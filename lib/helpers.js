const fs = require("fs");
const path = require("path");
const axios = require("axios");
const sharp = require("sharp");
const { getOpenAI, getTwilioClient, getModels } = require("./config");
const settings = require("./settings");
const { trackApiCall } = require("./health");

// Shared phone-masking helper for log lines. Keeps country code + last 4
// digits so a human can still tell phones apart across log lines, but
// hides the middle subscriber digits. "api:..." synthetic phones (kiosk /
// API entry points) render as "Kiosk". Same contract as the maskPhone()
// copies in lib/dashboard.js and lib/outreach.js — duplicated there for
// the admin-UI rendering path; this copy exists so non-UI modules (SMS,
// pipeline, lead capture, menu handlers) can mask without requiring the
// full dashboard module.
function maskPhone(phone) {
    if (!phone || phone.length < 6) return phone || "unknown";
    if (phone.startsWith("api:")) return "Kiosk";
    const tail = phone.slice(-4);
    let ccLen = 2; // +1
    if (phone.length > 12) ccLen = 4;
    const head = phone.slice(0, ccLen);
    return `${head}*****${tail}`;
}

async function withRetry(fn, maxRetries = 3) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isRetryable = err.status === 429
                || err.status === 502 || err.status === 503 || err.status === 504
                || err.code === "ECONNRESET" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND";
            if (attempt === maxRetries || !isRetryable) throw err;
            const retryAfter = err.headers?.["retry-after"];
            const delay = (retryAfter ? Number(retryAfter) : 2 ** attempt) * 1000;
            console.log(`⏳ Retryable error (${err.status || err.code}), retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})...`);
            await new Promise((r) => setTimeout(r, delay));
        }
    }
}

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20 MB

async function downloadImage(url, filepath) {
    if (!url) throw new Error("URL is undefined.");
    const config = { method: "GET", url: url, responseType: "stream", timeout: 30000 };

    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (host === "twilio.com" || host.endsWith(".twilio.com")) {
            config.auth = {
                username: settings.get("twilioAccountSid"),
                password: settings.get("twilioAuthToken"),
            };
        }
    } catch { /* invalid URL — let axios surface the error */ }

    const response = await axios(config);

    // Reject early if Content-Length exceeds limit
    const contentLength = parseInt(response.headers["content-length"], 10);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
        response.data.destroy();
        throw new Error(`Image too large (${Math.round(contentLength / 1024 / 1024)}MB exceeds ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB limit)`);
    }

    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(filepath);
        let bytesReceived = 0;
        let failed = false;
        function fail(err) {
            if (failed) return;
            failed = true;
            writer.destroy();
            response.data.destroy();
            fs.unlink(filepath, () => {});
            reject(err);
        }
        response.data.on("data", (chunk) => {
            bytesReceived += chunk.length;
            if (bytesReceived > MAX_DOWNLOAD_BYTES) {
                fail(new Error(`Image download exceeded ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB limit`));
            }
        });
        response.data.pipe(writer);
        response.data.on("error", fail);
        writer.on("finish", resolve);
        writer.on("error", fail);
    });

    // Log image metadata so we can diagnose "Invalid image file or mode"
    // failures from OpenAI. Sharp decodes the header-level info (format,
    // colour space, channels, bit depth) without loading the full pixel
    // buffer. Best-effort only — never fail the download if Sharp can't
    // read it, since that itself is diagnostic information.
    try {
        const meta = await sharp(filepath).metadata();
        console.log(`📷 Input image: format=${meta.format} space=${meta.space} channels=${meta.channels} depth=${meta.depth} ${meta.width}x${meta.height} hasAlpha=${meta.hasAlpha} icc=${meta.icc ? "present" : "none"}`);
    } catch (metaErr) {
        console.log(`📷 Input image: sharp metadata read failed (${metaErr.message}) — bytes may be an unsupported format`);
    }
}


async function moderateImage(base64Image, options = {}) {
    const start = Date.now();
    try {
        const response = await withRetry(() => getOpenAI().moderations.create({
            model: "omni-moderation-latest",
            input: [
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${base64Image}`,
                    },
                },
            ],
        }));
        trackApiCall("openai", true, Date.now() - start);
        const result = response.results[0];
        return { flagged: result.flagged, categories: result.categories };
    } catch (err) {
        trackApiCall("openai", false, Date.now() - start);
        console.error(`🛡️  Moderation API error (${options.strict ? "blocking Voice" : "allowing through"}): ${err.message}`);
        if (options.strict) throw err;
        return { flagged: false, categories: null };
    }
}

async function detectPerson(base64Image, options = {}) {
    const start = Date.now();
    try {
        const response = await withRetry(() => getOpenAI().responses.create({
            model: getModels().visionLight,
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_image",
                            image_url: `data:image/jpeg;base64,${base64Image}`,
                            detail: "low",
                        },
                        {
                            type: "input_text",
                            text: settings.get("promptFaceDetection"),
                        },
                    ],
                },
            ],
        }));
        trackApiCall("openai", true, Date.now() - start);
        const text = response.output_text.trim().toUpperCase();
        if (options.strict && !/^(YES|NO)\b/.test(text)) throw new Error("Face detection returned an uncertain answer");
        return text.startsWith("YES");
    } catch (err) {
        trackApiCall("openai", false, Date.now() - start);
        console.error(`👤 Person detection error (${options.strict ? "blocking Voice" : "allowing through"}): ${err.message}`);
        if (options.strict) throw err;
        return true;
    }
}

async function analyzeScene(base64Image, options = {}) {
    const start = Date.now();
    try {
        const response = await withRetry(() => getOpenAI().responses.create({
            model: getModels().visionLight,
            input: [
                {
                    role: "user",
                    content: [
                        {
                            type: "input_image",
                            image_url: `data:image/jpeg;base64,${base64Image}`,
                            detail: "low",
                        },
                        {
                            type: "input_text",
                            text: settings.get("promptSceneAnalysis"),
                        },
                    ],
                },
            ],
        }));
        trackApiCall("openai", true, Date.now() - start);
        return response.output_text.trim();
    } catch (err) {
        trackApiCall("openai", false, Date.now() - start);
        console.error(`👥 Scene analysis error (${options.strict ? "blocking Voice" : "skipping"}): ${err.message}`);
        if (options.strict) throw err;
        return "";
    }
}

function parseScene(raw) {
    const defaults = { subjects: 1, pets: "none", positions: "centered" };
    if (!raw) return defaults;
    try {
        const subjectsMatch = raw.match(/Subjects:\s*(\d+)/i);
        const petsMatch = raw.match(/Pets:\s*(.+)/im);
        const positionsMatch = raw.match(/Positions:\s*(.+)/im);
        return {
            subjects: subjectsMatch ? parseInt(subjectsMatch[1], 10) : defaults.subjects,
            pets: petsMatch ? petsMatch[1].trim().toLowerCase() : defaults.pets,
            positions: positionsMatch ? positionsMatch[1].trim().toLowerCase() : defaults.positions,
        };
    } catch {
        return defaults;
    }
}

const TEMPLATE_CACHE_MAX = 24;
const TEMPLATE_PREPARATION_RETRIES = 2;
const TRANSIENT_TEMPLATE_FILE_ERRORS = new Set([
    "EACCES", "EBUSY", "EIO", "EMFILE", "ENFILE", "ENOENT", "EPERM", "ESTALE",
]);
const _preparedTemplateCache = new Map();
let _templatePixelScans = 0;

function isTransientTemplateFileError(err) {
    return TRANSIENT_TEMPLATE_FILE_ERRORS.has(err && err.code)
        || /input file is missing|no such file or directory/i.test(err && err.message || "");
}

async function detectSafeZone(templateBuffer, sourceScale = 1) {
    const { data, info } = await sharp(templateBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

    const { width, height, channels } = info;
    const THRESHOLD = 128; // alpha below this = transparent
    // A one-pixel gap in an uploaded frame may span several print pixels.
    const erosion = Math.max(1, Math.ceil(sourceScale / 2));
    const pixelCount = width * height;
    const transparent = new Uint8Array(pixelCount);
    let transparentCount = 0;
    let top = height, bottom = -1, left = width, right = -1;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (data[index * channels + channels - 1] >= THRESHOLD) continue;
            transparent[index] = 1;
            transparentCount++;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            if (x < left) left = x;
            if (x > right) right = x;
        }
    }

    if (bottom <= top || right <= left) return null;
    const fullZone = { left, top, width: right - left + 1, height: bottom - top + 1 };

    // A frame can have a transparent outer rim as well as its photo opening.
    // Shrinking transparent regions separates accidental thin bridges before
    // we look for the largest enclosed opening. Scan transparent runs so the
    // work stays proportional to image size even for heavily upscaled frames.
    const core = new Uint8Array(pixelCount);
    for (let x = 0; x < width; x++) {
        let y = 0;
        while (y < height) {
            while (y < height && !transparent[y * width + x]) y++;
            const start = y;
            while (y < height && transparent[y * width + x]) y++;
            for (let inside = start + erosion; inside < y - erosion; inside++) {
                core[inside * width + x] = 1;
            }
        }
    }
    for (let y = 0; y < height; y++) {
        const row = y * width;
        let x = 0;
        while (x < width) {
            while (x < width && !transparent[row + x]) x++;
            const start = x;
            while (x < width && transparent[row + x]) x++;
            for (let edge = start; edge < Math.min(x, start + erosion); edge++) {
                transparent[row + edge] = 0;
            }
            for (let edge = Math.max(start, x - erosion); edge < x; edge++) {
                transparent[row + edge] = 0;
            }
        }
    }
    for (let index = 0; index < pixelCount; index++) core[index] &= transparent[index];

    const queue = new Int32Array(pixelCount);
    let opening = null;
    let largestEdgeComponent = null;
    let fullCanvasExterior = null;
    for (let start = 0; start < pixelCount; start++) {
        if (core[start] !== 1) continue;
        let head = 0, tail = 1;
        let componentLeft = width, componentTop = height, componentRight = -1, componentBottom = -1;
        queue[0] = start;
        core[start] = 2;
        while (head < tail) {
            const index = queue[head++];
            const x = index % width;
            const y = (index - x) / width;
            if (x < componentLeft) componentLeft = x;
            if (x > componentRight) componentRight = x;
            if (y < componentTop) componentTop = y;
            if (y > componentBottom) componentBottom = y;
            if (x > 0 && core[index - 1] === 1) {
                core[index - 1] = 2;
                queue[tail++] = index - 1;
            }
            if (x + 1 < width && core[index + 1] === 1) {
                core[index + 1] = 2;
                queue[tail++] = index + 1;
            }
            if (y > 0 && core[index - width] === 1) {
                core[index - width] = 2;
                queue[tail++] = index - width;
            }
            if (y + 1 < height && core[index + width] === 1) {
                core[index + width] = 2;
                queue[tail++] = index + width;
            }
        }

        const touchesLeft = componentLeft <= erosion;
        const touchesTop = componentTop <= erosion;
        const touchesRight = componentRight >= width - erosion - 1;
        const touchesBottom = componentBottom >= height - erosion - 1;
        if (!touchesLeft && !touchesTop && !touchesRight && !touchesBottom) {
            if (!opening || tail > opening.size) {
                opening = {
                    seed: start, size: tail,
                    left: componentLeft, top: componentTop,
                    right: componentRight, bottom: componentBottom,
                };
            }
        } else {
            if (!largestEdgeComponent || tail > largestEdgeComponent.size) {
                largestEdgeComponent = {
                    seed: start, size: tail,
                    left: componentLeft, top: componentTop,
                    right: componentRight, bottom: componentBottom,
                };
            }
            if (touchesLeft && touchesTop && touchesRight && touchesBottom
                && (!fullCanvasExterior || tail > fullCanvasExterior.size)) {
                fullCanvasExterior = { size: tail };
            }
        }
    }

    // Sparse overlays intentionally show the portrait across the whole canvas.
    // A dominant exterior plus very little artwork indicates an overlay, even
    // if a decorative ring encloses another transparent region. Tiny enclosed
    // cutouts should not replace a much larger edge-touching photo opening.
    const sparseOverlay = fullCanvasExterior && fullCanvasExterior.size > pixelCount / 2
        && transparentCount > pixelCount * 0.9;
    const decorativeCutout = largestEdgeComponent && opening
        && opening.size < largestEdgeComponent.size * 0.1;
    const selected = opening && !decorativeCutout ? opening : largestEdgeComponent;
    if (sparseOverlay || !selected) return fullZone;

    // Revisit only the chosen component and give the portrait a one-pixel
    // underlap below antialiased artwork. A packed mask keeps cached templates
    // small even at print resolution.
    const underlap = erosion + 1;
    const zoneLeft = Math.max(0, selected.left - underlap);
    const zoneTop = Math.max(0, selected.top - underlap);
    const zoneRight = Math.min(width - 1, selected.right + underlap);
    const zoneBottom = Math.min(height - 1, selected.bottom + underlap);
    let head = 0, tail = 1;
    queue[0] = selected.seed;
    core[selected.seed] = 3;
    const horizontal = transparent;
    horizontal.fill(0);
    while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = (index - x) / width;
        for (let dx = -underlap; dx <= underlap; dx++) {
            if (x + dx >= 0 && x + dx < width) horizontal[index + dx] = 1;
        }
        if (x > 0 && core[index - 1] === 2) {
            core[index - 1] = 3;
            queue[tail++] = index - 1;
        }
        if (x + 1 < width && core[index + 1] === 2) {
            core[index + 1] = 3;
            queue[tail++] = index + 1;
        }
        if (y > 0 && core[index - width] === 2) {
            core[index - width] = 3;
            queue[tail++] = index - width;
        }
        if (y + 1 < height && core[index + width] === 2) {
            core[index + width] = 3;
            queue[tail++] = index + width;
        }
    }

    const maskPixels = core;
    maskPixels.fill(0);
    for (let y = zoneTop; y <= zoneBottom; y++) {
        for (let x = zoneLeft; x <= zoneRight; x++) {
            const index = y * width + x;
            for (let dy = -underlap; dy <= underlap; dy++) {
                if (y + dy >= 0 && y + dy < height && horizontal[index + dy * width]) {
                    maskPixels[index] = 1;
                    break;
                }
            }
        }
    }

    // Opaque or translucent decorations surrounded by the opening still sit
    // over the photo. Fill holes in the mask while leaving the outer frame and
    // its transparent perimeter on the matte.
    head = 0;
    tail = 0;
    const addExterior = (index) => {
        if (maskPixels[index] !== 0) return;
        maskPixels[index] = 2;
        queue[tail++] = index;
    };
    for (let x = zoneLeft; x <= zoneRight; x++) {
        addExterior(zoneTop * width + x);
        addExterior(zoneBottom * width + x);
    }
    for (let y = zoneTop; y <= zoneBottom; y++) {
        addExterior(y * width + zoneLeft);
        addExterior(y * width + zoneRight);
    }
    while (head < tail) {
        const index = queue[head++];
        const x = index % width;
        const y = (index - x) / width;
        if (x > zoneLeft) addExterior(index - 1);
        if (x < zoneRight) addExterior(index + 1);
        if (y > zoneTop) addExterior(index - width);
        if (y < zoneBottom) addExterior(index + width);
    }

    const mask = Buffer.alloc(Math.ceil(pixelCount / 8));
    for (let y = zoneTop; y <= zoneBottom; y++) {
        for (let x = zoneLeft; x <= zoneRight; x++) {
            const index = y * width + x;
            if (maskPixels[index] !== 2) mask[index >> 3] |= 1 << (index & 7);
        }
    }
    return {
        left: zoneLeft,
        top: zoneTop,
        width: zoneRight - zoneLeft + 1,
        height: zoneBottom - zoneTop + 1,
        mask,
    };
}

async function detectExteriorFrameTrim(templatePath, metadata) {
    if (!metadata.hasAlpha || !metadata.width || !metadata.height) return null;

    const { width, height } = metadata;
    const maxInsetX = Math.min(256, Math.max(16, Math.floor(width * 0.05)), Math.floor((width - 1) / 2));
    const maxInsetY = Math.min(256, Math.max(16, Math.floor(height * 0.05)), Math.floor((height - 1) / 2));
    const findInset = async (region, vertical, fromEnd, maxInset) => {
        const { data, info } = await sharp(templatePath)
            .extract(region)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        const histogram = new Uint32Array(256);
        const lineLength = vertical ? info.height : info.width;
        const position = (distance) => fromEnd
            ? (vertical ? info.width : info.height) - distance - 1
            : distance;
        const medianAlpha = (distance) => {
            histogram.fill(0);
            const line = position(distance);
            for (let i = 0; i < lineLength; i++) {
                const index = vertical ? i * info.width + line : line * info.width + i;
                histogram[data[index * info.channels + info.channels - 1]]++;
            }
            let count = 0;
            for (let alpha = 0; alpha < 256; alpha++) {
                count += histogram[alpha];
                if (count > lineLength / 2) return alpha;
            }
            return 255;
        };
        if (medianAlpha(0) > 32) return null;
        let transitionCount = 0;
        for (let distance = 1; distance <= maxInset; distance++) {
            const alpha = medianAlpha(distance);
            if (alpha > 32 && alpha < 245) transitionCount++;
            if (alpha >= 245) {
                // A hard transparent cut can be intentional frame artwork.
                // The source's fading perimeter has several partial-alpha lines.
                if (transitionCount < 2) return null;
                // Leave the partly transparent transition behind as well.
                return distance + 2;
            }
        }
        return null;
    };

    // Read narrow strips first. Most templates reject on the first edge, and
    // large uploaded frames never need a full-resolution RGBA copy in JS.
    const left = await findInset({ left: 0, top: 0, width: maxInsetX + 1, height }, true, false, maxInsetX);
    if (left === null) return null;
    const right = await findInset({ left: width - maxInsetX - 1, top: 0, width: maxInsetX + 1, height }, true, true, maxInsetX);
    if (right === null) return null;
    const top = await findInset({ left: 0, top: 0, width, height: maxInsetY + 1 }, false, false, maxInsetY);
    if (top === null) return null;
    const bottom = await findInset({ left: 0, top: height - maxInsetY - 1, width, height: maxInsetY + 1 }, false, true, maxInsetY);
    if (left === null || right === null || top === null || bottom === null) return null;
    if (left + right >= width / 4 || top + bottom >= height / 4) return null;

    // A frame has a substantial enclosed opening, separate from its faded
    // exterior. Check topology on a small alpha preview to preserve overlays.
    const { data, info } = await sharp(templatePath)
        .resize({ width: 256, height: 256, fit: "inside", withoutEnlargement: true, kernel: "nearest" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    const pixelCount = info.width * info.height;
    const transparent = new Uint8Array(pixelCount);
    let transparentCount = 0;
    for (let index = 0; index < pixelCount; index++) {
        if (data[index * info.channels + info.channels - 1] < 128) {
            transparent[index] = 1;
            transparentCount++;
        }
    }
    const transparentFraction = transparentCount / pixelCount;
    if (transparentFraction < 0.1 || transparentFraction > 0.9) return null;

    const queue = new Int32Array(pixelCount);
    for (let start = 0; start < pixelCount; start++) {
        if (transparent[start] !== 1) continue;
        let head = 0, tail = 1;
        let touchesEdge = false;
        transparent[start] = 2;
        queue[0] = start;
        while (head < tail) {
            const index = queue[head++];
            const x = index % info.width;
            const y = (index - x) / info.width;
            if (x === 0 || y === 0 || x === info.width - 1 || y === info.height - 1) touchesEdge = true;
            if (x > 0 && transparent[index - 1] === 1) {
                transparent[index - 1] = 2;
                queue[tail++] = index - 1;
            }
            if (x + 1 < info.width && transparent[index + 1] === 1) {
                transparent[index + 1] = 2;
                queue[tail++] = index + 1;
            }
            if (y > 0 && transparent[index - info.width] === 1) {
                transparent[index - info.width] = 2;
                queue[tail++] = index - info.width;
            }
            if (y + 1 < info.height && transparent[index + info.width] === 1) {
                transparent[index + info.width] = 2;
                queue[tail++] = index + info.width;
            }
        }
        if (!touchesEdge && tail >= pixelCount * 0.1) {
            return { left, top, width: width - left - right, height: height - top - bottom };
        }
    }

    return null;
}

async function adaptTemplateAcrossOrientations(templatePath, targetWidth, targetHeight) {
    _templatePixelScans++;
    const { data, info } = await sharp(templatePath)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    let left = info.width, top = info.height, right = -1, bottom = -1;
    for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
            if (data[(y * info.width + x) * 4 + 3] < 16) continue;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
        }
    }
    if (right < left || bottom < top) {
        const buffer = await sharp({
            create: { width: targetWidth, height: targetHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
        }).png().toBuffer();
        return { buffer, scale: 1 };
    }

    const contentWidth = right - left + 1;
    const contentHeight = bottom - top + 1;
    const spansCanvas = contentWidth / info.width > 0.9 && contentHeight / info.height > 0.9;
    let scale;
    if (spansCanvas) {
        scale = Math.min(targetWidth / info.width, targetHeight / info.height);
    } else if (contentWidth >= contentHeight) {
        scale = targetWidth / info.width;
    } else {
        scale = targetHeight / info.height;
    }
    // Sparse edge decorations need breathing room when moved to a wider canvas.
    if (!spansCanvas) scale *= 0.82;
    scale = Math.min(scale, targetWidth / contentWidth, targetHeight / contentHeight);
    const resizedWidth = Math.max(1, Math.round(contentWidth * scale));
    const resizedHeight = Math.max(1, Math.round(contentHeight * scale));
    function anchoredPosition(start, end, sourceSize, targetSize, resizedSize) {
        const leadingMargin = start / sourceSize;
        const trailingMargin = (sourceSize - end - 1) / sourceSize;
        const edgeThreshold = 0.08;
        if (leadingMargin <= edgeThreshold && trailingMargin > edgeThreshold) {
            return Math.round(leadingMargin * targetSize);
        }
        if (trailingMargin <= edgeThreshold && leadingMargin > edgeThreshold) {
            return targetSize - resizedSize - Math.round(trailingMargin * targetSize);
        }
        const center = ((start + end + 1) / 2 / sourceSize) * targetSize;
        return Math.round(center - resizedSize / 2);
    }
    const targetLeft = Math.max(0, Math.min(
        targetWidth - resizedWidth,
        anchoredPosition(left, right, info.width, targetWidth, resizedWidth),
    ));
    const targetTop = Math.max(0, Math.min(
        targetHeight - resizedHeight,
        anchoredPosition(top, bottom, info.height, targetHeight, resizedHeight),
    ));

    const decoration = await sharp(templatePath)
        .extract({ left, top, width: contentWidth, height: contentHeight })
        .resize(resizedWidth, resizedHeight, { fit: "fill" })
        .png()
        .toBuffer();
    const buffer = await sharp({
        create: { width: targetWidth, height: targetHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
        .composite([{ input: decoration, left: targetLeft, top: targetTop }])
        .png()
        .toBuffer();
    return { buffer, scale };
}

async function getPreparedTemplate(templatePath, targetWidth, targetHeight, compatibility) {
    const stat = await fs.promises.stat(templatePath);
    const cacheKey = [templatePath, stat.mtimeMs, stat.size, targetWidth, targetHeight, compatibility].join(":");
    if (_preparedTemplateCache.has(cacheKey)) {
        const cached = _preparedTemplateCache.get(cacheKey);
        _preparedTemplateCache.delete(cacheKey);
        _preparedTemplateCache.set(cacheKey, cached);
        return cached;
    }

    const preparation = (async () => {
        const metadata = await sharp(templatePath).metadata();
        const targetOrientation = targetWidth > targetHeight ? "landscape" : "portrait";
        const templateOrientation = metadata.width > metadata.height
            ? "landscape"
            : metadata.width < metadata.height ? "portrait" : "square";
        const compatible = compatibility === "both"
            || compatibility === targetOrientation
            || (compatibility === "native" && (templateOrientation === targetOrientation || templateOrientation === "square"));
        if (!compatible) return { compatible: false, templateOrientation };

        const trim = await detectExteriorFrameTrim(templatePath, metadata);
        const templateInput = trim
            ? await sharp(templatePath).extract(trim).png().toBuffer()
            : templatePath;
        const sourceWidth = trim ? trim.width : metadata.width;
        const sourceHeight = trim ? trim.height : metadata.height;
        const adaptAcrossOrientations = templateOrientation !== targetOrientation
            && (templateOrientation === "square" || compatibility === "both" || compatibility === targetOrientation);
        let buffer;
        let sourceScale;
        if (adaptAcrossOrientations) {
            const adapted = await adaptTemplateAcrossOrientations(templateInput, targetWidth, targetHeight);
            buffer = adapted.buffer;
            sourceScale = adapted.scale;
        } else {
            // Keep the complete artwork of a trimmed frame when its aspect
            // ratio is close to the requested print size (such as 2:3 to 5:7).
            const ratioDifference = Math.abs((targetWidth / targetHeight) / (sourceWidth / sourceHeight) - 1);
            const fit = trim && ratioDifference <= 0.12 ? "fill" : "cover";
            buffer = await sharp(templateInput).resize(targetWidth, targetHeight, { fit }).toBuffer();
            sourceScale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
        }
        _templatePixelScans++;
        const zone = await detectSafeZone(buffer, sourceScale);
        return { compatible: true, buffer, zone, templateOrientation };
    })();

    while (_preparedTemplateCache.size >= TEMPLATE_CACHE_MAX) {
        _preparedTemplateCache.delete(_preparedTemplateCache.keys().next().value);
    }
    _preparedTemplateCache.set(cacheKey, preparation);
    try {
        return await preparation;
    } catch (err) {
        if (_preparedTemplateCache.get(cacheKey) === preparation) _preparedTemplateCache.delete(cacheKey);
        throw err;
    }
}

async function prepareTemplateWithRetry(templatePath, targetWidth, targetHeight, compatibility) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await getPreparedTemplate(templatePath, targetWidth, targetHeight, compatibility);
        } catch (err) {
            if (!isTransientTemplateFileError(err) || attempt === TEMPLATE_PREPARATION_RETRIES) throw err;
            await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
        }
    }
}

async function compositeWithTemplate(imagePath, outputProfile, eventName) {
    const profile = outputProfile || settings.getOutputProfile(eventName);
    const templatePath = settings.getTemplatePath(eventName, profile.orientation);
    if (!templatePath || !fs.existsSync(templatePath)) {
        console.log("🖼️  No template configured, skipping frame overlay.");
        return;
    }

    const { width: PRINT_WIDTH, height: PRINT_HEIGHT } = profile;
    const compatibility = settings.getTemplateCompatibility(path.basename(templatePath), eventName);
    let prepared;
    try {
        prepared = await prepareTemplateWithRetry(templatePath, PRINT_WIDTH, PRINT_HEIGHT, compatibility);
    } catch (err) {
        if (isTransientTemplateFileError(err)) {
            console.warn(`🖼️  Skipping ${path.basename(templatePath)}: template became unavailable during preparation.`);
            return;
        }
        throw err;
    }
    if (!prepared.compatible) {
        console.warn(`🖼️  Skipping ${path.basename(templatePath)}: template orientation does not match ${profile.orientation} output.`);
        return;
    }

    const borderEnabled = settings.getForEvent("enableFrameBorder", eventName) !== false;
    const INSET_RATIO = borderEnabled ? 0.03 : 0; // 3% padding when border enabled, 0 when off

    const resizedTemplate = prepared.buffer;
    const zone = prepared.zone;

    if (!zone) {
        // No transparent area — fall back to simple overlay
        const resizedImage = await sharp(imagePath)
            .resize(PRINT_WIDTH, PRINT_HEIGHT, { fit: "cover" })
            .toBuffer();
        await sharp(resizedImage)
            .composite([{ input: resizedTemplate, gravity: "center" }])
            .png()
            .toFile(imagePath);
        console.log("🖼️  Frame overlay applied (no safe zone detected, using full area).");
        return;
    }

    // Add inset padding
    const padX = Math.round(zone.width * INSET_RATIO);
    const padY = Math.round(zone.height * INSET_RATIO);
    const targetW = zone.width - padX * 2;
    const targetH = zone.height - padY * 2;
    const targetX = zone.left + padX;
    const targetY = zone.top + padY;

    // Portrait fitted within the safe zone (no clipping of subject)
    let fgPortrait;
    if (zone.mask) {
        const { data } = await sharp(imagePath)
            .resize(targetW, targetH, { fit: "cover" })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        for (let y = 0; y < targetH; y++) {
            for (let x = 0; x < targetW; x++) {
                const canvasIndex = (targetY + y) * PRINT_WIDTH + targetX + x;
                if (!(zone.mask[canvasIndex >> 3] & (1 << (canvasIndex & 7)))) {
                    data[(y * targetW + x) * 4 + 3] = 0;
                }
            }
        }
        fgPortrait = await sharp(data, { raw: { width: targetW, height: targetH, channels: 4 } })
            .png()
            .toBuffer();
    } else {
        fgPortrait = await sharp(imagePath)
            .resize(targetW, targetH, { fit: "cover" })
            .toBuffer();
    }

    // Blank canvas → fitted portrait → template frame
    const hex = settings.getForEvent("frameBorderColor", eventName) || "#000000";
    const bgR = parseInt(hex.slice(1, 3), 16) || 0;
    const bgG = parseInt(hex.slice(3, 5), 16) || 0;
    const bgB = parseInt(hex.slice(5, 7), 16) || 0;
    await sharp({
        create: { width: PRINT_WIDTH, height: PRINT_HEIGHT, channels: 3, background: { r: bgR, g: bgG, b: bgB } },
    })
        .composite([
            { input: fgPortrait, left: targetX, top: targetY },
            { input: resizedTemplate, left: 0, top: 0 },
        ])
        .png()
        .toFile(imagePath);

    console.log("🖼️  Frame overlay applied (safe zone: %dx%d at +%d+%d).",
        targetW, targetH, targetX, targetY);
}

async function prepareForPrint(imagePath, outputProfile, eventName) {
    const profile = outputProfile || settings.getOutputProfile(eventName);
    const { width: PRINT_WIDTH, height: PRINT_HEIGHT, dpi: PRINT_DPI } = profile;

    await sharp(imagePath)
        .resize(PRINT_WIDTH, PRINT_HEIGHT, {
            fit: "cover",
        })
        .withMetadata({ density: PRINT_DPI })
        .png()
        .toFile(imagePath + ".tmp");

    fs.renameSync(imagePath + ".tmp", imagePath);
    console.log(`📐 Image resized to ${PRINT_WIDTH}x${PRINT_HEIGHT} @ ${PRINT_DPI} DPI`);
}

async function generateSmartReply(userMessage, context) {
    const start = Date.now();
    try {
        const portugueseUnit = context.remaining === 1
            ? context.unit
            : ({ impressão: "impressões", retrato: "retratos" }[context.unit] || context.unit);
        const configuredPrompt = settings.get("promptSmartReply")
            .replace("{eventName}", context.eventName)
            .replace("{styleChoices}", context.styleChoices)
            .replace("{remainingLine}", "");
        const developerPrompt = context.locale === "pt_BR"
            ? [
                `Você é o assistente de uma cabine de fotos com IA no evento "${context.eventName}", criada com Twilio e OpenAI.`,
                "Responda à mensagem da pessoa de forma natural e útil e depois oriente-a a enviar uma selfie para transformá-la em arte.",
                `Estilos disponíveis: ${context.styleChoices}.`,
                context.remaining != null ? `Ela ainda pode criar ${context.remaining} ${portugueseUnit}.` : "",
                `Instruções adicionais do evento: ${configuredPrompt}`,
                "Use português brasileiro natural, seja breve (de 2 a 4 frases), não use emojis e termine incentivando o envio de uma selfie.",
            ].filter(Boolean).join("\n")
            : settings.get("promptSmartReply")
                .replace("{eventName}", context.eventName)
                .replace("{styleChoices}", context.styleChoices)
                .replace("{remainingLine}", context.remaining != null ? `They have ${context.remaining} free ${context.unit}${context.remaining === 1 ? "" : "s"} remaining.` : "")
                + "\nRespond in English.";
        const response = await withRetry(() => getOpenAI().responses.create({
            model: getModels().smartReply,
            input: [
                {
                    role: "developer",
                    content: [{
                        type: "input_text",
                        text: developerPrompt,
                    }],
                },
                {
                    role: "user",
                    content: [{ type: "input_text", text: userMessage }],
                },
            ],
        }));
        trackApiCall("openai", true, Date.now() - start);
        return response.output_text.trim();
    } catch (err) {
        trackApiCall("openai", false, Date.now() - start);
        console.error(`🤖 Smart reply failed (using static): ${err.message}`);
        return null;
    }
}

module.exports = {
    downloadImage,
    moderateImage,
    detectPerson,
    analyzeScene,
    parseScene,
    compositeWithTemplate,
    prepareForPrint,
    generateSmartReply,
    withRetry,
    maskPhone,
    getTwilioClient,
    trackApiCall,
    __getTemplateCacheStatsForTest: () => ({
        entries: _preparedTemplateCache.size,
        pixelScans: _templatePixelScans,
    }),
    __clearTemplateCacheForTest: () => {
        _preparedTemplateCache.clear();
        _templatePixelScans = 0;
    },
};

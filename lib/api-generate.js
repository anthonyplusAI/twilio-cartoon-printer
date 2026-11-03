// Programmatic generate endpoint — lets admins submit a selfie via HTTP
// instead of SMS. Reuses the SMS pipeline end-to-end; the only differences
// are:
//   - synthetic userPhone like "api:<id>" (no real phone to deliver to)
//   - noDelivery: true on the job, which suppresses every outbound message
//   - adminGenerated: true so the job doesn't count toward per-user quota
//
// Also backs /kiosk, which POSTs the camera snapshot to this same endpoint.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const sharp = require("sharp");

const settings = require("./settings");
const optionI18n = require("./option-i18n");
const contacts = require("./contacts");
const i18n = require("./i18n");
const queue = require("./queue");
const { enqueueJob, getUsageCount, getInFlightUsageRebuild, isAdmin, resolveKioskResultPrefix } = queue;
const kioskSubmissions = require("./kiosk-submissions");
const kioskRequests = require("./kiosk-requests");
const { resolveKioskDeliveryChannel } = require("./kiosk-delivery");
const { getActiveBrands } = require("./brands");
const { resolveBrandStep } = require("./menu-routing");
const { resolveBackgroundStep } = require("./prompt-assembler");
const { authenticateAdminSession, authenticateKioskSession } = require("./auth");
const {
    DATA_DIR,
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    REVIEW_DIR,
    DONE_DIR,
    FAILED_DIR,
    PRINTING_DIR,
    PROCESSING_DIR,
} = require("./config");

// E.164: leading +, then 7–15 digits. We don't localize or assume a country.
const E164_RE = /^\+[1-9]\d{6,14}$/;
// Pragmatic email check — syntactic only, no bounce verification.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = express.Router();

// ── Upload parsing ──────────────────────────────────────────────────────────
// Two body shapes supported:
//   1. Content-Type: image/jpeg|png|webp  → raw bytes
//   2. Content-Type: multipart/form-data  → a single file field named "image"
// Multipart is parsed by hand (no new dependency) since we only need one field.

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB
const KIOSK_UPLOAD_DIR = path.join(DATA_DIR, "kiosk-uploads");
const KIOSK_UPLOAD_MAX_AGE_MS = 60 * 60 * 1000;

async function sweepStaleKioskUploads({ dir = KIOSK_UPLOAD_DIR, now = Date.now(), maxAgeMs = KIOSK_UPLOAD_MAX_AGE_MS } = {}) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    let removed = 0;
    for (const entry of entries) {
        if (!entry.isFile() || !/^[0-9a-f-]{36}\.jpg$/i.test(entry.name)) continue;
        const filePath = path.join(dir, entry.name);
        try {
            const stat = await fsp.stat(filePath);
            if (now - stat.mtimeMs < maxAgeMs) continue;
            await fsp.unlink(filePath);
            removed++;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    return removed;
}

function readBodyBuffer(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_UPLOAD_BYTES) {
                reject(Object.assign(new Error(`Upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit`), { status: 413 }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks)));
        req.on("error", reject);
    });
}

// Minimal multipart parser for a single image and small text fields. Kiosk
// contact details are sent in the body, never in the request URL or logs.
function parseMultipart(buffer, boundary) {
    if (!boundary || boundary.length > 200) return null;
    const marker = Buffer.from(`--${boundary}`);
    const nextMarker = Buffer.from(`\r\n--${boundary}`);
    const fields = Object.create(null);
    let image = null;
    let cursor = buffer.indexOf(marker);
    let parts = 0;
    while (cursor >= 0 && parts++ < 20) {
        let headerStart = cursor + marker.length;
        if (buffer[headerStart] === 0x2d && buffer[headerStart + 1] === 0x2d) break;
        if (buffer[headerStart] !== 0x0d || buffer[headerStart + 1] !== 0x0a) break;
        headerStart += 2;
        const headerEnd = buffer.indexOf("\r\n\r\n", headerStart);
        if (headerEnd < 0 || headerEnd - headerStart > 4096) break;
        const bodyStart = headerEnd + 4;
        const bodyEnd = buffer.indexOf(nextMarker, bodyStart);
        if (bodyEnd < 0) break;
        const header = buffer.subarray(headerStart, headerEnd).toString("utf8");
        const nameMatch = /content-disposition:[^\r\n]*\bname="([A-Za-z][A-Za-z0-9]*)"/i.exec(header);
        if (nameMatch) {
            const name = nameMatch[1];
            const body = buffer.subarray(bodyStart, bodyEnd);
            if (name === "image" && /\bfilename="[^"]+"/i.test(header)) {
                if (!image) image = body;
            } else if (body.length <= 2048 && !Object.hasOwn(fields, name)) {
                fields[name] = body.toString("utf8");
            }
        }
        cursor = bodyEnd + 2;
    }
    return image ? { image, fields } : null;
}

// Detect image type from magic bytes — protects against a caller lying
// about Content-Type. Returns the canonical extension or null.
function sniffImageType(buf) {
    if (buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
    if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return "webp";
    return null;
}

async function extractUploadedImage(req) {
    const ctRaw = req.headers["content-type"] || "";
    const ct = ctRaw.toLowerCase();
    const buf = await readBodyBuffer(req);
    if (buf.length === 0) throw Object.assign(new Error("Empty upload body"), { status: 400 });

    let imageBuf;
    let fields = {};
    if (ct.startsWith("multipart/form-data")) {
        // Boundary is case-sensitive — extract it from the raw header, not
        // the lowercased copy we use for type dispatch.
        const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(ctRaw);
        if (!boundaryMatch) throw Object.assign(new Error("Missing multipart boundary"), { status: 400 });
        const part = parseMultipart(buf, boundaryMatch[1] || boundaryMatch[2]);
        if (!part) throw Object.assign(new Error("No file part found in multipart body"), { status: 400 });
        imageBuf = part.image;
        fields = part.fields;
    } else if (ct.startsWith("image/") || ct === "application/octet-stream") {
        imageBuf = buf;
    } else {
        throw Object.assign(new Error(`Unsupported Content-Type: ${ct}. Use image/* or multipart/form-data.`), { status: 415 });
    }

    const ext = sniffImageType(imageBuf);
    if (!ext) throw Object.assign(new Error("Uploaded file is not a recognised image (JPEG/PNG/WebP)"), { status: 415 });
    return { buffer: imageBuf, ext, fields };
}

// ── Job lookup (poll state across all queue directories) ────────────────────

async function findJobState(filePrefix) {
    // A single fs.rename is atomic, but a job in transit between two dirs
    // sits in one of them at any given instant. The lookup order below
    // mirrors the job's forward progression (pending → generating → terminal)
    // so if we read mid-transition we catch the later state — avoiding a
    // "pending" read for a job that has already moved to generating.
    const dirs = [
        { dir: DONE_DIR, state: "done" },
        { dir: READY_DIR, state: "ready" },
        { dir: PRINTING_DIR, state: "printing" },
        { dir: PROCESSING_DIR, state: "printing" },
        { dir: FAILED_DIR, state: "failed" },
        { dir: REVIEW_DIR, state: "review" },
        { dir: GENERATING_DIR, state: "generating" },
        { dir: PENDING_DIR, state: "pending" },
    ];
    for (const { dir, state } of dirs) {
        const jobPath = path.join(dir, `${filePrefix}.json`);
        if (fs.existsSync(jobPath)) {
            try {
                const job = JSON.parse(await fsp.readFile(jobPath, "utf8"));
                return { state, job };
            } catch {
                // File was renamed out from under us mid-read. Let the caller
                // poll again rather than committing to a wrong state.
                return { state: "transient", job: null };
            }
        }
    }
    return { state: "unknown", job: null };
}

// A kiosk request ID always points at its first queued prefix. Review can
// choose a different variant, and reanalysis can replace the whole group.
// Resolve that durable prefix before reporting or serving the finished image.
async function findResolvedJobState(filePrefix) {
    const original = await findJobState(filePrefix);
    if (!original.job?.kioskSubmission || !original.job.eventName) {
        return { ...original, resultPrefix: filePrefix };
    }
    const resultPrefix = await resolveKioskResultPrefix(filePrefix, original.job.eventName);
    if (resultPrefix === filePrefix) return { ...original, resultPrefix };
    const resolved = await findJobState(resultPrefix);
    return { ...resolved, resultPrefix };
}

async function findQueuedRequest(requestId, eventName) {
    for (const dir of [DONE_DIR, READY_DIR, PRINTING_DIR, PROCESSING_DIR, FAILED_DIR, REVIEW_DIR, GENERATING_DIR, PENDING_DIR]) {
        const names = await fsp.readdir(dir).catch((error) => {
            if (error.code === "ENOENT") return [];
            throw error;
        });
        for (const name of names) {
            if (!name.endsWith(".json")) continue;
            let job;
            try { job = JSON.parse(await fsp.readFile(path.join(dir, name), "utf8")); }
            catch { continue; }
            if (job.kioskSubmission && job.requestId === requestId && job.eventName === eventName) {
                // A crash can leave only v2 on disk. The request's public
                // prefix is always v1, regardless of which sibling we found.
                return job.parentJobId && job.variantCount > 1
                    ? `${job.parentJobId}-v1` : (job.filePrefix || name.slice(0, -5));
            }
        }
    }
    return null;
}

function hasCompleteKioskVariantGroup(job) {
    if (!job?.kioskSubmission || !job.parentJobId || !Number.isInteger(job.variantCount)
        || job.variantCount <= 1) return true;
    const dirs = [DONE_DIR, READY_DIR, PRINTING_DIR, PROCESSING_DIR, FAILED_DIR,
        REVIEW_DIR, GENERATING_DIR, PENDING_DIR];
    for (let index = 1; index <= job.variantCount; index++) {
        const name = `${job.parentJobId}-v${index}.json`;
        if (!dirs.some((dir) => fs.existsSync(path.join(dir, name)))) return false;
    }
    return true;
}

function kioskRequestInProgress(res) {
    res.setHeader("Retry-After", "2");
    throw kioskError(409, "REQUEST_IN_PROGRESS", "This portrait is still being submitted; retry shortly");
}

async function canonicalKioskPrefix(filePrefix) {
    const { job } = await findJobState(filePrefix);
    return job?.kioskSubmission && job.parentJobId && job.variantCount > 1
        ? `${job.parentJobId}-v1` : filePrefix;
}

async function respondToExistingKioskRequest(res, filePrefix) {
    const original = await findJobState(filePrefix);
    if (original.state === "unknown" || original.state === "transient"
        || !hasCompleteKioskVariantGroup(original.job)) kioskRequestInProgress(res);
    const { state, job, resultPrefix } = await findResolvedJobState(filePrefix);
    if (state === "unknown" || state === "transient" || !hasCompleteKioskVariantGroup(job)) {
        kioskRequestInProgress(res);
    }
    return res.status(202).json(describeJobForResponse(filePrefix, state, job, resultPrefix));
}

function describeJobForResponse(filePrefix, state, job, resultPrefix = filePrefix) {
    const resp = {
        filePrefix,
        state,
        statusUrl: `/api/generate/${encodeURIComponent(filePrefix)}/status`,
    };
    const imageReady = state === "ready" || state === "printing" || state === "done"
        || (state === "failed" && job?.kioskSubmission && job.failReason === "printer");
    if (imageReady) {
        resp.resultUrl = `/api/generate/${encodeURIComponent(filePrefix)}/result`;
        if (job && job.baseUrl && job.eventName) {
            resp.shareUrl = `${job.baseUrl}/s/${encodeURIComponent(resultPrefix)}?e=${encodeURIComponent(job.eventName)}`;
        }
    }
    if (resultPrefix !== filePrefix) resp.resultPrefix = resultPrefix;
    if (state === "failed" && job) {
        resp.failReason = job.failReason || "unknown";
    }
    if (state === "review" && job) {
        resp.note = "Held for review — an admin must approve before the result is served.";
    }
    if (job && job.kioskSubmission) {
        resp.delivery = {
            channel: job.channel,
            state: job.kioskDeliveryState || "pending",
            attempts: job.kioskDeliveryAttempts || 0,
        };
        if (job.kioskProviderStatus) resp.delivery.providerStatus = job.kioskProviderStatus;
        if (job.kioskDeliveryLastError) resp.delivery.lastError = job.kioskDeliveryLastError;
        if (job.kioskDeliveryNextAttemptAt) resp.delivery.nextAttemptAt = job.kioskDeliveryNextAttemptAt;
    }
    return resp;
}

// ── POST /api/generate ──────────────────────────────────────────────────────

function kioskError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function fieldValue(params, key) {
    const value = params[key];
    return typeof value === "string" ? value.trim() : "";
}

function resolveKioskChoices(style, requestedBrand, requestedBackground, activeStyles) {
    const activeBrands = getActiveBrands();
    const brandStep = resolveBrandStep({
        enabled: settings.get("enableBrandMenu"),
        brandKeys: Object.keys(activeBrands),
        offerUnbranded: settings.get("offerUnbranded"),
    });
    let brand = null;
    if (brandStep.kind === "skip") {
        if (requestedBrand) throw kioskError(400, "BRAND_INVALID", "Brand selection is not enabled for this event");
    } else if (brandStep.kind === "auto") {
        if (requestedBrand && requestedBrand !== brandStep.brandKey) {
            throw kioskError(400, "BRAND_INVALID", "Selected brand is not available");
        }
        brand = brandStep.brandKey;
    } else {
        if (!requestedBrand) throw kioskError(400, "BRAND_REQUIRED", "Choose a brand option");
        if (requestedBrand === "__none__") {
            if (!brandStep.includeNone) throw kioskError(400, "BRAND_INVALID", "Unbranded portraits are not available");
            brand = "__none__";
        } else if (Object.hasOwn(activeBrands, requestedBrand)) {
            brand = requestedBrand;
        } else {
            throw kioskError(400, "BRAND_INVALID", "Selected brand is not available");
        }
    }

    const backgroundStep = resolveBackgroundStep({
        style: activeStyles[style],
        brand: brand && brand !== "__none__" ? activeBrands[brand] : null,
        configuredChoices: settings.get("backgroundChoices") || [],
        enabled: settings.get("enableBackgroundMenu"),
    });
    let background = null;
    if (backgroundStep.kind === "skip") {
        if (requestedBackground) throw kioskError(400, "BACKGROUND_INVALID", "Background selection is not enabled for this event");
    } else if (backgroundStep.kind === "auto") {
        if (requestedBackground && requestedBackground !== backgroundStep.backgroundKey) {
            throw kioskError(400, "BACKGROUND_INVALID", "Selected background is not available");
        }
        background = backgroundStep.backgroundKey;
    } else {
        if (!requestedBackground) throw kioskError(400, "BACKGROUND_REQUIRED", "Choose a background option");
        if (!backgroundStep.choices.some((choice) => choice.key === requestedBackground)) {
            throw kioskError(400, "BACKGROUND_INVALID", "Selected background is not available");
        }
        background = requestedBackground;
    }
    return { brand, background };
}

router.post("/", (req, res, next) => {
    if (authenticateAdminSession(req)) return next();
    const kioskSession = authenticateKioskSession(req);
    if (kioskSession) {
        req.kioskSession = kioskSession;
        return next();
    }
    return res.status(401).json({ error: "Kiosk session expired; ask staff to relaunch", code: "KIOSK_SESSION_EXPIRED" });
}, async (req, res) => {
    let privateInputPath = null;
    let claimInput = null;
    let ownsClaim = false;
    let enqueued = false;
    try {
        const { buffer, ext, fields } = await extractUploadedImage(req);
        const eventName = settings.get("eventName");
        const kioskSubmission = fields.kiosk === "1" || req.query.kiosk === "1";
        const params = kioskSubmission ? fields : req.query;
        if (req.kioskSession && !kioskSubmission) {
            throw kioskError(403, "KIOSK_ONLY", "Kiosk session cannot use programmatic generation");
        }
        if (req.kioskSession && req.kioskSession.eventName !== eventName) {
            throw kioskError(409, "EVENT_CHANGED", "The active event changed; ask staff to relaunch");
        }
        if (kioskSubmission && fieldValue(params, "event") !== eventName) {
            throw kioskError(409, "EVENT_CHANGED", "The active event changed; start again");
        }
        if (kioskSubmission && fieldValue(params, "consent") !== "1") {
            throw kioskError(400, "CONSENT_REQUIRED", "Participation consent is required");
        }
        const requestId = kioskSubmission ? fieldValue(params, "requestId") : null;
        let kioskRequestDigest = null;
        if (kioskSubmission) {
            kioskRequests.requestPath(requestId); // validate before using it for queue recovery
            const choices = ["event", "style", "brand", "background", "channel", "phone", "email", "locale", "consent", "whatsappOptIn"]
                .map((key) => fieldValue(params, key));
            const digest = crypto.createHash("sha256").update(buffer).update(JSON.stringify(choices)).digest("hex");
            kioskRequestDigest = digest;
            claimInput = { requestId, digest, eventName, lookupJob: findQueuedRequest };
            // The queue manifest can outlive a failed HTTP response or an
            // interrupted claim. Reconcile it before deciding whether to
            // enqueue again, and compare the original payload fingerprint.
            const recoveredGroup = await queue.ensureKioskGroupPublished(requestId, eventName);
            if (recoveredGroup && recoveredGroup.digest !== digest) {
                throw kioskError(409, "REQUEST_ID_CONFLICT", "Request ID belongs to a different submission");
            }
            const claim = await kioskRequests.claim(claimInput);
            if (claim.kind === "existing") {
                if (recoveredGroup && !recoveredGroup.complete) kioskRequestInProgress(res);
                const filePrefix = recoveredGroup?.filePrefix || await canonicalKioskPrefix(claim.filePrefix);
                if (filePrefix !== claim.filePrefix) await kioskRequests.complete(claimInput, filePrefix);
                return await respondToExistingKioskRequest(res, filePrefix);
            }
            if (claim.kind === "in_progress") {
                if (recoveredGroup?.complete) {
                    await kioskRequests.complete(claimInput, recoveredGroup.filePrefix);
                    return await respondToExistingKioskRequest(res, recoveredGroup.filePrefix);
                }
                kioskRequestInProgress(res);
            }
            ownsClaim = true;
            if (recoveredGroup) {
                if (!recoveredGroup.complete) kioskRequestInProgress(res);
                await kioskRequests.complete(claimInput, recoveredGroup.filePrefix);
                enqueued = true;
                return await respondToExistingKioskRequest(res, recoveredGroup.filePrefix);
            }
        }

        // Resolve style (query param). Default: first active style.
        const activeStyleList = settings.getActiveStyleList();
        const activeStyles = settings.getActiveStyles();
        const requestedStyle = fieldValue(params, "style").toLowerCase();
        let style;
        if (requestedStyle && activeStyles[requestedStyle]) {
            style = requestedStyle;
        } else if (requestedStyle) {
            throw kioskError(400, "STYLE_INVALID", `Unknown style "${requestedStyle}"`);
        } else if (activeStyleList.length > 0) {
            if (kioskSubmission) throw kioskError(400, "STYLE_REQUIRED", "Choose an art style");
            style = activeStyleList[0];
        } else {
            throw kioskError(409, "STYLE_UNAVAILABLE", "No active styles configured for this event");
        }

        let brand = fieldValue(params, "brand") || null;
        let background = fieldValue(params, "background") || null;
        if (kioskSubmission) {
            ({ brand, background } = resolveKioskChoices(style, brand, background, activeStyles));
        } else {
            if (brand && !(settings.get("customBrands") || {})[brand]) {
                throw kioskError(400, "BRAND_INVALID", `Unknown brand "${brand}"`);
            }
            if (background && !(settings.get("backgroundChoices") || []).some((choice) => choice.key === background)) {
                throw kioskError(400, "BACKGROUND_INVALID", `Unknown background "${background}"`);
            }
        }

        const rawPhone = fieldValue(params, "phone");
        const rawEmail = fieldValue(params, "email").toLowerCase();
        let contactPhone = "";
        let contactEmail = "";
        if (rawPhone) {
            if (!E164_RE.test(rawPhone)) {
                throw kioskError(400, "DESTINATION_INVALID", "Phone must be in E.164 format (e.g. +14155551234)");
            }
            contactPhone = rawPhone;
        }
        if (rawEmail) {
            if (!EMAIL_RE.test(rawEmail)) {
                throw kioskError(400, "DESTINATION_INVALID", "Email looks invalid");
            }
            contactEmail = rawEmail;
        }

        const languageMode = settings.getForEvent("languageMode", eventName);
        const requestedLocale = i18n.normalizeLocale(fieldValue(params, "locale"));
        const locale = languageMode === "ask"
            ? (requestedLocale || (contactPhone ? contacts.getPreferredLocale(contactPhone, eventName) : null) || i18n.DEFAULT_LOCALE)
            : i18n.resolveAttendeeLocale(languageMode) || i18n.DEFAULT_LOCALE;
        const deliveryChannel = resolveKioskDeliveryChannel({
            requestedChannel: fieldValue(params, "channel"),
            hasPhone: !!contactPhone,
            hasEmail: !!contactEmail,
            kioskSubmission,
            eventName,
            locale,
        });
        if (kioskSubmission && deliveryChannel === "whatsapp" && fieldValue(params, "whatsappOptIn") !== "1") {
            throw kioskError(400, "WHATSAPP_OPT_IN_REQUIRED", "WhatsApp delivery opt-in is required");
        }
        // Keep the event's portrait limit for email guests too. A stable hash
        // lets the queue count repeat submissions without exposing the email
        // address through its phone-oriented usage and printer surfaces.
        const emailUsageId = kioskSubmission && deliveryChannel === "email"
            ? `api:email:${crypto.createHash("sha256").update(contactEmail).digest("hex")}` : "";
        const usageId = contactPhone || emailUsageId;
        const assertKioskQuotaAvailable = () => {
            if (!kioskSubmission || !usageId || isAdmin(usageId)) return;
            const maxPrints = settings.getForEvent("maxPrints", eventName);
            if (!settings.isUnlimitedQuota(maxPrints) && getUsageCount(usageId, eventName) >= maxPrints) {
                throw kioskError(429, "QUOTA_REACHED", "This destination has reached the event portrait limit");
            }
        };
        if (kioskSubmission) {
            let rebuilding;
            while ((rebuilding = getInFlightUsageRebuild())) await rebuilding;
        }
        assertKioskQuotaAvailable();

        const id = requestId || crypto.randomUUID();
        let inputFilename = null;
        let imageUrl = "";
        if (kioskSubmission) {
            // The queue copies this private JPEG into its own staged input.
            // Kiosk captures never need a public original-photo URL.
            await fsp.mkdir(KIOSK_UPLOAD_DIR, { recursive: true, mode: 0o700 });
            privateInputPath = path.join(KIOSK_UPLOAD_DIR, `${id}.jpg`);
            let jpeg;
            try { jpeg = await sharp(buffer).rotate().jpeg({ quality: 90 }).toBuffer(); }
            catch { throw kioskError(415, "IMAGE_INVALID", "The uploaded image could not be decoded"); }
            await fsp.writeFile(privateInputPath, jpeg, { mode: 0o600 });
        } else {
            // Programmatic API clients continue to use a public upload URL.
            inputFilename = `api_${id}_input.${ext}`;
            const downloadDir = settings.getDownloadDir(eventName);
            await fsp.mkdir(downloadDir, { recursive: true });
            await fsp.writeFile(path.join(downloadDir, inputFilename), buffer);
            require("./photogallery").rememberPublicApiInput(eventName, inputFilename);
        }

        // Resolve base URL — prefer BASE_URL env var (set on the deploy to
        // the public FQDN) so Twilio can actually fetch the MMS media URL.
        // Fall back to request headers for local dev where BASE_URL is blank.
        let baseUrl = process.env.BASE_URL || "";
        if (!baseUrl) {
            const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
            const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
            baseUrl = `${proto}://${host}`;
        }
        baseUrl = baseUrl.trim().replace(/\/+$/, "");
        if (!kioskSubmission) {
            imageUrl = `${baseUrl}/photogallery/img/${encodeURIComponent(eventName)}/${encodeURIComponent(inputFilename)}`;
        }

        // When the kiosk caller provides a phone, delivery, share links, promo,
        // NPS, and lead survey all use its selected channel. With no phone, use
        // a synthetic identifier and suppress every outbound messaging path.
        const userPhone = usageId || `api:${id.slice(0, 8)}`;
        const appPhone = contactPhone
            ? settings.get(deliveryChannel === "whatsapp" ? "twilioWhatsappNumber" : "twilioPhoneNumber") || ""
            : "";
        const messageSid = `api-${id}`;
        const extras = {
            apiSubmission: true,
            kioskSubmission,
            ...(inputFilename ? { uploadedInputFile: inputFilename } : {}),
            ...(privateInputPath ? { sourceImagePath: privateInputPath } : {}),
            ...(requestId ? { requestId } : {}),
            ...(kioskRequestDigest ? { kioskRequestDigest } : {}),
            ...(deliveryChannel === "email" ? { kioskEmail: contactEmail } : {}),
            ...(kioskSubmission ? { consentedAt: Date.now() } : {}),
            ...(deliveryChannel === "whatsapp" && kioskSubmission ? { whatsappOptInAt: Date.now() } : {}),
            channel: deliveryChannel || "sms",
            locale,
            styleName: optionI18n.localizeOption("style", style, activeStyles[style] || { name: style }, locale).name,
            eventName,
        };
        if (!kioskSubmission && !contactPhone) extras.noDelivery = true;

        // Image conversion and staging yield to other requests. Recheck here,
        // without an await before enqueueJob increments usage synchronously.
        if (kioskSubmission) {
            let rebuilding;
            while ((rebuilding = getInFlightUsageRebuild())) await rebuilding;
        }
        assertKioskQuotaAvailable();
        const enq = enqueueJob(
            imageUrl,
            messageSid,
            userPhone,
            appPhone,
            style,
            baseUrl,
            background,
            brand,
            extras,
        );
        if (!enq || !enq.filePrefix) {
            throw kioskError(500, "QUEUE_FAILED", "Failed to enqueue job");
        }
        enqueued = true;
        if (privateInputPath) {
            await fsp.unlink(privateInputPath).catch(() => {});
            privateInputPath = null;
        }
        if (claimInput) await kioskRequests.complete(claimInput, enq.filePrefix);

        // Record the submission so it shows up in the outreach tab — even
        // if both phone and email are empty. Keyed on filePrefix so the
        // outreach UI can look up the portrait thumbnail.
        if (kioskSubmission) try {
            kioskSubmissions.add({
                filePrefix: enq.filePrefix,
                event: eventName,
                phone: contactPhone,
                email: contactEmail,
                channel: deliveryChannel || "",
                style,
                baseUrl,
                consentedAt: extras.consentedAt,
                whatsappOptInAt: extras.whatsappOptInAt || null,
            });
        } catch (err) {
            console.error(`⚠️  Kiosk submission record write failed: ${err.message}`);
        }

        if (!kioskSubmission && req.query.wait) {
            return res.redirect(303, `/api/generate/${encodeURIComponent(enq.filePrefix)}/wait`);
        }

        const body = describeJobForResponse(enq.filePrefix, "pending", null);
        body.waitUrl = `/api/generate/${encodeURIComponent(enq.filePrefix)}/wait`;
        res.status(202).json(body);
    } catch (err) {
        if (privateInputPath) await fsp.unlink(privateInputPath).catch(() => {});
        if (ownsClaim && !enqueued) await kioskRequests.release(claimInput).catch(() => {});
        const status = err.status || 500;
        if (status >= 500) console.error(`❌ /api/generate failed: ${err.message}`);
        res.status(status).json({ error: err.message, code: err.code || "GENERATE_FAILED" });
    }
});

// ── GET /api/generate/:prefix/status ────────────────────────────────────────

router.get("/:prefix/status", async (req, res) => {
    const prefix = req.params.prefix;
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) return res.status(400).json({ error: "Invalid filePrefix" });
    const { state, job, resultPrefix } = await findResolvedJobState(prefix);
    res.json(describeJobForResponse(prefix, state, job, resultPrefix));
});

// ── GET /api/generate/:prefix/wait ──────────────────────────────────────────
// Long-poll: blocks until the job reaches a terminal state or the timeout
// elapses. On success, 303-redirects to /result so curl -L can save directly.

router.get("/:prefix/wait", async (req, res) => {
    const prefix = req.params.prefix;
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) return res.status(400).json({ error: "Invalid filePrefix" });
    const timeoutMs = Math.min(180000, Math.max(5000, Number(req.query.timeout) || 90000));
    const pollEveryMs = 1000;
    const deadline = Date.now() + timeoutMs;

    // Tolerate a few consecutive "unknown" readings before treating the job
    // as gone — covers the narrow race where the job file is in transit
    // between queue dirs, or any disk hiccup.
    let consecutiveUnknown = 0;
    const MAX_UNKNOWN_BEFORE_GONE = 3;
    while (Date.now() < deadline) {
        const { state, job } = await findResolvedJobState(prefix);
        if (state === "done" || state === "ready" || state === "printing"
            || (state === "failed" && job?.kioskSubmission && job.failReason === "printer")) {
            return res.redirect(303, `/api/generate/${encodeURIComponent(prefix)}/result`);
        }
        if (state === "failed") {
            return res.status(422).json({ state, filePrefix: prefix, failReason: job ? job.failReason : "unknown" });
        }
        if (state === "unknown") {
            if (++consecutiveUnknown >= MAX_UNKNOWN_BEFORE_GONE) {
                return res.status(410).json({ state: "gone", filePrefix: prefix });
            }
        } else {
            consecutiveUnknown = 0;
        }
        await new Promise((r) => setTimeout(r, pollEveryMs));
    }
    res.status(504).json({ state: "timeout", filePrefix: prefix, message: "Generation didn't finish within the wait window — poll /status instead." });
});

// ── GET /api/generate/:prefix/debug ─────────────────────────────────────────
// Diagnostic: shows the job record + whether its output file is on disk.
// Helps diagnose "didn't show in photo book" reports.
router.get("/:prefix/debug", async (req, res) => {
    const prefix = req.params.prefix;
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) return res.status(400).json({ error: "Invalid filePrefix" });
    const { state, job, resultPrefix } = await findResolvedJobState(prefix);
    const downloadDir = settings.getDownloadDir(job ? job.eventName : undefined);
    const outputFile = path.join(downloadDir, `${resultPrefix}_output.png`);
    const stagingFile = path.join(downloadDir, ".staging", `${resultPrefix}_output.png`);
    res.json({
        prefix,
        resultPrefix,
        state,
        job,
        outputExists: fs.existsSync(outputFile),
        stagingExists: fs.existsSync(stagingFile),
        downloadDir,
        baseUrlEnv: process.env.BASE_URL || null,
    });
});

// ── GET /api/generate/:prefix/result ────────────────────────────────────────
// Streams the exact PNG output master.

router.get("/:prefix/result", async (req, res) => {
    const prefix = req.params.prefix;
    if (!/^[A-Za-z0-9_-]+$/.test(prefix)) return res.status(400).send("Invalid filePrefix");
    const { state, job, resultPrefix } = await findResolvedJobState(prefix);
    if (state !== "ready" && state !== "printing" && state !== "done"
        && !(state === "failed" && job?.kioskSubmission && job.failReason === "printer")) {
        return res.status(409).json({ state, filePrefix: prefix, message: "Result not ready yet" });
    }
    const eventName = job ? job.eventName : undefined;
    const filePath = path.join(settings.getDownloadDir(eventName), `${resultPrefix}_output.png`);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Output image missing on disk" });
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `inline; filename="${resultPrefix}_output.png"`);
    res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
    fs.createReadStream(filePath).pipe(res);
});

function mountApiGenerate(app) {
    app.use("/api/generate", router);
    console.log("🖼️  /api/generate mounted (programmatic selfie → portrait)");
}

module.exports = { mountApiGenerate, sweepStaleKioskUploads };

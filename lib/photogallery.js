const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const express = require("express");
const sharp = require("sharp");
const settings = require("./settings");
const { authenticateAdminSession } = require("./auth");
const { requireStagedMediaAuth } = require("./review-auth");
const i18n = require("./i18n");
const optionI18n = require("./option-i18n");
const { moveJobsToEvent } = require("./queue");
const { DONE_DIR, FAILED_DIR, PENDING_DIR, GENERATING_DIR, READY_DIR, PRINTING_DIR, REVIEW_DIR } = require("./config");

const ROOT_DIR = path.join(__dirname, "..");
const router = express.Router();
router.use(express.json());

// Job metadata is resolved once by exact filename, never by repeatedly scanning
// the full terminal history.
const _styleMap = new Map();
const _imageOrientationCache = new Map();
const _styleMissCache = new Set();
const _imageListCache = new Map();
const _imageListRefresh = new Map();
const _imageListGeneration = new Map();
const _thumbnailCache = new Map();
const IMAGE_LIST_TTL = 10_000;
const IMAGE_LIST_CACHE_MAX = 50;
const STYLE_CACHE_MAX = 100_000;
const ORIENTATION_CACHE_MAX = 5000;
const STYLE_READ_BATCH_SIZE = 50;
const MAX_IMAGE_PAGE_SIZE = 100;
const IMAGE_PAGE_CACHE_MAX = 12;
const THUMB_CACHE_MAX = 200;
const THUMB_CACHE_TTL = 60_000;
const STYLE_DIRS = [DONE_DIR, FAILED_DIR, READY_DIR, PRINTING_DIR, REVIEW_DIR, GENERATING_DIR, PENDING_DIR];

function _rememberStyleInfo(job) {
    if (!job || !job.eventName || !job.filePrefix) return;
    const key = `${job.eventName}:${job.filePrefix}`;
    if (!_styleMap.has(key) && _styleMap.size >= STYLE_CACHE_MAX) {
        _styleMap.delete(_styleMap.keys().next().value);
    }
    _styleMap.set(key, {
        style: job.style || null,
        styleName: job.styleName,
        locale: job.locale,
        orientation: job.outputProfile && job.outputProfile.orientation || "portrait",
    });
    _styleMissCache.delete(key);
}

async function _getStyleInfo(eventName, prefix, styleMap) {
    const key = `${eventName}:${prefix}`;
    if (styleMap.has(key)) return styleMap.get(key);
    if (_styleMissCache.has(key)) return {};

    const filename = `${prefix}.json`;
    for (const qDir of STYLE_DIRS) {
        try {
            const job = JSON.parse(await fsp.readFile(path.join(qDir, filename), "utf-8"));
            if (job.eventName !== eventName) continue;
            _rememberStyleInfo(job);
            return _styleMap.get(key);
        } catch {}
    }
    if (_styleMissCache.size >= STYLE_CACHE_MAX) _styleMissCache.delete(_styleMissCache.values().next().value);
    _styleMissCache.add(key);
    return {};
}

function _imageCacheKey(event) {
    return event || settings.get("eventName");
}

function _invalidateImageList(event) {
    for (const key of new Set([_imageCacheKey(event), "all"])) {
        _imageListGeneration.set(key, (_imageListGeneration.get(key) || 0) + 1);
        _imageListCache.delete(key);
    }
    const target = _imageCacheKey(event);
    for (const [key, value] of _thumbnailCache) {
        if (target === "all" || value.event === target) _thumbnailCache.delete(key);
    }
}

function invalidatePhotoGalleryCache(event, { styles = false } = {}) {
    _invalidateImageList(event);
    if (!styles || !event) return;
    const prefix = `${event}:`;
    for (const key of _styleMap.keys()) {
        if (key.startsWith(prefix)) _styleMap.delete(key);
    }
    for (const key of _styleMissCache) {
        if (key.startsWith(prefix)) _styleMissCache.delete(key);
    }
}

function _setImageListCache(key, payload) {
    _imageListCache.delete(key);
    if (_imageListCache.size >= IMAGE_LIST_CACHE_MAX) {
        _imageListCache.delete(_imageListCache.keys().next().value);
    }
    _imageListCache.set(key, { payload, ts: Date.now() });
}

router.get("/", (req, res) => {
    if (!req.originalUrl.endsWith("/") && !req.originalUrl.includes("?"))
        return res.redirect(req.originalUrl + "/");
    const eventName = String(req.query.event || settings.get("eventName")).replace(/[^a-zA-Z0-9_\- ]/g, "");
    // The photo book also runs inside public-facing kiosk displays. Do not
    // render workspace links in an embedded frame, even for a logged-in admin.
    const embedded = req.get("sec-fetch-dest") === "iframe";
    res.type("html").send(buildPageHtml(eventName, req.query.lang, {
        adminNav: !embedded && Boolean(authenticateAdminSession(req)),
    }));
});

function isSafeMediaRouteSegment(value) {
    if (typeof value !== "string" || !value) return false;
    let candidate = value;
    for (let depth = 0; depth < 5; depth++) {
        if (candidate.startsWith(".") || candidate.includes("/") || candidate.includes("\\") || /[\x00-\x1f\x7f]/.test(candidate)) return false;
        if (!candidate.includes("%")) return true;
        try {
            const decoded = decodeURIComponent(candidate);
            if (decoded === candidate) return true;
            candidate = decoded;
        } catch {
            return false;
        }
    }
    return false;
}

router.get("/img/:event/:file", (req, res) => {
    const { event, file } = req.params;
    if (!isSafeMediaRouteSegment(event) || !isSafeMediaRouteSegment(file)) return res.sendStatus(400);
    const root = path.join(ROOT_DIR, "downloads", event);
    res.setHeader("Cache-Control", file.endsWith("_input.jpg")
        ? "private, no-store"
        : "public, max-age=0, must-revalidate");
    res.sendFile(file, { root }, (err) => {
        if (err && !res.headersSent) res.sendStatus(404);
    });
});

function _smallWebp(imagePath) {
    return sharp(imagePath).rotate().resize(320, 320, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 76, effort: 3 }).toBuffer();
}

function _outputThumbnail(event, file, imagePath) {
    const key = JSON.stringify([event, file]);
    const cached = _thumbnailCache.get(key);
    if (cached && Date.now() - cached.ts < THUMB_CACHE_TTL) {
        _thumbnailCache.delete(key);
        _thumbnailCache.set(key, cached);
        return cached.promise;
    }
    const promise = _smallWebp(imagePath);
    _thumbnailCache.delete(key);
    if (_thumbnailCache.size >= THUMB_CACHE_MAX) _thumbnailCache.delete(_thumbnailCache.keys().next().value);
    _thumbnailCache.set(key, { promise, ts: Date.now(), event });
    promise.catch(() => {
        if (_thumbnailCache.get(key)?.promise === promise) _thumbnailCache.delete(key);
    });
    return promise;
}

router.get("/thumb/:event/:file", async (req, res) => {
    const { event, file } = req.params;
    if (!isSafeMediaRouteSegment(event) || !isSafeMediaRouteSegment(file)
        || !(/_output\.png$|_input\.jpg$/).test(file)) return res.sendStatus(400);
    const isSelfie = file.endsWith("_input.jpg");
    const imagePath = path.join(ROOT_DIR, "downloads", event, file);
    res.setHeader("Cache-Control", isSelfie ? "private, no-store" : "public, max-age=0, must-revalidate");
    try {
        const buffer = isSelfie ? await _smallWebp(imagePath) : await _outputThumbnail(event, file, imagePath);
        res.type("image/webp").send(buffer);
    } catch {
        if (!res.headersSent) res.sendStatus(404);
    }
});

router.get("/staging/:event/:file", requireStagedMediaAuth, (req, res) => {
    const { event, file } = req.params;
    if (!isSafeMediaRouteSegment(event) || !isSafeMediaRouteSegment(file)) return res.sendStatus(400);
    const root = path.join(ROOT_DIR, "downloads", event, ".staging");
    res.setHeader("Cache-Control", "private, no-store");
    res.sendFile(file, { root }, (err) => {
        if (err && !res.headersSent) res.sendStatus(404);
    });
});

function gallerySettings(eventName = settings.get("eventName"), requestedLocale) {
    const settingsEvent = eventName === "all" ? settings.get("eventName") : eventName;
    const languageMode = settings.getForEvent("languageMode", settingsEvent);
    return {
        currentEvent: eventName,
        locale: languageMode === "ask"
            ? (i18n.normalizeLocale(requestedLocale) || i18n.DEFAULT_LOCALE)
            : (i18n.resolveAttendeeLocale(languageMode) || i18n.DEFAULT_LOCALE),
        termsUrl: settings.getForEvent("termsUrl", settingsEvent) || "",
        revealAnimation: settings.getForEvent("revealAnimation", settingsEvent) || "off",
        photoBookAutoplay: settings.getForEvent("photoBookAutoplay", settingsEvent) !== false,
        photoBookInterval: settings.getForEvent("photoBookInterval", settingsEvent) || 10,
        milestonesEnabled: settings.getForEvent("milestonesEnabled", settingsEvent) !== false,
        milestoneInterval: settings.getForEvent("milestoneInterval", settingsEvent) || 100,
    };
}

router.get("/api/events", async (req, res) => {
    const requestedEvent = String(req.query.event || settings.get("eventName")).replace(/[^a-zA-Z0-9_\- ]/g, "");
    try {
        const dlRoot = path.join(ROOT_DIR, "downloads");
        const entries = await fsp.readdir(dlRoot, { withFileTypes: true });
        const events = entries.filter((d) => d.isDirectory()).map((d) => d.name).sort();
        res.json({ events, ...gallerySettings(requestedEvent, req.query.lang) });
    } catch {
        res.json({ events: [], ...gallerySettings(requestedEvent, req.query.lang) });
    }
});

async function _buildImageIndex(event) {
    let dirs;
    if (event && event !== "all") {
        if (!isSafeMediaRouteSegment(event)) {
            const err = new Error("Invalid event");
            err.status = 400;
            throw err;
        }
        dirs = [{ dir: path.join(ROOT_DIR, "downloads", event), event }];
    } else if (event === "all") {
        const dlRoot = path.join(ROOT_DIR, "downloads");
        const entries = await fsp.readdir(dlRoot, { withFileTypes: true }).catch((err) => {
            if (err.code === "ENOENT") return [];
            throw err;
        });
        dirs = entries.filter((d) => d.isDirectory())
            .map((d) => ({ dir: path.join(dlRoot, d.name), event: d.name }));
    } else {
        dirs = [{ dir: settings.getDownloadDir(), event: settings.get("eventName") }];
    }

    // Keep the cache lightweight: filename scans determine the total and
    // order, while job metadata and Sharp only run for a requested page.
    const entries = [];
    for (const { dir, event: ev } of dirs) {
        const allFilesList = await fsp.readdir(dir).catch((err) => {
            // An empty or concurrently removed event should show the empty
            // Gallery state, not fail the entire collection.
            if (err.code === "ENOENT") return [];
            throw err;
        });
        const allFiles = new Set(allFilesList);
        for (const file of allFilesList) {
            if (!file.endsWith("_output.png")) continue;
            const prefix = file.slice(0, -"_output.png".length);
            entries.push({ file, event: ev, prefix, hasSelfie: allFiles.has(prefix + "_input.jpg"), dir });
        }
    }
    entries.sort(_compareImageEntries);
    return { entries, total: entries.length, pages: new Map() };
}

function _compareImageEntries(a, b) {
    return b.file.localeCompare(a.file) || b.event.localeCompare(a.event);
}

async function _enrichImages(entries) {
    const activeStyles = settings.getActiveStyles();
    const images = [];
    for (let i = 0; i < entries.length; i += STYLE_READ_BATCH_SIZE) {
        const batch = await Promise.all(entries.slice(i, i + STYLE_READ_BATCH_SIZE).map(async (entry) => {
            const { file, event, prefix, hasSelfie, dir } = entry;
            const styleInfo = await _getStyleInfo(event, prefix, _styleMap);
            const style = typeof styleInfo === "string" ? styleInfo : styleInfo.style;
            const eventLocale = i18n.resolveAttendeeLocale(settings.getForEvent("languageMode", event), null, styleInfo.locale) || i18n.DEFAULT_LOCALE;
            const styleName = styleInfo.styleName || (style ? optionI18n.localizeOption("style", style, activeStyles[style] || { name: style }, eventLocale).name : null);
            let orientation = styleInfo.orientation;
            if (!orientation) {
                const imagePath = path.join(dir, file);
                const cached = _imageOrientationCache.get(imagePath);
                if (cached) {
                    orientation = cached;
                } else {
                    try {
                        const metadata = await sharp(imagePath).metadata();
                        orientation = metadata.width > metadata.height ? "landscape" : "portrait";
                        if (_imageOrientationCache.size >= ORIENTATION_CACHE_MAX) {
                            _imageOrientationCache.delete(_imageOrientationCache.keys().next().value);
                        }
                        _imageOrientationCache.set(imagePath, orientation);
                    } catch {
                        orientation = "portrait";
                    }
                }
            }
            return { file, event, prefix, hasAi: true, hasSelfie, style: styleName, orientation };
        }));
        images.push(...batch);
    }
    return images;
}

function _encodeImageCursor(entry) {
    return Buffer.from(JSON.stringify([entry.file, entry.event])).toString("base64url");
}

function _decodeImageCursor(raw) {
    if (typeof raw !== "string" || raw.length > 1024) {
        const err = new Error("Invalid cursor");
        err.status = 400;
        throw err;
    }
    try {
        const tuple = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
        if (Array.isArray(tuple) && tuple.length === 2 && tuple.every((value) => typeof value === "string" && value.length > 0 && value.length <= 255)) {
            return { file: tuple[0], event: tuple[1] };
        }
    } catch {}
    const err = new Error("Invalid cursor");
    err.status = 400;
    throw err;
}

function _offsetAfterCursor(entries, cursor) {
    if (!cursor) return 0;
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (_compareImageEntries(entries[mid], cursor) <= 0) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

async function _pagePayload(index, limit, cursor) {
    const key = `${limit}:${cursor ? _encodeImageCursor(cursor) : ""}`;
    if (index.pages.has(key)) return index.pages.get(key);
    const promise = (async () => {
        const offset = _offsetAfterCursor(index.entries, cursor);
        const entries = index.entries.slice(offset, offset + limit);
        const images = await _enrichImages(entries);
        const uniqueStyles = new Set(images.map((img) => img.style).filter(Boolean));
        const hasMore = offset + entries.length < index.total;
        return {
            images, total: index.total, activeStyleCount: uniqueStyles.size,
            offset, hasMore, cursor: hasMore && entries.length ? _encodeImageCursor(entries.at(-1)) : null,
        };
    })();
    if (index.pages.size >= IMAGE_PAGE_CACHE_MAX) index.pages.delete(index.pages.keys().next().value);
    index.pages.set(key, promise);
    try { return await promise; }
    catch (err) { index.pages.delete(key); throw err; }
}

async function _refreshImageList(key, event) {
    if (_imageListRefresh.has(key)) return _imageListRefresh.get(key);
    const refresh = (async () => {
        while (true) {
            const generation = _imageListGeneration.get(key) || 0;
            const payload = await _buildImageIndex(event);
            if ((_imageListGeneration.get(key) || 0) !== generation) continue;
            _setImageListCache(key, payload);
            return payload;
        }
    })();
    _imageListRefresh.set(key, refresh);
    try {
        return await refresh;
    } finally {
        _imageListRefresh.delete(key);
    }
}

router.get("/api/images", async (req, res) => {
    const event = req.query.event;
    if (event !== undefined && typeof event !== "string") return res.status(400).json({ images: [], total: 0 });
    const paginated = req.query.limit !== undefined || req.query.cursor !== undefined;
    let limit;
    let cursor;
    if (paginated) {
        const requestedLimit = req.query.limit === undefined ? MAX_IMAGE_PAGE_SIZE : Number(req.query.limit);
        if (!Number.isInteger(requestedLimit) || requestedLimit < 1) return res.status(400).json({ images: [], total: 0 });
        limit = Math.min(requestedLimit, MAX_IMAGE_PAGE_SIZE);
        if (req.query.cursor !== undefined) {
            try { cursor = _decodeImageCursor(req.query.cursor); }
            catch (err) { return res.status(err.status || 400).json({ images: [], total: 0 }); }
        }
    }
    const key = _imageCacheKey(event);
    const cached = _imageListCache.get(key);
    try {
        let index;
        if (cached && Date.now() - cached.ts < IMAGE_LIST_TTL) {
            _imageListCache.delete(key);
            _imageListCache.set(key, cached);
            index = cached.payload;
        } else {
            try { index = await _refreshImageList(key, event); }
            catch (err) {
                if (!cached) throw err;
                index = cached.payload;
            }
        }
        if (paginated) return res.json(await _pagePayload(index, limit, cursor));
        // Existing integrations that omit pagination continue to receive the
        // complete response. The photo book itself always requests a page.
        if (!index.legacy) index.legacy = _enrichImages(index.entries).then((images) => ({
            images, total: index.total,
            activeStyleCount: new Set(images.map((image) => image.style).filter(Boolean)).size,
        }));
        res.json(await index.legacy);
    } catch (err) {
        if (!res.headersSent) res.status(err.status || 500).json({ images: [], total: 0 });
    }
});

// Delete specific images by prefix + type
// body: { event, items: [{ prefix, type: "ai"|"selfie"|"both" }] }
router.delete("/api/images", async (req, res) => {
    const { event, items } = req.body || {};
    if (!event || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: "event and items[] required" });
    }
    if (event.includes("..") || event.includes("/")) return res.sendStatus(400);
    const dir = path.join(ROOT_DIR, "downloads", event);
    try { await fsp.access(dir); } catch { return res.json({ deleted: 0, errors: [] }); }

    const SUFFIXES_AI = ["_output.png", "_output_mms.jpg"];
    const SUFFIXES_SELFIE = ["_input.jpg"];

    let deleted = 0;
    const errors = [];
    for (const { prefix, type } of items) {
        if (!prefix || prefix.includes("..") || prefix.includes("/")) continue;
        const suffixes = type === "selfie" ? SUFFIXES_SELFIE
            : type === "ai" ? SUFFIXES_AI
            : [...SUFFIXES_AI, ...SUFFIXES_SELFIE];
        for (const suffix of suffixes) {
            const fp = path.join(dir, prefix + suffix);
            try {
                await fsp.unlink(fp); deleted++;
            } catch (e) {
                if (e.code !== "ENOENT") errors.push(`${prefix}${suffix}: ${e.message}`);
            }
        }
    }
    console.log(`🗑️  Deleted ${deleted} files (${items.length} items) from ${event}`);
    _invalidateImageList(event);
    res.json({ deleted, errors });
});

// Delete ALL images for an event
router.delete("/api/images/all", async (req, res) => {
    const { event, type } = req.body || {};
    if (!event) return res.status(400).json({ error: "event required" });
    if (event.includes("..") || event.includes("/")) return res.sendStatus(400);
    const dir = path.join(ROOT_DIR, "downloads", event);
    try { await fsp.access(dir); } catch { return res.json({ deleted: 0 }); }

    let deleted = 0;
    const suffixes = type === "selfie" ? ["_input.jpg"]
        : type === "ai" ? ["_output.png", "_output_mms.jpg"]
        : ["_input.jpg", "_output.png", "_output_mms.jpg"];
    try {
        const files = await fsp.readdir(dir);
        for (const f of files) {
            if (suffixes.some((s) => f.endsWith(s))) {
                await fsp.unlink(path.join(dir, f));
                deleted++;
            }
        }
    } catch (e) {
        _invalidateImageList(event);
        return res.status(500).json({ error: e.message });
    }
    const label = type === "selfie" ? "selfies" : type === "ai" ? "AI outputs" : "ALL";
    console.log(`🗑️  Deleted ${label} ${deleted} files from event "${event}"`);
    _invalidateImageList(event);
    res.json({ deleted });
});

// Move photos between events
router.post("/api/move", async (req, res) => {
    const { prefixes, fromEvent, toEvent } = req.body || {};
    if (!Array.isArray(prefixes) || !prefixes.length || !fromEvent || !toEvent) {
        return res.status(400).json({ error: "prefixes, fromEvent, and toEvent required" });
    }
    if (fromEvent === toEvent) return res.status(400).json({ error: "Source and target events are the same" });
    if ([fromEvent, toEvent].some(e => e.includes("..") || e.includes("/") || e.includes("\\"))) {
        return res.sendStatus(400);
    }
    try {
        const results = await moveJobsToEvent(prefixes, fromEvent, toEvent);
        const moved = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        invalidatePhotoGalleryCache(fromEvent, { styles: true });
        invalidatePhotoGalleryCache(toEvent, { styles: true });
        res.json({ moved, failed, results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const { buildPageHtml } = require("./photogallery-page");

function mountPhotoGallery(app) {
    app.use("/photogallery", router);
    console.log("📖 Photo book mounted at /photogallery");
}

module.exports = { buildPageHtml, mountPhotoGallery, invalidatePhotoGalleryCache, rememberPhotoGalleryJob: _rememberStyleInfo };

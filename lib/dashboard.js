const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { exec } = require("child_process");
const express = require("express");
const PDFDocument = require("pdfkit");
const sharp = require("sharp");
const {
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    PRINTING_DIR,
    REVIEW_DIR,
    DONE_DIR,
    FAILED_DIR,
} = require("./config");
const settings = require("./settings");
const { readinessIssues } = require("./voice/readiness");
const { getPrinterBusyState, incrementUsage, getReviewQueue, approveJob, rejectJob, isAdmin, getAllUsers, resetUsage, toggleAdmin, pickVariant, regenerateVariant, rejectParent, requeueDoneJobForReprint, getVoiceDeliveryIssues, retryVoiceDelivery } = require("./queue");
const { jobPaths } = require("./pipeline");
const audit = require("./audit");
const leads = require("./leads");
const contacts = require("./contacts");
const kioskSubmissions = require("./kiosk-submissions");
const nps = require("./nps");
const { userBarSnippet, magicHatSnippet } = require("./auth");
const QRCode = require("qrcode");
const { getRelayPrinters } = require("./print-relay");
const dub = require("./dub");
const shareClicks = require("./share-clicks");
const { shapeActiveJob } = require("./relay-jobs");
const { loadOpenAIModelCatalog } = require("./openai-models");
const { getEventSummary } = require("./event-summary");
const { renderDashboardPage } = require("./dashboard-page");
const { renderLogsPage } = require("./logs-page");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));
const JOB_SNAPSHOT_MUTATIONS = new Map([
    ["/api/review-job", [REVIEW_DIR, READY_DIR, FAILED_DIR, PENDING_DIR, DONE_DIR]],
    ["/api/review-bulk", [REVIEW_DIR, READY_DIR, FAILED_DIR, DONE_DIR]],
    ["/api/variant/pick", [REVIEW_DIR, READY_DIR, FAILED_DIR, DONE_DIR]],
    ["/api/variant/regenerate", [REVIEW_DIR, PENDING_DIR]],
    ["/api/retry-job", [FAILED_DIR, READY_DIR, PENDING_DIR]],
    ["/api/reprint-job", [DONE_DIR, READY_DIR]],
    ["/api/release-ready-job", [READY_DIR]],
    ["/api/toggle-printer", [READY_DIR]],
]);
const _settingsFilesCache = { data: null, ts: 0, pending: null, version: 0 };
function invalidateSettingsFilesCache() {
    _settingsFilesCache.data = null;
    _settingsFilesCache.ts = 0;
    _settingsFilesCache.version++;
}
router.use((req, res, next) => {
    const settingsMutation = req.method !== "GET" && (req.path === "/api/settings"
        || req.path.startsWith("/api/settings/"));
    if (req.path === "/api/settings" || req.path.startsWith("/api/settings/")
        || req.path === "/api/audit" || req.path.startsWith("/api/audit/")) {
        res.set("Cache-Control", "private, no-store");
    }
    if (settingsMutation) {
        invalidateSettingsFilesCache();
        // A concurrent GET may finish discovery before this mutation commits.
        // Drop that snapshot again when the mutation's response completes.
        res.once("finish", () => {
            invalidateSettingsFilesCache();
            if (res.statusCode >= 200 && res.statusCode < 300) invalidateStatsCache();
        });
    }
    if (req.method !== "GET" && (req.path === "/api/dashboard-users/reset-survey"
        || req.path.startsWith("/api/audit/revert/"))) {
        res.once("finish", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) invalidateStatsCache();
        });
    }
    if (req.method !== "GET" && (JOB_SNAPSHOT_MUTATIONS.has(req.path)
        || /^\/api\/events\/[^/]+\/reset-data$/.test(req.path))) {
        res.once("finish", () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                invalidateJobSnapshots(JOB_SNAPSHOT_MUTATIONS.get(req.path));
            }
        });
    }
    next();
});

const TEMPLATE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif"]);
const TEMPLATE_FORMATS = {
    ".png": "png",
    ".jpg": "jpeg",
    ".jpeg": "jpeg",
    ".gif": "gif",
};
const MAX_TEMPLATE_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const MAX_TEMPLATE_PIXELS = 50_000_000;
const MAX_TEMPLATE_EDGE = 10_000;
const TEMPLATE_SETTING_KEYS = new Set([
    "templateFile",
    "templateFilesByOrientation",
    "templateCompatibilityOverrides",
    "templateDeletionTombstones",
]);
let _templateOperationCounter = 0;
let _templateOperationTail = Promise.resolve();

async function withTemplateOperationLock(operation) {
    let release;
    const previous = _templateOperationTail;
    _templateOperationTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
        return await operation();
    } finally {
        release();
    }
}

function validExistingTemplateName(filename) {
    return typeof filename === "string"
        && filename.length > 0
        && filename === path.basename(filename)
        && !/[\\/\0]/.test(filename)
        && TEMPLATE_EXTENSIONS.has(path.extname(filename).toLowerCase());
}

function validManagedTemplateName(filename) {
    return typeof filename === "string"
        && filename.length > 0
        && filename === path.basename(filename)
        && !/[\\/\0]/.test(filename)
        && [...TEMPLATE_EXTENSIONS, ".svg"].includes(path.extname(filename).toLowerCase());
}

function sanitizedRenamedTemplateName(name, sourceFilename) {
    if (typeof name !== "string" || /[\\/\0]/.test(name)) return "";
    const requested = name.trim();
    if (!requested) return "";
    const requestedExt = path.extname(requested);
    const stem = (requestedExt ? requested.slice(0, -requestedExt.length) : requested)
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/^\.+/, "")
        .replace(/_+/g, "_");
    return stem ? stem + path.extname(sourceFilename).toLowerCase() : "";
}

function sanitizeTemplateSettingsChanges(changes) {
    settings.refreshTemplateStateFromDisk();
    const sanitized = settings.sanitizeTemplateReferenceChanges(changes);
    // Frame-library globals are changed only by their dedicated locked APIs.
    delete sanitized.templateCompatibilityOverrides;
    delete sanitized.templateDeletionTombstones;
    return sanitized;
}

async function validateTemplateFile(filePath, filename) {
    const image = sharp(filePath, {
        animated: true,
        failOn: "error",
        limitInputPixels: MAX_TEMPLATE_PIXELS,
    });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.format !== TEMPLATE_FORMATS[path.extname(filename).toLowerCase()]) {
        throw new Error("Template data does not match its image extension");
    }
    if ((metadata.pages || 1) !== 1) {
        throw new Error("Animated or multipage templates are not supported");
    }
    if (metadata.width > MAX_TEMPLATE_EDGE || metadata.height > MAX_TEMPLATE_EDGE) {
        throw new Error("Template dimensions exceed the maximum edge length");
    }
    if (metadata.width * metadata.height > MAX_TEMPLATE_PIXELS) {
        throw new Error("Template dimensions exceed the maximum pixel count");
    }
    await image.toBuffer();
}

async function withTemplateFiles(payload) {
    try {
        payload.files = await settings.listTemplates();
    } catch (err) {
        payload.filesUnavailable = true;
        console.error(`⚠️  Template list refresh failed: ${err.message}`);
    }
    return payload;
}

// ── Reference analysis cache invalidation ────────────────────────────────────
// When a reference file is uploaded or deleted, clear cached analysis so it
// regenerates on the next generation. Brands are global; styles and backgrounds
// are per-event (current event only — other events regenerate on demand).
function invalidateRefAnalysis(refType) {
    if (refType === "brand-reference") {
        const brands = settings.get("customBrands") || {};
        let changed = false;
        for (const key of Object.keys(brands)) {
            if (brands[key].analysis) { brands[key].analysis = ""; changed = true; }
        }
        if (changed) settings.update({ customBrands: brands });
    } else if (refType === "style-reference") {
        const customs = settings.get("customStyles") || {};
        let changed = false;
        for (const key of Object.keys(customs)) {
            if (customs[key].analysis) { customs[key].analysis = ""; changed = true; }
        }
        if (changed) settings.update({ customStyles: customs });
    } else if (refType === "background-reference") {
        const bgs = settings.get("backgroundChoices") || [];
        let changed = false;
        for (const bg of bgs) {
            if (bg.analysis) { bg.analysis = ""; changed = true; }
        }
        if (changed) settings.update({ backgroundChoices: bgs });
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Async cache for directory reads. Historical queue files are nearly immutable,
// so a refresh only reads new files and the newest 60 existing files. This
// avoids re-reading years of portraits on every Dashboard poll.
const _dirCache = new Map();
const _jobsCache = new Map();
const _dirRefreshes = new Map();
const _jobRefreshes = new Map();
const _jobCacheEpochs = new Map();
const ACTIVE_CACHE_TTL = 5_000;
const HISTORICAL_CACHE_TTL = 30_000;
const JOB_READ_CONCURRENCY = 12;

function cacheTtl(dir) {
    return dir === DONE_DIR || dir === FAILED_DIR ? HISTORICAL_CACHE_TTL : ACTIVE_CACHE_TTL;
}

function invalidateJobSnapshots(dirs = [DONE_DIR, FAILED_DIR, PENDING_DIR, GENERATING_DIR, READY_DIR, PRINTING_DIR, REVIEW_DIR]) {
    for (const dir of dirs) {
        _jobCacheEpochs.set(dir, (_jobCacheEpochs.get(dir) || 0) + 1);
        _jobsCache.delete(dir);
        _dirCache.delete(dir);
        _jobRefreshes.delete(dir);
        _dirRefreshes.delete(dir);
    }
    invalidateStatsCache();
    if (dirs.includes(DONE_DIR)) _stylePreviewCache.clear();
}

async function mapWithConcurrency(items, work) {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(JOB_READ_CONCURRENCY, items.length) }, async () => {
        while (cursor < items.length) {
            const item = items[cursor++];
            await work(item);
        }
    });
    await Promise.all(workers);
}

// Trigger a background refresh of a directory listing (non-blocking, deduped).
function _refreshReaddir(dir) {
    if (_dirRefreshes.has(dir)) return _dirRefreshes.get(dir);
    const epoch = _jobCacheEpochs.get(dir) || 0;
    const run = fsp.readdir(dir).then((all) => {
        const files = all.filter((f) => f.endsWith(".json"));
        if (epoch === (_jobCacheEpochs.get(dir) || 0)) _dirCache.set(dir, { files, ts: Date.now() });
        return files;
    }).finally(() => { if (_dirRefreshes.get(dir) === run) _dirRefreshes.delete(dir); });
    _dirRefreshes.set(dir, run);
    return run;
}

// Refresh a directory without allowing duplicate scans to pile up. Azure Files
// has a per-file network round trip; a small concurrency cap gives a bounded
// speedup without launching thousands of simultaneous reads.
function _refreshJobs(dir) {
    if (_jobRefreshes.has(dir)) return _jobRefreshes.get(dir);
    const epoch = _jobCacheEpochs.get(dir) || 0;
    const run = fsp.readdir(dir).then(async (all) => {
        const files = all.filter((f) => f.endsWith(".json")).sort();
        if (epoch === (_jobCacheEpochs.get(dir) || 0)) _dirCache.set(dir, { files, ts: Date.now() });
        const previous = _jobsCache.get(dir);
        const historical = dir === DONE_DIR || dir === FAILED_DIR;
        const recent = new Set(historical ? files.slice(-60) : files);
        const byFile = new Map();
        const changed = files.filter((filename) => !previous?.byFile?.has(filename) || recent.has(filename));
        await mapWithConcurrency(changed, async (filename) => {
            try {
                const job = JSON.parse(await fsp.readFile(path.join(dir, filename), "utf-8"));
                if (job) byFile.set(filename, job);
            } catch {
                // A worker may have moved the file after readdir. Preserve the
                // previous snapshot until the next listing if one exists.
                if (previous?.byFile?.has(filename)) byFile.set(filename, previous.byFile.get(filename));
            }
        });
        for (const filename of files) {
            if (!byFile.has(filename) && previous?.byFile?.has(filename)) {
                byFile.set(filename, previous.byFile.get(filename));
            }
        }
        const jobs = files.map((filename) => byFile.get(filename)).filter(Boolean);
        if (epoch === (_jobCacheEpochs.get(dir) || 0)) _jobsCache.set(dir, { jobs, byFile, ts: Date.now() });
        return jobs;
    }).finally(() => { if (_jobRefreshes.get(dir) === run) _jobRefreshes.delete(dir); });
    _jobRefreshes.set(dir, run);
    return run;
}

// Returns cached jobs instantly (stale-while-revalidate). Never blocks.
function readJobs(dir) {
    const now = Date.now();
    const cached = _jobsCache.get(dir);
    if (cached && (now - cached.ts) < cacheTtl(dir)) return cached.jobs;
    _refreshJobs(dir).catch(() => {});
    return cached ? cached.jobs : [];
}

function countFiles(dir) {
    const now = Date.now();
    const cached = _dirCache.get(dir);
    if (cached && (now - cached.ts) < cacheTtl(dir)) return cached.files.length;
    _refreshReaddir(dir).catch(() => {});
    return cached ? cached.files.length : 0;
}

// Cold-cache-aware variants. The sync readJobs()/countFiles() above return
// []/0 when NOTHING is cached yet (fresh process, or before the module-load
// pre-warm resolves) — which made the Jobs table render empty and the queue
// counts read 0 for the first ~second after a restart. These async variants
// await a single real read ONLY on a cold cache; once warm (even if stale)
// they fall straight back to the non-blocking stale-while-revalidate path, so
// we never reintroduce the event-loop stall the sync version once caused on
// Azure Files. Awaiting here is async I/O — it yields, it does not block.
async function readJobsAsync(dir) {
    const now = Date.now();
    const cached = _jobsCache.get(dir);
    if (cached && (now - cached.ts) < cacheTtl(dir)) return cached.jobs;
    if (cached) { _refreshJobs(dir).catch(() => {}); return cached.jobs; }
    try { return await _refreshJobs(dir); } catch { return []; }
}

async function countFilesAsync(dir) {
    const now = Date.now();
    const cached = _dirCache.get(dir);
    if (cached && (now - cached.ts) < cacheTtl(dir)) return cached.files.length;
    if (cached) { _refreshReaddir(dir).catch(() => {}); return cached.files.length; }
    try { return (await _refreshReaddir(dir)).length; } catch { return 0; }
}

// Pre-warm caches on module load so first request has data
for (const dir of [DONE_DIR, FAILED_DIR, PENDING_DIR, GENERATING_DIR, READY_DIR, PRINTING_DIR, REVIEW_DIR]) {
    _refreshJobs(dir).catch(() => {});
}

function maskPhone(phone) {
    if (!phone || phone.length < 6) return phone || "unknown";
    // Kiosk / API submissions use synthetic userPhone like "api:<id>" —
    // render them as "Kiosk" so they don't look like mangled phone numbers.
    if (phone.startsWith("api:")) return "Kiosk";
    // Keep country code (+1, +44, +353, etc.) and last 4 digits
    // E.164: +{1-3 digit CC}{subscriber}. For +1 (NANP) keep 2 chars, else keep 3-4.
    const tail = phone.slice(-4);
    let ccLen = 2; // +1
    if (phone.length > 12) ccLen = 4; // +353, +852, etc.
    else if (phone.length > 11) ccLen = 3; // +44, +91, etc.
    const cc = phone.slice(0, ccLen);
    const maskLen = phone.length - ccLen - 4;
    return cc + "*".repeat(Math.max(1, maskLen)) + tail;
}

function parseFilenameTimestamp(filename) {
    // Format: YYYYMMDD_HHMMSS.json
    const m = filename.match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
}

function getAllPrinterStatuses() {
    return new Promise((resolve) => {
        const activePrinters = settings.get("activePrinters") || [];
        const baseName = settings.get("printerName") || "";
        const busyState = getPrinterBusyState();

        exec("lpstat -p", (err, stdout) => {
            if (err) {
                resolve([]);
                return;
            }
            const lines = stdout.split("\n").filter((l) => l.startsWith("printer "));
            const results = [];

            for (const line of lines) {
                const name = line.split(" ")[1];
                if (!name) continue;

                // Filter to active printers, or fall back to prefix match
                if (activePrinters.length > 0) {
                    if (!activePrinters.includes(name)) continue;
                } else if (baseName) {
                    if (!name.startsWith(baseName)) continue;
                } else {
                    continue;
                }

                const lower = line.toLowerCase();
                let status, message;
                if (lower.includes("idle")) { status = "ready"; message = "Idle"; }
                else if (lower.includes("printing")) { status = "printing"; message = "Printing"; }
                else if (lower.includes("disabled")) { status = "error"; message = "Disabled"; }
                else if (lower.includes("looking for printer") || lower.includes("unplugged")) { status = "error"; message = "Disconnected"; }
                else { status = "unknown"; message = line.split(" ").slice(2).join(" ").trim(); }

                if (busyState[name]) { status = "printing"; message = "Printing job"; }

                results.push({ name, status, message });
            }
            resolve(results);
        });
    });
}

// ── Country Code Map ─────────────────────────────────────────────────────────

const COUNTRY_CODES = {
    "1": "United States/Canada", "7": "Russia",
    "20": "Egypt", "27": "South Africa", "30": "Greece", "31": "Netherlands",
    "32": "Belgium", "33": "France", "34": "Spain", "36": "Hungary",
    "39": "Italy", "40": "Romania", "41": "Switzerland", "43": "Austria",
    "44": "United Kingdom", "45": "Denmark", "46": "Sweden", "47": "Norway",
    "48": "Poland", "49": "Germany", "51": "Peru", "52": "Mexico",
    "53": "Cuba", "54": "Argentina", "55": "Brazil", "56": "Chile",
    "57": "Colombia", "58": "Venezuela", "60": "Malaysia", "61": "Australia",
    "62": "Indonesia", "63": "Philippines", "64": "New Zealand", "65": "Singapore",
    "66": "Thailand", "81": "Japan", "82": "South Korea", "84": "Vietnam",
    "86": "China", "90": "Turkey", "91": "India", "92": "Pakistan",
    "93": "Afghanistan", "94": "Sri Lanka", "95": "Myanmar",
    "212": "Morocco", "213": "Algeria", "216": "Tunisia", "218": "Libya",
    "220": "Gambia", "221": "Senegal", "233": "Ghana", "234": "Nigeria",
    "254": "Kenya", "255": "Tanzania", "256": "Uganda", "260": "Zambia",
    "263": "Zimbabwe", "351": "Portugal", "352": "Luxembourg", "353": "Ireland",
    "354": "Iceland", "358": "Finland", "370": "Lithuania", "371": "Latvia",
    "372": "Estonia", "380": "Ukraine", "381": "Serbia", "385": "Croatia",
    "386": "Slovenia", "420": "Czech Republic", "421": "Slovakia",
    "852": "Hong Kong", "853": "Macau", "855": "Cambodia", "856": "Laos",
    "880": "Bangladesh", "886": "Taiwan", "960": "Maldives", "961": "Lebanon",
    "962": "Jordan", "963": "Syria", "964": "Iraq", "965": "Kuwait",
    "966": "Saudi Arabia", "968": "Oman", "971": "UAE", "972": "Israel",
    "973": "Bahrain", "974": "Qatar", "977": "Nepal", "992": "Tajikistan",
    "993": "Turkmenistan", "994": "Azerbaijan", "995": "Georgia", "998": "Uzbekistan",
};

function parseCountry(phone) {
    if (!phone || !phone.startsWith("+")) return "Unknown";
    const digits = phone.slice(1);
    // Try 3-digit, then 2-digit, then 1-digit prefix (longest match first)
    for (const len of [3, 2, 1]) {
        const prefix = digits.slice(0, len);
        if (COUNTRY_CODES[prefix]) return COUNTRY_CODES[prefix];
    }
    return "Other";
}

// ── Shared Stats ─────────────────────────────────────────────────────────────

async function computeStats(eventFilter, excludeAdmin) {
    const isAdmin = (phone) => settings.get("adminPhones").includes(phone);
    // On a fresh process, wait for the single shared async warmup. Returning
    // an empty cold cache would briefly show false zero totals and cache them.
    const [allDoneJobs, allFailedJobs] = await Promise.all([
        readJobsAsync(DONE_DIR), readJobsAsync(FAILED_DIR),
    ]);

    // Merge events from job files + downloads directory
    const jobEvents = [...allDoneJobs, ...allFailedJobs].map((j) => j.eventName).filter(Boolean);
    let dlEvents = [];
    try {
        const dlRoot = path.join(__dirname, "..", "downloads");
        dlEvents = (await fsp.readdir(dlRoot, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
    } catch {}
    const events = [...new Set([...jobEvents, ...dlEvents])].sort();

    const doneJobs = allDoneJobs.filter((j) =>
        (!excludeAdmin || !isAdmin(j.userPhone)) && (eventFilter === "all" || j.eventName === eventFilter));
    // Exclude "superseded" (losing sibling of a multi-variant pick — the
    // reviewer chose another variant, not a failure) and "reanalyzed"
    // (replaced by a new parent job — not a failure either). Both are
    // terminal states that land in FAILED_DIR for audit trail purposes,
    // but neither should count against success rate or failure metrics.
    const isRealFailure = (j) => j.failReason !== "superseded" && j.failReason !== "reanalyzed";
    const failedJobs = allFailedJobs.filter((j) =>
        isRealFailure(j) &&
        (!excludeAdmin || !isAdmin(j.userPhone)) && (eventFilter === "all" || j.eventName === eventFilter));

    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;
    const doneIn24h = doneJobs.filter((j) => j.createdAt && j.createdAt > oneDayAgo);

    const userCounts = {};
    for (const job of doneJobs) {
        const phone = job.userPhone || "unknown";
        userCounts[phone] = (userCounts[phone] || 0) + 1;
    }
    const uniqueUsers = Object.keys(userCounts).length;
    const avgPerUser = uniqueUsers > 0 ? (doneJobs.length / uniqueUsers).toFixed(1) : "0";

    const styleCounts = {};
    for (const job of doneJobs) {
        const style = job.style || "cartoon";
        styleCounts[style] = (styleCounts[style] || 0) + 1;
    }

    const topUsers = Object.entries(userCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([phone, count]) => ({ phone: maskPhone(phone), count }));

    const hourlyBuckets = new Array(24).fill(0);
    const hourlyLabels = new Array(24);
    const currentHour = new Date(now).getHours();
    for (let i = 0; i < 24; i++) {
        const hr = (currentHour - 23 + i + 24) % 24;
        const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
        hourlyLabels[i] = h12 + (hr < 12 ? "a" : "p");
    }
    for (const job of doneIn24h) {
        const hoursAgo = Math.floor((now - job.createdAt) / (60 * 60 * 1000));
        if (hoursAgo >= 0 && hoursAgo < 24) hourlyBuckets[23 - hoursAgo]++;
    }

    // Date range
    let earliest = Infinity, latest = 0;
    for (const job of doneJobs) {
        if (job.createdAt < earliest) earliest = job.createdAt;
        if (job.createdAt > latest) latest = job.createdAt;
    }

    // Failure breakdown
    const failureBreakdown = { moderation: 0, face_detection: 0, multi_subject: 0, generation: 0, printer: 0, review_rejected: 0, max_retries: 0, unknown: 0 };
    for (const job of failedJobs) {
        if (job.failReason && failureBreakdown.hasOwnProperty(job.failReason)) {
            failureBreakdown[job.failReason]++;
        } else if (job.permanent && !job.failReason) {
            // Backward compat: old permanent failures without failReason
            failureBreakdown.moderation++; // Most permanent failures were moderation/face_detection
        } else {
            failureBreakdown.unknown++;
        }
    }

    // Moderation rate: moderation rejections / total attempts (done + failed)
    const totalAttempts = doneJobs.length + failedJobs.length;
    const moderationRejects = failureBreakdown.moderation + failureBreakdown.face_detection;
    const moderationRate = totalAttempts > 0
        ? ((moderationRejects / totalAttempts) * 100).toFixed(1) + "%"
        : "0%";

    // Country breakdown (from successful prints only -- unique users)
    const countryUserSet = {};
    for (const phone of Object.keys(userCounts)) {
        const country = parseCountry(phone);
        if (!countryUserSet[country]) countryUserSet[country] = new Set();
        countryUserSet[country].add(phone);
    }
    const countryCounts = Object.entries(countryUserSet)
        .map(([country, phones]) => ({ country, count: phones.size }))
        .sort((a, b) => b.count - a.count);

    return {
        events, eventFilter,
        totals: { done: doneJobs.length, failed: failedJobs.length },
        prints24h: doneIn24h.length,
        uniqueUsers, avgPerUser,
        styleCounts, topUsers,
        hourlyActivity: hourlyBuckets, hourlyLabels,
        dateRange: doneJobs.length > 0 ? { earliest, latest } : null,
        failureBreakdown, moderationRate, countryCounts,
    };
}

// ── API Routes ───────────────────────────────────────────────────────────────

function pageRequest(query, defaultLimit) {
    const requestedLimit = Number.parseInt(query.limit, 10);
    const requestedOffset = Number.parseInt(query.offset, 10);
    return {
        limit: Number.isFinite(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : defaultLimit,
        offset: Number.isFinite(requestedOffset) ? Math.max(0, Math.min(1_000_000, requestedOffset)) : 0,
    };
}

function optionalPageRequest(query, defaultLimit) {
    return query.limit !== undefined || query.offset !== undefined
        ? pageRequest(query, defaultLimit) : null;
}

function setPageHeaders(res, total, page) {
    res.set("X-Total-Count", String(total));
    res.set("X-Page-Limit", String(page.limit));
    res.set("X-Page-Offset", String(page.offset));
}

function getStuckJobs(eventFilter) {
    const now = Date.now();
    const GENERATING_THRESHOLD = 5 * 60 * 1000; // 5 minutes
    const PRINTING_THRESHOLD = 10 * 60 * 1000; // 10 minutes
    const stuck = [];

    // Review items are NOT reported as stuck. They show up in their own
    // Review Queue panel with timestamps, and "stuck in review" just means
    // "no reviewer has clicked yet" — that's a staffing fact, not a system
    // fault worth raising a red banner over. Reserve the STUCK alert for
    // cases that need an admin click (hung generation, offline printer).
    const checks = [
        [GENERATING_DIR, "generating", GENERATING_THRESHOLD],
        [PRINTING_DIR, "printing", PRINTING_THRESHOLD],
    ];
    for (const [dir, label, threshold] of checks) {
        const jobs = readJobs(dir);
        for (const job of jobs) {
            if (eventFilter && eventFilter !== "all" && job.eventName !== eventFilter) continue;
            const enteredAt = job.stateChangedAt || job.generatingAt || job.createdAt;
            if (enteredAt && (now - enteredAt) > threshold) {
                stuck.push({
                    stage: label,
                    phone: maskPhone(job.userPhone),
                    style: job.style || "unknown",
                    stuckFor: Math.round((now - enteredAt) / 60000), // minutes
                });
            }
        }
    }
    return stuck;
}

function computeDurations(eventFilter, excludeAdmin) {
    const isAdmin = (phone) => settings.get("adminPhones").includes(phone);
    const doneJobs = readJobs(DONE_DIR).filter((j) =>
        (!excludeAdmin || !isAdmin(j.userPhone)) && (eventFilter === "all" || j.eventName === eventFilter));

    let genTimes = [];
    let printTimes = [];
    let totalTimes = [];

    for (const job of doneJobs) {
        // Generation time: generatingAt → readyAt or completedAt (digital mode)
        if (job.generatingAt) {
            const genEnd = job.readyAt || job.completedAt;
            if (genEnd && genEnd > job.generatingAt) {
                genTimes.push(genEnd - job.generatingAt);
            }
        }
        // Print time: printingAt → completedAt
        if (job.printingAt && job.completedAt && job.completedAt > job.printingAt) {
            printTimes.push(job.completedAt - job.printingAt);
        }
        // Total time: createdAt → smsSentAt (when user received image) or completedAt
        if (job.createdAt) {
            const deliveredAt = job.smsSentAt || job.completedAt;
            if (deliveredAt && deliveredAt > job.createdAt) {
                totalTimes.push(deliveredAt - job.createdAt);
            }
        }
    }

    const avg = (arr) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length / 1000) : null;

    return {
        avgGenerationSec: avg(genTimes),
        avgPrintSec: avg(printTimes),
        avgTotalSec: avg(totalTimes),
        genSamples: genTimes.length,
        printSamples: printTimes.length,
        totalSamples: totalTimes.length,
    };
}

// ── Stats response cache (avoids re-reading hundreds of job files every poll) ─
// Dashboard polls every 12s, so a 12s TTL missed on every scheduled poll.
// Keep independent entries for event/scope/PII combinations and share one
// in-flight build among simultaneous viewers of the same combination.
const _statsCache = new Map();
const STATS_CACHE_TTL = 30_000;
const MAX_STATS_CACHE_ENTRIES = 64;
let _statsCacheVersion = 0;

function invalidateStatsCache() {
    _statsCacheVersion++;
    _statsCache.clear();
}

function rememberStatsEntry(key, entry) {
    _statsCache.delete(key);
    _statsCache.set(key, entry);
    if (_statsCache.size > MAX_STATS_CACHE_ENTRIES) {
        _statsCache.delete(_statsCache.keys().next().value);
    }
}

async function buildStatsPayload(eventFilter, excludeAdmin, showPii, detailed) {
    // The always-visible overview avoids Dub and share-click scans. Full
    // analytics are loaded only when the operator opens Insights.
    const dubAnalyticsP = detailed ? Promise.race([
        dub.getAnalytics(eventFilter).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]) : Promise.resolve(null);
    const [stats, queueCounts, localPrinters, dubAnalytics] = await Promise.all([
        computeStats(eventFilter, excludeAdmin),
        Promise.all([
            countFilesAsync(PENDING_DIR), countFilesAsync(GENERATING_DIR),
            getReviewQueue(eventFilter).then((jobs) => jobs.length),
            countFilesAsync(READY_DIR), countFilesAsync(PRINTING_DIR),
        ]),
        getAllPrinterStatuses(),
        dubAnalyticsP,
    ]);
    const queue = Object.fromEntries(["pending", "generating", "review", "ready", "printing"]
        .map((key, index) => [key, queueCounts[index]]));
    // Merge relay-reported printers (cloud deployments have no local CUPS)
    const relayList = getRelayPrinters();
    const localNames = new Set(localPrinters.map(p => p.name));
    // Which relay printers are actively printing (have a job in
    // PRINTING_DIR). Cached 10s because it only drives a cosmetic
    // status badge on the printer chip. Uses the shared stale-while-
    // revalidate readJobs() helper so we never block the event loop
    // on Azure Files readdir/readFile under load — a SIGNAL2026-scale
    // review queue made the old sync version stall the dashboard.
    const relayBusy = new Set();
    const printingJobs = readJobs(PRINTING_DIR);
    for (const j of printingJobs) {
        if (j && j.printerName) relayBusy.add(j.printerName);
    }
    const relayEntries = relayList
        .filter(rp => !localNames.has(rp.name)) // avoid duplicates if same name in CUPS
        .map(rp => {
            const busy = relayBusy.has(rp.name);
            return { name: rp.name, status: busy ? "printing" : "ready", message: busy ? "Printing job" : "Relay", source: "relay" };
        });
    const printers = [...localPrinters, ...relayEntries];
    const stuckJobs = getStuckJobs(eventFilter);
    const durations = computeDurations(eventFilter, excludeAdmin);

    const disabledPrinters = settings.get("disabledPrinters") || [];
    const payload = {
        eventName: settings.get("eventName"),
        events: stats.events,
        currentEvent: stats.eventFilter,
        totals: stats.totals,
        prints24h: stats.prints24h,
        uniqueUsers: stats.uniqueUsers,
        avgPerUser: stats.avgPerUser,
        queue,
        stuckJobs,
        durations,
        styleCounts: stats.styleCounts,
        topUsers: stats.topUsers,
        hourlyActivity: stats.hourlyActivity,
        hourlyLabels: stats.hourlyLabels,
        printers,
        disabledPrinters,
        failureBreakdown: stats.failureBreakdown,
        moderationRate: stats.moderationRate,
        countryCounts: stats.countryCounts,
        queuePaused: settings.get("queuePaused") || false,
        hasReviewPin: !!settings.get("reviewPin"),
        enablePrinting: settings.get("enablePrinting"),
        immediateDigitalDelivery: settings.get("immediateDigitalDelivery"),
        nps: detailed ? nps.getStats(eventFilter === "all" ? null : eventFilter) : null,
        dubAnalytics: dubAnalytics || null,
        shareClicks: detailed ? shareClicks.getStats(eventFilter === "all" ? null : eventFilter) : null,
        showSharePII: showPii,
    };

    return payload;
}

router.get("/api/stats", async (req, res) => {
    try {
        const eventFilter = req.query.e || "all";
        // Admin phone numbers are ALWAYS excluded from dashboard stats now —
        // the old xa=1 toggle let ops forget to enable it and then misread
        // metrics inflated by their own test traffic. Keeping the variable
        // so the downstream compute helpers still receive a boolean.
        const excludeAdmin = true;
        const showPii = req.query.pii === "1";
        const detailed = req.query.scope !== "overview";

        // Previously this endpoint auto-approved every review item whose
        // event's reviewMode wasn't "human" — on EVERY stats poll. That
        // caused a data-loss incident where a dashboard visit silently
        // flushed all pending reviews because getForEvent returned "off".
        // Admin in-session review-mode toggles are handled by
        // lib/review-settings.js at the moment the toggle is flipped; no
        // other path should ever bulk auto-approve. Dashboard polling
        // must not mutate queue state.

        const cacheKey = JSON.stringify([eventFilter, showPii, detailed]);
        const cached = _statsCache.get(cacheKey);
        if (cached?.data && Date.now() - cached.ts < STATS_CACHE_TTL) {
            return res.json(cached.data);
        }
        if (cached?.pending) return res.json(await cached.pending);

        const version = _statsCacheVersion;
        const entry = { data: cached?.data || null, ts: cached?.ts || 0, pending: null };
        rememberStatsEntry(cacheKey, entry);
        const pending = buildStatsPayload(eventFilter, excludeAdmin, showPii, detailed);
        entry.pending = pending;
        try {
            const payload = await pending;
            // A completed action may have invalidated this build while it was
            // reading. Return it to its caller, but never publish it as fresh.
            if (version === _statsCacheVersion && _statsCache.get(cacheKey) === entry) {
                entry.data = payload;
                entry.ts = Date.now();
            }
            return res.json(payload);
        } finally {
            if (_statsCache.get(cacheKey) === entry) {
                entry.pending = null;
                if (!entry.data) _statsCache.delete(cacheKey);
            }
        }
    } catch (err) {
        console.error("Stats API error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ── Review QR Code ──────────────────────────────────────────────────────────

let _qrCache = { url: null, svg: null };

router.get("/api/review-qr", async (req, res) => {
    try {
        const baseUrl = process.env.BASE_URL || `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers.host}`;
        const reviewUrl = `${baseUrl}/review`;

        if (_qrCache.url !== reviewUrl) {
            _qrCache.svg = await QRCode.toString(reviewUrl, {
                type: "svg",
                margin: 1,
                color: { dark: "#000000", light: "#00000000" },
                errorCorrectionLevel: "M",
            });
            _qrCache.url = reviewUrl;
        }

        res.json({ svg: _qrCache.svg, url: reviewUrl });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

let _staffQrCache = { url: null, dataUrl: null };

router.get("/api/staff-qr", async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).send("url required");

        if (_staffQrCache.url !== url) {
            _staffQrCache.dataUrl = await QRCode.toDataURL(url, {
                margin: 2,
                width: 320,
                color: { dark: "#000000", light: "#ffffff" },
                errorCorrectionLevel: "M",
            });
            _staffQrCache.url = url;
        }

        // Return as PNG image
        const base64 = _staffQrCache.dataUrl.split(",")[1];
        const buf = Buffer.from(base64, "base64");
        res.set("Content-Type", "image/png");
        res.set("Cache-Control", "public, max-age=3600");
        res.send(buf);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── PDF Report ───────────────────────────────────────────────────────────────

router.get("/api/report", async (req, res) => {
    const eventFilter = req.query.e || "all";
    const stats = await computeStats(eventFilter, true);
    const durations = computeDurations(eventFilter, true);
    const dubAnalytics = await dub.getAnalytics(eventFilter);
    const shareClickStats = shareClicks.getStats(eventFilter === "all" ? null : eventFilter);
    const eventLabel = eventFilter === "all" ? "All Events" : eventFilter;

    // AI summary
    const summary = await getEventSummary(eventLabel);

    // Build PDF
    const doc = new PDFDocument({ size: "LETTER", margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    const filename = eventLabel.replace(/[^a-zA-Z0-9]/g, "_") + "_Report.pdf";
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    doc.pipe(res);

    // ── Register Twilio brand fonts ──
    const fontsDir = path.join(__dirname, "..", "assets", "fonts");
    doc.registerFont("TwilioDisplay", path.join(fontsDir, "TwilioSansDisplay-Extrabold.otf"));
    doc.registerFont("TwilioText", path.join(fontsDir, "TwilioSansText-Regular.otf"));
    doc.registerFont("TwilioTextBold", path.join(fontsDir, "TwilioSansText-Bold.otf"));
    doc.registerFont("TwilioMono", path.join(fontsDir, "TwilioSansMono-Regular.otf"));

    // ── Brand assets ──
    const assetsDir = path.join(__dirname, "..", "assets");
    const logoWhitePath = path.join(assetsDir, "twilio-logo-white.png");

    // ── Twilio brand color palette ──
    // Primary
    const twilioRed = "#EF223A";   // red-450
    const ink = "#000D25";          // blue-900 (Ink)
    const white = "#FFFFFF";
    // Blue family
    const blue200 = "#3ACEFA";
    const blue300 = "#19ABF3";
    const blue400 = "#2188EF";
    const blue500 = "#1866EE";
    // Red family
    const red400 = "#F83D53";
    // Gray family
    const gray50 = "#F3F4F7";
    const gray100 = "#DDE0E6";
    const gray300 = "#9AA0B4";
    const gray500 = "#656E87";
    const gray700 = "#38425E";
    // Style colors
    const styleColors = { cartoon: blue400, "pop-art": blue500, watercolor: blue200, anime: red400, sketch: gray300, "pixel-art": blue300 };

    const pw = doc.page.width;   // 612
    const ph = doc.page.height;  // 792
    const mx = 56;               // margin x
    const contentW = pw - mx * 2; // 500

    // ── Helper: section heading with accent bar ──
    function sectionHead(title, y) {
        if (y === undefined) y = doc.y;
        doc.save();
        doc.roundedRect(mx, y, 4, 18, 2).fill(twilioRed);
        doc.restore();
        doc.font("TwilioTextBold").fontSize(13).fillColor(ink).text(title, mx + 14, y + 2, { width: contentW - 14 });
        doc.y = y + 28;
        doc.x = mx;
    }

    // ── Helper: table with alternating rows ──
    function drawTable(headers, rows, colWidths, options = {}) {
        const { barCol, barMax, barColor } = options; // optional bar chart column
        const y0 = doc.y;
        const totalW = colWidths.reduce((a, b) => a + b, 0);
        const rowH = 24;
        const headerH = 22;

        // Header background
        doc.save();
        doc.roundedRect(mx, y0, totalW, headerH, 4).fill(gray100);
        doc.restore();

        let cx = mx;
        for (let i = 0; i < headers.length; i++) {
            const align = i === 0 ? "left" : "right";
            const padL = i === 0 ? 10 : 0;
            const padR = i === headers.length - 1 ? 10 : 0;
            doc.font("TwilioTextBold").fontSize(8.5).fillColor(gray700)
                .text(headers[i].toUpperCase(), cx + padL, y0 + 6, { width: colWidths[i] - padL - padR, align });
            cx += colWidths[i];
        }

        let ry = y0 + headerH;
        for (let r = 0; r < rows.length; r++) {
            // Alternating row shading
            if (r % 2 === 0) {
                doc.save();
                const rr = r === rows.length - 1 ? 4 : 0;
                if (rr) doc.roundedRect(mx, ry, totalW, rowH, rr).fill(gray50);
                else doc.rect(mx, ry, totalW, rowH).fill(gray50);
                doc.restore();
            }

            cx = mx;
            for (let i = 0; i < rows[r].length; i++) {
                const align = i === 0 ? "left" : "right";
                const padL = i === 0 ? 10 : 0;
                const padR = i === rows[r].length - 1 ? 10 : 0;
                const isFirst = i === 0;
                doc.font(isFirst ? "TwilioTextBold" : "TwilioText").fontSize(9.5).fillColor(isFirst ? ink : gray700)
                    .text(String(rows[r][i]), cx + padL, ry + 7, { width: colWidths[i] - padL - padR, align });

                // Draw inline bar if this column has a bar
                if (barCol !== undefined && i === barCol && barMax > 0) {
                    const val = parseFloat(rows[r][i]) || 0;
                    const barW = Math.max(2, (val / barMax) * (colWidths[i] - 20));
                    const color = barColor ? (typeof barColor === "function" ? barColor(rows[r][0]) : barColor) : blue400;
                    doc.save();
                    doc.roundedRect(cx + 4, ry + rowH - 5, barW, 3, 1.5).fill(color);
                    doc.restore();
                }
                cx += colWidths[i];
            }
            ry += rowH;
        }

        doc.y = ry + 6;
        doc.x = mx;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PAGE 1: Cover header + summary + key metrics + style breakdown
    // ══════════════════════════════════════════════════════════════════════════

    // ── Header banner ──
    doc.save();
    doc.rect(0, 0, pw, 120).fill(ink);
    // Red accent bar at very top
    doc.rect(0, 0, pw, 4).fill(twilioRed);
    doc.restore();

    // Twilio logo (white wordmark, top-right of header)
    try {
        // Logo is 1101x333 — render at ~80px wide in top-right
        doc.image(logoWhitePath, pw - mx - 80, 16, { width: 80 });
    } catch (_e) { /* logo missing — skip gracefully */ }

    // Title
    doc.font("TwilioDisplay").fontSize(28).fillColor(white).text("Event Report", mx, 28, { width: contentW - 100 });
    doc.font("TwilioText").fontSize(14).fillColor(gray300).text(eventLabel, mx, 64, { width: contentW - 100 });

    // Date info on the right side of the header
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
    doc.font("TwilioText").fontSize(9).fillColor(gray300).text(dateStr, mx, 92, { width: contentW, align: "right" });
    if (stats.dateRange) {
        const fmt = (ts) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
        doc.font("TwilioText").fontSize(8).fillColor(gray500)
            .text("Data: " + fmt(stats.dateRange.earliest) + " \u2014 " + fmt(stats.dateRange.latest), mx, 104, { width: contentW, align: "right" });
    }

    doc.y = 140;
    doc.x = mx;

    // ── Helper: render footer decoration on a page (line + bug + branding) ──
    // ── Helper: ensure enough room for a section, else start a new page ──
    function ensureSpace(needed) {
        const safeBottom = ph - 60;
        if (doc.y + needed > safeBottom) {
            doc.addPage({ size: "LETTER", margins: { top: 48, bottom: 0, left: 0, right: 0 } });
            doc.y = 48;
            doc.x = mx;
        }
    }

    // ── Event Summary ──
    sectionHead("About This Event");
    doc.font("TwilioText").fontSize(10).fillColor(gray700).text(summary, mx, doc.y, { lineGap: 4, width: contentW });
    doc.moveDown(1.2);

    // ── Key Metrics (card grid) ──
    const metricsGridH = Math.ceil(11 / 4) * (58 + 10) + 28 + 10;
    ensureSpace(metricsGridH);
    sectionHead("Key Metrics");

    const mostPopularStyle = Object.entries(stats.styleCounts).sort((a, b) => b[1] - a[1])[0];
    const successRate = (stats.totals.done + stats.totals.failed) > 0
        ? ((stats.totals.done / (stats.totals.done + stats.totals.failed)) * 100).toFixed(0) + "%"
        : "N/A";

    const fmtSec = (sec) => {
        if (sec === null || sec === undefined) return "N/A";
        if (sec < 60) return sec + "s";
        return Math.floor(sec / 60) + "m " + (sec % 60) + "s";
    };

    const metricCards = [
        { label: "Total Prints", value: String(stats.totals.done), color: blue400 },
        { label: "Unique Users", value: String(stats.uniqueUsers), color: blue200 },
        { label: "Avg / User", value: stats.avgPerUser, color: blue300 },
        { label: "Last 24h", value: String(stats.prints24h), color: blue500 },
        { label: "Top Style", value: mostPopularStyle ? mostPopularStyle[0] : "N/A", color: red400 },
        { label: "Success Rate", value: successRate, color: blue400 },
        { label: "Avg Generation", value: fmtSec(durations.avgGenerationSec), color: blue200 },
        { label: "Avg Print", value: fmtSec(durations.avgPrintSec), color: blue300 },
        { label: "Avg Delivery", value: fmtSec(durations.avgTotalSec), color: blue400 },
        { label: "Failed Jobs", value: String(stats.totals.failed), color: twilioRed },
        { label: "Rejection Rate", value: stats.moderationRate || "0%", color: blue500 },
        ...(dubAnalytics ? [
            { label: "Link Clicks", value: String(dubAnalytics.totalClicks), color: blue200 },
            { label: "Click-Through", value: stats.totals.done > 0
                ? ((dubAnalytics.totalClicks / stats.totals.done) * 100).toFixed(1) + "%"
                : "N/A", color: blue300 },
        ] : []),
        ...(shareClickStats && shareClickStats.totalEvents > 0 ? [
            { label: "Platform Shares", value: String(shareClickStats.totalShares), color: blue400 },
            { label: "Unique Sharers", value: String(shareClickStats.uniqueSharers), color: red400 },
        ] : []),
    ];

    const cardCols = 4;
    const cardGap = 10;
    const cardW = (contentW - cardGap * (cardCols - 1)) / cardCols;
    const cardH = 58;
    const cardStartY = doc.y;

    for (let i = 0; i < metricCards.length; i++) {
        const col = i % cardCols;
        const row = Math.floor(i / cardCols);
        const cx = mx + col * (cardW + cardGap);
        const cy = cardStartY + row * (cardH + cardGap);
        const m = metricCards[i];

        // Card background
        doc.save();
        doc.roundedRect(cx, cy, cardW, cardH, 6).fill(gray50);
        // Left accent stripe
        doc.roundedRect(cx, cy, 3, cardH, 1.5).fill(m.color);
        doc.restore();

        // Value
        doc.font("TwilioDisplay").fontSize(18).fillColor(ink)
            .text(m.value, cx + 12, cy + 10, { width: cardW - 18 });
        // Label
        doc.font("TwilioText").fontSize(8).fillColor(gray500)
            .text(m.label.toUpperCase(), cx + 12, cy + 34, { width: cardW - 18 });
    }

    const metricsRows = Math.ceil(metricCards.length / cardCols);
    doc.y = cardStartY + metricsRows * (cardH + cardGap) + 10;
    doc.x = mx;

    doc.moveDown(0.4);

    // ── Style Breakdown ──
    const styleCount = Object.keys(stats.styleCounts).length || 1;
    ensureSpace(28 + 22 + styleCount * 24 + 10);
    sectionHead("Style Breakdown");

    const sortedStyles = Object.entries(stats.styleCounts).sort((a, b) => b[1] - a[1]);
    const totalPrints = stats.totals.done || 1;
    const maxStyleCount = sortedStyles.length > 0 ? sortedStyles[0][1] : 1;

    if (sortedStyles.length === 0) {
        doc.font("TwilioText").fontSize(10).fillColor(gray500).text("No data yet", mx, doc.y);
        doc.moveDown(0.5);
    } else {
        const styleRows = sortedStyles.map(([style, count]) => [
            style,
            String(count),
            ((count / totalPrints) * 100).toFixed(0) + "%",
        ]);
        drawTable(
            ["Style", "Count", "Share"],
            styleRows,
            [240, 130, 130],
            { barCol: 1, barMax: maxStyleCount, barColor: (name) => styleColors[name] || blue400 }
        );
    }

    // ── Hourly Activity (24h) ──
    if (stats.hourlyActivity && stats.hourlyActivity.some((v) => v > 0)) {
        ensureSpace(120);
        sectionHead("Hourly Activity (24h)");

        const bars = stats.hourlyActivity;
        const labels = stats.hourlyLabels || [];
        const maxBar = Math.max(1, ...bars);
        const barAreaW = contentW;
        const barMaxH = 60;
        const barW = Math.floor(barAreaW / bars.length) - 2;
        const baseY = doc.y + barMaxH;

        for (let i = 0; i < bars.length; i++) {
            const bx = mx + i * (barW + 2);
            const bh = bars[i] > 0 ? Math.max(3, (bars[i] / maxBar) * barMaxH) : 0;

            if (bh > 0) {
                doc.save();
                doc.roundedRect(bx, baseY - bh, barW, bh, 2).fill(blue400);
                doc.restore();
            }

            // Labels (show every 3rd to avoid clutter)
            if (i % 3 === 0 && labels[i]) {
                doc.font("TwilioMono").fontSize(6.5).fillColor(gray500)
                    .text(labels[i], bx, baseY + 4, { width: barW + 2, align: "center" });
            }
        }

        doc.y = baseY + 18;
        doc.x = mx;
        doc.moveDown(0.6);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Remaining sections: flow naturally with page-break checks
    // ══════════════════════════════════════════════════════════════════════════

    // ── Top Users ──
    if (stats.topUsers.length > 0) {
        const estH = 28 + stats.topUsers.length * 24 + 20;
        ensureSpace(estH);
        sectionHead("Top Users");
        const userRows = stats.topUsers.map((u) => [u.phone, String(u.count)]);
        drawTable(["Phone", "Prints"], userRows, [340, 160], { barCol: 1, barMax: stats.topUsers[0]?.count || 1, barColor: blue200 });
        doc.moveDown(0.5);
    }

    // ── Failure Analysis ──
    const fb = stats.failureBreakdown;
    const totalFails = Object.values(fb).reduce((a, b) => a + b, 0);
    if (totalFails > 0) {
        const failEntries = Object.values(fb).filter((c) => c > 0).length;
        ensureSpace(28 + failEntries * 24 + 30);
        sectionHead("Failure Analysis");

        const failLabels = { moderation: "Moderation", face_detection: "Face Detection", multi_subject: "Multi-Subject", generation: "Generation / API", printer: "Printer", review_rejected: "Review Rejected", max_retries: "Crash Recovery", unknown: "Unknown" };
        const failColors = { moderation: twilioRed, face_detection: blue300, multi_subject: gray300, generation: blue500, printer: blue400, review_rejected: red400, max_retries: gray300, unknown: gray500 };
        const failRows = Object.entries(fb)
            .filter(([, c]) => c > 0)
            .sort((a, b) => b[1] - a[1])
            .map(([reason, count]) => [
                failLabels[reason] || reason,
                String(count),
                ((count / totalFails) * 100).toFixed(0) + "%",
            ]);
        const maxFail = Math.max(...Object.values(fb));
        drawTable(
            ["Reason", "Count", "Share"],
            failRows,
            [240, 130, 130],
            { barCol: 1, barMax: maxFail, barColor: (name) => {
                const key = Object.entries(failLabels).find(([, v]) => v === name)?.[0];
                return failColors[key] || twilioRed;
            }}
        );

        doc.font("TwilioText").fontSize(8.5).fillColor(gray500)
            .text("Rejection rate (moderation + face detection): " + stats.moderationRate, mx);
        doc.moveDown(0.8);
    } else {
        ensureSpace(50);
        sectionHead("Failure Analysis");
        doc.font("TwilioText").fontSize(10).fillColor(gray500).text("No failures recorded.", mx);
        doc.moveDown(1);
    }

    // ── User Geography ──
    if (stats.countryCounts.length > 0) {
        const geoEntries = Math.min(stats.countryCounts.length, 10);
        ensureSpace(28 + geoEntries * 24 + 20);
        sectionHead("User Geography");

        const top10Countries = stats.countryCounts.slice(0, 10);
        const totalGeoUsers = stats.countryCounts.reduce((a, b) => a + b.count, 0);
        const maxGeo = top10Countries[0]?.count || 1;
        const geoRows = top10Countries.map(({ country, count }) => [
            country,
            String(count),
            totalGeoUsers > 0 ? ((count / totalGeoUsers) * 100).toFixed(0) + "%" : "0%",
        ]);
        drawTable(
            ["Country", "Users", "Share"],
            geoRows,
            [240, 130, 130],
            { barCol: 1, barMax: maxGeo, barColor: blue200 }
        );
    }

    // ── Share Link Analytics ──
    if (dubAnalytics) {
        const linkRows = (dubAnalytics.topLinks || []).length;
        ensureSpace(28 + 30 + (linkRows > 0 ? 22 + linkRows * 24 + 10 : 0));
        sectionHead("Share Link Analytics");

        const ctr = stats.totals.done > 0
            ? ((dubAnalytics.totalClicks / stats.totals.done) * 100).toFixed(1) + "%"
            : "N/A";
        doc.font("TwilioDisplay").fontSize(22).fillColor(ink)
            .text(String(dubAnalytics.totalClicks) + " clicks", mx);
        doc.font("TwilioText").fontSize(9).fillColor(gray500)
            .text("Clicks on share links sent via SMS after portrait delivery  |  Click-through rate: " + ctr + " (clicks / total prints)", mx, undefined, { width: contentW });
        doc.moveDown(0.6);

        if (dubAnalytics.topLinks && dubAnalytics.topLinks.length > 0) {
            const maxLinkClicks = dubAnalytics.topLinks[0].clicks || 1;
            const topLinkRows = dubAnalytics.topLinks.map(l => [
                l.shortLink.replace(/^https?:\/\//, ""),
                String(l.clicks),
            ]);
            drawTable(
                ["Short Link", "Clicks"],
                topLinkRows,
                [340, 160],
                { barCol: 1, barMax: maxLinkClicks, barColor: blue200 }
            );
        }

        doc.moveDown(0.5);
    }

    // ── Share Platform Funnel ──
    if (shareClickStats && shareClickStats.totalEvents > 0) {
        const bp = shareClickStats.byPlatform || {};
        const platformRows = [
            ["X / Twitter", bp.x || 0],
            ["LinkedIn", bp.linkedin || 0],
            ["Instagram Save", bp.instagram || 0],
            ["Download", bp.download || 0],
        ].filter((r) => r[1] > 0);

        ensureSpace(28 + 40 + 22 + platformRows.length * 24 + 10);
        sectionHead("Share Platform Funnel");

        const dubClicks = (dubAnalytics && dubAnalytics.totalClicks) || 0;
        const shareRate = dubClicks > 0
            ? ((shareClickStats.totalShares / dubClicks) * 100).toFixed(1) + "%"
            : "N/A";
        doc.font("TwilioDisplay").fontSize(22).fillColor(ink)
            .text(String(shareClickStats.totalShares) + " platform shares", mx);
        doc.font("TwilioText").fontSize(9).fillColor(gray500)
            .text("Clicks on X, LinkedIn, or Instagram share buttons  |  Share rate: " + shareRate + " (shares / share-page visits)  |  Unique sharers: " + shareClickStats.uniqueSharers, mx, undefined, { width: contentW });
        doc.moveDown(0.6);

        if (platformRows.length > 0) {
            const maxPlat = Math.max(1, ...platformRows.map((r) => r[1]));
            drawTable(
                ["Platform", "Clicks"],
                platformRows.map((r) => [r[0], String(r[1])]),
                [340, 160],
                { barCol: 1, barMax: maxPlat, barColor: blue400 }
            );
        }

        doc.moveDown(0.5);
    }

    // ── NPS Score ──
    const npsStats = nps.getStats(eventFilter === "all" ? null : eventFilter);
    if (npsStats.count > 0) {
        ensureSpace(28 + 40 + 5 * 18 + 20);
        sectionHead("NPS Score");
        doc.font("TwilioDisplay").fontSize(28).fillColor(ink)
            .text(String(npsStats.average), mx);
        doc.font("TwilioText").fontSize(9).fillColor(gray500)
            .text("Average score from " + npsStats.count + " responses", mx);
        doc.moveDown(0.4);
        const npsBarW = 200;
        const npsMaxCount = Math.max(1, ...Object.values(npsStats.distribution));
        const npsColors = { 5: blue400, 4: blue300, 3: blue200, 2: blue500, 1: twilioRed };
        for (let s = 5; s >= 1; s--) {
            const count = npsStats.distribution[s] || 0;
            const barW = (count / npsMaxCount) * npsBarW;
            const y = doc.y;
            doc.font("TwilioTextBold").fontSize(9).fillColor(ink).text(String(s), mx, y, { width: 14 });
            doc.save();
            doc.roundedRect(mx + 20, y, npsBarW, 12, 2).fillColor(gray50).fill();
            if (barW > 0) doc.roundedRect(mx + 20, y, barW, 12, 2).fillColor(npsColors[s]).fill();
            doc.restore();
            doc.font("TwilioText").fontSize(8).fillColor(gray500).text(String(count), mx + 20 + npsBarW + 8, y + 1);
            doc.y = y + 18;
        }
        doc.moveDown(0.8);
    }

    doc.end();
});

// ── Review Queue API ─────────────────────────────────────────────────────────

router.get("/api/review-queue", async (req, res) => {
    const eventFilter = req.query.e || "all";
    const jobs = await getReviewQueue(eventFilter);
    // Legacy clients still receive the complete array. The Dashboard asks for
    // a short preview so its frequent poll never serializes every review card.
    if (req.query.limit === undefined) return res.json(jobs);
    const page = pageRequest(req.query, 12);
    setPageHeaders(res, jobs.length, page);
    res.json(jobs.slice(page.offset, page.offset + page.limit));
});

router.get("/api/review-count", async (req, res) => {
    const eventFilter = req.query.e || "all";
    const jobs = await getReviewQueue(eventFilter);
    res.json({ count: jobs.length });
});

router.post("/api/review-job", async (req, res) => {
    const body = req.body || {};
    const filename = path.basename(body.filename || "");
    const parentJobId = body.parentJobId ? String(body.parentJobId) : "";
    const action = body.action;
    const notify = !!body.notify;
    const reanalyze = !!body.reanalyze;
    if (!(filename || parentJobId) || !["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "filename or parentJobId required, action must be approve|reject" });
    }
    try {
        // Parent-level action (multi-variant card): no approve, only reject/reanalyze
        if (parentJobId) {
            if (action === "approve") {
                return res.status(400).json({ error: "Approve at parent level is not supported — pick a specific variant" });
            }
            // Look up any sibling to get the event for the SMS template
            const reviewFiles = fs.readdirSync(REVIEW_DIR).filter(f => f.endsWith(".json"));
            let evName = null;
            for (const f of reviewFiles) {
                try {
                    const j = JSON.parse(fs.readFileSync(path.join(REVIEW_DIR, f), "utf-8"));
                    if (j.parentJobId === parentJobId) { evName = j.eventName; break; }
                } catch {}
            }
            const message = notify ? settings.getMsgForEvent("reviewReject", evName) : null;
            const feedback = body.feedback || "";
            await rejectParent(parentJobId, message, reanalyze, feedback);
            return res.json({ ok: true });
        }

        // Legacy single-variant path
        if (action === "approve") {
            await approveJob(filename);
        } else {
            // Read job to get eventName for event-scoped message
            const jobData = JSON.parse(fs.readFileSync(path.join(REVIEW_DIR, filename), "utf-8"));
            const message = notify ? settings.getMsgForEvent("reviewReject", jobData.eventName) : null;
            const feedback = body.feedback || "";
            await rejectJob(filename, message, reanalyze, feedback);
        }
        res.json({ ok: true });
    } catch (err) {
        if (err.code === "ALREADY_DECIDED") return res.status(409).json({ error: err.message, code: err.code });
        res.status(500).json({ error: err.message });
    }
});

// Multi-variant: pick one variant of a parent job (approves it, supersedes siblings)
router.post("/api/variant/pick", async (req, res) => {
    const body = req.body || {};
    const parentJobId = body.parentJobId ? String(body.parentJobId) : "";
    const variantId = body.variantId ? String(body.variantId) : "";
    if (!parentJobId || !variantId) {
        return res.status(400).json({ error: "parentJobId and variantId required" });
    }
    try {
        await pickVariant(parentJobId, variantId);
        res.json({ ok: true });
    } catch (err) {
        if (err.code === "ALREADY_DECIDED") return res.status(409).json({ error: err.message, code: err.code });
        if (err.code === "VARIANT_NOT_FOUND") return res.status(404).json({ error: err.message, code: err.code });
        if (err.code === "VARIANT_FAILED") return res.status(400).json({ error: err.message, code: err.code });
        res.status(500).json({ error: err.message });
    }
});

// Multi-variant: regenerate a single variant (siblings untouched)
router.post("/api/variant/regenerate", async (req, res) => {
    const body = req.body || {};
    const parentJobId = body.parentJobId ? String(body.parentJobId) : "";
    const variantId = body.variantId ? String(body.variantId) : "";
    if (!parentJobId || !variantId) {
        return res.status(400).json({ error: "parentJobId and variantId required" });
    }
    try {
        await regenerateVariant(parentJobId, variantId);
        res.json({ ok: true });
    } catch (err) {
        if (err.code === "VARIANT_NOT_FOUND") return res.status(404).json({ error: err.message, code: err.code });
        if (err.code === "REGEN_LIMIT_REACHED") return res.status(429).json({ error: err.message, code: err.code });
        res.status(500).json({ error: err.message });
    }
});

router.post("/api/review-bulk", async (req, res) => {
    const filenames = Array.isArray((req.body || {}).filenames) ? req.body.filenames : [];
    const action = (req.body || {}).action;
    if (!filenames.length || !["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "filenames array and action (approve|reject) required" });
    }
    const results = [];
    for (const raw of filenames) {
        const filename = path.basename(raw || "");
        if (!filename) { results.push({ filename: raw, ok: false, error: "invalid" }); continue; }
        try {
            if (action === "approve") {
                await approveJob(filename);
            } else {
                await rejectJob(filename, null, false);
            }
            results.push({ filename, ok: true });
        } catch (err) {
            results.push({ filename, ok: false, error: err.message });
        }
    }
    res.json({ ok: true, results });
});

// ── Failed Jobs API ──────────────────────────────────────────────────────────

function visibleFailedJob(job, eventFilter) {
    if (eventFilter !== "all" && job.eventName !== eventFilter) return false;
    // Losing variants and jobs replaced by reanalysis remain on disk for the
    // audit trail, but they are not failures an operator can act on.
    return job.failReason !== "superseded" && job.failReason !== "reanalyzed";
}

async function shapeFailedJob(job, eventFilter) {
    const filename = `${job.filePrefix}.json`;
    const evName = job.eventName || eventFilter;
    let hasInputThumb = false;
    let canReprint = false;
    if (job.filePrefix && evName) {
        const inputPath = path.join(settings.getDownloadDir(evName), `${job.filePrefix}_input.jpg`);
        const { outputPath } = jobPaths(job);
        await Promise.all([
            fsp.access(inputPath).then(() => { hasInputThumb = true; }).catch(() => {}),
            fsp.access(outputPath).then(() => { canReprint = true; }).catch(() => {}),
        ]);
    }
    return {
        filename,
        filePrefix: job.filePrefix,
        eventName: evName,
        phone: maskPhone(job.userPhone),
        name: leads.getLeadName(job.userPhone, evName) || null,
        style: job.style || "unknown",
        failReason: job.failReason || "unknown",
        retries: job.retries || 0,
        createdAt: job.createdAt,
        canRetry: job.failReason !== "moderation",
        canReprint: canReprint && job.failReason !== "moderation",
        printerName: job.printerName || null,
        failedPrinters: job.failedPrinters || [],
        hasInputThumb,
        aiReviewResult: job.aiReviewResult || null,
        detectedSubjects: job.detectedSubjects || null,
    };
}

async function shapeDoneJob(job, eventFilter) {
    const filename = `${job.filePrefix}.json`;
    const evName = job.eventName || eventFilter;
    const { outputPath } = jobPaths(job);
    let canReprint = false;
    if (job.filePrefix && evName) {
        try { await fsp.access(outputPath); canReprint = true; } catch {}
    }
    return {
        filename,
        filePrefix: job.filePrefix,
        eventName: evName,
        phone: maskPhone(job.userPhone),
        name: leads.getLeadName(job.userPhone, evName) || null,
        style: job.style || "unknown",
        printerName: job.printerName || null,
        completedAt: job.completedAt,
        canReprint,
        hasOutputThumb: canReprint,
    };
}

router.get("/api/failed-jobs", async (req, res) => {
    const eventFilter = req.query.e || "all";
    const page = optionalPageRequest(req.query, 25);
    const candidates = (await readJobsAsync(FAILED_DIR)).filter((j) => visibleFailedJob(j, eventFilter));
    candidates.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (page) setPageHeaders(res, candidates.length, page);
    // Parallel file-existence checks for thumbnails. Each failed job MAY have
    // an _input.jpg on disk (moderation/face/multi-subject fails keep it;
    // download fails don't). Previously the browser discovered missing files
    // via a 404 per row, which flooded the network tab and slowed paint.
    const selected = page ? candidates.slice(page.offset, page.offset + page.limit) : candidates;
    const jobs = await Promise.all(selected.map((job) => shapeFailedJob(job, eventFilter)));
    res.json(jobs);
});

router.post("/api/retry-job", (req, res) => {
    const filename = path.basename((req.body || {}).filename || "");
    if (!filename) return res.status(400).json({ error: "filename required" });
    const targetPrinter = (req.body || {}).targetPrinter || null;
    const clearPrinterHistory = (req.body || {}).clearPrinterHistory || false;

    const srcPath = path.join(FAILED_DIR, filename);
    if (!fs.existsSync(srcPath)) return res.status(404).json({ error: "Job not found" });

    try {
        const job = JSON.parse(fs.readFileSync(srcPath, "utf-8"));
        if (job.failReason === "moderation") {
            return res.status(400).json({ error: "Cannot retry moderation failures" });
        }

        const existingOutput = jobPaths(job).outputPath;
        if (fs.existsSync(existingOutput) && settings.getForEvent("enablePrinting", job.eventName)) {
            const result = requeueDoneJobForReprint(filename, { targetPrinter });
            if (!result.ok) return res.status(result.status).json({ error: result.error });
            return res.json({ ok: true, target: "print queue" });
        }

        // Reset retry state
        const wasReviewRejected = job.failReason === "review_rejected";
        job.retries = 0;
        delete job.failReason;
        delete job.permanent;
        delete job.completedAt;
        job.stateChangedAt = Date.now();

        // Printer targeting
        if (targetPrinter) job.targetPrinter = targetPrinter;
        else delete job.targetPrinter;
        if (clearPrinterHistory) delete job.failedPrinters;

        // If review-rejected, delete old output so it re-generates fresh
        const { outputPath, mmsPath } = jobPaths(job);
        if (wasReviewRejected) {
            try { fs.unlinkSync(outputPath); } catch {}
            try { fs.unlinkSync(mmsPath); } catch {}
        }

        // Check if output already exists — skip to print queue if so
        const targetDir = fs.existsSync(outputPath) && settings.getForEvent("enablePrinting", job.eventName) ? READY_DIR : PENDING_DIR;

        const tmpPath = srcPath + `.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2));
        fs.renameSync(tmpPath, srcPath);
        fs.renameSync(srcPath, path.join(targetDir, filename));

        // Restore usage count
        if (job.userPhone && job.eventName) {
            incrementUsage(job.userPhone, job.eventName);
        }

        const target = targetDir === READY_DIR ? "print queue" : "generation queue";
        console.log(`🔄 Retrying job ${filename} → ${target}${targetPrinter ? ` (targeting ${targetPrinter})` : ""}`);
        res.json({ ok: true, target });
    } catch (err) {
        if (err.code === "ENOENT") return res.status(409).json({ error: "Job was already moved (concurrent request)" });
        console.error(`Failed to retry job ${filename}:`, err);
        res.status(500).json({ error: err.message });
    }
});

const _voiceIssuesCache = { data: null, ts: 0, pending: null, version: 0 };

async function cachedVoiceDeliveryIssues() {
    if (_voiceIssuesCache.data && Date.now() - _voiceIssuesCache.ts < 30_000) return _voiceIssuesCache.data;
    const version = _voiceIssuesCache.version;
    if (!_voiceIssuesCache.pending || _voiceIssuesCache.pending.version !== version) {
        _voiceIssuesCache.pending = { version, run: getVoiceDeliveryIssues("all") };
    }
    const pending = _voiceIssuesCache.pending;
    try {
        const issues = await pending.run;
        if (_voiceIssuesCache.version === pending.version) {
            _voiceIssuesCache.data = issues;
            _voiceIssuesCache.ts = Date.now();
        }
        return issues;
    } finally {
        if (_voiceIssuesCache.pending === pending) _voiceIssuesCache.pending = null;
    }
}

router.get("/api/voice-deliveries", async (req, res) => {
    try {
        const issues = await cachedVoiceDeliveryIssues();
        const eventFilter = req.query.e || "all";
        res.json(eventFilter === "all" ? issues : issues.filter((issue) => issue.eventName === eventFilter));
    } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post("/api/voice-deliveries/retry", async (req, res) => {
    const filename = String(req.body?.filename || "");
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(filename)) return res.status(400).json({ error: "Invalid filename" });
    try {
        const job = await retryVoiceDelivery(filename);
        _voiceIssuesCache.data = null;
        _voiceIssuesCache.version++;
        if (!job || job.inputMode !== "voice" || !job.voiceDeliveryKind) {
            return res.status(404).json({ error: "Voice delivery not found" });
        }
        return res.json({ ok: true, state: job.voiceDeliveryState,
            attempts: job.voiceDeliveryAttempts || 0 });
    } catch (error) { return res.status(500).json({ error: error.message }); }
});

// ── Printer Management API ──────────────────────────────────────────────────

router.post("/api/toggle-printer", (req, res) => {
    const printerName = (req.body || {}).printer;
    if (!printerName) return res.status(400).json({ error: "printer required" });

    const disabled = settings.get("disabledPrinters") || [];
    const idx = disabled.indexOf(printerName);
    if (idx >= 0) {
        disabled.splice(idx, 1);
        settings.update({ disabledPrinters: disabled });
        console.log(`✅ Printer enabled: ${printerName}`);
        res.json({ ok: true, enabled: true });
    } else {
        disabled.push(printerName);
        settings.update({ disabledPrinters: disabled });
        console.log(`🚫 Printer disabled: ${printerName}`);

        // Clear targetPrinter on any ready jobs aimed at this printer
        // so they can be picked up by a working printer instead of sitting stuck
        try {
            const readyFiles = fs.readdirSync(READY_DIR).filter(f => f.endsWith(".json"));
            let cleared = 0;
            for (const f of readyFiles) {
                const fp = path.join(READY_DIR, f);
                try {
                    const job = JSON.parse(fs.readFileSync(fp, "utf-8"));
                    if (job.targetPrinter === printerName) {
                        delete job.targetPrinter;
                        const tmp = fp + `.tmp.${process.pid}.${Date.now()}`;
                        fs.writeFileSync(tmp, JSON.stringify(job));
                        // Guard: if the original was claimed (renamed away) between read and write,
                        // discard the tmp to avoid creating a ghost duplicate in READY_DIR
                        try {
                            fs.accessSync(fp);
                            fs.renameSync(tmp, fp);
                            cleared++;
                        } catch {
                            try { fs.unlinkSync(tmp); } catch {}
                        }
                    }
                } catch (e) {
                    if (e.code !== "ENOENT") console.error(`Failed to clear targetPrinter on ${f}: ${e.message}`);
                }
            }
            if (cleared > 0) console.log(`   ↳ Cleared targetPrinter on ${cleared} ready job(s)`);
        } catch (e) { /* READY_DIR read failed — non-fatal */ }

        res.json({ ok: true, enabled: false });
    }
});

// ── Done Jobs & Reprint API ──────────────────────────────────────────────────

router.get("/api/done-jobs", async (req, res) => {
    const eventFilter = req.query.e || "all";
    const page = optionalPageRequest(req.query, 25);
    const candidates = (await readJobsAsync(DONE_DIR)).filter((j) => {
        if (eventFilter !== "all" && j.eventName !== eventFilter) return false;
        return true;
    });
    candidates.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    if (page) setPageHeaders(res, candidates.length, page);
    // One output check supplies both reprint availability and the final-image thumbnail.
    const selected = page ? candidates.slice(page.offset, page.offset + page.limit) : candidates;
    const jobs = await Promise.all(selected.map((job) => shapeDoneJob(job, eventFilter)));
    res.json(jobs);
});

// ── Active (in-flight) Jobs API ───────────────────────────────────────────────
// Jobs sitting in READY_DIR (generated, waiting for a relay/printer to claim
// them) and PRINTING_DIR (actively printing) used to surface ONLY as the
// numeric "Ready to Print" / "Printing" counters in the queue strip — never as
// rows in the Jobs table. So when the relay stopped printing (e.g. the venue
// network dropped), portraits piled up in ready/ and silently never appeared
// as job rows: the table only ever read done/ and failed/. This endpoint
// exposes those in-flight jobs so they render as live rows.
router.get("/api/active-jobs", async (req, res) => {
    const eventFilter = req.query.e || "all";
    const page = optionalPageRequest(req.query, 50);
    const out = [];
    for (const [dir, stage] of [[READY_DIR, "ready"], [PRINTING_DIR, "printing"]]) {
        for (const job of await readJobsAsync(dir)) {
            if (!job || !job.filePrefix) continue;
            if (eventFilter !== "all" && job.eventName !== eventFilter) continue;
            out.push(shapeActiveJob(job, stage, maskPhone));
        }
    }
    // Most-recently-entered first, matching the done/failed tabs' ordering.
    out.sort((a, b) => (b.enteredAt || 0) - (a.enteredAt || 0));
    if (!page) return res.json(out);
    setPageHeaders(res, out.length, page);
    res.json(out.slice(page.offset, page.offset + page.limit));
});

// The workspace's All filter needs one page from a single, global ordering.
// Paging the three status endpoints independently would either omit rows or
// require fetching every preceding page before showing a later one.
router.get("/api/jobs", async (req, res) => {
    const eventFilter = req.query.e || "all";
    const filter = req.query.filter || "all";
    if (!["all", "active", "failed", "done"].includes(filter)) {
        return res.status(400).json({ error: "Invalid job filter" });
    }
    const page = pageRequest(req.query, 25);
    const [ready, printing, failed, done] = await Promise.all([
        readJobsAsync(READY_DIR), readJobsAsync(PRINTING_DIR),
        readJobsAsync(FAILED_DIR), readJobsAsync(DONE_DIR),
    ]);
    const matchesEvent = (job) => eventFilter === "all" || job.eventName === eventFilter;
    const activeRows = [
        ...ready.filter((job) => job && job.filePrefix && matchesEvent(job)).map((job) => ({ job, stage: "ready" })),
        ...printing.filter((job) => job && job.filePrefix && matchesEvent(job)).map((job) => ({ job, stage: "printing" })),
    ];
    const failedRows = failed.filter((job) => job && visibleFailedJob(job, eventFilter));
    const doneRows = done.filter((job) => job && matchesEvent(job));
    const counts = { active: activeRows.length, failed: failedRows.length, done: doneRows.length };
    const candidates = [];
    let order = 0;
    for (const entry of activeRows) {
        const job = entry.job;
        candidates.push({ type: "active", ts: job.stateChangedAt || job.printingAt || job.readyAt || job.createdAt || 0,
            job, stage: entry.stage, order: order++ });
    }
    for (const job of failedRows) {
        candidates.push({ type: "failed", ts: job.createdAt || 0, job, order: order++ });
    }
    for (const job of doneRows) {
        candidates.push({ type: "done", ts: job.completedAt || 0, job, order: order++ });
    }
    const selected = (filter === "all" ? candidates : candidates.filter((item) => item.type === filter))
        .sort((a, b) => (b.ts - a.ts) || (a.order - b.order));
    const total = selected.length;
    const pageRows = selected.slice(page.offset, page.offset + page.limit);
    // Check image files and resolve lead names only for the requested page.
    const jobs = await Promise.all(pageRows.map(async ({ type, ts, job, stage }) => ({
        type,
        ts,
        data: type === "active" ? shapeActiveJob(job, stage, maskPhone)
            : type === "failed" ? await shapeFailedJob(job, eventFilter)
                : await shapeDoneJob(job, eventFilter),
    })));
    res.json({ jobs, total, counts, offset: page.offset, limit: page.limit,
        hasMore: page.offset + jobs.length < total });
});

// POST /api/release-ready-job — un-strand a job stuck in READY_DIR.
// A ready job can be invisible to the booth's relay because it carries a
// targetPrinter that's offline, or a failedPrinters list containing the only
// printer (the single-printer failover trap). This clears both so the next
// poll from ANY printer picks it up. The job stays in ready/ (not moved), so
// there's no double-print risk — it was never claimed/printed. No-op safe:
// returns ok even if there was nothing to clear.
router.post("/api/release-ready-job", (req, res) => {
    const filename = path.basename((req.body || {}).filename || "");
    if (!filename || !filename.endsWith(".json")) return res.status(400).json({ error: "filename required" });
    const readyPath = path.join(READY_DIR, filename);
    if (!fs.existsSync(readyPath)) return res.status(404).json({ error: "Job not in the ready queue (it may have started printing or completed)" });
    try {
        const job = JSON.parse(fs.readFileSync(readyPath, "utf-8"));
        delete job.targetPrinter;
        job.failedPrinters = [];
        job.retries = 0;
        job.stateChangedAt = Date.now();
        const tmpPath = readyPath + `.tmp.${process.pid}.${Date.now()}`;
        fs.writeFileSync(tmpPath, JSON.stringify(job, null, 2));
        fs.renameSync(tmpPath, readyPath);
        console.log(`🔧 Released ready job for any printer: ${filename}`);
        res.json({ ok: true });
    } catch (err) {
        if (err.code === "ENOENT") return res.status(409).json({ error: "Job was claimed by a printer just now" });
        console.error(`Failed to release ready job ${filename}:`, err);
        res.status(500).json({ error: err.message });
    }
});

router.post("/api/reprint-job", (req, res) => {
    const filename = path.basename((req.body || {}).filename || "");
    if (!filename) return res.status(400).json({ error: "filename required" });
    const targetPrinter = (req.body || {}).targetPrinter || null;

    // Shared with the relay's reprint endpoint so both surfaces re-queue
    // identically. The helper returns an HTTP-style status we pass through.
    const result = requeueDoneJobForReprint(filename, { targetPrinter });
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
});

// ── User Management API ─────────────────────────────────────────────────────

function phoneHash(phone) {
    let h = 0;
    for (let i = 0; i < phone.length; i++) {
        h = ((h << 5) - h + phone.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

router.get("/api/dashboard-users", (req, res) => {
    const eventFilter = req.query.e || "all";
    const page = optionalPageRequest(req.query, 40);
    const userMap = getAllUsers(eventFilter);
    const eventName = eventFilter !== "all" ? eventFilter : settings.get("eventName");
    const maxPrints = settings.getForEvent("maxPrints", eventName);
    const adminPhones = new Set(settings.getForEvent("adminPhones", eventName) || []);
    const showLeadData = eventFilter !== "all";
    const rows = [...userMap].map(([phone, count]) => ({ phone, count, isAdmin: adminPhones.has(phone) }));
    rows.sort((a, b) => (b.isAdmin - a.isAdmin) || (b.count - a.count));
    const selected = page ? rows.slice(page.offset, page.offset + page.limit) : rows;
    const users = selected.map(({ phone, count, isAdmin }) => ({
            id: phoneHash(phone),
            phone: maskPhone(phone),
            name: showLeadData ? (leads.getLeadName(phone, eventName) || null) : null,
            count,
            maxPrints,
            isAdmin,
            leadCompleted: showLeadData ? leads.isCompleted(phone, eventName) : false,
    }));
    if (!page) return res.json({ users });
    res.json({ users, total: rows.length, offset: page.offset, limit: page.limit,
        hasMore: page.offset + users.length < rows.length });
});

router.post("/api/dashboard-users/reset-usage", (req, res) => {
    const { id, event } = req.body || {};
    if (id == null || !event || event === "all") return res.status(400).json({ error: "id and specific event required" });
    const userMap = getAllUsers(event);
    let targetPhone = null;
    for (const [phone] of userMap) {
        if (phoneHash(phone) === id) { targetPhone = phone; break; }
    }
    if (!targetPhone) return res.status(404).json({ error: "User not found" });
    resetUsage(targetPhone, event);
    invalidateStatsCache();
    console.log(`📊 Usage reset for ${maskPhone(targetPhone)} on ${event}`);
    res.json({ ok: true });
});

router.post("/api/dashboard-users/reset-survey", (req, res) => {
    const { id, event } = req.body || {};
    if (id == null || !event || event === "all") return res.status(400).json({ error: "id and specific event required" });
    const userMap = getAllUsers(event);
    let targetPhone = null;
    for (const [phone] of userMap) {
        if (phoneHash(phone) === id) { targetPhone = phone; break; }
    }
    if (!targetPhone) return res.status(404).json({ error: "User not found" });
    const deleted = leads.deleteByPhone(targetPhone, event);
    console.log(`📋 Lead survey reset for ${maskPhone(targetPhone)} on ${event} (${deleted} record${deleted !== 1 ? "s" : ""} removed)`);
    res.json({ ok: true });
});

router.post("/api/dashboard-users/toggle-admin", async (req, res) => {
    try {
        const { id, event } = req.body || {};
        if (id == null) return res.status(400).json({ error: "id required" });
        const targetEvent = event || settings.get("eventName");
        const userMap = getAllUsers("all");
        let targetPhone = null;
        for (const [phone] of userMap) {
            if (phoneHash(phone) === id) { targetPhone = phone; break; }
        }
        if (!targetPhone) return res.status(404).json({ error: "User not found" });
        const nowAdmin = await toggleAdmin(targetPhone, targetEvent);
        invalidateStatsCache();
        console.log(`👤 ${maskPhone(targetPhone)} ${nowAdmin ? "added to" : "removed from"} admins for ${targetEvent}`);
        res.json({ ok: true, isAdmin: nowAdmin });
    } catch (err) {
        console.error("toggle-admin error:", err);
        res.status(500).json({ error: "Internal error" });
    }
});

// ── Style Preview API ────────────────────────────────────────────────────────

const STYLE_PREVIEW_TTL = 30_000;
const _stylePreviewCache = new Map();
let _stylePreviewIndex = { snapshot: null, byKey: new Map() };

function stylePreviewCandidates(doneJobs) {
    const snapshot = _jobsCache.get(DONE_DIR)?.ts || 0;
    if (_stylePreviewIndex.snapshot === snapshot) return _stylePreviewIndex.byKey;
    const byKey = new Map();
    for (const job of doneJobs) {
        if (!job.style || !job.filePrefix || !job.eventName) continue;
        for (const event of [job.eventName, "all"]) {
            const key = JSON.stringify([event, job.style]);
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(job);
        }
    }
    for (const candidates of byKey.values()) {
        candidates.sort((a, b) => (b.createdAt || b.completedAt || 0) - (a.createdAt || a.completedAt || 0));
    }
    _stylePreviewIndex = { snapshot, byKey };
    return byKey;
}

router.get("/api/style-preview", async (req, res) => {
    const style = req.query.style;
    if (!style) return res.status(400).json({ error: "style required" });
    const eventFilter = req.query.e || settings.get("eventName") || "all";
    const key = JSON.stringify([eventFilter, style]);
    const now = Date.now();
    const cached = _stylePreviewCache.get(key);
    if (cached && now - cached.ts < STYLE_PREVIEW_TTL) return res.json({ image: cached.image });
    try {
        const doneJobs = await readJobsAsync(DONE_DIR);
        const candidates = stylePreviewCandidates(doneJobs).get(key) || [];
        let image = null;
        for (const job of candidates) {
            const outputPath = path.join(settings.getDownloadDir(job.eventName), `${job.filePrefix}_output.png`);
            try { await fsp.access(outputPath); } catch { continue; }
            image = `/photogallery/img/${encodeURIComponent(job.eventName)}/${encodeURIComponent(job.filePrefix)}_output.png`;
            break;
        }
        _stylePreviewCache.set(key, { image, ts: Date.now() });
        res.json({ image });
    } catch (err) {
        console.error("Style preview error:", err);
        res.status(500).json({ error: "Preview unavailable" });
    }
});

// ── Settings API ─────────────────────────────────────────────────────────────

function browserSettingsWithVoiceReadiness() {
    // Readiness needs effective server credentials, but those values must
    // never be included in the browser response.
    const effective = settings.getAll();
    return {
        ...settings.getBrowserSettings(),
        voiceReadinessIssues: readinessIssues(effective, process.env.BASE_URL || ""),
    };
}

router.get("/api/settings", (req, res) => {
    res.json(browserSettingsWithVoiceReadiness());
});

router.get("/api/openai-models", async (_req, res) => {
    const catalog = await loadOpenAIModelCatalog();
    res.set("Cache-Control", "private, no-store");
    res.json(catalog);
});

function settingsEventIssue(expectedEvent, allowLegacySwitch = false) {
    if (expectedEvent === undefined) {
        return allowLegacySwitch ? null : {
            status: 428,
            body: { error: "Settings event context is missing. Reload Settings before saving." },
        };
    }
    if (typeof expectedEvent !== "string" || !expectedEvent.trim()) {
        return {
            status: 400,
            body: { error: "Settings event context is invalid. Reload Settings before saving." },
        };
    }
    const activeEvent = settings.get("eventName");
    if (expectedEvent !== activeEvent) {
        return {
            status: 409,
            body: {
                error: "The active event changed since Settings loaded. Reload Settings before saving.",
                currentEvent: activeEvent,
            },
        };
    }
    return null;
}

router.post("/api/settings", async (req, res) => {
    const saveChanges = (changes, expectedEvent, allowLegacySwitch, hasTemplateSettings = false) => {
        // Recheck here because a template operation may have held the lock
        // while another tab switched the active event.
        const eventIssue = settingsEventIssue(expectedEvent, allowLegacySwitch);
        if (eventIssue) return eventIssue;
        if (hasTemplateSettings) changes = sanitizeTemplateSettingsChanges(changes);

        // Capture before values for audit
        const beforeValues = {};
        for (const key of Object.keys(changes)) {
            const current = settings.get(key);
            if (current !== undefined) beforeValues[key] = current;
        }

        settings.updateForUser(req.user.email, changes);

        if (changes.backgroundChoices) {
            const savedBg = settings.get("backgroundChoices") || [];
            console.log(`⚙️  Backgrounds saved: ${savedBg.length} choices (received ${changes.backgroundChoices.length})`);
        }

        // Capture after values and log audit entry
        const afterValues = {};
        let hasChanges = false;
        for (const key of Object.keys(beforeValues)) {
            const newVal = settings.get(key);
            if (JSON.stringify(newVal) !== JSON.stringify(beforeValues[key])) {
                afterValues[key] = newVal;
                hasChanges = true;
            }
        }
        if (hasChanges) {
            const changedBefore = {};
            for (const key of Object.keys(afterValues)) changedBefore[key] = beforeValues[key];
            audit.logSettingsChange(req.user.email, settings.get("eventName"), changedBefore, afterValues).catch(err => {
                console.error("📝 Audit log error:", err.message);
            });
        }
        return { status: 200, body: browserSettingsWithVoiceReadiness() };
    };

    try {
        const payload = req.body || {};
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return res.status(400).json({ error: "Settings must be an object" });
        }
        const expectedEvent = payload._forEvent;
        let changes = { ...payload };
        delete changes._forEvent;
        const changedKeys = Object.keys(changes);
        // Older clients can still switch events with a single eventName field.
        // Every other save needs the event displayed when the form loaded.
        const allowLegacySwitch = changedKeys.length === 1 && changedKeys[0] === "eventName"
            && typeof changes.eventName === "string"
            && changes.eventName !== settings.get("eventName");
        const eventIssue = settingsEventIssue(expectedEvent, allowLegacySwitch);
        if (eventIssue) return res.status(eventIssue.status).json(eventIssue.body);
        if (Object.keys(changes).some((key) => settings.CREDENTIAL_KEYS.has(key))) {
            return res.status(400).json({ error: "Credentials require a separate replacement action" });
        }
        if (Object.prototype.hasOwnProperty.call(changes, "adminPhones")) {
            const normalized = settings.normalizeAdminPhones(changes.adminPhones);
            if (normalized === undefined) {
                return res.status(400).json({ error: "Admin phone numbers must use +country code and 8 to 15 digits" });
            }
            changes = { ...changes, adminPhones: normalized };
        }
        const hasTemplateSettings = Object.keys(changes).some((key) => TEMPLATE_SETTING_KEYS.has(key));
        const result = hasTemplateSettings
            ? await withTemplateOperationLock(() => saveChanges(changes, expectedEvent, allowLegacySwitch, true))
            : saveChanges(changes, expectedEvent, allowLegacySwitch);

        // Turning review off only affects new items. Existing review items
        // remain queued until a human explicitly approves or rejects them.
        res.status(result.status).json(result.body);
    } catch (err) {
        if (err.code === "VOICE_READINESS") {
            return res.status(400).json({ error: "Voice configuration is incomplete", issues: err.issues });
        }
        console.error(`❌ Settings save failed: ${err.message}`);
        res.status(500).json({ error: "Settings save failed" });
    }
});

// The saved dub.co key is a compatibility fallback until a deployment secret
// is configured. Replacement is write-only and separate from ordinary edits.
router.post("/api/settings/credentials/dub", async (req, res) => {
    if (settings.DEFAULTS.dubApiKey) {
        return res.status(409).json({ error: "Dub key is managed by deployment" });
    }
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).length !== 1 || typeof body.dubApiKey !== "string"
        || !body.dubApiKey.trim() || body.dubApiKey.trim().length > 2048) {
        return res.status(400).json({ error: "A replacement dub key is required" });
    }
    try {
        const previous = settings.get("dubApiKey");
        const replacement = body.dubApiKey.trim();
        if (replacement !== previous) {
            settings.update({ dubApiKey: replacement });
            await audit.logSettingsChange(req.user.email, settings.get("eventName"),
                { dubApiKey: previous }, { dubApiKey: replacement });
        }
        res.json({
            success: true,
            credentialStatus: { dubApiKey: settings.getBrowserSettings().credentialStatus.dubApiKey },
        });
    } catch (err) {
        console.error("❌ Dub key replacement failed");
        res.status(500).json({ error: "Dub key replacement failed" });
    }
});

router.get("/api/settings/events", (_req, res) => {
    res.json({ events: settings.listEvents(), eventProfiles: settings.listEventProfiles() });
});

router.get("/api/settings/files", async (req, res) => {
    let pending = null;
    try {
        const now = Date.now();
        if (_settingsFilesCache.data && now - _settingsFilesCache.ts < 20_000) {
            return res.json(_settingsFilesCache.data);
        }
        const version = _settingsFilesCache.version;
        if (!_settingsFilesCache.pending || _settingsFilesCache.pending.version !== version) {
            const run = Promise.all([
                settings.listTemplates(),
                Promise.resolve(settings.listVideos()),
                settings.listPrinters(),
            ]).then(([templates, videos, printers]) => ({
                templates, videos, printers,
                events: settings.listEvents(),
                brandReferences: settings.listBrandReferences(),
                styleReferences: settings.listStyleReferences(),
                backgroundReferences: settings.listBackgroundReferences(),
                eventProfiles: settings.listEventProfiles(),
            }));
            _settingsFilesCache.pending = { version, run };
        }
        pending = _settingsFilesCache.pending;
        const data = await pending.run;
        if (_settingsFilesCache.version === pending.version) {
            _settingsFilesCache.data = data;
            _settingsFilesCache.ts = Date.now();
        }
        if (_settingsFilesCache.pending === pending) _settingsFilesCache.pending = null;
        res.json(data);
    } catch (err) {
        if (_settingsFilesCache.pending === pending) _settingsFilesCache.pending = null;
        console.error(`❌ Settings file discovery failed: ${err.message}`);
        res.status(503).json({ error: "Template files are temporarily unavailable" });
    }
});

router.post("/api/settings/template/compatibility", async (req, res) => {
    const { filename, compatibility } = req.body || {};
    if (!validExistingTemplateName(filename)) {
        return res.status(400).json({ error: "Invalid template filename" });
    }
    if (!["native", "portrait", "landscape", "both"].includes(compatibility)) {
        return res.status(400).json({ error: "Invalid template compatibility" });
    }

    try {
        await withTemplateOperationLock(async () => {
            settings.refreshTemplateStateFromDisk();
            if (!settings.isTemplateUsable(filename)) {
                return res.status(404).json({ error: "Template not found" });
            }
            try {
                const stat = await fsp.stat(path.join(settings.TEMPLATES_DIR, filename));
                if (!stat.isFile()) return res.status(404).json({ error: "Template not found" });
            } catch (err) {
                if (err.code === "ENOENT") return res.status(404).json({ error: "Template not found" });
                throw err;
            }
            settings.setTemplateCompatibility(filename, compatibility);
            res.json({ success: true, filename, compatibility });
        });
    } catch (err) {
        console.error(`❌ Template compatibility update failed: ${err.message}`);
        res.status(500).json({ error: "Template compatibility update failed" });
    }
});

router.post("/api/settings/template/rename", async (req, res) => {
    const { filename, newName } = req.body || {};
    if (!validExistingTemplateName(filename)) {
        return res.status(400).json({ error: "Invalid template filename" });
    }
    const safeName = sanitizedRenamedTemplateName(newName, filename);
    if (!safeName) return res.status(400).json({ error: "Invalid new template name" });

    await withTemplateOperationLock(async () => {
        settings.refreshTemplateStateFromDisk();
        if (!settings.isTemplateUsable(filename)) {
            return res.status(404).json({ error: "Template not found" });
        }
        const sourcePath = path.join(settings.TEMPLATES_DIR, filename);
        const targetPath = path.join(settings.TEMPLATES_DIR, safeName);
        try {
            const sourceStat = await fsp.stat(sourcePath);
            if (!sourceStat.isFile()) return res.status(404).json({ error: "Template not found" });
        } catch (err) {
            if (err.code === "ENOENT") return res.status(404).json({ error: "Template not found" });
            return res.status(500).json({ error: "Could not read template" });
        }
        if (safeName === filename) {
            return res.json(await withTemplateFiles({ success: true, filename: safeName }));
        }
        try {
            await fsp.access(targetPath);
            return res.status(409).json({ error: "A template with that name already exists" });
        } catch (err) {
            if (err.code !== "ENOENT") return res.status(500).json({ error: "Could not check template name" });
        }

        let copied = false;
        let migrated = false;
        try {
            try {
                await fsp.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
                copied = true;
            } catch (err) {
                if (err.code === "EEXIST") {
                    return res.status(409).json({ error: "A template with that name already exists" });
                }
                throw err;
            }
            settings.migrateTemplateReferences(filename, safeName);
            migrated = true;
            try {
                await fsp.unlink(sourcePath);
            } catch (err) {
                if (err.code !== "ENOENT") {
                    console.error(`⚠️  Renamed template cleanup failed; tombstone will hide the old file: ${err.message}`);
                }
            }
            res.json(await withTemplateFiles({ success: true, filename: safeName }));
        } catch (err) {
            if (copied && !migrated) {
                try { await fsp.unlink(targetPath); } catch (cleanupErr) {
                    console.error(`⚠️  Failed to roll back template copy: ${cleanupErr.message}`);
                }
            }
            console.error(`❌ Template rename failed: ${err.message}`);
            res.status(500).json({ error: "Template rename failed" });
        }
    });
});

router.delete("/api/settings/template", async (req, res) => {
    const filename = req.query.filename;
    if (!validExistingTemplateName(filename)) {
        return res.status(400).json({ error: "Invalid template filename" });
    }
    await withTemplateOperationLock(async () => {
        settings.refreshTemplateStateFromDisk();
        if (!settings.isTemplateUsable(filename)) {
            return res.status(404).json({ error: "Template not found" });
        }
        const filePath = path.join(settings.TEMPLATES_DIR, filename);
        try {
            const stat = await fsp.stat(filePath);
            if (!stat.isFile()) return res.status(404).json({ error: "Template not found" });
            settings.migrateTemplateReferences(filename, "");
            try { await fsp.unlink(filePath); } catch (err) {
                if (err.code !== "ENOENT") {
                    console.error(`⚠️  Deleted template cleanup failed; tombstone will hide the file: ${err.message}`);
                }
            }
            res.json(await withTemplateFiles({ success: true }));
        } catch (err) {
            if (err.code === "ENOENT") return res.status(404).json({ error: "Template not found" });
            console.error(`❌ Template delete failed: ${err.message}`);
            res.status(500).json({ error: "Template delete failed" });
        }
    });
});

router.post("/api/settings/reset", (req, res) => {
    settings.resetUser(req.user.email);
    res.json(settings.getBrowserSettings());
});

router.post("/api/settings/reset-all", (req, res) => {
    const eventIssue = settingsEventIssue(req.body?._forEvent);
    if (eventIssue) return res.status(eventIssue.status).json(eventIssue.body);
    settings.resetUser(req.user.email);
    settings.reset();
    res.json(settings.getBrowserSettings());
});

// ── Reset event data ─────────────────────────────────────────────────────────
// Wipes all generated data for a single event: queue files (except actively
// processing), images, leads, contacts, and kiosk submissions. Does NOT
// touch audit-log.jsonl (audit trail preserved by design) and does NOT
// reset settings — those are separate concerns.
router.post("/api/events/:eventName/reset-data", async (req, res) => {
    const eventName = req.params.eventName;
    // Reject any separator/traversal/null-byte tricks, plus anything that
    // doesn't look like a normal event name we'd accept on creation. This
    // is a destructive endpoint — stay strict.
    if (!eventName || !/^[A-Za-z0-9_\- ]{1,64}$/.test(eventName)) {
        return res.status(400).json({ error: "Invalid eventName" });
    }

    const summary = { eventName, queueJobs: 0, images: 0, leads: 0, contacts: 0, kioskSubmissions: 0 };

    // Queue files — skip GENERATING_DIR and PRINTING_DIR so we don't yank
    // a file a worker is actively holding a reference to.
    const queueDirs = [DONE_DIR, PENDING_DIR, REVIEW_DIR, READY_DIR, FAILED_DIR];
    for (const dir of queueDirs) {
        try {
            const files = await fsp.readdir(dir);
            for (const f of files) {
                if (!f.endsWith(".json")) continue;
                const full = path.join(dir, f);
                try {
                    const job = JSON.parse(await fsp.readFile(full, "utf8"));
                    if (job.eventName === eventName) {
                        await fsp.unlink(full);
                        summary.queueJobs++;
                    }
                } catch { /* skip unreadable */ }
            }
        } catch { /* dir missing is fine */ }
    }

    // Download dir — images (final + .staging). Remove only files, not the
    // directory itself, so the pipeline can keep writing into it afterwards.
    const dlRoot = path.join(__dirname, "..", "downloads");
    for (const evDir of [path.join(dlRoot, eventName), path.join(dlRoot, eventName, ".staging")]) {
        try {
            const files = await fsp.readdir(evDir);
            for (const f of files) {
                const full = path.join(evDir, f);
                try {
                    const stat = await fsp.stat(full);
                    if (stat.isFile()) {
                        await fsp.unlink(full);
                        summary.images++;
                    }
                } catch {}
            }
        } catch {}
    }

    summary.leads = leads.deleteByEvent(eventName);
    summary.contacts = contacts.deleteByEvent(eventName);
    summary.kioskSubmissions = kioskSubmissions.deleteByEvent(eventName);

    // Invalidate caches so the dashboard immediately reflects the wipe
    // instead of serving stale counts until STATS_CACHE_TTL expires.
    // _dirCache feeds the count badges; _reviewCache feeds the review queue.
    // Miss either and post-reset UI shows stale numbers where the admin is
    // specifically looking to confirm the wipe.
    invalidateStatsCache();
    _jobsCache.clear();
    _dirCache.clear();
    try { require("./photogallery").invalidatePhotoGalleryCache(eventName, { styles: true }); } catch {}
    // Rebuild the usage cache since we deleted jobs it counted. Await so
    // the response only returns once the cache is ready — otherwise the
    // dashboard's next poll can still hit a half-built cache.
    try {
        const { buildUsageCache, invalidateReviewCache } = require("./queue");
        invalidateReviewCache();
        await buildUsageCache();
    } catch (err) {
        console.error(`⚠️  Usage cache rebuild after reset failed: ${err.message}`);
    }

    console.log(`🗑️  Reset event data for "${eventName}":`, summary);
    res.json({ ok: true, summary });
});

// ── Audit Log ──────────────────────────────────────────────────────────────

router.get("/api/audit", async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        // The "Recent Settings Changes" panel passes type=settings to hide
        // review/variant events. Left unset = show everything (for callers
        // that want the full activity log).
        const filter = req.query.type || null;
        const result = await audit.getAuditLog(limit, offset, filter);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post("/api/audit/revert/:id", async (req, res) => {
    try {
        const result = await audit.revertEntry(req.params.id, req.user.email);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Legacy endpoint — save is now always global, kept for backwards compatibility
router.post("/api/settings/save-global", (req, res) => {
    settings.saveUserToGlobal(req.user.email);
    res.json(settings.getBrowserSettings());
});

router.get("/api/settings/global", (req, res) => {
    res.json(settings.getBrowserSettings());
});

// Read another event's style prompts (overrides + custom styles) for importing into current event
router.get("/api/settings/event-styles/:eventName", (req, res) => {
    const eventName = req.params.eventName;
    const validEvents = settings.listEventProfiles();
    if (!validEvents.includes(eventName)) {
        return res.status(404).json({ error: "Event not found" });
    }
    const eventSettings = settings.loadEventSettings(eventName);
    res.json({
        stylePromptOverrides: eventSettings.stylePromptOverrides || {},
        customStyles: eventSettings.customStyles || {},
    });
});

// File upload for templates and videos (streams to disk without buffering the body)
router.post("/api/settings/upload", (req, res) => {
    const filename = req.query.filename;
    const type = req.query.type;
    const replaceFilename = req.query.replaceFilename;

    if (!filename || !type) {
        return res.status(400).json({ error: "filename and type query params are required" });
    }
    if (!["template", "video", "brand-reference", "style-reference", "background-reference", "booth-image"].includes(type)) {
        return res.status(400).json({ error: "type must be 'template', 'video', 'brand-reference', 'style-reference', 'background-reference', or 'booth-image'" });
    }
    if (replaceFilename && (type !== "template" || req.query.replace !== "1" || !validManagedTemplateName(replaceFilename))) {
        return res.status(400).json({ error: "Invalid replacement template filename" });
    }

    // Validate file extension
    const ext = path.extname(filename).toLowerCase();
    const allowed = type === "template"
        ? [...TEMPLATE_EXTENSIONS]
        : (type === "brand-reference" || type === "style-reference" || type === "background-reference")
        ? [".png", ".jpg", ".jpeg", ".gif"]
        : type === "booth-image"
        ? [".png", ".jpg", ".jpeg", ".svg", ".webp"]
        : [".mp4", ".webm", ".mov"];
    if (!allowed.includes(ext)) {
        return res.status(400).json({ error: `Invalid file type. Allowed: ${allowed.join(", ")}` });
    }

    const maxBytes = type === "template" ? MAX_TEMPLATE_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        const maxMb = maxBytes / 1024 / 1024;
        return res.status(413).json({ error: `File too large (max ${maxMb}MB)` });
    }

    // Sanitize filename
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const targetDir = type === "template"
        ? settings.TEMPLATES_DIR
        : type === "brand-reference"
        ? path.join(__dirname, "..", "brand-references")
        : type === "style-reference"
        ? path.join(__dirname, "..", "style-references")
        : type === "background-reference"
        ? path.join(__dirname, "..", "background-references")
        : path.join(__dirname, "..", "booth-uploads"); // video + booth-image live here so they persist across container restarts (assets/ is in-image only)

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    const targetPath = path.join(targetDir, safeName);
    if (type === "template" && req.query.replace !== "1" && fs.existsSync(targetPath)) {
        return res.status(409).json({ error: "A template with that name already exists" });
    }
    const uploadPath = path.join(targetDir, `.${safeName}.upload-${process.pid}-${Date.now()}-${_templateOperationCounter++}`);
    const writeStream = fs.createWriteStream(uploadPath, { flags: "wx" });
    let size = 0;
    let finished = false;

    function fail(status, msg) {
        if (finished) return;
        finished = true;
        writeStream.destroy();
        try { fs.unlinkSync(uploadPath); } catch (_) {}
        res.status(status).json({ error: msg });
    }

    req.on("data", (chunk) => {
        if (finished) return;
        size += chunk.length;
        if (size > maxBytes) {
            fail(413, `File too large (max ${maxBytes / 1024 / 1024}MB)`);
            return;
        }
        const canContinue = writeStream.write(chunk);
        if (!canContinue) {
            req.pause();
            writeStream.once("drain", () => { if (!finished) req.resume(); });
        }
    });

    req.on("end", () => {
        if (finished) return;
        writeStream.end(async () => {
            if (finished) return;
            if (size === 0) {
                finished = true;
                try { fs.unlinkSync(uploadPath); } catch (_) {}
                return res.status(400).json({ error: "No file data received" });
            }
            try {
                if (type === "template") {
                    try {
                        await validateTemplateFile(uploadPath, safeName);
                    } catch {
                        finished = true;
                        try { await fsp.unlink(uploadPath); } catch {}
                        return res.status(400).json({ error: "Invalid template image data" });
                    }
                }
                if (type === "template") {
                    await withTemplateOperationLock(async () => {
                        settings.refreshTemplateStateFromDisk();
                        const replacing = req.query.replace === "1";
                        const replacedFilename = replaceFilename || safeName;
                        const replacedPath = path.join(targetDir, replacedFilename);
                        let targetExists = false;
                        try {
                            targetExists = (await fsp.stat(targetPath)).isFile();
                        } catch (err) {
                            if (err.code !== "ENOENT") throw err;
                        }
                        let replacedFileExists = targetExists;
                        if (replacedFilename !== safeName) {
                            try {
                                replacedFileExists = (await fsp.stat(replacedPath)).isFile();
                            } catch (err) {
                                if (err.code !== "ENOENT") throw err;
                                replacedFileExists = false;
                            }
                        }
                        if (!replacing && targetExists) {
                            const err = new Error("A template with that name already exists");
                            err.status = 409;
                            throw err;
                        }
                        if (replacing && !replacedFileExists) {
                            const err = new Error("Template not found");
                            err.status = 404;
                            throw err;
                        }
                        if (replacing && replacedFilename !== safeName && targetExists) {
                            const err = new Error("A template with the replacement name already exists");
                            err.status = 409;
                            throw err;
                        }

                        const backupPath = path.join(targetDir, `.${safeName}.backup-${process.pid}-${Date.now()}-${_templateOperationCounter++}`);
                        let installed = false;
                        try {
                            if (targetExists) await fsp.copyFile(targetPath, backupPath, fs.constants.COPYFILE_EXCL);
                            await fsp.rename(uploadPath, targetPath);
                            installed = true;
                            if (replacedFilename !== safeName) {
                                settings.migrateTemplateReferences(replacedFilename, safeName);
                                try { await fsp.unlink(replacedPath); } catch (err) {
                                    if (err.code !== "ENOENT") {
                                        console.error(`⚠️  Replaced template cleanup failed; tombstone will hide the old file: ${err.message}`);
                                    }
                                }
                            } else {
                                settings.restoreTemplate(safeName);
                            }
                        } catch (err) {
                            if (installed) {
                                try {
                                    if (targetExists) await fsp.rename(backupPath, targetPath);
                                    else await fsp.unlink(targetPath);
                                } catch (rollbackErr) {
                                    err.message += ` (template rollback failed: ${rollbackErr.message})`;
                                }
                            }
                            throw err;
                        } finally {
                            try { await fsp.unlink(backupPath); } catch (err) {
                                if (err.code !== "ENOENT") console.error(`⚠️  Template backup cleanup failed: ${err.message}`);
                            }
                        }
                    });
                } else {
                    await fsp.rename(uploadPath, targetPath);
                }
                console.log(`📁 Uploaded ${type}: ${safeName} (${(size / 1024 / 1024).toFixed(1)}MB)`);
                if (["style-reference", "brand-reference", "background-reference"].includes(type)) {
                    invalidateRefAnalysis(type);
                }
                finished = true;
                if (type === "template") {
                    res.json(await withTemplateFiles({ success: true, filename: safeName }));
                } else {
                    const files = type === "brand-reference" ? settings.listBrandReferences() : type === "style-reference" ? settings.listStyleReferences() : type === "background-reference" ? settings.listBackgroundReferences() : type === "video" ? settings.listVideos() : [];
                    res.json({ success: true, filename: safeName, files });
                }
            } catch (err) {
                try { await fsp.unlink(uploadPath); } catch {}
                console.error(`❌ Upload finalize error: ${err.message}`);
                finished = true;
                res.status(err.status || 500).json({ error: "Upload failed: " + err.message });
            }
        });
    });

    writeStream.on("error", (err) => {
        console.error(`❌ Upload write error: ${err.message}`);
        fail(500, "Upload failed: " + err.message);
    });

    req.on("error", (err) => {
        console.error(`❌ Upload stream error: ${err.message}`);
        fail(500, "Upload failed: " + err.message);
    });
});

router.delete("/api/settings/brand-reference", (req, res) => {
    const filename = req.query.filename;
    if (!filename) return res.status(400).json({ error: "filename is required" });

    const safeName = path.basename(filename);
    const filePath = path.join(settings.BRAND_REFS_DIR, safeName);
    try { fs.unlinkSync(filePath); } catch (_) {}

    // Remove from brandReferenceFiles setting
    const current = settings.get("brandReferenceFiles") || [];
    settings.update({ brandReferenceFiles: current.filter((f) => f !== safeName) });
    invalidateRefAnalysis("brand-reference");

    res.json({ success: true, files: settings.listBrandReferences() });
});

router.delete("/api/settings/style-reference", (req, res) => {
    const filename = req.query.filename;
    if (!filename) return res.status(400).json({ error: "filename is required" });

    const safeName = path.basename(filename);
    const filePath = path.join(settings.STYLE_REFS_DIR, safeName);
    try { fs.unlinkSync(filePath); } catch (_) {}
    invalidateRefAnalysis("style-reference");

    res.json({ success: true, files: settings.listStyleReferences() });
});

router.delete("/api/settings/background-reference", (req, res) => {
    const filename = req.query.filename;
    if (!filename) return res.status(400).json({ error: "filename is required" });

    const safeName = path.basename(filename);
    const filePath = path.join(settings.BG_REFS_DIR, safeName);
    try { fs.unlinkSync(filePath); } catch (_) {}
    invalidateRefAnalysis("background-reference");

    res.json({ success: true, files: settings.listBackgroundReferences() });
});

// ── Logs API + Page ──────────────────────────────────────────────────────────

router.get("/api/logs", (req, res) => {
    const logBuffer = require("./log-buffer");
    const since = Math.max(0, Number.parseInt(req.query.since, 10) || 0);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(500, requestedLimit)) : 500;
    const level = req.query.level || null;
    let entries = logBuffer.getEntries();
    if (since) entries = entries.filter((e) => e.id > since);
    if (level) entries = entries.filter((e) => e.level === level);
    res.json(entries.slice(-limit));
});

router.get("/api/logs/stream", (req, res) => {
    const logBuffer = require("./log-buffer");
    const requestedSince = Math.max(0, Number.parseInt(req.query.since, 10) || 0,
        Number.parseInt(req.get("Last-Event-ID"), 10) || 0);
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
    });
    res.write(":\n\n");
    if (typeof res.flush === "function") res.flush();
    const onEntry = (entry) => {
        res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`);
        if (typeof res.flush === "function") res.flush();
    };
    logBuffer.subscribe(onEntry);
    const recent = logBuffer.getEntries();
    const newest = recent.length ? recent[recent.length - 1].id : 0;
    const since = requestedSince > newest ? 0 : requestedSince;
    if (requestedSince > newest) res.write("event: reset\ndata: {}\n\n");
    for (const entry of recent) {
        if (entry.id > since) onEntry(entry);
    }
    req.on("close", () => logBuffer.unsubscribe(onEntry));
});

router.get("/logs", (req, res) => {
    res.type("html").send(LOGS_HTML);
});

// ── Dashboard HTML ───────────────────────────────────────────────────────────

router.get("/", (req, res) => {
    // Ensure trailing slash so relative fetch URLs resolve correctly
    if (!req.originalUrl.endsWith("/")) return res.redirect(req.originalUrl + "/");
    res.type("html").send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = renderDashboardPage({ userBar: userBarSnippet(), magicHat: magicHatSnippet() });

// ── Logs HTML ─────────────────────────────────────────────────────────────────

const LOGS_HTML = renderLogsPage({ userBar: userBarSnippet(), magicHat: magicHatSnippet() });

// ── Start ────────────────────────────────────────────────────────────────────

function mountDashboard(app) {
    app.use("/dashboard", router);
    console.log("📊 Dashboard mounted at /dashboard");
}

module.exports = { mountDashboard };

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const express = require("express");
const sharp = require("sharp");
const { DONE_DIR, PENDING_DIR, GENERATING_DIR, REVIEW_DIR, READY_DIR, PRINTING_DIR, FAILED_DIR } = require("./config");
const settings = require("./settings");
const messaging = require("./messaging");
const leads = require("./leads");
const kioskSubmissions = require("./kiosk-submissions");
const contacts = require("./contacts");
const channels = require("./channels");
const i18n = require("./i18n");
const { randomInt } = require("node:crypto");
const { paginateRows, buildOutreachHtml } = require("./outreach-page");

const { userBarSnippet, magicHatSnippet } = require("./auth");

const router = express.Router();
router.use(express.json());

const DATA_DIR = path.join(__dirname, "..", "data");
const RAFFLE_FILE = path.join(DATA_DIR, "raffle.json");
const _thumbnailCache = new Map();
const _THUMBNAIL_CACHE_MAX = 160;

// Raffle persistence
let raffleHistory = [];

function loadRaffle() {
    try {
        if (fs.existsSync(RAFFLE_FILE)) {
            raffleHistory = JSON.parse(fs.readFileSync(RAFFLE_FILE, "utf-8"));
        }
    } catch (err) {
        console.error("Failed to load raffle history:", err);
        raffleHistory = [];
    }
}

let _writeCounter = 0;
function saveRaffle() {
    try {
        const tmp = RAFFLE_FILE + `.tmp.${process.pid}.${_writeCounter++}`;
        fs.writeFileSync(tmp, JSON.stringify(raffleHistory, null, 2), "utf-8");
        fs.renameSync(tmp, RAFFLE_FILE);
    } catch (err) {
        console.error("Failed to save raffle history:", err);
    }
}

// Helper functions — async stale-while-revalidate cache for job reads
const _outreachJobsCache = new Map();
const _OUTREACH_CACHE_TTL = 30_000;
const _userDirectoryCache = new Map();
let _outreachJobsGeneration = 0;
const ACTIVE_JOB_DIRS = [DONE_DIR, PENDING_DIR, GENERATING_DIR, REVIEW_DIR, READY_DIR, PRINTING_DIR];

function _refreshOutreachJobs(dir) {
    const pendingKey = dir + ":pending";
    if (_outreachJobsCache.has(pendingKey)) return _outreachJobsCache.get(pendingKey);
    const generation = _outreachJobsGeneration;
    const pending = (async () => {
        try {
            const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
            const jobs = [];
            // Read in bounded batches: one read at a time is slow for large
            // events, while an unbounded Promise.all can overload the disk.
            for (let i = 0; i < files.length; i += 48) {
                const batch = await Promise.all(files.slice(i, i + 48).map(async (f) => {
                    try { return JSON.parse(await fsp.readFile(path.join(dir, f), "utf-8")); }
                    catch { return null; }
                }));
                for (const job of batch) if (job) jobs.push(job);
            }
            if (generation === _outreachJobsGeneration) {
                _outreachJobsCache.set(dir, { jobs, ts: Date.now() });
                if (dir === DONE_DIR) _userDirectoryCache.clear();
            }
        } catch (error) {
            if (error.code === "ENOENT") {
                if (generation === _outreachJobsGeneration) _outreachJobsCache.set(dir, { jobs: [], ts: Date.now() });
            }
            else console.error("Outreach job refresh failed:", error);
        } finally {
            if (_outreachJobsCache.get(pendingKey) === pending) _outreachJobsCache.delete(pendingKey);
        }
    })();
    _outreachJobsCache.set(pendingKey, pending);
    return pending;
}

function readJobs(dir) {
    const cached = _outreachJobsCache.get(dir);
    const now = Date.now();
    if (cached && (now - cached.ts) < _OUTREACH_CACHE_TTL) return cached.jobs;
    _refreshOutreachJobs(dir);
    return cached ? cached.jobs : [];
}

async function ensureJobsReady(dir) {
    if (!_outreachJobsCache.get(dir)) await _refreshOutreachJobs(dir);
}

async function activeJobs() {
    await Promise.all(ACTIVE_JOB_DIRS.map(ensureJobsReady));
    return ACTIVE_JOB_DIRS.flatMap((dir) => readJobs(dir));
}

// Only the default Messaging view needs completed jobs at startup. The
// other queue directories are loaded when Follow-ups is opened.
_refreshOutreachJobs(DONE_DIR);

function maskPhone(phone) {
    if (!phone || phone.length < 6) return phone || "unknown";
    // Kiosk / API submissions use synthetic userPhone like "api:<id>" —
    // render them as "Kiosk" so they don't look like mangled phone numbers.
    if (phone.startsWith("api:")) return "Kiosk";
    const tail = phone.slice(-4);
    let ccLen = 2;
    if (phone.length > 12) ccLen = 4;
    else if (phone.length > 11) ccLen = 3;
    const cc = phone.slice(0, ccLen);
    const maskLen = phone.length - ccLen - 4;
    return cc + "*".repeat(Math.max(1, maskLen)) + tail;
}

function phoneHash(phone) {
    let h = 0;
    for (let i = 0; i < phone.length; i++) h = ((h << 5) - h + phone.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function buildUserDirectory(eventFilter) {
    const doneJobs = readJobs(DONE_DIR);
    const adminPhones = settings.get("adminPhones") || [];
    const cacheKey = eventFilter || "all";
    const adminKey = JSON.stringify(adminPhones);
    const cached = _userDirectoryCache.get(cacheKey);
    if (cached && cached.jobs === doneJobs && cached.adminKey === adminKey) return cached.users;
    const adminSet = new Set(adminPhones);
    const userMap = new Map();
    for (const job of doneJobs) {
        const phone = job.userPhone;
        if (!phone || adminSet.has(phone)) continue;
        if (eventFilter && eventFilter !== "all" && job.eventName !== eventFilter) continue;
        if (!userMap.has(phone)) {
            userMap.set(phone, { phone, appPhone: job.appPhone, count: 0, styles: new Set(), lastActive: 0, lastPrefix: null, lastEvent: null });
        }
        const user = userMap.get(phone);
        user.count++;
        if (job.style) user.styles.add(job.style);
        if (job.createdAt > user.lastActive) {
            user.lastActive = job.createdAt;
            user.appPhone = job.appPhone;
            // Track the most recent completed portrait so the UI can render a
            // thumbnail next to the row. For multi-variant jobs filePrefix is
            // the winning variant's prefix (what's on disk), so this works
            // without extra lookups.
            user.lastPrefix = job.filePrefix || null;
            user.lastEvent = job.eventName || null;
        }
    }
    const users = [...userMap.values()]
        .sort((a, b) => b.lastActive - a.lastActive)
        .map((u) => ({ ...u, id: phoneHash(u.phone), styles: [...u.styles] }));
    if (_userDirectoryCache.size >= 24) _userDirectoryCache.delete(_userDirectoryCache.keys().next().value);
    _userDirectoryCache.set(cacheKey, { jobs: doneJobs, adminKey, users });
    return users;
}

function wantsPage(query) {
    return query.paged === "1";
}

function includesSearch(values, search) {
    return values.some((value) => String(value || "").toLocaleLowerCase().includes(search));
}

function safeMediaSegment(value) {
    if (typeof value !== "string" || !value) return false;
    let decoded = value;
    for (let i = 0; i < 5; i++) {
        if (decoded.startsWith(".") || /[\\/\\\\\x00-\x1f\x7f]/.test(decoded)) return false;
        if (!decoded.includes("%")) return true;
        try {
            const next = decodeURIComponent(decoded);
            if (next === decoded) return true;
            decoded = next;
        } catch { return false; }
    }
    return false;
}

// ── HTML Page ────────────────────────────────────────────────────────────────

const OUTREACH_HTML = buildOutreachHtml({ userBar: userBarSnippet(), magicHat: magicHatSnippet() });

// Routes
router.get("/", (req, res) => {
    if (!req.originalUrl.endsWith("/")) return res.redirect(req.originalUrl + "/");
    res.type("html").send(OUTREACH_HTML);
});

router.get("/api/events", async (req, res) => {
    await ensureJobsReady(DONE_DIR);
    const jobs = readJobs(DONE_DIR);
    const jobEvents = jobs.map((j) => j.eventName).filter(Boolean);
    let dlEvents = [];
    try {
        const dlRoot = path.join(__dirname, "..", "downloads");
        dlEvents = (await fsp.readdir(dlRoot, { withFileTypes: true }))
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
    } catch {}
    const currentEvent = settings.get("eventName");
    const events = [...new Set([...jobEvents, ...dlEvents, currentEvent].filter(Boolean))].sort();
    res.json({ events, currentEvent });
});

router.get("/api/users", async (req, res) => {
    await ensureJobsReady(DONE_DIR);
    const eventFilter = req.query.event || settings.get("eventName");
    const users = buildUserDirectory(eventFilter);
    const showLeadData = eventFilter !== "all";
    const eventName = showLeadData ? eventFilter : null;
    const page = wantsPage(req.query)
        ? paginateRows(users, req.query, (u, search) => includesSearch([
            u.phone, maskPhone(u.phone), leads.getLeadName(u.phone, eventName || u.lastEvent), ...u.styles,
        ], search))
        : { items: users };
    const winnerIds = new Set(raffleHistory.filter((w) => !showLeadData || w.event === eventFilter).map((w) => w.id));
    // Parallel thumbnail existence checks avoid per-row 404s in the browser.
    // Page first, so large events only check the portraits currently shown.
    const withThumbs = await Promise.all(page.items.map(async (u) => {
        let hasThumb = false;
        if (u.lastPrefix && u.lastEvent) {
            const thumbPath = path.join(settings.getDownloadDir(u.lastEvent), `${u.lastPrefix}_output.png`);
            try { await fsp.access(thumbPath); hasThumb = true; } catch {}
        }
        return {
            id: u.id,
            phone: maskPhone(u.phone),
            name: leads.getLeadName(u.phone, eventName || u.lastEvent) || null,
            count: u.count,
            styles: u.styles,
            lastActive: u.lastActive,
            lastPrefix: u.lastPrefix,
            lastEvent: u.lastEvent,
            hasThumb,
            isWinner: winnerIds.has(u.id),
        };
    }));
    if (wantsPage(req.query)) res.json({ ...page, items: withThumbs });
    else res.json(withThumbs);
});

// Portrait list rows use small encoded images. The full-resolution output
// remains available through the existing gallery link when needed.
router.get("/api/thumbnail/:event/:prefix", async (req, res) => {
    const { event, prefix } = req.params;
    if (!safeMediaSegment(event) || !safeMediaSegment(prefix)) return res.sendStatus(400);
    const file = path.join(settings.getDownloadDir(event), `${prefix}_output.png`);
    let key;
    let encoded;
    try {
        const stat = await fsp.stat(file);
        key = `${file}:${stat.size}:${stat.mtimeMs}`;
        encoded = _thumbnailCache.get(key);
        if (!encoded) {
            encoded = sharp(file).rotate().resize(112, 112, { fit: "cover" }).webp({ quality: 70 }).toBuffer();
            _thumbnailCache.set(key, encoded);
            if (_thumbnailCache.size > _THUMBNAIL_CACHE_MAX) _thumbnailCache.delete(_thumbnailCache.keys().next().value);
        } else {
            _thumbnailCache.delete(key);
            _thumbnailCache.set(key, encoded);
        }
        const body = await encoded;
        res.setHeader("Content-Type", "image/webp");
        res.setHeader("Cache-Control", "private, max-age=60");
        res.send(body);
    } catch (error) {
        if (key && _thumbnailCache.get(key) === encoded) _thumbnailCache.delete(key);
        if (error.code === "ENOENT") return res.sendStatus(404);
        console.error("Outreach thumbnail failed:", error);
        res.sendStatus(500);
    }
});

router.post("/api/send-message", async (req, res) => {
    const { ids, message, event } = req.body || {};
    if (!message || !ids || !ids.length) {
        return res.status(400).json({ error: "ids and message are required" });
    }
    await ensureJobsReady(DONE_DIR);
    const users = buildUserDirectory(event || settings.get("eventName"));
    const byId = new Map(users.map((u) => [u.id, u]));
    let sent = 0;
    let failed = 0;
    for (const id of ids) {
        const user = byId.get(id);
        if (!user || !user.phone || !user.appPhone) { failed++; continue; }
        try {
            const adapter = channels.ADAPTERS[contacts.getPreferredChannel(user.phone)];
            if (!adapter || !user.lastEvent || !contacts.hasMarketingConsent(user.phone, user.lastEvent, adapter.name)) {
                failed++;
                continue;
            }
            const smsMessage = /reply\s+stop/i.test(message) ? message : `${message}\n\nReply STOP to unsubscribe.`;
            const result = await messaging.send(user.phone, "_raw", {}, { _body: smsMessage, requiresSession: true, ...(adapter ? { adapter } : {}) });
            if (result && (result.error || result.skipped)) failed++; else sent++;
        } catch {
            failed++;
        }
    }
    console.log(`📨 Broadcast: ${sent} sent, ${failed} failed`);
    res.json({ sent, failed });
});

router.get("/api/raffle", (req, res) => {
    const event = req.query.event;
    const winners = event && event !== "all"
        ? raffleHistory.filter((w) => w.event === event)
        : raffleHistory;
    if (wantsPage(req.query)) res.json(paginateRows(winners, req.query));
    else res.json(winners);
});

// Draw against the complete event directory, never the current UI page or
// search result. The server picks uniformly and persists the actual winner.
router.post("/api/raffle/draw", async (req, res) => {
    await ensureJobsReady(DONE_DIR);
    const event = (req.body || {}).event || settings.get("eventName");
    const users = buildUserDirectory(event);
    if (!users.length) return res.status(409).json({ error: "No eligible recipients for this event" });
    const winner = users[randomInt(users.length)];
    const entry = { id: winner.id, maskedPhone: maskPhone(winner.phone), event, timestamp: Date.now() };
    raffleHistory.unshift(entry);
    saveRaffle();
    res.json(entry);
});

router.post("/api/raffle", (req, res) => {
    const { id, maskedPhone, event } = req.body || {};
    if (!id || !maskedPhone) {
        return res.status(400).json({ error: "id and maskedPhone are required" });
    }
    const entry = { id, maskedPhone, event: event || "unknown", timestamp: Date.now() };
    raffleHistory.unshift(entry);
    saveRaffle();
    res.json(entry);
});

// ── Delete User ──────────────────────────────────────────────────────────────

router.delete("/api/users", async (req, res) => {
    const { ids, scope } = req.body || {};
    const event = (req.body || {}).event || settings.get("eventName");
    if (!ids || !ids.length) {
        return res.status(400).json({ error: "ids are required" });
    }
    if (!event) {
        return res.status(400).json({ error: "event is required" });
    }

    const deletePhotos = !scope || scope === "photos" || scope === "all";
    const deleteLead = !scope || scope === "lead" || scope === "all";

    await ensureJobsReady(DONE_DIR);
    const users = buildUserDirectory(event);
    const byId = new Map(users.map((u) => [u.id, u]));
    // Skip GENERATING_DIR and PRINTING_DIR — workers actively hold references
    // to jobs in those dirs; deleting mid-processing would corrupt state.
    const queueDirs = [DONE_DIR, PENDING_DIR, REVIEW_DIR, READY_DIR, FAILED_DIR];
    let deletedJobs = 0;
    let deletedLeads = 0;
    let deletedImages = 0;
    let deletedKioskSubs = 0;
    const affectedEvents = new Set();

    for (const id of ids) {
        const user = byId.get(id);
        if (!user) continue;
        const phone = user.phone;

        if (deletePhotos) {
            // Collect file prefixes from jobs before deleting, so we can delete images
            const filePrefixes = new Set();

            // Delete job files from all queue directories
            const isAllEvents = event === "all";
            for (const dir of queueDirs) {
                try {
                    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
                    for (const f of files) {
                        try {
                            const job = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
                            if (job.userPhone === phone && (isAllEvents || !event || job.eventName === event)) {
                                if (job.filePrefix) filePrefixes.add({ prefix: job.filePrefix, eventName: job.eventName });
                                fs.unlinkSync(path.join(dir, f));
                                deletedJobs++;
                            }
                        } catch {}
                    }
                } catch {}
            }

            // Delete image files from the relevant event download directories
            if (filePrefixes.size > 0 && event) {
                const dlRoot = path.join(__dirname, "..", "downloads");
                const prefixesByEvent = new Map();
                for (const { prefix, eventName } of filePrefixes) {
                    if (!prefixesByEvent.has(eventName)) prefixesByEvent.set(eventName, []);
                    prefixesByEvent.get(eventName).push(prefix);
                }
                for (const [evName, prefixes] of prefixesByEvent) {
                    affectedEvents.add(evName);
                    const dirs = [path.join(dlRoot, evName), path.join(dlRoot, evName, ".staging")];
                    for (const evDir of dirs) {
                        try {
                            const files = fs.readdirSync(evDir);
                            for (const f of files) {
                                for (const prefix of prefixes) {
                                    if (f.startsWith(prefix)) {
                                        try { fs.unlinkSync(path.join(evDir, f)); deletedImages++; } catch {}
                                        break;
                                    }
                                }
                            }
                        } catch {}
                    }
                    // Also wipe the kiosk submission records — batched in a
                    // single JSONL rewrite so heavy users (many portraits)
                    // don't trigger N full file rewrites.
                    try {
                        deletedKioskSubs += kioskSubmissions.deleteBatch(
                            prefixes.map((prefix) => ({ filePrefix: prefix, eventName: evName }))
                        );
                    } catch {}
                }
            }
        }

        if (deleteLead) {
            const isAllEvents = event === "all";
            deletedLeads += leads.deleteByPhone(phone, isAllEvents ? null : event);
        }

        // Clean up contact record so deleted users don't reappear in drop-offs
        if (deletePhotos) {
            const isAllEvents = event === "all";
            contacts.deleteByPhone(phone, isAllEvents ? null : event);
        }
    }

    // Invalidate outreach job cache so deleted users don't reappear in UI
    _outreachJobsGeneration++;
    _outreachJobsCache.clear();
    _userDirectoryCache.clear();
    try {
        const { invalidatePhotoGalleryCache } = require("./photogallery");
        for (const eventName of affectedEvents) invalidatePhotoGalleryCache(eventName);
    } catch {}

    // Rebuild usage cache
    if (deletePhotos) {
        const { buildUsageCache } = require("./queue");
        buildUsageCache();
    }

    const label = scope === "photos" ? "photos" : scope === "lead" ? "lead" : "all data";
    console.log(`🗑️  Deleted ${label} for ${ids.length} user(s): ${deletedJobs} jobs, ${deletedLeads} leads, ${deletedImages} images, ${deletedKioskSubs} kiosk submissions removed`);
    res.json({ deleted: ids.length, deletedJobs, deletedLeads, deletedImages, deletedKioskSubs });
});

// ── Drop-offs API ────────────────────────────────────────────────────────────

router.get("/api/drop-offs", async (req, res) => {
    const event = req.query.event || settings.get("eventName");
    // Check all active + completed directories — anyone with a job anywhere in the
    // pipeline is NOT a drop-off.  Only FAILED_DIR is excluded so failed users
    // can still be nudged.
    const pipelineJobs = await activeJobs();
    const adminPhones = settings.get("adminPhones") || [];
    const dropOffs = contacts.getDropOffs(event, pipelineJobs, adminPhones);
    const page = wantsPage(req.query)
        ? paginateRows(dropOffs, req.query, (c, search) => includesSearch([c.phone, maskPhone(c.phone), c.eventName], search))
        : { items: dropOffs };
    const items = page.items.map((c) => ({
        id: String(phoneHash(c.phone)),
        phone: maskPhone(c.phone),
        firstContactAt: c.firstContactAt,
        nudgedAt: c.nudgedAt,
    }));
    if (wantsPage(req.query)) res.json({ ...page, items });
    else res.json(items);
});

router.post("/api/nudge", async (req, res) => {
    const { id, event } = req.body || {};
    if (!id) return res.status(400).json({ error: "id is required" });

    const eventFilter = event || settings.get("eventName");
    const pipelineJobs = await activeJobs();
    const adminPhones = settings.get("adminPhones") || [];
    const dropOffs = contacts.getDropOffs(eventFilter, pipelineJobs, adminPhones);

    // Find the contact by hash ID
    const match = dropOffs.find((c) => String(phoneHash(c.phone)) === String(id));
    if (!match) return res.status(404).json({ error: "drop-off not found" });
    const adapter = channels.ADAPTERS[contacts.getPreferredChannel(match.phone)];
    if (!adapter || !contacts.hasMarketingConsent(match.phone, match.eventName, adapter.name)) {
        return res.status(403).json({ error: "Marketing opt-in required for this channel" });
    }

    const locale = i18n.resolveAttendeeLocale(
        settings.getForEvent("languageMode", match.eventName),
        contacts.getPreferredLocale(match.phone, match.eventName),
    ) || i18n.DEFAULT_LOCALE;
    const message = i18n.t(locale, "nudgeDropoff", { eventName: match.eventName }, match.eventName);
    try {
        const hasTemplate = adapter && adapter.name === "whatsapp" && settings.getContentSid("nudgeDropoff", locale);
        const result = hasTemplate
            ? await messaging.send(match.phone, "nudgeDropoff", { 1: match.eventName }, { adapter, locale, allowOutOfSession: true })
            : await messaging.send(match.phone, "_raw", {}, { _body: message, requiresSession: true, ...(adapter ? { adapter } : {}) });
        if (result && (result.error || result.skipped)) {
            const reason = result.error || `skipped (${result.skipped})`;
            console.error(`❌ Nudge failed for ${maskPhone(match.phone)}: ${reason}`);
            return res.status(500).json({ error: `Failed to send nudge message: ${reason}` });
        }
        contacts.markNudged(match.phone, match.eventName);
        console.log(`📇 Nudged drop-off: ${maskPhone(match.phone)} (${match.eventName})`);
        res.json({ ok: true });
    } catch (err) {
        console.error(`❌ Nudge failed for ${maskPhone(match.phone)}: ${err.message}`);
        res.status(500).json({ error: "Failed to send nudge message" });
    }
});

router.delete("/api/drop-offs", async (req, res) => {
    const { id, event } = req.body || {};
    if (!id) return res.status(400).json({ error: "id is required" });

    const eventFilter = event || settings.get("eventName");
    const pipelineJobs = await activeJobs();
    const adminPhones = settings.get("adminPhones") || [];
    const dropOffs = contacts.getDropOffs(eventFilter, pipelineJobs, adminPhones);
    const match = dropOffs.find((c) => String(phoneHash(c.phone)) === String(id));
    if (!match) return res.status(404).json({ error: "drop-off not found" });

    // Remove the contact record for this phone+event. The user texted in
    // but never finished — if they text again later, recordContact() will
    // create a fresh entry, so dismissing isn't a permanent blacklist.
    const deleted = contacts.deleteByPhone(match.phone, match.eventName);
    console.log(`📇 Dismissed drop-off: ${maskPhone(match.phone)} (${match.eventName})`);
    res.json({ deleted });
});

// ── Leads API ────────────────────────────────────────────────────────────────

router.get("/api/leads", (req, res) => {
    const event = req.query.event || settings.get("eventName");
    const eventFilter = event && event !== "all" ? event : null;
    const allLeads = eventFilter ? leads.getLeads(eventFilter) : leads.getLeads(null);
    // Sort by most recent first
    allLeads.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));
    const page = wantsPage(req.query)
        ? paginateRows(allLeads, req.query, (l, search) => includesSearch([
            l.firstName, l.lastName, l.email, l.personalEmail, l.company,
            l.jobTitle, l.country, l.phone,
        ], search))
        : { items: allLeads };
    const items = page.items.map((l) => ({
        firstName: l.firstName || "",
        lastName: l.lastName || "",
        email: l.email || "",
        personalEmail: l.personalEmail || "",
        company: l.company || "",
        jobTitle: l.jobTitle || "",
        country: l.country || "",
        phone: maskPhone(l.phone || ""),
        completedAt: l.completedAt || 0,
    }));
    if (wantsPage(req.query)) res.json({ ...page, items });
    else res.json(items);
});

router.delete("/api/leads", (req, res) => {
    const { event } = req.body || {};
    if (!event || event === "all") {
        return res.status(400).json({ error: "specific event required" });
    }
    const deleted = leads.deleteByEvent(event);
    console.log(`🗑️  Deleted ${deleted} leads for event "${event}"`);
    res.json({ deleted });
});

router.get("/api/kiosk-submissions", (req, res) => {
    const event = req.query.event || settings.get("eventName");
    const records = kioskSubmissions.listByEvent(event === "all" ? null : event);
    if (wantsPage(req.query)) {
        res.json(paginateRows(records, req.query, (r, search) => includesSearch([
            r.phone, r.email, r.style, r.event, r.filePrefix,
        ], search)));
    } else {
        res.json(records);
    }
});

router.post("/api/kiosk-submissions/emailed", (req, res) => {
    const { filePrefix, event, emailed } = req.body || {};
    if (!filePrefix || !event) return res.status(400).json({ error: "filePrefix and event required" });
    const updated = emailed
        ? kioskSubmissions.markEmailed(filePrefix, event)
        : kioskSubmissions.unmarkEmailed(filePrefix, event);
    if (!updated) return res.status(404).json({ error: "submission not found" });
    res.json(updated);
});

router.delete("/api/kiosk-submissions", (req, res) => {
    const { filePrefix, event } = req.body || {};
    if (!filePrefix || !event) return res.status(400).json({ error: "filePrefix and event required" });
    const removed = kioskSubmissions.deleteByFilePrefix(filePrefix, event);
    if (!removed) return res.status(404).json({ error: "submission not found" });
    res.json({ removed });
});

router.post("/api/kiosk-submissions/email", (req, res) => {
    const { filePrefix, event, email } = req.body || {};
    if (!filePrefix || !event) return res.status(400).json({ error: "filePrefix and event required" });
    const trimmed = (email || "").trim();
    // Pragmatic validation — matches what the kiosk accepts. Empty string
    // is allowed so admins can clear a bad address.
    if (trimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return res.status(400).json({ error: "Email looks invalid" });
    }
    const updated = kioskSubmissions.setEmail(filePrefix, event, trimmed);
    if (!updated) return res.status(404).json({ error: "submission not found" });
    res.json(updated);
});

router.get("/api/leads/export", (req, res) => {
    const event = req.query.event || settings.get("eventName");
    const eventFilter = event && event !== "all" ? event : null;
    const allLeads = eventFilter ? leads.getLeads(eventFilter) : leads.getLeads(null);
    allLeads.sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

    const headers = ["First Name", "Last Name", "Company Name", "Email Address", "Job Title", "Phone Number", "Address", "City", "Country", "State", "Postal Code", "List Import - Campaign Member Status"];
    const rows = allLeads.map((l) => {
        const email = (l.email || l.personalEmail || "").trim();
        return [
            (l.firstName || "").trim(),
            (l.lastName || "").trim(),
            (l.company || "").trim(),
            email,
            (l.jobTitle || "").trim(),
            (l.phone || "").trim(),
            "",  // Address
            "",  // City
            (l.country || "").trim(),
            "",  // State
            "",  // Postal Code
            "Attended",
        ];
    });

    // Build CSV
    const escapeCsv = (val) => {
        const str = String(val);
        if (str.includes(",") || str.includes('"') || str.includes("\n")) {
            return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
    };
    const csv = [headers.map(escapeCsv).join(",")]
        .concat(rows.map((r) => r.map(escapeCsv).join(",")))
        .join("\n");

    const filename = `leads-${eventFilter || "all-events"}-${new Date().toISOString().split("T")[0]}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
});

// Mount function
function mountOutreach(app) {
    loadRaffle();
    app.use("/outreach", router);
    console.log("📨 Outreach mounted at /outreach");
}

module.exports = { mountOutreach, buildOutreachHtml: () => OUTREACH_HTML };

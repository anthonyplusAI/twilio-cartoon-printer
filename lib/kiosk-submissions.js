// Stores contact info captured on the /kiosk page tied to a specific
// portrait's filePrefix. This is distinct from lib/leads.js (which runs a
// multi-step SMS survey keyed on phone+event) — kiosk submissions are a
// single-shot form filled in at the booth, and may have no phone, no email,
// or both. Admins use the outreach tab to see delivery records.
//
// Persisted as JSONL at data/kiosk-submissions.jsonl. New submissions append;
// edits and deletions compact older versions so superseded contact data is
// removed from disk.

const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "data", "kiosk-submissions.jsonl");

// The append-only log can be large at an event. Polling Outreach must not
// parse the whole file every time. The stat signature also notices another
// process replacing or appending to the file.
let recordsCache = { signature: null, records: [] };
const latestCache = new Map();

function fileSignature(stat) {
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

function invalidateCache() {
    recordsCache.signature = null;
    latestCache.clear();
}

function appendRecord(record) {
    const before = fs.existsSync(FILE) ? fs.statSync(FILE) : null;
    const cacheCurrent = before && recordsCache.signature === fileSignature(before);
    const line = JSON.stringify(record) + "\n";
    fs.appendFileSync(FILE, line, { mode: 0o600 });
    if (cacheCurrent) {
        const after = fs.statSync(FILE);
        if (after.size === before.size + Buffer.byteLength(line)) {
            recordsCache.records.push(record);
            recordsCache.signature = fileSignature(after);
            latestCache.clear();
            return;
        }
    }
    invalidateCache();
}

function ensureDir() {
    const dir = path.dirname(FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function add({ filePrefix, event, phone, email, channel, style, baseUrl, consentedAt, whatsappOptInAt, noticeVersion }) {
    if (!filePrefix || !event) throw new Error("filePrefix and event required");
    ensureDir();
    const record = {
        filePrefix,
        event,
        phone: phone || "",
        email: email || "",
        channel: channel || "",
        style: style || "",
        baseUrl: baseUrl || "",
        submittedAt: Date.now(),
        emailedAt: null,
        consentedAt: consentedAt || null,
        whatsappOptInAt: whatsappOptInAt || null,
        noticeVersion: noticeVersion || null,
    };
    appendRecord(record);
    return record;
}

function readAll() {
    if (!fs.existsSync(FILE)) {
        invalidateCache();
        recordsCache.records = [];
        return [];
    }
    const signature = fileSignature(fs.statSync(FILE));
    if (recordsCache.signature === signature) return recordsCache.records;
    const raw = fs.readFileSync(FILE, "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    recordsCache = { signature, records: out };
    latestCache.clear();
    return out;
}

function compactRecords(records) {
    const latest = new Map();
    for (const record of records) {
        const key = JSON.stringify([record.event, record.filePrefix]);
        if (latest.has(key)) latest.delete(key);
        latest.set(key, record);
    }
    return [...latest.values()];
}

function writeRecords(records) {
    ensureDir();
    const tmp = FILE + `.tmp.${process.pid}.${Date.now()}`;
    const body = records.length ? records.map((record) => JSON.stringify(record)).join("\n") + "\n" : "";
    try {
        fs.writeFileSync(tmp, body, { mode: 0o600 });
        fs.renameSync(tmp, FILE);
    } finally {
        try { fs.unlinkSync(tmp); } catch {}
    }
    recordsCache = { signature: fileSignature(fs.statSync(FILE)), records: records.slice() };
    latestCache.clear();
}

function replaceRecord(filePrefix, event, changes) {
    const records = compactRecords(readAll());
    const index = records.findIndex((record) => record.filePrefix === filePrefix && record.event === event);
    if (index < 0) return null;
    const updated = { ...records[index], ...changes };
    records[index] = updated;
    writeRecords(records);
    return updated;
}

// Return the latest record per event and filePrefix. Old append-only logs may
// still contain multiple versions until the next edit or deletion compacts them.
function listByEvent(eventName) {
    const records = readAll();
    const cacheKey = eventName || "\u0000all";
    if (latestCache.has(cacheKey)) return latestCache.get(cacheKey).slice();
    const latest = new Map();
    for (const r of records) {
        if (eventName && r.event !== eventName) continue;
        latest.set(`${r.event}\u0000${r.filePrefix}`, r);
    }
    const sorted = [...latest.values()].sort((a, b) => (b.submittedAt || 0) - (a.submittedAt || 0));
    latestCache.set(cacheKey, sorted);
    return sorted.slice();
}

function markEmailed(filePrefix, event) {
    return replaceRecord(filePrefix, event, { emailedAt: Date.now() });
}

function unmarkEmailed(filePrefix, event) {
    return replaceRecord(filePrefix, event, { emailedAt: null });
}

// Wipe all submissions for an event. Called from the Reset Event Data
// admin action and when a per-user delete in outreach should also clear
// their kiosk record. Because the store is JSONL append-only, we rewrite
// the file without the matching records.
function deleteByEvent(eventName) {
    if (!eventName) return 0;
    if (!fs.existsSync(FILE)) return 0;
    const records = readAll();
    const keep = records.filter((r) => r.event !== eventName);
    const removed = records.length - keep.length;
    if (removed === 0) return 0;
    writeRecords(compactRecords(keep));
    return removed;
}

// Wipe records for a specific filePrefix + event. Used when an admin
// deletes one user in outreach and we want to remove their kiosk record
// as part of the same operation.
function deleteByFilePrefix(filePrefix, eventName) {
    if (!filePrefix || !eventName) return 0;
    if (!fs.existsSync(FILE)) return 0;
    const records = readAll();
    const keep = records.filter((r) => !(r.filePrefix === filePrefix && r.event === eventName));
    const removed = records.length - keep.length;
    if (removed === 0) return 0;
    writeRecords(compactRecords(keep));
    return removed;
}

// Batched version — takes an array of {filePrefix, eventName} and rewrites
// the JSONL file once. Avoids the O(N×file_size) cliff when an admin bulk-
// deletes a user with many portraits.
function deleteBatch(targets) {
    if (!Array.isArray(targets) || targets.length === 0) return 0;
    if (!fs.existsSync(FILE)) return 0;
    const matchKeys = new Set(targets.map((t) => `${t.filePrefix}:${t.eventName}`));
    const records = readAll();
    const keep = records.filter((r) => !matchKeys.has(`${r.filePrefix}:${r.event}`));
    const removed = records.length - keep.length;
    if (removed === 0) return 0;
    writeRecords(compactRecords(keep));
    return removed;
}

// Admin edit. Empty string clears the email and removes superseded values.
function setEmail(filePrefix, event, email) {
    return replaceRecord(filePrefix, event, { email: (email || "").trim() });
}

module.exports = { add, listByEvent, markEmailed, unmarkEmailed, setEmail, deleteByEvent, deleteByFilePrefix, deleteBatch };

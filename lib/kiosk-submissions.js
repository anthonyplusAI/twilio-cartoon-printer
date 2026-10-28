// Stores contact info captured on the /kiosk page tied to a specific
// portrait's filePrefix. This is distinct from lib/leads.js (which runs a
// multi-step SMS survey keyed on phone+event) — kiosk submissions are a
// single-shot form filled in at the booth, and may have no phone, no email,
// or both. Admins use the outreach tab to see these records and manually
// follow up by email until a proper SendGrid integration is wired up.
//
// Persisted as JSONL at data/kiosk-submissions.jsonl so new records are a
// simple append (no read-modify-write races).

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
    fs.appendFileSync(FILE, line);
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

function add({ filePrefix, event, phone, email, channel, style, baseUrl }) {
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

// Return the latest record per filePrefix. JSONL is append-only, so edits
// (e.g. marking emailed) are written as new lines; the freshest one wins.
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

function findLatest(filePrefix, event) {
    const records = readAll();
    for (let i = records.length - 1; i >= 0; i--) {
        if (records[i].filePrefix === filePrefix && records[i].event === event) return records[i];
    }
    return null;
}

function markEmailed(filePrefix, event) {
    const existing = findLatest(filePrefix, event);
    if (!existing) return null;
    const updated = { ...existing, emailedAt: Date.now() };
    ensureDir();
    appendRecord(updated);
    return updated;
}

function unmarkEmailed(filePrefix, event) {
    const existing = findLatest(filePrefix, event);
    if (!existing) return null;
    const updated = { ...existing, emailedAt: null };
    ensureDir();
    appendRecord(updated);
    return updated;
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
    ensureDir();
    const tmp = FILE + `.tmp.${process.pid}.${Date.now()}`;
    const body = keep.length ? keep.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, FILE);
    invalidateCache();
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
    ensureDir();
    const tmp = FILE + `.tmp.${process.pid}.${Date.now()}`;
    const body = keep.length ? keep.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, FILE);
    invalidateCache();
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
    ensureDir();
    const tmp = FILE + `.tmp.${process.pid}.${Date.now()}`;
    const body = keep.length ? keep.map((r) => JSON.stringify(r)).join("\n") + "\n" : "";
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, FILE);
    invalidateCache();
    return removed;
}

// Admin edit. Appends a new record with the updated email; listByEvent()
// returns the freshest one per filePrefix. Empty string clears the email.
function setEmail(filePrefix, event, email) {
    const existing = findLatest(filePrefix, event);
    if (!existing) return null;
    const updated = { ...existing, email: (email || "").trim() };
    ensureDir();
    appendRecord(updated);
    return updated;
}

module.exports = { add, listByEvent, markEmailed, unmarkEmailed, setEmail, deleteByEvent, deleteByFilePrefix, deleteBatch };

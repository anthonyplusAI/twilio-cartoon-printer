const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const settings = require("./settings");

const DATA_DIR = path.join(__dirname, "..", "data");
const AUDIT_FILE = path.join(DATA_DIR, "audit-log.jsonl");
const NON_REVERTIBLE_FRAME_KEYS = new Set([
    "templateCompatibilityOverrides",
    "templateDeletionTombstones",
]);
const REDACTED = "[REDACTED]";

function isSensitiveAuditKey(key) {
    if (settings.CREDENTIAL_KEYS.has(key)) return true;
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return /(?:apikey|authtoken|accesstoken|refreshtoken|bearertoken|relaykey|reviewpin|adminpin|clientsecret|privatekey|password|passphrase)$/.test(normalized)
        || ["secret", "secrets", "token", "credential", "credentials"].includes(normalized);
}

function redactAuditValue(value, fieldName = "") {
    if (isSensitiveAuditKey(fieldName)) return REDACTED;
    if (Array.isArray(value)) return value.map((item) => redactAuditValue(item));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactAuditValue(item, key)]));
    }
    return value;
}

function presentAuditEntry(entry) {
    const safe = redactAuditValue(entry);
    if (safe.action === "settings.update") {
        safe.canRevert = !safe.reverted && Object.keys(safe.before || {}).some((key) => (
            !settings.CREDENTIAL_KEYS.has(key)
            && !NON_REVERTIBLE_FRAME_KEYS.has(key)
            && Object.prototype.hasOwnProperty.call(settings.DEFAULTS, key)
        ));
    }
    return safe;
}

function sanitizeRevertChanges(settingsApi, before) {
    const revertChanges = {};
    for (const [key, value] of Object.entries(before || {})) {
        if (!NON_REVERTIBLE_FRAME_KEYS.has(key)
            && !settings.CREDENTIAL_KEYS.has(key)
            && Object.prototype.hasOwnProperty.call(settings.DEFAULTS, key)) revertChanges[key] = value;
    }
    return settingsApi.sanitizeTemplateReferenceChanges(revertChanges);
}

function ensureAuditDirectory() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Write an audit entry ───────────────────────────────────────────────────

async function logSettingsChange(actor, eventName, before, after) {
    const entry = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        actor: actor || "unknown",
        action: "settings.update",
        eventName: eventName || "unknown",
        before,
        after,
        reverted: false,
    };
    const safe = redactAuditValue(entry);
    ensureAuditDirectory();
    await fsp.appendFile(AUDIT_FILE, JSON.stringify(safe) + "\n");
    return safe;
}

async function logRevert(actor, eventName, originalId, before, after) {
    const entry = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        actor: actor || "unknown",
        action: "settings.revert",
        eventName: eventName || "unknown",
        originalId,
        before,
        after,
        reverted: false,
    };
    const safe = redactAuditValue(entry);
    ensureAuditDirectory();
    await fsp.appendFile(AUDIT_FILE, JSON.stringify(safe) + "\n");
    return safe;
}

// Generic structured event logger for non-settings audit trails (variant
// picks, regenerations, etc). Callers pass an action name and an arbitrary
// data payload. Write errors are swallowed — audit must never break the
// reviewer hot path.
async function logEvent(action, eventName, data) {
    const entry = {
        id: crypto.randomUUID(),
        ts: Date.now(),
        action: action || "unknown",
        eventName: eventName || "unknown",
        ...(data && typeof data === "object" ? data : {}),
    };
    try {
        const safe = redactAuditValue(entry);
        ensureAuditDirectory();
        await fsp.appendFile(AUDIT_FILE, JSON.stringify(safe) + "\n");
        return safe;
    } catch (err) {
        console.error(`📝 Audit log write failed (${action}):`, err.message);
    }
    return redactAuditValue(entry);
}

// ── Read audit log ─────────────────────────────────────────────────────────

async function getAuditLog(limit = 50, offset = 0, filter = null) {
    try {
        const raw = await fsp.readFile(AUDIT_FILE, "utf8");
        const lines = raw.trim().split("\n").filter(Boolean);
        let entries = [];
        for (const line of lines) {
            try { entries.push(presentAuditEntry(JSON.parse(line))); } catch {}
        }
        // Apply action-prefix filter before pagination so "total" reflects the
        // filtered set. filter="settings" → only settings.* entries.
        if (filter) {
            entries = entries.filter((e) => typeof e.action === "string" && e.action.startsWith(filter + "."));
        }
        entries.reverse(); // newest first
        const total = entries.length;
        const page = entries.slice(offset, offset + limit);
        return { entries: page, total };
    } catch (err) {
        if (err.code === "ENOENT") return { entries: [], total: 0 };
        throw err;
    }
}

function requireAbsoluteAuditPath(filePath) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
        throw new Error("An absolute audit log path is required");
    }
}

async function prepareLegacyAuditLogMigration(filePath) {
    requireAbsoluteAuditPath(filePath);
    const raw = await fsp.readFile(filePath, "utf8");
    let redactedEntries = 0;
    let totalEntries = 0;
    const lines = raw.split("\n").map((line, index) => {
        if (!line.trim()) return line;
        let entry;
        try { entry = JSON.parse(line); } catch {
            throw new Error(`Invalid audit JSON on line ${index + 1}; file was not changed`);
        }
        totalEntries++;
        const safe = redactAuditValue(entry);
        if (JSON.stringify(safe) === JSON.stringify(entry)) return line;
        redactedEntries++;
        return JSON.stringify(safe);
    });
    return { lines, redactedEntries, totalEntries };
}

async function inspectLegacyAuditLogFile(filePath) {
    const { redactedEntries, totalEntries } = await prepareLegacyAuditLogMigration(filePath);
    return { redactedEntries, totalEntries };
}

// Explicit offline migration for old JSONL files. Do not call during normal
// startup or reads: deployments can have overlapping revisions writing to the
// same Azure Files mount. The caller must stop writers before invoking this.
async function migrateLegacyAuditLogFile(filePath) {
    const { lines, redactedEntries, totalEntries } = await prepareLegacyAuditLogMigration(filePath);
    if (redactedEntries === 0) return { redactedEntries, totalEntries };

    const stat = await fsp.stat(filePath);
    const temporaryPath = `${filePath}.redacting.${process.pid}.${crypto.randomUUID()}`;
    try {
        const handle = await fsp.open(temporaryPath, "wx", stat.mode & 0o777);
        try {
            await handle.writeFile(lines.join("\n"));
            await handle.sync();
        } finally {
            await handle.close();
        }
        await fsp.rename(temporaryPath, filePath);
    } finally {
        try { await fsp.unlink(temporaryPath); } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }
    }
    return { redactedEntries, totalEntries };
}

// ── Revert a settings change ───────────────────────────────────────────────

async function revertEntry(id, actor) {
    // Read the full log to find the entry
    const { entries } = await getAuditLog(10000, 0);
    const entry = entries.find(e => e.id === id);
    if (!entry) throw new Error("Audit entry not found");
    if (entry.action !== "settings.update") throw new Error("Only settings changes can be reverted");
    if (entry.reverted) throw new Error("Already reverted");
    if (!entry.eventName || entry.eventName === "unknown") {
        throw new Error("Audit entry has no original event, so it cannot be reverted safely");
    }
    if (entry.eventName !== settings.get("eventName")) {
        throw new Error(`Switch to event "${entry.eventName}" before reverting this change`);
    }

    // Snapshot current values for the keys being reverted
    if (!entry.before || typeof entry.before !== "object") throw new Error("Audit entry has no revertible data");
    settings.refreshTemplateStateFromDisk();
    const sanitizedChanges = sanitizeRevertChanges(settings, entry.before);
    if (Object.keys(sanitizedChanges).length === 0) {
        throw new Error("Audit entry has no revertible settings");
    }
    const currentValues = {};
    for (const key of Object.keys(sanitizedChanges)) {
        currentValues[key] = settings.get(key);
    }

    // Apply the "before" values
    settings.update(sanitizedChanges);

    // Mark the original entry as reverted by rewriting the file
    await markReverted(id);

    // Log the revert action
    await logRevert(actor, entry.eventName, id, currentValues, sanitizedChanges);

    return { success: true, reverted: sanitizedChanges };
}

// ── Mark an entry as reverted ──────────────────────────────────────────────

async function markReverted(id) {
    try {
        const raw = await fsp.readFile(AUDIT_FILE, "utf8");
        const lines = raw.trim().split("\n").filter(Boolean);
        const updated = lines.map(line => {
            try {
                const entry = JSON.parse(line);
                if (entry.id === id) {
                    entry.reverted = true;
                    return JSON.stringify(entry);
                }
                return line;
            } catch {
                return line;
            }
        });
        const tmp = AUDIT_FILE + `.tmp.${process.pid}.${Date.now()}`;
        await fsp.writeFile(tmp, updated.join("\n") + "\n");
        await fsp.rename(tmp, AUDIT_FILE);
    } catch (err) {
        console.error("📝 Failed to mark audit entry as reverted:", err.message);
    }
}

module.exports = { logSettingsChange, logRevert, logEvent, getAuditLog, revertEntry, sanitizeRevertChanges, inspectLegacyAuditLogFile, migrateLegacyAuditLogFile };

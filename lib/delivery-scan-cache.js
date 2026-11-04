const path = require("path");
const { DONE_DIR, FAILED_DIR } = require("./config");

// Azure Files charges for opening a job JSON even when the job is already
// settled. Keep periodic directory discovery, but avoid reopening unchanged
// history on every maintenance pass. The hourly rescan also catches edits
// made outside this process; normal in-process writes invalidate immediately.
const QUIET_RESCAN_MS = 60 * 60 * 1000;
const files = new Map();
const terminalWrites = new Map();

function isTerminalJob(filepath) {
    return filepath.endsWith(".json") && (path.dirname(filepath) === DONE_DIR || path.dirname(filepath) === FAILED_DIR);
}

function beginRead(filepath, sweep) {
    let entry = files.get(filepath);
    if (!entry) {
        entry = { quietUntil: Object.create(null) };
        files.set(filepath, entry);
    }
    if (entry.quietUntil[sweep] > Date.now()) return null;
    return entry;
}

function markQuiet(filepath, sweep, entry) {
    // A writer may replace or move the file while an older read is pending.
    // Invalidation removes that entry, so its stale read cannot cache quiet.
    if (files.get(filepath) !== entry) return;
    const now = Date.now();
    const lastWriteAt = terminalWrites.get(filepath);
    if (lastWriteAt !== undefined && now - lastWriteAt < QUIET_RESCAN_MS) return;
    if (lastWriteAt !== undefined) terminalWrites.delete(filepath);
    entry.quietUntil[sweep] = now + QUIET_RESCAN_MS;
}

function invalidate(filepath) {
    files.delete(filepath);
    if (isTerminalJob(filepath)) terminalWrites.set(filepath, Date.now());
}

function invalidateMove(source, destination) {
    invalidate(source);
    invalidate(destination);
}

function pruneDirectory(dir, filenames) {
    const present = new Set(filenames);
    for (const filepath of files.keys()) {
        if (path.dirname(filepath) === dir && !present.has(path.basename(filepath))) files.delete(filepath);
    }
    const expiredBefore = Date.now() - QUIET_RESCAN_MS;
    for (const [filepath, changedAt] of terminalWrites) {
        if (changedAt <= expiredBefore) terminalWrites.delete(filepath);
    }
}

module.exports = { beginRead, markQuiet, invalidate, invalidateMove, pruneDirectory };

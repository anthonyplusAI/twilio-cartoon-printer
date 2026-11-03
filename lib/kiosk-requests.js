// Durable idempotency record for a kiosk capture. A browser can retry with the
// same requestId after a lost HTTP response without creating another portrait.

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { DATA_DIR } = require("./config");
const { atomicWriteFile } = require("./atomic-write");

const DEFAULT_DIR = path.join(DATA_DIR, "kiosk-requests");
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STALE_PENDING_MS = 2 * 60 * 1000;

function requestPath(requestId, dir = DEFAULT_DIR) {
    if (!REQUEST_ID_RE.test(String(requestId || ""))) {
        throw Object.assign(new Error("Valid requestId is required"), { status: 400, code: "REQUEST_ID_INVALID" });
    }
    return path.join(dir, `${requestId.toLowerCase()}.json`);
}

async function readRecord(filePath) {
    try { return JSON.parse(await fsp.readFile(filePath, "utf8")); }
    catch (error) {
        if (error.code === "ENOENT") return null;
        if (!(error instanceof SyntaxError)) throw error;
        // A crash can leave the exclusive-create record half written. Its
        // filesystem age, rather than the time of each read, determines when
        // a retry may safely reclaim it.
        const stat = await fsp.stat(filePath).catch((statError) => {
            if (statError.code === "ENOENT") return null;
            throw statError;
        });
        return stat ? { state: "processing", createdAt: stat.mtimeMs } : null;
    }
}

async function claim({ requestId, digest, eventName, dir = DEFAULT_DIR, lookupJob = async () => null }) {
    const filePath = requestPath(requestId, dir);
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const handle = await fsp.open(filePath, "wx", 0o600);
            try {
                await handle.writeFile(JSON.stringify({ requestId, digest, eventName, state: "processing", createdAt: Date.now() }));
            } catch (error) {
                await fsp.unlink(filePath).catch(() => {});
                throw error;
            } finally {
                await handle.close();
            }
            return { kind: "new" };
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
        }
        const record = await readRecord(filePath);
        if (!record) continue;
        if (record.digest && (record.digest !== digest || record.eventName !== eventName)) {
            throw Object.assign(new Error("Request ID belongs to a different submission"), {
                status: 409, code: "REQUEST_ID_CONFLICT",
            });
        }
        if (record.filePrefix) return { kind: "existing", filePrefix: record.filePrefix };
        const recoveredPrefix = await lookupJob(requestId, eventName);
        if (recoveredPrefix) {
            await complete({ requestId, digest, eventName, dir }, recoveredPrefix);
            return { kind: "existing", filePrefix: recoveredPrefix };
        }
        if (Date.now() - (record.createdAt || 0) < STALE_PENDING_MS) return { kind: "in_progress" };
        await fsp.unlink(filePath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
    return { kind: "in_progress" };
}

async function complete({ requestId, digest, eventName, dir = DEFAULT_DIR }, filePrefix) {
    const filePath = requestPath(requestId, dir);
    await atomicWriteFile(filePath, JSON.stringify({
        requestId, digest, eventName, state: "accepted", filePrefix, createdAt: Date.now(),
    }));
}

async function release({ requestId, digest, dir = DEFAULT_DIR }) {
    const filePath = requestPath(requestId, dir);
    const record = await readRecord(filePath);
    if (record && record.state === "processing" && record.digest === digest) {
        await fsp.unlink(filePath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    }
}

async function deleteByEvent(eventName, dir = DEFAULT_DIR) {
    const filenames = await fsp.readdir(dir).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    let deleted = 0;
    for (const filename of filenames) {
        if (!REQUEST_ID_RE.test(filename.replace(/\.json$/, "")) || !filename.endsWith(".json")) continue;
        const filePath = path.join(dir, filename);
        const record = await readRecord(filePath);
        if (record?.eventName !== eventName) continue;
        try {
            await fsp.unlink(filePath);
            deleted++;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
    }
    return deleted;
}

module.exports = { requestPath, claim, complete, release, deleteByEvent };

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const sharp = require("sharp");

const settings = require("../lib/settings");
const kioskRequests = require("../lib/kiosk-requests");
const queue = require("../lib/queue");
const { PENDING_DIR } = require("../lib/config");
const { makeKioskSessionToken } = require("../lib/auth");
const { mountApiGenerate } = require("../lib/api-generate");

test("a kiosk retry waits for every queued variant and returns the first prefix", async () => {
    const eventName = `KioskRetry-${crypto.randomBytes(6).toString("hex")}`;
    const requestId = crypto.randomUUID();
    const parentJobId = `20261103_123456_${crypto.randomBytes(16).toString("hex")}`;
    const prefixes = [1, 2, 3].map((index) => `${parentJobId}-v${index}`);
    const email = "guest@example.com";
    const image = await sharp({ create: { width: 24, height: 24, channels: 3, background: "white" } })
        .jpeg().toBuffer();
    const digest = crypto.createHash("sha256")
        .update(image)
        .update(JSON.stringify([eventName, "cartoon", "", "", "email", "", email, "en", "1", ""]))
        .digest("hex");
    const claimInput = { requestId, digest, eventName, lookupJob: async () => null };
    const originalGet = settings.get;
    let server;

    function writeVariant(index) {
        const filePrefix = prefixes[index - 1];
        const job = {
            filePrefix, parentJobId, variantId: filePrefix, variantIndex: index, variantCount: 3,
            requestId, eventName, kioskSubmission: true, channel: "email", kioskEmail: email,
        };
        fs.mkdirSync(PENDING_DIR, { recursive: true });
        fs.writeFileSync(path.join(PENDING_DIR, `${filePrefix}.json`), JSON.stringify(job));
    }

    async function retry() {
        const form = new FormData();
        form.append("image", new Blob([image], { type: "image/jpeg" }), "selfie.jpg");
        for (const [key, value] of Object.entries({
            event: eventName, kiosk: "1", requestId, consent: "1",
            style: "cartoon", channel: "email", email, locale: "en",
        })) form.append(key, value);
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/generate`, {
            method: "POST", body: form,
            headers: { Cookie: `kiosk_session=${makeKioskSessionToken(eventName)}` },
            signal: AbortSignal.timeout(12000),
        });
        return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json() };
    }

    try {
        settings.get = (key, ...args) => key === "eventName" ? eventName : originalGet.call(settings, key, ...args);
        assert.deepEqual(await kioskRequests.claim(claimInput), { kind: "new" });
        // A crash after v2 was published is enough for lookupJob to find the
        // request, but must not make its incomplete group look accepted.
        writeVariant(2);
        const app = express();
        mountApiGenerate(app);
        server = await new Promise((resolve, reject) => {
            const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
            listening.on("error", reject);
        });

        const incomplete = await retry();
        assert.equal(incomplete.status, 409);
        assert.equal(incomplete.body.code, "REQUEST_IN_PROGRESS");
        assert.equal(incomplete.retryAfter, "2");

        writeVariant(1);
        writeVariant(3);
        const complete = await retry();
        assert.equal(complete.status, 202);
        assert.equal(complete.body.filePrefix, prefixes[0]);
        assert.equal(complete.body.state, "pending");

        // An older accepted claim might hold the picked sibling instead of
        // the public v1 prefix. Retry repairs it to the stable first prefix.
        await kioskRequests.complete(claimInput, prefixes[1]);
        const canonical = await retry();
        assert.equal(canonical.status, 202);
        assert.equal(canonical.body.filePrefix, prefixes[0]);
        const stored = JSON.parse(fs.readFileSync(kioskRequests.requestPath(requestId), "utf8"));
        assert.equal(stored.filePrefix, prefixes[0]);
    } finally {
        if (server) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
        settings.get = originalGet;
        for (const prefix of prefixes) fs.rmSync(path.join(PENDING_DIR, `${prefix}.json`), { force: true });
        fs.rmSync(kioskRequests.requestPath(requestId), { force: true });
    }
});

test("a recovered kiosk group cannot bind a different photo when its claim was lost", async () => {
    const eventName = `KioskDigest-${crypto.randomBytes(6).toString("hex")}`;
    const requestId = crypto.randomUUID();
    const originalGet = settings.get;
    const originalEnsure = queue.ensureKioskGroupPublished;
    const image = await sharp({ create: { width: 24, height: 24, channels: 3, background: "blue" } })
        .jpeg().toBuffer();
    let server;
    try {
        settings.get = (key, ...args) => key === "eventName" ? eventName : originalGet.call(settings, key, ...args);
        queue.ensureKioskGroupPublished = async () => ({
            filePrefix: "20261103_123457_abcdef-v1", complete: true, digest: "0".repeat(64),
        });
        const app = express();
        mountApiGenerate(app);
        server = await new Promise((resolve, reject) => {
            const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
            listening.on("error", reject);
        });
        const form = new FormData();
        form.append("image", new Blob([image], { type: "image/jpeg" }), "selfie.jpg");
        for (const [key, value] of Object.entries({
            event: eventName, kiosk: "1", requestId, consent: "1",
            style: "cartoon", channel: "email", email: "guest@example.com", locale: "en",
        })) form.append(key, value);
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/generate`, {
            method: "POST", body: form,
            headers: { Cookie: `kiosk_session=${makeKioskSessionToken(eventName)}` },
            signal: AbortSignal.timeout(12000),
        });
        assert.equal(response.status, 409);
        assert.equal((await response.json()).code, "REQUEST_ID_CONFLICT");
        assert.equal(fs.existsSync(kioskRequests.requestPath(requestId)), false,
            "a mismatched retry must not take over the old request ID");
    } finally {
        if (server) {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
        settings.get = originalGet;
        if (originalEnsure === undefined) delete queue.ensureKioskGroupPublished;
        else queue.ensureKioskGroupPublished = originalEnsure;
        fs.rmSync(kioskRequests.requestPath(requestId), { force: true });
    }
});

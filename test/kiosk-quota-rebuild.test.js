const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const { DATA_DIR, PENDING_DIR, GENERATING_DIR } = require("../lib/config");
const settings = require("../lib/settings");
const queue = require("../lib/queue");
const kioskRequests = require("../lib/kiosk-requests");
const kioskSubmissions = require("../lib/kiosk-submissions");
const { makeKioskSessionToken } = require("../lib/auth");
const { mountApiGenerate } = require("../lib/api-generate");

test("kiosk quota stays enforced when a cache rebuild overlaps admission", async () => {
    const eventName = `KioskQuotaRebuild-${crypto.randomBytes(6).toString("hex")}`;
    const email = `rebuild-${crypto.randomBytes(6).toString("hex")}@example.com`;
    const requestIds = [crypto.randomUUID(), crypto.randomUUID()];
    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-quota-rebuild-"));
    const fsp = fs.promises;
    const original = {
        get: settings.get,
        getForEvent: settings.getForEvent,
        getActiveStyleList: settings.getActiveStyleList,
        getActiveStyles: settings.getActiveStyles,
        getDownloadDir: settings.getDownloadDir,
        getOutputProfile: settings.getOutputProfile,
        addSubmission: kioskSubmissions.add,
        readdir: fsp.readdir,
        baseUrl: process.env.BASE_URL,
        sendgridKey: process.env.SENDGRID_API_KEY,
        sendgridFrom: process.env.SENDGRID_FROM_EMAIL,
    };
    const responses = [];
    let server;
    let releaseRebuild;
    let gateReached;
    const rebuildGate = new Promise(resolve => { releaseRebuild = resolve; });
    const enteredGate = new Promise(resolve => { gateReached = resolve; });
    let gated = false;

    settings.get = (key, ...args) => ({
        eventName, adminPhones: [], customBrands: {}, disabledBrands: [],
        enableBrandMenu: false, enableBackgroundMenu: false, offerUnbranded: true,
        backgroundChoices: [],
    })[key] ?? original.get.call(settings, key, ...args);
    settings.getForEvent = (key) => ({
        languageMode: "en", boothShowEmail: true, reviewMode: "off",
        variantsPerReview: 1, maxPrints: 1, enablePrinting: false,
    })[key] ?? original.getForEvent.call(settings, key, eventName);
    settings.getActiveStyleList = () => ["cartoon"];
    settings.getActiveStyles = () => ({ cartoon: { name: "Cartoon", prompt: "Cartoon prompt" } });
    settings.getDownloadDir = () => downloadDir;
    settings.getOutputProfile = () => ({ printSize: "6x4", printQuality: "high", orientation: "landscape" });
    kioskSubmissions.add = (record) => record;
    process.env.BASE_URL = "https://booth.example.test";
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "booth@example.com";

    // The rebuild has already snapshotted PENDING when it reaches GENERATING.
    // Pause there so the first accepted job can overlap the stale snapshot.
    fsp.readdir = async function(dir, options) {
        const entries = await original.readdir.call(fsp, dir, options);
        if (dir === GENERATING_DIR && !gated) {
            gated = true;
            gateReached();
            await rebuildGate;
        }
        return entries;
    };

    try {
        const app = express();
        mountApiGenerate(app);
        server = await new Promise((resolve, reject) => {
            const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
            listening.on("error", reject);
        });
        const image = await sharp({ create: { width: 24, height: 24, channels: 3, background: "white" } })
            .jpeg().toBuffer();
        const cookie = `kiosk_session=${makeKioskSessionToken(eventName)}`;
        const submit = async (requestId) => {
            const form = new FormData();
            form.append("image", new Blob([image], { type: "image/jpeg" }), "selfie.jpg");
            for (const [key, value] of Object.entries({
                event: eventName, kiosk: "1", requestId, consent: "1",
                style: "cartoon", channel: "email", email, locale: "en",
            })) form.append(key, value);
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/generate`, {
                method: "POST", body: form, headers: { Cookie: cookie }, signal: AbortSignal.timeout(15000),
            });
            const result = { requestId, status: response.status, body: await response.json() };
            responses.push(result);
            return result;
        };

        const rebuild = queue.buildUsageCache();
        await enteredGate;
        const firstRequest = submit(requestIds[0]);
        // Before the fix, the request completes while the rebuild is paused;
        // after the fix, admission waits for the rebuild to finish.
        let timer;
        try {
            await Promise.race([
                firstRequest,
                new Promise(resolve => { timer = setTimeout(resolve, 2500); }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
            releaseRebuild();
        }
        await rebuild;
        const first = await firstRequest;
        assert.equal(first.status, 202);
        const second = await submit(requestIds[1]);
        assert.equal(second.status, 429,
            "a late cache swap must not erase the first kiosk admission");
        assert.equal(second.body.code, "QUOTA_REACHED");
    } finally {
        releaseRebuild();
        fsp.readdir = original.readdir;
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        settings.get = original.get;
        settings.getForEvent = original.getForEvent;
        settings.getActiveStyleList = original.getActiveStyleList;
        settings.getActiveStyles = original.getActiveStyles;
        settings.getDownloadDir = original.getDownloadDir;
        settings.getOutputProfile = original.getOutputProfile;
        kioskSubmissions.add = original.addSubmission;
        if (original.baseUrl === undefined) delete process.env.BASE_URL;
        else process.env.BASE_URL = original.baseUrl;
        if (original.sendgridKey === undefined) delete process.env.SENDGRID_API_KEY;
        else process.env.SENDGRID_API_KEY = original.sendgridKey;
        if (original.sendgridFrom === undefined) delete process.env.SENDGRID_FROM_EMAIL;
        else process.env.SENDGRID_FROM_EMAIL = original.sendgridFrom;
        for (const { body } of responses) {
            if (body.filePrefix) fs.rmSync(path.join(PENDING_DIR, `${body.filePrefix}.json`), { force: true });
        }
        for (const requestId of requestIds) {
            fs.rmSync(kioskRequests.requestPath(requestId), { force: true });
            fs.rmSync(path.join(DATA_DIR, "kiosk-uploads", `${requestId}.jpg`), { force: true });
        }
        fs.rmSync(downloadDir, { recursive: true, force: true });
    }
});

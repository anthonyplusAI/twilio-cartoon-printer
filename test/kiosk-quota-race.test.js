const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const { DATA_DIR, PENDING_DIR } = require("../lib/config");
const settings = require("../lib/settings");
const kioskRequests = require("../lib/kiosk-requests");
const kioskSubmissions = require("../lib/kiosk-submissions");
const { makeKioskSessionToken } = require("../lib/auth");
const { mountApiGenerate } = require("../lib/api-generate");

test("simultaneous kiosk submissions cannot use the same final quota slot", async () => {
    const eventName = `KioskQuotaRace-${crypto.randomBytes(6).toString("hex")}`;
    const email = `race-${crypto.randomBytes(6).toString("hex")}@example.com`;
    const requestIds = [crypto.randomUUID(), crypto.randomUUID()];
    const uploadDir = path.join(DATA_DIR, "kiosk-uploads");
    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-quota-race-"));
    const fsp = fs.promises;
    const original = {
        get: settings.get,
        getForEvent: settings.getForEvent,
        getActiveStyleList: settings.getActiveStyleList,
        getActiveStyles: settings.getActiveStyles,
        getDownloadDir: settings.getDownloadDir,
        getOutputProfile: settings.getOutputProfile,
        addSubmission: kioskSubmissions.add,
        mkdir: fsp.mkdir,
        baseUrl: process.env.BASE_URL,
        sendgridKey: process.env.SENDGRID_API_KEY,
        sendgridFrom: process.env.SENDGRID_FROM_EMAIL,
    };
    let server;
    let gateTimer;
    let reachedUploadStage = 0;
    let releaseUploadStage;
    const uploadStageGate = new Promise(resolve => { releaseUploadStage = resolve; });
    const responses = [];

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

    // Hold both requests after the first quota check and before image staging.
    // This makes the one-remaining-slot race deterministic while leaving the
    // real HTTP handler, image conversion, and queue enqueue in place.
    fsp.mkdir = async function (dir, options) {
        if (dir === uploadDir) {
            reachedUploadStage++;
            if (reachedUploadStage === 1) gateTimer = setTimeout(releaseUploadStage, 5000);
            if (reachedUploadStage === 2) {
                clearTimeout(gateTimer);
                releaseUploadStage();
            }
            await uploadStageGate;
        }
        return original.mkdir.call(fsp, dir, options);
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
                method: "POST", body: form, headers: { Cookie: cookie }, signal: AbortSignal.timeout(12000),
            });
            const result = { requestId, status: response.status, body: await response.json() };
            responses.push(result);
            return result;
        };

        const results = await Promise.all(requestIds.map(submit));
        assert.equal(reachedUploadStage, 2, "both requests must pass the early quota check before either enqueues");
        assert.deepEqual(results.map(result => result.status).sort(), [202, 429]);
        assert.equal(results.find(result => result.status === 429).body.code, "QUOTA_REACHED");
        assert.equal(fs.existsSync(kioskRequests.requestPath(results.find(result => result.status === 429).requestId)), false,
            "the rejected request ID must be reusable");
        for (const requestId of requestIds) {
            assert.equal(fs.existsSync(path.join(uploadDir, `${requestId}.jpg`)), false,
                "no private kiosk upload should remain after acceptance or quota rejection");
        }
    } finally {
        if (gateTimer) clearTimeout(gateTimer);
        releaseUploadStage();
        fsp.mkdir = original.mkdir;
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
            fs.rmSync(path.join(uploadDir, `${requestId}.jpg`), { force: true });
        }
        fs.rmSync(downloadDir, { recursive: true, force: true });
    }
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");

const { PENDING_DIR } = require("../lib/config");
const settings = require("../lib/settings");
const kioskRequests = require("../lib/kiosk-requests");
const kioskSubmissions = require("../lib/kiosk-submissions");
const { makeKioskSessionToken } = require("../lib/auth");
const { mountApiGenerate } = require("../lib/api-generate");
const { getKioskDeliveryChannels, resolveKioskDeliveryChannel } = require("../lib/kiosk-delivery");

function dependencies({ sms = true, whatsapp = true, email = true, showSms = true,
    showWhatsapp = true, showEmail = true, deliverySid = "HXdelivery", emailPaused = false } = {}) {
    const eventSettings = { boothShowSms: showSms, boothShowWhatsapp: showWhatsapp, boothShowEmail: showEmail };
    return {
        settingsModule: {
            getForEvent: (key) => eventSettings[key],
            getContentSid: (key) => key === "delivery" ? deliverySid : null,
        },
        adapters: {
            sms: { isConfigured: () => sms },
            whatsapp: { isConfigured: () => whatsapp },
        },
        emailProvider: { isConfigured: () => email },
        env: { KIOSK_EMAIL_PAUSED: emailPaused ? "true" : "false" },
    };
}

test("kiosk offers only event-enabled, configured delivery methods", () => {
    assert.deepEqual(getKioskDeliveryChannels("Event", "en", dependencies()), ["sms", "whatsapp", "email"]);
    assert.deepEqual(getKioskDeliveryChannels("Event", "en", dependencies({ deliverySid: "" })), ["sms", "email"]);
    assert.deepEqual(getKioskDeliveryChannels("Event", "en", dependencies({ showEmail: false })), ["sms", "whatsapp"]);
    assert.deepEqual(getKioskDeliveryChannels("Event", "en", dependencies({ sms: false, whatsapp: false })), ["email"]);
});

test("global kiosk email pause hides email and rejects an already-open email form", () => {
    const paused = dependencies({ emailPaused: true });
    assert.deepEqual(getKioskDeliveryChannels("Event", "en", paused), ["sms", "whatsapp"]);
    assert.throws(() => resolveKioskDeliveryChannel({
        requestedChannel: "email", hasEmail: true, kioskSubmission: true,
        eventName: "Event", locale: "en",
    }, paused), (error) => error.code === "CHANNEL_UNAVAILABLE");
    assert.deepEqual(getKioskDeliveryChannels("Event", "en", dependencies()), ["sms", "whatsapp", "email"]);
});

test("kiosk requires one matching destination and an explicit channel", () => {
    const base = { eventName: "Event", locale: "en", kioskSubmission: true };
    assert.throws(() => resolveKioskDeliveryChannel({ ...base, hasPhone: true, requestedChannel: "" }, dependencies()),
        (error) => error.code === "CHANNEL_REQUIRED");
    assert.throws(() => resolveKioskDeliveryChannel({ ...base, hasPhone: true, hasEmail: true, requestedChannel: "email" }, dependencies()),
        (error) => error.code === "DESTINATION_INVALID");
    assert.throws(() => resolveKioskDeliveryChannel({ ...base, hasEmail: true, requestedChannel: "sms" }, dependencies()),
        (error) => error.code === "DESTINATION_INVALID");
    assert.equal(resolveKioskDeliveryChannel({ ...base, hasEmail: true, requestedChannel: "email" }, dependencies()), "email");
    assert.equal(resolveKioskDeliveryChannel({ ...base, hasPhone: true, requestedChannel: "whatsapp" }, dependencies()), "whatsapp");
    assert.throws(() => resolveKioskDeliveryChannel({ ...base, hasPhone: true, requestedChannel: "whatsapp" },
        dependencies({ deliverySid: "" })), (error) => error.code === "CHANNEL_UNAVAILABLE");
});

test("programmatic generate keeps its existing SMS default", () => {
    assert.equal(resolveKioskDeliveryChannel({ kioskSubmission: false, hasPhone: true, eventName: "Event", locale: "en" },
        dependencies()), "sms");
    assert.equal(resolveKioskDeliveryChannel({ kioskSubmission: false, hasPhone: false, eventName: "Event", locale: "en" },
        dependencies()), null);
});

test("kiosk POST stages privately, queues selected delivery, and deduplicates retries", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-api-"));
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    const submissions = [];
    const prefixes = [];
    const requestIds = [];
    const original = {
        get: settings.get, getForEvent: settings.getForEvent, getContentSid: settings.getContentSid,
        getActiveStyleList: settings.getActiveStyleList, getActiveStyles: settings.getActiveStyles,
        getDownloadDir: settings.getDownloadDir, getOutputProfile: settings.getOutputProfile,
        add: kioskSubmissions.add,
        baseUrl: process.env.BASE_URL,
        sendgridKey: process.env.SENDGRID_API_KEY,
        sendgridFrom: process.env.SENDGRID_FROM_EMAIL,
    };
    let server;
    settings.get = (key, ...args) => ({
        eventName: "KioskEvent", adminPhones: [], twilioWhatsappNumber: "+14155550100",
        twilioPhoneNumber: "+14155550200", customBrands: {}, disabledBrands: [],
        enableBrandMenu: false, enableBackgroundMenu: false, offerUnbranded: true,
        backgroundChoices: [],
    })[key] ?? original.get.call(settings, key, ...args);
    settings.getForEvent = (key) => ({
        languageMode: "en", boothShowSms: true, boothShowWhatsapp: true, boothShowEmail: true,
        enablePrinting: true, immediateDigitalDelivery: false, reviewMode: "off",
        enableManualReview: false, variantsPerReview: 1, maxPrints: 1,
    })[key] ?? original.getForEvent.call(settings, key, "KioskEvent");
    settings.getContentSid = (key) => key === "delivery" ? "HXdelivery" : null;
    settings.getActiveStyleList = () => ["cartoon"];
    settings.getActiveStyles = () => ({ cartoon: { name: "Cartoon", prompt: "Cartoon prompt" } });
    settings.getDownloadDir = () => tempDir;
    settings.getOutputProfile = () => ({ printSize: "6x4", printQuality: "high", orientation: "landscape" });
    kioskSubmissions.add = (record) => { submissions.push(record); return record; };
    process.env.SENDGRID_API_KEY = "SG.test";
    process.env.SENDGRID_FROM_EMAIL = "booth@example.com";
    process.env.BASE_URL = "https://booth.example.test/";

    try {
        const app = express();
        mountApiGenerate(app);
        server = await new Promise((resolve, reject) => {
            const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
            listening.on("error", reject);
        });
        const image = await sharp({ create: { width: 24, height: 24, channels: 3, background: "white" } })
            .jpeg().toBuffer();
        const kioskCookie = `kiosk_session=${makeKioskSessionToken("KioskEvent")}`;
        const submit = async (fields) => {
            const form = new FormData();
            form.append("image", new Blob([image], { type: "image/jpeg" }), "selfie.jpg");
            for (const [key, value] of Object.entries(fields)) form.append(key, value);
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/generate`, {
                method: "POST", body: form, headers: { Cookie: kioskCookie },
            });
            return { status: response.status, body: await response.json() };
        };
        const phone = "+14155559987";
        const firstId = crypto.randomUUID();
        requestIds.push(firstId);
        const whatsapp = {
            event: "KioskEvent", kiosk: "1", requestId: firstId, consent: "1", whatsappOptIn: "1",
            style: "cartoon", channel: "whatsapp", phone, locale: "en",
        };
        const first = await submit(whatsapp);
        assert.equal(first.status, 202, JSON.stringify(first.body));
        prefixes.push(first.body.filePrefix);
        assert.match(first.body.filePrefix, /^\d{8}_\d{6}_[a-f0-9]+$/);
        const job = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, `${first.body.filePrefix}.json`), "utf8"));
        assert.equal(job.channel, "whatsapp");
        assert.equal(job.baseUrl, "https://booth.example.test");
        assert.equal(job.userPhone, phone);
        assert.equal(job.kioskSubmission, true);
        assert.notEqual(job.kioskOriginalPublic, true);
        assert.equal(job.imageUrl, "");
        assert.equal(job.kioskEventSnapshot.eventSettings.immediateDigitalDelivery, true);
        assert.equal(job.kioskEventSnapshot.eventSettings.enablePrinting, true);
        assert.equal(fs.existsSync(path.join(tempDir, ".staging", `${first.body.filePrefix}_input.jpg`)), true);
        assert.equal(fs.existsSync(path.join(tempDir, `${first.body.filePrefix}_input.jpg`)), false);
        assert.equal(fs.existsSync(path.join(__dirname, "..", "data", "kiosk-uploads", `${firstId}.jpg`)), false);
        assert.equal(submissions[0].whatsappOptInAt > 0, true);

        const repeated = await submit(whatsapp);
        assert.equal(repeated.status, 202);
        assert.equal(repeated.body.filePrefix, first.body.filePrefix);
        assert.equal(submissions.length, 1);
        const quotaId = crypto.randomUUID();
        requestIds.push(quotaId);
        const quota = await submit({ ...whatsapp, requestId: quotaId });
        assert.equal(quota.status, 429);
        assert.equal(quota.body.code, "QUOTA_REACHED");

        const emailId = crypto.randomUUID();
        requestIds.push(emailId);
        const emailed = await submit({
            event: "KioskEvent", kiosk: "1", requestId: emailId, consent: "2",
            style: "cartoon", channel: "email", email: "guest@example.com", locale: "en",
        });
        assert.equal(emailed.status, 202, JSON.stringify(emailed.body));
        prefixes.push(emailed.body.filePrefix);
        const emailJob = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, `${emailed.body.filePrefix}.json`), "utf8"));
        assert.equal(emailJob.kioskOriginalPublic, true);
        assert.equal(emailJob.kioskEmail, "guest@example.com");
        assert.notEqual(emailJob.noDelivery, true);
        assert.equal(emailJob.channel, "email");
        assert.match(emailJob.userPhone, /^api:email:[a-f0-9]{64}$/);
        const emailQuotaId = crypto.randomUUID();
        requestIds.push(emailQuotaId);
        const emailQuota = await submit({
            event: "KioskEvent", kiosk: "1", requestId: emailQuotaId, consent: "1",
            style: "cartoon", channel: "email", email: "GUEST@example.com", locale: "en",
        });
        assert.equal(emailQuota.status, 429);
        assert.equal(emailQuota.body.code, "QUOTA_REACHED");

        const missingOptInId = crypto.randomUUID();
        requestIds.push(missingOptInId);
        const missingOptIn = await submit({ ...whatsapp, requestId: missingOptInId, whatsappOptIn: "0", phone: "+14155559988" });
        assert.equal(missingOptIn.status, 400);
        assert.equal(missingOptIn.body.code, "WHATSAPP_OPT_IN_REQUIRED");
        const changed = await submit({ ...whatsapp, requestId: crypto.randomUUID(), event: "OtherEvent" });
        assert.equal(changed.status, 409);
        assert.equal(changed.body.code, "EVENT_CHANGED");

        const unauthorizedForm = new FormData();
        unauthorizedForm.append("image", new Blob([image], { type: "image/jpeg" }), "selfie.jpg");
        unauthorizedForm.append("kiosk", "1");
        const unauthorized = await fetch(`http://127.0.0.1:${server.address().port}/api/generate`, {
            method: "POST", body: unauthorizedForm,
        });
        assert.equal(unauthorized.status, 401);
        assert.equal((await unauthorized.json()).code, "KIOSK_SESSION_EXPIRED");
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        settings.get = original.get;
        settings.getForEvent = original.getForEvent;
        settings.getContentSid = original.getContentSid;
        settings.getActiveStyleList = original.getActiveStyleList;
        settings.getActiveStyles = original.getActiveStyles;
        settings.getDownloadDir = original.getDownloadDir;
        settings.getOutputProfile = original.getOutputProfile;
        kioskSubmissions.add = original.add;
        if (original.baseUrl === undefined) delete process.env.BASE_URL;
        else process.env.BASE_URL = original.baseUrl;
        if (original.sendgridKey === undefined) delete process.env.SENDGRID_API_KEY;
        else process.env.SENDGRID_API_KEY = original.sendgridKey;
        if (original.sendgridFrom === undefined) delete process.env.SENDGRID_FROM_EMAIL;
        else process.env.SENDGRID_FROM_EMAIL = original.sendgridFrom;
        for (const prefix of prefixes) fs.rmSync(path.join(PENDING_DIR, `${prefix}.json`), { force: true });
        for (const id of requestIds) fs.rmSync(kioskRequests.requestPath(id), { force: true });
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

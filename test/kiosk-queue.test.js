const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const settings = require("../lib/settings");
const messaging = require("../lib/messaging");
const channelRegistry = require("../lib/channels");
const kioskEmail = require("../lib/kiosk-email");
const { PENDING_DIR, DONE_DIR, READY_DIR, REVIEW_DIR, PRINTING_DIR, FAILED_DIR } = require("../lib/config");
const { mountPrintRelay } = require("../lib/print-relay");
const {
    buildUsageCache, getUsageCount, enqueueJob, approveJob, pickVariant, rejectParent, processSinglePrint,
    sendPrintCompletionMms, sweepKioskDeliveries, setKioskDeliveryReady,
    finishPendingRelayEffects,
    updateKioskDeliveryFromProvider, updateKioskEmailFromProvider,
    resolveKioskResultPrefix, __sendDigitalDeliveryForTest,
} = require("../lib/queue");
const { jobPaths, moveStagedToFinal, aiReviewImage } = require("../lib/pipeline");

test("kiosk AI review checks stay frozen when event settings change", async () => {
    const original = settings.getForEvent;
    settings.getForEvent = (key, ...args) => key === "aiReviewChecks"
        ? { identity: true } : original.call(settings, key, ...args);
    try {
        const result = await aiReviewImage({
            kioskSubmission: true, eventName: "Frozen Review Event",
            kioskEventSnapshot: { eventSettings: { aiReviewChecks: { identity: false } } },
        });
        assert.equal(result.passed, true);
        assert.match(result.reason, /all checks disabled/);
    } finally {
        settings.getForEvent = original;
    }
});

test("usage rebuild counts one kiosk submission across variants and reanalysis", async () => {
    const eventName = `__kiosk_usage_${process.pid}__`;
    const emailUser = `api:email:${"a".repeat(64)}`;
    const phoneUser = "+14155550199";
    const emailRequest = "11111111-1111-4111-8111-111111111111";
    const nextEmailRequest = "22222222-2222-4222-8222-222222222222";
    const phoneRequest = "33333333-3333-4333-8333-333333333333";
    const prefix = `kiosk_usage_${process.pid}`;
    const files = [];
    const put = (dir, suffix, fields) => {
        fs.mkdirSync(dir, { recursive: true });
        const filePrefix = `${prefix}_${suffix}`;
        const filePath = path.join(dir, `${filePrefix}.json`);
        fs.writeFileSync(filePath, JSON.stringify({ filePrefix, eventName, kioskSubmission: true, ...fields }));
        files.push(filePath);
    };
    put(FAILED_DIR, "email_old_v1", {
        userPhone: emailUser, channel: "email", requestId: emailRequest,
        parentJobId: `${prefix}_email_old`, failReason: "reanalyzed",
    });
    put(FAILED_DIR, "email_old_v2", {
        userPhone: emailUser, channel: "email", requestId: emailRequest,
        parentJobId: `${prefix}_email_old`, failReason: "reanalyzed",
    });
    for (const [dir, suffix] of [[PENDING_DIR, "email_new_v1"], [REVIEW_DIR, "email_new_v2"]]) {
        put(dir, suffix, {
            userPhone: emailUser, channel: "email", requestId: emailRequest,
            parentJobId: `${prefix}_email_new`, reanalyzedFrom: `${prefix}_email_old`,
        });
    }
    put(DONE_DIR, "email_second_portrait", {
        userPhone: emailUser, channel: "email", requestId: nextEmailRequest,
        completedAt: Date.now(),
    });
    for (const [dir, suffix] of [[PENDING_DIR, "phone_v1"], [REVIEW_DIR, "phone_v2"]]) {
        put(dir, suffix, {
            userPhone: phoneUser, channel: "sms", requestId: phoneRequest,
            parentJobId: `${prefix}_phone`,
        });
    }
    put(FAILED_DIR, "phone_v3", {
        userPhone: phoneUser, channel: "sms", requestId: phoneRequest,
        parentJobId: `${prefix}_phone`, failReason: "superseded",
    });
    try {
        await buildUsageCache();
        assert.equal(getUsageCount(emailUser, eventName), 2,
            "reanalysis siblings count once, while a second email submission counts separately");
        assert.equal(getUsageCount(phoneUser, eventName), 1,
            "phone kiosk review variants consume one portrait quota");
    } finally {
        for (const filePath of files) fs.rmSync(filePath, { force: true });
        await buildUsageCache();
    }
});

test("kiosk submissions in one second keep separate jobs and freeze selected options", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-queue-"));
    const downloads = path.join(root, "downloads");
    const source = path.join(root, "upload.jpg");
    fs.writeFileSync(source, "private selfie");
    const original = {
        get: settings.get,
        getForEvent: settings.getForEvent,
        getActiveStyles: settings.getActiveStyles,
        getOutputProfile: settings.getOutputProfile,
        getDownloadDir: settings.getDownloadDir,
        styleRefsDir: settings.STYLE_REFS_DIR,
        now: Date.now,
    };
    const event = `__kiosk_queue_${process.pid}__`;
    const style = { name: "Painted", prompt: "Paint the attendee", files: ["pinned.png"], behavior: "normal" };
    const eventSettings = {
        reviewMode: "off", enableManualReview: false, variantsPerReview: 1,
        enablePrinting: true, immediateDigitalDelivery: false,
        customBrands: {}, backgroundChoices: [{ key: "garden", name: "Garden", prompt: "A garden", files: [] }],
        promptPreserve: "Preserve this", promptComposition: "Frame this", promptBackground: "Current scene",
    };
    const queued = [];
    Date.now = () => new Date(2999, 0, 2, 3, 4, 5).getTime();
    settings.get = (key) => key === "eventName" ? event : key === "adminPhones" ? [] : original.get(key);
    settings.getForEvent = (key) => eventSettings[key];
    settings.getActiveStyles = () => ({ painted: style });
    settings.getOutputProfile = () => ({ orientation: "portrait" });
    settings.getDownloadDir = () => downloads;
    settings.STYLE_REFS_DIR = path.join(root, "style-refs");
    fs.mkdirSync(settings.STYLE_REFS_DIR);
    fs.writeFileSync(path.join(settings.STYLE_REFS_DIR, "pinned.png"), "first version");

    try {
        for (let i = 0; i < 2; i++) {
            const result = enqueueJob("", `api-test-${i}`, `api:${i}`, "", "painted", "https://example.test", "garden", null, {
                eventName: event,
                apiSubmission: true,
                kioskSubmission: true,
                channel: "email",
                kioskEmail: `attendee${i}@example.test`,
                sourceImagePath: source,
            });
            queued.push(result.filePrefix);
        }
        assert.notEqual(queued[0], queued[1]);
        assert.match(queued[0], /^29990102_030405_[a-f0-9]{32}$/);
        for (const prefix of queued) {
            const job = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, `${prefix}.json`), "utf8"));
            assert.equal(job.kioskEventSnapshot.style.prompt, "Paint the attendee");
            assert.equal(job.kioskEventSnapshot.backgroundChoice.prompt, "A garden");
            assert.equal(job.kioskEventSnapshot.eventSettings.immediateDigitalDelivery, true);
            assert.equal(job.kioskDeliveryState, "pending");
            assert.equal(fs.readFileSync(jobPaths(job, { staged: true }).inputPath, "utf8"), "private selfie");
            assert.equal(fs.readFileSync(path.join(downloads, ".staging", `${prefix}_refs`, "style", "pinned.png"), "utf8"), "first version");
        }

        // Disabling a style while generation waits must not switch the job.
        settings.getActiveStyles = () => ({});
        fs.writeFileSync(path.join(settings.STYLE_REFS_DIR, "pinned.png"), "changed version");
        const first = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, `${queued[0]}.json`), "utf8"));
        assert.equal(jobPaths(first).styleKey, "painted");
        assert.equal(fs.readFileSync(path.join(downloads, ".staging", `${queued[0]}_refs`, "style", "pinned.png"), "utf8"), "first version");

        const staged = jobPaths(first, { staged: true });
        fs.writeFileSync(staged.outputPath, "finished portrait");
        fs.writeFileSync(staged.mmsPath, "mms portrait");
        await moveStagedToFinal(first);
        const published = jobPaths(first);
        assert.equal(fs.readFileSync(published.outputPath, "utf8"), "finished portrait");
        assert.equal(fs.readFileSync(published.mmsPath, "utf8"), "mms portrait");
        assert.equal(fs.existsSync(published.inputPath), false, "the kiosk source must not be public");
        assert.equal(fs.existsSync(staged.inputPath), false, "the staged source is removed after publishing");
        assert.equal(fs.existsSync(path.join(downloads, ".staging", `${queued[0]}_refs`)), false);
    } finally {
        Date.now = original.now;
        settings.get = original.get;
        settings.getForEvent = original.getForEvent;
        settings.getActiveStyles = original.getActiveStyles;
        settings.getOutputProfile = original.getOutputProfile;
        settings.getDownloadDir = original.getDownloadDir;
        settings.STYLE_REFS_DIR = original.styleRefsDir;
        for (const prefix of queued) fs.rmSync(path.join(PENDING_DIR, `${prefix}.json`), { force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("kiosk email attaches the finished portrait and records SendGrid acceptance", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-email-queue-"));
    const prefix = `kiosk_email_${process.pid}`;
    const filename = `${prefix}.json`;
    const jobPath = path.join(DONE_DIR, filename);
    const original = {
        sendKioskEmail: kioskEmail.sendKioskEmail,
        getDownloadDir: settings.getDownloadDir,
    };
    let sends = 0;
    let sentImagePath;
    settings.getDownloadDir = () => root;
    kioskEmail.sendKioskEmail = async (_job, { imagePath, shareUrl }) => {
        sends++;
        sentImagePath = imagePath;
        assert.match(shareUrl, /\/s\/kiosk_email_/);
        return { status: "accepted", providerId: "sg-message" };
    };
    fs.mkdirSync(DONE_DIR, { recursive: true });
    fs.writeFileSync(path.join(root, `${prefix}_output.png`), "portrait");
    fs.writeFileSync(path.join(root, `${prefix}_output_mms.jpg`), "portrait jpeg");
    const job = {
        filePrefix: prefix, eventName: "Email Event", baseUrl: "https://example.test",
        kioskSubmission: true, kioskDeliveryState: "pending", kioskDeliveryAttempts: 0,
        channel: "email", kioskEmail: "guest@example.test", userPhone: "api:email", locale: "en",
    };
    fs.writeFileSync(jobPath, JSON.stringify(job));
    try {
        await __sendDigitalDeliveryForTest(job, filename, "deliveryDigital", DONE_DIR);
        const saved = JSON.parse(fs.readFileSync(jobPath, "utf8"));
        assert.equal(saved.kioskDeliveryState, "accepted");
        assert.equal(saved.kioskDeliveryProviderId, "sg-message");
        assert.equal(sentImagePath, path.join(root, `${prefix}_output.png`), "email uses the full portrait when it fits");
        await __sendDigitalDeliveryForTest(saved, filename, "deliveryDigital", DONE_DIR);
        assert.equal(sends, 1);

        const oversizedPrefix = `${prefix}_oversized`;
        const oversizedPath = path.join(DONE_DIR, `${oversizedPrefix}.json`);
        const oversized = {
            ...job, filePrefix: oversizedPrefix,
            kioskDeliveryState: "pending", kioskDeliveryAttempts: 0,
        };
        fs.writeFileSync(oversizedPath, JSON.stringify(oversized));
        fs.closeSync(fs.openSync(path.join(root, `${oversizedPrefix}_output.png`), "w"));
        fs.truncateSync(path.join(root, `${oversizedPrefix}_output.png`), 20 * 1024 * 1024 + 1);
        fs.writeFileSync(path.join(root, `${oversizedPrefix}_output_mms.jpg`), "smaller jpeg");
        try {
            await __sendDigitalDeliveryForTest(oversized, `${oversizedPrefix}.json`, "deliveryDigital", DONE_DIR);
            assert.equal(sentImagePath, path.join(root, `${oversizedPrefix}_output_mms.jpg`),
                "oversized PNG falls back to the smaller JPEG");
        } finally {
            fs.rmSync(oversizedPath, { force: true });
        }

        const rejectedPrefix = `${prefix}_rejected`;
        const rejectedPath = path.join(DONE_DIR, `${rejectedPrefix}.json`);
        const rejected = {
            ...job, filePrefix: rejectedPrefix,
            kioskDeliveryState: "pending", kioskDeliveryAttempts: 0,
        };
        fs.writeFileSync(path.join(root, `${rejectedPrefix}_output.png`), "portrait");
        fs.writeFileSync(rejectedPath, JSON.stringify(rejected));
        kioskEmail.sendKioskEmail = async () => {
            const error = new Error("sender is invalid");
            error.retryable = false;
            throw error;
        };
        try {
            await assert.rejects(__sendDigitalDeliveryForTest(rejected, `${rejectedPrefix}.json`, "deliveryDigital", DONE_DIR), /sender is invalid/);
            const failed = JSON.parse(fs.readFileSync(rejectedPath, "utf8"));
            assert.equal(failed.kioskDeliveryState, "failed");
            assert.equal(failed.kioskDeliveryAttempts, 1);
            assert.equal(failed.kioskDeliveryNextAttemptAt, undefined);
        } finally {
            fs.rmSync(rejectedPath, { force: true });
        }

        const uncertainPrefix = `${prefix}_uncertain`;
        const uncertainPath = path.join(DONE_DIR, `${uncertainPrefix}.json`);
        const uncertain = {
            ...job, filePrefix: uncertainPrefix,
            kioskDeliveryState: "pending", kioskDeliveryAttempts: 0,
        };
        fs.writeFileSync(path.join(root, `${uncertainPrefix}_output.png`), "portrait");
        fs.writeFileSync(uncertainPath, JSON.stringify(uncertain));
        let uncertainCalls = 0;
        kioskEmail.sendKioskEmail = async () => {
            uncertainCalls++;
            const error = new Error("provider response was lost");
            error.uncertain = true;
            throw error;
        };
        try {
            await assert.rejects(__sendDigitalDeliveryForTest(uncertain,
                `${uncertainPrefix}.json`, "deliveryDigital", DONE_DIR), /response was lost/);
            const unknown = JSON.parse(fs.readFileSync(uncertainPath, "utf8"));
            assert.equal(unknown.kioskDeliveryState, "uncertain");
            assert.equal(unknown.kioskDeliveryNextAttemptAt, undefined);
            await assert.rejects(__sendDigitalDeliveryForTest(unknown,
                `${uncertainPrefix}.json`, "deliveryDigital", DONE_DIR), /response was lost/);
            assert.equal(uncertainCalls, 1, "an ambiguous SendGrid result must not trigger another send");
        } finally {
            fs.rmSync(uncertainPath, { force: true });
        }
    } finally {
        kioskEmail.sendKioskEmail = original.sendKioskEmail;
        settings.getDownloadDir = original.getDownloadDir;
        fs.rmSync(jobPath, { force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("paused kiosk email remains retryable and releases the portrait for Print Relay", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-email-paused-"));
    const prefix = `kiosk_email_paused_${process.pid}`;
    const filename = `${prefix}.json`;
    const readyPath = path.join(READY_DIR, filename);
    const original = {
        pause: process.env.KIOSK_EMAIL_PAUSED,
        sendKioskEmail: kioskEmail.sendKioskEmail,
        getDownloadDir: settings.getDownloadDir,
        get: settings.get,
    };
    process.env.KIOSK_EMAIL_PAUSED = "true";
    settings.getDownloadDir = () => root;
    settings.get = (key, ...args) => key === "printRelayKey"
        ? "kiosk-paused-relay-key" : original.get.call(settings, key, ...args);
    let sends = 0;
    kioskEmail.sendKioskEmail = async () => {
        sends++;
        return { status: "accepted", providerId: "sg-should-not-send" };
    };
    const job = {
        filePrefix: prefix, eventName: "Paused Email Event", baseUrl: "https://example.test",
        kioskSubmission: true, channel: "email", kioskEmail: "guest@example.test",
        kioskDeliveryState: "pending", kioskDeliveryAttempts: 0,
        digitalDeliveryPendingAt: Date.now(), readyAt: Date.now(),
        outputProfile: { orientation: "portrait", printSize: "4x6" },
    };
    fs.mkdirSync(READY_DIR, { recursive: true });
    fs.writeFileSync(path.join(root, `${prefix}_output.png`), "portrait");
    fs.writeFileSync(readyPath, JSON.stringify(job));
    const app = express();
    mountPrintRelay(app);
    let server;
    try {
        await assert.rejects(__sendDigitalDeliveryForTest(job, filename, "deliveryDigital", READY_DIR), /pending/i);
        const saved = JSON.parse(fs.readFileSync(readyPath, "utf8"));
        assert.equal(sends, 0, "an existing queued email must not reach SendGrid while paused");
        assert.equal(saved.kioskDeliveryState, "pending");
        assert.equal(saved.kioskDeliveryAttempts, 0);
        assert.equal(saved.digitalDeliveryPendingAt, undefined);

        server = await new Promise((resolve, reject) => {
            const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
            listening.on("error", reject);
        });
        const response = await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: "127.0.0.1", port: server.address().port,
                path: `/api/print-relay/jobs?event=${encodeURIComponent(job.eventName)}`,
                headers: { "x-relay-key": "kiosk-paused-relay-key" },
            }, (res) => {
                let body = "";
                res.on("data", (chunk) => { body += chunk; });
                res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
            });
            req.on("error", reject);
            req.end();
        });
        assert.equal(response.status, 200);
        assert.equal(response.body.jobs.some((item) => item.filename === filename), true);
    } finally {
        if (server) await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
        });
        if (original.pause === undefined) delete process.env.KIOSK_EMAIL_PAUSED;
        else process.env.KIOSK_EMAIL_PAUSED = original.pause;
        kioskEmail.sendKioskEmail = original.sendKioskEmail;
        settings.getDownloadDir = original.getDownloadDir;
        settings.get = original.get;
        fs.rmSync(readyPath, { force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a signed provider callback can bind its SID before API acceptance is saved", async () => {
    const prefix = `kiosk_callback_${process.pid}`;
    const jobPath = path.join(DONE_DIR, `${prefix}.json`);
    const uncertainPrefix = `${prefix}_uncertain`;
    const uncertainPath = path.join(DONE_DIR, `${uncertainPrefix}.json`);
    fs.mkdirSync(DONE_DIR, { recursive: true });
    fs.writeFileSync(jobPath, JSON.stringify({
        filePrefix: prefix, eventName: "Callback Event", channel: "sms",
        kioskSubmission: true, kioskDeliveryState: "sending", kioskDeliveryAttempts: 1,
    }));
    fs.writeFileSync(uncertainPath, JSON.stringify({
        filePrefix: uncertainPrefix, eventName: "Callback Event", channel: "sms",
        kioskSubmission: true, kioskDeliveryState: "uncertain", kioskDeliveryAttempts: 1,
    }));
    try {
        assert.equal(await updateKioskDeliveryFromProvider(prefix, "Callback Event", {
            providerId: "SMearly", status: "delivered",
        }), true);
        const saved = JSON.parse(fs.readFileSync(jobPath, "utf8"));
        assert.equal(saved.kioskDeliveryProviderId, "SMearly");
        assert.equal(saved.kioskDeliveryState, "delivered");
        assert.equal(await updateKioskDeliveryFromProvider(uncertainPrefix, "Callback Event", {
            providerId: "SMunknown", status: "queued",
        }), true);
        const accepted = JSON.parse(fs.readFileSync(uncertainPath, "utf8"));
        assert.equal(accepted.kioskDeliveryState, "accepted", "a signed callback resolves a lost API response");
        assert.equal(accepted.kioskDeliveryProviderId, "SMunknown");
        await updateKioskDeliveryFromProvider(uncertainPrefix, "Callback Event", {
            providerId: "SMunknown", status: "failed", errorCode: "30005",
        });
        await updateKioskDeliveryFromProvider(uncertainPrefix, "Callback Event", {
            providerId: "SMunknown", status: "sent",
        });
        const failed = JSON.parse(fs.readFileSync(uncertainPath, "utf8"));
        assert.equal(failed.kioskDeliveryState, "failed");
        assert.equal(failed.kioskProviderStatus, "failed", "an older sent callback cannot obscure carrier failure");
    } finally {
        fs.rmSync(jobPath, { force: true });
        fs.rmSync(uncertainPath, { force: true });
    }
});

test("correlated SendGrid events resolve uncertain sends and ignore older outcomes", async () => {
    const prefix = `kiosk_email_events_${process.pid}`;
    const filename = `${prefix}.json`;
    const jobPath = path.join(DONE_DIR, filename);
    const failedPrefix = `${prefix}_failed`;
    const failedPath = path.join(DONE_DIR, `${failedPrefix}.json`);
    const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    fs.mkdirSync(DONE_DIR, { recursive: true });
    const base = {
        eventName: "Email Event", kioskSubmission: true, channel: "email",
        requestId, kioskEmail: "guest@example.test", kioskDeliveryState: "uncertain",
        kioskDeliveryAttempts: 1, kioskDeliveryProviderId: "sendgrid-api-id",
    };
    fs.writeFileSync(jobPath, JSON.stringify({ ...base, filePrefix: prefix }));
    fs.writeFileSync(failedPath, JSON.stringify({ ...base, filePrefix: failedPrefix }));
    try {
        assert.equal(await updateKioskEmailFromProvider(prefix,
            "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { status: "delivered", timestamp: 200 }), false);
        assert.equal(await updateKioskEmailFromProvider(prefix, requestId, {
            status: "delivered", providerId: "sendgrid-event-id", eventId: "evt-delivered", timestamp: 200,
        }), true);
        let saved = JSON.parse(fs.readFileSync(jobPath, "utf8"));
        assert.equal(saved.kioskDeliveryState, "delivered");
        assert.equal(saved.kioskDeliveryProviderId, "sendgrid-api-id", "event IDs need not match API IDs");
        assert.equal(saved.kioskProviderMessageId, "sendgrid-event-id");
        assert.equal(saved.kioskProviderEventTimestamp, 200);
        assert.equal(saved.smsSentAt > 0, true);

        await updateKioskEmailFromProvider(prefix, requestId, {
            status: "bounce", eventId: "evt-older-bounce", timestamp: 199,
            reason: "Mailbox rejected",
        });
        assert.equal(JSON.parse(fs.readFileSync(jobPath, "utf8")).kioskDeliveryState, "delivered");

        await updateKioskEmailFromProvider(prefix, requestId, {
            status: "bounce", eventId: "evt-newer-bounce", timestamp: 201,
            reason: "Mailbox rejected",
        });
        saved = JSON.parse(fs.readFileSync(jobPath, "utf8"));
        assert.equal(saved.kioskDeliveryState, "failed", "a newer hard bounce can supersede delivered");
        assert.match(saved.kioskDeliveryLastError, /Mailbox rejected/);
        assert.equal(saved.kioskProviderEventId, "evt-newer-bounce");
        await updateKioskEmailFromProvider(prefix, requestId, {
            status: "delivered", eventId: "evt-delayed-delivery", timestamp: 200,
        });
        assert.equal(JSON.parse(fs.readFileSync(jobPath, "utf8")).kioskDeliveryState, "failed");

        await updateKioskEmailFromProvider(failedPrefix, requestId, {
            status: "dropped", eventId: "evt-dropped", reason: "Suppressed address", timestamp: 202,
        });
        assert.equal(JSON.parse(fs.readFileSync(failedPath, "utf8")).kioskDeliveryState, "failed",
            "a failed event resolves an uncertain send without a retry");
        await updateKioskEmailFromProvider(failedPrefix, requestId, {
            status: "dropped", eventId: "evt-dropped", reason: "Suppressed address", timestamp: 202,
        });
        assert.equal(JSON.parse(fs.readFileSync(failedPath, "utf8")).kioskProviderEventId, "evt-dropped");
    } finally {
        fs.rmSync(jobPath, { force: true });
        fs.rmSync(failedPath, { force: true });
    }
});

test("kiosk delivery sweep retries due sends and flags an interrupted send without duplicating it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-sweep-"));
    const queueDir = path.join(root, "done");
    const downloads = path.join(root, "downloads");
    fs.mkdirSync(queueDir);
    fs.mkdirSync(downloads);
    const original = {
        sendKioskEmail: kioskEmail.sendKioskEmail,
        getDownloadDir: settings.getDownloadDir,
    };
    settings.getDownloadDir = () => downloads;
    let sends = 0;
    kioskEmail.sendKioskEmail = async () => {
        sends++;
        return { status: "accepted", providerId: "sg-sweep" };
    };
    const due = {
        filePrefix: "due", eventName: "Sweep Event", baseUrl: "https://example.test",
        kioskSubmission: true, channel: "email", kioskEmail: "guest@example.test",
        kioskDeliveryState: "retry", kioskDeliveryAttempts: 1, kioskDeliveryNextAttemptAt: 0,
    };
    const interrupted = {
        ...due, filePrefix: "interrupted", kioskDeliveryState: "sending",
        kioskDeliveryAttemptStartedAt: Date.now() - 6 * 60_000,
    };
    for (const job of [due, interrupted]) {
        fs.writeFileSync(path.join(queueDir, `${job.filePrefix}.json`), JSON.stringify(job));
        fs.writeFileSync(path.join(downloads, `${job.filePrefix}_output.png`), "portrait");
    }
    try {
        await sweepKioskDeliveries({ dirs: [queueDir] });
        assert.equal(JSON.parse(fs.readFileSync(path.join(queueDir, "due.json"), "utf8")).kioskDeliveryState, "accepted");
        assert.equal(JSON.parse(fs.readFileSync(path.join(queueDir, "interrupted.json"), "utf8")).kioskDeliveryState, "uncertain");
        assert.equal(sends, 1);
        await sweepKioskDeliveries({ dirs: [queueDir] });
        assert.equal(sends, 1);
    } finally {
        kioskEmail.sendKioskEmail = original.sendKioskEmail;
        settings.getDownloadDir = original.getDownloadDir;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("startup recovery defers kiosk provider sends and preserves pending print effects", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-startup-send-"));
    const prefix = `kiosk_startup_${process.pid}`;
    const filename = `${prefix}.json`;
    const donePath = path.join(DONE_DIR, filename);
    const failedPrefix = `${prefix}_failed`;
    const failedFilename = `${failedPrefix}.json`;
    const failedPath = path.join(FAILED_DIR, failedFilename);
    const original = {
        getDownloadDir: settings.getDownloadDir,
        sendKioskEmail: kioskEmail.sendKioskEmail,
    };
    settings.getDownloadDir = () => root;
    let sends = 0;
    kioskEmail.sendKioskEmail = async () => {
        sends++;
        return { status: "accepted", providerId: `sg-startup-${sends}` };
    };
    const job = {
        filePrefix: prefix, eventName: "Startup Event", baseUrl: "https://example.test",
        kioskSubmission: true, channel: "email", kioskEmail: "guest@example.test",
        kioskDeliveryState: "pending", kioskDeliveryAttempts: 0, deliveryPending: true,
    };
    fs.mkdirSync(DONE_DIR, { recursive: true });
    fs.mkdirSync(FAILED_DIR, { recursive: true });
    fs.writeFileSync(donePath, JSON.stringify(job));
    fs.writeFileSync(failedPath, JSON.stringify({
        ...job, filePrefix: failedPrefix, deliveryPending: false,
        failureEffectsPending: true, usageReleasePending: false,
    }));
    fs.writeFileSync(path.join(root, `${prefix}_output.png`), "portrait");
    fs.writeFileSync(path.join(root, `${failedPrefix}_output.png`), "portrait");
    try {
        setKioskDeliveryReady(false);
        assert.equal(await finishPendingRelayEffects(donePath, filename), false);
        assert.equal(await finishPendingRelayEffects(failedPath, failedFilename), false);
        assert.equal(sends, 0);
        const pendingDone = JSON.parse(fs.readFileSync(donePath, "utf8"));
        const pendingFailed = JSON.parse(fs.readFileSync(failedPath, "utf8"));
        assert.equal(pendingDone.deliveryPending, true);
        assert.equal(pendingFailed.failureEffectsPending, true);
        assert.equal(pendingDone.kioskDeliveryState, "pending");
        assert.equal(pendingFailed.kioskDeliveryState, "pending");
        assert.equal(pendingDone.kioskDeliveryAttempts, 0);
        assert.equal(pendingFailed.kioskDeliveryAttempts, 0);

        setKioskDeliveryReady(true);
        assert.equal(await finishPendingRelayEffects(donePath, filename), true);
        assert.equal(await finishPendingRelayEffects(failedPath, failedFilename), true);
        assert.equal(sends, 2);
        assert.equal(JSON.parse(fs.readFileSync(donePath, "utf8")).deliveryPending, false);
        assert.equal(JSON.parse(fs.readFileSync(failedPath, "utf8")).failureEffectsPending, false);
        assert.equal(JSON.parse(fs.readFileSync(donePath, "utf8")).kioskDeliveryState, "accepted");
        assert.equal(JSON.parse(fs.readFileSync(failedPath, "utf8")).kioskDeliveryState, "accepted");
    } finally {
        setKioskDeliveryReady(true);
        kioskEmail.sendKioskEmail = original.sendKioskEmail;
        settings.getDownloadDir = original.getDownloadDir;
        fs.rmSync(donePath, { force: true });
        fs.rmSync(failedPath, { force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("kiosk SMS records provider acceptance, retries a send error, and never sends twice", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-send-"));
    const prefix = `kiosk_send_${process.pid}`;
    const filename = `${prefix}.json`;
    const jobPath = path.join(DONE_DIR, filename);
    const original = {
        send: messaging.send,
        smsConfigured: channelRegistry.ADAPTERS.sms.isConfigured,
        getDownloadDir: settings.getDownloadDir,
    };
    let sends = 0;
    const job = {
        filePrefix: prefix,
        eventName: "Kiosk Send Test",
        baseUrl: "https://example.test",
        channel: "sms",
        kioskSubmission: true,
        kioskDeliveryState: "pending",
        kioskDeliveryAttempts: 0,
        userPhone: "+14155551234",
        locale: "en",
        style: "cartoon",
        styleName: "Cartoon",
    };
    fs.mkdirSync(DONE_DIR, { recursive: true });
    settings.getDownloadDir = () => root;
    channelRegistry.ADAPTERS.sms.isConfigured = () => true;
    messaging.send = async (_to, _key, _vars, options) => {
        sends++;
        assert.match(options.statusCallback, new RegExp(`/api/kiosk-delivery/twilio-status/${prefix}`));
        return sends === 1 ? { error: "temporary provider failure" } : { sid: "SMaccepted" };
    };
    fs.writeFileSync(path.join(root, `${prefix}_output.png`), "portrait");
    fs.writeFileSync(path.join(root, `${prefix}_output_mms.jpg`), "portrait");
    fs.writeFileSync(jobPath, JSON.stringify(job));

    try {
        await assert.rejects(__sendDigitalDeliveryForTest(job, filename, "deliveryDigital", DONE_DIR), /temporary provider failure/);
        const retry = JSON.parse(fs.readFileSync(jobPath, "utf8"));
        assert.equal(retry.kioskDeliveryState, "retry");
        assert.equal(retry.kioskDeliveryAttempts, 1);

        retry.kioskDeliveryNextAttemptAt = 0;
        fs.writeFileSync(jobPath, JSON.stringify(retry));
        await __sendDigitalDeliveryForTest(retry, filename, "deliveryDigital", DONE_DIR);
        const accepted = JSON.parse(fs.readFileSync(jobPath, "utf8"));
        assert.equal(accepted.kioskDeliveryState, "accepted");
        assert.equal(accepted.kioskDeliveryProviderId, "SMaccepted");
        assert.equal(accepted.kioskDeliveryAttempts, 2);

        await __sendDigitalDeliveryForTest(accepted, filename, "deliveryDigital", DONE_DIR);
        assert.equal(sends, 2);

        assert.equal(await updateKioskDeliveryFromProvider(prefix, job.eventName, {
            providerId: "SMother", status: "delivered",
        }), false);
        assert.equal(await updateKioskDeliveryFromProvider(prefix, job.eventName, {
            providerId: "SMaccepted", status: "delivered",
        }), true);
        assert.equal(JSON.parse(fs.readFileSync(jobPath, "utf8")).kioskDeliveryState, "delivered");
        await updateKioskDeliveryFromProvider(prefix, job.eventName, {
            providerId: "SMaccepted", status: "undelivered", errorCode: "30005",
        });
        assert.equal(JSON.parse(fs.readFileSync(jobPath, "utf8")).kioskDeliveryState, "delivered");

        const ambiguousPrefix = `${prefix}_ambiguous`;
        const ambiguousPath = path.join(DONE_DIR, `${ambiguousPrefix}.json`);
        const ambiguous = {
            ...job, filePrefix: ambiguousPrefix,
            kioskDeliveryState: "pending", kioskDeliveryAttempts: 0,
        };
        fs.writeFileSync(path.join(root, `${ambiguousPrefix}_output.png`), "portrait");
        fs.writeFileSync(path.join(root, `${ambiguousPrefix}_output_mms.jpg`), "portrait");
        fs.writeFileSync(ambiguousPath, JSON.stringify(ambiguous));
        let ambiguousCalls = 0;
        messaging.send = async () => {
            ambiguousCalls++;
            return { error: "Twilio response was lost", uncertain: true };
        };
        try {
            await assert.rejects(__sendDigitalDeliveryForTest(ambiguous,
                `${ambiguousPrefix}.json`, "deliveryDigital", DONE_DIR), /response was lost/);
            assert.equal(JSON.parse(fs.readFileSync(ambiguousPath, "utf8")).kioskDeliveryState, "uncertain");
            await updateKioskDeliveryFromProvider(ambiguousPrefix, job.eventName, {
                providerId: "SMlate", status: "delivered",
            });
            assert.equal(JSON.parse(fs.readFileSync(ambiguousPath, "utf8")).kioskDeliveryState, "delivered");
            assert.equal(ambiguousCalls, 1, "a late signed callback resolves the send without retrying it");
        } finally {
            fs.rmSync(ambiguousPath, { force: true });
        }
    } finally {
        messaging.send = original.send;
        channelRegistry.ADAPTERS.sms.isConfigured = original.smsConfigured;
        settings.getDownloadDir = original.getDownloadDir;
        fs.rmSync(jobPath, { force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("kiosk WhatsApp uses the approved out-of-session template without raw fallback", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-whatsapp-queue-"));
    const prefix = `kiosk_whatsapp_${process.pid}`;
    const filename = `${prefix}.json`;
    const jobPath = path.join(DONE_DIR, filename);
    const original = {
        send: messaging.send,
        whatsappConfigured: channelRegistry.ADAPTERS.whatsapp.isConfigured,
        getDownloadDir: settings.getDownloadDir,
    };
    const calls = [];
    settings.getDownloadDir = () => root;
    channelRegistry.ADAPTERS.whatsapp.isConfigured = () => true;
    messaging.send = async (_to, key, vars, options) => {
        calls.push({ key, vars, options });
        return calls.length === 1 ? { error: "template rejected" } : { sid: "SMwhatsapp" };
    };
    fs.mkdirSync(DONE_DIR, { recursive: true });
    fs.writeFileSync(path.join(root, `${prefix}_output.png`), "portrait");
    fs.writeFileSync(path.join(root, `${prefix}_output_mms.jpg`), "portrait jpeg");
    const job = {
        filePrefix: prefix, eventName: "WhatsApp Event", baseUrl: "https://example.test",
        kioskSubmission: true, kioskDeliveryState: "pending", kioskDeliveryAttempts: 0,
        channel: "whatsapp", userPhone: "+14155551234", locale: "en", styleName: "Cartoon",
        kioskEventSnapshot: { style: { name: "Cartoon" }, deliveryContentSid: "HXapproved" },
    };
    fs.writeFileSync(jobPath, JSON.stringify(job));
    try {
        await assert.rejects(__sendDigitalDeliveryForTest(job, filename, "deliveryDigital", DONE_DIR), /template rejected/);
        assert.deepEqual(calls.map((call) => call.key), ["delivery"]);
        assert.equal(calls[0].options.contentSid, "HXapproved");
        assert.equal(calls[0].options.allowOutOfSession, true);
        assert.equal(calls[0].vars[1], "Cartoon");

        const retry = JSON.parse(fs.readFileSync(jobPath, "utf8"));
        retry.kioskDeliveryNextAttemptAt = 0;
        fs.writeFileSync(jobPath, JSON.stringify(retry));
        await __sendDigitalDeliveryForTest(retry, filename, "deliveryDigital", DONE_DIR);
        assert.deepEqual(calls.map((call) => call.key), ["delivery", "delivery"]);
        assert.equal(JSON.parse(fs.readFileSync(jobPath, "utf8")).kioskDeliveryState, "accepted");
    } finally {
        messaging.send = original.send;
        channelRegistry.ADAPTERS.whatsapp.isConfigured = original.whatsappConfigured;
        settings.getDownloadDir = original.getDownloadDir;
        fs.rmSync(jobPath, { force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("kiosk digital send blocks a relay claim, then the relay prints without sending twice", { timeout: 10_000 }, async () => {
    const eventName = `__kiosk_print_${process.pid}__`;
    const root = path.join(settings.ROOT_DIR, "downloads", eventName);
    const prefix = `kiosk_print_${process.pid}`;
    const filename = `${prefix}.json`;
    const reviewPath = path.join(REVIEW_DIR, filename);
    const readyPath = path.join(READY_DIR, filename);
    const printingPath = path.join(PRINTING_DIR, filename);
    const donePath = path.join(DONE_DIR, filename);
    const pendingFilename = `${prefix}_pending.json`;
    const pendingReadyPath = path.join(READY_DIR, pendingFilename);
    const pendingPrintingPath = path.join(PRINTING_DIR, pendingFilename);
    const relayKey = "kiosk-print-relay-test-key";
    const original = {
        get: settings.get,
        send: messaging.send,
        smsConfigured: channelRegistry.ADAPTERS.sms.isConfigured,
        getDownloadDir: settings.getDownloadDir,
    };
    let sends = 0;
    let releaseSend;
    let sendStartedResolve;
    let ackArrivedResolve;
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    const sendStarted = new Promise((resolve) => { sendStartedResolve = resolve; });
    const ackArrived = new Promise((resolve) => { ackArrivedResolve = resolve; });
    settings.get = (key, ...args) => key === "printRelayKey" ? relayKey : original.get.call(settings, key, ...args);
    settings.getDownloadDir = () => root;
    channelRegistry.ADAPTERS.sms.isConfigured = () => true;
    messaging.send = async () => {
        sends++;
        sendStartedResolve();
        await sendGate;
        return { sid: "SMprint" };
    };
    const job = {
        filePrefix: prefix, eventName, baseUrl: "https://example.test",
        channel: "sms", userPhone: "+14155551234", locale: "en", style: "cartoon", styleName: "Cartoon",
        outputProfile: { orientation: "portrait", printSize: "4x6" },
        kioskSubmission: true, kioskDeliveryState: "pending", kioskDeliveryAttempts: 0,
        kioskEventSnapshot: {
            style: { name: "Cartoon", prompt: "A cartoon" },
            eventSettings: { enablePrinting: true, immediateDigitalDelivery: true },
        },
    };
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    fs.mkdirSync(READY_DIR, { recursive: true });
    fs.mkdirSync(PRINTING_DIR, { recursive: true });
    fs.mkdirSync(DONE_DIR, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    const staged = jobPaths(job, { staged: true });
    fs.writeFileSync(staged.inputPath, "selfie");
    fs.writeFileSync(staged.outputPath, "portrait");
    fs.writeFileSync(staged.mmsPath, "portrait mms");
    fs.writeFileSync(reviewPath, JSON.stringify(job));

    const app = express();
    app.use((req, _res, next) => {
        if (req.path === `/api/print-relay/jobs/${filename}/ack`) ackArrivedResolve();
        next();
    });
    mountPrintRelay(app);
    let server;
    let approval;
    let ackRequest;
    try {
        server = await new Promise((resolve, reject) => {
            const listening = app.listen(0, "127.0.0.1", (error) => {
                if (error) reject(error);
                else resolve(listening);
            });
            listening.on("error", reject);
        });
        const relayRequest = (method, route, body) => new Promise((resolve, reject) => {
            const payload = body === undefined ? null : JSON.stringify(body);
            const req = http.request({
                hostname: "127.0.0.1", port: server.address().port, method,
                path: `/api/print-relay${route}`,
                agent: false,
                headers: {
                    "x-relay-key": relayKey,
                    "x-relay-version": "1.3.0",
                    ...(payload === null ? {} : {
                        "content-type": "application/json",
                        "content-length": Buffer.byteLength(payload),
                    }),
                },
            }, (res) => {
                let content = "";
                res.on("data", (chunk) => { content += chunk; });
                res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(content) }));
            });
            req.on("error", reject);
            req.end(payload === null ? undefined : payload);
        });

        approval = approveJob(filename);
        await Promise.race([sendStarted, approval.then(() => { throw new Error("Kiosk digital send did not start"); })]);
        assert.equal(fs.existsSync(readyPath), true);
        assert.equal(JSON.parse(fs.readFileSync(readyPath, "utf8")).digitalDeliveryPendingAt > 0, true);
        const hidden = await relayRequest("GET", `/jobs?event=${encodeURIComponent(eventName)}`);
        assert.equal(hidden.status, 200);
        assert.equal(hidden.body.jobs.some((item) => item.filename === filename), false,
            "the relay must not list a job while its digital send is pending");

        ackRequest = relayRequest("POST", `/jobs/${filename}/ack`, { eventName, printerName: "Kiosk Test Relay" });
        await ackArrived;
        let ackSettled = false;
        ackRequest.then(() => { ackSettled = true; }, () => { ackSettled = true; });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(ackSettled, false, "the claim waits for digital delivery to finish");
        assert.equal(fs.existsSync(printingPath), false);

        releaseSend();
        await approval;
        const ack = await ackRequest;
        assert.equal(ack.status, 200);
        assert.equal(fs.existsSync(readyPath), false);
        assert.equal(fs.existsSync(printingPath), true, "the relay can claim the finished kiosk portrait");
        const printing = JSON.parse(fs.readFileSync(printingPath, "utf8"));
        assert.equal(printing.kioskDeliveryState, "accepted");
        assert.equal(printing.kioskDeliveryProviderId, "SMprint");
        assert.equal(printing.smsSentAt > 0, true);
        assert.equal(fs.existsSync(jobPaths(printing).outputPath), true);
        assert.equal(fs.existsSync(jobPaths(printing).inputPath), false);

        const complete = await relayRequest("POST", `/jobs/${filename}/complete`, {
            success: true, claimId: ack.body.job.claimId,
        });
        assert.equal(complete.status, 200);
        assert.equal(complete.body.state, "done");
        assert.equal(fs.existsSync(donePath), true);
        assert.equal(sends, 1, "print completion must not deliver a second copy");

        const pendingJob = { ...job, filePrefix: prefix + "_pending", digitalDeliveryPendingAt: Date.now() };
        fs.writeFileSync(pendingReadyPath, JSON.stringify(pendingJob));
        const blocked = await relayRequest("POST", `/jobs/${pendingFilename}/ack`, { eventName });
        assert.equal(blocked.status, 409, "a pending send remains guarded even without an active sender");
        assert.equal(fs.existsSync(pendingReadyPath), true);
        assert.equal(fs.existsSync(pendingPrintingPath), false);
    } finally {
        releaseSend();
        if (approval) await approval.catch(() => {});
        if (ackRequest) await ackRequest.catch(() => {});
        if (server) await new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
        });
        messaging.send = original.send;
        settings.get = original.get;
        channelRegistry.ADAPTERS.sms.isConfigured = original.smsConfigured;
        settings.getDownloadDir = original.getDownloadDir;
        for (const filePath of [reviewPath, readyPath, printingPath, donePath, pendingReadyPath, pendingPrintingPath]) {
            fs.rmSync(filePath, { force: true });
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("a connected printer waits for kiosk digital delivery before claiming READY", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-local-print-"));
    const prefix = `kiosk_local_print_${process.pid}`;
    const filename = `${prefix}.json`;
    const readyPath = path.join(READY_DIR, filename);
    const printingPath = path.join(PRINTING_DIR, filename);
    const donePath = path.join(DONE_DIR, filename);
    const original = {
        getDownloadDir: settings.getDownloadDir,
        send: messaging.send,
        smsConfigured: channelRegistry.ADAPTERS.sms.isConfigured,
    };
    let sends = 0;
    let prints = 0;
    let releaseSend;
    let sendStartedResolve;
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    const sendStarted = new Promise((resolve) => { sendStartedResolve = resolve; });
    settings.getDownloadDir = () => root;
    channelRegistry.ADAPTERS.sms.isConfigured = () => true;
    messaging.send = async () => {
        sends++;
        sendStartedResolve();
        await sendGate;
        return { sid: "SMlocal" };
    };
    const job = {
        filePrefix: prefix, eventName: "Kiosk Local Print", baseUrl: "https://example.test",
        channel: "sms", userPhone: "+14155551234", locale: "en", style: "cartoon",
        kioskSubmission: true, kioskDeliveryState: "pending", kioskDeliveryAttempts: 0,
        digitalDeliveryPendingAt: Date.now(),
        kioskEventSnapshot: { eventSettings: { enablePrinting: true, immediateDigitalDelivery: true } },
    };
    fs.mkdirSync(READY_DIR, { recursive: true });
    fs.mkdirSync(PRINTING_DIR, { recursive: true });
    fs.mkdirSync(DONE_DIR, { recursive: true });
    fs.writeFileSync(path.join(root, `${prefix}_output.png`), "portrait");
    fs.writeFileSync(path.join(root, `${prefix}_output_mms.jpg`), "portrait mms");
    fs.writeFileSync(readyPath, JSON.stringify(job));
    let delivery;
    let localPrint;
    try {
        delivery = __sendDigitalDeliveryForTest(job, filename, "deliveryDigital", READY_DIR);
        await sendStarted;
        localPrint = processSinglePrint(filename, "Test Connected Printer", async () => { prints++; });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(fs.existsSync(readyPath), true);
        assert.equal(fs.existsSync(printingPath), false);

        releaseSend();
        await delivery;
        await localPrint;
        assert.equal(fs.existsSync(donePath), true);
        assert.equal(JSON.parse(fs.readFileSync(donePath, "utf8")).kioskDeliveryState, "accepted");
        assert.equal(sends, 1);
        assert.equal(prints, 1);
    } finally {
        releaseSend();
        if (delivery) await delivery.catch(() => {});
        if (localPrint) await localPrint.catch(() => {});
        messaging.send = original.send;
        channelRegistry.ADAPTERS.sms.isConfigured = original.smsConfigured;
        settings.getDownloadDir = original.getDownloadDir;
        for (const filePath of [readyPath, printingPath, donePath]) fs.rmSync(filePath, { force: true });
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("kiosk review reanalysis preserves its private selfie and pinned references", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-reanalyze-"));
    const originalGetDownloadDir = settings.getDownloadDir;
    const parentId = `kiosk_parent_${process.pid}`;
    const oldFiles = [];
    const newFiles = [];
    settings.getDownloadDir = () => root;
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    try {
        for (let index = 1; index <= 2; index++) {
            const prefix = `${parentId}-v${index}`;
            const filename = `${prefix}.json`;
            oldFiles.push(filename);
            const job = {
                filePrefix: prefix, parentJobId: parentId, variantId: prefix,
                variantIndex: index, variantCount: 2, eventName: "Reanalysis Event",
                messageSid: "api-reanalyze", userPhone: "api:reanalysis", channel: "email",
                kioskEmail: "guest@example.test", kioskSubmission: true, apiSubmission: true,
                kioskOriginalPublic: true,
                style: "painted", background: null, brand: null, locale: "en",
                outputProfile: { orientation: "portrait" },
                kioskEventSnapshot: {
                    style: { name: "Painted", prompt: "Paint", files: ["pinned.png"] },
                    brandReferenceFiles: [], backgroundChoice: null,
                    referencesPinned: true, eventSettings: { reviewMode: "human", enablePrinting: false },
                },
            };
            const staged = jobPaths(job, { staged: true });
            fs.writeFileSync(staged.inputPath, "private selfie");
            fs.writeFileSync(staged.outputPath, "old output");
            const refs = path.join(root, ".staging", `${prefix}_refs`, "style");
            fs.mkdirSync(refs, { recursive: true });
            fs.writeFileSync(path.join(refs, "pinned.png"), "pinned ref");
            fs.writeFileSync(path.join(REVIEW_DIR, filename), JSON.stringify(job));
        }

        await rejectParent(parentId, null, true, null);
        for (const filename of fs.readdirSync(PENDING_DIR).filter((name) => name.endsWith(".json"))) {
            const job = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, filename), "utf8"));
            if (job.reanalyzedFrom !== parentId) continue;
            newFiles.push(filename);
            assert.equal(job.kioskSubmission, true);
            assert.equal(job.kioskOriginalPublic, true);
            assert.equal(job.kioskEmail, "guest@example.test");
            assert.match(job.parentJobId, /^\d{8}_\d{6}_[a-f0-9]{32}$/);
            assert.equal(fs.readFileSync(jobPaths(job, { staged: true }).inputPath, "utf8"), "private selfie");
            assert.equal(fs.readFileSync(path.join(root, ".staging", `${job.filePrefix}_refs`, "style", "pinned.png"), "utf8"), "pinned ref");
        }
        assert.equal(newFiles.length, 2);
        const replacement = newFiles.find((name) => name.endsWith("-v1.json")).slice(0, -5);
        assert.equal(await resolveKioskResultPrefix(`${parentId}-v1`, "Reanalysis Event"), replacement);
        const retired = JSON.parse(fs.readFileSync(path.join(FAILED_DIR, `${parentId}-v1.json`), "utf8"));
        assert.equal(retired.kioskResultPrefix, replacement);
    } finally {
        settings.getDownloadDir = originalGetDownloadDir;
        for (const filename of oldFiles) {
            for (const dir of [REVIEW_DIR, PENDING_DIR, DONE_DIR, FAILED_DIR]) fs.rmSync(path.join(dir, filename), { force: true });
        }
        for (const filename of fs.readdirSync(PENDING_DIR).filter((name) => name.endsWith(".json"))) {
            try {
                const job = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, filename), "utf8"));
                if (job.reanalyzedFrom === parentId) fs.rmSync(path.join(PENDING_DIR, filename), { force: true });
            } catch { /* already gone */ }
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test("the original kiosk status prefix resolves to a different approved variant", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-pick-"));
    const original = {
        getDownloadDir: settings.getDownloadDir,
        sendKioskEmail: kioskEmail.sendKioskEmail,
    };
    const eventName = "Pick Event";
    const parentId = `kiosk_pick_${process.pid}`;
    const prefixes = [1, 2].map((index) => `${parentId}-v${index}`);
    settings.getDownloadDir = () => root;
    kioskEmail.sendKioskEmail = async () => ({ status: "accepted", providerId: "sg-picked" });
    fs.mkdirSync(REVIEW_DIR, { recursive: true });
    try {
        for (let index = 1; index <= 2; index++) {
            const prefix = prefixes[index - 1];
            const job = {
                filePrefix: prefix, parentJobId: parentId, variantId: prefix,
                variantIndex: index, variantCount: 2,
                eventName, style: "cartoon", locale: "en", baseUrl: "https://example.test",
                channel: "email", kioskEmail: "guest@example.test", kioskSubmission: true,
                kioskDeliveryState: "pending", kioskDeliveryAttempts: 0,
                kioskEventSnapshot: {
                    style: { name: "Cartoon", prompt: "Cartoon", files: [] },
                    brandReferenceFiles: [], referencesPinned: true,
                    eventSettings: { enablePrinting: false, immediateDigitalDelivery: true },
                },
            };
            const staged = jobPaths(job, { staged: true });
            fs.writeFileSync(staged.inputPath, "private selfie");
            fs.writeFileSync(staged.outputPath, `portrait ${index}`);
            fs.writeFileSync(path.join(REVIEW_DIR, `${prefix}.json`), JSON.stringify(job));
        }

        await pickVariant(parentId, prefixes[1]);
        assert.equal(await resolveKioskResultPrefix(prefixes[0], eventName), prefixes[1]);
        assert.equal(JSON.parse(fs.readFileSync(path.join(FAILED_DIR, `${prefixes[0]}.json`), "utf8")).kioskResultPrefix, prefixes[1]);
        assert.equal(JSON.parse(fs.readFileSync(path.join(DONE_DIR, `${prefixes[1]}.json`), "utf8")).kioskDeliveryState, "accepted");
    } finally {
        settings.getDownloadDir = original.getDownloadDir;
        kioskEmail.sendKioskEmail = original.sendKioskEmail;
        for (const prefix of prefixes) {
            for (const dir of [REVIEW_DIR, PENDING_DIR, READY_DIR, DONE_DIR, FAILED_DIR]) {
                fs.rmSync(path.join(dir, `${prefix}.json`), { force: true });
            }
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { DONE_DIR, FAILED_DIR } = require("../lib/config");
const queue = require("../lib/queue");
const messaging = require("../lib/messaging");
const kioskEmail = require("../lib/kiosk-email");
const settings = require("../lib/settings");

test("delivery maintenance does not reopen settled job history on every pass", async (t) => {
    const quiet = new Set();
    const active = new Set();
    const recent = new Set();
    const originalReadFile = fs.promises.readFile;
    let quietReads = 0;
    let activeReads = 0;
    let recentReads = 0;
    const initialReads = new Map();
    const prefix = `delivery-scan-${process.pid}-${Date.now()}`;
    const oldAt = Date.now() - 2 * 60 * 60 * 1000;

    for (const dir of [DONE_DIR, FAILED_DIR]) fs.mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 12; index++) {
        const filename = `${prefix}-${index}.json`;
        const filepath = path.join(index % 2 ? DONE_DIR : FAILED_DIR, filename);
        const job = {
            filePrefix: filename.slice(0, -5),
            eventName: "Delivery Scan Test",
            createdAt: oldAt,
            ...(index % 2 ? { completedAt: oldAt } : {}),
            ...(index % 3 === 0 ? {
                inputMode: "voice", voiceDeliveryKind: "result",
                voiceDeliveryState: "sent", voiceFollowupsAt: oldAt,
            } : index % 3 === 1 ? {
                kioskSubmission: true, kioskDeliveryState: "accepted",
            } : {}),
        };
        fs.writeFileSync(filepath, JSON.stringify(job));
        quiet.add(filepath);
    }
    const activeVoice = path.join(DONE_DIR, `${prefix}-voice-pending.json`);
    const activeKiosk = path.join(DONE_DIR, `${prefix}-kiosk-retry.json`);
    fs.writeFileSync(activeVoice, JSON.stringify({
        filePrefix: path.basename(activeVoice, ".json"), inputMode: "voice",
        voiceDeliveryKind: "failure", voiceDeliveryState: "sending",
        voiceDeliveryLeaseAt: Date.now(),
    }));
    fs.writeFileSync(activeKiosk, JSON.stringify({
        filePrefix: path.basename(activeKiosk, ".json"), kioskSubmission: true,
        kioskDeliveryState: "retry", kioskDeliveryNextAttemptAt: Date.now() + 60_000,
    }));
    active.add(activeVoice);
    active.add(activeKiosk);
    const recentPath = path.join(DONE_DIR, `${prefix}-recent.json`);
    fs.writeFileSync(recentPath, JSON.stringify({
        filePrefix: path.basename(recentPath, ".json"), createdAt: oldAt,
        completedAt: Date.now(), inputMode: "voice", voiceDeliveryKind: "result",
        voiceDeliveryState: "sent", voiceFollowupsAt: Date.now(),
    }));
    recent.add(recentPath);

    fs.promises.readFile = async (...args) => {
        if (quiet.has(String(args[0]))) {
            quietReads++;
            initialReads.set(String(args[0]), (initialReads.get(String(args[0])) || 0) + 1);
        }
        if (active.has(String(args[0]))) activeReads++;
        if (recent.has(String(args[0]))) recentReads++;
        return originalReadFile(...args);
    };
    t.after(() => {
        fs.promises.readFile = originalReadFile;
        for (const filepath of [...quiet, ...active, ...recent]) fs.rmSync(filepath, { force: true });
    });

    await queue.sweepVoiceDeliveries();
    await queue.sweepKioskDeliveries();
    await queue.sweepPendingTerminalEffects();
    for (const filepath of quiet) {
        assert.ok(initialReads.get(filepath) > 0, `the initial recovery pass must inspect ${path.basename(filepath)}`);
    }

    quietReads = 0;
    activeReads = 0;
    recentReads = 0;
    await queue.sweepVoiceDeliveries();
    await queue.sweepKioskDeliveries();
    await queue.sweepPendingTerminalEffects();
    assert.equal(quietReads, 0, "settled history must not generate repeated Azure Files opens");
    assert.ok(activeReads > 0, "unfinished deliveries must still be inspected on the next pass");
    assert.ok(recentReads > 0, "recent jobs must retain the 30-second recovery path");
});

test("a write during a settled-file read cannot hide the updated job", async (t) => {
    const prefix = `delivery-race-${process.pid}-${Date.now()}`;
    const filepath = path.join(DONE_DIR, `${prefix}.json`);
    const fromEvent = `${prefix}-from`;
    const toEvent = `${prefix}-to`;
    const originalReadFile = fs.promises.readFile;
    let startRead;
    let releaseRead;
    const readStarted = new Promise((resolve) => { startRead = resolve; });
    const readReleased = new Promise((resolve) => { releaseRead = resolve; });
    let held = false;
    let reads = 0;

    fs.mkdirSync(DONE_DIR, { recursive: true });
    const oldAt = Date.now() - 2 * 60 * 60 * 1000;
    fs.writeFileSync(filepath, JSON.stringify({
        filePrefix: prefix, eventName: fromEvent, createdAt: oldAt, completedAt: oldAt,
        inputMode: "voice", voiceDeliveryKind: "result", voiceDeliveryState: "sent",
        voiceFollowupsAt: oldAt,
    }));
    fs.promises.readFile = async (...args) => {
        if (String(args[0]) === filepath) {
            reads++;
            if (!held) {
                held = true;
                const oldBytes = await originalReadFile(...args);
                startRead();
                await readReleased;
                return oldBytes;
            }
        }
        return originalReadFile(...args);
    };
    t.after(() => {
        releaseRead();
        fs.promises.readFile = originalReadFile;
        fs.rmSync(filepath, { force: true });
        fs.rmSync(require("../lib/settings").getDownloadDir(toEvent), { recursive: true, force: true });
    });

    const sweep = queue.sweepVoiceDeliveries();
    await readStarted;
    const [moved] = await queue.moveJobsToEvent([prefix], fromEvent, toEvent);
    assert.equal(moved.success, true);
    releaseRead();
    await sweep;

    reads = 0;
    await queue.sweepVoiceDeliveries();
    assert.ok(reads > 0, "the next pass must inspect a job changed during the previous read");
});

test("a new legacy-named job is delivered after the cache is warm", async (t) => {
    const prefix = `20261104_010000_${process.pid}_${Date.now()}`;
    const voicePath = path.join(FAILED_DIR, `${prefix}.json`);
    const kioskPrefix = `20261104_010001_${process.pid}_${Date.now()}`;
    const kioskPath = path.join(DONE_DIR, `${kioskPrefix}.json`);
    const eventName = `${prefix}_event`;
    const downloads = settings.getDownloadDir(eventName);
    const originalSend = messaging.send;
    const originalEmail = kioskEmail.sendKioskEmail;
    let voiceSends = 0;
    let kioskSends = 0;

    t.after(() => {
        messaging.send = originalSend;
        kioskEmail.sendKioskEmail = originalEmail;
        fs.rmSync(voicePath, { force: true });
        fs.rmSync(kioskPath, { force: true });
        fs.rmSync(downloads, { recursive: true, force: true });
    });

    await queue.sweepVoiceDeliveries();
    await queue.sweepKioskDeliveries();
    fs.mkdirSync(FAILED_DIR, { recursive: true });
    fs.mkdirSync(DONE_DIR, { recursive: true });
    fs.mkdirSync(downloads, { recursive: true });
    fs.writeFileSync(voicePath, JSON.stringify({
        filePrefix: path.basename(voicePath, ".json"), eventName,
        inputMode: "voice", channel: "sms", locale: "en",
        userPhone: "+14155550123", appPhone: "+12065550199",
        voiceDeliveryKind: "failure", voiceDeliveryState: "pending",
    }));
    fs.writeFileSync(kioskPath, JSON.stringify({
        filePrefix: kioskPrefix, eventName, baseUrl: "https://example.test",
        kioskSubmission: true, channel: "email", kioskEmail: "guest@example.test",
        kioskDeliveryState: "retry", kioskDeliveryNextAttemptAt: 0,
    }));
    fs.writeFileSync(path.join(downloads, `${kioskPrefix}_output.png`), "portrait");
    messaging.send = async () => { voiceSends++; return { sid: "SMcache-test" }; };
    kioskEmail.sendKioskEmail = async () => { kioskSends++; return { status: "accepted", providerId: "sg-cache-test" }; };

    await queue.sweepVoiceDeliveries();
    await queue.sweepKioskDeliveries();
    assert.equal(voiceSends, 1);
    assert.equal(kioskSends, 1);
    assert.equal(JSON.parse(fs.readFileSync(voicePath, "utf8")).voiceDeliveryState, "sent");
    assert.equal(JSON.parse(fs.readFileSync(kioskPath, "utf8")).kioskDeliveryState, "accepted");
});

test("a recently rewritten old job stays on the 30-second read path", async (t) => {
    const prefix = `delivery-rewrite-${process.pid}-${Date.now()}`;
    const filename = `${prefix}.json`;
    const filepath = path.join(DONE_DIR, filename);
    const oldAt = Date.now() - 2 * 60 * 60 * 1000;
    const originalReadFile = fs.promises.readFile;
    let reads = 0;

    fs.mkdirSync(DONE_DIR, { recursive: true });
    fs.writeFileSync(filepath, JSON.stringify({
        filePrefix: prefix, createdAt: oldAt, completedAt: oldAt,
        smsSentAt: oldAt, deliveryPending: true,
    }));
    t.after(() => {
        fs.promises.readFile = originalReadFile;
        fs.rmSync(filepath, { force: true });
    });

    await queue.sweepVoiceDeliveries();
    assert.equal(await queue.finishPendingRelayEffects(filepath, filename), true);
    fs.promises.readFile = async (...args) => {
        if (String(args[0]) === filepath) reads++;
        return originalReadFile(...args);
    };
    await queue.sweepVoiceDeliveries();
    reads = 0;
    await queue.sweepVoiceDeliveries();
    assert.ok(reads > 0, "a recent in-process write must keep old terminal jobs hot");
});

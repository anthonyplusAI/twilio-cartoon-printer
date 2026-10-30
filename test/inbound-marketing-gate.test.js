const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const SOURCE_ROOT = path.join(__dirname, "..");
const EVENT_NAME = "Consent Gate Test";
const STARTER = "Hit send to start! 🚀\n\nBy sending this text, I agree to Twilio’s Terms (twil.io/terms) and Privacy Notice (twil.io/privacy) for marketing communications.\n\nMsg & data rates apply.";
let fixtureRoot;
let captureFile;
let appProcess;
let appOutput = "";
let baseUrl;

async function availablePort() {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

function outboundMessages() {
    if (!fs.existsSync(captureFile)) return [];
    return fs.readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

async function sendInbound({ from, to = "+15551234567", body = "", sid, mediaUrl, optOutType, expectedStatus = 204 }) {
    const payload = new URLSearchParams({
        From: from, To: to, Body: body, MessageSid: sid,
        NumMedia: mediaUrl ? "1" : "0",
    });
    if (mediaUrl) payload.set("MediaUrl0", mediaUrl);
    if (optOutType) payload.set("OptOutType", optOutType);
    const response = await fetch(`${baseUrl}/inbound`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: payload,
    });
    assert.equal(response.status, expectedStatus, await response.text());
}

before(async () => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portrait-consent-gate-"));
    captureFile = path.join(fixtureRoot, "outbound.jsonl");
    for (const filename of ["index.js", "package.json"]) {
        fs.copyFileSync(path.join(SOURCE_ROOT, filename), path.join(fixtureRoot, filename));
    }
    for (const dirname of ["lib", "assets"]) {
        fs.cpSync(path.join(SOURCE_ROOT, dirname), path.join(fixtureRoot, dirname), { recursive: true });
    }
    fs.mkdirSync(path.join(fixtureRoot, "relay-app"));
    fs.copyFileSync(path.join(SOURCE_ROOT, "relay-app", "cups-command.js"),
        path.join(fixtureRoot, "relay-app", "cups-command.js"));
    fs.symlinkSync(path.join(SOURCE_ROOT, "node_modules"), path.join(fixtureRoot, "node_modules"), "dir");
    fs.mkdirSync(path.join(fixtureRoot, "data"));
    fs.writeFileSync(path.join(fixtureRoot, "data", "settings.json"), JSON.stringify({
        eventName: EVENT_NAME,
        languageMode: "ask",
        queuePaused: true,
    }));
    fs.writeFileSync(path.join(fixtureRoot, "stub-twilio.cjs"), `
const fs = require("node:fs");
const helpers = require("./lib/helpers");
let sequence = 0;
helpers.getTwilioClient = () => ({
    messages: { create: async (payload) => {
        if (payload.to === "+14155550129") {
            const marker = process.env.GATE_CAPTURE_FILE + ".failed-once";
            if (!fs.existsSync(marker)) {
                fs.writeFileSync(marker, "1");
                throw new Error("fixture send failure");
            }
        }
        fs.appendFileSync(process.env.GATE_CAPTURE_FILE, JSON.stringify(payload) + "\\n");
        return { sid: "SMtest" + (++sequence) };
    } },
    content: { v1: { contents: { create: async () => ({ sid: "HXtest" + (++sequence) }) } } },
});
`);

    const port = await availablePort();
    baseUrl = `http://127.0.0.1:${port}`;
    appProcess = spawn(process.execPath, ["-r", "./stub-twilio.cjs", "index.js"], {
        cwd: fixtureRoot,
        env: {
            ...process.env,
            NODE_ENV: "production",
            PORT: String(port),
            BASE_URL: baseUrl,
            EVENT_NAME: EVENT_NAME,
            TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
            TWILIO_AUTH_TOKEN: "fixture-token",
            TWILIO_PHONE_NUMBER: "+15551234567",
            TWILIO_WHATSAPP_NUMBER: "+15557654321",
            ADMIN_PHONES: "+14155550128",
            SESSION_SECRET: require("node:crypto").randomBytes(32).toString("hex"),
            OPENAI_API_KEY: "",
            SKIP_TWILIO_SIGNATURE_VALIDATION: "true",
            GATE_CAPTURE_FILE: captureFile,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    appProcess.stdout.on("data", (chunk) => { appOutput += chunk; });
    appProcess.stderr.on("data", (chunk) => { appOutput += chunk; });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (appProcess.exitCode !== null) break;
        try {
            const health = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) });
            if (health.ok) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Fixture app did not start:\n${appOutput}`);
});

after(async () => {
    if (appProcess && appProcess.exitCode === null) {
        appProcess.kill("SIGTERM");
        await new Promise((resolve) => appProcess.once("exit", resolve));
    }
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

test("an SMS greeting without the consent starter cannot enter the portrait flow", async () => {
    const phone = "+14155550123";
    await sendInbound({ from: phone, body: "Hi", sid: "SMgate-greeting" });

    const sent = outboundMessages();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, phone);
    assert.match(sent[0].body, /complete prefilled consent message/i);
    assert.ok(sent[0].body.includes(STARTER));
    assert.doesNotMatch(sent[0].body, /Choose your language/i);

    const contacts = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "data", "contacts.json"), "utf8"));
    assert.equal(contacts[`${phone}:${EVENT_NAME}`], undefined);
    assert.ok(contacts[`__session__:${phone}`]);

    await sendInbound({ from: phone, body: "Hi", sid: "SMgate-greeting" });
    assert.equal(outboundMessages().length, 1, "retrying the same webhook must not resend the prompt");
});

test("a direct WhatsApp photo is blocked before language or portrait processing", async () => {
    const phone = "+14155550124";
    const beforeCount = outboundMessages().length;
    await sendInbound({
        from: `whatsapp:${phone}`,
        to: "whatsapp:+15557654321",
        sid: "SMgate-photo",
        mediaUrl: "https://example.com/selfie.jpg",
    });

    const sent = outboundMessages().slice(beforeCount);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, `whatsapp:${phone}`);
    assert.match(sent[0].body, /complete prefilled consent message/i);
    assert.ok(sent[0].body.includes(STARTER));
    const contacts = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "data", "contacts.json"), "utf8"));
    assert.equal(contacts[`${phone}:${EVENT_NAME}`], undefined);
    assert.ok(contacts[`__session__:${phone}`].lastInboundAtByChannel.whatsapp);
});

test("sending the full SMS starter records consent and unlocks language selection", async () => {
    const phone = "+14155550125";
    const beforeCount = outboundMessages().length;
    await sendInbound({ from: phone, body: STARTER, sid: "SMgate-consent" });

    const sent = outboundMessages().slice(beforeCount);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /Choose your language/i);
    const contacts = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "data", "contacts.json"), "utf8"));
    assert.equal(contacts[`__marketing__:${phone}:sms:${EVENT_NAME}`].messageSid, "SMgate-consent");
    assert.ok(contacts[`${phone}:${EVENT_NAME}`]);

    await sendInbound({ from: phone, body: "1", sid: "SMgate-language" });
    const next = outboundMessages().slice(beforeCount + 1);
    assert.equal(next.length, 1);
    assert.match(next[0].body, /Send us a selfie/i);
});

test("sending the full WhatsApp starter records consent and unlocks language selection", async () => {
    const phone = "+14155550130";
    const from = `whatsapp:${phone}`;
    const to = "whatsapp:+15557654321";
    const beforeCount = outboundMessages().length;
    await sendInbound({ from, to, body: STARTER, sid: "SMgate-wa-consent" });

    const sent = outboundMessages().slice(beforeCount);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, from);
    assert.match(sent[0].contentSid, /^HXtest/);
    const contacts = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "data", "contacts.json"), "utf8"));
    assert.equal(contacts[`__marketing__:${phone}:whatsapp:${EVENT_NAME}`].messageSid, "SMgate-wa-consent");
    assert.ok(contacts[`${phone}:${EVENT_NAME}`]);

    await sendInbound({ from, to, body: "Português", sid: "SMgate-wa-language" });
    const next = outboundMessages().slice(beforeCount + 1);
    assert.equal(next.length, 1);
    assert.match(next[0].body, /Envie uma selfie/i);
});

test("SMS consent does not unlock WhatsApp, and STOP closes the SMS flow", async () => {
    const phone = "+14155550126";
    await sendInbound({ from: phone, body: STARTER, sid: "SMgate-consent-stop" });
    let beforeCount = outboundMessages().length;

    await sendInbound({
        from: `whatsapp:${phone}`, to: "whatsapp:+15557654321",
        body: "Hi", sid: "SMgate-other-channel",
    });
    let sent = outboundMessages().slice(beforeCount);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /complete prefilled consent message/i);

    beforeCount = outboundMessages().length;
    await sendInbound({ from: phone, body: "STOP", sid: "SMgate-stop", optOutType: "STOP" });
    assert.equal(outboundMessages().length, beforeCount);
    await sendInbound({ from: phone, body: "Hi", sid: "SMgate-after-stop" });
    sent = outboundMessages().slice(beforeCount);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /complete prefilled consent message/i);
    const contacts = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "data", "contacts.json"), "utf8"));
    assert.ok(contacts[`__marketing__:${phone}:sms:${EVENT_NAME}`].revokedAt);
});

test("HELP receives support guidance without beginning a portrait session", async () => {
    const phone = "+14155550127";
    const beforeCount = outboundMessages().length;
    await sendInbound({ from: phone, body: "HELP", sid: "SMgate-help" });

    const sent = outboundMessages().slice(beforeCount);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /help.*booth QR code/i);
    assert.doesNotMatch(sent[0].body, /Choose your language/i);
    const contacts = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "data", "contacts.json"), "utf8"));
    assert.equal(contacts[`${phone}:${EVENT_NAME}`], undefined);
});

test("an admin phone can still use the normal booth controls without a consent record", async () => {
    const phone = "+14155550128";
    const beforeCount = outboundMessages().length;
    await sendInbound({ from: phone, body: "Hi", sid: "SMgate-admin" });

    const sent = outboundMessages().slice(beforeCount);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /Choose your language/i);
    const contacts = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "data", "contacts.json"), "utf8"));
    assert.ok(contacts[`${phone}:${EVENT_NAME}`]);
    assert.equal(contacts[`__marketing__:${phone}:sms:${EVENT_NAME}`], undefined);
});

test("a failed consent prompt can be retried with the same inbound MessageSid", async () => {
    const phone = "+14155550129";
    const beforeCount = outboundMessages().length;
    const inbound = { from: phone, body: "Hi", sid: "SMgate-retry-send" };

    await sendInbound({ ...inbound, expectedStatus: 502 });
    assert.equal(outboundMessages().length, beforeCount);
    await sendInbound(inbound);
    const sent = outboundMessages().slice(beforeCount);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].body.includes(STARTER));
});

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const express = require("express");
const { once } = require("node:events");

const { readinessIssues } = require("../lib/voice/readiness");
const projectRoot = path.join(__dirname, "..");
const homePath = path.join(projectRoot, "lib", "home.js");
const dashboardPath = path.join(projectRoot, "lib", "dashboard.js");
const otherEvent = `Voice Readiness Other Event ${process.pid}`;
const originalBaseUrl = process.env.BASE_URL;
let fixtureRoot;
let settings;
let buildSettingsHtml;
let mountDashboard;
let originalLoad;

before(() => {
    // The Voice settings checks need a real settings module, but they must not
    // read or rewrite the operator's active event profile or credentials.
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "voice-readiness-"));
    const fixtureLib = path.join(fixtureRoot, "lib");
    fs.mkdirSync(path.join(fixtureLib, "voice"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "data", "events", "default"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "templates"), { recursive: true });
    for (const file of ["settings.js", "styles.js"]) {
        fs.copyFileSync(path.join(projectRoot, "lib", file), path.join(fixtureLib, file));
    }
    fs.copyFileSync(path.join(projectRoot, "lib", "voice", "readiness.js"),
        path.join(fixtureLib, "voice", "readiness.js"));
    fs.symlinkSync(path.join(projectRoot, "node_modules"), path.join(fixtureRoot, "node_modules"), "dir");
    fs.writeFileSync(path.join(fixtureRoot, "data", "settings.json"), JSON.stringify({ eventName: "default" }));
    fs.writeFileSync(path.join(fixtureRoot, "data", "events", "default", "settings.json"), "{}");

    process.env.BASE_URL = "https://booth.example";
    settings = require(path.join(fixtureLib, "settings.js"));
    settings.load();

    const config = Object.fromEntries(["pending", "generating", "review", "ready", "printing", "done", "failed"]
        .map((name) => [`${name.toUpperCase()}_DIR`, path.join(fixtureRoot, "queue", name)]));
    for (const dir of Object.values(config)) fs.mkdirSync(dir, { recursive: true });
    const auth = { userBarSnippet: () => "", magicHatSnippet: () => "", themeToggleButton: () => "" };
    const dashboardUnused = new Set([
        "./queue", "./pipeline", "./audit", "./leads", "./contacts", "./kiosk-submissions",
        "./nps", "./print-relay", "./dub", "./share-clicks", "./relay-jobs", "./event-summary",
        "./openai-models",
    ]);
    originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (parent?.filename.startsWith(path.join(projectRoot, "lib") + path.sep)) {
            if (request === "./settings" || request === "../settings") return settings;
            if (request === "./auth") return auth;
        }
        if (parent?.filename === dashboardPath) {
            if (request === "./config") return config;
            if (dashboardUnused.has(request)) return {};
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    ({ buildSettingsHtml } = require(homePath));
    ({ mountDashboard } = require(dashboardPath));
});

after(() => {
    if (originalLoad) Module._load = originalLoad;
    delete require.cache[homePath];
    delete require.cache[dashboardPath];
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
    if (originalBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = originalBaseUrl;
});

const ready = {
    twilioVoiceNumber: "+14155550100",
    twilioAccountSid: "ACtest",
    twilioAuthToken: "test-token",
    openaiApiKey: "test-key",
    leadCaptureMode: "disabled",
    twilioWhatsappNumber: "",
    twilioWhatsappMessagingServiceSid: "",
    contentTemplates: { en: {}, pt_BR: {} },
};

test("Voice readiness accepts a configured SMS-only booth and rejects missing local prerequisites", () => {
    assert.deepEqual(readinessIssues(ready, "https://booth.example"), []);
    assert.match(readinessIssues({ ...ready, twilioVoiceNumber: "" }, "https://booth.example").join(" "), /Voice number/);
    assert.match(readinessIssues(ready, "http://booth.example").join(" "), /HTTPS/);
    assert.match(readinessIssues({ ...ready, leadCaptureMode: "before" }, "https://booth.example").join(" "), /lead capture/);
    assert.match(readinessIssues({ ...ready, openaiApiKey: "" }, "https://booth.example").join(" "), /OpenAI/);
});

test("WhatsApp Voice readiness needs invitation, result, and failure templates in both languages", () => {
    const issues = readinessIssues({ ...ready, twilioWhatsappNumber: "+14155550101" }, "https://booth.example");
    assert.equal(issues.length, 6);
    assert.match(issues.join(" "), /en voiceInvitation/);
    assert.match(issues.join(" "), /en voiceDelivery/);
    assert.match(issues.join(" "), /pt_BR voiceFailure/);
    assert.deepEqual(readinessIssues({
        ...ready,
        twilioWhatsappNumber: "+14155550101",
        contentTemplates: {
            en: { voiceInvitation: "HXenInvite", voiceInvitationPhone: ready.twilioVoiceNumber,
                voiceDelivery: "HXenResult", voiceFailure: "HXenFail" },
            pt_BR: { voiceInvitation: "HXptInvite", voiceInvitationPhone: ready.twilioVoiceNumber,
                voiceDelivery: "HXptResult", voiceFailure: "HXptFail" },
        },
    }, "https://booth.example"), []);
    const staleButton = {
        ...ready, twilioWhatsappNumber: "+14155550101",
        contentTemplates: {
            en: { voiceInvitation: "HXenInvite", voiceInvitationPhone: "+14155550999",
                voiceDelivery: "HXenResult", voiceFailure: "HXenFail" },
            pt_BR: { voiceInvitation: "HXptInvite", voiceInvitationPhone: ready.twilioVoiceNumber,
                voiceDelivery: "HXptResult", voiceFailure: "HXptFail" },
        },
    };
    assert.match(readinessIssues(staleButton, "https://booth.example").join(" "),
        /en voiceInvitation.*phone.*Voice number/i);
});

test("changing the Voice number retains its old invitation binding until the approved SIDs change", () => {
    settings.update({ ...ready, enableVoice: false });
    const templates = {
        en: { voiceInvitation: "HXenInvite", voiceDelivery: "HXenResult", voiceFailure: "HXenFail" },
        pt_BR: { voiceInvitation: "HXptInvite", voiceDelivery: "HXptResult", voiceFailure: "HXptFail" },
    };
    settings.update({ twilioWhatsappNumber: "+14155550101", contentTemplates: templates, enableVoice: true });
    assert.equal(settings.get("contentTemplates").en.voiceInvitationPhone, ready.twilioVoiceNumber);
    assert.equal(settings.get("contentTemplates").pt_BR.voiceInvitationPhone, ready.twilioVoiceNumber);
    assert.throws(() => settings.update({ twilioVoiceNumber: "+14155550222", contentTemplates: templates }),
        /voiceInvitation.*phone.*Voice number/i);
    assert.throws(() => settings.update({ twilioVoiceNumber: "" }), /Voice number must be E\.164/);
    assert.equal(settings.get("twilioVoiceNumber"), ready.twilioVoiceNumber);
});

test("settings rejects Voice plus before-survey atomically and keeps Voice event-scoped", () => {
    const startingEvent = settings.get("eventName");
    settings.update({ ...ready, enableVoice: false });
    assert.throws(() => settings.update({ enableVoice: true, leadCaptureMode: "before" }), /Voice.*lead capture/);
    assert.equal(settings.get("enableVoice"), false);
    assert.equal(settings.get("leadCaptureMode"), "disabled");

    settings.update({ enableVoice: true });
    assert.equal(settings.get("enableVoice"), true);
    assert.equal(settings.get("twilioVoiceNumber"), "+14155550100");
    settings.update({ eventName: otherEvent });
    assert.equal(settings.get("enableVoice"), false);
    assert.equal(settings.get("twilioVoiceNumber"), "+14155550100");
    settings.update({ eventName: startingEvent });
    assert.equal(settings.get("enableVoice"), true);
    settings.update({ enableVoice: false });
});

test("settings API returns 400 and reasons for Voice plus before-survey", async () => {
    settings.update({ ...ready, enableVoice: false });
    const app = express();
    app.use((req, _res, next) => { req.user = { email: "test@example.com" }; next(); });
    mountDashboard(app);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/dashboard/api/settings`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ _forEvent: settings.get("eventName"), enableVoice: true, leadCaptureMode: "before" }),
        });
        assert.equal(response.status, 400);
        assert.match(JSON.stringify(await response.json()), /lead capture/);
        assert.equal(settings.get("enableVoice"), false);
    } finally {
        server.close();
    }
});

test("operator settings expose the Voice switch, number, invitation templates, and readiness note", () => {
    const html = buildSettingsHtml();
    assert.match(html, /id="sEnableVoice"/);
    assert.match(html, /id="sTwilioVoiceNumber"/);
    assert.match(html, /id="sCtVoiceInvitationEn"/);
    assert.match(html, /id="sCtVoiceInvitationPt"/);
    assert.match(html, /id="voiceReadiness"/);
    assert.match(html, /test call/i);
});

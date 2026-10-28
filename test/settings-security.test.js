const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");

function withTestEnv(values, run) {
    const previous = new Map();
    for (const [key, value] of Object.entries(values)) {
        previous.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try { return run(); } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

function isolatedSettings(active, profile = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-security-"));
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "data", "events", "unit"), { recursive: true });
    fs.mkdirSync(path.join(root, "templates"), { recursive: true });
    fs.copyFileSync(path.join(PROJECT_ROOT, "lib", "settings.js"), path.join(root, "lib", "settings.js"));
    fs.symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
    fs.writeFileSync(path.join(root, "data", "settings.json"), JSON.stringify({ eventName: "unit", ...active }));
    fs.writeFileSync(path.join(root, "data", "events", "unit", "settings.json"), JSON.stringify(profile));

    const modulePath = path.join(root, "lib", "settings.js");
    const load = () => {
        delete require.cache[require.resolve(modulePath)];
        const settings = require(modulePath);
        settings.load();
        return settings;
    };
    return { root, load };
}

test("browser settings omit credentials while deployment keys win over saved keys", () => {
    withTestEnv({
        EVENT_NAME: "unit",
        ADMIN_PHONES: "",
        OPENAI_API_KEY: "synthetic-openai-ABCD",
        DUB_API_KEY: "synthetic-dub-EFGH",
        TWILIO_AUTH_TOKEN: "synthetic-twilio-IJKL",
        PRINT_RELAY_KEY: "synthetic-relay-MNOP",
    }, () => {
        const fixture = isolatedSettings({
            maxPrints: 7,
            openaiApiKey: "saved-openai-OLD1",
            dubApiKey: "saved-dub-OLD2",
            twilioAuthToken: "saved-twilio-OLD3",
            printRelayKey: "saved-relay-OLD4",
        }, { reviewPin: "2468", maxPrints: 7 });
        try {
            const settings = fixture.load();
            assert.equal(settings.get("openaiApiKey"), "synthetic-openai-ABCD");
            assert.equal(settings.getAll().openaiApiKey, "synthetic-openai-ABCD");
            assert.equal(settings.get("dubApiKey"), "synthetic-dub-EFGH");
            assert.equal(settings.getAll().dubApiKey, "synthetic-dub-EFGH");

            const browser = settings.getBrowserSettings();
            assert.equal(browser.maxPrints, 7);
            for (const key of ["openaiApiKey", "twilioAuthToken", "dubApiKey", "printRelayKey", "reviewPin"]) {
                assert.equal(Object.hasOwn(browser, key), false, `${key} must not be sent to the browser`);
                assert.equal(browser.credentialStatus[key].configured, true);
            }
            assert.equal(browser.credentialStatus.openaiApiKey.last4, "ABCD");
            assert.doesNotMatch(JSON.stringify(browser), /synthetic-|saved-|2468/);
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });
});

test("reset retains saved connection routing and Dub link state", () => {
    withTestEnv({
        EVENT_NAME: "unit", ADMIN_PHONES: "", DUB_API_KEY: undefined, OPENAI_API_KEY: undefined,
        TWILIO_ACCOUNT_SID: undefined, TWILIO_PHONE_NUMBER: undefined,
        TWILIO_MESSAGING_SERVICE_SID: undefined, TWILIO_VOICE_NUMBER: undefined,
        TWILIO_WHATSAPP_NUMBER: undefined,
        TWILIO_WHATSAPP_MESSAGING_SERVICE_SID: undefined,
    }, () => {
        const fixture = isolatedSettings({
            dubApiKey: "saved-dub-OLD2",
            dubDomain: "go.example.test",
            dubFolderId: "folder-123",
            twilioAccountSid: "AC123",
            twilioPhoneNumber: "+14155550123",
            twilioMessagingServiceSid: "MG123",
            twilioVoiceNumber: "+14155550125",
            twilioWhatsappNumber: "whatsapp:+14155550124",
            twilioWhatsappMessagingServiceSid: "MG456",
            contentTemplates: { en: { delivery: "HX123" } },
            maxPrints: 9,
        }, {
            reviewPin: "2468", maxPrints: 9, dubSlugPrefix: "event", dubSlugCounter: 17,
        });
        try {
            let settings = fixture.load();
            assert.equal(settings.get("dubApiKey"), "saved-dub-OLD2");
            assert.equal(settings.getBrowserSettings().credentialStatus.dubApiKey.configured, true);
            settings.reset();
            settings = fixture.load();
            for (const [key, value] of Object.entries({
                dubApiKey: "saved-dub-OLD2",
                dubDomain: "go.example.test",
                dubFolderId: "folder-123",
                dubSlugPrefix: "event",
                dubSlugCounter: 17,
                twilioAccountSid: "AC123",
                twilioPhoneNumber: "+14155550123",
                twilioMessagingServiceSid: "MG123",
                twilioVoiceNumber: "+14155550125",
                twilioWhatsappNumber: "whatsapp:+14155550124",
                twilioWhatsappMessagingServiceSid: "MG456",
            })) {
                assert.equal(settings.get(key), value, key);
            }
            assert.equal(settings.get("contentTemplates").en.delivery, "HX123");
            assert.equal(settings.get("reviewPin"), "2468");
            assert.equal(settings.get("maxPrints"), settings.DEFAULTS.maxPrints);
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });
});

test("admin phone changes accept only unique E.164 numbers", () => {
    withTestEnv({ EVENT_NAME: "unit", ADMIN_PHONES: "" }, () => {
        const fixture = isolatedSettings({}, { adminPhones: ["+14155550111"] });
        try {
            const settings = fixture.load();
            settings.update({ adminPhones: ["+14155550111", "<img src=x>"] });
            assert.deepEqual(settings.get("adminPhones"), ["+14155550111"]);
            settings.update({ adminPhones: [" +14155550111 ", "+14155550111", "+447700900123"] });
            assert.deepEqual(settings.get("adminPhones"), ["+14155550111", "+447700900123"]);
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });
});

test("a short malformed OpenAI value is never disclosed in full as a suffix", () => {
    withTestEnv({ EVENT_NAME: "unit", OPENAI_API_KEY: "ABCD" }, () => {
        const fixture = isolatedSettings();
        try {
            const settings = fixture.load();
            const status = settings.getBrowserSettings().credentialStatus.openaiApiKey;
            assert.equal(status.configured, true);
            assert.equal(Object.hasOwn(status, "last4"), false);
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });
});

test("unknown inherited property names cannot become settings", () => {
    withTestEnv({ EVENT_NAME: "unit" }, () => {
        const fixture = isolatedSettings();
        try {
            const settings = fixture.load();
            settings.update(JSON.parse('{"__proto__":{"polluted":true}}'));
            assert.equal(settings.get("polluted"), undefined);
            assert.equal(settings.get("__proto__"), undefined);
            assert.equal(settings.getForEvent("__proto__", "other"), undefined);
        } finally {
            fs.rmSync(fixture.root, { recursive: true, force: true });
        }
    });
});

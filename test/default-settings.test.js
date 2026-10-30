const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT_ROOT = path.join(__dirname, "..");
const FIRST_MESSAGE = "Hit send to start! 🚀";
const OLD_MARKETING_MESSAGE = "Hit send to start! 🚀\n\nBy sending this text, I agree to Twilio’s Terms (twil.io/terms) and Privacy Notice (twil.io/privacy) for marketing communications.\n\nMsg & data rates apply.";
const NEW_EVENT_DEFAULTS = {
    enableFrameBorder: false,
    multiSubjectMode: "normal",
    reviewMode: "off",
    boothDisplayMode: "static",
    boothSmsInstructionText: FIRST_MESSAGE,
    boothWhatsappPrefillText: FIRST_MESSAGE,
    milestoneInterval: 10,
    revealAnimation: "pixel",
    enableShareLinks: true,
    sharePageOnly: false,
    enablePromoMessage: true,
    promoMessage: "Had fun? ⭐ Star the repo and build your own AI photo booth! https://github.com/anthonyplusAI/twilio-cartoon-printer",
};
const LEGACY_EVENT_DEFAULTS = {
    enableFrameBorder: true,
    multiSubjectMode: "reject",
    boothDisplayMode: "video",
    boothSmsInstructionText: FIRST_MESSAGE,
    boothWhatsappPrefillText: FIRST_MESSAGE,
    milestoneInterval: 100,
    revealAnimation: "off",
    enableShareLinks: false,
    enablePromoMessage: false,
    promoMessage: "",
};

function isolatedSettings({ active, profiles = {}, downloadEvents = [] } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "booth-new-defaults-"));
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "data", "events"), { recursive: true });
    fs.mkdirSync(path.join(root, "templates"), { recursive: true });
    fs.copyFileSync(path.join(PROJECT_ROOT, "lib", "settings.js"), path.join(root, "lib", "settings.js"));
    fs.symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
    if (active !== undefined) {
        fs.writeFileSync(path.join(root, "data", "settings.json"), JSON.stringify(active));
    }
    for (const [eventName, profile] of Object.entries(profiles)) {
        const eventDir = path.join(root, "data", "events", eventName);
        fs.mkdirSync(eventDir, { recursive: true });
        fs.writeFileSync(path.join(eventDir, "settings.json"), JSON.stringify(profile));
    }
    for (const eventName of downloadEvents) {
        fs.mkdirSync(path.join(root, "downloads", eventName), { recursive: true });
    }
    const modulePath = path.join(root, "lib", "settings.js");
    const load = () => {
        delete require.cache[modulePath];
        const previous = { EVENT_NAME: process.env.EVENT_NAME, PROMO_MESSAGE: process.env.PROMO_MESSAGE };
        delete process.env.EVENT_NAME;
        delete process.env.PROMO_MESSAGE;
        try {
            const settings = require(modulePath);
            settings.load();
            return settings;
        } finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    };
    const cleanup = () => {
        delete require.cache[modulePath];
        fs.rmSync(root, { recursive: true, force: true });
    };
    return { root, load, cleanup };
}

function assertEffectiveDefaults(settings, expected) {
    const all = settings.getAll();
    const browser = settings.getBrowserSettings();
    for (const [key, value] of Object.entries(expected)) {
        assert.equal(settings.get(key), value, `get(${key})`);
        assert.equal(all[key], value, `getAll().${key}`);
        assert.equal(browser[key], value, `browser.${key}`);
    }
}

test("a fresh event uses the requested attendee and gallery defaults", () => {
    const fixture = isolatedSettings();
    try {
        assertEffectiveDefaults(fixture.load(), NEW_EVENT_DEFAULTS);
    } finally {
        fixture.cleanup();
    }
});

test("loading a fresh install does not create a placeholder default event profile", () => {
    const fixture = isolatedSettings();
    try {
        const settings = fixture.load();
        const profilePath = path.join(fixture.root, "data", "events", "default", "settings.json");
        assert.equal(fs.existsSync(profilePath), false);
        assert.equal(fs.existsSync(path.join(fixture.root, "data", "settings.json")), false);

        settings.update({ maxPrints: 3 });
        assert.equal(JSON.parse(fs.readFileSync(profilePath, "utf-8"))._eventDefaultsVersion, 2);
        assert.equal(fixture.load().get("milestoneInterval"), 10);
    } finally {
        fixture.cleanup();
    }
});

test("a sparse existing event keeps its previous effective defaults after an unrelated edit", () => {
    const fixture = isolatedSettings({ active: { eventName: "legacy" }, profiles: { legacy: {} } });
    try {
        let settings = fixture.load();
        assertEffectiveDefaults(settings, LEGACY_EVENT_DEFAULTS);
        settings.update({ maxPrints: 3 });
        settings = fixture.load();
        assertEffectiveDefaults(settings, LEGACY_EVENT_DEFAULTS);
        assert.equal(settings.get("maxPrints"), 3);
    } finally {
        fixture.cleanup();
    }
});

test("loading upgrades only known old first-message values in active and event settings files", () => {
    const fixture = isolatedSettings({
        active: {
            eventName: "unprofiled",
            boothSmsInstructionText: "Hit send to start",
            boothWhatsappPrefillText: "Hi",
        },
        profiles: {
            old: { boothSmsInstructionText: "Hit send to start", boothWhatsappPrefillText: "Hi" },
            recent: { _eventDefaultsVersion: 2, boothSmsInstructionText: OLD_MARKETING_MESSAGE, boothWhatsappPrefillText: OLD_MARKETING_MESSAGE },
            custom: { boothSmsInstructionText: "Start SMS with a photo", boothWhatsappPrefillText: "Start WhatsApp with a photo" },
            empty: { boothSmsInstructionText: "", boothWhatsappPrefillText: "" },
        },
    });
    const readActive = () => JSON.parse(fs.readFileSync(path.join(fixture.root, "data", "settings.json"), "utf-8"));
    const readProfile = (name) => JSON.parse(fs.readFileSync(path.join(fixture.root, "data", "events", name, "settings.json"), "utf-8"));
    try {
        const settings = fixture.load();
        assert.equal(settings.get("boothSmsInstructionText"), FIRST_MESSAGE);
        assert.equal(settings.get("boothWhatsappPrefillText"), FIRST_MESSAGE);
        for (const data of [readActive(), readProfile("unprofiled"), readProfile("old"), readProfile("recent")]) {
            assert.equal(data.boothSmsInstructionText, FIRST_MESSAGE);
            assert.equal(data.boothWhatsappPrefillText, FIRST_MESSAGE);
        }
        assert.equal(readProfile("custom").boothSmsInstructionText, "Start SMS with a photo");
        assert.equal(readProfile("custom").boothWhatsappPrefillText, "Start WhatsApp with a photo");
        assert.equal(readProfile("empty").boothSmsInstructionText, "");
        assert.equal(readProfile("empty").boothWhatsappPrefillText, "");

        settings.update({ eventName: "old" });
        assert.equal(settings.get("boothSmsInstructionText"), FIRST_MESSAGE);
        assert.equal(settings.get("boothWhatsappPrefillText"), FIRST_MESSAGE);
        assert.equal(fixture.load().get("boothSmsInstructionText"), FIRST_MESSAGE);
    } finally {
        fixture.cleanup();
    }
});

test("an active existing event without a profile keeps its previous defaults", () => {
    const fixture = isolatedSettings({ active: { eventName: "unprofiled" } });
    try {
        const settings = fixture.load();
        assertEffectiveDefaults(settings, LEGACY_EVENT_DEFAULTS);
        assert.equal(settings.getForEvent("milestoneInterval", "unprofiled"), 100);
    } finally {
        fixture.cleanup();
    }
});

test("a downloads-only existing event is not mistaken for a new event", () => {
    const fixture = isolatedSettings({
        active: { eventName: "legacy" }, profiles: { legacy: {} }, downloadEvents: ["old-photos"],
    });
    try {
        const settings = fixture.load();
        assert.equal(settings.getForEvent("milestoneInterval", "old-photos"), 100);
        settings.update({ eventName: "old-photos" });
        assertEffectiveDefaults(settings, LEGACY_EVENT_DEFAULTS);
    } finally {
        fixture.cleanup();
    }
});

test("a new event retains its new defaults through event switches and restart", () => {
    const fixture = isolatedSettings({ active: { eventName: "legacy" }, profiles: { legacy: {} } });
    try {
        let settings = fixture.load();
        settings.update({ eventName: "new-event" });
        assertEffectiveDefaults(settings, NEW_EVENT_DEFAULTS);
        assert.equal(settings.getForEvent("milestoneInterval", "legacy"), 100);
        settings.update({ maxPrints: 4 });
        settings.update({ eventName: "legacy" });
        assertEffectiveDefaults(settings, LEGACY_EVENT_DEFAULTS);
        assert.equal(settings.getForEvent("milestoneInterval", "new-event"), 10);
        settings.update({ eventName: "new-event" });
        settings = fixture.load();
        assertEffectiveDefaults(settings, NEW_EVENT_DEFAULTS);
        assert.equal(settings.get("maxPrints"), 4);
    } finally {
        fixture.cleanup();
    }
});

test("explicit existing event choices survive the new baseline", () => {
    const fixture = isolatedSettings({
        active: { eventName: "legacy" },
        profiles: { legacy: { enableFrameBorder: false, milestoneInterval: 25, enableShareLinks: true } },
    });
    try {
        const settings = fixture.load();
        assert.equal(settings.get("enableFrameBorder"), false);
        assert.equal(settings.getForEvent("milestoneInterval", "legacy"), 25);
        assert.equal(settings.get("enableShareLinks"), true);
        assert.equal(settings.get("multiSubjectMode"), "reject");
    } finally {
        fixture.cleanup();
    }
});

test("explicitly empty first-message fields stay empty in saved event settings", () => {
    const fixture = isolatedSettings({
        active: { eventName: "legacy" },
        profiles: { legacy: { boothSmsInstructionText: "", boothWhatsappPrefillText: "" } },
    });
    try {
        const settings = fixture.load();
        for (const key of ["boothSmsInstructionText", "boothWhatsappPrefillText"]) {
            assert.equal(settings.get(key), "", `legacy get(${key})`);
            assert.equal(settings.getAll()[key], "", `legacy getAll().${key}`);
            assert.equal(settings.getBrowserSettings()[key], "", `legacy browser.${key}`);
        }

        settings.update({ eventName: "new-event" });
        assert.equal(settings.getForEvent("boothSmsInstructionText", "legacy"), "");
        assert.equal(settings.getForEvent("boothWhatsappPrefillText", "legacy"), "");
        settings.update({ boothSmsInstructionText: "", boothWhatsappPrefillText: "" });
        for (const key of ["boothSmsInstructionText", "boothWhatsappPrefillText"]) {
            assert.equal(settings.get(key), "", `new get(${key})`);
            assert.equal(settings.getAll()[key], "", `new getAll().${key}`);
            assert.equal(settings.getBrowserSettings()[key], "", `new browser.${key}`);
        }
    } finally {
        fixture.cleanup();
    }
});

test("reset intentionally adopts and persists the new event defaults", () => {
    const fixture = isolatedSettings({ active: { eventName: "legacy" }, profiles: { legacy: {} } });
    try {
        let settings = fixture.load();
        settings.reset();
        assertEffectiveDefaults(settings, NEW_EVENT_DEFAULTS);
        settings = fixture.load();
        assertEffectiveDefaults(settings, NEW_EVENT_DEFAULTS);
    } finally {
        fixture.cleanup();
    }
});

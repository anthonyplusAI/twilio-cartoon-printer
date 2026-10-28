const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("node:os");
const path = require("path");

const projectRoot = path.join(__dirname, "..");
let fixtureRoot;
let fixtureSettingsPath;

before(() => {
    // Run against a synthetic installation so validation cannot inspect or
    // rewrite the operator's active event, profile, or environment secrets.
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "settings-combo-"));
    const fixtureLib = path.join(fixtureRoot, "lib");
    fs.mkdirSync(path.join(fixtureLib, "voice"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "data", "events", "default"), { recursive: true });
    fs.mkdirSync(path.join(fixtureRoot, "templates"), { recursive: true });
    fixtureSettingsPath = path.join(fixtureLib, "settings.js");
    const settingsSource = fs.readFileSync(path.join(projectRoot, "lib", "settings.js"), "utf8");
    fs.writeFileSync(fixtureSettingsPath,
        'const process = { pid: require("node:process").pid, env: Object.create(null) };\n' + settingsSource);
    fs.copyFileSync(path.join(projectRoot, "lib", "styles.js"), path.join(fixtureLib, "styles.js"));
    fs.copyFileSync(path.join(projectRoot, "lib", "voice", "readiness.js"),
        path.join(fixtureLib, "voice", "readiness.js"));
    fs.symlinkSync(path.join(projectRoot, "node_modules"), path.join(fixtureRoot, "node_modules"), "dir");
    fs.writeFileSync(path.join(fixtureRoot, "data", "settings.json"), JSON.stringify({ eventName: "default" }));
    fs.writeFileSync(path.join(fixtureRoot, "data", "events", "default", "settings.json"), "{}");
});

after(() => {
    if (fixtureSettingsPath) delete require.cache[fixtureSettingsPath];
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

function freshSettings() {
    delete require.cache[fixtureSettingsPath];
    const s = require(fixtureSettingsPath);
    s.load();
    return s;
}

test("attendee language defaults to English and validates runtime modes", () => {
    const settings = freshSettings();
    assert.equal(settings.DEFAULTS.languageMode, "en");

    settings.update({ languageMode: "pt_BR" });
    assert.equal(settings.get("languageMode"), "pt_BR");

    settings.update({ languageMode: "invalid" });
    assert.equal(settings.get("languageMode"), "pt_BR");

    settings.update({ languageMode: "ask" });
    assert.equal(settings.get("languageMode"), "ask");
});

test("existing events offer Unbranded by default and can disable it", () => {
    const settings = freshSettings();
    assert.equal(settings.getForEvent("offerUnbranded", "missing-unbranded-setting-test"), true);

    settings.update({ offerUnbranded: false });
    assert.equal(freshSettings().get("offerUnbranded"), false);
});

test("deployment template SIDs override stale persisted values", () => {
    const settings = freshSettings();
    const original = settings.DEFAULTS.contentTemplates.en.delivery;
    settings.DEFAULTS.contentTemplates.en.delivery = "HXenvironment";
    settings.update({ contentTemplates: { en: { delivery: "HXpersisted" } } });
    assert.equal(settings.getContentSid("delivery", "en"), "HXenvironment");
    settings.DEFAULTS.contentTemplates.en.delivery = original;
});

test("customStyles accepts behavior field", () => {
    const settings = freshSettings();
    settings.update({
        customStyles: {
            "test-style": {
                name: "Test Style",
                prompt: "A test style prompt.",
                behavior: "themed-container",
                acceptsColorPalette: false,
                containerDescription: "Subject inside a test container.",
            },
        },
    });
    const stored = settings.get("customStyles")["test-style"];
    assert.equal(stored.behavior, "themed-container");
    assert.equal(stored.acceptsColorPalette, false);
    assert.equal(stored.containerDescription, "Subject inside a test container.");
});

test("localized option labels survive settings validation", () => {
    const settings = freshSettings();
    settings.update({
        customStyles: {
            oil: {
                name: "Oil Painting",
                prompt: "Paint the portrait.",
                description: "Textured paint",
                labels: { pt_BR: { name: "Pintura a óleo", description: "Pintura com textura" } },
            },
        },
        backgroundChoices: [{
            key: "city",
            name: "City",
            prompt: "City background",
            labels: { pt_BR: { name: "Cidade", description: "Paisagem urbana" } },
        }],
    });
    assert.equal(settings.get("customStyles").oil.labels.pt_BR.name, "Pintura a óleo");
    assert.equal(settings.get("backgroundChoices")[0].labels.pt_BR.name, "Cidade");
});

test("customStyles missing new fields loads cleanly (backward compat)", () => {
    const settings = freshSettings();
    settings.update({
        customStyles: {
            "legacy-style": {
                name: "Legacy",
                prompt: "Legacy prompt.",
            },
        },
    });
    const stored = settings.get("customStyles")["legacy-style"];
    assert.equal(stored.name, "Legacy");
    assert.ok(!("behavior" in stored) || stored.behavior === undefined);
});

test("customStyles invalid behavior value is dropped", () => {
    const settings = freshSettings();
    settings.update({
        customStyles: {
            "bad-style": {
                name: "Bad",
                prompt: "Bad prompt.",
                behavior: "banana",
            },
        },
    });
    const stored = settings.get("customStyles")["bad-style"];
    assert.ok(!("behavior" in stored) || stored.behavior === undefined,
        `Invalid behavior "banana" should have been dropped; got ${stored.behavior}`);
});

test("customBrands accepts category, scenes, allowOriginal, wardrobe, colorPalette", () => {
    const settings = freshSettings();
    settings.update({
        customBrands: {
            "test-brand": {
                name: "Test Brand",
                brandPrompt: "legacy prompt",
                category: "wardrobe-plus-scene",
                wardrobe: "test wardrobe fragment",
                allowOriginal: false,
                colorPalette: "Recolor everything red.",
                scenes: [
                    { key: "scene-a", name: "Scene A", prompt: "Scene A prompt." },
                    { key: "scene-b", name: "Scene B", prompt: "Scene B prompt." },
                ],
            },
        },
    });
    const stored = settings.get("customBrands")["test-brand"];
    assert.equal(stored.category, "wardrobe-plus-scene");
    assert.equal(stored.wardrobe, "test wardrobe fragment");
    assert.equal(stored.allowOriginal, false);
    assert.equal(stored.colorPalette, "Recolor everything red.");
    assert.equal(stored.scenes.length, 2);
    assert.equal(stored.scenes[0].key, "scene-a");
    assert.equal(stored.scenes[0].name, "Scene A");
    assert.equal(stored.scenes[0].prompt, "Scene A prompt.");
});

test("customBrands legacy shape loads cleanly (backward compat)", () => {
    const settings = freshSettings();
    settings.update({
        customBrands: {
            "legacy-brand": {
                name: "Legacy",
                brandPrompt: "legacy text",
                files: ["ref1.png"],
            },
        },
    });
    const stored = settings.get("customBrands")["legacy-brand"];
    assert.equal(stored.name, "Legacy");
    assert.equal(stored.brandPrompt, "legacy text");
    assert.deepEqual(stored.files, ["ref1.png"]);
});

test("customBrands invalid category is dropped", () => {
    const settings = freshSettings();
    settings.update({
        customBrands: {
            "bad-brand": {
                name: "Bad",
                brandPrompt: "x",
                category: "banana",
            },
        },
    });
    const stored = settings.get("customBrands")["bad-brand"];
    assert.ok(!("category" in stored) || stored.category === undefined,
        `Invalid category "banana" should be dropped; got ${stored.category}`);
});

test("customBrands invalid scene entries are filtered out", () => {
    const settings = freshSettings();
    settings.update({
        customBrands: {
            "filter-brand": {
                name: "Filter",
                brandPrompt: "x",
                scenes: [
                    { key: "ok", name: "OK scene", prompt: "ok." },
                    { name: "missing key" },
                    "not an object",
                    { key: "nokey-no-name" },
                ],
            },
        },
    });
    const stored = settings.get("customBrands")["filter-brand"];
    assert.equal(stored.scenes.length, 1, "only the valid scene should survive");
    assert.equal(stored.scenes[0].key, "ok");
});

test("pickupLocation is trimmed and persisted per event", () => {
    const settings = freshSettings();
    settings.update({ pickupLocation: "  Twilio Experience Station  " });
    assert.equal(settings.get("pickupLocation"), "Twilio Experience Station");
});

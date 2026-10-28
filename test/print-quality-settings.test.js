const { test } = require("node:test");
const assert = require("node:assert/strict");

const settings = require("../lib/settings");
const { buildSettingsHtml } = require("../lib/home");

test("maximum print quality matches the supported 720 DPI in settings and UI", () => {
    assert.equal(settings.PRINT_QUALITIES.max, "720x720dpi");
    const html = buildSettingsHtml();
    assert.match(html, /Max \(720 DPI\)/);
    assert.doesNotMatch(html, /1440 DPI/);
});

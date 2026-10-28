const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { buildSettingsHtml } = require("../lib/home");

function renderPreview(offerUnbranded, brands) {
    const html = buildSettingsHtml();
    const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1])
        .find((body) => body.includes("function renderBrandMessagesPreview()"));
    assert.ok(script, "settings page has a runnable brand preview");

    const preview = { innerHTML: "" };
    const elements = {
        brandMessagesPreview: preview,
        msgBrandMenuIntro: { value: "Choose branding" },
        msgBrandMenuFooter: { value: "Reply with a number" },
    };
    const context = {
        document: {
            getElementById: (id) => elements[id] || null,
            addEventListener: () => {},
            createElement: () => ({
                set textContent(value) {
                    this.innerHTML = String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                },
                innerHTML: "",
            }),
        },
    };
    vm.createContext(context);
    // The settings page bootstraps browser-only navigation after these helpers.
    vm.runInContext(script.split("document.getElementById('themeLabel').textContent =")[0], context);
    context._customBrands = brands;
    context._disabledBrands = [];
    context._offerUnbranded = offerUnbranded;
    context.renderBrandMessagesPreview();
    return preview.innerHTML;
}

test("brand message preview shows Unbranded when attendees can choose it", () => {
    const preview = renderPreview(true, { "la-kings": { name: "LA Kings" } });
    assert.match(preview, /1\. LA Kings/);
    assert.match(preview, /2\. Unbranded/);
});

test("brand message preview explains the skipped menu for one required brand", () => {
    const preview = renderPreview(false, { "la-kings": { name: "LA Kings" } });
    assert.match(preview, /LA Kings/);
    assert.match(preview, /automatically/);
    assert.doesNotMatch(preview, /Unbranded/);
});

test("brand message preview lists only enabled brands when Unbranded is removed", () => {
    const preview = renderPreview(false, {
        "la-kings": { name: "LA Kings" },
        twilio: { name: "Twilio" },
    });
    assert.match(preview, /1\. LA Kings/);
    assert.match(preview, /2\. Twilio/);
    assert.doesNotMatch(preview, /Unbranded/);
});

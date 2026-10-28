const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// These renderers only need event display values. Provide them in memory so
// navigation tests never load or write an operator's saved settings.
const settingsPath = require.resolve("../lib/settings");
require.cache[settingsPath] = {
    id: settingsPath,
    filename: settingsPath,
    loaded: true,
    exports: {
        get: (key) => ({ eventName: "Synthetic Event", breakMessage: "" })[key],
        getForEvent: () => "en",
    },
};

const { buildPageHtml } = require("../lib/photogallery-page");
const { buildReviewQueueHtml } = require("../lib/review-queue-page");
const { buildMobileSettingsHtml } = require("../lib/review-settings-page");

const NAV_LABELS = ["Home", "Dashboard", "Gallery", "Outreach", "Review", "Prompt Lab", "Logs", "Settings"];

function adminLinks(html) {
    const links = html.match(/<nav class="site-nav-links"[^>]*>([\s\S]*?)<\/nav>/);
    assert.ok(links, "admin page should have the shared desktop menu");
    return [...links[1].matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((match) => match[1]);
}

test("admin Gallery and Review pages render the same menu with the correct active link", () => {
    const pages = [
        [buildPageHtml("Synthetic Event", "en", { adminNav: true }), "Gallery"],
        [buildReviewQueueHtml({ adminNav: true }), "Review"],
        [buildMobileSettingsHtml({ adminNav: true }), "Review"],
    ];

    for (const [html, active] of pages) {
        assert.deepEqual(adminLinks(html), NAV_LABELS);
        assert.match(html, /href="\/assets\/site-nav\.css"/);
        assert.match(html, new RegExp(`<a class="site-nav-link is-active"[^>]*aria-current="page">${active}<`));
        assert.doesNotMatch(html, /\{\{(?:SITE_NAV|GALLERY_BRAND|REVIEW_HEADER_LABEL|STAFF_NAV)/);
    }
});

test("public Gallery and PIN-only Review pages do not reveal admin navigation", () => {
    const gallery = buildPageHtml("Synthetic Event", "en");
    const queue = buildReviewQueueHtml();
    const settings = buildMobileSettingsHtml();

    for (const html of [gallery, queue, settings]) {
        assert.doesNotMatch(html, /class="site-nav(?:\s|\")/);
        assert.doesNotMatch(html, /href="\/(?:home|dashboard|outreach|eval)(?:\/|\?|\")/);
    }
    assert.match(gallery, /class="gallery-brand"/);
    assert.match(queue, /aria-label="Review navigation"/);
    assert.match(settings, /aria-label="Review navigation"/);
    assert.doesNotMatch(settings, /Switch event in Home settings/);
});

test("Gallery hides admin menu during embedded and fullscreen display", () => {
    const css = fs.readFileSync(path.join(__dirname, "../assets/gallery-workspace.css"), "utf8");
    assert.match(css, /html\.combo-embedded \.site-nav/);
    assert.match(css, /\.scene\.fs-active > \.site-nav/);
    assert.match(css, /:fullscreen \.site-nav/);
});

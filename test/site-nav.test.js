const test = require("node:test");
const assert = require("node:assert/strict");
const { NAV_ITEMS, renderSiteNav, siteNavStylesheet } = require("../lib/site-nav");
const { renderLogsPage } = require("../lib/logs-page");
const { buildOutreachHtml } = require("../lib/outreach-page");
const { pageShell, evalNav } = require("../lib/eval-page");

test("shared admin menu has the same ordered links and one current page", () => {
    assert.deepEqual(NAV_ITEMS.map((item) => item.label), [
        "Home", "Dashboard", "Gallery", "Outreach", "Review", "Prompt Lab", "Logs", "Settings",
    ]);
    for (const item of NAV_ITEMS) {
        const html = renderSiteNav(item.key);
        const desktop = html.match(/<nav class="site-nav-links"[^>]*>(.*?)<\/nav>/s)?.[1];
        assert.ok(desktop, `desktop navigation for ${item.key}`);
        assert.deepEqual([...desktop.matchAll(/href="([^"]+)"/g)].map((match) => match[1]), NAV_ITEMS.map((link) => link.href));
        assert.match(desktop, new RegExp(`href="${item.href.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" aria-current="page"`));
        assert.equal((desktop.match(/aria-current="page"/g) || []).length, 1);
        assert.match(html, /<details class="site-nav-mobile">/);
        assert.equal((html.match(/aria-current="page"/g) || []).length, 2);
    }
});

test("Logs, Outreach, and Prompt Lab use the shared navigation stylesheet", () => {
    const pages = [
        ["logs", renderLogsPage()],
        ["outreach", buildOutreachHtml()],
        ["eval", pageShell({ title: "Synthetic", body: evalNav("runs") })],
    ];
    for (const [active, html] of pages) {
        assert.ok(html.includes(siteNavStylesheet()), `${active} stylesheet`);
        assert.ok(html.includes(renderSiteNav(active)), `${active} menu`);
        assert.equal((html.match(/<nav class="site-nav-links"/g) || []).length, 1, `${active} desktop menu`);
    }
});

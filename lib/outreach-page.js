// Small, predictable list responses for the Outreach workspace. Keep the
// filtering before slicing so a search can find records on later pages.
const fs = require("node:fs");
const path = require("node:path");
const { renderSiteNav, siteNavStylesheet } = require("./site-nav");
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;
const HTML_TEMPLATE = fs.readFileSync(path.join(__dirname, "outreach-page.html"), "utf8");

// Preview can render the exact page without importing the live Outreach
// router or touching job and contact stores.
function buildOutreachHtml({ userBar = "", magicHat = "" } = {}) {
    return HTML_TEMPLATE.replace("<!--SITE_NAV_STYLESHEET-->", siteNavStylesheet())
        .replace("<!--SITE_NAV-->", renderSiteNav("outreach"))
        .replace("<!--USER_BAR-->", userBar)
        .replace("<!--MAGIC_HAT-->", magicHat);
}

function positiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function paginateRows(rows, query = {}, matches) {
    const limit = Math.min(MAX_LIMIT, positiveInteger(query.limit, DEFAULT_LIMIT));
    const search = String(query.q || "").trim().toLocaleLowerCase().slice(0, 100);
    const filtered = search && matches ? rows.filter((row) => matches(row, search)) : rows;
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(pages, positiveInteger(query.page, 1));
    const start = (page - 1) * limit;
    return { items: filtered.slice(start, start + limit), total, page, pages, limit };
}

module.exports = { paginateRows, buildOutreachHtml, DEFAULT_LIMIT, MAX_LIMIT };

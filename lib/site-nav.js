// Shared navigation for the authenticated admin workspaces.
const NAV_ITEMS = Object.freeze([
    { key: "home", label: "Home", href: "/home/" },
    { key: "dashboard", label: "Dashboard", href: "/dashboard/" },
    { key: "gallery", label: "Gallery", href: "/photogallery/" },
    { key: "outreach", label: "Outreach", href: "/outreach/" },
    { key: "review", label: "Review", href: "/review/queue" },
    { key: "eval", label: "Prompt Lab", href: "/eval" },
    { key: "logs", label: "Logs", href: "/dashboard/logs/" },
    { key: "settings", label: "Settings", href: "/home/settings" },
]);

function navLinks(active) {
    return NAV_ITEMS.map(({ key, label, href }) =>
        `<a class="site-nav-link${key === active ? " is-active" : ""}" href="${href}"${key === active ? ' aria-current="page"' : ""}>${label}</a>`
    ).join("");
}

function renderSiteNav(active) {
    const current = NAV_ITEMS.find((item) => item.key === active);
    return `<header class="site-nav">
  <a class="site-nav-brand" href="/home/" aria-label="Twilio Photobooth home"><img src="/assets/icon-twilio-bug-red.svg" width="26" height="26" alt=""><span>Twilio Photobooth</span></a>
  <nav class="site-nav-links" aria-label="Main navigation">${navLinks(active)}</nav>
  <details class="site-nav-mobile"><summary><span>Menu</span><span class="site-nav-current">${current ? current.label : ""}</span><span class="site-nav-chevron" aria-hidden="true"></span></summary><nav aria-label="Main navigation">${navLinks(active)}</nav></details>
</header>`;
}

function siteNavStylesheet() {
    return '<link rel="stylesheet" href="/assets/site-nav.css">';
}

module.exports = { NAV_ITEMS, renderSiteNav, siteNavStylesheet };

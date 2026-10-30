#!/usr/bin/env node
// Local, read-only layout preview. It never loads .env, index.js, or saved event data.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const fixtures = require("./preview-fixtures");
const { DEFAULT_FIRST_MESSAGE } = require("../lib/channel-entry");

function isolatePreviewEnvironment() {
    // Keep the standalone preview independent of any app credentials in the shell.
    const inheritedPath = process.env.PATH;
    for (const key of Object.keys(process.env)) delete process.env[key];
    if (inheritedPath) process.env.PATH = inheritedPath;
    process.env.NODE_ENV = "development";
}

const assetsDir = path.resolve(__dirname, "../assets");
const HOST = "127.0.0.1";
const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".otf": "font/otf",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};

function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
}

function previewChannelMode(value) {
    return ["sms", "whatsapp", "both"].includes(value) ? value : "both";
}

function previewSetting(key, mode) {
    if (key === "boothShowSms") return mode !== "whatsapp";
    if (key === "boothShowWhatsapp") return mode !== "sms";
    return fixtureSettings[key];
}

function buildDraftPreviewHtml({ channel, recipient, body, eventName, locale, mode }) {
    const channelName = channel === "sms" ? "SMS" : "WhatsApp";
    const backHref = "/start?" + new URLSearchParams({ event: eventName, lang: locale, channels: mode }).toString();
    return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>${channelName} draft preview — Twilio Photobooth</title>
<style>
  * { box-sizing: border-box; }
  body { min-height: 100vh; margin: 0; background: var(--th-bg, #000D25); color: var(--th-text); }
  main { width: min(100%, 620px); margin: 0 auto; padding: 40px 22px 70px; }
  .back { color: var(--blue-300); font-size: 14px; text-underline-offset: 3px; }
  .badge { display: inline-block; margin: 28px 0 18px; padding: 7px 11px; border: 1px solid var(--th-card-border); border-radius: 999px; color: var(--th-text-secondary); background: var(--th-card); font-size: 12px; font-weight: 700; }
  h1 { margin: 0 0 12px; font-size: clamp(34px, 8vw, 48px); line-height: 1.08; }
  .intro { margin: 0 0 28px; color: var(--th-text-dim); font-size: 16px; line-height: 1.5; }
  .phone { overflow: hidden; border: 1px solid var(--th-card-border); border-radius: 28px; background: var(--th-card); box-shadow: 0 20px 60px var(--th-card-shadow); }
  .phone-top { padding: 17px 22px; border-bottom: 1px solid var(--th-card-border); text-align: center; font-size: 15px; font-weight: 700; }
  .to { padding: 14px 20px; border-bottom: 1px solid var(--th-card-border); color: var(--th-text-dim); font-size: 13px; }
  .to strong { color: var(--th-text); }
  .conversation { min-height: 260px; display: flex; align-items: flex-end; padding: 28px 18px; }
  .bubble { max-width: 95%; margin-left: auto; padding: 16px 18px; border-radius: 18px 18px 5px 18px; background: var(--blue-400); color: white; font-size: 15px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
  .composer { display: flex; gap: 10px; align-items: center; padding: 12px 16px; border-top: 1px solid var(--th-card-border); color: var(--th-text-muted); font-size: 12px; }
  .composer span { flex: 1; padding: 11px 15px; border: 1px solid var(--th-card-border); border-radius: 999px; }
  .send { width: 35px; height: 35px; display: grid; place-items: center; border-radius: 50%; background: var(--th-raised); color: var(--th-text-muted); }
  .note { margin: 18px 0 0; color: var(--th-text-muted); font-size: 13px; line-height: 1.5; }
</style>
</head>
<body>
<main>
  <a class="back" href="${escapeHtml(backHref)}">← Back to event start</a>
  <div><span class="badge">Preview only · no message sent</span></div>
  <h1>${channelName} message draft</h1>
  <p class="intro">In the live experience, this opens ${channelName} with the message below. The attendee then taps Send to start.</p>
  <div class="phone">
    <div class="phone-top">${channelName}</div>
    <div class="to">To: <strong>${escapeHtml(recipient)}</strong></div>
    <div class="conversation"><div class="bubble">${escapeHtml(body)}</div></div>
    <div class="composer"><span>Message ready to send</span><div class="send" aria-hidden="true">↑</div></div>
  </div>
  <p class="note">Every starter draft includes the Twilio Terms, Privacy Notice, and marketing consent text. This preview never opens a messaging app or contacts Twilio.</p>
</main>
</body>
</html>`;
}

const fixtureSettings = Object.freeze({
    eventName: "DEMO EVENT",
    languageMode: "en",
    maxPrints: 2,
    maxConcurrentGeneration: 3,
    queuePaused: false,
    enablePrinting: true,
    enableFrameBorder: false,
    multiSubjectMode: "normal",
    reviewMode: "off",
    boothDisplayMode: "static",
    boothShowSms: true,
    boothSmsInstructionText: DEFAULT_FIRST_MESSAGE,
    twilioPhoneNumber: "+14155550199",
    // Both channels are enabled in this demo to showcase the single-QR selector.
    boothShowWhatsapp: true,
    boothWhatsappPrefillText: DEFAULT_FIRST_MESSAGE,
    twilioWhatsappNumber: "whatsapp:+14155550198",
    enablePromoMessage: true,
    promoMessage: "Had fun? ⭐ Star the repo and build your own AI photo booth! https://github.com/anthonyplusAI/twilio-cartoon-printer",
    enableShareLinks: true,
    sharePageOnly: false,
    revealAnimation: "pixel",
    milestonesEnabled: true,
    milestoneInterval: 10,
    modelOrchestrator: "gpt-5.5",
    modelVisionLight: "gpt-5.4-nano",
    modelImageGen: "gpt-image-2-2026-04-21",
    modelSmartReply: "gpt-5.4-nano",
    modelRefAnalysis: "gpt-5.5",
    voiceReadinessIssues: ["Voice number must be E.164", "Public HTTPS BASE_URL is required"],
    credentialStatus: {
        openaiApiKey: { configured: true, last4: "0000" },
        twilioAuthToken: { configured: true },
        dubApiKey: { configured: false },
        printRelayKey: { configured: false },
        reviewPin: { configured: true },
    },
});
const fixtureFiles = Object.freeze({
    events: ["DEMO EVENT", "SECOND DEMO EVENT"],
    eventProfiles: ["DEMO EVENT"],
    printers: [], templates: [], videos: [],
    brandReferences: [], styleReferences: [], backgroundReferences: [],
});

function buildComboPreviewHtml() {
    return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>Booth Display — Twilio Photobooth</title>
<style>
  * { margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: var(--th-bg, #000D25); }
  .split { display: flex; width: 100%; height: 100%; }
  .split iframe { border: none; height: 100%; }
  #leftPane, #rightPane { flex: 1; }
  .handle { width: 8px; flex-shrink: 0; cursor: col-resize; background: var(--th-card, rgba(255,255,255,0.06)); position: relative; z-index: 10; }
  .handle::after { content: ''; position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); width: 3px; height: 36px; border-radius: 2px; background: var(--th-text-muted, rgba(255,255,255,0.25)); }
  .drag-overlay { display: none; position: fixed; inset: 0; z-index: 5; cursor: col-resize; }
  .drag-overlay.active { display: block; }
  @media (orientation: portrait) {
    .split { flex-direction: column; }
    .split iframe { width: 100%; min-width: 0; min-height: 0; }
    #leftPane { flex: 0 0 42%; }
    #rightPane { flex: 1; }
    .handle { width: 100%; height: 8px; cursor: row-resize; }
    .handle::after { width: 36px; height: 3px; }
    .drag-overlay { cursor: row-resize; }
  }
</style>
</head>
<body>
<div class="split">
  <iframe id="leftPane" src="/home/panel" allow="autoplay; fullscreen" allowfullscreen title="QR instructions"></iframe>
  <div class="handle" id="handle" role="separator" aria-label="Resize display panes"></div>
  <iframe id="rightPane" src="/photogallery/" allow="fullscreen" allowfullscreen title="Photo book"></iframe>
</div>
<div class="drag-overlay" id="overlay"></div>
<script>
(function() {
  var handle = document.getElementById("handle");
  var overlay = document.getElementById("overlay");
  var leftPane = document.getElementById("leftPane");
  var rightPane = document.getElementById("rightPane");
  var dragging = false;
  handle.addEventListener("pointerdown", function(e) {
    e.preventDefault();
    dragging = true;
    overlay.classList.add("active");
    handle.setPointerCapture(e.pointerId);
  });
  document.addEventListener("pointermove", function(e) {
    if (!dragging) return;
    e.preventDefault();
    var portrait = window.innerHeight > window.innerWidth;
    var total = portrait ? window.innerHeight : window.innerWidth;
    var position = portrait ? e.clientY : e.clientX;
    var available = total - 8;
    if (portrait) {
      var firstHeight = Math.max(8, Math.min(available - 8, position - 4));
      leftPane.style.flex = rightPane.style.flex = "none";
      leftPane.style.height = firstHeight + "px";
      rightPane.style.height = (available - firstHeight) + "px";
    } else {
      var percent = Math.max(15, Math.min(85, position / total * 100));
      leftPane.style.flex = rightPane.style.flex = "none";
      leftPane.style.width = percent + "%";
      rightPane.style.width = (100 - percent) + "%";
    }
  });
  function stopDragging() { dragging = false; overlay.classList.remove("active"); }
  document.addEventListener("pointerup", stopDragging);
  document.addEventListener("pointercancel", stopDragging);
  window.addEventListener("resize", function() {
    [leftPane, rightPane].forEach(function(frame) { frame.style.flex = frame.style.width = frame.style.height = ""; });
  });
  function applyTheme(theme) {
    if (theme !== "dark" && theme !== "light") return;
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("twilio-theme", theme);
    [leftPane, rightPane].forEach(function(frame) {
      try { frame.contentDocument.documentElement.setAttribute("data-theme", theme); } catch (err) {}
    });
  }
  window.addEventListener("message", function(e) {
    if (e.origin !== window.location.origin || !e.data || e.data.type !== "twilio-theme-change") return;
    applyTheme(e.data.theme);
  });
  window.addEventListener("storage", function(e) {
    if (e.key === "twilio-theme") applyTheme(e.newValue);
  });
})();
</script>
</body>
</html>`;
}

function send(response, status, body, contentType, headers = {}) {
    response.writeHead(status, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...headers,
    });
    response.end(body);
}

function sendJson(response, status, value, headers = {}) {
    send(response, status, JSON.stringify(value), "application/json; charset=utf-8", headers);
}

function sendPagedRows(response, items, url, { defaultLimit = 25, maxLimit = 100 } = {}) {
    const page = fixtures.limitedRows(items, url, { defaultLimit, maxLimit });
    sendJson(response, 200, page);
}

function sendDashboardJobs(response, items, url, defaultLimit) {
    const requestedLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : defaultLimit;
    const requestedOffset = Number(url.searchParams.get("offset"));
    const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
    sendJson(response, 200, items.slice(offset, offset + limit), {
        "X-Total-Count": String(items.length),
        "X-Page-Limit": String(limit),
        "X-Page-Offset": String(offset),
    });
}

function matchesEvent(items, key, selected) {
    return !selected || selected === "all" ? items : items.filter((item) => item[key] === selected);
}

function serveDemoPortrait(response, pathname) {
    const match = pathname.match(/demo-(\d{3})/);
    if (!match) return send(response, 404, "Not found", "text/plain; charset=utf-8");
    const kind = pathname.endsWith("_input.jpg") ? "input" : "output";
    return send(response, 200, fixtures.portraitSvg(Number(match[1]), kind), "image/svg+xml");
}

function serveAsset(response, pathname) {
    let relative;
    try { relative = decodeURIComponent(pathname.slice("/assets/".length)); }
    catch { return send(response, 400, "Bad asset path", "text/plain; charset=utf-8"); }
    const fullPath = path.resolve(assetsDir, relative);
    if (!fullPath.startsWith(assetsDir + path.sep)) {
        return send(response, 404, "Not found", "text/plain; charset=utf-8");
    }
    try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) throw new Error("not a file");
        send(response, 200, fs.readFileSync(fullPath), contentTypes[path.extname(fullPath).toLowerCase()] || "application/octet-stream");
    } catch {
        send(response, 404, "Not found", "text/plain; charset=utf-8");
    }
}

function createPreviewServer() {
    const { buildHomeHtml, buildSettingsHtml, buildStaticPanelHtml } = require("../lib/home");
    const { buildAttendeeStartHtml, buildEventNoticeHtml } = require("../lib/attendee-start");
    const { buildChannelLaunchPath, buildChannelOptions, resolveEventLocale } = require("../lib/channel-entry");
    const { renderDashboardPage } = require("../lib/dashboard-page");
    const { renderLogsPage } = require("../lib/logs-page");
    const { buildOutreachHtml } = require("../lib/outreach-page");
    const { buildPageHtml } = require("../lib/photogallery-page");
    const { buildReviewQueueHtml } = require("../lib/review-queue-page");
    const { buildMobileSettingsHtml } = require("../lib/review-settings-page");
    const { renderEvalRunsPage, renderEvalNewPage, renderEvalPhotosPage, renderEvalVariantsPage } = require("../lib/eval-page");
    const { renderEvalRunDetailPage } = require("../lib/eval-run-page");
    const { userBarSnippet } = require("../lib/auth");
    const userBar = userBarSnippet();
    return http.createServer((request, response) => {
        let pathname;
        try { pathname = new URL(request.url, `http://${HOST}`).pathname; }
        catch { return send(response, 400, "Bad request", "text/plain; charset=utf-8"); }
        const url = new URL(request.url, "http://" + HOST);
        if (request.method !== "GET") {
            return sendJson(response, 405, { error: "This is a read-only demo preview. No changes were saved." });
        }
        if (pathname === "/" || pathname === "/home") {
            response.writeHead(302, { Location: "/home/", "Cache-Control": "no-store" });
            return response.end();
        }
        if (pathname === "/home/") {
            return send(response, 200, buildHomeHtml({ demo: true, getSetting: (key) => fixtureSettings[key] }), "text/html; charset=utf-8");
        }
        if (pathname === "/home/settings") {
            return send(response, 200, buildSettingsHtml({ demo: true }), "text/html; charset=utf-8");
        }
        if (pathname === "/home/combo") {
            return send(response, 200, buildComboPreviewHtml(), "text/html; charset=utf-8");
        }
        if (pathname === "/home/panel") {
            return buildStaticPanelHtml("en", {
                locale: "en",
                baseUrl: `http://${HOST}:${request.socket.localPort}`,
                eventName: fixtures.EVENTS[0],
                getSetting: (key) => fixtureSettings[key],
                previewOnly: true,
            }).then((html) => send(response, 200, html, "text/html; charset=utf-8"))
                .catch(() => send(response, 500, "Preview panel unavailable.", "text/plain; charset=utf-8"));
        }
        if (pathname === "/start" || pathname === "/start/") {
            if (url.searchParams.get("event") !== fixtureSettings.eventName) {
                return send(response, 404, "Demo event not found.", "text/plain; charset=utf-8");
            }
            const mode = previewChannelMode(url.searchParams.get("channels"));
            const getSetting = (key) => previewSetting(key, mode);
            const locale = resolveEventLocale(getSetting, url.searchParams.get("lang"));
            const channelMap = buildChannelOptions({ locale, getSetting });
            const channels = [channelMap.sms, channelMap.whatsapp]
                .filter((channel) => channel.enabled && channel.href)
                .map((channel) => ({
                    ...channel,
                    launchHref: buildChannelLaunchPath(fixtureSettings.eventName, locale, channel.id),
                }));
            return send(response, 200, buildAttendeeStartHtml({
                eventName: fixtureSettings.eventName,
                locale,
                languageMode: fixtureSettings.languageMode,
                channels,
                legalText: "",
                termsUrl: "",
                previewChannels: mode,
            }), "text/html; charset=utf-8");
        }
        if (pathname === "/start/notice" || pathname === "/start/notice/") {
            if (url.searchParams.get("event") !== fixtureSettings.eventName) {
                return send(response, 404, "Demo event not found.", "text/plain; charset=utf-8");
            }
            const mode = previewChannelMode(url.searchParams.get("channels"));
            const getSetting = (key) => previewSetting(key, mode);
            const locale = resolveEventLocale(getSetting, url.searchParams.get("lang"));
            return send(response, 200, buildEventNoticeHtml({
                eventName: fixtureSettings.eventName,
                locale,
                legalText: "",
                termsUrl: "",
                previewChannels: mode,
            }), "text/html; charset=utf-8");
        }
        if (pathname === "/start/open" || pathname === "/start/open/") {
            if (url.searchParams.get("event") !== fixtureSettings.eventName) {
                return send(response, 404, "Demo event not found.", "text/plain; charset=utf-8");
            }
            const channel = url.searchParams.get("channel");
            if (!["sms", "whatsapp"].includes(channel)) {
                return send(response, 400, "Invalid channel.", "text/plain; charset=utf-8");
            }
            const mode = previewChannelMode(url.searchParams.get("channels"));
            const getSetting = (key) => previewSetting(key, mode);
            const locale = resolveEventLocale(getSetting, url.searchParams.get("lang"));
            const selected = buildChannelOptions({ locale, getSetting })[channel];
            if (!selected.enabled || !selected.href) {
                return send(response, 404, "Channel not available.", "text/plain; charset=utf-8");
            }
            const body = new URL(selected.href).searchParams.get(channel === "sms" ? "body" : "text") || "";
            return send(response, 200, buildDraftPreviewHtml({
                channel,
                recipient: selected.phone,
                body,
                eventName: fixtureSettings.eventName,
                locale,
                mode,
            }), "text/html; charset=utf-8");
        }
        if (pathname === "/dashboard" || pathname === "/dashboard/logs" || pathname === "/outreach" || pathname === "/photogallery") {
            response.writeHead(302, { Location: pathname + "/", "Cache-Control": "no-store" });
            return response.end();
        }
        if (pathname === "/dashboard/") {
            return send(response, 200, renderDashboardPage({ userBar }), "text/html; charset=utf-8");
        }
        if (pathname === "/dashboard/logs/") {
            return send(response, 200, renderLogsPage({ userBar }), "text/html; charset=utf-8");
        }
        if (pathname === "/outreach/") {
            return send(response, 200, buildOutreachHtml({ userBar }), "text/html; charset=utf-8");
        }
        if (pathname === "/photogallery/") {
            return send(response, 200, buildPageHtml(fixtures.EVENTS[0], "en", {
                adminNav: request.headers["sec-fetch-dest"] !== "iframe",
            }), "text/html; charset=utf-8");
        }
        if (pathname === "/review/queue" || pathname === "/review/queue/") {
            return send(response, 200, buildReviewQueueHtml({ adminNav: true }), "text/html; charset=utf-8");
        }
        if (pathname === "/review/settings" || pathname === "/review/settings/") {
            return send(response, 200, buildMobileSettingsHtml({ adminNav: true }), "text/html; charset=utf-8");
        }
        if (pathname === "/eval" || pathname === "/eval/") {
            return send(response, 200, renderEvalRunsPage({
                summaries: fixtures.evalRuns, evalSettings: { maxConcurrent: 12 }, activeEvent: fixtures.EVENTS[0],
                query: Object.fromEntries(url.searchParams), userBar,
            }), "text/html; charset=utf-8");
        }
        if (pathname === "/eval/new" || pathname === "/eval/new/") {
            return send(response, 200, renderEvalNewPage({
                activeStyles: fixtures.evalStyles, activeBrands: {}, photos: fixtures.evalPhotos, savedVariants: fixtures.evalVariants,
                evalSettings: { maxConcurrent: 12 }, activeEvent: fixtures.EVENTS[0], eventNames: fixtures.EVENTS,
                existingGroups: ["Launch prep", "Style tuning", "Delivery tests"], userBar,
            }), "text/html; charset=utf-8");
        }
        if (pathname === "/eval/photos" || pathname === "/eval/photos/") {
            return send(response, 200, renderEvalPhotosPage({ photos: fixtures.evalPhotos, userBar }), "text/html; charset=utf-8");
        }
        if (pathname === "/eval/variants" || pathname === "/eval/variants/") {
            return send(response, 200, renderEvalVariantsPage({
                variants: fixtures.evalVariants, activeStyles: fixtures.evalStyles, activeBrands: {}, userBar,
            }), "text/html; charset=utf-8");
        }
        if (pathname.startsWith("/eval/run/")) {
            let id;
            try { id = decodeURIComponent(pathname.slice("/eval/run/".length)); }
            catch { return send(response, 400, "Invalid run ID.", "text/plain; charset=utf-8"); }
            const manifest = fixtures.evalRunManifest(id);
            if (!manifest) return send(response, 404, "Run not found in sample data.", "text/plain; charset=utf-8");
            return send(response, 200, renderEvalRunDetailPage({
                manifest, query: Object.fromEntries(url.searchParams), userBar,
            }), "text/html; charset=utf-8");
        }
        if (pathname.startsWith("/assets/")) return serveAsset(response, pathname);
        if (pathname.startsWith("/photogallery/img/") || pathname.startsWith("/photogallery/thumb/") || pathname.startsWith("/photogallery/staging/") || pathname.startsWith("/outreach/api/thumbnail/") || pathname.startsWith("/review/api/thumbnail/") || pathname.startsWith("/eval/images/")) {
            return serveDemoPortrait(response, pathname);
        }
        if (pathname.startsWith("/eval/prompts/")) {
            return send(response, 200, "Sample prompt for the local preview. Keep the face recognizable and use a clean illustrated style.", "text/plain; charset=utf-8");
        }
        if (pathname === "/dashboard/api/settings") return sendJson(response, 200, fixtureSettings);
        if (pathname === "/dashboard/api/settings/files") return sendJson(response, 200, fixtureFiles);
        if (pathname === "/dashboard/api/settings/events") {
            return sendJson(response, 200, { events: fixtureFiles.events, eventProfiles: fixtureFiles.eventProfiles });
        }
        if (pathname === "/dashboard/api/review-count") return sendJson(response, 200, { count: fixtures.reviewItems.filter((item) => item.eventName === fixtures.EVENTS[0]).length });
        if (pathname === "/dashboard/api/logs") {
            const requested = Number(url.searchParams.get("limit"));
            const limit = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 500) : 200;
            return sendJson(response, 200, fixtures.logs.slice(-limit));
        }
        if (pathname === "/dashboard/api/logs/stream") {
            response.writeHead(200, {
                "Content-Type": "text/event-stream; charset=utf-8",
                "Cache-Control": "no-store",
                Connection: "keep-alive",
            });
            response.write(": synthetic preview stream\n\n");
            const since = Number(url.searchParams.get("since")) || 0;
            for (const entry of fixtures.logs) {
                if (entry.id > since) response.write("id: " + entry.id + "\ndata: " + JSON.stringify(entry) + "\n\n");
            }
            const timer = setInterval(() => response.write(": preview keepalive\n\n"), 25000);
            response.on("close", () => clearInterval(timer));
            return;
        }
        if (pathname === "/dashboard/api/style-preview") return sendJson(response, 200, { image: null });
        if (pathname === "/dashboard/api/openai-models") {
            return sendJson(response, 200, { source: "fixture", models: { text: ["gpt-5.4-nano"], vision: ["gpt-5.5"], image: ["gpt-image-2-2026-04-21"] } });
        }
        if (pathname === "/auth/me") return sendJson(response, 200, { name: "Demo operator" });
        if (pathname === "/dashboard/api/staff-qr") {
            return send(response, 200, '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect width="160" height="160" fill="white"/><rect x="12" y="12" width="136" height="136" fill="none" stroke="#EF223A" stroke-width="2"/><text x="80" y="82" text-anchor="middle" fill="#000D25" font-family="sans-serif" font-size="20" font-weight="bold">DEMO</text></svg>', "image/svg+xml");
        }
        if (pathname === "/dashboard/api/stats") {
            return sendJson(response, 200, fixtures.dashboardStats(url.searchParams.get("scope")));
        }
        if (pathname === "/dashboard/api/dashboard-users") {
            const items = matchesEvent(fixtures.recipients, "lastEvent", url.searchParams.get("e"));
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 40));
            const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
            return sendJson(response, 200, {
                users: items.slice(offset, offset + limit),
                total: items.length, offset, limit, hasMore: offset + limit < items.length,
            });
        }
        if (pathname === "/dashboard/api/jobs") {
            const filter = url.searchParams.get("filter") || "all";
            if (!["all", "active", "failed", "done"].includes(filter)) {
                return sendJson(response, 400, { error: "Invalid job filter" });
            }
            const selected = url.searchParams.get("e");
            const groups = {
                active: matchesEvent(fixtures.activeJobs, "eventName", selected),
                failed: matchesEvent(fixtures.failedJobs, "eventName", selected),
                done: matchesEvent(fixtures.doneJobs, "eventName", selected),
            };
            const counts = Object.fromEntries(Object.entries(groups).map(([type, rows]) => [type, rows.length]));
            const requestedLimit = Number(url.searchParams.get("limit"));
            const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 25;
            const requestedOffset = Number(url.searchParams.get("offset"));
            const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
            const jobs = Object.entries(groups)
                .flatMap(([type, rows]) => rows.map((data) => ({
                    type, data,
                    ts: Number(data.enteredAt || data.createdAt || data.completedAt || 0),
                })))
                .filter((row) => filter === "all" || row.type === filter)
                .sort((a, b) => b.ts - a.ts || a.data.filename.localeCompare(b.data.filename));
            return sendJson(response, 200, {
                jobs: jobs.slice(offset, offset + limit), total: jobs.length, counts,
                offset, limit, hasMore: offset + limit < jobs.length,
            });
        }
        if (pathname === "/dashboard/api/failed-jobs" || pathname === "/dashboard/api/done-jobs" || pathname === "/dashboard/api/active-jobs") {
            const selected = url.searchParams.get("e");
            const source = pathname.endsWith("failed-jobs") ? fixtures.failedJobs : pathname.endsWith("done-jobs") ? fixtures.doneJobs : fixtures.activeJobs;
            return sendDashboardJobs(response, matchesEvent(source, "eventName", selected), url, pathname.endsWith("active-jobs") ? 50 : 25);
        }
        if (pathname === "/dashboard/api/voice-deliveries") {
            return sendJson(response, 200, []);
        }
        if (pathname === "/dashboard/api/review-queue") {
            const items = matchesEvent(fixtures.reviewItems, "eventName", url.searchParams.get("e"));
            const requestedLimit = Number(url.searchParams.get("limit"));
            if (!url.searchParams.has("limit")) return sendJson(response, 200, items);
            const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 12;
            return sendJson(response, 200, items.slice(0, limit), { "X-Total-Count": String(items.length) });
        }
        if (pathname === "/dashboard/api/audit") return sendJson(response, 200, { entries: [], total: 0 });
        if (pathname === "/dashboard/api/review-qr") return sendJson(response, 200, { svg: "", url: "" });
        if (pathname === "/review/api/events") {
            return sendJson(response, 200, { events: fixtures.EVENTS, currentEvent: fixtures.EVENTS[0] });
        }
        if (pathname === "/review/api/settings") {
            return sendJson(response, 200, {
                eventName: fixtures.EVENTS[0], languageMode: "en", maxPrints: 2,
                queuePaused: false, enablePrinting: true, reviewMode: "human", hasReviewPin: true,
                disabledStyles: [], disabledBrands: [], customStyles: {}, backgroundChoices: [], messages: {},
            });
        }
        if (pathname === "/review/api/settings/files") {
            return sendJson(response, 200, {
                events: fixtures.EVENTS, templates: [], videos: [], brands: [],
                styles: Object.entries(fixtures.evalStyles).map(([key, value]) => ({ key, name: value.name })),
            });
        }
        if (pathname === "/review/api/queue") {
            const selected = url.searchParams.get("e") || fixtures.EVENTS[0];
            const items = matchesEvent(fixtures.reviewItems, "eventName", selected);
            if (!url.searchParams.has("limit") && !url.searchParams.has("cursor")) return sendJson(response, 200, items);
            const requestedLimit = Number(url.searchParams.get("limit"));
            const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 60) : 24;
            const cursor = url.searchParams.get("cursor") || "";
            const requestedOffset = cursor.startsWith("offset:") ? Number(cursor.slice(7)) : 0;
            const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
            const hasMore = offset + limit < items.length;
            return sendJson(response, 200, {
                items: items.slice(offset, offset + limit), total: items.length, offset, limit, hasMore,
                cursor: hasMore ? "offset:" + (offset + limit) : null,
            });
        }
        if (pathname === "/eval/api/groups") {
            return sendJson(response, 200, { groups: ["Launch prep", "Style tuning", "Delivery tests"] });
        }
        if (pathname === "/eval/api/runs") {
            const selectedIds = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
            return sendJson(response, 200, { runs: selectedIds.length
                ? fixtures.evalRuns.filter((run) => selectedIds.includes(run.id))
                : fixtures.evalRuns.slice(0, 24) });
        }
        const evalRunApi = pathname.match(/^\/eval\/api\/runs\/([^/]+)(\/summary)?$/);
        if (evalRunApi) {
            let id;
            try { id = decodeURIComponent(evalRunApi[1]); }
            catch { return sendJson(response, 400, { error: "Invalid run ID" }); }
            const run = fixtures.evalRuns.find((item) => item.id === id);
            if (!run) return sendJson(response, 404, { error: "Run not found in sample data" });
            return sendJson(response, 200, evalRunApi[2]
                ? { ...run, updatedAt: new Date(fixtures.NOW).toISOString() }
                : fixtures.evalRunManifest(id));
        }
        if (pathname === "/eval/api/settings") return sendJson(response, 200, { maxConcurrent: 12 });
        if (pathname === "/outreach/api/events") {
            return sendJson(response, 200, { events: fixtures.EVENTS, currentEvent: fixtures.EVENTS[0] });
        }
        if (pathname === "/outreach/api/users") {
            return sendPagedRows(response, matchesEvent(fixtures.recipients, "lastEvent", url.searchParams.get("event")), url);
        }
        if (pathname === "/outreach/api/raffle") {
            return sendPagedRows(response, matchesEvent(fixtures.raffle, "event", url.searchParams.get("event")), url, { defaultLimit: 5 });
        }
        if (pathname === "/outreach/api/leads") {
            return sendPagedRows(response, matchesEvent(fixtures.leads, "event", url.searchParams.get("event")), url);
        }
        if (pathname === "/outreach/api/kiosk-submissions") {
            return sendPagedRows(response, matchesEvent(fixtures.kioskSubmissions, "event", url.searchParams.get("event")), url);
        }
        if (pathname === "/outreach/api/drop-offs") {
            return sendPagedRows(response, matchesEvent(fixtures.dropoffs, "event", url.searchParams.get("event")), url);
        }
        if (pathname === "/photogallery/api/events") {
            return sendJson(response, 200, {
                events: fixtures.EVENTS, currentEvent: fixtures.EVENTS[0], locale: "en", termsUrl: "",
                revealAnimation: fixtureSettings.revealAnimation,
                photoBookAutoplay: true, photoBookInterval: 10,
                milestonesEnabled: fixtureSettings.milestonesEnabled,
                milestoneInterval: fixtureSettings.milestoneInterval,
            });
        }
        if (pathname === "/photogallery/api/images") {
            const items = matchesEvent(fixtures.galleryImages, "event", url.searchParams.get("event"));
            const requestedLimit = Number(url.searchParams.get("limit"));
            const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 100) : 48;
            const cursor = url.searchParams.get("cursor") || "";
            const requestedOffset = cursor.startsWith("offset:") ? Number(cursor.slice(7)) : 0;
            const offset = Number.isSafeInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
            const hasMore = offset + limit < items.length;
            return sendJson(response, 200, {
                images: items.slice(offset, offset + limit), total: items.length,
                activeStyleCount: 6, offset, hasMore,
                cursor: hasMore ? "offset:" + (offset + limit) : null,
            });
        }
        return send(response, 404, "Not found in the read-only demo preview.", "text/plain; charset=utf-8");
    });
}

if (require.main === module) {
    isolatePreviewEnvironment();
    const port = Number(process.argv[2] || 4173);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error("Usage: node scripts/preview-home.js [port]");
        process.exitCode = 1;
    } else {
        createPreviewServer().listen(port, HOST, () => {
            console.log(`Read-only demo preview: http://${HOST}:${port}/home/`);
            console.log(`Settings: http://${HOST}:${port}/home/settings`);
            console.log(`Combo display: http://${HOST}:${port}/home/combo`);
            console.log(`Dashboard: http://${HOST}:${port}/dashboard/`);
            console.log(`Outreach: http://${HOST}:${port}/outreach/`);
            console.log(`Photo book: http://${HOST}:${port}/photogallery/`);
            console.log(`Logs: http://${HOST}:${port}/dashboard/logs/`);
            console.log(`Review Queue: http://${HOST}:${port}/review/queue`);
            console.log(`Prompt Lab: http://${HOST}:${port}/eval`);
            console.log("Sample data only. No .env, saved events, queue processors, or external services.");
        });
    }
}

module.exports = { createPreviewServer, fixtureSettings };

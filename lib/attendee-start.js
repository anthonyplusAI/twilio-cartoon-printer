const express = require("express");
const settings = require("./settings");
const ui = require("./ui-i18n");
const { buildChannelOptions, isValidEventName, resolveEventLocale } = require("./channel-entry");

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[char]));
}

function safeHttpUrl(value) {
    try {
        const url = new URL(String(value || ""));
        return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
    } catch {
        return "";
    }
}

function channelIcon(channel) {
    const src = channel.id === "sms" ? "/assets/icon-sms.svg" : "/assets/icon-phone-chat.svg";
    return `<span class="channel-icon ${channel.id}"><img src="${src}" alt=""></span>`;
}

function previewChannelMode(value) {
    return ["sms", "whatsapp", "both"].includes(value) ? value : "";
}

function buildAttendeeStartHtml({ eventName, locale, languageMode, channels, previewChannels = "" }) {
    const availableChannels = channels.filter((channel) => channel.enabled && channel.href);
    const previewMode = previewChannelMode(previewChannels);
    const channelCards = availableChannels.map((channel) => `
      <button class="channel-button channel-${channel.id}" type="submit" name="channel" value="${escapeHtml(channel.id)}">
        ${channelIcon(channel)}
        <span>${escapeHtml(ui.t(locale, channel.id === "sms" ? "continueWithSms" : "continueWithWhatsapp"))}</span>
        <svg class="channel-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </button>`).join("");
    const noticeParams = { event: eventName, lang: locale };
    if (previewMode) noticeParams.channels = previewMode;
    const noticeHref = `/start/notice?${new URLSearchParams(noticeParams).toString()}`;
    const previewToolbar = previewMode ? `<nav class="preview-toolbar" aria-label="Preview channel modes">
    <span>Preview only</span>
    <a href="/start?${new URLSearchParams({ event: eventName, lang: locale, channels: "sms" }).toString()}"${previewMode === "sms" ? ' aria-current="page"' : ""}>SMS only</a>
    <a href="/start?${new URLSearchParams({ event: eventName, lang: locale, channels: "whatsapp" }).toString()}"${previewMode === "whatsapp" ? ' aria-current="page"' : ""}>WhatsApp only</a>
    <a href="/start?${new URLSearchParams({ event: eventName, lang: locale, channels: "both" }).toString()}"${previewMode === "both" ? ' aria-current="page"' : ""}>Both</a>
  </nav>` : "";
    const languageHref = (lang) => {
        const params = { event: eventName, lang };
        if (previewMode) params.channels = previewMode;
        return escapeHtml(`/start?${new URLSearchParams(params).toString()}`);
    };
    const languagePicker = languageMode === "ask" ? `
      <nav class="language-picker" aria-label="${escapeHtml(ui.t(locale, "pageLanguage"))}">
        <span>${escapeHtml(ui.t(locale, "pageLanguage"))}:</span>
        <a href="${languageHref("en")}"${locale === "en" ? ' aria-current="page"' : ""}>English</a>
        <a href="${languageHref("pt_BR")}"${locale === "pt_BR" ? ' aria-current="page"' : ""}>Português</a>
      </nav>` : "";

    return `<!DOCTYPE html>
<html lang="${ui.htmlLang(locale)}" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>${escapeHtml(ui.t(locale, "startPageTitle"))} — Twilio Photobooth</title>
<style>
  * { box-sizing: border-box; }
  html { color-scheme: light; }
  body { min-height: 100vh; margin: 0; background: #fff; color: var(--th-text); }
  .page { width: min(100%, 560px); min-height: 100vh; margin: 0 auto; padding: 32px 24px 44px; }
  .topbar { display: flex; align-items: center; gap: 10px; }
  .brand { width: 34px; height: 34px; flex: 0 0 34px; }
  .event-name { color: var(--th-text-dim); font-family: 'Twilio Sans Mono', monospace; font-size: 11px; font-weight: 700; letter-spacing: .08em; line-height: 1.35; text-transform: uppercase; overflow-wrap: anywhere; }
  .hero { margin-top: clamp(38px, 7vh, 68px); }
  h1 { max-width: 500px; margin: 0; font-size: clamp(38px, 9vw, 54px); letter-spacing: -.02em; line-height: 1.04; }
  .intro { margin: 13px 0 0; color: var(--th-text-secondary); font-size: 16px; line-height: 1.5; }
  .start-form { margin-top: 26px; }
  .notice { margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--th-card-border); }
  .notice-label { margin: 0; color: var(--red-600); font-family: 'Twilio Sans Mono', monospace; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  .notice p { margin: 10px 0 0; color: var(--th-text-secondary); font-size: 14px; line-height: 1.55; }
  .notice a, .participation a { color: var(--blue-600); text-underline-offset: 3px; }
  .notice a { display: inline-block; margin-top: 12px; font-size: 13px; font-weight: 700; }
  .channel-list { display: grid; gap: 10px; }
  .channel-button { width: 100%; min-height: 64px; display: flex; align-items: center; gap: 13px; padding: 10px 13px; border: 2px solid var(--red-600); border-radius: 14px; background: #fff; box-shadow: 0 2px 8px rgba(0, 13, 37, .08); color: var(--th-text); font: 700 16px 'Twilio Sans Text', system-ui, sans-serif; text-align: left; cursor: pointer; }
  .channel-button:hover { border-color: var(--red-700); background: var(--red-50); }
  .channel-button:focus-visible { outline: 3px solid var(--blue-400); outline-offset: 2px; }
  .channel-icon { width: 38px; height: 38px; flex: 0 0 38px; display: grid; place-items: center; border-radius: 10px; }
  .channel-icon img { width: 23px; height: 23px; }
  .channel-icon.sms { background: var(--red-50); }
  .channel-icon.sms img { filter: brightness(0) saturate(100%) invert(42%) sepia(90%) saturate(4000%) hue-rotate(340deg) brightness(105%); }
  .channel-icon.whatsapp { background: var(--blue-50); }
  .channel-icon.whatsapp img { filter: brightness(0) saturate(100%) invert(35%) sepia(90%) saturate(2000%) hue-rotate(200deg) brightness(110%); }
  .channel-arrow { width: 20px; height: 20px; flex: 0 0 20px; margin-left: auto; color: var(--red-600); }
  .participation { margin: 22px 0 0; padding-top: 16px; border-top: 1px solid var(--th-card-border); color: var(--th-text-dim); font-size: 12px; line-height: 1.55; }
  .empty { padding: 20px 0; color: var(--th-text-dim); }
  .language-picker { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-top: 24px; }
  .language-picker span { color: var(--th-text-dim); font-size: 12px; }
  .language-picker a { padding: 5px 9px; border-radius: 8px; color: var(--th-text-dim); font-size: 12px; font-weight: 700; text-decoration: none; }
  .language-picker a[aria-current="page"] { background: var(--gray-50); color: var(--th-text); }
  .preview-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-bottom: 22px; padding: 7px; border: 1px solid var(--th-card-border); border-radius: 10px; background: var(--gray-50); font-size: 11px; }
  .preview-toolbar span { padding: 5px 7px; color: var(--th-text-dim); font-weight: 700; }
  .preview-toolbar a { padding: 5px 8px; border-radius: 7px; color: var(--th-text-secondary); text-decoration: none; }
  .preview-toolbar a[aria-current="page"] { background: var(--red-450); color: #fff; }
  @media (max-width: 420px) { .page { padding: 24px 20px 36px; } .hero { margin-top: 30px; } .preview-toolbar span { flex-basis: 100%; } }
</style>
</head>
<body>
<main class="page">
  ${previewToolbar}
  <header class="topbar">
    <img class="brand" src="/assets/icon-twilio-bug-red.svg" alt="Twilio">
    <span class="event-name">${escapeHtml(ui.t(locale, "eventLabel", { eventName }))}</span>
  </header>
  <div class="hero">
    <h1>${escapeHtml(ui.t(locale, "startPageTitle"))}</h1>
    <p class="intro">${escapeHtml(ui.t(locale, availableChannels.length === 1 ? "startIntroSingle" : "startIntroBoth"))}</p>
  </div>
  ${channelCards ? `<form class="start-form" action="/start/open" method="get">
    <input type="hidden" name="event" value="${escapeHtml(eventName)}">
    <input type="hidden" name="lang" value="${escapeHtml(locale)}">
    ${previewMode ? `<input type="hidden" name="channels" value="${previewMode}">` : ""}
    <div class="channel-list" role="group" aria-label="${escapeHtml(ui.t(locale, availableChannels.length === 1 ? "openMessagingApp" : "chooseMessagingApp"))}">${channelCards}</div>
    <section class="notice" aria-labelledby="photo-notice-title">
      <h2 class="notice-label" id="photo-notice-title">${escapeHtml(ui.t(locale, "beforeYouBegin"))}</h2>
      <p>${escapeHtml(ui.t(locale, "noticeDataBody"))}</p>
      <p>${escapeHtml(ui.t(locale, "noticeAiBody"))}</p>
      <a href="${escapeHtml(noticeHref)}">${escapeHtml(ui.t(locale, "readEventNotice"))} →</a>
    </section>
    <p class="participation">${escapeHtml(ui.t(locale, "participationAcknowledgement"))}</p>
  </form>` : `<div class="empty">${escapeHtml(ui.t(locale, "noChannel"))}</div>`}
  ${languagePicker}
</main>
</body>
</html>`;
}

function buildEventNoticeHtml({ eventName, locale, legalText, termsUrl, previewChannels = "" }) {
    const startParams = { event: eventName, lang: locale };
    const previewMode = previewChannelMode(previewChannels);
    if (previewMode) startParams.channels = previewMode;
    const startHref = `/start?${new URLSearchParams(startParams).toString()}`;
    const customTermsUrl = safeHttpUrl(termsUrl);
    const isTwilioTermsUrl = customTermsUrl && (() => {
        const url = new URL(customTermsUrl);
        return url.hostname === "twil.io"
            && url.pathname.replace(/\/+$/, "") === "/terms"
            && !url.search
            && !url.hash;
    })();
    const extraTermsUrl = customTermsUrl && !isTwilioTermsUrl ? customTermsUrl : "";
    const customNotice = String(legalText || "").trim();
    const section = (titleKey, bodyHtml) => `<section class="notice-section">
      <h2>${escapeHtml(ui.t(locale, titleKey))}</h2>
      <p>${bodyHtml}</p>
    </section>`;
    const termsFooter = ui.t(locale, "noticeTermsFooter");
    const sections = [
        section("noticePrivacyTitle", `${escapeHtml(ui.t(locale, "noticePrivacyBody"))} (<a href="https://twil.io/privacy" target="_blank" rel="noopener">twil.io/privacy</a>).`),
        section("noticeMarketingTitle", escapeHtml(ui.t(locale, "noticeMarketingBody"))),
        section("noticeAiTitle", escapeHtml(ui.t(locale, "noticeAiBody"))),
        section("noticeDataTitle", escapeHtml(ui.t(locale, "noticeDataBody"))),
        section("noticeStorageTitle", escapeHtml(ui.t(locale, "noticeStorageBody"))),
        section("noticeTermsTitle", `${escapeHtml(ui.t(locale, "noticeTermsBody"))} (<a href="https://twil.io/terms" target="_blank" rel="noopener">twil.io/terms</a>).${termsFooter ? ` ${escapeHtml(termsFooter)}` : ""}`),
    ].join("");
    return `<!DOCTYPE html>
<html lang="${ui.htmlLang(locale)}" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<title>${escapeHtml(ui.t(locale, "eventNoticeTitle"))} — Twilio Photobooth</title>
<style>
  * { box-sizing: border-box; }
  body { min-height: 100vh; margin: 0; background: #f5f6f9; color: #000d25; }
  .page { width: min(100%, 680px); min-height: 100vh; margin: 0 auto; padding: 25px 28px 64px; background: #fff; }
  .back { display: inline-block; padding: 4px 0; color: #1953b9; font-size: 14px; font-weight: 600; text-underline-offset: 3px; }
  .brand { width: 36px; height: 36px; display: block; margin: 33px 0 17px; }
  .eyebrow { color: #aa142d; font-family: 'Twilio Sans Mono', monospace; font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  h1 { margin: 8px 0 12px; font-size: clamp(32px, 8vw, 44px); line-height: 1.1; letter-spacing: -.025em; }
  .intro { margin: 0 0 32px; color: #4d5777; font-size: 15px; line-height: 1.55; }
  .notice-list { display: grid; gap: 26px; }
  .notice-section h2 { margin: 0 0 5px; color: #000d25; font-size: 16px; line-height: 1.35; }
  .notice-section p { margin: 0; color: #232b45; font-size: 14px; line-height: 1.6; }
  .notice-section a, .supplemental-link a { color: #1953b9; text-underline-offset: 3px; }
  .notice-section a:focus-visible, .supplemental-link a:focus-visible, .back:focus-visible { outline: 2px solid #1953b9; outline-offset: 3px; }
  .supplemental-link { margin: 30px 0 0; font-size: 14px; }
  .supplemental-notice { margin-top: 30px; padding-top: 23px; border-top: 1px solid #dde0e6; }
  .supplemental-notice p { white-space: pre-wrap; }
  @media (min-width: 720px) { .page { box-shadow: 0 8px 40px rgba(0, 13, 37, .06); } }
  @media (max-width: 420px) { .page { padding: 22px 21px 48px; } .brand { margin-top: 28px; } .notice-list { gap: 24px; } }
</style>
</head>
<body>
<main class="page">
  <a class="back" href="${escapeHtml(startHref)}">← ${escapeHtml(ui.t(locale, "backToStart"))}</a>
  <img class="brand" src="/assets/icon-twilio-bug-red.svg" alt="Twilio">
  <div class="eyebrow">${escapeHtml(ui.t(locale, "eventLabel", { eventName }))}</div>
  <h1>${escapeHtml(ui.t(locale, "eventNoticeTitle"))}</h1>
  <p class="intro">${escapeHtml(ui.t(locale, "eventNoticeIntro"))}</p>
  <div class="notice-list">${sections}</div>
  ${extraTermsUrl ? `<p class="supplemental-link"><a href="${escapeHtml(extraTermsUrl)}" target="_blank" rel="noopener">${escapeHtml(ui.t(locale, "noticeEventTermsLink"))}</a></p>` : ""}
  ${customNotice ? `<section class="notice-section supplemental-notice"><h2>${escapeHtml(ui.t(locale, "noticeAdditionalTitle"))}</h2><p>${escapeHtml(customNotice)}</p></section>` : ""}
</main>
</body>
</html>`;
}

function createAttendeeStartRouter({ settingsModule = settings } = {}) {
    const router = express.Router();
    router.get("/notice", (req, res) => {
        const eventQuery = req.query.event;
        if (typeof eventQuery !== "string" || !isValidEventName(eventQuery)) {
            return res.status(400).type("text").send("Invalid or missing event");
        }
        if (eventQuery !== settingsModule.get("eventName")) {
            return res.status(404).type("text").send("Event not found");
        }
        const getSetting = (key) => settingsModule.get(key);
        const locale = resolveEventLocale(getSetting, req.query.lang);
        const html = buildEventNoticeHtml({
            eventName: eventQuery,
            locale,
            legalText: getSetting("boothLegalText") || "",
            termsUrl: getSetting("termsUrl") || "",
        });
        res.set({
            "Cache-Control": "private, no-store",
            "Content-Language": ui.htmlLang(locale),
            "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        });
        return res.status(200).type("html").send(html);
    });
    router.get("/open", (req, res) => {
        const eventQuery = req.query.event;
        const channel = req.query.channel;
        if (typeof eventQuery !== "string" || !isValidEventName(eventQuery) || !["sms", "whatsapp"].includes(channel)) {
            return res.status(400).type("text").send("Invalid launch request");
        }
        if (eventQuery !== settingsModule.get("eventName")) {
            return res.status(404).type("text").send("Event not found");
        }

        const getSetting = (key) => settingsModule.get(key);
        const locale = resolveEventLocale(getSetting, req.query.lang);
        const channelMap = buildChannelOptions({ locale, getSetting });
        const selected = channelMap[channel];
        if (!selected.enabled || !selected.href) return res.status(404).type("text").send("Channel not available");

        const userAgent = String(req.get("user-agent") || "");
        const destination = channel === "sms" && /iPad|iPhone|iPod|Macintosh.*Mobile/i.test(userAgent)
            ? selected.iosHref
            : selected.href;
        res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
        return res.redirect(302, destination);
    });

    router.get("/", (req, res) => {
        const eventQuery = req.query.event;
        if (typeof eventQuery !== "string" || !isValidEventName(eventQuery)) {
            return res.status(400).type("text").send("Invalid or missing event");
        }
        if (eventQuery !== settingsModule.get("eventName")) {
            return res.status(404).type("text").send("Event not found");
        }

        const getSetting = (key) => settingsModule.get(key);
        const locale = resolveEventLocale(getSetting, req.query.lang);
        const channelMap = buildChannelOptions({ locale, getSetting });
        const channels = [channelMap.sms, channelMap.whatsapp]
            .filter((channel) => channel.enabled && channel.href);
        const html = buildAttendeeStartHtml({
            eventName: eventQuery,
            locale,
            languageMode: getSetting("languageMode"),
            channels,
            legalText: getSetting("boothLegalText") || "",
            termsUrl: getSetting("termsUrl") || "",
        });
        res.set({
            "Cache-Control": "private, no-store",
            "Content-Language": ui.htmlLang(locale),
            "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        });
        return res.status(channels.length ? 200 : 503).type("html").send(html);
    });
    return router;
}

const attendeeStartRouter = createAttendeeStartRouter();

module.exports = { attendeeStartRouter, buildAttendeeStartHtml, buildEventNoticeHtml, createAttendeeStartRouter };

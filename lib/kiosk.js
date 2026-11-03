// Shared-device camera page. The kiosk submits a portrait request and then
// clears the guest's photo and contact details before the next guest starts.

const express = require("express");
const settings = require("./settings");
const i18n = require("./i18n");
const optionI18n = require("./option-i18n");
const ui = require("./ui-i18n");
const { getKioskDeliveryChannels } = require("./kiosk-delivery");
const { getActiveBrands } = require("./brands");
const { resolveBrandStep } = require("./menu-routing");
const { resolveBackgroundStep } = require("./prompt-assembler");
const {
    authenticateAdminSession,
    authenticateKioskSession,
    requireAuth,
    makeKioskSessionToken,
    setKioskSessionCookie,
    clearAdminSessionCookie,
} = require("./auth");

const router = express.Router();

function displayOption(type, key, option, locale) {
    const localized = optionI18n.localizeOption(type, key, option, locale);
    return { key: localized.key, name: localized.name, description: localized.description };
}

function buildKioskOptions({
    activeStyles,
    activeStyleList,
    activeBrands,
    enableBrandMenu,
    offerUnbranded,
    enableBackgroundMenu,
    backgroundChoices,
    locale,
}) {
    const styleOptions = activeStyleList.map((key) =>
        displayOption("style", key, activeStyles[key] || { name: key }, locale));
    const brandKeys = Object.keys(activeBrands);
    const brandStep = resolveBrandStep({
        enabled: enableBrandMenu,
        brandKeys,
        offerUnbranded,
    });
    const brandOptions = brandStep.kind !== "menu" ? []
        : brandKeys.map((key) => displayOption("brand", key, activeBrands[key], locale));
    if (brandStep.kind === "menu" && brandStep.includeNone) {
        brandOptions.push(optionI18n.unbrandedOption(locale));
        brandOptions[brandOptions.length - 1].key = "__none__";
    }

    // Background menus depend on both the chosen style and brand. Compute the
    // same combinations as the SMS/WhatsApp flow without exposing prompts or
    // reference file names to the kiosk browser.
    const backgroundOptionsByCombination = {};
    const autoBrandKey = brandStep.kind === "auto" ? brandStep.brandKey : "";
    const selectableBrands = autoBrandKey ? [autoBrandKey]
        : brandOptions.length ? brandOptions.map((item) => item.key) : [""];
    for (const styleKey of activeStyleList) {
        for (const brandKey of selectableBrands) {
            const step = resolveBackgroundStep({
                style: activeStyles[styleKey] || {},
                brand: brandKey && brandKey !== "__none__" ? activeBrands[brandKey] : null,
                configuredChoices: backgroundChoices,
                enabled: enableBackgroundMenu,
            });
            backgroundOptionsByCombination[styleKey + "|" + brandKey] = {
                kind: step.kind,
                selected: step.kind === "auto" ? step.backgroundKey : "",
                options: step.kind === "menu"
                    ? step.choices.map((choice) => displayOption("background", choice.key, choice, locale))
                    : [],
            };
        }
    }
    return { styleOptions, brandOptions, autoBrandKey, backgroundOptionsByCombination };
}

router.get("/launch", (req, res, next) => {
    if (!authenticateAdminSession(req)) return requireAuth(req, res, next);
    const token = makeKioskSessionToken(settings.get("eventName"));
    setKioskSessionCookie(res, token, req);
    clearAdminSessionCookie(res, req);
    res.set("Cache-Control", "private, no-store");
    return res.redirect("/kiosk");
});

router.get("/", (req, res, next) => {
    if (authenticateAdminSession(req)) return res.redirect("/kiosk/launch");
    const kioskSession = authenticateKioskSession(req);
    if (!kioskSession) return requireAuth(req, res, next);
    if (kioskSession.eventName !== settings.get("eventName")) {
        return res.status(409).type("html").send("The kiosk event changed. Ask event staff to relaunch the kiosk.");
    }
    const eventName = settings.get("eventName");
    const languageMode = settings.get("languageMode") || "en";
    const locale = languageMode === "ask"
        ? (i18n.normalizeLocale(req.query.lang) || i18n.DEFAULT_LOCALE)
        : i18n.resolveAttendeeLocale(languageMode) || i18n.DEFAULT_LOCALE;
    const options = buildKioskOptions({
        activeStyles: settings.getActiveStyles(eventName),
        activeStyleList: settings.getActiveStyleList(eventName),
        activeBrands: getActiveBrands(),
        enableBrandMenu: settings.getForEvent("enableBrandMenu", eventName),
        offerUnbranded: settings.getForEvent("offerUnbranded", eventName),
        enableBackgroundMenu: settings.getForEvent("enableBackgroundMenu", eventName),
        backgroundChoices: settings.getForEvent("backgroundChoices", eventName) || [],
        locale,
    });
    const deliveryChannels = getKioskDeliveryChannels(eventName, locale);

    res.set({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" });
    res.type("html").send(buildKioskHtml({
        ...options, eventName, locale, languageMode, deliveryChannels,
    }));
});

function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[character]));
}

function safeScriptJson(value) {
    return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

const fs = require("fs");
const path = require("path");
const pageTemplate = fs.readFileSync(path.join(__dirname, "kiosk-page.html"), "utf8");
const clientScript = fs.readFileSync(path.join(__dirname, "kiosk-client.js"), "utf8");

function buildKioskHtml({
    styleOptions = [],
    brandOptions = [],
    autoBrandKey = "",
    backgroundOptionsByCombination = {},
    eventName = "",
    locale = "en",
    languageMode = "en",
    deliveryChannels = ["sms"],
}) {
    const safeChannels = [...new Set(deliveryChannels)]
        .filter((channel) => ["sms", "whatsapp", "email"].includes(channel));
    const channelLabels = {
        sms: ui.t(locale, "sendBySms"),
        whatsapp: ui.t(locale, "sendByWhatsapp"),
        email: ui.t(locale, "sendByEmail"),
    };
    const deliveryOptions = safeChannels.map((channel) =>
        '<label class="delivery-option"><input type="radio" name="deliveryChannel" value="' + channel + '"'
        + (safeChannels.length === 1 ? ' checked' : '')
        + '><span>' + escapeHtml(channelLabels[channel]) + '</span></label>'
    ).join("");
    const noticeHref = "/start/notice?" + new URLSearchParams({ event: eventName, lang: locale }).toString();
    const languagePicker = languageMode === "ask"
        ? '<nav class="language-picker" aria-label="' + escapeHtml(ui.t(locale, "language")) + '">'
            + '<a href="?lang=en"' + (locale === "en" ? ' aria-current="page"' : '') + '>English</a>'
            + '<a href="?lang=pt_BR"' + (locale === "pt_BR" ? ' aria-current="page"' : '') + '>Português</a>'
            + '</nav>'
        : "";
    const copyKeys = [
        "startPrompt", "startCamera", "takePhoto", "artStyle", "chooseStyle",
        "brandStyle", "chooseBrand", "backgroundStyle", "chooseBackground",
        "noStyles", "noDeliveryChannels", "requestingCamera", "takePhotoPrompt",
        "cameraUnavailable", "cameraNotReady", "captureFailed", "photoConfirm",
        "retakePrompt", "chooseDelivery", "chooseBrandError", "chooseBackgroundError",
        "invalidPhoneRequired", "invalidEmailRequired", "mustAgreeNotice",
        "mustAgreeWhatsapp", "uploading", "uploadUnconfirmed", "uploadInProgress",
        "submissionConflict", "uploadFailed", "networkFailed",
        "eventChanged", "quotaReached", "deliveryUnavailable", "invalidDestination",
        "kioskSessionExpired",
        "submittedTitle", "generatingNow", "queuedForSms", "queuedForWhatsapp",
        "queuedForEmail", "photoBookAfterComplete", "idleCleared", "sendBySms",
        "sendByWhatsapp", "sendByEmail",
    ];
    const copy = Object.fromEntries(copyKeys.map((key) => [key, ui.t(locale, key)]));
    const script = [
        "const STYLES = " + safeScriptJson(styleOptions) + ";",
        "const BRAND_OPTIONS = " + safeScriptJson(brandOptions) + ";",
        "const AUTO_BRAND_KEY = " + safeScriptJson(autoBrandKey) + ";",
        "const BACKGROUND_MATRIX = " + safeScriptJson(backgroundOptionsByCombination) + ";",
        "const DELIVERY_CHANNELS = " + safeScriptJson(safeChannels) + ";",
        "const KIOSK_COPY = " + safeScriptJson(copy) + ";",
        "const EVENT_NAME = " + safeScriptJson(eventName) + ";",
        "const LOCALE = " + safeScriptJson(locale) + ";",
        clientScript,
    ].join("\n");
    const replacements = {
        LANG: ui.htmlLang(locale),
        TITLE: escapeHtml(ui.t(locale, "kioskPageTitle")),
        HEADER: escapeHtml(ui.t(locale, "snapSelfie")),
        EVENT: escapeHtml(ui.t(locale, "eventLabel", { eventName })),
        LANGUAGE_PICKER: languagePicker,
        CAPTURED_SELFIE: escapeHtml(ui.t(locale, "capturedSelfie")),
        START_PROMPT: escapeHtml(ui.t(locale, "startPrompt")),
        START_CAMERA: escapeHtml(ui.t(locale, "startCamera")),
        TAKE_PHOTO: escapeHtml(ui.t(locale, "takePhoto")),
        REVIEW_TITLE: escapeHtml(ui.t(locale, "reviewTitle")),
        ART_STYLE: escapeHtml(ui.t(locale, "artStyle")),
        BRAND_STYLE: escapeHtml(ui.t(locale, "brandStyle")),
        BACKGROUND_STYLE: escapeHtml(ui.t(locale, "backgroundStyle")),
        DELIVERY_METHOD: escapeHtml(ui.t(locale, "deliveryMethod")),
        DELIVERY_OPTIONS: deliveryOptions,
        PHONE_LABEL: escapeHtml(ui.t(locale, "phoneRequired")),
        EMAIL_LABEL: escapeHtml(ui.t(locale, "emailRequired")),
        WHATSAPP_OPT_IN: escapeHtml(ui.t(locale, "whatsappOptIn")),
        PARTICIPATION_NOTICE: escapeHtml(ui.t(locale, "kioskParticipationNotice")),
        PARTICIPATION_CHECK: escapeHtml(ui.t(locale, "kioskParticipationCheck")),
        NOTICE_LINK: escapeHtml(ui.t(locale, "kioskEventTerms")),
        NOTICE_HREF: escapeHtml(noticeHref),
        GENERATE: escapeHtml(ui.t(locale, "generate")),
        RETAKE: escapeHtml(ui.t(locale, "retake")),
        CANCEL_UPLOAD: escapeHtml(ui.t(locale, "cancelUpload")),
        SUBMITTED_TITLE: escapeHtml(ui.t(locale, "submittedTitle")),
        START_OVER: escapeHtml(ui.t(locale, "startOver")),
        SCRIPT: script,
    };
    return pageTemplate.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => replacements[key] || "");
}

function mountKiosk(app) {
    app.use("/kiosk", router);
    console.log("📸 Kiosk mounted at /kiosk");
}

module.exports = { buildKioskHtml, buildKioskOptions, mountKiosk };

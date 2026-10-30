const i18n = require("./i18n");
const ui = require("./ui-i18n");
const { MARKETING_CONSENT_TEXT, marketingOptInText, stripMarketingOptInText } = require("./marketing-consent");
const DEFAULT_FIRST_MESSAGE = "Hit send to start! 🚀";
const PREVIOUS_BUNDLED_FIRST_MESSAGE = `${DEFAULT_FIRST_MESSAGE}\n\n${MARKETING_CONSENT_TEXT}`;
const PREVIOUS_SMS_FIRST_MESSAGES = new Set(["Hit send to start", "Hit send to start!", PREVIOUS_BUNDLED_FIRST_MESSAGE]);
const PREVIOUS_WHATSAPP_FIRST_MESSAGES = new Set(["Hi", "Hit send to start!", PREVIOUS_BUNDLED_FIRST_MESSAGE]);

function resolveFirstMessage(value, previousDefaults) {
    return value && !previousDefaults.has(value) ? value : DEFAULT_FIRST_MESSAGE;
}

function withMarketingConsent(firstMessage, channel) {
    const starter = stripMarketingOptInText(firstMessage, channel) || DEFAULT_FIRST_MESSAGE;
    return `${starter}\n\n${marketingOptInText(channel)}`;
}

function normalizeSmsPhone(value) {
    const raw = String(value || "").trim().replace(/^sms:/i, "");
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 3 || digits.length > 15) return "";
    return raw.startsWith("+") ? `+${digits}` : digits;
}

function normalizeWhatsappPhone(value) {
    const digits = String(value || "").replace(/^whatsapp:/i, "").replace(/\D/g, "");
    return digits.length >= 7 && digits.length <= 15 ? digits : "";
}

function resolveEventLocale(getSetting, requestedLocale) {
    const mode = getSetting("languageMode");
    if (mode === "ask") return i18n.normalizeLocale(requestedLocale) || i18n.DEFAULT_LOCALE;
    return i18n.resolveAttendeeLocale(mode) || i18n.DEFAULT_LOCALE;
}

function buildChannelOptions({ locale = i18n.DEFAULT_LOCALE, getSetting }) {
    const resolvedLocale = i18n.normalizeLocale(locale) || i18n.DEFAULT_LOCALE;
    const smsPhoneRaw = getSetting("boothSmsPhone") || getSetting("twilioPhoneNumber") || "";
    const smsPhone = normalizeSmsPhone(smsPhoneRaw);
    const smsText = withMarketingConsent(
        resolveFirstMessage(getSetting("boothSmsInstructionText"), PREVIOUS_SMS_FIRST_MESSAGES),
        "sms",
    );

    const whatsappPhoneRaw = getSetting("boothWhatsappPhone") || getSetting("twilioWhatsappNumber") || "";
    const whatsappPhone = normalizeWhatsappPhone(whatsappPhoneRaw);
    const whatsappText = withMarketingConsent(
        resolveFirstMessage(getSetting("boothWhatsappPrefillText"), PREVIOUS_WHATSAPP_FIRST_MESSAGES),
        "whatsapp",
    );
    const configuredWhatsappInstruction = getSetting("boothWhatsappInstructionText") || "Open WhatsApp to start";
    const whatsappInstruction = resolvedLocale === "pt_BR" && configuredWhatsappInstruction === "Open WhatsApp to start"
        ? ui.t(resolvedLocale, "openWhatsapp")
        : configuredWhatsappInstruction;

    return {
        sms: {
            id: "sms",
            enabled: getSetting("boothShowSms") !== false,
            phone: smsPhoneRaw,
            href: smsPhone ? `sms:${smsPhone}?body=${encodeURIComponent(smsText)}` : "",
            iosHref: smsPhone ? `sms:${smsPhone}&body=${encodeURIComponent(smsText)}` : "",
            title: ui.t(resolvedLocale, "textWithSms"),
            description: ui.t(resolvedLocale, "smsChooserHint"),
        },
        whatsapp: {
            id: "whatsapp",
            enabled: !!getSetting("boothShowWhatsapp"),
            phone: whatsappPhoneRaw,
            href: whatsappPhone ? `https://wa.me/${whatsappPhone}?text=${encodeURIComponent(whatsappText)}` : "",
            title: ui.t(resolvedLocale, "whatsappChooserTitle"),
            description: whatsappInstruction,
        },
    };
}

function normalizePublicBaseUrl(value) {
    try {
        const url = new URL(String(value || "").trim());
        if (url.protocol !== "http:" && url.protocol !== "https:") return "";
        return url.origin;
    } catch {
        return "";
    }
}

function resolvePublicBaseUrl(req, configuredBaseUrl = process.env.BASE_URL) {
    const configured = normalizePublicBaseUrl(configuredBaseUrl);
    if (configured) return configured;
    const headers = req && req.headers || {};
    const forwarded = String(headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    const protocol = forwarded === "https" ? "https" : (req && req.protocol === "https" ? "https" : "http");
    const host = req && typeof req.get === "function" ? req.get("host") : headers.host;
    return host ? normalizePublicBaseUrl(`${protocol}://${host}`) : "";
}

function buildStartUrl(baseUrl, eventName, locale) {
    const origin = normalizePublicBaseUrl(baseUrl);
    if (!origin || !isValidEventName(eventName)) return "";
    const url = new URL("/start", origin);
    url.searchParams.set("event", eventName);
    url.searchParams.set("lang", i18n.normalizeLocale(locale) || i18n.DEFAULT_LOCALE);
    return url.toString();
}

function buildChannelLaunchPath(eventName, locale, channel, carryLocale = false) {
    if (!isValidEventName(eventName) || !["sms", "whatsapp"].includes(channel)) return "";
    const params = new URLSearchParams({
        event: eventName,
        lang: i18n.normalizeLocale(locale) || i18n.DEFAULT_LOCALE,
        channel,
    });
    if (carryLocale) params.set("carry", "1");
    return `/start/open?${params.toString()}`;
}

function buildChannelLaunchUrl(baseUrl, eventName, locale, channel, carryLocale = false) {
    const origin = normalizePublicBaseUrl(baseUrl);
    const launchPath = buildChannelLaunchPath(eventName, locale, channel, carryLocale);
    return origin && launchPath ? new URL(launchPath, origin).toString() : "";
}

function isValidEventName(value) {
    return typeof value === "string"
        && value.length > 0
        && value.length <= 256
        && value.trim() === value
        && /^[\p{L}\p{N}_-](?:[\p{L}\p{N} _-]*[\p{L}\p{N}_-])?$/u.test(value);
}

module.exports = {
    DEFAULT_FIRST_MESSAGE,
    buildChannelOptions,
    buildChannelLaunchPath,
    buildChannelLaunchUrl,
    buildStartUrl,
    isValidEventName,
    normalizePublicBaseUrl,
    resolveEventLocale,
    resolvePublicBaseUrl,
};

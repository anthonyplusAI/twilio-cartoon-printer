const settings = require("./settings");
const channels = require("./channels");
const kioskEmail = require("./kiosk-email");

function httpError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

function isKioskEmailPaused(env = process.env) {
    return String(env.KIOSK_EMAIL_PAUSED || "").toLowerCase() === "true";
}

function getKioskDeliveryChannels(eventName, locale, {
    settingsModule = settings,
    adapters = channels.ADAPTERS,
    emailProvider = kioskEmail,
    env = process.env,
} = {}) {
    const available = [];
    if (settingsModule.getForEvent("boothShowSms", eventName) !== false && adapters.sms.isConfigured()) {
        available.push("sms");
    }
    if (settingsModule.getForEvent("boothShowWhatsapp", eventName) === true
        && adapters.whatsapp.isConfigured()
        && settingsModule.getContentSid("delivery", locale)) {
        available.push("whatsapp");
    }
    if (!isKioskEmailPaused(env)
        && settingsModule.getForEvent("boothShowEmail", eventName) !== false
        && emailProvider.isConfigured()) {
        available.push("email");
    }
    return available;
}

function resolveKioskDeliveryChannel({
    requestedChannel,
    hasPhone,
    hasEmail = false,
    kioskSubmission,
    eventName,
    locale,
}, dependencies = {}) {
    const requested = String(requestedChannel || "").trim().toLowerCase();
    if (!kioskSubmission) {
        if (!hasPhone) return null;
        const selected = requested || "sms";
        if (selected !== "sms" && selected !== "whatsapp") {
            throw httpError(400, "CHANNEL_INVALID", `Unknown delivery channel "${selected}"`);
        }
        const adapter = (dependencies.adapters || channels.ADAPTERS)[selected];
        if (!adapter || !adapter.isConfigured()) {
            throw httpError(409, "CHANNEL_UNAVAILABLE", `${selected} delivery is not configured`);
        }
        if (selected === "whatsapp"
            && !(dependencies.settingsModule || settings).getContentSid("delivery", locale)) {
            throw httpError(409, "CHANNEL_UNAVAILABLE", `WhatsApp delivery template is not configured for locale ${locale}`);
        }
        return selected;
    }

    if (!requested || !["sms", "whatsapp", "email"].includes(requested)) {
        throw httpError(400, "CHANNEL_REQUIRED", "Choose SMS, WhatsApp, or Email delivery");
    }
    if (requested === "email" ? (!hasEmail || hasPhone) : (!hasPhone || hasEmail)) {
        throw httpError(400, "DESTINATION_INVALID", "Provide one destination for the selected delivery method");
    }
    const available = getKioskDeliveryChannels(eventName, locale, dependencies);
    if (!available.includes(requested)) {
        throw httpError(409, "CHANNEL_UNAVAILABLE", `${requested} delivery is not available for this kiosk`);
    }
    return requested;
}

module.exports = { getKioskDeliveryChannels, resolveKioskDeliveryChannel, isKioskEmailPaused };

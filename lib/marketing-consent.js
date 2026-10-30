const MARKETING_CONSENT_TEXT = "By sending this text, I agree to Twilio’s Terms (twil.io/terms) and Privacy Notice (twil.io/privacy) for marketing communications.\n\nMsg & data rates apply.";

function legacyMarketingOptInText(channel) {
    const channelName = { sms: "SMS", whatsapp: "WhatsApp" }[channel];
    if (!channelName) return "";
    return `I agree to receive recurring automated promotional ${channelName} messages from Twilio at this number. `
        + "Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help. "
        + "Terms: twil.io/terms Privacy: twil.io/privacy.";
}

function marketingOptInText(channel) {
    return channel === "sms" || channel === "whatsapp" ? MARKETING_CONSENT_TEXT : "";
}

function marketingOptInCopies(channel) {
    const current = marketingOptInText(channel);
    return current ? [current, legacyMarketingOptInText(channel)] : [];
}

function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/gu, " ").trim();
}

function matchingMarketingOptInText(body, channel) {
    const normalizedBody = normalizeWhitespace(body);
    return marketingOptInCopies(channel).find(copy => normalizedBody.includes(normalizeWhitespace(copy))) || "";
}

function hasMarketingOptIn(body, channel) {
    return !!matchingMarketingOptInText(body, channel);
}

function stripMarketingOptInText(value, channel) {
    let text = String(value || "");
    for (const copy of marketingOptInCopies(channel)) {
        const pattern = new RegExp(copy.trim().split(/\s+/u)
            .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("\\s+"), "gu");
        text = text.replace(pattern, "");
    }
    return text.trim();
}

function isMarketingStop(body, optOutType) {
    if (normalizeWhitespace(optOutType).toUpperCase() === "STOP") return true;
    return /^(?:STOP|STOPALL|STOP ALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/i.test(normalizeWhitespace(body));
}

function handleVerifiedInboundMarketingMessage({ phone, eventName, channel, messageSid, body, optOutType }, contacts) {
    if (isMarketingStop(body, optOutType)) {
        contacts.revokeMarketingConsent({ phone, eventName, channel, messageSid, body });
        return true;
    }
    if (hasMarketingOptIn(body, channel)) {
        contacts.recordMarketingOptIn({ phone, eventName, channel, messageSid, body });
    }
    return false;
}

module.exports = {
    MARKETING_CONSENT_TEXT,
    marketingOptInText,
    matchingMarketingOptInText,
    stripMarketingOptInText,
    hasMarketingOptIn,
    isMarketingStop,
    handleVerifiedInboundMarketingMessage,
};

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    __shouldSkipDeliveryMediaForTest: shouldSkipDeliveryMedia,
    __oversizedWhatsappImageSuffixForTest: oversizedWhatsappImageSuffix,
    __selectWhatsappDeliveryMediaForTest: selectWhatsappDeliveryMedia,
    __shouldUseRichDeliveryForTest: shouldUseRichDelivery,
    sendPrintCompletionMms,
} = require("../lib/queue");
const settings = require("../lib/settings");
const messaging = require("../lib/messaging");
const contacts = require("../lib/contacts");
const channels = require("../lib/channels");

test("share-page-only suppresses SMS media", () => {
    assert.equal(shouldSkipDeliveryMedia({ name: "sms" }, " Share: https://example.com", true), true);
});

test("share-page-only never suppresses WhatsApp portrait previews", () => {
    assert.equal(shouldSkipDeliveryMedia({ name: "whatsapp" }, " Share: https://example.com", true), false);
});

test("oversized WhatsApp portrait does not add a second URL when a share link exists", () => {
    assert.equal(oversizedWhatsappImageSuffix(" Share: twil.io/startup-labs-1", "https://example.com/s/job/img?e=event"), "");
});

test("oversized WhatsApp portrait retains its direct URL without a share link", () => {
    assert.equal(oversizedWhatsappImageSuffix("", "https://example.com/s/job/img?e=event"), "\nhttps://example.com/s/job/img?e=event");
});

test("oversized WhatsApp delivery template uses the compressed preview", () => {
    assert.deepEqual(selectWhatsappDeliveryMedia(6 * 1024 * 1024, {
        finalImageUrl: "https://example.com/s/job/img?e=event",
        finalImagePath: "s/job/img?e=event",
        mmsImageUrl: "https://example.com/s/job/mms?e=event",
        mmsImagePath: "s/job/mms?e=event",
    }), {
        imageUrl: "https://example.com/s/job/mms?e=event",
        templateImagePath: "s/job/mms?e=event",
    });
});

test("kiosk WhatsApp print completion reuses the approved delivery template", () => {
    const common = {
        templateKey: "deliveryPrint",
        adapterName: "whatsapp",
        imageUrl: "https://example.com/s/job/mms?e=event",
        contentSid: "HXdelivery",
        baseUrl: "https://example.com",
    };
    assert.equal(shouldUseRichDelivery({ ...common, kioskWhatsapp: true }), true);
    assert.equal(shouldUseRichDelivery({ ...common, kioskWhatsapp: false }), false);
});

test("STOP after portrait delivery prevents a scheduled promotional SMS", async () => {
    const originals = {
        get: settings.get,
        getForEvent: settings.getForEvent,
        getActiveStyles: settings.getActiveStyles,
        getActiveStyleList: settings.getActiveStyleList,
        getContentSid: settings.getContentSid,
        send: messaging.send,
        hasMarketingConsent: contacts.hasMarketingConsent,
        smsIsConfigured: channels.ADAPTERS.sms.isConfigured,
        setTimeout: global.setTimeout,
    };
    let consented = true;
    let promoTimer = null;
    const sent = [];
    settings.get = (key) => key === "adminPhones" ? [] : null;
    settings.getForEvent = (key) => ({
        defaultStyle: "cartoon", maxPrints: 2, enableShareLinks: false,
        leadCaptureMode: "off", enablePromoMessage: true, promoMessage: "New offers from Twilio",
        enableNps: false, sharePageOnly: false, pickupLocation: "",
    })[key];
    settings.getActiveStyles = () => ({ cartoon: { name: "Cartoon" } });
    settings.getActiveStyleList = () => ["cartoon"];
    settings.getContentSid = () => null;
    contacts.hasMarketingConsent = () => consented;
    channels.ADAPTERS.sms.isConfigured = () => true;
    messaging.send = async (_phone, templateKey) => { sent.push(templateKey); return { sid: `SM${sent.length}` }; };
    global.setTimeout = (callback, delay) => {
        if (delay === 15000) { promoTimer = callback; return 1; }
        return originals.setTimeout(callback, delay);
    };
    try {
        await sendPrintCompletionMms({
            userPhone: "+14155550106", appPhone: "+12065551234", eventName: "Event A",
            channel: "sms", locale: "en", style: "cartoon", styleName: "Cartoon",
            filePrefix: "promo-consent-test", baseUrl: "",
        }, "promo-consent-test.json", null);
        assert.deepEqual(sent, ["_raw"]);
        assert.equal(typeof promoTimer, "function");
        consented = false;
        promoTimer();
        await Promise.resolve();
        assert.deepEqual(sent, ["_raw"]);
    } finally {
        settings.get = originals.get;
        settings.getForEvent = originals.getForEvent;
        settings.getActiveStyles = originals.getActiveStyles;
        settings.getActiveStyleList = originals.getActiveStyleList;
        settings.getContentSid = originals.getContentSid;
        messaging.send = originals.send;
        contacts.hasMarketingConsent = originals.hasMarketingConsent;
        channels.ADAPTERS.sms.isConfigured = originals.smsIsConfigured;
        global.setTimeout = originals.setTimeout;
    }
});

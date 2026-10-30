const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    buildChannelOptions,
    buildChannelLaunchPath,
    buildChannelLaunchUrl,
    buildStartUrl,
    resolveEventLocale,
    resolvePublicBaseUrl,
} = require("../lib/channel-entry");

const FIRST_MESSAGE = "Hit send to start! 🚀";
const MARKETING_COPY = "By sending this text, I agree to Twilio’s Terms (twil.io/terms) and Privacy Notice (twil.io/privacy) for marketing communications.\n\nMsg & data rates apply.";
const DEFAULT_DRAFT = `${FIRST_MESSAGE}\n\n${MARKETING_COPY}`;
const LEGACY_SMS_OPT_IN = "I agree to receive recurring automated promotional SMS messages from Twilio at this number. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help. Terms: twil.io/terms Privacy: twil.io/privacy.";
const ENCODED_DEFAULT_DRAFT = encodeURIComponent(DEFAULT_DRAFT);

function getter(values) {
    return (key) => values[key];
}

test("channel options append the fixed marketing copy to custom SMS and WhatsApp messages in Portuguese", () => {
    const getSetting = getter({
        boothShowSms: true,
        boothSmsPhone: "+55 (11) 99999-0000",
        boothSmsInstructionText: "Start SMS",
        boothShowWhatsapp: true,
        boothWhatsappPhone: "whatsapp:+55 (11) 98888-0000",
        boothWhatsappPrefillText: "Start WhatsApp",
        boothWhatsappInstructionText: "Open WhatsApp to start",
    });

    const channels = buildChannelOptions({ locale: "pt_BR", getSetting });

    assert.equal(channels.sms.href, "sms:+5511999990000?body=" + encodeURIComponent(`Start SMS\n\n${MARKETING_COPY}`));
    assert.equal(channels.whatsapp.href, "https://wa.me/5511988880000?text=" + encodeURIComponent(`Start WhatsApp\n\n${MARKETING_COPY}`));
    assert.equal(channels.sms.title, "Abrir SMS");
    assert.equal(channels.whatsapp.title, "Abrir WhatsApp");
});

test("both channels prefill the complete portrait starter and fixed marketing copy by default", () => {
    const getSetting = getter({
        boothShowSms: true,
        boothSmsPhone: "+14155550111",
        boothShowWhatsapp: true,
        boothWhatsappPhone: "+14155550222",
    });
    const channels = buildChannelOptions({ locale: "en", getSetting });

    assert.equal(channels.sms.href, "sms:+14155550111?body=" + ENCODED_DEFAULT_DRAFT);
    assert.equal(channels.sms.iosHref, "sms:+14155550111&body=" + ENCODED_DEFAULT_DRAFT);
    assert.equal(channels.whatsapp.href, "https://wa.me/14155550222?text=" + ENCODED_DEFAULT_DRAFT);
});

test("explicitly empty first-message fields use the new launch fallback", () => {
    const getSetting = getter({
        boothShowSms: true,
        boothSmsPhone: "+14155550111",
        boothSmsInstructionText: "",
        boothShowWhatsapp: true,
        boothWhatsappPhone: "+14155550222",
        boothWhatsappPrefillText: "",
    });
    const channels = buildChannelOptions({ locale: "en", getSetting });

    assert.equal(channels.sms.href, "sms:+14155550111?body=" + ENCODED_DEFAULT_DRAFT);
    assert.equal(channels.whatsapp.href, "https://wa.me/14155550222?text=" + ENCODED_DEFAULT_DRAFT);
});

test("saved bundled marketing copy produces exactly one copy of the default draft", () => {
    const getSetting = getter({
        languageMode: "pt_BR",
        boothShowSms: true,
        boothSmsPhone: "+5511999990000",
        boothSmsInstructionText: DEFAULT_DRAFT,
        boothShowWhatsapp: true,
        boothWhatsappPhone: "+5511988880000",
        boothWhatsappPrefillText: DEFAULT_DRAFT,
    });
    const channels = buildChannelOptions({ locale: "pt_BR", getSetting });

    assert.equal(channels.sms.href, "sms:+5511999990000?body=" + ENCODED_DEFAULT_DRAFT);
    assert.equal(channels.whatsapp.href, "https://wa.me/5511988880000?text=" + ENCODED_DEFAULT_DRAFT);
});

test("old marketing query parameter does not alter the mandatory draft", () => {
    const getSetting = getter({
        boothShowSms: true,
        boothSmsPhone: "+14155550111",
        boothShowWhatsapp: true,
        boothWhatsappPhone: "+14155550222",
    });
    const channels = buildChannelOptions({ locale: "en", getSetting, marketingOptIn: true });

    assert.equal(channels.sms.href, "sms:+14155550111?body=" + ENCODED_DEFAULT_DRAFT);
    assert.equal(channels.sms.iosHref, "sms:+14155550111&body=" + ENCODED_DEFAULT_DRAFT);
    assert.equal(channels.whatsapp.href, "https://wa.me/14155550222?text=" + ENCODED_DEFAULT_DRAFT);
});

test("custom messages already containing marketing copy do not duplicate it", () => {
    const getSetting = getter({
        boothSmsPhone: "+14155550111",
        boothSmsInstructionText: `Custom SMS\r\n\r\n${MARKETING_COPY}\n\n${MARKETING_COPY}`,
        boothWhatsappPhone: "+14155550222",
        boothWhatsappPrefillText: `Custom WhatsApp\n\n${LEGACY_SMS_OPT_IN.replace("SMS", "WhatsApp")}`,
    });
    const channels = buildChannelOptions({ locale: "en", getSetting });

    assert.equal(channels.sms.href, "sms:+14155550111?body=" + encodeURIComponent(`Custom SMS\n\n${MARKETING_COPY}`));
    assert.equal(channels.whatsapp.href, "https://wa.me/14155550222?text=" + encodeURIComponent(`Custom WhatsApp\n\n${MARKETING_COPY}`));
});

test("old default text in saved events launches with the full portrait starter", () => {
    const getSetting = getter({
        boothSmsPhone: "+14155550111",
        boothSmsInstructionText: "Hit send to start",
        boothWhatsappPhone: "+14155550222",
        boothWhatsappPrefillText: "Hi",
    });
    const channels = buildChannelOptions({ locale: "en", getSetting });

    assert.equal(channels.sms.href, "sms:+14155550111?body=" + ENCODED_DEFAULT_DRAFT);
    assert.equal(channels.whatsapp.href, "https://wa.me/14155550222?text=" + ENCODED_DEFAULT_DRAFT);
});

test("channel launch URLs preserve event, locale, and channel", () => {
    assert.equal(
        buildChannelLaunchPath("Developer Week 2026", "pt-BR", "sms"),
        "/start/open?event=Developer+Week+2026&lang=pt_BR&channel=sms",
    );
    const path = buildChannelLaunchPath("Developer Week 2026", "pt-BR", "sms", true);
    assert.equal(path, "/start/open?event=Developer+Week+2026&lang=pt_BR&channel=sms&carry=1");
    assert.equal(
        buildChannelLaunchUrl("https://booth.example.com", "Developer Week 2026", "en", "whatsapp"),
        "https://booth.example.com/start/open?event=Developer+Week+2026&lang=en&channel=whatsapp",
    );
});

test("event locale honors overrides only in ask mode", () => {
    assert.equal(resolveEventLocale(getter({ languageMode: "ask" }), "pt-BR"), "pt_BR");
    assert.equal(resolveEventLocale(getter({ languageMode: "en" }), "pt-BR"), "en");
});

test("ask mode keeps the full starter when the chooser carries a page locale", () => {
    const getSetting = getter({
        languageMode: "ask",
        boothShowSms: true,
        boothSmsPhone: "+5511999990000",
        boothShowWhatsapp: true,
        boothWhatsappPhone: "+5511988880000",
    });
    const channels = buildChannelOptions({ locale: "pt_BR", getSetting, carryLocale: true });

    assert.equal(channels.sms.href, "sms:+5511999990000?body=" + ENCODED_DEFAULT_DRAFT);
    assert.equal(channels.sms.iosHref, "sms:+5511999990000&body=" + ENCODED_DEFAULT_DRAFT);
    assert.equal(channels.whatsapp.href, "https://wa.me/5511988880000?text=" + ENCODED_DEFAULT_DRAFT);
});

test("ask mode preserves custom first messages when the chooser carries a page locale", () => {
    const getSetting = getter({
        languageMode: "ask",
        boothSmsPhone: "+5511999990000",
        boothSmsInstructionText: "Custom SMS",
        boothWhatsappPhone: "+5511988880000",
        boothWhatsappPrefillText: "Custom WhatsApp",
    });
    const channels = buildChannelOptions({ locale: "pt_BR", getSetting, carryLocale: true });

    assert.equal(channels.sms.href, "sms:+5511999990000?body=" + encodeURIComponent(`Custom SMS\n\n${MARKETING_COPY}`));
    assert.equal(channels.whatsapp.href, "https://wa.me/5511988880000?text=" + encodeURIComponent(`Custom WhatsApp\n\n${MARKETING_COPY}`));
});

test("ask mode without a carried locale keeps the full starter", () => {
    const getSetting = getter({
        languageMode: "ask",
        boothSmsPhone: "+5511999990000",
        boothWhatsappPhone: "+5511988880000",
    });
    const channels = buildChannelOptions({ locale: "pt_BR", getSetting, carryLocale: false });

    assert.equal(channels.sms.href, "sms:+5511999990000?body=" + ENCODED_DEFAULT_DRAFT);
    assert.equal(channels.whatsapp.href, "https://wa.me/5511988880000?text=" + ENCODED_DEFAULT_DRAFT);
});

test("chooser URL preserves the exact event and normalized locale", () => {
    const url = buildStartUrl("https://booth.example.com/base/", "Developer Week 2026", "pt-BR");
    assert.equal(url, "https://booth.example.com/start?event=Developer+Week+2026&lang=pt_BR");
});

test("chooser URL safely supports configured Unicode event names", () => {
    const url = buildStartUrl("https://booth.example.com", "São Paulo", "en");
    assert.equal(new URL(url).searchParams.get("event"), "São Paulo");
});

test("configured public origin wins over request headers", () => {
    const req = { protocol: "http", headers: { host: "spoofed.example", "x-forwarded-proto": "http" } };
    assert.equal(resolvePublicBaseUrl(req, "https://booth.example.com/"), "https://booth.example.com");
});

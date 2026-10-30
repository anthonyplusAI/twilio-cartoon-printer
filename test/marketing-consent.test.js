const { test } = require("node:test");
const assert = require("node:assert/strict");
const { marketingOptInText, hasMarketingOptIn, isMarketingStop } = require("../lib/marketing-consent");

const MARKETING_COPY = "By sending this text, I agree to Twilio’s Terms (twil.io/terms) and Privacy Notice (twil.io/privacy) for marketing communications.\n\nMsg & data rates apply.";
const LEGACY_SMS_COPY = "I agree to receive recurring automated promotional SMS messages from Twilio at this number. "
    + "Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help. "
    + "Terms: twil.io/terms Privacy: twil.io/privacy.";

test("marketing opt-in copy is the exact mandatory starter disclosure for SMS", () => {
    assert.equal(marketingOptInText("sms"),
        MARKETING_COPY);
});

test("the same marketing copy applies to WhatsApp, but not unknown channels", () => {
    assert.equal(marketingOptInText("whatsapp"), MARKETING_COPY);
    assert.equal(marketingOptInText("email"), "");
});

test("sent SMS draft counts as marketing opt-in despite line breaks", () => {
    const body = "Hit send to start! 🚀\n\n"
        + MARKETING_COPY.replace("Privacy Notice", "Privacy\nNotice");
    assert.equal(hasMarketingOptIn(body, "sms"), true);
    assert.equal(hasMarketingOptIn(body, "whatsapp"), true);
    assert.equal(hasMarketingOptIn(body, "email"), false);
});

test("a starter without the fixed disclosure does not record marketing consent", () => {
    assert.equal(hasMarketingOptIn("Hit send to start! 🚀", "sms"), false);
    assert.equal(hasMarketingOptIn("Msg & data rates apply.", "whatsapp"), false);
});

test("previous channel-specific opt-in drafts remain recognizable", () => {
    assert.equal(hasMarketingOptIn(`Hit send to start! 🚀\n\n${LEGACY_SMS_COPY}`, "sms"), true);
    assert.equal(hasMarketingOptIn(LEGACY_SMS_COPY.replace("SMS", "WhatsApp"), "whatsapp"), true);
    assert.equal(hasMarketingOptIn(LEGACY_SMS_COPY, "whatsapp"), false);
});

test("standalone STOP is recognized without treating the opt-in disclosure as STOP", () => {
    assert.equal(isMarketingStop(" STOP "), true);
    assert.equal(isMarketingStop("Hit send to start! Reply STOP to opt out."), false);
    assert.equal(isMarketingStop("HELP", "STOP"), true);
});

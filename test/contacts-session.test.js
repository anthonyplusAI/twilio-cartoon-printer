const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Use a temp dir so tests don't touch real data
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "contacts-test-"));
const CONTACTS_FILE = path.join(tmpDir, "contacts.json");

// Patch DATA_DIR before requiring contacts
const originalEnv = process.env.DATA_DIR;
process.env.DATA_DIR = tmpDir;

// Clear require cache so DATA_DIR is picked up fresh
delete require.cache[require.resolve("../lib/contacts")];
const contacts = require("../lib/contacts");
const { handleVerifiedInboundMarketingMessage } = require("../lib/marketing-consent");
const MARKETING_COPY = "By sending this text, I agree to Twilio’s Terms (twil.io/terms) and Privacy Notice (twil.io/privacy) for marketing communications.\n\nMsg & data rates apply.";
const LEGACY_SMS_COPY = "I agree to receive recurring automated promotional SMS messages from Twilio at this number. "
    + "Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help. "
    + "Terms: twil.io/terms Privacy: twil.io/privacy.";

test("recordInbound: sets lastInboundAt on first call", () => {
    const before = Date.now();
    contacts.recordInbound("+14155551111", "sms");
    const after = Date.now();
    const ts = contacts.getLastInboundAt("+14155551111");
    assert.ok(ts >= before && ts <= after, "timestamp should be in range");
});

test("recordInbound: updates lastInboundAt on repeat calls", async () => {
    contacts.recordInbound("+14155552222", "sms");
    const first = contacts.getLastInboundAt("+14155552222");
    await new Promise(r => setTimeout(r, 5));
    contacts.recordInbound("+14155552222", "sms");
    const second = contacts.getLastInboundAt("+14155552222");
    assert.ok(second > first, "second timestamp should be later");
});

test("recordInbound: sets preferredChannel on first call", () => {
    contacts.recordInbound("+14155553333", "whatsapp");
    assert.equal(contacts.getPreferredChannel("+14155553333"), "whatsapp");
});

test("recordInbound: updates preferredChannel to the latest inbound channel", () => {
    contacts.recordInbound("+14155554444", "sms");
    contacts.recordInbound("+14155554444", "whatsapp");
    assert.equal(contacts.getPreferredChannel("+14155554444"), "whatsapp");
});

test("recordInbound: isolates session timestamps by channel", () => {
    contacts.recordInbound("+14155556666", "sms");
    assert.ok(contacts.getLastInboundAt("+14155556666", "sms") > 0);
    assert.equal(contacts.getLastInboundAt("+14155556666", "whatsapp"), null);
});

test("recovered inbound timestamps do not reopen an old WhatsApp window or replace a newer channel", () => {
    const phone = "+14155559006";
    const original = Date.now() - 25 * 60 * 60 * 1000;
    contacts.recordInbound(phone, "whatsapp", original);
    assert.equal(contacts.getLastInboundAt(phone, "whatsapp"), original);
    const newer = Date.now();
    contacts.recordInbound(phone, "sms", newer);
    contacts.recordInbound(phone, "whatsapp", original);
    assert.equal(contacts.getLastInboundAt(phone, "whatsapp"), original);
    assert.equal(contacts.getPreferredChannel(phone), "sms");
});

test("getLastInboundAt: returns null for unknown phone", () => {
    assert.equal(contacts.getLastInboundAt("+19995550000"), null);
});

test("getPreferredChannel: returns null for unknown phone", () => {
    assert.equal(contacts.getPreferredChannel("+19995550001"), null);
});

test("recordInbound: persists to disk (survives re-require)", () => {
    contacts.recordInbound("+14155555555", "whatsapp");
    // Re-require contacts fresh — should load from disk
    delete require.cache[require.resolve("../lib/contacts")];
    const fresh = require("../lib/contacts");
    fresh.load();
    assert.equal(fresh.getPreferredChannel("+14155555555"), "whatsapp");
    assert.ok(fresh.getLastInboundAt("+14155555555") > 0);
});

test("preferred locale is stored per phone and event", () => {
    contacts.setPreferredLocale("+14155557777", "Event A", "pt_BR");
    contacts.setPreferredLocale("+14155557777", "Event B", "en");
    assert.equal(contacts.getPreferredLocale("+14155557777", "Event A"), "pt_BR");
    assert.equal(contacts.getPreferredLocale("+14155557777", "Event B"), "en");
});

test("deleteByPhone: removes session key when no eventName given", () => {
    contacts.recordContact("+14155556666", "+12065551234", "testEvent");
    contacts.recordInbound("+14155556666", "sms");
    assert.ok(contacts.getLastInboundAt("+14155556666") !== null);
    contacts.deleteByPhone("+14155556666");
    assert.equal(contacts.getLastInboundAt("+14155556666"), null);
    assert.equal(contacts.getPreferredChannel("+14155556666"), null);
});

test("deleteByPhone: preserves session key when eventName given", () => {
    contacts.recordContact("+14155557777", "+12065551234", "testEvent");
    contacts.recordInbound("+14155557777", "whatsapp");
    contacts.deleteByPhone("+14155557777", "testEvent");
    // Session key should survive per-event deletion
    assert.ok(contacts.getPreferredChannel("+14155557777") !== null);
});

test("deleteByEvent: preserves session keys", () => {
    contacts.recordContact("+14155558888", "+12065551234", "eventToDelete");
    contacts.recordInbound("+14155558888", "sms");
    contacts.deleteByEvent("eventToDelete");
    // Contact record gone, session key survives
    assert.ok(contacts.getPreferredChannel("+14155558888") !== null);
});

test("getDropOffs: returns contacts with no active jobs", () => {
    contacts.recordContact("+14155559001", "+12065551234", "evt1");
    contacts.recordContact("+14155559002", "+12065551234", "evt1");
    const dropOffs = contacts.getDropOffs("evt1", [], []);
    const phones = dropOffs.map(d => d.phone);
    assert.ok(phones.includes("+14155559001"));
    assert.ok(phones.includes("+14155559002"));
});

test("getDropOffs: excludes contacts with active jobs", () => {
    contacts.recordContact("+14155559003", "+12065551234", "evt2");
    const activeJobs = [{ userPhone: "+14155559003", eventName: "evt2" }];
    const dropOffs = contacts.getDropOffs("evt2", activeJobs, []);
    assert.equal(dropOffs.find(d => d.phone === "+14155559003"), undefined);
});

test("getDropOffs: excludes admin phones", () => {
    contacts.recordContact("+14155559004", "+12065551234", "evt3");
    const dropOffs = contacts.getDropOffs("evt3", [], ["+14155559004"]);
    assert.equal(dropOffs.find(d => d.phone === "+14155559004"), undefined);
});

test("getDropOffs: skips __session__ keys (no session records in results)", () => {
    contacts.recordInbound("+14155559005", "sms");
    const dropOffs = contacts.getDropOffs("evt4", [], []);
    // session key should never appear as a drop-off
    assert.equal(dropOffs.find(d => d.phone === "+14155559005" && !d.eventName), undefined);
});

test("markNudged: sets nudgedAt on existing contact", () => {
    contacts.recordContact("+14155559006", "+12065551234", "evt5");
    const before = Date.now();
    const result = contacts.markNudged("+14155559006", "evt5");
    assert.equal(result, true);
});

test("markNudged: returns false for unknown contact", () => {
    const result = contacts.markNudged("+19999990000", "unknown-event");
    assert.equal(result, false);
});

test("marketing consent defaults to false for an attendee with no opt-in", () => {
    assert.equal(contacts.hasMarketingConsent("+14155550101", "Event A", "sms"), false);
});

test("sent marketing opt-in is stored with inbound message evidence", () => {
    const phone = "+14155550102";
    const copy = MARKETING_COPY;
    const body = `Hit send to start! 🚀\n\n${copy}`;
    assert.equal(contacts.recordMarketingOptIn({
        phone, eventName: "Event A", channel: "sms", messageSid: "SMconsent001", body, receivedAt: 1000,
    }), true);
    assert.equal(contacts.hasMarketingConsent(phone, "Event A", "sms"), true);
    assert.equal(contacts.hasMarketingConsent(phone, "Event B", "sms"), false);
    assert.equal(contacts.hasMarketingConsent(phone, "Event A", "whatsapp"), false);
    assert.deepEqual(contacts.getMarketingConsent(phone, "Event A", "sms"), {
        phone, eventName: "Event A", channel: "sms", messageSid: "SMconsent001",
        consentedAt: 1000, body, copy, method: "inbound_message", revokedAt: null,
    });
});

test("legacy opt-in evidence retains the exact consent copy that was sent", () => {
    const phone = "+14155550109";
    const body = `Hit send to start! 🚀\n\n${LEGACY_SMS_COPY}`;
    assert.equal(contacts.recordMarketingOptIn({
        phone, eventName: "Event A", channel: "sms", messageSid: "SMlegacy001", body, receivedAt: 1001,
    }), true);
    assert.equal(contacts.getMarketingConsent(phone, "Event A", "sms").copy, LEGACY_SMS_COPY);
});

test("STOP revokes every event on the inbound channel but preserves the other channel", () => {
    const phone = "+14155550103";
    const smsCopy = MARKETING_COPY;
    const whatsappCopy = MARKETING_COPY;
    contacts.recordMarketingOptIn({ phone, eventName: "Event A", channel: "sms", messageSid: "SMconsentA", body: smsCopy, receivedAt: 1000 });
    contacts.recordMarketingOptIn({ phone, eventName: "Event B", channel: "sms", messageSid: "SMconsentB", body: smsCopy, receivedAt: 1001 });
    contacts.recordMarketingOptIn({ phone, eventName: "Event A", channel: "whatsapp", messageSid: "SMconsentWA", body: whatsappCopy, receivedAt: 1002 });

    assert.equal(contacts.revokeMarketingConsent({ phone, channel: "sms", eventName: "Event B", messageSid: "SMstop", body: "STOP", receivedAt: 2000 }), 2);
    assert.equal(contacts.hasMarketingConsent(phone, "Event A", "sms"), false);
    assert.equal(contacts.hasMarketingConsent(phone, "Event B", "sms"), false);
    assert.equal(contacts.hasMarketingConsent(phone, "Event A", "whatsapp"), true);
    assert.equal(contacts.getMarketingConsent(phone, "Event A", "sms").revokedAt, 2000);
    assert.equal(contacts.getMarketingConsent(phone, "Event A", "sms").revocationMessageSid, "SMstop");
    assert.equal(contacts.getMarketingConsent(phone, "Event A", "sms").revocationBody, "STOP");
});

test("a generic START after STOP does not restore marketing consent", () => {
    const phone = "+14155550104";
    const copy = MARKETING_COPY;
    const inbound = { phone, eventName: "Event A", channel: "sms" };
    assert.equal(handleVerifiedInboundMarketingMessage({ ...inbound, messageSid: "SMopt", body: copy }, contacts), false);
    assert.equal(contacts.hasMarketingConsent(phone, "Event A", "sms"), true);
    assert.equal(handleVerifiedInboundMarketingMessage({ ...inbound, messageSid: "SMstop2", body: "STOP" }, contacts), true);
    assert.equal(contacts.hasMarketingConsent(phone, "Event A", "sms"), false);
    assert.equal(handleVerifiedInboundMarketingMessage({ ...inbound, messageSid: "SMstart", body: "START" }, contacts), false);
    assert.equal(contacts.hasMarketingConsent(phone, "Event A", "sms"), false);
});

test("one inbound MessageSid cannot opt a person into two events on webhook retry", () => {
    const phone = "+14155550105";
    const body = MARKETING_COPY;
    const inbound = { phone, channel: "sms", messageSid: "SMretry001", body, receivedAt: 3000 };
    assert.equal(contacts.recordMarketingOptIn({ ...inbound, eventName: "Event A" }), true);
    assert.equal(contacts.recordMarketingOptIn({ ...inbound, eventName: "Event B" }), false);
    assert.equal(contacts.hasMarketingConsent(phone, "Event B", "sms"), false);
});

test("marketing consent evidence is not shown as an unfinished attendee", () => {
    const phone = "+14155550107";
    const body = MARKETING_COPY;
    contacts.recordMarketingOptIn({ phone, eventName: "Consent Only", channel: "sms", messageSid: "SMconsentOnly", body });
    assert.deepEqual(contacts.getDropOffs("Consent Only", [], []), []);
});

test("phone deletion removes marketing consent for the selected scope", () => {
    const phone = "+14155550108";
    const body = MARKETING_COPY;
    contacts.recordMarketingOptIn({ phone, eventName: "Event A", channel: "sms", messageSid: "SMdeleteA", body });
    contacts.recordMarketingOptIn({ phone, eventName: "Event B", channel: "sms", messageSid: "SMdeleteB", body });
    contacts.deleteByPhone(phone, "Event A");
    assert.equal(contacts.getMarketingConsent(phone, "Event A", "sms"), null);
    assert.equal(contacts.hasMarketingConsent(phone, "Event B", "sms"), true);
    contacts.deleteByPhone(phone);
    assert.equal(contacts.getMarketingConsent(phone, "Event B", "sms"), null);
});

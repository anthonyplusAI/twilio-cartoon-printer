const fs = require("fs");
const path = require("path");
const { matchingMarketingOptInText } = require("./marketing-consent");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const CONTACTS_FILE = path.join(DATA_DIR, "contacts.json");

// ── State ────────────────────────────────────────────────────────────────────

let contactsData = {};

// ── Persistence ──────────────────────────────────────────────────────────────

function load() {
    try {
        if (fs.existsSync(CONTACTS_FILE)) {
            contactsData = JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf-8"));
        }
    } catch {
        contactsData = {};
    }
    const count = Object.keys(contactsData).length;
    if (count > 0) console.log(`📇 Contacts loaded (${count} records)`);
}

let _writeCounter = 0;
function atomicWriteSync(filePath, data) {
    const tmp = filePath + `.tmp.${process.pid}.${_writeCounter++}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, filePath);
}

function save() {
    atomicWriteSync(CONTACTS_FILE, JSON.stringify(contactsData, null, 2));
}

// ── Record first contact ─────────────────────────────────────────────────────

function recordContact(phone, appPhone, eventName) {
    const key = `${phone}:${eventName}`;
    if (contactsData[key]) return; // already tracked
    contactsData[key] = {
        phone,
        appPhone,
        eventName,
        firstContactAt: Date.now(),
        nudgedAt: null,
    };
    save();
}

// ── Session tracking ─────────────────────────────────────────────────────────

function recordInbound(phone, channelName, receivedAt = Date.now()) {
    if (!phone) return;
    const sessionKey = `__session__:${phone}`;
    const at = Number.isFinite(receivedAt) ? receivedAt : Date.now();
    if (!contactsData[sessionKey]) {
        contactsData[sessionKey] = { phone, preferredChannel: channelName, lastInboundAt: at, lastInboundAtByChannel: {} };
    }
    const record = contactsData[sessionKey];
    if (at >= (record.lastInboundAt || 0)) record.preferredChannel = channelName;
    record.lastInboundAt = Math.max(record.lastInboundAt || 0, at);
    if (!record.lastInboundAtByChannel) record.lastInboundAtByChannel = {};
    record.lastInboundAtByChannel[channelName] = Math.max(record.lastInboundAtByChannel[channelName] || 0, at);
    save();
}

function getLastInboundAt(phone, channelName) {
    const record = contactsData[`__session__:${phone}`];
    if (!record) return null;
    if (!channelName) return record.lastInboundAt || null;
    if (record.lastInboundAtByChannel && record.lastInboundAtByChannel[channelName]) {
        return record.lastInboundAtByChannel[channelName];
    }
    // Existing persisted sessions predate per-channel timestamps.
    return record.preferredChannel === channelName ? (record.lastInboundAt || null) : null;
}

function getPreferredChannel(phone) {
    const record = contactsData[`__session__:${phone}`];
    return record ? record.preferredChannel : null;
}

function localeKey(phone, eventName) {
    return `__locale__:${phone}:${eventName}`;
}

function setPreferredLocale(phone, eventName, locale) {
    if (!phone || !eventName || !locale) return;
    contactsData[localeKey(phone, eventName)] = { phone, eventName, preferredLocale: locale, updatedAt: Date.now() };
    save();
}

function getPreferredLocale(phone, eventName) {
    const record = contactsData[localeKey(phone, eventName)];
    return record ? record.preferredLocale : null;
}

function marketingConsentKey(phone, eventName, channel) {
    return `__marketing__:${phone}:${channel}:${eventName}`;
}

function recordMarketingOptIn({ phone, eventName, channel, messageSid, body, receivedAt = Date.now() } = {}) {
    const copy = matchingMarketingOptInText(body, channel);
    if (!phone || !eventName || !messageSid || !copy) return false;
    const key = marketingConsentKey(phone, eventName, channel);
    if (Object.entries(contactsData).some(([existingKey, record]) =>
        existingKey.startsWith("__marketing__:") && record.messageSid === messageSid)) return false;
    contactsData[key] = {
        phone, eventName, channel, messageSid,
        consentedAt: Number.isFinite(receivedAt) ? receivedAt : Date.now(),
        body, copy, method: "inbound_message", revokedAt: null,
    };
    save();
    return true;
}

function getMarketingConsent(phone, eventName, channel) {
    const record = contactsData[marketingConsentKey(phone, eventName, channel)];
    return record ? { ...record } : null;
}

function hasMarketingConsent(phone, eventName, channel) {
    const record = getMarketingConsent(phone, eventName, channel);
    return !!(record && record.consentedAt && record.revokedAt === null);
}

function revokeMarketingConsent({ phone, channel, eventName, messageSid, body, receivedAt = Date.now() } = {}) {
    if (!phone || !channel) return 0;
    const prefix = `__marketing__:${phone}:${channel}:`;
    const revokedAt = Number.isFinite(receivedAt) ? receivedAt : Date.now();
    let revoked = 0;
    for (const [key, record] of Object.entries(contactsData)) {
        if (!key.startsWith(prefix) || record.revokedAt !== null) continue;
        record.revokedAt = revokedAt;
        record.revocationMessageSid = messageSid || null;
        record.revocationBody = body || null;
        record.revokedInEvent = eventName || null;
        revoked++;
    }
    if (revoked) save();
    return revoked;
}

// ── Query drop-offs ──────────────────────────────────────────────────────────

function getDropOffs(eventName, activeJobs, adminPhones) {
    // Build set of phone:event pairs that have any job in the pipeline
    const activeSet = new Set();
    for (const job of activeJobs) {
        if (job.userPhone && job.eventName) {
            activeSet.add(`${job.userPhone}:${job.eventName}`);
        }
    }

    const adminSet = new Set(adminPhones || []);
    const dropOffs = [];

    for (const [key, contact] of Object.entries(contactsData)) {
        if (key.startsWith("__session__:") || key.startsWith("__locale__:") || key.startsWith("__marketing__:")) continue;
        // Filter by event
        if (eventName && eventName !== "all" && contact.eventName !== eventName) continue;
        // Skip admins
        if (adminSet.has(contact.phone)) continue;
        // Skip users with active or completed jobs
        if (activeSet.has(key)) continue;

        dropOffs.push(contact);
    }

    // Sort by most recent first
    dropOffs.sort((a, b) => (b.firstContactAt || 0) - (a.firstContactAt || 0));
    return dropOffs;
}

// ── Nudge ────────────────────────────────────────────────────────────────────

function markNudged(phone, eventName) {
    const key = `${phone}:${eventName}`;
    if (!contactsData[key]) return false;
    contactsData[key].nudgedAt = Date.now();
    save();
    return true;
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

function deleteByPhone(phone, eventName) {
    let deleted = 0;
    for (const key of Object.keys(contactsData)) {
        if (key.startsWith(phone + ":") && (!eventName || key === `${phone}:${eventName}`)) {
            delete contactsData[key];
            deleted++;
        }
        if (!eventName && key === `__session__:${phone}`) {
            delete contactsData[key];
            deleted++;
        }
        if (key.startsWith(`__locale__:${phone}:`) && (!eventName || key === localeKey(phone, eventName))) {
            delete contactsData[key];
            deleted++;
        }
        if (key.startsWith(`__marketing__:${phone}:`) && (!eventName || contactsData[key].eventName === eventName)) {
            delete contactsData[key];
            deleted++;
        }
    }
    if (deleted > 0) save();
    return deleted;
}

// Session keys survive deleteByEvent; locale and marketing keys are event-specific.
function deleteByEvent(eventName) {
    let deleted = 0;
    for (const key of Object.keys(contactsData)) {
        if (key.endsWith(":" + eventName)) {
            delete contactsData[key];
            deleted++;
        }
    }
    if (deleted > 0) save();
    return deleted;
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = { load, recordContact, recordInbound, getLastInboundAt, getPreferredChannel, setPreferredLocale, getPreferredLocale, recordMarketingOptIn, getMarketingConsent, hasMarketingConsent, revokeMarketingConsent, getDropOffs, markNudged, deleteByPhone, deleteByEvent };

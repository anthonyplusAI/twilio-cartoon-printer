// Signed SendGrid Event Webhook for kiosk portrait email status. SendGrid
// signs the timestamp followed by the exact request bytes with ECDSA P-256.
const crypto = require("node:crypto");
const express = require("express");

const SIGNATURE_HEADER = "x-twilio-email-event-webhook-signature";
const TIMESTAMP_HEADER = "x-twilio-email-event-webhook-timestamp";
const PREFIX_RE = /^[A-Za-z0-9_-]+$/;
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS_EVENTS = new Set(["processed", "deferred", "delivered", "bounce", "dropped", "spamreport"]);

function publicKeyObject(encoded) {
    if (typeof encoded !== "string" || !encoded.trim()) return null;
    try {
        const value = encoded.trim();
        const key = value.includes("-----BEGIN PUBLIC KEY-----")
            ? crypto.createPublicKey(value.replace(/\\n/g, "\n"))
            : crypto.createPublicKey({
                key: Buffer.from(value, "base64"), format: "der", type: "spki",
            });
        if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
        return key;
    } catch { return null; }
}

function verifySendGridSignature(rawBody, signature, timestamp, key) {
    if (!Buffer.isBuffer(rawBody) || typeof signature !== "string" || typeof timestamp !== "string"
        || !/^\d{10,13}$/.test(timestamp) || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) return false;
    const publicKey = typeof key === "string" ? publicKeyObject(key) : key;
    if (!publicKey) return false;
    try {
        const signedBytes = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);
        return crypto.verify("sha256", signedBytes, publicKey, Buffer.from(signature, "base64"));
    } catch { return false; }
}

function supportedEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) return null;
    const status = String(event.event || "").toLowerCase().replace(/[\s_-]/g, "");
    if (!STATUS_EVENTS.has(status)) return null;
    // Mail Send custom_args appear as top-level webhook fields. Accept their
    // nested form as well for compatibility with manually replayed fixtures.
    const prefix = event.kiosk_file_prefix || event.custom_args?.kiosk_file_prefix;
    const requestId = event.kiosk_request_id || event.custom_args?.kiosk_request_id;
    if (typeof prefix !== "string" || !PREFIX_RE.test(prefix)
        || typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) return null;
    const timestamp = Number(event.timestamp);
    return {
        prefix,
        requestId,
        status,
        providerId: typeof event.sg_message_id === "string" ? event.sg_message_id.slice(0, 200) : null,
        eventId: typeof event.sg_event_id === "string" ? event.sg_event_id.slice(0, 120) : null,
        reason: typeof event.reason === "string" ? event.reason.slice(0, 160) : null,
        timestamp: Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null,
    };
}

function createKioskSendGridStatusRouter({
    getPublicKey = () => process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY,
    update = (...args) => require("./queue").updateKioskEmailFromProvider(...args),
} = {}) {
    const router = express.Router();
    router.post("/sendgrid-events", express.raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
        const key = publicKeyObject(getPublicKey());
        if (!key) return res.sendStatus(503);
        if (!Buffer.isBuffer(req.body)) return res.sendStatus(415);
        if (!verifySendGridSignature(req.body, req.get(SIGNATURE_HEADER), req.get(TIMESTAMP_HEADER), key)) {
            return res.sendStatus(403);
        }

        let events;
        try { events = JSON.parse(req.body.toString("utf8")); }
        catch { return res.sendStatus(400); }
        if (!Array.isArray(events) || events.length > 1000) return res.sendStatus(400);

        try {
            for (const rawEvent of events) {
                const event = supportedEvent(rawEvent);
                if (!event) continue;
                await update(event.prefix, event.requestId, {
                    status: event.status,
                    providerId: event.providerId,
                    eventId: event.eventId,
                    reason: event.reason,
                    timestamp: event.timestamp,
                });
            }
            return res.sendStatus(204);
        } catch (error) {
            // A 5xx asks SendGrid to retry the batch. Event updates are
            // idempotent, so an earlier event in this batch may be repeated.
            console.error(`⚠️  Kiosk SendGrid callback failed: ${error.message}`);
            return res.sendStatus(500);
        }
    });
    return router;
}

function mountKioskSendGridStatus(app) {
    app.use("/api/kiosk-delivery", createKioskSendGridStatusRouter());
}

module.exports = {
    verifySendGridSignature,
    createKioskSendGridStatusRouter,
    mountKioskSendGridStatus,
};

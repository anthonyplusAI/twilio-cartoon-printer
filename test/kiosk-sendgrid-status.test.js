const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");

const {
    verifySendGridSignature,
    createKioskSendGridStatusRouter,
} = require("../lib/kiosk-sendgrid-status");

const SIGNATURE_HEADER = "x-twilio-email-event-webhook-signature";
const TIMESTAMP_HEADER = "x-twilio-email-event-webhook-timestamp";
const REQUEST_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function signingFixture() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const encodedPublicKey = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const pemPublicKey = publicKey.export({ format: "pem", type: "spki" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = (rawBody) => crypto.sign("sha256", Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]), privateKey)
        .toString("base64");
    return { encodedPublicKey, pemPublicKey, timestamp, sign };
}

test("SendGrid verification uses the timestamp and exact raw body", () => {
    const fixture = signingFixture();
    const rawBody = Buffer.from(' [ {"event":"delivered"} ] \n');
    const signature = fixture.sign(rawBody);
    assert.equal(verifySendGridSignature(rawBody, signature, fixture.timestamp, fixture.encodedPublicKey), true);
    assert.equal(verifySendGridSignature(rawBody, signature, fixture.timestamp, fixture.pemPublicKey), true);
    assert.equal(verifySendGridSignature(Buffer.from('[{"event":"delivered"}]'), signature,
        fixture.timestamp, fixture.encodedPublicKey), false);
    assert.equal(verifySendGridSignature(rawBody, signature, String(Number(fixture.timestamp) + 1),
        fixture.encodedPublicKey), false);
});

test("signed SendGrid batches update only correlated kiosk email events", async () => {
    const fixture = signingFixture();
    const updates = [];
    const app = express();
    app.use("/api/kiosk-delivery", createKioskSendGridStatusRouter({
        getPublicKey: () => fixture.encodedPublicKey,
        update: async (...args) => { updates.push(args); return true; },
    }));
    const server = await new Promise((resolve, reject) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
        listening.on("error", reject);
    });
    try {
        const url = `http://127.0.0.1:${server.address().port}/api/kiosk-delivery/sendgrid-events`;
        const events = [
            { event: "processed", kiosk_file_prefix: "job_123", kiosk_request_id: REQUEST_ID,
                sg_message_id: "sg-1", sg_event_id: "event-1", timestamp: 1750000000 },
            { event: "delivered", kiosk_file_prefix: "job_123", kiosk_request_id: REQUEST_ID,
                sg_message_id: "sg-1", sg_event_id: "event-2", timestamp: 1750000001 },
            { event: "bounce", kiosk_file_prefix: "job_456", kiosk_request_id: REQUEST_ID,
                reason: "Mailbox rejected", sg_event_id: "event-3" },
            { event: "dropped", custom_args: { kiosk_file_prefix: "job_789", kiosk_request_id: REQUEST_ID } },
            { event: "spam report", kiosk_file_prefix: "job_900", kiosk_request_id: REQUEST_ID },
            { event: "Spam_Report", kiosk_file_prefix: "job_902", kiosk_request_id: REQUEST_ID },
            { event: "deferred", kiosk_file_prefix: "job_901", kiosk_request_id: REQUEST_ID },
            { event: "open", kiosk_file_prefix: "job_123", kiosk_request_id: REQUEST_ID },
            { event: "delivered", kiosk_file_prefix: "../wrong", kiosk_request_id: REQUEST_ID },
            { event: "delivered", kiosk_file_prefix: "unrelated", kiosk_request_id: "not-a-request-id" },
        ];
        const rawBody = `\n${JSON.stringify(events)}\n`;
        const send = (body, signature = fixture.sign(body), contentType = "application/json") => fetch(url, {
            method: "POST",
            body,
            headers: {
                "content-type": contentType,
                [SIGNATURE_HEADER]: signature,
                [TIMESTAMP_HEADER]: fixture.timestamp,
            },
        });

        const forged = await send(rawBody, "AAAA");
        assert.equal(forged.status, 403);
        assert.equal(updates.length, 0);

        const modified = await send(rawBody + " ", fixture.sign(rawBody));
        assert.equal(modified.status, 403);
        assert.equal(updates.length, 0);

        const valid = await send(rawBody);
        assert.equal(valid.status, 204);
        assert.deepEqual(updates, [
            ["job_123", REQUEST_ID, { status: "processed", providerId: "sg-1", eventId: "event-1", reason: null, timestamp: 1750000000 }],
            ["job_123", REQUEST_ID, { status: "delivered", providerId: "sg-1", eventId: "event-2", reason: null, timestamp: 1750000001 }],
            ["job_456", REQUEST_ID, { status: "bounce", providerId: null, eventId: "event-3", reason: "Mailbox rejected", timestamp: null }],
            ["job_789", REQUEST_ID, { status: "dropped", providerId: null, eventId: null, reason: null, timestamp: null }],
            ["job_900", REQUEST_ID, { status: "spamreport", providerId: null, eventId: null, reason: null, timestamp: null }],
            ["job_902", REQUEST_ID, { status: "spamreport", providerId: null, eventId: null, reason: null, timestamp: null }],
            ["job_901", REQUEST_ID, { status: "deferred", providerId: null, eventId: null, reason: null, timestamp: null }],
        ]);

        const badJson = await send("not-json");
        assert.equal(badJson.status, 400);
        const wrongType = await send(rawBody, fixture.sign(rawBody), "text/plain");
        assert.equal(wrongType.status, 415);
        assert.equal(updates.length, 7);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("SendGrid webhook refuses requests when its verification key is missing", async () => {
    const app = express();
    app.use("/api/kiosk-delivery", createKioskSendGridStatusRouter({ getPublicKey: () => "" }));
    const server = await new Promise((resolve, reject) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
        listening.on("error", reject);
    });
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/kiosk-delivery/sendgrid-events`, {
            method: "POST", body: "[]", headers: { "content-type": "application/json" },
        });
        assert.equal(response.status, 503);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

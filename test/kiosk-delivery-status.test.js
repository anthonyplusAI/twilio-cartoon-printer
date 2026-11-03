const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const twilio = require("twilio");

const { isPublicRoute } = require("../lib/auth");
const { createTwilioWebhookValidator } = require("../lib/twilio-webhook");
const { createKioskDeliveryStatusRouter } = require("../lib/kiosk-delivery-status");

test("kiosk Twilio callback is public only to a signature-validated route", async () => {
    assert.equal(isPublicRoute({ method: "POST", path: "/api/kiosk-delivery/twilio-status/job_123" }), true);
    assert.equal(isPublicRoute({ method: "GET", path: "/api/kiosk-delivery/twilio-status/job_123" }), false);
    const token = "test_auth_token";
    const updates = [];
    const app = express();
    app.use("/api/kiosk-delivery", createKioskDeliveryStatusRouter({
        validate: createTwilioWebhookValidator({ getAuthToken: () => token, allowSkip: false }),
        update: async (...args) => { updates.push(args); return true; },
    }));
    const server = await new Promise((resolve, reject) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
        listening.on("error", reject);
    });
    try {
        const url = `http://127.0.0.1:${server.address().port}/api/kiosk-delivery/twilio-status/job_123?e=Event`;
        const params = { MessageSid: "SM123", MessageStatus: "delivered", ErrorCode: "" };
        const body = new URLSearchParams(params);
        const invalid = await fetch(url, { method: "POST", body, headers: { "x-twilio-signature": "invalid" } });
        assert.equal(invalid.status, 403);
        assert.equal(updates.length, 0);

        const signature = twilio.getExpectedTwilioSignature(token, url, params);
        const valid = await fetch(url, { method: "POST", body: new URLSearchParams(params),
            headers: { "x-twilio-signature": signature } });
        assert.equal(valid.status, 204);
        assert.deepEqual(updates[0], ["job_123", "Event", {
            providerId: "SM123", status: "delivered", errorCode: null,
        }]);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { isConfigured, sendKioskEmail } = require("../lib/kiosk-email");

test("SendGrid kiosk email is offered only with a key and sender", () => {
    assert.equal(isConfigured({ SENDGRID_API_KEY: "SG.example", SENDGRID_FROM_EMAIL: "booth@example.com" }), true);
    assert.equal(isConfigured({ SENDGRID_API_KEY: "SG.example" }), false);
    assert.equal(isConfigured({ SENDGRID_FROM_EMAIL: "booth@example.com" }), false);
});

test("SendGrid receives the finished portrait as an attachment", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-email-"));
    const imagePath = path.join(dir, "portrait.jpg");
    const image = Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2, 3]);
    fs.writeFileSync(imagePath, image);
    let request;
    try {
        const result = await sendKioskEmail({
            kioskSubmission: true,
            kioskEmail: "guest@example.com",
            eventName: "Autumn Event",
            locale: "en",
            filePrefix: "kiosk-123",
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }, { imagePath, shareUrl: "https://booth.example/s/kiosk-123?e=Autumn" }, {
            env: { SENDGRID_API_KEY: "SG.example", SENDGRID_FROM_EMAIL: "booth@example.com" },
            fetchImpl: async (url, options) => {
                request = { url, ...options };
                return { status: 202, headers: { get: (name) => name === "x-message-id" ? "sg-123" : null } };
            },
        });
        assert.equal(result.status, "accepted");
        assert.equal(result.providerId, "sg-123");
        assert.equal(request.url, "https://api.sendgrid.com/v3/mail/send");
        assert.equal(request.headers.Authorization, "Bearer SG.example");
        const payload = JSON.parse(request.body);
        assert.equal(payload.personalizations[0].to[0].email, "guest@example.com");
        assert.equal(payload.from.email, "booth@example.com");
        assert.equal(payload.attachments[0].content, image.toString("base64"));
        assert.equal(payload.attachments[0].type, "image/jpeg");
        assert.deepEqual(payload.personalizations[0].custom_args, {
            kiosk_request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            kiosk_file_prefix: "kiosk-123",
        });
        assert.match(payload.content[0].value, /https:\/\/booth\.example\/s\/kiosk-123/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("SendGrid rejects definitive errors and leaves ambiguous results for review", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-email-"));
    const imagePath = path.join(dir, "portrait.jpg");
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0]));
    try {
        await assert.rejects(sendKioskEmail({ kioskEmail: "guest@example.com", eventName: "Event" }, { imagePath }, {
            env: { SENDGRID_API_KEY: "SG.secret", SENDGRID_FROM_EMAIL: "booth@example.com" },
            fetchImpl: async () => ({ status: 429, headers: { get: () => null } }),
        }), (err) => err.status === 429 && err.retryable === true && !err.message.includes("SG.secret"));
        await assert.rejects(sendKioskEmail({ kioskEmail: "guest@example.com", eventName: "Event" }, { imagePath }, {
            env: { SENDGRID_API_KEY: "SG.secret", SENDGRID_FROM_EMAIL: "booth@example.com" },
            fetchImpl: async () => ({ status: 403, headers: { get: () => null } }),
        }), (err) => err.status === 403 && err.retryable === false);
        await assert.rejects(sendKioskEmail({ kioskEmail: "guest@example.com", eventName: "Event" }, { imagePath }, {
            env: { SENDGRID_API_KEY: "SG.secret", SENDGRID_FROM_EMAIL: "booth@example.com" },
            fetchImpl: async () => ({ status: 503, headers: { get: () => null } }),
        }), (err) => err.status === 503 && err.uncertain === true && err.retryable === false);
        await assert.rejects(sendKioskEmail({ kioskEmail: "guest@example.com", eventName: "Event" }, { imagePath }, {
            env: { SENDGRID_API_KEY: "SG.secret", SENDGRID_FROM_EMAIL: "booth@example.com" },
            fetchImpl: async () => { throw new Error("connection lost"); },
        }), (err) => err.uncertain === true && err.retryable === false && !err.message.includes("SG.secret"));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

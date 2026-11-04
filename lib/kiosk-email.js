// Transactional portrait delivery through SendGrid Mail Send v3.
// Credentials stay in the process environment and never enter browser settings.

const fsp = require("node:fs/promises");
const path = require("node:path");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function isConfigured(env = process.env) {
    const replyTo = String(env.SENDGRID_REPLY_TO_EMAIL || "");
    return Boolean(env.SENDGRID_API_KEY
        && EMAIL_RE.test(String(env.SENDGRID_FROM_EMAIL || ""))
        && (!replyTo || EMAIL_RE.test(replyTo)));
}

function mailEndpoint(env) {
    return env.SENDGRID_REGION === "eu"
        ? "https://api.eu.sendgrid.com/v3/mail/send"
        : "https://api.sendgrid.com/v3/mail/send";
}

function emailText(job, shareUrl) {
    const event = String(job.eventName || "the event").replace(/[\r\n]/g, " ").slice(0, 100);
    const portuguese = job.locale === "pt_BR";
    const intro = portuguese
        ? `Seu retrato de ${event} está pronto. A imagem está anexada a este e-mail.`
        : `Your portrait from ${event} is ready. The image is attached to this email.`;
    const link = /^https:\/\//i.test(String(shareUrl || ""))
        ? (portuguese ? `\n\nVeja e compartilhe: ${shareUrl}` : `\n\nView and share: ${shareUrl}`)
        : "";
    return { event, portuguese, body: intro + link };
}

async function sendKioskEmail(job, { imagePath, shareUrl } = {}, {
    env = process.env,
    fetchImpl = globalThis.fetch,
} = {}) {
    if (!isConfigured(env)) {
        const error = new Error("SendGrid kiosk email is not configured");
        error.retryable = false;
        throw error;
    }
    const recipient = String(job.kioskEmail || "").trim();
    if (!EMAIL_RE.test(recipient)) {
        const error = new Error("Kiosk email recipient is invalid");
        error.retryable = false;
        throw error;
    }
    if (!imagePath) {
        const error = new Error("Finished portrait is missing");
        error.retryable = true;
        throw error;
    }
    const image = await fsp.readFile(imagePath);
    if (!image.length || image.length > MAX_ATTACHMENT_BYTES) {
        const error = new Error("Finished portrait exceeds SendGrid attachment limit");
        error.retryable = false;
        throw error;
    }
    const extension = path.extname(imagePath).toLowerCase();
    const mime = extension === ".png" ? "image/png" : "image/jpeg";
    const { event, portuguese, body } = emailText(job, shareUrl);
    const payload = {
        personalizations: [{ to: [{ email: recipient }] }],
        from: {
            email: env.SENDGRID_FROM_EMAIL,
            ...(env.SENDGRID_FROM_NAME ? { name: env.SENDGRID_FROM_NAME } : {}),
        },
        ...(env.SENDGRID_REPLY_TO_EMAIL ? { reply_to: { email: env.SENDGRID_REPLY_TO_EMAIL } } : {}),
        subject: portuguese ? `Seu retrato de ${event}` : `Your portrait from ${event}`,
        content: [{ type: "text/plain", value: body }],
        attachments: [{
            content: image.toString("base64"),
            type: mime,
            filename: `portrait${extension === ".png" ? ".png" : ".jpg"}`,
            disposition: "attachment",
        }],
    };
    if (/^[a-f0-9-]{36}$/i.test(String(job.requestId || ""))
        && /^[A-Za-z0-9_-]+$/.test(String(job.filePrefix || ""))) {
        // SendGrid returns these non-PII values in signed Event Webhooks so a
        // later bounce or delivery can update the exact kiosk job.
        payload.personalizations[0].custom_args = {
            kiosk_request_id: job.requestId,
            kiosk_file_prefix: job.filePrefix,
        };
    }

    let response;
    try {
        response = await fetchImpl(mailEndpoint(env), {
            method: "POST",
            headers: {
                Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(20_000),
        });
    } catch {
        // The request may have reached SendGrid even when the response was
        // lost. Retrying automatically could send a second portrait.
        const error = new Error("SendGrid result is unknown after a network error");
        error.uncertain = true;
        error.retryable = false;
        throw error;
    }
    if (response.status !== 202) {
        const error = new Error(`SendGrid rejected kiosk email (HTTP ${response.status})`);
        error.status = response.status;
        error.uncertain = response.status >= 500;
        error.retryable = response.status === 429;
        throw error;
    }
    return { status: "accepted", providerId: response.headers.get("x-message-id") || null };
}

module.exports = { isConfigured, sendKioskEmail };

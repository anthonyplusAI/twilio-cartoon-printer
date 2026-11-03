const express = require("express");
const { createTwilioWebhookValidator } = require("./twilio-webhook");
const { updateKioskDeliveryFromProvider } = require("./queue");

function createKioskDeliveryStatusRouter({
    validate = createTwilioWebhookValidator({ allowSkip: false }),
    update = updateKioskDeliveryFromProvider,
} = {}) {
    const router = express.Router();
    router.post("/twilio-status/:prefix", express.urlencoded({ extended: false, limit: "32kb" }), validate, async (req, res) => {
        const prefix = req.params.prefix;
        const eventName = req.query.e;
        const providerId = req.body.MessageSid || req.body.SmsSid;
        const status = req.body.MessageStatus || req.body.SmsStatus;
        if (!/^[A-Za-z0-9_-]+$/.test(prefix || "") || typeof eventName !== "string"
            || !eventName || eventName.length > 128 || typeof providerId !== "string"
            || typeof status !== "string") {
            return res.sendStatus(400);
        }
        try {
            const updated = await update(prefix, eventName, {
                providerId,
                status,
                errorCode: req.body.ErrorCode || null,
            });
            return res.sendStatus(updated ? 204 : 404);
        } catch (error) {
            console.error(`⚠️  Kiosk delivery callback failed: ${error.message}`);
            return res.sendStatus(500);
        }
    });
    return router;
}

function mountKioskDeliveryStatus(app) {
    app.use("/api/kiosk-delivery", createKioskDeliveryStatusRouter());
}

module.exports = { createKioskDeliveryStatusRouter, mountKioskDeliveryStatus };

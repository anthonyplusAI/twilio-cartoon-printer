const express = require("express");
const settings = require("./settings");
const { STYLES, STYLE_LIST } = require("./styles");
const audit = require("./audit");
const { authenticateAdminSession } = require("./auth");
const { buildMobileSettingsHtml } = require("./review-settings-page");

// Review staff can edit only fields built by review-settings-page.js. The PIN
// is a separate write-only exception below. Adding a setting elsewhere must
// never grant Review users access to read or change it by default.
const REVIEW_PAGE_WRITE_KEYS = new Set([
    "reviewMode", "variantsPerReview", "regenerationLimit",
    "maxPrints", "languageMode", "queuePaused", "maxConcurrentGeneration",
    "defaultStyle", "multiSubjectMode", "disabledStyles", "stylePromptOverrides", "customStyles",
    "enableBrandMenu", "offerUnbranded", "disabledBrands", "brandPromptOverrides",
    "enableBackgroundMenu", "promptBackground", "backgroundChoices",
    "enablePrinting", "boothDisplayMode", "boothHeadline", "boothSubline",
    "leadCaptureMode", "enablePromoMessage", "promoMessage", "enableNps",
    "promptUserDirective", "promptPreserve", "promptComposition",
    "promptPreserveBrand", "promptBrandInstruction", "brandPrompt", "messages",
]);
const RESPONSE_KEYS = ["eventName", ...REVIEW_PAGE_WRITE_KEYS];

function sanitizeSettings(obj) {
    const clean = { hasReviewPin: !!obj.reviewPin };
    for (const key of RESPONSE_KEYS) {
        if (Object.hasOwn(obj, key)) clean[key] = obj[key];
    }
    return clean;
}

function browserReviewSettings() {
    const all = settings.getAll();
    // Event profiles can contain only customized message keys. Keep the
    // default messages visible after both a load and a save.
    all.messages = { ...settings.DEFAULTS.messages, ...(all.messages || {}) };
    return sanitizeSettings(all);
}

function sanitizePayload(body) {
    const clean = {};
    for (const key of REVIEW_PAGE_WRITE_KEYS) {
        if (Object.hasOwn(body, key)) clean[key] = body[key];
    }
    if (typeof body.reviewPin === "string" && body.reviewPin.trim()) {
        clean.reviewPin = body.reviewPin.trim();
    }
    return settings.sanitizeTemplateReferenceChanges(clean);
}

// ── Routes ─────────────────────────────────────────────────────────────────

function mountReviewSettings(router, requireReviewAuth) {

    // Mobile settings page
    router.get("/settings", requireReviewAuth, (req, res) => {
        res.type("html").send(buildMobileSettingsHtml({ adminNav: Boolean(authenticateAdminSession(req)) }));
    });

    // Get sanitized settings
    router.get("/api/settings", requireReviewAuth, (_req, res) => {
        res.json(browserReviewSettings());
    });

    // Save settings (with audit + auto-approve side effect)
    router.post("/api/settings", requireReviewAuth, express.json(), async (req, res) => {
        try {
            const body = req.body;
            if (!body || typeof body !== "object" || Array.isArray(body)) {
                return res.status(400).json({ error: "Settings must be an object" });
            }
            // Guard: reject if active event changed since mobile loaded settings
            const targetEvent = body._forEvent;
            if (targetEvent && targetEvent !== settings.get("eventName")) {
                return res.status(409).json({
                    error: "Event changed",
                    currentEvent: settings.get("eventName"),
                });
            }

            if (Object.hasOwn(body, "reviewPin")) {
                const replacement = body.reviewPin;
                if (typeof replacement !== "string" || (replacement.trim() && !/^\d{4,6}$/.test(replacement.trim()))) {
                    return res.status(400).json({ error: "Review PIN must be 4–6 digits" });
                }
            }

            settings.refreshTemplateStateFromDisk();
            const changes = sanitizePayload(body);
            if (Object.keys(changes).length === 0) {
                return res.json(browserReviewSettings());
            }

            // Capture before values for audit
            const beforeValues = {};
            for (const key of Object.keys(changes)) {
                const current = settings.get(key);
                if (current !== undefined) beforeValues[key] = current;
            }

            settings.update(changes);

            // Audit logging
            const afterValues = {};
            let hasChanges = false;
            for (const key of Object.keys(beforeValues)) {
                const newVal = settings.get(key);
                if (JSON.stringify(newVal) !== JSON.stringify(beforeValues[key])) {
                    afterValues[key] = newVal;
                    hasChanges = true;
                }
            }
            if (hasChanges) {
                const changedBefore = {};
                for (const key of Object.keys(afterValues)) changedBefore[key] = beforeValues[key];
                audit.logSettingsChange("review-pin", settings.get("eventName"), changedBefore, afterValues).catch(err => {
                    console.error("📝 Audit log error:", err.message);
                });
            }

            // Review mode toggle only affects NEW items going forward.
            // Pending items already in review stay there until a human
            // explicitly approves or rejects them. See matching note in
            // lib/dashboard.js /api/settings.

            res.json(browserReviewSettings());
        } catch (err) {
            console.error("❌ Review settings save error:", err);
            res.status(500).json({ error: "Failed to save settings" });
        }
    });

    // Explicit removal is separate from ordinary saves, where an empty PIN
    // means "keep the current PIN". Existing review authorization applies.
    router.post("/api/settings/review-pin/remove", requireReviewAuth, express.json(), async (req, res) => {
        try {
            const targetEvent = req.body?._forEvent;
            if (targetEvent && targetEvent !== settings.get("eventName")) {
                return res.status(409).json({
                    error: "Event changed",
                    currentEvent: settings.get("eventName"),
                });
            }

            if (settings.get("reviewPin")) {
                settings.update({ reviewPin: "" });
                audit.logSettingsChange(
                    "review-pin",
                    settings.get("eventName"),
                    { reviewPin: true },
                    { reviewPin: false },
                ).catch(err => {
                    console.error("📝 Audit log error:", err.message);
                });
            }
            res.json({ hasReviewPin: false });
        } catch (err) {
            console.error("❌ Review PIN removal error:", err);
            res.status(500).json({ error: "Failed to remove Review PIN" });
        }
    });

    // Available files for dropdowns
    router.get("/api/settings/files", requireReviewAuth, async (_req, res) => {
        // Return ALL styles (built-in + custom), not just active ones,
        // so disabled styles still appear in toggles and can be re-enabled.
        const styles = STYLE_LIST.map(key => ({ key, name: STYLES[key].name || key }));
        const customStyles = settings.get("customStyles") || {};
        for (const [key, val] of Object.entries(customStyles)) {
            styles.push({ key, name: val.name || key });
        }
        const customBrands = settings.get("customBrands") || {};
        const brands = Object.entries(customBrands).map(([key, val]) => ({ key, name: val.name || key }));
        res.json({
            templates: await settings.listTemplates(),
            videos: settings.listVideos(),
            events: settings.listEvents(),
            styles,
            brands,
        });
    });
}

module.exports = { mountReviewSettings, buildMobileSettingsHtml };

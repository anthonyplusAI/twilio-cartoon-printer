const express = require("express");
const fsp = require("fs").promises;
const path = require("path");
const sharp = require("sharp");
const settings = require("./settings");
const { parseReviewPageRequest, paginateReviewQueue } = require("./review-pagination");
const {
    authenticateAdminSession,
    clearPinFailures,
    hasAdminAuth,
    makeReviewToken,
    parseCookie,
    pinFailureState,
    recordPinFailure,
    PIN_FAILURE_LIMIT,
    REVIEW_TOKEN_TTL,
} = require("./auth");
const { authenticateReviewPin, authenticateReviewRequest, getReviewCredentials } = require("./review-auth");
const { getReviewQueue, approveJob, rejectJob, pickVariant, regenerateVariant, rejectParent } = require("./queue");
const { mountReviewSettings } = require("./review-settings");

const router = express.Router();
const reviewThumbCache = new Map();
const REVIEW_THUMB_CACHE_MAX = 200;
const REVIEW_THUMB_CACHE_TTL = 60_000;

// ── Middleware: require valid review token or admin session ──────────────────

function requireReviewAuth(req, res, next) {
    const token = parseCookie(req, "review_token");
    if (authenticateReviewRequest(req)) return next();

    // For API calls, return 401; for pages, redirect to PIN entry
    if (req.path.startsWith("/api/")) {
        return res.status(401).json({ error: "Review session expired" });
    }
    // Only show "expired" if they had a token that failed validation (not first-time visitors)
    return res.redirect(token ? "/review?reason=expired" : "/review");
}

// ── PIN entry page ──────────────────────────────────────────────────────────

function reviewLandingPath() {
    const mode = settings.get("reviewMode") || (settings.get("enableManualReview") ? "human" : "off");
    return mode === "human" ? "/review/queue" : "/review/settings";
}

function hasReviewLoginCredential() {
    return Boolean(getReviewCredentials().reviewPin);
}

function adminLoginLink() {
    if (!hasAdminAuth()) return "";
    return `<a class="admin-login" href="/auth/login?next=${encodeURIComponent(reviewLandingPath())}">Admin login</a>`;
}

function renderPinPage(res, errorMsg = "", status = 200) {
    const errorHtml = errorMsg ? `<div class="error">${errorMsg}</div>` : "";
    const html = PIN_PAGE_HTML
        .replace("{{ERROR}}", errorHtml)
        .replace("{{ADMIN_LOGIN}}", adminLoginLink());
    res.setHeader("Cache-Control", "no-store");
    return res.status(status).type("html").send(html);
}

router.get("/", (req, res) => {
    // If already authed, go straight to the appropriate page
    if (authenticateReviewRequest(req)) {
        return res.redirect(reviewLandingPath());
    }

    if (!hasReviewLoginCredential()) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(403).type("html").send(PIN_DISABLED_HTML.replace("{{ADMIN_LOGIN}}", adminLoginLink()));
    }

    let errorMsg = "";
    if (req.query.error) errorMsg = "Incorrect PIN — please try again";
    else if (req.query.reason === "expired") errorMsg = "Your session expired — please enter the PIN again";

    return renderPinPage(res, errorMsg);
});

router.post("/auth", express.urlencoded({ extended: false, limit: "1kb" }), (req, res) => {
    if (!hasReviewLoginCredential()) return res.status(403).send("Review access PIN not configured");

    const state = pinFailureState(req, "review");
    if (state.count >= PIN_FAILURE_LIMIT) {
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil((state.resetAt - state.now) / 1000))));
        return renderPinPage(res, "Too many failed attempts. Try again later.", 429);
    }

    const credential = authenticateReviewPin(req.body.pin);
    if (!credential) {
        recordPinFailure(state);
        return res.redirect("/review?error=1");
    }

    clearPinFailures(state);
    const token = makeReviewToken(credential);
    const isSecure = (req.headers["x-forwarded-proto"] || req.protocol) === "https";
    const parts = [`review_token=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${REVIEW_TOKEN_TTL}`];
    if (isSecure) parts.push("Secure");
    res.append("Set-Cookie", parts.join("; "));
    const legacyParts = ["review_token=", "HttpOnly", "SameSite=Lax", "Path=/review", "Max-Age=0"];
    if (isSecure) legacyParts.push("Secure");
    res.append("Set-Cookie", legacyParts.join("; "));
    res.redirect(reviewLandingPath());
});

// ── Review queue page ───────────────────────────────────────────────────────

router.get("/queue", requireReviewAuth, (req, res) => {
    const reviewMode = settings.get("reviewMode") || (settings.get("enableManualReview") ? "human" : "off");
    if (reviewMode !== "human") {
        return res.redirect("/review/settings");
    }
    res.setHeader("Content-Type", "text/html");
    res.send(buildReviewQueueHtml({ adminNav: Boolean(authenticateAdminSession(req)) }));
});

// ── Review API ──────────────────────────────────────────────────────────────

router.get("/api/queue", requireReviewAuth, async (req, res) => {
    let page;
    try { page = parseReviewPageRequest(req.query); }
    catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
    if (req.query.e !== undefined && typeof req.query.e !== "string") {
        return res.status(400).json({ error: "Invalid event filter" });
    }
    const eventFilter = req.query.e || settings.get("eventName") || "all";
    const jobs = await getReviewQueue(eventFilter);
    res.json(page ? paginateReviewQueue(jobs, page) : jobs);
});

router.get("/api/events", requireReviewAuth, (_req, res) => {
    const currentEvent = settings.get("eventName") || "";
    const events = new Set(settings.listEvents());
    if (currentEvent) events.add(currentEvent);
    res.json({ events: [...events].sort(), currentEvent });
});

function isSafeReviewMediaSegment(value) {
    if (typeof value !== "string" || !value) return false;
    let candidate = value;
    for (let depth = 0; depth < 5; depth++) {
        if (candidate.startsWith(".") || candidate.includes("/") || candidate.includes("\\")
            || /[\x00-\x1f\x7f]/.test(candidate)) return false;
        if (!candidate.includes("%")) return true;
        try {
            const decoded = decodeURIComponent(candidate);
            if (decoded === candidate) return true;
            candidate = decoded;
        } catch { return false; }
    }
    return false;
}

router.get("/api/thumbnail/:event/:file", requireReviewAuth, async (req, res) => {
    const { event, file } = req.params;
    if (!isSafeReviewMediaSegment(event) || !isSafeReviewMediaSegment(file)
        || !(/_output\.png$|_input\.jpg$/).test(file)) return res.sendStatus(400);
    const isSelfie = file.endsWith("_input.jpg");
    const imagePath = path.join(__dirname, "..", "downloads", event, ".staging", file);
    res.setHeader("Cache-Control", isSelfie ? "private, no-store" : "private, max-age=0, must-revalidate");
    try {
        const render = () => sharp(imagePath).rotate()
            .resize(480, 480, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 76, effort: 3 }).toBuffer();
        let buffer;
        if (isSelfie) {
            buffer = await render();
        } else {
            const stat = await fsp.stat(imagePath);
            const key = `${imagePath}:${stat.size}:${stat.mtimeMs}`;
            const cached = reviewThumbCache.get(key);
            if (cached && Date.now() - cached.ts < REVIEW_THUMB_CACHE_TTL) {
                reviewThumbCache.delete(key);
                reviewThumbCache.set(key, cached);
                buffer = await cached.promise;
            } else {
                const promise = render();
                reviewThumbCache.delete(key);
                if (reviewThumbCache.size >= REVIEW_THUMB_CACHE_MAX) reviewThumbCache.delete(reviewThumbCache.keys().next().value);
                reviewThumbCache.set(key, { promise, ts: Date.now() });
                promise.catch(() => {
                    if (reviewThumbCache.get(key)?.promise === promise) reviewThumbCache.delete(key);
                });
                buffer = await promise;
            }
        }
        res.type("image/webp").send(buffer);
    } catch {
        if (!res.headersSent) res.sendStatus(404);
    }
});

router.post("/api/job", requireReviewAuth, express.json(), async (req, res) => {
    const body = req.body || {};
    const filename = path.basename(body.filename || "");
    const parentJobId = body.parentJobId ? String(body.parentJobId) : "";
    const action = body.action;
    const notify = !!body.notify;
    const reanalyze = !!body.reanalyze;
    if (!(filename || parentJobId) || !["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "filename or parentJobId required, action must be approve|reject" });
    }
    try {
        // Parent-level action (multi-variant card)
        if (parentJobId) {
            if (action === "approve") {
                return res.status(400).json({ error: "Approve at parent level is not supported — pick a specific variant" });
            }
            const message = notify ? settings.getMsg("reviewReject") : null;
            const feedback = body.feedback || "";
            await rejectParent(parentJobId, message, reanalyze, feedback);
            return res.json({ ok: true });
        }

        // Legacy single-variant path
        if (action === "approve") {
            await approveJob(filename);
        } else {
            const message = notify ? settings.getMsg("reviewReject") : null;
            const feedback = body.feedback || "";
            await rejectJob(filename, message, reanalyze, feedback);
        }
        res.json({ ok: true });
    } catch (err) {
        if (err.code === "ALREADY_DECIDED") return res.status(409).json({ error: err.message, code: err.code });
        res.status(500).json({ error: err.message });
    }
});

// ── Multi-variant endpoints ────────────────────────────────────────────────

router.post("/api/variant/pick", requireReviewAuth, express.json(), async (req, res) => {
    const body = req.body || {};
    const parentJobId = body.parentJobId ? String(body.parentJobId) : "";
    const variantId = body.variantId ? String(body.variantId) : "";
    if (!parentJobId || !variantId) {
        return res.status(400).json({ error: "parentJobId and variantId required" });
    }
    try {
        await pickVariant(parentJobId, variantId);
        res.json({ ok: true });
    } catch (err) {
        if (err.code === "ALREADY_DECIDED") return res.status(409).json({ error: err.message, code: err.code });
        if (err.code === "VARIANT_NOT_FOUND") return res.status(404).json({ error: err.message, code: err.code });
        if (err.code === "VARIANT_FAILED") return res.status(400).json({ error: err.message, code: err.code });
        res.status(500).json({ error: err.message });
    }
});

router.post("/api/variant/regenerate", requireReviewAuth, express.json(), async (req, res) => {
    const body = req.body || {};
    const parentJobId = body.parentJobId ? String(body.parentJobId) : "";
    const variantId = body.variantId ? String(body.variantId) : "";
    if (!parentJobId || !variantId) {
        return res.status(400).json({ error: "parentJobId and variantId required" });
    }
    try {
        await regenerateVariant(parentJobId, variantId);
        res.json({ ok: true });
    } catch (err) {
        if (err.code === "VARIANT_NOT_FOUND") return res.status(404).json({ error: err.message, code: err.code });
        if (err.code === "REGEN_LIMIT_REACHED") return res.status(429).json({ error: err.message, code: err.code });
        res.status(500).json({ error: err.message });
    }
});

router.post("/api/bulk", requireReviewAuth, express.json(), async (req, res) => {
    const filenames = Array.isArray((req.body || {}).filenames) ? req.body.filenames : [];
    const action = (req.body || {}).action;
    if (!filenames.length || !["approve", "reject"].includes(action)) {
        return res.status(400).json({ error: "filenames array and action (approve|reject) required" });
    }
    const results = [];
    for (const raw of filenames) {
        const filename = path.basename(raw || "");
        if (!filename) { results.push({ filename: raw, ok: false, error: "invalid" }); continue; }
        try {
            if (action === "approve") {
                await approveJob(filename);
            } else {
                await rejectJob(filename, null, false);
            }
            results.push({ filename, ok: true });
        } catch (err) {
            results.push({ filename, ok: false, error: err.message });
        }
    }
    res.json({ ok: true, results });
});

// ── HTML Templates ──────────────────────────────────────────────────────────

const PIN_DISABLED_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<link rel="stylesheet" href="/assets/tw-modal.css">
<script src="/assets/tw-modal.js"></script>
<title>Review — Twilio Photobooth</title>
<style>
  body { background: var(--th-bg); color: var(--th-text-dim); min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Twilio Sans Text', -apple-system, system-ui, sans-serif; }
  .msg { text-align: center; max-width: 380px; padding: 40px; }
  .msg h1 { font-family: 'Twilio Sans Display', sans-serif; font-size: 22px; color: var(--th-text); margin-bottom: 12px; }
  .msg p { font-size: 14px; color: var(--th-text-muted); }
  .admin-login { display: inline-block; margin-top: 20px; color: var(--blue-300); font-size: 14px; }
</style>
</head>
<body>
<div class="msg">
  <h1>Review Not Available</h1>
  <p>A Review PIN has not been configured. An administrator can sign in or configure one in Review Settings.</p>
  {{ADMIN_LOGIN}}
</div>
</body></html>`;

const PIN_PAGE_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<link rel="stylesheet" href="/assets/tw-modal.css">
<script src="/assets/tw-modal.js"></script>
<title>Review Login — Twilio Photobooth</title>
<style>
  body { background: var(--th-bg); color: var(--th-text-dim); min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Twilio Sans Text', -apple-system, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased; position: relative; overflow: hidden; }
  body::before {
    content: ''; position: fixed; top: -40%; left: -20%; width: 140%; height: 140%;
    background: radial-gradient(ellipse at 30% 20%, rgba(239,34,58,0.12) 0%, transparent 55%),
                radial-gradient(ellipse at 70% 80%, rgba(33,136,239,0.06) 0%, transparent 50%);
    pointer-events: none; z-index: 0;
  }
  .login-wrapper { text-align: center; max-width: 400px; width: 92%; position: relative; z-index: 1; }
  .card {
    position: relative; background: var(--th-card); border: 1px solid var(--th-card-border);
    border-radius: 16px; padding: 48px 40px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.3); overflow: hidden;
  }
  .card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, var(--brand-red) 0%, #F83D53 40%, #2188EF 100%);
  }
  .card .app-name {
    font-family: 'Twilio Sans Mono', monospace; font-size: 11px;
    text-transform: uppercase; letter-spacing: 1px;
    color: var(--brand-red); font-weight: 400; margin-bottom: 6px;
  }
  .card h1 { font-family: 'Twilio Sans Display', sans-serif; font-size: 24px;
    font-weight: 800; color: var(--th-text); margin-bottom: 6px; }
  .card .subtitle { font-size: 13px; color: var(--th-text-muted); margin-bottom: 28px; }
  .error {
    background: rgba(239,34,58,.1); border: 1px solid rgba(239,34,58,.3);
    color: var(--brand-red); border-radius: 8px; padding: 10px 14px;
    font-size: 13px; margin-bottom: 20px;
  }
  .pin-input {
    width: 100%; padding: 14px 16px; font-size: 24px; text-align: center;
    letter-spacing: 12px; font-family: 'Twilio Sans Mono', monospace;
    background: var(--th-bg); border: 1px solid var(--th-card-border); border-radius: 10px;
    color: var(--th-text); outline: none; transition: border-color .2s;
  }
  .pin-input:focus { border-color: var(--blue-400); }
  .pin-input::placeholder { letter-spacing: 4px; font-size: 14px; color: var(--th-text-muted); }
  .btn-submit {
    margin-top: 20px; width: 100%; padding: 14px; border: none; border-radius: 10px;
    background: var(--brand-red); color: #fff; font-size: 14px; font-weight: 700;
    font-family: 'Twilio Sans Text', sans-serif; cursor: pointer;
    transition: background .2s, transform .1s;
  }
  .btn-submit:hover { background: var(--brand-red-hover, #DB132A); }
  .btn-submit:active { transform: translateY(1px); }
  .admin-login { display: inline-block; margin-top: 20px; color: var(--blue-300); font-size: 13px; }
</style>
</head>
<body>
<div class="login-wrapper">
  <div class="card">
    <div class="app-name">AI Photobooth</div>
    <h1>Staff Access</h1>
    <p class="subtitle">Enter the PIN to continue</p>
    {{ERROR}}
    <form method="POST" action="/review/auth">
      <input class="pin-input" type="password" name="pin" maxlength="6" inputmode="numeric" pattern="[0-9]*" placeholder="PIN" autofocus autocomplete="off">
      <button class="btn-submit" type="submit">Enter</button>
    </form>
    {{ADMIN_LOGIN}}
  </div>
</div>
</body></html>`;

const { buildReviewQueueHtml } = require("./review-queue-page");

// ── Mount helper ────────────────────────────────────────────────────────────

function mountReview(app) {
    mountReviewSettings(router, requireReviewAuth);
    app.use("/review", router);
}

module.exports = { mountReview, buildReviewQueueHtml };

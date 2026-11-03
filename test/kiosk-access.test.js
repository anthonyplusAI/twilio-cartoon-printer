const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const sharp = require("sharp");

const TEST_SESSION_SECRET = "kiosk-access-test-session-secret-32-characters";
const TEST_ADMIN_PIN = "Kiosk9876";
process.env.SESSION_SECRET = TEST_SESSION_SECRET;
process.env.ADMIN_PIN = TEST_ADMIN_PIN;

const settings = require("../lib/settings");
const {
    mountAuth,
    requireAuth,
    isPublicRoute,
    makeKioskSessionToken,
    verifyKioskSessionToken,
    authenticateAdminSession,
} = require("../lib/auth");
const { mountKiosk } = require("../lib/kiosk");
const { mountApiGenerate } = require("../lib/api-generate");

function signedKioskToken(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto.createHmac("sha256", TEST_SESSION_SECRET)
        .update(`kiosk:${encoded}`).digest("base64url");
    return `${encoded}.${signature}`;
}

function cookieFrom(response, name) {
    const cookies = response.headers.getSetCookie?.() || [response.headers.get("set-cookie") || ""];
    const line = cookies.find((value) => value.startsWith(`${name}=`));
    assert.ok(line, `expected ${name} Set-Cookie header`);
    return line.split(";", 1)[0];
}

async function postImage(baseUrl, image, cookie, fields) {
    const body = new FormData();
    body.append("image", new Blob([image], { type: "image/jpeg" }), "selfie.jpg");
    for (const [key, value] of Object.entries(fields)) body.append(key, value);
    return fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        body,
        headers: cookie ? { Cookie: cookie } : {},
    });
}

test("kiosk session tokens are purpose-bound and reject expiry or tampering", () => {
    assert.equal(isPublicRoute({ method: "POST", path: "/api/kiosk-delivery/sendgrid-events" }), true);
    assert.equal(isPublicRoute({ method: "GET", path: "/api/kiosk-delivery/sendgrid-events" }), false);
    const token = makeKioskSessionToken("KioskAuthEvent");
    assert.deepEqual(verifyKioskSessionToken(token), { eventName: "KioskAuthEvent" });
    assert.equal(authenticateAdminSession({ headers: { cookie: `session=${token}` } }), null);

    const expired = signedKioskToken({
        purpose: "kiosk", eventName: "KioskAuthEvent", exp: Date.now() - 1,
    });
    assert.equal(verifyKioskSessionToken(expired), null);
    assert.equal(verifyKioskSessionToken(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`), null);
    assert.equal(verifyKioskSessionToken(signedKioskToken({
        purpose: "admin", eventName: "KioskAuthEvent", exp: Date.now() + 60_000,
    })), null);
});

test("admin launch exchanges cookies and kiosk access is limited to its active event", async () => {
    let activeEvent = "KioskAuthEvent";
    const originalSettings = {
        get: settings.get,
        getForEvent: settings.getForEvent,
        getActiveStyleList: settings.getActiveStyleList,
        getActiveStyles: settings.getActiveStyles,
    };
    settings.get = (key, ...args) => ({
        eventName: activeEvent,
        languageMode: "en",
        customBrands: {},
        disabledBrands: [],
        twilioPhoneNumber: "",
        twilioWhatsappNumber: "",
    })[key] ?? originalSettings.get.call(settings, key, ...args);
    settings.getForEvent = (key) => ({
        enableBrandMenu: false,
        offerUnbranded: true,
        enableBackgroundMenu: false,
        backgroundChoices: [],
        boothShowSms: false,
        boothShowWhatsapp: false,
        boothShowEmail: false,
    })[key] ?? originalSettings.getForEvent.call(settings, key, activeEvent);
    settings.getActiveStyleList = () => ["cartoon"];
    settings.getActiveStyles = () => ({ cartoon: { name: "Cartoon", prompt: "Cartoon portrait" } });

    let server;
    try {
        const app = express();
        app.set("trust proxy", 1);
        mountAuth(app);
        app.use((req, res, next) => isPublicRoute(req) ? next() : requireAuth(req, res, next));
        app.get("/home", (req, res) => res.status(200).send("admin home"));
        app.get("/api/admin", (req, res) => res.json({ admin: true }));
        mountKiosk(app);
        mountApiGenerate(app);
        server = await new Promise((resolve, reject) => {
            const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
            listening.on("error", reject);
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        const anonymousLaunch = await fetch(`${baseUrl}/kiosk/launch`, { redirect: "manual" });
        assert.equal(anonymousLaunch.status, 302);
        assert.match(anonymousLaunch.headers.get("location"), /^\/auth\/login\?/);

        const pinLogin = await fetch(`${baseUrl}/auth/pin`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ pin: TEST_ADMIN_PIN, next: "/home" }),
            redirect: "manual",
        });
        assert.equal(pinLogin.status, 302);
        const adminCookie = cookieFrom(pinLogin, "session");

        const adminKioskPage = await fetch(`${baseUrl}/kiosk`, {
            headers: { Cookie: adminCookie }, redirect: "manual",
        });
        assert.equal(adminKioskPage.status, 302);
        assert.equal(adminKioskPage.headers.get("location"), "/kiosk/launch");

        const launch = await fetch(`${baseUrl}/kiosk/launch`, {
            headers: { Cookie: adminCookie }, redirect: "manual",
        });
        assert.equal(launch.status, 302);
        assert.equal(launch.headers.get("location"), "/kiosk");
        const kioskCookie = cookieFrom(launch, "kiosk_session");
        const clearedAdminCookie = cookieFrom(launch, "session");
        assert.equal(clearedAdminCookie, "session=");
        assert.match(launch.headers.getSetCookie().find((line) => line.startsWith("session=")), /Max-Age=0/);
        assert.deepEqual(verifyKioskSessionToken(kioskCookie.slice("kiosk_session=".length)),
            { eventName: activeEvent });

        const page = await fetch(`${baseUrl}/kiosk`, { headers: { Cookie: kioskCookie } });
        assert.equal(page.status, 200);
        assert.match(await page.text(), /KioskAuthEvent/);
        const adminHome = await fetch(`${baseUrl}/home`, {
            headers: { Cookie: kioskCookie }, redirect: "manual",
        });
        assert.equal(adminHome.status, 302);
        assert.match(adminHome.headers.get("location"), /^\/auth\/login\?/);
        const adminApi = await fetch(`${baseUrl}/api/admin`, { headers: { Cookie: kioskCookie } });
        assert.equal(adminApi.status, 401);

        const image = await sharp({
            create: { width: 24, height: 24, channels: 3, background: "white" },
        }).jpeg().toBuffer();
        const nonKiosk = await fetch(`${baseUrl}/api/generate`, {
            method: "POST", body: image,
            headers: { Cookie: kioskCookie, "content-type": "image/jpeg" },
        });
        assert.equal(nonKiosk.status, 403);
        assert.equal((await nonKiosk.json()).code, "KIOSK_ONLY");

        const anonymous = await postImage(baseUrl, image, "", { kiosk: "1", event: activeEvent });
        assert.equal(anonymous.status, 401);
        assert.equal((await anonymous.json()).code, "KIOSK_SESSION_EXPIRED");

        const wrongEventField = await postImage(baseUrl, image, kioskCookie, {
            kiosk: "1", event: "DifferentEvent",
        });
        assert.equal(wrongEventField.status, 409);
        assert.equal((await wrongEventField.json()).code, "EVENT_CHANGED");

        activeEvent = "ChangedEvent";
        const stalePage = await fetch(`${baseUrl}/kiosk`, {
            headers: { Cookie: kioskCookie }, redirect: "manual",
        });
        assert.equal(stalePage.status, 409);
        const stalePost = await postImage(baseUrl, image, kioskCookie, {
            kiosk: "1", event: "KioskAuthEvent",
        });
        assert.equal(stalePost.status, 409);
        assert.equal((await stalePost.json()).code, "EVENT_CHANGED");

        const expiredCookie = `kiosk_session=${signedKioskToken({
            purpose: "kiosk", eventName: activeEvent, exp: Date.now() - 1,
        })}`;
        const expiredPost = await postImage(baseUrl, image, expiredCookie, {
            kiosk: "1", event: activeEvent,
        });
        assert.equal(expiredPost.status, 401);
        assert.equal((await expiredPost.json()).code, "KIOSK_SESSION_EXPIRED");
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        Object.assign(settings, originalSettings);
    }
});

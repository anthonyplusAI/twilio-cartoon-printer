const { test } = require("node:test");
const assert = require("node:assert/strict");
const QRCode = require("qrcode");
const { buildStaticPanelHtml } = require("../lib/home");

const QR_OPTIONS = { width: 480, margin: 1, color: { dark: "#000000", light: "#FFFFFF" } };

function panelSettings(overrides = {}) {
    const values = {
        eventName: "Developer Week 2026",
        boothHeadline: "Get Your AI Portrait",
        boothSubline: "",
        boothQrImage: "",
        boothSteps: ["Scan the QR code with your phone camera", "Send the pre-filled text message", "Take a selfie and reply with your photo"],
        boothLegalText: "",
        termsUrl: "",
        boothShowSms: true,
        boothSmsPhone: "+14155550100",
        boothSmsInstructionText: "Hit send to start",
        boothSmsQrSource: "auto",
        boothSmsQrImage: "",
        boothShowWhatsapp: true,
        boothWhatsappPhone: "+14155550200",
        boothWhatsappPrefillText: "Hi",
        boothWhatsappInstructionText: "Open WhatsApp to start",
        boothWhatsappQrSource: "auto",
        boothWhatsappQrImage: "",
        ...overrides,
    };
    return (key) => values[key];
}

function bodyMarkup(html) {
    return html.slice(html.indexOf("<body>"));
}

function qrSources(html) {
    return [...bodyMarkup(html).matchAll(/<div class="qr-wrap"><img src="([^"]+)"/g)]
        .map((match) => match[1]);
}

test("dual-channel static display QR opens the event channel selector", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings(),
    });
    const body = bodyMarkup(html);
    const expected = await QRCode.toDataURL("https://booth.example.com/start?event=Developer+Week+2026&lang=en", QR_OPTIONS);

    assert.equal(qrSources(html).length, 1);
    assert.equal(qrSources(html)[0] === expected, true, "QR encodes /start for this event and language");
    assert.match(body, /Scan to choose SMS or WhatsApp/);
    assert.doesNotMatch(body, /<div class="qr-two-up">/);
    assert.doesNotMatch(body, /local-preview-note|Open channel selector on this computer/);
});

test("single-channel static display QR opens the notice before SMS", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({ boothShowWhatsapp: false }),
    });
    const body = bodyMarkup(html);
    const expected = await QRCode.toDataURL("https://booth.example.com/start?event=Developer+Week+2026&lang=en", QR_OPTIONS);

    assert.equal(qrSources(html).length, 1);
    assert.equal(qrSources(html)[0] === expected, true, "QR opens the notice before SMS");
    assert.doesNotMatch(body, /Scan to choose SMS or WhatsApp|<div class="qr-two-up">/);
});

test("WhatsApp-only static display QR opens the notice before WhatsApp", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({ boothShowSms: false }),
    });
    const expected = await QRCode.toDataURL("https://booth.example.com/start?event=Developer+Week+2026&lang=en", QR_OPTIONS);

    assert.deepEqual(qrSources(html), [expected]);
});

test("auto QR does not bypass the notice when no public URL is configured", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "",
        locale: "en",
        getSetting: panelSettings({ boothShowWhatsapp: false }),
    });

    assert.equal(qrSources(html).length, 0);
    assert.match(bodyMarkup(html), /qr-placeholder/);
});

test("partly configured display still opens the notice before the usable channel", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({ boothWhatsappPhone: "" }),
    });
    const body = bodyMarkup(html);
    const expected = await QRCode.toDataURL("https://booth.example.com/start?event=Developer+Week+2026&lang=en", QR_OPTIONS);

    assert.equal(qrSources(html).length, 1);
    assert.equal(qrSources(html)[0] === expected, true);
    assert.doesNotMatch(body, /Scan to choose SMS or WhatsApp/);
    assert.doesNotMatch(body, /<div class="qr-two-up">/);
});

test("partly configured display opens the notice before WhatsApp", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({ boothSmsPhone: "", twilioPhoneNumber: "" }),
    });
    const expected = await QRCode.toDataURL("https://booth.example.com/start?event=Developer+Week+2026&lang=en", QR_OPTIONS);

    assert.deepEqual(qrSources(html), [expected]);
    assert.doesNotMatch(bodyMarkup(html), /Scan to choose SMS or WhatsApp|<div class="qr-two-up">/);
});

test("dual-channel display preserves an uploaded SMS QR when SMS uses only a Messaging Service", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({
            boothSmsPhone: "", twilioPhoneNumber: "",
            boothSmsQrSource: "auto", boothSmsQrImage: "sms.png",
        }),
    });
    const expectedWhatsapp = await QRCode.toDataURL("https://booth.example.com/start?event=Developer+Week+2026&lang=en", QR_OPTIONS);
    const body = bodyMarkup(html);

    assert.deepEqual(qrSources(html), ["/booth-uploads/sms.png", expectedWhatsapp]);
    assert.match(body, /<div class="qr-two-up">/);
    assert.doesNotMatch(body, /Scan to choose SMS or WhatsApp/);
});

test("dual-channel display falls back to a single uploaded SMS QR if neither channel has a number", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({
            boothSmsPhone: "", twilioPhoneNumber: "",
            boothWhatsappPhone: "", twilioWhatsappNumber: "",
            boothSmsQrSource: "upload", boothSmsQrImage: "sms.png",
        }),
    });

    assert.deepEqual(qrSources(html), ["/booth-uploads/sms.png"]);
    assert.doesNotMatch(bodyMarkup(html), /Scan to choose SMS or WhatsApp|<div class="qr-two-up">/);
});

test("dual-channel display preserves explicitly uploaded QRs", async () => {
    const html = await buildStaticPanelHtml("pt_BR", {
        baseUrl: "https://booth.example.com",
        locale: "pt_BR",
        getSetting: panelSettings({
            boothSmsQrSource: "upload", boothSmsQrImage: "sms.png",
            boothWhatsappQrSource: "upload", boothWhatsappQrImage: "whatsapp.png",
        }),
    });
    const body = bodyMarkup(html);

    assert.deepEqual(qrSources(html), ["/booth-uploads/sms.png", "/booth-uploads/whatsapp.png"]);
    assert.match(body, /<div class="qr-two-up">/);
    assert.match(body, /<div class="qr-channel-label">SMS · \(415\) 555-0100<\/div>/);
    assert.match(body, /<div class="qr-channel-label">WhatsApp · \+14155550200<\/div>/);
    assert.doesNotMatch(body, /Scan to choose SMS or WhatsApp/);
});

test("dual-channel display pairs uploaded SMS QR with WhatsApp start-page QR", async () => {
    const html = await buildStaticPanelHtml("pt_BR", {
        baseUrl: "https://booth.example.com",
        locale: "pt_BR",
        getSetting: panelSettings({ boothSmsQrSource: "upload", boothSmsQrImage: "sms.png" }),
    });
    const expectedWhatsapp = await QRCode.toDataURL("https://booth.example.com/start?event=Developer+Week+2026&lang=pt_BR", QR_OPTIONS);

    assert.deepEqual(qrSources(html), ["/booth-uploads/sms.png", expectedWhatsapp]);
    const body = bodyMarkup(html);
    assert.match(body, /<div class="qr-two-up">/);
    assert.match(body, /<div class="qr-channel-label">SMS · \(415\) 555-0100<\/div>/);
    assert.match(body, /<div class="qr-channel-label">Escaneie para escolher SMS ou WhatsApp<\/div>/);
});

test("dual-channel display pairs SMS start-page QR with uploaded WhatsApp QR", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({ boothWhatsappQrSource: "upload", boothWhatsappQrImage: "whatsapp.png" }),
    });
    const expectedSms = await QRCode.toDataURL("https://booth.example.com/start?event=Developer+Week+2026&lang=en", QR_OPTIONS);

    assert.deepEqual(qrSources(html), [expectedSms, "/booth-uploads/whatsapp.png"]);
    const body = bodyMarkup(html);
    assert.match(body, /<div class="qr-two-up">/);
    assert.match(body, /<div class="qr-channel-label">Scan to choose SMS or WhatsApp<\/div>/);
    assert.match(body, /<div class="qr-channel-label">WhatsApp · \+14155550200<\/div>/);
});

test("uploaded QR remains available when only its channel is enabled", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({ boothShowWhatsapp: false, boothSmsQrSource: "upload", boothSmsQrImage: "sms.png" }),
    });

    assert.deepEqual(qrSources(html), ["/booth-uploads/sms.png"]);
    assert.doesNotMatch(bodyMarkup(html), /<div class="qr-two-up">/);
});

test("dual-channel display keeps an uploaded QR when no public URL is available", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "not a public URL",
        locale: "en",
        getSetting: panelSettings({ boothSmsQrSource: "upload", boothSmsQrImage: "sms.png" }),
    });
    const body = bodyMarkup(html);

    assert.deepEqual(qrSources(html), ["/booth-uploads/sms.png"]);
    assert.match(body, /SMS · \(415\) 555-0100/);
    assert.doesNotMatch(body, /<div class="qr-two-up">|qr-placeholder/);
});

test("dual-channel display shows one unavailable placeholder without a public URL or uploaded QRs", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "not a public URL",
        locale: "en",
        getSetting: panelSettings(),
    });
    const body = bodyMarkup(html);

    assert.deepEqual(qrSources(html), []);
    assert.equal((body.match(/class="qr-placeholder"/g) || []).length, 1);
    assert.match(body, /Channel selector unavailable/);
    assert.doesNotMatch(body, /<div class="qr-two-up">/);
});

test("dual-channel display preserves both uploaded QRs when neither number is configured", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({
            boothSmsPhone: "", boothWhatsappPhone: "",
            boothSmsQrSource: "upload", boothSmsQrImage: "sms.png",
            boothWhatsappQrSource: "upload", boothWhatsappQrImage: "whatsapp.png",
        }),
    });
    const body = bodyMarkup(html);

    assert.deepEqual(qrSources(html), ["/booth-uploads/sms.png", "/booth-uploads/whatsapp.png"]);
    assert.match(body, /<div class="qr-two-up">/);
    assert.doesNotMatch(body, /Scan to choose SMS or WhatsApp/);
});

test("dual-channel display shows one unavailable placeholder when neither channel can launch", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "https://booth.example.com",
        locale: "en",
        getSetting: panelSettings({
            boothSmsPhone: "", twilioPhoneNumber: "",
            boothWhatsappPhone: "", twilioWhatsappNumber: "",
        }),
    });

    assert.equal(qrSources(html).length, 0);
    assert.equal((bodyMarkup(html).match(/class="qr-placeholder"/g) || []).length, 1);
    assert.match(bodyMarkup(html), /Channel selector unavailable/);
});

test("local panel preview explains its QR cannot be scanned from a phone", async () => {
    const html = await buildStaticPanelHtml("en", {
        baseUrl: "http://127.0.0.1:4173",
        locale: "en",
        getSetting: panelSettings(),
        previewOnly: true,
    });

    assert.match(bodyMarkup(html), /Local preview/);
    assert.match(bodyMarkup(html), /QR points to 127\.0\.0\.1 and will not open on a phone/);
    assert.match(bodyMarkup(html), /href="http:\/\/127\.0\.0\.1:4173\/start\?event=Developer\+Week\+2026&amp;lang=en"[^>]*>Open channel selector on this computer/);
});

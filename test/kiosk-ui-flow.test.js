const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { buildKioskHtml, buildKioskOptions } = require("../lib/kiosk");

function browserScript(html) {
    const match = html.match(/<script>\n([\s\S]*?)<\/script>/);
    assert.ok(match, "kiosk client script is embedded");
    return match[1];
}

test("kiosk uses the event's style, brand, and combination-specific background choices", () => {
    const options = buildKioskOptions({
        activeStyles: {
            portrait: { name: "Portrait", prompt: "private style prompt" },
            container: { name: "Container", behavior: "themed-container" },
        },
        activeStyleList: ["portrait", "container"],
        activeBrands: {
            sponsor: {
                name: "Sponsor",
                brandPrompt: "private brand prompt",
                scenes: [{ key: "stage", name: "Stage", prompt: "private scene prompt" }],
                allowOriginal: false,
            },
        },
        enableBrandMenu: true,
        offerUnbranded: true,
        enableBackgroundMenu: true,
        backgroundChoices: [
            { key: "gradient", name: "Gradient", prompt: "private background prompt" },
            { key: "original", name: "Original", prompt: "private original prompt" },
        ],
        locale: "en",
    });
    assert.deepEqual(options.styleOptions.map((option) => option.key), ["portrait", "container"]);
    assert.deepEqual(options.brandOptions.map((option) => option.key), ["sponsor", "__none__"]);
    assert.deepEqual(
        options.backgroundOptionsByCombination["portrait|sponsor"].options.map((option) => option.key),
        ["stage", "plain-white"],
    );
    assert.deepEqual(
        options.backgroundOptionsByCombination["portrait|__none__"].options.map((option) => option.key),
        ["gradient", "original"],
    );
    assert.equal(options.backgroundOptionsByCombination["container|__none__"].kind, "auto");
    assert.equal(options.backgroundOptionsByCombination["container|__none__"].selected, "original");
    assert.doesNotMatch(JSON.stringify(options), /private .* prompt/);
});

test("kiosk uses an automatically selected brand when offering scene choices", async () => {
    const options = buildKioskOptions({
        activeStyles: { portrait: { name: "Portrait" } },
        activeStyleList: ["portrait"],
        activeBrands: {
            sponsor: {
                name: "Sponsor",
                scenes: [{ key: "stage", name: "Stage" }],
                allowOriginal: false,
            },
        },
        enableBrandMenu: true,
        offerUnbranded: false,
        enableBackgroundMenu: true,
        backgroundChoices: [{ key: "gradient", name: "Gradient" }],
        locale: "en",
    });
    assert.equal(options.autoBrandKey, "sponsor");
    assert.deepEqual(options.brandOptions, []);
    assert.deepEqual(
        options.backgroundOptionsByCombination["portrait|sponsor"].options.map((option) => option.key),
        ["stage", "plain-white"],
    );

    let submitted;
    const browser = fakeBrowser(buildKioskHtml({ ...options, eventName: "Demo", deliveryChannels: ["email"] }),
        async (_url, request) => {
            submitted = request.body;
            return { ok: true, json: async () => ({ filePrefix: "portrait_1" }) };
        });
    const element = (id) => browser.elements.get(id);
    await element("startBtn").emit("click");
    await element("snapBtn").emit("click");
    assert.deepEqual(element("backgroundSel").children.map((option) => option.value), ["", "stage", "plain-white"]);
    element("backgroundSel").value = "stage";
    element("emailInput").value = "guest@example.test";
    element("consentInput").checked = true;
    await element("confirmBtn").emit("click");
    assert.equal(submitted.get("background"), "stage");
    assert.equal(submitted.get("brand"), null, "the API applies the same automatic brand");
});

test("kiosk page offers one delivery method and keeps personal data out of URLs", () => {
    const html = buildKioskHtml({
        styleOptions: [{ key: "cartoon", name: "Cartoon" }],
        eventName: "Demo <Event>",
        deliveryChannels: ["sms", "whatsapp", "email"],
    });
    assert.match(html, /name="deliveryChannel" value="sms"/);
    assert.match(html, /name="deliveryChannel" value="whatsapp"/);
    assert.match(html, /name="deliveryChannel" value="email"/);
    assert.match(html, /Demo &lt;Event&gt;/);
    assert.match(html, /public photo book/);
    assert.match(html, /href="\/start\/notice\?event=Demo\+%3CEvent%3E&amp;lang=en&amp;kiosk=1"/);
    assert.match(html, /autocomplete="off"/);
    assert.doesNotMatch(html, /href="\/home"|id="user-bar"/);
    assert.match(html, /fetch\("\/api\/generate"/);
    assert.match(html, /form\.append\("requestId", requestId\)/);
    assert.match(html, /form\.append\("event", EVENT_NAME\)/);
    assert.doesNotMatch(html, /URLSearchParams\(\)|\?style=|qs\.set\("phone"/);
    assert.doesNotThrow(() => new vm.Script(browserScript(html)));
});

function fakeBrowser(html, fetchImpl, { play, toBlob, drawImage } = {}) {
    const elements = new Map();
    const ids = [
        "video", "canvas", "preview", "countdown", "status", "startBtn", "snapBtn",
        "confirmBtn", "retakeBtn", "cancelBtn", "againBtn", "styleSel", "brandSel",
        "backgroundSel", "phoneInput", "emailInput", "consentInput", "whatsappOptIn",
        "brand-field", "background-field", "phone-field", "email-field",
        "whatsapp-opt-in-row", "review-panel", "done-card", "stage",
        "controls-capture", "controls-confirm", "done-title", "done-detail",
    ];
    class FakeElement {
        constructor(id) {
            this.id = id;
            this.listeners = {};
            this.classes = new Set();
            this.classList = {
                add: (name) => this.classes.add(name),
                remove: (name) => this.classes.delete(name),
                contains: (name) => this.classes.has(name),
                toggle: (name, force) => force ? this.classes.add(name) : this.classes.delete(name),
            };
            this.value = "";
            this.checked = false;
            this.disabled = false;
            this.children = [];
            this.src = "";
            this.videoWidth = 640;
            this.videoHeight = 480;
            this.readyState = 2;
        }
        addEventListener(type, listener) {
            (this.listeners[type] ||= []).push(listener);
        }
        removeEventListener(type, listener) {
            this.listeners[type] = (this.listeners[type] || []).filter((item) => item !== listener);
        }
        async emit(type) {
            for (const listener of this.listeners[type] || []) await listener({ target: this });
        }
        appendChild(child) { this.children.push(child); }
        replaceChildren() { this.children = []; this.value = ""; }
        removeAttribute(name) { this[name] = ""; }
        focus() { this.focused = true; }
        play() { return Promise.resolve(); }
        getContext() {
            return { save() {}, scale() {}, drawImage() {}, restore() {} };
        }
        toBlob(callback) { callback(new Blob(["jpeg"], { type: "image/jpeg" })); }
    }
    for (const id of ids) elements.set(id, new FakeElement(id));
    if (play) elements.get("video").play = play;
    if (toBlob) elements.get("canvas").toBlob = toBlob;
    if (drawImage) elements.get("canvas").getContext = () => ({ drawImage });
    const radio = new FakeElement("email-radio");
    radio.value = "email";
    radio.checked = true;
    const document = {
        getElementById: (id) => elements.get(id),
        createElement: (tag) => new FakeElement(tag),
        querySelectorAll: (selector) => selector === 'input[name="deliveryChannel"]' ? [radio] : [],
        querySelector: (selector) => {
            if (selector === 'input[name="deliveryChannel"]:checked') return radio.checked ? radio : null;
            return selector === 'input[name="deliveryChannel"]' ? radio : null;
        },
        addEventListener() {},
    };
    const stopped = [];
    const track = { stop() { stopped.push(true); }, addEventListener() {} };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    const urlsRevoked = [];
    const timerCallbacks = new Map();
    let nextTimer = 1;
    class FormDataStub {
        constructor() { this.fields = []; }
        append(key, value) { this.fields.push([key, value]); }
        get(key) { return this.fields.find((entry) => entry[0] === key)?.[1] ?? null; }
    }
    const context = {
        document,
        window: { addEventListener() {} },
        navigator: { mediaDevices: { getUserMedia: async () => stream } },
        URL: {
            createObjectURL: () => "blob:captured-photo",
            revokeObjectURL: (url) => urlsRevoked.push(url),
        },
        crypto: { randomUUID: () => "11111111-2222-4333-8444-555555555555" },
        FormData: FormDataStub,
        Blob,
        AbortController,
        Uint8Array,
        fetch: fetchImpl,
        setTimeout: (callback, delay) => {
            const id = nextTimer++;
            if (delay <= 900) Promise.resolve().then(callback);
            else timerCallbacks.set(id, { callback, delay });
            return id;
        },
        clearTimeout: (id) => timerCallbacks.delete(id),
    };
    vm.runInNewContext(browserScript(html), context);
    return {
        elements, radio, stopped, urlsRevoked,
        runTimers: (delay) => {
            for (const [id, timer] of timerCallbacks) {
                if (timer.delay !== delay) continue;
                timerCallbacks.delete(id);
                timer.callback();
            }
        },
    };
}

test("saved JPEG uses the camera frame orientation while only the live preview is mirrored", async () => {
    const html = buildKioskHtml({
        styleOptions: [{ key: "cartoon", name: "Cartoon" }],
        eventName: "Demo",
        deliveryChannels: ["email"],
    });
    assert.match(html, /video \{ transform: scaleX\(-1\); \}/);
    const draws = [];
    const browser = fakeBrowser(html, async () => {
        throw new Error("fetch should not run");
    }, { drawImage: (...args) => draws.push(args) });
    await browser.elements.get("startBtn").emit("click");
    await browser.elements.get("snapBtn").emit("click");
    assert.equal(draws.length, 1);
    assert.equal(draws[0][0], browser.elements.get("video"));
    assert.deepEqual(draws[0].slice(1), [0, 0, 640, 480]);
});

test("idle reset clears a guest's contact and captured photo", async () => {
    const html = buildKioskHtml({
        styleOptions: [{ key: "cartoon", name: "Cartoon" }],
        eventName: "Demo",
        deliveryChannels: ["email"],
    });
    const browser = fakeBrowser(html, async () => {
        throw new Error("fetch should not run");
    });
    const element = (id) => browser.elements.get(id);
    await element("startBtn").emit("click");
    await element("snapBtn").emit("click");
    element("emailInput").value = "guest@example.test";
    element("consentInput").checked = true;
    browser.runTimers(120000);
    assert.equal(element("emailInput").value, "");
    assert.equal(element("consentInput").checked, false);
    assert.equal(element("preview").src, "");
    assert.equal(element("startBtn").disabled, false);
    assert.deepEqual(browser.urlsRevoked, ["blob:captured-photo"]);
    assert.match(element("status").textContent, /cleared after inactivity/i);
});

test("kiosk recovers from camera playback and JPEG encoding failures", async () => {
    const html = buildKioskHtml({
        styleOptions: [{ key: "cartoon", name: "Cartoon" }],
        eventName: "Demo",
        deliveryChannels: ["email"],
    });
    const unavailable = fakeBrowser(html, async () => {
        throw new Error("fetch should not run");
    }, { play: async () => { throw new Error("playback failed"); } });
    await unavailable.elements.get("startBtn").emit("click");
    assert.equal(unavailable.elements.get("startBtn").disabled, false);
    assert.equal(unavailable.elements.get("snapBtn").disabled, true);
    assert.match(unavailable.elements.get("status").textContent, /camera is unavailable/i);

    const encodeFailure = fakeBrowser(html, async () => {
        throw new Error("fetch should not run");
    }, { toBlob: (callback) => callback(null) });
    await encodeFailure.elements.get("startBtn").emit("click");
    await encodeFailure.elements.get("snapBtn").emit("click");
    assert.equal(encodeFailure.elements.get("snapBtn").disabled, false);
    assert.match(encodeFailure.elements.get("status").textContent, /could not capture/i);
});

test("email kiosk retries one capture with one request ID and clears guest data after acceptance", async () => {
    const html = buildKioskHtml({
        styleOptions: [{ key: "cartoon", name: "Cartoon" }],
        eventName: "Demo",
        deliveryChannels: ["email"],
    });
    const requests = [];
    const browser = fakeBrowser(html, async (url, options) => {
        requests.push({ url, options });
        if (requests.length === 1) throw new Error("lost response");
        return { ok: true, status: 202, json: async () => ({ filePrefix: "job123" }) };
    });
    const element = (id) => browser.elements.get(id);

    await element("startBtn").emit("click");
    assert.equal(element("snapBtn").disabled, false);
    await element("snapBtn").emit("click");
    assert.equal(element("preview").src, "blob:captured-photo");
    element("emailInput").value = "guest@example.test";
    element("consentInput").checked = true;
    await element("confirmBtn").emit("click");
    assert.equal(element("confirmBtn").disabled, false, "upload failure allows retry");
    await element("confirmBtn").emit("click");

    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.url), ["/api/generate", "/api/generate"]);
    const first = requests[0].options.body;
    const second = requests[1].options.body;
    assert.equal(first.get("requestId"), second.get("requestId"));
    assert.equal(first.get("event"), "Demo");
    assert.equal(first.get("style"), "cartoon");
    assert.equal(first.get("channel"), "email");
    assert.equal(first.get("email"), "guest@example.test");
    assert.equal(first.get("phone"), null);
    assert.equal(first.get("consent"), "2");
    assert.equal(element("emailInput").value, "");
    assert.equal(element("preview").src, "");
    assert.deepEqual(browser.urlsRevoked, ["blob:captured-photo"]);
    assert.ok(browser.stopped.length > 0);
    assert.match(element("done-detail").textContent, /email when it is ready/);
});

test("kiosk does not claim a portrait was queued after an HTML login redirect", async () => {
    const html = buildKioskHtml({
        styleOptions: [{ key: "cartoon", name: "Cartoon" }],
        eventName: "Demo",
        deliveryChannels: ["email"],
    });
    const browser = fakeBrowser(html, async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error("response was HTML"); },
    }));
    const element = (id) => browser.elements.get(id);
    await element("startBtn").emit("click");
    await element("snapBtn").emit("click");
    element("emailInput").value = "guest@example.test";
    element("consentInput").checked = true;
    await element("confirmBtn").emit("click");
    assert.equal(element("confirmBtn").disabled, false);
    assert.equal(element("preview").src, "blob:captured-photo");
    assert.match(element("status").textContent, /could not submit/i);
});

test("expired kiosk session clears the guest's photo and asks staff to relaunch", async () => {
    const html = buildKioskHtml({
        styleOptions: [{ key: "cartoon", name: "Cartoon" }],
        eventName: "Demo",
        deliveryChannels: ["email"],
    });
    const browser = fakeBrowser(html, async () => ({
        ok: false,
        status: 401,
        json: async () => ({ code: "KIOSK_SESSION_EXPIRED" }),
    }));
    const element = (id) => browser.elements.get(id);
    await element("startBtn").emit("click");
    await element("snapBtn").emit("click");
    element("emailInput").value = "guest@example.test";
    element("consentInput").checked = true;
    await element("confirmBtn").emit("click");
    assert.equal(element("emailInput").value, "");
    assert.equal(element("preview").src, "");
    assert.equal(element("review-panel").classList.contains("hidden"), true);
    assert.match(element("status").textContent, /ask event staff to relaunch/i);
});

test("event switch clears the guest's photo and waits for staff relaunch", async () => {
    const html = buildKioskHtml({
        styleOptions: [{ key: "cartoon", name: "Cartoon" }],
        eventName: "Demo",
        deliveryChannels: ["email"],
    });
    const browser = fakeBrowser(html, async () => ({
        ok: false,
        status: 409,
        json: async () => ({ code: "EVENT_CHANGED" }),
    }));
    const element = (id) => browser.elements.get(id);
    await element("startBtn").emit("click");
    await element("snapBtn").emit("click");
    element("emailInput").value = "guest@example.test";
    element("consentInput").checked = true;
    await element("confirmBtn").emit("click");
    assert.equal(element("emailInput").value, "");
    assert.equal(element("preview").src, "");
    assert.equal(element("review-panel").classList.contains("hidden"), true);
    assert.match(element("status").textContent, /event changed.*staff to relaunch/i);
});

test("an in-progress retry keeps the photo while a conflicting retry asks staff", async () => {
    const html = buildKioskHtml({
        styleOptions: [{ key: "cartoon", name: "Cartoon" }],
        eventName: "Demo",
        deliveryChannels: ["email"],
    });
    let attempts = 0;
    const browser = fakeBrowser(html, async () => ({
        ok: false,
        status: 409,
        json: async () => ({ code: ++attempts === 1 ? "REQUEST_IN_PROGRESS" : "REQUEST_ID_CONFLICT" }),
    }));
    const element = (id) => browser.elements.get(id);
    await element("startBtn").emit("click");
    await element("snapBtn").emit("click");
    element("emailInput").value = "guest@example.test";
    element("consentInput").checked = true;

    await element("confirmBtn").emit("click");
    assert.equal(element("preview").src, "blob:captured-photo");
    assert.equal(element("emailInput").value, "guest@example.test");
    assert.match(element("status").textContent, /still being submitted/i);

    await element("confirmBtn").emit("click");
    assert.equal(element("preview").src, "");
    assert.equal(element("emailInput").value, "");
    assert.match(element("status").textContent, /ask event staff for help/i);
});

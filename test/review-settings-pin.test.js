const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const settings = require("../lib/settings");
const audit = require("../lib/audit");
const { mountReviewSettings } = require("../lib/review-settings");
const { buildMobileSettingsHtml } = require("../lib/review-settings-page");

async function withSettingsRoutes(state, run) {
    const originals = {
        getAll: settings.getAll,
        get: settings.get,
        update: settings.update,
        refreshTemplateStateFromDisk: settings.refreshTemplateStateFromDisk,
        sanitizeTemplateReferenceChanges: settings.sanitizeTemplateReferenceChanges,
        logSettingsChange: audit.logSettingsChange,
    };

    settings.getAll = () => structuredClone(state);
    settings.get = (key) => state[key];
    settings.update = (changes) => Object.assign(state, changes);
    settings.refreshTemplateStateFromDisk = () => {};
    settings.sanitizeTemplateReferenceChanges = (changes) => changes;
    audit.logSettingsChange = async () => {};

    const routes = { get: {}, post: {} };
    const router = {
        get: (path, ...handlers) => { routes.get[path] = handlers.at(-1); },
        post: (path, ...handlers) => { routes.post[path] = handlers.at(-1); },
    };
    mountReviewSettings(router, (_req, _res, next) => next());

    try {
        await run(routes);
    } finally {
        settings.getAll = originals.getAll;
        settings.get = originals.get;
        settings.update = originals.update;
        settings.refreshTemplateStateFromDisk = originals.refreshTemplateStateFromDisk;
        settings.sanitizeTemplateReferenceChanges = originals.sanitizeTemplateReferenceChanges;
        audit.logSettingsChange = originals.logSettingsChange;
    }
}

function jsonResponse() {
    return {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

function mobileScript() {
    const routes = {};
    const router = {
        get: (path, ...handlers) => { routes[path] = handlers.at(-1); },
        post: () => {},
    };
    mountReviewSettings(router, (_req, _res, next) => next());
    const response = {
        type() { return this; },
        send(html) { this.html = html; },
    };
    routes["/settings"]({ headers: {} }, response);
    const script = [...response.html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1])
        .find((body) => body.includes("function renderSettings()"));
    assert.ok(script);

    const settingsBody = { innerHTML: "", textContent: "" };
    const defaultInput = { value: "", checked: false };
    const pinInput = { value: "" };
    const context = {
        document: {
            getElementById: (id) => id === "settingsBody" ? settingsBody
                : id === "queueBtn" ? null
                    : id === "sReviewPin" ? pinInput : defaultInput,
            querySelectorAll: () => [],
        },
        fetch: () => new Promise(() => {}),
    };
    vm.createContext(context);
    vm.runInContext(script, context);
    return { context, settingsBody, pinInput, html: response.html };
}

function mobileWorkspace() {
    const { context, settingsBody, html } = mobileScript();
    let renderedHtml = "";
    let groups = [];
    Object.defineProperty(settingsBody, "innerHTML", {
        get: () => renderedHtml,
        set(value) {
            renderedHtml = value;
            groups = [...value.matchAll(/<section class="sg-group" data-group="([^"]+)"/g)].map((match) => {
                const classes = new Set();
                const header = { expanded: "false", setAttribute(_name, value) { this.expanded = value; } };
                return {
                    key: match[1], header,
                    getAttribute() { return this.key; },
                    querySelector() { return header; },
                    classList: {
                        contains: (name) => classes.has(name),
                        add: (name) => classes.add(name),
                        toggle: (name, force) => {
                            if (force === undefined) force = !classes.has(name);
                            if (force) classes.add(name); else classes.delete(name);
                            return force;
                        },
                    },
                };
            });
        },
    });
    context.document.querySelectorAll = (selector) => selector === ".sg-group" ? groups : [];
    return { context, settingsBody, html, getGroups: () => groups };
}

test("mobile settings API returns PIN configuration status without the PIN value", async () => {
    const state = { eventName: "demo", reviewPin: "2468", maxPrints: 2, messages: {} };
    await withSettingsRoutes(state, async (routes) => {
        let response = jsonResponse();
        routes.get["/api/settings"]({}, response);
        assert.equal(response.statusCode, 200);
        assert.equal(response.body.hasReviewPin, true);
        assert.equal(Object.hasOwn(response.body, "reviewPin"), false);
        assert.equal(JSON.stringify(response.body).includes("2468"), false);

        state.reviewPin = "";
        response = jsonResponse();
        routes.get["/api/settings"]({}, response);
        assert.equal(response.body.hasReviewPin, false);
        assert.equal(Object.hasOwn(response.body, "reviewPin"), false);
    });
});

test("review settings responses contain only fields used by the page", async () => {
    const state = {
        eventName: "demo",
        reviewMode: "human",
        reviewPin: "2468",
        maxPrints: 2,
        messages: { welcome: "Welcome" },
        customStyles: { sketch: { name: "Sketch", prompt: "Pencil portrait" } },
        twilioAccountSid: "ACsynthetic",
        twilioVoiceNumber: "+14155550111",
        boothSmsPhone: "+14155550222",
        boothWhatsappPhone: "+14155550333",
        dubFolderId: "synthetic-folder",
        futureInfrastructureField: "synthetic-private-value",
    };
    await withSettingsRoutes(state, async (routes) => {
        const expectedKeys = ["eventName", "reviewMode", "hasReviewPin", "maxPrints", "messages", "customStyles"].sort();

        const getResponse = jsonResponse();
        routes.get["/api/settings"]({}, getResponse);
        assert.deepEqual(Object.keys(getResponse.body).sort(), expectedKeys);
        assert.equal(getResponse.body.hasReviewPin, true);
        assert.equal(getResponse.body.messages.welcome, "Welcome");
        const defaultMessageKey = Object.keys(settings.DEFAULTS.messages).find((key) => key !== "welcome");
        assert.ok(defaultMessageKey);
        assert.equal(getResponse.body.messages[defaultMessageKey], settings.DEFAULTS.messages[defaultMessageKey]);
        assert.deepEqual(getResponse.body.customStyles, state.customStyles);

        const postResponse = jsonResponse();
        await routes.post["/api/settings"]({ body: {
            _forEvent: "demo",
            maxPrints: 3,
            twilioVoiceNumber: "+14155550999",
            boothSmsPhone: "+14155550888",
            boothWhatsappPhone: "+14155550777",
        } }, postResponse);
        assert.equal(postResponse.statusCode, 200);
        assert.deepEqual(Object.keys(postResponse.body).sort(), expectedKeys);
        assert.equal(postResponse.body.maxPrints, 3);
        assert.equal(postResponse.body.messages[defaultMessageKey], settings.DEFAULTS.messages[defaultMessageKey]);
        assert.deepEqual(postResponse.body.customStyles, state.customStyles);
        assert.equal(state.twilioVoiceNumber, "+14155550111");
        assert.equal(state.boothSmsPhone, "+14155550222");
        assert.equal(state.boothWhatsappPhone, "+14155550333");
    });
});

test("Review settings only changes fields offered by its page", async () => {
    const state = {
        eventName: "demo", reviewPin: "2468", maxPrints: 2,
        customStyles: { sketch: { name: "Sketch", prompt: "Old prompt" } },
        printerName: "Current printer", boothSmsPhone: "+14155550111",
        dubSlugPrefix: "existing", messages: {},
    };
    await withSettingsRoutes(state, async (routes) => {
        const response = jsonResponse();
        await routes.post["/api/settings"]({ body: {
            _forEvent: "demo",
            maxPrints: 3,
            customStyles: { sketch: { name: "Sketch", prompt: "New prompt" } },
            printerName: "Other printer",
            boothSmsPhone: "+14155550999",
            dubSlugPrefix: "changed",
            futureInfrastructureField: "unrelated",
        } }, response);

        assert.equal(response.statusCode, 200);
        assert.equal(state.maxPrints, 3);
        assert.equal(state.customStyles.sketch.prompt, "New prompt");
        assert.equal(state.printerName, "Current printer");
        assert.equal(state.boothSmsPhone, "+14155550111");
        assert.equal(state.dubSlugPrefix, "existing");
        assert.equal(Object.hasOwn(state, "futureInfrastructureField"), false);
        for (const key of ["printerName", "boothSmsPhone", "dubSlugPrefix", "futureInfrastructureField"]) {
            assert.equal(Object.hasOwn(response.body, key), false);
        }
    });
});

test("saving another mobile setting or an empty PIN leaves the current PIN intact", async () => {
    const state = { eventName: "demo", reviewPin: "2468", maxPrints: 2, messages: {} };
    await withSettingsRoutes(state, async (routes) => {
        const response = jsonResponse();
        await routes.post["/api/settings"]({ body: { _forEvent: "demo", maxPrints: 3, reviewPin: "" } }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(state.maxPrints, 3);
        assert.equal(state.reviewPin, "2468");
        assert.equal(response.body.hasReviewPin, true);
        assert.equal(Object.hasOwn(response.body, "reviewPin"), false);
    });
});

test("an existing mobile settings user can replace the PIN without receiving its value", async () => {
    const state = { eventName: "demo", reviewPin: "2468", maxPrints: 2, messages: {} };
    await withSettingsRoutes(state, async (routes) => {
        const response = jsonResponse();
        await routes.post["/api/settings"]({ body: { _forEvent: "demo", reviewPin: " 8642 " } }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(state.reviewPin, "8642");
        assert.equal(response.body.hasReviewPin, true);
        assert.equal(Object.hasOwn(response.body, "reviewPin"), false);
        assert.equal(JSON.stringify(response.body).includes("8642"), false);
    });
});

test("mobile settings rejects replacement PINs that are not 4–6 digits", async () => {
    const state = { eventName: "demo", reviewPin: "2468", maxPrints: 2, messages: {} };
    await withSettingsRoutes(state, async (routes) => {
        for (const invalidPin of ["123", "1234567", "12ab", 1234, null]) {
            const response = jsonResponse();
            await routes.post["/api/settings"]({ body: { _forEvent: "demo", maxPrints: 3, reviewPin: invalidPin } }, response);
            assert.equal(response.statusCode, 400);
            assert.equal(state.reviewPin, "2468");
            assert.equal(state.maxPrints, 2);
        }
    });
});

test("explicit review PIN removal disables it and returns only configuration status", async () => {
    const state = { eventName: "demo", reviewPin: "2468", maxPrints: 2, messages: {} };
    await withSettingsRoutes(state, async (routes) => {
        const response = jsonResponse();
        assert.equal(typeof routes.post["/api/settings/review-pin/remove"], "function");
        await routes.post["/api/settings/review-pin/remove"]({ body: { _forEvent: "demo" } }, response);
        assert.equal(response.statusCode, 200);
        assert.equal(state.reviewPin, "");
        assert.deepEqual(response.body, { hasReviewPin: false });
        assert.equal(JSON.stringify(response.body).includes("2468"), false);
    });
});

test("review PIN removal leaves the PIN intact when the active event changed", async () => {
    const state = { eventName: "another-event", reviewPin: "2468", maxPrints: 2, messages: {} };
    await withSettingsRoutes(state, async (routes) => {
        const response = jsonResponse();
        assert.equal(typeof routes.post["/api/settings/review-pin/remove"], "function");
        await routes.post["/api/settings/review-pin/remove"]({ body: { _forEvent: "demo" } }, response);
        assert.equal(response.statusCode, 409);
        assert.equal(state.reviewPin, "2468");
    });
});

test("mobile PIN field is blank and only shows whether a PIN is configured", () => {
    const { context, settingsBody } = mobileScript();
    context.currentSettings = { reviewPin: "2468", hasReviewPin: true };
    context.fileOptions = {};
    context.renderSettings();

    assert.equal(/Current PIN: Configured/.test(settingsBody.innerHTML), true);
    assert.equal(/<input type="password" id="sReviewPin"[^>]*>/.test(settingsBody.innerHTML), true);
    assert.equal(settingsBody.innerHTML.includes("2468"), false);
});

test("mobile settings renderer uses accessible sections and keeps detailed controls collapsed", () => {
    const { context, settingsBody, html, getGroups } = mobileWorkspace();
    context.currentSettings = { eventName: "Demo", reviewMode: "human", hasReviewPin: true };
    context.fileOptions = { styles: [{ key: "cartoon", name: "Cartoon" }], brands: [{ key: "twilio", name: "Twilio" }] };
    context.renderSettings();

    assert.equal(buildMobileSettingsHtml(), html);
    assert.match(html, /review-settings-workspace\.css/);
    assert.match(html, /class="review-settings-topbar"/);
    assert.match(html, /class="save-bar"/);
    assert.match(html, /id="saveBtn"[^>]*>Review changes<\/button>/);
    assert.match(settingsBody.innerHTML, /<button type="button" class="sg-group-header" aria-expanded="false" aria-controls="sg-review"/);
    assert.match(settingsBody.innerHTML, /<details class="sg-details"><summary>Advanced review options<\/summary>/);
    assert.match(settingsBody.innerHTML, /id="sVariantsPerReview"/);
    assert.match(settingsBody.innerHTML, /id="sRegenerationLimit"/);
    for (const id of [
        "sMaxPrints", "sLanguageMode", "sQueuePaused", "sMaxGen", "sDefaultStyle", "sMultiSubject",
        "sEnablePrinting", "sReviewMode", "sReviewPin", "sBoothDisplayMode", "sBoothHeadline",
        "sBoothSubline", "sLeadCapture", "sEnablePromo", "sPromoMessage", "sEnableNps",
        "sEnableBgMenu", "sPromptBackground", "sPromptDirective", "sPromptPreserve",
        "sPromptComposition", "sPromptPreserveBrand", "sPromptBrandInstruction", "sBrandPrompt",
    ]) {
        assert.equal((settingsBody.innerHTML.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, id);
    }
    assert.equal((settingsBody.innerHTML.match(/<section class="sg-group"/g) || []).length,
        (settingsBody.innerHTML.match(/<\/section>/g) || []).length);
    assert.deepEqual(getGroups().filter((group) => group.classList.contains("open")).map((group) => group.key), ["review"]);
    assert.equal(getGroups()[0].header.expanded, "true");

    const operations = getGroups().find((group) => group.key === "operations");
    operations.classList.add("open");
    context.fileOptions.brands = [];
    context.renderSettings();
    assert.deepEqual(getGroups().filter((group) => group.classList.contains("open")).map((group) => group.key), ["review", "operations"]);
    assert.equal(settingsBody.innerHTML.includes("data-group=\"brands\""), false);
});

test("mobile save omits a blank PIN and hides a replacement in its confirmation summary", () => {
    const { context, pinInput } = mobileScript();
    context.currentSettings = { hasReviewPin: true };

    assert.equal(Object.hasOwn(context.buildPayload(), "reviewPin"), false);
    pinInput.value = "8642";
    const payload = context.buildPayload();
    assert.equal(payload.reviewPin, "8642");
    const summary = context.summarizeChanges({ reviewPin: payload.reviewPin });
    assert.equal(summary.count, 1);
    assert.equal(summary.items.join(" ").includes("8642"), false);
});

test("mobile Remove Review PIN asks for confirmation and cancellation makes no request", () => {
    const { context, settingsBody, html } = mobileScript();
    context.currentSettings = { hasReviewPin: true };
    context.fileOptions = {};
    context.renderSettings();
    assert.equal(/id="removeReviewPinBtn"/.test(settingsBody.innerHTML), true);
    assert.equal(/id="removePinModal"/.test(html), true);
    assert.equal(/Review PIN sign-in will be disabled/.test(html), true);

    const classes = new Set();
    const modal = {
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
        },
    };
    context.document.getElementById = (id) => id === "removePinModal" ? modal : null;
    let requests = 0;
    context.fetch = () => { requests++; throw new Error("Unexpected request"); };

    assert.equal(typeof context.requestRemoveReviewPin, "function");
    context.requestRemoveReviewPin();
    assert.equal(classes.has("show"), true);
    assert.equal(requests, 0);
    context.closeRemovePinModal();
    assert.equal(classes.has("show"), false);
    assert.equal(requests, 0);
});

test("confirming removal calls the dedicated route and updates PIN status", async () => {
    const { context, pinInput } = mobileScript();
    context.currentSettings = { hasReviewPin: true };
    context.loadedEventName = "demo";
    pinInput.value = "8642";

    const classes = new Set(["show"]);
    const modal = {
        classList: {
            add: (name) => classes.add(name),
            remove: (name) => classes.delete(name),
        },
    };
    const status = { textContent: "Current PIN: Configured" };
    const removeButton = { removed: false, remove() { this.removed = true; } };
    const confirmButton = { disabled: false, textContent: "Remove PIN" };
    const toast = { textContent: "", className: "" };
    context.document.getElementById = (id) => ({
        removePinModal: modal,
        reviewPinStatus: status,
        removeReviewPinBtn: removeButton,
        removePinConfirmBtn: confirmButton,
        sReviewPin: pinInput,
        toast,
    })[id] || null;
    context.setTimeout = () => 0;
    const requests = [];
    context.fetch = (url, options) => {
        requests.push({ url, options });
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ hasReviewPin: false }) });
    };

    assert.equal(typeof context.confirmRemoveReviewPin, "function");
    await context.confirmRemoveReviewPin();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/review/api/settings/review-pin/remove");
    assert.equal(requests[0].options.method, "POST");
    assert.deepEqual(JSON.parse(requests[0].options.body), { _forEvent: "demo" });
    assert.equal(context.currentSettings.hasReviewPin, false);
    assert.equal(status.textContent, "Current PIN: Not configured");
    assert.equal(removeButton.removed, true);
    assert.equal(pinInput.value, "");
    assert.equal(classes.has("show"), false);
});

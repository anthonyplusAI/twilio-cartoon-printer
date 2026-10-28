const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { buildHomeHtml, buildSettingsHtml } = require("../lib/home");
const { createPreviewServer } = require("../scripts/preview-home");

function settingsScript() {
    const html = buildSettingsHtml();
    const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1])
        .find((body) => body.includes("function collectSettingsBody()"));
    assert.ok(script);
    return script;
}

test("rendered Home and Settings inline scripts parse", () => {
    for (const html of [buildHomeHtml(), buildSettingsHtml()]) {
        for (const [, script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
            new vm.Script(script);
        }
    }
});

test("Home is an operator hub with event-scoped status and direct tool links", () => {
    const values = {
        eventName: "Demo & Friends",
        queuePaused: true,
        reviewMode: "human",
        enablePrinting: false,
        boothShowSms: true,
        twilioPhoneNumber: "+14155550199",
        boothShowWhatsapp: false,
    };
    const html = buildHomeHtml({ getSetting: (key) => values[key] });
    assert.match(html, /<h1 id="eventTitle">Demo &amp; Friends<\/h1>/);
    assert.match(html, /Twilio \+ AI Photo Generator/);
    assert.match(html, /\/assets\/home-hub\.css/);
    assert.match(html, /review-count\?e=Demo%20%26%20Friends/);
    assert.match(html, /id="reviewNotify"/);
    assert.match(html, /<dd class="paused">Paused<\/dd>/);
    for (const route of ["/dashboard/", "/photogallery/", "/outreach/", "/home/settings", "/home/combo", "/kiosk"]) {
        assert.ok(html.includes(`href="${route}"`), `${route} remains directly reachable`);
    }
    assert.doesNotMatch(html, /id="settingsPanel"|id="sTwilioSid"|id="sModelOrch"/);
    const noVideo = buildHomeHtml({ getSetting: (key) => ({ ...values, videoFile: "" })[key] });
    assert.match(noVideo, /Gallery only/);
    assert.doesNotMatch(noVideo, /href="\/home\/video"/);
});

test("Settings puts technical fields in Advanced and shows credential status without old secret inputs", () => {
    const html = buildSettingsHtml();
    for (const section of ["event", "portrait", "delivery", "booth", "messaging", "advanced"]) {
        assert.match(html, new RegExp(`data-nav-section="${section}"`));
    }
    assert.match(html, /id="settingsSearch"/);
    assert.match(html, /data-section="advanced"[\s\S]*id="sTwilioSid"[\s\S]*id="sModelOrch"/);
    assert.match(html, /id="credentialOpenai"|id="credentialDub"/);
    assert.match(html, /\/dashboard\/api\/settings\/credentials\/dub/);
    assert.match(html, /id="dangerZone"/);
    for (const oldId of ["sTwilioToken", "sOpenaiKey", "sDubApiKey", "sReviewPin", "sPrintRelayKey"]) {
        assert.doesNotMatch(html, new RegExp(`id="${oldId}"`));
    }
    const collector = settingsScript().split("function collectSettingsBody()")[1].split("async function _doSaveSettings()")[0];
    for (const secret of ["openaiApiKey", "twilioAuthToken", "dubApiKey", "printRelayKey", "reviewPin"]) {
        assert.doesNotMatch(collector, new RegExp(`\\b${secret}\\b`));
    }
});

test("Voice toggle and readiness guidance stay in Messaging while routing IDs stay in Advanced", () => {
    const html = buildSettingsHtml();
    const messaging = html.split('data-section="messaging"')[1].split('data-section="advanced"')[0];
    const advanced = html.split('data-section="advanced"')[1].split('id="dangerZone"')[0];
    assert.match(messaging, /id="sEnableVoice"/);
    assert.match(messaging, /id="voiceReadiness"/);
    assert.match(messaging, /place a test call from the phone that sent a selfie/i);
    assert.doesNotMatch(messaging, /id="sTwilioVoiceNumber"|id="sCtVoiceInvitationEn"/);
    assert.match(advanced, /id="sTwilioVoiceNumber"/);
    for (const id of [
        "sCtVoiceInvitationEn", "sCtVoiceDeliveryEn", "sCtVoiceFailureEn",
        "sCtVoiceInvitationPt", "sCtVoiceDeliveryPt", "sCtVoiceFailurePt",
    ]) {
        assert.match(advanced, new RegExp(`id="${id}"`));
    }
    assert.doesNotMatch(html, /id="[^"]*voiceInvitationPhone[^"]*"/);
});

test("Voice readiness reports only a confirmed empty issue list as configured", () => {
    const script = settingsScript();
    const readiness = script.slice(script.indexOf("function renderVoiceReadiness()"), script.indexOf("function populateSettings()"));
    const fields = { voiceReadiness: { textContent: "" }, sEnableVoice: { checked: false } };
    const context = { _settings: {}, document: { getElementById: (id) => fields[id] } };
    vm.createContext(context);
    vm.runInContext(readiness, context);

    context.renderVoiceReadiness();
    assert.match(fields.voiceReadiness.textContent, /unavailable/i);
    assert.doesNotMatch(fields.voiceReadiness.textContent, /checks passed/i);

    context._settings.voiceReadinessIssues = ["Voice number must be E.164"];
    context.renderVoiceReadiness();
    assert.match(fields.voiceReadiness.textContent, /Last saved Voice setup needs: Voice number must be E\.164/);

    context._settings.voiceReadinessIssues = [];
    context.renderVoiceReadiness();
    assert.match(fields.voiceReadiness.textContent, /Last saved Voice configuration passes checks\. Enable Voice and save/);
    fields.sEnableVoice.checked = true;
    context.renderVoiceReadiness();
    assert.match(fields.voiceReadiness.textContent, /Save edits to recheck, then place a test call/);
});

test("Settings collection retains all approved Voice template IDs and the shared number", () => {
    const script = settingsScript();
    const collector = script.slice(script.indexOf("function collectSettingsBody()"), script.indexOf("async function _doSaveSettings()"));
    const fields = new Map();
    const field = (id) => {
        if (!fields.has(id)) fields.set(id, { value: "", checked: false });
        return fields.get(id);
    };
    const voiceIds = {
        sCtVoiceInvitationEn: "HXinvitationEn",
        sCtVoiceDeliveryEn: "HXdeliveryEn",
        sCtVoiceFailureEn: "HXfailureEn",
        sCtVoiceInvitationPt: "HXinvitationPt",
        sCtVoiceDeliveryPt: "HXdeliveryPt",
        sCtVoiceFailurePt: "HXfailurePt",
    };
    for (const [id, value] of Object.entries(voiceIds)) field(id).value = ` ${value} `;
    field("sTwilioVoiceNumber").value = "+14155550100";
    field("sEnableVoice").checked = true;
    const context = {
        document: { getElementById: field, querySelectorAll: () => [] },
        _templateSelections: { portrait: "", landscape: "" }, _activeTemplateOrientation: "portrait",
        _settings: {}, _adminPhones: [], _brandRefFiles: [], _disabledBrands: [],
        _backgroundChoices: [], _customBrands: {}, _brandPromptOverrides: {},
        _customStyles: {}, _stylePromptOverrides: {}, _leadCaptureFields: {},
        getSelectedPrinters: () => [], getBoothSteps: () => [], collectMessages: () => ({}),
    };
    vm.createContext(context);
    vm.runInContext(collector, context);
    const body = context.collectSettingsBody();
    assert.equal(body.enableVoice, true);
    assert.equal(body.twilioVoiceNumber, "+14155550100");
    assert.equal(body.contentTemplates.en.voiceInvitation, "HXinvitationEn");
    assert.equal(body.contentTemplates.en.voiceDelivery, "HXdeliveryEn");
    assert.equal(body.contentTemplates.en.voiceFailure, "HXfailureEn");
    assert.equal(body.contentTemplates.pt_BR.voiceInvitation, "HXinvitationPt");
    assert.equal(body.contentTemplates.pt_BR.voiceDelivery, "HXdeliveryPt");
    assert.equal(body.contentTemplates.pt_BR.voiceFailure, "HXfailurePt");
    assert.equal("voiceInvitationPhone" in body.contentTemplates.en, false);
    assert.equal("voiceInvitationPhone" in body.contentTemplates.pt_BR, false);

    field("sMaxPrints").value = "5";
    const unrelatedEdit = context.collectSettingsBody();
    assert.equal(unrelatedEdit.maxPrints, 5);
    assert.equal(unrelatedEdit.contentTemplates.en.voiceInvitation, "HXinvitationEn");
    assert.equal(unrelatedEdit.contentTemplates.pt_BR.voiceFailure, "HXfailurePt");
});

test("Settings save sends changed fields only and checks reload success", async () => {
    const script = settingsScript();
    const saveFunction = script.slice(script.indexOf("async function _doSaveSettings()"), script.indexOf("async function resetEventData()"));
    let posted = null;
    let loaded = true;
    let alertCount = 0;
    const context = {
        _baselineBody: { maxPrints: 2, enablePrinting: true },
        _settings: { eventName: "DEMO EVENT" },
        collectSettingsBody: () => ({ maxPrints: 3, enablePrinting: true }),
        document: { getElementById: () => ({ value: "DEMO EVENT" }) },
        fetch: async (_url, options) => {
            posted = JSON.parse(options.body);
            return { ok: true, json: async () => ({}) };
        },
        loadSettings: async () => loaded,
        updateDirtyState: () => {},
        showBanner: () => {},
        twModal: { alert: async () => { alertCount++; } },
    };
    vm.createContext(context);
    vm.runInContext(saveFunction, context);
    assert.equal(await context._doSaveSettings(), true);
    assert.deepEqual(posted, { maxPrints: 3, _forEvent: "DEMO EVENT" });

    loaded = false;
    assert.equal(await context._doSaveSettings(), false);
    assert.equal(alertCount, 1);
});

test("Voice readiness save failure shows the actual setup issues in Messaging", async () => {
    const script = settingsScript();
    const saveFunction = script.slice(script.indexOf("async function _doSaveSettings()"), script.indexOf("async function resetEventData()"));
    let section;
    let alertMessage;
    const context = {
        _baselineBody: { enableVoice: false },
        _settings: { eventName: "DEMO EVENT" },
        collectSettingsBody: () => ({ enableVoice: true }),
        updateDirtyState: () => {},
        showSettingsSection: (value) => { section = value; },
        fetch: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({
            error: "Voice configuration is incomplete",
            issues: ["Voice number must be E.164", "Public HTTPS BASE_URL is required"],
        }) }),
        twModal: { alert: async ({ message }) => { alertMessage = message; } },
    };
    vm.createContext(context);
    vm.runInContext(saveFunction, context);
    assert.equal(await context._doSaveSettings(), false);
    assert.equal(section, "messaging");
    assert.match(alertMessage, /Voice number must be E\.164/);
    assert.match(alertMessage, /Public HTTPS BASE_URL is required/);
});

test("printer refresh keeps the current selection while the checklist is loading", async () => {
    const script = settingsScript();
    const refreshFunction = script.slice(script.indexOf("async function refreshPrinters()"), script.indexOf("// ── Save / Reset"));
    const container = { innerHTML: "checked printers" };
    let renderedSelection;
    const context = {
        document: { getElementById: () => container },
        getSelectedPrinters: () => container.innerHTML === "checked printers" ? ["printer A"] : [],
        fetch: async () => ({ json: async () => ({ printers: ["printer A", "printer B"] }) }),
        renderPrinterChecklist: (_available, selected) => { renderedSelection = selected; },
        _files: {},
    };
    vm.createContext(context);
    vm.runInContext(refreshFunction, context);
    await context.refreshPrinters();
    assert.deepEqual(renderedSelection, ["printer A"]);
});

test("local fixture preview serves sample pages and refuses every write", () => {
    const server = createPreviewServer();
    function request(method, url) {
        const result = {};
        const response = {
            writeHead(status, headers) { result.status = status; result.headers = headers; },
            end(body = "") { result.body = body.toString(); },
        };
        server.emit("request", { method, url }, response);
        return result;
    }
    const home = request("GET", "/home/");
    const settings = request("GET", "/home/settings?section=advanced");
    const state = JSON.parse(request("GET", "/dashboard/api/settings").body);
    const rejected = request("POST", "/dashboard/api/settings");
    assert.match(home.body, /Read-only demo preview · sample data/);
    assert.match(settings.body, /Read-only demo preview · sample data/);
    assert.equal(state.eventName, "DEMO EVENT");
    assert.deepEqual(Object.keys(state).filter((key) => ["openaiApiKey", "twilioAuthToken", "dubApiKey", "printRelayKey", "reviewPin"].includes(key)), []);
    assert.equal(rejected.status, 405);
});

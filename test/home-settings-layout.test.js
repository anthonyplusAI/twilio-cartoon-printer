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
    const fields = { voiceReadiness: { textContent: "", dataset: {} }, sEnableVoice: { checked: false } };
    const context = { _settings: {}, document: { getElementById: (id) => fields[id] } };
    vm.createContext(context);
    vm.runInContext(readiness, context);

    context.renderVoiceReadiness();
    assert.match(fields.voiceReadiness.textContent, /unavailable/i);
    assert.doesNotMatch(fields.voiceReadiness.textContent, /checks passed/i);

    context._settings.voiceReadinessIssues = ["Voice number must be E.164"];
    context.renderVoiceReadiness();
    assert.match(fields.voiceReadiness.textContent, /Last saved Voice setup needs: Voice number must be E\.164/);
    assert.equal(fields.voiceReadiness.dataset.state, "warning");

    context._settings.voiceReadinessIssues = [];
    context.renderVoiceReadiness();
    assert.match(fields.voiceReadiness.textContent, /Last saved Voice configuration passes checks\. Enable Voice and save/);
    assert.equal(fields.voiceReadiness.dataset.state, "ready");
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

test("Settings preview thumbnails wait until Art Styles is opened", () => {
    const script = settingsScript();
    const previewFunctions = script.slice(
        script.indexOf("var _stylePreviewCache = new Map()"),
        script.indexOf("function renderPhoneTags()"),
    );
    const thumb = {
        id: "sp0", dataset: { previewStyle: "cartoon" }, nodes: [],
        replaceChildren() { this.nodes = []; },
        appendChild(node) { this.nodes.push(node); },
    };
    let collapsed = true;
    const list = {
        closest: () => ({ classList: { contains: () => collapsed } }),
        querySelectorAll: () => [thumb],
    };
    let requests = 0;
    class VisibleObserver {
        constructor(callback) { this.callback = callback; }
        observe(target) { this.callback([{ isIntersecting: true, target }]); }
        unobserve() {}
        disconnect() {}
    }
    const context = {
        Map, Set, _baselineBody: {}, _activeSection: "event",
        window: { IntersectionObserver: VisibleObserver },
        IntersectionObserver: VisibleObserver,
        document: {
            getElementById: (id) => id === "stylesList" ? list : thumb,
            createElement: () => ({ className: "", textContent: "" }),
        },
        fetch: () => { requests++; return Promise.resolve({ ok: true, json: async () => ({ image: null }) }); },
    };
    vm.createContext(context);
    vm.runInContext(previewFunctions, context);
    context.loadStylePreviews();
    assert.equal(requests, 0, "Event section does not request every style preview");
    context._activeSection = "portrait";
    context.loadStylePreviews();
    assert.equal(requests, 0, "closed Art Styles card does not request previews");
    collapsed = false;
    context.loadStylePreviews();
    assert.equal(requests, 1, "opening Art Styles requests its visible preview");
});

test("local fixture preview serves sample pages and refuses every write", () => {
    const server = createPreviewServer();
    function request(method, url) {
        const result = {};
        const response = {
            writeHead(status, headers) { result.status = status; result.headers = headers; },
            end(body = "") { result.body = body.toString(); },
        };
        server.emit("request", { method, url, headers: {} }, response);
        return result;
    }
    const home = request("GET", "/home/");
    const settings = request("GET", "/home/settings?section=advanced");
    const dashboard = request("GET", "/dashboard/");
    const logsPage = request("GET", "/dashboard/logs/");
    const outreach = request("GET", "/outreach/");
    const gallery = request("GET", "/photogallery/");
    const review = request("GET", "/review/queue");
    const reviewSettings = request("GET", "/review/settings");
    const evalRuns = request("GET", "/eval");
    const evalNew = request("GET", "/eval/new");
    const evalPhotos = request("GET", "/eval/photos");
    const evalVariants = request("GET", "/eval/variants");
    const evalDetail = request("GET", "/eval/run/demo-run-001");
    const state = JSON.parse(request("GET", "/dashboard/api/settings").body);
    const recipients = JSON.parse(request("GET", "/outreach/api/users?paged=1&event=DEMO%20EVENT&page=1&limit=5").body);
    const portraits = JSON.parse(request("GET", "/photogallery/api/images?event=DEMO%20EVENT&limit=6").body);
    const jobs = request("GET", "/dashboard/api/done-jobs?e=DEMO%20EVENT&limit=3");
    const logs = JSON.parse(request("GET", "/dashboard/api/logs?limit=4").body);
    const reviews = JSON.parse(request("GET", "/review/api/queue?e=DEMO%20EVENT&limit=5").body);
    const dashboardReviews = request("GET", "/dashboard/api/review-queue?e=DEMO%20EVENT&limit=12");
    const runSummary = JSON.parse(request("GET", "/eval/api/runs/demo-run-001/summary").body);
    const rejected = request("POST", "/dashboard/api/settings");
    assert.match(home.body, /Read-only demo preview · sample data/);
    assert.match(settings.body, /Read-only demo preview · sample data/);
    assert.match(dashboard.body, /Dashboard — Twilio Photobooth/);
    assert.match(logsPage.body, /Application logs/);
    assert.match(outreach.body, /Outreach — Twilio Photobooth/);
    assert.match(gallery.body, /Photo Book — Twilio Photobooth/);
    assert.match(review.body, /Review portraits/);
    assert.match(reviewSettings.body, /Settings — Twilio Photobooth/);
    assert.match(evalRuns.body, /Prompt runs/);
    assert.match(evalNew.body, /New experiment/);
    assert.match(evalPhotos.body, /Test photos/);
    assert.match(evalVariants.body, /Saved variants/);
    assert.match(evalDetail.body, /Cartoon detail/);
    assert.match(evalDetail.body, /Page 1 of 2/);
    assert.equal(state.eventName, "DEMO EVENT");
    assert.equal(recipients.items.length, 5);
    assert.ok(recipients.total > recipients.items.length);
    assert.equal(portraits.images.length, 6);
    assert.ok(portraits.total > portraits.images.length);
    assert.equal(JSON.parse(jobs.body).length, 3);
    assert.ok(Number(jobs.headers["X-Total-Count"]) > 3);
    assert.equal(logs.length, 4);
    assert.equal(reviews.items.length, 5);
    assert.ok(reviews.total > reviews.items.length);
    assert.equal(JSON.parse(dashboardReviews.body).length, 12);
    assert.equal(Number(dashboardReviews.headers["X-Total-Count"]), 30);
    assert.equal(runSummary.totals.total, 132);
    assert.deepEqual(Object.keys(state).filter((key) => ["openaiApiKey", "twilioAuthToken", "dubApiKey", "printRelayKey", "reviewPin"].includes(key)), []);
    assert.equal(rejected.status, 405);
});

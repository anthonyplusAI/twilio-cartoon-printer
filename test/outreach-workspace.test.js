const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { paginateRows, buildOutreachHtml } = require("../lib/outreach-page");

test("Outreach pagination filters before slicing and bounds page size", () => {
    const rows = Array.from({ length: 121 }, (_, id) => ({ id, name: id === 120 ? "Last guest" : `Guest ${id}` }));
    const page = paginateRows(rows, { page: "2", limit: "20" });
    assert.deepEqual(page.items.map((row) => row.id), Array.from({ length: 20 }, (_, i) => i + 20));
    assert.equal(page.total, 121);
    assert.equal(page.pages, 7);
    assert.equal(page.page, 2);
    const search = paginateRows(rows, { page: "9", limit: "2", q: "LAST" }, (row, q) => row.name.toLowerCase().includes(q));
    assert.deepEqual(search.items.map((row) => row.id), [120]);
    assert.equal(search.total, 1);
    assert.equal(search.page, 1);
    assert.equal(paginateRows(rows, { limit: "9000" }).limit, 50);
    assert.equal(paginateRows(rows, { page: "nope", limit: "0" }).page, 1);
    assert.equal(rows.length, 121);
});

test("kiosk outreach shows the approved variant while retaining the original submission key", async () => {
    const app = syntheticOutreach({ kioskVariantWinner: true });
    const response = await app.request("get", "/api/kiosk-submissions", {
        query: { event: "Event A", paged: "1", q: "portrait_0-v1" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.payload.total, 1);
    assert.equal(response.payload.items[0].filePrefix, "portrait_0-v1");
    assert.equal(response.payload.items[0].resultPrefix, "portrait_0-v2");
});

test("kiosk outreach reports the resolved job's digital and print state", async () => {
    const app = syntheticOutreach({
        kioskVariantWinner: true,
        kioskStatus: {
            dir: "/synthetic/ready",
            job: {
                filePrefix: "portrait_0-v2", eventName: "Event A", kioskSubmission: true,
                channel: "email", kioskDeliveryState: "uncertain", kioskDeliveryAttempts: 1,
                kioskEventSnapshot: { eventSettings: { enablePrinting: true } },
                readyAt: 500,
            },
        },
    });
    const response = await app.request("get", "/api/kiosk-submissions", {
        query: { event: "Event A", paged: "1", q: "portrait_0-v1" },
    });
    const row = response.payload.items[0];
    assert.equal(row.resultPrefix, "portrait_0-v2");
    assert.deepEqual(JSON.parse(JSON.stringify(row.kioskStatus)), {
        portrait: "ready",
        channel: "email",
        delivery: { state: "uncertain", attempts: 1 },
        print: { state: "queued" },
    });
});

test("kiosk outreach does not report a job from another event", async () => {
    const app = syntheticOutreach({
        kioskStatus: {
            dir: "/synthetic/done",
            job: {
                filePrefix: "portrait_0", eventName: "Another event", kioskSubmission: true,
                channel: "sms", kioskDeliveryState: "delivered",
            },
        },
    });
    const response = await app.request("get", "/api/kiosk-submissions", {
        query: { event: "Event A", paged: "1", q: "portrait_0" },
    });
    assert.equal(response.payload.items[0].kioskStatus, null);
});

test("kiosk outreach portrait links and delivery status use the approved variant prefix", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "assets", "outreach-workspace.js"), "utf8");
    const row = {
        filePrefix: "portrait_0-v1", resultPrefix: "portrait_0-v2", event: "Event A",
        email: "guest@example.test",
        kioskStatus: { portrait: "ready", channel: "email", delivery: { state: "uncertain", attempts: 1 }, print: { state: "queued" } },
    };
    const body = { innerHTML: "", querySelectorAll: () => [] };
    const exposed = {};
    const instrumented = source.replace(/  start\(\);\s*\}\)\(\);\s*$/, "  Object.assign(globalThis.__outreachTest, { state, renderKiosk });\n})();");
    assert.notEqual(instrumented, source, "the test loads the actual Outreach renderer");
    vm.runInNewContext(instrumented, {
        document: { getElementById: (id) => id === "kioskSubsBody" ? body : null },
        Date, encodeURIComponent, URLSearchParams, AbortController, console,
        __outreachTest: exposed,
    }, { filename: "outreach-workspace.js" });
    const view = exposed;
    view.state.lists.kiosk.items = [row];
    view.renderKiosk();
    assert.match(body.innerHTML, /\/photogallery\/img\/Event%20A\/portrait_0-v2_output\.png/);
    assert.match(body.innerHTML, /api\/thumbnail\/Event%20A\/portrait_0-v2/);
    assert.match(body.innerHTML, /Email: Needs review/);
    assert.match(body.innerHTML, /Print: Queued/);
    assert.match(body.innerHTML, /\/api\/generate\/portrait_0-v1\/status/);
});

test("Outreach preview renderer is independent of live stores and uses deferred view assets", () => {
    const html = buildOutreachHtml();
    assert.match(html, /\/assets\/outreach-workspace\.css/);
    assert.match(html, /\/assets\/outreach-workspace\.js/);
    assert.match(html, /id="view-messaging"/);
    for (const view of ["leads", "kiosk", "followups"]) {
        assert.match(html, new RegExp(`id="view-${view}"[^>]* hidden`));
    }
    assert.doesNotMatch(html, /<!--USER_BAR-->|<!--MAGIC_HAT-->/);
    new vm.Script(fs.readFileSync(path.join(__dirname, "..", "assets", "outreach-workspace.js"), "utf8"));
});

function syntheticOutreach({ holdFirstDoneRead = false, holdSecondReadFile = false, marketingConsent = false, legacyRawUpload = false, kioskVariantWinner = false, kioskStatus = null } = {}) {
    const routes = { get: new Map(), post: new Map(), delete: new Map() };
    const router = {
        use() {},
        get(pathname, handler) { routes.get.set(pathname, handler); },
        post(pathname, handler) { routes.post.set(pathname, handler); },
        delete(pathname, handler) { routes.delete.set(pathname, handler); },
    };
    const express = { Router: () => router, json: () => () => {} };
    const doneDir = "/synthetic/done";
    const jobs = Array.from({ length: 120 }, (_, i) => ({
        userPhone: `+1415555${String(i).padStart(4, "0")}`,
        appPhone: "+14155559999",
        eventName: "Event A",
        filePrefix: `portrait_${i}`,
        createdAt: i + 1,
        style: "cartoon",
    }));
    const rawUpload = "api_123e4567-e89b-12d3-a456-426614174000_input.jpg";
    const imageDir = "/synthetic/downloads/Event A";
    const imageFiles = new Set(legacyRawUpload
        ? ["portrait_0_output.png", "portrait_0_input.jpg", rawUpload, "portrait_01_output.png"]
        : []);
    if (legacyRawUpload) {
        jobs[0].kioskSubmission = true;
        jobs[0].uploadedInputFile = rawUpload;
    }
    const jobFiles = new Map(jobs.map((job, i) => [`${i}.json`, job]));
    const kiosk = Array.from({ length: 72 }, (_, i) => ({ filePrefix: `portrait_${i}`, event: "Event A", phone: `+1415555${String(i).padStart(4, "0")}`, email: `guest${i}@example.test`, submittedAt: i }));
    if (kioskVariantWinner) kiosk[0].filePrefix = "portrait_0-v1";
    const leads = Array.from({ length: 83 }, (_, i) => ({ firstName: `Guest ${i}`, lastName: "Test", phone: `+1415555${String(i).padStart(4, "0")}`, email: `guest${i}@example.test`, company: "Twilio", completedAt: i }));
    const followups = Array.from({ length: 65 }, (_, i) => ({ phone: `+1415777${String(i).padStart(4, "0")}`, eventName: "Event A", firstContactAt: i }));
    let accessCount = 0;
    let sentMessages = 0;
    let nudgedContacts = 0;
    let randomBound = 0;
    let now = 1_000_000;
    class SyntheticDate extends Date { static now() { return now; } }
    let releaseJobs = () => {};
    const firstDoneRead = holdFirstDoneRead
        ? new Promise((resolve) => { releaseJobs = resolve; })
        : Promise.resolve();
    let doneReads = 0;
    let releaseSecondReads = () => {};
    const secondReadGate = holdSecondReadFile
        ? new Promise((resolve) => { releaseSecondReads = resolve; })
        : Promise.resolve();
    let secondReadStarted;
    const secondReadStartedPromise = new Promise((resolve) => { secondReadStarted = resolve; });
    const fakeFs = {
        promises: {
            readdir: async (dir) => {
                if (dir !== doneDir) return [];
                if (++doneReads === 1) await firstDoneRead;
                return [...jobFiles.keys()];
            },
            readFile: async (file) => {
                if (kioskStatus && file === path.join(kioskStatus.dir, `${kioskStatus.job.filePrefix}.json`)) {
                    return JSON.stringify(kioskStatus.job);
                }
                const job = jobFiles.get(path.basename(file));
                if (!job) throw Object.assign(new Error("job gone"), { code: "ENOENT" });
                const snapshot = JSON.stringify(job);
                if (holdSecondReadFile && doneReads === 2) {
                    secondReadStarted();
                    await secondReadGate;
                }
                return snapshot;
            },
            access: async () => { accessCount++; throw new Error("no thumbnail"); },
            stat: async () => ({ size: 1024, mtimeMs: 1 }),
        },
        existsSync: () => false,
        readdirSync: (dir) => dir === doneDir ? [...jobFiles.keys()] : dir === imageDir ? [...imageFiles] : [],
        readFileSync: (file) => JSON.stringify(jobFiles.get(path.basename(file))),
        unlinkSync: (file) => {
            if (path.dirname(file) === imageDir) imageFiles.delete(path.basename(file));
            else jobFiles.delete(path.basename(file));
        },
        writeFileSync() {},
        renameSync() {},
    };
    const stubs = {
        fs: fakeFs,
        path,
        express,
        sharp: () => ({ rotate() { return this; }, resize() { return this; }, webp() { return this; }, toBuffer: async () => Buffer.from("synthetic-image") }),
        "./config": { DONE_DIR: doneDir, PENDING_DIR: "/synthetic/pending", GENERATING_DIR: "/synthetic/generating", REVIEW_DIR: "/synthetic/review", READY_DIR: "/synthetic/ready", PRINTING_DIR: "/synthetic/printing", PROCESSING_DIR: "/synthetic/processing", FAILED_DIR: "/synthetic/failed" },
        "./settings": { get: (key) => key === "eventName" ? "Event A" : [], getForEvent: () => "en", getDownloadDir: (event) => `/synthetic/downloads/${event}` },
        "./messaging": { send: async () => { sentMessages++; return {}; } },
        "./leads": { getLeadName: (phone) => `Guest ${Number(phone.slice(-4))}`, getLeads: () => leads.slice(), deleteByPhone: () => 1 },
        "./kiosk-submissions": { listByEvent: () => kiosk.slice(), deleteBatch: () => 0 },
        "./contacts": {
            getDropOffs: () => followups.slice(), getPreferredChannel: () => "sms",
            getPreferredLocale: () => null,
            hasMarketingConsent: (_phone, eventName, channel) => marketingConsent && eventName === "Event A" && channel === "sms",
            markNudged: () => { nudgedContacts++; return true; }, deleteByPhone() {},
        },
        "./channels": { ADAPTERS: { sms: { name: "sms", isConfigured: () => true } } },
        "./i18n": { resolveAttendeeLocale: () => "en", DEFAULT_LOCALE: "en", t: () => "Finish your portrait" },
        "./photogallery": { invalidatePhotoGalleryCache() {} },
        "./queue": {
            buildUsageCache() {},
            resolveKioskResultPrefix: async (prefix, event) =>
                kioskVariantWinner && event === "Event A" && prefix === "portrait_0-v1"
                    ? "portrait_0-v2" : prefix,
        },
        "./auth": { userBarSnippet: () => "", magicHatSnippet: () => "" },
        "./outreach-page": { paginateRows, buildOutreachHtml: () => "<html></html>" },
        "node:crypto": { randomInt: (bound) => { randomBound = bound; return bound - 1; } },
    };
    const code = fs.readFileSync(path.join(__dirname, "..", "lib", "outreach.js"), "utf8");
    const module = { exports: {} };
    vm.runInNewContext(code, {
        require: (name) => {
            if (!(name in stubs)) throw new Error(`Unexpected module ${name}`);
            return stubs[name];
        },
        module, exports: module.exports, __dirname: "/synthetic/lib", process: { pid: 1 }, console, Date: SyntheticDate,
    }, { filename: "outreach.js" });
    module.exports.mountOutreach({ use() {} });

    async function request(method, route, { query = {}, body = {}, params = {} } = {}) {
        const handler = routes[method].get(route);
        assert.ok(handler, `${method} ${route} exists`);
        let status = 200;
        let payload;
        const response = {
            status(code) { status = code; return this; },
            json(value) { payload = value; return this; },
            send(value) { payload = value; return this; },
            sendStatus(code) { status = code; return this; },
            setHeader() {},
        };
        await handler({ query, body, params }, response);
        return { status, payload };
    }
    return {
        request, releaseJobs, releaseSecondReads,
        waitSecondReadStarted: () => secondReadStartedPromise,
        advanceTime: (ms) => { now += ms; },
        get accessCount() { return accessCount; }, get randomBound() { return randomBound; },
        get sentMessages() { return sentMessages; }, get nudgedContacts() { return nudgedContacts; },
        get imageFiles() { return [...imageFiles]; },
    };
}

test("cold Outreach send waits for completed jobs before resolving recipients", async () => {
    const app = syntheticOutreach({ holdFirstDoneRead: true, marketingConsent: true });
    const request = app.request("post", "/api/send-message", {
        body: { ids: [1654912861], message: "Event update", event: "Event A" },
    });
    app.releaseJobs();
    const result = await request;
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(JSON.stringify(result.payload)), { sent: 1, failed: 0 });
});

test("Outreach does not send a promotional broadcast to an attendee without consent", async () => {
    const app = syntheticOutreach();
    const result = await app.request("post", "/api/send-message", {
        body: { ids: [1654912861], message: "New offers", event: "Event A" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(JSON.stringify(result.payload)), { sent: 0, failed: 1 });
    assert.equal(app.sentMessages, 0);
});

test("Outreach nudge requires promotional consent before sending", async () => {
    const app = syntheticOutreach();
    const dropOffs = await app.request("get", "/api/drop-offs", { query: { event: "Event A" } });
    const result = await app.request("post", "/api/nudge", {
        body: { id: dropOffs.payload[0].id, event: "Event A" },
    });
    assert.equal(result.status, 403);
    assert.equal(app.sentMessages, 0);
    assert.equal(app.nudgedContacts, 0);
});

test("Outreach sends a nudge to a consenting attendee on the opted-in channel", async () => {
    const app = syntheticOutreach({ marketingConsent: true });
    const dropOffs = await app.request("get", "/api/drop-offs", { query: { event: "Event A" } });
    const result = await app.request("post", "/api/nudge", {
        body: { id: dropOffs.payload[0].id, event: "Event A" },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(JSON.stringify(result.payload)), { ok: true });
    assert.equal(app.sentMessages, 1);
    assert.equal(app.nudgedContacts, 1);
});

test("cold Outreach deletion waits for completed jobs before resolving users", async () => {
    const app = syntheticOutreach({ holdFirstDoneRead: true });
    const request = app.request("delete", "/api/users", {
        body: { ids: [1654912861], event: "Event A", scope: "lead" },
    });
    app.releaseJobs();
    const result = await request;
    assert.equal(result.status, 200);
    assert.equal(result.payload.deletedLeads, 1);
});

test("deleting a kiosk user removes the legacy raw upload without touching a neighboring prefix", async () => {
    const app = syntheticOutreach({ legacyRawUpload: true });
    const deleted = await app.request("delete", "/api/users", {
        body: { ids: [1654912861], event: "Event A", scope: "photos" },
    });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.payload.deletedImages, 3);
    assert.deepEqual(app.imageFiles, ["portrait_01_output.png"]);
});

test("a refresh started before deletion cannot restore a deleted recipient", async () => {
    const app = syntheticOutreach({ holdSecondReadFile: true });
    await app.request("get", "/api/users", { query: { event: "Event A", paged: "1" } });
    app.advanceTime(31_000);
    await app.request("get", "/api/users", { query: { event: "Event A", paged: "1" } });
    await app.waitSecondReadStarted();

    const deleted = await app.request("delete", "/api/users", {
        body: { ids: [1654912861], event: "Event A", scope: "photos" },
    });
    assert.equal(deleted.payload.deletedJobs, 1);
    app.releaseSecondReads();
    await new Promise((resolve) => setImmediate(resolve));

    const later = await app.request("get", "/api/users", {
        query: { event: "Event A", paged: "1", q: "+14155550000" },
    });
    assert.equal(later.payload.total, 0);
});

test("Outreach APIs page all large lists and raffle draw uses every eligible user", async () => {
    const app = syntheticOutreach();
    const query = { event: "Event A", paged: "1", page: "1", limit: "25" };
    const users = (await app.request("get", "/api/users", { query })).payload;
    assert.equal(users.total, 120);
    assert.equal(users.items.length, 25);
    assert.equal(app.accessCount, 25, "thumbnail checks run only for page rows");
    const laterUser = (await app.request("get", "/api/users", { query: { ...query, q: "Guest 0" } })).payload;
    assert.ok(laterUser.total > 0);
    assert.ok(laterUser.items.every((user) => user.name.includes("Guest 0")));
    const leadPage = (await app.request("get", "/api/leads", { query })).payload;
    assert.equal(leadPage.total, 83);
    assert.equal(leadPage.items.length, 25);
    const kioskPage = (await app.request("get", "/api/kiosk-submissions", { query })).payload;
    assert.equal(kioskPage.total, 72);
    assert.equal(kioskPage.items.length, 25);
    const followupPage = (await app.request("get", "/api/drop-offs", { query })).payload;
    assert.equal(followupPage.total, 65);
    assert.equal(followupPage.items.length, 25);
    const draw = await app.request("post", "/api/raffle/draw", { body: { event: "Event A" } });
    assert.equal(draw.status, 200);
    assert.equal(app.randomBound, 120, "raffle includes recipients beyond the current page");
    assert.ok(draw.payload.maskedPhone.endsWith("0000"));
    const history = (await app.request("get", "/api/raffle", { query })).payload;
    assert.equal(history.total, 1);
    assert.equal(history.items[0].id, draw.payload.id);
    const unsafeImage = await app.request("get", "/api/thumbnail/:event/:prefix", { params: { event: "..", prefix: "portrait_1" } });
    assert.equal(unsafeImage.status, 400);
    const encodedTraversal = await app.request("get", "/api/thumbnail/:event/:prefix", { params: { event: "%252e%252e", prefix: "portrait_1" } });
    assert.equal(encodedTraversal.status, 400);
    const thumb = await app.request("get", "/api/thumbnail/:event/:prefix", { params: { event: "Event A", prefix: "portrait_1" } });
    assert.equal(thumb.status, 200);
    assert.equal(thumb.payload.toString(), "synthetic-image");
});

test("Kiosk log caches unchanged reads and keeps identical prefixes in different events", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "lib", "kiosk-submissions.js"), "utf8");
    let text = [
        { filePrefix: "same", event: "A", email: "a@example.test", submittedAt: 2 },
        { filePrefix: "same", event: "B", email: "b@example.test", submittedAt: 3 },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n";
    let version = 1;
    let reads = 0;
    const temporaryFiles = new Map();
    const fakeFs = {
        existsSync: () => true,
        statSync: () => ({ size: text.length, mtimeMs: version, ctimeMs: version }),
        readFileSync: () => { reads++; return text; },
        appendFileSync: (_file, value) => { text += value; version++; },
        writeFileSync: (file, value) => { temporaryFiles.set(file, value); },
        renameSync: (from) => { text = temporaryFiles.get(from); temporaryFiles.delete(from); version++; },
        mkdirSync() {},
    };
    const module = { exports: {} };
    vm.runInNewContext(source, {
        require: (name) => name === "fs" ? fakeFs : path,
        module, exports: module.exports, __dirname: "/synthetic/lib", process: { pid: 1 }, Date, Buffer,
    });
    const store = module.exports;
    assert.equal(store.listByEvent(null).length, 2);
    assert.equal(store.listByEvent(null).length, 2);
    assert.equal(reads, 1, "unchanged polling reuses parsed log");
    store.setEmail("same", "A", "new@example.test");
    store.markEmailed("same", "A");
    const refreshed = store.listByEvent(null);
    assert.equal(refreshed.length, 2);
    assert.ok(refreshed.find((row) => row.event === "A").emailedAt);
    assert.equal(refreshed.find((row) => row.event === "A").email, "new@example.test");
    assert.equal(refreshed.find((row) => row.event === "B").email, "b@example.test");
    assert.doesNotMatch(text, /a@example\.test/, "superseded contact details are removed from disk");
    assert.equal(reads, 1, "compacting an edit updates the warm cache");
    version++;
    text += JSON.stringify({ filePrefix: "new", event: "A", email: "new@example.test", submittedAt: 4 }) + "\n";
    assert.equal(store.listByEvent("A").length, 2);
    assert.equal(reads, 2, "an external append is detected by file metadata");
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const DASHBOARD_PATH = path.join(__dirname, "..", "lib", "dashboard.js");
const PHONE = "+14155550123";

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

async function withStatsRoute(run) {
    const originalNow = Date.now;
    const originalLoad = Module._load;
    let now = originalNow();
    let reviewCalls = 0;
    let reviewGate = null;
    let adminPhones = [];
    let queuePaused = true;
    const routes = new Map();
    const middlewares = [];
    const router = { use(middleware) { if (middleware.length >= 3) middlewares.push(middleware); } };
    for (const method of ["get", "post", "delete"]) {
        router[method] = (routePath, handler) => { routes.set(`${method} ${routePath}`, handler); };
    }
    const dirs = Object.fromEntries(["pending", "generating", "ready", "printing", "review", "done", "failed"]
        .map((name) => [name, `/synthetic/${name}`]));
    const config = Object.fromEntries(Object.entries(dirs)
        .map(([name, dir]) => [`${name.toUpperCase()}_DIR`, dir]));
    const job = {
        filePrefix: "synthetic-job", eventName: "event-a", userPhone: PHONE,
        style: "cartoon", createdAt: now - 1000, completedAt: now - 500,
    };
    const fakeFs = { promises: {
        async readdir(dir) { return dir === dirs.done ? ["synthetic-job.json"] : []; },
        async readFile(file) {
            assert.equal(file, path.join(dirs.done, "synthetic-job.json"));
            return JSON.stringify(job);
        },
    } };
    const settings = {
        get(key) {
            if (key === "eventName") return "event-a";
            if (key === "adminPhones") return adminPhones;
            if (key === "queuePaused") return queuePaused;
            return null;
        },
        resetUser() {},
        reset() { queuePaused = false; },
        getBrowserSettings() { return { queuePaused }; },
    };
    const queue = {
        getPrinterBusyState() { return {}; },
        async getReviewQueue() {
            reviewCalls++;
            if (reviewGate) await reviewGate;
            return Array.from({ length: reviewCalls }, (_, index) => ({ filename: `review-${index}.json` }));
        },
        getAllUsers() { return new Map([[PHONE, 1]]); },
        async toggleAdmin(phone) {
            assert.equal(phone, PHONE);
            adminPhones = [phone];
            return true;
        },
    };
    const stubbed = {
        fs: fakeFs,
        child_process: { exec(_command, callback) { callback(new Error("No local printer"), ""); } },
        express: { Router: () => router, json: () => () => {} },
        pdfkit: class {},
        sharp: () => {},
        qrcode: { toString: async () => "" },
        "./config": config,
        "./settings": settings,
        "./voice/readiness": { readinessIssues: () => [] },
        "./queue": queue,
        "./pipeline": { jobPaths: () => ({}) },
        "./audit": {},
        "./leads": {},
        "./contacts": {},
        "./kiosk-submissions": {},
        "./nps": { getStats: () => ({ average: 0, count: 0, distribution: {} }) },
        "./auth": { userBarSnippet: () => "", magicHatSnippet: () => "" },
        "./print-relay": { getRelayPrinters: () => [] },
        "./dub": { getAnalytics: async () => null },
        "./share-clicks": { getStats: () => null },
        "./relay-jobs": { shapeActiveJob: () => ({}) },
        "./openai-models": { loadOpenAIModelCatalog: async () => [] },
        "./event-summary": { getEventSummary: () => ({}) },
        "./dashboard-page": { renderDashboardPage: () => "" },
        "./logs-page": { renderLogsPage: () => "" },
    };
    Date.now = () => now;
    try {
        Module._load = function(request, parent, isMain) {
            if (parent?.filename === DASHBOARD_PATH && Object.hasOwn(stubbed, request)) {
                return stubbed[request];
            }
            return originalLoad.call(this, request, parent, isMain);
        };
        delete require.cache[DASHBOARD_PATH];
        require(DASHBOARD_PATH);
        Module._load = originalLoad;

        async function call(method, routePath, { query = {}, body = {} } = {}) {
            const handler = routes.get(`${method} ${routePath}`);
            assert.ok(handler, `${method} ${routePath} is registered`);
            let sent;
            const finishListeners = [];
            const response = {
                statusCode: 200,
                status(code) { this.statusCode = code; return this; },
                set() { return this; },
                once(event, listener) { if (event === "finish") finishListeners.push(listener); return this; },
                json(payload) { sent = payload; finishListeners.forEach((listener) => listener()); return this; },
            };
            const request = { query, body, path: routePath, method: method.toUpperCase(),
                user: { email: "synthetic@example.test" } };
            for (const middleware of middlewares) middleware(request, response, () => {});
            await handler(request, response);
            assert.equal(response.statusCode, 200);
            return sent;
        }
        await run({
            stats: (event = "event-a") => call("get", "/api/stats", { query: { e: event, scope: "overview" } }),
            toggleAdmin: () => call("post", "/api/dashboard-users/toggle-admin", {
                body: { id: 1654911835, event: "event-a" },
            }),
            resetSettings: () => call("post", "/api/settings/reset-all", {
                body: { _forEvent: "event-a" },
            }),
            clock: () => now,
            setClock: (value) => { now = value; },
            setReviewGate: (promise) => { reviewGate = promise; },
            reviewCalls: () => reviewCalls,
        });
    } finally {
        Module._load = originalLoad;
        Date.now = originalNow;
        delete require.cache[DASHBOARD_PATH];
    }
}

test("12-second stats polls reuse a response for multiple cycles and concurrent refreshes coalesce", async () => {
    await withStatsRoute(async ({ stats, clock, setClock, setReviewGate, reviewCalls }) => {
        const start = clock();
        const first = await stats();
        assert.deepEqual(first.totals, { done: 1, failed: 0 });
        assert.equal(first.queue.review, 1);
        assert.equal(reviewCalls(), 1);

        setClock(start + 12_000);
        assert.equal((await stats()).queue.review, 1);
        setClock(start + 24_000);
        assert.equal((await stats()).queue.review, 1);
        assert.equal(reviewCalls(), 1, "two scheduled polls should use the completed snapshot");

        setClock(start + 30_000);
        const heldReview = deferred();
        setReviewGate(heldReview.promise);
        const firstRefresh = stats();
        const secondRefresh = stats();
        await Promise.resolve();
        assert.equal(reviewCalls(), 2, "simultaneous misses should start one scan");
        setClock(start + 75_000);
        heldReview.resolve();
        const [refreshedA, refreshedB] = await Promise.all([firstRefresh, secondRefresh]);
        assert.equal(refreshedA.queue.review, 2);
        assert.equal(refreshedB.queue.review, 2);

        setClock(start + 87_000);
        assert.equal((await stats()).queue.review, 2, "TTL should begin when the refresh completes");
        assert.equal(reviewCalls(), 2);
        setClock(start + 105_000);
        assert.equal((await stats()).queue.review, 3);
        assert.equal(reviewCalls(), 3, "a completed snapshot must eventually refresh");
    });
});

test("switching event filters preserves each event's recent stats response", async () => {
    await withStatsRoute(async ({ stats, reviewCalls }) => {
        const eventA = await stats("event-a");
        const eventB = await stats("event-b");
        assert.deepEqual(eventA.totals, { done: 1, failed: 0 });
        assert.deepEqual(eventB.totals, { done: 0, failed: 0 });
        assert.equal(eventA.queue.review, 1);
        assert.equal(eventB.queue.review, 2);
        assert.equal((await stats("event-a")).queue.review, 1);
        assert.equal(reviewCalls(), 2);
    });
});

test("an admin change invalidates a stats build already in flight", async () => {
    await withStatsRoute(async ({ stats, toggleAdmin, setReviewGate, reviewCalls }) => {
        const heldReview = deferred();
        setReviewGate(heldReview.promise);
        const staleRequest = stats();
        await Promise.resolve();
        assert.equal(reviewCalls(), 1);
        await toggleAdmin();
        heldReview.resolve();
        await staleRequest;

        const fresh = await stats();
        assert.deepEqual(fresh.totals, { done: 0, failed: 0 });
        assert.equal(fresh.queue.review, 2);
        assert.equal(reviewCalls(), 2, "the invalidated in-flight build must not fill the cache");
    });
});

test("settings reset invalidates cached operational state immediately", async () => {
    await withStatsRoute(async ({ stats, resetSettings, reviewCalls }) => {
        assert.equal((await stats()).queuePaused, true);
        assert.equal(reviewCalls(), 1);
        await resetSettings();
        assert.equal((await stats()).queuePaused, false);
        assert.equal(reviewCalls(), 2, "the reset must bypass the 30-second stats snapshot");
    });
});

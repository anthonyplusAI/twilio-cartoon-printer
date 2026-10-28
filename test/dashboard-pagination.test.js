const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const express = require("express");

const DASHBOARD_PATH = path.join(__dirname, "..", "lib", "dashboard.js");

async function withDashboardFixture(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-pages-"));
    const names = ["pending", "generating", "ready", "printing", "review", "done", "failed"];
    const dirs = Object.fromEntries(names.map((name) => [name, path.join(root, name)]));
    for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, "output"));
    const filePrefix = (number) => `20261028_${String(number).padStart(6, "0")}`;
    for (let i = 0; i < 145; i++) {
        const prefix = filePrefix(i);
        fs.writeFileSync(path.join(dirs.done, `${prefix}.json`), JSON.stringify({
            filePrefix: prefix, eventName: i < 120 ? "event-a" : "event-b",
            userPhone: "+14155550123", style: "cartoon", completedAt: i + 1,
        }));
    }
    for (let i = 0; i < 112; i++) {
        const prefix = filePrefix(i + 200);
        fs.writeFileSync(path.join(dirs.failed, `${prefix}.json`), JSON.stringify({
            filePrefix: prefix, eventName: "event-a", userPhone: "+14155550123",
            style: "cartoon", failReason: "generation", createdAt: i + 1,
        }));
    }
    for (let i = 0; i < 110; i++) {
        const prefix = filePrefix(i + 400);
        fs.writeFileSync(path.join(dirs.ready, `${prefix}.json`), JSON.stringify({
            filePrefix: prefix, eventName: "event-a", userPhone: "+14155550123",
            style: "cartoon", readyAt: i + 1, stateChangedAt: i + 1,
            failedPrinters: i === 109 ? ["offline-printer"] : [],
        }));
    }

    const userMap = new Map(Array.from({ length: 240 }, (_, i) =>
        [`+1415${String(1000000 + i)}`, i % 7]));
    const settings = {
        get(key) { return key === "eventName" ? "event-a" : key === "adminPhones" ? [] : null; },
        getForEvent(key) { return key === "maxPrints" ? 7 : key === "adminPhones" ? [] : null; },
        getDownloadDir(event) { return path.join(root, "downloads", event); },
        listEvents() { return ["event-a", "event-b"]; },
        listEventProfiles() { return ["event-a"]; },
    };
    const config = {
        PENDING_DIR: dirs.pending, GENERATING_DIR: dirs.generating,
        READY_DIR: dirs.ready, PRINTING_DIR: dirs.printing, REVIEW_DIR: dirs.review,
        DONE_DIR: dirs.done, FAILED_DIR: dirs.failed,
    };
    const reviewJobs = Array.from({ length: 31 }, (_, index) => ({
        filename: `review-${index}.json`, eventName: "event-a", reviewAt: index + 1,
    }));
    const queue = {
        getAllUsers() { return userMap; },
        async getReviewQueue(eventFilter) { return eventFilter === "all" || eventFilter === "event-a" ? reviewJobs : []; },
    };
    const pipeline = { jobPaths(job) { return { outputPath: path.join(root, "output", `${job.filePrefix}.png`) }; } };
    const leads = { getLeadName() { return null; }, isCompleted() { return false; } };
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (parent && parent.filename === DASHBOARD_PATH) {
            if (request === "./config") return config;
            if (request === "./settings") return settings;
            if (request === "./queue") return queue;
            if (request === "./pipeline") return pipeline;
            if (request === "./leads") return leads;
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    let mountDashboard;
    try {
        delete require.cache[require.resolve(DASHBOARD_PATH)];
        ({ mountDashboard } = require(DASHBOARD_PATH));
    } finally {
        Module._load = originalLoad;
    }
    const app = express();
    mountDashboard(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        await run({ base, root, reviewJobs });
    } finally {
        await new Promise((resolve) => server.close(resolve));
        delete require.cache[require.resolve(DASHBOARD_PATH)];
        fs.rmSync(root, { recursive: true, force: true });
    }
}

test("dashboard historical job endpoints page before checking image files", async () => {
    await withDashboardFixture(async ({ base }) => {
        const originalAccess = fs.promises.access;
        let checks = 0;
        fs.promises.access = async (...args) => { checks++; return originalAccess(...args); };
        try {
            const done = await fetch(`${base}/dashboard/api/done-jobs?e=event-a&limit=25&offset=0`);
            const doneRows = await done.json();
            assert.equal(done.status, 200);
            assert.equal(doneRows.length, 25);
            assert.equal(Number(done.headers.get("x-total-count")), 120);
            assert.equal(doneRows[0].completedAt, 120);
            assert.equal(checks, 25, "only returned done rows need image checks");

            checks = 0;
            const failed = await fetch(`${base}/dashboard/api/failed-jobs?e=event-a&offset=25&limit=10`);
            const failedRows = await failed.json();
            assert.equal(failedRows.length, 10);
            assert.equal(Number(failed.headers.get("x-total-count")), 112);
            assert.equal(failedRows[0].createdAt, 87);
            assert.equal(checks, 20, "only returned failed rows need two image checks");
        } finally {
            fs.promises.access = originalAccess;
        }
    });
});

test("dashboard active jobs and people have bounded pages with totals", async () => {
    await withDashboardFixture(async ({ base }) => {
        const active = await fetch(`${base}/dashboard/api/active-jobs?e=event-a&limit=50&offset=0`);
        const activeRows = await active.json();
        assert.equal(activeRows.length, 50);
        assert.equal(Number(active.headers.get("x-total-count")), 110);

        const people = await fetch(`${base}/dashboard/api/dashboard-users?e=event-a&limit=999`);
        const result = await people.json();
        assert.equal(result.users.length, 100, "requested page size is capped");
        assert.equal(result.total, 240);
        assert.equal(result.hasMore, true);
        assert.ok(result.users.every((user) => !/^\+\d{7,}$/.test(user.phone)));

        const events = await fetch(`${base}/dashboard/api/settings/events`);
        assert.equal(events.headers.get("cache-control"), "private, no-store");
        assert.deepEqual(await events.json(), { events: ["event-a", "event-b"], eventProfiles: ["event-a"] });
    });
});

test("combined Jobs pages stay globally ordered and shape only visible rows", async () => {
    await withDashboardFixture(async ({ base }) => {
        const originalAccess = fs.promises.access;
        let checks = 0;
        fs.promises.access = async (...args) => { checks++; return originalAccess(...args); };
        try {
            const firstResponse = await fetch(`${base}/dashboard/api/jobs?e=event-a&filter=all&offset=0&limit=25`);
            assert.equal(firstResponse.status, 200);
            const first = await firstResponse.json();
            assert.deepEqual(first.counts, { active: 110, failed: 112, done: 120 });
            assert.equal(first.total, 342);
            assert.equal(first.jobs.length, 25);
            assert.equal(first.hasMore, true);
            assert.ok(first.jobs.every((item, index) => index === 0 || first.jobs[index - 1].ts >= item.ts));
            assert.ok(checks <= 50, "file-existence checks should be limited to the visible page");

            const second = await fetch(`${base}/dashboard/api/jobs?e=event-a&filter=all&offset=25&limit=25`)
                .then((response) => response.json());
            assert.equal(second.jobs.length, 25);
            assert.ok(first.jobs.at(-1).ts >= second.jobs[0].ts, "next page follows the same global order");
            const identities = [...first.jobs, ...second.jobs].map((item) => `${item.type}:${item.data.filename}`);
            assert.equal(new Set(identities).size, identities.length, "page boundaries do not duplicate jobs");

            const failed = await fetch(`${base}/dashboard/api/jobs?e=event-a&filter=failed&offset=100&limit=25`)
                .then((response) => response.json());
            assert.equal(failed.total, 112);
            assert.equal(failed.jobs.length, 12);
            assert.ok(failed.jobs.every((item) => item.type === "failed"));
            assert.equal(failed.hasMore, false);
            const invalid = await fetch(`${base}/dashboard/api/jobs?filter=unknown`);
            assert.equal(invalid.status, 400);
        } finally {
            fs.promises.access = originalAccess;
        }
    });
});

test("legacy Dashboard list URLs stay unpaged without pagination parameters", async () => {
    await withDashboardFixture(async ({ base }) => {
        const done = await fetch(`${base}/dashboard/api/done-jobs?e=event-a`);
        assert.equal((await done.json()).length, 120);
        assert.equal(done.headers.get("x-total-count"), null);

        const failed = await fetch(`${base}/dashboard/api/failed-jobs?e=event-a`);
        assert.equal((await failed.json()).length, 112);
        assert.equal(failed.headers.get("x-total-count"), null);

        const active = await fetch(`${base}/dashboard/api/active-jobs?e=event-a`);
        assert.equal((await active.json()).length, 110);
        assert.equal(active.headers.get("x-total-count"), null);

        const people = await fetch(`${base}/dashboard/api/dashboard-users?e=event-a`);
        const result = await people.json();
        assert.deepEqual(Object.keys(result), ["users"]);
        assert.equal(result.users.length, 240);
    });
});

test("Dashboard review preview is bounded with an accurate count and legacy response", async () => {
    await withDashboardFixture(async ({ base, reviewJobs }) => {
        const preview = await fetch(`${base}/dashboard/api/review-queue?e=event-a&limit=12`);
        const previewJobs = await preview.json();
        assert.equal(previewJobs.length, 12);
        assert.equal(preview.headers.get("x-total-count"), String(reviewJobs.length));
        assert.equal(previewJobs[0].filename, reviewJobs[0].filename);

        const legacy = await fetch(`${base}/dashboard/api/review-queue?e=event-a`);
        assert.deepEqual(await legacy.json(), reviewJobs);
    });
});

test("style previews reuse a recent lookup for the same event and style", async () => {
    await withDashboardFixture(async ({ base, root }) => {
        const eventOutput = path.join(root, "downloads", "event-a");
        fs.mkdirSync(eventOutput, { recursive: true });
        fs.writeFileSync(path.join(eventOutput, "20261028_000119_output.png"), "synthetic image");
        const originalAccess = fs.promises.access;
        let checks = 0;
        fs.promises.access = async (...args) => { checks++; return originalAccess(...args); };
        try {
            const url = `${base}/dashboard/api/style-preview?e=event-a&style=cartoon`;
            const first = await fetch(url).then((response) => response.json());
            const second = await fetch(url).then((response) => response.json());
            assert.deepEqual(first, { image: "/photogallery/img/event-a/20261028_000119_output.png" });
            assert.deepEqual(second, first);
            assert.equal(checks, 1, "the recent preview result should avoid a second file check");
        } finally {
            fs.promises.access = originalAccess;
        }
    });
});

test("a completed job action refreshes the active snapshot", async () => {
    await withDashboardFixture(async ({ base }) => {
        const endpoint = `${base}/dashboard/api/active-jobs?e=event-a`;
        const before = await fetch(endpoint).then((response) => response.json());
        assert.deepEqual(before[0].failedPrinters, ["offline-printer"]);

        const release = await fetch(`${base}/dashboard/api/release-ready-job`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: before[0].filename }),
        });
        assert.equal(release.status, 200);
        const after = await fetch(endpoint).then((response) => response.json());
        assert.deepEqual(after[0].failedPrinters, [], "the next list request must see the released job");
    });
});

test("logs API bounds initial history and SSE replays missed entries by ID", async () => {
    await withDashboardFixture(async ({ base }) => {
        const logPath = require.resolve("../lib/log-buffer");
        const previous = require.cache[logPath];
        const entries = Array.from({ length: 30 }, (_, index) => ({
            id: index + 1, ts: index + 1, level: "info", category: "app", message: `synthetic-${index + 1}`,
        }));
        const fake = new Module(logPath);
        fake.loaded = true;
        fake.exports = { getEntries() { return entries; }, subscribe() {}, unsubscribe() {} };
        require.cache[logPath] = fake;
        try {
            const history = await fetch(`${base}/dashboard/api/logs?limit=10`).then((response) => response.json());
            assert.equal(history.length, 10);
            assert.equal(history[0].id, 21);

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            try {
                const response = await fetch(`${base}/dashboard/api/logs/stream?since=27`, { signal: controller.signal });
                assert.equal(response.headers.get("content-type"), "text/event-stream");
                const reader = response.body.getReader();
                let streamText = "";
                while (!streamText.includes("id: 30")) {
                    const chunk = await reader.read();
                    assert.equal(chunk.done, false);
                    streamText += new TextDecoder().decode(chunk.value);
                }
                assert.match(streamText, /id: 28\ndata: /);
                assert.doesNotMatch(streamText, /id: 27\ndata: /);
            } finally {
                clearTimeout(timeout);
                controller.abort();
            }
        } finally {
            if (previous) require.cache[logPath] = previous;
            else delete require.cache[logPath];
        }
    });
});

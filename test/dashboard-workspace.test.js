const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { renderDashboardPage } = require("../lib/dashboard-page");

function makeElement() {
    const attributes = new Map();
    const classes = new Set();
    return {
        hidden: false, focused: false,
        setAttribute(name, value) { attributes.set(name, value); },
        removeAttribute(name) { attributes.delete(name); },
        getAttribute(name) { return attributes.get(name); },
        focus() { this.focused = true; },
        classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains(name) { return classes.has(name); } },
    };
}

function dashboardClient(fetchHandler) {
    const html = renderDashboardPage();
    const script = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1]).filter(Boolean)[1];
    const views = ["jobs", "people", "insights", "activity"];
    const tabs = Object.fromEntries(views.map((view) => [view, makeElement()]));
    const panels = Object.fromEntries(views.map((view) => [view, makeElement()]));
    const nodes = new Map();
    const document = {
        hidden: true,
        body: { addEventListener() {} },
        querySelector(selector) {
            if (selector === ".workspace-tabs") return { addEventListener() {} };
            const match = selector.match(/data-workspace-tab="([^"]+)"/);
            return match ? tabs[match[1]] : null;
        },
        getElementById(id) {
            const view = id.replace(/^panel/, "").toLowerCase();
            if (panels[view]) return panels[view];
            if (!nodes.has(id)) nodes.set(id, makeElement());
            return nodes.get(id);
        },
        addEventListener() {},
    };
    const window = { location: { search: "", href: "http://localhost/dashboard/" }, history: { replaceState() {} } };
    const context = vm.createContext({ document, window, URLSearchParams, URL, AbortController,
        setInterval() {}, console, fetch: fetchHandler });
    vm.runInContext(script, context);
    vm.runInContext('firstLoad = false; selectedEvent = "event-a"; renderJobs = function() {}; renderDashboardUsers = function() {};', context);
    return context;
}

test("Dashboard renderer provides parseable scripts and keyboard accessible tab panels", () => {
    const html = renderDashboardPage();
    const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)]
        .map((match) => match[1]).filter(Boolean);
    assert.equal(scripts.length, 2);
    scripts.forEach((script, index) => new vm.Script(script, { filename: `dashboard-script-${index}` }));
    assert.match(html, /href="\/assets\/dashboard-workspace\.css"/);

    const views = ["jobs", "people", "insights", "activity"];
    const tabs = Object.fromEntries(views.map((view) => [view, makeElement()]));
    const panels = Object.fromEntries(views.map((view) => [view, makeElement()]));
    let onKeydown;
    const document = {
        hidden: true,
        body: { addEventListener() {} },
        querySelector(selector) {
            if (selector === ".workspace-tabs") return { addEventListener(_name, handler) { onKeydown = handler; } };
            const match = selector.match(/data-workspace-tab="([^"]+)"/);
            return match ? tabs[match[1]] : null;
        },
        getElementById(id) {
            const view = id.replace(/^panel/, "").toLowerCase();
            return panels[view] || null;
        },
        addEventListener() {},
    };
    const window = { location: { search: "", href: "http://localhost/dashboard/" }, history: { replaceState() {} } };
    const context = vm.createContext({ document, window, URLSearchParams, URL, setInterval() {}, console, fetch() { throw new Error("No network while hidden"); } });
    vm.runInContext(scripts[1], context);
    assert.equal(tabs.jobs.getAttribute("aria-selected"), "true");
    assert.equal(panels.people.hidden, true);

    onKeydown({ key: "ArrowRight", preventDefault() {} });
    assert.equal(tabs.people.getAttribute("aria-selected"), "true");
    assert.equal(tabs.people.getAttribute("tabindex"), "0");
    assert.equal(tabs.jobs.getAttribute("tabindex"), "-1");
    assert.equal(panels.jobs.hidden, true);
    assert.equal(panels.people.hidden, false);
    assert.equal(tabs.people.focused, true);
});

test("Jobs pagination requests one page and keeps only its rows", async () => {
    const doneJobs = Array.from({ length: 53 }, (_, index) => ({
        type: "done", ts: 53 - index, data: { filename: `job-${index + 1}.json` },
    }));
    const offsets = [];
    const context = dashboardClient(async (url) => {
        const parsed = new URL(url, "http://localhost/dashboard/");
        const offset = Number(parsed.searchParams.get("offset"));
        const limit = Number(parsed.searchParams.get("limit"));
        assert.equal(parsed.pathname, "/dashboard/api/jobs");
        offsets.push(offset);
        const jobs = doneJobs.slice(offset, offset + limit);
        return { ok: true, json: async () => ({ jobs, total: doneJobs.length,
            counts: { active: 0, failed: 0, done: doneJobs.length }, offset, limit,
            hasMore: offset + jobs.length < doneJobs.length }) };
    });
    vm.runInContext('_jobFilter = "done"', context);
    await vm.runInContext('fetchJobs()', context);
    assert.equal(vm.runInContext('_jobItems.length', context), 25);
    assert.equal(vm.runInContext('document.getElementById("jobsNext").disabled', context), false);
    await vm.runInContext('fetchJobs({ page: 1 })', context);
    assert.equal(vm.runInContext('_jobItems.length', context), 25);
    assert.equal(vm.runInContext('_jobBrowsingHistory', context), true);
    await vm.runInContext('fetchJobs({ page: 2 })', context);
    assert.deepEqual(offsets, [0, 25, 50]);
    assert.equal(vm.runInContext('_jobItems.length', context), 3);
    assert.equal(vm.runInContext('document.getElementById("jobsPageLabel").textContent', context), "Page 3 of 3");
    assert.equal(vm.runInContext('document.getElementById("jobsNext").disabled', context), true);
    await vm.runInContext('refreshLatestJobs()', context);
    assert.equal(vm.runInContext('_jobPage', context), 0);
    assert.equal(vm.runInContext('_jobBrowsingHistory', context), false);
});

test("People uses 25 rows per page like Jobs and clamps after a shrink", async () => {
    const people = Array.from({ length: 53 }, (_, index) => ({ id: index + 1 }));
    const offsets = [];
    const context = dashboardClient(async (url) => {
        const parsed = new URL(url, "http://localhost/dashboard/");
        const offset = Number(parsed.searchParams.get("offset"));
        const limit = Number(parsed.searchParams.get("limit"));
        offsets.push(offset);
        const users = people.slice(offset, offset + limit);
        return { ok: true, json: async () => ({ users, total: people.length,
            hasMore: offset + users.length < people.length }) };
    });
    await vm.runInContext('fetchDashboardUsers()', context);
    assert.equal(vm.runInContext('_peopleRows.length', context), 25);
    await vm.runInContext('fetchDashboardUsers({ page: 1 })', context);
    assert.equal(vm.runInContext('_peopleRows.length', context), 25);
    await vm.runInContext('fetchDashboardUsers({ page: 2 })', context);
    assert.equal(vm.runInContext('_peopleRows.length', context), 3);
    assert.equal(vm.runInContext('document.getElementById("peoplePageLabel").textContent', context), "Page 3 of 3");
    assert.equal(vm.runInContext('document.getElementById("peopleNext").disabled', context), true);
    people.splice(20);
    await vm.runInContext('fetchDashboardUsers({ page: 2 })', context);
    assert.deepEqual(offsets, [0, 25, 50, 50, 0]);
    assert.equal(vm.runInContext('_peoplePage', context), 0);
    assert.equal(vm.runInContext('_peopleRows.length', context), 20);
});

test("live polling does not interrupt a requested Jobs or People page", async () => {
    const requests = [];
    const pending = [];
    const context = dashboardClient((url) => {
        const parsed = new URL(url, "http://localhost/dashboard/");
        const path = parsed.pathname;
        const offset = Number(parsed.searchParams.get("offset"));
        requests.push(`${path}:${offset}`);
        if (offset > 0) return new Promise((resolve) => pending.push({ path, resolve }));
        if (path.endsWith("/jobs")) return Promise.resolve({ ok: true, json: async () => ({
            jobs: Array.from({ length: 25 }, (_, index) => ({ type: "done", ts: index,
                data: { filename: `job-${index}.json` } })),
            total: 50, counts: { active: 0, failed: 0, done: 50 },
        }) });
        return Promise.resolve({ ok: true, json: async () => ({
            users: Array.from({ length: 25 }, (_, index) => ({ id: index })), total: 80,
        }) });
    });

    await vm.runInContext("fetchJobs()", context);
    vm.runInContext("document.hidden = false", context);
    const jobsNext = vm.runInContext("changeJobsPage(1)", context);
    vm.runInContext('scheduleDashboardPoll("jobs", true)', context);
    assert.deepEqual(requests, ["/dashboard/api/jobs:0", "/dashboard/api/jobs:25"]);
    pending.shift().resolve({ ok: true, json: async () => ({
        jobs: [{ type: "done", ts: 1, data: { filename: "page-2.json" } }],
        total: 50, counts: { active: 0, failed: 0, done: 50 },
    }) });
    await jobsNext;
    assert.equal(vm.runInContext("_jobPage", context), 1);

    vm.runInContext('activeWorkspace = "people"', context);
    await vm.runInContext("fetchDashboardUsers()", context);
    const peopleNext = vm.runInContext("changePeoplePage(1)", context);
    vm.runInContext('scheduleDashboardPoll("people", true)', context);
    assert.deepEqual(requests.slice(-2), ["/dashboard/api/dashboard-users:0", "/dashboard/api/dashboard-users:25"]);
    pending.shift().resolve({ ok: true, json: async () => ({
        users: [{ id: 41 }], total: 80,
    }) });
    await peopleNext;
    assert.equal(vm.runInContext("_peoplePage", context), 1);
});

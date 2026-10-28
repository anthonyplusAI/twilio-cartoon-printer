const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const express = require("express");

const PROJECT_ROOT = path.join(__dirname, "..");
const DASHBOARD_PATH = path.join(PROJECT_ROOT, "lib", "dashboard.js");

async function withTestEnv(values, run) {
    const previous = new Map();
    for (const [key, value] of Object.entries(values)) {
        previous.set(key, process.env[key]);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    try { return await run(); } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

async function withDashboardFixture(run, options = {}) {
    return withTestEnv({
        EVENT_NAME: "unit",
        ADMIN_PHONES: "",
        OPENAI_API_KEY: "synthetic-env-openai-ABCD",
        DUB_API_KEY: options.envDubKey,
        TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
        TWILIO_AUTH_TOKEN: "synthetic-env-twilio",
        PRINT_RELAY_KEY: "synthetic-env-relay",
        SESSION_SECRET: "synthetic-test-session-secret-32-chars",
    }, async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-settings-security-"));
        fs.mkdirSync(path.join(root, "lib"), { recursive: true });
        fs.mkdirSync(path.join(root, "data", "events", "unit"), { recursive: true });
        fs.mkdirSync(path.join(root, "templates"), { recursive: true });
        for (const file of ["settings.js", "audit.js"]) {
            fs.copyFileSync(path.join(PROJECT_ROOT, "lib", file), path.join(root, "lib", file));
        }
        fs.symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
        const settingsFile = path.join(root, "data", "settings.json");
        const auditFile = path.join(root, "data", "audit-log.jsonl");
        fs.writeFileSync(settingsFile, JSON.stringify({
            eventName: "unit",
            dubApiKey: "synthetic-saved-dub",
            openaiApiKey: "synthetic-saved-openai",
            twilioAuthToken: "synthetic-saved-twilio",
            printRelayKey: "synthetic-saved-relay",
        }));
        fs.writeFileSync(path.join(root, "data", "events", "unit", "settings.json"), JSON.stringify({
            maxPrints: 4,
            reviewPin: "2468",
            adminPhones: ["+14155550111"],
        }));
        const settings = require(path.join(root, "lib", "settings.js"));
        settings.load();
        const audit = require(path.join(root, "lib", "audit.js"));

        const originalLoad = Module._load;
        Module._load = function(request, parent, isMain) {
            if (parent && parent.filename.startsWith(path.join(PROJECT_ROOT, "lib") + path.sep)) {
                if (request === "./settings") return settings;
                if (request === "./audit") return audit;
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
        app.use((req, _res, next) => {
            req.user = { email: "operator@example.com" };
            next();
        });
        mountDashboard(app);
        const server = app.listen(0, "127.0.0.1");
        await new Promise((resolve) => server.once("listening", resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const request = async (method, route, body) => {
            const response = await fetch(baseUrl + route, {
                method,
                headers: body === undefined ? {} : { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            return { status: response.status, cacheControl: response.headers.get("cache-control"), body: await response.json() };
        };
        try {
            return await run({ request, settings, settingsFile, auditFile });
        } finally {
            await new Promise((resolve) => server.close(resolve));
            delete require.cache[require.resolve(DASHBOARD_PATH)];
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
}

test("all dashboard settings responses omit raw credentials and disable caching", async () => {
    await withDashboardFixture(async ({ request }) => {
        const calls = [
            ["GET", "/dashboard/api/settings"],
            ["GET", "/dashboard/api/settings/global"],
            ["POST", "/dashboard/api/settings", { maxPrints: 5, _forEvent: "unit" }],
            ["POST", "/dashboard/api/settings/reset", {}],
            ["POST", "/dashboard/api/settings/save-global", {}],
            ["POST", "/dashboard/api/settings/reset-all", { _forEvent: "unit" }],
        ];
        for (const [method, route, body] of calls) {
            const response = await request(method, route, body);
            assert.equal(response.status, 200, route);
            assert.equal(response.cacheControl, "private, no-store", route);
            for (const key of ["openaiApiKey", "twilioAuthToken", "dubApiKey", "printRelayKey", "reviewPin"]) {
                assert.equal(Object.hasOwn(response.body, key), false, `${route} exposed ${key}`);
                assert.equal(typeof response.body.credentialStatus[key].configured, "boolean", route);
            }
            assert.equal(response.body.credentialStatus.openaiApiKey.last4, "ABCD");
            assert.doesNotMatch(JSON.stringify(response.body), /synthetic-|2468/);
            if (route === "/dashboard/api/settings") {
                assert.ok(Array.isArray(response.body.voiceReadinessIssues));
                assert.equal(response.body.voiceReadinessIssues.includes("OpenAI API key is required"), false);
                assert.equal(response.body.voiceReadinessIssues.includes("Twilio credentials are required"), false);
            }
        }
    });
});

test("general settings POST rejects credential fields and invalid admin phones before saving", async () => {
    await withDashboardFixture(async ({ request, settingsFile }) => {
        const before = fs.readFileSync(settingsFile, "utf8");
        for (const key of ["openaiApiKey", "twilioAuthToken", "dubApiKey", "printRelayKey", "reviewPin"]) {
            const response = await request("POST", "/dashboard/api/settings", {
                maxPrints: 8, [key]: "synthetic-injected-value", _forEvent: "unit",
            });
            assert.equal(response.status, 400, key);
            assert.equal(response.cacheControl, "private, no-store");
            assert.doesNotMatch(JSON.stringify(response.body), /synthetic-/);
            assert.equal(fs.readFileSync(settingsFile, "utf8"), before);
        }
        const invalidPhone = await request("POST", "/dashboard/api/settings", {
            adminPhones: ["<img src=x>"], _forEvent: "unit",
        });
        assert.equal(invalidPhone.status, 400);
        assert.equal(fs.readFileSync(settingsFile, "utf8"), before);
        const validPhone = await request("POST", "/dashboard/api/settings", {
            adminPhones: [" +14155550111 ", "+14155550111"], _forEvent: "unit",
        });
        assert.equal(validPhone.status, 200);
        assert.deepEqual(validPhone.body.adminPhones, ["+14155550111"]);
        assert.equal(Object.hasOwn(validPhone.body, "_forEvent"), false);
        assert.doesNotMatch(fs.readFileSync(settingsFile, "utf8"), /_forEvent/);
    });
});

test("ordinary settings saves and resets require the displayed event", async () => {
    await withDashboardFixture(async ({ request, settings, settingsFile }) => {
        const before = fs.readFileSync(settingsFile, "utf8");
        const missingSave = await request("POST", "/dashboard/api/settings", { maxPrints: 9 });
        assert.equal(missingSave.status, 428);
        assert.match(missingSave.body.error, /Reload Settings/);
        const missingReset = await request("POST", "/dashboard/api/settings/reset-all", {});
        assert.equal(missingReset.status, 428);
        assert.equal(settings.get("maxPrints"), 4);
        assert.equal(fs.readFileSync(settingsFile, "utf8"), before);

        // A legacy event picker can still send its single explicit switch.
        const switchResponse = await request("POST", "/dashboard/api/settings", { eventName: "other" });
        assert.equal(switchResponse.status, 200);
        assert.equal(settings.get("eventName"), "other");
    });
});

test("stale Settings tab cannot save or reset another active event", async () => {
    await withDashboardFixture(async ({ request, settings, settingsFile }) => {
        settings.update({ eventName: "other" });
        settings.update({ maxPrints: 6 });
        const otherProfile = path.join(path.dirname(settingsFile), "events", "other", "settings.json");
        const beforeGlobal = fs.readFileSync(settingsFile, "utf8");
        const beforeProfile = fs.readFileSync(otherProfile, "utf8");

        const staleSave = await request("POST", "/dashboard/api/settings", {
            maxPrints: 9, _forEvent: "unit",
        });
        assert.equal(staleSave.status, 409);
        assert.match(staleSave.body.error, /active event changed/);
        assert.equal(staleSave.body.currentEvent, "other");

        const staleSwitch = await request("POST", "/dashboard/api/settings", {
            eventName: "unit", _forEvent: "unit",
        });
        assert.equal(staleSwitch.status, 409);

        const staleReset = await request("POST", "/dashboard/api/settings/reset-all", {
            _forEvent: "unit",
        });
        assert.equal(staleReset.status, 409);
        assert.equal(staleReset.body.currentEvent, "other");

        assert.equal(settings.get("eventName"), "other");
        assert.equal(settings.get("maxPrints"), 6);
        assert.equal(fs.readFileSync(settingsFile, "utf8"), beforeGlobal);
        assert.equal(fs.readFileSync(otherProfile, "utf8"), beforeProfile);
    });
});

test("template save rechecks the event after waiting for a template operation", async () => {
    await withDashboardFixture(async ({ request, settings }) => {
        const templatePath = path.join(settings.TEMPLATES_DIR, "frame.png");
        fs.writeFileSync(templatePath, "frame");
        const originalStat = fs.promises.stat;
        const originalNormalize = settings.normalizeAdminPhones;
        let templateStatReached;
        const statReached = new Promise((resolve) => { templateStatReached = resolve; });
        let releaseTemplateStat;
        const blockedStat = new Promise((resolve) => { releaseTemplateStat = resolve; });
        let saveValidated;
        const validated = new Promise((resolve) => { saveValidated = resolve; });
        fs.promises.stat = async function(file, ...args) {
            if (file === templatePath) {
                templateStatReached();
                await blockedStat;
            }
            return originalStat.call(this, file, ...args);
        };
        settings.normalizeAdminPhones = (phones) => {
            const result = originalNormalize(phones);
            saveValidated();
            return result;
        };

        try {
            const compatibility = request("POST", "/dashboard/api/settings/template/compatibility", {
                filename: "frame.png", compatibility: "both",
            });
            await statReached;
            const pendingSave = request("POST", "/dashboard/api/settings", {
                templateFile: "frame.png",
                adminPhones: ["+14155550111"],
                _forEvent: "unit",
            });
            await validated;
            settings.update({ eventName: "other" });
            settings.update({ maxPrints: 6 });
            const beforeTemplate = settings.get("templateFile");
            const beforeAdmins = settings.get("adminPhones");
            releaseTemplateStat();

            const [compatibilityResponse, staleSave] = await Promise.all([compatibility, pendingSave]);
            assert.equal(compatibilityResponse.status, 200);
            assert.equal(staleSave.status, 409);
            assert.equal(settings.get("eventName"), "other");
            assert.equal(settings.get("maxPrints"), 6);
            assert.equal(settings.get("templateFile"), beforeTemplate);
            assert.deepEqual(settings.get("adminPhones"), beforeAdmins);
        } finally {
            releaseTemplateStat();
            fs.promises.stat = originalStat;
            settings.normalizeAdminPhones = originalNormalize;
        }
    });
});

test("dub key has a separate write-only replacement route with redacted audit", async () => {
    await withDashboardFixture(async ({ request, settings, auditFile }) => {
        const invalid = await request("POST", "/dashboard/api/settings/credentials/dub", { dubApiKey: "" });
        assert.equal(invalid.status, 400);
        const replaced = await request("POST", "/dashboard/api/settings/credentials/dub", {
            dubApiKey: "synthetic-new-dub",
        });
        assert.equal(replaced.status, 200);
        assert.equal(replaced.cacheControl, "private, no-store");
        assert.deepEqual(replaced.body, {
            success: true,
            credentialStatus: { dubApiKey: { configured: true } },
        });
        assert.equal(settings.get("dubApiKey"), "synthetic-new-dub");
        const auditEntries = (await request("GET", "/dashboard/api/audit?type=settings")).body.entries;
        assert.equal(auditEntries[0].after.dubApiKey, "[REDACTED]");
        assert.doesNotMatch(fs.readFileSync(auditFile, "utf8"), /synthetic-/);
    });
});

test("deployment-managed dub key cannot be overwritten from the browser", async () => {
    await withDashboardFixture(async ({ request, settings, settingsFile }) => {
        const before = fs.readFileSync(settingsFile, "utf8");
        const response = await request("POST", "/dashboard/api/settings/credentials/dub", { dubApiKey: "synthetic-browser-dub" });
        assert.equal(response.status, 409);
        assert.equal(response.cacheControl, "private, no-store");
        assert.equal(settings.get("dubApiKey"), "synthetic-env-dub");
        assert.equal(fs.readFileSync(settingsFile, "utf8"), before);
        assert.doesNotMatch(JSON.stringify(response.body), /synthetic-/);
    }, { envDubKey: "synthetic-env-dub" });
});

test("dashboard audit API redacts legacy credentials and blocks secret-only revert", async () => {
    await withDashboardFixture(async ({ request, settings, auditFile }) => {
        fs.writeFileSync(auditFile, JSON.stringify({
            id: "secret-only", action: "settings.update", eventName: "unit", reverted: false,
            before: { dubApiKey: "synthetic-old-dub" },
            after: { dubApiKey: "synthetic-saved-dub" },
        }) + "\n");
        const response = await request("GET", "/dashboard/api/audit?type=settings");
        assert.equal(response.status, 200);
        assert.equal(response.cacheControl, "private, no-store");
        assert.equal(response.body.entries[0].before.dubApiKey, "[REDACTED]");
        assert.equal(response.body.entries[0].canRevert, false);
        const revert = await request("POST", "/dashboard/api/audit/revert/secret-only", {});
        assert.equal(revert.status, 400);
        assert.equal(settings.get("dubApiKey"), "synthetic-saved-dub");
        assert.doesNotMatch(JSON.stringify(response.body), /synthetic-/);
    });
});

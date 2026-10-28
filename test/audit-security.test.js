const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.join(__dirname, "..");

function isolatedAudit(active = {}, profile = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-security-"));
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.mkdirSync(path.join(root, "data", "events", "unit"), { recursive: true });
    fs.mkdirSync(path.join(root, "templates"), { recursive: true });
    for (const file of ["settings.js", "audit.js"]) {
        fs.copyFileSync(path.join(PROJECT_ROOT, "lib", file), path.join(root, "lib", file));
    }
    fs.symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
    fs.writeFileSync(path.join(root, "data", "settings.json"), JSON.stringify({ eventName: "unit", ...active }));
    fs.writeFileSync(path.join(root, "data", "events", "unit", "settings.json"), JSON.stringify(profile));
    const settings = require(path.join(root, "lib", "settings.js"));
    settings.load();
    const audit = require(path.join(root, "lib", "audit.js"));
    return { root, settings, audit, auditFile: path.join(root, "data", "audit-log.jsonl") };
}

test("new audit writes retain field names without credential values", async () => {
    const fixture = isolatedAudit();
    try {
        await fixture.audit.logSettingsChange("operator@example.com", "unit",
            { maxPrints: 2, dubApiKey: "synthetic-old-dub", reviewPin: "1234" },
            { maxPrints: 3, dubApiKey: "synthetic-new-dub", reviewPin: "5678" });
        await fixture.audit.logEvent("settings.extra", "unit", {
            details: { apiKey: "synthetic-nested-key", note: "changed" },
        });
        const stored = fs.readFileSync(fixture.auditFile, "utf8");
        assert.doesNotMatch(stored, /synthetic-|1234|5678/);
        const entries = stored.trim().split("\n").map(JSON.parse);
        assert.equal(entries[0].before.dubApiKey, "[REDACTED]");
        assert.equal(entries[0].after.reviewPin, "[REDACTED]");
        assert.equal(entries[0].after.maxPrints, 3);
        assert.equal(entries[1].details.apiKey, "[REDACTED]");
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("legacy audit reads are redacted without rewriting the source file", async () => {
    const fixture = isolatedAudit();
    try {
        const legacy = {
            id: "legacy-change", action: "settings.update", eventName: "unit", reverted: false,
            before: { openaiApiKey: "synthetic-old-openai", maxPrints: 2 },
            after: { openaiApiKey: "synthetic-new-openai", maxPrints: 3 },
        };
        fs.writeFileSync(fixture.auditFile, JSON.stringify(legacy) + "\n");
        const page = await fixture.audit.getAuditLog(20, 0, "settings");
        assert.equal(page.total, 1);
        assert.equal(page.entries[0].before.openaiApiKey, "[REDACTED]");
        assert.equal(page.entries[0].after.openaiApiKey, "[REDACTED]");
        assert.equal(page.entries[0].before.maxPrints, 2);
        assert.doesNotMatch(JSON.stringify(page), /synthetic-/);
        assert.match(fs.readFileSync(fixture.auditFile, "utf8"), /synthetic-old-openai/);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("reverting a mixed legacy entry restores ordinary settings but never an old key", async () => {
    const fixture = isolatedAudit({ openaiApiKey: "synthetic-current-openai" }, { maxPrints: 4 });
    try {
        fs.writeFileSync(fixture.auditFile, JSON.stringify({
            id: "mixed", action: "settings.update", eventName: "unit", reverted: false,
            before: { openaiApiKey: "synthetic-old-openai", maxPrints: 2 },
            after: { openaiApiKey: "synthetic-current-openai", maxPrints: 4 },
        }) + "\n");
        const result = await fixture.audit.revertEntry("mixed", "operator@example.com");
        assert.equal(result.success, true);
        assert.deepEqual(result.reverted, { maxPrints: 2 });
        assert.equal(fixture.settings.get("maxPrints"), 2);
        assert.equal(fixture.settings.get("openaiApiKey"), "synthetic-current-openai");
        assert.doesNotMatch(JSON.stringify(await fixture.audit.getAuditLog()), /synthetic-/);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("reverting a change from another event leaves both event profiles and the audit log untouched", async () => {
    const fixture = isolatedAudit({}, { maxPrints: 4 });
    try {
        const otherProfile = path.join(fixture.root, "data", "events", "other", "settings.json");
        fs.mkdirSync(path.dirname(otherProfile), { recursive: true });
        fs.writeFileSync(otherProfile, JSON.stringify({ maxPrints: 7 }));
        const originalLog = JSON.stringify({
            id: "other-event-change", action: "settings.update", eventName: "other", reverted: false,
            before: { maxPrints: 2 }, after: { maxPrints: 7 },
        }) + "\n";
        fs.writeFileSync(fixture.auditFile, originalLog);

        await assert.rejects(
            fixture.audit.revertEntry("other-event-change", "operator@example.com"),
            /switch to .*other.* before reverting/i,
        );

        assert.equal(fixture.settings.get("eventName"), "unit");
        assert.equal(fixture.settings.get("maxPrints"), 4);
        assert.equal(JSON.parse(fs.readFileSync(otherProfile, "utf8")).maxPrints, 7);
        assert.equal(fs.readFileSync(fixture.auditFile, "utf8"), originalLog);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("an audit entry containing only a credential cannot be reverted", async () => {
    const fixture = isolatedAudit({ dubApiKey: "synthetic-current-dub" });
    try {
        fs.writeFileSync(fixture.auditFile, JSON.stringify({
            id: "secret-only", action: "settings.update", eventName: "unit", reverted: false,
            before: { dubApiKey: "synthetic-old-dub" },
            after: { dubApiKey: "synthetic-current-dub" },
        }) + "\n");
        await assert.rejects(fixture.audit.revertEntry("secret-only", "operator@example.com"), /no revertible settings/i);
        assert.equal(fixture.settings.get("dubApiKey"), "synthetic-current-dub");
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("explicit offline migration redacts a fixture audit log and is idempotent", async () => {
    const fixture = isolatedAudit();
    try {
        const original = JSON.stringify({
            id: "legacy", action: "settings.update", eventName: "unit",
            before: { twilioAuthToken: "synthetic-old-token", maxPrints: 2 },
            after: { twilioAuthToken: "synthetic-new-token", maxPrints: 3 },
        }) + "\n";
        fs.writeFileSync(fixture.auditFile, original);
        const first = await fixture.audit.migrateLegacyAuditLogFile(fixture.auditFile);
        assert.equal(first.redactedEntries, 1);
        const migrated = fs.readFileSync(fixture.auditFile, "utf8");
        assert.doesNotMatch(migrated, /synthetic-/);
        assert.equal(JSON.parse(migrated).before.maxPrints, 2);
        const second = await fixture.audit.migrateLegacyAuditLogFile(fixture.auditFile);
        assert.equal(second.redactedEntries, 0);
        assert.equal(fs.readFileSync(fixture.auditFile, "utf8"), migrated);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("audit redaction CLI previews before an explicit apply", () => {
    const fixture = isolatedAudit();
    try {
        const original = JSON.stringify({
            id: "legacy", action: "settings.update", eventName: "unit",
            before: { dubApiKey: "synthetic-old-dub" },
            after: { dubApiKey: "synthetic-new-dub" },
        }) + "\n";
        fs.writeFileSync(fixture.auditFile, original);
        const script = path.join(PROJECT_ROOT, "scripts", "redact-audit-log.js");
        const preview = spawnSync(process.execPath, [script, "--file", fixture.auditFile], { encoding: "utf8" });
        assert.equal(preview.status, 0);
        assert.match(preview.stdout, /1 of 1 entries need redaction/);
        assert.equal(fs.readFileSync(fixture.auditFile, "utf8"), original);

        const applied = spawnSync(process.execPath, [script, "--file", fixture.auditFile, "--apply"], { encoding: "utf8" });
        assert.equal(applied.status, 0);
        assert.match(applied.stdout, /redacted 1 of 1 entries/);
        assert.doesNotMatch(fs.readFileSync(fixture.auditFile, "utf8"), /synthetic-/);
    } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
    }
});

test("loading audit helpers for a dry run does not create app data files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "audit-import-"));
    try {
        fs.mkdirSync(path.join(root, "lib"));
        for (const file of ["settings.js", "audit.js"]) {
            fs.copyFileSync(path.join(PROJECT_ROOT, "lib", file), path.join(root, "lib", file));
        }
        fs.symlinkSync(path.join(PROJECT_ROOT, "node_modules"), path.join(root, "node_modules"), "dir");
        const audit = require(path.join(root, "lib", "audit.js"));
        assert.equal(fs.existsSync(path.join(root, "data")), false);
        await audit.logSettingsChange("operator@example.com", "unit", { maxPrints: 2 }, { maxPrints: 3 });
        assert.equal(fs.existsSync(path.join(root, "data", "audit-log.jsonl")), true);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

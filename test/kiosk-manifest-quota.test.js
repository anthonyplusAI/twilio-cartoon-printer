const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { PENDING_DIR } = require("../lib/config");
const { buildUsageCache, getUsageCount } = require("../lib/queue");

const root = path.dirname(PENDING_DIR);
const publicationDir = path.join(root, "kiosk-group-publications");
const decisionDir = path.join(root, "kiosk-parent-decisions");

function keyedPath(dir, id) {
    return path.join(dir, `${crypto.createHash("sha256").update(id).digest("hex")}.json`);
}

test("quota rebuild counts a committed kiosk group before its first sibling is published", async () => {
    const token = crypto.randomBytes(8).toString("hex");
    const eventName = `ManifestQuota-${token}`;
    const userPhone = `api:email:${token}`;
    const requestId = crypto.randomUUID();
    const initialParent = `20261103_123456_${crypto.randomBytes(16).toString("hex")}`;
    const nextParent = `20261103_123457_${crypto.randomBytes(16).toString("hex")}`;
    const initialPath = keyedPath(publicationDir, initialParent);
    const nextPath = keyedPath(publicationDir, nextParent);
    const decisionPath = keyedPath(decisionDir, initialParent);
    const initialJobPath = path.join(PENDING_DIR, `${initialParent}-v1.json`);
    const nextJobPath = path.join(PENDING_DIR, `${nextParent}-v1.json`);
    const job = (parentJobId, index) => ({
        filePrefix: `${parentJobId}-v${index}`, parentJobId,
        variantId: `${parentJobId}-v${index}`, variantIndex: index, variantCount: 2,
        kioskSubmission: true, requestId, kioskUsageId: requestId,
        userPhone, eventName,
    });
    const initialJobs = [job(initialParent, 1), job(initialParent, 2)];
    const nextJobs = [job(nextParent, 1), job(nextParent, 2)];

    try {
        fs.mkdirSync(publicationDir, { recursive: true });
        fs.mkdirSync(decisionDir, { recursive: true });
        fs.mkdirSync(PENDING_DIR, { recursive: true });
        fs.writeFileSync(initialPath, JSON.stringify({
            kind: "initial", groupId: initialParent, requestId, eventName,
            digest: "a".repeat(64), jobs: initialJobs, createdAt: Date.now(),
        }));
        await buildUsageCache();
        assert.equal(getUsageCount(userPhone, eventName), 1,
            "a committed group consumes one quota slot even before v1 exists");

        fs.writeFileSync(initialJobPath, JSON.stringify(initialJobs[0]));
        await buildUsageCache();
        assert.equal(getUsageCount(userPhone, eventName), 1,
            "a published sibling and its manifest count only once");

        // Re-analysis can retire the original review card before the first
        // replacement JSON appears. Its durable decision and marker still
        // represent the same one portrait, including after restart.
        fs.writeFileSync(decisionPath, JSON.stringify({
            action: "reanalyze", parentJobId: initialParent, newParentId: nextParent,
            eventName, jobs: nextJobs, createdAt: Date.now(),
        }));
        fs.writeFileSync(nextPath, JSON.stringify({
            kind: "reanalyze", groupId: nextParent, oldParentId: initialParent,
            jobs: nextJobs, createdAt: Date.now(),
        }));
        await buildUsageCache();
        assert.equal(getUsageCount(userPhone, eventName), 1,
            "the old job and committed replacement still consume one slot");

        fs.rmSync(initialPath);
        fs.rmSync(initialJobPath);
        await buildUsageCache();
        assert.equal(getUsageCount(userPhone, eventName), 1,
            "a committed re-analysis with no replacement jobs keeps the quota slot");

        fs.writeFileSync(nextJobPath, JSON.stringify(nextJobs[0]));
        await buildUsageCache();
        assert.equal(getUsageCount(userPhone, eventName), 1,
            "a re-analysis marker and its first replacement count only once");
    } finally {
        for (const file of [initialPath, nextPath, decisionPath, initialJobPath, nextJobPath]) {
            fs.rmSync(file, { force: true });
        }
        await buildUsageCache();
    }
});

test("a durable rejection is not counted as a kiosk publication", async () => {
    const token = crypto.randomBytes(8).toString("hex");
    const eventName = `RejectedManifestQuota-${token}`;
    const userPhone = `api:email:${token}`;
    const parentJobId = `20261103_123458_${crypto.randomBytes(16).toString("hex")}`;
    const publicationPath = keyedPath(publicationDir, parentJobId);
    const decisionPath = keyedPath(decisionDir, parentJobId);
    try {
        fs.mkdirSync(publicationDir, { recursive: true });
        fs.mkdirSync(decisionDir, { recursive: true });
        fs.writeFileSync(publicationPath, JSON.stringify({
            kind: "initial", groupId: parentJobId, requestId: crypto.randomUUID(), eventName,
            jobs: [{ kioskSubmission: true, userPhone, eventName, filePrefix: `${parentJobId}-v1`,
                parentJobId, variantCount: 2 }],
        }));
        fs.writeFileSync(decisionPath, JSON.stringify({
            action: "reject", parentJobId, userPhone, eventName, createdAt: Date.now(),
        }));
        await buildUsageCache();
        assert.equal(getUsageCount(userPhone, eventName), 0);
    } finally {
        fs.rmSync(publicationPath, { force: true });
        fs.rmSync(decisionPath, { force: true });
        await buildUsageCache();
    }
});

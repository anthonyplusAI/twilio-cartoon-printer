const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const config = require("../lib/config");
const settings = require("../lib/settings");
const pipeline = require("../lib/pipeline");
const QUEUE_PATH = require.resolve("../lib/queue");

function isolatedQueue(existingRoot, pipelineOverrides) {
    const root = existingRoot || fs.mkdtempSync(path.join(os.tmpdir(), "ai-review-recovery-"));
    const dirs = Object.fromEntries([
        ["PENDING_DIR", "pending"], ["GENERATING_DIR", "generating"],
        ["READY_DIR", "ready"], ["PRINTING_DIR", "printing"],
        ["PROCESSING_DIR", "processing"], ["REVIEW_DIR", "review"],
        ["DONE_DIR", "done"], ["FAILED_DIR", "failed"],
    ].map(([key, name]) => [key, path.join(root, name)]));
    Object.values(dirs).forEach((dir) => fs.mkdirSync(dir, { recursive: true }));
    const downloads = path.join(root, "downloads");
    fs.mkdirSync(downloads, { recursive: true });
    const originalLoad = Module._load;
    const originalQueue = require.cache[QUEUE_PATH];
    const originalGetDownloadDir = settings.getDownloadDir;
    settings.getDownloadDir = () => downloads;
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === QUEUE_PATH) {
            if (request === "./config") return { ...config, ...dirs };
            if (request === "./audit") return { logEvent: async () => {} };
            if (request === "./pipeline" && pipelineOverrides) {
                return { ...originalLoad.call(this, request, parent, isMain), ...pipelineOverrides };
            }
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    let queue;
    try {
        delete require.cache[QUEUE_PATH];
        queue = require(QUEUE_PATH);
    } finally {
        Module._load = originalLoad;
    }
    return {
        queue, dirs, downloads, root,
        cleanup({ keepFiles = false } = {}) {
            settings.getDownloadDir = originalGetDownloadDir;
            delete require.cache[QUEUE_PATH];
            if (originalQueue) require.cache[QUEUE_PATH] = originalQueue;
            if (!keepFiles) fs.rmSync(root, { recursive: true, force: true });
        },
    };
}

function kioskVariant(parentId, index, variantStatus, extra = {}) {
    const filePrefix = `${parentId}-v${index}`;
    return {
        filePrefix, parentJobId: parentId, variantId: filePrefix,
        variantIndex: index, variantCount: 2, variantStatus,
        eventName: "AI recovery event", userPhone: "api:email:recovery",
        channel: "email", kioskEmail: "guest@example.test",
        kioskSubmission: true, noDelivery: true, style: "cartoon", locale: "en",
        reviewAt: Date.now(), retries: 0,
        kioskEventSnapshot: {
            style: { name: "Cartoon", prompt: "Cartoon portrait", files: [] },
            referencesPinned: true, brandReferenceFiles: [],
            eventSettings: { reviewMode: "ai", enablePrinting: false, immediateDigitalDelivery: true },
        },
        ...extra,
    };
}

async function waitFor(filePath) {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(filePath) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(fs.existsSync(filePath), `Expected queue transition to ${filePath}`);
}

async function waitForJobField(filePath, key, value) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        try {
            if (JSON.parse(fs.readFileSync(filePath, "utf8"))[key] === value) return;
        } catch { /* the worker may still be moving this file */ }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`Expected ${key}=${value} in ${filePath}`);
}

function humanKioskVariant(parentId, index, extra = {}) {
    return kioskVariant(parentId, index, undefined, {
        reviewAt: undefined,
        kioskDeliveryState: "pending",
        kioskEventSnapshot: {
            style: { name: "Cartoon", prompt: "Cartoon portrait", files: ["reference.png"] },
            referencesPinned: true, brandReferenceFiles: [],
            eventSettings: { reviewMode: "human", enablePrinting: false, immediateDigitalDelivery: true },
        },
        ...extra,
    });
}

function writePrivateKioskSource(downloads, job) {
    const staged = path.join(downloads, ".staging");
    const input = path.join(staged, `${job.filePrefix}_input.jpg`);
    const refs = path.join(staged, `${job.filePrefix}_refs`);
    fs.mkdirSync(path.join(refs, "style"), { recursive: true });
    fs.writeFileSync(input, "private selfie");
    fs.writeFileSync(path.join(refs, "style", "reference.png"), "private reference");
    return { input, refs };
}

function failNextAtomicJobWrite(jobPath) {
    const originalRename = fs.promises.rename;
    let failed = false;
    fs.promises.rename = async (src, dst) => {
        if (!failed && dst === jobPath && path.basename(src).includes(".tmp.")) {
            failed = true;
            const error = new Error("Simulated atomic job write failure");
            error.code = "EIO";
            throw error;
        }
        return originalRename(src, dst);
    };
    return () => { fs.promises.rename = originalRename; };
}

function failNextPendingVariantWrite(pendingDir, variantIndex) {
    const originalRename = fs.renameSync;
    let failed = false;
    fs.renameSync = (src, dst) => {
        if (!failed && path.dirname(dst) === pendingDir
            && path.basename(dst).endsWith(`-v${variantIndex}.json`)
            && path.basename(src).includes(".tmp.")) {
            failed = true;
            const error = new Error("Simulated replacement publication failure");
            error.code = "EIO";
            throw error;
        }
        return originalRename(src, dst);
    };
    return () => { fs.renameSync = originalRename; };
}

test("generation poll recovers an interrupted AI kiosk review after the final sibling failed", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `ai-recover-${process.pid}`;
    const winner = kioskVariant(parentId, 1, "READY", { aiBestOfNDecided: true });
    const failed = kioskVariant(parentId, 2, "FAILED", { failReason: "generation" });
    const winnerFile = `${winner.filePrefix}.json`;
    const failedFile = `${failed.filePrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, winnerFile), JSON.stringify(winner));
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, failedFile), JSON.stringify(failed));
        const staged = path.join(downloads, ".staging");
        fs.mkdirSync(staged);
        fs.writeFileSync(path.join(staged, `${winner.filePrefix}_input.jpg`), "private selfie");
        fs.writeFileSync(path.join(staged, `${winner.filePrefix}_output.png`), "finished portrait");

        await queue.processGenerationQueue();
        await waitFor(path.join(dirs.DONE_DIR, winnerFile));
        assert.equal(fs.existsSync(path.join(dirs.FAILED_DIR, failedFile)), true);
        await waitForJobField(path.join(dirs.FAILED_DIR, failedFile), "kioskResultPrefix", winner.filePrefix);
        assert.equal(fs.existsSync(path.join(downloads, `${winner.filePrefix}_output.png`)), true);
        assert.equal(fs.existsSync(path.join(staged, `${winner.filePrefix}_input.jpg`)), false);
    } finally {
        fixture.cleanup();
    }
});

test("AI review finishes a persisted winner after a crash during sibling supersession", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `ai-mid-pick-${process.pid}`;
    const winnerPrefix = `${parentId}-v2`;
    const loser = kioskVariant(parentId, 1, "SUPERSEDED", { failReason: "superseded" });
    const winner = kioskVariant(parentId, 2, "READY", {
        aiBestOfNDecision: { winnerVariantId: winnerPrefix, reason: "Best portrait" },
    });
    const winnerFile = `${winnerPrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.FAILED_DIR, `${loser.filePrefix}.json`), JSON.stringify(loser));
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, winnerFile), JSON.stringify(winner));
        const staged = path.join(downloads, ".staging");
        fs.mkdirSync(staged);
        fs.writeFileSync(path.join(staged, `${winnerPrefix}_input.jpg`), "private selfie");
        fs.writeFileSync(path.join(staged, `${winnerPrefix}_output.png`), "finished portrait");

        await queue.processGenerationQueue();
        await waitFor(path.join(dirs.DONE_DIR, winnerFile));
        assert.equal(await queue.resolveKioskResultPrefix(loser.filePrefix, loser.eventName), winnerPrefix);
    } finally {
        fixture.cleanup();
    }
});

test("AI review waits while a sibling is still generating", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `ai-incomplete-${process.pid}`;
    const ready = kioskVariant(parentId, 1, "READY");
    const generating = kioskVariant(parentId, 2, undefined);
    const readyFile = `${ready.filePrefix}.json`;
    const generatingFile = `${generating.filePrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, readyFile), JSON.stringify(ready));
        fs.writeFileSync(path.join(dirs.GENERATING_DIR, generatingFile), JSON.stringify(generating));
        const staged = path.join(downloads, ".staging");
        fs.mkdirSync(staged);
        fs.writeFileSync(path.join(staged, `${ready.filePrefix}_input.jpg`), "private selfie");
        fs.writeFileSync(path.join(staged, `${ready.filePrefix}_output.png`), "finished portrait");

        await queue.sweepAiBestOfNGroups();
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, readyFile)), true);
        assert.equal(fs.existsSync(path.join(dirs.GENERATING_DIR, generatingFile)), true);
        assert.equal(fs.existsSync(path.join(dirs.DONE_DIR, readyFile)), false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.REVIEW_DIR, readyFile), "utf8")).aiBestOfNDecision, undefined);
    } finally {
        fixture.cleanup();
    }
});

for (const recoveryMethod of ["recoverStaleJobs", "sweepStaleGenerating"]) {
    test(`${recoveryMethod} lets AI review finish when its last variant exhausts retries`, async () => {
        const fixture = isolatedQueue();
        const { queue, dirs, downloads } = fixture;
        const parentId = `ai-stale-${recoveryMethod}-${process.pid}`;
        const ready = kioskVariant(parentId, 1, "READY");
        const stale = kioskVariant(parentId, 2, undefined, {
            retries: 2, generatingAt: Date.now() - 6 * 60 * 1000,
            stateChangedAt: Date.now() - 6 * 60 * 1000,
        });
        const readyFile = `${ready.filePrefix}.json`;
        const staleFile = `${stale.filePrefix}.json`;
        try {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, readyFile), JSON.stringify(ready));
            fs.writeFileSync(path.join(dirs.GENERATING_DIR, staleFile), JSON.stringify(stale));
            const staged = path.join(downloads, ".staging");
            fs.mkdirSync(staged);
            fs.writeFileSync(path.join(staged, `${ready.filePrefix}_input.jpg`), "private selfie");
            fs.writeFileSync(path.join(staged, `${ready.filePrefix}_output.png`), "finished portrait");

            await queue[recoveryMethod]();
            if (!fs.existsSync(path.join(dirs.DONE_DIR, readyFile))) {
                assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, staleFile)), true,
                    "an exhausted sibling must remain visible to the AI review coordinator");
            }
            await queue.processGenerationQueue();
            await waitFor(path.join(dirs.DONE_DIR, readyFile));
            assert.equal(fs.existsSync(path.join(dirs.FAILED_DIR, staleFile)), true);
            await waitForJobField(path.join(dirs.FAILED_DIR, staleFile), "kioskResultPrefix", ready.filePrefix);
        } finally {
            fixture.cleanup();
        }
    });
}

for (const recoveryMethod of ["recoverStaleJobs", "sweepStaleGenerating"]) {
    test(`${recoveryMethod} preserves a reviewable failed kiosk variant's selfie and references`, async () => {
        const fixture = isolatedQueue();
        const { queue, dirs, downloads } = fixture;
        const parentId = `kiosk-retry-source-${recoveryMethod}-${process.pid}`;
        const job = humanKioskVariant(parentId, 1, {
            retries: 2, generatingAt: Date.now() - 6 * 60 * 1000,
            stateChangedAt: Date.now() - 6 * 60 * 1000,
        });
        const filename = `${job.filePrefix}.json`;
        try {
            fs.writeFileSync(path.join(dirs.GENERATING_DIR, filename), JSON.stringify(job));
            const { input, refs } = writePrivateKioskSource(downloads, job);

            await queue[recoveryMethod]();
            assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, filename)), true);
            assert.equal(fs.existsSync(input), true);
            assert.equal(fs.existsSync(refs), true);

            await queue.regenerateVariant(parentId, job.variantId);
            assert.equal(fs.existsSync(path.join(dirs.PENDING_DIR, filename)), true);
            assert.equal(fs.existsSync(input), true);
            assert.equal(fs.existsSync(refs), true);
            const retry = JSON.parse(fs.readFileSync(path.join(dirs.PENDING_DIR, filename), "utf8"));
            assert.equal(retry.kioskDeliveryState, "pending");
            assert.equal(retry.kioskDeliveryLastError, undefined);
        } finally {
            fixture.cleanup();
        }
    });
}

test("restart recovery deletes a permanently rejected kiosk source and blocks regeneration", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-permanent-stale-${process.pid}`;
    const job = humanKioskVariant(parentId, 1, {
        retries: 2, permanent: true, failReason: "moderation",
        generatingAt: Date.now() - 6 * 60 * 1000,
    });
    const filename = `${job.filePrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.GENERATING_DIR, filename), JSON.stringify(job));
        const { input, refs } = writePrivateKioskSource(downloads, job);

        await queue.recoverStaleJobs();
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, filename)), true);
        assert.equal(fs.existsSync(input), false);
        assert.equal(fs.existsSync(refs), false);
        await assert.rejects(queue.regenerateVariant(parentId, job.variantId),
            { code: "VARIANT_PERMANENT_FAILURE" });
    } finally {
        fixture.cleanup();
    }
});

for (const failureKind of ["permanent", "retry exhaustion"]) {
    test(`${failureKind} generation failure handles kiosk regeneration source correctly`, async () => {
        const fixture = isolatedQueue(undefined, {
            generateImage: async () => {
                const error = new Error("Simulated generation failure");
                if (failureKind === "permanent") {
                    error.permanent = true;
                    error.failReason = "content_rejected";
                }
                throw error;
            },
        });
        const { queue, dirs, downloads } = fixture;
        const parentId = `kiosk-generation-source-${failureKind.replace(/ /g, "-")}-${process.pid}`;
        const job = humanKioskVariant(parentId, 1, {
            retries: failureKind === "retry exhaustion" ? 2 : 0,
        });
        const filename = `${job.filePrefix}.json`;
        try {
            fs.writeFileSync(path.join(dirs.PENDING_DIR, filename), JSON.stringify(job));
            const { input, refs } = writePrivateKioskSource(downloads, job);

            await queue.processGenerationQueue();
            await waitFor(path.join(dirs.REVIEW_DIR, filename));
            const retryable = failureKind !== "permanent";
            assert.equal(fs.existsSync(input), retryable);
            assert.equal(fs.existsSync(refs), retryable);
            const failed = JSON.parse(fs.readFileSync(path.join(dirs.REVIEW_DIR, filename), "utf8"));
            assert.equal(failed.variantStatus, "FAILED");

            if (retryable) {
                await queue.regenerateVariant(parentId, job.variantId);
                assert.equal(fs.existsSync(path.join(dirs.PENDING_DIR, filename)), true);
                assert.equal(fs.existsSync(input), true);
                assert.equal(fs.existsSync(refs), true);
                const retry = JSON.parse(fs.readFileSync(path.join(dirs.PENDING_DIR, filename), "utf8"));
                assert.equal(retry.kioskDeliveryState, "pending");
                assert.equal(retry.kioskDeliveryLastError, undefined);
            } else {
                await assert.rejects(queue.regenerateVariant(parentId, job.variantId),
                    { code: "VARIANT_PERMANENT_FAILURE" });
                assert.equal(fs.existsSync(path.join(dirs.PENDING_DIR, filename)), false);
            }
        } finally {
            fixture.cleanup();
        }
    });
}

test("review cards expose retry and reanalysis availability from private kiosk sources", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-review-actions-${process.pid}`;
    const retryable = humanKioskVariant(parentId, 1, {
        variantStatus: "FAILED", failReason: "generation",
        kioskDeliveryState: "failed", kioskDeliveryFailureSource: "generation",
    });
    const permanent = humanKioskVariant(parentId, 2, {
        variantStatus: "FAILED", failReason: "moderation", permanent: true,
        kioskDeliveryState: "failed", kioskDeliveryFailureSource: "generation",
    });
    try {
        for (const job of [retryable, permanent]) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${job.filePrefix}.json`), JSON.stringify(job));
        }
        const source = writePrivateKioskSource(downloads, retryable);
        let [card] = await queue.getReviewQueue(retryable.eventName);
        assert.equal(card.canReanalyze, true);
        assert.equal(card.variants.find((v) => v.variantId === retryable.variantId).canRegenerate, true);
        assert.equal(card.variants.find((v) => v.variantId === permanent.variantId).canRegenerate, false);

        fs.rmSync(path.join(source.refs, "style", "reference.png"));
        queue.invalidateReviewCache();
        [card] = await queue.getReviewQueue(retryable.eventName);
        assert.equal(card.canReanalyze, false);
        assert.equal(card.variants.find((v) => v.variantId === retryable.variantId).canRegenerate, false);
        await assert.rejects(queue.rejectParent(parentId, null, true, null),
            /Pinned kiosk references are missing/);

        fs.rmSync(source.input);
        queue.invalidateReviewCache();
        [card] = await queue.getReviewQueue(retryable.eventName);
        assert.equal(card.canReanalyze, false);
    } finally {
        fixture.cleanup();
    }
});

test("regeneration preserves a genuine provider failure instead of resetting delivery state", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-provider-final-${process.pid}`;
    const job = humanKioskVariant(parentId, 1, {
        variantStatus: "FAILED", failReason: "generation",
        kioskDeliveryState: "failed", kioskDeliveryFailureSource: "generation",
        kioskDeliveryAttempts: 1, kioskDeliveryProviderId: "provider-message",
        kioskDeliveryLastError: "SendGrid bounce",
    });
    const filename = `${job.filePrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, filename), JSON.stringify(job));
        writePrivateKioskSource(downloads, job);

        await assert.rejects(queue.regenerateVariant(parentId, job.variantId),
            { code: "VARIANT_DELIVERY_FINAL" });
        assert.equal(fs.existsSync(path.join(dirs.PENDING_DIR, filename)), false);
        const unchanged = JSON.parse(fs.readFileSync(path.join(dirs.REVIEW_DIR, filename), "utf8"));
        assert.equal(unchanged.kioskDeliveryState, "failed");
        assert.equal(unchanged.kioskDeliveryLastError, "SendGrid bounce");
    } finally {
        fixture.cleanup();
    }
});

test("all failed kiosk variants can be reanalyzed and old private sources are retired", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-reanalyze-source-${process.pid}`;
    const variants = [1, 2].map((index) => humanKioskVariant(parentId, index, {
        variantStatus: "FAILED", failReason: "generation",
        kioskDeliveryState: "failed", kioskDeliveryFailureSource: "generation",
    }));
    const originalSources = [];
    try {
        for (const job of variants) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${job.filePrefix}.json`), JSON.stringify(job));
            originalSources.push(writePrivateKioskSource(downloads, job));
        }

        await queue.rejectParent(parentId, null, true, "Try another composition");
        const replacements = fs.readdirSync(dirs.PENDING_DIR).filter((name) => name.endsWith(".json"));
        assert.equal(replacements.length, 2);
        for (const filename of replacements) {
            const job = JSON.parse(fs.readFileSync(path.join(dirs.PENDING_DIR, filename), "utf8"));
            assert.equal(job.reanalyzedFrom, parentId);
            const staged = path.join(downloads, ".staging");
            assert.equal(fs.readFileSync(path.join(staged, `${job.filePrefix}_input.jpg`), "utf8"), "private selfie");
            assert.equal(fs.existsSync(path.join(staged, `${job.filePrefix}_refs`, "style", "reference.png")), true);
        }
        for (const [index, source] of originalSources.entries()) {
            assert.equal(fs.existsSync(source.input), false);
            assert.equal(fs.existsSync(source.refs), false);
            assert.equal(fs.existsSync(path.join(dirs.FAILED_DIR, `${variants[index].filePrefix}.json`)), true);
        }
    } finally {
        fixture.cleanup();
    }
});

test("stale ordinary variants whose review mode is now off do not create review cards", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs } = fixture;
    const parentId = `off-stale-variant-${process.pid}`;
    const originalGetForEvent = settings.getForEvent;
    settings.getForEvent = (key, eventName) => key === "reviewMode"
        ? "off" : originalGetForEvent.call(settings, key, eventName);
    const job = kioskVariant(parentId, 1, undefined, {
        kioskSubmission: false, kioskEventSnapshot: undefined,
        reviewModeAtEnqueue: "ai", aiBestOfNMode: true,
        retries: 2, generatingAt: Date.now() - 6 * 60 * 1000,
    });
    const filename = `${job.filePrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.GENERATING_DIR, filename), JSON.stringify(job));
        await queue.sweepStaleGenerating();
        assert.equal(fs.existsSync(path.join(dirs.FAILED_DIR, filename)), true);
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, filename)), false);
    } finally {
        settings.getForEvent = originalGetForEvent;
        fixture.cleanup();
    }
});

for (const recoveryMethod of ["recoverStaleJobs", "sweepStaleGenerating"]) {
    test(`${recoveryMethod} completes an already published kiosk portrait before retry exhaustion`, async () => {
        const fixture = isolatedQueue();
        const { queue, dirs, downloads } = fixture;
        const parentId = `kiosk-published-${recoveryMethod}-${process.pid}`;
        const job = kioskVariant(parentId, 1, undefined, {
            parentJobId: undefined, variantId: undefined, variantCount: undefined,
            variantIndex: undefined, retries: 2,
            generatingAt: Date.now() - 6 * 60 * 1000,
            stateChangedAt: Date.now() - 6 * 60 * 1000,
        });
        const filename = `${job.filePrefix}.json`;
        const staged = path.join(downloads, ".staging");
        const refs = path.join(staged, `${job.filePrefix}_refs`);
        try {
            fs.writeFileSync(path.join(dirs.GENERATING_DIR, filename), JSON.stringify(job));
            fs.mkdirSync(refs, { recursive: true });
            fs.writeFileSync(path.join(refs, "reference.png"), "private reference");
            fs.writeFileSync(path.join(staged, `${job.filePrefix}_input.jpg`), "private selfie");
            fs.writeFileSync(path.join(staged, `${job.filePrefix}_output_mms.jpg`), "mms portrait");
            fs.writeFileSync(path.join(downloads, `${job.filePrefix}_output.png`), "published portrait");

            await queue[recoveryMethod]();
            assert.equal(fs.existsSync(path.join(dirs.DONE_DIR, filename)), true);
            assert.equal(fs.existsSync(path.join(dirs.FAILED_DIR, filename)), false);
            assert.equal(fs.existsSync(path.join(downloads, `${job.filePrefix}_output_mms.jpg`)), true);
            assert.equal(fs.existsSync(path.join(staged, `${job.filePrefix}_input.jpg`)), false);
            assert.equal(fs.existsSync(refs), false);
        } finally {
            fixture.cleanup();
        }
    });
}

test("published-output recovery rebuilds a missing MMS derivative before delivery", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-published-mms-${process.pid}`;
    const job = kioskVariant(parentId, 1, undefined, {
        parentJobId: undefined, variantId: undefined, variantCount: undefined,
        variantIndex: undefined, retries: 2,
    });
    const filename = `${job.filePrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.GENERATING_DIR, filename), JSON.stringify(job));
        await require("sharp")({
            create: { width: 8, height: 8, channels: 3, background: "white" },
        }).png().toFile(path.join(downloads, `${job.filePrefix}_output.png`));

        await queue.recoverStaleJobs();
        assert.equal(fs.existsSync(path.join(dirs.DONE_DIR, filename)), true);
        const derivative = path.join(downloads, `${job.filePrefix}_output_mms.jpg`);
        assert.equal(fs.existsSync(derivative), true);
        assert.equal((await require("sharp")(derivative).metadata()).format, "jpeg");
    } finally {
        fixture.cleanup();
    }
});

test("live generation resumes a kiosk portrait after publication but before queue transition", async () => {
    let publishedOnce = false;
    const fixture = isolatedQueue(undefined, {
        generateImage: async (job) => {
            const staged = path.join(settings.getDownloadDir(), ".staging");
            fs.mkdirSync(staged, { recursive: true });
            fs.writeFileSync(path.join(staged, `${job.filePrefix}_output.png`), "finished portrait");
            fs.writeFileSync(path.join(staged, `${job.filePrefix}_output_mms.jpg`), "mms portrait");
        },
        moveStagedToFinal: async (job) => {
            await pipeline.moveStagedToFinal(job);
            if (!publishedOnce) {
                publishedOnce = true;
                throw new Error("Simulated crash after portrait publication");
            }
        },
    });
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-post-publish-${process.pid}`;
    const job = kioskVariant(parentId, 1, undefined, {
        parentJobId: undefined, variantId: undefined, variantCount: undefined,
        variantIndex: undefined, reviewAt: undefined,
        kioskDeliveryState: "pending",
        kioskEventSnapshot: {
            style: { name: "Cartoon", prompt: "Cartoon portrait", files: [] },
            referencesPinned: true, brandReferenceFiles: [],
            eventSettings: { reviewMode: "off", enablePrinting: false, immediateDigitalDelivery: true },
        },
    });
    const filename = `${job.filePrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.PENDING_DIR, filename), JSON.stringify(job));
        const { input, refs } = writePrivateKioskSource(downloads, job);

        await queue.processGenerationQueue();
        await waitFor(path.join(dirs.DONE_DIR, filename));
        assert.equal(fs.existsSync(path.join(dirs.PENDING_DIR, filename)), false);
        assert.equal(fs.existsSync(path.join(dirs.FAILED_DIR, filename)), false);
        assert.equal(fs.existsSync(path.join(downloads, `${job.filePrefix}_output.png`)), true);
        assert.equal(fs.existsSync(input), false);
        assert.equal(fs.existsSync(refs), false);
        const recovered = JSON.parse(fs.readFileSync(path.join(dirs.DONE_DIR, filename), "utf8"));
        assert.equal(recovered.kioskDeliveryState, "pending");
    } finally {
        fixture.cleanup();
    }
});

for (const failureSource of ["generation", "provider"]) {
    test(`published output recovery ${failureSource === "generation" ? "resets generation" : "preserves provider"} delivery failure`, async () => {
        const fixture = isolatedQueue();
        const { queue, dirs, downloads } = fixture;
        const parentId = `kiosk-failed-publish-${failureSource}-${process.pid}`;
        const job = kioskVariant(parentId, 1, undefined, {
            parentJobId: undefined, variantId: undefined, variantCount: undefined,
            variantIndex: undefined, retries: 2, failReason: "generation",
            kioskDeliveryState: "failed", kioskDeliveryFailureSource: "generation",
            kioskDeliveryLastError: failureSource === "provider" ? "SendGrid bounce" : "generation",
            kioskDeliveryAttempts: failureSource === "provider" ? 1 : 0,
            kioskDeliveryProviderId: failureSource === "provider" ? "sg-provider-result" : undefined,
            kioskProviderStatus: failureSource === "provider" ? "bounce" : undefined,
        });
        const filename = `${job.filePrefix}.json`;
        try {
            fs.writeFileSync(path.join(dirs.GENERATING_DIR, filename), JSON.stringify(job));
            fs.writeFileSync(path.join(downloads, `${job.filePrefix}_output.png`), "published portrait");
            fs.writeFileSync(path.join(downloads, `${job.filePrefix}_output_mms.jpg`), "mms portrait");

            await queue.recoverStaleJobs();
            const recovered = JSON.parse(fs.readFileSync(path.join(dirs.DONE_DIR, filename), "utf8"));
            assert.equal(recovered.kioskDeliveryState,
                failureSource === "generation" ? "pending" : "failed");
            assert.equal(recovered.kioskDeliveryLastError,
                failureSource === "generation" ? undefined : "SendGrid bounce");
        } finally {
            fixture.cleanup();
        }
    });
}

test("boot recovery rescues a previously failed kiosk job whose portrait was already published", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-old-published-failure-${process.pid}`;
    const job = kioskVariant(parentId, 1, undefined, {
        parentJobId: undefined, variantId: undefined, variantCount: undefined,
        variantIndex: undefined, retries: 3, failReason: "generation",
        kioskDeliveryState: "failed", kioskDeliveryFailureSource: "generation",
        kioskDeliveryLastError: "generation", kioskDeliveryAttempts: 0,
    });
    const filename = `${job.filePrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.FAILED_DIR, filename), JSON.stringify(job));
        const { input, refs } = writePrivateKioskSource(downloads, job);
        fs.writeFileSync(path.join(downloads, `${job.filePrefix}_output.png`), "published portrait");
        fs.writeFileSync(path.join(downloads, `${job.filePrefix}_output_mms.jpg`), "mms portrait");

        await queue.buildUsageCache();
        assert.equal(queue.getUsageCount(job.userPhone, job.eventName), 0);
        await queue.recoverStaleJobs();
        assert.equal(fs.existsSync(path.join(dirs.DONE_DIR, filename)), true);
        assert.equal(fs.existsSync(path.join(dirs.FAILED_DIR, filename)), false);
        const recovered = JSON.parse(fs.readFileSync(path.join(dirs.DONE_DIR, filename), "utf8"));
        assert.equal(recovered.kioskDeliveryState, "pending");
        assert.equal(queue.getUsageCount(job.userPhone, job.eventName), 1);
        assert.equal(fs.existsSync(input), false);
        assert.equal(fs.existsSync(refs), false);
    } finally {
        fixture.cleanup();
    }
});

test("AI review does not compare a sibling already marked superseded", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `ai-superseded-${process.pid}`;
    const ready = kioskVariant(parentId, 1, "READY");
    const superseded = kioskVariant(parentId, 2, "SUPERSEDED", { failReason: "superseded" });
    const readyFile = `${ready.filePrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, readyFile), JSON.stringify(ready));
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${superseded.filePrefix}.json`), JSON.stringify(superseded));
        const staged = path.join(downloads, ".staging");
        fs.mkdirSync(staged);
        fs.writeFileSync(path.join(staged, `${ready.filePrefix}_input.jpg`), "private selfie");
        fs.writeFileSync(path.join(staged, `${ready.filePrefix}_output.png`), "finished portrait");

        await queue.sweepAiBestOfNGroups();
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, readyFile)), true);
        assert.equal(fs.existsSync(path.join(dirs.DONE_DIR, readyFile)), false);
    } finally {
        fixture.cleanup();
    }
});

test("AI recovery finishes a leftover sibling after its chosen portrait was published", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs } = fixture;
    const parentId = `ai-published-${process.pid}`;
    const winnerPrefix = `${parentId}-v1`;
    const winner = kioskVariant(parentId, 1, "READY", { approvedAt: Date.now(), completedAt: Date.now() });
    const leftover = kioskVariant(parentId, 2, "READY", {
        aiBestOfNDecision: { winnerVariantId: winnerPrefix, reason: "Best portrait" },
    });
    const leftoverFile = `${leftover.filePrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.DONE_DIR, `${winnerPrefix}.json`), JSON.stringify(winner));
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, leftoverFile), JSON.stringify(leftover));

        await queue.sweepAiBestOfNGroups();
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, leftoverFile)), false);
        const retired = JSON.parse(fs.readFileSync(path.join(dirs.FAILED_DIR, leftoverFile), "utf8"));
        assert.equal(retired.failReason, "superseded");
        assert.equal(retired.kioskResultPrefix, winnerPrefix);
    } finally {
        fixture.cleanup();
    }
});

test("AI recovery retires a leftover sibling after its approved winner later fails printing", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs } = fixture;
    const parentId = `ai-print-failed-${process.pid}`;
    const winnerPrefix = `${parentId}-v1`;
    const winner = kioskVariant(parentId, 1, "FAILED", {
        approvedAt: Date.now(), failReason: "printer_error",
    });
    const leftover = kioskVariant(parentId, 2, "READY", {
        aiBestOfNDecision: { winnerVariantId: winnerPrefix, reason: "Best portrait" },
    });
    const leftoverFile = `${leftover.filePrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.FAILED_DIR, `${winnerPrefix}.json`), JSON.stringify(winner));
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, leftoverFile), JSON.stringify(leftover));

        await queue.sweepAiBestOfNGroups();
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, leftoverFile)), false);
        const retired = JSON.parse(fs.readFileSync(path.join(dirs.FAILED_DIR, leftoverFile), "utf8"));
        assert.equal(retired.failReason, "superseded");
        assert.equal(retired.kioskResultPrefix, winnerPrefix);
    } finally {
        fixture.cleanup();
    }
});

test("kiosk approval intent survives a crash before portrait publication", async () => {
    const firstRun = isolatedQueue(undefined, {
        moveStagedToFinal: async () => { throw new Error("Simulated publication crash"); },
    });
    let active = firstRun;
    const { dirs, downloads } = firstRun;
    const parentId = `kiosk-approval-intent-${process.pid}`;
    const job = kioskVariant(parentId, 1, "READY", {
        parentJobId: undefined, variantId: undefined, variantCount: undefined,
        variantIndex: undefined, kioskEventSnapshot: {
            style: { name: "Cartoon", prompt: "Cartoon portrait", files: [] },
            referencesPinned: true, brandReferenceFiles: [],
            eventSettings: { reviewMode: "human", enablePrinting: false, immediateDigitalDelivery: true },
        },
    });
    const filename = `${job.filePrefix}.json`;
    const staged = path.join(downloads, ".staging");
    try {
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, filename), JSON.stringify(job));
        fs.mkdirSync(staged);
        fs.writeFileSync(path.join(staged, `${job.filePrefix}_input.jpg`), "private selfie");
        fs.writeFileSync(path.join(staged, `${job.filePrefix}_output.png`), "finished portrait");
        fs.writeFileSync(path.join(staged, `${job.filePrefix}_output_mms.jpg`), "mms portrait");

        await assert.rejects(firstRun.queue.approveJob(filename), /Simulated publication crash/);
        const interrupted = JSON.parse(fs.readFileSync(path.join(dirs.REVIEW_DIR, filename), "utf8"));
        assert.ok(interrupted.kioskApprovalStartedAt, "approval intent must be durable before publication");

        firstRun.cleanup({ keepFiles: true });
        active = isolatedQueue(firstRun.root);
        await active.queue.processGenerationQueue();
        await waitFor(path.join(dirs.DONE_DIR, filename));
        assert.equal(fs.existsSync(path.join(downloads, `${job.filePrefix}_output.png`)), true);
        assert.equal(fs.existsSync(path.join(staged, `${job.filePrefix}_input.jpg`)), false);
    } finally {
        active.cleanup();
    }
});

test("post-route recovery finishes a published kiosk approval without flushing untouched human reviews", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-legacy-publish-${process.pid}`;
    const approved = kioskVariant(parentId, 1, "READY", {
        parentJobId: undefined, variantId: undefined, variantCount: undefined,
        variantIndex: undefined, kioskEventSnapshot: {
            style: { name: "Cartoon", prompt: "Cartoon portrait", files: [] },
            referencesPinned: true, brandReferenceFiles: [],
            eventSettings: { reviewMode: "human", enablePrinting: false, immediateDigitalDelivery: true },
        },
    });
    const untouched = { ...approved, filePrefix: `${parentId}-untouched` };
    const approvedFile = `${approved.filePrefix}.json`;
    const untouchedFile = `${untouched.filePrefix}.json`;
    const staged = path.join(downloads, ".staging");
    const refs = path.join(staged, `${approved.filePrefix}_refs`);
    try {
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, approvedFile), JSON.stringify(approved));
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, untouchedFile), JSON.stringify(untouched));
        fs.mkdirSync(refs, { recursive: true });
        fs.writeFileSync(path.join(refs, "reference.png"), "private reference");
        fs.writeFileSync(path.join(staged, `${approved.filePrefix}_input.jpg`), "private selfie");
        fs.writeFileSync(path.join(staged, `${approved.filePrefix}_output_mms.jpg`), "mms portrait");
        fs.writeFileSync(path.join(downloads, `${approved.filePrefix}_output.png`), "published portrait");

        await queue.processGenerationQueue();
        await waitFor(path.join(dirs.DONE_DIR, approvedFile));
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, untouchedFile)), true);
        assert.equal(fs.existsSync(path.join(downloads, `${approved.filePrefix}_output_mms.jpg`)), true);
        assert.equal(fs.existsSync(path.join(staged, `${approved.filePrefix}_input.jpg`)), false);
        assert.equal(fs.existsSync(refs), false);
    } finally {
        fixture.cleanup();
    }
});

test("recovery never auto-approves an unmarked human review when event settings change", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `human-stays-human-${process.pid}`;
    const originalGetForEvent = settings.getForEvent;
    settings.getForEvent = (key, eventName) => key === "reviewMode"
        ? "ai" : originalGetForEvent.call(settings, key, eventName);
    const ready = kioskVariant(parentId, 1, "READY", {
        kioskSubmission: false, kioskEventSnapshot: undefined,
        reviewModeAtEnqueue: "human", channel: "sms",
    });
    const failed = kioskVariant(parentId, 2, "FAILED", {
        kioskSubmission: false, kioskEventSnapshot: undefined,
        reviewModeAtEnqueue: "human", channel: "sms", failReason: "generation",
    });
    const readyFile = `${ready.filePrefix}.json`;
    try {
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, readyFile), JSON.stringify(ready));
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${failed.filePrefix}.json`), JSON.stringify(failed));
        const staged = path.join(downloads, ".staging");
        fs.mkdirSync(staged);
        fs.writeFileSync(path.join(staged, `${ready.filePrefix}_input.jpg`), "private selfie");
        fs.writeFileSync(path.join(staged, `${ready.filePrefix}_output.png`), "finished portrait");

        await queue.sweepAiBestOfNGroups();
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, readyFile)), true);
        assert.equal(fs.existsSync(path.join(dirs.DONE_DIR, readyFile)), false);
    } finally {
        settings.getForEvent = originalGetForEvent;
        fixture.cleanup();
    }
});

test("AI at enqueue does not auto-pick when ordinary variants enter human review", async () => {
    const fixture = isolatedQueue(undefined, {
        generateImage: async (job) => {
            const staged = path.join(settings.getDownloadDir(), ".staging");
            fs.mkdirSync(staged, { recursive: true });
            fs.writeFileSync(path.join(staged, `${job.filePrefix}_output.png`), "finished portrait");
        },
    });
    const { queue, dirs } = fixture;
    const parentId = `ai-to-human-${process.pid}`;
    const originalGetForEvent = settings.getForEvent;
    settings.getForEvent = (key, eventName) => key === "reviewMode"
        ? "human" : originalGetForEvent.call(settings, key, eventName);
    const variants = [1, 2].map((index) => kioskVariant(parentId, index, undefined, {
        kioskSubmission: false, kioskEventSnapshot: undefined, channel: "sms",
        reviewModeAtEnqueue: "ai", aiBestOfNMode: true,
    }));
    try {
        for (const variant of variants) {
            fs.writeFileSync(path.join(dirs.PENDING_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
        }
        await queue.processGenerationQueue();
        for (const variant of variants) {
            await waitFor(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`));
        }
        await queue.sweepAiBestOfNGroups();
        for (const variant of variants) {
            const job = JSON.parse(fs.readFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), "utf8"));
            assert.equal(job.reviewModeAtReview, "human");
            assert.equal(fs.existsSync(path.join(dirs.DONE_DIR, `${variant.filePrefix}.json`)), false);
        }
    } finally {
        settings.getForEvent = originalGetForEvent;
        fixture.cleanup();
    }
});

test("AI review does not auto-pick a group with a later human-review sibling", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `ai-mixed-review-${process.pid}`;
    const first = kioskVariant(parentId, 1, "READY", {
        kioskSubmission: false, kioskEventSnapshot: undefined,
        reviewModeAtEnqueue: "ai", reviewModeAtReview: "ai", aiBestOfNMode: true,
    });
    const second = kioskVariant(parentId, 2, "READY", {
        kioskSubmission: false, kioskEventSnapshot: undefined,
        reviewModeAtEnqueue: "ai", reviewModeAtReview: "human", aiBestOfNMode: true,
    });
    try {
        for (const variant of [first, second]) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
        }
        const staged = path.join(downloads, ".staging");
        fs.mkdirSync(staged);
        fs.writeFileSync(path.join(staged, `${first.filePrefix}_output.png`), "finished portrait");

        await queue.sweepAiBestOfNGroups();
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, `${first.filePrefix}.json`)), true);
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, `${second.filePrefix}.json`)), true);
        assert.equal(fs.existsSync(path.join(dirs.DONE_DIR, `${first.filePrefix}.json`)), false);
    } finally {
        fixture.cleanup();
    }
});

test("retrying a partial AI rejection releases one portrait quota only once", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs } = fixture;
    const parentId = `ai-reject-${process.pid}`;
    const decision = { allFailed: true, reason: "All portraits failed review" };
    const first = kioskVariant(parentId, 1, "READY", { aiBestOfNDecision: decision });
    const second = kioskVariant(parentId, 2, "READY", { aiBestOfNDecision: decision });
    const firstFile = `${first.filePrefix}.json`;
    const secondFile = `${second.filePrefix}.json`;
    const originalRename = fs.promises.rename;
    try {
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, firstFile), JSON.stringify(first));
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, secondFile), JSON.stringify(second));
        fs.writeFileSync(path.join(dirs.DONE_DIR, "other-portrait.json"), JSON.stringify({
            filePrefix: "other-portrait", eventName: first.eventName,
            userPhone: first.userPhone, kioskSubmission: true,
            requestId: "other-request", completedAt: Date.now(),
        }));
        await queue.buildUsageCache();
        assert.equal(queue.getUsageCount(first.userPhone, first.eventName), 2);

        const stubbornPath = path.join(dirs.REVIEW_DIR, secondFile);
        fs.promises.rename = async (src, dst) => {
            if (src === stubbornPath && dst === path.join(dirs.FAILED_DIR, secondFile)) {
                const error = new Error("Simulated interrupted move");
                error.code = "ENOENT";
                throw error;
            }
            return originalRename(src, dst);
        };
        await queue.sweepAiBestOfNGroups();
        assert.equal(fs.existsSync(stubbornPath), true);
        assert.equal(queue.getUsageCount(first.userPhone, first.eventName), 1);

        fs.promises.rename = originalRename;
        await queue.sweepAiBestOfNGroups();
        assert.equal(fs.existsSync(path.join(dirs.FAILED_DIR, secondFile)), true);
        assert.equal(queue.getUsageCount(first.userPhone, first.eventName), 1,
            "the other kiosk portrait must keep its quota charge");
    } finally {
        fs.promises.rename = originalRename;
        fixture.cleanup();
    }
});

test("a restarted AI rejection releases only its own portrait quota", async () => {
    const firstRun = isolatedQueue();
    let active = firstRun;
    const { dirs } = firstRun;
    const parentId = `ai-reject-restart-${process.pid}`;
    const decision = { allFailed: true, reason: "All portraits failed review" };
    const variants = [1, 2].map((index) => kioskVariant(parentId, index, "FAILED", {
        aiBestOfNDecision: decision,
    }));
    const stubbornFile = `${variants[1].filePrefix}.json`;
    const stubbornPath = path.join(dirs.REVIEW_DIR, stubbornFile);
    const originalRename = fs.promises.rename;
    try {
        for (const variant of variants) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
        }
        fs.writeFileSync(path.join(dirs.DONE_DIR, "other-portrait.json"), JSON.stringify({
            filePrefix: "other-portrait", eventName: variants[0].eventName,
            userPhone: variants[0].userPhone, kioskSubmission: true,
            requestId: "other-request", completedAt: Date.now(),
        }));
        await firstRun.queue.buildUsageCache();
        assert.equal(firstRun.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 2);

        fs.promises.rename = async (src, dst) => {
            if (src === stubbornPath && dst === path.join(dirs.FAILED_DIR, stubbornFile)) {
                const error = new Error("Simulated interrupted move");
                error.code = "ENOENT";
                throw error;
            }
            return originalRename(src, dst);
        };
        await firstRun.queue.sweepAiBestOfNGroups();
        assert.equal(fs.existsSync(stubbornPath), true);
        assert.equal(firstRun.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 1);

        fs.promises.rename = originalRename;
        firstRun.cleanup({ keepFiles: true });
        active = isolatedQueue(firstRun.root);
        await active.queue.buildUsageCache();
        // Persisted terminal review siblings were already rejected. Rebuild
        // must count only the unrelated portrait, before any retry sweep.
        assert.equal(active.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 1);
        await active.queue.sweepAiBestOfNGroups();
        assert.equal(fs.existsSync(stubbornPath), false);
        assert.equal(active.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 1);
    } finally {
        fs.promises.rename = originalRename;
        active.cleanup();
    }
});

test("a partially rejected human kiosk card is hidden and retired after restart without quota loss", async () => {
    const firstRun = isolatedQueue();
    let active = firstRun;
    const { dirs, downloads } = firstRun;
    const parentId = `human-reject-restart-${process.pid}`;
    const variants = [1, 2].map((index) => humanKioskVariant(parentId, index, {
        variantStatus: "READY", requestId: `request-${parentId}`,
    }));
    const stubbornFile = `${variants[1].filePrefix}.json`;
    const stubbornPath = path.join(dirs.REVIEW_DIR, stubbornFile);
    const originalRename = fs.promises.rename;
    try {
        for (const variant of variants) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
            writePrivateKioskSource(downloads, variant);
        }
        fs.writeFileSync(path.join(dirs.DONE_DIR, "other-portrait.json"), JSON.stringify({
            filePrefix: "other-portrait", eventName: variants[0].eventName,
            userPhone: variants[0].userPhone, kioskSubmission: true,
            requestId: "other-request", completedAt: Date.now(),
        }));
        await firstRun.queue.buildUsageCache();
        assert.equal(firstRun.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 2);

        fs.promises.rename = async (src, dst) => {
            if (src === stubbornPath && dst === path.join(dirs.FAILED_DIR, stubbornFile)) {
                const error = new Error("Simulated interrupted terminal move");
                error.code = "ENOENT";
                throw error;
            }
            return originalRename(src, dst);
        };
        await firstRun.queue.rejectParent(parentId, null, false, null);
        assert.equal(fs.existsSync(stubbornPath), true);
        assert.equal(firstRun.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 1);
        assert.equal((await firstRun.queue.getReviewQueue(variants[0].eventName)).length, 0);

        fs.promises.rename = originalRename;
        firstRun.cleanup({ keepFiles: true });
        active = isolatedQueue(firstRun.root);
        await active.queue.buildUsageCache();
        assert.equal(active.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 1);
        await active.queue.recoverStaleJobs();
        assert.equal(fs.existsSync(stubbornPath), false);
        assert.equal(fs.existsSync(path.join(dirs.FAILED_DIR, stubbornFile)), true);
        assert.equal(active.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 1);
        for (const variant of variants) {
            const staged = path.join(downloads, ".staging");
            assert.equal(fs.existsSync(path.join(staged, `${variant.filePrefix}_input.jpg`)), false);
            assert.equal(fs.existsSync(path.join(staged, `${variant.filePrefix}_refs`)), false);
        }
    } finally {
        fs.promises.rename = originalRename;
        active.cleanup();
    }
});

test("a kiosk pick waits for a loser write and resumes after that write recovers", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-pick-write-${process.pid}`;
    const winner = humanKioskVariant(parentId, 1, { variantStatus: "READY" });
    const loser = humanKioskVariant(parentId, 2, { variantStatus: "READY" });
    const winnerFile = `${winner.filePrefix}.json`;
    const loserFile = `${loser.filePrefix}.json`;
    let restoreRename = () => {};
    try {
        for (const variant of [winner, loser]) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
            writePrivateKioskSource(downloads, variant);
        }
        const staged = path.join(downloads, ".staging");
        fs.writeFileSync(path.join(staged, `${winner.filePrefix}_output.png`), "finished portrait");
        fs.writeFileSync(path.join(staged, `${winner.filePrefix}_output_mms.jpg`), "mms portrait");

        restoreRename = failNextAtomicJobWrite(path.join(dirs.REVIEW_DIR, loserFile));
        await assert.rejects(queue.pickVariant(parentId, winner.variantId), /Simulated atomic job write failure/);
        assert.equal(fs.existsSync(path.join(dirs.DONE_DIR, winnerFile)), false);
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, winnerFile)), true);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.REVIEW_DIR, loserFile), "utf8")).variantStatus, "READY");

        restoreRename();
        restoreRename = () => {};
        await queue.processGenerationQueue();
        await waitFor(path.join(dirs.DONE_DIR, winnerFile));
        await waitFor(path.join(dirs.FAILED_DIR, loserFile));
        assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.FAILED_DIR, loserFile), "utf8")).variantStatus,
            "SUPERSEDED");
    } finally {
        restoreRename();
        fixture.cleanup();
    }
});

test("a human kiosk reject recovers after an atomic loser write fails", async () => {
    const firstRun = isolatedQueue();
    let active = firstRun;
    const { dirs, downloads } = firstRun;
    const parentId = `kiosk-reject-write-${process.pid}`;
    const variants = [1, 2].map((index) => humanKioskVariant(parentId, index, {
        variantStatus: "READY", requestId: `request-${parentId}`,
    }));
    const loserFile = `${variants[1].filePrefix}.json`;
    let restoreRename = () => {};
    try {
        for (const variant of variants) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
            writePrivateKioskSource(downloads, variant);
        }
        fs.writeFileSync(path.join(dirs.DONE_DIR, "other-portrait.json"), JSON.stringify({
            filePrefix: "other-portrait", eventName: variants[0].eventName,
            userPhone: variants[0].userPhone, kioskSubmission: true,
            requestId: "other-request", completedAt: Date.now(),
        }));
        await firstRun.queue.buildUsageCache();
        assert.equal(firstRun.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 2);

        restoreRename = failNextAtomicJobWrite(path.join(dirs.REVIEW_DIR, loserFile));
        await assert.rejects(firstRun.queue.rejectParent(parentId, null, false, null),
            /Simulated atomic job write failure/);
        assert.equal(firstRun.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 2);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.REVIEW_DIR, loserFile), "utf8")).variantStatus,
            "READY");

        restoreRename();
        restoreRename = () => {};
        firstRun.cleanup({ keepFiles: true });
        active = isolatedQueue(firstRun.root);
        await active.queue.buildUsageCache();
        assert.equal(active.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 2);
        await active.queue.recoverStaleJobs();
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, loserFile)), false);
        assert.equal(fs.existsSync(path.join(dirs.FAILED_DIR, loserFile)), true);
        assert.equal(active.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 1);
    } finally {
        restoreRename();
        active.cleanup();
    }
});

test("a kiosk rejection retains its intent when the first sibling scan misses a card", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs } = fixture;
    const parentId = `kiosk-reject-scan-${process.pid}`;
    const variants = [1, 2].map((index) => humanKioskVariant(parentId, index, {
        variantStatus: "READY", requestId: `request-${parentId}`,
    }));
    const missedPath = path.join(dirs.REVIEW_DIR, `${variants[1].filePrefix}.json`);
    const originalReadFile = fs.promises.readFile;
    let missed = false;
    try {
        for (const variant of variants) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
        }
        await queue.buildUsageCache();
        fs.promises.readFile = async (filePath, ...args) => {
            if (!missed && filePath === missedPath) {
                missed = true;
                const error = new Error("Simulated review card read failure");
                error.code = "EIO";
                throw error;
            }
            return originalReadFile(filePath, ...args);
        };
        await assert.rejects(queue.rejectParent(parentId, null, false, null),
            /Kiosk rejection is incomplete/);
        assert.equal(queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 1);
        assert.equal(fs.existsSync(missedPath), true);

        fs.promises.readFile = originalReadFile;
        await queue.recoverStaleJobs();
        assert.equal(fs.existsSync(missedPath), false);
        assert.equal(queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 0);
    } finally {
        fs.promises.readFile = originalReadFile;
        fixture.cleanup();
    }
});

for (const recovery of ["recoverStaleJobs", "sweepStaleGenerating"]) {
    for (const terminalStatus of ["SUPERSEDED", "REJECTED"]) {
        test(`${recovery} retires a terminal kiosk generating variant without reviving review (${terminalStatus})`, async () => {
            const fixture = isolatedQueue();
            const { queue, dirs, downloads } = fixture;
            const parentId = `kiosk-terminal-${recovery}-${terminalStatus}-${process.pid}`;
            const variant = humanKioskVariant(parentId, 1, {
                variantStatus: terminalStatus,
                failReason: terminalStatus === "REJECTED" ? "review_rejected" : "superseded",
                permanent: true, retries: config.MAX_RETRIES - 1,
                generatingAt: Date.now() - 360_000,
            });
            const filename = `${variant.filePrefix}.json`;
            try {
                fs.writeFileSync(path.join(dirs.GENERATING_DIR, filename), JSON.stringify(variant));
                const { input, refs } = writePrivateKioskSource(downloads, variant);
                await queue[recovery]();
                assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, filename)), false);
                const failedPath = path.join(dirs.FAILED_DIR, filename);
                assert.equal(fs.existsSync(failedPath), true);
                assert.equal(JSON.parse(fs.readFileSync(failedPath, "utf8")).variantStatus, terminalStatus);
                assert.equal(fs.existsSync(input), false);
                assert.equal(fs.existsSync(refs), false);
            } finally {
                fixture.cleanup();
            }
        });
    }
}

test("kiosk reanalysis does not queue replacements when an old variant write fails", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-reanalyze-write-${process.pid}`;
    const variants = [1, 2].map((index) => humanKioskVariant(parentId, index, { variantStatus: "READY" }));
    const loserFile = `${variants[1].filePrefix}.json`;
    let restoreRename = () => {};
    try {
        for (const variant of variants) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
            writePrivateKioskSource(downloads, variant);
        }

        restoreRename = failNextAtomicJobWrite(path.join(dirs.REVIEW_DIR, loserFile));
        await assert.rejects(queue.rejectParent(parentId, null, true, "Try again"),
            /Simulated atomic job write failure/);
        assert.deepEqual(fs.readdirSync(dirs.PENDING_DIR).filter((name) => name.endsWith(".json")), []);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.REVIEW_DIR, loserFile), "utf8")).variantStatus,
            "READY");
        assert.equal(fs.existsSync(path.join(downloads, ".staging", `${variants[1].filePrefix}_input.jpg`)), true);

        restoreRename();
        restoreRename = () => {};
        await queue.rejectParent(parentId, null, true, "Try again");
        assert.equal(fs.readdirSync(dirs.PENDING_DIR).filter((name) => name.endsWith(".json")).length, 2);
        assert.equal(fs.existsSync(path.join(dirs.REVIEW_DIR, loserFile)), false);
    } finally {
        restoreRename();
        fixture.cleanup();
    }
});

test("concurrent kiosk reanalysis requests publish only one replacement group", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-reanalyze-concurrent-${process.pid}`;
    const variants = [1, 2].map((index) => humanKioskVariant(parentId, index, { variantStatus: "READY" }));
    for (const variant of variants) variant.kioskEventSnapshot.style.files = [];
    const originalReadFile = fs.promises.readFile;
    let slowedSource = false;
    try {
        for (const variant of variants) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
            writePrivateKioskSource(downloads, variant);
        }
        const sourcePath = path.join(downloads, ".staging", `${variants[0].filePrefix}_input.jpg`);
        fs.promises.readFile = async (filePath, ...args) => {
            const contents = await originalReadFile(filePath, ...args);
            if (!slowedSource && filePath === sourcePath) {
                slowedSource = true;
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return contents;
        };
        await Promise.allSettled([
            queue.rejectParent(parentId, null, true, "Try again"),
            queue.rejectParent(parentId, null, true, "Try again"),
        ]);
        const jobs = fs.readdirSync(dirs.PENDING_DIR).filter((name) => name.endsWith(".json"))
            .map((name) => JSON.parse(fs.readFileSync(path.join(dirs.PENDING_DIR, name), "utf8")));
        assert.equal(jobs.length, 2);
        assert.equal(new Set(jobs.map((job) => job.parentJobId)).size, 1);
        assert.equal(fs.readdirSync(path.join(downloads, ".staging"))
            .filter((name) => name.endsWith("_input.jpg")).length, 2);
    } finally {
        fs.promises.readFile = originalReadFile;
        fixture.cleanup();
    }
});

test("a simultaneous kiosk reject cannot override a reanalysis already preparing", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-reanalyze-vs-reject-${process.pid}`;
    const variants = [1, 2].map((index) => humanKioskVariant(parentId, index, { variantStatus: "READY" }));
    for (const variant of variants) variant.kioskEventSnapshot.style.files = [];
    const originalReadFile = fs.promises.readFile;
    let delayedSource = false;
    try {
        for (const variant of variants) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
            writePrivateKioskSource(downloads, variant);
        }
        await queue.buildUsageCache();
        const sourcePath = path.join(downloads, ".staging", `${variants[0].filePrefix}_input.jpg`);
        fs.promises.readFile = async (filePath, ...args) => {
            const contents = await originalReadFile(filePath, ...args);
            if (!delayedSource && filePath === sourcePath) {
                delayedSource = true;
                await new Promise((resolve) => setTimeout(resolve, 400));
            }
            return contents;
        };
        const [reanalyze, reject] = await Promise.allSettled([
            queue.rejectParent(parentId, null, true, "Try again"),
            queue.rejectParent(parentId, null, false, null),
        ]);
        assert.equal(reanalyze.status, "fulfilled");
        assert.equal(reject.status, "rejected");
        assert.equal(reject.reason.code, "ALREADY_DECIDED");
        const jobs = fs.readdirSync(dirs.PENDING_DIR).filter((name) => name.endsWith(".json"));
        assert.equal(jobs.length, 2);
        assert.equal(queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 1);
    } finally {
        fs.promises.readFile = originalReadFile;
        fixture.cleanup();
    }
});

test("a simultaneous kiosk reject cannot overtake a pick before approval is recorded", async () => {
    const fixture = isolatedQueue();
    const { queue, dirs, downloads } = fixture;
    const parentId = `kiosk-pick-vs-reject-${process.pid}`;
    const winner = humanKioskVariant(parentId, 1, { variantStatus: "READY" });
    const loser = humanKioskVariant(parentId, 2, { variantStatus: "READY" });
    const winnerFile = `${winner.filePrefix}.json`;
    const originalRename = fs.promises.rename;
    let delayedApproval = false;
    try {
        for (const variant of [winner, loser]) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
            writePrivateKioskSource(downloads, variant);
        }
        const staged = path.join(downloads, ".staging");
        fs.writeFileSync(path.join(staged, `${winner.filePrefix}_output.png`), "finished portrait");
        fs.writeFileSync(path.join(staged, `${winner.filePrefix}_output_mms.jpg`), "mms portrait");
        await queue.buildUsageCache();
        const winnerReviewPath = path.join(dirs.REVIEW_DIR, winnerFile);
        fs.promises.rename = async (src, dst) => {
            if (!delayedApproval && dst === winnerReviewPath && path.basename(src).includes(".tmp.")) {
                delayedApproval = true;
                await new Promise((resolve) => setTimeout(resolve, 400));
            }
            return originalRename(src, dst);
        };
        const [pick, reject] = await Promise.allSettled([
            queue.pickVariant(parentId, winner.variantId),
            queue.rejectParent(parentId, null, false, null),
        ]);
        assert.equal(pick.status, "fulfilled");
        assert.equal(reject.status, "rejected");
        assert.equal(reject.reason.code, "ALREADY_DECIDED");
        assert.equal(fs.existsSync(path.join(dirs.DONE_DIR, winnerFile)), true);
        assert.equal(fs.existsSync(path.join(dirs.FAILED_DIR, winnerFile)), false);
        assert.equal(queue.getUsageCount(winner.userPhone, winner.eventName), 1);
    } finally {
        fs.promises.rename = originalRename;
        fixture.cleanup();
    }
});

test("restart completes a kiosk reanalysis after the second replacement write fails", async () => {
    const firstRun = isolatedQueue();
    let active = firstRun;
    const { dirs, downloads } = firstRun;
    const parentId = `kiosk-reanalyze-publish-${process.pid}`;
    const variants = [1, 2].map((index) => humanKioskVariant(parentId, index, {
        variantStatus: "READY", requestId: `request-${parentId}`,
    }));
    let restoreRename = () => {};
    try {
        for (const variant of variants) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
            writePrivateKioskSource(downloads, variant);
        }
        await firstRun.queue.buildUsageCache();
        restoreRename = failNextPendingVariantWrite(dirs.PENDING_DIR, 2);
        await assert.rejects(firstRun.queue.rejectParent(parentId, null, true, "Try again"),
            /Simulated replacement publication failure/);
        const partialName = fs.readdirSync(dirs.PENDING_DIR).find((name) => name.endsWith(".json"));
        assert.ok(partialName);
        const partialPath = path.join(dirs.PENDING_DIR, partialName);
        const partialJob = JSON.parse(fs.readFileSync(partialPath, "utf8"));
        partialJob.variantStatus = "READY";
        partialJob.reviewAt = Date.now();
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, partialName), JSON.stringify(partialJob));
        fs.unlinkSync(partialPath);
        assert.equal(fs.readdirSync(dirs.REVIEW_DIR).filter((name) => name.endsWith(".json")).length, 1);
        assert.equal((await firstRun.queue.getReviewQueue(variants[0].eventName)).length, 0);

        restoreRename();
        restoreRename = () => {};
        firstRun.cleanup({ keepFiles: true });
        active = isolatedQueue(firstRun.root);
        await active.queue.buildUsageCache();
        await active.queue.recoverStaleJobs();
        const names = [dirs.PENDING_DIR, dirs.REVIEW_DIR].flatMap((dir) =>
            fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => ({ dir, name })));
        assert.equal(names.length, 2);
        const newJobs = names.map(({ dir, name }) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")));
        assert.equal(new Set(newJobs.map((job) => job.parentJobId)).size, 1);
        assert.deepEqual(newJobs.map((job) => job.variantIndex).sort(), [1, 2]);
        for (const job of newJobs) {
            const staged = path.join(downloads, ".staging");
            assert.equal(fs.existsSync(path.join(staged, `${job.filePrefix}_input.jpg`)), true);
            assert.equal(fs.existsSync(path.join(staged, `${job.filePrefix}_refs`, "style", "reference.png")), true);
        }
        assert.equal(active.queue.getUsageCount(variants[0].userPhone, variants[0].eventName), 1);
        assert.equal(await active.queue.resolveKioskResultPrefix(variants[0].filePrefix, variants[0].eventName),
            newJobs.find((job) => job.variantIndex === 1).filePrefix);
    } finally {
        restoreRename();
        active.cleanup();
    }
});

test("a reanalysis cleanup failure leaves a complete replacement group usable and replays on restart", async () => {
    const firstRun = isolatedQueue();
    let active = firstRun;
    const { dirs, downloads, root } = firstRun;
    const parentId = `kiosk-reanalyze-cleanup-${process.pid}`;
    const variants = [1, 2].map((index) => humanKioskVariant(parentId, index, { variantStatus: "READY" }));
    const originalUnlink = fs.promises.unlink;
    let decisionUnlinks = 0;
    try {
        for (const variant of variants) {
            fs.writeFileSync(path.join(dirs.REVIEW_DIR, `${variant.filePrefix}.json`), JSON.stringify(variant));
            writePrivateKioskSource(downloads, variant);
        }
        const decisionDirs = new Set([
            path.join(root, "kiosk-parent-decisions"), path.join(root, "kiosk-group-publications"),
        ]);
        fs.promises.unlink = async (filePath) => {
            if (decisionDirs.has(path.dirname(filePath)) && filePath.endsWith(".json")
                && ++decisionUnlinks === 2) {
                const error = new Error("Simulated manifest cleanup failure");
                error.code = "EIO";
                throw error;
            }
            return originalUnlink(filePath);
        };
        await assert.rejects(firstRun.queue.rejectParent(parentId, null, true, "Try again"),
            /Simulated manifest cleanup failure/);
        fs.promises.unlink = originalUnlink;

        const pendingNames = fs.readdirSync(dirs.PENDING_DIR).filter((name) => name.endsWith(".json"));
        assert.equal(pendingNames.length, 2);
        const firstName = pendingNames.find((name) => name.endsWith("-v1.json"));
        const firstJob = JSON.parse(fs.readFileSync(path.join(dirs.PENDING_DIR, firstName), "utf8"));
        firstJob.variantStatus = "READY";
        firstJob.reviewAt = Date.now();
        fs.writeFileSync(path.join(dirs.REVIEW_DIR, firstName), JSON.stringify(firstJob));
        fs.unlinkSync(path.join(dirs.PENDING_DIR, firstName));
        assert.equal((await firstRun.queue.getReviewQueue(variants[0].eventName)).length, 1);

        firstRun.cleanup({ keepFiles: true });
        active = isolatedQueue(firstRun.root);
        await active.queue.recoverStaleJobs();
        assert.equal((await active.queue.getReviewQueue(variants[0].eventName)).length, 1);
        assert.equal(fs.readdirSync(path.join(root, "kiosk-parent-decisions")).filter((name) => name.endsWith(".json")).length, 0);
        assert.equal(fs.readdirSync(path.join(root, "kiosk-group-publications")).filter((name) => name.endsWith(".json")).length, 0);
        assert.equal(fs.readdirSync(dirs.PENDING_DIR).filter((name) => name.endsWith(".json")).length, 1);
    } finally {
        fs.promises.unlink = originalUnlink;
        active.cleanup();
    }
});

test("restart completes an initially published kiosk group after its second variant write fails", async () => {
    const firstRun = isolatedQueue();
    let active = firstRun;
    const { dirs, root, downloads } = firstRun;
    const eventName = `kiosk-group-publish-${process.pid}`;
    const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const digest = "initial-group-digest";
    const selfiePath = path.join(root, "selfie.jpg");
    const originalGetForEvent = settings.getForEvent;
    const originalGetActiveStyles = settings.getActiveStyles;
    const originalGetOutputProfile = settings.getOutputProfile;
    let restoreRename = () => {};
    try {
        fs.writeFileSync(selfiePath, "private selfie");
        settings.getForEvent = (key, event) => event === eventName ? ({
            reviewMode: "human", variantsPerReview: 2, enablePrinting: false,
            immediateDigitalDelivery: true, customBrands: {}, backgroundChoices: [], adminPhones: [],
        })[key] : originalGetForEvent(key, event);
        settings.getActiveStyles = () => ({ cartoon: { name: "Cartoon", prompt: "Cartoon portrait", files: [] } });
        settings.getOutputProfile = () => ({ orientation: "portrait" });
        restoreRename = failNextPendingVariantWrite(dirs.PENDING_DIR, 2);
        assert.throws(() => firstRun.queue.enqueueJob("", `api-${requestId}`,
            "api:email:group-publish", "", "cartoon", "https://example.test", null, null, {
                eventName, kioskSubmission: true, channel: "email", kioskEmail: "guest@example.test",
                requestId, kioskRequestDigest: digest, sourceImagePath: selfiePath,
            }), /Simulated replacement publication failure/);
        assert.equal(fs.readdirSync(dirs.PENDING_DIR).filter((name) => name.endsWith(".json")).length, 1);

        restoreRename();
        restoreRename = () => {};
        firstRun.cleanup({ keepFiles: true });
        active = isolatedQueue(firstRun.root);
        await active.queue.buildUsageCache();
        await active.queue.recoverStaleJobs();
        const names = fs.readdirSync(dirs.PENDING_DIR).filter((name) => name.endsWith(".json"));
        assert.equal(names.length, 2);
        const jobs = names.map((name) => JSON.parse(fs.readFileSync(path.join(dirs.PENDING_DIR, name), "utf8")));
        assert.equal(new Set(jobs.map((job) => job.parentJobId)).size, 1);
        assert.deepEqual(jobs.map((job) => job.variantIndex).sort(), [1, 2]);
        for (const job of jobs) {
            assert.equal(fs.existsSync(path.join(downloads, ".staging", `${job.filePrefix}_input.jpg`)), true);
        }
        assert.equal(active.queue.getUsageCount("api:email:group-publish", eventName), 1);
        assert.equal(jobs[0].kioskRequestDigest, digest);
    } finally {
        restoreRename();
        settings.getForEvent = originalGetForEvent;
        settings.getActiveStyles = originalGetActiveStyles;
        settings.getOutputProfile = originalGetOutputProfile;
        active.cleanup();
    }
});

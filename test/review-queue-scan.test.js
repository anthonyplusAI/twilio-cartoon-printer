const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const QUEUE_PATH = path.join(__dirname, "..", "lib", "queue.js");

test("review scan reuses unchanged jobs, bounds reads, and keeps variant cards current", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-scan-"));
    const dirs = Object.fromEntries(["pending", "generating", "review", "ready", "printing", "done", "failed"]
        .map((name) => [name, path.join(root, name)]));
    Object.values(dirs).forEach((dir) => fs.mkdirSync(dir));
    const write = (location, filename, job) => fs.writeFileSync(path.join(dirs[location], filename), JSON.stringify(job));

    for (let index = 0; index < 60; index++) {
        write("review", `a-${String(index).padStart(3, "0")}.json`, {
            eventName: "event-a", filePrefix: `a-${index}`, userPhone: "+15550101000",
            style: "cartoon", reviewAt: index + 1,
        });
    }
    for (let index = 0; index < 20; index++) {
        write("review", `b-${String(index).padStart(3, "0")}.json`, {
            eventName: "event-b", filePrefix: `b-${index}`, reviewAt: index + 1,
        });
    }
    write("review", "group-a-v1.json", {
        parentJobId: "group-a", variantCount: 2, variantId: "group-a-v1",
        variantIndex: 1, variantStatus: "READY", eventName: "event-a",
        filePrefix: "group-a-v1", reviewAt: 100,
    });
    write("pending", "group-a-v2.json", {
        parentJobId: "group-a", variantCount: 2, variantId: "group-a-v2",
        variantIndex: 2, regenCount: 1, eventName: "event-a", filePrefix: "group-a-v2",
    });
    write("generating", "group-b-v1.json", {
        parentJobId: "group-b", variantCount: 2, variantIndex: 1,
        eventName: "event-a", filePrefix: "group-b-v1",
    });
    for (let index = 0; index < 40; index++) {
        write("pending", `plain-${index}.json`, { eventName: "event-a", filePrefix: `plain-${index}` });
    }

    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
        if (parent?.filename === QUEUE_PATH) {
            if (request === "./config") return {
                PENDING_DIR: dirs.pending, GENERATING_DIR: dirs.generating,
                REVIEW_DIR: dirs.review, READY_DIR: dirs.ready, PRINTING_DIR: dirs.printing,
                DONE_DIR: dirs.done, FAILED_DIR: dirs.failed,
            };
            if (request === "./settings") return { getForEvent() { return 2; } };
            if (request === "sharp") return () => {};
            if (request.startsWith("./")) return {};
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    let queue;
    try {
        delete require.cache[require.resolve(QUEUE_PATH)];
        queue = require(QUEUE_PATH);
    } finally {
        Module._load = originalLoad;
    }

    const originalReadFile = fs.promises.readFile;
    let reads = 0;
    let activeReads = 0;
    let maxActiveReads = 0;
    fs.promises.readFile = async (...args) => {
        if (!String(args[0]).startsWith(root)) return originalReadFile(...args);
        reads++;
        activeReads++;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        try {
            await new Promise((resolve) => setTimeout(resolve, 2));
            return await originalReadFile(...args);
        } finally {
            activeReads--;
        }
    };
    try {
        const first = await queue.getReviewQueue("event-a");
        assert.equal(first.length, 61, "unreviewed fan-out and plain pending jobs stay hidden");
        const group = first.find((job) => job.parentJobId === "group-a");
        assert.deepEqual(group.variants.map((variant) => variant.status), ["READY", "REGENERATING"]);
        assert.ok(maxActiveReads > 1 && maxActiveReads <= 12,
            `reads should overlap within the 12-worker cap (observed ${maxActiveReads})`);
        const initialReads = reads;

        const otherEvent = await queue.getReviewQueue("event-b");
        assert.equal(otherEvent.length, 20);
        assert.equal(reads, initialReads, "switching filters reuses one file snapshot");
        assert.strictEqual(await queue.getReviewQueue("event-a"), first,
            "the same queue snapshot keeps array identity for pagination caches");

        queue.invalidateReviewCache();
        const rescanned = await queue.getReviewQueue("event-a");
        assert.notStrictEqual(rescanned, first);
        assert.equal(reads, initialReads, "unchanged files need metadata checks but no JSON reads");

        const target = path.join(dirs.review, "a-000.json");
        fs.writeFileSync(`${target}.new`, JSON.stringify({
            eventName: "event-a", filePrefix: "a-0", style: "watercolor", reviewAt: 1,
        }));
        fs.renameSync(`${target}.new`, target);
        queue.invalidateReviewCache();
        const updated = await queue.getReviewQueue("event-a");
        assert.equal(updated.find((job) => job.filename === "a-000.json").style, "watercolor");
        assert.equal(reads, initialReads + 1, "only the replaced job is read again");

        fs.rmSync(target);
        queue.invalidateReviewCache();
        const afterRemoval = await queue.getReviewQueue("event-a");
        assert.equal(afterRemoval.length, 60);
    } finally {
        fs.promises.readFile = originalReadFile;
        delete require.cache[require.resolve(QUEUE_PATH)];
        fs.rmSync(root, { recursive: true, force: true });
    }
});

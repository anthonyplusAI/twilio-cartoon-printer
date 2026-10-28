const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { parseReviewPageRequest, paginateReviewQueue } = require("../lib/review-pagination");
const { buildReviewQueueHtml } = require("../lib/review-queue-page");

function jobs(count) {
    return Array.from({ length: count }, (_, i) => ({
        filename: `job-${String(i).padStart(3, "0")}.json`, reviewAt: 1000 + i,
    }));
}

test("review pages return bounded oldest-first cards and a stable cursor", () => {
    const original = jobs(83);
    const first = paginateReviewQueue(original, parseReviewPageRequest({ limit: "24" }));
    assert.equal(first.total, 83);
    assert.equal(first.items.length, 24);
    assert.equal(first.items[0].filename, "job-000.json");
    assert.equal(first.offset, 0);
    assert.equal(first.hasMore, true);
    assert.ok(first.cursor);

    // New and already-acted-on cards ahead of the cursor must not cause a
    // later batch to repeat or skip pending jobs.
    const changed = [{ filename: "earlier.json", reviewAt: 500 }, ...original.slice(1)];
    const second = paginateReviewQueue(changed, parseReviewPageRequest({ limit: "24", cursor: first.cursor }));
    assert.equal(second.items[0].filename, "job-024.json");
    assert.equal(second.items.length, 24);
    assert.equal(second.offset, 24);
    assert.equal(second.items.some((job) => first.items.some((seen) => seen.filename === job.filename)), false);
});

test("review pagination breaks timestamp ties by card identity", () => {
    const tied = [
        { filename: "z.json", reviewAt: 1000 },
        { filename: "a.json", reviewAt: 1000 },
        { parentJobId: "group-b", reviewAt: 1000 },
    ];
    const first = paginateReviewQueue(tied, parseReviewPageRequest({ limit: "2" }));
    const second = paginateReviewQueue(tied, parseReviewPageRequest({ limit: "2", cursor: first.cursor }));
    assert.deepEqual(first.items.map((job) => job.parentJobId || job.filename), ["a.json", "group-b"]);
    assert.deepEqual(second.items.map((job) => job.parentJobId || job.filename), ["z.json"]);
});

test("review pagination validates input and caps oversized requests", () => {
    assert.equal(parseReviewPageRequest({}), null);
    assert.throws(() => parseReviewPageRequest({ limit: "0" }), /limit/i);
    assert.throws(() => parseReviewPageRequest({ limit: "3.5" }), /limit/i);
    assert.throws(() => parseReviewPageRequest({ limit: "5", cursor: "not-a-cursor" }), /cursor/i);
    const oversized = paginateReviewQueue(jobs(150), parseReviewPageRequest({ limit: "9999" }));
    assert.equal(oversized.items.length, 60);
    assert.equal(oversized.limit, 60);
});

test("review workspace requests bounded batches and parses without runtime imports", () => {
    const html = buildReviewQueueHtml();
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        new vm.Script(match[1]);
    }
    assert.match(html, /review-workspace\.css/);
    assert.match(html, /params\.set\("limit", String\(REVIEW_PAGE_SIZE\)\)/);
    assert.match(html, /review\/api\/thumbnail/);
    assert.match(html, /loading="lazy" decoding="async"/);
    assert.match(html, /id="reviewPagination"/);
});

test("review card actions remain valid for quoted event names and IDs", () => {
    const html = buildReviewQueueHtml();
    const clientScript = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
    const withoutBoot = clientScript.split("// Poll every 5s")[0];
    const context = vm.createContext({
        window: { location: { search: "" } },
        document: { body: { addEventListener() {} } },
        URLSearchParams,
    });
    new vm.Script(withoutBoot).runInContext(context);

    const shared = { eventName: "Kid's & Family", filePrefix: "photo-'1", reviewAt: 1000 };
    const single = vm.runInContext("renderSingleCard(job)", vm.createContext({ ...context, job: {
        ...shared, filename: "photo-'1.json", style: "Cartoon",
    } }));
    const multi = vm.runInContext("renderMultiCard(job)", vm.createContext({ ...context, job: {
        ...shared, parentJobId: "group-'1", variantCount: 1,
        variants: [{ variantId: "variant-'1", filePrefix: shared.filePrefix, status: "READY" }],
    } }));

    for (const card of [single, multi]) {
        const handlers = [...card.matchAll(/\bonclick="([^"]*)"/g)].map((match) => match[1]
            .replaceAll("&quot;", '"').replaceAll("&#39;", "'")
            .replaceAll("&lt;", "<").replaceAll("&gt;", ">")
            .replaceAll("&amp;", "&"));
        assert.ok(handlers.length > 0);
        for (const handler of handlers) assert.doesNotThrow(() => new vm.Script(handler));
    }
});

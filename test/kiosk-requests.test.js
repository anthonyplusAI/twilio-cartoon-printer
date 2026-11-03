const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const requests = require("../lib/kiosk-requests");

test("a repeated kiosk upload returns its original job without enqueueing twice", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-requests-"));
    const input = {
        requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        digest: "same-photo-and-options",
        eventName: "Event",
        dir,
        lookupJob: async () => null,
    };
    try {
        assert.deepEqual(await requests.claim(input), { kind: "new" });
        assert.equal((await requests.claim(input)).kind, "in_progress");
        await requests.complete(input, "20261103_121314-a1b2c3d4");
        assert.deepEqual(await requests.claim(input), { kind: "existing", filePrefix: "20261103_121314-a1b2c3d4" });
        await assert.rejects(requests.claim({ ...input, digest: "different-photo" }), (err) => err.status === 409);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("stale claim recovers a queued job after a crash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-requests-"));
    const input = {
        requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        digest: "same-photo-and-options",
        eventName: "Event",
        dir,
        lookupJob: async () => "20261103_121315-abcdef12",
    };
    try {
        assert.deepEqual(await requests.claim(input), { kind: "new" });
        assert.deepEqual(await requests.claim(input), { kind: "existing", filePrefix: "20261103_121315-abcdef12" });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("an old partial claim can be reclaimed after a crash", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-requests-"));
    const input = {
        requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        digest: "same-photo-and-options",
        eventName: "Event",
        dir,
        lookupJob: async () => null,
    };
    try {
        const filePath = requests.requestPath(input.requestId, dir);
        fs.writeFileSync(filePath, '{"state":"processing"');
        const old = new Date(Date.now() - 10 * 60 * 1000);
        fs.utimesSync(filePath, old, old);
        assert.deepEqual(await requests.claim(input), { kind: "new" });
        assert.equal(JSON.parse(fs.readFileSync(filePath, "utf8")).digest, input.digest);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("event reset removes only that event's kiosk idempotency records", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-requests-"));
    const first = {
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        digest: "first",
        eventName: "First Event",
        dir,
    };
    const second = { ...first, requestId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", eventName: "Second Event" };
    try {
        await requests.claim(first);
        await requests.complete(first, "first-prefix");
        await requests.claim(second);
        await requests.complete(second, "second-prefix");
        assert.equal(await requests.deleteByEvent("First Event", dir), 1);
        assert.equal(fs.existsSync(requests.requestPath(first.requestId, dir)), false);
        assert.equal(fs.existsSync(requests.requestPath(second.requestId, dir)), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

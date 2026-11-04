const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { DONE_DIR } = require("../lib/config");
const cache = require("../lib/delivery-scan-cache");

test("hourly settled-job rescans are spread across maintenance passes", (t) => {
    const realNow = Date.now;
    const startedAt = 1_800_000_000_000;
    let now = startedAt;
    Date.now = () => now;
    t.after(() => { Date.now = realNow; });

    const files = Array.from({ length: 1000 }, (_, index) =>
        path.join(DONE_DIR, `rescan-stagger-${index}.json`));
    for (const filepath of files) {
        const entry = cache.beginRead(filepath, "voice");
        assert.ok(entry);
        cache.markQuiet(filepath, "voice", entry);
    }

    const refreshed = new Set();
    let busiestMinute = 0;
    for (let minute = 1; minute <= 60; minute++) {
        now = startedAt + minute * 60_000;
        let due = 0;
        for (const filepath of files) {
            if (refreshed.has(filepath) || !cache.beginRead(filepath, "voice")) continue;
            refreshed.add(filepath);
            due++;
        }
        busiestMinute = Math.max(busiestMinute, due);
    }
    assert.equal(refreshed.size, files.length, "every quiet job still receives a safety rescan");
    assert.ok(busiestMinute < 100,
        `one minute reopened ${busiestMinute} of ${files.length} quiet jobs`);
});

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { sweepStaleKioskUploads } = require("../lib/api-generate");

test("crash cleanup removes only old private kiosk upload copies", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-uploads-"));
    const oldFile = path.join(dir, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg");
    const newFile = path.join(dir, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg");
    const unrelated = path.join(dir, "other.jpg");
    const now = Date.now();
    try {
        for (const file of [oldFile, newFile, unrelated]) fs.writeFileSync(file, "private image");
        const old = new Date(now - 2 * 60 * 60 * 1000);
        fs.utimesSync(oldFile, old, old);
        fs.utimesSync(unrelated, old, old);
        assert.equal(await sweepStaleKioskUploads({ dir, now }), 1);
        assert.equal(fs.existsSync(oldFile), false);
        assert.equal(fs.existsSync(newFile), true);
        assert.equal(fs.existsSync(unrelated), true);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

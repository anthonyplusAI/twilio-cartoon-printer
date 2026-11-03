const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const settings = require("../lib/settings");
const { jobPaths, moveStagedToFinal } = require("../lib/pipeline");

test("kiosk output is not published before its MMS derivative", async () => {
    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-publish-order-"));
    const getDownloadDir = settings.getDownloadDir;
    const rename = fs.promises.rename;
    const job = {
        kioskSubmission: true,
        eventName: "Kiosk Publish Test",
        filePrefix: `kiosk_publish_${process.pid}`,
        style: "cartoon",
    };
    settings.getDownloadDir = () => downloadDir;

    try {
        const staged = jobPaths(job, { staged: true });
        const published = jobPaths(job);
        fs.writeFileSync(staged.inputPath, "private selfie");
        fs.writeFileSync(staged.mmsPath, "mms derivative");
        fs.writeFileSync(staged.outputPath, "finished portrait");

        fs.promises.rename = async (src, dst) => {
            if (dst === published.outputPath) {
                const error = new Error("interrupted before final output publication");
                error.code = "EIO";
                throw error;
            }
            return rename(src, dst);
        };
        await assert.rejects(moveStagedToFinal(job), /interrupted before final output publication/);

        assert.equal(fs.readFileSync(published.mmsPath, "utf8"), "mms derivative");
        assert.equal(fs.existsSync(published.outputPath), false,
            "the PNG commit marker must remain absent until all delivery media exists");
        assert.equal(fs.readFileSync(staged.outputPath, "utf8"), "finished portrait");
        assert.equal(fs.readFileSync(staged.inputPath, "utf8"), "private selfie");

        fs.promises.rename = rename;
        await moveStagedToFinal(job);
        assert.equal(fs.readFileSync(published.outputPath, "utf8"), "finished portrait");
        assert.equal(fs.readFileSync(published.mmsPath, "utf8"), "mms derivative");
        assert.equal(fs.existsSync(staged.inputPath), false);
    } finally {
        fs.promises.rename = rename;
        settings.getDownloadDir = getDownloadDir;
        fs.rmSync(downloadDir, { recursive: true, force: true });
    }
});

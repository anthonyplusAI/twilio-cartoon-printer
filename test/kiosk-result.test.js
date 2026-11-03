const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");

const settings = require("../lib/settings");
const { FAILED_DIR, DONE_DIR, PRINTING_DIR } = require("../lib/config");
const { mountApiGenerate } = require("../lib/api-generate");

test("original kiosk result URL follows the approved variant", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kiosk-result-"));
    const suffix = `${process.pid}_${Date.now()}`;
    const originalPrefix = `kiosk_result_${suffix}-v1`;
    const chosenPrefix = `kiosk_result_${suffix}-v2`;
    const originalPath = path.join(FAILED_DIR, `${originalPrefix}.json`);
    const chosenPath = path.join(DONE_DIR, `${chosenPrefix}.json`);
    const printingPath = path.join(PRINTING_DIR, `${chosenPrefix}.json`);
    const failedPrintPath = path.join(FAILED_DIR, `${chosenPrefix}.json`);
    const originalDownloadDir = settings.getDownloadDir;
    let server;
    settings.getDownloadDir = () => tempDir;
    fs.mkdirSync(FAILED_DIR, { recursive: true });
    fs.mkdirSync(DONE_DIR, { recursive: true });
    fs.writeFileSync(originalPath, JSON.stringify({
        filePrefix: originalPrefix,
        eventName: "Kiosk Result Event",
        kioskSubmission: true,
        variantStatus: "SUPERSEDED",
        failReason: "superseded",
        kioskResultPrefix: chosenPrefix,
    }));
    fs.writeFileSync(chosenPath, JSON.stringify({
        filePrefix: chosenPrefix,
        eventName: "Kiosk Result Event",
        kioskSubmission: true,
        channel: "email",
        kioskDeliveryState: "accepted",
        baseUrl: "https://booth.example.test",
    }));
    fs.writeFileSync(path.join(tempDir, `${chosenPrefix}_output.png`), "approved portrait");

    try {
        const app = express();
        mountApiGenerate(app);
        server = await new Promise((resolve, reject) => {
            const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
            listening.on("error", reject);
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}/api/generate/${originalPrefix}`;
        const statusResponse = await fetch(`${baseUrl}/status`);
        assert.equal(statusResponse.status, 200);
        const status = await statusResponse.json();
        assert.equal(status.filePrefix, originalPrefix);
        assert.equal(status.resultPrefix, chosenPrefix);
        assert.equal(status.state, "done");
        assert.match(status.shareUrl, new RegExp(`/s/${chosenPrefix}\\?`));
        assert.equal(status.delivery.state, "accepted");

        const waitResponse = await fetch(`${baseUrl}/wait?timeout=5000`, { redirect: "manual" });
        assert.equal(waitResponse.status, 303);
        assert.equal(waitResponse.headers.get("location"), `/api/generate/${originalPrefix}/result`);

        const resultResponse = await fetch(`${baseUrl}/result`);
        assert.equal(resultResponse.status, 200);
        assert.equal(await resultResponse.text(), "approved portrait");
        assert.match(resultResponse.headers.get("content-disposition"), new RegExp(chosenPrefix));

        // The published image remains available while the relay prints it,
        // and even if the physical print later fails.
        fs.mkdirSync(PRINTING_DIR, { recursive: true });
        fs.renameSync(chosenPath, printingPath);
        const printingStatus = await (await fetch(`${baseUrl}/status`)).json();
        assert.equal(printingStatus.state, "printing");
        assert.ok(printingStatus.resultUrl);
        assert.equal((await fetch(`${baseUrl}/result`)).status, 200);

        const printJob = JSON.parse(fs.readFileSync(printingPath, "utf8"));
        printJob.failReason = "printer";
        fs.writeFileSync(printingPath, JSON.stringify(printJob));
        fs.renameSync(printingPath, failedPrintPath);
        const failedPrintStatus = await (await fetch(`${baseUrl}/status`)).json();
        assert.equal(failedPrintStatus.state, "failed");
        assert.equal(failedPrintStatus.failReason, "printer");
        assert.ok(failedPrintStatus.resultUrl);
        assert.equal((await fetch(`${baseUrl}/result`)).status, 200);
    } finally {
        if (server) await new Promise((resolve) => server.close(resolve));
        settings.getDownloadDir = originalDownloadDir;
        fs.rmSync(originalPath, { force: true });
        fs.rmSync(chosenPath, { force: true });
        fs.rmSync(printingPath, { force: true });
        fs.rmSync(failedPrintPath, { force: true });
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

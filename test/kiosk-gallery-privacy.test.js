const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const sharp = require("sharp");

const settings = require("../lib/settings");
const { DONE_DIR } = require("../lib/config");
const { mountPhotoGallery, invalidatePhotoGalleryCache, rememberPublicApiInput } = require("../lib/photogallery");

const EVENT = "__kiosk_gallery_privacy_test__";
const EVENT_DIR = settings.getDownloadDir(EVENT);
const PRIVATE_PREFIX = "29991231_235949_private";
const LEGACY_PREFIX = "29991231_235950_legacy";
const RAW_NAME = "api_123e4567-e89b-12d3-a456-426614174000_input.jpg";
const PUBLIC_PREFIX = "29991231_235951_api";
const PUBLIC_RAW_NAME = "api_123e4567-e89b-12d3-a456-426614174001_input.jpg";
const NEW_PUBLIC_RAW_NAME = "api_123e4567-e89b-12d3-a456-426614174002_input.jpg";
const JOB_PATHS = [PRIVATE_PREFIX, LEGACY_PREFIX, PUBLIC_PREFIX].map((prefix) => path.join(DONE_DIR, `${prefix}.json`));

async function request(app, method, requestPath, body) {
    const server = await new Promise((resolve) => {
        const listening = app.listen(0, () => resolve(listening));
    });
    try {
        return await new Promise((resolve, reject) => {
            const payload = body ? Buffer.from(JSON.stringify(body)) : null;
            const req = http.request({
                port: server.address().port,
                method,
                path: requestPath,
                headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {},
            }, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
            });
            req.on("error", reject);
            req.end(payload);
        });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function writePortrait(prefix) {
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ae2e45" } })
        .png().toFile(path.join(EVENT_DIR, `${prefix}_output.png`));
}

after(() => {
    for (const jobPath of JOB_PATHS) fs.rmSync(jobPath, { force: true });
    fs.rmSync(EVENT_DIR, { recursive: true, force: true });
    invalidatePhotoGalleryCache(EVENT, { styles: true });
});

test("completed kiosk portraits stay in the photo book without exposing original selfies", async () => {
    fs.mkdirSync(EVENT_DIR, { recursive: true });
    fs.mkdirSync(DONE_DIR, { recursive: true });
    await writePortrait(PRIVATE_PREFIX);
    await writePortrait(LEGACY_PREFIX);
    fs.writeFileSync(path.join(EVENT_DIR, `${LEGACY_PREFIX}_input.jpg`), "legacy-original");
    fs.writeFileSync(path.join(EVENT_DIR, RAW_NAME), "legacy-raw-upload");
    for (const prefix of [PRIVATE_PREFIX, LEGACY_PREFIX]) {
        fs.writeFileSync(path.join(DONE_DIR, `${prefix}.json`), JSON.stringify({
            eventName: EVENT,
            filePrefix: prefix,
            kioskSubmission: true,
            style: "cartoon",
            uploadedInputFile: prefix === LEGACY_PREFIX ? RAW_NAME : undefined,
        }));
    }
    invalidatePhotoGalleryCache(EVENT, { styles: true });

    const app = express();
    mountPhotoGallery(app);
    const response = await request(app, "GET", `/photogallery/api/images?event=${EVENT}`);
    assert.equal(response.status, 200);
    const images = JSON.parse(response.body).images;
    assert.deepEqual(images.map((image) => image.prefix), [LEGACY_PREFIX, PRIVATE_PREFIX]);
    assert.deepEqual(images.map((image) => image.hasSelfie), [false, false]);
    assert.equal((await request(app, "GET", `/photogallery/img/${EVENT}/${PRIVATE_PREFIX}_output.png`)).status, 200);
    assert.equal((await request(app, "GET", `/photogallery/img/${EVENT}/${LEGACY_PREFIX}_input.jpg`)).status, 404);
    assert.equal((await request(app, "GET", `/photogallery/thumb/${EVENT}/${LEGACY_PREFIX}_input.jpg`)).status, 404);
    assert.equal((await request(app, "GET", `/photogallery/img/${EVENT}/${RAW_NAME}`)).status, 404);

    // Historical programmatic API uploads used the same raw filename shape.
    // Their public source URL must remain fetchable by the generation worker.
    fs.writeFileSync(path.join(EVENT_DIR, PUBLIC_RAW_NAME), "public-api-upload");
    fs.writeFileSync(path.join(DONE_DIR, `${PUBLIC_PREFIX}.json`), JSON.stringify({
        eventName: EVENT,
        filePrefix: PUBLIC_PREFIX,
        apiSubmission: true,
        kioskSubmission: false,
        uploadedInputFile: PUBLIC_RAW_NAME,
    }));
    assert.equal((await request(app, "GET", `/photogallery/img/${EVENT}/${PUBLIC_RAW_NAME}`)).status, 200);
});

test("new programmatic API input is fetchable before its job is indexed", async () => {
    fs.writeFileSync(path.join(EVENT_DIR, NEW_PUBLIC_RAW_NAME), "new-public-api-upload");
    rememberPublicApiInput(EVENT, NEW_PUBLIC_RAW_NAME);
    const app = express();
    mountPhotoGallery(app);
    assert.equal((await request(app, "GET", `/photogallery/img/${EVENT}/${NEW_PUBLIC_RAW_NAME}`)).status, 200);
});

test("targeted selfie deletion also removes a legacy kiosk raw upload", async () => {
    const app = express();
    mountPhotoGallery(app);
    const response = await request(app, "DELETE", "/photogallery/api/images", {
        event: EVENT,
        items: [{ prefix: LEGACY_PREFIX, type: "selfie" }],
    });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(path.join(EVENT_DIR, `${LEGACY_PREFIX}_input.jpg`)), false);
    assert.equal(fs.existsSync(path.join(EVENT_DIR, RAW_NAME)), false);
    assert.equal(fs.existsSync(path.join(EVENT_DIR, `${LEGACY_PREFIX}_output.png`)), true);

    fs.writeFileSync(path.join(EVENT_DIR, `${LEGACY_PREFIX}_input.jpg`), "legacy-original");
    fs.writeFileSync(path.join(EVENT_DIR, RAW_NAME), "legacy-raw-upload");
    const aiResponse = await request(app, "DELETE", "/photogallery/api/images", {
        event: EVENT,
        items: [{ prefix: LEGACY_PREFIX, type: "ai" }],
    });
    assert.equal(aiResponse.status, 200);
    assert.equal(fs.existsSync(path.join(EVENT_DIR, `${LEGACY_PREFIX}_output.png`)), false);
    assert.equal(fs.existsSync(path.join(EVENT_DIR, `${LEGACY_PREFIX}_input.jpg`)), false);
    assert.equal(fs.existsSync(path.join(EVENT_DIR, RAW_NAME)), false);
});

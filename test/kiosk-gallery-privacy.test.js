const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const express = require("express");
const sharp = require("sharp");

const settings = require("../lib/settings");
const { DONE_DIR } = require("../lib/config");
const { mountPhotoGallery, invalidatePhotoGalleryCache, rememberPublicApiInput, isPrivateKioskImage } = require("../lib/photogallery");
const { buildPageHtml } = require("../lib/photogallery-page");

const EVENT = "__kiosk_gallery_privacy_test__";
const EVENT_DIR = settings.getDownloadDir(EVENT);
const PRIVATE_PREFIX = "29991231_235949_private";
const LEGACY_PREFIX = "29991231_235950_legacy";
const RAW_NAME = "api_123e4567-e89b-12d3-a456-426614174000_input.jpg";
const PUBLIC_PREFIX = "29991231_235951_api";
const CONSENTED_PREFIX = "29991231_235952_consented";
const PUBLIC_RAW_NAME = "api_123e4567-e89b-12d3-a456-426614174001_input.jpg";
const NEW_PUBLIC_RAW_NAME = "api_123e4567-e89b-12d3-a456-426614174002_input.jpg";
const JOB_PATHS = [PRIVATE_PREFIX, LEGACY_PREFIX, PUBLIC_PREFIX, CONSENTED_PREFIX]
    .map((prefix) => path.join(DONE_DIR, `${prefix}.json`));

test("unsafe approved-image paths never bypass kiosk original privacy", async () => {
    assert.equal(await isPrivateKioskImage(EVENT, `./${PRIVATE_PREFIX}_input.jpg`), true);
    assert.equal(await isPrivateKioskImage(EVENT, `nested/${PRIVATE_PREFIX}_input.jpg`), true);
});

test("a legacy kiosk original stays private when its file reaches another event before job metadata", async () => {
    const fromEvent = `__kiosk_move_source_${process.pid}__`;
    const toEvent = `__kiosk_move_target_${process.pid}__`;
    const targetDir = settings.getDownloadDir(toEvent);
    const kioskPrefix = `kiosk_move_private_${process.pid}`;
    const regularPrefix = `regular_move_public_${process.pid}`;
    const kioskJob = path.join(DONE_DIR, `${kioskPrefix}.json`);
    const regularJob = path.join(DONE_DIR, `${regularPrefix}.json`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.mkdirSync(DONE_DIR, { recursive: true });
    fs.writeFileSync(kioskJob, JSON.stringify({
        filePrefix: kioskPrefix, eventName: fromEvent, kioskSubmission: true,
    }));
    fs.writeFileSync(regularJob, JSON.stringify({
        filePrefix: regularPrefix, eventName: fromEvent, kioskSubmission: false,
    }));
    fs.writeFileSync(path.join(targetDir, `${kioskPrefix}_input.jpg`), "private-original");
    fs.writeFileSync(path.join(targetDir, `${regularPrefix}_input.jpg`), "public-original");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ae2e45" } })
        .png().toFile(path.join(targetDir, `${kioskPrefix}_output.png`));
    invalidatePhotoGalleryCache(toEvent, { styles: true });
    const app = express();
    mountPhotoGallery(app);
    try {
        assert.equal((await request(app, "GET", `/photogallery/img/${toEvent}/${kioskPrefix}_input.jpg`)).status, 404);
        assert.equal((await request(app, "GET", `/photogallery/img/${toEvent}/${regularPrefix}_input.jpg`)).status, 200);
        const listing = await request(app, "GET", `/photogallery/api/images?event=${toEvent}`);
        assert.equal(listing.status, 200);
        assert.equal(JSON.parse(listing.body).images.find((image) => image.prefix === kioskPrefix).hasSelfie, false);
    } finally {
        fs.rmSync(kioskJob, { force: true });
        fs.rmSync(regularJob, { force: true });
        fs.rmSync(targetDir, { recursive: true, force: true });
        invalidatePhotoGalleryCache(toEvent, { styles: true });
    }
});

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

function photoBookFor(imageOrImages) {
    const bookImages = Array.isArray(imageOrImages) ? imageOrImages : [imageOrImages];
    const html = buildPageHtml(EVENT, "en");
    const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
    const urlStart = script.indexOf("function imgUrl(img)");
    const urlEnd = script.indexOf("function thumbUrl(img", urlStart);
    const bookStart = script.indexOf("function initBook() {");
    const bookEnd = script.indexOf("\nvar _fetchingImages", bookStart);
    const modalStart = script.indexOf("var _photoModalIdx = -1;");
    const modalEnd = script.indexOf("// Book images carry their current page index", modalStart);
    assert.ok(urlStart >= 0 && urlEnd > urlStart && bookStart >= 0 && bookEnd > bookStart
        && modalStart >= 0 && modalEnd > modalStart);

    function element() {
        return {
            children: [], dataset: {}, style: { setProperty() {} }, innerHTML: "", id: "",
            classList: { add() {}, remove() {} },
            appendChild(child) { this.children.push(child); },
            addEventListener() {},
        };
    }
    const wrap = element();
    wrap.clientWidth = 1200;
    wrap.clientHeight = 800;
    const modal = element();
    const modalImage = element();
    const nodes = {
        bookWrap: wrap, emptyMsg: element(), bottomBar: element(), thumbs: element(),
        photoModal: modal, photoModalImg: modalImage,
    };
    const context = vm.createContext({
        document: {
            getElementById: (id) => nodes[id] || null,
            createElement: element,
            addEventListener() {},
            removeEventListener() {},
        },
        window: {},
        images: bookImages, galleryTotal: bookImages.length, pageOffset: 0, bookUsesTurn: false,
        hydrateBookPages() {}, getBookRatio: () => 1.5,
        getBookSize: () => ({ width: 900, height: 600 }),
        setBookPage() {}, highlightThumbs() {},
        htmlEscape: (value) => String(value),
        setTimeout(callback) { callback(); },
    });
    new vm.Script(script.slice(urlStart, urlEnd) + script.slice(bookStart, bookEnd)
        + script.slice(modalStart, modalEnd)).runInContext(context);
    vm.runInContext("initBook()", context);
    const book = wrap.children[0].children.find((child) => child.id === "book");
    return { context, page: book.children[0], modalImage };
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

test("consented kiosk original is visible only after its finished portrait is published", async () => {
    fs.mkdirSync(EVENT_DIR, { recursive: true });
    fs.mkdirSync(DONE_DIR, { recursive: true });
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } })
        .jpeg().toFile(path.join(EVENT_DIR, `${CONSENTED_PREFIX}_input.jpg`));
    fs.writeFileSync(path.join(DONE_DIR, `${CONSENTED_PREFIX}.json`), JSON.stringify({
        eventName: EVENT,
        filePrefix: CONSENTED_PREFIX,
        kioskSubmission: true,
        kioskOriginalPublic: true,
        style: "cartoon",
    }));
    invalidatePhotoGalleryCache(EVENT, { styles: true });
    const app = express();
    mountPhotoGallery(app);

    assert.equal((await request(app, "GET", `/photogallery/img/${EVENT}/${CONSENTED_PREFIX}_input.jpg`)).status, 404);
    await writePortrait(CONSENTED_PREFIX);
    invalidatePhotoGalleryCache(EVENT, { styles: true });
    const response = await request(app, "GET", `/photogallery/api/images?event=${EVENT}`);
    assert.equal(response.status, 200);
    const image = JSON.parse(response.body).images.find(({ prefix }) => prefix === CONSENTED_PREFIX);
    assert.equal(image.hasSelfie, true);
    assert.equal((await request(app, "GET", `/photogallery/img/${EVENT}/${CONSENTED_PREFIX}_input.jpg`)).status, 200);
    assert.equal((await request(app, "GET", `/photogallery/thumb/${EVENT}/${CONSENTED_PREFIX}_input.jpg`)).status, 200);

    const { context, page, modalImage } = photoBookFor(image);
    assert.match(page.innerHTML, /class="flip-btn"[^>]*>View Original<\/button>/);
    assert.match(page.innerHTML, new RegExp(`${CONSENTED_PREFIX}_input\\.jpg`));
    vm.runInContext("openPhotoModal(imgUrl(images[0]), 0, 'portrait')", context);
    assert.match(modalImage.src, new RegExp(`${CONSENTED_PREFIX}_output\\.png$`));
    vm.runInContext("_photoModalKeys({ key: ' ', code: 'Space', preventDefault() {} })", context);
    assert.match(modalImage.src, new RegExp(`${CONSENTED_PREFIX}_input\\.jpg$`));
    vm.runInContext("_photoModalKeys({ key: ' ', code: 'Space', preventDefault() {} })", context);
    assert.match(modalImage.src, new RegExp(`${CONSENTED_PREFIX}_output\\.png$`));
});

test("photo modal arrow keys show a portrait for legacy kiosk images and resume originals", () => {
    const images = [
        { event: EVENT, file: "new_kiosk_a_output.png", hasSelfie: true },
        { event: EVENT, file: "legacy_kiosk_output.png", hasSelfie: false },
        { event: EVENT, file: "new_kiosk_b_output.png", hasSelfie: true },
    ];
    const { context, modalImage } = photoBookFor(images);
    vm.runInContext("openPhotoModal('/photogallery/img/__kiosk_gallery_privacy_test__/new_kiosk_a_input.jpg', 0, 'original')", context);

    vm.runInContext("_photoModalKeys({ key: 'ArrowRight', preventDefault() {} })", context);
    assert.equal(modalImage.src, `/photogallery/img/${EVENT}/legacy_kiosk_output.png`);
    assert.equal(modalImage.alt, "Portrait");

    vm.runInContext("_photoModalKeys({ key: 'ArrowRight', preventDefault() {} })", context);
    assert.equal(modalImage.src, `/photogallery/img/${EVENT}/new_kiosk_b_input.jpg`);
    assert.equal(modalImage.alt, "Original selfie");

    vm.runInContext("_photoModalKeys({ key: 'ArrowLeft', preventDefault() {} })", context);
    assert.equal(modalImage.src, `/photogallery/img/${EVENT}/legacy_kiosk_output.png`);
    assert.equal(modalImage.alt, "Portrait");
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

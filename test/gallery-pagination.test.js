const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");
const express = require("express");
const sharp = require("sharp");

const settings = require("../lib/settings");
const { buildPageHtml, mountPhotoGallery, invalidatePhotoGalleryCache } = require("../lib/photogallery");

const EVENT = "__gallery_pagination_test__";
const eventDir = settings.getDownloadDir(EVENT);
const filenames = Array.from({ length: 127 }, (_, i) => `29990101_000000_${String(i).padStart(4, "0")}_output.png`);

function get(app, requestPath) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            http.get({ port: server.address().port, path: requestPath }, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const rawBody = Buffer.concat(chunks);
                    server.close(() => resolve({ status: res.statusCode, body: rawBody.toString("utf8"), rawBody, headers: res.headers }));
                });
            }).on("error", (err) => server.close(() => reject(err)));
        });
    });
}

before(() => {
    fs.mkdirSync(eventDir, { recursive: true });
    for (const file of filenames) fs.writeFileSync(path.join(eventDir, file), "not-a-real-png");
});

after(() => {
    fs.rmSync(eventDir, { recursive: true, force: true });
    invalidatePhotoGalleryCache(EVENT, { styles: true });
});

test("a gallery page returns a bounded newest slice and enriches only that slice", async () => {
    const app = express();
    mountPhotoGallery(app);
    const originalReadFile = fs.promises.readFile;
    let jobMetadataReads = 0;
    fs.promises.readFile = async function countedReadFile(file, ...args) {
        if (String(file).includes("29990101_000000_")) jobMetadataReads++;
        return originalReadFile.call(this, file, ...args);
    };
    try {
        const response = await get(app, `/photogallery/api/images?event=${EVENT}&limit=24`);
        const payload = JSON.parse(response.body);
        assert.equal(response.status, 200);
        assert.equal(payload.total, filenames.length);
        assert.equal(payload.images.length, 24);
        assert.equal(payload.images[0].file, filenames.at(-1));
        assert.equal(payload.offset, 0);
        assert.equal(payload.hasMore, true);
        assert.equal(typeof payload.cursor, "string");
        assert.ok(jobMetadataReads > 0 && jobMetadataReads <= 24 * 7,
            `expected metadata for only 24 photos, got ${jobMetadataReads} reads`);
    } finally {
        fs.promises.readFile = originalReadFile;
    }
});

test("a gallery cursor remains stable when a newer photo arrives", async () => {
    const app = express();
    mountPhotoGallery(app);
    const first = JSON.parse((await get(app, `/photogallery/api/images?event=${EVENT}&limit=24`)).body);
    const newFile = "29990101_000000_9999_output.png";
    fs.writeFileSync(path.join(eventDir, newFile), "not-a-real-png");
    invalidatePhotoGalleryCache(EVENT);
    try {
        const secondResponse = await get(app,
            `/photogallery/api/images?event=${EVENT}&limit=24&cursor=${encodeURIComponent(first.cursor)}`);
        const second = JSON.parse(secondResponse.body);
        assert.equal(secondResponse.status, 200);
        assert.equal(second.total, filenames.length + 1);
        assert.equal(second.offset, 25);
        assert.equal(second.images.length, 24);
        assert.equal(second.images[0].file, filenames.at(-25));
        assert.equal(second.images.some((image) => first.images.some((prior) => prior.file === image.file)), false);
    } finally {
        fs.unlinkSync(path.join(eventDir, newFile));
        invalidatePhotoGalleryCache(EVENT);
    }
});

test("invalid gallery pagination input is rejected without breaking the legacy API", async () => {
    const app = express();
    mountPhotoGallery(app);
    const malformed = await get(app, `/photogallery/api/images?event=${EVENT}&limit=24&cursor=invalid`);
    const tooLarge = JSON.parse((await get(app, `/photogallery/api/images?event=${EVENT}&limit=9999`)).body);
    const legacy = JSON.parse((await get(app, `/photogallery/api/images?event=${EVENT}`)).body);
    assert.equal(malformed.status, 400);
    assert.equal(tooLarge.images.length, 100);
    assert.equal(legacy.images.length, filenames.length);
});

test("an empty event returns an empty page instead of a gallery error", async () => {
    const app = express();
    mountPhotoGallery(app);
    const response = await get(app, `/photogallery/api/images?event=${EVENT}_missing&limit=24`);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), {
        images: [], total: 0, activeStyleCount: 0, offset: 0, hasMore: false, cursor: null,
    });
});

test("the photo book exposes batch navigation and pauses background fetching", () => {
    const html = buildPageHtml(EVENT, "en");
    assert.match(html, /id="olderBatchBtn"/);
    assert.match(html, /id="newerBatchBtn"/);
    assert.match(html, /galleryQuery\(pageCursor, IMAGE_PAGE_SIZE\)/);
    assert.match(html, /document\.addEventListener\("visibilitychange"/);
    assert.match(html, /loading="lazy" decoding="async"/);
    assert.match(html, /gallery-workspace\.css/);
});

test("a one-style batch still labels its portraits", () => {
    const html = buildPageHtml(EVENT, "en");
    const clientScript = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
    const start = clientScript.indexOf("function initBook() {");
    const end = clientScript.indexOf("\nvar _fetchingImages", start);
    assert.ok(start >= 0 && end > start);

    function element() {
        return {
            children: [], dataset: {}, style: {}, innerHTML: "", className: "", id: "",
            classList: { add() {}, remove() {} },
            appendChild(child) { this.children.push(child); },
            addEventListener() {},
        };
    }
    const wrap = element();
    wrap.clientWidth = 1200;
    wrap.clientHeight = 800;
    const nodes = { bookWrap: wrap, emptyMsg: element(), bottomBar: element(), thumbs: element() };
    const context = vm.createContext({
        document: {
            getElementById: (id) => nodes[id] || null,
            createElement: element,
        },
        window: {},
        images: [
            { style: "Cartoon", hasSelfie: false },
            { style: "Cartoon", hasSelfie: false },
            { style: null, hasSelfie: false },
        ],
        activeStyleCount: 1, // The page API only counted this loaded slice.
        galleryTotal: 127,
        pageOffset: 0,
        bookUsesTurn: false,
        hydrateBookPages() {},
        getBookSize: () => ({ width: 900, height: 600 }),
        setBookPage() {},
        highlightThumbs() {},
        imgUrl: () => "/portrait",
        htmlEscape: (value) => String(value).replaceAll("&", "&amp;"),
    });
    new vm.Script(clientScript.slice(start, end)).runInContext(context);
    vm.runInContext("initBook()", context);

    const book = wrap.children[0].children.find((child) => child.id === "book");
    assert.equal(book.children.length, 3);
    assert.match(book.children[0].innerHTML, /class="style-tag [^"]*">Cartoon<\/div>/);
    assert.match(book.children[1].innerHTML, /class="style-tag [^"]*">Cartoon<\/div>/);
    assert.doesNotMatch(book.children[2].innerHTML, /class="style-tag /);
});

test("gallery footer labels and preview controls are localized for Portuguese visitors", () => {
    for (const adminNav of [false, true]) {
        const portuguese = buildPageHtml(EVENT, "pt_BR", { adminNav });
        assert.match(portuguese, /id="newerBatchBtn"[^>]*>Fotos mais recentes<\/button>/);
        assert.match(portuguese, /id="olderBatchBtn"[^>]*>Fotos mais antigas<\/button>/);
        assert.match(portuguese, /id="thumbScrollPrev"[^>]*aria-label="Rolar prévias para a esquerda"/);
        assert.match(portuguese, /id="thumbScrollNext"[^>]*aria-label="Rolar prévias para a direita"/);
        assert.match(portuguese, /id="thumbs"[^>]*aria-label="Prévia dos retratos"/);
        assert.match(portuguese, /Novos retratos disponíveis/);
        assert.match(portuguese, /Exibindo/);

        const english = buildPageHtml(EVENT, "en", { adminNav });
        assert.match(english, /id="newerBatchBtn"[^>]*>Newer photos<\/button>/);
        assert.match(english, /id="olderBatchBtn"[^>]*>Older photos<\/button>/);
        assert.match(english, /id="thumbScrollPrev"[^>]*aria-label="Scroll previews left"/);
        assert.match(english, /id="thumbScrollNext"[^>]*aria-label="Scroll previews right"/);
    }
});

test("gallery thumbnails resize images and never cache original selfies publicly", async () => {
    const event = "__gallery_thumbnails_test__";
    const dir = settings.getDownloadDir(event);
    const prefix = "29990101_000000_thumb";
    fs.mkdirSync(dir, { recursive: true });
    try {
        await sharp({ create: { width: 1800, height: 1200, channels: 3, background: "#336699" } })
            .png().toFile(path.join(dir, `${prefix}_output.png`));
        await sharp({ create: { width: 1200, height: 1800, channels: 3, background: "#aa3366" } })
            .jpeg().toFile(path.join(dir, `${prefix}_input.jpg`));
        const app = express();
        mountPhotoGallery(app);
        const output = await get(app, `/photogallery/thumb/${event}/${prefix}_output.png`);
        const selfie = await get(app, `/photogallery/thumb/${event}/${prefix}_input.jpg`);
        assert.equal(output.status, 200);
        assert.match(output.headers["content-type"], /^image\/webp/);
        assert.ok((await sharp(output.rawBody).metadata()).width <= 320);
        assert.equal(selfie.status, 200);
        assert.equal(selfie.headers["cache-control"], "private, no-store");
        assert.equal((await get(app, `/photogallery/thumb/${event}/not-an-image.txt`)).status, 400);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

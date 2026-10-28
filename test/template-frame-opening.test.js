const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");

const settings = require("../lib/settings");
const { compositeWithTemplate } = require("../lib/helpers");

async function renderSyntheticFrame(alphaAt, options = {}) {
    const width = options.sourceWidth || 120;
    const height = options.sourceHeight || 180;
    const outputWidth = options.outputWidth || width;
    const outputHeight = options.outputHeight || height;
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "template-frame-opening-"));
    const templatePath = path.join(tempDir, "__synthetic_frame_opening_test__.png");
    const portraitPath = path.join(tempDir, "portrait.png");
    const frame = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const offset = (y * width + x) * 4;
            const color = options.rgbAt ? options.rgbAt(x, y) : [255, 0, 0];
            frame[offset] = color[0];
            frame[offset + 1] = color[1];
            frame[offset + 2] = color[2];
            frame[offset + 3] = alphaAt(x, y);
        }
    }

    const originalGetTemplatePath = settings.getTemplatePath;
    const originalGetTemplateCompatibility = settings.getTemplateCompatibility;
    const originalGetForEvent = settings.getForEvent;
    try {
        await sharp(frame, { raw: { width, height, channels: 4 } }).png().toFile(templatePath);
        await sharp({ create: { width: 80, height: 110, channels: 3, background: "#00ff00" } })
            .png().toFile(portraitPath);
        settings.getTemplatePath = () => templatePath;
        if (options.compatibility) settings.getTemplateCompatibility = () => options.compatibility;
        settings.getForEvent = (key, eventName) => {
            if (key === "enableFrameBorder") return options.borderEnabled || false;
            if (key === "frameBorderColor") return "#000000";
            return originalGetForEvent(key, eventName);
        };

        await compositeWithTemplate(portraitPath, {
            width: outputWidth, height: outputHeight,
            orientation: outputWidth > outputHeight ? "landscape" : "portrait",
        }, "__frame_opening_test__");
        const { data, info } = await sharp(portraitPath).removeAlpha().raw()
            .toBuffer({ resolveWithObject: true });
        assert.deepEqual([info.width, info.height, info.channels], [outputWidth, outputHeight, 3]);
        return (x, y) => Array.from(data.subarray((y * outputWidth + x) * 3, (y * outputWidth + x) * 3 + 3));
    } finally {
        settings.getTemplatePath = originalGetTemplatePath;
        settings.getTemplateCompatibility = originalGetTemplateCompatibility;
        settings.getForEvent = originalGetForEvent;
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}

test("a frame's transparent perimeter and translucent border art do not reveal the portrait", async () => {
    // The intended opening is surrounded by opaque red artwork. A separate
    // transparent strip at the canvas edge must not become part of the opening.
    const pixel = await renderSyntheticFrame((x, y) => {
        const perimeter = x < 5 || x >= 115 || y < 6 || y >= 174;
        const opening = x >= 20 && x < 100 && y >= 24 && y < 156;
        const translucentArtwork = x >= 8 && x < 18 && y >= 50 && y < 60;
        return translucentArtwork ? 200 : (perimeter || opening ? 0 : 255);
    });

    assert.deepEqual(pixel(60, 90), [0, 255, 0], "portrait fills the intended opening");
    assert.deepEqual(pixel(15, 90), [255, 0, 0], "opaque frame artwork stays red");
    assert.deepEqual(pixel(2, 90), [0, 0, 0], "left transparent perimeter stays free of portrait");
    assert.deepEqual(pixel(60, 2), [0, 0, 0], "top transparent perimeter stays free of portrait");
    assert.deepEqual(pixel(12, 55), [200, 0, 0], "translucent border art blends with black, not portrait green");
});

test("trimming a near-transparent source fringe exposes only solid frame artwork at output edges", async () => {
    const edgeDistance = (x, y) => Math.min(x, 119 - x, y, 179 - y);
    const pixel = await renderSyntheticFrame((x, y) => {
        const distance = edgeDistance(x, y);
        if (distance < 7) return 8;
        if (distance < 10) return [80, 160, 224][distance - 7];
        const opening = x >= 20 && x < 100 && y >= 25 && y < 155;
        return opening ? 0 : 255;
    }, {
        rgbAt: (x, y) => edgeDistance(x, y) < 10 ? [0, 255, 255] : [255, 0, 0],
    });

    assert.deepEqual(pixel(0, 90), [255, 0, 0], "the left edge uses solid frame art");
    assert.deepEqual(pixel(119, 90), [255, 0, 0], "the right edge uses solid frame art");
    assert.deepEqual(pixel(60, 0), [255, 0, 0], "the top edge uses solid frame art");
    assert.deepEqual(pixel(60, 179), [255, 0, 0], "the bottom edge uses solid frame art");
    assert.deepEqual(pixel(60, 90), [0, 255, 0], "the portrait remains in the photo opening");
});

test("trimming a 2:3 frame for 5:7 output retains artwork on both short ends", async () => {
    const edgeDistance = (x, y) => Math.min(x, 239 - x, y, 359 - y);
    const pixel = await renderSyntheticFrame((x, y) => {
        const distance = edgeDistance(x, y);
        if (distance < 5) return 8;
        if (distance < 8) return [80, 160, 224][distance - 5];
        const opening = x >= 48 && x < 192 && y >= 60 && y < 300;
        return opening ? 0 : 255;
    }, {
        sourceWidth: 240,
        sourceHeight: 360,
        outputWidth: 240,
        outputHeight: 336,
        rgbAt: (x, y) => {
            if (y >= 8 && y < 25) return [0, 0, 255];
            if (y >= 335 && y < 352) return [255, 0, 255];
            return [255, 0, 0];
        },
    });

    assert.deepEqual(pixel(120, 0), [0, 0, 255], "the top artwork band survives normalization");
    assert.deepEqual(pixel(120, 335), [255, 0, 255], "the bottom artwork band survives normalization");
    assert.deepEqual(pixel(120, 168), [0, 255, 0], "the portrait remains in the opening");
});

test("translucent artwork inside the opening still overlays the portrait", async () => {
    const pixel = await renderSyntheticFrame((x, y) => {
        const opening = x >= 20 && x < 100 && y >= 24 && y < 156;
        const translucentArtwork = x >= 45 && x < 55 && y >= 50 && y < 60;
        return translucentArtwork ? 200 : (opening ? 0 : 255);
    });

    const blended = pixel(50, 55);
    assert.equal(blended[0], 200);
    assert.ok(blended[1] >= 54 && blended[1] <= 55, "artwork inside the opening blends with the photo");
    assert.equal(blended[2], 0);
    assert.deepEqual(pixel(12, 55), [255, 0, 0], "opaque border art remains outside the photo");
});

test("an enclosed opening wins over a larger transparent outer rim", async () => {
    const pixel = await renderSyntheticFrame((x, y) => {
        const thickRim = x < 12 || x >= 108 || y < 12 || y >= 168;
        const smallOpening = x >= 39 && x < 81 && y >= 52 && y < 128;
        return thickRim || smallOpening ? 0 : 255;
    });

    assert.deepEqual(pixel(60, 90), [0, 255, 0], "photo fills the enclosed opening");
    assert.deepEqual(pixel(20, 90), [255, 0, 0], "opaque art remains visible between regions");
    assert.deepEqual(pixel(2, 90), [0, 0, 0], "larger transparent rim does not reveal the photo");
});

test("a frame opening still wins when its transparent outer rim covers most of the canvas", async () => {
    const pixel = await renderSyntheticFrame((x, y) => {
        const thickRim = x < 25 || x >= 95 || y < 25 || y >= 155;
        const opening = x >= 30 && x < 90 && y >= 40 && y < 140;
        return thickRim || opening ? 0 : 255;
    });

    assert.deepEqual(pixel(60, 90), [0, 255, 0], "photo fills the enclosed opening");
    assert.deepEqual(pixel(2, 90), [0, 0, 0], "the dominant transparent rim stays on the matte");
});

test("a small decorative hole does not replace an edge-touching photo opening", async () => {
    const pixel = await renderSyntheticFrame((x, y) => {
        const opening = y >= 30 && y < 150;
        const smallHole = x >= 10 && x < 20 && y >= 10 && y < 20;
        return opening || smallHole ? 0 : 255;
    });

    assert.deepEqual(pixel(60, 90), [0, 255, 0], "photo fills the large edge-touching opening");
    assert.deepEqual(pixel(60, 5), [255, 0, 0], "opaque artwork stays visible above it");
});

test("an edge-touching opening excludes separate transparent strips", async () => {
    const pixel = await renderSyntheticFrame((x, y) => {
        const opening = y >= 30 && y < 150;
        const topStrip = y < 4;
        const bottomStrip = y >= 176;
        return opening || topStrip || bottomStrip ? 0 : 255;
    });

    assert.deepEqual(pixel(60, 90), [0, 255, 0], "photo fills the edge-touching opening");
    assert.deepEqual(pixel(60, 2), [0, 0, 0], "top strip stays on the matte");
    assert.deepEqual(pixel(60, 178), [0, 0, 0], "bottom strip stays on the matte");
});

test("a one-pixel transparent bridge does not extend the portrait to the outer edge", async () => {
    const pixel = await renderSyntheticFrame((x, y) => {
        const rim = x < 4 || x >= 116 || y < 4 || y >= 176;
        const opening = x >= 20 && x < 100 && y >= 24 && y < 156;
        const bridge = y === 90 && x >= 4 && x < 20;
        return rim || opening || bridge ? 0 : 255;
    });

    assert.deepEqual(pixel(60, 90), [0, 255, 0], "photo fills the enclosed opening");
    assert.deepEqual(pixel(10, 80), [255, 0, 0], "opaque artwork stays red");
    assert.deepEqual(pixel(2, 90), [0, 0, 0], "bridge does not expose the photo at the rim");
});

test("a source-pixel bridge stays separate after a frame is enlarged for printing", async () => {
    const pixel = await renderSyntheticFrame((x, y) => {
        const rim = x < 4 || x >= 116 || y < 4 || y >= 176;
        const opening = x >= 20 && x < 100 && y >= 24 && y < 156;
        const bridge = y === 90 && x >= 4 && x < 20;
        return rim || opening || bridge ? 0 : 255;
    }, { outputWidth: 300, outputHeight: 450 });

    assert.deepEqual(pixel(150, 225), [0, 255, 0], "the opening still contains the photo");
    assert.deepEqual(pixel(5, 225), [0, 0, 0], "the enlarged bridge does not expose the outer rim");
});

test("an adapted landscape frame separates a bridge widened from its source", async () => {
    const pixel = await renderSyntheticFrame((x, y) => {
        const rim = x < 4 || x >= 116 || y < 4 || y >= 176;
        const opening = x >= 20 && x < 100 && y >= 24 && y < 156;
        const bridge = y === 90 && x >= 4 && x < 20;
        return rim ? 32 : (opening || bridge ? 0 : 255);
    }, { outputWidth: 900, outputHeight: 600, compatibility: "both" });

    assert.deepEqual(pixel(450, 300), [0, 255, 0], "the adapted opening contains the photo");
    assert.equal(pixel(255, 300)[1], 0, "the adapted outer rim does not reveal green photo pixels");
});

test("a full-canvas transparent overlay keeps photo on both sides of an opaque ring", async () => {
    const pixel = await renderSyntheticFrame((x, y) => {
        const withinRing = x >= 20 && x < 100 && y >= 30 && y < 150;
        const ringEdge = x < 24 || x >= 96 || y < 34 || y >= 146;
        return withinRing && ringEdge ? 255 : 0;
    });

    assert.deepEqual(pixel(2, 90), [0, 255, 0], "photo remains visible outside the ring");
    assert.deepEqual(pixel(60, 90), [0, 255, 0], "photo remains visible inside the ring");
    assert.deepEqual(pixel(22, 90), [255, 0, 0], "opaque ring covers the photo");
});

test("a faded-edge overlay connected through its center keeps the portrait at canvas edges", async () => {
    const pixel = await renderSyntheticFrame((x, y) => {
        const opening = x >= 20 && x < 100 && y >= 24 && y < 156;
        const passage = x >= 56 && x < 64 && y < 24;
        if (opening || passage) return 0;
        const distance = Math.min(x, 119 - x, y, 179 - y);
        if (distance < 2) return 8;
        if (distance < 5) return [80, 160, 224][distance - 2];
        return 255;
    });

    for (const [x, y] of [[0, 90], [119, 90], [10, 0], [10, 179]]) {
        const [red, green] = pixel(x, y);
        assert.ok(red <= 15 && green >= 240, `photo remains visible at overlay edge ${x},${y}`);
    }
    assert.deepEqual(pixel(60, 90), [0, 255, 0], "the connected center contains the photo");
    assert.deepEqual(pixel(10, 90), [255, 0, 0], "opaque decoration still covers the photo");
});

test("a full-canvas overlay keeps its configured inset", async () => {
    const pixel = await renderSyntheticFrame((x, y) => {
        const withinRing = x >= 20 && x < 100 && y >= 30 && y < 150;
        const ringEdge = x < 24 || x >= 96 || y < 34 || y >= 146;
        return withinRing && ringEdge ? 255 : 0;
    }, { borderEnabled: true });

    assert.deepEqual(pixel(2, 90), [0, 0, 0], "the outer inset shows the configured matte");
    assert.deepEqual(pixel(12, 90), [0, 255, 0], "the photo remains outside the ring");
    assert.deepEqual(pixel(60, 90), [0, 255, 0], "the photo remains inside the ring");
});

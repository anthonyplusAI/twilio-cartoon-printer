const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { paginateRunDetail, renderEvalRunDetailPage } = require("../lib/eval-run-page");

function makeManifest(count = 500) {
    const photos = ["one.jpg", "two.jpg"];
    const variants = [{ name: "live" }, { name: "warm" }, { name: "bold" }];
    const entries = Array.from({ length: count }, (_, index) => ({
        style: index < 250 ? "cartoon" : "watercolor",
        brand: null,
        background: null,
        photo: photos[index % photos.length],
        variant: variants[index % variants.length].name,
        rep: 1 + Math.floor(index / 6),
        status: index % 9 === 0 ? "failed" : "completed",
        outputPath: "image-" + index + ".png",
        generationMs: 32000,
    }));
    return {
        id: "demo-run",
        name: "Large sample run",
        status: "completed",
        createdAt: "2026-01-01T00:00:00Z",
        totalCostUsd: 95,
        config: { photos, variants },
        entries,
        winners: {
            "cartoon|null|null": { variant: "live", notes: "Keep the face clear." },
            "watercolor|null|null": { variant: "warm", notes: "Keep the warm lighting." },
        },
        notes: "Compare prompt consistency.",
        starred: [entries[2].outputPath, entries[330].outputPath],
    };
}

test("run detail pages keep at most 120 entries and cover the full run", () => {
    const manifest = makeManifest();
    const first = paginateRunDetail(manifest);
    assert.equal(first.total, 500);
    assert.ok(first.pages >= 5);
    const visible = [];
    for (let page = 1; page <= first.pages; page++) {
        const section = paginateRunDetail(manifest, { page: String(page) });
        assert.ok(section.shown <= 120);
        assert.equal(section.page, page);
        visible.push(...section.rows.flatMap((row) => row.entries.map((entry) => entry.outputPath)));
    }
    assert.equal(visible.length, 500);
    assert.equal(new Set(visible).size, 500);
    assert.equal(paginateRunDetail(manifest, { page: "999" }).page, first.pages);
});

test("starred filter searches the entire run before paging", () => {
    const manifest = makeManifest();
    const page = paginateRunDetail(manifest, { starred: "1" });
    assert.equal(page.total, 2);
    assert.equal(page.starredCount, 2);
    assert.equal(page.rows.flatMap((row) => row.entries).length, 2);
    assert.deepEqual(
        new Set(page.rows.flatMap((row) => row.entries.map((entry) => entry.outputPath))),
        new Set(manifest.starred),
    );
});

test("pure run detail HTML bounds tiles and preserves actions and hidden winners", () => {
    const manifest = makeManifest();
    manifest.winners["watercolor|null|null"].notes = "</script><img src=x>";
    const html = renderEvalRunDetailPage({ manifest, query: { page: "2" } });
    assert.ok((html.match(/class="img-tile-wrap/g) || []).length <= 120);
    assert.match(html, /Page 2 of/);
    assert.match(html, /data-detail-nav/);
    assert.match(html, /\/summary"/);
    assert.match(html, /visibilitychange/);
    assert.match(html, /retry-failed/);
    assert.match(html, /data-star-output/);
    assert.match(html, /data-combo-key/);
    assert.match(html, /const winners = \{ \.\.\.ORIGINAL_WINNERS \}/);
    assert.doesNotMatch(html, /<\/script><img src=x>/);
    for (const [, script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        if (script.trim()) new vm.Script(script);
    }
});

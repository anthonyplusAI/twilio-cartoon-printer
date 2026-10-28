const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
    paginateRunSummaries,
    renderEvalRunsPage,
    renderEvalNewPage,
    renderEvalPhotosPage,
    renderEvalVariantsPage,
} = require("../lib/eval-page");

function makeRuns(count) {
    return Array.from({ length: count }, (_, i) => ({
        id: "demo-" + i,
        name: "Prompt test " + i,
        status: i % 11 === 0 ? "running" : i % 9 === 0 ? "failed" : "completed",
        createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString(),
        eventName: i % 4 === 0 ? "SECOND EVENT" : "DEMO EVENT",
        group: i % 2 === 0 ? "Illustration" : "Color",
        totals: { total: 10, done: 8, failed: 0 },
        totalCostUsd: 1.52,
        starredCount: 0,
    }));
}

test("run summaries filter before slicing and cap page size", () => {
    const runs = makeRuns(160);
    const page = paginateRunSummaries(runs, { activeEvent: "DEMO EVENT", page: 2 });
    assert.equal(page.total, 120);
    assert.equal(page.runs.length, 24);
    assert.equal(page.page, 2);
    assert.equal(page.pages, 5);
    assert.ok(page.runs.every((run) => run.eventName === "DEMO EVENT"));

    const filtered = paginateRunSummaries(runs, {
        activeEvent: "DEMO EVENT", allEvents: "1",
        q: "prompt test 159", group: "Color", status: "completed", page: 99,
    });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.page, 1);
    assert.equal(filtered.runs[0].id, "demo-159");

    const ungrouped = paginateRunSummaries([{ ...runs[0], group: "" }, ...runs], {
        activeEvent: "SECOND EVENT", group: "__ungrouped__",
    });
    assert.deepEqual(ungrouped.runs.map((run) => run.id), ["demo-0"]);
    assert.equal(paginateRunSummaries(runs, { allEvents: true, limit: 1000 }).runs.length, 50);
});

test("runs preview renders one bounded page and keeps links to later pages", () => {
    const html = renderEvalRunsPage({
        summaries: makeRuns(160),
        evalSettings: { maxConcurrent: 12 },
        activeEvent: "DEMO EVENT",
        query: { page: "2", q: "Prompt" },
        preview: true,
    });
    assert.equal((html.match(/class="card card-compact run-card"/g) || []).length, 24);
    assert.match(html, /Page 2 of 5/);
    assert.match(html, /page=3/);
    assert.match(html, /Run defaults/);
    assert.match(html, /eval-workspace\.css/);
    assert.doesNotMatch(html, /auth\/me/);
    for (const [, script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        if (script.trim()) new vm.Script(script);
    }
});

test("new-run preview keeps live controls and safely embeds prompt text", () => {
    const html = renderEvalNewPage({
        activeStyles: { cartoon: { name: "Cartoon", prompt: "</script><img src=x>", core: "cartoon" } },
        activeBrands: {},
        photos: [{ filename: "demo.jpg", displayName: "Demo portrait" }],
        savedVariants: [],
        evalSettings: { maxConcurrent: 12 },
        activeEvent: "DEMO EVENT",
        eventNames: ["DEMO EVENT"],
        preview: true,
    });
    assert.match(html, /Run plan/);
    assert.match(html, /estimateCount/);
    assert.match(html, /function updateEstimate/);
    assert.match(html, /Run experiment/);
    assert.doesNotMatch(html, /<\/script><img src=x>/);
    for (const [, script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        if (script.trim()) new vm.Script(script);
    }
});

test("photos and saved variants render in the pure workspace shell with working controls", () => {
    const photosHtml = renderEvalPhotosPage({
        photos: [{ filename: "demo.jpg", displayName: "Demo portrait", uploadedAt: "2026-01-01T00:00:00Z", sceneDescription: "A person by a window" }],
    });
    assert.match(photosHtml, /Photo library/);
    assert.match(photosHtml, /Upload photo/);
    assert.match(photosHtml, /data-del="demo.jpg"/);
    assert.ok(photosHtml.includes('fetch("/eval/api/photos"'));
    assert.match(photosHtml, /eval-workspace\.css/);

    const variantsHtml = renderEvalVariantsPage({
        variants: [{
            name: "Soft linework",
            description: "</script><img src=x>",
            createdAt: "2026-01-01T00:00:00Z",
            overrides: { styles: { cartoon: { prompt: "gentler linework" } }, brands: {} },
        }],
        activeStyles: { cartoon: { prompt: "</script><img src=x>", core: "illustration" } },
        activeBrands: {},
    });
    assert.match(variantsHtml, /Variant library/);
    assert.match(variantsHtml, /data-edit="Soft linework"/);
    assert.match(variantsHtml, /editor-save/);
    assert.doesNotMatch(variantsHtml, /<\/script><img src=x>/);
    for (const html of [photosHtml, variantsHtml]) {
        for (const [, script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
            if (script.trim()) new vm.Script(script);
        }
    }
});

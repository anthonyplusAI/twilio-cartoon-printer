const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createManifestCoordinator, SKIP_MANIFEST_WRITE } = require("../lib/experiment-manifest-coordinator");

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-manifest-race-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "manifest.json");
    let writes = 0;
    const coordinator = createManifestCoordinator({
        read: async () => JSON.parse(await fs.readFile(file, "utf8")),
        write: async (manifest) => { writes++; await fs.writeFile(file, JSON.stringify(manifest)); },
        debounceMs: 60_000,
    });
    const disk = async () => JSON.parse(await fs.readFile(file, "utf8"));
    return { coordinator, disk, file, writes: () => writes };
}

function sampleManifest() {
    return {
        id: "sample-run", name: "Sample", createdAt: "2026-01-01T00:00:00Z",
        status: "running", totalCostUsd: 0, notes: "", winners: {}, starred: [],
        config: { photos: ["sample.jpg"], styles: ["cartoon"], brands: [null], backgrounds: [null], variants: [{ name: "live" }] },
        entries: [{ photo: "sample.jpg", style: "cartoon", brand: null, background: null,
            variant: "live", rep: 1, outputPath: "sample.png", status: "pending" }],
    };
}

test("a debounced runner save preserves edits made through the API while progress advances", async (t) => {
    const { coordinator, disk } = await fixture(t);
    const runner = sampleManifest();
    coordinator.activate(runner);
    await coordinator.save(runner);

    runner.entries[0].status = "completed";
    runner.totalCostUsd = 0.19;
    const pendingSave = coordinator.debouncedSave(runner);
    await coordinator.edit(runner.id, (manifest) => {
        manifest.notes = "The better face is in the live variant.";
        manifest.group = "Launch";
        manifest.winners = { "cartoon|null|null": { variant: "live", notes: "Keep" } };
        manifest.starred = ["sample.png"];
    });
    await coordinator.flushDebounced(runner.id);
    await pendingSave;

    const saved = await disk();
    assert.equal(saved.entries[0].status, "completed");
    assert.equal(saved.totalCostUsd, 0.19);
    assert.equal(saved.notes, "The better face is in the live variant.");
    assert.equal(saved.group, "Launch");
    assert.deepEqual(saved.winners, { "cartoon|null|null": { variant: "live", notes: "Keep" } });
    assert.deepEqual(saved.starred, ["sample.png"]);
});

test("concurrent user edits to an idle run retain both changes", async (t) => {
    const { coordinator, disk } = await fixture(t);
    const manifest = sampleManifest();
    manifest.status = "completed";
    await coordinator.save(manifest);

    await Promise.all([
        coordinator.edit(manifest.id, (current) => { current.notes = "Keep the hat."; }),
        coordinator.edit(manifest.id, (current) => { current.starred = ["sample.png"]; }),
    ]);

    const saved = await disk();
    assert.equal(saved.notes, "Keep the hat.");
    assert.deepEqual(saved.starred, ["sample.png"]);
});

test("active ownership remains until the last runner releases it", async (t) => {
    const { coordinator, disk } = await fixture(t);
    const runner = sampleManifest();
    await coordinator.save(runner);
    coordinator.activate(runner);
    coordinator.activate(runner);
    coordinator.deactivate(runner);

    runner.entries[0].status = "completed";
    await coordinator.edit(runner.id, (current) => { current.notes = "Saved during retry."; });
    await coordinator.save(runner);
    assert.equal((await disk()).notes, "Saved during retry.");
    assert.equal((await disk()).entries[0].status, "completed");
    coordinator.deactivate(runner);
});

test("a background scan can skip an active run without another full manifest write", async (t) => {
    const { coordinator, disk, writes } = await fixture(t);
    const runner = sampleManifest();
    await coordinator.save(runner);
    coordinator.activate(runner);
    const before = writes();

    const { result } = await coordinator.edit(runner.id, () => SKIP_MANIFEST_WRITE);

    assert.equal(result, SKIP_MANIFEST_WRITE);
    assert.equal(writes(), before);
    assert.equal((await disk()).entries[0].status, "pending");
    coordinator.deactivate(runner);
});

test("initial run setup keeps one live manifest while photo loading waits", async (t) => {
    const { coordinator, disk } = await fixture(t);
    const runner = sampleManifest();
    let releasePhotos;
    const photosReady = new Promise((resolve) => { releasePhotos = resolve; });
    let reachedPhotos;
    const loadingPhotos = new Promise((resolve) => { reachedPhotos = resolve; });

    const setup = coordinator.prepare(runner, async () => {
        await coordinator.save(runner);
        reachedPhotos();
        await photosReady;
        return "photos loaded";
    });
    await loadingPhotos;
    assert.equal(coordinator.isActive(runner.id), true);
    await coordinator.edit(runner.id, (current) => { current.notes = "Edited during photo load"; });
    releasePhotos();
    assert.equal(await setup, "photos loaded");
    runner.entries[0].status = "completed";
    await coordinator.save(runner);
    assert.equal((await disk()).notes, "Edited during photo load");
    assert.equal((await disk()).entries[0].status, "completed");
    coordinator.deactivate(runner);
});

test("failed initial run setup releases the live manifest", async (t) => {
    const { coordinator } = await fixture(t);
    const runner = sampleManifest();
    await assert.rejects(coordinator.prepare(runner, async () => {
        await coordinator.save(runner);
        throw new Error("photo catalog unavailable");
    }), /photo catalog unavailable/);
    assert.equal(coordinator.isActive(runner.id), false);
});

test("active or delayed runner writes block deletion; an idle run can be removed", async (t) => {
    const { coordinator, disk, file } = await fixture(t);
    const runner = sampleManifest();
    await coordinator.save(runner);
    coordinator.activate(runner);
    await assert.rejects(coordinator.remove(runner.id, () => fs.unlink(file)), (error) => error.status === 409);
    assert.equal((await disk()).id, runner.id);
    coordinator.deactivate(runner);

    const pendingSave = coordinator.debouncedSave(runner);
    await assert.rejects(coordinator.remove(runner.id, () => fs.unlink(file)), (error) => error.status === 409);
    await coordinator.flushDebounced(runner.id);
    await pendingSave;
    await coordinator.remove(runner.id, () => fs.unlink(file));
    await assert.rejects(disk(), (error) => error.code === "ENOENT");
});

test("deletion waits for a queued write and leaves no resurrected manifest", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eval-delete-queue-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, "manifest.json");
    const runner = sampleManifest();
    let releaseWrite;
    const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
    let writeStarted;
    const writing = new Promise((resolve) => { writeStarted = resolve; });
    const coordinator = createManifestCoordinator({
        read: async () => JSON.parse(await fs.readFile(file, "utf8")),
        write: async (manifest) => {
            writing && writeStarted();
            await writeGate;
            await fs.writeFile(file, JSON.stringify(manifest));
        },
    });

    const save = coordinator.save(runner);
    await writing;
    const remove = coordinator.remove(runner.id, () => fs.unlink(file));
    releaseWrite();
    await save;
    await remove;
    await assert.rejects(fs.readFile(file), (error) => error.code === "ENOENT");
});

// lib/experiments.js
// Prompt experiment tracker — standalone runner, storage, and Express mount.
// See docs/superpowers/specs/2026-04-28-prompt-experiment-tracker-design.md
//
// This module is intentionally self-contained: all experiment state lives under
// data/experiments/ and nothing in the production pipeline reads from it. A
// failure here must never affect live SMS generation.

const crypto = require("node:crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const express = require("express");
const sharp = require("sharp");
const { getOpenAI, getModels } = require("./config");
const { toFile } = require("openai");
const { analyzeScene, parseScene, withRetry } = require("./helpers");
const { compositeExactBackground } = require("./bg-composite");
const settings = require("./settings");
const promptBuilder = require("./prompt-builder");
const { getActiveBrands } = require("./brands");
const { escapeHtml, formatMs, evalNav, pageShell, paginateRunSummaries, renderEvalRunsPage, renderEvalNewPage, renderEvalPhotosPage, renderEvalVariantsPage } = require("./eval-page");
const { runWallTimeMs, renderEvalRunDetailPage } = require("./eval-run-page");
const { createManifestCoordinator, SKIP_MANIFEST_WRITE } = require("./experiment-manifest-coordinator");

const EXPERIMENTS_DIR = path.join(__dirname, "..", "data", "experiments");
const TEST_PHOTOS_DIR = path.join(EXPERIMENTS_DIR, "test-photos");
const PHOTOS_JSON = path.join(EXPERIMENTS_DIR, "photos.json");
const VARIANTS_JSON = path.join(EXPERIMENTS_DIR, "variants.json");
const SETTINGS_JSON = path.join(EXPERIMENTS_DIR, "settings.json");

const DEFAULT_MAX_CONCURRENT = 30;
const MIN_CONCURRENT = 1;
const MAX_CONCURRENT_CAP = 60;
const MAX_CONCURRENT = DEFAULT_MAX_CONCURRENT; // legacy export, kept for tests
const MAX_RETRIES = 1;
const MAX_ENTRIES_PER_EXPERIMENT = 500;
const MAX_VARIANTS_PER_EXPERIMENT = 10;
const COST_PER_IMAGE_USD = 0.19;

function clampConcurrent(n) {
    const v = Math.floor(Number(n));
    if (!Number.isFinite(v)) return DEFAULT_MAX_CONCURRENT;
    return Math.max(MIN_CONCURRENT, Math.min(MAX_CONCURRENT_CAP, v));
}

async function loadEvalSettings() {
    try {
        const raw = await fsp.readFile(SETTINGS_JSON, "utf8");
        const data = JSON.parse(raw);
        return { maxConcurrent: clampConcurrent(data.maxConcurrent ?? DEFAULT_MAX_CONCURRENT) };
    } catch (err) {
        if (err.code === "ENOENT") return { maxConcurrent: DEFAULT_MAX_CONCURRENT };
        throw err;
    }
}

async function saveEvalSettings(data) {
    const out = { maxConcurrent: clampConcurrent(data.maxConcurrent) };
    const tmp = `${SETTINGS_JSON}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(out, null, 2), "utf8");
    await fsp.rename(tmp, SETTINGS_JSON);
    return out;
}

async function ensureDirs() {
    await fsp.mkdir(EXPERIMENTS_DIR, { recursive: true });
    await fsp.mkdir(TEST_PHOTOS_DIR, { recursive: true });
}

function experimentDir(id) {
    return path.join(EXPERIMENTS_DIR, id);
}

function manifestPath(id) {
    return path.join(experimentDir(id), "manifest.json");
}

// Canonical filename-segment sanitizer. The HTTP route that serves generated
// PNGs strips anything outside [A-Za-z0-9._-], so the same set must be used at
// write time or the reader will 404 on filenames containing spaces, parens,
// slashes, etc. (happens with user-typed custom variant names like "New Twilio
// Illustration"). Runs of disallowed chars collapse to a single '-', and
// leading/trailing dashes are trimmed per segment.
function sanitizeFilenameSegment(seg) {
    return String(seg ?? "")
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "none";
}

async function loadManifest(id) {
    const raw = await fsp.readFile(manifestPath(id), "utf8");
    const manifest = JSON.parse(raw);
    // Strip any _refs persisted by earlier code that stashed Buffers on entries.
    // These cause JSON.stringify to throw "Invalid string length" on large runs.
    if (Array.isArray(manifest.entries)) {
        for (const e of manifest.entries) delete e._refs;
    }
    return manifest;
}

// Azure Files (SMB) rejects overlapping renames to the same file. The
// coordinator also keeps one live object for a running experiment, so API
// edits cannot be lost to a later debounced runner save.
async function writeManifestFile(manifest) {
    manifest.updatedAt = new Date().toISOString();
    const filePath = manifestPath(manifest.id);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
    await fsp.rename(tmp, filePath);
}

const manifestCoordinator = createManifestCoordinator({
    read: loadManifest,
    write: writeManifestFile,
    onChange: (manifest) => _summaryCache.set(manifest.id, summarizeManifest(manifest)),
    onDebounceError: (err, manifest) => console.warn(`[experiments] debounced save failed ${manifest.id}: ${err.message}`),
});

function saveManifest(manifest) { return manifestCoordinator.save(manifest); }
function debouncedSaveManifest(manifest) { return manifestCoordinator.debouncedSave(manifest); }
function flushDebouncedSave(manifestId) { return manifestCoordinator.flushDebounced(manifestId); }

async function listManifests() {
    try {
        const entries = await fsp.readdir(EXPERIMENTS_DIR, { withFileTypes: true });
        const dirs = entries.filter((e) => e.isDirectory() && e.name !== "test-photos");
        const manifests = [];
        for (const d of dirs) {
            try { manifests.push(await loadManifest(d.name)); }
            catch (err) { console.warn(`[experiments] Skipping malformed manifest in ${d.name}: ${err.message}`); }
        }
        manifests.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
        return manifests;
    } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
    }
}

// Per-run summary cache keyed by manifest id. The /eval index page and the
// /api/runs listing only need small header-level fields (status, totals,
// cost, group), but we previously re-parsed every full manifest on every
// request. Now we parse once and cache the derived summary; writes invalidate
// the cache entry via invalidateRunSummary().
const _summaryCache = new Map();

function summarizeManifest(m) {
    const totals = (m.entries || []).reduce((acc, e) => {
        acc.total++;
        if (e.status === "completed") acc.done++;
        else if (e.status === "failed") acc.failed++;
        return acc;
    }, { total: 0, done: 0, failed: 0 });
    return {
        id: m.id,
        name: m.name,
        status: m.status,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        group: m.group || "",
        eventName: (m.config && m.config.eventName) || "",
        totalCostUsd: m.totalCostUsd || 0,
        totals,
        wallMs: runWallTimeMs(m),
        starredCount: Array.isArray(m.starred) ? m.starred.length : 0,
    };
}

function invalidateRunSummary(id) {
    if (id) _summaryCache.delete(id);
    else _summaryCache.clear();
}

async function listRunSummaries() {
    let dirs;
    try {
        const entries = await fsp.readdir(EXPERIMENTS_DIR, { withFileTypes: true });
        dirs = entries.filter((e) => e.isDirectory() && e.name !== "test-photos");
    } catch (err) {
        if (err.code === "ENOENT") return [];
        throw err;
    }
    // Azure Files has noticeable per-file latency. Read cold manifests in
    // bounded parallel batches, while reusing summaries updated by saves.
    const names = new Set(dirs.map((d) => d.name));
    for (const id of _summaryCache.keys()) {
        if (!names.has(id)) _summaryCache.delete(id);
    }
    const uncached = dirs.filter((d) => !_summaryCache.has(d.name));
    for (let i = 0; i < uncached.length; i += 16) {
        await Promise.all(uncached.slice(i, i + 16).map(async (d) => {
            try {
                const summary = summarizeManifest(await loadManifest(d.name));
                _summaryCache.set(d.name, summary);
            } catch (err) {
                console.warn(`[experiments] Skipping malformed manifest in ${d.name}: ${err.message}`);
            }
        }));
    }
    const summaries = dirs.map((d) => _summaryCache.get(d.name)).filter(Boolean);
    summaries.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return summaries;
}

function buildEntries(config) {
    // Expand config into one entry per (photo × style × brand × background × variant × rep)
    const reps = Math.max(1, Number(config.reps) || 1);
    const entries = [];
    for (const photo of config.photos) {
        for (const style of config.styles) {
            for (const brand of config.brands) {
                for (const background of config.backgrounds) {
                    for (const variant of config.variants) {
                        for (let rep = 1; rep <= reps; rep++) {
                            const brandSeg = brand || "none";
                            const bgSeg = background || "none";
                            const parts = [
                                path.parse(photo).name,
                                style, brandSeg, bgSeg, variant.name,
                            ].map(sanitizeFilenameSegment);
                            entries.push({
                                photo, style, brand, background,
                                variant: variant.name, rep,
                                status: "pending",
                                outputPath: `${parts.join("_")}_${rep}.png`,
                                promptText: null,
                                generationMs: null,
                                error: null,
                                startedAt: null,
                                completedAt: null,
                            });
                        }
                    }
                }
            }
        }
    }
    return entries;
}

function makeId(name, now = new Date()) {
    // Slug-safe timestamp + slug-safe name. Keeps directories filesystem-sortable.
    const ts = now.toISOString().replace(/:/g, "-").replace(/\..+/, "");
    const slug = String(name)
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 60)
        .replace(/-$/, "");
    return `${ts}_${slug || "experiment"}`;
}

// ── Photo management ────────────────────────────────────────────────────────

async function loadPhotos() {
    try {
        const raw = await fsp.readFile(PHOTOS_JSON, "utf8");
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === "ENOENT") return { photos: [] };
        throw err;
    }
}

async function savePhotos(data) {
    const tmp = PHOTOS_JSON + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, PHOTOS_JSON);
}

async function addPhoto({ filename, displayName, buffer }) {
    await ensureDirs();
    const safeName = path.basename(filename);
    await fsp.writeFile(path.join(TEST_PHOTOS_DIR, safeName), buffer);

    const photos = await loadPhotos();
    if (photos.photos.find((p) => p.filename === safeName)) {
        throw new Error(`Photo ${safeName} already exists`);
    }

    // Scene analysis happens in the route handler (needs helpers.analyzeScene);
    // addPhoto just persists the file + manifest entry with null scene fields.
    photos.photos.push({
        filename: safeName,
        displayName: displayName || safeName,
        uploadedAt: new Date().toISOString(),
        sceneDescription: null,
        parsedScene: null,
    });
    await savePhotos(photos);
    return photos.photos[photos.photos.length - 1];
}

async function updatePhotoScene(filename, sceneDescription, parsedScene) {
    const photos = await loadPhotos();
    const entry = photos.photos.find((p) => p.filename === filename);
    if (!entry) throw new Error(`Photo ${filename} not found`);
    entry.sceneDescription = sceneDescription ?? null;
    entry.parsedScene = parsedScene ?? null;
    await savePhotos(photos);
    return entry;
}

async function removePhoto(filename) {
    const photos = await loadPhotos();
    const idx = photos.photos.findIndex((p) => p.filename === filename);
    if (idx === -1) throw new Error(`Photo ${filename} not found`);
    photos.photos.splice(idx, 1);
    await savePhotos(photos);
    try { await fsp.unlink(path.join(TEST_PHOTOS_DIR, filename)); } catch (err) {
        if (err.code !== "ENOENT") throw err;
    }
}

async function isPhotoInUseByRunning(filename) {
    const manifests = await listManifests();
    return manifests.some((m) => m.status === "running" && (m.config.photos || []).includes(filename));
}

// ── Saved variant library ──────────────────────────────────────────────────

// Variant override shape (v2): { styles: {<styleKey>: {...}}, brands: {<brandKey>: {...}} }
// Legacy (v1) shape: { <styleKey>: { prompt, core, brandCore } } — wrapped on read.
// The wrapper detects v1 by checking if any value is a plain object containing
// prompt/core/brandCore fields (i.e. style-shaped, not the new nested shape).
function migrateOverrides(overrides) {
    if (!overrides || typeof overrides !== "object") return { styles: {}, brands: {} };
    if ("styles" in overrides || "brands" in overrides) {
        return {
            styles: overrides.styles && typeof overrides.styles === "object" ? overrides.styles : {},
            brands: overrides.brands && typeof overrides.brands === "object" ? overrides.brands : {},
        };
    }
    // Legacy flat shape — every key is a style key.
    return { styles: overrides, brands: {} };
}

async function loadSavedVariants() {
    try {
        const raw = await fsp.readFile(VARIANTS_JSON, "utf8");
        const data = JSON.parse(raw);
        if (Array.isArray(data.variants)) {
            data.variants = data.variants.map((v) => ({ ...v, overrides: migrateOverrides(v.overrides) }));
        }
        return data;
    } catch (err) {
        if (err.code === "ENOENT") return { variants: [] };
        throw err;
    }
}

async function saveSavedVariants(data) {
    const tmp = `${VARIANTS_JSON}.${crypto.randomUUID()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fsp.rename(tmp, VARIANTS_JSON);
}

async function addSavedVariant({ name, description, overrides }) {
    if (!name || typeof name !== "string") throw new Error("Variant name is required");
    if (!overrides || typeof overrides !== "object") throw new Error("Variant overrides are required");
    const data = await loadSavedVariants();
    if (data.variants.find((v) => v.name === name)) throw new Error(`Variant "${name}" already exists`);
    data.variants.push({
        name,
        description: description || "",
        overrides,
        createdAt: new Date().toISOString(),
    });
    await saveSavedVariants(data);
    return data.variants[data.variants.length - 1];
}

async function updateSavedVariant(name, { description, overrides }) {
    const data = await loadSavedVariants();
    const entry = data.variants.find((v) => v.name === name);
    if (!entry) throw new Error(`Variant "${name}" not found`);
    if (description !== undefined) entry.description = description || "";
    if (overrides !== undefined) entry.overrides = overrides;
    entry.updatedAt = new Date().toISOString();
    await saveSavedVariants(data);
    return entry;
}

async function removeSavedVariant(name) {
    const data = await loadSavedVariants();
    const idx = data.variants.findIndex((v) => v.name === name);
    if (idx === -1) throw new Error(`Variant "${name}" not found`);
    data.variants.splice(idx, 1);
    await saveSavedVariants(data);
}

// ── Runner ──────────────────────────────────────────────────────────────────

// Tracks which entries have already been retried this session. Kept out of
// the entry object so it never gets serialized into the persisted manifest.
const retriedEntries = new WeakSet();

// runEntry is parameterized on `deps` so tests can mock OpenAI + builder.
// In production, mountExperiments wires the real dependencies in.
async function runEntry(entry, manifest, deps) {
    entry.status = "running";
    // Keep startedAt from the first attempt so retried entries show total wall time.
    entry.startedAt = entry.startedAt || new Date().toISOString();
    await deps.flushManifest(manifest);

    const t0 = Date.now();
    try {
        const promptText = await deps.buildPromptForEntry(entry, manifest);
        entry.promptText = promptText;
        const pngBuf = await deps.callImageEdit({ entry, manifest, promptText });
        const runDir = experimentDir(manifest.id);
        await fsp.writeFile(path.join(runDir, entry.outputPath), pngBuf);
        // Sidecar: prompt text next to the PNG. Served lazily on tile open so
        // the manifest + list HTML stay small. Non-fatal if the write fails —
        // manifest.promptText is still the authoritative fallback.
        const promptFile = entry.outputPath.replace(/\.png$/, ".prompt.txt");
        try { await fsp.writeFile(path.join(runDir, promptFile), promptText, "utf8"); }
        catch (err) { console.warn(`[experiments] prompt sidecar failed for ${promptFile}: ${err.message}`); }
        entry.status = "completed";
        entry.generationMs = Date.now() - t0;
    } catch (err) {
        if (!retriedEntries.has(entry)) {
            retriedEntries.add(entry);
            console.log(`[experiments] Retrying entry ${entry.outputPath} after error: ${err.message}`);
            return runEntry(entry, manifest, deps);
        }
        entry.status = "failed";
        entry.error = err.message;
    }
    entry.completedAt = new Date().toISOString();
    await deps.flushManifest(manifest);
}

async function runExperiment(manifest, deps) {
    await fsp.mkdir(experimentDir(manifest.id), { recursive: true });
    manifest.status = "running";
    // Terminal transitions use flushFinal (sync save); falls back to flushManifest for tests.
    const flushFinal = deps.flushFinal || deps.flushManifest;
    await flushFinal(manifest);

    // Ensure each photo has a cached scene description
    for (const photo of manifest.config.photos) {
        await deps.ensurePhotoSceneCache(photo);
    }

    const cap = clampConcurrent(manifest.config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
    const inFlight = new Set();
    for (const entry of manifest.entries) {
        while (inFlight.size >= cap) {
            await Promise.race(inFlight);
        }
        const p = runEntry(entry, manifest, deps).finally(() => inFlight.delete(p));
        inFlight.add(p);
    }
    await Promise.all(inFlight);

    manifest.status = "completed";
    manifest.totalCostUsd = manifest.entries.filter((e) => e.status === "completed").length * COST_PER_IMAGE_USD;
    await flushFinal(manifest);
}

// Recover any manifest left in "running" state from a prior crash.
// Called at server startup.
async function recoverStaleExperiments() {
    const manifests = await listManifests();
    for (const m of manifests) {
        if (m.status !== "running") continue;
        const { result } = await manifestCoordinator.edit(m.id, (current) => {
            // A new run or retry may have started after the scan listed it.
            if (manifestCoordinator.isActive(m.id) || current.status !== "running") return SKIP_MANIFEST_WRITE;
            for (const entry of current.entries || []) {
                if (entry.status === "running" || entry.status === "pending") {
                    entry.status = "failed";
                    entry.error = "server restarted";
                    entry.completedAt = new Date().toISOString();
                }
            }
            current.status = "failed";
            return true;
        });
        if (result === true) console.log(`[experiments] Recovered stale experiment ${m.id}`);
    }
}

// One-time migration: before the sanitizer was added, outputPath could contain
// spaces/parens/etc. (e.g. "... _New Twilio Illustration_1.png"). The image
// route strips those chars at read time, so such files 404 in the UI. Walk
// every run, rename any file whose name changes under the sanitizer, and
// update the matching entry.outputPath in the manifest. Idempotent — skips
// files that already match, and uses a suffix if the target already exists.
async function migrateFilenamesToSanitized() {
    let manifests;
    try { manifests = await listManifests(); }
    catch (err) { console.warn(`[experiments] migrateFilenames: listManifests failed: ${err.message}`); return; }

    for (const listed of manifests) {
        try {
            await manifestCoordinator.edit(listed.id, async (m) => {
                if (manifestCoordinator.isActive(m.id)) return SKIP_MANIFEST_WRITE;
                const dir = experimentDir(m.id);
                let changed = false;
                for (const entry of m.entries || []) {
                    const oldName = entry.outputPath;
                    if (!oldName || typeof oldName !== "string") continue;
                    // Re-derive the canonical sanitized form from scratch, then append rep+ext.
                    const parts = [
                        path.parse(entry.photo || "").name,
                        entry.style || "", entry.brand || "none", entry.background || "none",
                        entry.variant || "",
                    ].map(sanitizeFilenameSegment);
                    const newName = `${parts.join("_")}_${entry.rep}.png`;
                    if (newName === oldName) continue;

                    const oldPath = path.join(dir, oldName);
                    let target = newName;
                    let targetPath = path.join(dir, target);
                    try {
                        await fsp.access(oldPath, fs.constants.F_OK);
                    } catch {
                        // Old file isn't on disk (failed entry, already migrated elsewhere) —
                        // still update the manifest so the UI builds the correct URL.
                        entry.outputPath = target;
                        changed = true;
                        continue;
                    }
                    // If target already exists and isn't the same inode, disambiguate.
                    let collisionCount = 0;
                    while (true) {
                        try { await fsp.access(targetPath, fs.constants.F_OK); }
                        catch { break; }
                        collisionCount += 1;
                        target = newName.replace(/\.png$/, `-m${collisionCount}.png`);
                        targetPath = path.join(dir, target);
                        if (collisionCount > 20) { target = null; break; }
                    }
                    if (!target) {
                        console.warn(`[experiments] migrateFilenames: giving up on ${oldPath} (too many collisions)`);
                        continue;
                    }
                    try {
                        await fsp.rename(oldPath, targetPath);
                        entry.outputPath = target;
                        changed = true;
                        console.log(`[experiments] migrateFilenames: ${m.id}/${oldName} → ${target}`);
                    } catch (err) {
                        console.warn(`[experiments] migrateFilenames: rename failed ${oldPath}: ${err.message}`);
                    }
                }
                return changed ? true : SKIP_MANIFEST_WRITE;
            });
        } catch (err) {
            console.warn(`[experiments] migrateFilenames: update failed ${listed.id}: ${err.message}`);
        }
    }
}

// ── Route layer ─────────────────────────────────────────────────────────────

// Build a prompt-builder input from a single entry + manifest. This mirrors the
// production pipeline's resolution step but sources style/brand/background
// either from event-scoped settings or from the variant's override map.
//
// Callers supply already-loaded reference buffers + analyses (loaded once per
// run for performance). See resolveRefsAndAnalyses.
function resolveEntryInputs(entry, manifest, photoScene, refs) {
    const ev = manifest.config.eventName || settings.get("eventName");
    const variant = manifest.config.variants.find((v) => v.name === entry.variant);
    const activeStyles = settings.getActiveStyles();
    const customBrands = settings.getForEvent("customBrands", ev) || {};
    const ov = variant && variant.type === "custom" ? migrateOverrides(variant.overrides) : { styles: {}, brands: {} };

    // ── Style: merge base ∪ overrides ─────────────────────────────────────
    let styleObj, stylePrompt;
    const styleO = ov.styles[entry.style];
    const baseStyle = activeStyles[entry.style];
    if (styleO && baseStyle) {
        styleObj = {
            ...baseStyle,
            prompt: styleO.prompt || baseStyle.prompt,
            core: styleO.core || baseStyle.core,
            brandCore: styleO.brandCore || baseStyle.brandCore,
            ...(styleO.behavior ? { behavior: styleO.behavior } : {}),
            ...(typeof styleO.containerDescription === "string" ? { containerDescription: styleO.containerDescription } : {}),
            ...(typeof styleO.acceptsColorPalette === "boolean" ? { acceptsColorPalette: styleO.acceptsColorPalette } : {}),
        };
        stylePrompt = styleObj.prompt;
    } else if (baseStyle) {
        styleObj = baseStyle;
        stylePrompt = baseStyle.prompt;
    } else {
        styleObj = { name: entry.style, core: "", brandCore: "", acceptsColorPalette: true };
        stylePrompt = "";
    }

    // ── Brand: merge base ∪ overrides ─────────────────────────────────────
    let brandObj = null;
    if (entry.brand) {
        const baseBrand = customBrands[entry.brand];
        const brandO = ov.brands[entry.brand];
        if (baseBrand && brandO) {
            const mergedScenes = Array.isArray(baseBrand.scenes)
                ? baseBrand.scenes.map((s) => {
                    const so = brandO.scenes && brandO.scenes[s.key];
                    if (!so) return s;
                    return { ...s, ...(typeof so.prompt === "string" ? { prompt: so.prompt } : {}) };
                })
                : baseBrand.scenes;
            brandObj = {
                ...baseBrand,
                ...(brandO.category ? { category: brandO.category } : {}),
                ...(typeof brandO.wardrobe === "string" ? { wardrobe: brandO.wardrobe } : {}),
                ...(typeof brandO.colorPalette === "string" ? { colorPalette: brandO.colorPalette } : {}),
                ...(typeof brandO.allowOriginal === "boolean" ? { allowOriginal: brandO.allowOriginal } : {}),
                ...(mergedScenes ? { scenes: mergedScenes } : {}),
            };
        } else {
            brandObj = baseBrand || null;
        }
    }

    // Background choice: expand the stored key using the same logic as live.
    let bgChoice = null;
    if (entry.background) {
        const { resolveBackgroundMenu } = require("./prompt-assembler");
        const menu = resolveBackgroundMenu(styleObj, brandObj);
        bgChoice = menu.find((c) => c.key === entry.background) || null;
    }
    const bgMode = bgChoice ? (bgChoice.mode || "ai") : "ai";

    const scene = photoScene && photoScene.parsedScene ? photoScene.parsedScene : { subjects: 1, pets: "none", positions: "centered" };
    let sceneLine;
    const multiIdentityLine = " Each person has DISTINCT facial features, hair, and build — do NOT merge, swap, or blend their features. Each person must remain visually distinct from the others and recognizable as themselves.";
    if (scene.subjects > 1 && scene.pets !== "none") {
        sceneLine = `This photo has exactly ${scene.subjects} HUMAN subjects and a ${scene.pets}. Include ALL of them positioned as shown. The output must contain exactly ${scene.subjects} people and the ${scene.pets} — no more, no fewer.${multiIdentityLine}`;
    } else if (scene.subjects > 1) {
        sceneLine = `This photo has exactly ${scene.subjects} HUMAN subjects. Include ALL of them positioned as shown. The output must contain exactly ${scene.subjects} people — no more, no fewer.${multiIdentityLine}`;
    } else if (scene.pets !== "none") {
        sceneLine = `This photo has exactly 1 person and a ${scene.pets}. The ${scene.pets} is an animal, NOT a person — do not turn the ${scene.pets} into a human. The output must contain exactly 1 person and the ${scene.pets} — no other people.`;
    } else {
        sceneLine = "This photo has exactly 1 person. The output must contain exactly 1 human figure — do not add, invent, or hallucinate any additional people. Anything else in the photo (objects, posters, screens, reflections) is NOT a person.";
    }

    const r = refs || {};
    const brandRefBuffers = r.brandRefBuffers || [];
    const brandAnalysis = r.brandAnalysis || "";
    const styleRefBuffers = r.styleRefBuffers || [];
    const styleAnalysis = r.styleAnalysis || "";
    const bgRefBuffers = r.bgRefBuffers || [];
    const bgAnalysis = r.bgAnalysis || "";
    const brandPrompt = r.brandPrompt || "";

    return {
        styleKey: entry.style, styleObj, stylePrompt,
        brandKey: entry.brand, brandObj,
        brandAnalysis, brandPrompt, brandRefBuffers,
        styleAnalysis, styleRefBuffers,
        bgChoice, bgMode, bgAnalysis, bgRefBuffers,
        scene, sceneLine,
        preserve: settings.getForEvent("promptPreserve", ev),
        preserveBrand: settings.getForEvent("promptPreserveBrand", ev),
        brandInstruction: settings.getForEvent("promptBrandInstruction", ev),
        composition: settings.getForEvent("promptComposition", ev),
        backgroundLine: settings.getForEvent("promptBackground", ev),
        multiSubjectMode: settings.getForEvent("multiSubjectMode", ev) || "reject",
        reviewFeedback: manifest.config.reviewFeedback || null,
    };
}

// Load reference buffers (brand/style/bg) and cached vision analyses for a
// single entry. Mirrors the live pipeline's resolution so eval prompts match
// what the production flow would produce. Analysis cache is shared with the
// live pipeline via analyzeReferences' in-flight dedup Map.
async function resolveRefsAndAnalyses(entry, manifest) {
    const ev = manifest.config.eventName || settings.get("eventName");
    const activeStyles = settings.getActiveStyles();
    const customBrands = settings.getForEvent("customBrands", ev) || {};
    const styleObj = activeStyles[entry.style] || null;
    const variant = manifest.config.variants.find((v) => v.name === entry.variant);
    const ov = variant && variant.type === "custom" ? migrateOverrides(variant.overrides) : { styles: {}, brands: {} };
    const brandOverride = entry.brand ? ov.brands[entry.brand] || null : null;
    const brandObj = entry.brand ? customBrands[entry.brand] || null : null;
    const { analyzeReferences } = require("./pipeline");

    // ── Brand refs + analysis ─────────────────────────────────────────────
    let brandRefFiles = [];
    let brandPrompt = "";
    if (entry.brand && brandObj) {
        const bOverrides = settings.getForEvent("brandPromptOverrides", ev) || {};
        brandRefFiles = brandObj.files || [];
        // Variant wardrobe override takes precedence over everything else so
        // A/B testing "what if the wardrobe were X?" actually changes the prompt.
        const variantWardrobe = brandOverride && typeof brandOverride.wardrobe === "string" && brandOverride.wardrobe.trim()
            ? brandOverride.wardrobe
            : null;
        brandPrompt = variantWardrobe || bOverrides[entry.brand] || brandObj.wardrobe || brandObj.brandPrompt || settings.getForEvent("brandPrompt", ev);
    } else if (entry.brand) {
        // Brand was deleted — fall back to event-level
        brandRefFiles = settings.getForEvent("brandReferenceFiles", ev) || [];
        brandPrompt = settings.getForEvent("brandPrompt", ev);
    }
    const BRAND_REFS_DIR = path.join(__dirname, "..", "brand-references");
    const brandRefBuffers = [];
    for (const filename of brandRefFiles) {
        const filePath = path.join(BRAND_REFS_DIR, path.basename(filename));
        if (fs.existsSync(filePath)) brandRefBuffers.push(await fsp.readFile(filePath));
    }
    let brandAnalysis = "";
    if (brandRefBuffers.length > 0 && entry.brand && brandObj) {
        brandAnalysis = brandObj.analysis || "";
        if (brandAnalysis.length > 500) brandAnalysis = "";
        if (!brandAnalysis) {
            try {
                brandAnalysis = await analyzeReferences(brandRefBuffers, "brand", `brand:${entry.brand}`);
                if (brandAnalysis) {
                    try {
                        const customBrandsForCache = settings.get("customBrands") || {};
                        if (customBrandsForCache[entry.brand]) {
                            customBrandsForCache[entry.brand].analysis = brandAnalysis;
                            settings.update({ customBrands: customBrandsForCache });
                        }
                    } catch { /* caching best-effort */ }
                }
            } catch (err) {
                console.error(`[experiments] Brand analysis failed: ${err.message}`);
            }
        }
    }

    // ── Style refs + analysis ─────────────────────────────────────────────
    const styleRefFiles = (styleObj && styleObj.files) || [];
    const styleRefBuffers = [];
    for (const filename of styleRefFiles) {
        const filePath = path.join(settings.STYLE_REFS_DIR, path.basename(filename));
        if (fs.existsSync(filePath)) styleRefBuffers.push(await fsp.readFile(filePath));
    }
    let styleAnalysis = (styleObj && styleObj.analysis) || "";
    if (styleAnalysis.length > 500) styleAnalysis = "";
    if (styleRefBuffers.length > 0 && !styleAnalysis) {
        try {
            styleAnalysis = await analyzeReferences(styleRefBuffers, "style", `style:${ev}:${entry.style}`);
            if (styleAnalysis && ev === settings.get("eventName")) {
                try {
                    const customs = settings.get("customStyles") || {};
                    if (customs[entry.style]) {
                        customs[entry.style].analysis = styleAnalysis;
                        settings.update({ customStyles: customs });
                    }
                } catch { /* caching best-effort */ }
            }
        } catch (err) {
            console.error(`[experiments] Style analysis failed: ${err.message}`);
        }
    }

    // ── Background refs + analysis ────────────────────────────────────────
    let bgChoice = null;
    if (entry.background) {
        const { resolveBackgroundMenu } = require("./prompt-assembler");
        const menu = resolveBackgroundMenu(styleObj, brandObj);
        bgChoice = menu.find((c) => c.key === entry.background) || null;
    }
    const bgRefFiles = bgChoice ? (bgChoice.files || []) : [];
    const bgMode = bgChoice ? (bgChoice.mode || "ai") : "ai";
    const bgRefBuffers = [];
    for (const filename of bgRefFiles) {
        const filePath = path.join(settings.BG_REFS_DIR, path.basename(filename));
        if (fs.existsSync(filePath)) bgRefBuffers.push(await fsp.readFile(filePath));
    }
    let bgAnalysis = "";
    if (bgRefBuffers.length > 0 && bgMode === "ai" && bgChoice) {
        bgAnalysis = bgChoice.analysis || "";
        if (bgAnalysis.length > 500) bgAnalysis = "";
        if (!bgAnalysis) {
            try {
                bgAnalysis = await analyzeReferences(bgRefBuffers, "background", `bg:${ev}:${bgChoice.key}`);
                if (bgAnalysis && ev === settings.get("eventName")) {
                    try {
                        const allBgChoices = settings.get("backgroundChoices") || [];
                        const idx = allBgChoices.findIndex((c) => c.key === bgChoice.key);
                        if (idx !== -1) {
                            allBgChoices[idx].analysis = bgAnalysis;
                            settings.update({ backgroundChoices: allBgChoices });
                        }
                    } catch { /* caching best-effort */ }
                }
            } catch (err) {
                console.error(`[experiments] Background analysis failed: ${err.message}`);
            }
        }
    }

    return {
        brandRefBuffers, brandAnalysis, brandPrompt,
        styleRefBuffers, styleAnalysis,
        bgRefBuffers, bgAnalysis, bgMode,
    };
}

// Stash image ref Buffers off-manifest. Attaching them to the entry object
// caused saveManifest to serialize megabytes of binary data as JSON during
// concurrent retries → RangeError: Invalid string length.
const _entryRefs = new WeakMap();

async function defaultBuildPromptForEntry(entry, manifest, photosSnapshot) {
    const photos = photosSnapshot || (await loadPhotos());
    const photoScene = photos.photos.find((p) => p.filename === entry.photo) || null;
    const refs = await resolveRefsAndAnalyses(entry, manifest);
    const input = resolveEntryInputs(entry, manifest, photoScene, refs);
    _entryRefs.set(entry, refs);
    return promptBuilder.build(input);
}

async function defaultCallImageEdit({ entry, promptText }) {
    const selfiePath = path.join(TEST_PHOTOS_DIR, entry.photo);
    const selfieBuffer = await fsp.readFile(selfiePath);
    const refs = _entryRefs.get(entry) || {};
    const styleRefBuffers = refs.styleRefBuffers || [];
    const brandRefBuffers = refs.brandRefBuffers || [];
    const bgRefBuffers = refs.bgRefBuffers || [];
    const bgMode = refs.bgMode || "ai";
    const imageFiles = await Promise.all([
        toFile(selfieBuffer, "selfie.jpg", { type: "image/jpeg" }),
        ...styleRefBuffers.map((buf, i) => toFile(buf, `style_ref_${i}.png`, { type: "image/png" })),
        ...brandRefBuffers.map((buf, i) => toFile(buf, `brand_ref_${i}.png`, { type: "image/png" })),
        ...(bgMode === "ai" ? bgRefBuffers : []).map((buf, i) => toFile(buf, `bg_ref_${i}.png`, { type: "image/png" })),
    ]);
    // Exact background mode requires transparent-alpha output, which only
    // gpt-image-1.5 supports. Force the model for this mode only; other
    // modes use the configured model.
    const isExactBg = bgMode === "exact" && bgRefBuffers.length > 0;
    const imageModel = isExactBg ? "gpt-image-1.5" : getModels().imageGen;
    const editParams = {
        model: imageModel,
        image: imageFiles,
        prompt: promptText,
        size: "1024x1536",
        quality: "high",
    };
    if (isExactBg) {
        editParams.background = "transparent";
    }
    if (imageModel.startsWith("gpt-image-1")) {
        editParams.input_fidelity = "high";
    }
    const result = await withRetry(() => getOpenAI().images.edit(editParams));
    const data = result.data && result.data[0];
    if (!data || !data.b64_json) throw new Error("No image returned");
    const portraitBuf = Buffer.from(data.b64_json, "base64");

    // Exact background mode: composite the transparent-alpha portrait onto
    // the literal uploaded background image. Mirrors pipeline.js so /eval
    // matches production.
    if (bgMode === "exact" && bgRefBuffers.length > 0) {
        try {
            const meta = await sharp(portraitBuf).metadata();
            return await compositeExactBackground({
                portraitBuf,
                backgroundBuf: bgRefBuffers[0],
                width: meta.width || 1024,
                height: meta.height || 1536,
            });
        } catch (bgErr) {
            console.error(`[experiments] Exact background compositing failed (using portrait as-is): ${bgErr.message}`);
        }
    }

    return portraitBuf;
}

async function defaultEnsurePhotoSceneCache(filename) {
    const photos = await loadPhotos();
    const entry = photos.photos.find((p) => p.filename === filename);
    if (!entry) throw new Error(`Photo ${filename} not found`);
    if (entry.sceneDescription) return;
    const photoPath = path.join(TEST_PHOTOS_DIR, filename);
    const buf = await fsp.readFile(photoPath);
    const b64 = buf.toString("base64");
    const sceneText = await analyzeScene(b64);
    const parsed = parseScene(sceneText);
    await updatePhotoScene(filename, sceneText, parsed);
}

function runtimeEvalChrome() {
    const { userBarSnippet, magicHatSnippet } = require("./auth");
    return { userBar: userBarSnippet(), magicHat: magicHatSnippet() };
}

function runtimePageShell(options) {
    return pageShell({ ...options, ...runtimeEvalChrome() });
}

function buildRouter() {
    const router = express.Router();

    router.get("/", async (req, res) => {
        const [summaries, evalSettings] = await Promise.all([listRunSummaries(), loadEvalSettings()]);
        res.type("html").send(renderEvalRunsPage({
            summaries, evalSettings,
            activeEvent: settings.get("eventName") || "",
            query: req.query,
            ...runtimeEvalChrome(),
        }));
    });

    router.get("/new", async (req, res) => {
        const [photosData, savedData, evalSettings] = await Promise.all([
            loadPhotos(), loadSavedVariants(), loadEvalSettings(),
        ]);
        const activeEvent = settings.get("eventName");
        res.type("html").send(renderEvalNewPage({
            activeStyles: settings.getActiveStyles(),
            activeBrands: getActiveBrands(),
            photos: photosData.photos,
            savedVariants: savedData.variants,
            evalSettings,
            activeEvent,
            eventNames: [...new Set([activeEvent, ...settings.listEventProfiles()].filter(Boolean))],
            ...runtimeEvalChrome(),
        }));
    });

    router.get("/run/:id", async (req, res) => {
        let manifest;
        try { manifest = await loadManifest(req.params.id); }
        catch (err) {
            if (err.code === "ENOENT") return res.status(404).send("Not found");
            throw err;
        }
        res.type("html").send(renderEvalRunDetailPage({
            manifest, query: req.query, ...runtimeEvalChrome(),
        }));
    });

    router.get("/photos", async (req, res) => {
        const photos = (await loadPhotos()).photos;
        res.type("html").send(renderEvalPhotosPage({ photos, ...runtimeEvalChrome() }));
    });

    router.get("/variants", async (req, res) => {
        const { variants } = await loadSavedVariants();
        res.type("html").send(renderEvalVariantsPage({
            variants, activeStyles: settings.getActiveStyles(), activeBrands: getActiveBrands(),
            ...runtimeEvalChrome(),
        }));
    });

    router.get("/api/runs", async (req, res) => {
        // Returns run summaries (status/totals/cost/group) — not full manifests.
        // Consumers that need entries should call /api/runs/:id.
        try {
            if (typeof req.query.ids === "string") {
                const ids = [...new Set(req.query.ids.split(",").filter((id) => /^[A-Za-z0-9._:-]{1,120}$/.test(id) && id !== "." && id !== ".."))].slice(0, 50);
                const runs = (await Promise.all(ids.map(async (id) => {
                    if (_summaryCache.has(id)) return _summaryCache.get(id);
                    try {
                        const summary = summarizeManifest(await loadManifest(id));
                        _summaryCache.set(id, summary);
                        return summary;
                    } catch (err) {
                        if (err.code !== "ENOENT") console.warn(`[experiments] Could not load run ${id}: ${err.message}`);
                        return null;
                    }
                }))).filter(Boolean);
                return res.json({ runs });
            }
            const summaries = await listRunSummaries();
            if (req.query.paged === "1") {
                return res.json(paginateRunSummaries(summaries, { activeEvent: settings.get("eventName") || "", ...req.query }));
            }
            res.json({ runs: summaries });
        }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get("/api/groups", async (req, res) => {
        try {
            const summaries = await listRunSummaries();
            const groups = [...new Set(summaries.map((m) => (m.group || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
            res.json({ groups });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post("/api/runs", express.json({ limit: "1mb" }), async (req, res) => {
        try {
            const {
                name, styles, brands, photos, reps, variants, maxConcurrent,
                bgSelections, bgCategories, backgrounds, eventName, reviewFeedback,
                group,
            } = req.body || {};
            if (!name || !Array.isArray(styles) || !Array.isArray(brands) || !Array.isArray(photos) || !Array.isArray(variants)) {
                return res.status(400).json({ error: "Missing required fields" });
            }
            if (variants.length > MAX_VARIANTS_PER_EXPERIMENT) {
                return res.status(400).json({ error: `Too many variants (max ${MAX_VARIANTS_PER_EXPERIMENT})` });
            }
            if (!styles.length || !photos.length || !variants.length) {
                return res.status(400).json({ error: "Pick at least one style, one photo, and one variant" });
            }
            const defaults = await loadEvalSettings();
            const resolvedBrands = brands.length ? brands : [null];
            const ev = (eventName && typeof eventName === "string" && eventName.trim()) || settings.get("eventName");

            // Group explicit user selections by brand key ("" = no brand).
            // If the client sent bgSelections, that's authoritative. Otherwise
            // fall back to categories (legacy) or flat backgrounds list.
            const selectionsByBrand = new Map();
            if (Array.isArray(bgSelections) && bgSelections.length) {
                for (const s of bgSelections) {
                    if (!s || typeof s.bg !== "string") continue;
                    const key = s.brand || "";
                    if (!selectionsByBrand.has(key)) selectionsByBrand.set(key, new Set());
                    selectionsByBrand.get(key).add(s.bg);
                }
            }
            const categories = !selectionsByBrand.size && Array.isArray(bgCategories) && bgCategories.length
                ? bgCategories
                : (!selectionsByBrand.size && Array.isArray(backgrounds) && backgrounds.length ? null : null);

            // Expand the backgrounds per (style × brand) combination using the
            // same logic as the live pipeline. This is what makes cartoon ×
            // chelsea-fc correctly produce stadium/original/plain-white.
            const { resolveBackgroundMenu } = require("./prompt-assembler");
            const activeStyles = settings.getActiveStyles();
            const customBrands = settings.getForEvent("customBrands", ev) || {};
            const entries = [];
            const effectiveReps = Math.max(1, Number(reps) || 1);
            const allBgKeys = new Set();
            for (const photo of photos) {
                for (const style of styles) {
                    const styleObj = activeStyles[style] || null;
                    for (const brand of resolvedBrands) {
                        const brandObj = brand ? customBrands[brand] || null : null;
                        const menu = resolveBackgroundMenu(styleObj, brandObj);
                        let bgKeys;
                        if (selectionsByBrand.size) {
                            const allowed = selectionsByBrand.get(brand || "") || new Set();
                            bgKeys = menu.filter((c) => allowed.has(c.key)).map((c) => c.key);
                            if (!bgKeys.length) continue; // no valid bg for this combo → skip
                        } else if (categories) {
                            bgKeys = menu.filter((c) => {
                                if (c.key === "original") return categories.includes("original");
                                if (c.key === "plain-white") return categories.includes("plain-white");
                                return categories.includes("brand-scenes");
                            }).map((c) => c.key);
                            if (!bgKeys.length) bgKeys = [null];
                        } else if (Array.isArray(backgrounds) && backgrounds.length) {
                            bgKeys = backgrounds;
                        } else {
                            bgKeys = [null];
                        }
                        for (const bg of bgKeys) {
                            allBgKeys.add(bg || "none");
                            for (const variant of variants) {
                                for (let rep = 1; rep <= effectiveReps; rep++) {
                                    const brandSeg = brand || "none";
                                    const bgSeg = bg || "none";
                                    const parts = [
                                        path.parse(photo).name,
                                        style, brandSeg, bgSeg, variant.name,
                                    ].map(sanitizeFilenameSegment);
                                    entries.push({
                                        photo, style, brand, background: bg,
                                        variant: variant.name, rep,
                                        status: "pending",
                                        outputPath: `${parts.join("_")}_${rep}.png`,
                                        promptText: null, generationMs: null, error: null,
                                        startedAt: null, completedAt: null,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            if (!entries.length) {
                return res.status(400).json({ error: "No valid (photo × style × brand × background) combinations. Check your background selections." });
            }
            if (entries.length > MAX_ENTRIES_PER_EXPERIMENT) {
                return res.status(400).json({ error: `Too many entries (${entries.length} > max ${MAX_ENTRIES_PER_EXPERIMENT})` });
            }
            const config = {
                styles, brands: resolvedBrands,
                backgrounds: [...allBgKeys].map((k) => k === "none" ? null : k),
                bgSelections: selectionsByBrand.size
                    ? [...selectionsByBrand.entries()].flatMap(([b, set]) => [...set].map((bg) => ({ brand: b || null, bg })))
                    : null,
                photos, reps: effectiveReps, variants,
                eventName: ev,
                reviewFeedback: (reviewFeedback && String(reviewFeedback).trim()) || null,
                maxConcurrent: clampConcurrent(maxConcurrent ?? defaults.maxConcurrent),
            };
            const id = makeId(name);
            const trimmedGroup = (group && typeof group === "string") ? group.trim().slice(0, 40) : "";
            const manifest = {
                id, name, createdAt: new Date().toISOString(), status: "pending",
                config, entries, winners: {}, starred: [], notes: "", totalCostUsd: 0,
                ...(trimmedGroup ? { group: trimmedGroup } : {}),
            };
            // Keep the new run canonical from its first disk write onward.
            // prepare() releases ownership if directory, save, or photo setup fails.
            const deps = await manifestCoordinator.prepare(manifest, async () => {
                await fsp.mkdir(experimentDir(id), { recursive: true });
                await saveManifest(manifest);
                const photosSnapshot = await loadPhotos();
                return {
                    // Hot path: debounced so per-entry transitions coalesce.
                    flushManifest: debouncedSaveManifest,
                    // Terminal transitions: durable sync write.
                    flushFinal: async (m) => { await flushDebouncedSave(m.id); await saveManifest(m); },
                    buildPromptForEntry: (entry, current) => defaultBuildPromptForEntry(entry, current, photosSnapshot),
                    callImageEdit: defaultCallImageEdit,
                    ensurePhotoSceneCache: defaultEnsurePhotoSceneCache,
                };
            });
            // Kick off asynchronously; don't await.
            runExperiment(manifest, deps).catch(async (err) => {
                console.error(`[experiments] Experiment ${id} crashed: ${err.message}`);
                manifest.status = "failed";
                try { await flushDebouncedSave(id); } catch {}
                // If this write also fails (e.g., disk full), the manifest stays in
                // "running" until recoverStaleExperiments() runs at next server startup.
                try { await saveManifest(manifest); }
                catch (saveErr) { console.error(`[experiments] Could not save failed run ${id}: ${saveErr.message}`); }
            }).finally(() => manifestCoordinator.deactivate(manifest));
            res.json({ id });
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get("/api/runs/:id", async (req, res) => {
        try { res.json(await loadManifest(req.params.id)); }
        catch (err) { res.status(err.code === "ENOENT" ? 404 : 500).json({ error: err.message }); }
    });

    router.get("/api/runs/:id/summary", async (req, res) => {
        try {
            let summary = _summaryCache.get(req.params.id);
            if (!summary) {
                summary = summarizeManifest(await loadManifest(req.params.id));
                _summaryCache.set(req.params.id, summary);
            }
            res.json(summary);
        } catch (err) { res.status(err.code === "ENOENT" ? 404 : 500).json({ error: err.message }); }
    });

    router.patch("/api/runs/:id", express.json(), async (req, res) => {
        try {
            const body = req.body || {};
            await manifestCoordinator.edit(req.params.id, (manifest) => {
                if (body.winners) manifest.winners = { ...(manifest.winners || {}), ...body.winners };
                if (typeof body.notes === "string") manifest.notes = body.notes;
                if (typeof body.group === "string") {
                    const g = body.group.trim().slice(0, 40);
                    if (g) manifest.group = g;
                    else delete manifest.group;
                }
            });
            res.json({ ok: true });
        } catch (err) { res.status(err.code === "ENOENT" ? 404 : 500).json({ error: err.message }); }
    });

    router.delete("/api/runs/:id", async (req, res) => {
        try {
            await manifestCoordinator.remove(req.params.id, () =>
                fsp.rm(experimentDir(req.params.id), { recursive: true, force: true }));
            invalidateRunSummary(req.params.id);
            res.json({ ok: true });
        } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
    });

    router.post("/api/runs/:id/star", express.json(), async (req, res) => {
        try {
            const { outputPath, starred } = req.body || {};
            if (!outputPath || typeof outputPath !== "string") {
                return res.status(400).json({ error: "outputPath required" });
            }
            const { result: starredCount } = await manifestCoordinator.edit(req.params.id, (manifest) => {
                const hasEntry = (manifest.entries || []).some((e) => e.outputPath === outputPath);
                if (!hasEntry) {
                    const error = new Error("entry not found");
                    error.status = 404;
                    throw error;
                }
                const current = new Set(Array.isArray(manifest.starred) ? manifest.starred : []);
                if (starred) current.add(outputPath);
                else current.delete(outputPath);
                manifest.starred = [...current];
                return manifest.starred.length;
            });
            res.json({ ok: true, starredCount });
        } catch (err) { res.status(err.status || (err.code === "ENOENT" ? 404 : 500)).json({ error: err.message }); }
    });

    function markEntriesForRetry(manifest, entries) {
        for (const entry of entries) {
            entry.status = "pending";
            entry.error = null;
            entry.startedAt = null;
            entry.completedAt = null;
            entry.generationMs = null;
            retriedEntries.delete(entry);
        }
        if (manifest.status !== "running") manifest.status = "running";
    }

    // The route has already marked and saved these entries through the
    // coordinator, retaining the live manifest until this batch finishes.
    async function retryEntries(manifest, entries) {
        try {
            const photosSnapshot = await loadPhotos();
            const deps = {
                flushManifest: debouncedSaveManifest,
                flushFinal: async (m) => { await flushDebouncedSave(m.id); await saveManifest(m); },
                buildPromptForEntry: (e, m) => defaultBuildPromptForEntry(e, m, photosSnapshot),
                callImageEdit: defaultCallImageEdit,
                ensurePhotoSceneCache: defaultEnsurePhotoSceneCache,
            };

            // Run async; don't await. Respect per-run concurrency cap.
            (async () => {
                const uniquePhotos = [...new Set(entries.map((e) => e.photo))];
                for (const p of uniquePhotos) {
                    try { await deps.ensurePhotoSceneCache(p); }
                    catch (err) { console.warn(`[experiments] ensurePhotoSceneCache failed for ${p}: ${err.message}`); }
                }
                const cap = clampConcurrent(manifest.config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
                const inFlight = new Set();
                for (const entry of entries) {
                    while (inFlight.size >= cap) await Promise.race(inFlight);
                    const p = runEntry(entry, manifest, deps).finally(() => inFlight.delete(p));
                    inFlight.add(p);
                }
                await Promise.all(inFlight);

                const hasRunning = manifest.entries.some((e) => e.status === "running" || e.status === "pending");
                if (!hasRunning) {
                    const hasFailed = manifest.entries.some((e) => e.status === "failed");
                    manifest.status = hasFailed ? "failed" : "completed";
                    manifest.totalCostUsd = manifest.entries.filter((e) => e.status === "completed").length * COST_PER_IMAGE_USD;
                    await flushDebouncedSave(manifest.id);
                    await saveManifest(manifest);
                }
            })().catch((err) => console.error(`[experiments] Retry batch crashed: ${err.message}`))
                .finally(async () => {
                    // Drain any delayed runner write before giving up ownership;
                    // otherwise it could fire after a subsequent API edit.
                    try { await flushDebouncedSave(manifest.id); }
                    catch (err) { console.warn(`[experiments] Retry flush failed: ${err.message}`); }
                    manifestCoordinator.deactivate(manifest);
                });

            return entries.length;
        } catch (err) {
            manifestCoordinator.deactivate(manifest);
            throw err;
        }
    }

    router.post("/api/runs/:id/entries/:outputPath/retry", async (req, res) => {
        try {
            const { manifest, result: entries } = await manifestCoordinator.edit(req.params.id, (current) => {
                const entry = current.entries.find((e) => e.outputPath === req.params.outputPath);
                if (!entry) {
                    const err = new Error("entry not found");
                    err.status = 404;
                    throw err;
                }
                if (entry.status === "running" || entry.status === "pending") {
                    const err = new Error("entry is already running");
                    err.status = 409;
                    throw err;
                }
                markEntriesForRetry(current, [entry]);
                return [entry];
            }, { activate: true });
            await retryEntries(manifest, entries);
            res.json({ ok: true });
        } catch (err) {
            res.status(err.status || (err.code === "ENOENT" ? 404 : 500)).json({ error: err.message });
        }
    });

    router.post("/api/runs/:id/retry-failed", async (req, res) => {
        try {
            const { manifest, result: failed } = await manifestCoordinator.edit(req.params.id, (current) => {
                const failedEntries = current.entries.filter((e) => e.status === "failed");
                if (failedEntries.length) markEntriesForRetry(current, failedEntries);
                return failedEntries;
            }, { activate: true });
            if (!failed.length) {
                manifestCoordinator.deactivate(manifest);
                return res.json({ ok: true, retried: 0 });
            }
            const count = await retryEntries(manifest, failed);
            res.json({ ok: true, retried: count });
        } catch (err) {
            res.status(err.code === "ENOENT" ? 404 : 500).json({ error: err.message });
        }
    });

    router.get("/api/photos", async (req, res) => {
        try { res.json(await loadPhotos()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Raw JPEG upload — body is the image bytes, filename in query string.
    // Keeps the route dependency-free (no multer). Max 8MB.
    router.post("/api/photos", express.raw({ type: "image/jpeg", limit: "8mb" }), async (req, res) => {
        try {
            const rawFilename = req.query.filename ? String(req.query.filename) : "";
            if (!/^[A-Za-z0-9._-]+\.(jpe?g)$/i.test(rawFilename)) {
                return res.status(400).json({ error: "filename must match [A-Za-z0-9._-]+\\.(jpg|jpeg)" });
            }
            const filename = rawFilename;
            const displayName = req.query.displayName ? String(req.query.displayName) : filename;
            if (!Buffer.isBuffer(req.body) || req.body.length < 1024) {
                return res.status(400).json({ error: "body must be raw image/jpeg bytes" });
            }
            // Quick signature check (JPEG SOI)
            if (!(req.body[0] === 0xff && req.body[1] === 0xd8)) {
                return res.status(400).json({ error: "body does not look like a JPEG" });
            }
            const added = await addPhoto({ filename, displayName, buffer: req.body });
            // Scene analysis happens inline and may fail — keep the photo either way
            try {
                const b64 = req.body.toString("base64");
                const sceneText = await analyzeScene(b64);
                const parsed = parseScene(sceneText);
                await updatePhotoScene(filename, sceneText, parsed);
                added.sceneDescription = sceneText;
                added.parsedScene = parsed;
            } catch (err) {
                console.warn(`[experiments] Scene analysis failed for ${filename}: ${err.message}`);
            }
            res.json(added);
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete("/api/photos/:name", async (req, res) => {
        try {
            const name = req.params.name;
            if (!/^[A-Za-z0-9._-]+\.(jpe?g)$/i.test(name)) {
                return res.status(400).json({ error: "invalid filename" });
            }
            if (await isPhotoInUseByRunning(name)) {
                return res.status(409).json({ error: "Photo is in use by a running experiment" });
            }
            await removePhoto(name);
            res.json({ ok: true });
        } catch (err) {
            if (/not found/i.test(err.message)) return res.status(404).json({ error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    // ── Eval settings (global defaults) ───────────────────────────────────
    router.get("/api/settings", async (req, res) => {
        try { res.json(await loadEvalSettings()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.patch("/api/settings", express.json(), async (req, res) => {
        try {
            const current = await loadEvalSettings();
            const next = { ...current, ...(req.body || {}) };
            if (req.body && req.body.maxConcurrent !== undefined) {
                const n = Number(req.body.maxConcurrent);
                if (!Number.isFinite(n) || n < MIN_CONCURRENT || n > MAX_CONCURRENT_CAP) {
                    return res.status(400).json({ error: `maxConcurrent must be between ${MIN_CONCURRENT} and ${MAX_CONCURRENT_CAP}` });
                }
            }
            res.json(await saveEvalSettings(next));
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    // ── Saved variant library ─────────────────────────────────────────────
    router.get("/api/variants", async (req, res) => {
        try { res.json(await loadSavedVariants()); }
        catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post("/api/variants", express.json({ limit: "1mb" }), async (req, res) => {
        try {
            const { name, description, overrides } = req.body || {};
            if (!name || typeof name !== "string" || !/^[A-Za-z0-9 _.\-]+$/.test(name)) {
                return res.status(400).json({ error: "name is required (letters, numbers, spaces, . _ -)" });
            }
            if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
                return res.status(400).json({ error: "overrides must be an object keyed by style" });
            }
            const entry = await addSavedVariant({ name: name.trim(), description, overrides });
            res.json(entry);
        } catch (err) {
            if (/already exists/i.test(err.message)) return res.status(409).json({ error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    router.patch("/api/variants/:name", express.json({ limit: "1mb" }), async (req, res) => {
        try {
            const entry = await updateSavedVariant(req.params.name, req.body || {});
            res.json(entry);
        } catch (err) {
            if (/not found/i.test(err.message)) return res.status(404).json({ error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    router.delete("/api/variants/:name", async (req, res) => {
        try {
            await removeSavedVariant(req.params.name);
            res.json({ ok: true });
        } catch (err) {
            if (/not found/i.test(err.message)) return res.status(404).json({ error: err.message });
            res.status(500).json({ error: err.message });
        }
    });

    // Static PNG serving. Scope tightly — only expose experiment dirs.
    router.get("/images/:id/:file", (req, res) => {
        const safeId = String(req.params.id).replace(/[^A-Za-z0-9._:-]/g, "");
        const safeFile = String(req.params.file).replace(/[^A-Za-z0-9._-]/g, "");
        if (!safeFile.endsWith(".png")) return res.status(400).end();
        const fp = path.join(experimentDir(safeId), safeFile);
        // path.join normalizes `..` segments; startsWith then rejects anything
        // that escaped the experiments tree.
        if (!fp.startsWith(EXPERIMENTS_DIR)) return res.status(400).end();
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.sendFile(fp, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    });

    // Lazy prompt-text serving. Tiles load the prompt on open (not in the
    // list HTML) so pages with hundreds of tiles stay fast. Falls back to
    // manifest.promptText for older runs that predate the sidecar files.
    router.get("/prompts/:id/:file", async (req, res) => {
        const safeId = String(req.params.id).replace(/[^A-Za-z0-9._:-]/g, "");
        const safeFile = String(req.params.file).replace(/[^A-Za-z0-9._-]/g, "");
        if (!safeFile.endsWith(".png")) return res.status(400).end();
        const promptName = safeFile.replace(/\.png$/, ".prompt.txt");
        const fp = path.join(experimentDir(safeId), promptName);
        if (!fp.startsWith(EXPERIMENTS_DIR)) return res.status(400).end();
        try {
            const text = await fsp.readFile(fp, "utf8");
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            res.type("text/plain").send(text);
            return;
        } catch (err) {
            if (err.code !== "ENOENT") return res.status(500).end();
        }
        // Fallback: pull from the manifest (older runs without sidecar).
        try {
            const m = await loadManifest(safeId);
            const entry = m.entries.find((e) => e.outputPath === safeFile);
            if (entry && entry.promptText) return res.type("text/plain").send(entry.promptText);
            return res.status(404).end();
        } catch { return res.status(404).end(); }
    });

    return router;
}

async function mountExperiments(app) {
    // Keep boot fast. Only ensureDirs() blocks — the rest runs in the
    // background so Azure Files SMB latency (tens of ms per op × hundreds
    // of manifests) doesn't delay the app coming up and taking traffic.
    await ensureDirs();
    app.use("/eval", buildRouter());
    console.log("[experiments] Tracker mounted at /eval");

    // Background: recover any stale "running" experiments from a prior crash.
    setImmediate(() => {
        recoverStaleExperiments()
            .catch((err) => console.warn(`[experiments] recoverStaleExperiments failed: ${err.message}`));
    });

    // Background: one-time migration of pre-sanitizer filenames. Skip if we've
    // already run it on this volume — the marker file prevents scanning every
    // run on every boot.
    const migrationMarker = path.join(EXPERIMENTS_DIR, ".filename-migration.done");
    setImmediate(async () => {
        try {
            await fsp.access(migrationMarker, fs.constants.F_OK);
            return; // Already migrated.
        } catch {}
        try {
            await migrateFilenamesToSanitized();
            await fsp.writeFile(migrationMarker, new Date().toISOString(), "utf8");
            console.log("[experiments] filename migration complete");
        } catch (err) {
            console.warn(`[experiments] migrateFilenamesToSanitized failed: ${err.message}`);
        }
    });
}

module.exports = {
    // constants
    EXPERIMENTS_DIR, TEST_PHOTOS_DIR, PHOTOS_JSON,
    MAX_CONCURRENT, MAX_RETRIES, MAX_ENTRIES_PER_EXPERIMENT, MAX_VARIANTS_PER_EXPERIMENT, COST_PER_IMAGE_USD,
    // helpers
    ensureDirs, experimentDir, manifestPath,
    loadManifest, saveManifest, listManifests,
    buildEntries, makeId,
    loadPhotos, savePhotos, addPhoto, updatePhotoScene, removePhoto, isPhotoInUseByRunning,
    runEntry, runExperiment, recoverStaleExperiments,
    buildRouter, mountExperiments, resolveEntryInputs,
    paginateRunSummaries, renderEvalRunsPage, renderEvalNewPage, renderEvalPhotosPage, renderEvalVariantsPage, renderEvalRunDetailPage,
    defaultBuildPromptForEntry, defaultCallImageEdit, defaultEnsurePhotoSceneCache,
    migrateFilenamesToSanitized, sanitizeFilenameSegment,
};

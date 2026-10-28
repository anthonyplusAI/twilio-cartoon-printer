// One process owns each active run's manifest. Runner progress and API edits
// must mutate that same object, while all reads/modifications/writes to an
// inactive run are serialized by ID.
const SKIP_MANIFEST_WRITE = Symbol("skip manifest write");

function createManifestCoordinator({ read, write, onChange = () => {}, onDebounceError = () => {}, debounceMs = 2000 }) {
    const queues = new Map();
    const active = new Map();
    const timers = new Map();
    const pending = new Map();
    const deleting = new Set();

    function activeRunError(id) {
        const error = new Error(`Run ${id} is active`);
        error.status = 409;
        return error;
    }

    function enqueue(id, action) {
        const previous = queues.get(id) || Promise.resolve();
        const next = previous.catch(() => {}).then(action);
        queues.set(id, next);
        const cleanup = () => { if (queues.get(id) === next) queues.delete(id); };
        next.then(cleanup, cleanup);
        return next;
    }

    async function persist(manifest) {
        await write(manifest);
        onChange(manifest);
    }

    function activate(manifest) {
        if (deleting.has(manifest.id)) throw activeRunError(manifest.id);
        const current = active.get(manifest.id);
        if (current) {
            if (current.manifest !== manifest) throw new Error(`Run ${manifest.id} already has an active manifest`);
            current.owners++;
        } else {
            active.set(manifest.id, { manifest, owners: 1 });
        }
        return manifest;
    }

    function deactivate(manifest) {
        const current = active.get(manifest.id);
        if (!current || current.manifest !== manifest) return;
        current.owners--;
        if (current.owners === 0) active.delete(manifest.id);
    }

    function isActive(id) { return active.has(id); }

    async function prepare(manifest, setup) {
        activate(manifest);
        try { return await setup(manifest); }
        catch (error) {
            deactivate(manifest);
            throw error;
        }
    }

    function save(manifest) {
        if (deleting.has(manifest.id)) return Promise.reject(activeRunError(manifest.id));
        return enqueue(manifest.id, async () => { await persist(manifest); return manifest; });
    }

    function edit(id, change, { activate: keepActive = false } = {}) {
        return enqueue(id, async () => {
            const manifest = active.get(id)?.manifest || await read(id);
            const result = await change(manifest);
            if (result === SKIP_MANIFEST_WRITE) return { manifest, result };
            await persist(manifest);
            if (keepActive) activate(manifest);
            return { manifest, result };
        });
    }

    function debouncedSave(manifest) {
        if (deleting.has(manifest.id)) throw activeRunError(manifest.id);
        pending.set(manifest.id, manifest);
        // Show live runner progress while the durable write is waiting.
        onChange(manifest);
        if (timers.has(manifest.id)) return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(async () => {
                timers.delete(manifest.id);
                const latest = pending.get(manifest.id);
                pending.delete(manifest.id);
                if (latest) {
                    try { await save(latest); }
                    catch (error) { onDebounceError(error, latest); }
                }
                resolve();
            }, debounceMs);
            timers.set(manifest.id, { timer, resolve });
        });
    }

    async function flushDebounced(id) {
        const scheduled = timers.get(id);
        if (scheduled) {
            clearTimeout(scheduled.timer);
            timers.delete(id);
        }
        const latest = pending.get(id);
        pending.delete(id);
        try {
            if (latest) await save(latest);
        } finally {
            if (scheduled) scheduled.resolve();
        }
    }

    function remove(id, erase) {
        if (active.has(id) || timers.has(id) || pending.has(id) || deleting.has(id)) {
            return Promise.reject(activeRunError(id));
        }
        // Reserve the ID before the queued delete starts. A late runner save
        // must not recreate the directory after erase finishes.
        deleting.add(id);
        const task = enqueue(id, async () => {
            if (active.has(id) || timers.has(id) || pending.has(id)) throw activeRunError(id);
            return erase(id);
        });
        const release = () => deleting.delete(id);
        task.then(release, release);
        return task;
    }

    return { activate, deactivate, isActive, prepare, save, edit, debouncedSave, flushDebounced, remove };
}

module.exports = { createManifestCoordinator, SKIP_MANIFEST_WRITE };

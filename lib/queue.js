const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { createHash, randomUUID } = require("node:crypto");
const sharp = require("sharp");
const {
    MAX_RETRIES,
    formatTimestamp,
    PENDING_DIR,
    GENERATING_DIR,
    READY_DIR,
    PRINTING_DIR,
    PROCESSING_DIR,
    REVIEW_DIR,
    DONE_DIR,
    FAILED_DIR,
} = require("./config");
const settings = require("./settings");
const messaging = require("./messaging");
const channels = require("./channels");
const contacts = require("./contacts");
const { generateImage, printJob, jobPaths, moveStagedToFinal, cleanupStaged, aiReviewImage, aiPickBestVariant } = require("./pipeline");
const { getActivePrinters } = require("./printer");
const { DEFAULT_STYLE } = require("./styles");
const leads = require("./leads");
const nps = require("./nps");
const audit = require("./audit");
const stillWorking = require("./still-working");
const i18n = require("./i18n");
const optionI18n = require("./option-i18n");
const { atomicWriteFile, atomicWriteFileSync, cleanupTempDirectory, renameWithRetrySync } = require("./atomic-write");
const relayHeartbeats = require("./relay-heartbeats");
const { acquireRelayJobLock } = require("./relay-job-lock");
const voiceDelivery = require("./voice/delivery");
const { selectBackgroundChoices } = require("./prompt-assembler");

const QUEUE_TMP_DIR = path.join(path.dirname(PENDING_DIR), ".tmp");
const VOICE_GROUP_DIR = path.join(path.dirname(PENDING_DIR), "voice-groups");
const KIOSK_PARENT_DECISION_DIR = path.join(path.dirname(PENDING_DIR), "kiosk-parent-decisions");
const KIOSK_GROUP_PUBLICATION_DIR = path.join(path.dirname(PENDING_DIR), "kiosk-group-publications");
const voiceGroupLocks = new Map();
const kioskGroupPublicationLocks = new Map();

function jobAdapter(job) {
    if (job.channel) {
        const selected = channels.ADAPTERS[job.channel];
        if (!selected || !selected.isConfigured()) {
            throw new Error(`Selected delivery channel "${job.channel}" is not configured`);
        }
        return selected;
    }
    const preferred = contacts.getPreferredChannel(job.userPhone);
    if (preferred && channels.ADAPTERS[preferred]?.isConfigured()) return channels.ADAPTERS[preferred];
    return channels.getConfiguredAdapters()[0] || null;
}

function jobSendOptions(job, options = {}) {
    const adapter = jobAdapter(job);
    return adapter ? { ...options, adapter } : options;
}

function jobEventSetting(job, key) {
    if (job.inputMode === "voice" && Object.prototype.hasOwnProperty.call(job.voiceEventSettings || {}, key)) {
        return job.voiceEventSettings[key];
    }
    if (job.kioskSubmission && Object.prototype.hasOwnProperty.call(job.kioskEventSnapshot?.eventSettings || {}, key)) {
        return job.kioskEventSnapshot.eventSettings[key];
    }
    return settings.getForEvent(key, job.eventName);
}

function effectiveReviewMode(job) {
    return jobEventSetting(job, "reviewMode")
        || (jobEventSetting(job, "enableManualReview") ? "human" : "off");
}

function markVariantReviewMode(job, reviewMode) {
    if (!job.parentJobId) return;
    job.reviewModeAtReview = reviewMode;
    job.aiBestOfNMode = reviewMode === "ai";
}

function shouldSkipDeliveryMedia(adapter, shareLinks, sharePageOnly) {
    return (!adapter || adapter.name !== "whatsapp") && !!shareLinks && sharePageOnly === true;
}

function oversizedWhatsappImageSuffix(shareLinks, imageUrl) {
    return shareLinks || !imageUrl ? "" : `\n${imageUrl}`;
}

function selectWhatsappDeliveryMedia(outputBytes, {
    finalImageUrl,
    finalImagePath,
    mmsImageUrl,
    mmsImagePath,
}) {
    if (outputBytes <= 5 * 1024 * 1024 || !mmsImageUrl) {
        return { imageUrl: outputBytes <= 5 * 1024 * 1024 ? finalImageUrl : null, templateImagePath: finalImagePath };
    }
    return { imageUrl: mmsImageUrl, templateImagePath: mmsImagePath };
}

function shouldUseRichDelivery({ templateKey, kioskWhatsapp, adapterName, imageUrl, contentSid, baseUrl }) {
    return (templateKey !== "deliveryPrint" || kioskWhatsapp)
        && adapterName === "whatsapp" && !!imageUrl && !!contentSid && !!baseUrl;
}

function hasActiveDigitalDeliveryLock(job) {
    return job.inputMode === "voice" ? false : !!job.digitalDeliveryPendingAt;
}

function markVoiceDeliveryPending(job, kind) {
    if (job.inputMode !== "voice" || job.voiceDeliveryState === "sent") return job;
    job.voiceDeliveryKind = kind;
    job.voiceDeliveryState = "pending";
    job.voiceDeliveryPendingAt ||= Date.now();
    job.voiceDeliveryAttempts ||= 0;
    if (kind === "result" && job.channel === "whatsapp") {
        const output = jobPaths(job).outputPath;
        try { job.voiceMediaKind = fs.statSync(output).size > 5 * 1024 * 1024 ? "mms" : "img"; }
        catch { job.voiceMediaKind = "img"; }
    }
    return job;
}

function markKioskGenerationFailed(job, reason) {
    if (!job.kioskSubmission || ["accepted", "delivered"].includes(job.kioskDeliveryState)) return job;
    job.kioskDeliveryState = "failed";
    job.kioskDeliveryFailureSource = "generation";
    job.kioskDeliveryLastError = String(reason || "Portrait generation failed").slice(0, 160);
    job.kioskDeliveryFailedAt = Date.now();
    job.kioskDeliveryUpdatedAt = job.kioskDeliveryFailedAt;
    delete job.kioskDeliveryNextAttemptAt;
    delete job.digitalDeliveryPendingAt;
    return job;
}

const RECOVERABLE_GENERATION_FAILURES = new Set(["generation", "max_retries", "stale_generating"]);

function isGenerationOriginDeliveryFailure(job) {
    if (!job.kioskSubmission || job.kioskDeliveryState !== "failed"
        || !RECOVERABLE_GENERATION_FAILURES.has(job.failReason)) return false;
    // A provider attempt or callback is stronger evidence than an older
    // generation marker. Never turn a genuine delivery failure into a retry.
    if ((job.kioskDeliveryAttempts || 0) > 0 || job.kioskDeliveryProviderId
        || job.kioskProviderMessageId || job.kioskProviderStatus) return false;
    return !job.kioskDeliveryFailureSource || job.kioskDeliveryFailureSource === "generation";
}

function resetKioskDeliveryForRegeneration(job) {
    if (!job.kioskSubmission) return;
    if (job.kioskDeliveryState && job.kioskDeliveryState !== "pending"
        && !isGenerationOriginDeliveryFailure(job)) return;
    job.kioskDeliveryState = "pending";
    job.kioskDeliveryAttempts = 0;
    job.kioskDeliveryUpdatedAt = Date.now();
    for (const key of [
        "kioskDeliveryFailureSource", "kioskDeliveryLastError", "kioskDeliveryFailedAt",
        "kioskDeliveryNextAttemptAt", "kioskDeliveryAttemptStartedAt", "kioskDeliveryUncertainAt",
        "kioskDeliveryAcceptedAt", "kioskDeliveryDeliveredAt", "kioskDeliveryProviderId",
        "kioskProviderMessageId", "kioskProviderStatus", "kioskProviderEventId",
        "kioskProviderEventTimestamp", "digitalDeliveryPendingAt", "smsSentAt",
    ]) delete job[key];
}

function kioskRequiredReferencePaths(job) {
    if (Array.isArray(job.kioskReferenceRequirements)) return job.kioskReferenceRequirements;
    const snapshot = job.kioskEventSnapshot;
    if (!snapshot?.referencesPinned) return [];
    return [
        ["style", snapshot.style?.files || []],
        ["brand", snapshot.brandReferenceFiles || []],
        ["background", snapshot.backgroundChoice?.files || []],
    ].flatMap(([category, files]) => files.map((file) => path.join(category, path.basename(file))));
}

function kioskRequiresPinnedReferences(job) {
    return kioskRequiredReferencePaths(job).length > 0;
}

function hasKioskPrivateInput(job) {
    return fs.existsSync(path.join(settings.getDownloadDir(job.eventName), ".staging", `${job.filePrefix}_input.jpg`));
}

function hasKioskPinnedReferences(job) {
    const requiredPaths = kioskRequiredReferencePaths(job);
    if (requiredPaths.length === 0) return true;
    const root = kioskReferenceDir(job);
    return requiredPaths.every((relativePath) => fs.existsSync(path.join(root, relativePath)));
}

function kioskDeliveryBlocksRegeneration(job) {
    return job.kioskSubmission && job.kioskDeliveryState
        && job.kioskDeliveryState !== "pending"
        && !isGenerationOriginDeliveryFailure(job);
}

const voiceDeliveryRuns = new Map();
const voiceJobLocks = new Map();
const VOICE_DELIVERY_LEASE_MS = 2 * 60 * 1000;

function withVoiceJobLock(filename, operation) {
    const previous = voiceJobLocks.get(filename) || Promise.resolve();
    const run = previous.then(operation);
    const settled = run.catch(() => {});
    voiceJobLocks.set(filename, settled);
    void settled.then(() => {
        if (voiceJobLocks.get(filename) === settled) voiceJobLocks.delete(filename);
    });
    return run;
}

async function findVoiceDeliveryPath(filename) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(filename || "")) throw new Error("Invalid Voice job filename");
    for (const dir of [READY_DIR, PRINTING_DIR, DONE_DIR, FAILED_DIR]) {
        const candidate = path.join(dir, filename);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

async function prepareVoiceSmsShare(filename) {
    return withVoiceJobLock(filename, async () => {
        const jobPath = await findVoiceDeliveryPath(filename);
        if (!jobPath) throw new Error("Voice job moved out of delivery queues");
        const job = await readJobAsync(jobPath);
        if (Object.prototype.hasOwnProperty.call(job, "voiceShareMessage")) return job;
        job.voiceShareMessage = await buildShareMessage(job, { deterministicSlug: true });
        job.voiceSkipMedia = shouldSkipDeliveryMedia(channels.ADAPTERS.sms,
            job.voiceShareMessage, settings.getForEvent("sharePageOnly", job.eventName));
        await writeJobAsync(jobPath, job);
        return job;
    });
}

async function runVoiceDelivery(filename, { force = false } = {}) {
    const initial = await withVoiceJobLock(filename, async () => {
        const jobPath = await findVoiceDeliveryPath(filename);
        if (!jobPath) return null;
        const job = await readJobAsync(jobPath);
        if (job.inputMode !== "voice" || !job.voiceDeliveryKind
            || job.voiceDeliveryState === "sent") return { job, shouldSend: false };
        const at = Date.now();
        if (job.voiceDeliveryState === "sending"
            && at - (job.voiceDeliveryLeaseAt || 0) < VOICE_DELIVERY_LEASE_MS) {
            return { job, shouldSend: false };
        }
        if (!force && Number(job.voiceDeliveryNextAttemptAt || 0) > at) {
            return { job, shouldSend: false };
        }
        job.voiceDeliveryState = "sending";
        job.voiceDeliveryLeaseAt = at;
        job.voiceDeliveryUncertainAt = at;
        job.voiceDeliveryAttempts = (job.voiceDeliveryAttempts || 0) + 1;
        await writeJobAsync(jobPath, job);
        return { job, shouldSend: true };
    });
    if (!initial) return null;
    if (!initial.shouldSend) return initial.job;
    try {
        const sendJob = initial.job.voiceDeliveryKind === "result" && initial.job.channel === "sms"
            ? await prepareVoiceSmsShare(filename) : initial.job;
        const result = initial.job.voiceDeliveryKind === "failure"
            ? await voiceDelivery.sendVoiceFailure(sendJob, sendJob.failReason)
            : await voiceDelivery.sendVoiceDelivery(sendJob);
        const completed = await withVoiceJobLock(filename, async () => {
            const jobPath = await findVoiceDeliveryPath(filename);
            if (!jobPath) throw new Error("Voice job moved out of delivery queues");
            const job = await readJobAsync(jobPath);
            job.voiceDeliverySid = result.sid;
            job.voiceDeliveryState = "sent";
            job.voiceDeliverySentAt = Date.now();
            job.smsSentAt = job.voiceDeliverySentAt;
            delete job.voiceDeliveryPendingAt;
            delete job.digitalDeliveryPendingAt;
            delete job.voiceDeliveryLeaseAt;
            delete job.voiceDeliveryNextAttemptAt;
            delete job.voiceDeliveryLastError;
            await writeJobAsync(jobPath, job);
            return { job, jobPath };
        });
        if (completed.job.voiceDeliveryKind === "result") {
            try { await startVoiceFollowups(completed.job, completed.jobPath); }
            catch (error) { console.error(`Voice follow-up failed for ${filename}: ${error.message}`); }
        }
        return completed.job;
    } catch (error) {
        return withVoiceJobLock(filename, async () => {
            const jobPath = await findVoiceDeliveryPath(filename);
            if (!jobPath) throw error;
            const job = await readJobAsync(jobPath);
            job.voiceDeliveryState = "pending";
            job.voiceDeliveryLastError = String(error.message || error).slice(0, 160);
            job.voiceDeliveryNextAttemptAt = Date.now()
                + Math.min(60_000, 1000 * (2 ** Math.min(6, job.voiceDeliveryAttempts || 1)));
            delete job.voiceDeliveryLeaseAt;
            await writeJobAsync(jobPath, job);
            return job;
        });
    }
}

function attemptVoiceDelivery(filename, options) {
    if (voiceDeliveryRuns.has(filename)) return voiceDeliveryRuns.get(filename);
    const operation = runVoiceDelivery(filename, options).finally(() => voiceDeliveryRuns.delete(filename));
    voiceDeliveryRuns.set(filename, operation);
    return operation;
}

async function sweepVoiceDeliveries() {
    for (const dir of [READY_DIR, PRINTING_DIR, DONE_DIR, FAILED_DIR]) {
        let filenames;
        try { filenames = (await fsp.readdir(dir)).filter((name) => name.endsWith(".json")); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        for (const filename of filenames) {
            let job;
            try { job = await readJobAsync(path.join(dir, filename)); }
            catch { continue; }
            if (job.inputMode !== "voice" || !job.voiceDeliveryKind) continue;
            if (job.voiceDeliveryState !== "sent") await attemptVoiceDelivery(filename);
            else if (job.voiceDeliveryKind === "result" && !job.voiceFollowupsAt) {
                await startVoiceFollowups(job, path.join(dir, filename)).catch((error) => {
                    console.error(`Voice follow-up retry failed for ${filename}: ${error.message}`);
                });
            }
        }
    }
}

async function retryVoiceDelivery(filename) {
    return attemptVoiceDelivery(filename, { force: true });
}

// Terminal directories can contain years of non-Voice jobs. Remember files
// that had no outstanding Voice send and revisit them on a slow cadence;
// outstanding issues are always re-read so a retry is reflected promptly.
const voiceIssueFileCache = new Map();
const VOICE_QUIET_FILE_TTL = 5 * 60 * 1000;

async function getVoiceDeliveryIssues(eventName = "all") {
    const issues = [];
    const seen = new Set();
    const candidates = [];
    for (const dir of [READY_DIR, PRINTING_DIR, DONE_DIR, FAILED_DIR]) {
        let filenames;
        try { filenames = (await fsp.readdir(dir)).filter((name) => name.endsWith(".json")); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        for (const filename of filenames) {
            const key = path.join(dir, filename);
            seen.add(key);
            candidates.push({ dir, filename, key });
        }
    }
    let cursor = 0;
    const now = Date.now();
    const workers = Array.from({ length: Math.min(12, candidates.length) }, async () => {
        while (cursor < candidates.length) {
            const { dir, filename, key } = candidates[cursor++];
            const cached = voiceIssueFileCache.get(key);
            const historical = dir === DONE_DIR || dir === FAILED_DIR;
            let issue = cached?.issue || null;
            if (!historical || !cached || issue || now - cached.ts >= VOICE_QUIET_FILE_TTL) {
                try {
                    const job = await readJobAsync(key);
                    issue = job.inputMode === "voice" && job.voiceDeliveryKind
                        && job.voiceDeliveryState !== "sent"
                        ? { filename, eventName: job.eventName, kind: job.voiceDeliveryKind,
                            state: job.voiceDeliveryState, attempts: job.voiceDeliveryAttempts || 0,
                            lastError: job.voiceDeliveryLastError || null,
                            uncertainAt: job.voiceDeliveryUncertainAt || null,
                            nextAttemptAt: job.voiceDeliveryNextAttemptAt || null }
                        : null;
                    voiceIssueFileCache.set(key, { issue, ts: now });
                } catch {
                    voiceIssueFileCache.delete(key);
                    issue = null;
                }
            }
            if (issue && (eventName === "all" || issue.eventName === eventName)) issues.push(issue);
        }
    });
    await Promise.all(workers);
    for (const key of voiceIssueFileCache.keys()) {
        if (!seen.has(key)) voiceIssueFileCache.delete(key);
    }
    return issues.sort((a, b) => (b.uncertainAt || 0) - (a.uncertainAt || 0));
}

async function startVoiceFollowups(job, jobPath) {
    if (job.voiceFollowupsAt) return;
    const filename = path.basename(jobPath);
    job = await withVoiceJobLock(filename, async () => {
        const currentPath = await findVoiceDeliveryPath(filename);
        if (!currentPath) return null;
        const current = await readJobAsync(currentPath);
        if (current.voiceFollowupsAt) return null;
        current.voiceFollowupsAt = Date.now();
        await writeJobAsync(currentPath, current);
        return current;
    });
    if (!job) return;
    const rules = job.voiceEventSettings || {};
    const adapter = channels.ADAPTERS[job.channel];
    const withinSession = !adapter?.sessionAware
        || (Date.now() - Number(contacts.getLastInboundAt(job.userPhone, job.channel) || 0) < 24 * 60 * 60 * 1000);
    if (rules.leadCaptureMode === "after" && withinSession
        && !leads.isCompleted(job.userPhone, job.eventName) && !leads.isActive(job.userPhone)) {
        await leads.startSurvey(job.userPhone, job.appPhone, job.eventName, "after", null,
            job.locale, job.channel).catch((error) => console.error(`Voice survey start failed: ${error.message}`));
    }
    const maxPrints = Number(rules.maxPrints);
    const quotaReached = Number.isFinite(maxPrints) && maxPrints > 0
        && getUsageCount(job.userPhone, job.eventName) >= maxPrints;
    if (rules.enableNps && quotaReached && !leads.isActive(job.userPhone)
        && !nps.hasCompleted(job.userPhone, job.eventName)) {
        const hasApprovedRating = job.channel === "whatsapp" && !!settings.getContentSid("rating", job.locale);
        if (withinSession || hasApprovedRating) {
            const result = await messaging.send(job.userPhone,
                hasApprovedRating ? "rating" : "_raw", {}, jobSendOptions(job, {
                    locale: job.locale, fromPhone: job.appPhone,
                    ...(hasApprovedRating ? { allowOutOfSession: true }
                        : { _body: i18n.t(job.locale, "npsPrompt", {}, job.eventName) }),
                }));
            if (result?.sid) nps.markPending(job.userPhone, { locale: job.locale, eventName: job.eventName });
        }
    }
}

// ── Rename with retry (for Azure Files SMB quirks) ───────────────────────────
// Azure Files SMB shares can return transient EACCES/EBUSY/EPERM when one
// process holds a file open (e.g., the dashboard scanning job JSONs) while
// another tries to rename it (worker transitioning queues). The lock
// usually clears within 50-200ms. Linux EXT4 doesn't behave this way; this
// helper is a no-op cost on non-SMB filesystems because the first attempt
// always succeeds.
//
// ENOENT is NOT retried — that's the normal "file already moved to its
// next queue dir" race and retrying wouldn't help.
async function renameWithRetry(src, dst, maxAttempts = 4) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fsp.rename(src, dst);
        } catch (err) {
            lastErr = err;
            if (err.code === "ENOENT") throw err;
            if (!["EACCES", "EBUSY", "EPERM"].includes(err.code)) throw err;
            if (attempt === maxAttempts) break;
            // Backoff: 50ms, 150ms, 350ms. Jitter via process.pid avoids
            // two workers retrying in lockstep.
            const base = [50, 150, 350][attempt - 1] || 500;
            const jitter = (process.pid % 37);
            await new Promise((r) => setTimeout(r, base + jitter));
            console.warn(`⚠️  Rename retry ${attempt + 1}/${maxAttempts} for ${path.basename(src)} after ${err.code}`);
        }
    }
    throw lastErr;
}

// ── Share Links ─────────────────────────────────────────────────────────────

const dub = require("./dub");

async function buildShareMessage(job, { deterministicSlug = false } = {}) {
    const ev = job.eventName || settings.get("eventName");
    if (!settings.getForEvent("enableShareLinks", ev)) return "";
    if (!job.baseUrl || !job.filePrefix) {
        // One-shot observation when a share link is silently dropped —
        // most often because baseUrl was blank when the job was queued
        // (server restart with no BASE_URL env var, before first inbound).
        console.warn(`⚠️  Share link skipped for ${job.filePrefix || "?"}: baseUrl="${job.baseUrl || ""}" (shareLinks are on)`);
        return "";
    }

    const sharePageUrl = `${job.baseUrl}/s/${job.filePrefix}?e=${encodeURIComponent(ev)}`;
    const prefix = settings.getForEvent("dubSlugPrefix", ev) || "p";
    // A Voice send can retry after a restart. Its slug must survive a crash
    // between calling Dub and saving the job without advancing the event counter.
    const slug = deterministicSlug
        ? `${prefix}-${createHash("sha256").update(JSON.stringify([ev, job.filePrefix])).digest("hex").slice(0, 16)}`
        : `${prefix}-${settings.incrementEventCounter("dubSlugCounter", ev)}`;
    const shortLink = await dub.shortenUrl(sharePageUrl, slug);
    const url = shortLink ? shortLink.replace(/^https?:\/\//, "") : sharePageUrl;

    // Store short link on job for use by share page
    if (shortLink) job.shareUrl = shortLink;

    const template = job.locale === "pt_BR"
        ? "Compartilhe seu retrato: {url}"
        : (settings.getForEvent("shareMessageText", ev) || "Share your portrait: {url}");
    const message = template.includes("{url}")
        ? template.replace(/\{url\}/g, url)
        : `${template.trimEnd()} ${url}`;
    return `\n\n${message}`;
}

// ── Usage Tracking (in-memory cache) ─────────────────────────────────────────

const usageCache = new Map();
let _buildingCache = null;

function usageKey(phone, event) {
    return `${phone}:${event}`;
}

async function buildUsageCache() {
    if (_buildingCache) return _buildingCache;
    _buildingCache = _buildUsageCacheImpl();
    try { return await _buildingCache; } finally { _buildingCache = null; }
}

// Kiosk admission waits for an in-flight rebuild before its final synchronous
// quota check and enqueue. Return the current promise rather than starting a
// new scan for every submission.
function getInFlightUsageRebuild() {
    return _buildingCache;
}

async function _buildUsageCacheImpl() {
    // Build into a new Map and swap atomically so getAllUsers() never
    // sees a partially-built or empty cache during the rebuild window.
    const newCache = new Map();
    // Cache per-event admin lists so we only load each event's settings once
    const eventAdminCache = new Map();
    const countedVoiceGroups = new Set();
    const countedKioskSubmissions = new Set();
    function isEventAdmin(phone, eventName) {
        if (!eventAdminCache.has(eventName)) {
            eventAdminCache.set(eventName, new Set(settings.getForEvent("adminPhones", eventName) || []));
        }
        return eventAdminCache.get(eventName).has(phone);
    }
    function countKioskSubmission(job) {
        // Both the initial group and later re-analysis groups spend the same
        // one quota slot. Use the same stable key for queue jobs and manifests.
        const submissionId = job.requestId || job.kioskUsageId
            || job.reanalyzedFrom || job.parentJobId || job.filePrefix;
        const submissionKey = `${job.userPhone}\0${job.eventName}\0${submissionId}`;
        if (countedKioskSubmissions.has(submissionKey)) return false;
        countedKioskSubmissions.add(submissionKey);
        return true;
    }
    for (const dir of [DONE_DIR, PENDING_DIR, GENERATING_DIR, REVIEW_DIR, READY_DIR, PRINTING_DIR, PROCESSING_DIR, FAILED_DIR]) {
        try {
            const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
            for (const file of files) {
                try {
                    const data = await fsp.readFile(path.join(dir, file), "utf-8");
                    const job = JSON.parse(data);
                    if (!job.userPhone || !job.eventName) continue;
                    if (job.kioskSubmission && ["REJECTED", "SUPERSEDED"].includes(job.variantStatus)) continue;
                    if (!job.completedAt && job.failureEffectsPending && job.usageReleasePending) continue;
                    if (dir === FAILED_DIR && !job.completedAt && !job.countUsageOnRebuild) continue;
                    if (job.adminGenerated || isEventAdmin(job.userPhone, job.eventName)) continue;
                    if (job.voiceGroupId) {
                        if (countedVoiceGroups.has(job.voiceGroupId)) continue;
                        const group = await getVoiceGroup(job.voiceGroupId);
                        if (!group || group.status !== "committed") continue;
                        countedVoiceGroups.add(job.voiceGroupId);
                    }
                    if (job.kioskSubmission) {
                        if (!countKioskSubmission(job)) continue;
                    }
                    const key = usageKey(job.userPhone, job.eventName);
                    newCache.set(key, (newCache.get(key) || 0) + 1);
                } catch {
                    // Skip malformed files
                }
            }
        } catch {
            // Directory doesn't exist, skip
        }
    }
    // An initial group can be durably accepted before v1 is published. A
    // re-analysis can likewise retire its old siblings before the first new
    // job exists. Count their committed manifests so a cache rebuild cannot
    // free the same guest's quota slot during either recovery window.
    try {
        const files = (await fsp.readdir(KIOSK_GROUP_PUBLICATION_DIR)).filter((name) => name.endsWith(".json"));
        for (const file of files) {
            try {
                const manifest = JSON.parse(await fsp.readFile(path.join(KIOSK_GROUP_PUBLICATION_DIR, file), "utf8"));
                if (manifest.kind !== "initial" && manifest.kind !== "reanalyze") continue;
                const job = manifest.jobs?.[0];
                if (!job?.kioskSubmission || !job.userPhone || !job.eventName) continue;
                if (manifest.kind === "initial") {
                    if (readKioskParentDecision(manifest.groupId)?.action === "reject") continue;
                } else {
                    const decision = readKioskParentDecision(manifest.oldParentId);
                    if (decision?.action !== "reanalyze" || decision.newParentId !== manifest.groupId) continue;
                }
                if (job.adminGenerated || isEventAdmin(job.userPhone, job.eventName)) continue;
                if (!countKioskSubmission(job)) continue;
                const key = usageKey(job.userPhone, job.eventName);
                newCache.set(key, (newCache.get(key) || 0) + 1);
            } catch (error) {
                if (error.code === "ENOENT" || error instanceof SyntaxError) continue;
                // Keep the previous cache if Azure Files is temporarily
                // unreadable; silently skipping a committed group frees quota.
                throw error;
            }
        }
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    // Apply persistent usage overrides (from manual resets)
    const overrides = settings.get("usageOverrides") || {};
    for (const [key, offset] of Object.entries(overrides)) {
        const current = newCache.get(key) || 0;
        newCache.set(key, Math.max(0, current + offset));
    }
    // Atomic swap
    usageCache.clear();
    for (const [k, v] of newCache) usageCache.set(k, v);
    console.log(`📊 Usage cache built: ${usageCache.size} entries`);
}

function incrementUsage(phone, event) {
    if (isAdmin(phone)) return;
    const key = usageKey(phone, event);
    usageCache.set(key, (usageCache.get(key) || 0) + 1);
}

function decrementUsage(phone, event) {
    if (isAdmin(phone)) return;
    const key = usageKey(phone, event);
    const current = usageCache.get(key) || 0;
    if (current > 0) usageCache.set(key, current - 1);
}

// Move completed photos between events (done/failed jobs only)
async function moveJobsToEvent(prefixes, fromEvent, toEvent) {
    const results = [];
    const fromDir = settings.getDownloadDir(fromEvent);
    const toDir = settings.getDownloadDir(toEvent);
    await fsp.mkdir(toDir, { recursive: true });

    for (const prefix of prefixes) {
        try {
            // Validate prefix (must be a safe filename — no path traversal)
            if (!prefix || prefix.includes("..") || prefix.includes("/") || prefix.includes("\\")) {
                results.push({ prefix, success: false, error: "Invalid prefix" });
                continue;
            }

            // Find job JSON in done/ or failed/
            const filename = `${prefix}.json`;
            let jobPath;
            for (const dir of [DONE_DIR, FAILED_DIR]) {
                const p = path.join(dir, filename);
                if (fs.existsSync(p)) { jobPath = p; break; }
            }
            if (!jobPath) {
                results.push({ prefix, success: false, error: "Job not found in done/failed" });
                continue;
            }

            const job = JSON.parse(await fsp.readFile(jobPath, "utf-8"));
            if (job.eventName !== fromEvent) {
                results.push({ prefix, success: false, error: "Event mismatch" });
                continue;
            }

            // Move image files, tracking for rollback
            const suffixes = ["_input.jpg", "_output.png", "_output_mms.jpg"];
            const moved = [];
            try {
                for (const s of suffixes) {
                    const src = path.join(fromDir, prefix + s);
                    const dst = path.join(toDir, prefix + s);
                    if (fs.existsSync(dst)) throw new Error("File already exists in target event");
                    if (fs.existsSync(src)) {
                        await renameWithRetry(src, dst);
                        moved.push([dst, src]);
                    }
                }
            } catch (moveErr) {
                // Rollback moved files
                for (const [dst, src] of moved) {
                    try { await fsp.rename(dst, src); } catch {}
                }
                throw moveErr;
            }

            // Update job JSON
            job.eventName = toEvent;
            job.movedFrom = fromEvent;
            job.movedAt = Date.now();
            await writeJobAsync(jobPath, job);

            results.push({ prefix, success: true });
            console.log(`📦 Moved ${prefix} from "${fromEvent}" to "${toEvent}"`);
        } catch (err) {
            results.push({ prefix, success: false, error: err.message });
            console.error(`❌ Failed to move ${prefix}: ${err.message}`);
        }
    }

    // Rebuild usage cache after all moves
    await buildUsageCache();
    return results;
}

function isAdmin(phone) {
    return settings.get("adminPhones").includes(phone);
}

// Testing mode: admins experience the full regular-user flow with unlimited quota
function isTestingMode(eventName) {
    return (eventName || "").toLowerCase() === "testing";
}

function getUsageCount(phone, eventName) {
    return usageCache.get(usageKey(phone, eventName || settings.get("eventName"))) || 0;
}

function getAllUsers(eventFilter) {
    const userMap = new Map();
    for (const [key, count] of usageCache) {
        const lastColon = key.lastIndexOf(":");
        const phone = key.substring(0, lastColon);
        const event = key.substring(lastColon + 1);
        if (eventFilter && eventFilter !== "all" && event !== eventFilter) continue;
        if (!userMap.has(phone)) userMap.set(phone, 0);
        userMap.set(phone, userMap.get(phone) + count);
    }
    // Include admin phones that may have 0 usage (not in cache)
    // Use the viewed event's admin list, not just the active event's
    const adminPhones = eventFilter && eventFilter !== "all"
        ? settings.getForEvent("adminPhones", eventFilter)
        : settings.get("adminPhones");
    for (const phone of (adminPhones || [])) {
        if (!userMap.has(phone)) userMap.set(phone, 0);
    }
    return userMap;
}

function resetUsage(phone, event) {
    const key = usageKey(phone, event);
    const current = usageCache.get(key) || 0;
    if (current === 0) return;
    const overrides = { ...(settings.get("usageOverrides") || {}) };
    overrides[key] = (overrides[key] || 0) - current;
    settings.update({ usageOverrides: overrides });
    usageCache.set(key, 0);
}

async function toggleAdmin(phone, eventName) {
    const activeEvent = settings.get("eventName");
    const targetEvent = eventName || activeEvent;

    if (targetEvent === activeEvent) {
        // Active event — modify in-memory settings directly
        const admins = [...settings.get("adminPhones")];
        const idx = admins.indexOf(phone);
        if (idx >= 0) admins.splice(idx, 1);
        else admins.push(phone);
        settings.update({ adminPhones: admins });
    } else {
        // Non-active event — load, modify, and save its settings file
        const eventSettings = settings.loadEventSettings(targetEvent);
        const admins = [...(eventSettings.adminPhones || [])];
        const idx = admins.indexOf(phone);
        if (idx >= 0) admins.splice(idx, 1);
        else admins.push(phone);
        eventSettings.adminPhones = admins;
        const dir = path.join(settings.EVENTS_DIR, targetEvent);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const settingsPath = path.join(dir, "settings.json");
        const tmp = settingsPath + `.tmp.${process.pid}.${_writeCounter++}`;
        fs.writeFileSync(tmp, JSON.stringify(eventSettings, null, 2));
        fs.renameSync(tmp, settingsPath);
    }
    // Kick off cache rebuild in the background — don't block the response.
    // Admin status is already persisted in settings; the cache rebuild just
    // updates usage counts (which aren't needed for the immediate UI update).
    (async () => {
        try {
            if (_buildingCache) await _buildingCache.catch(() => {});
            await buildUsageCache();
        } catch (err) {
            console.error("Background cache rebuild error:", err);
        }
    })();
    const updatedAdmins = targetEvent === activeEvent
        ? settings.get("adminPhones")
        : (settings.loadEventSettings(targetEvent).adminPhones || []);
    return updatedAdmins.includes(phone);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasOutputFile(job) {
    const { outputPath } = jobPaths(job);
    return fs.existsSync(outputPath);
}

function recoveredOutputDir(job) {
    return (job.inputMode === "voice" || job.kioskSubmission)
        && !jobEventSetting(job, "enablePrinting") ? DONE_DIR : READY_DIR;
}

async function completePublishedOutput(job) {
    // The final PNG is the publish marker. A previous process may have moved
    // it before cleaning up the private kiosk selfie/references or publishing
    // the MMS derivative. Build any missing derivative before publishing a
    // staged PNG, preserving the normal media commit order.
    const staged = jobPaths(job, { staged: true });
    const final = jobPaths(job);
    if (!fs.existsSync(final.mmsPath) && !fs.existsSync(staged.mmsPath)) {
        const sourceOutput = fs.existsSync(staged.outputPath) ? staged.outputPath : final.outputPath;
        if (!fs.existsSync(sourceOutput)) throw new Error(`Portrait output is missing for ${job.filePrefix}`);
        const targetMms = sourceOutput === staged.outputPath ? staged.mmsPath : final.mmsPath;
        const temporaryMms = `${targetMms}.recovering.${process.pid}.${randomUUID()}`;
        try {
            await sharp(sourceOutput)
                .resize(800, null, { withoutEnlargement: true })
                .jpeg({ quality: 80 })
                .toFile(temporaryMms);
            await renameWithRetry(temporaryMms, targetMms);
        } finally {
            await fsp.unlink(temporaryMms).catch(() => {});
        }
    }
    await moveStagedToFinal(job);
    if (!fs.existsSync(final.outputPath)) throw new Error(`Published output is missing for ${job.filePrefix}`);
    if (!fs.existsSync(final.mmsPath)) throw new Error(`Published MMS is missing for ${job.filePrefix}`);
}

function readJob(filepath) {
    return JSON.parse(fs.readFileSync(filepath, "utf-8"));
}

let _writeCounter = 0;
function writeJob(filepath, job) {
    atomicWriteFileSync(filepath, JSON.stringify(job), { tempDir: QUEUE_TMP_DIR });
}

async function readJobAsync(filepath) {
    return JSON.parse(await fsp.readFile(filepath, "utf-8"));
}

async function readClaimedJobWithRetry(filepath, attempts = 8) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await readJobAsync(filepath);
        } catch (err) {
            lastError = err;
            if (!["ENOENT", "EACCES", "EBUSY", "EPERM"].includes(err.code) || attempt === attempts) throw err;
            await new Promise((resolve) => setTimeout(resolve, attempt * 75));
        }
    }
    throw lastError;
}

async function writeJobAsync(filepath, job) {
    await atomicWriteFile(filepath, JSON.stringify(job), { tempDir: QUEUE_TMP_DIR });
}

async function cleanupQueueTempFiles() {
    const deleted = await cleanupTempDirectory(QUEUE_TMP_DIR);
    if (deleted > 0) console.log(`🧹 Removed ${deleted} stale queue temp file(s)`);
}

// ── Enqueue ──────────────────────────────────────────────────────────────────

// Deduplication: track recent messageSids to prevent Twilio webhook retries
// from creating duplicate jobs (Twilio retries if response takes >15s)
const recentSids = new Map();
const SID_TTL = 600_000; // 10 minutes — Twilio can retry webhooks for several minutes

function isDuplicate(messageSid) {
    if (!messageSid) return false;
    // Clean old entries
    const now = Date.now();
    for (const [sid, ts] of recentSids) {
        if (now - ts > SID_TTL) recentSids.delete(sid);
    }
    if (recentSids.has(messageSid)) return true;
    recentSids.set(messageSid, now);
    return false;
}

const KIOSK_SNAPSHOT_SETTING_KEYS = [
    "reviewMode", "enableManualReview", "variantsPerReview", "enablePrinting",
    "immediateDigitalDelivery", "aiReviewChecks", "promptPreserve",
    "promptPreserveBrand", "promptBrandInstruction", "promptComposition",
    "promptBackground", "multiSubjectMode", "defaultStyle",
];

function plainSnapshot(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function kioskOptionsChanged(message) {
    return Object.assign(new Error(message), { status: 409, code: "EVENT_OPTIONS_CHANGED" });
}

function captureKioskEventSnapshot(eventName, style, brand, background, locale) {
    const styleObj = settings.getActiveStyles(eventName)[style];
    if (!styleObj) throw kioskOptionsChanged(`Kiosk style ${style} is no longer enabled`);

    const eventSettings = {};
    for (const key of KIOSK_SNAPSHOT_SETTING_KEYS) {
        eventSettings[key] = plainSnapshot(settings.getForEvent(key, eventName));
    }
    // Guests are promised a digital portrait even when the event also prints.
    eventSettings.immediateDigitalDelivery = true;

    const brands = settings.getForEvent("customBrands", eventName) || {};
    const selectedBrand = brand && brand !== "__none__" ? brands[brand] || null : null;
    if (brand && brand !== "__none__" && !selectedBrand) {
        throw kioskOptionsChanged(`Kiosk brand ${brand} is no longer enabled`);
    }
    const brandOverrides = settings.getForEvent("brandPromptOverrides", eventName) || {};
    let brandPrompt = "";
    let brandReferenceFiles = [];
    if (brand === "__none__") {
        // The guest explicitly chose an unbranded portrait.
    } else if (selectedBrand) {
        brandPrompt = brandOverrides[brand] || selectedBrand.wardrobe || selectedBrand.brandPrompt
            || settings.getForEvent("brandPrompt", eventName) || "";
        brandReferenceFiles = selectedBrand.files || [];
    } else {
        brandPrompt = settings.getForEvent("brandPrompt", eventName) || "";
        brandReferenceFiles = settings.getForEvent("brandReferenceFiles", eventName) || [];
    }

    const configuredBackgrounds = settings.getForEvent("backgroundChoices", eventName) || [];
    const choices = selectBackgroundChoices(styleObj, selectedBrand, configuredBackgrounds);
    const backgroundChoice = background ? choices.find((choice) => choice.key === background) || null : null;
    if (background && !backgroundChoice) {
        throw kioskOptionsChanged(`Kiosk background ${background} is no longer available`);
    }

    return {
        style: plainSnapshot(styleObj),
        brand: plainSnapshot(selectedBrand),
        brandPrompt,
        brandReferenceFiles: plainSnapshot(brandReferenceFiles),
        backgroundChoice: plainSnapshot(backgroundChoice),
        eventSettings,
        deliveryContentSid: settings.getContentSid("delivery", locale || "en") || null,
    };
}

function kioskReferenceDir(job) {
    return path.join(settings.getDownloadDir(job.eventName), ".staging", `${job.filePrefix}_refs`);
}

function copyKioskReferences(job) {
    const snapshot = job.kioskEventSnapshot;
    if (!snapshot) return null;
    const groups = [
        ["style", snapshot.style?.files || [], settings.STYLE_REFS_DIR],
        ["brand", snapshot.brandReferenceFiles || [], settings.BRAND_REFS_DIR],
        ["background", snapshot.backgroundChoice?.files || [], settings.BG_REFS_DIR],
    ];
    const root = kioskReferenceDir(job);
    let copied = false;
    for (const [category, files, sourceDir] of groups) {
        if (!files.length) continue;
        const categoryDir = path.join(root, category);
        fs.mkdirSync(categoryDir, { recursive: true });
        for (const filename of files) {
            const basename = path.basename(filename);
            const source = path.join(sourceDir, basename);
            if (!fs.existsSync(source)) throw new Error(`Kiosk ${category} reference is unavailable: ${basename}`);
            fs.copyFileSync(source, path.join(categoryDir, basename));
            copied = true;
        }
    }
    snapshot.referencesPinned = true;
    return copied ? root : null;
}

function kioskGroupPublicationPath(groupId) {
    const key = createHash("sha256").update(groupId).digest("hex");
    return path.join(KIOSK_GROUP_PUBLICATION_DIR, `${key}.json`);
}

function hasKioskGroupPublication(groupId) {
    return fs.existsSync(kioskGroupPublicationPath(groupId));
}

async function completeKioskGroupPublication(manifest) {
    const manifestPath = kioskGroupPublicationPath(manifest.groupId);
    if (kioskGroupPublicationLocks.has(manifestPath)) return kioskGroupPublicationLocks.get(manifestPath);
    const operation = (async () => {
        let published = 0;
        try {
            await fsp.mkdir(PENDING_DIR, { recursive: true });
            for (const job of manifest.jobs) {
                const filename = `${job.filePrefix}.json`;
                if (kioskJobPath(filename)) continue;
                if (manifest.requiresPrivateSource && !hasKioskPrivateInput(job)) {
                    throw new Error(`Kiosk source is missing for ${job.filePrefix}`);
                }
                if (!hasKioskPinnedReferences(job)) {
                    throw new Error(`Pinned kiosk references are missing for ${job.filePrefix}`);
                }
                writeJob(path.join(PENDING_DIR, filename), job);
                published++;
            }
            const complete = manifest.jobs.every((job) => kioskJobPath(`${job.filePrefix}.json`));
            if (complete) {
                await fsp.unlink(manifestPath).catch((error) => {
                    if (error.code !== "ENOENT") throw error;
                });
            }
            return {
                filePrefix: manifest.jobs[0].filePrefix,
                complete,
                digest: manifest.digest || manifest.jobs[0].kioskRequestDigest || null,
            };
        } finally {
            // Startup builds the cache before queue recovery. A manifest may
            // have been persisted before its first sibling was published.
            if (published > 0) await buildUsageCache();
        }
    })().finally(() => kioskGroupPublicationLocks.delete(manifestPath));
    kioskGroupPublicationLocks.set(manifestPath, operation);
    return operation;
}

async function ensureKioskGroupPublished(requestId, eventName) {
    let files;
    try { files = (await fsp.readdir(KIOSK_GROUP_PUBLICATION_DIR)).filter((name) => name.endsWith(".json")); }
    catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
    for (const filename of files) {
        let manifest;
        try { manifest = JSON.parse(await fsp.readFile(path.join(KIOSK_GROUP_PUBLICATION_DIR, filename), "utf8")); }
        catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
        }
        if (manifest.kind !== "initial" || manifest.requestId !== requestId || manifest.eventName !== eventName) continue;
        try { return await completeKioskGroupPublication(manifest); }
        catch (error) {
            console.error(`⚠️  Kiosk group publication is pending for ${manifest.groupId}: ${error.message}`);
            return {
                filePrefix: manifest.jobs[0].filePrefix,
                complete: false,
                digest: manifest.digest || manifest.jobs[0].kioskRequestDigest || null,
            };
        }
    }
    return null;
}

async function sweepKioskGroupPublications() {
    let files;
    try { files = (await fsp.readdir(KIOSK_GROUP_PUBLICATION_DIR)).filter((name) => name.endsWith(".json")); }
    catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
    }
    for (const filename of files) {
        try {
            const manifest = JSON.parse(await fsp.readFile(path.join(KIOSK_GROUP_PUBLICATION_DIR, filename), "utf8"));
            if (manifest.kind === "initial") {
                await completeKioskGroupPublication(manifest);
            } else if (manifest.kind === "reanalyze") {
                const decision = readKioskParentDecision(manifest.oldParentId);
                if (decision?.action === "reanalyze") {
                    await completeKioskReanalysis(decision);
                } else if (manifest.jobs.every((job) => kioskJobPath(`${job.filePrefix}.json`))) {
                    // The parent manifest was removed after all replacements
                    // were published, but this visibility marker survived.
                    await fsp.unlink(kioskGroupPublicationPath(manifest.groupId));
                }
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                console.error(`⚠️  Kiosk group publication recovery failed for ${filename}: ${error.message}`);
            }
        }
    }
}

function enqueueJob(imageUrl, messageSid, userPhone, appPhone, style, baseUrl, background, brand, extras) {
    if (isDuplicate(messageSid)) {
        console.log(`⚠️  Duplicate webhook detected (${messageSid}), skipping enqueue`);
        return;
    }
    const createdAt = Date.now();
    const ts = formatTimestamp(createdAt);
    // Timestamp-only names can overwrite a second guest's job within the same
    // second. Preserve chronological sorting while giving kiosk work a unique
    // prefix that also survives multi-variant fan-out.
    const basePrefix = extras?.kioskSubmission ? `${ts}_${randomUUID().replace(/-/g, "")}` : ts;
    const eventName = extras && extras.eventName || settings.get("eventName");
    let kioskEventSnapshot = null;
    try {
        if (extras?.kioskSubmission) {
            kioskEventSnapshot = captureKioskEventSnapshot(eventName, style, brand, background, extras.locale);
            if (extras.channel === "whatsapp" && !kioskEventSnapshot.deliveryContentSid) {
                throw kioskOptionsChanged("WhatsApp delivery template is no longer available");
            }
        }
    } catch (error) {
        recentSids.delete(messageSid);
        throw error;
    }

    // Multi-variant review: spawn N siblings sharing a parentJobId.
    // Active when variantsPerReview > 1 AND review is on (either human or AI).
    // When review is off, there's no reviewer to pick a variant and no AI to
    // auto-select, so fan-out is pointless — stay single-variant.
    const reviewMode = settings.getForEvent("reviewMode", eventName) ||
        (settings.getForEvent("enableManualReview", eventName) ? "human" : "off");
    const variantsRequested = (reviewMode === "human" || reviewMode === "ai")
        ? Math.max(1, Math.min(3, Number(settings.getForEvent("variantsPerReview", eventName)) || 1))
        : 1;
    const isMultiVariant = variantsRequested > 1;
    console.log(`📥 enqueueJob: event=${eventName} reviewMode=${reviewMode} variantsPerReview=${settings.getForEvent("variantsPerReview", eventName)} → ${variantsRequested} variant(s)`);

    const { sourceImagePath, ...safeExtras } = extras || {};

    const baseJob = {
        imageUrl,
        messageSid,
        userPhone,
        appPhone,
        style,
        baseUrl: baseUrl || "",
        background: background || null,
        brand: brand || null,
        eventName,
        retries: 0,
        createdAt,
        pendingAt: createdAt,
        stateChangedAt: createdAt,
        ...safeExtras,
        ...(isMultiVariant ? { reviewModeAtEnqueue: reviewMode } : {}),
        outputProfile: settings.getOutputProfile(eventName),
    };
    if (kioskEventSnapshot) {
        baseJob.kioskEventSnapshot = kioskEventSnapshot;
        baseJob.kioskUsageId = extras?.requestId || basePrefix;
        baseJob.kioskDeliveryState = "pending";
        baseJob.kioskDeliveryAttempts = 0;
    }
    if (isAdmin(userPhone)) baseJob.adminGenerated = true;

    const jobs = Array.from({ length: variantsRequested }, (_, index) => {
        const prefix = isMultiVariant ? `${basePrefix}-v${index + 1}` : basePrefix;
        return isMultiVariant ? {
            ...baseJob, filePrefix: prefix, parentJobId: basePrefix, variantId: prefix,
            variantIndex: index + 1, variantCount: variantsRequested,
        } : { ...baseJob, filePrefix: prefix };
    });
    const copied = [];
    const copiedReferenceDirs = [];
    const published = [];
    let durableGroupPath = null;
    let usageCharged = false;
    try {
        fs.mkdirSync(PENDING_DIR, { recursive: true });
        // A MENU fallback uses the private preflight copy. Every variant gets
        // its own staged input before any queue file becomes visible to workers.
        if (sourceImagePath) {
            if (!path.isAbsolute(sourceImagePath) || !fs.statSync(sourceImagePath).isFile()) {
                throw new Error("MENU selfie source is unavailable");
            }
            for (const job of jobs) {
                const destination = jobPaths(job, { staged: true }).inputPath;
                if (fs.existsSync(destination) || fs.existsSync(path.join(PENDING_DIR, `${job.filePrefix}.json`))) {
                    throw new Error("MENU job already exists");
                }
                const temp = `${destination}.copying.${process.pid}`;
                try {
                    fs.copyFileSync(sourceImagePath, temp);
                    renameWithRetrySync(temp, destination);
                } finally { try { fs.unlinkSync(temp); } catch {} }
                copied.push(destination);
            }
        }
        if (kioskEventSnapshot) {
            for (const job of jobs) {
                copiedReferenceDirs.push(kioskReferenceDir(job));
                copyKioskReferences(job);
            }
        }
        if (kioskEventSnapshot && isMultiVariant) {
            // All private inputs and pinned references exist before the first
            // sibling becomes visible to a worker. Recovery can publish any
            // missing sibling from this complete, durable job description.
            fs.mkdirSync(KIOSK_GROUP_PUBLICATION_DIR, { recursive: true });
            const manifestPath = kioskGroupPublicationPath(basePrefix);
            atomicWriteFileSync(manifestPath, JSON.stringify({
                kind: "initial", groupId: basePrefix, requestId: extras?.requestId || null,
                eventName, digest: extras?.kioskRequestDigest || null,
                requiresPrivateSource: !!sourceImagePath, jobs, createdAt,
            }), { tempDir: QUEUE_TMP_DIR });
            durableGroupPath = manifestPath;
            incrementUsage(userPhone, eventName);
            usageCharged = true;
        }
        for (const job of jobs) {
            const jobPath = path.join(PENDING_DIR, `${job.filePrefix}.json`);
            writeJob(jobPath, job);
            published.push(jobPath);
        }
        if (durableGroupPath) fs.unlinkSync(durableGroupPath);
    } catch (error) {
        if (!durableGroupPath) {
            for (const filepath of published) { try { fs.unlinkSync(filepath); } catch {} }
            for (const filepath of copied) { try { fs.unlinkSync(filepath); } catch {} }
            for (const dir of copiedReferenceDirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
        }
        recentSids.delete(messageSid);
        throw error;
    }
    if (!usageCharged) incrementUsage(userPhone, eventName); // count ONCE for the parent
    if (isMultiVariant) console.log(`📥 Multi-variant job queued: ${basePrefix} (${variantsRequested} variants)`);
    else console.log(`📥 Job queued: ${basePrefix}.json`);
    return { filePrefix: jobs[0].filePrefix, parentJobId: isMultiVariant ? basePrefix : null };
}

function voiceGroupPath(groupId) {
    if (!/^\d{8}_\d{6}_voice_[a-f0-9]{16}$/.test(groupId || "")) throw new Error("Invalid Voice group ID");
    return path.join(VOICE_GROUP_DIR, `${groupId}.json`);
}

async function readVoiceGroup(groupId) {
    try { return JSON.parse(await fsp.readFile(voiceGroupPath(groupId), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function findVoiceJob(prefix) {
    for (const dir of [PENDING_DIR, GENERATING_DIR, REVIEW_DIR, READY_DIR, PRINTING_DIR, DONE_DIR, FAILED_DIR]) {
        try { return JSON.parse(await fsp.readFile(path.join(dir, `${prefix}.json`), "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return null;
}

async function getVoiceGroup(groupId) {
    const manifest = await readVoiceGroup(groupId);
    if (!manifest) return null;
    const jobs = [];
    for (const prefix of manifest.filePrefixes) {
        const job = await findVoiceJob(prefix);
        if (job) jobs.push(job);
    }
    return { ...manifest, jobs };
}

async function _enqueueVoiceGroup({ request, brief, locale, groupId }) {
    const manifestPath = voiceGroupPath(groupId);
    const rules = request.eventSettings || {};
    const reviewMode = rules.reviewMode || "off";
    const count = ["human", "ai"].includes(reviewMode)
        ? Math.max(1, Math.min(3, Number(rules.variantsPerReview) || 1)) : 1;
    const filePrefixes = Array.from({ length: count }, (_, index) =>
        count === 1 ? groupId : `${groupId}-v${index + 1}`);
    let manifest = await readVoiceGroup(groupId);
    if (manifest && (manifest.requestId !== request.id
        || JSON.stringify(manifest.filePrefixes) !== JSON.stringify(filePrefixes))) {
        throw new Error("Voice group ID collision");
    }
    if (!manifest) {
        manifest = {
            groupId, requestId: request.id, eventName: request.eventName,
            status: "preparing", filePrefixes, createdAt: request.receivedAt,
        };
        await atomicWriteFile(manifestPath, JSON.stringify(manifest));
    }
    if (manifest.status === "committed") return getVoiceGroup(groupId);

    await fsp.mkdir(PENDING_DIR, { recursive: true });
    for (let index = 0; index < count; index++) {
        const prefix = filePrefixes[index];
        const existingJob = await findVoiceJob(prefix);
        const job = existingJob || {
            imageUrl: request.imageUrl, messageSid: request.messageSid,
            userPhone: request.phone, appPhone: request.appPhone, channel: request.channel,
            eventName: request.eventName, baseUrl: request.baseUrl || "",
            filePrefix: prefix, createdAt: request.receivedAt, pendingAt: Date.now(),
            stateChangedAt: Date.now(), retries: 0, style: null, brand: null, background: null,
            locale, inputMode: "voice", voiceGroupId: groupId, voiceBrief: brief,
            voiceScene: request.scene, voiceEventSettings: rules,
            cachedScene: `Subjects: ${request.scene.subjects}\nPets: ${request.scene.pets || "none"}\nPositions: ${request.scene.positions || "centered"}`,
            outputProfile: rules.outputProfile,
            ...(count > 1 ? {
                parentJobId: groupId, variantId: prefix, variantIndex: index + 1, variantCount: count,
            } : {}),
        };
        if (isAdmin(request.phone)) job.adminGenerated = true;
        const destination = jobPaths(job, { staged: true }).inputPath;
        if (!fs.existsSync(destination)) {
            if (!request.stagedInputPath) throw new Error("Voice staged selfie is missing");
            const tempPath = `${destination}.copying.${process.pid}`;
            try {
                await fsp.copyFile(request.stagedInputPath, tempPath);
                await fsp.rename(tempPath, destination);
            } finally {
                await fsp.unlink(tempPath).catch(() => {});
            }
        }
        if (!existingJob) await writeJobAsync(path.join(PENDING_DIR, `${prefix}.json`), job);
    }
    const chargeUsage = !manifest.usageCharged;
    manifest = { ...manifest, status: "committed", committedAt: Date.now(), usageCharged: true };
    await atomicWriteFile(manifestPath, JSON.stringify(manifest));
    // Rebuilds derive this same single charge from the committed manifest.
    if (chargeUsage) incrementUsage(request.phone, request.eventName);
    return getVoiceGroup(groupId);
}

function enqueueVoiceGroup(input) {
    const key = input.groupId;
    if (voiceGroupLocks.has(key)) return voiceGroupLocks.get(key);
    const operation = _enqueueVoiceGroup(input).finally(() => voiceGroupLocks.delete(key));
    voiceGroupLocks.set(key, operation);
    return operation;
}

// ── Crash Recovery ───────────────────────────────────────────────────────────

async function recoverStaleJobs() {
    // Complete terminal transitions durably recorded by the previous process.
    const terminalEffectsRecovered = await sweepPendingRelayEffects();
    await sweepVoiceDeliveries();
    await sweepTerminalKioskReviewSiblings();

    // Recover jobs that were mid-generation when the server stopped
    await recoverDirectory(GENERATING_DIR, "generating");

    // Legacy: recover jobs from old processing/ directory
    try { await fsp.access(PROCESSING_DIR); await recoverDirectory(PROCESSING_DIR, "processing (legacy)"); } catch {}

    await sweepKioskGroupPublications();
    // A kiosk parent rejection can have stopped between sibling writes.
    // Finish it after generation recovery has moved any orphaned claims.
    await sweepKioskRejectDecisions();

    // Do not touch printing/ at boot. A remote relay or local CUPS process may
    // still be completing the physical print while the server restarts.
    // Heartbeat/age-based maintenance recovers only genuinely stale claims.

    // A crash can leave a ready job locked between queueing and its immediate
    // digital send. Keep an unsent kiosk job hidden from printers until the
    // post-ready sweep sends it; release other stale locks so printing proceeds.
    try {
        const ready = (await fsp.readdir(READY_DIR)).filter((f) => f.endsWith(".json"));
        for (const filename of ready) {
            const readyPath = path.join(READY_DIR, filename);
            const job = await readJobAsync(readyPath);
            if (!job.digitalDeliveryPendingAt) continue;
            if (job.inputMode === "voice") continue;
            if (job.kioskSubmission) {
                const state = job.kioskDeliveryState || "pending";
                const due = state === "pending" || (state === "retry"
                    && Number(job.kioskDeliveryNextAttemptAt || 0) <= Date.now());
                if (due && fs.existsSync(jobPaths(job).outputPath)) continue;
                // Accepted, ambiguous, or delayed retries can print while
                // their provider state is handled separately.
                delete job.digitalDeliveryPendingAt;
                await writeJobAsync(readyPath, job);
                continue;
            }
            delete job.digitalDeliveryPendingAt;
            delete job.smsSentAt;
            await writeJobAsync(readyPath, job);
            console.log(`♻️  Released stale digital delivery lock: ${filename}`);
        }
    } catch {}

    // NOTE: Previously this block auto-approved every pending review item
    // whose event had reviewMode !== "human" at boot. That caused a real
    // data-loss incident — a container restart (e.g. deploy) silently
    // flushed 12 pending reviews because getForEvent returned "off" for
    // an event the operator believed was "human". Whether that was due
    // to stale overrides, a race in settings.load, or a human edit
    // elsewhere, the correct behavior at boot is to leave the queue
    // alone. In-session toggles (admin flipping review off) are handled
    // explicitly by lib/review-settings.js, which is the only path that
    // should ever trigger a bulk auto-approve.
    //
    // If you really need to clear a stale review queue, do it from the
    // dashboard UI — not automatically on restart.

    // Recover non-permanent failed jobs
    let recoveredFailedJob = false;
    try {
        const failed = (await fsp.readdir(FAILED_DIR)).filter((f) => f.endsWith(".json"));
        for (const filename of failed) {
            const src = path.join(FAILED_DIR, filename);
            try {
                const job = await readJobAsync(src);
                if (job.kioskSubmission && !job.permanent && hasOutputFile(job)
                    && (!job.failReason || RECOVERABLE_GENERATION_FAILURES.has(job.failReason))) {
                    await recoverPublishedGeneration(src, filename, job);
                    recoveredFailedJob = true;
                    console.log(`♻️  Recovered previously failed kiosk job with published output: ${filename}`);
                    continue;
                }
                if (job.permanent || job.failReason) continue;
                job.retries = 0;

                if (hasOutputFile(job)) {
                    // Image already generated, just needs printing
                    await writeJobAsync(src, job);
                    await renameWithRetry(src, path.join(recoveredOutputDir(job), filename));
                    recoveredFailedJob = true;
                    console.log(`♻️  Recovered failed job to print queue: ${filename}`);
                } else {
                    await writeJobAsync(src, job);
                    await renameWithRetry(src, path.join(PENDING_DIR, filename));
                    recoveredFailedJob = true;
                    console.log(`♻️  Recovered failed job for retry: ${filename}`);
                }
            } catch (err) {
                console.error(`⚠️  Skipping corrupt failed job ${filename}: ${err.message}`);
            }
        }
    } catch {}
    if (recoveredFailedJob) await buildUsageCache();
    return terminalEffectsRecovered;
}

async function failRecoveredGeneration(src, filename, job, reason) {
    job.failReason = job.failReason || reason;
    markKioskGenerationFailed(job, job.failReason);
    const reviewMode = effectiveReviewMode(job);
    const reviewableVariant = job.parentJobId && (reviewMode === "ai" || reviewMode === "human");
    await cleanupStaged(job, { preserveSource: !!(reviewableVariant && job.kioskSubmission && !job.permanent) });
    if (reviewableVariant) {
        // Keep exhausted variants beside their review siblings. The parent
        // coordinator must see every expected variant before it can decide.
        job.variantStatus = "FAILED";
        job.reviewAt ||= Date.now();
        markVariantReviewMode(job, reviewMode);
        await writeJobAsync(src, job);
        await renameWithRetry(src, path.join(REVIEW_DIR, filename));
        invalidateReviewCache();
        // Startup calls this before media routes are ready. The first
        // generation poll will resume AI review after those routes mount.
        if (kioskDeliveryReady && hasDurableAiReviewMode(job)) void maybeRunAiBestOfN(job.parentJobId);
    } else {
        if (!job.parentJobId) markVoiceDeliveryPending(job, "failure");
        await writeJobAsync(src, job);
        await renameWithRetry(src, path.join(FAILED_DIR, filename));
    }
}

async function recoverPublishedGeneration(src, filename, job) {
    await completePublishedOutput(job);
    if (isGenerationOriginDeliveryFailure(job)) resetKioskDeliveryForRegeneration(job);
    job.retries = 0;
    delete job.failReason;
    delete job.permanent;
    if (job.kioskSubmission && job.parentJobId) {
        // A multi-variant portrait with a public output was already selected.
        // Resume its parent choice after routes mount, so other variants are
        // superseded before this winner is delivered.
        job.kioskApprovalStartedAt ||= Date.now();
        job.reviewAt ||= Date.now();
        job.variantStatus = "READY";
        await writeJobAsync(src, job);
        await renameWithRetry(src, path.join(REVIEW_DIR, filename));
        invalidateReviewCache();
        return;
    }
    const destination = recoveredOutputDir(job);
    if (destination === DONE_DIR) job.completedAt ||= Date.now();
    else job.readyAt ||= Date.now();
    if (job.kioskSubmission && destination === READY_DIR && kioskDeliveryStillPending(job)) {
        job.digitalDeliveryPendingAt ||= Date.now();
    }
    markVoiceDeliveryPending(job, "result");
    await writeJobAsync(src, job);
    await renameWithRetry(src, path.join(destination, filename));
}

async function retireTerminalGeneratingVariant(src, filename, job) {
    if (!job.parentJobId || !["SUPERSEDED", "REJECTED"].includes(job.variantStatus)) return false;
    await cleanupStaged(job);
    markKioskGenerationFailed(job, job.failReason || "superseded");
    await writeJobAsync(src, job);
    await renameWithRetry(src, path.join(FAILED_DIR, filename));
    invalidateReviewCache();
    return true;
}

async function recoverDirectory(dir, label) {
    let stale;
    try { stale = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json")); } catch { return; }
    for (const filename of stale) {
        const src = path.join(dir, filename);
        try {
            const job = await readJobAsync(src);
            if (await retireTerminalGeneratingVariant(src, filename, job)) {
                console.log(`♻️  Retired terminal ${label} variant: ${filename}`);
                continue;
            }
            job.retries++;

            if (hasOutputFile(job)) {
                await recoverPublishedGeneration(src, filename, job);
                console.log(`♻️  Recovered ${label} job with published output: ${filename}`);
            } else if (job.retries >= MAX_RETRIES) {
                await failRecoveredGeneration(src, filename, job, "max_retries");
                console.log(`💀 Stale ${label} job exceeded retries: ${filename}`);
            } else {
                await writeJobAsync(src, job);
                await renameWithRetry(src, path.join(PENDING_DIR, filename));
                console.log(`♻️  Recovered stale ${label} job (retry ${job.retries}): ${filename}`);
            }
        } catch (err) {
            console.error(`⚠️  Skipping corrupt ${label} job ${filename}: ${err.message}`);
        }
    }
}

// Sweep GENERATING_DIR for jobs whose worker has clearly died or hung. A
// healthy generation call returns within ~30-60s; anything much older is a
// stuck job that will never resolve on its own.
//
// Why this exists: recoverStaleJobs only runs at boot. If the server stays
// up but a generation call hangs indefinitely (TCP black-hole, OpenAI
// timeout with no error bubble-up, worker promise orphaned by an uncaught
// rejection), the job file stays in GENERATING_DIR forever with no one
// processing it. Users see "REGENERATING" spinner forever on the review
// card; operators have to hand-fix the file share.
//
// Called from the existing generation poll (index.js) alongside
// processGenerationQueue. Idempotent, safe to call every poll.
const GENERATING_STALE_MS = 5 * 60 * 1000; // 5 minutes

async function sweepStaleGenerating() {
    let files;
    try { files = (await fsp.readdir(GENERATING_DIR)).filter((f) => f.endsWith(".json")); } catch { return; }
    if (files.length === 0) return;
    const now = Date.now();
    for (const filename of files) {
        const src = path.join(GENERATING_DIR, filename);
        try {
            const job = await readJobAsync(src);
            const startedAt = job.generatingAt || job.stateChangedAt || 0;
            if (!startedAt || (now - startedAt) < GENERATING_STALE_MS) continue;
            console.log(`⏰ Stale generating job (${Math.round((now - startedAt) / 1000)}s old): ${filename}`);
            if (await retireTerminalGeneratingVariant(src, filename, job)) {
                console.log(`♻️  Retired stale terminal variant: ${filename}`);
                continue;
            }
            // Route through the same recovery path used at boot — increments
            // retries, re-queues to pending or moves to failed after
            // MAX_RETRIES, restores staged output to ready if it already
            // exists. Consistent semantics with crash recovery.
            job.retries++;
            if (hasOutputFile(job)) {
                await recoverPublishedGeneration(src, filename, job);
                console.log(`♻️  Recovered stale generating job with published output: ${filename}`);
            } else if (job.retries >= MAX_RETRIES) {
                await failRecoveredGeneration(src, filename, job, "stale_generating");
                console.log(`💀 Stale generating job exceeded retries: ${filename}`);
            } else {
                await writeJobAsync(src, job);
                await renameWithRetry(src, path.join(PENDING_DIR, filename));
                console.log(`♻️  Recovered stale generating job (retry ${job.retries}): ${filename}`);
            }
        } catch (err) {
            // ENOENT is the expected race: the generation worker finished
            // and renamed the file out of GENERATING_DIR between our readdir
            // snapshot and readFile. Nothing to do — the job is fine.
            if (err.code !== "ENOENT") {
                console.error(`⚠️  Sweep stale generating error for ${filename}: ${err.message}`);
            }
        }
    }
}

// ── Generation Worker (concurrent) ──────────────────────────────────────────

let generatingCount = 0;
let aiBestOfNSweepInFlight = null;
let nextAiBestOfNSweepAt = 0;

async function processGenerationQueue() {
    // The generation poll starts after routes are mounted. Recover AI review
    // groups and interrupted kiosk approvals without sending media too early.
    if (!aiBestOfNSweepInFlight && Date.now() >= nextAiBestOfNSweepAt) {
        nextAiBestOfNSweepAt = Date.now() + 30_000;
        aiBestOfNSweepInFlight = sweepKioskGroupPublications()
            .then(() => sweepTerminalKioskReviewSiblings())
            .then(() => sweepKioskRejectDecisions())
            .then(() => sweepKioskReviewApprovals())
            .then(() => sweepAiBestOfNGroups())
            .catch((error) => console.error(`⚠️  AI review recovery scan failed: ${error.message}`))
            .finally(() => { aiBestOfNSweepInFlight = null; });
    }
    if (generatingCount >= settings.get("maxConcurrentGeneration")) return true;

    let pending;
    try {
        pending = (await fsp.readdir(PENDING_DIR))
            .filter((f) => f.endsWith(".json"))
            .sort();
    } catch { return true; }

    if (pending.length === 0) return generatingCount > 0;

    const slots = settings.get("maxConcurrentGeneration") - generatingCount;
    const toProcess = [];
    for (const filename of pending) {
        if (toProcess.length >= slots) break;
        let eligible = true;
        try {
            const job = await readJobAsync(path.join(PENDING_DIR, filename));
            if (job.voiceGroupId) eligible = (await readVoiceGroup(job.voiceGroupId))?.status === "committed";
        } catch { eligible = false; }
        if (eligible) toProcess.push(filename);
    }

    for (const filename of toProcess) {
        const pendingPath = path.join(PENDING_DIR, filename);
        const generatingPath = path.join(GENERATING_DIR, filename);

        try {
            // Claim the job atomically by renaming first (rename-as-lock)
            await renameWithRetry(pendingPath, generatingPath);
        } catch {
            continue; // Another worker already claimed this job
        }

        try {
            // Stamp generating timestamp after claiming
            const job = await readClaimedJobWithRetry(generatingPath);
            if (applyTerminalVariantDecision(job)) {
                await cleanupStaged(job);
                await writeJobAsync(generatingPath, job);
                await renameWithRetry(generatingPath, path.join(FAILED_DIR, filename));
                invalidateReviewCache();
                continue;
            }
            const now = Date.now();
            job.generatingAt = now;
            job.stateChangedAt = now;
            // Keep this synchronous so a concurrent parent decision cannot
            // interleave between the claimed read and timestamp write.
            writeJob(generatingPath, job);
        } catch (err) {
            console.error(`⚠️  Failed to stamp claimed job ${filename}: ${err.message}`);
            // Never launch a worker without a readable, durable claim. Azure
            // Files can briefly hide the rename destination. Return a visible
            // destination to pending immediately; otherwise stale recovery will
            // handle the claim if neither path is visible yet.
            await renameWithRetry(generatingPath, pendingPath).catch(() => {});
            continue;
        }

        generatingCount++;
        processGeneration(filename, generatingPath).finally(() => {
            generatingCount--;
        });
    }
    return toProcess.length > 0;
}

async function processGeneration(filename, generatingPath) {
    let job;
    try {
        job = await readClaimedJobWithRetry(generatingPath);
    } catch (error) {
        console.error(`❌ Claimed job is not readable yet: ${filename} - ${error.message}`);
        await renameWithRetry(generatingPath, path.join(PENDING_DIR, filename)).catch(() => {});
        return;
    }
    if (applyTerminalVariantDecision(job)) {
        markKioskGenerationFailed(job, job.failReason || "superseded");
        await cleanupStaged(job);
        await writeJobAsync(generatingPath, job).catch(() => {});
        await renameWithRetry(generatingPath, path.join(FAILED_DIR, filename)).catch(() => {});
        invalidateReviewCache();
        return;
    }

    try {
        console.log(`⚙️  Generating: ${filename} (attempt ${job.retries + 1})`);

        await generateImage(job);

        // Success: reset retries
        job.retries = 0;
        const genDoneAt = Date.now();
        job.stateChangedAt = genDoneAt;

        // Did a sibling pickVariant/rejectParent run while we were generating?
        // If so, the parent decision has already happened and this output is
        // stale. Re-read the on-disk job to pick up any SUPERSEDED flag
        // written by pickVariant — the in-memory `job` was read before
        // generation started and wouldn't see it.
        if (job.parentJobId) {
            try {
                const fresh = await readClaimedJobWithRetry(generatingPath);
                if (applyTerminalVariantDecision(fresh)) {
                    markKioskGenerationFailed(fresh, fresh.failReason || "superseded");
                    // Preserve the supersede metadata the picker wrote, merge
                    // in our failure reason, drop the staged output, and park
                    // the job in FAILED_DIR. The user already got their image
                    // from whichever sibling was picked.
                    fresh.stateChangedAt = genDoneAt;
                    await cleanupStaged(fresh);
                    await writeJobAsync(generatingPath, fresh);
                    await renameWithRetry(generatingPath, path.join(FAILED_DIR, filename));
                    invalidateReviewCache();
                    console.log(`⏭️  Generation discarded — sibling already picked: ${filename}`);
                    return;
                }
            } catch (readErr) {
                if (readErr.code === "ENOENT") return;
                throw readErr;
            }
        }

        // Determine review mode: new reviewMode setting, or fall back to legacy enableManualReview
        const reviewMode = effectiveReviewMode(job);

        if (reviewMode === "ai") {
            // Multi-variant AI mode: defer the AI pick until all siblings are
            // terminal, then run a single best-of-N comparison across the whole
            // parent group. Each sibling parks in REVIEW_DIR (same as human
            // mode) while it waits.
            if (job.parentJobId) {
                job.reviewAt = genDoneAt;
                job.variantStatus = "READY";
                markVariantReviewMode(job, reviewMode);
                await writeJobAsync(generatingPath, job);
                await renameWithRetry(generatingPath, path.join(REVIEW_DIR, filename));
                invalidateReviewCache();
                console.log(`🤖 Variant ready, awaiting AI best-of-N: ${filename}`);
                // Fire-and-forget: if this is the last sibling, the coordinator
                // picks the winner and promotes it; otherwise it's a no-op.
                maybeRunAiBestOfN(job.parentJobId).catch((err) => {
                    console.error(`❌ AI best-of-N coordinator error: ${err.message}`);
                });
                return;
            }
            // AI review: automated quality check (legacy single-variant path)
            try {
                const result = await aiReviewImage(job);
                job.aiReviewResult = result.reason;
                if (result.passed) {
                    console.log(`✅ AI review passed: ${filename}`);
                    // Fall through to ready/done logic below
                } else {
                    // AI flagged — auto-reject and notify user to try again
                    console.log(`🔍 AI review flagged: ${filename} — ${result.reason}`);
                    job.failReason = "ai_review_rejected";
                    job.permanent = true;
                    markKioskGenerationFailed(job, job.failReason);
                    await cleanupStaged(job);
                    decrementUsage(job.userPhone, job.eventName);
                    markVoiceDeliveryPending(job, "failure");
                    await writeJobAsync(generatingPath, job);
                    await renameWithRetry(generatingPath, path.join(FAILED_DIR, filename));
                    stillWorking.cancel(job.userPhone);
                    if (!job.noDelivery && !job.kioskSubmission && job.inputMode !== "voice") {
                        messaging.send(job.userPhone, "_raw", {}, jobSendOptions(job, { _body: i18n.t(job.locale, "reviewFailed", {}, job.eventName) }))
                            .catch((err) => console.error(`❌ AI review rejection SMS failed: ${err.message}`));
                    }
                    return;
                }
            } catch (err) {
                // AI review API error — re-queue for retry instead of auto-approving
                console.error(`⚠️ AI review error, re-queuing for retry: ${err.message}`);
                job.retries = (job.retries || 0) + 1;
                job.stateChangedAt = Date.now();
                if (job.retries >= MAX_RETRIES) {
                    job.failReason = "ai_review_error";
                    markKioskGenerationFailed(job, job.failReason);
                    await cleanupStaged(job);
                    decrementUsage(job.userPhone, job.eventName);
                    markVoiceDeliveryPending(job, "failure");
                    await writeJobAsync(generatingPath, job);
                    await renameWithRetry(generatingPath, path.join(FAILED_DIR, filename));
                    console.log(`💀 AI review failed after max retries: ${filename}`);
                    stillWorking.cancel(job.userPhone);
                    if (!job.noDelivery && !job.kioskSubmission && job.inputMode !== "voice") {
                        messaging.send(job.userPhone, "_raw", {}, jobSendOptions(job, { _body: i18n.t(job.locale, "reviewFailed", {}, job.eventName) }))
                            .catch((e) => console.error(`❌ AI review failure SMS failed: ${e.message}`));
                    }
                } else {
                    await writeJobAsync(generatingPath, job);
                    await renameWithRetry(generatingPath, path.join(PENDING_DIR, filename));
                    console.log(`🔄 AI review error, re-queued (retry ${job.retries}): ${filename}`);
                }
                return;
            }
        } else if (reviewMode === "human") {
            // Human review: keep images staged until approved
            job.reviewAt = genDoneAt;
            if (job.parentJobId) {
                job.variantStatus = "READY";
                markVariantReviewMode(job, reviewMode);
            }
            await writeJobAsync(generatingPath, job);
            await renameWithRetry(generatingPath, path.join(REVIEW_DIR, filename));
            invalidateReviewCache();
            console.log(`\n🚨🚨🚨 AWAITING MANUAL REVIEW — ${filename} 🚨🚨🚨\n`);
            return;
        }

        // No review, AI passed, or AI soft-fail — proceed to delivery
        if (jobEventSetting(job, "enablePrinting")) {
            // Printing enabled: move staged images to final downloads
            await moveStagedToFinal(job);
            job.readyAt = genDoneAt;

            if (job.inputMode === "voice" || jobEventSetting(job, "immediateDigitalDelivery")) {
                job.digitalDeliveryPendingAt = Date.now();
            }
            markVoiceDeliveryPending(job, "result");

            await writeJobAsync(generatingPath, job);
            await renameWithRetry(generatingPath, path.join(READY_DIR, filename));
            console.log(`✅ Generation complete: ${filename}`);

            // Send digital copy immediately if enabled (don't wait for print)
            if (job.digitalDeliveryPendingAt) {
                const readyPath = path.join(READY_DIR, filename);
                try {
                    await sendDigitalDelivery(job, filename, "deliveryDigital", READY_DIR);
                    if (job.inputMode !== "voice" && !job.kioskSubmission) {
                        job.smsSentAt = Date.now();
                        delete job.digitalDeliveryPendingAt;
                        if (fs.existsSync(readyPath)) await writeJobAsync(readyPath, job);
                    }
                } catch (smsErr) {
                    console.error(`❌ Immediate digital delivery failed for ${filename}: ${smsErr.message}`);
                    if (job.inputMode !== "voice" && !job.kioskSubmission) {
                        delete job.digitalDeliveryPendingAt;
                        delete job.smsSentAt;
                        if (fs.existsSync(readyPath)) await writeJobAsync(readyPath, job).catch(() => {});
                    }
                }
            }
        } else {
            // Digital only: move staged images to final, send MMS, move to done
            await moveStagedToFinal(job);
            job.completedAt = genDoneAt;
            markVoiceDeliveryPending(job, "result");
            await writeJobAsync(generatingPath, job);
            await renameWithRetry(generatingPath, path.join(DONE_DIR, filename));
            console.log(`✅ Generation complete (digital delivery): ${filename}`);

            try {
                await sendDigitalDelivery(job, filename, "deliveryDigital", DONE_DIR);
            } catch (smsErr) {
                console.error(`❌ Digital delivery failed for ${filename}: ${smsErr.message}`);
            }
        }
    } catch (error) {
        console.error(`❌ Generation failed: ${filename} - ${error.message}`);
        if (error.response) {
            console.error(`❌ API error status=${error.response.status || "unknown"} twilioCode=${error.response.headers?.["x-twilio-error-code"] || "none"}`);
        }

        try {
            const now = Date.now();
            const jobRead = await readClaimedJobWithRetry(generatingPath);
            if (error.status === 400 && /safety system|safety rejection/i.test(error.message || "")) {
                error.permanent = true;
                error.failReason = "safety_rejected";
            }
            const isVariantSibling = !!jobRead.parentJobId;

            if (applyTerminalVariantDecision(jobRead)) {
                markKioskGenerationFailed(jobRead, jobRead.failReason || "superseded");
                await cleanupStaged(jobRead);
                await writeJobAsync(generatingPath, jobRead);
                await renameWithRetry(generatingPath, path.join(FAILED_DIR, filename));
                invalidateReviewCache();
                console.log(`⏭️  Terminal variant discarded after generation error: ${filename}`);
                return;
            }

            if (jobRead.kioskSubmission && !error.permanent && hasOutputFile(jobRead)) {
                // The portrait was already published before a later queue or
                // private-cleanup error. Resume that durable transition instead
                // of retrying generation with a source that may be gone.
                await recoverPublishedGeneration(generatingPath, filename, jobRead);
                console.log(`♻️  Completed published kiosk generation after error: ${filename}`);
                if (!isVariantSibling && kioskDeliveryReady && !jobRead.noDelivery) {
                    try {
                        await attemptKioskDelivery(jobRead, filename, recoveredOutputDir(jobRead));
                    } catch (deliveryError) {
                        console.error(`❌ Kiosk delivery pending retry for ${filename}: ${deliveryError.message}`);
                    }
                }
                return;
            }

            if (error.permanent) {
                jobRead.permanent = true;
                jobRead.failReason = error.failReason || "content_rejected";
                markKioskGenerationFailed(jobRead, jobRead.failReason);
                jobRead.stateChangedAt = now;
                await cleanupStaged(jobRead);
                if (isVariantSibling) {
                    // Variant sibling: keep in REVIEW_DIR as FAILED so aggregation
                    // can show the card when all siblings are terminal. Usage is
                    // counted/decremented at parent level (when card is rejected).
                    jobRead.variantStatus = "FAILED";
                    jobRead.reviewAt = jobRead.reviewAt || now;
                    markVariantReviewMode(jobRead, effectiveReviewMode(jobRead));
                    await writeJobAsync(generatingPath, jobRead);
                    await renameWithRetry(generatingPath, path.join(REVIEW_DIR, filename));
                    invalidateReviewCache();
                    console.log(`⚠️  Variant failed (kept in review for aggregation): ${filename}`);
                    if (hasDurableAiReviewMode(jobRead)) void maybeRunAiBestOfN(jobRead.parentJobId);
                } else {
                    decrementUsage(jobRead.userPhone, jobRead.eventName);
                    markVoiceDeliveryPending(jobRead, "failure");
                    await writeJobAsync(generatingPath, jobRead);
                    await renameWithRetry(generatingPath, path.join(FAILED_DIR, filename));
                    stillWorking.cancel(jobRead.userPhone);
                    console.log(`🚫 Job permanently failed: ${filename}`);
                }
            } else {
                jobRead.retries++;
                jobRead.stateChangedAt = now;
                if (jobRead.retries >= MAX_RETRIES) {
                    jobRead.failReason = "generation";
                    markKioskGenerationFailed(jobRead, jobRead.failReason);
                    await cleanupStaged(jobRead, { preserveSource: isVariantSibling && jobRead.kioskSubmission });
                    if (isVariantSibling) {
                        jobRead.variantStatus = "FAILED";
                        jobRead.reviewAt = jobRead.reviewAt || now;
                        markVariantReviewMode(jobRead, effectiveReviewMode(jobRead));
                        await writeJobAsync(generatingPath, jobRead);
                        await renameWithRetry(generatingPath, path.join(REVIEW_DIR, filename));
                        invalidateReviewCache();
                        console.log(`⚠️  Variant failed after retries (kept in review): ${filename}`);
                        if (hasDurableAiReviewMode(jobRead)) void maybeRunAiBestOfN(jobRead.parentJobId);
                    } else {
                        decrementUsage(jobRead.userPhone, jobRead.eventName);
                        markVoiceDeliveryPending(jobRead, "failure");
                        await writeJobAsync(generatingPath, jobRead);
                        await renameWithRetry(generatingPath, path.join(FAILED_DIR, filename));
                        console.log(`💀 Generation exceeded max retries, moved to failed: ${filename}`);
                        // Cancel the reassurance timer BEFORE sending the
                        // failure SMS so the user never gets "still working"
                        // after "couldn't generate" (minute-later contradiction).
                        stillWorking.cancel(jobRead.userPhone);
                        // Notify user their image failed
                        if (!jobRead.noDelivery && !jobRead.kioskSubmission && jobRead.inputMode !== "voice") {
                            messaging.send(jobRead.userPhone, "_raw", {}, jobSendOptions(jobRead, { _body: i18n.t(jobRead.locale, "reviewFailed", {}, jobRead.eventName) }))
                                .catch((err) => console.error(`❌ Failure notification failed: ${err.message}`));
                        }
                    }
                } else {
                    await cleanupStaged(jobRead, { preserveSource: jobRead.kioskSubmission });
                    await writeJobAsync(generatingPath, jobRead);
                    await renameWithRetry(generatingPath, path.join(PENDING_DIR, filename));
                    console.log(`🔄 Generation re-queued (retry ${jobRead.retries}): ${filename}`);
                }
            }
        } catch (moveErr) {
            console.error(`❌ Failed to move job file: ${moveErr.message}`);
        }
    }
}

// ── Print Worker (concurrent, one job per printer) ──────────────────────────

const printerBusy = new Map();

function getPrinterBusyState() {
    const state = {};
    for (const [name, busy] of printerBusy) {
        state[name] = busy;
    }
    return state;
}

// ── Stale relay job recovery (runs periodically) ─────────────────────────────

const RELAY_STALE_THRESHOLD = 15 * 60 * 1000; // 15 minutes — fallback for heartbeat-less relays
const RELAY_HEARTBEAT_STALE = 60 * 1000;      // 60 seconds — fast recovery when heartbeats stop
const LOCAL_STALE_THRESHOLD = 10 * 60 * 1000; // 10 minutes
const MAX_STALE_RECOVERIES = 5; // 5 × 15 min = 75 min relay downtime tolerance

function markFailureEffectsPending(job) {
    const releaseUsage = !job.reprint || !!job.reprintRestoredUsage;
    job.failureEffectsPending = true;
    job.usageReleasePending = releaseUsage;
    if (releaseUsage) job.countUsageOnRebuild = false;
}

const pendingEffectRuns = new Map();
const pendingEffectRetries = new Map();

function kioskDeliveryStillPending(job) {
    return job.kioskSubmission && !job.noDelivery && !job.smsSentAt
        && !["accepted", "delivered", "failed", "uncertain"].includes(job.kioskDeliveryState || "pending");
}

async function finishPendingRelayEffects(jobPath, filename) {
    pendingEffectRetries.set(jobPath, filename);
    if (pendingEffectRuns.has(jobPath)) return pendingEffectRuns.get(jobPath);

    const run = (async () => {
        let job = await readJobAsync(jobPath);

        // A durable physical completion always wins over a stale-recovery
        // failure marker created by an older server or an interrupted race.
        if (job.completedAt && job.failureEffectsPending) {
            if (job.inputMode === "voice") {
                job = await withVoiceJobLock(filename, async () => {
                    const latest = await readJobAsync(jobPath);
                    latest.failureEffectsPending = false;
                    delete latest.usageReleasePending;
                    delete latest.failReason;
                    await writeJobAsync(jobPath, latest);
                    return latest;
                });
            } else {
                job.failureEffectsPending = false;
                delete job.usageReleasePending;
                delete job.failReason;
                await writeJobAsync(jobPath, job);
            }
        }

        if (job.deliveryPending) {
            await sendPrintCompletionMms(job, filename);
            if (job.kioskSubmission) {
                job = await readJobAsync(jobPath);
                if (kioskDeliveryStillPending(job)) return false;
            }
            if (job.inputMode === "voice") {
                job = await withVoiceJobLock(filename, async () => {
                    const latest = await readJobAsync(jobPath);
                    latest.deliveryPending = false;
                    await writeJobAsync(jobPath, latest);
                    return latest;
                });
            } else {
                job.deliveryPending = false;
                await writeJobAsync(jobPath, job);
            }
        }

        if (job.failureEffectsPending) {
            const releaseUsage = job.usageReleasePending !== undefined
                ? job.usageReleasePending
                : (!job.reprint || !!job.reprintRestoredUsage);
            if (releaseUsage && !job.usageDecrementedAt) {
                // Persist the accounting decision before changing the in-memory
                // cache. A restart rebuild then observes the released quota.
                if (job.inputMode === "voice") {
                    let released = false;
                    job = await withVoiceJobLock(filename, async () => {
                        const latest = await readJobAsync(jobPath);
                        if (!latest.usageDecrementedAt) {
                            latest.countUsageOnRebuild = false;
                            latest.usageDecrementedAt = Date.now();
                            await writeJobAsync(jobPath, latest);
                            released = true;
                        }
                        return latest;
                    });
                    if (released) decrementUsage(job.userPhone, job.eventName);
                } else {
                    job.countUsageOnRebuild = false;
                    job.usageDecrementedAt = Date.now();
                    await writeJobAsync(jobPath, job);
                    decrementUsage(job.userPhone, job.eventName);
                }
            }
            await sendPrintCompletionMms(job, filename, null);
            if (job.kioskSubmission) {
                job = await readJobAsync(jobPath);
                if (kioskDeliveryStillPending(job)) return false;
            }
            if (job.inputMode === "voice") {
                await withVoiceJobLock(filename, async () => {
                    const latest = await readJobAsync(jobPath);
                    latest.failureEffectsPending = false;
                    delete latest.usageReleasePending;
                    await writeJobAsync(jobPath, latest);
                });
            } else {
                job.failureEffectsPending = false;
                delete job.usageReleasePending;
                await writeJobAsync(jobPath, job);
            }
        }
        return true;
    })();

    pendingEffectRuns.set(jobPath, run);
    try {
        const result = await run;
        if (result !== false) pendingEffectRetries.delete(jobPath);
        return result;
    } catch (err) {
        if (err.code === "ENOENT") pendingEffectRetries.delete(jobPath);
        throw err;
    } finally {
        pendingEffectRuns.delete(jobPath);
    }
}

async function settlePendingRelayTransition(filename, sourceDir = PRINTING_DIR) {
    const sourcePath = path.join(sourceDir, filename);
    let job;
    try {
        job = await readJobAsync(sourcePath);
    } catch (err) {
        if (err.code === "ENOENT") return null;
        throw err;
    }

    let terminalPath;
    let state;
    if (job.completedAt) {
        terminalPath = path.join(DONE_DIR, filename);
        state = "done";
    } else if (job.failureEffectsPending) {
        terminalPath = path.join(FAILED_DIR, filename);
        state = "failed";
    } else if (job.deliveryPending) {
        terminalPath = path.join(DONE_DIR, filename);
        state = "done";
    } else {
        return null;
    }

    try {
        await renameWithRetry(sourcePath, terminalPath);
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
    }
    if (fs.existsSync(terminalPath)) {
        await finishPendingRelayEffects(terminalPath, filename);
    }
    return state;
}

let readyTransitionSweepPending = true;

async function sweepPendingPrintingTransitions({ includeReady = false } = {}) {
    const sourceDirs = includeReady ? [PRINTING_DIR, READY_DIR] : [PRINTING_DIR];
    let readyComplete = true;
    for (const sourceDir of sourceDirs) {
        let active = [];
        try {
            active = (await fsp.readdir(sourceDir)).filter((f) => f.endsWith(".json"));
        } catch (err) {
            if (sourceDir === READY_DIR) readyComplete = false;
            console.error(`⚠️  Pending relay transition scan failed for ${path.basename(sourceDir)}: ${err.message}`);
        }
        for (const filename of active) {
            try {
                await settlePendingRelayTransition(filename, sourceDir);
            } catch (err) {
                if (sourceDir === READY_DIR && err.code && err.code !== "ENOENT") readyComplete = false;
                console.error(`⚠️  Pending relay transition failed for ${filename}: ${err.message}`);
            }
        }
    }
    return readyComplete;
}

async function sweepPendingTerminalEffects() {
    let complete = true;
    for (const dir of [DONE_DIR, FAILED_DIR]) {
        let files = [];
        try {
            files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
        } catch (err) {
            complete = false;
            console.error(`⚠️  Pending relay effects scan failed for ${path.basename(dir)}: ${err.message}`);
            continue;
        }
        for (const filename of files) {
            const jobPath = path.join(dir, filename);
            try {
                const job = await readJobAsync(jobPath);
                if (dir === FAILED_DIR && job.completedAt) {
                    const donePath = path.join(DONE_DIR, filename);
                    await renameWithRetry(jobPath, donePath);
                    if (await finishPendingRelayEffects(donePath, filename) === false) complete = false;
                    continue;
                }
                if (!job.deliveryPending && !job.failureEffectsPending) continue;
                if (await finishPendingRelayEffects(jobPath, filename) === false) complete = false;
            } catch (err) {
                complete = false;
                if (err.code !== "ENOENT") {
                    console.error(`⚠️  Pending relay effects failed for ${filename}: ${err.message}`);
                }
            }
        }
    }
    return complete;
}

async function retryKnownPendingRelayEffects() {
    for (const [jobPath, filename] of [...pendingEffectRetries]) {
        try {
            await finishPendingRelayEffects(jobPath, filename);
        } catch (err) {
            if (err.code !== "ENOENT") {
                console.error(`⚠️  Pending relay effects retry failed for ${filename}: ${err.message}`);
            }
        }
    }
}

async function sweepPendingRelayEffects() {
    // READY_DIR is included at startup to repair jobs recovered by older code.
    // Periodic maintenance scans only PRINTING_DIR to avoid rereading a large
    // healthy ready backlog every 30 seconds.
    const readyComplete = await sweepPendingPrintingTransitions({ includeReady: true });
    if (readyComplete) readyTransitionSweepPending = false;
    const terminalComplete = await sweepPendingTerminalEffects();
    return readyComplete && terminalComplete;
}

async function recoverStaleRelayJobs({ retryPendingEffects = true } = {}) {
    const readyComplete = await sweepPendingPrintingTransitions({ includeReady: readyTransitionSweepPending });
    if (readyTransitionSweepPending && readyComplete) readyTransitionSweepPending = false;
    if (retryPendingEffects) await retryKnownPendingRelayEffects();

    let printing;
    try {
        printing = (await fsp.readdir(PRINTING_DIR)).filter(f => f.endsWith(".json"));
    } catch { return; }

    const now = Date.now();
    for (const filename of printing) {
        const filePath = path.join(PRINTING_DIR, filename);
        const releaseJobLock = await acquireRelayJobLock(filename);
        try {
            const job = JSON.parse(await fsp.readFile(filePath, "utf-8"));
            if (job.completedAt || job.deliveryPending || job.failureEffectsPending) {
                await settlePendingRelayTransition(filename);
                continue;
            }
            if (!job.printingAt) continue;

            // Skip jobs being printed locally (tracked in printerBusy)
            if (job.printerName && printerBusy.get(job.printerName)) continue;

            // Two-tier threshold for relay mode:
            // 1. If heartbeats are present (relay ≥ v1.1), recover as soon as
            //    beats stop for >60s — the relay is dead or wedged.
            // 2. If no heartbeats (old relay or first-beat not arrived yet),
            //    fall back to the original 15-min age-of-printingAt. This
            //    keeps older deployed relays working without regression.
            const isRelayMode = !!settings.get("printRelayKey");
            if (isRelayMode) {
                const lastHeartbeat = relayHeartbeats.get(filename, job.claimId || "legacy") || job.lastHeartbeatAt;
                if (lastHeartbeat) {
                    if ((now - lastHeartbeat) < RELAY_HEARTBEAT_STALE) continue;
                } else {
                    if ((now - job.printingAt) < RELAY_STALE_THRESHOLD) continue;
                }
            } else {
                if ((now - job.printingAt) < LOCAL_STALE_THRESHOLD) continue;
            }

            const staleClaimId = job.claimId || null;
            job.staleRecoveries = (job.staleRecoveries || 0) + 1;
            job.stateChangedAt = now;
            relayHeartbeats.clear(filename, staleClaimId || "legacy");
            if (job.staleRecoveries >= MAX_STALE_RECOVERIES) {
                job.failReason = "relay_stale";
                job.terminalClaimId = staleClaimId;
                delete job.claimId;
                delete job.claimRevokedAt;
                markFailureEffectsPending(job);
                await writeJobAsync(filePath, job);
                await settlePendingRelayTransition(filename);
                console.log(`💀 Stale relay job exceeded recovery limit: ${filename}`);
            } else {
                // Revoke claim-ID and legacy completion rights before the job
                // becomes visible in ready/. ACK replaces this marker and the
                // new claim in one atomic write.
                delete job.claimId;
                delete job.terminalClaimId;
                job.claimRevokedAt = now;
                await writeJobAsync(filePath, job);
                await renameWithRetry(filePath, path.join(READY_DIR, filename));
                console.log(`♻️  Recovered stale relay job (stale recovery ${job.staleRecoveries}, retries ${job.retries || 0}): ${filename}`);
            }
        } catch { /* skip unreadable */ }
        finally { releaseJobLock(); }
    }
}

// Auto-clear targetPrinter on ready jobs aimed at relay printers that went offline.
// Prevents jobs from sitting stuck when a relay laptop disconnects.
const RELAY_TARGET_STALE_AGE = 2 * 60 * 1000; // 2 minutes
async function clearStaleRelayTargets() {
    if (!settings.get("printRelayKey")) return; // only relevant in relay mode
    let relayList;
    try {
        const { getRelayPrinters } = require("./print-relay");
        relayList = getRelayPrinters();
    } catch { return; }

    const aliveNames = new Set(relayList.map(rp => rp.name));
    let ready;
    try { ready = (await fsp.readdir(READY_DIR)).filter(f => f.endsWith(".json")); } catch { return; }

    for (const filename of ready) {
        const fp = path.join(READY_DIR, filename);
        try {
            const job = JSON.parse(await fsp.readFile(fp, "utf-8"));
            if (!job.targetPrinter) continue;
            if (aliveNames.has(job.targetPrinter)) continue;
            // Target printer hasn't checked in — check if the job has been waiting long enough
            if (job.stateChangedAt && (Date.now() - job.stateChangedAt) < RELAY_TARGET_STALE_AGE) continue;
            delete job.targetPrinter;
            // Guard: if the file was claimed (renamed away) between read and write,
            // discard the tmp to avoid creating a ghost duplicate in READY_DIR
            const tmp = fp + `.tmp.${process.pid}.${Date.now()}`;
            await fsp.writeFile(tmp, JSON.stringify(job));
            try {
                await fsp.access(fp);
                await renameWithRetry(tmp, fp);
            } catch {
                await fsp.unlink(tmp).catch(() => {});
                continue;
            }
            console.log(`🔓 Cleared stale targetPrinter on ${filename} (relay printer offline)`);
        } catch (e) {
            if (e.code !== "ENOENT") { /* skip */ }
        }
    }
}

// ── Missing-output orphan recovery (runs periodically) ───────────────────────
// A job only reaches READY_DIR after moveStagedToFinal() has placed its
// _output.png in the final downloads dir. If that PNG later goes missing
// (deleted, lost on the file share, never synced), the job becomes an orphan
// that can NEVER print: a relay claims it, the print-relay ack handler finds no
// image and returns HTTP 400 + bounces it back to ready, the relay marks it
// "processed" for ~10 min, then retries and bounces again — forever. It shows
// as a phantom "Ready to Print" count that never clears and the user never
// gets their portrait.
//
// This sweep detects such orphans and moves them to FAILED_DIR with
// failReason="missing_output", sending the MMS digital copy as a fallback so
// the user still receives something. Only READY_DIR is scanned — a job in
// PRINTING_DIR is owned by a relay actively working it and must not be touched.
async function sweepMissingOutputJobs() {
    let ready;
    try {
        ready = (await fsp.readdir(READY_DIR)).filter((f) => f.endsWith(".json"));
    } catch { return; }

    for (const filename of ready) {
        const src = path.join(READY_DIR, filename);
        let job;
        try {
            job = await readJobAsync(src);
        } catch { continue; } // unreadable or already moved — skip
        if (!job || !job.filePrefix) continue;

        // Does the print-resolution output image exist?
        const { outputPath } = jobPaths(job);
        try {
            await fsp.access(outputPath);
            continue; // image present — healthy, leave it queued
        } catch { /* missing — fall through to fail it */ }

        job.failReason = "missing_output";
        job.stateChangedAt = Date.now();
        if (job.inputMode === "voice" && job.voiceDeliveryState !== "sent") {
            markVoiceDeliveryPending(job, "failure");
        }
        if (!job.reprint) decrementUsage(job.userPhone, job.eventName);
        // Send the digital portrait as a fallback. The MMS is built from the
        // _output_mms.jpg which may also be gone; sendPrintCompletionMms
        // handles its own errors, so guard and continue regardless.
        if (job.inputMode !== "voice") {
            try { await sendPrintCompletionMms(job, filename, null); } catch (e) {
                console.error(`❌ Fallback MMS failed for missing-output job ${filename}: ${e.message}`);
            }
        }
        try {
            await writeJobAsync(src, job);
            await renameWithRetry(src, path.join(FAILED_DIR, filename));
            console.log(`🚫 Failed orphaned ready job (output image missing): ${filename}`);
        } catch (e) {
            // Lost a race — the job was claimed/moved between our read and
            // rename. Harmless: whoever claimed it will hit the ack 400 path.
            if (e.code !== "ENOENT") console.error(`⚠️  Could not fail missing-output job ${filename}: ${e.message}`);
        }
    }
}

// ── Reprint a terminal job ───────────────────────────────────────────────────
// Re-queues a job from DONE_DIR or FAILED_DIR into READY_DIR so a printer (local or
// relay) prints it again. Shared by the dashboard's /api/reprint-job and the
// relay's /api/print-relay/jobs/:filename/reprint so both surfaces use ONE
// code path and can't drift. Returns { ok, status, error } where status is an
// HTTP-style code the callers map straight onto their responses.
//
// Guards (in order):
//   404 — job not in a terminal queue
//   400 — already queued in ready/ or printing/ (prevents double-prints)
//   400 — the print-resolution _output.png is gone (nothing to print)
// reprint=true keeps the job out of quota accounting and, with smsSentAt
// preserved, suppresses a duplicate "your portrait" SMS on completion.
function requeueDoneJobForReprint(filename, { targetPrinter = null, eventName = null } = {}) {
    const safe = path.basename(filename || "");
    if (!safe || !safe.endsWith(".json")) return { ok: false, status: 400, error: "Invalid filename" };

    const donePath = path.join(DONE_DIR, safe);
    const failedPath = path.join(FAILED_DIR, safe);
    const srcPath = fs.existsSync(donePath) ? donePath : fs.existsSync(failedPath) ? failedPath : null;
    if (!srcPath) return { ok: false, status: 404, error: "Job not found in completed or failed queue" };
    if (fs.existsSync(path.join(READY_DIR, safe)) || fs.existsSync(path.join(PRINTING_DIR, safe))) {
        return { ok: false, status: 400, error: "Job is already queued for printing" };
    }

    try {
        const job = JSON.parse(fs.readFileSync(srcPath, "utf-8"));
        if (eventName && job.eventName !== eventName) {
            return { ok: false, status: 404, error: "Job not found for selected event" };
        }
        if (job.deliveryPending || job.failureEffectsPending) {
            return { ok: false, status: 409, error: "Job still has pending terminal delivery effects" };
        }

        const { outputPath } = jobPaths(job);
        if (!fs.existsSync(outputPath)) {
            return { ok: false, status: 400, error: "Output image no longer exists" };
        }

        const restoreOriginalUsage = srcPath === failedPath && job.countUsageOnRebuild !== true;
        job.reprint = true;
        job.reprintAt = Date.now();
        job.retries = 0;
        job.stateChangedAt = Date.now();
        delete job.printingAt;
        delete job.completedAt;
        delete job.failReason;
        delete job.failedPrinters;
        delete job.permanent;
        // Completed jobs were already delivered. Failed jobs may still need
        // their first successful delivery after the reprint succeeds.
        if (srcPath === donePath) job.smsSentAt = job.smsSentAt || Date.now();
        job.countUsageOnRebuild = true;
        if (restoreOriginalUsage) {
            job.reprintRestoredUsage = true;
            delete job.usageDecrementedAt;
        } else {
            delete job.reprintRestoredUsage;
        }
        delete job.deliveryPending;
        delete job.failureEffectsPending;
        delete job.usageReleasePending;
        delete job.terminalClaimId;
        delete job.claimId;
        delete job.claimRevokedAt;
        if (targetPrinter) job.targetPrinter = targetPrinter;
        else delete job.targetPrinter;

        atomicWriteFileSync(srcPath, JSON.stringify(job, null, 2), { tempDir: QUEUE_TMP_DIR });
        renameWithRetrySync(srcPath, path.join(READY_DIR, safe));

        // A failed original had its usage released. Restore that one original
        // usage slot when it is re-queued; subsequent reprints add no quota.
        if (restoreOriginalUsage) incrementUsage(job.userPhone, job.eventName);
        console.log(`🔄 Reprint queued: ${safe}${targetPrinter ? ` (targeting ${targetPrinter})` : ""}`);
        return { ok: true, status: 200 };
    } catch (err) {
        if (err.code === "ENOENT") return { ok: false, status: 409, error: "Job was already moved (concurrent request)" };
        console.error(`Failed to reprint job ${safe}:`, err);
        return { ok: false, status: 500, error: err.message };
    }
}

async function processPrintQueue() {
    // If relay mode is active, skip local printing — relay agent handles it
    if (settings.get("printRelayKey")) return false;

    let printers;
    try {
        printers = await getActivePrinters();
    } catch {
        return true; // Retry transient printer discovery failures quickly
    }
    if (printers.length === 0) return false;

    const idlePrinters = printers.filter((p) => !printerBusy.get(p));
    if (idlePrinters.length === 0) return true;

    let ready;
    try {
        ready = (await fsp.readdir(READY_DIR))
            .filter((f) => f.endsWith(".json"))
            .sort();
    } catch { return true; }

    if (ready.length === 0) return [...printerBusy.values()].some(Boolean);

    // Smart dispatch: read job metadata to avoid failed printers and respect targetPrinter
    const usedPrinters = new Set();
    for (const filename of ready) {
        if (usedPrinters.size >= idlePrinters.length) break;

        let job;
        try { job = JSON.parse(await fsp.readFile(path.join(READY_DIR, filename), "utf-8")); } catch { continue; }
        if (hasActiveDigitalDeliveryLock(job)) continue;

        const failed = job.failedPrinters || [];
        const target = job.targetPrinter || null;

        // Find the best idle printer for this job
        let bestPrinter = null;
        for (const p of idlePrinters) {
            if (usedPrinters.has(p)) continue;
            if (target && p !== target) continue; // targetPrinter set but doesn't match
            if (!target && failed.includes(p)) continue; // skip printers that failed this job
            bestPrinter = p;
            break;
        }

        // If no preferred printer found, fall back to any idle printer (even previously failed)
        if (!bestPrinter && !target) {
            for (const p of idlePrinters) {
                if (usedPrinters.has(p)) continue;
                bestPrinter = p;
                break;
            }
        }

        if (!bestPrinter) continue; // no printer available for this job (e.g., target printer is busy)

        usedPrinters.add(bestPrinter);
        printerBusy.set(bestPrinter, true);
        processSinglePrint(filename, bestPrinter).finally(() => {
            printerBusy.set(bestPrinter, false);
        });
    }
    return ready.length > 0;
}

async function processSinglePrint(filename, printerName, runPrint = printJob) {
    const readyPath = path.join(READY_DIR, filename);
    const printingPath = path.join(PRINTING_DIR, filename);
    let claimedByLocalPrinter = false;

    try {
        // Serialize the local READY claim with relay ACK and kiosk delivery.
        // The voice lock then protects job writes through the rename.
        const releaseClaimLock = await acquireRelayJobLock(filename);
        let job;
        try {
            job = await withVoiceJobLock(filename, async () => {
                let preJob;
                try { preJob = await readJobAsync(readyPath); }
                catch (error) {
                    if (error.code === "ENOENT") return null; // relay claimed it first
                    throw error;
                }
                if (hasActiveDigitalDeliveryLock(preJob)) return null;
                const printStartAt = Date.now();
                preJob.printingAt = printStartAt;
                preJob.stateChangedAt = printStartAt;
                preJob.printerName = printerName;
                await writeJobAsync(readyPath, preJob);
                await renameWithRetry(readyPath, printingPath);
                claimedByLocalPrinter = true;
                return readJobAsync(printingPath);
            });
        } finally {
            releaseClaimLock();
        }
        if (!job) return;
        console.log(`🖨️  Printing on ${printerName}: ${filename}`);

        await runPrint(job, printerName);

        await withVoiceJobLock(filename, async () => {
            const current = await readJobAsync(printingPath);
            current.completedAt = Date.now();
            current.stateChangedAt = current.completedAt;
            delete current.targetPrinter; // Clear targeting after successful print
            delete current.reprintRestoredUsage;
            current.deliveryPending = !current.smsSentAt;
            await writeJobAsync(printingPath, current);
            await renameWithRetry(printingPath, path.join(DONE_DIR, filename));
        });
        console.log(`✅ Printed on ${printerName}: ${filename}`);

        await finishPendingRelayEffects(path.join(DONE_DIR, filename), filename);
    } catch (error) {
        if (!claimedByLocalPrinter) {
            if (error.code !== "ENOENT") console.error(`❌ Print claim failed on ${printerName}: ${filename} - ${error.message}`);
            return;
        }
        console.error(`❌ Print failed on ${printerName}: ${filename} - ${error.message}`);

        try {
            const terminal = await withVoiceJobLock(filename, async () => {
                const job = await readJobAsync(printingPath);
                job.retries++;
                job.stateChangedAt = Date.now();
                job.failedPrinters = [...(job.failedPrinters || []), printerName];
                if (job.retries >= MAX_RETRIES) {
                    job.failReason = "printer";
                    markFailureEffectsPending(job);
                    await writeJobAsync(printingPath, job);
                    await renameWithRetry(printingPath, path.join(FAILED_DIR, filename));
                    return true;
                }
                delete job.targetPrinter; // Let smart dispatch pick a different printer
                await writeJobAsync(printingPath, job);
                await renameWithRetry(printingPath, path.join(READY_DIR, filename));
                return false;
            });
            if (terminal) {
                await finishPendingRelayEffects(path.join(FAILED_DIR, filename), filename);
                console.log(`💀 Print exceeded max retries, moved to failed: ${filename}`);
            } else {
                console.log(`🔄 Print re-queued: ${filename}`);
            }
        } catch (moveErr) {
            console.error(`❌ Failed to move job file: ${moveErr.message}`);
        }
    }
}

// ── Kiosk digital delivery ──────────────────────────────────────────────────

const KIOSK_DELIVERY_MAX_ATTEMPTS = 4;
const KIOSK_DELIVERY_RETRY_DELAYS = [30_000, 120_000, 300_000];
const KIOSK_DELIVERY_SENDING_LEASE_MS = 5 * 60_000;
let kioskDeliveryReady = true;

function setKioskDeliveryReady(ready) {
    kioskDeliveryReady = ready === true;
}

function kioskJobPath(filename, preferredDir) {
    const dirs = [preferredDir, READY_DIR, DONE_DIR, PRINTING_DIR, FAILED_DIR, REVIEW_DIR, GENERATING_DIR, PENDING_DIR]
        .filter(Boolean);
    for (const dir of new Set(dirs)) {
        const candidate = path.join(dir, filename);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function kioskShareUrl(job) {
    if (!job.baseUrl) return "";
    return `${job.baseUrl}/s/${encodeURIComponent(job.filePrefix)}?e=${encodeURIComponent(job.eventName)}`;
}

async function sendKioskViaProvider(job) {
    const { outputPath, mmsPath } = jobPaths(job);
    if (!fs.existsSync(outputPath)) throw new Error("Finished portrait is unavailable for delivery");
    const shareUrl = kioskShareUrl(job);
    if (job.channel === "email") {
        const { sendKioskEmail } = require("./kiosk-email");
        // SendGrid can attach the print-quality image when it fits. The MMS
        // derivative is only a size fallback for the 20 MiB attachment cap.
        const imagePath = fs.statSync(outputPath).size <= 20 * 1024 * 1024 || !fs.existsSync(mmsPath)
            ? outputPath : mmsPath;
        const sent = await sendKioskEmail(job, { imagePath, shareUrl });
        if (sent?.status !== "accepted") throw new Error("SendGrid did not accept the email");
        return { providerId: sent.providerId || null };
    }

    const adapter = jobAdapter(job);
    const eventParam = encodeURIComponent(job.eventName);
    const finalImagePath = `s/${encodeURIComponent(job.filePrefix)}/img?e=${eventParam}`;
    const mmsImagePath = `s/${encodeURIComponent(job.filePrefix)}/mms?e=${eventParam}`;
    const finalImageUrl = job.baseUrl ? `${job.baseUrl}/${finalImagePath}` : null;
    const mmsImageUrl = job.baseUrl ? `${job.baseUrl}/${mmsImagePath}` : null;
    if (!finalImageUrl) throw new Error("Public delivery URL is not configured");
    const statusCallback = `${job.baseUrl}/api/kiosk-delivery/twilio-status/${encodeURIComponent(job.filePrefix)}?e=${eventParam}`;
    const styleName = job.styleName || job.kioskEventSnapshot?.style?.name || job.style || "AI";
    let sent;
    if (job.channel === "whatsapp") {
        const contentSid = job.kioskEventSnapshot?.deliveryContentSid || settings.getContentSid("delivery", job.locale);
        if (!contentSid) throw new Error("Approved WhatsApp delivery template is unavailable");
        const media = selectWhatsappDeliveryMedia(fs.statSync(outputPath).size, {
            finalImageUrl, finalImagePath, mmsImageUrl, mmsImagePath,
        });
        if (!media.imageUrl) throw new Error("Finished portrait exceeds WhatsApp media limit");
        sent = await messaging.send(job.userPhone, "delivery", {
            1: styleName,
            2: media.templateImagePath,
            3: `s/${job.filePrefix}?e=${eventParam}`,
        }, {
            adapter, locale: job.locale, contentSid, allowOutOfSession: true, statusCallback,
        });
    } else if (job.channel === "sms") {
        const body = `${i18n.t(job.locale, "deliveryDigital", { styleName }, job.eventName)}\n${shareUrl}`;
        sent = await messaging.send(job.userPhone, "_raw", {}, {
            _body: body, mediaUrl: mmsImageUrl, adapter, statusCallback,
        });
    } else {
        throw new Error(`Unsupported kiosk delivery channel: ${job.channel}`);
    }
    if (sent?.error || sent?.skipped || !sent?.sid) {
        const error = new Error(sent?.error || sent?.skipped || "Provider did not accept the message");
        if (sent?.uncertain) error.uncertain = true;
        if (sent?.retryable === false) error.retryable = false;
        throw error;
    }
    return { providerId: sent.sid };
}

async function attemptKioskDelivery(job, filename, preferredDir) {
    // A relay claim renames READY to PRINTING. Hold its lock through the
    // provider request so the result is persisted at the same queue path.
    // Terminal effects already hold this lock and call us from DONE/FAILED.
    const releaseRelayLock = preferredDir === READY_DIR || preferredDir === PRINTING_DIR
        ? await acquireRelayJobLock(filename) : null;
    try {
        return await withVoiceJobLock(filename, async () => {
            const jobPath = kioskJobPath(filename, preferredDir);
            if (!jobPath) throw new Error("Kiosk job is unavailable for delivery");
            const current = await readJobAsync(jobPath);
            if (!current.kioskSubmission) throw new Error("Job is not a kiosk submission");
            const state = current.kioskDeliveryState || "pending";
            if (state === "accepted" || state === "delivered") {
                Object.assign(job, current);
                return current;
            }
            if (state === "failed" || state === "uncertain") {
                Object.assign(job, current);
                return current;
            }
            // Startup recovery can reach this path while /s media still
            // returns 503. The post-ready sweep will send this job later.
            if (!kioskDeliveryReady) {
                Object.assign(job, current);
                return current;
            }
            const now = Date.now();
            if (state === "retry" && current.kioskDeliveryNextAttemptAt > now) {
                Object.assign(job, current);
                return current;
            }
            if (state === "sending") {
                if (now - (current.kioskDeliveryAttemptStartedAt || 0) < KIOSK_DELIVERY_SENDING_LEASE_MS) {
                    Object.assign(job, current);
                    return current;
                }
                // A crash during the provider request is ambiguous. Sending again
                // could duplicate the portrait, so surface this for an operator.
                current.kioskDeliveryState = "uncertain";
                current.kioskDeliveryLastError = "Provider result is unknown after an interrupted send";
                current.kioskDeliveryUpdatedAt = now;
                delete current.digitalDeliveryPendingAt;
                await writeJobAsync(jobPath, current);
                Object.assign(job, current);
                return current;
            }

            current.kioskDeliveryState = "sending";
            current.kioskDeliveryAttempts = (current.kioskDeliveryAttempts || 0) + 1;
            delete current.kioskDeliveryFailureSource;
            current.kioskDeliveryAttemptStartedAt = now;
            current.kioskDeliveryUpdatedAt = now;
            delete current.kioskDeliveryLastError;
            delete current.kioskDeliveryNextAttemptAt;
            await writeJobAsync(jobPath, current);

            try {
                const result = await sendKioskViaProvider(current);
                // Provider callbacks use this same lock. A delivery callback that
                // has already arrived must not be downgraded to mere acceptance.
                const latest = await readJobAsync(jobPath);
                if (!["accepted", "delivered", "failed"].includes(latest.kioskDeliveryState)
                    || !latest.kioskProviderStatus) {
                    latest.kioskDeliveryState = "accepted";
                    latest.kioskDeliveryProviderId = result.providerId;
                    latest.kioskDeliveryAcceptedAt = Date.now();
                    latest.kioskDeliveryUpdatedAt = latest.kioskDeliveryAcceptedAt;
                }
                if (["accepted", "delivered"].includes(latest.kioskDeliveryState)) latest.smsSentAt ||= Date.now();
                delete latest.digitalDeliveryPendingAt;
                await writeJobAsync(jobPath, latest);
                Object.assign(job, latest);
                return latest;
            } catch (error) {
                const latest = await readJobAsync(jobPath);
                // A signed provider event may have arrived while an API response
                // was lost. Its observed state wins over an ambiguous API error.
                if (["accepted", "delivered", "failed"].includes(latest.kioskDeliveryState)
                    && latest.kioskProviderStatus) {
                    delete latest.digitalDeliveryPendingAt;
                    await writeJobAsync(jobPath, latest);
                    Object.assign(job, latest);
                    return latest;
                }
                const attempts = latest.kioskDeliveryAttempts || 1;
                latest.kioskDeliveryState = error.uncertain === true ? "uncertain"
                    : error.retryable === false || attempts >= KIOSK_DELIVERY_MAX_ATTEMPTS ? "failed" : "retry";
                latest.kioskDeliveryLastError = String(error.message || error).slice(0, 300);
                latest.kioskDeliveryUpdatedAt = Date.now();
                if (latest.kioskDeliveryState === "retry") {
                    latest.kioskDeliveryNextAttemptAt = latest.kioskDeliveryUpdatedAt
                        + KIOSK_DELIVERY_RETRY_DELAYS[Math.min(attempts - 1, KIOSK_DELIVERY_RETRY_DELAYS.length - 1)];
                } else if (latest.kioskDeliveryState === "uncertain") {
                    latest.kioskDeliveryUncertainAt = latest.kioskDeliveryUpdatedAt;
                    delete latest.kioskDeliveryNextAttemptAt;
                } else {
                    latest.kioskDeliveryFailedAt = latest.kioskDeliveryUpdatedAt;
                    delete latest.kioskDeliveryNextAttemptAt;
                }
                delete latest.digitalDeliveryPendingAt;
                await writeJobAsync(jobPath, latest);
                Object.assign(job, latest);
                throw error;
            }
        });
    } finally {
        releaseRelayLock?.();
    }
}

async function sweepKioskDeliveries({ dirs = [READY_DIR, DONE_DIR, PRINTING_DIR] } = {}) {
    for (const dir of dirs) {
        let filenames;
        try { filenames = (await fsp.readdir(dir)).filter((name) => name.endsWith(".json")); }
        catch { continue; }
        for (const filename of filenames) {
            const jobPath = path.join(dir, filename);
            let job;
            try { job = await readJobAsync(jobPath); }
            catch { continue; }
            if (!job.kioskSubmission || job.noDelivery) continue;
            const state = job.kioskDeliveryState || "pending";
            if (!["pending", "retry", "sending"].includes(state)) continue;
            if (state === "retry" && job.kioskDeliveryNextAttemptAt > Date.now()) continue;
            if (state === "sending" && Date.now() - (job.kioskDeliveryAttemptStartedAt || 0) < KIOSK_DELIVERY_SENDING_LEASE_MS) continue;
            if (!fs.existsSync(jobPaths(job).outputPath)) continue;
            try { await attemptKioskDelivery(job, filename, dir); }
            catch (error) { console.error(`❌ Kiosk delivery retry failed for ${filename}: ${error.message}`); }
        }
    }
}

async function updateKioskDeliveryFromProvider(filePrefix, eventName, { providerId, status, errorCode } = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(filePrefix || "")) return false;
    const filename = `${filePrefix}.json`;
    const releaseRelayLock = await acquireRelayJobLock(filename);
    try {
        return await withVoiceJobLock(filename, async () => {
            const jobPath = kioskJobPath(filename);
            if (!jobPath) return false;
            const job = await readJobAsync(jobPath);
            if (!job.kioskSubmission || job.eventName !== eventName || !["sms", "whatsapp"].includes(job.channel)) return false;
            if (!providerId) return false;
            if (!job.kioskDeliveryProviderId && ["sending", "uncertain"].includes(job.kioskDeliveryState)) {
                // A signed webhook can beat the API response, or arrive after a
                // transport error left the provider result uncertain.
                job.kioskDeliveryProviderId = providerId;
            }
            if (providerId !== job.kioskDeliveryProviderId) return false;
            const normalized = String(status || "").toLowerCase();
            if (job.kioskDeliveryState === "failed") return true;
            if (job.kioskDeliveryState === "delivered" && !["delivered", "read"].includes(normalized)) return true;
            if (normalized === "delivered" || normalized === "read") {
                job.kioskDeliveryState = "delivered";
                job.kioskDeliveryDeliveredAt = Date.now();
                job.kioskProviderStatus = normalized;
                job.smsSentAt ||= job.kioskDeliveryDeliveredAt;
            } else if (normalized === "failed" || normalized === "undelivered") {
                job.kioskDeliveryState = "failed";
                job.kioskDeliveryFailedAt = Date.now();
                job.kioskProviderStatus = normalized;
                job.kioskDeliveryLastError = errorCode ? `Twilio error ${String(errorCode).slice(0, 20)}` : "Carrier delivery failed";
                delete job.kioskDeliveryNextAttemptAt;
            } else {
                job.kioskProviderStatus = normalized;
                if (["queued", "accepted", "sending", "sent"].includes(normalized)
                    && ["sending", "uncertain", "retry", "pending"].includes(job.kioskDeliveryState)) {
                    job.kioskDeliveryState = "accepted";
                    job.kioskDeliveryAcceptedAt ||= Date.now();
                    job.smsSentAt ||= job.kioskDeliveryAcceptedAt;
                    delete job.kioskDeliveryNextAttemptAt;
                    delete job.digitalDeliveryPendingAt;
                }
            }
            job.kioskDeliveryUpdatedAt = Date.now();
            delete job.kioskDeliveryFailureSource;
            await writeJobAsync(jobPath, job);
            return true;
        });
    } finally {
        releaseRelayLock();
    }
}

async function updateKioskEmailFromProvider(filePrefix, requestId, {
    status, providerId, eventId, reason, timestamp,
} = {}) {
    if (!/^[A-Za-z0-9_-]+$/.test(filePrefix || "")
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(requestId || "")) return false;
    const normalized = String(status || "").toLowerCase();
    if (!["processed", "deferred", "delivered", "bounce", "dropped", "spamreport"].includes(normalized)) return false;
    const filename = `${filePrefix}.json`;
    const releaseRelayLock = await acquireRelayJobLock(filename);
    try {
        return await withVoiceJobLock(filename, async () => {
            const jobPath = kioskJobPath(filename);
            if (!jobPath) return false;
            const job = await readJobAsync(jobPath);
            if (!job.kioskSubmission || job.channel !== "email" || job.requestId !== requestId) return false;

            const incomingEventId = typeof eventId === "string" ? eventId.slice(0, 200) : "";
            if (incomingEventId && incomingEventId === job.kioskProviderEventId) return true;
            const incomingTimestamp = Number(timestamp);
            const eventTimestamp = Number.isSafeInteger(incomingTimestamp) && incomingTimestamp > 0
                ? incomingTimestamp : null;
            const priorTimestamp = job.kioskProviderEventTimestamp || null;
            if (eventTimestamp && priorTimestamp && eventTimestamp < priorTimestamp) return true;

            const terminal = ["delivered", "failed"].includes(job.kioskDeliveryState);
            const isTerminalEvent = ["delivered", "bounce", "dropped", "spamreport"].includes(normalized);
            if (terminal && (!isTerminalEvent || !eventTimestamp
                || (priorTimestamp && eventTimestamp === priorTimestamp))) return true;

            const eventAt = eventTimestamp
                ? (eventTimestamp < 1_000_000_000_000 ? eventTimestamp * 1000 : eventTimestamp)
                : Date.now();
            if (providerId) {
                job.kioskProviderMessageId = String(providerId).slice(0, 200);
                job.kioskDeliveryProviderId ||= job.kioskProviderMessageId;
            }
            if (incomingEventId) job.kioskProviderEventId = incomingEventId;
            if (eventTimestamp) job.kioskProviderEventTimestamp = eventTimestamp;
            job.kioskProviderStatus = normalized;
            job.kioskDeliveryUpdatedAt = Date.now();
            delete job.kioskDeliveryFailureSource;

            if (normalized === "delivered") {
                job.kioskDeliveryState = "delivered";
                job.kioskDeliveryDeliveredAt = eventAt;
                job.smsSentAt ||= eventAt;
                delete job.kioskDeliveryLastError;
                delete job.kioskDeliveryNextAttemptAt;
                delete job.digitalDeliveryPendingAt;
            } else if (isTerminalEvent) {
                job.kioskDeliveryState = "failed";
                job.kioskDeliveryFailedAt = eventAt;
                job.kioskDeliveryLastError = reason
                    ? `SendGrid ${normalized}: ${String(reason).slice(0, 200)}`
                    : `SendGrid ${normalized}`;
                delete job.kioskDeliveryNextAttemptAt;
                delete job.digitalDeliveryPendingAt;
            } else {
                // Processed/deferred proves SendGrid accepted the request,
                // even if the Mail Send API response was lost.
                job.kioskDeliveryState = "accepted";
                job.kioskDeliveryAcceptedAt ||= eventAt;
                job.smsSentAt ||= eventAt;
                delete job.kioskDeliveryNextAttemptAt;
                delete job.digitalDeliveryPendingAt;
            }
            await writeJobAsync(jobPath, job);
            return true;
        });
    } finally {
        releaseRelayLock();
    }
}

async function rememberKioskResultPointer(siblings, targetPrefix) {
    for (const sibling of siblings) {
        if (!sibling.job.kioskSubmission || sibling.job.filePrefix === targetPrefix) continue;
        const jobPath = kioskJobPath(sibling.filename);
        if (!jobPath) continue;
        try {
            const job = await readJobAsync(jobPath);
            job.kioskResultPrefix = targetPrefix;
            await writeJobAsync(jobPath, job);
        } catch (error) {
            console.error(`⚠️  Could not link kiosk result ${sibling.filename}: ${error.message}`);
        }
    }
}

async function findKioskResultSuccessor(job, eventName) {
    const parentId = job.parentJobId;
    if (!parentId) return null;
    const reanalyzed = [];
    const siblings = [];
    for (const dir of [DONE_DIR, READY_DIR, PRINTING_DIR, REVIEW_DIR, GENERATING_DIR, PENDING_DIR, FAILED_DIR]) {
        let names;
        try { names = (await fsp.readdir(dir)).filter((name) => name.endsWith(".json")); }
        catch { continue; }
        for (const name of names) {
            const maybeSibling = name.startsWith(`${parentId}-v`);
            if (!maybeSibling && job.failReason !== "reanalyzed") continue;
            let candidate;
            try { candidate = await readJobAsync(path.join(dir, name)); }
            catch { continue; }
            if (!candidate.kioskSubmission || candidate.eventName !== eventName) continue;
            if (job.failReason === "reanalyzed" && candidate.reanalyzedFrom === parentId) {
                reanalyzed.push(candidate);
            }
            if (maybeSibling && candidate.parentJobId === parentId
                && !["SUPERSEDED", "REJECTED", "FAILED"].includes(candidate.variantStatus)) {
                siblings.push({ job: candidate, dir });
            }
        }
    }
    if (reanalyzed.length > 0) {
        reanalyzed.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)
            || (a.variantIndex || 1) - (b.variantIndex || 1));
        return reanalyzed[0].filePrefix;
    }
    if (siblings.length > 0) {
        const rank = (item) => item.dir === DONE_DIR || item.dir === READY_DIR || item.dir === PRINTING_DIR ? 0 : 1;
        siblings.sort((a, b) => rank(a) - rank(b)
            || (a.job.variantIndex || 1) - (b.job.variantIndex || 1));
        return siblings[0].job.filePrefix;
    }
    return null;
}

async function resolveKioskResultPrefix(originalPrefix, eventName) {
    if (!/^[A-Za-z0-9_-]+$/.test(originalPrefix || "")) return originalPrefix;
    let prefix = originalPrefix;
    const seen = new Set();
    for (let depth = 0; depth < 8 && !seen.has(prefix); depth++) {
        seen.add(prefix);
        const jobPath = kioskJobPath(`${prefix}.json`);
        if (!jobPath) break;
        let job;
        try { job = await readJobAsync(jobPath); }
        catch { break; }
        if (!job.kioskSubmission || job.eventName !== eventName) break;
        let next = /^[A-Za-z0-9_-]+$/.test(job.kioskResultPrefix || "")
            ? job.kioskResultPrefix : null;
        if (!next && job.variantStatus === "SUPERSEDED") {
            next = await findKioskResultSuccessor(job, eventName);
        }
        if (!next || next === prefix) break;
        prefix = next;
    }
    return prefix;
}

// ── Digital delivery helper (shared by generation, print completion, and review approval) ──

async function sendDigitalDelivery(job, filename, templateKey, jobDir) {
    const ev = job.eventName;
    // API / kiosk jobs have no real recipient — skip every SMS side effect
    // (delivery media, promo, NPS, lead survey). The generated image remains
    // available through the gallery and result endpoints.
    if (job.noDelivery) return;
    if (job.inputMode === "voice") {
        const jobPath = path.join(jobDir, filename);
        if (!job.voiceDeliveryKind) {
            markVoiceDeliveryPending(job, "result");
            await writeJobAsync(jobPath, job);
        }
        const delivered = await attemptVoiceDelivery(filename);
        if (!delivered || delivered.voiceDeliveryState !== "sent") {
            throw new Error(delivered?.voiceDeliveryLastError || "Voice delivery is pending retry");
        }
        return;
    }
    if (job.kioskSubmission) {
        const delivered = await attemptKioskDelivery(job, filename, jobDir);
        if (!["accepted", "delivered"].includes(delivered.kioskDeliveryState)) {
            throw new Error(delivered.kioskDeliveryLastError || "Kiosk delivery is pending");
        }
        return;
    }
    // Cancel any pending "still working" SMS BEFORE we send delivery — prevents
    // the user getting both messages back-to-back if the timer fires mid-send.
    stillWorking.cancel(job.userPhone);
    const activeStyles = settings.getActiveStyles();
    const activeStyleList = settings.getActiveStyleList();
    const configuredDefault = settings.getForEvent("defaultStyle", ev) || DEFAULT_STYLE;
    const jobStyle = job.style && activeStyles[job.style] ? job.style : (activeStyleList[0] || configuredDefault);
    const singleStyle = activeStyleList.length <= 1;
    const richStyleName = job.styleName
        || optionI18n.localizeOption("style", jobStyle, activeStyles[jobStyle] || { name: jobStyle || "AI" }, job.locale).name;
    const jobStyleName = richStyleName;

    const testing = isTestingMode(ev);
    const adminShortcut = isAdmin(job.userPhone) && !testing;

    let suffix = "";
    if (!adminShortcut) {
        const maxPrints = settings.getForEvent("maxPrints", ev);
        const quotaUnlimited = settings.isUnlimitedQuota(maxPrints);
        const remaining = maxPrints - (usageCache.get(usageKey(job.userPhone, ev)) || 0);
        const unlimited = (isAdmin(job.userPhone) && testing) || quotaUnlimited;
        // Unlimited quota suppresses all count-related suffixes (remaining,
        // lastPortrait). Users never see counts or "last one" notes when
        // quota is effectively infinite.
        if (!quotaUnlimited) {
            if (templateKey === "deliveryPrint") {
                if (remaining > 0 || unlimited) {
                    const unit = job.locale === "pt_BR" ? (remaining === 1 ? "impressão" : "impressões") : (remaining === 1 ? "print" : "prints");
                    suffix = ` ${i18n.t(job.locale, "remainingCount", { remaining, unit }, ev)}`;
                } else if (maxPrints > 1) {
                    suffix = ` ${i18n.t(job.locale, "lastPortrait", {}, ev)}`;
                }
            } else {
                if (remaining <= 0 && !unlimited && maxPrints > 1) {
                    suffix = ` ${i18n.t(job.locale, "lastPortrait", {}, ev)}`;
                }
            }
        }
    }

    const shareLinks = await buildShareMessage(job);
    const adapter = jobAdapter(job);
    const kioskWhatsapp = job.kioskSubmission === true && adapter.name === "whatsapp";
    const eventParam = encodeURIComponent(ev);
    const finalImagePath = `s/${encodeURIComponent(job.filePrefix)}/img?e=${eventParam}`;
    const mmsImagePath = `s/${encodeURIComponent(job.filePrefix)}/mms?e=${eventParam}`;
    const finalImageUrl = job.baseUrl ? `${job.baseUrl}/${finalImagePath}` : null;
    const mmsImageUrl = job.baseUrl ? `${job.baseUrl}/${mmsImagePath}` : null;
    let imageUrl = adapter && adapter.name === "sms" ? mmsImageUrl : finalImageUrl;
    let templateImagePath = finalImagePath;
    const skipMedia = shouldSkipDeliveryMedia(adapter, shareLinks, settings.getForEvent("sharePageOnly", ev));
    const pickupLocation = i18n.resolvePickupLocation(job.locale, settings.getForEvent("pickupLocation", ev));
    let mmsBody = `${i18n.t(job.locale, templateKey, { styleName: jobStyleName, pickupLocation }, ev)}${suffix}${shareLinks}`;
    if (adapter && adapter.name === "whatsapp" && imageUrl) {
        try {
            const selectedMedia = selectWhatsappDeliveryMedia(fs.statSync(jobPaths(job).outputPath).size, {
                finalImageUrl,
                finalImagePath,
                mmsImageUrl,
                mmsImagePath,
            });
            imageUrl = selectedMedia.imageUrl;
            templateImagePath = selectedMedia.templateImagePath;
            if (!imageUrl) {
                mmsBody += oversizedWhatsappImageSuffix(shareLinks, finalImageUrl);
            }
        } catch { /* normal delivery handling reports a missing output */ }
    }
    // Print pickup copy includes an event-specific physical location, while the
    // approved generic delivery card does not. Send it as in-session text.
    const richDelivery = shouldUseRichDelivery({
        templateKey,
        kioskWhatsapp,
        adapterName: adapter.name,
        imageUrl,
        contentSid: settings.getContentSid("delivery", job.locale),
        baseUrl: job.baseUrl,
    });
    const deliveryVars = {
        1: richStyleName,
        2: templateImagePath,
        3: `s/${job.filePrefix}?e=${encodeURIComponent(ev)}`,
    };
    const leadMode = settings.getForEvent("leadCaptureMode", ev);

    let leadSurveyStarted = !kioskWhatsapp && leadMode === "after" && !adminShortcut
        && !leads.isCompleted(job.userPhone, ev)
        && !leads.isActive(job.userPhone);

    if (leadSurveyStarted) {
        const surveyResult = await leads.startSurvey(job.userPhone, job.appPhone, ev, "after", {
            body: mmsBody,
            mediaUrl: skipMedia ? null : imageUrl,
            channel: job.channel,
            templateKey: richDelivery ? "delivery" : null,
            vars: richDelivery ? deliveryVars : null,
            locale: job.locale || "en",
        }, job.locale || "en");
        leadSurveyStarted = !surveyResult || surveyResult.status !== "send_failed";
    }

    if (!leadSurveyStarted) {
        let deliveryResult;
        if (richDelivery) {
            deliveryResult = await messaging.send(job.userPhone, "delivery", deliveryVars, { adapter, locale: job.locale, allowOutOfSession: true });
            if (deliveryResult && deliveryResult.error) {
                deliveryResult = await messaging.send(job.userPhone, "_raw", {}, { _body: mmsBody, mediaUrl: skipMedia ? null : imageUrl, adapter });
            }
        } else {
            deliveryResult = await messaging.send(job.userPhone, "_raw", {}, jobSendOptions(job, { _body: mmsBody, mediaUrl: skipMedia ? null : imageUrl }));
        }
        if (deliveryResult && (deliveryResult.error || deliveryResult.skipped)) {
            throw new Error(deliveryResult.error || "Delivery skipped outside the WhatsApp session");
        }
    }

    // Persist shareUrl to job so share page can use the short link
    if (job.shareUrl && jobDir) {
        await writeJobAsync(path.join(jobDir, filename), job);
    }

    if (!leadSurveyStarted && !kioskWhatsapp) {
        // Send standalone promo after a brief delay
        const promoText = settings.getForEvent("enablePromoMessage", ev) ? settings.getForEvent("promoMessage", ev) : "";
        if (promoText && !adminShortcut) {
            setTimeout(() => {
                if (!contacts.hasMarketingConsent(job.userPhone, ev, adapter.name)) return;
                const hasTemplate = adapter && adapter.name === "whatsapp" && settings.getContentSid("promo", job.locale);
                const send = hasTemplate
                    ? messaging.send(job.userPhone, "promo", {}, { adapter, locale: job.locale, allowOutOfSession: true })
                    : messaging.send(job.userPhone, "_raw", {}, jobSendOptions(job, { _body: promoText, requiresSession: true }));
                send.catch((e) => console.error(`❌ Promo send failed: ${e.message}`));
            }, 15000);
        }

        // NPS survey after last print (skip entirely when quota is unlimited —
        // there is no "last print" to trigger on)
        if (settings.getForEvent("enableNps", ev) && !adminShortcut && !nps.hasCompleted(job.userPhone, ev)) {
            const maxPrintsNps = settings.getForEvent("maxPrints", ev);
            const quotaUnlimited = settings.isUnlimitedQuota(maxPrintsNps);
            const remaining = maxPrintsNps - (usageCache.get(usageKey(job.userPhone, ev)) || 0);
            const unlimited = (isAdmin(job.userPhone) && testing) || quotaUnlimited;
            if (remaining <= 0 && !unlimited) {
                const delay = (settings.getForEvent("npsDelay", ev) || 30) * 1000;
                setTimeout(async () => {
                    const hasRating = adapter && adapter.name === "whatsapp" && settings.getContentSid("rating", job.locale);
                    try {
                        const result = hasRating
                            ? await messaging.send(job.userPhone, "rating", {}, jobSendOptions(job, { locale: job.locale, allowOutOfSession: true }))
                            : await messaging.send(job.userPhone, "_raw", {}, jobSendOptions(job, { _body: i18n.t(job.locale, "npsPrompt", {}, ev) }));
                        if (result && (result.error || result.skipped)) throw new Error(result.error || "out-of-session");
                        nps.markPending(job.userPhone, { locale: job.locale || "en", eventName: ev });
                    } catch (e) {
                        console.error(`❌ NPS SMS failed: ${e.message}`);
                    }
                }, delay);
            }
        }
    }
}

// ── Print completion MMS (shared by local print worker and relay) ────────────

async function sendPrintCompletionMms(job, filename, jobDir) {
    if (job.smsSentAt) return; // SMS already sent via immediate digital delivery
    if (job.kioskSubmission && job.noDelivery) return;
    if (job.kioskSubmission) {
        // Print completion cannot send a second copy. Pending kiosk delivery
        // is retried by its own sweep even if the printer was unavailable.
        const current = await attemptKioskDelivery(job, filename, jobDir === undefined ? DONE_DIR : jobDir);
        if (["accepted", "delivered"].includes(current.kioskDeliveryState)) {
            job.smsSentAt = current.smsSentAt;
        }
        return;
    }
    if (job.inputMode === "voice") {
        if (job.voiceDeliveryKind && job.voiceDeliveryState !== "sent") {
            await attemptVoiceDelivery(filename);
        }
        return;
    }
    // jobDir defaults to DONE_DIR for normal completion; callers from failure
    // paths should pass null to avoid writing a ghost file to the wrong directory
    await sendDigitalDelivery(job, filename, "deliveryPrint", jobDir !== undefined ? jobDir : DONE_DIR);
    job.smsSentAt = Date.now();
}

// ── Manual Review Queue ──────────────────────────────────────────────────────

const _reviewCache = { records: null, byEvent: new Map(), ts: 0, inFlight: null, generation: 0 };
const _reviewFileCache = new Map();
const REVIEW_CACHE_TTL = 10_000;
const REVIEW_SCAN_CONCURRENCY = 12;

function reviewRecord(job) {
    // Review JSON can contain prompts, settings snapshots, and media metadata.
    // Keep only the fields needed to build a queue card in the file index.
    const {
        parentJobId, variantCount, variantId, variantIndex, variantStatus,
        failReason, regenCount, userPhone, style, eventName, reviewAt,
        filePrefix, retries,
    } = job;
    return {
        parentJobId, variantCount, variantId, variantIndex, variantStatus,
        failReason, regenCount, userPhone, style, eventName, reviewAt,
        filePrefix, retries,
        kioskSubmission: job.kioskSubmission === true,
        permanent: job.permanent === true,
        kioskReferencesRequired: job.kioskSubmission === true && kioskRequiresPinnedReferences(job),
        kioskReferenceRequirements: job.kioskSubmission === true ? kioskRequiredReferencePaths(job) : [],
        kioskDeliveryFinal: !!kioskDeliveryBlocksRegeneration(job),
    };
}

async function scanReviewFiles() {
    const locations = [
        { dir: REVIEW_DIR, location: "review" },
        { dir: PENDING_DIR, location: "pending" },
        { dir: GENERATING_DIR, location: "generating" },
    ];
    const lists = await Promise.all(locations.map(async ({ dir, location }) => {
        try {
            const files = (await fsp.readdir(dir)).filter((name) => name.endsWith(".json"));
            // Preserve the original order for review cards with equal timestamps.
            if (location === "review") files.sort();
            return files;
        } catch (error) {
            if (location === "review" && error.code !== "ENOENT") throw error;
            return [];
        }
    }));
    const records = { review: [], pending: [], generating: [] };
    const candidates = [];
    const seen = new Set();
    locations.forEach(({ dir, location }, locationIndex) => {
        const files = lists[locationIndex];
        records[location] = new Array(files.length);
        files.forEach((filename, index) => {
            const filepath = path.join(dir, filename);
            candidates.push({ filepath, filename, location, index });
            seen.add(filepath);
        });
    });

    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(REVIEW_SCAN_CONCURRENCY, candidates.length) }, async () => {
        while (cursor < candidates.length) {
            const { filepath, filename, location, index } = candidates[cursor++];
            try {
                const stat = await fsp.stat(filepath, { bigint: true });
                const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
                const cached = _reviewFileCache.get(filepath);
                let job = cached?.signature === signature ? cached.job : null;
                if (!job) {
                    job = reviewRecord(await readJobAsync(filepath));
                    _reviewFileCache.set(filepath, { signature, job });
                }
                records[location][index] = { ...job, _filename: filename, _location: location };
            } catch {
                // A worker can move a file between readdir and stat/read.
                _reviewFileCache.delete(filepath);
            }
        }
    }));
    for (const filepath of _reviewFileCache.keys()) {
        if (!seen.has(filepath)) _reviewFileCache.delete(filepath);
    }
    for (const { location } of locations) records[location] = records[location].filter(Boolean);
    return records;
}

async function getReviewRecords() {
    if (_reviewCache.records && Date.now() - _reviewCache.ts < REVIEW_CACHE_TTL) {
        return _reviewCache.records;
    }
    if (_reviewCache.inFlight) return _reviewCache.inFlight;
    const task = (async () => {
        // A review action may invalidate the queue while a scan is running.
        // Retry before publishing so that action cannot restore stale cards.
        while (true) {
            const generation = _reviewCache.generation;
            let records;
            try { records = await scanReviewFiles(); }
            catch (error) {
                if (_reviewCache.records) return _reviewCache.records;
                throw error;
            }
            if (generation !== _reviewCache.generation) continue;
            _reviewCache.records = records;
            _reviewCache.byEvent.clear();
            _reviewCache.ts = Date.now();
            return records;
        }
    })();
    _reviewCache.inFlight = task;
    try { return await task; }
    finally { if (_reviewCache.inFlight === task) _reviewCache.inFlight = null; }
}

async function getReviewQueue(eventFilter) {
    const cacheKey = eventFilter || "all";
    try {
        const records = await getReviewRecords();
        if (_reviewCache.byEvent.has(cacheKey)) return _reviewCache.byEvent.get(cacheKey);
        // Load all sibling/singleton jobs from REVIEW_DIR (the primary source).
        const singletons = [];
        const variantGroups = new Map(); // parentJobId -> [{ ...job, _filename, _location: "review" }]
        for (const job of records.review) {
            if (eventFilter && eventFilter !== "all" && job.eventName !== eventFilter) continue;
            if (job.kioskSubmission && ["REJECTED", "SUPERSEDED"].includes(job.variantStatus)) continue;
            if (job.parentJobId) {
                if (!variantGroups.has(job.parentJobId)) variantGroups.set(job.parentJobId, []);
                variantGroups.get(job.parentJobId).push(job);
            } else {
                singletons.push(job);
            }
        }

        // ALSO scan PENDING_DIR and GENERATING_DIR for variant siblings whose
        // parent is already partially surfaced. This is what makes per-variant
        // Regen show a loading placeholder instead of hiding the entire card:
        // the regenerating variant lives temporarily in pending/generating, but
        // we still want the card to show its other siblings.
        for (const job of [...records.pending, ...records.generating]) {
            if (!job.parentJobId) continue; // only siblings — plain pending jobs aren't review items
            if (eventFilter && eventFilter !== "all" && job.eventName !== eventFilter) continue;
            if (job.kioskSubmission && ["REJECTED", "SUPERSEDED"].includes(job.variantStatus)) continue;
            // Only surface if the parent already has at least one sibling in review.
            // This avoids showing cards that haven't had their first reviewable
            // variant land yet (initial fan-out still in progress).
            if (!variantGroups.has(job.parentJobId)) continue;
            variantGroups.get(job.parentJobId).push(job);
        }

        const result = [];

        // Singletons render as legacy single-variant cards (parentJobId absent on response)
        for (const job of singletons) {
            result.push({
                filename: job._filename,
                userPhone: job.userPhone,
                style: job.style,
                eventName: job.eventName,
                reviewAt: job.reviewAt,
                filePrefix: job.filePrefix,
                retries: job.retries || 0,
            });
        }

        // Variant groups: one parent-level card each. Card surfaces once at
        // least one sibling has reached terminal state (READY or FAILED) in
        // REVIEW_DIR. Slots for siblings currently mid-regen (in pending or
        // generating) render as REGENERATING placeholders so the reviewer sees
        // the card continuously during a regen rather than having it disappear.
        for (const [parentJobId, siblings] of variantGroups) {
            if (siblings.some((s) => s.kioskSubmission)
                && (hasKioskParentDecision(parentJobId) || hasKioskGroupPublication(parentJobId))) continue;
            const expectedCount = siblings[0].variantCount || siblings.length;
            // Hide the card only during the INITIAL fan-out — when no siblings
            // have reached REVIEW_DIR yet. Once any sibling is in review, show
            // the card with placeholders for the others.
            const anyInReview = siblings.some((s) => s._location === "review");
            if (!anyInReview) continue;
            // If the total sibling count doesn't match expected (e.g., a
            // variant failed and got deleted permanently outside of the normal
            // regen flow), still render with what we have.
            const variants = siblings
                .sort((a, b) => (a.variantIndex || 0) - (b.variantIndex || 0))
                .map((v) => ({
                    variantId: v.variantId || v.filePrefix,
                    variantIndex: v.variantIndex,
                    filename: v._filename,
                    filePrefix: v.filePrefix,
                    // A sibling in REVIEW_DIR is terminal (READY / FAILED /
                    // SUPERSEDED). A sibling in pending/generating is still
                    // in flight — "REGENERATING" only if the reviewer
                    // actually clicked Regen (regenCount > 0), otherwise
                    // it's the initial fan-out still completing and we
                    // should say so. The two states use different
                    // placeholder copy in the UI.
                    status: v._location === "review"
                        ? (v.variantStatus || "READY")
                        : ((v.regenCount || 0) > 0 ? "REGENERATING" : "GENERATING"),
                    failReason: v.failReason || null,
                    generatedAt: v.reviewAt || null,
                    regenCount: v.regenCount || 0,
                    canRegenerate: !v.kioskSubmission || (!v.permanent && !v.kioskDeliveryFinal
                        && hasKioskPrivateInput(v) && hasKioskPinnedReferences(v)),
                }));

            const reviewSiblings = siblings.filter((s) => s._location === "review");
            const first = reviewSiblings[0] || siblings[0];
            const kioskGroup = siblings.some((s) => s.kioskSubmission);
            const referencesRequired = siblings.some((s) => s.kioskReferencesRequired);
            const canReanalyze = !kioskGroup || (siblings.some((s) => s.kioskSubmission && hasKioskPrivateInput(s))
                && (!referencesRequired || siblings.some((s) => s.kioskSubmission
                    && hasKioskPinnedReferences(s))));
            const earliestReviewAt = Math.min(...siblings.map((s) => s.reviewAt || Infinity));
            const regenLimit = Math.max(1, Math.min(5,
                Number(settings.getForEvent("regenerationLimit", first.eventName)) || 2));
            result.push({
                parentJobId,
                userPhone: first.userPhone,
                style: first.style,
                eventName: first.eventName,
                reviewAt: Number.isFinite(earliestReviewAt) ? earliestReviewAt : null,
                filePrefix: first.filePrefix,
                variantCount: expectedCount,
                regenerationLimit: regenLimit,
                canReanalyze,
                variants,
            });
        }

        result.sort((a, b) => (a.reviewAt || 0) - (b.reviewAt || 0));

        _reviewCache.byEvent.set(cacheKey, result);

        return result;
    } catch {
        return _reviewCache.byEvent.get(cacheKey) || [];
    }
}

function invalidateReviewCache() {
    _reviewCache.ts = 0;
    _reviewCache.generation++;
    _reviewCache.byEvent.clear();
}

async function approveJob(filename) {
    invalidateReviewCache();
    const reviewPath = path.join(REVIEW_DIR, filename);
    if (!fs.existsSync(reviewPath)) throw new Error("Job not found in review queue");

    const job = await readJobAsync(reviewPath);
    const now = Date.now();
    job.stateChangedAt = now;
    job.approvedAt = now;

    if (job.kioskSubmission) {
        // Publish can be interrupted before the queue file moves out of
        // REVIEW. Record the operator's approval first so a post-route sweep
        // can safely resume even when the final PNG was not written yet.
        job.kioskApprovalStartedAt ||= now;
        await writeJobAsync(reviewPath, job);
    }

    // Move staged images to final downloads directory
    await moveStagedToFinal(job);

    const ev = job.eventName;

    if (jobEventSetting(job, "enablePrinting")) {
        job.readyAt = now;

        if (job.inputMode === "voice" || jobEventSetting(job, "immediateDigitalDelivery")) {
            job.digitalDeliveryPendingAt = Date.now();
        }
        markVoiceDeliveryPending(job, "result");

        await writeJobAsync(reviewPath, job);
        await renameWithRetry(reviewPath, path.join(READY_DIR, filename));
        console.log(`✅ Review approved (to print): ${filename}`);

        // Send digital copy immediately if enabled (don't wait for print)
        if (job.digitalDeliveryPendingAt) {
            const readyPath = path.join(READY_DIR, filename);
            try {
                await sendDigitalDelivery(job, filename, "deliveryDigital", READY_DIR);
                if (job.inputMode !== "voice" && !job.kioskSubmission) {
                    job.smsSentAt = Date.now();
                    delete job.digitalDeliveryPendingAt;
                    if (fs.existsSync(readyPath)) await writeJobAsync(readyPath, job);
                }
            } catch (smsErr) {
                console.error(`❌ Immediate digital delivery failed for ${filename}: ${smsErr.message}`);
                if (job.inputMode !== "voice" && !job.kioskSubmission) {
                    delete job.digitalDeliveryPendingAt;
                    delete job.smsSentAt;
                    if (fs.existsSync(readyPath)) await writeJobAsync(readyPath, job).catch(() => {});
                }
            }
        }
    } else {
        job.completedAt = now;
        markVoiceDeliveryPending(job, "result");
        await writeJobAsync(reviewPath, job);
        await renameWithRetry(reviewPath, path.join(DONE_DIR, filename));
        console.log(`✅ Review approved (digital delivery): ${filename}`);

        try {
            await sendDigitalDelivery(job, filename, "deliveryDigital", DONE_DIR);
        } catch (smsErr) {
            console.error(`❌ Digital delivery failed for ${filename}: ${smsErr.message}`);
        }
    }
}

async function rejectJob(filename, message, reanalyze, feedback) {
    invalidateReviewCache();
    const reviewPath = path.join(REVIEW_DIR, filename);
    if (!fs.existsSync(reviewPath)) throw new Error("Job not found in review queue");

    const job = await readJobAsync(reviewPath);
    job.stateChangedAt = Date.now();
    delete job.reviewAt;

    // Kiosk retries need the privately staged selfie and pinned references;
    // the upload URL is intentionally unavailable to the public pipeline.
    await cleanupStaged(job, { preserveSource: reanalyze && job.kioskSubmission });

    if (reanalyze) {
        // Reject + Re-analyze: re-queue for generation with fresh scene analysis
        job.retries = (job.retries || 0) + 1;
        delete job.cachedScene;
        if (feedback) {
            job.reviewFeedback = feedback;
        } else {
            delete job.reviewFeedback;
        }

        if (job.retries >= MAX_RETRIES) {
            job.failReason = "review_rejected";
            job.permanent = true;
            markKioskGenerationFailed(job, job.failReason);
            if (job.kioskSubmission) await cleanupStaged(job);
            decrementUsage(job.userPhone, job.eventName);
            markVoiceDeliveryPending(job, "failure");
            await writeJobAsync(reviewPath, job);
            await renameWithRetry(reviewPath, path.join(FAILED_DIR, filename));
            console.log(`💀 Review rejected, max retries exceeded: ${filename}`);
            if (!job.noDelivery && !job.kioskSubmission && job.inputMode !== "voice") {
                messaging.send(job.userPhone, "_raw", {}, jobSendOptions(job, { _body: i18n.t(job.locale, "reviewFailed", {}, job.eventName) }))
                    .catch((err) => console.error(`❌ Rejection notification failed: ${err.message}`));
            }
        } else {
            await writeJobAsync(reviewPath, job);
            await renameWithRetry(reviewPath, path.join(PENDING_DIR, filename));
            console.log(`🔄 Review rejected, re-queued for re-analysis (retry ${job.retries}): ${filename}`);
        }
    } else {
        // Reject / Reject + Notify: kill the job
        job.failReason = "review_rejected";
        job.permanent = true;
        markKioskGenerationFailed(job, job.failReason);
        decrementUsage(job.userPhone, job.eventName);
        markVoiceDeliveryPending(job, "failure");
        await writeJobAsync(reviewPath, job);
        await renameWithRetry(reviewPath, path.join(FAILED_DIR, filename));
        console.log(`🗑️  Review rejected (discarded): ${filename}`);
        if (message && !job.noDelivery && !job.kioskSubmission && job.inputMode !== "voice") {
            messaging.send(job.userPhone, "_raw", {}, jobSendOptions(job, { _body: i18n.t(job.locale, "reviewReject", {}, job.eventName) }))
                .catch((err) => console.error(`❌ Review SMS failed: ${err.message}`));
        }
    }
}

// ── Multi-variant Review Operations ─────────────────────────────────────────

const terminalVariantDecisions = new Map();
const TERMINAL_VARIANT_CACHE_MAX = 10_000;
const parentRejectEffectsApplied = new Set();
const kioskRejectDecisionsRecordedInThisProcess = new Set();
const kioskReanalysisLocks = new Map();
const kioskReanalysisPreparations = new Map();
const parentReviewActionTails = new Map();

async function withParentReviewAction(parentJobId, action) {
    // Claim the parent synchronously, before any queue read or durable write.
    // A second pick/reject/reanalysis then re-checks persisted state only
    // after the first action has finished.
    const previous = parentReviewActionTails.get(parentJobId);
    let release;
    const finished = new Promise((resolve) => { release = resolve; });
    parentReviewActionTails.set(parentJobId, finished);
    if (previous) await previous;
    try { return await action(); }
    finally {
        release();
        if (parentReviewActionTails.get(parentJobId) === finished) {
            parentReviewActionTails.delete(parentJobId);
        }
    }
}

function kioskRejectDecisionPath(parentJobId) {
    const key = createHash("sha256").update(parentJobId).digest("hex");
    return path.join(KIOSK_PARENT_DECISION_DIR, `${key}.json`);
}

function hasKioskParentDecision(parentJobId) {
    return fs.existsSync(kioskRejectDecisionPath(parentJobId));
}

function readKioskParentDecision(parentJobId) {
    try { return JSON.parse(fs.readFileSync(kioskRejectDecisionPath(parentJobId), "utf8")); }
    catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

async function recordKioskRejectDecision(parentJobId, job, releaseUsageInThisProcess) {
    const decisionPath = kioskRejectDecisionPath(parentJobId);
    if (fs.existsSync(decisionPath)) return;
    await fsp.mkdir(KIOSK_PARENT_DECISION_DIR, { recursive: true });
    await atomicWriteFile(decisionPath, JSON.stringify({
        parentJobId, userPhone: job.userPhone, eventName: job.eventName,
        action: "reject", createdAt: Date.now(),
    }), { tempDir: QUEUE_TMP_DIR });
    if (releaseUsageInThisProcess) kioskRejectDecisionsRecordedInThisProcess.add(parentJobId);
    invalidateReviewCache();
}

async function clearKioskRejectDecisionIfSettled(parentJobId) {
    if ((await _findVariantSiblings(parentJobId, { strict: true })).length > 0) return;
    await fsp.unlink(kioskRejectDecisionPath(parentJobId)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
    });
    kioskRejectDecisionsRecordedInThisProcess.delete(parentJobId);
    invalidateReviewCache();
}

function variantDecisionKey(job) {
    return job.variantId || job.filePrefix;
}

function rememberTerminalVariantDecision(job, variantStatus, failReason, stateChangedAt) {
    const key = variantDecisionKey(job);
    if (!key) return;
    if (terminalVariantDecisions.size >= TERMINAL_VARIANT_CACHE_MAX && !terminalVariantDecisions.has(key)) {
        terminalVariantDecisions.delete(terminalVariantDecisions.keys().next().value);
    }
    terminalVariantDecisions.set(key, { variantStatus, failReason, stateChangedAt });
}

function applyTerminalVariantDecision(job) {
    if (["SUPERSEDED", "REJECTED"].includes(job.variantStatus)) return true;
    if (job.kioskSubmission && job.parentJobId) {
        const decision = readKioskParentDecision(job.parentJobId);
        if (decision?.action === "reject" || decision?.action === "reanalyze") {
            Object.assign(job, {
                variantStatus: decision.action === "reject" ? "REJECTED" : "SUPERSEDED",
                failReason: decision.action === "reject" ? "review_rejected" : "reanalyzed",
                permanent: true, stateChangedAt: Date.now(),
            });
            return true;
        }
    }
    const decision = terminalVariantDecisions.get(variantDecisionKey(job));
    if (!decision) return false;
    Object.assign(job, decision, { permanent: true });
    return true;
}

// Find every sibling of a parent job, no matter where in the pipeline it is.
// A variant can legitimately be in:
//   REVIEW_DIR     — ready, awaiting reviewer decision
//   PENDING_DIR    — queued for generation (e.g. regen just requested)
//   GENERATING_DIR — actively being generated by the worker right now
// Callers that act on the parent (pickVariant, regenerateVariant, rejectParent)
// must see siblings in all three so they can't miss an in-flight regen and
// produce a ghost review card when it finishes.
async function _findVariantSiblings(parentJobId, { strict = false } = {}) {
    const out = [];
    const dirs = [
        { dir: REVIEW_DIR, location: "review" },
        { dir: PENDING_DIR, location: "pending" },
        { dir: GENERATING_DIR, location: "generating" },
    ];
    for (const { dir, location } of dirs) {
        try {
            const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
            for (const filename of files) {
                try {
                    const job = await readJobAsync(path.join(dir, filename));
                    if (job.parentJobId === parentJobId) {
                        out.push({ filename, job, location });
                    }
                } catch (error) {
                    if (strict && error.code !== "ENOENT") throw error;
                }
            }
        } catch (error) {
            if (strict && error.code !== "ENOENT") throw error;
        }
    }
    return out;
}

// Mark a sibling as terminal (superseded / rejected / reanalyzed) no matter
// where it is in the pipeline. Sibling location matters:
//   review    — safe to move out of REVIEW_DIR → FAILED_DIR
//   pending   — queued but not claimed; move before the worker can pick it up
//   generating— worker owns the file; only flip the flag in place. The
//              worker's processGeneration success path re-reads the job and
//              drops the output when variantStatus === "SUPERSEDED".
// Staged output is cleaned up for review/pending (where no one is actively
// writing to it) but left alone for generating (the worker is).
async function _markSiblingTerminal(sib, failReason, now) {
    // "SUPERSEDED" covers both picked-another-variant (failReason="superseded")
    // and re-analyze-the-parent (failReason="reanalyzed") — the variant still
    // exists in lineage, just no longer relevant. "REJECTED" is reserved for
    // the reviewer explicitly discarding all variants (failReason=
    // "review_rejected").
    const variantStatus = failReason === "review_rejected" ? "REJECTED" : "SUPERSEDED";
    rememberTerminalVariantDecision(sib.job, variantStatus, failReason, now);
    Object.assign(sib.job, { variantStatus, failReason, permanent: true, stateChangedAt: now });
    markKioskGenerationFailed(sib.job, failReason);

    let handled = false;
    // Re-scan briefly because a generation worker can move pending ->
    // generating or generating -> review while the parent decision is being
    // applied. The in-memory decision stops delivery; these passes persist it
    // at whichever path ultimately owns the job.
    for (let pass = 0; pass < 5; pass++) {
        for (const { dir, active } of [
            { dir: REVIEW_DIR, active: false },
            { dir: PENDING_DIR, active: false },
            { dir: GENERATING_DIR, active: true },
        ]) {
            const src = path.join(dir, sib.filename);
            if (!fs.existsSync(src)) continue;
            let current;
            try {
                current = await readClaimedJobWithRetry(src, 3);
            } catch (err) {
                if (err.code === "ENOENT") continue;
                throw err;
            }
            Object.assign(current, { variantStatus, failReason, permanent: true, stateChangedAt: now });
            markKioskGenerationFailed(current, failReason);
            if (sib.job.voiceDeliveryKind === "failure") markVoiceDeliveryPending(current, "failure");
            await writeJobAsync(src, current);
            handled = true;
            if (active) continue;
            await cleanupStaged(current);
            await renameWithRetry(src, path.join(FAILED_DIR, sib.filename)).catch((err) => {
                if (err.code !== "ENOENT") throw err;
            });
        }
        if (pass < 4) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (handled || fs.existsSync(path.join(FAILED_DIR, sib.filename))) return;
    const err = new Error(`Variant moved while applying terminal decision: ${sib.filename}`);
    err.code = "ENOENT";
    throw err;
}

// Approve one variant of a multi-variant review card. Promotes the chosen
// variant through the normal approve path and supersedes its siblings (staged
// files deleted, job files moved to FAILED_DIR with failReason="superseded").
// Usage is NOT decremented for superseded siblings — the parent counts once.
async function pickVariant(parentJobId, variantId) {
    return withParentReviewAction(parentJobId, () => applyVariantPick(parentJobId, variantId));
}

async function applyVariantPick(parentJobId, variantId) {
    invalidateReviewCache();
    if (hasKioskParentDecision(parentJobId) || hasKioskGroupPublication(parentJobId)) {
        const err = new Error("This kiosk portrait group already has a pending decision or publication");
        err.code = "ALREADY_DECIDED";
        throw err;
    }
    const siblings = await _findVariantSiblings(parentJobId);
    if (siblings.length === 0) {
        const err = new Error("Parent job not found or already decided");
        err.code = "ALREADY_DECIDED";
        throw err;
    }
    const chosen = siblings.find((s) => (s.job.variantId || s.job.filePrefix) === variantId);
    if (!chosen) {
        const err = new Error("Variant not found in parent job");
        err.code = "VARIANT_NOT_FOUND";
        throw err;
    }
    if (chosen.job.variantStatus === "FAILED") {
        const err = new Error("Cannot pick a failed variant");
        err.code = "VARIANT_FAILED";
        throw err;
    }
    if (chosen.location !== "review") {
        // The chosen variant is mid-regeneration or freshly re-queued. Its
        // staged output doesn't exist yet (or is partial), so we can't
        // promote it. The reviewer can pick it once the regen lands in
        // REVIEW_DIR.
        const err = new Error("Cannot approve a variant that is still regenerating");
        err.code = "VARIANT_NOT_READY";
        throw err;
    }
    if (chosen.job.kioskSubmission && siblings.some((sib) =>
        sib.filename !== chosen.filename && sib.job.kioskApprovalStartedAt)) {
        const err = new Error("Another kiosk portrait has already been selected");
        err.code = "ALREADY_DECIDED";
        throw err;
    }

    // Supersede siblings first. Do this BEFORE promoting the winner so that
    // any concurrent call sees an empty sibling set.
    const now = Date.now();
    if (chosen.job.kioskSubmission && !chosen.job.kioskApprovalStartedAt) {
        // A crash after retiring the other variants but before approveJob
        // begins still leaves a durable record of the selected portrait.
        chosen.job.kioskApprovalStartedAt = now;
        await writeJobAsync(path.join(REVIEW_DIR, chosen.filename), chosen.job);
    }
    for (const sib of siblings) {
        if (sib.filename === chosen.filename) continue;
        try {
            await _markSiblingTerminal(sib, "superseded", now);
        } catch (err) {
            if (chosen.job.kioskSubmission) throw err;
            console.error(`⚠️  Failed to supersede sibling ${sib.filename}: ${err.message}`);
        }
    }

    // Promote the winner via the standard approve flow
    if (chosen.job.kioskSubmission && hasOutputFile(chosen.job)) {
        await completePublishedOutput(chosen.job);
    }
    await approveJob(chosen.filename);
    if (chosen.job.kioskSubmission) {
        await rememberKioskResultPointer(siblings, chosen.job.filePrefix);
    }
    console.log(`🏆 Variant picked: ${chosen.filename} (parent=${parentJobId})`);

    // Audit: record which variant won + decision latency + regen counts.
    // Training data for future AI-picks-best-of-N.
    const pickedJob = chosen.job;
    const timeToDecisionMs = pickedJob.reviewAt ? (now - pickedJob.reviewAt) : null;
    const regenerationsPerVariant = {};
    let regenerationsUsed = 0;
    for (const sib of siblings) {
        const idx = sib.job.variantIndex || 0;
        const count = sib.job.regenCount || 0;
        regenerationsPerVariant["v" + idx] = count;
        regenerationsUsed += count;
    }
    audit.logEvent("variant.pick", pickedJob.eventName, {
        parentJobId,
        pickedVariantId: chosen.job.variantId || chosen.job.filePrefix,
        pickedVariantIndex: chosen.job.variantIndex,
        siblingVariantIds: siblings
            .filter((s) => s.filename !== chosen.filename)
            .map((s) => s.job.variantId || s.job.filePrefix),
        variantCount: siblings[0].job.variantCount || siblings.length,
        style: pickedJob.style,
        brand: pickedJob.brand || null,
        background: pickedJob.background || null,
        timeToDecisionMs,
        regenerationsUsed,
        regenerationsPerVariant,
    }).catch(() => {});
}

// Regenerate a single variant of a multi-variant review card. Deletes the
// staged output, clears failure/cached state, and moves the job back to
// PENDING_DIR so the generation worker picks it up. Siblings are untouched.
// Enforces per-variant regenerationLimit to prevent runaway loops.
async function regenerateVariant(parentJobId, variantId) {
    return withParentReviewAction(parentJobId, () => applyVariantRegeneration(parentJobId, variantId));
}

async function applyVariantRegeneration(parentJobId, variantId) {
    invalidateReviewCache();
    if (hasKioskParentDecision(parentJobId) || hasKioskGroupPublication(parentJobId)) {
        const err = new Error("This kiosk portrait group already has a pending decision or publication");
        err.code = "ALREADY_DECIDED";
        throw err;
    }
    const siblings = await _findVariantSiblings(parentJobId);
    const target = siblings.find((s) => (s.job.variantId || s.job.filePrefix) === variantId);
    if (!target) {
        const err = new Error("Variant not found in review queue");
        err.code = "VARIANT_NOT_FOUND";
        throw err;
    }
    if (target.location !== "review") {
        // The variant is already being regenerated — don't stack a second
        // regen on top of an in-flight one. The reviewer can regen again
        // once the current pass lands in REVIEW_DIR.
        const err = new Error("Variant is already regenerating");
        err.code = "VARIANT_ALREADY_REGENERATING";
        throw err;
    }

    const src = path.join(REVIEW_DIR, target.filename);
    const job = target.job;

    if (job.kioskSubmission && job.permanent) {
        const err = new Error("This photo cannot be regenerated; ask the guest to take a new selfie");
        err.code = "VARIANT_PERMANENT_FAILURE";
        throw err;
    }
    if (kioskDeliveryBlocksRegeneration(job)) {
        const err = new Error("This portrait has a final delivery result and cannot be regenerated");
        err.code = "VARIANT_DELIVERY_FINAL";
        throw err;
    }
    if (job.kioskSubmission && (!hasKioskPrivateInput(job) || !hasKioskPinnedReferences(job))) {
        const err = new Error("The private selfie or pinned references are no longer available for regeneration");
        err.code = "KIOSK_SOURCE_MISSING";
        throw err;
    }

    const limit = Math.max(1, Math.min(5,
        Number(settings.getForEvent("regenerationLimit", job.eventName)) || 2));
    const usedSoFar = job.regenCount || 0;
    if (usedSoFar >= limit) {
        const err = new Error("Regeneration limit reached for this variant");
        err.code = "REGEN_LIMIT_REACHED";
        throw err;
    }

    await cleanupStaged(job, { preserveSource: job.kioskSubmission });
    resetKioskDeliveryForRegeneration(job);
    delete job.cachedScene;
    delete job.failReason;
    delete job.permanent;
    delete job.variantStatus;
    delete job.reviewAt;
    job.retries = 0;
    job.regenCount = usedSoFar + 1;
    job.stateChangedAt = Date.now();

    await writeJobAsync(src, job);
    await renameWithRetry(src, path.join(PENDING_DIR, target.filename));
    console.log(`🔄 Variant regenerate requested: ${target.filename} (${job.regenCount}/${limit})`);

    audit.logEvent("variant.regenerate", job.eventName, {
        parentJobId,
        variantId: job.variantId || job.filePrefix,
        variantIndex: job.variantIndex,
        regenerationIndex: job.regenCount,
        regenerationLimit: limit,
    }).catch(() => {});
}

async function resolveReanalysisOutputProfile(siblings) {
    const firstJob = siblings[0].job;
    let outputProfile = null;
    for (const sib of siblings) {
        if (sib.job.outputProfile) {
            outputProfile = { ...sib.job.outputProfile };
            break;
        }
    }
    if (!outputProfile) {
        for (const sib of siblings) {
            const stagedOutput = jobPaths(sib.job, { staged: true }).outputPath;
            const finalOutput = jobPaths(sib.job).outputPath;
            for (const outputPath of [stagedOutput, finalOutput]) {
                if (!fs.existsSync(outputPath)) continue;
                try {
                    const metadata = await sharp(outputPath).metadata();
                    outputProfile = settings.getOutputProfileForDimensions(
                        metadata.width,
                        metadata.height,
                        firstJob.eventName,
                    );
                    break;
                } catch { /* try the next output path */ }
            }
            if (outputProfile) break;
        }
    }
    // Jobs old enough to lack a profile were portrait-only. If their image
    // is also unavailable, preserve that historical 5x7 portrait default.
    return outputProfile || settings.getOutputProfileForDimensions(1500, 2100, firstJob.eventName);
}

async function prepareKioskReanalysis(parentJobId, siblings, feedback, now) {
    if (kioskReanalysisPreparations.has(parentJobId)) return kioskReanalysisPreparations.get(parentJobId);
    const operation = (async () => {
        const existing = readKioskParentDecision(parentJobId);
        if (existing?.action === "reanalyze") return existing;
        if (existing) {
            const err = new Error("This kiosk portrait group already has a pending decision");
            err.code = "ALREADY_DECIDED";
            throw err;
        }
        return prepareNewKioskReanalysis(parentJobId, siblings, feedback, now);
    })().finally(() => kioskReanalysisPreparations.delete(parentJobId));
    kioskReanalysisPreparations.set(parentJobId, operation);
    return operation;
}

async function prepareNewKioskReanalysis(parentJobId, siblings, feedback, now) {
    const firstJob = siblings[0].job;
    const outputProfile = await resolveReanalysisOutputProfile(siblings);
    const source = siblings.map((sib) => jobPaths(sib.job, { staged: true }).inputPath)
        .find((candidate) => fs.existsSync(candidate));
    if (!source) throw new Error("Kiosk source selfie is missing for re-analysis");
    const sourceBytes = await fsp.readFile(source);
    const referenceOwner = siblings.find((sib) =>
        fs.existsSync(kioskReferenceDir(sib.job)) && hasKioskPinnedReferences(sib.job));
    const referenceSource = referenceOwner ? kioskReferenceDir(referenceOwner.job) : null;
    if (kioskRequiresPinnedReferences(firstJob) && !referenceSource) {
        throw new Error("Pinned kiosk references are missing for re-analysis");
    }

    const newParentId = `${formatTimestamp(now)}_${randomUUID().replace(/-/g, "")}`;
    const variantCount = firstJob.variantCount || siblings.length;
    const jobs = Array.from({ length: variantCount }, (_, index) => {
        const variantPrefix = `${newParentId}-v${index + 1}`;
        return {
            imageUrl: firstJob.imageUrl,
            messageSid: `${firstJob.messageSid}-reanalyze-${now}`,
            userPhone: firstJob.userPhone,
            appPhone: firstJob.appPhone,
            channel: firstJob.channel || null,
            apiSubmission: firstJob.apiSubmission || undefined,
            kioskSubmission: true,
            kioskEmail: firstJob.kioskEmail || undefined,
            kioskRequestDigest: firstJob.kioskRequestDigest || undefined,
            requestId: firstJob.requestId || undefined,
            consentedAt: firstJob.consentedAt || undefined,
            whatsappOptInAt: firstJob.whatsappOptInAt || undefined,
            kioskEventSnapshot: firstJob.kioskEventSnapshot
                ? plainSnapshot(firstJob.kioskEventSnapshot) : undefined,
            kioskUsageId: firstJob.kioskUsageId || firstJob.requestId || firstJob.reanalyzedFrom
                || firstJob.parentJobId || firstJob.filePrefix,
            kioskDeliveryState: "pending", kioskDeliveryAttempts: 0,
            uploadedInputFile: firstJob.uploadedInputFile || undefined,
            noDelivery: firstJob.noDelivery || undefined,
            style: firstJob.style, baseUrl: firstJob.baseUrl || "",
            background: firstJob.background || null, brand: firstJob.brand || null,
            locale: firstJob.locale || "en", styleName: firstJob.styleName,
            eventName: firstJob.eventName,
            retries: 0, createdAt: now, pendingAt: now, stateChangedAt: now,
            filePrefix: variantPrefix, parentJobId: newParentId, variantId: variantPrefix,
            variantIndex: index + 1, variantCount,
            reanalyzedFrom: parentJobId, reviewFeedback: feedback || undefined,
            outputProfile: { ...outputProfile },
            ...(firstJob.adminGenerated ? { adminGenerated: true } : {}),
        };
    });
    const decision = {
        action: "reanalyze", parentJobId, newParentId, jobs,
        oldSiblingFilenames: siblings.map((sib) => sib.filename),
        eventName: firstJob.eventName, feedback: feedback || "", createdAt: now,
    };
    let decisionRecorded = false;
    try {
        // New private assets are complete before old review cards are retired.
        // Once the decision is durable, a restart can safely publish every
        // replacement even if the process dies after publishing only v1.
        for (const job of jobs) {
            await atomicWriteFile(jobPaths(job, { staged: true }).inputPath, sourceBytes);
            if (referenceSource) {
                await fsp.cp(referenceSource, kioskReferenceDir(job), { recursive: true });
            }
        }
        await fsp.mkdir(KIOSK_PARENT_DECISION_DIR, { recursive: true });
        await atomicWriteFile(kioskRejectDecisionPath(parentJobId), JSON.stringify(decision),
            { tempDir: QUEUE_TMP_DIR });
        decisionRecorded = true;
        await ensureKioskReanalysisGroupMarker(decision);
    } finally {
        if (!decisionRecorded) {
            for (const job of jobs) await cleanupStaged(job).catch(() => {});
        }
    }
    invalidateReviewCache();
    return decision;
}

async function ensureKioskReanalysisGroupMarker(decision) {
    const markerPath = kioskGroupPublicationPath(decision.newParentId);
    if (fs.existsSync(markerPath)) return;
    await fsp.mkdir(KIOSK_GROUP_PUBLICATION_DIR, { recursive: true });
    await atomicWriteFile(markerPath, JSON.stringify({
        kind: "reanalyze", groupId: decision.newParentId,
        oldParentId: decision.parentJobId, jobs: decision.jobs,
        createdAt: decision.createdAt,
    }), { tempDir: QUEUE_TMP_DIR });
}

async function completeKioskReanalysis(decision) {
    const decisionPath = kioskRejectDecisionPath(decision.parentJobId);
    if (kioskReanalysisLocks.has(decisionPath)) return kioskReanalysisLocks.get(decisionPath);
    const operation = (async () => {
        await ensureKioskReanalysisGroupMarker(decision);
        const siblings = await _findVariantSiblings(decision.parentJobId);
        for (const sib of siblings) await _markSiblingTerminal(sib, "reanalyzed", decision.createdAt);
        const remaining = await _findVariantSiblings(decision.parentJobId, { strict: true });
        if (remaining.some((sib) => sib.job.variantStatus !== "SUPERSEDED")) {
            throw new Error(`Kiosk reanalysis is incomplete for ${decision.parentJobId}`);
        }

        let published = 0;
        try {
            await fsp.mkdir(PENDING_DIR, { recursive: true });
            for (const job of decision.jobs) {
                const filename = `${job.filePrefix}.json`;
                if (kioskJobPath(filename)) continue;
                if (!hasKioskPrivateInput(job) || !hasKioskPinnedReferences(job)) {
                    throw new Error(`Kiosk replacement source is missing for ${job.filePrefix}`);
                }
                writeJob(path.join(PENDING_DIR, filename), job);
                published++;
            }
            if (!decision.jobs.every((job) => kioskJobPath(`${job.filePrefix}.json`))) {
                throw new Error(`Kiosk replacement group is incomplete for ${decision.newParentId}`);
            }
            for (const filename of decision.oldSiblingFilenames) {
                const oldPath = kioskJobPath(filename);
                if (!oldPath) continue;
                let oldJob;
                try { oldJob = await readJobAsync(oldPath); }
                catch (error) {
                    if (error.code === "ENOENT") continue;
                    throw error;
                }
                if (oldJob.kioskResultPrefix === decision.jobs[0].filePrefix) continue;
                oldJob.kioskResultPrefix = decision.jobs[0].filePrefix;
                await writeJobAsync(oldPath, oldJob);
            }
            await fsp.unlink(kioskGroupPublicationPath(decision.newParentId)).catch((error) => {
                if (error.code !== "ENOENT") throw error;
            });
            // Remove the new group's visibility hold first. Every replacement
            // now exists, so a later parent-record cleanup failure must not
            // keep the finished group hidden from review.
            await fsp.unlink(decisionPath).catch((error) => {
                if (error.code !== "ENOENT") throw error;
            });
            invalidateReviewCache();
            console.log(`🔄 Re-analyzed: ${decision.parentJobId} → ${decision.newParentId} (${decision.jobs.length} new variants)`);
            audit.logEvent("parent.reanalyze", decision.eventName, {
                oldParentJobId: decision.parentJobId, newParentJobId: decision.newParentId,
                variantCount: decision.jobs.length, feedback: decision.feedback,
                style: decision.jobs[0].style, brand: decision.jobs[0].brand || null,
            }).catch(() => {});
        } finally {
            if (published > 0) await buildUsageCache();
        }
    })().finally(() => kioskReanalysisLocks.delete(decisionPath));
    kioskReanalysisLocks.set(decisionPath, operation);
    return operation;
}

// Reject an entire multi-variant card. If reanalyze=true, a fresh set of
// variants is queued (new parentJobId); the old siblings are superseded.
// Usage is decremented ONCE at the parent level.
async function rejectParent(parentJobId, message, reanalyze, feedback) {
    return withParentReviewAction(parentJobId,
        () => applyParentRejection(parentJobId, message, reanalyze, feedback));
}

async function applyParentRejection(parentJobId, message, reanalyze, feedback) {
    invalidateReviewCache();
    if (hasKioskGroupPublication(parentJobId)) {
        const err = new Error("This kiosk portrait group is still being published");
        err.code = "ALREADY_DECIDED";
        throw err;
    }
    const existingDecision = readKioskParentDecision(parentJobId);
    if (existingDecision?.action === "reanalyze") {
        if (!reanalyze) {
            const err = new Error("This kiosk portrait group is already being reanalyzed");
            err.code = "ALREADY_DECIDED";
            throw err;
        }
        await completeKioskReanalysis(existingDecision);
        return;
    }
    if (reanalyze && existingDecision) {
        const err = new Error("This kiosk portrait group already has a pending decision or publication");
        err.code = "ALREADY_DECIDED";
        throw err;
    }
    const siblings = await _findVariantSiblings(parentJobId);
    if (siblings.length === 0) {
        const err = new Error("Parent job not found or already decided");
        err.code = "ALREADY_DECIDED";
        throw err;
    }

    const firstJob = siblings[0].job;
    const now = Date.now();
    const rejectionAlreadyPersisted = !reanalyze
        && siblings.every((sib) => sib.job.variantStatus === "REJECTED");
    if (firstJob.kioskSubmission && siblings.some((sib) => sib.job.kioskApprovalStartedAt)
        && existingDecision?.action !== "reject") {
        const err = new Error("A kiosk portrait has already been selected");
        err.code = "ALREADY_DECIDED";
        throw err;
    }

    if (reanalyze && firstJob.kioskSubmission) {
        const decision = await prepareKioskReanalysis(parentJobId, siblings, feedback, now);
        await completeKioskReanalysis(decision);
        return;
    }

    if (reanalyze) {
        const reanalyzeOutputProfile = await resolveReanalysisOutputProfile(siblings);
        let voiceInput = null;
        let voiceManifest = null;
        if (firstJob.inputMode === "voice") {
            voiceManifest = await readVoiceGroup(firstJob.voiceGroupId);
            if (!voiceManifest || voiceManifest.status !== "committed") {
                throw new Error("Voice group is not committed for re-analysis");
            }
            const source = siblings.map((sib) => jobPaths(sib.job, { staged: true }).inputPath)
                .find((candidate) => fs.existsSync(candidate));
            if (!source) throw new Error("Voice source selfie is missing for re-analysis");
            voiceInput = await fsp.readFile(source);
        }

        // Re-queue fresh siblings under a NEW parentJobId, preserving lineage
        // via reanalyzedFrom. Supersede all existing siblings.
        for (const sib of siblings) {
            try {
                await _markSiblingTerminal(sib, "reanalyzed", now);
            } catch (err) {
                console.error(`⚠️  Failed to supersede sibling ${sib.filename}: ${err.message}`);
            }
        }

        const newParentId = firstJob.inputMode === "voice"
            ? `${formatTimestamp(now)}-voice-${randomUUID().slice(0, 8)}`
            : formatTimestamp(now);
        const variantCount = firstJob.variantCount || siblings.length;
        const replacementPrefixes = [];
        for (let i = 1; i <= variantCount; i++) {
            const variantPrefix = `${newParentId}-v${i}`;
            replacementPrefixes.push(variantPrefix);
            const newJob = {
                imageUrl: firstJob.imageUrl,
                messageSid: `${firstJob.messageSid}-reanalyze-${now}`,
                userPhone: firstJob.userPhone,
                appPhone: firstJob.appPhone,
                channel: firstJob.channel || null,
                apiSubmission: firstJob.apiSubmission || undefined,
                kioskSubmission: firstJob.kioskSubmission || undefined,
                kioskEmail: firstJob.kioskEmail || undefined,
                requestId: firstJob.requestId || undefined,
                consentedAt: firstJob.consentedAt || undefined,
                whatsappOptInAt: firstJob.whatsappOptInAt || undefined,
                kioskEventSnapshot: firstJob.kioskEventSnapshot
                    ? plainSnapshot(firstJob.kioskEventSnapshot) : undefined,
                kioskUsageId: firstJob.kioskSubmission
                    ? (firstJob.kioskUsageId || firstJob.requestId || firstJob.reanalyzedFrom
                        || firstJob.parentJobId || firstJob.filePrefix) : undefined,
                kioskDeliveryState: firstJob.kioskSubmission ? "pending" : undefined,
                kioskDeliveryAttempts: firstJob.kioskSubmission ? 0 : undefined,
                uploadedInputFile: firstJob.uploadedInputFile || undefined,
                noDelivery: firstJob.noDelivery || undefined,
                style: firstJob.style,
                baseUrl: firstJob.baseUrl || "",
                background: firstJob.background || null,
                brand: firstJob.brand || null,
                locale: firstJob.locale || "en",
                styleName: firstJob.styleName,
                eventName: firstJob.eventName,
                retries: 0,
                createdAt: now,
                pendingAt: now,
                stateChangedAt: now,
                filePrefix: variantPrefix,
                parentJobId: newParentId,
                variantId: variantPrefix,
                variantIndex: i,
                variantCount,
                reanalyzedFrom: parentJobId,
                reviewFeedback: feedback || undefined,
                outputProfile: { ...reanalyzeOutputProfile },
            };
            if (voiceInput) {
                Object.assign(newJob, {
                    inputMode: "voice", voiceGroupId: firstJob.voiceGroupId,
                    voiceBrief: firstJob.voiceBrief, voiceScene: firstJob.voiceScene,
                    voiceEventSettings: firstJob.voiceEventSettings,
                });
                await atomicWriteFile(jobPaths(newJob, { staged: true }).inputPath, voiceInput);
            }
            if (firstJob.adminGenerated) newJob.adminGenerated = true;
            const filename = `${variantPrefix}.json`;
            const jobPath = path.join(PENDING_DIR, filename);
            writeJob(jobPath, newJob);
        }
        if (voiceManifest) {
            await atomicWriteFile(voiceGroupPath(firstJob.voiceGroupId), JSON.stringify({
                ...voiceManifest, filePrefixes: replacementPrefixes,
                reanalyzedFrom: parentJobId, reanalyzedAt: now,
            }));
        }
        // Usage is NOT re-incremented — the parent was counted once at original enqueue
        console.log(`🔄 Re-analyzed: ${parentJobId} → ${newParentId} (${variantCount} new variants)`);

        audit.logEvent("parent.reanalyze", firstJob.eventName, {
            oldParentJobId: parentJobId,
            newParentJobId: newParentId,
            variantCount,
            feedback: feedback || "",
            style: firstJob.style,
            brand: firstJob.brand || null,
        }).catch(() => {});
        return;
    }

    // Reject (with or without notify): kill all siblings, decrement usage once
    if (firstJob.kioskSubmission) {
        // Persist the parent decision before changing any sibling. A failed
        // write to a later sibling must not leave a reviewable card after a
        // restart, or let a pick race with an unfinished rejection.
        await recordKioskRejectDecision(parentJobId, firstJob, !rejectionAlreadyPersisted);
    }
    for (const [index, sib] of siblings.entries()) {
        try {
            if (index === 0) markVoiceDeliveryPending(sib.job, "failure");
            await _markSiblingTerminal(sib, "review_rejected", now);
        } catch (err) {
            if (firstJob.kioskSubmission) throw err;
            console.error(`⚠️  Failed to reject sibling ${sib.filename}: ${err.message}`);
        }
    }
    if (firstJob.kioskSubmission) {
        const remaining = await _findVariantSiblings(parentJobId, { strict: true });
        if (remaining.some((sib) => sib.job.variantStatus !== "REJECTED")) {
            throw new Error(`Kiosk rejection is incomplete for ${parentJobId}`);
        }
    }
    if (firstJob.inputMode === "voice") {
        const terminalPath = await findVoiceDeliveryPath(siblings[0].filename);
        if (terminalPath) {
            const owner = await readJobAsync(terminalPath);
            markVoiceDeliveryPending(owner, "failure");
            await writeJobAsync(terminalPath, owner);
        }
    }
    // A failed SMB move can leave one sibling in review after this pass. The
    // AI recovery poll will retry that move; the parent's quota and rejection
    // notification must still be applied only once in this process. On a
    // restart, usage is rebuilt from the files that actually remain active.
    if (!parentRejectEffectsApplied.has(parentJobId)) {
        parentRejectEffectsApplied.add(parentJobId);
        if (!rejectionAlreadyPersisted || kioskRejectDecisionsRecordedInThisProcess.has(parentJobId)) {
            // A restart rebuild excludes terminal variants. If every remaining
            // sibling was already marked REJECTED before the crash, the parent
            // quota was released by that rebuild; replay only the file moves.
            decrementUsage(firstJob.userPhone, firstJob.eventName);
            console.log(`🗑️  Parent rejected: ${parentJobId}`);
            if (message && !firstJob.noDelivery && !firstJob.kioskSubmission && firstJob.inputMode !== "voice") {
                messaging.send(firstJob.userPhone, "_raw", {}, jobSendOptions(firstJob, { _body: i18n.t(firstJob.locale, "reviewReject", {}, firstJob.eventName) }))
                    .catch((err) => console.error(`❌ Review SMS failed: ${err.message}`));
            }

            audit.logEvent("parent.reject", firstJob.eventName, {
                parentJobId,
                variantCount: siblings.length,
                notified: !!message,
                style: firstJob.style,
            }).catch(() => {});
        }
    }
    if (firstJob.kioskSubmission) await clearKioskRejectDecisionIfSettled(parentJobId);
}

// In-memory guard: prevents multiple concurrent AI best-of-N coordinators
// racing for the same parent group. A single process instance can rely on
// this; multi-instance deployments would need a disk-backed flag, but the
// app currently runs as a single container.
const _aiBestOfNLocks = new Set();

function hasDurableAiReviewMode(job) {
    // Never infer a queued review's mode from mutable event settings. A prior
    // restart auto-approved human reviews after the current setting changed.
    if (job.reviewModeAtReview) return job.reviewModeAtReview === "ai";
    if (job.aiBestOfNDecided === true || job.aiBestOfNDecision) return true;
    if (job.kioskSubmission) return job.kioskEventSnapshot?.eventSettings?.reviewMode === "ai";
    if (job.inputMode === "voice") return job.voiceEventSettings?.reviewMode === "ai";
    return false;
}

async function sweepTerminalKioskReviewSiblings() {
    let files;
    try { files = (await fsp.readdir(REVIEW_DIR)).filter((name) => name.endsWith(".json")); }
    catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
    }
    for (const filename of files) {
        try {
            const job = await readJobAsync(path.join(REVIEW_DIR, filename));
            if (!job.kioskSubmission || !["REJECTED", "SUPERSEDED"].includes(job.variantStatus)) continue;
            const reason = job.variantStatus === "REJECTED" ? "review_rejected"
                : job.failReason === "reanalyzed" ? "reanalyzed" : "superseded";
            await _markSiblingTerminal({ filename, job, location: "review" }, reason,
                job.stateChangedAt || Date.now());
            invalidateReviewCache();
        } catch (error) {
            if (error.code !== "ENOENT") {
                console.error(`⚠️  Terminal kiosk review recovery failed for ${filename}: ${error.message}`);
            }
        }
    }
}

async function sweepKioskRejectDecisions() {
    let files;
    try { files = (await fsp.readdir(KIOSK_PARENT_DECISION_DIR)).filter((name) => name.endsWith(".json")); }
    catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
    }
    for (const filename of files) {
        try {
            const decision = JSON.parse(await fsp.readFile(path.join(KIOSK_PARENT_DECISION_DIR, filename), "utf8"));
            if (typeof decision.parentJobId !== "string") continue;
            if (decision.action === "reanalyze") {
                await completeKioskReanalysis(decision);
                continue;
            }
            if (decision.action !== "reject") continue;
            if ((await _findVariantSiblings(decision.parentJobId, { strict: true })).length > 0) {
                await rejectParent(decision.parentJobId, null, false, null);
            } else {
                // The last queue move can complete before the caller reaches
                // the quota update. In this process, release it now; after a
                // restart buildUsageCache already excludes terminal siblings.
                if (kioskRejectDecisionsRecordedInThisProcess.has(decision.parentJobId)
                    && !parentRejectEffectsApplied.has(decision.parentJobId)) {
                    parentRejectEffectsApplied.add(decision.parentJobId);
                    decrementUsage(decision.userPhone, decision.eventName);
                }
                await clearKioskRejectDecisionIfSettled(decision.parentJobId);
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                console.error(`⚠️  Kiosk parent rejection recovery failed for ${filename}: ${error.message}`);
            }
        }
    }
}

async function sweepKioskReviewApprovals() {
    let files;
    try { files = (await fsp.readdir(REVIEW_DIR)).filter((name) => name.endsWith(".json")); }
    catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
    }
    for (const filename of files) {
        try {
            const job = await readJobAsync(path.join(REVIEW_DIR, filename));
            if (!job.kioskSubmission || (!job.kioskApprovalStartedAt && !hasOutputFile(job))) continue;
            if (job.parentJobId) await pickVariant(job.parentJobId, job.variantId || job.filePrefix);
            else {
                await completePublishedOutput(job);
                await approveJob(filename);
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                console.error(`⚠️  Kiosk review approval recovery failed for ${filename}: ${error.message}`);
            }
        }
    }
}

async function sweepAiBestOfNGroups() {
    let files;
    try { files = (await fsp.readdir(REVIEW_DIR)).filter((name) => name.endsWith(".json")); }
    catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
    }
    const parents = new Set();
    for (const filename of files) {
        try {
            const job = await readJobAsync(path.join(REVIEW_DIR, filename));
            if (job.parentJobId && hasDurableAiReviewMode(job)) {
                parents.add(job.parentJobId);
            }
        } catch (error) {
            if (error.code !== "ENOENT") console.error(`⚠️  AI review scan skipped ${filename}: ${error.message}`);
        }
    }
    for (const parentJobId of parents) await maybeRunAiBestOfN(parentJobId);
}

async function findPromotedAiWinner(parentJobId, winnerVariantId) {
    for (const dir of [READY_DIR, PRINTING_DIR, DONE_DIR, FAILED_DIR]) {
        let files;
        try { files = (await fsp.readdir(dir)).filter((name) => name.endsWith(".json")); }
        catch { continue; }
        for (const filename of files) {
            try {
                const job = await readJobAsync(path.join(dir, filename));
                if (job.parentJobId === parentJobId
                    && (job.variantId || job.filePrefix) === winnerVariantId
                    && job.approvedAt) return job;
            } catch { /* A worker may be moving this job. */ }
        }
    }
    return null;
}

// Called after each sibling lands in REVIEW_DIR under AI multi-variant mode.
// No-op until all expected siblings are terminal, at which point the best
// variant is auto-picked (or all are rejected). Errors are logged, never
// thrown — AI coordination must never break the user-facing flow.
async function maybeRunAiBestOfN(parentJobId) {
    if (_aiBestOfNLocks.has(parentJobId)) return;
    _aiBestOfNLocks.add(parentJobId);
    try {
        const siblings = await _findVariantSiblings(parentJobId);
        if (siblings.length === 0) return;
        // An ordinary event can change mode while sibling generations are in
        // flight. One sibling entering human review vetoes automatic selection
        // for the entire card, even if another entered AI review earlier.
        if (siblings.some((s) => s.location === "review"
            && s.job.reviewModeAtReview && s.job.reviewModeAtReview !== "ai")) return;
        // The comparison result is recorded on every review sibling before
        // moving any files. A crash halfway through pick/reject then leaves a
        // surviving sibling with the exact decision to finish on the next poll.
        const savedDecision = siblings.map((s) => s.job.aiBestOfNDecision)
            .find((d) => d?.allFailed === true || typeof d?.winnerVariantId === "string");
        if (savedDecision) {
            if (savedDecision.allFailed) {
                const firstJob = siblings[0].job;
                await rejectParent(parentJobId,
                    i18n.t(firstJob.locale, "reviewFailed", {}, firstJob.eventName),
                    false, null);
            } else {
                const winnerStillInReview = siblings.some((s) =>
                    (s.job.variantId || s.job.filePrefix) === savedDecision.winnerVariantId);
                if (winnerStillInReview) {
                    await pickVariant(parentJobId, savedDecision.winnerVariantId);
                } else {
                    // pickVariant moves the winner last, but a transient SMB
                    // failure can leave one loser in review after the winner
                    // has already been published. Finish only that cleanup;
                    // never send the chosen portrait a second time.
                    const winner = await findPromotedAiWinner(parentJobId, savedDecision.winnerVariantId);
                    if (!winner) throw new Error("Persisted AI winner is not in an approved queue");
                    const now = Date.now();
                    for (const sibling of siblings) {
                        try { await _markSiblingTerminal(sibling, "superseded", now); }
                        catch (error) {
                            console.error(`⚠️  Failed to finish AI sibling ${sibling.filename}: ${error.message}`);
                        }
                    }
                    if (winner.kioskSubmission) await rememberKioskResultPointer(siblings, winner.filePrefix);
                }
            }
            return;
        }
        const expected = siblings[0].job.variantCount || siblings.length;
        const priorAiCoordinatorStarted = siblings.some((s) => s.job.aiBestOfNDecided === true);
        if (siblings.length < expected || siblings.some((s) =>
            s.location !== "review"
            || (s.job.variantStatus && !["READY", "FAILED"].includes(s.job.variantStatus)))
            || (!priorAiCoordinatorStarted && siblings.some((s) => !hasDurableAiReviewMode(s.job)))) return;

        // A previous process may have written aiBestOfNDecided before its AI
        // call or parent decision finished. A review group still on disk is
        // unfinished, so this old marker must not suppress recovery.
        const first = siblings[0].job;

        console.log(`🤖 Running AI best-of-N for parent ${parentJobId} (${siblings.length} variants)`);

        const jobsInOrder = siblings
            .sort((a, b) => (a.job.variantIndex || 0) - (b.job.variantIndex || 0))
            .map((s) => s.job);

        let pickResult;
        try {
            pickResult = await aiPickBestVariant(jobsInOrder);
        } catch (err) {
            console.error(`❌ AI best-of-N call failed: ${err.message} — falling back to variant 1`);
            // Fallback: pick the first non-failed variant so the user still gets
            // something. This preserves the "AI mode never leaves a user hanging"
            // guarantee — AI infra failures should not stall delivery.
            const firstOk = jobsInOrder.find((j) => j.variantStatus !== "FAILED");
            if (firstOk) {
                pickResult = { winnerIndex: jobsInOrder.indexOf(firstOk), reason: `AI error: ${err.message} (fell back to first variant)` };
            } else {
                pickResult = { allFailed: true, reason: `AI error: ${err.message}` };
            }
        }

        audit.logEvent("variant.ai_pick", first.eventName, {
            parentJobId,
            variantCount: jobsInOrder.length,
            outcome: pickResult.allFailed ? "all_failed" : "picked",
            pickedVariantIndex: pickResult.winnerIndex != null ? (jobsInOrder[pickResult.winnerIndex]?.variantIndex || null) : null,
            reason: pickResult.reason,
            style: first.style,
        }).catch(() => {});

        const winner = pickResult.allFailed ? null : jobsInOrder[pickResult.winnerIndex];
        if (!pickResult.allFailed && !winner) throw new Error("AI best-of-N returned an invalid winner");
        const winnerVariantId = winner && (winner.variantId || winner.filePrefix);
        const decision = pickResult.allFailed
            ? { allFailed: true, reason: pickResult.reason }
            : { winnerVariantId, reason: pickResult.reason };
        for (const sibling of siblings) {
            sibling.job.aiBestOfNDecision = decision;
            await writeJobAsync(path.join(REVIEW_DIR, sibling.filename), sibling.job);
        }

        if (pickResult.allFailed) {
            await rejectParent(parentJobId,
                i18n.t(first.locale, "reviewFailed", {}, first.eventName),
                false, null);
            return;
        }

        await pickVariant(parentJobId, winnerVariantId);
    } catch (err) {
        console.error(`❌ AI best-of-N coordinator failed for ${parentJobId}: ${err.message}`);
    } finally {
        _aiBestOfNLocks.delete(parentJobId);
    }
}

module.exports = {
    buildUsageCache,
    getInFlightUsageRebuild,
    isAdmin,
    getUsageCount,
    getAllUsers,
    resetUsage,
    toggleAdmin,
    incrementUsage,
    decrementUsage,
    moveJobsToEvent,
    enqueueJob,
    ensureKioskGroupPublished,
    sweepKioskDeliveries,
    setKioskDeliveryReady,
    updateKioskDeliveryFromProvider,
    updateKioskEmailFromProvider,
    resolveKioskResultPrefix,
    enqueueVoiceGroup,
    getVoiceGroup,
    sweepVoiceDeliveries,
    retryVoiceDelivery,
    getVoiceDeliveryIssues,
    recoverStaleJobs,
    sweepStaleGenerating,
    processGenerationQueue,
    sweepAiBestOfNGroups,
    processPrintQueue,
    processSinglePrint,
    getPrinterBusyState,
    sendPrintCompletionMms,
    markFailureEffectsPending,
    finishPendingRelayEffects,
    settlePendingRelayTransition,
    sweepPendingRelayEffects,
    sweepPendingTerminalEffects,
    recoverStaleRelayJobs,
    clearStaleRelayTargets,
    cleanupQueueTempFiles,
    sweepMissingOutputJobs,
    requeueDoneJobForReprint,
    getReviewQueue,
    invalidateReviewCache,
    pickVariant,
    regenerateVariant,
    rejectParent,
    resolveReanalysisOutputProfile,
    approveJob,
    rejectJob,
    __shouldSkipDeliveryMediaForTest: shouldSkipDeliveryMedia,
    __oversizedWhatsappImageSuffixForTest: oversizedWhatsappImageSuffix,
    __selectWhatsappDeliveryMediaForTest: selectWhatsappDeliveryMedia,
    __shouldUseRichDeliveryForTest: shouldUseRichDelivery,
    __jobAdapterForTest: jobAdapter,
    __sendDigitalDeliveryForTest: sendDigitalDelivery,
};

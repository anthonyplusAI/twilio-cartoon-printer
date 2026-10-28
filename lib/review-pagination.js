const DEFAULT_REVIEW_PAGE_SIZE = 24;
const MAX_REVIEW_PAGE_SIZE = 60;

// getReviewQueue caches its array for ten seconds. Keep a sorted view of that
// exact snapshot so polling does not sort a large queue on every request.
const orderedSnapshots = new WeakMap();

function reviewKey(job) {
    return String(job.parentJobId || job.filename || job.filePrefix || "");
}

function reviewTime(job) {
    const value = Number(job.reviewAt);
    return Number.isFinite(value) ? value : 0;
}

function compareReviewJobs(a, b) {
    return reviewTime(a) - reviewTime(b) || reviewKey(a).localeCompare(reviewKey(b));
}

function invalidPage(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

function parseReviewPageRequest(query = {}) {
    if (query.limit === undefined && query.cursor === undefined) return null;

    const requestedLimit = query.limit === undefined ? DEFAULT_REVIEW_PAGE_SIZE : Number(query.limit);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) throw invalidPage("Invalid review page limit");
    const limit = Math.min(requestedLimit, MAX_REVIEW_PAGE_SIZE);
    let cursor = null;
    if (query.cursor !== undefined) {
        const raw = query.cursor;
        if (typeof raw !== "string" || !raw || raw.length > 2048) throw invalidPage("Invalid review cursor");
        try {
            const tuple = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
            if (Array.isArray(tuple) && tuple.length === 2
                && Number.isFinite(tuple[0]) && tuple[0] >= 0
                && typeof tuple[1] === "string" && tuple[1].length > 0 && tuple[1].length <= 512) {
                cursor = { reviewAt: tuple[0], key: tuple[1] };
            }
        } catch {}
        if (!cursor) throw invalidPage("Invalid review cursor");
    }
    return { limit, cursor };
}

function encodeReviewCursor(job) {
    return Buffer.from(JSON.stringify([reviewTime(job), reviewKey(job)])).toString("base64url");
}

function orderedReviewJobs(jobs) {
    let ordered = orderedSnapshots.get(jobs);
    if (!ordered) {
        ordered = jobs.slice().sort(compareReviewJobs);
        orderedSnapshots.set(jobs, ordered);
    }
    return ordered;
}

function offsetAfterCursor(items, cursor) {
    if (!cursor) return 0;
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const cmp = reviewTime(items[mid]) - cursor.reviewAt || reviewKey(items[mid]).localeCompare(cursor.key);
        if (cmp <= 0) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function paginateReviewQueue(jobs, page) {
    const ordered = orderedReviewJobs(jobs);
    const offset = offsetAfterCursor(ordered, page.cursor);
    const items = ordered.slice(offset, offset + page.limit);
    const hasMore = offset + items.length < ordered.length;
    return {
        items,
        total: ordered.length,
        offset,
        limit: page.limit,
        hasMore,
        cursor: hasMore && items.length ? encodeReviewCursor(items.at(-1)) : null,
    };
}

module.exports = {
    DEFAULT_REVIEW_PAGE_SIZE,
    MAX_REVIEW_PAGE_SIZE,
    parseReviewPageRequest,
    paginateReviewQueue,
};

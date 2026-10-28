// Pure Prompt Lab HTML and list helpers for runtime and synthetic preview.
// This module has no app-state, storage, or credential imports.
const { renderSiteNav, siteNavStylesheet } = require("./site-nav");
const MIN_CONCURRENT = 1;
const MAX_CONCURRENT_CAP = 60;
const MAX_ENTRIES_PER_EXPERIMENT = 500;
const MAX_VARIANTS_PER_EXPERIMENT = 10;
const COST_PER_IMAGE_USD = 0.19;

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function jsonForScript(value) { return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026"); }

function formatMs(ms) {
    if (!ms && ms !== 0) return "";
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return `${m}m ${rem}s`;
}

function evalNav(active) {
    const tab = (key, label, href) =>
        `<a href="${href}" class="${active === key ? "active" : ""}" ${active === key ? `aria-current="page"` : ""}>${label}</a>`;
    return `<header class="eval-app-header">
      <div class="eval-app-brand"><strong>Prompt Lab</strong></div>
      <div class="eval-app-links"><button type="button" id="evalThemeButton" aria-label="Switch color theme">Theme</button></div>
    </header>
    <nav class="nav-tabs" aria-label="Prompt Lab sections">
      ${tab("runs", "Runs", "/eval")}
      ${tab("new", "New run", "/eval/new")}
      ${tab("photos", "Photos", "/eval/photos")}
      ${tab("variants", "Saved variants", "/eval/variants")}
    </nav>`;
}

function pageShell({ title, body, userBar = "", magicHat = "" }) {
    return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<link rel="stylesheet" href="/assets/tw-modal.css">
<script src="/assets/tw-modal.js"></script>
<title>${escapeHtml(title)} — Prompt Lab</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--th-bg); color: var(--th-text); font-family: 'Twilio Sans Text', system-ui, sans-serif; padding: 32px 24px 80px; line-height: 1.5; }
  .wrap { max-width: 1200px; margin: 0 auto; }
  h1 { font-family: 'Twilio Sans Display', sans-serif; font-size: 32px; font-weight: 700; margin-bottom: 4px; letter-spacing: -0.01em; }
  h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; margin: 28px 0 10px; color: var(--th-text-muted); }
  h3 { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
  p { margin-bottom: 8px; }
  .subtitle { color: var(--th-text-muted); font-size: 14px; margin-bottom: 24px; }
  .card { background: var(--th-card); border: 1px solid var(--th-card-border); border-radius: 10px; padding: 20px; margin-bottom: 14px; }
  .card-compact { padding: 14px 16px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
  .row-top { align-items: flex-start; }
  .stack { display: flex; flex-direction: column; gap: 12px; }
  .stack-lg { display: flex; flex-direction: column; gap: 20px; }
  .cluster { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .btn { display: inline-flex; align-items: center; gap: 6px; background: var(--brand-red); color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600; border: none; cursor: pointer; font-size: 14px; font-family: inherit; line-height: 1; transition: filter 0.15s, transform 0.05s; }
  .btn:hover { filter: brightness(1.08); }
  .btn:active { transform: translateY(1px); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-secondary { background: transparent; color: var(--th-text); border: 1px solid var(--th-card-border); }
  .btn-secondary:hover { background: var(--th-card-border); filter: none; }
  .btn-sm { padding: 5px 10px; font-size: 12px; }
  .btn-danger { background: transparent; color: #ef4444; border: 1px solid #ef4444; }
  .btn-danger:hover { background: rgba(239, 68, 68, 0.1); filter: none; }
  .muted { color: var(--th-text-muted); font-size: 13px; }
  .small { font-size: 12px; }
  .pill { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase; vertical-align: middle; }
  .pill-running { background: #fef3c7; color: #92400e; }
  .pill-completed { background: #d1fae5; color: #065f46; }
  .pill-failed { background: #fee2e2; color: #991b1b; }
  .pill-pending { background: var(--th-card-border); color: var(--th-text-muted); }
  input[type=text], input[type=number], input[type=file], input:not([type]), select, textarea { width: 100%; background: var(--th-bg); color: var(--th-text); border: 1px solid var(--th-card-border); padding: 10px 12px; border-radius: 6px; font-family: inherit; font-size: 14px; transition: border-color 0.15s, box-shadow 0.15s; }
  input[type=text]:focus, input[type=number]:focus, input:not([type]):focus, select:focus, textarea:focus { outline: none; border-color: var(--brand-red); box-shadow: 0 0 0 3px rgba(244, 49, 60, 0.15); }
  textarea { font-family: 'Twilio Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace; line-height: 1.5; resize: vertical; }
  input[type=checkbox] { accent-color: var(--brand-red); width: 16px; height: 16px; vertical-align: middle; margin-right: 6px; }
  label { display: block; font-size: 13px; color: var(--th-text-muted); margin-bottom: 12px; }
  label.inline { display: inline-flex; align-items: center; gap: 6px; margin-right: 16px; margin-bottom: 6px; font-size: 14px; color: var(--th-text); cursor: pointer; }
  label.inline input[type=checkbox] { margin-right: 0; }
  label .label-text { display: block; margin-bottom: 6px; font-weight: 500; color: var(--th-text); font-size: 13px; }
  label .label-hint { display: block; font-size: 12px; color: var(--th-text-muted); margin-bottom: 6px; font-weight: normal; }
  fieldset { border: 1px solid var(--th-card-border); border-radius: 8px; padding: 14px 16px 16px; margin-bottom: 4px; }
  fieldset legend { font-size: 13px; font-weight: 600; padding: 0 8px; color: var(--th-text); }
  fieldset .legend-hint { font-size: 12px; color: var(--th-text-muted); margin-bottom: 10px; font-weight: normal; }
  .options-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 4px 12px; }
  details.override-block { border: 1px solid var(--th-card-border); border-radius: 6px; padding: 10px 12px; background: var(--th-bg); }
  details.override-block summary { cursor: pointer; font-weight: 600; font-size: 13px; padding: 2px 0; }
  details.override-block summary::marker { color: var(--th-text-muted); }
  details.override-block[open] { padding-bottom: 12px; }
  a { color: var(--brand-red); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .err { color: #ef4444; font-size: 13px; margin-top: 8px; min-height: 18px; }
  .code { font-family: 'Twilio Sans Mono', ui-monospace, 'SF Mono', Menlo, monospace; font-size: 12px; background: var(--th-bg); padding: 1px 6px; border-radius: 4px; border: 1px solid var(--th-card-border); }
  .divider { height: 1px; background: var(--th-card-border); margin: 16px 0; }
  .nav-tabs { display: flex; gap: 4px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
  .nav-tabs a { padding: 8px 14px; border-radius: 6px; color: var(--th-text-muted); font-size: 14px; font-weight: 500; }
  .nav-tabs a.active { background: var(--th-card); color: var(--th-text); }
  .nav-tabs a:hover { background: var(--th-card); text-decoration: none; }
  .nav-tabs .nav-home { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; color: var(--th-text-muted); border: 1px solid var(--th-card-border); border-radius: 6px; }
  .nav-tabs .nav-home svg { width: 14px; height: 14px; }
  .nav-tabs .nav-home:hover { color: var(--th-text); border-color: var(--th-text-muted); background: transparent; }
  .nav-tabs .nav-sep { width: 1px; height: 20px; background: var(--th-card-border); margin: 0 6px; }
</style>
<link rel="stylesheet" href="/assets/eval-workspace.css">
${siteNavStylesheet()}
<script defer src="/assets/eval-workspace.js"></script>
</head>
<body class="eval-page">
${magicHat}
${userBar}
<div class="wrap">
${renderSiteNav("eval")}
<div class="eval-review-notify" id="evalReviewNotify" hidden><span id="evalReviewText"></span><a href="/review/queue">Open review queue</a></div>
${body}
</div>
</body>
</html>`;
}

const RUNS_PAGE_SIZE = 24;

function paginateRunSummaries(summaries, { activeEvent = "", allEvents = false, q = "", group = "", status = "", page = 1, limit = RUNS_PAGE_SIZE } = {}) {
    const showAllEvents = allEvents === true || allEvents === "1" || !activeEvent;
    const scoped = showAllEvents ? summaries : summaries.filter((m) => (m.eventName || "") === activeEvent);
    const search = String(q || "").trim().toLocaleLowerCase().slice(0, 100);
    const selectedGroup = String(group || "").trim().slice(0, 40);
    const selectedStatus = ["running", "pending", "completed", "failed"].includes(status) ? status : "";
    const groups = [...new Set(scoped.map((m) => (m.group || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const counts = scoped.reduce((result, m) => {
        result.total++;
        if (Object.hasOwn(result, m.status)) result[m.status]++;
        return result;
    }, { total: 0, running: 0, pending: 0, completed: 0, failed: 0 });
    const filtered = scoped.filter((m) => {
        const runGroup = (m.group || "").trim();
        if (selectedGroup === "__ungrouped__" ? runGroup : selectedGroup && runGroup !== selectedGroup) return false;
        if (selectedStatus && m.status !== selectedStatus) return false;
        if (!search) return true;
        return [m.name, m.id, m.group, m.eventName].some((value) => String(value || "").toLocaleLowerCase().includes(search));
    }).sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || (b.createdAt || "").localeCompare(a.createdAt || ""));
    const safeLimit = Math.min(50, Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : RUNS_PAGE_SIZE);
    const total = filtered.length;
    const pages = Math.max(1, Math.ceil(total / safeLimit));
    const requestedPage = Number(page);
    const currentPage = Math.min(pages, Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1);
    return {
        runs: filtered.slice((currentPage - 1) * safeLimit, currentPage * safeLimit),
        total, page: currentPage, pages, limit: safeLimit,
        counts, groups, hiddenCount: summaries.length - scoped.length,
        showAllEvents, q: search, group: selectedGroup, status: selectedStatus,
    };
}

function renderEvalRunsPage({ summaries, evalSettings, activeEvent = "", query = {}, userBar = "", magicHat = "" }) {
        const pageData = paginateRunSummaries(summaries, { activeEvent, ...query });
        const { runs, total, page, pages, limit, counts, groups: allGroupNames, hiddenCount, showAllEvents } = pageData;
        const running = runs.filter((m) => m.status === "running");
        const recent = runs.filter((m) => m.status !== "running");
        const pageUrl = (nextPage, overrides = {}) => {
            const params = new URLSearchParams();
            const filters = { allEvents: showAllEvents ? "1" : "", q: pageData.q, group: pageData.group, status: pageData.status, ...overrides };
            for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
            if (nextPage > 1) params.set("page", String(nextPage));
            return `/eval${params.size ? `?${params}` : ""}`;
        };

        const card = (m) => {
            const { done, failed, total } = m.totals;
            const progress = total ? Math.round(((done + failed) / total) * 100) : 0;
            const pill = `<span class="pill pill-${m.status}">${m.status}</span>`;
            const cost = m.totalCostUsd ? `$${m.totalCostUsd.toFixed(2)}` : "";
            const wallMs = m.wallMs;
            const wallLabel = wallMs ? formatMs(wallMs) : "";
            const groupLabel = m.group ? `<span class="run-group-tag">${escapeHtml(m.group)}</span>` : "";
            const eventLabel = showAllEvents && m.eventName
                ? `<span class="run-event-tag" title="Event">${escapeHtml(m.eventName)}</span>`
                : "";
            const starBadge = m.starredCount > 0
                ? `<span class="run-star-badge" title="${m.starredCount} starred image${m.starredCount === 1 ? "" : "s"}"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>${m.starredCount}</span>`
                : "";
            return `<div class="card card-compact run-card" data-run-id="${escapeHtml(m.id)}" data-run-name="${escapeHtml(m.name)}" data-run-group="${escapeHtml(m.group || "")}">
              <a href="/eval/run/${encodeURIComponent(m.id)}" class="run-card-link">
                <div class="row">
                  <div>
                    <div class="run-card-title"><strong class="run-name">${escapeHtml(m.name)}</strong>${pill}${groupLabel}${eventLabel}${starBadge}</div>
                    <div class="run-card-meta muted">${escapeHtml(new Date(m.createdAt).toLocaleString())} · ${done}/${total} done${failed ? ` · <span class="run-failed-count">${failed} failed</span>` : ""}${wallLabel ? ` · ${wallLabel}` : ""}${cost ? ` · ${cost}` : ""}</div>
                  </div>
                </div>
                <div class="run-progress" role="progressbar" aria-label="Run progress" aria-valuenow="${done + failed}" aria-valuemin="0" aria-valuemax="${total || 0}"><span style="width:${progress}%"></span></div>
              </a>
              <button type="button" class="run-move" data-move-run="${escapeHtml(m.id)}" aria-label="Move to group" title="Move to group"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg><span>Move</span></button>
              <button type="button" class="run-delete" data-delete-run="${escapeHtml(m.id)}" aria-label="Delete run" title="Delete run"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>Delete</span></button>
            </div>`;
        };

        const eventToggle = activeEvent
            ? (showAllEvents
                ? `<a class="eval-event-toggle" href="${escapeHtml(pageUrl(1, { allEvents: "" }))}">All events <span>· show ${escapeHtml(activeEvent)}</span></a>`
                : `<a class="eval-event-toggle" href="${escapeHtml(pageUrl(1, { allEvents: "1" }))}">${escapeHtml(activeEvent)} <span>· show all${hiddenCount ? ` (${hiddenCount} more)` : ""}</span></a>`)
            : "";

        const body = `
          ${evalNav("runs")}
          <main id="evalRunsPage" class="eval-runs">
            <header class="eval-hero">
              <div><h1>Prompt runs</h1><p>Compare prompt variations on the same photos, then mark the results that work.</p></div>
              <div class="eval-hero-actions">${eventToggle}<a class="btn" href="/eval/new">New run</a></div>
            </header>
            <div class="eval-overview" aria-label="Run status for the selected event">
              <div><strong>${counts.total}</strong><span>Runs</span></div>
              <div><strong>${counts.running + counts.pending}</strong><span>Active</span></div>
              <div><strong>${counts.completed}</strong><span>Completed</span></div>
              <div><strong>${counts.failed}</strong><span>Failed</span></div>
            </div>
            <section class="eval-run-panel" aria-labelledby="runHistoryTitle">
              <div class="eval-run-panel-head">
                <div><h2 id="runHistoryTitle">Run history</h2><p>Newest runs first. Active runs stay at the top.</p></div>
                <details class="eval-defaults"><summary>Run defaults</summary><div class="eval-defaults-body">
                  <label for="cc-input"><strong>Concurrent generations</strong><span>Default for new runs. Choose ${MIN_CONCURRENT}–${MAX_CONCURRENT_CAP}.</span></label>
                  <div class="eval-defaults-controls"><input type="number" id="cc-input" min="${MIN_CONCURRENT}" max="${MAX_CONCURRENT_CAP}" value="${evalSettings.maxConcurrent}"><button type="button" class="btn btn-secondary btn-sm" id="cc-save">Save</button></div>
                  <span id="cc-msg" class="muted small" role="status" aria-live="polite"></span>
                </div></details>
              </div>
              <form class="eval-filterbar" action="/eval" method="get" aria-label="Filter runs">
                ${showAllEvents && activeEvent ? `<input type="hidden" name="allEvents" value="1">` : ""}
                <label class="eval-search"><span class="sr-only">Search runs</span><input type="search" name="q" value="${escapeHtml(pageData.q)}" placeholder="Search run, group, or event"></label>
                <label><span class="sr-only">Group</span><select name="group"><option value="">All groups</option><option value="__ungrouped__" ${pageData.group === "__ungrouped__" ? "selected" : ""}>Ungrouped</option>${allGroupNames.map((g) => `<option value="${escapeHtml(g)}" ${pageData.group === g ? "selected" : ""}>${escapeHtml(g)}</option>`).join("")}</select></label>
                <label><span class="sr-only">Status</span><select name="status"><option value="">All statuses</option>${["running", "pending", "completed", "failed"].map((s) => `<option value="${s}" ${pageData.status === s ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}</select></label>
                <button class="btn btn-secondary" type="submit">Apply</button>
                ${pageData.q || pageData.group || pageData.status ? `<a class="eval-clear" href="${escapeHtml(pageUrl(1, { q: "", group: "", status: "" }))}">Clear</a>` : ""}
              </form>
              <div class="eval-list-heading"><span>${total ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total}` : "No matching runs"}</span><span>Progress updates while this tab is open</span></div>
              <div class="eval-run-list">
                ${running.length ? `<h3>Active</h3>${running.map(card).join("")}` : ""}
                ${recent.length ? `<h3>${running.length ? "Other runs" : "Runs"}</h3>${recent.map(card).join("")}` : ""}
                ${!runs.length ? `<div class="eval-empty"><strong>${counts.total ? "No runs match these filters" : "No runs for this event yet"}</strong><p>${counts.total ? "Try a different search, group, or status." : "Create a run to compare prompts on your test photos."}</p><a class="btn btn-secondary" href="${counts.total ? escapeHtml(pageUrl(1, { q: "", group: "", status: "" })) : "/eval/new"}">${counts.total ? "Clear filters" : "Create a run"}</a></div>` : ""}
              </div>
              ${pages > 1 ? `<nav class="eval-pagination" aria-label="Run pages"><span>Page ${page} of ${pages}</span><div>${page > 1 ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(pageUrl(page - 1))}">Previous</a>` : `<span class="btn btn-secondary btn-sm is-disabled">Previous</span>`}${page < pages ? `<a class="btn btn-secondary btn-sm" href="${escapeHtml(pageUrl(page + 1))}">Next</a>` : `<span class="btn btn-secondary btn-sm is-disabled">Next</span>`}</div></nav>` : ""}
            </section>
          </main>

          <div id="confirmModal" class="confirm-modal" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
            <div class="confirm-backdrop"></div>
            <div class="confirm-card">
              <div class="confirm-title" id="confirmTitle">Delete run?</div>
              <div class="confirm-body" id="confirmBody"></div>
              <div class="confirm-actions">
                <button type="button" class="btn btn-secondary btn-sm" id="confirmCancel">Cancel</button>
                <button type="button" class="btn btn-sm confirm-danger" id="confirmOk">Delete</button>
              </div>
            </div>
          </div>

          <div id="moveModal" class="confirm-modal" style="display:none;" role="dialog" aria-modal="true" aria-labelledby="moveTitle">
            <div class="confirm-backdrop"></div>
            <div class="confirm-card">
              <div class="confirm-title" id="moveTitle">Move to group</div>
              <div class="confirm-body">
                <div id="moveChips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">${allGroupNames.length ? allGroupNames.map((g) => `<button type="button" class="move-chip" data-chip="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join("") : `<span class="muted small">No groups yet. Enter a new name below.</span>`}</div>
                <label style="display:block;font-size:12px;color:var(--th-text-muted);margin-bottom:4px;">Or type a new group name</label>
                <input type="text" id="moveInput" maxlength="40" placeholder="e.g. PGA Golfer, Coachella" style="width:100%;padding:8px 10px;border:1px solid var(--th-card-border);border-radius:6px;background:var(--th-bg);color:var(--th-text);font-family:inherit;font-size:13px;">
                <div id="moveError" style="color:#ef4444;font-size:12px;margin-top:6px;min-height:16px;"></div>
              </div>
              <div class="confirm-actions">
                <button type="button" class="btn btn-secondary btn-sm" id="moveClear">Remove from group</button>
                <button type="button" class="btn btn-secondary btn-sm" id="moveCancel">Cancel</button>
                <button type="button" class="btn btn-sm" id="moveOk">Move</button>
              </div>
            </div>
          </div>

          <style>
            .run-card { position: relative; padding-right: 190px; }
            .run-card-link { display: block; color: inherit; text-decoration: none; }
            .run-card-link:hover { text-decoration: none; }
            .run-card-link:hover * { text-decoration: none; }
            .run-move, .run-delete {
                position: absolute;
                top: 50%;
                transform: translateY(-50%);
                display: inline-flex;
                align-items: center;
                gap: 6px;
                height: 30px;
                padding: 0 12px;
                border-radius: 6px;
                font-size: 13px;
                font-weight: 500;
                line-height: 1;
                cursor: pointer;
                z-index: 2;
                transition: background 0.15s, border-color 0.15s, color 0.15s;
            }
            .run-move {
                right: 92px;
                border: 1px solid var(--th-border);
                background: var(--th-bg);
                color: var(--th-text);
            }
            .run-move:hover { background: var(--th-border-subtle); border-color: var(--th-text-muted); }
            .run-delete {
                right: 10px;
                border: 1px solid #fecaca;
                background: #fef2f2;
                color: #b91c1c;
            }
            .run-delete:hover { background: #fee2e2; border-color: #fca5a5; color: #991b1b; }
            .run-move svg, .run-delete svg { flex-shrink: 0; }
            .run-group-tag { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--th-border-subtle); color: var(--th-text); font-size: 11px; font-weight: 600; margin-left: 4px; letter-spacing: 0.02em; }
            .run-event-tag { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #dbeafe; color: #1e40af; font-size: 11px; font-weight: 700; margin-left: 4px; letter-spacing: 0.02em; }
            .run-star-badge { display: inline-flex; align-items: center; gap: 3px; padding: 2px 8px; border-radius: 999px; background: #fef3c7; color: #92400e; font-size: 11px; font-weight: 700; margin-left: 4px; letter-spacing: 0.02em; vertical-align: middle; }
            .run-star-badge svg { flex-shrink: 0; }
            .group-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; border-bottom: 1px solid var(--th-card-border); padding-bottom: 8px; }
            .group-tab { background: transparent; border: 1px solid var(--th-card-border); color: var(--th-text-muted); padding: 6px 14px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; transition: all 0.12s; }
            .group-tab:hover { color: var(--th-text); border-color: var(--th-text-muted); }
            .group-tab.active { background: var(--brand-red); border-color: var(--brand-red); color: white; }
            .move-chip { padding: 4px 10px; border-radius: 999px; border: 1px solid var(--th-card-border); background: var(--th-border-subtle); color: var(--th-text); font-size: 12px; cursor: pointer; font-family: inherit; }
            .move-chip:hover { border-color: var(--brand-red); color: var(--brand-red); }
            .confirm-modal { position: fixed; inset: 0; z-index: 2000; }
            .confirm-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,0.55); backdrop-filter: blur(2px); }
            .confirm-card { position: relative; max-width: 440px; margin: 18vh auto 0; background: var(--th-card); border: 1px solid var(--th-card-border); border-radius: 12px; padding: 22px 22px 18px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); }
            .confirm-title { font-weight: 700; font-size: 17px; margin-bottom: 8px; color: var(--th-text); }
            .confirm-body { color: var(--th-text); font-size: 14px; line-height: 1.5; margin-bottom: 18px; }
            .confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
            .confirm-danger { background: #991b1b; border-color: #991b1b; }
            .confirm-danger:hover { filter: brightness(0.92); }
          </style>
          <script>
            (function pollRuns() {
              const ids = [...document.querySelectorAll(".run-card .pill-running")].map((pill) => pill.closest(".run-card").dataset.runId);
              if (!ids.length) return;
              let busy = false;
              const refresh = async () => {
                if (document.hidden || busy) return;
                busy = true;
                try {
                  const r = await fetch("/eval/api/runs?ids=" + encodeURIComponent(ids.join(",")));
                  if (!r.ok) return;
                  const payload = await r.json();
                  for (const m of payload.runs || []) {
                    const card = document.querySelector('[data-run-id="' + CSS.escape(m.id) + '"]');
                    if (!card) continue;
                    const totals = m.totals || { total: 0, done: 0, failed: 0 };
                    const pill = card.querySelector(".pill");
                    if (pill) { pill.className = "pill pill-" + m.status; pill.textContent = m.status; }
                    const meta = card.querySelector(".run-card-meta");
                    if (meta) {
                      const created = new Date(m.createdAt).toLocaleString();
                      const cost = m.totalCostUsd ? " · $" + m.totalCostUsd.toFixed(2) : "";
                      const failedPart = totals.failed ? " · " + totals.failed + " failed" : "";
                      meta.textContent = created + " · " + totals.done + "/" + totals.total + " done" + failedPart + cost;
                    }
                    const progress = card.querySelector(".run-progress");
                    if (progress) {
                      progress.setAttribute("aria-valuenow", totals.done + totals.failed);
                      progress.setAttribute("aria-valuemax", totals.total);
                      progress.querySelector("span").style.width = (totals.total ? Math.round((totals.done + totals.failed) / totals.total * 100) : 0) + "%";
                    }
                  }
                  if (!document.querySelector(".run-card .pill-running")) clearInterval(timer);
                } catch {} finally { busy = false; }
              };
              const timer = setInterval(refresh, 10000);
              document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
            })();
            (function () {
              const input = document.getElementById("cc-input");
              const btn = document.getElementById("cc-save");
              const msg = document.getElementById("cc-msg");
              btn.addEventListener("click", async () => {
                const n = Number(input.value);
                msg.textContent = "Saving…";
                btn.disabled = true;
                const r = await fetch("/eval/api/settings", {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ maxConcurrent: n }),
                });
                btn.disabled = false;
                if (r.ok) { msg.textContent = "Saved"; setTimeout(() => msg.textContent = "", 1500); }
                else { const j = await r.json().catch(() => ({})); msg.textContent = j.error || "Save failed"; }
              });
            })();
            (function wireDelete() {
              const modal = document.getElementById("confirmModal");
              const body = document.getElementById("confirmBody");
              const okBtn = document.getElementById("confirmOk");
              const cancelBtn = document.getElementById("confirmCancel");
              const backdrop = modal.querySelector(".confirm-backdrop");
              let pending = null;

              function closeConfirm() { modal.style.display = "none"; document.body.style.overflow = ""; pending = null; okBtn.disabled = false; okBtn.textContent = "Delete"; }
              function openConfirm(runId, name, triggerBtn) {
                pending = { runId, triggerBtn };
                body.textContent = "Delete run “" + name + "”? This permanently removes all generated images.";
                modal.style.display = "block";
                document.body.style.overflow = "hidden";
                setTimeout(() => okBtn.focus(), 0);
              }
              cancelBtn.addEventListener("click", closeConfirm);
              backdrop.addEventListener("click", closeConfirm);
              document.addEventListener("keydown", (ev) => {
                if (modal.style.display === "none") return;
                if (ev.key === "Escape") { ev.preventDefault(); closeConfirm(); }
                else if (ev.key === "Enter") { ev.preventDefault(); okBtn.click(); }
              });
              okBtn.addEventListener("click", async () => {
                if (!pending) return;
                okBtn.disabled = true;
                okBtn.textContent = "Deleting…";
                try {
                  const r = await fetch("/eval/api/runs/" + encodeURIComponent(pending.runId), { method: "DELETE" });
                  if (r.ok) { location.reload(); return; }
                  throw new Error("Delete failed (" + r.status + ")");
                } catch (err) {
                  okBtn.disabled = false;
                  okBtn.textContent = "Delete";
                  body.textContent = err.message || "Delete failed.";
                }
              });

              document.addEventListener("click", (ev) => {
                const btn = ev.target.closest("[data-delete-run]");
                if (!btn) return;
                ev.preventDefault();
                ev.stopPropagation();
                const card = btn.closest(".run-card");
                const name = card ? card.dataset.runName : btn.dataset.deleteRun;
                openConfirm(btn.dataset.deleteRun, name, btn);
              });
            })();
            (function wireGroupTabs() {
              const STORAGE_KEY = "eval-active-group";
              const tabs = document.querySelectorAll(".group-tab");
              if (!tabs.length) return;
              const saved = localStorage.getItem(STORAGE_KEY) || "";

              function applyFilter(filter) {
                tabs.forEach((t) => t.classList.toggle("active", (t.dataset.groupFilter || "") === filter));
                document.querySelectorAll(".run-card").forEach((card) => {
                  const g = card.dataset.runGroup || "";
                  let show;
                  if (filter === "") show = true;
                  else if (filter === "__ungrouped__") show = !g;
                  else show = (g === filter);
                  card.style.display = show ? "" : "none";
                });
                localStorage.setItem(STORAGE_KEY, filter);
              }

              const exists = [...tabs].some((t) => (t.dataset.groupFilter || "") === saved);
              applyFilter(exists ? saved : "");

              tabs.forEach((t) => t.addEventListener("click", () => applyFilter(t.dataset.groupFilter || "")));
            })();
            (function wireMove() {
              const modal = document.getElementById("moveModal");
              if (!modal) return;
              const chipsWrap = document.getElementById("moveChips");
              const input = document.getElementById("moveInput");
              const errEl = document.getElementById("moveError");
              const okBtn = document.getElementById("moveOk");
              const cancelBtn = document.getElementById("moveCancel");
              const clearBtn = document.getElementById("moveClear");
              const backdrop = modal.querySelector(".confirm-backdrop");
              let pending = null;

              function closeMove() { modal.style.display = "none"; document.body.style.overflow = ""; pending = null; errEl.textContent = ""; input.value = ""; okBtn.disabled = false; okBtn.textContent = "Move"; }
              function openMove(runId, currentGroup) {
                pending = { runId };
                input.value = currentGroup || "";
                errEl.textContent = "";
                modal.style.display = "block";
                document.body.style.overflow = "hidden";
                setTimeout(() => input.focus(), 0);
              }
              chipsWrap.addEventListener("click", (ev) => {
                const chip = ev.target.closest("[data-chip]");
                if (!chip) return;
                input.value = chip.dataset.chip;
                input.focus();
              });
              async function submitGroup(value) {
                if (!pending) return;
                const g = (value || "").trim().slice(0, 40);
                okBtn.disabled = true;
                okBtn.textContent = "Saving…";
                try {
                  const r = await fetch("/eval/api/runs/" + encodeURIComponent(pending.runId), {
                    method: "PATCH",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ group: g }),
                  });
                  if (!r.ok) throw new Error("Save failed (" + r.status + ")");
                  location.reload();
                } catch (err) {
                  okBtn.disabled = false;
                  okBtn.textContent = "Move";
                  errEl.textContent = err.message || "Save failed.";
                }
              }
              okBtn.addEventListener("click", () => submitGroup(input.value));
              clearBtn.addEventListener("click", () => submitGroup(""));
              cancelBtn.addEventListener("click", closeMove);
              backdrop.addEventListener("click", closeMove);
              document.addEventListener("keydown", (ev) => {
                if (modal.style.display === "none") return;
                if (ev.key === "Escape") { ev.preventDefault(); closeMove(); }
                else if (ev.key === "Enter" && document.activeElement === input) { ev.preventDefault(); okBtn.click(); }
              });

              document.addEventListener("click", (ev) => {
                const btn = ev.target.closest("[data-move-run]");
                if (!btn) return;
                ev.preventDefault();
                ev.stopPropagation();
                const card = btn.closest(".run-card");
                openMove(btn.dataset.moveRun, card ? (card.dataset.runGroup || "") : "");
              });
            })();
          </script>
        `;
        return pageShell({ title: "Experiments", body, userBar, magicHat });
}

function renderEvalNewPage({ activeStyles, activeBrands, photos, savedVariants, evalSettings, activeEvent, eventNames, existingGroups = [], userBar = "", magicHat = "" }) {

        const styleOptions = Object.entries(activeStyles).map(([k, s]) =>
            `<label class="inline"><input type="checkbox" name="styles" value="${escapeHtml(k)}"> ${escapeHtml(s.name)}</label>`).join("");
        const brandOptions = [`<label class="inline"><input type="checkbox" name="brands" value="" checked> (no brand)</label>`]
            .concat(Object.entries(activeBrands).map(([k, b]) =>
                `<label class="inline"><input type="checkbox" name="brands" value="${escapeHtml(k)}"> ${escapeHtml(b.name || k)}</label>`)).join("");
        const eventOptions = eventNames.map((n) =>
            `<option value="${escapeHtml(n)}" ${n === activeEvent ? "selected" : ""}>${escapeHtml(n)}</option>`).join("");
        const photoOptions = photos.length
            ? photos.map((p) =>
                `<label class="inline"><input type="checkbox" name="photos" value="${escapeHtml(p.filename)}" checked> ${escapeHtml(p.displayName || p.filename)}</label>`).join("")
            : `<p class="muted">No photos uploaded. <a href="/eval/photos">Upload one</a> first.</p>`;

        // Serialized for client-side background menu computation. Mirrors the
        // shape resolveBackgroundMenu() reads from — behavior + acceptsColorPalette
        // on styles; category + allowOriginal + scenes on brands.
        const stylesForBgJs = Object.fromEntries(Object.entries(activeStyles).map(([k, s]) => [k, {
            name: s.name || k,
            behavior: s.behavior || "normal",
        }]));
        const brandsForBgJs = Object.fromEntries(Object.entries(activeBrands).map(([k, b]) => [k, {
            name: b.name || k,
            category: b.category || "wardrobe-only",
            allowOriginal: b.allowOriginal !== false,
            scenes: Array.isArray(b.scenes) ? b.scenes.filter((s) => s && s.key && s.name).map((s) => ({ key: s.key, name: s.name })) : [],
        }]));

        const stylesForJs = Object.fromEntries(Object.entries(activeStyles).map(([k, s]) => [k, { prompt: s.prompt || "", core: s.core || "", brandCore: s.brandCore || "" }]));
        const savedForJs = savedVariants.map((v) => ({ name: v.name, description: v.description || "", overrides: v.overrides || {} }));
        const savedOptions = savedVariants.length
            ? `<option value="">— Load a saved variant —</option>` + savedVariants.map((v) =>
                `<option value="${escapeHtml(v.name)}">${escapeHtml(v.name)}${v.description ? ` — ${escapeHtml(v.description.slice(0, 60))}` : ""}</option>`).join("")
            : "";

        const groupDatalist = existingGroups.map((g) => `<option value="${escapeHtml(g)}"></option>`).join("");

        const body = `
          ${evalNav("new")}
          <header class="eval-hero eval-new-hero"><div><h1>New experiment</h1><p>Choose the photos and prompts to compare. Review the run size before starting.</p></div><a class="eval-back-link" href="/eval">Back to runs</a></header>
          <form id="f" class="eval-form-layout">
            <div class="eval-form-main">
            <div class="eval-form-section-title"><h2>Run details</h2><p>Name this test and choose the event settings it will use.</p></div>
            <div class="card eval-form-card">
              <label><span class="label-text">Name</span><input name="name" required placeholder="e.g. cartoon-length-v2"></label>
              <label style="margin-top:12px;"><span class="label-text">Group (optional)</span>
                <span class="label-hint">Organize related runs under a label (e.g. "pop-art tuning", "launch prep"). Pick an existing group or type a new one. Leave blank for ungrouped.</span>
                <input name="group" list="groupOptions" placeholder="e.g. magazine-cover exploration" maxlength="40">
                <datalist id="groupOptions">${groupDatalist}</datalist>
              </label>
              <label style="margin-top:12px;"><span class="label-text">Event</span>
                <span class="label-hint">Which event's settings (prompts, brands, backgrounds) to use when generating. Defaults to the currently-selected event.</span>
                <select name="eventName">${eventOptions}</select>
              </label>
            </div>

            <div class="eval-form-section-title"><h2>Image choices</h2><p>Select the look, branding, backgrounds, and test photos.</p></div>
            <fieldset class="eval-form-card">
              <legend>Styles</legend>
              <div class="legend-hint">Which style prompts to evaluate.</div>
              <div class="options-grid">${styleOptions}</div>
            </fieldset>

            <fieldset class="eval-form-card">
              <legend>Brands</legend>
              <div class="legend-hint">Leave <span class="code">(no brand)</span> checked to test without brand overlays.</div>
              <div class="options-grid">${brandOptions}</div>
            </fieldset>

            <fieldset class="eval-form-card">
              <legend>Backgrounds</legend>
              <div class="legend-hint">Scene options update as you pick styles and brands. Brand-specific scenes (e.g. Chelsea's <span class="code">Stamford Bridge</span>) appear only when that brand is checked. <span class="code">Original</span> and <span class="code">Solid White</span> are hidden for combos that don't support them.</div>
              <div id="bgOptions" class="stack" style="gap:14px;">
                <p class="muted small">Pick at least one style and brand to see background options.</p>
              </div>
            </fieldset>

            <details class="eval-optional-block"><summary>Reviewer feedback <span>Optional prompt correction</span></summary><div class="eval-optional-body">
              <label style="margin:0;"><span class="label-text">Reviewer feedback (optional)</span>
                <span class="label-hint">Drops a one-shot correction into the prompt — same field AI Review uses in the live flow. Leave blank for a clean run.</span>
                <textarea name="reviewFeedback" style="min-height:60px;" placeholder="e.g. last run drew the hat wrong; keep it centered and facing forward"></textarea>
              </label>
            </div></details>

            <fieldset class="eval-form-card">
              <legend>Photos</legend>
              <div class="legend-hint">Upload test photos via the <a href="/eval/photos">Photos</a> tab.</div>
              <div class="eval-selection-actions"><button type="button" data-select-photos="all">Select all</button><button type="button" data-select-photos="none">Clear</button></div>
              <div class="options-grid eval-photo-options">${photoOptions}</div>
            </fieldset>

            <div class="eval-form-section-title"><h2>Run controls</h2><p>Control the number of samples and how quickly they generate.</p></div>
            <div class="card eval-form-card">
              <div class="row" style="gap:24px;flex-wrap:wrap;align-items:flex-start;">
                <label style="flex:1;min-width:220px;margin-bottom:0;"><span class="label-text">Reps per combination</span>
                  <span class="label-hint">gpt-image-2 is non-deterministic. 5 reps reveals how much variance a prompt has.</span>
                  <input type="number" name="reps" value="5" min="1" max="10" style="max-width:120px;">
                </label>
                <label style="flex:1;min-width:220px;margin-bottom:0;"><span class="label-text">Max concurrent generations</span>
                  <span class="label-hint">Parallel image-edit requests. Higher = faster but more rate-limit risk. Defaults to your global setting (currently ${evalSettings.maxConcurrent}).</span>
                  <input type="number" name="maxConcurrent" value="${evalSettings.maxConcurrent}" min="${MIN_CONCURRENT}" max="${MAX_CONCURRENT_CAP}" style="max-width:120px;">
                </label>
              </div>
            </div>

            <div class="eval-form-section-title"><h2>Compare prompts</h2><p>Include the live prompt, add your own, or load one you saved.</p></div>
            <fieldset class="eval-form-card">
              <legend>Variants</legend>
              <div class="legend-hint">Each variant becomes a row in the output grid. <strong>live</strong> = your current production prompt. Custom variants let you tweak prompts and A/B test them.</div>
              <label class="inline"><input type="checkbox" name="includeLive" checked> Include <strong>live</strong> variant</label>
              <div id="customVariants" class="stack" style="margin-top:16px;"></div>
              <div class="cluster" style="margin-top:12px;">
                <button type="button" class="btn btn-secondary btn-sm" id="addVariant">+ Add custom variant</button>
                ${savedOptions ? `<select id="loadSaved" style="max-width:280px;">${savedOptions}</select>` : `<span class="muted small">No saved variants yet — create one below and click <strong>Save</strong> to reuse it.</span>`}
              </div>
            </fieldset>

            </div>
            <aside class="eval-plan" aria-labelledby="runPlanTitle"><div class="eval-plan-inner">
              <div class="eval-plan-heading"><h2 id="runPlanTitle">Run plan</h2><p>Updates as you make selections.</p></div>
              <div class="eval-plan-count"><strong id="estimateCount">0</strong><span>images to generate</span></div>
              <div class="eval-plan-detail"><span>Estimated image cost</span><strong id="estimateCost">$0.00</strong></div>
              <div class="eval-plan-detail"><span>Run limit</span><strong>${MAX_ENTRIES_PER_EXPERIMENT} images</strong></div>
              <p class="eval-plan-hint" id="estimateHint" role="status" aria-live="polite">Choose a style to calculate the run.</p>
              <button class="btn eval-run-submit" type="submit">Run experiment</button>
              <div id="err" class="err" role="alert" aria-live="polite"></div>
              <p class="eval-plan-footnote">Runs generate images and may incur API charges.</p>
            </div></aside>
          </form>
          <script>
          const LIVE_STYLES = ${jsonForScript(stylesForJs)};
          const SAVED_VARIANTS = ${jsonForScript(savedForJs)};
          const BG_STYLES = ${jsonForScript(stylesForBgJs)};
          const BG_BRANDS = ${jsonForScript(brandsForBgJs)};
          let variantCounter = 0;

          // Mirrors resolveBackgroundMenu() in lib/prompt-assembler.js. Keep
          // in sync — this is the user-facing preview of what the server will
          // actually produce per (style, brand) combination.
          function computeBgMenu(styleKey, brandKey) {
              const style = BG_STYLES[styleKey] || { behavior: "normal" };
              const brand = brandKey ? BG_BRANDS[brandKey] : null;
              const options = [];
              const scenes = (brand && brand.scenes) || [];
              for (const s of scenes) options.push({ key: s.key, name: s.name });
              const allowOriginal = !brand || brand.allowOriginal !== false;
              const isWardrobePlusScene = brand && brand.category === "wardrobe-plus-scene";
              if (allowOriginal && !isWardrobePlusScene) options.push({ key: "original", name: "Original scene" });
              const isContainer = style && style.behavior === "themed-container";
              if (!isContainer && !isWardrobePlusScene) options.push({ key: "plain-white", name: "Solid White" });
              return options;
          }

          function renderBgOptions() {
              const container = document.getElementById("bgOptions");
              const styles = [...document.querySelectorAll("[name=styles]:checked")].map(x => x.value);
              const brands = [...document.querySelectorAll("[name=brands]:checked")].map(x => x.value);
              const prev = new Set([...container.querySelectorAll("input[type=checkbox]:checked")].map(x => x.dataset.selector));
              const firstRender = !container.querySelector("input[type=checkbox]");
              container.replaceChildren();
              if (!styles.length || !brands.length) {
                  const empty = document.createElement("p");
                  empty.className = "muted small";
                  empty.textContent = "Pick at least one style and brand to see background options.";
                  container.appendChild(empty);
                  updateEstimate();
                  return;
              }
              for (const brand of brands) {
                  const brandLabel = brand ? (BG_BRANDS[brand] ? BG_BRANDS[brand].name : brand) : "(no brand)";
                  const union = new Map();
                  for (const sk of styles) for (const opt of computeBgMenu(sk, brand || "")) union.set(opt.key, opt.name);
                  if (!union.size) continue;
                  const group = document.createElement("div");
                  group.className = "eval-background-group";
                  const heading = document.createElement("strong");
                  heading.textContent = brandLabel;
                  group.appendChild(heading);
                  const options = document.createElement("div");
                  options.className = "options-grid";
                  for (const [key, name] of union) {
                      const sel = (brand || "") + "::" + key;
                      const label = document.createElement("label");
                      label.className = "inline";
                      const checkbox = document.createElement("input");
                      checkbox.type = "checkbox";
                      checkbox.name = "bgChoice";
                      checkbox.dataset.brand = brand || "";
                      checkbox.dataset.bg = key;
                      checkbox.dataset.selector = sel;
                      checkbox.checked = firstRender || prev.has(sel);
                      label.append(checkbox, document.createTextNode(" " + name));
                      options.appendChild(label);
                  }
                  group.appendChild(options);
                  container.appendChild(group);
              }
              if (!container.children.length) {
                  const empty = document.createElement("p");
                  empty.className = "muted small";
                  empty.textContent = "No background options are available for this combination.";
                  container.appendChild(empty);
              }
              updateEstimate();
          }

          function updateEstimate() {
              const form = document.getElementById("f");
              const styles = [...form.querySelectorAll("[name=styles]:checked")].map(x => x.value);
              const brands = [...form.querySelectorAll("[name=brands]:checked")].map(x => x.value);
              const photos = form.querySelectorAll("[name=photos]:checked").length;
              const variants = Number(form.querySelector("[name=includeLive]").checked) + form.querySelectorAll("#customVariants > [data-variant]").length;
              const reps = Math.max(1, Math.min(10, Number(form.elements.namedItem("reps").value) || 1));
              const selected = new Map();
              for (const checkbox of form.querySelectorAll("[name=bgChoice]:checked")) {
                  const key = checkbox.dataset.brand || "";
                  if (!selected.has(key)) selected.set(key, new Set());
                  selected.get(key).add(checkbox.dataset.bg);
              }
              let combinations = 0;
              for (const style of styles) for (const brand of brands) {
                  const allowed = selected.get(brand || "") || new Set();
                  combinations += computeBgMenu(style, brand).filter((option) => allowed.has(option.key)).length;
              }
              const count = photos * variants * reps * combinations;
              document.getElementById("estimateCount").textContent = count.toLocaleString();
              document.getElementById("estimateCost").textContent = "$" + (count * ${COST_PER_IMAGE_USD}).toFixed(2);
              const hint = document.getElementById("estimateHint");
              if (!styles.length) hint.textContent = "Choose at least one style.";
              else if (!brands.length) hint.textContent = "Choose at least one brand option.";
              else if (!photos) hint.textContent = "Choose at least one test photo.";
              else if (!selected.size || !combinations) hint.textContent = "Choose a background for the selected images.";
              else if (!variants) hint.textContent = "Include the live prompt or add a custom variant.";
              else if (variants > ${MAX_VARIANTS_PER_EXPERIMENT}) hint.textContent = "The run allows at most ${MAX_VARIANTS_PER_EXPERIMENT} variants.";
              else if (count > ${MAX_ENTRIES_PER_EXPERIMENT}) hint.textContent = "This exceeds the ${MAX_ENTRIES_PER_EXPERIMENT}-image limit. Reduce selections or reps.";
              else hint.textContent = "Ready to generate " + count.toLocaleString() + " images.";
              form.querySelector("button[type=submit]").disabled = !count || count > ${MAX_ENTRIES_PER_EXPERIMENT} || variants > ${MAX_VARIANTS_PER_EXPERIMENT};
          }

          document.querySelectorAll("[name=styles], [name=brands]").forEach((el) => el.addEventListener("change", renderBgOptions));
          document.getElementById("f").addEventListener("change", updateEstimate);
          document.getElementById("f").addEventListener("input", (event) => { if (event.target.name === "reps") updateEstimate(); });
          document.querySelectorAll("[data-select-photos]").forEach((button) => button.addEventListener("click", () => {
              const checked = button.dataset.selectPhotos === "all";
              document.querySelectorAll("[name=photos]").forEach((input) => { input.checked = checked; });
              updateEstimate();
          }));
          renderBgOptions();
          function autogrow(ta) {
              ta.style.height = "auto";
              ta.style.height = Math.max(ta.scrollHeight + 2, 80) + "px";
          }
          function makeField(labelText, hint, styleKey, field, value, variantId, minH) {
              const lbl = document.createElement("label");
              lbl.style.cssText = "display:block;margin-top:10px;margin-bottom:0;";
              const name = document.createElement("span");
              name.className = "label-text";
              name.textContent = labelText;
              lbl.appendChild(name);
              if (hint) { const h = document.createElement("span"); h.className = "label-hint"; h.textContent = hint; lbl.appendChild(h); }
              const ta = document.createElement("textarea");
              ta.dataset.variant = variantId;
              ta.dataset.style = styleKey;
              ta.dataset.field = field;
              ta.style.minHeight = minH + "px";
              ta.value = value || "";
              ta.addEventListener("input", () => autogrow(ta));
              lbl.appendChild(ta);
              setTimeout(() => autogrow(ta), 0);
              return lbl;
          }
          function buildVariantBlock(preset) {
              // preset = { name, description, overrides } or null for "from current styles".
              // overrides arrives from the API in v2 shape { styles: {...}, brands: {...} };
              // legacy files in v1 flat shape { <styleKey>: {...} } are migrated on read,
              // but handle both defensively. This form only edits style overrides today.
              const styleOverrides = (preset && preset.overrides && preset.overrides.styles)
                  || (preset && preset.overrides)
                  || {};
              const checkedStyles = [...document.querySelectorAll("[name=styles]:checked")].map(x => x.value);
              const stylesForBlock = preset && preset.overrides
                  ? [...new Set([...Object.keys(styleOverrides), ...checkedStyles])]
                  : checkedStyles;
              if (!stylesForBlock.length) {
                  document.getElementById("err").textContent = "Pick at least one style before adding a variant";
                  return null;
              }
              document.getElementById("err").textContent = "";
              const id = "v" + (++variantCounter);
              const block = document.createElement("div");
              block.className = "card";
              block.dataset.variant = id;

              const header = document.createElement("div");
              header.className = "row row-top";
              const headerLeft = document.createElement("div");
              headerLeft.style.flex = "1";
              const nameLbl = document.createElement("label");
              const nameTxt = document.createElement("span");
              nameTxt.className = "label-text";
              nameTxt.textContent = "Variant name";
              nameLbl.appendChild(nameTxt);
              const nameInput = document.createElement("input");
              nameInput.setAttribute("data-variant-name", id);
              nameInput.value = (preset && preset.name) || ("custom-" + variantCounter);
              nameLbl.appendChild(nameInput);
              headerLeft.appendChild(nameLbl);

              const descLbl = document.createElement("label");
              const descTxt = document.createElement("span");
              descTxt.className = "label-text";
              descTxt.textContent = "Description (optional)";
              descLbl.appendChild(descTxt);
              const descInput = document.createElement("input");
              descInput.setAttribute("data-variant-desc", id);
              descInput.value = (preset && preset.description) || "";
              descInput.placeholder = "e.g. shorter core, stricter face preservation";
              descLbl.appendChild(descInput);
              headerLeft.appendChild(descLbl);

              const btnCluster = document.createElement("div");
              btnCluster.className = "cluster";
              const saveBtn = document.createElement("button");
              saveBtn.type = "button";
              saveBtn.className = "btn btn-secondary btn-sm";
              saveBtn.textContent = "Save to library";
              saveBtn.addEventListener("click", () => saveVariantToLibrary(block, saveBtn));
              const removeBtn = document.createElement("button");
              removeBtn.type = "button";
              removeBtn.className = "btn btn-danger btn-sm";
              removeBtn.textContent = "Remove";
              removeBtn.addEventListener("click", () => { block.remove(); updateEstimate(); });
              btnCluster.appendChild(saveBtn);
              btnCluster.appendChild(removeBtn);

              header.appendChild(headerLeft);
              header.appendChild(btnCluster);
              block.appendChild(header);

              const stylesWrap = document.createElement("div");
              stylesWrap.style.cssText = "margin-top:16px;display:flex;flex-direction:column;gap:10px;";
              stylesForBlock.forEach((sk) => {
                  const base = styleOverrides[sk] || LIVE_STYLES[sk] || { prompt: "", core: "", brandCore: "" };
                  const det = document.createElement("details");
                  det.className = "override-block";
                  det.open = stylesForBlock.length === 1;
                  const sum = document.createElement("summary");
                  sum.textContent = sk;
                  det.appendChild(sum);
                  det.appendChild(makeField("prompt", "The main style instruction sent to gpt-image-2.", sk, "prompt", base.prompt, id, 180));
                  det.appendChild(makeField("core", "The short style tag embedded in composed prompts.", sk, "core", base.core, id, 90));
                  det.appendChild(makeField("brandCore", "Short version used when a brand is present.", sk, "brandCore", base.brandCore, id, 90));
                  stylesWrap.appendChild(det);
              });
              block.appendChild(stylesWrap);
              document.getElementById("customVariants").appendChild(block);
              updateEstimate();
              return block;
          }
          async function saveVariantToLibrary(block, btn) {
              const id = block.dataset.variant;
              const name = block.querySelector("[data-variant-name='" + id + "']").value.trim();
              const description = block.querySelector("[data-variant-desc='" + id + "']").value.trim();
              if (!name) { document.getElementById("err").textContent = "Variant needs a name before saving"; return; }
              const overrides = {};
              block.querySelectorAll("textarea[data-variant='" + id + "']").forEach((ta) => {
                  if (!overrides[ta.dataset.style]) overrides[ta.dataset.style] = {};
                  overrides[ta.dataset.style][ta.dataset.field] = ta.value;
              });
              btn.disabled = true;
              const orig = btn.textContent;
              btn.textContent = "Saving…";
              const r = await fetch("/eval/api/variants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, description, overrides }) });
              if (r.ok) { btn.textContent = "Saved"; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500); }
              else {
                  const j = await r.json().catch(() => ({}));
                  const overwrite = r.status === 409
                      ? await twModal.confirm({ title: "Overwrite variant?", message: "Variant '" + name + "' already exists.", confirmText: "Overwrite", danger: true })
                      : false;
                  if (overwrite) {
                      const r2 = await fetch("/eval/api/variants/" + encodeURIComponent(name), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ description, overrides }) });
                      if (r2.ok) { btn.textContent = "Updated"; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500); return; }
                  }
                  document.getElementById("err").textContent = j.error || "Save failed";
                  btn.textContent = orig; btn.disabled = false;
              }
          }
          document.getElementById("addVariant").addEventListener("click", () => buildVariantBlock(null));
          fetch("/eval/api/groups").then((response) => response.ok ? response.json() : { groups: [] }).then((payload) => {
              const list = document.getElementById("groupOptions");
              if (!list) return;
              for (const group of payload.groups || []) {
                  const option = document.createElement("option");
                  option.value = group;
                  list.appendChild(option);
              }
          }).catch(() => {});
          const loadSaved = document.getElementById("loadSaved");
          if (loadSaved) loadSaved.addEventListener("change", (ev) => {
              const v = SAVED_VARIANTS.find((x) => x.name === ev.target.value);
              if (v) buildVariantBlock(v);
              ev.target.value = "";
          });
          document.getElementById("f").addEventListener("submit", async (e) => {
              e.preventDefault();
              const f = e.target;
              const submit = f.querySelector("button[type=submit]");
              const error = document.getElementById("err");
              error.textContent = "";
              const estimated = Number(document.getElementById("estimateCount").textContent.replace(/,/g, ""));
              if (!estimated || estimated > ${MAX_ENTRIES_PER_EXPERIMENT}) {
                  error.textContent = document.getElementById("estimateHint").textContent;
                  return;
              }
              submit.disabled = true;
              submit.textContent = "Starting run…";
              const variants = [];
              if (f.elements.namedItem("includeLive").checked) variants.push({ name: "live", type: "live" });
              document.querySelectorAll("#customVariants > [data-variant]").forEach((block) => {
                  const id = block.dataset.variant;
                  const name = block.querySelector("[data-variant-name='" + id + "']").value.trim() || "custom";
                  const descEl = block.querySelector("[data-variant-desc='" + id + "']");
                  const description = descEl ? descEl.value.trim() : "";
                  const overrides = {};
                  block.querySelectorAll("textarea[data-variant='" + id + "']").forEach((ta) => {
                      const sk = ta.dataset.style;
                      if (!overrides[sk]) overrides[sk] = {};
                      overrides[sk][ta.dataset.field] = ta.value;
                  });
                  variants.push({ name, type: "custom", description, overrides });
              });
              const data = {
                  name: f.elements.namedItem("name").value.trim(),
                  group: f.elements.namedItem("group").value.trim(),
                  eventName: f.elements.namedItem("eventName").value,
                  styles: [...f.querySelectorAll("[name=styles]:checked")].map(x => x.value),
                  brands: [...f.querySelectorAll("[name=brands]:checked")].map(x => x.value || null),
                  bgSelections: [...f.querySelectorAll("[name=bgChoice]:checked")].map(x => ({ brand: x.dataset.brand || null, bg: x.dataset.bg })),
                  photos: [...f.querySelectorAll("[name=photos]:checked")].map(x => x.value),
                  reps: parseInt(f.elements.namedItem("reps").value, 10) || 5,
                  maxConcurrent: parseInt(f.elements.namedItem("maxConcurrent").value, 10),
                  reviewFeedback: f.elements.namedItem("reviewFeedback").value.trim(),
                  variants,
              };
              try {
                  const r = await fetch("/eval/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
                  const j = await r.json();
                  if (r.ok) { location.href = "/eval/run/" + encodeURIComponent(j.id); return; }
                  error.textContent = j.error || "Could not start the run";
              } catch (err) {
                  error.textContent = err.message || "Could not start the run";
              }
              submit.textContent = "Run experiment";
              updateEstimate();
          });
          </script>
        `;
        return pageShell({ title: "New experiment", body, userBar, magicHat });
}

function renderEvalPhotosPage({ photos = [], userBar = "", magicHat = "" } = {}) {
        const list = photos.map((p) => `
          <article class="eval-library-row">
            <div class="eval-library-row-main">
              <div class="eval-library-row-title"><strong>${escapeHtml(p.displayName || p.filename)}</strong><span class="eval-library-date">${escapeHtml(new Date(p.uploadedAt).toLocaleDateString())}</span></div>
              <div class="eval-library-file">${escapeHtml(p.filename)}</div>
              ${p.sceneDescription ? `<p class="eval-library-desc">${escapeHtml(p.sceneDescription.slice(0, 240))}${p.sceneDescription.length > 240 ? "…" : ""}</p>` : `<p class="eval-library-desc">Scene analysis pending</p>`}
            </div>
            <button class="btn btn-secondary btn-sm" type="button" data-del="${escapeHtml(p.filename)}">Delete</button>
          </article>`).join("");
        const body = `
          ${evalNav("photos")}
          <main class="eval-photos">
            <header class="eval-hero"><div><h1>Test photos</h1><p>Use a consistent set of portraits to compare prompt changes across runs.</p></div><a class="eval-back-link" href="/eval/new">Create a run</a></header>
            <div class="eval-library-layout">
              <section class="eval-upload-panel" aria-labelledby="evalUploadTitle">
                <div class="eval-section-head"><h2 id="evalUploadTitle">Add a photo</h2><p>JPEG photos are analyzed once, then reused in future runs.</p></div>
                <label for="file"><span class="label-text">JPEG file</span><input type="file" id="file" accept="image/jpeg" aria-label="Test photo file"></label>
                <label for="displayName"><span class="label-text">Display name <span class="eval-optional-label">optional</span></span><input type="text" id="displayName" placeholder="e.g. Anthony" aria-label="Display name (optional)"></label>
                <p class="eval-upload-note">Scene analysis may take a few seconds after upload.</p>
                <div class="eval-upload-footer"><span class="muted small" id="msg" role="status" aria-live="polite"></span><button class="btn" type="button" id="upload">Upload photo</button></div>
              </section>
              <section class="eval-library-panel" aria-labelledby="evalLibraryTitle">
                <div class="eval-section-head eval-library-heading"><div><h2 id="evalLibraryTitle">Photo library</h2><p>Available for every new run</p></div><span class="eval-library-count">${photos.length} photo${photos.length === 1 ? "" : "s"}</span></div>
                <div class="eval-library-list">${list || '<div class="eval-library-empty"><strong>No photos yet</strong><p>Upload a JPEG to start your test library.</p></div>'}</div>
              </section>
            </div>
          </main>
          <script>
          document.getElementById("upload").addEventListener("click", async () => {
              const f = document.getElementById("file").files[0];
              const dn = document.getElementById("displayName").value;
              const msg = document.getElementById("msg");
              if (!f) { msg.textContent = "Pick a JPEG first"; return; }
              const qs = "?filename=" + encodeURIComponent(f.name) + (dn ? "&displayName=" + encodeURIComponent(dn) : "");
              msg.textContent = "Uploading (scene analysis may take a few seconds)…";
              document.getElementById("upload").disabled = true;
              const r = await fetch("/eval/api/photos" + qs, { method: "POST", headers: { "content-type": "image/jpeg" }, body: f });
              if (r.ok) location.reload();
              else {
                  const j = await r.json().catch(() => ({}));
                  msg.textContent = j.error || "Upload failed";
                  document.getElementById("upload").disabled = false;
              }
          });
          document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
              const ok = await twModal.confirm({ title: "Delete " + b.dataset.del + "?", confirmText: "Delete", danger: true });
              if (!ok) return;
              const r = await fetch("/eval/api/photos/" + encodeURIComponent(b.dataset.del), { method: "DELETE" });
              if (r.ok) location.reload();
              else { const j = await r.json().catch(() => ({})); await twModal.alert({ title: "Delete failed", message: j.error || "Check the server logs." }); }
          }));
          </script>
        `;
        return pageShell({ title: "Test photos", body, userBar, magicHat });
}

function renderEvalVariantsPage({ variants = [], activeStyles = {}, activeBrands = {}, userBar = "", magicHat = "" } = {}) {
        const styleKeys = Object.keys(activeStyles);
        const brandKeys = Object.keys(activeBrands);

        const cards = variants.map((v, i) => {
            const ov = v.overrides || { styles: {}, brands: {} };
            const styleList = Object.keys(ov.styles || {});
            const brandList = Object.keys(ov.brands || {});
            const chips = [
                ...styleList.map((k) => `<code class="kbd">${escapeHtml(k)}</code>`),
                ...brandList.map((k) => `<code class="kbd">${escapeHtml(k)}</code>`),
            ];
            const preview = chips.length ? chips.join(" ") : '<span class="muted">(no overrides)</span>';
            return `
              <article class="card eval-variant-card" data-variant-idx="${i}">
                <div class="row row-top eval-variant-card-head">
                  <div style="flex:1;min-width:0;">
                    <div class="eval-variant-name">${escapeHtml(v.name)}</div>
                    <div class="eval-variant-meta">${escapeHtml(new Date(v.createdAt).toLocaleDateString())}${v.updatedAt ? ` · edited ${escapeHtml(new Date(v.updatedAt).toLocaleDateString())}` : ""} · ${styleList.length} style${styleList.length === 1 ? "" : "s"}${brandList.length ? ` · ${brandList.length} brand${brandList.length === 1 ? "" : "s"}` : ""}</div>
                  </div>
                  <div class="cluster eval-variant-actions">
                    <button class="btn btn-secondary btn-sm" type="button" data-edit="${escapeHtml(v.name)}">Edit</button>
                    <button class="btn btn-secondary btn-sm" type="button" data-del="${escapeHtml(v.name)}">Delete</button>
                  </div>
                </div>
                ${v.description ? `<p class="eval-variant-description">${escapeHtml(v.description)}</p>` : ""}
                <div class="eval-variant-chips">${preview}</div>
              </article>`;
        }).join("");

        const body = `
          ${evalNav("variants")}
          <main class="eval-variants">
            <header class="eval-hero"><div><h1>Saved variants</h1><p>Reuse prompt and brand overrides across experiments.</p></div><button class="btn" type="button" id="new-variant-btn">New variant</button></header>
            <section class="eval-library-panel" aria-labelledby="evalVariantLibraryTitle">
              <div class="eval-section-head eval-library-heading"><div><h2 id="evalVariantLibraryTitle">Variant library</h2><p>Choose a variant when you set up a new run.</p></div><span class="eval-library-count">${variants.length} variant${variants.length === 1 ? "" : "s"}</span></div>
              <div class="eval-variant-list">${variants.length ? cards : `<div class="eval-library-empty"><strong>No saved variants yet</strong><p>Build one in the <a href="/eval/new">new run form</a> and choose <strong>Save to library</strong> on a custom variant.</p></div>`}</div>
            </section>

          <div id="variant-editor" class="v-modal" role="dialog" aria-modal="true" aria-labelledby="editor-title" hidden>
            <div class="v-modal-backdrop" data-close-editor></div>
            <div class="v-modal-panel">
              <div class="row" style="margin-bottom:12px;">
                <h3 id="editor-title">Edit variant</h3>
                <button class="btn btn-secondary btn-sm" data-close-editor>Close</button>
              </div>
              <label>Name<input type="text" id="editor-name" placeholder="e.g. trimmed-cartoon-v2"></label>
              <label>Description<input type="text" id="editor-desc" placeholder="Short note about what this variant changes"></label>
              <h2 style="margin-top:16px;">Style overrides</h2>
              <div class="muted small" style="margin-bottom:8px;">Leave a field blank to inherit from live. Expanded styles override all filled-in fields.</div>
              <div id="editor-styles" class="stack"></div>
              <h2 style="margin-top:20px;">Brand overrides</h2>
              <div class="muted small" style="margin-bottom:8px;">Override per-brand settings — wardrobe text, color palette, category, per-scene prompts. Scene file references are not editable here.</div>
              <div id="editor-brands" class="stack"></div>
              <div class="row" style="margin-top:16px;">
                <div class="muted small" id="editor-msg" role="status" aria-live="polite"></div>
                <div class="cluster">
                  <button class="btn btn-secondary" data-close-editor>Cancel</button>
                  <button class="btn" id="editor-save">Save</button>
                </div>
              </div>
            </div>
          </div>
          </main>

          <script>
            const STYLE_KEYS = ${jsonForScript(styleKeys)};
            const STYLE_LIVE = ${jsonForScript(
                Object.fromEntries(styleKeys.map((k) => [k, {
                    prompt: activeStyles[k].prompt || "",
                    core: activeStyles[k].core || "",
                    brandCore: activeStyles[k].brandCore || "",
                    behavior: activeStyles[k].behavior || "normal",
                    containerDescription: activeStyles[k].containerDescription || "",
                    acceptsColorPalette: activeStyles[k].acceptsColorPalette !== false,
                }]))
            )};
            const BRAND_KEYS = ${jsonForScript(brandKeys)};
            const BRAND_LIVE = ${jsonForScript(
                Object.fromEntries(brandKeys.map((k) => [k, {
                    name: activeBrands[k].name || k,
                    category: activeBrands[k].category || "wardrobe-only",
                    wardrobe: activeBrands[k].wardrobe || "",
                    colorPalette: activeBrands[k].colorPalette || "",
                    allowOriginal: activeBrands[k].allowOriginal !== false,
                    scenes: Array.isArray(activeBrands[k].scenes)
                        ? activeBrands[k].scenes.filter((s) => s && s.key && s.name).map((s) => ({ key: s.key, name: s.name, prompt: s.prompt || "" }))
                        : [],
                }]))
            )};
            const VARIANTS = ${jsonForScript(variants)};

            const editor = document.getElementById("variant-editor");
            const editorStyles = document.getElementById("editor-styles");
            const editorBrands = document.getElementById("editor-brands");
            const editorName = document.getElementById("editor-name");
            const editorDesc = document.getElementById("editor-desc");
            const editorTitle = document.getElementById("editor-title");
            const editorMsg = document.getElementById("editor-msg");
            let editingName = null;
            let restoreFocus = null;

            function escAttr(s) { return String(s || "").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }
            function escTxt(s) { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;"); }

            function hasStyleOv(o) { return !!(o && (o.prompt || o.core || o.brandCore || o.behavior || o.containerDescription != null || typeof o.acceptsColorPalette === "boolean")); }
            function hasBrandOv(o) {
                if (!o) return false;
                if (o.category || (o.wardrobe != null && o.wardrobe !== "") || (o.colorPalette != null && o.colorPalette !== "") || typeof o.allowOriginal === "boolean") return true;
                if (o.scenes && Object.values(o.scenes).some((s) => s && typeof s.prompt === "string" && s.prompt !== "")) return true;
                return false;
            }

            function renderEditorStyles(overrides) {
                const styleOv = (overrides && overrides.styles) || {};
                editorStyles.innerHTML = STYLE_KEYS.map((k) => {
                    const o = styleOv[k] || {};
                    const live = STYLE_LIVE[k] || {};
                    const isOverridden = hasStyleOv(o);
                    const behaviorLive = live.behavior || "normal";
                    const acpLive = live.acceptsColorPalette !== false;
                    const acpO = typeof o.acceptsColorPalette === "boolean" ? o.acceptsColorPalette : null;
                    const containerHint = escAttr((live.containerDescription || "").slice(0, 80));
                    return \`
                      <details class="card card-compact" \${isOverridden ? "open" : ""}>
                        <summary><strong>\${k}</strong> <span class="muted small">\${isOverridden ? "(overridden)" : "(unchanged)"}</span></summary>
                        <label>Prompt<textarea data-style="\${k}" data-field="prompt" rows="3" placeholder="\${escAttr((live.prompt || '').slice(0,80))}">\${escTxt(o.prompt || '')}</textarea></label>
                        <label>Core<textarea data-style="\${k}" data-field="core" rows="2" placeholder="\${escAttr((live.core || '').slice(0,80))}">\${escTxt(o.core || '')}</textarea></label>
                        <label>Brand core<textarea data-style="\${k}" data-field="brandCore" rows="2" placeholder="\${escAttr((live.brandCore || '').slice(0,80))}">\${escTxt(o.brandCore || '')}</textarea></label>
                        <label>Behavior <span class="muted small">(live: \${escTxt(behaviorLive)})</span>
                          <select data-style="\${k}" data-field="behavior">
                            <option value="">— inherit from live —</option>
                            <option value="normal" \${o.behavior === "normal" ? "selected" : ""}>normal</option>
                            <option value="themed-container" \${o.behavior === "themed-container" ? "selected" : ""}>themed-container</option>
                          </select>
                        </label>
                        <label>Container description <span class="muted small">(applies when behavior is themed-container)</span>
                          <textarea data-style="\${k}" data-field="containerDescription" rows="2" placeholder="\${containerHint}">\${escTxt(o.containerDescription || '')}</textarea>
                        </label>
                        <label>Accepts color palette <span class="muted small">(live: \${acpLive ? "yes" : "no"})</span>
                          <select data-style="\${k}" data-field="acceptsColorPalette">
                            <option value="">— inherit from live —</option>
                            <option value="true" \${acpO === true ? "selected" : ""}>yes</option>
                            <option value="false" \${acpO === false ? "selected" : ""}>no</option>
                          </select>
                        </label>
                      </details>\`;
                }).join("");
            }

            function renderEditorBrands(overrides) {
                const brandOv = (overrides && overrides.brands) || {};
                if (!BRAND_KEYS.length) {
                    editorBrands.innerHTML = '<div class="muted small">No brands configured in the current event.</div>';
                    return;
                }
                editorBrands.innerHTML = BRAND_KEYS.map((k) => {
                    const o = brandOv[k] || {};
                    const live = BRAND_LIVE[k] || { scenes: [] };
                    const isOverridden = hasBrandOv(o);
                    const sceneOv = o.scenes || {};
                    const scenesHtml = live.scenes.length
                        ? live.scenes.map((s) => {
                            const so = sceneOv[s.key] || {};
                            return \`
                              <label>Scene "\${escTxt(s.name)}" <span class="muted small">(key: \${escTxt(s.key)})</span>
                                <textarea data-brand="\${k}" data-scene="\${s.key}" data-field="prompt" rows="2" placeholder="\${escAttr((s.prompt || '').slice(0, 80))}">\${escTxt(so.prompt || '')}</textarea>
                              </label>\`;
                        }).join("")
                        : '<div class="muted small" style="margin-bottom:8px;">No scenes defined for this brand.</div>';
                    const allowO = typeof o.allowOriginal === "boolean" ? o.allowOriginal : null;
                    return \`
                      <details class="card card-compact" \${isOverridden ? "open" : ""}>
                        <summary><strong>\${k}</strong> <span class="muted">— \${escTxt(live.name)}</span> <span class="muted small">\${isOverridden ? "(overridden)" : "(unchanged)"}</span></summary>
                        <label>Category <span class="muted small">(live: \${escTxt(live.category)})</span>
                          <select data-brand="\${k}" data-field="category">
                            <option value="">— inherit from live —</option>
                            <option value="wardrobe-only" \${o.category === "wardrobe-only" ? "selected" : ""}>wardrobe-only</option>
                            <option value="wardrobe-plus-scene" \${o.category === "wardrobe-plus-scene" ? "selected" : ""}>wardrobe-plus-scene</option>
                          </select>
                        </label>
                        <label>Wardrobe fragment<textarea data-brand="\${k}" data-field="wardrobe" rows="3" placeholder="\${escAttr((live.wardrobe || '').slice(0,80))}">\${escTxt(o.wardrobe || '')}</textarea></label>
                        <label>Color palette<textarea data-brand="\${k}" data-field="colorPalette" rows="2" placeholder="\${escAttr((live.colorPalette || '').slice(0,80))}">\${escTxt(o.colorPalette || '')}</textarea></label>
                        <label>Allow original scene <span class="muted small">(live: \${live.allowOriginal ? "yes" : "no"})</span>
                          <select data-brand="\${k}" data-field="allowOriginal">
                            <option value="">— inherit from live —</option>
                            <option value="true" \${allowO === true ? "selected" : ""}>yes</option>
                            <option value="false" \${allowO === false ? "selected" : ""}>no</option>
                          </select>
                        </label>
                        \${scenesHtml}
                      </details>\`;
                }).join("");
            }

            function openEditor({ name, description, overrides }) {
                restoreFocus = document.activeElement;
                editingName = name || null;
                editorTitle.textContent = name ? "Edit variant" : "New variant";
                editorName.value = name || "";
                editorName.disabled = !!name;
                editorDesc.value = description || "";
                const ov = overrides && (overrides.styles || overrides.brands) ? overrides : { styles: overrides || {}, brands: {} };
                renderEditorStyles(ov);
                renderEditorBrands(ov);
                editorMsg.textContent = "";
                editor.hidden = false;
                (editorName.disabled ? editorDesc : editorName).focus();
            }

            function closeEditor() {
                editor.hidden = true;
                editingName = null;
                if (restoreFocus && restoreFocus.isConnected) restoreFocus.focus();
            }

            document.getElementById("new-variant-btn").addEventListener("click", () => openEditor({}));
            document.querySelectorAll("[data-close-editor]").forEach((el) => el.addEventListener("click", closeEditor));
            document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !editor.hidden) closeEditor(); });

            document.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => {
                const v = VARIANTS.find((x) => x.name === b.dataset.edit);
                if (v) openEditor(v);
            }));

            document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
                const ok = await twModal.confirm({ title: "Delete variant?", message: '"' + b.dataset.del + '" will be removed.', confirmText: "Delete", danger: true });
                if (!ok) return;
                const r = await fetch("/eval/api/variants/" + encodeURIComponent(b.dataset.del), { method: "DELETE" });
                if (r.ok) location.reload();
                else { const j = await r.json().catch(() => ({})); await twModal.alert({ title: "Delete failed", message: j.error || "Check the server logs." }); }
            }));

            function collectOverrides() {
                const styles = {};
                editorStyles.querySelectorAll("textarea, select").forEach((el) => {
                    const k = el.dataset.style, f = el.dataset.field;
                    if (!k || !f) return;
                    const raw = el.value;
                    if (raw === "" || raw == null) return;
                    styles[k] = styles[k] || {};
                    if (f === "acceptsColorPalette") styles[k][f] = raw === "true";
                    else styles[k][f] = raw.trim();
                    // Drop fields that ended up as empty strings after trim
                    if (styles[k][f] === "") delete styles[k][f];
                });
                // Remove any style entries that collapsed to empty
                Object.keys(styles).forEach((k) => { if (!Object.keys(styles[k]).length) delete styles[k]; });

                const brands = {};
                editorBrands.querySelectorAll("textarea, select").forEach((el) => {
                    const k = el.dataset.brand, f = el.dataset.field, sceneKey = el.dataset.scene;
                    if (!k || !f) return;
                    const raw = el.value;
                    if (raw === "" || raw == null) return;
                    brands[k] = brands[k] || {};
                    if (sceneKey) {
                        brands[k].scenes = brands[k].scenes || {};
                        brands[k].scenes[sceneKey] = brands[k].scenes[sceneKey] || {};
                        const val = raw.trim();
                        if (val) brands[k].scenes[sceneKey][f] = val;
                    } else if (f === "allowOriginal") {
                        brands[k][f] = raw === "true";
                    } else {
                        const val = raw.trim();
                        if (val) brands[k][f] = val;
                    }
                });
                // Prune empty brand/scene maps
                Object.keys(brands).forEach((k) => {
                    if (brands[k].scenes) {
                        Object.keys(brands[k].scenes).forEach((sk) => {
                            if (!Object.keys(brands[k].scenes[sk]).length) delete brands[k].scenes[sk];
                        });
                        if (!Object.keys(brands[k].scenes).length) delete brands[k].scenes;
                    }
                    if (!Object.keys(brands[k]).length) delete brands[k];
                });
                return { styles, brands };
            }

            document.getElementById("editor-save").addEventListener("click", async () => {
                const name = editorName.value.trim();
                if (!name) { editorMsg.textContent = "Name is required"; return; }
                const overrides = collectOverrides();
                if (!Object.keys(overrides.styles).length && !Object.keys(overrides.brands).length) {
                    editorMsg.textContent = "At least one override is required";
                    return;
                }
                editorMsg.textContent = "Saving…";
                const body = { description: editorDesc.value.trim(), overrides };
                let r;
                if (editingName) {
                    r = await fetch("/eval/api/variants/" + encodeURIComponent(editingName), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
                } else {
                    r = await fetch("/eval/api/variants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, ...body }) });
                }
                if (r.ok) location.reload();
                else { const j = await r.json().catch(() => ({})); editorMsg.textContent = j.error || "Save failed"; }
            });
          </script>
        `;
        return pageShell({ title: "Saved variants", body, userBar, magicHat });
}


module.exports = {
    escapeHtml, jsonForScript, formatMs, evalNav, pageShell,
    paginateRunSummaries, renderEvalRunsPage, renderEvalNewPage, renderEvalPhotosPage, renderEvalVariantsPage,
};

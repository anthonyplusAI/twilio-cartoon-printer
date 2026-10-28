// Pure Prompt Lab run detail renderer. No storage, settings, or credential imports.
const { escapeHtml, formatMs, evalNav, pageShell, jsonForScript } = require("./eval-page");

function runWallTimeMs(manifest) {
    if (!Array.isArray(manifest.entries) || !manifest.entries.length) return null;
    let minStart = Infinity;
    let maxEnd = -Infinity;
    for (const e of manifest.entries) {
        if (e.startedAt) {
            const t = new Date(e.startedAt).getTime();
            if (t < minStart) minStart = t;
        }
        if (e.completedAt) {
            const t = new Date(e.completedAt).getTime();
            if (t > maxEnd) maxEnd = t;
        }
    }
    if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd) || maxEnd <= minStart) return null;
    return maxEnd - minStart;
}

const RUN_DETAIL_PAGE_ENTRIES = 120;

function paginateRunDetail(manifest, query = {}) {
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    const starredSet = new Set(Array.isArray(manifest.starred) ? manifest.starred : []);
    const starredOnly = query.starred === "1" || query.starred === true;
    const configuredPhotos = (manifest.config && manifest.config.photos) || [];
    const configuredVariants = ((manifest.config && manifest.config.variants) || []).map((variant) => variant.name);
    const combos = new Map();
    for (const entry of entries) {
        if (starredOnly && !starredSet.has(entry.outputPath)) continue;
        const key = [entry.style, entry.brand || "null", entry.background || "null"].join("|");
        if (!combos.has(key)) combos.set(key, {
            key, style: entry.style, brand: entry.brand, background: entry.background, photos: new Map(),
        });
        const combo = combos.get(key);
        if (!combo.photos.has(entry.photo)) combo.photos.set(entry.photo, new Map());
        const variants = combo.photos.get(entry.photo);
        if (!variants.has(entry.variant)) variants.set(entry.variant, []);
        variants.get(entry.variant).push(entry);
    }

    const rows = [];
    for (const combo of combos.values()) {
        const photoOrder = [...new Set([...configuredPhotos, ...combo.photos.keys()])];
        for (const photo of photoOrder) {
            const variants = combo.photos.get(photo);
            if (!variants) continue;
            const variantOrder = [...new Set([...configuredVariants, ...variants.keys()])];
            for (const variant of variantOrder) {
                const cellEntries = variants.get(variant);
                if (!cellEntries) continue;
                cellEntries.sort((a, b) => a.rep - b.rep);
                for (let start = 0; start < cellEntries.length; start += RUN_DETAIL_PAGE_ENTRIES) {
                    rows.push({
                        key: combo.key, style: combo.style, brand: combo.brand,
                        background: combo.background, photo, variant,
                        entries: cellEntries.slice(start, start + RUN_DETAIL_PAGE_ENTRIES),
                    });
                }
            }
        }
    }

    const pages = [];
    let current = [];
    let currentCount = 0;
    for (const row of rows) {
        if (currentCount && currentCount + row.entries.length > RUN_DETAIL_PAGE_ENTRIES) {
            pages.push({ rows: current, count: currentCount });
            current = [];
            currentCount = 0;
        }
        current.push(row);
        currentCount += row.entries.length;
    }
    if (current.length || !pages.length) pages.push({ rows: current, count: currentCount });
    const requested = Number(query.page);
    const page = Math.min(pages.length, Number.isSafeInteger(requested) && requested > 0 ? requested : 1);
    const before = pages.slice(0, page - 1).reduce((count, section) => count + section.count, 0);
    const total = pages.reduce((count, section) => count + section.count, 0);
    return {
        rows: pages[page - 1].rows,
        page, pages: pages.length,
        total, shown: pages[page - 1].count,
        from: total ? before + 1 : 0,
        to: before + pages[page - 1].count,
        starredOnly, starredCount: starredSet.size,
    };
}

function renderEvalRunDetailPage({ manifest, query = {}, userBar = "", magicHat = "" }) {
        const pageData = paginateRunDetail(manifest, query);
        const variantNames = manifest.config.variants.map((v) => v.name);
        const totalsGlobal = manifest.entries.reduce((acc, e) => {
            acc.total++;
            if (e.status === "completed") acc.done++;
            else if (e.status === "failed") acc.failed++;
            return acc;
        }, { total: 0, done: 0, failed: 0 });

        const starredSet = new Set(Array.isArray(manifest.starred) ? manifest.starred : []);
        const visibleGroups = new Map();
        for (const row of pageData.rows) {
            if (!visibleGroups.has(row.key)) visibleGroups.set(row.key, { ...row, photos: new Map() });
            const group = visibleGroups.get(row.key);
            if (!group.photos.has(row.photo)) group.photos.set(row.photo, []);
            group.photos.get(row.photo).push(row);
        }
        const detailUrl = (nextPage, starredOnly = pageData.starredOnly) => {
            const params = new URLSearchParams();
            if (starredOnly) params.set("starred", "1");
            if (nextPage > 1) params.set("page", String(nextPage));
            return `/eval/run/${encodeURIComponent(manifest.id)}${params.size ? `?${params}` : ""}`;
        };
        const renderCombo = (group) => {
            const key = group.key;
            const s = group.style;
            const b = group.brand || "null";
            const bg = group.background || "null";
            const title = `${s} × ${b === "null" ? "(no brand)" : b} × ${bg === "null" ? "(default bg)" : bg}`;
            const winnerOpts = ["<option value=''>— no winner —</option>"]
                .concat(variantNames.map((v) => `<option value="${escapeHtml(v)}" ${manifest.winners && manifest.winners[key] && manifest.winners[key].variant === v ? "selected" : ""}>${escapeHtml(v)}</option>`));
            const currentNotes = (manifest.winners && manifest.winners[key] && manifest.winners[key].notes) || "";
            const photoBlocks = [...group.photos].map(([p, visibleRows]) => {
                const rows = visibleRows.map((row) => {
                    const vn = row.variant;
                    const cells = row.entries.map((e) => {
                            if (e.status === "completed") {
                                const imgUrl = `/eval/images/${encodeURIComponent(manifest.id)}/${encodeURIComponent(e.outputPath)}`;
                                const durLabel = e.generationMs ? formatMs(e.generationMs) : "";
                                const durBadge = durLabel ? `<span class="tile-duration">${escapeHtml(durLabel)}</span>` : "";
                                const promptUrl = `/eval/prompts/${encodeURIComponent(manifest.id)}/${encodeURIComponent(e.outputPath)}`;
                                const isStarred = starredSet.has(e.outputPath);
                                const starredAttr = isStarred ? " data-starred=\"1\"" : "";
                                const starredClass = isStarred ? " starred" : "";
                                return `<div class="img-tile-wrap${starredClass}" data-output="${escapeHtml(e.outputPath)}"${starredAttr}>
                                  <button type="button" class="img-tile" data-img="${imgUrl}" data-prompt-url="${promptUrl}" data-caption="${escapeHtml(vn + " · " + p + " · rep " + e.rep + (durLabel ? " · " + durLabel : ""))}" style="border:none;padding:0;background:none;cursor:zoom-in;position:relative;">
                                    <img src="${imgUrl}" width="180" loading="lazy" decoding="async" style="border-radius:8px;display:block;box-shadow:0 2px 8px rgba(0,0,0,0.15);transition:transform 0.1s;">
                                    ${durBadge}
                                  </button>
                                  <button type="button" class="tile-star" data-star-output="${escapeHtml(e.outputPath)}" aria-label="${isStarred ? "Unstar image" : "Star image"}" aria-pressed="${isStarred ? "true" : "false"}" title="${isStarred ? "Unstar" : "Star as favorite"}">
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="${isStarred ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                                  </button>
                                </div>`;
                            }
                            if (e.status === "failed") return `<div class="tile-failed"><div class="tile-failed-msg">${escapeHtml(e.error || "failed")}</div><button type="button" class="tile-retry" data-retry-output="${escapeHtml(e.outputPath)}">↻ Retry</button></div>`;
                            return `<div class="tile-pending"><span class="muted small">${escapeHtml(e.status)}</span></div>`;
                        }).join("");
                    return `<div class="variant-row"><strong class="variant-label">${escapeHtml(vn)}</strong><div class="variant-cells">${cells}</div></div>`;
                }).join("");
                return `<div class="photo-group"><div class="photo-label">${escapeHtml(p)}</div>${rows}</div>`;
            }).join("");
            return `<div class="card combo-card" data-combo="${escapeHtml(key)}">
              <div class="row combo-header">
                <div><h3 style="margin:0;">${escapeHtml(title)}</h3></div>
                <label style="margin:0;min-width:260px;"><span class="label-text">Winner</span><select data-combo-key="${escapeHtml(key)}">${winnerOpts.join("")}</select></label>
              </div>
              <label style="margin-top:8px;"><span class="label-text">Notes for this combination</span><textarea data-combo-notes="${escapeHtml(key)}" placeholder="e.g. live loses the sunglasses, custom-1 nails them but breaks the background…" style="min-height:60px;">${escapeHtml(currentNotes)}</textarea></label>
              <div class="photo-stack">${photoBlocks}</div>
            </div>`;
        };

        const combos = [...visibleGroups.values()].map(renderCombo).join("");
        const activeRun = manifest.status === "pending" || manifest.status === "running";
        const elapsed = runWallTimeMs(manifest);
        const pageControls = pageData.pages > 1 ? `<nav class="eval-detail-pages" aria-label="Result pages">
          <span>Page ${pageData.page} of ${pageData.pages}</span>
          <div>${pageData.page > 1 ? `<a class="btn btn-secondary btn-sm" data-detail-nav href="${escapeHtml(detailUrl(pageData.page - 1))}">Previous</a>` : '<span class="btn btn-secondary btn-sm is-disabled">Previous</span>'}
          ${pageData.page < pageData.pages ? `<a class="btn btn-secondary btn-sm" data-detail-nav href="${escapeHtml(detailUrl(pageData.page + 1))}">Next</a>` : '<span class="btn btn-secondary btn-sm is-disabled">Next</span>'}</div>
        </nav>` : "";
        const body = `
          ${evalNav("runs")}
          <main class="eval-detail" data-run-status="${escapeHtml(manifest.status)}">
            <header class="eval-hero eval-detail-hero">
              <div><a class="eval-back-link" data-detail-nav href="/eval">← All runs</a><h1>${escapeHtml(manifest.name)} <span id="runStatus" class="pill pill-${escapeHtml(manifest.status)}">${escapeHtml(manifest.status)}</span></h1>
                <p id="runSummary">${escapeHtml(new Date(manifest.createdAt).toLocaleString())}${manifest.group ? ` · ${escapeHtml(manifest.group)}` : ""}${elapsed ? ` · ${escapeHtml(formatMs(elapsed))} elapsed` : ""}</p>
              </div>
              <div class="eval-detail-actions">
                <a class="btn btn-secondary btn-sm eval-star-filter ${pageData.starredOnly ? "is-active" : ""}" data-detail-nav href="${escapeHtml(detailUrl(1, !pageData.starredOnly))}">${pageData.starredOnly ? "Show all images" : "Starred only"} (<span id="starredCount">${starredSet.size}</span>)</a>
                ${totalsGlobal.failed ? `<button type="button" class="btn btn-sm eval-retry-all" id="retryAllBtn">Retry all ${totalsGlobal.failed} failed</button>` : ""}
              </div>
            </header>
            <div class="eval-overview eval-detail-overview" aria-label="Run progress">
              <div><strong id="runTotal">${totalsGlobal.total}</strong><span>Images</span></div>
              <div><strong id="runDone">${totalsGlobal.done}</strong><span>Completed</span></div>
              <div><strong id="runFailed">${totalsGlobal.failed}</strong><span>Failed</span></div>
              <div><strong id="runCost">$${(manifest.totalCostUsd || 0).toFixed(2)}</strong><span>Image cost</span></div>
            </div>
            <section class="eval-detail-notes" aria-labelledby="runNotesTitle">
              <div><h2 id="runNotesTitle">Run notes</h2><p>Record what this test is meant to show and what you learned.</p></div>
              <textarea id="runNotes" aria-label="Run notes" placeholder="What are you testing? What did you learn?">${escapeHtml(manifest.notes || "")}</textarea>
              <span id="runSaveStatus" role="status" aria-live="polite">Changes save automatically</span>
            </section>
            <section class="eval-detail-results" aria-labelledby="runResultsTitle">
              <div class="eval-detail-results-head"><div><h2 id="runResultsTitle">Results</h2><p>${pageData.total ? `Showing ${pageData.from}–${pageData.to} of ${pageData.total} ${pageData.starredOnly ? "starred " : ""}images` : pageData.starredOnly ? "No starred images in this run" : "No images in this run yet"}</p></div><span>Choose a winner and add notes for each combination</span></div>
              ${pageControls}
              ${combos || `<div class="eval-detail-empty"><strong>${pageData.starredOnly ? "No starred images yet" : "No results yet"}</strong><p>${pageData.starredOnly ? "Star an image on any results page to see it here." : "Generated images will appear as the run progresses."}</p></div>`}
              ${pageControls}
            </section>
          </main>

          <div id="imgModal" class="modal" role="dialog" aria-modal="true" aria-label="Image and prompt" style="display:none;">
            <div class="modal-backdrop"></div>
            <div class="modal-content">
              <button type="button" class="modal-close" aria-label="Close">×</button>
              <div class="modal-body">
                <div class="modal-img-wrap"><img id="modalImg" alt=""></div>
                <div class="modal-side">
                  <div id="modalCaption" class="muted small" style="margin-bottom:8px;"></div>
                  ${pageData.pages > 1 ? `<div class="eval-modal-page-nav"><span>Results page ${pageData.page} of ${pageData.pages}</span><div>${pageData.page > 1 ? `<a data-detail-nav href="${escapeHtml(detailUrl(pageData.page - 1))}">Previous page</a>` : ""}${pageData.page < pageData.pages ? `<a data-detail-nav href="${escapeHtml(detailUrl(pageData.page + 1))}">Next page</a>` : ""}</div></div>` : ""}
                  <label style="margin:0;"><span class="label-text">Prompt</span><textarea id="modalPrompt" readonly style="min-height:340px;"></textarea></label>
                  <div class="cluster" style="margin-top:10px;">
                    <button type="button" class="btn btn-secondary btn-sm" id="modalCopy">Copy prompt</button>
                    <a class="btn btn-secondary btn-sm" id="modalOpen" target="_blank" rel="noopener">Open in new tab</a>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <style>
            .combo-card { padding: 20px; }
            .combo-header { gap: 20px; margin-bottom: 4px; }
            .photo-stack { margin-top: 16px; display: flex; flex-direction: column; gap: 20px; }
            .photo-group { border-top: 1px solid var(--th-card-border); padding-top: 14px; }
            .photo-label { font-weight: 600; font-size: 13px; color: var(--th-text-muted); margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
            .variant-row { display: flex; gap: 12px; align-items: flex-start; padding: 6px 0; }
            .variant-label { flex: 0 0 120px; padding-top: 8px; font-size: 13px; color: var(--th-text); word-break: break-word; }
            .variant-cells { display: flex; gap: 10px; flex-wrap: wrap; }
            .img-tile:hover img { transform: scale(1.03); }
            .img-tile-wrap { position: relative; display: inline-block; border-radius: 10px; padding: 4px; transition: background 0.15s, box-shadow 0.15s; }
            .img-tile-wrap.starred { background: #fef3c7; box-shadow: 0 0 0 2px #f59e0b, 0 4px 16px rgba(245, 158, 11, 0.35); }
            .img-tile-wrap.starred img { box-shadow: 0 2px 8px rgba(0,0,0,0.2) !important; }
            .tile-star { position: absolute; bottom: 8px; left: 8px; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 50%; background: rgba(0,0,0,0.55); color: #fff; cursor: pointer; z-index: 3; transition: background 0.15s, color 0.15s, transform 0.1s; opacity: 0; }
            .img-tile-wrap:hover .tile-star, .img-tile-wrap:focus-within .tile-star, .img-tile-wrap.starred .tile-star { opacity: 1; }
            .tile-star:hover { background: rgba(0,0,0,0.75); transform: scale(1.08); }
            .img-tile-wrap.starred .tile-star { background: #f59e0b; color: #fff; opacity: 1; }
            .img-tile-wrap.starred .tile-star:hover { background: #d97706; }
            body.starred-only .img-tile-wrap:not(.starred) { display: none; }
            body.starred-only .variant-row:not(:has(.img-tile-wrap.starred)) { display: none; }
            body.starred-only .photo-group:not(:has(.img-tile-wrap.starred)) { display: none; }
            body.starred-only .combo-card:not(:has(.img-tile-wrap.starred)) { display: none; }
            #starredFilterBtn[aria-pressed="true"] { background: #f59e0b; border-color: #f59e0b; color: #fff; }
            .tile-duration { position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.72);color:#fff;font-size:11px;font-weight:600;padding:2px 7px;border-radius:10px;letter-spacing:0.02em;pointer-events:none; }
            .tile-failed { width:180px;height:240px;background:#fee2e2;color:#991b1b;border-radius:8px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:12px;font-size:12px;text-align:center; }
            .tile-failed-msg { overflow:hidden;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical; }
            .tile-retry { background:#991b1b;color:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer; }
            .tile-retry:hover { background:#7f1d1d; }
            .tile-retry:disabled { opacity:0.6;cursor:wait; }
            .tile-pending { width:180px;height:240px;background:var(--th-card);border:1px dashed var(--th-card-border);border-radius:8px;display:flex;align-items:center;justify-content:center; }
            .modal { position:fixed;inset:0;z-index:1000; }
            .modal-backdrop { position:absolute;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(4px); }
            .modal-content { position:relative;margin:3vh auto;max-width:1200px;width:94vw;max-height:94vh;background:var(--th-card);border:1px solid var(--th-card-border);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,0.5);overflow:hidden;display:flex;flex-direction:column; }
            .modal-close { position:absolute;top:10px;right:14px;background:transparent;border:none;color:var(--th-text);font-size:28px;line-height:1;cursor:pointer;padding:4px 10px;border-radius:6px;z-index:2; }
            .modal-close:hover { background:var(--th-card-border); }
            .modal-body { display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:0;flex:1;min-height:0; }
            .modal-img-wrap { background:#000;display:flex;align-items:center;justify-content:center;overflow:auto;padding:12px; }
            .modal-img-wrap img { max-width:100%;max-height:88vh;object-fit:contain;border-radius:6px; }
            .modal-side { padding:20px;display:flex;flex-direction:column;overflow:auto;border-left:1px solid var(--th-card-border); }
            .modal-side textarea { flex:1; }
            @media (max-width: 880px) { .modal-body { grid-template-columns: 1fr; } .modal-img-wrap img { max-height: 50vh; } }
          </style>

          <script>
          const runId = ${jsonForScript(manifest.id)};
          const ORIGINAL_WINNERS = ${jsonForScript(manifest.winners || {})};
          const runSaveStatus = document.getElementById("runSaveStatus");
          const runNotes = document.getElementById("runNotes");
          let saveTimer = 0;
          let dirty = false;
          let saveQueue = Promise.resolve();

          function currentRunEdits() {
              const winners = { ...ORIGINAL_WINNERS };
              document.querySelectorAll("[data-combo-key]").forEach((select) => {
                  const key = select.dataset.comboKey;
                  const notes = document.querySelector('[data-combo-notes="' + CSS.escape(key) + '"]');
                  winners[key] = { variant: select.value, notes: notes ? notes.value : "" };
              });
              return { winners, notes: runNotes.value };
          }

          async function saveRunEdits() {
              if (saveTimer) { clearTimeout(saveTimer); saveTimer = 0; }
              if (!dirty) return saveQueue.then(() => true, () => false);
              dirty = false;
              const payload = currentRunEdits();
              runSaveStatus.textContent = "Saving…";
              saveQueue = saveQueue.catch(() => {}).then(async () => {
                  const response = await fetch("/eval/api/runs/" + encodeURIComponent(runId), {
                      method: "PATCH",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(payload),
                  });
                  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Save failed");
              });
              try {
                  await saveQueue;
                  if (!dirty) runSaveStatus.textContent = "Saved";
                  return true;
              } catch (error) {
                  dirty = true;
                  runSaveStatus.textContent = "Could not save changes: " + error.message;
                  return false;
              }
          }
          function queueRunSave() {
              dirty = true;
              runSaveStatus.textContent = "Unsaved changes";
              if (saveTimer) clearTimeout(saveTimer);
              saveTimer = setTimeout(saveRunEdits, 500);
          }
          document.querySelectorAll("[data-combo-key], [data-combo-notes], #runNotes").forEach((element) => {
              element.addEventListener("input", queueRunSave);
              element.addEventListener("change", queueRunSave);
          });
          document.querySelectorAll("[data-detail-nav]").forEach((link) => link.addEventListener("click", async (event) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              if (await saveRunEdits()) location.assign(link.href);
          }));

          if (${pageData.starredOnly}) document.body.classList.add("starred-only");
          if (${activeRun}) {
              let polling = false;
              const initialDone = Number(document.getElementById("runDone").textContent);
              const initialFailed = Number(document.getElementById("runFailed").textContent);
              const initialStatus = document.getElementById("runStatus").textContent;
              const refresh = async () => {
                  if (document.hidden || polling) return;
                  polling = true;
                  try {
                      const response = await fetch("/eval/api/runs/" + encodeURIComponent(runId) + "/summary", { cache: "no-store" });
                      if (!response.ok) return;
                      const summary = await response.json();
                      if (!summary.totals) return;
                      const status = document.getElementById("runStatus");
                      status.className = "pill pill-" + summary.status;
                      status.textContent = summary.status;
                      document.getElementById("runDone").textContent = summary.totals.done;
                      document.getElementById("runFailed").textContent = summary.totals.failed;
                      document.getElementById("runCost").textContent = "$" + Number(summary.totalCostUsd || 0).toFixed(2);
                      const changed = summary.status !== initialStatus
                          || summary.totals.done !== initialDone || summary.totals.failed !== initialFailed;
                      if (!changed) return;
                      const modalOpen = document.getElementById("imgModal").style.display === "block";
                      const active = document.activeElement;
                      const editing = active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
                      if (!modalOpen && !editing && !dirty) location.reload();
                  } catch {
                      // The next visible poll can recover from a transient request failure.
                  } finally {
                      polling = false;
                  }
              };
              setInterval(refresh, 8000);
              document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
          }
          const modal = document.getElementById("imgModal");
          const modalImg = document.getElementById("modalImg");
          const modalPrompt = document.getElementById("modalPrompt");
          const modalCaption = document.getElementById("modalCaption");
          const modalOpen = document.getElementById("modalOpen");
          const modalClose = modal.querySelector(".modal-close");
          let currentTile = null;
          const _promptCache = new Map();
          async function fetchPrompt(url) {
              if (_promptCache.has(url)) return _promptCache.get(url);
              try {
                  const r = await fetch(url);
                  const text = r.ok ? await r.text() : "";
                  _promptCache.set(url, text);
                  return text;
              } catch { return ""; }
          }
          async function openModal(tile) {
              modalImg.src = tile.dataset.img;
              modalImg.alt = tile.dataset.caption;
              modalPrompt.value = "Loading prompt…";
              modalCaption.textContent = tile.dataset.caption;
              modalOpen.href = tile.dataset.img;
              modal.style.display = "block";
              document.body.style.overflow = "hidden";
              currentTile = tile;
              modalClose.focus();
              const url = tile.dataset.promptUrl;
              const openedFor = tile;
              const text = url ? await fetchPrompt(url) : "";
              // Avoid overwriting if the user navigated to another tile meanwhile.
              if (currentTile === openedFor) modalPrompt.value = text;
          }
          function closeModal() {
              const previousTile = currentTile;
              modal.style.display = "none";
              document.body.style.overflow = "";
              modalImg.src = "";
              currentTile = null;
              if (previousTile && previousTile.isConnected && previousTile.getClientRects().length) previousTile.focus();
          }
          function allTiles() { return Array.from(document.querySelectorAll(".img-tile")).filter((tile) => tile.getClientRects().length); }
          function navHorizontal(dir) {
              if (!currentTile) return;
              const tiles = allTiles();
              const idx = tiles.indexOf(currentTile);
              if (idx === -1) return;
              const next = tiles[idx + dir];
              if (next) openModal(next);
          }
          function navVertical(dir) {
              if (!currentTile) return;
              const row = currentTile.closest(".variant-row");
              if (!row) return;
              const cells = Array.from(row.querySelectorAll(".variant-cells > *"));
              const colIdx = cells.indexOf(currentTile.closest(".img-tile-wrap"));
              if (colIdx === -1) return;
              // Walk through every variant-row (across photo-groups and combo-cards) in DOM order.
              const allRows = Array.from(document.querySelectorAll(".variant-row"));
              const rowIdx = allRows.indexOf(row);
              for (let i = rowIdx + dir; i >= 0 && i < allRows.length; i += dir) {
                  const targetCells = Array.from(allRows[i].querySelectorAll(".variant-cells > *"));
                  const candidate = targetCells[colIdx] || targetCells[targetCells.length - 1];
                  const nextTile = candidate && candidate.querySelector(".img-tile");
                  if (nextTile && nextTile.getClientRects().length) {
                      openModal(nextTile);
                      return;
                  }
              }
          }
          modal.querySelector(".modal-backdrop").addEventListener("click", closeModal);
          modalClose.addEventListener("click", closeModal);
          document.addEventListener("keydown", (ev) => {
              if (modal.style.display === "none") return;
              // Don't hijack arrows when the user is focused inside the prompt textarea
              const inTextarea = ev.target && ev.target.tagName === "TEXTAREA";
              if (ev.key === "Escape") { closeModal(); return; }
              if (inTextarea) return;
              if (ev.key === "ArrowRight") { ev.preventDefault(); navHorizontal(1); }
              else if (ev.key === "ArrowLeft") { ev.preventDefault(); navHorizontal(-1); }
              else if (ev.key === "ArrowDown") { ev.preventDefault(); navVertical(1); }
              else if (ev.key === "ArrowUp") { ev.preventDefault(); navVertical(-1); }
          });
          document.querySelectorAll(".img-tile").forEach((btn) => btn.addEventListener("click", () => openModal(btn)));
          document.getElementById("modalCopy").addEventListener("click", async (ev) => {
              try { await navigator.clipboard.writeText(modalPrompt.value); const orig = ev.target.textContent; ev.target.textContent = "Copied"; setTimeout(() => { ev.target.textContent = orig; }, 1200); }
              catch { modalPrompt.select(); document.execCommand("copy"); }
          });

          async function toggleStar(outputPath, btn) {
              if (btn.disabled) return;
              btn.disabled = true;
              const wrap = btn.closest(".img-tile-wrap");
              const wasStarred = wrap.classList.contains("starred");
              const countEl = document.getElementById("starredCount");
              const previousCount = countEl ? Number(countEl.textContent) || 0 : 0;
              // Optimistic UI
              wrap.classList.toggle("starred", !wasStarred);
              btn.setAttribute("aria-pressed", !wasStarred ? "true" : "false");
              btn.setAttribute("aria-label", !wasStarred ? "Unstar image" : "Star image");
              btn.setAttribute("title", !wasStarred ? "Unstar" : "Star as favorite");
              const svg = btn.querySelector("svg");
              if (svg) svg.setAttribute("fill", !wasStarred ? "currentColor" : "none");
              if (!wasStarred) wrap.dataset.starred = "1"; else delete wrap.dataset.starred;
              if (countEl) countEl.textContent = Math.max(0, previousCount + (wasStarred ? -1 : 1));
              try {
                  const r = await fetch("/eval/api/runs/" + encodeURIComponent(runId) + "/star", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({ outputPath, starred: !wasStarred }),
                  });
                  if (!r.ok) throw new Error("save failed");
                  const result = await r.json().catch(() => ({}));
                  if (countEl && Number.isInteger(result.starredCount)) countEl.textContent = result.starredCount;
              } catch (err) {
                  // Roll back
                  wrap.classList.toggle("starred", wasStarred);
                  btn.setAttribute("aria-pressed", wasStarred ? "true" : "false");
                  btn.setAttribute("aria-label", wasStarred ? "Unstar image" : "Star image");
                  btn.setAttribute("title", wasStarred ? "Unstar" : "Star as favorite");
                  if (svg) svg.setAttribute("fill", wasStarred ? "currentColor" : "none");
                  if (wasStarred) wrap.dataset.starred = "1"; else delete wrap.dataset.starred;
                  if (countEl) countEl.textContent = previousCount;
                  await twModal.alert({ title: "Couldn't save star", message: err.message });
              } finally {
                  btn.disabled = false;
              }
          }
          document.querySelectorAll(".tile-star").forEach((btn) => {
              btn.addEventListener("click", (ev) => {
                  ev.stopPropagation();
                  ev.preventDefault();
                  toggleStar(btn.dataset.starOutput, btn);
              });
          });

          document.querySelectorAll(".tile-retry").forEach((btn) => btn.addEventListener("click", async (ev) => {
              ev.stopPropagation();
              btn.disabled = true;
              btn.textContent = "Retrying…";
              const output = btn.dataset.retryOutput;
              try {
                  const r = await fetch("/eval/api/runs/" + encodeURIComponent(runId) + "/entries/" + encodeURIComponent(output) + "/retry", { method: "POST" });
                  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "retry failed");
                  location.reload();
              } catch (err) {
                  btn.disabled = false;
                  btn.textContent = "↻ Retry";
                  await twModal.alert({ title: "Retry failed", message: err.message });
              }
          }));

          const retryAllBtn = document.getElementById("retryAllBtn");
          if (retryAllBtn) {
              retryAllBtn.addEventListener("click", async () => {
                  const ok = await twModal.confirm({
                      title: "Retry all failed generations?",
                      message: "This will cost one image credit per retry.",
                      confirmText: "Retry all",
                  });
                  if (!ok) return;
                  retryAllBtn.disabled = true;
                  retryAllBtn.textContent = "Retrying…";
                  try {
                      const r = await fetch("/eval/api/runs/" + encodeURIComponent(runId) + "/retry-failed", { method: "POST" });
                      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "retry failed");
                      location.reload();
                  } catch (err) {
                      retryAllBtn.disabled = false;
                      retryAllBtn.textContent = "↻ Retry all failed";
                      await twModal.alert({ title: "Retry failed", message: err.message });
                  }
              });
          }
          </script>
        `;
        return pageShell({ title: manifest.name, body, userBar, magicHat });
}

module.exports = { runWallTimeMs, paginateRunDetail, renderEvalRunDetailPage };

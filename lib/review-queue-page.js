// Lightweight Review Queue page renderer. Runtime authentication and routes stay in review.js.
const { renderSiteNav, siteNavStylesheet } = require("./site-nav");
const QUEUE_HTML = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
{{SITE_NAV_STYLESHEET}}
<link rel="stylesheet" href="/assets/tw-modal.css">
<script src="/assets/tw-modal.js"></script>
<title>Review Queue — Twilio Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--th-bg); color: var(--th-text-dim); min-height: 100vh;
    padding: 20px 16px; font-family: 'Twilio Sans Text', -apple-system, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  .header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 20px; padding-bottom: 14px;
    border-bottom: 1px solid var(--th-card-border); flex-wrap: wrap; gap: 10px;
  }
  .header h1 {
    font-size: 20px; font-weight: 700; color: var(--th-text);
    display: flex; align-items: center; gap: 8px;
  }
  .header-btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600;
    color: var(--th-text-dim); text-decoration: none;
    background: var(--th-card); border: 1px solid var(--th-card-border);
    transition: all .15s; cursor: pointer; min-height: 44px;
  }
  .header-btn:hover { border-color: var(--blue-300); color: var(--blue-300); }
  .header-btn svg { width: 16px; height: 16px; }
  .status-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--blue-400); animation: pulse 2s infinite;
  }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.4; } }
  .badge {
    font-size: 12px; background: var(--brand-red); color: #fff;
    border-radius: 10px; padding: 2px 10px; margin-left: 8px; font-weight: 700;
  }
  .empty {
    text-align: center; padding: 60px 20px; color: var(--th-text-muted); font-size: 14px;
  }
  .empty-icon { font-size: 40px; margin-bottom: 12px; opacity: 0.4; }

  /* Grid */
  .review-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 220px)); gap: 14px;
  }
  @media (max-width: 500px) {
    .review-grid { grid-template-columns: 1fr; }
  }

  /* Cards */
  .rv-card {
    position: relative; background: var(--th-card); border-radius: 10px;
    padding: 12px; text-align: center;
    border: 1px solid var(--th-card-border); transition: border-color .2s;
  }
  .rv-card:hover { border-color: var(--blue-300); }
  .rv-images { display: flex; gap: 4px; margin-bottom: 8px; }
  .rv-images img { width: 100%; border-radius: 4px; cursor: pointer; display: block; }
  .rv-images .rv-img-label {
    position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%);
    font-size: 8px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px;
    background: rgba(0,0,0,.6); color: #fff; padding: 1px 5px; border-radius: 3px;
    pointer-events: none;
  }
  .rv-img-wrap { position: relative; flex: 1; min-width: 0; }
  .rv-meta { font-size: 11px; color: var(--th-text-muted); margin-bottom: 10px; }
  .rv-actions { display: flex; flex-direction: column; gap: 6px; }
  .rv-btn {
    border: none; border-radius: 6px; padding: 8px 12px; cursor: pointer;
    font-size: 12px; font-weight: 700; color: #fff; transition: all .15s;
    width: 100%; text-align: center;
  }
  .rv-btn:hover { transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,.3); }
  .rv-btn:active { transform: translateY(0); }
  .rv-btn-approve { background: var(--blue-400); font-size: 13px; padding: 10px 12px; }
  .rv-reject-row { display: flex; gap: 6px; }
  .rv-reject-row .rv-btn { font-size: 11px; padding: 6px 8px; }
  .rv-btn-reject { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-dim); }
  .rv-btn-reject:hover { border-color: var(--brand-red); color: var(--brand-red); background: rgba(239,34,58,.08); }
  .rv-btn-notify { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-dim); }
  .rv-btn-notify:hover { border-color: var(--blue-300); color: var(--blue-300); background: rgba(25,171,243,.08); }
  .rv-btn-reanalyze { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-dim); }
  .rv-btn-reanalyze:hover { border-color: var(--blue-500); color: var(--blue-500); background: rgba(24,102,238,.08); }

  /* ── Multi-variant cards ────────────────────────────────────────────── */
  .rv-card.rv-multi { grid-column: span 2; }
  @media (max-width: 900px) { .rv-card.rv-multi { grid-column: span 1; } }

  .rv-multi .rv-orig-row {
    display: flex; gap: 8px; align-items: stretch; margin-bottom: 10px;
  }
  .rv-multi .rv-orig-wrap {
    flex: 0 0 30%; position: relative; max-width: 30%;
  }
  .rv-multi .rv-orig-wrap img {
    width: 100%; height: auto; object-fit: cover; border-radius: 4px;
    cursor: pointer; display: block; aspect-ratio: 1 / 1;
  }
  .rv-multi .rv-variant-row {
    flex: 1; display: grid; gap: 6px;
    grid-template-columns: repeat(var(--variant-count, 3), 1fr);
  }
  .rv-variant {
    position: relative; display: flex; flex-direction: column; gap: 6px;
  }
  /* Placeholder slot for variants that failed and were cleaned up. Keeps
     the grid shape consistent so surviving variants stay thumbnail-sized. */
  .rv-variant.is-empty .rv-v-imgwrap {
    background: var(--th-bg); border: 1px dashed var(--th-card-border);
    display: flex; align-items: center; justify-content: center;
    cursor: default;
  }
  .rv-variant.is-empty .rv-v-regen-label {
    color: var(--th-text-muted); font-size: 11px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  .rv-variant.is-empty .rv-v-actions { min-height: 0; }
  .rv-variant .rv-v-imgwrap {
    position: relative; aspect-ratio: 1 / 1; border-radius: 4px; overflow: hidden;
    background: var(--th-bg);
  }
  .rv-variant .rv-v-imgwrap img {
    width: 100%; height: 100%; object-fit: cover; cursor: pointer; display: block;
    transition: opacity .15s;
  }
  .rv-variant .rv-v-num {
    position: absolute; top: 4px; left: 4px;
    background: rgba(0,0,0,.7); color: #fff;
    font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 10px;
    pointer-events: none;
  }
  .rv-variant .rv-v-regens {
    position: absolute; top: 4px; right: 4px;
    background: rgba(246,173,85,.9); color: #1a1a1a;
    font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 10px;
    pointer-events: none; letter-spacing: 0.02em;
  }
  .rv-variant .rv-v-actions {
    display: flex; flex-direction: column; gap: 4px;
  }
  .rv-v-send {
    background: var(--blue-400); color: #fff; border: none; border-radius: 6px;
    padding: 8px 10px; font-size: 12px; font-weight: 700; cursor: pointer;
    transition: all .15s;
  }
  .rv-v-send:hover:not(:disabled) { background: var(--blue-500); transform: translateY(-1px); }
  .rv-v-send:disabled { opacity: .4; cursor: not-allowed; }
  .rv-v-regen {
    background: transparent; color: var(--th-text-dim);
    border: 1px solid var(--th-text-muted); border-radius: 6px;
    padding: 6px 10px; font-size: 11px; font-weight: 600; cursor: pointer;
    transition: all .15s;
  }
  .rv-v-regen:hover:not(:disabled) {
    border-color: var(--blue-500); color: var(--blue-500); background: rgba(24,102,238,.08);
  }
  .rv-v-regen:disabled { opacity: .4; cursor: not-allowed; }

  /* Variant states */
  .rv-variant.is-regen .rv-v-imgwrap::after {
    content: ''; position: absolute; inset: 0;
    background: repeating-linear-gradient(45deg,
      rgba(33,136,239,0.15) 0 12px, rgba(33,136,239,0.05) 12px 24px);
    animation: rv-stripe 1.2s linear infinite;
  }
  .rv-variant.is-regen .rv-v-imgwrap img { opacity: .35; }
  .rv-variant.is-regen .rv-v-imgwrap { cursor: wait; }
  .rv-variant.is-regen .rv-v-num::after {
    content: ' · regenerating'; font-weight: 500;
  }
  .rv-v-regen-label {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    font-family: 'Twilio Sans Text', sans-serif; font-size: 13px;
    font-weight: 700; color: var(--th-text);
    text-shadow: 0 1px 3px rgba(0,0,0,.45);
    z-index: 2; pointer-events: none;
  }
  @keyframes rv-stripe {
    0% { background-position: 0 0; }
    100% { background-position: 48px 0; }
  }
  .rv-variant.is-failed .rv-v-imgwrap {
    display: flex; align-items: center; justify-content: center;
    border: 1px dashed rgba(239,34,58,.45);
  }
  .rv-variant.is-failed .rv-v-imgwrap::before {
    content: '⚠ Failed'; color: var(--brand-red);
    font-size: 11px; font-weight: 700;
  }
  .rv-variant.is-failed .rv-v-imgwrap img { display: none; }
  .rv-variant.is-failed .rv-v-send { display: none; }

  /* Card-level actions row (multi-variant) */
  .rv-multi .rv-card-actions {
    display: flex; gap: 6px; flex-wrap: wrap;
    padding-top: 10px; margin-top: 8px;
    border-top: 1px solid var(--th-card-border);
  }
  .rv-multi .rv-card-actions .rv-btn { width: auto; flex: 1; min-width: 110px; font-size: 11px; padding: 8px 10px; }

  /* Mobile carousel layout (≤600px) for multi-variant cards */
  @media (max-width: 600px) {
    .rv-multi .rv-orig-row { flex-direction: column; gap: 10px; }
    .rv-multi .rv-orig-wrap { flex: none; max-width: 100%; }
    .rv-multi .rv-variant-row {
      display: block; position: relative; overflow: hidden;
    }
    .rv-multi .rv-variant {
      display: none;
    }
    .rv-multi .rv-variant.is-active { display: flex; }
    .rv-multi .rv-v-send { padding: 12px 14px; font-size: 14px; min-height: 44px; }
    .rv-multi .rv-v-regen { padding: 10px 14px; font-size: 12px; min-height: 40px; }
    .rv-carousel-nav {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      padding: 8px 0 4px;
    }
    .rv-carousel-nav button {
      background: var(--th-card); border: 1px solid var(--th-card-border);
      color: var(--th-text-dim); width: 36px; height: 36px; border-radius: 50%;
      font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    .rv-carousel-nav button:disabled { opacity: .3; cursor: not-allowed; }
    .rv-carousel-dots { display: flex; gap: 6px; }
    .rv-carousel-dots button {
      width: 8px; height: 8px; min-width: 8px; padding: 0; border: 0;
      border-radius: 50%; background: var(--th-text-muted);
      opacity: .4; cursor: pointer;
    }
    .rv-carousel-dots button.is-active { opacity: 1; background: var(--blue-400); }
    .rv-carousel-label { font-size: 11px; color: var(--th-text-muted); font-weight: 600; margin-left: 4px; }

    /* Card-level actions: collapsed disclosure on mobile */
    .rv-multi .rv-card-actions-toggle {
      display: block; width: 100%; padding: 10px; margin-top: 8px;
      background: transparent; border: 1px dashed var(--th-card-border);
      color: var(--th-text-muted); font-size: 12px; font-weight: 600;
      border-radius: 6px; cursor: pointer;
    }
    .rv-multi .rv-card-actions {
      display: none;
    }
    .rv-multi.actions-open .rv-card-actions { display: flex; }
    .rv-multi.actions-open .rv-card-actions-toggle { border-style: solid; color: var(--th-text); }
  }
  @media (min-width: 601px) {
    .rv-carousel-nav, .rv-card-actions-toggle { display: none !important; }
    .rv-multi .rv-variant { display: flex !important; }
  }

  /* Re-analyze feedback panel */
  .rv-feedback {
    display: none; margin-top: 8px; text-align: left;
  }
  .rv-feedback.open { display: block; }
  .rv-feedback textarea {
    width: 100%; box-sizing: border-box; min-height: 60px; padding: 8px; border-radius: 6px;
    border: 1px solid var(--th-card-border); background: var(--th-bg); color: var(--th-text);
    font-size: 12px; font-family: inherit; resize: vertical;
  }
  .rv-feedback textarea:focus { outline: none; border-color: var(--blue-400); }
  .rv-feedback-hint { font-size: 10px; color: var(--th-text-muted); margin: 4px 0 6px; }
  .rv-feedback-btns { display: flex; gap: 6px; }
  .rv-feedback-btns .rv-btn { font-size: 11px; padding: 6px 12px; }
  .rv-fb-submit { background: var(--blue-500); }
  .rv-fb-cancel { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-dim); }

  /* Bulk selection */
  .rv-card-check {
    position: absolute; top: 8px; left: 8px; z-index: 2;
    width: 20px; height: 20px; accent-color: var(--blue-400); cursor: pointer;
  }
  .rv-card.rv-selected { border-color: var(--blue-400); box-shadow: 0 0 0 1px var(--blue-400); }
  .rv-bulk-bar {
    display: none; align-items: center; gap: 10px; flex-wrap: wrap;
    margin-bottom: 12px; padding: 10px 14px;
    background: var(--th-card); border: 1px solid var(--th-card-border); border-radius: 8px;
  }
  .rv-bulk-bar.active { display: flex; }
  .rv-bulk-bar label { font-size: 13px; color: var(--th-text-dim); cursor: pointer; display: flex; align-items: center; gap: 6px; }
  .rv-bulk-bar label input { accent-color: var(--blue-400); cursor: pointer; }
  .rv-bulk-count { font-size: 12px; color: var(--blue-300); font-weight: 700; }
  .rv-bulk-actions { display: flex; gap: 6px; margin-left: auto; }
  .rv-bulk-actions .rv-btn { width: auto; padding: 6px 14px; font-size: 12px; }

  /* Modal */
  .rv-modal {
    display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,.85); z-index: 9999;
    align-items: center; justify-content: center;
  }
  .rv-modal.open { display: flex; }
  .rv-modal-content { position: relative; max-width: 92vw; max-height: 90vh; display: flex; gap: 16px; align-items: center; }
  .rv-modal-pane { display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .rv-modal-pane img {
    max-width: 44vw; max-height: 82vh; border-radius: 10px;
    box-shadow: 0 8px 40px rgba(0,0,0,.5);
  }
  .rv-modal-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: rgba(255,255,255,.7); }
  @media (max-width: 700px) {
    .rv-modal-content { flex-direction: column; gap: 10px; }
    .rv-modal-pane img { max-width: 88vw; max-height: 40vh; }
  }
  .rv-modal-close {
    position: absolute; top: -12px; right: -12px;
    background: var(--th-card); color: #fff; border: 2px solid var(--th-text-muted);
    width: 32px; height: 32px; border-radius: 50%; font-size: 18px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
  }
  .rv-modal-close:hover { background: var(--brand-red); border-color: var(--brand-red); }
  /* Modal action bar (prev / approve / next). Single container so the
     approve button is always visible, independent of whether prev/next
     show for multi-variant modals. Mirrors the bar in /dashboard. */
  .rv-modal-actions {
    position: absolute; left: 50%; bottom: -60px;
    transform: translateX(-50%);
    display: flex; gap: 12px; align-items: center;
  }
  .rv-modal-nav-btn {
    background: var(--th-card); color: var(--th-text); border: 1px solid var(--th-text-muted);
    width: 44px; height: 44px; border-radius: 50%;
    font-size: 22px; line-height: 1; cursor: pointer;
    align-items: center; justify-content: center;
    transition: all .15s;
  }
  .rv-modal-nav-btn.shown { display: inline-flex; }
  .rv-modal-nav-btn:hover:not(:disabled) { border-color: var(--blue-400); color: var(--blue-400); }
  .rv-modal-nav-btn:disabled { opacity: .3; cursor: not-allowed; }
  .rv-modal-approve {
    background: var(--blue-400); color: #fff; border: none;
    height: 44px; padding: 0 24px; border-radius: 22px;
    font-size: 14px; font-weight: 700; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    transition: transform .1s, box-shadow .15s, background .15s;
  }
  .rv-modal-approve:hover:not(:disabled) { background: var(--blue-500); box-shadow: 0 2px 10px rgba(33,136,239,.35); }
  .rv-modal-approve:active:not(:disabled) { transform: translateY(1px); }
  .rv-modal-approve:disabled { opacity: .5; cursor: not-allowed; }

  /* Toast */
  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--th-card); border: 1px solid var(--th-card-border);
    color: var(--th-text); padding: 10px 20px; border-radius: 10px;
    font-size: 13px; font-weight: 600; z-index: 10000; opacity: 0;
    transition: opacity .3s; pointer-events: none;
    box-shadow: 0 4px 20px rgba(0,0,0,.3);
  }
  .toast.show { opacity: 1; }

  /* Offline banner */
  .offline-bar {
    display: none; text-align: center; padding: 8px 16px; font-size: 12px; font-weight: 600;
    background: rgba(239,34,58,.12); color: var(--brand-red); border-radius: 8px;
    margin-bottom: 14px; border: 1px solid rgba(239,34,58,.25);
  }
  .offline-bar.show { display: block; }
</style>
<link rel="stylesheet" href="/assets/review-workspace.css">
</head>
<body class="{{ADMIN_BODY_CLASS}}">
{{SITE_NAV}}
<header class="review-topbar{{ADMIN_TOPBAR_CLASS}}">
  <div class="review-topbar-inner">
    {{REVIEW_HEADER_LABEL}}
    {{STAFF_NAV}}
    <div class="review-top-actions">
      <button type="button" class="review-theme-button" onclick="toggleReviewTheme()" aria-label="Toggle light or dark theme"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20.4 15.4A9 9 0 0 1 8.6 3.6 9 9 0 1 0 20.4 15.4Z"/></svg><span>Theme</span></button>
      <a href="/review/settings" class="review-settings-link">Settings</a>
    </div>
  </div>
</header>
<main class="wrap">
  <section class="review-intro">
    <div><span class="review-eyebrow">Operations / Review</span><h1>Review portraits</h1><p>Compare the original and generated portrait before sending it to the guest.</p></div>
    <div class="review-total"><strong id="reviewCount" aria-live="polite">0</strong><span>Awaiting review</span></div>
  </section>

  <div class="review-toolbar">
    <label class="review-event-filter" for="reviewEvent"><span>Event</span><select id="reviewEvent" onchange="onReviewEventChange()"><option value="">Current event</option></select></label>
    <span class="review-live"><span class="status-dot"></span><span id="reviewConnection">Live queue</span></span>
    <button type="button" class="review-refresh" onclick="fetchQueue()">Refresh</button>
    <label class="review-select-page"><input type="checkbox" id="rvSelectAll" onchange="toggleSelectAll(this.checked)"> Select page</label>
  </div>

  <div class="offline-bar" id="offlineBar">Connection lost — retrying automatically...</div>
  <div class="rv-bulk-bar" id="rvBulkBar">
    <span class="rv-bulk-count" id="rvBulkCount"></span>
    <div class="rv-bulk-actions">
      <button class="rv-btn rv-btn-approve" id="rvBulkApprove" onclick="bulkAction('approve')" title="Deliver all selected images to their users via MMS">Approve Selected</button>
      <button class="rv-btn rv-btn-reject" onclick="bulkAction('reject')" title="Discard all selected images silently — users are not notified">Reject Selected</button>
    </div>
  </div>

  <div id="reviewGrid" class="review-grid"></div>
  <div id="emptyState" class="empty" style="display:none">
    <div class="empty-icon" aria-hidden="true">&#10003;</div>
    <h2 id="emptyTitle">All caught up</h2>
    <p id="emptyDescription">New portraits will appear here when they are ready to review.</p>
  </div>
  <nav class="review-pagination" id="reviewPagination" aria-label="Review queue pages">
    <span id="reviewPageRange" aria-live="polite">Loading queue…</span>
    <div class="review-page-actions"><button type="button" id="reviewPrevious" onclick="previousReviewPage()" disabled>Previous</button><button type="button" id="reviewNext" onclick="nextReviewPage()" disabled>Next</button></div>
  </nav>
</main>

<div id="reviewModal" class="rv-modal" role="dialog" aria-modal="true" aria-label="Compare portraits" onclick="closeModal(event)">
  <div class="rv-modal-content">
    <div class="rv-modal-pane"><span class="rv-modal-label">Original</span><img id="reviewModalOrig" src="" alt="Original selfie"></div>
    <div class="rv-modal-pane"><span class="rv-modal-label" id="reviewModalGenLabel">Generated</span><img id="reviewModalImg" src="" alt="Generated portrait"></div>
    <button type="button" class="rv-modal-close" onclick="closeModal()" aria-label="Close comparison">&times;</button>
    <div class="rv-modal-actions" id="reviewModalActions">
      <button class="rv-modal-nav-btn" id="rvModalPrev" onclick="cycleModalVariant(-1)" title="Previous variant" style="display:none">‹</button>
      <button class="rv-modal-approve" id="rvModalApprove" onclick="approveFromModal()" title="Approve this image (A or Enter)">Approve</button>
      <button class="rv-modal-nav-btn" id="rvModalNext" onclick="cycleModalVariant(1)" title="Next variant" style="display:none">›</button>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
var _selected = new Set();
var _openFeedback = {};
var REVIEW_PAGE_SIZE = 24;
var _reviewEvent = new URLSearchParams(window.location.search).get("e") || "";
var _reviewCursor = "", _reviewNextCursor = null, _reviewHistory = [];
var _reviewTotal = 0, _reviewOffset = 0, _reviewPageCount = 0;
var _fetchPromise = null, _lastRenderSignature = "";
var _cardVariants = {};     // parentJobId -> { origSrc, variants: [{variantId, filePrefix, status, mmsSrc, fullSrc}] }
var _carouselIndex = {};    // parentJobId -> currently-visible variant index (mobile)
var _actionsOpen = {};      // parentJobId -> true when the mobile card-level actions panel is expanded
var _regenInFlight = {};    // key "parentJobId|variantId" -> true while regen request pending
var _pickInFlight = new Set(); // parentJobId values currently being picked
var _modalContext = null;   // { parentJobId, idx, variantCount } or null for single

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// JSON strings use double quotes, so apostrophes in event names and IDs stay
// valid inside an inline handler. HTML escaping then protects the attribute.
function jsArg(s) { return escHtml(JSON.stringify(String(s))); }

function timeAgo(ts) {
  if (!ts) return "";
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h ago";
  return Math.floor(s/86400) + "d ago";
}

function showToast(msg) {
  var t = document.getElementById("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(function(){ t.classList.remove("show"); }, 2500);
}

function toggleReviewTheme() {
  var html = document.documentElement;
  var next = html.getAttribute("data-theme") === "light" ? "dark" : "light";
  html.setAttribute("data-theme", next);
  localStorage.setItem("twilio-theme", next);
}

async function fetchReviewEvents() {
  try {
    var r = await fetch("/review/api/events");
    if (r.status === 401) { location.href = "/review"; return; }
    if (!r.ok) return;
    var data = await r.json();
    var select = document.getElementById("reviewEvent");
    select.replaceChildren(new Option("All events", "all"));
    (data.events || []).forEach(function(event) { select.add(new Option(event, event)); });
    if (!_reviewEvent) _reviewEvent = data.currentEvent || "all";
    if (!Array.from(select.options).some(function(option) { return option.value === _reviewEvent; })) {
      select.add(new Option(_reviewEvent, _reviewEvent));
    }
    select.value = _reviewEvent;
  } catch(e) {}
}

function reviewQuery() {
  var params = new URLSearchParams();
  if (_reviewEvent) params.set("e", _reviewEvent);
  params.set("limit", String(REVIEW_PAGE_SIZE));
  if (_reviewCursor) params.set("cursor", _reviewCursor);
  return "/review/api/queue?" + params.toString();
}

function setReviewConnection(online) {
  document.getElementById("offlineBar").classList.toggle("show", !online);
  document.querySelector(".review-live").classList.toggle("is-offline", !online);
  document.getElementById("reviewConnection").textContent = online ? "Live queue" : "Reconnecting";
}

function updateReviewPageNav() {
  var nav = document.getElementById("reviewPagination");
  nav.classList.toggle("visible", _reviewTotal > REVIEW_PAGE_SIZE || !!_reviewCursor);
  var end = Math.min(_reviewOffset + _reviewPageCount, _reviewTotal);
  document.getElementById("reviewPageRange").textContent = _reviewTotal && _reviewPageCount
    ? "Showing " + (_reviewOffset + 1).toLocaleString() + "–" + end.toLocaleString() + " of " + _reviewTotal.toLocaleString()
    : _reviewTotal ? "No portraits in this batch" : "No portraits awaiting review";
  document.getElementById("reviewPrevious").disabled = _reviewHistory.length === 0;
  document.getElementById("reviewNext").disabled = !_reviewNextCursor;
}

function fetchQueue() {
  if (_fetchPromise) return _fetchPromise;
  _fetchPromise = loadQueuePage().finally(function() { _fetchPromise = null; });
  return _fetchPromise;
}

async function loadQueuePage() {
  try {
    var r = await fetch(reviewQuery());
    if (r.status === 401) { location.href = "/review"; return false; }
    if (!r.ok) throw new Error("Review queue request failed");
    var page = await r.json();
    if (!page || !Array.isArray(page.items)) throw new Error("Invalid review queue response");
    _reviewTotal = page.total || 0;
    _reviewOffset = page.offset || 0;
    _reviewPageCount = page.items.length;
    _reviewNextCursor = page.cursor || null;
    document.getElementById("reviewCount").textContent = _reviewTotal.toLocaleString();
    setReviewConnection(true);
    var signature = JSON.stringify(page.items) + ":" + Math.floor(Date.now() / 60000);
    if (signature !== _lastRenderSignature && !_modalContext && renderQueue(page.items)) {
      _lastRenderSignature = signature;
    }
    updateReviewPageNav();
    return true;
  } catch(e) {
    setReviewConnection(false);
    return false;
  }
}

async function nextReviewPage() {
  if (_fetchPromise) await _fetchPromise;
  if (!_reviewNextCursor) return;
  var previous = _reviewCursor;
  _reviewHistory.push(previous);
  _reviewCursor = _reviewNextCursor;
  _selected.clear();
  _openFeedback = {};
  _lastRenderSignature = "";
  if (!await fetchQueue()) {
    _reviewCursor = previous;
    _reviewHistory.pop();
    showToast("Could not load the next batch");
  }
}

async function previousReviewPage() {
  if (_fetchPromise) await _fetchPromise;
  if (!_reviewHistory.length) return;
  var previous = _reviewCursor;
  _reviewCursor = _reviewHistory.pop();
  _selected.clear();
  _openFeedback = {};
  _lastRenderSignature = "";
  if (!await fetchQueue()) {
    _reviewHistory.push(_reviewCursor);
    _reviewCursor = previous;
    showToast("Could not load the previous batch");
  }
}

async function onReviewEventChange() {
  if (_fetchPromise) await _fetchPromise;
  _reviewEvent = document.getElementById("reviewEvent").value;
  var url = new URL(window.location);
  if (_reviewEvent) url.searchParams.set("e", _reviewEvent);
  else url.searchParams.delete("e");
  history.replaceState(null, "", url);
  _reviewCursor = "";
  _reviewNextCursor = null;
  _reviewHistory = [];
  _selected.clear();
  _openFeedback = {};
  _lastRenderSignature = "";
  fetchQueue();
}

function renderQueue(jobs) {
  var grid = document.getElementById("reviewGrid");
  var empty = document.getElementById("emptyState");

  if (!jobs.length) {
    grid.replaceChildren();
    empty.style.display = "";
    document.getElementById("emptyTitle").textContent = _reviewTotal ? "No portraits in this batch" : "All caught up";
    document.getElementById("emptyDescription").textContent = _reviewTotal
      ? "Go to the previous batch to keep reviewing."
      : "New portraits will appear here when they are ready to review.";
    _selected.clear();
    updateBulk(0);
    return true;
  }

  empty.style.display = "none";
  if (Object.keys(_openFeedback).length > 0) return false;

  // Cards are keyed by filename (singleton) or parentJobId (multi).
  var cardIds = new Set(jobs.map(function(j){ return j.parentJobId || j.filename; }));
  _selected.forEach(function(k){ if (!cardIds.has(k)) _selected.delete(k); });
  Object.keys(_actionsOpen).forEach(function(k){ if (!cardIds.has(k)) delete _actionsOpen[k]; });

  _cardVariants = {};

  var parts = [];
  for (var j of jobs) {
    if (j.parentJobId) {
      parts.push(renderMultiCard(j));
    } else {
      parts.push(renderSingleCard(j));
    }
  }
  // All dynamic values below are escaped via escHtml. The HTML assembled here is
  // composed from trusted template strings + escHtml'd values — same pattern as
  // pre-existing single-variant code path.
  grid.innerHTML = parts.join(""); // eslint-disable-line no-unsanitized/property
  updateBulk(document.querySelectorAll(".rv-card-check").length);

  // Restore carousel position for any cards that were mid-swipe before re-render
  for (var id in _carouselIndex) {
    applyCarouselIndex(id, _carouselIndex[id]);
  }
  return true;
}

function renderSingleCard(j) {
  var fn = escHtml(j.filename);
  var fnArg = jsArg(j.filename);
  var prefix = String(j.filePrefix || "");
  var eventPath = encodeURIComponent(j.eventName || "");
  var imgSrc = "/photogallery/staging/" + eventPath + "/" + encodeURIComponent(prefix + "_output.png");
  var origSrc = "/photogallery/staging/" + eventPath + "/" + encodeURIComponent(prefix + "_input.jpg");
  var thumbImg = "/review/api/thumbnail/" + eventPath + "/" + encodeURIComponent(prefix + "_output.png");
  var thumbOrig = "/review/api/thumbnail/" + eventPath + "/" + encodeURIComponent(prefix + "_input.jpg");
  var modalSrc = "/photogallery/staging/" + eventPath + "/" + encodeURIComponent(prefix + "_output_mms.jpg");
  var sel = _selected.has(j.filename);
  var h = "";
  h += '<article class="rv-card'+(sel?" rv-selected":"")+'" id="rv-'+fn+'">';
  h += '<div class="rv-card-head"><span class="rv-card-event">'+escHtml(j.eventName || "Current event")+'</span><span class="rv-card-age">'+timeAgo(j.reviewAt)+'</span></div>';
  h += '<input type="checkbox" class="rv-card-check" '+(sel?"checked":"")+' onchange="toggleSelect('+fnArg+',this.checked)" title="Select for bulk action">';
  h += '<div class="rv-images">';
  h += '<div class="rv-img-wrap"><button type="button" class="rv-image-open" onclick="openSingleModal('+jsArg(origSrc)+','+jsArg(modalSrc)+','+fnArg+')" aria-label="Compare original and generated portrait"><img src="'+thumbOrig+'" loading="lazy" decoding="async" alt="Original selfie"></button><span class="rv-img-label">Original</span></div>';
  h += '<div class="rv-img-wrap"><button type="button" class="rv-image-open" onclick="openSingleModal('+jsArg(origSrc)+','+jsArg(modalSrc)+','+fnArg+')" aria-label="Compare original and generated portrait"><img src="'+thumbImg+'" loading="lazy" decoding="async" alt="Generated portrait"></button><span class="rv-img-label">Generated</span></div>';
  h += '</div>';
  h += '<div class="rv-meta"><strong>'+escHtml(j.style||"Unlabeled style")+'</strong><span>Single portrait</span></div>';
  h += '<div class="rv-actions">';
  h += '<button class="rv-btn rv-btn-approve" onclick="doAction('+fnArg+','+jsArg("approve")+')" title="Deliver this image to the user via MMS">Approve</button>';
  h += '<div class="rv-reject-row">';
  h += '<button class="rv-btn rv-btn-notify" onclick="doAction('+fnArg+','+jsArg("reject")+',{notify:true})" title="Discard and send the user an SMS asking them to try a different photo">Reject + Notify</button>';
  h += '<button class="rv-btn rv-btn-reanalyze" onclick="showFeedback('+fnArg+')" title="Re-generate with fresh analysis — optionally add instructions">Re-analyze</button>';
  h += '<button class="rv-btn rv-btn-reject" onclick="doAction('+fnArg+','+jsArg("reject")+')" title="Discard this image silently — the user is not notified">Reject</button>';
  h += '</div></div>';
  h += '<div class="rv-feedback" id="rvfb-'+fn+'">';
  h += '<textarea placeholder="Optional: describe what to fix (e.g. fix the logo, include the dog, remove the hat)"></textarea>';
  h += '<div class="rv-feedback-hint">Leave blank to re-generate with fresh analysis only.</div>';
  h += '<div class="rv-feedback-btns">';
  h += '<button class="rv-btn rv-fb-submit" onclick="submitFeedback('+fnArg+')">Re-generate</button>';
  h += '<button class="rv-btn rv-fb-cancel" onclick="hideFeedback('+fnArg+')">Cancel</button>';
  h += '</div></div>';
  h += '</article>';
  return h;
}

function renderMultiCard(j) {
  var pid = escHtml(j.parentJobId);
  var pidArg = jsArg(j.parentJobId);
  var cardKey = j.parentJobId;
  var eventPath = encodeURIComponent(j.eventName || "");
  var firstPrefix = String(j.variants && j.variants[0] ? j.variants[0].filePrefix : j.filePrefix || "");
  var origSrc = "/photogallery/staging/" + eventPath + "/" + encodeURIComponent(firstPrefix + "_input.jpg");
  var thumbOrig = "/review/api/thumbnail/" + eventPath + "/" + encodeURIComponent(firstPrefix + "_input.jpg");
  var variants = j.variants || [];
  // gridSlots = originally-requested variant count (from server). Drives the
  // grid track count so surviving variants stay thumbnail-sized even when
  // some siblings failed and were cleaned up. variantCount remains the
  // live count (used for carousel dots / mobile navigation).
  var gridSlots = j.variantCount || variants.length || 1;
  var variantCount = variants.length;

  _cardVariants[cardKey] = {
    origSrc: origSrc,
    variants: variants.map(function(v){
      return {
        variantId: v.variantId,
        filePrefix: v.filePrefix,
        status: v.status,
        mmsSrc: "/photogallery/staging/" + eventPath + "/" + encodeURIComponent(v.filePrefix + "_output_mms.jpg"),
        fullSrc: "/photogallery/staging/" + eventPath + "/" + encodeURIComponent(v.filePrefix + "_output.png"),
      };
    }),
  };

  var actionsOpenCls = _actionsOpen[cardKey] ? " actions-open" : "";
  var h = "";
  h += '<article class="rv-card rv-multi'+actionsOpenCls+'" id="rv-'+pid+'" style="--variant-count:'+gridSlots+'">';
  h += '<div class="rv-card-head"><span class="rv-card-event">'+escHtml(j.eventName || "Current event")+'</span><span class="rv-card-age">'+timeAgo(j.reviewAt)+'</span></div>';

  h += '<div class="rv-orig-row">';
  h += '<div class="rv-orig-wrap"><button type="button" class="rv-image-open" onclick="openMultiModal('+pidArg+',-1)" aria-label="Compare original and generated portraits"><img src="'+thumbOrig+'" loading="lazy" decoding="async" alt="Original selfie"></button></div>';

  h += '<div class="rv-variant-row">';
  var regenLimit = j.regenerationLimit || 2;
  variants.forEach(function(v, idx){
    var failed = v.status === "FAILED";
    // "inFlight" = variant is in PENDING_DIR or GENERATING_DIR (not yet
    // showable or approvable). REGENERATING = user clicked Regen;
    // GENERATING = initial fan-out still completing.
    var regenerating = v.status === "REGENERATING";
    var generating = v.status === "GENERATING";
    var inFlight = regenerating || generating;
    var isActive = idx === 0;
    var vid = escHtml(v.variantId);
    var vidArg = jsArg(v.variantId);
    var vfp = encodeURIComponent(v.filePrefix + "_output.png");
    var regenCount = v.regenCount || 0;
    var regenExhausted = regenCount >= regenLimit;
    var stateCls = (failed ? " is-failed" : "") + (inFlight ? " is-regen" : "") + (isActive ? " is-active" : "");
    h += '<div class="rv-variant'+stateCls+'" data-variant-idx="'+idx+'" data-variant-id="'+vid+'" id="rvv-'+pid+'-'+idx+'">';
    h += '<div class="rv-v-imgwrap">';
    h += '<span class="rv-v-num">'+(idx+1)+'/'+gridSlots+'</span>';
    if (regenCount > 0) {
      h += '<span class="rv-v-regens" title="Regenerations used">'+regenCount+'/'+regenLimit+'</span>';
    }
    // For in-flight variants the server has not yet produced a staged image
    // (either never did — first pass — or deleted it for a regen), so we
    // leave the img src blank and let the .is-regen stripe + text overlay
    // carry the visual state.
    if (inFlight) {
      h += '<div class="rv-v-regen-label">'+(regenerating ? 'Regenerating…' : 'Generating…')+'</div>';
    } else {
      h += '<button type="button" class="rv-image-open" onclick="openMultiModal('+pidArg+','+idx+')" aria-label="Compare variant '+(idx+1)+'"><img src="/review/api/thumbnail/'+eventPath+'/'+vfp+'" loading="lazy" decoding="async" alt="Variant '+(idx+1)+'"></button>';
    }
    h += '</div>';
    h += '<div class="rv-v-actions">';
    var regenDisabled = regenExhausted || inFlight ? ' disabled' : '';
    var regenTitle = regenExhausted
      ? 'Regeneration limit reached ('+regenLimit+')'
      : regenerating ? 'Already regenerating…'
      : generating ? 'Wait for generation to finish'
      : 'Regenerate only this variant (siblings untouched)';
    if (failed) {
      h += '<button class="rv-v-regen" onclick="regenVariant('+pidArg+','+vidArg+')"'+regenDisabled+' title="'+(regenExhausted?regenTitle:"Try generating this variant again")+'">↻ Try Again</button>';
    } else if (inFlight) {
      // No Approve while in flight (staged file is gone or not yet written),
      // just a disabled Regen
      h += '<button class="rv-v-send" disabled title="'+(regenerating ? 'Wait for regeneration to finish' : 'Wait for generation to finish')+'">Approve</button>';
      h += '<button class="rv-v-regen" disabled title="'+regenTitle+'">↻ Regen</button>';
    } else {
      h += '<button class="rv-v-send" onclick="pickVariantClick('+pidArg+','+vidArg+')" title="Approve variant '+(idx+1)+' — delivered to the user via MMS">Approve</button>';
      h += '<button class="rv-v-regen" onclick="regenVariant('+pidArg+','+vidArg+')"'+regenDisabled+' title="'+regenTitle+'">↻ Regen this</button>';
    }
    h += '</div>';
    h += '</div>';
  });
  // Fill empty slots so the grid keeps its shape when some siblings are
  // missing (e.g., permanent failures that got cleaned up).
  for (var slotIdx = variants.length; slotIdx < gridSlots; slotIdx++) {
    h += '<div class="rv-variant is-empty" aria-hidden="true">';
    h += '<div class="rv-v-imgwrap"><span class="rv-v-num">'+(slotIdx+1)+'/'+gridSlots+'</span>';
    h += '<div class="rv-v-regen-label">Unavailable</div></div>';
    h += '<div class="rv-v-actions"></div>';
    h += '</div>';
  }
  h += '</div></div>';

  h += '<div class="rv-carousel-nav">';
  h += '<button id="cnav-prev-'+pid+'" onclick="cycleMobileVariant('+pidArg+',-1)" aria-label="Previous variant">‹</button>';
  h += '<div class="rv-carousel-dots" id="cdots-'+pid+'">';
  for (var d = 0; d < variantCount; d++) {
    h += '<button type="button"'+(d===0?' class="is-active"':'')+' onclick="setMobileVariant('+pidArg+','+d+')" aria-label="Variant '+(d+1)+'"></button>';
  }
  h += '</div>';
  h += '<button id="cnav-next-'+pid+'" onclick="cycleMobileVariant('+pidArg+',1)" aria-label="Next variant">›</button>';
  h += '<span class="rv-carousel-label" id="clabel-'+pid+'">1 / '+variantCount+'</span>';
  h += '</div>';

  h += '<div class="rv-meta"><strong>'+escHtml(j.style||"Unlabeled style")+'</strong><span>'+variantCount+' of '+gridSlots+' variants</span></div>';

  var isOpen = !!_actionsOpen[cardKey];
  h += '<button class="rv-card-actions-toggle" onclick="toggleCardActions('+pidArg+')" aria-expanded="'+isOpen+'">Card-level actions '+(isOpen?'▴':'▾')+'</button>';
  h += '<div class="rv-card-actions">';
  h += '<button class="rv-btn rv-btn-notify" onclick="parentAction('+pidArg+','+jsArg("reject")+',{notify:true})" title="Discard all variants and SMS the user to try again">Reject + Notify</button>';
  h += '<button class="rv-btn rv-btn-reanalyze" onclick="showFeedback('+pidArg+')" title="Discard all and regenerate 3 new variants with optional feedback">Re-analyze All</button>';
  h += '<button class="rv-btn rv-btn-reject" onclick="parentAction('+pidArg+','+jsArg("reject")+')" title="Discard all variants silently — user is not notified">Reject Silently</button>';
  h += '</div>';

  h += '<div class="rv-feedback" id="rvfb-'+pid+'">';
  h += '<textarea placeholder="Optional: describe what to fix for all 3 regenerations"></textarea>';
  h += '<div class="rv-feedback-hint">Leave blank to re-generate all '+gridSlots+' variants with fresh analysis.</div>';
  h += '<div class="rv-feedback-btns">';
  h += '<button class="rv-btn rv-fb-submit" onclick="submitFeedbackParent('+pidArg+')">Regenerate All</button>';
  h += '<button class="rv-btn rv-fb-cancel" onclick="hideFeedback('+pidArg+')">Cancel</button>';
  h += '</div></div>';

  h += '</article>';
  return h;
}

function toggleSelect(filename, checked) {
  if (checked) _selected.add(filename); else _selected.delete(filename);
  var card = document.getElementById("rv-"+filename);
  if (card) { if (checked) card.classList.add("rv-selected"); else card.classList.remove("rv-selected"); }
  var total = document.querySelectorAll(".rv-card-check").length;
  document.getElementById("rvSelectAll").checked = _selected.size === total && total > 0;
  updateBulk(total);
}

function toggleSelectAll(checked) {
  document.querySelectorAll(".rv-card-check").forEach(function(cb) {
    cb.checked = checked;
    var card = cb.closest(".rv-card");
    var fn = card ? card.id.replace("rv-","") : null;
    if (fn) { if (checked) { _selected.add(fn); card.classList.add("rv-selected"); } else { _selected.delete(fn); card.classList.remove("rv-selected"); } }
  });
  updateBulk(document.querySelectorAll(".rv-card-check").length);
}

function updateBulk(total) {
  var bar = document.getElementById("rvBulkBar");
  var ct = document.getElementById("rvBulkCount");
  var selectAll = document.getElementById("rvSelectAll");
  selectAll.disabled = total === 0;
  selectAll.checked = total > 0 && _selected.size === total;
  bar.classList.toggle("active", _selected.size > 0);
  ct.textContent = _selected.size ? _selected.size + " of " + total + " single portraits selected" : "";
}

async function doAction(filename, action, opts) {
  opts = opts || {};
  var payload = {filename: filename, action: action};
  if (opts.notify) payload.notify = true;
  if (opts.reanalyze) {
    payload.reanalyze = true;
    if (opts.feedback) payload.feedback = opts.feedback;
  }
  try {
    var r = await fetch("/review/api/job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    if (r.status === 401) { location.href = "/review"; return; }
    var d = await r.json();
    if (d.ok) {
      _selected.delete(filename);
      var card = document.getElementById("rv-"+filename);
      if (card) card.remove();
      var msg = action === "approve" ? "Approved" : opts.reanalyze ? (payload.feedback ? "Re-generating with feedback" : "Re-generating with fresh analysis") : opts.notify ? "Rejected, user notified" : "Rejected";
      showToast(msg);
      fetchQueue();
    } else {
      var errMsg = (d.error || "").toLowerCase().indexOf("not found") >= 0 ? "Already processed by someone else" : (d.error || "Action failed");
      showToast(errMsg);
      fetchQueue();
    }
  } catch(e) { showToast("Connection error — try again"); }
}

async function bulkAction(action) {
  if (!_selected.size) { showToast("No items selected"); return; }
  var filenames = Array.from(_selected);
  var count = filenames.length;
  var label = action === "approve" ? "approve" : "reject";
  var confirmed = await twModal.confirm({
    title: action === "approve" ? "Approve selected?" : "Reject selected?",
    message: "This will " + label + " " + count + " item" + (count>1?"s":"") + ".",
    confirmText: action === "approve" ? "Approve" : "Reject",
    danger: action !== "approve",
  });
  if (!confirmed) return;
  try {
    var r = await fetch("/review/api/bulk", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({filenames: filenames, action: action})
    });
    if (r.status === 401) { location.href = "/review"; return; }
    var d = await r.json();
    _selected.clear();
    document.getElementById("rvSelectAll").checked = false;
    var ok = d.results ? d.results.filter(function(x){return x.ok}).length : 0;
    var fail = count - ok;
    showToast(ok + " " + label + (action==="approve"?"d":"ed") + (fail ? ", " + fail + " failed" : ""));
    fetchQueue();
  } catch(e) { showToast("Bulk action failed"); }
}

function showFeedback(fn) {
  _openFeedback[fn] = _openFeedback[fn] || "";
  var panel = document.getElementById("rvfb-"+fn);
  if (panel) {
    panel.classList.add("open");
    var ta = panel.querySelector("textarea");
    ta.value = _openFeedback[fn];
    ta.focus();
    ta.oninput = function() { _openFeedback[fn] = ta.value; };
  }
}
function hideFeedback(fn) {
  delete _openFeedback[fn];
  var panel = document.getElementById("rvfb-"+fn);
  if (panel) { panel.classList.remove("open"); panel.querySelector("textarea").value = ""; }
  fetchQueue();
}
function submitFeedback(fn) {
  var panel = document.getElementById("rvfb-"+fn);
  var fb = panel ? panel.querySelector("textarea").value.trim() : "";
  delete _openFeedback[fn];
  doAction(fn, "reject", { reanalyze: true, feedback: fb || undefined });
}

// filename is the singleton job's .json filename — needed to wire up the
// in-modal Approve button. Optional for back-compat.
function openSingleModal(origSrc, genSrc, filename) {
  _modalContext = filename ? { kind: "single", filename: filename } : null;
  var img = document.getElementById("reviewModalImg");
  img.src = "";
  document.getElementById("reviewModalOrig").src = origSrc;
  img.onerror = function() { this.onerror = null; this.src = genSrc.replace("_output_mms.jpg", "_output.png"); };
  img.src = genSrc;
  document.getElementById("reviewModalGenLabel").textContent = "Generated";
  var prev = document.getElementById("rvModalPrev");
  var next = document.getElementById("rvModalNext");
  if (prev) { prev.classList.remove("shown"); prev.style.display = "none"; }
  if (next) { next.classList.remove("shown"); next.style.display = "none"; }
  var approve = document.getElementById("rvModalApprove");
  if (approve) { approve.style.display = filename ? "inline-flex" : "none"; approve.disabled = false; }
  document.getElementById("reviewModal").classList.add("open");
  document.addEventListener("keydown", _esc);
}

// Multi-variant modal: pid is parentJobId, idx is variant index (-1 = start on original/variant-1)
function openMultiModal(pid, idx) {
  var ctx = _cardVariants[pid];
  if (!ctx) return;
  _modalContext = { kind: "multi", parentJobId: pid, idx: Math.max(0, idx), variantCount: ctx.variants.length };
  // Fetch only the visible variant's compressed delivery image. Opening one
  // card should not download every full-resolution sibling.
  renderModalVariant();
  document.getElementById("reviewModal").classList.add("open");
  document.addEventListener("keydown", _esc);
}

function cycleModalVariant(delta) {
  if (!_modalContext || _modalContext.kind !== "multi") return;
  var next = _modalContext.idx + delta;
  if (next < 0 || next >= _modalContext.variantCount) return;
  _modalContext.idx = next;
  renderModalVariant();
}

function renderModalVariant() {
  if (!_modalContext || _modalContext.kind !== "multi") return;
  var ctx = _cardVariants[_modalContext.parentJobId];
  if (!ctx) return;
  var v = ctx.variants[_modalContext.idx];
  var img = document.getElementById("reviewModalImg");
  // Force a visible transition so rapid arrow-keys don't leave the old image
  // painted while the new one loads. Also: blank the src to abort any in-
  // flight load before starting the next one — otherwise the previous load
  // can "win" and overwrite the newer one.
  img.src = "";
  document.getElementById("reviewModalOrig").src = ctx.origSrc;
  img.onerror = function() { this.onerror = null; this.src = v.fullSrc; };
  img.src = v.mmsSrc;
  document.getElementById("reviewModalGenLabel").textContent = "Variant " + (_modalContext.idx + 1) + " / " + _modalContext.variantCount;
  var prev = document.getElementById("rvModalPrev");
  var next = document.getElementById("rvModalNext");
  var showNav = _modalContext.variantCount > 1;
  if (prev) {
    prev.style.display = showNav ? "inline-flex" : "none";
    if (showNav) prev.classList.add("shown"); else prev.classList.remove("shown");
    prev.disabled = _modalContext.idx === 0;
  }
  if (next) {
    next.style.display = showNav ? "inline-flex" : "none";
    if (showNav) next.classList.add("shown"); else next.classList.remove("shown");
    next.disabled = _modalContext.idx === _modalContext.variantCount - 1;
  }
  // Approve is disabled unless the current variant is READY. Matches the
  // variant-card rule used elsewhere — you can only pick what's deliverable.
  var approve = document.getElementById("rvModalApprove");
  if (approve) {
    var canApprove = v && (v.status === "READY" || v.status === undefined);
    approve.style.display = "inline-flex";
    approve.disabled = !canApprove;
    approve.title = canApprove
      ? "Approve this variant (A or Enter)"
      : "Variant not ready (" + (v && v.status || "unknown") + ")";
  }
}

function closeModal(e) {
  // Only close when the user clicks the backdrop itself, not any child
  // element (images, nav buttons, labels). Previous version accidentally
  // closed the modal on nav-button clicks because BUTTON isn't IMG.
  if (e && e.target && !e.target.classList.contains("rv-modal")) return;
  document.getElementById("reviewModal").classList.remove("open");
  document.removeEventListener("keydown", _esc);
  _modalContext = null;
}
function _esc(e) {
  if (e.key === "Escape") return closeModal();
  if (_modalContext && _modalContext.kind === "multi") {
    if (e.key === "ArrowLeft") { e.preventDefault(); return cycleModalVariant(-1); }
    if (e.key === "ArrowRight") { e.preventDefault(); return cycleModalVariant(1); }
  }
  if (_modalContext && (e.key === "a" || e.key === "A" || e.key === "Enter")) {
    e.preventDefault();
    approveFromModal();
  }
}

// Approve whatever variant / image is currently visible in the modal.
// Modal closes on success so the reviewer lands back on the queue with
// one fewer card to scan. Delegates to the existing handlers
// (pickVariantClick for multi, doAction for single) so race guards,
// toasts, and optimistic card removal all work uniformly.
async function approveFromModal() {
  var ctx = _modalContext;
  if (!ctx) return;
  var btn = document.getElementById("rvModalApprove");
  if (btn && btn.disabled) return;
  if (btn) btn.disabled = true;
  try {
    if (ctx.kind === "multi") {
      var vctx = _cardVariants[ctx.parentJobId];
      if (!vctx) return;
      var v = vctx.variants[ctx.idx];
      if (!v || (v.status && v.status !== "READY")) { showToast("Variant not ready"); return; }
      console.log("Approving variant " + (ctx.idx + 1) + "/" + ctx.variantCount + " (" + v.variantId + ") of parent " + ctx.parentJobId);
      closeModal();
      await pickVariantClick(ctx.parentJobId, v.variantId);
    } else if (ctx.kind === "single") {
      console.log("Approving singleton " + ctx.filename);
      closeModal();
      await doAction(ctx.filename, "approve");
    }
  } finally {
    if (btn && document.getElementById("reviewModal").classList.contains("open")) {
      btn.disabled = false;
    }
  }
}

// ── Multi-variant handlers ─────────────────────────────────────────────────

async function pickVariantClick(parentJobId, variantId) {
  if (_pickInFlight.has(parentJobId)) return;
  _pickInFlight.add(parentJobId);

  // Disable all Send/Regen buttons on this card immediately (optimistic)
  var card = document.getElementById("rv-"+parentJobId);
  if (card) card.querySelectorAll(".rv-v-send, .rv-v-regen").forEach(function(b){ b.disabled = true; });

  try {
    var r = await fetch("/review/api/variant/pick", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ parentJobId: parentJobId, variantId: variantId }),
      credentials: "same-origin"
    });
    if (r.status === 401) { location.href = "/review"; return; }
    if (r.ok) {
      _selected.delete(parentJobId);
      if (card) card.remove();
      showToast("Sent to user");
      fetchQueue();
    } else if (r.status === 409) {
      // Already decided — treat as success for this reviewer's intent
      if (card) card.remove();
      showToast("Already handled — moving on");
      fetchQueue();
    } else {
      var d = await r.json().catch(function(){ return {}; });
      showToast(d.error || "Send failed");
      if (card) card.querySelectorAll(".rv-v-send, .rv-v-regen").forEach(function(b){ b.disabled = false; });
    }
  } catch(e) {
    showToast("Connection error — try again");
    if (card) card.querySelectorAll(".rv-v-send, .rv-v-regen").forEach(function(b){ b.disabled = false; });
  } finally {
    _pickInFlight.delete(parentJobId);
  }
}

async function regenVariant(parentJobId, variantId) {
  var key = parentJobId + "|" + variantId;
  if (_regenInFlight[key]) return;
  _regenInFlight[key] = true;

  // Find the variant DOM element; mark as regenerating
  var card = document.getElementById("rv-"+parentJobId);
  var variantEl = card ? card.querySelector('[data-variant-id="'+CSS.escape(variantId)+'"]') : null;
  if (variantEl) {
    variantEl.classList.add("is-regen");
    variantEl.classList.remove("is-failed");
    variantEl.querySelectorAll("button").forEach(function(b){ b.disabled = true; });
  }

  try {
    var r = await fetch("/review/api/variant/regenerate", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ parentJobId: parentJobId, variantId: variantId }),
      credentials: "same-origin"
    });
    if (r.status === 401) { location.href = "/review"; return; }
    if (r.ok) {
      showToast("Regenerating variant…");
      // Card will temporarily disappear from review queue (variant moves back
      // to PENDING_DIR) and reappear when all siblings are terminal again.
      fetchQueue();
    } else if (r.status === 429) {
      var dLimit = await r.json().catch(function(){ return {}; });
      showToast(dLimit.error || "Regeneration limit reached");
      if (variantEl) {
        variantEl.classList.remove("is-regen");
        variantEl.querySelectorAll("button").forEach(function(b){ b.disabled = false; });
        var regenBtn = variantEl.querySelector(".rv-v-regen");
        if (regenBtn) { regenBtn.disabled = true; regenBtn.title = "Regeneration limit reached"; }
      }
    } else {
      var d = await r.json().catch(function(){ return {}; });
      showToast(d.error || "Regenerate failed");
      if (variantEl) {
        variantEl.classList.remove("is-regen");
        variantEl.querySelectorAll("button").forEach(function(b){ b.disabled = false; });
      }
    }
  } catch(e) {
    showToast("Connection error — tap retry");
    if (variantEl) {
      variantEl.classList.remove("is-regen");
      variantEl.querySelectorAll("button").forEach(function(b){ b.disabled = false; });
    }
  } finally {
    delete _regenInFlight[key];
  }
}

async function parentAction(parentJobId, action, opts) {
  opts = opts || {};
  var payload = { parentJobId: parentJobId, action: action };
  if (opts.notify) payload.notify = true;
  if (opts.reanalyze) {
    payload.reanalyze = true;
    if (opts.feedback) payload.feedback = opts.feedback;
  }
  try {
    var r = await fetch("/review/api/job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload),
      credentials: "same-origin"
    });
    if (r.status === 401) { location.href = "/review"; return; }
    var d = await r.json();
    if (d.ok) {
      _selected.delete(parentJobId);
      var card = document.getElementById("rv-"+parentJobId);
      if (card) card.remove();
      var msg = opts.reanalyze
        ? (opts.feedback ? "Re-generating with feedback" : "Re-generating all variants")
        : opts.notify ? "Rejected — user notified" : "Rejected silently";
      showToast(msg);
      fetchQueue();
    } else {
      showToast(d.error || "Action failed");
      fetchQueue();
    }
  } catch(e) { showToast("Connection error — try again"); }
}

function submitFeedbackParent(pid) {
  var panel = document.getElementById("rvfb-"+pid);
  var fb = panel ? panel.querySelector("textarea").value.trim() : "";
  delete _openFeedback[pid];
  parentAction(pid, "reject", { reanalyze: true, feedback: fb || undefined });
}

// ── Mobile carousel nav ────────────────────────────────────────────────────

function cycleMobileVariant(pid, delta) {
  var ctx = _cardVariants[pid];
  if (!ctx) return;
  var cur = _carouselIndex[pid] || 0;
  var next = cur + delta;
  if (next < 0 || next >= ctx.variants.length) return;
  _carouselIndex[pid] = next;
  applyCarouselIndex(pid, next);
}
function setMobileVariant(pid, idx) {
  var ctx = _cardVariants[pid];
  if (!ctx || idx < 0 || idx >= ctx.variants.length) return;
  _carouselIndex[pid] = idx;
  applyCarouselIndex(pid, idx);
}
function applyCarouselIndex(pid, idx) {
  var card = document.getElementById("rv-"+pid);
  if (!card) return;
  var variants = card.querySelectorAll(".rv-variant");
  variants.forEach(function(el, i){
    el.classList.toggle("is-active", i === idx);
  });
  var dots = card.querySelectorAll("#cdots-"+CSS.escape(pid)+" button");
  dots.forEach(function(el, i){ el.classList.toggle("is-active", i === idx); });
  var label = document.getElementById("clabel-"+pid);
  if (label) label.textContent = (idx + 1) + " / " + variants.length;
  var prev = document.getElementById("cnav-prev-"+pid);
  var next = document.getElementById("cnav-next-"+pid);
  if (prev) prev.disabled = idx === 0;
  if (next) next.disabled = idx === variants.length - 1;
}

function toggleCardActions(pid) {
  var card = document.getElementById("rv-"+pid);
  if (!card) return;
  var open = card.classList.toggle("actions-open");
  // Persist across poll-driven re-renders — without this, the next poll
  // (every 3s) wipes the DOM and the panel collapses under the user.
  if (open) _actionsOpen[pid] = true; else delete _actionsOpen[pid];
  var btn = card.querySelector(".rv-card-actions-toggle");
  if (btn) {
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Card-level actions ▴" : "Card-level actions ▾";
  }
}

// ── Mobile swipe gestures ──────────────────────────────────────────────────
// Two swipe contexts:
//   1. Variant carousel row inside a multi-variant card (mobile only, ≤600px)
//   2. Comparison modal (any width) — swipe through variants when modal is open
// Both share the same body-level event delegation so handlers survive DOM
// re-renders without rebinding.
(function setupSwipeNav() {
  var SWIPE_THRESHOLD_PX = 50;
  var touchStartX = 0, touchStartY = 0, touchStartTime = 0;
  var touchActivePid = null;      // variant-row swipe target
  var touchActiveModal = false;   // modal swipe context

  function findCardPid(target) {
    var card = target.closest && target.closest(".rv-card.rv-multi");
    if (!card) return null;
    var row = target.closest(".rv-variant-row");
    if (!row) return null;
    return card.id.replace("rv-", "");
  }

  function insideOpenModal(target) {
    // The comparison modal has id="reviewModal" and .open when visible.
    var modal = document.getElementById("reviewModal");
    if (!modal || !modal.classList.contains("open")) return false;
    return modal.contains(target);
  }

  document.body.addEventListener("touchstart", function(e) {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = Date.now();
    touchActivePid = null;
    touchActiveModal = false;

    // Modal takes priority over variant row — if the modal is open, it's
    // receiving the gesture regardless of viewport width.
    if (insideOpenModal(e.target)) {
      touchActiveModal = true;
      return;
    }

    // Variant row: mobile widths only.
    if (window.innerWidth > 600) return;
    var pid = findCardPid(e.target);
    if (pid) touchActivePid = pid;
  }, { passive: true });

  document.body.addEventListener("touchend", function(e) {
    if (!touchActivePid && !touchActiveModal) return;
    if (!e.changedTouches || !e.changedTouches.length) return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    var dy = e.changedTouches[0].clientY - touchStartY;
    var elapsed = Date.now() - touchStartTime;
    var pid = touchActivePid;
    var wasModal = touchActiveModal;
    touchActivePid = null;
    touchActiveModal = false;

    // Ignore if vertical movement dominates (user was scrolling), or if the
    // swipe took too long (>600ms) — treat that as a slow drag, not a flick.
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (elapsed > 600) return;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;

    // Swipe left (dx < 0) → next; right (dx > 0) → previous.
    var delta = dx < 0 ? 1 : -1;
    if (wasModal) cycleModalVariant(delta);
    else if (pid) cycleMobileVariant(pid, delta);
  }, { passive: true });

  document.body.addEventListener("touchcancel", function() {
    touchActivePid = null;
    touchActiveModal = false;
  }, { passive: true });
})();

// Poll every 5s while the document is visible. When hidden (e.g. phone
// locked, tab backgrounded) pause polling to save battery. On visibility
// restore, fetch immediately so the reviewer sees the latest state
// instead of whatever snapshot was current when they switched away.
var _pollTimer = null;
function startPolling() {
  if (_pollTimer) return;
  _pollTimer = setInterval(fetchQueue, 5000);
}
function stopPolling() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}
document.addEventListener("visibilitychange", function() {
  if (document.visibilityState === "visible") {
    fetchQueue();
    startPolling();
  } else {
    stopPolling();
  }
});
fetchReviewEvents().then(function() {
  fetchQueue();
  if (document.visibilityState === "visible") startPolling();
});
</script>
</body></html>`;


function buildReviewQueueHtml({ adminNav = false } = {}) {
  return QUEUE_HTML
    .replace("{{SITE_NAV_STYLESHEET}}", adminNav ? siteNavStylesheet() : "")
    .replace("{{ADMIN_BODY_CLASS}}", adminNav ? "review-admin" : "")
    .replace("{{SITE_NAV}}", adminNav ? renderSiteNav("review") : "")
    .replace("{{ADMIN_TOPBAR_CLASS}}", adminNav ? " review-topbar--admin" : "")
    .replace("{{REVIEW_HEADER_LABEL}}", adminNav
      ? '<span class="review-local-title">Review queue</span>'
      : '<span class="review-brand"><img src="/assets/icon-twilio-bug-red.svg" alt=""><span>Twilio <strong>Photo booth</strong></span></span>')
    .replace("{{STAFF_NAV}}", adminNav ? "" : '<nav class="review-global-nav" aria-label="Review navigation"><a href="/review/queue" class="is-current" aria-current="page">Review</a></nav>');
}

module.exports = { buildReviewQueueHtml };

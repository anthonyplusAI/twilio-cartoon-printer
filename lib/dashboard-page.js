// Static dashboard view, separate from the queue/router so the local preview can render
// it with synthetic data and without importing runtime services.
const { renderSiteNav, siteNavStylesheet } = require("./site-nav");

function renderDashboardPage({ userBar = "", magicHat = "" } = {}) {
    return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<link rel="stylesheet" href="/assets/tw-modal.css">
${siteNavStylesheet()}
<script src="/assets/tw-modal.js"></script>
<title>Dashboard — Twilio Photobooth</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: clamp(15px, 1.2vw, 19px); }
  body {
    background: var(--th-bg);
    color: var(--th-text-dim);
    min-height: 100vh;
    padding: clamp(20px, 3vw, 48px) clamp(16px, 3vw, 40px);
    -webkit-font-smoothing: antialiased;
    scrollbar-width: thin; scrollbar-color: var(--th-input-border) var(--th-bg);
  }
  .wrap { max-width: 1400px; margin: 0 auto; }

  /* Section group dividers */
  .section-group { margin-bottom: clamp(20px, 2.5vw, 36px); }
  .section-label {
    font-size: 11px; font-weight: 700; color: var(--th-text-muted);
    text-transform: uppercase; letter-spacing: 1.5px;
    font-family: 'Twilio Sans Mono', monospace;
    padding: 0 0 14px 0;
    display: flex; align-items: center; gap: 12px;
  }
  .section-label::after { content: ''; flex: 1; height: 1px; background: var(--th-card-border); }

  /* Header */
  .header {
    display: flex; justify-content: space-between; align-items: flex-start;
    margin-bottom: clamp(20px, 2.5vw, 36px);
    padding-bottom: clamp(14px, 1.5vw, 22px);
    border-bottom: 1px solid var(--th-card-border);
    gap: 16px; flex-wrap: wrap;
  }
  .header h1 {
    font-size: clamp(20px, 1.6vw, 28px); font-weight: 700; color: var(--th-text);
    letter-spacing: -0.3px; display: flex; align-items: center; gap: 8px;
    padding-top: 6px;
  }
  .status-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    animation: pulse 2s infinite; flex-shrink: 0;
  }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .4; } }

  .header-controls {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    /* When there are too many chips to fit alongside <h1>, the parent
       .header wraps and this block lands on the next row. margin-left:auto
       keeps it pushed to the right edge instead of snapping to the left. */
    margin-left: auto; justify-content: flex-end;
  }
  .hdr-item {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--th-card); backdrop-filter: blur(8px);
    border: 1px solid var(--th-card-border); border-radius: 10px;
    padding: 8px 14px; font-size: 13px; font-weight: 400; color: var(--th-text-dim);
    font-family: inherit; cursor: pointer; white-space: nowrap;
    transition: all .2s ease;
    text-decoration: none;
  }
  .hdr-item:hover { color: var(--th-text); border-color: var(--th-input-border); background: var(--th-raised); box-shadow: 0 2px 8px rgba(0,0,0,.15); }
  .hdr-item svg { width: 14px; height: 14px; flex-shrink: 0; }
  .hdr-item select {
    background: transparent; border: none; color: var(--th-text);
    font-size: 13px; font-weight: 700; font-family: inherit;
    cursor: pointer; outline: none; padding: 0; margin: 0;
    -webkit-appearance: none; appearance: none;
  }
  .hdr-item select option { background: var(--th-card); color: var(--th-text-dim); }
  .hdr-item input[type=checkbox] { accent-color: var(--brand-red); cursor: pointer; margin: 0; }
  .hdr-item.hdr-action {
    background: linear-gradient(135deg, var(--brand-red), #e0283e); border-color: var(--brand-red); color: #fff; font-weight: 700;
    letter-spacing: .2px; box-shadow: 0 2px 8px rgba(242,47,70,.2);
  }
  .hdr-item.hdr-action:hover { background: linear-gradient(135deg, #ff3a52, var(--brand-red)); border-color: #ff3a52; box-shadow: 0 4px 16px rgba(242,47,70,.3); }
  .hdr-item.hdr-action:disabled { opacity: .6; cursor: default; box-shadow: none; }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(clamp(130px, 13vw, 210px), 1fr)); gap: clamp(12px, 1.2vw, 18px); margin-bottom: clamp(8px, 1vw, 16px); }
  .card {
    background: linear-gradient(145deg, var(--th-card), var(--th-card));
    border: 1px solid var(--th-card-border);
    border-top: 3px solid var(--th-card-border);
    border-radius: 16px;
    padding: clamp(20px, 2vw, 32px) clamp(16px, 1.4vw, 24px);
    text-align: center;
    position: relative;
    overflow: hidden;
    transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease;
    box-shadow: 0 2px 8px rgba(0,0,0,.12);
  }
  .card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 80px;
    background: linear-gradient(180deg, rgba(255,255,255,.03) 0%, transparent 100%);
    pointer-events: none;
  }
  .card:hover { transform: translateY(-3px); box-shadow: 0 12px 40px rgba(0,0,0,.25); border-color: var(--th-input-border); }
  .card:nth-child(1) { border-top-color: var(--blue-400); }
  .card:nth-child(2) { border-top-color: var(--blue-400); }
  .card:nth-child(3) { border-top-color: var(--blue-500); }
  .card:nth-child(4) { border-top-color: var(--blue-300); }
  .card:nth-child(5) { border-top-color: var(--red-400); }
  .card:nth-child(1)::before { background: linear-gradient(180deg, rgba(33,136,239,.06) 0%, transparent 100%); }
  .card:nth-child(2)::before { background: linear-gradient(180deg, rgba(33,136,239,.06) 0%, transparent 100%); }
  .card:nth-child(3)::before { background: linear-gradient(180deg, rgba(24,102,238,.06) 0%, transparent 100%); }
  .card:nth-child(4)::before { background: linear-gradient(180deg, rgba(25,171,243,.06) 0%, transparent 100%); }
  .card:nth-child(5)::before { background: linear-gradient(180deg, rgba(248,61,83,.06) 0%, transparent 100%); }
  .card .value { font-size: clamp(24px, 2.4vw, 42px); font-weight: 800; color: var(--th-text); font-variant-numeric: tabular-nums; position: relative; transition: color .3s; font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }
  .card .label { font-size: 12px; color: var(--th-text-muted); margin-top: 6px; text-transform: uppercase; letter-spacing: .6px; font-weight: 400; position: relative; font-family: 'Twilio Sans Mono', monospace; }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: clamp(12px, 1.2vw, 18px); }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }

  .panel {
    background: linear-gradient(160deg, var(--th-card), var(--th-card));
    border: 1px solid var(--th-card-border);
    border-radius: 16px;
    padding: clamp(24px, 2.2vw, 36px);
    position: relative;
    overflow: hidden;
    transition: border-color .2s ease, box-shadow .2s ease;
    box-shadow: 0 2px 8px rgba(0,0,0,.1);
  }
  .panel::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: var(--th-card-border);
  }
  .panel:hover { border-color: var(--th-input-border); box-shadow: 0 8px 32px rgba(0,0,0,.2); }
  .panel h2 {
    font-size: 13px; font-weight: 700; color: var(--th-text-secondary);
    text-transform: uppercase; letter-spacing: 1px;
    margin-bottom: clamp(14px, 1.4vw, 22px);
    padding-left: 12px; border-left: 3px solid var(--blue-400);
    font-family: 'Twilio Sans Mono', monospace;
    line-height: 1; padding-top: 1px; padding-bottom: 1px;
  }
  /* Panel accent colors by section */
  .sg-analytics .panel::before { background: linear-gradient(90deg, var(--blue-400), transparent); }
  .sg-analytics .panel h2 { border-left-color: var(--blue-400); }
  .sg-users .panel::before { background: linear-gradient(90deg, var(--blue-400), transparent); }
  .sg-users .panel h2 { border-left-color: var(--blue-400); }
  .sg-failures .panel::before { background: linear-gradient(90deg, var(--blue-300), transparent); }
  .sg-failures .panel h2 { border-left-color: var(--blue-300); }
  .sg-operations .panel::before { background: linear-gradient(90deg, var(--blue-500), transparent); }
  .sg-operations .panel h2 { border-left-color: var(--blue-500); }
  .sg-links .panel::before { background: linear-gradient(90deg, var(--blue-200), transparent); }
  .sg-links .panel h2 { border-left-color: var(--blue-200); }
  .link-summary { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
  .link-stat { display: flex; flex-direction: column; gap: 4px; padding: 14px 16px; background: var(--th-bg); border-radius: 12px; border: 1px solid var(--th-card-border); }
  .link-stat-val { font-size: clamp(20px, 2vw, 32px); font-weight: 800; color: var(--th-text); font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; font-variant-numeric: tabular-nums; }
  .link-stat-lbl { font-size: 11px; color: var(--th-text-muted); text-transform: uppercase; letter-spacing: .6px; font-family: 'Twilio Sans Mono', monospace; }
  .link-stat-desc { font-size: 11px; color: var(--th-text-dim); line-height: 1.4; margin-top: 2px; font-family: 'Twilio Sans Text', sans-serif; }
  .link-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 0; }
  .link-name { width: clamp(100px, 10vw, 180px); font-size: 12px; color: var(--th-text-secondary); text-align: right; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; font-family: 'Twilio Sans Mono', monospace; }
  .link-bar-bg { flex: 1; height: clamp(16px, 1.4vw, 24px); background: var(--th-bg); border-radius: 6px; overflow: hidden; border: 1px solid var(--th-card-border); }
  .link-bar { height: 100%; border-radius: 5px; transition: width .5s ease; min-width: 2px; background: var(--blue-200); }
  .link-count { width: 40px; font-size: 13px; font-weight: 700; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; color: var(--th-text); font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }
  .sg-audit .panel::before { background: linear-gradient(90deg, var(--blue-300), transparent); }
  .sg-audit .panel h2 { border-left-color: var(--blue-300); }
  .audit-row { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--th-card-border); font-size: 13px; }
  .audit-row:last-child { border-bottom: none; }
  .audit-time { color: var(--th-text-muted); white-space: nowrap; min-width: 140px; }
  .audit-actor { color: var(--th-text-muted); min-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .audit-detail { flex: 1; color: var(--th-text); }
  .audit-detail .key { color: var(--blue-400); font-weight: 600; }
  .audit-detail .old { color: #F83D53; text-decoration: line-through; }
  .audit-detail .new { color: #34D399; }
  .audit-detail .audit-meta { color: var(--th-text-muted); font-size: 12px; }
  .audit-revert { flex-shrink: 0; }
  .audit-revert button { font-size: 11px; padding: 4px 10px; border-radius: 4px; border: 1px solid var(--th-input-border); background: transparent; color: var(--th-text-muted); cursor: pointer; }
  .audit-revert button:hover { border-color: var(--blue-400); color: var(--blue-400); }
  .audit-revert button:disabled { opacity: 0.4; cursor: default; }
  .audit-reverted { font-size: 11px; color: var(--th-text-muted); font-style: italic; }

  .btn {
    background: var(--th-card-border); color: var(--th-text-dim); border: 1px solid #364050; border-radius: 10px;
    padding: 8px 18px; font-size: 13px; font-weight: 700; font-family: inherit;
    cursor: pointer; transition: all .2s ease;
  }
  .btn:hover { background: var(--th-input-border); transform: translateY(-1px); box-shadow: 0 2px 8px rgba(0,0,0,.15); }
  .btn:active { transform: translateY(0); box-shadow: none; }
  .btn-primary { background: var(--brand-red); border-color: var(--brand-red); color: #fff; font-weight: 700; box-shadow: 0 2px 8px rgba(239,34,58,.2); }
  .btn-primary:hover { background: #F83D53; box-shadow: 0 4px 16px rgba(239,34,58,.3); }
  .btn-danger { background: var(--red-600); border-color: var(--red-600); color: #fff; font-weight: 700; }
  .btn-danger:hover { background: #C91229; box-shadow: 0 4px 16px rgba(177,15,35,.3); }
  .stuck-alert {
    text-align: center; padding: 10px 14px; border-radius: 10px; margin-bottom: 14px;
    font-weight: 700; font-size: 13px; display: none;
  }
  .stuck-alert.warning { display: block; background: rgba(25,171,243,.07); color: var(--blue-300); border: 1px solid rgba(25,171,243,.2); }
  .stuck-alert.error { display: block; background: rgba(239,34,58,.07); color: var(--brand-red); border: 1px solid rgba(239,34,58,.2); }

  /* Queue status */
  .queue-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 12px 16px; margin-bottom: 6px;
    background: var(--th-bg); border: 1px solid var(--th-card-border); border-radius: 10px;
    transition: all .2s ease;
  }
  .queue-row:hover { border-color: var(--th-input-border); background: var(--th-bg-subtle); box-shadow: 0 2px 8px rgba(0,0,0,.1); }
  .queue-label { display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 400; }
  .queue-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .queue-count { font-weight: 700; font-size: clamp(15px, 1.3rem, 24px); font-variant-numeric: tabular-nums; color: var(--th-text); font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }

  /* Style bars */
  .style-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 0; }
  .style-name { width: clamp(60px, 6vw, 100px); font-size: 13px; color: var(--th-text-secondary); text-align: right; flex-shrink: 0; font-weight: 400; }
  .style-bar-bg { flex: 1; height: clamp(18px, 1.5vw, 26px); background: var(--th-bg); border-radius: 8px; overflow: hidden; border: 1px solid var(--th-card-border); }
  .style-bar { height: 100%; border-radius: 7px; transition: width .6s cubic-bezier(.25,.8,.25,1); min-width: 3px; box-shadow: inset 0 1px 0 rgba(255,255,255,.1); }
  .style-count { width: 34px; font-size: 13px; font-weight: 700; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; color: var(--th-text); font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }

  /* Hourly chart */
  .hourly-bars {
    display: flex; align-items: flex-end; gap: 3px; height: clamp(80px, 9vw, 140px);
    position: relative; padding: 8px 0;
    border-bottom: 1px solid var(--th-card-border);
  }
  .hourly-bar {
    flex: 1; background: linear-gradient(180deg, var(--blue-300), var(--blue-400)); border-radius: 5px 5px 0 0; min-height: 3px;
    transition: height .4s ease, opacity .15s, transform .15s; cursor: default; position: relative;
  }
  .hourly-bar:hover { opacity: .85; transform: scaleX(1.1); }
  .hourly-bar:hover .hourly-tip { display: block; }
  .hourly-tip {
    display: none; position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%);
    background: var(--th-raised); color: var(--th-text); font-size: 12px; font-weight: 700; padding: 4px 10px;
    border-radius: 6px; white-space: nowrap; pointer-events: none; z-index: 10;
  }
  .hourly-tip::after {
    content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
    border: 4px solid transparent; border-top-color: var(--th-raised);
  }
  .hourly-labels { display: flex; gap: 3px; margin-top: 6px; }
  .hourly-label { flex: 1; font-size: clamp(7px, 0.6rem, 11px); color: var(--th-text-muted); text-align: center; white-space: nowrap; }

  /* Printer */
  .printer-status {
    display: flex; align-items: center; gap: 10px; font-size: 13px; font-weight: 400;
    padding: 8px 12px; margin-bottom: 4px;
    background: var(--th-bg); border-radius: 8px; border: 1px solid var(--th-card-border);
  }
  .printer-status:last-child { margin-bottom: 0; }
  .printer-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .ptr-btn {
    font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 6px; cursor: pointer;
    font-family: inherit; border: 1px solid; transition: background .15s, border-color .15s;
  }
  .ptr-btn-disable { background: rgba(239,34,58,.09); color: var(--brand-red); border-color: rgba(239,34,58,.2); }
  .ptr-btn-disable:hover { background: rgba(239,34,58,.16); border-color: var(--brand-red); }
  .ptr-btn-enable { background: rgba(33,136,239,.09); color: var(--blue-400); border-color: rgba(33,136,239,.2); }
  .ptr-btn-enable:hover { background: rgba(33,136,239,.16); border-color: var(--blue-400); }
  .fj-printer-select {
    font-size: 11px; padding: 3px 6px; border-radius: 6px; border: 1px solid var(--th-input-border);
    background: var(--th-input-bg); color: var(--th-text); font-family: inherit; cursor: pointer;
  }
  /* Combined jobs panel */
  .jb-tabs { display: flex; gap: 4px; }
  .jb-tab {
    font-size: 11px; font-weight: 700; padding: 4px 12px; border-radius: 6px; cursor: pointer;
    font-family: inherit; border: 1px solid var(--th-card-border); background: var(--th-bg); color: var(--th-text-muted);
    transition: background .15s, border-color .15s, color .15s;
  }
  .jb-tab:hover { background: var(--th-raised); }
  .jb-tab.active { background: rgba(33,136,239,.09); color: var(--blue-400); border-color: rgba(33,136,239,.2); }
  .jb-list { max-height: 500px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--th-input-border) var(--th-card); }
  /* Header and every row use identical tracks. The fixed action track keeps
     button and dropdown combinations from shifting the other columns. */
  .jb-grid-cols {
    display: grid;
    grid-template-columns: 44px 110px minmax(80px, 1fr) 90px 110px 90px 60px 220px;
    align-items: center; gap: 8px 10px;
  }
  .jb-header {
    padding: 6px 12px 8px; margin-bottom: 2px;
    font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.6px; color: var(--th-text-muted);
    font-family: 'Twilio Sans Mono', monospace;
    border-bottom: 1px solid var(--th-card-border); position: sticky; top: 0;
    background: var(--th-card); z-index: 1;
  }
  .jb-time-head, .jb-action-head { text-align: right; }
  .jb-row {
    padding: 10px 12px; margin-bottom: 4px;
    background: var(--th-bg); border-radius: 8px; border: 1px solid var(--th-card-border); font-size: 13px;
  }
  .jb-row.has-detail { grid-template-rows: auto auto; }
  .jb-thumb-link, .jb-thumb-empty {
    flex-shrink: 0; width: 36px; height: 36px; border-radius: 4px; display: inline-block;
  }
  .jb-thumb {
    width: 36px; height: 36px; object-fit: cover; border-radius: 4px;
    background: var(--th-input); display: block; cursor: pointer;
    transition: transform 0.15s ease;
  }
  .jb-thumb:hover { transform: scale(1.08); }
  .jb-thumb-empty {
    background: var(--th-bg-subtle); border: 1px dashed var(--th-card-border);
  }
  .jb-phone { color: var(--th-text-secondary); font-family: 'Twilio Sans Mono', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .jb-name { color: var(--th-text); font-weight: 600; font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jb-style { color: var(--th-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .jb-printer { color: var(--th-text-muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .jb-time { color: var(--th-text-muted); font-size: 11px; text-align: right; white-space: nowrap; }
  .jb-status {
    font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 6px;
    text-transform: uppercase; letter-spacing: .3px;
  }
  .jb-status.done { background: rgba(33,186,69,.09); color: #21ba45; }
  .jb-status.moderation { background: rgba(239,34,58,.09); color: var(--brand-red); }
  .jb-status.face_detection { background: rgba(25,171,243,.09); color: var(--blue-300); }
  .jb-status.multi_subject { background: rgba(206,147,37,.09); color: #ce9325; }
  .jb-status.ai_review_rejected { background: rgba(164,94,229,.09); color: #a45ee5; }
  .jb-status.review_rejected { background: rgba(164,94,229,.09); color: #a45ee5; }
  .jb-status.content_rejected { background: rgba(239,34,58,.09); color: var(--brand-red); }
  .jb-status.generation { background: rgba(24,102,238,.09); color: var(--blue-500); }
  .jb-status.printer { background: rgba(33,136,239,.09); color: var(--blue-400); }
  .jb-status.relay_stale { background: rgba(33,136,239,.09); color: var(--blue-400); }
  .jb-status.max_retries { background: rgba(107,117,133,.09); color: var(--th-text-muted); }
  .jb-status.unknown { background: rgba(107,117,133,.09); color: var(--th-text-muted); }
  .jb-status.ready { background: rgba(107,117,133,.12); color: var(--th-text-secondary); }
  .jb-status.printing { background: rgba(24,102,238,.12); color: var(--blue-500); }
  .jb-bounce { font-size: 10px; font-weight: 700; color: #ce9325; background: rgba(206,147,37,.09); padding: 2px 6px; border-radius: 5px; white-space: nowrap; cursor: help; }
  .jb-btn {
    background: rgba(33,136,239,.09); color: var(--blue-400); border: 1px solid rgba(33,136,239,.2); border-radius: 6px;
    padding: 4px 12px; font-size: 11px; font-weight: 700; cursor: pointer; font-family: inherit;
    transition: background .15s, border-color .15s;
  }
  .jb-btn:hover { background: rgba(33,136,239,.16); border-color: var(--blue-400); }
  .jb-btn:disabled { opacity: .4; cursor: default; }
  .jb-detail {
    grid-column: 1 / -1; font-size: 11px; color: var(--th-text-muted); line-height: 1.5;
    padding: 4px 0 0; border-top: 1px solid var(--th-card-border); margin-top: 2px;
  }
  .jb-action { text-align: right; display: flex; gap: 4px; justify-content: flex-end; align-items: center; }
  .jb-empty { color: var(--th-text-muted); font-size: 13px; padding: 16px 0; }

  /* Top users */
  .user-row {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 12px; margin-bottom: 4px;
    background: var(--th-bg); border-radius: 8px;
    transition: background .15s;
  }
  .user-row:hover { background: var(--th-raised); }
  .user-phone { color: var(--th-text-secondary); font-family: 'Twilio Sans Mono', monospace; font-size: 13px; width: 110px; flex-shrink: 0; }
  .user-name { color: var(--th-text); font-weight: 600; font-size: 13px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .user-count { font-weight: 700; font-variant-numeric: tabular-nums; font-size: 13px; color: var(--th-text); font-family: 'Twilio Sans Mono', monospace; white-space: nowrap; width: 90px; flex-shrink: 0; text-align: right; }
  .du-badges { display: flex; gap: 4px; flex-shrink: 0; width: 80px; }
  .du-badge { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 6px; text-transform: uppercase; letter-spacing: 0.5px; white-space: nowrap; }
  .du-badge-admin { background: rgba(239,34,58,0.15); color: var(--brand-red); }
  .du-badge-lead { background: rgba(33,136,239,0.15); color: var(--blue-400); }
  .du-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .btn-xs { padding: 4px 10px; font-size: 11px; border-radius: 6px; }

  /* Failure breakdown bars */
  .fail-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 0; }
  .fail-name { width: clamp(75px, 7vw, 110px); font-size: 13px; color: var(--th-text-secondary); text-align: right; flex-shrink: 0; font-weight: 400; }
  .fail-bar-bg { flex: 1; height: clamp(16px, 1.4vw, 24px); background: var(--th-bg); border-radius: 6px; overflow: hidden; border: 1px solid var(--th-card-border); }
  .fail-bar { height: 100%; border-radius: 5px; transition: width .5s ease; min-width: 2px; }
  .fail-count { width: 34px; font-size: 13px; font-weight: 700; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; color: var(--th-text); font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }

  /* Geography bars */
  .geo-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; padding: 4px 0; }
  .geo-name { width: clamp(90px, 9vw, 150px); font-size: 13px; color: var(--th-text-secondary); text-align: right; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; }
  .geo-bar-bg { flex: 1; height: clamp(16px, 1.4vw, 24px); background: var(--th-bg); border-radius: 6px; overflow: hidden; border: 1px solid var(--th-card-border); }
  .geo-bar { height: 100%; border-radius: 5px; transition: width .5s ease; min-width: 2px; background: var(--blue-200); }
  .geo-count { width: 34px; font-size: 13px; font-weight: 700; text-align: right; flex-shrink: 0; font-variant-numeric: tabular-nums; color: var(--th-text); font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }

  /* Job Health grid */
  .health-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
  }
  .health-stat {
    display: flex; flex-direction: column; gap: 4px;
    padding: 14px 16px; background: var(--th-bg); border-radius: 12px; border: 1px solid var(--th-card-border);
    transition: border-color .2s, box-shadow .2s;
  }
  .health-stat:hover { border-color: var(--th-input-border); box-shadow: 0 2px 8px rgba(0,0,0,.1); }
  .health-val { font-size: clamp(20px, 1.8vw, 32px); font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.1; font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }
  .health-val-sm { font-size: clamp(16px, 1.4vw, 24px); }
  .health-lbl { font-size: 11px; color: var(--th-text-muted); text-transform: uppercase; letter-spacing: .5px; font-weight: 400; font-family: 'Twilio Sans Mono', monospace; }
  .health-timing {
    display: flex; gap: 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--th-card-border);
  }
  .health-timing .health-stat { flex: 1; }

  /* NPS panel */
  .nps-content { display: flex; align-items: flex-start; gap: 24px; flex-wrap: wrap; }
  .nps-disabled { color: var(--th-text-muted); font-size: 13px; padding: 12px 0; }
  .nps-big { display: flex; flex-direction: column; align-items: center; min-width: 80px; }
  .nps-score { font-size: clamp(36px, 3vw, 56px); font-weight: 800; line-height: 1; font-family: 'Twilio Sans Display', sans-serif; letter-spacing: 0.02em; }
  .nps-score-good { color: var(--blue-400); }
  .nps-score-ok { color: var(--blue-300); }
  .nps-score-bad { color: var(--brand-red); }
  .nps-count { font-size: 12px; color: var(--th-text-muted); margin-top: 4px; }
  .nps-bars { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 6px; }
  .nps-bar-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .nps-bar-label { width: 14px; text-align: right; color: var(--th-text-secondary); font-weight: 700; }
  .nps-bar-track { flex: 1; height: 18px; background: var(--th-bg); border-radius: 4px; overflow: hidden; border: 1px solid var(--th-card-border); }
  .nps-bar-fill { height: 100%; border-radius: 4px; transition: width .3s ease; }
  .nps-bar-val { width: 28px; font-size: 12px; color: var(--th-text-muted); }

  .fj-toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--blue-400); color: #fff; padding: 10px 20px; border-radius: 10px;
    font-size: 13px; font-weight: 700; z-index: 100; opacity: 0; transition: opacity .3s;
    pointer-events: none;
  }
  .fj-toast.show { opacity: 1; }

  .footer {
    text-align: center; color: var(--th-text-muted); font-size: 12px; font-weight: 400;
    margin-top: 56px; padding: 28px 0 12px;
    border-top: 1px solid var(--th-card-border);
    letter-spacing: .3px;
  }

  /* Review banner */
  @keyframes review-pulse {
    0%, 100% { border-color: var(--blue-300); box-shadow: 0 0 14px rgba(25,171,243,0.30), inset 0 0 14px rgba(25,171,243,0.10); }
    50%      { border-color: var(--brand-red); box-shadow: 0 0 32px rgba(239,34,58,0.55), inset 0 0 24px rgba(239,34,58,0.18); }
  }
  .review-banner {
    background: var(--th-card); border: 5px solid var(--blue-300); border-radius: 14px;
    padding: 20px 24px; margin-bottom: 20px;
    animation: review-pulse 1.6s ease-in-out infinite;
  }
  .review-header {
    display: flex; align-items: center; gap: 10px; margin-bottom: 14px;
  }
  .review-header h2 { margin: 0; font-size: 16px; }
  .review-icon { font-size: 22px; color: var(--blue-300); }
  .review-badge {
    font-size: 12px; background: var(--brand-red); color: #fff;
    border-radius: 10px; padding: 2px 10px; margin-left: 8px;
    font-weight: 700;
  }
  /* QR review block */
  .qr-review-block {
    display: flex; align-items: center; gap: 20px;
    background: var(--th-bg-subtle, var(--th-bg));
    border: 1px dashed var(--th-card-border); border-radius: 10px;
    padding: 16px 20px; margin-bottom: 16px;
  }
  .qr-review-block.qr-review-hint-only { justify-content: center; padding: 12px 16px; }
  .qr-review-code { flex-shrink: 0; width: 120px; height: 120px; }
  .qr-review-code svg { width: 100%; height: 100%; }
  [data-theme="dark"] .qr-review-code svg path { stroke: #FFFFFF; }
  [data-theme="light"] .qr-review-code svg path { stroke: #000D25; }
  .qr-review-info { flex: 1; min-width: 0; }
  .qr-review-title {
    font-family: 'Twilio Sans Display', sans-serif; font-size: 15px;
    font-weight: 700; color: var(--th-text); margin-bottom: 6px;
  }
  .qr-review-url {
    font-family: 'Twilio Sans Mono', monospace; font-size: 12px;
    color: var(--blue-300); word-break: break-all; margin-bottom: 6px;
  }
  .qr-review-hint { font-size: 12px; color: var(--th-text-muted); }
  @media (max-width: 500px) {
    .qr-review-block { flex-direction: column; text-align: center; }
    .qr-review-code { width: 100px; height: 100px; }
  }

  /* Review grid: fit 3 multi-variant cards per row. Each multi-card spans
     2 base columns (rv-card.rv-multi { grid-column: span 2 }), so we need
     6 base tracks of 1fr to get 3 cards across. auto-fit collapses unused
     tracks so the layout stays tight instead of leaving trailing white-
     space on the right. At narrower widths the grid falls back to 2 → 1
     cards per row automatically. */
  .review-grid {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px;
  }
  .rv-card {
    background: var(--th-bg-subtle); border-radius: 8px; padding: 12px; text-align: center;
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
  .rv-meta { font-size: 11px; color: var(--th-text-secondary); margin-bottom: 10px; }
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
  .rv-btn-reject { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-secondary); }
  .rv-btn-reject:hover { border-color: var(--brand-red); color: var(--brand-red); background: rgba(239,34,58,.08); }
  .rv-btn-notify { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-secondary); }
  .rv-btn-notify:hover { border-color: var(--blue-300); color: var(--blue-300); background: rgba(25,171,243,.08); }
  .rv-btn-reanalyze { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-secondary); }
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
  /* Placeholder for missing variants — keeps the grid shape consistent when
     some siblings failed and were cleaned up. Non-interactive; shows a
     dim "Unavailable" label where the image would be. */
  .rv-variant.is-empty .rv-v-imgwrap {
    background: var(--th-bg); border: 1px dashed var(--th-card-border);
    position: relative; aspect-ratio: 1 / 1; border-radius: 4px;
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
    background: transparent; color: var(--th-text-secondary);
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
  .rv-multi .rv-card-actions .rv-btn {
    width: auto; flex: 1; min-width: 110px; font-size: 11px; padding: 8px 10px;
  }

  /* Modal action bar (prev / approve / next). Single container so the
     approve button always shows — whether the card is a singleton (no
     prev/next) or multi-variant. Inner buttons toggle display independently. */
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
  /* Shown state — toggled by JS (display:none inline → display:inline-flex). */
  .rv-modal-nav-btn.shown { display: inline-flex; }
  .rv-modal-nav-btn:hover:not(:disabled) { border-color: var(--blue-400); color: var(--blue-400); }
  .rv-modal-nav-btn:disabled { opacity: .3; cursor: not-allowed; }
  /* Approve button sits between prev/next, styled like the card-level primary
     approve so the visual is consistent. Wider pill, not a circle. */
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

  /* Re-analyze feedback panel */
  .rv-feedback {
    display: none; margin-top: 8px; text-align: left;
  }
  .rv-feedback.open { display: block; }
  .rv-feedback textarea {
    width: 100%; box-sizing: border-box; min-height: 60px; padding: 8px; border-radius: 6px;
    border: 1px solid var(--th-input-border); background: var(--th-bg); color: var(--th-text);
    font-size: 12px; font-family: inherit; resize: vertical;
  }
  .rv-feedback textarea:focus { outline: none; border-color: var(--blue-400); }
  .rv-feedback-hint { font-size: 10px; color: var(--th-text-muted); margin: 4px 0 6px; }
  .rv-feedback-btns { display: flex; gap: 6px; }
  .rv-feedback-btns .rv-btn { font-size: 11px; padding: 6px 12px; }
  .rv-fb-submit { background: var(--blue-500); }
  .rv-fb-cancel { background: transparent; border: 1px solid var(--th-text-muted); color: var(--th-text-secondary); }

  /* Bulk selection */
  .rv-card-check {
    position: absolute; top: 8px; left: 8px; z-index: 2;
    width: 20px; height: 20px; accent-color: var(--blue-400); cursor: pointer;
  }
  .rv-card { position: relative; }
  .rv-card.rv-selected { border-color: var(--blue-400); box-shadow: 0 0 0 1px var(--blue-400); }
  .rv-bulk-bar {
    display: none; align-items: center; gap: 10px; flex-wrap: wrap;
    margin-bottom: 12px; padding: 10px 14px;
    background: var(--th-bg-subtle); border: 1px solid var(--th-card-border); border-radius: 8px;
  }
  .rv-bulk-bar.active { display: flex; }
  .rv-bulk-bar label { font-size: 13px; color: var(--th-text-secondary); cursor: pointer; display: flex; align-items: center; gap: 6px; }
  .rv-bulk-bar label input { accent-color: var(--blue-400); cursor: pointer; }
  .rv-bulk-count { font-size: 12px; color: var(--blue-300); font-weight: 700; }
  .rv-bulk-actions { display: flex; gap: 6px; margin-left: auto; }
  .rv-bulk-actions .rv-btn { width: auto; padding: 6px 14px; font-size: 12px; }

  /* Review modal */
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
    line-height: 1;
  }
  .rv-modal-close:hover { background: var(--brand-red); border-color: var(--brand-red); }

  /* Theme toggle */
  .theme-toggle {
    background: none; border: 1px solid var(--th-card-border); border-radius: 10px;
    padding: 8px; cursor: pointer; color: var(--th-text-dim);
    display: inline-flex; align-items: center; justify-content: center;
    transition: color .2s, border-color .2s;
  }
  .theme-toggle:hover { color: var(--th-text); border-color: var(--th-input-border); }
  .theme-toggle svg { width: 16px; height: 16px; }
  [data-theme="dark"] .icon-sun { display: none; }
  [data-theme="dark"] .icon-moon { display: block; }
  [data-theme="light"] .icon-sun { display: block; }
  [data-theme="light"] .icon-moon { display: none; }
</style>
<link rel="stylesheet" href="/assets/dashboard-workspace.css">
</head>
<body class="dashboard-workspace">

<div class="wrap">
${renderSiteNav("dashboard")}
<div class="header">
  <div class="workspace-heading">
    <span class="workspace-eyebrow">EVENT OPERATIONS <span class="workspace-live"><span class="status-dot" id="liveDot" style="background:var(--blue-400)"></span> Live view</span><span id="pausedBadge" class="workspace-paused" style="display:none">Paused</span></span>
    <h1>Dashboard</h1>
    <p>Track the queue, review portraits, and keep delivery moving.</p>
  </div>
  <div class="header-controls">
    <label class="workspace-event-control" for="eventSelect"><span>Event</span><select id="eventSelect" onchange="onEventChange()"><option value="all">All events</option></select></label>
    <button class="hdr-item hdr-action" id="reportBtn" onclick="generateReport()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>Report</button>
    <button class="theme-toggle" onclick="toggleTheme()" aria-label="Toggle light and dark theme" title="Toggle theme">
      <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
      <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
    </button>
  </div>
</div>

<section class="workspace-snapshot" aria-labelledby="snapshotTitle">
  <div class="workspace-section-heading"><div><span class="workspace-kicker">01 / Live snapshot</span><h2 id="snapshotTitle">At a glance</h2></div><span class="workspace-updated">Updated <span id="lastUpdated">--</span></span></div>
<div class="cards">
  <div class="card"><div class="value" id="totalPrints">--</div><div class="label">Total Prints</div></div>
  <div class="card"><div class="value" id="prints24h">--</div><div class="label">Last 24h</div></div>
  <div class="card"><div class="value" id="uniqueUsers">--</div><div class="label">Unique Users</div></div>
  <div class="card"><div class="value" id="avgPerUser">--</div><div class="label">Avg / User</div></div>
  <div class="card"><div class="value" id="inQueue">--</div><div class="label">In Queue</div></div>
</div>
</section>

<div class="review-banner" id="reviewPanel" style="display:none">
  <div class="review-header">
    <span class="review-icon">&#9888;</span>
    <h2>Pending Review <span id="reviewCount" class="review-badge">0</span></h2>
    <a class="review-full-link" href="/review/queue">Open full review queue &rarr;</a>
  </div>
  <div class="qr-review-block" id="qrReviewBlock" style="display:none">
    <div class="qr-review-code" id="qrReviewSvg"></div>
    <div class="qr-review-info">
      <div class="qr-review-title">Scan to review from your phone</div>
      <div class="qr-review-url" id="qrReviewUrl"></div>
      <div class="qr-review-hint">Staff enter the Review PIN to access the queue</div>
    </div>
  </div>
  <div class="qr-review-block qr-review-hint-only" id="qrReviewHint" style="display:none">
    <div class="qr-review-hint">Set a Review PIN in <a href="/review/settings" style="color:var(--blue-300)">Review settings</a> to let staff review from their phones</div>
  </div>
  <div class="rv-bulk-bar" id="rvBulkBar">
    <label title="Select or deselect the visible items"><input type="checkbox" id="rvSelectAll" onchange="toggleSelectAll(this.checked)"> Select shown</label>
    <span class="rv-bulk-count" id="rvBulkCount"></span>
    <div class="rv-bulk-actions">
      <button class="rv-btn rv-btn-approve" onclick="bulkReviewAction('approve')" title="Approve all selected images">Approve Selected</button>
      <button class="rv-btn rv-btn-reject" onclick="bulkReviewAction('reject')" title="Discard all selected images silently — users are not notified">Reject Selected</button>
    </div>
  </div>
  <div id="reviewGrid" class="review-grid"></div>
  <p id="reviewMore" class="review-more" hidden></p>
</div>

<div id="reviewModal" class="rv-modal" onclick="closeReviewModal(event)">
  <div class="rv-modal-content">
    <div class="rv-modal-pane"><span class="rv-modal-label">Original</span><img id="reviewModalOrig" src=""></div>
    <div class="rv-modal-pane"><span class="rv-modal-label" id="reviewModalGenLabel">Generated</span><img id="reviewModalImg" src=""></div>
    <button class="rv-modal-close" onclick="closeReviewModal()">&times;</button>
    <div class="rv-modal-actions" id="reviewModalActions">
      <button class="rv-modal-nav-btn" id="rvModalPrev" onclick="cycleModalVariant(-1)" title="Previous variant" style="display:none">&lsaquo;</button>
      <button class="rv-modal-approve" id="rvModalApprove" onclick="approveFromModal()" title="Approve this image (A or Enter)">Approve</button>
      <button class="rv-modal-nav-btn" id="rvModalNext" onclick="cycleModalVariant(1)" title="Next variant" style="display:none">&rsaquo;</button>
    </div>
  </div>
</div>

<section class="section-group sg-operations workspace-overview" aria-labelledby="overviewTitle">
  <div class="workspace-section-heading"><div><span class="workspace-kicker">02 / Operations</span><h2 id="overviewTitle">Queue &amp; health</h2></div><p>What needs attention right now.</p></div>
  <div class="grid">
    <div class="panel">
      <h2>Queue Status</h2>
      <div id="stuckAlert"></div>
      <div id="printerWarning"></div>
      <div id="queueRows"></div>
      <div style="margin-top:20px; padding-top:16px; border-top:1px solid var(--th-card-border)">
        <h2>Printers</h2>
        <div id="printerList"><span style="color:var(--th-text-muted)">--</span></div>
      </div>
    </div>
    <div class="panel">
      <h2>Job Health</h2>
      <div class="health-grid">
        <div class="health-stat">
          <span class="health-val" style="color:var(--blue-400)" id="healthDone">--</span>
          <span class="health-lbl">Completed</span>
        </div>
        <div class="health-stat">
          <span class="health-val" style="color:var(--brand-red)" id="healthFailed">--</span>
          <span class="health-lbl">Failed</span>
        </div>
        <div class="health-stat">
          <span class="health-val" style="color:var(--blue-400)" id="healthRate">--</span>
          <span class="health-lbl">Success Rate</span>
        </div>
        <div class="health-stat">
          <span class="health-val" style="color:var(--blue-300)" id="healthModRate">--</span>
          <span class="health-lbl">Rejection Rate</span>
        </div>
      </div>
      <div class="health-timing">
        <div class="health-stat">
          <span class="health-val health-val-sm" style="color:var(--blue-500)" id="avgGenTime">--</span>
          <span class="health-lbl">Avg Generation</span>
        </div>
        <div class="health-stat">
          <span class="health-val health-val-sm" style="color:var(--blue-400)" id="avgPrintTime">--</span>
          <span class="health-lbl">Avg Print</span>
        </div>
        <div class="health-stat">
          <span class="health-val health-val-sm" style="color:var(--th-text)" id="avgTotalTime">--</span>
          <span class="health-lbl">Avg Delivery</span>
        </div>
      </div>
    </div>
  </div>
</section>

<div class="workspace-section-heading workspace-view-heading"><div><span class="workspace-kicker">03 / Workspaces</span><h2>Explore the event</h2></div><p>Focused views for the people and work behind each portrait.</p></div>
<div class="workspace-tabs" role="tablist" aria-label="Dashboard views">
  <button id="tabJobs" class="workspace-tab" type="button" role="tab" aria-controls="panelJobs" aria-selected="true" tabindex="0" data-workspace-tab="jobs" onclick="selectWorkspaceTab('jobs')">Jobs</button>
  <button id="tabPeople" class="workspace-tab" type="button" role="tab" aria-controls="panelPeople" aria-selected="false" tabindex="-1" data-workspace-tab="people" onclick="selectWorkspaceTab('people')">People</button>
  <button id="tabInsights" class="workspace-tab" type="button" role="tab" aria-controls="panelInsights" aria-selected="false" tabindex="-1" data-workspace-tab="insights" onclick="selectWorkspaceTab('insights')">Insights</button>
  <button id="tabActivity" class="workspace-tab" type="button" role="tab" aria-controls="panelActivity" aria-selected="false" tabindex="-1" data-workspace-tab="activity" onclick="selectWorkspaceTab('activity')">Activity</button>
</div>

<section class="section-group sg-jobs workspace-tab-panel" id="panelJobs" role="tabpanel" aria-labelledby="tabJobs">
  <div class="panel voice-issues-panel">
    <h2>Voice delivery retries</h2>
    <div id="voiceDeliveryIssues" style="color:var(--th-text-muted);font-size:13px">Checking delivery status...</div>
  </div>
  <div class="panel jobs-panel">
    <div class="workspace-panel-heading">
      <div><h2>Portrait jobs</h2><p>Recent work first. 25 jobs per page.</p></div>
      <div class="jb-tabs" id="jobTabs">
        <button class="jb-tab active" type="button" data-filter="all" aria-pressed="true" onclick="setJobFilter(&apos;all&apos;)">All</button>
        <button class="jb-tab" type="button" data-filter="active" aria-pressed="false" onclick="setJobFilter(&apos;active&apos;)">In progress</button>
        <button class="jb-tab" type="button" data-filter="failed" aria-pressed="false" onclick="setJobFilter(&apos;failed&apos;)">Failed</button>
        <button class="jb-tab" type="button" data-filter="done" aria-pressed="false" onclick="setJobFilter(&apos;done&apos;)">Completed</button>
      </div>
    </div>
    <div id="jobsList" class="workspace-list-viewport" aria-live="off" style="color:var(--th-text-muted);font-size:13px">Loading recent jobs...</div>
    <div class="workspace-list-footer"><span id="jobsRange" role="status" aria-live="polite"></span><button class="btn btn-secondary" id="jobsRefreshLatest" type="button" onclick="refreshLatestJobs()" hidden>Refresh latest</button><nav class="workspace-pagination" aria-label="Jobs pages"><button class="btn btn-secondary" id="jobsPrev" type="button" onclick="changeJobsPage(-1)" disabled>Previous</button><span id="jobsPageLabel">Page 1 of 1</span><button class="btn btn-secondary" id="jobsNext" type="button" onclick="changeJobsPage(1)" disabled>Next</button></nav></div>
  </div>
</section>

<section class="section-group sg-users workspace-tab-panel" id="panelPeople" role="tabpanel" aria-labelledby="tabPeople" hidden>
  <div class="grid">
    <div class="panel" style="grid-column: 1 / -1">
      <div class="workspace-panel-heading"><div><h2>People &amp; usage</h2><p>Guest activity, 25 people per page. Select one event to manage usage.</p></div></div>
      <div id="dashboardUsers" class="workspace-list-viewport" aria-live="off">Open People to load guests.</div>
      <div class="workspace-list-footer"><span id="peopleRange" role="status" aria-live="polite"></span><button class="btn btn-secondary" id="peopleRefreshLatest" type="button" onclick="refreshLatestPeople()" hidden>Refresh latest</button><nav class="workspace-pagination" aria-label="People pages"><button class="btn btn-secondary" id="peoplePrev" type="button" onclick="changePeoplePage(-1)" disabled>Previous</button><span id="peoplePageLabel">Page 1 of 1</span><button class="btn btn-secondary" id="peopleNext" type="button" onclick="changePeoplePage(1)" disabled>Next</button></nav></div>
    </div>
  </div>
</section>

<section class="workspace-tab-panel" id="panelInsights" role="tabpanel" aria-labelledby="tabInsights" hidden>
<div class="section-group sg-failures">
  <div class="workspace-panel-heading"><div><h2>Quality &amp; reach</h2><p>Patterns across completed portraits and exceptions.</p></div></div>
  <div class="grid">
    <div class="panel">
      <h2>Failure Breakdown</h2>
      <div id="failBars"></div>
    </div>
    <div class="panel">
      <h2>User Geography</h2>
      <div id="geoBars"></div>
    </div>
  </div>
</div>

<div class="section-group sg-analytics">
  <div class="workspace-panel-heading"><div><h2>Event trends</h2><p>Styles, activity, and guest feedback.</p></div></div>
  <div class="grid">
    <div class="panel">
      <h2>Style Breakdown</h2>
      <div id="styleBars"></div>
    </div>
    <div class="panel">
      <h2>Hourly Activity (24h)</h2>
      <div class="hourly-bars" id="hourlyBars"></div>
      <div class="hourly-labels" id="hourlyLabels"></div>
    </div>
  </div>
  <div class="panel nps-panel" style="margin-top:14px">
    <h2>NPS Score</h2>
    <div id="npsPanel" class="nps-content">
      <div class="nps-disabled">NPS survey is disabled. Enable it in <a href="/home/settings?section=messaging">Settings &gt; Messaging</a>.</div>
    </div>
  </div>
</div>

<div class="section-group sg-links" id="dubSection" style="display:none">
  <div class="section-label">Share Links</div>
  <div class="grid">
    <div class="panel" style="grid-column:1/-1">
      <h2>Link Analytics</h2>
      <div class="link-summary">
        <div class="link-stat"><span class="link-stat-val" id="dubTotalClicks">--</span><span class="link-stat-lbl">Total Clicks</span><span class="link-stat-desc">Clicks on the short share links sent to users via SMS after their portrait is delivered.</span></div>
        <div class="link-stat"><span class="link-stat-val" id="dubCtr">--</span><span class="link-stat-lbl">Click-Through Rate</span><span class="link-stat-desc">Percentage of delivered portraits where the user clicked their share link. (Total clicks / total prints)</span></div>
      </div>
      <div id="dubTopLinks"></div>
    </div>
  </div>
</div>

<div class="section-group sg-links" id="shareFunnelSection" style="display:none">
  <div class="workspace-panel-heading"><div><h2>Platform sharing</h2><p>What guests do after opening their portrait link.</p></div><label class="workspace-pii-toggle" title="Reveal names, emails, and companies in the recent sharing list"><input type="checkbox" id="showPiiCb" onchange="onPiiToggle()"> Show contact details</label></div>
  <div class="grid">
    <div class="panel" style="grid-column:1/-1">
      <h2>Platform breakdown</h2>
      <div class="link-summary" style="grid-template-columns:repeat(4, 1fr)">
        <div class="link-stat"><span class="link-stat-val" id="sfX">--</span><span class="link-stat-lbl">X / Twitter</span><span class="link-stat-desc">Clicks on the "Share on X" button.</span></div>
        <div class="link-stat"><span class="link-stat-val" id="sfLinkedin">--</span><span class="link-stat-lbl">LinkedIn</span><span class="link-stat-desc">Clicks on the "Share on LinkedIn" button.</span></div>
        <div class="link-stat"><span class="link-stat-val" id="sfInstagram">--</span><span class="link-stat-lbl">Instagram Save</span><span class="link-stat-desc">Clicks on "Save for Instagram" (downloads image for manual sharing).</span></div>
        <div class="link-stat"><span class="link-stat-val" id="sfDownload">--</span><span class="link-stat-lbl">Download</span><span class="link-stat-desc">Clicks on the plain "Download Image" button.</span></div>
      </div>
      <div class="link-summary" style="margin-top:12px">
        <div class="link-stat"><span class="link-stat-val" id="sfShareRate">--</span><span class="link-stat-lbl">Share Rate</span><span class="link-stat-desc">% of share-page visits (dub clicks) that led to a platform share (X / LinkedIn / Instagram).</span></div>
        <div class="link-stat"><span class="link-stat-val" id="sfUniqueSharers">--</span><span class="link-stat-lbl">Unique Sharers</span><span class="link-stat-desc">Distinct users who clicked at least one share button.</span></div>
      </div>
      <div id="sfRecent" style="margin-top:14px"></div>
    </div>
  </div>
</div>
</section>

<section class="section-group sg-audit workspace-tab-panel" id="panelActivity" role="tabpanel" aria-labelledby="tabActivity" hidden>
  <div class="grid">
    <div class="panel" style="grid-column: 1 / -1">
      <div class="workspace-panel-heading"><div><h2>Settings activity</h2><p>Recent changes to this event and its configuration.</p></div></div>
      <div id="auditLog" aria-live="off" style="font-size:13px;color:var(--th-text-muted);max-height:420px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--th-input-border) var(--th-card)">Open Activity to load changes.</div>
      <div style="margin-top:12px;text-align:center">
        <button class="btn btn-secondary" id="auditLoadMore" style="display:none" onclick="loadMoreAudit()">Load More</button>
      </div>
    </div>
  </div>
</section>

<div class="fj-toast" id="fjToast" role="status" aria-live="polite"></div>
<div class="footer">Live data refreshes while this page is visible. Historical lists load in pages.</div>
</div><!-- /.wrap -->

<script>
const STYLE_COLORS = {
  cartoon: "#2188EF", "pop-art": "#19ABF3", watercolor: "#1866EE",
  anime: "#F83D53", sketch: "#94a0b0", "pixel-art": "#2188EF",
};
const QUEUE_META = [
  { key: "pending", label: "Pending", color: "#94a0b0" },
  { key: "generating", label: "Generating", color: "#1866EE" },
  { key: "review", label: "Pending Review", color: "#19ABF3" },
  { key: "ready", label: "Ready to Print", color: "#2188EF" },
  { key: "printing", label: "Printing", color: "#2188EF" },
];

let selectedEvent = "all";
let firstLoad = true;
let showPii = false;
let userActionGen = 0;
let activeWorkspace = "jobs";
const WORKSPACE_VIEWS = ["jobs", "people", "insights", "activity"];

function selectWorkspaceTab(name, options) {
  options = options || {};
  if (!WORKSPACE_VIEWS.includes(name)) return;
  activeWorkspace = name;
  for (var view of WORKSPACE_VIEWS) {
    var tab = document.querySelector('[data-workspace-tab="' + view + '"]');
    var panel = document.getElementById("panel" + view.charAt(0).toUpperCase() + view.slice(1));
    var selected = view === name;
    tab.setAttribute("aria-selected", String(selected));
    tab.setAttribute("tabindex", selected ? "0" : "-1");
    tab.classList.toggle("active", selected);
    panel.hidden = !selected;
  }
  if (options.updateUrl !== false) {
    var url = new URL(window.location.href);
    url.searchParams.set("tab", name);
    window.history.replaceState(null, "", url);
  }
  if (options.refresh !== false) pollDashboard(true);
}

document.querySelector(".workspace-tabs").addEventListener("keydown", function(event) {
  if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  var current = WORKSPACE_VIEWS.indexOf(activeWorkspace);
  var next = event.key === "Home" ? 0 : event.key === "End" ? WORKSPACE_VIEWS.length - 1
    : (current + (event.key === "ArrowRight" ? 1 : -1) + WORKSPACE_VIEWS.length) % WORKSPACE_VIEWS.length;
  var name = WORKSPACE_VIEWS[next];
  selectWorkspaceTab(name);
  document.querySelector('[data-workspace-tab="' + name + '"]').focus();
});

function queryParams() {
  var parts = ["e=" + encodeURIComponent(selectedEvent)];
  if (showPii) parts.push("pii=1");
  return "?" + parts.join("&");
}

function onEventChange() {
  selectedEvent = document.getElementById("eventSelect").value;
  userActionGen++;
  resetDashboardPages();
  pollDashboard(true);
}

function onPiiToggle() {
  showPii = document.getElementById("showPiiCb").checked;
  userActionGen++;
  scheduleDashboardPoll("stats", true);
}

async function fetchStats() {
  var gen = userActionGen;
  try {
    const scope = activeWorkspace === "insights" ? "full" : "overview";
    const r = await fetch("api/stats" + queryParams() + "&scope=" + scope);
    if (!r.ok) throw new Error("Stats unavailable");
    const d = await r.json();
    if (gen !== userActionGen) return;
    render(d);
  } catch (e) {
    console.error("fetchStats error:", e);
    document.getElementById("liveDot").style.background = "#EF223A";
  }
}

function render(d) {
  if (!d) return;
  var wasFirstLoad = firstLoad;
  d.totals = d.totals || { done: 0, failed: 0 };
  d.styleCounts = d.styleCounts || {};
  d.hourlyActivity = d.hourlyActivity || new Array(24).fill(0);
  d.hourlyLabels = d.hourlyLabels || [];
  d.failureBreakdown = d.failureBreakdown || {};
  d.countryCounts = d.countryCounts || [];
  d.topUsers = d.topUsers || [];
  d.queue = d.queue || { pending: 0, generating: 0, review: 0, ready: 0, printing: 0 };
  d.printers = d.printers || [];
  d.stuckJobs = d.stuckJobs || [];
  d.events = d.events || [];
  d.durations = d.durations || {};
  d.nps = d.nps || { count: 0 };

  var _prevPin = _hasReviewPin;
  _hasReviewPin = !!d.hasReviewPin;
  if (_hasReviewPin !== _prevPin && document.getElementById("reviewPanel").style.display !== "none") {
    updateQrBlock();
  }
  document.getElementById("liveDot").style.background = d.queuePaused ? "#19ABF3" : "#2188EF";
  document.getElementById("pausedBadge").style.display = d.queuePaused ? "" : "none";

  // Populate event dropdown (preserve selection). Only rebuild the <options>
  // when the events list actually changed. This also preserves the focused
  // innerHTML swap was (a) wasteful and (b) caused a brief deselect flicker
  // mid-rebuild that could persist if the user was hovering the dropdown.
  const sel = document.getElementById("eventSelect");
  const prev = sel.value;
  const nextSig = "all|" + (d.events || []).join("|");
  if (sel.dataset.sig !== nextSig) {
    sel.innerHTML = '<option value="all">All events</option>';
    if (d.events) {
      for (const e of d.events) {
        sel.innerHTML += '<option value="'+escHtml(e)+'">'+escHtml(e)+'</option>';
      }
    }
    sel.dataset.sig = nextSig;
  }
  // On first load, default to the configured event from settings
  if (firstLoad && d.eventName && d.events && d.events.includes(d.eventName)) {
    sel.value = d.eventName;
    selectedEvent = d.eventName;
    firstLoad = false;
    userActionGen++;
    resetDashboardPages();
    scheduleDashboardPoll("stats", true);
    pollDashboard(false, true);
    return;
  }
  firstLoad = false;
  // Restore previous selection if the user had picked something non-default.
  // (Without this, rebuilding the dropdown on an events-list change would
  // reset to "all".)
  if (prev && prev !== sel.value) sel.value = prev;

  document.getElementById("totalPrints").textContent = d.totals.done;
  document.getElementById("prints24h").textContent = d.prints24h;
  document.getElementById("uniqueUsers").textContent = d.uniqueUsers;
  document.getElementById("avgPerUser").textContent = d.avgPerUser;
  const queueTotal = d.queue.pending + d.queue.generating + d.queue.review + d.queue.ready + d.queue.printing;
  document.getElementById("inQueue").textContent = queueTotal;

  // Stuck job warnings
  const stuckEl = document.getElementById("stuckAlert");
  if (d.stuckJobs && d.stuckJobs.length > 0) {
    const msgs = d.stuckJobs.map(function(s) { return s.stage + " stuck for " + s.stuckFor + "m (" + s.phone + ")"; });
    stuckEl.className = "stuck-alert error";
    stuckEl.textContent = "STUCK: " + msgs.join("; ");
    stuckEl.style.display = "block";
  } else {
    stuckEl.className = "stuck-alert";
    stuckEl.style.display = "none";
  }

  // Queue
  let qhtml = "";
  for (const q of QUEUE_META) {
    qhtml += '<div class="queue-row"><span class="queue-label"><span class="queue-dot" style="background:'+q.color+'"></span>'+q.label+'</span><span class="queue-count">'+d.queue[q.key]+'</span></div>';
  }
  document.getElementById("queueRows").innerHTML = qhtml;

  // Printers
  const printerColors = { ready: "#2188EF", printing: "#1866EE", error: "#EF223A", not_found: "#19ABF3", unknown: "#94a0b0" };
  var disabledSet = new Set(d.disabledPrinters || []);
  window._activePrinterNames = (d.printers || []).map(function(p) { return p.name; }).filter(function(n) { return !disabledSet.has(n); });
  var phtml = "";
  if (d.printers && d.printers.length > 0) {
    for (const p of d.printers) {
      var isDisabled = disabledSet.has(p.name);
      var dotColor = isDisabled ? "#94a0b0" : (printerColors[p.status] || "#94a0b0");
      var label = isDisabled ? "Disabled" : p.message;
      var btnClass = isDisabled ? "ptr-btn ptr-btn-enable" : "ptr-btn ptr-btn-disable";
      var btnLabel = isDisabled ? "Enable" : "Disable";
      phtml += '<div class="printer-status"><span class="printer-dot" style="background:' + dotColor + (isDisabled ? ";opacity:.4" : "") + '"></span><span style="flex:1">' + escHtml(p.name) + ' — ' + escHtml(label) + '</span><button class="' + btnClass + '" onclick="togglePrinter(&apos;' + escHtml(p.name) + '&apos;)">' + btnLabel + '</button></div>';
    }
  } else {
    phtml = '<div class="printer-status"><span class="printer-dot" style="background:#19ABF3"></span><span>No printers active</span></div>';
  }
  document.getElementById("printerList").innerHTML = phtml;

  // Printer warnings
  var pwEl = document.getElementById("printerWarning");
  var noPrinters = !d.printers || d.printers.length === 0;
  var allDisabled = !noPrinters && d.printers.every(function(p) { return disabledSet.has(p.name); });
  var readyCount = d.queue ? d.queue.ready : 0;
  var pwMsg = "";
  if (noPrinters && readyCount > 0 && d.enablePrinting) {
    pwMsg = readyCount + " job" + (readyCount > 1 ? "s" : "") + " waiting but no printers are connected.";
    if (d.immediateDigitalDelivery === false) {
      pwMsg += " Digital delivery is also paused until print — users won't receive their portraits.";
    }
  } else if (allDisabled && readyCount > 0 && d.enablePrinting) {
    pwMsg = readyCount + " job" + (readyCount > 1 ? "s" : "") + " waiting but all printers are disabled.";
    if (d.immediateDigitalDelivery === false) {
      pwMsg += " Digital delivery is also paused until print — users won't receive their portraits.";
    }
  }
  if (pwMsg) {
    pwEl.className = "stuck-alert error";
    pwEl.textContent = pwMsg;
    pwEl.style.display = "block";
  } else {
    pwEl.style.display = "none";
  }

  // Styles
  const styleVals = Object.values(d.styleCounts);
  const maxStyle = styleVals.length > 0 ? Math.max(1, ...styleVals) : 1;
  let shtml = "";
  const sortedStyles = Object.entries(d.styleCounts).sort((a,b) => b[1]-a[1]);
  for (const [name, count] of sortedStyles) {
    const pct = (count / maxStyle * 100).toFixed(1);
    const color = STYLE_COLORS[name] || "#2188EF";
    shtml += '<div class="style-row"><span class="style-name">'+name+'</span><div class="style-bar-bg"><div class="style-bar" style="width:'+pct+'%;background:'+color+'"></div></div><span class="style-count">'+count+'</span></div>';
  }
  document.getElementById("styleBars").innerHTML = shtml;

  // Hourly
  const maxH = d.hourlyActivity.length > 0 ? Math.max(1, ...d.hourlyActivity) : 1;
  let barsHtml = "";
  let labelsHtml = "";
  for (let i = 0; i < d.hourlyActivity.length; i++) {
    const h = d.hourlyActivity[i];
    const hpct = Math.max(2, Math.round(h / maxH * 100));
    const lbl = d.hourlyLabels ? d.hourlyLabels[i] : "";
    const showLabel = (i % 3 === 0) || i === 23;
    barsHtml += '<div class="hourly-bar" style="height:'+hpct+'%"><span class="hourly-tip">'+lbl+': '+h+'</span></div>';
    labelsHtml += '<span class="hourly-label">'+(showLabel ? lbl : "")+'</span>';
  }
  document.getElementById("hourlyBars").innerHTML = barsHtml;
  document.getElementById("hourlyLabels").innerHTML = labelsHtml;

  // Users — fetched on separate interval (see below)

  // Health
  document.getElementById("healthDone").textContent = d.totals.done;
  document.getElementById("healthFailed").textContent = d.totals.failed;
  const total = d.totals.done + d.totals.failed;
  document.getElementById("healthRate").textContent = total > 0 ? (d.totals.done / total * 100).toFixed(0) + "%" : "--";
  document.getElementById("healthModRate").textContent = d.moderationRate || "--";

  // Durations
  if (d.durations) {
    var fmtTime = function(sec) {
      if (sec === null || sec === undefined) return "--";
      if (sec < 60) return sec + "s";
      var m = Math.floor(sec / 60);
      var s = sec % 60;
      return m + "m " + s + "s";
    };
    document.getElementById("avgGenTime").textContent = fmtTime(d.durations.avgGenerationSec);
    document.getElementById("avgPrintTime").textContent = fmtTime(d.durations.avgPrintSec);
    document.getElementById("avgTotalTime").textContent = fmtTime(d.durations.avgTotalSec);
  }

  // Failure breakdown
  const FAIL_META = [
    { key: "moderation", label: "Moderation", color: "#EF223A" },
    { key: "face_detection", label: "Face Detection", color: "#19ABF3" },
    { key: "multi_subject", label: "Multi-Subject", color: "#9AA0B4" },
    { key: "generation", label: "Generation/API", color: "#1866EE" },
    { key: "printer", label: "Printer", color: "#2188EF" },
    { key: "max_retries", label: "Crash Recovery", color: "#94a0b0" },
    { key: "unknown", label: "Unknown", color: "#656E87" },
  ];
  const fb = d.failureBreakdown || {};
  const fbVals = Object.values(fb);
  const maxFail = fbVals.length > 0 ? Math.max(1, ...fbVals) : 1;
  const totalFails = Object.values(fb).reduce((a,b) => a+b, 0);
  let fhtml = "";
  if (totalFails === 0) {
    fhtml = '<div style="color:var(--th-text-muted);font-size:13px">No failures</div>';
  } else {
    for (const fm of FAIL_META) {
      const c = fb[fm.key] || 0;
      if (c === 0) continue;
      const pct = (c / maxFail * 100).toFixed(1);
      fhtml += '<div class="fail-row"><span class="fail-name">'+fm.label+'</span><div class="fail-bar-bg"><div class="fail-bar" style="width:'+pct+'%;background:'+fm.color+'"></div></div><span class="fail-count">'+c+'</span></div>';
    }
  }
  document.getElementById("failBars").innerHTML = fhtml;

  // Geography
  const geo = d.countryCounts || [];
  const maxGeo = geo.length > 0 ? Math.max(1, geo[0].count) : 1;
  let ghtml = "";
  if (geo.length === 0) {
    ghtml = '<div style="color:var(--th-text-muted);font-size:13px">No data yet</div>';
  } else {
    const top10 = geo.slice(0, 10);
    for (const g of top10) {
      const pct = (g.count / maxGeo * 100).toFixed(1);
      ghtml += '<div class="geo-row"><span class="geo-name" title="'+g.country+'">'+g.country+'</span><div class="geo-bar-bg"><div class="geo-bar" style="width:'+pct+'%"></div></div><span class="geo-count">'+g.count+'</span></div>';
    }
  }
  document.getElementById("geoBars").innerHTML = ghtml;

  // NPS
  renderNps(d.nps);

  // Dub.co link analytics
  var dubEl = document.getElementById("dubSection");
  if (d.dubAnalytics && d.dubAnalytics.totalClicks !== undefined) {
    dubEl.style.display = "";
    document.getElementById("dubTotalClicks").textContent = d.dubAnalytics.totalClicks.toLocaleString();
    var ctr = d.totals.done > 0 ? ((d.dubAnalytics.totalClicks / d.totals.done) * 100).toFixed(1) + "%" : "--";
    document.getElementById("dubCtr").textContent = ctr;
    var links = d.dubAnalytics.topLinks || [];
    var maxLink = links.length > 0 ? Math.max(1, links[0].clicks) : 1;
    var lhtml = "";
    if (links.length > 0) {
      for (var li = 0; li < links.length; li++) {
        var lk = links[li];
        var lpct = (lk.clicks / maxLink * 100).toFixed(1);
        var label = lk.shortLink.replace(/^https?:\\\/\\\//, "");
        lhtml += '<div class="link-row"><span class="link-name" title="' + escHtml(lk.url || "") + '">' + escHtml(label) + '</span><div class="link-bar-bg"><div class="link-bar" style="width:' + lpct + '%"></div></div><span class="link-count">' + lk.clicks + '</span></div>';
      }
    }
    document.getElementById("dubTopLinks").innerHTML = lhtml;
  } else {
    dubEl.style.display = "none";
  }

  // Share platform funnel
  renderShareFunnel(d);

  // Last updated timestamp
  var now = new Date();
  document.getElementById("lastUpdated").textContent = now.toLocaleTimeString();
  if (wasFirstLoad) pollDashboard(false, true);
}

function renderShareFunnel(d) {
  var sfEl = document.getElementById("shareFunnelSection");
  if (!d.shareClicks || !d.shareClicks.totalEvents) {
    sfEl.style.display = "none";
    return;
  }
  sfEl.style.display = "";
  var bp = d.shareClicks.byPlatform || {};
  document.getElementById("sfX").textContent = (bp.x || 0).toLocaleString();
  document.getElementById("sfLinkedin").textContent = (bp.linkedin || 0).toLocaleString();
  document.getElementById("sfInstagram").textContent = (bp.instagram || 0).toLocaleString();
  document.getElementById("sfDownload").textContent = (bp.download || 0).toLocaleString();

  var dubClicks = (d.dubAnalytics && d.dubAnalytics.totalClicks) || 0;
  document.getElementById("sfShareRate").textContent = dubClicks > 0
    ? ((d.shareClicks.totalShares / dubClicks) * 100).toFixed(1) + "%"
    : "--";
  document.getElementById("sfUniqueSharers").textContent = (d.shareClicks.uniqueSharers || 0).toLocaleString();

  // Build recent list with safe DOM APIs (textContent only — no HTML injection).
  var recentEl = document.getElementById("sfRecent");
  while (recentEl.firstChild) recentEl.removeChild(recentEl.firstChild);
  var recent = d.shareClicks.recent || [];
  if (recent.length === 0) return;

  var showPII = !!d.showSharePII;

  var header = document.createElement("div");
  header.style.cssText = "font-size:12px;color:var(--th-text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-family:'Twilio Sans Mono',monospace";
  header.textContent = "Recent Shares";
  recentEl.appendChild(header);

  var list = document.createElement("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:4px;max-height:280px;overflow-y:auto";
  for (var ri = 0; ri < recent.length; ri++) {
    var r = recent[ri];
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:10px;font-size:13px;padding:6px 8px;border-radius:6px;background:var(--th-bg)";

    var pl = document.createElement("span");
    pl.style.cssText = "font-family:'Twilio Sans Mono',monospace;color:var(--blue-200);min-width:70px";
    pl.textContent = String(r.platform || "").toUpperCase();

    var when = document.createElement("span");
    when.style.cssText = "color:var(--th-text-muted);min-width:150px";
    when.textContent = new Date(r.ts).toLocaleString();

    var who = document.createElement("span");
    who.style.color = "var(--th-text)";
    if (showPII) {
      var parts = [];
      var nm = [r.firstName, r.lastName].filter(Boolean).join(" ");
      parts.push(nm || "(anonymous)");
      if (r.email) parts.push(r.email);
      if (r.company) parts.push(r.company);
      who.textContent = parts.join(" · ");
    } else {
      who.textContent = "Contact details hidden";
    }

    row.appendChild(pl);
    row.appendChild(when);
    row.appendChild(who);
    list.appendChild(row);
  }
  recentEl.appendChild(list);
}


function generateReport() {
  const btn = document.getElementById("reportBtn");
  btn.textContent = "Generating...";
  btn.disabled = true;
  const url = "api/report" + queryParams();
  // Open in new tab so browser handles the PDF download
  const w = window.open(url, "_blank");
  // Restore button after a short delay (PDF streams immediately, but AI summary may take a moment)
  setTimeout(function() { btn.textContent = "Generate Report"; btn.disabled = false; }, 4000);
}

// ── User Management ──
var _duGen = 0;
var PEOPLE_PAGE_SIZE = 25;
var _peopleRows = [];
var _peopleTotal = 0;
var _peoplePage = 0;
var _peopleLoading = false;
var _peopleController = null;
var _peopleBrowsingHistory = false;
var _peopleRenderSignature = "";

function updatePeoplePagination() {
  var pageCount = Math.max(1, Math.ceil(_peopleTotal / PEOPLE_PAGE_SIZE));
  document.getElementById("peoplePageLabel").textContent = "Page " + (_peoplePage + 1) + " of " + pageCount;
  document.getElementById("peoplePrev").disabled = _peopleLoading || _peoplePage === 0;
  document.getElementById("peopleNext").disabled = _peopleLoading || _peoplePage + 1 >= pageCount;
  document.getElementById("peopleRefreshLatest").hidden = _peoplePage === 0;
}

async function fetchDashboardUsers(options) {
  options = options || {};
  var page = Number.isInteger(options.page) ? Math.max(0, options.page) : _peoplePage;
  var event = selectedEvent;
  var offset = page * PEOPLE_PAGE_SIZE;
  // Keep the live poller from replacing a page the operator just requested.
  if (options.manual) _peopleBrowsingHistory = true;
  if (_peopleController) _peopleController.abort();
  var controller = new AbortController();
  _peopleController = controller;
  _peopleLoading = true;
  updatePeoplePagination();
  document.getElementById("dashboardUsers").setAttribute("aria-busy", "true");
  var gen = ++_duGen;
  try {
    var ep = "api/dashboard-users?e=" + encodeURIComponent(event) + "&offset=" + offset + "&limit=" + PEOPLE_PAGE_SIZE;
    var r = await fetch(ep, { signal: controller.signal });
    if (!r.ok) throw new Error("People unavailable");
    var d = await r.json();
    if (gen !== _duGen || event !== selectedEvent) return;
    var rows = Array.isArray(d.users) ? d.users : [];
    var total = Number.isFinite(Number(d.total)) ? Math.max(0, Number(d.total)) : rows.length;
    var lastPage = Math.max(0, Math.ceil(total / PEOPLE_PAGE_SIZE) - 1);
    if (page > lastPage) {
      return await fetchDashboardUsers({ page: lastPage });
    }
    _peopleRows = rows;
    _peopleTotal = total;
    _peoplePage = page;
    _peopleBrowsingHistory = page > 0;
    renderDashboardUsers();
  } catch(e) {
    if (e.name !== "AbortError") {
      if (!_peopleRows.length) document.getElementById("dashboardUsers").textContent = "Could not load people. It will retry shortly.";
      else showToast("Could not load people. Try again.");
    }
  } finally {
    if (_peopleController === controller) {
      _peopleController = null;
      _peopleLoading = false;
      _peopleBrowsingHistory = _peoplePage > 0;
      document.getElementById("dashboardUsers").removeAttribute("aria-busy");
      updatePeoplePagination();
    }
  }
}

function changePeoplePage(direction) {
  if (_peopleLoading) return;
  var next = _peoplePage + direction;
  if (next < 0 || next >= Math.max(1, Math.ceil(_peopleTotal / PEOPLE_PAGE_SIZE))) return;
  return fetchDashboardUsers({ page: next, manual: true });
}

function refreshLatestPeople() {
  return fetchDashboardUsers({ page: 0, manual: true });
}

function renderDashboardUsers() {
  var el = document.getElementById("dashboardUsers");
  var users = _peopleRows;
  var range = document.getElementById("peopleRange");
  var start = _peoplePage * PEOPLE_PAGE_SIZE + 1;
  var rangeText = (users.length ? "Showing " + start.toLocaleString() + "–" + (start + users.length - 1).toLocaleString()
    + " of " + _peopleTotal.toLocaleString() + " people" : "0 people")
    + (_peopleBrowsingHistory ? " · live refresh paused while browsing older rows" : "");
  if (range.textContent !== rangeText) range.textContent = rangeText;
  updatePeoplePagination();
  if (!users.length) {
    el.innerHTML = '<div class="workspace-empty">No people yet for this event.</div>';
    _peopleRenderSignature = "";
    return;
  }
  var signature = JSON.stringify([selectedEvent, _peoplePage, users]);
  if (signature === _peopleRenderSignature) return;
  var oldList = el.querySelector(".people-list");
  var scrollTop = oldList && oldList.dataset.page === String(_peoplePage) ? oldList.scrollTop : 0;
  var openUsers = new Set(Array.from(el.querySelectorAll(".user-row .du-manage[open]"), function(details) {
    return details.closest(".user-row").dataset.userId;
  }));
  var focused = document.activeElement;
  var focusedRow = focused && el.contains(focused) ? focused.closest(".user-row") : null;
  var focusedUserId = focusedRow ? focusedRow.dataset.userId : null;
  var focusedAction = focusedRow && focused ? Array.from(focusedRow.querySelectorAll("summary,button")).indexOf(focused) : -1;
  var html = '<div class="people-list" data-page="' + _peoplePage + '" tabindex="0" role="region" aria-label="People"><div class="people-list-head"><span>Guest</span><span>Status</span><span>Usage</span><span>Actions</span></div>';
  for (var i = 0; i < users.length; i++) {
    var u = users[i];
    var badges = "";
    if (u.isAdmin) badges += '<span class="du-badge du-badge-admin">Admin</span>';
    if (u.leadCompleted) badges += '<span class="du-badge du-badge-lead">Lead</span>';
    var countText = u.isAdmin ? u.count + " (unlimited)" : u.count + " / " + u.maxPrints;
    html += '<div class="user-row" data-user-id="' + Number(u.id) + '">'
      + '<span class="people-guest"><span class="user-name">' + (u.name ? escHtml(u.name) : 'Guest') + '</span><span class="user-phone">' + escHtml(u.phone) + '</span></span>'
      + '<span class="du-badges">' + badges + '</span>'
      + '<span class="user-count">' + countText + '</span>'
      + '<span class="du-actions">' + (selectedEvent === "all" ? '<span class="workspace-muted">Select an event</span>'
        : '<details class="du-manage"><summary>Manage</summary><div class="du-menu">'
        + '<button type="button" onclick="resetUserUsage('+u.id+')">Reset portrait count</button>'
        + '<button type="button" onclick="resetUserSurvey('+u.id+')">Reset survey</button>'
        + '<button type="button" onclick="toggleUserAdmin('+u.id+')">' + (u.isAdmin ? 'Remove admin' : 'Make admin') + '</button>'
        + '</div></details>') + '</span>'
      + '</div>';
  }
  el.innerHTML = html + '</div>';
  _peopleRenderSignature = signature;
  var newList = el.querySelector(".people-list");
  if (newList && scrollTop) newList.scrollTop = scrollTop;
  for (var row of el.querySelectorAll(".user-row")) {
    if (openUsers.has(row.dataset.userId) && row.querySelector("details")) row.querySelector("details").open = true;
    if (row.dataset.userId === focusedUserId && focusedAction >= 0) {
      var nextFocus = row.querySelectorAll("summary,button")[focusedAction];
      if (nextFocus) nextFocus.focus();
    }
  }
}

async function resetUserUsage(id) {
  if (selectedEvent === "all") { showToast("Select a specific event to reset portraits"); return; }
  var ev = selectedEvent;
  var ok = await twModal.confirm({
    title: "Reset portrait count?",
    message: "Reset this user's portrait count to 0 for " + ev + "?",
    confirmText: "Reset",
    danger: true,
  });
  if (!ok) return;
  fetch("api/dashboard-users/reset-usage", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id: id, event: ev }) })
    .then(function(r) { return r.json(); })
    .then(function(d) { if (d.ok) { showToast("Portrait count reset"); refreshLatestPeople(); fetchStats(); } else { showToast("Error: " + (d.error || "unknown")); } })
    .catch(function() { showToast("Failed to reset portraits"); });
}

async function resetUserSurvey(id) {
  if (selectedEvent === "all") { showToast("Select a specific event to reset survey"); return; }
  var ev = selectedEvent;
  var ok = await twModal.confirm({
    title: "Clear lead capture survey?",
    message: "Clear lead capture survey for this user on " + ev + "? They will be asked to fill it out again.",
    confirmText: "Clear",
    danger: true,
  });
  if (!ok) return;
  fetch("api/dashboard-users/reset-survey", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id: id, event: ev }) })
    .then(function(r) { return r.json(); })
    .then(function(d) { if (d.ok) { showToast("Survey reset"); refreshLatestPeople(); } else { showToast("Error: " + (d.error || "unknown")); } })
    .catch(function() { showToast("Failed to reset survey"); });
}

function toggleUserAdmin(id) {
  var ev = selectedEvent !== "all" ? selectedEvent : null;
  fetch("api/dashboard-users/toggle-admin", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ id: id, event: ev }) })
    .then(function(r) { return r.json(); })
    .then(function(d) { if (d.ok) { showToast(d.isAdmin ? "Admin added" : "Admin removed"); refreshLatestPeople(); fetchStats(); } else { showToast("Error: " + (d.error || "unknown")); } })
    .catch(function() { showToast("Failed to toggle admin"); });
}

// ── Combined Jobs Panel ──
var _jobFilter = "all";
var JOB_PAGE_SIZE = 25;
var _jobItems = [];
var _jobTotal = 0;
var _jobPage = 0;
var _jobTotals = { active: 0, failed: 0, done: 0 };
var _jobController = null;
var _jobGen = 0;
var _jobLoading = false;
var _jobBrowsingHistory = false;
var _voiceController = null;
var _jobsRenderSignature = "";

function resetDashboardPages() {
  _jobGen++;
  _duGen++;
  if (_jobController) _jobController.abort();
  if (_peopleController) _peopleController.abort();
  if (_voiceController) _voiceController.abort();
  _jobController = null;
  _peopleController = null;
  _voiceController = null;
  _jobItems = []; _jobTotal = 0; _jobPage = 0; _jobLoading = false;
  _jobTotals = { active: 0, failed: 0, done: 0 };
  _jobBrowsingHistory = false;
  _jobsRenderSignature = "";
  _peopleRows = []; _peopleTotal = 0; _peoplePage = 0; _peopleLoading = false; _peopleBrowsingHistory = false;
  _peopleRenderSignature = "";
  document.getElementById("jobsList").textContent = "Loading recent jobs...";
  document.getElementById("dashboardUsers").textContent = "Loading people...";
  document.getElementById("jobsRange").textContent = "";
  document.getElementById("peopleRange").textContent = "";
  document.getElementById("jobsList").removeAttribute("aria-busy");
  document.getElementById("dashboardUsers").removeAttribute("aria-busy");
  updateJobsPagination();
  updatePeoplePagination();
  var voicePanel = document.querySelector(".voice-issues-panel");
  voicePanel.hidden = false;
  document.getElementById("voiceDeliveryIssues").textContent = "Checking delivery status...";
}

function timeAgo(ts) {
  if (!ts) return "";
  var s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s/60) + "m ago";
  if (s < 86400) return Math.floor(s/3600) + "h ago";
  return Math.floor(s/86400) + "d ago";
}

function renderNps(npsData) {
  var el = document.getElementById("npsPanel");
  if (!npsData || npsData.count === 0) {
    el.innerHTML = '<div class="nps-disabled">No NPS responses yet.</div>';
    return;
  }
  var avg = npsData.average;
  var cls = avg >= 4 ? "nps-score-good" : avg >= 3 ? "nps-score-ok" : "nps-score-bad";
  var maxCount = Math.max(1, Math.max(npsData.distribution[1]||0, npsData.distribution[2]||0, npsData.distribution[3]||0, npsData.distribution[4]||0, npsData.distribution[5]||0));
  var colors = { 1: "#EF223A", 2: "#F83D53", 3: "#19ABF3", 4: "#2188EF", 5: "#1866EE" };
  var h = '<div class="nps-big"><span class="nps-score '+cls+'">'+avg+'</span><span class="nps-count">'+npsData.count+' responses</span></div>';
  h += '<div class="nps-bars">';
  for (var i = 5; i >= 1; i--) {
    var c = npsData.distribution[i] || 0;
    var pct = Math.round((c / maxCount) * 100);
    h += '<div class="nps-bar-row"><span class="nps-bar-label">'+i+'</span><div class="nps-bar-track"><div class="nps-bar-fill" style="width:'+pct+'%;background:'+colors[i]+'"></div></div><span class="nps-bar-val">'+c+'</span></div>';
  }
  h += '</div>';
  el.innerHTML = h;
}

function failDetail(j) {
  switch (j.failReason) {
    case "moderation":
      return "Image was flagged by content moderation and blocked automatically.";
    case "face_detection":
      return "No face was detected in the photo. The user may have sent a non-selfie image.";
    case "multi_subject":
      return "Detected " + (j.detectedSubjects || "multiple") + " people in the photo. This event only allows 1 person per photo.";
    case "ai_review_rejected":
      return j.aiReviewResult ? escHtml(j.aiReviewResult.replace(/^FAIL:\s*/i, "AI flagged: ")) : "AI quality review rejected this image.";
    case "review_rejected":
      return "Rejected by a human reviewer during manual review.";
    case "content_rejected":
      return "Content was permanently rejected during generation.";
    case "generation":
      return "Image generation failed after " + (j.retries || "max") + " retries.";
    case "printer":
      return "Print failed after " + (j.retries || "max") + " retries.";
    case "max_retries":
      return "Exceeded maximum retry attempts.";
    default:
      return "";
  }
}

function printerDropdown(id, defaultLabel) {
  var printers = window._activePrinterNames || [];
  var h = '<select id="' + id + '" class="fj-printer-select">';
  h += '<option value="">' + escHtml(defaultLabel || "Any printer") + '</option>';
  for (var p of printers) h += '<option value="' + escHtml(p) + '">' + escHtml(p) + '</option>';
  h += '</select>';
  return h;
}

function setJobFilter(f) {
  if (!["all", "active", "failed", "done"].includes(f)) return;
  _jobFilter = f;
  var tabs = document.querySelectorAll(".jb-tab");
  for (var t of tabs) {
    var active = t.getAttribute("data-filter") === f;
    t.classList.toggle("active", active);
    t.setAttribute("aria-pressed", String(active));
  }
  _jobPage = 0;
  _jobTotal = 0;
  _jobItems = [];
  _jobBrowsingHistory = false;
  _jobsRenderSignature = "";
  document.getElementById("jobsList").textContent = "Loading jobs...";
  document.getElementById("jobsRange").textContent = "";
  return fetchJobs({ page: 0 });
}

function updateJobsPagination() {
  var pageCount = Math.max(1, Math.ceil(_jobTotal / JOB_PAGE_SIZE));
  document.getElementById("jobsPageLabel").textContent = "Page " + (_jobPage + 1) + " of " + pageCount;
  document.getElementById("jobsPrev").disabled = _jobLoading || _jobPage === 0;
  document.getElementById("jobsNext").disabled = _jobLoading || _jobPage + 1 >= pageCount;
  document.getElementById("jobsRefreshLatest").hidden = _jobPage === 0;
}

async function fetchJobs(options) {
  options = options || {};
  var page = Number.isInteger(options.page) ? Math.max(0, options.page) : _jobPage;
  var event = selectedEvent;
  var filter = _jobFilter;
  // Pause live polling until a manual page change finishes, including page one.
  if (options.manual) _jobBrowsingHistory = true;
  if (_jobController) _jobController.abort();
  var controller = new AbortController();
  _jobController = controller;
  _jobLoading = true;
  updateJobsPagination();
  document.getElementById("jobsList").setAttribute("aria-busy", "true");
  var gen = ++_jobGen;
  try {
    var url = "api/jobs?e=" + encodeURIComponent(event) + "&filter=" + encodeURIComponent(filter)
      + "&offset=" + (page * JOB_PAGE_SIZE) + "&limit=" + JOB_PAGE_SIZE;
    var response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("Jobs unavailable");
    var data = await response.json();
    if (gen !== _jobGen || event !== selectedEvent || filter !== _jobFilter) return;
    if (!Array.isArray(data.jobs)) throw new Error("Invalid jobs response");
    var total = Number.isFinite(Number(data.total)) ? Math.max(0, Number(data.total)) : data.jobs.length;
    var lastPage = Math.max(0, Math.ceil(total / JOB_PAGE_SIZE) - 1);
    if (page > lastPage) {
      return await fetchJobs({ page: lastPage });
    }
    _jobItems = data.jobs;
    _jobTotal = total;
    _jobTotals = data.counts || { active: 0, failed: 0, done: 0 };
    _jobPage = page;
    _jobBrowsingHistory = page > 0;
    renderJobs();
  } catch(e) {
    if (e.name !== "AbortError") {
      if (!_jobItems.length) document.getElementById("jobsList").textContent = "Could not load jobs. It will retry shortly.";
      else showToast("Could not load jobs. Try again.");
    }
  } finally {
    if (_jobController === controller) {
      _jobController = null;
      _jobLoading = false;
      _jobBrowsingHistory = _jobPage > 0;
      document.getElementById("jobsList").removeAttribute("aria-busy");
      updateJobsPagination();
    }
  }
}

function changeJobsPage(direction) {
  if (_jobLoading) return;
  var next = _jobPage + direction;
  if (next < 0 || next >= Math.max(1, Math.ceil(_jobTotal / JOB_PAGE_SIZE))) return;
  return fetchJobs({ page: next, manual: true });
}

function refreshLatestJobs() {
  return fetchJobs({ page: 0, manual: true });
}

async function fetchVoiceIssues() {
  var event = selectedEvent;
  if (_voiceController) _voiceController.abort();
  var controller = new AbortController();
  _voiceController = controller;
  try {
    var response = await fetch("api/voice-deliveries?e=" + encodeURIComponent(event), { signal: controller.signal });
    if (!response.ok) throw new Error("Voice status unavailable");
    var issues = await response.json();
    if (event === selectedEvent) renderVoiceDeliveryIssues(issues);
  } catch(e) {
    if (e.name !== "AbortError") document.getElementById("voiceDeliveryIssues").textContent = "Delivery status is temporarily unavailable.";
  } finally {
    if (_voiceController === controller) _voiceController = null;
  }
}

function renderVoiceDeliveryIssues(items) {
  var el = document.getElementById("voiceDeliveryIssues");
  if (!el) return;
  var panel = el.closest(".voice-issues-panel");
  if (!Array.isArray(items) || !items.length) { panel.hidden = true; el.textContent = "No pending Voice sends"; return; }
  panel.hidden = false;
  var h = "";
  for (var j of items) {
    h += '<div class="voice-issue-row"><div><strong>'+escHtml(j.kind === "failure" ? "Failure notice" : "Portrait delivery")+'</strong>';
    h += '<span class="voice-issue-meta">'+escHtml(j.filename)+' · attempt '+Number(j.attempts || 0)+'</span>';
    if (j.uncertainAt) h += '<span class="voice-issue-warning" title="The previous send may have reached Twilio before its SID was saved">Send status uncertain</span>';
    if (j.lastError) h += '<span class="voice-issue-error">'+escHtml(j.lastError)+'</span>';
    h += '</div><button class="jb-btn" onclick="retryVoiceSend(&apos;'+escHtml(j.filename)+'&apos;)">Retry send</button></div>';
  }
  el.innerHTML = h;
}

async function retryVoiceSend(filename) {
  try {
    var r = await fetch("api/voice-deliveries/retry", { method: "POST",
      headers: {"Content-Type":"application/json"}, body: JSON.stringify({filename: filename}) });
    var d = await r.json();
    showToast(d.ok ? (d.state === "sent" ? "Voice portrait sent" : "Voice send queued for retry") : (d.error || "Retry failed"));
    fetchVoiceIssues();
  } catch(e) { showToast("Retry failed"); }
}

function renderJobs() {
  var el = document.getElementById("jobsList");
  var filtered = _jobItems;
  // Counts describe all matching jobs, while the browser keeps only one page.
  var activeCount = Number(_jobTotals.active) || 0;
  var failCount = Number(_jobTotals.failed) || 0;
  var doneCount = Number(_jobTotals.done) || 0;
  var tabs = document.querySelectorAll(".jb-tab");
  for (var t of tabs) {
    var f = t.getAttribute("data-filter");
    if (f === "all") t.textContent = "All (" + (activeCount + failCount + doneCount).toLocaleString() + ")";
    else if (f === "active") t.textContent = "In progress (" + activeCount.toLocaleString() + ")";
    else if (f === "failed") t.textContent = "Failed (" + failCount + ")";
    else if (f === "done") t.textContent = "Completed (" + doneCount.toLocaleString() + ")";
  }
  var jobsRange = document.getElementById("jobsRange");
  var start = _jobPage * JOB_PAGE_SIZE + 1;
  var rangeText = (filtered.length ? "Showing " + start.toLocaleString() + "–" + (start + filtered.length - 1).toLocaleString()
    + " of " + _jobTotal.toLocaleString() + " jobs" : "0 jobs")
    + (_jobBrowsingHistory ? " · live refresh paused while browsing older rows" : "");
  if (jobsRange.textContent !== rangeText) jobsRange.textContent = rangeText;
  updateJobsPagination();

  if (!filtered.length) {
    var msg = _jobFilter === "active" ? "No jobs in progress" : _jobFilter === "failed" ? "No failed jobs" : _jobFilter === "done" ? "No completed jobs" : "No jobs";
    el.innerHTML = '<div class="jb-empty">' + msg + '</div>';
    _jobsRenderSignature = "";
    return;
  }
  // Polls often return the same rows. Keep the existing DOM so a focused
  // action button or selected printer does not reset every eight seconds.
  var signature = JSON.stringify([_jobFilter, _jobPage, filtered]);
  if (signature === _jobsRenderSignature) {
    el.querySelectorAll(".jb-time").forEach(function(node, index) { node.textContent = timeAgo(filtered[index].ts); });
    return;
  }
  var oldList = el.querySelector(".jb-list");
  var scrollTop = oldList && oldList.dataset.page === String(_jobPage)
    && oldList.dataset.filter === _jobFilter ? oldList.scrollTop : 0;
  var selectedPrinters = new Map(Array.from(el.querySelectorAll(".fj-printer-select"), function(sel) { return [sel.id, sel.value]; }));
  var focused = document.activeElement;
  var focusedRow = focused && el.contains(focused) ? focused.closest(".jb-row") : null;
  var focusedRowId = focusedRow ? focusedRow.id : null;
  var focusedAction = focusedRow && focused ? Array.from(focusedRow.querySelectorAll("button,select")).indexOf(focused) : -1;
  // Sticky column header sits inside .jb-list so it stays pinned to the top
  // as rows scroll beneath it. Grid template matches data rows exactly so
  // every header cell lines up with its column.
  var h = '<div class="jb-list" data-page="' + _jobPage + '" data-filter="' + _jobFilter + '" tabindex="0" role="region" aria-label="Portrait jobs">';
  h += '<div class="jb-header jb-grid-cols">'
    + '<span></span>'
    + '<span>Phone</span>'
    + '<span>Name</span>'
    + '<span>Style</span>'
    + '<span>Status</span>'
    + '<span>Printer</span>'
    + '<span class="jb-time-head">Time</span>'
    + '<span class="jb-action-head">Action</span>'
    + '</div>';
  for (var item of filtered) {
    var j = item.data;
    if (item.type === "active") {
      h += renderActiveRow(j);
    } else if (item.type === "failed") {
      h += renderFailedRow(j);
    } else {
      h += renderDoneRow(j);
    }
  }
  h += '</div>';
  el.innerHTML = h;
  _jobsRenderSignature = signature;
  var newList = el.querySelector(".jb-list");
  if (newList && scrollTop) newList.scrollTop = scrollTop;
  for (var sel of el.querySelectorAll(".fj-printer-select")) {
    var previous = selectedPrinters.get(sel.id);
    if (previous && Array.from(sel.options).some(function(option) { return option.value === previous; })) sel.value = previous;
  }
  if (focusedRowId && focusedAction >= 0) {
    var newRow = document.getElementById(focusedRowId);
    var nextFocus = newRow && newRow.querySelectorAll("button,select")[focusedAction];
    if (nextFocus) nextFocus.focus();
  }
}

function renderActiveRow(j) {
  // In-flight job (ready or printing). No Reprint/Retry action — it isn't
  // terminal yet — but we DO surface a hint when a ready job has already been
  // rejected by one or more printers, since that's the signature of a job
  // bouncing in the queue (e.g. its output image is missing, or every printer
  // is offline). The thumbnail uses the MMS-sized jpg like the Done rows.
  var statusLabel = j.status === "printing" ? "Printing…" : "Ready to print";
  var statusCls = j.status === "printing" ? "printing" : "ready";
  var h = '<div class="jb-row jb-grid-cols" id="jb-'+escHtml(j.filename)+'">';
  if (j.filePrefix && j.eventName) {
    var thumbUrl = "/photogallery/img/" + encodeURIComponent(j.eventName) + "/" + encodeURIComponent(j.filePrefix) + "_output.png";
    h += '<a class="jb-thumb-link" href="'+thumbUrl+'" target="_blank" rel="noopener" title="Portrait"><img class="jb-thumb" src="'+thumbUrl+'" loading="lazy" alt="" onerror="this.style.display=&apos;none&apos;"></a>';
  } else {
    h += '<span class="jb-thumb-empty"></span>';
  }
  h += '<span class="jb-phone">'+escHtml(j.phone || "")+'</span>';
  h += '<span class="jb-name">'+(j.name ? escHtml(j.name) : '')+'</span>';
  h += '<span class="jb-style">'+escHtml(j.style)+'</span>';
  h += '<span class="jb-status '+statusCls+'">'+statusLabel+'</span>';
  h += '<span class="jb-printer">'+(j.printerName ? escHtml(j.printerName) : '')+'</span>';
  h += '<span class="jb-time">'+timeAgo(j.enteredAt)+'</span>';
  h += '<span class="jb-action">';
  if (j.status === "ready") {
    // A ready job that's been rejected by a printer (or targeted at one that's
    // offline) can sit unclaimed. "Release" clears the printer history/target
    // so any connected printer picks it up on its next poll — the operator
    // doesn't have to uncheck printers in the relay app. Shown with the bounce
    // hint when there's failure history so the cause is visible.
    if (j.failedPrinters && j.failedPrinters.length) {
      h += '<span class="jb-bounce" title="Rejected by: '+escHtml(j.failedPrinters.join(", "))+'">retry '+(j.retries||0)+'</span>';
    }
    h += '<button class="jb-btn" onclick="releaseReadyJob(&apos;'+escHtml(j.filename)+'&apos;)" title="Clear printer history so any connected printer prints this">Release</button>';
  }
  h += '</span>';
  h += '</div>';
  return h;
}

function renderFailedRow(j) {
  var detail = failDetail(j);
  var isPrinterFail = j.failReason === "printer" || j.failReason === "relay_stale" || j.failReason === "max_retries";
  var rowCls = "jb-row jb-grid-cols" + (detail ? " has-detail" : "");
  var h = '<div class="'+rowCls+'" id="jb-'+escHtml(j.filename)+'">';
  if (j.hasInputThumb && j.filePrefix && j.eventName) {
    var thumbUrl = "/photogallery/img/" + encodeURIComponent(j.eventName) + "/" + encodeURIComponent(j.filePrefix) + "_input.jpg";
    h += '<a class="jb-thumb-link" href="'+thumbUrl+'" target="_blank" rel="noopener" title="Original selfie"><img class="jb-thumb" src="'+thumbUrl+'" loading="lazy" alt=""></a>';
  } else {
    h += '<span class="jb-thumb-empty"></span>';
  }
  h += '<span class="jb-phone">'+escHtml(j.phone)+'</span>';
  h += '<span class="jb-name">'+(j.name ? escHtml(j.name) : '')+'</span>';
  h += '<span class="jb-style">'+escHtml(j.style)+'</span>';
  h += '<span class="jb-status '+escHtml(j.failReason)+'">'+escHtml(j.failReason).replace(/_/g," ")+'</span>';
  h += '<span class="jb-printer">'+(j.printerName ? escHtml(j.printerName) : '')+'</span>';
  h += '<span class="jb-time">'+timeAgo(j.createdAt)+'</span>';
  h += '<span class="jb-action">';
  if (j.canReprint) {
    // Output image still exists — offer a direct Reprint (re-queue straight to
    // the print queue, no re-generation). Broader than the old printer-fail-
    // only gate: any non-moderation failure whose image survived can reprint.
    h += printerDropdown("jb-ptr-"+escHtml(j.filename), "Any printer");
    h += '<button class="jb-btn" onclick="retryJob(&apos;'+escHtml(j.filename)+'&apos;,true)" title="Print the existing portrait again — no re-generation, user is not notified">Reprint</button>';
  } else if (j.canRetry) {
    h += '<button class="jb-btn" onclick="retryJob(&apos;'+escHtml(j.filename)+'&apos;,false)" title="Re-queue this job for fresh generation — the user is not notified">Retry</button>';
  } else {
    h += '<button class="jb-btn" disabled title="Cannot retry moderation failures">Retry</button>';
  }
  h += '</span>';
  if (detail) h += '<div class="jb-detail">'+detail+'</div>';
  h += '</div>';
  return h;
}

function renderDoneRow(j) {
  var h = '<div class="jb-row jb-grid-cols" id="jb-'+escHtml(j.filename)+'">';
  if (j.hasOutputThumb && j.filePrefix && j.eventName) {
    var thumbUrl = "/photogallery/img/" + encodeURIComponent(j.eventName) + "/" + encodeURIComponent(j.filePrefix) + "_output.png";
    h += '<a class="jb-thumb-link" href="'+thumbUrl+'" target="_blank" rel="noopener" title="Portrait"><img class="jb-thumb" src="'+thumbUrl+'" loading="lazy" alt=""></a>';
  } else {
    h += '<span class="jb-thumb-empty"></span>';
  }
  h += '<span class="jb-phone">'+escHtml(j.phone)+'</span>';
  h += '<span class="jb-name">'+(j.name ? escHtml(j.name) : '')+'</span>';
  h += '<span class="jb-style">'+escHtml(j.style)+'</span>';
  h += '<span class="jb-status done">done</span>';
  h += '<span class="jb-printer">'+(j.printerName ? escHtml(j.printerName) : '')+'</span>';
  h += '<span class="jb-time">'+timeAgo(j.completedAt)+'</span>';
  h += '<span class="jb-action">';
  if (j.canReprint) {
    h += printerDropdown("jb-ptr-"+escHtml(j.filename), "Any printer");
    h += '<button class="jb-btn" onclick="reprintJob(&apos;'+escHtml(j.filename)+'&apos;)">Reprint</button>';
  } else {
    h += '<button class="jb-btn" disabled title="Output image no longer exists">Reprint</button>';
  }
  h += '</span>';
  h += '</div>';
  return h;
}

async function retryJob(filename, isPrintRetry) {
  try {
    var body = { filename };
    if (isPrintRetry) {
      var sel = document.getElementById("jb-ptr-" + filename);
      if (sel && sel.value) body.targetPrinter = sel.value;
    }
    var r = await fetch("api/retry-job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(body)
    });
    var d = await r.json();
    if (d.ok) {
      showToast("Job requeued to " + d.target);
      fetchJobs({ forceHistory: true });
      fetchStats();
    } else {
      showToast(d.error || "Retry failed");
    }
  } catch(e) { showToast("Retry failed"); }
}

async function reprintJob(filename) {
  try {
    var body = { filename };
    var sel = document.getElementById("jb-ptr-" + filename);
    if (sel && sel.value) {
      body.targetPrinter = sel.value;
    }
    var r = await fetch("api/reprint-job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(body)
    });
    var d = await r.json();
    if (d.ok) {
      showToast("Reprint queued" + (body.targetPrinter ? " to " + body.targetPrinter : ""));
      fetchJobs({ forceHistory: true });
      fetchStats();
    } else {
      showToast(d.error || "Reprint failed");
    }
  } catch(e) { showToast("Reprint failed"); }
}

async function releaseReadyJob(filename) {
  try {
    var r = await fetch("api/release-ready-job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ filename })
    });
    var d = await r.json();
    if (d.ok) {
      showToast("Released — any connected printer will pick it up");
      fetchJobs({ forceHistory: true });
      fetchStats();
    } else {
      showToast(d.error || "Release failed");
    }
  } catch(e) { showToast("Release failed"); }
}

async function togglePrinter(name) {
  try {
    var r = await fetch("api/toggle-printer", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ printer: name })
    });
    var d = await r.json();
    if (d.ok) {
      showToast(name + (d.enabled ? " enabled" : " disabled"));
      fetchStats();
    } else { showToast(d.error || "Failed"); }
  } catch(e) { showToast("Failed to toggle printer"); }
}

function showToast(msg) {
  var t = document.getElementById("fjToast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(function() { t.classList.remove("show"); }, 2500);
}

// ── Review Queue ──
var _reviewEnabled = false;
var _reviewTimer = null;
var _reviewTotal = 0;
var _rvSelected = new Set();
var _openFeedback = {};  // { filename: textareaValue }
var _hasMultiCards = false;
var _cardVariants = {};     // parentJobId -> { origSrc, variants: [...] }
var _regenInFlight = {};    // key "parentJobId|variantId" -> true while regen request pending
var _pickInFlight = new Set(); // parentJobId values currently being picked
var _modalContext = null;   // { parentJobId, idx, variantCount } or null for single
var _hasReviewPin = false;
var _qrFetched = false;
var _qrSvg = "";
var _qrUrl = "";

function checkReviewEnabled() {
  fetchReviewQueue();
}

async function fetchReviewQueue() {
  try {
    var event = selectedEvent;
    var ep = "api/review-queue?e=" + encodeURIComponent(event) + "&limit=12";
    var r = await fetch(ep);
    if (!r.ok) throw new Error("Review queue unavailable");
    var jobs = await r.json();
    var totalHeader = r.headers.get("X-Total-Count");
    var total = totalHeader === null ? jobs.length : Number(totalHeader);
    if (event === selectedEvent) renderReviewQueue(jobs, Number.isFinite(total) ? total : jobs.length);
  } catch(e) {}
}

function updateReviewSummary(shown) {
  document.getElementById("reviewCount").textContent = _reviewTotal;
  document.getElementById("reviewPanel").style.display = _reviewTotal > 0 ? "" : "none";
  var more = document.getElementById("reviewMore");
  more.hidden = _reviewTotal <= shown;
  if (!more.hidden) more.textContent = "Showing " + shown + " of " + _reviewTotal + " pending portraits. Open the full review queue to see the rest.";
  document.body.classList.toggle("review-pending", _reviewTotal > 0);
}

function updateQrBlock() {
  var qrBlock = document.getElementById("qrReviewBlock");
  var hintBlock = document.getElementById("qrReviewHint");
  if (_hasReviewPin) {
    hintBlock.style.display = "none";
    qrBlock.style.display = "";
    if (!_qrFetched) {
      _qrFetched = true;
      fetch("api/review-qr").then(function(r){return r.json()}).then(function(d){
        _qrSvg = d.svg; _qrUrl = d.url;
        document.getElementById("qrReviewSvg").innerHTML = d.svg;
        document.getElementById("qrReviewUrl").textContent = d.url;
      }).catch(function(){ _qrFetched = false; });
    }
  } else {
    qrBlock.style.display = "none";
    hintBlock.style.display = "";
  }
}

// Per-card signature used to decide whether to re-render a card on poll.
// Two cards with the same sig render identically, so we skip the rebuild
// and preserve the card's images, event listeners, and open sub-panels
// (regen feedback textareas, etc).
function _rvCardSig(j) {
  if (j.parentJobId) {
    // Variant status (READY / REGENERATING / FAILED / SUPERSEDED) changes
    // as regens complete; regenCount goes up per variant. Both must be in
    // the signature so we catch those transitions.
    var vSig = (j.variants || []).map(function(v){
      return (v.variantId||v.filePrefix) + ":" + (v.status||"?") + ":" + (v.regenCount||0);
    }).join("|");
    return "M:" + j.parentJobId + "|" + vSig;
  }
  return "S:" + j.filename;
}

function renderReviewQueue(jobs, total) {
  var grid = document.getElementById("reviewGrid");
  _reviewTotal = Math.max(jobs.length, total || 0);
  updateReviewSummary(jobs.length);

  if (!jobs.length) {
    grid.replaceChildren();
    _rvSelected.clear();
    updateBulkBar(0);
    _hasMultiCards = false;
    refreshBulkApproveVisibility();
    return;
  }

  updateQrBlock();

  // Prune selection; card key is filename for singletons, parentJobId for multi
  var current = new Set(jobs.map(function(j){ return j.parentJobId || j.filename; }));
  _rvSelected.forEach(function(k){ if (!current.has(k)) _rvSelected.delete(k); });

  _hasMultiCards = jobs.some(function(j){ return !!j.parentJobId; });

  // Skip re-render if the user has a feedback textarea open — replacing the
  // card would blow away their typed text. Same guard as before.
  if (Object.keys(_openFeedback).length > 0) return;

  // Incremental update. Previously this rebuilt grid.innerHTML on every 3s
  // poll, which forced every card's images to re-decode and caused a visible
  // flicker on approve. Now we:
  //   1. Remove cards no longer in the queue (approved / rejected elsewhere)
  //   2. Update cards whose signature changed (status / regenCount)
  //   3. Append new cards at the end
  //   4. Reorder if needed (oldest first from server)
  var existingById = {};
  for (var i = 0; i < grid.children.length; i++) {
    var c = grid.children[i];
    existingById[c.id] = c;
  }
  var seenIds = {};
  var prevCardEl = null;
  for (var k = 0; k < jobs.length; k++) {
    var j = jobs[k];
    var id = "rv-" + (j.parentJobId || j.filename);
    seenIds[id] = true;
    var sig = _rvCardSig(j);
    var existing = existingById[id];
    var needsRender = !existing || existing.dataset.sig !== sig;
    if (needsRender) {
      var html = j.parentJobId ? renderMultiReviewCard(j) : renderSingleReviewCard(j);
      var tmp = document.createElement("div");
      tmp.innerHTML = html; // eslint-disable-line no-unsanitized/property
      var newEl = tmp.firstElementChild;
      newEl.dataset.sig = sig;
      if (existing) {
        grid.replaceChild(newEl, existing);
      } else if (prevCardEl && prevCardEl.nextSibling) {
        grid.insertBefore(newEl, prevCardEl.nextSibling);
      } else {
        grid.appendChild(newEl);
      }
      prevCardEl = newEl;
    } else {
      // Order might have shifted (e.g., a card ahead got approved). Move
      // into position only if needed.
      if (prevCardEl ? existing.previousSibling !== prevCardEl : grid.firstChild !== existing) {
        if (prevCardEl) prevCardEl.after(existing);
        else grid.prepend(existing);
      }
      prevCardEl = existing;
    }
  }
  // Remove cards that are no longer in the queue (server-side gone).
  for (var gid in existingById) {
    if (!seenIds[gid]) existingById[gid].remove();
  }

  updateBulkBar(jobs.length);
  refreshBulkApproveVisibility();
}

function renderSingleReviewCard(j) {
  var fn = escHtml(j.filename);
  var fp = escHtml(j.filePrefix);
  var eventPath = encodeURIComponent(j.eventName || "");
  var imgSrc = "/photogallery/staging/" + eventPath + "/" + fp + "_output.png";
  var origSrc = "/photogallery/staging/" + eventPath + "/" + fp + "_input.jpg";
  var fullSrc = imgSrc;
  var sel = _rvSelected.has(j.filename);
  var h = "";
  h += '<div class="rv-card'+(sel?" rv-selected":"")+'" id="rv-'+fn+'">';
  h += '<input type="checkbox" class="rv-card-check" '+(sel?"checked":"")+' onchange="toggleSelect(\\''+fn+'\\',this.checked)" title="Select for bulk action">';
  h += '<div class="rv-images">';
  h += '<div class="rv-img-wrap"><img src="'+origSrc+'" onclick="openSingleReviewModal(\\''+origSrc+'\\',\\''+fullSrc+'\\',\\''+fn+'\\')" title="Click to compare"><span class="rv-img-label">Original</span></div>';
  h += '<div class="rv-img-wrap"><img src="'+imgSrc+'" onclick="openSingleReviewModal(\\''+origSrc+'\\',\\''+fullSrc+'\\',\\''+fn+'\\')" title="Click to compare"><span class="rv-img-label">Generated</span></div>';
  h += '</div>';
  h += '<div class="rv-meta">'+escHtml(j.style||"unknown")+' &middot; '+timeAgo(j.reviewAt)+'</div>';
  h += '<div class="rv-actions">';
  h += '<button class="rv-btn rv-btn-approve" onclick="reviewAction(\\''+fn+'\\',\\'approve\\')" title="Deliver this image to the user via MMS">Approve</button>';
  h += '<div class="rv-reject-row">';
  h += '<button class="rv-btn rv-btn-notify" onclick="reviewAction(\\''+fn+'\\',\\'reject\\',{notify:true})" title="Discard and send the user an SMS asking them to try a different photo">Reject + Notify</button>';
  h += '<button class="rv-btn rv-btn-reanalyze" onclick="showFeedback(\\''+fn+'\\')" title="Re-generate with fresh analysis — optionally add instructions">Re-analyze</button>';
  h += '<button class="rv-btn rv-btn-reject" onclick="reviewAction(\\''+fn+'\\',\\'reject\\')" title="Discard this image silently — the user is not notified">Reject</button>';
  h += '</div></div>';
  h += '<div class="rv-feedback" id="rvfb-'+fn+'">';
  h += '<textarea placeholder="Optional: describe what to fix (e.g. fix the logo, include the dog, remove the hat)"></textarea>';
  h += '<div class="rv-feedback-hint">Leave blank to re-generate with fresh analysis only.</div>';
  h += '<div class="rv-feedback-btns">';
  h += '<button class="rv-btn rv-fb-submit" onclick="submitFeedback(\\''+fn+'\\')">Re-generate</button>';
  h += '<button class="rv-btn rv-fb-cancel" onclick="hideFeedback(\\''+fn+'\\')">Cancel</button>';
  h += '</div></div>';
  h += '</div>';
  return h;
}

function renderMultiReviewCard(j) {
  var pid = escHtml(j.parentJobId);
  var cardKey = j.parentJobId;
  var variants = j.variants || [];
  var eventPath = encodeURIComponent(j.eventName || "");
  // gridSlots = originally-requested variant count (from server). Always use
  // this for the grid-template-columns track count so thumbnails stay the
  // same size even when some siblings are missing (e.g., 2 of 3 failed and
  // got cleaned up). Missing slots render as empty placeholders rather
  // than stretching the surviving variants across the row.
  var gridSlots = j.variantCount || variants.length || 1;
  var firstPrefix = variants[0] ? escHtml(variants[0].filePrefix) : escHtml(j.filePrefix);
  var origSrc = "/photogallery/staging/" + eventPath + "/" + firstPrefix + "_input.jpg";
  var sel = _rvSelected.has(cardKey);

  _cardVariants[cardKey] = {
    origSrc: origSrc,
    variants: variants.map(function(v){
      return {
        variantId: v.variantId,
        filePrefix: v.filePrefix,
        status: v.status,
        mmsSrc: "/photogallery/staging/" + eventPath + "/" + v.filePrefix + "_output.png",
        fullSrc: "/photogallery/staging/" + eventPath + "/" + v.filePrefix + "_output.png",
      };
    }),
  };

  var regenLimit = j.regenerationLimit || 2;
  var h = "";
  h += '<div class="rv-card rv-multi'+(sel?" rv-selected":"")+'" id="rv-'+pid+'" style="--variant-count:'+gridSlots+'">';
  h += '<input type="checkbox" class="rv-card-check" '+(sel?"checked":"")+' onchange="toggleSelect(\\''+pid+'\\',this.checked)" title="Select for bulk action">';

  h += '<div class="rv-orig-row">';
  h += '<div class="rv-orig-wrap"><img src="'+origSrc+'" alt="Original photo" onclick="openMultiReviewModal(\\''+pid+'\\',-1)" title="Original photo"></div>';

  h += '<div class="rv-variant-row">';
  variants.forEach(function(v, idx){
    var failed = v.status === "FAILED";
    // "inFlight" = variant is in PENDING_DIR or GENERATING_DIR (not yet
    // showable or approvable). REGENERATING = user clicked Regen;
    // GENERATING = initial fan-out still completing.
    var regenerating = v.status === "REGENERATING";
    var generating = v.status === "GENERATING";
    var inFlight = regenerating || generating;
    var vid = escHtml(v.variantId);
    var vfp = escHtml(v.filePrefix);
    var regenCount = v.regenCount || 0;
    var regenExhausted = regenCount >= regenLimit;
    var stateCls = (failed ? " is-failed" : "") + (inFlight ? " is-regen" : "");
    h += '<div class="rv-variant'+stateCls+'" data-variant-idx="'+idx+'" data-variant-id="'+vid+'" id="rvv-'+pid+'-'+idx+'">';
    h += '<div class="rv-v-imgwrap"'+(inFlight ? '' : ' onclick="openMultiReviewModal(\\''+pid+'\\','+idx+')"')+'>';
    h += '<span class="rv-v-num">'+(idx+1)+'/'+gridSlots+'</span>';
    if (regenCount > 0) {
      h += '<span class="rv-v-regens" title="Regenerations used">'+regenCount+'/'+regenLimit+'</span>';
    }
    if (inFlight) {
      h += '<div class="rv-v-regen-label">'+(regenerating ? 'Regenerating…' : 'Generating…')+'</div>';
    } else {
      h += '<img src="/photogallery/staging/'+eventPath+'/'+vfp+'_output.png" alt="Variant '+(idx+1)+'">';
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
      h += '<button class="rv-v-regen" onclick="regenVariantDash(\\''+pid+'\\',\\''+vid+'\\')"'+regenDisabled+' title="'+(regenExhausted?regenTitle:"Try generating this variant again")+'">↻ Try Again</button>';
    } else if (inFlight) {
      h += '<button class="rv-v-send" disabled title="'+(regenerating ? 'Wait for regeneration to finish' : 'Wait for generation to finish')+'">Approve</button>';
      h += '<button class="rv-v-regen" disabled title="'+regenTitle+'">↻ Regen</button>';
    } else {
      h += '<button class="rv-v-send" onclick="pickVariantDash(\\''+pid+'\\',\\''+vid+'\\')" title="Approve variant '+(idx+1)+' — delivered to the user via MMS">Approve</button>';
      h += '<button class="rv-v-regen" onclick="regenVariantDash(\\''+pid+'\\',\\''+vid+'\\')"'+regenDisabled+' title="'+regenTitle+'">↻ Regen this</button>';
    }
    h += '</div>';
    h += '</div>';
  });
  // Fill empty slots so the grid keeps its shape when some siblings are
  // missing. Placeholder is non-interactive with a "gone" label.
  for (var slotIdx = variants.length; slotIdx < gridSlots; slotIdx++) {
    h += '<div class="rv-variant is-empty" aria-hidden="true">';
    h += '<div class="rv-v-imgwrap"><span class="rv-v-num">'+(slotIdx+1)+'/'+gridSlots+'</span>';
    h += '<div class="rv-v-regen-label">Unavailable</div></div>';
    h += '<div class="rv-v-actions"></div>';
    h += '</div>';
  }
  h += '</div></div>';

  h += '<div class="rv-meta">'+escHtml(j.style||"unknown")+' &middot; '+timeAgo(j.reviewAt)+' &middot; '+variants.length+' of '+gridSlots+' variants</div>';

  h += '<div class="rv-card-actions">';
  h += '<button class="rv-btn rv-btn-notify" onclick="parentActionDash(\\''+pid+'\\',\\'reject\\',{notify:true})" title="Discard all variants and SMS the user to try again">Reject + Notify</button>';
  h += '<button class="rv-btn rv-btn-reanalyze" onclick="showFeedback(\\''+pid+'\\')" title="Discard all and regenerate with optional feedback">Re-analyze All</button>';
  h += '<button class="rv-btn rv-btn-reject" onclick="parentActionDash(\\''+pid+'\\',\\'reject\\')" title="Discard all variants silently — user is not notified">Reject Silently</button>';
  h += '</div>';

  h += '<div class="rv-feedback" id="rvfb-'+pid+'">';
  h += '<textarea placeholder="Optional: describe what to fix for all new regenerations"></textarea>';
  h += '<div class="rv-feedback-hint">Leave blank to regenerate all '+gridSlots+' variants with fresh analysis.</div>';
  h += '<div class="rv-feedback-btns">';
  h += '<button class="rv-btn rv-fb-submit" onclick="submitFeedbackParentDash(\\''+pid+'\\')">Regenerate All</button>';
  h += '<button class="rv-btn rv-fb-cancel" onclick="hideFeedback(\\''+pid+'\\')">Cancel</button>';
  h += '</div></div>';

  h += '</div>';
  return h;
}

function refreshBulkApproveVisibility() {
  var btn = document.querySelector('.rv-bulk-actions .rv-btn-approve');
  if (!btn) return;
  btn.style.display = _hasMultiCards ? "none" : "";
  btn.title = _hasMultiCards
    ? "Bulk approve is disabled when multi-variant cards are present — pick a specific variant per card"
    : "Deliver all selected images to their users via MMS";
}

function toggleSelect(filename, checked) {
  if (checked) _rvSelected.add(filename); else _rvSelected.delete(filename);
  var card = document.getElementById("rv-"+filename);
  if (card) { if (checked) card.classList.add("rv-selected"); else card.classList.remove("rv-selected"); }
  var total = document.querySelectorAll(".rv-card-check").length;
  document.getElementById("rvSelectAll").checked = _rvSelected.size === total && total > 0;
  updateBulkBar(total);
}

function toggleSelectAll(checked) {
  document.querySelectorAll(".rv-card-check").forEach(function(cb) {
    cb.checked = checked;
    var card = cb.closest(".rv-card");
    var fn = card ? card.id.replace("rv-","") : null;
    if (fn) { if (checked) { _rvSelected.add(fn); card.classList.add("rv-selected"); } else { _rvSelected.delete(fn); card.classList.remove("rv-selected"); } }
  });
  var total = document.querySelectorAll(".rv-card-check").length;
  updateBulkBar(total);
}

function updateBulkBar(total) {
  var bar = document.getElementById("rvBulkBar");
  var countEl = document.getElementById("rvBulkCount");
  if (total > 0) {
    bar.classList.add("active");
    countEl.textContent = _rvSelected.size ? _rvSelected.size + " of " + total + " selected" : "";
  } else {
    bar.classList.remove("active");
  }
}

async function bulkReviewAction(action) {
  if (!_rvSelected.size) { showToast("No items selected"); return; }
  var filenames = Array.from(_rvSelected);
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
    var r = await fetch("api/review-bulk", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({filenames: filenames, action: action})
    });
    var d = await r.json();
    _rvSelected.clear();
    document.getElementById("rvSelectAll").checked = false;
    var ok = d.results ? d.results.filter(function(x){return x.ok}).length : 0;
    var fail = count - ok;
    showToast(ok + " " + label + (action==="approve"?"d":"ed") + (fail ? ", " + fail + " failed" : ""));
    fetchReviewQueue();
    fetchStats();
  } catch(e) { showToast("Bulk action failed"); }
}

async function reviewAction(filename, action, opts) {
  try {
    opts = opts || {};
    var payload = {filename: filename, action: action};
    if (opts.notify) payload.notify = true;
    if (opts.reanalyze) {
      payload.reanalyze = true;
      if (opts.feedback) payload.feedback = opts.feedback;
    }
    var r = await fetch("api/review-job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    var d = await r.json();
    if (d.ok) {
      _rvSelected.delete(filename);
      var card = document.getElementById("rv-"+filename);
      if (card) card.remove();
      var msg = action === "approve" ? "Image approved" : opts.reanalyze ? (payload.feedback ? "Re-generating with feedback" : "Re-generating with fresh analysis") : opts.notify ? "Image rejected, user notified" : "Image rejected";
      showToast(msg);
      // Keep the total accurate while the bounded preview waits for its next poll.
      _reviewTotal = Math.max(0, _reviewTotal - 1);
      updateReviewSummary(document.querySelectorAll("#reviewGrid .rv-card").length);
      updateBulkBar(document.querySelectorAll("#reviewGrid .rv-card").length);
      refreshBulkApproveVisibility();
      fetchStats();
    } else {
      showToast(d.error || "Action failed");
    }
  } catch(e) { showToast("Action failed"); }
}

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// Modal — singleton path (legacy). Kept for backwards compat.
function openReviewModal(origSrc, genSrc) {
  openSingleReviewModal(origSrc, genSrc);
}
// filename is the singleton job's .json filename — needed to wire up the
// in-modal Approve button. Optional for back-compat (old callers that didn't
// pass it still get a working compare-view modal, just without Approve).
function openSingleReviewModal(origSrc, genSrc, filename) {
  _modalContext = filename ? { kind: "single", filename: filename } : null;
  [origSrc, genSrc].forEach(function(s) { if (s) { var p = new Image(); p.src = s; } });
  var img = document.getElementById("reviewModalImg");
  img.src = "";
  document.getElementById("reviewModalOrig").src = origSrc;
  img.src = genSrc;
  var labelEl = document.getElementById("reviewModalGenLabel");
  if (labelEl) labelEl.textContent = "Generated";
  // Hide prev/next for singletons. Show/enable the Approve button only if
  // the caller gave us a filename — old callers (compare-view on Done jobs,
  // say) get the modal with Approve hidden instead of a broken button.
  var prev = document.getElementById("rvModalPrev");
  var next = document.getElementById("rvModalNext");
  if (prev) { prev.classList.remove("shown"); prev.style.display = "none"; }
  if (next) { next.classList.remove("shown"); next.style.display = "none"; }
  var approve = document.getElementById("rvModalApprove");
  if (approve) { approve.style.display = filename ? "inline-flex" : "none"; approve.disabled = false; }
  document.getElementById("reviewModal").classList.add("open");
  document.addEventListener("keydown", _modalEsc);
}

// Modal — multi-variant path. idx -1 or 0 both start on variant 1.
function openMultiReviewModal(pid, idx) {
  var ctx = _cardVariants[pid];
  if (!ctx) return;
  _modalContext = { kind: "multi", parentJobId: pid, idx: Math.max(0, idx), variantCount: ctx.variants.length };
  // Preload every variant's modal image before showing the modal — we use
  // the MMS jpg (already resized for delivery) instead of the multi-MB
  // _output.png so paint is instant after cache warm-up.
  for (var i = 0; i < ctx.variants.length; i++) {
    var src = ctx.variants[i] && ctx.variants[i].mmsSrc;
    if (src) { var pre = new Image(); pre.src = src; }
  }
  renderModalVariant();
  document.getElementById("reviewModal").classList.add("open");
  document.addEventListener("keydown", _modalEsc);
}

function cycleModalVariant(delta) {
  if (!_modalContext) return;
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
  // Blank the src before assigning the new one to abort any in-flight load —
  // otherwise the previous variant's image can finish loading AFTER the new
  // one is requested and end up painted on top of it.
  var img = document.getElementById("reviewModalImg");
  img.src = "";
  document.getElementById("reviewModalOrig").src = ctx.origSrc;
  img.src = v.mmsSrc;
  var labelEl = document.getElementById("reviewModalGenLabel");
  if (labelEl) labelEl.textContent = "Variant " + (_modalContext.idx + 1) + " / " + _modalContext.variantCount;
  var prev = document.getElementById("rvModalPrev");
  var next = document.getElementById("rvModalNext");
  // Show prev/next only when there are multiple variants to cycle through.
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
  // Approve button: disabled if the current variant is still generating /
  // regenerating / failed / superseded — only READY variants can be picked.
  var approve = document.getElementById("rvModalApprove");
  if (approve) {
    var canApprove = v && (v.status === "READY" || v.status === undefined); // undefined = legacy shape
    approve.style.display = "inline-flex";
    approve.disabled = !canApprove;
    approve.title = canApprove
      ? "Approve this variant (A or Enter)"
      : "Variant not ready (" + (v && v.status || "unknown") + ")";
  }
}

function closeReviewModal(e) {
  // Only close when clicking the backdrop itself, not any child (nav buttons,
  // images, labels) — previously BUTTON clicks bubbled up and closed the
  // modal, breaking the Prev/Next arrow buttons.
  if (e && e.target && !e.target.classList.contains("rv-modal")) return;
  document.getElementById("reviewModal").classList.remove("open");
  document.removeEventListener("keydown", _modalEsc);
  _modalContext = null;
}
function _modalEsc(e) {
  if (e.key === "Escape") return closeReviewModal();
  if (_modalContext && _modalContext.kind === "multi") {
    if (e.key === "ArrowLeft") { e.preventDefault(); return cycleModalVariant(-1); }
    if (e.key === "ArrowRight") { e.preventDefault(); return cycleModalVariant(1); }
  }
  // A / Enter approves the currently-displayed image (single or multi).
  // Lowercase-a ensures a bare letter press works regardless of caps lock.
  if (_modalContext && (e.key === "a" || e.key === "A" || e.key === "Enter")) {
    e.preventDefault();
    approveFromModal();
  }
}

// Approve whatever's currently on screen in the modal. Works for both
// single (_modalContext.filename set) and multi (parentJobId + idx). Closes
// the modal after the server confirms the approval succeeded so the admin
// lands back on the review grid with one fewer card.
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
      // Log what we're about to approve so the admin can verify in the
      // browser console that the right variant went through (paranoia check:
      // ctx.idx should always match what the label shows on screen).
      console.log("Approving variant " + (ctx.idx + 1) + "/" + ctx.variantCount + " (" + v.variantId + ") of parent " + ctx.parentJobId);
      closeReviewModal();
      // Delegate to the existing card-level handler — it already handles the
      // optimistic card.remove(), 409 races, toast, and badge refresh.
      await pickVariantDash(ctx.parentJobId, v.variantId);
    } else if (ctx.kind === "single") {
      console.log("Approving singleton " + ctx.filename);
      closeReviewModal();
      await reviewAction(ctx.filename, "approve");
    }
  } finally {
    // _modalContext is cleared by closeReviewModal; if the approve failed
    // mid-flight the card still exists and its buttons work normally.
    if (btn && document.getElementById("reviewModal").classList.contains("open")) {
      btn.disabled = false;
    }
  }
}

// Swipe gestures inside the comparison modal — touch/drag horizontally to
// cycle variants. Body-delegated so it survives re-renders.
(function setupModalSwipe() {
  var THRESHOLD = 50;
  var startX = 0, startY = 0, startT = 0, active = false;
  function inModal(t) {
    var m = document.getElementById("reviewModal");
    return m && m.classList.contains("open") && m.contains(t);
  }
  document.body.addEventListener("touchstart", function(e) {
    if (e.touches.length !== 1 || !inModal(e.target)) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startT = Date.now();
    active = true;
  }, { passive: true });
  document.body.addEventListener("touchend", function(e) {
    if (!active || !e.changedTouches || !e.changedTouches.length) return;
    active = false;
    var dx = e.changedTouches[0].clientX - startX;
    var dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (Date.now() - startT > 600) return;
    if (Math.abs(dx) < THRESHOLD) return;
    cycleModalVariant(dx < 0 ? 1 : -1);
  }, { passive: true });
  document.body.addEventListener("touchcancel", function() { active = false; }, { passive: true });
})();

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
}
function submitFeedback(fn) {
  var panel = document.getElementById("rvfb-"+fn);
  var fb = panel ? panel.querySelector("textarea").value.trim() : "";
  delete _openFeedback[fn];
  reviewAction(fn, "reject", { reanalyze: true, feedback: fb || undefined });
}

// ── Multi-variant action handlers ──────────────────────────────────────────

async function pickVariantDash(parentJobId, variantId) {
  if (_pickInFlight.has(parentJobId)) return;
  _pickInFlight.add(parentJobId);
  var card = document.getElementById("rv-"+parentJobId);
  if (card) card.querySelectorAll(".rv-v-send, .rv-v-regen").forEach(function(b){ b.disabled = true; });
  try {
    var r = await fetch("api/variant/pick", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ parentJobId: parentJobId, variantId: variantId })
    });
    if (r.ok) {
      _rvSelected.delete(parentJobId);
      if (card) card.remove();
      showToast("Sent to user");
      // Keep the total accurate while the bounded preview waits for its next poll.
      _reviewTotal = Math.max(0, _reviewTotal - 1);
      updateReviewSummary(document.querySelectorAll("#reviewGrid .rv-card").length);
      updateBulkBar(document.querySelectorAll("#reviewGrid .rv-card").length);
      refreshBulkApproveVisibility();
    } else if (r.status === 409) {
      // Server says it's already been decided (another admin / AI picked it).
      // Remove our card silently and let the next poll reconcile.
      if (card) card.remove();
      showToast("Already handled — moving on");
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

async function regenVariantDash(parentJobId, variantId) {
  var key = parentJobId + "|" + variantId;
  if (_regenInFlight[key]) return;
  _regenInFlight[key] = true;
  var card = document.getElementById("rv-"+parentJobId);
  var variantEl = card ? card.querySelector('[data-variant-id="'+CSS.escape(variantId)+'"]') : null;
  if (variantEl) {
    variantEl.classList.add("is-regen");
    variantEl.classList.remove("is-failed");
    variantEl.querySelectorAll("button").forEach(function(b){ b.disabled = true; });
  }
  try {
    var r = await fetch("api/variant/regenerate", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ parentJobId: parentJobId, variantId: variantId })
    });
    if (r.ok) {
      showToast("Regenerating variant…");
      fetchReviewQueue();
    } else if (r.status === 429) {
      var dLimit = await r.json().catch(function(){ return {}; });
      showToast(dLimit.error || "Regeneration limit reached");
      if (variantEl) {
        variantEl.classList.remove("is-regen");
        variantEl.querySelectorAll("button").forEach(function(b){ b.disabled = false; });
        var rb = variantEl.querySelector(".rv-v-regen");
        if (rb) { rb.disabled = true; rb.title = "Regeneration limit reached"; }
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

async function parentActionDash(parentJobId, action, opts) {
  opts = opts || {};
  var payload = { parentJobId: parentJobId, action: action };
  if (opts.notify) payload.notify = true;
  if (opts.reanalyze) {
    payload.reanalyze = true;
    if (opts.feedback) payload.feedback = opts.feedback;
  }
  try {
    var r = await fetch("api/review-job", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify(payload)
    });
    var d = await r.json();
    if (d.ok) {
      _rvSelected.delete(parentJobId);
      var card = document.getElementById("rv-"+parentJobId);
      if (card) card.remove();
      var msg = opts.reanalyze
        ? (opts.feedback ? "Re-generating with feedback" : "Re-generating all variants")
        : opts.notify ? "Rejected — user notified" : "Rejected silently";
      showToast(msg);
      fetchReviewQueue();
    } else {
      showToast(d.error || "Action failed");
      fetchReviewQueue();
    }
  } catch(e) { showToast("Connection error — try again"); }
}

function submitFeedbackParentDash(pid) {
  var panel = document.getElementById("rvfb-"+pid);
  var fb = panel ? panel.querySelector("textarea").value.trim() : "";
  delete _openFeedback[pid];
  parentActionDash(pid, "reject", { reanalyze: true, feedback: fb || undefined });
}

function toggleTheme() {
  var html = document.documentElement;
  var current = html.getAttribute('data-theme') || 'dark';
  var next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('twilio-theme', next);
}

// ── Audit Log ──
var auditOffset = 0;
var auditLimit = 20;

function fmtAuditTime(ts) {
  var d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function esc(s) {
  var d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function fmtValue(v) {
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "object") return esc(JSON.stringify(v));
  return esc(String(v));
}

function renderAuditEntry(e) {
  var changes = "";
  if (e.action === "settings.update" && e.before && e.after) {
    var keys = Object.keys(e.after);
    changes = keys.map(function(k) {
      return '<span class="key">' + esc(k) + '</span>: <span class="old">' + fmtValue(e.before[k]) + '</span> &rarr; <span class="new">' + fmtValue(e.after[k]) + '</span>';
    }).join("<br>");
  } else if (e.action === "settings.revert") {
    changes = '<em>Reverted change ' + esc((e.originalId || "").slice(0, 8)) + '</em>';
  } else if (e.action === "variant.pick") {
    // Reviewer picked a winning variant from a multi-variant job group
    var pickedIdx = e.pickedVariantIndex != null ? e.pickedVariantIndex : "?";
    var total = e.variantCount != null ? e.variantCount : "?";
    var styleSuffix = e.style ? ' <span class="audit-meta">(' + esc(e.style) + (e.brand ? " · " + esc(e.brand) : "") + ')</span>' : "";
    changes = '<span class="key">Variant picked</span>: chose #' + esc(String(pickedIdx)) + ' of ' + esc(String(total)) + styleSuffix;
  } else if (e.action === "variant.regenerate") {
    // Reviewer kicked off a regeneration of a single variant
    var vIdx = e.variantIndex != null ? e.variantIndex : "?";
    var regen = e.regenerationIndex != null ? e.regenerationIndex : "?";
    var limit = e.regenerationLimit != null ? e.regenerationLimit : "?";
    changes = '<span class="key">Variant regenerated</span>: #' + esc(String(vIdx)) + ' <span class="audit-meta">(attempt ' + esc(String(regen)) + '/' + esc(String(limit)) + ')</span>';
  } else if (e.action === "parent.reanalyze") {
    // Reviewer rejected all variants and requested a fresh generation with
    // different scene analysis (and optional feedback prompt)
    var fbSuffix = e.feedback ? ' <span class="audit-meta">feedback: "' + esc(e.feedback) + '"</span>' : "";
    changes = '<span class="key">Reanalyzed</span>: all variants rejected, requeued with fresh analysis' + fbSuffix;
  } else if (e.action === "parent.reject") {
    // Reviewer rejected the entire variant group (no regeneration)
    var notified = e.notified === true ? "user notified" : e.notified === false ? "silently rejected" : "notify status unknown";
    changes = '<span class="key">Rejected</span>: ' + esc(String(e.variantCount || "?")) + ' variants — ' + notified;
  } else if (e.action === "variant.ai_pick") {
    // AI automatically picked the best variant (no human reviewer)
    if (e.outcome === "all_failed") {
      changes = '<span class="key">AI pick</span>: all ' + esc(String(e.variantCount || "?")) + ' variants failed review' + (e.reason ? ' <span class="audit-meta">(' + esc(e.reason) + ')</span>' : "");
    } else {
      var aiIdx = e.pickedVariantIndex != null ? e.pickedVariantIndex : "?";
      changes = '<span class="key">AI pick</span>: chose #' + esc(String(aiIdx)) + ' of ' + esc(String(e.variantCount || "?"));
    }
  } else {
    // Unknown action type — show the raw name so operators can spot it
    changes = '<em>' + esc(e.action || "unknown action") + '</em>';
  }
  var revertHtml = "";
  if (e.action === "settings.update") {
    if (e.reverted) {
      revertHtml = '<span class="audit-reverted">Reverted</span>';
    } else if (e.canRevert !== false) {
      revertHtml = '<button onclick="revertAudit(\\\'' + esc(e.id) + '\\\', this)">Revert</button>';
    } else {
      revertHtml = '<span class="audit-reverted">Unavailable</span>';
    }
  }
  // Non-settings events (variant.* / parent.*) are system-generated and have
  // no actor field — show "system" instead of an empty column.
  var actorText = e.actor ? e.actor.split("@")[0] : "system";
  return '<div class="audit-row">'
    + '<div class="audit-time">' + fmtAuditTime(e.ts) + '</div>'
    + '<div class="audit-actor">' + esc(actorText) + '</div>'
    + '<div class="audit-detail">' + changes + '</div>'
    + '<div class="audit-revert">' + revertHtml + '</div>'
    + '</div>';
}

async function fetchAuditLog(append) {
  try {
    // type=settings filters out variant.pick/regenerate/etc — those belong
    // in a future review activity panel, not the settings activity log.
    var r = await fetch("api/audit?type=settings&limit=" + auditLimit + "&offset=" + (append ? auditOffset : 0));
    var d = await r.json();
    var container = document.getElementById("auditLog");
    if (!append) { container.innerHTML = ""; auditOffset = 0; }
    if (d.entries.length === 0 && !append) {
      container.innerHTML = '<span style="color:var(--th-text-muted)">No activity logged yet.</span>';
    } else {
      d.entries.forEach(function(e) { container.innerHTML += renderAuditEntry(e); });
    }
    auditOffset += d.entries.length;
    var btn = document.getElementById("auditLoadMore");
    btn.style.display = auditOffset < d.total ? "" : "none";
  } catch(e) {
    document.getElementById("auditLog").innerHTML = '<span style="color:var(--th-text-muted)">Failed to load audit log.</span>';
  }
}

function loadMoreAudit() { fetchAuditLog(true); }

async function revertAudit(id, btn) {
  var ok = await twModal.confirm({
    title: "Revert settings change?",
    message: "The previous values will be restored. This itself creates a new audit entry.",
    confirmText: "Revert",
    danger: true,
  });
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = "Reverting...";
  try {
    var r = await fetch("api/audit/revert/" + id, { method: "POST" });
    var d = await r.json();
    if (d.error) { await twModal.alert({ title: "Revert failed", message: d.error }); btn.disabled = false; btn.textContent = "Revert"; return; }
    btn.parentElement.innerHTML = '<span class="audit-reverted">Reverted</span>';
    fetchStats();
  } catch(e) {
    await twModal.alert({ title: "Revert failed", message: "Check the server logs and try again." });
    btn.disabled = false;
    btn.textContent = "Revert";
  }
}

// Each view refreshes only while visible. A poller waits for its previous
// request to settle before starting another, even when a tab or event changes.
var dashboardPollers = {
  stats: { every: 12000, run: fetchStats, enabled: function() { return true; } },
  review: { every: 5000, run: fetchReviewQueue, enabled: function() { return true; } },
  jobs: { every: 8000, run: fetchJobs, enabled: function() { return activeWorkspace === "jobs" && !_jobBrowsingHistory; } },
  voice: { every: 30000, run: fetchVoiceIssues, enabled: function() { return activeWorkspace === "jobs"; } },
  people: { every: 30000, run: fetchDashboardUsers, enabled: function() { return activeWorkspace === "people" && !_peopleBrowsingHistory; } },
  activity: { every: 30000, run: function() { return fetchAuditLog(false); }, enabled: function() { return activeWorkspace === "activity" && auditOffset <= auditLimit; } },
};
for (var poller of Object.values(dashboardPollers)) {
  poller.running = false;
  poller.pending = false;
  poller.last = 0;
}
// Voice issue discovery can be expensive on a large queue. Give the primary
// snapshot and recent jobs a head start, then refresh it independently.
dashboardPollers.voice.last = Date.now() - 25000;

function scheduleDashboardPoll(name, force) {
  var poller = dashboardPollers[name];
  if (!poller || document.hidden || !poller.enabled() || firstLoad && name !== "stats") return;
  if (poller.running) {
    if (force) poller.pending = true;
    return;
  }
  if (!force && Date.now() - poller.last < poller.every) return;
  poller.running = true;
  Promise.resolve().then(poller.run).catch(function(error) {
    console.error("Dashboard refresh failed:", name, error);
  }).finally(function() {
    poller.running = false;
    poller.last = Date.now();
    if (poller.pending) {
      poller.pending = false;
      scheduleDashboardPoll(name, true);
    }
  });
}

function pollDashboard(force, skipStats) {
  for (var name of Object.keys(dashboardPollers)) {
    if (skipStats && name === "stats") continue;
    scheduleDashboardPoll(name, force);
  }
}

document.addEventListener("visibilitychange", function() {
  if (!document.hidden) pollDashboard(true);
});
var requestedView = new URLSearchParams(window.location.search).get("tab");
selectWorkspaceTab(WORKSPACE_VIEWS.includes(requestedView) ? requestedView : "jobs", { refresh: false, updateUrl: false });
scheduleDashboardPoll("stats", true);
setInterval(function() { pollDashboard(false); }, 1500);
</script>
${userBar}
${magicHat}
</body>
</html>`;
}

module.exports = { renderDashboardPage };

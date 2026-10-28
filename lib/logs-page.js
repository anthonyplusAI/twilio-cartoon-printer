// Static Logs view for the local synthetic preview and the live dashboard.
const { renderSiteNav, siteNavStylesheet } = require("./site-nav");

function renderLogsPage({ userBar = "", magicHat = "" } = {}) {
    return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<script>(function(){var t=localStorage.getItem('twilio-theme')||'dark';document.documentElement.setAttribute('data-theme',t)})()</script>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/svg+xml" href="/assets/icon-twilio-bug-red.svg">
<link rel="stylesheet" href="/assets/twilio-brand.css">
<link rel="stylesheet" href="/assets/logs-workspace.css">
${siteNavStylesheet()}
<title>Logs — Twilio Photo Booth</title>
</head>
<body class="logs-workspace">
<div class="wrap">
  ${renderSiteNav("logs")}

  <header class="logs-header">
    <div>
      <span class="logs-kicker">EVENT OPERATIONS / DIAGNOSTICS</span>
      <h1>Application logs</h1>
      <p>Follow queue, delivery, and system activity in real time.</p>
    </div>
    <div class="logs-header-controls">
      <a class="logs-review-notice" id="logsReviewNotice" href="/review/queue" hidden><span class="logs-review-dot" aria-hidden="true"></span><span id="logsReviewCount">0 portraits pending review</span></a>
      <div class="logs-connection is-connecting" id="connectionStatus" role="status" aria-live="polite"><span class="logs-status-dot"></span><span id="connectionText">Connecting</span></div>
      <button class="theme-toggle" type="button" onclick="toggleTheme()" aria-label="Toggle light and dark theme" title="Toggle theme">
        <svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
        <svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>
      </button>
    </div>
  </header>

  <main>
    <section class="logs-snapshot" aria-label="Recent log counts">
      <div class="logs-stat"><span class="logs-stat-label">Recent in view</span><strong id="totalCount">0</strong></div>
      <div class="logs-stat"><span class="logs-stat-label">Info</span><strong id="infoCount">0</strong></div>
      <div class="logs-stat"><span class="logs-stat-label">Warnings</span><strong id="warnCount">0</strong></div>
      <div class="logs-stat"><span class="logs-stat-label">Errors</span><strong id="errorCount">0</strong></div>
    </section>

    <section class="logs-panel" aria-labelledby="streamTitle">
      <div class="logs-panel-heading">
        <div><span class="logs-kicker">LIVE STREAM</span><h2 id="streamTitle">Activity stream</h2><p>Showing the most recent messages. Pause or filter to inspect a moment.</p></div>
        <span class="logs-cap-note">Up to 400 messages kept in this view</span>
      </div>
      <div class="logs-toolbar" aria-label="Log filters and actions">
        <div class="logs-levels" role="group" aria-label="Filter by level">
          <button class="tb-btn active" type="button" data-level="" aria-pressed="true" onclick="setLevel('')">All</button>
          <button class="tb-btn" type="button" data-level="info" aria-pressed="false" onclick="setLevel('info')">Info</button>
          <button class="tb-btn" type="button" data-level="warn" aria-pressed="false" onclick="setLevel('warn')">Warn</button>
          <button class="tb-btn" type="button" data-level="error" aria-pressed="false" onclick="setLevel('error')">Error</button>
        </div>
        <label class="logs-field"><span class="sr-only">Category</span><select id="catFilter" onchange="applyFilters()">
          <option value="">All categories</option><option value="queue">Queue</option><option value="pipeline">Pipeline</option><option value="print">Print</option><option value="sms">SMS</option><option value="safety">Safety</option><option value="system">System</option><option value="error">Error</option><option value="app">App</option>
        </select></label>
        <label class="logs-field logs-search"><span class="sr-only">Search log messages</span><input id="searchBox" type="search" placeholder="Search messages" oninput="debounceFilters()"></label>
        <div class="logs-toolbar-actions">
          <button class="tb-btn" id="pauseBtn" type="button" onclick="togglePause()">Pause</button>
          <button class="tb-btn" type="button" onclick="clearLogs()">Clear view</button>
        </div>
      </div>
      <div class="logs-column-head" aria-hidden="true"><span>Time</span><span>Level</span><span>Category</span><span>Message</span></div>
      <div class="log-container" id="logContainer">
        <div class="log-rows" id="logRows" role="log" aria-live="off" aria-label="Application log entries"></div>
        <div class="empty-state" id="emptyState">Connecting to the log stream...</div>
      </div>
      <div class="logs-footer"><span id="visibleCount">Loading recent messages...</span><span>New messages appear while this tab is visible.</span></div>
    </section>
  </main>
</div>

<script>
var MAX_VIEW = 400;
var _entries = [];
var _entryById = new Map();
var _pending = [];
var _lastId = 0;
var _levelFilter = '';
var _manualPaused = false;
var _autoScroll = true;
var _source = null;
var _renderScheduled = false;
var _searchTimer = 0;
var _loaded = false;
var _emptyMessage = 'No logs yet. Waiting for activity...';

var container = document.getElementById('logContainer');
var rows = document.getElementById('logRows');
var emptyState = document.getElementById('emptyState');

container.addEventListener('scroll', function() {
  _autoScroll = container.scrollHeight - container.scrollTop - container.clientHeight < 40;
});

function fmtTime(ts) {
  var d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' '
    + d.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function showEntry(entry) {
  if (_levelFilter && entry.level !== _levelFilter) return false;
  var category = document.getElementById('catFilter').value;
  if (category && entry.category !== category) return false;
  var search = document.getElementById('searchBox').value.trim().toLowerCase();
  return !search || String(entry.message || '').toLowerCase().includes(search);
}

function renderEntry(entry) {
  var row = document.createElement('div');
  row.className = 'log-entry level-' + (['info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info');
  row.dataset.id = String(entry.id);
  row.setAttribute('role', 'listitem');
  row.hidden = !showEntry(entry);
  var time = document.createElement('time');
  time.className = 'le-time';
  var date = new Date(entry.ts);
  if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();
  time.textContent = fmtTime(entry.ts);
  var level = document.createElement('span');
  level.className = 'le-level';
  level.textContent = entry.level || 'info';
  var category = document.createElement('span');
  category.className = 'le-cat';
  category.textContent = entry.category || 'app';
  var message = document.createElement('span');
  message.className = 'le-msg';
  message.textContent = String(entry.message || '');
  row.append(time, level, category, message);
  return row;
}

function updateSummary() {
  var counts = { info: 0, warn: 0, error: 0 };
  for (var entry of _entries) if (counts[entry.level] !== undefined) counts[entry.level]++;
  document.getElementById('totalCount').textContent = _entries.length.toLocaleString();
  document.getElementById('infoCount').textContent = counts.info.toLocaleString();
  document.getElementById('warnCount').textContent = counts.warn.toLocaleString();
  document.getElementById('errorCount').textContent = counts.error.toLocaleString();
  var shown = rows.querySelectorAll('.log-entry:not([hidden])').length;
  document.getElementById('visibleCount').textContent = shown.toLocaleString() + ' matching · '
    + _entries.length.toLocaleString() + ' recent in view';
  emptyState.textContent = _entries.length ? 'No messages match these filters.' : _emptyMessage;
  emptyState.hidden = shown > 0;
}

function flushPending() {
  _renderScheduled = false;
  if (!_pending.length) return updateSummary();
  var fragment = document.createDocumentFragment();
  for (var entry of _pending) fragment.appendChild(renderEntry(entry));
  _pending = [];
  rows.appendChild(fragment);
  while (rows.childElementCount > MAX_VIEW) {
    var oldest = rows.firstElementChild;
    var height = oldest.offsetHeight;
    oldest.remove();
    if (!_autoScroll) container.scrollTop = Math.max(0, container.scrollTop - height);
  }
  updateSummary();
  if (_autoScroll) container.scrollTop = container.scrollHeight;
}

function queueEntry(entry) {
  var id = Number(entry && entry.id);
  if (!Number.isSafeInteger(id) || id <= _lastId) return;
  _lastId = id;
  _entries.push(entry);
  _entryById.set(id, entry);
  if (_entries.length > MAX_VIEW) {
    var removed = _entries.shift();
    _entryById.delete(Number(removed.id));
  }
  _pending.push(entry);
  if (_pending.length > MAX_VIEW) _pending.shift();
  if (!_renderScheduled) {
    _renderScheduled = true;
    requestAnimationFrame(flushPending);
  }
}

function setLevel(level) {
  _levelFilter = level;
  document.querySelectorAll('.logs-levels .tb-btn').forEach(function(button) {
    var active = button.dataset.level === level;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  applyFilters();
}

function applyFilters() {
  if (_pending.length) flushPending();
  for (var row of rows.children) {
    var entry = _entryById.get(Number(row.dataset.id));
    row.hidden = !entry || !showEntry(entry);
  }
  updateSummary();
}

function debounceFilters() {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(applyFilters, 120);
}

function clearLogs() {
  _entries = [];
  _entryById.clear();
  _pending = [];
  rows.replaceChildren();
  _emptyMessage = 'View cleared. Waiting for new messages...';
  _autoScroll = true;
  updateSummary();
}

function setConnection(state, label) {
  document.getElementById('connectionStatus').className = 'logs-connection is-' + state;
  document.getElementById('connectionText').textContent = label;
}

function disconnectStream() {
  if (_source) { _source.close(); _source = null; }
}

function resetStreamSession() {
  disconnectStream();
  _lastId = 0;
  clearLogs();
  _emptyMessage = 'A new server log session started.';
  updateSummary();
  connectStream();
}

function connectStream() {
  if (_manualPaused) return setConnection('paused', 'Paused');
  if (document.hidden) return setConnection('paused', 'Paused in background');
  if (_source) return;
  setConnection('connecting', 'Connecting');
  var source = new EventSource('/dashboard/api/logs/stream?since=' + _lastId);
  _source = source;
  source.onopen = function() { if (_source === source) setConnection('live', 'Live stream'); };
  source.onmessage = function(event) {
    try { queueEntry(JSON.parse(event.data)); } catch(_) {}
  };
  source.addEventListener('reset', function() { if (_source === source) resetStreamSession(); });
  source.onerror = function() { if (_source === source) setConnection('connecting', 'Reconnecting'); };
}

function togglePause() {
  _manualPaused = !_manualPaused;
  var button = document.getElementById('pauseBtn');
  button.textContent = _manualPaused ? 'Resume' : 'Pause';
  button.setAttribute('aria-pressed', String(_manualPaused));
  button.classList.toggle('active', _manualPaused);
  if (_manualPaused) { disconnectStream(); setConnection('paused', 'Paused'); }
  else connectStream();
}

document.addEventListener('visibilitychange', function() {
  if (document.hidden) { disconnectStream(); setConnection('paused', _manualPaused ? 'Paused' : 'Paused in background'); }
  else connectStream();
});
window.addEventListener('beforeunload', disconnectStream);

fetch('/dashboard/api/logs?limit=200', { cache: 'no-store' })
  .then(function(response) { if (!response.ok) throw new Error('Logs unavailable'); return response.json(); })
  .then(function(entries) {
    _loaded = true;
    if (Array.isArray(entries)) entries.forEach(queueEntry);
    flushPending();
    connectStream();
  })
  .catch(function() {
    _loaded = true;
    _emptyMessage = 'Recent messages unavailable. Waiting for the live stream...';
    updateSummary();
    connectStream();
  });

function toggleTheme() {
  var theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('twilio-theme', theme);
}

var _reviewCheckRunning = false;
async function pollReviewCount() {
  if (document.hidden || _reviewCheckRunning) return;
  _reviewCheckRunning = true;
  try {
    var response = await fetch('/dashboard/api/review-count');
    if (!response.ok) return;
    var data = await response.json();
    var count = Math.max(0, Number(data && data.count) || 0);
    document.body.classList.toggle('review-pending', count > 0);
    document.getElementById('logsReviewNotice').hidden = count === 0;
    document.getElementById('logsReviewCount').textContent = count.toLocaleString()
      + (count === 1 ? ' portrait pending review' : ' portraits pending review');
  } catch (_) {} finally { _reviewCheckRunning = false; }
}
pollReviewCount();
setInterval(pollReviewCount, 10000);
</script>
${userBar}
${magicHat}
</body>
</html>`;
}

module.exports = { renderLogsPage };

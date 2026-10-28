(() => {
  "use strict";

  const VIEWS = ["messaging", "leads", "kiosk", "followups"];
  const LISTS = {
    messaging: { endpoint: "api/users", key: "users", body: "userList", count: "usersCount", noun: "recipient" },
    leads: { endpoint: "api/leads", key: "leads", body: "leadTableBody", count: "leadsCount", noun: "lead" },
    kiosk: { endpoint: "api/kiosk-submissions", key: "kiosk", body: "kioskSubsBody", count: "kioskCount", noun: "submission" },
    followups: { endpoint: "api/drop-offs", key: "followups", body: "dropoffList", count: "followupsCount", noun: "visit" },
  };
  const $ = (id) => document.getElementById(id);
  const makeList = () => ({ items: [], total: 0, page: 1, pages: 1, limit: 25, q: "", loaded: false, stamp: 0, seq: 0, controller: null, timer: null });
  const state = {
    event: "", view: "messaging", generation: 0, selectedIds: new Set(),
    lists: { messaging: makeList(), leads: makeList(), kiosk: makeList(), followups: makeList() },
    raffle: { items: [], total: 0, controller: null, seq: 0 },
    activeUserId: null,
  };

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function relativeTime(ts) {
    if (!ts) return "—";
    const minutes = Math.max(0, Math.floor((Date.now() - ts) / 60000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + "m ago";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + "h ago";
    return Math.floor(hours / 24) + "d ago";
  }

  function countText(total, noun) {
    return total.toLocaleString() + " " + noun + (total === 1 ? "" : "s");
  }

  function pageQuery(list) {
    const query = new URLSearchParams({ paged: "1", event: state.event || "all", page: String(list.page), limit: String(list.limit) });
    if (list.q) query.set("q", list.q);
    return "?" + query.toString();
  }

  function showLoading(view) {
    const list = state.lists[view];
    if (list.loaded) return;
    const cfg = LISTS[view];
    if (view === "messaging" || view === "followups") {
      $(cfg.body).innerHTML = '<div class="list-state">Loading ' + cfg.noun + 's…</div>';
    } else {
      $(cfg.body).innerHTML = '<tr><td colspan="' + (view === "kiosk" ? 7 : 6) + '" class="table-state">Loading ' + cfg.noun + 's…</td></tr>';
    }
  }

  function showError(view, message) {
    const cfg = LISTS[view];
    const safe = escapeHtml(message || "Unable to load this list");
    const html = '<div class="list-state">' + safe + '<br><button type="button" class="empty-action" data-retry="' + view + '">Try again</button></div>';
    if (view === "messaging" || view === "followups") $(cfg.body).innerHTML = html;
    else $(cfg.body).innerHTML = '<tr><td colspan="' + (view === "kiosk" ? 7 : 6) + '" class="table-state">' + safe + '<br><button type="button" class="empty-action" data-retry="' + view + '">Try again</button></td></tr>';
  }

  async function loadList(view, { silent = false } = {}) {
    const cfg = LISTS[view];
    const list = state.lists[view];
    if (list.controller) list.controller.abort();
    const controller = new AbortController();
    list.controller = controller;
    const seq = ++list.seq;
    const generation = state.generation;
    const event = state.event;
    if (!silent) showLoading(view);
    try {
      const response = await fetch(cfg.endpoint + pageQuery(list), { signal: controller.signal });
      if (!response.ok) throw new Error("The list could not be loaded (" + response.status + ")");
      const data = await response.json();
      if (generation !== state.generation || seq !== list.seq || event !== state.event) return;
      list.items = Array.isArray(data.items) ? data.items : [];
      list.total = Number(data.total) || 0;
      list.page = Number(data.page) || 1;
      list.pages = Number(data.pages) || 1;
      list.limit = Number(data.limit) || 25;
      list.loaded = true;
      list.stamp = Date.now();
      $(cfg.count).textContent = countText(list.total, cfg.noun);
      if (view === "messaging") $("drawButton").disabled = list.total === 0;
      renderList(view);
      renderPager(view);
    } catch (error) {
      if (error.name === "AbortError") return;
      if (generation !== state.generation || seq !== list.seq) return;
      console.error(error);
      if (!silent || !list.loaded) {
        list.loaded = false;
        showError(view, error.message);
      }
    } finally {
      if (list.controller === controller) list.controller = null;
    }
  }

  function renderList(view) {
    if (view === "messaging") renderUsers();
    else if (view === "leads") renderLeads();
    else if (view === "kiosk") renderKiosk();
    else renderFollowups();
  }

  function renderPager(view) {
    const list = state.lists[view];
    const holder = $("pager-" + LISTS[view].key);
    const from = list.total ? (list.page - 1) * list.limit + 1 : 0;
    const to = Math.min(list.total, list.page * list.limit);
    holder.innerHTML = '<span>Showing ' + from.toLocaleString() + '–' + to.toLocaleString() + ' of ' + list.total.toLocaleString() + '</span>'
      + '<div class="pager-controls"><button type="button" data-page="previous"' + (list.page <= 1 ? ' disabled' : '') + '>Previous</button>'
      + '<span>Page ' + list.page + ' of ' + list.pages + '</span>'
      + '<button type="button" data-page="next"' + (list.page >= list.pages ? ' disabled' : '') + '>Next</button></div>';
  }

  function renderUsers() {
    const users = state.lists.messaging.items;
    if (!users.length) {
      $("userList").innerHTML = '<div class="list-state">' + (state.lists.messaging.q ? "No recipients match this search." : "No recipients for this event yet.") + '</div>';
      updateSelection();
      return;
    }
    $("userList").innerHTML = users.map((user) => {
      const fullImage = '/photogallery/img/' + escapeHtml(encodeURIComponent(user.lastEvent)) + '/' + escapeHtml(encodeURIComponent(user.lastPrefix)) + '_output.png';
      const thumbImage = 'api/thumbnail/' + escapeHtml(encodeURIComponent(user.lastEvent)) + '/' + escapeHtml(encodeURIComponent(user.lastPrefix));
      const thumb = user.hasThumb && user.lastPrefix && user.lastEvent
        ? '<a class="portrait-link" href="' + fullImage + '" target="_blank" rel="noopener" title="Open latest portrait"><img loading="lazy" decoding="async" width="48" height="48" alt="" src="' + thumbImage + '"></a>'
        : '<span class="portrait-empty">No image</span>';
      const styles = (user.styles || []).slice(0, 3).map((style) => '<span class="style-chip">' + escapeHtml(style) + '</span>').join("");
      return '<div class="recipient-row' + (user.isWinner ? ' is-winner' : '') + '" role="listitem">'
        + '<input type="checkbox" class="user-select" data-id="' + Number(user.id) + '" aria-label="Select ' + escapeHtml(user.name || user.phone) + '"' + (state.selectedIds.has(user.id) ? ' checked' : '') + '>'
        + thumb
        + '<div class="recipient-identity"><span class="recipient-name">' + escapeHtml(user.name || (user.isWinner ? 'Raffle winner' : 'Attendee')) + '</span><span class="recipient-phone">' + escapeHtml(user.phone) + '</span></div>'
        + '<div class="recipient-detail"><strong>' + Number(user.count || 0) + ' portrait' + (user.count === 1 ? '' : 's') + '</strong><span>Active ' + relativeTime(user.lastActive) + '</span></div>'
        + '<div class="style-list">' + styles + '</div>'
        + '<button type="button" class="row-menu-button" data-user-menu="' + Number(user.id) + '" aria-label="Actions for ' + escapeHtml(user.name || user.phone) + '">⋮</button></div>';
    }).join("");
    updateSelection();
  }

  function updateSelection() {
    const count = state.selectedIds.size;
    const checkboxes = [...document.querySelectorAll("#userList .user-select")];
    const checked = checkboxes.filter((box) => box.checked).length;
    const elsewhere = Math.max(0, count - checked);
    $("selectionStatus").textContent = count
      ? countText(count, "selected recipient") + (elsewhere ? " · " + elsewhere + " on other pages or filters" : "")
      : "None selected";
    $("selAll").checked = checkboxes.length > 0 && checked === checkboxes.length;
    $("selAll").indeterminate = checked > 0 && checked < checkboxes.length;
    $("deleteSelectedButton").hidden = count === 0;
    const send = $("sendButton");
    send.disabled = count === 0 || !$("msgBox").value.trim();
    send.textContent = count ? "Send to " + countText(count, "recipient") : "Select recipients to send";
  }

  function renderLeads() {
    const leads = state.lists.leads.items;
    if (!leads.length) {
      $("leadTableBody").innerHTML = '<tr><td colspan="6" class="table-state">' + (state.lists.leads.q ? "No leads match this search." : "No leads captured for this event yet.") + '</td></tr>';
      return;
    }
    $("leadTableBody").innerHTML = leads.map((lead) => '<tr>'
      + '<td data-label="Name" class="name-cell">' + escapeHtml([lead.firstName, lead.lastName].filter(Boolean).join(" ") || "—") + '</td>'
      + '<td data-label="Work email">' + escapeHtml(lead.email || "—") + '</td><td data-label="Personal email">' + escapeHtml(lead.personalEmail || "—") + '</td>'
      + '<td data-label="Company">' + escapeHtml(lead.company || "—") + '</td><td data-label="Title">' + escapeHtml(lead.jobTitle || "—") + '</td><td data-label="Country">' + escapeHtml(lead.country || "—") + '</td></tr>').join("");
  }

  function renderKiosk() {
    const items = state.lists.kiosk.items;
    if (!items.length) {
      $("kioskSubsBody").innerHTML = '<tr><td colspan="7" class="table-state">' + (state.lists.kiosk.q ? "No submissions match this search." : "No kiosk submissions for this event yet.") + '</td></tr>';
      return;
    }
    $("kioskSubsBody").innerHTML = items.map((item, index) => {
      const imageUrl = '/photogallery/img/' + escapeHtml(encodeURIComponent(item.event)) + '/' + escapeHtml(encodeURIComponent(item.filePrefix)) + '_output.png';
      const thumbUrl = 'api/thumbnail/' + escapeHtml(encodeURIComponent(item.event)) + '/' + escapeHtml(encodeURIComponent(item.filePrefix));
      return '<tr data-index="' + index + '"><td class="kiosk-image-cell" data-label="Portrait"><a href="' + imageUrl + '" target="_blank" rel="noopener" title="Open full portrait"><img class="kiosk-thumb" src="' + thumbUrl + '" alt="" width="52" height="52" loading="lazy" decoding="async"></a></td>'
        + '<td data-label="Phone">' + escapeHtml(item.phone || "—") + '</td>'
        + '<td data-label="Email"><label class="sr-only" for="kiosk-email-' + index + '">Email for submission ' + (index + 1) + '</label><input class="kiosk-email" id="kiosk-email-' + index + '" type="email" value="' + escapeHtml(item.email || "") + '" placeholder="Add email" autocomplete="off"></td>'
        + '<td data-label="Style">' + escapeHtml(item.style || "—") + '</td><td data-label="Submitted">' + (item.submittedAt ? escapeHtml(new Date(item.submittedAt).toLocaleString()) : "—") + '</td>'
        + '<td data-label="Emailed"><input class="kiosk-emailed" type="checkbox" aria-label="Mark submission ' + (index + 1) + ' emailed"' + (item.emailedAt ? ' checked' : '') + '></td>'
        + '<td data-label="Actions"><button type="button" class="icon-button kiosk-dismiss" title="Remove contact record" aria-label="Remove contact record">×</button></td></tr>';
    }).join("");
    $("kioskSubsBody").querySelectorAll(".kiosk-thumb").forEach((img) => {
      img.addEventListener("error", () => {
        const replacement = document.createElement("span");
        replacement.className = "kiosk-placeholder";
        replacement.textContent = "No image";
        img.parentElement.replaceWith(replacement);
      }, { once: true });
    });
  }

  function renderFollowups() {
    const items = state.lists.followups.items;
    if (!items.length) {
      $("dropoffList").innerHTML = '<div class="list-state">' + (state.lists.followups.q ? "No visits match this search." : "No unfinished visits for this event.") + '</div>';
      return;
    }
    $("dropoffList").innerHTML = items.map((item, index) => '<div class="followup-row" role="listitem" data-index="' + index + '">'
      + '<div><strong>' + escapeHtml(item.phone) + '</strong><span>Texted ' + relativeTime(item.firstContactAt) + '</span></div>'
      + '<div><span>' + (item.nudgedAt ? 'Last nudged ' + relativeTime(item.nudgedAt) : 'No follow-up sent') + '</span></div>'
      + '<div class="followup-actions"><button type="button" class="secondary-button" data-followup="nudge">' + (item.nudgedAt ? 'Nudge again' : 'Send nudge') + '</button><button type="button" class="icon-button" data-followup="dismiss" aria-label="Dismiss ' + escapeHtml(item.phone) + '" title="Dismiss visit">×</button></div></div>').join("");
  }

  async function loadRaffle() {
    if (state.raffle.controller) state.raffle.controller.abort();
    const controller = new AbortController();
    state.raffle.controller = controller;
    const seq = ++state.raffle.seq;
    const generation = state.generation;
    try {
      const query = new URLSearchParams({ paged: "1", event: state.event || "all", page: "1", limit: "5" });
      const response = await fetch("api/raffle?" + query, { signal: controller.signal });
      if (!response.ok) throw new Error("Could not load raffle history");
      const data = await response.json();
      if (generation !== state.generation || seq !== state.raffle.seq) return;
      state.raffle.items = data.items || [];
      state.raffle.total = Number(data.total) || 0;
      $("winnerCount").textContent = countText(state.raffle.total, "winner");
      $("winnerList").innerHTML = state.raffle.items.length
        ? state.raffle.items.map((winner) => '<div class="winner-entry"><span>' + escapeHtml(winner.maskedPhone) + '</span><small>' + escapeHtml(winner.event === "all" ? "All events" : winner.event || "") + ' · ' + relativeTime(winner.timestamp) + '</small></div>').join("")
        : '<div class="list-state">No winners yet</div>';
    } catch (error) {
      if (error.name !== "AbortError" && generation === state.generation) $("winnerList").innerHTML = '<div class="list-state">Could not load winners</div>';
    } finally {
      if (state.raffle.controller === controller) state.raffle.controller = null;
    }
  }

  function setView(view, { focus = false } = {}) {
    if (!VIEWS.includes(view)) return;
    state.view = view;
    for (const name of VIEWS) {
      const active = name === view;
      const tab = $("tab-" + name);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      $("view-" + name).hidden = !active;
    }
    if (focus) $("tab-" + view).focus();
    const url = new URL(window.location.href);
    if (view === "messaging") url.searchParams.delete("view");
    else url.searchParams.set("view", view);
    history.replaceState(null, "", url);
    const list = state.lists[view];
    if (state.event && (!list.loaded || Date.now() - list.stamp > 30000)) loadList(view);
    if (state.event && view === "messaging") loadRaffle();
  }

  function changeEvent() {
    state.event = $("evSel").value;
    state.generation++;
    state.selectedIds.clear();
    closeUserMenu();
    $("raffleDisplay").hidden = true;
    for (const name of VIEWS) {
      const list = state.lists[name];
      if (list.controller) list.controller.abort();
      list.seq++;
      list.items = [];
      list.total = 0;
      list.page = 1;
      list.loaded = false;
      $(LISTS[name].count).textContent = "Load this view to see " + LISTS[name].noun + "s";
      $("pager-" + LISTS[name].key).innerHTML = "";
    }
    if (state.raffle.controller) state.raffle.controller.abort();
    state.raffle.seq++;
    $("drawButton").disabled = true;
    $("winnerList").innerHTML = '<div class="list-state">Loading winners…</div>';
    updateSelection();
    loadList(state.view);
    if (state.view === "messaging") loadRaffle();
  }

  async function loadEvents() {
    try {
      const response = await fetch("api/events");
      if (!response.ok) throw new Error("Could not load events");
      const data = await response.json();
      const select = $("evSel");
      select.replaceChildren();
      select.add(new Option("All events", "all"));
      for (const event of data.events || []) select.add(new Option(event, event));
      select.value = data.currentEvent && [...select.options].some((option) => option.value === data.currentEvent) ? data.currentEvent : "all";
      changeEvent();
    } catch (error) {
      console.error(error);
      $("evSel").innerHTML = '<option value="all">All events</option>';
      changeEvent();
    }
  }

  function debounceSearch(view, value) {
    const list = state.lists[view];
    list.q = value.trim();
    list.page = 1;
    clearTimeout(list.timer);
    list.timer = setTimeout(() => loadList(view), 250);
  }

  function closeUserMenu() {
    $("userMenu").hidden = true;
    state.activeUserId = null;
  }

  function openUserMenu(button, id) {
    const user = state.lists.messaging.items.find((item) => item.id === id);
    if (!user) return;
    state.activeUserId = id;
    $("userMenuLabel").textContent = user.name || user.phone;
    const menu = $("userMenu");
    menu.hidden = false;
    const rect = button.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.left - 185, window.innerWidth - menu.offsetWidth - 8)) + "px";
    menu.style.top = (rect.bottom + menu.offsetHeight + 8 <= window.innerHeight ? rect.bottom + 5 : rect.top - menu.offsetHeight - 5) + "px";
    menu.querySelector("button").focus();
  }

  async function deleteUsers(ids, scope = "all") {
    if (!ids.length) return;
    const event = state.event;
    const label = scope === "photos" ? "photos and job history" : scope === "lead" ? "lead data" : "all data";
    const ok = await twModal.confirm({ title: "Delete " + label + "?", message: "This removes data for " + countText(ids.length, "recipient") + ". This cannot be undone.", confirmText: "Delete", danger: true });
    if (!ok || event !== state.event) return;
    try {
      const response = await fetch("api/users", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, event, scope }) });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "Delete failed");
      ids.forEach((id) => state.selectedIds.delete(id));
      state.lists.leads.loaded = false;
      state.lists.kiosk.loaded = false;
      state.lists.followups.loaded = false;
      if (event === state.event) await loadList("messaging");
    } catch (error) {
      await twModal.alert({ title: "Delete failed", message: error.message });
    }
  }

  async function sendMessage() {
    const ids = [...state.selectedIds];
    const message = $("msgBox").value.trim();
    const event = state.event;
    if (!ids.length || !message) return;
    const ok = await twModal.confirm({ title: "Send message?", message: "Deliver this message to " + countText(ids.length, "recipient") + ".", confirmText: "Send" });
    if (!ok) return;
    if (event !== state.event) return;
    const button = $("sendButton");
    button.disabled = true;
    button.textContent = "Sending…";
    const result = $("sendResult");
    result.hidden = true;
    try {
      const response = await fetch("api/send-message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, message, event }) });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "Message delivery failed");
      result.className = "action-result";
      result.textContent = "Sent to " + countText(data.sent, "recipient") + (data.failed ? "; " + data.failed + " failed" : "") + ".";
      result.hidden = false;
      $("msgBox").value = "";
      updateCharCount();
    } catch (error) {
      result.className = "action-result error";
      result.textContent = error.message;
      result.hidden = false;
    } finally {
      updateSelection();
    }
  }

  async function drawWinner() {
    const button = $("drawButton");
    button.disabled = true;
    button.textContent = "Drawing…";
    const event = state.event;
    try {
      const response = await fetch("api/raffle/draw", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event }) });
      const winner = await response.json();
      if (!response.ok || winner.error) throw new Error(winner.error || "Could not draw a winner");
      if (event !== state.event) return;
      state.selectedIds.add(winner.id);
      const visibleWinner = state.lists.messaging.items.find((user) => user.id === winner.id);
      if (visibleWinner) visibleWinner.isWinner = true;
      renderUsers();
      const display = $("raffleDisplay");
      display.textContent = "Winner: " + winner.maskedPhone + ". Selected for messaging.";
      display.hidden = false;
      loadRaffle();
    } catch (error) {
      await twModal.alert({ title: "Raffle draw failed", message: error.message });
    } finally {
      button.disabled = false;
      button.textContent = "Draw a winner";
    }
  }

  function updateCharCount() {
    const length = $("msgBox").value.length;
    const segments = Math.ceil(length / 160);
    $("charCount").textContent = length + " character" + (length === 1 ? "" : "s") + (segments > 1 ? " · " + segments + " SMS segments" : "");
    updateSelection();
  }

  async function deleteAllLeads() {
    if (!state.event || state.event === "all") {
      await twModal.alert({ title: "Choose an event", message: "Select one event before deleting leads." });
      return;
    }
    const event = state.event;
    const ok = await twModal.confirm({ title: "Delete all leads for " + event + "?", message: "Photos and job history will remain. This cannot be undone.", confirmText: "Delete all leads", danger: true });
    if (!ok || event !== state.event) return;
    const button = $("deleteLeadsButton");
    button.disabled = true;
    try {
      const response = await fetch("api/leads", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event }) });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "Delete failed");
      state.lists.messaging.loaded = false;
      if (event === state.event) await loadList("leads");
    } catch (error) {
      await twModal.alert({ title: "Delete failed", message: error.message });
    } finally {
      button.disabled = false;
    }
  }

  function kioskItemFor(target) {
    const row = target.closest("tr[data-index]");
    return row ? state.lists.kiosk.items[Number(row.dataset.index)] : null;
  }

  async function saveKioskEmail(input) {
    const item = kioskItemFor(input);
    if (!item) return;
    const original = item.email || "";
    const next = input.value.trim();
    if (next === original) return;
    input.disabled = true;
    try {
      const response = await fetch("api/kiosk-submissions/email", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filePrefix: item.filePrefix, event: item.event, email: next }) });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "Could not save email");
      item.email = next;
    } catch (error) {
      input.value = original;
      await twModal.alert({ title: "Could not save email", message: error.message });
    } finally {
      input.disabled = false;
    }
  }

  async function toggleKioskEmailed(checkbox) {
    const item = kioskItemFor(checkbox);
    if (!item) return;
    checkbox.disabled = true;
    try {
      const response = await fetch("api/kiosk-submissions/emailed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filePrefix: item.filePrefix, event: item.event, emailed: checkbox.checked }) });
      if (!response.ok) throw new Error("Could not update emailed status");
      item.emailedAt = checkbox.checked ? Date.now() : null;
    } catch (error) {
      checkbox.checked = !checkbox.checked;
      await twModal.alert({ title: "Update failed", message: error.message });
    } finally {
      checkbox.disabled = false;
    }
  }

  async function dismissKiosk(item) {
    const selectedEvent = state.event;
    const ok = await twModal.confirm({ title: "Remove kiosk contact?", message: "The generated portrait and job will remain.", confirmText: "Remove", danger: true });
    if (!ok || selectedEvent !== state.event) return;
    try {
      const response = await fetch("api/kiosk-submissions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filePrefix: item.filePrefix, event: item.event }) });
      if (!response.ok) throw new Error("Could not remove contact");
      await loadList("kiosk");
    } catch (error) {
      await twModal.alert({ title: "Remove failed", message: error.message });
    }
  }

  async function actOnFollowup(action, item, button) {
    const event = state.event;
    const ok = await twModal.confirm(action === "nudge"
      ? { title: "Send nudge?", message: "Send a follow-up message to " + item.phone + "?", confirmText: "Send nudge" }
      : { title: "Dismiss visit?", message: "This visit will return if the attendee texts again.", confirmText: "Dismiss" });
    if (!ok || event !== state.event) return;
    button.disabled = true;
    try {
      const response = await fetch(action === "nudge" ? "api/nudge" : "api/drop-offs", { method: action === "nudge" ? "POST" : "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: item.id, event }) });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error || "Action failed");
      if (event === state.event) await loadList("followups");
    } catch (error) {
      await twModal.alert({ title: action === "nudge" ? "Nudge failed" : "Dismiss failed", message: error.message });
    } finally {
      button.disabled = false;
    }
  }

  async function pollReviews() {
    if (document.hidden) return;
    try {
      const response = await fetch("/dashboard/api/review-count");
      if (!response.ok) return;
      const data = await response.json();
      const count = Number(data.count) || 0;
      $("reviewNotify").hidden = count === 0;
      $("reviewNotifyText").textContent = countText(count, "portrait") + " waiting for review";
      document.body.classList.toggle("review-pending", count > 0);
    } catch { /* Non-critical badge. */ }
  }

  function bind() {
    $("evSel").addEventListener("change", changeEvent);
    $("themeButton").addEventListener("click", () => {
      const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      localStorage.setItem("twilio-theme", next);
    });
    $("msgBox").addEventListener("input", updateCharCount);
    $("sendButton").addEventListener("click", sendMessage);
    $("drawButton").addEventListener("click", drawWinner);
    $("deleteSelectedButton").addEventListener("click", () => deleteUsers([...state.selectedIds]));
    $("deleteLeadsButton").addEventListener("click", deleteAllLeads);
    $("exportButton").addEventListener("click", () => {
      window.location.href = "api/leads/export?event=" + encodeURIComponent(state.event || "all");
    });
    $("selAll").addEventListener("change", (event) => {
      for (const user of state.lists.messaging.items) {
        if (event.target.checked) state.selectedIds.add(user.id);
        else state.selectedIds.delete(user.id);
      }
      renderUsers();
    });
    $("userList").addEventListener("change", (event) => {
      if (!event.target.matches(".user-select")) return;
      const id = Number(event.target.dataset.id);
      if (event.target.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
      updateSelection();
    });
    $("userList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-user-menu]");
      if (button) { event.stopPropagation(); openUserMenu(button, Number(button.dataset.userMenu)); }
    });
    $("userMenu").addEventListener("click", (event) => {
      const button = event.target.closest("[data-scope]");
      if (!button) return;
      const id = state.activeUserId;
      closeUserMenu();
      if (id != null) deleteUsers([id], button.dataset.scope);
    });
    document.addEventListener("click", (event) => { if (!event.target.closest("#userMenu, [data-user-menu]")) closeUserMenu(); });
    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeUserMenu(); });
    $("kioskSubsBody").addEventListener("focusout", (event) => { if (event.target.matches(".kiosk-email")) saveKioskEmail(event.target); });
    $("kioskSubsBody").addEventListener("keydown", (event) => {
      if (!event.target.matches(".kiosk-email")) return;
      if (event.key === "Enter") { event.preventDefault(); event.target.blur(); }
      if (event.key === "Escape") {
        const item = kioskItemFor(event.target);
        if (item) event.target.value = item.email || "";
        event.target.blur();
      }
    });
    $("kioskSubsBody").addEventListener("change", (event) => { if (event.target.matches(".kiosk-emailed")) toggleKioskEmailed(event.target); });
    $("kioskSubsBody").addEventListener("click", (event) => {
      if (!event.target.matches(".kiosk-dismiss")) return;
      const item = kioskItemFor(event.target);
      if (item) dismissKiosk(item);
    });
    $("dropoffList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-followup]");
      if (!button) return;
      const row = button.closest("[data-index]");
      const item = row && state.lists.followups.items[Number(row.dataset.index)];
      if (item) actOnFollowup(button.dataset.followup, item, button);
    });
    for (const view of VIEWS) {
      $("tab-" + view).addEventListener("click", () => setView(view));
      $("search-" + LISTS[view].key).addEventListener("input", (event) => debounceSearch(view, event.target.value));
      $("pager-" + LISTS[view].key).addEventListener("click", (event) => {
        const button = event.target.closest("[data-page]");
        if (!button || button.disabled) return;
        const list = state.lists[view];
        list.page += button.dataset.page === "next" ? 1 : -1;
        loadList(view);
      });
    }
    $("userList").addEventListener("click", retryClick);
    $("leadTableBody").addEventListener("click", retryClick);
    $("kioskSubsBody").addEventListener("click", retryClick);
    $("dropoffList").addEventListener("click", retryClick);
    $("tab-messaging").parentElement.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const index = VIEWS.indexOf(state.view);
      const next = event.key === "Home" ? 0 : event.key === "End" ? VIEWS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + VIEWS.length) % VIEWS.length;
      event.preventDefault();
      setView(VIEWS[next], { focus: true });
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        if (Date.now() - state.lists[state.view].stamp > 30000) loadList(state.view, { silent: true });
        pollReviews();
      }
    });
  }

  function retryClick(event) {
    const button = event.target.closest("[data-retry]");
    if (button) loadList(button.dataset.retry);
  }

  function start() {
    bind();
    const initialView = new URLSearchParams(window.location.search).get("view");
    if (VIEWS.includes(initialView)) setView(initialView);
    loadEvents();
    pollReviews();
    setInterval(() => {
      if (document.hidden || !state.event) return;
      if (state.view === "messaging" || state.view === "followups") {
        loadList(state.view, { silent: true });
        if (state.view === "messaging") loadRaffle();
      }
    }, 30000);
    setInterval(pollReviews, 15000);
  }

  start();
})();

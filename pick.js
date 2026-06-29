// Camp VC planner - picks page.
(function () {
  "use strict";
  var schedule = window.SCHEDULE;
  var CONFIG = window.CONFIG;
  var acts = schedule.activities;

  var state = { name: "", picks: {}, savedPicks: {}, loading: false, expanded: {} };
  var DRAFT_KEY = "campvc_draft"; // per-tab session cache so tabbing between views keeps edits

  var $ = function (id) { return document.getElementById(id); };
  function fmt(m) { var h = Math.floor(m / 60), x = m % 60; return (h < 10 ? "0" : "") + h + ":" + (x < 10 ? "0" : "") + x; }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  if (window.Store.isLocal) $("localFlag").hidden = false;

  // Populate name dropdown
  (CONFIG.friends || []).forEach(function (n) {
    var o = el("option"); o.value = n; o.textContent = n; $("who").appendChild(o);
  });

  // Categories (primary grouping = first tag) + filter options
  var allCats = {};
  acts.forEach(function (a) { (a.categories || []).forEach(function (c) { allCats[c] = (allCats[c] || 0) + 1; }); });
  Object.keys(allCats).sort().forEach(function (c) {
    var o = el("option"); o.value = c; o.textContent = c; $("fCat").appendChild(o);
  });
  schedule.days.forEach(function (d) { var o = el("option"); o.value = d; o.textContent = d; $("fDay").appendChild(o); });

  function primaryCat(a) { return (a.categories && a.categories[0]) || "Other"; }

  function daysOf(a) {
    var s = {};
    (a.kind === "dropin" ? (a.windows || []) : (a.instances || [])).forEach(function (i) { s[i.day] = 1; });
    return Object.keys(s);
  }

  function locationsOf(a) {
    var s = {};
    (a.instances || []).forEach(function (i) { if (i.location) s[i.location] = 1; });
    (a.windows || []).forEach(function (w) { if (w.location) s[w.location] = 1; });
    return Object.keys(s);
  }

  function detail(a) {
    var bits = [];
    var locs = locationsOf(a);
    if (locs.length) bits.push(esc(locs.slice(0, 2).join(" / ")));
    if (a.kind === "repeating") {
      bits.push(a.instances.length + " sessions (" + daysOf(a).map(function (d) { return d.slice(0, 3); }).join(", ") + ")");
    } else if (a.kind === "oneoff") {
      bits.push(esc(a.instances[0].label));
    } else {
      bits.push("Drop in - " + daysOf(a).map(function (d) { return d.slice(0, 3); }).join(", "));
    }
    return bits.join(" &middot; ");
  }

  function badges(a) {
    var b = "";
    if (a.paid) b += '<span class="badge paid">Paid</span>';
    else b += '<span class="badge">Free</span>';
    if (a.offsite) b += '<span class="badge off">Off-site</span>';
    if (a.external) b += '<span class="badge off">Books off-app</span>';
    if (a.kind === "repeating") b += '<span class="badge rep">Repeats &times;' + a.instances.length + '</span>';
    if (a.kind === "dropin") b += '<span class="badge drop">Drop-in &middot; just turn up</span>';
    if (a.maxPerSession && a.maxPerSession > 0 && a.maxPerSession <= 12) b += '<span class="badge lim">Limited &middot; ' + a.maxPerSession + '/session</span>';
    return b;
  }

  function bookingNote(a) {
    if (a.kind === "dropin") return "Just turn up - no booking needed.";
    if (a.external) return "Book OFF-APP via the partner link" + (a.paid ? " (paid, opens 4 July)" : " (opens 11 July)") +
      ". 'Add to schedule' in the app does NOT secure your space - complete the third-party booking first.";
    return a.paid ? "Paid - books in the app, phase 1 (from 4 July)." : "Included - books in the app, phase 2 (from 11 July).";
  }

  function matches(a) {
    var q = $("search").value.trim().toLowerCase();
    if (q) {
      var hay = (a.name + " " + locationsOf(a).join(" ") + " " + (a.categories || []).join(" ") + " " + (a.description || "")).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    var fc = $("fCat").value; if (fc && (a.categories || []).indexOf(fc) === -1) return false;
    var fd = $("fDay").value; if (fd && daysOf(a).indexOf(fd) === -1) return false;
    var fk = $("fKind").value;
    if (fk === "paid" && !a.paid) return false;
    if (fk === "free" && a.paid) return false;
    if (fk === "repeating" && a.kind !== "repeating") return false;
    if (fk === "oneoff" && a.kind !== "oneoff") return false;
    if (fk === "dropin" && a.kind !== "dropin") return false;
    return true;
  }

  function render() {
    var list = $("list");
    list.innerHTML = "";
    var shown = acts.filter(matches);
    if (!state.name) {
      list.appendChild(el("div", "empty", "Choose your name above to start picking."));
      return;
    }
    if (!shown.length) { list.appendChild(el("div", "empty", "No activities match those filters.")); return; }

    // Group by primary category
    var groups = {};
    shown.forEach(function (a) { (groups[primaryCat(a)] = groups[primaryCat(a)] || []).push(a); });
    Object.keys(groups).sort().forEach(function (cat) {
      var picked = groups[cat].filter(function (a) { return state.picks[a.id]; }).length;
      var d = el("details", "cat"); d.open = !!$("fCat").value || !!$("search").value.trim();
      var sum = el("summary");
      sum.innerHTML = esc(cat) + ' <span class="count">' + picked + " picked / " + groups[cat].length + "</span>";
      d.appendChild(sum);
      groups[cat].forEach(function (a) { d.appendChild(activityRow(a)); });
      list.appendChild(d);
    });
  }

  function activityRow(a) {
    var frag = document.createDocumentFragment();
    var row = el("div", "act");
    var meta = el("div", "meta");
    var info = a.description ? ' <button class="infobtn" type="button" title="More details">&#9432;</button>' : "";
    meta.innerHTML = '<div class="nm">' + esc(a.name) + badges(a) + info + "</div><div class=\"det\">" + detail(a) + "</div>";
    row.appendChild(meta);

    var seg = el("div", "seg");
    [["iffree", "If free"], ["want", "Want"], ["must", "Must"]].forEach(function (pair) {
      var btn = el("button"); btn.textContent = pair[1]; btn.dataset.v = pair[0];
      btn.setAttribute("aria-pressed", state.picks[a.id] === pair[0] ? "true" : "false");
      btn.addEventListener("click", function () {
        if (state.picks[a.id] === pair[0]) delete state.picks[a.id];
        else state.picks[a.id] = pair[0];
        seg.querySelectorAll("button").forEach(function (b) {
          b.setAttribute("aria-pressed", state.picks[a.id] === b.dataset.v ? "true" : "false");
        });
        updateCount(); afterEdit();
        var det = row.closest("details");
        if (det) {
          var picked = det.querySelectorAll('.seg button[aria-pressed="true"]').length;
          var total = det.querySelectorAll(".act").length;
          det.querySelector(".count").textContent = picked + " picked / " + total;
        }
      });
      seg.appendChild(btn);
    });
    row.appendChild(seg);
    frag.appendChild(row);

    // Collapsible details panel (description + booking info). Inline, so no
    // navigation and no state is lost; expanded state is remembered per activity.
    if (a.description) {
      var panel = el("div", "actdetails");
      panel.hidden = !state.expanded[a.id];
      panel.innerHTML = '<div class="bnote">' + esc(bookingNote(a)) + "</div><p>" + esc(a.description) + "</p>";
      meta.querySelector(".infobtn").addEventListener("click", function () {
        state.expanded[a.id] = panel.hidden;  // toggle
        panel.hidden = !panel.hidden;
      });
      frag.appendChild(panel);
    }
    return frag;
  }

  function pickedCount() { return Object.keys(state.picks).length; }
  function updateCount() {
    $("pickCount").innerHTML = state.name
      ? "<strong>" + esc(state.name) + "</strong> - " + pickedCount() + " picked"
      : "Pick your name to start.";
  }
  function setStatus(msg, cls) { var s = $("saveStatus"); s.textContent = msg; s.className = "status " + (cls || ""); }

  // ---- draft cache + unsaved-changes flag ----
  function clone(o) { return JSON.parse(JSON.stringify(o || {})); }
  function equalPicks(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(function (k) { return a[k] === b[k]; });
  }
  function isDirty() { return !!state.name && !equalPicks(state.picks, state.savedPicks); }
  function saveDraft() {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ name: state.name, picks: state.picks, savedPicks: state.savedPicks })); }
    catch (e) { /* private mode / disabled storage - draft just won't persist */ }
  }
  function updateDirty() {
    var f = $("dirtyFlag");
    if (isDirty()) {
      f.hidden = false;
      f.textContent = "● Unsaved changes - tap Save so they show on the group calendar";
      $("saveBtn").classList.add("attn");
    } else {
      f.hidden = true;
      $("saveBtn").classList.remove("attn");
    }
  }
  // call after any edit: persist the draft, refresh the flag, keep Save enabled
  function afterEdit() {
    $("saveBtn").disabled = !state.name;
    setStatus("", "");
    saveDraft();
    updateDirty();
  }
  function restoreDraft() {
    var d;
    try { d = JSON.parse(sessionStorage.getItem(DRAFT_KEY)); } catch (e) { d = null; }
    if (!d || !d.name) return false;
    $("who").value = d.name;
    if ($("who").value !== d.name) return false; // name no longer in the configured list
    state.name = d.name;
    state.picks = d.picks || {};
    state.savedPicks = d.savedPicks || {};
    $("saveBtn").disabled = false;
    updateCount(); render(); updateDirty();
    if (isDirty()) setStatus("restored your unsaved changes from this session", "busy");
    return true;
  }

  // Name change -> load that person's saved picks
  $("who").addEventListener("change", function () {
    state.name = this.value;
    if (!state.name) {
      state.picks = {}; state.savedPicks = {};
      sessionStorage.removeItem(DRAFT_KEY);
      updateCount(); render(); updateDirty(); $("saveBtn").disabled = true; return;
    }
    setStatus("loading your saved picks...", "busy");
    state.loading = true;
    window.Store.getPicks().then(function (all) {
      state.picks = all[state.name] ? clone(all[state.name]) : {};
      state.savedPicks = clone(state.picks);
      state.loading = false;
      setStatus(Object.keys(state.picks).length ? "loaded your saved picks" : "", "ok");
      $("saveBtn").disabled = false;
      updateCount(); render(); saveDraft(); updateDirty();
    }).catch(function () {
      state.loading = false;
      state.picks = {}; state.savedPicks = {};
      setStatus("could not load saved picks - starting fresh", "err");
      $("saveBtn").disabled = false;
      updateCount(); render(); saveDraft(); updateDirty();
    });
  });

  ["search", "fCat", "fDay", "fKind"].forEach(function (id) {
    $(id).addEventListener("input", render);
  });

  $("saveBtn").addEventListener("click", function () {
    if (!state.name) return;
    $("saveBtn").disabled = true;
    setStatus("saving...", "busy");
    window.Store.savePicks(state.name, state.picks).then(function (res) {
      $("saveBtn").disabled = false;
      if (res.ok) {
        state.savedPicks = clone(state.picks);
        saveDraft(); updateDirty();
        setStatus("saved - your picks are in. You can close this or keep editing.", "ok");
      } else {
        setStatus("NOT saved - check your connection and tap Save again.", "err");
      }
    });
  });

  // Restore an in-progress session (e.g. after tabbing to the calendar and back);
  // otherwise start fresh.
  if (!restoreDraft()) { updateCount(); render(); }
})();

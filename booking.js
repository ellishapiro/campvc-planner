// Camp VC planner - booking list page.
// A phase-first checklist of exactly what each person needs to book: Phase 1
// (Paid, books first) then Phase 2 (Free, a week later). Tick items off as you
// book them (stored on this device). Drop-ins are listed separately as "just
// turn up - no booking needed".
(function () {
  "use strict";
  var schedule = window.SCHEDULE;
  var CONFIG = window.CONFIG;
  var NAMES = (CONFIG.friends || []).slice();
  var BOOKED_KEY = "campvc_booked";
  var actById = {};
  schedule.activities.forEach(function (a) { actById[a.id] = a; });
  var PRANK = { must: 3, want: 2, iffree: 1 };
  // Scarcity = total places across all sessions; fewer = book sooner. Unlimited
  // (null) sorts last. Used to order each person's list within a phase.
  function scarcity(p) {
    var a = actById[p.activityId];
    return (a && a.totalPlaces != null) ? a.totalPlaces : Infinity;
  }
  function byScarcity(x, y) {
    return (PRANK[y.p.priority] || 0) - (PRANK[x.p.priority] || 0) ||
      scarcity(x.p) - scarcity(y.p) ||
      (x.p.dayIndex - y.p.dayIndex) || (x.p.start_min - y.p.start_min);
  }

  var $ = function (id) { return document.getElementById(id); };
  function el(t, c, h) { var e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  var fmt = window.Engine.fmt;

  var state = { result: null, filter: "", booked: load() };
  function load() { try { return JSON.parse(localStorage.getItem(BOOKED_KEY)) || {}; } catch (e) { return {}; } }
  function persist() { try { localStorage.setItem(BOOKED_KEY, JSON.stringify(state.booked)); } catch (e) {} }
  function keyOf(name, p) { return name + "|" + p.activityId + "|" + p.day + "|" + p.start_min; }

  if (window.Store.isLocal) $("localFlag").hidden = false;
  NAMES.forEach(function (n) { var o = el("option"); o.value = n; o.textContent = "Just " + n; $("who").appendChild(o); });

  Promise.all([window.Store.getPicks(), window.Store.getKnobs()]).then(function (res) {
    var raw = res[0] || {}; var picksByName = {};
    NAMES.forEach(function (n) { picksByName[n] = raw[n] || {}; });
    state.result = window.Engine.compute(schedule, picksByName, res[1] || {}, CONFIG);
    if (!state.result.anyPicks) {
      $("status").innerHTML = "Nobody has saved any picks yet. Start on <a href='index.html'>My picks</a>.";
      return;
    }
    $("status").hidden = true; $("main").hidden = false;
    render();
  }).catch(function (e) { $("status").innerHTML = "Could not load data. Reload to try again. <span class='hint'>(" + esc(e.message) + ")</span>"; });

  $("who").addEventListener("change", function () { state.filter = this.value; render(); });
  $("copyBtn").addEventListener("click", copyList);

  var PHASES = [
    { key: "paid", title: "Phase 1 - Paid (book first)" },
    { key: "free", title: "Phase 2 - Free (book a week later)" },
  ];

  function peopleToShow() { return state.filter ? [state.filter] : NAMES; }

  function render() {
    var c = $("content"); c.innerHTML = "";
    PHASES.forEach(function (ph) {
      var items = []; // {name, p}
      peopleToShow().forEach(function (n) {
        (state.result.byPerson[n][ph.key] || []).forEach(function (p) { items.push({ name: n, p: p }); });
      });
      var sec = el("div", "card");
      var left = items.filter(function (it) { return !state.booked[keyOf(it.name, it.p)]; }).length;
      sec.appendChild(el("h3", null, esc(ph.title) + ' <span class="hint">- ' + left + " still to book / " + items.length + " total</span>"));
      if (!items.length) { sec.appendChild(el("div", "hint", "nothing to book here")); c.appendChild(sec); return; }
      // group by person
      peopleToShow().forEach(function (n) {
        var mine = items.filter(function (it) { return it.name === n; }).sort(byScarcity);
        if (!mine.length) return;
        var grp = el("div", "phase");
        grp.appendChild(el("h4", null, esc(n) + ' <span class="hint">- scarcest first</span>'));
        mine.forEach(function (it) { grp.appendChild(itemRow(it.name, it.p)); });
        sec.appendChild(grp);
      });
      c.appendChild(sec);
    });

    // Drop-ins: not booked, listed for completeness
    var dropItems = [];
    peopleToShow().forEach(function (n) {
      (state.result.byPerson[n].dropins || []).forEach(function (p) { dropItems.push({ name: n, p: p }); });
      (state.result.byPerson[n].ifTime || []).forEach(function (x) { dropItems.push({ name: n, p: { name: x.name, type: "iftime" } }); });
    });
    if (dropItems.length) {
      var d = el("div", "card");
      d.appendChild(el("h3", null, 'Drop-ins <span class="hint">- just turn up, no booking needed</span>'));
      peopleToShow().forEach(function (n) {
        var mine = dropItems.filter(function (it) { return it.name === n; });
        if (!mine.length) return;
        var grp = el("div", "phase"); grp.appendChild(el("h4", null, esc(n)));
        mine.forEach(function (it) {
          var when = it.p.type === "iftime" ? "if you have time" : (it.p.day + " " + fmt(it.p.start_min) + "-" + fmt(it.p.end_min));
          grp.appendChild(el("div", "bk drop", esc(it.p.name) + ' <span class="when">' + when + "</span>"));
        });
        d.appendChild(grp);
      });
      c.appendChild(d);
    }
  }

  function itemRow(name, p) {
    var k = keyOf(name, p);
    var row = el("label", "bkitem");
    var cb = el("input"); cb.type = "checkbox"; cb.checked = !!state.booked[k];
    cb.addEventListener("change", function () {
      if (cb.checked) state.booked[k] = true; else delete state.booked[k];
      persist(); body.classList.toggle("booked", cb.checked); updateCounts();
    });
    var body = el("div", state.booked[k] ? "bkbody booked" : "bkbody");
    var act = actById[p.activityId] || {};
    var withTxt = p.withWhom && p.withWhom.length ? '<span class="with"> &middot; with ' + p.withWhom.map(esc).join(", ") + "</span>" : "";
    var split = p.split ? ' <span class="flag">(split from group)</span>' : "";
    var limited = (act.totalPlaces != null && act.totalPlaces <= 60)
      ? ' <span class="badge lim">limited &middot; ~' + act.totalPlaces + " places</span>" : "";
    var ext = act.external ? '<div class="bnote">Books off-app - via a link in the Guidebook app.</div>' : "";
    var bkp = (p.kind === "repeating" && p.backups && p.backups.length)
      ? '<div class="bkp">if full, backup: ' + p.backups.map(esc).join("; ") + "</div>" : "";
    var dot = p.priority ? '<span class="pri-dot ' + p.priority + '"></span>' : "";
    body.innerHTML = dot + "<strong>" + esc(p.name) + "</strong>" + split + limited +
      '<div class="when">' + p.day + " " + fmt(p.start_min) + "-" + fmt(p.end_min) +
      (p.location ? " &middot; " + esc(p.location) : "") + (p.offsite ? " &middot; off-site" : "") + withTxt + "</div>" + ext + bkp;
    row.appendChild(cb); row.appendChild(body);
    return row;
  }

  function updateCounts() {
    // cheap: re-render headers by re-rendering everything (small page)
    render();
  }

  function copyList() {
    var lines = [];
    PHASES.forEach(function (ph) {
      lines.push("== " + ph.title + " ==");
      peopleToShow().forEach(function (n) {
        var mine = (state.result.byPerson[n][ph.key] || []);
        if (!mine.length) return;
        lines.push(n + ":");
        mine.forEach(function (p) {
          var done = state.booked[keyOf(n, p)] ? "[x] " : "[ ] ";
          var w = p.withWhom && p.withWhom.length ? " (with " + p.withWhom.join(", ") + ")" : "";
          lines.push("  " + done + p.name + " - " + p.day + " " + fmt(p.start_min) + "-" + fmt(p.end_min) +
            (p.location ? " @ " + p.location : "") + w);
        });
      });
      lines.push("");
    });
    var text = lines.join("\n");
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { flash("Copied!"); }, function () { fallbackCopy(text); });
    } else { fallbackCopy(text); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); flash("Copied!"); } catch (e) { flash("Copy failed - select manually"); }
    document.body.removeChild(ta);
  }
  function flash(msg) { var b = $("copyBtn"); var old = b.textContent; b.textContent = msg; setTimeout(function () { b.textContent = old; }, 1500); }
})();

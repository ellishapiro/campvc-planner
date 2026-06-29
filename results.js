// Camp VC planner - group calendar + booking lists + Adjust panel.
(function () {
  "use strict";
  var schedule = window.SCHEDULE;
  var CONFIG = window.CONFIG;
  var NAMES = (CONFIG.friends || []).slice();
  var actById = {};
  schedule.activities.forEach(function (a) { actById[a.id] = a; });

  var $ = function (id) { return document.getElementById(id); };
  function el(t, c, h) { var e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  var fmt = window.Engine.fmt;

  var PX = 1.1; // pixels per minute
  var state = { picksByName: {}, knobs: {}, result: null, day: 0, showRef: false };

  if (window.Store.isLocal) $("localFlag").hidden = false;

  Promise.all([window.Store.getPicks(), window.Store.getKnobs()]).then(function (res) {
    var raw = res[0] || {};
    NAMES.forEach(function (n) { state.picksByName[n] = raw[n] || {}; });
    state.knobs = res[1] || {};
    recompute();
    if (!state.result.anyPicks) {
      $("status").innerHTML = "Nobody has saved any picks yet. Head to <a href='index.html'>My picks</a> to start.";
      return;
    }
    $("status").hidden = true;
    $("main").hidden = false;
    buildDayTabs();
    buildAdjust();
    renderAll();
  }).catch(function (e) {
    $("status").innerHTML = "Could not load data. Reload to try again. <span class='hint'>(" + esc(e.message) + ")</span>";
  });

  function recompute() {
    state.result = window.Engine.compute(schedule, state.picksByName, state.knobs, CONFIG);
  }

  function buildDayTabs() {
    var t = $("dayTabs"); t.innerHTML = "";
    schedule.days.forEach(function (d, i) {
      var b = el("button", i === state.day ? "active" : "", d);
      b.addEventListener("click", function () { state.day = i; renderAll(); });
      t.appendChild(b);
    });
  }

  $("showRef").addEventListener("change", function () { state.showRef = this.checked; renderCalendar(); });

  function renderAll() {
    buildDayTabs();
    renderCalendar();
    renderPeople();
    fixSticky();
  }

  // Pin the day tabs + legend below the header, and the friend-name row below
  // that, by measuring their heights (works on web and mobile).
  function fixSticky() {
    var tb = document.querySelector(".topbar");
    var head = $("calHead");
    if (!tb || !head) return;
    var tbH = tb.offsetHeight;
    document.documentElement.style.setProperty("--calhead-top", tbH + "px");
    document.documentElement.style.setProperty("--colhead-top", (tbH + head.offsetHeight) + "px");
  }
  window.addEventListener("resize", fixSticky);

  // ---------- Calendar ----------
  function renderCalendar() {
    var cal = $("cal");
    cal.innerHTML = "";
    var day = schedule.days[state.day];
    var b = state.result.bounds;
    // Range covers every block on this day (so evening drop-in earmarks show),
    // falling back to the schedule bounds when the day is empty.
    var dayItems = [];
    NAMES.forEach(function (n) {
      var p = state.result.byPerson[n];
      p.all.concat(p.dropins).forEach(function (x) { if (x.day === day) dayItems.push(x); });
    });
    var minS = b.start, maxE = b.end;
    dayItems.forEach(function (x) { if (x.start_min < minS) minS = x.start_min; if (x.end_min > maxE) maxE = x.end_min; });
    var startB = Math.floor(minS / 60) * 60;
    var endB = Math.ceil(maxE / 60) * 60;
    var H = (endB - startB) * PX;

    var cols = "52px repeat(" + NAMES.length + ", minmax(116px,1fr))";
    if (state.showRef) cols += " minmax(170px,1.4fr)";
    cal.style.gridTemplateColumns = cols;

    // Header row
    cal.appendChild(el("div", "colhead time", "Time"));
    NAMES.forEach(function (n) { cal.appendChild(el("div", "colhead", esc(n))); });
    if (state.showRef) cal.appendChild(el("div", "colhead", "Full schedule"));

    // Time column
    var tc = el("div", "timecol"); tc.style.height = H + "px";
    for (var m = startB; m <= endB; m += 60) {
      var y = (m - startB) * PX;
      var line = el("div", "hourline"); line.style.top = y + "px"; tc.appendChild(line);
      var lbl = el("div", "hourlbl", fmt(m)); lbl.style.top = (y + 2) + "px"; tc.appendChild(lbl);
    }
    cal.appendChild(tc);

    // Person columns
    NAMES.forEach(function (n) {
      var col = el("div", "col"); col.style.height = H + "px";
      for (var m2 = startB; m2 <= endB; m2 += 60) {
        var l = el("div", "hourline"); l.style.top = (m2 - startB) * PX + "px"; col.appendChild(l);
      }
      var p = state.result.byPerson[n];
      var items = p.all.concat(p.dropins).filter(function (x) { return x.day === day; });
      items.forEach(function (x) { col.appendChild(blockEl(x, startB)); });
      cal.appendChild(col);
    });

    // Optional full-schedule reference column
    if (state.showRef) {
      var ref = el("div", "col refcol"); ref.style.height = H + "px"; ref.style.overflow = "auto";
      var rows = [];
      schedule.activities.forEach(function (a) {
        (a.instances || []).forEach(function (i) { if (i.day === day) rows.push({ s: i.start_min, a: a, lbl: fmt(i.start_min) + "-" + fmt(i.end_min) }); });
      });
      rows.sort(function (x, y) { return x.s - y.s; });
      rows.forEach(function (r) {
        ref.appendChild(el("div", "ref-item",
          '<span class="t">' + r.lbl + "</span> " + esc(r.a.name) +
          (r.a.paid ? ' <span class="badge paid">£</span>' : "") +
          '<div class="t">' + esc(r.a.location) + "</div>"));
      });
      cal.appendChild(ref);
    }
  }

  function blockEl(x, startB) {
    var cls = "block " + (x.type === "dropin" ? "dropin" : (x.priority || "none"));
    if (x.paid) cls += " paid";
    if (x.split) cls += " split";
    var b = el("div", cls);
    b.style.top = (x.start_min - startB) * PX + "px";
    b.style.height = Math.max((x.end_min - x.start_min) * PX, 22) + "px";
    var withTxt = x.withWhom && x.withWhom.length ? " &middot; with " + x.withWhom.map(esc).join(", ") : "";
    var tag = x.type === "dropin" ? '<span class="droptag">drop-in &middot; flexible</span>' : "";
    b.innerHTML = '<div class="bt">' + esc(x.name) + tag + "</div><div class=\"bm\">" +
      fmt(x.start_min) + "-" + fmt(x.end_min) + (x.type === "dropin" ? " &middot; go anytime around here" : withTxt) + "</div>";
    b.title = x.name + " - " + x.day + " " + fmt(x.start_min) + "-" + fmt(x.end_min) +
      (x.location ? " @ " + x.location : "");
    return b;
  }

  // ---------- People / booking lists ----------
  function renderPeople() {
    var wrap = $("people"); wrap.innerHTML = "";
    NAMES.forEach(function (n) {
      var p = state.result.byPerson[n];
      var hasAny = p.all.length || p.dropins.length || p.ifTime.length || p.dropped.length;
      var card = el("div", "card");
      card.appendChild(el("h3", null, esc(n)));
      if (!hasAny) { card.appendChild(el("div", "hint", "No picks yet.")); wrap.appendChild(card); return; }

      card.appendChild(phaseBlock("Phase 1 - Paid (book first)", p.paid));
      card.appendChild(phaseBlock("Phase 2 - Free (book a week later)", p.free));

      if (p.dropins.length) {
        var dd = el("div", "phase"); dd.appendChild(el("h4", null, "Drop-ins (turn up - time earmarked)"));
        p.dropins.forEach(function (x) {
          dd.appendChild(el("div", "bk drop",
            esc(x.name) + ' <span class="when">' + x.day + " " + fmt(x.start_min) + "-" + fmt(x.end_min) + "</span>"));
        });
        card.appendChild(dd);
      }
      if (p.ifTime.length) {
        card.appendChild(el("div", "phase hint", "Wanted drop-ins with no free gap (turn up if you can squeeze them in): " + p.ifTime.map(function (x) { return esc(x.name); }).join(", ")));
      }
      if (p.dropped.length) {
        // group the couldn't-fit list by priority (must -> want -> if-free) for readability
        var fd = el("div", "phase"); fd.appendChild(el("h4", null, "Couldn't fit (" + p.dropped.length + ")"));
        var order = { must: 0, want: 1, iffree: 2 };
        p.dropped.slice().sort(function (a, b) {
          return (order[a.priority] == null ? 9 : order[a.priority]) - (order[b.priority] == null ? 9 : order[b.priority]);
        }).forEach(function (x) {
          var dot = x.priority ? '<span class="pri-dot ' + x.priority + '"></span>' : "";
          fd.appendChild(el("div", "bk drop", dot + esc(x.name) +
            '<div class="when">' + esc(x.reason) + "</div>"));
        });
        card.appendChild(fd);
      }
      wrap.appendChild(card);
    });
  }

  function phaseBlock(title, items) {
    var d = el("div", "phase");
    d.appendChild(el("h4", null, title + " (" + items.length + ")"));
    if (!items.length) { d.appendChild(el("div", "hint", "nothing here")); return d; }
    items.forEach(function (x) {
      var line = el("div", "bk");
      var dot = x.priority ? '<span class="pri-dot ' + x.priority + '"></span>' : "";
      var withTxt = x.withWhom && x.withWhom.length ? '<div class="with">with ' + x.withWhom.map(esc).join(", ") + "</div>" : "";
      var bkp = (x.kind === "repeating" && x.backups && x.backups.length)
        ? '<div class="bkp">backup: ' + x.backups.map(esc).join("; ") + "</div>" : "";
      var split = x.split ? ' <span class="flag">(split from group)</span>' : "";
      var act = actById[x.activityId] || {};
      var ext = act.external ? '<div class="bnote">books off-app (link in the app)</div>' : "";
      line.innerHTML = dot + "<strong>" + esc(x.name) + "</strong>" + split +
        '<div class="when">' + x.day + " " + fmt(x.start_min) + "-" + fmt(x.end_min) +
        (x.location ? " &middot; " + esc(x.location) : "") + (x.offsite ? " &middot; off-site" : "") + "</div>" +
        withTxt + ext + bkp;
      d.appendChild(line);
    });
    return d;
  }

  // ---------- Adjust panel ----------
  function buildAdjust() {
    var body = $("adjustBody"); body.innerHTML = "";
    body.appendChild(el("p", "hint",
      "Changes here are shared with everyone (saved to the group sheet) and the schedule recomputes live."));

    // Global break
    var brk = el("div", "knobrow");
    brk.innerHTML = "<span>Break between activities (minutes):</span>";
    var bi = el("input"); bi.type = "number"; bi.min = "0"; bi.step = "5"; bi.style.width = "80px";
    bi.value = (state.knobs.breakMinutes != null ? state.knobs.breakMinutes : CONFIG.breakMinutes) || 0;
    bi.addEventListener("change", function () {
      state.knobs.breakMinutes = parseInt(bi.value, 10) || 0; persist();
    });
    brk.appendChild(bi);
    body.appendChild(brk);

    // Pin instance
    var repWithPicks = schedule.activities.filter(function (a) {
      return a.kind === "repeating" && NAMES.some(function (n) { return state.picksByName[n][a.id]; });
    });
    var pinRow = el("div", "knobrow");
    pinRow.innerHTML = "<span>Pin an activity to a set time:</span>";
    var pinAct = el("select"); pinAct.appendChild(new Option("- activity -", ""));
    repWithPicks.forEach(function (a) { pinAct.appendChild(new Option(a.name, a.id)); });
    var pinInst = el("select"); pinInst.appendChild(new Option("- time -", ""));
    pinAct.addEventListener("change", function () {
      pinInst.innerHTML = ""; pinInst.appendChild(new Option("- time -", ""));
      var a = schedule.activities.filter(function (x) { return x.id === pinAct.value; })[0];
      if (a) a.instances.forEach(function (i) { pinInst.appendChild(new Option(i.label, i.day + "|" + i.start_min)); });
    });
    var pinBtn = el("button", null, "Pin");
    pinBtn.addEventListener("click", function () {
      if (!pinAct.value || !pinInst.value) return;
      state.knobs.pins = state.knobs.pins || {};
      state.knobs.pins[pinAct.value] = pinInst.value; persist();
    });
    pinRow.appendChild(pinAct); pinRow.appendChild(pinInst); pinRow.appendChild(pinBtn);
    body.appendChild(pinRow);

    // Force gap
    var actsWithPicks = schedule.activities.filter(function (a) {
      return a.kind !== "dropin" && NAMES.some(function (n) { return state.picksByName[n][a.id]; });
    });
    var gapRow = el("div", "knobrow");
    gapRow.innerHTML = "<span>Force a gap around an activity (e.g. off-site travel):</span>";
    var gapAct = el("select"); gapAct.appendChild(new Option("- activity -", ""));
    actsWithPicks.forEach(function (a) { gapAct.appendChild(new Option(a.name, a.id)); });
    var gapMin = el("input"); gapMin.type = "number"; gapMin.min = "0"; gapMin.step = "15"; gapMin.value = "30"; gapMin.style.width = "70px";
    var gapBtn = el("button", null, "Set");
    gapBtn.addEventListener("click", function () {
      if (!gapAct.value) return;
      state.knobs.gaps = state.knobs.gaps || {};
      state.knobs.gaps[gapAct.value] = parseInt(gapMin.value, 10) || 0; persist();
    });
    gapRow.appendChild(gapAct); gapRow.appendChild(gapMin); gapRow.appendChild(gapBtn);
    body.appendChild(gapRow);

    // Current overrides
    var cur = el("div", "knobrow"); cur.id = "curKnobs";
    body.appendChild(cur);
    renderCurrentKnobs();

    var st = el("span", "status", ""); st.id = "knobStatus"; body.appendChild(st);
  }

  function renderCurrentKnobs() {
    var cur = $("curKnobs"); if (!cur) return;
    cur.innerHTML = "";
    var nameOf = {}; schedule.activities.forEach(function (a) { nameOf[a.id] = a.name; });
    var pins = state.knobs.pins || {}, gaps = state.knobs.gaps || {};
    var any = Object.keys(pins).length || Object.keys(gaps).length;
    if (!any) { cur.innerHTML = "<span class='hint'>No pins or forced gaps set.</span>"; return; }
    cur.innerHTML = "<span>Active overrides:</span>";
    Object.keys(pins).forEach(function (id) {
      var tag = el("span", "badge", "Pin: " + esc(nameOf[id]) + " (&times;)");
      tag.style.cursor = "pointer";
      tag.addEventListener("click", function () { delete state.knobs.pins[id]; persist(); });
      cur.appendChild(tag);
    });
    Object.keys(gaps).forEach(function (id) {
      var tag = el("span", "badge", "Gap: " + esc(nameOf[id]) + " " + gaps[id] + "m (&times;)");
      tag.style.cursor = "pointer";
      tag.addEventListener("click", function () { delete state.knobs.gaps[id]; persist(); });
      cur.appendChild(tag);
    });
  }

  function persist() {
    var st = $("knobStatus"); if (st) { st.textContent = "saving..."; st.className = "status busy"; }
    recompute();
    renderAll();
    renderCurrentKnobs();
    $("adjust").open = true;
    window.Store.saveKnobs(state.knobs).then(function (r) {
      if (st) { st.textContent = r.ok ? "saved" : "saved locally only"; st.className = "status " + (r.ok ? "ok" : "err"); }
    });
  }
})();

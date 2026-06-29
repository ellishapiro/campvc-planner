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
    renderShared();
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

    // Festival open/close for this day - grey out before opening / after closing.
    var fh = (CONFIG.festivalHours || {})[day] || {};
    var openMin = pmin(fh.open), closeMin = pmin(fh.close);
    function addClosed(col, withLabel) {
      if (openMin != null && openMin > startB) {
        var d = el("div", "closed"); d.style.top = "0px"; d.style.height = (openMin - startB) * PX + "px";
        if (withLabel) d.innerHTML = '<span>site opens ' + fmt(openMin) + "</span>";
        col.appendChild(d);
      }
      if (closeMin != null && closeMin < endB) {
        var d2 = el("div", "closed"); d2.style.top = (closeMin - startB) * PX + "px"; d2.style.height = (endB - closeMin) * PX + "px";
        if (withLabel) d2.innerHTML = '<span>site closed ' + fmt(closeMin) + "</span>";
        col.appendChild(d2);
      }
    }

    // Time column
    var tc = el("div", "timecol"); tc.style.height = H + "px";
    for (var m = startB; m <= endB; m += 60) {
      var y = (m - startB) * PX;
      var line = el("div", "hourline"); line.style.top = y + "px"; tc.appendChild(line);
      var lbl = el("div", "hourlbl", fmt(m)); lbl.style.top = (y + 2) + "px"; tc.appendChild(lbl);
    }
    cal.appendChild(tc);

    // Person columns
    NAMES.forEach(function (n, ni) {
      var col = el("div", "col"); col.style.height = H + "px";
      for (var m2 = startB; m2 <= endB; m2 += 60) {
        var l = el("div", "hourline"); l.style.top = (m2 - startB) * PX + "px"; col.appendChild(l);
      }
      addClosed(col, ni === 0);
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

  // Readable full availability window for a drop-in (its real open hours).
  function pmin(t) { var m = /^(\d{1,2}):(\d{2})$/.exec(String(t || "").trim()); return m ? (+m[1] * 60 + +m[2]) : null; }
  function winText(w) {
    var s = pmin(w.start), e = pmin(w.end);
    if (s === 0) s = null; // "00:00" means open from the start of the day
    if (s != null && e != null) return fmt(s) + "-" + fmt(e);
    if (e != null) return "until " + fmt(e);
    if (s != null) return "from " + fmt(s);
    return "all day";
  }
  function winLabel(x) {
    var act = actById[x.activityId] || {};
    var w = (act.windows || []).filter(function (z) { return z.day === x.day; })[0];
    return w ? "open " + winText(w) : "around " + fmt(x.start_min);
  }

  function blockEl(x, startB) {
    var isWindow = x.type === "dropin";
    var booking = isWindow && x.booking; // window that needs booking (appointment)
    // Background always carries priority; drop-in/appointment is a border cue.
    var cls = "block " + (x.priority || "none");
    if (isWindow) cls += booking ? " appt" : " dropin";
    if (x.paid) cls += " paid";
    var b = el("div", cls);
    b.style.top = (x.start_min - startB) * PX + "px";
    b.style.height = Math.max((x.end_min - x.start_min) * PX, 30) + "px";
    var withTxt = x.withWhom && x.withWhom.length ? " &middot; with " + x.withWhom.map(esc).join(", ") : "";
    var tag = isWindow
      ? (booking ? '<span class="droptag book">book a slot' + (x.external ? " off-app" : "") + "</span>"
                 : '<span class="droptag">drop-in &middot; flexible</span>')
      : "";
    var bm;
    if (isWindow) {
      var act = actById[x.activityId] || {};
      var w = (act.windows || []).filter(function (z) { return z.day === x.day; })[0];
      if (booking) {
        bm = (x.external ? "book off-app" : "book a slot") + (w ? " &middot; open " + winText(w) : "");
      } else {
        bm = "earmarked " + fmt(x.start_min) + "-" + fmt(x.end_min) + (w ? " &middot; open " + winText(w) : " &middot; go anytime");
      }
    } else {
      bm = fmt(x.start_min) + "-" + fmt(x.end_min) + withTxt;
    }
    b.innerHTML = '<div class="bt">' + esc(x.name) + tag + '</div><div class="bm">' + bm + "</div>";
    b.title = x.name + " - " + x.day + " " + fmt(x.start_min) + "-" + fmt(x.end_min) +
      (x.location ? " @ " + x.location : "");
    return b;
  }

  // ---------- "Do these together?" - per-activity shared-time locking ----------
  // Togetherness is an explicit, per-activity choice (it pins the chosen instance
  // for everyone) rather than an abstract global dial. Only repeating activities
  // with 2+ interested people can be locked - one-offs have no choice to make.
  function renderShared() {
    var wrap = $("shared"); if (!wrap) return; wrap.innerHTML = "";
    state.knobs.pins = state.knobs.pins || {};
    var pins = state.knobs.pins;
    var acts = Object.keys(state.result.byActivity)
      .map(function (id) { return state.result.byActivity[id]; })
      .filter(function (a) { return a.kind === "repeating" && a.people.length >= 2; });
    if (!acts.length) {
      wrap.appendChild(el("p", "hint", "Nothing yet that two or more of you both want - this fills in as people add picks."));
      return;
    }
    function isSplit(a) { return !pins[a.id] && a.groupCount < a.people.length; }
    // Actionable first: split (needs a decision), then locked, then already-together.
    function rank(a) { return isSplit(a) ? 0 : (pins[a.id] ? 1 : 2); }
    acts.sort(function (x, y) { return (rank(x) - rank(y)) || (y.people.length - x.people.length) || x.name.localeCompare(y.name); });
    var nSplit = acts.filter(isSplit).length, nLocked = acts.filter(function (a) { return pins[a.id]; }).length;

    // Collapsible so the section doesn't add a wall of scrolling.
    var box = el("details", "card");
    box.open = state.sharedOpen || false;
    box.addEventListener("toggle", function () { state.sharedOpen = box.open; });
    var sum = el("summary");
    sum.innerHTML = "<strong>Do these together?</strong> " +
      '<span class="hint">- ' + acts.length + " activity(ies) 2+ of you want" +
      (nSplit ? ", <span class='warn'>" + nSplit + " split</span>" : "") +
      (nLocked ? ", " + nLocked + " locked" : "") + "</span>";
    box.appendChild(sum);
    box.appendChild(el("p", "hint", "Lock a shared time and everyone who's free then is put on that session. " +
      "A 'must do' is never given up to do this."));

    acts.forEach(function (a) {
      var pinned = !!pins[a.id];
      var total = a.people.length;
      var byKey = {}; a.instances.forEach(function (i) { byKey[i.key] = i; });
      var row = el("div", "share" + (pinned ? " locked" : ""));
      var head = el("div", "share-head");
      head.innerHTML = "<strong>" + esc(a.name) + "</strong>" +
        ' <span class="hint">- ' + total + " want this: " + a.people.map(esc).join(", ") + "</span>";
      row.appendChild(head);

      // Status from ACTUAL placements (exact), not a prediction.
      var here = (byKey[pinned ? pins[a.id] : a.chosenKey] || {}).here || [];
      var status = el("div", "share-status");
      if (pinned) {
        var pl = (byKey[pins[a.id]] || {}).label || a.chosenLabel;
        status.innerHTML = '<span class="lock">&#128274; Locked</span> to <strong>' + esc(pl) + "</strong> &middot; " +
          (here.length ? "on it: " + here.map(esc).join(", ") : "nobody can make it") +
          (a.notPlaced.length ? ' &middot; <span class="warn">' + a.notPlaced.map(esc).join(", ") +
            " can't make this time (clash)</span> - try another below" : "");
      } else if (a.groupCount >= total) {
        status.innerHTML = (total === 2 ? "Both" : "All " + total) +
          " are already on the same session (" + esc(a.chosenLabel) + ").";
      } else {
        // who's where right now
        var spread = a.instances.filter(function (i) { return i.here.length; })
          .map(function (i) { return i.here.map(esc).join(", ") + " on " + esc(i.label); });
        status.innerHTML = '<span class="warn">Split</span> - ' + spread.join("; ") +
          (a.notPlaced.length ? "; " + a.notPlaced.map(esc).join(", ") + " not placed" : "") +
          ". Lock a time to pull together whoever's free.";
      }
      row.appendChild(status);

      // control: pick an instance (showing who's currently on each) + lock / unlock
      var ctl = el("div", "share-ctl");
      var sel = el("select");
      a.instances.forEach(function (i) {
        var note = i.here.length ? " - on it now: " + i.here.join(", ") : " - nobody yet";
        sel.appendChild(new Option(i.label + note, i.key));
      });
      sel.value = pinned ? pins[a.id] : a.chosenKey;
      ctl.appendChild(sel);
      var btn = el("button", null, pinned ? "Update lock" : "Lock this time for everyone");
      btn.addEventListener("click", function () { state.knobs.pins[a.id] = sel.value; persist(); });
      ctl.appendChild(btn);
      if (pinned) {
        var un = el("button", "linkbtn", "Unlock");
        un.addEventListener("click", function () { delete state.knobs.pins[a.id]; persist(); });
        ctl.appendChild(un);
      }
      row.appendChild(ctl);
      box.appendChild(row);
    });
    wrap.appendChild(box);
  }

  // ---------- People / booking lists ----------
  function renderPeople() {
    var wrap = $("people"); wrap.innerHTML = "";
    NAMES.forEach(function (n) {
      var p = state.result.byPerson[n];
      var hasAny = p.all.length || p.dropins.length || p.ifTime.length || p.dropped.length;
      // Collapsible per person, collapsed by default so the section is short;
      // tap a name to expand. (Counts are in the summary either way.)
      var card = el("details", "card");
      card.open = false;
      var toBook = p.paid.length + p.free.length;
      var sum = el("summary");
      sum.innerHTML = "<strong>" + esc(n) + "</strong>" +
        (hasAny ? ' <span class="hint">- ' + toBook + " to book, " + p.all.length + " scheduled</span>" : ' <span class="hint">- no picks yet</span>');
      card.appendChild(sum);
      if (!hasAny) { wrap.appendChild(card); return; }

      card.appendChild(phaseBlock("Phase 1 - Paid (book first)", p.paid));
      card.appendChild(phaseBlock("Phase 2 - Free (book a week later)", p.free));
      if (p.turnup && p.turnup.length) card.appendChild(phaseBlock("Turn up - no booking (be there on time)", p.turnup));

      // appointments (window activities that need booking, e.g. Massage) vs
      // genuinely flexible turn-up drop-ins (Calm Space).
      var appts = p.dropins.filter(function (x) { return x.booking; });
      var flex = p.dropins.filter(function (x) { return !x.booking; });
      if (appts.length) {
        var ad = el("div", "phase"); ad.appendChild(el("h4", null, "Book a slot (appointment)"));
        appts.forEach(function (x) { ad.appendChild(dropRow(x, x.day + " " + winLabel(x))); });
        card.appendChild(ad);
      }
      if (flex.length) {
        var dd = el("div", "phase"); dd.appendChild(el("h4", null, "Drop-ins - turn up (anytime)"));
        flex.forEach(function (x) { dd.appendChild(dropRow(x, x.day + " " + fmt(x.start_min) + "-" + fmt(x.end_min))); });
        card.appendChild(dd);
      }
      if (p.ifTime.length) {
        var it = el("div", "phase"); it.appendChild(el("h4", null, "Drop-ins - no free gap (turn up if you can)"));
        p.ifTime.forEach(function (x) { it.appendChild(dropRow(x, "no free slot")); });
        card.appendChild(it);
      }
      if (p.dropped.length) {
        // group the couldn't-fit list by priority (must -> want -> if-free) for readability
        var fd = el("div", "phase"); fd.appendChild(el("h4", null, "Couldn't fit (" + p.dropped.length + ")"));
        var order = { must: 0, want: 1, iffree: 2 };
        p.dropped.slice().sort(function (a, b) {
          return (order[a.priority] == null ? 9 : order[a.priority]) - (order[b.priority] == null ? 9 : order[b.priority]);
        }).forEach(function (x) {
          var dot = x.priority ? '<span class="pri-dot ' + x.priority + '"></span>' : "";
          fd.appendChild(el("div", "bk", dot + esc(x.name) +
            '<div class="when">' + esc(x.reason) + "</div>"));
        });
        card.appendChild(fd);
      }
      wrap.appendChild(card);
    });
  }

  // A drop-in row, styled like the other list rows (priority dot + name + tag).
  function dropRow(x, whenText) {
    var dot = x.priority ? '<span class="pri-dot ' + x.priority + '"></span>' : "";
    var tag = x.booking
      ? '<span class="badge book">book a slot' + (x.external ? " off-app" : "") + "</span>"
      : '<span class="badge drop">drop-in</span>';
    var note = x.booking && x.external ? '<div class="bnote">books off-app (partner link)</div>' : "";
    return el("div", "bk", dot + esc(x.name) + " " + tag +
      '<div class="when">' + esc(whenText) + "</div>" + note);
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
      var act = actById[x.activityId] || {};
      var ext = act.external ? '<div class="bnote">books off-app (partner link)</div>' : "";
      line.innerHTML = dot + "<strong>" + esc(x.name) + "</strong>" +
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

    body.appendChild(el("p", "hint",
      "To put people on the same session, use “Do these together?” above - it's per activity. " +
      "By default the engine already co-locates friends when it costs nobody a pick."));

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

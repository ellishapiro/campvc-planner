// Camp VC planner - matchmaking + clash engine.
// Pure, deterministic functions. Given the schedule, everyone's picks, and the
// shared "knobs", it produces each person's booking plan and the group view.
// No randomness, no network, no DOM - so it is consistent and testable.
//
// Exposed as window.Engine.compute(schedule, picksByName, knobs, config).
//
// picksByName: { "Elli": { "<activityId>": "must"|"want"|"iffree", ... }, ... }
// knobs:       { breakMinutes?, pins?: {activityId: instanceKey}, gaps?: {activityId: minutes} }
(function () {
  "use strict";

  var PRIORITY_WEIGHT = { must: 3, want: 2, iffree: 1 };
  var PRIORITY_LABEL = { must: "Must do", want: "Want", iffree: "If free" };

  function weightOf(priority) {
    return PRIORITY_WEIGHT[priority] || 0;
  }

  function instanceKey(inst) {
    return inst.day + "|" + inst.start_min;
  }

  // Derive sensible calendar bounds from the bookable instances.
  function dayBounds(schedule, config) {
    var min = 24 * 60, max = 0, seen = false;
    schedule.activities.forEach(function (a) {
      a.instances.forEach(function (i) {
        seen = true;
        if (i.start_min < min) min = i.start_min;
        if (i.end_min > max) max = i.end_min;
      });
    });
    if (!seen) {
      min = (config.dayStartHourFallback || 8) * 60;
      max = (config.dayEndHourFallback || 23) * 60;
    }
    return { start: min, end: max };
  }

  function compute(schedule, picksByName, knobs, config) {
    knobs = knobs || {};
    config = config || {};
    var acts = {};
    schedule.activities.forEach(function (a) { acts[a.id] = a; });
    var days = schedule.days;
    var dayIndex = {};
    days.forEach(function (d, i) { dayIndex[d] = i; });

    var breakMin = (knobs.breakMinutes != null ? knobs.breakMinutes : config.breakMinutes) || 0;
    var offsiteBuf = config.offsiteBufferMinutes || 0;
    var pins = knobs.pins || {};
    var forced = knobs.gaps || {};
    var names = Object.keys(picksByName);

    var sched = {};       // name -> [placement]   (bookings)
    var earmarks = {};    // name -> [placement]   (drop-in suggestions)
    var dropped = {};     // name -> [{activityId,name,reason}]
    var ifTime = {};      // name -> [activity]    (wanted drop-ins with no gap)
    names.forEach(function (n) { sched[n] = []; earmarks[n] = []; dropped[n] = []; ifTime[n] = []; });

    var bounds = dayBounds(schedule, config);
    var dropinEarliest = Math.max(bounds.start, (config.dropInEarliestHour || 9) * 60);
    var dropinLatest = (config.dayEndHourFallback || 23) * 60;  // evening drop-ins (cabaret, DJ) run later than the last bookable session

    function reqGap(aId, bId) {
      var g = breakMin;
      var a = acts[aId], b = acts[bId];
      if ((a && a.offsite) || (b && b.offsite)) g += offsiteBuf;
      g += Math.max(forced[aId] || 0, forced[bId] || 0);
      return g;
    }

    // Does `cand` fit in `person`'s timetable without overlap/too-close?
    // Returns the conflicting placement if not, else null.
    function conflictFor(person, cand, includeEarmarks) {
      var list = sched[person].slice();
      if (includeEarmarks) list = list.concat(earmarks[person]);
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (p.day !== cand.day) continue;
        var g = reqGap(p.activityId, cand.activityId);
        var ok = (cand.start_min >= p.end_min + g) || (p.start_min >= cand.end_min + g);
        if (!ok) return p;
      }
      return null;
    }

    function fits(person, cand, includeEarmarks) {
      return conflictFor(person, cand, includeEarmarks) === null;
    }

    function makePlacement(a, inst, type, priority, split) {
      return {
        activityId: a.id,
        name: a.name,
        location: a.location,
        paid: a.paid,
        offsite: a.offsite,
        booking: !!a.booking,       // needs booking (in booking lists) vs turn-up
        external: !!a.external,     // booking is off-app (partner link)
        kind: a.kind,
        type: type,                 // "booking" | "dropin"
        priority: priority || null,
        priorityLabel: priority ? PRIORITY_LABEL[priority] : null,
        day: inst.day,
        dayIndex: dayIndex[inst.day] != null ? dayIndex[inst.day] : 9,
        start_min: inst.start_min,
        end_min: inst.end_min,
        label: inst.label || (inst.day + " " + fmt(inst.start_min) + "-" + fmt(inst.end_min)),
        split: !!split,
        withWhom: [],
      };
    }

    function place(person, a, inst, type, priority, split) {
      sched[person].push(makePlacement(a, inst, type, priority, split));
    }

    function candFromInstance(a, inst) {
      return { day: inst.day, start_min: inst.start_min, end_min: inst.end_min, activityId: a.id };
    }

    function interested(actId) {
      var out = [];
      names.forEach(function (n) {
        var pr = picksByName[n][actId];
        if (pr) out.push({ name: n, priority: pr, weight: weightOf(pr) });
      });
      return out;
    }

    function dayIdx(i) {
      if (i.dayIndex != null) return i.dayIndex;
      return dayIndex[i.day] != null ? dayIndex[i.day] : 9;
    }
    function instSort(a, b) {
      return (dayIdx(a) - dayIdx(b)) || (a.start_min - b.start_min);
    }

    function overlaps(p, cand) {
      if (p.day !== cand.day) return false;
      var g = reqGap(p.activityId, cand.activityId);
      return !((cand.start_min >= p.end_min + g) || (p.start_min >= cand.end_min + g));
    }
    function weightOfPick(person, actId) { return weightOf(picksByName[person][actId]); }

    // ---- Placement ----
    // We place activities one at a time, tightest-first, so constrained picks
    // (one-offs, few-instance activities) claim slots before very flexible ones
    // (e.g. Archery x34). For each activity all interested people aim at the SAME
    // chosen instance (matchmaking); a person who can't fit it will first try to
    // RELOCATE the flexible bookings in the way (keeping everyone), and only then
    // fall back to a different instance (a "split") or being dropped.
    var groupPref = {};   // activityId -> chosen shared instance
    var backupsOf = {};   // activityId -> [labels]

    function isGroupPref(a, inst) { return groupPref[a.id] && instanceKey(inst) === instanceKey(groupPref[a.id]); }
    function candList(a) {
      if (pins[a.id]) {
        var pinned = a.instances.filter(function (i) { return instanceKey(i) === pins[a.id]; });
        return pinned.length ? pinned : a.instances.slice();
      }
      var pref = groupPref[a.id];
      var rest = a.instances.filter(function (i) { return !pref || instanceKey(i) !== instanceKey(pref); }).sort(instSort);
      return (pref ? [pref] : []).concat(rest);
    }

    // Put `inst` of `a` into `person`'s timetable - directly if it fits, else by
    // relocating the flexible (repeating) bookings it clashes with to other
    // instances. One-off conflicts can't move, so those block. Returns true if placed.
    function placeAt(person, a, inst, priority, split) {
      var cf = candFromInstance(a, inst);
      if (fits(person, cf, false)) { place(person, a, inst, "booking", priority, split); return true; }
      var conflicts = sched[person].filter(function (p) { return overlaps(p, cf); });
      if (!conflicts.length) return false;
      if (conflicts.some(function (p) { return acts[p.activityId].kind !== "repeating"; })) return false;
      var snapshot = sched[person].slice();
      sched[person] = sched[person].filter(function (p) { return conflicts.indexOf(p) < 0; });
      place(person, a, inst, "booking", priority, split);
      for (var k = 0; k < conflicts.length; k++) {
        var cc = conflicts[k], act = acts[cc.activityId], moved = false, alt = candList(act);
        for (var j = 0; j < alt.length; j++) {
          if (fits(person, candFromInstance(act, alt[j]), false)) {
            place(person, act, alt[j], "booking", cc.priority, !isGroupPref(act, alt[j]));
            moved = true; break;
          }
        }
        if (!moved) { sched[person] = snapshot; return false; }  // rollback
      }
      return true;
    }

    function maxWeight(a) {
      return interested(a.id).reduce(function (m, p) { return Math.max(m, p.weight); }, 0);
    }
    var ordered = schedule.activities
      .filter(function (a) { return a.kind !== "dropin" && interested(a.id).length; })
      .sort(function (x, y) {
        return (maxWeight(y) - maxWeight(x)) || (x.instances.length - y.instances.length) ||
          (x.name < y.name ? -1 : (x.name > y.name ? 1 : 0));
      });

    var byActivity = {};
    ordered.forEach(function (a) {
      var people = interested(a.id).sort(function (p, q) { return q.weight - p.weight; });
      // Choose the shared instance: the one the most (weighted) interested people
      // can take right now. A pin forces it.
      var chosen, scored = null;
      if (pins[a.id]) {
        chosen = a.instances.filter(function (i) { return instanceKey(i) === pins[a.id]; })[0] || a.instances[0];
      } else {
        scored = a.instances.map(function (inst) {
          var s = 0, mustFit = 0;
          people.forEach(function (p) {
            if (fits(p.name, candFromInstance(a, inst), false)) { s += p.weight; if (p.priority === "must") mustFit++; }
          });
          return { inst: inst, score: s, mustFit: mustFit };
        });
        // Prefer the instance that includes the most MUST-people (so a must-person
        // anchors the shared slot), then the most weighted attendance overall.
        scored.sort(function (x, y) { return (y.mustFit - x.mustFit) || (y.score - x.score) || instSort(x.inst, y.inst); });
        chosen = scored[0].inst;
      }
      groupPref[a.id] = chosen;
      backupsOf[a.id] = scored ? scored.slice(1).filter(function (x) { return x.score > 0; }).slice(0, 2)
        .map(function (x) { return x.inst.label; }) : [];

      people.forEach(function (p) {
        // 1) the shared instance (direct or by relocation) -> together
        if (placeAt(p.name, a, chosen, p.priority, false)) return;
        if (pins[a.id]) {
          var cp = conflictFor(p.name, candFromInstance(a, chosen), false);
          dropped[p.name].push({ activityId: a.id, name: a.name, priority: p.priority, reason: "pinned slot unavailable" + (cp ? " (clashes with " + cp.name + ")" : "") });
          return;
        }
        // 2) best alternative instance -> split from the group
        var cands = candList(a);
        for (var i = 0; i < cands.length; i++) {
          if (instanceKey(cands[i]) === instanceKey(chosen)) continue;
          if (placeAt(p.name, a, cands[i], p.priority, true)) return;
        }
        // 3) drop
        var clash = conflictFor(p.name, candFromInstance(a, chosen), false);
        dropped[p.name].push({
          activityId: a.id, name: a.name, priority: p.priority,
          reason: clash ? ("no clash-free time (clashes with " + clash.name + ")") : "no clash-free time",
        });
      });

      var prefKey = instanceKey(chosen);
      var here = names.filter(function (n) {
        return sched[n].some(function (p) { return p.activityId === a.id && instanceKey(p) === prefKey; });
      });
      byActivity[a.id] = {
        id: a.id, name: a.name, kind: a.kind, paid: a.paid, offsite: a.offsite,
        chosenLabel: chosen.label || (chosen.day + " " + fmt(chosen.start_min) + "-" + fmt(chosen.end_min)),
        chosenKey: prefKey,
        people: people.map(function (p) { return p.name; }),
        groupCount: here.length,
        backups: backupsOf[a.id],
        instances: a.instances.map(function (i) { return { key: instanceKey(i), label: i.label }; }),
      };
    });

    // ---- Priority repair: never let a lower-priority booking crowd out a
    //      higher-priority pick. If a dropped pick can take a slot where every
    //      clashing booking is strictly lower priority, bump those and place it. ----
    names.forEach(function (n) {
      for (var guard = 0; guard < 200; guard++) {
        var drops = dropped[n].slice().sort(function (x, y) {
          return weightOf(picksByName[n][y.activityId]) - weightOf(picksByName[n][x.activityId]);
        });
        var did = false;
        for (var di = 0; di < drops.length; di++) {
          var d = drops[di], a = acts[d.activityId];
          if (!a || a.kind === "dropin" || !a.instances.length) continue;
          var myW = weightOf(picksByName[n][a.id]);
          if (!myW) continue;
          for (var ii = 0; ii < a.instances.length; ii++) {
            var cf = candFromInstance(a, a.instances[ii]);
            var confs = sched[n].filter(function (p) { return overlaps(p, cf); });
            if (confs.length && confs.every(function (p) { return weightOf(p.priority) < myW; })) {
              confs.forEach(function (p) {
                sched[n] = sched[n].filter(function (q) { return q !== p; });
                dropped[n].push({ activityId: p.activityId, name: p.name, priority: p.priority,
                  reason: "bumped so a higher-priority pick (" + a.name + ") could fit" });
              });
              dropped[n] = dropped[n].filter(function (x) { return x.activityId !== a.id; });
              place(n, a, a.instances[ii], "booking", picksByName[n][a.id], !isGroupPref(a, a.instances[ii]));
              did = true;
              break;
            }
          }
          if (did) break;
        }
        if (!did) break;
      }
    });

    // ---- Togetherness pass: if interested friends ended up on different
    //      instances of the same activity, try to converge them onto one slot
    //      (the one with the most attendees). placeAt only relocates flexible
    //      bookings and never drops a must, so split friends are pulled together
    //      only when it can be done without sacrificing anyone's must. ----
    function myInstKey(n, id) {
      var p = sched[n].filter(function (x) { return x.activityId === id; })[0];
      return p ? instanceKey(p) : null;
    }
    schedule.activities.filter(function (a) { return a.kind === "repeating"; }).forEach(function (a) {
      var fans = names.filter(function (n) { return picksByName[n][a.id] && myInstKey(n, a.id); });
      if (fans.length < 2) return;
      var here = {};
      fans.forEach(function (n) { var k = myInstKey(n, a.id); here[k] = (here[k] || 0) + 1; });
      var keys = Object.keys(here);
      if (keys.length < 2) return; // already together
      keys.sort(function (x, y) { return here[y] - here[x]; });
      var target = keys[0];
      var targetInst = a.instances.filter(function (i) { return instanceKey(i) === target; })[0];
      if (!targetInst) return;
      fans.forEach(function (n) {
        if (myInstKey(n, a.id) === target) return;
        var pr = picksByName[n][a.id];
        var snapshot = sched[n].slice();
        sched[n] = sched[n].filter(function (x) { return x.activityId !== a.id; });
        if (placeTogether(n, a, targetInst, pr)) return;
        sched[n] = snapshot; // couldn't join without sacrificing an equal/higher priority - leave split
      });
    });

    // Seat `n` on `inst` for togetherness: relocate flexible conflicts if possible,
    // else bump conflicts that are STRICTLY lower priority (never an equal/higher,
    // so a must is never sacrificed to chase togetherness).
    function placeTogether(person, a, inst, priority) {
      if (placeAt(person, a, inst, priority, false)) return true;
      var cf = candFromInstance(a, inst);
      var confs = sched[person].filter(function (p) { return overlaps(p, cf); });
      if (!confs.length) return false;
      if (!confs.every(function (p) { return weightOf(p.priority) < weightOf(priority); })) return false;
      confs.forEach(function (p) {
        sched[person] = sched[person].filter(function (q) { return q !== p; });
        dropped[person].push({ activityId: p.activityId, name: p.name, priority: p.priority,
          reason: "moved aside so the group could be together for " + a.name });
      });
      place(person, a, inst, "booking", priority, false);
      return true;
    }

    // recompute the shared instance + group counts after repair/togetherness passes
    Object.keys(byActivity).forEach(function (id) {
      var counts = {};
      names.forEach(function (n) {
        sched[n].forEach(function (p) { if (p.activityId === id) counts[instanceKey(p)] = (counts[instanceKey(p)] || 0) + 1; });
      });
      var keys = Object.keys(counts);
      if (!keys.length) { byActivity[id].groupCount = 0; return; }
      keys.sort(function (x, y) { return counts[y] - counts[x]; });
      byActivity[id].chosenKey = keys[0];
      byActivity[id].groupCount = counts[keys[0]];
      var inst = (acts[id].instances || []).filter(function (i) { return instanceKey(i) === keys[0]; })[0];
      if (inst) byActivity[id].chosenLabel = inst.label;
    });

    // ---- Step 3: earmark drop-ins into free gaps ----
    var dropins = schedule.activities.filter(function (a) { return a.kind === "dropin"; });
    names.forEach(function (n) {
      var wanted = dropins
        .filter(function (a) { return picksByName[n][a.id]; })
        .map(function (a) { return { a: a, w: weightOf(picksByName[n][a.id]) }; });
      wanted.sort(function (x, y) { return y.w - x.w; });
      wanted.forEach(function (item) {
        if (!tryPlaceDropin(n, item.a)) ifTime[n].push({ activityId: item.a.id, name: item.a.name, priority: picksByName[n][item.a.id] });
      });
    });

    function festOpen(day) { var t = toMin(((config.festivalHours || {})[day] || {}).open); return t == null ? 0 : t; }
    function festClose(day) { var t = toMin(((config.festivalHours || {})[day] || {}).close); return t == null ? 24 * 60 : t; }
    function availabilityByDay(a) {
      var map = {};
      (a.windows || []).forEach(function (w) {
        var s = toMin(w.start);
        var e = toMin(w.end);
        if (s == null) s = dropinEarliest;
        if (e == null) e = dropinLatest;
        s = Math.max(s, dropinEarliest, festOpen(w.day));   // not before the site opens
        e = Math.min(e, dropinLatest, festClose(w.day));    // not after it closes
        if (e - s < 1) return;
        if (!map[w.day] || s < map[w.day][0]) {
          map[w.day] = map[w.day] ? [Math.min(map[w.day][0], s), Math.max(map[w.day][1], e)] : [s, e];
        } else {
          map[w.day] = [Math.min(map[w.day][0], s), Math.max(map[w.day][1], e)];
        }
      });
      return map;
    }

    function tryPlaceDropin(n, a) {
      var slotLen = config.dropInSlotMinutes || 45;
      var avail = availabilityByDay(a);
      for (var di = 0; di < days.length; di++) {
        var day = days[di];
        if (!avail[day]) continue;
        var as = avail[day][0], ae = avail[day][1];
        var items = sched[n].concat(earmarks[n])
          .filter(function (p) { return p.day === day; })
          .sort(function (x, y) { return x.start_min - y.start_min; });
        var positions = [as];
        items.forEach(function (it) { positions.push(it.end_min + reqGap(it.activityId, a.id)); });
        for (var pi = 0; pi < positions.length; pi++) {
          var pos = Math.max(positions[pi], as);
          var cand = { day: day, start_min: pos, end_min: pos + slotLen, activityId: a.id };
          if (cand.end_min <= ae && fits(n, cand, true)) {
            earmarks[n].push(makePlacement(a, {
              day: day, start_min: pos, end_min: pos + slotLen,
              label: day + " " + fmt(pos) + "-" + fmt(pos + slotLen),
            }, "dropin", picksByName[n][a.id], false));
            return true;
          }
        }
      }
      return false;
    }

    // ---- Finalise: sort, compute who-with, attach backups ----
    names.forEach(function (n) {
      sched[n].sort(instSort);
      earmarks[n].sort(instSort);
    });
    // who-with: people sharing the same activity instance (same day+start)
    names.forEach(function (n) {
      sched[n].forEach(function (p) {
        var others = [];
        names.forEach(function (m) {
          if (m === n) return;
          if (sched[m].some(function (q) {
            return q.activityId === p.activityId && q.day === p.day && q.start_min === p.start_min;
          })) others.push(m);
        });
        p.withWhom = others;
        var ba = byActivity[p.activityId];
        p.backups = (ba && ba.backups) ? ba.backups : [];
      });
    });

    // Recompute couldn't-fit reasons against the FINAL schedule, listing every
    // activity that blocks it (a dropped pick usually clashes with several).
    names.forEach(function (n) {
      dropped[n].forEach(function (d) {
        if (/bumped|moved aside|pinned/.test(d.reason || "")) return; // keep intentional reasons
        var a = acts[d.activityId];
        if (!a || !a.instances || !a.instances.length) { d.reason = d.reason || "no clash-free time"; return; }
        var blockers = {};
        a.instances.forEach(function (inst) {
          sched[n].forEach(function (p) { if (overlaps(p, candFromInstance(a, inst))) blockers[p.name] = true; });
        });
        var list = Object.keys(blockers);
        d.reason = list.length
          ? "clashes with " + list.slice(0, 4).join(", ") + (list.length > 4 ? " and " + (list.length - 4) + " more" : "")
          : "no clash-free time";
      });
    });

    var anyPicks = names.some(function (n) { return Object.keys(picksByName[n]).length > 0; });

    return {
      days: days,
      bounds: bounds,
      names: names,
      anyPicks: anyPicks,
      byPerson: buildByPerson(),
      byActivity: byActivity,
    };

    function buildByPerson() {
      var out = {};
      names.forEach(function (n) {
        var bookings = sched[n].filter(function (p) { return p.type === "booking"; });
        var needBooking = bookings.filter(function (p) { return p.booking; });
        out[n] = {
          paid: needBooking.filter(function (p) { return p.paid; }),
          free: needBooking.filter(function (p) { return !p.paid; }),
          turnup: bookings.filter(function (p) { return !p.booking; }),  // scheduled, no booking
          all: bookings,
          dropins: earmarks[n],
          ifTime: ifTime[n],
          dropped: dropped[n],
        };
      });
      return out;
    }
  }

  function toMin(s) {
    if (s == null) return null;
    s = String(s).trim();
    var m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  }
  function fmt(mins) {
    var h = Math.floor(mins / 60), m = mins % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  window.Engine = {
    compute: compute,
    weightOf: weightOf,
    instanceKey: instanceKey,
    PRIORITY_LABEL: PRIORITY_LABEL,
    fmt: fmt,
  };
})();

// Camp VC planner - matchmaking + scheduling engine.
// Pure, deterministic. Given the schedule, everyone's picks and the shared
// "knobs", it produces each person's booking plan and the group view.
//
//   window.Engine.compute(schedule, picksByName, knobs, config)
//
// Design: for each person we solve the EXACT best timetable for their must+want
// picks (branch-and-bound: choose <=1 instance per activity, no time overlaps
// incl. buffers, maximise total priority weight) - so a higher priority is never
// crowded out by a lower one, and no fittable pick is left out. If-free picks are
// then greedily slotted into the gaps. Togetherness is a TUNABLE objective term
// (config/knobs.togetherness): we iterate a group "consensus" instance per shared
// activity and reward landing on it - small dial = only co-locate when it's free,
// larger dial = trade some lower-priority picks for being together. A must is
// never dropped to chase togetherness.
(function () {
  "use strict";

  var PRIORITY_WEIGHT = { must: 3, want: 2, iffree: 1 };
  var PRIORITY_LABEL = { must: "Must do", want: "Want", iffree: "If free" };
  function weightOf(p) { return PRIORITY_WEIGHT[p] || 0; }
  // Optimiser weights are tiered so a MUST can never be traded away for
  // togetherness or wants (must dominates), while wants remain tradeable.
  function covWeight(p) { return p === "must" ? 10000 : (p === "want" ? 10 : (p === "iffree" ? 1 : 0)); }
  function instanceKey(i) { return i.day + "|" + i.start_min; }
  function fmt(m) { var h = Math.floor(m / 60), x = m % 60; return (h < 10 ? "0" : "") + h + ":" + (x < 10 ? "0" : "") + x; }
  function toMin(s) { if (s == null) return null; var m = /^(\d{1,2}):(\d{2})$/.exec(String(s).trim()); return m ? +m[1] * 60 + +m[2] : null; }

  function dayBounds(schedule, config) {
    var min = 24 * 60, max = 0, seen = false;
    schedule.activities.forEach(function (a) {
      a.instances.forEach(function (i) { seen = true; if (i.start_min < min) min = i.start_min; if (i.end_min > max) max = i.end_min; });
    });
    if (!seen) { min = (config.dayStartHourFallback || 8) * 60; max = (config.dayEndHourFallback || 23) * 60; }
    return { start: min, end: max };
  }

  function compute(schedule, picksByName, knobs, config) {
    knobs = knobs || {}; config = config || {};
    var acts = {}; schedule.activities.forEach(function (a) { acts[a.id] = a; });
    var days = schedule.days; var dayIndex = {}; days.forEach(function (d, i) { dayIndex[d] = i; });
    var breakMin = (knobs.breakMinutes != null ? knobs.breakMinutes : config.breakMinutes) || 0;
    var offsiteBuf = config.offsiteBufferMinutes || 0;
    var pins = knobs.pins || {}, forced = knobs.gaps || {};
    var names = Object.keys(picksByName);
    // A lock is per-person: pins[id] = { key, people:[names] }. An older string
    // form (whole-group) is read as locking config.legacyLockPeople (the original
    // friends), so people added later aren't locked retroactively.
    function pinInfo(id) {
      var p = pins[id]; if (!p) return null;
      if (typeof p === "string") return { key: p, people: (config.legacyLockPeople || names) };
      return { key: p.key, people: (p.people && p.people.length ? p.people : names) };
    }
    function lockedFor(id, n) { var pi = pinInfo(id); return !!(pi && pi.people.indexOf(n) >= 0); }
    // Togetherness dial. Optimiser weights are must=10000, want=10, iffree=1, so a
    // must is never traded for togetherness. To trade ONE want for one extra person
    // sharing an instance you need dial >= 10. So: 0 = off, 1 = co-locate only when
    // it costs nothing (default), ~10 = prefer together (trade a want), ~30 = strong.
    var together = (knobs.togetherness != null ? knobs.togetherness : config.togetherness);
    if (together == null) together = 1;  // default: co-locate when free, never trade a want
    var bounds = dayBounds(schedule, config);
    var dropinEarliest = Math.max(bounds.start, (config.dropInEarliestHour || 9) * 60);
    var dropinLatest = (config.dayEndHourFallback || 23) * 60;

    function reqGap(aId, bId) {
      var g = breakMin, a = acts[aId], b = acts[bId];
      if ((a && a.offsite) || (b && b.offsite)) g += offsiteBuf;
      g += Math.max(forced[aId] || 0, forced[bId] || 0);
      return g;
    }
    function dayIdx(i) { return i.dayIndex != null ? i.dayIndex : (dayIndex[i.day] != null ? dayIndex[i.day] : 9); }
    function instSort(a, b) { return (dayIdx(a) - dayIdx(b)) || (a.start_min - b.start_min); }
    // do instances of two activities clash (overlap or within the required gap)?
    function clash(i1, a1, i2, a2) {
      if (i1.day !== i2.day) return false;
      var g = reqGap(a1.id, a2.id);
      return i1.start_min < i2.end_min + g && i2.start_min < i1.end_min + g;
    }
    function scheduled(a) { return a && (a.kind === "oneoff" || a.kind === "repeating") && a.instances.length; }
    // Instance candidates for a person. If the activity is locked FOR this person
    // (or n omitted, e.g. seeding consensus) restrict to the locked instance;
    // otherwise they choose freely from all instances.
    function candInsts(a, n) {
      var pi = pinInfo(a.id);
      if (pi && (n == null || pi.people.indexOf(n) >= 0)) {
        var p = a.instances.filter(function (i) { return instanceKey(i) === pi.key; });
        if (p.length) return p;
      }
      return a.instances.slice().sort(instSort);
    }
    function interested(id) {
      var o = []; names.forEach(function (n) { var pr = picksByName[n][id]; if (pr) o.push({ name: n, priority: pr, w: weightOf(pr) }); });
      return o;
    }

    // ---- togetherness consensus: a shared instance per activity ----
    var consensus = {};
    schedule.activities.forEach(function (a) {
      if (!scheduled(a) || !interested(a.id).length) return;
      consensus[a.id] = instanceKey(candInsts(a)[0]);
    });

    // ---- per-person solve: exact B&B over must+want, then greedy if-free ----
    // A LOCKED activity (pinned via "Do these together?") is force-placed for
    // everyone who wants it: it sits just below a must, so the solver will drop
    // lower/equal picks (and relocate flexible ones) to fit it, but never gives up
    // a real must for it.
    var LOCK_W = 5000;
    function solve(n) {
      var picks = picksByName[n];
      // Items in the exact solve: every must/want pick, plus any LOCKED pick of
      // any tier (a locked if-free still gets force-placed). If-free that isn't
      // locked is left for the greedy fill below.
      var items = [];
      for (var id in picks) {
        if (!scheduled(acts[id])) continue;
        var pr = picks[id], lk = lockedFor(id, n);
        if (pr === "must" || pr === "want" || lk) {
          var w = lk ? (pr === "must" ? covWeight("must") : LOCK_W) : covWeight(pr);
          items.push({ a: acts[id], w: w, insts: candInsts(acts[id], n) });
        }
      }
      items.sort(function (x, y) { return (y.w - x.w) || (x.insts.length - y.insts.length); });

      var best = { score: -1, set: [] }, calls = 0;
      function fitsList(inst, a, list) { for (var k = 0; k < list.length; k++) if (clash(inst, a, list[k].inst, list[k].a)) return false; return true; }
      function dfs(idx, cur, curW, curT) {
        if (++calls > 2000000) return;
        var score = curW + together * curT;
        if (score > best.score) best = { score: score, set: cur.slice() };
        if (idx >= items.length) return;
        var rem = 0; for (var k = idx; k < items.length; k++) rem += items[k].w;
        if (curW + rem + together * (curT + (items.length - idx)) <= best.score) return; // optimistic bound
        var it = items[idx];
        for (var j = 0; j < it.insts.length; j++) {
          var inst = it.insts[j];
          if (fitsList(inst, it.a, cur)) {
            var t = consensus[it.a.id] === instanceKey(inst) ? 1 : 0;
            cur.push({ a: it.a, inst: inst, w: it.w }); dfs(idx + 1, cur, curW + it.w, curT + t); cur.pop();
          }
        }
        dfs(idx + 1, cur, curW, curT); // skip this activity
      }
      dfs(0, [], 0, 0);
      var chosen = best.set.map(function (c) { return { a: c.a, inst: c.inst }; });

      // if-free: greedy into remaining gaps, preferring the consensus instance.
      function fitsAll(inst, a) { for (var k = 0; k < chosen.length; k++) if (clash(inst, a, chosen[k].inst, chosen[k].a)) return false; return true; }
      var iff = [];
      for (var id in picks) if (picks[id] === "iffree" && !lockedFor(id, n) && scheduled(acts[id])) iff.push(acts[id]);
      iff.sort(function (x, y) { return x.instances.length - y.instances.length; });
      iff.forEach(function (a) {
        var order = candInsts(a, n).slice().sort(function (p, q) {
          var pc = consensus[a.id] === instanceKey(p) ? 0 : 1, qc = consensus[a.id] === instanceKey(q) ? 0 : 1;
          return (pc - qc) || instSort(p, q);
        });
        for (var j = 0; j < order.length; j++) if (fitsAll(order[j], a)) { chosen.push({ a: a, inst: order[j] }); break; }
      });
      return chosen;
    }

    // Global objective so we can pick the BEST iteration (the consensus loop can
    // oscillate, so we never just trust the last one): total priority weight
    // placed + dial * total co-attendance (extra people sharing an instance).
    function globalScore(asg) {
      var cov = 0, byInst = {};
      names.forEach(function (n) {
        asg[n].forEach(function (c) {
          cov += covWeight(picksByName[n][c.a.id]);
          var k = c.a.id + "@" + instanceKey(c.inst); byInst[k] = (byInst[k] || 0) + 1;
        });
      });
      var tog = 0; for (var k in byInst) tog += Math.max(0, byInst[k] - 1);
      return cov + together * tog;
    }

    // iterate: solve everyone, recompute consensus, keep the best-scoring round.
    var assign = null, bestScore = -Infinity;
    for (var iter = 0; iter < 6; iter++) {
      var cur = {}; names.forEach(function (n) { cur[n] = solve(n); });
      var sc = globalScore(cur);
      if (sc > bestScore) { bestScore = sc; assign = cur; }
      var tally = {};
      names.forEach(function (n) {
        cur[n].forEach(function (c) {
          var id = c.a.id, k = instanceKey(c.inst);
          (tally[id] = tally[id] || {})[k] = (tally[id][k] || 0) + weightOf(picksByName[n][id]);
        });
      });
      var changed = false;
      Object.keys(tally).forEach(function (id) {
        if (pins[id]) return;
        var bk = null, bw = -1;
        for (var k in tally[id]) if (tally[id][k] > bw) { bw = tally[id][k]; bk = k; }
        if (bk && consensus[id] !== bk) { consensus[id] = bk; changed = true; }
      });
      if (!changed) break;
    }
    assign = assign || {};

    // ---- build placements ----
    var sched = {}, dropped = {}, earmarks = {}, ifTime = {};
    names.forEach(function (n) { sched[n] = []; dropped[n] = []; earmarks[n] = []; ifTime[n] = []; });

    function makePlacement(a, inst, type, priority) {
      return {
        activityId: a.id, name: a.name, location: a.location, paid: a.paid, offsite: a.offsite,
        booking: !!a.booking, external: !!a.external, kind: a.kind, type: type,
        priority: priority || null, priorityLabel: priority ? PRIORITY_LABEL[priority] : null,
        day: inst.day, dayIndex: dayIdx(inst), start_min: inst.start_min, end_min: inst.end_min,
        label: inst.label || (inst.day + " " + fmt(inst.start_min) + "-" + fmt(inst.end_min)),
        withWhom: [], backups: [],
      };
    }

    names.forEach(function (n) {
      var got = {};
      assign[n].forEach(function (c) { got[c.a.id] = true; sched[n].push(makePlacement(c.a, c.inst, "booking", picksByName[n][c.a.id])); });
      sched[n].sort(instSort);
      for (var id in picksByName[n]) {
        var a = acts[id];
        if (scheduled(a) && !got[id]) dropped[n].push({ activityId: id, name: a.name, priority: picksByName[n][id], reason: "" });
      }
    });

    // ---- drop-ins (window activities): earmark into free gaps within open hours ----
    function festOpen(day) { var t = toMin(((config.festivalHours || {})[day] || {}).open); return t == null ? 0 : t; }
    function festClose(day) { var t = toMin(((config.festivalHours || {})[day] || {}).close); return t == null ? 24 * 60 : t; }
    function availabilityByDay(a) {
      var map = {};
      (a.windows || []).forEach(function (w) {
        var s = toMin(w.start), e = toMin(w.end);
        if (s == null) s = dropinEarliest;
        if (e == null) e = dropinLatest;
        s = Math.max(s, dropinEarliest, festOpen(w.day));
        e = Math.min(e, dropinLatest, festClose(w.day));
        if (e - s < 1) return;
        map[w.day] = map[w.day] ? [Math.min(map[w.day][0], s), Math.max(map[w.day][1], e)] : [s, e];
      });
      return map;
    }
    function fitsForDropin(n, cand) {
      var list = sched[n].concat(earmarks[n]);
      for (var i = 0; i < list.length; i++) {
        var p = list[i]; if (p.day !== cand.day) continue;
        var g = reqGap(p.activityId, cand.activityId);
        if (!(cand.start_min >= p.end_min + g || p.start_min >= cand.end_min + g)) return false;
      }
      return true;
    }
    function tryPlaceDropin(n, a) {
      var slot = config.dropInSlotMinutes || 45, avail = availabilityByDay(a);
      for (var di = 0; di < days.length; di++) {
        var day = days[di]; if (!avail[day]) continue;
        var as = avail[day][0], ae = avail[day][1];
        var items = sched[n].concat(earmarks[n]).filter(function (p) { return p.day === day; }).sort(function (x, y) { return x.start_min - y.start_min; });
        var pos = [as]; items.forEach(function (it) { pos.push(it.end_min + reqGap(it.activityId, a.id)); });
        for (var pi = 0; pi < pos.length; pi++) {
          var s = Math.max(pos[pi], as), cand = { day: day, start_min: s, end_min: s + slot, activityId: a.id };
          if (cand.end_min <= ae && fitsForDropin(n, cand)) {
            earmarks[n].push(makePlacement(a, { day: day, start_min: s, end_min: s + slot, label: day + " " + fmt(s) + "-" + fmt(s + slot) }, "dropin", picksByName[n][a.id]));
            return true;
          }
        }
      }
      return false;
    }
    var dropins = schedule.activities.filter(function (a) { return a.kind === "dropin"; });
    names.forEach(function (n) {
      dropins.filter(function (a) { return picksByName[n][a.id]; })
        .sort(function (x, y) { return weightOf(picksByName[n][y.id]) - weightOf(picksByName[n][x.id]); })
        .forEach(function (a) {
          if (!tryPlaceDropin(n, a)) ifTime[n].push({ activityId: a.id, name: a.name, priority: picksByName[n][a.id] });
        });
    });

    // ---- who-with + backups ----
    names.forEach(function (n) { earmarks[n].sort(instSort); });
    names.forEach(function (n) {
      sched[n].forEach(function (p) {
        p.withWhom = names.filter(function (m) {
          return m !== n && sched[m].some(function (q) { return q.activityId === p.activityId && q.day === p.day && q.start_min === p.start_min; });
        });
        if (p.kind === "repeating") {
          var a = acts[p.activityId], others = sched[n].filter(function (q) { return q !== p; });
          p.backups = a.instances.filter(function (i) {
            return instanceKey(i) !== instanceKey(p) && others.every(function (q) { return !clash(i, a, q, acts[q.activityId]); });
          }).sort(instSort).slice(0, 2).map(function (i) { return i.label; });
        }
      });
    });

    // ---- couldn't-fit reasons (against the final schedule) ----
    names.forEach(function (n) {
      dropped[n].forEach(function (d) {
        var a = acts[d.activityId]; var blockers = {};
        a.instances.forEach(function (inst) {
          sched[n].forEach(function (p) { if (clash(inst, a, p, acts[p.activityId])) blockers[p.name] = true; });
        });
        var list = Object.keys(blockers);
        d.reason = list.length ? "clashes with " + list.slice(0, 4).join(", ") + (list.length > 4 ? " and " + (list.length - 4) + " more" : "") : "no clash-free time";
      });
    });

    // ---- group view ----
    var byActivity = {};
    schedule.activities.forEach(function (a) {
      if (a.kind === "dropin") return;
      var people = interested(a.id); if (!people.length) return;
      var counts = {};
      names.forEach(function (n) { sched[n].forEach(function (p) { if (p.activityId === a.id) counts[instanceKey(p)] = (counts[instanceKey(p)] || 0) + 1; }); });
      var keys = Object.keys(counts).sort(function (x, y) { return counts[y] - counts[x]; });
      var chosenKey = keys[0] || consensus[a.id] || instanceKey(a.instances[0]);
      var chosenInst = a.instances.filter(function (i) { return instanceKey(i) === chosenKey; })[0] || a.instances[0];
      // Exact current attendance per instance (who is actually placed there now).
      function whoHere(key) {
        return names.filter(function (n) {
          return sched[n].some(function (p) { return p.activityId === a.id && instanceKey(p) === key; });
        });
      }
      var placedSomewhere = names.filter(function (n) {
        return sched[n].some(function (p) { return p.activityId === a.id; });
      });
      byActivity[a.id] = {
        id: a.id, name: a.name, kind: a.kind, paid: a.paid, offsite: a.offsite,
        chosenLabel: chosenInst.label, chosenKey: chosenKey,
        lock: pinInfo(a.id),  // { key, people } or null
        people: people.map(function (p) { return p.name; }),
        notPlaced: people.map(function (p) { return p.name; }).filter(function (n) { return placedSomewhere.indexOf(n) < 0; }),
        groupCount: keys.length ? counts[keys[0]] : 0,
        backups: [], instances: a.instances.map(function (i) {
          var k = instanceKey(i); return { key: k, label: i.label, here: whoHere(k) };
        }),
      };
    });

    function buildByPerson() {
      var out = {};
      names.forEach(function (n) {
        var b = sched[n].filter(function (p) { return p.type === "booking"; });
        var need = b.filter(function (p) { return p.booking; });
        out[n] = {
          paid: need.filter(function (p) { return p.paid; }),
          free: need.filter(function (p) { return !p.paid; }),
          turnup: b.filter(function (p) { return !p.booking; }),
          all: b, dropins: earmarks[n], ifTime: ifTime[n], dropped: dropped[n],
        };
      });
      return out;
    }

    return {
      days: days, bounds: bounds, names: names,
      anyPicks: names.some(function (n) { return Object.keys(picksByName[n]).length > 0; }),
      byPerson: buildByPerson(), byActivity: byActivity,
    };
  }

  window.Engine = { compute: compute, weightOf: weightOf, instanceKey: instanceKey, PRIORITY_LABEL: PRIORITY_LABEL, fmt: fmt };
})();

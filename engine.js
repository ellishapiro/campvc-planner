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

    function instSort(a, b) {
      return (a.dayIndex - b.dayIndex) || (a.start_min - b.start_min);
    }

    // ---- Step 1: one-offs (inflexible) placed first, by priority ----
    schedule.activities.filter(function (a) { return a.kind === "oneoff"; }).forEach(function () {});
    names.forEach(function (n) {
      var wanted = schedule.activities
        .filter(function (a) { return a.kind === "oneoff" && picksByName[n][a.id]; })
        .map(function (a) { return { a: a, w: weightOf(picksByName[n][a.id]) }; });
      wanted.sort(function (x, y) {
        return (y.w - x.w) ||
          (dayIndex[x.a.instances[0].day] - dayIndex[y.a.instances[0].day]) ||
          (x.a.instances[0].start_min - y.a.instances[0].start_min);
      });
      wanted.forEach(function (item) {
        var a = item.a, inst = a.instances[0];
        var cand = candFromInstance(a, inst);
        var clash = conflictFor(n, cand, false);
        if (!clash) {
          place(n, a, inst, "booking", picksByName[n][a.id], false);
        } else {
          dropped[n].push({
            activityId: a.id, name: a.name,
            reason: "clashes with " + clash.name + " (" + clash.label + ")",
          });
        }
      });
    });

    // ---- Step 2: repeating activities, by aggregate interest ----
    var byActivity = {};
    var repeating = schedule.activities.filter(function (a) { return a.kind === "repeating"; });
    repeating.sort(function (x, y) {
      return aggWeight(y) - aggWeight(x);
    });
    function aggWeight(a) {
      return interested(a.id).reduce(function (s, p) { return s + p.weight; }, 0);
    }

    repeating.forEach(function (a) {
      var people = interested(a.id);
      if (!people.length) return;

      var chosen = null, backups = [];
      if (pins[a.id]) {
        chosen = a.instances.filter(function (i) { return instanceKey(i) === pins[a.id]; })[0] || null;
      }
      if (!chosen) {
        var scored = a.instances.map(function (inst) {
          var s = 0, fitNames = [];
          people.forEach(function (p) {
            if (fits(p.name, candFromInstance(a, inst), false)) { s += p.weight; fitNames.push(p.name); }
          });
          return { inst: inst, score: s, count: fitNames.length };
        });
        scored.sort(function (x, y) {
          return (y.score - x.score) || (y.count - x.count) || instSort(x.inst, y.inst);
        });
        chosen = scored[0].inst;
        backups = scored.slice(1)
          .filter(function (x) { return x.count > 0; })
          .slice(0, 2)
          .map(function (x) { return x.inst.label; });
      }

      var groupHere = [];
      people.forEach(function (p) {
        var pr = p.priority;
        if (fits(p.name, candFromInstance(a, chosen), false)) {
          place(p.name, a, chosen, "booking", pr, false);
          groupHere.push(p.name);
        } else {
          var alt = bestAltInstance(a, p.name, chosen);
          if (alt) {
            place(p.name, a, alt, "booking", pr, true);
          } else {
            var clash = conflictFor(p.name, candFromInstance(a, chosen), false);
            dropped[p.name].push({
              activityId: a.id, name: a.name,
              reason: "no clash-free time" + (clash ? " (wanted slot clashes with " + clash.name + ")" : ""),
            });
          }
        }
      });

      byActivity[a.id] = {
        id: a.id, name: a.name, kind: a.kind, paid: a.paid, offsite: a.offsite,
        chosenLabel: chosen.label, chosenKey: instanceKey(chosen),
        people: people.map(function (p) { return p.name; }),
        groupCount: groupHere.length,
        backups: backups,
        instances: a.instances.map(function (i) { return { key: instanceKey(i), label: i.label }; }),
      };
    });

    function bestAltInstance(a, person, exclude) {
      var best = null;
      a.instances.forEach(function (inst) {
        if (exclude && instanceKey(inst) === instanceKey(exclude)) return;
        if (fits(person, candFromInstance(a, inst), false)) {
          if (!best || instSort(inst, best) < 0) best = inst;
        }
      });
      return best;
    }

    // Record one-off group info too (for the group view).
    schedule.activities.filter(function (a) { return a.kind === "oneoff"; }).forEach(function (a) {
      var people = interested(a.id);
      if (!people.length) return;
      byActivity[a.id] = {
        id: a.id, name: a.name, kind: a.kind, paid: a.paid, offsite: a.offsite,
        chosenLabel: a.instances[0].label, chosenKey: instanceKey(a.instances[0]),
        people: people.map(function (p) { return p.name; }),
        groupCount: 0, backups: [],
        instances: [{ key: instanceKey(a.instances[0]), label: a.instances[0].label }],
      };
    });

    // ---- Step 3: earmark drop-ins into free gaps ----
    var dropins = schedule.activities.filter(function (a) { return a.kind === "dropin"; });
    names.forEach(function (n) {
      var wanted = dropins
        .filter(function (a) { return picksByName[n][a.id]; })
        .map(function (a) { return { a: a, w: weightOf(picksByName[n][a.id]) }; });
      wanted.sort(function (x, y) { return y.w - x.w; });
      wanted.forEach(function (item) {
        if (!tryPlaceDropin(n, item.a)) ifTime[n].push({ activityId: item.a.id, name: item.a.name });
      });
    });

    var dropinEarliest = Math.max(bounds.start, (config.dropInEarliestHour || 9) * 60);
    function availabilityByDay(a) {
      var map = {};
      (a.windows || []).forEach(function (w) {
        var s = toMin(w.start);
        var e = toMin(w.end);
        if (s == null) s = dropinEarliest;
        if (e == null) e = bounds.end;
        s = Math.max(s, dropinEarliest);
        e = Math.min(e, bounds.end);
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
        out[n] = {
          paid: bookings.filter(function (p) { return p.paid; }),
          free: bookings.filter(function (p) { return !p.paid; }),
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

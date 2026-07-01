// Quick Node test harness for the engine (no framework).
//   node tests/engine.test.node.js
// Loads the real schedule.json and runs the verification scenarios.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const schedule = JSON.parse(fs.readFileSync(path.join(root, "data/schedule.json"), "utf8"));

// Load engine.js into a sandbox that provides `window`.
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "engine.js"), "utf8"), sandbox);
const Engine = sandbox.window.Engine;

const config = {
  breakMinutes: 0, offsiteBufferMinutes: 30, dropInSlotMinutes: 45,
  dayStartHourFallback: 8, dayEndHourFallback: 23,
};

const byName = {};
schedule.activities.forEach(a => { byName[a.name] = a; });
const id = name => byName[name].id;

let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log("  ok  - " + desc); }
  else { fail++; console.log("  FAIL- " + desc); }
}

// Scenario A: two friends both want Archery (repeating) -> same instance, together.
(function () {
  console.log("\n[A] Repeating activity matchmaking (Archery)");
  const picks = {
    Elli: { [id("Archery")]: "want" },
    Sam: { [id("Archery")]: "want" },
  };
  const r = Engine.compute(schedule, picks, {}, config);
  const e = r.byPerson.Elli.all.find(p => p.name === "Archery");
  const s = r.byPerson.Sam.all.find(p => p.name === "Archery");
  check("Elli gets an Archery slot", !!e);
  check("Sam gets an Archery slot", !!s);
  check("they share the same instance", e && s && e.day === s.day && e.start_min === s.start_min);
  check("who-with shows the other person", e && e.withWhom.includes("Sam"));
})();

// Scenario B: two overlapping must-do one-offs -> lower priority dropped & flagged.
(function () {
  console.log("\n[B] Head-to-head one-off clash");
  // Find two one-off activities that overlap in time on the same day.
  const oneoffs = schedule.activities.filter(a => a.kind === "oneoff");
  let pair = null;
  for (let i = 0; i < oneoffs.length && !pair; i++) {
    for (let j = i + 1; j < oneoffs.length; j++) {
      const x = oneoffs[i].instances[0], y = oneoffs[j].instances[0];
      if (x.day === y.day && x.start_min < y.end_min && y.start_min < x.end_min) {
        pair = [oneoffs[i], oneoffs[j]]; break;
      }
    }
  }
  if (!pair) { check("found an overlapping one-off pair", false); return; }
  const picks = { Elli: {} };
  picks.Elli[pair[0].id] = "must";
  picks.Elli[pair[1].id] = "iffree";
  const r = Engine.compute(schedule, picks, {}, config);
  const placed = r.byPerson.Elli.all.map(p => p.activityId);
  const droppedIds = r.byPerson.Elli.dropped.map(d => d.activityId);
  check("the must-do is kept", placed.includes(pair[0].id));
  check("the if-free is dropped", droppedIds.includes(pair[1].id));
  check("drop has a reason", r.byPerson.Elli.dropped.length > 0 && /clash/.test(r.byPerson.Elli.dropped[0].reason));
})();

// Scenario C: off-site activity forces a buffer before/after.
(function () {
  console.log("\n[C] Off-site buffer");
  const offsite = schedule.activities.find(a => a.offsite && a.kind !== "dropin");
  // Find a bookable activity whose instance starts shortly after the off-site ends.
  const oi = offsite.instances[0];
  let neighbour = null, nInst = null;
  schedule.activities.forEach(a => {
    if (a === offsite || a.kind === "dropin") return;
    a.instances.forEach(inst => {
      if (inst.day !== oi.day) return;
      const gap = inst.start_min - oi.end_min;
      if (gap >= 0 && gap < 30) { neighbour = a; nInst = inst; }
    });
  });
  if (!neighbour) { console.log("  (no neighbour within 30min; skipping)"); return; }
  const picks = { Elli: {} };
  picks.Elli[offsite.id] = "must";
  picks.Elli[neighbour.id] = "must";
  const r = Engine.compute(schedule, picks, {}, config);
  const sched = r.byPerson.Elli.all;
  check("off-site is booked", sched.some(p => p.activityId === offsite.id));
  // The real guarantee: nothing in the final schedule sits within 30min of the
  // off-site activity (buffer respected), whichever instances were chosen.
  const off = sched.find(p => p.offsite);
  let violation = false;
  if (off) {
    sched.forEach(p => {
      if (p === off || p.day !== off.day) return;
      const gap = p.start_min >= off.end_min ? p.start_min - off.end_min
        : (off.start_min >= p.end_min ? off.start_min - p.end_min : -1);
      if (gap < 30) violation = true; // overlap or within buffer
    });
  }
  check("off-site buffer (30min) respected in final schedule", !violation);
})();

// Scenario D: drop-in is earmarked on the calendar but never in booking lists.
(function () {
  console.log("\n[D] Drop-in earmarking");
  const dropin = schedule.activities.find(a => a.kind === "dropin" && (a.windows || []).length);
  const picks = { Elli: {} };
  picks.Elli[dropin.id] = "want";
  const r = Engine.compute(schedule, picks, {}, config);
  const inDropins = r.byPerson.Elli.dropins.some(p => p.activityId === dropin.id);
  const inBookings = r.byPerson.Elli.all.some(p => p.activityId === dropin.id);
  check("drop-in earmarked on calendar", inDropins || r.byPerson.Elli.ifTime.some(x => x.activityId === dropin.id));
  check("drop-in NOT in booking list", !inBookings);
})();

// Scenario E: pin knob overrides the chosen instance.
(function () {
  console.log("\n[E] Pin instance knob");
  const arch = byName["Archery"];
  const target = arch.instances[arch.instances.length - 1]; // last instance
  const key = target.day + "|" + target.start_min;
  const picks = { Elli: { [arch.id]: "want" } };
  const r = Engine.compute(schedule, picks, { pins: { [arch.id]: key } }, config);
  const e = r.byPerson.Elli.all.find(p => p.activityId === arch.id);
  check("Archery placed at pinned instance", e && e.day === target.day && e.start_min === target.start_min);
})();

// Scenario F: a flexible activity relocates to make room for a constrained one.
(function () {
  console.log("\n[F] Relocation - flexible activity yields its slot");
  const fake = {
    days: ["D1"],
    activities: [
      { id: "A", name: "A-flex", location: "", offsite: false, paid: false, categories: [], kind: "repeating",
        instances: [
          { day: "D1", start_min: 600, end_min: 650, label: "D1 10:00-10:50" },
          { day: "D1", start_min: 840, end_min: 890, label: "D1 14:00-14:50" }], windows: [] },
      { id: "B", name: "B-tight", location: "", offsite: false, paid: false, categories: [], kind: "repeating",
        instances: [
          { day: "D1", start_min: 600, end_min: 650, label: "D1 10:00-10:50" },
          { day: "D1", start_min: 630, end_min: 680, label: "D1 10:30-11:20" }], windows: [] },
    ],
  };
  // A is must (placed first); B is want and only has early slots clashing with A.
  const r = Engine.compute(fake, { P: { A: "must", B: "want" } }, {}, config);
  const ids = r.byPerson.P.all.map(p => p.activityId).sort();
  check("both A and B are scheduled (A moved aside)", ids.join(",") === "A,B");
  check("nothing dropped", r.byPerson.P.dropped.length === 0);
})();

// Scenario G: drop-ins are actually earmarked on the calendar (regression).
(function () {
  console.log("\n[G] Drop-ins get earmarked (not just 'if time')");
  const dropins = schedule.activities.filter(a => a.kind === "dropin" && (a.windows || []).length).slice(0, 2);
  const picks = { Elli: {} };
  dropins.forEach(a => { picks.Elli[a.id] = "want"; });
  const r = Engine.compute(schedule, picks, {}, config);
  check("both drop-ins earmarked on the calendar", r.byPerson.Elli.dropins.length === 2);
  check("none fell through to 'if time'", r.byPerson.Elli.ifTime.length === 0);
})();

// Scenario H: a per-person lock binds only the listed people.
(function () {
  console.log("\n[H] Per-person lock");
  const fake = {
    days: ["D1"],
    activities: [
      { id: "X", name: "X", location: "", offsite: false, paid: false, categories: [], kind: "repeating",
        instances: [
          { day: "D1", start_min: 600, end_min: 650, label: "D1 10:00-10:50" },
          { day: "D1", start_min: 840, end_min: 890, label: "D1 14:00-14:50" }], windows: [] },
      { id: "Z", name: "Z", location: "", offsite: false, paid: false, categories: [], kind: "oneoff",
        instances: [{ day: "D1", start_min: 840, end_min: 890, label: "D1 14:00-14:50" }], windows: [] },
    ],
  };
  // P1 and P2 both want X. Lock X to the 14:00 instance for P1 ONLY. P2 also has a
  // must (Z) at 14:00, so if the lock wrongly bound P2 it would collide.
  const picks = { P1: { X: "want" }, P2: { X: "want", Z: "must" } };
  const key = "D1|840";
  const r = Engine.compute(fake, picks, { pins: { X: { key: key, people: ["P1"] } } }, config);
  const x1 = r.byPerson.P1.all.find(p => p.activityId === "X");
  const x2 = r.byPerson.P2.all.find(p => p.activityId === "X");
  const z2 = r.byPerson.P2.all.find(p => p.activityId === "Z");
  check("locked person P1 is on the locked 14:00 instance", x1 && x1.start_min === 840);
  check("unlocked person P2 keeps their must Z at 14:00", z2 && z2.start_min === 840);
  check("unlocked person P2's X is NOT forced onto the locked time", x2 && x2.start_min === 600);
})();

// Scenario I: legacy string pin locks only the legacy people (config default).
(function () {
  console.log("\n[I] Legacy string pin -> legacyLockPeople only");
  const fake = {
    days: ["D1"],
    activities: [{ id: "X", name: "X", location: "", offsite: false, paid: false, categories: [], kind: "repeating",
      instances: [
        { day: "D1", start_min: 600, end_min: 650, label: "D1 10:00-10:50" },
        { day: "D1", start_min: 840, end_min: 890, label: "D1 14:00-14:50" }], windows: [] }],
  };
  const cfg = Object.assign({}, config, { legacyLockPeople: ["Old"] });
  const picks = { Old: { X: "want" }, New: { X: "want" } };
  const r = Engine.compute(fake, picks, { pins: { X: "D1|840" } }, cfg);
  const old = r.byPerson.Old.all.find(p => p.activityId === "X");
  check("legacy-listed person is locked to 14:00", old && old.start_min === 840);
  // 'New' isn't in legacyLockPeople, so isn't force-locked (togetherness may still
  // co-locate, but it must not be *restricted* to the pinned instance) - sanity:
  check("New person still scheduled", r.byPerson.New.all.some(p => p.activityId === "X"));
})();

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

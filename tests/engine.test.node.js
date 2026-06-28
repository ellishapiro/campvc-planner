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
  const hasOff = r.byPerson.Elli.all.some(p => p.activityId === offsite.id);
  const placedNeighbourSame = r.byPerson.Elli.all.some(
    p => p.activityId === neighbour.id && p.day === nInst.day && p.start_min === nInst.start_min);
  check("off-site is booked", hasOff);
  check("neighbour within buffer is NOT placed at the clashing instance",
    !placedNeighbourSame || (nInst.start_min - oi.end_min >= 30));
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

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);

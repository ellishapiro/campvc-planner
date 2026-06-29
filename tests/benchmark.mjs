// Scheduling-quality benchmark: compare the engine's greedy result against an
// EXACT per-person optimum (branch-and-bound) for the scheduled must/want picks.
// Answers: is the greedy leaving higher-priority picks unscheduled that a perfect
// scheduler would fit?  Run: node tests/benchmark.mjs
import fs from "node:fs"; import vm from "node:vm";
const sb = { window: {}, console };
vm.createContext(sb);
["data/schedule.js", "data/migrations.js", "engine.js"].forEach(f => vm.runInContext(fs.readFileSync(f, "utf8"), sb));
const S = sb.window.SCHEDULE, E = sb.window.Engine, M = sb.window.MIGRATIONS;
const acts = {}; S.activities.forEach(a => acts[a.id] = a);

// live picks (or fall back to a synthetic set if offline)
let rowsRaw = process.env.PICKS_JSON && fs.existsSync(process.env.PICKS_JSON)
  ? JSON.parse(fs.readFileSync(process.env.PICKS_JSON, "utf8")) : null;
if (!rowsRaw) { console.error("Pass PICKS_JSON=path to live picks json"); process.exit(2); }
const latest = {}; rowsRaw.forEach(r => { if (!latest[r.name] || r.ts > latest[r.name].ts) latest[r.name] = r; });
const mig = p => { const o = {}; for (const k in p) o[M[k] || k] = p[k]; return o; };
const NAMES = (sb.window.CONFIG && sb.window.CONFIG.friends) || ["Abs", "Elli", "Jess", "Mummy"];
const W = { must: 3, want: 2, iffree: 1 };

const cfg = { breakMinutes: 0, offsiteBufferMinutes: 30, dropInSlotMinutes: 45, dropInEarliestHour: 9, dayEndHourFallback: 23, festivalHours: S.festivalHours };
const pbn = {}; NAMES.forEach(n => pbn[n] = latest[n] ? mig(latest[n].picks) : {});
const result = E.compute(S, pbn, {}, cfg);

const gap = (a, b) => ((a && a.offsite) || (b && b.offsite)) ? 30 : 0;
const overlap = (i, j, a, b) => i.day === j.day && i.start_min < j.end_min + gap(a, b) && j.start_min < i.end_min + gap(a, b);

// EXACT optimum: max-weight subset of scheduled must/want picks, <=1 instance per
// activity, no overlaps. Branch-and-bound, most-constrained-first with pruning.
function optimum(picks) {
  var items = Object.keys(picks)
    .filter(id => acts[id] && (acts[id].kind === "oneoff" || acts[id].kind === "repeating") && (picks[id] === "must" || picks[id] === "want"))
    .map(id => ({ a: acts[id], w: W[picks[id]], insts: acts[id].instances }))
    .sort((x, y) => x.insts.length - y.insts.length); // tightest first
  var best = { w: 0, n: 0 };
  var calls = 0;
  function dfs(idx, chosen, curW, curN) {
    if (++calls > 4000000) return; // safety cap
    if (curW > best.w) best = { w: curW, n: curN };
    if (idx >= items.length) return;
    // optimistic bound: assume all remaining fit
    var rem = 0; for (var k = idx; k < items.length; k++) rem += items[k].w;
    if (curW + rem <= best.w) return;
    var it = items[idx];
    for (var j = 0; j < it.insts.length; j++) {
      var inst = it.insts[j];
      var ok = true;
      for (var c = 0; c < chosen.length; c++) { if (overlap(inst, chosen[c].inst, it.a, chosen[c].a)) { ok = false; break; } }
      if (ok) { chosen.push({ inst: inst, a: it.a }); dfs(idx + 1, chosen, curW + it.w, curN + 1); chosen.pop(); }
    }
    dfs(idx + 1, chosen, curW, curN); // skip this activity
  }
  dfs(0, [], 0, 0);
  return best;
}

console.log("Per-person scheduled MUST/WANT satisfaction - engine vs exact optimum:\n");
var anyGap = false;
NAMES.forEach(n => {
  var picks = pbn[n]; if (!Object.keys(picks).length) return;
  var schedMW = Object.keys(picks).filter(id => acts[id] && (acts[id].kind === "oneoff" || acts[id].kind === "repeating") && (picks[id] === "must" || picks[id] === "want"));
  var totalW = schedMW.reduce((s, id) => s + W[picks[id]], 0);
  var placed = result.byPerson[n].all.filter(p => p.booking || p.priority); // scheduled bookings/turnups
  var gotIds = new Set(placed.map(p => p.activityId));
  var greedyW = schedMW.filter(id => gotIds.has(id)).reduce((s, id) => s + W[picks[id]], 0);
  var greedyN = schedMW.filter(id => gotIds.has(id)).length;
  var opt = optimum(picks);
  var flag = opt.w > greedyW ? "  <-- ENGINE BELOW OPTIMUM" : "  (optimal)";
  if (opt.w > greedyW) anyGap = true;
  console.log(`${n}: picked ${schedMW.length} must/want (weight ${totalW}) | engine ${greedyN}/weight ${greedyW} | optimum weight ${opt.w} (${opt.n} picks)${flag}`);
});
console.log("\n" + (anyGap ? "=> Engine is leaving must/want picks unscheduled vs the optimum." : "=> Engine matches the optimum on must/want coverage."));

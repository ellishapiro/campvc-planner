// Store merge test - proves a stale client can't wipe others' knobs (the 13:25 bug),
// and that a real deletion still propagates.  node tests/store.test.node.js
const fs = require("fs"); const path = require("path"); const vm = require("vm");
const root = path.join(__dirname, "..");

var ls = (function () { var m = {}; return { getItem: function (k) { return k in m ? m[k] : null; }, setItem: function (k, v) { m[k] = String(v); }, removeItem: function (k) { delete m[k]; } }; })();
var sandbox = {
  window: { CONFIG: { legacyLockPeople: ["Abs", "Elli", "Jess", "Mummy"] } },
  localStorage: ls, console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
  document: { createElement: function () { return {}; }, body: { appendChild: function () {}, removeChild: function () {} } },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "store.js"), "utf8"), sandbox);
const Store = sandbox.window.Store;

let pass = 0, fail = 0;
function check(d, c) { if (c) { pass++; console.log("  ok  - " + d); } else { fail++; console.log("  FAIL- " + d); } }

(async function () {
  console.log("[store] merge-on-save (local mode)");
  check("runs in local mode (no appsScriptUrl)", Store.isLocal === true);

  // Scenario: server has a rich state; a STALE client (baseline empty) makes one edit.
  ls.setItem("campvc_knobs", JSON.stringify({ booked: { A: { Elli: "x" }, B: { Abs: "y" } }, pins: { P: { Jess: "k" } } }));
  let r = await Store.saveKnobs({ couldNotBook: { Q: { Sophie: "*" } } }, {}, "Sophie");
  check("others' bookings survive a stale save", r.merged.booked && r.merged.booked.A && r.merged.booked.B);
  check("others' pins survive a stale save", r.merged.pins && r.merged.pins.P && r.merged.pins.P.Jess === "k");
  check("the stale client's own edit is applied", r.merged.couldNotBook && r.merged.couldNotBook.Q);

  // Scenario: a genuine deletion (local removed a leaf vs its baseline) propagates.
  ls.setItem("campvc_knobs", JSON.stringify({ booked: { A: { Elli: "x" } } }));
  r = await Store.saveKnobs({ booked: {} }, { booked: { A: { Elli: "x" } } }, "Elli");
  check("a real un-book propagates (leaf removed)", !(r.merged.booked && r.merged.booked.A));

  // Scenario: concurrent edits to different people on the SAME activity both survive.
  ls.setItem("campvc_knobs", JSON.stringify({ booked: { A: { Elli: "x" } } }));   // Elli booked on server
  r = await Store.saveKnobs({ booked: { A: { Abs: "z" } } }, {}, "Abs");           // Abs books, stale of Elli's
  check("concurrent per-person edits merge (both Abs and Elli)", r.merged.booked.A.Abs === "z" && r.merged.booked.A.Elli === "x");

  console.log("[store] savePicks wipe-guard");
  ls.setItem("campvc_picks", JSON.stringify({ Elli: { archery: "must", bmx: "want" } }));
  r = await Store.savePicks("Elli", {});
  check("empty save over non-empty picks is BLOCKED", r.ok === false && r.blocked === true);
  check("existing picks untouched after a blocked save", Object.keys(JSON.parse(ls.getItem("campvc_picks")).Elli).length === 2);
  r = await Store.savePicks("Elli", {}, true);
  check("empty save with force:true does clear", r.ok === true && Object.keys(JSON.parse(ls.getItem("campvc_picks")).Elli || {}).length === 0);
  ls.setItem("campvc_picks", JSON.stringify({}));
  r = await Store.savePicks("Kate", {});
  check("empty save for a brand-new person is allowed (nothing to wipe)", r.ok === true);
  r = await Store.savePicks("Elli", { archery: "must" });
  check("a normal non-empty save still works", r.ok === true && JSON.parse(ls.getItem("campvc_picks")).Elli.archery === "must");

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();

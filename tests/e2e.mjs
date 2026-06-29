// End-to-end test for the Camp VC planner. No dependencies - uses Node 22's
// built-in fetch + WebSocket to drive headless Chrome via the DevTools Protocol.
//
//   node tests/e2e.mjs
//
// It serves the project over http, then in a real browser: opens the picks page,
// selects two people, ticks activities, saves (localStorage in local mode),
// opens the results page, asserts the calendar + booking lists rendered, and
// writes screenshots to tests/_shots/. Exit code 0 = all assertions passed.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const shotDir = path.join(here, "_shots");
fs.mkdirSync(shotDir, { recursive: true });

const PORT = 8123;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

// ---- tiny static server ----
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end("nf"); }
  // SAFETY: always serve config.js with a blank appsScriptUrl so tests run in
  // LOCAL mode (localStorage) and can NEVER read or write the live Google sheet.
  if (p === "/config.js") {
    const cfg = fs.readFileSync(file, "utf8").replace(/appsScriptUrl:\s*"[^"]*"/, 'appsScriptUrl: ""');
    res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" });
    return res.end(cfg);
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "text/plain", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
});

function findChrome() {
  const cands = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error("No Chrome/Edge found");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- minimal CDP client ----
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); this.session = null;
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && this.waiters.has(m.id)) { const w = this.waiters.get(m.id); this.waiters.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } }; }
  send(method, params = {}, useSession = true) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (useSession && this.session) msg.sessionId = this.session;
    return new Promise((res, rej) => { this.waiters.set(id, { res, rej }); this.ws.send(JSON.stringify(msg)); });
  }
  async evalp(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("page eval threw: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async waitFor(expr, desc, timeout = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (await this.evalp(`!!(${expr})`)) return true; await sleep(120); }
    throw new Error("timeout waiting for: " + desc);
  }
  async navigate(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState==='complete'", "load " + url);
  }
}

let pass = 0, fail = 0;
const check = (d, ok) => { if (ok) { pass++; console.log("  ok  - " + d); } else { fail++; console.log("  FAIL- " + d); } };

async function shot(cdp, name) {
  const h = await cdp.evalp("Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)");
  const w = await cdp.evalp("document.documentElement.clientWidth");
  const r = await cdp.send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: w, height: Math.min(h, 4000), scale: 1 },
  });
  fs.writeFileSync(path.join(shotDir, name), Buffer.from(r.data, "base64"));
  console.log("  shot  -> tests/_shots/" + name);
}

async function main() {
  await new Promise((r) => server.listen(PORT, r));
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "cvc-e2e-"));
  const chrome = spawn(findChrome(), [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--remote-debugging-port=9333", "--user-data-dir=" + userDir,
    "--window-size=1300,1700", "about:blank",
  ]);

  try {
    // discover the browser websocket endpoint
    let wsUrl;
    for (let i = 0; i < 50 && !wsUrl; i++) {
      try { const v = await (await fetch("http://localhost:9333/json/version")).json(); wsUrl = v.webSocketDebuggerUrl; }
      catch { await sleep(200); }
    }
    if (!wsUrl) throw new Error("Chrome devtools not reachable");

    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const cdp = new CDP(ws);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }, false);
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, false);
    cdp.session = sessionId;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    const base = `http://localhost:${PORT}`;

    // ---------- PICKS: person 1 ----------
    console.log("\n[picks] Elli");
    await cdp.navigate(base + "/index.html");
    check("local-mode flag visible", await cdp.evalp("!document.getElementById('localFlag').hidden"));
    await cdp.evalp("(function(){var s=document.getElementById('who');s.value='Elli';s.dispatchEvent(new Event('change'));return true;})()");
    await cdp.waitFor("!document.getElementById('saveBtn').disabled", "Elli picks loaded");

    // helper injected into the page to click a priority by activity name
    const clicker = `function(name,v){var rows=[].slice.call(document.querySelectorAll('.act'));var row=rows.filter(function(r){return r.querySelector('.nm').textContent.indexOf(name)===0;})[0];if(!row)return 'NOFIND:'+name;row.querySelector('.seg button[data-v="'+v+'"]').click();return 'ok';}`;
    const click = async (name, v) => cdp.evalp(`(${clicker})(${JSON.stringify(name)},${JSON.stringify(v)})`);
    check("tick Archery=must", (await click("Archery", "must")) === "ok");
    check("tick Climbing Wall=want", (await click("Climbing Wall", "want")) === "ok");
    check("tick White Water Rafting=must (off-site)", (await click("White Water Rafting", "must")) === "ok");
    check("tick Forest Bathing=iffree", (await click("Forest Bathing", "iffree")) === "ok");
    await cdp.evalp("document.getElementById('saveBtn').click()");
    await cdp.waitFor("/saved/.test(document.getElementById('saveStatus').textContent)", "Elli saved");
    check("Elli stored in localStorage", await cdp.evalp("Object.keys((JSON.parse(localStorage.getItem('campvc_picks'))||{}).Elli||{}).length>=4"));
    await shot(cdp, "1-picks.png");

    // ---------- PICKS: person 2 ----------
    console.log("\n[picks] Abs");
    await cdp.evalp("(function(){var s=document.getElementById('who');s.value='Abs';s.dispatchEvent(new Event('change'));return true;})()");
    await cdp.waitFor("!document.getElementById('saveBtn').disabled", "Abs picks loaded");
    await click("Archery", "want");           // shared with Elli
    await click("Climbing Wall", "must");     // shared
    await cdp.evalp("document.getElementById('saveBtn').click()");
    await cdp.waitFor("/saved/.test(document.getElementById('saveStatus').textContent)", "Abs saved");

    // ---------- RESULTS ----------
    console.log("\n[results]");
    await cdp.navigate(base + "/results.html");
    await cdp.waitFor("!document.getElementById('main').hidden", "results rendered");
    const blocks = await cdp.evalp("document.querySelectorAll('#cal .block').length");
    check("calendar has blocks", blocks > 0);
    check("Elli has a booking card", await cdp.evalp("[].some.call(document.querySelectorAll('.card h3'),function(h){return h.textContent==='Elli';})"));
    // Archery should be shared - appears with a 'with' note somewhere
    check("a shared session shows 'with' someone", await cdp.evalp("[].some.call(document.querySelectorAll('.bk .with'),function(w){return /with/.test(w.textContent);})"));
    check("off-site appears in a booking list", await cdp.evalp("/off-site/i.test(document.getElementById('people').textContent)"));
    // switch days to confirm tabs work
    await cdp.evalp("(function(){var b=document.querySelectorAll('#dayTabs button')[1];b&&b.click();return true;})()");
    await sleep(200);
    await cdp.evalp("(function(){var b=document.querySelectorAll('#dayTabs button')[0];b&&b.click();return true;})()");
    // turn on the full-schedule reference column
    await cdp.evalp("(function(){var c=document.getElementById('showRef');c.checked=true;c.dispatchEvent(new Event('change'));return true;})()");
    await sleep(200);
    check("full-schedule column renders", await cdp.evalp("document.querySelectorAll('.refcol .ref-item').length>0"));
    await shot(cdp, "2-results.png");

    // ---------- ADJUST KNOB ----------
    console.log("\n[adjust] global break = 30");
    await cdp.evalp("document.getElementById('adjust').open=true");
    await cdp.evalp("(function(){var i=document.querySelector('#adjustBody input[type=number]');i.value='30';i.dispatchEvent(new Event('change'));return true;})()");
    await cdp.waitFor("/saved/.test((document.getElementById('knobStatus')||{}).textContent||'')", "knob saved");
    check("break knob persisted to store", await cdp.evalp("(JSON.parse(localStorage.getItem('campvc_knobs'))||{}).breakMinutes===30"));

    // ---------- CACHING: draft survives tabbing between views ----------
    console.log("\n[caching] draft survives tabbing + unsaved flag");
    const pressed = (name, v) => `(function(){var r=[].slice.call(document.querySelectorAll('.act')).filter(function(x){return x.querySelector('.nm').textContent.indexOf(${JSON.stringify(name)})===0;})[0];return !!r&&r.querySelector('.seg button[data-v="'+${JSON.stringify(v)}+'"]').getAttribute('aria-pressed')==='true';})()`;
    await cdp.navigate(base + "/index.html");
    check("name restored without re-selecting", await cdp.evalp("document.getElementById('who').value==='Abs'"));
    check("picks restored (Climbing Wall=must)", await cdp.evalp(pressed("Climbing Wall", "must")));
    check("no unsaved flag right after restore", await cdp.evalp("document.getElementById('dirtyFlag').hidden"));
    await click("Forest Bathing", "want");                 // an unsaved edit
    check("unsaved flag shows after an edit", await cdp.evalp("!document.getElementById('dirtyFlag').hidden"));
    await cdp.navigate(base + "/results.html");
    await cdp.waitFor("!document.getElementById('main').hidden", "results again");
    await cdp.navigate(base + "/index.html");
    check("unsaved edit preserved after round-trip", await cdp.evalp(pressed("Forest Bathing", "want")));
    check("unsaved flag still shown after round-trip", await cdp.evalp("!document.getElementById('dirtyFlag').hidden"));

    // ---------- BOOKING LIST (third tab) ----------
    console.log("\n[booking] phase-first checklist");
    await cdp.navigate(base + "/booking.html");
    await cdp.waitFor("!document.getElementById('main').hidden", "booking rendered");
    check("Phase 1 (Paid) section present", await cdp.evalp("/Phase 1/.test(document.getElementById('content').textContent)"));
    check("Phase 2 (Free) section present", await cdp.evalp("/Phase 2/.test(document.getElementById('content').textContent)"));
    check("has bookable items with checkboxes", await cdp.evalp("document.querySelectorAll('.bkitem input[type=checkbox]').length>0"));
    await cdp.evalp("(function(){document.querySelector('.bkitem input[type=checkbox]').click();return true;})()");
    check("ticking an item persists (marked booked)", await cdp.evalp("Object.keys(JSON.parse(localStorage.getItem('campvc_booked')||'{}')).length>0"));
    await shot(cdp, "3-booking.png");

    // ---------- THEME: light/dark toggle ----------
    console.log("\n[theme] light/dark toggle");
    await cdp.evalp("document.getElementById('themeToggle').click()");
    check("theme override applied (light)", await cdp.evalp("document.documentElement.getAttribute('data-theme')==='light'"));
    check("theme choice persisted", await cdp.evalp("localStorage.getItem('campvc_theme')==='light'"));
    await cdp.navigate(base + "/results.html");
    await cdp.waitFor("!document.getElementById('main').hidden", "results (light)");
    check("theme persists across pages", await cdp.evalp("document.documentElement.getAttribute('data-theme')==='light'"));
    await shot(cdp, "4-results-light.png");

    await ws.close();
  } finally {
    chrome.kill();
    server.close();
  }

  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error("E2E ERROR:", e.message); server.close(); process.exit(1); });

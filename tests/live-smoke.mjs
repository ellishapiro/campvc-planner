// Live deployment smoke test: drives a real browser against the deployed
// GitHub Pages site + Google Apps Script backend to prove the cross-origin
// save/read path works. Cleans up after itself (resets the test pick).
//   node tests/live-smoke.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const BASE = "https://ellishapiro.github.io/campvc-planner";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function findChrome() {
  for (const c of [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ]) if (fs.existsSync(c)) return c;
  throw new Error("no browser");
}
class CDP {
  constructor(ws){this.ws=ws;this.id=0;this.w=new Map();this.session=null;
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.w.has(m.id)){const x=this.w.get(m.id);this.w.delete(m.id);m.error?x.rej(new Error(m.error.message)):x.res(m.result);}};}
  send(method,params={},useSession=true){const id=++this.id;const msg={id,method,params};if(useSession&&this.session)msg.sessionId=this.session;return new Promise((res,rej)=>{this.w.set(id,{res,rej});this.ws.send(JSON.stringify(msg));});}
  async ev(expr){const r=await this.send("Runtime.evaluate",{expression:expr,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
  async waitFor(expr,desc,t=20000){const t0=Date.now();while(Date.now()-t0<t){if(await this.ev(`!!(${expr})`))return true;await sleep(200);}throw new Error("timeout: "+desc);}
  async nav(url){await this.send("Page.navigate",{url});await this.waitFor("document.readyState==='complete'","load "+url);}
}
let pass=0,fail=0;const check=(d,ok)=>{ok?(pass++,console.log("  ok  - "+d)):(fail++,console.log("  FAIL- "+d));};

const chrome=spawn(findChrome(),["--headless=new","--disable-gpu","--no-sandbox","--no-first-run","--remote-debugging-port=9444","--user-data-dir="+fs.mkdtempSync(path.join(os.tmpdir(),"cvc-live-")),"about:blank"]);
try{
  let wsUrl;for(let i=0;i<50&&!wsUrl;i++){try{wsUrl=(await (await fetch("http://localhost:9444/json/version")).json()).webSocketDebuggerUrl;}catch{await sleep(200);}}
  const ws=new WebSocket(wsUrl);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
  const cdp=new CDP(ws);
  const {targetId}=await cdp.send("Target.createTarget",{url:"about:blank"},false);
  const {sessionId}=await cdp.send("Target.attachToTarget",{targetId,flatten:true},false);
  cdp.session=sessionId;await cdp.send("Page.enable");await cdp.send("Runtime.enable");

  console.log("[live] picks page");
  await cdp.nav(BASE+"/index.html");
  check("deployed in SHARED mode (no local flag)", await cdp.ev("document.getElementById('localFlag').hidden"));
  await cdp.ev("(function(){var s=document.getElementById('who');s.value='Elli';s.dispatchEvent(new Event('change'));return true;})()");
  await cdp.waitFor("!document.getElementById('saveBtn').disabled","Elli loaded from backend");
  check("read path works (picks loaded from Google)", true);
  // tick one activity and save -> exercises cross-origin write + verify
  const clicked = await cdp.ev("(function(){var r=[].slice.call(document.querySelectorAll('.act')).filter(x=>x.querySelector('.nm').textContent.indexOf('Archery')===0)[0];if(!r)return false;r.querySelector('.seg button[data-v=\"want\"]').click();return true;})()");
  check("could tick an activity", clicked);
  await cdp.ev("document.getElementById('saveBtn').click()");
  await cdp.waitFor("/saved|NOT saved/.test(document.getElementById('saveStatus').textContent)","save resolved");
  const status = await cdp.ev("document.getElementById('saveStatus').textContent");
  check("WRITE path works (saved to Google): "+JSON.stringify(status), /(^|[^T])saved/.test(status) && !/NOT saved/.test(status));

  console.log("[live] cleanup - reset Elli to no picks");
  await cdp.ev("(function(){var r=[].slice.call(document.querySelectorAll('.act')).filter(x=>x.querySelector('.nm').textContent.indexOf('Archery')===0)[0];r.querySelector('.seg button[data-v=\"want\"]').click();return true;})()");
  await cdp.ev("document.getElementById('saveBtn').click()");
  await cdp.waitFor("/saved/.test(document.getElementById('saveStatus').textContent)","reset saved");
  check("cleanup save resolved", true);

  await ws.close();
}finally{ chrome.kill(); }
console.log("\n"+pass+" passed, "+fail+" failed");
process.exit(fail?1:0);

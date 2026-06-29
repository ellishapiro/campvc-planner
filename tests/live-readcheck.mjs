// READ-ONLY live check: opens the deployed results page, confirms each friend's
// migrated picks render (no saving, never writes to the sheet).
import fs from "node:fs"; import os from "node:os"; import path from "node:path"; import { spawn } from "node:child_process";
const BASE = "https://ellishapiro.github.io/campvc-planner";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chromePath = ["C:/Program Files/Google/Chrome/Application/chrome.exe","C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(p=>fs.existsSync(p));
class CDP{constructor(ws){this.ws=ws;this.id=0;this.w=new Map();this.session=null;ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.w.has(m.id)){const x=this.w.get(m.id);this.w.delete(m.id);m.error?x.rej(new Error(m.error.message)):x.res(m.result);}};}
 send(method,params={},us=true){const id=++this.id;const msg={id,method,params};if(us&&this.session)msg.sessionId=this.session;return new Promise((res,rej)=>{this.w.set(id,{res,rej});this.ws.send(JSON.stringify(msg));});}
 async ev(e){const r=await this.send("Runtime.evaluate",{expression:e,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;}
 async waitFor(e,d,t=25000){const t0=Date.now();while(Date.now()-t0<t){if(await this.ev(`!!(${e})`))return true;await sleep(300);}throw new Error("timeout: "+d);}
 async nav(u){await this.send("Page.navigate",{url:u});await this.waitFor("document.readyState==='complete'","load");}}
const chrome=spawn(chromePath,["--headless=new","--disable-gpu","--no-sandbox","--no-first-run","--remote-debugging-port=9555","--user-data-dir="+fs.mkdtempSync(path.join(os.tmpdir(),"cvc-read-")),"about:blank"]);
let pass=0,fail=0;const check=(d,ok)=>{ok?(pass++,console.log("  ok  - "+d)):(fail++,console.log("  FAIL- "+d));};
try{
 let wsUrl;for(let i=0;i<50&&!wsUrl;i++){try{wsUrl=(await(await fetch("http://localhost:9555/json/version")).json()).webSocketDebuggerUrl;}catch{await sleep(200);}}
 const ws=new WebSocket(wsUrl);await new Promise((res,rej)=>{ws.onopen=res;ws.onerror=rej;});
 const cdp=new CDP(ws);
 const {targetId}=await cdp.send("Target.createTarget",{url:"about:blank"},false);
 const {sessionId}=await cdp.send("Target.attachToTarget",{targetId,flatten:true},false);
 cdp.session=sessionId;await cdp.send("Page.enable");await cdp.send("Runtime.enable");
 await cdp.nav(BASE+"/results.html");
 await cdp.waitFor("!document.getElementById('main').hidden || /Nobody/.test(document.getElementById('status').textContent)","results");
 const blocks=await cdp.ev("document.querySelectorAll('#cal .block').length");
 check("calendar rendered blocks from live (migrated) picks: "+blocks, blocks>0);
 // each friend with real picks should have booking-list content
 for(const n of ["Elli","Abs","Jess"]){
   const has=await cdp.ev(`(function(){var c=[].slice.call(document.querySelectorAll('.card')).filter(x=>x.querySelector('h3')&&x.querySelector('h3').textContent==='${n}')[0];return c?!/No picks/.test(c.textContent):false;})()`);
   check(n+" shows migrated picks (not empty)", has);
 }
 // no migrated id should be unknown (would show as blank) - check booking list has known activity names
 const names=await cdp.ev("document.getElementById('people').textContent.length");
 check("booking lists populated", names>50);
 await ws.close();
}finally{chrome.kill();}
console.log("\n"+pass+" passed, "+fail+" failed (READ-ONLY - no writes)");
process.exit(fail?1:0);

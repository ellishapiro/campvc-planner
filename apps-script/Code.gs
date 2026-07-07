/**
 * Camp VC planner - Google Apps Script backend.
 *
 * This is the tiny "server" that stores everyone's picks and the shared knobs
 * in a Google Sheet. Paste this into a script bound to your Sheet
 * (Extensions -> Apps Script), then deploy it as a Web app (see README).
 *
 * The Sheet should have two tabs: "Picks" and "Knobs". If they don't exist,
 * this script creates them on first use.
 *
 * Reads come in as GET with ?action=getPicks|getKnobs&callback=... (JSONP).
 * Writes come in as POST with a JSON body {action: 'savePicks'|'saveKnobs', ...}.
 */

function getSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
  }
  return sh;
}

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  var callback = (e && e.parameter && e.parameter.callback) || '';
  var data;
  if (action === 'getPicks') {
    data = readPicks_();
  } else if (action === 'getKnobs') {
    data = readKnobs_();
  } else {
    data = { error: 'unknown action' };
  }
  return reply_(data, callback);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { body = {}; }
  var action = body.action || '';
  var ok = false;
  if (action === 'savePicks') {
    getSheet_('Picks', ['ts', 'name', 'picksJson'])
      .appendRow([body.ts || Date.now(), String(body.name || ''), JSON.stringify(body.picks || {})]);
    ok = true;
  } else if (action === 'saveKnobs') {
    saveKnobs_(body);
    ok = true;
  }
  return reply_({ ok: ok }, '');
}

// Atomic knob save. If the client sent local + baseline, we hold a lock, read the
// LATEST stored knobs, and 3-way merge server-side - so simultaneous edits by
// several people can't clobber each other (only the leaves each person changed are
// written). Falls back to the client-merged blob if local/baseline weren't sent.
function saveKnobs_(body) {
  var sh = getSheet_('Knobs', ['ts', 'knobsJson', 'author']);
  var toStore = body.knobs || {};
  if (body.local && body.baseline) {
    var lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
      var rows = sh.getDataRange().getValues();
      var latest = {};
      for (var i = 1; i < rows.length; i++) { try { latest = JSON.parse(rows[i][1]) || {}; } catch (e) {} }
      toStore = mergeKnobs_(body.baseline, body.local, latest, body.legacy || []);
      sh.appendRow([body.ts || Date.now(), JSON.stringify(toStore), String(body.author || '')]);
    } finally { try { lock.releaseLock(); } catch (e) {} }
  } else {
    sh.appendRow([body.ts || Date.now(), JSON.stringify(toStore), String(body.author || '')]);
  }
}

// 3-way merge at the per-person leaf level (must mirror store.js mergeKnobs).
function mergeKnobs_(base, local, remote, legacy) {
  base = base || {}; local = local || {}; remote = remote || {}; legacy = legacy || [];
  function pinNorm(v) {
    if (v == null) return {};
    if (typeof v === 'string') { var m = {}; for (var i = 0; i < legacy.length; i++) m[legacy[i]] = v; return m; }
    if (typeof v.key === 'string' && Object.prototype.toString.call(v.people) === '[object Array]') {
      var o = {}; for (var j = 0; j < v.people.length; j++) o[v.people[j]] = v.key; return o;
    }
    return v;
  }
  function eq(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }
  var out = {};
  var scal = ['breakMinutes', 'togetherness'];
  for (var s = 0; s < scal.length; s++) { var k = scal[s]; var v = eq(local[k], base[k]) ? remote[k] : local[k]; if (v != null) out[k] = v; }
  var cats = [['booked', false], ['pins', true], ['couldNotBook', false]];
  for (var c = 0; c < cats.length; c++) {
    var cat = cats[c][0], isPin = cats[c][1];
    var B = base[cat] || {}, L = local[cat] || {}, R = remote[cat] || {}, ids = {}, res = {};
    [B, L, R].forEach(function (o) { for (var id in o) ids[id] = 1; });
    for (var id in ids) {
      var bb = isPin ? pinNorm(B[id]) : (B[id] || {}), ll = isPin ? pinNorm(L[id]) : (L[id] || {}), rr = isPin ? pinNorm(R[id]) : (R[id] || {});
      var ps = {}, pm = {};
      [bb, ll, rr].forEach(function (o) { for (var p in o) ps[p] = 1; });
      for (var p in ps) { var val = eq(ll[p], bb[p]) ? rr[p] : ll[p]; if (val !== undefined && val !== null) pm[p] = val; }
      if (Object.keys(pm).length) res[id] = pm;
    }
    if (Object.keys(res).length) out[cat] = res;
  }
  var Bg = base.gaps || {}, Lg = local.gaps || {}, Rg = remote.gaps || {}, gids = {}, gg = {};
  [Bg, Lg, Rg].forEach(function (o) { for (var id in o) gids[id] = 1; });
  for (var gid in gids) { var gv = eq(Lg[gid], Bg[gid]) ? Rg[gid] : Lg[gid]; if (gv != null) gg[gid] = gv; }
  if (Object.keys(gg).length) out.gaps = gg;
  return out;
}

function readPicks_() {
  var sh = getSheet_('Picks', ['ts', 'name', 'picksJson']);
  var rows = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[1]) continue;
    var picks = {};
    try { picks = JSON.parse(r[2]); } catch (err) { picks = {}; }
    out.push({ ts: Number(r[0]) || 0, name: String(r[1]), picks: picks });
  }
  return out;
}

function readKnobs_() {
  var sh = getSheet_('Knobs', ['ts', 'knobsJson', 'author']);
  var rows = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var knobs = {};
    try { knobs = JSON.parse(rows[i][1]); } catch (err) { knobs = {}; }
    out.push({ ts: Number(rows[i][0]) || 0, knobs: knobs, author: String(rows[i][2] || '') });
  }
  return out;
}

/** Return JSON, wrapped as JSONP if a callback name was supplied. */
function reply_(data, callback) {
  var json = JSON.stringify(data);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

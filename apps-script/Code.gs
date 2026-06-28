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
    getSheet_('Knobs', ['ts', 'knobsJson'])
      .appendRow([body.ts || Date.now(), JSON.stringify(body.knobs || {})]);
    ok = true;
  }
  return reply_({ ok: ok }, '');
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
  var sh = getSheet_('Knobs', ['ts', 'knobsJson']);
  var rows = sh.getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    var knobs = {};
    try { knobs = JSON.parse(rows[i][1]); } catch (err) { knobs = {}; }
    out.push({ ts: Number(rows[i][0]) || 0, knobs: knobs });
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

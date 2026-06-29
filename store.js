// Camp VC planner - shared data store.
// Talks to the Google Apps Script web app when CONFIG.appsScriptUrl is set,
// otherwise falls back to this browser's localStorage ("LOCAL mode") so the
// whole app is usable for testing before the backend exists.
//
// Reads use JSONP (a <script> tag) because that is the reliable way to read
// JSON from an Apps Script web app cross-origin. Writes use a text/plain POST
// (which avoids a CORS preflight); because the POST response can be awkward to
// read cross-origin, we confirm a save by reading the data back.
(function () {
  "use strict";

  var url = (window.CONFIG && window.CONFIG.appsScriptUrl) || "";
  var isLocal = !url;
  var LS_PICKS = "campvc_picks";
  var LS_KNOBS = "campvc_knobs";

  function lsGet(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; }
    catch (e) { return fallback; }
  }
  function lsSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  var jsonpId = 0;
  function jsonp(params) {
    return new Promise(function (resolve, reject) {
      var cb = "__campvc_cb_" + (++jsonpId) + "_" + (jsonpId * 7 + 13);
      var script = document.createElement("script");
      var timer = setTimeout(function () { cleanup(); reject(new Error("timeout")); }, 15000);
      function cleanup() {
        clearTimeout(timer);
        delete window[cb];
        if (script.parentNode) script.parentNode.removeChild(script);
      }
      window[cb] = function (data) { cleanup(); resolve(data); };
      var q = Object.keys(params).map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]);
      }).join("&");
      script.src = url + "?" + q + "&callback=" + cb;
      script.onerror = function () { cleanup(); reject(new Error("network")); };
      document.body.appendChild(script);
    });
  }

  function post(obj) {
    return fetch(url, {
      method: "POST",
      mode: "cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(obj),
    });
  }

  // Remap saved pick ids to current (merged) ids so picks survive a rebuild.
  // On a merge collision, keep the higher priority. Applied on every read, so
  // there's no timing race with a deploy and nothing is ever lost.
  var PRANK = { must: 3, want: 2, iffree: 1 };
  function migrate(picks) {
    var M = window.MIGRATIONS || {};
    var out = {};
    Object.keys(picks || {}).forEach(function (k) {
      var nk = M[k] || k, v = picks[k];
      if (!out[nk] || (PRANK[v] || 0) > (PRANK[out[nk]] || 0)) out[nk] = v;
    });
    return out;
  }
  function migrateAll(map) {
    var out = {};
    Object.keys(map).forEach(function (n) { out[n] = migrate(map[n]); });
    return out;
  }

  // ---- Picks ----
  function getPicks() {
    if (isLocal) return Promise.resolve(migrateAll(lsGet(LS_PICKS, {})));
    return jsonp({ action: "getPicks" }).then(function (rows) {
      // rows: [{ts, name, picks}] - keep latest per name.
      var latest = {};
      (rows || []).forEach(function (r) {
        if (!latest[r.name] || r.ts > latest[r.name].ts) latest[r.name] = r;
      });
      var out = {};
      Object.keys(latest).forEach(function (n) { out[n] = migrate(latest[n].picks || {}); });
      return out;
    });
  }

  function sameKeys(a, b) {
    var ka = Object.keys(a || {}), kb = Object.keys(b || {});
    if (ka.length !== kb.length) return false;
    return ka.every(function (k) { return a[k] === b[k]; });
  }

  function savePicks(name, picks) {
    if (isLocal) {
      var all = lsGet(LS_PICKS, {});
      all[name] = picks;
      lsSet(LS_PICKS, all);
      return Promise.resolve({ ok: true });
    }
    return post({ action: "savePicks", name: name, picks: picks, ts: Date.now() })
      .catch(function () { /* response may be unreadable cross-origin; verify below */ })
      .then(function () { return getPicks(); })
      .then(function (all) { return { ok: !!(all[name] && sameKeys(all[name], picks)) }; })
      .catch(function () { return { ok: false }; });
  }

  // ---- Knobs (shared schedule adjustments) ----
  function getKnobs() {
    if (isLocal) return Promise.resolve(lsGet(LS_KNOBS, {}));
    return jsonp({ action: "getKnobs" }).then(function (rows) {
      var latest = null;
      (rows || []).forEach(function (r) { if (!latest || r.ts > latest.ts) latest = r; });
      return latest ? (latest.knobs || {}) : {};
    });
  }

  function saveKnobs(knobs) {
    if (isLocal) { lsSet(LS_KNOBS, knobs); return Promise.resolve({ ok: true }); }
    return post({ action: "saveKnobs", knobs: knobs, ts: Date.now() })
      .catch(function () {})
      .then(function () { return { ok: true }; })
      .catch(function () { return { ok: false }; });
  }

  window.Store = {
    isLocal: isLocal,
    getPicks: getPicks,
    savePicks: savePicks,
    getKnobs: getKnobs,
    saveKnobs: saveKnobs,
  };
})();

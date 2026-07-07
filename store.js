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
  var LS_CACHE_PICKS = "campvc_cache_picks";   // last-seen shared data, for instant first paint
  var LS_CACHE_KNOBS = "campvc_cache_knobs";

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
      lsSet(LS_CACHE_PICKS, out);   // stash for instant render next load
      return out;
    });
  }

  // Last-seen values, read synchronously for a stale-while-revalidate first paint.
  function cachedPicks() { return isLocal ? migrateAll(lsGet(LS_PICKS, {})) : lsGet(LS_CACHE_PICKS, null); }
  function cachedKnobs() { return isLocal ? lsGet(LS_KNOBS, {}) : lsGet(LS_CACHE_KNOBS, null); }

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
      var k = latest ? (latest.knobs || {}) : {};
      lsSet(LS_CACHE_KNOBS, k);
      return k;
    });
  }

  // Who's editing (per device), so saves are attributed in the Knobs history.
  function getMe() { try { return localStorage.getItem("campvc_me") || ""; } catch (e) { return ""; } }
  function setMe(n) { try { localStorage.setItem("campvc_me", n || ""); } catch (e) {} }

  // 3-way merge of knobs at the per-person leaf level. base = what this client last
  // synced; local = its current state; remote = the latest on the server. For each
  // leaf: if the user changed it (local != base) their value wins (incl. a deletion);
  // otherwise the server's value is kept. This means a stale client can never wipe
  // another person's booking/pin - it only writes the leaves it actually touched.
  function pinNorm(v) {
    if (v == null) return {};
    var legacy = (window.CONFIG && window.CONFIG.legacyLockPeople) || [];
    if (typeof v === "string") { var m = {}; legacy.forEach(function (n) { m[n] = v; }); return m; }
    if (typeof v.key === "string" && Array.isArray(v.people)) { var o = {}; v.people.forEach(function (n) { o[n] = v.key; }); return o; }
    return v;
  }
  function eq(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }
  function mergeKnobs(base, local, remote) {
    base = base || {}; local = local || {}; remote = remote || {};
    var out = {};
    ["breakMinutes", "togetherness"].forEach(function (k) {
      var v = eq(local[k], base[k]) ? remote[k] : local[k];
      if (v != null) out[k] = v;
    });
    [["booked", 0], ["pins", 1], ["couldNotBook", 0]].forEach(function (pair) {
      var cat = pair[0], isPin = pair[1];
      var B = base[cat] || {}, L = local[cat] || {}, R = remote[cat] || {};
      var ids = {}; [B, L, R].forEach(function (o) { Object.keys(o).forEach(function (i) { ids[i] = 1; }); });
      var res = {};
      Object.keys(ids).forEach(function (id) {
        var bb = isPin ? pinNorm(B[id]) : (B[id] || {}), ll = isPin ? pinNorm(L[id]) : (L[id] || {}), rr = isPin ? pinNorm(R[id]) : (R[id] || {});
        var ps = {}; [bb, ll, rr].forEach(function (o) { Object.keys(o).forEach(function (p) { ps[p] = 1; }); });
        var pm = {};
        Object.keys(ps).forEach(function (p) {
          var v = eq(ll[p], bb[p]) ? rr[p] : ll[p];
          if (v !== undefined && v !== null) pm[p] = v;
        });
        if (Object.keys(pm).length) res[id] = pm;
      });
      if (Object.keys(res).length) out[cat] = res;
    });
    var Bg = base.gaps || {}, Lg = local.gaps || {}, Rg = remote.gaps || {}, gids = {}, gg = {};
    [Bg, Lg, Rg].forEach(function (o) { Object.keys(o).forEach(function (i) { gids[i] = 1; }); });
    Object.keys(gids).forEach(function (id) { var v = eq(Lg[id], Bg[id]) ? Rg[id] : Lg[id]; if (v != null) gg[id] = v; });
    if (Object.keys(gg).length) out.gaps = gg;
    return out;
  }

  // Save = merge the client's changes INTO the latest server state, never a
  // wholesale overwrite. Returns the merged knobs so the caller can adopt it.
  function saveKnobs(local, baseline, author) {
    if (isLocal) {
      var mL = mergeKnobs(baseline, local, lsGet(LS_KNOBS, {}));
      lsSet(LS_KNOBS, mL); lsSet(LS_CACHE_KNOBS, mL);
      return Promise.resolve({ ok: true, merged: mL });
    }
    return getKnobs().then(function (remote) {
      var merged = mergeKnobs(baseline || {}, local || {}, remote || {});
      // Send `knobs` (client-merged, fallback for the old backend) AND local+baseline
      // so a merge-capable backend can re-merge atomically under a lock - making
      // simultaneous edits by several people safe, not just near-simultaneous ones.
      return post({
        action: "saveKnobs", knobs: merged, local: local || {}, baseline: baseline || {},
        legacy: (window.CONFIG && window.CONFIG.legacyLockPeople) || [],
        ts: Date.now(), author: author || getMe() || "",
      })
        .catch(function () {})
        .then(function () { lsSet(LS_CACHE_KNOBS, merged); return { ok: true, merged: merged }; })
        .catch(function () { return { ok: false, merged: merged }; });
    }).catch(function () { return { ok: false }; });
  }

  window.Store = {
    isLocal: isLocal,
    getPicks: getPicks,
    savePicks: savePicks,
    getKnobs: getKnobs,
    saveKnobs: saveKnobs,
    cachedPicks: cachedPicks,
    cachedKnobs: cachedKnobs,
    getMe: getMe,
    setMe: setMe,
  };
})();

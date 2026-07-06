// Camp VC planner - service worker.
// Two strategies:
//   - Versioned static assets (URLs carrying ?v=<stamp>): CACHE-FIRST. They're
//     immutable per stamp, so a new deploy = new URL = guaranteed fresh; serving
//     from cache makes repeat loads instant (no re-fetching schedule.js etc).
//   - Everything else (HTML, dynamic data reads): NETWORK-FIRST with cache
//     fallback, so new ?v= stamps in the HTML are always picked up, and the app
//     still works offline from the last-seen copy.
const CACHE = "campvc-runtime";

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  var versioned = url.origin === self.location.origin && /[?&]v=/.test(url.search);

  if (versioned) {
    e.respondWith((async function () {
      var cached = await caches.match(req);
      if (cached) return cached;
      var fresh = await fetch(req);
      try { (await caches.open(CACHE)).put(req, fresh.clone()); } catch (err) {}
      return fresh;
    })());
    return;
  }

  e.respondWith((async function () {
    try {
      var fresh = await fetch(req, { cache: "no-cache" });
      try { (await caches.open(CACHE)).put(req, fresh.clone()); } catch (err) {}
      return fresh;
    } catch (err) {
      var cached = await caches.match(req);
      if (cached) return cached;
      throw err;
    }
  })());
});

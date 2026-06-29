// Camp VC planner - service worker (network-first).
// GitHub Pages caches pages for 10 minutes and we can't change those headers,
// which is why updates didn't show without a hard refresh. This always
// revalidates with the server (via ETag) so you get the latest whenever you're
// online, and falls back to the last-seen copy when offline.
const CACHE = "campvc-runtime";

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  e.respondWith((async function () {
    try {
      // cache:"no-cache" => revalidate with the server; never serve stale-but-fresh.
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

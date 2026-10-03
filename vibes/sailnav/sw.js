/* SailNav service worker: app shell precache + runtime cache for bundled charts.
 * Bump VERSION when shipping code changes so old shells are evicted. */
const VERSION = "sailnav-v4";
const SHELL = ["./", "index.html", "nav.js", "chart.js", "router.js", "s57.js", "chartstore.js", "manifest.webmanifest",
  "vendor/leaflet.js", "vendor/leaflet.css", "vendor/images/marker-icon.png", "vendor/images/marker-icon-2x.png", "vendor/images/marker-shadow.png", "vendor/icon.svg",
  "charts/catalog.json"];
const CHARTS = "sailnav-charts-v1";

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== CHARTS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // NOAA / OSM tiles: network only, browser HTTP cache applies
  if (url.pathname.includes("/charts/") && url.pathname.endsWith(".zip")) {
    // cache-first: cells are versioned by content on refresh via fetch_charts.js
    e.respondWith(caches.open(CHARTS).then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  // shell: network-first so edits show up, fall back to cache when offline
  e.respondWith(fetch(e.request).then(r => { if (r.ok && e.request.method === "GET") caches.open(VERSION).then(c => c.put(e.request, r.clone())); return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(m => m || (e.request.mode === "navigate" ? caches.match("index.html") : undefined))));
});

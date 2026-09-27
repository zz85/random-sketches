/*
 * sw.js - Estate AR service worker.
 *
 *   App shell   stale-while-revalidate: served from cache instantly, refreshed
 *               in the background so the next load has the new build. Bump
 *               VERSION to force a clean sweep.
 *   Data APIs   network-first with a cached fallback, so a spot you have
 *               already looked at keeps working with no signal. Parcel data
 *               itself is also kept in IndexedDB by the page (parcelstore.js);
 *               this layer just makes the raw responses survive too.
 *   Everything else  passthrough.
 */
const VERSION = "estate-ar-v8";
const SHELL = ["./", "./index.html", "./geo.js", "./providers.js", "./heights.js", "./parcelstore.js", "./market.js", "./terrain.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png"];
const DATA_HOSTS = ["gismaps.kingcounty.gov", "gis.snoco.org", "gis.dnr.wa.gov", "nominatim.openstreetmap.org", "overpass-api.de", "overpass.kumi.systems"];
const DATA_CACHE = VERSION + "-data";
const DATA_MAX = 120;   // responses kept

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== DATA_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin === self.location.origin) {
    if (e.request.method !== "GET") return;
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(e.request, { ignoreSearch: true });
      const refresh = fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; }).catch(() => null);
      if (hit) { e.waitUntil(refresh); return hit; }
      return (await refresh) || new Response("offline", { status: 503 });
    }));
    return;
  }
  if (DATA_HOSTS.includes(url.hostname)) {
    e.respondWith(networkFirst(e.request));
  }
});

async function networkFirst(req) {
  // Overpass is a POST; key it by URL + body so it can be cached
  const key = req.method === "GET" ? req : new Request(req.url + "#" + await req.clone().text(), { method: "GET" });
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) { await cache.put(key, res.clone()); trim(cache); }
    return res;
  } catch (err) {
    const hit = await cache.match(key);
    if (hit) return hit;
    throw err;
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length > DATA_MAX) await Promise.all(keys.slice(0, keys.length - DATA_MAX).map((k) => cache.delete(k)));
}

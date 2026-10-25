/*
 * sw.js - Aquarelle service worker: the whole app is static and same-origin, so it is
 * precached on install and served stale-while-revalidate (instant, offline, and an online
 * load fetches the new build for next time). Bump VERSION when the file list changes.
 */
const VERSION = 'aquarelle-v4';
const SHELL = ['./', './index.html', './app.js', './sim.js', './km.js', './paper.js', './brush.js', './colour.js', './store.js', './timelapse.js', './manifest.webmanifest', '../pwa/install.js', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('aquarelle-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const refresh = fetch(e.request).then((res) => { if (res.ok) c.put(url.pathname, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || (e.request.mode === 'navigate' && (await c.match('./index.html'))) || new Response('offline', { status: 503 });
  }));
});

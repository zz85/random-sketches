/* Committee Boat service worker: app shell precache, network-first so edits show up.
 * Bump VERSION when shipping code changes so old shells are evicted. */
const VERSION = 'committee-boat-v1';
const SHELL = ['./', 'index.html', 'app.js', 'race.js', 'horn.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', '../pwa/install.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return; // the OCR engine from the CDN: browser HTTP cache
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(VERSION).then((x) => x.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((m) => m || (e.request.mode === 'navigate' ? caches.match('index.html') : undefined))));
});

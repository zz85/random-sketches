/*
 * sw.js - ScoreShift service worker. The app is static and same-origin: precache it all on
 * install, serve stale-while-revalidate so it starts offline and updates quietly.
 * Bump VERSION when the file list changes.
 */
const VERSION = 'scoreshift-v6';
const SHELL = ['./', './index.html', './app.js', './worker.js', './omr.js', './imgproc.js', './theory.js', './render.js', './glyphs.js', './sample.jpg', './manifest.webmanifest', './icon.svg',
  './pdfsource.js', './rhythm.js', './raster.js', './score.js', './export.js', './player.js', './glyphnet.js', './glyphnet-weights.js', './dynamics.js', './vendor/pdfjs/pdf.min.mjs', './vendor/pdfjs/pdf.worker.min.mjs',
  './vendor/pdfjs/wasm/jbig2.wasm', './vendor/pdfjs/wasm/openjpeg.wasm', './vendor/pdfjs/wasm/qcms_bg.wasm'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('scoreshift-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
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

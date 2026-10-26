/*
 * sw.js - ScoreShift service worker. The app is static and same-origin: precache it all on
 * install, serve stale-while-revalidate so it starts offline and updates quietly.
 * Bump VERSION when the file list changes.
 */
const VERSION = 'scoreshift-v15';
const SHELL = ['./', './index.html', './app.js', './worker.js', './omr.js', './imgproc.js', './theory.js', './render.js', './glyphs.js', './sample.jpg', './manifest.webmanifest', '../pwa/install.js', './icon.svg', './icon-192.png', './icon-512.png', './icon-maskable-512.png',
  './pdfsource.js', './rhythm.js', './raster.js', './score.js', './export.js', './player.js', './edits.js', './glyphnet.js', './glyphnet-weights.js', './dynamics.js', './vendor/pdfjs/pdf.min.mjs', './vendor/pdfjs/pdf.worker.min.mjs',
  './vendor/pdfjs/wasm/jbig2.wasm', './vendor/pdfjs/wasm/openjpeg.wasm', './vendor/pdfjs/wasm/qcms_bg.wasm',
  // shared with StaffInk: pitch, duration and the audio player
  '../notation-ir/rational.js', '../notation-ir/pitch.js', '../notation-ir/duration.js', '../notation-ir/player.js', '../notation-ir/markers.js', '../notation-ir/playheads.js', '../notation-ir/surface.js', './surface.js',
  '../notation-ir/arrangement.js', '../notation-ir/cliporder.js', '../notation-ir/anchors.js', '../notation-ir/ir.js'];
// The timeline IR (authored playback, Edit in StaffInk), loaded on demand: best-effort.
const OPTIONAL = ['../notation-ir/interpret.js', '../notation-ir/playback.js',
  '../notation-ir/adapters/scoreshift.js', '../notation-ir/adapters/staffink.js',
  '../staffink/theory.js', '../staffink/export.js', '../staffink/layout.js', '../staffink/smufl.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).then(() => Promise.all(OPTIONAL.map((u) => c.add(u).catch(() => null))))).then(() => self.skipWaiting()));
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

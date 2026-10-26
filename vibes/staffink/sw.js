/*
 * sw.js - StaffInk service worker. Everything StaffInk needs is same-origin and static,
 * so the whole app is precached on install and served stale-while-revalidate: instant
 * and offline, while an online load quietly fetches the new build for next time.
 * Bump VERSION when the file list changes.
 */
const VERSION = 'staffink-v10';
const SHELL = [
  './', './index.html', './app.js', './recognizer.js', './extras.js', './parser.js', './theory.js', './layout.js',
  './render.js', './export.js', './audio.js', './smufl.js', './model.json', './digits.json',
  './fonts/Bravura.woff2', './fonts/Petaluma.woff2', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', '../pwa/install.js',
  // shared with ScoreShift: pitch, duration and the audio player
  '../notation-ir/rational.js', '../notation-ir/pitch.js', '../notation-ir/duration.js', '../notation-ir/player.js', '../notation-ir/markers.js', '../notation-ir/playheads.js',
  '../notation-ir/arrangement.js', '../notation-ir/cliporder.js', '../notation-ir/anchors.js', '../notation-ir/ir.js', './arrange.js',
];
// Authored playback (the timeline IR), loaded on demand from app.js: cached best-effort, so
// only playProgram fails if a deployment lacks it.
const OPTIONAL = [
  '../notation-ir/interpret.js', '../notation-ir/playback.js', '../notation-ir/adapters/staffink.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).then(() => Promise.all(OPTIONAL.map((u) => c.add(u).catch(() => null))))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('staffink-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    // ?fresh etc. are app parameters, not different files
    const hit = await c.match(e.request, { ignoreSearch: true });
    const refresh = fetch(e.request).then((res) => { if (res.ok) c.put(url.pathname, res.clone()) /* key without the query */; return res; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || (e.request.mode === 'navigate' && (await c.match('./index.html'))) || new Response('offline', { status: 503 });
  }));
});

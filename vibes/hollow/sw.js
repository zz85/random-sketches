/*
 * sw.js - Hollow service worker: the app's own files are precached; three.js (WebGPU build, TSL and the
 * addons used) from unpkg is cached the first time it is fetched. Stale-while-revalidate, so it opens
 * instantly and offline. Bump VERSION when the file list changes.
 */
const VERSION = 'hollow-v3';
const SHELL = ['./', './index.html', './main.js', './sdf.js', './wood.js', './studio.js', './dust.js', './mesher.worker.js', './manifest.webmanifest', '../pwa/install.js', './icon.svg', './icon-192.png', './icon-512.png'];
const BASE = 'https://unpkg.com/three@0.187.0/';
const CDN = [BASE + 'build/three.webgpu.js', BASE + 'build/three.tsl.js'].concat(['tsl/display/BloomNode.js', 'tsl/display/GodraysNode.js', 'tsl/display/BilateralBlurNode.js', 'tsl/display/GTAONode.js',
  'controls/OrbitControls.js', 'environments/RoomEnvironment.js', 'geometries/RoundedBoxGeometry.js'].map((f) => BASE + 'examples/jsm/' + f));

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).then(() => Promise.all(CDN.map((u) => c.add(u).catch(() => {}))))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('hollow-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || (url.origin !== self.location.origin && !url.href.startsWith(BASE))) return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const key = url.origin === self.location.origin ? url.pathname : url.href;
    const hit = await c.match(key, { ignoreSearch: true });
    const refresh = fetch(e.request).then((res) => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || (e.request.mode === 'navigate' && (await c.match('./index.html'))) || new Response('offline', { status: 503 });
  }));
});

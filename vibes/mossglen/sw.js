/*
 * sw.js - Mossglen service worker: the app's own files are precached; three.js and its addons
 * from unpkg are cached the first time they are fetched. Stale-while-revalidate, so it opens
 * instantly and offline. Bump VERSION when the file list changes.
 */
const VERSION = 'mossglen-v4';
const SHELL = ['./', './index.html', './main.js', './glsl.js', './world.js', './props.js', './growth.js', './moss.js', './flora.js', './post.js', './manifest.webmanifest', '../pwa/install.js', './icon.svg', './icon-192.png', './icon-512.png', './piano_case.glb', './audio.js'];
const BASE = 'https://unpkg.com/three@0.160.1/';
const GRAND = 'https://cdn.jsdelivr.net/gh/zz85/midiviz@';
const CDN = [BASE + 'build/three.module.js', BASE + 'examples/jsm/controls/OrbitControls.js', BASE + 'examples/jsm/libs/lil-gui.module.min.js', BASE + 'examples/jsm/postprocessing/Pass.js', BASE + 'examples/jsm/utils/BufferGeometryUtils.js', BASE + 'examples/jsm/loaders/GLTFLoader.js'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).then(() => Promise.all(CDN.map((u) => c.add(u).catch(() => {}))))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('mossglen-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || (url.origin !== self.location.origin && !url.href.startsWith(BASE) && !url.href.startsWith(GRAND))) return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const key = url.origin === self.location.origin ? url.pathname : url.href;
    const hit = await c.match(key, { ignoreSearch: true });
    const refresh = fetch(e.request).then((res) => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || (e.request.mode === 'navigate' && (await c.match('./index.html'))) || new Response('offline', { status: 503 });
  }));
});

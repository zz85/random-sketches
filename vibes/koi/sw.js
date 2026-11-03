/*
 * sw.js - Koi service worker: the app's own files are precached; three.js from unpkg is cached
 * the first time it is fetched. Stale-while-revalidate, so it opens instantly and offline.
 * Bump VERSION when the file list changes.
 */
const VERSION = 'koi-v1';
const SHELL = ['./', './index.html', './main.js', './glsl.js', './pond.js', './koi.js', './surface.js', './paint.js', './audio.js', './manifest.webmanifest', '../pwa/install.js', './icon.svg', './icon-192.png', './icon-512.png'];
const CDN = 'https://unpkg.com/three@0.160.1/build/three.module.js';

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL).then(() => c.add(CDN).catch(() => {}))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('koi-') && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || (url.origin !== self.location.origin && url.href !== CDN)) return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const key = url.origin === self.location.origin ? url.pathname : url.href;
    const hit = await c.match(key, { ignoreSearch: true });
    const refresh = fetch(e.request).then((res) => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || (e.request.mode === 'navigate' && (await c.match('./index.html'))) || new Response('offline', { status: 503 });
  }));
});

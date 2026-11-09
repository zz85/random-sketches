/*
 * sw.js - Hanzi Lens service worker. The app shell is precached on install and served
 * stale-while-revalidate. The models (Hugging Face) and ONNX Runtime (jsDelivr) are pinned
 * to exact versions, so they are kept cache-first once fetched: after the first run the
 * app works offline. Bump VERSION when the shell's file list changes.
 */
const VERSION = 'hanzi-lens-v3';
const ASSETS = 'hanzi-lens-assets-v1';   // pinned third-party files, kept across app updates
const SHELL = ['./', './index.html', './style.css', './app.js', './text.js', './ocr.js', './worker.js', './assets.js',
  './dict/cedict.txt.gz', './sample.jpg', './manifest.webmanifest', '../pwa/install.js', './icon.svg', './icon-192.png', './icon-512.png'];
const PINNED = [/^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web@[\d.]+\//, /^https:\/\/huggingface\.co\/PaddlePaddle\/[^/]+\/resolve\/[0-9a-f]{40}\//];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('hanzi-lens-') && k !== VERSION && k !== ASSETS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (PINNED.some((re) => re.test(url.href))) {
    e.respondWith(caches.open(ASSETS).then(async (c) => {
      const hit = await c.match(url.href);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(url.href, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const refresh = fetch(e.request).then((res) => { if (res.ok) c.put(url.pathname, res.clone()); return res; }).catch(() => null);
    if (hit) { e.waitUntil(refresh); return hit; }
    return (await refresh) || (e.request.mode === 'navigate' && (await c.match('./index.html'))) || new Response('offline', { status: 503 });
  }));
});

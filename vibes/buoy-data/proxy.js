#!/usr/bin/env node
// Zero-dependency dev server + NDBC proxy.
//
//   node proxy.js            -> http://localhost:8787
//
// Serves this directory as static files and proxies
//   /ndbc/<path>  ->  https://www.ndbc.noaa.gov/data/<path>
// with CORS headers and a short in-memory cache, because NDBC's
// realtime2 text feeds don't send Access-Control-Allow-Origin.
// Everything else the app needs (api.weather.gov, CO-OPS) already
// supports CORS and is fetched directly by the browser.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const NDBC = 'https://www.ndbc.noaa.gov/data/';
const CACHE_MS = 5 * 60 * 1000;
const ALLOWED = /^(realtime2|5day2|latest_obs)\/[A-Za-z0-9_]+\.(txt|cwind|spec|ocean|drift|srad|supl|rss)$|^activestations\.xml$/;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const cache = new Map(); // key -> { at, status, body, type }

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

async function proxyNdbc(rel, res) {
  if (!ALLOWED.test(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('path not allowed');
  }
  const hit = cache.get(rel);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    res.writeHead(hit.status, { 'Content-Type': hit.type, 'X-Cache': 'HIT', 'X-Fetched-At': new Date(hit.at).toISOString() });
    return res.end(hit.body);
  }
  try {
    const r = await fetch(NDBC + rel, { headers: { 'User-Agent': 'buoy-data-vibe (local dev proxy)' } });
    const body = Buffer.from(await r.arrayBuffer());
    const type = r.headers.get('content-type') || 'text/plain';
    cache.set(rel, { at: Date.now(), status: r.status, body, type });
    res.writeHead(r.status, { 'Content-Type': type, 'X-Cache': 'MISS' });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('upstream error: ' + err.message);
  }
}

function serveStatic(urlPath, res) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403); return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url.startsWith('/ndbc/')) return proxyNdbc(req.url.slice('/ndbc/'.length).split('?')[0], res);
  serveStatic(req.url, res);
}).listen(PORT, () => {
  console.log(`buoy-data        http://localhost:${PORT}`);
  console.log(`NDBC proxy       http://localhost:${PORT}/ndbc/realtime2/WPOW1.cwind`);
});

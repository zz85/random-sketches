#!/usr/bin/env node
// Zero-dependency dev server + AIS proxy for Marine AR.
//
//   AISSTREAM_API_KEY=... node proxy.js        -> http://localhost:8788
//
// Serves this directory as static files and, when AISSTREAM_API_KEY is set,
// keeps one WebSocket open to aisstream.io (Node 22+ has a built-in
// WebSocket client) for a bounding box around the viewer. Positions and
// static reports are merged into an in-memory table and exposed with the
// SAME shape Digitraffic uses, so the browser has a single code path:
//
//   GET /ais/locations?latitude=&longitude=&radius=<km>   GeoJSON FeatureCollection
//   GET /ais/vessels/<mmsi>                               static data (JSON)
//   GET /ais/status                                       what the proxy is doing
//
// The API key never leaves this process (aisstream.io forbids browser
// connections). Without a key the /ais routes answer 503 and the app falls
// back to its demo provider.
//
// Everything else (NOAA ENC Direct lanes, NOAA WMM declination, Nominatim)
// already sends Access-Control-Allow-Origin and is fetched by the browser.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8788);
const ROOT = __dirname;
const KEY = process.env.AISSTREAM_API_KEY || '';
const STREAM = 'wss://stream.aisstream.io/v0/stream';
const MAX_AGE_MS = 20 * 60 * 1000;
const NM = 1852;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};

// ---- vessel table -----------------------------------------------------------
const vessels = new Map(); // mmsi -> { pos: {...} | null, static: {...} | null }
function entry(mmsi) { let v = vessels.get(mmsi); if (!v) { v = { pos: null, static: null }; vessels.set(mmsi, v); } return v; }

function ingest(msg) {
  const meta = msg.MetaData || {}, mmsi = Number(meta.MMSI);
  if (!mmsi) return;
  const body = msg.Message && msg.Message[msg.MessageType];
  if (!body) return;
  const now = Date.now();
  switch (msg.MessageType) {
    case 'PositionReport':
    case 'StandardClassBPositionReport':
    case 'ExtendedClassBPositionReport': {
      const v = entry(mmsi);
      v.pos = {
        lat: body.Latitude != null ? body.Latitude : meta.latitude, lon: body.Longitude != null ? body.Longitude : meta.longitude,
        sog: body.Sog, cog: body.Cog, heading: body.TrueHeading, navStat: body.NavigationalStatus == null ? 15 : body.NavigationalStatus,
        rot: body.RateOfTurn == null ? null : body.RateOfTurn, posAcc: !!body.PositionAccuracy, at: now,
      };
      if (meta.ShipName && !(v.static && v.static.name)) v.static = Object.assign(v.static || {}, { name: meta.ShipName.trim() });
      // Class B extended carries dimensions + type in the same message
      if (body.Dimension) v.static = Object.assign(v.static || {}, staticFrom(body, meta, now));
      break;
    }
    case 'ShipStaticData': {
      const v = entry(mmsi);
      v.static = Object.assign(v.static || {}, staticFrom(body, meta, now));
      break;
    }
    case 'StaticDataReport': {
      const v = entry(mmsi);
      const a = body.ReportA, b = body.ReportB;
      const s = v.static || {};
      if (a && a.Name) s.name = a.Name.trim();
      if (b) { if (b.ShipType != null) s.shipType = b.ShipType; if (b.CallSign) s.callSign = b.CallSign.trim(); if (b.Dimension) s.dims = dims(b.Dimension); }
      s.at = now; v.static = s;
      break;
    }
    default: break;
  }
}
function dims(d) { return { a: d.A || 0, b: d.B || 0, c: d.C || 0, d: d.D || 0 }; }
function staticFrom(body, meta, now) {
  const s = { at: now };
  if (body.Name) s.name = body.Name.trim(); else if (meta.ShipName) s.name = meta.ShipName.trim();
  if (body.CallSign) s.callSign = body.CallSign.trim();
  if (body.ImoNumber) s.imo = body.ImoNumber;
  if (body.Type != null) s.shipType = body.Type;
  if (body.Dimension) s.dims = dims(body.Dimension);
  if (body.MaximumStaticDraught != null) s.draught = body.MaximumStaticDraught;   // metres
  if (body.Destination) s.destination = body.Destination.trim();
  if (body.Eta) s.eta = body.Eta;
  return s;
}
function sweep() { const cut = Date.now() - MAX_AGE_MS; for (const [m, v] of vessels) if (!v.pos || v.pos.at < cut) vessels.delete(m); }
setInterval(sweep, 60e3).unref();

// ---- aisstream connection --------------------------------------------------------
const state = { connected: false, box: null, messages: 0, lastMessageAt: 0, error: null, attempts: 0 };
let ws = null, wantBox = null, reconnectTimer = null;

function boxAround(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.32, dLon = radiusKm / (111.32 * Math.cos(lat * Math.PI / 180));
  // aisstream: [[lat1, lon1], [lat2, lon2]] corners
  return [[lat + dLat, lon - dLon], [lat - dLat, lon + dLon]];
}
function boxContains(box, lat, lon, radiusKm) {
  if (!box) return false;
  const inner = boxAround(lat, lon, radiusKm);
  return inner[0][0] <= box[0][0] && inner[0][1] >= box[0][1] && inner[1][0] >= box[1][0] && inner[1][1] <= box[1][1];
}
function subscribe(box) {
  wantBox = box;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ APIKey: KEY, BoundingBoxes: [box], FilterMessageTypes: ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport', 'ShipStaticData', 'StaticDataReport'] }));
    state.box = box;
  } else connect();
}
function connect() {
  if (!KEY || typeof WebSocket === 'undefined') return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  clearTimeout(reconnectTimer);
  state.attempts++;
  try { ws = new WebSocket(STREAM); } catch (e) { state.error = e.message; return scheduleReconnect(); }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { state.connected = true; state.error = null; state.attempts = 0; if (wantBox) subscribe(wantBox); };
  ws.onmessage = (ev) => {
    try {
      const txt = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8');
      const msg = JSON.parse(txt);
      if (msg.error) { state.error = msg.error; return; }
      if (msg.MessageType === 'SubscriptionConfirmation') return;
      state.messages++; state.lastMessageAt = Date.now();
      ingest(msg);
    } catch (e) { /* skip malformed frame */ }
  };
  ws.onerror = () => { state.error = 'websocket error'; };
  ws.onclose = () => { state.connected = false; scheduleReconnect(); };
}
function scheduleReconnect() {
  const wait = Math.min(60e3, 1000 * 2 ** Math.min(state.attempts, 6)) * (0.7 + Math.random() * 0.6);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, wait);
}

// ---- HTTP -----------------------------------------------------------------------
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); }

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, p = Math.PI / 180, a = Math.sin((lat2 - lat1) * p / 2) ** 2 + Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin((lon2 - lon1) * p / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function handleAis(url, res) {
  if (!KEY) return json(res, 503, { error: 'AISSTREAM_API_KEY not set on the proxy' });
  if (url.pathname === '/ais/status') return json(res, 200, { ...state, vessels: vessels.size, key: KEY ? 'set' : 'missing' });
  if (url.pathname === '/ais/locations') {
    const lat = Number(url.searchParams.get('latitude')), lon = Number(url.searchParams.get('longitude'));
    const radius = Math.min(200, Math.max(1, Number(url.searchParams.get('radius') || 20)));
    if (!isFinite(lat) || !isFinite(lon)) return json(res, 400, { error: 'latitude and longitude required' });
    // widen the subscription generously so a walking viewer rarely forces a resubscribe (limit: 1 update/s)
    if (!boxContains(state.box, lat, lon, radius)) subscribe(boxAround(lat, lon, radius * 2.5));
    const features = [];
    for (const [mmsi, v] of vessels) {
      if (!v.pos || haversineKm(lat, lon, v.pos.lat, v.pos.lon) > radius) continue;
      features.push({ mmsi, type: 'Feature', geometry: { type: 'Point', coordinates: [v.pos.lon, v.pos.lat] },
        properties: { mmsi, sog: v.pos.sog, cog: v.pos.cog, navStat: v.pos.navStat, rot: v.pos.rot, posAcc: v.pos.posAcc, raim: false, heading: v.pos.heading, timestamp: 0, timestampExternal: v.pos.at } });
    }
    return json(res, 200, { type: 'FeatureCollection', dataUpdatedTime: new Date(state.lastMessageAt || Date.now()).toISOString(), features });
  }
  const m = url.pathname.match(/^\/ais\/vessels\/(\d{5,9})$/);
  if (m) {
    const v = vessels.get(Number(m[1]));
    if (!v || !v.static) return json(res, 404, { error: 'no static data yet' });
    const s = v.static, d = s.dims || { a: 0, b: 0, c: 0, d: 0 };
    return json(res, 200, { mmsi: Number(m[1]), name: s.name || null, callSign: s.callSign || null, imo: s.imo || 0, shipType: s.shipType == null ? 0 : s.shipType,
      referencePointA: d.a, referencePointB: d.b, referencePointC: d.c, referencePointD: d.d,
      draught: s.draught != null ? Math.round(s.draught * 10) : 0, destination: s.destination || '', eta: s.eta || 0, posType: 0, timestamp: s.at });
  }
  json(res, 404, { error: 'not found' });
}

function serveStatic(urlPath, res) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

if (require.main === module) {
  http.createServer((req, res) => {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/ais/')) return handleAis(url, res);
    serveStatic(url.pathname, res);
  }).listen(PORT, () => {
    console.log(`marine-ar        http://localhost:${PORT}`);
    console.log(`AIS proxy        http://localhost:${PORT}/ais/status  (${KEY ? 'aisstream key set' : 'no AISSTREAM_API_KEY: /ais disabled, app uses demo traffic'})`);
  });
}

module.exports = { ingest, vessels, boxAround, boxContains, handleAis, _state: state };

// Headless render check over the Chrome DevTools protocol, zero npm deps.
// Unlike --screenshot with --virtual-time-budget, this does not wait for
// network idle (the app polls forever), it waits a fixed settle time, then
// captures the page and its console. Run:  node smoke.js
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME = process.env.CHROME || path.join(process.env.HOME, '.cache/ms-playwright/chromium-1134/chrome-linux/chrome');
const PORT = 8799, CDP = 9333, SETTLE_MS = Number(process.env.SETTLE_MS || 12000);

const CASES = [
  { name: 'seattle-demo', url: `http://localhost:${PORT}/?lat=47.6603&lon=-122.4412&eye=18&hdg=300&pitch=-6&provider=demo&auto=1&nocam=1` },
  { name: 'seattle-occlusion', url: `http://localhost:${PORT}/?lat=47.6603&lon=-122.4412&eye=18&hdg=135&pitch=-4&provider=demo&auto=1&nocam=1` },
  { name: 'seattle-aton', url: `http://localhost:${PORT}/?lat=47.6603&lon=-122.4412&eye=4&hdg=20&pitch=-3&provider=demo&auto=1&nocam=1` },
  { name: 'helsinki-live', url: `http://localhost:${PORT}/?lat=60.153&lon=24.95&eye=12&hdg=200&pitch=-5&provider=digitraffic&auto=1&nocam=1` },
];

const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => res(JSON.parse(s))); }).on('error', rej));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ } if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(200); } }

/** Minimal CDP client over Node's built-in WebSocket. */
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return new Promise((res) => { ws.onopen = () => res({ send, events, close: () => ws.close() }); });
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'proxy.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--window-size=1280,800', `--remote-debugging-port=${CDP}`, '--use-fake-ui-for-media-stream', 'about:blank'], { stdio: 'ignore' });
  let failed = false;
  try {
    await waitFor(() => new Promise((r) => http.get(`http://localhost:${PORT}/geo.js`, (x) => { x.resume(); r(true); }).on('error', () => r(false))), 10000);
    const targets = await waitFor(() => getJson(`http://localhost:${CDP}/json/list`), 15000);
    const page = targets.find((t) => t.type === 'page');
    const c = await cdp(page.webSocketDebuggerUrl);
    await c.send('Runtime.enable'); await c.send('Log.enable'); await c.send('Page.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    for (const k of CASES) {
      c.events.length = 0;
      await c.send('Page.navigate', { url: k.url });
      await sleep(SETTLE_MS);
      const state = await c.send('Runtime.evaluate', { awaitPromise: true, expression: 'JSON.stringify({vessels: MarineAR.vessels.length, lanes: MarineAR.lanes.length, land: MarineAR.land.length, spots: MarineAR.landSpots.length, aton: MarineAR.aton.length, occluded: MarineAR.vessels.filter(v=>v.occluded).length, atonOccluded: MarineAR.aton.filter(a=>a.occluded).length, hits: MarineAR.hits.length, ais: MarineAR.provider && MarineAR.provider.id, errors: [MarineAR.lanesError, MarineAR.landError, MarineAR.atonError, MarineAR.aisError].filter(Boolean)})', returnByValue: true });
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      const out = path.join(__dirname, `smoke_${k.name}.png`);
      fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
      const errs = c.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/camera|orientation|favicon/.test(e.params.entry.text + (e.params.entry.url || ''))))
        .map((e) => e.method === 'Runtime.exceptionThrown' ? e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description || e.params.exceptionDetails.text : e.params.entry.text);
      const st = JSON.parse(state.result.result.value);
      console.log(`${k.name}: ${fs.statSync(out).size} bytes, ${errs.length} errors,`, st);
      for (const e of errs) console.log('   ', String(e).slice(0, 220));
      if (errs.length || st.errors.length) failed = true;
    }
    c.close();
  } catch (e) { console.error('smoke failed:', e.message); failed = true; }
  chrome.kill(); srv.kill();
  process.exit(failed ? 1 : 0);
})();

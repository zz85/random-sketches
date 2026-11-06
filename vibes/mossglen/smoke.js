// Headless check over CDP (zero deps; three.js from unpkg): the glen builds with no console
// or shader errors, the growth front covers more as Growth rises, Cover widens it, painting
// grows moss where you paint and it creeps outward, scraping strips it, light presets and
// the phone tier render, frames aren't blank. Writes shot_*.png.
//   node smoke.js            (ONLY=shots to just take the screenshots)
// SwiftShader is slow, so frames are stepped by hand, not timed.
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = 8841;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res);
});
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const b = await launch({ port: 9391, width: 1280, height: 800 });
  const shot = async (name) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, `shot_${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const errors = () => b.events.filter((e) => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || e.params.args?.map((a) => a.value ?? a.description).join(' ')).filter((s) => !/GPU stall|ReadPixels|WebGL-|lil-gui/.test(s || ''));
  const device = async (w, h, mobile) => {
    await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  };
  const open = async (q) => {
    b.events.length = 0;
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/mossglen/?shot&${q}` });
    await waitFor(() => b.evaluate('!!window.__moss || /Could not/.test(document.body.innerText)'), 240000);
    const bad = await b.evaluate('!window.__moss && document.body.innerText');
    if (bad) throw new Error(bad);
  };
  const frameStats = () => b.evaluate(`(() => { const c = document.querySelector('canvas'), g = c.getContext('webgl2'); const w = g.drawingBufferWidth, h = g.drawingBufferHeight, a = new Uint8Array(4);
      let s = 0, s2 = 0, gr = 0, n = 0; for (let i = 0; i < 100; i++) { g.readPixels(Math.floor(w * (0.05 + 0.9 * (i % 10) / 9)), Math.floor(h * (0.05 + 0.9 * Math.floor(i / 10) / 9)), 1, 1, g.RGBA, g.UNSIGNED_BYTE, a);
      const l = (a[0] + a[1] + a[2]) / 3; s += l; s2 += l * l; if (a[1] > a[0] * 1.08 && a[1] > a[2] * 1.15) gr++; n++; } return { mean: s / n, sd: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)), green: gr / n }; })()`);
  try {
    await device(1280, 800, false);
    const t0 = Date.now();
    await open(process.env.Q || 'q=2');
    const info = await b.evaluate(`({ ms: __moss.buildMs, verts: __moss.verts })`);
    console.log(`     built in ${info.ms.toFixed(0)} ms (page ${(Date.now() - t0) / 1000}s), ${info.verts} mossable vertices`);
    await b.evaluate('__moss.step(2)'); await sleep(200);
    let er = errors();
    check('loads without console or shader errors', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 900));
    await shot('morning');
    const lit = await frameStats();
    check('frame is rendered, not blank', lit.mean > 25 && lit.sd > 8, `mean ${lit.mean.toFixed(0)} sd ${lit.sd.toFixed(1)} green ${lit.green.toFixed(2)}`);
    if (process.env.ONLY === 'shots') {
      for (const [n, l] of [['day', 1], ['golden', 2], ['gloaming', 3]]) { await b.evaluate(`__moss.set('light', ${l}); __moss.step(2)`); await sleep(200); await shot(n); }
      await b.evaluate(`__moss.set('light', 0); __moss.set('grow', 0); __moss.step(2)`); await sleep(200); await shot('bare');
      await b.evaluate(`__moss.set('grow', 0.4); __moss.step(2)`); await sleep(200); await shot('half');
      await open('q=2&cam=1.8,1.2,10.6,0.2,0.9,7.8'); await b.evaluate('__moss.step(2)'); await sleep(200); await shot('close');
      await open('q=2&cam=-3.6,0.9,9.6,-4.2,0.25,12.6'); await b.evaluate('__moss.step(2)'); await sleep(200); await shot('macro');
      return;
    }
    // growth: more moss as growth rises, more again as cover widens
    const cov = [];
    for (const g of [0, 0.3, 0.6, 1]) { await b.evaluate(`__moss.set('grow', ${g})`); cov.push(await b.evaluate('__moss.coverage()')); }
    check('growth front spreads with Growth', cov[0] < 0.01 && cov[1] > cov[0] + 0.05 && cov[2] > cov[1] + 0.05 && cov[3] > cov[2], cov.map((c) => c.toFixed(2)).join(' -> '));
    await b.evaluate(`__moss.set('cover', 0.3)`); const c3 = await b.evaluate('__moss.coverage()');
    await b.evaluate(`__moss.set('cover', 1)`); const c10 = await b.evaluate('__moss.coverage()');
    check('Cover widens what it reaches', c10 > c3 + 0.1, `${c3.toFixed(2)} -> ${c10.toFixed(2)}`);
    // the stones get moss after the ground near the burn: the front climbs
    const order = await b.evaluate(`(() => { const G = __moss.G; let a = 0, n = 0, s = 0, m = 0; for (let i = 0; i < G.N; i++) { if (G.kind[i] === 0 && G.hab[i] > 0.6) { a += G.arr[i]; n++; } if (G.kind[i] === 1) { s += G.arr[i]; m++; } } return [a / n, s / m]; })()`);
    check('moss reaches the stones after the wet ground', order[1] > order[0], order.map((x) => x.toFixed(2)).join(' < '));
    // paint: on bare glen, a stroke grows moss under the brush, then it creeps outward
    await b.evaluate(`__moss.set('grow', 0); __moss.set('cover', 0.78); __moss.G.clear(); __moss.step(2)`);
    const hit = await b.evaluate(`__moss.paintAt(640, 470, 'grow')`);
    check('the brush finds a surface', !!hit, hit ? `${hit.name} at ${hit.p.map((v) => v.toFixed(1)).join(',')}` : 'nothing');
    for (let i = 0; i < 6; i++) await b.evaluate(`__moss.paintAt(${620 + i * 8}, 470, 'grow')`);
    const p0 = await b.evaluate(`__moss.coverage()`);
    await b.evaluate('__moss.step(180)');
    const p1 = await b.evaluate(`__moss.coverage()`);
    await b.evaluate('__moss.step(300)');
    const p2 = await b.evaluate(`__moss.coverage()`);
    check('painted moss grows and creeps outward', p1 > p0 && p2 > p1 && p2 > 0, `${(p0 * 1e4).toFixed(0)} -> ${(p1 * 1e4).toFixed(0)} -> ${(p2 * 1e4).toFixed(0)} (per 10k)`);
    await shot('painted');
    for (let i = 0; i < 8; i++) await b.evaluate(`__moss.paintAt(${612 + i * 8}, 470, 'scrape')`);
    await b.evaluate('__moss.step(90)');
    const p3 = await b.evaluate(`__moss.coverage()`);
    check('scraping strips it', p3 < p2 * 0.8, `${(p2 * 1e4).toFixed(0)} -> ${(p3 * 1e4).toFixed(0)}`);
    const t1 = Date.now(); await b.evaluate('__moss.step(10)'); const ms = (Date.now() - t1) / 10;
    console.log(`     ${ms.toFixed(0)} ms per frame (SwiftShader, desktop tier)`);
    // full growth looks green
    await b.evaluate(`__moss.G.clear(); __moss.set('grow', 1); __moss.step(2)`); await sleep(200);
    const full = await frameStats();
    check('a grown glen is green', full.green > 0.25, `green ${full.green.toFixed(2)}`);
    // phone tier
    await device(390, 844, true);
    await open('q=0');
    await b.evaluate('__moss.step(2)'); await sleep(200);
    const ph = await frameStats(); er = errors();
    check('phone tier renders without errors', er.length === 0 && ph.mean > 25 && ph.sd > 8, `mean ${ph.mean.toFixed(0)} sd ${ph.sd.toFixed(1)} ${er.slice(0, 2).join(' | ').slice(0, 400)}`);
    const pinfo = await b.evaluate(`({ v: __moss.verts, ms: __moss.buildMs })`);
    console.log(`     phone tier: ${pinfo.v} mossable vertices, built in ${pinfo.ms.toFixed(0)} ms`);
    await shot('phone');
    er = errors();
    check('no errors after all of it', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 600));
  } catch (e) { console.log('FAIL', e.message); failed++; } finally {
    b.kill(); server.close();
    console.log(failed ? `${failed} failed` : 'all ok'); process.exit(failed ? 1 : 0);
  }
})();

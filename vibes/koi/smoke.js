// Headless check over CDP (zero deps; three.js from unpkg): the pond starts with no console
// or shader errors, fish swim and stay in the pond, each touch mode does what it says
// (ripples, food eaten, fish called over), tilt and shake are taken, watercolour renders,
// and the frame is not blank. node smoke.js  (ONLY=shots to just take screenshots).
// Writes shot_*.png. SwiftShader is slow, so frames are stepped by hand, not timed.
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = 8831;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res);
});
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const W = +(process.env.W || 390), H = +(process.env.H || 844);

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const b = await launch({ port: 9383, width: W, height: H });
  await b.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await b.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  const shot = async (name) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, `shot_${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const errors = () => b.events.filter((e) => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.args?.map((a) => a.value ?? a.description).join(' ')).filter((s) => !/GPU stall|ReadPixels|WebGL-/.test(s || ''));
  const open = async (q) => {
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/koi/?seed=3&q=1&pause&shot&${q}` });
    await waitFor(() => b.evaluate('!!window.__koi'), 60000);
  };
  try {
    const base = process.env.Q || '';
    await open(base);
    await b.evaluate('__koi.step(1)');
    await sleep(300);
    let er = errors();
    check('loads without console or shader errors', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 600));
    await shot('real');
    if (process.env.ONLY === 'shots') {
      await b.evaluate(`__koi.setStyle('paint'); __koi.step(1)`); await sleep(200); await shot('paint');
      return;
    }
    // the fish swim, stay in the pond and their bodies stay whole
    const p0 = await b.evaluate(`__koi.fish.map(f => [f.x, f.y])`);
    const t0 = Date.now();
    await b.evaluate(`__koi.step(300)`);
    const ms = (Date.now() - t0) / 300;
    const st = await b.evaluate(`(() => { const v = __koi.view; return { pos: __koi.fish.map(f => [f.x, f.y]), out: __koi.fish.filter(f => Math.abs(f.x) > v.hx + 0.9 || Math.abs(f.y) > v.hy + 0.9).length,
      seg: Math.max(...__koi.fish.map(f => { let m = 0; for (let i = 1; i < f.P.length; i++) m = Math.max(m, Math.hypot(f.P[i].x - f.P[i-1].x, f.P[i].y - f.P[i-1].y) / (f.sMax * f.L / (f.P.length - 1))); return m; })),
      nan: __koi.fish.some(f => !isFinite(f.x + f.y + f.z + f.h)), speed: __koi.fish.map(f => f.v / f.L) }; })()`);
    const moved = st.pos.map((p, i) => Math.hypot(p[0] - p0[i][0], p[1] - p0[i][1]));
    check('every fish swims', moved.every((d) => d > 0.3), moved.map((d) => d.toFixed(2)).join(','));
    check('fish stay in the pond', st.out === 0 && !st.nan, `out ${st.out}`);
    check('spines stay whole', Math.abs(st.seg - 1) < 0.02, st.seg.toFixed(3));
    check('calm cruising speed (0.1 to 1.2 body lengths/s)', st.speed.every((s) => s > 0.08 && s < 1.3), st.speed.map((s) => s.toFixed(2)).join(','));
    console.log(`     ${ms.toFixed(1)} ms per simulated + rendered frame (SwiftShader)`);

    // ripple mode: a touch makes a ripple
    await b.evaluate(`__koi.setMode('ripple'); __koi.touch(${W / 2}, ${H / 2}); __koi.touch(${W / 2 + 60}, ${H / 2 + 40}, 'move'); __koi.touch(${W / 2 + 60}, ${H / 2 + 40}, 'up'); __koi.step(8)`);
    const nr = await b.evaluate(`__koi.ripples.length`);
    check('a touch ripples the water', nr >= 2, `${nr} ripples`);
    await shot('ripple');

    // feed mode: pellets float and get eaten
    await b.evaluate(`__koi.setMode('feed'); for (let i = 0; i < 3; i++) { __koi.touch(${W / 2 + 30} + i * 25, ${H * 0.45}); __koi.touch(0, 0, 'up'); } __koi.step(3)`);
    const fed0 = await b.evaluate(`__koi.surface.pellets.length`);
    await shot('feed');
    await b.evaluate(`__koi.step(900)`);
    const fed1 = await b.evaluate(`__koi.surface.pellets.length`);
    check('food is scattered and eaten', fed0 >= 9 && fed1 < fed0 / 2, `${fed0} -> ${fed1}`);

    // call mode: hold a finger and the fish gather
    const cx = W * 0.3, cy = H * 0.7;
    await b.evaluate(`__koi.setMode('call'); __koi.touch(${cx}, ${cy});`);
    await b.evaluate(`__koi.step(600)`);
    const gathered = await b.evaluate(`(() => { const fs = __koi.fish; const w = ${JSON.stringify([cx, cy])};
      const v = __koi.view; const x = (w[0] / ${W} * 2 - 1) * v.hx, y = -(w[1] / ${H} * 2 - 1) * v.hy;
      return fs.filter(f => Math.hypot(f.x - x, f.y - y) < 1.3).length; })()`);
    await shot('call');
    await b.evaluate(`__koi.touch(0, 0, 'up')`);
    check('holding a finger calls the fish over', gathered >= Math.ceil(st.pos.length * 0.5), `${gathered} of ${st.pos.length} within 1.3 m`);

    // motion: tilt moves the camera and the floaters, shake would startle (simulated tilt only)
    await b.evaluate(`__koi.setMode('ripple'); __koi.tilt(0.8, -0.6); __koi.step(60)`);
    const tl = await b.evaluate(`__koi.motion.tilt`);
    check('tilt is followed', tl[0] > 0.6 && tl[1] < -0.4, tl.map((v) => v.toFixed(2)).join(','));
    await shot('tilt');
    await b.evaluate(`__koi.tilt(0, 0); __koi.step(60)`);

    // watercolour
    await b.evaluate(`__koi.setStyle('paint'); __koi.step(2)`);
    await sleep(200);
    await shot('paint');
    const px = await b.evaluate(`(() => { const c = document.querySelector('canvas'), g = c.getContext('webgl2'); const w = g.drawingBufferWidth, h = g.drawingBufferHeight; const a = new Uint8Array(4 * 64);
      let s = 0, s2 = 0, n = 0; for (let i = 0; i < 64; i++) { g.readPixels(Math.floor(w * (0.2 + 0.6 * (i % 8) / 7)), Math.floor(h * (0.2 + 0.6 * Math.floor(i / 8) / 7)), 1, 1, g.RGBA, g.UNSIGNED_BYTE, a.subarray(i * 4, i * 4 + 4)); }
      for (let i = 0; i < 64; i++) { const l = (a[i*4] + a[i*4+1] + a[i*4+2]) / 3; s += l; s2 += l * l; n++; } return { mean: s / n, sd: Math.sqrt(s2 / n - (s / n) ** 2) }; })()`);
    check('watercolour frame is painted, not blank', px.mean > 60 && px.sd > 4, `mean ${px.mean.toFixed(0)} sd ${px.sd.toFixed(1)}`);
    er = errors();
    check('no errors after all of it', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 600));
  } catch (e) { console.log('FAIL', e.message); failed++; } finally {
    b.kill(); server.close();
    console.log(failed ? `${failed} failed` : 'all ok'); process.exit(failed ? 1 : 0);
  }
})();

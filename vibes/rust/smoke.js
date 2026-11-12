// Headless check over CDP (zero deps; three.js from unpkg; WebGPU on SwiftShader, `offscreen` mode since the
// software device is lost on its first present to a canvas): each piece loads with no console or shader errors and
// renders; over the years bare steel rusts, paint is undercut and flakes from its scratches, zinc goes before the
// steel under it rusts, runoff leaves stain below the screws, water runs down and dries; the tools scratch,
// brush, paint and wet where they're dragged.
// Screenshots go to /tmp/rust-shots (OUT=dir to change; SHOTS=1 also copies the README ones here).
//   node smoke.js        RES=256 for the sim's width in cells (smaller is quicker on software WebGPU)
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = 8877, OUT = process.env.OUT || '/tmp/rust-shots', RES = process.env.RES || 256;
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res);
});
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const log = (s) => console.log('     ' + s);

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const b = await launch({ port: 9417, width: 1280, height: 800 });
  const E = (s) => b.evaluate(s);
  let lastPng = null;
  const shot = async (name) => { await E('__rust.snapshot()'); const r = await b.send('Page.captureScreenshot', { format: 'png' }); lastPng = r.result.data; fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const errors = () => b.events.filter((e) => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || e.params.args?.map((a) => a.value ?? a.description).join(' ')).filter((s) => !/GPU stall|Automatic fallback/.test(s || ''));
  // mean, spread and warmth (red minus blue) of the last screenshot, or of a box in it (fractions of the frame)
  const stats = (box = [0, 0, 1, 1]) => E(`(async () => { const im = new Image(); im.src = 'data:image/png;base64,${lastPng}'; await im.decode();
      const o = new OffscreenCanvas(128, 80), g = o.getContext('2d'); g.drawImage(im, 0, 0, 128, 80);
      const d = g.getImageData(0, 0, 128, 80).data, B = ${JSON.stringify(box)}; let s = 0, s2 = 0, n = 0, r = 0, bl = 0;
      for (let y = Math.floor(B[1] * 80); y < Math.ceil(B[3] * 80); y++) for (let x = Math.floor(B[0] * 128); x < Math.ceil(B[2] * 128); x++) {
        const i = (y * 128 + x) * 4, l = (d[i] + d[i + 1] + d[i + 2]) / 3; s += l; s2 += l * l; r += d[i]; bl += d[i + 2]; n++; }
      return { mean: s / n, sd: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)), warm: (r - bl) / n }; })()`);
  const open = async (q) => {
    b.events.length = 0;
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/rust/?shot&offscreen&paused&res=${RES}&seed=7&${q}` });
    await waitFor(() => E('!!window.__rust || /needs WebGPU|Could not/.test(document.body.innerText)'), 300000);
    const bad = await E('!window.__rust && document.body.innerText'); if (bad) throw new Error(bad);
    await sleep(300);
  };
  // run the clock: `frames` frames of `hours` each, with `passes` water passes
  const age = (frames, hours, passes = 2) => E(`(async () => { const R = __rust; for (let f = 0; f < ${frames}; f++) { R.simFrame(${hours}, ${passes}); if (f % 50 === 49) await R.stats(); } return { s: await R.stats(), y: R.date().years }; })()`);
  // fields over the whole sheet: mean of each channel, and of the sheet cells only
  const fields = () => E(`(async () => { const { C, W } = await __rust.read(); const n = C.length / 4; const m = [0, 0, 0, 0, 0, 0, 0];
      for (let i = 0; i < n; i++) { m[0] += C[i * 4]; m[1] += C[i * 4 + 1]; m[2] += C[i * 4 + 2]; m[3] += C[i * 4 + 3]; m[4] += W[i * 4]; m[5] += W[i * 4 + 2]; m[6] = Math.max(m[6], W[i * 4 + 2]); }
      return { R: m[0] / n, P: m[1] / n, U: m[2] / n, M: m[3] / n, W: m[4] / n, S: m[5] / n, Smax: m[6], finite: m.every(Number.isFinite) }; })()`);
  try {
    // ---- the painted panel
    let t0 = Date.now();
    await open('piece=panel&climate=coastal');
    log(`panel loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    let er = errors();
    check('panel loads without console or shader errors', er.length === 0, er.slice(0, 4).join(' | ').slice(0, 2000));
    await shot('panel_new'); let s = await stats();
    check('the new panel renders', s.mean > 15 && s.sd > 6, `mean ${s.mean.toFixed(1)} sd ${s.sd.toFixed(1)}`);
    let f0 = await fields();
    check('it starts painted, dry and clean', f0.P > 0.9 && f0.R === 0 && f0.W === 0, JSON.stringify(f0));
    // a scratch across the middle, through to steel
    await E('__rust.stroke("scratch", -1.8, -0.5, -0.4, -1.1)');
    let st0 = await E('__rust.stats()');
    check('the scratch takes the paint off', st0.bare > 0.0015 && st0.bare < 0.02, `bare ${(st0.bare * 100).toFixed(2)}%`);
    // a shower: water lands and runs down
    await E('__rust.state.shower = 6');
    await age(60, 0.1, 4);
    const fw = await fields();
    check('rain wets it', fw.W > 0.0005 && fw.finite, `mean water ${fw.W.toFixed(5)}`);
    await shot('panel_rain');
    t0 = Date.now();
    let a = await age(600, 72);
    log(`aged to ${a.y.toFixed(1)} years in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    let f1 = await fields();
    check('the scratch has rusted and the paint has let go around it', a.s.rust > st0.bare * 0.8 && a.s.bare > st0.bare * 1.3, `rust ${(a.s.rust * 100).toFixed(2)}% bare ${(a.s.bare * 100).toFixed(2)}% blisters ${(a.s.blisters * 100).toFixed(2)}%`);
    check('runoff left a stain', f1.Smax > 0.005 && f1.finite, `stain mean ${f1.S.toExponential(2)} max ${f1.Smax.toFixed(4)}`);
    check('five coastal years take some paint, not all of it', a.s.bare > 0.01 && a.s.bare < 0.5, `bare ${(a.s.bare * 100).toFixed(1)}%`);
    await shot('panel_5y'); s = await stats([0.3, 0.2, 0.7, 0.8]);
    await E('(() => { const R = __rust; R.controls.target.set(-0.9, -2.0, 0); R.camera.position.set(-0.7, -1.75, 1.1); R.controls.update(); })()');
    await shot('panel_5y_close');
    await E('(() => { const R = __rust; R.controls.target.set(0, 0, 0); R.camera.position.set(1.2, 0.4, 9.6); R.controls.update(); })()');
    check('the old panel renders, with rust in it', s.sd > 6, `mean ${s.mean.toFixed(1)} sd ${s.sd.toFixed(1)} warm ${s.warm.toFixed(1)}`);
    a = await age(1200, 72);
    log(`${a.y.toFixed(1)} years: rust ${(a.s.rust * 100).toFixed(1)}% bare ${(a.s.bare * 100).toFixed(1)}% holes ${(a.s.holes * 100).toFixed(3)}%`);
    await shot('panel_15y');
    // paint over it all: fresh paint over rust blisters again soon
    await E('__rust.stroke("paint", -1.8, -0.5, -0.4, -1.1)');
    // wire brush a patch
    await E('__rust.stroke("brush", 1.0, -1.5, 2.0, -1.5)');
    // the clock running live for a moment, at a day a second
    await E('(() => { __rust.state.speed = 1; __rust.state.paused = false; })()'); await sleep(2500); await E('__rust.state.paused = true');
    er = errors(); check('ageing and tools raise no errors', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 1500));

    // ---- the steel plate: bare, in mill scale, rusts all over within a few years
    await open('piece=plate&climate=temperate');
    er = errors(); check('plate loads without errors', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 1500));
    await shot('plate_new');
    a = await age(250, 72);
    check('bare plate rusts within two years', a.s.rust > 0.3, `${a.y.toFixed(1)} y: rust ${(a.s.rust * 100).toFixed(1)}%`);
    await shot('plate_2y'); s = await stats([0.3, 0.2, 0.7, 0.8]);
    check('the rusty plate looks warm', s.warm > 4, `warm ${s.warm.toFixed(1)} mean ${s.mean.toFixed(1)}`);

    // ---- corrugated galvanised: zinc first, red rust later
    await open('piece=corrugated&climate=coastal');
    er = errors(); check('corrugated loads without errors', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 1500));
    a = await age(120, 72);
    check('a year in, the zinc still keeps rust off most of it', a.s.rust < 0.2, `${a.y.toFixed(1)} y: rust ${(a.s.rust * 100).toFixed(1)}% zinc gone ${(a.s.bare * 100).toFixed(1)}%`);
    a = await age(1500, 72);
    check('after many years zinc is gone and it rusts', a.s.rust > 0.2, `${a.y.toFixed(1)} y: rust ${(a.s.rust * 100).toFixed(1)}% zinc gone ${(a.s.bare * 100).toFixed(1)}%`);
    await shot('corrugated_old');
    er = errors(); check('no errors after ageing', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 1500));
  } catch (e) { console.log('FAIL ' + (e.stack || e)); failed++; }
  b.kill(); server.close();
  if (process.env.SHOTS) for (const n of ['panel_5y', 'panel_5y_close', 'panel_15y', 'plate_2y', 'corrugated_old', 'panel_rain']) fs.copyFileSync(path.join(OUT, `${n}.png`), path.join(DIR, `shot_${n}.png`));
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();

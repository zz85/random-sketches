// Headless check over CDP (zero deps; three.js from unpkg): the orrery builds with no console or shader
// errors and renders something that isn't blank, inside and from outside. Screenshots go to /tmp/orrery-shots
// (not into the repo).   node smoke.js      Q='lat=..&t=..' for another sky.
// Software GL is lavapipe when installed (see cdp.js); WebGL 2 backend, frames stepped by hand.
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = 8853, OUT = process.env.OUT || '/tmp/orrery-shots';
fs.mkdirSync(OUT, { recursive: true });
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
  const b = await launch({ port: 9393, width: 1280, height: 800 });
  console.log(`     software GL: ${b.lavapipe ? 'lavapipe' : 'SwiftShader'}`);
  const shot = async (name) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); lastPng = r.result.data; fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const errors = () => b.events.filter((e) => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || e.params.args?.map((a) => a.value ?? a.description).join(' ')).filter((s) => !/GPU stall|ReadPixels|WebGL-|Automatic fallback/.test(s || ''));
  const open = async (q) => {
    b.events.length = 0;
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/orrery/?shot&webgl&${q}` });
    await waitFor(() => b.evaluate('!!window.__orr || /Could not/.test(document.body.innerText)'), 240000);
    const bad = await b.evaluate('!window.__orr && document.body.innerText');
    if (bad) throw new Error(bad);
  };
  // statistics of the last screenshot, decoded in the page (no PNG decoder needed here)
  let lastPng = null;
  const stats = () => b.evaluate(`(async () => { const im = new Image(); im.src = 'data:image/png;base64,${lastPng}'; await im.decode();
      const o = new OffscreenCanvas(64, 40), g = o.getContext('2d'); g.drawImage(im, 0, 0, 64, 40);
      const d = g.getImageData(0, 0, 64, 40).data; let s = 0, s2 = 0, n = 0; for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; s += l; s2 += l * l; n++; }
      return { mean: s / n, sd: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) }; })()`);
  try {
    const t0 = Date.now();
    // Miniature: the watch, a night with the Moon up over Seattle
    await open(process.env.Q || 't=2026-10-29T07:00:00Z');
    console.log(`     loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s, backend ${await b.evaluate('__orr.backend')}`);
    await b.evaluate('__orr.step(3)'); await sleep(300);
    let er = errors();
    check('loads without console or shader errors', er.length === 0, er.slice(0, 4).join(' | ').slice(0, 1500));
    await shot('mini'); let s = await stats();
    check('miniature renders', s.mean > 8 && s.sd > 6, `mean ${s.mean.toFixed(1)} sd ${s.sd.toFixed(1)}`);
    await b.evaluate(`__orr.select('Jupiter'); __orr.step(2)`); await sleep(200); await shot('mini_card');
    // the chart flipped to the ground view
    await b.evaluate(`__orr.flipChart(-1); for (let i = 0; i < 40; i++) __orr.step(1)`); await sleep(200); await shot('mini_ground');
    // Immersive
    await open('mode=sky&t=2026-10-29T07:00:00Z&yaw=100&pitch=30');
    await b.evaluate('__orr.step(3)'); await sleep(300);
    await shot('sky_night'); s = await stats();
    check('immersive night renders', s.mean > 4 && s.sd > 3, `mean ${s.mean.toFixed(1)} sd ${s.sd.toFixed(1)}`);
    const moon = await b.evaluate(`(() => { const m = __orr.sky.bodies.Moon; return { alt: m.alt, az: m.az }; })()`);
    console.log(`     Moon alt ${moon.alt.toFixed(1)} az ${moon.az.toFixed(1)}`);
    for (const k of ['Moon', 'Jupiter', 'Saturn']) {
      await b.evaluate(`(() => { const s = __orr.state, d = __orr.sky.bodies.${k}.dir; s.yaw = Math.atan2(-d.x, -d.z); s.pitch = Math.asin(d.y); s.fov = ${k === 'Moon' ? 14 : 30}; __orr.skyCam.fov = s.fov; __orr.step(3); })()`); await sleep(200);
      await shot('sky_' + k.toLowerCase());
    }
    await open('mode=sky&t=2026-11-06T20:00:00Z&yaw=180&pitch=15');
    await b.evaluate('__orr.step(3)'); await sleep(200);
    await shot('sky_day'); s = await stats();
    check('day is brighter than night', s.mean > 40, `mean ${s.mean.toFixed(1)}`);
    er = errors(); check('no errors in later views', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 900));
  } catch (e) { check('run', false, e.message); }
  b.kill(); server.close();
  console.log(failed ? `${failed} failed` : 'all passed', `(shots in ${OUT})`);
  process.exit(failed ? 1 : 0);
})();

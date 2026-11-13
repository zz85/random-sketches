// Headless check over CDP (zero deps; three.js from unpkg; WebGPU on SwiftShader, `offscreen` mode since the
// software device is lost on its first present to a canvas): each scene builds with no console or shader
// errors and renders a frame that isn't flat, with both paint and rust in it; the field reads back finite;
// growing the rust moves the front into the paint.
// Screenshots go to /tmp/oxide-shots (OUT=dir to change; SHOTS=1 also copies the README ones here).
//   node smoke.js        RES=512 for the field's size in texels (smaller is quicker on software WebGPU)
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = 8878, OUT = process.env.OUT || '/tmp/oxide-shots', RES = process.env.RES || 512;
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
const ONLY = process.env.ONLY;

// each scene, and the views the README shows: [name, scene, seed, camera position and target]
const VIEWS = [
  ['tide', 'tide', 11, [0.45, 0.42, 0.75, 0, 0.02, 0]],
  ['tide_low', 'tide', 11, [-0.55, 0.16, 0.35, -0.1, 0.02, 0.05]],
  ['plates', 'plates', 3, [0.2, 0.7, 0.75, 0, 0.02, 0]],
  ['plates_close', 'plates', 3, [0.12, 0.2, 0.32, 0, 0.02, 0.05]],
  ['powder', 'powder', 5, [0.35, 0.3, 0.55, 0, 0.02, 0]],
  ['powder_close', 'powder', 5, [0.1, 0.13, 0.22, 0, 0.02, 0]],
  ['lace', 'lace', 8, [0.4, 0.55, 0.7, 0, 0.02, 0]],
  ['lace_top', 'lace', 8, [0.02, 1.1, 0.2, 0, 0.02, 0]],
];

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const b = await launch({ port: 9418, width: 1280, height: 800 });
  const E = (s) => b.evaluate(s);
  let lastPng = null;
  const shot = async (name) => { await E('__oxide.snapshot()'); const r = await b.send('Page.captureScreenshot', { format: 'png' }); lastPng = r.result.data; fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const errors = () => b.events.filter((e) => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || e.params.args?.map((a) => a.value ?? a.description).join(' ')).filter((s) => !/GPU stall|Automatic fallback/.test(s || ''));
  // mean, spread and how much of the frame is teal (paint) and how much orange-brown (rust)
  const stats = () => E(`(async () => { const im = new Image(); im.src = 'data:image/png;base64,${lastPng}'; await im.decode();
      const o = new OffscreenCanvas(160, 100), g = o.getContext('2d'); g.drawImage(im, 0, 0, 160, 100);
      const d = g.getImageData(0, 0, 160, 100).data; let s = 0, s2 = 0, n = 0, teal = 0, rust = 0;
      for (let i = 0; i < d.length; i += 4) { const r = d[i], gg = d[i + 1], bb = d[i + 2], l = (r + gg + bb) / 3; s += l; s2 += l * l; n++;
        if (bb > r + 8 && gg > r) teal++; else if (r > bb + 12 && r >= gg) rust++; }
      return { mean: s / n, sd: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)), teal: teal / n, rust: rust / n }; })()`);
  try {
    let t0 = Date.now();
    b.events.length = 0;
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/oxide/?shot&offscreen&still&res=${RES}&scene=tide&seed=11` });
    await waitFor(() => E('!!window.__oxide || /needs WebGPU|Could not/.test(document.body.innerText)'), 300000);
    const bad = await E('!window.__oxide && document.body.innerText'); if (bad) throw new Error(bad);
    log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    let cur = null;
    for (const [name, sc, seed, cam] of VIEWS) {
      if (ONLY && !name.includes(ONLY)) continue;
      if (cur !== sc + seed) { await E(`__oxide.set('${sc}', ${seed})`); cur = sc + seed; }
      await E(`__oxide.view(${JSON.stringify(cam)})`);
      t0 = Date.now(); await shot(name); const s = await stats();
      const er = errors();
      check(`${name}: renders with no errors`, er.length === 0, er.slice(0, 3).join(' | ').slice(0, 600));
      check(`${name}: not flat`, s.sd > 10 && s.mean > 8, `mean ${s.mean.toFixed(1)} sd ${s.sd.toFixed(1)} teal ${(s.teal * 100).toFixed(0)}% rust ${(s.rust * 100).toFixed(0)}% (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      if (!name.includes('_')) check(`${name}: paint and rust both show`, s.teal > 0.03 && s.rust > 0.05);
      b.events.length = 0;
    }
    if (!ONLY || ONLY === 'fly') {
      // the lander: it flies off, stays over the ground, and the frame holds both paint and rust somewhere on the way
      await E(`__oxide.set('lace', 8)`); await E(`__oxide.view([0.4, 0.55, 0.7, 0, 0.02, 0])`);
      const a = await E(`(async () => { const ys = []; for (let i = 0; i < 18; i++) { await __oxide.fly(1); ys.push(__oxide.camera.position.y); }
        const s = __oxide.ship; let jump = 0; for (let i = 2; i < ys.length; i++) jump = Math.max(jump, Math.abs(ys[i] - 2 * ys[i - 1] + ys[i - 2]));
        return { x: s.x, z: s.z, y: __oxide.camera.position.y, g: __oxide.ground.under, jump }; })()`);
      check('it glides: no sudden climbs or drops', a.jump < 0.012, `largest change in climb rate ${a.jump.toFixed(4)} cm/s in a second`);
      await shot('fly_cruise'); const s1 = await stats();
      const c = await E('__oxide.fly(14).then((s) => ({ x: s.x, z: s.z, y: s.y, g: s.ground, h: s.h }))');
      await shot('fly_low'); const s2 = await stats();
      check('the orbiter flies', Math.hypot(a.x - 0.4, a.z - 0.7) > 1.2, `at ${a.x.toFixed(2)}, ${a.z.toFixed(2)} after 18 s`);
      check('it stays above the ground', a.y > a.g + 0.01 && c.y > c.g + 0.01, `${(a.y - a.g).toFixed(3)} then ${(c.y - c.g).toFixed(3)} cm up`);
      check('flying shots render', s1.sd > 10 && s2.sd > 10 && errors().length === 0, errors().slice(0, 2).join(' | ').slice(0, 400));
      b.events.length = 0;
    }
    if (!ONLY || ONLY === 'listen') {
      // Listen, with the test source (no audio device): the plow corrodes a furrow where the orbiter flies
      await E(`__oxide.set('lace', 8)`); await E(`__oxide.view([0.35, 0.5, 0.6, 0, 0.02, 0])`);
      await E(`__oxide.listen('test')`);
      const o = await E('__oxide.fly(14).then((s) => ({ x: s.x, z: s.z, y: s.y, g: s.ground }))');
      const tr = await E('__oxide.trail()');
      await shot('listen'); const er = errors();
      check('listen: renders with no errors', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 600));
      check('listen: the plow cuts a furrow where the camera goes', tr.max > 0.2 && tr.cut > 0.3 && tr.cut < 20, `deepest ${tr.max.toFixed(2)}, ${tr.cut.toFixed(2)} cm2 cut`);
      check('listen: the camera still flies over it', o.y > o.g + 0.05 && Math.hypot(o.x - 0.35, o.z - 0.6) > 0.8, `at ${o.x.toFixed(2)}, ${o.z.toFixed(2)}, ${(o.y - o.g).toFixed(2)} cm up`);
      await E(`__oxide.view([${o.x}, ${o.g + 0.55}, ${o.z}, ${o.x}, ${o.g}, ${o.z - 0.6}])`); // looking back down the furrow
      await shot('listen_trail');
      await E(`__oxide.listen('off')`); await E('__oxide.hear(3)');
      b.events.length = 0;
    }
    if (!ONLY || ONLY === 'grow') {
      await E(`__oxide.set('tide', 11)`); await E(`__oxide.view([0.02, 1.4, 0.2, 0, 0.02, 0])`);
      await shot('grow_0'); const a = await stats();
      await E('__oxide.grow(0.25)'); await shot('grow_1'); const c = await stats();
      check('growing the rust takes paint', c.teal < a.teal - 0.03 && c.rust > a.rust, `teal ${(a.teal * 100).toFixed(0)}% -> ${(c.teal * 100).toFixed(0)}%`);
    }
  } catch (e) { check('run', false, e.message); }
  b.kill(); server.close();
  if (process.env.SHOTS) for (const n of ['tide', 'tide_low', 'plates_close', 'powder_close', 'lace']) fs.copyFileSync(path.join(OUT, `${n}.png`), path.join(DIR, `shot_${n}.png`));
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();

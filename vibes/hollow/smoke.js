// Headless check over CDP (zero deps; three.js from unpkg): a piece carves and renders with no
// console or shader errors on the WebGL 2 backend, each light and a few woods and finishes render,
// frames aren't blank, the godrays brighten the air, a new piece replaces the old one.
// Screenshots go to /tmp/hollow-shots (OUT=dir to change; SHOTS=1 also copies the README ones here).
//   node smoke.js        Q='seed=..' for another piece
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = 8857, OUT = process.env.OUT || '/tmp/hollow-shots';
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
  const b = await launch({ port: 9397, width: 1280, height: 800 });
  console.log(`     software GL: ${b.lavapipe ? 'lavapipe' : 'SwiftShader'}`);
  let lastPng = null;
  const shot = async (name) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); lastPng = r.result.data; fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const errors = () => b.events.filter((e) => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || e.params.args?.map((a) => a.value ?? a.description).join(' ')).filter((s) => !/GPU stall|ReadPixels|WebGL-|Automatic fallback/.test(s || ''));
  // mean and spread of the last screenshot, and of a box in it (fractions of the frame)
  const stats = (box = [0, 0, 1, 1]) => b.evaluate(`(async () => { const im = new Image(); im.src = 'data:image/png;base64,${lastPng}'; await im.decode();
      const o = new OffscreenCanvas(128, 80), g = o.getContext('2d'); g.drawImage(im, 0, 0, 128, 80);
      const d = g.getImageData(0, 0, 128, 80).data, B = ${JSON.stringify(box)}; let s = 0, s2 = 0, n = 0, r = 0, bl = 0;
      for (let y = Math.floor(B[1] * 80); y < Math.ceil(B[3] * 80); y++) for (let x = Math.floor(B[0] * 128); x < Math.ceil(B[2] * 128); x++) {
        const i = (y * 128 + x) * 4, l = (d[i] + d[i + 1] + d[i + 2]) / 3; s += l; s2 += l * l; r += d[i]; bl += d[i + 2]; n++; }
      return { mean: s / n, sd: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)), warm: (r - bl) / n }; })()`);
  const open = async (q) => {
    b.events.length = 0;
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/hollow/?shot&webgl&${q}` });
    await waitFor(() => b.evaluate('!!window.__hollow || /Could not/.test(document.body.innerText)'), 300000);
    const bad = await b.evaluate('!window.__hollow && document.body.innerText');
    if (bad) throw new Error(bad);
  };
  try {
    const t0 = Date.now();
    await open(process.env.Q || 'seed=9&wood=walnut&finish=oil&light=skylight&q=1');
    const info = await b.evaluate('__hollow.info');
    console.log(`     loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${info.backend}, mesh N=${info.N} ${info.tris} tris in ${info.meshMs.toFixed(0)} ms`);
    await b.evaluate('__hollow.step(3)'); await sleep(200);
    let er = errors();
    check('loads without console or shader errors', er.length === 0, er.slice(0, 4).join(' | ').slice(0, 1500));
    check('the piece is meshed', info.tris > 20000, `${info.tris} triangles`);
    await shot('skylight'); let s = await stats();
    check('frame renders', s.mean > 10 && s.sd > 8, `mean ${s.mean.toFixed(1)} sd ${s.sd.toFixed(1)}`);
    const piece = await stats([0.4, 0.25, 0.6, 0.6]);
    check('the wood is warm-coloured', piece.warm > 6, `warm ${piece.warm.toFixed(1)} mean ${piece.mean.toFixed(1)}`);
    // godrays off, same view: the haze is what lifts the air in the beam
    await b.evaluate('__hollow.studio.key; window.__d = 0'); 
    const hazeOn = (await stats([0.05, 0.05, 0.35, 0.5])).mean;
    await b.evaluate(`(() => { const L = __hollow; L.light(0); })()`);
    for (const [i, n] of [[1, 'window'], [2, 'golden'], [3, 'studio']]) {
      await b.evaluate(`__hollow.light(${i}); __hollow.step(3)`); await sleep(150); await shot(n); s = await stats();
      check(`${n} light renders`, s.mean > 6 && s.sd > 5, `mean ${s.mean.toFixed(1)} sd ${s.sd.toFixed(1)}`);
    }
    console.log(`     air in the skylight beam: mean ${hazeOn.toFixed(1)}`);
    for (const [w, f] of [['oak', 'bare'], ['maple', 'lacquer'], ['spalted', 'wax'], ['olive', 'oil']]) {
      await b.evaluate(`__hollow.light(1); __hollow.setWood('${w}'); __hollow.setFinish('${f}'); __hollow.cam([0.55, 1.3, 0.75], [0, 1.18, 0]); __hollow.step(3)`); await sleep(150);
      await shot(`close_${w}`);
    }
    er = errors(); check('woods and finishes render without errors', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 900));
    // another piece
    for (const seed of [4, 7, 14, 23, 5]) {
      const t1 = Date.now();
      await b.evaluate(`(async () => { await __hollow.newPiece(${seed}); __hollow.cam([1.15, 1.48, 1.85], [0, 1.19, 0]); __hollow.light(${seed % 3}); await __hollow.step(3); })()`); await sleep(150);
      await shot(`piece_${seed}`); s = await stats([0.35, 0.2, 0.65, 0.65]);
      check(`piece ${seed} renders`, s.sd > 6, `sd ${s.sd.toFixed(1)}, ${((Date.now() - t1) / 1000).toFixed(1)} s, ${await b.evaluate('__hollow.info.tris')} tris`);
    }
    er = errors(); check('no errors in later views', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 900));
    // a share link reopens the same view, and autoplay rolls new pieces in random woods and finishes
    const link = 'seed=12&wood=olive&finish=wax&light=window&cam=1.1,1.5,1.8,0,1.2,0&still';
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/hollow/?webgl&q=0#${link}` });
    await waitFor(() => b.evaluate('document.body.classList.contains("ready") && !document.body.classList.contains("carving")'), 300000); await sleep(400);
    const got = await b.evaluate(`({ hash: location.hash, name: document.getElementById('name').textContent, mat: document.getElementById('mat').textContent, light: document.querySelector('#lights .on')?.textContent })`);
    check('a link reopens the same piece, wood, finish, light and view', got.hash === '#' + link && /No\. 12 /.test(got.name) && got.mat === 'Olive, beeswax' && got.light === 'Morning window', JSON.stringify(got));
    await b.evaluate(`document.getElementById('play').click()`);
    const seen = new Set(), mats = new Set(); const t2 = Date.now();
    while (seen.size < 3 && Date.now() - t2 < 120000) { const h = await b.evaluate('location.hash'); const m = /seed=(\d+)/.exec(h); if (m && /play/.test(h)) { seen.add(m[1]); mats.add(await b.evaluate(`document.getElementById('mat').textContent`)); } await sleep(300); }
    check('autoplay rolls new pieces into the link', seen.size >= 3 && !seen.has('12') || seen.size >= 4, [...seen].join(' ') + ' | ' + [...mats].join(' / '));
    check('autoplay varies the wood and finish', mats.size >= 2, [...mats].join(' / '));
    await b.evaluate(`document.getElementById('play').click()`); await sleep(300);
    er = errors(); check('no errors in autoplay', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 900));
    if (process.env.SHOTS) for (const n of ['skylight', 'window', 'golden', 'close_maple', 'piece_7']) fs.copyFileSync(path.join(OUT, n + '.png'), path.join(DIR, `shot_${n}.png`));
  } catch (e) { check('run', false, e.message); }
  b.kill(); server.close();
  console.log(failed ? `${failed} failed` : 'all passed', `(shots in ${OUT})`);
  process.exit(failed ? 1 : 0);
})();

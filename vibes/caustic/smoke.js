// Headless check over CDP (zero deps; three.js from unpkg; WebGL on SwiftShader): the page loads with no console
// or shader errors, each of the three surfaces is designed and its caustic, as the GPU draws it, matches the
// picture; the picture blurs away off the designed distance; the pool's waves stir it and it settles; the cup
// toy draws. Screenshots go to /tmp/caustic-shots (OUT=dir); SHOTS=1 also copies the README ones here.
//   node smoke.js
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = +process.env.PORT || 8893, OUT = process.env.OUT || '/tmp/caustic-shots';
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

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const b = await launch({ port: 9433, width: 1280, height: 800 });
  const E = (s) => b.evaluate(s);
  const shot = async (name) => { await sleep(400); const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64')); if (process.env.SHOTS) fs.writeFileSync(path.join(DIR, `shot_${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const errors = () => b.events.filter((e) => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || e.params.args?.map((a) => a.value ?? a.description).join(' ')).filter((s) => !/GPU stall|Automatic fallback|GL_CLOSE_PATH|swiftshader/i.test(s || ''));
  const idle = () => waitFor(() => E('window.__caustic && !__caustic.busy && !!__caustic.state.designs[__caustic.state.mode]'), 240000);
  try {
    const t0 = Date.now();
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/caustic/?shot&n=128` });
    await idle();
    console.log(`     loaded and designed in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await sleep(500);
    let er = errors();
    check('loads without console or shader errors', er.length === 0, er.slice(0, 4).join(' | ').slice(0, 1500));
    for (const mode of ['glass', 'mirror', 'water']) {
      if (mode !== 'glass') { await E(`__caustic.setMode('${mode}')`); await sleep(300); await idle(); }
      await E(`__caustic.setTilt(__caustic.CFG.${mode}.tilt, 0)`);
      const r = await E('__caustic.readCaustic()');
      check(`${mode}: the light draws the picture`, r.corr > 0.85, `corr ${r.corr.toFixed(3)}, mean ${r.mean.toFixed(2)}, max ${r.max.toFixed(1)}`);
      await sleep(300); await shot(mode);
      await E(`__caustic.setCamera('wall', true)`); await sleep(200); await shot(mode + '_screen');
      await E(`__caustic.setFocus(0.6)`); const off = await E('__caustic.readCaustic()');
      check(`${mode}: off the designed distance it falls apart`, off.corr < r.corr - (mode === 'water' ? 0.1 : 0.2), `corr ${off.corr.toFixed(3)} at 0.6 D`);
      await shot(mode + '_defocus');
      await E(`__caustic.setFocus(1); __caustic.setCamera('3d', true)`);
    }
    // the pool: a splash scrambles it, and it calms back
    await E(`__caustic.poke(0.5, 0.5); __caustic.stepWaves(25)`);
    const stir = await E('__caustic.readCaustic()');
    await shot('water_splash');
    await E(`__caustic.stepWaves(1500)`);
    const calm = await E('__caustic.readCaustic()');
    check('pool: a splash stirs the picture and the water settles', stir.corr < calm.corr - 0.03 && calm.corr > 0.85 && Number.isFinite(stir.mean), `stirred ${stir.corr.toFixed(3)}, settled ${calm.corr.toFixed(3)}`);
    // a new picture in the glass, by text
    await E(`__caustic.setMode('glass')`); await idle();
    await E(`__caustic.choose('text', 'hi!')`); await sleep(200); await idle();
    const tx = await E('__caustic.readCaustic()');
    check('glass: text', tx.corr > 0.85, `corr ${tx.corr.toFixed(3)}`);
    await E(`__caustic.setCamera('wall', true)`); await shot('glass_text');
    er = errors(); check('no errors after all that', er.length === 0, er.slice(0, 4).join(' | ').slice(0, 1500));
    // the cup
    b.events.length = 0;
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/caustic/cup.html?shot` });
    await waitFor(() => E('!!window.__cup'), 60000); await sleep(600);
    const cup = await E('__cup.stats()');
    check('cup: rays drawn and the cardioid is the brightest curve', cup.rays > 1000 && cup.peakOnCurve, JSON.stringify(cup));
    await shot('cup');
    for (const [k, name] of [['parabola', 'cup_parabola'], ['heart', 'cup_heart']]) { await E(`__cup.set('${k}')`); await sleep(400); await shot(name); }
    er = errors(); check('cup: no errors', er.length === 0, er.slice(0, 4).join(' | '));
  } catch (e) { console.error(e); failed++; }
  b.kill(); server.close();
  console.log(failed ? `${failed} FAILED` : 'all ok', `(shots in ${OUT})`);
  process.exit(failed ? 1 : 0);
})();

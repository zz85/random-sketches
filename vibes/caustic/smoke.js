// Headless check over CDP (zero deps; three.js from unpkg; WebGPU on SwiftShader or lavapipe, `offscreen` since
// the software device is lost on its first present to a canvas): each set loads with no console or shader
// errors, its caustic texture is lit and has lines, and a few frames render. Screenshots go to /tmp/caustic-shots
// (OUT=dir); SHOTS=1 also copies the README ones here.   node smoke.js     Q='nogi' to add to the query
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = +process.env.PORT || 8895, OUT = process.env.OUT || '/tmp/caustic-shots';
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
  const b = await launch({ port: 9435, width: 1280, height: 640 });
  const E = (s) => b.evaluate(s);
  await b.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  const shot = async (name) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); const buf = Buffer.from(r.result.data, 'base64'); fs.writeFileSync(path.join(OUT, `${name}.png`), buf); const keep = { corridor: 'corridor', office: 'office', hall_2: 'hall' }[name];
    if (process.env.SHOTS && keep) { const j = await b.send('Page.captureScreenshot', { format: 'jpeg', quality: 86 }); fs.writeFileSync(path.join(DIR, `shot_${keep}.jpg`), Buffer.from(j.result.data, 'base64')); } };
  const errors = () => b.events.filter((e) => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || e.params.args?.map((a) => a.value ?? a.description).join(' ')).filter((s) => !/GPU stall|Automatic fallback|powerPreference/i.test(s || ''));
  try {
  // SwiftShader's WebGPU loses its device on the haze (every shadowed, projected spot light sampled in a raymarch),
  // so the full look is checked on WebGL 2 and WebGPU is checked without the haze
  for (const [tag, q] of [['', 'webgl'], ['webgpu_', 'novol']]) {
    b.events.length = 0;
    const t0 = Date.now();
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/caustic/?shot&offscreen&${q}&${process.env.Q || ''}#corridor` });
    await waitFor(() => E("!!window.__caustic || !!document.querySelector('#status')?.dataset.err"), 300000);
    const bad = await E("document.querySelector('#status')?.dataset.err && document.body.innerText"); if (bad) throw new Error(bad);
    console.log(`     loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s, backend ${await E("__caustic.renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL'")}`);
    for (const set of ['corridor', 'office', 'hall']) {
      const t1 = Date.now();
      await E(`__caustic.show('${set}')`);
      const shots = await E('__caustic.sets[__caustic.set].shots.length');
      for (let i = 0; i < shots; i++) {
        await E(`__caustic.shot(${i}, 0.4)`);
        await E('__caustic.frame(8)'); // a few frames, for the temporal AA and GI to settle
        if (!tag || i === 0) await shot(`${tag}${set}${i ? '_' + i : ''}`);
      }
      const st = await E('__caustic.causticStats()');
      check(`${tag}${set}: the caustic is lit and has lines`, st.mean > 0.5 && st.mean < 1.6 && st.sd > 0.4 && st.max > 3, `mean ${st.mean.toFixed(2)}, sd ${st.sd.toFixed(2)}, max ${st.max.toFixed(1)}`);
      const er = errors(); check(`${tag}${set}: no console or shader errors`, er.length === 0, er.slice(0, 3).join(' | ').slice(0, 1500));
      if (!tag) {
        const sd = await E('__caustic.splashTest()');
        check(`${set}: a splash ripples the caustic`, sd > 0.02, `mean change ${sd.toFixed(3)}`);
        await E('__caustic.shot(0, 0.4)');
        const n = await E(`__caustic.splashAt(innerWidth * ${set === 'hall' ? 0.12 : 0.5}, innerHeight * ${set === 'hall' ? 0.3 : 0.5})`);
        check(`${set}: a tap on a lit wall lands in a caustic beam`, n > 0, `${n} beams`);
      }
      if (!tag) { await E('__caustic.shot(0, 0.4); __caustic.splashAll(1.2)'); await E('__caustic.frame(100)'); await shot(`splash_${set}`); }
      console.log(`     ${set}: ${shots} shots in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    }
    if (!tag) {
      // the Tune panel: no warmth gives a grey grade and white lamps; then a stormy, cold look for a screenshot
      await E("__caustic.show('office'); Object.assign(__caustic.TUNE, { warmth: 0 }); __caustic.applyTune()");
      const tint = await E('[...__caustic.LOOK.tint.value.toArray()]');
      check('tune: warmth 0 drains the amber', Math.max(...tint) - Math.min(...tint) < 1e-6, tint.map((v) => v.toFixed(3)).join(' '));
      await E("Object.assign(__caustic.TUNE, { warmth: 0.25, height: 1.8, sharp: 1.6, size: 0.6 }); __caustic.applyTune(); __caustic.shot(0, 0.4)");
      await E('__caustic.frame(8)'); await shot('tune_cold');
      await E("Object.assign(__caustic.TUNE, { warmth: 1, height: 1, sharp: 1, size: 1 }); __caustic.applyTune()");
      const mu = await E('__caustic.renderBars(4, 64)');
      check('music: four bars render with sound in them', mu.rms > 0.01 && mu.peak < 4 && Number.isFinite(mu.rms), `rms ${mu.rms.toFixed(3)}, peak ${mu.peak.toFixed(2)}, ${mu.seconds.toFixed(1)} s`);
      const er = errors(); check('tune and music: no console errors', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 1500));
    }
  }
  } catch (e) { console.error(e); console.error(errors().slice(0, 6).join('\n---\n').slice(0, 5000)); failed++; }
  b.kill(); server.close();
  console.log(failed ? `${failed} FAILED` : 'all ok', `(shots in ${OUT})`);
  process.exit(failed ? 1 : 0);
})();

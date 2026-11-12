// Headless check over CDP (zero deps; three.js from unpkg; WebGPU on SwiftShader, `offscreen` mode since the
// software device is lost on its first present to a canvas): each panel loads with no console or shader errors
// and renders; filaments grow from its defects and show as warm (steel) or pale (aluminium) threads; the scratch,
// chip and salt tools change the panel and start new ones; dry air stops growth and humid air starts it again.
// Screenshots go to /tmp/filiform-shots (OUT=dir to change; SHOTS=1 also copies the README ones here).
//   node smoke.js        RES=384 for the sim's width in cells
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = 8878, OUT = process.env.OUT || '/tmp/filiform-shots', RES = process.env.RES || 768;
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
  const b = await launch({ port: 9419, width: 1280, height: 800 });
  const E = (s) => b.evaluate(s);
  let lastPng = null;
  const shot = async (name) => { await E('__filiform.snapshot()'); const r = await b.send('Page.captureScreenshot', { format: 'png' }); lastPng = r.result.data; fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const errors = () => b.events.filter((e) => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || e.params.args?.map((a) => a.value ?? a.description).join(' ')).filter((s) => !/GPU stall|Automatic fallback/.test(s || ''));
  // mean, spread and warmth (red minus blue) of the last screenshot, or of a box in it (fractions of the frame)
  const stats = (box = [0, 0, 1, 1]) => E(`(async () => { const im = new Image(); im.src = 'data:image/png;base64,${lastPng}'; await im.decode();
      const o = new OffscreenCanvas(256, 160), g = o.getContext('2d'); g.drawImage(im, 0, 0, 256, 160);
      const d = g.getImageData(0, 0, 256, 160).data, B = ${JSON.stringify(box)}; let s = 0, s2 = 0, n = 0, r = 0, bl = 0;
      for (let y = Math.floor(B[1] * 160); y < Math.ceil(B[3] * 160); y++) for (let x = Math.floor(B[0] * 256); x < Math.ceil(B[2] * 256); x++) {
        const i = (y * 256 + x) * 4, l = (d[i] + d[i + 1] + d[i + 2]) / 3; s += l; s2 += l * l; r += d[i]; bl += d[i + 2]; n++; }
      return { mean: s / n, sd: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)), warm: (r - bl) / n }; })()`);
  const open = async (q) => {
    b.events.length = 0;
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/filiform/?shot&offscreen&paused&res=${RES}&seed=3&${q}` });
    await waitFor(() => E('!!window.__filiform || /needs WebGPU|Could not/.test(document.body.innerText)'), 300000);
    const bad = await E('!window.__filiform && document.body.innerText'); if (bad) throw new Error(bad);
    await sleep(300);
  };
  const st = () => E('__filiform.sim.stats()');
  const days = (d) => E(`(() => { const F = __filiform; const end = F.sim.now + ${d}; while (F.sim.now < end - 1e-9) F.advance(Math.min(6, (end - F.sim.now) * 24)); return F.sim.stats(); })()`);
  const PANEL = [0.25, 0.14, 0.75, 0.86]; // where the panel is in the frame
  try {
    // ---- the lacquered tinplate, fresh: the X scribed, nothing grown yet
    let t0 = Date.now();
    await open('piece=tinplate&age=0');
    log(`tinplate loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    let er = errors();
    check('tinplate loads without console or shader errors', er.length === 0, er.slice(0, 4).join(' | ').slice(0, 2000));
    await shot('tinplate_new'); const s0 = await stats(PANEL);
    check('the new panel renders', s0.mean > 30 && s0.sd > 4, `mean ${s0.mean.toFixed(1)} sd ${s0.sd.toFixed(1)} warm ${s0.warm.toFixed(1)}`);
    check('nothing has grown yet', (await st()).filaments === 0);
    // forty days at 85%: filaments out of the scribe, warm threads
    let s = await days(40);
    check('filaments grow out of the scribe', s.filaments > 60 && s.lengthMm > 300, `${s.filaments} filaments, ${s.lengthMm.toFixed(0)} mm`);
    check('they hardly ever cross', s.crossings / s.moves < 0.002, `${s.crossings} in ${s.moves} moves`);
    await shot('tinplate_40d'); const s1 = await stats(PANEL);
    check('the threads show: the panel is redder', s1.warm > s0.warm + 3, `sd ${s0.sd.toFixed(1)} -> ${s1.sd.toFixed(1)}, warm ${s0.warm.toFixed(1)} -> ${s1.warm.toFixed(1)}`);
    await E('__filiform.view(22, 27, 1.3)'); await shot('tinplate_close');
    // dry air: the heads stop; humid again: they go on
    await E('__filiform.setRh(0.5)'); const a = await st(); s = await days(20);
    check('below the threshold humidity nothing grows', s.lengthMm === a.lengthMm && s.active === 0, `${a.lengthMm.toFixed(1)} -> ${s.lengthMm.toFixed(1)} mm`);
    await E('__filiform.setRh(0.85)'); s = await days(10);
    check('humid again, they grow on', s.lengthMm > a.lengthMm + 20, `${a.lengthMm.toFixed(0)} -> ${s.lengthMm.toFixed(0)} mm`);
    // the tools: a salted scratch in a clear corner and a chip start new filaments
    await E('__filiform.home()');
    const d0 = await E('__filiform.sim.defect.reduce((a, v) => a + v, 0)');
    await E('__filiform.scratch(3, 37, 14, 30)'); await E('__filiform.chip(54, 4)'); await E('__filiform.salt(8.5, 33.5)');
    const d1 = await E('__filiform.sim.defect.reduce((a, v) => a + v, 0)');
    check('scratch and chip cut the coating', d1 > d0 + 50, `defect ${d0.toFixed(0)} -> ${d1.toFixed(0)}`);
    const near = () => E('__filiform.sim.fil.filter((f) => f.born > __filiform.sim.now - 21 && Math.hypot(f.x * __filiform.sim.mm - 8.5, f.y * __filiform.sim.mm - 33.5) < 8).length');
    await days(20);
    check('the new scratch starts filaments', (await near()) >= 3, `${await near()} near it`);
    // very humid: heads swell into blisters
    await E('__filiform.setRh(0.97)'); await days(8);
    const wide = await E('(() => { const s = __filiform.sim; const w = s.alive.map((f) => f.w * s.mm); return w.reduce((a, b) => a + b, 0) / Math.max(1, w.length); })()');
    check('at 97% the heads swell', wide > 0.5, `mean head width ${wide.toFixed(2)} mm`);
    await E('__filiform.setRh(0.85)');
    // the clock running live for a moment, at a week a second
    await E('(() => { __filiform.state.speed = 3; __filiform.state.paused = false; })()'); await sleep(2500); await E('__filiform.state.paused = true');
    await shot('tinplate_later');
    er = errors(); check('growing and tools raise no errors', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 1500));

    // ---- painted aluminium: ridges under white paint, from the sawn edge and the hole
    await open('piece=frame&age=90');
    er = errors(); check('painted aluminium loads without errors', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 1500));
    s = await st();
    check('filaments grow from its cut edge and its hole', s.filaments > 40, `${s.filaments} filaments, ${s.lengthMm.toFixed(0)} mm, ${s.branched} splits`);
    await shot('frame_90d'); let sf = await stats(PANEL);
    check('the paint shows its ridges', sf.sd > 4 && sf.mean > 100, `mean ${sf.mean.toFixed(1)} sd ${sf.sd.toFixed(1)}`);
    await E('__filiform.lamp(0.4, 0.2)');
    await E('__filiform.view(30, 20, 1.6)'); await shot('frame_hole');
    await E('(() => { const s = __filiform; document.getElementById("paint").value = "anthracite"; document.getElementById("paint").dispatchEvent(new Event("change")); s.home(); })()');
    await shot('frame_dark');

    // ---- the alloy wheel: white tails under clear coat, from chips and a kerb scrape
    await open('piece=wheel&age=75');
    er = errors(); check('alloy loads without errors', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 1500));
    s = await st();
    check('filaments grow from the chips and the kerb', s.filaments > 60, `${s.filaments} filaments, ${s.lengthMm.toFixed(0)} mm`);
    await shot('wheel_75d'); sf = await stats(PANEL);
    check('the alloy renders, cool', sf.sd > 6 && sf.warm < 15, `mean ${sf.mean.toFixed(1)} sd ${sf.sd.toFixed(1)} warm ${sf.warm.toFixed(1)}`);
    await E('__filiform.view(30, 10, 1.4)'); await shot('wheel_close');
    er = errors(); check('no errors at the end', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 1500));
  } catch (e) { console.log('FAIL ' + (e.stack || e)); failed++; }
  b.kill(); server.close();
  if (process.env.SHOTS) for (const n of ['tinplate_40d', 'tinplate_close', 'tinplate_later', 'frame_90d', 'frame_hole', 'frame_dark', 'wheel_75d', 'wheel_close']) fs.copyFileSync(path.join(OUT, `${n}.png`), path.join(DIR, `shot_${n}.png`));
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
})();

// Headless check over CDP (zero deps; three.js from unpkg; WebGPU on SwiftShader, `offscreen` mode since the
// software device is lost on its first present to a canvas): the egg loads with no console or shader errors,
// the membrane rests glued, a slow pull on the loose flap peels it off the shell without tearing much, a fast
// yank on a fresh egg tears it, and letting go doesn't set off a runaway.
// Screenshots go to /tmp/membrane-shots (OUT=dir to change; SHOTS=1 also copies the README ones here).
//   node smoke.js        Q='seed=..&level=5' to change the egg
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = 8863, OUT = process.env.OUT || '/tmp/membrane-shots';
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
  const b = await launch({ port: 9399, width: 1280, height: 800 });
  const shot = async (name) => { await E('__membrane.snapshot()'); const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const errors = () => b.events.filter((e) => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || e.params.args?.map((a) => a.value ?? a.description).join(' ')).filter((s) => !/GPU stall|Automatic fallback/.test(s || ''));
  const E = (s) => b.evaluate(s);
  const open = async (q) => {
    b.events.length = 0;
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/membrane/?shot&offscreen&paused&${q}` });
    await waitFor(() => E('!!window.__membrane || /needs WebGPU/.test(document.body.innerText) || ' + "!!document.querySelector('#status')?.dataset.err"), 300000);
    const bad = await E('!window.__membrane && document.body.innerText'); if (bad) throw new Error(bad);
    await E('__membrane.pause(true)');
  };
  // a pull on the flap's tip: `cm` along a direction, in `frames` frames
  const pull = (frames, cm, dir) => E(`(async () => {
      const P = __membrane, w = P.world, m = w.sim.m; let best = -1, by = -1e9;
      for (let i = 0; i < m.N; i++) if (m.flap[i] && m.start[i * 3 + 1] > by) { by = m.start[i * 3 + 1]; best = i; }
      w.posCache = await P.positions(); const q = w.posCache;
      const tip = [q[best * 4], q[best * 4 + 1], q[best * 4 + 2]];
      const [sx, sy] = P.project(...tip);
      const vi = P.startGrab(sx, sy); if (vi < 0) return { err: 'no pick at ' + sx + ',' + sy };
      const d = ${JSON.stringify(dir)}, n = Math.hypot(...d);
      const t0 = performance.now(), hist = [];
      for (let f = 1; f <= ${frames}; f++) {
        const k = ${cm} * f / ${frames} / n;
        P.grabWorld(...P.toWorld(tip[0] + d[0] * k, tip[1] + d[1] * k, tip[2] + d[2] * k));
        P.steps(1);
        if (f % 30 === 0 || f === 3 || f === 10) { const c = await P.counters(); hist.push(f + ':' + c.slice(0, 3).join('/')); }
      }
      const c = await P.counters(); await P.snapshot();
      return { c, ms: (performance.now() - t0) / ${frames}, vi, hist: hist.join(' ') };
    })()`);
  const log = (s) => console.log('     ' + s);
  try {
    const t0 = Date.now();
    await open(process.env.Q || 'seed=3&level=5');
    const info = await E('__membrane.info');
    await E('__membrane.renderer.backend.device.lost.then((i) => console.error("DEVICE LOST", i.reason, i.message)), 0');
    console.log(`     loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s, level ${info.level}: ${info.N} vertices, ${info.NT} triangles, ${info.NL} links, edge ${(info.edge * 10).toFixed(2)} mm`);
    await E('__membrane.steps(60); __membrane.snapshot()'); await sleep(300);
    let er = errors();
    check('loads without console or shader errors', er.length === 0, er.slice(0, 4).join(' | ').slice(0, 2000));
    let c = await E('__membrane.counters()');
    check('the membrane rests glued (nothing tears or peels on its own)', c[0] === 0 && c[1] < info.N * 0.06, JSON.stringify(c));
    await shot('rest');
    // slow peel: the tip pulled back off its wall, toward the camera and a little up, 6 cm over 6 s
    const half = await pull(150, 2.5, [0, 0.5, 1]);
    await shot('peeling');
    await E(`(() => { const P = __membrane; P.camera.position.set(1.6, 2.4, 4.6); P.controls.target.set(0, 0.2, -1.2); P.controls.update(); })()`); await shot('close');
    await E(`(() => { const P = __membrane; P.camera.position.set(0.3, 6.6, 6.9); P.controls.target.set(0, -0.6, 0); P.controls.update(); })()`); await E('__membrane.world.mesh.userData.strainView.value = 1'); await shot('strain'); await E('__membrane.world.mesh.userData.strainView.value = 0; __membrane.endGrab()');
    await E('__membrane.rebuild(3)'); await E('__membrane.steps(60)');
    const slow = await pull(360, 6, [0, 0.5, 1]);
    if (slow.err) throw new Error(slow.err);
    console.log(`     slow pull: ${slow.ms.toFixed(1)} ms/frame, counters ${JSON.stringify(slow.c)}\n     ${slow.hist}`);
    await sleep(200); await shot('slow');
    check('a slow pull draws strands of egg white, and some snap', slow.c[6] >= 2 && slow.c[5] >= 1, `${slow.c[6]} drawn, ${slow.c[5]} snapped`);
    const wetNow = await E(`(async () => { const w = new Float32Array(await __membrane.renderer.getArrayBufferAsync(__membrane.world.sim.buffers.wet.value)); let n = 0; for (const v of w) if (v > 0.3) n++; return n; })()`);
    check('the bare shell is wet where it peeled', wetNow > slow.c[1] * 0.3, `${wetNow} wet vertices`);
    check('a slow pull peels the membrane', slow.c[1] > info.N * 0.04, `${slow.c[1]} vertices let go`);
    const mm = (n) => (n * info.edge * 10) / 1.5; // links torn as a length of tear: a tear cuts about 1.5 links per edge length
    check('a slow pull hardly tears it', mm(slow.c[0]) < 30, `${slow.c[0]} links torn, about ${mm(slow.c[0]).toFixed(0)} mm`);
    await E('__membrane.endGrab(); __membrane.steps(60); __membrane.snapshot()'); await shot('slow_after');
    // fast yank on a fresh egg: 7 cm in 0.25 s, straight off the wall toward the camera
    await E('__membrane.rebuild(3)'); await E('__membrane.steps(30)');
    const fast = await pull(15, 7, [0, 1, 0.9]);
    console.log(`     fast pull: counters ${JSON.stringify(fast.c)}\n     ${fast.hist}`);
    await sleep(200); await shot('fast');
    check('a fast yank tears it', mm(fast.c[0]) > 8 && fast.c[0] > 1.5 * slow.c[0], `${fast.c[0]} links torn, about ${mm(fast.c[0]).toFixed(0)} mm`);
    const hist = [];
    await E('__membrane.endGrab()');
    for (let k = 0; k < 9; k++) { await E('__membrane.steps(10)'); hist.push((await E('__membrane.counters()')).slice(0, 3).join('/')); }
    if (process.env.DEBUG) log(await E(`(async () => { const P = __membrane, s = P.world.sim, m = s.m; const p = await P.positions();
      const L = new Float32Array(await P.renderer.getArrayBufferAsync(s.buffers.links.value)); const A = new Float32Array(await P.renderer.getArrayBufferAsync(s.buffers.anchor.value));
      const bins = {}; for (let i = 0; i < m.nStruct; i++) if (L[i*4+3] < 0.5) { const a = L[i*4]; const r = Math.hypot(p[a*4], p[a*4+1], p[a*4+2]); const k = 'y' + Math.round(p[a*4+1]) + ' r' + r.toFixed(0) + ' g' + A[a*4+3] + ' f' + m.flap[a]; bins[k] = (bins[k] || 0) + 1; }
      let nan = 0; for (let i = 0; i < m.N; i++) if (!isFinite(p[i*4])) nan++;
      return 'nan ' + nan + ' ' + JSON.stringify(Object.entries(bins).sort((a, b) => b[1] - a[1]).slice(0, 12)); })()`));
    log('after letting go: ' + hist.join(' ')); await shot('fast_after');
    const after = await E('__membrane.counters()');
    check('letting go after the yank settles (no runaway tearing)', after[0] < fast.c[0] * 1.5 + 50, `${after[0]} links torn, ${after[1]} let go`);
    // a tear parts softly: in the second after letting go, few loose vertices move fast
    const fastest = await E(`(async () => { const P = __membrane, m = P.world.sim.m; let a = await P.positions(), worst = 0, n = 0;
      for (let f = 0; f < 30; f++) { P.steps(1); const b = await P.positions(); let k = 0; for (let i = 0; i < m.N; i++) { const v = Math.hypot(b[i*4]-a[i*4], b[i*4+1]-a[i*4+1], b[i*4+2]-a[i*4+2]) * 60; if (v > 25) k++; worst = Math.max(worst, v); } n = Math.max(n, k); a = b; }
      return { worst, n }; })()`);
    check('a torn piece settles softly (no rubber-band whipping)', fastest.n < info.N * 0.01, `at most ${fastest.n} vertices over 25 cm/s in a frame, fastest ${fastest.worst.toFixed(0)} cm/s`);
    const pieces = await E('__membrane.countPieces()');
    log(`pieces after the yank: ${pieces}, score ${await E('__membrane.counters().then((c) => __membrane.scoreOf(c))')}`);

    // pick the shell up, turned to face you, and peel the flap downward
    await E('__membrane.rebuild(3)'); await E('__membrane.steps(20)');
    check('a fresh egg is one piece', (await E('__membrane.countPieces()')) === 1);
    const shellPt = await E('(() => { const P = __membrane; return P.project(0, -0.4, 2.2); })()');
    const hitShell = await E(`(async () => { __membrane.world.posCache = await __membrane.positions(); return __membrane.pickAt(${shellPt[0]}, ${shellPt[1]}); })()`);
    check('a click on the shell picks the shell, not the membrane', hitShell.shell && hitShell.vi < 0, JSON.stringify(hitShell));
    await E('__membrane.pickUp(); __membrane.steps(90)');
    let lc = await E('__membrane.counters()');
    check('picking the shell up and turning it leaves the membrane on', lc[0] < 12 && lc[1] - lc[4] < info.N * 0.08, JSON.stringify(lc.slice(0, 5)));
    await shot('held');
    const down = await E(`(async () => {
      const P = __membrane, w = P.world, m = w.sim.m; let best = -1, by = -1e9;
      for (let i = 0; i < m.N; i++) if (m.flap[i] && m.start[i * 3 + 1] > by) { by = m.start[i * 3 + 1]; best = i; }
      w.posCache = await P.positions(); const q = w.posCache;
      const tipW = P.toWorld(q[best * 4], q[best * 4 + 1], q[best * 4 + 2]);
      const [sx, sy] = P.project(q[best * 4], q[best * 4 + 1], q[best * 4 + 2]);
      const onScreen = sx > 0 && sx < innerWidth && sy > 0 && sy < innerHeight;
      P.grabVertex(best);
      // straight down in the world: with the shell held facing you, that is off the far wall and toward you
      for (let f = 1; f <= 360; f++) { const k = 5 * f / 360; P.grabWorld(tipW[0], tipW[1] - k, tipW[2] + 0.3 * k); P.steps(1); if (f % 60 === 0) await P.counters() }
      const c = await P.counters(); return { c, onScreen, nan: (await P.positions()).some((v) => !isFinite(v)) };
    })()`);
    if (down.err) throw new Error(down.err);
    await E(`(() => { const P = __membrane; P.camera.position.set(9, 2.5, 3); P.controls.update(); })()`); await shot('held_side');
    await shot('held_peel');
    check('held up, the flap is in view', down.onScreen);
    check('held up, a pull downward peels it', down.c[1] - down.c[4] > info.N * 0.12 && !down.nan, JSON.stringify(down.c.slice(0, 5)));
    log(`downward peel torn about ${(down.c[0] * info.edge * 10 / 1.5).toFixed(0)} mm`);
    await E('__membrane.refresh()'); await shot('hud');
    const hudTxt = await E(`[document.getElementById('peeled').textContent, document.getElementById('torn').textContent, document.querySelector('#lifebar i').style.width]`);
    check('the top bars show the peel and what is left intact', /%/.test(hudTxt[0]) && /mm torn|no tears/.test(hudTxt[1]) && parseFloat(hudTxt[2]) < 100, hudTxt.join(' | '));
    await E('__membrane.endGrab(); __membrane.steps(30); __membrane.finish()');
    const res = await E('__membrane.result');
    check('the result card scores it', res && res.score >= 0 && res.score <= 1000 && res.pieces >= 1, JSON.stringify(res));
    await shot('result');
    await E("document.getElementById('result').classList.remove('on')");
    // torn past the limit: a fresh egg yanked hard several times loses
    await E('__membrane.setDown(); __membrane.steps(120); __membrane.rebuild(5)'); await E('__membrane.steps(20)');
    const yanks = [];
    for (let k = 0; k < 6 && !(await E('__membrane.result && __membrane.result.lost')); k++) {
      const r = await pull(8, 9, [0.4 * k - 1, 1, 0.5]); await E('__membrane.endGrab(); __membrane.steps(10); __membrane.refresh()');
      yanks.push(r.err || (r.c[0] * info.edge * 10 / 1.5).toFixed(0) + ' mm');
    }
    log('yanks: ' + yanks.join(', '));
    const lost = await E('__membrane.result');
    check('tearing past the limit loses', lost && lost.lost && lost.mm >= await E('__membrane.LOSE_MM'), JSON.stringify(lost));
    await shot('lose');
    await E("document.getElementById('result').classList.remove('on')");
    await E('__membrane.setDown(); __membrane.steps(120)');
    check('set down, the shell is back in the cup', await E('__membrane.rig.position.lengthSq() === 0'));

    // the sounds, rendered offline: each voice is audible, doesn't clip, and the wet ones are where they belong
    const snd = await E(`(async () => {
      const SR = 44100, res = {}, wavs = {};
      const render = async (sec, fn) => {
        const ctx = new OfflineAudioContext(2, SR * sec, SR), a = __membrane.makeAudio({ ctx }); a.setup(); fn(a, ctx);
        const buf = await ctx.startRendering(), d = buf.getChannelData(0);
        let pk = 0, ss = 0, nan = 0, zc = 0; for (let i = 0; i < d.length; i++) { const v = d[i]; if (!isFinite(v)) nan++; pk = Math.max(pk, Math.abs(v)); ss += v * v; if (i && (d[i - 1] < 0) !== (v < 0)) zc++; }
        // 16-bit WAV for listening
        const n = d.length, b = new DataView(new ArrayBuffer(44 + n * 2)), w = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
        w(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
        b.setUint32(24, SR, true); b.setUint32(28, SR * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * 2, true);
        for (let i = 0; i < n; i++) b.setInt16(44 + i * 2, Math.max(-1, Math.min(1, d[i])) * 32767, true);
        let bin = ''; const u = new Uint8Array(b.buffer); for (let i = 0; i < u.length; i += 8192) bin += String.fromCharCode(...u.subarray(i, i + 8192));
        return { peak: pk, rms: Math.sqrt(ss / n), nan, zcr: zc / sec / 2, wav: btoa(bin) };
      };
      const one = (name, at) => (a, ctx) => a.voices[name](...(at || []).map((v) => v === 'T' ? 0.05 : v));
      res.grab = await render(0.3, (a) => a.voices.grab(0.05));
      res.release = await render(0.5, (a) => a.voices.release(0.05));
      res.peel = await render(0.4, (a) => a.voices.peel(60, 0.05, 0.2));
      res.tear = await render(0.4, (a) => a.voices.tear(40, 0.05, 0.2));
      res.draw = await render(0.4, (a) => a.voices.draw(0.05));
      res.snap = await render(0.9, (a) => a.voices.snap(0.05));
      res.stick = await render(0.4, (a) => a.voices.stick(10, 0.05));
      // a 4 s slow peel as the app would report it: the bed running under the grains, two threads, one snap
      res.sequence = await render(4.2, (a, ctx) => {
        const v = a.voices, rnd = (k) => (Math.sin(k * 12.9898) * 43758.5453) % 1;
        v.grab(0.05);
        for (let f = 0; f < 220; f++) { const t = 0.15 + f / 60, n = Math.round(8 + 10 * Math.abs(Math.sin(f / 9)) + 6 * Math.abs(rnd(f))); v.peel(n, t, 1 / 60); }
        v.draw(1.0); v.draw(2.1); v.snap(2.9); v.tear(9, 3.3, 0.05); v.release(3.85);
      });
      return res;
    })()`);
    const SD = path.join(OUT, 'sounds'); fs.mkdirSync(SD, { recursive: true });
    for (const [k, r] of Object.entries(snd)) { fs.writeFileSync(path.join(SD, k + '.wav'), Buffer.from(r.wav, 'base64')); delete r.wav; }
    log('sounds: ' + Object.entries(snd).map(([k, r]) => `${k} pk ${r.peak.toFixed(2)} rms ${r.rms.toFixed(3)} ~${r.zcr.toFixed(0)} Hz`).join(', '));
    check('every sound is audible, finite and unclipped', Object.values(snd).every((r) => r.nan === 0 && r.peak > 0.02 && r.peak < 0.99), '');
    check('a snap is brighter than a release, the wet slap lowest', snd.snap.zcr > snd.release.zcr && snd.release.zcr < snd.tear.zcr, `snap ${snd.snap.zcr.toFixed(0)} release ${snd.release.zcr.toFixed(0)} tear ${snd.tear.zcr.toFixed(0)}`);
    er = errors();
    check('no errors after pulling', er.length === 0, er.slice(0, 4).join(' | ').slice(0, 2000));
  } catch (e) { console.log('FAIL', e.message); failed++; }
  b.kill(); server.close();
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})();

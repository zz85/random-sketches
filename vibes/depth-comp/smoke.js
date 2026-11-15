// Headless check over CDP (zero deps; three.js from unpkg): the page loads with no errors, the
// breathe-up buttons breathe, pack and dive, the kick buttons kick, and the bot's whole dive
// draws at each stage and ends on a white card. Writes shot_*.png. node smoke.js
// (ONLY=icons renders icon-192.png and icon-512.png from icon.svg.)
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = 8857;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res);
});
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
const W = +(process.env.W || 1280), H = +(process.env.H || 800);

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const b = await launch({ port: 9391, width: W, height: H });
  await b.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  const shot = async (name) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, `shot_${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const errors = () => b.events.filter((e) => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.args?.map((a) => a.value ?? a.description).join(' ')).filter((s) => !/GPU stall|ReadPixels|WebGL-/.test(s || ''));
  try {
    if (process.env.ONLY === 'icons') {
      await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/depth-comp/icon.svg` }); await sleep(500);
      for (const n of [192, 512]) {
        const data = await b.evaluate(`(async () => { const img = new Image(); img.src = location.href; await img.decode(); const c = new OffscreenCanvas(${n}, ${n}); c.getContext('2d').drawImage(img, 0, 0, ${n}, ${n}); const bl = await c.convertToBlob(); const u = new Uint8Array(await bl.arrayBuffer()); let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s); })()`);
        fs.writeFileSync(path.join(DIR, `icon-${n}.png`), Buffer.from(data, 'base64'));
      }
      console.log('icons written'); return;
    }
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/depth-comp/?seed=3&pause&shot&target=30&disc=CWT` });
    await waitFor(() => b.evaluate('!!window.__depthcomp'), 60000);
    await b.evaluate('__depthcomp.step(2)'); await sleep(200);
    let er = errors();
    check('loads without console or shader errors', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 600));

    // the breathe-up by the buttons: hold Breathe to the top, pack, dive
    const st = await b.evaluate(`(() => { const A = __depthcomp; A.press('Space'); A.advance(5); const full = A.dive.lung; A.press('KeyP'); A.press('KeyP'); A.release('Space'); A.step(4);
      return { full, packed: A.dive.packed, holding: A.dive.holding }; })()`);
    check('Breathe fills the lungs, Pack packs, the breath is held', st.full > 5.9 && st.packed > 0.4 && st.holding, JSON.stringify(st));
    await shot('breathe');
    const dv = await b.evaluate(`(() => { const A = __depthcomp; A.press('Enter'); A.step(45); const duck = A.dive.phase; A.until("d.phase === 'dive'", 5); A.press('KeyZ'); A.advance(0.45); A.press('KeyX'); A.step(6);
      return { duck, phase: A.dive.phase, kicks: A.dive.kicks, depth: A.dive.depth, body: document.body.className }; })()`);
    const nose = await b.evaluate(`(() => { const A = __depthcomp, d = A.dive, F = A.fig, V = F.group.position.constructor; let best = 9;
      for (let i = 0; i < 20; i++) { d.nose = d.t; A.step(1); F.group.updateMatrixWorld(true); best = Math.min(best, F.arms[1].hand.getWorldPosition(new V()).distanceTo(new V(0, 0.1, 0.15).applyMatrix4(F.neck.matrixWorld))); }
      return +best.toFixed(3); })()`);
    check('Frenzel: the right hand at the nose', nose < 0.05, `${nose} m`);
    check('Dive: a duck dive, then the kick buttons kick', dv.duck === 'duck' && dv.phase === 'dive' && dv.kicks === 2 && dv.body === 'dive', JSON.stringify(dv));
    await shot('kick');

    // the bot's dive, drawn at each stage
    await b.evaluate(`__depthcomp.demo(true)`);
    // the duck dive, frame by frame: glide face down away from the line, fold, legs up, pull,
    // and head down facing the line
    const duckFaces = [];
    for (const [i, T] of [[1, 0.5], [2, 1.3], [3, 2.0], [4, 2.8], [5, 3.6]]) {
      await b.evaluate(`__depthcomp.until("d.phase === 'duck' && d.duckT > ${T - 0.25}", 300)`); await b.evaluate('__depthcomp.step(8)'); await sleep(120);
      duckFaces.push(await b.evaluate(`(() => { const F = __depthcomp.fig; F.group.updateMatrixWorld(true); const V = F.group.position.constructor;
        const head = new V(0, 0.13, 0).applyMatrix4(F.neck.matrixWorld), eye = new V(0, 0.16, 0.12).applyMatrix4(F.neck.matrixWorld); return [+(eye.x - head.x).toFixed(2), +(eye.y - head.y).toFixed(2)]; })()`));
      await shot(`duck${i}`);
    }
    check('duck dive: face down in the glide, then toward the line head down', duckFaces[0][1] < -0.05 && duckFaces[4][0] < -0.05, JSON.stringify(duckFaces));
    const stages = [['duck', "d.phase === 'duck' && d.duckT > 2"], ['descent', "d.phase === 'dive' && d.depth > 8"], ['freefall', "d.depth > 22 && !d.turned"], ['turn', "d.turnT !== null && d.turnT > 0.7"], ['met', "window.__depthcomp.safety.state === 'escort' && d.depth < 19"],
      ['ascent', "d.turned && d.depth < 12"], ['surface', "d.phase === 'surface' && d.surfT > 3"], ['result', "d.phase === 'done'"]];
    const audioAt = {};
    for (const [name, cond] of stages) {
      const ok = await b.evaluate(`__depthcomp.until(${JSON.stringify(cond)}, 400)`);
      await b.evaluate(`__depthcomp.step(${name === 'result' ? 30 : 24})`); await sleep(name === 'result' ? 900 : 150);
      check(`bot dive reaches: ${name}`, ok);
      // the diver faces the line: from the back of the head to the eyes points across to it
      if (['descent', 'freefall', 'ascent'].includes(name)) {
        const f = await b.evaluate(`(() => { const F = __depthcomp.fig; F.group.updateMatrixWorld(true); const V = F.group.position.constructor;
          const head = new V(0, 0.13, 0).applyMatrix4(F.neck.matrixWorld), eye = new V(0, 0.16, 0.12).applyMatrix4(F.neck.matrixWorld);
          return { toward: +((eye.x - head.x) * -F.side).toFixed(3), side: F.side, x: +__depthcomp.dive.x.toFixed(2) }; })()`);
        check(`${name}: facing the line`, f.toward > 0.03, JSON.stringify(f));
      }
      if (name === 'descent' || name === 'ascent') {
        // <- tips the head toward the belly, which faces the line; the pad's arrows follow the screen
        const l = await b.evaluate(`(() => { const A = __depthcomp, d = A.dive, F = A.fig, out = {};
          for (const k of ['ArrowLeft', 'ArrowRight', 'PadLeft', 'PadRight']) { A.hold(k, true); const lean = A.leanInput(); A.hold(k, false);
            // which way the head moves across the screen (x) for this lean: a CCW turn moves it along (-cos th)
            out[k] = Math.sign(lean * -Math.cos(d.th)); }
          out.lineSide = -F.side; return out; })()`);
        check(`${name}: <- tips toward the line, -> away; the pad follows the screen`, l.ArrowLeft === l.lineSide && l.ArrowRight === -l.lineSide && l.PadLeft === -1 && l.PadRight === 1, JSON.stringify(l));
      }
      if (name === 'descent' || name === 'freefall') {
        const a = await b.evaluate('__depthcomp.audio.state()');
        audioAt[name] = a;
        if (name === 'freefall') check('the water sounds more muffled deeper', audioAt.descent.running && a.under && a.cutoff < audioAt.descent.cutoff * 0.6, JSON.stringify(audioAt));
      }
      if (name === 'met') {
        const m = await b.evaluate(`(() => { const A = __depthcomp, d = A.dive, p = A.safety.p; return { gap: +Math.hypot(p.x - d.x, p.y - d.y).toFixed(2), sx: +p.x.toFixed(2), visible: A.safety.fig.group.visible }; })()`);
        check('the safety diver meets you and comes up beside you', m.visible && m.gap < 1.6 && m.sx < 0, JSON.stringify(m));
      }
      if (name === 'descent') {
        const px = await b.evaluate(`(() => { const c = document.getElementById('gl'), g = c.getContext('webgl2') || c.getContext('webgl'); const p = new Uint8Array(4 * c.width); g.readPixels(0, Math.floor(c.height * 0.55), c.width, 1, g.RGBA, g.UNSIGNED_BYTE, p); let mn = 999, mx = 0; for (let i = 0; i < c.width; i++) { const v = p[i * 4] + p[i * 4 + 1] + p[i * 4 + 2]; mn = Math.min(mn, v); mx = Math.max(mx, v); } return [mn, mx]; })()`);
        check('the frame has the diver and the line against the water', px[1] - px[0] > 40, JSON.stringify(px));
      }
      await shot(name);
    }
    const r = await b.evaluate(`__depthcomp.dive.result`);
    check('the bot dive ends on a white card with the tag', r && r.card === 'white' && r.tag, JSON.stringify(r));
    const shown = await b.evaluate(`document.getElementById('result').classList.contains('show')`);
    check('the result card shows', shown);
    // free immersion: the rope
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/depth-comp/?seed=4&pause&shot&target=25&disc=FIM&demo` });
    await waitFor(() => b.evaluate('!!window.__depthcomp'), 60000);
    const fim = await b.evaluate(`(() => { const A = __depthcomp; A.until("d.phase === 'dive' && d.depth > 10", 300); A.step(10); return { pulls: A.dive.pulls, depth: A.dive.depth }; })()`);
    check('FIM: the bot pulls down the rope', fim.pulls > 3 && fim.depth > 10, JSON.stringify(fim));
    const grip = await b.evaluate(`(() => { const A = __depthcomp, F = A.fig, V = F.group.position.constructor, r = []; for (let i = 0; i < 30; i++) { A.step(1); F.group.updateMatrixWorld(true);
      for (const a of F.arms) if (a.ik === 'rope' && a.ikW > 0.95) { const h = a.hand.getWorldPosition(new V()); r.push(Math.hypot(h.x, h.z)); } }
      const face = (() => { const head = new V(0, 0.13, 0).applyMatrix4(F.neck.matrixWorld), eye = new V(0, 0.16, 0.12).applyMatrix4(F.neck.matrixWorld); return +(eye.x - head.x).toFixed(2); })();
      return { n: r.length, worst: +Math.max(...r).toFixed(3), face }; })()`);
    check('FIM: hands on the rope, facing it', grip.n > 20 && grip.worst < 0.06 && grip.face < -0.05, JSON.stringify(grip));
    await sleep(150); await shot('fim');
    // deep, on a monofin, with a headlamp and a lit plate
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/depth-comp/?seed=5&pause&shot&target=60&disc=CWT&fins=mono&lamp=auto&demo` });
    await waitFor(() => b.evaluate('!!window.__depthcomp'), 60000);
    const deep = await b.evaluate(`(() => { const A = __depthcomp; A.until("d.phase === 'dive' && d.depth > 8 && d.mono.down", 300); A.step(6);
      const shallow = { dolphins: A.dive.dolphins, legs: A.fig.legs.map(L => +L.hip.rotation.x.toFixed(2)), mono: A.fig.monoBlade.root.visible, bifin: A.fig.legs[0].blade.root.visible };
      A.until("d.depth > 56", 300); A.step(24);
      return { ...shallow, lamp: A.fig.lampMount.visible, depth: A.dive.depth }; })()`);
    check('monofin: dolphin kicks, legs together, one blade; headlamp on for 60 m', deep.dolphins > 3 && Math.abs(deep.legs[0] - deep.legs[1]) < 0.05 && deep.mono && !deep.bifin && deep.lamp, JSON.stringify(deep));
    await sleep(150); await shot('deep');
    // in pain: a hand over the ear, knees drawn up
    const hurt = await b.evaluate(`(() => { const A = __depthcomp, d = A.dive; d.pain = 0.9; d.Pe = d.P - 0.4; A.step(20); const F = A.fig;
      F.group.updateMatrixWorld(true); const V = F.group.position.constructor; const hand = F.arms[1].hand.getWorldPosition(new V()), head = new V(0, 0.13, 0).applyMatrix4(F.neck.matrixWorld);
      return { handToHead: +hand.distanceTo(head).toFixed(2), knee: +F.legs[0].knee.rotation.x.toFixed(2), pain: +d.pain.toFixed(2) }; })()`);
    check('pain shows: a hand to the ear, knees drawn up', hurt.handToHead < 0.35 && hurt.knee > 0.5, JSON.stringify(hurt));
    await sleep(150); await shot('pain');
    er = errors(); check('no errors through the dives', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 600));
  } catch (e) { console.error(e); failed++; }
  finally { b.kill(); server.close(); console.log(failed ? `${failed} failed` : 'all passed'); process.exit(failed ? 1 : 0); }
})();

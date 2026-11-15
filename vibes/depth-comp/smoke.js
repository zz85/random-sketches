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
    const stages = [['duck', "d.phase === 'duck' && d.duckT > 2"], ['descent', "d.phase === 'dive' && d.depth > 8"], ['freefall', "d.depth > 22 && !d.turned"], ['turn', "d.turnT !== null && d.turnT > 0.7"],
      ['ascent', "d.turned && d.depth < 12"], ['surface', "d.phase === 'surface' && d.surfT > 3"], ['result', "d.phase === 'done'"]];
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
    await sleep(150); await shot('fim');
    er = errors(); check('no errors through the dives', er.length === 0, er.slice(0, 3).join(' | ').slice(0, 600));
  } catch (e) { console.error(e); failed++; }
  finally { b.kill(); server.close(); console.log(failed ? `${failed} failed` : 'all passed'); process.exit(failed ? 1 : 0); }
})();

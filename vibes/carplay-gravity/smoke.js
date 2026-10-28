// Headless end-to-end check over CDP (zero deps), at 800 × 480 (the target head unit) and
// 1280 × 800: every layout fits the screen with no pieces overlapping, everything falls and
// settles inside, Restore puts every piece back, a drag lifts an icon, taps work on a still layout,
// pulling one card out knocks others loose, Drive sways with the turns, Zero-G floats, the frame
// cost, no console errors. node smoke.js. Writes smoke_*.png.
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = 8823;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

// layout sanity: inside the screen, no two pieces overlapping (axis-aligned boxes at home)
const LAYOUT = `(()=>{const P=__cp.pieces,{LW,LH}=__cp.size;let out=0,ov=[];
  for(const p of P){if(p.x-p.w/2<-0.5||p.y-p.h/2<-0.5||p.x+p.w/2>LW+0.5||p.y+p.h/2>LH+0.5)out++;}
  for(let i=0;i<P.length;i++)for(let j=i+1;j<P.length;j++){const a=P[i],b=P[j];if(Math.abs(a.x-b.x)<(a.w+b.w)/2-0.5&&Math.abs(a.y-b.y)<(a.h+b.h)/2-0.5)ov.push(a.id+'/'+b.id);}
  return {n:P.length,out,ov,LW:Math.round(LW),LH:Math.round(LH)}})()`;
const STATS = `(()=>{const P=__cp.pieces,W=__cp.world.walls;return {n:P.length,pinned:P.filter(p=>p.body.pinned).length,
  off:Math.max(...P.map(p=>Math.hypot(p.body.x-p.home.x,p.body.y-p.home.y)+Math.abs(p.body.angle)*100)),
  inside:P.every(p=>p.body.x>W.l&&p.body.x<W.r&&p.body.y>W.t&&p.body.y<W.b+1),
  speed:Math.max(...P.map(p=>Math.hypot(p.body.vx,p.body.vy))), low:P.filter(p=>p.body.y>W.b*0.6).length}})()`;

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const b = await launch({ port: 9373, width: 800, height: 480 });
  const shot = async (name) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, `smoke_${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const mouse = (type, [x, y]) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const click = async (xy) => { await mouse('mousePressed', xy); await mouse('mouseReleased', xy); await sleep(250); };
  try {
    for (const [w, h, tag] of [[1280, 800, '1280'], [800, 480, '']]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/carplay-gravity/?still` });
      await waitFor(() => b.evaluate('!!window.__cp'), 15000);
      await sleep(600);
      for (const L of ['home', 'dash', 'cluster']) {
        await b.evaluate(`__cp.setLayout('${L}')`); await sleep(500);
        const s = await b.evaluate(LAYOUT);
        check(`${w}×${h} ${L}: ${s.n} pieces fit ${s.LW}×${s.LH}, none overlapping`, s.n >= 8 && !s.out && !s.ov.length, s.ov.join(' '));
        await shot(L + tag);
      }
    }
    await b.evaluate(`__cp.setLayout('home')`); await sleep(300);
    await b.evaluate(`__cp.dropAll()`); await sleep(4500);
    let s = await b.evaluate(STATS);
    check('dropped: everything settled inside the screen', s.pinned === 0 && s.inside && s.speed < 60, `max speed ${s.speed.toFixed(1)}`);
    check('dropped: most pieces at the bottom', s.low >= s.n * 0.8, `${s.low} of ${s.n}`);
    await shot('fallen');
    // drag the Music tile up
    const xy = await b.evaluate(`__cp.clientOf('tile-music')`), y0 = await b.evaluate(`__cp.pieces.find(p=>p.id==='tile-music').body.y`);
    await mouse('mousePressed', xy);
    for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', [xy[0] - i * 10, xy[1] - i * 22]); await sleep(16); }
    await sleep(300);
    const y1 = await b.evaluate(`__cp.pieces.find(p=>p.id==='tile-music').body.y`);
    check('drag lifts the tile', y0 - y1 > 150, `${(y0 - y1).toFixed(0)} px up`);
    await shot('drag');
    await mouse('mouseReleased', [xy[0] - 100, xy[1] - 220]); await sleep(2000);
    await b.evaluate(`__cp.restore()`); await sleep(1600);
    s = await b.evaluate(STATS);
    check('restore: every piece back home', s.pinned === s.n && s.off < 0.01);
    await click(await b.evaluate(`__cp.clientOf('tile-music')`));
    check('tap Music opens the dashboard', await b.evaluate(`__cp.state.layout==='dash'`));
    await click(await b.evaluate(`__cp.clientOf('np','play')`));
    check('tap pause stops the music', await b.evaluate(`__cp.state.playing===false && __cp.pieces.every(p=>p.body.pinned)`));
    await click(await b.evaluate(`__cp.clientOf('np','next')`));
    check('tap next skips', await b.evaluate(`__cp.state.track===1`));
    await shot('dash_paused');
    // pull the weather card out and throw it at the now-playing card
    const w0 = await b.evaluate(`__cp.clientOf('wx')`);
    await mouse('mousePressed', w0);
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', [w0[0] - i * 3, w0[1] - i * 30]); await sleep(16); }
    await mouse('mouseReleased', [w0[0] - 18, w0[1] - 180]); await sleep(1500);
    s = await b.evaluate(STATS);
    check('a thrown card knocks others loose', s.n - s.pinned >= 2, `${s.n - s.pinned} loose`);
    await shot('knock');
    await b.evaluate(`__cp.setMode('drive')`);
    const lat = await b.evaluate(`new Promise(r=>{let mx=0;const t0=performance.now();(function f(){mx=Math.max(mx,Math.abs(__cp.world.gx));performance.now()-t0<25000?setTimeout(f,50):r(mx)})()})`);
    check('drive: turns push sideways', lat > 200, `max sideways ${lat.toFixed(0)} px/s²`);
    await shot('drive');
    await b.evaluate(`__cp.setLayout('cluster')`); await sleep(3000);
    await shot('cluster_fallen');
    await b.evaluate(`__cp.setMode('zero')`); await sleep(2000);
    s = await b.evaluate(STATS);
    check('zero-g: pieces float, inside', s.inside && s.speed > 5);
    await shot('zero');
    // the controls drawer
    await click([783, 23]); await sleep(300);
    check('☰ opens the controls', await b.evaluate(`document.body.classList.contains('menu') && document.getElementById('hw').getBoundingClientRect().top>=0`));
    await shot('menu');
    const pf = await b.evaluate(`(()=>{const p=__cp.perf;p.frames=0;p.ms=0;return new Promise(r=>setTimeout(()=>r({ms:p.ms/p.frames,n:p.frames}),3000))})()`);
    check('frame cost', pf.ms < 12, `${pf.ms.toFixed(2)} ms/frame CPU (headless, no GPU), ${pf.n} frames in 3 s`);
    const ex = b.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
    check('no console errors', !ex.length, ex.map((e) => JSON.stringify(e.params).slice(0, 300)).join('\n'));
  } catch (e) { check('run', false, e.stack); }
  b.kill(); server.close();
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})();

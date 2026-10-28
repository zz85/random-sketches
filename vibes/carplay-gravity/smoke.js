// Headless end-to-end check over CDP (zero deps): each layout's pieces match the layout before the
// drop, everything falls and settles inside the screen, Restore puts every piece back, a drag
// throws an icon, a tap plays / pauses, pulling one icon out of the still layout knocks others
// loose, Drive mode sways with the turns, no console errors. node smoke.js. Writes smoke_*.png.
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

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const b = await launch({ port: 9373, width: 1280, height: 800 });
  const shot = async (name) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, `smoke_${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const mouse = (type, x, y) => b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  const errors = [];
  try {
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/carplay-gravity/?still` });
    await waitFor(() => b.evaluate('!!window.__cp'), 15000);
    await sleep(500);
    const stats = `(()=>{const P=__cp.pieces,W=__cp.world.walls;return {n:P.length,pinned:P.filter(p=>p.body.pinned).length,
      off:Math.max(...P.map(p=>Math.hypot(p.body.x-p.home.x,p.body.y-p.home.y)+Math.abs(p.body.angle)*100)),
      inside:P.every(p=>p.body.x>W.l&&p.body.x<W.r&&p.body.y>W.t&&p.body.y<W.b+1),
      speed:Math.max(...P.map(p=>Math.hypot(p.body.vx,p.body.vy))), low:P.filter(p=>p.body.y>W.b*0.6).length,
      rectErr:Math.max(...P.map(p=>{const r=p.el.getBoundingClientRect(),s=document.getElementById('screen').getBoundingClientRect();return p.body.pinned&&!p.body.angle?Math.abs(r.left-s.left+r.width/2-p.body.x)+Math.abs(r.top-s.top+r.height/2-p.body.y):0}))}})()`;
    for (const L of ['home', 'dash', 'cluster']) {
      await b.evaluate(`__cp.setLayout('${L}')`); await sleep(400);
      const s = await b.evaluate(stats);
      check(`${L}: pieces pinned in the layout`, s.n >= 8 && s.pinned === s.n && s.off < 0.01 && s.rectErr < 1, `${s.n} pieces, drawn ${s.rectErr.toFixed(2)} px from their bodies`);
      await shot(L);
    }
    // drop the home screen
    await b.evaluate(`__cp.setLayout('home')`); await sleep(300);
    await b.evaluate(`__cp.dropAll()`); await sleep(4500);
    let s = await b.evaluate(stats);
    check('dropped: everything settled inside the screen', s.pinned === 0 && s.inside && s.speed < 60, `max speed ${s.speed.toFixed(1)} px/s`);
    check('dropped: most pieces at the bottom', s.low >= s.n * 0.8, `${s.low} of ${s.n}`);
    await shot('fallen');
    // drag the Maps tile up and fling it
    const tileXY = await b.evaluate(`(()=>{const p=__cp.pieces.find(p=>p.el.matches('.tile[data-act="app:music"]'));const r=p.el.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2,p.body.y]})()`);
    await mouse('mousePressed', tileXY[0], tileXY[1]);
    for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', tileXY[0] - i * 15, tileXY[1] - i * 35); await sleep(16); }
    await sleep(250);
    const held = await b.evaluate(`__cp.pieces.find(p=>p.el.matches('.tile[data-act="app:music"]')).body.y`);
    check('drag lifts the tile', tileXY[2] - held > 200, `${(tileXY[2] - held).toFixed(0)} px up`);
    await shot('drag');
    await mouse('mouseReleased', tileXY[0] - 150, tileXY[1] - 350);
    await sleep(2500);
    // restore
    await b.evaluate(`__cp.restore()`); await sleep(1600);
    s = await b.evaluate(stats);
    check('restore: every piece back home', s.pinned === s.n && s.off < 0.01 && s.rectErr < 1);
    // tap Music in the still layout opens the dashboard; tap pause
    const mxy = await b.evaluate(`(()=>{const r=document.querySelector('#L-home .tile[data-act="app:music"]').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
    await mouse('mousePressed', mxy[0], mxy[1]); await mouse('mouseReleased', mxy[0], mxy[1]); await sleep(400);
    check('tap Music opens the dashboard', await b.evaluate(`__cp.state.layout==='dash'`));
    const pxy = await b.evaluate(`(()=>{const r=document.querySelector('#L-dash [data-act="play"]').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
    await mouse('mousePressed', pxy[0], pxy[1]); await mouse('mouseReleased', pxy[0], pxy[1]); await sleep(200);
    check('tap pause stops the music', await b.evaluate(`__cp.state.playing===false && __cp.pieces.every(p=>p.body.pinned)`));
    // pull the weather card out of the still layout and throw it at the now-playing card
    const wxy = await b.evaluate(`(()=>{const r=document.querySelector('#L-dash .wx').getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()`);
    await mouse('mousePressed', wxy[0], wxy[1]);
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', wxy[0] - i * 4, wxy[1] - i * 45); await sleep(16); }
    await mouse('mouseReleased', wxy[0] - 24, wxy[1] - 270); await sleep(1500);
    s = await b.evaluate(stats);
    check('a thrown card knocks others loose', s.n - s.pinned >= 2, `${s.n - s.pinned} loose`);
    await shot('knock');
    // drive mode: lateral g follows the route
    await b.evaluate(`__cp.setMode('drive')`);
    const lat = await b.evaluate(`new Promise(r=>{let mx=0;const t0=performance.now();(function f(){mx=Math.max(mx,Math.abs(__cp.world.gx));performance.now()-t0<25000?setTimeout(f,50):r(mx)})()})`);
    check('drive: turns push sideways', lat > 300, `max sideways ${lat.toFixed(0)} px/s²`);
    await shot('drive');
    await b.evaluate(`__cp.setLayout('cluster')`); await sleep(3000);
    await shot('cluster_fallen');
    await b.evaluate(`__cp.setMode('zero')`); await sleep(2000);
    s = await b.evaluate(stats);
    check('zero-g: pieces float, inside', s.inside && s.speed > 5);
    await shot('zero');
    const ex = b.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
    for (const e of ex) errors.push(JSON.stringify(e.params).slice(0, 300));
    check('no console errors', !errors.length, errors.join('\n'));
  } catch (e) { check('run', false, e.stack); }
  b.kill(); server.close();
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})();

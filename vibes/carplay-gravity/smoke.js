// Headless end-to-end check over CDP (zero deps), at 800 × 480 (the target head unit) and
// 1280 × 800: every layout fits the screen with no pieces overlapping, everything falls and
// settles inside, Restore puts every piece back, a drag lifts an icon, taps work on a still layout,
// pulling one card out knocks others loose, Drive sways with the turns, Zero-G floats, the options
// sheet (open, every control, close), the frame
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
  for(let i=0;i<P.length;i++)for(let j=i+1;j<P.length;j++){const a=P[i],b=P[j];if(a.under||b.under)continue;if(Math.abs(a.x-b.x)<(a.w+b.w)/2-0.5&&Math.abs(a.y-b.y)<(a.h+b.h)/2-0.5)ov.push(a.id+'/'+b.id);}
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
    // a fresh visit: still for 5 s, or until the first touch, at 1.5 g
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/carplay-gravity/` });
    await waitFor(() => b.evaluate('!!window.__cp'), 15000);
    await b.evaluate(`localStorage.clear()`);
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/carplay-gravity/` });
    await waitFor(() => b.evaluate('!!window.__cp'), 15000);
    await sleep(1500);
    let st0 = await b.evaluate(`({started:__cp.state.started, pinned:__cp.pieces.every(p=>p.body.pinned), g:__cp.state.strength, filter:__cp.FILTER})`);
    check('start: still at first, 1.5 g, glass blur on', !st0.started && st0.pinned && st0.g === 1.5 && st0.filter, JSON.stringify(st0));
    await sleep(4500);
    check('start: drops by itself after 5 s', await b.evaluate(`__cp.state.started && __cp.pieces.some(p=>!p.body.pinned)`));
    await b.send('Page.reload', {}); await waitFor(() => b.evaluate('!!window.__cp && !__cp.state.started'), 15000); await sleep(500);
    await mouse('mousePressed', [400, 140]); await sleep(50);
    const ft = await b.evaluate(`({started:__cp.state.started, loose:__cp.pieces.filter(p=>!p.body.pinned).length, layout:__cp.state.layout, menu:__cp.state.menu, vw:innerWidth, vh:innerHeight})`);
    check('start: the first touch drops it sooner', ft.started && ft.loose > 0, JSON.stringify(ft));
    await mouse('mouseReleased', [400, 140]); await sleep(300);
    for (const [w, h, tag] of [[1280, 800, '1280'], [800, 480, '']]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/carplay-gravity/?still` });
      await waitFor(() => b.evaluate('!!window.__cp'), 15000);
      await sleep(600);
      for (const L of ['widgets', 'home', 'dash', 'cluster']) {
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
    check('dropped: most pieces at the bottom', s.low >= s.n * 0.75, `${s.low} of ${s.n}`);
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
    // a double tap does nothing; a triple tap cracks the glass and the shock knocks nearby tiles loose
    for (const xy of [[500, 452], [503, 454]]) { await mouse('mousePressed', xy); await mouse('mouseReleased', xy); await sleep(60); }
    await sleep(450);
    check('double tap does not crack', await b.evaluate(`__cp.cracks.length===0`));
    for (const xy of [[500, 452], [503, 454], [501, 453]]) { await mouse('mousePressed', xy); await mouse('mouseReleased', xy); await sleep(60); }
    await sleep(150); s = await b.evaluate(STATS);
    check('triple tap cracks the glass, quick taps hit harder', await b.evaluate(`__cp.tapForce(130)>1.5 && __cp.tapForce(800)<0.6 && __cp.cracks[0]?.power>1.8`) && await b.evaluate(`__cp.cracks.length===1`) && s.n - s.pinned >= 3, `${s.n - s.pinned} loose`);
    check('WebGL pass draws the crack (ripples off by default)', await b.evaluate(`__cp.fx.ok && __cp.fx.cracks.length===1 && __cp.fx.ripples.length===0 && __cp.fx.canvas.style.visibility==='visible' && __cp.fx.canvas.width===__cp.fx.canvas.parentElement.querySelector('canvas').width`));
    await sleep(800); await shot('crack');
    const spread = await b.evaluate(`(()=>{const f=__cp.fx,c=f.cracks[0],b0=c.born,W=f.canvas.width,H=f.canvas.height,K=W/__cp.size.LW;
      const grab=a=>{c.born=performance.now()/1000-a;f.render();const o=document.createElement('canvas');o.width=W;o.height=H;const g=o.getContext('2d');g.drawImage(f.canvas,0,0);return g.getImageData(0,0,W,H).data;};
      const ref=grab(-1),far=a=>{const d=grab(a);let n=0;for(let y=0;y<H;y+=3)for(let x=0;x<W;x+=3){const i=(y*W+x)*4;if(Math.hypot(x/K-c.x,y/K-c.y)>250&&Math.abs(d[i]-ref[i])+Math.abs(d[i+1]-ref[i+1])+Math.abs(d[i+2]-ref[i+2])>60)n++;}return n;};
      const r={early:far(0.05),done:far(2),power:c.power};c.born=b0;return r;})()`);
    check('crack spreads out over half a second, from a quick triple tap', spread.early === 0 && spread.done > 50 && spread.power > 1.8, JSON.stringify(spread));
    await b.evaluate(`__cp.restore()`); await sleep(1600);
    check('restore: clears the cracks', await b.evaluate(`__cp.cracks.length===0 && __cp.pieces.every(p=>p.body.pinned)`));
    await sleep(1200);
    check('GL pass sleeps when idle (1 x 1, hidden)', await b.evaluate(`__cp.fx.cracks.length===0 && __cp.fx.ripples.length===0 && __cp.fx.canvas.style.visibility==='hidden' && __cp.fx.canvas.width===1`));
    for (const xy of [[500, 452], [502, 453], [501, 452]]) { await mouse('mousePressed', xy); await mouse('mouseReleased', xy); await sleep(300); }
    check('slow triple tap leaves a single hairline', await b.evaluate(`__cp.cracks.length===1 && __cp.cracks[0].kind==='hair' && __cp.cracks[0].blot===0`));
    await b.evaluate(`__cp.restore()`); await sleep(1600);
    for (const xy of [[500, 452], [502, 453], [501, 452], [500, 451]]) { await mouse('mousePressed', xy); await mouse('mouseReleased', xy); await sleep(60); }
    await sleep(150);
    check('quadruple tap turns it into a spider web', await b.evaluate(`__cp.cracks.length===1 && __cp.cracks[0].kind==='web' && __cp.fx.cracks.length===1 && __cp.cracks[0].lines.length>40`), await b.evaluate(`JSON.stringify(__cp.cracks.map(c=>[c.kind,c.lines.length]))+__cp.fx.cracks.length`));
    await b.evaluate(`__cp.restore()`); await sleep(1600);
    await mouse('mousePressed', [400, 300]); await mouse('mouseReleased', [400, 300]); await sleep(100);
    check('Ripples off by default: a touch makes none', await b.evaluate(`__cp.state.ripples==='off' && __cp.fx.ripples.length===0`));
    await b.evaluate(`__cp.state.ripples='on'`); await mouse('mousePressed', [400, 300]); await mouse('mouseReleased', [400, 300]); await sleep(100);
    check('Ripples on: a touch makes one', await b.evaluate(`__cp.fx.ripples.length===1`));
    await b.evaluate(`__cp.state.ripples='off'; __cp.setLayout('home')`); await sleep(2800);
    await click(await b.evaluate(`__cp.clientOf('tile-music')`));
    check('tap Music opens the dashboard', await b.evaluate(`__cp.state.layout==='dash'`));
    await click(await b.evaluate(`__cp.clientOf('np','play')`));
    check('tap pause stops the music', await b.evaluate(`__cp.state.playing===false && __cp.pieces.every(p=>p.body.pinned)`));
    await click(await b.evaluate(`__cp.clientOf('np','next')`));
    check('tap next skips', await b.evaluate(`__cp.state.track===1`));
    await shot('dash_paused');
    // pull the weather card out and throw it at the now-playing card
    const w0 = await b.evaluate(`__cp.clientOf('upnext')`);
    await mouse('mousePressed', w0);
    for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', [w0[0] - i * 3, w0[1] - i * 30]); await sleep(16); }
    await mouse('mouseReleased', [w0[0] - 18, w0[1] - 180]); await sleep(1500);
    s = await b.evaluate(STATS);
    check('a thrown card knocks others loose', s.n - s.pinned >= 2, `${s.n - s.pinned} loose`);
    await shot('knock');
    const slabs = await b.evaluate(`(()=>{const q=__cp.pieces.filter(p=>p.whole);return {n:q.length,map:q.filter(p=>p.whole.id==='map').length,loose:q.filter(p=>!p.body.pinned).length,small:q.filter(p=>!p.body.pinned&&p.sc<0.8).length}})()`);
    check('dashboard panels are slabs that come apart and fall back smaller', slabs.n === 18 && slabs.map === 9 && slabs.loose >= 2 && slabs.small === slabs.loose, JSON.stringify(slabs));
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
    // the options sheet, drawn on the canvas: open it from the button, change things, close it
    await b.evaluate(`__cp.restore()`); await sleep(1200);
    await b.evaluate(`__cp.setLayout('home')`); await sleep(300);
    await click(await b.evaluate(`__cp.menuPoint('orb')`)); await sleep(300);
    check('sheet: the button opens it', await b.evaluate(`__cp.state.menu`));
    await click(await b.evaluate(`__cp.menuPoint('layout',0,'dash')`));
    await click(await b.evaluate(`__cp.menuPoint('mode',0,'drive')`));
    await click(await b.evaluate(`__cp.menuPoint('wallpaper',0,'rose')`));
    await click(await b.evaluate(`__cp.menuPoint('appearance',0,'light')`));
    await click(await b.evaluate(`__cp.menuPoint('icons',0,'clear')`));
    check('sheet: light appearance, clear icons', await b.evaluate(`__cp.state.appearance==='light' && __cp.state.icons==='clear'`));
    await click(await b.evaluate(`__cp.menuPoint('icons',0,'dark')`));
    const sl = await b.evaluate(`__cp.menuPoint('strength',0)`), sr = await b.evaluate(`__cp.menuPoint('strength',2/3)`);
    await mouse('mousePressed', sl); for (let i = 1; i <= 8; i++) { await mouse('mouseMoved', [sl[0] + (sr[0] - sl[0]) * i / 8, sl[1]]); await sleep(16); } await mouse('mouseReleased', sr); await sleep(200);
    let st = await b.evaluate(`(()=>{const s=__cp.state;return {layout:s.layout,mode:s.mode,wallpaper:s.wallpaper,icons:s.icons,strength:s.strength,loose:s.loose}})()`);
    check('sheet: screen, gravity, wallpaper, icons, strength', st.layout === 'dash' && st.mode === 'drive' && st.wallpaper === 'rose' && st.icons === 'dark' && Math.abs(st.strength - 2) < 0.06, JSON.stringify(st));
    await click(await b.evaluate(`__cp.menuPoint('cracks',0.1)`)); await sleep(100);
    const cpw = await b.evaluate(`__cp.state.crackPower`);
    check('sheet: Cracks slider sets crack strength', Math.abs(cpw - 0.525) < 0.06, String(cpw));
    await b.evaluate(`__cp.state.crackPower=1.8`);
    await shot('menu');
    const dc = await b.evaluate(`__cp.menuPoint('dial',0.5)`);
    await mouse('mousePressed', [dc[0] - 40, dc[1]]); await mouse('mouseMoved', [dc[0] - 45, dc[1]]); await mouse('mouseReleased', [dc[0] - 45, dc[1]]); await sleep(200);
    check('sheet: the dial points gravity left', await b.evaluate(`__cp.state.mode==='down' && Math.abs(Math.abs(__cp.state.angle)-Math.PI)<0.1`));
    await click(await b.evaluate(`__cp.menuPoint('drop')`));
    check('sheet: Restore puts everything back', await b.evaluate(`!__cp.state.loose`));
    await click(await b.evaluate(`__cp.menuPoint('close')`)); await sleep(400);
    check('sheet: closes', await b.evaluate(`!__cp.state.menu && __cp.state.menuT===0`));
    await click(await b.evaluate(`__cp.clientOf('sb-btn')`));
    check('sidebar button goes to the apps', await b.evaluate(`__cp.state.layout==='home'`));
    await shot('home_dark');
    await b.evaluate(`localStorage.clear()`);
    const pf = await b.evaluate(`(()=>{const p=__cp.perf;p.frames=0;p.ms=0;return new Promise(r=>setTimeout(()=>r({ms:p.ms/p.frames,n:p.frames}),3000))})()`);
    check('frame cost', pf.ms < 12, `${pf.ms.toFixed(2)} ms/frame CPU (headless, no GPU), ${pf.n} frames in 3 s`);
    const ex = b.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
    check('no console errors', !ex.length, ex.map((e) => JSON.stringify(e.params).slice(0, 300)).join('\n'));
  } catch (e) { check('run', false, e.stack); }
  b.kill(); server.close();
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})();

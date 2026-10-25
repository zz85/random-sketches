// Headless end-to-end check over CDP (zero deps): a synthetic demo frame through the real UI and
// worker (pose vs the known camera), clicking a court point and reading its metres back, a
// synthetic video clip tracked frame to frame (pose vs the camera of the frame on screen, fps),
// export, no console errors. node smoke.js  (CHROME=/path/to/chrome to override). Writes smoke_*.png.
import http from 'http';
import path from 'path';
import fs from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), PORT = 8811;
const CLIP = '/tmp/squash-smoke/clip.webm';
if (!fs.existsSync(CLIP)) { fs.mkdirSync(path.dirname(CLIP), { recursive: true }); execFileSync('node', [path.join(DIR, 'tools/make_video.mjs'), CLIP, '75'], { stdio: 'inherit' }); }
const truthCams = JSON.parse(fs.readFileSync(CLIP.replace('.webm', '.json'), 'utf8'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webm': 'video/webm' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(DIR, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const b = await launch({ port: 9361, width: 1400, height: 860 });
  const shot = async (name) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, `smoke_${name}.png`), Buffer.from(r.result.data, 'base64')); };
  try {
    // 1. demo frame
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?demo${process.env.QS ? "&" + process.env.QS : ""}` });
    await waitFor(() => b.evaluate('!!(window.__sq && __sq.cam && !__sq.busy)'), 30000);
    const d = await b.evaluate(`(()=>{const S=__sq,c=S.cam,t=S.truth;return {dC:Math.hypot(...c.C.map((v,i)=>v-t.C[i])),df:c.f/t.f-1,ok:S.okay,ms:S.ms.wall,txt:document.getElementById('readout').textContent}})()`);
    check('demo frame: camera within 15 cm', d.dC < 0.15, `${(d.dC * 100).toFixed(1)} cm, f ${(d.df * 100).toFixed(2)}%, ${Math.round(d.ms)} ms`);
    check('demo frame: confident', d.ok);
    check('readout shows the pose', /camera\s+x/.test(d.txt) && /h-fov/.test(d.txt));
    // 2. click where the short line meets the half line, read the floor point back
    const pick = await b.evaluate(`(async()=>{const S=__sq,st=document.getElementById('stage'),r=st.getBoundingClientRect(),dpr=st.width/r.width;
      const k=st.width/r.width; const u=S.truth.project([3.2,5.44,0]); const D=(()=>{const kk=Math.min(st.width/S.srcW,st.height/S.srcH);return {k:kk,ox:(st.width-S.srcW*kk)/2,oy:(st.height-S.srcH*kk)/2}})();
      const x=r.left+(D.ox+u[0]*D.k)/dpr, y=r.top+(D.oy+u[1]*D.k)/dpr; st.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,bubbles:true}));
      await new Promise(r=>setTimeout(r,50)); const p=S.picks.at(-1); return p&&{s:p.surface,X:p.X}})()`);
    check('click lifts a pixel onto the floor in metres', pick && pick.s === 'floor' && Math.hypot(pick.X[0] - 3.2, pick.X[1] - 5.44) < 0.08, JSON.stringify(pick && { s: pick.s, X: pick.X.map((v) => +v.toFixed(3)) }));
    const plan = await b.evaluate(`(()=>{const c=document.getElementById('plan'),g=c.getContext('2d'),d=g.getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if(d[i]+d[i+1]+d[i+2]>120)n++;return n/(d.length/4)})()`);
    check('rectified floor drawn', plan > 0.3, `${(plan * 100).toFixed(0)}% lit`);
    // players: the demo's two people (cylinders) found on the floor, in metres
    await waitFor(() => b.evaluate('__sq.players.length > 0'), 20000).catch(() => {});
    const pl = await b.evaluate(`(()=>{const S=__sq;return {got:S.players.map(p=>p.X),truth:S.truthPlayers,ms:S.rallyMs.players}})()`);
    const errs = pl.truth.map((T) => Math.min(...pl.got.map((X) => Math.hypot(X[0] - T[0], X[1] - T[1]))));
    check('demo frame: players in metres (within 15 cm)', pl.got.length >= 1 && errs.filter((e) => e < 0.15).length >= 1, `${pl.got.length} found, errors ${errs.map((e) => (e * 100).toFixed(0) + ' cm').join(', ')}, ${Math.round(pl.ms)} ms`);
    await shot('demo');
    const json = await b.evaluate(`(()=>{let out=null;const o=URL.createObjectURL;URL.createObjectURL=(blob)=>{blob.text().then(t=>window.__exp=t);return 'blob:x'};document.getElementById('export').click();URL.createObjectURL=o;return true})()`);
    await waitFor(() => b.evaluate('!!window.__exp'), 3000);
    const exp = JSON.parse(await b.evaluate('window.__exp'));
    check('export has K, R, P, homographies and players', json && exp.intrinsics.K.length === 9 && exp.P.length === 12 && exp.H_floor.length === 9 && Array.isArray(exp.players) && exp.players.length === pl.got.length);

    // 3. video, tracked
    await b.send('DOM.enable');
    const doc = await b.send('DOM.getDocument', {}), node = await b.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#file' });
    await b.send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: [CLIP] });
    // setFileInputFiles fires change on its own, usually; nudge it if the clip has not started
    try { await waitFor(() => b.evaluate('__sq.live'), 3000); } catch { await b.evaluate(`document.getElementById('file').dispatchEvent(new Event('change'));1`); }
    await waitFor(() => b.evaluate('__sq.live'), 10000);
    await b.evaluate(`__sq.src.loop = false; __sq.src.currentTime = 0; 1`); // the truth table below has no wrap-around
    const f00 = await b.evaluate('__sq.frames');
    await waitFor(() => b.evaluate(`__sq.frames > ${f00} + 2`), 30000);
    const f0 = await b.evaluate('__sq.frames');
    await sleep(1000);
    // pause, let the last analysis land, then compare with the camera of the frame on screen
    await b.evaluate(`__sq.src.pause();1`); await sleep(100);
    await waitFor(() => b.evaluate('!__sq.busy'), 5000);
    await b.evaluate(`new Promise(r=>{const S=__sq;const go=()=>{if(S.busy)return setTimeout(go,30);S.fails=0;r()};go()})`);
    const v = await b.evaluate(`(async()=>{const S=__sq; await new Promise(r=>{const t=setInterval(()=>{if(!S.busy){clearInterval(t);r()}},20)}); return {frames:S.frames,t:S.src.currentTime,C:S.cam.C,f:S.cam.f,w:S.srcW,trk:S.trackMs.slice(),ok:S.okay,path:S.path,mount:S.mount,tA:S.tAnalysed,wms:S.ms}})()`);
    // the last analysed frame may lag the paused frame by one tracking interval: accept the closest truth within 0.4 s
    const fi = Math.min(truthCams.length - 1, Math.round(v.t * 25));
    let best = Infinity;
    for (let j = Math.max(0, fi - 10); j <= Math.min(truthCams.length - 1, fi + 1); j++) { const p = truthCams[j].p; best = Math.min(best, Math.hypot(p[3] - v.C[0], p[4] - v.C[1], p[5] - v.C[2])); }
    const fps = v.trk.length ? 1000 / (v.trk.reduce((s, x) => s + x, 0) / v.trk.length) : 0;
    check('video tracked frame to frame', v.trk.length >= 2 && fps > 8, `${v.frames - f0} frames analysed in the last 1 s, tracking ${fps.toFixed(1)} fps (last: worker ${v.wms?.total?.toFixed(1)} ms of ${v.wms?.wall?.toFixed(1)} ms)`);
    check('tracked camera follows the clip (within 25 cm)', best < 0.25 && v.ok, `${(best * 100).toFixed(1)} cm at ${v.t.toFixed(2)} s (${v.path}, ${v.mount} mount, analysed ${v.tA?.toFixed(2)} s)`);
    await waitFor(() => b.evaluate('__sq.players.length > 0'), 8000).catch(() => {}); // a frame can come back empty (court lost on it)
    const vp = await b.evaluate(`({n:__sq.players.length,ms:__sq.rallyMs.players,mb:__sq.rallyMs.ball,X:__sq.players.map(p=>p.X.map(v=>+v.toFixed(2)))})`);
    await waitFor(() => b.evaluate('__sq.players.length > 0 && __sq.rallyMs.players != null'), 10000).catch(() => {});
    const hs = await b.evaluate(`(()=>{const st=Object.values(__sq.stats);return {n:st.length,sec:st.reduce((s,q)=>s+q.heat.reduce((a,v)=>a+v,0),0),sp:st.map(q=>q.speed)}})()`);
    check('video: heatmap and player speeds accumulate', hs.n > 0 && hs.sec > 0.1 && hs.sp.every((v) => v >= 0 && v < 9), `${hs.n} players, ${hs.sec.toFixed(1)} s in the heatmap, speeds ${hs.sp.map((v) => v.toFixed(1)).join(', ')} m/s`);
    const bb = await b.evaluate(`(()=>{const B=__sq.bounces;B.update([{t0:0.2,t1:0.5,impacts:[{t:0.3,X:[2,0,1.2],plane:'front'}],pts:[{t:0.2,X:[3,5,1],V:[0,-9,1]},{t:0.5,X:[2.5,3,0.03],V:[0,8,-4]}]}]);const n=[B.on('floor').length,B.on('front').length];return {n,fed:(__sq.ballTs||[]).length}})()`);
    check('video: bounces collected, ball fed from every video frame', bb.n[0] >= 1 && bb.n[1] >= 1 && bb.fed >= 1, `floor ${bb.n[0]}, front ${bb.n[1]}, ${bb.fed} frames to the ball worker`);
    check('video: players and ball run in their own workers', vp.n > 0 && vp.ms != null && vp.mb != null, `${vp.n} players ${JSON.stringify(vp.X)}, players ${Math.round(vp.ms)} ms, ball ${Math.round(vp.mb)} ms a frame`);
    await shot('video');
    // the time slider seeks, and typed names reach the labels and the commentary
    const sk = await b.evaluate(`(async()=>{const v=__sq.src,s=document.getElementById('seek');const shown=!document.getElementById('scrub').hidden;v.pause();s.value=0.5;s.dispatchEvent(new Event('input'));s.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,400));return {shown,t:v.currentTime,max:+s.max}})()`);
    check('time slider seeks the video', sk.shown && Math.abs(sk.t - 0.5) < 0.1 && sk.max > 1, JSON.stringify(sk));
    await b.evaluate(`(()=>{const i=document.getElementById('name1');i.value='Elias';i.dispatchEvent(new Event('input'));return 1})()`);
    // commentary feed fills from shots, and Clear empties heatmaps, bounces and the feed
    await b.evaluate(`(()=>{const S=__sq;S.comm.update([{t0:0.2,t1:0.9,cam:[3,17,4],impacts:[{t:0.4,X:[5.9,0.02,1.4],plane:'front'}],pts:[0.2,0.3,0.5,0.7,0.9].map((t,i)=>({t,X:[5.8,[6,3,1,3,6][i],1.2-0.2*i],V:[0,i<2?-30:20,-2]}))}],[],()=>({id:1,dist:0.3,other:3}));return 1})()`);
    await b.evaluate(`(()=>{const S=__sq;const s=S.comm.shots[0];if(s){S.feed.push({id:s.id,t:s.t,shot:s,player:1,sure:true});}document.getElementById('name1').dispatchEvent(new Event('input'));return 1})()`);
    const nm = await b.evaluate(`[...document.querySelectorAll('#feed li')].map(l=>l.textContent).join(' | ')`);
    check('typed name used in the commentary', /Elias plays/.test(nm), nm.slice(0, 120));
    await b.evaluate(`document.getElementById('clear').click();1`);
    const cl = await b.evaluate(`({heat:Object.keys(__sq.stats).length,b:__sq.bounces.list.length,shots:__sq.comm.shots.length,feed:document.querySelectorAll('#feed li').length})`);
    check('Clear resets heatmaps, bounces and commentary', cl.heat === 0 && cl.b === 0 && cl.shots === 0 && cl.feed === 0, JSON.stringify(cl));
    // a match file from tools/match.mjs
    const M = { source: 'test.mp4', duration: 600, courtSeconds: 500, audio: { heard: 10, offset: 0.03, matched: 5 }, flights: 2,
      players: [1, 2].map((id) => ({ id, colour: [200, 50, 90], distance: 900 + id, seconds: 400, topSpeed: 4.5, tControl: { seconds: 400, zoneSeconds: id === 1 ? 160 : 90, zoneShare: id === 1 ? 0.4 : 0.225, controlSeconds: id === 1 ? 180 : 120, controlShare: id === 1 ? 0.6 : 0.4, meanDistance: 1.2 + id / 10, radius: 1 }, speed: [[1, 2], [2, 3], [3, null], [5, 1]], heatmap: { cell: 0.25, nx: 26, ny: 39, seconds: Array.from({ length: 26 * 39 }, (_, i) => (i === 22 * 26 + 13 ? 50 : 0)) } })),
      shots: [{ t: 2.5, player: 1, kind: { type: 'drive', direction: 'straight', length: 'deep' }, front: [5.9, 0, 1.4], bounce: [6, 8.5, 0], speed: 40, quality: 4, text: 'P1 plays a hard straight drive (144 km/h), dying in the back corner.' }],
      coach: { radius: 1, total: 3, attributed: 2, shots: [], players: {
        1: { shots: 2, tAtOppHit: { n: 4, onT: 3, share: 0.75, medianDistance: 0.8, points: [[3.2, 5.6], [3.0, 6.0], [2.9, 5.2], [1.2, 8]] }, volleys: { n: 1, of: 2, share: 0.5, kinds: { drive: 1 }, points: [{ X: [3, 6], opp: [5, 8.5], kind: 'drive' }] }, firstBounces: { n: 2, zones: { front: 0, middle: 0, back: 2 }, byKind: { drive: 2 }, points: [{ X: [0.4, 8.5], kind: 'drive', inferred: false }, { X: [1.5, 7.5], kind: 'drive', inferred: true }], drives: 2, drivesDeep: 2, drivesTight: 1 } },
        2: { shots: 1, tAtOppHit: { n: 2, onT: 0, share: 0, medianDistance: 2.1, points: [[5, 8.5], [4.8, 8]] }, volleys: { n: 0, of: 1, share: 0, kinds: {}, points: [] }, firstBounces: { n: 1, zones: { front: 1, middle: 0, back: 0 }, byKind: { drop: 1 }, points: [{ X: [5.8, 1.2], kind: 'drop', inferred: false }], drives: 0, drivesDeep: 0, drivesTight: 0 } } } },
      bounces: [{ t: 3, plane: 'floor', x: 1, y: 8, z: 0, inferred: false, sound: false, player: 1 }, { t: 4, plane: 'front', x: 2, y: 0, z: 1, inferred: false, sound: true, player: 2 }] };
    fs.writeFileSync('/tmp/squash-smoke/match.json', JSON.stringify(M));
    await b.send('DOM.setFileInputFiles', { nodeId: node.result.nodeId, files: ['/tmp/squash-smoke/match.json'] });
    try { await waitFor(() => b.evaluate('!!__sq.match'), 3000); } catch { await b.evaluate(`document.getElementById('file').dispatchEvent(new Event('change'));1`); await waitFor(() => b.evaluate('!!__sq.match'), 3000); }
    const mt = await b.evaluate(`({txt:document.getElementById('readout').textContent,b:__sq.bounces.list.length})`);
    const fd = await b.evaluate(`[...document.querySelectorAll('#feed li')].map(l=>l.textContent)`);
    check('commentary feed shows the shots', fd.length === 1 && /straight drive/.test(fd[0]), fd[0]);
    check('match file: heatmaps, speeds and bounces shown', mt.b === 2 && /match\s+test\.mp4/.test(mt.txt) && /P1 hit 1/.test(mt.txt), mt.txt.split('\n')[0]);
    const sp = await b.evaluate(`(()=>{const c=document.getElementById('speed'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let n=0;for(let i=0;i<d.length;i+=4)if((d[i]>200&&d[i+1]<120)||(d[i+2]>200&&d[i]<120))n++;return n})()`);
    const tt = await b.evaluate(`[document.getElementById('heat1t').textContent, document.getElementById('heat2t').textContent, document.getElementById('readout').textContent]`);
    check('T domination per player (heatmap titles, readout)', /T 60%/.test(tt[0]) && /T 40%/.test(tt[1]) && /on the T 40% of the time/.test(tt[2]), `${tt[0]} | ${tt[1]}`);
    const ch = await b.evaluate(`(()=>{const n=(id)=>{const c=document.getElementById(id),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let k=0;for(let i=0;i<d.length;i+=4)if((d[i]>200&&d[i+1]<120)||(d[i+2]>200&&d[i]<120))k++;return k};return {t:n('coachT'),v:n('coachV'),b:n('coachB'),txt:document.getElementById('coachText').textContent}})()`);
    check('coaching: T at opponent\'s hit, volleys, first bounces', ch.t > 20 && ch.v > 10 && ch.b > 20 && /on the T at 75% of the opponent's hits/.test(ch.txt) && /volleys 1 of 2/.test(ch.txt) && /drives deep 2\/2/.test(ch.txt), ch.txt.split('\n')[1]);
    check('speed chart drawn per player', sp > 50, `${sp} px in the players' colours`);
    await shot('match');
    await b.evaluate(`document.getElementById('coachText').closest('figure').scrollIntoView();1`); await new Promise((r) => setTimeout(r, 200)); await shot('coach');
    const errors = [];
    for (const e of b.events) if (e.method === 'Runtime.exceptionThrown') errors.push(e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
    for (const e of b.events) if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') errors.push(e.params.args.map((a) => a.value || a.description).join(' '));
    check('no errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } catch (e) { check('run', false, e.stack); }
  b.kill(); server.close();
  console.log(failed ? `${failed} FAILED` : 'all ok');
  process.exit(failed ? 1 : 0);
})();

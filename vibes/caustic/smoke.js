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
  const b = await launch({ port: +process.env.CDP || 9435, width: 1280, height: 640 });
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
      check(`${tag}${set}: the caustic is lit and has lines`, st.mean > 0.5 && st.mean < 1.6 && st.sd > 0.4 && st.max > 3 && st.lit > 0.05, `mean ${st.mean.toFixed(2)}, sd ${st.sd.toFixed(2)}, max ${st.max.toFixed(1)}, lit ${(st.lit * 100).toFixed(0)}%`);
      const pc = await E('__caustic.posCheck()');
      check(`${tag}${set}: each beam's map of the set matches a traced ray`, pc.length > 0 && pc.every((p) => p.n >= 8 && p.bad < 1 && p.off <= Math.max(1, p.n * 0.08)), pc.map((p) => `${p.n} probes, worst ${p.bad.toFixed(2)}, ${p.off} on edges`).join('; '));
      if (tag) check(`${tag}${set}: the rays are traced in a compute pass`, await E('__caustic.lamps().length > 0 && __caustic.lamps().every((c) => c.compute)'));
      const er = errors(); check(`${tag}${set}: no console or shader errors`, er.length === 0, er.slice(0, 3).join(' | ').slice(0, 1500));
      if (!tag) {
        const sd = await E('__caustic.splashTest()');
        check(`${set}: a splash ripples the caustic`, sd > 0.02, `mean change ${sd.toFixed(3)}`);
        await E('__caustic.shot(0, 0.4)');
        const n = await E(`__caustic.splashAt(innerWidth * ${set === 'corridor' ? 0.15 : 0.5}, innerHeight * 0.35)`);
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
      // the people: shown in every set, and the walkers walk
      await E('__caustic.setPeople(true)');
      for (const set of ['corridor', 'office', 'hall']) {
        await E(`__caustic.show('${set}'); __caustic.shot(0, 0.4)`);
        const p0 = await E('__caustic.sets[__caustic.set].figures.group.children.map((c) => c.getWorldPosition(c.position.clone()).toArray())');
        await E('__caustic.frame(90)'); await shot(`people_${set}`);
        const p1 = await E('__caustic.sets[__caustic.set].figures.group.children.map((c) => c.getWorldPosition(c.position.clone()).toArray())');
        const moved = Math.max(...p0.map((a, i) => Math.hypot(a[0] - p1[i][0], a[2] - p1[i][2])));
        check(`people ${set}: shown, and a walker walks`, p0.length > 0 && moved > 0.4, `${p0.length} figures, moved ${moved.toFixed(2)} m in 3 s`);
      }
      // Luv's feet on the corridor's stairs, over a whole climb and descent: the lowest corner of the lower foot
      // each frame, against the floor under it (a tread's height), neither sunk into a step nor floating over it
      await E("__caustic.show('corridor')");
      const fc = await E(`(()=>{const S=__caustic.sets.corridor, f=S.figures.group.children[0], u=S.figures.walkers[0]; const zs=-5.2, tread=0.36, rise=0.19, h=(x,z)=>z>zs?0:Math.min(8,Math.floor((zs-z)/tread)+1)*rise;
        let pen=0, flo=0, n=0; for(let t=0;t<60;t+=1/30){ u(t); f.updateMatrixWorld(true); if(t<0.3) continue; const low=[];
          f.traverse(o=>{ if(o.isMesh&&o.geometry.type==='BoxGeometry'){ o.geometry.computeBoundingBox(); const b=o.geometry.boundingBox; let m=1e9; for(const x of [b.min.x,b.max.x]) for(const z of [b.min.z,b.max.z]){ const v=o.localToWorld(o.position.clone().set(x,b.min.y,z)); m=Math.min(m,v.y-h(v.x,v.z)); } low.push(m); } });
          const lo=Math.min(...low); pen=Math.min(pen,lo); flo=Math.max(flo,lo); n++; }
        return {pen, flo, n};})()`);
      check('people: Luv\'s feet land on each stair, up and down', fc.pen > -0.045 && fc.flo < 0.045, `worst ${(fc.pen * 100).toFixed(1)} cm into a step, ${(fc.flo * 100).toFixed(1)} cm over one, ${fc.n} frames`);
      // the gait: on the level an upright walk (hips within about 20 degrees of upright), and nowhere a joint that
      // jumps between two frames, on the level or the stairs
      const gait = await E(`(()=>{ const r={ hip: 0, jump: 0 };
        for (const [set, idx] of [['office', 1], ['corridor', 0]]) { __caustic.show(set); const S=__caustic.sets[set], fig=S.figures.group.children[idx], u=S.figures.walkers[idx]; let prev=null;
          for (let t=0; t<60; t+=1/30) { u(t); const pel=fig.children[0].children[0], J=[0,1].flatMap((i)=>[pel.children[i].rotation.x, pel.children[i].children[1].rotation.x]);
            if (set==='office') r.hip=Math.max(r.hip, Math.abs(J[0]), Math.abs(J[2]));
            if (prev) r.jump=Math.max(r.jump, ...J.map((j,i)=>Math.abs(j-prev[i]))); prev=J; } }
        return { hip: r.hip*57.3, jump: r.jump*57.3 }; })()`);
      check('people: an upright walk on the level, no joint jumping between frames', gait.hip < 21.5 && gait.jump < 20, `hips within ${gait.hip.toFixed(1)} degrees on the level, fastest joint ${gait.jump.toFixed(1)} degrees in a frame`);
      // nobody walks into the furniture: each walker's body (a column 0.16 m round, from above her knees to her head) clear of each
      // thing of the set that stands up out of the floor she is on (chairs, tables, desks, frames, stair risers ahead)
      const hits = await E(`(()=>{ const out=[]; const B=new __caustic.camera.position.constructor().constructor; 
        for (const set of ['corridor','office','hall']) { __caustic.show(set); const S=__caustic.sets[set];
          const boxes=[]; S.group.traverse((o)=>{ if (!o.isMesh || !o.geometry || S.figures.group.getObjectById(o.id) || o.material.isMeshBasicNodeMaterial) return; o.geometry.computeBoundingBox(); const b=o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); const sz=b.getSize(new __caustic.camera.position.constructor()); if (sz.x>6 && sz.z>6 || sz.y<0.05 && (sz.x>3||sz.z>3)) return; boxes.push([b, o.name||o.geometry.type]); });
          S.figures.walkers.forEach((u,i)=>{ const f=S.figures.figs[i]; u(0); const p0=f.root.position.clone(); u(20); if (p0.distanceTo(f.root.position)<0.01) return; for (let t=0;t<80;t+=0.25){ u(t); const p=f.root.position;
            for (const [b,n] of boxes) { const lo=p.y+0.6, hi=p.y+1.6; if (b.max.y<lo || b.min.y>hi) continue; if (p.x>b.min.x-0.16 && p.x<b.max.x+0.16 && p.z>b.min.z-0.16 && p.z<b.max.z+0.16) { out.push(set+' '+i+' t'+t+' '+n+' at '+[p.x,p.z].map(v=>v.toFixed(2))); break; } } } }); }
        return out; })()`);
      check('people: nobody walks into the furniture', hits.length === 0, hits.slice(0, 4).join('; ') || 'all clear');
      // the MakeHuman Luv: it loads, every set's Luv wears it, and its ankles follow the mannequin's as she walks
      // (only where the model was built: tools/fetch_makehuman.py)
      const hasMH = fs.existsSync(path.join(DIR, 'assets', 'luv.glb'));
      if (!hasMH) console.log('     (no assets/luv.glb: skipping the MakeHuman Luv; python3 tools/fetch_makehuman.py builds it)');
      if (hasMH) {
      await E('__caustic.setMakehuman(true)');
      const mh = await E(`(()=>{ const out={};
        for (const [set, idx] of [['corridor', 0], ['office', 1], ['hall', 1]]) { __caustic.show(set); const S=__caustic.sets[set], f=S.figures.figs[idx], u=S.figures.walkers[idx]; let worst=0; const b={};
          if (!f.mh) { out[set]=null; continue; } f.mh.model.traverse((o)=>{ if (o.isBone) b[o.name]=o; });
          for (let t=0; t<40; t+=1/10) { u(t); f.mh.pose(); f.root.updateMatrixWorld(true);
            for (const [side, nm] of [[1,'foot_l'],[0,'foot_r']]) worst=Math.max(worst, f.legs[side].ankle.getWorldPosition(f.root.position.clone()).distanceTo(b[nm].getWorldPosition(f.root.position.clone()))); }
          out[set]=worst; }
        return out; })()`);
      if (fs.existsSync(path.join(DIR, 'assets', 'wallace.glb'))) {
        const w = await E(`(()=>{ const out={}; for (const [set, idx] of [['office', 0], ['hall', 0]]) { __caustic.show(set); const f=__caustic.sets[set].figures.figs[idx];
          out[set] = f.kind === 'man' && !!f.mh; } return out; })()`);
        check('people: the MakeHuman Wallace is worn in the office and the hall', Object.values(w).every(Boolean), JSON.stringify(w));
      }
      check('people: the MakeHuman Luv is worn in every set and follows the walk', Object.values(mh).every((w) => w !== null && w < 0.01), Object.entries(mh).map(([k, w]) => `${k} ${w === null ? 'missing' : (w * 100).toFixed(1) + ' cm'}`).join(', '));
      await E("__caustic.show('corridor'); __caustic.shot(0, 0.4)"); await E('__caustic.frame(30)'); await shot('people_makehuman');
      await E('__caustic.setMakehuman(false)');
      }
      await E('__caustic.setPeople(false)');
      // the classic mode: every set lit by the tiled, projected caustic again, and back
      await E("__caustic.setMode('classic')");
      for (const set of ['corridor', 'office', 'hall']) {
        await E(`__caustic.show('${set}'); __caustic.shot(0, 0.4)`); await E('__caustic.frame(6)'); await shot(`classic_${set}`);
        const st = await E('__caustic.causticStats()');
        check(`classic ${set}: the tiled caustic is lit and has lines`, st.mean > 0.5 && st.mean < 1.6 && st.sd > 0.4 && st.max > 3, `mean ${st.mean.toFixed(2)}, sd ${st.sd.toFixed(2)}, max ${st.max.toFixed(1)}`);
        const n = await E('__caustic.splashAt(innerWidth * 0.5, innerHeight * 0.4)');
        check(`classic ${set}: a tap lands in a beam`, n > 0, `${n} beams`);
      }
      await E("__caustic.setMode('traced')");
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

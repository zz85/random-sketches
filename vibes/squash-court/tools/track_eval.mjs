// node tools/track_eval.mjs <video> [--ss 12.5] [--n 150] [--fps 25] [--w 960] [--truth cams.json]
//   [--mode both|full|sparse] [--out dir]
// Tracks a clip frame to frame the way the page does (detect on the first frame, then track), with
// the full tracker (whole-frame line map at 480 px every frame) and with the sparse tracker
// (track.js, falling back to the full one when it loses the court). Reports time per frame, how
// often each path ran, jitter (frame-to-frame movement of the projected court, px — on a fixed
// camera it should be ~0) and, with --truth (make_video.mjs writes one), camera position error.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Camera } from '../camera.js';
import { detectCourt, trackCourt, features, total, toWorkCam, modelSamples } from '../detect.js';
import { createTracker, resetTracker, trackFrame, recallShot } from '../track.js';
import { courtModel, samplePoints } from '../court.js';

const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const file = args[0], ss = +arg('ss', 0), n = +arg('n', 150), fps = +arg('fps', 25), width = +arg('w', 960), mode = arg('mode', 'both'), out = arg('out', null);
const SOPT = arg('sopt', null) ? JSON.parse(arg('sopt')) : {};
const truth = arg('truth', null) && JSON.parse(fs.readFileSync(arg('truth'))), every = +arg('every', 1);

async function frames() {
  const ff = spawn('ffmpeg', ['-v', 'error', '-ss', String(ss), '-i', file, '-frames:v', String(n), '-vf', `fps=${fps},scale=${width}:-2`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const chunks = []; for await (const c of ff.stdout) chunks.push(c);
  const buf = Buffer.concat(chunks), h = Math.round(width * 9 / 16) & ~1, sz = width * h * 4, list = [];
  for (let o = 0; o + sz <= buf.length; o += sz) list.push(new Uint8ClampedArray(buf.buffer, buf.byteOffset + o, sz));
  return { list, w: width, h };
}

const { list, w, h } = await frames();
console.log(`${list.length} frames ${w}x${h} from ${path.basename(file)} @${ss}s`);
const det = detectCourt(list[0], w, h);
console.log(`detect frame 0: ok=${det.ok} C=[${det.cam.C.map((v) => v.toFixed(2))}] hfov=${det.cam.hfov().toFixed(1)} ${Math.round(det.ms.total)} ms`);
const FLOOR = []; for (let x = 0.4; x < 6.4; x += 0.8) for (let y = 0.4; y < 9.75; y += 0.8) FLOOR.push([x, y, 0]);
const P = samplePoints(courtModel({ tin: det.tin }), 0.5).map((s) => s.X);
const truthCam = (i) => truth && truth[i * every] && new Camera(truth[i * every].p, w, h, truth[i * every].cx * w / 960, truth[i * every].cy * w / 960);

function run(kind) {
  let cam = det.cam, fails = 0, prev = null;
  const st = createTracker({ tin: det.tin }); resetTracker(st, cam, det.tin);
  const ms = [], jit = [], err = [], ferr = [], modes = {}, cams = [];
  for (let i = 1; i < list.length; i++) {
    const t0 = performance.now(); let r, m;
    if (kind === 'sparse' && fails < 3) {
      const dbg = []; r = trackFrame(list[i], w, h, cam, st, { ...SOPT, dt: 1 / fps, debug: dbg }); m = r.path; if (process.env.V) console.log(i, m, r.hit?.toFixed(2), r.n, r.rms?.toFixed(2), r.cam.C.map((v) => v.toFixed(2)).join(','), truthCam(i)?.C.map((v) => v.toFixed(2)).join(','));
    } else if (fails < 3) { r = trackCourt(list[i], w, h, cam, { tin: det.tin }); m = 'full'; }
    else {
      const back = kind === 'sparse' && recallShot(list[i], w, h, st, SOPT);
      if (back) { r = back; m = 'recall'; } else { r = detectCourt(list[i], w, h); m = 'detect'; if (r.ok) resetTracker(st, r.cam, r.tin); }
    }
    ms.push(performance.now() - t0); modes[m] = (modes[m] || 0) + 1;
    if (r.ok) { cam = r.cam; fails = 0; } else fails++;
    cams.push({ p: cam.p, ok: r.ok, mode: m });
    // jitter: mean movement of projected court points since the last frame
    const pr = P.map((X) => cam.project(X));
    if (prev) { let s = 0, k = 0; pr.forEach((u, j) => { const v = prev[j]; if (u[2] > 0 && v[2] > 0 && u[0] >= 0 && u[0] < w && u[1] >= 0 && u[1] < h) { s += Math.hypot(u[0] - v[0], u[1] - v[1]); k++; } }); if (k) jit.push(s / k); }
    prev = pr;
    const tc = truthCam(i); if (tc) {
      err.push(Math.hypot(...cam.C.map((v, k) => v - tc.C[k])));
      // floor error: visible floor points seen through the true camera, put on the floor by ours
      let s = 0, k = 0;
      for (const X of FLOOR) { const u = tc.project(X); if (!(u[2] > 0) || u[0] < 0 || u[1] < 0 || u[0] >= w || u[1] >= h) continue; const Y = cam.toFloor(u[0], u[1]); s += Y ? Math.min(5, Math.hypot(Y[0] - X[0], Y[1] - X[1])) : 5; k++; }
      if (k) ferr.push(s / k);
    }
  }
  const q = (a, f) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
  const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  console.log(`${kind.padEnd(6)} ${mean(ms).toFixed(1)} ms/frame (median ${q(ms, 0.5).toFixed(1)}, p95 ${q(ms, 0.95).toFixed(1)})  paths ${JSON.stringify(modes)}  jitter median ${q(jit, 0.5).toFixed(3)} px mean ${mean(jit).toFixed(3)}` +
    (err.length ? `  error median ${(q(err, 0.5) * 100).toFixed(1)} cm, p95 ${(q(err, 0.95) * 100).toFixed(1)} cm, max ${(Math.max(...err) * 100).toFixed(1)} cm;  floor error median ${(q(ferr, 0.5) * 100).toFixed(1)} cm, p95 ${(q(ferr, 0.95) * 100).toFixed(1)} cm` : ''));
  // independent check on a few frames: the detector's own score of the camera against the full
  // 640 px line map (higher is better; what detection maximises)
  const sc = [];
  for (const f of [0.25, 0.5, 0.75, 1]) { const i = Math.min(cams.length - 1, Math.round(f * (cams.length - 1))), F = features(list[i + 1], w, h, { workWidth: 640 }), M = modelSamples(det.tin, 0.08); sc.push(total(toWorkCam(new Camera(cams[i].p, w, h), F), F, M.pts, M.model).score.toFixed(0)); }
  console.log(`       score vs 640 px line map at 25/50/75/100%: ${sc.join(' ')}`);
  return cams;
}
const res = {};
for (const k of mode === 'both' ? ['full', 'sparse'] : [mode]) res[k] = run(k);
if (out) {
  const { writeImage, drawCourt } = await import('./nodeimg.js');
  fs.mkdirSync(out, { recursive: true });
  for (const k of Object.keys(res)) for (const i of [0, 0.25, 0.5, 0.75, 1].map((f) => Math.min(res[k].length - 1, Math.round(f * (res[k].length - 1))))) {
    const img = { data: new Uint8ClampedArray(list[i + 1]), width: w, height: h };
    drawCourt(img, new Camera(res[k][i].p, w, h), { tin: det.tin, thick: 2 });
    writeImage(path.join(out, `${k}_${String(i + 1).padStart(3, '0')}.jpg`), img);
  }
}
if (res.full && res.sparse && process.env.CMP) {
  const line = [];
  for (let i = 0; i < res.full.length; i += 10) {
    const a = new Camera(res.full[i].p, w, h), b = new Camera(res.sparse[i].p, w, h); let s = 0, k = 0;
    for (const X of P) { const u = a.project(X), v = b.project(X); if (u[2] > 0 && v[2] > 0 && u[0] >= 0 && u[0] < w && u[1] >= 0 && u[1] < h) { s += Math.hypot(u[0] - v[0], u[1] - v[1]); k++; } }
    line.push(`${i + 1}:${res.sparse[i].mode[0]}:${(s / k).toFixed(1)}`);
  }
  console.log('full vs sparse (px):', line.join(' '));
}

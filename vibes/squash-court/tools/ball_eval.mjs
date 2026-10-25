// node tools/ball_eval.mjs [n] — synthetic rallies: simulate shots with bounces, project with pixel
// noise, cut at impacts, fit flights in 3D. Reports 3D error per frame and impact labels.
import { simulate, cutTrack, fitFlights } from '../ball.js';
import { randomBroadcastCamera } from '../synth.js';
import { mulberry32 } from '../detect.js';
const n = +(process.argv[2] || 10), noise = +(process.env.NOISE || 1), fps = 50, rng = mulberry32(3);
const gauss = () => { let u = 0; while (!u) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
const errs = [], labelOk = [], all = [];
for (let i = 0; i < n; i++) {
  const cam = randomBroadcastCamera(rng, 1280, 720);
  // a drive: hit from the back of the court at the front wall, comes back off the floor
  const X0 = [1 + rng() * 4.4, 6 + rng() * 3, 0.4 + rng() * 0.8], tgt = [rng() * 6.4, 0, 0.6 + rng() * 2.5];
  const d = tgt.map((v, j) => v - X0[j]), L = Math.hypot(...d), sp = 18 + rng() * 25;
  const V0 = d.map((v) => (v / L) * sp); V0[2] += 2;
  const sim = simulate(X0, V0, 1.0, fps);
  const pts = sim.frames.map((f) => { const u = cam.project(f.X); return { t: f.t, u: u[0] + noise * gauss(), v: u[1] + noise * gauss(), X: f.X }; }).filter((p) => p.u > 0 && p.v > 0 && p.u < 1280 && p.v < 720);
  // cut at the true impact frames (the detector's job; here the fit is tested on its own)
  const imp = sim.events.filter((e) => e.type !== 'racket').map((e) => pts.findIndex((p) => p.t >= e.t)).filter((k) => k > 0);
  const idx = [0, ...imp, pts.length - 1], segs = [];
  for (let k = 0; k + 1 < idx.length; k++) { const a = k ? idx[k] : 0, b = k + 2 < idx.length ? idx[k + 1] - 1 : idx[k + 1]; if (b - a >= 2) segs.push([a, b]); }
  const auto = process.env.AUTO ? cutTrack(pts, cam, { tol: Math.max(2, 2.5 * noise) }) : [];
  const r = fitFlights(pts, process.env.AUTO ? auto : segs, cam);
  let nf = 0; for (const f of r.flights) for (const q of f.pts3) { const p = pts.find((p) => p.t === q.t); const e = Math.hypot(...q.X.map((v, j) => v - p.X[j])); errs.push(e); nf++; }
  const truth = sim.events.map((e) => e.type).join(' ');
  console.log(`#${i} truth: ${truth.padEnd(28)} fit: ${r.labels.join(' ').padEnd(40)} median err ${(errs.slice(-nf).sort((a, b) => a - b)[nf >> 1] * 100).toFixed(0)} cm  rms ${r.rms.toFixed(2)} px  cuts auto ${auto.length} true ${segs.length}`);
}
errs.sort((a, b) => a - b);
console.log(`\n3D error over ${errs.length} frames: median ${(errs[errs.length >> 1] * 100).toFixed(1)} cm, 90% ${(errs[Math.floor(errs.length * 0.9)] * 100).toFixed(1)} cm (pixel noise ${noise})`);

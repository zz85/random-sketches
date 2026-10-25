// node tools/synth_eval.mjs [n] [--save]  — render synthetic frames with known cameras, detect,
// and report pose errors: camera position (cm), view direction (°), focal (%), and the mean
// reprojection error of court points (px at the rendered size).
import { renderCourt, randomBroadcastCamera } from '../synth.js';
import { detectCourt, mulberry32, total, toWorkCam, modelSamples, refine } from '../detect.js';
import { writeImage, drawCourt } from './nodeimg.js';
import fs from 'fs';

const args = process.argv.slice(2), save = args.includes('--save');
const n = +(args.find((a) => /^\d+$/.test(a)) || 10), W = +(process.env.W || 960), H = W * 9 / 16;
const rng = mulberry32(42);
const probe = []; for (let x = 0; x <= 6.4; x += 0.8) for (let y = 0; y <= 9.75; y += 0.975) probe.push([x, y, 0]);
for (let x = 0; x <= 6.4; x += 0.8) for (let z = 0; z <= 4.5; z += 0.5) probe.push([x, 0, z]);
const rows = [];
if (save) fs.mkdirSync('/tmp/squash/synth', { recursive: true });
for (let i = 0; i < n; i++) {
  const cam = randomBroadcastCamera(rng, W, H);
  const style = i % 2 ? 'glass' : 'club';
  const img = renderCourt(cam, { seed: i + 1, style, players: 2, adverts: 8 });
  const r = detectCourt(img.data, W, H, {});
  const c = r.cam;
  const ms = modelSamples(0.48, 0.08), tw = toWorkCam(cam, r.features), T = total(tw, r.features, ms.pts, ms.model);
  const Tr = total(refine(tw, r.features, ms.pts, { tau: 3, minTau: 1 }).cam, r.features, ms.pts, ms.model);
  let pe = 0, pn = 0;
  for (const X of probe) { const a = cam.project(X), b = c.project(X); if (a[2] > 0 && a[0] >= 0 && a[0] < W && a[1] >= 0 && a[1] < H && b[2] > 0) { pe += Math.hypot(a[0] - b[0], a[1] - b[1]); pn++; } }
  const dC = Math.hypot(...cam.C.map((v, k) => v - c.C[k])) * 100;
  const dz = (A) => [A.R[6], A.R[7], A.R[8]];
  const dot = dz(cam).reduce((s, v, k) => s + v * dz(c)[k], 0), dAng = Math.acos(Math.min(1, dot)) * 180 / Math.PI;
  const dF = (c.f / cam.f - 1) * 100;
  rows.push({ i, style, ok: r.ok, dC, dAng, dF, px: pe / Math.max(1, pn), ms: r.ms.total });
  console.log(`#${i} ${style.padEnd(5)} ok=${r.ok} pos ${dC.toFixed(1)} cm  dir ${dAng.toFixed(2)}°  f ${dF.toFixed(2)}%  reproj ${(pe / Math.max(1, pn)).toFixed(2)} px  cov ${r.coverage.toFixed(2)} score ${r.score.toFixed(0)} truth ${T.score.toFixed(0)} truthRef ${Tr.score.toFixed(0)}  ${Math.round(r.ms.total)} ms`);
  if (save) { drawCourt(img, c); writeImage(`/tmp/squash/synth/s${i}.jpg`, img); }
}
const good = rows.filter((r) => r.px < 3);
const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };
console.log(`\nfound ${good.length}/${rows.length} (reproj < 3 px)  median: pos ${med(good.map((r) => r.dC)).toFixed(1)} cm, dir ${med(good.map((r) => r.dAng)).toFixed(2)}°, f ${med(good.map((r) => Math.abs(r.dF))).toFixed(2)}%, reproj ${med(good.map((r) => r.px)).toFixed(2)} px; median time ${med(rows.map((r) => r.ms)).toFixed(0)} ms`);

// node tools/players_eval.mjs [n] — synthetic frames with players at known spots: detect the court,
// then the players, and report the floor-position error in cm.
import { renderCourt, randomBroadcastCamera } from '../synth.js';
import { detectCourt, mulberry32 } from '../detect.js';
import { detectPlayers } from '../players.js';
const n = +(process.argv[2] || 10), W = 960, H = 540, rng = mulberry32(7);
const errs = []; let missed = 0, extra = 0, tms = 0, nvis = 0; const along = [];
for (let i = 0; i < n; i++) {
  const cam = randomBroadcastCamera(rng, W, H);
  const P = [[1 + rng() * 4.4, 2.5 + rng() * 6], [1 + rng() * 4.4, 2.5 + rng() * 6]];
  const img = renderCourt(cam, { seed: i + 1, style: i % 2 ? 'glass' : 'club', players: P.map(([x, y]) => ({ x, y })), adverts: 8 });
  const useTruth = process.env.TRUTH, c = useTruth ? cam : detectCourt(img.data, W, H).cam;
  const t0 = performance.now(), r = detectPlayers(img.data, W, H, c); tms += performance.now() - t0;
  const got = r.players.map((p) => p.X), row = [];
  const vis = (p) => { const u = cam.project([p[0], p[1], 0]); return u[2] > 0 && u[0] > 15 && u[1] > 15 && u[0] < W - 15 && u[1] < H - 15; };
  for (const p of P) { if (!vis(p)) { row.push('-'); continue; } const d = Math.min(...got.map((g) => Math.hypot(g[0] - p[0], g[1] - p[1]))); const g = got.find((g) => Math.hypot(g[0] - p[0], g[1] - p[1]) === d); if (g && d < 0.6) { const gx = p[0] - c.C[0], gy = p[1] - c.C[1], gl = Math.hypot(gx, gy); along.push(((g[0] - p[0]) * gx + (g[1] - p[1]) * gy) / gl); } if (d < 0.6) { errs.push(d); row.push((d * 100).toFixed(0)); } else { missed++; row.push('miss'); } }
  nvis += P.filter(vis).length;
  extra += Math.max(0, got.length - row.filter((x) => x !== 'miss' && x !== '-').length);
  console.log(`#${i} ${i % 2 ? 'glass' : 'club '} ${row.join(' ')} cm  found ${got.length}`);
}
errs.sort((a, b) => a - b);
console.log(`\n${errs.length}/${nvis} visible players within 60 cm, median ${(errs[errs.length >> 1] * 100).toFixed(1)} cm, 90% ${(errs[Math.floor(errs.length * 0.9)] * 100).toFixed(1)} cm; ${extra} extra; ${(tms / n).toFixed(0)} ms per frame`);
console.log("along-ray bias (+ = too far from camera) cm:", along.map((v) => (v * 100).toFixed(0)).join(" "));

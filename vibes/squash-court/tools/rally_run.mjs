// node tools/rally_run.mjs <video|frame dir> <out dir> [start s] [seconds] — players and ball in
// metres over a clip. The court is detected on the first frame (the camera is assumed still; use a
// wide, uncut stretch). Writes annotated frames o###.jpg and a flights.json, and prints the
// players and every fitted flight.
import { execFileSync } from 'child_process';
import { mkdirSync, readdirSync, writeFileSync, rmSync } from 'fs';
import { readImage, writeImage, line, drawSeg } from './nodeimg.js';
import { detectCourt } from '../detect.js';
import { Rally } from '../rally.js';

const [src, out, ss = '0', dur = '4'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
let files, fps = +(process.env.FPS || 50);
if (src.endsWith('.mp4') || src.endsWith('.webm') || src.endsWith('.mov')) {
  const dir = `${out}/frames`; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
  execFileSync('ffmpeg', ['-v', 'error', '-ss', ss, '-i', src, '-t', dur, `${dir}/f%04d.png`]);
  files = readdirSync(dir).sort().map((f) => `${dir}/${f}`);
} else files = readdirSync(src).filter((f) => /\.(png|jpg)$/.test(f)).sort().map((f) => `${src}/${f}`);

const first = readImage(files[0]), W = first.width, H = first.height;
const C = detectCourt(first.data, W, H);
if (!C.ok) { console.log('no court on the first frame'); process.exit(1); }
const cam = C.cam, R = new Rally(), all = [];
const live = [];
let tP = 0, nP = 0;
for (let i = 0; i < files.length; i++) {
  const img = i ? readImage(files[i]) : first, t = i / fps;
  const r = R.frame(img.data, W, H, cam, t, { tin: C.tin });
  if (!r.dup) { tP += r.ms.total; nP++; }
  if (r.ball) live.push(r.ball);

  // annotate
  for (const p of r.players) {
    const u = cam.project([p.X[0], p.X[1], 0]); if (!(u[2] > 0)) continue;
    const col = p.id === 1 ? [255, 60, 160] : [60, 200, 255];
    for (let a = 0; a < 24; a++) { const q = cam.project([p.X[0] + 0.25 * Math.cos(a / 24 * 6.283), p.X[1] + 0.25 * Math.sin(a / 24 * 6.283), 0]), q2 = cam.project([p.X[0] + 0.25 * Math.cos((a + 1) / 24 * 6.283), p.X[1] + 0.25 * Math.sin((a + 1) / 24 * 6.283), 0]); line(img, q[0], q[1], q2[0], q2[1], col, 2); }
    label(img, u[0] + 12, u[1] + 4, col);
  }
  for (const f of R.flights.filter((f) => f.t1 > t - 1.5)) for (let k = 1; k < f.pts.length; k++) drawSeg(img, cam, f.pts[k - 1].X, f.pts[k].X, [255, 240, 0], 2);
  for (const b of live.filter((b) => b.t > t - 0.3)) box(img, b.u, b.v, 6, [0, 255, 0]);
  if (process.env.ALL || i % 2 === 0) writeImage(`${out}/o${String(i).padStart(4, '0')}.jpg`, img);
}
all.push(...R.finish(cam, W)); for (const f of all) report(f);
writeFileSync(`${out}/flights.json`, JSON.stringify({ camera: { C: cam.C, f: cam.f }, flights: all }, null, 1));
console.log(`${files.length} frames, ${nP} distinct, ${(tP / nP).toFixed(0)} ms per distinct frame, ${all.length} flights`);

function report(f) {
  const a = f.pts[0].X, b = f.pts[f.pts.length - 1].X, fx = (X) => `(${X.map((v) => v.toFixed(2)).join(', ')})`;
  console.log(`flight ${f.t0.toFixed(2)}–${f.t1.toFixed(2)} s  ${fx(a)} -> ${fx(b)}  ${f.speed.toFixed(1)} m/s  rms ${f.rms.toFixed(2)} px  ${f.labels.join(',')}${f.impacts.length ? '  impacts ' + f.impacts.map((m) => `${m.plane}@${fx(m.X)}`).join(' ') : ''}`);
}
function box(img, u, v, r, col) { line(img, u - r, v - r, u + r, v - r, col); line(img, u - r, v + r, u + r, v + r, col); line(img, u - r, v - r, u - r, v + r, col); line(img, u + r, v - r, u + r, v + r, col); }
function label(img, x, y, col) { line(img, x, y, x + 6, y, col, 2); }

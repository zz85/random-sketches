// node tools/run.mjs <images...> [--out dir]  — detect the court in each image, print the camera
// and timings, and write an overlay (cyan: painted lines, yellow: court box) per image.
import path from 'path';
import fs from 'fs';
import { readImage, writeImage, drawCourt } from './nodeimg.js';
import { detectCourt } from '../detect.js';

const args = process.argv.slice(2);
const oi = args.indexOf('--out'), out = oi >= 0 ? args.splice(oi, 2)[1] : '/tmp/squash/out';
const mi = args.indexOf('--map'); const showMap = mi >= 0 && args.splice(mi, 1);
fs.mkdirSync(out, { recursive: true });
for (const f of args) {
  const img = readImage(f);
  const r = detectCourt(img.data, img.width, img.height, { colour: !!process.env.COL });
  const c = r.cam, a = c?.angles();
  console.log(`${path.basename(f)} colour=${r.features.colour.colour?.map((v) => v.toFixed(0))}/${r.features.colour.chroma?.toFixed(0)} ok=${r.ok} score=${r.score?.toFixed(0)} cov=${r.coverage?.toFixed(2)} recall=${r.recall?.toFixed(2)} rms=${r.rms?.toFixed(2)}px  C=[${c?.C.map((v) => v.toFixed(2))}] hfov=${c?.hfov().toFixed(1)} yaw=${a?.yaw.toFixed(1)} pitch=${a?.pitch.toFixed(1)} roll=${a?.roll.toFixed(1)} k1=${c?.k1.toFixed(3)}  ms=${JSON.stringify(Object.fromEntries(Object.entries(r.ms).map(([k, v]) => [k, Math.round(v)])))}`);
  if (showMap) {
    const F = r.features, s = F.scale;
    for (const p of F.pts) { const X = Math.floor(p.x * s), Y = Math.floor(p.y * s); const g = Math.round(255 * p.wt); for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) { const o = ((Y + j) * img.width + X + i) * 4; img.data[o] = 255 - g; img.data[o + 1] = g; img.data[o + 2] = 0; } }
  }
  if (c) drawCourt(img, c, { thick: 1 });
  writeImage(path.join(out, path.basename(f).replace(/\.\w+$/, '.jpg')), img);
}

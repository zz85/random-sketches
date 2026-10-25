// node tools/players_run.mjs <out dir> <images...> — court, then players, on real frames: writes
// overlays (magenta: foreground, green cross: feet, label: metres) and prints the positions.
import path from 'path';
import fs from 'fs';
import { readImage, writeImage, line, drawSeg } from './nodeimg.js';
import { detectCourt } from '../detect.js';
import { detectPlayers } from '../players.js';
import { courtModel } from '../court.js';
const [out, ...files] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
for (const f of files) {
  const img = readImage(f), r = detectCourt(img.data, img.width, img.height);
  let msg = `${path.basename(f)} court ${r.ok}`, dbg = [];
  if (r.ok) {
    const t0 = performance.now(), P = detectPlayers(img.data, img.width, img.height, r.cam, { tin: r.tin, debug: dbg }), ms = performance.now() - t0, k = img.width / P.w;
    for (let q = 0; q < P.w * P.h; q++) if (P.fg[q]) { const x = Math.floor((q % P.w) * k), y = Math.floor(((q / P.w) | 0) * k); for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) { const o = ((y + j) * img.width + x + i) * 4; img.data[o] = (img.data[o] + 255) / 2; img.data[o + 2] = (img.data[o + 2] + 255) / 2; } }
    for (const l of courtModel({ tin: r.tin }).lines) if (l.kind === 'floor') drawSeg(img, r.cam, l.a, l.b, [0, 200, 255], 1);
    for (const p of P.players) { const u = p.foot; line(img, u[0] - 12, u[1], u[0] + 12, u[1], [0, 255, 0], 3); line(img, u[0], u[1] - 12, u[0], u[1] + 12, [0, 255, 0], 3); }
    msg += ` players ${P.players.map((p) => `(${p.X[0].toFixed(2)}, ${p.X[1].toFixed(2)}) h${p.height.toFixed(1)}`).join(' ')} ${ms.toFixed(0)} ms`;
  }
  console.log(msg); if (process.env.DEBUG && r.ok) console.log('   ', JSON.stringify(dbg.map((d) => [d.x.toFixed(1), d.y.toFixed(1), d.score.toFixed(2), d.why || 'ok'])));
  writeImage(path.join(out, path.basename(f).replace(/\.\w+$/, '.jpg')), img);
}

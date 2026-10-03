// How much would oemer's notehead segmentation add to ScoreShift's head detector?
//   bun tools/oemer_heads.mjs <dir with oemer <fixture>_<cond>.json + _mask.png>
// The json/mask come from running oemer's seg_net (notehead layer) on the fixture images (see
// README). Per condition: truth heads found by ScoreShift, by oemer (head centre inside the
// predicted notehead mask), by either; and oemer's blobs that cover no truth head.
import fs from 'fs';
import { evaluate } from '../eval.js';
import { decodeGray } from '../png.js';
import { degrade, CONDITIONS } from '../degrade.js';

const DIR = process.argv[2] || '/tmp/oem/out';
const rows = {};
for (const f of fs.readdirSync(DIR).filter((f) => /_(clean|scan|photo|phone)\.json$/.test(f))) {
  const [, name, cond] = f.match(/^(.*)_(clean|scan|photo|phone)\.json$/);
  const O = JSON.parse(fs.readFileSync(`${DIR}/${f}`)), mask = decodeGray(fs.readFileSync(`${DIR}/${f.replace('.json', '_mask.png')}`));
  const r = evaluate(name, cond), S = r.truth.space * (CONDITIONS[cond].scale || 1);
  const { fwd } = cond === 'clean' ? { fwd: (x, y) => [x, y] } : degrade({ w: r.truth.w, h: r.truth.h, data: new Uint8Array(r.truth.w * r.truth.h) }, CONDITIONS[cond]);
  const found = new Set(r.pairs.map(([t]) => t));
  const inMask = (x, y, rad) => { for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) { const X = Math.round(x + dx), Y = Math.round(y + dy); if (X >= 0 && Y >= 0 && X < mask.w && Y < mask.h && mask.data[Y * mask.w + X]) return true; } return false; };
  const R = (rows[cond] ||= { n: 0, ss: 0, oem: 0, either: 0, oemOnly: 0, blobs: 0, falseBlobs: 0, secs: 0 });
  const tpts = r.tn.map((t) => ({ t, p: fwd(t.x, t.y) }));
  for (const { t, p } of tpts) {
    R.n++; const o = inMask(p[0], p[1], Math.round(0.15 * S)), s = found.has(t);
    if (s) R.ss++; if (o) R.oem++; if (o || s) R.either++; if (o && !s) R.oemOnly++;
  }
  for (const b of O.blobs) {
    R.blobs++;
    if (!tpts.some(({ p }) => p[0] >= b[2] - 0.3 * S && p[0] <= b[4] + 0.3 * S && p[1] >= b[3] - 0.3 * S && p[1] <= b[5] + 0.3 * S)) R.falseBlobs++;
  }
  R.secs += O.secs;
}
const p = (a, b) => ((100 * a) / b).toFixed(1) + '%';
console.log('cond    heads  ScoreShift  oemer   either  (oemer only)  oemer blobs covering no head   oemer s/page');
for (const [c, R] of Object.entries(rows)) console.log(c.padEnd(7), String(R.n).padStart(5), p(R.ss, R.n).padStart(10), p(R.oem, R.n).padStart(7), p(R.either, R.n).padStart(8), String(R.oemOnly).padStart(8), `${R.falseBlobs}/${R.blobs}`.padStart(20), (R.secs / (R.blobs ? Object.keys(rows).length && 1 : 1) / (fs.readdirSync(DIR).filter((f) => f.endsWith(`_${c}.json`)).length)).toFixed(0).padStart(14));

// Debug overlay of the analysis on the normalized binary: bun debug.js <tune> [cond] [x0 y0 x1 y1]
import fs from 'fs';
import { encodeRGB } from './png.js';
import { evaluate } from './eval.js';
import { lineY } from './omr.js';
const [name, cond = 'clean', ...crop] = process.argv.slice(2);
const r = evaluate(name, cond), { bin } = r.norm, { w, h } = bin, res = r.res;
const out = new Uint8Array(w * h * 3);
for (let i = 0; i < w * h; i++) { const v = bin.data[i] ? 90 : 255; out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v; }
const px = (x, y, c) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h) return; out.set(c, (y * w + x) * 3); };
const rect = (b, c) => { for (let x = b[0]; x <= b[2]; x++) { px(x, b[1], c); px(x, b[3], c); } for (let y = b[1]; y <= b[3]; y++) { px(b[0], y, c); px(b[2], y, c); } };
const comp = (id, c) => { const k = res.comps[id]; if (!k) return; for (let y = k.y0; y <= k.y1; y++) for (let x = k.x0; x <= k.x1; x++) if (res.labels[y * w + x] === id) px(x, y, c); };
for (const st of res.staves) {
  for (let k = 0; k < 5; k++) for (let x = st.x0; x <= st.x1; x += 2) px(x, lineY(st, k, x), [0, 120, 255]);
  if (st.clef.box) rect(st.clef.box, [255, 140, 0]);
  for (const b of st.bars) for (let y = lineY(st, 0, b.x); y < lineY(st, 4, b.x); y++) px(b.x, y, [0, 200, 200]);
  for (const id of st.key.ids) comp(id, [230, 180, 0]);
}
for (const n of res.notes) {
  rect(n.box.map(Math.round), n.kind === 'black' ? [0, 170, 0] : [220, 0, 0]);
  if (n.stem) for (let y = Math.min(n.y, n.stem.tip); y < Math.max(n.y, n.stem.tip); y++) px(n.stem.x, y, [160, 0, 200]);
  if (n.accid) n.accid.ids.forEach((id) => comp(id, [255, 0, 255]));
}
for (const m of r.misses) rect([m.u - 10, m.v - 8, m.u + 10, m.v + 8].map(Math.round), [255, 0, 0]);
let img = { w, h, data: out };
if (crop.length === 4) {
  const [x0, y0, x1, y1] = crop.map(Number), cw = x1 - x0, ch = y1 - y0, d = new Uint8Array(cw * ch * 3);
  for (let y = 0; y < ch; y++) d.set(out.subarray(((y + y0) * w + x0) * 3, ((y + y0) * w + x1) * 3), y * cw * 3);
  img = { w: cw, h: ch, data: d };
}
fs.writeFileSync(`/tmp/ss_${name}_${cond}.png`, encodeRGB(img));
console.log(`/tmp/ss_${name}_${cond}.png`);

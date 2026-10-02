// Experiment: would a small learned glyph classifier beat the hand-written rules?
//   node tools/make_glyphset.mjs 120 /tmp/glyphset     (training pages, disjoint from fixtures)
//   bun tools/glyphnet.mjs [/tmp/glyphset] [epochs]
// Samples are cut from the page as the pipeline sees it (normalized, binarized, staff lines in)
// around the components that make up each truth glyph, after random photo degradation. A
// 960 -> 96 -> 48 -> 12 MLP (plain JS, Adam) learns them. It is then compared with the rules
// on the evaluation fixtures (other tunes) under the four standard conditions: note accidentals
// read, key signatures read, and false accidentals on everything else.
import fs from 'fs';
import { decodeGray } from '../png.js';
import { normalize, analyze, lineY } from '../omr.js';
import { degrade, CONDITIONS } from '../degrade.js';
import { FIXTURES, loadFixture } from '../eval.js';

const DIR = process.argv[2] || '/tmp/glyphset', EPOCHS = +(process.argv[3] || 25);
export const LABELS = ['sharp', 'flat', 'natural', 'dsharp', 'dflat', 'head', 'hollow', 'rest2', 'rest4', 'rest8', 'rest16', 'other'];
const ACC = { sharp: 1, flat: -1, natural: 0, dsharp: 2, dflat: -2 };
let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// 24 x 40 crop: 3 x 5 staff spaces around the box centre, 2x2 averaged (space = 16 px)
export const GW = 24, GH = 40, NF = GW * GH + 2;
export function crop(bin, box) {
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2, x0 = Math.round(cx - 24), y0 = Math.round(cy - 40), f = new Float32Array(NF);
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    let s = 0; for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const X = x0 + 2 * x + dx, Y = y0 + 2 * y + dy; if (X >= 0 && Y >= 0 && X < bin.w && Y < bin.h) s += bin.data[Y * bin.w + X]; }
    f[y * GW + x] = s / 4;
  }
  f[GW * GH] = (box[2] - box[0]) / 16; f[GW * GH + 1] = (box[3] - box[1]) / 16;
  return f;
}
// components of the final labelling whose centre lies inside a (normalized) truth box
function groupBox(res, tb, pad = 3) {
  let b = null; const ids = [];
  for (const c of res.comps) if (c && c.cx >= tb[0] - pad && c.cx <= tb[2] + pad && c.cy >= tb[1] - pad && c.cy <= tb[3] + pad && c.x1 - c.x0 < 3 * 16 && c.y1 - c.y0 < 5 * 16) {
    ids.push(c.id); b = b ? [Math.min(b[0], c.x0), Math.min(b[1], c.y0), Math.max(b[2], c.x1), Math.max(b[3], c.y1)] : [c.x0, c.y0, c.x1, c.y1];
  }
  return b && { box: b, ids };
}
function pageSamples(img, boxes, cond, ignore = []) {
  const { img: ph, fwd } = degrade(img, cond);
  const norm = normalize(ph); let res; try { res = analyze(norm); } catch (e) { return []; }
  const [a, b, c, d, e, f] = norm.A, det = a * e - b * d;
  const toN = (x, y) => { const [u, v] = fwd(x, y); return [(e * (u - c) - b * (v - f)) / det, (-d * (u - c) + a * (v - f)) / det]; };
  const out = [], used = new Set();
  for (const q of boxes) {
    const p0 = toN(q.box[0], q.box[1]), p1 = toN(q.box[2], q.box[3]);
    const g = groupBox(res, [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])]);
    if (!g) continue; g.ids.forEach((i) => used.add(i));
    out.push({ x: crop(norm.bin, g.box), y: LABELS.indexOf(q.cls === 'rest1' ? 'rest2' : q.cls === 'rest32' ? 'rest16' : q.cls), meta: q });
  }
  for (const q of ignore) { const p0 = toN(q[0], q[1]), p1 = toN(q[2], q[3]); const g = groupBox(res, [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])]); if (g) g.ids.forEach((i) => used.add(i)); }
  // negatives: symbol-sized components near a staff that belong to no truth glyph
  for (const c of res.comps) {
    if (!c || used.has(c.id)) continue;
    const W = (c.x1 - c.x0) / 16, H = (c.y1 - c.y0) / 16;
    if (W < 0.2 || H < 0.2 || W > 3 || H > 5 || rnd() > 0.5) continue;
    if (!res.staves.some((st) => c.cy > st.band[0] && c.cy < st.band[1])) continue;
    out.push({ x: crop(norm.bin, [c.x0, c.y0, c.x1, c.y1]), y: LABELS.indexOf('other') });
  }
  return { samples: out, res, norm, toN };
}
function randomCond() {
  const k = rnd();
  if (k < 0.2) return {};
  return { rot: (rnd() - 0.5) * 8, keystone: rnd() * 0.08, curl: rnd() * 12, scale: 0.8 + rnd() * 0.5, blur: 1, noise: 4 + rnd() * 12, light: rnd() * 0.5, paper: 210 + rnd() * 40, ink: 20 + rnd() * 40, seed: Math.floor(rnd() * 1e6) };
}

// ---------------------------------------------------------------- MLP (as StaffInk's train.js)
function layer(nin, nout) { const W = new Float32Array(nin * nout), s = Math.sqrt(2 / nin); for (let i = 0; i < W.length; i++) W[i] = gauss() * s; return { nin, nout, W, b: new Float32Array(nout), gW: new Float32Array(nin * nout), gb: new Float32Array(nout), mW: new Float32Array(nin * nout), vW: new Float32Array(nin * nout), mb: new Float32Array(nout), vb: new Float32Array(nout) }; }
export function forward(net, x) {
  let h = x;
  net.forEach((L, li) => { const a = new Float32Array(L.nout); for (let o = 0; o < L.nout; o++) { let v = L.b[o]; const r = o * L.nin; for (let i = 0; i < L.nin; i++) v += L.W[r + i] * h[i]; a[o] = li < net.length - 1 ? Math.max(0, v) : v; } h = a; });
  const mx = Math.max(...h), z = h.reduce((s, v) => s + Math.exp(v - mx), 0);
  return Array.from(h, (v) => Math.exp(v - mx) / z);
}
function train(S) {
  const net = [layer(NF, 96), layer(96, 48), layer(48, LABELS.length)], B = 32, wd = 3e-5;
  const acts = net.map((L) => new Float32Array(L.nout)), del = net.map((L) => new Float32Array(L.nout)); let t = 0;
  // class weights: the rare classes matter as much as the 3000 heads
  const cnt = LABELS.map((_, k) => S.filter((s) => s.y === k).length), cw = cnt.map((n) => (n ? Math.min(5, Math.sqrt(S.length / LABELS.length / n)) : 0));
  for (let ep = 0; ep < EPOCHS; ep++) {
    const lr = 1.5e-3 * (ep < EPOCHS * 0.6 ? 1 : ep < EPOCHS * 0.85 ? 0.3 : 0.08);
    const ord = S.map((_, i) => i); for (let i = ord.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [ord[i], ord[j]] = [ord[j], ord[i]]; }
    let loss = 0, ok = 0;
    for (let bi = 0; bi < ord.length; bi += B) {
      for (const L of net) { L.gW.fill(0); L.gb.fill(0); }
      const n = Math.min(B, ord.length - bi);
      for (let k = 0; k < n; k++) {
        const s = S[ord[bi + k]]; let h = s.x;
        net.forEach((L, li) => { const a = acts[li]; for (let o = 0; o < L.nout; o++) { let v = L.b[o]; const r = o * L.nin; for (let i = 0; i < L.nin; i++) v += L.W[r + i] * h[i]; a[o] = li < net.length - 1 ? Math.max(0, v) : v; } h = a; });
        const out = acts[2], mx = Math.max(...out); let z = 0; for (const v of out) z += Math.exp(v - mx);
        loss += -(out[s.y] - mx - Math.log(z)); if (out.indexOf(mx) === s.y) ok++;
        for (let o = 0; o < out.length; o++) del[2][o] = cw[s.y] * (Math.exp(out[o] - mx) / z - (o === s.y ? 1 : 0));
        for (let li = 2; li >= 0; li--) {
          const L = net[li], d = del[li], hin = li ? acts[li - 1] : s.x;
          for (let o = 0; o < L.nout; o++) { const g = d[o]; if (!g) continue; L.gb[o] += g; const r = o * L.nin; for (let i = 0; i < L.nin; i++) L.gW[r + i] += g * hin[i]; }
          if (li) { const dp = del[li - 1]; dp.fill(0); for (let o = 0; o < L.nout; o++) { const g = d[o]; if (!g) continue; const r = o * L.nin; for (let i = 0; i < L.nin; i++) dp[i] += g * L.W[r + i]; } for (let i = 0; i < dp.length; i++) if (acts[li - 1][i] <= 0) dp[i] = 0; }
        }
      }
      t++; const c1 = 1 - 0.9 ** t, c2 = 1 - 0.999 ** t;
      for (const L of net) {
        for (let i = 0; i < L.W.length; i++) { const g = L.gW[i] / n + wd * L.W[i]; L.mW[i] = 0.9 * L.mW[i] + 0.1 * g; L.vW[i] = 0.999 * L.vW[i] + 0.001 * g * g; L.W[i] -= (lr * L.mW[i] / c1) / (Math.sqrt(L.vW[i] / c2) + 1e-8); }
        for (let i = 0; i < L.b.length; i++) { const g = L.gb[i] / n; L.mb[i] = 0.9 * L.mb[i] + 0.1 * g; L.vb[i] = 0.999 * L.vb[i] + 0.001 * g * g; L.b[i] -= (lr * L.mb[i] / c1) / (Math.sqrt(L.vb[i] / c2) + 1e-8); }
      }
    }
    if (ep % 5 === 4 || ep === EPOCHS - 1) console.log(`epoch ${ep + 1} loss ${(loss / S.length).toFixed(3)} train ${(100 * ok / S.length).toFixed(1)}%`);
  }
  return net;
}

// ---------------------------------------------------------------- main
if (process.argv[1]?.endsWith('glyphnet.mjs')) {
  const t0 = performance.now(), S = [];
  const pages = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  for (const f of process.env.LOAD ? [] : pages) {
    const T = JSON.parse(fs.readFileSync(`${DIR}/${f}`)), img = decodeGray(fs.readFileSync(`${DIR}/${f.replace('.json', '.png')}`));
    for (let k = 0; k < 2; k++) { const r = pageSamples(img, T.boxes, randomCond()); if (r.samples) S.push(...r.samples); }
  }
  console.log(`${S.length} samples from ${pages.length} pages in ${((performance.now() - t0) / 1000).toFixed(0)} s:`, LABELS.map((l, k) => `${l} ${S.filter((s) => s.y === k).length}`).join(', '));
  const net = process.env.LOAD ? JSON.parse(fs.readFileSync('/tmp/glyphnet.json')).layers.map((L) => ({ ...L, W: Float32Array.from(L.W), b: Float32Array.from(L.b) })) : train(S);
  const size = net.reduce((s, L) => s + L.W.length + L.b.length, 0);
  console.log(`parameters ${size} (${(size * 4 / 1024).toFixed(0)} KB float32, ~${(size / 1024).toFixed(0)} KB int8)`);

  // evaluation on the fixtures: note accidentals and key signatures, rules vs net
  const mark = (p) => LABELS[p.indexOf(Math.max(...p))];
  for (const cname of ['clean', 'scan', 'photo', 'phone']) {
    let nAcc = 0, rulesAcc = 0, netAcc = 0, nKey = 0, rulesKey = 0, netKey = 0, neg = 0, netFalse = 0, rulesFalse = 0, ms = 0;
    for (const name of FIXTURES) {
      const { img, truth } = loadFixture(name);
      const boxes = truth.notes.filter((n) => n.accid != null && n.accidBox).map((n) => ({ cls: { 1: 'sharp', '-1': 'flat', 0: 'natural', 2: 'dsharp', '-2': 'dflat' }[n.accid], box: n.accidBox, note: n }));
      // heads are known too (not negatives); key signatures are scored separately
      const heads = truth.notes.map((n) => ({ cls: n.type === 'black' ? 'head' : 'hollow', box: [n.x - n.w / 2, n.y - truth.space / 2, n.x + n.w / 2, n.y + truth.space / 2] }));
      const r = pageSamples(img, [...boxes, ...heads], CONDITIONS[cname], truth.staves.map((t) => t.keyBox).filter(Boolean)); if (!r.res) continue;
      const { res, norm, toN } = r;
      for (const s of r.samples) {
        const tq = Date.now(); const p = forward(net, s.x); ms += Date.now() - tq;
        if (s.meta && s.meta.cls in ACC === false) { if (mark(p) in ACC) netFalse++; neg++; continue; }
        if (s.meta) { // a true note accidental: did the rules give the note nearest it that accidental?
          nAcc++; if (mark(p) === s.meta.cls) netAcc++;
          const [u, v] = toN(s.meta.note.x, s.meta.note.y), n = res.notes.reduce((b, q) => (!b || Math.hypot(q.x - u, q.y - v) < Math.hypot(b.x - u, b.y - v) ? q : b), null);
          if (n && Math.hypot(n.x - u, n.y - v) < 10 && n.accid && n.accid.type === ACC[s.meta.cls]) rulesAcc++;
        } else { neg++; if (ACC[mark(p)] !== undefined) { netFalse++; if (process.env.SHOWFP) console.log('fp', name, mark(p), s.x[960].toFixed(2), s.x[961].toFixed(2)); } }
      }
      rulesFalse += res.notes.filter((n) => n.accid).length; // (accidentals the rules attached, for scale)
      // key signatures: group the components inside each staff's truth key box, classify each
      truth.staves.forEach((ts, si) => {
        if (!ts.keyBox || !truth.fifths) return;
        const p0 = toN(ts.keyBox[0], ts.keyBox[1]), p1 = toN(ts.keyBox[2], ts.keyBox[3]);
        const st = res.staves.find((q) => Math.abs(lineY(q, 2, (p0[0] + p1[0]) / 2) - (p0[1] + p1[1]) / 2) < 40); if (!st) return;
        nKey++; if (st.key.detected === truth.fifths) rulesKey++;
        const comps = res.comps.filter((c) => c && c.cx > p0[0] - 2 && c.cx < p1[0] + 2 && c.cy > Math.min(p0[1], p1[1]) - 4 && c.cy < Math.max(p0[1], p1[1]) + 4 && c.n > 8).sort((a, b) => a.x0 - b.x0);
        // merge pieces with overlapping columns (a sharp cut by staff lines)
        const glyphs = [];
        for (const c of comps) { const g = glyphs.find((q) => Math.min(q[2], c.x1) - Math.max(q[0], c.x0) > 2 || (c.x0 - q[2] <= 2 && (q[2] - q[0] < 6 || c.x1 - c.x0 < 6) && c.x0 >= q[0])); if (g) { g[0] = Math.min(g[0], c.x0); g[1] = Math.min(g[1], c.y0); g[2] = Math.max(g[2], c.x1); g[3] = Math.max(g[3], c.y1); } else glyphs.push([c.x0, c.y0, c.x1, c.y1]); }
        const reads = glyphs.map((b) => mark(forward(net, crop(norm.bin, b))));
        const k = reads.filter((x) => x === 'sharp').length - reads.filter((x) => x === 'flat').length;
        if (k === truth.fifths) netKey++; else if (process.env.SHOWKEY) console.log('key', cname, name, si, truth.fifths, reads.join(','), glyphs.map((b) => ((b[2] - b[0]) / 16).toFixed(1) + 'x' + ((b[3] - b[1]) / 16).toFixed(1)).join(' '));
      });
    }
    console.log(`${cname.padEnd(6)} note accidentals: rules ${rulesAcc}/${nAcc}, net ${netAcc}/${nAcc} | key signatures: rules ${rulesKey}/${nKey}, net ${netKey}/${nKey} | net false accidentals ${netFalse}/${neg} other symbols | ${(ms / Math.max(1, nAcc + neg)).toFixed(2)} ms/glyph`);
  }
  fs.writeFileSync('/tmp/glyphnet.json', JSON.stringify({ labels: LABELS, layers: net.map((L) => ({ nin: L.nin, nout: L.nout, W: Array.from(L.W), b: Array.from(L.b) })) }));
}

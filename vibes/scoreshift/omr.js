// Optical music recognition for ScoreShift: a classical staff-first pipeline
// (Fujinaga run-lengths -> staff detection -> staff removal -> symbol segmentation),
// limited to what transposition needs: staves, clefs, key signatures, barlines,
// noteheads + stems, accidentals and augmentation dots. Rhythm is never interpreted:
// the page keeps its own layout, so durations do not have to be understood to move notes.
import * as IP from './imgproc.js';
import { CLEFS, readStaff, nameOf, keySigPositions } from './theory.js';

export const TARGET = 16; // staff space (line to line) in normalized pixels
const odd = (n) => (n | 1);

// ---------- normalisation: scale to TARGET space, deskew ----------
export function normalize(gray) {
  const { w, h } = gray;
  const b0 = IP.sauvola(gray, odd(Math.max(15, Math.round(Math.min(w, h) / 40))), 0.15);
  const m0 = IP.staffMetrics(b0);
  if (!(m0.space >= 5) || m0.votes < 20) throw new Error('No staff lines found');
  const f = TARGET / m0.space;
  const ang = IP.estimateSkew(b0);
  const c = Math.cos(ang), s = Math.sin(ang);
  const ow = Math.ceil(f * (w * Math.abs(c) + h * Math.abs(s))), oh = Math.ceil(f * (w * Math.abs(s) + h * Math.abs(c)));
  const ou = ow / 2, ov = oh / 2, cx = w / 2, cy = h / 2;
  // normalized (u,v) -> original (x,y)
  const A = [c / f, -s / f, cx - (c * ou - s * ov) / f, s / f, c / f, cy - (s * ou + c * ov) / f];
  const src = f < 1 ? IP.boxBlur(gray, Math.round(0.5 / f - 0.5)) : gray;
  const g = IP.resampleAffine(src, ow, oh, A, 255);
  const noise = IP.noiseSigma(g);
  const bin = IP.sauvola(g, 41, 0.2, 'wolf', noise > 3 ? 1 : 0);
  const m = IP.staffMetrics(bin);
  return { g, bin, A, scale: f, angle: ang, noise, space: m.space, thick: Math.max(1, m.thick) };
}

// ---------- staves ----------
export function lineY(st, k, x) {
  const P = st.pts;
  if (x <= P[0].x) return P[0].ys[k] + (P.length > 1 ? (x - P[0].x) * st.slope[k] : 0);
  if (x >= P[P.length - 1].x) return P[P.length - 1].ys[k] + (P.length > 1 ? (x - P[P.length - 1].x) * st.slope[k] : 0);
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (P[mid].x <= x) lo = mid; else hi = mid; }
  const t = (x - P[lo].x) / (P[hi].x - P[lo].x);
  return P[lo].ys[k] + (P[hi].ys[k] - P[lo].ys[k]) * t;
}
// y of staff position p (0 = bottom line, 8 = top line), extrapolated beyond the staff
export function yOfP(st, p, x) { const y0 = lineY(st, 0, x), y4 = lineY(st, 4, x); return y4 - (p * (y4 - y0)) / 8; }
export function pOfY(st, y, x) { const y0 = lineY(st, 0, x), y4 = lineY(st, 4, x); return ((y4 - y) * 8) / (y4 - y0); }
export const spaceAt = (st, x) => (lineY(st, 4, x) - lineY(st, 0, x)) / 4;

export function findStaves(bin, S, t) {
  const { w, h, data } = bin, SW = Math.round(4 * S), step = Math.round(2 * S), groups = [];
  const maxTh = Math.max(3 * t, t + 4), proj = new Int32Array(h);
  for (let x0 = 0; x0 + SW <= w; x0 += step) {
    proj.fill(0);
    for (let y = 0; y < h; y++) { let n = 0; const r = y * w; for (let x = x0; x < x0 + SW; x++) n += data[r + x]; proj[y] = n; }
    const thr = 0.65 * SW, lines = [];
    for (let y = 0; y < h; y++) {
      if (proj[y] < thr) continue;
      let a = y, sw = 0, sy = 0, pk = 0; while (y < h && proj[y] >= thr) { sw += proj[y]; sy += proj[y] * y; pk = Math.max(pk, proj[y]); y++; }
      if (y - a <= maxTh) lines.push({ y: sy / sw, pk });
    }
    // every run of five evenly spaced lines; where there are more (ledger lines next to a
    // staff) keep the run whose lines are most complete
    const seqs = [];
    for (let i = 0; i < lines.length; i++) {
      const seq = [i];
      for (let j = i + 1; j < lines.length && seq.length < 5; j++) {
        const gap = lines[j].y - lines[seq[seq.length - 1]].y;
        if (gap > 1.3 * S) break;
        if (gap >= 0.75 * S) seq.push(j);
      }
      if (seq.length < 5) continue;
      const gaps = [1, 2, 3, 4].map((k) => lines[seq[k]].y - lines[seq[k - 1]].y);
      if (Math.max(...gaps) / Math.min(...gaps) > 1.3) continue;
      seqs.push({ seq, score: seq.reduce((a, k) => a + Math.min(lines[k].pk, SW), 0) - 0.1 * Math.abs(gaps[0] + gaps[3] - gaps[1] - gaps[2]) });
    }
    seqs.sort((a, b) => b.score - a.score);
    const used = new Set();
    for (const q of seqs) {
      if (q.seq.some((k) => used.has(k))) continue;
      q.seq.forEach((k) => used.add(k));
      groups.push({ x: x0 + SW / 2, ys: q.seq.map((k) => lines[k].y) });
    }
  }
  groups.sort((a, b) => a.x - b.x);
  // link groups across slices
  let staves = [];
  for (const g of groups) {
    let best = null, bd = 0.6 * S;
    for (const s of staves) {
      const last = s.pts[s.pts.length - 1];
      if (g.x === last.x) continue;
      const d = Math.abs(g.ys[2] - last.ys[2]);
      if (d < bd) { bd = d; best = s; }
    }
    if (best) best.pts.push(g); else staves.push({ pts: [g] });
  }
  const span = (s) => s.pts[s.pts.length - 1].x - s.pts[0].x;
  staves = staves.filter((s) => s.pts.length >= 3 && span(s) >= 8 * S);
  for (const s of staves) {
    const P = s.pts, n = P.length;
    // end slopes from a least-squares fit over the outer few points
    s.slope = [0, 1, 2, 3, 4].map((k) => {
      const q = P.length > 6 ? P.slice(0, 3).concat(P.slice(-3)) : P;
      const mx = q.reduce((a, p) => a + p.x, 0) / q.length, my = q.reduce((a, p) => a + p.ys[k], 0) / q.length;
      let sxx = 0, sxy = 0; for (const p of q) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.ys[k] - my); }
      return sxx ? sxy / sxx : 0;
    });
    const has = (x) => {
      let c = 0;
      for (let k = 0; k < 5; k++) {
        const y = Math.round(lineY(s, k, x)); let hit = 0;
        for (let dy = -Math.ceil(t) - 1; dy <= Math.ceil(t) + 1; dy++) if (y + dy >= 0 && y + dy < h && data[(y + dy) * w + x]) hit = 1;
        c += hit;
      }
      return c >= 3;
    };
    // walk outwards along the lines, tolerating short breaks (binarisation gaps in photos)
    const tol = Math.round(1.0 * S);
    let x1 = Math.min(w - 1, Math.round(P[n - 1].x)), miss = 0, last1 = x1;
    while (x1 < w - 1 && miss <= tol) { x1++; if (has(x1)) { miss = 0; last1 = x1; } else miss++; }
    let x0 = Math.max(0, Math.round(P[0].x)), last0 = x0; miss = 0;
    while (x0 > 0 && miss <= tol) { x0--; if (has(x0)) { miss = 0; last0 = x0; } else miss++; }
    s.x0 = last0 + 1; s.x1 = last1 - 1;
  }
  // stacked ledger lines over a run of high (low) notes also look like five lines: such a
  // "staff" sits one space above (below) a real one and is shorter
  const onLedgers = (s, o) => {
    const x = s.pts[0].x, up = (lineY(o, 0, x) - s.pts[0].ys[4]) / S, dn = (s.pts[0].ys[0] - lineY(o, 4, x)) / S;
    const ok = (d) => d > -0.3 && d < 6.5 && Math.abs(d - Math.round(d)) < 0.25;
    return ok(up) || ok(dn);
  };
  staves = staves.filter((s) => !staves.some((o) => o !== s && span(o) > 1.5 * span(s) && o.pts[0].x < s.pts[s.pts.length - 1].x && s.pts[0].x < o.pts[o.pts.length - 1].x && onLedgers(s, o)));
  staves.sort((a, b) => a.pts[0].ys[0] - b.pts[0].ys[0]);
  // drop duplicates (same staff found twice, e.g. a few slices that took a beam or hairpin
  // above it as the top line): the one supported by the most slices wins
  const bySupport = staves.slice().sort((a, b) => b.pts.length - a.pts.length);
  const keep = bySupport.filter((s, i) => !bySupport.some((o, j) => j < i && Math.abs(lineY(o, 2, s.x0) - lineY(s, 2, s.x0)) < 2 * S && o.x0 < s.x1 && s.x0 < o.x1));
  return staves.filter((s) => keep.includes(s));
}

// Clear thin vertical runs crossing a horizontal guide y(x) on [xa, xb].
function clearThinRuns(img, xa, xb, yAt, t, orig = img.data) {
  const { w, h, data } = img, maxRun = Math.ceil(t) + 2, win = Math.ceil(t * 0.5) + 1, cleared = [];
  for (let x = Math.max(0, Math.round(xa)); x <= Math.min(w - 1, Math.round(xb)); x++) {
    const yc = Math.round(yAt(x));
    for (let y = yc - win; y <= yc + win; y++) {
      if (y < 0 || y >= h || !data[y * w + x]) continue;
      let a = y, b = y;
      while (a > 0 && data[(a - 1) * w + x]) a--;
      while (b < h - 1 && data[(b + 1) * w + x]) b++;
      if (b - a + 1 <= maxRun) { for (let yy = a; yy <= b; yy++) { data[yy * w + x] = 0; cleared.push(yy * w + x); } }
      y = b;
    }
  }
  return cleared;
}
export function removeStaves(bin, staves, t) {
  const out = { w: bin.w, h: bin.h, data: new Uint8Array(bin.data) };
  for (const st of staves) for (let k = 0; k < 5; k++) clearThinRuns(out, st.x0 - 2, st.x1 + 2, (x) => lineY(st, k, x), t, bin.data);
  return out;
}

// ---------- symbol helpers ----------
export function compMask(labels, w, c) { // binary mask of a component (or a group: c.ids)
  const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1, m = new Uint8Array(cw * ch), ids = c.ids || [c.id];
  for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (ids.includes(labels[y * w + x])) m[(y - c.y0) * cw + x - c.x0] = 1;
  return { m, cw, ch };
}

// Vertical strokes (columns whose longest run >= minLen), grouped.
export function strokes(mask, minLen, gapMax = 0) {
  const { m, cw, ch } = mask, cols = [];
  for (let x = 0; x < cw; x++) {
    // longest run in the column, bridging gaps of up to gapMax px (strokes broken in photos)
    let best = 0, bt = 0, start = -1, last = -1;
    for (let y = 0; y < ch; y++) {
      if (!m[y * cw + x]) continue;
      if (start < 0 || y - last - 1 > gapMax) start = y;
      last = y;
      if (last - start + 1 > best) { best = last - start + 1; bt = start; }
    }
    cols.push(best >= minLen ? { x, top: bt, bot: bt + best - 1 } : null);
  }
  const out = [];
  for (let x = 0; x < cw; x++) {
    if (!cols[x]) continue;
    const s = { x0: x, x1: x, top: cols[x].top, bot: cols[x].bot };
    while (x + 1 < cw && cols[x + 1]) { x++; s.x1 = x; s.top = Math.min(s.top, cols[x].top); s.bot = Math.max(s.bot, cols[x].bot); }
    out.push(s);
  }
  return out;
}

// Accidental classifier from stroke structure. Returns { type: alter, ref: y of the pitch it marks } or null.
export function classifyAccidental(labels, w, c, S, t = 0.13 * S) {
  const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1, W = cw / S, H = ch / S;
  if (W < 0.3 || W > 2.2 || H < 0.5 || H > 3.8) return null;
  const mask = compMask(labels, w, c), st = strokes(mask, 1.1 * S, Math.round(0.15 * S + t)) // gaps: photo breaks + removed staff lines.filter((s) => s.x1 - s.x0 + 1 <= 0.35 * S + 1);
  const fill = c.n / (cw * ch);
  if (st.length === 0) {
    // double sharp: small square X, centre ink, edge midpoints empty
    if (W > 0.55 && W < 1.3 && H > 0.55 && H < 1.3 && fill < 0.75) {
      const { m } = mask, at = (fx, fy) => m[Math.min(ch - 1, Math.round(fy * (ch - 1))) * cw + Math.min(cw - 1, Math.round(fx * (cw - 1)))];
      if (at(0.5, 0.5) && !at(0.5, 0.05) && !at(0.05, 0.5) && at(0.1, 0.1) && at(0.9, 0.9)) return { type: 2, ref: (c.y0 + c.y1) / 2 };
    }
    return null;
  }
  if (H < 1.6) return null;
  // ink right of the first stroke, top vs bottom half: flats are bottom-heavy (bowl)
  const right = (s) => {
    let top = 0, bot = 0; const { m } = mask;
    for (let y = 0; y < ch; y++) for (let x = s.x1 + 2; x < cw; x++) if (m[y * cw + x]) { if (y < ch * 0.55) top++; else bot++; }
    return { top, bot };
  };
  // a flat's bowl can read as a short second stroke: only strokes near full height count
  let stv = st;
  if (st.length >= 2) { const L0 = Math.max(...st.map((s) => s.bot - s.top)); stv = st.filter((s) => s.bot - s.top >= 0.6 * L0); }
  if (stv.length === 1) {
    const s = stv[0], r = right(s);
    if (s.x0 <= 0.3 * cw && r.bot > 1.5 * r.top && W >= 0.45 && W <= 1.3 && H >= 1.8 && H <= 3.4 && s.top <= 0.15 * ch)
      return { type: -1, ref: c.y1 - 0.45 * S };
    return null;
  }
  if (stv.length === 2) {
    const [a, b] = stv, la = a.bot - a.top, lb = b.bot - b.top;
    const ov = Math.min(a.bot, b.bot) - Math.max(a.top, b.top);
    const ra = right(a);
    if (W >= 1.0 && ra.bot > 1.5 * ra.top && Math.abs(a.top - b.top) < 0.4 * S && a.x0 <= 0.2 * cw) return { type: -2, ref: c.y1 - 0.45 * S };
    if (H < 2.0 || H > 3.8) return null;
    if (b.top - a.top > 0.35 * S && b.bot - a.bot > 0.35 * S && ov < 0.85 * Math.min(la, lb)) return { type: 0, ref: (c.y0 + c.y1) / 2 };
    if (ov >= 0.7 * Math.min(la, lb) && W >= 0.55 && W <= 1.9) return { type: 1, ref: (c.y0 + c.y1) / 2 };
  }
  return null;
}

// Clef from a tall component near the start of the staff.
function classifyClef(c, st, labels, w) {
  const xm = (c.x0 + c.x1) / 2, y0 = lineY(st, 0, xm), y4 = lineY(st, 4, xm), s = (y4 - y0) / 4;
  const top = (y0 - c.y0) / s, bot = (c.y1 - y4) / s, H = (c.y1 - c.y0 + 1) / s;
  if (H >= 5 && top >= 0.6 && bot >= 0.5) return 'treble';
  if (H >= 2.2 && H < 5 && top > -0.7 && top < 1.4) {
    // C clefs stand on a solid bar as tall as the clef; the F clef is a curl
    const st2 = strokes(compMask(labels, w, c), 0.8 * (c.y1 - c.y0 + 1));
    if (st2.length && H >= 3.4) return top >= 0.6 && bot < -0.4 ? 'tenor' : 'alto';
    if (bot < -0.2 && H < 4.2) return 'bass';
  }
  return H >= 5 ? 'treble' : null;
}

// ---------- full analysis ----------
export function analyze(norm, opts = {}) {
  const { bin } = norm, { w, h } = bin;
  const S0 = norm.space, t = norm.thick;
  const staves = findStaves(bin, S0, t);
  if (!staves.length) throw new Error('No staves detected');
  const sym0 = removeStaves(bin, staves, t);
  const bandOf = (st, i) => {
    const prev = staves[i - 1], next = staves[i + 1], xm = (st.x0 + st.x1) / 2;
    const top = prev ? (lineY(prev, 4, xm) + lineY(st, 0, xm)) / 2 : lineY(st, 0, xm) - 8 * S0;
    const bot = next ? (lineY(st, 4, xm) + lineY(next, 0, xm)) / 2 : lineY(st, 4, xm) + 8 * S0;
    return [Math.max(0, top), Math.min(h - 1, bot)];
  };
  staves.forEach((st, i) => { st.index = i; st.band = bandOf(st, i); st.notes = []; st.bars = []; });
  const staffAt = (x, y) => staves.find((st) => x >= st.x0 - S0 && x <= st.x1 + S0 && y >= st.band[0] && y < st.band[1]);

  // components before ledger removal (for clefs). Scanned systems often have the clefs touching
  // the system bracket or the barline at the start of the staff, making clef + bracket one
  // component spanning the whole system. Cut long vertical runs in the clef zone first: runs
  // longer than any clef anywhere in it, and long ones at the very start of the staff.
  // Only components too big to be a clef are cut, so a clef standing alone (a C clef's bars
  // also span the staff) is never touched.
  const clefImg = { w, h, data: new Uint8Array(sym0.data) };
  const c0 = IP.components(sym0), big = new Uint8Array(c0.comps.length);
  for (const c of c0.comps) if (c && (c.y1 - c.y0 > 8.5 * S0 || c.x1 - c.x0 > 4 * S0)) big[c.id] = 1;
  for (const st of staves) {
    const [b0, b1] = st.band;
    for (let x = Math.max(0, Math.round(st.x0 - 3 * S0)); x <= Math.min(w - 1, Math.round(st.x0 + 4.5 * S0)); x++) {
      const lim = x < st.x0 + 1.5 * S0 ? 3.5 * S0 : 9 * S0; // (the opening barline spans 4 spaces)
      for (let y = Math.max(0, Math.round(b0 - 6 * S0)); y < Math.min(h, Math.round(b1 + 6 * S0)); y++) {
        if (!clefImg.data[y * w + x] || !big[c0.labels[y * w + x]]) continue;
        let e = y; while (e < h && sym0.data[e * w + x]) e++;
        if (e - y > lim) for (let yy = y; yy < e; yy++) clefImg.data[yy * w + x] = 0;
        y = e;
      }
    }
  }
  let cc = IP.components(clefImg);
  const used = new Set();
  for (const st of staves) {
    // (system brackets and braces are taller than any clef, or a thin line)
    const cands = cc.comps.filter((c) => c && c.x0 < st.x0 + 4.5 * S0 && c.x1 > st.x0 && c.y1 - c.y0 > 2.2 * S0 && c.y1 - c.y0 < 8.5 * S0 &&
      (c.x1 - c.x0 >= 0.8 * S0 || (Math.abs(c.y0 - lineY(st, 0, c.cx)) < 0.6 * S0 && Math.abs(c.y1 - lineY(st, 4, c.cx)) < 0.6 * S0)) && c.cy > st.band[0] && c.cy < st.band[1] && c.x1 - c.x0 < 4 * S0).sort((a, b) => a.x0 - b.x0);
    st.clef = { type: opts.clef || 'treble', detected: null, box: null };
    for (const c of cands) {
      const type = classifyClef(c, st, cc.labels, w);
      if (!type) continue;
      const box = [c.x0, c.y0, c.x1, c.y1], S = spaceAt(st, c.cx);
      // C clefs come in pieces (thick bar, thin bar, the two curls); F clefs have two dots
      const inBox = new Set([c.id]);
      for (let grew = true; grew;) { // repeat: pieces are found left to right in any id order
        grew = false;
        for (const q of cc.comps) {
          if (!q || inBox.has(q.id) || q.x0 < box[0] || q.x0 - box[2] > 1.0 * S || q.y1 < box[1] || q.y0 > box[3]) continue;
          const qh = q.y1 - q.y0 + 1, qw = q.x1 - q.x0 + 1;
          // a C clef's bars span the staff (~4 spaces); a sharp or natural right after it is
          // ~3 spaces tall and must stay out, or the key signature loses its first glyph
          const span = lineY(st, 4, q.cx) - lineY(st, 0, q.cx);
          if (((type === 'alto' || type === 'tenor') && qh >= 0.85 * span && q.y0 <= lineY(st, 0, q.cx) + 0.3 * S && q.y1 >= lineY(st, 4, q.cx) - 0.3 * S && q.x1 - box[0] < 5 * S) || (type === 'bass' && qh <= 0.8 * S && qw <= 0.8 * S)) {
            box[0] = Math.min(box[0], q.x0); box[1] = Math.min(box[1], q.y0); box[2] = Math.max(box[2], q.x1); box[3] = Math.max(box[3], q.y1);
            inBox.add(q.id); grew = true;
          }
        }
      }
      if (type === 'alto' || type === 'tenor') { // the two curls right of the bars
        const ya = lineY(st, 0, c.cx), yb = lineY(st, 4, c.cx);
        for (const q of cc.comps) {
          if (!q || inBox.has(q.id) || q.x0 < box[2] - 0.2 * S || q.x1 > box[0] + 3.2 * S || q.y0 < ya - 0.5 * S || q.y1 > yb + 0.5 * S) continue;
          if (q.y1 - q.y0 < 0.5 * S || classifyAccidental(cc.labels, w, q, S, t)) continue;
          box[2] = Math.max(box[2], q.x1); inBox.add(q.id);
        }
      }
      st.clef = { type: opts.clef || type, detected: type, box }; break;
    }
  }

  // ---- filled heads: opening removes stems, beams, lines, thin strokes ----
  const k = Math.max(3, Math.round(0.55 * S0));
  const opened = IP.open(sym0, k);
  const oc = IP.components(opened);
  const heads = [];
  for (const b of oc.comps) {
    if (!b) continue;
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    const st = staffAt(b.cx, b.cy); if (!st) continue;
    const S = spaceAt(st, b.cx);
    if (bw < 0.75 * S || bh < 0.6 * S || bw > 3 * S || bh > 6.5 * S) continue;
    if (st.clef.box && b.cx < st.clef.box[2] + 0.3 * S && b.cx > st.clef.box[0] - 0.3 * S) continue;
    if (bw > 2.2 * S && bh < 1.5 * S) continue; // beam-ish slab
    // columns: a blob wider than ~1.8 heads is a chord with seconds, analyse halves
    const cols = bw > 1.85 * S ? [[b.x0, Math.round((b.x0 + b.x1) / 2)], [Math.round((b.x0 + b.x1) / 2) + 1, b.x1]] : [[b.x0, b.x1]];
    for (const [cx0, cx1] of cols) {
      const xm = (cx0 + cx1) / 2;
      const pTop = Math.ceil(pOfY(st, b.y1, xm) - 0.3), pBot = Math.floor(pOfY(st, b.y0, xm) + 0.3);
      const sc = [];
      for (let p = pTop; p <= pBot; p++) {
        const yc = yOfP(st, p, xm); let n = 0, tot = 0;
        for (let y = Math.round(yc - 0.3 * S); y <= Math.round(yc + 0.3 * S); y++) for (let x = cx0; x <= cx1; x++) { tot++; if (y >= 0 && y < h && oc.labels[y * w + x] === b.id) n++; }
        sc.push({ p, s: n / tot });
      }
      sc.sort((a, b2) => b2.s - a.s);
      const acc = [];
      for (const q of sc) { if (q.s < 0.55) break; if (acc.some((a) => Math.abs(a.p - q.p) < 2)) continue; acc.push(q); }
      for (const q of acc) {
        const yc = yOfP(st, q.p, xm);
        // row extent of the head at its centre
        let l = Math.round(xm), r = l; const yy = Math.round(yc);
        while (l > cx0 && oc.labels[yy * w + l - 1] === b.id) l--;
        while (r < cx1 && oc.labels[yy * w + r + 1] === b.id) r++;
        if (r - l + 1 < 0.6 * S) continue;
        // a head is about a space tall; a beam slab that survives the opening is ~half that
        const xc = Math.round((l + r) / 2); let u = yy, dn = yy;
        while (u > 0 && oc.labels[(u - 1) * w + xc] === b.id) u--;
        while (dn < h - 1 && oc.labels[(dn + 1) * w + xc] === b.id) dn++;
        if (dn - u + 1 < 0.72 * S) continue;
        heads.push({ st, p: q.p, x: (l + r) / 2, y: yc, box: [l - 1, yc - 0.5 * S, r + 1, yc + 0.5 * S], kind: 'black' });
      }
    }
  }

  // ---- hollow heads: enclosed holes with a thick ring, on the binary with staff lines ----
  const wc = IP.components(bin, 0);
  const holes = [];
  for (const c of wc.comps) {
    if (!c || c.x0 === 0 || c.y0 === 0 || c.x1 === w - 1 || c.y1 === h - 1) continue;
    const hw = c.x1 - c.x0 + 1, hh = c.y1 - c.y0 + 1;
    if (hw > 1.2 * S0 || hh > 0.9 * S0 || hw < 0.15 * S0 || c.n < 3) continue;
    holes.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, n: c.n });
  }
  // merge hole halves split by a staff or ledger line
  holes.sort((a, b) => a.y0 - b.y0);
  for (let i = 0; i < holes.length; i++) {
    const a = holes[i]; if (!a) continue;
    for (let j = i + 1; j < holes.length; j++) {
      const b = holes[j]; if (!b) continue;
      if (b.y0 - a.y1 > t + 3) break;
      const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      if (b.y0 > a.y1 && ov > -0.25 * S0) { // tilted ovals: the halves need not overlap
        a.x0 = Math.min(a.x0, b.x0); a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1); a.n += b.n; a.split = true; holes[j] = null;
      }
    }
  }
  const black = (x, y) => x >= 0 && y >= 0 && x < w && y < h && bin.data[y * w + x] === 1;
  const runFrom = (x, y, dx, dy, max) => { let n = 0; while (n < max && black(x + dx * (n + 1), y + dy * (n + 1))) n++; return n; };
  for (const hl of holes) {
    if (!hl) continue;
    const hw = hl.x1 - hl.x0 + 1, hh = hl.y1 - hl.y0 + 1;
    if (hh > 1.05 * S0 || hw > 1.1 * S0) continue;
    if (hl.n / (hw * hh) > 0.86 && !hl.split) continue; // rectangular pocket between stems and lines, not an oval
    const cx = Math.round((hl.x0 + hl.x1) / 2), cy = Math.round((hl.y0 + hl.y1) / 2);
    const st = staffAt(cx, cy); if (!st) continue;
    const S = spaceAt(st, cx);
    if (st.clef.box && cx <= st.clef.box[2] + 0.2 * S) continue;
    // a row inside the hole (the centre row may be a staff line through it)
    let ry = cy; if (black(cx, ry)) { for (let d = 1; d < hh; d++) { if (!black(cx, cy - d)) { ry = cy - d; break; } if (!black(cx, cy + d)) { ry = cy + d; break; } } }
    let lx = cx; while (lx > hl.x0 && !black(lx - 1, ry)) lx--;
    let rx = cx; while (rx < hl.x1 && !black(rx + 1, ry)) rx++;
    const tl = runFrom(lx, ry, -1, 0, S), tr = runFrom(rx, ry, 1, 0, S);
    const tu = runFrom(cx, hl.y0, 0, -1, S), td = runFrom(cx, hl.y1, 0, 1, S);
    const ow = (rx - lx + 1) + tl + tr, oh = hh + tu + td;
    if (tl < 0.08 * S || tr < 0.08 * S || tl > 0.7 * S || tr > 0.7 * S) continue;
    if (ow < 0.95 * S || ow > 2.3 * S || oh < 0.65 * S || oh > 1.45 * S) continue;
    if (tu > 0.55 * S || td > 0.55 * S) continue;
    const x0 = lx - tl, x1 = rx + tr;
    // flats: the stem rises from the left side of the bowl
    const up = runFrom(x0 + 1, hl.y0, 0, -1, 3 * S), upIn = runFrom(x0 + Math.round(0.15 * S), hl.y0, 0, -1, 3 * S);
    if (Math.max(up, upIn) > 1.3 * S && runFrom(x1 - 1, hl.y0, 0, -1, 3 * S) < 0.8 * S && ow < 1.25 * S) continue;
    const ym = (hl.y0 - tu + hl.y1 + td) / 2, p = Math.round(pOfY(st, ym, cx));
    heads.push({ st, p, x: (x0 + x1) / 2, y: yOfP(st, p, cx), box: [x0, ym - oh / 2, x1, ym + oh / 2], kind: 'hollow' });
  }
  // dedupe
  heads.sort((a, b) => (a.kind === 'hollow' ? 0 : 1) - (b.kind === 'hollow' ? 0 : 1));
  const uniq = [];
  for (const hd of heads) if (!uniq.some((u) => u.st === hd.st && Math.abs(u.x - hd.x) < 0.6 * S0 && Math.abs(u.p - hd.p) < 1)) uniq.push(hd);

  // ---- stems ----
  const maxGap = Math.max(1, Math.round(0.2 * S0));
  const vrun = (x, y, dir) => { // vertical ink from near y in direction dir on sym0, tolerating small gaps and a 1px wobble
    let yy = Math.round(y), gap = 0, last = yy;
    for (; yy >= 0 && yy < h; yy += dir) { if (sym0.data[yy * w + x] || (x > 0 && sym0.data[yy * w + x - 1]) || (x < w - 1 && sym0.data[yy * w + x + 1])) { last = yy; gap = 0; } else if (++gap > maxGap) break; }
    return Math.abs(last - y);
  };
  for (const hd of uniq) {
    const S = spaceAt(hd.st, hd.x); let best = null;
    const tryCol = (x, dir) => {
      if (x < 0 || x >= w) return;
      let y = -1;
      for (let d = 0; d <= Math.round(0.4 * S) && y < 0; d++) for (const sg of [1, -1]) {
        const yy = Math.round(hd.y + sg * d);
        if (yy >= 0 && yy < h && sym0.data[yy * w + x]) { y = yy; break; }
      }
      if (y < 0) return;
      const tip = y + dir * vrun(x, y, dir), len = (tip - hd.y) * dir;
      if (!best || len > best.len) best = { x, len, dir, tip };
    };
    for (let x = Math.round(hd.box[2] - 0.35 * S); x <= Math.round(hd.box[2] + 0.2 * S); x++) tryCol(x, -1);
    for (let x = Math.round(hd.box[0] - 0.2 * S); x <= Math.round(hd.box[0] + 0.35 * S); x++) tryCol(x, 1);
    hd.stem = best && best.len >= 2.0 * S ? best : null;
    if (hd.stem) { // stem is thin: neighbours 0.4S away must not run as long
      const off = Math.round(0.45 * S) * (hd.stem.dir < 0 ? -1 : 1), x2 = hd.stem.x + off;
      if (x2 >= 0 && x2 < w && vrun(x2, hd.y + hd.stem.dir * 0.6 * S, hd.stem.dir) > 0.8 * hd.stem.len) hd.stem = null;
    }
  }
  // a head beyond the staff stands on ledger lines: the first one must be under it
  // (rejects letters of tempo marks, lyrics and dynamics that look like noteheads)
  const ledgerUnder = (hd) => {
    if (hd.p > -3 && hd.p < 11) return true;
    const S = spaceAt(hd.st, hd.x), q = hd.p >= 11 ? 10 : -2, y = Math.round(yOfP(hd.st, q, hd.x));
    for (let dy = -Math.ceil(t) - 1; dy <= Math.ceil(t) + 1; dy++) {
      const yy = y + dy; if (yy < 0 || yy >= h) continue;
      let run = 0, best = 0;
      for (let x = Math.round(hd.box[0] - 0.6 * S); x <= Math.round(hd.box[2] + 0.6 * S); x++) { if (x >= 0 && x < w && bin.data[yy * w + x]) { run++; best = Math.max(best, run); } else run = 0; }
      if (best >= 0.9 * (hd.box[2] - hd.box[0])) return true;
    }
    return false;
  };
  let notes = uniq.filter((hd) => (hd.kind === 'hollow' || hd.stem) && ledgerUnder(hd));
  // a stem carries one duration: a "half note" sharing its stem with black heads is the
  // loop of a curly flag
  // loop of a curly flag: a "half note" sharing a stem with black heads, or threaded on one
  notes = notes.filter((n) => n.kind === 'black' || !notes.some((o) => o.kind === 'black' && o.stem && o.st === n.st &&
    ((n.stem && Math.abs(o.stem.x - n.stem.x) <= 0.35 * S0) ||
     (o.stem.x >= n.box[0] - 0.45 * S0 && o.stem.x <= n.box[2] + 0.45 * S0 && n.y > Math.min(o.y, o.stem.tip) + 0.5 * S0 && n.y < Math.max(o.y, o.stem.tip) + 0.3 * S0))));
  for (const n of notes) n.kind = n.kind === 'black' ? 'black' : n.stem ? 'half' : 'whole';

  // ---- ledger lines around heads beyond the staff, then final components ----
  const sym = { w, h, data: new Uint8Array(sym0.data) };
  const ledgerPx = [];
  for (const n of notes) {
    const S = spaceAt(n.st, n.x), qs = [];
    if (n.p <= -2) for (let q = -2; q >= n.p - 1; q -= 2) qs.push(q);
    if (n.p >= 10) for (let q = 10; q <= n.p + 1; q += 2) qs.push(q);
    n.ledgers = qs;
    for (const q of qs) ledgerPx.push(...clearThinRuns(sym, n.box[0] - 1.8 * S, n.box[2] + 0.7 * S, (x) => yOfP(n.st, q, x), t));
  }
  cc = IP.components(sym);
  const L = cc.labels;
  const labelNear = (x, y, r) => {
    for (let d = 0; d <= r; d++) for (let dy = -d; dy <= d; dy++) for (let dx = -d; dx <= d; dx++) {
      const xx = Math.round(x + dx), yy = Math.round(y + dy);
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && L[yy * w + xx]) return L[yy * w + xx];
    }
    return 0;
  };
  for (const n of notes) n.comp = labelNear(n.x, n.y, Math.round(0.4 * S0)) || labelNear(n.box[2], n.y, 2);
  // whole notes / time-signature digits: a stemless ring must be its own small component
  notes = notes.filter((n) => {
    if (n.kind !== 'whole') return true;
    const c = cc.comps[n.comp]; if (!c) return false;
    const S = spaceAt(n.st, n.x);
    return c.y1 - c.y0 < 1.7 * S && c.x1 - c.x0 < 3 * S;
  });
  // holes inside sharps, naturals and double sharps pass the ring test: drop those
  notes = notes.filter((n) => {
    const c = cc.comps[n.comp]; if (!c) return n.kind === 'black';
    const S = spaceAt(n.st, n.x), a = classifyAccidental(L, w, c, S, t);
    if (a && a.type >= 0) return false; // also filled: a sharp's crossings survive the opening in heavy scans
    if (n.kind === 'black') return true;
    // time-signature digits: two spaces tall, hanging from the top line or standing on the bottom one
    const ch = c.y1 - c.y0 + 1, ya = lineY(n.st, 0, n.x), yb = lineY(n.st, 4, n.x);
    if (ch > 1.6 * S && ch < 2.4 * S && (Math.abs(c.y0 - ya) < 0.35 * S || Math.abs(c.y1 - yb) < 0.35 * S) && c.x1 - c.x0 > 1.0 * S) return false;
    return true;
  });
  const headComps = new Set(notes.map((n) => n.comp));

  // ---- other symbols per staff ----
  // Staff removal cuts a flat where its thin bowl joins the stem on a line: re-pair a thin
  // tall stroke with the bowl fragment hugging its right side (lower part).
  const groups = new Map();
  for (const c of cc.comps) if (c && !headComps.has(c.id)) groups.set(c.id, { ...c, ids: [c.id] });
  const isStroke = (g) => g.x1 - g.x0 + 1 <= 0.45 * S0 && g.y1 - g.y0 + 1 >= 1.5 * S0;
  // a half of a sharp or natural whose crossbars were erased with thick staff lines keeps
  // stubs of them, so it can be most of a space wide
  const isHalf = (g) => g.x1 - g.x0 + 1 <= 0.95 * S0 && g.y1 - g.y0 + 1 >= 1.8 * S0 && g.y1 - g.y0 + 1 <= 3.8 * S0;
  for (const g of groups.values()) {
    if (!(isStroke(g) || isHalf(g)) || g.merged) continue;
    for (const q of groups.values()) {
      if (q === g || q.merged || q.x0 - g.x1 < 0 || q.x0 - g.x1 > 0.6 * S0 || q.x1 - q.x0 > 1.4 * S0) continue;
      const ov = Math.min(g.y1, q.y1) - Math.max(g.y0, q.y0);
      const bowl = isStroke(g) && q.y0 >= g.y0 + 0.4 * S0 && q.y1 <= g.y1 + 0.3 * S0 && q.x0 - g.x1 <= 0.3 * S0; // flat: bowl fragment
      const pair = (isStroke(q) || isHalf(q)) && ov > 0.6 * Math.min(g.y1 - g.y0, q.y1 - q.y0) && q.x1 - g.x0 <= 1.9 * S0; // sharp / natural halves
      if (!bowl && !pair) continue;
      const m = { ...g, ids: [...g.ids, ...q.ids], x1: Math.max(g.x1, q.x1), y0: Math.min(g.y0, q.y0), y1: Math.max(g.y1, q.y1), n: g.n + q.n, cx: (g.cx * g.n + q.cx * q.n) / (g.n + q.n), cy: (g.cy * g.n + q.cy * q.n) / (g.n + q.n) };
      const a = classifyAccidental(L, w, m, S0, t);
      if (a && (bowl ? a.type < 0 : a.type >= 0)) { Object.assign(g, m); q.merged = true; break; }
    }
  }
  for (const [k, g] of groups) if (g.merged) groups.delete(k);
  const accs = [], dots = [];
  for (const c of groups.values()) {
    if (!c || headComps.has(c.id)) continue;
    const st = staffAt(c.cx, c.cy); if (!st) continue;
    const S = spaceAt(st, c.cx), cw = c.x1 - c.x0 + 1, chh = c.y1 - c.y0 + 1;
    if (st.clef.box && c.x1 <= st.clef.box[2] + 0.2 * S) continue;
    const ya = lineY(st, 0, c.cx), yb = lineY(st, 4, c.cx);
    if (cw <= 0.75 * S && c.y0 <= ya + 0.4 * S && c.y1 >= yb - 0.4 * S && c.n / chh <= Math.max(0.35 * S, 2.5 * t) && c.n / chh >= 0.6 * t &&
      (chh <= (yb - ya) + 1.2 * S || staves.some((o) => o !== st && (c.y1 >= lineY(o, 0, c.cx) || c.y0 <= lineY(o, 4, c.cx)) && Math.abs(lineY(o, 2, c.cx) - lineY(st, 2, c.cx)) < 20 * S))) { // thin; may span a whole system
      for (const o of staves) { // a system barline counts for every staff it crosses
        if (c.cx < o.x0 - S || c.cx > o.x1 + S) continue;
        if (c.y0 <= lineY(o, 0, c.cx) + 0.4 * S && c.y1 >= lineY(o, 4, c.cx) - 0.4 * S) o.bars.push({ x: c.cx, x0: c.x0, x1: c.x1, ids: c.ids });
      }
      continue;
    }
    const a = classifyAccidental(L, w, c, S, t);
    if (a) { accs.push({ st, c, ...a, p: Math.round(pOfY(st, a.ref, c.cx)) }); continue; }
    if (cw >= 0.2 * S && cw <= 0.75 * S && chh >= 0.2 * S && chh <= 0.75 * S && c.n / (cw * chh) > 0.5) dots.push({ st, c });
  }
  for (const st of staves) {
    st.bars.sort((a, b) => a.x - b.x);
    st.bars = st.bars.filter((b, i, arr) => !(i > 0 && b.x - arr[i - 1].x < 1.5 * S0)); // double / final bar = one
  }

  // key signature: accidentals right after the clef, same type, closely spaced
  for (const st of staves) {
    const S = spaceAt(st, st.x0 + 4 * S0);
    const firstNote = Math.min(...notes.filter((n) => n.st === st).map((n) => n.box[0]), st.x1);
    let x = st.clef.box ? st.clef.box[2] : st.x0 + 2 * S;
    const mine = accs.filter((a) => a.st === st && a.c.x0 > x - 0.3 * S && a.c.x1 < firstNote && (a.type === 1 || a.type === -1)).sort((a, b) => a.c.x0 - b.c.x0);
    const key = [];
    for (const a of mine) {
      if (a.c.x0 - x > 2.0 * S || key.length >= 7) break;
      if (key.length && a.type !== key[0].type) break;
      // key signature glyphs are evenly spaced; a wider jump is the time signature or the music
      if (key.length >= 2) { const d = (key[key.length - 1].c.x0 - key[0].c.x0) / (key.length - 1); if (a.c.x0 - key[key.length - 1].c.x0 > 1.4 * d) break; }
      key.push(a); x = a.c.x1;
    }
    // keep the prefix whose glyphs sit where a key signature puts them
    const clef = CLEFS[st.clef.type];
    if (key.length) {
      const exp = keySigPositions(clef, key[0].type * key.length);
      let n = 0; while (n < key.length && Math.abs(key[n].p - exp[n]) <= 1) n++;
      key.length = n;
    }
    key.forEach((a) => (a.isKey = true));
    st.key = { fifths: opts.fifths ?? (key.length ? key[0].type * key.length : 0), detected: key.length ? key[0].type * key.length : 0,
      ids: key.flatMap((a) => a.c.ids), idsPer: key.map((a) => a.c.ids), glyphs: key.map((a) => ({ p: a.p, box: [a.c.x0, a.c.y0, a.c.x1, a.c.y1] })), x0: st.clef.box ? st.clef.box[2] + 1 : st.x0 + 2 * S, x1: key.length ? key[key.length - 1].c.x1 : (st.clef.box ? st.clef.box[2] + 1 : st.x0 + 2 * S) };
  }

  // local accidentals: nearest head to the right at the same position
  for (const a of accs) {
    if (a.isKey) continue;
    const S = spaceAt(a.st, a.c.cx);
    let best = null, bd = 3 * S;
    for (const n of notes) {
      if (n.st !== a.st || Math.abs(n.p - a.p) > 0) continue;
      const dx = n.box[0] - a.c.x1;
      if (dx > -0.4 * S && dx < bd) { bd = dx; best = n; }
    }
    if (best && (!best.accid || bd < best.accidDx)) { best.accid = { type: a.type, ids: a.c.ids, box: [a.c.x0, a.c.y0, a.c.x1, a.c.y1] }; best.accidDx = bd; }
  }
  // augmentation dots and staccato dots travel with their note
  for (const d of dots) {
    const S = spaceAt(d.st, d.c.cx);
    let best = null, bd = 1e9;
    for (const n of notes) {
      if (n.st !== d.st) continue;
      const dx = d.c.cx - n.box[2], dy = Math.abs(d.c.cy - n.y);
      if (dx > 0 && dx < 1.6 * S && dy < 0.8 * S && dx < bd) { bd = dx; best = n; }
    }
    if (best) (best.dots ||= []).push({ ids: d.c.ids, box: [d.c.x0, d.c.y0, d.c.x1, d.c.y1], p: pOfY(d.st, d.c.cy, d.c.cx) });
  }

  // A page usually has one key, and the staves of one system always share theirs. Scanned key
  // signatures get misread (a glyph lost to noise or touching the clef, one extra picked up from
  // the music, none found at all), so a staff takes the key most staves of its system, else of
  // the page, actually read: plurality among the staves that read one, at least two of them and
  // half of those. Applied to staves that read nothing (when there is ink where a key would be)
  // or the same kind of accidental in another number; never against a sharp/flat contradiction.
  const plural = (sts) => {
    const v = new Map(); let tot = 0;
    for (const st of sts) if (st.key.detected) { v.set(st.key.detected, (v.get(st.key.detected) || 0) + 1); tot++; }
    // ties go to the longer signature: a glyph lost to noise is likelier than one invented
    const [k, n] = [...v].sort((a, b) => b[1] - a[1] || Math.abs(b[0]) - Math.abs(a[0]))[0] || [0, 0];
    return n >= 2 && n >= 0.5 * tot ? k : 0;
  };
  const sysOf = (st) => staves.filter((o) => Math.abs(o.x0 - st.x0) < 2 * S0 && o.bars.some((b) => st.bars.some((q) => q.ids[0] === b.ids[0])));
  const pageKey = plural(staves);
  if (opts.fifths == null) for (const st of staves) {
    const sys = sysOf(st), k = (sys.length >= 3 && plural(sys)) || pageKey;
    if (!k || st.key.detected === k) continue;
    if (Math.sign(st.key.detected) === Math.sign(k)) { st.key.fifths = k; st.key.inferred = true; continue; }
    if (st.key.detected) continue;
    const S = spaceAt(st, st.key.x0), first = Math.min(st.x1, ...notes.filter((q) => q.st === st).map((q) => q.box[0]));
    const ya = lineY(st, 0, st.key.x0), yb = lineY(st, 4, st.key.x0);
    const something = cc.comps.some((c) => c && c.x0 >= st.key.x0 - 0.2 * S && c.x1 <= Math.min(first, st.key.x0 + 1.5 * S * Math.abs(k) + S) &&
      c.y1 - c.y0 >= 1.2 * S && c.x1 - c.x0 <= 1.6 * S && c.y1 > ya && c.y0 < yb);
    if (something) { st.key.fifths = k; st.key.inferred = true; }
  }

  // ---- assemble per staff: chords, bars, pitches ----
  for (const st of staves) {
    const ns = notes.filter((n) => n.st === st).sort((a, b) => a.x - b.x || a.p - b.p);
    for (const n of ns) n.bar = st.bars.filter((b) => b.x < n.x).length;
    let chord = 0;
    ns.forEach((n, i) => {
      const prev = ns[i - 1];
      const same = prev && ((n.stem && prev.stem && Math.abs(n.stem.x - prev.stem.x) <= 0.35 * S0 && n.stem.dir === prev.stem.dir) || (!n.stem && !prev.stem && Math.abs(n.x - prev.x) < 0.6 * S0));
      if (!same) chord++;
      n.chord = chord;
    });
    st.notes = ns;
    interpret(st);
  }
  // fragments that belong to a note but lost contact with it (thin stems and flags broken
  // up by binarisation in photos): they travel with the note's component
  const taken = new Set([...headComps]);
  for (const st of staves) { st.key.ids.forEach((i) => taken.add(i)); st.bars.forEach((b) => b.ids.forEach((i) => taken.add(i))); }
  for (const n of notes) { n.accid?.ids.forEach((i) => taken.add(i)); n.dots?.forEach((d) => d.ids.forEach((i) => taken.add(i))); }
  const attach = {};
  const byComp = new Map(); for (const n of notes) { if (!byComp.has(n.comp)) byComp.set(n.comp, []); byComp.get(n.comp).push(n); }
  for (const [id, ns] of byComp) {
    const c = cc.comps[id]; if (!c) continue;
    const S = spaceAt(ns[0].st, ns[0].x), pad = 0.25 * S, out = [];
    for (const q of cc.comps) {
      if (!q || taken.has(q.id)) continue;
      if (q.x1 < c.x0 - S || q.x0 > c.x1 + S || q.y1 < c.y0 - 2 * S || q.y0 > c.y1 + 2 * S) continue;
      const small = q.x1 - q.x0 < 1.2 * S && q.y1 - q.y0 < 1.2 * S && q.x0 >= c.x0 - pad && q.x1 <= c.x1 + pad && q.y0 >= c.y0 - pad && q.y1 <= c.y1 + pad;
      const onStem = ns.some((n) => n.stem && Math.abs((q.x0 + q.x1) / 2 - n.stem.x) <= 0.35 * S && q.x1 - q.x0 < 0.5 * S &&
        q.y0 >= Math.min(n.y, n.stem.tip) - 0.4 * S && q.y1 <= Math.max(n.y, n.stem.tip) + 0.4 * S);
      // pieces of the head itself (a hollow head's ring cut in two where it touches staff lines)
      const inHead = ns.some((n) => q.x0 >= n.box[0] - 2 && q.x1 <= n.box[2] + 2 && q.y0 >= n.box[1] - 2 && q.y1 <= n.box[3] + 2);
      if (small || onStem || inHead) { out.push(q.id); taken.add(q.id); }
    }
    if (out.length) attach[id] = out;
  }

  // systems: staves bound by shared barlines (they must stay aligned when a staff is squeezed)
  let sys = 0;
  staves.forEach((st, i) => {
    const prev = staves[i - 1];
    const shared = prev && Math.abs(prev.x0 - st.x0) < 2 * S0 && st.bars.some((b) => prev.bars.some((q) => Math.abs(q.x - b.x) < 0.5 * S0 && q.ids[0] === b.ids[0]));
    if (!shared) sys++;
    st.system = sys;
  });

  // clef pieces in the final labelling (for erasing on a clef change)
  for (const st of staves) {
    const b = st.clef.box;
    st.clef.ids = b ? cc.comps.filter((c) => c && c.cx >= b[0] && c.cx <= b[2] && c.cy >= b[1] && c.cy <= b[3] &&
      c.x1 - c.x0 <= b[2] - b[0] + 4 && c.y1 - c.y0 <= b[3] - b[1] + 4 && !headComps.has(c.id)).map((c) => c.id) : [];
  }
  return { w, h, space: S0, thick: t, staves, labels: L, comps: cc.comps, ledgerPx: Int32Array.from(ledgerPx), notes, attach, bin: bin.data, A: norm.A, scale: norm.scale, angle: norm.angle };
}

// Pitches from clef + key + accidentals (re-run after a manual correction).
export function interpret(st) {
  const clef = CLEFS[st.clef.type];
  const ps = readStaff(st.notes.map((n) => ({ p: n.p, acc: n.accid ? n.accid.type : null, bar: n.bar })), clef, st.key.fifths);
  st.notes.forEach((n, i) => { n.pitch = ps[i]; n.name = nameOf(ps[i]); });
}

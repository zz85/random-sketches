// Optical music recognition for ScoreShift: a classical staff-first pipeline
// (Fujinaga run-lengths -> staff detection -> staff removal -> symbol segmentation),
// limited to what transposition needs: staves, clefs, key signatures, barlines,
// noteheads + stems, accidentals and augmentation dots. Rhythm is never interpreted:
// the page keeps its own layout, so durations do not have to be understood to move notes.
import * as IP from './imgproc.js';
import { CLEFS, readStaff, nameOf, keySigPositions } from './theory.js';
import { readRhythm } from './rhythm.js';
import { classify } from './glyphnet.js';

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
  // above it as the top line, or a long slur under it as the bottom line while beams buried the
  // top line): the one whose five lines have ink along most of its length wins, then the one
  // supported by the most slices (Sibelius 2 viola, p. 9: 32nd-note runs under three beams)
  const evidence = (s) => {
    let hit = 0, n = 0;
    for (let x = s.x0; x <= s.x1; x += 3) for (let k = 0; k < 5; k++) {
      const y = Math.round(lineY(s, k, x)); n++;
      for (let dy = -Math.ceil(t); dy <= Math.ceil(t); dy++) if (y + dy >= 0 && y + dy < h && data[(y + dy) * w + x]) { hit++; break; }
    }
    return n ? hit / n : 0;
  };
  for (const s of staves) s.evidence = evidence(s);
  const bySupport = staves.slice().sort((a, b) => (Math.abs(b.evidence - a.evidence) > 0.02 ? b.evidence - a.evidence : b.pts.length - a.pts.length));
  // (staves never overlap: two whose line spans intersect are one staff found twice)
  const keep = bySupport.filter((s, i) => !bySupport.some((o, j) => j < i && Math.abs(lineY(o, 2, s.x0) - lineY(s, 2, s.x0)) < 4.5 * S && o.x0 < s.x1 && s.x0 < o.x1));
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
export function compMask(labels, w, c) { // binary mask of a component (or a group: c.ids; or a piece with its own mask)
  if (c.mask) return c.mask;
  const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1, m = new Uint8Array(cw * ch), ids = c.ids || [c.id];
  for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (ids.includes(labels[y * w + x])) m[(y - c.y0) * cw + x - c.x0] = 1;
  return { m, cw, ch };
}

// Vertical strokes (columns whose longest run >= minLen), grouped.
export function strokes(mask, minLen, gapMax = 0) {
  const { m, cw, ch } = mask, cols = [];
  for (let x = 0; x < cw; x++) {
    // longest run in the column, bridging gaps of up to gapMax px (strokes broken in photos)
    // ... but only runs that are mostly ink: bridging must not turn the stack of crossbars
    // between a sharp's two stems into a third "stem"
    let best = 0, bt = 0, start = -1, last = -1, ink = 0;
    for (let y = 0; y < ch; y++) {
      if (!m[y * cw + x]) continue;
      if (start < 0 || y - last - 1 > gapMax) { start = y; ink = 0; }
      last = y; ink++;
      if (last - start + 1 > best && ink >= 0.7 * (last - start + 1)) { best = last - start + 1; bt = start; }
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
  let cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1, W = cw / S, H = ch / S;
  if (W < 0.3 || W > 2.6 || H < 0.5 || H > 4.2) return null;
  const narrow = (s) => s.x1 - s.x0 + 1 <= 0.35 * S + 1;
  let mask = compMask(labels, w, c);
  // the end of a slur or a tie fused to the glyph (Sibelius 2 viola, p. 7, bar 109: a natural with
  // the slur's end under its left stroke read as a sharp): a row's run wider than 1.4 spaces is
  // no part of an accidental, whose crossbars are a space wide, and leaves; the box is then
  // trimmed to the ink left, so the pitch it marks is read from the glyph alone
  {
    const m = mask.m; let erased = false;
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { if (!m[y * cw + x]) continue; let e = x; while (e + 1 < cw && m[y * cw + e + 1]) e++; if (e - x + 1 > 1.4 * S) { for (let q = x; q <= e; q++) m[y * cw + q] = 0; erased = true; } x = e; }
    if (erased) {
      let x0 = cw, x1 = -1, y0 = ch, y1 = -1;
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (m[y * cw + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      if (x1 < 0) return null;
      const ncw = x1 - x0 + 1, nch = y1 - y0 + 1, nm = new Uint8Array(ncw * nch);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) nm[(y - y0) * ncw + x - x0] = m[y * cw + x];
      c = { ...c, x0: c.x0 + x0, x1: c.x0 + x1, y0: c.y0 + y0, y1: c.y0 + y1, cx: c.x0 + (x0 + x1) / 2, cy: c.y0 + (y0 + y1) / 2 };
      mask = { m: nm, cw: ncw, ch: nch }; cw = ncw; ch = nch; W = cw / S; H = ch / S;
      if (W < 0.3 || W > 2.2 || H < 0.5 || H > 3.8) return null;
    } else if (W > 2.2 || H > 3.8) return null;
  }
  let st = strokes(mask, Math.max(1.1 * S, 0.62 * ch), Math.round(0.15 * S + t)); // gaps: photo breaks + removed staff lines
  // heavy fonts and scans: a flat's stem and its bowl's right side bridge into one wide
  // "stroke"; without gap bridging the bowl's hole separates them again
  let flatOnly = false;
  // bold sharps and naturals on scans: crossbars as thick as the gap between the stems bridge
  // both stems into one wide "stroke" too. The stems are still the columns with the most ink
  // over the glyph's height; two such groups are two strokes.
  if (st.length === 1 && !narrow(st[0])) {
    const { m } = mask, cov = [];
    for (let x = 0; x < cw; x++) { let k = 0; for (let y = 0; y < ch; y++) k += m[y * cw + x]; cov.push(k / ch); }
    const top = Math.max(...cov), grp = [];
    for (let x = 0; x < cw; x++) if (cov[x] >= Math.max(0.6, 0.85 * top)) { const g = grp[grp.length - 1]; if (g && x - g.x1 <= 1) g.x1 = x; else grp.push({ x0: x, x1: x }); }
    if (grp.length === 2 && grp[1].x0 - grp[0].x1 >= 0.2 * S && grp.every(narrow)) {
      st = grp.map((g) => { let a = ch, b = -1; for (let x = g.x0; x <= g.x1; x++) for (let y = 0; y < ch; y++) if (m[y * cw + x]) { a = Math.min(a, y); b = Math.max(b, y); } return { ...g, top: a, bot: b }; });
    }
  }
  if (st.length === 1 && !narrow(st[0])) { const g = strokes(mask, 1.1 * S, 0).filter(narrow); if (g.length) { st = g; flatOnly = true; } }
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
  // a stroke's end that runs into a wide blob (the end of a slur or a tie fused to the glyph's
  // foot, p. 7, bar 109: a natural read as a sharp, its left stroke lengthened by the slur) is
  // cut back to where the rows are no wider than the stroke; a crossbar is wider but sits
  // between the strokes, not at an end
  for (const k of st) {
    const kw = k.x1 - k.x0 + 1, ink = (y) => { for (let x = k.x0; x <= k.x1; x++) if (mask.m[y * cw + x]) return true; return false; };
    const run = (y) => { let a = k.x0, b = k.x1; while (a > 0 && mask.m[y * cw + a - 1]) a--; while (b < cw - 1 && mask.m[y * cw + b + 1]) b++; return b - a + 1; };
    // (a bridged gap at the end, with a blob past it, is the slur's too)
    const blobEnd = (y) => !ink(y) || run(y) > Math.max(2.5 * kw, 0.5 * S);
    // (only across a bridged gap: a sharp's crossbar at a stroke's very end is as wide, and stays)
    let b = k.bot, gap = false; while (b > k.top + 0.6 * S && blobEnd(b)) { if (!ink(b)) gap = true; b--; } if (gap && k.bot - b >= 2) { let y = b; while (y > k.top && !ink(y)) y--; k.bot = y; }
    let a = k.top; gap = false; while (a < k.bot - 0.6 * S && blobEnd(a)) { if (!ink(a)) gap = true; a++; } if (gap && a - k.top >= 2) { let y = a; while (y < k.bot && !ink(y)) y++; k.top = y; }
  }
  // ink right of the first stroke, top vs bottom half: flats are bottom-heavy (bowl)
  const right = (s) => {
    let top = 0, bot = 0, cap = 0; const { m } = mask;
    for (let y = 0; y < ch; y++) for (let x = s.x1 + 2; x < cw; x++) if (m[y * cw + x]) { if (y < ch * 0.55) top++; else bot++; if (y < ch * 0.3) cap++; }
    return { top, bot, cap };
  };
  // a flat's bowl can read as a short second stroke: only strokes near full height count
  let stv = st;
  if (st.length >= 2) { const L0 = Math.max(...st.map((s) => s.bot - s.top)); stv = st.filter((s) => s.bot - s.top >= 0.6 * L0); }
  if (stv.length === 1) {
    const s = stv[0], r = right(s);
    if (s.x0 <= 0.3 * cw && (r.bot > 1.5 * r.top || (r.cap <= 0.02 * cw * ch && r.bot > r.top)) && W >= 0.45 && W <= 1.3 && H >= 1.8 && H <= 3.4 && s.top <= 0.15 * ch) {
      // the pitch it marks is the bowl's middle: the rows with ink right of the stem, in the
      // lower half (a stem that reaches below the bowl, as a stem re-paired with its bowl from
      // two pieces can, put the glyph's bottom a step low: Sibelius 2 viola p. 2, bar 121)
      let b0 = -1, b1 = -1; const { m } = mask;
      for (let y = Math.floor(0.4 * ch); y < ch; y++) { let ink = 0; for (let x = s.x1 + 2; x < cw; x++) ink += m[y * cw + x]; if (ink >= 2) { if (b0 < 0) b0 = y; b1 = y; } }
      return { type: -1, ref: b0 >= 0 && b1 - b0 >= 0.4 * S ? c.y0 + (b0 + b1) / 2 : c.y1 - 0.45 * S };
    }
    return null;
  }
  if (flatOnly) return null;
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
function classifyClef(c, st, labels, w, comps = null) {
  const xm = (c.x0 + c.x1) / 2, y0 = lineY(st, 0, xm), y4 = lineY(st, 4, xm), s = (y4 - y0) / 4;
  const top = (y0 - c.y0) / s, bot = (c.y1 - y4) / s, H = (c.y1 - c.y0 + 1) / s, W = (c.x1 - c.x0 + 1) / s;
  // (a G clef is over two spaces wide: a piece of a system barline or a brace left standing
  // at the start of a divisi staff is as tall, and thin)
  if (H >= 5 && top >= 0.6 && bot >= 0.5) return W >= 1.4 ? 'treble' : null;
  if (H >= 2.2 && H < 5 && top > -0.7 && top < 1.4) {
    // C clefs stand on a solid bar as tall as the clef; the F clef is a curl
    const st2 = strokes(compMask(labels, w, c), 0.8 * (c.y1 - c.y0 + 1));
    if (st2.length && H >= 3.4) return top >= 0.6 && bot < -0.4 ? 'tenor' : 'alto';
    if (bot < -0.2 && H < 4.2) {
      // an F clef has its two dots right of the curl; a C clef's curls left standing after its
      // bars were cut away with a beam they touched (Sibelius 2 viola, p. 9) have none
      if (!comps) return 'bass';
      const dots = comps.filter((q) => q && q !== c && q.x0 > c.x1 - 0.3 * s && q.x0 - c.x1 < 1.2 * s && q.y1 - q.y0 <= 0.8 * s && q.x1 - q.x0 <= 0.8 * s && q.cy > y0 - 0.5 * s && q.cy < y4);
      const cutBars = (st.clefCuts || []).some((x) => x > c.x0 - 1.6 * s && x < c.x0);
      return dots.length || !cutBars ? 'bass' : H >= 2.6 ? 'alto' : null;
    }
  }
  return H >= 5 && W >= 1.4 ? 'treble' : null;
}

// A clef change inside a staff: a smaller clef (about three quarters of the opening clef's
// size) after the key signature, usually right after a barline. Shape tests tell it from the
// notes, which also stand in the staff: a C clef is two solid bars centred on the staff, dense,
// about two spaces wide; a G clef reaches well above and below the staff and is wider than a
// stem with a head; an F clef is a curl with no straight stroke, with its two dots to the right.
export function classifyChangeClef(c, st, labels, w, comps) {
  const xm = (c.x0 + c.x1) / 2, y0 = lineY(st, 0, xm), y4 = lineY(st, 4, xm), s = (y4 - y0) / 4;
  const top = (y0 - c.y0) / s, bot = (c.y1 - y4) / s, H = (c.y1 - c.y0 + 1) / s, W = (c.x1 - c.x0 + 1) / s;
  const mask = compMask(labels, w, c); let ink = 0; for (const v of mask.m) ink += v;
  const dens = ink / (mask.cw * mask.ch), bars = strokes(mask, 0.8 * (c.y1 - c.y0 + 1)), tall = bars.length;
  if (H >= 5 && H <= 9 && top >= 0.4 && bot >= 0.4 && W >= 1.8 && W <= 3.4 && !tall && dens >= 0.3 && dens <= 0.55) {
    // a G clef's loop fills its middle rows; a tall time signature's two digits touch at a point
    // and the clef ends below in a thin tail with a dot, where a digit is as wide as the rest
    const rowW = (y) => { let a = -1, b = -1; for (let x = 0; x < mask.cw; x++) if (mask.m[y * mask.cw + x]) { if (a < 0) a = x; b = x; } return a < 0 ? 0 : b - a + 1; };
    let narrow = Infinity, foot = 0, head = 0;
    for (let y = Math.round(0.3 * mask.ch); y < 0.7 * mask.ch; y++) narrow = Math.min(narrow, rowW(y));
    for (let y = Math.round(0.85 * mask.ch); y < mask.ch; y++) foot = Math.max(foot, rowW(y));
    for (let y = 0; y < 0.12 * mask.ch; y++) head = Math.max(head, rowW(y));
    // (cue clefs on this part: middle 0.32-0.37, foot 0.67-0.71, top 0.46-0.53 of the width;
    // a tall 6/8 under scan noise: 0.39, 0.86 and 0.64)
    if (narrow >= 0.3 * mask.cw && foot <= 0.78 * mask.cw && head <= 0.58 * mask.cw) return 'treble';
  }
  // a C clef: a thick bar with a thin one right of it (its curls may stand apart), solid, centred
  // on the staff; a chord's heads stacked on their stem are as dense but have one thin stroke
  // (or the two bars run together into one stroke half a space wide)
  const bars2 = strokes(mask, 0.6 * (c.y1 - c.y0 + 1)), bw = bars2.length ? bars2[0].x1 - bars2[0].x0 + 1 : 0;
  const twoBars = (bars2.length >= 2 && bw >= 0.25 * s && bars2[1].x0 - bars2[0].x1 <= 0.6 * s) || (bw >= 0.5 * s && bw <= 0.9 * s);
  if (H >= 2.6 && H <= 4.6 && W >= 1.0 && W <= 3.2 && (W >= 1.4 || dens >= 0.6) && Math.abs(top - bot) <= 0.8 && top <= 0.4 && twoBars && dens >= 0.45) return 'alto';
  if (H >= 2.4 && H <= 4.2 && W >= 1.2 && W <= 2.6 && top >= -0.5 && top <= 0.6 && bot <= -0.2 && bot >= -1.6 && !tall && dens >= 0.3) {
    // the F clef's two dots, right of the curl, one above the other
    const dots = comps.filter((q) => q && q !== c && q.x0 > c.x1 - 0.3 * s && q.x0 - c.x1 < 1.0 * s && q.y1 - q.y0 <= 0.8 * s && q.x1 - q.x0 <= 0.8 * s && q.cy > c.y0 && q.cy < c.y1);
    if (dots.length >= 1) return 'bass';
  }
  return null;
}

/** Clef changes along a staff, after its key signature: [{ x, x0, x1, type, box }]. */
function findClefChanges(st, cc, S0, t, w) {
  const start = (st.clef.box ? st.clef.box[2] : st.x0) + 1.5 * S0, out = []; // (the key signature is read later; its glyphs fail the shape tests)
  const cands = cc.comps.filter((c) => c && c.x0 > start && c.x1 < st.x1 && c.cy > st.band[0] && c.cy < st.band[1] &&
    c.y1 - c.y0 >= 2.2 * S0 && c.y1 - c.y0 <= 9 * S0 && c.x1 - c.x0 >= 1.0 * S0 && c.x1 - c.x0 <= 3.6 * S0).sort((a, b) => a.x0 - b.x0);
  for (const c of cands) {
    if (out.length && c.x0 < out[out.length - 1].x1 + S0) continue;
    const type = classifyChangeClef(c, st, cc.labels, w, cc.comps);
    if (!type || type === st.clef.type && !out.length) continue;
    if (out.length && type === out[out.length - 1].type) continue;
    const S = spaceAt(st, c.cx), box = [c.x0, c.y0, c.x1, c.y1];
    // the pieces to the right that belong to it: a C clef's curls, an F clef's dots
    for (const q of cc.comps) {
      if (!q || q === c || q.x0 < box[2] - 0.3 * S || q.x0 - box[2] > 1.0 * S || q.y0 < box[1] - 0.6 * S || q.y1 > box[3] + 0.6 * S) continue;
      if (type === 'alto' && q.x1 - box[0] > 3.4 * S) continue;
      if (type === 'bass' && (q.y1 - q.y0 > 0.8 * S || q.x1 - q.x0 > 0.8 * S)) continue;
      if (type === 'treble') continue;
      if (classifyAccidental(cc.labels, w, q, S, t)) continue;
      box[2] = Math.max(box[2], q.x1); box[1] = Math.min(box[1], q.y0); box[3] = Math.max(box[3], q.y1);
    }
    out.push({ x: box[0], x0: box[0], x1: box[2], type, box, ids: [] });
  }
  return out;
}

/** The clef in effect at x on a staff: its opening clef, then any clef changes inside it. */
export function clefAt(st, x) {
  let c = st.clef.type;
  for (const k of st.clefChanges || []) if (k.x0 <= x) c = k.type;
  return c;
}

/** Whether x on a staff falls inside a clef change's box (with a margin of `pad` spaces). */
const inClefChange = (st, x, S, pad = 0.3) => (st.clefChanges || []).some((k) => x > k.box[0] - pad * S && x < k.box[2] + pad * S);

// A tall component that reads as nothing, cut at the row of least ink in its middle third: where
// both pieces read as accidentals (sharp, flat or natural) of pitches a step or more apart, the
// two pieces, else null. Two accidentals of a chord one above the other touch: the upper one's
// foot or bowl on the lower one's head.
export function splitStacked(labels, w, g, S, t) {
  const gw = g.x1 - g.x0 + 1, gh = g.y1 - g.y0 + 1;
  if (gw < 0.5 * S || gw > 1.6 * S || gh < 3.4 * S || gh > 5.6 * S) return null;
  if (classifyAccidental(labels, w, g, S, t)) return null;
  const mask = compMask(labels, w, g);
  let cut = -1, least = Infinity;
  for (let y = Math.round(0.35 * gh); y <= Math.round(0.65 * gh); y++) { let n = 0; for (let x = 0; x < gw; x++) n += mask.m[y * gw + x]; if (n < least) { least = n; cut = y; } }
  if (cut < 0 || least > 0.6 * S) return null;
  const piece = (ya, yb) => {
    let x0 = gw, x1 = -1, n = 0;
    for (let y = ya; y <= yb; y++) for (let x = 0; x < gw; x++) if (mask.m[y * gw + x]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); n++; }
    if (!n) return null;
    const m = new Uint8Array((x1 - x0 + 1) * (yb - ya + 1));
    for (let y = ya; y <= yb; y++) for (let x = x0; x <= x1; x++) if (mask.m[y * gw + x]) m[(y - ya) * (x1 - x0 + 1) + x - x0] = 1;
    return { ...g, x0: g.x0 + x0, x1: g.x0 + x1, y0: g.y0 + ya, y1: g.y0 + yb, n, cx: g.x0 + (x0 + x1) / 2, cy: g.y0 + (ya + yb) / 2, mask: { m, cw: x1 - x0 + 1, ch: yb - ya + 1 }, split: true };
  };
  const p1 = piece(0, cut - 1), p2 = piece(cut, gh - 1);
  if (!p1 || !p2) return null;
  const r1 = classifyAccidental(labels, w, p1, S, t), r2 = classifyAccidental(labels, w, p2, S, t);
  if (!r1 || !r2 || Math.abs(r1.type) > 1 || Math.abs(r2.type) > 1 || r2.ref - r1.ref < 0.9 * S) return null;
  return [p1, p2];
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
    st.clefCuts = []; // the columns cut inside the staff, where a clef's bar may have gone with them
    for (let x = Math.max(0, Math.round(st.x0 - 3 * S0)); x <= Math.min(w - 1, Math.round(st.x0 + 4.5 * S0)); x++) {
      const lim = x < st.x0 + 1.5 * S0 ? 3.5 * S0 : 9 * S0; // (the opening barline spans 4 spaces)
      for (let y = Math.max(0, Math.round(b0 - 6 * S0)); y < Math.min(h, Math.round(b1 + 6 * S0)); y++) {
        if (!clefImg.data[y * w + x] || !big[c0.labels[y * w + x]]) continue;
        let e = y; while (e < h && sym0.data[e * w + x]) e++;
        if (e - y > lim) { for (let yy = y; yy < e; yy++) clefImg.data[yy * w + x] = 0; if (x >= st.x0 && y < lineY(st, 2, x) && e > lineY(st, 2, x)) st.clefCuts.push(x); }
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
      const type = classifyClef(c, st, cc.labels, w, cc.comps);
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
  // clef changes inside the staff, after the opening clef and its key signature
  for (const st of staves) st.clefChanges = opts.clefChanges === false ? [] : findClefChanges(st, cc, S0, t, w);

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
    if (inClefChange(st, b.cx, S)) continue;
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

  // ---- small filled heads (grace and cue notes): a finer opening keeps heads the main one
  // erases; only blobs clearly smaller than a head, at a staff position, away from other heads,
  // are kept here (they still need a stem, checked below like every head)
  const k2 = Math.max(2, Math.round(0.32 * S0)), opened2 = IP.open(sym0, k2), oc2 = IP.components(opened2);
  const medW = new Map(); for (const st of staves) { const ws = heads.filter((o) => o.st === st).map((o) => o.box[2] - o.box[0]).sort((a, b) => a - b); medW.set(st, ws.length ? ws[ws.length >> 1] : 1.3 * S0); }
  for (const b of oc2.comps) {
    if (!b) continue;
    const st = staffAt(b.cx, b.cy); if (!st) continue;
    const S = spaceAt(st, b.cx), bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    // a grace head is about two thirds the size of the staff's heads (flat bowls, flags and dots
    // are smaller or another shape), and a full-size note follows it closely
    const mw = medW.get(st) + 2;
    if (bw < 0.5 * mw || bw > 0.86 * mw || bh < 0.4 * S || bh > 1.0 * S || b.n / (bw * bh) < 0.62) continue;
    if (!heads.some((o) => o.st === st && !o.small && o.x - b.cx > 0.7 * S && o.x - b.cx < 3.2 * S && Math.abs(o.y - b.cy) < 4.5 * S)) continue;
    if (st.clef.box && b.cx < st.clef.box[2] + 0.9 * S) continue;
    if (inClefChange(st, b.cx, S)) continue;
    if (heads.some((o) => o.st === st && Math.abs(o.x - b.cx) < 0.9 * S && Math.abs(o.y - b.cy) < 0.9 * S)) continue;
    const p = Math.round(pOfY(st, b.cy, b.cx));
    heads.push({ st, p, x: b.cx, y: b.cy, box: [b.x0 - 1, b.cy - 0.4 * S, b.x1 + 1, b.cy + 0.4 * S], kind: 'black', small: true });
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
  // (top first; of two at one row, the wider first: a speck of white in a ring's wall, where two
  // hollow heads a third apart meet, took the lower head's half for its own and left the real
  // half alone, p. 4)
  holes.sort((a, b) => a.y0 - b.y0 || (b.x1 - b.x0) - (a.x1 - a.x0));
  for (let i = 0; i < holes.length; i++) {
    const a = holes[i]; if (!a) continue;
    for (let j = i + 1; j < holes.length; j++) {
      const b = holes[j]; if (!b) continue;
      if (b.y0 - a.y1 > t + 3) break;
      const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      // (the halves of one hole lie either side of a line: a staff line or a ledger line, at an
      // even staff position. The holes of two hollow heads a third apart, stacked with the ring's
      // wall between them, lie either side of a space: Sibelius 2 viola, p. 4, half-note chords)
      const gy = (a.y1 + b.y0) / 2, gx = (Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2, gst = staffAt(gx, gy);
      const onLine = !gst || Math.abs(pOfY(gst, gy, gx) / 2 - Math.round(pOfY(gst, gy, gx) / 2)) <= 0.3;
      // (the pockets between a sharp's stems, above and below its crossbars, are narrower than
      // any head's hole, and merge as before, into something too tall to be one)
      const narrow = Math.max(a.x1 - a.x0, b.x1 - b.x0) + 1 < 0.55 * S0;
      if (b.y0 > a.y1 && ov > -0.25 * S0 && (onLine || narrow)) { // tilted ovals: the halves need not overlap
        // (a half that leaks into the hole of the head a third below, through a gap in the wall
        // between them, makes the hole too tall: clipped to a head's height)
        // (only an oval's halves, which fill under 0.8 of their boxes: the pocket between a
        // sharp's stems, split by a line, is as tall and rectangular, and stays too tall to be a head)
        const y1 = Math.max(a.y1, b.y1), tall = y1 - a.y0 + 1, fill = (q) => q.n / ((q.x1 - q.x0 + 1) * (q.y1 - q.y0 + 1));
        const clip = tall > 1.05 * S0 && tall <= 1.4 * S0 && fill(a) < 0.8 && fill(b) < 0.8 && Math.max(a.x1, b.x1) - Math.min(a.x0, b.x0) + 1 >= 0.6 * S0;
        a.x0 = Math.min(a.x0, b.x0); a.x1 = Math.max(a.x1, b.x1); a.y1 = clip ? a.y0 + Math.round(S0) - 1 : y1; a.n += b.n; a.split = true; holes[j] = null;
      }
    }
  }
  const black = (x, y) => x >= 0 && y >= 0 && x < w && y < h && bin.data[y * w + x] === 1;
  const runFrom = (x, y, dx, dy, max) => { let n = 0; while (n < max && black(x + dx * (n + 1), y + dy * (n + 1))) n++; return n; };
  for (const hl of holes) {
    if (!hl) continue;
    const hw = hl.x1 - hl.x0 + 1, hh = hl.y1 - hl.y0 + 1;
    if (hh > 1.05 * S0 || hw > 1.3 * S0) continue; // (tilted holes of some fonts are wide)
    if (hl.n / (hw * hh) > 0.86 && !hl.split) continue; // rectangular pocket between stems and lines, not an oval
    const cx = Math.round((hl.x0 + hl.x1) / 2), cy = Math.round((hl.y0 + hl.y1) / 2);
    const st = staffAt(cx, cy); if (!st) continue;
    const S = spaceAt(st, cx);
    if (st.clef.box && cx <= st.clef.box[2] + 0.9 * S) continue; // (the curls of a C clef, the gap to the key)
    if (inClefChange(st, cx, S, 0.9)) continue;
    // the hole's widest row (the centre row may be a staff line through it, and the row under a
    // line a sliver of the hole: Sibelius 2 viola, p. 4, where that row's width failed the test)
    // Of the middle three fifths of its rows; an oval is widest there, where the pocket between
    // two staff lines, a stem and the round side of a head (a grace note's) is widest at the
    // lines: one whose outer rows run wider than the middle is no head's hole.
    const rowRun = (y) => {
      let x = Math.max(hl.x0, cx - Math.round(0.4 * S)); const xe = Math.min(hl.x1, cx + Math.round(0.4 * S));
      for (; x <= xe && black(x, y); x++);
      if (x > xe) return null;
      let l = x; while (l > hl.x0 && !black(l - 1, y)) l--;
      let r = x; while (r < hl.x1 && !black(r + 1, y)) r++;
      return { l, r };
    };
    let ry = cy, lx = cx, rx = cx, best = -1, outer = -1;
    for (let y = hl.y0; y <= hl.y1; y++) {
      const run = rowRun(y); if (!run) continue;
      const mid = y >= hl.y0 + 0.2 * hh && y <= hl.y1 - 0.2 * hh;
      if (mid && run.r - run.l > best) { best = run.r - run.l; ry = y; lx = run.l; rx = run.r; }
      if (!mid) outer = Math.max(outer, run.r - run.l);
    }
    if (best < 0) continue;
    if (outer > 1.15 * best + 1) continue;
    let tl = runFrom(lx, ry, -1, 0, S), tr = runFrom(rx, ry, 1, 0, S);
    // a stem against the ring's wall lengthens the wall's run: where the ink past the wall's
    // likely thickness is a long vertical stroke, the wall is as thick as the other side's
    // (half-note chords a third apart, the stem down their left, p. 4)
    // (a note's stem, over three spaces: a sharp's two stems are shorter, and the pocket between
    // them narrower than a head's hole)
    const stemAt = (x) => runFrom(x, ry, 0, -1, 4 * S) + runFrom(x, ry, 0, 1, 4 * S) > 3 * S;
    const stemIn = (xa, xb) => { for (let x = xa; x <= xb; x++) if (stemAt(x)) return true; return false; };
    if (hw >= 0.6 * S) {
      if (tl > 0.5 * S && tr <= 0.65 * S && tr >= 0.08 * S && tl > tr && stemIn(lx - tl, lx - Math.round(0.3 * S))) tl = Math.min(tl, Math.max(tr, Math.round(0.2 * S)));
      else if (tr > 0.5 * S && tl <= 0.65 * S && tl >= 0.08 * S && tr > tl && stemIn(rx + Math.round(0.3 * S), rx + tr)) tr = Math.min(tr, Math.max(tl, Math.round(0.2 * S)));
    }
    let tu = runFrom(cx, hl.y0, 0, -1, S), td = runFrom(cx, hl.y1, 0, 1, S);
    // a filled head of the other voice touching the ring above or below (two voices a third apart
    // in one column): take the ring's thickness from the free side
    const headAt = (y) => heads.some((o) => o.kind === 'black' && o.st === st && Math.abs(o.x - cx) < 0.8 * S && Math.abs(o.y - y) < 0.45 * S);
    if (tu > 0.55 * S && td <= 0.55 * S && headAt(hl.y0 - 0.6 * S)) tu = td; else if (td > 0.55 * S && tu <= 0.55 * S && headAt(hl.y1 + 0.6 * S)) td = tu;
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
  if (opts.onHeads) opts.onHeads(heads);
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
      if (!bestOf[dir] || len > bestOf[dir].len) bestOf[dir] = { x, len, dir, tip };
    };
    const bestOf = {};
    for (let x = Math.round(hd.box[2] - 0.35 * S); x <= Math.round(hd.box[2] + 0.2 * S); x++) tryCol(x, -1);
    for (let x = Math.round(hd.box[0] - 0.2 * S); x <= Math.round(hd.box[0] + 0.35 * S); x++) tryCol(x, 1);
    // A stem up from the right and one down from the left: two voices meet at this head's column.
    // The stem that passes through another head on its way belongs to that head (a chord's stem
    // runs through all its heads, but then there is no second stem the other way).
    const through = (sm) => uniq.some((o) => o !== hd && o.st === hd.st && Math.abs(o.x - hd.x) < 0.9 * S && (o.y - hd.y) * sm.dir > 0.6 * S && (o.y - hd.y) * sm.dir < sm.len - 0.5 * S);
    const up = bestOf[-1], dn = bestOf[1];
    best = up && (!dn || up.len >= dn.len) ? up : dn;
    if (up && dn && up.len >= 2.5 * S && dn.len >= 2.5 * S && through(best) && !through(best === up ? dn : up)) best = best === up ? dn : up;
    hd.stem = best && best.len >= (hd.small ? 1.5 : 2.0) * S ? best : null;
    if (hd.stem) { // stem is thin: neighbours 0.4S away must not run as long
      const off = Math.round(0.45 * S) * (hd.stem.dir < 0 ? -1 : 1), x2 = hd.stem.x + off;
      if (x2 >= 0 && x2 < w && vrun(x2, hd.y + hd.stem.dir * 0.6 * S, hd.stem.dir) > 0.8 * hd.stem.len) hd.stem = null;
    }
  }
  // a head beyond the staff stands on ledger lines: the first one must be under it
  // (rejects letters of tempo marks, lyrics and dynamics that look like noteheads)
  const ledgerUnder = (hd) => {
    if (hd.p > -3 && hd.p < 11) return true;
    // every ledger between the staff and the head (a dynamic's bowl below the staff has none)
    const S = spaceAt(hd.st, hd.x), qs = [];
    if (hd.p >= 11) for (let q = 10; q <= hd.p - 1; q += 2) qs.push(q);
    else for (let q = -2; q >= hd.p + 1; q -= 2) qs.push(q);
    return qs.every((q) => {
      const y = Math.round(yOfP(hd.st, q, hd.x));
      for (let dy = -Math.ceil(t) - 1; dy <= Math.ceil(t) + 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        let run = 0, best = 0;
        for (let x = Math.round(hd.box[0] - 0.6 * S); x <= Math.round(hd.box[2] + 0.6 * S); x++) { if (x >= 0 && x < w && bin.data[yy * w + x]) { run++; best = Math.max(best, run); } else run = 0; }
        if (best >= 0.9 * (hd.box[2] - hd.box[0])) return true;
      }
      return false;
    });
  };
  // a stem going up from the left of a "head" is a flat (its bowl survives the opening in
  // bold engravings); real up-stems stand on the right
  const flatLike = (hd) => hd.kind === 'black' && hd.stem && hd.stem.dir < 0 && hd.stem.x < (hd.box[0] + hd.box[2]) / 2;
  let notes = uniq.filter((hd) => (hd.kind === 'hollow' || hd.stem) && ledgerUnder(hd) && !flatLike(hd));
  // a stem carries one duration: a "half note" sharing its stem with black heads is the
  // loop of a curly flag
  // loop of a curly flag: a "half note" sharing a stem with black heads, or threaded on one
  notes = notes.filter((n) => n.kind === 'black' || !notes.some((o) => o.kind === 'black' && o.stem && o.st === n.st &&
    ((n.stem && Math.abs(o.stem.x - n.stem.x) <= 0.35 * S0) ||
     (o.stem.x >= n.box[0] - 0.45 * S0 && o.stem.x <= n.box[2] + 0.45 * S0 && n.y > Math.min(o.y, o.stem.tip) + 0.5 * S0 && n.y < Math.max(o.y, o.stem.tip) + 0.3 * S0))));
  // the hook of an 8th flag at the tip of a stem that carries a black head at its other end
  // passes the opening as a head: a black "head" centred on its own stem (a head hangs to one
  // side of it, a third of a space or more; the hook straddles it), with another black head
  // three spaces or more away on the same stem, is the flag (Sibelius 2 viola, p. 3: 8th-note
  // passages with their flags read as notes)
  notes = notes.filter((n) => !(n.kind === 'black' && n.stem && Math.abs(n.x - n.stem.x) < 0.25 * S0 &&
    notes.some((o) => o !== n && o.kind === 'black' && o.stem && o.st === n.st && Math.abs(o.stem.x - n.stem.x) <= 0.35 * S0 && Math.abs(n.y - o.y) >= 3 * S0 && Math.abs(o.stem.tip - n.y) <= 0.8 * S0)));
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
  // Text: letters stand in rows of similar-sized components with tight gaps (words of a tempo
  // mark, an expression, lyrics, a dynamic like "pp"). Notes are rarely like that: a stemmed
  // note is a tall component, beamed notes are one component, whole notes stand far apart. A
  // note whose component is in such a row ("o", "p", "d" read as whole or half notes) is text.
  // (pieces of a head split by staff removal count as the note)
  const noteParts = new Set(notes.map((n) => n.comp));
  for (const q of cc.comps) if (q && notes.some((n) => q.cx >= n.box[0] - 2 && q.cx <= n.box[2] + 2 && q.cy >= n.box[1] - 2 && q.cy <= n.box[3] + 2)) noteParts.add(q.id);
  const textIds = findText(cc.comps, S0, noteParts, staves);
  notes = notes.filter((n) => !textIds.has(n.comp));
  // whole notes / time-signature digits: a stemless ring must be its own small component
  notes = notes.filter((n) => {
    if (n.kind !== 'whole') return true;
    const c = cc.comps[n.comp]; if (!c) return false;
    const S = spaceAt(n.st, n.x);
    return c.y1 - c.y0 < 1.7 * S && c.x1 - c.x0 < 3 * S && n.box[2] - n.box[0] >= 1.15 * S; // (a whole note is wide; the bowl of a dynamic p is not)
  });
  // holes inside sharps, naturals and double sharps pass the ring test: drop those
  notes = notes.filter((n) => {
    const c = cc.comps[n.comp]; if (!c) return n.kind === 'black';
    const S = spaceAt(n.st, n.x), a = classifyAccidental(L, w, c, S, t);
    // also filled: a sharp's crossings and a flat's bowl survive the opening in heavy scans.
    // (A real note never classifies as a flat: its stem is on the right going up, or on the
    // left going down with the head at the top, where a flat's bowl is at the bottom.)
    // (a grace note's stem, flag and slash can pass for an accidental; accidentals are taller)
    if (a && !(n.small && c.y1 - c.y0 + 1 < 2.4 * S)) return false;
    // (or two accidentals one above the other, a flat's bowl read as a head with the stem of
    // the pair down its left: Sibelius 2 viola, p. 4, flats a third apart before a chord)
    if (n.kind === 'black' && !n.small && splitStacked(L, w, c, S, t)) return false;
    if (n.kind === 'black') return true;
    // A hole's nearest ink can be another component: an accidental-shaped component around the
    // hole, or one that is the head's "stem" (a ring closed by a sharp's stroke, a staff line
    // and the next symbol), makes it part of that accidental, not a note.
    // (in a key signature of flats set tight, the bowl of one flat and the stem of the next close
    // a ring too: a component standing over the head's box that reads as an accidental, in the
    // key zone, is one of the signature's glyphs: Sibelius 2 viola, p. 12, G flat major)
    const keyZone = n.st.clef.box && n.x < n.st.clef.box[2] + 9 * S;
    for (const q of cc.comps) {
      if (!q || q === c || q.y0 > n.y || q.y1 < n.y) continue;
      const inHole = q.x0 <= n.x && q.x1 >= n.x, stemOf = n.stem && n.stem.x >= q.x0 && n.stem.x <= q.x1;
      const over = keyZone && q.x0 < n.box[2] && q.x1 > n.box[0];
      // (or the bowl's own stem, cut from it by a staff line: a narrow tall stroke ending at the
      // ring's left edge with the ring in its lower half)
      if (keyZone && q.x1 - q.x0 + 1 <= 0.35 * S + 1 && q.y1 - q.y0 + 1 >= 1.8 * S && Math.abs(q.x1 - n.box[0]) <= 0.35 * S && n.y > (q.y0 + q.y1) / 2) return false;
      if (!inHole && !stemOf && !over) continue;
      // (a flat too: its bowl is a ring with a stem rising from its left; a real half note's
      // stem rises from the right, or falls from the left with the head on top)
      const qa = classifyAccidental(L, w, q, S, t);
      if (qa) return false;
    }
    // time-signature digits: two spaces tall, hanging from the top line or standing on the bottom one
    const ch = c.y1 - c.y0 + 1, ya = lineY(n.st, 0, n.x), yb = lineY(n.st, 4, n.x);
    if (ch > 1.6 * S && ch < 2.4 * S && (Math.abs(c.y0 - ya) < 0.35 * S || Math.abs(c.y1 - yb) < 0.35 * S) && c.x1 - c.x0 > 1.0 * S) return false;
    return true;
  });
  // a "whole note" right in front of another head at its height is an accidental (a double
  // sharp's hole, a natural's box)
  notes = notes.filter((n) => n.kind !== 'whole' || !notes.some((o) => o !== n && o.st === n.st && Math.abs(o.p - n.p) <= 1 &&
    o.box[0] - n.box[2] > -0.2 * S0 && o.box[0] - n.box[2] < 1.0 * S0));
  // a pair of touching sharps in a tight key signature keeps enough ink through the opening to
  // pass as a head with a stem: in the key zone, a component with four thin stems is no note
  // ... and a sharp of a bold key signature alone passes the same way: one that reads as an
  // accidental, the size of one, is no note either (p. 7: two of six sharps read as notes, so the
  // key stopped at the first)
  notes = notes.filter((n) => {
    const c = cc.comps[n.comp], b = n.st.clef.box; if (!c || !b || c.x0 < b[2] || c.x0 > b[2] + 9 * S0) return true;
    const cw = c.x1 - c.x0 + 1, chh = c.y1 - c.y0 + 1;
    if (n.kind === 'black' && cw <= 1.3 * S0 && chh >= 1.8 * S0 && chh <= 3.6 * S0 && classifyAccidental(L, w, c, S0, t)) return false;
    if (cw < 1.5 * S0 || cw > 7.5 * S0 || chh < 2.2 * S0 || chh > 4.8 * S0) return true;
    const k = strokes(compMask(L, w, c), 0.45 * chh).filter((k) => k.x1 - k.x0 + 1 <= 0.45 * S0).length;
    return k < 4 || k % 2 || k > 14;
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
  // a flat's stem keeps the stub of its bowl's bottom when a ledger line cuts the bowl away, so
  // it can be a little wider than a bare stroke (Sibelius 2 viola, p. 4: the B♭ above the staff
  // read as a double sharp from the bowl alone)
  const isFlatStem = (g) => g.x1 - g.x0 + 1 <= 0.6 * S0 && g.y1 - g.y0 + 1 >= 1.5 * S0;
  for (const g of groups.values()) {
    if (!(isStroke(g) || isHalf(g)) || g.merged) continue;
    for (const q of groups.values()) {
      if (q === g || q.merged || q.x0 - g.x1 < -1 || q.x0 - g.x1 > 0.6 * S0 || q.x1 - q.x0 > 1.4 * S0) continue;
      const ov = Math.min(g.y1, q.y1) - Math.max(g.y0, q.y0);
      const bowl = isFlatStem(g) && q.y0 >= g.y0 + 0.4 * S0 && q.y1 <= g.y1 + 0.3 * S0 && q.x0 - g.x1 <= 0.5 * S0; // flat: bowl fragment
      const pair = (isStroke(q) || isHalf(q)) && ov > 0.6 * Math.min(g.y1 - g.y0, q.y1 - q.y0) && q.x1 - g.x0 <= 1.9 * S0; // sharp / natural halves
      if (!bowl && !pair) continue;
      const m = { ...g, ids: [...g.ids, ...q.ids], x1: Math.max(g.x1, q.x1), y0: Math.min(g.y0, q.y0), y1: Math.max(g.y1, q.y1), n: g.n + q.n, cx: (g.cx * g.n + q.cx * q.n) / (g.n + q.n), cy: (g.cy * g.n + q.cy * q.n) / (g.n + q.n) };
      const a = classifyAccidental(L, w, m, S0, t);
      if (a && (bowl ? a.type < 0 : a.type >= 0)) { Object.assign(g, m); q.merged = true; break; }
    }
  }
  for (const [k, g] of groups) if (g.merged) groups.delete(k);
  // a double sharp cut through its middle by a staff line comes apart into two small halves side
  // by side; the classifier reads the pair
  if (opts.glyphnet !== false) {
    const small = [...groups.values()].filter((g) => g.x1 - g.x0 + 1 <= 0.7 * S0 && g.y1 - g.y0 + 1 <= 1.4 * S0 && g.y1 - g.y0 + 1 >= 0.5 * S0);
    for (const g of small) for (const q of small) {
      if (g === q || g.merged || q.merged || q.x0 <= g.x1 || q.x0 - g.x1 > 0.35 * S0 || Math.abs(q.cy - g.cy) > 0.3 * S0) continue;
      const box = [g.x0, Math.min(g.y0, q.y0), q.x1, Math.max(g.y1, q.y1)];
      if (box[2] - box[0] + 1 > 1.4 * S0) continue;
      const pr = classify(bin, box);
      if (pr.dsharp < 0.9) continue;
      Object.assign(g, { ids: [...g.ids, ...q.ids], x1: box[2], y0: box[1], y1: box[3], n: g.n + q.n, cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2, pairDsharp: true }); q.merged = true;
    }
    for (const [k, g] of groups) if (g.merged) groups.delete(k);
  }
  // Sharps or flats of a tightly set key signature touching each other come as one component
  // two or more spaces wide (Sibelius 2 viola, p. 7: F sharp major's six sharps in pairs, or
  // all in one). Cut such a component between its stems, two to a sharp and one to a flat,
  // where every piece reads as the same accidental; each piece keeps the component's id.
  for (const g of [...groups.values()]) {
    const gw = g.x1 - g.x0 + 1, gh = g.y1 - g.y0 + 1;
    if (g.merged || gw < 1.5 * S0 || gw > 7.5 * S0 || gh < 2.2 * S0 || gh > 4.8 * S0) continue;
    const st = staffAt(g.cx, g.cy); if (!st) continue;
    const S = spaceAt(st, g.cx);
    if (!st.clef.box || g.x0 > st.clef.box[2] + 12 * S) continue; // the key zone
    if (classifyAccidental(L, w, g, S, t)) continue;
    const mask = compMask(L, w, g);
    // the stems (each glyph stands a step or more from its neighbours, so a stem is shorter
    // than the group): sharps have two each, flats one, with the bowl hanging right of it
    const stems = strokes(mask, 0.45 * gh).filter((k) => k.x1 - k.x0 + 1 <= 0.45 * S0);
    let cuts = [], own = [];
    if (stems.length >= 4 && stems.length % 2 === 0) { for (let i = 0; i < stems.length; i += 2) { own.push([stems[i], stems[i + 1]]); if (i + 2 < stems.length) cuts.push(Math.round((stems[i + 1].x1 + stems[i + 2].x0) / 2)); } }
    else if (stems.length >= 2 && stems.every((k, i) => !i || k.x0 - stems[i - 1].x1 > 0.8 * S0)) { for (let i = 0; i < stems.length; i++) { own.push([stems[i]]); if (i + 1 < stems.length) cuts.push(stems[i + 1].x0 - 1); } }
    if (!cuts.length || cuts.some((c, i) => c < 1 || c > gw - 2 || (i && c <= cuts[i - 1] + 1))) continue;
    // each piece's rows are its own stems' (a neighbour's crossbars reach into its columns)
    const piece = (xa, xb, ks) => {
      const ya = Math.min(...ks.map((k) => k.top)) - 1, yb = Math.max(...ks.map((k) => k.bot)) + 1;
      let n = 0; for (let y = Math.max(0, ya); y <= Math.min(gh - 1, yb); y++) for (let x = xa; x <= xb; x++) n += mask.m[y * gw + x];
      return { ...g, x0: g.x0 + xa, x1: g.x0 + xb, y0: g.y0 + Math.max(0, ya), y1: g.y0 + Math.min(gh - 1, yb), n, cx: (2 * g.x0 + xa + xb) / 2, cy: g.y0 + (ya + yb) / 2, split: true };
    };
    const pieces = own.map((ks, i) => piece(i ? cuts[i - 1] + 1 : 0, i < cuts.length ? cuts[i] - 1 : gw - 1, ks));
    const read = pieces.map((q) => classifyAccidental(L, w, q, S, t));
    if (read.some((r) => !r || r.type !== read[0].type || Math.abs(r.type) !== 1)) continue;
    pieces.forEach((q, i) => groups.set(i ? g.id + 'p' + i : g.id, q));
  }
  // Two flats of a chord a third apart touch: the upper note's flat stands right, and its bowl
  // meets the stem of the lower note's flat, set a space lower to the left (p. 4, bars 209-224:
  // the pair read as one sharp). A component with two thin stems well apart, one starting about
  // a space below the other, is cut in two: the right stem with everything at its height, and
  // the rest; where both pieces read as flats of different pitches, they replace it.
  for (const g of [...groups.values()]) {
    const gw = g.x1 - g.x0 + 1, gh = g.y1 - g.y0 + 1;
    if (g.merged || g.split || gw < 1.3 * S0 || gw > 2.4 * S0 || gh < 2.6 * S0 || gh > 4.6 * S0) continue;
    const st = staffAt(g.cx, g.cy); if (!st) continue;
    const S = spaceAt(st, g.cx), mask = compMask(L, w, g);
    const stems = strokes(mask, 0.5 * gh).filter((k) => k.x1 - k.x0 + 1 <= 0.4 * S);
    if (stems.length !== 2) continue;
    const [a, b] = stems;
    if (b.x0 - a.x1 < 0.45 * S || Math.abs(a.top - b.top) < 0.6 * S) continue; // (a sharp's stems are closer, and level but for a quarter space)
    const upper = a.top < b.top ? a : b, lower = upper === a ? b : a; // the stem that starts higher is the upper flat's
    const piece = (take) => {
      let x0 = gw, x1 = -1, y0 = gh, y1 = -1, n = 0;
      for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) if (mask.m[y * gw + x] && take(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); n++; }
      if (!n) return null;
      const m = new Uint8Array((x1 - x0 + 1) * (y1 - y0 + 1));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (mask.m[y * gw + x] && take(x, y)) m[(y - y0) * (x1 - x0 + 1) + x - x0] = 1;
      return { ...g, x0: g.x0 + x0, x1: g.x0 + x1, y0: g.y0 + y0, y1: g.y0 + y1, n, cx: g.x0 + (x0 + x1) / 2, cy: g.y0 + (y0 + y1) / 2, mask: { m, cw: x1 - x0 + 1, ch: y1 - y0 + 1 }, split: true };
    };
    // the upper flat: at or right of its stem, above its stem's foot (where its bowl's bottom meets the other's stem)
    const isUpper = upper === b ? (x, y) => x >= b.x0 - 1 && y <= b.bot + 1 : (x, y) => x <= a.x1 + 1 || y <= a.bot - 0.3 * S;
    const p1 = piece(isUpper), p2 = piece((x, y) => !isUpper(x, y));
    if (!p1 || !p2) continue;
    const r1 = classifyAccidental(L, w, p1, S, t), r2 = classifyAccidental(L, w, p2, S, t);
    if (!r1 || !r2 || r1.type !== -1 || r2.type !== -1 || Math.abs(r1.ref - r2.ref) < 0.8 * S) continue;
    groups.set(g.id, p1); groups.set(g.id + 'f', p2);
  }
  // Two accidentals of a chord one above the other, touching (p. 4, bar 216: flats a fifth
  // apart, A flat and E flat, in one component four spaces tall): cut apart where both pieces
  // read as accidentals.
  for (const g of [...groups.values()]) {
    if (g.merged || g.split) continue;
    const st = staffAt(g.cx, g.cy); if (!st) continue;
    const S = spaceAt(st, g.cx);
    if (!notes.some((n) => n.st === st && n.box[0] - g.x1 > -0.3 * S && n.box[0] - g.x1 < 1.4 * S)) continue;
    const ps = splitStacked(L, w, g, S, t);
    if (ps) { groups.set(g.id, ps[0]); groups.set(g.id + 'v', ps[1]); }
  }
  // Competing readings of an accidental-sized symbol: the stroke rules (classifyAccidental) and
  // the learned classifier (glyphnet.js) each give evidence; the reading with the most combined
  // support wins. The rules carry a fixed prior weight, so the classifier overrides them only
  // when it is confident (a double sharp the rules miss, a sharp cut up in a phone photo).
  // A narrow piece the rules could not pair with its neighbour is also tried as a pair.
  const ACC_OF = { sharp: 1, flat: -1, natural: 0, dsharp: 2, dflat: -2 }, NAME_OF = { 1: 'sharp', '-1': 'flat', 0: 'natural', 2: 'dsharp', '-2': 'dflat' };
  const RULE_W = Math.log(opts.ruleWeight ?? 8), useNet = opts.glyphnet !== false;
  const readAccidental = (c, S, st) => {
    const rule = classifyAccidental(L, w, c, S, t);
    const W = (c.x1 - c.x0 + 1) / S, H = (c.y1 - c.y0 + 1) / S;
    // (the crop pads a narrow box to the classifier's shape with its surroundings: the bare stem
    // of a flat whose bowl came apart, 0.3 spaces wide, read as the two flats beside it)
    if (!useNet || W < (c.pairDsharp ? 0.3 : 0.45) || W > 2.2 || H < (c.pairDsharp ? 0.5 : 0.8) || H > 3.8) return rule;
    const pr = classify(bin, [c.x0, c.y0, c.x1, c.y1]);
    const pNone = Math.max(1e-4, 1 - Object.keys(ACC_OF).reduce((q, k) => q + pr[k], 0));
    // (the classifier may add or retype an accidental but not delete one the rules found: on real
    // scans unlike its synthetic training pages it is less sure of what is not a symbol)
    let best = { type: null, s: rule ? -Infinity : Math.log(pNone) + RULE_W };
    for (const [k, v] of Object.entries(ACC_OF)) { const agree = rule && rule.type === v; if (!agree && pr[k] < 0.9) continue; const sc = Math.log(pr[k] + 1e-4) + (agree ? RULE_W : 0); if (sc > best.s) best = { type: v, s: sc }; }
    c.readings = { rule: rule ? NAME_OF[rule.type] : null, net: Object.entries(pr).sort((x, y) => y[1] - x[1])[0], chose: best.type == null ? null : NAME_OF[best.type] };
    if (best.type == null) return null;
    if (rule && rule.type === best.type) return rule;
    const ref = best.type === -1 || best.type === -2 ? c.y1 - 0.45 * S : (c.y0 + c.y1) / 2;
    return { type: best.type, ref, net: true };
  };
  const accs = [], dots = [];
  for (const c of groups.values()) {
    if (!c || headComps.has(c.id)) continue;
    const st = staffAt(c.cx, c.cy); if (!st) continue;
    const S = spaceAt(st, c.cx), cw = c.x1 - c.x0 + 1, chh = c.y1 - c.y0 + 1;
    if (st.clef.box && c.x1 <= st.clef.box[2] + 0.2 * S) continue;
    if (inClefChange(st, c.cx, S)) continue;
    const ya = lineY(st, 0, c.cx), yb = lineY(st, 4, c.cx);
    // (a stem cut off its hollow head by staff removal is not a barline)
    const stemOf = notes.some((n) => n.stem && n.st === st && Math.abs(n.stem.x - c.cx) <= 0.4 * S && Math.min(n.y, n.stem.tip) <= c.y0 + 0.5 * S && Math.max(n.y, n.stem.tip) >= c.y1 - 1.0 * S);
    if (!stemOf && cw <= 0.75 * S && c.y0 <= ya + 0.4 * S && c.y1 >= yb - 0.4 * S && (c.n / chh <= Math.max(0.35 * S, 2.5 * t) || (c.n / (cw * chh) > 0.7 && c.n / chh <= 0.65 * S)) && c.n / chh >= 0.6 * t && // (or a thick, solid final / repeat bar)

      (chh <= (yb - ya) + 1.2 * S || staves.some((o) => o !== st && (c.y1 >= lineY(o, 0, c.cx) || c.y0 <= lineY(o, 4, c.cx)) && Math.abs(lineY(o, 2, c.cx) - lineY(st, 2, c.cx)) < 20 * S))) { // thin; may span a whole system
      for (const o of staves) { // a system barline counts for every staff it crosses
        if (c.cx < o.x0 - S || c.cx > o.x1 + S) continue;
        if (c.y0 <= lineY(o, 0, c.cx) + 0.4 * S && c.y1 >= lineY(o, 4, c.cx) - 0.4 * S) o.bars.push({ x: c.cx, x0: c.x0, x1: c.x1, ids: c.ids });
      }
      continue;
    }
    const a = readAccidental(c, S, st);
    if (a) { const pf = pOfY(st, a.ref, c.cx); accs.push({ st, c, ...a, p: Math.round(pf), pf }); continue; }
    // the bare stem of a flat whose bowl joined the head it marks (dense beamed runs: p. 3, bar
    // 133): a thin stroke of a flat's height, no note's stem, standing a fraction of a space
    // left of a head and reaching from above the head to a little below it, is that head's flat
    if (!stemOf && cw <= 0.4 * S && chh >= 1.7 * S && chh <= 2.9 * S) {
      const bowl = c.y1 - 0.45 * S;
      const hd = notes.find((n) => n.st === st && n.box[0] - c.x1 >= 0.15 * S && n.box[0] - c.x1 <= 1.0 * S && Math.abs(n.y - bowl) <= 0.6 * S && c.y0 <= n.y - 1.1 * S);
      if (hd && !notes.some((n) => n.st === st && n.box[0] <= c.x1 && n.box[2] >= c.x0 - 0.3 * S && Math.abs(n.y - c.cy) < 2 * S)) {
        const pf = pOfY(st, bowl, c.cx); accs.push({ st, c, type: -1, ref: bowl, p: Math.round(pf), pf, stemOnly: true }); continue;
      }
    }
    if (cw >= 0.2 * S && cw <= 0.75 * S && chh >= 0.2 * S && chh <= 0.75 * S && c.n / (cw * chh) > 0.5 && cw / chh > 0.55 && cw / chh < 1.8) {
      // a dot stands alone; pieces of a tie or slur cut up by staff-line removal have neighbours
      // just across the removed line
      const r = Math.ceil(t) + 2; let near = 0;
      for (let y = Math.max(0, c.y0 - r); y <= Math.min(h - 1, c.y1 + r); y++) for (let x = Math.max(0, c.x0 - r); x <= Math.min(w - 1, c.x1 + r); x++) {
        const l = L[y * w + x]; if (l && !c.ids.includes(l)) near++;
      }
      const onLine = [0, 1, 2, 3, 4].some((k) => { const yl = lineY(st, k, c.cx); return c.y0 - yl <= t + 2 && yl - c.y1 <= t + 2; });
      if (near < 3 || !onLine) dots.push({ st, c });
    }
  }
  // Barlines touched by a slur or a hairpin are part of a bigger component and fail the shape
  // test above: find them as columns of ink covering the whole staff inside such components,
  // thin, and not the stem of a note.
  for (const st of staves) {
    const S = spaceAt(st, (st.x0 + st.x1) / 2), x0 = Math.round((st.clef.box ? st.clef.box[2] : st.x0) + S);
    let run = 0;
    for (let x = x0; x <= st.x1 + 1; x++) {
      const ya = Math.round(lineY(st, 0, x)), yb = Math.round(lineY(st, 4, x));
      let miss = 0;
      for (let y = ya + 1; miss <= 2 && y < yb; y++) if (!L[y * w + x]) miss++;
      const full = x <= st.x1 && miss <= 2;
      if (full) { run++; continue; }
      if (run && run <= 0.45 * S) {
        const xb = x - run, xc = (xb + x - 1) / 2;
        let id = 0; for (let y = ya + 1; !id && y < yb; y++) id = L[y * w + Math.round(xc)];
        const c = cc.comps[id];
        const big = c && !headComps.has(id) && (c.x1 - c.x0 > 0.75 * S || c.y1 - c.y0 > (yb - ya) + 2.5 * S);
        const stem = notes.some((n) => n.stem && Math.abs(n.stem.x - xc) <= 0.5 * S && n.st === st);
        const near = st.bars.some((b) => Math.abs(b.x - xc) < 1.5 * S);
        // nothing pokes out sideways along most of it (a slur crossing it touches it at one place)
        let side = 0; for (let y = ya; y <= yb; y++) if (L[y * w + xb - 2] === id || L[y * w + x + 1] === id) side++;
        // and the column ends at the staff, or at another staff's line (a system barline): one
        // that runs on past the staff by half a space or more and stops in the open is the stem
        // of a note whose head wasn't found (Sibelius 2 viola, p. 4: half-note chords a third
        // apart, read as barlines, which reset the bar's accidentals)
        const xi = Math.round(xc), onLine = (y) => staves.some((o) => [0, 4].some((k) => Math.abs(lineY(o, k, xi) - y) <= t + 2));
        let yt = ya; for (let g = 0; yt > 0 && g <= 2; yt--) { if (L[(yt - 1) * w + xi]) g = 0; else g++; } yt += 1;
        let yd = yb; for (let g = 0; yd < h - 1 && g <= 2; yd++) { if (L[(yd + 1) * w + xi]) g = 0; else g++; } yd -= 1;
        // (or ends inside another staff, short of its far line: the stem of the upper staff's
        // note, down, meeting the lower staff's, up, at one x)
        const inside = (y) => staves.some((o) => o !== st && y > lineY(o, 0, xi) + t + 2 && y < lineY(o, 4, xi) - t - 2);
        // (or carries a head at either end: ink of its own component reaching 0.6 space to one
        // side over half a space of rows within a space of the run's end, where a barline has
        // nothing but a tie's thin arc; the upper staff's chord on its top line, stem down, met
        // the lower's stem up and passed as a system barline)
        const headAt = (ye, dir) => {
          let rows = 0;
          for (let y = ye, k = 0; k < Math.round(1.3 * S) && y > 0 && y < h - 1; y += dir, k++) {
            let l = xi, r = xi; while (l > 0 && L[y * w + l - 1] === id) l--; while (r < w - 1 && L[y * w + r + 1] === id) r++;
            if (Math.max(xi - l, r - xi) >= 0.6 * S) rows++;
          }
          return rows >= 0.5 * S;
        };
        // (a system barline's end may run a little past the far staff's outer line, where a tie
        // hangs from it: within 0.8 space of a line of a staff the run crosses whole)
        const crossed = staves.filter((o) => yt <= lineY(o, 0, xi) + t + 2 && yd >= lineY(o, 4, xi) - t - 2);
        const pastOuter = (y) => crossed.some((o) => Math.abs(y - lineY(o, 0, xi)) <= 0.8 * S || Math.abs(y - lineY(o, 4, xi)) <= 0.8 * S);
        const endBad = (y) => (!onLine(y) && !pastOuter(y)) || inside(y);
        const stemEnd = (ya - yt > 0.5 * S && endBad(yt)) || (yd - yb > 0.5 * S && endBad(yd)) || headAt(yt, 1) || headAt(yd, -1);
        if (big && !stem && !near && !stemEnd && side < 0.35 * (yb - ya)) st.bars.push({ x: xc, x0: xb, x1: x - 1, ids: [], merged: true });
      }
      run = 0;
    }
  }
  for (const st of staves) {
    st.bars.sort((a, b) => a.x - b.x);
    // double / final bar = one, marked (a piece or section may end on a short bar)
    st.bars = st.bars.filter((b, i, arr) => { if (i > 0 && b.x - arr[i - 1].x < 1.5 * S0) { arr[i - 1].double = true; arr[i - 1].ids = [...arr[i - 1].ids, ...b.ids]; return false; } return true; });
    for (const b of st.bars) if (!b.double && b.x1 - b.x0 + 1 > 2.2 * t + 2) b.double = true; // a thick (final) bar
  }

  // key signature: accidentals right after the clef, same type, closely spaced. A page that
  // starts with a key change (the part continues from a page in another key) prints naturals
  // first: only naturals cancel the old key (C / a minor), naturals then sharps or flats replace it.
  for (const st of staves) {
    const S = spaceAt(st, st.x0 + 4 * S0);
    const firstNote = Math.min(...notes.filter((n) => n.st === st).map((n) => n.box[0]), st.x1);
    let x = st.clef.box ? st.clef.box[2] : st.x0 + 2 * S;
    const mine = accs.filter((a) => a.st === st && a.c.x0 > x - 0.3 * S && a.c.x1 < firstNote && (a.type === 1 || a.type === -1 || a.type === 0) && a.p >= -2 && a.p <= 10).sort((a, b) => a.c.x0 - b.c.x0);
    const key = [];
    for (const a of mine) {
      if (a.c.x0 - x > 2.0 * S || key.length >= 14) break;
      // a local accidental hugs its note (~0.2-0.3 spaces); a key signature keeps a full space
      // or more before the music, so an accidental with a head at its pitch right after it ends the key
      // (a natural in front of the first note can stand up to ~2 spaces off and is still that
      // note's: naturals need 3 spaces of clearance to count as a cancellation)
      // (a stemless "whole note" there, once the key has begun, is the loop of a time-signature
      // digit touching the key: tight engravings)
      const localGap = a.type === 0 ? 3.0 * S : 0.55 * S;
      if (notes.some((n) => n.st === st && Math.abs(n.p - a.p) <= 0 && n.box[0] - a.c.x1 > -0.3 * S && n.box[0] - a.c.x1 < localGap && !(key.length && n.kind === 'whole'))) break;
      // naturals come first; after them, sharps or flats of one kind
      const replacementType = key.find((k) => k.type !== 0)?.type;
      if (a.type === 0 ? replacementType != null : replacementType != null && a.type !== replacementType) break;
      // glyphs of one signature are one size (a C or cut-C time signature can read as a sharp);
      // compared within a kind (a sharp is wider than a natural)
      const sameType = key.find((k) => k.type === a.type);
      if (sameType && (a.c.x1 - a.c.x0) > 1.35 * (sameType.c.x1 - sameType.c.x0) + 1) break;
      // key signature glyphs are evenly spaced; a wider jump is the time signature or the music
      if (key.length >= 2) { const d = (key[key.length - 1].c.x0 - key[0].c.x0) / (key.length - 1); if (a.c.x0 - key[key.length - 1].c.x0 > 1.4 * d) break; }
      key.push(a); x = a.c.x1;
    }
    // keep the replacement prefix whose glyphs sit where a key signature puts them
    const clef = CLEFS[st.clef.type];
    let naturals = key.findIndex((a) => a.type !== 0); if (naturals < 0) naturals = key.length;
    if (naturals < key.length) {
      const rep = key.slice(naturals), exp = keySigPositions(clef, rep[0].type * rep.length);
      let n = 0; while (n < rep.length && Math.abs(rep[n].p - exp[n]) <= 1) n++;
      key.length = naturals + n;
    }
    const replacement = key.slice(naturals);
    const cancellation = key.length > 0 && !replacement.length;
    const detected = replacement.length ? replacement[0].type * replacement.length : 0;
    key.forEach((a) => (a.isKey = true));
    // opts.fifths: the key the part was in before this page; it applies to staves that print
    // none (an explicit signature or a cancellation always wins)
    st.key = { fifths: cancellation ? 0 : detected || (opts.fifths ?? 0), detected, cancellation,
      ids: key.flatMap((a) => a.c.ids), idsPer: key.map((a) => a.c.ids), glyphs: key.map((a) => ({ p: a.p, type: a.type, box: [a.c.x0, a.c.y0, a.c.x1, a.c.y1] })), x0: st.clef.box ? st.clef.box[2] + 1 : st.x0 + 2 * S, x1: key.length ? key[key.length - 1].c.x1 : (st.clef.box ? st.clef.box[2] + 1 : st.x0 + 2 * S) };
  }

  // a double flat engraved as two flat glyphs side by side: two separate components
  for (const a of accs) {
    if (a.type !== -1 || a.isKey || a.merged) continue;
    const S = spaceAt(a.st, a.c.cx);
    const b = accs.find((q) => q !== a && q.st === a.st && q.type === -1 && !q.isKey && !q.merged && q.p === a.p && q.c.x0 > a.c.x0 && q.c.x0 - a.c.x1 < 0.35 * S && Math.abs(q.c.y1 - a.c.y1) < 0.3 * S);
    if (!b) continue;
    a.type = -2; a.c = { ...a.c, ids: [...a.c.ids, ...b.c.ids], x1: b.c.x1, y0: Math.min(a.c.y0, b.c.y0) }; b.merged = true;
  }
  for (let k = accs.length - 1; k >= 0; k--) if (accs[k].merged) accs.splice(k, 1);
  // ... or a flat plus a leftover piece of the second one (staff removal cut it): the classifier
  // reads the extended box
  if (opts.glyphnet !== false) for (const a of accs) {
    if (a.type !== -1 || a.isKey || a.merged) continue;
    const S = spaceAt(a.st, a.c.cx);
    const extra = cc.comps.filter((q) => q && !headComps.has(q.id) && !a.c.ids.includes(q.id) && q.x0 > a.c.x0 && q.x0 - a.c.x1 < 0.3 * S && q.x1 - a.c.x0 < 2.1 * S && q.y0 >= a.c.y0 - 0.3 * S && q.y1 <= a.c.y1 + 0.3 * S && !accs.some((o) => o !== a && o.c.ids.includes(q.id)));
    if (!extra.length) continue;
    const box = [a.c.x0, Math.min(a.c.y0, ...extra.map((q) => q.y0)), Math.max(a.c.x1, ...extra.map((q) => q.x1)), Math.max(a.c.y1, ...extra.map((q) => q.y1))];
    if (classify(bin, box).dflat >= 0.9) { a.type = -2; a.c = { ...a.c, ids: [...a.c.ids, ...extra.map((q) => q.id)], x1: box[2] }; }
  }
  // Key changes inside a staff (a new section after a double bar, Telemann's minore / maggiore):
  // a run of accidentals right after a barline, not hugging a note at its pitch, optionally
  // naturals cancelling the old key first, then sharps or flats of one kind at the key-signature
  // positions for the clef. Only the run's first glyphs need to be found right after the bar.
  for (const st of staves) {
    st.keyChanges = [];
    // (from the key in effect: a staff that inherited the previous page's key cancels that one)
    let cur = st.key.fifths;
    for (const b of st.bars) {
      const S = spaceAt(st, b.x), xs = b.x1;
      const run = [];
      let x = xs;
      // (inside the staff, like any signature: text such as "[Minore]" above it is not part of it)
      for (const a of accs.filter((q) => q.st === st && !q.isKey && q.c.x0 > xs && q.c.x0 - xs < 6 * S && q.p >= -2 && q.p <= 10).sort((p, q) => p.c.x0 - q.c.x0)) {
        // (a repeat sign's thin line and dots stand between the barline and the key)
        if (a.c.x0 - x > (run.length ? 1.6 : b.double ? 3.4 : 2.2) * S || run.length >= 11) break;
        if (notes.some((n) => n.st === st && n.box[0] > xs && n.box[2] < a.c.x0)) break; // music started
        if (notes.some((n) => n.st === st && n.p === a.p && n.box[0] - a.c.x1 > -0.3 * S && n.box[0] - a.c.x1 < 0.55 * S)) break; // hugs a note
        run.push(a); x = a.c.x1;
      }
      if (!run.length) continue;
      let i = 0; while (i < run.length && run[i].type === 0) i++;
      const nat = run.slice(0, i), acc = run.slice(i);
      // the new signature is the prefix of one kind at its positions; it ends at the first glyph
      // that is not (the first accidental of the music)
      const clef = CLEFS[clefAt(st, b.x)];
      let j = 0; while (j < acc.length && Math.abs(acc[j].type) === 1 && acc[j].type === acc[0].type && Math.abs(acc[j].p - keySigPositions(clef, acc[0].type * (j + 1))[j]) <= 1) j++;
      acc.length = j; run.length = nat.length + j;
      if (run.length) x = run[run.length - 1].c.x1;
      // naturals stand where the old key's glyphs were; the new glyphs where the new key's go
      const oldPos = keySigPositions(clef, cur);
      if (nat.length && (!cur || nat.some((a) => !oldPos.some((p) => Math.abs(p - a.p) <= 1)))) continue;
      const nf = acc.length ? acc[0].type * acc.length : 0, exp = keySigPositions(clef, nf);
      if (acc.some((a, k) => Math.abs(a.p - exp[k]) > 1)) continue;
      if (!nat.length && !acc.length) continue;
      // a lone sharp or flat with no naturals is only a key change if it differs from the key
      // and keeps clear of the music like a signature does
      const next = Math.min(st.x1, ...notes.filter((n) => n.st === st && n.box[0] > x).map((n) => n.box[0]));
      if (next - x < 0.5 * S || next >= st.x1) continue; // (one at the very end, with no music after, is not trusted)
      if (nf === cur) continue;
      // plausibility, from false positives on IMSLP pages: a lone accidental after a plain barline
      // is a local one (its note can be a grace note, which is not detected); naturals alone must
      // cancel the whole old key; fewer accidentals of the same kind need naturals to say so
      if (run.length < 2 && !b.double) continue;
      if (!acc.length && nat.length !== Math.abs(cur)) continue;
      if (Math.sign(nf) === Math.sign(cur) && Math.abs(nf) < Math.abs(cur) && !nat.length) continue;
      run.forEach((a) => (a.isKey = true));
      st.keyChanges.push({ x: b.x, x0: run[0].c.x0, x1: x, detected: nf, fifths: nf, from: cur,
        ids: run.flatMap((a) => a.c.ids), glyphs: run.map((a) => ({ p: a.p, type: a.type, box: [a.c.x0, a.c.y0, a.c.x1, a.c.y1] })) });
      cur = nf;
    }
  }

  // An accidental fused with something else never came as a component of its own: a natural
  // or sharp whose crossbar meets its head, or a natural touching the slur over it, or the
  // beam of its note (p. 12, bars 152-153: a run in G flat major with its naturals lost). For a
  // head with no accidental read just before it, the ink of the window left of it, from the
  // head's own component and from components not read as anything, is tried as one.
  {
    const spoken = new Set(); for (const a of accs) a.c.ids.forEach((i) => spoken.add(i)); for (const d of dots) d.c.ids.forEach((i) => spoken.add(i));
    for (const st of staves) { st.key.ids.forEach((i) => spoken.add(i)); st.keyChanges.forEach((k) => k.ids.forEach((i) => spoken.add(i))); st.clefChanges.forEach((k) => k.ids.forEach((i) => spoken.add(i))); st.bars.forEach((b) => b.ids.forEach((i) => spoken.add(i))); }
    const textIdSet = textIds;
    for (const n of notes) {
      const S = spaceAt(n.st, n.x);
      if (accs.some((a) => a.st === n.st && !a.isKey && n.box[0] - a.c.x1 > -0.4 * S && n.box[0] - a.c.x1 < 1.4 * S && Math.abs(a.p - n.p) <= 1)) continue;
      const xa = Math.max(0, Math.round(n.box[0] - 1.7 * S)), xb = Math.round(n.box[0] - 0.12 * S), ya = Math.max(0, Math.round(n.y - 1.9 * S)), yb = Math.min(h - 1, Math.round(n.y + 1.9 * S));
      if (xb <= xa) continue;
      // other heads in the window keep their ink (their boxes and stems) out of it; a natural's
      // filled box that passed as a head of this note's own component is taken back below
      const others = notes.filter((o) => o !== n && o.st === n.st && o.box[2] > xa - 0.3 * S && o.box[0] < xb + 0.3 * S && Math.abs(o.y - n.y) < 2.6 * S);
      // (and the stems of the staff's notes near in x, whatever their height: a stem from a head
      // three spaces up runs through the window)
      const stemsNear = notes.filter((o) => o !== n && o.st === n.st && o.stem && o.stem.len >= 2.6 * S && Math.abs(o.x - n.x) < 3.5 * S);
      // a "head" with a short stem or none, entirely left of this note, may be the filled box of
      // a natural or a sharp's crossing (two were read on one sharp as grace notes, p. 14):
      // its ink stays in the window, and it is taken back below where the accidental covers it
      // (a sharp fused to its head, p. 5, bar 309: its box reaches the head's)
      const blob = (o) => o.kind === 'black' && (!o.stem || o.stem.len < 2.6 * S) && o.box[2] < n.box[0] + 0.15 * S && o.x < n.box[0];
      const inOther = (x, y) => others.some((o) => !blob(o) && ((x >= o.box[0] - 0.2 * S && x <= o.box[2] + 0.2 * S && y >= o.box[1] - 0.2 * S && y <= o.box[3] + 0.2 * S) || (o.stem && Math.abs(x - o.stem.x) <= 0.25 * S)))
        || stemsNear.some((o) => Math.abs(x - o.stem.x) <= 0.25 * S && y >= Math.min(o.y, o.stem.tip) - 0.3 * S && y <= Math.max(o.y, o.stem.tip) + 0.3 * S);
      // a slur or a beam through the window is a long horizontal run of ink, which no accidental
      // has (a natural's crossbars are under a space wide): its pixels stay out
      const wide = new Set(), rx0 = Math.max(0, Math.round(xa - 3 * S)), rx1 = Math.min(w - 1, Math.round(xb + 3 * S));
      // (a run under 2.2 spaces that ends in the head's box or lies on a staff line's rows stays:
      // a crossbar joining the head it marks, or thickened by the line's remains, is no slur:
      // p. 5, bar 309, a sharp cut in two above its lower crossbar; a beam is longer and goes)
      const onStaffLine = (y, x) => [0, 1, 2, 3, 4].some((k) => Math.abs(lineY(n.st, k, x) - y) <= t + 1);
      for (let y = ya; y <= yb; y++) for (let x = rx0; x <= rx1; x++) { if (!L[y * w + x]) continue; let e = x; while (e + 1 <= rx1 && L[y * w + e + 1]) e++; if (e - x + 1 > 1.3 * S && !(e - x + 1 <= 2.2 * S && (onStaffLine(y, (x + e) / 2) || (e >= n.box[0] && e <= n.box[2] + 1 && y >= n.box[1] - 1 && y <= n.box[3] + 1)))) for (let q = Math.max(x, xa); q <= Math.min(e, xb); q++) wide.add(y * w + q); x = e; }
      let x0 = xb, x1 = xa, y0 = yb, y1 = ya, cnt = 0; const ids = new Set();
      // (a component of another head is ink too, where that head is not in the window: a slur
      // carrying a sharp along it had a head read on it elsewhere, p. 14, bars 238-258)
      const ok = (l, x, y) => l && !textIds.has(l) && (l === n.comp || !spoken.has(l)) && !inOther(x, y) && !wide.has(y * w + x);
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) { const l = L[y * w + x]; if (!ok(l, x, y)) continue; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); cnt++; ids.add(l); }
      if (!cnt) continue;
      const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
      if (cw < 0.5 * S || cw > 2.6 * S || ch < 1.8 * S || ch > 4.5 * S) continue;
      let m = new Uint8Array(cw * ch);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (ok(L[y * w + x], x, y)) m[(y - y0) * cw + x - x0] = 1;
      let c = { id: n.comp, ids: [...ids], x0, y0, x1, y1, n: cnt, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, mask: { m, cw, ch }, fused: true };
      // a slur's end touching the glyph (p. 16, bar 247: naturals under a slur): keep the ink
      // around the glyph's own strokes, from just above their tops to just below their feet,
      // and from half a space left of the first to a bowl's width right of the last
      // (no accidental has ink more than a crossbar's end left of its first stroke). The strokes
      // are read with the gaps the staff lines' removal cut in them filled, and no other gap
      // bridged, so a slur's end a few pixels under a stroke's foot doesn't lengthen the stroke.
      for (let x = 0; x < cw; x++) for (let k = 0; k < 5; k++) {
        const yl = Math.round(lineY(n.st, k, x0 + x)) - y0; if (yl < 1 || yl >= ch - 1) continue;
        let a = yl, b = yl; while (a > 0 && !m[(a - 1) * cw + x] && yl - a < t + 2) a--; while (b < ch - 1 && !m[(b + 1) * cw + x] && b - yl < t + 2) b++;
        if (a > 0 && b < ch - 1 && b - a + 1 <= t + 2 && m[(a - 1) * cw + x] && m[(b + 1) * cw + x] && !m[yl * cw + x]) for (let y = a; y <= b; y++) m[y * cw + x] = 1;
      }
      const stk = strokes(c.mask, 1.1 * S, 0).filter((k) => k.x1 - k.x0 + 1 <= 0.35 * S + 1);
      if (stk.length >= 1 && stk.length <= 2) {
        const kx0 = Math.max(0, Math.round(Math.min(...stk.map((k) => k.x0)) - 0.22 * S)), kx1 = Math.min(cw - 1, Math.round(Math.max(...stk.map((k) => k.x1)) + 0.65 * S));
        const ky0 = Math.max(0, Math.min(...stk.map((k) => k.top)) - 2), ky1 = Math.min(ch - 1, Math.max(...stk.map((k) => k.bot)) + 2);
        // and the slur itself where it runs in under the glyph: left of the last stroke, nothing
        // of an accidental lies below the shorter stroke's foot (a sharp's and a natural's lower
        // crossbar end at or above it; a flat has nothing left of its stem), and left of the
        // first stroke, nothing thin (a column run under 0.3 space: a crossbar's end is thicker)
        const fx0 = Math.min(...stk.map((k) => k.x0)), lx0 = Math.max(...stk.map((k) => k.x0)), foot = Math.min(...stk.map((k) => k.bot)) + 0.45 * S;
        const thin = (x, y) => { let a = y, b = y; while (a > 0 && m[(a - 1) * cw + x]) a--; while (b < ch - 1 && m[(b + 1) * cw + x]) b++; return b - a + 1 <= 0.3 * S; };
        const ncw = kx1 - kx0 + 1, nch = ky1 - ky0 + 1, nm = new Uint8Array(ncw * nch); let nn = 0;
        for (let y = ky0; y <= ky1; y++) for (let x = kx0; x <= kx1; x++) if (m[y * cw + x] && !(x < lx0 && y > foot) && !(x < fx0 && thin(x, y))) { nm[(y - ky0) * ncw + x - kx0] = 1; nn++; }
        c = { ...c, x0: x0 + kx0, x1: x0 + kx1, y0: y0 + ky0, y1: y0 + ky1, n: nn, cx: x0 + (kx0 + kx1) / 2, cy: y0 + (ky0 + ky1) / 2, mask: { m: nm, cw: ncw, ch: nch } };
      }
      if (c.x1 - c.x0 + 1 > 1.5 * S || c.y1 - c.y0 + 1 > 3.5 * S) continue;
      const a = classifyAccidental(L, w, c, S, t);
      if (!a || a.type === -2 || a.type === 2) continue;
      const pf = pOfY(n.st, a.ref, c.cx), p = Math.round(pf);
      if (Math.abs(p - n.p) > 1 || Math.abs(pf - n.p) > 0.7) continue;
      accs.push({ st: n.st, c, type: a.type, ref: a.ref, p: n.p, pf, fused: true });
      for (const o of others) if (blob(o) && o.x >= c.x0 - 0.2 * S && o.x <= c.x1 + 0.2 * S && o.y >= c.y0 && o.y <= c.y1) o.fusedBlob = true;
    }
    if (notes.some((n) => n.fusedBlob)) notes = notes.filter((n) => !n.fusedBlob);
  }
  // local accidentals: nearest head to the right at the same position
  for (const a of accs) {
    if (a.isKey) continue;
    const S = spaceAt(a.st, a.c.cx);
    // the glyph's own right edge: a component that runs on past it (a natural fused with the
    // tenuto dash under the next note, p. 2, bar 114, two spaces wide) would put the head it
    // marks inside the component, and the accidental went to the note after
    const fusedRight = a.c.x1 - a.c.x0 + 1 > 1.5 * S, ax1 = fusedRight ? a.c.x0 + (a.type === -1 || a.type === -2 ? 1.0 : 1.2) * S : a.c.x1;
    let best = null, bd = 3 * S;
    for (const n of notes) {
      if (n.st !== a.st || Math.abs(n.p - a.p) > 0) continue;
      const dx = n.box[0] - ax1;
      if (dx > -(fusedRight ? 0.6 : 0.4) * S && dx < bd) { bd = dx; best = n; }
    }
    // An accidental read half a step off: a flat whose bowl's bottom is lost to the stem of the
    // note it touches (Sibelius 2 viola, p. 4: E♭ before a half note read a step low, so it found
    // no head). Only for one hugging its note, the position within 0.7 of a step of the head's.
    if (!best) for (const n of notes) {
      if (n.st !== a.st || Math.abs(n.p - a.p) !== 1 || Math.abs(n.p - (a.pf ?? a.p)) > 0.7) continue;
      const dx = n.box[0] - ax1;
      if (dx > -0.4 * S && dx < 1.0 * S && (!best || dx < bd)) { bd = dx; best = n; }
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
  // A page can hold several pieces in different keys (audition sheets, études): a key that
  // two or more staves read is real and is never voted away. A staff whose reading nobody
  // shares takes the confirmed key of the same kind closest in count, then the nearest staff's.
  const count = new Map(); for (const st of staves) if (st.key.detected) count.set(st.key.detected, (count.get(st.key.detected) || 0) + 1);
  const confirmed = [...count].filter(([, n]) => n >= 2).map(([k]) => k);
  const nearestKey = (st, ok) => {
    for (let d = 1; d < staves.length; d++) for (const o of [staves[st.index + d], staves[st.index - d]]) if (o && ok(o.key.detected)) return o.key.detected;
    return 0;
  };
  // in a part, two staves in a row with no key signature and nothing key-like after the clef
  // are a section in C / a minor (a page can end one movement and start another): no key is
  // inferred for them. (On old scans a signature is often missed on two staves in a row; its
  // glyphs are still there as ink, so those staves still get the page's key.)
  // (an accidental hugging the first note is that note's, not key ink: Sibelius 2 viola, p. 3-4,
  // a C section whose staves open on F♯ or C♯ read as D major)
  const hugging = new Set();
  for (const n of notes) if (n.accid && n.accidDx < 0.8 * spaceAt(n.st, n.x)) n.accid.ids.forEach((i) => hugging.add(i));
  const keyInk = (o) => {
    const S = spaceAt(o, o.key.x0), first = Math.min(o.x1, ...notes.filter((q) => q.st === o).map((q) => q.box[0]));
    const ya = lineY(o, 0, o.key.x0), yb = lineY(o, 4, o.key.x0);
    return cc.comps.some((c) => {
      if (!c || hugging.has(c.id)) return false;
      if (c.x0 < o.key.x0 - 0.2 * S || c.x1 > Math.min(first, o.key.x0 + 3 * S) || c.y1 - c.y0 < 1.2 * S || c.x1 - c.x0 > 1.6 * S || c.y1 <= ya || c.y0 >= yb) return false;
      if (opts.glyphnet === false) return true;
      const pr = classify(bin, [c.x0, c.y0, c.x1, c.y1]); // (time-signature digits are not sharps or flats)
      return pr.sharp + pr.flat > 0.5;
    });
  };
  // (also with opts.fifths: a staff that prints no key starts from the previous page's, and the
  // page's own readings still correct it)
  for (const st of staves) {
    if (st.key.cancellation) continue; // printed naturals are a key: C / a minor
    const sys = sysOf(st);
    let k = sys.length >= 3 && plural(sys);
    // in a part, a key change inside the previous staff carries into this one (its signature is
    // the strongest evidence there is, stronger than what the rest of the page reads)
    const prev = staves[st.index - 1], endK = sys.length < 2 && prev?.keyChanges?.length ? prev.keyChanges[prev.keyChanges.length - 1].fifths : null;
    if (!k && endK != null && st.key.detected !== endK && (!st.key.detected || (Math.sign(st.key.detected) === Math.sign(endK) && Math.abs(st.key.detected) < Math.abs(endK)))) k = endK;
    const fromPrev = k === endK && k != null;
    if (!k && st.key.detected && confirmed.includes(st.key.detected)) continue;
    // keylessSection marks the reading as evidence (zero, not "none found"), so a key carried
    // over from the previous page does not fill it in
    // (so is a system of staves none of which prints a key or has key-like ink: Sibelius 2
    // viola, p. 4, divisi systems in a C section, where the page's D major was filled in)
    const bare = (o) => o && !o.key.detected && !o.keyChanges?.length && !keyInk(o);
    if (!k && !st.key.detected && !keyInk(st) && (sys.length < 2 ? [staves[st.index - 1], staves[st.index + 1]].some(bare) : sys.every(bare))) {
      st.key.fifths = 0; st.key.keylessSection = true; continue;
    }
    if (!k && st.key.detected) {
      const same = confirmed.filter((c) => Math.sign(c) === Math.sign(st.key.detected));
      const best = Math.min(...same.map((c) => Math.abs(Math.abs(c) - Math.abs(st.key.detected))));
      const near = same.filter((c) => Math.abs(Math.abs(c) - Math.abs(st.key.detected)) === best);
      k = near.length === 1 ? near[0] : near.length ? nearestKey(st, (v) => near.includes(v)) : 0;
    }
    if (!k) k = nearestKey(st, (v) => confirmed.includes(v)) || plural(staves);
    if (!k || st.key.detected === k) continue;
    if (Math.sign(st.key.detected) === Math.sign(k)) {
      st.key.fifths = k; st.key.inferred = true;
      // one glyph too many read: it is something else (a time signature), not part of the key
      // (leading naturals are a cancellation, not counted)
      const n = Math.abs(k), K = st.key;
      let nat = K.glyphs.findIndex((g) => g.type !== 0); if (nat < 0) nat = K.glyphs.length;
      if (K.glyphs.length - nat > n) { const keep = nat + n; K.idsPer = K.idsPer.slice(0, keep); K.glyphs = K.glyphs.slice(0, keep); K.ids = K.idsPer.flat(); K.x1 = K.glyphs[keep - 1].box[2]; }
      continue;
    }
    if (st.key.detected) continue;
    const S = spaceAt(st, st.key.x0), first = Math.min(st.x1, ...notes.filter((q) => q.st === st).map((q) => q.box[0]));
    const ya = lineY(st, 0, st.key.x0), yb = lineY(st, 4, st.key.x0);
    const something = cc.comps.some((c) => c && !hugging.has(c.id) && c.x0 >= st.key.x0 - 0.2 * S && c.x1 <= Math.min(first, st.key.x0 + 1.5 * S * Math.abs(k) + S) &&
      c.y1 - c.y0 >= 1.2 * S && c.x1 - c.x0 <= 1.6 * S && c.y1 > ya && c.y0 < yb);
    if (something || fromPrev) { st.key.fifths = k; st.key.inferred = true; }
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
  for (const st of staves) { st.key.ids.forEach((i) => taken.add(i)); st.keyChanges.forEach((k) => k.ids.forEach((i) => taken.add(i))); st.clefChanges.forEach((k) => k.ids.forEach((i) => taken.add(i))); st.bars.forEach((b) => b.ids.forEach((i) => taken.add(i))); }
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
  const piecesIn = (b) => cc.comps.filter((c) => c && c.cx >= b[0] && c.cx <= b[2] && c.cy >= b[1] && c.cy <= b[3] &&
    c.x1 - c.x0 <= b[2] - b[0] + 4 && c.y1 - c.y0 <= b[3] - b[1] + 4 && !headComps.has(c.id)).map((c) => c.id);
  for (const st of staves) {
    st.clef.ids = st.clef.box ? piecesIn(st.clef.box) : [];
    for (const k of st.clefChanges) k.ids = piecesIn(k.box);
  }
  readRhythm({ w, h, S0, t, staves, notes, L, comps: cc.comps, accs, dots, headComps, bin, useNet: opts.glyphnet !== false, textIds });
  // the same part on the previous system (ties over the system break), then pitches again with ties
  for (const st of staves) {
    const row = staves.filter((o) => o.system === st.system).indexOf(st);
    st.prevStaff = staves.filter((o) => o.system === st.system - 1)[row] || null;
  }
  for (const st of staves) interpret(st);
  return { w, h, space: S0, thick: t, staves, labels: L, comps: cc.comps, ledgerPx: Int32Array.from(ledgerPx), notes, attach, bin: bin.data, A: norm.A, scale: norm.scale, angle: norm.angle };
}

// Rows of letter-like components (see analyze). Returns a Set of component ids.
export function findText(comps, S, noteComps = new Set(), staves = []) {
  // text sits outside the five lines (tempo, expressions, lyrics); inside are digits and music
  const inStaff = (q) => staves.some((st) => q.cx >= st.x0 && q.cx <= st.x1 && q.cy > lineY(st, 0, q.cx) - 0.2 * S && q.cy < lineY(st, 4, q.cx) + 0.2 * S);
  const c = comps.filter((q) => q && q.y1 - q.y0 + 1 >= 0.45 * S && q.y1 - q.y0 + 1 <= 2.3 * S && q.x1 - q.x0 + 1 >= 0.15 * S && q.x1 - q.x0 + 1 <= 2.4 * S && q.n >= 6)
    .sort((a, b) => a.x0 - b.x0);
  const next = new Map();
  // link each to the nearest component on its right that overlaps it vertically and looks alike
  for (let i = 0; i < c.length; i++) {
    const a = c[i], ha = a.y1 - a.y0 + 1; let best = null;
    for (let j = i + 1; j < c.length && c[j].x0 - a.x1 <= 0.9 * S; j++) {
      const b = c[j], hb = b.y1 - b.y0 + 1, gap = b.x0 - a.x1;
      if (gap < -0.15 * S) continue;
      const ov = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      // letters share an x-height band: most of the smaller one overlaps the other
      if (ov < 0.55 * Math.min(ha, hb) || Math.max(ha, hb) > 2.6 * Math.min(ha, hb)) continue;
      if (!best || gap < best.gap) best = { b, gap };
    }
    if (best) next.set(a, best);
  }
  const prevOf = new Map(); for (const [a, { b }] of next) if (!prevOf.has(b) || prevOf.get(b).gap > next.get(a).gap) prevOf.set(b, { a, gap: next.get(a).gap });
  const out = new Set();
  for (const a of c) {
    if (prevOf.has(a) && prevOf.get(a).a && next.get(prevOf.get(a).a)?.b === a) continue; // not a chain start
    const chain = [a]; let gaps = [];
    for (let q = a; next.has(q) && prevOf.get(next.get(q).b)?.a === q; ) { gaps.push(next.get(q).gap); q = next.get(q).b; chain.push(q); }
    // three or more letters; or two tightly set (a dynamic "pp", "mf")
    // (and most of the row is not read as notes: a row of letters around the "o" that passed)
    const others = chain.filter((q) => !noteComps.has(q.id)).length;
    if (chain.filter(inStaff).length * 2 > chain.length) continue;
    if ((chain.length >= 3 && others >= 2) || (chain.length === 2 && others >= 1 && Math.max(...gaps) <= 0.35 * S)) for (const q of chain) out.add(q.id);
  }
  return out;
}

// Key in effect at x on a staff: the signature, then any key changes inside the staff.
export function keyAt(st, x) {
  let f = st.key.fifths;
  for (const k of st.keyChanges || []) if (k.x0 <= x) f = k.fifths;
  return f;
}

// ---------- the key from the previous page ----------
// A part's key signature is printed on every staff, but OMR misses some (faint scans, a sharp
// touching the clef), and a page whose staves read none at all would be read in C. When the
// previous page of the same part ended in a known key, `analyzeAfter` reads the page again with
// it as the default for staves that print nothing. Printed evidence always wins: a signature, a
// cancellation (naturals alone), a keyless section (`keylessSection`), or any printed key that
// disagrees with the previous page (the part changed key at the page turn) all keep the page's
// own reading.
const printedKey = (k) => !!(k?.cancellation || k?.detected || k?.glyphs?.length);
/** Whether a page's reading should be redone with `fifths` as the previous page's key. */
export function needsPriorKey(staves, fifths) {
  if (!Array.isArray(staves) || !Number.isInteger(fifths)) return false;
  const missing = staves.some((st) => st.key && !st.key.keylessSection && !printedKey(st.key));
  return missing && staves.filter((st) => printedKey(st.key)).every((st) => st.key.fifths === fifths);
}
/**
 * Give staves that print no key the previous page's key, then re-read pitches from the first
 * staff changed on (ties carry pitches across system breaks). Returns the staves changed.
 */
export function applyPriorKey(staves, fifths) {
  if (!Array.isArray(staves) || !Number.isInteger(fifths)) return 0;
  if (staves.some((st) => printedKey(st.key) && st.key.fifths !== fifths)) return 0;
  let changed = 0, first = staves.length;
  staves.forEach((st, i) => {
    if (!st.key || st.key.keylessSection || printedKey(st.key)) return;
    st.key.fifths = fifths; st.key.documentInferred = true; changed++; first = Math.min(first, i);
  });
  for (let i = first; i < staves.length; i++) interpret(staves[i]);
  return changed;
}
/** analyze() for a page that follows one ending in `fifths` (null: unknown, a plain analyze). */
export function analyzeAfter(norm, fifths, opts = {}) {
  let model = analyze(norm, opts);
  if (!Number.isInteger(fifths)) return model;
  if (needsPriorKey(model.staves, fifths)) model = analyze(norm, { ...opts, fifths });
  applyPriorKey(model.staves, fifths);
  return model;
}
// Pitches from clef + key + accidentals (re-run after a manual correction).
// A tied note keeps the pitch it is tied from, also across a barline or a system break where the
// bar's accidentals no longer apply (F♯ tied into the next bar stays F♯ without a new sharp).
export function interpret(st) {
  const clef = CLEFS[st.clef.type];
  // n.clef: a clef change inside the staff before the note
  const ps = readStaff(st.notes.map((n) => ({ p: n.p, acc: n.accid ? n.accid.type : null, bar: n.bar, fifths: keyAt(st, n.x), clef: st.clefChanges?.length ? CLEFS[clefAt(st, n.x)] : undefined })), clef, st.key.fifths);
  st.notes.forEach((n, i) => { n.pitch = ps[i]; n.name = nameOf(ps[i]); });
  const tied = (n) => (n.fix && n.fix.tie !== undefined ? n.fix.tie : n.tie);
  // ties into the first chord of this staff from the end of the previous one (same part)
  let from = st.prevStaff ? st.prevStaff.notes.filter((n) => n.chord === Math.max(...st.prevStaff.notes.map((q) => q.chord)) && tied(n)) : [];
  const chords = [...new Set(st.notes.map((n) => n.chord))].sort((a, b) => a - b);
  for (const c of chords) {
    const ns = st.notes.filter((n) => n.chord === c);
    for (const n of ns) {
      if (n.accid) continue;
      const src = from.find((q) => (q.st === st ? q.p === n.p : q.pitch.d === n.pitch.d));
      if (src && src.pitch.alter !== n.pitch.alter) { n.pitch = { d: n.pitch.d, alter: src.pitch.alter }; n.name = nameOf(n.pitch); }
    }
    from = ns.filter(tied);
  }
}

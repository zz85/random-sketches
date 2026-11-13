// Reading the players' names off a broadcast score bug: a small template OCR for capitals.
//
// The bug is found by overlays.js (axis-aligned graphic boxes). Inside it each pixel is compared with
// the mean brightness around it, in both polarities (light letters on a dark box, dark on a light
// one), since a bug is several boxes of different colours, some with gradients; where the two
// readings overlap, the one that reads more letters well wins. Letters are connected components of
// one height on one line (a letter broken in two is joined, letters touching are cut where the
// letters' errors are lowest); words are runs of letters with small gaps, both in box and in ink.
// Each letter's grey levels are scaled to a 12 x 16 grid and matched against A-Z / 0-9 templates by
// pixel difference plus a chamfer distance both ways (so stroke weight matters little and a missing
// stroke, the leg of an R, a lot), with a second look at only the differing cells when two letters
// come close. The templates are embedded below: rendered from Helvetica / Helvetica Narrow / DejaVu /
// Noto / Droid / Cantarell / URW Gothic in four weights, monoline stroke capitals for DIN-like
// faces, and letters read off PSA score bugs (the dark 2019+ bar and the light 2015-2019 one). So
// the result does not depend on the fonts of the machine it runs on.
//
//   makeGlyphs(document) -> templates          (document is no longer used; kept for the API)
//   readBug(rgba, W, H, rect, glyphs) -> [{ text, err, x0, x1, y0, y1, chars }]
//   playerNames(rgba, W, H, rects, glyphs) -> { left, right, err, leftErr, rightErr, rect, words } | null
const GW = 12, GH = 16, N = GW * GH;
// match error = A_L1 x pixel difference + A_CH x chamfer distance both ways + aspect term;
// A_PAIR weights the second look at two close candidates; A_SPLIT is the cost of one more letter
// when a component is cut (in letter heights, against width-weighted errors)
const A_L1 = 0.15, A_CH = 0.15, A_PAIR = 0.45, A_SPLIT = 0.03;

// words in score bugs that are not names
const STOP = new Set(['MATCH', 'GAME', 'BALL', 'POINT', 'SET', 'BEST', 'OF', 'VS', 'THE', 'AND', 'FINAL', 'SEMI', 'QUARTER', 'ROUND', 'LIVE', 'REPLAY', 'PSA', 'WSF', 'TOUR', 'SQUASH', 'SERVE', 'SERVER', 'REVIEW', 'LET', 'STROKE', 'NO', 'TIME', 'OUT', 'GAMES', 'SUDDEN', 'DEATH', 'CHAMPIONSHIP', 'OPEN', 'WORLD', 'CUP']);

let cached = null;
export function makeGlyphs(_doc) {
  if (cached) return cached;
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', out = [];
  let psa = false;
  for (const line of TEMPLATES.split('\n')) {
    if (line[0] === '#') { psa = true; continue; }
    if (line.length < 3) continue;
    const v = new Float32Array(N);
    for (let i = 0; i < N / 3; i++) { const b = B64.indexOf(line[3 + i]); v[3 * i] = (b >> 4) / 3; v[3 * i + 1] = ((b >> 2) & 3) / 3; v[3 * i + 2] = (b & 3) / 3; }
    out.push({ ch: line[0], aspect: parseInt(line.slice(1, 3), 36) / 100, v, dt: distances(v), ink: v.reduce((a, b) => a + b, 0), c: coarse(v), psa });
  }
  return (cached = out);
}

// area-average of the values P (0..1) inside box [x0, y0, x1, y1) into GW x GH
function norm(P, w, x0, y0, x1, y1) {
  const v = new Float32Array(N), bw = x1 - x0, bh = y1 - y0;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const ax = x0 + i * bw / GW, bx = x0 + (i + 1) * bw / GW, ay = y0 + j * bh / GH, by = y0 + (j + 1) * bh / GH;
    let s = 0, n = 0;
    for (let y = Math.floor(ay); y < Math.ceil(by); y++) for (let x = Math.floor(ax); x < Math.ceil(bx); x++) {
      const wx = Math.min(x + 1, bx) - Math.max(x, ax), wy = Math.min(y + 1, by) - Math.max(y, ay); if (wx <= 0 || wy <= 0) continue;
      s += P[y * w + x] * wx * wy; n += wx * wy;
    }
    v[j * GW + i] = n ? s / n : 0;
  }
  return v;
}
// distance (in cells, capped) from each cell to the nearest inked cell of a grid: a stroke drawn a
// cell thicker or thinner costs little, a stroke missing altogether (the leg of an R) costs a lot
function distances(v) {
  // two-pass chamfer transform (1, 1.4), capped at 5 cells
  const d = new Float32Array(N);
  for (let i = 0; i < N; i++) d[i] = v[i] >= 0.5 ? 0 : 5;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
    const i = y * GW + x; let m = d[i];
    if (x > 0 && d[i - 1] + 1 < m) m = d[i - 1] + 1;
    if (y > 0) { if (d[i - GW] + 1 < m) m = d[i - GW] + 1; if (x > 0 && d[i - GW - 1] + 1.4 < m) m = d[i - GW - 1] + 1.4; if (x < GW - 1 && d[i - GW + 1] + 1.4 < m) m = d[i - GW + 1] + 1.4; }
    d[i] = m;
  }
  for (let y = GH - 1; y >= 0; y--) for (let x = GW - 1; x >= 0; x--) {
    const i = y * GW + x; let m = d[i];
    if (x < GW - 1 && d[i + 1] + 1 < m) m = d[i + 1] + 1;
    if (y < GH - 1) { if (d[i + GW] + 1 < m) m = d[i + GW] + 1; if (x < GW - 1 && d[i + GW + 1] + 1.4 < m) m = d[i + GW + 1] + 1.4; if (x > 0 && d[i + GW - 1] + 1.4 < m) m = d[i + GW - 1] + 1.4; }
    d[i] = m;
  }
  return d;
}
// the grid at a third / quarter resolution (4 x 4), for a first cheap pass over the templates
const CN = (GW / 3) * (GH / 4);
function coarse(v) { const c = new Float32Array(CN); for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) c[((j / 4) | 0) * (GW / 3) + ((i / 3) | 0)] += v[j * GW + i] / 12; return c; }
const TOPK = 64;
// k-th smallest (quickselect, reorders a)
function kth(a, k) {
  let lo = 0, hi = a.length - 1;
  while (lo < hi) {
    const p = a[(lo + hi) >> 1]; let i = lo, j = hi;
    while (i <= j) { while (a[i] < p) i++; while (a[j] > p) j--; if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; } }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return a[k];
  }
  return a[k];
}
// best template, and the best of a different character (how sure the match is: margin)
function classify(v, aspect, glyphs) {
  // first pass: coarse grid and aspect, keep the TOPK closest templates
  const vc = coarse(v), sc = new Float32Array(glyphs.length), la = Math.log(aspect + 0.05);
  for (let k = 0; k < glyphs.length; k++) {
    const t = glyphs[k], tc = t.c || (t.c = coarse(t.v)); if (t.la === undefined) t.la = Math.log(t.aspect + 0.05);
    let e = 0; for (let i = 0; i < CN; i++) e += Math.abs(vc[i] - tc[i]); sc[k] = e / CN + 0.25 * Math.abs(la - t.la);
  }
  let pool = glyphs;
  if (glyphs.length > TOPK) { const lim = kth(Float32Array.from(sc), TOPK - 1); pool = []; for (let k = 0; k < glyphs.length; k++) if (sc[k] <= lim) pool.push(glyphs[k]); }
  const best = new Map(), dv = distances(v); let ink = 0; for (let i = 0; i < N; i++) ink += v[i];
  for (const t of pool) {
    const ea = 0.25 * Math.abs(la - (t.la ?? Math.log(t.aspect + 0.05))), cur = best.get(t.ch);
    if (cur && cur.e <= ea) continue;
    let e = 0, ca = 0, cb = 0; for (let i = 0; i < N; i++) { e += Math.abs(v[i] - t.v[i]); ca += v[i] * t.dt[i] * t.dt[i]; cb += t.v[i] * dv[i] * dv[i]; }
    e = A_L1 * e / N + A_CH * (ca / Math.max(1, ink) + cb / Math.max(1, t.ink)) + ea;
    if (!cur || e < cur.e) best.set(t.ch, { e, t });
  }
  let a = null, b = null;
  for (const [ch, r] of best) { if (!a || r.e < a.err) { b = a; a = { ch, err: r.e, t: r.t }; } else if (!b || r.e < b.err) b = { ch, err: r.e, t: r.t }; }
  // the best letter and the best digit, for words that are clearly one or the other (G0HAR, 1O)
  let bl = null, bd = null;
  for (const [ch, r] of best) { if (ch >= 'A') { if (!bl || r.e < bl.err) bl = { ch, err: r.e }; } else if (!bd || r.e < bd.err) bd = { ch, err: r.e }; }
  // two close candidates (R / P, O / D, V / Y): look again at only the cells where their
  // templates differ, the leg of the R, the corners of the D
  if (b && b.err - a.err < 0.08) {
    const disc = (t) => { let s = 0, n = 0; for (let i = 0; i < N; i++) if (Math.abs(a.t.v[i] - b.t.v[i]) >= 0.34) { s += Math.abs(v[i] - t.v[i]); n++; } return n ? s / n : 0; };
    const da = a.err + A_PAIR * disc(a.t), db = b.err + A_PAIR * disc(b.t);
    if (db < da) { const t = a; a = b; b = t; }
    return { ch: a.ch, err: a.err, alt: b.ch, margin: Math.abs(db - da), bl, bd };
  }
  return { ch: a.ch, err: a.err, alt: b ? b.ch : '', margin: b ? b.err - a.err : 1, bl, bd };
}

// Words in one graphic box (rgba pixels). Each word: text, err (mean letter match error), box, and
// chars [{ ch, err, alt, margin }] (margin: how much worse the runner-up `alt` matched; 0 = a
// coin toss). detail: also each letter's grid `v`, aspect `asp`, and the word's polarity `sgn`.
export function readBug(rgba, W, H, rect, glyphs, { detail = false } = {}) {
  const [rx0, ry0, rx1, ry1] = rect.map(Math.round), ox = Math.max(0, rx0), oy = Math.max(0, ry0);
  const w = Math.max(1, Math.min(W, rx1) - ox), h = Math.max(1, Math.min(H, ry1) - oy), L = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = ((oy + y) * W + ox + x) * 4; L[y * w + x] = 0.3 * rgba[o] + 0.59 * rgba[o + 1] + 0.11 * rgba[o + 2]; }
  // local mean over a window about the bar's height (integral image)
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += L[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; } }
  const r = Math.max(4, Math.round(h * 0.6)), D = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = Math.max(0, x - r), c = Math.min(w, x + r + 1), b0 = Math.max(0, y - r), d = Math.min(h, y + r + 1);
    D[y * w + x] = L[y * w + x] - (I[d * (w + 1) + c] - I[b0 * (w + 1) + c] - I[d * (w + 1) + a] + I[b0 * (w + 1) + a]) / ((c - a) * (d - b0));
  }
  // each polarity read on its own; where readings overlap, the polarity that reads more letters
  // well there wins (the other one sees the box around the letters)
  const all = [];
  for (const sgn of [1, -1]) {
    const SD = new Float32Array(w * h); for (let i = 0; i < w * h; i++) SD[i] = sgn * D[i];
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = SD[i] > 28 ? 1 : 0;
    for (const wd of wordsFrom(lettersIn(mask, w, h), w, h, glyphs, ox, oy, SD, detail)) all.push({ ...wd, sgn });
  }
  const over = (k, wd) => Math.min(k.x1, wd.x1) - Math.max(k.x0, wd.x0) > 0.3 * Math.min(k.x1 - k.x0, wd.x1 - wd.x0) && Math.min(k.y1, wd.y1) > Math.max(k.y0, wd.y0);
  const score = (wd) => wd.text.length * (0.25 - wd.err);
  const cl = all.map((_, i) => i), root = (i) => (cl[i] === i ? i : (cl[i] = root(cl[i])));
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (all[i].sgn !== all[j].sgn && over(all[i], all[j])) cl[root(j)] = root(i);
  const kept = [];
  for (const r of new Set(all.map((_, i) => root(i)))) {
    const grp = all.filter((_, i) => root(i) === r), sum = (sg) => grp.filter((x) => x.sgn === sg).reduce((a, x) => a + score(x), 0);
    const sg = sum(1) >= sum(-1) ? 1 : -1; for (const x of grp) if (x.sgn === sg) { if (!detail) delete x.sgn; kept.push(x); }
  }
  return kept.sort((a, b) => a.x0 - b.x0);
}

// Connected components (8-neighbour) of a 0/1 mask: { x0, y0, x1, y1, n, id, lab } with `lab` the
// label image (component k has label k + 1).
function lettersIn(mask, w, h) {
  const lab = new Int32Array(w * h), comps = [], st = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i]) continue;
    const id = comps.length + 1, c = { x0: w, y0: h, x1: -1, y1: -1, n: 0, id, lab }; lab[i] = id; st.push(i);
    while (st.length) {
      const j = st.pop(), x = j % w, y = (j / w) | 0; c.n++;
      if (x < c.x0) c.x0 = x; if (x + 1 > c.x1) c.x1 = x + 1; if (y < c.y0) c.y0 = y; if (y + 1 > c.y1) c.y1 = y + 1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const q = Y * w + X; if (mask[q] && !lab[q]) { lab[q] = id; st.push(q); } }
    }
    comps.push(c);
  }
  return comps;
}

function wordsFrom(comps, w, h, glyphs, ox, oy, SD, detail) {
  if (!comps.length) return [];
  const lab = comps[0].lab;
  // a letter broken into pieces by the threshold (a thin stroke): pieces stacked in one column join
  const parent = comps.map((_, i) => i), find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  // (bars and boxes, much wider than tall, never join)
  const big = comps.filter((c) => (c.y1 - c.y0 >= 3 || c.x1 - c.x0 >= 3) && c.x1 - c.x0 <= 2 * (c.y1 - c.y0) + 3 && c.y1 - c.y0 <= 0.8 * h);
  for (const a of big) for (const b of big) {
    if (a.id >= b.id) continue;
    const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), gap = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
    if (ov >= 0.6 * Math.min(a.x1 - a.x0, b.x1 - b.x0) && gap <= 2 && gap >= -1 && Math.max(a.y1, b.y1) - Math.min(a.y0, b.y0) <= 0.8 * h) parent[find(b.id - 1)] = find(a.id - 1);
  }
  const groups = new Map();
  for (const c of comps) { const g = find(c.id - 1); const G = groups.get(g); if (!G) groups.set(g, { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1, n: c.n, ids: [c.id] }); else { G.x0 = Math.min(G.x0, c.x0); G.y0 = Math.min(G.y0, c.y0); G.x1 = Math.max(G.x1, c.x1); G.y1 = Math.max(G.y1, c.y1); G.n += c.n; G.ids.push(c.id); } }
  // letters: capitals and digits between a sixth and nine tenths of the box tall, not touching its
  // top or bottom (box borders and colour bars do), not long bars
  const cand = [...groups.values()].filter((c) => { const ch = c.y1 - c.y0, cw = c.x1 - c.x0; return ch >= Math.max(7, 0.16 * h) && ch <= 0.9 * h && c.y0 > 0 && c.y1 < h && cw < 4 * ch && c.n > 0.1 * ch * cw && !(c.n > 0.7 * ch * cw && cw > 1.3 * ch); });
  // lines: letters whose tops and bottoms agree, seeded by the most typical letters (those most others agree with), so a line takes the
  // height of its letters rather than of a taller digit or a shorter broken letter
  const agree = (a, c) => { const tol = Math.max(2, 0.15 * (c.y1 - c.y0)); return Math.abs(a.y0 - c.y0) <= tol && Math.abs(a.y1 - c.y1) <= tol; };
  for (const c of cand) c.sup = cand.reduce((n, a) => n + (agree(a, c) ? 1 : 0), 0);
  cand.sort((a, b) => b.sup - a.sup || (b.y1 - b.y0) - (a.y1 - a.y0));
  const lines = [];
  for (const c of cand) {
    const ch = c.y1 - c.y0, tol = Math.max(2, 0.15 * ch);
    let ln = null, bd = Infinity;
    for (const l of lines) { const dd = Math.abs(l.y0 - c.y0) + Math.abs(l.y1 - c.y1); if (Math.abs(l.y0 - c.y0) <= tol && Math.abs(l.y1 - c.y1) <= tol && dd < bd) { bd = dd; ln = l; } }
    if (ln) ln.items.push(c); else lines.push({ y0: c.y0, y1: c.y1, items: [c] });
  }
  // one id image per group, so a group's pixels can be picked out
  const gid = new Int32Array(w * h), owner = new Map();
  [...groups.values()].forEach((g, k) => { for (const id of g.ids) owner.set(id, k + 1); g.k = k + 1; });
  for (let i = 0; i < w * h; i++) if (lab[i]) gid[i] = owner.get(lab[i]);
  const scratch = new Float32Array(w * h);
  // per letter: the contrast of its ink (hi) and of the background around it (lo)
  for (const g of cand) {
    const ink = [], bg = [];
    for (let y = Math.max(0, g.y0 - 1); y < Math.min(h, g.y1 + 1); y++) for (let x = Math.max(0, g.x0 - 1); x < Math.min(w, g.x1 + 1); x++) { const i = y * w + x; if (gid[i] === g.k) ink.push(SD[i]); else if (!gid[i]) bg.push(SD[i]); }
    ink.sort((p, q) => p - q); bg.sort((p, q) => p - q);
    g.hi = ink[Math.floor(ink.length * 0.75)]; g.lo = bg.length ? bg[bg.length >> 1] : 0; if (g.hi - g.lo < 10) g.hi = g.lo + 10;
  }
  const one = (g, x0, x1) => {
    let a = x1, b = g.y1, c = -1, d = -1;
    for (let y = g.y0; y < g.y1; y++) for (let x = x0; x < x1; x++) if (gid[y * w + x] === g.k) { if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
    if (c < 0) return null;
    // the letter's pixels, plus the soft fringe around them (antialiasing) when not another letter's
    const P = scratch;
    for (let y = b; y <= d; y++) for (let x = a; x <= c; x++) { const i = y * w + x, gk = gid[i]; P[i] = gk === g.k || gk === 0 ? Math.min(1, Math.max(0, (SD[i] - g.lo) / (g.hi - g.lo))) : 0; }
    const v = norm(P, w, a, b, c + 1, d + 1);
    return { ...classify(v, (c + 1 - a) / (d + 1 - b), glyphs), x0: a, x1: c + 1, h: d + 1 - b, ...(detail ? { v, asp: (c + 1 - a) / (d + 1 - b) } : {}) };
  };
  // a group as one or more letters: dynamic programme over cut columns (thin columns)
  const read = (g, Hm) => {
    const cw = g.x1 - g.x0;
    const whole = one(g, g.x0, g.x1);
    // narrow, or one clean letter: no need to look for cuts
    if (cw < 0.75 * Hm || (whole && whole.err < 0.07 && cw < 1.1 * Hm)) return [whole];
    const ink = []; for (let x = g.x0; x < g.x1; x++) { let s = 0; for (let y = g.y0; y < g.y1; y++) if (gid[y * w + x] === g.k) s++; ink.push(s); }
    // cut candidates: columns with the least ink locally
    const cuts = [g.x0];
    let cand = [];
    for (let x = g.x0 + 2; x < g.x1 - 2; x++) { const s = ink[x - g.x0]; if (s <= 0.7 * Hm && s <= ink[x - g.x0 - 1] && s < ink[x - g.x0 + 1]) cand.push(x); }
    // at most about three per letter's width, the thinnest
    const cap = Math.ceil(cw / Hm) * 3; if (cand.length > cap) cand = cand.sort((p, q) => ink[p - g.x0] - ink[q - g.x0]).slice(0, cap).sort((p, q) => p - q);
    cuts.push(...cand, g.x1);
    // cost: the letters' errors weighted by their widths, so one letter and several compare fairly
    const n = cuts.length, best = new Array(n).fill(null); best[0] = { cost: 0, seq: [] };
    for (let j = 1; j < n; j++) for (let i = 0; i < j; i++) {
      if (!best[i]) continue;
      const sw = cuts[j] - cuts[i]; if (sw < 0.15 * Hm || (sw > 1.45 * Hm && !(i === 0 && j === n - 1))) continue;
      const r = i === 0 && j === n - 1 ? whole : one(g, cuts[i], cuts[j]);
      // a piece must still be letter-tall
      if (!r || r.h < 0.8 * Hm) continue;
      const cost = best[i].cost + r.err * sw + A_SPLIT * Hm;
      if (!best[j] || cost < best[j].cost) best[j] = { cost, seq: [...best[i].seq, r] };
    }
    return best[n - 1] ? best[n - 1].seq : [whole];
  };
  const inkGap = (a, b) => {
    let m = Infinity;
    for (let y = Math.max(a.y0, b.y0); y < Math.min(a.y1, b.y1); y++) {
      let r = -1, l = -1; for (let x = a.x1 - 1; x >= a.x0; x--) if (gid[y * w + x] === a.k) { r = x; break; }
      for (let x = b.x0; x < b.x1; x++) if (gid[y * w + x] === b.k) { l = x; break; }
      if (r >= 0 && l >= 0 && l - r - 1 < m) m = l - r - 1;
    }
    return m === Infinity ? b.x0 - a.x1 : m;
  };
  const words = [];
  for (const ln of lines) {
    if (ln.items.length < 1) continue;
    ln.items.sort((a, b) => a.x0 - b.x0);
    const hs = ln.items.map((g) => g.y1 - g.y0).sort((p, q) => p - q), Hm = hs[hs.length >> 1];
    // a letter the threshold broke in two side by side (the stem and bowl of a thin R): two narrow
    // neighbours whose ink nearly touches are one letter when they read better as one
    for (let i = 0; i + 1 < ln.items.length; i++) {
      const A = ln.items[i], B = ln.items[i + 1], uw = Math.max(A.x1, B.x1) - A.x0;
      if (A.x1 - A.x0 > 0.75 * Hm || B.x1 - B.x0 > 0.75 * Hm || uw > 1.2 * Hm || inkGap(A, B) > 1) continue;
      const ra = one(A, A.x0, A.x1), rb = one(B, B.x0, B.x1);
      const px = []; for (let y = B.y0; y < B.y1; y++) for (let x = B.x0; x < B.x1; x++) if (gid[y * w + x] === B.k) { px.push(y * w + x); gid[y * w + x] = A.k; }
      const M = { ...A, x1: Math.max(A.x1, B.x1), y0: Math.min(A.y0, B.y0), y1: Math.max(A.y1, B.y1) }, rm = one(M, M.x0, M.x1);
      const sep = (ra ? ra.err * (A.x1 - A.x0) : 1) + (rb ? rb.err * (B.x1 - B.x0) : 1) + 2 * A_SPLIT * Hm, joined = rm ? rm.err * uw + A_SPLIT * Hm : Infinity;
      if (joined < sep) { Object.assign(A, { x1: M.x1, y0: M.y0, y1: M.y1, n: A.n + B.n }); ln.items.splice(i + 1, 1); i--; }
      else for (const q of px) gid[q] = B.k;
    }
    let cur = null, lastX1 = -Infinity, prev = null;
    for (const g of ln.items) {
      // a space is wide both between the boxes and between the ink row by row (E then L is close
      // in ink, L then T is not but its boxes nearly touch)
      if (!cur || (g.x0 - lastX1 > 0.22 * Hm && inkGap(prev, g) > 0.4 * Hm)) { cur = { chars: [], x0: g.x0, x1: g.x1, y0: g.y0, y1: g.y1 }; words.push(cur); }
      cur.chars.push(...read(g, Hm));
      cur.x1 = g.x1; cur.y0 = Math.min(cur.y0, g.y0); cur.y1 = Math.max(cur.y1, g.y1); lastX1 = g.x1; prev = g;
    }
  }
  // a word is letters or digits: a digit in a word of letters is its look-alike letter, and back
  for (const wd of words) {
    const nl = wd.chars.filter((r) => r.ch >= 'A').length, letters = nl * 2 >= wd.chars.length;
    wd.chars = wd.chars.map((r) => { if ((r.ch >= 'A') === letters) return r; const q = letters ? r.bl : r.bd; return q ? { ...r, ch: q.ch, err: q.err, alt: r.ch, margin: 0 } : r; });
  }
  return words.map((wd) => ({ text: wd.chars.map((r) => r.ch).join(''), err: wd.chars.reduce((s, r) => s + r.err, 0) / wd.chars.length, chars: wd.chars.map((r) => ({ ch: r.ch, err: +r.err.toFixed(3), alt: r.alt, margin: +r.margin.toFixed(3), ...(detail ? { v: r.v, asp: r.asp } : {}) })), x0: ox + wd.x0, x1: ox + wd.x1, y0: oy + wd.y0, y1: oy + wd.y1 }));
}

// Could this be a (Latin-script) surname? Rejects what letter-reading mistakes typically make:
// no vowel, five consonants in a row, a letter three times running, or a doubled letter names
// almost never have but splitting produces (W read as VV, M as IVI, a U cut in two).
function plausible(word) {
  if (word.length >= 3 && !/[AEIOUY]/.test(word)) return false;
  if (/[^AEIOUY]{5}/.test(word) || /(.)\1\1/.test(word)) return false;
  return !/(VV|WW|UU|JJ|QQ|XX|YY|KK|HH|II)/.test(word);
}

// The two names on a score bug: on the widest graphic box, the letter words (3+ letters, not a
// caption word, plausible as a name), joined into a name when adjacent (EL WELILY); the leftmost and
// the rightmost name, with the score between them. Null unless all of that holds.
// err is the worse of the two names' mean letter errors. On PSA bugs a right name reads at
// 0.05-0.10 (median 0.075, 99% under 0.14); misreads seen without the PSA letters were 0.09-0.17.
export function playerNames(rgba, W, H, rects, glyphs, { maxErr = 0.16 } = {}) {
  const R = rects.filter((r) => r[2] - r[0] > 0.2 * W && r[3] - r[1] < 0.12 * H).sort((a, b) => (b[2] - b[0]) - (a[2] - a[0]))[0];
  if (!R) return null;
  const words = readBug(rgba, W, H, R, glyphs);
  const names = []; let cur = null;
  for (const wd of words) {
    const isName = /^[A-Z]{2,}$/.test(wd.text) && wd.err < maxErr && !STOP.has(wd.text) && plausible(wd.text);
    if (!isName) { cur = null; continue; }
    if (cur && wd.x0 - cur.x1 < 1.6 * (wd.y1 - wd.y0)) { cur.text += ' ' + wd.text; cur.x1 = wd.x1; cur.err = Math.max(cur.err, wd.err); }
    else { cur = { ...wd }; names.push(cur); }
  }
  const good = names.filter((n) => n.text.replace(/ /g, '').length >= 3);
  if (good.length < 2) return null;
  const mid = (R[0] + R[2]) / 2, left = good[0], right = good[good.length - 1];
  if (!((left.x0 + left.x1) / 2 < mid && (right.x0 + right.x1) / 2 > mid)) return null;
  // a score bug has the score between the names, and no other clean words: a banner (MANCHESTER
  // OPEN 2019, TOURNAMENT OF CHAMPIONS) does not. (A box edge read as XJI is not a clean word.)
  const between = words.filter((wd) => wd.x0 >= left.x1 && wd.x1 <= right.x0);
  if (!between.some((wd) => /^[0-9]+$/.test(wd.text) && wd.err < maxErr)) return null;
  if (between.some((wd) => /^[A-Z]{2,}$/.test(wd.text) && wd.err < 0.12 && !STOP.has(wd.text) && plausible(wd.text))) return null;
  return { left: left.text, right: right.text, err: Math.max(left.err, right.err), leftErr: left.err, rightErr: right.err, rect: R, words };
}

// @templates-begin
const TEMPLATES = `
A2fAH0AAL4AAP8AAetAAtdAA8OAB4LAB0HQCwHgD6rwH//0LVV4PAA8eAAttAAd8AAe
B22//+Q/qv08AC88AA98AAt8AA89AG0///g+qr48AAt8AAf8AAP8AAf8AAu/qr4///g
C2aAb+AC+v0LgB8PAAttAAesAAA4AAA4AAA4AAA4AAA8AAPtAAefAAtLgB8C+v0Ab+A
D28//5A/q/g8AH48AA98AAt8AAe8AAP8AAP8AAP8AAP8AAe8AAt8AA98AH4/q/g//5A
E1z///+/qqp8AAA8AAA8AAA8AAA9AAA///9+qqp8AAA8AAA8AAA8AAA8AAA/qqq////
F1v/////qqq9AAA9AAA9AAA9AAA9AAA///4+qqk9AAA9AAA9AAA9AAA9AAA9AAA9AAA
G2gAb+QC/v0H0B8PAAddAAKsAAA8AAA4Aaq4Af/8AFbsAALdAALPAAfHkB/C/vnAb5C
H258AAP8AAP8AAP8AAP8AAP8AAP8AAP////+qqv8AAP8AAP8AAP8AAP8AAP8AAP8AAP
I0d////////////////////////////////////////////////////////////////
J1iAAAvAAAvAAAvAAAvAAAvAAAvAAAvAAAvAAAvAAAvpAAv+AAv/AA/vQC+P+v4Bv+Q
K278AA98AD08ALg8AuA8C4A8LgA8vAA+/QA/nwA+C4A8A9A8AfA8ALg8AD08AB88AAu
L1p+AAA+AAA+AAA+AAA+AAA+AAA+AAA+AAA+AAA+AAA+AAA+AAA+AAA+AAA/qqq////
M2m9AAf+AAv/AA//QB77gB36gCn5wDX40HX44LH4sKH4cNH4NcH4KsH4H4H4H0H4DwH
N279AAP/AAP/gAP+0AP98AP8uAP8PQP8HgP8C0P8B8P8AuP8APf8AHv8AC/8AB/8AAf
O2kAb5AC+vgLgC4eAAstAAesAAO4AAL4AAL4AAL4AALsAAOtAAeeAAsLgC4C+vgAb5A
P1z///g/qv88AB+8AAf8AAP8AAf8ABu+qr9///g9AAA8AAA8AAA8AAA8AAA8AAA8AAA
Q2gAb5AC+vgLgC4eAAtsAAe4AAO4AAL4AAL4AAL4AALsAAOdANdPQL8H5b4Bv+tAFQK
R28//+Q+qv48AB88AAt8AAt8AAt8AB8+qrw///g8AG48AA88AAs8AAs8AAs8AAt8AAf
S23Bv6AL6v0fQC8tAAttAAZeAAAP5AAG/6QAG/4AAG9UAAe4AAP9AAefQB9L+r4Bv+Q
T27////qr6qADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwA
U238AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAPtAAefQB9H+v0Bv+Q
V2c8AAOtAAeeAAtPAA8LQB4HgC0DwDwC0DgB4HQA8LAAtOAAddAAOsAAL4AAH4AAD0A
W3g0CgHoDwKoDwKcH0OcGkNNKoNNJYcNNccKMMoKcNoHYJkHoK0D0HwD0HwCwDgCwDg
X2eeAAuLQB8HwC0C0HgA8PAAedAAL8AAH0AAH4AAP8AAteAB4LQD0HwHgC4PAA9tAAe
Y2htAAffAAtLQB4DwC0C4HgA8LQAeeAAPtAAH4AADwAACwAACwAACwAACwAACwAACwA
Z24v///aqq/AAA9AAC4AALgAAfQAB9AAD4AALgAAfQAB9AAD4AALgAAvAAA/qqq////
01rAr5AC+vgLgD4fAB9uAAuuAAu9AAe9AAf9AAf9AAfuAAuuAAufAB9LgC4C+vgAv5A
10xAAA/AAC/ABv/r///qqv/AAH/AAH/AAH/AAH/AAH/AAH/AAH/AAH/AAH/AAH/AAH/
21vAv+QH//4LkB9fAAufAAfZAAfAAA+AAG8AAvgAL9AB/QAH0AAPQAAuAAAv///////
31tAv+AH+v0PgC8fAA9uAA9AAB8ABb4AH/gABb4AAA+AAAe9AAfuAAufQB9L+v0Bv+Q
41vAALQAAfQAA/QAC/QALfQAuPQB4PQDwPQLQPQuAPQ+qv6////AAPgAAPQAAPQAAPQ
51uH//9H6qpHgAALgAALQAAPWpAP//0fkG9FAAuAAAfAAAfUAAfuAAufgC9H+v0Bv+A
61rAb+QC+v0H0C9PQAueAAAuAAA9b+Q++v4/gB9+AAv9AAfuAAffAAuLgC9D+v0Av+A
71w////////AAAtAAC4AAHgAAPAAAtAAB4AAC0AAHwAALQAAfAAAuAAA9AAB8AAC8AA
81tAv+AH+v0LgC8fQA9fAA9PQB8H6b0B//gL0G8fAAuuAAftAAfuAAvfgB9H+v0Av+Q
91rBv5AH+vgfgC4+AA99AAu9AAu+AAvvQC/L+vvBv5fAAAuAAA9uAB8fQH4H+vgBv5A
A2jAL4AAP8AAP9AAv+AAuuAA+vAB9fQC8PgD4LwH0H0L//4L//4P6r8fQB9vAA++AA/
B28//+Q///4/qv8/AC9/AB+/AC9/qr4///g///4/AG9/AA//AA//AB//qv9///4///g
C2dAb+AC//0L+v8P0C+fgA+vAAV/AAA/AAA/AAA/AAAvAAqfgA+P0C+L+v8C//0Ab+A
D2b//6A///w/qv4/AH9/AC+/AB//AA//AA//AA//AA//AB//AC+/AH9/q/4///w//5A
E22///+///+/qqp/QAA/QAA/QAA/qqo///8///8/QAA/QAA/QAA/QAA/qqq////////
F1y/////////6qq/gAA/gAA/gAA/6qo///8///8/gAA/gAA/gAA/gAA/gAA/gAA/gAA
G2gAb+QC//0H+v9P0B+fQAvvAAA+AAA+Aaq+Af//Af/vAAffgAvP0C/H/v/C//bAb5G
H29/AA//AA//AA//AA//AA//QB//////////qq//AA//AA//AA//AA//AA//AA//AA/
J1rAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/VQD//wD//wD/v0H+f+v9L//4Bv6Q
K2f/AH9/AP0/Avg/B+A/H8A/P0A/vQA//QA//0A/n4A/C9A/A/Q/Afg/AL0/AH9/AC+
L1x/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/6qq////////
M2r/wD//wD//0H//0H//4L/+4Lv+8Pv+sOv+tev+ddv+etv+Osv+P8v+L4v+L4v+H0v
N2b/QA//wA//0A//8A//+A//vA//fg//Lw//D4//C9//A+//Af//AP//AH//AD//AB/
O2kAf9AC//gL+v4P0H8vQB+vAA++AAv+AAv+AAv+AAvvAA+vQB+P0H8L+v4C//gAb5A
P25//+Q///4/qv9/QC+/QB//QB//QC+/lb9///8///g/lUA/QAA/QAA/QAA/QAA/QAA
Q2hAf5AC//gL+v0PgC8fQB9vAA++AAu+AAv+AAuuAEuvAu+fgf9L5b4H//9Bv+uABUI
R29///g///8/qv9/AC+/AB+/AB+/AG9///0///g/qr8/AD8/AC9/AC9/AC9/AC9/AB/
S27Bv+AL//0f6v8vQD9vAB9vgAAf+UAL//kBv/9AAb+AAB//AA/vgB+f6r9L//4Bv+Q
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
C1yAb+AC//0H//8P0C+fgA+vQAVvAAA/AAA/AAAvAAAvQAqfgA+P0C9L//8C//wAf+A
D1y//+A///w/q/4/AH9/AC+/AB+/AA//AA//AA//AB//AB+/AC9/AH8/q/4///g//5A
E1q///+///+/6qq/QAA/QAA/QAA/qqo///8///8/QAA/QAA/QAA/QAA/6qq////////
F1m/////////6qq/gAA/gAA/gAA/qqo///8///8/lVU/gAA/gAA/gAA/gAA/gAA/gAA
G21Ab+AC//0H+r8P0C+fgA/vAAVvAAA/Aaq/Af/vAf/vAAvfgAvP0C/L+v/C//fAb5G
H1v/AA//AA//AA//AA//AA//AA//////////6r//AA//AA//AA//AA//AA//AA//AA/
J1fAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/VQD//gD//gD//wH/v+v+P//4Bv+Q
K20/AH9/Af0/A/g/C+A/L4A/fwA//QA//gA//0A/r8A/D+A/B/Q/Avg/Af0/AL8/AD+
L1m/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA////////////
M28/wC//wD//0D/+0H/+4Hv98Lv98Lf9tOf9tOf9edf9etf9Psf9P8f9L4f9L4f9H0f
N1w/gA//wA//4A//8A//+A/+vA/+Pg/+L0/+D4/+C9/+A+/+Av/+AP/+AH/+AD/+AB/
O23Ab5AC//gL+v4P0D8fQB9vAA+vAAu+AAv+AAvvAAvvAA+fQB9P0D8L+v4C//gAb5A
P1q///g///4/6v+/QC//QB//QB//QC//qr+///8///g/VUA/QAA/QAA/QAA/QAA/QAA
Q20Ab5AC//gL+v4fwC9vQB+vAA++AAv+AAv+AAvvAEvvAe+fgf9P5f8H//9Bv+uAFUJ
R1w///g///4/qv9/AC+/AB+/AB+/AC9///4///w/qv8/AD9/AC9/AC9/AC9/AC9/AB/
S1sBv6AL//wf6v4vQD9vAC9vgAAf+kAL//gBv/8ABv+AAB+/AA/vgB+f6r9L//4Bv+Q
T1v////////qv+qAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4A
U1r/QB//QB//QB//QB//QB//QB//QB//QB//QB//QB//QB//QB/vwH+f+/9L//0Bv+Q
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
F1g/////////////4AA/4AA/4AA/5VV///+///+/5VV/4AA/4AA/4AA/4AA/4AA/4AA
G2wAb5AC//QH//0PgH4fABpuAAA9AAA8AAA8H//9H//uGq+fAB9P0H8H//0C//gAb5A
H21/QA//QA//QA//QA//QA//QA//qq//////////VV//QA//QA//QA//QA//QA//QA/
J1iAAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAH//0L+v//9L//4Bv+Q
K20/QD+/QL8/Qf0/R/Q/T+A/b4A/vwA//QA//QA/vwA/b4A/T+A/R/Q/Qf0/QL8/QD+
L1d/4AA/4AA/4AA/4AA/4AA/4AA/4AA/4AA/4AA/4AA/4AA/4AA/4AA////////////
M2y/AA//QB//gC//wD//wD/+0Hv94Lf98Pf9sOf9def9etf9P8f9L4f9H0f9H0f9Dwf
N2a/QAv/wAv/4Av/8Av/+Av/vAv/Pgv/L0v/D4v/B9v/A+v/Af//AP//AH//AC//AB/
O2tAb5AC//gH//0P0H8fAB9uAAu9AAf8AAf8AAf9AAfuAAufAA9P0D8H//0C//gAb5A
P1t//6Q///0///9/gH+/gC//gC//gH+///9///0//6Q/gAA/gAA/gAA/gAA/gAA/gAA
Q2xAb5AC//QH//wPgH4fAB8tAAt9AAu8AAe+pAe//guvv8tfB/9PkP4H//+C///Ab5b
R1w//6Q///0///9/gH+/gC//gB//gC+/lb9///4//+Q/v4A/n+A/i/Q/gv0/gP8/gH+
S1rAb+AD//0L//9P4H9f0BVP5AAL/pAC//kAb/9AAb+AAC/qgB/v0C+f//9H//0Av+A
T1j////////////AP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8A
U1v/gB//gB//gB//gB//gB//gB//gB//gB//gB//gB//gB/vgB/v0H+P//9H//0Av+A
V2k+AAvvAA+fQB9PgB8LgC4HwD0D0HwC4LgB8PQA9fAAueAAftAAP9AAL8AAH4AAD0A
W3c8CgPsDwOtDwedH0deH0tOL4sPLo8LOo4Het0Hte0D9ewD8PwC8PgC4LgB4LQB0HQ
X2i/AB+fgC8L0H4D4PwC9fQA/+AAf9AAL4AAL4AAf9AA/+AC9fQD4PwL0H4fgC8vAB+
Y2dvAA+fgB9LwD8H0H0D4LwB9PQA+vAAf+AAP8AAL4AAH0AAH0AAH0AAH0AAH0AAH0A
Z1qv//9v//9v//9AAf8AA/0AC/gAH/AAP9AAv0AB/gAD/AAL9AAf4AA////////////
01sBv+QH//4f+v9vgC+/QB//QA//QA//QA//QA//QA//QA//QB/vgC/f+v9H//4Bv+Q
10u////////qr//AD//AD//AD//AD//AD//AD//AD//AD//AD//AD//AD//AD//AD//
21tAr+QH//0P+v9vwD+/QB/qQB/AAC+AAL9AAv4AC/gAf9AB/0AL+AAv+qqv///v///
31uAf5AC//gH+v0L4L4AAL4ACv0AH/gAH/0ABb9AAC+AAB//QB/vgD+f+v9H//0Av+A
420AALwAAfwAA/wAC/wAH/wAPrwAvLwB9LwH4LwLwLwfQLw////////qqv6AALwAALw
51wC//0D//0D+qkH4AAH0AAL66AL//0P+v8GkD+AAB/AAB//QB/vwD+P+v8H//0Ab+A
61wAB/gAD+AAL8AAf0AA/gAC/qAL//0f//9v0H+/QB//QB//QB/vwC+f+v9H//0Av+A
71n////////qqr/AAH+AAL8AAf0AA/wAC/QAH+AAL9AAf4AA/0AB/gAD/AAL9AAf8AA
81sAb5AC//wL+v4P0H8P0D8L4L8D//0H//0f+v9vgC//QB//QB/vgC+f+v9H//0Av+Q
91wAv+AH//0P+v9vgD+/QB//QB//QB/v0H+f//9H//4Aq/gAC/AAH9AAP4AAvwAC/QA
A2pADwAAH0AAL4AAP8AAf9AAv+AA+vAB9fQC+vgD//wH//0L//4PwD8fgC9vQB+/AA/
B1t/+pA///g///4/1v8/wP8/wv4///0///0///9/1b+/wD//wD//1v////9///0//pA
C2oAKpAB//gH//4L+b9fgB+vQAV/AAA+AAA+AAA/AAAvQAVfwB+L+b9H//4B//gAK5A
D28/6kA///Q///0/m/8/QL9/QC+/QB//QB//QB//QB//QC+/QL9/m/8///0///Q/6kA
E1j/////////////5VV/4AA/4AA/+qp///+///+/+qq/4AA/4AA/5VV////////////
F1g/////////////9VV/8AA/8AA/+qp///+///+/+qq/8AA/8AA/8AA/8AA/8AA/8AA
G2vAapAB//QH//0P5f8fgC9vAAV+AAA+Gqq+H//+H//vGr+fgC9P5b8H//0B//gAa5A
H21/QC//QC//QC//QC//QC//QC//6r//////////qr//QC//QC//QC//QC//QC//QC/
J1jAAL/AAL/AAL/AAL/AAL/AAL/AAL/AAL/AAL/AAL/AAL/qkL/v+v/f//9H//0Aa6Q
K21/QH+/Qf8/Q/0/S/Q/X+A/v8A//wA//QA//gA//0A/v8A/X+A/S/g/Q/0/Qf8/QH+
L1f/8AA/8AA/8AA/8AA/8AA/8AA/8AA/8AA/8AA/8AA/8AA/8AA/9VV////////////
M2v/QB//gC//wC//wD//0H//4L//8L/+8Pv99fv9uuf9f9f9P8f9P8f9L4f9H0f9Dwf
N29/gB//0B//4B//9B//+B///R//vh//f1//H5//C+//B///Av//Af//AL//AH//AC/
O2sAKpAB//gH//0P9b8fgC9vAA++AAv+AAv+AAv+AAvvQA+fgC9P9b8H//0B//gAK5A
P1s//qA///0///9/1v//wD//wD//1b////+///4//+Q/1AA/wAA/wAA/wAA/wAA/wAA
Q2wAaoAB//QH//0P5v4fgC9vAA++AAu+AAu/+Qu//4uv/++fh/9P9v9H///B///Aa5b
R1x//pA///g///4/lv9/gH+/gD+/gH9/6v9///0//+Q//8A/r+A/j/Q/h/0/gv8/gL+
S1sAapAC//wL//8f9v9f4L+f9AAP/5AH//0Af/9ABv+VQH//0D/v9b+f//8H//0AapA
T1l////////////Vv+VAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9A
U1v/gC//gC//gC//gC//gC//gC//gC//gC//gC//gC//gC//wD+v+v+P//8D//wAapA
V2k/AA/vQB+fgC9PwC8LwD4H0H0D4LwC8PgB9fgA+vQAv/AAf+AAf9AAP8AAL4AAD0A
W3b9DwftDweuH0ueH0tfH09PL48Pb58Lf94Huu0H+v0D9fwD9fwC8PgC8PgB4LQB4LA
X2k/gB/fwD9L4H4H8P0C+vgA//AAv+AAP8AAP8AAf+AA//AC+vgH8P0L4L4fwD9/gB/
Y2d/QB/fwC9P0H8H4L4D9PwC+vgA//QAv+AAf9AAL4AAL4AAL4AAL4AAL4AAL4AAL4A
Z1sv//9v//+v//+VVv9AB/0AD/gAL/QAf9AA/4AC/0AH/QAP+AAv+VV////////////
01uAaqAH//0P//9v5b+vwD//gC//gC//gC//gC//gC//gC/vwD/v5b+P//9H//0Aa6A
10x////////////Vb//AL//AL//AL//AL//AL//AL//AL//AL//AL//AL//AL//AL//
21sAapAH//0P//9v5b+/wD//gD/AAH/AAf+AB/4AL/gAv+AH/0Af/lV////////////
31uAa5AC//gH//0L9f4GoP4AG/4AL/wAL/4AGv+AAH/VQC//wD/v5b+P//9H//0Aa5A
420AAL0AAf0AA/0AC/0AL/0Af/0A/v0C/f0H9P0P4P0v6v6////////qqv6AAP0AAP0
51vC//4D//4H//4H9VUL8AAL/+QP//0f//9L4L+AAC/VQC//wD/v5b+P//8H//0AbpA
61yAB/wAD/QAL+AAf4AA/wAC/6QL//0f//9v5b+vwD/vgC/vwD+f5b9P//8C//0Aa5A
71o////////////VVf+AAf8AA/4AC/wAD/QAL/AAf9AAv4AB/0AD/gAL/AAP+AAv8AA
81uAa5AC//gH//0L9f4L4L8L+f4H//0H//0f//9v4H+/wC/vwD/v5b+P//8H//0AapA
91wAbpAH//gf//4v5b9/gD+/gC//gD+/5b+f//8H//0Br/gAH/AAP9AAv4AC/gAH/QA
A2iADwAAH0AAL4AAOsAAddAAsOAA4LAB0HQCwDgDgDwH//0L//4PAA8eAAttAAe8AAP
B1z//+Q/qv09AC89AA99AA99AB8+Vb0///Q+Vb49AA99AAf9AAf9AAv9AB+/qv4//+Q
C26AL/kB/q+H4ALPQABfAAAuAAAtAAA9AAA9AAAtAAAuAAAfAAAPQABH4ALB/q+AL/k
D2c//oA/r/g8AL48AB88AAu8AAe8AAP8AAP8AAP8AAP8AAe8AAu8AB98AH4/q/g//oA
E1u///+/qqq+AAA+AAA+AAA+AAA+VVU///9+VVU+AAA+AAA+AAA+AAA+AAA/qqq////
F1m/////qqq/AAA/AAA/AAA/AAA/VVU///8/VVU/AAA/AAA/AAA/AAA/AAA/AAA/AAA
G2dAb+gB/r9H0AePQABeAAAtAAAsAAA8AFV8AP/sAFftAAPeAAPPQAPH0AfC/r+Ab/g
H259AAf9AAf9AAf9AAf9AAf9AAf+VVv////+VVv9AAf9AAf9AAf9AAf9AAf9AAf9AAf
J0rAAP/AAP/AAP/AAP/AAP/AAP/AAP/AAP/AAP/AAP/AAP/AAP/AAP/AAv9Vr/0/+pA
K288AC88ALg8AvA8C8A8LwA8uAA+8AA/0AA+8AA9vAA8LwA8C4A8A+A8APg8AH48AB+
M2l/AA//AB//QC/+gCv9wDf80HP84KP8sOP8ddP8OsP8L4P8H0P8DwP8AAP8AAP8AAP
N24/QAP/gAP/0AP+8AP99AP9fAP9LQP9HwP9C0P9B8P9AtP9AfP9ALv9AD/9AC/9AA/
O2hAb9AC+vgHgC4PAA9eAAetAAOsAAP8AAP8AAPsAAPtAAOeAAePAA9HgC4C+vgAb5A
P1u//+Q/qv4+AC9+AA++AAv+AA++AB++Vb8///0/qpA+AAA+AAA+AAA+AAA+AAA+AAA
Q25Ab5AC+vwLgB4eAAttAAesAAP8AAP8AAPsAAPtAAeeAAtLgB4C+rgAb+AAALgAAC0
R25//kA/r/A9Afg9AHg9AHw9AHw9ALg+q/A//4A9V+A9APQ9AHw9AD09AB89AA99AAe
S1wBv+kL+r4fQAUuAAA9AAAuAAAf5QAH/+QAa/4AAG9AAAuAAAvAAAuoAB9v6v4G/+Q
U239AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAftAAfeAAuPgB8H+v0Av+Q
V2i8AAPtAAeeAAtPAA8LQB4HQC0DgDwCwHgB0LQA4LAAsOAAddAAOsAAP4AAL0AAHwA
W3h0CgHoDwKoDwKcGkNcGkNcKoNNJYcNNccKMMoKMMoHYJ0HYJ0DoKwD0HwC0HgCwDg
X2cPAAuHgB8D0C0B4HgAtPAAPuAAL8AAD0AAL4AAftAAtfAB4LgDwDwLgB4fAAttAAf
Y2atAAffAAtLgB4D0DwB4LgAtfAAftAAL4AADwAADwAADwAADwAADwAADwAADwAADwA
Z2bv//+qqq+AAB8AAD0AALgAAeAAB8AAD0AALgAAfAAB9AAC0AALgAAfAAA/qqq////
01vAf9AC+vgLgC4fQB9vAAuuAAutAAe9AAf9AAftAAeuAAufAA9fQB9LgC4C+vgAf9A
11nGr4A//4ApX4AAD4AAD4AAD4AAD4AAD4AAD4AAD4AAD4AAD4AAD4AAD4Aar+qf///
21rG/6A/+/05AG9AAA+AAA+AAA+AAC9AAH4AAfgAB9AAL0AAvQAH9AAfgAA/qqq////
31rK/+Qf6/4UAC9AAA+AAA+AAB9AVb0A//QAVb4AAB+AAAfAAAfAAAvkAG9/6/4a/6A
420AAvgAB/gAD7gALbgAeLgA8LgC0LgHgLgPALgtALg+qv6////VVblAALgAALgAALg
51sf//4fqqofAAAfAAAfAAAfqkAf//gZQb4AAB9AAAuAAAvAAAuAAB+kAH8/6/0a/5A
61uAL/oB/r8H4AEPQAAvAAAuGlA+v/g/1X8/QA+/AAv+AAvuAAvfAAuLgC9D+v0Af+Q
71r////qqr+AAB9AAD4AAH0AALwAAfQAAvAAA+AAC8AAD4AAH0AAPgAAfQAAuAAB9AA
81vBv+QH+v0PgC8fAA9fAA9PQB8H1X0B//QL6r0fQB9uAAutAAfuAAufQB9L+v4Bv+Q
91uBv+AH+vgfgC4uAA9+AAu+AAv+AA/vAB/P1X/C/+fAWkuAAA+AAB8EAL0Pq/QK/oA
A2vAP4AAf8AAf9AAv+AA+/AB+vAC9fQC8fgD4PwH4L0L//4P//4f//8fgC9vQB+/AB/
B29//+Q///4/6/9/gL9/gH9/gL9/6/4///0///9/gH+/gC//gC//gH//6v+///8//+Q
C29AG/oB///H///P+QHf4AAv0AA/wAA/wAA/wAA/wAAv0AAf4AAP+AHH///B///AG/p
D2m//oA///Q///0/Vv8/QL9/QD+/QC+/QB//QB//QC+/QD+/QL9/Vv8///0///Q//oA
E1z///+///+///+/1VU/0AA/0AA///9///9///9/0AA/0AA/0AA/1VU////////////
F1x/////////////0AA/0AA/0AA///9///+///+/5VU/0AA/0AA/0AA/0AA/0AA/0AA
G2kAb/kB//9H//9P9AZv0AAvgAA/QAA/QKq/QP//QP/vgA/v0A/P9A/H///C//+Ab+k
H2i/QC//QC//QC//QC//QC//QC//////////////gC//QC//QC//QC//QC//QC//QC/
J10AC//AC//AC//AC//AC//AC//AC//AC//AC//AC//AC//AC//AH/+Wv/9///k/6kA
K2p/QL8/Qf0/R/Q/T+A/b8A/v0A//QA/+AA//QA//wA/f4A/X+A/S/Q/Q/0/Qf8/QH+
L1y/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA////////////
M33/gC//wD//0H//4L//4P/+8Pv+tev+etv+f8v+P4v+L4v+H0v+Dwv+AAv+AAv+AAv
N2i/wB//4B//8B//9B//+B//vR//fh//bx//X5//S+//R///Q///Qf//QP//QL//QD/
O2rAf9AC//gL//4f4L8vgC+vQB+/QB//QB//QB//QB/vQB+vgC+f0L8L//4C//gAb5A
P28//+Q///4///9/gL//gD//gD//gH//6v+///8///g/1UA/gAA/gAA/gAA/gAA/gAA
Q2cAv+AD//wP+v8fwD9vQB+/QB//QB//QB//QB+vgC+f0H9L//4C//gAWvAAAPwAAH4
R2h//5A///Q///w/Qv0/Qf0/Qf0/Qvw///Q//9A///A/R/g/Qv0/QP4/QL8/QH9/QC/
S23Bv+kL//8v//8/0Bs/gAA/0AAv/pAf//0G//9AGv/AAH/QAC/5QH////+///4Gv+Q
T2k////////////AL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4A
U2b/gC//gC//gC//gC//gC//gC//gC//gC//gC//gC//gC/vwD+v0H+f//8H//0Bv+Q
V2v/AA/vQB+fgC9fgD8PwD4L0H4H4L0D4PwD8fgC9fQB+vQA//AAv+AAv9AAf8AAP8A
W3z8DwPtH0etH0etL0ueL4teKotfOs9POs8Pdd8Pdd4Lse4L8P4H8P0H4L0H4L0D4Lw
X2svgC+P0H8L4L4D9fwC+vgA//AAv+AAP8AAf9AAv+AB//QC+vgH8P0L0H4fwD9vQB+
Y2r/QC/fwD9P0H8H8P0D9fwC+/QA//AAf9AAP8AAL4AAL4AAL4AAL4AAL4AAL4AAL4A
Z2fv//+v//+v//+FVf9AAv0AB/gAD/AAL9AAf4AA/gAC/QAL9AAf5VV////////////
026Af9AD//wL//4f4L9vwD+/wD+/gC//gC//gC//gC//wD+vwD+f4L9L+v4D//wAv9A
11xWv8A//8A//8AlP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8A////////////
21zGrpA///0///85Af+QAL+AAL+AAP9AAv4AC/gAL+AB/4AH/gAf9AA////////////
321K/+Qf//4f//9EAL+AAL+AAL9Aq/4B//gB//4AAf+AAH/AAD/kAL//6/9///4b/6Q
42aAB/wAD/wAL/wAf/wAvvwB9vwD4vwLwvwfQvw+Avw////////////AAvwAAvwAAvw
523f//8f//8f//4fwAAfwAAf6qAf//0f//9ZAf+AAH/AAD/AAH/5AP+/7/9///0Gv5A
625AK+kB//8H/q8P8AEf0AAvxlA///g///8/5L+/0D+/wD/v0D+f4H+L+v9C//0Af+Q
724////////////AAL+AAP8AAf4AA/wAB/gAC/QAH+AAL9AAP8AAv0AA/wAB/gAD/AA
823Bv+QL//4f+v9v0H+vwD+f0H9L+v4C//gL//4v0H+/gD//gC//wD/v+v+L//4Bv+Q
925Bv5AH//gf+v4vwL8/gH9/gH+/wH+v4f/P///H//+AaT+AAH9EAP8Pq/0P//QG/oA
A28ADwAAH4AAL8AAOsAAddAAsOAA4LAB0HQCwDgDgCwH//0L//4PAAseAAttAAe8AAP
B1s//+Q/qv09AC89AA99AA99AB8+Vb0///Q+Vb49AA+9AAf9AAf9AAv9AB+/qv4//+Q
C1yAL/kB/q+H0ALPQABeAAAtAAA9AAA8AAA8AAA9AAAtAAAeAAAPQABH0ALB/q+AL/k
D24//pA/r/g8AH48AB98AAu8AAf8AAP8AAP8AAP8AAP8AAf8AAu8AB98AH4/q/g//oA
E1n///+/qqq+AAA+AAA+AAA+AAA+VVU///9+VVV+AAA+AAA+AAA+AAA+AAA/qqq////
G23Ab/kB/r9H0AaPAABeAAAtAAA8AAA8AFV8AP/8AFftAAPeAAPPAAPL0AfC/r+Ab/g
H1y9AAf9AAf9AAf9AAf9AAf9AAf9VVf////+VVv9AAf9AAf9AAf9AAf9AAf9AAf9AAf
K1z8AC98AL08AvA8C8A8LwA9vQA+8AA/0AA+9AA9vAA8LwA8C4A8A+A8ALg8AD48AA+
M2b/AAv/QA//gB7+wCr9wDb80Hb8oLL8cOL8NdL8OsL8L4L8H0L8DwL8AAL8AAL8AAL
N1x/QAP/gAP/0AP+8AP9tAP9fAP9LQP9HwP9C0P9B8P9AtP9AfP9ALv9AD/9AC/9AA/
O27Ab5AC+vgLgC4fAA9tAAesAAO8AAP8AAP8AAP8AAPsAAOtAAefAA9LgC4C+vgAb5A
P1n//+Q/qv4+AC++AA/+AAv+AAv+AB++Vb9///0/qpA+AAA+AAA+AAA+AAA+AAA+AAA
Q1xAb5AD6rwLQB4eAAttAAe8AAP8AAP8AAP8AAPtAAeeAAtLQB4C6rgAb+AAALQAAC0
R1x//oA/q/A9APg9AHw9ADw9AHw9ALg+q/A//8A9V+A9APQ9AHw9AC09AB89AAt9AAf
S1oBv+kL+r8vQAY9AAA9AAA+AAAf5QAH/+QAa/4AAG+AAAvAAAfAAAv0AB+/6v4W/+Q
U1w9AAP9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAftAAftAAeeAAuPgC8H+v0Av+Q
V288AAPtAAeeAAtPAA8LQB4HQB0DgCwCwDgB0HQA4LAAsOAAddAAOsAAP8AAL4AAH0A
W330CgHkDwHoDwKoHkKcGkNcGYNNJYcNJccKMMcKMMoHYJoHYJ0DoG0D0HwD0DwCwDg
X24fAAuLgB8D0C0B4HgAtPAAfuAAL8AAH0AAL4AAftAAtfAB4LQDwDwLQB4fAA9tAAe
Y23tAAefAA9LgC4DwDwB4LQAteAAf9AAL4AADwAADwAADwAADwAADwAADwAADwAADwA
Z21v//+qqq+AAB9AAD0AALgAAfAAB9AAC0AALgAAfAAB9AAD0AALgAAfAAA/qqq////
01nAv9AD+vwLgC4fAA9uAAu+AAv9AAv9AAf9AAf9AAv+AAvuAAufAA9LgC4D+vwAv+A
11iWv4A//4ApX4AAD4AAD4AAD4AAD4AAD4AAD4AAD4AAD4AAD4AAD4AAD4Aar+qf///
21kGv6Qv+/4pAC9AAA/AAAvAAA/AAB+AAH4AAfgAB+AAL4AAvQAC9AAf0AA/6qq////
31mK/6Qf6/0UAC9AAA+AAA+AAB9AVb0A//QAVb4AAB+AAAvAAAvAAAvkAC9/6/0a/6Q
41tAAfgAA/gAC7gAHXgAOHgAtHgB0HgHgHgPQHgtAHg+qr6////VVblAAHgAAHgAAHg
51kf//4fqqofAAAfAAAfAAAfalAf//gZQb8AAB+AAAvAAAfAAAvAAA/kAH9/6/0a/6A
61oAL/kB/r4H0AEPQAAfAAAuFlA+v/g/5X4/QB9/AAuuAAfuAAefAA+LgC9C+v0Av+A
71m////qqr+AAB9AAD4AAH0AALwAAfQAAvAAB9AAC8AAD4AAH0AAPgAAfQAAuAAB9AA
81nBv+QL+v4fQB9vAA+uAAufAB9L1X4B//QL6r4fQB9+AAv+AAv+AAvvQB9L+v4Bv+Q
91oAv9AH+vgfgC4vAA9tAAu9AAuuAA/fAB/P1b/C/+vAWUuAAA9AAC8EAH0Pq/QG/oA
A2kAP8AAf9AAf9AAv+AA+/AB+vQC9fgD8PgD4PwH4L0L//4P//8f//8fgC9vQB+/AA/
B22//+Q///4/6/8/gL9/gH9/gL9/6/4///w///8/gH+/gD//gD//gH//6/+///4//+Q
C22AG/kB///H///P+AHf4AAv0AAvwAA/gAA/gAAvwAAv0AAf4AAP+AHH///B///AG/k
D2c//pA///g///0/Vv8/QH9/QD+/QC//QB//QB//QC//QC+/QH9/Vv8///0///g//pA
E1s///+///+///+/1VU/0AA/0AA///9///9///9/0AA/0AA/0AA/1VV////////////
F1q/////////////0AA/0AA/0AA///9///9///9/5VU/0AA/0AA/0AA/0AA/0AA/0AA
G2cAL/kB//9H//9P9AZf0AAvgAAvgAA/QKq/QP/vgP/vgA/f0A/P9B/H///C//+Ab/k
H28/QB//QB//QB//QB//QB//QB//////////////gC//QB//QB//QB//QB//QB//QB/
J0wAC//AC//AC//AC//AC//AC//AC//AC//AC//AC//AC//AC//AH//Wv/9///k/+kA
K2f/AL8/Af0/B/g/D+A/L8A/v0A//QA/+AA//QA//wA/f4A/H+A/C/Q/Av0/AP8/AH+
M2s/gC//wD//0H//4L//8P/+8Pv+tev+etv+P8v+P8v+L4v+H0v+Dwv+AAv+AAv+AAv
N28/wB//4B//8B//+B///B//vR//fh//b1//T5//S9//R+//Q///Qf//QP//QH//QD/
O2hAf9AC//gL//4P4H9fgC+vQB+vQA//AA//AA/vQA/vQB+fgC+P4H9L//4C//gAb5A
P21//+Q///4///9/gb+/gD//gD//gH+/6v+///8///g/lUA/gAA/gAA/gAA/gAA/gAA
Q24Av+AC//wL+v8fwD9vgB+vQB//AA//AA/vQB/vgC+f0H9L//4C//gAGvQAAPwAAH4
R27//5A///g///0/Qv0/QP4/QP0/Qvw///Q//9A///Q/R/g/Qf0/QP4/QL9/QD+/QC/
S1wBv+kL//8f//8v0Bs/gAA/0AAv/pAP//0C//9AGv+AAH/QAD/pQH+v//9v//4Gv+Q
U23/gC//gC//gC//gC//gC//gC//gC//gC//gC//gC//gC/vwC/v4H+P//9H//0Bv+Q
V2k/AA/vQB+fgC9fgC9PwD8L0H4H4L0D8PwD8PwC9fgB+vQA//AAv+AAf9AAf9AAP8A
W3l8Hwf9H0etH0etL0ueL4teK4tfOo8PNs8Pdd8Pte4Lse4L8P4L8P0H4P0H4LwD4Lw
X2ivgC+PwH8L4L4D9fwC+vgA//AAv+AAP8AAf8AAv+AB//QC9vgH8P0L0L4fwD9/QC+
Y2h/QC/fwD9P0H8H8P0D9fwB+/QA//AAf9AAP8AAL4AAL0AAL0AAL0AAL0AAL0AAL0A
Z27v//+v//+v//+FVf8AAv0AB/gAD/AAL9AAf0AB/gAD/AAL9AAf5VV////////////
01zAf9AC//gL//4f4L9vwD+vwD+/wC//gC//gC//wC/vwD+vwD+f4L9L+v4C//gAf9A
11qWv8A//9A//9Alf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9A////////////
21sGrpA///0///85Af+QAL+AAH+AAP9AAv4AC/wAL+AB/4AH/QAf9AA////////////
31sa/+Qf//4f//9UAL+AAL+AAL9Aq/4B//gB//8AAf+AAH/AAD/kAL//6/+///4a/6Q
421AB/wAD/wAL/wAf/wA+vwC9vwD4vwLwvwfQvw+Avw////////////AAvwAAvwAAvw
51uf//8f//8f//8fgAAfgAAf6qAf//0f//9VAf+AAH/AAD/AAH/4Af+/7/9///0Gv5A
61yAK+kB//4H/q4P9AEf0AAvxlAv//g///8/9L9v0D+v0C+f0D+f4D+L+v8C//0Af+Q
71v////////////AAL+AAP8AAf4AA/0AB/gAD/QAH+AAL9AAf8AAv0AA/wAC/QAD/AA
81wBv+QL//4f+v9v0H+vwD+f0H9L+v4C//gL//4v0H+/wD//wD/vwD+f+v9L//4Bv+Q
91yBv9AH//gP+v4vwL9vwH9/gH+vwH+v4f/P///H//+AaT+AAH9EAf8Lq/0L//QG/oA
A2fADwAAH0AAL4AAOsAAddAAsOAA4LAB0HQCwDgD//wH//0LQB4OAA8eAAttAAe4AAL
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
D29//kA///Q9Ab09AC89AA99AAu9AAu9AAf9AAf9AAu9AAu9AB99AD89Af0///Q//kA
E1l/////////QAA/QAA/QAA/QAA/lVU///9/6qp/QAA/QAA/QAA/QAA/QAA////////
F1l/////////AAA/AAA/AAA/AAA/AAA/qqp///9/VVU/AAA/AAA/AAA/AAA/AAA/AAA
G28AK/kB//+H5AYPgAAfAAAuAAA9AAA9AKq9Af/9AFvuAAfvAAfPgAfL5AfC///Ab/p
H269AAf9AAf9AAf9AAf9AAf9AAf+VVv/////qq/9AAf9AAf9AAf9AAf9AAf9AAf9AAf
I12////r//6Af9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9Ar//6////
J0uAAL/AAL/AAL/AAL/AAL/AAL/AAL/AAL/AAL/AAL/AAL/AAL/AAL/AAf+qr/4v/pA
K22+AB++AH4+APg+AvA+C8A+L0A+fQA//QA//gA/X4A+C9A+AvA+Afg+AH0+AC9+AA+
L1m/QAA/QAA/QAA/QAA/QAA/QAA/QAA/QAA/QAA/QAA/QAA/QAA/QAA/QAA////////
M2t+AAv/AA//QB/7QB77gCr6wDr50Hb44LL44OL4sNL4ddL4OsL4L4L4L0L4HwL4DgL
N29/AAP/gAP/wAP+4AP99AP8vAP8PQP8LwP8D4P8B9P8AuP8Aff8AL/8AD/8AC/8AA/
O2iAv9AD//gL0H4fAB8uAAu9AAe8AAe8AAP8AAf8AAe9AAeuAAtfAB8L0H4D//gAv9A
P1t//6Q///4/AX9/AB+/AA//AA//AB+/Ab9///0//5A/AAA/AAA/AAA/AAA/AAA/AAA
Q22Av+AH+vwPQC8uAAt9AAe8AAf8AAP8AAe9AAeuAAtPQB8H6r0Bv+AAAfQAAHwAAC8
R22//5A///Q+Af0+AH4+AD4+AD4+AL0+q/Q//9A+q4A+B+A+AvA+APg+AH0+AC8+AB+
S1qBv+kL//9fkBovAAAvAAAvgAAP+AAC/5AAb/0AAb9AAC+AAA+AAA+pAG9///0a/6A
T23////////AH0AADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwAADwA
U259AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAfuAAfvAA+PkG9H//0Av+Q
V2e9AAfuAAufAA9PQB8LgC4HgC0DwDwC0HgB4LQA8PAAteAAetAAetAAP8AAL4AAH0A
W3k4CgHoDwLoDwKsH0OcGkNdKodNKYcONccKNcoKcNoHYJ0HoK0DoLwD0HwD0HwCwDg
X2bvAA9PQB8HwD0C4LgB8PAAuuAAP8AAL0AAL4AAf9AA9fAC4PQH0HwLgC4fAB99AAu
Y29uAAufAA9LgC4HwD0C4LgB8PQAuuAAf9AAL4AAH0AADwAADwAADwAADwAADwAADwA
Z1zv//+v//+AAC9AAH4AAPgAAvAAB9AAH4AALwAAvQAB+AAD4AALwAAfQAA////////
01uAv+AD//wP0H4fQC8vAA9vAA++AAu+AAv+AAv+AAuvAA+vAA+fQC9L0H4D//wAv5A
115AAb/AG//C///v+H/LQH/AAH/AAH/AAH/AAH/AAH/AAH/AAH/AAH/AAH/AAH/AAH/
21vBv+Af//0fUH4EAC8AAB9AAC8AAD4AALwAAvQAC9AAL0AAvQAD9AAf0AA////////
31tGv+Qv//0eQH8AAB9AAB9AAC8AVv0A/+AAq/0AAC9AAA/AAA/AAB+lAH9///0b/6Q
422AAPwAAvwAB/wAD7wALXwAeHwB8HwC0HwLgHwfAHw+qr6////qqr6AAHwAAHwAAHw
51rP//4f//4fQAAfQAAfQAAfAAAvrqAv//0FAb9AAB+AAA/AAA/AAB+lAL9///0b/5A
61tAG/4Bv6oH9AAPwAAfQAAvAAA+b/g++v4/gC++AA++AAvuAAvfQA+P0H9C//0Af+Q
71w////////AAB+AAC8AAD4AALwAAPgAAvAAA+AAC9AAD4AAL0AAfgAAvQAA+AAC9AA
81uBv+QH+v0PgC8fQB9fQB9P0H4H+vgA/+AC+/gPkH8vAB++AAu+AAuvQC9L+v4Bv+Q
91tBv9AH//gf0H8vAB9+AAu+AAvvAAvvQC/L+v/C/5vAAA+AAB9AAD8AAf0Lv/QL/kA
A2mAL4AAP8AAf9AAuuAA+vAA9fQB8PQC8LgD4LwH6r0H//4L//4PgC8fQB9vQA+/AA/
B20//6Q///4/6/9/QH+/QD+/QH9/q/4///g///9/QH+/QC//QC//QH//6/+///4//+Q
C21AL/oB//+H/r9P9AYv0AAvgAA/QAA/QAA/QAA/QAA/gAAv0AAf5AFL/79C//9Ab/k
D2b//kA///Q/r/0/Af8/AD9/AC+/AB+/AB//AB+/AB+/AC+/AH9/Af8/r/0///Q//kA
E1l/////////+qq/0AA/0AA/0AA/6qp///9///9/0AA/0AA/0AA/0AA/+qq////////
F1k/////////6qq/0AA/0AA/0AA/0AA///9///9/6qp/0AA/0AA/0AA/0AA/0AA/0AA
G27AL/5B//+H/69P9AEvwAAvgAA/QAA/Qv//Qv//Qq//QA/vwA/f4A/L/r/C///Ab/p
H29/AB//AB//AB//AB//AB//AB//qq//////////AB//AB//AB//AB//AB//AB//AB/
I19////////G//kA//AA//AA//AA//AA//AA//AA//AA//AA//AA//AG//k////////
J0xAAv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/AA//UW/9///0//pA
K28/AD9/AL4/Avw/B/Q/D+A/L4A/vwA//wA//4A/78A/D+A/B/Q/Avw/AP4/AL8/AD+
L1o/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/6qq////////
M2y/QB//gC//gD//wD/+0Hv+0Lf94Lf98Pf88ef8tdf8dsf8e8f8P4f8P0f8L0f8Hwf
N2f/wAv/0Av/8Av/9Av+/Av9vQv9fwv+L0v+H8v+C9f+B+f+A/v+Af/+AL/+AH/+AD/
O2kAv+AH//gL+v4fwD9vQB+/AA++AA/+AA/+AA/+AA//AB+vQC+f0H9L+/4D//gAv+A
P1v//+Q///4/6/9/gH+/gD//gC//gH+/lv9///4///Q/lQA/gAA/gAA/gAA/gAA/gAA
Q23Bv+AH//0P5b8vQC+/AA++AA/+AA/+AA//AA+vQC+P5b8H//0Bv/QAAvgAAL4AAC+
R25//oA///Q/r/w/Af0/AP0/AP0/Avw///Q//9A//8A/C+A/B/Q/Avw/AP4/AH9/AC+
S1rBv/kH//+f/r9v0AUv0AAv5AAP/kAH/+QAv/4ABv9AAL/AAC/pAH//+v9///4W/6Q
T23////////qv+qAP4AAP4AAP4AAP4AAP4AAP4AAP4AAP4AAP4AAP4AAP4AAP4AAP4A
U27/AA//QA//QA//QA//QA//QA//QA//QA//QA//QA//QA//QB/v0C+f+v9H//0Bv+Q
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
D25//kA///Q/r/0/Qf8/QH9/QC+/QC+/QB//QB//QC+/QC+/QH9/Qf8/r/0///Q//kA
G27AK/5B//+H/69P9AEv0AAvgAA/QAA/Qv//Qv//Qq/vQA/vwA/f4A/L/7/C///Ab/p
H23/QB//QB//QB//QB//QB//QB//qr//////////QB//QB//QB//QB//QB//QB//QB/
J10AAf/AAf/AAf/AAf/AAf/AAf/AAf/AAf/AAf/AAf/AAf/AAf/AAv/UW/+///0//pA
K23/QH+/QL4/Qf0/R/Q/S+A/b8A/f0A//wA//4A/79A/T+A/R/Q/Qvw/Qf4/QL8/QH+
L1k/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/6qq////////
M2t/QC//gC//wD//wD/+0Hv+0Lv94Pf98Pf98ef9ttf9etf9e8f9P4f9P0f9L0f9Hwf
N2c/wA//0A//8A//9A/++A/9vQ/+fg/+L0/+H4/+D9v+B+v+A/v+Af/+AP/+AL/+AH/
O2eAv+AD//gL+v4f0H9vQC+/AB+/AA//AA//AA//AA//AB+vQC+f0H9L//4D//gAf9A
P1r//6Q///4/6/9/gL+/gD//gD//gH+/1v9///4//+Q/1QA/gAA/gAA/gAA/gAA/gAA
Q1zBv+AH//0f5b8vgC9/AB+/AA+/AA+/AA+/AB+vQC9f5b8H//wBv/QAAfwAAL4AAC+
R21//oA///Q/r/w/Qv0/Qf0/Qf0/Qvw///g//9A//8A/S+A/R/Q/Qvw/QP4/QL9/QD/
S1nBv/lH//+f/r9v4AUv4AAv9AAP/kAH/+QAv/4AB/9AAL/AAD/pAH//6/+///4a/6Q
T1z////////qv+qAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8A
U23/QB//QB//QB//QB//QB//QB//QB//QB//QB//QB//QB//gC+v0H+P+v8H//0Bv+A
V2b/AA/vQB+fgC9PwC9LwD8H0H4H4L0D8LwC8PgB9fgA+fQAuvAAv+AAf9AAP8AAL4A
W3j8DwPsDwOtH0etH0edL4deL4tOKosOOssPOs4Ldd4Ldd4HsO0H8P0D4LwD4LwD4Lw
X2ffgC9P0D8H4L0D8PwB+fQA//AAf9AAP8AAf9AAv+AB+vQC9fgH4P0L0H4fwD9vQC+
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
31yGv5Av//wfqv8EAH8AAD9AAH8AVv0Av/QAv/4AAb9AAB/AAB/AAB/vqv9///0Gv5Q
42aAAfQAA/QAC/QAH/QAPfQAuPQB8PQC0PQHgPQPQPQv///////qqvqAAPQAAPQAAPQ
51zL//8L//8L6qoL0AAL0AAP0AAP/+QP//4FVv9AAD+AAB+AAB+EAD+fqv8v//0G/5A
61zAG/5B//+H/ltL4AAfgAAvQAAvW/g/v/8/9b+/gB/vQA/vgA/f0B+L+b9D//4Af+Q
71y////////qqr9AAH8AAL0AAfwAAvgAB/AAC+AAD8AAL4AAP0AAvgAA/QAC+AAD9AA
820Av+QH//0P5b8fgC9vQC9fgD8L+f0C//AG//0f0b9vAC//AA//QB+v5b9L//4Bv+Q
91zBv5AL//gf6v4vQH9/AC+/AB+/QC/v5b/P/+/C/l+AAB+AAC9AAL8eW/0v//Qa/oA
A2tAP8AAf9AAf+AAv/AA+/AB+vQB9fgC8fwD4PwH//0H//4L//8P6r8fgC9vgC+/QB/
B29//5A///w///4/gv4/gP4/gf0/6/g///4///+/lb//gD//gD//gH+///9///0//+Q
C29AG/5Av//D//+L/lpf8AAv0AAvwAAvwAAvwAAvwAAv0AAf9AAL/lZH//9B//+AG/k
D2j//5A///g///4/Wv9/AL+/AD//AC//AB//AB//AB//AC+/AH9/Wv8///0///Q//kA
E20/////////////6qq/wAA/wAA/6qp///9///9/6qp/wAA/wAA/6qq////////////
F1y/////////////6qq/0AA/0AA/6qo///9///9///9/0AA/0AA/0AA/0AA/0AA/0AA
G2jAG/kB//9H//8L+lof0AAvwAAvgaqvQv/vQv/vgq/vwA/f4A/P+W/H///B//9Ab+g
H2g/QB//QB//QB//QB//QB//QB//6r//////////6r//QB//QB//QB//QB//QB//QB/
J1kAAf/AAf/AAf/AAf/AAf/AAf/AAf/AAf/AAf/AAf/AAf/AAv/Kq/+f//8v//0a/5A
K2i/QL9/Qf4/Qv0/R/g/T/A/b9A/v4A//0A//4A/f9A/X/A/S/Q/R/w/Qv4/Qf9/QL+
L1u/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/6qq////////////
M31+AA//AB//gC//wD//0H//4L//8P/+9f/+uuv+f9v+P8v+L4v+H0v+Cgv+AAv+AAv
N2l/wA//0A//8A//9A///A///Q//vw//P0//H8//D9//B///A///Af//AP//AH//AD/
O2sAb9AC//gH//0P9v8fwD9vgC+vQB+/AA//AA/vQB+vgC+fwD9P9f8L//0C//gAb9A
P26//6A///0///9/6v+/gH//gD//gH+/lf+///8///0//+A/lAA/gAA/gAA/gAA/gAA
Q2nAb5AC//gL//0P5b8vgD9vQB+vAB+/AR+vB5+vS++vh/9f5v8L//4C//+Ab5+AAAY
R2c//6A///w///4/qv8/QL8/QL8/QP8///4///w///A/r/A/R/g/Q/0/Qf4/QP9/QH/
S22Ab/kH//9P//8f+Vov0AAv5AAv/5AP//0G//9Aa/+AAb/EAH/fpb+v//9///4Gv+Q
T2d////////////qv+qAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4A
U2f/QB//QB//QB//QB//QB//QB//QB//QB//QB//QB/vgB+vwD+f+r9P//4H//wAv9A
V2p/gB/vwC+fwC9P0D8L4H4L4L0H8L0D9PwC9fgB+fQB/vAA/+AAv+AAf9AAP8AAP4A
W429D0PtH0euH4euH4eeL4tfL8tPP8sPet8Let4Lte4H9f0H9P0H8P0D8PwD4LwC4Lg
X2pvwH9P4L4L8f0D9vgB//AA/+AAf8AAP4AAf8AAv+AB//AC9vgH8fwL4P4f0H9/gD+
Y2p/gC+fwD9P0H8L8L4D9PwC+fgB/vQAv+AAf9AAL8AAL4AAL4AAL4AAL4AAL4AAL4A
Z2fv//+v//+v//+aqv8AAv0AB/gAD/AAL9AAv4AB/gAD/QAL9AAf+qq////////////
029Ab5AC//gL//4f9f9f0H+vwD+/gC//gC//gC//gC/vwD+v0H9f9f9L//4C//gAb5A
11jAAb/AG//G///v///P///Hkv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/
222Cv5Av//w///4fq/9EAP9AAL9AAP9AAf4AB/0AH/gAf+AB/4AL/6pf///v///v///
322Gv5Av//0f//4eVv8AAP8AAf8Aa/0A//QA//4Aav+AAH/AAD/eVr/v//9v//0G/5A
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
61zAL+gB//9H5BoPgAAfAAAuAAA9G+Q+v/4/0C9+AAu+AAuuAAvfQA+L0C9C//0Ab+A
722////////AAB9AAD0AALgAAfAAAuAAB8AAC4AAD0AAH0AALwAALgAALgAAPgAAPgA
81zAb+AD+v0L0C8PQA9PQA9LwB8D9C0Av/QG6/kPQG9uAAu9AAfuAAffgB+L+v4Bv+Q
91zAv5AL//gfgH4uAC89AA99AAuuAA/fQH/L/+vBvkuAAAuAAB9AAC8KAf0f//QG/4A
A2hAP8AAf9AAv9AAu+AA+vAB9vQC8fQD8PgD4PwH6v0L//4P//4P1X8fgC9vQC+/AB/
B23//+Q///0/6/8/gL9/gH9/gL8/6v0///Q///4/gH+/gC//gC//gH//6/9///4//+Q
C23AG/gB//9H//9P+Rof4AAvwAA/gAA/gAA/gAA/gAAvwAAf4AAP+RtH///B//9AL/g
D23//oA///g///0/gf8/gL+/gD+/gC//gC//gC//gC//gD+/gL+/gf8///0///Q//oA
E1v///+///+///+/wAA/wAA/wAA/6qk///4///4/1VU/wAA/wAA/wAA////////////
F1v/////////////wAA/wAA/wAA/wAA///8///8///4/wAA/wAA/wAA/wAA/wAA/wAA
G23AH/gB//9H//9P+B0f4AAvwAA/gAA/gf//gf//gf/vwB/f4B/P+B/H///B//9AL/g
H21/gD//gD//gD//gD//gD//gD//////////////lX//gD//gD//gD//gD//gD//gD/
I1y////////////AP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8A////////////
J1xL///L///L///AAD/AAD/AAD/AAD/AAD/AAD/AAD/AAD/FAH+fkb+///8P//0Bv6A
K29/gH9/gP4/gvg/h/Q/j9A/r4A//0A//4A//9A/++A/1/Q/gvg/gf0/gL4/gH9/gD+
L1v/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA/wAA////////////
M23/wD//0H//4H//8L/v9Pv+tev/uuv/ftv/P8//L4//H0//Cg//AA//AA//AA//AA/
N1z/0B//4B//8B//+B///B//vR//fx//b1//j5//i9//h+//gv//gf//gP//gH//gD/
O25Af5AD//gL//4f4L9vwH9/gC+/gC//QC//QC//gC//gC+vwD9f4L9L//4D//gAv5A
P23//+Q///4/6/9/gH+/gC//gC//gD+/lv9///4///Q/lUA/gAA/gAA/gAA/gAA/gAA
Q1sBv5AH//gf5v4vwL8/QD9/QD+/QD+/QD+/gD9vwL8P5v0H//gAv9AAH+VAB/+AAb+
R26//5A///w/6/4/QL8/QH9/QH9/QL8/q/4///w//+A/i/A/R/g/Qv0/QP4/QL9/QH+
S22Ab+QG//4L//9f4G0v0AAf5AAP/0AH//gBv/8AB/+AAH/BAC/PkH+v//9f//0Bv6A
U20/gC//gC//gC//gC//gC//gC//gC//gC//gC//gC//gC+vwD+v4L9P//8H//0Bv+A
V2e/QB/vgB+fgC9fwD8P0D8L0H4H4L0D8LwD8PgC9fgB+fQA+vAAv+AAv+AAf9AAP8A
W2i/AA/vQA/vQA+vQA+fS0+fT0+fn49Pn49Pr88Prt8Luu8Luf8L9f4H9P4H9P4H8P4
X2evwD+P0H8L4L4D9PwC+fgB//AAv+AAf8AAf9AAv+AB+/QC9vgH8f0L0L4fwH9vgC+
Y2e/QB+fgC9P0H8L4L4H8PwC9fgB+vQA/+AAv9AAP8AAL4AAL4AAL4AAL4AAL4AAL4A
Z24f//+f//+f//+AAP8AAv0AB/gAD+AAL9AAf4AA/gAC/AAH9AAP4AAv///////////
023Af+AC//wL/v4P4H9vgC+vgB+/W1//b5//b4/vSl/vgB/fwC+P0H9L/v4C//gAf9A
120Ab9Ab/9Af/9Aav9AAL9AAL9AAL9AAL9AAL9AAL9AAL9AAL9AAL9A////////////
222Bv5AL//gv//4PQP8AAH9AAH9AAL8AAf4AAvwAC/QAL9AB/0AH/QAf///////////
323Bv+Ab//0f+/8HQL9AAD9AAH9AWv0Af/QAf/kABb9AAD+AAC/OQH/v//9f//4Bv+Q
42cAB/wAC/wAH/wAPvwAvfwB+PwD9PwL0PwfwPwvqv6////////VVf1AAPwAAPwAAPw
522H//9H//9L//9L4AAL4AAL5UAL//gP//8Hlf+AAD/AAC/EAC/eQL+///8f//0Bv5A
621Ab/gB//9H//9P9Bkv0AAvgAA/S+Q/v/8/+r+/0C//gB/vgB/f0C/L/v9C//4Ab+Q
723///////////+AAH8AAP0AAvQAB/AAD9AAH8AAL4AAP4AAf0AAf0AAvwAAvwAAvwA
821Ar+AH//0P+v8fwD9fwD9P4D8L/b0C//QG//0fxv9vQD+/AC//gC/v6r+L//4Bv+Q
923Bv5AH//gf+/4vgL8/QD9/QC+/gH+f+v/L/+/Bvi+AAC+AAH9GQf4f//0f//QC/4A
A2mAf9AAv9AAv+AA//AB+/AB9vQC9fgD8fgH8PwH+v0L//4P//8f6r8fwH9vgD+/gC/
B27//6Q///0///8/1f9/wL9/wP8/+/0///Q///4/1b9/wH+/wH//1b+///9///4//+Q
C25AG/gB//9H//9P/q4f9AQv4AA/0AA/wAA/wAA/0AAv4AAf9AUP/m8H//+B//9AL/g
D27//oA///Q///0/2/8/wf9/wL+/wH+/wH+/wH//wH+/wL+/wf9/2/8///0///Q//oA
E1z///+///+///+/+qp/4AA/4AA///4///4///4/+qk/4AA/4AA/+qq////////////
F1x/////////////+qq/4AA/4AA/+qk///8///8///8/4AA/4AA/4AA/4AA/4AA/4AA
G23AH/gB//9H//9P/q0f9AQv4AA/0FV/wv//wv//0v/v4C/f9C/P/n/H///B//+Ab/g
H24/0H//0H//0H//0H//0H//0H//////////////+v//0H//0H//0H//0H//0H//0H/
I21////////////qv+qAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9Aqv+q////////////
J1zL///L///L///Gqr/AAH/AAH/AAH/AAH/AAH/AAH/AAH/HQL/f+v+///9L//0Bv+A
K2c/wL9/wf4/w/0/y/Q/3+A/79A//4A//8A//+A///A/+/g/0/w/wv0/wf8/wL9/wH/
L1x/4AA/4AA/4AA/4AA/4AA/4AA/4AA/4AA/4AA/4AA/4AA/4AA/+qq////////////
M25/0H//4L//4P//8P//9f//uu//eu//f9//f5//b2//X2//Ti//QC//QC//QC//QC/
N22/0H//8H//9H//+H///H///X//vn//r3//33//z+//x///w///0v//0f//0P//0L/
O26Ab5AC//wL//4f+v9v4L+v0D//wD//wD//wD//wD/v0D/v4L+f+v9L//4C//wAb5A
P27//+Q///0///9/1f+/wH+/wD//wH+/6v+///8///0//5A/wAA/wAA/wAA/wAA/wAA
Q1uAv5AH//gP+/4v0P8vwL9/gH9/gH9/wH9vwL8f4f4L//0C//QAf9AAH/pAB/+AAb+
R2c//6A///w///4/1v8/wL9/wL9/wP8/6/4///0///Q/7/Q/x/g/w/0/wf4/wP9/wH+
S22Ar+QH//4P//9f+r4v4AQv9AAf/5AL//0C//9AG/+AAf/GQH/P6b////9f//0Bv6A
T2c////////////qv+qAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8AAP8A
U23/0D//0D//0D//0D//0D//0D//0D//0D//0D//0D/v0D/v4H/f+v+P//8H//0Av+Q
V2k/wC/vwC+f0D9P0H9L4H8L8L4H8L0D9P0D9PwC+fgB+vgA/vQA//AAv+AAf+AAP9A
W2k/gA/vgA/vgB/vgB+vi1+fj1+fn5+Pn99Pr99Pr+8Pvu8L+u8L+f8L9f4L9f4H9P4
X2iv0H+f4L9L8P4H9f0C/vgB//QA//AAf9AAv9AA//AC//QD9/wH8f0P4P8f0L9/wH+
Y2i/wD+f0H9P4L8L8P4H8f0D9fgC+vQA//AAv+AAf9AAP8AAP4AAP4AAP4AAP4AAP4A
Z25f///f///f///Kqv9AA/4AC/wAH/QAP+AAv4AB/0AD/QAL+AAf+qq////////////
024Af5AC//gL//4f9f9vwH9/gD+/n2//v6//v6//nm/vwD+vwH9f9f8L//4C//gAf5A
122AL+Ab/+Af/+Af/+AFb+AAL+AAL+AAL+AAL+AAL+AAL+AAL+AVf+V////////////
225Bv5AL//gv//0P1v8CAP8AAL9AAP8AAv4AB/wAH/QAf9AB/0AH/qqv///v///v///
323Bv+Qf//0f//9Llf9BAL+AAL9Aa/4Af/QAf/0AVv9AAH/FAH/flv/v//+f//4Cv+Q
42cAC/0AH/0AP/0Av/0A/f0C+f0H9f0L4f0fwf0/6/+////////qqv6AAf0AAf0AAf0
524H//9H//9H//9H+qpL8AAL9VAL//kL//9H6v+AAH/AAD/FAH/f5v+v//9f//0Bv+A
624Ab+QB//9H//9P+W0f4AQv0AA/y/g///8///+/4H+vwC/v0D/P9b+L//9C//0Ab+A
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
41qAALoAAf9AA/9AC/9AL/9Af/9A//9C/79H/X9P+H9v///v///P///FVb+AAH9AAH9
51pH//Qf//Qf//QvwAAvxAAv/+Qv//0b+v9BQH+AAC+AAC/AAC+GgH+v//8L//0Bv6A
61rAb+AB//0D//8L9H5P5QAf/+Qv//0v+v9v0H+/gC//gB//gC/v4H+P//8H//0Ab5A
71k///4///+///+FVf9AAv8AA/0AB/wAC/QAH/AAL+AAf8AAv4AB/wAC/gAD/QABqAA
81rAb5AC//gL//4P4L9f0D9f0H9L//8H//4f//9v1X+/gC//gC/v0H+f//9H//0Ar6A
91rAb5AH//0P//8v4H+/gC//QB//gC/v0H+f+v+H//+Bv/9ABb8b0f4P//wH//QAv4A
A29AL4AAP8AAf9AAv+AA//AA//QB+vgC9fgD9f0H//0L//4P//8f1X9vgB+/QB/aAAp
B1pH/+Qr//0///8/QH9/QD9/QH9/6v8///4///9/lX+/QC//QC//QC////+///4L//g
C1oAL+QB//4H//+L+C5f4AQvwAA/gAA/gAA/gAA/gAAvwAAf4AQL9C5H//+B//4AL+Q
D1wH/5Ar//g///4/AL9/AC+/AB+/AB//AA//AA//AB//AB+/AC+/AL9///4///gL/5A
E1eL///v////////0AA/0AA/0AA/+qo///4///4/1VQ/0AA/0AA/0AA////v///L///
F1hH///v////////5VV/0AA/0AA/1VQ///4///4///4/0AA/0AA/0AA/0AA/0AA/0AA
G1xAb5AC//gH//0P4LkfwBAvgAA/QAA/Aao/Af//Qf/vgG/fwD/P4L/H//6C//gAb5A
H2a/AA//AA//AA//AA//AA//AA//qq//////////qq//AA//AA//AA//AA//AA//AA/
J1rAAC/AAC/AAC/AAC/AAC/AAC/AAC/AAC/AAC/AAC//gC//wD/v5b+P//9H//0Af+Q
K1xAAB0/QH9/Qf9/R/0/X/Q/v9A//0A//wA//4A//9A/j/Q/R/w/Qf4/QL+/QC+AAAk
K1wAABg/QL4/Qv9/S/0/b/A//4A//gA//gA//0A/v9A/X/A/R/g/Qv4/QL+/QC+AAAk
L1h/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/5VV////v///H///
M2jaAAp/QB//gC//wD//0H//4L//8P//+v/+//v+v+v+f9v+P8v+L4v+BQv+AAv+AAv
M2iqAAq/AA//QB//gC//wD//0H//4L//8P//9f//+v/+//v+v+v+f9v+P8v+L4vpH0a
M2lLgC4PwD8f0H9f4L9f8P9f8P9f9f9f+v9v//+vv++vf9+vP8+vL4+vL4+/AA/uAAu
N23bQAV/wA//4A//9A//+A///Q///w//f4//L9//D///B///Av//Af//AL//AD/VAB5
O1zAb5AB//QH//0P4L8fgD9vQB+/QB+/AA//AA//AB+vQB+fwD9P4L8H//0B//QAb5A
P1uL//Qv//4///9/lX+/gC//gC//gC//lX+///9///0//+Q/gAA/gAA/gAA/gAA/gAA
Q1zAb5AB//QH//0P4L8fgD9vQB+/QB+/AA//AA//AB+vQH+fwv9P4v8H//8B//9Ab5g
R1vL/+Qv//0///8/QH9/QD+/QD+/QH9///8///0///g/l/g/Qv0/QP8/QH+/QC/VAA0
R1xL/+Av//w///4/Vb8/QD9/QD9/QH9/qv8///0///w/lf0/QL4/QH8/QD+/QC/qAB5
R1zL/+Av//w///4/Vb8/QD9/QD9/QH9/qr8///4///9/qr+/QC//QB//QB//QB//QB/
S1rBv+QL//4f//9/0Ck/QAA/gAAv5AAf/+QG//4AG/9AAC/BAC/rgD+v//9L//4Bv+Q
U22/AA//AA//AA//AA//AA//AA//AA//AA//AA//AA//QB/vgC+f1X+P//8D//0Af9A
V28aAAl/QB/vgC+fwD9P0H8L4L4H4P0D8fwC9fgC+vgB//QA//AAv+AAf9AAP8AAL4A
W34tAAetCgfuH0uuH0ufL49fL49Pf98Pv+8L//4L+v4H+v0H9f0D9fwD8PwC8PgC4Lg
W32ZDwZ9H0fuL4uuL4ufP8tfP89Pf99Pv+8P+v8L+v4L9f4H9P0H8P0H4L0D4LwC0Hg
X22HQA0vgC+f0H9L8P4D+v0B//gAv/AAf9AAf9AAv/AB//gD+v0L8P4f0H9vgC+HQA0
Y26HAA0vgC+f0D+P4L8H9f4C/vwB//QAv+AAP9AAL4AAL4AAL4AAL4AAL4AAL4AAL4A
Z1pL//8L//+H///AAL9AAv0AB/gAD/AAL9AAf4AA/wAC/QAH+AAP8AAv//4v//4L//4
022Ab5AB//gH//0P4L8fgC9vQB+/AA//AA//AA//AA/vQB+fgC9P4L8H//0B//gAb5A
116ABuQAb/+b///f///H+//AUv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/AAv/
21uBv+AL//0v//9vgH+BAB/AAB/AAC/AAH+AAv4AC/wAf+AB/4AL/QA///8v//8f//8
31yBv6AL//0f//8CQH9AAC+AAC+ACv9AC/4AC/9AAX+AAA/AAA/LQC////9f//4Br+Q
422AAHQAAf8AA/8AC/8AH/8Af/8A/78C/X8H+H8f8H8////v///f///FVb9AAH8AAH8
51yH//gf//gf//gvgAAvRAAv/+Q///4f+v9BAC+AAA/AAA/AAB/LQG+///9f//0Br6A
622AL+AB//0D//8L9C4P1QAf/+Qv//0v+v9vgC+/AA//AA//QB/v0H+P//8H//0Ab5A
71w///4///9///+FVb9AAP4AAf0AAvgAB/QAC/AAH9AAL8AAf0AAvwAB/gAC/AAAeAA
822Ab5AC//gL//4P0H8fgC9PwD9P//8H//0f//9vlW+/AA//AA/vkC+f//9H//0Ab6A
922Ab5AH//0P//8v0H+/QB//AA//AA/vgC+P+v+H//+Bv/9ABX8LgL4P//wH//QAv4A
A2oAH0AAL4AAP8AAf9AAv+AA+/AB9fQC8PgD4PwH//0L//4P//8fVW9vAA++AA+JAAU
B21L/+Qr//0///8/AD9/AC9/AD9/qv8///4///9/VW+/AA//AA//AB+///9///4P//g
C1zAK+QB//4H//+L9C9fwAQvgAAvQAA/AAA/AAAvQAAvgAAfwAQL9C9H//+B//4AK+Q
D28L/5Av//g///4+AH9+AB++AA++AAv+AAv+AAv+AAv+AA++AB++AH9///4///gP/5A
E1pL////////////QAA/QAA/QAA/6qo///4///4/lVQ/QAA/QAA/QAA////////L///
F1sL///v////////lVV/gAA/gAA/lVQ///4///4///4/gAA/gAA/gAA/gAA/gAA/gAA
G2bAb5AB//QH//0P0HgfgBAvAAA+AAA+Aqo+Av++Av/vAF/fgC/P0H/H//6B//QAb5A
H2p+AAv+AAv+AAv+AAv+AAv+AAv/qq//////////qq/+AAv+AAv+AAv+AAv+AAv+AAv
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
D2nP/5Av//w///49AG99AA+9AAf9AAf9AAf9AAf9AAf9AAf9AA+9AG9///4///gf/5A
E22P////////////AAA/AAA/AAA/qqo///4///4/VVQ/AAA/AAA/AAA////////P///
F26L///v////////VVV/AAA/AAA/VVQ///4///4///4/AAA/AAA/AAA/AAA/AAA/AAA
G2qAb5AB//gH//0P0HwfQBQuAAA9AAA9Aap9Av/9Av/uAFvfQB/P0H/H//6B//QAb5A
H379AAf9AAf9AAf9AAf9AAf9AAf+qqv////////+qqv9AAf9AAf9AAf9AAf9AAf9AAf
J2gAAAvAAAvAAAvAAAvAAAvAAAvAAAvAAAvAAAvAAAv+AAv/AA/v1W+P//9H//0Av+Q
K2nAAAY9AB99AH+9Av49C/Q9L9A9/0A//gA//0A/n9A+B/A9Avw9AL49AC+9AA9AAAY
K2nAAAk9AC89Af89B/g9L+A9v4A//QA//QA//0A+L8A9C/A9Avg9AL49AD+9AA9AAAY
L26/AAA/AAA/AAA/AAA/AAA/AAA/AAA/AAA/AAA/AAA/AAA/AAA/VVV////v///L///
M3lYAAJ9AAf+AAv/QB//gC//wD/+4L/98Pf89fP8vuP8P9P8L4P8H0P8CgP8AAP8AAP
M3fsAAO9AAf+AAv/AA//QB//gC//wD/+0Hv94Lf88PP8ueP8f9P8P8P8L4P8H0PADwA
M3lLAA4PQB8PgC9fwD9f0H9f4L9f8L9e9fdtueetftetP8etL4OsH0P8DwP8BQPoAAK
N2sZAAA/AAf/gAf/0Af/8Af++Af9vgf9P0f9D8f9C+f9Avv9AP/9AH/9AC/9AA/AAAZ
O2sAb5AB//gH//0P0H8fQB9uAAu9AAf9AAP9AAP9AAfuAAufQB9P0H8H//0B//QAb5A
P2kP//Qv//4///9+VW++AAu+AAv+AAu+VW+///9///4//+Q+AAA+AAA+AAA+AAA+AAA
Q2rAb5AB//gH//0P0H8fQA9uAAu9AAf9AAP9AAP9AAfuAKufQf9L0f8H//9B//9AKoY
R2mf/+Q///0///89AC99AA99AA99AC9///8///0///Q9Vvg9AL09AH89AC+9AAuUAAY
R2of/+Q///0///49AG89AB99AB99AC8///4///0///w+Vb09AD49AC99AA+9AAvUAAY
R2sf/+A///w///4+VX89AB99AA99AB8+qr8///4///9+qq+9AAv9AAf9AAf9AAf9AAf
S2gBv+QL//4f//9vQB0+AAA+AAAv5AAf/+QG//4AGv+AAB/FAAffQB/v//9L//4Bv+Q
T2a////////////Vb5VAH0AAH0AAH0AAH0AAH0AAH0AAH0AAH0AAH0AAH0AAH0AAH0A
U2w9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAfuAAvvlW+P//8H//0Av+A
V33IAAI9AAfuAAufAA9PQB8LgC4HwD0D0HwC8LgB9PQA+fAAv+AAP9AAL8AAH0AADwA
W4fUAAJ4CQLsDwOsHwOdH0ddL4dOL4sOOssLes4Ldd4Hse0H8PwD4LwD4LgC0HgB0HQ
W4cUCgE4DwL4HwKsH0OsL4NdL4ddOsdOdtsOddsLsO4L8P4H4L0H0L0D0HwDwDwCwDg
X2sJAAIuAAuvgC+P0H8H8P0B+vQAv+AAP8AAP8AAv+AB+vQH8P0P0H8vgC+uAAuJAAI
Y2zIAAIeAAu/QB/fwC9L0H4D9fwB/vQAv+AAP8AAH0AADwAADwAADwAADwAADwAADwA
Z2dP//9P//+P///AAD9AAP0AAvgAC/AAH9AAP0AAvgAC+AAH8AAf0AA///8v//8f//8
01wAb5AC//gH//0P//8f8P9v4H+/0H//wD//wD//0H/v4L+f8P9P//8H//0C//gAb5A
117AG5AB//5f///f///C///Af//AL//AL//AL//AL//AL//AL//AL//AL//AL//AL//
21rBv+AL//0f//8v+/+BkL/AAL/AAL/AAv+AC/8AL/0Av/QH/9Af/+gv//wP//wL//w
31tBv6AL//wf//4C+/9AQP9AAf+AC/9AC/4AC/9ABv+AAH+AQH+L+v+///9L//0Bv6A
41uAAKQAAv/AB//AD//AL//Af//B///D///L///f///////v///P///H///AAP/AAP/
51tC//Af//Av//Av+qAv5UA///Q///4f//9Blf+AAH+AAH/AQL+L+v9///8L//0Bv6A
61wAb+AB//0H//8L/v5P+pAf//Qv//4v//9v5b+/0H//wD//4L/f/v+P//8D//wAb5A
71n///0///8///+///+AB/9AC/4AH/0AL/gAP/QAv+AA/9AC/8AD/0AH/wAL/QAAbAA
81wAb5AC//gL//4P//9f8L9f9f9P//8L//4f//9v+v//0D//0H/v+v+f//9H//0Ar6A
91wAb5AD//wP//8v/v+/4L//wD//0H/v9b+f//+L//+B//9Aav8b+/4P//0H//QAv5A
A2iAL8AAP9AAf9AAv+AA//AB//QC//gD//wH/v0L//4P//8P//9f6r+vwD+vgC+GQBk
B1uD/+QX//0///8/6v9/wL9/1f9///9///8///+/6r//wH//wH//6r+///9v//4H/+g
C1tAL+QB//4H//+P/v9f9CQv4AA/0AA/0AA/0AA/0AAv4AAf9CQL/v9H//+B//4AL+Q
D21D/5AX//g///4/6/9/gL+/gD+/gD//gC//gC//gD//gD+/gL+/6/9///4v//gL/5A
E1hG///f////////+qq/8AA/9VU///8///8///8/+qo/8AA/8AA/+qq////f///G///
F1mC///f////////////9VV/9AA/+VU///4///4///4//qo/9AA/9AA/9AA/9AA/9AA
G22Ab5AC//gH//0P//0f4JAv0AA/wFQ/gf8/gf//wf/v0b/f4L/P///H//1C//gAb5A
H2m/gC//gC//gC//gC//gC//1W//////////////////1W//gC//gC//gC//gC//gC/
J1yAAH/AAH/AAH/AAH/AAH/AAH/AAH/AAH/AAH/VQH//4H/v9b/f//+P//8H//0Ab+A
K23AACgqgL4/wf9/x/8/3/w///Q//9A//4A//8A//+A/7/g/y/0/w/9/wf+/wH4AACg
K22AACQqgP0/w/9/3/4///g//+A//4A//0A//8A///A/7/g/y/0/w/9/wf//wH9AACg
L1m/9AA/9AA/9AA/9AA/9AA/9AA/9AA/9AA/9AA/9AA/9AA/9VV////////f///C///
M2uHQB0/gC//wD//0H//4L//9f//+v//////////////////v+//f9//Wl//QB//QB/
M2rbQB5/gC//wD//0H//4L//4L//8P//9f//+v//////////////////v+//f9/VL4V
M2vK0HoP0H8f4L9f8P9f9f9f+v9f//9f//9v//+v//+v//+v//+vv++vb5+/Wl/vQB+
N29GgAA/0C//8C//+C///S///i///2///+//v///n///i///h///gv//gP//gH/AACk
O24Ab5AB//QH//0P//8f4L9vwH+/gD+/gC//gC//gD+vwH+f4L9P//8H//0C//QAb5A
P21H//Qf//0///9///+/1b+/wH//wH//6r+///9///8///0/6pA/wAA/wAA/wAA/wAA
Q24Ab5AB//QH//0P//8f4L9vwH+/gD+/gC//gC//gD+vwL+f4/9P//8H//9C//0Ab6Q
R21H/+Qf//0///8///9/wL+/wL+/1b9///9///4///w///w/w/4/wf9/wP+/wH9AACg
R24H/+Af//w///4///8/wL9/wL9/wL9///8///4///0///4/wf8/wP9/wL+/wH+VQCk
R27H/+Af//w///4///8/1f9/wL9/wL9/6v8///8///9///+/1b//wD//wD//wD//wD/
S1wBv+QH//0f//9v+vk/0AA/wAA/+kAf//gH//8Ab/+AAb/BgH/v+v+f//9L//0Bv6Q
T1j////////////////V//VA//AA//AA//AA//AA//AA//AA//AA//AA//AA//AA//A
U2a/gC//gC//gC//gC//gC//gC//gC//gC//gC//gC//wD/v5b+f//9L//4H//0Ab5A
V2gGQBgvgD+vwD+v0H9P4L8P8P8L9f4H+v0D//wC//gB//QA//AAv+AAf9AAf8AAP8A
W3dKAAo+Gk//L0+vL5+vf59fv+9f//8P//8P//4L//4L//0H+v0H+v0D9fwD9fwC8Pg
W3fGH0o/L4/vL4+vP8+ff99fv+9f//9P//8P//8L//4L+v4L+v4H9f0H8P0D8PwD4Lw
X26BgCQLwH4/4P+f9v9L//4D//wB//QAv+AAv+AB//QD//wL//4f9v9/4P+LwH4BgCQ
Y2eCgCgfwH9/4L+f9f9P+v4H//0C//gB//AAv+AAP8AAP8AAP8AAP8AAP8AAP8AAP8A
Z1tH//4H//9H//+Gq/+AA/4AC/0AH/QAf+AA/8AC/0AH/gAP/AAv/qg///wf//wL//w
027Ab5AB//QH//0P//8f4L9vwD+/gC//gB//gB//gC/vwD+f4L9P//8H//0C//gAb5A
11cAC9QBv/+f///f///H///B///AC//AC//AC//AC//AC//AC//AC//AC//AC//AC//
21zBv6AL//0f//9v+v+GgH/AAC/AAH/AAP+AB/8AL/0Av/QH/4Av/6kv//4f//4P//4
323Bv6AL//0P//8D+v9AQD+AAX+AC/9AC/8AC/9ABv/AAC/BQC/L+v/v//9P//4Br6Q
429AALQAAf9AB/9AD/9AL/9Af/9A//9C//9L/r9f/r+////v///P///L///AAL9AAL9
523D//Qf//Qf//Qv+qQv1UAv//g///4f//9Clb/AAC/AAC/BQD/L+v+v//8P//0Br+A
627AL+AB//0D//8L/v5P+mQf//Qv//4v//9v5b+/gC//gC//0D/f+v+P//8H//0Ab+A
71x///4///9///////+AAf9AA/4AB/0AD/gAH/QAP+AAf9AA/4AB/0AD/gAC/QAAKAA
827Ab5AC//gL//4P+v8f0H9f5X9P//8L//4f//9v6r+/gC//gC/v+v+f//9H//0Ar6A
927Ab9AH//0P//8f+v+/0D//gC//gC/v5b+f//+L//+B//9Blv8b+/4P//wH//QAv4A
A2wAL4AAL8AAP9AAf+AAv/AA//QB/vgC+vwD+v0H//0L//8P//8f6r9vgC+vQB+HAA0
B26H/+QX//0///8/6v8/QH9/lX9///8///8///9/qr+/QC//QC//6r+///9v//4L/+Q
C23AK+QB//4D//+P/v9f8Bgv0AA/wAA/gAA/gAA/wAAv0AAf8BgL/v9D//+B//4AK+Q
D2dH/5Ab//g///4/6v9/QH+/QC+/QB//QB//QB//QB//QC+/QH+/6v9///4v//gL/5A
E1sH///v////////+qq/0AA/1VQ///4///4///4/6qk/0AA/0AA/+qq////v///H///
F1xH///f////////////5VV/0AA/5VU///4///4///4/+qo/0AA/0AA/0AA/0AA/0AA
G2gAb5AB//QH//0P+vgf0GAvgAA/QFQ/Qv8/Av+/Qv/vgX/f0H/P+//H//0B//QAb5A
H32/QB//QB//QB//QB//QB//VV//////////////////VV//QB//QB//QB//QB//QB/
J2aAAC/AAC/AAC/AAC/AAC/AAC/AAC/AAC/AAC/VQC//wC/v5X/f//+P//8H//0Ab+A
K2dAAAgqQD4/Qf9/R/9/X/0/v/Q//9A//0A//8A//+A/n/g/R/0/Qf9/QL+qQC4AAAg
K2cAABgqQH0/Qv8/S/8/v/g//+A//4A//wA//4A/v+A/X/g/R/4/Qv9/QL+qQC8AAAg
L1x/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/0AA/5VV////////f///H///
M3aGAAk/QA//gC//wD//0H//4L//9P//+v/////+//v+v+v+P9v+L4v+H0v+AAv+AAv
M35aAAp/AA//QB//gC//wD//0H//4L//8P//9f//+v/////+v+v+f9v+P8v+L4vAH0A
M3aGgCkPwD8f0H9f4L9f8P9f9f9f9f9v+v+v//+v//+vv++vP8+/L8//L4//Cg/qAAq
N2mHQAA/wA//4B//9B//+B///R///x//v5//b+//T///R///Q///Qf//QL//AD/AAB0
O2hAb5AB//QH//0P/v8f0H9vgC+/QB//AA//QA//QB/vgC+f0H9P/v8H//0B//QAb5A
P2dL//Qf//4///9///+/lX//gC//gC//qr////+///8///0/6pA/gAA/gAA/gAA/gAA
Q2hAb5AB//QH//0P/v8f0H9vgC+/QB//AA//QA//QC/vgL+f0v9P//8H//9B//4Ab5g
R2cL/+Qv//0///8///9/QD9/QD+/lX9///9///4///g/6/w/Qv4/QP9/QH//QC9AAAg
R2gL/+Av//w///4///8/QH9/QD9/QH9///8///4///0///0/QP8/QH9/QD+/QC+VAB0
R2kL/+Af//w///4///8/lX9/QD9/QD9/6v8///8///9///+/lW//QB//QB//QB//QB/
S27Bv+QH//0f//9v+v0/gBA/gAAv+kAf//gH//8Ab/+AAX/CgC/f+v+v//9L//4Bv+Q
T1w////////////////Vf9VAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9AAf9A
U2o/QB//QB//QB//QB//QB//QB//QB//QB//QB//QB//QB/v1X+f//9L//4D//wAb5A
V2vHAA0vQB+vgC+fwD9P0H8L4L4H8P0D9fwC+vgC//QB//AA/+AAv9AAf9AAP8AAL4A
W3yZAAY9CgfuH0uuL4uvL49fP89ff99Pv+8P//4L+/4L+v0H9f0D9fwD8PwD8PgC4Lg
W3wFH0U9H0f+L4vuL4uuP8+ff89ff99Pv+8P+v8P+v4L9f4L8f4H8P0H4L0D4LwC0Hg
X2eCAAgPgC8/0H+f8P9L+v4D//wB//QAv+AAv+AB//QD//wL+v4f8P9/0H+PgC8CAAg
Y2sCAAkPgC8vwD+f4L+L9f8H//0C//gA//QAv+AAP8AAL4AAL4AAL4AAL4AAL4AAL4A
Z24L//4L//9L//+Gq/+AAv4AB/wAH/QAP+AAv4AB/0AH/QAP+AAv+qk///4f//4P//4
02lAb5AC//gH//0P/v8f0H9vgC+/QA//AA//AA//QA/vgC+f0H9P/v8H//0B//gAb5A
11fABuQAb/5b///v///P///H+//BQ//AA//AA//AA//AA//AA//AA//AA//AA//AA//
22cBv6AL//0v//8v+v+GQC+AAB/AAC+AAL9AB/8AL/0Av/QH/4Av/6ov//4f//4f//4
32gBv6AL//0f//8H6v9BAC+AAW+AC/9AC/8AC/9ABr/AAB/GAB/f6v+///9f//4Bv+Q
42mAAGQAAf4AAv8AC/8AH/8Af/8A//8C/78L/b8f+b9////v///f///P///AAL9AAH8
52gH//gf//gf//gv6qQvlUAv//g///4v//9HlX+AAB/AAA/GAC/f6v+///8f//0Bv+Q
62lAL+AB//0D//8L/v5P+lQf//Qv//4v//9v1X+/QA//AA/vgC/v+v+P//8C//wAb5A
72c///4///9///+///+AAP9AAf4AA/0AB/gAD/QAH+AAP8AAf4AA/wAB/gAB/AAAKAA
82lAb5AC//gL//4P+v8fwD9f1X9P//8L//4f//9v6r//QA//QB/v+v+f//9H//0Ab6A
92lAb6AC//wP//8v+v+/gC//AA//QB/v1X/f//+L//+B//9Blr8L+/4P//wH//QAv4A
A3dAH0AAL4AAP8AAf9AAv+AA//AB+vQC9fgH+vwL//0P//4f//9vqq9/AA/uAAtFAAU
B2jL/+Qb//0///4/qr8/AC9/VX9///8///8///9/qr+/AB//AB//qr+///9v//4L//g
C2hAL+QB//4H//+L/r9f4B0vgAA/QAA/AAA/AAA/QAAvgAAf4B0L/r9H//+B//4AK+Q
D2sL/5Ab//g///4/qv9+AC++AA++AAv+AAv+AAv+AAv+AA/+AC+/qv9///4v//gP/5A
E24L///v////////6qq/gAA/lVQ///4///4///4/qqk/gAA/gAA/6qq////v///L///
F2bL///f////////////lVV/gAA/lVU///4///4///4/6qo/gAA/gAA/gAA/gAA/gAA
G2uAb5AB//QH//0P+vwf0DQvQAA/AFQ+Av9+Av//Av/vQW/f0D/P+v/H//1B//gAb5A
H3l+AAv+AAv+AAv+AAv+AAv/VVv/////////////////VVv+AAv+AAv+AAv+AAv+AAv
J2oAAB/AAB/AAB/AAB/AAB/AAB/AAB/AAB/AAB/VAB//QB/v1X/v//+P//8H//0Av6A
K2sAAAYpAC8/AL+/Av9/D/0/f/Q//9A//0A//4A//+A/j/g/A/4/Af9/AH+qAB9AAAY
K2rAAAgpAH4/Af8/C/4/f/g//9A//0A//gA//4A/f+A/D/g/A/4/Af+/AH+pAB8AAAU
L2b/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/gAA/lVV////////f///L///
M3wJAAY+AAv/QB//gC//wD//0H//8P//9f/++vv9v/f9f9f9P8f9L4f9D0f9AAf9AAf
M3nJAAY+AAv/AA//QB//gC//wD//0H//4L//9P/++fv9/vf9v+f9f9f9P8f9H4fAD0A
M3wHQB0PgC8PwD9f0H9f4L9f8P9f9P9f+f9u+vuuv+uuf9uuP8uuL4v+H0f9CgfpAAa
N30KAAA/QAa/0Av/8Av/+Av//Qv+/wv+f4v+L9v+C/v+B//+Af/+AL/+AD/pAB/AAAo
O2xAb5AB//QH//0P+v8f0H9vQB+/AAv+AAv+AAv/AAvvQB+f0H9P+v8H//0B//gAb5A
P2sL//Qv//4///8///+/VW+/AB//AB//qr+///9///8///0/qpA/AAA/AAA/AAA/AAA
Q2xAb5AB//QH//0P+v8f0H9vQB+/AAv+AAv+AAv/AFvvQL+f0f9P+/8H//9B//4Ab5k
R2rP/+Qv//0///4///9/AC9/AC9/VX9///8///4///g/q/w/Af4/AL9/AC+qAB9AAAk
R2vP/+Av//w///4///8+AC9+AC9/VX9///8///4///w///0+AH8+AD9+AC++AA+AAAk
R30L/+Av//w///4///8/VX9+AC9+AC9/qv8///8///9///+/VW/+AA/+AAv+AAv+AAv
S2lBv+QH//4f//9v+r0/QBQ/QAAv+kAf//kH//9Ab/+AAW/HQB/f+r/v//9L//4Bv+Q
T2d////////////////Vf9VAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4AAL4A
U35+AAv+AAv+AAv+AAv+AAv+AAv+AAv+AAv+AAv+AAv/AA/v1X+f//9P//8H//0Av+A
V3bFAAUuAA9/AB/vQC+fgD8PwH4L4L0H4PwD9fgC+vQA//AAv+AAf9AAP8AAL4AAH0A
W4oIAAI8CgP9DwftH0euH4ueL4tPP89Pf98Luu8L+v4H9f0H9f0D8PwD8LwC4LgC0Hg
W4nEDwEsHwO8H0PtL4etL4eeP8tef8tPet8Ptu8L9f4L8P4H8P0H4L0H4LwD0HwDwHg
X2vGAAYPQB9vwD+f4L+L9f4D//wB//QAv+AAv+AB//QD//wL9f4f4L+vwD+PQB9GAAY
Y37FAAUPAA8vgC+v0H+P8P8H+v0C//gB//QAv+AAP8AAH0AAH0AAH0AAH0AAH0AAH0A
Z2hP//8P//9P//+Kqv+AAf4AB/wAD/QAL9AAv4AB/wAH/AAP9AAv+qo///4f//4P//4
# letters read off PSA score bugs
A29AKkBEv9AF+uRB5bQC0LQC0HgHgGkHgG0LQC4LlW4f//8fqq9uQFu9AAe8AAf8AAf
A28AaoABv+AB9uAC4fQD0LgH0HgHgHwLkH0L5b4f+v4f6r8vlW9+ABu9AAe4AAKQAAF
A2kAFUAAGoAAL5AAb9AAeuAAuuQAtbQBpbgC5H0C6b0G+r4H6r4LgB9fQBufQAueQAv
A2kAFQAAakAAf4AAv5ABu9ABquAB5uAC5eQH0bgH6vgL6vkLqr0fQG4eQC8uAB9tABt
B21aqqQvqv4+Vb9+QG9+QG9/lb4/6v4/+v4/pa9+QFu9AAu+QBu/lW+v6r5b/+kFqlA
B23GqpAf//gv/v4uAC8tAC8tAC8uAH0v7/gvqvkuVX4tAB9tAA+tAA+uVW9v//4f/+Q
B2av//kvlrkvgb4vgH4vgH4vgbov6uUv6uUvqqkvgG5vgC+vgC+ugC+vlb5v6rpv/+k
B23VVVAqqqkv6vkvgb5vgD5vgH4vlbkv6/kv6vkvlWpvgC+vgBuvgC+vlW+vqr5v//k
D27f/+Qv//0vlr5uQG9uABuuAAutAAutAAutAAutAAutAAutABuuAB9uVW5vqv0f/+g
D1zv/+Q//v4+la99AFu5ABv5AAf5AAb5AAb5AAb5AAb5AAb5AAf5ABu+QW++qr5v7qk
D2bVVUAqqqQvqukuQb4uQC+uQBuuQBuuQBvuQBvuQBvuQBuuQBuuQG9ulb4vqukv/5Q
D2jv/+QvqvkuRb4uQG9uQBuuQBuuQBuuQBuuQBuuQBuuQB+uQG+uQG5+lvkvqqUv/5A
E1raqqqv////pVV+QAA+QAA+QAA+VVQ//qp/qqk+lUA+QAA+QAA+QAA/lVVv///G///
E1oaqqlv6qp/lVU/gAA/gAA/5VU/+rp//vo/6qU/lAA+QAA+QAA/1VUv+qpb//+Fqql
E1vVVVVqqqqv6qqvkAAvkAAvkAAvlVUv6qpv6qpvlVUvkAAvkAAvkAAvlVVv6qpv///
E23VVVUaqqpb6qpbwAAbwAAbwAAb1VAb6qUb6qUb1VAbwAAbwAAbwAAb1VUb6qlb//5
G2kAFUABqqQGv/kH/v4LkG4fkBUfQAAeQAAuRv9eRa9fQV9fQB9blW9L6r9G/+tBv5t
G2jG/+QK//kb+v4vkG4uQBU+QAA9AAA9Bqp9Br+9AW++QB++QG+vkb+b//+K/6uGv5t
H21ZAAauQAfuQAfuQAfuQAfuQAfuQAvvqWvv+r/vqqvvUBvuQAfuQAfuQAfuQAfaAAa
H27ZAAGuAAPuAAfuAAfuQAfvlVvv6q/v///v6q/vlVvuQAfuQAfuQAfuQAfuQAfuAAL
H2kVAAUaQBpfQB9fQB9fQB9fQB9flV9f6r9fqr9fVV9fQB9fQB9fQB9fQB9fQB9eQBs
H2bFQAVaQAafgAffgAffgAffgAfflVvf6q/f6qvflVvfgAffgAffQAffgAffgAfbgAb
I0dVVVV//qq//qq//qq//qq//qq//qq//qq//qq//qq//qq//qq//qq//qq//qqqqVV
I0kVapVqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qVapV
I0pVVVVqqqqqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+q
I0pVVVVqqpVqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv+qqv9V
K23VABUqQGp+Qbp+RvU+W9A+b4A+rkA/+QA/+QA/vkA/roA+b9A+RuQ+Rvk+Qb5+QH+
K2bFABUaQGkvgbkfQvgfi9Afm5AfrkAf/QAv/QAv7kAvr5Avm9AvR+QfgvkfQb4aQG5
L1kZQAA+QAA+QAA+QAA+QAA+QAA+QAA+QAA+QAA+QAA+QAA+QAA+QAA/lVVv///b///
L1oaQAAvgAAvgAAvgABvgAAvgAAvgAAvgAAvgAAvgAAvgAAvgAAv5VUb+qpK//6Baqk
L1vVUAAakAAbkAAbkAArkAArkAArkAArkAArkAArkAArkAArkAArkAArpVVr6qqb///
L1vVQAAqUAA/UAA/UAA/UAA/UAA/UAA/UAA/UAA/UAA/UAA/UAA/UAA/VVQ/qql///6
M3dGkGkL4L4eoKtesKddcNddcNdddNddddNcddOcddOsJYOsJoOsKoKoK4KoH0KYHkK
M2zFQBQLgG4f0L5p4Ktpodd4odd4odd4odd4ode4doe4doe0doK0doK0aoK0L0KkGkG
M30VAAVqQBpvQC+vgC+vkH+vkH+v0L+u4buu5euupeutututeputb5utL4utL0utHke
M2sVAAVqQAq/QB//gB//wC//0D//4H/+4Hr99Lr9tPf8eef8euP8L9P9L4P9H4LtH0L
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
`;
// @templates-end

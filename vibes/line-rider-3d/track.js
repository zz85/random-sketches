// Track geometry, no three.js: strokes -> per-vertex frames (tangent, ribbon side, surface normal,
// optional auto-banking) -> collision segments in a spatial hash. Shared by the sim, the renderer and the tests.
//
// A stroke is { type, mode, pts, hints?, flip, bank, w }:
//   type  0 normal (blue), 1 accelerate (red), 2 scenery (green, no collision)
//   mode  'wall'  drawn on a vertical sketch plane; the ribbon is the stroke extruded along the plane normal,
//                 hints[i] is that plane normal (it may rotate while drawing), so this is 2D Line Rider
//                 per plane. The riding side follows Line Rider: left of the drawing direction as seen
//                 from the side the hint points to (draw left -> right for a floor, right -> left for a ceiling).
//         'floor' drawn top-down; the ribbon lies flat across the path and its riding side faces up.
//   flip  swap the riding side (Line Rider's shift-draw)
//   bank  tilt floor-like parts toward the inside of turns for the speed the rider should have there
//   w     ribbon width

export const G = 16;            // gravity, units/s^2 (rider is ~1 unit tall)
export const UP = [0, 1, 0];
export const DEFAULT_W = 2.4;
const CELL = 3;
const MAX_BANK = 1.25;          // ~72 degrees

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const V = { sub, add, mul, dot, cross, len, norm };

// Side vector perpendicular to t from a hint, with fallbacks for degenerate (vertical) directions.
function sideFrom(hint, t) {
  let s = sub(hint, mul(t, dot(hint, t)));
  if (len(s) > 1e-3) return norm(s);
  s = cross(t, UP);
  if (len(s) > 1e-3) return norm(s);
  return norm(cross(t, [1, 0, 0]));
}

// yRef: height whose drop sets the speed estimate for banking (flag height + v0^2 / 2g).
export function strokeFrames(st, yRef = 20) {
  const P = st.pts, m = P.length;
  const T = new Array(m), S = new Array(m), N = new Array(m), arc = new Array(m);
  arc[0] = 0;
  for (let i = 1; i < m; i++) arc[i] = arc[i - 1] + len(sub(P[i], P[i - 1]));
  for (let i = 0; i < m; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(m - 1, i + 1)];
    T[i] = norm(sub(b, a));
  }
  const sign = st.flip ? -1 : 1;
  for (let i = 0; i < m; i++) {
    const hint = st.mode === 'floor' ? cross(T[i], UP) : (st.hints ? st.hints[Math.min(i, st.hints.length - 1)] : [0, 0, 1]);
    S[i] = sideFrom(hint, T[i]);
    N[i] = mul(cross(S[i], T[i]), sign);
  }
  if (st.bank && st.type !== 2 && m > 2) {
    // lateral curvature along the side vector, from tangents a short arc either side
    const theta = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      if (N[i][1] < 0.5) continue;                       // walls / ceilings / loops: leave alone
      let j0 = i, j1 = i;
      while (j0 > 0 && arc[i] - arc[j0] < 0.8) j0--;
      while (j1 < m - 1 && arc[j1] - arc[i] < 0.8) j1++;
      const ds = arc[j1] - arc[j0];
      if (ds < 1e-6) continue;
      const k = mul(sub(T[j1], T[j0]), 1 / ds);
      const ks = dot(k, S[i]);
      const v2 = Math.max(0.8 * 2 * G * (yRef - P[i][1]), 9);   // runs lose some speed on landings
      theta[i] = Math.max(-MAX_BANK, Math.min(MAX_BANK, Math.atan(v2 * ks / G)));
    }
    // smooth over ~3 units of track so the ribbon doesn't twist abruptly
    const sm = new Float64Array(m);
    for (let i = 0; i < m; i++) {
      let s = 0, wsum = 0;
      for (let j = i; j >= 0 && arc[i] - arc[j] < 4.5; j--) { const w = Math.exp(-((arc[i] - arc[j]) ** 2) / 4.5); s += theta[j] * w; wsum += w; }
      for (let j = i + 1; j < m && arc[j] - arc[i] < 4.5; j++) { const w = Math.exp(-((arc[j] - arc[i]) ** 2) / 4.5); s += theta[j] * w; wsum += w; }
      sm[i] = s / wsum;
    }
    for (let i = 0; i < m; i++) {
      const c = Math.cos(sm[i]), s = Math.sin(sm[i]);
      const n = add(mul(N[i], c), mul(S[i], s)), sd = sub(mul(S[i], c), mul(N[i], s));
      N[i] = n; S[i] = sd;
    }
  }
  return { P, T, S, N, arc, w: st.w || DEFAULT_W, type: st.type, flip: !!st.flip };
}

const cellKey = (ix, iy, iz) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) | 0;

export function buildTrack(strokes, { yRef = 20 } = {}) {
  const frames = [], segs = [];
  let minY = Infinity, maxY = -Infinity;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  strokes.forEach((st, si) => {
    if (!st.pts || st.pts.length < 2) { frames.push(null); return; }
    const f = strokeFrames(st, yRef);
    frames.push(f);
    for (const p of f.P) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
    if (st.type === 2) return;
    for (let i = 0; i + 1 < f.P.length; i++) {
      const a = f.P[i], b = f.P[i + 1], d = sub(b, a), L = len(d);
      if (L < 1e-6) continue;
      segs.push({ a, b, t: mul(d, 1 / L), L, sa: f.S[i], sb: f.S[i + 1], na: f.N[i], nb: f.N[i + 1], w: f.w, type: st.type, dir: st.flip ? -1 : 1, stroke: si });
    }
  });
  const hash = new Map();
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k], pad = s.w / 2 + 0.7;
    const i0 = Math.floor((Math.min(s.a[0], s.b[0]) - pad) / CELL), i1 = Math.floor((Math.max(s.a[0], s.b[0]) + pad) / CELL);
    const j0 = Math.floor((Math.min(s.a[1], s.b[1]) - pad) / CELL), j1 = Math.floor((Math.max(s.a[1], s.b[1]) + pad) / CELL);
    const k0 = Math.floor((Math.min(s.a[2], s.b[2]) - pad) / CELL), k1 = Math.floor((Math.max(s.a[2], s.b[2]) + pad) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let q = k0; q <= k1; q++) {
      const key = cellKey(i, j, q);
      let arr = hash.get(key);
      if (!arr) hash.set(key, (arr = []));
      arr.push(k);
    }
  }
  const EMPTY = [];
  return {
    frames, segs, lo, hi,
    query(x, y, z) { return hash.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL), Math.floor(z / CELL))) || EMPTY; },
  };
}

// --- persistence: compact JSON with rounded coordinates
const r3 = (v) => v.map((x) => Math.round(x * 1000) / 1000);
export function serialize(strokes, flag) {
  return JSON.stringify({
    v: 1,
    flag: flag && { p: r3(flag.p), dir: r3(flag.dir), v: flag.v },
    strokes: strokes.map((s) => ({ type: s.type, mode: s.mode, flip: s.flip ? 1 : 0, bank: s.bank ? 1 : 0, w: s.w, pts: s.pts.map(r3), hints: s.hints && s.hints.map(r3) })),
  });
}
export function deserialize(text) {
  const o = JSON.parse(text);
  if (!o || !Array.isArray(o.strokes)) throw new Error('not a track file');
  const strokes = o.strokes.map((s) => ({ type: s.type | 0, mode: s.mode === 'floor' ? 'floor' : 'wall', flip: !!s.flip, bank: !!s.bank, w: +s.w || DEFAULT_W, pts: s.pts, hints: s.hints || undefined }))
    .filter((s) => Array.isArray(s.pts) && s.pts.length >= 2);
  return { strokes, flag: o.flag || null };
}

// Handwritten music symbol recognizer. No DOM: runs in the browser and in bun/node.
//
// Classifier: a small MLP over online-handwriting features, trained offline on HOMUS
// (Calvo-Zaragoza & Oncina, ICPR 2014: 15 200 symbols, 100 musicians, 32 classes,
// written on a staff with 14 px line spacing). See train.js. Features:
//   - directional element features (Kato et al., TPAMI 1999, from CJK character recognition):
//     ink length binned by undirected orientation (4 planes) over a 6x6 zone grid,
//     so stroke order and direction do not matter (people draw a sharp's four lines
//     in any order) but orientation does (stem up vs down, flat vs 'q')
//   - where strokes start and end (4x4), which separates closed from open shapes
//   - size in staff spaces. Shape normalisation throws scale away, but a dot and a
//     whole note differ mostly in size, and staff-relative size is the strongest cue
//     in the OMR literature (Rebelo et al. 2012)
//   - stroke count, direction reversals, closure, ink length
//
// Personal adaptation: user corrections are stored as $P point-cloud templates
// (Vatavu, Anthony & Wobbrock, ICMI 2012) and a close $P match overrides the MLP.
//
// Coordinates: y grows downward. Units are staff spaces (sp).

// ---------------------------------------------------------------- geometry

export function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return d;
}

export function bbox(strokes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const p of s) {
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

export function inkLength(strokes) { return strokes.reduce((a, s) => a + pathLength(s), 0); }

/** Straightness: chord / path length (1 = straight line). */
export function straightness(pts) {
  const L = pathLength(pts);
  return L === 0 ? 1 : Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y) / L;
}

/** Reversals of direction along one axis, ignoring jitter below `tol`. */
export function reversals(pts, tol = 0.25, axis = 'x') {
  let dir = 0, count = 0, anchor = pts.length ? pts[0][axis] : 0;
  for (const p of pts) {
    const d = p[axis] - anchor;
    if (Math.abs(d) < tol) continue;
    const s = Math.sign(d);
    if (dir !== 0 && s !== dir) count++;
    dir = s; anchor = p[axis];
  }
  return count;
}

/** Resample a multistroke to n points spread evenly along its ink ($P resampling). */
export function resample(strokes, n = 32) {
  const pts = [];
  for (let s = 0; s < strokes.length; s++) for (const p of strokes[s]) pts.push({ x: p.x, y: p.y, id: s });
  if (pts.length === 0) return [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i].id === pts[i - 1].id) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (total === 0) return Array.from({ length: n }, () => ({ x: pts[0].x, y: pts[0].y, id: 0 }));
  const I = total / (n - 1);
  let D = 0;
  const out = [{ ...pts[0] }];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].id !== pts[i - 1].id) continue;
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (D + d >= I && d > 0) {
      const t = (I - D) / d;
      const q = { x: pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), y: pts[i - 1].y + t * (pts[i].y - pts[i - 1].y), id: pts[i].id };
      out.push(q);
      pts.splice(i, 0, q);
      D = 0;
    } else D += d;
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] });
  out.length = n;
  return out;
}

/** Resample one stroke at a fixed spacing (keeps endpoints). */
export function resampleStep(pts, step) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  let prev = pts[0], acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let q = pts[i];
    let d = Math.hypot(q.x - prev.x, q.y - prev.y);
    while (acc + d >= step && d > 0) {
      const t = (step - acc) / d;
      prev = { x: prev.x + t * (q.x - prev.x), y: prev.y + t * (q.y - prev.y) };
      out.push(prev);
      d = Math.hypot(q.x - prev.x, q.y - prev.y); acc = 0;
    }
    acc += d; prev = q;
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(last.x - out[out.length - 1].x, last.y - out[out.length - 1].y) > step * 0.2) out.push(last);
  return out;
}

// ---------------------------------------------------------------- $P (user templates)

export function normalizeCloud(strokes, n = 32) {
  const pts = resample(strokes, n);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const size = Math.max(x1 - x0, y1 - y0) || 1;
  let cx = 0, cy = 0;
  for (const p of pts) { p.x = (p.x - x0) / size; p.y = (p.y - y0) / size; cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  const xs = new Float32Array(n), ys = new Float32Array(n);
  for (let i = 0; i < n; i++) { xs[i] = pts[i].x - cx; ys[i] = pts[i].y - cy; }
  return { xs, ys };
}

function cloudDistance(a, b, start, n, best) {
  const matched = new Uint8Array(n);
  let sum = 0, i = start, k = 0;
  do {
    let min = Infinity, index = -1;
    const ax = a.xs[i], ay = a.ys[i];
    for (let j = 0; j < n; j++) {
      if (matched[j]) continue;
      const dx = ax - b.xs[j], dy = ay - b.ys[j], d = dx * dx + dy * dy;
      if (d < min) { min = d; index = j; }
    }
    matched[index] = 1;
    sum += (1 - k / n) * Math.sqrt(min);
    if (sum >= best) return sum; // early abandoning, as in $Q
    i = (i + 1) % n; k++;
  } while (i !== start);
  return sum;
}

/** $P greedy cloud match, normalised per point. */
export function cloudMatch(a, b, best = Infinity) {
  const n = a.xs.length, step = Math.floor(Math.sqrt(n));
  let min = best * n;
  for (let i = 0; i < n; i += step) {
    min = Math.min(min, cloudDistance(a, b, i, n, min));
    min = Math.min(min, cloudDistance(b, a, i, n, min));
  }
  return min / n;
}

export function makeUserTemplate(label, strokes) {
  const b = bbox(strokes);
  return { label, cloud: normalizeCloud(strokes), w: b.w, h: b.h, ns: strokes.length, strokes: packStrokes(strokes) };
}

/** Nearest user template; size must agree within ~40 % to count. */
export function matchUserTemplates(strokes, templates) {
  if (!templates.length) return null;
  const b = bbox(strokes), cloud = normalizeCloud(strokes);
  let best = null;
  for (const t of templates) {
    const sizePen = Math.abs(Math.log((b.w + 0.3) / (t.w + 0.3))) + Math.abs(Math.log((b.h + 0.3) / (t.h + 0.3)));
    if (sizePen > 0.7) continue;
    const d = cloudMatch(cloud, t.cloud, best ? best.d : Infinity) + 0.05 * sizePen;
    if (!best || d < best.d) best = { label: t.label, d };
  }
  return best;
}

export function packStrokes(strokes, q = 20) {
  const b = bbox(strokes);
  return strokes.map((s) => s.flatMap((p) => [Math.round((p.x - b.x0) * q), Math.round((p.y - b.y0) * q)]));
}
export function unpackStrokes(packed, q = 20) {
  return packed.map((a) => { const s = []; for (let i = 0; i < a.length; i += 2) s.push({ x: a[i] / q, y: a[i + 1] / q }); return s; });
}

// ---------------------------------------------------------------- classes

/** HOMUS labels and what they mean to the score model. */
export const CLASSES = {
  'Whole-Note': { kind: 'note', dur: 1 }, 'Half-Note': { kind: 'note', dur: 2 }, 'Quarter-Note': { kind: 'note', dur: 4 },
  'Eighth-Note': { kind: 'note', dur: 8 }, 'Sixteenth-Note': { kind: 'note', dur: 16 }, 'Thirty-Two-Note': { kind: 'note', dur: 32 }, 'Sixty-Four-Note': { kind: 'note', dur: 64 },
  'Whole-Half-Rest': { kind: 'rest', dur: 0 }, 'Quarter-Rest': { kind: 'rest', dur: 4 }, 'Eighth-Rest': { kind: 'rest', dur: 8 },
  'Sixteenth-Rest': { kind: 'rest', dur: 16 }, 'Thirty-Two-Rest': { kind: 'rest', dur: 32 }, 'Sixty-Four-Rest': { kind: 'rest', dur: 64 },
  'Sharp': { kind: 'acc', acc: 1 }, 'Flat': { kind: 'acc', acc: -1 }, 'Natural': { kind: 'acc', acc: 0 }, 'Double-Sharp': { kind: 'acc', acc: 2 },
  'G-Clef': { kind: 'clef', clef: 'G' }, 'F-Clef': { kind: 'clef', clef: 'F' }, 'C-Clef': { kind: 'clef', clef: 'C' },
  'Common-Time': { kind: 'time', time: [4, 4], sym: 'common' }, 'Cut-Time': { kind: 'time', time: [2, 2], sym: 'cut' },
  '2-2-Time': { kind: 'time', time: [2, 2] }, '2-4-Time': { kind: 'time', time: [2, 4] }, '3-4-Time': { kind: 'time', time: [3, 4] }, '4-4-Time': { kind: 'time', time: [4, 4] },
  '3-8-Time': { kind: 'time', time: [3, 8] }, '6-8-Time': { kind: 'time', time: [6, 8] }, '9-8-Time': { kind: 'time', time: [9, 8] }, '12-8-Time': { kind: 'time', time: [12, 8] },
  'Dot': { kind: 'dot' }, 'Barline': { kind: 'barline' },
};
export const LABELS = Object.keys(CLASSES);

// ---------------------------------------------------------------- features

const G = 6;           // zone grid for directional features
const E = 4;           // grid for stroke endpoints
export const N_FEATURES = 4 * G * G + E * E + 11;

function splat(arr, off, g, u, v, w) {
  // bilinear splat of weight w at (u,v) in [0,1]^2 onto a g x g grid
  const fx = Math.min(g - 1, Math.max(0, u * g - 0.5)), fy = Math.min(g - 1, Math.max(0, v * g - 0.5));
  const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
  const ix1 = Math.min(g - 1, ix + 1), iy1 = Math.min(g - 1, iy + 1);
  arr[off + iy * g + ix] += w * (1 - tx) * (1 - ty);
  arr[off + iy * g + ix1] += w * tx * (1 - ty);
  arr[off + iy1 * g + ix] += w * (1 - tx) * ty;
  arr[off + iy1 * g + ix1] += w * tx * ty;
}

/** Feature vector for a symbol given in staff spaces. */
export function features(strokes) {
  const f = new Float32Array(N_FEATURES);
  const b = bbox(strokes);
  const size = Math.max(b.w, b.h, 0.25);
  const step = size / 48;
  let ink = 0, revX = 0, revY = 0;
  const S = strokes.map((s) => resampleStep(s, step));
  for (const s of S) {
    for (let i = 1; i < s.length; i++) {
      const dx = s[i].x - s[i - 1].x, dy = s[i].y - s[i - 1].y, L = Math.hypot(dx, dy);
      if (L === 0) continue;
      ink += L;
      let a = Math.atan2(dy, dx); if (a < 0) a += Math.PI; if (a >= Math.PI) a -= Math.PI;
      const bin = a / (Math.PI / 4), b0 = Math.floor(bin) % 4, b1 = (b0 + 1) % 4, t = bin - Math.floor(bin);
      const u = ((s[i].x + s[i - 1].x) / 2 - b.cx) / size + 0.5, v = ((s[i].y + s[i - 1].y) / 2 - b.cy) / size + 0.5;
      splat(f, b0 * G * G, G, u, v, L * (1 - t));
      splat(f, b1 * G * G, G, u, v, L * t);
    }
    revX += reversals(s, size * 0.12, 'x'); revY += reversals(s, size * 0.12, 'y');
  }
  const inkN = ink / size || 1;
  for (let i = 0; i < 4 * G * G; i++) f[i] = f[i] / size / inkN * 8;
  let o = 4 * G * G;
  for (const s of strokes) for (const p of [s[0], s[s.length - 1]]) splat(f, o, E, (p.x - b.cx) / size + 0.5, (p.y - b.cy) / size + 0.5, 1 / strokes.length);
  o += E * E;
  const ns = strokes.length;
  let closure = 1;
  for (const s of strokes) { const L = pathLength(s); if (L > size * 0.8) closure = Math.min(closure, Math.hypot(s[0].x - s[s.length - 1].x, s[0].y - s[s.length - 1].y) / size); }
  f[o++] = Math.log(Math.max(b.w, 0.1));
  f[o++] = Math.log(Math.max(b.h, 0.1));
  f[o++] = Math.log((b.w + 0.1) / (b.h + 0.1));
  f[o++] = Math.log(inkN);
  for (let k = 1; k <= 5; k++) f[o++] = (k < 5 ? ns === k : ns >= 5) ? 1 : 0;
  f[o++] = Math.log1p(revX + revY);
  f[o++] = closure;
  return f;
}

// ---------------------------------------------------------------- MLP inference

function b64ToF32(s) {
  const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Float32Array(u8.buffer);
}
export function f32ToB64(a) {
  const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
  let s = ''; for (const c of u8) s += String.fromCharCode(c); return btoa(s);
}

/** Model JSON (from train.js) -> runnable model. */
export function loadModel(json) {
  const m = { labels: json.labels, sizes: json.sizes, mean: b64ToF32(json.mean), std: b64ToF32(json.std), layers: [] };
  for (const L of json.layers) m.layers.push({ W: b64ToF32(L.W), b: b64ToF32(L.b), nin: L.nin, nout: L.nout });
  return m;
}

export function forward(model, x) {
  let h = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) h[i] = (x[i] - model.mean[i]) / model.std[i];
  model.layers.forEach((L, li) => {
    const out = new Float32Array(L.nout);
    for (let o = 0; o < L.nout; o++) {
      let s = L.b[o]; const row = o * L.nin;
      for (let i = 0; i < L.nin; i++) s += L.W[row + i] * h[i];
      out[o] = li < model.layers.length - 1 ? Math.max(0, s) : s;
    }
    h = out;
  });
  let mx = -Infinity; for (const v of h) mx = Math.max(mx, v);
  let z = 0; const p = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) { p[i] = Math.exp(h[i] - mx); z += p[i]; }
  for (let i = 0; i < h.length; i++) p[i] /= z;
  return p;
}

/**
 * Rank classes for one symbol (strokes in staff spaces).
 * opts.prior: {label: multiplier} for context (e.g. clefs only at a bar start)
 * opts.user:  user templates; a close $P match wins
 * @returns [{label, p, source}] best first
 */
export function classify(strokes, model, opts = {}) {
  const p = forward(model, features(strokes));
  let out = model.labels.map((label, i) => ({ label, p: p[i] * (opts.prior && opts.prior[label] !== undefined ? opts.prior[label] : 1), source: 'mlp' }));
  const z = out.reduce((a, c) => a + c.p, 0) || 1;
  for (const c of out) c.p /= z;
  if (opts.user && opts.user.length) {
    const m = matchUserTemplates(strokes, opts.user);
    // per-point $P cost: same writer, same symbol ~0.005-0.03; different symbols >= 0.06
    if (m && m.d < 0.042) {
      const c = out.find((c) => c.label === m.label);
      const boost = Math.min(0.95, (0.047 - m.d) / 0.025);
      if (c) { for (const o of out) o.p *= 1 - boost; c.p += boost; c.source = 'user'; }
    }
  }
  out.sort((a, b) => b.p - a.p);
  return out;
}

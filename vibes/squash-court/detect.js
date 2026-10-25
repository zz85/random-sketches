// Court line detection and camera fit. Pure functions over RGBA pixels, no DOM, so the same code
// runs in a worker, on the page and under node / bun for the tests.
//
// 1. lineMap: a thin-line detector. A pixel is on a painted line when, along some direction (one
//    of 4), the pixels w to either side look like each other and both differ from it in the same
//    way (multi-scale w). That fires on lines of any colour on any floor or wall, but not on edges.
//    Non-maximum suppression across the line leaves 1-px centre lines with a sub-pixel offset.
// 2. The court colour: the strongest chroma mode among line pixels. Line pixels far from it are
//    down-weighted (adverts, players, glass reflections).
// 3. A distance transform of the centre lines with the index of the nearest one, so a projected
//    model point finds its nearest image line in O(1).
// 4. fitCamera: score many seed cameras by how much of the image's lines the projected model
//    covers, refine the best by Gauss-Newton ICP (point to nearest line, along the model line's
//    normal) with a shrinking robust scale, and keep the one that explains the most line pixels.
import { Camera, solve } from './camera.js';
import { courtModel, samplePoints } from './court.js';

// ---------- image ----------

// Box-downsample RGBA to float RGB planes of width ~targetW. Returns { w, h, r, g, b, scale }.
export function toWork(rgba, W, H, targetW = 640) {
  const s = Math.max(1, Math.round(W / targetW)), w = Math.floor(W / s), h = Math.floor(H / s);
  const r = new Float32Array(w * h), g = new Float32Array(w * h), b = new Float32Array(w * h), n = s * s;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sr = 0, sg = 0, sb = 0;
    for (let j = 0; j < s; j++) { let o = ((y * s + j) * W + x * s) * 4; for (let i = 0; i < s; i++, o += 4) { sr += rgba[o]; sg += rgba[o + 1]; sb += rgba[o + 2]; } }
    const k = y * w + x; r[k] = sr / n; g[k] = sg / n; b[k] = sb / n;
  }
  return { w, h, r, g, b, scale: s };
}

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]]; // comparison directions (across the line)
const DANG = [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4];

// Thin-line response. Returns { resp, nx, ny, dr, dg, db } where resp is the line strength in
// colour units, (nx, ny) the unit normal of the line (from the doubled-angle sum of the four
// directional responses), and d* the colour difference of the line from its surroundings
// (signed, for the court-colour mode).
export function lineMap(img, scales = [2, 3, 5]) {
  const { w, h, r, g, b } = img, N = w * h;
  const resp = new Float32Array(N), nxA = new Float32Array(N), nyA = new Float32Array(N), dr = new Float32Array(N), dg = new Float32Array(N), db = new Float32Array(N);
  const m = Math.max(...scales) + 1, Rd = new Float32Array(4);
  const c2 = DANG.map((a) => Math.cos(2 * a)), s2 = DANG.map((a) => Math.sin(2 * a));
  const o3 = 3, oy3 = 3 * w;
  for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) {
    const k = y * w + x, R0 = r[k], G0 = g[k], B0 = b[k];
    // cheap reject: a line pixel differs from the mean of its four axial neighbours 3 px away
    // (two across the line, two along it) by at least half its contrast
    const mr = R0 - (r[k - o3] + r[k + o3] + r[k - oy3] + r[k + oy3]) / 4, mg = G0 - (g[k - o3] + g[k + o3] + g[k - oy3] + g[k + oy3]) / 4, mb = B0 - (b[k - o3] + b[k + o3] + b[k - oy3] + b[k + oy3]) / 4;
    if (Math.abs(mr) + Math.abs(mg) + Math.abs(mb) < 9) continue;
    let best = 0, br = 0, bg = 0, bb = 0;
    for (let d = 0; d < 4; d++) {
      const [ux, uy] = DIRS[d]; let bd = 0;
      for (const s of scales) {
        const sx = d >= 2 ? Math.max(1, Math.round(s * 0.75)) : s; // diagonals step √2 further
        const o = (uy * w + ux) * sx, p = k - o, q = k + o;
        const ar = R0 - r[p], ag = G0 - g[p], ab = B0 - b[p];
        const cr = R0 - r[q], cg = G0 - g[q], cb = B0 - b[q];
        const na = ar * ar + ag * ag + ab * ab, nc = cr * cr + cg * cg + cb * cb;
        const dot = ar * cr + ag * cg + ab * cb;
        if (dot <= 0.7 * Math.sqrt(na * nc)) continue; // both sides must differ from the centre the same way
        const er = r[p] - r[q], eg = g[p] - g[q], eb = b[p] - b[q], ne = er * er + eg * eg + eb * eb;
        const v = Math.sqrt(Math.min(na, nc)) - 0.5 * Math.sqrt(ne); // sides alike
        if (v > bd) bd = v;
        if (v > best) { best = v; br = (ar + cr) / 2; bg = (ag + cg) / 2; bb = (ab + cb) / 2; }
      }
      Rd[d] = bd;
    }
    if (best <= 0) continue;
    // a line's response is strongest across it and falls off with angle; the doubled-angle mean
    // of the four responses points along the normal
    let sx = 0, sy = 0; for (let d = 0; d < 4; d++) { sx += Rd[d] * c2[d]; sy += Rd[d] * s2[d]; }
    const phi = 0.5 * Math.atan2(sy, sx);
    resp[k] = best; nxA[k] = Math.cos(phi); nyA[k] = Math.sin(phi); dr[k] = br; dg[k] = bg; db[k] = bb;
  }
  return { resp, nx: nxA, ny: nyA, dr, dg, db, w, h };
}

const bil = (a, w, x, y) => { const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, k = y0 * w + x0; return (a[k] * (1 - fx) + a[k + 1] * fx) * (1 - fy) + (a[k + w] * (1 - fx) + a[k + w + 1] * fx) * fy; };

// Non-maximum suppression across each pixel's line normal. Returns centre-line points
// { x, y (sub-pixel, pixel i covers [i, i + 1)), s (strength), nx, ny (normal), k (pixel index) }.
export function centreLines(lm, img, thr = 10) {
  const { resp, nx, ny, w, h } = lm, pts = [];
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const k = y * w + x, v = resp[k];
    if (v < thr) continue;
    const ux = nx[k], uy = ny[k], a = bil(resp, w, x - ux, y - uy), c = bil(resp, w, x + ux, y + uy);
    if (v < a || v <= c) continue;
    const den = a - 2 * v + c, t = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
    pts.push({ x: x + 0.5 + t * ux, y: y + 0.5 + t * uy, s: v, nx: ux, ny: uy, k });
  }
  return pts;
}

// Group centre-line points into straight segments: 8-connected components of points whose line
// directions agree, ordered along their principal axis and split (Douglas-Peucker) until every
// piece is straight to within `tol` px. Pieces shorter than minLen are texture, text or noise.
// Returns { segs: [{ x0, y0, x1, y1, len, idx: [point indices] }], keep: Uint8Array per point }.
export function segments(pts, w, h, { minLen = 14, tol = 1.0 } = {}) {
  const at = new Int32Array(w * h).fill(-1);
  pts.forEach((p, i) => { at[p.k] = i; });
  const lab = new Int32Array(pts.length).fill(-1), segs = [], keep = new Uint8Array(pts.length);
  const compat = (a, b) => Math.abs(a.nx * b.nx + a.ny * b.ny) > 0.88; // within ~28°
  const stack = [];
  for (let i = 0; i < pts.length; i++) {
    if (lab[i] >= 0) continue;
    const comp = []; lab[i] = i; stack.push(i);
    while (stack.length) {
      const j = stack.pop(); comp.push(j);
      const k = pts[j].k, x = k % w, y = (k - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const n = at[Y * w + X];
        if (n >= 0 && lab[n] < 0 && compat(pts[j], pts[n])) { lab[n] = i; stack.push(n); }
      }
    }
    if (comp.length < minLen * 0.7) continue;
    split(comp);
  }
  function split(idx) {
    if (idx.length < minLen * 0.7) return;
    // principal axis
    let mx = 0, my = 0; for (const j of idx) { mx += pts[j].x; my += pts[j].y; } mx /= idx.length; my /= idx.length;
    let sxx = 0, syy = 0, sxy = 0; for (const j of idx) { const a = pts[j].x - mx, b = pts[j].y - my; sxx += a * a; syy += b * b; sxy += a * b; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy), ux = Math.cos(th), uy = Math.sin(th);
    const ord = idx.map((j) => [j, (pts[j].x - mx) * ux + (pts[j].y - my) * uy]).sort((a, b) => a[1] - b[1]);
    const len = ord[ord.length - 1][1] - ord[0][1];
    if (len < minLen) return;
    // deviation from the chord of the extreme points (DP), and from the fitted line
    let worst = 0, wi = -1;
    for (let i = 0; i < ord.length; i++) {
      const p = pts[ord[i][0]], dev = Math.abs(-(p.x - mx) * uy + (p.y - my) * ux);
      if (dev > worst) { worst = dev; wi = i; }
    }
    if (worst > tol) {
      if (wi < 3 || wi > ord.length - 4) { // an outlier at an end: drop it
        ord.splice(wi, 1); return split(ord.map((o) => o[0]));
      }
      split(ord.slice(0, wi).map((o) => o[0])); split(ord.slice(wi).map((o) => o[0])); return;
    }
    // gaps: a component bridging two collinear pieces through clutter is fine, but long gaps are not one line
    const a = ord[0][1], b = ord[ord.length - 1][1];
    const fill = ord.length / Math.max(1, len);
    if (fill < 0.5) return;
    const sidx = ord.map((o) => o[0]);
    for (const j of sidx) keep[j] = 1;
    segs.push({ x0: mx + ux * a, y0: my + uy * a, x1: mx + ux * b, y1: my + uy * b, len, idx: sidx, ux, uy });
  }
  return { segs, keep };
}

// Dominant line colour (difference from surroundings, in an opponent space) among the strongest
// centre-line points; returns weights in [0.15, 1] per point by closeness to it.
export function courtColour(pts, lm, lens = null) {
  if (!pts.length) return { weights: [], colour: null };
  const B = 32, H = new Float32Array(B * B), lo = -256, step = 512 / B;
  const opp = (k) => { const r = lm.dr[k], g = lm.dg[k], b = lm.db[k]; return [(r - g), (r + g - 2 * b) / 2, (r + g + b) / 3]; };
  pts.forEach((p, n) => {
    const [a, c] = opp(p.k), i = Math.floor((a - lo) / step), j = Math.floor((c - lo) / step);
    if (i >= 0 && i < B && j >= 0 && j < B) H[j * B + i] += p.s * (lens ? Math.sqrt(lens[n] || 1) : 1);
  });
  // smooth, then peak; neutral (grey) differences are lighting edges and glass, so bias against them
  let best = -1, bi = 0, bj = 0;
  for (let j = 1; j < B - 1; j++) for (let i = 1; i < B - 1; i++) {
    let s = 0; for (let v = -1; v <= 1; v++) for (let u = -1; u <= 1; u++) s += H[(j + v) * B + i + u];
    const ca = lo + (i + 0.5) * step, cc = lo + (j + 0.5) * step, chroma = Math.hypot(ca, cc);
    s *= Math.min(1, 0.35 + chroma / 40);
    if (s > best) { best = s; bi = i; bj = j; }
  }
  const ca = lo + (bi + 0.5) * step, cc = lo + (bj + 0.5) * step, chroma = Math.hypot(ca, cc);
  // a grey mode (white or dark lines) cannot discriminate by chroma, so weight by luminance sign instead
  let lumSign = 0;
  if (chroma < 20) { let s = 0; for (const p of pts) { const [a, c, l] = opp(p.k); if (Math.hypot(a - ca, c - cc) < 2 * step) s += Math.sign(l) * p.s; } lumSign = Math.sign(s); }
  const sig = Math.max(18, chroma * 0.6);
  const weights = pts.map((p) => {
    const [a, c, l] = opp(p.k);
    if (chroma < 20) return Math.sign(l) === lumSign && Math.hypot(a, c) < 30 ? 1 : 0.15;
    const d = Math.hypot(a - ca, c - cc);
    return Math.max(0.15, Math.exp(-(d * d) / (2 * sig * sig)));
  });
  return { weights, colour: [ca, cc], chroma, lumSign };
}

// Distance to the nearest seed pixel with that seed's index, by two raster passes propagating
// nearest-seed labels over 8-neighbours (vector propagation; exact to within a fraction of a
// pixel for line-like seed sets, ~10x faster than an exact transform). Returns { dist, near }.
export function distanceTransform(w, h, seeds) {
  const N = w * h, near = new Int32Array(N).fill(-1), d2 = new Float32Array(N).fill(1e12);
  for (const k of seeds) { near[k] = k; d2[k] = 0; }
  const sx = new Int32Array(N), sy = new Int32Array(N);
  for (let k = 0; k < N; k++) { sx[k] = k % w; sy[k] = (k / w) | 0; }
  const relax = (k, x, y, n) => {
    const s = near[n]; if (s < 0) return;
    const dx = x - sx[s], dy = y - sy[s], v = dx * dx + dy * dy;
    if (v < d2[k]) { d2[k] = v; near[k] = s; }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (y > 0) { relax(k, x, y, k - w); if (x > 0) relax(k, x, y, k - w - 1); if (x < w - 1) relax(k, x, y, k - w + 1); }
      if (x > 0) relax(k, x, y, k - 1);
    }
    for (let x = w - 2; x >= 0; x--) relax(y * w + x, x, y, y * w + x + 1);
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const k = y * w + x;
      if (y < h - 1) { relax(k, x, y, k + w); if (x > 0) relax(k, x, y, k + w - 1); if (x < w - 1) relax(k, x, y, k + w + 1); }
      if (x < w - 1) relax(k, x, y, k + 1);
    }
    for (let x = 1; x < w; x++) relax(y * w + x, x, y, y * w + x - 1);
  }
  const dist = new Float32Array(N); for (let k = 0; k < N; k++) dist[k] = Math.sqrt(d2[k]);
  return { dist, near };
}

// ---------- features ----------

export function features(rgba, W, H, opt = {}) {
  const t0 = now();
  const img = toWork(rgba, W, H, opt.workWidth || 480);
  const lm = lineMap(img, opt.scales);
  const cand = centreLines(lm, img, opt.thr ?? 10);
  const sg = segments(cand, img.w, img.h, { minLen: opt.minLen ?? Math.max(10, img.w / 45) });
  const segLen = new Float32Array(cand.length);
  for (const s of sg.segs) for (const j of s.idx) segLen[j] = s.len;
  const all = cand.filter((p, i) => sg.keep[i]).map((p, i) => p);
  const lens = cand.map((p, i) => segLen[i]).filter((v, i) => sg.keep[i]);
  const col = !opt.colour ? { weights: all.map(() => 1), colour: null } : courtColour(all, lm, lens);
  const pts = all.map((p, i) => ({ ...p, len: lens[i], wt: col.weights[i] * Math.min(1, lens[i] / (img.w / 15)) * Math.min(1, p.s / 30) }));
  { const ci = new Int32Array(cand.length).fill(-1); let n = 0; cand.forEach((p, i) => { if (sg.keep[i]) ci[i] = n++; });
    for (const s of sg.segs) { let t = 0; for (const j of s.idx) t += col.weights[ci[j]]; s.wt = t / s.idx.length; } }
  const ptAt = new Int32Array(img.w * img.h).fill(-1);
  pts.forEach((p, i) => { ptAt[p.k] = i; });
  // seeds for the distance map: the points that look like court lines
  const seeds = pts.filter((p) => p.wt > 0.25).map((p) => p.k);
  const dt = distanceTransform(img.w, img.h, seeds);
  const totalW = pts.reduce((s, p) => s + (p.wt > 0.25 ? p.wt : 0), 0);
  // principal point at the centre of the full frame, in work pixels
  return { img, lm, cand, segs: sg.segs, pts, ptAt, dt, colour: col, totalW, w: img.w, h: img.h, scale: img.scale, cx: W / 2 / img.scale, cy: H / 2 / img.scale, W, H, ms: now() - t0 };
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---------- fit ----------

// Model samples: every ~8 cm on the painted lines, with neighbour info for projected spacing.
export function modelSamples(tin, step = 0.08) {
  const model = courtModel({ tin });
  return { model, pts: samplePoints(model, step) };
}

// Physically possible cameras: above the floor and not behind the (opaque) front wall.
export const plausible = (cam) => cam.C[1] > 0.3 && cam.C[2] > 0.2 && cam.f > 30 && Math.abs(cam.k1) < 0.5;

// The back wall line is on the glass right in front of a camera behind the back wall: out of
// frame or a blur, never usable. Skip it for such cameras.
const skip = (cam, kind) => kind === 'back' && cam.C[1] > 9.45;

// Score a camera: weighted length (px) of model line that lands on image line pixels, minus a
// fraction of the length that lands on nothing, over in-frame samples. Higher is better.
export function scoreCamera(cam, F, S, tau = 3, lambda = 0.5) {
  const { w, h, dt } = F; let good = 0, bad = 0, prev = null, inFrame = 0;
  if (!plausible(cam)) return { score: -1e9, good: 0, bad: 0, inFrame: 0 };
  for (let i = 0; i < S.length; i++) {
    const s = S[i]; if (skip(cam, s.kind)) { prev = null; continue; }
    const u = cam.project(s.X);
    if (prev && prev.seg === s.seg && u[2] > 0 && prev.u[2] > 0) {
      const mx = (u[0] + prev.u[0]) / 2, my = (u[1] + prev.u[1]) / 2;
      if (mx >= 1 && my >= 1 && mx < w - 1 && my < h - 1) {
        const len = Math.min(40, Math.hypot(u[0] - prev.u[0], u[1] - prev.u[1]));
        const d = dt.dist[(my | 0) * w + (mx | 0)];
        if (d <= tau) good += len * (1 - d / (tau * 2)); else bad += len;
        inFrame++;
      }
    }
    prev = { u, seg: s.seg };
  }
  return { score: good - lambda * bad, good, bad, inFrame };
}

// Gauss-Newton ICP from a camera: each model sample is pulled toward its nearest image line point
// along the projected model line's normal, robustly weighted with scale tau. `free` masks the
// parameters that move (8: rx ry rz Cx Cy Cz logf k1).
export function refine(cam0, F, S, { iters = 12, tau = 4, free = [1, 1, 1, 1, 1, 1, 1, 0], minTau = 1, prior = null } = {}) {
  const { w, h, dt, pts, ptAt } = F;
  let cam = cam0.with(cam0.p), p = cam.p.slice();
  const idx = free.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), n = idx.length;
  const eps = [1e-4, 1e-4, 1e-4, 1e-3, 1e-3, 1e-3, 1e-4, 1e-4];
  let lastCost = Infinity, used = 0;
  for (let it = 0; it < iters; it++) {
    // correspondences under the current camera
    const corr = [];
    for (let i = 0; i < S.length; i++) {
      const s = S[i]; if (skip(cam, s.kind)) continue;
      const u = cam.project(s.X);
      if (!(u[2] > 0) || u[0] < 1 || u[1] < 1 || u[0] >= w - 1 || u[1] >= h - 1) continue;
      const k = (u[1] | 0) * w + (u[0] | 0), d = dt.dist[k];
      if (d > tau * 3) continue;
      const nk = dt.near[k], pi = ptAt[nk]; if (pi < 0) continue;
      const q = pts[pi];
      // projected direction of the model line at this sample
      const X2 = [s.X[0] + s.dir[0] * 0.05, s.X[1] + s.dir[1] * 0.05, s.X[2] + s.dir[2] * 0.05], u2 = cam.project(X2);
      let tx = u2[0] - u[0], ty = u2[1] - u[1]; const tl = Math.hypot(tx, ty); if (!(tl > 1e-6)) continue;
      tx /= tl; ty /= tl;
      const nx = -ty, ny = tx, r = nx * (u[0] - q.x) + ny * (u[1] - q.y);
      const wt = q.wt * (Math.abs(r) < tau ? (1 - (r / tau) ** 2) ** 2 : 0); // Tukey
      if (wt <= 0) continue;
      corr.push({ X: s.X, qx: q.x, qy: q.y, nx, ny, wt });
    }
    used = corr.length;
    if (used < 12) break;
    // Jacobian by forward differences
    const res = (c) => corr.map((o) => { const u = c.project(o.X); return o.nx * (u[0] - o.qx) + o.ny * (u[1] - o.qy); });
    const r0 = res(cam), J = [];
    for (const j of idx) { const pp = p.slice(); pp[j] += eps[j]; const rj = res(cam.with(pp)); J.push(rj.map((v, i) => (v - r0[i]) / eps[j])); }
    const A = new Float64Array(n * n), b = new Float64Array(n);
    let cost = 0;
    for (let i = 0; i < corr.length; i++) {
      const wt = corr[i].wt; if (!isFinite(r0[i])) continue; cost += wt * r0[i] * r0[i];
      for (let a = 0; a < n; a++) { const Ja = J[a][i]; if (!isFinite(Ja)) continue; b[a] -= wt * Ja * r0[i]; for (let c = 0; c <= a; c++) A[a * n + c] += wt * Ja * J[c][i]; }
    }
    for (let a = 0; a < n; a++) for (let c = 0; c < a; c++) A[c * n + a] = A[a * n + c];
    // weak prior pulls (k1 toward 0, etc.) and LM damping
    for (let a = 0; a < n; a++) A[a * n + a] = A[a * n + a] * 1.001 + 1e-6 + (idx[a] === 7 ? 1e4 : 0);
    if (prior) for (let a = 0; a < n; a++) if (prior[idx[a]]) { A[a * n + a] += prior[idx[a]]; }
    const dx = solve(A, b, n); if (!dx) break;
    // step with simple backtracking
    let step = 1, ok = false;
    for (let t = 0; t < 4; t++, step /= 2) {
      const pp = p.slice(); idx.forEach((j, a) => { pp[j] += step * dx[a]; });
      const c2 = cam.with(pp); if (!plausible(c2)) continue;
      const r2 = res(c2);
      let cs = 0; for (let i = 0; i < r2.length; i++) { const v = r2[i]; const ww = corr[i].wt; cs += isFinite(v) ? ww * Math.min(v * v, 9 * tau * tau) : ww * 9 * tau * tau; }
      if (cs <= cost) { p = pp; cam = c2; ok = true; break; }
    }
    const conv = Math.abs(lastCost - cost) < 1e-4 * cost;
    lastCost = cost;
    if (!ok || conv) { if (tau > minTau) { tau = Math.max(minTau, tau / 2); continue; } break; }
    if (tau > minTau && it % 2 === 1) tau = Math.max(minTau, tau * 0.7);
  }
  return { cam, used, tau };
}

// Seed cameras from priors over where squash cameras stand. Deterministic (seeded) for repeatability.
function* seeds(w, h, n, rng, cx, cy) {
  const W = 6.4, L = 9.75;
  for (let i = 0; i < n; i++) {
    const u = rng();
    let C, T;
    if (u < 0.75) { // broadcast: behind / above the back wall, looking at the front wall
      C = [W / 2 + (rng() - 0.5) * 6, L + 0.5 + rng() * 9, 1.5 + rng() * 6];
      T = [W / 2 + (rng() - 0.5) * 3, rng() * 5, rng() * 3];
    } else if (u < 0.85) { // high overhead, steep
      C = [W / 2 + (rng() - 0.5) * 4, L * (0.5 + rng() * 0.8), 5 + rng() * 6];
      T = [W / 2 + (rng() - 0.5) * 2, rng() * 6, 0];
    } else if (u < 0.93) { // side / corner views through the glass
      const side = rng() < 0.5 ? -1 : 1;
      C = [W / 2 + side * (4 + rng() * 6), rng() * L * 1.3, 1 + rng() * 5];
      T = [W / 2 + (rng() - 0.5) * 3, rng() * L, rng() * 2];
    } else { // inside the court or low behind the back wall (handheld, referee, phone)
      C = [W / 2 + (rng() - 0.5) * 5, L * (0.4 + rng() * 0.9), 0.8 + rng() * 2.5];
      T = [W / 2 + (rng() - 0.5) * 3, rng() * 3, rng() * 2.5];
    }
    const hfov = (25 + rng() * 75) * Math.PI / 180, f = w / 2 / Math.tan(hfov / 2);
    const roll = (rng() - 0.5) * 0.12;
    yield Camera.fromLookAt(C, T, roll, f, w, h, 0, cx, cy);
  }
}

export function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Full detection: features + global search + refinement. Returns { cam (in original pixels), score, ... }
// Project the painted lines as 2D pieces (clipped in front of the camera, split so distortion bends them).
export function projectLines(cam, model, pieces = 6) {
  const out = [];
  for (const s of model.lines) {
    if (skip(cam, s.kind)) continue;
    let a = s.a, b = s.b;
    const za = cam.toCam(a)[2], zb = cam.toCam(b)[2], near = 0.2;
    if (za < near && zb < near) continue;
    if (za < near) { const t = (near - za) / (zb - za); a = a.map((v, i) => v + (b[i] - v) * t); }
    else if (zb < near) { const t = (near - zb) / (za - zb); b = b.map((v, i) => v + (a[i] - v) * t); }
    let prev = cam.project(a);
    for (let k = 1; k <= pieces; k++) {
      const X = a.map((v, i) => v + (b[i] - v) * k / pieces), u = cam.project(X);
      out.push([prev[0], prev[1], u[0], u[1]]); prev = u;
    }
  }
  return out;
}

// Image -> model: weighted length of detected line segments lying on (and along) a projected model line.
export function explainScore(cam, F, model, tol = 2.5) {
  const P = projectLines(cam, model);
  let ex = 0;
  for (const s of F.segs) {
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0; let hit = 0;
    for (let t = 0.1; t < 1; t += 0.2) {
      const x = s.x0 + dx * t, y = s.y0 + dy * t;
      for (const p of P) {
        const ex2 = p[2] - p[0], ey2 = p[3] - p[1], l2 = ex2 * ex2 + ey2 * ey2; if (!(l2 > 1)) continue;
        const u = Math.max(0, Math.min(1, ((x - p[0]) * ex2 + (y - p[1]) * ey2) / l2));
        const d = Math.hypot(x - p[0] - u * ex2, y - p[1] - u * ey2);
        if (d < tol && Math.abs(dx * ey2 - dy * ex2) / Math.sqrt(l2) < 0.17 * s.len) { hit++; break; }
      }
    }
    ex += s.len * s.wt * hit / 5;
  }
  return ex;
}

export function total(cam, F, S, model) {
  const a = scoreCamera(cam, F, S, 2, 0.5), e = explainScore(cam, F, model);
  return { ...a, explained: e, score: a.score + e };
}

// Full detection: features + global search + refinement. Returns { cam (in original pixels), score, ... }
// Two resolutions see different things: the coarse one is steadier on clutter, the fine one
// resolves thin distant lines. Search both and keep the camera that explains the fine image best.
export function detectCourt(rgba, W, H, opt = {}) {
  const t0 = now(), sizes = opt.workWidth ? [opt.workWidth] : opt.sizes || [640, 480];
  let best = null;
  const fine = features(rgba, W, H, { ...opt, workWidth: sizes[0] });
  const { model, pts: S } = modelSamples(opt.tin ?? 0.48, 0.08);
  for (const ww of sizes) {
    const r = detectAt(rgba, W, H, { ...opt, workWidth: ww, features: ww === sizes[0] ? fine : undefined });
    // judge on the fine features (polished there first)
    let c = toWorkCam(r.cam, fine);
    if (ww !== sizes[0]) c = refine(c, fine, S, { tau: 3, iters: 10, minTau: 1, free: [1, 1, 1, 1, 1, 1, 1, 0] }).cam;
    const sc = total(c, fine, S, model);
    if (!best || sc.score > best.sc.score) best = { r, c, sc, ww };
  }
  const res = finish({ cam: best.c, ...best.sc }, fine, S, opt);
  res.ms = { features: fine.ms, total: now() - t0 };
  res.features = fine; res.workWidth = best.ww; res.candidates = best.r.candidates;
  return res;
}

function detectAt(rgba, W, H, opt = {}) {
  const t0 = now();
  const F = opt.features || features(rgba, W, H, opt);
  const tin = opt.tin ?? 0.48;
  const { model, pts: S } = modelSamples(tin, 0.08), Sc = modelSamples(tin, 0.25).pts;
  const rng = mulberry32(opt.seed ?? 1);
  const tauC = Math.max(4, F.w / 80);
  const sc0 = (cam) => scoreCamera(cam, F, Sc, tauC, 0.35).score;
  // coarse: many seeds scored with a forgiving tolerance
  const nSeeds = opt.seeds ?? 6000, keep = opt.keep ?? 60;
  let top = [];
  for (const cam of seeds(F.w, F.h, nSeeds, rng, F.cx, F.cy)) {
    const sc = sc0(cam);
    if (top.length < keep || sc > top[top.length - 1].sc) { top.push({ cam, sc }); top.sort((a, b) => b.sc - a.sc); if (top.length > keep) top.pop(); }
  }
  // local stochastic search around each survivor (shrinking steps), still on the coarse score
  const sd = [0.03, 0.03, 0.03, 0.4, 0.6, 0.4, 0.08, 0];
  for (const t of top) {
    for (let it = 0, scale = 1; it < 36; it++) {
      if (it % 12 === 11) scale *= 0.5;
      const p = t.cam.p.map((v, i) => v + sd[i] * scale * gauss(rng)), c = t.cam.with(p), sc = sc0(c);
      if (sc > t.sc) { t.cam = c; t.sc = sc; }
    }
  }
  // keep distinct poses: local search often walks several seeds into the same basin
  top.sort((a, b) => b.sc - a.sc);
  const same = (a, b) => Math.hypot(a.C[0] - b.C[0], a.C[1] - b.C[1], a.C[2] - b.C[2]) < 0.6 && a.R[6] * b.R[6] + a.R[7] * b.R[7] + a.R[8] * b.R[8] > 0.998 && Math.abs(a.p[6] - b.p[6]) < 0.08;
  const distinct = [];
  for (const t of top) if (!distinct.some((u) => same(u.cam, t.cam))) distinct.push(t);
  top = distinct.slice(0, opt.refineN ?? 16);
  const tCoarse = now() - t0;
  // refine each, re-score both ways (model on image lines, image lines on the model)
  let best = null;
  const tried = [];
  for (const { cam } of top) {
    let c = refine(cam, F, Sc, { tau: tauC * 2.5, iters: 14, minTau: tauC / 2 }).cam;
    c = refine(c, F, S, { tau: tauC, iters: 10, minTau: 1.2 }).cam;
    const sc = total(c, F, S, model);
    tried.push({ cam: c, ...sc });
    if (!best || sc.score > best.score) best = { cam: c, ...sc };
  }
  // the focal / distance trade-off: try the best at other zooms, keep any that explains more
  if (best) for (const k of [0.85, 0.92, 1.08, 1.18]) {
    const p = best.cam.p.slice(), c0 = best.cam;
    const fwd = [c0.R[6], c0.R[7], c0.R[8]], target = 12; // dolly along the view axis to keep the centre's scale
    p[6] += Math.log(k); for (let i = 0; i < 3; i++) p[3 + i] -= fwd[i] * target * (k - 1);
    let c = refine(c0.with(p), F, Sc, { tau: tauC * 2, iters: 12, minTau: tauC / 2 }).cam;
    c = refine(c, F, S, { tau: tauC, iters: 10, minTau: 1.2 }).cam;
    const sc = total(c, F, S, model); tried.push({ cam: c, ...sc });
    if (sc.score > best.score) best = { cam: c, ...sc };
  }
  // final polish with the distortion term free
  if (best) {
    const r = refine(best.cam, F, S, { tau: 2, iters: 10, minTau: 1, free: [1, 1, 1, 1, 1, 1, 1, opt.distortion === false ? 0 : 1] });
    const sc = total(r.cam, F, S, model);
    if (sc.score >= best.score * 0.98) best = { cam: r.cam, ...sc };
  }
  const res = finish(best, F, S, opt);
  res.ms = { features: F.ms, coarse: tCoarse - (opt.features ? 0 : F.ms), total: now() - t0 };
  res.features = F;
  res.candidates = tried.sort((a, b) => b.score - a.score).slice(0, 5).map((t) => ({ score: t.score, cam: toFull(t.cam, F) }));
  return res;
}

function gauss(rng) { let u = 0; while (!u) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }

// Track: refine from the previous frame's camera (original-pixel camera). Fast path for video.
export function trackCourt(rgba, W, H, prevCam, opt = {}) {
  const t0 = now();
  const F = opt.features || features(rgba, W, H, opt);
  const tin = opt.tin ?? 0.48, S = modelSamples(tin, 0.08).pts;
  const start = toWorkCam(prevCam, F);
  // wide capture first (a fast pan moves lines tens of pixels), then tight; distortion stays as detected
  const Sc = modelSamples(tin, 0.25).pts, tauW = opt.tau ?? Math.max(6, F.w / 40);
  let c = refine(start, F, Sc, { tau: tauW, iters: 8, minTau: tauW / 3, free: [1, 1, 1, 1, 1, 1, 1, 0] }).cam;
  c = refine(c, F, S, { tau: 4, iters: 8, minTau: 1.2, free: [1, 1, 1, 1, 1, 1, 1, 0] }).cam;
    const sc = scoreCamera(c, F, S, 2, 0.5);
  const res = finish({ cam: c, ...sc }, F, S, opt);
  res.ms = { features: F.ms, total: now() - t0 };
  res.features = F;
  return res;
}

// Camera in work pixels -> original pixels (same pose, focal scaled, k1 unchanged in normalised units).
function toFull(cam, F) { const p = cam.p.slice(); p[6] += Math.log(F.scale); return new Camera(p, F.W, F.H, cam.cx * F.scale, cam.cy * F.scale); }
export function toWorkCam(cam, F) { const p = cam.p.slice(); p[6] -= Math.log(F.scale); return new Camera(p, F.w, F.h, cam.cx / F.scale, cam.cy / F.scale); }

// Quality numbers and the camera in original pixels.
function finish(best, F, S, opt) {
  if (!best) return { ok: false };
  const cam = best.cam;
  // fraction of image court-line weight the model explains, and model coverage
  let explained = 0;
  const near = new Uint8Array(F.w * F.h);
  for (const s of S) { const u = cam.project(s.X); if (u[2] > 0 && u[0] >= 0 && u[1] >= 0 && u[0] < F.w && u[1] < F.h) near[(u[1] | 0) * F.w + (u[0] | 0)] = 1; }
  // dilate by 2 px
  const dil = dilate(near, F.w, F.h, 2);
  for (const p of F.pts) if (p.wt > 0.25 && dil[p.k]) explained += p.wt;
  const coverage = best.good / Math.max(1, best.good + best.bad);
  const recall = explained / Math.max(1e-9, F.totalW);
  // residual RMS of inliers (work px)
  let se = 0, n = 0;
  for (const s of S) {
    const u = cam.project(s.X); if (!(u[2] > 0) || u[0] < 0 || u[1] < 0 || u[0] >= F.w || u[1] >= F.h) continue;
    const d = F.dt.dist[(u[1] | 0) * F.w + (u[0] | 0)]; if (d < 2) { se += d * d; n++; }
  }
  const full = toFull(cam, F);
  const ok = coverage > 0.45 && best.good > 100 * F.w / 640;
  return { ok, explained: best.explained, cam: full, workCam: cam, score: best.score, good: best.good, bad: best.bad, coverage, recall, rms: Math.sqrt(se / Math.max(1, n)) * F.scale };
}

function dilate(m, w, h, r) {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const X = x + i, Y = y + j; if (X >= 0 && Y >= 0 && X < w && Y < h) o[Y * w + X] = 1; }
  return o;
}

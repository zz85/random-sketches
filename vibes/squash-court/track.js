// Sparse frame-to-frame tracking for video. Instead of building the whole-frame line map (most of
// the cost of a full fit), every model line sample is projected with the last camera and a short
// colour profile is read across it, straight from the frame's RGBA. The painted line is the peak
// of the same "both sides alike, centre different" response the detector uses, found along the
// normal near the predicted position. That costs a few thousand pixel reads instead of a pass
// over every pixel, so the frame can be read at full resolution.
//
// Three ways to handle a frame, cheapest first:
//   static  the lines are still where the camera puts them (sub-pixel): the camera is kept as it is,
//           so a fixed camera gives fixed coordinates, not a fresh, slightly different fit every frame.
//           The small offsets measured on static frames are averaged and applied now and then, so the
//           fit gets more precise while the camera holds still, without jitter.
//   moving  a pan / tilt / zoom: Gauss-Newton on the profile peaks (RAPiD-style), with a soft prior
//           holding the camera position near where it has been. Broadcast and club cameras pan and
//           zoom on a fixed mount; the prior takes away the zoom / distance valley that makes an
//           unconstrained fit drift while zooming in, and still lets a camera that really moves move.
//   lost    too few lines found where expected (a cut, a replay graphic): the caller falls back to the
//           full tracker or a fresh detection.
import { Camera, solve } from './camera.js';
import { modelSamples, plausible, skip, KIND_W, trackCourt } from './detect.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
// across-line direction in each surface: the line direction crossed with the surface normal
const NORMAL = { floor: [0, 0, 1], front: [0, 1, 0], back: [0, 1, 0], side: [1, 0, 0] };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function createTracker(opt = {}) {
  return {
    tin: opt.tin ?? 0.48, S: null, // model samples
    anchor: null, // camera position the prior holds to
    mount: 'fixed', strikes: 0, // strikes: evidence (px² per sample) that it moves. a camera is assumed to pan, tilt and zoom on a fixed mount until frames show otherwise
    refHit: null, // fraction of the visible model found on the reference frames
    still: 0, acc: null, accN: 0, // static frames in a row, and their summed offsets
    frames: 0, modes: { static: 0, moving: 0, lost: 0 },
    shots: [], // cameras this video has cut to and held, to come back to without a new detection
  };
}

// Reset the reference after a full fit (new shot, re-detection). Keeps nothing from the old shot.
export function resetTracker(st, cam, tin) {
  st.tin = tin ?? st.tin; st.S = null; st.anchor = cam ? cam.C.slice() : null; st.mount = 'fixed'; st.strikes = 0; st.refined = false; st.colours = null; st.vel = null; st.lastC = null; st.okRun = 0; st.refHit = null; st.still = 0; st.acc = null; st.accN = 0;
}

function samples(st) {
  if (!st.S) {
    st.S = modelSamples(st.tin, 0.1).pts.map((s) => ({ ...s, across: (() => { const a = cross(s.dir, NORMAL[s.kind]); const n = Math.hypot(...a); return a.map((v) => v / n); })() }));
  }
  return st.S;
}

// Bilinear RGB from RGBA, clamped to the frame.
function rgbAt(rgba, W, H, x, y, out, o) {
  x -= 0.5; y -= 0.5; // pixel centres
  if (x < 0) x = 0; else if (x > W - 1.001) x = W - 1.001;
  if (y < 0) y = 0; else if (y > H - 1.001) y = H - 1.001;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, k = (y0 * W + x0) * 4, k2 = k + W * 4;
  const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
  out[o] = a * rgba[k] + b * rgba[k + 4] + c * rgba[k2] + d * rgba[k2 + 4];
  out[o + 1] = a * rgba[k + 1] + b * rgba[k + 5] + c * rgba[k2 + 1] + d * rgba[k2 + 5];
  out[o + 2] = a * rgba[k + 2] + b * rgba[k + 6] + c * rgba[k2 + 2] + d * rgba[k2 + 6];
}

const PROF = new Float32Array(3 * 512), RESP = new Float32Array(256), DV = new Float32Array(3 * 256), TMP = new Float32Array(9);

// For every visible sample: the painted line's offset (px, along the projected normal) within
// ±R of where cam puts it, or none. Returns the correspondences and the hit fraction.
export function searchLines(rgba, W, H, cam, S, R, opt = {}) {
  const thr = opt.thr ?? 10, margin = 4, corr = [];
  let seen = 0, found = 0;
  for (let i = 0; i < S.length; i++) {
    const s = S[i]; if (skip(cam, s.kind, s.name)) continue;
    const u = cam.project(s.X); if (!(u[2] > 0)) continue;
    if (u[0] < margin + R || u[1] < margin + R || u[0] > W - margin - R || u[1] > H - margin - R) continue;
    const X = s.X, d = s.dir, a = s.across;
    const ut = cam.project([X[0] + d[0] * 0.05, X[1] + d[1] * 0.05, X[2] + d[2] * 0.05]);
    let tx = ut[0] - u[0], ty = ut[1] - u[1]; const tl = Math.hypot(tx, ty); if (!(tl > 1e-6)) continue;
    tx /= tl; ty /= tl; const nx = -ty, ny = tx;
    // painted width in pixels here (5 cm across the line, in its own surface)
    const pa = cam.project([X[0] + a[0] * 0.025, X[1] + a[1] * 0.025, X[2] + a[2] * 0.025]), pb = cam.project([X[0] - a[0] * 0.025, X[1] - a[1] * 0.025, X[2] - a[2] * 0.025]);
    const wpx = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) || 1;
    const kw = KIND_W[s.kind] ?? 1;
    seen += kw;
    const s1 = Math.max(2, Math.round(wpx * 0.5 + 1.5)), s2 = Math.round(s1 * 1.7), M = R + s2, L = 2 * M + 1;
    if (L > 512) continue;
    // colour profile across the line, each point averaged with ±1.5 px along it
    for (let j = 0; j < L; j++) {
      const t = j - M, px = u[0] + nx * t, py = u[1] + ny * t;
      rgbAt(rgba, W, H, px, py, TMP, 0); rgbAt(rgba, W, H, px - tx * 1.5, py - ty * 1.5, TMP, 3); rgbAt(rgba, W, H, px + tx * 1.5, py + ty * 1.5, TMP, 6);
      PROF[3 * j] = (TMP[0] + TMP[3] + TMP[6]) / 3; PROF[3 * j + 1] = (TMP[1] + TMP[4] + TMP[7]) / 3; PROF[3 * j + 2] = (TMP[2] + TMP[5] + TMP[8]) / 3;
    }
    // the colour the painted line differs from its surroundings by, once known for this kind of
    // line: a glass seam, a panel post or the scoreboard next to a faint red line is a different colour
    const col = opt.colours && opt.colours[s.kind];
    let vmax = 0;
    for (let j = -R; j <= R; j++) {
      const c = 3 * (j + M); let best = 0, br = 0, bg = 0, bb = 0;
      for (const sc of [s1, s2]) {
        const p = c - 3 * sc, q = c + 3 * sc;
        const ar = PROF[c] - PROF[p], ag = PROF[c + 1] - PROF[p + 1], ab = PROF[c + 2] - PROF[p + 2];
        const cr = PROF[c] - PROF[q], cg = PROF[c + 1] - PROF[q + 1], cb = PROF[c + 2] - PROF[q + 2];
        const na = ar * ar + ag * ag + ab * ab, nc = cr * cr + cg * cg + cb * cb, dot = ar * cr + ag * cg + ab * cb;
        if (dot <= 0.7 * Math.sqrt(na * nc)) continue;
        const er = PROF[p] - PROF[q], eg = PROF[p + 1] - PROF[q + 1], eb = PROF[p + 2] - PROF[q + 2];
        const v = Math.sqrt(Math.min(na, nc)) - 0.5 * Math.sqrt(er * er + eg * eg + eb * eb);
        if (v > best) { best = v; br = (ar + cr) / 2; bg = (ag + cg) / 2; bb = (ab + cb) / 2; }
      }
      if (col && best > 0 && (br * col[0] + bg * col[1] + bb * col[2]) < (opt.colourCos ?? 0.8) * Math.hypot(br, bg, bb)) best = 0;
      RESP[j + R] = best; DV[3 * (j + R)] = br; DV[3 * (j + R) + 1] = bg; DV[3 * (j + R) + 2] = bb; if (best > vmax) vmax = best;
    }
    if (vmax < thr) continue;
    // the peak nearest the prediction among the strong ones (a reflection or a seam further off loses)
    let pick = 0, pd = Infinity;
    for (let j = -R; j <= R; j++) {
      const v = RESP[j + R]; if (v < thr || v < 0.5 * vmax) continue;
      if ((j > -R && RESP[j + R - 1] > v) || (j < R && RESP[j + R + 1] >= v)) continue;
      if (Math.abs(j) < pd) { pd = Math.abs(j); pick = j; }
    }
    if (pd === Infinity) continue;
    const v0 = RESP[pick + R], vm = pick > -R ? RESP[pick + R - 1] : v0, vp = pick < R ? RESP[pick + R + 1] : v0;
    const den = vm - 2 * v0 + vp, off = pick + (den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (vm - vp) / den)) : 0);
    // the line must continue along the model direction there: a line crossing the profile at an
    // angle (a glass seam, a panel frame, a player's shirt stripe) does not
    const qx = u[0] + nx * off, qy = u[1] + ny * off, c = 3 * (pick + M);
    rgbAt(rgba, W, H, qx - tx * (s1 + 1.5), qy - ty * (s1 + 1.5), TMP, 0); rgbAt(rgba, W, H, qx + tx * (s1 + 1.5), qy + ty * (s1 + 1.5), TMP, 3);
    const side = (PROF[c - 3 * s1] + PROF[c + 3 * s1]) / 2, contrast = Math.abs(PROF[c] - side) + Math.abs(PROF[c + 1] - (PROF[c + 1 - 3 * s1] + PROF[c + 1 + 3 * s1]) / 2) + Math.abs(PROF[c + 2] - (PROF[c + 2 - 3 * s1] + PROF[c + 2 + 3 * s1]) / 2);
    const dev = (k) => Math.abs(TMP[k] - PROF[c]) + Math.abs(TMP[k + 1] - PROF[c + 1]) + Math.abs(TMP[k + 2] - PROF[c + 2]);
    if ((dev(0) + dev(3)) / 2 > 0.6 * contrast) continue;
    found += kw;
    corr.push({ i, X, qx, qy, nx, ny, off, wt: kw * Math.min(1, v0 / 30), kind: s.kind, dv: [DV[3 * (pick + R)], DV[3 * (pick + R) + 1], DV[3 * (pick + R) + 2]] });
  }
  return { corr, hit: seen > 0 ? found / seen : 0, seen };
}

// Gauss-Newton on point-to-line residuals n·(project(X) - q), robust (Tukey, scale tau), with an
// optional Gaussian prior on the camera position: (C - prior.a)ᵀ prior.L (C - prior.a), L in px² per
// m². Returns the camera, its cost, and the data-only normal matrix (for the position's uncertainty).
export function fitSparse(cam0, corr, { iters = 3, tau = 3, free = [1, 1, 1, 1, 1, 1, 1, 0], prior = null } = {}) {
  let cam = cam0, p = cam.p.slice();
  const idx = free.map((v, i) => (v ? i : -1)).filter((i) => i >= 0), n = idx.length;
  const eps = [1e-5, 1e-5, 1e-5, 1e-4, 1e-4, 1e-4, 1e-5, 1e-5];
  const res = (c) => corr.map((o) => { const u = c.project(o.X); return o.nx * (u[0] - o.qx) + o.ny * (u[1] - o.qy); });
  const costOf = (c, r) => {
    let s = 0; for (let i = 0; i < r.length; i++) { const v = r[i]; s += corr[i].wt * (isFinite(v) ? Math.min(v * v, tau * tau) : tau * tau); }
    if (prior) { const d = [c.p[3] - prior.a[0], c.p[4] - prior.a[1], c.p[5] - prior.a[2]]; for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) s += d[a] * prior.L[a * 3 + b] * d[b]; }
    return s;
  };
  let r0 = res(cam), cost = costOf(cam, r0), data = null;
  for (let it = 0; it < iters; it++) {
    if (corr.length < 8) break;
    const J = idx.map((j) => { const pp = p.slice(); pp[j] += eps[j]; const rj = res(cam.with(pp)); return rj.map((v, i) => (v - r0[i]) / eps[j]); });
    const A = new Float64Array(n * n), b = new Float64Array(n);
    for (let i = 0; i < corr.length; i++) {
      const r = r0[i]; if (!isFinite(r) || Math.abs(r) >= tau) continue;
      const wt = corr[i].wt * (1 - (r / tau) ** 2) ** 2;
      for (let a = 0; a < n; a++) { const Ja = J[a][i]; if (!isFinite(Ja)) continue; b[a] -= wt * Ja * r; for (let c = 0; c <= a; c++) A[a * n + c] += wt * Ja * J[c][i]; }
    }
    for (let a = 0; a < n; a++) for (let c = 0; c < a; c++) A[c * n + a] = A[a * n + c];
    data = { A: A.slice(), idx };
    for (let a = 0; a < n; a++) A[a * n + a] = A[a * n + a] * 1.001 + 1e-6;
    if (prior) {
      const ci = [3, 4, 5].map((j) => idx.indexOf(j)), d = [p[3] - prior.a[0], p[4] - prior.a[1], p[5] - prior.a[2]];
      for (let a = 0; a < 3; a++) { if (ci[a] < 0) continue; for (let c = 0; c < 3; c++) { if (ci[c] < 0) continue; A[ci[a] * n + ci[c]] += prior.L[a * 3 + c]; b[ci[a]] -= prior.L[a * 3 + c] * d[c]; } }
    }
    const dx = solve(A, b, n); if (!dx) break;
    let ok = false;
    for (let step = 1, t = 0; t < 4; t++, step /= 2) {
      const pp = p.slice(); idx.forEach((j, a) => { pp[j] += step * dx[a]; });
      const c2 = cam.with(pp); if (!plausible(c2)) continue;
      const r2 = res(c2), c2cost = costOf(c2, r2);
      if (c2cost <= cost) { p = pp; cam = c2; r0 = r2; ok = c2cost < cost * (1 - 1e-6); cost = c2cost; break; }
    }
    if (!ok) break;
  }
  return { cam, cost, data };
}

// 3×3 helpers for the position filter
const inv3 = (m) => {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-30)) return null;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
};
const mul3 = (x, y) => { const o = new Array(9).fill(0); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) o[r * 3 + c] += x[r * 3 + k] * y[k * 3 + c]; return o; };
const add3 = (x, y, k = 1) => x.map((v, i) => v + k * y[i]);
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Marginal covariance (m²) of the camera position from a data normal matrix, residuals of sigma px.
function positionCov(data, sigma) {
  if (!data) return null;
  const { A, idx } = data, n = idx.length, ci = [3, 4, 5].map((j) => idx.indexOf(j)); if (ci.some((v) => v < 0)) return null;
  const cols = [];
  for (const k of ci) { const M = Float64Array.from(A); for (let a = 0; a < n; a++) M[a * n + a] += 1e-9; const e = new Float64Array(n); e[k] = 1; const x = solve(M, e, n); if (!x) return null; cols.push(ci.map((j) => x[j] * sigma * sigma)); }
  return [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
}

// Mean colour difference (unit vector) of the lines found, per kind of line, blended in at rate a.
function learnColours(st, corr, a) {
  const sum = {};
  for (const c of corr) { const n = Math.hypot(...c.dv); if (!(n > 0)) continue; const v = sum[c.kind] || (sum[c.kind] = [0, 0, 0, 0]); for (let k = 0; k < 3; k++) v[k] += c.dv[k] / n; v[3]++; }
  const out = { ...(st.colours || {}) };
  for (const k in sum) {
    if (sum[k][3] < 12) continue;
    const m = sum[k].slice(0, 3), n = Math.hypot(...m); if (!(n > 0.6 * sum[k][3])) continue; // too mixed to be one colour
    const u = m.map((v) => v / n), o = out[k];
    const b = o ? o.map((v, i) => v + a * (u[i] - v)) : u, bn = Math.hypot(...b);
    out[k] = b.map((v) => v / bn);
  }
  st.colours = out;
}


// Track one frame. cam is the last camera in this frame's pixel grid. Returns
// { ok, cam, mode: 'static' | 'moving' | 'lost', hit, rms, n, ms }.
export function sparseTrack(rgba, W, H, cam, st, opt = {}) {
  const t0 = now(), S = samples(st);
  st.frames++;
  if (!st.anchor) st.anchor = cam.C.slice();
  // a lost frame (a cut away, a replay wipe) must not move what the tracker believes about the mount
  const keep = { anchor: st.anchor.slice(), mount: st.mount, strikes: st.strikes, vel: st.vel, lastC: st.lastC, refined: st.refined };
  // the position prior: held to a few millimetres on a fixed mount, a loose damping once the
  // mount has been seen to move (px² per m²: a 1 cm move costs as much as one sample 1 px off)
  const priorOf = () => { const sd = st.mount === 'fixed' && st.refined ? (opt.lockSd ?? 0.01) : (opt.freeSd ?? 0.08), l = 1 / (sd * sd); return { a: st.anchor, L: [l, 0, 0, 0, l, 0, 0, 0, l] }; };
  // where the lines are relative to the last camera, within a few pixels; on the first frame this
  // also learns the colour of each kind of line from what lies under the fitted camera
  if (!st.colours) { const first = searchLines(rgba, W, H, cam, S, 2, opt); learnColours(st, first.corr, 1); }
  opt = { ...opt, colours: st.colours };
  const near = searchLines(rgba, W, H, cam, S, 3, opt);
  const ref = st.refHit ?? 0;
  // has the camera moved? Not judged per line sample (each offset carries a few tenths of a pixel
  // of noise) but by the one Gauss-Newton step all of them ask for together: how far it would move
  // the court in the image
  let moved = Infinity;
  if (st.refined && near.corr.length >= 30) {
    const c1 = fitSparse(cam, near.corr, { iters: 1, tau: 1.5, prior: priorOf() }).cam;
    let sum = 0; for (const c of near.corr) { const a = cam.project(c.X), b = c1.project(c.X); sum += Math.hypot(a[0] - b[0], a[1] - b[1]); }
    moved = sum / near.corr.length;
  }
  let out, mode, fin;
  // the first frame after a full fit is always refitted here: the full fit works at 480 px, the profiles
  // at the frame's own resolution, and a camera a few pixels off would otherwise be held as it is
  if (near.hit >= 0.8 * ref && moved < (opt.stillPx ?? 0.2)) {
    // static: keep the camera. Average the residual offsets over the still frames; once enough have
    // been seen, apply them as one small correction.
    mode = 'static'; st.still++;
    if (!st.acc) { st.acc = new Float32Array(S.length * 2); st.accN = 0; }
    for (const c of near.corr) { st.acc[2 * c.i] += c.off; st.acc[2 * c.i + 1]++; }
    st.accN++;
    out = cam; fin = near;
    if (st.accN >= (opt.settle ?? 12)) {
      const avg = [];
      for (const c of near.corr) {
        const k = st.acc[2 * c.i + 1]; if (k < st.accN / 2) continue;
        const o = st.acc[2 * c.i] / k, u0x = c.qx - c.nx * c.off, u0y = c.qy - c.ny * c.off;
        avg.push({ ...c, off: o, qx: u0x + c.nx * o, qy: u0y + c.ny * o, wt: c.wt * Math.sqrt(k) });
      }
      if (avg.length >= 30) { out = fitSparse(cam, avg, { iters: 2, tau: 1.5, prior: priorOf() }).cam; fin = null; }
      st.acc = null; st.accN = 0;
    }
  } else {
    // moving: re-find the lines in a wide window, fit, narrow the window, fit again
    mode = 'moving'; st.still = 0; st.acc = null; st.accN = 0;
    const prior = priorOf();
    let c = cam;
    for (const R of opt.radii ?? [24, 8, 3]) {
      const sr = R === 3 && c === cam ? near : searchLines(rgba, W, H, c, S, R, opt);
      if (sr.corr.length < 20) break;
      c = fitSparse(c, sr.corr, { iters: 3, tau: Math.max(1.5, R / 2), prior }).cam;
    }
    out = c;
    // the position the mount is held to starts from this first full-resolution fit
    if (!st.refined) { st.refined = true; st.anchor = out.C.slice(); }
    fin = searchLines(rgba, W, H, out, S, 3, opt);
    if (st.mount === 'fixed' && fin.corr.length >= 30) {
      // does the frame contradict the fixed position? Fit the same lines with the position free: a
      // mount that really moves leaves a clearly better fit for several frames running, while the
      // zoom / distance valley (where a free fit would wander) gains nothing
      const lock = fitSparse(out, fin.corr, { iters: 0, tau: 1.5 }).cost, fr = fitSparse(out, fin.corr, { iters: 3, tau: 1.5 });
      const gain = (lock - fr.cost) / fin.corr.length;
      if (opt.debug) opt.debug.push({ lock: lock / fin.corr.length, free: fr.cost / fin.corr.length, gain, dC: Math.hypot(...fr.cam.C.map((v, k) => v - out.C[k])) });
      // evidence accumulates (CUSUM): a pan or a zoom on a fixed mount gains a little now and then, a
      // dolly or a hand-held camera gains on frame after frame
      st.strikes = Math.max(0, st.strikes + gain - (opt.slack ?? 0.01));
      if (st.strikes > (opt.release ?? 0.1)) { st.mount = 'free'; out = fr.cam; fin = null; }
      // the position found at detection is a single frame's estimate: average the free fits into it
      // slowly, so the fixed position itself gets more exact as the camera pans and zooms
      else for (let k = 0; k < 3; k++) st.anchor[k] += (opt.settleC ?? 0.03) * (fr.cam.C[k] - st.anchor[k]);
    }
    // a moving mount: the prior is a constant-velocity prediction, so the position follows the image
    // where the image pins it and coasts along where it does not (the zoom / distance valley)
    if (st.mount === 'free') {
      const v = st.lastC ? out.C.map((x, k) => x - st.lastC[k]) : [0, 0, 0];
      st.vel = st.vel ? st.vel.map((x, k) => x + 0.5 * (v[k] - x)) : v;
      st.anchor = out.C.map((x, k) => x + st.vel[k]);
    }
    st.lastC = out.C.slice();
  }
  // how well the result explains the frame
  if (!fin) fin = searchLines(rgba, W, H, out, S, 3, opt);
  let se = 0; for (const c of fin.corr) se += c.off * c.off;
  const rms = Math.sqrt(se / Math.max(1, fin.corr.length));
  const ok = fin.corr.length >= 30 && fin.hit >= (opt.lostFrac ?? 0.6) * ref && fin.hit > (st.refHit == null ? 0.35 : 0.15);
  if (!ok) { mode = 'lost'; Object.assign(st, keep); st.acc = null; st.accN = 0; }
  else {
    learnColours(st, fin.corr, 0.05);
    st.okRun = (st.okRun || 0) + 1; if (st.okRun >= 10 && st.okRun % 10 === 0) rememberShot(st, out);
  }
  if (ok) st.refHit = st.refHit == null ? fin.hit : st.refHit + 0.05 * (fin.hit - st.refHit); // players cover and uncover lines
  st.modes[mode]++;
  return { ok, cam: out, mode, hit: fin.hit, rms, n: fin.corr.length, ms: now() - t0 };
}

// One video frame, the way the page tracks: the sparse tracker first; the full tracker (whole-frame
// line map, detect.js) when the sparse one loses the court or finds clearly fewer of its lines than
// usual (a fast pan or zoom can carry the profiles onto the wrong lines), keeping whichever camera
// finds more of the court at full resolution. Returns the result and which path produced it:
// 'static' | 'moving' | 'full'.
export function trackFrame(rgba, W, H, cam, st, opt = {}) {
  const t0 = now();
  // a camera that moves (not just pans and zooms) seen at long intervals (a slow device, a throttled
  // tab), or the first frame after a detection that took a second while the video played on, can
  // move further than profiles a few pixels long reach: the full tracker takes those
  const far = (st.mount === 'free' || !st.refined) && (opt.dt ?? 0) > (opt.maxDt ?? 0.12);
  const sp = opt.sparse === false || far ? null : sparseTrack(rgba, W, H, cam, st, opt);
  if (sp && sp.ok && (sp.mode === 'static' || sp.hit >= (opt.doubt ?? 0.85) * st.refHit)) return { ...sp, path: sp.mode, tin: st.tin, coverage: sp.hit, ms: { total: now() - t0 } };
  if (sp && !sp.ok) { const back = recallShot(rgba, W, H, st, opt); if (back) return { ...back, ms: { total: now() - t0 } }; }
  const full = trackCourt(rgba, W, H, sp && sp.ok ? sp.cam : cam, { ...opt, tin: st.tin });
  if (sp && sp.ok) {
    const h = searchLines(rgba, W, H, full.cam, samples(st), 3, { ...opt, colours: st.colours }).hit;
    if (!(full.ok && h > sp.hit)) return { ...sp, path: sp.mode, tin: st.tin, coverage: sp.hit, ms: { total: now() - t0 } };
  }
  // the full tracker's camera is the new reference; a mount already seen to move stays free
  if (full.ok) { const mount = st.mount; resetTracker(st, full.cam, full.tin); if (sp || far) st.mount = mount; if (opt.fixedMount === false) st.mount = 'free'; }
  return { ...full, path: 'full', ms: { ...full.ms, total: now() - t0 } };
}

// ---------- shots ----------
// Broadcasts cut between a few cameras on fixed mounts and back again (the main camera, a side or
// front-wall camera, replays). Every camera held for a while is remembered with what the tracker
// learnt about it; after a cut each is tried where it was, which costs a millisecond or two, and
// the one whose lines are all still there is picked up again instead of searching from scratch.
const sameShot = (a, b) => Math.hypot(a.C[0] - b.C[0], a.C[1] - b.C[1], a.C[2] - b.C[2]) < 0.5 && a.R[6] * b.R[6] + a.R[7] * b.R[7] + a.R[8] * b.R[8] > 0.99 && Math.abs(Math.log(a.f / b.f)) < 0.15;

function rememberShot(st, cam) {
  const shot = { cam, anchor: st.anchor.slice(), mount: st.mount, colours: st.colours, refHit: st.refHit, tin: st.tin };
  const i = st.shots.findIndex((s) => sameShot(s.cam, cam));
  if (i >= 0) st.shots.splice(i, 1);
  st.shots.unshift(shot); if (st.shots.length > 8) st.shots.pop();
}

export function recallShot(rgba, W, H, st, opt = {}) {
  let best = null;
  for (const sh of st.shots) {
    if (sh.cam.w !== W || sh.cam.h !== H) continue;
    if (sh.tin !== st.tin) { st.tin = sh.tin; st.S = null; }
    const sr = searchLines(rgba, W, H, sh.cam, samples(st), 6, { ...opt, colours: sh.colours });
    const q = sr.hit / Math.max(1e-9, sh.refHit);
    if (sr.corr.length >= 30 && q >= (opt.recallFrac ?? 0.75) && (!best || q > best.q)) best = { sh, q };
  }
  if (!best) return null;
  const { sh } = best;
  resetTracker(st, sh.cam, sh.tin);
  Object.assign(st, { anchor: sh.anchor.slice(), mount: sh.mount, colours: sh.colours, refHit: sh.refHit, refined: true });
  const r = sparseTrack(rgba, W, H, sh.cam, st, opt);
  return r.ok ? { ...r, path: 'recall', tin: st.tin, coverage: r.hit } : null;
}

// The ball in metres. One camera sees a ray per frame, not a point; what fixes depth is physics
// and the court: between impacts the ball flies a ballistic path with air drag, and every impact
// is on a known plane (front wall, side walls, back wall, floor) or a racket. So a 2D track is cut
// at its impacts, each flight is fitted in 3D (start point and velocity, 6 numbers) to its
// observed pixels, and the impacts are pinned to the planes they hit.
//
//   ballCandidates(prev, cur, next, ...)  2D blobs that moved (three-frame difference), sized like
//                                         a ball (with motion blur) at court depths
//   BallTracker                           links candidates into 2D tracks, cuts them at impacts
//   fitFlights(track, cam, ...)           3D flights and impacts from a cut 2D track
//   simulate(...)                         the flight model, also used to make synthetic rallies
import { W as CW, L as CL } from './court.js';

export const G = 9.81, BALL_R = 0.02;

// How far (m) a point is outside the court's box of air: the walls, the floor and a 7 m ceiling.
export const outside = (X) => Math.max(0, -X[0], X[0] - CW) + Math.max(0, -X[1], X[1] - CL) + Math.max(0, -X[2], X[2] - 7);
// drag: a = -K |v| v, K = rho Cd A / (2 m) for a 24 g, 40 mm ball (Cd ~0.5)
export const K = 1.2 * 0.5 * Math.PI * BALL_R * BALL_R / (2 * 0.024);

// Integrate one flight from X0, V0 for duration T, returning the position at the requested times.
export function flight(X0, V0, times, k = K) {
  const out = [], h = 1 / 100; // RK2: under 0.1 mm off a 1/400 s step over a 1 s flight
  let x = X0.slice(), v = V0.slice(), t = 0;
  const ts = times.map((t, i) => [t, i]).sort((a, b) => a[0] - b[0]);
  for (const [tt, i] of ts) {
    while (t < tt - 1e-9) {
      const dt = Math.min(h, tt - t), acc = (v) => { const s = Math.hypot(v[0], v[1], v[2]); return [-k * s * v[0], -k * s * v[1], -G - k * s * v[2]]; };
      // RK2 (midpoint)
      const a1 = acc(v), vm = v.map((q, j) => q + a1[j] * dt / 2), a2 = acc(vm);
      x = x.map((q, j) => q + vm[j] * dt); v = v.map((q, j) => q + a2[j] * dt); t += dt;
    }
    out[i] = { X: x.slice(), V: v.slice() };
  }
  return out;
}

// Planes the ball can hit, as [axis, value, inward normal sign]. Heights: front wall to its out
// line, side walls to theirs, back wall to 2.13.
export const PLANES = {
  front: { axis: 1, val: 0 }, back: { axis: 1, val: CL }, right: { axis: 0, val: 0 }, left: { axis: 0, val: CW }, floor: { axis: 2, val: 0 },
};

// Full simulation with bounces, for synthetic rallies: restitution e and friction mu per impact.
export function simulate(X0, V0, T, fps, { e = 0.45, eFloor = 0.5, mu = 0.25, hits = [] } = {}) {
  const step = 1 / 400, frames = [], events = [];
  let x = X0.slice(), v = V0.slice(), t = 0, nextFrame = 0;
  while (t < T) {
    if (nextFrame / fps <= t + 1e-12 && nextFrame / fps < T) { frames.push({ t: nextFrame / fps, X: x.slice(), V: v.slice() }); nextFrame++; continue; }
    // steps end exactly on frame times, so a frame's position is the state at its time
    const dt = Math.min(step, nextFrame / fps - t > 1e-12 ? nextFrame / fps - t : step);
    // racket hits: [{ t, V }] replace the velocity at time t
    for (const hh of hits) if (!hh.done && t >= hh.t) { v = hh.V.slice(); hh.done = true; events.push({ t, type: 'racket', X: x.slice() }); }
    const s = Math.hypot(...v), a = [-K * s * v[0], -K * s * v[1], -G - K * s * v[2]];
    const xn = x.map((q, j) => q + v[j] * dt + 0.5 * a[j] * dt * dt), vn = v.map((q, j) => q + a[j] * dt);
    for (const [name, P] of Object.entries(PLANES)) {
      const lo = P.val === 0, q = xn[P.axis] - (lo ? BALL_R : -BALL_R);
      if ((lo && q < P.val && vn[P.axis] < 0) || (!lo && q > P.val && vn[P.axis] > 0)) {
        xn[P.axis] = P.val + (lo ? BALL_R : -BALL_R);
        const ee = name === 'floor' ? eFloor : e;
        vn[P.axis] = -vn[P.axis] * ee;
        for (let j = 0; j < 3; j++) if (j !== P.axis) vn[j] *= 1 - mu;
        events.push({ t, type: name, X: xn.slice() });
      }
    }
    x = xn; v = vn; t += dt;
  }
  return { frames, events };
}

// Where the ball goes next: carry a state X, V (time t) forward with drag, gravity and the same
// bounce model as simulate, until the second floor bounce (the rally is over), the ball leaves the
// court (above an out line: front 4.57, sides falling to 2.13 at the back, back 2.13; or into the
// tin), or T seconds. Returns the path every 1/100 s and its impacts, with why it stopped.
export function predictPath(X, V, { t = 0, T = 1.5, e = 0.45, eFloor = 0.5, mu = 0.25, tin = 0.48 } = {}) {
  const step = 1 / 400, pts = [{ t, X: X.slice() }], hits = [];
  let x = X.slice(), v = V.slice(), s = 0, floors = 0, end = 'time';
  const outH = (p) => (p.axis === 1 ? (p.val === 0 ? 4.57 : 2.13) : 4.57 - (4.57 - 2.13) * Math.min(1, Math.max(0, x[1] / CL)));
  run: while (s < T) {
    const sp = Math.hypot(...v), a = [-K * sp * v[0], -K * sp * v[1], -G - K * sp * v[2]];
    const xn = x.map((q, j) => q + v[j] * step + 0.5 * a[j] * step * step), vn = v.map((q, j) => q + a[j] * step);
    s += step;
    for (const [name, P] of Object.entries(PLANES)) {
      const lo = P.val === 0, q = xn[P.axis] - (lo ? BALL_R : -BALL_R);
      if (!((lo && q < P.val && vn[P.axis] < 0) || (!lo && q > P.val && vn[P.axis] > 0))) continue;
      xn[P.axis] = P.val + (lo ? BALL_R : -BALL_R);
      const hit = { t: t + s, plane: name, X: xn.slice() };
      if (name !== 'floor' && xn[2] > outH(P)) { hits.push({ ...hit, out: true }); x = xn; end = 'out'; break run; }
      if (name === 'front' && xn[2] < tin) { hits.push({ ...hit, out: true }); x = xn; end = 'tin'; break run; }
      hits.push(hit);
      vn[P.axis] = -vn[P.axis] * (name === 'floor' ? eFloor : e);
      for (let j = 0; j < 3; j++) if (j !== P.axis) vn[j] *= 1 - mu;
      if (name === 'floor' && ++floors === 2) { x = xn; end = 'down'; break run; }
    }
    x = xn; v = vn;
    if (Math.round(s * 400) % 4 === 0) pts.push({ t: t + s, X: x.slice() });
  }
  pts.push({ t: t + s, X: x.slice() });
  return { pts, hits, end };
}

// ---------- 2D detection ----------

// Gray at a w-wide grid.
export function toGray(rgba, W, H, w) {
  const k = W / w, h = Math.round(H / k), g = new Float32Array(w * h), s = Math.max(1, Math.round(k));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0, n = 0;
    for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) { const o = (Math.min(H - 1, Math.floor(y * k) + j) * W + Math.min(W - 1, Math.floor(x * k) + i)) * 4; a += 0.3 * rgba[o] + 0.59 * rgba[o + 1] + 0.11 * rgba[o + 2]; n++; }
    g[y * w + x] = a / n;
  }
  return { g, w, h, k };
}

// Moving blobs in the middle frame of three (gray grids of one size): pixels that differ from both
// neighbours, so the ball's ghosts in the other two frames do not count. A blob is a candidate when
// its size fits a 40 mm ball, smeared by up to `maxSpeed` over a frame, somewhere in the court.
// players: boxes in grid pixels to ignore (a swinging racket or a moving leg is not the ball).
export function ballCandidates(A, B, C, cam, { thr = 14, players = [], fps = 50, maxSpeed = 70, isolation = 0.12 } = {}) {
  const { w, h, k } = B, n = w * h, m = new Uint8Array(n), I = new Uint32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) for (let x = 0, row = 0; x < w; x++) {
    const i = y * w + x; row += Math.abs(B.g[i] - A.g[i]) > thr || Math.abs(B.g[i] - C.g[i]) > thr || Math.abs(A.g[i] - C.g[i]) > thr ? 1 : 0;
    I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
  }
  // moving pixels (in any of the three pairs) in a box, clipped to the grid
  const boxSum = (x0, y0, x1, y1) => { x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1); return x1 <= x0 || y1 <= y0 ? [0, 0] : [I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0], (x1 - x0) * (y1 - y0)]; };
  for (let i = 0; i < n; i++) {
    const d1 = B.g[i] - A.g[i], d2 = B.g[i] - C.g[i];
    // same sign: the ball is darker (or lighter) than the background in both comparisons
    if (Math.abs(d1) > thr && Math.abs(d2) > thr && Math.sign(d1) === Math.sign(d2)) m[i] = d1 < 0 ? 1 : 2;
  }
  const inPlayer = (x, y) => players.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  const seen = new Uint8Array(n), out = [], st = [];
  // the ball's size range: nearest and farthest court points along this pixel's ray are not known
  // per blob yet, so use the court's depth range from the camera
  const dists = [[0, 0, 0], [CW, 0, 0], [0, CL, 0], [CW, CL, 0], [CW / 2, CL / 2, 1]].map((X) => Math.hypot(X[0] - cam.C[0], X[1] - cam.C[1], X[2] - cam.C[2]));
  const dMin = Math.max(1, Math.min(...dists) * 0.6), dMax = Math.max(...dists) * 1.1;
  const rMin = cam.f * BALL_R / dMax / k, rMax = cam.f * BALL_R / dMin / k, lMax = cam.f * maxSpeed / fps / dMin / k;
  for (let i = 0; i < n; i++) {
    if (!m[i] || seen[i]) continue;
    const px = []; seen[i] = 1; st.push(i);
    while (st.length && px.length < 4000) {
      const j = st.pop(); px.push(j); const x = j % w, y = (j / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const q = Y * w + X; if (m[q] === m[i] && !seen[q]) { seen[q] = 1; st.push(q); } }
    }
    // shape: centroid, principal axis, length and width
    let sx = 0, sy = 0; for (const j of px) { sx += j % w; sy += (j / w) | 0; } sx /= px.length; sy /= px.length;
    let xx = 0, yy = 0, xy = 0; for (const j of px) { const dx = (j % w) - sx, dy = ((j / w) | 0) - sy; xx += dx * dx; yy += dy * dy; xy += dx * dy; }
    xx /= px.length; yy /= px.length; xy /= px.length;
    const tr = xx + yy, det = xx * yy - xy * xy, l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)), l2 = Math.max(0, tr - l1);
    const len = 4 * Math.sqrt(l1), wid = 4 * Math.sqrt(l2);
    if (wid > 2 * rMax * 1.6 + 1.5 || len > lMax + 2 * rMax + 2 || px.length > Math.PI * rMax * (rMax + lMax) * 1.5 + 6) continue; // too big
    if (px.length < Math.max(1, Math.PI * rMin * rMin * 0.4)) continue; // too small even far away
    if (inPlayer(sx, sy)) continue;
    // isolated: a ball flies through still background, so around it only its own two ghosts move
    // (in the previous and next frames, along its path). A blob on a swinging arm, a racket or a
    // lunging leg sits in a field of motion.
    let bx0 = w, by0 = h, bx1 = 0, by1 = 0; for (const j of px) { const x = j % w, y = (j / w) | 0; bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x + 1); by0 = Math.min(by0, y); by1 = Math.max(by1, y + 1); }
    const reach = Math.ceil(Math.max(len, 2 * rMax) + 2), ring = Math.max(4, 2 * reach);
    const [inner, ia] = boxSum(bx0 - reach, by0 - reach, bx1 + reach, by1 + reach), [outer, oa] = boxSum(bx0 - reach - ring, by0 - reach - ring, bx1 + reach + ring, by1 + reach + ring);
    if (oa > ia && (outer - inner) / (oa - ia) > isolation) continue;
    let contrast = 0; for (const j of px) contrast += Math.min(Math.abs(B.g[j] - A.g[j]), Math.abs(B.g[j] - C.g[j]));
    const ang = 0.5 * Math.atan2(2 * xy, xx - yy);
    out.push({ u: (sx + 0.5) * k, v: (sy + 0.5) * k, len: len * k, wid: wid * k, ang, n: px.length, contrast: contrast / px.length, dark: m[i] === 1 });
  }
  return out;
}

// ---------- 2D tracking ----------

// Links candidates frame to frame. A track predicts its next pixel from its last two; candidates
// inside the gate continue it. When nothing is inside, the nearest candidate within a wider radius
// that is consistent with a bounce (the ball keeps its speed roughly but turns) continues it as a
// new segment: an impact. Tracks that stop for a few frames end.
export class BallTracker {
  constructor({ gate = 18, wide = 80, maxMiss = 4, impacts = true, slack = 0.25, first = 40 } = {}) { this.gate = gate; this.first = first; this.slack = slack; this.wide = wide; this.impacts = impacts; this.maxMiss = maxMiss; this.tracks = []; this.done = []; this.n = 0; }
  update(t, cands) {
    const used = new Set();
    // best existing tracks first
    for (const tr of this.tracks.sort((a, b) => b.pts.length - a.pts.length)) {
      const p = tr.pts, last = p[p.length - 1], dt = t - last.t;
      let pred = [last.u, last.v];
      if (p.length >= 2) { const q = p[p.length - 2], s = dt / (last.t - q.t); pred = [last.u + (last.u - q.u) * s, last.v + (last.v - q.v) * s]; }
      const speed = p.length >= 2 ? Math.hypot(last.u - p[p.length - 2].u, last.v - p[p.length - 2].v) / (last.t - p[p.length - 2].t) * dt : 0;
      let best = null, bd = Infinity;
      for (const c of cands) { if (used.has(c)) continue; const d = Math.hypot(c.u - pred[0], c.v - pred[1]); if (d < bd) { bd = d; best = c; } }
      const gate = p.length === 1 ? this.first * dt * 25 : this.gate + this.slack * speed; // a new track: any speed up to `first` px per 1/25 s
      if (best && bd < gate) { used.add(best); p.push({ t, u: best.u, v: best.v, c: best }); tr.miss = 0; continue; }
      // an impact: the ball turns, near where it was, at a speed of the same order
      let turn = null, td = Infinity;
      for (const c of cands) { if (used.has(c)) continue; const d = Math.hypot(c.u - last.u, c.v - last.v); if (d < Math.max(this.wide, 2.5 * speed) && d < td && d > 0.1 * speed) { td = d; turn = c; } }
      if (turn && this.impacts && p.length >= 3) { used.add(turn); tr.cuts.push(p.length); p.push({ t, u: turn.u, v: turn.v, c: turn }); tr.miss = 0; continue; }
      tr.miss++;
    }
    for (const tr of this.tracks) if (tr.miss > this.maxMiss) { if (tr.pts.length >= 5) this.done.push(tr); }
    this.tracks = this.tracks.filter((tr) => tr.miss <= this.maxMiss);
    for (const c of cands) if (!used.has(c) && this.tracks.length < 30) this.tracks.push({ id: ++this.n, pts: [{ t, u: c.u, v: c.v, c }], cuts: [], miss: 0 });
  }
  finish() { for (const tr of this.tracks) if (tr.pts.length >= 5) this.done.push(tr); this.tracks = []; return this.done.sort((a, b) => b.pts.length - a.pts.length); }
}

// Cut a 2D track at its impacts: grow each flight frame by frame while one ballistic flight (with
// drag, seen through this camera) still fits its pixels to within `tol`; where a new frame breaks
// the fit, the impact was just before it. The frame at the break can be near the impact on either
// side, so it is left out of both flights when the next flight fits better without it.
export function cutTrack(pts, cam, { tol = 2.2, minLen = 4 } = {}) {
  const segs = []; let s = 0;
  const fits = (a, b, init) => fitFlight(pts.slice(a, b + 1), cam, { init });
  while (s + minLen - 1 < pts.length) {
    let e = s + minLen - 1, f = fits(s, e);
    if (f.rms > tol) { s++; continue; } // not even a short flight: an outlier at the start
    while (e + 1 < pts.length) {
      let g = fits(s, e + 1, f.p);
      if (g.rms > tol) g = fits(s, e + 1); // the warm start can be in the wrong basin
      if (g.rms > tol) break;
      e++; f = g;
    }
    segs.push([s, e]);
    let nx = e + 1;
    if (nx + minLen < pts.length && fits(nx, nx + minLen - 1).rms > fits(nx + 1, nx + minLen).rms) nx++;
    s = nx;
  }
  // a tolerant fit swallows a frame or two past the impact: move each boundary to where the two
  // flights on either side fit best together (sum of squared residuals)
  const sse = (a, b) => { if (b - a + 1 < 3) return Infinity; const f = fits(a, b); return f.rms * f.rms * (b - a + 1); };
  for (let k = 0; k + 1 < segs.length; k++) {
    const [a] = segs[k], [, d] = segs[k + 1]; let best = null;
    for (let c = segs[k][1] - 3; c <= segs[k][1] + 1; c++) for (const gap of [1, 2]) {
      if (c - a + 1 < 3 || d - (c + gap) + 1 < 3) continue;
      const v = sse(a, c) + sse(c + gap, d) + (gap - 1) * tol * tol; // leaving a frame out costs a little
      if (!best || v < best.v) best = { v, c, gap };
    }
    if (best) { segs[k][1] = best.c; segs[k + 1][0] = best.c + best.gap; }
  }
  return segs;
}

// ---------- 3D ----------

// Fit one flight to its pixels. Unknowns: start position and velocity at pts[0].t (6 numbers), or
// only the velocity when the flight starts at a known point (`from`: { X, t }, where the previous
// flight met its plane). `end`: the plane this flight hits next, which it must cross between its
// last frame and `tNext` (the first frame after the impact).
export function fitFlight(pts, cam, { end = null, tNext = null, from = null, init = null } = {}) {
  const t0 = from ? from.t : pts[0].t, times = pts.map((p) => p.t - t0), T = times[times.length - 1] || 1 / 50;
  const ray = (p) => cam.ray(p.u, p.v);
  const onPlane = (p, name) => { const P = PLANES[name], r = ray(p), t = (P.val - r.o[P.axis]) / r.d[P.axis]; return t > 0 ? r.o.map((o, j) => o + t * r.d[j]) : null; };
  const atDepth = (p, d) => { const r = ray(p); return r.o.map((o, j) => o + d * r.d[j]); };
  const pinW = cam.f / 15, boxW = cam.f / 30;
  const tEnd = end && tNext != null ? [times[times.length - 1], (tNext - t0 + times[times.length - 1]) / 2, tNext - t0] : null;
  const unpack = (q) => (from ? [from.X, q] : [q.slice(0, 3), q.slice(3, 6)]);
  const res = (q) => {
    const [X0, V0] = unpack(q), S = flight(X0, V0, tEnd ? [...times, ...tEnd] : times), r = [];
    for (let i = 0; i < times.length; i++) { const u = cam.project(S[i].X); r.push(u[2] > 0 ? u[0] - pts[i].u : 1e3, u[2] > 0 ? u[1] - pts[i].v : 1e3, outside(S[i].X) * boxW); }
    if (tEnd) {
      // crossing the plane (ball surface touching it) somewhere in [last frame, next frame]
      const P = PLANES[end], target = P.val + (P.val === 0 ? BALL_R : -BALL_R), ds = tEnd.map((_, k) => S[times.length + k].X[P.axis] - target);
      const cross = ds.some((d, k) => k && Math.sign(d) !== Math.sign(ds[k - 1]));
      r.push(cross ? 0 : Math.min(...ds.map(Math.abs)) * pinW);
    }
    return r;
  };
  const inits = [], vel = (XA, XB) => XB.map((v, j) => (v - XA[j]) / T + (j === 2 ? 0.5 * G * T : 0));
  const dMid = Math.hypot(CW / 2 - cam.C[0], CL / 2 - cam.C[1], 1 - cam.C[2]);
  const XAs = from ? [from.X] : [0.45, 0.65, 0.85, 1.05, 1.3].map((k) => atDepth(pts[0], k * dMid));
  for (const XA of XAs) {
    const dA = Math.hypot(...XA.map((v, j) => v - cam.C[j])), XE = end ? onPlane(pts[pts.length - 1], end) : null;
    const XBs = XE ? [XE, ...[0.8, 1.25].map((k) => atDepth(pts[pts.length - 1], dA * k))] : [0.7, 1, 1.4].map((k) => atDepth(pts[pts.length - 1], dA * k));
    for (const XB of XBs) inits.push(from ? vel(XA, XB) : [...XA, ...vel(XA, XB)]);
  }
  let best = null;
  for (const q0 of init ? [init] : inits) { const f = lm(res, q0); if (!best || f.cost < best.cost) best = f; }
  const [X0, V0] = unpack(best.p), S = flight(X0, V0, times);
  const rp = pts.map((pt, i) => { const u = cam.project(S[i].X); return Math.hypot(u[0] - pt.u, u[1] - pt.v); });
  // where and when it meets its plane
  let impact = null;
  if (end && tNext != null) {
    const P = PLANES[end], target = P.val + (P.val === 0 ? BALL_R : -BALL_R), N = 12, ts = Array.from({ length: N + 1 }, (_, k) => times[times.length - 1] + (tNext - t0 - times[times.length - 1]) * k / N), Q = flight(X0, V0, ts);
    for (let k = 1; k <= N; k++) { const a = Q[k - 1].X[P.axis] - target, b2 = Q[k].X[P.axis] - target; if (Math.sign(a) !== Math.sign(b2)) { const s = a / (a - b2); impact = { t: t0 + ts[k - 1] + (ts[k] - ts[k - 1]) * s, X: Q[k - 1].X.map((v, j) => v + (Q[k].X[j] - v) * s), V: Q[k - 1].V, plane: end }; break; } }
    if (!impact) { const k = Q.reduce((bi, q, i) => (Math.abs(q.X[P.axis] - target) < Math.abs(Q[bi].X[P.axis] - target) ? i : bi), 0); impact = { t: t0 + ts[k], X: Q[k].X.slice(), V: Q[k].V, plane: end }; impact.X[P.axis] = target; }
  }
  return { p: best.p, X0, V0, t0, t1: pts[pts.length - 1].t, rms: Math.sqrt(rp.reduce((s, v) => s + v * v, 0) / rp.length), cost: best.cost, pts3: S.map((s, i) => ({ t: pts[i].t, X: s.X, V: s.V })), end, impact };
}

// Levenberg-Marquardt with forward-difference Jacobians.
function lm(res, p0, iters = 40) {
  let p = p0.slice(), r0 = res(p), cost = r0.reduce((s, v) => s + v * v, 0), lambda = 1e-3; const n = p.length;
  for (let it = 0; it < iters; it++) {
    const J = [];
    for (let j = 0; j < n; j++) { const q = p.slice(); const e = 1e-4 * Math.max(1, Math.abs(p[j])); q[j] += e; J.push(res(q).map((v, i) => (v - r0[i]) / e)); }
    const A = new Float64Array(n * n), b = new Float64Array(n);
    for (let i = 0; i < r0.length; i++) for (let a = 0; a < n; a++) { b[a] -= J[a][i] * r0[i]; for (let c = 0; c < n; c++) A[a * n + c] += J[a][i] * J[c][i]; }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const M = A.slice(); for (let a = 0; a < n; a++) M[a * n + a] = M[a * n + a] * (1 + lambda) + 1e-9;
      const dx = solveN(M, b.slice(), n); if (!dx) break;
      const q = p.map((v, j) => v + dx[j]), r1 = res(q), c1 = r1.reduce((s, v) => s + v * v, 0);
      if (c1 < cost) { const rel = (cost - c1) / cost; p = q; r0 = r1; cost = c1; lambda = Math.max(1e-7, lambda / 4); improved = rel > 1e-7; break; }
      lambda *= 5;
    }
    if (!improved) break;
  }
  return { p, cost };
}

function solveN(A, b, n) {
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r * n + i]) > Math.abs(A[p * n + i])) p = r;
    if (Math.abs(A[p * n + i]) < 1e-12) return null;
    for (let c = 0; c < n; c++) { const t = A[i * n + c]; A[i * n + c] = A[p * n + c]; A[p * n + c] = t; } { const t = b[i]; b[i] = b[p]; b[p] = t; }
    for (let r = i + 1; r < n; r++) { const f = A[r * n + i] / A[i * n + i]; for (let c = i; c < n; c++) A[r * n + c] -= f * A[i * n + c]; b[r] -= f * b[i]; }
  }
  const x = new Array(n); for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i * n + c] * x[c]; x[i] = s / A[i * n + i]; }
  return x;
}

// Whether a 3D point is a legal place for an impact on a plane (inside the wall, below its out line).
const legal = (name, X) => {
  const m = 0.25;
  if (name === 'floor') return X[0] > -m && X[0] < CW + m && X[1] > -m && X[1] < CL + m;
  if (name === 'front') return X[0] > -m && X[0] < CW + m && X[2] > -m && X[2] < 4.57 + 0.6;
  if (name === 'back') return X[0] > -m && X[0] < CW + m && X[2] > -m && X[2] < 2.13 + 0.6;
  return X[1] > -m && X[1] < CL + m && X[2] > -m && X[2] < 4.57 + 0.6; // side walls
};

// Fit a whole cut track at once for a given labelling of its impacts. Unknowns: the first flight's
// start and velocity, then per later flight its velocity (after a wall or floor impact it starts
// where and when the previous flight met that plane) or its start and velocity (after a racket).
// Residuals: every frame's reprojection, plus each wall impact having to happen between the last
// frame before it and the first after.
export function fitChain(pts, segs, labels, cam, init = null) {
  const fl = segs.map(([a, b]) => pts.slice(a, b + 1));
  const pinW = cam.f / 15, boxW = cam.f / 30;
  const layout = []; let n = 0;
  for (let s = 0; s < segs.length; s++) { const free = s === 0 || labels[s - 1] === 'racket'; layout.push({ off: n, free }); n += free ? 6 : 3; }
  const run = (q) => {
    const out = []; let r = [];
    for (let s = 0; s < fl.length; s++) {
      const P = fl[s], L = layout[s];
      let X0, t0;
      if (L.free) { X0 = q.slice(L.off, L.off + 3); t0 = P[0].t; } else { X0 = out[s - 1].impact.X; t0 = out[s - 1].impact.t; }
      const V0 = q.slice(L.off + (L.free ? 3 : 0), L.off + (L.free ? 6 : 3));
      const times = P.map((p) => p.t - t0), plane = s + 1 < fl.length && labels[s] !== 'racket' ? labels[s] : null;
      const tN = s + 1 < fl.length ? fl[s + 1][0].t - t0 : null, last = times[times.length - 1];
      const N = 8, te = plane ? Array.from({ length: N + 1 }, (_, k) => last + (tN - last) * k / N) : [];
      const S = flight(X0, V0, [...times, ...te]);
      for (let i = 0; i < times.length; i++) { const u = cam.project(S[i].X); r.push(u[2] > 0 ? u[0] - P[i].u : 1e3, u[2] > 0 ? u[1] - P[i].v : 1e3, outside(S[i].X) * boxW); }
      let impact = null;
      if (plane) {
        const Pl = PLANES[plane], target = Pl.val + (Pl.val === 0 ? BALL_R : -BALL_R), Q = S.slice(times.length);
        for (let k = 1; k <= N && !impact; k++) { const a = Q[k - 1].X[Pl.axis] - target, b2 = Q[k].X[Pl.axis] - target; if (Math.sign(a) !== Math.sign(b2)) { const f = a / (a - b2); impact = { t: t0 + te[k - 1] + (te[k] - te[k - 1]) * f, X: Q[k - 1].X.map((v, j) => v + (Q[k].X[j] - v) * f), plane }; } }
        if (impact) r.push(0);
        else { let bi = 0; Q.forEach((qq, k) => { if (Math.abs(qq.X[Pl.axis] - target) < Math.abs(Q[bi].X[Pl.axis] - target)) bi = k; }); r.push((Q[bi].X[Pl.axis] - target) * pinW); impact = { t: t0 + te[bi], X: Q[bi].X.slice(), plane, missed: true }; impact.X[Pl.axis] = target; }
      }
      out.push({ X0, V0, t0, pts3: S.slice(0, times.length).map((s2, i) => ({ t: P[i].t, X: s2.X, V: s2.V })), impact, end: plane });
    }
    return { out, r };
  };
  const res = (q) => run(q).r;
  // starting points: the previous fit (extended), or depth guesses for the first flight
  const starts = [];
  if (init) starts.push(init);
  else {
    const dMid = Math.hypot(CW / 2 - cam.C[0], CL / 2 - cam.C[1], 1 - cam.C[2]);
    for (const k of [0.5, 0.7, 0.9, 1.1, 1.35]) {
      const q = new Array(n).fill(0);
      for (let s = 0; s < fl.length; s++) {
        const P = fl[s], L = layout[s], T = (P[P.length - 1].t - P[0].t) || 0.02, ra = cam.ray(P[0].u, P[0].v), rb = cam.ray(P[P.length - 1].u, P[P.length - 1].v);
        const XA = ra.o.map((o, j) => o + k * dMid * ra.d[j]), XB = rb.o.map((o, j) => o + k * dMid * rb.d[j]), V = XB.map((v, j) => (v - XA[j]) / T + (j === 2 ? 0.5 * G * T : 0));
        if (L.free) { q.splice(L.off, 6, ...XA, ...V); } else q.splice(L.off, 3, ...V);
      }
      starts.push(q);
    }
  }
  let best = null;
  for (const q0 of starts) { const f = lm(res, q0, 60); if (!best || f.cost < best.cost) best = f; }
  const { out } = run(best.p);
  const nPts = fl.reduce((s, P) => s + P.length, 0);
  return { flights: out, p: best.p, cost: best.cost, rms: Math.sqrt(best.cost / (2 * nPts)), layout };
}

// Label the impacts of a cut track. A beam over label sequences, refitting the whole chain for each
// extension (warm-started from its parent), keeps the few best; a racket label must be near a
// player and between knee and above head; every wall or floor impact must land legally on its
// plane. Returns { flights, labels, impacts, cost }.
export function fitFlights(pts, segs, cam, { players = null, beam = 4 } = {}) {
  const labels = ['front', 'floor', 'right', 'left', 'back', 'racket'];
  const rk = (X) => { let p = X[2] < 0.1 || X[2] > 2.8 ? 60 : 0; if (players && players.length) { const d = Math.min(...players.map((q) => Math.hypot(q[0] - X[0], q[1] - X[1]))); p += Math.max(0, d - 1.4) * 40; } return p; };
  const judge = (fit, labs) => {
    let pen = 0;
    fit.flights.forEach((f, s) => {
      for (const q of f.pts3) { const X = q.X; if (X[2] < -0.1 || X[1] < -0.15 || X[0] < -0.2 || X[0] > CW + 0.2 || X[2] > 6.5) pen += 30; }
      if (f.impact && !legal(f.impact.plane, f.impact.X)) pen += 200;
      if (f.impact && f.impact.missed) pen += 50;
      const sp = Math.hypot(...f.V0); if (sp > 75) pen += (sp - 75) * 10;
      if (labs[s] === 'racket') pen += 25 + rk(f.pts3[f.pts3.length - 1].X);
    });
    return fit.cost + pen;
  };
  const one = fitChain(pts, segs.slice(0, 1), [], cam);
  let beamSet = [{ labs: [], fit: one, c: judge(one, []) }];
  for (let s = 1; s < segs.length; s++) {
    const cand = [];
    for (const B of beamSet) for (const l of labels) {
      const labs = [...B.labs, l], layoutPrev = B.fit.layout, init = B.fit.p.slice();
      // warm start: the new flight's velocity from its own pixels at the previous flight's depth
      const P = pts.slice(segs[s][0], segs[s][1] + 1), prev = B.fit.flights[B.fit.flights.length - 1], dep = Math.hypot(...prev.pts3[prev.pts3.length - 1].X.map((v, j) => v - cam.C[j]));
      const T = (P[P.length - 1].t - P[0].t) || 0.02, ra = cam.ray(P[0].u, P[0].v), rb = cam.ray(P[P.length - 1].u, P[P.length - 1].v);
      const XA = ra.o.map((o, j) => o + dep * ra.d[j]), XB = rb.o.map((o, j) => o + dep * rb.d[j]), V = XB.map((v, j) => (v - XA[j]) / T + (j === 2 ? 0.5 * G * T : 0));
      const fit = fitChain(pts, segs.slice(0, s + 1), labs, cam, l === 'racket' ? [...init, ...XA, ...V] : [...init, ...V]);
      void layoutPrev;
      cand.push({ labs, fit, c: judge(fit, labs) });
    }
    cand.sort((a, b) => a.c - b.c);
    beamSet = cand.slice(0, beam);
  }
  const win = beamSet[0];
  return { flights: win.fit.flights, labels: win.labs, cost: win.c, rms: win.fit.rms, impacts: win.fit.flights.map((f) => f.impact).filter(Boolean) };
}

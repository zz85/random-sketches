// Where the ball lands: floor bounces and front-wall hits gathered from fitted flights, kept for the
// whole clip, and binned into a heatmap.
//
// A bounce is a labelled impact inside a track, or the end of a flight that comes down onto the
// floor: the ball tracker does not join tracks across an impact, so most floor bounces end a track.
// The flight list the ball worker sends is a window that can also replace a flight with a better
// rival, so the bounces in the time span it covers are rebuilt from it each time.
import { W as CW, L as CL } from './court.js';
import { G, K } from './ball.js';

// Carry a ball state X, V by dt seconds (negative: back in time) with gravity and drag.
export function extrapolate(X, V, dt) {
  const n = Math.max(1, Math.ceil(Math.abs(dt) / 0.005)), h = dt / n; let x = X.slice(), v = V.slice();
  const acc = (v) => { const s = Math.hypot(v[0], v[1], v[2]); return [-K * s * v[0], -K * s * v[1], -G - K * s * v[2]]; };
  for (let i = 0; i < n; i++) { const a1 = acc(v), vm = v.map((q, j) => q + a1[j] * h / 2), a2 = acc(vm); x = x.map((q, j) => q + vm[j] * h); v = v.map((q, j) => q + a2[j] * h); }
  return { X: x, V: v };
}

// Impacts heard but not seen: an onset (in video time) with no fitted impact near it, where a
// flight that ended just before (carried forward) or starts just after (carried back) reaches a
// court surface. A point near a player at racket height is a racket hit, kept for the hitter.
export function soundImpacts(onsetTimes, flights, players = () => null, { near = 0.04, reach = 0.35, tol = 0.3 } = {}) {
  const fitted = flights.flatMap((f) => impactsOf(f).map((m) => m.t)), out = [];
  for (const t of onsetTimes) {
    if (fitted.some((u) => Math.abs(u - t) < near)) continue;
    let best = null;
    for (const f of flights) {
      const a = f.pts[0], z = f.pts[f.pts.length - 1];
      if (!a.V || !z.V) continue;
      let s = null;
      if (t > z.t && t - z.t < reach) s = extrapolate(z.X, z.V, t - z.t);
      else if (t < a.t && a.t - t < reach) s = extrapolate(a.X, a.V, t - a.t);
      if (s && (!best || Math.abs(s.dt) < Math.abs(best.dt))) best = { ...s, dt: t > z.t ? t - z.t : a.t - t };
    }
    if (!best) continue;
    const X = best.X, d = { floor: Math.abs(X[2]), front: Math.abs(X[1]), back: Math.abs(X[1] - CL), right: Math.abs(X[0]), left: Math.abs(X[0] - CW) };
    const plane = Object.keys(d).sort((p, q) => d[p] - d[q])[0];
    const pl = players(t, X);
    if (pl && pl.dist < 1.2 && X[2] > 0.15 && X[2] < 2.6 && d[plane] > 0.15) { out.push({ t, X, plane: 'racket', inferred: true, sound: true, player: pl.id }); continue; }
    if (d[plane] > tol || X[0] < -tol || X[0] > CW + tol || X[1] < -tol || X[1] > CL + tol || X[2] < -tol) continue;
    const Y = X.slice(); if (plane === 'floor') Y[2] = 0; else if (plane === 'front') Y[1] = 0; else if (plane === 'back') Y[1] = CL; else if (plane === 'right') Y[0] = 0; else Y[0] = CW;
    out.push({ t, X: Y, plane, inferred: true, sound: true });
  }
  return out;
}

// Who hit the shot that made impact m: the last flight before it heading for the front wall
// started off a racket; carry it back to its racket sound if one was heard just before (else 40 ms)
// and take the player nearest that point, if clearly nearer than the other.
export function hitterOf(m, flights, players, racketTimes = []) {
  let f = null;
  for (const g of flights) if (g.t0 <= m.t + 1e-6 && m.t - g.t0 < 2.5 && g.pts[0].V && g.pts[0].V[1] < -2 && (!f || g.t0 > f.t0)) f = g;
  if (!f) return null;
  const a = f.pts[0], hit = racketTimes.filter((t) => t <= a.t && a.t - t < 0.3).pop(), dt = hit != null ? hit - a.t : -0.04;
  const X = extrapolate(a.X, a.V, dt).X, p = players(a.t + dt, X, true);
  return p && p.dist < 2.5 && (p.other == null || p.dist < 0.7 * p.other) ? p.id : null;
}

// One flight's impacts: [{ t, X, plane, inferred }]
export function impactsOf(f) {
  const out = f.impacts.map((m) => ({ t: m.t, X: m.X, plane: m.plane, inferred: false }));
  const last = f.pts[f.pts.length - 1];
  if (last && last.X[2] < 0.12 && (!last.V || last.V[2] < 0) && !out.some((m) => m.plane === 'floor' && Math.abs(m.t - last.t) < 0.1)) out.push({ t: last.t, X: [last.X[0], last.X[1], 0], plane: 'floor', inferred: true });
  return out;
}

export class Bounces {
  constructor() { this.list = []; } // sorted by t
  // flights: the worker's current window (sorted by t0). onsets: heard impact times in video time.
  // players(t, X, both?) -> { id, dist, other } nearest player then, or null.
  update(flights, { onsets = null, players = () => null } = {}) {
    if (!flights.length) return;
    const t0 = flights[0].t0 - 0.05, t1 = Math.max(...flights.map((f) => f.t1)) + 0.4;
    this.list = this.list.filter((b) => b.t < t0 || b.t > t1);
    const add = flights.flatMap((f) => impactsOf(f)).filter(inside);
    const heard = onsets ? soundImpacts(onsets.filter((t) => t >= t0 && t <= t1), flights, players) : [];
    const rackets = heard.filter((m) => m.plane === 'racket').map((m) => m.t);
    for (const m of [...add, ...heard.filter((m) => m.plane !== 'racket')]) { m.player = hitterOf(m, flights, players, onsets ? onsets.filter((t) => t >= t0 - 0.3 && t <= t1) : rackets); this.list.push(m); }
    this.list.sort((a, b) => a.t - b.t);
  }
  clear() { this.list = []; }
  on(plane) { return this.list.filter((b) => b.plane === plane); }
}
const inside = (m) => (m.plane === 'floor' ? m.X[0] >= -0.05 && m.X[0] <= CW + 0.05 && m.X[1] >= -0.05 && m.X[1] <= CL + 0.05 : m.plane === 'front' ? m.X[0] >= -0.05 && m.X[0] <= CW + 0.05 && m.X[2] >= 0 && m.X[2] <= 5.6 : true);

// Count points per cell of an nx x ny grid over [0, w] x [0, h] (cells of `cell` m), then a
// Gaussian-ish 3x3 blur twice (one bounce spreads over ~0.5 m: the fit is not finer than that).
export function heatGrid(points, cell, w, h) {
  const nx = Math.ceil(w / cell), ny = Math.ceil(h / cell);
  let g = new Float32Array(nx * ny);
  for (const [x, y] of points) { const i = Math.floor(x / cell), j = Math.floor(y / cell); if (i >= 0 && j >= 0 && i < nx && j < ny) g[j * nx + i] += 1; }
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(nx * ny);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      let v = 0, s = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const X = x + i, Y = y + j; if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue; const k = (i ? 0.5 : 1) * (j ? 0.5 : 1); v += g[Y * nx + X] * k; s += k; }
      o[y * nx + x] = v / s;
    }
    g = o;
  }
  return { g, nx, ny, cell };
}

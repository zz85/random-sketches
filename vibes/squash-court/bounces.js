// Where the ball lands: floor bounces and front-wall hits gathered from fitted flights, kept for the
// whole clip, and binned into a heatmap.
//
// A bounce is a labelled impact inside a track, or the end of a flight that comes down onto the
// floor: the ball tracker does not join tracks across an impact, so most floor bounces end a track.
// The flight list the ball worker sends is a window that can also replace a flight with a better
// rival, so the bounces in the time span it covers are rebuilt from it each time.
import { W as CW, L as CL } from './court.js';

// One flight's impacts: [{ t, X, plane, inferred }]
export function impactsOf(f) {
  const out = f.impacts.map((m) => ({ t: m.t, X: m.X, plane: m.plane, inferred: false }));
  const last = f.pts[f.pts.length - 1];
  if (last && last.X[2] < 0.12 && (!last.V || last.V[2] < 0) && !out.some((m) => m.plane === 'floor' && Math.abs(m.t - last.t) < 0.1)) out.push({ t: last.t, X: [last.X[0], last.X[1], 0], plane: 'floor', inferred: true });
  return out;
}

export class Bounces {
  constructor() { this.list = []; } // sorted by t
  // flights: the worker's current window (sorted by t0)
  update(flights) {
    if (!flights.length) return;
    const t0 = flights[0].t0 - 0.05, t1 = Math.max(...flights.map((f) => f.t1)) + 0.2;
    this.list = this.list.filter((b) => b.t < t0 || b.t > t1);
    for (const f of flights) for (const m of impactsOf(f)) if (inside(m)) this.list.push(m);
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

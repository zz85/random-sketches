/*
 * brush.js - turning pointer samples into evenly spaced brush stamps.
 *
 * Pointer events arrive unevenly (60-240 Hz, coalesced), so the stroke is resampled at a
 * fixed spacing in sheet pixels; pressure, tilt and speed are interpolated along it. A light
 * speed-adaptive smoother (stronger when slow, where hand tremor shows) takes the jitter out
 * without the lag a fixed-strength smoother has on fast flicks.
 */

/** Stamps every `spacing` along a->b, starting `spacing - rest` from a. Returns {stamps, rest}. */
export function strokeStamps(a, b, spacing, rest) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy), stamps = [];
  let d = spacing - rest;
  if (len === 0) return { stamps, rest };
  for (; d <= len + 1e-9; d += spacing) {
    const t = d / len, s = {};
    for (const k in b) s[k] = typeof b[k] === 'number' && typeof a[k] === 'number' ? a[k] + (b[k] - a[k]) * t : b[k];
    s.x = a.x + dx * t; s.y = a.y + dy * t; s.dx = dx / len; s.dy = dy / len;
    stamps.push(s);
  }
  return { stamps, rest: len - (d - spacing) };
}

export class Smoother {
  constructor(strength = 0.5) { this.k = strength; this.p = null; this.raw = null; }
  push(q) {
    this.raw = q;
    if (!this.p) return (this.p = { ...q });
    const dt = Math.max(1, (q.t ?? 0) - (this.p.t ?? 0) || 8), v = Math.hypot(q.x - this.p.x, q.y - this.p.y) / dt; // px/ms
    const a = Math.min(1, (1 - this.k * 0.85) + v * 0.15);
    const p = { ...q }; for (const k of ['x', 'y']) p[k] = this.p[k] + (q[k] - this.p[k]) * a;
    return (this.p = p);
  }
  /** Points easing from the smoothed position onto the last raw sample, so the stroke ends where the pen lifted. */
  finish() {
    if (!this.p || !this.raw) return [];
    const out = []; const a = this.p, b = this.raw;
    for (let i = 1; i <= 4; i++) { const t = i / 4; out.push({ ...b, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
    this.p = null; return out;
  }
}

/**
 * Brush library. Sizes are radii in sheet pixels at full pressure. `mode`: 0 paint, 1 clear
 * water, 2 lift; smudge and erase are tools that borrow a paint brush's shape.
 * `angle` (degrees) holds a flat brush's chisel at a fixed angle to the page.
 */
export const BRUSHES = {
  round: { name: 'Round', cat: 'Watercolour', size: 22, water: 0.65, paint: 0.55, shape: 0, spacing: 0.18, sizePressure: 0.75, paintPressure: 0.4, note: 'pointed round: pressure makes it fat' },
  wash: { name: 'Wash', cat: 'Watercolour', size: 70, water: 0.9, paint: 0.35, shape: 1, spacing: 0.15, sizePressure: 0.25, paintPressure: 0.2, note: 'big soft mop for skies and washes' },
  flat: { name: 'Flat', cat: 'Watercolour', size: 26, water: 0.7, paint: 0.5, shape: 1, spacing: 0.12, sizePressure: 0.3, paintPressure: 0.3, angle: 45, flat: 2.6, note: 'chisel edge: thin one way, broad the other' },
  detail: { name: 'Rigger', cat: 'Watercolour', size: 6, water: 0.45, paint: 0.7, shape: 0, spacing: 0.2, sizePressure: 0.8, paintPressure: 0.5, note: 'long thin hairs for lines and twigs' },
  dry: { name: 'Dry brush', cat: 'Watercolour', size: 26, water: 0.15, paint: 0.8, shape: 2, spacing: 0.15, sizePressure: 0.5, paintPressure: 0.4, note: 'little water: only the paper tooth takes paint' },
  water: { name: 'Clear water', cat: 'Water', mode: 1, size: 30, water: 0.8, paint: 0, shape: 0, spacing: 0.18, sizePressure: 0.5, paintPressure: 0, note: 'wet the paper first, soften edges, make blooms' },
  lift: { name: 'Lift', cat: 'Water', mode: 2, size: 24, water: 0.3, paint: 0.8, shape: 0, spacing: 0.18, sizePressure: 0.5, paintPressure: 0, note: 'blot paint back off with a damp brush' },
  splatter: { name: 'Splatter', cat: 'Effects', size: 40, water: 0.7, paint: 0.6, shape: 3, spacing: 0.6, sizePressure: 0.5, paintPressure: 0.3, note: 'flick drops off the brush' },
};
export const CATEGORIES = ['Watercolour', 'Water', 'Effects'];
/** Brushes smudge and erase can borrow a shape from. */
export const SHAPES = ['round', 'wash', 'flat', 'detail', 'dry'];

/** Random droplets for a splatter stamp, deterministic in `seed`. */
export function splatterDrops(s, radius, seed) {
  let r = (seed * 2654435761) >>> 0; const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  const n = 2 + Math.floor(rnd() * 4), out = [];
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), 0.6) * radius * 1.6;
    out.push({ ...s, x: s.x + Math.cos(a) * d + (s.dx || 0) * d * 0.6, y: s.y + Math.sin(a) * d + (s.dy || 0) * d * 0.6, r: radius * (0.04 + 0.16 * Math.pow(rnd(), 2.5)) });
  }
  return out;
}

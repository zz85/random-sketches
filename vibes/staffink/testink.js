// Synthetic handwriting for tests and the headless smoke run. Coordinates in staff
// spaces, y down. Shapes are drawn the way people write them (HOMUS-style): a
// scribbled filled head, an oval for an open head, the stem as its own stroke, etc.
// `wob` adds deterministic hand tremor so shapes are not machine-perfect.

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
export function reseed(s) { seed = s >>> 0; }
const wob = (pts, a = 0.03) => pts.map((p) => ({ x: p.x + (rnd() - 0.5) * a, y: p.y + (rnd() - 0.5) * a }));

export const yOf = (top, pos) => top + 4 - pos / 2;
const line = (x0, y0, x1, y1, n = 12) => wob(Array.from({ length: n }, (_, i) => ({ x: x0 + (x1 - x0) * i / (n - 1), y: y0 + (y1 - y0) * i / (n - 1) })));

export function filledHead(cx, cy, w = 1.2, h = 0.9) {
  // tight spiral scribble, tilted like a written notehead
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    const t = i / 60, a = t * Math.PI * 2 * 3.2, r = 0.15 + 0.85 * (1 - Math.abs(1 - 2 * ((t * 3.2) % 1)) * 0.35) * Math.min(1, t * 3 + 0.3);
    const x = Math.cos(a) * r * w / 2, y = Math.sin(a) * r * h / 2;
    pts.push({ x: cx + x * 0.94 + y * 0.25, y: cy + y * 0.94 - x * 0.12 });
  }
  return wob(pts, 0.04);
}
export function hollowHead(cx, cy, w = 1.35, h = 0.95) {
  const pts = [];
  for (let i = 0; i <= 28; i++) {
    const a = Math.PI * 0.9 + i / 28 * Math.PI * 2.1;
    const x = Math.cos(a) * w / 2, y = Math.sin(a) * h / 2;
    pts.push({ x: cx + x * 0.95 + y * 0.2, y: cy + y * 0.95 - x * 0.2 });
  }
  return wob(pts, 0.03);
}
/** Quarter/half/eighth... with stem. dir 'up' puts the head at the bottom-left. */
export function note(top, x, pos, { filled = true, dir, flags = 0 } = {}) {
  const y = yOf(top, pos);
  const up = dir ? dir === 'up' : pos < 4;
  const strokes = [filled ? filledHead(x, y) : hollowHead(x, y)];
  const sx = up ? x + 0.55 : x - 0.55, sy0 = up ? y - 0.15 : y + 0.15, sy1 = up ? y - 3.4 : y + 3.4;
  strokes.push(line(sx, sy0, sx, sy1, 14));
  for (let f = 0; f < flags; f++) {
    const fy = sy1 + (up ? 0.8 : -0.8) * f;
    const pts = [];
    for (let i = 0; i <= 12; i++) { const t = i / 12; pts.push({ x: sx + 0.9 * Math.sin(t * Math.PI * 0.6) + 0.1 * t, y: fy + (up ? 1 : -1) * (1.9 * t) }); }
    strokes.push(wob(pts));
  }
  return strokes;
}
export function wholeNote(top, x, pos) { return [hollowHead(x, yOf(top, pos), 1.6, 1.05)]; }
export function sharp(top, x, pos) {
  const y = yOf(top, pos);
  return [line(x - 0.25, y - 1.3, x - 0.3, y + 1.4), line(x + 0.35, y - 1.45, x + 0.3, y + 1.3), line(x - 0.75, y - 0.25, x + 0.8, y - 0.55), line(x - 0.8, y + 0.55, x + 0.75, y + 0.25)];
}
export function flat(top, x, pos) {
  const y = yOf(top, pos);
  const pts = [...line(x, y - 2.3, x, y + 0.55, 14)];
  for (let i = 1; i <= 14; i++) { const t = i / 14, a = Math.PI + t * Math.PI * 1.15; pts.push({ x: x + 0.45 + Math.cos(a) * 0.45 * -1 * (t < 0.5 ? 1 : 1), y: y - 0.05 + Math.sin(a) * 0.5 * -1 }); }
  return [wob(pts)];
}
export function natural(top, x, pos) {
  const y = yOf(top, pos);
  return [[...line(x - 0.3, y - 1.5, x - 0.3, y + 0.5, 10), ...line(x - 0.3, y + 0.5, x + 0.4, y + 0.25, 5)], [...line(x - 0.3, y - 0.3, x + 0.4, y - 0.55, 5), ...line(x + 0.4, y - 0.55, x + 0.4, y + 1.5, 10)]];
}
export function quarterRest(top, x) {
  const y = yOf(top, 4);
  return [wob([{ x: x - 0.3, y: y - 1.5 }, { x: x + 0.35, y: y - 0.7 }, { x: x - 0.35, y: y + 0.0 }, { x: x + 0.3, y: y + 0.6 }, { x: x - 0.25, y: y + 0.55 }, { x: x - 0.4, y: y + 0.9 }, { x: x - 0.05, y: y + 1.45 }].flatMap((p, i, a) => i ? Array.from({ length: 5 }, (_, k) => ({ x: a[i - 1].x + (p.x - a[i - 1].x) * (k + 1) / 5, y: a[i - 1].y + (p.y - a[i - 1].y) * (k + 1) / 5 })) : [p]))];
}
export function blockRest(top, x, pos) {
  // filled rectangle: whole rest hangs from line 4 (pos 5-6), half rest sits on line 3 (pos 4-5)
  const yt = yOf(top, pos + 1), yb = yOf(top, pos);
  const pts = [];
  for (let i = 0; i <= 8; i++) { const yy = yt + (yb - yt) * (i / 8); pts.push({ x: i % 2 ? x + 1.0 : x - 1.0, y: yy }); }
  const dense = []; for (let i = 1; i < pts.length; i++) for (let k = 0; k < 6; k++) dense.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k / 6, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k / 6 });
  return [wob(dense)];
}
export function dot(x, y) { return [wob([{ x, y }, { x: x + 0.08, y: y + 0.05 }, { x: x + 0.12, y: y - 0.02 }, { x: x + 0.05, y: y + 0.08 }], 0.02)]; }
export function scribble(x0, y0, x1, y1, n = 6) {
  const pts = []; for (let i = 0; i <= n; i++) { pts.push({ x: i % 2 ? x1 : x0, y: y0 + (y1 - y0) * i / n }); }
  const dense = []; for (let i = 1; i < pts.length; i++) for (let k = 0; k < 8; k++) dense.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k / 8, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k / 8 });
  return [wob(dense, 0.05)];
}
export function straight(x0, y0, x1, y1) { return [line(x0, y0, x1, y1, 16)]; }
export function arc(x0, y0, x1, y1, sag) {
  const pts = []; for (let i = 0; i <= 16; i++) { const t = i / 16; pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t + sag * Math.sin(Math.PI * t) }); }
  return [wob(pts, 0.02)];
}
export function trebleClef(top, x) {
  // spiral around the G line, up through the top, down the spine, hook at the bottom
  const g = yOf(top, 2), pts = [];
  for (let i = 0; i <= 26; i++) { const a = -Math.PI / 2 + i / 26 * Math.PI * 1.9, r = 0.35 + i / 26 * 0.75; pts.push({ x: x + Math.cos(a) * r, y: g + Math.sin(a) * r * 1.1 }); }
  const last = pts[pts.length - 1];
  for (let i = 1; i <= 16; i++) { const t = i / 16; pts.push({ x: last.x + (x + 0.5 - last.x) * t + 0.5 * Math.sin(t * Math.PI), y: last.y + (top - 1.8 - last.y) * t }); }
  for (let i = 1; i <= 12; i++) { const t = i / 12; pts.push({ x: x + 0.5 - 0.9 * Math.sin(t * Math.PI * 0.6), y: top - 1.8 + t * 1.2 }); }
  const s = pts[pts.length - 1];
  for (let i = 1; i <= 18; i++) { const t = i / 18; pts.push({ x: s.x + (x + 0.15 - s.x) * t, y: s.y + (top + 6.3 - s.y) * t }); }
  for (let i = 1; i <= 8; i++) { const a = i / 8 * Math.PI; pts.push({ x: x - 0.3 + Math.cos(a) * 0.45, y: top + 6.3 - Math.sin(a) * 0.35 }); }
  return [wob(pts, 0.04)];
}

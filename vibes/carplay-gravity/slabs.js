// Slabs: how a dashboard panel breaks. A panel is a rounded rectangle, kept as a convex polygon;
// every cut is a straight line across one piece, so every piece stays convex (what the physics
// takes). mosaic() makes a panel's own irregular, slanted break lines; cutAlong() splits pieces
// along a crack, one straight cut per piece from where the crack enters it to where it leaves, so
// a piece's edges follow the crack as it wanders.
// Points are [x, y]; polygons are arrays of points.

export const area = (P) => { let a = 0; for (let i = 0; i < P.length; i++) { const [ax, ay] = P[i], [bx, by] = P[(i + 1) % P.length]; a += ax * by - bx * ay; } return a / 2; };
const perimeter = (P) => P.reduce((s, p, i) => s + Math.hypot(P[(i + 1) % P.length][0] - p[0], P[(i + 1) % P.length][1] - p[1]), 0);
export function centroid(P) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < P.length; i++) {
    const [ax, ay] = P[i], [bx, by] = P[(i + 1) % P.length], c = ax * by - bx * ay;
    a += c; cx += (ax + bx) * c; cy += (ay + by) * c;
  }
  return a ? [cx / (3 * a), cy / (3 * a)] : P[0];
}
export function bbox(P) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of P) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}
// a rounded rectangle as a polygon, a few points on each corner
export function roundRect(x, y, w, h, r, seg = 5) {
  const out = [], C = [[x + w - r, y + r, -Math.PI / 2], [x + w - r, y + h - r, 0], [x + r, y + h - r, Math.PI / 2], [x + r, y + r, Math.PI]];
  for (const [cx, cy, a0] of C) for (let k = 0; k <= seg; k++) { const a = a0 + (Math.PI / 2) * k / seg; out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); }
  return out;
}
// big and thick enough to be a slab of its own
export const solid = (P, min = 700) => Math.abs(area(P)) >= min && Math.abs(area(P)) / perimeter(P) >= 6;

// split a convex polygon by the line through p along d: the two sides, or null if it misses
export function cut(P, p, d) {
  const side = (q) => (q[0] - p[0]) * d[1] - (q[1] - p[1]) * d[0], L = [], R = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], sa = side(a), sb = side(b);
    if (sa <= 0) L.push(a); if (sa >= 0) R.push(a);
    if ((sa < 0 && sb > 0) || (sa > 0 && sb < 0)) { const t = sa / (sa - sb), q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; L.push(q); R.push(q); }
  }
  return L.length >= 3 && R.length >= 3 && Math.abs(area(L)) > 1 && Math.abs(area(R)) > 1 ? [L, R] : null;
}

// A panel's own break lines: the biggest piece is cut again and again near its middle, across its
// longer side and 10 to 35 degrees off square, so the pieces come out slanted and uneven.
export function mosaic(P, n, rnd) {
  let out = [P];
  for (let guard = 0; out.length < n && guard < n * 6; guard++) {
    out.sort((a, b) => Math.abs(area(b)) - Math.abs(area(a)));
    const Q = out[0], b = bbox(Q), [cx, cy] = centroid(Q);
    const across = b.w > b.h ? Math.PI / 2 : 0, a = across + (rnd() < 0.5 ? -1 : 1) * (0.17 + rnd() * 0.44);
    const p = [cx + (rnd() - 0.5) * b.w * 0.3, cy + (rnd() - 0.5) * b.h * 0.3], two = cut(Q, p, [Math.cos(a), Math.sin(a)]);
    if (two && two.every((q) => solid(q, 2500))) out = [...two, ...out.slice(1)];
  }
  return out;
}

const inside = (P, q, eps = 0) => { for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; if ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]) < -eps * Math.hypot(b[0] - a[0], b[1] - a[1])) return false; } return true; };
// inside a convex polygon of either winding
export function contains(P, q, eps = 0) { return area(P) >= 0 ? inside(P, q, eps) : inside(P.slice().reverse(), q, eps); }

// where a crack, a polyline, enters a convex piece and where it next leaves it
function span(P, line) {
  const hits = [];
  for (let k = 0; k + 1 < line.length; k++) {
    const p = line[k], q = line[k + 1], dx = q[0] - p[0], dy = q[1] - p[1];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length], ex = b[0] - a[0], ey = b[1] - a[1], den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den, u = ((a[0] - p[0]) * dy - (a[1] - p[1]) * dx) / den;
      if (t >= 0 && t < 1 && u >= 0 && u <= 1) hits.push([k + t, [p[0] + dx * t, p[1] + dy * t]]);
    }
  }
  hits.sort((a, b) => a[0] - b[0]);
  // a crack that starts on the piece's edge (a fork off a crack already cut) enters there
  const start = line[0], onEdge = contains(P, start, 1.5) && !contains(P, start, -1.5);
  if (onEdge) hits.unshift([-1, start]);
  else if (contains(P, start)) return null; // starts inside: it can't split the piece on its own
  for (let i = 0; i + 1 < hits.length; i++) {
    const E = hits[i][1], X = hits[i + 1][1];
    if (Math.hypot(X[0] - E[0], X[1] - E[1]) > 8) {
      // the crack's own point furthest off the straight cut between them
      let far = null, dev = 0;
      const ex = X[0] - E[0], ey = X[1] - E[1], l = Math.hypot(ex, ey);
      for (let k = Math.ceil(hits[i][0]); k <= hits[i + 1][0]; k++) {
        const q = line[k]; if (!q) continue;
        const d = Math.abs((q[0] - E[0]) * ey - (q[1] - E[1]) * ex) / l;
        if (d > dev) { dev = d; far = q; }
      }
      return { E, X, far, dev };
    }
  }
  return null;
}
// One straight cut per piece follows a crack only while the crack runs straight across it. Where it
// bends more than a few pixels away, the piece first breaks across the crack at the bend, slanted,
// as glass does, and each half then takes its own straight cut.
function split(P, line, depth = 0) {
  const s = span(P, line);
  if (!s) return [P];
  const d = [s.X[0] - s.E[0], s.X[1] - s.E[1]];
  if (s.dev > 3.5 && depth < 3) {
    const a = Math.atan2(d[0], -d[1]) + (depth % 2 ? 0.3 : -0.3), across = cut(P, s.far, [Math.cos(a), Math.sin(a)]);
    if (across && across.every((q) => solid(q))) return across.flatMap((q) => split(q, line, depth + 1));
  }
  const two = cut(P, s.E, d);
  return two && two.every((q) => solid(q)) ? two : [P];
}
// cut every piece a crack runs right across, along the crack; pieces too small to stand stay whole
export function cutAlong(pieces, line, max = 24) {
  const out = [];
  for (let i = 0; i < pieces.length; i++) {
    const P = pieces[i], room = out.length + pieces.length - i < max;
    out.push(...(room ? split(P, line) : [P]));
  }
  return out;
}

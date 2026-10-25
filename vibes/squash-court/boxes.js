// Camera seeds from the service boxes. The floor pattern behind the short line is the most
// distinctive thing on a squash court: two box sides meet the short line in T junctions and turn
// into the box backs in L junctions, all four corners on the floor plane. Four such points give
// the floor homography, and with the principal point known it decomposes into a full camera
// (focal, rotation, position). Each matching pair of boxes in the image becomes one exact seed.
import { Camera, rotToRodrigues, solve } from './camera.js';

// Centre lines of the box geometry (court.js: lines are 50 mm, positions to the measured edge).
const H2 = 0.025;
const SHORT = 5.44 - H2, BACK = 7.04 - H2, SIDE_R = 1.6 - H2, SIDE_L = 6.4 - 1.6 + H2;

// Cluster segments into straight lines (same direction, on one line, gaps allowed).
export function mergeLines(segs, tolPx = 1.6, tolDeg = 2.5) {
  const order = segs.slice().sort((a, b) => b.len - a.len), lines = [], ct = Math.cos(tolDeg * Math.PI / 180);
  for (const s of order) {
    let L = null;
    for (const l of lines) {
      if (Math.abs(l.ux * s.ux + l.uy * s.uy) < ct) continue;
      const d0 = Math.abs((s.x0 - l.px) * l.nx + (s.y0 - l.py) * l.ny), d1 = Math.abs((s.x1 - l.px) * l.nx + (s.y1 - l.py) * l.ny);
      if (d0 < tolPx && d1 < tolPx) { L = l; break; }
    }
    const t0 = L ? (s.x0 - L.px) * L.ux + (s.y0 - L.py) * L.uy : 0, t1 = L ? (s.x1 - L.px) * L.ux + (s.y1 - L.py) * L.uy : s.len;
    if (!L) { L = { px: s.x0, py: s.y0, ux: (s.x1 - s.x0) / s.len, uy: (s.y1 - s.y0) / s.len, iv: [], len: 0, wt: 0 }; L.nx = -L.uy; L.ny = L.ux; lines.push(L); }
    L.iv.push([Math.min(t0, t1), Math.max(t0, t1)]); L.len += s.len; L.wt += s.len * (s.wt ?? 1);
  }
  for (const l of lines) { // merge intervals
    l.iv.sort((a, b) => a[0] - b[0]); const m = [];
    for (const v of l.iv) { if (m.length && v[0] <= m[m.length - 1][1] + 1) m[m.length - 1][1] = Math.max(m[m.length - 1][1], v[1]); else m.push(v.slice()); }
    l.iv = m;
  }
  return lines;
}

const covered = (l, a, b) => { let s = 0; for (const [p, q] of l.iv) s += Math.max(0, Math.min(b, q) - Math.max(a, p)); return s / (b - a); };

// Junctions between pairs of lines: the intersection, and which of each line's two arms leave it.
export function junctions(lines, { gap = 7, arm = 10, minAngle = 12 } = {}) {
  // the line detector goes quiet within a line width or so of a junction (one side of the
  // crossing line is not like the other), so arms are looked for from `gap` px out
  const out = [], sa = Math.sin(minAngle * Math.PI / 180);
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const A = lines[i], B = lines[j], cr = A.ux * B.uy - A.uy * B.ux;
    if (Math.abs(cr) < sa) continue;
    const dx = B.px - A.px, dy = B.py - A.py, ta = (dx * B.uy - dy * B.ux) / cr;
    const x = A.px + A.ux * ta, y = A.py + A.uy * ta, tb = (x - B.px) * B.ux + (y - B.py) * B.uy;
    const arms = (l, t) => [covered(l, t - gap - arm, t - gap) > 0.5, covered(l, t + gap, t + gap + arm) > 0.5];
    const a = arms(A, ta), b = arms(B, tb);
    if (!(a[0] || a[1]) || !(b[0] || b[1])) continue;
    out.push({ x, y, A, B, ta, tb, a, b });
  }
  return out;
}

// Homography (row-major 3x3) from 4 point pairs, world (X, Y) -> image (u, v).
export function homography4(W, I) {
  const A = new Float64Array(64), b = new Float64Array(8);
  for (let k = 0; k < 4; k++) {
    const [X, Y] = W[k], [u, v] = I[k], r = 2 * k;
    A.set([X, Y, 1, 0, 0, 0, -u * X, -u * Y], r * 8); b[r] = u;
    A.set([0, 0, 0, X, Y, 1, -v * X, -v * Y], (r + 1) * 8); b[r + 1] = v;
  }
  const h = solve(A, b, 8);
  return h && [...h, 1];
}

// Floor homography -> camera, principal point (cx, cy) known, square pixels, no skew.
// The focal from four corners of one small rectangle is ill-conditioned (a pixel of corner error
// can move it by half), so pass `focal` to get the pose for a given focal instead.
export function focalFromFloorH(H, cx, cy) {
  const [a, b, , d, e, , p, q] = [H[0] - cx * H[6], H[1] - cx * H[7], 0, H[3] - cy * H[6], H[4] - cy * H[7], 0, H[6], H[7]];
  const fs = [];
  if (Math.abs(p * q) > 1e-12) { const v = -(a * b + d * e) / (p * q); if (v > 0) fs.push(v); }
  if (Math.abs(q * q - p * p) > 1e-12) { const v = (a * a + d * d - b * b - e * e) / (q * q - p * p); if (v > 0) fs.push(v); }
  return fs.length ? Math.sqrt(fs.length === 2 ? Math.sqrt(fs[0] * fs[1]) : fs[0]) : null;
}

export function cameraFromFloorH(H, w, h, cx, cy, focal = null) {
  const g = [H[0] - cx * H[6], H[1] - cx * H[7], H[2] - cx * H[8], H[3] - cy * H[6], H[4] - cy * H[7], H[5] - cy * H[8], H[6], H[7], H[8]];
  const [a, b, c, d, e, f0, p, q, r] = g; // columns h1 = (a, d, p), h2 = (b, e, q), h3 = (c, f0, r)
  const f = focal ?? focalFromFloorH(H, cx, cy);
  if (!f) return null;
  let r1 = [a / f, d / f, p], r2 = [b / f, e / f, q], t = [c / f, f0 / f, r];
  const n1 = Math.hypot(...r1), n2 = Math.hypot(...r2), lam = 2 / (n1 + n2);
  // sign: the court centre must be in front of the camera
  const depth = lam * (r1[2] * 3.2 + r2[2] * 6 + t[2]), s = depth > 0 ? lam : -lam;
  r1 = r1.map((v) => v * s); r2 = r2.map((v) => v * s); t = t.map((v) => v * s);
  const m1 = Math.hypot(...r1); r1 = r1.map((v) => v / m1);
  const dp = r1[0] * r2[0] + r1[1] * r2[1] + r1[2] * r2[2]; r2 = r2.map((v, i) => v - dp * r1[i]);
  const m2 = Math.hypot(...r2); r2 = r2.map((v) => v / m2);
  const r3 = [r1[1] * r2[2] - r1[2] * r2[1], r1[2] * r2[0] - r1[0] * r2[2], r1[0] * r2[1] - r1[1] * r2[0]];
  const R = [r1[0], r2[0], r3[0], r1[1], r2[1], r3[1], r1[2], r2[2], r3[2]]; // columns r1 r2 r3
  const C = [0, 1, 2].map((j) => -(R[j] * t[0] + R[3 + j] * t[1] + R[6 + j] * t[2]));
  return new Camera([...rotToRodrigues(R), ...C, Math.log(f), 0], w, h, cx, cy);
}

// Seeds: every image quad of box corners that looks like the two service boxes.
export function boxSeeds(F, { max = 48, gap = 6, probe = 14 } = {}) {
  const lines = mergeLines(F.segs.filter((s) => (s.wt ?? 1) > 0.3)).filter((l) => l.len >= 8);
  // The corners come from intersecting the fitted lines, not from line pixels at the corner: the
  // detector goes quiet within a line width of a junction, and a player's foot often stands on one.
  const meet = (A, B) => {
    const cr = A.ux * B.uy - A.uy * B.ux; if (Math.abs(cr) < 0.2) return null;
    const ta = ((B.px - A.px) * B.uy - (B.py - A.py) * B.ux) / cr, x = A.px + A.ux * ta, y = A.py + A.uy * ta;
    return { x, y, ta, tb: (x - B.px) * B.ux + (y - B.py) * B.uy };
  };
  const cov = (l, a, b) => covered(l, Math.min(a, b), Math.max(a, b));
  const sides = [], J = [];
  for (const V of lines) {
    // corners of V with every other line
    const hits = [];
    for (const O of lines) { if (O === V) continue; const m = meet(V, O); if (m && m.x > -20 && m.y > -20 && m.x < F.w + 20 && m.y < F.h + 20) hits.push({ O, ...m }); }
    for (const s of hits) for (const b of hits) {
      if (s === b) continue;
      const dir = Math.sign(b.ta - s.ta), span = Math.abs(b.ta - s.ta);
      if (span < 10) continue;
      // V runs from the short line to the box back, and no further either way
      if (cov(V, s.ta + dir * gap, b.ta - dir * gap) < 0.55) continue;
      if (cov(V, s.ta - dir * gap, s.ta - dir * (gap + probe)) > 0.3 || cov(V, b.ta + dir * gap, b.ta + dir * (gap + probe)) > 0.3) continue;
      // the short line is there near the corner, on either side (players stand on it)
      const S = s.O, B = b.O;
      if (cov(S, s.tb + gap, s.tb + gap + 4 * probe) < 0.3 && cov(S, s.tb - gap, s.tb - gap - 4 * probe) < 0.3) continue;
      // the box back leaves the corner on one side only
      const bp = cov(B, b.tb + gap, b.tb + gap + probe), bm = cov(B, b.tb - gap, b.tb - gap - probe);
      if ((bp > 0.5) === (bm > 0.5)) continue;
      const sb = bp > 0.5 ? 1 : -1;
      sides.push({ T: { x: s.x, y: s.y, S }, L: { x: b.x, y: b.y }, bx: sb * B.ux, by: sb * B.uy, len: span });
    }
  }
  const seeds = [];
  for (let i = 0; i < sides.length; i++) for (let k = i + 1; k < sides.length; k++) {
    const s1 = sides[i], s2 = sides[k];
    if (s1.T.S !== s2.T.S) continue; // both on the same short line
    const ex = s2.T.x - s1.T.x, ey = s2.T.y - s1.T.y, d = Math.hypot(ex, ey);
    if (d < 12) continue;
    // stems on the same side of the short line; each box back turns outward, away from the other box
    const n = [s1.T.S.nx, s1.T.S.ny], st = (s) => Math.sign((s.L.x - s.T.x) * n[0] + (s.L.y - s.T.y) * n[1]);
    if (st(s1) !== st(s2)) continue;
    if (s1.bx * ex + s1.by * ey > 0 || s2.bx * -ex + s2.by * -ey > 0) continue;
    const I = [[s1.T.x, s1.T.y], [s1.L.x, s1.L.y], [s2.T.x, s2.T.y], [s2.L.x, s2.L.y]];
    for (const [xa, xb] of [[SIDE_R, SIDE_L], [SIDE_L, SIDE_R]]) {
      const Hm = homography4([[xa, SHORT], [xa, BACK], [xb, SHORT], [xb, BACK]], I);
      if (!Hm) continue;
      // the decomposed focal, and a ladder of fields of view to cover its uncertainty
      const f0 = focalFromFloorH(Hm, F.cx, F.cy), fl = [];
      if (f0 && f0 > 0.2 * F.w && f0 < 30 * F.w) fl.push(f0);
      for (const hf of [20, 30, 40, 50, 62, 75, 90]) fl.push(F.w / 2 / Math.tan(hf * Math.PI / 360));
      const support = s1.len + s2.len + d;
      for (const f of fl) {
        const cam = cameraFromFloorH(Hm, F.w, F.h, F.cx, F.cy, f);
        if (cam && cam.C[2] > 0.3 && (cam.C[1] > 0.3 || cam.C[2] > 4.7)) seeds.push({ cam, support, quad: I });
      }
    }
  }
  seeds.sort((a, b) => b.support - a.support);
  return { seeds: seeds.slice(0, max).map((s) => s.cam), lines, junctions: J, sides };
}

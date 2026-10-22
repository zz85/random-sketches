// The demo track, built from the same strokes a user would draw. Every piece starts where the last ended
// with the same heading, so the joints are smooth. test.js rides it and fails if the rider crashes.
import { DEFAULT_W } from './track.js';

const STEP = 0.4;
const Z = [0, 0, 1];

// wall stroke from a parametric curve f(u) -> [x,y,z], sampled ~STEP apart
function curve(f, u0, u1, approxLen, hint = Z) {
  const n = Math.max(2, Math.ceil(approxLen / STEP));
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(f(u0 + (u1 - u0) * (i / n)));
  return pts;
}
const wall = (pts, extra = {}) => ({ type: 0, mode: 'wall', pts, hints: pts.map(() => extra.hint || Z), flip: false, bank: false, w: DEFAULT_W, ...extra, hint: undefined });

// top-down turtle: heading psi in the xz plane, curvature profile k(s), grade g(s) (dy/ds)
function turtle(start, psi, length, k, g) {
  const pts = [start.slice()];
  let [x, y, z] = start, s = 0;
  const n = Math.ceil(length / STEP), ds = length / n;
  for (let i = 0; i < n; i++) {
    const sm = s + ds / 2;
    psi += k(sm) * ds;
    x += Math.cos(psi) * ds; z += Math.sin(psi) * ds; y += g(sm) * ds;
    s += ds;
    pts.push([x, y, z]);
  }
  return { pts, psi };
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function makeDemo() {
  const strokes = [];
  const flag = { p: [-29, 22.05, 0], dir: [1, 0, 0], v: 2 };

  // 1. start platform and a long cosine drop
  strokes.push(wall(curve((x) => [x, x < -24 ? 22 : 2 + 10 * (1 + Math.cos(Math.PI * (x + 24) / 20)), 0], -31, -4, 34)));
  strokes.push(wall(curve((x) => [x, 2, 0], -4, 0, 4)));

  // 2. corkscrew loop: a 2D Line Rider loop whose plane slides sideways by a ribbon and a half
  const R = 3.6, dz = 3.8;
  strokes.push(wall(curve((ph) => [R * Math.cos(ph), 2 + R + R * Math.sin(ph), dz * (ph + Math.PI / 2) / (2 * Math.PI)], -Math.PI / 2, 1.5 * Math.PI, 2 * Math.PI * R)));

  // 3. run-out, a lip and a straight launch (so the sled leaves without spinning), then a landing
  //    laid along the ballistic path a little below it, easing out to a slope
  strokes.push(wall(curve((x) => [x, 2, dz], 0, 8, 8)));
  const lipR = 14, lipA = 13 * Math.PI / 180;
  strokes.push(wall(curve((a) => [8 + lipR * Math.sin(a), 2 + lipR * (1 - Math.cos(a)), dz], 0, lipA, lipR * lipA)));
  const lx0 = 8 + lipR * Math.sin(lipA), ly0 = 2 + lipR * (1 - Math.cos(lipA));
  const lx1 = lx0 + 2.5 * Math.cos(lipA), ly1 = ly0 + 2.5 * Math.sin(lipA);
  strokes.push(wall([[lx0, ly0, dz], [lx0 + 1.25 * Math.cos(lipA), ly0 + 1.25 * Math.sin(lipA), dz], [lx1, ly1, dz]]));
  // approximate take-off speed from the drop, ballistic path from the end of the launch
  // take-off speed from the drop, underestimated so the real path always passes above the landing
  const v = 0.86 * Math.sqrt(2 * 16 * (22.05 + 4 / 32 - ly1));
  const vx = v * Math.cos(lipA), vy = v * Math.sin(lipA);
  const yb = (x) => { const t = (x - lx1) / vx; return ly1 + vy * t - 8 * t * t - 0.3; };
  const slope = (x) => { const t = (x - lx1) / vx; return (vy - 16 * t) / vx; };
  const xa = lx1 + vx * 0.3, xb = lx1 + vx * 1.15;
  const land = curve((x) => [x, yb(x), dz], xa, xb, (xb - xa) * 1.1);
  // then hold the final slope and round out to flat over an arc
  const m = slope(xb), ang = Math.atan(-m), rr = 18;
  const cx = xb + rr * Math.sin(ang) * 0 , ybx = yb(xb);
  // circle tangent to the slope at xb, bottoming out: centre above-forward of the end point
  const ccx = xb + rr * Math.sin(ang), ccy = ybx + rr * Math.cos(ang);
  const arc = curve((a) => [ccx - rr * Math.sin(a), ccy - rr * Math.cos(a), dz], ang, 0, rr * ang);
  void cx;
  strokes.push(wall([...land, ...arc.slice(1)]));
  let end = arc[arc.length - 1];

  // 4. a banked 180 degree turn drawn top-down, gently downhill, curvature eased in and out
  const T = 124, RAMP = 30, TAIL = 16;
  const turn = turtle(end, 0, T + TAIL, (s) => (smooth(0, RAMP, s) * (1 - smooth(T - RAMP, T, s))) * (Math.PI / (T - RAMP)), () => -0.04);
  strokes.push({ type: 0, mode: 'floor', pts: turn.pts, flip: false, bank: true, w: 3.2 });
  end = turn.pts[turn.pts.length - 1];

  // 5. accelerate lines, then rollers and a long flat finish (drawn right to left, seen from -z)
  const a = turtle(end, turn.psi, 16, () => 0, () => 0);
  strokes.push({ type: 1, mode: 'floor', pts: a.pts, flip: false, bank: false, w: 3.2 });
  end = a.pts[a.pts.length - 1];
  const x0 = end[0], y0 = end[1], z0 = end[2];
  // long gentle swells, then a run-out that climbs to bleed the speed off
  const roll = curve((x) => [x0 - x, y0 + 0.5 * (1 - Math.cos(2 * Math.PI * x / 36)), z0], 0, 72, 74);
  strokes.push(wall(roll, { hint: [0, 0, -1], w: 3.2 }));
  const fin = curve((x) => [x0 - 72 - x, y0 + (x > 10 ? (x - 10) ** 2 * 0.006 : 0), z0], 0, 90, 95);
  strokes.push(wall(fin, { hint: [0, 0, -1], w: 3.2 }));

  // scenery: a finish banner arch
  const fx = x0 - 82;
  strokes.push({ type: 2, mode: 'wall', pts: curve((a) => [fx, y0 + 4 * Math.sin(a), z0 + 3 * Math.cos(a)], 0, Math.PI, 12), hints: null, flip: false, bank: false, w: 0.3 });
  return { strokes, flag };
}

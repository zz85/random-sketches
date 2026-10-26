// Synthetic squash court frames with a known camera, for testing the detector: ray-cast floor,
// front and side walls (opaque club walls or glass with a busy crowd behind), painted 50 mm lines,
// players as occluding blobs, advert text clutter, noise. Deterministic from a seed.
import { Camera } from './camera.js';
import { mulberry32 } from './detect.js';

const W = 6.4, L = 9.75, h = 0.025;

export function renderCourt(cam, opt = {}) {
  const rng = mulberry32(opt.seed ?? 7), w = cam.w, H = cam.h;
  const style = opt.style || 'club'; // 'club' (white walls, wood floor, red lines) | 'glass' (dark floor, glass sides, crowd)
  const tin = opt.tin ?? 0.48;
  const line = opt.lineColour || (style === 'glass' ? [235, 70, 110] : [200, 30, 35]);
  const floorC = style === 'glass' ? [70, 72, 95] : [205, 165, 115];
  const wallC = style === 'glass' ? [40, 50, 110] : [235, 235, 232];
  const out = new Uint8ClampedArray(w * H * 4);
  // players: vertical ellipsoids standing on the floor (world), plus some 2D advert text boxes on the front wall
  // players: a number (placed at random) or [{ x, y, c? }]; drawn as cylinders r 0.15 m, 1.8 m tall
  const players = Array.isArray(opt.players) ? opt.players.map((p) => ({ c: [rng() * 255, rng() * 255, rng() * 255], ...p }))
    : (opt.players ?? 2) > 0 ? Array.from({ length: opt.players ?? 2 }, () => ({ x: 1 + rng() * 4.4, y: 3 + rng() * 5, c: [rng() * 255, rng() * 255, rng() * 255] })) : [];
  // ball: { a: [x, y, z], b?: [x, y, z] } — a 40 mm ball, or the capsule a..b it sweeps during the exposure
  const ball = opt.ball ? { a: opt.ball.a, b: opt.ball.b || opt.ball.a, r: 0.02, c: opt.ball.c || [20, 20, 20] } : null;
  const adverts = Array.from({ length: opt.adverts ?? 6 }, () => ({ x: rng() * 5.5, z: 0.6 + rng() * 3.6, w: 0.3 + rng() * 1.2, h: 0.08 + rng() * 0.25, c: [rng() * 255, rng() * 255, rng() * 255], f: 6 + rng() * 20 }));
  const grain = (a, b) => { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); };
  const ss = opt.supersample ?? 2;
  const shade = (o, d) => {
    // nearest opaque hit among floor and walls; glass walls are see-through to a crowd texture
    let best = Infinity, col = null;
    const tryPlane = (axis, val, fn) => {
      const den = d[axis]; if (Math.abs(den) < 1e-9) return;
      const t = (val - o[axis]) / den; if (t <= 1e-4 || t >= best) return;
      const p = [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]], c = fn(p);
      if (c) { best = t; col = c; }
    };
    // players: cylinders r 0.25 m, height 1.8, in front of everything they hide
    for (const pl of players) {
      const ox = o[0] - pl.x, oy = o[1] - pl.y, a = d[0] * d[0] + d[1] * d[1], b = 2 * (ox * d[0] + oy * d[1]), c = ox * ox + oy * oy - 0.15 * 0.15, disc = b * b - 4 * a * c;
      if (disc < 0) continue; const t = (-b - Math.sqrt(disc)) / (2 * a); const z = o[2] + t * d[2];
      if (t > 0 && t < best && z > 0 && z < 1.8) { best = t; col = pl.c.map((v) => v * (0.6 + 0.4 * (z / 1.8))); }
    }
    if (ball) { // capsule: closest approach of the ray to the segment
      const ab = ball.b.map((v, i) => v - ball.a[i]), ao = o.map((v, i) => v - ball.a[i]);
      const L2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2, dd = d[0] * ab[0] + d[1] * ab[1] + d[2] * ab[2];
      const da = d[0] * ao[0] + d[1] * ao[1] + d[2] * ao[2], ba = ab[0] * ao[0] + ab[1] * ao[1] + ab[2] * ao[2];
      const den = L2 - dd * dd; let s = den > 1e-12 ? (ba - dd * da) / den : 0; s = Math.max(0, Math.min(1, s));
      const q = ball.a.map((v, i) => v + ab[i] * s), oq = q.map((v, i) => v - o[i]), t = oq[0] * d[0] + oq[1] * d[1] + oq[2] * d[2];
      const dist = Math.hypot(o[0] + t * d[0] - q[0], o[1] + t * d[1] - q[1], o[2] + t * d[2] - q[2]);
      if (t > 0 && dist < ball.r && t < best) { best = t; col = ball.c; }
    }
    tryPlane(2, 0, (p) => { // floor
      if (p[0] < 0 || p[0] > W || p[1] < 0 || p[1] > L) return null;
      const on = Math.abs(p[1] - (5.44 - h)) < h || (p[1] > 5.44 && Math.abs(p[0] - W / 2) < h) ||
        (p[1] > 5.44 && p[1] < 7.04 && (Math.abs(p[0] - (1.6 - h)) < h || Math.abs(p[0] - (W - 1.6 + h)) < h)) ||
        (Math.abs(p[1] - (7.04 - h)) < h && (p[0] < 1.6 || p[0] > W - 1.6));
      if (on) return line;
      const g = style === 'club' ? 0.92 + 0.12 * grain(Math.floor(p[0] / 0.07), Math.floor(p[1] / 1.3)) : 0.95 + 0.1 * grain(p[0] * 40 | 0, p[1] * 40 | 0);
      return floorC.map((v) => v * g);
    });
    // a front camera (in the tin, or behind a glass front wall) does not see the front wall
    if (o[1] > 0.3) tryPlane(1, 0, (p) => { // front wall
      if (p[0] < 0 || p[0] > W || p[2] < 0 || p[2] > 5.6) return null;
      if (p[2] < tin - 2 * h) return style === 'glass' ? [30, 30, 40] : [240, 240, 240];
      if (Math.abs(p[2] - (4.57 - h)) < h || Math.abs(p[2] - (1.78 - h)) < h || Math.abs(p[2] - (tin - h)) < h) return line;
      for (const a of adverts) if (p[0] > a.x && p[0] < a.x + a.w && p[2] > a.z && p[2] < a.z + a.h) {
        // striped "text"
        if (Math.sin((p[0] - a.x) * a.f * 6) > 0.2 && (p[2] - a.z) / a.h > 0.15 && (p[2] - a.z) / a.h < 0.85) return a.c;
      }
      return wallC;
    });
    for (const sx of [0, W]) tryPlane(0, sx, (p) => { // side walls
      if (p[1] < 0 || p[1] > L || p[2] < 0 || p[2] > 5.6) return null;
      const zo = 4.57 - (4.57 - 2.13) * p[1] / L - h;
      if (Math.abs(p[2] - zo) < h) return line;
      if (style === 'glass') return null; // see-through (crowd shows behind)
      return wallC.map((v) => v * 0.93);
    });
    if (col) return col;
    // background: crowd / arena — noisy blobs
    const az = Math.atan2(d[1], d[0]), el = d[2];
    const n = grain(Math.floor(az * 120), Math.floor(el * 120));
    return style === 'glass' ? [30 + 80 * n, 25 + 60 * n, 40 + 70 * n] : [120 * n + 40, 120 * n + 40, 120 * n + 40];
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const { o, d } = cam.ray(x + (i + 0.5) / ss, y + (j + 0.5) / ss), c = shade(o, d);
      r += c[0]; g += c[1]; b += c[2];
    }
    const n = ss * ss, k = (y * w + x) * 4, nz = (opt.noise ?? 6) * (rng() - 0.5) * 2;
    out[k] = r / n + nz; out[k + 1] = g / n + nz; out[k + 2] = b / n + nz; out[k + 3] = 255;
  }
  return { data: out, width: w, height: H, players: players.map(({ x, y }) => [x, y]), ball: ball && ball.a };
}

// A random plausible broadcast camera (seeded), the kind the detector must handle.
export function randomBroadcastCamera(rng, w = 1280, hgt = 720) {
  const C = [W / 2 + (rng() - 0.5) * 2.5, L + 2 + rng() * 6, 2.2 + rng() * 3.5];
  const T = [W / 2 + (rng() - 0.5) * 1.2, 1 + rng() * 3, 0.8 + rng() * 1.2];
  // pick the focal so most of the court is in view
  const dist = Math.hypot(C[0] - T[0], C[1] - T[1], C[2] - T[2]);
  const hfov = 2 * Math.atan((W * (0.55 + rng() * 0.5)) / dist);
  return Camera.fromLookAt(C, T, (rng() - 0.5) * 0.06, w / 2 / Math.tan(hfov / 2), w, hgt);
}

// A random front camera: in the tin or a front corner, low, looking back down the court (the PSA
// front-wall camera), seeded.
export function randomFrontCamera(rng, w = 1280, hgt = 720) {
  const corner = rng() < 0.5, side = rng() < 0.5 ? 0 : 1;
  const C = corner ? [side ? W - 0.05 - rng() * 0.3 : 0.05 + rng() * 0.3, -0.4 + rng() * 0.4, 0.5 + rng() * 0.5] : [1 + rng() * (W - 2), -0.3 + rng() * 0.3, 0.35 + rng() * 0.25];
  const T = [corner ? (side ? 0.5 + rng() * 2.5 : W - 0.5 - rng() * 2.5) : W / 2 + (rng() - 0.5) * 2, 6.5 + rng() * 3.2, 0.1 + rng() * 0.4];
  const hfov = (50 + rng() * 40) * Math.PI / 180;
  return Camera.fromLookAt(C, T, (rng() - 0.5) * 0.04, w / 2 / Math.tan(hfov / 2), w, hgt);
}

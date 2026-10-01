// Deterministic "phone photo" degradation of a clean engraving, for tests and the demo:
// rotation, keystone perspective, page curl, scale, uneven lighting, blur and sensor noise.
// Returns the photo plus `fwd(x, y)`, mapping clean-image points to photo pixels (truth).
import { boxBlur } from './imgproc.js';

export function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function degrade(img, o = {}) {
  const { w, h, data } = img;
  const rot = ((o.rot ?? 0) * Math.PI) / 180, key = o.keystone ?? 0, curl = o.curl ?? 0, sc = o.scale ?? 1;
  const pad = Math.round((o.pad ?? 0.04) * Math.max(w, h));
  const ow = Math.round((w + 2 * pad) * sc), oh = Math.round((h + 2 * pad) * sc);
  const cx = w / 2, cy = h / 2, c = Math.cos(rot), s = Math.sin(rot);
  // photo (u,v) -> clean (x,y)
  const inv = (u, v) => {
    let a = u / sc - pad - cx, b = v / sc - pad - cy;
    const ra = c * a + s * b, rb = -s * a + c * b;           // undo rotation
    const kx = 1 + key * (rb / h);                             // keystone: wider at the bottom
    const x = ra / kx + cx;
    const y = rb + cy - curl * Math.sin((Math.PI * (x / w))) ; // curl: page bulges up in the middle
    return [x, y];
  };
  const fwd = (x, y) => { // Newton on inv
    let u = (x + pad) * sc, v = (y + pad) * sc;
    for (let i = 0; i < 20; i++) {
      const [x0, y0] = inv(u, v), [x1, y1] = inv(u + 1, v), [x2, y2] = inv(u, v + 1);
      const j11 = x1 - x0, j12 = x2 - x0, j21 = y1 - y0, j22 = y2 - y0, det = j11 * j22 - j12 * j21;
      const ex = x - x0, ey = y - y0;
      u += (j22 * ex - j12 * ey) / det; v += (-j21 * ex + j11 * ey) / det;
      if (Math.abs(ex) + Math.abs(ey) < 1e-3) break;
    }
    return [u, v];
  };
  const R = rng(o.seed ?? 1), out = new Uint8Array(ow * oh);
  const paper = o.paper ?? 235, ink = o.ink ?? 40, light = o.light ?? 0;
  const lx = R(), ly = R();
  for (let v = 0; v < oh; v++) {
    for (let u = 0; u < ow; u++) {
      const [x, y] = inv(u, v);
      let val = 255;
      const x0 = Math.floor(x), y0 = Math.floor(y);
      if (x0 >= 0 && y0 >= 0 && x0 < w - 1 && y0 < h - 1) {
        const fx = x - x0, fy = y - y0, i = y0 * w + x0;
        const t1 = data[i] + (data[i + 1] - data[i]) * fx, t2 = data[i + w] + (data[i + w + 1] - data[i + w]) * fx;
        val = t1 + (t2 - t1) * fy;
      }
      // lighting: radial falloff from a random hot spot plus a linear shadow
      const dx = u / ow - lx, dy = v / oh - ly;
      const lit = 1 - light * (0.6 * Math.min(1, Math.sqrt(dx * dx + dy * dy)) + 0.4 * (u / ow));
      const pp = paper * lit, ii = ink * (0.6 + 0.4 * lit);
      out[v * ow + u] = Math.max(0, Math.min(255, ii + (pp - ii) * (val / 255)));
    }
  }
  let res = { w: ow, h: oh, data: out };
  if (o.blur) res = boxBlur(res, o.blur);
  if (o.noise) {
    const d = res.data;
    for (let i = 0; i < d.length; i++) { const n = (R() + R() + R() - 1.5) * 2 * o.noise; d[i] = Math.max(0, Math.min(255, d[i] + n)); }
  }
  return { img: res, fwd };
}

// A few named photo conditions used by the tests and eval.
export const CONDITIONS = {
  clean: {},
  scan: { rot: 1.2, blur: 1, noise: 6, light: 0.1, seed: 2 },
  photo: { rot: -2.5, keystone: 0.04, curl: 6, scale: 1.25, blur: 1, noise: 10, light: 0.35, seed: 3 },
  phone: { rot: 4, keystone: 0.07, curl: 10, scale: 0.85, blur: 1, noise: 14, light: 0.5, paper: 215, ink: 55, seed: 4 },
};

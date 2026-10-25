// Pinhole camera with one radial distortion term, a compact 8-number parametrisation for the
// optimiser, and the small linear algebra the fit needs (no deps; runs in node, workers, pages).
//
// Camera frame: x right, y down, z forward. A world point X maps to Xc = R (X - C), then
// u = cx + f * (x / z) * (1 + k1 r^2), v = cy + f * (y / z) * (1 + k1 r^2), r^2 = (x^2 + y^2) / z^2.
// Parameters p = [rx, ry, rz, Cx, Cy, Cz, log f, k1] with r the Rodrigues vector of R.

export function rodrigues(r) {
  const th = Math.hypot(r[0], r[1], r[2]);
  if (th < 1e-12) return [1, -r[2], r[1], r[2], 1, -r[0], -r[1], r[0], 1];
  const k = [r[0] / th, r[1] / th, r[2] / th], c = Math.cos(th), s = Math.sin(th), v = 1 - c;
  return [
    c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s,
    k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s,
    k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v,
  ];
}

export function rotToRodrigues(R) {
  // via a unit quaternion (Shepperd's method), stable for every angle including 180°
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = R, tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4; }
  if (w < 0) { w = -w; x = -x; y = -y; z = -z; }
  const sn = Math.hypot(x, y, z); if (sn < 1e-12) return [0, 0, 0];
  const th = 2 * Math.atan2(sn, w);
  return [x / sn * th, y / sn * th, z / sn * th];
}

// Rotation for a camera at C looking at T with the given roll (radians) about the view axis; world up is +z.
export function lookAt(C, T, roll = 0) {
  let fz = [T[0] - C[0], T[1] - C[1], T[2] - C[2]];
  const n = Math.hypot(...fz); fz = fz.map((v) => v / n);
  let fx = [fz[1], -fz[0], 0]; // forward × up
  const m = Math.hypot(...fx) || 1; fx = fx.map((v) => v / m);
  const fy = [fz[1] * fx[2] - fz[2] * fx[1], fz[2] * fx[0] - fz[0] * fx[2], fz[0] * fx[1] - fz[1] * fx[0]];
  const c = Math.cos(roll), s = Math.sin(roll);
  const ax = fx.map((v, i) => c * v + s * fy[i]), ay = fy.map((v, i) => -s * fx[i] + c * v);
  return [...ax, ...ay, ...fz]; // rows: camera axes in world coordinates
}

export class Camera {
  // (cx, cy) defaults to the image centre; pixel i covers [i, i + 1)
  constructor(p, width, height, cx = width / 2, cy = height / 2) { this.w = width; this.h = height; this.cx = cx; this.cy = cy; this.set(p); }
  set(p) {
    this.p = p.slice();
    this.R = rodrigues(p);
    this.C = [p[3], p[4], p[5]];
    this.f = Math.exp(p[6]);
    this.k1 = p[7] || 0;
    return this;
  }
  static fromLookAt(C, T, roll, f, w, h, k1 = 0, cx, cy) {
    const r = rotToRodrigues(lookAt(C, T, roll));
    return new Camera([...r, ...C, Math.log(f), k1], w, h, cx, cy);
  }
  // camera-frame coordinates
  toCam(X) {
    const R = this.R, a = X[0] - this.C[0], b = X[1] - this.C[1], c = X[2] - this.C[2];
    return [R[0] * a + R[1] * b + R[2] * c, R[3] * a + R[4] * b + R[5] * c, R[6] * a + R[7] * b + R[8] * c];
  }
  // [u, v, depth]; depth <= 0 means behind the camera
  project(X) {
    const R = this.R, a = X[0] - this.C[0], b = X[1] - this.C[1], c = X[2] - this.C[2];
    const z = R[6] * a + R[7] * b + R[8] * c;
    if (z <= 1e-6) return [NaN, NaN, z];
    const x = (R[0] * a + R[1] * b + R[2] * c) / z, y = (R[3] * a + R[4] * b + R[5] * c) / z;
    const d = 1 + this.k1 * (x * x + y * y);
    return [this.cx + this.f * x * d, this.cy + this.f * y * d, z];
  }
  // world ray through pixel (u, v): origin C, unit direction
  ray(u, v) {
    let x = (u - this.cx) / this.f, y = (v - this.cy) / this.f;
    if (this.k1) { // undistort by fixed point iteration
      const xd = x, yd = y;
      for (let i = 0; i < 8; i++) { const d = 1 + this.k1 * (x * x + y * y); x = xd / d; y = yd / d; }
    }
    const R = this.R, d = [R[0] * x + R[3] * y + R[6], R[1] * x + R[4] * y + R[7], R[2] * x + R[5] * y + R[8]];
    const n = Math.hypot(...d);
    return { o: this.C.slice(), d: d.map((v) => v / n) };
  }
  // intersection of the pixel's ray with a plane n·X = k (null if parallel or behind)
  unproject(u, v, n, k) {
    const { o, d } = this.ray(u, v), den = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    if (Math.abs(den) < 1e-9) return null;
    const t = (k - (n[0] * o[0] + n[1] * o[1] + n[2] * o[2])) / den;
    return t > 0 ? [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]] : null;
  }
  toFloor(u, v) { return this.unproject(u, v, [0, 0, 1], 0); }
  toFrontWall(u, v) { return this.unproject(u, v, [0, 1, 0], 0); }
  // 3x4 projection matrix K [R | -R C] (ignores k1)
  matrix() {
    const R = this.R, C = this.C, f = this.f;
    const t = [-(R[0] * C[0] + R[1] * C[1] + R[2] * C[2]), -(R[3] * C[0] + R[4] * C[1] + R[5] * C[2]), -(R[6] * C[0] + R[7] * C[1] + R[8] * C[2])];
    const K = [f, 0, this.cx, 0, f, this.cy, 0, 0, 1], P = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) {
      let s = 0; for (let k = 0; k < 3; k++) s += K[i * 3 + k] * (j < 3 ? R[k * 3 + j] : t[k]);
      P.push(s);
    }
    return P;
  }
  // homography from plane coordinates to pixels (ignores k1): floor (x, y, 0) or front wall (x, 0, z)
  homography(plane = 'floor') {
    const P = this.matrix(), c = plane === 'floor' ? [0, 1, 3] : [0, 2, 3];
    return [0, 1, 2].flatMap((i) => c.map((j) => P[i * 4 + j]));
  }
  with(p) { return new Camera(p, this.w, this.h, this.cx, this.cy); }
  hfov() { return 2 * Math.atan(this.w / 2 / this.f) * 180 / Math.PI; }
  // yaw (heading of the view axis, 0 = looking at the front wall), pitch (down positive) and roll, degrees
  angles() {
    const R = this.R, fz = [R[6], R[7], R[8]], fx = [R[0], R[1], R[2]];
    const yaw = Math.atan2(fz[0], -fz[1]) * 180 / Math.PI, pitch = Math.asin(-fz[2]) * 180 / Math.PI;
    const up = [0, 0, 1], side = [fz[1] * up[2] - fz[2] * up[1], fz[2] * up[0] - fz[0] * up[2], fz[0] * up[1] - fz[1] * up[0]];
    const sn = Math.hypot(...side) || 1;
    const roll = Math.atan2(-(fx[2]), (fx[0] * side[0] + fx[1] * side[1] + fx[2] * side[2]) / sn) * 180 / Math.PI;
    return { yaw, pitch, roll };
  }
}

// Solve the n×n system A x = b (A row-major, overwritten) by Gaussian elimination with partial pivoting.
export function solve(A, b, n) {
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r * n + i]) > Math.abs(A[p * n + i])) p = r;
    if (Math.abs(A[p * n + i]) < 1e-15) return null;
    if (p !== i) { for (let c = 0; c < n; c++) { const t = A[i * n + c]; A[i * n + c] = A[p * n + c]; A[p * n + c] = t; } const t = b[i]; b[i] = b[p]; b[p] = t; }
    for (let r = i + 1; r < n; r++) {
      const m = A[r * n + i] / A[i * n + i]; if (!m) continue;
      for (let c = i; c < n; c++) A[r * n + c] -= m * A[i * n + c];
      b[r] -= m * b[i];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i * n + c] * x[c]; x[i] = s / A[i * n + i]; }
  return x;
}

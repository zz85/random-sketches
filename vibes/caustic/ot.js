/*
 * ot.js - designing a caustic surface by optimal transport. Plain JS, no DOM, so it runs in the worker and in node.
 *
 * The problem: a uniform beam of light falls on a square of glass (or bronze, or water). Shape its surface so that
 * the light it refracts (or reflects) forms a given picture on a screen at distance D.
 *
 *  1. Transport. Light is conserved, so the surface has to move the beam's energy from a uniform square to the
 *     picture's brightness. Split the square into n x n cells and move the cell corners until cell (i, j) has an
 *     area equal to the share of the total brightness that pixel (i, j) of the picture holds. Each step solves a
 *     Poisson equation, lap(phi) = (area - target), and moves the corners down the gradient of phi: cells that
 *     are too big shrink and cells too small grow (Ferraro's "Poisson grid" scheme, after Schwartzburg et al.
 *     2014). Then the light that lands on the deformed cell (i, j) of the glass has to go to pixel (i, j).
 *  2. Normals. Each point of the glass now knows where its light must go, so Snell's law (or the mirror law)
 *     gives the surface normal that bends it there.
 *  3. Heights. The surface with those normals is found by least squares: lap(h) = div(slopes), another Poisson
 *     solve. Since the ray's start depends on h, steps 2 and 3 are repeated a few times.
 *
 * Every Poisson solve is exact, by a 2D DCT (Neumann boundaries) done with FFTs, so a 256 x 256 solve takes a few ms.
 */

// ---------------------------------------------------------------- FFT and DCT (length a power of two)

function fftPlan(N) {
  const rev = new Uint32Array(N), bits = Math.log2(N) | 0;
  if (1 << bits !== N) throw new Error('size must be a power of two');
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / N); sin[i] = Math.sin(-2 * Math.PI * i / N); }
  return { N, rev, cos, sin };
}

// in place; inverse without the 1/N
function fft(p, re, im, inverse) {
  const { N, rev, cos, sin } = p, sg = inverse ? -1 : 1;
  for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let s = 0; s < N; s += size) for (let k = 0; k < half; k++) {
      const wr = cos[k * step], wi = sg * sin[k * step], a = s + k, b = a + half;
      const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}

// DCT-II, X_k = sum_n x_n cos(pi k (2n + 1) / 2N), and its exact inverse, by Makhoul's reordering into one FFT.
export function makeDCT(N) {
  const p = fftPlan(N), re = new Float64Array(N), im = new Float64Array(N);
  const wc = new Float64Array(N), ws = new Float64Array(N);
  for (let k = 0; k < N; k++) { wc[k] = Math.cos(Math.PI * k / (2 * N)); ws[k] = Math.sin(Math.PI * k / (2 * N)); }
  const forward = (x, X, off = 0, stride = 1) => {
    for (let n = 0; n < N / 2; n++) { re[n] = x[off + 2 * n * stride]; re[N - 1 - n] = x[off + (2 * n + 1) * stride]; }
    im.fill(0); fft(p, re, im, false);
    for (let k = 0; k < N; k++) X[off + k * stride] = re[k] * wc[k] + im[k] * ws[k]; // Re(e^{-i pi k / 2N} V_k)
  };
  const inverse = (X, x, off = 0, stride = 1) => {
    for (let k = 0; k < N; k++) { // V_k = (X_k - i X_{N-k}) e^{i pi k / 2N}
      const a = X[off + k * stride], b = k ? -X[off + (N - k) * stride] : 0;
      re[k] = a * wc[k] - b * ws[k]; im[k] = a * ws[k] + b * wc[k];
    }
    fft(p, re, im, true);
    for (let n = 0; n < N / 2; n++) { x[off + 2 * n * stride] = re[n] / N; x[off + (2 * n + 1) * stride] = re[N - 1 - n] / N; }
  };
  return { forward, inverse };
}

// Solves lap(u) = f on an N x N cell grid with unit spacing and zero-flux (Neumann) edges, the 5-point Laplacian.
// f is first made to sum to zero (the only solvable part); u has zero mean.
// `denom(k, l)` replaces the Laplacian's eigenvalue for DCT mode (k, l), to solve another operator the DCT diagonalises.
export function makePoisson(N, denom) {
  const dct = makeDCT(N), tmp = new Float64Array(N * N), lam = new Float64Array(N);
  for (let k = 0; k < N; k++) lam[k] = 2 * Math.cos(Math.PI * k / N) - 2;
  const den = new Float64Array(N * N);
  for (let k = 0; k < N; k++) for (let l = 0; l < N; l++) den[k * N + l] = denom ? denom(k, l) : lam[k] + lam[l];
  return (f, u) => {
    for (let r = 0; r < N; r++) dct.forward(f, tmp, r * N, 1);
    for (let c = 0; c < N; c++) dct.forward(tmp, tmp, c, N);
    for (let k = 0; k < N; k++) for (let l = 0; l < N; l++) { const i = k * N + l; tmp[i] = k || l ? tmp[i] / den[i] : 0; }
    for (let c = 0; c < N; c++) dct.inverse(tmp, tmp, c, N);
    for (let r = 0; r < N; r++) dct.inverse(tmp, u, r * N, 1);
    return u;
  };
}

// ---------------------------------------------------------------- 1. transport

// Target cell areas from a picture: `lum` is n*n linear brightness, row-major, row 0 at the top (+y up in the
// lens frame, so rows are flipped here). `floor` keeps a little light everywhere, so no cell has to shrink to nothing.
export function targetAreas(lum, n, floor = 0.05) {
  const t = new Float64Array(n * n); let s = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const v = floor + (1 - floor) * Math.max(0, lum[(n - 1 - j) * n + i]); t[j * n + i] = v; s += v; }
  for (let k = 0; k < n * n; k++) t[k] /= s;
  return t;
}

// Vertex grid (n+1)^2, x then y interleaved, in the unit square. Cell (i, j) has corners v(i,j) v(i+1,j) v(i+1,j+1) v(i,j+1).
export function cellAreas(V, n, A) {
  const m = n + 1;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = 2 * (j * m + i), b = a + 2, c = a + 2 * m + 2, d = a + 2 * m;
    // shoelace over a b c d
    A[j * n + i] = 0.5 * ((V[a] * V[b + 1] - V[b] * V[a + 1]) + (V[b] * V[c + 1] - V[c] * V[b + 1]) + (V[c] * V[d + 1] - V[d] * V[c + 1]) + (V[d] * V[a + 1] - V[a] * V[d + 1]));
  }
  return A;
}

// Smallest t > 0 at which triangle (p0, p1, p2) moving with (d0, d1, d2) collapses; Infinity if never.
function collapseTime(V, D, i0, i1, i2) {
  const ax = V[i1] - V[i0], ay = V[i1 + 1] - V[i0 + 1], bx = V[i2] - V[i0], by = V[i2 + 1] - V[i0 + 1];
  const dax = D[i1] - D[i0], day = D[i1 + 1] - D[i0 + 1], dbx = D[i2] - D[i0], dby = D[i2 + 1] - D[i0 + 1];
  const c = ax * by - ay * bx, b = ax * dby + dax * by - ay * dbx - day * bx, a = dax * dby - day * dbx;
  let t = Infinity;
  if (Math.abs(a) < 1e-14) { if (Math.abs(b) > 1e-14) { const r = -c / b; if (r > 0) t = r; } return t; }
  const disc = b * b - 4 * a * c; if (disc < 0) return t;
  const s = Math.sqrt(disc), r1 = (-b - s) / (2 * a), r2 = (-b + s) / (2 * a);
  if (r1 > 0) t = Math.min(t, r1); if (r2 > 0) t = Math.min(t, r2);
  return t;
}

const cross = (V, a, b, c) => (V[b] - V[a]) * (V[c + 1] - V[a + 1]) - (V[b + 1] - V[a + 1]) * (V[c] - V[a]);

/*
 * Moves the vertices until each cell's area matches its target. Returns { V, iters, err } where err is the largest
 * |area - target| in units of a regular cell's area. `onStep(it, err, V)` is called each iteration.
 */
export function transport(target, n, { maxIter = 400, tol = 0.02, onStep, V: V0 } = {}) {
  const m = n + 1, V = new Float64Array(2 * m * m), D = new Float64Array(2 * m * m);
  if (V0) V.set(V0); else for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) { V[2 * (j * m + i)] = i / n; V[2 * (j * m + i) + 1] = j / n; }
  let stall = 0;
  const A = new Float64Array(n * n), L = new Float64Array(n * n), phi = new Float64Array(n * n), solve = makePoisson(n);
  const P = (i, j) => phi[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))];
  let err = Infinity, it = 0;
  for (; it < maxIter; it++) {
    cellAreas(V, n, A); err = 0;
    for (let k = 0; k < n * n; k++) { const e = (A[k] - target[k]) * n * n; err = Math.max(err, Math.abs(e)); L[k] = e / Math.sqrt(Math.max(A[k] * n * n, 0.05)); }
    if (onStep) onStep(it, err, V);
    if (err < tol) break;
    solve(L, phi);
    // gradient of phi at each vertex, in cell units, from the four cells around it; edges keep to their side
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const gx = 0.5 * ((P(i, j - 1) + P(i, j)) - (P(i - 1, j - 1) + P(i - 1, j)));
      const gy = 0.5 * ((P(i - 1, j) + P(i, j)) - (P(i - 1, j - 1) + P(i, j - 1)));
      const k = 2 * (j * m + i);
      D[k] = i === 0 || i === n ? 0 : -gx / n;
      D[k + 1] = j === 0 || j === n ? 0 : -gy / n;
    }
    // A cell stays usable while one of its two diagonals splits it into two upright triangles (a thin cell may
    // go concave), so the step stops at half the time to the first cell that loses both.
    let tmin = Infinity;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const a = 2 * (j * m + i), b = a + 2, c = a + 2 * m + 2, d = a + 2 * m;
      const t = Math.max(Math.min(collapseTime(V, D, a, b, c), collapseTime(V, D, a, c, d)), Math.min(collapseTime(V, D, a, b, d), collapseTime(V, D, b, c, d)));
      if (t < tmin) tmin = t;
    }
    const step = Math.min(1, 0.5 * tmin);
    for (let k = 0; k < V.length; k++) V[k] += step * D[k];
    if (step < 1e-3) { if (++stall >= 4) break; } else stall = 0; // pinned by a cell about to fold: as good as it gets
  }
  return { V, iters: it, err };
}

// The map from the lens to the picture, sampled at the lens's n x n cell centres: deformed vertex v goes to the
// regular vertex v, and points between are interpolated inside each deformed triangle. Returns Float64Array 2*n*n.
export function resampleMap(V, n) {
  const m = n + 1, M = new Float64Array(2 * n * n).fill(NaN);
  const tri = (a, b, c) => {
    const ax = V[a], ay = V[a + 1], bx = V[b], by = V[b + 1], cx = V[c], cy = V[c + 1];
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy); if (Math.abs(det) < 1e-18) return;
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) * n - 0.5)), i1 = Math.min(n - 1, Math.floor(Math.max(ax, bx, cx) * n - 0.5));
    const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) * n - 0.5)), j1 = Math.min(n - 1, Math.floor(Math.max(ay, by, cy) * n - 0.5));
    // regular positions of the three vertices
    const ra = a >> 1, rb = b >> 1, rc = c >> 1;
    const rax = (ra % m) / n, ray = ((ra / m) | 0) / n, rbx = (rb % m) / n, rby = ((rb / m) | 0) / n, rcx = (rc % m) / n, rcy = ((rc / m) | 0) / n;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = (i + 0.5) / n, py = (j + 0.5) / n;
      const w0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det, w1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det, w2 = 1 - w0 - w1;
      if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue;
      const k = 2 * (j * n + i); M[k] = w0 * rax + w1 * rbx + w2 * rcx; M[k + 1] = w0 * ray + w1 * rby + w2 * rcy;
    }
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = 2 * (j * m + i), b = a + 2, c = a + 2 * m + 2, d = a + 2 * m;
    if (cross(V, a, b, c) > 0 && cross(V, a, c, d) > 0) { tri(a, b, c); tri(a, c, d); } else { tri(a, b, d); tri(b, c, d); }
  }
  for (let k = 0; k < n * n; k++) if (Number.isNaN(M[2 * k])) { M[2 * k] = ((k % n) + 0.5) / n; M[2 * k + 1] = (((k / n) | 0) + 0.5) / n; }
  return M;
}

// ---------------------------------------------------------------- 2 + 3. normals and heights

/*
 * Optics, in the lens frame (mm): the surface is z = h(x, y) over the square [-S/2, S/2]^2. Light arrives travelling
 * +z. Modes:
 *   'glass'  - inside a slab of index nin (flat face toward the light), out of the top surface into air, to a
 *              screen at z = D.
 *   'water'  - from air (nin = 1) into water (nout), to the pool floor D below (drawn the other way up).
 *   'mirror' - reflected back off the surface to a screen at z = -D (a wall beside the lamp).
 * `mag` is the size of the picture on the screen over the size of the lens.
 */
export const MODES = { glass: { nin: 1.49, nout: 1 }, water: { nin: 1, nout: 1.333 }, mirror: { nin: 1, nout: 1 } };

export function solveHeights(M, n, { mode = 'glass', S = 100, D = 1000, mag = 1, iters = 6, nin, nout, light = [0, 0, 1], lamp = null } = {}) {
  const o = MODES[mode]; nin = nin ?? o.nin; nout = nout ?? o.nout;
  const s = S / n, h = new Float64Array(n * n), gx = new Float64Array(n * n), gy = new Float64Array(n * n), rhs = new Float64Array(n * n);
  const solve = makePoisson(n), zs = mode === 'mirror' ? -D : D;
  // where the bare (flat) surface throws the middle of the beam: the picture is centred there
  const c = throwCentre({ mode, D, nin, nout, light, lamp });
  for (let it = 0; it < iters; it++) {
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, px = ((i + 0.5) / n - 0.5) * S, py = ((j + 0.5) / n - 0.5) * S;
      const qx = c[0] + (M[2 * k] - 0.5) * S * mag, qy = c[1] + (M[2 * k + 1] - 0.5) * S * mag;
      let ox = qx - px, oy = qy - py, oz = zs - h[k]; const l = Math.hypot(ox, oy, oz); ox /= l; oy /= l; oz /= l;
      const I = incoming(mode, nin, light, lamp, px, py, h[k]);
      // normal: refraction nin*I - nout*O, reflection O - I, then turned to face +z
      let nx, ny, nz;
      if (mode === 'mirror') { nx = ox - I[0]; ny = oy - I[1]; nz = oz - I[2]; } else { nx = nin * I[0] - nout * ox; ny = nin * I[1] - nout * oy; nz = nin * I[2] - nout * oz; }
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
      gx[k] = -nx / nz; gy[k] = -ny / nz;
    }
    // least squares over the interior faces: lap(h) = div(g), the outer faces carrying nothing
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i; let d = 0;
      if (i < n - 1) d += 0.5 * (gx[k] + gx[k + 1]); if (i > 0) d -= 0.5 * (gx[k] + gx[k - 1]);
      if (j < n - 1) d += 0.5 * (gy[k] + gy[k + n]); if (j > 0) d -= 0.5 * (gy[k] + gy[k - n]);
      rhs[k] = d * s;
    }
    solve(rhs, h);
  }
  let lo = Infinity, hi = -Infinity; for (const v of h) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let k = 0; k < n * n; k++) h[k] -= lo;
  return { h, relief: hi - lo, centre: c };
}

// The direction light travels at a surface point, in the medium just before the surface (inside the glass for 'glass').
function incoming(mode, nin, light, lamp, px, py, pz) {
  let I = lamp ? [px - lamp[0], py - lamp[1], pz - lamp[2]] : light.slice();
  const l = Math.hypot(...I); I = I.map((v) => v / l);
  if (mode === 'glass') I = refract(I[0], I[1], I[2], 0, 0, -1, 1 / nin); // through the flat face
  return I;
}

// Where light through the middle of a flat surface lands on the screen.
export function throwCentre({ mode = 'glass', D = 1000, nin, nout, light = [0, 0, 1], lamp = null } = {}) {
  const o = MODES[mode]; nin = nin ?? o.nin; nout = nout ?? o.nout;
  const I = incoming(mode, nin, light, lamp, 0, 0, 0);
  const O = mode === 'mirror' ? [I[0], I[1], -I[2]] : refract(I[0], I[1], I[2], 0, 0, -1, nin / nout);
  const t = (mode === 'mirror' ? -D : D) / O[2];
  return [O[0] * t, O[1] * t];
}

// Everything, from a picture to a surface.
export function design(lum, n, opts = {}) {
  const tr = transport(targetAreas(lum, n, opts.floor ?? 0.05), n, opts);
  const M = resampleMap(tr.V, n);
  const { h, relief, centre } = solveHeights(M, n, opts);
  return { h, relief, centre, iters: tr.iters, err: tr.err, V: tr.V };
}

// ---------------------------------------------------------------- forward check (the same optics the shader runs)

function refract(ix, iy, iz, nx, ny, nz, eta) { // GLSL refract: n faces against i
  const d = nx * ix + ny * iy + nz * iz, k = 1 - eta * eta * (1 - d * d);
  if (k < 0) return null; const a = eta * d + Math.sqrt(k);
  return [eta * ix - a * nx, eta * iy - a * ny, eta * iz - a * nz];
}

// Traces the n x n lens points to the screen and splats each lens triangle's light over the screen pixels it
// covers (flux / screen area), the caustic as the shader draws it. Returns a W x W image, row 0 at the top,
// covering [-half, half]^2 mm, 1 = the brightness the bare beam would give.
export function render(h, n, { mode = 'glass', S = 100, D = 1000, W = 128, half = 50, centre = [0, 0], light = [0, 0, 1], lamp = null, nin, nout } = {}) {
  const o = MODES[mode]; nin = nin ?? o.nin; nout = nout ?? o.nout;
  const s = S / n, X = new Float64Array(n * n), Y = new Float64Array(n * n), ok = new Uint8Array(n * n);
  const H = (i, j) => h[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))];
  const zs = mode === 'mirror' ? -D : D;
  let lz = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, hx = (H(i + 1, j) - H(i - 1, j)) / ((i > 0 && i < n - 1 ? 2 : 1) * s), hy = (H(i, j + 1) - H(i, j - 1)) / ((j > 0 && j < n - 1 ? 2 : 1) * s);
    const nl = Math.hypot(hx, hy, 1), nx = -hx / nl, ny = -hy / nl, nz = 1 / nl;
    const px = ((i + 0.5) / n - 0.5) * S, py = ((j + 0.5) / n - 0.5) * S;
    const I = incoming(mode, nin, light, lamp, px, py, h[k]); if (!I) continue;
    let O;
    if (mode === 'mirror') { const d = I[0] * nx + I[1] * ny + I[2] * nz; O = [I[0] - 2 * d * nx, I[1] - 2 * d * ny, I[2] - 2 * d * nz]; }
    else O = refract(I[0], I[1], I[2], -nx, -ny, -nz, nin / nout);
    if (!O) continue;
    const t = (zs - h[k]) / O[2];
    if (!(t > 0)) continue;
    X[k] = px + O[0] * t - centre[0]; Y[k] = py + O[1] * t - centre[1]; ok[k] = 1;
  }
  { let I = lamp ? [-lamp[0], -lamp[1], -lamp[2]] : light; lz = Math.abs(I[2]) / Math.hypot(...I); }
  const img = new Float64Array(W * W), pix = (2 * half / W) ** 2, flux = s * s * 0.5 * lz;
  const splat = (a, b, c) => {
    if (!ok[a] || !ok[b] || !ok[c]) return;
    const ax = (X[a] + half) / (2 * half) * W, ay = (half - Y[a]) / (2 * half) * W, bx = (X[b] + half) / (2 * half) * W, by = (half - Y[b]) / (2 * half) * W;
    const cx = (X[c] + half) / (2 * half) * W, cy = (half - Y[c]) / (2 * half) * W;
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay), area = Math.abs(det) / 2; if (area < 1e-9) return;
    const v = flux / (area * pix);
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(W - 1, Math.ceil(Math.max(ay, by, cy)));
    // supersampled coverage, 4 x 4 per pixel
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      let cov = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const qx = x + (sx + 0.5) / 4, qy = y + (sy + 0.5) / 4;
        const w0 = ((bx - qx) * (cy - qy) - (cx - qx) * (by - qy)) / det, w1 = ((cx - qx) * (ay - qy) - (ax - qx) * (cy - qy)) / det;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) cov++;
      }
      if (cov) img[y * W + x] += v * cov / 16; // flux spread evenly over the triangle
    }
  };
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i; splat(a, a + 1, a + n + 1); splat(a, a + n + 1, a + n); }
  return img;
}

// Pearson correlation of two equal-length arrays.
export function correlation(a, b) {
  const N = a.length; let ma = 0, mb = 0; for (let i = 0; i < N; i++) { ma += a[i]; mb += b[i]; } ma /= N; mb /= N;
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < N; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return sab / Math.sqrt(saa * sbb);
}

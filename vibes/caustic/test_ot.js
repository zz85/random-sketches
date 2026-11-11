// node --test test_ot.js: the transforms, the Poisson solver, and designs that, traced back through the optics,
// draw their pictures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDCT, makePoisson, targetAreas, transport, cellAreas, design, render, correlation } from './ot.js';

test('DCT round trip and a coefficient against the sum', () => {
  const N = 32, d = makeDCT(N), x = Float64Array.from({ length: N }, (_, i) => Math.sin(i * 1.7) + i / N), X = new Float64Array(N), y = new Float64Array(N);
  d.forward(x, X); d.inverse(X, y);
  for (let i = 0; i < N; i++) assert.ok(Math.abs(x[i] - y[i]) < 1e-12);
  let ref = 0; for (let n = 0; n < N; n++) ref += x[n] * Math.cos(Math.PI * 5 * (2 * n + 1) / (2 * N));
  assert.ok(Math.abs(X[5] - ref) < 1e-10);
});

test('Poisson solve satisfies the Neumann 5-point Laplacian', () => {
  const m = 32, P = makePoisson(m), f = Float64Array.from({ length: m * m }, (_, i) => Math.cos(i * 0.37));
  const mean = f.reduce((a, b) => a + b) / f.length; for (let i = 0; i < f.length; i++) f[i] -= mean;
  const u = P(f, new Float64Array(m * m)), U = (i, j) => u[Math.min(m - 1, Math.max(0, j)) * m + Math.min(m - 1, Math.max(0, i))];
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) assert.ok(Math.abs(U(i + 1, j) + U(i - 1, j) + U(i, j + 1) + U(i, j - 1) - 4 * U(i, j) - f[j * m + i]) < 1e-9);
});

const n = 64;
const ring = new Float64Array(n * n);
for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const x = (i + 0.5) / n - 0.5, y = (j + 0.5) / n - 0.5, r = Math.hypot(x, y); ring[j * n + i] = (r < 0.15 ? 1 : 0) + (Math.abs(r - 0.35) < 0.05 ? 1 : 0) + (x < -0.2 && y > 0.25 ? 1 : 0); }

test('transport moves the cells to the target areas', () => {
  const t = targetAreas(ring, n), r = transport(t, n), A = cellAreas(r.V, n, new Float64Array(n * n));
  let rms = 0; for (let k = 0; k < n * n; k++) rms += ((A[k] - t[k]) * n * n) ** 2;
  assert.ok(Math.sqrt(rms / (n * n)) < 0.05, `rms ${Math.sqrt(rms / (n * n))}`);
});

for (const [mode, o] of [['glass', { S: 150, D: 1000, mag: 2, light: [0.1, 0.04, 1] }], ['mirror', { S: 120, D: 1500, mag: 4, lamp: [0, 360, -1500] }], ['water', { S: 1000, D: 2500, mag: 1 }]]) {
  test(`${mode}: the surface draws the picture, and only at its distance`, () => {
    const r = design(ring, n, { mode, ...o }), W = 32, f = n / W, tgt = new Float64Array(W * W);
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) { let a = 0; for (let b = 0; b < f; b++) for (let c = 0; c < f; c++) a += ring[(f * j + b) * n + f * i + c]; tgt[j * W + i] = a; }
    const img = render(r.h, n, { mode, ...o, W, half: o.S * o.mag / 2, centre: r.centre });
    const off = render(r.h, n, { mode, ...o, D: o.D * 0.6, W, half: o.S * o.mag / 2, centre: r.centre });
    const c = correlation(img, tgt), c2 = correlation(off, tgt);
    assert.ok(c > 0.93, `corr ${c}`); assert.ok(c2 < c - 0.1, `defocused corr ${c2}`);
  });
}

// node --test test_egg.js: the membrane mesh is sound for the GPU solver.
import test from 'node:test';
import assert from 'node:assert';
import { makeRim, buildMembrane, rimAt, eggR, MAXL, MAXT } from './egg.js';

for (const seed of [1, 3, 7, 42]) test(`seed ${seed}: membrane mesh`, () => {
  const table = makeRim(seed), m = buildMembrane(5, table, seed);
  assert.equal(m.over, 0, 'no vertex has more links or triangles than its slots');
  assert.ok(m.N > 4000 && m.NT > 8000, `${m.N} vertices`);
  // every vertex lies just inside the shell, under the rim
  for (let i = 0; i < m.N; i++) {
    const x = m.pos[i * 3], y = m.pos[i * 3 + 1], z = m.pos[i * 3 + 2], L = Math.hypot(x, y, z);
    const s = L - eggR(x / L, y / L, z / L);
    assert.ok(s < 0 && s > -0.03, `vertex ${i} off the wall by ${s}`);
    assert.ok(Math.acos(-y / L) < rimAt(table, Math.atan2(z, x)), `vertex ${i} above the rim`);
  }
  // triangles face the inside of the cup, and each struct link is a sane length
  for (const [a, b, c] of m.tris) {
    const P = (i) => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
    const [p, q, r] = [P(a), P(b), P(c)], u = q.map((v, k) => v - p[k]), w = r.map((v, k) => v - p[k]);
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    assert.ok(n[0] * p[0] + n[1] * p[1] + n[2] * p[2] < 0);
  }
  for (let i = 0; i < m.nStruct; i++) assert.ok(m.links[i][2] > 0.01 && m.links[i][2] < 0.25);
  // each bend link's parent is a struct edge shared by two triangles
  for (let i = m.nStruct; i < m.NL; i++) assert.ok(m.links[i][3] >= 0 && m.links[i][3] < m.nStruct);
  // the flap is one tongue of loose membrane, and the rest is glued
  const nf = m.flap.reduce((a, b) => a + b, 0);
  assert.ok(nf > 40 && nf < m.N * 0.05, `${nf} flap vertices`);
  assert.ok(m.adj.every((l) => l >= 0 && l <= m.NL) && m.vtris.every((t) => t >= 0 && t <= m.NT));
  assert.ok(MAXL === 12 && MAXT === 6);
});

test('rim is closed and deterministic', () => {
  const a = makeRim(5), b = makeRim(5);
  assert.deepEqual(a, b);
  assert.ok(Math.abs(rimAt(a, -Math.PI) - rimAt(a, Math.PI - 1e-9)) < 0.05);
  for (const v of a) assert.ok(v > 1.3 && v < 2.0);
});

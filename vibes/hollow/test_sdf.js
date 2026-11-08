// node --test test_sdf.js : the mesher's winding, closure and normals, and that generated pieces
// mesh to one solid that stands on its foot.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMesh, makeSculpture, compile, FOOT } from './sdf.js';

const facing = (m) => {
  // share of triangles whose geometric normal agrees with the SDF normal at their vertices
  const P = m.position, Nn = m.normal, I = m.index; let ok = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * (Nn[a] + Nn[b] + Nn[c]) + ny * (Nn[a + 1] + Nn[b + 1] + Nn[c + 1]) + nz * (Nn[a + 2] + Nn[b + 2] + Nn[c + 2]) > 0) ok++;
  }
  return ok / (I.length / 3);
};
const boundaryEdges = (m) => {
  const E = new Map(), I = m.index;
  for (let t = 0; t < I.length; t += 3) for (let e = 0; e < 3; e++) { const a = I[t + e], b = I[t + (e + 1) % 3], k = a < b ? a + ',' + b : b + ',' + a; E.set(k, (E.get(k) || 0) + 1); }
  let open = 0; for (const n of E.values()) if (n !== 2) open++; return open;
};

test('a ball meshes closed, wound outward, on its surface', () => {
  const spec = { base: { kind: 'pebble', rx: 0.7, ry: 0.7, rz: 0.7, egg: 0, cy: 0.1 }, footK: 0, shell: 0, cuts: [] };
  const m = buildMesh(spec, 48);
  assert.ok(m.index.length > 1000);
  assert.ok(facing(m) > 0.99, 'winding ' + facing(m));
  assert.equal(boundaryEdges(m), 0);
  const f = compile(spec); let worst = 0;
  for (let i = 0; i < m.position.length; i += 3) worst = Math.max(worst, Math.abs(f(m.position[i], m.position[i + 1], m.position[i + 2])));
  assert.ok(worst < 2e-3, 'off surface by ' + worst);
});

test('a shell with a tunnel is one closed piece, its inside darker', () => {
  const spec = { base: { kind: 'pebble', rx: 0.8, ry: 0.9, rz: 0.7, egg: 0, cy: 0 }, footK: 0.05, shell: 0.12,
    cuts: [{ kind: 'tunnel', a: [-2, 0.1, 0], m: [0, 0.1, 0], b: [2, 0.1, 0], ra: 0.3, rm: 0.25, rb: 0.3, k: 0.1 }] };
  const m = buildMesh(spec, 72);
  assert.ok(facing(m) > 0.99);
  assert.equal(boundaryEdges(m), 0);
  // vertices near the centre are the inner wall
  let ai = 0, ni = 0, ao = 0, no = 0;
  // the inner wall faces the centre
  for (let i = 0; i < m.ao.length; i++) { const P = m.position, n = m.normal, d = P[i * 3] * n[i * 3] + P[i * 3 + 1] * n[i * 3 + 1] + P[i * 3 + 2] * n[i * 3 + 2]; if (d < -0.2) { ai += m.ao[i]; ni++; } else if (d > 0.3) { ao += m.ao[i]; no++; } }
  assert.ok(ni > 50 && ai / ni < ao / no - 0.15, `inner ${ai / ni} outer ${ao / no}`);
});

test('generated pieces: one piece, wound right, standing on the foot', () => {
  const kinds = new Set();
  for (let seed = 1; seed <= 24; seed++) {
    const spec = makeSculpture(seed); kinds.add(spec.base.kind);
    const m = buildMesh(spec, 96, { vis: false }); // the app meshes at 104 to 152
    assert.ok(m.index.length > 3000, `seed ${seed} ${spec.title}: ${m.index.length / 3} tris`);
    assert.ok(facing(m) > 0.98, `seed ${seed}: winding ${facing(m)}`);
    assert.ok(Math.abs(m.minY - FOOT) < 0.03, `seed ${seed}: foot at ${m.minY}`);
    assert.ok(m.footRadius > 0.08, `seed ${seed}: foot radius ${m.footRadius}`);
    assert.ok(m.maxY > 0.2, `seed ${seed}: height ${m.maxY}`);
  }
  assert.ok(kinds.size >= 4, [...kinds].join());
});

test('the same seed makes the same piece', () => {
  assert.deepEqual(makeSculpture(77), makeSculpture(77));
  assert.notDeepEqual(makeSculpture(77), makeSculpture(78));
});

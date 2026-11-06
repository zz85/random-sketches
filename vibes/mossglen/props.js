// Everything moss grows on besides the ground: a recumbent stone circle on the knoll, glacial
// boulders, stones in the burn, a fallen log and old Atlantic oaks with roots over the ground.
// Each part is plain world-space arrays (pos, nor, idx) with a `kind`: 1 stone, 2 bark.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { heightAt, streamDist, streamHalfWidth, streamZ, fbm3, noise3, mulberry32 } from './world.js';

const v3 = () => new THREE.Vector3();

// A stone: intersect random fracture planes (smoothly bevelled), stretch to size, erode with
// noise. `box` > 0 squares it off into a slab.
function stone(rnd, { detail, size, rot, at, sink = 0.2, planes = 11, bevel = 0.18, rough = 0.06, box = 0 }) {
  let g = new THREE.IcosahedronGeometry(1, detail); g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g);
  const P = [];
  for (let i = 0; i < planes; i++) {
    const n = new THREE.Vector3(rnd() * 2 - 1, (rnd() * 2 - 1) * 0.8, rnd() * 2 - 1).normalize();
    P.push([n, 0.78 + rnd() * 0.22]);
  }
  if (box) for (const n of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) P.push([new THREE.Vector3(...n).add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.25)).normalize(), 0.72 + rnd() * 0.1]);
  const seed = rnd() * 100, p = g.attributes.position, d = v3(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot));
  for (let i = 0; i < p.count; i++) {
    d.fromBufferAttribute(p, i).normalize();
    let r = 1.6;
    for (const [n, o] of P) {
      const f = d.dot(n); if (f <= 0) continue;
      const a = r, b = o / f, h = Math.max(bevel - Math.abs(a - b), 0) / bevel;
      r = Math.min(a, b) - h * h * bevel * 0.25;
    }
    const x = d.x * size[0], y = d.y * size[1], z = d.z * size[2];
    r += (fbm3(x * 1.8 + seed, y * 1.8, z * 1.8, 4) - 0.5) * rough * 4 + (noise3(x * 7 + seed, y * 7, z * 7) - 0.5) * rough * 0.5;
    d.multiplyScalar(r); d.x *= size[0]; d.y *= size[1]; d.z *= size[2];
    d.applyQuaternion(q);
    p.setXYZ(i, d.x, d.y, d.z);
  }
  g.computeBoundingBox();
  const base = heightAt(at[0], at[1]);
  const dy = base - g.boundingBox.min.y - (g.boundingBox.max.y - g.boundingBox.min.y) * sink;
  g.translate(at[0], dy, at[1]);
  g.computeVertexNormals();
  return { pos: Float32Array.from(p.array), nor: Float32Array.from(g.attributes.normal.array), idx: Uint32Array.from(g.index.array), kind: 1 };
}

// Tube along a polyline with parallel-transported rings; radius per point.
function tube(T, pts, rad, M, cap = false) {
  const base = T.pos.length / 3, t = v3(), n = v3(), b = v3(), prevT = v3(), tmp = v3();
  for (let k = 0; k < pts.length; k++) {
    const a = pts[Math.max(0, k - 1)], c = pts[Math.min(pts.length - 1, k + 1)];
    t.subVectors(c, a).normalize();
    if (k === 0) { n.set(0, 1, 0); if (Math.abs(t.y) > 0.9) n.set(1, 0, 0); n.addScaledVector(t, -n.dot(t)).normalize(); }
    else { const ax = tmp.crossVectors(prevT, t), s = ax.length(); if (s > 1e-6) { const ang = Math.asin(Math.min(1, s)); n.applyAxisAngle(ax.normalize(), ang); } n.addScaledVector(t, -n.dot(t)).normalize(); }
    prevT.copy(t); b.crossVectors(t, n);
    for (let j = 0; j < M; j++) {
      const ang = j / M * Math.PI * 2, cs = Math.cos(ang), sn = Math.sin(ang);
      const r = rad[k] * (1 + (noise3(pts[k].x * 3 + j, pts[k].y * 3, pts[k].z * 3) - 0.5) * 0.25);
      const nx = n.x * cs + b.x * sn, ny = n.y * cs + b.y * sn, nz = n.z * cs + b.z * sn;
      T.pos.push(pts[k].x + nx * r, pts[k].y + ny * r, pts[k].z + nz * r); T.nor.push(nx, ny, nz);
    }
  }
  for (let k = 0; k < pts.length - 1; k++) for (let j = 0; j < M; j++) {
    const a = base + k * M + j, b2 = base + k * M + (j + 1) % M, c = a + M, d = b2 + M;
    T.idx.push(a, c, b2, b2, c, d);
  }
  if (cap) for (const [k, s] of [[0, -1], [pts.length - 1, 1]]) {
    const c = T.pos.length / 3, d = v3().subVectors(pts[Math.min(pts.length - 1, k + 1)], pts[Math.max(0, k - 1)]).normalize().multiplyScalar(s);
    T.pos.push(pts[k].x + d.x * rad[k] * 0.15, pts[k].y + d.y * rad[k] * 0.15, pts[k].z + d.z * rad[k] * 0.15); T.nor.push(d.x, d.y, d.z);
    for (let j = 0; j < M; j++) { const a = base + k * M + j, b2 = base + k * M + (j + 1) % M; if (s < 0) T.idx.push(c, a, b2); else T.idx.push(c, b2, a); }
  }
}
const part = (T, kind) => ({ pos: Float32Array.from(T.pos), nor: Float32Array.from(T.nor), idx: Uint32Array.from(T.idx), kind });

// An old oak: a short twisting bole that splits low, branches that wander and droop at the
// ends, buttress roots running over the ground. Returns the bark part and leaf cluster spots.
function oak(rnd, x, z, Q) {
  const T = { pos: [], nor: [], idx: [] }, leaves = [];
  const y0 = heightAt(x, z) - 0.25;
  const grow = (p, d, L, r0, depth) => {
    const n = Math.max(3, Math.round(L / (depth ? 0.45 : 0.35))), pts = [p.clone()], rad = [r0];
    const dir = d.clone(), cur = p.clone();
    for (let i = 1; i <= n; i++) {
      dir.x += (rnd() - 0.5) * 0.45; dir.z += (rnd() - 0.5) * 0.45; dir.y += (rnd() - 0.5) * 0.25 + (depth >= 2 ? -0.06 : 0.05);
      dir.normalize(); cur.addScaledVector(dir, L / n); pts.push(cur.clone());
      const t = i / n; let r = r0 * (1 - 0.62 * t);
      if (depth === 0) r *= 1 + 0.9 * Math.exp(-(cur.y - y0) / 0.4);
      rad.push(r);
    }
    if (depth === 0) rad[0] *= 1.9;
    tube(T, pts, rad, depth === 0 ? Q.trunkM : depth === 1 ? Q.trunkM - 1 : Q.branchM, depth >= Q.depth);
    if (depth >= Q.depth) { leaves.push({ p: cur.clone(), s: 1.5 + rnd() * 0.6 }); return; }
    const kids = depth === 0 ? 3 : 2 + (rnd() < 0.5 ? 1 : 0);
    for (let c = 0; c < kids; c++) {
      const t = c === kids - 1 ? 1 : 0.45 + rnd() * 0.45, k = Math.min(pts.length - 1, Math.round(t * (pts.length - 1)));
      const a = c / kids * Math.PI * 2 + rnd() * 1.2, spread = depth === 0 ? 1.1 : 0.7 + rnd() * 0.5;
      const nd = new THREE.Vector3(Math.cos(a) * spread, depth === 0 ? 0.75 : 0.45 + rnd() * 0.3, Math.sin(a) * spread).add(dir.clone().multiplyScalar(0.6)).normalize();
      grow(pts[k], nd, L * (depth === 0 ? 1.25 : 0.72) * (0.8 + rnd() * 0.4), rad[k] * 0.72, depth + 1);
      if (depth >= 1 && rnd() < 0.7) leaves.push({ p: pts[k].clone().add(new THREE.Vector3(rnd() - 0.5, 0.3, rnd() - 0.5)), s: 1.2 + rnd() * 0.5 });
    }
  };
  const r0 = 0.42 + rnd() * 0.2;
  grow(new THREE.Vector3(x, y0, z), new THREE.Vector3((rnd() - 0.5) * 0.4, 1, (rnd() - 0.5) * 0.4).normalize(), 2.0 + rnd() * 0.9, r0, 0);
  // buttress roots: up from inside the bole, out over the ground, then down into it
  const roots = 4 + Math.floor(rnd() * 3);
  for (let i = 0; i < roots; i++) {
    const a = i / roots * Math.PI * 2 + rnd() * 0.6, L = 1.4 + rnd() * 1.4, pts = [], rad = [], S = 7;
    for (let k = 0; k <= S; k++) {
      const t = k / S, px = x + Math.cos(a + t * 0.4 * (rnd() - 0.5)) * (0.1 + t * L), pz = z + Math.sin(a) * (0.1 + t * L);
      const r = r0 * (0.75 - 0.6 * t);
      pts.push(new THREE.Vector3(px, heightAt(px, pz) + r * (0.55 - 0.9 * t * t) + (1 - t) * 0.35, pz)); rad.push(r);
    }
    tube(T, pts, rad, Q.branchM + 1, true);
  }
  return { bark: part(T, 2), leaves, at: [x, z] };
}

// A fallen oak bough on the bank, broken at both ends, half sunk in the ground.
function log(rnd, a, b, r0, M) {
  const T = { pos: [], nor: [], idx: [] }, pts = [], rad = [], S = 16;
  for (let k = 0; k <= S; k++) {
    const t = k / S, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t + Math.sin(t * 3.0) * 0.25;
    const r = r0 * (1 - 0.25 * t) * (1 + (k === 0 || k === S ? -0.2 : 0));
    pts.push(new THREE.Vector3(x, heightAt(x, z) + r * 0.55, z)); rad.push(r);
  }
  tube(T, pts, rad, M, true);
  const p = pts[6];
  tube(T, [p, p.clone().add(new THREE.Vector3(0.1, 0.5, 0.25)), p.clone().add(new THREE.Vector3(0.15, 0.8, 0.45))], [r0 * 0.35, r0 * 0.25, r0 * 0.15], Math.max(5, M - 3), true);
  return part(T, 2);
}

export function buildProps(Q, seed = 5) {
  const rnd = mulberry32(seed), parts = [], rocks = [];
  const add = (p, name, info) => { parts.push({ ...p, name }); if (info) rocks.push(info); return p; };
  // ---- the recumbent stone circle: a long recumbent stone at the back between its two tall
  // flankers, the ring falling in height towards the front, one stone fallen
  const R = 6.2, N = 10;
  for (let i = 0; i < N; i++) {
    const a = -Math.PI / 2 + (i / N) * Math.PI * 2 + (rnd() - 0.5) * 0.12;
    const x = Math.cos(a) * R * (0.96 + rnd() * 0.08), z = Math.sin(a) * R * (0.96 + rnd() * 0.08);
    const front = 0.5 - 0.5 * Math.cos(a + Math.PI / 2);                    // 0 at the recumbent, 1 opposite it
    if (i === 0) {
      add(stone(rnd, { detail: Q.rockDetail + 1, size: [1.75, 0.68, 0.6], rot: [0.02, -a - Math.PI / 2, 0.03], at: [x, z], sink: 0.12, box: 1, bevel: 0.25 }), 'recumbent', { x, z, r: 1.8 });
      continue;
    }
    const flank = i === 1 || i === N - 1;
    const h = flank ? 1.35 : 1.05 - front * 0.45 + rnd() * 0.15, w = 0.42 + rnd() * 0.18, d = 0.26 + rnd() * 0.1;
    const fallen = i === 6;
    add(stone(rnd, {
      detail: Q.rockDetail, size: fallen ? [h, d, w] : [w, h, d], rot: [(rnd() - 0.5) * 0.12, -a + Math.PI / 2 + (rnd() - 0.5) * 0.3, (rnd() - 0.5) * (flank ? 0.05 : 0.18)],
      at: [x, z], sink: fallen ? 0.35 : 0.1, box: 1, bevel: 0.2, planes: 7,
    }), 'standing stone', { x, z, r: Math.max(w, d) + 0.2 });
  }
  // ---- boulders on the banks and in the woods
  const spots = [[2.6, 13.8, 0.75], [-3.2, 1.2, 0.55], [9.5, -4, 1.3], [-9, -2.5, 1.1], [-4.5, 14.5, 0.9], [13, 9, 1.2], [-15, 9.5, 1.6], [6, -12, 1.0], [-11, -14, 1.5], [18, -6, 1.4], [0.5, 16.8, 0.6], [7.5, 13.5, 0.85]];
  for (const [x, z, s] of spots) {
    const k = stone(rnd, { detail: Q.rockDetail, size: [s * (0.9 + rnd() * 0.4), s * (0.55 + rnd() * 0.3), s * (0.8 + rnd() * 0.3)], rot: [rnd() * 0.4, rnd() * 6.3, rnd() * 0.4], at: [x, z], sink: 0.25, rough: 0.07 });
    add(k, 'boulder', { x, z, r: s * 1.1 });
  }
  // ---- stones in the burn, mostly in the shallows near the camera
  for (let i = 0; i < Q.burnStones; i++) {
    const x = -14 + rnd() * 30, w = streamHalfWidth(x), z = streamZ(x) + (rnd() * 2 - 1) * w * 0.9, s = 0.2 + rnd() * 0.32;
    add(stone(rnd, { detail: Math.max(1, Q.rockDetail - 1), size: [s * 1.2, s * 0.6, s], rot: [0, rnd() * 6.3, 0], at: [x, z], sink: 0.3, rough: 0.04 }), 'stone in the burn', { x, z, r: s });
  }
  // ---- fallen bough on the near bank
  add(log(rnd, [-6.8, 13.0], [-2.2, 12.2], 0.36, Q.trunkM + 2), 'fallen bough', { x: -4.5, z: 12.6, r: 0.5 });
  // ---- oaks round the clearing
  const trees = [];
  const at = [[-10.5, -8.5], [11.5, -11], [-16, 3.5], [15.5, 2.5], [-5, -17], [4.5, -19.5], [19, 15], [-13, 16.5], [-21, -6], [23, -9]];
  for (const [x, z] of at.slice(0, Q.trees)) {
    if (streamDist(x, z) < 3.5) continue;
    const t = oak(rnd, x, z, Q); trees.push(t);
    add(t.bark, 'oak', null);
  }
  return { parts, rocks, trees };
}

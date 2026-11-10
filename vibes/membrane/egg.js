// egg.js - Membrane: the egg's shape, the cracked rim of the half shell, and the membrane mesh that lines it.
// Units are centimetres. The egg stands on its blunt end, long axis +y, centre at the origin.
// Everything here is plain JS (no three.js), so node tests can run it.

export const A = 2.1;      // equatorial radius of the shell's inner surface
export const B = 2.62;     // polar radius
export const KEGG = 0.075; // egg asymmetry: the top (pointed end) is longer than the bottom
export const THICK = 0.055; // shell thickness (about 0.55 mm, real ones are 0.3-0.4)
export const MOFF = 0.012; // the membrane's mid-surface sits this far inside the shell
export const RIM_N = 128;  // samples of the rim's height round the egg

// radius of the shell's inner surface in the unit direction d
export function eggR(dx, dy, dz) {
  const q = (dx * dx + dz * dz) / (A * A) + (dy * dy) / (B * B);
  return (1 + KEGG * dy) / Math.sqrt(q);
}

export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// The crack: polar angle from the bottom pole up to the rim, as a function of azimuth theta = atan2(z, x).
// Straight runs between random knots, so the edge reads as broken shell rather than a wave.
// The shard opposite the camera (theta = -pi/2) is kept tall: the loose flap of membrane hangs there.
export function makeRim(seed) {
  const r = rng(seed * 7919 + 13);
  const K = 17 + Math.floor(r() * 6);
  const knots = [];
  for (let k = 0; k < K; k++) {
    const th = -Math.PI + (2 * Math.PI * (k + 0.15 + 0.7 * r())) / K;
    let phi = 1.7 + (r() - 0.5) * 0.3;
    if (r() < 0.2) phi -= 0.12 + r() * 0.1; // a notch where a chip came out
    knots.push([th, phi]);
  }
  const table = new Float32Array(RIM_N);
  for (let i = 0; i < RIM_N; i++) {
    const th = -Math.PI + (2 * Math.PI * i) / RIM_N;
    const j = knots.findIndex((k) => k[0] > th);
    const a = knots[j <= 0 ? K - 1 : j - 1], b = knots[j < 0 ? 0 : j];
    let ta = a[0], tb = b[0];
    if (j === 0) ta -= 2 * Math.PI;
    if (j < 0) tb += 2 * Math.PI;
    const f = (th - ta) / (tb - ta);
    let phi = a[1] + (b[1] - a[1]) * f;
    // the flap's shard: a tall, broad tooth opposite the camera
    const dt = wrap(th + Math.PI / 2);
    phi = Math.max(phi, 1.86 - 0.5 * dt * dt);
    table[i] = phi;
  }
  return table;
}

export const wrap = (a) => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };

export function rimAt(table, th) {
  const u = ((th + Math.PI) / (2 * Math.PI)) * RIM_N;
  const i0 = Math.floor(u), f = u - i0;
  const a = table[((i0 % RIM_N) + RIM_N) % RIM_N], b = table[(i0 + 1) % RIM_N];
  return a + (b - a) * f;
}

const phiOf = (dy) => Math.acos(Math.max(-1, Math.min(1, -dy)));

// Is the point inside the shell's own material? Used by the CPU picker to stop rays at the shell.
export function inShell(table, x, y, z) {
  const L = Math.hypot(x, y, z); if (L < 1e-6) return false;
  const dx = x / L, dy = y / L, dz = z / L;
  const s = L - eggR(dx, dy, dz);
  return s > -0.005 && s < THICK + 0.005 && phiOf(dy) < rimAt(table, Math.atan2(dz, dx));
}

// The membrane: an icosphere warped onto the inside of the egg, jittered so tears don't follow
// straight lines, cut off just under the rim. Returns flat typed arrays ready for the GPU:
//   pos        vertex positions (= the anchors on the shell)
//   tris       vertex triples, wound to face the inside of the cup
//   links      struct edges first, then bend links across each pair of triangles: [a, b, rest, parentEdge]
//   adj        MAXL link slots per vertex, padded with the dummy link (index nLinks)
//   vtris      MAXT triangle slots per vertex, padded with the dummy triangle (index nTris)
//   triEdges   the three struct edges of each triangle
//   flap       1 where the membrane starts loose (the tongue at the tall shard)
export const MAXL = 12, MAXT = 6;

export function buildMembrane(level, table, seed = 1) {
  // icosahedron
  const t = (1 + Math.sqrt(5)) / 2;
  let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((p) => { const l = Math.hypot(...p); return p.map((c) => c / l); });
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let l = 0; l < level; l++) {
    const mid = new Map(), F2 = [];
    const m = (a, b) => {
      const k = a < b ? a * 1e7 + b : b * 1e7 + a;
      let i = mid.get(k);
      if (i === undefined) { const p = V[a].map((c, j) => c + V[b][j]); const n = Math.hypot(...p); i = V.length; V.push(p.map((c) => c / n)); mid.set(k, i); }
      return i;
    };
    for (const [a, b, c] of F) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); F2.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    F = F2;
  }
  // tangential jitter, a quarter of an edge
  const r = rng(seed * 104729 + 7);
  const edgeAng = 1.1071 / (1 << level);
  for (const p of V) {
    let ux = -p[1], uy = p[0], uz = 0; if (Math.abs(p[2]) < 0.9) { ux = -p[1]; uy = p[0]; uz = 0; } else { ux = 0; uy = -p[2]; uz = p[1]; }
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const vx = p[1] * uz - p[2] * uy, vy = p[2] * ux - p[0] * uz, vz = p[0] * uy - p[1] * ux;
    const a = r() * 2 * Math.PI, s = Math.sqrt(r()) * 0.28 * edgeAng;
    p[0] += (Math.cos(a) * ux + Math.sin(a) * vx) * s; p[1] += (Math.cos(a) * uy + Math.sin(a) * vy) * s; p[2] += (Math.cos(a) * uz + Math.sin(a) * vz) * s;
    const n = Math.hypot(...p); p[0] /= n; p[1] /= n; p[2] /= n;
  }
  // keep what lies under the rim
  const keep = new Int32Array(V.length).fill(-1);
  const kept = [];
  V.forEach((p, i) => { if (phiOf(p[1]) < rimAt(table, Math.atan2(p[2], p[0])) - 0.015) { keep[i] = kept.length; kept.push(p); } });
  const tris = [];
  for (const [a, b, c] of F) if (keep[a] >= 0 && keep[b] >= 0 && keep[c] >= 0) tris.push([keep[a], keep[b], keep[c]]);
  const N = kept.length, NT = tris.length;
  const pos = new Float32Array(N * 3);
  kept.forEach((d, i) => { const R = eggR(d[0], d[1], d[2]) - MOFF; pos[i * 3] = d[0] * R; pos[i * 3 + 1] = d[1] * R; pos[i * 3 + 2] = d[2] * R; });
  const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  // wind every triangle to face the centre (the inside of the cup)
  for (const tr of tris) {
    const [a, b, c] = tr.map(P);
    const n = cross(sub(b, a), sub(c, a));
    if (dot(n, a) > 0) { const s = tr[1]; tr[1] = tr[2]; tr[2] = s; }
  }
  // struct edges
  const eMap = new Map(), edges = [], eTris = [];
  const triEdges = new Int32Array(NT * 3);
  tris.forEach((tr, ti) => {
    for (let k = 0; k < 3; k++) {
      const a = tr[k], b = tr[(k + 1) % 3], key = a < b ? a * 1e7 + b : b * 1e7 + a;
      let e = eMap.get(key);
      if (e === undefined) { e = edges.length; edges.push([a, b]); eTris.push([]); eMap.set(key, e); }
      eTris[e].push([ti, tr[(k + 2) % 3]]);
      triEdges[ti * 3 + k] = e;
    }
  });
  const len = (a, b) => Math.hypot(pos[a * 3] - pos[b * 3], pos[a * 3 + 1] - pos[b * 3 + 1], pos[a * 3 + 2] - pos[b * 3 + 2]);
  const links = [];
  edges.forEach(([a, b]) => links.push([a, b, len(a, b), -1]));
  edges.forEach(([a, b], e) => { if (eTris[e].length === 2) { const c = eTris[e][0][1], d = eTris[e][1][1]; links.push([c, d, len(c, d), e]); } });
  const NL = links.length;
  const adj = new Int32Array(N * MAXL).fill(NL), deg = new Uint8Array(N);
  let over = 0;
  links.forEach(([a, b], li) => { for (const v of [a, b]) { if (deg[v] < MAXL) adj[v * MAXL + deg[v]++] = li; else over++; } });
  const vtris = new Int32Array(N * MAXT).fill(NT), tdeg = new Uint8Array(N);
  tris.forEach((tr, ti) => { for (const v of tr) { if (tdeg[v] < MAXT) vtris[v * MAXT + tdeg[v]++] = ti; else over++; } });
  // the loose tongue at the tall shard, theta = -pi/2: it starts unglued
  const flap = new Uint8Array(N);
  const start = new Float32Array(pos);
  for (let i = 0; i < N; i++) {
    const [x, y, z] = P(i), L = Math.hypot(x, y, z), th = Math.atan2(z, x);
    const depth = rimAt(table, th) - phiOf(y / L), dth = wrap(th + Math.PI / 2);
    const w = 0.24 - 0.9 * dth * dth; // the tongue narrows toward its root
    if (depth < w) {
      flap[i] = 1;
      // lifted off the wall a hair, so it is free to fall away from the shell where the shell leans in
      const lift = (w - depth) / 0.24, s = 1 - 0.01 * lift;
      start[i * 3] = x * s; start[i * 3 + 1] = y * s; start[i * 3 + 2] = z * s;
    }
  }
  const restArea = new Float32Array(NT);
  tris.forEach(([a, b, c], ti) => { const n = cross(sub(P(b), P(a)), sub(P(c), P(a))); restArea[ti] = 0.5 * Math.hypot(...n); });
  // depth below the rim, for the weaker grip of the membrane near the crack
  const depth = new Float32Array(N);
  for (let i = 0; i < N; i++) { const [x, y, z] = P(i); depth[i] = rimAt(table, Math.atan2(z, x)) - phiOf(y / Math.hypot(x, y, z)); }
  let sumE = 0; for (let e = 0; e < edges.length; e++) sumE += links[e][2];
  return { N, NT, NL, nStruct: edges.length, pos, start, tris, links, adj, vtris, triEdges, restArea, flap, depth, over, edge: sumE / edges.length };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ---------- the yolk (yolk.js): an icosphere, subdivided `level` times: vertices, triangles, links (edges, then bend links across each edge),
// and for each vertex the links and triangles round it
export const YMAXL = 12, YMAXT = 6;
export const YR = 1.45; // cm: a yolk about 29 mm across
export function buildYolk(level = 4, r = YR) {
  const t = (1 + Math.sqrt(5)) / 2;
  let V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  let F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  V = V.map(norm);
  for (let s = 0; s < level; s++) {
    const mid = new Map(), NF = [];
    const m = (a, b) => { const k = a < b ? a * 1e6 + b : b * 1e6 + a; if (!mid.has(k)) { mid.set(k, V.length); V.push(norm([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2, (V[a][2] + V[b][2]) / 2])); } return mid.get(k); };
    for (const [a, b, c] of F) { const ab = m(a, b), bc = m(b, c), ca = m(c, a); NF.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    F = NF;
  }
  const N = V.length, NT = F.length;
  const pos = new Float32Array(N * 3); V.forEach((v, i) => { pos[i * 3] = v[0] * r; pos[i * 3 + 1] = v[1] * r; pos[i * 3 + 2] = v[2] * r; });
  const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]], dist = (a, b) => Math.hypot(...P(a).map((x, k) => x - P(b)[k]));
  // edges and the two triangles' far corners across each
  const edge = new Map(), links = [], triEdges = new Int32Array(NT * 3), opp = [];
  F.forEach((f, ti) => {
    for (let k = 0; k < 3; k++) {
      const a = f[k], b = f[(k + 1) % 3], c = f[(k + 2) % 3], key = a < b ? a * 1e6 + b : b * 1e6 + a;
      if (!edge.has(key)) { edge.set(key, links.length); links.push([a, b, dist(a, b), -1]); opp.push([c]); } else opp[edge.get(key)].push(c);
      triEdges[ti * 3 + k] = edge.get(key);
    }
  });
  const nStruct = links.length;
  for (let e = 0; e < nStruct; e++) if (opp[e].length === 2) links.push([opp[e][0], opp[e][1], dist(opp[e][0], opp[e][1]), e]);
  const NL = links.length;
  const adj = new Int32Array(N * YMAXL).fill(NL), na = new Int32Array(N);
  links.forEach(([a, b], li) => { for (const v of [a, b]) { if (na[v] >= YMAXL) throw new Error('valence'); adj[v * YMAXL + na[v]++] = li; } });
  const vtris = new Int32Array(N * YMAXT).fill(NT), nt = new Int32Array(N);
  F.forEach((f, ti) => { for (const v of f) { if (nt[v] >= YMAXT) throw new Error('tri valence'); vtris[v * YMAXT + nt[v]++] = ti; } });
  const restArea = F.map(([a, b, c]) => { const p = P(a), q = P(b), s = P(c), u = q.map((x, k) => x - p[k]), w = s.map((x, k) => x - p[k]); return 0.5 * Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]); });
  let volume = 0;
  for (const [a, b, c] of F) { const p = P(a), q = P(b), w = P(c); volume += (p[0] * (q[1] * w[2] - q[2] * w[1]) + p[1] * (q[2] * w[0] - q[0] * w[2]) + p[2] * (q[0] * w[1] - q[1] * w[0])) / 6; }
  return { N, NT, NL, nStruct, pos, tris: F, links, adj, vtris, triEdges, restArea, edge: links[0][2], volume, r };
}


// sdf.js - the sculptures as signed distance fields, and the mesher that turns one into a
// smooth triangle mesh. Plain JS with no three.js, so it runs in a worker and in node.
//
// A piece is a seeded spec: a base form (pebble, turned vessel, twisted totem, ring, a cluster
// of lobes), a flat foot so it stands, optionally a shell (the inside carved away), then cutters
// taken out with a smooth subtraction so every cut edge is a rounded fillet, the way a carver
// sands an opening: bent tunnels, scoops, a mouth, grooves, a pierced lattice. The spec is plain
// data (posted to the worker); compile() turns it into f(x, y, z), negative inside.
//
// Unit space: the piece stands on y = FOOT and reaches to about y = 1, inside the box
// [-BOUND, BOUND]^3. main.js scales it to metres.

export const BOUND = 1.25;
export const FOOT = -0.92;

export function rng(seed) {
  let a = seed >>> 0 || 1;
  const r = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  r.chance = (p) => r() < p;
  return r;
}

// ---- smooth operators (iq) ----
const smin = (a, b, k) => { if (k <= 0) return Math.min(a, b); const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
const smax = (a, b, k) => -smin(-a, -b, k);

// ---- primitives ----
function ellipsoid(x, y, z, rx, ry, rz) {
  const k0 = Math.hypot(x / rx, y / ry, z / rz), k1 = Math.hypot(x / (rx * rx), y / (ry * ry), z / (rz * rz));
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}
function roundBox(x, y, z, bx, by, bz, r) {
  const qx = Math.abs(x) - bx + r, qy = Math.abs(y) - by + r, qz = Math.abs(z) - bz + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r;
}
// round cone between a (radius r1) and b (radius r2) - iq's sdRoundCone (arbitrary endpoints)
function roundCone(px, py, pz, a, b, r1, r2) {
  const bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const l2 = bax * bax + bay * bay + baz * baz, rr = r1 - r2, a2 = l2 - rr * rr, il2 = 1 / l2;
  const pax = px - a[0], pay = py - a[1], paz = pz - a[2];
  const y = pax * bax + pay * bay + paz * baz, z = y - l2;
  const xx = pax * l2 - bax * y, xy = pay * l2 - bay * y, xz = paz * l2 - baz * y;
  const x2 = xx * xx + xy * xy + xz * xz, y2 = y * y * l2, z2 = z * z * l2;
  const k = Math.sign(rr) * rr * rr * x2;
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - r2;
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - r1;
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
const sphere = (x, y, z, c, r) => Math.hypot(x - c[0], y - c[1], z - c[2]) - r;
// torus around an axis through c: n is the axis (unit), R major, r minor
function torus(x, y, z, c, n, R, r) {
  const px = x - c[0], py = y - c[1], pz = z - c[2], h = px * n[0] + py * n[1] + pz * n[2];
  const qx = px - n[0] * h, qy = py - n[1] * h, qz = pz - n[2] * h;
  return Math.hypot(Math.hypot(qx, qy, qz) - R, h) - r;
}
function gyroid(x, y, z, f) {
  x *= f; y *= f; z *= f;
  return (Math.sin(x) * Math.cos(y) + Math.sin(y) * Math.cos(z) + Math.sin(z) * Math.cos(x)) / (f * 1.6);
}

// a turned profile: radius at height y for the vessel, smooth from foot to shoulder to lip
function vesselRadius(b, y) {
  const t = Math.min(1, Math.max(0, (y - FOOT) / (b.h - FOOT)));
  const tw = Math.pow(t, Math.log(0.5) / Math.log(b.shoulder)); // moves the belly to t = shoulder
  const lin = b.rf + (b.rn - b.rf) * t;
  return lin + (b.rb - lin) * Math.pow(Math.sin(Math.PI * tw), b.q);
}

// ---- the base forms ----
// b.dy lifts or drops the form so its lowest point sits a little under the foot plane
function baseFn(b) {
  const f = baseShape(b), dy = b.dy || 0;
  return dy ? (x, y, z) => f(x, y - dy, z) : f;
}
function baseShape(b) {
  switch (b.kind) {
    case 'pebble': return (x, y, z) => {
      const e = 1 - b.egg * y; // egg: narrower at the top
      return ellipsoid(x, y - b.cy, z, b.rx * e, b.ry, b.rz * e) * Math.min(1, e);
    };
    case 'vessel': return (x, y, z) => {
      const R = vesselRadius(b, y), d = 0.004, dR = (vesselRadius(b, y + d) - vesselRadius(b, y - d)) / (2 * d);
      const side = (Math.hypot(x, z * b.oval) - R) / Math.sqrt(1 + dR * dR);
      return smax(side, y - b.h, 0.12);
    };
    case 'totem': return (x, y, z) => {
      const a = y * b.twist, c = Math.cos(a), s = Math.sin(a), sc = 1 / (1 - b.taper * y);
      const rx = (c * x - s * z) * sc, rz = (s * x + c * z) * sc;
      return roundBox(rx, y - b.cy, rz, b.bx, b.by, b.bz, b.round) / sc;
    };
    case 'ring': return (x, y, z) => {
      // a thick ring standing on its rim, squashed front to back, swelling at the bottom
      const py = y - b.cy, pr = Math.hypot(x / b.sx, py) * Math.min(1, b.sx);
      const r = b.r * (1 + b.swell * Math.max(0, -py / b.R));
      return Math.hypot(pr - b.R, z / b.sz) * Math.min(1, b.sz) - r;
    };
    case 'cluster': return (x, y, z) => {
      let d = 1e9;
      for (const l of b.lobes) d = smin(d, ellipsoid(x - l.c[0], y - l.c[1], z - l.c[2], l.r[0], l.r[1], l.r[2]), b.k);
      return d;
    };
  }
  throw new Error('unknown base ' + b.kind);
}

function cutFn(c) {
  switch (c.kind) {
    case 'tunnel': return (x, y, z) => smin(roundCone(x, y, z, c.a, c.m, c.ra, c.rm), roundCone(x, y, z, c.m, c.b, c.rm, c.rb), c.rm * 0.8);
    case 'scoop': return (x, y, z) => sphere(x, y, z, c.c, c.r);
    case 'groove': return (x, y, z) => torus(x, y, z, c.c, c.n, c.R, c.r);
    case 'lattice': return (x, y, z) => Math.max(sphere(x, y, z, c.c, c.r), gyroid(x - c.o[0], y - c.o[1], z - c.o[2], c.f) - c.t);
  }
  throw new Error('unknown cut ' + c.kind);
}

// the whole piece: base, flat foot, shell, smooth cuts
export function compile(spec) {
  const base = baseFn(spec.base), cuts = spec.cuts.map((c) => ({ f: cutFn(c), k: c.k }));
  const th = spec.shell, footK = spec.footK;
  return (x, y, z) => {
    let d = smax(base(x, y, z), FOOT - y, footK);
    if (th > 0) d = Math.max(d, -(d + th));
    for (let i = 0; i < cuts.length; i++) d = smax(d, -cuts[i].f(x, y, z), cuts[i].k);
    return d;
  };
}

// ---- generating a piece ----
const TITLES = {
  pebble: ['Seed', 'Egg', 'Pebble', 'Kernel', 'Hollow Stone'],
  vessel: ['Vessel', 'Hollow Form', 'Urn', 'Calabash', 'Jar'],
  totem: ['Column', 'Twist', 'Totem', 'Spire', 'Helix'],
  ring: ['Oculus', 'Ring', 'Halo', 'Portal', 'Eye'],
  cluster: ['Figure', 'Reclining Form', 'Cloud', 'Knot', 'Lobes'],
};
const PIERCED = ['Pierced', 'Opened', 'Tunnelled', 'Winged', 'Breathing', 'Turning'];

// find the surface along a ray from outside toward p0 (sphere tracing, then bisection)
function surfaceToward(f, dir, target) {
  let t = 0; const o = [target[0] + dir[0] * 2.2, target[1] + dir[1] * 2.2, target[2] + dir[2] * 2.2];
  for (let i = 0; i < 200 && t < 2.2; i++) {
    const p = [o[0] - dir[0] * t, o[1] - dir[1] * t, o[2] - dir[2] * t], d = f(p[0], p[1], p[2]);
    if (d < 1e-3) return p;
    t += Math.max(d * 0.7, 0.004);
  }
  return null;
}
const norm = (v) => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const randDir = (r, yScale = 1) => { for (;;) { const v = [r() * 2 - 1, (r() * 2 - 1) * yScale, r() * 2 - 1]; const l = Math.hypot(...v); if (l > 0.2 && l <= 1) return norm(v); } };

export function makeSculpture(seed) {
  const r = rng(seed);
  const kind = r.pick(['pebble', 'vessel', 'vessel', 'totem', 'ring', 'cluster', 'pebble', 'ring']);
  let b;
  if (kind === 'pebble') b = { kind, rx: r.range(0.62, 0.88), ry: r.range(0.85, 1.0), rz: r.range(0.45, 0.78), egg: r.range(-0.05, 0.22), cy: 0.02 };
  else if (kind === 'vessel') b = { kind, h: r.range(0.55, 0.95), rf: r.range(0.22, 0.36), rb: r.range(0.62, 0.84), rn: r.range(0.1, 0.32), shoulder: r.range(0.3, 0.68), q: r.range(0.6, 1.3), oval: r.range(1, 1.25) };
  else if (kind === 'totem') b = { kind, bx: r.range(0.32, 0.5), by: 0.98, bz: r.range(0.22, 0.42), round: r.range(0.14, 0.24), twist: r.range(0.6, 1.8) * (r.chance(0.5) ? 1 : -1), taper: r.range(0, 0.25), cy: 0.0 };
  else if (kind === 'ring') {
    const R = r.range(0.55, 0.68), rr = r.range(0.2, 0.3);
    b = { kind, R, r: rr, sx: r.range(0.9, 1.2), sz: r.range(0.7, 1.3), swell: r.range(0, 0.6), cy: FOOT + R + rr * 0.55 };
  } else {
    // a chain of lobes, each overlapping the one below
    const n = 2 + Math.floor(r() * 3), lobes = [];
    let c = [r.range(-0.2, 0.2), -0.5, r.range(-0.15, 0.15)];
    for (let i = 0; i < n; i++) {
      const rad = [r.range(0.32, 0.55), r.range(0.3, 0.45) * (n > 3 ? 0.85 : 1), r.range(0.28, 0.42)];
      if (i) c = [Math.max(-0.45, Math.min(0.45, c[0] + r.range(-0.3, 0.3))), c[1] + (lobes[i - 1].r[1] + rad[1]) * r.range(0.5, 0.7), Math.max(-0.3, Math.min(0.3, c[2] + r.range(-0.2, 0.2)))];
      lobes.push({ c: c.slice(), r: rad });
    }
    // stretch a squat chain up to about the height of the other forms
    const y0 = lobes[0].c[1] - lobes[0].r[1], top = Math.max(...lobes.map((l) => l.c[1] + l.r[1])), st = Math.min(1.7, Math.max(1, 1.6 / (top - y0)));
    for (const l of lobes) { l.c[1] = y0 + (l.c[1] - y0) * st; l.r[1] *= st; }
    b = { kind, lobes, k: r.range(0.25, 0.45) };
  }
  if (kind !== 'vessel') {
    // drop or raise the form so the foot plane takes a slice off its bottom
    const f0 = baseShape(b), want = FOOT - r.range(0.06, 0.16);
    let low = null;
    for (let y = -BOUND - 0.4; y < 1 && low === null; y += 0.01)
      for (let i = 0; i < 169 && low === null; i++) if (f0(((i % 13) / 6 - 1) * 0.9, y, (Math.floor(i / 13) / 6 - 1) * 0.9) < 0) low = y;
    b.dy = low === null ? 0 : want - low;
  }
  const base = baseFn(b), footK = r.range(0.03, 0.08);
  const solid = (x, y, z) => smax(base(x, y, z), FOOT - y, footK);

  const shell = kind === 'vessel' ? r.range(0.07, 0.11) : r.chance(0.5) ? r.range(0.09, 0.15) : 0;
  const cuts = [];
  const fillet = () => r.range(0.06, 0.14);
  // interior points, for the tunnels to pass through
  const inside = () => { for (let i = 0; i < 400; i++) { const p = [r.range(-0.8, 0.8), r.range(-0.45, 0.85), r.range(-0.6, 0.6)]; if (solid(...p) < -0.14) return p; } return [0, 0.1, 0]; };

  if (kind === 'vessel') {
    // the mouth: a shallow opening at the lip, as a turner leaves it
    const top = b.h, rm = b.rn * r.range(0.65, 0.9);
    cuts.push({ kind: 'tunnel', a: [0, top + 1, 0], m: [0, top - 0.05, 0], b: [0, top - 0.3, 0], ra: rm, rm, rb: rm * 0.6, k: 0.09 });
  }
  const nTun = kind === 'ring' ? Math.floor(r() * 2) : (kind === 'vessel' ? Math.floor(r() * 3) : 1 + Math.floor(r() * 2.6));
  for (let i = 0; i < nTun; i++) {
    const m = inside(), d1 = randDir(r, 0.45), bend = r.range(0.2, 0.9);
    // entry and exit on roughly opposite sides, bent through m
    const d2 = norm([-d1[0] + randDir(r)[0] * bend, -d1[1] * 0.5 + randDir(r)[1] * bend * 0.5, -d1[2] + randDir(r)[2] * bend]);
    const rm = r.range(0.14, 0.3);
    cuts.push({ kind: 'tunnel', a: [m[0] + d1[0] * 1.8, m[1] + d1[1] * 1.8, m[2] + d1[2] * 1.8], m, b: [m[0] + d2[0] * 1.8, m[1] + d2[1] * 1.8, m[2] + d2[2] * 1.8], ra: rm * r.range(0.9, 1.6), rm, rb: rm * r.range(0.9, 1.6), k: fillet() });
  }
  const nScoop = Math.floor(r() * (kind === 'vessel' ? 2 : 3.2));
  for (let i = 0; i < nScoop; i++) {
    const dir = randDir(r, 0.7); if (dir[1] < -0.4) dir[1] *= -1;
    const s = surfaceToward(solid, dir, [0, 0.1, 0]); if (!s) continue;
    const R = r.range(0.25, 0.5);
    cuts.push({ kind: 'scoop', c: [s[0] + dir[0] * R * r.range(0.45, 0.8), s[1] + dir[1] * R * 0.6, s[2] + dir[2] * R * r.range(0.45, 0.8)], r: R, k: fillet() });
  }
  if (r.chance(kind === 'vessel' || kind === 'totem' ? 0.45 : 0.2)) {
    const n = 1 + Math.floor(r() * 3), y0 = r.range(-0.4, 0.4), gap = r.range(0.09, 0.16), rr = r.range(0.035, 0.06);
    for (let i = 0; i < n; i++) {
      const y = y0 + (i - (n - 1) / 2) * gap;
      let R = 0; for (let x = 0.05; x < BOUND; x += 0.01) { if (solid(x, y, 0) > 0) { R = x; break; } }
      if (R > 0) cuts.push({ kind: 'groove', c: [0, y, 0], n: [0, 1, 0], R: R + rr * 0.35, r: rr, k: 0.02 });
    }
  }
  if (shell > 0 && r.chance(0.22)) {
    const dir = randDir(r, 0.5), s = surfaceToward(solid, dir, [0, 0.15, 0]);
    if (s) cuts.push({ kind: 'lattice', c: s, r: r.range(0.35, 0.55), o: [r(), r(), r()], f: r.range(9, 14), t: r.range(0.18, 0.35) / 12, k: 0.02 });
  }
  // a shell with nothing cut through it would hide its hollow: make sure one opening reaches in
  if (shell > 0 && !cuts.some((c) => c.kind === 'tunnel' || c.kind === 'lattice')) {
    const m = inside(), d1 = randDir(r, 0.4), rm = r.range(0.18, 0.28);
    cuts.push({ kind: 'tunnel', a: [m[0] + d1[0] * 1.8, m[1] + d1[1] * 1.8, m[2] + d1[2] * 1.8], m, b: [m[0] - d1[0] * 1.8, m[1] - d1[1] * 1.8, m[2] - d1[2] * 1.8], ra: rm * 1.3, rm, rb: rm * 1.3, k: fillet() });
  }
  // a cut that splits the piece in two (the mesher keeps the larger part) is taken back out
  const spec = { seed, title: '', base: b, footK, shell, cuts };
  for (let tries = 0; tries < 8 && spec.cuts.length; tries++) {
    const m = buildMesh(spec, 40, { lite: true });
    if (m.lostFraction < 0.03 && m.maxY > 0.2) break;
    spec.cuts.splice(kind === 'vessel' && spec.cuts.length > 1 ? 1 + Math.floor(r() * (spec.cuts.length - 1)) : spec.cuts.length - 1, 1);
  }
  const hasHole = cuts.some((c) => c.kind === 'tunnel' && c.ra > 0.12) || shell > 0;
  const title = (hasHole && r.chance(0.6) ? r.pick(PIERCED) + ' ' : '') + r.pick(TITLES[kind]);
  spec.title = title;
  return spec;
}

// ---- meshing: surface nets on a grid, vertices projected onto the surface ----
// opts.N cells along each axis. Returns positions, normals (SDF gradient), per-vertex ambient
// occlusion and curvature (from the field), and indices, keeping only the largest connected piece.
export function buildMesh(spec, N = 128, { lite = false, vis: withVis = true } = {}) {
  const f = compile(spec);
  const S = N + 1, h = (2 * BOUND) / N, lo = -BOUND;
  const v = new Float32Array(S * S * S);
  // coarse pass first: blocks of 4 cells far from the surface take the corner value as is
  const B = 4, nb = Math.ceil(N / B), cb = nb + 1, coarse = new Float32Array(cb * cb * cb), H = h * B;
  for (let k = 0; k < cb; k++) for (let j = 0; j < cb; j++) for (let i = 0; i < cb; i++) coarse[i + cb * (j + cb * k)] = f(lo + Math.min(i * B, N) * h, lo + Math.min(j * B, N) * h, lo + Math.min(k * B, N) * h);
  const far = H * 1.9; // block diagonal ~1.73 H, with margin for non-exact distances
  for (let bk = 0; bk < nb; bk++) for (let bj = 0; bj < nb; bj++) for (let bi = 0; bi < nb; bi++) {
    const c0 = coarse[bi + cb * (bj + cb * bk)];
    let near = false, mn = Infinity;
    for (let c = 0; c < 8; c++) { const cv = coarse[(bi + (c & 1)) + cb * ((bj + ((c >> 1) & 1)) + cb * (bk + (c >> 2)))]; mn = Math.min(mn, Math.abs(cv)); if (Math.sign(cv) !== Math.sign(c0)) near = true; }
    if (mn < far) near = true;
    const i1 = Math.min((bi + 1) * B, N), j1 = Math.min((bj + 1) * B, N), k1 = Math.min((bk + 1) * B, N);
    for (let k = bk * B; k <= k1; k++) for (let j = bj * B; j <= j1; j++) for (let i = bi * B; i <= i1; i++) {
      const idx = i + S * (j + S * k);
      v[idx] = near ? f(lo + i * h, lo + j * h, lo + k * h) : (c0 > 0 ? far : -far);
    }
  }
  // keep the largest solid piece: flood-fill the inside samples (6-connected); every other
  // piece, a sliver a cut left floating, turns to air before meshing
  const label = new Int32Array(S * S * S), sizes = [0]; let lab = 0;
  const stack = new Int32Array(S * S * S);
  for (let s0 = 0; s0 < v.length; s0++) {
    if (v[s0] >= 0 || label[s0]) continue;
    lab++; let sp = 0, size = 0; stack[sp++] = s0; label[s0] = lab;
    while (sp) {
      const c = stack[--sp]; size++;
      const i = c % S, j = ((c / S) | 0) % S, k = (c / (S * S)) | 0;
      if (i > 0 && v[c - 1] < 0 && !label[c - 1]) { label[c - 1] = lab; stack[sp++] = c - 1; }
      if (i < N && v[c + 1] < 0 && !label[c + 1]) { label[c + 1] = lab; stack[sp++] = c + 1; }
      if (j > 0 && v[c - S] < 0 && !label[c - S]) { label[c - S] = lab; stack[sp++] = c - S; }
      if (j < N && v[c + S] < 0 && !label[c + S]) { label[c + S] = lab; stack[sp++] = c + S; }
      if (k > 0 && v[c - S * S] < 0 && !label[c - S * S]) { label[c - S * S] = lab; stack[sp++] = c - S * S; }
      if (k < N && v[c + S * S] < 0 && !label[c + S * S]) { label[c + S * S] = lab; stack[sp++] = c + S * S; }
    }
    sizes.push(size);
  }
  let keep = 1; for (let l = 1; l < sizes.length; l++) if (sizes[l] > sizes[keep]) keep = l;
  let solidAll = 0, solidLost = 0;
  for (let l = 1; l < sizes.length; l++) { solidAll += sizes[l]; if (l !== keep) solidLost += sizes[l]; }
  if (lite) { let maxY = -Infinity; for (let s0 = 0; s0 < v.length; s0++) if (label[s0] === keep) maxY = Math.max(maxY, lo + ((s0 / (S * S)) | 0) * 0 + (((s0 / S) | 0) % S) * h); return { lostFraction: solidAll ? solidLost / solidAll : 1, maxY }; }
  if (solidLost) for (let s0 = 0; s0 < v.length; s0++) if (label[s0] && label[s0] !== keep) v[s0] = h * 0.5;

  // one vertex per cell the surface crosses
  const cellVert = new Int32Array(N * N * N).fill(-1);
  const pos = [];
  const corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const cv = new Float32Array(8);
  for (let k = 0; k < N; k++) for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { const o = corner[c]; cv[c] = v[(i + o[0]) + S * ((j + o[1]) + S * (k + o[2]))]; if (cv[c] < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, bb] of edges) {
      if ((cv[a] < 0) === (cv[bb] < 0)) continue;
      const t = cv[a] / (cv[a] - cv[bb]), A = corner[a], Bc = corner[bb];
      sx += A[0] + (Bc[0] - A[0]) * t; sy += A[1] + (Bc[1] - A[1]) * t; sz += A[2] + (Bc[2] - A[2]) * t; n++;
    }
    cellVert[i + N * (j + N * k)] = pos.length / 3;
    pos.push(lo + (i + sx / n) * h, lo + (j + sy / n) * h, lo + (k + sz / n) * h);
  }
  // quads across every grid edge with a sign change
  const quads = [];
  const cell = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= N || j >= N || k >= N ? -1 : cellVert[i + N * (j + N * k)]);
  for (let k = 0; k < S; k++) for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const v0 = v[i + S * (j + S * k)], in0 = v0 < 0;
    for (let ax = 0; ax < 3; ax++) {
      const i1 = i + (ax === 0), j1 = j + (ax === 1), k1 = k + (ax === 2);
      if (i1 >= S || j1 >= S || k1 >= S) continue;
      if (in0 === (v[i1 + S * (j1 + S * k1)] < 0)) continue;
      let q;
      if (ax === 0) q = [cell(i, j - 1, k - 1), cell(i, j, k - 1), cell(i, j, k), cell(i, j - 1, k)];
      else if (ax === 1) q = [cell(i - 1, j, k - 1), cell(i - 1, j, k), cell(i, j, k), cell(i, j, k - 1)];
      else q = [cell(i - 1, j - 1, k), cell(i, j - 1, k), cell(i, j, k), cell(i - 1, j, k)];
      if (q.some((x) => x < 0)) continue;
      // the outward normal is +axis where the edge starts inside; the winding is fixed below
      q.push(ax, in0 ? 1 : -1);
      quads.push(q);
    }
  }
  const nv = pos.length / 3, m = nv, remap = new Int32Array(nv); for (let i = 0; i < nv; i++) remap[i] = i;
  // project each kept vertex onto the surface (two Newton steps), normal from the gradient
  const P = new Float32Array(m * 3), Nn = new Float32Array(m * 3), AO = new Float32Array(m), CV = new Float32Array(m);
  const e = h * 0.5, g = [0, 0, 0];
  const grad = (x, y, z) => { g[0] = f(x + e, y, z) - f(x - e, y, z); g[1] = f(x, y + e, z) - f(x, y - e, z); g[2] = f(x, y, z + e) - f(x, y, z - e); const l = Math.hypot(g[0], g[1], g[2]) || 1; g[0] /= l; g[1] /= l; g[2] /= l; return l / (2 * e); };
  // occlusion field: the piece and the plinth top it stands on
  const fo = (x, y, z) => Math.min(f(x, y, z), y - FOOT);
  for (let i = 0; i < nv; i++) {
    const o = remap[i]; if (o < 0) continue;
    let x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const x0 = x, y0 = y, z0 = z;
    for (let it = 0; it < 3; it++) {
      const d = f(x, y, z), gl = grad(x, y, z), s = d / Math.max(gl, 0.25);
      x -= g[0] * s; y -= g[1] * s; z -= g[2] * s;
    }
    // stay in the neighbourhood of the cell, so thin walls can't fold over
    const dx = x - x0, dy = y - y0, dz = z - z0, dl = Math.hypot(dx, dy, dz);
    if (dl > h) { x = x0 + (dx * h) / dl; y = y0 + (dy * h) / dl; z = z0 + (dz * h) / dl; }
    grad(x, y, z);
    P[o * 3] = x; P[o * 3 + 1] = y; P[o * 3 + 2] = z; Nn[o * 3] = g[0]; Nn[o * 3 + 1] = g[1]; Nn[o * 3 + 2] = g[2];
    // iq-style occlusion along the normal, 6 taps to 0.36 units: the insides of tunnels and shells go dark
    let occ = 0, w = 1;
    for (let s = 1; s <= 6; s++) { const t = 0.06 * s; occ += (t - fo(x + g[0] * t, y + g[1] * t, z + g[2] * t)) * w; w *= 0.72; }
    AO[o] = Math.min(1, Math.max(0, 1 - occ * 1.15));
    // curvature: how much the field rises off the surface, convex edges positive (wear), hollows negative
    const t = 0.03; CV[o] = (f(x + g[0] * t, y + g[1] * t, z + g[2] * t) - t) / t;
  }
  // How open each place is to the room: the share of 20 rays from it that escape past the
  // piece without hitting it or the plinth top. Traced on a coarse grid near the surface and
  // read back at each vertex, so the far wall of a cavity or the throat of a tunnel goes dark,
  // which a short occlusion probe along the normal can't see.
  if (withVis) {
  const G = 22, gS = G + 1, gh = (2 * BOUND) / G, vis = new Float32Array(gS * gS * gS).fill(1);
  const NR = 20, dirs = []; for (let i = 0; i < NR; i++) { const yv = 1 - (2 * (i + 0.5)) / NR, rr = Math.sqrt(1 - yv * yv), ph = i * 2.399963; dirs.push([Math.cos(ph) * rr, yv, Math.sin(ph) * rr]); }
  for (let k = 0; k < gS; k++) for (let j = 0; j < gS; j++) for (let i = 0; i < gS; i++) {
    let x = lo + i * gh, y = lo + j * gh, z = lo + k * gh;
    let d = fo(x, y, z);
    if (Math.abs(d) > gh * 1.8) { vis[i + gS * (j + gS * k)] = d > 0 ? 1 : 0; continue; }
    if (d < 0.02) { const gl = grad(x, y, z), push = (0.02 - d) / Math.max(gl, 0.25); x += g[0] * push; y += g[1] * push; z += g[2] * push; }
    let esc = 0;
    for (const dr of dirs) {
      let t = 0.02, hit = false;
      for (let st = 0; st < 40; st++) {
        const dd = fo(x + dr[0] * t, y + dr[1] * t, z + dr[2] * t);
        if (dd < 0.004) { hit = true; break; }
        t += dd; if (t > 2.6) break;
      }
      if (!hit) esc++;
    }
    vis[i + gS * (j + gS * k)] = esc / dirs.length;
  }
  const visAt = (x, y, z) => {
    const fx = Math.min(G - 1e-4, Math.max(0, (x - lo) / gh)), fy = Math.min(G - 1e-4, Math.max(0, (y - lo) / gh)), fz = Math.min(G - 1e-4, Math.max(0, (z - lo) / gh));
    const i = fx | 0, j = fy | 0, k = fz | 0, tx = fx - i, ty = fy - j, tz = fz - k; let s = 0;
    for (let c = 0; c < 8; c++) { const w = (c & 1 ? tx : 1 - tx) * (c & 2 ? ty : 1 - ty) * (c & 4 ? tz : 1 - tz); s += w * vis[(i + (c & 1)) + gS * ((j + ((c >> 1) & 1)) + gS * (k + (c >> 2)))]; }
    return s;
  };
  for (let o = 0; o < m; o++) {
    const x = P[o * 3] + Nn[o * 3] * 0.04, y = P[o * 3 + 1] + Nn[o * 3 + 1] * 0.04, z = P[o * 3 + 2] + Nn[o * 3 + 2] * 0.04;
    // an open face sees half the rays; scale so that reads as fully open
    AO[o] *= Math.min(1, visAt(x, y, z) * 1.9) * 0.85 + 0.15;
  }
  }
  const idx = new Uint32Array(quads.length * 6); let n = 0;
  const L2 = (a, c) => (P[a * 3] - P[c * 3]) ** 2 + (P[a * 3 + 1] - P[c * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[c * 3 + 2]) ** 2;
  for (const q0 of quads) {
    if (remap[q0[0]] < 0) continue;
    let q = [remap[q0[0]], remap[q0[1]], remap[q0[2]], remap[q0[3]]];
    // wind it so its normal points the way the edge leaves the solid
    const a = q[0] * 3, b = q[1] * 3, c = q[2] * 3, d = q[3] * 3, ax = q0[4];
    const u = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]], w = [P[d] - P[b], P[d + 1] - P[b + 1], P[d + 2] - P[b + 2]];
    const cr = ax === 0 ? u[1] * w[2] - u[2] * w[1] : ax === 1 ? u[2] * w[0] - u[0] * w[2] : u[0] * w[1] - u[1] * w[0];
    if (cr * q0[5] < 0) q = [q[3], q[2], q[1], q[0]];
    // split along the shorter diagonal
    if (L2(q[0], q[2]) <= L2(q[1], q[3])) { idx[n++] = q[0]; idx[n++] = q[1]; idx[n++] = q[2]; idx[n++] = q[0]; idx[n++] = q[2]; idx[n++] = q[3]; }
    else { idx[n++] = q[0]; idx[n++] = q[1]; idx[n++] = q[3]; idx[n++] = q[1]; idx[n++] = q[2]; idx[n++] = q[3]; }
  }
  // footprint on the foot plane, for the contact shadow
  let fr = 0; for (let i = 0; i < m; i++) if (P[i * 3 + 1] < FOOT + 0.02) fr = Math.max(fr, Math.hypot(P[i * 3], P[i * 3 + 2]));
  let minY = Infinity, maxY = -Infinity; for (let i = 0; i < m; i++) { minY = Math.min(minY, P[i * 3 + 1]); maxY = Math.max(maxY, P[i * 3 + 1]); }
  return { position: P, normal: Nn, ao: AO, curv: CV, index: idx.slice(0, n), footRadius: fr, minY, maxY, lostFraction: solidAll ? solidLost / solidAll : 0 };
}

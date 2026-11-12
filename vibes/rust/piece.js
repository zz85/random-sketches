// piece.js - Rust: the three pieces of steel (a painted panel, a bare plate, a corrugated galvanised sheet), their
// screws, bolts and rivets, and the maps the sim starts from: what each cell is (K: material, crevice,
// susceptibility, edge; K2: rivulet lean, flake threshold) and its coating at the start (C0: rust, coat, undercut,
// metal lost). Units: 1 = 10 cm. The sheet stands in the xy plane, centred on the origin, facing +z.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COAT, MAT } from './sim.js';

export const SHEET = { W: 6, H: 4.5 };
export const PAINTS = {
  green: { name: 'Machine green', c: [0.105, 0.2, 0.15] },
  red: { name: 'Signal red', c: [0.42, 0.035, 0.025] },
  blue: { name: 'Gentian blue', c: [0.035, 0.08, 0.19] },
  cream: { name: 'Cream', c: [0.62, 0.53, 0.36] },
  grey: { name: 'Battleship grey', c: [0.24, 0.26, 0.27] },
};
export const PIECES = {
  panel: { name: 'Painted panel', coat: COAT.paint, gauge: 1.0, note: 'painted sheet steel, zinc-plated screws' },
  plate: { name: 'Steel plate', coat: COAT.bare, gauge: 8, note: 'hot-rolled plate in mill scale, a weld, a riveted lap' },
  corrugated: { name: 'Corrugated sheet', coat: COAT.zinc, gauge: 0.8, note: 'galvanised corrugated sheet, roofing screws' },
};
const CORR = { A: 0.09, L: 0.76 }, SEAM_Y = 0.95, WELD_X = -1.05;

// the sheet's surface height (z) at (x, y), and the same in TSL
export function shapeZ(id, x, y) {
  if (id === 'corrugated') return CORR.A * Math.cos((2 * Math.PI * x) / CORR.L);
  if (id === 'plate') { const t = Math.min(1, Math.max(0, (y - (SEAM_Y - 0.02)) / 0.04)); return 0.07 * t * t * (3 - 2 * t); }
  return 0;
}

// ---- small seeded noise for the maps
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeNoise(seed) {
  const P = new Uint8Array(512), r = rng(seed * 7919 + 13);
  const p = [...Array(256).keys()]; for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
  const v = (ix, iy) => P[(P[ix & 255] + iy) & 511] / 255;
  const n = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
    const a = v(ix, iy), b = v(ix + 1, iy), c = v(ix, iy + 1), d = v(ix + 1, iy + 1);
    return a + (b - a) * u + (c - a) * w + (a - b - c + d) * u * w;
  };
  return (x, y, oct = 4) => { let s = 0, a = 0.5, f = 1, t = 0; for (let o = 0; o < oct; o++) { s += a * n(x * f + o * 31.7, y * f - o * 17.3); t += a; a *= 0.5; f *= 2.03; } return s / t; };
}

// ---- the hardware on each piece. type: pan (Phillips pan head), hex (bolt and washer), rivet (dome), pop (pop
// rivet), roof (hex washer-head roofing screw on a rubber washer). r: head radius, rw: washer radius.
function hardware(id, seed) {
  const r = rng(seed * 31 + 7), list = [];
  if (id === 'panel') {
    const xs = [-2.72, -1.81, -0.9, 0, 0.9, 1.81, 2.72];
    for (const y of [2.0, -2.0]) for (const x of xs) list.push({ x, y, type: 'pan', mat: MAT.zincScrew, r: 0.062 });
    for (const x of [-2.72, 2.72]) for (const y of [-1.0, 0, 1.0]) list.push({ x, y, type: 'pan', mat: MAT.zincScrew, r: 0.062 });
    // replacements: a plain steel screw or two, and one stainless
    const pick = () => list[Math.floor(r() * list.length)];
    for (let i = 0; i < 2; i++) { const s = pick(); s.mat = MAT.steel; s.recess = 2; }
    let st = pick(); while (st.mat !== MAT.zincScrew) st = pick(); st.mat = MAT.stainless;
    // the rating plate's pop rivets
    for (const [x, y] of [[0.55, 1.05], [2.05, 1.05], [0.55, 0.25], [2.05, 0.25]]) list.push({ x, y, type: 'pop', mat: MAT.steel, r: 0.045 });
  } else if (id === 'plate') {
    for (const [x, y] of [[-2.65, 1.95], [2.65, 1.95], [-2.65, -1.95], [2.65, -1.95]]) list.push({ x, y, type: 'hex', mat: MAT.steel, r: 0.085, rw: 0.13 });
    for (let x = -2.6; x <= 2.61; x += 0.4) list.push({ x, y: SEAM_Y + 0.17, type: 'rivet', mat: MAT.steel, r: 0.06 });
    for (const y of [-1.3, -0.2]) list.push({ x: 1.6, y, type: 'hex', mat: MAT.zincScrew, r: 0.085, rw: 0.13 });
  } else {
    for (const y of [1.95, 0, -1.95]) for (const n of [-3, -1, 1, 3]) list.push({ x: n * CORR.L, y, type: 'roof', mat: MAT.zincScrew, r: 0.05, rw: 0.085 });
  }
  for (const s of list) { s.z = shapeZ(id, s.x, s.y); s.recess = s.recess ?? (s.type === 'pan' ? 1 : s.type === 'pop' ? 3 : 0); s.spin = r() * Math.PI * 2; }
  return list;
}

// ---- the maps
export function buildMaps(id, seed, NX, NY) {
  const N = NX * NY, K0 = new Float32Array(N * 4), K1 = new Float32Array(N * 4), C0 = new Float32Array(N * 4);
  const nz = makeNoise(seed), nz2 = makeNoise(seed + 101), nz3 = makeNoise(seed + 202), r = rng(seed * 977 + 3);
  const { W, H } = SHEET, cx = W / NX, cy = H / NY;
  const hw = hardware(id, seed);
  const piece = PIECES[id];
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const o = (j * NX + i) * 4, x = -W / 2 + (i + 0.5) * cx, y = -H / 2 + (j + 0.5) * cy;
    const ed = Math.min(i, NX - 1 - i, j, NY - 1 - j); // cells from the sheet's edge
    let mat = MAT.sheet, crev = 0, edge = Math.max(0, 1 - ed / 5);
    let susc = 0.72 + 0.55 * nz(x * 0.9, y * 0.9) + 0.35 * (nz2(x * 9, y * 9, 2) - 0.5);
    let lean = (nz3(x * 1.4 + 9, y * 0.35, 3) - 0.5) * 2.2;
    let P = piece.coat === COAT.paint ? 1 : piece.coat === COAT.zinc ? 1 - 0.5 * edge : 0.25 + 0.75 * Math.max(0, Math.min(1, (nz2(x * 2.2, y * 2.2) - 0.32) * 2.2));
    if (id === 'corrugated') lean += 2.6 * Math.sin((2 * Math.PI * x) / CORR.L); // water runs to the troughs
    if (id === 'plate') {
      if (Math.abs(y - SEAM_Y) < 0.04) { crev = Math.max(crev, 0.9); edge = Math.max(edge, 0.6); } // water wicks into the lap
      if (y < SEAM_Y) { const dw = Math.abs(x - WELD_X); if (dw < 0.045) { mat = MAT.weld; P = 0; } else if (dw < 0.22) susc += 0.55 * (1 - dw / 0.22); } // heat-affected zone
    }
    if (id === 'panel' && x > 0.45 && x < 2.15 && y > 0.15 && y < 1.15) { mat = MAT.aluminium; P = 0; } // rating plate
    if (id === 'panel' && ((x > 0.43 && x < 2.17 && Math.abs(y - 1.15) < 0.025) || (Math.abs(y - 0.65) < 0.52 && Math.abs(x - 1.3) > 0.84 && Math.abs(x - 1.3) < 0.88))) crev = Math.max(crev, 0.7);
    for (const s of hw) {
      const dx = x - s.x, dy = y - s.y, d = Math.hypot(dx, dy), rr = s.rw || s.r;
      if (d < rr * 2.8) {
        if (d < s.r) { mat = s.mat; P = s.mat === MAT.zincScrew ? 1 : s.mat === MAT.steel ? (s.type === 'rivet' ? 0.2 : 0.45) : 0; }
        else if (s.rw && d < s.rw) { mat = s.type === 'roof' ? MAT.rubber : s.mat; P = s.mat === MAT.zincScrew ? 1 : 0.4; }
        // water held at the rim of the head (more on its top side) and paint cracked round the hole
        const rim = Math.exp(-(((d - rr) / (rr * 0.22)) ** 2));
        crev = Math.max(crev, rim * (s.type === 'roof' ? 0.5 : 0.85) * (1 + 0.4 * Math.max(0, dy / d)));
        if (d > rr * 0.9 && d < rr * 1.6) edge = Math.max(edge, 0.55 * (1 - (d - rr) / (rr * 0.7)));
        if (s.mat === MAT.stainless && d > rr && d < rr * 2.8) susc += 0.7 * (1 - (d - rr) / (rr * 1.8)); // galvanic: steel next to stainless goes faster
      }
    }
    K0[o] = mat; K0[o + 1] = Math.min(1, crev); K0[o + 2] = Math.max(0.3, susc); K0[o + 3] = Math.min(1, edge);
    K1[o] = Math.max(-1, Math.min(1, lean)); K1[o + 1] = 0.3 + 0.75 * nz(x * 3 + 40, y * 3) ** 1.5 + 0.7 * nz2(x * 22 + 5, y * 22, 2) ** 2;
    C0[o + 1] = P;
  }
  // chips and scratches from fitting it: a screwdriver that slipped, a knock on the edge
  const chip = (x0, y0, x1, y1, w) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (cx * 0.5)) + 1;
    for (let s = 0; s <= steps; s++) {
      const x = x0 + ((x1 - x0) * s) / steps, y = y0 + ((y1 - y0) * s) / steps;
      const i0 = Math.round((x + W / 2) / cx), j0 = Math.round((y + H / 2) / cy), R = Math.ceil(w / cx);
      for (let j = j0 - R; j <= j0 + R; j++) for (let i = i0 - R; i <= i0 + R; i++) {
        if (i < 0 || j < 0 || i >= NX || j >= NY) continue;
        const o = (j * NX + i) * 4; if (K0[o] !== MAT.sheet) continue;
        if (Math.hypot((i - i0) * cx, (j - j0) * cy) < w) C0[o + 1] = piece.coat === COAT.paint ? 0 : C0[o + 1] * 0.2;
      }
    }
  };
  if (piece.coat !== COAT.bare) {
    for (let k = 0; k < 3; k++) {
      const s = hw[Math.floor(r() * Math.min(hw.length, 20))], a = r() * 6.28, L = 0.08 + r() * 0.18;
      const x0 = s.x + Math.cos(a) * (s.rw || s.r) * 1.15, y0 = s.y + Math.sin(a) * (s.rw || s.r) * 1.15;
      chip(x0, y0, x0 + Math.cos(a) * L, y0 + Math.sin(a) * L, 0.006 + r() * 0.006);
    }
    for (let k = 0; k < 4; k++) { const side = r() < 0.5 ? -1 : 1, y = (r() - 0.5) * H * 0.9, x = side * (W / 2 - 0.01); chip(x, y, x - side * 0.03, y + (r() - 0.5) * 0.05, 0.012 + r() * 0.015); }
  }
  return { K0, K1, C0, hw };
}

// ---- geometry
// the sheet's front: a grid bent to its shape, with uv over the whole sheet; and its four edges
export function buildSheet(id, segX, segY, thick = 0.012) {
  const { W, H } = SHEET;
  const g = new THREE.PlaneGeometry(W, H, segX, segY), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) p.setZ(i, shapeZ(id, p.getX(i), p.getY(i)));
  g.computeVertexNormals();
  const pos = [], idx = [];
  const strip = (pts) => { // pts along an edge: [x, y]; each gets a front and back vertex
    const b = pos.length / 3;
    for (const [x, y] of pts) { const z = shapeZ(id, x, y); pos.push(x, y, z, x, y, z - thick); }
    for (let k = 0; k < pts.length - 1; k++) { const a = b + k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  };
  const n = 160, along = (x0, y0, x1, y1) => [...Array(n + 1)].map((_, k) => [x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  strip(along(-W / 2, -H / 2, W / 2, -H / 2)); strip(along(W / 2, -H / 2, W / 2, H / 2)); strip(along(W / 2, H / 2, -W / 2, H / 2)); strip(along(-W / 2, H / 2, -W / 2, -H / 2));
  const e = new THREE.BufferGeometry(); e.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); e.setIndex(idx); e.computeVertexNormals();
  // the back, so the sheet isn't see-through from behind or through a hole
  const back = new THREE.PlaneGeometry(W, H, id === 'corrugated' ? 160 : 1, 1); back.rotateY(Math.PI);
  const bp = back.attributes.position; for (let i = 0; i < bp.count; i++) bp.setZ(i, shapeZ(id, bp.getX(i), bp.getY(i)) - thick);
  back.computeVertexNormals();
  return { front: g, edges: e, back };
}

// screws, bolts and rivets, merged into one geometry in sheet coordinates. Each vertex carries its head
// (centre x, y, radius, recess) and material.
export function buildHardware(hw) {
  const parts = [];
  const lathe = (prof, seg = 40) => { const g = new THREE.LatheGeometry(prof.slice().reverse().map(([r, h]) => new THREE.Vector2(r, h)), seg); g.rotateX(Math.PI / 2); return g; };
  for (const s of hw) {
    const geos = [];
    const R = s.r;
    if (s.type === 'pan') {
      const prof = []; for (let k = 0; k <= 14; k++) { const t = k / 14; prof.push([R * t, R * 0.6 * (1 - t ** 4)]); }
      prof.push([R * 1.02, 0]); geos.push(lathe(prof));
    } else if (s.type === 'hex') {
      const w = lathe([[0, 0.012], [s.rw * 0.98, 0.012], [s.rw, 0.006], [s.rw, 0]], 48); geos.push(w);
      const hx = new THREE.CylinderGeometry(R, R, R * 0.7, 6, 1); hx.rotateX(Math.PI / 2); hx.rotateZ(s.spin); hx.translate(0, 0, 0.012 + R * 0.35); geos.push(hx.toNonIndexed());
      const stub = lathe([[0, R * 0.95], [R * 0.48, R * 0.95], [R * 0.58, R * 0.8], [R * 0.58, R * 0.7]], 24); stub.translate(0, 0, 0.012); geos.push(stub); // bolt end through the nut
    } else if (s.type === 'rivet') {
      const prof = [[0, R * 0.55]]; for (let k = 1; k <= 10; k++) { const a = (k / 10) * Math.PI / 2; prof.push([R * Math.sin(a), R * 0.55 * Math.cos(a)]); }
      prof.push([R * 1.04, 0]); geos.push(lathe(prof));
    } else if (s.type === 'pop') {
      geos.push(lathe([[R * 0.2, R * 0.28], [R * 0.32, R * 0.36], [R * 0.75, R * 0.33], [R * 0.98, R * 0.16], [R * 1.02, 0]]));
      geos.push(lathe([[0, R * 0.12], [R * 0.2, R * 0.12], [R * 0.2, R * 0.28]], 16)); // the mandrel's broken end, sunk in the hole
    } else if (s.type === 'roof') {
      geos.push(lathe([[0, 0.02], [s.rw * 0.95, 0.019], [s.rw, 0.012], [s.rw * 0.9, 0.006], [s.rw * 1.04, 0]], 48)); // bonded washer over rubber
      const hx = new THREE.CylinderGeometry(R * 0.86, R * 0.86, R * 0.75, 6, 1); hx.rotateX(Math.PI / 2); hx.rotateZ(s.spin); hx.translate(0, 0, 0.02 + R * 0.375); geos.push(hx.toNonIndexed());
      geos.push(lathe([[0, 0.02 + R * 0.78], [R * 1.05, 0.02 + R * 0.76], [R * 1.08, 0.02 + R * 0.7], [R * 1.08, 0.02]], 32));
    }
    for (let g of geos) {
      g = g.index ? g.toNonIndexed() : g;
      g.deleteAttribute('uv');
      g.translate(s.x, s.y, s.z);
      const n = g.attributes.position.count, head = new Float32Array(n * 4), kind = new Float32Array(n);
      for (let i = 0; i < n; i++) { head.set([s.x, s.y, R, s.recess + (s.spin / 7)], i * 4); kind[i] = s.mat; }
      g.setAttribute('aHead', new THREE.BufferAttribute(head, 4)); g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
      if (!g.attributes.normal) g.computeVertexNormals();
      parts.push(g);
    }
  }
  // hex heads come flat-shaded already (non-indexed), lathes smooth
  return mergeGeometries(parts);
}

// the rating plate on the panel (an aluminium plate riveted on) and the weld bead on the plate
export function buildExtras(id) {
  const out = [];
  if (id === 'panel') {
    const g = new THREE.BoxGeometry(1.7, 1.0, 0.012, 1, 1, 1); g.translate(1.3, 0.65, 0.006);
    out.push({ geo: g, kind: MAT.aluminium });
  }
  if (id === 'plate') {
    const pts = []; for (let k = 0; k <= 80; k++) pts.push(new THREE.Vector3(WELD_X, -SHEET.H / 2 + (SEAM_Y + SHEET.H / 2) * (k / 80), 0));
    const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 200, 0.032, 10, false); g.scale(1, 1, 0.5);
    out.push({ geo: g, kind: MAT.weld });
  }
  return out;
}

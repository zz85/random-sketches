// scene.js - Membrane: the half shell, the egg cup it stands in, the table, and the membrane's material.
import * as THREE from 'three/webgpu';
import { Fn, attribute, varying, int, float, vec3, vec4, select, mix, smoothstep, clamp, positionLocal, normalWorld, transformNormalToView, faceDirection,
  mx_fractal_noise_float, mx_noise_float, mx_worley_noise_float, uniform, dot, normalize, max, pow, abs, cameraPosition, positionWorld, normalView, positionView, length, cross, exp, sin, cos, If, attribute as attr, fract, sqrt, min, fwidth } from 'three/tsl';
import { eggR, rimAt, THICK, RIM_N } from './egg.js';
import { TABLE_Y, CUP, NS } from './sim.js';

// ---------- shell: inner face, outer face and the broken edge between them, on a (theta, t) grid
export function buildShell(table, { brown = true } = {}) {
  const S = 256, R = 72;
  const dir = (th, phi) => [Math.sin(phi) * Math.cos(th), -Math.cos(phi), Math.sin(phi) * Math.sin(th)];
  const make = (off, flip) => {
    const p = [], idx = [];
    for (let j = 0; j <= R; j++) for (let i = 0; i <= S; i++) {
      const th = -Math.PI + (2 * Math.PI * i) / S, top = rimAt(table, th), phi = (top * j) / R;
      const d = dir(th, phi), r = eggR(...d) + off;
      p.push(d[0] * r, d[1] * r, d[2] * r);
    }
    for (let j = 0; j < R; j++) for (let i = 0; i < S; i++) {
      const a = j * (S + 1) + i, b = a + 1, c = a + S + 1, e = c + 1;
      if (flip) idx.push(a, b, c, b, e, c); else idx.push(a, c, b, b, c, e);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(idx); g.computeVertexNormals();
    return g;
  };
  const inner = make(0, true), outer = make(THICK, false);
  // rim: a strip from the inner edge to the outer edge, a little rounded and chipped
  const p = [], idx = [];
  for (let i = 0; i <= S; i++) {
    const th = -Math.PI + (2 * Math.PI * i) / S, top = rimAt(table, th);
    for (let k = 0; k <= 2; k++) {
      const d = dir(th, top + (k === 1 ? 0.004 : 0)), r = eggR(...d) + (THICK * k) / 2;
      p.push(d[0] * r, d[1] * r, d[2] * r);
    }
  }
  for (let i = 0; i < S; i++) for (let k = 0; k < 2; k++) { const a = i * 3 + k, b = a + 1, c = a + 3, e = c + 1; idx.push(a, c, b, b, c, e); }
  const rim = new THREE.BufferGeometry();
  rim.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); rim.setIndex(idx); rim.computeVertexNormals();

  // materials
  const outerMat = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.62, clearcoat: 0.08, clearcoatRoughness: 0.6 });
  const P = positionLocal;
  const mottle = mx_fractal_noise_float(P.mul(1.3), 3, 2, 0.5).mul(0.5).add(0.5);
  const speck = smoothstep(0.72, 0.9, mx_noise_float(P.mul(9)).mul(0.5).add(0.5)).mul(0.35).add(smoothstep(0.8, 0.95, mx_noise_float(P.mul(31)).mul(0.5).add(0.5)).mul(0.25));
  const brownC = mix(vec3(0.52, 0.27, 0.14), vec3(0.72, 0.45, 0.28), mottle).mul(float(1).sub(speck));
  const whiteC = mix(vec3(0.86, 0.83, 0.78), vec3(0.93, 0.91, 0.87), mottle).mul(float(1).sub(speck.mul(0.15)));
  const shellTint = uniform(brown ? 1 : 0);
  outerMat.colorNode = mix(whiteC, brownC, shellTint);
  // pores and the faint pitting of the cuticle
  outerMat.roughnessNode = float(0.55).add(mx_noise_float(P.mul(60)).mul(0.08));
  outerMat.side = THREE.FrontSide;

  // inside: the shell under the membrane is chalky, a little grey-cream, with mammillary bumps
  const innerMat = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.92 });
  const bumps = mx_worley_noise_float(P.mul(42));
  innerMat.colorNode = mix(vec3(0.66, 0.6, 0.5), vec3(0.78, 0.73, 0.63), bumps).mul(mx_fractal_noise_float(P.mul(4), 2, 2, 0.5).mul(0.06).add(0.97));
  innerMat.side = THREE.FrontSide;
  const rimMat = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.85 });
  rimMat.colorNode = mix(vec3(0.9, 0.88, 0.84), brownC, smoothstep(0.7, 1.0, mx_noise_float(P.mul(20)).mul(0.5).add(0.5)).mul(0.2).mul(shellTint));

  const group = new THREE.Group();
  for (const [g, m] of [[inner, innerMat], [outer, outerMat], [rim, rimMat]]) { const me = new THREE.Mesh(g, m); me.castShadow = me.receiveShadow = true; group.add(me); }
  group.userData = { shellTint, dispose: () => { inner.dispose(); outer.dispose(); rim.dispose(); } };
  return group;
}

// ---------- egg cup: white glazed porcelain, a bowl on a short stem and a foot
export function buildCup() {
  const pts = [];
  const prof = [[0.0, TABLE_Y], [1.55, TABLE_Y], [1.6, TABLE_Y + 0.08], [1.5, TABLE_Y + 0.2], [0.9, TABLE_Y + 0.45], [0.62, TABLE_Y + 0.8], [0.6, CUP.bot - 0.05]];
  for (let k = 0; k <= 14; k++) { const t = k / 14, y = CUP.bot + (CUP.top - CUP.bot) * t; const tt = 1 - t; prof.push([CUP.rTop * Math.sqrt(1 - 0.9 * tt * tt), y]); }
  prof.push([CUP.rTop - 0.04, CUP.top + 0.03], [CUP.rTop - 0.12, CUP.top + 0.02]);
  // inside the bowl, following the egg's outer surface down a little way
  const hug = [];
  for (let k = 0; k <= 40; k++) {
    const phi = (k / 40) * 1.2, d = [Math.sin(phi), -Math.cos(phi), 0], r = eggR(...d) + THICK + 0.012;
    if (-r * Math.cos(phi) < CUP.top) hug.push([r * Math.sin(phi), -r * Math.cos(phi)]);
  }
  hug.reverse().forEach((q) => prof.push(q));
  for (const [x, y] of prof) pts.push(new THREE.Vector2(x, y));
  const g = new THREE.LatheGeometry(pts, 96);
  const mat = new THREE.MeshPhysicalNodeMaterial({ color: 0xf3f1ec, roughness: 0.22, clearcoat: 0.6, clearcoatRoughness: 0.15 });
  const m = new THREE.Mesh(g, mat); m.castShadow = m.receiveShadow = true;
  return m;
}

// ---------- the table: oiled oak planks, 11 cm wide, running left to right. Each plank is a flat-sawn board from
// its own log: the pith lies a depth d under the board and the board runs a little off the log's axis, so the
// growth rings at r = sqrt(y^2 + d^2) close into cathedral arches along it. Earlywood ramps into a dense late
// band each year, ring widths drift, fine fibres and the odd ray fleck run along the grain, each board has its own
// tone, and a dark seam with a slight bevel sits between boards. Rings finer than a pixel fade to their mean.
export function buildTable() {
  const g = new THREE.PlaneGeometry(140, 140, 1, 1); g.rotateX(-Math.PI / 2); g.translate(0, TABLE_Y, 0);
  const mat = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.55, clearcoat: 0.18, clearcoatRoughness: 0.45 }); // oiled, satin: no varnish glare
  const W = 11.0;
  const C = (h) => { const c = new THREE.Color(h); return vec3(c.r, c.g, c.b); }; // sRGB hex to linear
  const P = positionLocal;
  const wood = Fn(() => {
    const along = P.x, across = P.z;
    const v = across.div(W), plank = v.floor(), f = v.fract();
    const h1 = fract(sin(plank.mul(12.9898)).mul(43758.55)), h2 = fract(sin(plank.mul(78.233)).mul(12345.67)), h3 = fract(sin(plank.mul(39.425)).mul(24634.6));
    const x = along.add(h2.mul(400));
    const yIn = f.sub(0.5).mul(W).add(h3.sub(0.5).mul(6));
    // slow warp of the log, a few millimetres
    const wy = mx_fractal_noise_float(vec3(x.mul(0.04), yIn.mul(0.05), plank), 3, 2, 0.5).mul(0.6);
    const d = h1.mul(10).add(4).add(sin(x.mul(0.018).add(h3.mul(6))).mul(3.2));
    const yy = yIn.add(wy);
    const r = sqrt(yy.mul(yy).add(d.mul(d)));
    const rings = r.mul(5.5).add(mx_noise_float(vec3(r.mul(0.3), x.mul(0.01), plank)).mul(2.5));
    const ri = rings.floor(), t = rings.fract(), rh = fract(sin(ri.mul(91.7).add(plank)).mul(4375.5));
    const lwRaw = smoothstep(rh.mul(-0.25).add(0.62), 0.93, t).pow(1.2).mul(smoothstep(1.0, 0.96, t));
    const lw = mix(lwRaw, float(0.3), smoothstep(0.3, 0.9, fwidth(rings)));
    const fib = mx_noise_float(vec3(x.mul(0.5), yy.mul(30), plank.mul(3))).mul(smoothstep(1.5, 0.4, fwidth(yy.mul(30))));
    // oak's open pores: short dark dashes along the grain, thickest in the earlywood
    const pore = smoothstep(0.55, 0.8, mx_noise_float(vec3(x.mul(2.2), yy.mul(70), plank.mul(5)))).mul(float(1).sub(lw)).mul(smoothstep(1.2, 0.3, fwidth(yy.mul(70))));
    const fleck = smoothstep(0.78, 0.9, mx_noise_float(vec3(x.mul(1.1), yy.mul(6), plank.add(7)))).mul(0.6);
    const early = mix(C('#8a6038'), C('#a0754a'), h1), late = mix(C('#4a2d17'), C('#5c3a1f'), h2);
    const base = mix(early, late, lw.mul(0.85)).mul(rh.sub(0.5).mul(0.18).add(1)).mul(fib.mul(0.22).add(1)).mul(float(1).sub(pore.mul(0.35))).add(C('#b08a5c').mul(fleck).mul(0.15));
    const edge = min(f, float(1).sub(f)).mul(W);
    const seam = smoothstep(0.0, 0.07, edge), bevel = smoothstep(0.07, 0.3, edge);
    const tone = mx_fractal_noise_float(vec3(P.x.mul(0.02), P.z.mul(0.02), 1), 2, 2, 0.5).mul(0.1).add(1).mul(h3.mul(0.2).add(0.9));
    return vec4(base.mul(tone).mul(seam.mul(0.85).add(0.15)).mul(bevel.mul(0.15).add(0.85)), lw);
  })();
  mat.colorNode = wood.rgb;
  mat.roughnessNode = float(0.5).add(wood.a.mul(0.15));
  const m = new THREE.Mesh(g, mat); m.receiveShadow = true;
  return m;
}

// ---------- membrane: one vertex of the drawn mesh per corner of each triangle, read from the sim's buffers
export function buildMembraneMesh(sim, light) {
  const { m } = sim, { pos, normal, anchor, triE, wet } = sim.buffers;
  const vid = new Float32Array(m.NT * 3), tid = new Float32Array(m.NT * 3);
  for (let t = 0; t < m.NT; t++) for (let k = 0; k < 3; k++) { vid[t * 3 + k] = m.tris[t][k]; tid[t * 3 + k] = t; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(m.NT * 9), 3));
  g.setAttribute('vid', new THREE.Float32BufferAttribute(vid, 1));
  g.setAttribute('tid', new THREE.Float32BufferAttribute(tid, 1));
  // a raw egg's membrane: wet, so a clear coat of egg white over a matte fibrous sheet
  const mat = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, transparent: true, roughness: 0.5, sheen: 0.4, sheenRoughness: 0.5, sheenColor: 0xffffff,
    clearcoat: 0.7, clearcoatRoughness: 0.12 });
  const vi = int(attribute('vid', 'float')), ti = int(attribute('tid', 'float'));
  mat.positionNode = Fn(() => select(triE.element(ti).w.greaterThan(0.5), pos.element(vi).xyz, vec3(0, -50, 0)))();
  const nrm = varying(normal.element(vi), 'vNrm');
  const att = varying(anchor.element(vi).w, 'vAtt');
  const rest = varying(anchor.element(vi).xyz, 'vRest');
  const wt = varying(wet.element(vi).min(1), 'vWet');
  mat.normalNode = transformNormalToView(nrm.xyz).mul(faceDirection);
  const strainView = uniform(0);
  const stretch = nrm.w; // area now / area at rest
  // fibrous mat: fine streaky noise in rest space, so it travels with the sheet
  const fib = mx_fractal_noise_float(rest.mul(vec3(26, 9, 26)), 3, 2, 0.5).mul(0.5).add(0.5);
  const base = mix(vec3(0.9, 0.9, 0.89), vec3(0.98, 0.98, 0.97), fib);
  const free = float(1).sub(att);
  const thin = clamp(stretch.sub(1).mul(1.6), 0, 1);
  // strained sheet: thinner, glassier, faintly blue-grey where light passes
  const col = mix(base, vec3(0.8, 0.82, 0.84), thin.mul(0.5));
  const heat = mix(mix(vec3(0.2, 0.4, 0.9), vec3(0.95, 0.85, 0.2), clamp(stretch.sub(1).mul(4), 0, 1)), vec3(0.95, 0.15, 0.1), clamp(stretch.sub(1.25).mul(3), 0, 1));
  mat.colorNode = mix(col, heat, strainView);
  mat.roughnessNode = mix(0.62, 0.36, free).sub(thin.mul(0.12)).sub(wt.mul(0.15)).max(0.12);
  // freshly peeled: the wet side glistens; it dulls as it dries, and shows a faint drying tide line
  const gloss = free.mul(wt.mul(0.6).add(0.4));
  mat.clearcoatNode = gloss;
  mat.clearcoatRoughnessNode = mix(0.35, 0.06, wt);
  mat.opacityNode = mix(float(1), clamp(float(0.93).sub(thin.mul(0.45)), 0.4, 0.95), free);
  // light through the sheet from behind it
  // the light's direction in the membrane's own frame (the shell's, which can be picked up and turned)
  const L = uniform(new THREE.Vector3()).onRenderUpdate(({ object }) => {
    const d = light.position.clone().sub(light.target.position).normalize();
    return object ? d.transformDirection(object.matrixWorld.clone().invert()) : d;
  });
  const back = max(dot(nrm.xyz.mul(faceDirection), L).negate(), 0).mul(free).mul(0.35);
  mat.emissiveNode = vec3(1, 0.97, 0.9).mul(back).mul(mix(float(0.6), float(1), thin));
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true;

  // the wet film the membrane leaves on the bare shell: drawn on the shell at the membrane's rest places,
  // glossy and a little darker and greyer (wet chalk), fading as it dries
  const wmat = new THREE.MeshPhysicalNodeMaterial({ transparent: true, depthWrite: false, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.04,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const wAt = varying(anchor.element(vi), 'wAt');
  const wW = varying(wet.element(vi).min(1), 'wWet');
  wmat.positionNode = Fn(() => { const a = anchor.element(vi).xyz; return normalize(a).mul(length(a).add(0.0095)); })();
  wmat.normalNode = transformNormalToView(normalize(wAt.xyz).negate());
  // puddles bead up as the film breaks: worley cells drop out first where the film is thin
  const cells = mx_worley_noise_float(wAt.xyz.mul(9));
  const film = smoothstep(0.0, 0.35, wW.sub(cells.mul(0.35)));
  wmat.colorNode = vec3(0.55, 0.52, 0.45);
  wmat.opacityNode = film.mul(float(1).sub(wAt.w)).mul(0.5);
  wmat.side = THREE.FrontSide;
  const wetMesh = new THREE.Mesh(g, wmat); wetMesh.frustumCulled = false; wetMesh.renderOrder = 1;
  mesh.add(wetMesh);
  mesh.renderOrder = 2;
  mesh.userData = { strainView, dispose: () => { g.dispose(); mat.dispose(); wmat.dispose(); } };
  return mesh;
}

// ---------- strands of egg white: a tube per strand slot, two halves of SEG rings, shaped in the vertex shader.
// Attached, the thread runs from the shell to its vertex, thinnest in the middle, with a meniscus at each end,
// and sags by its slack (the arc of a parabola of its own length over the span). Snapped, each half shortens
// toward its end, droops under gravity and ends in a bead.
export function buildStrands(sim) {
  const { pos, sA, sB } = sim.buffers;
  const SEG = 12, SIDES = 6;
  const p = [], sid = [], hs = [], ang = [], idx = [];
  for (let s = 0; s < NS; s++) for (let h = 0; h < 2; h++) {
    const base = p.length / 3;
    for (let j = 0; j <= SEG; j++) for (let k = 0; k < SIDES; k++) { p.push(0, 0, 0); sid.push(s); hs.push(h + j / SEG * 0.999); ang.push((k / SIDES) * Math.PI * 2); }
    for (let j = 0; j < SEG; j++) for (let k = 0; k < SIDES; k++) {
      const a = base + j * SIDES + k, b = base + j * SIDES + ((k + 1) % SIDES), c = a + SIDES, d = b + SIDES;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('sid', new THREE.Float32BufferAttribute(sid, 1));
  g.setAttribute('hs', new THREE.Float32BufferAttribute(hs, 1));
  g.setAttribute('ang', new THREE.Float32BufferAttribute(ang, 1));
  g.setIndex(idx);
  const mat = new THREE.MeshPhysicalNodeMaterial({ transparent: true, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.03, ior: 1.36, specularIntensity: 1 });
  const si = int(attr('sid', 'float')), hsA = attr('hs', 'float'), an = attr('ang', 'float');
  const A = sA.element(si), Bv = sB.element(si);
  const half = hsA.floor(), s = hsA.fract(); // s from 0 at its end to 1 at the middle (attached) or tip (snapped)
  // centre line and radius at (half, s)
  const curve = Fn(([sq]) => {
    const P0 = A.xyz, P1 = pos.element(int(A.w)).xyz;
    const snapped = Bv.y.greaterThan(1.5);
    const D = length(P1.sub(P0)).max(1e-4);
    const Ls = Bv.z.max(D);
    const out = vec4(0).toVar();
    If(snapped.not(), () => {
      const u = select(half.lessThan(0.5), sq.mul(0.5), float(1).sub(sq.mul(0.5)));
      const sag = Ls.sub(D).max(0).mul(D).mul(0.375).sqrt();
      const c = mix(P0, P1, u).sub(vec3(0, sag.mul(u).mul(float(1).sub(u)).mul(4), 0));
      const r = Bv.x.div(Ls.mul(Math.PI)).sqrt();
      // physical radius scaled up so a thread of a tenth of a millimetre still reads on screen
      const rr = r.mul(3.2).clamp(0.008, 0.055).mul(float(1).add(exp(u.mul(-14)).add(exp(float(1).sub(u).mul(-14))).mul(2.2)));
      out.assign(vec4(c, rr));
    }).Else(() => {
      const t = Bv.w, k = exp(t.mul(-5.5));
      const Ph = select(half.lessThan(0.5), P0, P1), Po = select(half.lessThan(0.5), P1, P0);
      const len = Bv.z.mul(0.5).mul(k);
      const dir = normalize(mix(normalize(Po.sub(Ph)), vec3(0, -1, 0), float(1).sub(k).mul(0.55)));
      // it whips a little as it recoils
      const c = Ph.add(dir.mul(len.mul(sq))).add(vec3(0, sin(t.mul(22).add(sq.mul(3))).mul(0.06).mul(k).mul(sq), 0));
      const r0 = Bv.x.div(Bv.z.mul(Math.PI)).sqrt().mul(3.2).clamp(0.008, 0.055);
      const bead = smoothstep(0.6, 1.0, sq).mul(float(1).sub(k).mul(1.5).add(0.8));
      out.assign(vec4(c, r0.mul(float(1).add(bead).add(exp(sq.mul(-12)).mul(2))).mul(float(1).sub(smoothstep(0.97, 1.0, sq).mul(0.85)))));
    });
    return out;
  });
  const c0 = curve(s), c1 = curve(s.add(0.02).min(1)), cm = curve(s.sub(0.02).max(0));
  const T = normalize(c1.xyz.sub(cm.xyz).add(vec3(1e-6, 0, 0)));
  const up = select(abs(T.y).greaterThan(0.9), vec3(1, 0, 0), vec3(0, 1, 0));
  const Nn = normalize(cross(T, up)), Bn = cross(T, Nn);
  const radial = Nn.mul(cos(an)).add(Bn.mul(sin(an)));
  const alive = Bv.y.greaterThan(0.5);
  mat.positionNode = select(alive, c0.xyz.add(radial.mul(c0.w)), vec3(0, -50, 0));
  mat.normalNode = transformNormalToView(varying(radial, 'sRad'));
  // a clear viscous rod: see-through face on, bright and opaque at its silhouette, as a glass thread is
  const facing = abs(dot(normalView, normalize(positionView).negate()));
  const rim = pow(float(1).sub(facing), 2.0);
  mat.colorNode = vec3(0.97, 0.97, 0.93);
  mat.opacityNode = mix(float(0.18), float(0.92), rim);
  mat.emissiveNode = vec3(0.55, 0.56, 0.52).mul(rim).mul(0.5);
  const mesh = new THREE.Mesh(g, mat); mesh.frustumCulled = false; mesh.renderOrder = 3;
  mesh.userData = { dispose: () => { g.dispose(); mat.dispose(); } };
  return mesh;
}

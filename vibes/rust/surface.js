// surface.js - Rust: one material for everything made of metal here (the sheet, its edges, the screws and bolts,
// the rating plate, the weld), drawn from the sim's textures. Each layer is read where it lies: bare steel or zinc,
// mill scale, paint over primer, rust on top in crusts that darken as they thicken and orange where they're young,
// the iron stain the runoff leaves, the water film and beads, and holes where the metal is gone. Relief comes from
// a height made of the same layers, turned into a normal by screen-space differences, and the sheet itself is
// pushed out where rust is thick or paint blisters.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uniform, texture, attribute, varying, positionGeometry, positionLocal, normalLocal, normalView, positionView,
  mix, smoothstep, clamp, select, max, min, abs, exp, dot, cross, normalize, dFdx, dFdy, sign, floor, fract, sin, cos, length,
  mx_fractal_noise_float, mx_noise_float, mx_worley_noise_float } from 'three/tsl';
import { COAT, MAT } from './sim.js';
import { SHEET } from './piece.js';

const C = (r, g, b) => vec3(r, g, b);

export function makeLook() {
  return {
    paint: uniform(new THREE.Color(0.105, 0.2, 0.15)), age: uniform(0), // years, for paint chalking
    stainGain: uniform(1), showWet: uniform(1),
  };
}

// kTex: the static cell map (material, crevice, susceptibility, edge) as a half-float texture
export function surfaceMaterial({ sim, look, kTex, kind = null, hardware = false, displace = true }) {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.5, metalness: 0, clearcoat: 0, side: THREE.FrontSide });
  m.alphaTest = 0.5;
  const coatU = sim.U.coat;
  const half = vec2(SHEET.W, SHEET.H);
  const uvOf = (q) => q.div(half).add(0.5);
  const kindN = kind === null ? varying(attribute('aKind', 'float'), 'vKind').round() : float(kind);
  const head = hardware ? varying(attribute('aHead', 'vec4'), 'vHead') : null;
  const pV = positionGeometry.xy;

  // ---- push the surface out where the rust is thick and where paint blisters
  if (displace) {
    m.positionNode = Fn(() => {
      const c = texture(sim.texC, uvOf(pV)).level(0);
      const paintOn = select(coatU.equal(COAT.paint), smoothstep(0.45, 0.55, c.y), float(0));
      const d = smoothstep(0.05, 2.5, c.x).mul(0.006).mul(float(1).sub(paintOn)).add(c.z.min(1.2).mul(0.005).mul(paintOn));
      return positionLocal.add(normalLocal.mul(d));
    })();
  }

  const p = varying(pV, 'vSheetXY');
  const isSheet = kindN.equal(MAT.sheet).or(kindN.equal(MAT.weld));
  const coat = select(kindN.equal(MAT.zincScrew), float(COAT.zinc), select(isSheet, coatU, float(COAT.bare)));
  const rustable = kindN.lessThanEqual(MAT.steel).or(kindN.equal(MAT.weld));

  // the layers at a point q of the sheet
  const layers = (q) => {
    const uv = uvOf(q);
    const c = texture(sim.texC, uv), w = texture(sim.texW, uv);
    const R = c.x, P = c.y, Un = c.z, M = c.w;
    const n1 = mx_fractal_noise_float(vec3(q.mul(26), 1.3), 3, 2.1, 0.5); // -1..1, about 4 mm
    const n2 = mx_noise_float(vec3(q.mul(140), 7.1)); // under a mm
    const crust = mx_worley_noise_float(vec3(q.mul(95), 2.0));
    const Rn = R.add(n1.mul(0.08)).add(n2.mul(0.025));
    const paintTop = select(coat.equal(COAT.paint), smoothstep(0.5, 0.56, P.add(n1.mul(0.07)).add(n2.mul(0.03))), float(0));
    const primer = select(coat.equal(COAT.paint), smoothstep(0.36, 0.42, P.add(n1.mul(0.07)).add(n2.mul(0.03).add(0.06))), float(0));
    const rust = select(rustable, smoothstep(0.02, 0.22, Rn).mul(float(1).sub(primer)), float(0));
    const hole = select(isSheet, M.add(n1.mul(0.25)).add(n2.mul(0.05)), float(0));
    // height, in the same units as the scene (1 = 10 cm)
    const flake = smoothstep(0.35, 0.05, crust).mul(smoothstep(0.6, 2.0, R));
    let h = rust.mul(R.min(2.5).mul(0.0025).add(crust.mul(0.0012)).add(flake.mul(0.0015)).add(n2.mul(0.0004)))
      .add(primer.mul(0.0006)).add(paintTop.mul(0.0008)).add(paintTop.mul(smoothstep(0.02, 1.0, Un).mul(0.0035).mul(n1.mul(0.4).add(0.8))));
    // orange peel in the paint, rolling marks in mill scale
    h = h.add(paintTop.mul(mx_noise_float(vec3(q.mul(60), 3)).mul(0.00008)));
    // the water: beads on paint, zinc and steel that sheds it, a smooth film on rust
    const wet = smoothstep(0.0006, 0.006, w.x);
    const bead = smoothstep(0.4, 0.1, mx_worley_noise_float(vec3(q.mul(45), 4.0))).mul(smoothstep(0.0003, 0.0015, w.x)).mul(smoothstep(0.008, 0.003, w.x).mul(0.7).add(0.3)).mul(float(1).sub(rust));
    h = h.add(bead.mul(0.0006));
    if (hardware) {
      // the recess in the head: Phillips cross, slot, or a pop rivet's hollow
      const rel = q.sub(head.xy).div(head.z), code = head.w, rec = floor(code), sp = fract(code).mul(7);
      const cs = cos(sp), sn = sin(sp), d = vec2(rel.x.mul(cs).sub(rel.y.mul(sn)), rel.x.mul(sn).add(rel.y.mul(cs)));
      const ax = abs(d.x), ay = abs(d.y), r = length(d);
      const phil = max(smoothstep(0.15, 0.1, ax).mul(smoothstep(0.5, 0.42, ay)), smoothstep(0.15, 0.1, ay).mul(smoothstep(0.5, 0.42, ax))).max(smoothstep(0.2, 0.12, r));
      const slot = smoothstep(0.11, 0.07, ay).mul(smoothstep(0.92, 0.85, ax));
      const pop = smoothstep(0.2, 0.15, r);
      const top = smoothstep(0.55, 0.85, normalLocal.z);
      const depth = select(rec.equal(1), phil, select(rec.equal(2), slot, select(rec.equal(3), pop, float(0)))).mul(top);
      h = h.sub(depth.mul(0.012));
      return { R, P, Un, M, w, n1, n2, crust, rust, paintTop, primer, hole, h, wet, bead, flake, recess: depth };
    }
    return { R, P, Un, M, w, n1, n2, crust, rust, paintTop, primer, hole, h, wet, bead, flake, recess: float(0) };
  };

  const L = layers(p);
  const dpx = dFdx(p), dpy = dFdy(p);
  const Lx = layers(p.add(dpx)), Ly = layers(p.add(dpy));

  // ---- colour, roughness and metalness, layer by layer
  const age = look.age;
  const kc = texture(kTex, uvOf(p));
  const steel = C(0.52, 0.52, 0.53), steelRough = float(0.3).add(L.n2.mul(0.05));
  // mill scale: blue-black, patchy where it has spalled
  const scale = mix(C(0.075, 0.08, 0.09), C(0.13, 0.13, 0.14), L.n1.mul(0.5).add(0.5));
  // zinc: spangle (big crystals catching the light differently), dulling to grey then to white rust as it's used
  const sp = mx_worley_noise_float(vec3(p.mul(9), 5.0)), spV = mx_noise_float(vec3(floor(p.mul(9).add(sp.mul(0.0))), 1.0));
  const zincNew = C(0.6, 0.62, 0.64).mul(spV.mul(0.08).add(1)), zincDull = C(0.45, 0.46, 0.46), zincWhite = C(0.62, 0.62, 0.6);
  const zt = L.P.add(L.n1.mul(0.08));
  const zinc = mix(mix(zincWhite, zincDull, smoothstep(0.15, 0.5, zt).mul(smoothstep(0.35, 0.6, L.n1.mul(0.5).add(0.5)).mul(0.6).add(0.4))), zincNew, smoothstep(0.55, 0.95, zt));
  const zincMetal = smoothstep(0.35, 0.8, zt), zincRough = mix(float(0.85), spV.mul(0.12).add(0.28), smoothstep(0.5, 0.9, zt));

  // the bare metal of each kind
  let { col, rough, metal } = baseMetal(kindN, { steel, steelRough, scale, zinc, zincMetal, zincRough, L, coat, p });

  // paint over primer
  const pc = look.paint.mul(mix(float(1), float(1.35), smoothstep(0, 25, age).mul(L.n1.mul(0.15).add(0.85)))); // chalks paler with age
  const primerC = C(0.3, 0.085, 0.05);
  col = mix(col, primerC, L.primer); rough = mix(rough, float(0.75), L.primer); metal = mix(metal, float(0), L.primer);
  const paintRough = float(0.3).add(smoothstep(0, 25, age).mul(0.35));
  col = mix(col, pc, L.paintTop); rough = mix(rough, paintRough, L.paintTop); metal = mix(metal, float(0), L.paintTop);
  // a blister seeps rust at its rim before it breaks
  col = mix(col, C(0.22, 0.08, 0.03), L.paintTop.mul(smoothstep(0.3, 0.9, L.Un)).mul(smoothstep(0.2, 0.7, L.n2.mul(0.5).add(0.5))).mul(0.45));

  // rust: orange and young, brown, then dark crust with lighter flakes; bright lepidocrocite here and there
  const R = L.R;
  const young = C(0.48, 0.17, 0.04), mid = C(0.24, 0.075, 0.025), old = C(0.075, 0.03, 0.014), lepi = C(0.55, 0.26, 0.06);
  const Rv = R.mul(mx_fractal_noise_float(vec3(p.mul(1.6), 3.0), 2, 2, 0.5).mul(0.35).add(1));
  let rc = mix(mix(young, mid, smoothstep(0.15, 0.9, Rv)), old, smoothstep(1.2, 2.8, Rv).mul(0.85));
  rc = mix(rc, lepi, smoothstep(0.3, 0.75, L.n1.mul(0.5).add(0.5)).mul(smoothstep(0.1, 0.4, R)).mul(smoothstep(2.2, 0.8, R)).mul(0.55));
  rc = mix(rc, C(0.42, 0.17, 0.06), L.flake.mul(0.6));
  rc = rc.mul(L.crust.mul(0.35).add(0.8).mul(L.n2.mul(0.1).add(1))).mul(mx_fractal_noise_float(vec3(p.mul(3.5), 9.0), 3, 2, 0.5).mul(0.35).add(1));
  col = mix(col, rc, L.rust); rough = mix(rough, float(0.93), L.rust); metal = mix(metal, float(0), L.rust);

  // the stain runoff leaves, on whatever it dries on (it hardly shows on rust)
  const S = L.w.z.mul(look.stainGain);
  const st = float(1).sub(exp(S.mul(-220))).mul(float(1).sub(L.rust.mul(0.7)));
  const stainC = C(0.3, 0.1, 0.03);
  col = mix(col, mix(stainC.mul(1.5), col.mul(stainC).mul(3), 0.4), st.mul(0.75));
  rough = mix(rough, float(0.8), st.mul(0.6)); metal = metal.mul(float(1).sub(st.mul(0.8)));

  // dark in the crevice at a screw's rim and down the recess, and at the ragged rim of a hole
  col = col.mul(float(1).sub(kc.y.mul(select(isSheet, float(0.35), float(0))))).mul(float(1).sub(L.recess.mul(0.7)));
  col = col.mul(float(1).sub(smoothstep(0.75, 1.05, L.hole).mul(0.6)));

  // water: darkens what soaks it up, a glossy coat over everything
  const wet = L.wet.mul(look.showWet), beads = L.bead.mul(look.showWet);
  col = col.mul(mix(float(1), float(0.72), wet.mul(L.rust)).mul(mix(float(1), float(0.95), wet.mul(float(1).sub(L.rust)))));
  rough = mix(rough, rough.mul(0.5), wet);

  // ---- normal from the height, by screen-space differences (Mikkelsen's surface gradient)
  const nrm = Fn(() => {
    const dHx = Lx.h.sub(L.h), dHy = Ly.h.sub(L.h);
    const pv = positionView, sx = dFdx(pv), sy = dFdy(pv), n0 = normalView;
    const r1 = cross(sy, n0), r2 = cross(n0, sx), det = dot(sx, r1);
    const grad = sign(det).mul(r1.mul(dHx).add(r2.mul(dHy)));
    return normalize(abs(det).mul(n0).sub(grad));
  })();

  m.colorNode = col;
  m.roughnessNode = clamp(rough, 0.05, 1);
  m.metalnessNode = clamp(metal, 0, 1);
  m.normalNode = nrm;
  m.clearcoatNode = wet.mul(0.55).add(beads.mul(0.35)).min(0.8);
  m.clearcoatRoughnessNode = float(0.12);
  m.clearcoatNormalNode = nrm;
  m.opacityNode = select(L.hole.greaterThan(1.05), float(0), float(1));
  return m;
}

// the base metal of each kind of part
function baseMetal(kindN, { steel, steelRough, scale, zinc, zincMetal, zincRough, L, coat, p }) {
  const isSheet = kindN.equal(MAT.sheet);
  // sheet: by its coating. Under paint and where mill scale is gone, bright steel; zinc as above
  const sheetC = select(coat.equal(COAT.zinc), zinc, select(coat.equal(COAT.bare), mix(steel.mul(0.8), scale, smoothstep(0.2, 0.6, L.P)), steel));
  const sheetR = select(coat.equal(COAT.zinc), zincRough, select(coat.equal(COAT.bare), mix(float(0.4), float(0.6), smoothstep(0.2, 0.6, L.P)), steelRough));
  const sheetM = select(coat.equal(COAT.zinc), zincMetal.mul(0.9).add(0.05), select(coat.equal(COAT.bare), mix(float(0.9), float(0.35), smoothstep(0.2, 0.6, L.P)), float(1)));
  // weld: dark, rippled, with a heat tint
  const rip = sin(p.y.mul(420).add(L.n1.mul(2))).mul(0.5).add(0.5);
  const weldC = mix(C(0.09, 0.085, 0.085), C(0.2, 0.16, 0.11), rip.mul(0.5)).mul(L.n2.mul(0.15).add(1));
  const black = C(0.055, 0.055, 0.06), stain = C(0.6, 0.6, 0.62), alu = C(0.42, 0.43, 0.44).mul(L.n1.mul(0.04).add(1)), rubber = C(0.02, 0.02, 0.022);
  // steel screws, bolts and rivets: black oxide wearing to steel
  const steelPart = mix(steel.mul(0.75), black, smoothstep(0.1, 0.4, L.P));
  const col = (select(isSheet, sheetC, select(kindN.equal(MAT.weld), weldC, select(kindN.equal(MAT.zincScrew), zinc, select(kindN.equal(MAT.steel), steelPart,
    select(kindN.equal(MAT.stainless), stain, select(kindN.equal(MAT.aluminium), alu, rubber)))))));
  const rough = (select(isSheet, sheetR, select(kindN.equal(MAT.weld), float(0.6), select(kindN.equal(MAT.zincScrew), zincRough, select(kindN.equal(MAT.steel), float(0.45),
    select(kindN.equal(MAT.stainless), float(0.2), select(kindN.equal(MAT.aluminium), float(0.42), float(0.85))))))));
  const metal = (select(isSheet, sheetM, select(kindN.equal(MAT.weld), float(0.6), select(kindN.equal(MAT.zincScrew), zincMetal, select(kindN.equal(MAT.steel), float(0.7),
    select(kindN.equal(MAT.stainless), float(1), select(kindN.equal(MAT.aluminium), float(1), float(0))))))));
  return { col, rough, metal };
}

// the concrete wall the piece is fixed to
export function wallMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95 });
  const q = positionGeometry.xy;
  const n = mx_fractal_noise_float(vec3(q.mul(0.35), 0), 4, 2, 0.55).mul(0.5).add(0.5);
  const pits = smoothstep(0.08, 0.02, mx_worley_noise_float(vec3(q.mul(14), 0)));
  const streak = mx_noise_float(vec3(q.x.mul(3), q.y.mul(0.15), 2)).mul(0.5).add(0.5);
  m.colorNode = mix(C(0.2, 0.195, 0.18), C(0.33, 0.32, 0.3), n).mul(float(1).sub(pits.mul(0.4))).mul(streak.mul(0.18).add(0.88));
  const h = n.mul(0.004).sub(pits.mul(0.002));
  m.normalNode = Fn(() => {
    const pv = positionView, sx = dFdx(pv), sy = dFdy(pv), n0 = normalView;
    const r1 = cross(sy, n0), r2 = cross(n0, sx), det = dot(sx, r1);
    const grad = sign(det).mul(r1.mul(dFdx(h)).add(r2.mul(dFdy(h))));
    return normalize(abs(det).mul(n0).sub(grad));
  })();
  return m;
}

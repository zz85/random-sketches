// surface.js - Filiform: the panel's face, drawn from the sim's two textures.
//   texA (half float): tail, head, defect, tail x (birth - epoch)   texB (8 bit): salt, rear of head, activity, hue
// Under the coating: polished or brushed metal, and where a tail has grown, its corrosion product (on steel
// dark when new, then red-brown, darker with age; on aluminium a grey gel that dries to white powder), damp and
// darker just behind each head; the heads themselves (on steel blue-green at the front, olive behind; on
// aluminium grey). Over it the coating: a tinted clear lacquer, lifted into ridges over the tails and bulging
// over the heads, or opaque paint whose ridges show in raking light and crack along old tails. Where the coating
// is cut the metal is bare, and corrodes in the groove; salt sits on top as crystals. Relief is a height made of
// the same layers, turned into normals by screen-space differences, one under the coating and one on top of it.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uniform, texture, uv, mix, smoothstep, clamp, select, max, exp, dot, cross, normalize, dFdx, dFdy, sign, abs, floor,
  positionView, normalView, mx_noise_float, mx_worley_noise_float } from 'three/tsl';
import { PANEL } from './sim.js';

const C = (r, g, b) => vec3(r, g, b);

export function makeLook() {
  return {
    now: uniform(0), // days since the epoch the birth channel is written from
    wetDays: uniform(0), // humid days so far, for the bare metal in scratches
    paint: uniform(new THREE.Color(0.86, 0.85, 0.8)),
    hole: uniform(new THREE.Vector3(0, 0, -1)), // a hole through the panel: centre and radius in mm (r < 0: none)
  };
}

// B-spline bicubic from four bilinear fetches: smooth enough that a ridge a few cells wide gives smooth normals
const bicubic = (tex, q, size) => {
  const st = q.mul(size).sub(0.5), i = floor(st), f = st.sub(i);
  const f2 = f.mul(f), f3 = f2.mul(f);
  const w0 = float(1).sub(f).pow(3).div(6), w1 = f3.mul(3).sub(f2.mul(6)).add(4).div(6);
  const w2 = f3.mul(-3).add(f2.mul(3)).add(f.mul(3)).add(1).div(6), w3 = f3.div(6);
  const g0 = w0.add(w1), g1 = w2.add(w3);
  const h0 = i.sub(0.5).add(w1.div(g0)), h1 = i.add(1.5).add(w3.div(g1));
  const t00 = texture(tex, vec2(h0.x, h0.y).div(size)), t10 = texture(tex, vec2(h1.x, h0.y).div(size));
  const t01 = texture(tex, vec2(h0.x, h1.y).div(size)), t11 = texture(tex, vec2(h1.x, h1.y).div(size));
  return mix(mix(t00, t10, g1.x), mix(t01, t11, g1.x), g1.y);
};

export function surfaceMaterial({ texA, texB, look, piece, P, NX, NY }) {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.3, metalness: 0 });
  const size = vec2(NX, NY), dimsMm = vec2(PANEL.W, PANEL.H);
  const steel = P.metal === 'steel', paint = P.coat === 'paint';
  const q0 = uv();

  // the layers at uv q, for the colour and for the heights a screen pixel away
  const layers = (q) => {
    const A = bicubic(texA, q, size);
    const pm = q.mul(dimsMm);
    const tail = A.x.max(0), head = A.y.max(0), def = A.z.clamp(0, 1);
    const n1 = mx_noise_float(vec3(pm.mul(1.3), 1.0)), n2 = mx_noise_float(vec3(pm.mul(11), 2.0));
    const cov = smoothstep(0.06, 0.38, tail);
    // salt crystals: little cubes where the salt is
    const salt = texture(texB, q).x;
    const wc = mx_worley_noise_float(vec3(pm.mul(9), 3.0));
    const crystal = smoothstep(0.24, 0.1, wc).mul(smoothstep(0.08, 0.55, salt.mul(n1.mul(0.3).add(0.85))));
    // the groove of a scratch: deepest in the middle
    const groove = smoothstep(0.25, 1, def);
    // heights in scene units (1 = 10 mm), much exaggerated: the coating's top, and what is under it
    const hTop = tail.mul(0.003).add(head.mul(0.0045)).sub(groove.mul(0.0018)).add(crystal.mul(0.0012))
      .add(paint ? mx_noise_float(vec3(pm.mul(3.2), 4.0)).mul(0.00004) : float(0));
    const hUnder = hTop.add(cov.mul(n2.mul(0.00025))).add(groove.mul(n2.mul(0.0002)));
    return { A, tail, head, def, cov, salt, crystal, groove, n1, n2, hTop, hUnder, pm };
  };
  const L = layers(q0), dqx = dFdx(q0), dqy = dFdy(q0);
  const Lx = layers(q0.add(dqx)), Ly = layers(q0.add(dqy));
  const B = texture(texB, q0);
  const rear = B.y, act = B.z, hue = B.w;

  // ---- under the coating
  const pm = L.pm;
  const brushed = mx_noise_float(vec3(pm.x.mul(0.35), pm.y.mul(48), 5.0));
  const metal = steel ? C(0.86, 0.86, 0.87).mul(brushed.mul(0.05).add(1)) : C(0.9, 0.91, 0.92).mul(brushed.mul(0.025).add(1));
  const metalRough = steel ? float(0.2).add(brushed.mul(0.04)) : float(0.1).add(brushed.mul(0.02));
  // how long ago each bit of tail was laid (days); the birth channel is premultiplied by the tail
  const age = look.now.sub(L.A.w.div(L.tail.max(1e-3))).max(0);
  const ox = float(1).sub(exp(age.div(-2.5))), old = smoothstep(15, 160, age);
  const grain = L.n2.mul(0.5).add(0.5);
  let product;
  if (steel) {
    const red = mix(C(0.34, 0.1, 0.035), C(0.19, 0.06, 0.024), old);
    product = mix(C(0.05, 0.055, 0.04), red, ox).mul(hue.mul(0.3).add(0.85)).mul(grain.mul(0.4).add(0.8));
    product = product.mul(mix(float(1), float(0.62), smoothstep(0.55, 1.0, L.tail)));
    // the thin edge of a tail, where the product is a film: a lighter, more orange line
    product = mix(product, C(0.5, 0.2, 0.06), L.cov.mul(float(1).sub(smoothstep(0.25, 0.6, L.tail))).mul(ox).mul(0.5));
  } else {
    product = mix(C(0.46, 0.47, 0.47), C(0.84, 0.84, 0.82), ox).mul(grain.mul(0.25).add(0.85)).mul(hue.mul(0.1).add(0.95));
    product = product.mul(select(L.n2.greaterThan(0.55), float(0.72), float(1)));
  }
  const wet = exp(age.div(-0.3)).mul(L.cov);
  product = product.mul(float(1).sub(wet.mul(0.45)));
  let col = mix(metal, product, L.cov);
  let rough = mix(metalRough, mix(float(0.85), float(0.35), wet), L.cov);
  let metalness = float(1).sub(L.cov);
  // the heads
  const hm = smoothstep(0.03, 0.3, L.head);
  const front = steel ? C(0.05, 0.24, 0.23) : C(0.6, 0.63, 0.63), back = steel ? C(0.13, 0.14, 0.05) : C(0.45, 0.46, 0.45);
  let headC = mix(front, back, smoothstep(0.15, 0.95, rear));
  headC = mix(headC.mul(steel ? C(0.6, 0.55, 0.5) : C(0.8, 0.8, 0.8)), headC, act);
  col = mix(col, headC, hm); rough = mix(rough, float(0.2), hm); metalness = metalness.mul(float(1).sub(hm));

  // ---- the bare metal in a cut: bright where freshly cut, corroding with the humid days and the salt in it
  const cut = smoothstep(0.35, 0.75, L.def);
  const cutCorr = clamp(look.wetDays.mul(0.012).mul(L.salt.add(0.3)).mul(L.n1.mul(0.5).add(0.9)), 0, 1);
  const cutRust = steel ? mix(C(0.35, 0.13, 0.04), C(0.18, 0.07, 0.03), L.n2.mul(0.5).add(0.5)) : C(0.78, 0.78, 0.76);
  const inCut = mix(metal.mul(steel ? 1.05 : 1.02).mul(float(1).sub(L.groove.mul(0.25))), cutRust, cutCorr.mul(smoothstep(-0.2, 0.4, L.n2)));
  const inRough = mix(float(0.28), float(0.9), cutCorr), inMetal = float(1).sub(cutCorr);
  const coatOn = float(1).sub(cut);

  // ---- the coating
  let clearcoat;
  if (paint) {
    const pc = look.paint;
    // ridges stain the paint a little over steel; on aluminium the white product barely shows through
    let pcol = steel ? mix(pc, pc.mul(C(0.82, 0.66, 0.5)), L.cov.mul(old).mul(0.5)) : mix(pc, pc.mul(0.93), L.cov.mul(0.4));
    pcol = mix(pcol, pcol.mul(0.85), hm.mul(0.5));
    // old ridges crack along their crest and show the product
    const crack = L.cov.mul(smoothstep(0.62, 0.95, L.tail)).mul(smoothstep(20, 140, age)).mul(smoothstep(0.1, 0.5, L.n2.add(L.n1.mul(0.5))));
    pcol = mix(pcol, product, crack);
    col = mix(inCut, pcol, coatOn); rough = mix(inRough, mix(float(0.42), float(0.9), crack), coatOn); metalness = mix(inMetal, float(0), coatOn);
    clearcoat = coatOn.mul(0.35);
  } else {
    // a clear coat: gold lacquer on the tinplate, water-clear on the wheel
    const tint = steel ? C(1.0, 0.66, 0.24) : C(0.98, 0.98, 0.97);
    col = mix(inCut, col.mul(tint), coatOn); rough = mix(inRough, rough, coatOn); metalness = mix(inMetal, metalness, coatOn);
    clearcoat = coatOn;
  }
  // the cut edge of the coating is a thin dark line
  const edge = smoothstep(0.08, 0.3, L.def).mul(smoothstep(0.6, 0.3, L.def));
  col = col.mul(float(1).sub(edge.mul(0.35)));
  // salt on top of everything
  col = mix(col, C(0.93, 0.93, 0.91), L.crystal); rough = mix(rough, float(0.45), L.crystal); metalness = metalness.mul(float(1).sub(L.crystal));
  clearcoat = clearcoat.mul(float(1).sub(L.crystal));

  // ---- normals from the heights (Mikkelsen's surface gradient)
  const normalFrom = (h, hx, hy) => Fn(() => {
    const pv = positionView, sx = dFdx(pv), sy = dFdy(pv), n0 = normalView;
    const r1 = cross(sy, n0), r2 = cross(n0, sx), det = dot(sx, r1);
    const grad = sign(det).mul(r1.mul(hx.sub(h)).add(r2.mul(hy.sub(h))));
    return normalize(abs(det).mul(n0).sub(grad));
  })();
  const nTop = normalFrom(L.hTop, Lx.hTop, Ly.hTop);
  const nUnder = paint ? nTop : normalFrom(L.hUnder, Lx.hUnder, Ly.hUnder);

  m.colorNode = col;
  m.roughnessNode = clamp(rough, 0.04, 1);
  m.metalnessNode = clamp(metalness, 0, 1);
  m.normalNode = nUnder;
  m.clearcoatNode = clearcoat;
  m.clearcoatRoughnessNode = float(paint ? 0.25 : 0.035);
  m.clearcoatNormalNode = nTop;
  // a hole drilled through
  const hole = look.hole;
  m.opacityNode = select(pm.sub(hole.xy).length().lessThan(hole.z), float(0), float(1));
  m.alphaTest = 0.5;
  return m;
}

// the bench under the panel: dark linen
export function benchMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  const p = uv().mul(vec2(400, 400));
  const weave = mx_noise_float(vec3(p.x.mul(1.0), p.y.mul(0.08), 1)).mul(0.5).add(mx_noise_float(vec3(p.x.mul(0.08), p.y.mul(1.0), 2)).mul(0.5));
  const blot = mx_noise_float(vec3(uv().mul(9), 3));
  m.colorNode = C(0.075, 0.07, 0.065).mul(weave.mul(0.18).add(1)).mul(blot.mul(0.12).add(1));
  return m;
}

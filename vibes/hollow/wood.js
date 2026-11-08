// wood.js - solid (volumetric) wood in TSL. The figure is a function of the piece's own
// object-space position, so it runs through the carving the way real grain does: rings
// show as arcs and ellipses where a cut crosses them, end grain where a hole runs along the
// fibres. Growth rings with soft earlywood and dense latewood (per-ring colour and width),
// wobble from slow 3D noise, long heartwood streaks, ray flecks (radial ribbons), pores as
// short dashes along the grain that are sunk into the surface (bump) and rougher, curl figure
// that shifts with the view angle (chatoyance), spalting zone lines, darker end grain. The
// finish is a clearcoat over it: oil, wax, lacquer or bare. Baked occlusion from the mesher
// (see sdf.js) dims indirect light inside the hollows and settles a little grime there.
import * as THREE from 'three/webgpu';
import { uniform, attribute, positionGeometry, normalGeometry, normalView, positionView, vec2, vec3, float, mix, smoothstep, fract, floor,
  length, abs, pow, dot, cross, sin, atan, hash, fwidth, mx_noise_float, mx_fractal_noise_float, normalize, max } from 'three/tsl';

// colours as sRGB hex; THREE.Color converts them to linear
export const SPECIES = {
  walnut: { name: 'Black walnut', early: '#7a5236', late: '#3c2416', ray: '#8a5f40', streak: '#2a180e', streakAmt: 0.55, density: 52, warp: 0.06, warpFreq: 1.4, pore: 0.75, poreScale: 520, rayAmt: 0.12, rayFreq: 140, figure: 0.25, figFreq: 70, contrast: 0.85, rough: 0.5, endDark: 0.62 },
  oak: { name: 'White oak', early: '#c7a06d', late: '#8f6a3f', ray: '#e4c898', streak: '#9a7848', streakAmt: 0.25, density: 38, warp: 0.05, warpFreq: 1.2, pore: 1.0, poreScale: 380, rayAmt: 0.6, rayFreq: 45, figure: 0.0, figFreq: 60, contrast: 0.9, rough: 0.58, endDark: 0.6 },
  cherry: { name: 'Cherry', early: '#b9724c', late: '#8e4b2c', ray: '#c27d55', streak: '#6e3420', streakAmt: 0.3, density: 58, warp: 0.07, warpFreq: 1.3, pore: 0.25, poreScale: 700, rayAmt: 0.18, rayFreq: 160, figure: 0.3, figFreq: 80, contrast: 0.6, rough: 0.48, endDark: 0.68 },
  maple: { name: 'Curly maple', early: '#ead6b0', late: '#d2b386', ray: '#f0dfbf', streak: '#c9a878', streakAmt: 0.2, density: 54, warp: 0.04, warpFreq: 1.0, pore: 0.08, poreScale: 800, rayAmt: 0.2, rayFreq: 180, figure: 1.0, figFreq: 95, contrast: 0.4, rough: 0.45, endDark: 0.75 },
  olive: { name: 'Olive', early: '#d4bd8c', late: '#6b4f2e', ray: '#d9c49a', streak: '#3d2a18', streakAmt: 0.75, density: 40, warp: 0.17, warpFreq: 1.7, pore: 0.15, poreScale: 750, rayAmt: 0.05, rayFreq: 150, figure: 0.15, figFreq: 50, contrast: 0.75, rough: 0.44, endDark: 0.7 },
  zebrano: { name: 'Zebrawood', early: '#ddc690', late: '#4a3320', ray: '#e2cc9a', streak: '#3a2816', streakAmt: 0.15, density: 30, warp: 0.03, warpFreq: 0.8, pore: 0.5, poreScale: 420, rayAmt: 0.05, rayFreq: 150, figure: 0.2, figFreq: 50, contrast: 1.0, rough: 0.5, endDark: 0.65 },
  padauk: { name: 'Padauk', early: '#bb4a2c', late: '#7c2818', ray: '#c45a38', streak: '#5e1a10', streakAmt: 0.35, density: 50, warp: 0.06, warpFreq: 1.3, pore: 0.6, poreScale: 480, rayAmt: 0.1, rayFreq: 150, figure: 0.25, figFreq: 70, contrast: 0.65, rough: 0.5, endDark: 0.66 },
  ash: { name: 'Ash', early: '#dccaa4', late: '#a38a5e', ray: '#e6d6b4', streak: '#b49a6c', streakAmt: 0.2, density: 30, warp: 0.05, warpFreq: 1.1, pore: 0.95, poreScale: 360, rayAmt: 0.1, rayFreq: 150, figure: 0.1, figFreq: 60, contrast: 0.85, rough: 0.56, endDark: 0.66 },
  spalted: { name: 'Spalted beech', early: '#e6d6b8', late: '#cdb995', ray: '#d8c5a2', streak: '#b5a07c', streakAmt: 0.35, density: 52, warp: 0.08, warpFreq: 1.4, pore: 0.1, poreScale: 800, rayAmt: 0.45, rayFreq: 220, figure: 0.0, figFreq: 60, contrast: 0.4, rough: 0.52, endDark: 0.72, spalt: 1 },
};
export const FINISHES = {
  oil: { name: 'Danish oil', clearcoat: 0.45, ccRough: 0.32, wet: 0.7, rough: 1.0 },
  wax: { name: 'Beeswax', clearcoat: 0.25, ccRough: 0.5, wet: 0.45, rough: 0.9 },
  lacquer: { name: 'Lacquer', clearcoat: 1.0, ccRough: 0.035, wet: 0.8, rough: 0.85 },
  bare: { name: 'Bare, sanded', clearcoat: 0.0, ccRough: 0.6, wet: 0.0, rough: 1.25 },
};

export function makeWood() {
  const U = {
    early: uniform(new THREE.Color()), late: uniform(new THREE.Color()), ray: uniform(new THREE.Color()), streak: uniform(new THREE.Color()),
    streakAmt: uniform(0.4), density: uniform(28), warp: uniform(0.06), warpFreq: uniform(1.3), pore: uniform(0.6), poreScale: uniform(500),
    rayAmt: uniform(0.2), rayFreq: uniform(150), figure: uniform(0), figFreq: uniform(70), contrast: uniform(0.8), rough: uniform(0.5),
    endDark: uniform(0.65), spalt: uniform(0), wet: uniform(0.6), roughMul: uniform(1), bump: uniform(0.0005),
    rot: uniform(new THREE.Matrix3()), pith: uniform(new THREE.Vector3()), seed: uniform(0),
  };
  const ao = attribute('ao', 'float'), curv = attribute('curv', 'float');

  // log space: y along the fibres, the pith on the y axis
  const q0 = U.rot.mul(positionGeometry.sub(U.pith));
  const wp = vec3(q0.x, q0.y.mul(0.22), q0.z).mul(U.warpFreq).add(U.seed);
  const q = q0.add(vec3(mx_fractal_noise_float(wp, 3, 2, 0.5, 1), 0, mx_fractal_noise_float(wp.add(17.3), 3, 2, 0.5, 1)).mul(U.warp));
  const r = length(q.xz).add(mx_noise_float(vec3(q.x.mul(7), q.y.mul(1.3), q.z.mul(7)).add(U.seed)).mul(0.01));

  // growth rings: earlywood ramps into a dense late band, a sharp edge to the next year
  // ring widths vary from year to year: a slow drift in the ring count with radius
  const rings = r.mul(U.density).add(mx_noise_float(vec3(r.mul(U.density).mul(0.12), q.y.mul(0.25), U.seed)).mul(3.0));
  const ri = floor(rings), t = fract(rings);
  const rh = hash(ri.add(U.seed.mul(13.1)));
  const lwRaw = smoothstep(rh.mul(-0.3).add(0.5), 0.95, t).pow(1.5).mul(smoothstep(1.0, 0.975, t));
  const ringAA = smoothstep(0.3, 0.9, fwidth(rings)); // rings finer than a pixel blend to their mean
  const lw = mix(lwRaw, float(0.32), ringAA);
  let col = mix(U.early, U.late, lw.mul(U.contrast)).mul(rh.sub(0.5).mul(mix(0.25, 0.05, ringAA)).add(1));

  // fibres: fine streaks running along the grain, a few percent either way
  const fib = mx_noise_float(vec3(q.x.mul(160), q.y.mul(3), q.z.mul(160)).add(U.seed)).mul(smoothstep(1.5, 0.4, fwidth(q.x.mul(160)).add(fwidth(q.z.mul(160)))));
  col = col.mul(fib.mul(0.14).add(1)).mul(mx_noise_float(vec3(q.x.mul(40), q.y.mul(0.8), q.z.mul(40))).mul(0.08).add(1));

  // heartwood streaks and colour drift, long along the grain
  const st = mx_fractal_noise_float(vec3(q.x.mul(1.7), q.y.mul(0.16), q.z.mul(1.7)).add(U.seed.add(5)), 2, 2, 0.5, 1);
  col = mix(col, U.streak, smoothstep(0.02, 0.42, st).mul(U.streakAmt));

  // ray flecks: ribbons in planes through the pith, thin across, short along the grain
  const arc = atan(q.z, q.x).mul(r).mul(U.rayFreq);
  const rayN = mx_noise_float(vec3(arc, r.mul(2), q.y.mul(9)).add(U.seed));
  const ray = smoothstep(0.45, 0.7, rayN).mul(U.rayAmt).mul(smoothstep(1.6, 0.5, fwidth(arc)));
  col = mix(col, U.ray, ray);

  // pores: short dashes along the fibres, most in the earlywood
  const pp = vec3(q.x, q.y.mul(0.07), q.z).mul(U.poreScale);
  const poreAA = smoothstep(1.4, 0.45, fwidth(pp.x).add(fwidth(pp.z)));
  const pore = smoothstep(0.3, 0.62, mx_noise_float(pp)).mul(lw.mul(-0.7).add(1)).mul(U.pore);
  col = col.mul(pore.mul(poreAA).mul(-0.5).add(1)).mul(pore.mul(poreAA.oneMinus()).mul(-0.12).add(1));

  // curl: stripes across the grain whose brightness flips with the angle you see them at
  const curl = sin(q.y.mul(U.figFreq).add(mx_noise_float(q.mul(3).add(U.seed)).mul(3.5)));
  const facing = dot(normalView, positionView.normalize().negate());
  col = col.mul(curl.mul(U.figure).mul(facing.sub(0.55)).mul(0.7).add(1));

  // spalting: black zone lines between fungal colonies, bleached patches
  const sz = mx_noise_float(positionGeometry.mul(2.1).add(U.seed.add(3.1)));
  col = mix(col, U.early.mul(1.08), smoothstep(0.08, 0.4, sz).mul(U.spalt).mul(0.45));
  col = mix(col, vec3(0.025, 0.018, 0.012), smoothstep(0.03, 0.0, abs(sz)).mul(U.spalt));
  const sz2 = mx_noise_float(positionGeometry.mul(4.3).add(U.seed.add(9.7)));
  col = mix(col, vec3(0.03, 0.02, 0.014), smoothstep(0.02, 0.0, abs(sz2)).mul(U.spalt).mul(0.7));

  // end grain soaks up finish and reads darker and duller
  const ng = normalize(U.rot.mul(normalGeometry));
  const endg = smoothstep(0.5, 0.95, abs(ng.y));
  col = col.mul(mix(float(1), U.endDark, endg));

  // finish: oil deepens the colour; hollows hold a little grime and old wax
  col = mix(col, pow(col, vec3(1.22)), U.wet);
  col = col.mul(mix(0.72, 1.0, ao)).mul(mix(0.85, 1.0, smoothstep(-0.6, -0.05, curv)));

  const rough = U.rough.mul(U.roughMul).mul(pore.mul(0.6).add(1)).mul(mix(1, 0.85, lw)).mul(mix(1, 1.3, endg)).clamp(0.2, 0.95);

  // bump: pores sink, latewood stands a hair proud after sanding, rays catch the light
  const height = pore.mul(poreAA).mul(-0.7).add(lw.mul(0.06)).add(ray.mul(0.2)).mul(U.bump);
  const dpdx = positionView.dFdx(), dpdy = positionView.dFdy();
  const r1 = cross(dpdy, normalView), r2 = cross(normalView, dpdx), det = dot(dpdx, r1);
  const dh = vec2(height.dFdx(), height.dFdy());
  const bumped = normalize(abs(det).mul(normalView).sub(det.sign().mul(dh.x.mul(r1).add(dh.y.mul(r2)))));

  const mat = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.5, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.3, specularIntensity: 0.5 });
  mat.colorNode = col;
  mat.roughnessNode = rough;
  mat.normalNode = bumped;
  mat.aoNode = ao;

  // grain orientation: a turned vessel has the pith on its axis; carvings come from a plank
  // or a log section somewhere off to the side, so their rings arc across the piece
  function setGrain(spec, r) {
    const m = new THREE.Matrix4(), axis = new THREE.Vector3();
    let pith;
    if (spec.base.kind === 'vessel' && r() < 0.6) { axis.set(r() * 0.1 - 0.05, 1, r() * 0.1 - 0.05); pith = new THREE.Vector3(r() * 0.1 - 0.05, 0, r() * 0.1 - 0.05); }
    else {
      const along = r();
      if (along < 0.55) axis.set(r() * 0.3 - 0.15, 1, r() * 0.3 - 0.15);
      else if (along < 0.85) axis.set(1, r() * 0.3 - 0.15, r() * 0.3 - 0.15);
      else axis.set(r() * 0.3 - 0.15, r() * 0.3 - 0.15, 1);
      const a = r() * Math.PI * 2, d = 0.3 + r() * 1.6;
      pith = new THREE.Vector3(Math.cos(a) * d, 0, Math.sin(a) * d);
    }
    axis.normalize();
    // rotation taking the axis to +y
    const qn = new THREE.Quaternion().setFromUnitVectors(axis, new THREE.Vector3(0, 1, 0));
    m.makeRotationFromQuaternion(qn);
    U.rot.value.setFromMatrix4(m);
    // pith given in log space so it stays off to the side of the rotated piece
    U.pith.value.copy(pith.applyQuaternion(qn.clone().invert()));
    U.seed.value = r() * 50;
  }
  function setSpecies(key) {
    const s = SPECIES[key];
    for (const k of ['early', 'late', 'ray', 'streak']) U[k].value.set(s[k]);
    for (const k of ['streakAmt', 'density', 'warp', 'warpFreq', 'pore', 'poreScale', 'rayAmt', 'rayFreq', 'figure', 'figFreq', 'contrast', 'rough', 'endDark']) U[k].value = s[k];
    U.spalt.value = s.spalt || 0;
  }
  function setFinish(key) {
    const f = FINISHES[key];
    mat.clearcoat = f.clearcoat; mat.clearcoatRoughness = f.ccRough; U.wet.value = f.wet; U.roughMul.value = f.rough;
  }
  return { mat, U, setGrain, setSpecies, setFinish };
}

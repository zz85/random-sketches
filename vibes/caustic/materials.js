// materials.js - procedural surfaces in TSL: the corridor's planked wood, Wallace's warm concrete, leather,
// dark lacquer and the black water of the hall.
import * as THREE from 'three/webgpu';
import { Fn, vec2, vec3, float, positionWorld, normalWorld, abs, mix, smoothstep, fract, floor, mx_noise_float, mx_fractal_noise_float, mx_worley_noise_float, bumpMap, hash, select, color, uniform, reflector, time, sin, normalView, positionLocal } from 'three/tsl';

// world-space coordinates on the face a fragment is on: (along, up) for walls, (x, z) for floors
const faceUVBox = Fn(() => {
  const n = abs(normalWorld), p = positionWorld;
  return select(n.y.greaterThan(0.6), p.xz, select(n.x.greaterThan(n.z), p.zy, p.xy));
});

// planks laid horizontally, as in the corridor: long streaky grain, a plank every `h` metres, dark joints
const faceUV = faceUVBox;
export function wood({ base = 0x6b4422, light = 0xb07a3e, h = 0.16, rough = 0.55, gloss = false } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: rough, metalness: 0 });
  const A = color(base), B = color(light);
  m.colorNode = Fn(() => {
    const uv = faceUV(), row = floor(uv.y.div(h)), f = fract(uv.y.div(h));
    const shift = hash(row).mul(40);
    const streak = mx_fractal_noise_float(vec3(uv.x.mul(0.35).add(shift), uv.y.mul(55), row.mul(3.1)), 3, 2.0, 0.5).mul(0.5).add(0.5);
    const fine = mx_noise_float(vec3(uv.x.mul(2.5), uv.y.mul(240), row)).mul(0.5).add(0.5);
    const tone = hash(row.add(17)).mul(0.35).add(0.75);
    const joint = smoothstep(0.0, 0.05, f).mul(smoothstep(1.0, 0.95, f));
    const c = mix(A, B, streak.mul(0.75).add(fine.mul(0.25))).mul(tone);
    return c.mul(joint.mul(0.75).add(0.25));
  })();
  m.roughnessNode = Fn(() => float(rough).add(mx_noise_float(vec3(faceUV().mul(vec2(1, 40)), 0)).mul(0.12)))();
  return m;
}

// Wallace's walls and floor: warm, smooth cast concrete, faint blotches, panel seams every `panel` metres
export function concrete({ base = 0x8a6a3a, panel = [3, 3], rough = 0.6, seam = 0.35 } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: rough, metalness: 0 });
  const A = color(base);
  m.colorNode = Fn(() => {
    const uv = faceUV();
    const blot = mx_fractal_noise_float(vec3(uv.mul(0.6), 1), 4, 2, 0.5).mul(0.18).add(1);
    const pores = mx_noise_float(vec3(uv.mul(30), 2)).mul(0.04);
    const g = fract(uv.div(vec2(...panel))), e = vec2(...panel).mul(g.min(g.oneMinus()));
    const s = smoothstep(0.0, 0.012, e.x.min(e.y));
    return A.mul(blot.add(pores)).mul(s.mul(seam).add(1 - seam));
  })();
  m.roughnessNode = Fn(() => float(rough).add(mx_noise_float(vec3(faceUV().mul(0.8), 4)).mul(0.15)))();
  return m;
}

// The one wall surface of all three sets: rough board-formed concrete. Broad blotches and stains, sandy grit,
// small air pits, tall panel seams, and the same height field bumped into the normal so a raking caustic
// catches the grain. Its colour is a neutral warm grey: the gold comes from the lamps and the grade.
// `uvm`: the surface's own coordinates in metres, for a curved wall, where the box-style projection by the normal
// would jump between axes and break the panels into facets
export function rough({ base = 0x76694e, panel = [1.5, 3.2], seam = 0.3, rough = 0.88, bump = 1, scale = 1, uvm = null } = {}) {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: rough, metalness: 0 });
  const faceUV = uvm ? Fn(() => uvm) : faceUVBox;
  const A = color(base);
  const parts = Fn(() => {
    const uv = faceUV().mul(scale);
    const blot = mx_fractal_noise_float(vec3(uv.mul(0.45), 1), 4, 2, 0.5);
    const grit = mx_fractal_noise_float(vec3(uv.mul(38), 3), 3, 2.1, 0.55);
    const pit = smoothstep(0.08, 0.02, mx_worley_noise_float(vec3(uv.mul(11), 5)));
    const board = mx_noise_float(vec3(uv.x.mul(0.6), uv.y.mul(9), 7)); // faint horizontal formwork streaks
    return vec3(blot, grit, pit).add(vec3(0, board.mul(0.4), 0));
  });
  const seamOf = Fn(() => { const g = fract(faceUV().div(vec2(...panel))), e = vec2(...panel).mul(g.min(g.oneMinus())); return smoothstep(0.0, 0.01, e.x.min(e.y)); });
  m.colorNode = Fn(() => {
    const q = parts();
    return A.mul(q.x.mul(0.22).add(1)).mul(q.y.mul(0.12).add(1)).mul(q.z.mul(-0.45).add(1)).mul(seamOf().mul(seam).add(1 - seam));
  })();
  m.normalNode = bumpMap(Fn(() => { const q = parts(); return q.y.mul(0.5).add(q.x.mul(0.2)).sub(q.z.mul(0.8)).add(seamOf().mul(0.6)); })(), 0.012 * bump);
  m.roughnessNode = Fn(() => float(rough).add(parts().y.mul(0.06)))();
  return m;
}

export function plain(c, rough = 0.5, metal = 0) { return new THREE.MeshStandardNodeMaterial({ color: c, roughness: rough, metalness: metal }); }

// leather: a soft sheen and a fine pebble
export function leather(c, rough = 0.42) {
  const m = new THREE.MeshPhysicalNodeMaterial({ color: c, roughness: rough, sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xffe2bc) });
  m.roughnessNode = Fn(() => float(rough).add(mx_noise_float(positionWorld.mul(90)).mul(0.08)))();
  return m;
}

// black, still water that mirrors the room, with slow fine ripples bending the reflection
export function water(scene, { size = 200, y = 0, ripple = 0.012 } = {}) {
  const r = reflector({ resolutionScale: 0.5 });
  r.target.rotateX(-Math.PI / 2); r.target.position.y = y; scene.add(r.target);
  const wob = Fn(() => {
    const p = positionWorld.xz;
    const a = mx_noise_float(vec3(p.mul(0.9), time.mul(0.25))), b = mx_noise_float(vec3(p.mul(2.7).add(9), time.mul(0.4)));
    return vec2(a, b).mul(ripple);
  });
  r.uvNode = r.uvNode.add(wob());
  const m = new THREE.MeshStandardNodeMaterial({ color: 0x010101, roughness: 0.08, metalness: 0 });
  m.emissiveNode = r.rgb.mul(0.35);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), m);
  mesh.rotation.x = -Math.PI / 2; mesh.position.y = y; mesh.receiveShadow = true;
  return { mesh, reflector: r };
}

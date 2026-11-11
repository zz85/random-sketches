/*
 * scenes.js - the three sets, after Blade Runner 2049's Wallace building, each lit as Deakins lit it: big lamps
 * aimed into water so that the reflections, not the lamps, light the room. Here each reflection is a spot light
 * carrying a live caustic (caustics.js), with shadows.
 *
 *   corridor - the planked wooden corridor with stairs up to a receding frame of portals, its walls streaked with
 *              thin moving lines of light that come in steeply from above.
 *   office   - Wallace's office: a warm concrete box with a skylight over water, a long desk, white chairs, broad
 *              slow ribbons of light over the walls and the floor.
 *   hall     - the hall of water: a black flooded floor, a wooden platform with two chairs, stepping stones, a
 *              slit of light overhead, fine ripples climbing the far curved walls.
 *
 * Each returns { group, caustics, lights, shots, look, update(t) }; `shots` are slow camera moves (from, to, aim
 * from, aim to, seconds, fov).
 */
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { texture, uv, vec3, vec2, time, Fn, color, float } from 'three/tsl';
import { Caustics, causticSpot, bounce } from './caustics.js';
import { wood, rough, plain, leather, water } from './materials.js';

// One palette for the three sets, as in the film: the same gold lamps (tungsten through warm gels), the same rough
// concrete, the same grade (each colour pulled toward its luminance times this gold; sat is how much survives).
const GOLD = 0xffb840, GOLD2 = 0xffc050;
const GRADE = { tint: [1.0, 0.7, 0.14], sat: 0.88 };
const CONCRETE = 0x8a7c62, BOUNCE = 0x8a7656;

function box(g, w, h, d, mat, x, y, z, { cast = true, receive = true, round = 0 } = {}) {
  const geo = round ? new RoundedBoxGeometry(w, h, d, 3, round) : new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = cast; m.receiveShadow = receive; g.add(m); return m;
}
function aim(g, light, from, to) {
  light.position.set(...from); light.target.position.set(...to); g.add(light, light.target); return light;
}

// a mid-century armchair: cushion, back, arms, slim legs
function armchair(g, mat, legMat, x, z, ry, s = 1) {
  const c = new THREE.Group(); c.position.set(x, 0, z); c.rotation.y = ry; c.scale.setScalar(s); g.add(c);
  box(c, 0.82, 0.16, 0.74, mat, 0, 0.42, 0.03, { round: 0.05 });
  box(c, 0.82, 0.5, 0.14, mat, 0, 0.72, -0.33, { round: 0.06 });
  for (const sx of [-1, 1]) box(c, 0.12, 0.3, 0.78, mat, sx * 0.43, 0.56, 0, { round: 0.05 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(c, 0.04, 0.34, 0.04, legMat, sx * 0.36, 0.17, sz * 0.3);
  return c;
}

// ---------------------------------------------------------------- the corridor

export function corridor(renderer, { phone = false } = {}) {
  const g = new THREE.Group(), W = 5.4, H = 5.6, z0 = 3, z1 = -10.6;
  const planks = rough({ panel: [1.6, 6] });
  const floorWood = rough({ base: 0x6e6450, panel: [2.7, 2.7], rough: 0.75 });
  const dark = plain(0x0a0705, 0.9);
  // floor, walls (with the dark seams between their tall panels)
  box(g, W, 0.1, z0 - z1, floorWood, 0, -0.05, (z0 + z1) / 2, { cast: false });
  for (const s of [-1, 1]) {
    box(g, 0.2, H, z0 - z1, planks, s * (W / 2 + 0.1), H / 2, (z0 + z1) / 2);
    for (let z = z0 - 2.6; z > z1; z -= 2.9) box(g, 0.03, H, 0.035, dark, s * W / 2, H / 2, z, { cast: false });
  }
  // the stairs: eight steps, a little narrower than the corridor, up to a landing
  const sw = W - 0.8, rise = 0.19, tread = 0.36, zs = -5.2;
  for (let i = 0; i < 8; i++) {
    const zf = zs - i * tread;
    box(g, sw, rise * (i + 1), tread + 0.04, floorWood, 0, rise * (i + 1) / 2, zf - tread / 2);
    box(g, sw + 0.02, 0.03, 0.05, dark, 0, rise * (i + 1) + 0.005, zf, { cast: false }); // nosing shadow line
  }
  const top = rise * 8, zl = zs - 8 * tread;
  box(g, W, top, zl - z1 + 0.6, floorWood, 0, top / 2, (zl + z1 - 0.6) / 2);
  // the portal: rectangular frames, each a little smaller and further, down to a black door
  const zp = zl - 0.6;
  for (let k = 0; k < 7; k++) {
    const fw = W - 0.3 * k - 0.15, fh = H - top - 0.25 * k - 0.3, z = zp - 0.22 * k, cy = top + fh / 2 + 0.06 * k, t = 0.14;
    const fr = new THREE.Group(); fr.position.set(0.04 * k, cy, z); fr.rotation.z = 0.012 * k; g.add(fr);
    box(fr, fw, t, 0.18, planks, 0, fh / 2, 0); box(fr, fw, t, 0.18, planks, 0, -fh / 2, 0);
    box(fr, t, fh, 0.18, planks, -fw / 2, 0, 0); box(fr, t, fh, 0.18, planks, fw / 2, 0, 0);
  }
  const zd = zp - 1.7;
  box(g, 2.9, 1.6, 0.1, plain(0x000000, 1), 0.3, top + 1.2, zd, { cast: false });
  box(g, W, H, 0.3, planks, 0, H / 2, zd - 0.2); // the wall around it
  // the roof: open above most of the corridor, crossed by slanting beams, with a ceiling over the portal
  for (let k = 0; k < 6; k++) { const b = box(g, W + 0.6, 0.16, 0.28, planks, 0, H + 0.3, z0 - 1.4 - k * 2.25); b.rotation.y = 0.5; }
  const beam = box(g, 0.22, 0.22, 4.2, planks, -0.6, H - 0.6, zp - 0.8); beam.rotation.set(0.5, 0.35, 0.4);
  box(g, W + 0.4, 0.2, 2.8, planks, 0, H + 0.1, zp - 0.5);
  box(g, 20, 0.2, 30, dark, 0, H + 3.2, -4, { cast: false }); // a dark sky over it all, for the haze to end on

  // light: steep reflections from above, from either side and from behind, all off one sloshing trough
  const lines = new Caustics(renderer, { kMin: 2, kMax: 9, amp: 1.0, depth: 0.0675, speed: 0.55, dir: 0.3, spread: 1.1, grid: phone ? 160 : 256, seed: 3 });
  const sh = phone ? 512 : 1024;
  const L = [
    aim(g, causticSpot(lines, { color: GOLD, intensity: 1900, angle: 0.4, penumbra: 0.5, scale: 3.6, rot: 0.6, shadow: sh, far: 40 }), [8.5, 15, -2], [-2.7, 2.2, -3.2]),
    aim(g, causticSpot(lines, { color: GOLD, intensity: 1700, angle: 0.38, penumbra: 0.5, scale: 3.2, rot: -0.7, drift: [0.004, 0.002], shadow: sh, far: 40 }), [-8.5, 15, -1], [2.7, 2.2, -2.5]),
    aim(g, causticSpot(lines, { color: GOLD2, intensity: 1200, angle: 0.34, penumbra: 0.6, scale: 3.0, rot: 1.6, shadow: sh, far: 40 }), [0.5, 13, 8], [0, 1, -6.5]),
  ];
  for (const l of L) g.add(bounce(l, { albedo: BOUNCE, share: 0.02, off: 1.0 }));
  const fill = new THREE.HemisphereLight(0x8a7044, 0x1a1408, 0.06); g.add(fill);
  return {
    group: g, caustics: [lines], lights: L,
    look: { exposure: 0.72, ...GRADE, haze: 0.0205, fog: 0x2a1f0c, bg: 0x050302 },
    volume: { size: [W, H + 1.5, z0 - z1], at: [0, (H + 1.5) / 2, (z0 + z1) / 2] },
    shots: [
      { from: [0, 1.55, 2.6], to: [0, 1.6, -1.2], look0: [0, 2.0, -8], look1: [0, 2.1, -9], dur: 16, fov: 58 },
      { from: [-2.0, 3.2, -1.5], to: [-1.6, 3.0, -3.5], look0: [2.6, 2.2, -4], look1: [2.6, 2.0, -6], dur: 12, fov: 50 },
      { from: [1.5, 0.45, -2.2], to: [0.8, 0.6, -3.6], look0: [0, 1.0, -8], look1: [0, 1.6, -9], dur: 12, fov: 58 },
    ],
    update() {},
  };
}

// ---------------------------------------------------------------- Wallace's office

export function office(renderer, { phone = false } = {}) {
  const g = new THREE.Group(), X = 5.4, H = 6, zf = 6, zb = -8;
  const walls = rough({ panel: [2.6, 3], seam: 0.25 });
  const floorMat = rough({ base: 0x6e6450, panel: [4, 4], rough: 0.45, seam: 0.15, bump: 0.5 });
  const ceil = rough({ base: 0x4a4232, panel: [4, 4], seam: 0.2 });
  box(g, 2 * X, 0.1, zf - zb, floorMat, 0, -0.05, (zf + zb) / 2, { cast: false });
  box(g, 2 * X, 0.4, zf - zb, ceil, 0, H + 0.2, (zf + zb) / 2);
  // the back wall, with a long recessed shelf; side walls stepped into deep pilasters that throw shadows
  box(g, 2 * X, H, 0.4, walls, 0, H / 2, zb - 0.2);
  box(g, 7, 0.12, 0.9, walls, 0, 2.2, zb + 0.45); box(g, 7, 0.6, 0.5, walls, 0, 1.9, zb + 0.25);
  for (const s of [-1, 1]) {
    box(g, 0.4, H, zf - zb, walls, s * (X + 0.2), H / 2, (zf + zb) / 2);
    for (let z = zb + 2.2; z < zf; z += 3.4) box(g, 0.7, H, 0.9, walls, s * (X - 0.35), H / 2, z);
  }
  box(g, 2 * X, H, 0.4, walls, 0, H / 2, zf + 0.2);
  // the skylight: a well in the ceiling over water, glowing with its own caustic
  const soft = new Caustics(renderer, { kMin: 1, kMax: 4, amp: 1.0, depth: 0.09, speed: 0.35, dir: 0.2, spread: Math.PI, grid: phone ? 128 : 192, seed: 7, disp: 0.03 });
  const sky = new THREE.MeshBasicNodeMaterial();
  sky.colorNode = texture(soft.texture, uv().mul(vec2(1.6, 0.5))).rgb.mul(color(0xffb860)).mul(2.2).add(color(0x5a3810));
  const skyMesh = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 1.4), sky); skyMesh.rotation.x = Math.PI / 2; skyMesh.position.set(0, H - 0.01, -1.5); g.add(skyMesh);
  // the desk, its chair, two lounge chairs and a table
  const lacquer = plain(0x0c0906, 0.22), cream = leather(0xe8dcc6, 0.45), steel = plain(0x8a7a62, 0.3, 1);
  box(g, 4.8, 0.08, 1.3, lacquer, 0, 0.82, -4.4);
  box(g, 2.0, 0.74, 1.0, lacquer, 0, 0.41, -4.4);
  for (const s of [-1, 1]) box(g, 0.05, 0.78, 0.05, steel, s * 2.3, 0.39, -4.4);
  box(g, 0.32, 0.12, 0.25, plain(0x1c1712, 0.4), 0.1, 0.92, -4.6);
  armchair(g, cream, steel, 0, -5.6, 0, 1.05);
  armchair(g, cream, steel, 2.9, -1.6, -2.2, 1.15); armchair(g, cream, steel, 4.1, -3.0, -1.0, 1.15);
  box(g, 0.8, 0.45, 0.8, lacquer, 3.4, 0.225, -2.5);
  box(g, 0.12, 0.2, 0.12, plain(0xeee4d0, 0.15), 3.3, 0.55, -2.4);

  // light: the reflection of water from troughs along the front wall up onto the back and side walls, and the
  // skylight's down onto the floor. Broad, slow ribbons.
  const broad = new Caustics(renderer, { kMin: 2, kMax: 6, amp: 1.0, depth: 0.054, speed: 0.4, dir: 0, spread: 0.9, grid: phone ? 160 : 256, seed: 11 });
  const sh = phone ? 512 : 1024;
  const L = [
    aim(g, causticSpot(broad, { color: GOLD, intensity: 900, angle: 0.42, penumbra: 0.7, scale: 2.4, rot: 0.1, shadow: sh }), [0, 0.6, 5.3], [0, 3.6, -8]),
    aim(g, causticSpot(broad, { color: GOLD, intensity: 650, angle: 0.5, penumbra: 0.7, scale: 2.2, rot: 1.3, drift: [0.003, 0], shadow: sh }), [4.7, 0.5, 5], [-5.4, 3.2, -3]),
    aim(g, causticSpot(broad, { color: GOLD, intensity: 650, angle: 0.5, penumbra: 0.7, scale: 2.1, rot: -1.2, drift: [-0.002, 0.003], shadow: sh }), [-4.7, 0.5, 5], [5.4, 3.2, -3]),
    aim(g, causticSpot(soft, { color: GOLD2, intensity: 1300, angle: 0.62, penumbra: 0.8, scale: 2.0, rot: 0.4, shadow: sh }), [0, 14, -1.5], [0, 0, -0.5]),
  ];
  for (const l of L) g.add(bounce(l, { albedo: BOUNCE, share: 0.06, off: 2.0 }));
  g.add(new THREE.HemisphereLight(0x8a7044, 0x2a2010, 0.08));
  return {
    group: g, caustics: [broad, soft], lights: L,
    look: { exposure: 0.72, ...GRADE, haze: 0.0103, fog: 0x2a200c, bg: 0x070502 },
    volume: { size: [2 * X, H, zf - zb], at: [0, H / 2, (zf + zb) / 2] },
    shots: [
      { from: [0, 1.7, 5.5], to: [0, 1.75, 4.0], look0: [0, 2.3, -8], look1: [0, 2.2, -8], dur: 18, fov: 72 },
      { from: [-4.4, 1.4, 3.2], to: [-3.6, 1.5, 2.2], look0: [3.3, 1.2, -3], look1: [3.1, 1.3, -3.5], dur: 12, fov: 68 },
      { from: [3.0, 4.5, 5.0], to: [1.2, 4.8, 5.0], look0: [-1.5, 1.5, -6], look1: [0, 1.4, -6], dur: 12, fov: 72 },
    ],
    update() {},
  };
}

// ---------------------------------------------------------------- the hall of water

export function hall(renderer, scene, { phone = false } = {}) {
  const g = new THREE.Group();
  const deck = wood({ base: 0x3a2412, light: 0x6a4824, h: 0.45, rough: 0.5 });
  const black = leather(0x141110, 0.38), steel = plain(0x3a3632, 0.35, 1), stone = plain(0x0d0b09, 0.6);
  const w = water(g, { size: 160, y: 0, ripple: 0.006 });
  g.add(w.mesh);
  box(g, 9, 0.28, 6, deck, 0, 0.1, 0);
  armchair(g, black, steel, -0.9, -0.6, 0.35); armchair(g, black, steel, 0.5, -0.4, -0.3);
  box(g, 0.5, 0.4, 0.5, plain(0x0c0a08, 0.3), -0.25, 0.44, -1.4);
  for (const [x, h] of [[-0.35, 0.22], [-0.2, 0.26], [-0.12, 0.18]]) box(g, 0.06, h, 0.06, plain(0x2a1d10, 0.1), x, 0.64 + h / 2, -1.4);
  for (let k = 0; k < 9; k++) box(g, 0.75, 0.16, 0.5, stone, 5.3 + k * 1.15, 0.05, 2.2 + k * 0.12);
  // the far walls: two long curved screens, open in the middle (the dark beyond), for the light to climb
  const wallMat = rough({ base: 0x6a604c, panel: [6, 40], seam: 0.1 });
  for (const s of [-1, 1]) {
    const geo = new THREE.CylinderGeometry(24, 24, 16, 96, 1, true, s < 0 ? Math.PI + 0.25 : Math.PI - 1.45, 1.2);
    const m = new THREE.Mesh(geo, wallMat); m.material.side = THREE.BackSide; m.position.set(0, 8, 8); m.receiveShadow = true; g.add(m);
  }
  // the light hanging overhead: a thin glowing disc (an ellipse from where you stand) on a long cable from the dark,
  // swinging slowly as a pendulum, and the beam it throws down onto the platform swinging with it
  const pivot = new THREE.Group(); pivot.position.set(0, 13, -7.5); g.add(pivot);
  const LEN = 7.4;
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, LEN, 6), plain(0x050403, 0.6)); cable.position.y = -LEN / 2; pivot.add(cable);
  const slit = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 0.04, 64), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 0.78, 0.4).multiplyScalar(16) }));
  slit.position.y = -LEN; pivot.add(slit);
  const down = new THREE.SpotLight(GOLD2, 260, 0, 0.45, 0.8, 2); down.castShadow = true; down.shadow.mapSize.set(1024, 1024); down.shadow.bias = -0.0004;
  down.position.set(0, -LEN - 0.1, 0.2); pivot.add(down); down.target.position.set(0, 0, -0.5); g.add(down.target);
  const ripples = new Caustics(renderer, { kMin: 5, kMax: 16, amp: 1.0, depth: 0.045, speed: 0.6, dir: 0, spread: Math.PI, grid: phone ? 160 : 256, seed: 5 });
  const gold = GOLD, sh = phone ? 512 : 1024;
  const L = [
    aim(g, causticSpot(ripples, { color: gold, intensity: 5000, angle: 0.5, penumbra: 1, scale: 4.5, rot: 0.2, shadow: sh, far: 90 }), [-4, 0.1, 10], [-17, 0.5, -10]),
    aim(g, causticSpot(ripples, { color: gold, intensity: 5000, angle: 0.5, penumbra: 1, scale: 4.2, rot: -0.4, drift: [0.002, 0], shadow: sh, far: 90 }), [4, 0.1, 10], [17, 0.5, -10]),
    down,
  ];
  for (const l of L.slice(0, 2)) g.add(bounce(l, { albedo: BOUNCE, share: 0.01, off: 4.0 }));
  pivot.updateMatrixWorld(true); down.position.applyMatrix4(pivot.matrixWorld); // bounce() reads world positions
  const deckBounce = bounce(down, { albedo: 0x7a6040, share: 0.02, off: 1.6 }); g.add(deckBounce);
  down.position.set(0, -LEN - 0.1, 0.2);
  g.add(new THREE.HemisphereLight(0x3a3018, 0x050302, 0.03));
  return {
    group: g, caustics: [ripples], lights: L, reflector: w.reflector,
    look: { exposure: 1.0, ...GRADE, haze: 0.0066, fog: 0x0a0803, bg: 0x000000 },
    volume: { size: [50, 14, 30], at: [0, 7, -9] }, // stops short of the low wall lamps, which would glare
    shots: [
      { from: [3, 6.5, 18], to: [1.5, 6.0, 16], look0: [0, 2.2, -5], look1: [0, 2.4, -5], dur: 18, fov: 50 },
      { from: [-6, 0.9, 6], to: [-4.5, 0.8, 5], look0: [0.5, 0.8, -1], look1: [0, 1.0, -2], dur: 12, fov: 48 },
      { from: [12, 0.5, 9], to: [9, 0.6, 8], look0: [-2, 2.5, -10], look1: [-5, 3.5, -12], dur: 14, fov: 50 },
    ],
    // a slow pendulum swing, mostly left to right (7.5 degrees each way, 7.6 s), with a little fore-and-aft so it wanders
    update(t) { pivot.rotation.z = 0.13 * Math.sin(t * 2 * Math.PI / 7.6); pivot.rotation.x = 0.02 * Math.sin(t * 2 * Math.PI / 11.3 + 1.3); },
  };
}

export const SCENES = { corridor, office, hall };

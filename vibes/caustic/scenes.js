/*
 * scenes.js - the three sets, after Blade Runner 2049's Wallace building, each lit as Deakins lit it: big lamps
 * aimed into water so that the reflections, not the lamps, light the room. Here each lamp has its own water, a
 * trough or a glass tank placed in the set, whose bent rays are traced out to the walls (caustics.js, Trough), and
 * a spot light at the light's apparent source carries the result, with shadows.
 *
 *   corridor - the planked wooden corridor with stairs up to a receding frame of portals, its walls streaked with
 *              thin moving lines of light that come in steeply from above.
 *   office   - Wallace's office: a warm concrete box with a skylight over water, a long desk, white chairs, broad
 *              slow ribbons of light over the walls and the floor.
 *   hall     - the hall of water: a dark square room flooded with black water, a low wooden deck with chairs,
 *              stepping stones, a long ellipse of light overhead, ripples climbing the two far walls.
 *
 * Each returns { group, caustics, lights, shots, look, update(t) }; `shots` are slow camera moves (from, to, aim
 * from, aim to, seconds, fov).
 */
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { texture, uv, vec3, vec2, time, Fn, color, float } from 'three/tsl';
import { Caustics, Trough, causticSpot, bounce } from './caustics.js';
import { wood, rough, plain, leather, water } from './materials.js';
import { figure, walker, sit, stand, LUV_LEGS } from './figures.js';

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

// The classic lights (the first version, kept as a mode): spot lights projecting a tiled caustic, with their
// bounces, built hidden; `modes` in a set's return says which lights, caustics and tuning each mode uses.
function classic(g, list, bounceOpt) {
  for (const l of list) l.userData.frame?.(); // the slant's plane, from where each light is aimed
  const B = list.map((l) => bounce(l, bounceOpt));
  for (const l of [...list, ...B]) { l.visible = false; if (!l.parent) g.add(l); }
  return { lights: list, extra: B };
}
// People, after the stills (a toggle): hidden until shown, added after every light is baked so no map holds them.
function people(g, list) {
  const grp = new THREE.Group(); grp.visible = false; g.add(grp);
  for (const p of list) grp.add(p.f.root);
  return { group: grp, figs: list.map((p) => p.f), walkers: list.map((p) => p.update), update: (t) => { for (const p of list) { p.update(t); p.f.mh?.pose(); } } };
}

function traced(g, lights, from, to) { return { lights, extra: g.children.slice(from, to).filter((o) => o.isPointLight) }; }

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

export function corridor(renderer, { phone = false, hq = false } = {}) {
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

  // light: three lamps high outside, each shining down through a glass tank of water over the open roof, steeply
  // onto the walls from either side and down the stairs from behind
  const sh = phone ? 512 : 1024, res = phone ? 512 : hq ? 2048 : 1024;
  const tank = (o) => new Trough(renderer, { mode: 'refract', color: GOLD, res, shadow: sh, far: 40, lMin: 0.2, lMax: 0.9, slope: 0.05, speed: 0.3, slosh: 0, disp: 0.012, ...o });
  const W3 = [
    tank({ at: [1.5, 7, -2.75], size: [2.5, 4.5], from: [8.5, 15, -2], lux: 6.6, dir: 0.3, spread: 1.1, seed: 3 }),
    tank({ at: [-1.5, 7, -1.94], size: [2.5, 4.5], from: [-8.5, 15, -1], lux: 6, dir: -0.4, spread: 1.1, seed: 4 }),
    tank({ at: [0.25, 7, 0.75], size: [3, 3], color: GOLD2, from: [0.5, 13, 8], lux: 4.2, seed: 6 }),
  ];
  for (const w of W3) { g.add(w.light, w.light.target); w.bake(g); }
  const L = W3.map((w) => w.light);
  const n0 = g.children.length;
  for (const l of L) g.add(bounce(l, { albedo: BOUNCE, share: 0.02, off: 1.0 }));
  const lines = new Caustics(renderer, { kMin: 2, kMax: 9, amp: 1.0, depth: 0.0675, speed: 0.55, dir: 0.3, spread: 1.1, grid: phone ? 160 : 256, seed: 3 });
  const n1 = g.children.length;
  const C = classic(g, [
    aim(g, causticSpot(lines, { color: GOLD, intensity: 1900, angle: 0.4, penumbra: 0.5, scale: 3.6, rot: 0.6, shadow: sh, far: 40, water: 3 }), [8.5, 15, -2], [-2.7, 2.2, -3.2]),
    aim(g, causticSpot(lines, { color: GOLD, intensity: 1700, angle: 0.38, penumbra: 0.5, scale: 3.2, rot: -0.7, drift: [0.004, 0.002], shadow: sh, far: 40, water: 3 }), [-8.5, 15, -1], [2.7, 2.2, -2.5]),
    aim(g, causticSpot(lines, { color: GOLD2, intensity: 1200, angle: 0.34, penumbra: 0.6, scale: 3.0, rot: 1.6, shadow: sh, far: 40, water: 3 }), [0.5, 13, 8], [0, 1, -6.5]),
  ], { albedo: BOUNCE, share: 0.02, off: 1.0 });
  const fill = new THREE.HemisphereLight(0x8a7044, 0x1a1408, 0.06); g.add(fill);
  // Luv, in her pale dress, climbing the stairs toward the portal, as the stills show her
  const luv = figure({ kind: 'woman', legs: LUV_LEGS, clasp: true });
  const stairs = (x, z) => z > zs ? 0 : Math.min(8, Math.floor((zs - z) / tread) + 1) * rise;
  const P = people(g, [{ f: luv, update: walker(luv, [[0.35, 1.2], [0.35, zs + 0.2], [0.3, zl - 0.2]], stairs, { speed: 0.6, rest: 7, start: 9 }) }]);
  return {
    group: g, caustics: W3, lights: L, figures: P, luvLook: { outfit: 'tunic', hair: 'bun', skin: 'caucasian' },
    tuned: { exposure: 1.75, haze: 6, size: 1.63, sharp: 0.28, speed: 1.35 },
    modes: { traced: { ...traced(g, L, n0, n1), caustics: W3, tuned: { exposure: 1.75, haze: 6, size: 1.63, sharp: 0.28, speed: 1.35 } }, classic: { ...C, caustics: [lines], tuned: {} } },
    look: { exposure: 0.72, ...GRADE, haze: 0.0205, fog: 0x2a1f0c, bg: 0x050302 },
    volume: { size: [W, H + 1.5, z0 - z1], at: [0, (H + 1.5) / 2, (z0 + z1) / 2] },
    shots: [
      // every shot square to the room: the camera looks level and straight at a wall, so its verticals stay
      // vertical and its edges run square across the frame
      { from: [0, 1.6, 2.6], to: [0, 1.6, -1.2], look0: [0, 1.6, -11], look1: [0, 1.6, -11], dur: 16, fov: 58 },
      { from: [-2.2, 2.2, -0.8], to: [-2.2, 2.2, -3.4], look0: [3, 2.2, -0.8], look1: [3, 2.2, -3.4], dur: 12, fov: 58 },
      { from: [0, 0.8, -1.8], to: [0, 0.9, -3.0], look0: [0, 0.8, -11], look1: [0, 0.9, -11], dur: 12, fov: 54 },
    ],
    update() {},
  };
}

// ---------------------------------------------------------------- Wallace's office

export function office(renderer, { phone = false, hq = false } = {}) {
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

  // light: low lamps shining down into troughs of water on the floor along the front wall, their reflections
  // fanning up over the back and side walls and the ceiling; and a lamp over the skylight's tank, down onto the
  // floor. Broad, slow ribbons.
  const sh = phone ? 512 : 1024, res = phone ? 512 : hq ? 2048 : 1024;
  const trough = (o) => new Trough(renderer, { mode: 'reflect', color: GOLD, res, shadow: sh, far: 40, lMin: 0.06, lMax: 0.3, slope: 0.015, dir: Math.PI / 2, spread: 0.4, speed: 0.3, slosh: 0.01, ...o });
  const dark = plain(0x050403, 0.9), still = plain(0x020202, 0.05);
  const W4 = [
    trough({ at: [0, 0.3, 4.7], size: [2.4, 1.2], from: [0, 0.05, 5.6], lux: 4.9, seed: 11 }),
    trough({ at: [3.6, 0.3, 3.0], size: [1.4, 1.4], from: [4.4, 0.04, 3.54], lux: 3.5, seed: 12 }),
    trough({ at: [-3.6, 0.3, 3.0], size: [1.4, 1.4], from: [-4.4, 0.04, 3.54], lux: 3.5, seed: 13 }),
    new Trough(renderer, { mode: 'refract', color: GOLD2, res, shadow: sh, far: 40, at: [0, 5.92, -1.5], size: [4.4, 1.3], from: [0, 14, -1.5], near: 8.05, lux: 6.2, lMin: 0.3, lMax: 1.2, slope: 0.15, speed: 0.25, slosh: 0, seed: 7 }),
  ];
  for (const w of W4.slice(0, 3)) { // the troughs themselves: dark boxes brim-full of still black water
    const [sx, sz] = [w.size.x + 0.12, w.size.y + 0.12];
    box(g, sx, 0.29, sz, dark, w.C.x, 0.145, w.C.z, { cast: false });
    const top = new THREE.Mesh(new THREE.PlaneGeometry(w.size.x, w.size.y), still); top.rotation.x = -Math.PI / 2; top.position.copy(w.C).y -= 0.004; g.add(top);
  }
  for (const w of W4) { g.add(w.light, w.light.target); w.bake(g); }
  const L = W4.map((w) => w.light);
  const n0 = g.children.length;
  for (const l of L) g.add(bounce(l, { albedo: BOUNCE, share: 0.06, off: 2.0 }));
  const broad = new Caustics(renderer, { kMin: 2, kMax: 6, amp: 1.0, depth: 0.054, speed: 0.4, dir: 0, spread: 0.9, grid: phone ? 160 : 256, seed: 11 });
  const n1 = g.children.length;
  const C = classic(g, [
    aim(g, causticSpot(broad, { color: GOLD, intensity: 900, angle: 0.42, penumbra: 0.7, scale: 2.4, rot: 0.1, shadow: sh, water: 0.5 }), [0, 0.6, 5.3], [0, 3.6, -8]),
    aim(g, causticSpot(broad, { color: GOLD, intensity: 650, angle: 0.5, penumbra: 0.7, scale: 2.2, rot: 1.3, drift: [0.003, 0], shadow: sh, water: 0.5 }), [4.7, 0.5, 5], [-5.4, 3.2, -3]),
    aim(g, causticSpot(broad, { color: GOLD, intensity: 650, angle: 0.5, penumbra: 0.7, scale: 2.1, rot: -1.2, drift: [-0.002, 0.003], shadow: sh, water: 0.5 }), [-4.7, 0.5, 5], [5.4, 3.2, -3]),
    aim(g, causticSpot(soft, { color: GOLD2, intensity: 1300, angle: 0.62, penumbra: 0.8, scale: 2.0, rot: 0.4, shadow: sh, water: 8 }), [0, 14, -1.5], [0, 0, -0.5]),
  ], { albedo: BOUNCE, share: 0.06, off: 2.0 });
  g.add(new THREE.HemisphereLight(0x8a7044, 0x2a2010, 0.08));
  // Wallace standing behind his desk; Luv walking in past it and back
  const wal = figure({ kind: 'man', height: 1.86 }), luv = figure({ kind: 'woman', dress: 0x2a221c, legs: LUV_LEGS });
  wal.root.position.set(0.15, 0, -5.3); // (behind the desk, clear of it)
  const P = people(g, [
    { f: wal, update: (t) => stand(wal, t) },
    { f: luv, update: walker(luv, [[-3.6, 3.2], [-2.6, -1.0], [-1.6, -3.4]], () => 0, { speed: 0.62, rest: 8, start: 4 }) },
  ]);
  return {
    group: g, caustics: [...W4, soft], lights: L, figures: P, luvLook: { outfit: 'coat', hair: 'bun', skin: 'caucasian' },
    tuned: { exposure: 0.5 },
    modes: { traced: { ...traced(g, L, n0, n1), caustics: [...W4, soft], tuned: { exposure: 0.5 } }, classic: { ...C, caustics: [broad, soft], tuned: {} } },
    look: { exposure: 0.72, ...GRADE, haze: 0.0103, fog: 0x2a200c, bg: 0x070502 },
    volume: { size: [2 * X, H, zf - zb], at: [0, H / 2, (zf + zb) / 2] },
    shots: [
      { from: [0, 2.0, 5.5], to: [0, 2.0, 4.0], look0: [0, 2.0, -8], look1: [0, 2.0, -8], dur: 18, fov: 72 },
      { from: [-4.6, 1.8, -1.0], to: [-4.6, 1.8, -3.4], look0: [5.4, 1.8, -1.0], look1: [5.4, 1.8, -3.4], dur: 12, fov: 66 },
      { from: [2.4, 3.0, 5.5], to: [0.4, 3.0, 5.5], look0: [2.4, 3.0, -8], look1: [0.4, 3.0, -8], dur: 12, fov: 66 },
    ],
    update() {},
  };
}

// ---------------------------------------------------------------- the hall of water

export function hall(renderer, scene, { phone = false, hq = false } = {}) {
  // A great dark square room flooded with black water, seen from one corner toward the far one: two flat concrete
  // walls meet in the dark behind a low square deck that stands in the water, with two armchairs and a table on
  // it and a line of stepping stones running off its far side. Light off the water climbs both walls from a
  // glowing band at the waterline, and a long ellipse of light hangs high over the deck.
  const g = new THREE.Group(), S = 14, HW = 20; // the walls at x = +-S and z = +-S; the room's height
  const deck = wood({ base: 0x4a3418, light: 0x7a5a30, h: 0.5, rough: 0.55 });
  const black = leather(0x141110, 0.38), steel = plain(0x3a3632, 0.35, 1), stone = plain(0x0d0b09, 0.6), tableMat = plain(0x0c0a08, 0.35);
  const w = water(g, { size: 160, y: 0, ripple: 0.006 });
  g.add(w.mesh);
  const DX = -1, DZ = 0; // the deck's centre
  box(g, 10, 0.24, 9, deck, DX, 0.1, DZ);
  armchair(g, black, steel, DX - 2.6, DZ - 2.4, 0.5, 1.1); armchair(g, black, steel, DX - 0.9, DZ - 2.1, -0.2, 1.1);
  box(g, 0.9, 0.42, 0.6, tableMat, DX - 1.8, 0.43, DZ - 3.3);
  for (const [x, h] of [[-2.0, 0.22], [-1.85, 0.26], [-1.7, 0.18]]) box(g, 0.06, h, 0.06, plain(0x2a1d10, 0.1), DX + x, 0.64 + h / 2, DZ - 3.3);
  armchair(g, black, steel, DX + 1.4, DZ - 3.6, -0.1, 1.0); box(g, 0.7, 0.4, 0.5, tableMat, DX + 2.6, 0.42, DZ - 3.7); // further back in the dark
  // the stepping stones: low slabs running off the deck's right side along the water
  for (let k = 0; k < 8; k++) box(g, 0.55, 0.16, 1.1, stone, DX + 5.7 + k * 1.05, 0.05, DZ - 1.2 + k * 0.08);
  // the walls: four flat walls of big cast panels (the near two behind the camera), a dark reveal at the
  // waterline, and a black ceiling
  const wallMat = rough({ base: 0x6e6450, panel: [4.8, 3.4], seam: 0.18 }), revealMat = plain(0x030202, 0.9);
  for (const [x, z, wx, wz] of [[-S, 0, 0.4, 2 * S], [0, -S, 2 * S, 0.4], [S, 0, 0.4, 2 * S], [0, S, 2 * S, 0.4]]) {
    box(g, wx, HW, wz, wallMat, x + (wx < 1 ? -Math.sign(x) * 0.2 : 0), HW / 2 - 0.5, z + (wz < 1 ? -Math.sign(z) * 0.2 : 0), { cast: false });
    box(g, wx < 1 ? 0.06 : wx, 0.08, wz < 1 ? 0.06 : wz, revealMat, x + (wx < 1 ? -Math.sign(x) * 0.02 : 0), 0.35, z + (wz < 1 ? -Math.sign(z) * 0.02 : 0), { cast: false });
  }
  box(g, 2 * S + 1, 0.3, 2 * S + 1, plain(0x020101, 1), 0, HW - 0.4, 0, { cast: false });
  // the light overhead: a long thin ellipse low over the deck on a cable from the dark, swinging slowly as a
  // pendulum, and the beam it throws down onto the deck swinging with it
  const pivot = new THREE.Group(); pivot.position.set(DX - 0.5, HW - 0.6, DZ - 1.5); g.add(pivot);
  const LEN = 14.4; // its disc 5 m over the deck
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, LEN, 6), plain(0x050403, 0.6)); cable.position.y = -LEN / 2; pivot.add(cable);
  const slit = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 0.04, 64), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(1, 0.78, 0.4).multiplyScalar(16) }));
  slit.name = 'slit'; slit.scale.set(3.4, 1, 0.7); slit.rotation.y = Math.PI / 4; slit.position.y = -LEN; pivot.add(slit); // its long axis across the view from the near corner
  const down = new THREE.SpotLight(GOLD2, 420, 0, 0.82, 0.55, 2); down.castShadow = true; down.shadow.mapSize.set(1024, 1024); down.shadow.bias = -0.0004;
  down.position.set(0, -LEN - 0.1, 0.2); pivot.add(down); down.target.position.set(DX, 0, DZ); g.add(down.target);
  // the wall light: lamps out in the room shine down onto long strips of the water along the foot of the back
  // and side walls, whose reflections climb the walls, brightest at the waterline and breaking into ripples higher up
  const sh = phone ? 512 : 1024;
  const pool = (o) => new Trough(renderer, { mode: 'reflect', color: GOLD, res: phone ? 512 : hq ? 2048 : 1024, shadow: sh, far: 90, lMin: 0.5, lMax: 1.8, slope: 0.009, speed: 0.3, slosh: 0, edge: 0.15, ...o });
  const V3 = (a) => new THREE.Vector3(...a);
  const src = (c, to, d) => V3(c).addScaledVector(V3(to).sub(V3(c)).normalize(), -d).toArray();
  // (each strip stays clear of the deck, which would shadow the water under it)
  const PL = [-S + 4.1, 0, 0], PR = [S - 4.1, 0, 0], PB = [0, 0, -S + 4.1], LONG = 2 * S - 3;
  const W2 = [
    pool({ at: PB, size: [LONG, 8], from: src(PB, [0, 3.6, -S], 22), lux: 4.2, edge: 0.3, seed: 8 }),
    pool({ at: PL, size: [8, LONG], from: src(PL, [-S, 3.6, 0], 22), lux: 4.2, edge: 0.3, seed: 5 }),
    pool({ at: PR, size: [8, LONG], from: src(PR, [S, 3.6, 0], 22), lux: 4.2, edge: 0.3, seed: 9 }),
  ];
  const L = [...W2.map((w) => w.light), down];
  for (const w of W2) { g.add(w.light, w.light.target); w.bake(g); }
  const n0 = g.children.length;
  for (const l of L.slice(0, 3)) g.add(bounce(l, { albedo: BOUNCE, share: 0.01, off: 3.0 }));
  const n1 = g.children.length;
  const ripples = new Caustics(renderer, { kMin: 2, kMax: 9, amp: 1.0, depth: 0.06, speed: 0.5, dir: 0, spread: Math.PI, grid: phone ? 160 : 256, seed: 5 });
  const C = classic(g, [
    aim(g, causticSpot(ripples, { color: GOLD, intensity: 5000, angle: 0.55, penumbra: 1, scale: 3.0, rot: 0.2, shadow: sh, far: 90, water: 0.4 }), [0, 0.1, 13.5], [0, 4, -S]),
    aim(g, causticSpot(ripples, { color: GOLD, intensity: 4000, angle: 0.55, penumbra: 1, scale: 2.8, rot: -0.4, drift: [0.002, 0], shadow: sh, far: 90, water: 0.4 }), [13.5, 0.1, 0], [-S, 4, 0]),
    aim(g, causticSpot(ripples, { color: GOLD, intensity: 4000, angle: 0.55, penumbra: 1, scale: 2.9, rot: 0.9, shadow: sh, far: 90, water: 0.4 }), [-13.5, 0.1, 0], [S, 4, 0]),
  ], { albedo: BOUNCE, share: 0.01, off: 3.0 });
  pivot.updateMatrixWorld(true); down.position.applyMatrix4(pivot.matrixWorld); // bounce() reads world positions
  const deckBounce = bounce(down, { albedo: 0x7a6040, share: 0.02, off: 1.6 }); g.add(deckBounce);
  down.position.set(0, -LEN - 0.1, 0.2);
  g.add(new THREE.HemisphereLight(0x3a3018, 0x050302, 0.03));
  // Wallace in the first armchair; Luv crossing the stepping stones onto the deck toward him and back
  const wal = figure({ kind: 'man', height: 1.86 }), luv = figure({ kind: 'woman', dress: 0x2a221c, legs: LUV_LEGS });
  wal.root.position.set(DX - 2.6, 0.22, DZ - 2.4); wal.root.rotation.y = 0.5;
  const onDeck = (x, z) => Math.abs(x - DX) < 5 && Math.abs(z - DZ) < 4.5;
  const floorH = (x, z) => onDeck(x, z) ? 0.22 : 0.13;
  const P = people(g, [
    { f: wal, update: (t) => sit(wal, 0.33, t) }, // the cushion's top 0.55 m up, the deck's 0.22
    // (she stops on the deck short of the chairs, at Wallace's side, and turns back: their fronts are at about DZ - 1.7)
    { f: luv, update: walker(luv, [[DX + 13, DZ - 0.6], [DX + 5.4, DZ - 1.15], [DX + 1.2, DZ - 1.05], [DX - 0.6, DZ - 0.8]], floorH, { speed: 0.62, rest: 9, start: 8 }) },
  ]);
  return {
    group: g, caustics: W2, lights: L, reflector: w.reflector, figures: P, luvLook: { outfit: 'coat', hair: 'bun', skin: 'caucasian' },
    tuned: { exposure: 0.6, size: 0.6, height: 0.5 },
    modes: { traced: { ...traced(g, W2.map((w) => w.light), n0, n1), caustics: W2, tuned: { exposure: 0.6, size: 0.6, height: 0.5 } }, classic: { ...C, caustics: [ripples], tuned: { exposure: 0.4 } }, shared: [down] },
    look: { exposure: 1.0, ...GRADE, haze: 0.0066, fog: 0x0a0803, bg: 0x000000 },
    volume: { size: [2 * S - 1, HW - 1, 2 * S - 1], at: [0, HW / 2, 0] },
    shots: [
      // square to the room: level, straight at the back wall across the deck, then at the side wall, then low
      // over the water, trucking along the back wall
      { from: [0, 2.4, 12.5], to: [0, 2.4, 10.5], look0: [0, 2.4, -S], look1: [0, 2.4, -S], dur: 18, fov: 56 },
      { from: [11, 1.4, 1.2], to: [11, 1.4, -1.2], look0: [-S, 1.4, 1.2], look1: [-S, 1.4, -1.2], dur: 12, fov: 56 },
      { from: [5, 0.7, 7], to: [2.5, 0.7, 7], look0: [5, 0.7, -S], look1: [2.5, 0.7, -S], dur: 14, fov: 56 },
    ],
    // a slow pendulum swing, mostly side to side (5 degrees each way, 7.6 s), with a little fore-and-aft so it wanders
    update(t) { pivot.rotation.z = 0.09 * Math.sin(t * 2 * Math.PI / 7.6); pivot.rotation.x = 0.02 * Math.sin(t * 2 * Math.PI / 11.3 + 1.3); },
  };
}

export const SCENES = { corridor, office, hall };

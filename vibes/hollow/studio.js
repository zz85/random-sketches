// studio.js - the gallery the pieces are shown in: a seamless cyclorama (floor curving up into
// the back wall), a plaster plinth, and the light. The key light is a directional light with a
// big shadow box. Light enters only through an opening (a skylight or a window with mullions):
// a mask in the light's path, seen by the shadow camera alone, so the room is lit as a pool and
// the godrays pass (which marches the same shadow map) draws beams of the opening's shape,
// broken by the piece's holes. Presets set the opening, the sun, the haze and the fill.
import * as THREE from 'three/webgpu';
import { uniform, positionWorld, mx_noise_float, mx_fractal_noise_float, vec3, mix, smoothstep, float } from 'three/tsl';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const PLINTH_TOP = 0.92;
const MASK_LAYER = 1;

// light presets. dir points from the scene toward the light (azimuth from +z toward +x, elevation)
export const LIGHTS = [
  { key: 'skylight', name: 'Skylight', az: -28, el: 62, color: 0xfff1de, intensity: 9, opening: 'sky', haze: 0.8, hazeMax: 0.42, atten: 0.6, fill: 0.16, fillColor: 0xc8d4e6, rim: 0.0, exposure: 1.0, wall: 0x37322e },
  { key: 'window', name: 'Morning window', az: 72, el: 26, color: 0xe7efff, intensity: 8, opening: 'window', haze: 0.9, hazeMax: 0.45, atten: 0.5, fill: 0.2, fillColor: 0xb8c8e0, rim: 0.4, exposure: 1.0, wall: 0x34332f },
  { key: 'golden', name: 'Golden hour', az: 118, el: 14, color: 0xffb070, intensity: 11, opening: 'window', haze: 1.0, hazeMax: 0.6, atten: 0.45, fill: 0.1, fillColor: 0x8090c0, rim: 0.0, exposure: 1.05, wall: 0x2f2a27 },
  { key: 'studio', name: 'Studio', az: -40, el: 38, color: 0xfff6ec, intensity: 5, opening: 'none', haze: 0.0, hazeMax: 0.0, atten: 1, fill: 0.55, fillColor: 0xf0f0f0, rim: 1.2, exposure: 0.95, wall: 0x6d6862 },
];

function cycGeometry() {
  // profile in (z, y): floor from the front, a 1.6 m radius cove, then the wall up to 6 m
  const R = 1.6, zWall = -3.2, pts = [];
  for (let z = 7; z > zWall + R; z -= 0.5) pts.push([z, 0]);
  for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI / 2; pts.push([zWall + R - Math.sin(a) * R, R - Math.cos(a) * R]); }
  for (let y = R + 0.5; y <= 7; y += 0.5) pts.push([zWall, y]);
  const W = 16, nx = 32, pos = [], idx = [];
  for (let i = 0; i < pts.length; i++) for (let j = 0; j <= nx; j++) pos.push(-W / 2 + (W * j) / nx, pts[i][1], pts[i][0]);
  for (let i = 0; i < pts.length - 1; i++) for (let j = 0; j < nx; j++) { const a = i * (nx + 1) + j, b = a + nx + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// the opening the light comes through: a plane of boxes with a hole, mullions across it
function openingMask(kind) {
  const g = new THREE.Group(), mat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  const box = (w, h, x, y) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.04), mat); m.position.set(x, y, 0); m.castShadow = true; m.layers.set(MASK_LAYER); g.add(m); };
  if (kind === 'none') return g;
  const [hw, hh, cols, rows, bar] = kind === 'sky' ? [0.46, 0.46, 2, 2, 0.04] : [0.4, 0.72, 2, 3, 0.03];
  const E = 9; // far enough to fill the shadow box
  box(E, E, 0, hh + E / 2); box(E, E, 0, -hh - E / 2); box(E, 2 * hh, -hw - E / 2, 0); box(E, 2 * hh, hw + E / 2, 0);
  for (let c = 1; c < cols; c++) box(bar, 2 * hh, -hw + (2 * hw * c) / cols, 0);
  for (let r = 1; r < rows; r++) box(2 * hw, bar, 0, -hh + (2 * hh * r) / rows);
  return g;
}

export function buildStudio(scene, { shadowSize = 4096 } = {}) {
  const S = {};
  // floor and wall: warm grey, slightly mottled like painted concrete
  const wallColor = uniform(new THREE.Color(0x37322e));
  const cycMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  const mottle = mx_fractal_noise_float(positionWorld.mul(1.3), 3, 2, 0.5, 1).mul(0.12).add(mx_noise_float(positionWorld.mul(9)).mul(0.03));
  cycMat.colorNode = wallColor.mul(mottle.add(1));
  cycMat.roughnessNode = float(0.88).add(mottle.mul(0.4));
  const cyc = new THREE.Mesh(cycGeometry(), cycMat); cyc.receiveShadow = true; cyc.castShadow = true; scene.add(cyc);

  // the plinth, white plaster, a felt pad would hide the foot so it stands bare
  const plMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.93, metalness: 0 });
  plMat.colorNode = vec3(0.74, 0.715, 0.67).mul(mx_noise_float(positionWorld.mul(40)).mul(0.025).add(1));
  const plinth = new THREE.Mesh(new RoundedBoxGeometry(0.62, PLINTH_TOP, 0.62, 4, 0.01), plMat);
  plinth.position.y = PLINTH_TOP / 2; plinth.castShadow = true; plinth.receiveShadow = true; scene.add(plinth);

  // key light
  const key = new THREE.DirectionalLight(0xffffff, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(shadowSize, shadowSize);
  const sc = key.shadow.camera; sc.left = -3.4; sc.right = 3.4; sc.top = 3.4; sc.bottom = -3.4; sc.near = 0.05; sc.far = 16;
  sc.layers.enable(MASK_LAYER);
  key.shadow.bias = -0.0002; key.shadow.normalBias = 0.012; key.shadow.radius = 3;
  key.target.position.set(0, 1.1, 0);
  scene.add(key, key.target);

  // fill: a soft sky from the opening's side and a little bounce off the floor
  const fill = new THREE.HemisphereLight(0xc8d4e6, 0x2a2420, 0.2); scene.add(fill);
  // a rim light from behind for the studio look
  const rim = new THREE.DirectionalLight(0xdfe8ff, 0); rim.position.set(1.5, 2.6, -3); rim.target.position.set(0, 1.1, 0); scene.add(rim, rim.target);

  let mask = null;
  S.apply = (L) => {
    const az = THREE.MathUtils.degToRad(L.az), el = THREE.MathUtils.degToRad(L.el);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const D = 6;
    key.position.copy(key.target.position).addScaledVector(dir, D);
    key.color.set(L.color); key.intensity = L.intensity;
    if (mask) { scene.remove(mask); mask.traverse((o) => o.geometry && o.geometry.dispose()); }
    mask = openingMask(L.opening);
    // just under the shadow camera's near plane, facing the light
    mask.position.copy(key.target.position).addScaledVector(dir, D - 0.25);
    mask.lookAt(key.position);
    scene.add(mask);
    fill.intensity = L.fill; fill.color.set(L.fillColor);
    rim.intensity = L.rim;
    wallColor.value.set(L.wall);
    key.shadow.needsUpdate = true;
    S.dir = dir;
  };
  Object.assign(S, { key, fill, rim, plinth, cyc, MASK_LAYER });
  return S;
}

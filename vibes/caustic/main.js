/*
 * main.js - Caustic: design a piece of glass, a bronze mirror or a pool's water surface whose caustic draws a
 * picture, then shine light through it.
 *
 * The design runs in worker.js (ot.js, optimal transport + Poisson). The caustic itself is drawn on the GPU by
 * tracing the light: every point of the surface's height grid is a vertex, the vertex shader bends the ray there
 * (refraction through the flat back and the shaped front, or reflection) and puts the vertex where the ray meets
 * the screen; the fragment shader gives each pixel the light per screen area, |d(lens area) / d(screen area)|,
 * from the screen-space derivatives of the lens position. Triangles add up, so folds, cusps and caustic lines
 * come out as they would in the real thing. One pass per colour (dispersion) and per sample of the sun's disc.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { PRESETS, textPicture, newCanvas, drawCover, luminance } from './pictures.js';
import { throwCentre } from './ot.js';

const Q = new URLSearchParams(location.search + '&' + location.hash.slice(1));
const SHOT = Q.has('shot'), $ = (id) => document.getElementById(id);
const mobile = matchMedia('(pointer: coarse)').matches;

// ---------------------------------------------------------------- the three settings

const CFG = {
  glass: { S: 150, D: 1000, mag: 2, nin: 1.49, nout: 1, disp: 0.0045, preset: 'cat', flipX: true, T: 8, tilt: 0.21,
    name: 'Glass', blurb: 'a slab of acrylic in a sunbeam, 1 m from the wall' },
  mirror: { S: 120, D: 1500, mag: 4, nin: 1, nout: 1, disp: 0, preset: 'lotus', flipX: false, lampY: 360, T: 5, tilt: 0.0,
    name: 'Magic mirror', blurb: 'a polished bronze mirror that looks flat, with a lamp on the wall' },
  water: { S: 1000, D: 2500, mag: 1, nin: 1, nout: 1.333, disp: 0.0035, preset: 'text', text: 'SWIM', flipX: true, T: 0, tilt: 0.12, floor: 0.45,
    name: 'Pool', blurb: 'still water 2.5 m deep, with waves you can make' },
};
const state = {
  mode: ['glass', 'mirror', 'water'].includes(Q.get('mode')) ? Q.get('mode') : 'glass',
  n: +Q.get('n') || (mobile ? 128 : 256),
  tx: 0, ty: 0, // light tilt, radians (the lamp's offset on the wall in the mirror)
  focus: 1, disp: 1, expo: 1, exag: 1, sunDisc: true, view: '3d', waves: 0.25,
  designs: {}, // per mode: { h, prev, relief, centre, n, lum, picture }
  morph: null, // { t, dir }
  designing: false,
};

// ---------------------------------------------------------------- renderer, scene

const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: SHOT });
renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 2 : 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.AgXToneMapping; renderer.toneMappingExposure = 1.1;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0b0d);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.35;
const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.01, 60);
const controls = new OrbitControls(camera, canvas); controls.enableDamping = true; controls.dampingFactor = 0.08;
scene.add(new THREE.HemisphereLight(0x9fb4d0, 0x2a2018, 0.25));
const sunLight = new THREE.DirectionalLight(0xfff0dc, 1.6); sunLight.castShadow = true; sunLight.shadow.mapSize.set(1024, 1024);
Object.assign(sunLight.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.1, far: 12 }); scene.add(sunLight, sunLight.target);

// ---------------------------------------------------------------- the caustic pass

const RT = mobile ? 768 : 1280;
const caustRT = new THREE.WebGLRenderTarget(RT, RT, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
const caustScene = new THREE.Scene(), caustCam = new THREE.Camera();
const hTex = { tex: null, data: null, n: 0 };

const caustVS = /* glsl */`
  uniform sampler2D hTex; uniform float n, S, zs, half_, nin, nout, circ;
  uniform int mode; uniform vec3 L, lamp; uniform float useLamp; uniform vec2 centre;
  out vec2 vSrc; out float vOk; out float vCos;
  float H(ivec2 p) { return texelFetch(hTex, clamp(p, ivec2(0), ivec2(int(n) - 1)), 0).r; }
  void main() {
    ivec2 ij = ivec2(position.xy); int N = int(n); float s = S / n;
    float dx = (ij.x > 0 && ij.x < N - 1) ? 2.0 : 1.0, dy = (ij.y > 0 && ij.y < N - 1) ? 2.0 : 1.0;
    float hx = (H(ij + ivec2(1, 0)) - H(ij - ivec2(1, 0))) / (dx * s), hy = (H(ij + ivec2(0, 1)) - H(ij - ivec2(0, 1))) / (dy * s);
    vec3 Nr = normalize(vec3(-hx, -hy, 1.0));
    vec3 P = vec3(((vec2(ij) + 0.5) / n - 0.5) * S, H(ij));
    vec3 I = useLamp > 0.5 ? normalize(P - lamp) : normalize(L);
    vCos = abs(I.z);
    vec3 O;
    if (mode == 0) { vec3 Ig = refract(I, vec3(0.0, 0.0, -1.0), 1.0 / nin); O = refract(Ig, -Nr, nin / nout); }
    else if (mode == 1) O = refract(I, -Nr, nin / nout);
    else O = reflect(I, -Nr);
    vOk = dot(O, O) > 0.5 ? 1.0 : 0.0;
    float t = (zs - P.z) / O.z; if (!(t > 0.0)) vOk = 0.0;
    vec2 sp = P.xy + O.xy * t - centre;
    if (circ > 0.0 && length(P.xy) > circ) vOk = 0.0;
    vSrc = P.xy;
    gl_Position = vec4(sp / half_, 0.0, 1.0);
  }`;
const caustFS = /* glsl */`
  uniform vec3 chan; uniform float pix, gain;
  layout(location = 0) out highp vec4 outColor;
  in vec2 vSrc; in float vOk; in float vCos;
  void main() {
    if (vOk < 0.999) discard;
    vec2 a = dFdx(vSrc), b = dFdy(vSrc);
    float j = abs(a.x * b.y - a.y * b.x); // lens mm^2 that landed on this pixel
    outColor = vec4(chan * min(j / pix * vCos * gain, 400.0), 1.0);
  }`;
const caustMat = new THREE.ShaderMaterial({
  glslVersion: THREE.GLSL3, vertexShader: caustVS, fragmentShader: caustFS, side: THREE.DoubleSide,
  depthTest: false, depthWrite: false, transparent: true, blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
  uniforms: {
    hTex: { value: null }, n: { value: 0 }, S: { value: 0 }, zs: { value: 0 }, half_: { value: 1 }, nin: { value: 1 }, nout: { value: 1 }, circ: { value: 0 },
    mode: { value: 0 }, L: { value: new THREE.Vector3(0, 0, 1) }, lamp: { value: new THREE.Vector3() }, useLamp: { value: 0 }, centre: { value: new THREE.Vector2() },
    chan: { value: new THREE.Vector3(1, 1, 1) }, pix: { value: 1 }, gain: { value: 1 },
  },
});
let caustMesh = null;
function caustGeometry(n) {
  const pos = new Float32Array(n * n * 3);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { pos[3 * (j * n + i)] = i; pos[3 * (j * n + i) + 1] = j; }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6); let q = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { const a = j * n + i; idx.set([a, a + 1, a + n + 1, a, a + n + 1, a + n], q); q += 6; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

// the screen window the caustic texture covers, in mm in the optical frame
const view = { centre: new THREE.Vector2(), half: 1 };
let caustDirty = true;

// light in the optical frame: travelling +z, tilted by (tx, ty); or the mirror's lamp on the wall
function lightNow() {
  const c = CFG[state.mode], D = c.D * state.focus;
  if (state.mode === 'mirror') return { lamp: [Math.tan(state.tx) * c.D, c.lampY + Math.tan(state.ty) * c.D, -D] };
  return { light: [Math.tan(state.tx), Math.tan(state.ty), 1] };
}

function renderCaustic() {
  const d = state.designs[state.mode]; if (!d || !caustMesh) return;
  const c = CFG[state.mode], u = caustMat.uniforms, D = c.D * state.focus, l = lightNow();
  u.mode.value = state.mode === 'glass' ? 0 : state.mode === 'water' ? 1 : 2;
  u.n.value = d.n; u.S.value = c.S; u.zs.value = state.mode === 'mirror' ? -D : D; u.circ.value = state.mode === 'mirror' ? c.S / 2 : 0;
  // follow the picture where the light throws it, with room for the tilt
  const tc = throwCentre({ mode: state.mode, D, nin: c.nin, nout: c.nout, light: l.light, lamp: l.lamp });
  view.centre.set(tc[0], tc[1]); view.half = c.S * c.mag * 0.5 * 1.45 * Math.max(1, state.focus);
  u.centre.value.copy(view.centre); u.half_.value = view.half; u.pix.value = (2 * view.half / RT) ** 2;
  renderer.setRenderTarget(caustRT); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.autoClear = false;
  const sun = state.mode !== 'mirror' && state.sunDisc && !animating() ? 7 : 1;
  const chans = c.disp > 0 && state.disp > 0 ? [[1, 0, 0, -1], [0, 1, 0, 0], [0, 0, 1, 1]] : [[1, 1, 1, 0]];
  const rSun = 0.00465; // the sun's angular radius
  for (let k = 0; k < sun; k++) {
    const a = k * 2.39996, r = sun > 1 ? rSun * Math.sqrt((k + 0.5) / sun) : 0;
    if (l.lamp) { u.useLamp.value = 1; u.lamp.value.set(...l.lamp); }
    else { u.useLamp.value = 0; u.L.value.set(l.light[0] + r * Math.cos(a), l.light[1] + r * Math.sin(a), 1); }
    for (const [cr, cg, cb, sgn] of chans) {
      const dn = sgn * c.disp * state.disp;
      u.nin.value = c.nin + (c.nin > 1 ? dn : 0); u.nout.value = c.nout + (c.nout > 1 ? dn : 0);
      u.chan.value.set(cr, cg, cb); u.gain.value = 1 / sun;
      renderer.render(caustScene, caustCam);
    }
  }
  renderer.setRenderTarget(null); renderer.autoClear = true;
  caustDirty = false;
}

// ---------------------------------------------------------------- materials for the screens (wall, pool floor)

const screenMat = (pattern, base) => new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  uniforms: { caus: { value: caustRT.texture }, cc: { value: view.centre }, half_: { value: 1 }, expo: { value: 1 }, ambient: { value: 0.02 }, base: { value: new THREE.Color(base) }, pattern: { value: pattern },
    bare: { value: 0 }, foot: { value: 0 } },
  vertexShader: /* glsl */`varying vec2 vP; void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D caus; uniform vec2 cc; uniform float half_, expo, ambient, bare, foot; uniform vec3 base; uniform int pattern; varying vec2 vP;
    float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
    void main() {
      vec2 uv = (vP - cc) / (2.0 * half_) + 0.5;
      vec3 Lc = vec3(0.0);
      if (uv.x > 0.0 && uv.y > 0.0 && uv.x < 1.0 && uv.y < 1.0) Lc = texture2D(caus, uv).rgb;
      // sunlight through the flat water around the shaped patch (soft-edged, as the patch's light is)
      vec2 q = abs(vP - cc) - foot; Lc += bare * smoothstep(-8.0, 8.0, max(q.x, q.y));
      vec3 alb = base;
      if (pattern == 1) { // plaster
        alb *= 0.9 + 0.1 * vnoise(vP * 0.05) + 0.05 * vnoise(vP * 0.4);
      } else if (pattern == 2) { // pool tiles, 50 mm with grout, and a dark lane line
        vec2 t = fract(vP / 50.0), e = min(t, 1.0 - t); float grout = smoothstep(0.03, 0.06, min(e.x, e.y));
        alb = mix(vec3(0.55, 0.6, 0.6), base * (0.92 + 0.12 * h21(floor(vP / 50.0))), grout);
      }
      vec3 col = alb * (ambient + Lc * expo);
      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
});

// a soft additive beam between two quads (or from a point), fading along it
const beamMat = (strength, tint) => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  uniforms: { k: { value: strength }, tint: { value: new THREE.Color(tint) } },
  vertexShader: /* glsl */`attribute float along; varying float vA; varying vec3 vW; void main() { vA = along; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
  fragmentShader: /* glsl */`uniform float k; uniform vec3 tint; varying float vA; varying vec3 vW;
    float h(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
    void main() { float d = 0.75 + 0.25 * h(floor(vW * 300.0)); gl_FragColor = vec4(tint * k * d * smoothstep(0.0, 0.08, vA) * smoothstep(1.0, 0.85, vA), 1.0); }`,
});
function beam(A, B, strength, tint = 0xfff1d6) {
  const pos = [], along = [];
  for (let s = 0; s < 4; s++) {
    const a0 = A[s], a1 = A[(s + 1) % 4], b0 = B[s], b1 = B[(s + 1) % 4];
    pos.push(...a0, ...a1, ...b1, ...a0, ...b1, ...b0); along.push(0, 0, 1, 0, 1, 1);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('along', new THREE.Float32BufferAttribute(along, 1));
  const m = new THREE.Mesh(g, beamMat(strength, tint)); m.renderOrder = 5; m.frustumCulled = false; return m;
}
const quad = (cx, cy, hx, hy, z) => [[cx - hx, cy - hy, z], [cx + hx, cy - hy, z], [cx + hx, cy + hy, z], [cx - hx, cy + hy, z]];

// ---------------------------------------------------------------- the world for each mode

let world = null; // { group, optic, screen, surface, beams[], ... }
const optic = new THREE.Group(); // the optical frame, in mm
optic.scale.setScalar(0.001);

function std(color, rough = 0.8, metal = 0) { return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal }); }

function buildWorld() {
  if (world) { scene.remove(world.group); world.group.traverse((o) => { o.geometry?.dispose(); }); }
  const c = CFG[state.mode], group = new THREE.Group(); scene.add(group);
  optic.clear(); optic.rotation.set(0, 0, 0); optic.position.set(0, 0, 0); group.add(optic);
  const W = { group, beams: [] };
  const D = c.D * state.focus;
  if (state.mode === 'glass') {
    optic.rotation.y = Math.PI; optic.position.set(0, 1.1, 0);
    // the wall is the screen
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(4200, 3200).translate(0, 0, 0), screenMat(1, 0xe8e2d6)); wall.position.z = D; optic.add(wall); W.screen = wall;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), std(0x2a2420, 0.9)); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; group.add(floor);
    // a card holding the lens, and a stand
    const card = new THREE.Mesh(cardGeometry(c.S + 70, c.S, 3).translate(0, 0, -c.T - 4), std(0x1b1a19, 0.7)); card.castShadow = true; optic.add(card);
    const rodLen = 1100 - (c.S / 2 + 35);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(6, 6, rodLen, 16), std(0x8a8f96, 0.35, 1)); rod.position.set(0, -(c.S / 2 + 35) - rodLen / 2, -c.T - 3); optic.add(rod);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(90, 100, 18, 40), std(0x2c2f33, 0.4, 0.8)); base.position.set(0, -1100 + 9, -c.T - 3); optic.add(base);
    W.surface = lensMesh(c);
    optic.add(W.surface);
    W.light = 'sun';
  } else if (state.mode === 'mirror') {
    optic.rotation.y = Math.PI; optic.position.set(0, 1.0, 0);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(4200, 3200), screenMat(1, 0xe6e0d4)); wall.position.z = -D; optic.add(wall); W.screen = wall;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), std(0x2b211b, 0.85)); floor.rotation.x = -Math.PI / 2; group.add(floor);
    W.surface = mirrorMesh(c); optic.add(W.surface);
    const stand = new THREE.Group();
    const wood = std(0x3a2416, 0.55);
    const leg = new THREE.Mesh(new THREE.BoxGeometry(14, 1000 - c.S / 2 - 10, 20), wood); leg.position.set(0, -(1000 + c.S / 2) / 2 - 5, 10); stand.add(leg);
    const ft = new THREE.Mesh(new THREE.BoxGeometry(220, 20, 160), wood); ft.position.set(0, -1000 + 10, 10); stand.add(ft);
    const cradle = new THREE.Mesh(new THREE.TorusGeometry(c.S / 2 + 8, 6, 10, 64, Math.PI), wood); cradle.rotation.z = Math.PI; cradle.position.z = 10; stand.add(cradle);
    optic.add(stand);
    // the lamp on the wall, aimed at the mirror
    const lamp = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(28, 36, 90, 32, 1, true), std(0x222428, 0.4, 0.9)); body.rotation.x = Math.PI / 2; lamp.add(body);
    const lens = new THREE.Mesh(new THREE.CircleGeometry(27, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.4, 4.4) })); lens.position.z = 44; lamp.add(lens);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(14, 14, 60), std(0x222428, 0.4, 0.9)); arm.position.z = -60; lamp.add(arm);
    optic.add(lamp); W.lamp = lamp;
    W.light = 'lamp';
  } else {
    optic.rotation.set(Math.PI / 2, Math.PI, 0, 'YXZ'); optic.position.set(0, 0, 0); // optical +z down, +y away from the camera
    const P = c.S / 2 + 250; // the pool is a little wider than the shaped patch
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * P, 2 * P), screenMat(2, 0x5fb3c9)); floor.position.z = D; optic.add(floor); W.screen = floor;
    const tileWall = screenMat(2, 0x6cc0d4); tileWall.uniforms.expo.value = 0; tileWall.uniforms.ambient.value = 0.08;
    for (let s = 0; s < 4; s++) {
      const w = new THREE.Mesh(new THREE.PlaneGeometry(2 * P, D + 120), tileWall);
      w.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)));
      w.position.set(P, 0, (D - 120) / 2);
      const holder = new THREE.Group(); holder.rotation.z = s * Math.PI / 2; holder.add(w); optic.add(holder);
    }
    // the deck around it
    const deckMat = std(0x8f877a, 0.9); deckMat.side = THREE.DoubleSide; const deck = new THREE.Mesh(deckGeometry(P, P + 1800), deckMat); deck.position.z = -120; optic.add(deck);
    W.surface = waterMesh(c); optic.add(W.surface);
    W.light = 'sun';
  }
  world = W; placeBeams(); setCamera(state.view, true); updateSurface(); caustDirty = true;
}

function cardGeometry(outer, inner, t) {
  const s = new THREE.Shape(); s.moveTo(-outer / 2, -outer / 2); s.lineTo(outer / 2, -outer / 2); s.lineTo(outer / 2, outer / 2); s.lineTo(-outer / 2, outer / 2); s.closePath();
  const h = new THREE.Path(); h.moveTo(-inner / 2, -inner / 2); h.lineTo(-inner / 2, inner / 2); h.lineTo(inner / 2, inner / 2); h.lineTo(inner / 2, -inner / 2); h.closePath(); s.holes.push(h);
  return new THREE.ExtrudeGeometry(s, { depth: t, bevelEnabled: false });
}
function deckGeometry(inner, outer) {
  const s = new THREE.Shape(); s.moveTo(-outer, -outer); s.lineTo(outer, -outer); s.lineTo(outer, outer); s.lineTo(-outer, outer); s.closePath();
  const h = new THREE.Path(); h.moveTo(-inner, -inner); h.lineTo(-inner, inner); h.lineTo(inner, inner); h.lineTo(inner, -inner); h.closePath(); s.holes.push(h);
  return new THREE.ShapeGeometry(s);
}

// the beams: light in, and light out toward the picture
function placeBeams() {
  for (const b of world.beams) optic.remove(b);
  world.beams = [];
  const c = CFG[state.mode], D = c.D * state.focus, l = lightNow(), hs = c.S / 2;
  const tc = throwCentre({ mode: state.mode, D, nin: c.nin, nout: c.nout, light: l.light, lamp: l.lamp }), hi = c.S * c.mag / 2;
  if (state.mode === 'glass') {
    const far = -3200, dx = l.light[0] * far, dy = l.light[1] * far;
    world.beams.push(beam(quad(dx, dy, hs, hs, far), quad(0, 0, hs, hs, -c.T), 0.03));
    world.beams.push(beam(quad(0, 0, hs, hs, 2), quad(tc[0], tc[1], hi, hi, D - 2), 0.022));
  } else if (state.mode === 'mirror') {
    const [lx, ly, lz] = l.lamp, A = [[lx, ly, lz + 50], [lx, ly, lz + 50], [lx, ly, lz + 50], [lx, ly, lz + 50]];
    world.beams.push(beam(A, quad(0, 0, hs * 0.8, hs * 0.8, -2), 0.05));
    world.beams.push(beam(quad(0, 0, hs * 0.8, hs * 0.8, -2), quad(tc[0], tc[1], hi * 0.8, hi * 0.8, -D + 2), 0.02));
    world.lamp.position.set(lx, ly, lz + 45); world.lamp.lookAt(optic.localToWorld(new THREE.Vector3(0, 0, 0)));
  } else {
    const top = -2600, dx = l.light[0] * top, dy = l.light[1] * top;
    world.beams.push(beam(quad(dx, dy, hs, hs, top), quad(0, 0, hs, hs, -10), 0.01));
    world.beams.push(beam(quad(0, 0, hs, hs, 10), quad(tc[0], tc[1], hi, hi, D - 2), 0.012, 0xd8f4ff));
  }
  for (const b of world.beams) optic.add(b);
  // the light on the objects comes from where the beam does
  optic.updateMatrixWorld(true);
  const src = l.lamp ? new THREE.Vector3(...l.lamp) : new THREE.Vector3(-l.light[0], -l.light[1], -1).multiplyScalar(3000);
  sunLight.position.copy(optic.localToWorld(src)); sunLight.target.position.copy(optic.localToWorld(new THREE.Vector3(0, 0, 0)));
  sunLight.intensity = state.mode === 'mirror' ? 0.5 : state.mode === 'water' ? 2.2 : 1.2;
  world.screen.position.z = state.mode === 'mirror' ? -D : D;
}

// display grids, at most 160 a side, sampled from the design
const DISP = mobile ? 112 : 160;
function sampleH(h, n, x, y) { // bilinear, x, y in [0, 1]
  const fx = Math.min(n - 1.001, Math.max(0, x * n - 0.5)), fy = Math.min(n - 1.001, Math.max(0, y * n - 0.5));
  const i = fx | 0, j = fy | 0, a = fx - i, b = fy - j;
  return (h[j * n + i] * (1 - a) + h[j * n + i + 1] * a) * (1 - b) + (h[(j + 1) * n + i] * (1 - a) + h[(j + 1) * n + i + 1] * a) * b;
}
function gridGeometry(m) {
  const g = new THREE.BufferGeometry(), pos = new Float32Array((m + 1) * (m + 1) * 3), idx = [];
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) { const a = j * (m + 1) + i; idx.push(a, a + 1, a + m + 2, a, a + m + 2, a + m + 1); }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx); return g;
}

function lensMesh(c) {
  const grp = new THREE.Group();
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xf4fbff, roughness: 0.04, transmission: 1, thickness: 0.008, ior: 1.49, specularIntensity: 1, envMapIntensity: 1.4, attenuationColor: new THREE.Color(0xdff5ee), attenuationDistance: 0.4 });
  const top = new THREE.Mesh(gridGeometry(DISP), mat); grp.add(top);
  const sides = new THREE.Mesh(new THREE.BufferGeometry(), mat); grp.add(sides);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(c.S, c.S).translate(0, 0, -c.T).rotateY(Math.PI), mat); grp.add(back);
  grp.userData = { top, sides, kind: 'lens' };
  return grp;
}
function mirrorMesh(c) {
  const grp = new THREE.Group(), R = c.S / 2;
  const front = new THREE.Mesh(polarGeometry(64, 128), new THREE.MeshStandardMaterial({ color: 0xd8b98a, metalness: 1, roughness: 0.07, envMapIntensity: 1.6, side: THREE.DoubleSide }));
  const back = new THREE.Mesh(polarGeometry(96, 160), new THREE.MeshStandardMaterial({ color: 0x6f5a35, metalness: 0.75, roughness: 0.5, side: THREE.DoubleSide }));
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(R + 3, R + 3, c.T + 2, 96, 1, true).rotateX(Math.PI / 2).translate(0, 0, c.T / 2), new THREE.MeshStandardMaterial({ color: 0x80673d, metalness: 0.85, roughness: 0.35 }));
  const knob = new THREE.Mesh(new THREE.SphereGeometry(10, 24, 16).scale(1, 1, 0.6).translate(0, 0, c.T + 3), back.material);
  grp.add(front, back, rim, knob);
  grp.userData = { front, back, kind: 'mirror' };
  return grp;
}
function polarGeometry(rings, segs) {
  const g = new THREE.BufferGeometry(), pos = new Float32Array((1 + rings * segs) * 3), idx = [];
  for (let s = 0; s < segs; s++) idx.push(0, 1 + s, 1 + ((s + 1) % segs));
  for (let r = 1; r < rings; r++) for (let s = 0; s < segs; s++) {
    const a = 1 + (r - 1) * segs + s, b = 1 + (r - 1) * segs + (s + 1) % segs, c2 = a + segs, d = b + segs;
    idx.push(a, c2, d, a, d, b);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setIndex(idx); g.userData = { rings, segs }; return g;
}
function waterMesh(c) {
  // seen through without refraction (the light's refraction is what the caustic pass computes): a thin tinted
  // sheet with reflections, so the floor reads clearly from above
  const mat = new THREE.MeshPhysicalMaterial({ color: 0x8fd6e8, roughness: 0.02, metalness: 0, transparent: true, opacity: 0.22, envMapIntensity: 0.5, specularIntensity: 1, side: THREE.DoubleSide, depthWrite: false });
  const m = new THREE.Mesh(gridGeometry(DISP), mat);
  m.userData = { kind: 'water' };
  return m;
}

// the shown surface follows the design (and the waves), its relief scaled by `exag` for looking at
function updateSurface() {
  const d = state.designs[state.mode], c = CFG[state.mode]; if (!world || !d) return;
  const H = d.cur, n = d.n, ex = state.exag, s = world.surface;
  if (s.userData.kind === 'lens' || s.userData.kind === 'water') {
    const mesh = s.userData.kind === 'lens' ? s.userData.top : s, pos = mesh.geometry.attributes.position.array, m = DISP;
    const S = state.mode === 'water' ? c.S + 500 : c.S, inner = c.S; // the water reaches the pool's walls; outside the patch it is flat
    for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) {
      const x = (i / m - 0.5) * S, y = (j / m - 0.5) * S, k = 3 * (j * (m + 1) + i);
      const u = x / inner + 0.5, v = y / inner + 0.5, inside = u >= 0 && u <= 1 && v >= 0 && v <= 1;
      pos[k] = x; pos[k + 1] = y; pos[k + 2] = inside ? sampleH(H, n, u, v) * ex : edgeH(H, n, u, v) * ex;
    }
    mesh.geometry.attributes.position.needsUpdate = true; mesh.geometry.computeVertexNormals();
    if (s.userData.kind === 'lens') {
      // side walls from the flat back to the shaped edge
      const sp = [], T = c.T;
      const edge = (t, side) => { const q = [[t, 0], [1, t], [1 - t, 1], [0, 1 - t]][side]; return [(q[0] - 0.5) * c.S, (q[1] - 0.5) * c.S, sampleH(H, n, q[0], q[1]) * ex]; };
      for (let side = 0; side < 4; side++) for (let k = 0; k < m; k++) {
        const a = edge(k / m, side), b = edge((k + 1) / m, side);
        sp.push(a[0], a[1], -T, b[0], b[1], -T, b[0], b[1], b[2], a[0], a[1], -T, b[0], b[1], b[2], a[0], a[1], a[2]);
      }
      const g = s.userData.sides.geometry; g.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3)); g.computeVertexNormals();
    }
  } else {
    const R = c.S / 2;
    const fill = (mesh, zf) => {
      const g = mesh.geometry, { rings, segs } = g.userData, p = g.attributes.position.array;
      p[0] = 0; p[1] = 0; p[2] = zf(0, 0);
      for (let r = 1; r <= rings; r++) for (let sg = 0; sg < segs; sg++) {
        const rr = R * r / rings, a = sg / segs * Math.PI * 2, x = rr * Math.cos(a), y = rr * Math.sin(a), k = 3 * (1 + (r - 1) * segs + sg);
        p[k] = x; p[k + 1] = y; p[k + 2] = zf(x, y);
      }
      g.attributes.position.needsUpdate = true; g.computeVertexNormals();
    };
    fill(s.userData.front, (x, y) => sampleH(H, n, x / c.S + 0.5, y / c.S + 0.5) * ex);
    // the back: the picture cast in relief, as on a real magic mirror (its front relief comes from the back's)
    const P = d.backRelief;
    fill(s.userData.back, (x, y) => c.T + 1.6 * sampleH(P, P.n, x / c.S + 0.5, y / c.S + 0.5) * (Math.hypot(x, y) < R - 6 ? 1 : 0));
  }
}
function edgeH(H, n, u, v) { return sampleH(H, n, Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))) * Math.max(0, 1 - 4 * Math.max(Math.abs(u - 0.5) - 0.5, Math.abs(v - 0.5) - 0.5, 0)); }

// ---------------------------------------------------------------- cameras

function setCamera(v, jump) {
  state.view = v;
  const c = CFG[state.mode], D = c.D * state.focus, to = new THREE.Vector3(), from = new THREE.Vector3();
  const w = (x, y, z) => optic.localToWorld(new THREE.Vector3(x, y, z));
  optic.updateMatrixWorld(true);
  const ctr = view.centre;
  if (v === 'wall') {
    if (state.mode === 'water') { to.copy(w(ctr.x, ctr.y, D)); from.copy(w(ctr.x, ctr.y - 260, -700)); }
    else { const z = state.mode === 'mirror' ? -D : D; to.copy(w(ctr.x, ctr.y, z)); from.copy(w(ctr.x, ctr.y, z + (state.mode === 'mirror' ? 1 : -1) * c.S * c.mag * 2.6)); }
  } else if (state.mode === 'glass') { to.set(-0.05, 1.06, -0.62); from.set(0.62, 1.3, 0.42); }
  else if (state.mode === 'mirror') { to.set(0, 0.95, 0.75); from.set(-1.25, 1.35, -0.55); }
  else { to.set(0, -2.5, -0.05); from.set(0.12, 2.6, 0.95); }
  if (jump) { camera.position.copy(from); controls.target.copy(to); controls.update(); camTween = null; }
  else camTween = { t: 0, p0: camera.position.clone(), t0: controls.target.clone(), p1: from, t1: to };
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
}
let camTween = null;

// ---------------------------------------------------------------- designing

let worker = null, jobId = 0;
const prevCanvas = $('preview'), pg = prevCanvas.getContext('2d');
function design(picture, label) {
  const c = CFG[state.mode], n = state.n, mode = state.mode;
  const lum = luminance(picture, n, { flipX: c.flipX });
  if (mode === 'mirror') for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { if (Math.hypot(i + 0.5 - n / 2, j + 0.5 - n / 2) > n / 2 - 1) lum[j * n + i] = 0; }
  const l = mode === 'mirror' ? { lamp: [0, c.lampY, -c.D] } : { light: [Math.tan(c.tilt), 0, 1] }; // designed for the default light
  worker?.terminate(); worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  const id = ++jobId; state.designing = true; document.body.classList.add('designing');
  $('progress').textContent = 'moving the light around'; $('progbar').style.width = '0%';
  // the preview: the picture faint, the mesh moving over it
  const thumb = newCanvas(prevCanvas.width)[0]; thumb.getContext('2d').drawImage(picture, 0, 0, thumb.width, thumb.height);
  const t0 = performance.now();
  worker.onmessage = (e) => {
    const m = e.data; if (m.id !== id) return;
    if (m.type === 'progress') {
      $('progbar').style.width = `${Math.min(97, 100 * m.it / 400 + 3)}%`;
      $('progress').textContent = m.phase ? 'shaping the surface' : `transport  ${m.it}   ${(m.err * 100).toFixed(0)}% off`;
      if (m.grid) drawMesh(thumb, m.grid, m.k, c.flipX);
      return;
    }
    state.designing = false; document.body.classList.remove('designing');
    const old = state.designs[mode];
    const H = m.h; H.n = n;
    state.designs[mode] = { h: H, cur: Float32Array.from(H), prev: old && old.n === n ? old.h : null, relief: m.relief, centre: m.centre, n, label, backRelief: backFrom(picture), lum, bg: background(lum, c.floor ?? 0.05) };
    state.designs[mode].cur.n = n;
    $('progbar').style.width = '100%';
    $('progress').textContent = `${label}: ${m.iters} steps, ${(m.ms / 1000).toFixed(1)} s`;
    if (mode === state.mode) onDesign();
    if (old && old.n === n && mode === state.mode && !SHOT) startMorph(old.cur);
    worker.terminate(); worker = null;
    console.log(`designed ${label} (${mode}, ${n}): ${m.iters} steps, err ${m.err.toFixed(3)}, relief ${m.relief.toFixed(2)} mm, ${(performance.now() - t0).toFixed(0)} ms`);
  };
  worker.postMessage({ id, lum, n, opts: { mode, S: c.S, D: c.D, mag: c.mag, floor: c.floor ?? 0.05, ...l } });
}
function drawMesh(thumb, g, k, flip) {
  const W = prevCanvas.width; pg.clearRect(0, 0, W, W); pg.globalAlpha = 0.45; pg.drawImage(thumb, 0, 0); pg.globalAlpha = 1;
  pg.strokeStyle = 'rgba(255, 214, 140, 0.85)'; pg.lineWidth = 1; pg.beginPath();
  const P = (i, j) => { const x = g[2 * (j * k + i)], y = g[2 * (j * k + i) + 1]; return [(flip ? 1 - x : x) * W, (1 - y) * W]; };
  for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) {
    const [x, y] = P(i, j);
    if (i < k - 1) { const [x2, y2] = P(i + 1, j); pg.moveTo(x, y); pg.lineTo(x2, y2); }
    if (j < k - 1) { const [x2, y2] = P(i, j + 1); pg.moveTo(x, y); pg.lineTo(x2, y2); }
  }
  pg.stroke();
}
// the brightness the design gives the picture's black parts, against the bare beam's 1
function background(lum, floor) { let m = 0; for (const v of lum) m += v; m /= lum.length; return floor / (floor + (1 - floor) * m); }
// the mirror's back: the picture, softened, as a height (0..1)
function backFrom(picture) {
  const n = 128, l = luminance(picture, n), b = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let a = 0, w = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const x = Math.min(n - 1, Math.max(0, i + di)), y = Math.min(n - 1, Math.max(0, j + dj)); a += l[(n - 1 - y) * n + x]; w++; }
    b[j * n + i] = Math.pow(a / w, 0.5);
  }
  b.n = n; return b;
}

function onDesign() {
  const d = state.designs[state.mode]; if (!d) return;
  if (hTex.n !== d.n) {
    hTex.data = new Float32Array(d.n * d.n); hTex.tex?.dispose();
    hTex.tex = new THREE.DataTexture(hTex.data, d.n, d.n, THREE.RedFormat, THREE.FloatType); hTex.tex.minFilter = hTex.tex.magFilter = THREE.NearestFilter; hTex.n = d.n;
    if (caustMesh) { caustScene.remove(caustMesh); caustMesh.geometry.dispose(); }
    caustMesh = new THREE.Mesh(caustGeometry(d.n), caustMat); caustMesh.frustumCulled = false; caustScene.add(caustMesh);
    caustMat.uniforms.hTex.value = hTex.tex;
    waves.reset(d.n);
  }
  uploadH(); updateSurface();
  $('relief').textContent = reliefText(d.relief);
  $('stl').style.display = state.mode === 'water' ? 'none' : '';
}
function uploadH() {
  const d = state.designs[state.mode]; if (!d) return;
  if (state.mode === 'water' && waves.u) { for (let k = 0; k < d.cur.length; k++) hTex.data[k] = d.cur[k] + waves.u[k]; }
  else hTex.data.set(d.cur);
  hTex.tex.needsUpdate = true; caustDirty = true;
}
const reliefText = (r) => r < 1 ? `relief ${(r * 1000).toFixed(0)} um` : `relief ${r.toFixed(1)} mm`;

// morph: the light slides from where the last picture put it to where the new one does
function startMorph(from) { state.morph = { from: Float32Array.from(from), t: 0, dir: 1, hold: 0 }; }
function stepMorph(dt) {
  const M = state.morph, d = state.designs[state.mode]; if (!M || !d) return;
  M.t = Math.min(1, M.t + dt / 3.2);
  const e = M.t * M.t * (3 - 2 * M.t);
  for (let k = 0; k < d.cur.length; k++) d.cur[k] = M.from[k] * (1 - e) + d.h[k] * e;
  uploadH(); if (frame % 3 === 0 || M.t === 1) updateSurface();
  if (M.t === 1) state.morph = null;
}

// ---------------------------------------------------------------- waves on the pool

const waves = {
  u: null, v: null, n: 0,
  reset(n) { this.n = n; this.u = new Float32Array(n * n); this.v = new Float32Array(n * n); this.calm = 0; },
  drop(x, y, r, a) { // x, y in [0, 1]
    const n = this.n, R = r * n, ci = x * n, cj = y * n;
    for (let j = Math.max(0, Math.floor(cj - 3 * R)); j < Math.min(n, cj + 3 * R); j++) for (let i = Math.max(0, Math.floor(ci - 3 * R)); i < Math.min(n, ci + 3 * R); i++) {
      const d2 = ((i - ci) ** 2 + (j - cj) ** 2) / (R * R); this.u[j * n + i] -= a * Math.exp(-d2) * (1 - d2 * 0.5);
    }
    this.calm = 0;
  },
  step() {
    const n = this.n, u = this.u, v = this.v, c2 = 0.18;
    let e = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, l = u[i > 0 ? k - 1 : k] + u[i < n - 1 ? k + 1 : k] + u[j > 0 ? k - n : k] + u[j < n - 1 ? k + n : k] - 4 * u[k];
      v[k] = (v[k] + c2 * l) * 0.994;
    }
    for (let k = 0; k < n * n; k++) { u[k] = (u[k] + v[k]) * 0.9995; e = Math.max(e, Math.abs(u[k])); }
    return e;
  },
};
const waveScale = () => 1; // the wave field is in mm

// ---------------------------------------------------------------- pictures and UI

let picture = null, pictureLabel = '';
function presetPicture(name, text) {
  const [cv, g] = newCanvas(512);
  if (name === 'text') textPicture(g, 512, text ?? $('text').value ?? 'hello'); else PRESETS[name](g, 512);
  return cv;
}
function choose(cv, label) {
  picture = cv; pictureLabel = label;
  document.querySelectorAll('[data-pic]').forEach((b) => b.classList.toggle('on', b.dataset.pic === label));
  design(cv, label);
}

function setMode(m) {
  state.mode = m; state.tx = CFG[m].tilt; state.ty = 0; state.focus = 1; $('focus').value = 100; state.morph = null;
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  document.body.dataset.mode = m;
  $('blurb').textContent = CFG[m].blurb;
  buildWorld(); updatePad();
  if (state.designs[m]) { onDesign(); updateSurface(); }
  else { const c = CFG[m]; if (c.preset === 'text') $('text').value = c.text; choose(presetPicture(c.preset, c.text), c.preset); }
  history.replaceState(null, '', `#mode=${m}`);
}

document.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => setMode(b.dataset.mode));
document.querySelectorAll('[data-view]').forEach((b) => b.onclick = () => setCamera(b.dataset.view));
document.querySelectorAll('[data-pic]').forEach((b) => b.onclick = () => {
  const p = b.dataset.pic;
  if (p === 'photo') $('file').click();
  else if (p === 'camera') snapCamera();
  else if (p === 'draw') openDraw();
  else choose(presetPicture(p), p);
});
$('text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); choose(presetPicture('text'), 'text'); } e.stopPropagation(); });
$('text').addEventListener('change', () => choose(presetPicture('text'), 'text'));
$('file').onchange = () => { const f = $('file').files[0]; if (f) loadFile(f); };
function loadFile(f) {
  const img = new Image(); img.onload = () => { const [cv, g] = newCanvas(512); drawCover(g, 512, img, img.naturalWidth, img.naturalHeight); choose(cv, 'photo'); URL.revokeObjectURL(img.src); };
  img.src = URL.createObjectURL(f);
}
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) loadFile(f); });
async function snapCamera() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 640, height: 640 } });
    const v = document.createElement('video'); v.srcObject = s; v.muted = true; v.playsInline = true; await v.play();
    await new Promise((r) => setTimeout(r, 700));
    const [cv, g] = newCanvas(512); g.translate(512, 0); g.scale(-1, 1); drawCover(g, 512, v, v.videoWidth, v.videoHeight);
    s.getTracks().forEach((t) => t.stop()); choose(cv, 'camera');
  } catch (e) { toast('No camera: ' + e.message); }
}

// drawing your own picture
const drawCv = $('draw'), dg = drawCv.getContext('2d');
function openDraw() {
  document.body.classList.add('drawing'); dg.fillStyle = '#000'; dg.fillRect(0, 0, drawCv.width, drawCv.height);
}
let pen = null;
drawCv.addEventListener('pointerdown', (e) => { drawCv.setPointerCapture(e.pointerId); pen = pt(e); dot(pen, pen); });
drawCv.addEventListener('pointermove', (e) => { if (!pen) return; const p = pt(e); dot(pen, p); pen = p; });
drawCv.addEventListener('pointerup', () => (pen = null));
const pt = (e) => { const r = drawCv.getBoundingClientRect(); return [(e.clientX - r.left) / r.width * drawCv.width, (e.clientY - r.top) / r.height * drawCv.height, e.pressure || 0.5]; };
function dot(a, b) { dg.strokeStyle = '#fff'; dg.lineCap = 'round'; dg.lineWidth = drawCv.width * (0.012 + 0.03 * (b[2] ?? 0.5)); dg.beginPath(); dg.moveTo(a[0], a[1]); dg.lineTo(b[0], b[1]); dg.stroke(); }
$('drawdone').onclick = () => { document.body.classList.remove('drawing'); const [cv, g] = newCanvas(512); g.drawImage(drawCv, 0, 0, 512, 512); choose(cv, 'draw'); };
$('drawclear').onclick = () => openDraw();
$('drawcancel').onclick = () => document.body.classList.remove('drawing');

// sliders
const bind = (id, f) => { const el = $(id); el.oninput = () => { f(+el.value); caustDirty = true; }; };
bind('focus', (v) => { state.focus = v / 100; $('focusv').textContent = `${(CFG[state.mode].D * state.focus / 1000).toFixed(2)} m`; placeBeams(); });
bind('disp', (v) => { state.disp = v; $('dispv').textContent = v ? `x${v}` : 'off'; });
bind('expo', (v) => { state.expo = 2 ** (v / 10); });
bind('exag', (v) => { state.exag = v; $('exagv').textContent = `x${v}`; updateSurface(); });
bind('wind', (v) => { state.waves = v / 100; });
$('sun').onclick = () => { state.sunDisc = !state.sunDisc; $('sun').classList.toggle('on', state.sunDisc); caustDirty = true; };
$('day').onclick = () => { dayAnim = dayAnim ? null : { t: 0 }; $('day').classList.toggle('on', !!dayAnim); };
$('again').onclick = () => { const d = state.designs[state.mode]; if (!d?.prev) return toast('Design a second picture first: the light then slides from one to the other'); startMorph(d.cur); const t = d.h; d.h = d.prev; d.prev = t; };
$('stl').onclick = exportSTL;
$('panelbtn').onclick = () => document.body.classList.toggle('panel');
let dayAnim = null;
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'h') document.body.classList.toggle('calm');
  if (e.key === '1') setMode('glass'); if (e.key === '2') setMode('mirror'); if (e.key === '3') setMode('water');
  if (e.key === 'v') setCamera(state.view === 'wall' ? '3d' : 'wall');
});

// the light pad: drag the dot to tilt the sun (or move the lamp)
const pad = $('pad'), padDot = $('paddot'), TILT = 0.26;
function updatePad() { padDot.style.transform = `translate(${(state.tx / TILT) * 38}px, ${(-state.ty / TILT) * 38}px)`; }
let padDrag = false;
pad.addEventListener('pointerdown', (e) => { padDrag = true; pad.setPointerCapture(e.pointerId); padMove(e); });
pad.addEventListener('pointermove', (e) => padDrag && padMove(e));
pad.addEventListener('pointerup', () => (padDrag = false));
pad.addEventListener('dblclick', () => { state.tx = CFG[state.mode].tilt; state.ty = 0; updatePad(); placeBeams(); caustDirty = true; });
function padMove(e) {
  const r = pad.getBoundingClientRect(); let x = (e.clientX - r.left - r.width / 2) / 38, y = -(e.clientY - r.top - r.height / 2) / 38;
  const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
  state.tx = x * TILT; state.ty = y * TILT; updatePad(); placeBeams(); caustDirty = true;
}

// pokes on the water
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let poking = null;
canvas.addEventListener('pointerdown', (e) => { if (state.mode === 'water' && e.button === 0 && !e.shiftKey) poking = poke(e) ? e.pointerId : null; });
canvas.addEventListener('pointermove', (e) => { if (poking === e.pointerId) poke(e, 0.4); });
canvas.addEventListener('pointerup', () => { poking = null; controls.enabled = true; });
function poke(e, a = 1) {
  if (!world?.surface || state.mode !== 'water') return false;
  ndc.set(e.clientX / innerWidth * 2 - 1, -e.clientY / innerHeight * 2 + 1); ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObject(world.surface)[0]; if (!hit) return false;
  const p = optic.worldToLocal(hit.point.clone()), c = CFG.water, x = p.x / c.S + 0.5, y = p.y / c.S + 0.5;
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  controls.enabled = false; waves.drop(x, y, 0.012, 5 * a); return true;
}

function toast(s) { const t = $('toast'); t.textContent = s; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 3200); }

// ---------------------------------------------------------------- STL of the piece, to cut or print

function exportSTL() {
  const d = state.designs[state.mode], c = CFG[state.mode]; if (!d) return;
  const n = d.n, H = d.h, s = c.S / n, T = c.T, tris = [];
  const P = (i, j) => [(i + 0.5 - n / 2) * s, (j + 0.5 - n / 2) * s, H[j * n + i]];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) { tris.push([P(i, j), P(i + 1, j), P(i + 1, j + 1)], [P(i, j), P(i + 1, j + 1), P(i, j + 1)]); }
  const lo = (i, j) => { const p = P(i, j); return [p[0], p[1], -T]; };
  tris.push([lo(0, 0), lo(n - 1, n - 1), lo(n - 1, 0)], [lo(0, 0), lo(0, n - 1), lo(n - 1, n - 1)]);
  const ring = []; for (let i = 0; i < n - 1; i++) ring.push([i, 0]); for (let j = 0; j < n - 1; j++) ring.push([n - 1, j]); for (let i = n - 1; i > 0; i--) ring.push([i, n - 1]); for (let j = n - 1; j > 0; j--) ring.push([0, j]);
  for (let k = 0; k < ring.length; k++) { const a = ring[k], b = ring[(k + 1) % ring.length]; tris.push([P(...a), lo(...a), lo(...b)], [P(...a), lo(...b), P(...b)]); }
  const buf = new ArrayBuffer(84 + 50 * tris.length), dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  tris.forEach((t, q) => { let o = 84 + 50 * q + 12; for (const v of t) for (const x of v) { dv.setFloat32(o, x, true); o += 4; } });
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buf], { type: 'model/stl' }));
  a.download = `caustic-${state.mode}-${d.label}.stl`; a.click();
  toast(`${c.S} mm ${state.mode === 'mirror' ? 'mirror face' : 'lens'}, ${d.relief.toFixed(2)} mm relief, for a screen ${(c.D / 1000).toFixed(1)} m away. Units are mm.`);
}

// ---------------------------------------------------------------- loop

const timer = new THREE.Timer();
let frame = 0;
const animating = () => !!state.morph || (state.mode === 'water' && waves.active) || !!dayAnim;
function tick() {
  timer.update(); const dt = Math.min(0.05, timer.getDelta()); frame++;
  if (camTween) {
    camTween.t = Math.min(1, camTween.t + dt / 1.3); const e = 1 - (1 - camTween.t) ** 3;
    camera.position.lerpVectors(camTween.p0, camTween.p1, e); controls.target.lerpVectors(camTween.t0, camTween.t1, e);
    if (camTween.t === 1) camTween = null;
  }
  controls.update();
  stepMorph(dt);
  if (dayAnim) { dayAnim.t += dt; state.tx = CFG[state.mode].tilt + 0.16 * Math.sin(dayAnim.t * 0.5); state.ty = 0.1 * Math.sin(dayAnim.t * 0.31); updatePad(); placeBeams(); caustDirty = true; }
  if (state.mode === 'water' && waves.u && state.designs.water && !SHOT) {
    if (Math.random() < state.waves * 0.6) waves.drop(Math.random(), Math.random(), 0.006 + 0.014 * Math.random(), (0.6 + Math.random() * 2) * state.waves);
    let e = 0; for (let s = 0; s < 3; s++) e = waves.step();
    waves.active = e > 1e-4;
    if (waves.active || waves.wasActive) {
      const d = state.designs.water, ws = waveScale();
      for (let k = 0; k < d.cur.length; k++) hTex.data[k] = d.cur[k] + waves.u[k] * ws;
      hTex.tex.needsUpdate = true; caustDirty = true;
      if (frame % 2 === 0) { const keep = d.cur; d.cur = hTex.data; updateSurface(); d.cur = keep; }
    }
    waves.wasActive = waves.active;
  }
  if (caustDirty) renderCaustic();
  if (world) {
    const u = world.screen.material.uniforms; u.half_.value = view.half; u.expo.value = state.expo * (state.mode === 'water' ? 0.8 : state.mode === 'mirror' ? 0.75 : 0.8);
    if (state.mode === 'water') { u.bare.value = state.designs.water?.bg ?? 0.5; u.foot.value = CFG.water.S / 2; u.ambient.value = 0.1; }
  }
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------------------------------------------------------------- start

if ('serviceWorker' in navigator && !SHOT && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');
setMode(state.mode);
document.body.classList.add('ready');
tick();

// for the smoke test
window.__caustic = {
  state, CFG, renderer, camera, controls, scene,
  get busy() { return state.designing; },
  setMode, setCamera, choose: (name, text) => choose(presetPicture(name, text), name),
  setTilt(tx, ty) { state.tx = tx; state.ty = ty; placeBeams(); caustDirty = true; updatePad(); },
  setFocus(f) { state.focus = f; placeBeams(); caustDirty = true; },
  poke(x, y) { waves.drop(x, y, 0.02, 8); waves.active = true; },
  stepWaves(k) { for (let i = 0; i < k; i++) waves.step(); const d = state.designs.water; for (let q = 0; q < d.cur.length; q++) hTex.data[q] = d.cur[q] + waves.u[q] * waveScale(); hTex.tex.needsUpdate = true; caustDirty = true; },
  // the caustic as rendered, n x n grey, row 0 at the top, and the picture it was designed for, as seen on the screen
  readCaustic(W = 64) {
    renderCaustic();
    const buf = new Uint16Array(RT * RT * 4); renderer.readRenderTargetPixels(caustRT, 0, 0, RT, RT, buf);
    const c = CFG[state.mode], d = state.designs[state.mode], out = new Float64Array(W * W), tgt = new Float64Array(W * W);
    // the picture's square on the screen, inside the texture's window
    const f = (c.S * c.mag / 2) / view.half, o = (1 - f) / 2;
    for (let j = 0; j < W; j++) for (let i = 0; i < W; i++) {
      let a = 0; const K = 4;
      for (let q = 0; q < K; q++) for (let p = 0; p < K; p++) {
        const x = Math.floor((o + f * (i + (p + 0.5) / K) / W) * RT), y = Math.floor((o + f * (1 - (j + (q + 0.5) / K) / W)) * RT);
        const k = 4 * (y * RT + x); a += THREE.DataUtils.fromHalfFloat(buf[k]) + THREE.DataUtils.fromHalfFloat(buf[k + 1]) + THREE.DataUtils.fromHalfFloat(buf[k + 2]);
      }
      out[j * W + i] = a / (3 * K * K);
      const n = d.n; let b = 0, cnt = 0;
      for (let y = Math.floor(j * n / W); y < Math.floor((j + 1) * n / W); y++) for (let x = Math.floor(i * n / W); x < Math.floor((i + 1) * n / W); x++) { b += d.lum[y * n + x]; cnt++; }
      tgt[j * W + i] = b / cnt;
    }
    let ma = 0, mb = 0; for (let k = 0; k < W * W; k++) { ma += out[k]; mb += tgt[k]; } ma /= W * W; mb /= W * W;
    let sab = 0, saa = 0, sbb = 0; for (let k = 0; k < W * W; k++) { const x = out[k] - ma, y = tgt[k] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return { corr: sab / Math.sqrt(saa * sbb), mean: ma, max: Math.max(...out) };
  },
};

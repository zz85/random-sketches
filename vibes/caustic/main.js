/*
 * main.js - Caustic: three sets after Blade Runner 2049's Wallace building, lit by moving reflections of water.
 * three.js r187, WebGPU (WebGL 2 fallback), TSL throughout.
 *
 * The look, and the cheap way to each part of it:
 *   - the water light: spot lights that project a live caustic texture (caustics.js), with shadow maps, so the
 *     ripples fall across walls, stairs and furniture and are cut by their shadows, as the 10K Fresnels bounced
 *     off troughs did on set;
 *   - haze: a half-resolution raymarched volume (VolumeNodeMaterial) lit by the same spots, so each beam carries
 *     its ripples through the air;
 *   - the lens: bloom from a mip chain, a horizontal anamorphic streak from the bloom, a soft vignette, a little
 *     chromatic fringe at the edges, film grain, 2.39:1 bars;
 *   - global illumination, two ways: each beam's light bounces once off the wall it lands on (a dim unshadowed
 *     light there, the wall's colour, so the room fills with amber), and, where the GPU allows, screen-space GI
 *     and AO (SSGINode) on top, denoised by temporal AA (TRAA), which also antialiases;
 *   - the grade: Wallace's near-monochrome amber (each colour pulled toward its luminance times an amber tint,
 *     shadows kept warm and deep), then AgX.
 */
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, diffuseColor, velocity, packNormalToRGB, unpackRGBToNormal, sample, uniform, vec2, vec3, vec4, float, mix, smoothstep, length, screenUV, screenSize, hash, time, Fn, Loop, luminance, max, exp, texture3D, frameId, screenCoordinate, clamp } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';
import { bayer16 } from 'three/addons/tsl/math/Bayer.js';
import { SCENES } from './scenes.js';
import { Drone } from './audio.js';

const Q = new URLSearchParams(location.search + '&' + location.hash.slice(1));
const $ = (id) => document.getElementById(id);
const phone = matchMedia('(pointer: coarse)').matches || Q.has('phone');
const OFF = Q.has('offscreen'), SHOT = Q.has('shot');
const VOL = 10; // the layer the haze and its lights are on

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGPURenderer({ canvas: $('gl'), antialias: false, forceWebGL: Q.has('webgl') });
renderer.setPixelRatio(Math.min(devicePixelRatio, phone ? 1.5 : 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
// if the GPU gives up (a software adapter can, on the haze's many shadowed, projected lights), come back without haze
renderer.onDeviceLost = () => { if (!Q.has('novol')) location.replace(location.pathname + '?novol&' + location.search.slice(1) + location.hash); };
try { await renderer.init(); } catch (e) { $('status').textContent = 'This needs WebGPU or WebGL 2: ' + e.message; $('status').dataset.err = 1; throw e; }

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 200);
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = 0.06; controls.enabled = false;

// ---------------------------------------------------------------- haze

function noise3D() {
  const n = 64, d = new Uint8Array(n * n * n), p = new ImprovedNoise(); let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const f = (a) => p.noise(x / n * a, y / n * a, z / n * a); // tileable enough at these scales for drifting haze
    d[i++] = 128 + 127 * Math.max(-1, Math.min(1, 0.6 * f(4) + 0.3 * f(8) + 0.15 * f(16)));
  }
  const t = new THREE.Data3DTexture(d, n, n, n); t.format = THREE.RedFormat; t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.unpackAlignment = 1; t.needsUpdate = true; return t;
}
const hazeTex = noise3D();
const hazeAmount = uniform(0.5), hazeOn = uniform(Q.has('nohaze') ? 0 : 1);
const volMat = new THREE.VolumeNodeMaterial();
volMat.steps = +Q.get('steps') || (phone ? 12 : 20);
volMat.offsetNode = bayer16(screenCoordinate.add(frameId));
volMat.scatteringNode = Fn(({ positionRay }) => {
  const drift = vec3(time.mul(0.02), time.mul(0.008), time.mul(-0.015));
  const a = texture3D(hazeTex, positionRay.mul(0.11).add(drift), 0).r, b = texture3D(hazeTex, positionRay.mul(0.31).sub(drift.mul(2)), 0).r;
  return hazeAmount.mul(a.mul(b).mul(2.2).add(0.15));
});
const volMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), volMat);
volMesh.receiveShadow = true; volMesh.layers.disableAll(); volMesh.layers.enable(VOL); scene.add(volMesh);

// ---------------------------------------------------------------- post

const LOOK = { tint: uniform(new THREE.Vector3(1, 0.64, 0.26)), sat: uniform(0.5), streak: uniform(0.45), glow: uniform(0.35), fringe: uniform(0.35), vignette: uniform(0.55), grain: uniform(0.035), fade: uniform(0) };
const pipeline = new THREE.RenderPipeline(renderer);
const GI = { on: uniform(phone || Q.has('nogi') ? 0 : 1), amount: uniform(1) };
const scenePass = pass(scene, camera, { samples: 0 });
scenePass.setMRT(mrt({ output, diffuseColor, normal: packNormalToRGB(normalView), velocity }));
scenePass.getTexture('diffuseColor').type = THREE.UnsignedByteType; scenePass.getTexture('normal').type = THREE.UnsignedByteType;
const beauty = scenePass.getTextureNode('output'), depth = scenePass.getTextureNode('depth');
const albedo = scenePass.getTextureNode('diffuseColor'), normals = scenePass.getTextureNode('normal'), vel = scenePass.getTextureNode('velocity');
const NOGI = Q.has('nogi');
let giAO = float(1), giRGB = vec3(0);
if (!NOGI) {
  const giPass = ssgi(beauty, depth, sample((u) => unpackRGBToNormal(normals.sample(u))), camera);
  giPass.sliceCount.value = 2; giPass.stepCount.value = phone ? 6 : 10; giPass.radius.value = 6; giPass.giIntensity.value = 6; giPass.thickness.value = 0.6;
  giAO = giPass.getAONode(); giRGB = giPass.getGINode();
}
const lit = Fn(() => {
  const b = beauty.rgb, withGI = b.mul(mix(float(1), giAO, GI.on.mul(0.8))).add(albedo.rgb.mul(giRGB.rgb).mul(GI.amount).mul(GI.on));
  return vec4(withGI, 1);
})();
const col = Q.has('notaa') ? beauty : traa(lit, depth, vel, camera).getTextureNode();
volMat.depthNode = depth.sample(screenUV);
const volLayer = new THREE.Layers(); volLayer.disableAll(); volLayer.enable(VOL);
const volPass = pass(scene, camera, { depthBuffer: false, samples: 0 });
volPass.setLayers(volLayer); volPass.setResolutionScale(phone ? 0.33 : 0.5);
const NOVOL = Q.has('novol');
if (NOVOL) scene.remove(volMesh);
const volSoft = NOVOL ? vec3(0) : bloom(volPass, 1, 1, 0); // the mip-chain blur hides the raymarch's noise
const glow = bloom(col, 1, 0.65, 0.7);
const glowTex = glow.getTextureNode();
pipeline.outputNode = Fn(() => {
  const uv = screenUV, asp = screenSize.x.div(screenSize.y), d = uv.sub(0.5).mul(vec2(asp, 1)), r = length(d);
  // a little lateral colour toward the edges, as old anamorphic glass has
  const ca = d.mul(r).mul(0.0035).mul(LOOK.fringe);
  const c = vec3(col.sample(uv.add(ca)).r, col.sample(uv).g, col.sample(uv.sub(ca)).b).toVar();
  c.addAssign(volSoft.rgb.mul(hazeOn).mul(0.9));
  c.addAssign(glow.rgb.mul(LOOK.glow));
  // the anamorphic streak: the bloom smeared sideways
  const s = vec3(0).toVar();
  Loop({ start: -12, end: 13 }, ({ i }) => {
    const x = float(i).div(12);
    s.addAssign(glowTex.sample(uv.add(vec2(x.mul(0.22), 0))).rgb.mul(exp(x.mul(x).mul(-5))));
  });
  c.addAssign(s.mul(vec3(1, 0.7, 0.42)).mul(LOOK.streak).mul(0.06));
  // grade: toward the luminance in amber, keeping a little of the original colour
  const y = luminance(c);
  // a toe: the shadows sink to black, as on the film's print
  const graded = mix(LOOK.tint.mul(y).mul(2.2), c, LOOK.sat).mul(smoothstep(0.0, 0.06, y).mul(0.85).add(0.15));
  const v = smoothstep(1.05, 0.2, r);
  const px = uv.mul(screenSize).floor();
  const n = hash(px.x.add(px.y.mul(4111)).add(time.mul(24).floor().mul(7919).mod(65536))).sub(0.5);
  const out = graded.mul(mix(float(1).sub(LOOK.vignette), float(1), v)).mul(n.mul(LOOK.grain).add(1)).mul(LOOK.fade.oneMinus());
  return vec4(max(out, 0), 1);
})();

let off = null;
if (OFF) {
  off = { W: innerWidth, H: innerHeight }; off.rt = new THREE.RenderTarget(off.W, off.H);
  off.c2d = document.createElement('canvas'); off.c2d.width = off.W; off.c2d.height = off.H;
  off.c2d.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:0'; document.body.insertBefore(off.c2d, $('gl').nextSibling);
}
const draw = () => { renderer.setRenderTarget(OFF ? off.rt : null); pipeline.render(); renderer.setRenderTarget(null); };
async function snapshot() {
  draw();
  const px = await renderer.readRenderTargetPixelsAsync(off.rt, 0, 0, off.W, off.H);
  const img = new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), off.W, off.H);
  // render targets come back bottom-up on WebGL, top-down on WebGPU
  const g = off.c2d.getContext('2d'); g.putImageData(img, 0, 0);
  if (renderer.backend.isWebGLBackend) { g.save(); g.scale(1, -1); g.drawImage(off.c2d, 0, -off.H); g.restore(); }
}

// ---------------------------------------------------------------- sets

const sets = {};
let cur = null, name = null;
function build(n) {
  if (!sets[n]) sets[n] = n === 'hall' ? SCENES.hall(renderer, scene, { phone }) : SCENES[n](renderer, { phone });
  return sets[n];
}
function show(n) {
  const S = build(n);
  if (cur) scene.remove(cur.group);
  cur = S; name = n; scene.add(S.group);
  for (const l of S.lights) l.layers.enable(VOL);
  scene.background = new THREE.Color(S.look.bg);
  volMesh.scale.set(...S.volume.size); volMesh.position.set(...S.volume.at);
  hazeAmount.value = S.look.haze; LOOK.tint.value.set(...S.look.tint); LOOK.sat.value = S.look.sat; renderer.toneMappingExposure = S.look.exposure;
  document.querySelectorAll('[data-set]').forEach((b) => b.classList.toggle('on', b.dataset.set === n));
  $('caption').textContent = { corridor: 'The corridor', office: 'Wallace', hall: 'The hall of water' }[n];
  $('caption').classList.remove('on'); void $('caption').offsetWidth; $('caption').classList.add('on');
  shotIndex = 0; startShot(0, true);
  history.replaceState(null, '', '#' + n);
}

// ---------------------------------------------------------------- the camera: slow moves, cut by fades

let shotIndex = 0, shotT = 0, tour = !Q.has('free'), fadeT = 0, pending = null;
const V = (a) => new THREE.Vector3(...a), ease = (t) => t * t * (3 - 2 * t);
function startShot(i, now) { shotIndex = i % cur.shots.length; shotT = 0; place(0); }
function place(t) {
  const s = cur.shots[shotIndex], e = ease(Math.min(1, t));
  camera.position.lerpVectors(V(s.from), V(s.to), e);
  const look = V(s.look0).lerp(V(s.look1), e); camera.lookAt(look); controls.target.copy(look);
  if (camera.fov !== s.fov) { camera.fov = s.fov; camera.updateProjectionMatrix(); }
}
const order = ['corridor', 'office', 'hall'];
function next() { // the next shot, and after a set's last shot the next set
  if (shotIndex + 1 < cur.shots.length) cut(() => startShot(shotIndex + 1));
  else cut(() => show(order[(order.indexOf(name) + 1) % order.length]));
}
function cut(fn) { pending = fn; fadeT = 0.0001; }
function freeLook() { if (!tour) return; tour = false; controls.enabled = true; $('tour').classList.remove('on'); }
renderer.domElement.addEventListener('pointerdown', freeLook);
renderer.domElement.addEventListener('wheel', freeLook, { passive: true });

// ---------------------------------------------------------------- UI

const drone = new Drone();
document.querySelectorAll('[data-set]').forEach((b) => b.onclick = () => { cut(() => show(b.dataset.set)); });
$('tour').onclick = () => { tour = !tour; controls.enabled = !tour; $('tour').classList.toggle('on', tour); if (tour) startShot(shotIndex); };
$('haze').onclick = () => { hazeOn.value = hazeOn.value ? 0 : 1; $('haze').classList.toggle('on', !!hazeOn.value); };
$('bars').onclick = () => { document.body.classList.toggle('nobars'); $('bars').classList.toggle('on'); };
$('gi').onclick = () => { GI.on.value = GI.on.value ? 0 : 1; $('gi').classList.toggle('on', !!GI.on.value); };
$('gi').classList.toggle('on', !!GI.on.value);
$('sound').onclick = () => { drone.toggle(); $('sound').classList.toggle('on', drone.on); };
$('haze').classList.toggle('on', !!hazeOn.value); $('tour').classList.toggle('on', tour);
addEventListener('keydown', (e) => {
  if (e.key === '1') cut(() => show('corridor')); if (e.key === '2') cut(() => show('office')); if (e.key === '3') cut(() => show('hall'));
  if (e.key === 'h') document.body.classList.toggle('calm');
  if (e.key === ' ') { e.preventDefault(); next(); }
});
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---------------------------------------------------------------- loop

const timer = new THREE.Timer();
let t = 0, paused = Q.has('paused');
function frame() {
  timer.update(); const dt = paused ? 0 : Math.min(0.05, timer.getDelta()); t += dt;
  if (fadeT > 0) { // fade out 0.7 s, cut, fade in 0.9 s
    fadeT += dt;
    if (pending && fadeT >= 0.7) { pending(); pending = null; }
    LOOK.fade.value = fadeT < 0.7 ? fadeT / 0.7 : Math.max(0, 1 - (fadeT - 0.7) / 0.9);
    if (fadeT > 1.6) { fadeT = 0; LOOK.fade.value = 0; }
  }
  if (tour && !pending) { const s = cur.shots[shotIndex]; shotT += dt / s.dur; place(shotT); if (shotT > 1 && !fadeT) next(); }
  else if (!tour) controls.update();
  for (const c of cur.caustics) c.update(t);
  if (drone.on) drone.set(name);
  if (!OFF) draw();
}
const first = order.includes(location.hash.slice(1)) ? location.hash.slice(1) : order.includes(Q.get('set')) ? Q.get('set') : 'corridor';
show(first);
if (!OFF) renderer.setAnimationLoop(frame);
$('status').remove(); document.body.classList.add('ready');
if ('serviceWorker' in navigator && !SHOT && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');

// for the smoke test
window.__caustic = {
  renderer, scene, camera, sets, get set() { return name; }, LOOK, hazeOn, GI,
  show, async frame(n = 1, dt = 1 / 30) { for (let i = 0; i < n; i++) { t += dt; for (const c of cur.caustics) c.update(t); if (tour && cur) { shotT += dt / cur.shots[shotIndex].dur; place(Math.min(1, shotT)); } } await snapshot(); },
  shot(i, at = 0.5) { startShot(i); shotT = at; place(at); },
  // the mean and the spread of the caustic texture, to see that it is lit and has lines
  async causticStats() {
    const c = cur.caustics[0], s = c.rt.width;
    const px = await renderer.readRenderTargetPixelsAsync(c.rt, 0, 0, s, s);
    let m = 0, m2 = 0, hi = 0, N = 0;
    for (let i = 0; i < px.length; i += 16) { const v = THREE.DataUtils.fromHalfFloat(px[i + 1]); m += v; m2 += v * v; hi = Math.max(hi, v); N++; }
    m /= N; return { mean: m, sd: Math.sqrt(m2 / N - m * m), max: hi };
  },
};

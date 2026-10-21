// Sorairo: an anime-style hillside. Scene assembly, time-of-day presets, shadow pass, UI.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { makeShared } from './glsl.js';
import { makeSky } from './sky.js';
import { makeTerrain, makeMountains, makePoles, heightAt } from './world.js';
import { makeTree, TREE_STYLES } from './tree.js';
import { makeGrass } from './grass.js';
import { makePost } from './post.js';

const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) ? parseFloat(Q.get(k)) : d);
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;

// ---------- time-of-day keyframes (colours in sRGB, converted to linear by THREE.Color)
const C = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
const PRESETS = [
  { name: 'Noon', sunEl: 62, zenith: C('#1d5ad6'), mid: C('#4a92ee'), horizon: C('#c4e5ff'), sun: C('#fff3df', 3.1), ambient: C('#93b5ff', 0.62), fog: C('#b9d9fb'), fogSun: C('#fff1d8'), cloudLit: C('#ffffff', 1.25), cloudShade: C('#94a8da'), cloudRim: C('#fff6e0'), disc: C('#fffaf0', 30), discSize: 0.99985, glow: 1, stars: 0, exposure: 1.0, shafts: 0.45, flare: 0.55, lift: C('#0a1638'), gain: C('#fffaf2'), sat: 1.18 },
  { name: 'Afternoon', sunEl: 30, zenith: C('#2056c8'), mid: C('#5799e8'), horizon: C('#d3e8f8'), sun: C('#fff0cf', 3.0), ambient: C('#88a9f2', 0.56), fog: C('#c6dcf1'), fogSun: C('#ffe8c0'), cloudLit: C('#fff9ee', 1.2), cloudShade: C('#8797cb'), cloudRim: C('#ffeccc'), disc: C('#fff6e0', 26), discSize: 0.99985, glow: 1, stars: 0, exposure: 1.0, shafts: 0.6, flare: 0.7, lift: C('#0c1434'), gain: C('#fff8ee'), sat: 1.18 },
  { name: 'Golden hour', sunEl: 9, zenith: C('#2a4fa2'), mid: C('#7f92d4'), horizon: C('#ffd09a'), sun: C('#ffb26a', 2.8), ambient: C('#8187cc', 0.5), fog: C('#ebc6aa'), fogSun: C('#ffbf78'), cloudLit: C('#ffd8a6', 1.15), cloudShade: C('#7b70aa'), cloudRim: C('#ffb070'), disc: C('#fff0c0', 24), discSize: 0.9998, glow: 1.2, stars: 0, exposure: 1.0, shafts: 1.0, flare: 1.0, lift: C('#1c0f34'), gain: C('#fff2e2'), sat: 1.15 },
  { name: 'Magic hour', sunEl: 1.8, zenith: C('#1b2368'), mid: C('#7b4e9f'), horizon: C('#ff906c'), sun: C('#ff7c4c', 1.7), ambient: C('#6c5cab', 0.5), fog: C('#c88ca2'), fogSun: C('#ff9a6a'), cloudLit: C('#ffa07c', 1.1), cloudShade: C('#4b3b82'), cloudRim: C('#ff8a50'), disc: C('#ffd0a0', 14), discSize: 0.9997, glow: 1.3, stars: 0.15, exposure: 1.05, shafts: 1.2, flare: 0.8, lift: C('#200c38'), gain: C('#fff0e8'), sat: 1.12 },
  { name: 'Night', sunEl: 38, zenith: C('#040a25'), mid: C('#0c1a45'), horizon: C('#24375f'), sun: C('#a3b8ff', 0.4), ambient: C('#2c3f80', 0.3), fog: C('#1c2b52'), fogSun: C('#3b5082'), cloudLit: C('#3c4a7c'), cloudShade: C('#121a38'), cloudRim: C('#a0b2e2'), disc: C('#eef2ff', 7), discSize: 0.99975, glow: 0.35, stars: 1, exposure: 1.3, shafts: 0.3, flare: 0.25, lift: C('#040a20'), gain: C('#e6eeff'), sat: 0.85 },
];
function samplePreset(t) {
  t = THREE.MathUtils.clamp(t, 0, PRESETS.length - 1);
  const i = Math.min(Math.floor(t), PRESETS.length - 2), f = THREE.MathUtils.smoothstep(t - i, 0, 1);
  const a = PRESETS[i], b = PRESETS[i + 1], o = {};
  for (const k in a) {
    if (k === 'name') continue;
    o[k] = a[k].isColor ? a[k].clone().lerp(b[k], f) : a[k] + (b[k] - a[k]) * f;
  }
  // night: the moon rises from elsewhere, don't sweep the sun over the sky
  if (t > 3) o.sunEl = t < 3.5 ? THREE.MathUtils.lerp(1.8, -6, (t - 3) * 2) : THREE.MathUtils.lerp(-6, 38, (t - 3.5) * 2);
  o.night = THREE.MathUtils.smoothstep(t, 3.2, 3.9);
  return o;
}

// ---------- settings
const S = {
  time: num('time', 0.75), azimuth: num('az', 55), clouds: num('clouds', 0.5), towers: num('towers', 1),
  style: Q.get('style') || 'summer', leaves: num('leaves', 1), wind: num('wind', 1.2), windDir: num('windDir', 30),
  painterly: Q.has('paint') ? num('paint', 2.5) : (MOBILE ? 0 : 2.5), shafts: 1, bloom: 0.55, flare: 1, paper: 1, vignette: 1, saturation: 1, exposure: 1,
  shot: Q.get('shot') || 'hillside', orbit: Q.get('orbit') === '1', seed: num('seed', 7), quality: MOBILE ? 'low' : 'high',
};

// ---------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: Q.has('still') });
renderer.autoClear = false;
document.body.appendChild(renderer.domElement);
const shared = makeShared();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 8000);

const sky = makeSky(shared); scene.add(sky.mesh);
const terrain = makeTerrain(shared); scene.add(terrain.mesh);
const mountains = makeMountains(shared); scene.add(mountains.group);
const poles = makePoles(shared); scene.add(poles.group);
const GROUND = heightAt(0, 0);
const grass = makeGrass(shared, { count: S.quality === 'high' ? 170000 : 60000 });
scene.add(grass.mesh, grass.flowers);
let tree = makeTree(shared, GROUND, S.seed, { fallCount: MOBILE ? 220 : 420 });
scene.add(tree.group); tree.setStyle(S.style);

// grass and ground albedo stay fixed; light does the work
grass.uniforms.uBase.value = C('#1f4a2a'); grass.uniforms.uTip.value = C('#4e9a3c'); grass.uniforms.uTip2.value = C('#98c54e'); grass.uniforms.uSheen.value = C('#f4ffc8');
terrain.mat.uniforms.uGrassDark.value = C('#24502b'); terrain.mat.uniforms.uGrassLight.value = C('#4f8f34'); terrain.mat.uniforms.uDirt.value = C('#b49a74');

// ---------- light motes / fireflies
const motes = (() => {
  const N = 500, p = new Float32Array(N * 3), sd = new Float32Array(N);
  for (let i = 0; i < N; i++) { p.set([(Math.random() - 0.5) * 50, Math.random() * 10, (Math.random() - 0.5) * 50], i * 3); sd[i] = Math.random(); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { ...shared, uNight: { value: 0 }, uPR: { value: 1 }, uCenter: { value: new THREE.Vector3(-8, GROUND, 10) } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      uniform float uTime, uNight, uPR; uniform vec3 uCenter, uSunDir; uniform vec2 uWind;
      attribute float aSeed;
      varying float vA; varying float vGlint;
      void main() {
        vec4 P = vec4(position, 1.0); float s = aSeed;
        vec3 p = P.xyz + uCenter;
        p.xz += uWind * uTime * 0.3; p.xz = mod(p.xz - uCenter.xz + 25.0, 50.0) - 25.0 + uCenter.xz;
        p += vec3(sin(uTime * 0.7 + s * 30.0), sin(uTime * 0.5 + s * 17.0) * 0.6, cos(uTime * 0.6 + s * 23.0)) * 0.8;
        if (uNight > 0.5) p.y = uCenter.y + mod(P.y, 3.0) * 0.6 + sin(uTime + s * 9.0) * 0.3 - 0.5;
        vec3 vd = normalize(p - cameraPosition);
        vGlint = mix(pow(max(dot(vd, uSunDir), 0.0), 8.0) * 2.0 + 0.05, 1.0, uNight);
        vA = mix(1.0, smoothstep(0.6, 1.0, sin(uTime * (1.0 + s * 2.0) + s * 40.0)), uNight);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_PointSize = mix(2.2, 3.5, uNight) * uPR * (20.0 / max(-mv.z, 1.0)) + 1.0;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunColor; uniform float uNight; varying float vA; varying float vGlint;
      void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d) * vA * vGlint;
        vec3 c = mix(uSunColor * 0.4, vec3(0.8, 1.0, 0.35) * 2.5, uNight); gl_FragColor = vec4(c * a, 1.0); }`,
  });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false; return { pts, m };
})();
scene.add(motes.pts);

// ---------- tree shadow map (only the tree and poles cast; everything receives)
const SHADOW_RES = MOBILE ? 1024 : 2048;
const shadowRT = new THREE.WebGLRenderTarget(SHADOW_RES, SHADOW_RES, { depthTexture: new THREE.DepthTexture(SHADOW_RES, SHADOW_RES, THREE.FloatType), depthBuffer: true });
const shadowCam = new THREE.OrthographicCamera(-26, 26, 26, -26, 1, 110);
const shadowBasic = new THREE.MeshBasicMaterial();
shared.uShadowMap.value = shadowRT.depthTexture;
function renderShadow() {
  const target = new THREE.Vector3(0, GROUND + 5, 0);
  shadowCam.position.copy(target).addScaledVector(shared.uSunDir.value, 60);
  shadowCam.up.set(0, 1, 0); if (Math.abs(shared.uSunDir.value.y) > 0.98) shadowCam.up.set(0, 0, 1);
  shadowCam.lookAt(target); shadowCam.updateMatrixWorld(); shadowCam.updateProjectionMatrix();
  shared.uShadowMatrix.value.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);
  const swapped = [];
  scene.traverse((o) => {
    if (!(o.isMesh || o.isPoints) || !o.visible) return;
    if (o.userData.castShadow) { swapped.push([o, o.material, true]); o.material = o.userData.shadowMat || shadowBasic; }
    else { swapped.push([o, null, false]); o.visible = false; }
  });
  renderer.setRenderTarget(shadowRT); renderer.setClearColor(0xffffff, 1); renderer.clear();
  renderer.render(scene, shadowCam);
  for (const [o, m, c] of swapped) { if (c) o.material = m; else o.visible = true; }
}

// ---------- post
const post = makePost(renderer);
let pixelRatio = Math.min(devicePixelRatio, MOBILE ? 1.25 : 1.5) * num('pr', 1);
function resize() {
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  post.setSize(innerWidth, innerHeight, pixelRatio);
  motes.m.uniforms.uPR.value = pixelRatio;
}
addEventListener('resize', resize); resize();

// ---------- camera
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.06; controls.minDistance = 2; controls.maxDistance = 90;
controls.autoRotateSpeed = 0.25;
const SHOTS = {
  hillside: { pos: [-26, 1.5, 17], tgt: [0, 6.5, 0], fov: 50 },
  under: { pos: [3.5, 1.4, 5.5], tgt: [-2, 9, -5], fov: 62 },
  wide: { pos: [-48, 3.5, 62], tgt: [0, 6, 0], fov: 40 },
  path: { pos: [-33, 1.5, 47], tgt: [8, 4, -6], fov: 42 },
  sky: { pos: [-10, 0.6, 16], tgt: [6, 14, -12], fov: 58 },
};
function setShot(name) {
  const s = SHOTS[name] || SHOTS.hillside;
  camera.position.set(s.pos[0], heightAt(s.pos[0], s.pos[2]) + s.pos[1], s.pos[2]);
  controls.target.set(s.tgt[0], GROUND + s.tgt[1] - 2, s.tgt[2]);
  camera.fov = s.fov; camera.updateProjectionMatrix(); controls.update();
}
setShot(S.shot);

// ---------- apply settings each frame
const tmp = new THREE.Vector3();
function applyLook() {
  const P = samplePreset(S.time);
  const el = THREE.MathUtils.degToRad(P.sunEl), az = THREE.MathUtils.degToRad(S.azimuth + (P.night > 0.5 ? 140 : 0));
  const sd = shared.uSunDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
  // light fades out as the sun sets, then the moon takes over
  const lightK = THREE.MathUtils.smoothstep(P.sunEl, -4, 2);
  if (sd.y < 0.02) sd.y = 0.02; sd.normalize();
  shared.uSunColor.value.copy(P.sun).multiplyScalar(lightK);
  shared.uAmbient.value.copy(P.ambient);
  shared.uFogColor.value.copy(P.fog); shared.uFogSunColor.value.copy(P.fogSun);
  shared.uCloudCover.value = S.clouds;
  shared.uCloudShadow.value = 0.55 * lightK * (1 - P.night * 0.6);
  const wa = THREE.MathUtils.degToRad(S.windDir);
  shared.uWind.value.set(Math.cos(wa), Math.sin(wa)).multiplyScalar(S.wind);
  const u = sky.uniforms;
  u.uZenith.value.copy(P.zenith); u.uMid.value.copy(P.mid); u.uHorizon.value.copy(P.horizon);
  u.uCloudLit.value.copy(P.cloudLit); u.uCloudShade.value.copy(P.cloudShade); u.uCloudRim.value.copy(P.cloudRim);
  u.uDiscColor.value.copy(P.disc).multiplyScalar(lightK); u.uDiscSize.value = P.discSize; u.uGlow.value = P.glow * lightK; u.uStars.value = P.stars;
  u.uTowers.value = S.towers;
  motes.m.uniforms.uNight.value = P.night;
  tree.fallUniforms.uFallRate.value = S.leaves;
  tree.group.children[2].visible = S.leaves > 0.01;

  // sun on screen, for shafts and flare
  tmp.copy(sd).multiplyScalar(4000).add(camera.position).project(camera);
  const onScreen = tmp.z < 1 && Math.abs(tmp.x) < 1.3 && Math.abs(tmp.y) < 1.3 ? 1 : 0;
  const edge = THREE.MathUtils.smoothstep(1.3 - Math.max(Math.abs(tmp.x), Math.abs(tmp.y)), 0, 0.4);
  const sunOn = onScreen * edge * lightK;
  const sunUv = new THREE.Vector2(tmp.x * 0.5 + 0.5, tmp.y * 0.5 + 0.5);
  post.light.uniforms.uSun.value.copy(sunUv); post.light.uniforms.uSunOn.value = sunOn * S.shafts;
  post.light.uniforms.uColor.value.copy(P.sun).multiplyScalar(0.25 * lightK); post.light.uniforms.uStrength.value = P.shafts;
  const inside = Math.abs(tmp.x) < 1 && Math.abs(tmp.y) < 1 ? 1 : 0;
  post.grade.uniforms.uSun.value.copy(sunUv); post.grade.uniforms.uSunOn.value = sunOn * inside;
  post.grade.uniforms.uFlare.value = P.flare * S.flare; post.grade.uniforms.uFlareColor.value.copy(P.sun).multiplyScalar(0.35);
  post.grade.uniforms.uExposure.value = P.exposure * S.exposure; post.grade.uniforms.uSat.value = P.sat * S.saturation;
  post.grade.uniforms.uLift.value.copy(P.lift); post.grade.uniforms.uGain.value.copy(P.gain);
  post.final.uniforms.uPaper.value = S.paper; post.final.uniforms.uVignette.value = S.vignette;
  return P;
}

// ---------- UI
const gui = new GUI({ title: 'Sorairo' });
const names = Object.fromEntries(PRESETS.map((p, i) => [p.name, i]));
const fScene = gui.addFolder('Scene');
const timeCtl = fScene.add(S, 'time', 0, PRESETS.length - 1, 0.01).name('time of day');
fScene.add({ preset: '' }, 'preset', names).name('jump to').onChange((v) => { S.time = +v; timeCtl.updateDisplay(); });
fScene.add(S, 'azimuth', -180, 180, 1).name('sun azimuth');
fScene.add(S, 'clouds', 0, 1, 0.01).name('cloud cover');
fScene.add(S, 'towers', 0, 1.6, 0.01).name('cumulus towers');
fScene.add(S, 'wind', 0, 3, 0.01);
fScene.add(S, 'windDir', 0, 360, 1).name('wind direction');
const fTree = gui.addFolder('Tree');
fTree.add(S, 'style', Object.keys(TREE_STYLES)).onChange((v) => tree.setStyle(v));
fTree.add(S, 'leaves', 0, 3, 0.01).name('falling leaves');
fTree.add({ grow: () => { S.seed = (S.seed * 7 + 13) % 1000; rebuildTree(); } }, 'grow').name('grow another tree');
const fLook = gui.addFolder('Look');
fLook.add(S, 'painterly', { off: 0, 'soft gouache': 2.5, 'oil paint': 4, 'heavy brush': 6 });
fLook.add(S, 'shafts', 0, 2, 0.01).name('light shafts');
fLook.add(S, 'bloom', 0, 1.5, 0.01);
fLook.add(S, 'flare', 0, 2, 0.01).name('lens flare');
fLook.add(S, 'paper', 0, 2, 0.01).name('canvas texture');
fLook.add(S, 'vignette', 0, 1.5, 0.01);
fLook.add(S, 'saturation', 0.5, 1.5, 0.01);
fLook.add(S, 'exposure', 0.5, 2, 0.01);
const fCam = gui.addFolder('Camera');
fCam.add(S, 'shot', Object.keys(SHOTS)).onChange(setShot);
fCam.add(S, 'orbit').name('slow orbit');
gui.add({ save: savePNG }, 'save').name('save picture (P)');
if (MOBILE || Q.has('still')) gui.close();
if (Q.has('noui')) gui.hide();

function rebuildTree() {
  scene.remove(tree.group); tree.dispose();
  tree = makeTree(shared, GROUND, S.seed, { fallCount: MOBILE ? 220 : 420 });
  tree.setStyle(S.style); scene.add(tree.group);
}
function savePNG() {
  frame(0);
  renderer.domElement.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `sorairo-${Date.now()}.png`; a.click(); });
}
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'h' || e.key === 'H') { gui._hidden ? gui.show() : gui.hide(); document.getElementById('title').classList.toggle('gone'); }
  if (e.key === 'p' || e.key === 'P') savePNG();
});

// ---------- loop
const clock = new THREE.Clock();
let frames = 0, acc = 0;
const FIXED_T = Q.has('t') ? num('t', 0) : null;
function frame(dt) {
  shared.uTime.value = FIXED_T ?? shared.uTime.value + dt;
  controls.autoRotate = S.orbit;
  controls.update();
  // keep the eye above the grass
  const gy = heightAt(camera.position.x, camera.position.z) + 0.45;
  if (camera.position.y < gy) camera.position.y = gy;
  applyLook();
  renderShadow();
  post.render(scene, camera, { bloom: S.bloom, paint: Math.min(6, S.painterly * pixelRatio) });
  post.final.uniforms.uTime.value = shared.uTime.value;
}
function loop() {
  const dt = Math.min(clock.getDelta(), 0.1);
  frame(dt);
  // adaptive resolution: drop pixel ratio if we can't hold ~40 fps
  frames++; acc += dt;
  if (acc > 2.5 && FIXED_T === null) {
    const fps = frames / acc; frames = 0; acc = 0;
    if (fps < 38 && pixelRatio > 0.6) { pixelRatio = Math.max(0.6, pixelRatio - 0.15); resize(); }
  }
  requestAnimationFrame(loop);
}
if (Q.has('still')) { frame(0); window.__ready = true; }
else { loop(); setTimeout(() => (window.__ready = true), 500); }
window.__sorairo = { S, grass, tree, frame, setShot };

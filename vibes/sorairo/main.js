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
import { makeBirds } from './birds.js';
import { mulberry32 } from './tree.js';
import { makeLiveAudio } from './audio.js';
import { sampleSeason, SEASON_MARKS, rainOnDay } from './seasons.js';
import { makeSnow } from './snow.js';
import { makeRain } from './rain.js';
import * as J from './journey.js';

const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) ? parseFloat(Q.get(k)) : d);
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;

// ---------- time-of-day keyframes (colours in sRGB, converted to linear by THREE.Color)
const C = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
const PRESETS = [
  { name: 'Noon', sunEl: 62, zenith: C('#1d5ad6'), mid: C('#4a92ee'), horizon: C('#c4e5ff'), sun: C('#fff3df', 3.1), ambient: C('#93b5ff', 0.62), fog: C('#b9d9fb'), fogSun: C('#fff1d8'), cloudLit: C('#ffffff', 1.25), cloudShade: C('#94a8da'), cloudRim: C('#fff6e0'), disc: C('#fffaf0', 30), discSize: 0.99985, glow: 1, stars: 0, exposure: 1.0, shafts: 0.45, flare: 0.55, lift: C('#0a1638'), gain: C('#fffaf2'), sat: 1.18 , fogK: 1 },
  { name: 'Afternoon', sunEl: 30, zenith: C('#2056c8'), mid: C('#5799e8'), horizon: C('#d3e8f8'), sun: C('#fff0cf', 3.0), ambient: C('#88a9f2', 0.56), fog: C('#c6dcf1'), fogSun: C('#ffe8c0'), cloudLit: C('#fff9ee', 1.2), cloudShade: C('#8797cb'), cloudRim: C('#ffeccc'), disc: C('#fff6e0', 26), discSize: 0.99985, glow: 1, stars: 0, exposure: 1.0, shafts: 0.6, flare: 0.7, lift: C('#0c1434'), gain: C('#fff8ee'), sat: 1.18 , fogK: 1 },
  { name: 'Golden hour', sunEl: 9, zenith: C('#2a4fa2'), mid: C('#7f92d4'), horizon: C('#ffd09a'), sun: C('#ffb26a', 2.8), ambient: C('#8187cc', 0.5), fog: C('#ebc6aa'), fogSun: C('#ffbf78'), cloudLit: C('#ffd8a6', 1.15), cloudShade: C('#7b70aa'), cloudRim: C('#ffb070'), disc: C('#fff0c0', 24), discSize: 0.9998, glow: 1.2, stars: 0, exposure: 1.0, shafts: 1.0, flare: 1.0, lift: C('#1c0f34'), gain: C('#fff2e2'), sat: 1.15 , fogK: 1 },
  { name: 'Magic hour', sunEl: 1.8, zenith: C('#1b2368'), mid: C('#7b4e9f'), horizon: C('#ff906c'), sun: C('#ff7c4c', 1.7), ambient: C('#6c5cab', 0.5), fog: C('#c88ca2'), fogSun: C('#ff9a6a'), cloudLit: C('#ffa07c', 1.1), cloudShade: C('#4b3b82'), cloudRim: C('#ff8a50'), disc: C('#ffd0a0', 14), discSize: 0.9997, glow: 1.3, stars: 0.15, exposure: 1.05, shafts: 1.2, flare: 0.8, lift: C('#200c38'), gain: C('#fff0e8'), sat: 1.12 , fogK: 1.1 },
  { name: 'Night', sunEl: 38, zenith: C('#040a25'), mid: C('#0c1a45'), horizon: C('#24375f'), sun: C('#a3b8ff', 0.4), ambient: C('#2c3f80', 0.3), fog: C('#1c2b52'), fogSun: C('#3b5082'), cloudLit: C('#3c4a7c'), cloudShade: C('#121a38'), cloudRim: C('#a0b2e2'), disc: C('#eef2ff', 7), discSize: 0.99975, glow: 0.35, stars: 1, exposure: 1.3, shafts: 0.3, flare: 0.25, lift: C('#040a20'), gain: C('#e6eeff'), sat: 0.85 , fogK: 1 },
  // Dawn is not magic hour backwards: a cool blue-lilac sky with a pastel peach band at the
  // horizon, rose-lit cloud bases, the last stars, and low mist (fogK) in the valleys.
  { name: 'Dawn', sunEl: 1.5, zenith: C('#22306e'), mid: C('#7482c2'), horizon: C('#ffcab4'), sun: C('#ffb894', 1.6), ambient: C('#7c88cc', 0.52), fog: C('#bdb8da'), fogSun: C('#ffc4a6'), cloudLit: C('#ffc8bc', 1.1), cloudShade: C('#5e629e'), cloudRim: C('#ffb898'), disc: C('#ffe4c8', 16), discSize: 0.9997, glow: 1.1, stars: 0.12, exposure: 1.05, shafts: 1.1, flare: 0.8, lift: C('#141a42'), gain: C('#f4f2ff'), sat: 1.04, fogK: 2.4 },
  // Morning: low clear light, cooler and fresher than the afternoon, mist burning off
  { name: 'Morning', sunEl: 16, zenith: C('#2460d0'), mid: C('#6aa6ec'), horizon: C('#dbeefb'), sun: C('#fff3da', 2.9), ambient: C('#8fb4f2', 0.58), fog: C('#cde2f6'), fogSun: C('#fff0d8'), cloudLit: C('#ffffff', 1.2), cloudShade: C('#8ea3d6'), cloudRim: C('#fff2dc'), disc: C('#fffaf0', 26), discSize: 0.99985, glow: 1.05, stars: 0, exposure: 1.0, shafts: 0.75, flare: 0.75, lift: C('#0c1636'), gain: C('#f8fbff'), sat: 1.15, fogK: 1.5 },
];
// The time-of-day slider runs once round the clock: 0 noon, 1 afternoon, 2 golden hour,
// 3 magic hour, 4 night, 5 dawn, 6 morning, and 7 is noon again.
const NIGHT_T = 4, DAY_T = PRESETS.length;
function samplePreset(t) {
  t = ((t % DAY_T) + DAY_T) % DAY_T;
  const i = Math.floor(t), f = THREE.MathUtils.smoothstep(t - i, 0, 1);
  const a = PRESETS[i], b = PRESETS[(i + 1) % DAY_T], o = {};
  for (const k in a) {
    if (k === 'name') continue;
    o[k] = a[k].isColor ? a[k].clone().lerp(b[k], f) : a[k] + (b[k] - a[k]) * f;
  }
  // night: the moon rises from elsewhere, don't sweep the sun over the sky
  // the sun sets below the horizon and the moon rises (3 … 4); the moon sets and the sun
  // comes up for dawn (4 … 5)
  if (t > 3 && t <= 4) o.sunEl = t < 3.5 ? THREE.MathUtils.lerp(1.8, -6, (t - 3) * 2) : THREE.MathUtils.lerp(-6, 38, (t - 3.5) * 2);
  else if (t > 4 && t < 5) o.sunEl = t < 4.5 ? THREE.MathUtils.lerp(38, -6, (t - 4) * 2) : THREE.MathUtils.lerp(-6, PRESETS[5].sunEl, (t - 4.5) * 2);
  o.night = THREE.MathUtils.smoothstep(t, 3.2, 3.9) * (1 - THREE.MathUtils.smoothstep(t, 4.1, 4.8));
  return o;
}

// ---------- settings
const S = {
  time: num('time', 0.75), azimuth: num('az', 55), clouds: num('clouds', 0.5), towers: num('towers', 1),
  rain: num('rain', Q.get('weather') === 'rain' ? 1 : 0),
  style: Q.get('style') || 'summer', leaves: num('leaves', 1), wind: num('wind', 1.2), windDir: num('windDir', 30),
  birds: Q.get('birds') !== '0', contrail: Q.get('contrail') !== '0',
  painterly: Q.has('paint') ? num('paint', 2.5) : (MOBILE ? 0 : 2.5), shafts: 1, bloom: 0.55, flare: 1, paper: 1, vignette: 1, saturation: 1, exposure: 1,
  shot: Q.get('shot') || 'hillside', orbit: Q.get('orbit') === '1', seed: num('seed', 7), airy: num('airy', 1), turned: num('turned', 0.5), sound: false, music: num('music', 0.6), ambience: num('ambience', 0.8), quality: MOBILE ? 'low' : 'high',
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
let tree = makeTree(shared, GROUND, S.seed, { fallCount: MOBILE ? 220 : 420, airy: S.airy, turned: S.turned });
scene.add(tree.group); tree.setStyle(S.style);
const birds = makeBirds(shared); scene.add(birds.mesh);
const snow = makeSnow(shared, MOBILE ? 2500 : 6000); scene.add(snow.pts);
const rain = makeRain(shared, MOBILE ? 4000 : 9000); scene.add(rain.lines);

// ---------- animations: a day (noon to night), a year (four seasons), or a time zoom
// (real time, speeding up to days, then months), as time-lapses.
// `progress` runs 0 … 1 over `length` seconds and loops (the time zoom: 0 … 1 is its
// ramp, after which it holds month by month); ?anim=day|year|zoom, ?dur=, ?p= (start),
// ?season= (a fixed day of the year, paused; the time zoom's start date), ?hour= (the time
// zoom's start time, default now), ?lapse= (cloud speed-up).
const ANIMS = { off: 'off', 'day cycle': 'day', 'four seasons': 'year', 'time zoom': 'zoom' };
const ANIM_LEN = { day: 60, year: 80, zoom: 44, off: 50 };
const AN = {
  mode: Q.get('anim') || (Q.has('season') ? 'year' : 'off'),
  playing: !(Q.has('season') && Q.get('anim') !== 'zoom') && Q.get('play') !== '0',
  progress: Q.has('season') && Q.get('anim') !== 'zoom' ? num('season', 0) : num('p', 0),
  length: num('dur', ANIM_LEN[Q.get('anim')] || 50),
  lockHour: num('lock', 15), // the time zoom's same-time-every-day hour
  lapse: num('lapse', 30),
  drift: num('drift', 1), // camera drift while playing, 0 = off
  weather: Q.get('weather') !== 'clear', // random rainy spells in the seasons and the time zoom
};

// grass and ground albedo stay fixed; light does the work
const SUMMER_GROUND = ['#1f4a2a', '#4e9a3c', '#98c54e', '#24502b', '#4f8f34'].map((h) => C(h));
// k darkens it (wet ground in the rain)
function setGround(g, k = 1) {
  grass.uniforms.uBase.value.copy(g[0]).multiplyScalar(k); grass.uniforms.uTip.value.copy(g[1]).multiplyScalar(k); grass.uniforms.uTip2.value.copy(g[2]).multiplyScalar(k);
  terrain.mat.uniforms.uGrassDark.value.copy(g[3]).multiplyScalar(k); terrain.mat.uniforms.uGrassLight.value.copy(g[4]).multiplyScalar(k);
  terrain.mat.uniforms.uDirt.value.copy(DIRT).multiplyScalar(k * k);
}
const DIRT = C('#b49a74');
grass.uniforms.uSheen.value = C('#f4ffc8'); terrain.mat.uniforms.uDirt.value = DIRT.clone();
setGround(SUMMER_GROUND);

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
  motes.m.uniforms.uPR.value = pixelRatio; snow.uniforms.uPR.value = pixelRatio;
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

// ---------- fly-overs. Each cycle picks a new line of flight from wherever the camera is
// looking when it starts, so a flock or an airliner always crosses the view.
const view = new THREE.Vector3();
function viewAzimuth() { camera.getWorldDirection(view); view.y = 0; return view.lengthSq() > 1e-6 ? view.normalize() : view.set(0, 0, -1); }
const BIRD_P = 55, BIRD_O = BIRD_P - 9, BIRD_SPEED = 8, BIRD_HALF = 90;
let birdCycle = -1;
const flockC = new THREE.Vector3(), flockDir = new THREE.Vector3();
function updateBirds(t, on) {
  const c = Math.floor((t + BIRD_O) / BIRD_P), tau = (t + BIRD_O) - c * BIRD_P;
  if (c !== birdCycle) {
    birdCycle = c;
    const r = mulberry32(c * 7919 + 1), f = viewAzimuth();
    const side = new THREE.Vector3(-f.z, 0, f.x);
    const ahead = 45 + r() * 50;
    // cross the view at a slant, left-to-right or right-to-left
    const a = (r() - 0.5) * 0.9;
    flockDir.copy(side).multiplyScalar(r() < 0.5 ? 1 : -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
    flockC.copy(camera.position).addScaledVector(f, ahead).addScaledVector(side, (r() - 0.5) * ahead * 0.4);
    flockC.y = Math.max(camera.position.y, GROUND) + 5 + r() * 7;
  }
  const s = tau * BIRD_SPEED - BIRD_HALF;
  birds.uniforms.uFlockPos.value.copy(flockC).addScaledVector(flockDir, s);
  birds.uniforms.uFlockPos.value.y += Math.sin(tau * 0.4) * 1.5;
  birds.uniforms.uFlockDir.value.copy(flockDir);
  birds.uniforms.uFlockOn.value = on && s < BIRD_HALF ? 1 : 0;
}
const TRAIL_P = 130, TRAIL_O = 46, TRAIL_SPEED = 0.022;
let trailCycle = -1;
function updateContrail(t, on) {
  const c = Math.floor((t + TRAIL_O) / TRAIL_P), tau = (t + TRAIL_O) - c * TRAIL_P;
  const u = sky.uniforms;
  if (c !== trailCycle) {
    trailCycle = c;
    const r = mulberry32(c * 104729 + 3), f = viewAzimuth();
    // the point where it crosses: in front of the camera, 25-55 degrees up
    const az = (r() - 0.5) * 1.0, el = THREE.MathUtils.degToRad(25 + r() * 30);
    const fh = f.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), az);
    const C = fh.clone().multiplyScalar(Math.cos(el)).setY(Math.sin(el)).normalize();
    // heading at that point: mostly across the view, tilted a little
    const across = new THREE.Vector3(-fh.z, 0, fh.x).multiplyScalar(r() < 0.5 ? 1 : -1);
    const upT = new THREE.Vector3().crossVectors(C, across).normalize();
    const tangent = across.clone().sub(C.clone().multiplyScalar(across.dot(C))).normalize().addScaledVector(upT, (r() - 0.5) * 0.8).normalize();
    u.uTrailRef.value.copy(C);
    u.uTrailAxis.value.crossVectors(C, tangent).normalize();
  }
  u.uTrailHead.value = -1.2 + tau * TRAIL_SPEED;
  u.uTrailLen.value = Math.min(tau * TRAIL_SPEED, 0.9);
  u.uTrailOn.value = on ? THREE.MathUtils.smoothstep(TRAIL_P - tau, 0, 12) : 0;
}

// ---------- apply settings each frame
const tmp = new THREE.Vector3();
// time-lapse weather flicker: each 'day' of a year gets its own cloud and light
const dayHash = (d, k) => { const x = Math.sin(d * 127.1 + k * 311.7) * 43758.5453; return x - Math.floor(x); };
let SE = null, animFade = 1, lastMode = 'off', animAz = 0;
// time zoom state: tau = real seconds since its start, sim = simulated seconds elapsed
const ZM = { tau: 0, sim: 0, start: new Date(), rate: 1, k: 0, now: new Date() };
function zoomStart() {
  const now = new Date(), h = Q.has('hour') ? num('hour', 12) : now.getHours() + now.getMinutes() / 60;
  ZM.start = Q.has('season') ? J.dateOfSeason(num('season', 0), now.getFullYear(), h) : (Q.has('hour') ? J.dateOfSeason(J.seasonOfDate(now), now.getFullYear(), h) : now);
}
function zoomSeek(progress) { ZM.tau = progress * AN.length; ZM.sim = J.simSecondsAt(ZM.tau, AN.length); }
zoomStart(); if (AN.mode === 'zoom') zoomSeek(AN.progress);
const clockEl = document.getElementById('clock');
const DAY_KNOTS = [[0, 0], [0.5, NIGHT_T], [0.6, NIGHT_T], [1, DAY_T]];
function dayCycleTime(p) {
  p = ((p % 1) + 1) % 1;
  for (let i = 1; i < DAY_KNOTS.length; i++) {
    const [p1, t1] = DAY_KNOTS[i], [p0, t0] = DAY_KNOTS[i - 1];
    if (p <= p1) return t0 + (t1 - t0) * (p - p0) / (p1 - p0);
  }
  return 0;
}
// Rain (0 … 1) turns any time of day overcast: colours drain toward a cool grey at about the
// same brightness, the direct sun goes, ambient light rises to make up for it, and a hazy
// distance closes in.
const GREY = new THREE.Color(), WARM = new THREE.Color(0.9, 0.96, 1.08);
function grey(c, k, r) {
  const l = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
  return c.lerp(GREY.copy(WARM).multiplyScalar(l * k), r);
}
function wetPreset(P, r) {
  if (r <= 0) return P;
  grey(P.zenith, 0.85, r); grey(P.mid, 0.95, r); grey(P.horizon, 0.9, r);
  grey(P.cloudLit, 0.6, r); grey(P.cloudShade, 0.8, r); P.cloudRim.multiplyScalar(1 - r * 0.9);
  const sky = (P.ambient.r + P.ambient.g + P.ambient.b) / 3 + (P.sun.r + P.sun.g + P.sun.b) / 3 * 0.08;
  P.ambient.lerp(GREY.copy(WARM).multiplyScalar(sky * 1.05), r);
  P.sun.multiplyScalar(1 - r * 0.85);
  grey(P.fog, 0.85, r); P.fogSun.lerp(P.fog, r);
  P.fogK *= 1 + r * 3; P.disc.multiplyScalar(1 - r); P.glow *= 1 - r * 0.8; P.stars *= 1 - r;
  P.shafts *= 1 - r; P.flare *= 1 - r; P.sat *= 1 - r * 0.22;
  return P;
}
function applyAnim() {
  if (AN.mode !== lastMode) {
    if (lastMode === 'year' || lastMode === 'zoom') { tree.setStyle(S.style); setGround(SUMMER_GROUND); }
    lastMode = AN.mode;
  }
  animFade = 1; SE = null; animAz = 0;
  clockEl.hidden = AN.mode !== 'zoom';
  if (AN.mode === 'day') {
    // once round the clock and back to noon, so it loops without a cut: noon … magic hour
    // over the first half, a short hold in the night, then dawn and morning
    S.time = dayCycleTime(AN.progress);
  } else if (AN.mode === 'year') {
    SE = sampleSeason(AN.progress);
    tree.setSeason(SE);
    setGround(SE.ground);
    const day = Math.floor(AN.progress * 365);
    SE.clouds += (dayHash(day, 1) - 0.5) * 0.3;
    SE.light = 1 + (dayHash(day, 2) - 0.5) * 0.08;
    SE.rain = AN.weather ? rainOnDay(AN.progress * 365, SE.wet) * (1 - SE.snowFall) : 0;
  } else if (AN.mode === 'zoom') {
    const now = ZM.now = new Date(ZM.start.getTime() + ZM.sim * 1000);
    ZM.rate = J.rate(ZM.tau, AN.length); ZM.k = J.dayLock(ZM.tau, AN.length);
    const h = J.warpHour(now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600, AN.lockHour, ZM.k);
    S.time = J.hourToTime(h);
    // the sun crosses the sky, east in the morning to west in the evening; the moon stays
    // put, so the swing fades out through the night and never jumps at midnight
    const hs = ((((h - 12) % 24) + 36) % 24) - 12;
    animAz = hs * 9;
    SE = sampleSeason(J.seasonOfDate(now));
    tree.setSeason(SE); setGround(SE.ground);
    const day = Math.floor(ZM.sim / 86400);
    SE.clouds += (dayHash(day, 1) - 0.5) * 0.3 * ZM.k;
    SE.light = 1 + (dayHash(day, 2) - 0.5) * 0.08 * ZM.k;
    // rainy spells come in once it's past real time (the start shows the sky as it is)
    SE.rain = AN.weather ? rainOnDay(ZM.sim / 86400, SE.wet) * (1 - SE.snowFall) * THREE.MathUtils.smoothstep(ZM.tau / AN.length, 0.14, 0.32) : 0;
    const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    const time = ZM.k < 0.5 ? ' · ' + now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
    clockEl.textContent = `${date}${time} · ${J.formatSpeed(ZM.rate)}`;
  }
}
let wasWet = false;
function applyLook() {
  applyAnim();
  const R = Math.max(S.rain, SE && SE.rain ? SE.rain : 0);
  if (R > 0 || wasWet) setGround(SE ? SE.ground : SUMMER_GROUND, 1 - 0.32 * R);
  wasWet = R > 0;
  const P = wetPreset(samplePreset(S.time), R);
  const el = THREE.MathUtils.degToRad(P.sunEl), az = THREE.MathUtils.degToRad(S.azimuth + animAz * (1 - P.night) + (P.night > 0.5 ? 140 : 0));
  const sd = shared.uSunDir.value.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az));
  // light fades out as the sun sets, then the moon takes over
  const lightK = THREE.MathUtils.smoothstep(P.sunEl, -4, 2);
  if (sd.y < 0.02) sd.y = 0.02; sd.normalize();
  shared.uSunColor.value.copy(P.sun).multiplyScalar(lightK);
  shared.uAmbient.value.copy(P.ambient);
  shared.uFogColor.value.copy(P.fog); shared.uFogSunColor.value.copy(P.fogSun);
  shared.uFogDensity.value = 0.0009 * P.fogK;
  shared.uCloudCover.value = THREE.MathUtils.clamp(S.clouds + (SE ? SE.clouds : 0) + R, 0, 1);
  sky.uniforms.uRain.value = R; rain.uniforms.uRain.value = R * (SE ? 1 - Math.min(1, SE.snowFall * 2) : 1);
  terrain.mat.uniforms.uRain.value = rain.uniforms.uRain.value;
  shared.uSnowCover.value = SE ? SE.snowCover : 0;
  snow.uniforms.uSnowFall.value = SE ? SE.snowFall : 0;
  grass.flowerUniforms.uFlowers.value = SE ? SE.flowers : 1;
  shared.uCloudShadow.value = 0.55 * lightK * (1 - P.night * 0.6) * (1 - R);
  const wa = THREE.MathUtils.degToRad(S.windDir);
  shared.uWind.value.set(Math.cos(wa), Math.sin(wa)).multiplyScalar(S.wind);
  const u = sky.uniforms;
  u.uZenith.value.copy(P.zenith); u.uMid.value.copy(P.mid); u.uHorizon.value.copy(P.horizon);
  u.uCloudLit.value.copy(P.cloudLit); u.uCloudShade.value.copy(P.cloudShade); u.uCloudRim.value.copy(P.cloudRim);
  u.uDiscColor.value.copy(P.disc).multiplyScalar(lightK); u.uDiscSize.value = P.discSize; u.uGlow.value = P.glow * lightK; u.uStars.value = P.stars;
  u.uTowers.value = S.towers;
  updateBirds(shared.uTime.value, S.birds && P.night < 0.5 && lightK > 0.3 && R < 0.35);
  updateContrail(shared.uTime.value, S.contrail && P.night < 0.5 && R < 0.2);
  birds.uniforms.uInk.value.copy(P.cloudShade).multiplyScalar(0.18);
  motes.m.uniforms.uNight.value = P.night; motes.m.visible = R < 0.5;
  sound.update({ day: 1 - P.night, night: P.night, dusk: Math.max(THREE.MathUtils.smoothstep(S.time, 1.6, 2.4) * (1 - THREE.MathUtils.smoothstep(S.time, 3.3, 3.8)), // higurashi call at dusk and again at dawn
      THREE.MathUtils.smoothstep(S.time, 4.6, 4.95) * (1 - THREE.MathUtils.smoothstep(S.time, 5.4, 5.9))),
    wind: S.wind, leaves: Math.min(1, S.leaves) * (SE ? SE.fall : 1), birdsK: (SE ? SE.birds : 1) * (1 - R), insects: (SE ? SE.insects : 1) * (1 - R * 0.85), rain: rain.uniforms.uRain.value, trail: sky.uniforms.uTrailOn.value, flock: birds.uniforms.uFlockOn.value, music: S.music, amb: S.ambience }, shared.uTime.value);
  tree.fallUniforms.uFallRate.value = S.leaves;
  tree.group.children[2].visible = S.leaves > 0.01 && (!SE || SE.fall > 0.005);

  // sun on screen, for shafts and flare
  tmp.copy(sd).multiplyScalar(4000).add(camera.position).project(camera);
  const onScreen = tmp.z < 1 && Math.abs(tmp.x) < 1.3 && Math.abs(tmp.y) < 1.3 ? 1 : 0;
  const edge = THREE.MathUtils.smoothstep(1.3 - Math.max(Math.abs(tmp.x), Math.abs(tmp.y)), 0, 0.4);
  const sunOn = onScreen * edge * lightK * (1 - R);
  const sunUv = new THREE.Vector2(tmp.x * 0.5 + 0.5, tmp.y * 0.5 + 0.5);
  post.light.uniforms.uSun.value.copy(sunUv); post.light.uniforms.uSunOn.value = sunOn * S.shafts;
  post.light.uniforms.uColor.value.copy(P.sun).multiplyScalar(0.25 * lightK); post.light.uniforms.uStrength.value = P.shafts;
  const inside = Math.abs(tmp.x) < 1 && Math.abs(tmp.y) < 1 ? 1 : 0;
  post.grade.uniforms.uSun.value.copy(sunUv); post.grade.uniforms.uSunOn.value = sunOn * inside;
  post.grade.uniforms.uFlare.value = P.flare * S.flare; post.grade.uniforms.uFlareColor.value.copy(P.sun).multiplyScalar(0.35);
  post.grade.uniforms.uExposure.value = P.exposure * S.exposure * animFade * (SE ? SE.light : 1); post.grade.uniforms.uSat.value = P.sat * S.saturation * (SE ? SE.sat : 1);
  post.grade.uniforms.uLift.value.copy(P.lift); post.grade.uniforms.uGain.value.copy(P.gain);
  post.final.uniforms.uPaper.value = S.paper; post.final.uniforms.uVignette.value = S.vignette;
  return P;
}

// ---------- UI
const gui = new GUI({ title: 'Sorairo' });
const names = Object.fromEntries(PRESETS.map((p, i) => [p.name, i]));
const fScene = gui.addFolder('Scene');
const timeCtl = fScene.add(S, 'time', 0, DAY_T, 0.01).name('time of day');
timeCtl.listen();
fScene.add({ preset: '' }, 'preset', names).name('jump to').onChange((v) => { S.time = +v; timeCtl.updateDisplay(); });
fScene.add(S, 'azimuth', -180, 180, 1).name('sun azimuth');
fScene.add(S, 'clouds', 0, 1, 0.01).name('cloud cover');
fScene.add(S, 'towers', 0, 1.6, 0.01).name('cumulus towers');
fScene.add(S, 'rain', 0, 1, 0.01).name('rain');
fScene.add(S, 'wind', 0, 3, 0.01);
fScene.add(S, 'windDir', 0, 360, 1).name('wind direction');
fScene.add(S, 'birds');
fScene.add(S, 'contrail');
const fTree = gui.addFolder('Tree');
fTree.add(S, 'style', Object.keys(TREE_STYLES)).onChange((v) => tree.setStyle(v));
fTree.add(S, 'turned', 0, 1, 0.01).name('autumn turned').onChange((v) => tree.setTurned(v));
fTree.add(S, 'leaves', 0, 3, 0.01).name('falling leaves');
fTree.add(S, 'airy', 0, 1, 0.05).name('canopy gaps').onFinishChange(() => rebuildTree());
fTree.add({ grow: () => { S.seed = (S.seed * 7 + 13) % 1000; rebuildTree(); } }, 'grow').name('grow another tree');
const fAnim = gui.addFolder('Animate');
fAnim.add(AN, 'mode', ANIMS).name('animation').onChange((v) => { AN.progress = 0; AN.length = ANIM_LEN[v]; lenCtl.updateDisplay(); if (v === 'zoom') { zoomStart(); zoomSeek(0); } });
fAnim.add(AN, 'playing').name('play');
fAnim.add(AN, 'progress', 0, 1, 0.001).name('progress').listen().onChange((v) => AN.mode === 'zoom' && zoomSeek(v));
fAnim.add({ jump: '' }, 'jump', SEASON_MARKS).name('jump to season').onChange((v) => { AN.mode = 'year'; AN.progress = +v; AN.playing = false; gui.controllersRecursive().forEach((c) => c.updateDisplay()); });
const lenCtl = fAnim.add(AN, 'length', 10, 300, 1).name('seconds per loop').onFinishChange(() => AN.mode === 'zoom' && zoomSeek(Math.min(1, AN.progress)));
fAnim.add(AN, 'lockHour', 6, 18, 0.25).name('time zoom: hour kept');
fAnim.add({ restart: () => { AN.mode = 'zoom'; AN.length = ANIM_LEN.zoom; AN.playing = true; zoomStart(); zoomSeek(0); AN.progress = 0; gui.controllersRecursive().forEach((c) => c.updateDisplay()); } }, 'restart').name('start time zoom from now');
fAnim.add(AN, 'lapse', 1, 100, 1).name('cloud speed-up');
fAnim.add(AN, 'drift', 0, 2, 0.05).name('camera drift');
fAnim.add(AN, 'weather').name('rainy days');
if (AN.mode !== 'off') fAnim.open();
const fSound = gui.addFolder('Sound');
const soundCtl = fSound.add(S, 'sound').name('sound on (M)').onChange((v) => setSound(v));
fSound.add(S, 'music', 0, 1, 0.01);
fSound.add(S, 'ambience', 0, 1, 0.01).name('wind, birds, insects');
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
  tree = makeTree(shared, GROUND, S.seed, { fallCount: MOBILE ? 220 : 420, airy: S.airy, turned: S.turned });
  tree.setStyle(S.style); scene.add(tree.group);
}
function savePNG() {
  frame(0);
  renderer.domElement.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `sorairo-${Date.now()}.png`; a.click(); });
}
// ---------- sound: browsers only allow audio after a gesture, so it starts on a click.
// ?sound=1 arms it to start on the first click or key anywhere.
const sound = makeLiveAudio();
const soundBtn = document.getElementById('sound');
function setSound(on) {
  S.sound = on; sound.setOn(on); soundCtl.updateDisplay();
  soundBtn.textContent = on ? '♪ sound on' : '♪ sound off'; soundBtn.classList.toggle('on', on);
}
soundBtn.addEventListener('click', () => setSound(!S.sound));
if (Q.get('sound') === '1') { const arm = () => { setSound(true); removeEventListener('pointerdown', arm); removeEventListener('keydown', arm); }; addEventListener('pointerdown', arm); addEventListener('keydown', arm); }
if (Q.has('noui')) soundBtn.style.display = 'none';
if (Q.has('noui') && !Q.has('clock')) clockEl.style.display = 'none';
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'm' || e.key === 'M') setSound(!S.sound);
  if (e.key === 'h' || e.key === 'H') { gui._hidden ? gui.show() : gui.hide(); document.getElementById('title').classList.toggle('gone'); soundBtn.classList.toggle('gone'); clockEl.classList.toggle('gone'); }
  if (e.key === 'p' || e.key === 'P') savePNG();
});

// ---------- camera drift: while a time-lapse plays the camera moves like a motion-control
// slider shot, swinging slowly around the tree and back with a slight push in and rise.
// The swing is relative (applied as frame-to-frame increments), so it carries on from
// wherever you leave the view; it pauses while you drag and for 2 s after.
const sph = new THREE.Spherical(), off3 = new THREE.Vector3();
let driftT = 0, driftPrev = null, userHold = 0;
controls.addEventListener('start', () => (userHold = Infinity));
controls.addEventListener('end', () => (userHold = 2));
function driftCamera(dt) {
  if (AN.mode === 'off' || !AN.playing || AN.drift <= 0 || S.orbit || dt === 0) { driftPrev = null; return; }
  if (userHold > 0) { userHold -= dt; driftPrev = null; return; }
  driftT += dt;
  // one full swing per two loops, with the push and rise on slower, offset cycles so the
  // path doesn't repeat exactly
  const w = (2 * Math.PI) / (AN.length * 2), k = AN.drift;
  const cur = { a: Math.sin(driftT * w) * 0.4 * k, r: Math.sin(driftT * w * 0.63 + 1.3) * 0.12 * k, e: Math.sin(driftT * w * 0.41 + 0.4) * 0.05 * k };
  if (driftPrev) {
    sph.setFromVector3(off3.copy(camera.position).sub(controls.target));
    sph.theta += cur.a - driftPrev.a;
    sph.radius = THREE.MathUtils.clamp(sph.radius * Math.exp(driftPrev.r - cur.r), controls.minDistance, controls.maxDistance);
    sph.phi = THREE.MathUtils.clamp(sph.phi - (cur.e - driftPrev.e), 0.35, 1.7);
    camera.position.copy(controls.target).add(off3.setFromSpherical(sph));
  }
  driftPrev = cur;
}

// ---------- loop
const clock = new THREE.Clock();
let frames = 0, acc = 0;
const FIXED_T = Q.has('t') ? num('t', 0) : null;
function frame(dt) {
  shared.uTime.value = FIXED_T ?? shared.uTime.value + dt;
  // time-lapses race the clouds; a still frame keeps them where uTime puts them
  // the time zoom starts in real time, so its clouds speed up with it
  const lapse = AN.mode !== 'off' && AN.playing ? (AN.mode === 'zoom' ? Math.min(AN.lapse, ZM.rate) : AN.lapse) : 1;
  shared.uCloudT.value = FIXED_T !== null ? FIXED_T : shared.uCloudT.value + dt * lapse;
  if (AN.mode === 'zoom') {
    if (AN.playing && !Q.has('still')) { ZM.sim += J.rate(ZM.tau, AN.length) * dt; ZM.tau += dt; }
    AN.progress = Math.min(1, ZM.tau / AN.length);
  } else if (AN.mode !== 'off' && AN.playing && !Q.has('still')) AN.progress = (AN.progress + dt / AN.length) % 1;
  driftCamera(dt);
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
window.__sorairo = { S, AN, ZM, camera, grass, tree, birds, frame, setShot };

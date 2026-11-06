// Mossglen: a mossy glen with a recumbent stone circle, a peaty burn and old oaks, where the
// moss grows on a front you can scrub through (Growth), spread (Cover), thicken (Lush), and
// paint or scrape by hand. Scene assembly, light presets, shadow pass, input, UI, quality.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'three/addons/libs/lil-gui.module.min.js';
import { makeShared } from './glsl.js';
import { heightAt, terrainGeometry, makeWater, makeHills, makeSky, mulberry32, setTerrainSeed } from './world.js';
import { buildProps } from './props.js';
import { makeGrowth } from './growth.js';
import { makeSurfaceMaterial, makeShells, makeSporophytes } from './moss.js';
import { makeFerns, makeRushes, makeCanopy, makeMotes, makeWisps } from './flora.js';
import { makePost } from './post.js';

const URLQ = new URLSearchParams(location.search);
const num = (k, d) => (URLQ.has(k) ? parseFloat(URLQ.get(k)) : d);
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
const SHOT = URLQ.has('shot');

// ---------- quality tiers: 0 phones, 1 laptops, 2 desktops
const TIERS = [
  { terrainN: 150, rockDetail: 3, trunkM: 7, branchM: 4, depth: 3, trees: 7, burnStones: 10, shells: 4, shellDist: 8, sporo: 6000, ferns: 70, rushes: 45, perSpot: 5, shadow: 1024, taps: 4, msaa: 0, wispLights: 2, motes: 160, maxDpr: 1.5, shaftTaps: 20 },
  { terrainN: 190, rockDetail: 3, trunkM: 8, branchM: 5, depth: 3, trees: 9, burnStones: 14, shells: 7, shellDist: 12, sporo: 14000, ferns: 130, rushes: 70, perSpot: 7, shadow: 2048, taps: 9, msaa: 4, wispLights: 4, motes: 300, maxDpr: 1.5, shaftTaps: 28 },
  { terrainN: 230, rockDetail: 4, trunkM: 9, branchM: 5, depth: 3, trees: 10, burnStones: 18, shells: 10, shellDist: 16, sporo: 26000, ferns: 200, rushes: 90, perSpot: 8, shadow: 2048, taps: 9, msaa: 4, wispLights: 4, motes: 400, maxDpr: 1.75, shaftTaps: 36 },
];
const tier = Math.round(num('q', MOBILE ? 0 : 2));
const Q = TIERS[Math.max(0, Math.min(2, tier))];
const defines = { SHADOW_TAPS: Q.taps, WISP_LIGHTS: Q.wispLights };

// ---------- renderer and scene
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: SHOT });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(MOBILE ? 52 : 45, innerWidth / innerHeight, 0.05, 1200);
const shared = makeShared();
const status = document.getElementById('status');
const say = (s) => { if (status) status.textContent = s; };

// ---------- light presets: morning mist, a soft day, golden evening, the gloaming
const C = (r, g, b, k = 1) => new THREE.Color(r * k, g * k, b * k);
const LIGHTS = [
  { name: 'Morning mist', el: 9, az: -25, sun: C(1, 0.82, 0.6, 4), sky: C(0.32, 0.38, 0.44, 0.9), ground: C(0.09, 0.08, 0.04), fog: C(0.3, 0.37, 0.4), fogSun: C(1, 0.8, 0.55, 1.15), dens: 0.015, fall: 0.3, exp: 1.0, shafts: 0.85, cloud: 0.5, wisp: 0.25, lift: C(0.004, 0.009, 0.014), gain: C(1.02, 1, 0.95), sat: 1.18 },
  { name: 'Soft day', el: 36, az: 15, sun: C(1, 0.95, 0.86, 3.2), sky: C(0.38, 0.45, 0.52, 1.1), ground: C(0.12, 0.11, 0.06), fog: C(0.62, 0.67, 0.7), fogSun: C(1, 0.95, 0.86), dens: 0.009, fall: 0.2, exp: 0.9, shafts: 0.4, cloud: 0.75, wisp: 0.12, lift: C(0.004, 0.007, 0.01), gain: C(1, 1, 0.98), sat: 1.15 },
  { name: 'Golden evening', el: 5, az: 38, sun: C(1, 0.58, 0.28, 4.6), sky: C(0.3, 0.3, 0.42, 0.8), ground: C(0.1, 0.07, 0.04), fog: C(0.55, 0.45, 0.42), fogSun: C(1, 0.6, 0.3, 1.4), dens: 0.018, fall: 0.3, exp: 1.05, shafts: 0.75, cloud: 0.55, wisp: 0.5, lift: C(0.012, 0.006, 0.012), gain: C(1.03, 0.98, 0.9), sat: 1.15 },
  { name: 'Gloaming', el: 16, az: -12, sun: C(0.35, 0.45, 0.75, 0.9), sky: C(0.07, 0.1, 0.19), ground: C(0.02, 0.025, 0.03), fog: C(0.07, 0.09, 0.15), fogSun: C(0.22, 0.3, 0.48), dens: 0.04, fall: 0.3, exp: 1.7, shafts: 0.5, cloud: 0.6, wisp: 1, lift: C(0.008, 0.012, 0.025), gain: C(0.95, 0.98, 1.05), sat: 0.9 },
];
const sunDirOf = (el, az) => { const e = el * Math.PI / 180, a = az * Math.PI / 180; return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)); };

// ---------- state the UI drives
const S = {
  mode: 'look', brush: MOBILE ? 0.6 : 0.5, grow: num('grow', SHOT ? 0.85 : 0), cover: num('cover', 0.68), lush: num('lush', 1), wet: num('wet', 0.35),
  light: num('light', 0), wind: num('wind', 0.5), creep: 1.2, wisps: !URLQ.has('nowisps'), playing: !SHOT && !URLQ.has('grow'), playTo: 0.82, playSpeed: 1 / 22,
};

let seed = Math.round(num('seed', 5));
setTerrainSeed(seed);
async function build() {
  const t0 = performance.now(), first = scene.children.length;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  say('laying out the glen…'); await tick();
  const G = makeGrowth();
  const T = terrainGeometry(Q.terrainN);
  const terrainPart = G.add({ ...T, kind: 0, name: 'ground' });
  const props = buildProps(Q, seed);
  for (const p of props.parts) G.add(p);
  say('working out where the moss will grow…'); await tick();
  G.finalize({ rocks: props.rocks, trees: props.trees, sunDir: sunDirOf(LIGHTS[0].el, LIGHTS[0].az) });
  shared.uMossTex.value = G.tex; shared.uMossW.value = G.W;
  say('growing…'); await tick();
  const surf = makeSurfaceMaterial(shared, defines);
  const ground = new THREE.Mesh(G.geometry([terrainPart]), surf);
  const stones = new THREE.Mesh(G.geometry(G.parts.slice(1)), surf);
  ground.userData.castShadow = stones.userData.castShadow = true;
  ground.frustumCulled = false;
  scene.add(ground, stones);
  if (Q.shells > 0) { const sd = { ...defines, SHADOW_TAPS: 4 }; // 4 taps per layer is enough; the surface below does the 9-tap lookup
    scene.add(makeShells(ground.geometry, shared, sd, Q.shells), makeShells(stones.geometry, shared, sd, Q.shells)); }
  const rnd = mulberry32(77 + seed * 31);
  scene.add(makeSporophytes(G, shared, defines, Q.sporo, rnd));
  scene.add(makeFerns(G, shared, defines, Q.ferns, rnd));
  scene.add(makeRushes(G, shared, defines, Q.rushes, rnd));
  scene.add(makeCanopy(props.trees, shared, Q.msaa ? { ...defines, A2C: 1 } : defines, Q.perSpot, rnd));
  scene.add(makeWater(shared, defines), makeHills(shared, defines), makeSky(shared, defines));
  scene.add(makeMotes(shared, defines, Q.motes, rnd));
  const wisps = makeWisps(shared, defines, 9, rnd, heightAt); scene.add(wisps);
  // bounding spheres for picking the props
  for (const p of G.parts) {
    let x = 0, y = 0, z = 0; for (let i = 0; i < p.count; i++) { x += p.pos[i * 3]; y += p.pos[i * 3 + 1]; z += p.pos[i * 3 + 2]; }
    p.c = new THREE.Vector3(x / p.count, y / p.count, z / p.count); let r = 0;
    for (let i = 0; i < p.count; i++) r = Math.max(r, Math.hypot(p.pos[i * 3] - p.c.x, p.pos[i * 3 + 1] - p.c.y, p.pos[i * 3 + 2] - p.c.z));
    p.r = r;
  }
  return { G, props, wisps, objs: scene.children.slice(first), ms: performance.now() - t0 };
}

// ---------- a new glen: the old one sinks into the mere, a new one is rolled and rises from the
// stone circle outward on a glowing front, then the moss floods over it
let conj = null;
function dispose(o) {
  o.traverse((c) => {
    c.geometry?.dispose();
    for (const mat of [c.material, c.userData.shadowMat]) {
      if (!mat) continue; mat.dispose();
      for (const u of Object.values(mat.uniforms || {})) if (u.value?.isTexture && u.value !== shared.uMossTex.value && u.value !== shared.uShadowMap.value) u.value.dispose();
    }
  });
}
async function conjure(newSeed = (Math.random() * 1e6) | 0) {
  if (conj) return;
  conj = { phase: 'sink', t: 0 };
  S.playing = false; hint('');
  $('newglen')?.classList.add('on');
  await new Promise((r) => { conj.done = r; });             // frame() runs the sink
  conj.phase = 'build'; hint('the glen is dreaming…');
  for (const o of W.objs) { scene.remove(o); dispose(o); }
  W.G.tex.dispose();
  seed = newSeed; setTerrainSeed(seed);
  W = await build();
  applyLight(S.light); shadowDirty = false;
  S.grow = 0; W.G.creep = S.creep; syncGrowUI(); hint('');
  conj = { phase: 'rise', t: 0 };
}
function stepConjure(dt) {
  if (!conj) return;
  conj.t += dt;
  const u = shared.uReveal, gl = shared.uRevealGlow;
  if (conj.phase === 'sink') {
    shared.uShadowOn.value = 0; gl.value = 0.6;
    u.value = 140 * Math.pow(Math.max(0, 1 - conj.t / 0.9), 2);
    if (conj.t > 0.95) { u.value = 0; conj.phase = 'wait'; conj.done(); }
  } else if (conj.phase === 'rise') {
    shared.uShadowOn.value = 0; gl.value = 1;
    const x = conj.t / 3.2; u.value = 2 + 150 * x * x;
    if (x >= 1) {
      u.value = 1e5; gl.value = 0; conj = null; shadowDirty = true; $('newglen')?.classList.remove('on');
      // and the moss comes in fast
      S.playTo = 0.85; S.playSpeed = 1 / 6; S.playing = true; syncGrowUI();
    }
  }
}

// ---------- shadow map from the sun (only redrawn when the light changes)
const shadowRT = new THREE.WebGLRenderTarget(Q.shadow, Q.shadow, { depthTexture: new THREE.DepthTexture(Q.shadow, Q.shadow, THREE.FloatType), depthBuffer: true });
const shadowCam = new THREE.OrthographicCamera(-30, 30, 30, -30, 1, 160);
const shadowBasic = new THREE.MeshBasicMaterial();
shared.uShadowMap.value = shadowRT.depthTexture;
function renderShadow() {
  const target = new THREE.Vector3(0, 0, 2);
  shadowCam.position.copy(target).addScaledVector(shared.uSunDir.value, 80);
  shadowCam.lookAt(target); shadowCam.updateMatrixWorld(); shadowCam.updateProjectionMatrix();
  shared.uShadowMatrix.value.multiplyMatrices(shadowCam.projectionMatrix, shadowCam.matrixWorldInverse);
  const swapped = [];
  scene.traverse((o) => {
    if (!o.isMesh && !o.isPoints) return;
    if (o.userData.castShadow) { swapped.push([o, o.material, true]); o.material = o.userData.shadowMat || shadowBasic; }
    else if (o.visible) { swapped.push([o, null, false]); o.visible = false; }
  });
  shared.uShadowOn.value = 0;
  renderer.setRenderTarget(shadowRT); renderer.setClearColor(0xffffff, 1); renderer.clear(); renderer.render(scene, shadowCam);
  renderer.setRenderTarget(null);
  for (const [o, m, mat] of swapped) { if (mat) o.material = m; else o.visible = true; }
  shared.uShadowOn.value = 1;
}

// ---------- light: interpolate the presets
let shadowDirty = true, lastLight = -1;
const post = makePost(renderer, { samples: Q.msaa, shaftTaps: Q.shaftTaps });
function applyLight(t) {
  const i = Math.min(LIGHTS.length - 2, Math.floor(t)), f = t - i, A = LIGHTS[i], B = LIGHTS[i + 1];
  const L = (a, b) => a + (b - a) * f;
  shared.uSunDir.value.copy(sunDirOf(L(A.el, B.el), L(A.az, B.az)));
  shared.uSunColor.value.copy(A.sun).lerp(B.sun, f); shared.uSkyAmb.value.copy(A.sky).lerp(B.sky, f); shared.uGroundAmb.value.copy(A.ground).lerp(B.ground, f);
  shared.uFogColor.value.copy(A.fog).lerp(B.fog, f); shared.uFogSun.value.copy(A.fogSun).lerp(B.fogSun, f);
  shared.uFogDensity.value = L(A.dens, B.dens); shared.uFogFall.value = L(A.fall, B.fall);
  const cu = post.comp.uniforms; cu.uExposure.value = L(A.exp, B.exp); cu.uLift.value.copy(A.lift).lerp(B.lift, f); cu.uGain.value.copy(A.gain).lerp(B.gain, f); cu.uSat.value = L(A.sat, B.sat);
  cu.uShaftColor.value.copy(shared.uFogSun.value).multiplyScalar(0.5);
  post.shaftStrength = L(A.shafts, B.shafts); S.wispK = L(A.wisp, B.wisp);
  scene.traverse((o) => { if (o.material?.uniforms?.uCloud) o.material.uniforms.uCloud.value = L(A.cloud, B.cloud); });
  shadowDirty = true; lastLight = t;
}

// ---------- camera
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 0.35; controls.maxDistance = 32; controls.maxPolarAngle = Math.PI * 0.52;
controls.zoomSpeed = 0.8; controls.rotateSpeed = 0.6;
const cam0 = (URLQ.get('cam') || '').split(',').map(Number);
function resetView() {
  if (cam0.length === 6 && cam0.every(Number.isFinite)) { camera.position.set(cam0[0], cam0[1], cam0[2]); controls.target.set(cam0[3], cam0[4], cam0[5]); }
  else if (MOBILE && innerHeight > innerWidth) { camera.position.set(3.2, heightAt(3.2, 15.5) + 1.6, 15.5); controls.target.set(-0.5, 1.0, 1); }
  else { camera.position.set(5.5, heightAt(5.5, 15.5) + 2.0, 15.5); controls.target.set(-0.6, 0.7, 2); }
  controls.update();
}
function keepAboveGround() {
  const g = heightAt(camera.position.x, camera.position.z) + 0.22;
  if (camera.position.y < g) camera.position.y = g;
  const t = controls.target, r = Math.hypot(t.x, t.z - 2);
  if (r > 26) { t.x *= 26 / r; t.z = 2 + (t.z - 2) * 26 / r; }
  const tg = heightAt(t.x, t.z) + 0.05; if (t.y < tg) t.y = tg;
}

// ---------- picking: march the height field for the ground, triangles for the props
const ray = new THREE.Ray(), ndc = new THREE.Vector2();
const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), pv = new THREE.Vector3(), tv = new THREE.Vector3(), qv = new THREE.Vector3();
function pick(cx, cy, W) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  camera.updateMatrixWorld();
  ray.origin.setFromMatrixPosition(camera.matrixWorld);
  ray.direction.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(ray.origin).normalize();
  let best = Infinity, bn = null;
  const o = ray.origin, d = ray.direction;
  // ground
  let tPrev = 0, t = 0.05;
  while (t < 90) {
    const y = o.y + d.y * t - heightAt(o.x + d.x * t, o.z + d.z * t);
    if (y < 0) { let a = tPrev, b = t; for (let k = 0; k < 8; k++) { const m = (a + b) / 2; if (o.y + d.y * m - heightAt(o.x + d.x * m, o.z + d.z * m) < 0) b = m; else a = m; } best = b; bn = 'ground'; break; }
    tPrev = t; t += Math.max(0.05, t * 0.02);
  }
  // props
  for (const p of W.G.parts) {
    if (p.kind === 0) continue;
    const oc = qv.subVectors(p.c, o), tc = oc.dot(d); if (tc < -p.r || tc - p.r > best) continue;
    if (oc.lengthSq() - tc * tc > p.r * p.r) continue;
    const P = p.pos, I = p.idx;
    for (let k = 0; k < I.length; k += 3) {
      const a = I[k] * 3, b = I[k + 1] * 3, c = I[k + 2] * 3;
      e1.set(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]); e2.set(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]);
      pv.crossVectors(d, e2); const det = e1.dot(pv); if (Math.abs(det) < 1e-9) continue;
      const inv = 1 / det; tv.set(o.x - P[a], o.y - P[a + 1], o.z - P[a + 2]);
      const u = tv.dot(pv) * inv; if (u < 0 || u > 1) continue;
      qv.crossVectors(tv, e1); const v = d.dot(qv) * inv; if (v < 0 || u + v > 1) continue;
      const tt = e2.dot(qv) * inv; if (tt > 0.01 && tt < best) { best = tt; bn = p.name; }
    }
  }
  if (!bn) return null;
  return { point: o.clone().addScaledVector(d, best), name: bn, t: best };
}

// ---------- the brush ring
const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: 0xfff1d0, transparent: true, opacity: 0.5, depthTest: false, side: THREE.DoubleSide }));
ring.visible = false; ring.renderOrder = 9; scene.add(ring);
function showRing(hit) {
  if (!hit || S.mode === 'look') { ring.visible = false; return; }
  ring.visible = true; ring.position.copy(hit.point); ring.scale.setScalar(S.brush);
  ring.lookAt(camera.position); ring.material.color.set(S.mode === 'scrape' ? 0xffc0a0 : 0xe0ffc0);
}

// ---------- UI
const $ = (id) => document.getElementById(id);
function setMode(m) {
  S.mode = m;
  for (const b of document.querySelectorAll('[data-mode]')) b.classList.toggle('on', b.dataset.mode === m);
  const paint = m !== 'look';
  controls.touches = paint ? { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE } : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
  controls.mouseButtons = paint ? { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE } : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  if (!paint) ring.visible = false;
  hint(paint ? (MOBILE ? 'Paint with one finger · two fingers turn and zoom' : 'Paint with the left button · right-drag turns, wheel zooms') : '');
}
let hintTimer = 0;
function hint(s) { const h = $('hint'); if (!h) return; h.textContent = s; h.classList.toggle('show', !!s); clearTimeout(hintTimer); if (s) hintTimer = setTimeout(() => h.classList.remove('show'), 3500); }
function syncGrowUI() { const g = $('grow'); if (g && document.activeElement !== g) g.value = S.grow; const p = $('play'); if (p) p.textContent = S.playing ? '❚❚' : '▶'; }

let W = null, time = 0, fpsAvg = 16.7, scale = 1, lastSize = '';
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, Q.maxDpr) * scale;
  renderer.setPixelRatio(dpr); renderer.setSize(innerWidth, innerHeight, true);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr), key = `${w}x${h}`;
  if (key !== lastSize) { post.setSize(w, h); lastSize = key; }
  shared.uPix.value = 2 * Math.tan(camera.fov * Math.PI / 360) / h;
}
addEventListener('resize', resize);

// painting input
let stroke = null; const touches = new Set();
const cvs = renderer.domElement;
cvs.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') touches.add(e.pointerId);
  if (S.mode === 'look' || !W || touches.size > 1 || (e.pointerType === 'mouse' && e.button !== 0)) { stroke = null; return; }
  stroke = { id: e.pointerId, x: e.clientX, y: e.clientY };
  paintAt(e.clientX, e.clientY);
});
cvs.addEventListener('pointermove', (e) => {
  if (!W) return;
  if (stroke && e.pointerId === stroke.id && touches.size <= 1) { stroke.x = e.clientX; stroke.y = e.clientY; paintAt(e.clientX, e.clientY); }
  else if (S.mode !== 'look' && e.pointerType === 'mouse') showRing(pick(e.clientX, e.clientY, W));
});
const up = (e) => { touches.delete(e.pointerId); if (stroke && e.pointerId === stroke.id) stroke = null; };
cvs.addEventListener('pointerup', up); cvs.addEventListener('pointercancel', up);
cvs.addEventListener('contextmenu', (e) => e.preventDefault());
function paintAt(x, y) {
  const hit = pick(x, y, W); showRing(hit);
  if (hit) W.G.brush(hit.point, S.brush, S.mode === 'scrape' ? 'scrape' : 'grow');
  return hit;
}

function buildUI() {
  for (const b of document.querySelectorAll('[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('grow').addEventListener('input', (e) => { S.grow = +e.target.value; S.playing = false; syncGrowUI(); });
  $('play').addEventListener('click', () => { if (S.grow >= S.playTo - 0.005) { S.grow = 0; S.playTo = 1; } S.playing = !S.playing; syncGrowUI(); });
  $('size').addEventListener('input', (e) => { S.brush = +e.target.value; });
  $('newglen').addEventListener('click', () => conjure());
  $('size').value = S.brush;
  const gui = new GUI({ title: 'Glen' });
  gui.add(S, 'cover', 0, 1, 0.01).name('Cover (how far it reaches)');
  gui.add(S, 'lush', 0, 1.6, 0.01).name('Lushness');
  gui.add(S, 'wet', 0, 1, 0.01).name('Wet');
  gui.add(S, 'light', 0, LIGHTS.length - 1, 0.01).name('Light').onChange(() => applyLight(S.light));
  gui.add(S, 'wind', 0, 1.5, 0.01).name('Breeze');
  gui.add(S, 'creep', 0.2, 2.5, 0.01).name('Painted moss creeps (m)').onChange((v) => { W.G.creep = v; });
  gui.add(S, 'wisps').name('Wisps');
  const light = gui.addFolder('Light presets');
  LIGHTS.forEach((l, i) => light.add({ go: () => { S.light = i; applyLight(i); gui.controllersRecursive().forEach((c) => c.updateDisplay()); } }, 'go').name(l.name));
  gui.add({ clear: () => W.G.clear() }, 'clear').name('Clear painting');
  gui.add({ bare: () => { S.grow = 0; S.playing = false; W.G.clear(); syncGrowUI(); } }, 'bare').name('Bare glen');
  gui.add({ reset: resetView }, 'reset').name('Reset view');
  const info = { quality: ['phone', 'laptop', 'desktop'][tier], scale: '1.00', fps: '' };
  const f = gui.addFolder('Info'); f.add(info, 'quality').disable(); f.add(info, 'scale').listen().disable(); f.add(info, 'fps').listen().disable(); f.close();
  S.info = info;
  if (MOBILE || SHOT) gui.close();
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === '1') setMode('look'); if (e.key === '2') setMode('grow'); if (e.key === '3') setMode('scrape');
    if (e.key === ' ') { e.preventDefault(); $('play').click(); }
    if (e.key === '[') S.brush = Math.max(0.15, S.brush * 0.85); if (e.key === ']') S.brush = Math.min(2, S.brush * 1.18);
    if (e.key === 'h') document.body.classList.toggle('calm');
    if (e.key === 'n') conjure();
  });
}

// ---------- frame
function frame(dt) {
  time += dt;
  stepConjure(dt);
  if (conj && (conj.phase === 'wait' || conj.phase === 'build')) return;
  shared.uTime.value = time;
  if (S.playing) { S.grow = Math.min(S.playTo, S.grow + dt * S.playSpeed); if (S.grow >= S.playTo) { S.playing = false; S.playSpeed = 1 / 22; } syncGrowUI(); }
  shared.uGrow.value = S.grow; shared.uCover.value = S.cover; shared.uLush.value = S.lush; shared.uWet.value = S.wet; shared.uWind.value = S.wind;
  if (stroke && W) paintAt(stroke.x, stroke.y);
  W.G.update(Math.min(dt, 0.05));
  W.wisps.userData.update(time, S.wisps && S.wispK > 0.05);
  W.wisps.material.uniforms.uBright.value = S.wispK;
  for (const v of shared.uWisp.value) v.w *= S.wispK;
  controls.update(); keepAboveGround();
  if (shadowDirty) { renderShadow(); shadowDirty = false; }
  // light shafts: the sun's position on screen, faded as it leaves the view
  const sp = camera.position.clone().addScaledVector(shared.uSunDir.value, 500).project(camera);
  const facing = shared.uSunDir.value.dot(camera.getWorldDirection(tv));
  post.sun.set(sp.x * 0.5 + 0.5, sp.y * 0.5 + 0.5);
  post.shafts.uniforms.uOn.value = facing > 0 ? post.shaftStrength * THREE.MathUtils.smoothstep(facing, 0.0, 0.5) * (sp.z < 1 ? 1 : 0) : 0;
  post.comp.uniforms.uTime.value = time % 100;
  post.render(scene, camera);
}

let last = performance.now(), acc = 0, frames = 0;
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (URLQ.has('pause')) return;
  frame(dt);
  // adaptive resolution: hold about 60 fps (or 30 on phones when 60 is out of reach)
  fpsAvg += ((now - (loop.prev || now)) - fpsAvg) * 0.05; loop.prev = now; acc += dt; frames++;
  if (acc > 1.5) {
    const target = MOBILE ? 33 : 18;
    const old = scale;
    if (fpsAvg > target * 1.15 && scale > 0.5) scale = Math.max(0.5, scale * 0.88);
    else if (fpsAvg < target * 0.8 && scale < 1) scale = Math.min(1, scale * 1.06);
    if (Math.abs(old - scale) > 1e-3) resize();
    if (S.info) { S.info.scale = scale.toFixed(2); S.info.fps = `${Math.round(1000 / fpsAvg)} fps`; }
    acc = 0; frames = 0;
  }
}

(async () => {
  try {
    resize(); resetView();
    W = await build();
    applyLight(S.light);
    buildUI(); setMode('look'); syncGrowUI();
    $('status')?.remove();
    document.body.classList.add('ready');
    // test hooks
    window.__moss = {
      get W() { return W; }, get G() { return W.G; }, S, shared, scene, camera, controls, renderer, Q, tier,
      step(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) frame(dt); return time; },
      set(k, v) { S[k] = v; if (k === 'light') applyLight(v); if (k === 'creep') W.G.creep = v; syncGrowUI(); },
      setMode, conjure, get conj() { return conj; }, get seed() { return seed; }, pick: (x, y) => pick(x, y, W), paintAt: (x, y, mode) => { const m = S.mode; S.mode = mode; const h = paintAt(x, y); S.mode = m; return h && { name: h.name, p: h.point.toArray() }; },
      coverage: (from, to) => W.G.coverage({ grow: S.grow, cover: S.cover }, from, to),
      buildMs: W.ms, verts: W.G.N,
    };
    if (!SHOT && !URLQ.has('grow')) hint(MOBILE ? 'Watch it grow · then pick Grow and paint moss with a finger' : 'Watch it grow · then press Grow (2) and paint moss on stones, bark and ground');
    requestAnimationFrame(loop);
  } catch (e) { say('Could not start: ' + e.message); console.error(e); }
})();

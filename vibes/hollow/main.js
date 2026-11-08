// main.js - Hollow: generated wooden sculptures, carved hollow by smooth CSG, shown in a gallery.
// three.js r187 WebGPURenderer (WebGL 2 fallback) with a TSL post chain: scene pass with MRT
// normals -> GTAO, raymarched godrays from the key light's shadow map (bilateral blurred), bloom,
// AgX tone mapping, vignette and grain.
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, packNormalToRGB, unpackRGBToNormal, uniform, vec2, vec3, vec4, float, mix, smoothstep, length, screenUV, screenSize, hash, time, Fn, sample } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { godrays } from 'three/addons/tsl/display/GodraysNode.js';
import { bilateralBlur } from 'three/addons/tsl/display/BilateralBlurNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { makeSculpture, rng, FOOT } from './sdf.js';
import { makeWood, SPECIES, FINISHES } from './wood.js';
import { buildStudio, LIGHTS, PLINTH_TOP } from './studio.js';
import { buildDust } from './dust.js';
import { buildGlass, CASE_HALF } from './glass.js';
import { makeAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
// parameters come from the query and the hash, the hash winning, so a shared #link reopens the same view
const Q = new URLSearchParams(location.search);
for (const [k, v] of new URLSearchParams(location.hash.slice(1))) Q.set(k, v);
const SHOT = Q.has('shot');
const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
const TIER = Q.has('q') ? +Q.get('q') : phone ? 0 : 2;
const T = [
  { N: 104, shadow: 2048, steps: 32, gscale: 0.35, ao: false, pr: 1.5, dust: 1000 },
  { N: 128, shadow: 3072, steps: 48, gscale: 0.5, ao: true, pr: 1.75, dust: 2000 },
  { N: 152, shadow: 4096, steps: 64, gscale: 0.75, ao: true, pr: 2, dust: 2800 },
][Math.max(0, Math.min(2, TIER))];
const SCALE = 0.3; // unit space to metres: pieces stand about 0.57 m tall

const renderer = new THREE.WebGPURenderer({ canvas: $('gl'), antialias: true, forceWebGL: Q.has('webgl') });
renderer.shadowMap.enabled = true;
renderer.setClearColor(0x000000, 0); // the glass pass's alpha is what the glass takes away, so it clears to 0
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.AgXToneMapping;
let prCap = Math.min(devicePixelRatio, T.pr), prScale = 1;
renderer.setPixelRatio(prCap);
renderer.setSize(innerWidth, innerHeight);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d0b0a);
const camera = new THREE.PerspectiveCamera(32, innerWidth / innerHeight, 0.05, 30);
const target = new THREE.Vector3(0, PLINTH_TOP + 0.27, 0);
camera.position.set(1.15, 1.48, 1.85);
if (Q.has('cam')) { const c = Q.get('cam').split(',').map(Number); camera.position.set(c[0], c[1], c[2]); if (c.length >= 6) target.set(c[3], c[4], c[5]); }
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(target); controls.enableDamping = true; controls.dampingFactor = 0.07;
controls.minDistance = 0.6; controls.maxDistance = 5; controls.maxPolarAngle = 1.6; controls.enablePan = false;
controls.update();

const studio = buildStudio(scene, { shadowSize: T.shadow });
const wood = makeWood();
const turntable = new THREE.Group(); turntable.position.y = PLINTH_TOP - FOOT * SCALE; scene.add(turntable);
const piece = new THREE.Mesh(new THREE.BufferGeometry(), wood.mat);
piece.scale.setScalar(SCALE); piece.castShadow = true; piece.receiveShadow = true; piece.visible = false;
turntable.add(piece);

// ---- post ----
const pipeline = new THREE.RenderPipeline(renderer);
const scenePass = pass(scene, camera);
scenePass.setMRT(mrt({ output, normal: packNormalToRGB(normalView) }));
const col = scenePass.getTextureNode('output'), depth = scenePass.getTextureNode('depth');
const P = { ao: uniform(T.ao ? 0.8 : 0), beam: uniform(new THREE.Color()), beamGain: uniform(1.6), bloomOn: uniform(1), vignette: uniform(0.42) };
let aoTex = null;
if (T.ao) {
  const nrmTex = scenePass.getTextureNode('normal'), nrm = sample((uv) => unpackRGBToNormal(nrmTex.sample(uv)));
  const gtao = ao(depth, nrm, camera); gtao.resolutionScale = 0.5; gtao.radius.value = 0.3; gtao.thickness.value = 0.5; gtao.distanceExponent.value = 1.4;
  aoTex = gtao.getTextureNode();
}
const rays = godrays(depth, camera, studio.key);
rays.raymarchSteps.value = T.steps; rays.resolutionScale = T.gscale;
const raysBlur = bilateralBlur(rays.getTextureNode(), null, 4, 0.5).getTextureNode();
// dust motes: their own scene and pass, added before bloom so the brightest glint
const dustScene = new THREE.Scene();
const dustPass = pass(dustScene, camera), dustCol = dustPass.getTextureNode('output');
// the glass case: its own pass too, composited over the room (see glass.js)
const glassScene = new THREE.Scene();
const glassPass = pass(glassScene, camera), glassCol = glassPass.getTextureNode('output');
const P_tint = uniform(new THREE.Color(0.93, 0.975, 0.955));
const throughGlass = (rgb) => {
  const g = glassCol.sample(screenUV);
  return rgb.mul(g.a.oneMinus()).mul(mix(vec3(1), P_tint, smoothstep(0, 0.02, g.a))).add(g.rgb);
};
const lit = vec4(throughGlass(col.rgb.add(dustCol.rgb)), 1);
const glow = bloom(lit, 0.22, 0.55, 0.85);
pipeline.outputNode = Fn(() => {
  const occl = aoTex ? mix(float(1), aoTex.sample(screenUV).r, P.ao) : float(1);
  const g = raysBlur.sample(screenUV).r;
  // the haze in the beam scatters light toward you; it adds, so dark things stay dark outside it
  const room = col.rgb.mul(occl).add(dustCol.rgb).mul(g.mul(-0.35).add(1)).add(P.beam.mul(P.beamGain).mul(g));
  const c = throughGlass(room).add(glow.rgb.mul(P.bloomOn));
  const v = smoothstep(1.15, 0.25, length(screenUV.sub(0.5).mul(vec2(screenSize.x.div(screenSize.y), 1))));
  const px = screenUV.mul(screenSize).floor();
  const n = hash(px.x.add(px.y.mul(4111.0)).add(time.mul(60).floor().mul(7919.0).mod(65536))).sub(0.5).mul(0.006);
  return vec4(c.mul(mix(float(1).sub(P.vignette), float(1), v)).add(n), 1);
})();

// ---- state ----
const state = {
  seed: Q.has('seed') ? +Q.get('seed') : Math.floor(Math.random() * 100000),
  wood: Q.get('wood') in SPECIES ? Q.get('wood') : null, finish: Q.get('finish') in FINISHES ? Q.get('finish') : null,
  light: Math.max(0, LIGHTS.findIndex((l) => l.key === Q.get('light'))), spin: !SHOT && !Q.has('still'),
  play: !SHOT && Q.has('play'),
  glass: !Q.has('noglass'), // the case is on unless the link says otherwise
};
let woodNow = 'walnut', finishNow = 'oil';
const audio = makeAudio();

function applyLight(i) {
  state.light = (i + LIGHTS.length) % LIGHTS.length;
  const L = LIGHTS[state.light];
  studio.apply(L); audio.setLight(L.key);
  rays.density.value = L.haze; rays.maxDensity.value = L.hazeMax; rays.distanceAttenuation.value = L.atten;
  P.beam.value.set(L.color).multiplyScalar(0.9);
  syncDust(); syncGlass();
  renderer.toneMappingExposure = L.exposure;
  scene.environmentIntensity = L.key === 'studio' ? 0.7 : 0.22;
  document.querySelectorAll('#lights button').forEach((b, j) => b.classList.toggle('on', j === state.light));
  writeLink();
}
// the glass case: its key light and room reflections follow the light; the piece is scaled down to fit
// where it is wider than the case, and the case is as tall as the piece needs
let glass = null, extent = { r: 0.8, top: 0.6 };
const _d = new THREE.Vector3();
function syncGlass() {
  if (!glass) return;
  glass.U.keyDir.value.copy(_d.copy(studio.key.position).sub(studio.key.target.position).normalize());
  glass.U.keyColor.value.copy(studio.key.color).multiplyScalar(studio.key.intensity / 9);
  glass.U.env.value = scene.environmentIntensity * 0.4; // a dim gallery: the room it mirrors is darker than the map
  glass.U.fill.value.copy(studio.fill.color).multiplyScalar(studio.fill.intensity * 0.35);
}
function fitPiece() {
  const k = state.glass ? Math.min(1, (CASE_HALF - 0.04) / (extent.r * SCALE)) : 1;
  piece.scale.setScalar(SCALE * k);
  turntable.position.y = PLINTH_TOP - FOOT * SCALE * k;
  if (!glass) return;
  const H = Math.max(0.42, (extent.top - FOOT) * SCALE * k + 0.09);
  if (Math.abs(H - glass.height) > 0.004) glass.resize(H);
  glass.group.visible = state.glass;
  if (dust) {
    dust.U.caseOn.value = state.glass ? 1 : 0;
    dust.U.caseMin.value.set(-CASE_HALF, PLINTH_TOP, -CASE_HALF); dust.U.caseMax.value.set(CASE_HALF, PLINTH_TOP + H, CASE_HALF);
  }
}
function setGlass(on) {
  state.glass = on; $('glass').classList.toggle('on', on); audio.glass(on);
  fitPiece(); writeLink();
}

// dust motes in the beam: made after the first frame, once the key light's shadow map exists
let dust = null;
function syncDust() {
  if (!dust) return;
  const L = LIGHTS[state.light];
  dust.U.amount.value = Q.has('nodust') ? 0 : L.haze > 0 ? 1.2 * L.intensity / 9 : 0.08;
  dust.U.color.value.set(L.color);
  dust.U.focus.value.copy(controls.target);
}
function applyWood(k) { woodNow = k; wood.setSpecies(k); audio.setWood(woodNow, finishNow); syncLabels(); }
function applyFinish(k) {
  const was = wood.mat.clearcoat > 0; finishNow = k; wood.setFinish(k);
  if (was !== wood.mat.clearcoat > 0) wood.mat.needsUpdate = true;
  audio.setWood(woodNow, finishNow);
  syncLabels();
}
let title = '';
function syncLabels() {
  $('name').textContent = title ? `No. ${state.seed} \u00b7 ${title}` : '';
  $('mat').textContent = `${SPECIES[woodNow].name}, ${FINISHES[finishNow].name.toLowerCase()}`;
  $('wood').value = woodNow; $('finish').value = finishNow;
}

// ---- meshing in a worker; a quick coarse mesh first, then the fine one ----
let worker = null, jobId = 0;
try { worker = new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' }); } catch (e) { worker = null; }
const pending = new Map();
function mesh(spec, N, vis) {
  const id = ++jobId;
  if (!worker) return import('./sdf.js').then(({ buildMesh }) => ({ id, N, mesh: buildMesh(spec, N, { vis }) }));
  return new Promise((res) => { pending.set(id, res); worker.postMessage({ id, spec, N, vis }); });
}
if (worker) worker.onmessage = (e) => { const r = pending.get(e.data.id); pending.delete(e.data.id); r && r(e.data); };
worker && (worker.onerror = (e) => console.error('mesher worker', e.message));

function setGeometry(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  g.setAttribute('ao', new THREE.BufferAttribute(m.ao, 1));
  g.setAttribute('curv', new THREE.BufferAttribute(m.curv, 1));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  g.computeBoundingSphere(); g.computeBoundingBox();
  piece.geometry.dispose(); piece.geometry = g; piece.visible = true;
  // how far the piece reaches from the turntable's axis, in its own units, and how high it stands
  let r2 = 0; const p = m.position;
  for (let i = 0; i < p.length; i += 3) r2 = Math.max(r2, p[i] * p[i] + p[i + 2] * p[i + 2]);
  extent = { r: Math.sqrt(r2), top: g.boundingBox.max.y };
  fitPiece();
}

let generation = 0;
async function newPiece(seed = Math.floor(Math.random() * 100000)) {
  const gen = ++generation;
  state.seed = seed; clearTimeout(playTimer);
  const spec = makeSculpture(seed), r = rng(seed ^ 0x5eed);
  title = spec.title;
  // a turned vessel more often in a figured wood, the rest by chance
  const woods = Object.keys(SPECIES);
  applyWood(state.wood || woods[Math.floor(r() * woods.length)]);
  const fin = r(); applyFinish(state.finish || (fin < 0.5 ? 'oil' : fin < 0.72 ? 'wax' : fin < 0.9 ? 'lacquer' : 'bare'));
  wood.setGrain(spec, r);
  writeLink();
  document.body.classList.add('carving'); audio.carving(true);
  const t0 = performance.now();
  const quick = await mesh(spec, 64, false);
  if (gen !== generation) return;
  if (quick.error) throw new Error(quick.error);
  setGeometry(quick.mesh);
  const fine = await mesh(spec, T.N, true);
  if (gen !== generation) return;
  if (fine.error) throw new Error(fine.error);
  setGeometry(fine.mesh);
  document.body.classList.remove('carving'); audio.carving(false); audio.piece(seed);
  info.meshMs = performance.now() - t0; info.tris = fine.mesh.index.length / 3; info.N = T.N;
  if (state.play) playTimer = setTimeout(playNext, PLAY_MS);
  return spec;
}

// ---- autoplay: a new piece in a random wood and finish, 2 s after the last one finished carving ----
const PLAY_MS = 2000;
let playTimer = 0;
function playNext() {
  const woods = Object.keys(SPECIES), fins = Object.keys(FINISHES);
  state.wood = woods[Math.floor(Math.random() * woods.length)];
  state.finish = fins[Math.floor(Math.random() * fins.length)];
  newPiece().catch((e) => console.error(e));
}
function setPlay(on) {
  state.play = on; clearTimeout(playTimer);
  $('play').classList.toggle('on', on);
  $('play').innerHTML = on ? '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>';
  $('play').title = on ? 'Stop autoplay (p)' : 'Autoplay (p)';
  if (on && !document.body.classList.contains('carving')) playNext();
  writeLink();
}

// ---- the link: everything that sets the view, in the hash, so the address bar is always a share link ----
// wood and finish are written only when chosen (or rolled by autoplay); otherwise the seed picks them
function linkParams() {
  const p = new URLSearchParams({ seed: state.seed });
  if (state.wood) p.set('wood', state.wood);
  if (state.finish) p.set('finish', state.finish);
  p.set('light', LIGHTS[state.light].key);
  const f = (v) => +v.toFixed(2), c = camera.position, t = controls.target;
  p.set('cam', [c.x, c.y, c.z, t.x, t.y, t.z].map(f).join(','));
  if (!state.spin) p.set('still', '');
  if (state.play) p.set('play', '');
  if (!state.glass) p.set('noglass', '');
  return p.toString().replace(/%2C/g, ',').replace(/=(&|$)/g, '$1');
}
let linkTimer = 0;
function writeLink() {
  if (SHOT) return;
  clearTimeout(linkTimer);
  linkTimer = setTimeout(() => {
    const keep = new URLSearchParams(location.search);
    for (const k of ['seed', 'wood', 'finish', 'light', 'cam', 'still', 'play', 'glass', 'noglass']) keep.delete(k);
    const q = keep.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + '#' + linkParams());
  }, 150);
}
async function copyLink() {
  clearTimeout(linkTimer);
  history.replaceState(null, '', location.pathname + location.search.replace(/[?&](seed|wood|finish|light|cam|still|play|glass|noglass)=[^&]*/g, '') + '#' + linkParams());
  const url = location.href, el = $('link');
  try { await navigator.clipboard.writeText(url); el.classList.add('on'); el.title = 'Link copied'; } catch (e) { prompt('Link to this piece', url); }
  setTimeout(() => { el.classList.remove('on'); el.title = 'Copy link (c)'; }, 1500);
}

// ---- UI ----
const woodSel = $('wood'), finSel = $('finish');
for (const [k, s] of Object.entries(SPECIES)) woodSel.add(new Option(s.name, k));
for (const [k, f] of Object.entries(FINISHES)) finSel.add(new Option(f.name, k));
woodSel.onchange = () => { state.wood = woodSel.value; applyWood(woodSel.value); woodSel.blur(); writeLink(); };
finSel.onchange = () => { state.finish = finSel.value; applyFinish(finSel.value); finSel.blur(); writeLink(); };
LIGHTS.forEach((L, i) => { const b = document.createElement('button'); b.textContent = L.name; b.onclick = () => applyLight(i); $('lights').appendChild(b); });
$('new').onclick = () => newPiece();
$('spin').onclick = () => { state.spin = !state.spin; $('spin').classList.toggle('on', state.spin); writeLink(); };
$('play').onclick = () => setPlay(!state.play);
$('link').onclick = () => copyLink();
$('glass').onclick = () => setGlass(!state.glass);
$('save').onclick = () => save();
$('spin').classList.toggle('on', state.spin);
$('glass').classList.toggle('on', state.glass);
// sound: off until asked for, since browsers start audio only on a gesture; once turned on it is
// remembered, and starts again at the first touch or key on the next visit
const SOUND_OFF = '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/></svg>', SOUND_ON = '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
async function setSound(want) {
  await audio.toggle(want);
  $('sound').classList.toggle('on', audio.on); $('sound').innerHTML = audio.on ? SOUND_ON : SOUND_OFF;
  $('sound').title = audio.on ? 'Sound off (m)' : 'Sound (m)';
  try { localStorage.setItem('hollow.sound', audio.on ? '1' : '0'); } catch (e) { /* private mode */ }
}
$('sound').onclick = () => setSound(!audio.on);
if (!SHOT && (() => { try { return localStorage.getItem('hollow.sound') === '1'; } catch (e) { return false; } })()) {
  const go = (e) => { if (e.target.closest?.('#sound')) return; removeEventListener('pointerdown', go, true); removeEventListener('keydown', go, true); setSound(true); };
  addEventListener('pointerdown', go, true); addEventListener('keydown', go, true);
}

async function save() {
  await pipeline.render();
  renderer.domElement.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `hollow-${state.seed}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); });
}
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase(), woods = Object.keys(SPECIES), fins = Object.keys(FINISHES);
  if (k === 'n') newPiece();
  else if (k === 'w') { state.wood = woods[(woods.indexOf(woodNow) + 1) % woods.length]; applyWood(state.wood); writeLink(); }
  else if (k === 'f') { state.finish = fins[(fins.indexOf(finishNow) + 1) % fins.length]; applyFinish(state.finish); writeLink(); }
  else if (k === 'l') applyLight(state.light + 1);
  else if (k === 'p') setPlay(!state.play);
  else if (k === 'c') copyLink();
  else if (k === 'g') setGlass(!state.glass);
  else if (k === 't' || k === ' ') { state.spin = !state.spin; $('spin').classList.toggle('on', state.spin); e.preventDefault(); }
  else if (k === 'h') document.body.classList.toggle('calm');
  else if (k === 's') save();
  else if (k === 'm') setSound(!audio.on);
});
// a drag stops the orbit for a moment so you can look
let heldUntil = 0; const UP = new THREE.Vector3(0, 1, 0);
controls.addEventListener('start', () => { heldUntil = Infinity; });
controls.addEventListener('end', () => { heldUntil = performance.now() + 2500; writeLink(); });

addEventListener('hashchange', () => { if (!location.hash.includes('seed=') || location.hash.slice(1) === linkParams()) return; location.reload(); });
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

// ---- loop ----
const info = { backend: '', meshMs: 0, tris: 0, N: 0 };
let last = performance.now(), slow = 0, fast = 0;
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  // the camera walks slowly round the exhibit; the piece, its case and the light stay put
  if (state.spin && now > heldUntil) camera.position.sub(controls.target).applyAxisAngle(UP, dt * 0.16).add(controls.target);
  controls.update(); audio.update();
  pipeline.render();
  // adaptive resolution: drop the pixel ratio under load, raise it back when there is room
  if (!SHOT) {
    if (dt > 0.03) { slow++; fast = 0; } else if (dt < 0.014) { fast++; slow = 0; } else { slow = Math.max(0, slow - 1); fast = Math.max(0, fast - 1); }
    if (slow > 30 && prScale > 0.5) { prScale = Math.max(0.5, prScale * 0.85); renderer.setPixelRatio(prCap * prScale); slow = 0; }
    if (fast > 120 && prScale < 1) { prScale = Math.min(1, prScale / 0.9); renderer.setPixelRatio(prCap * prScale); fast = 0; }
  }
}

(async () => {
  try { await renderer.init(); } catch (e) { $('status').textContent = 'Could not start the renderer: ' + e.message; return; }
  info.backend = renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2';
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  applyLight(state.light);
  try { await newPiece(state.seed); } catch (e) { $('status').textContent = 'Could not carve: ' + e.message; console.error(e); return; }
  await pipeline.render();
  dust = buildDust(dustScene, studio.key, depth, { count: T.dust }); syncDust();
  glass = buildGlass(glassScene, { light: studio.key, envTexture: scene.environment, sceneDepth: depth, base: new THREE.Vector3(0, PLINTH_TOP, 0) });
  syncGlass(); fitPiece();
  controls.addEventListener('change', () => dust.U.focus.value.copy(controls.target));
  $('status').remove(); document.body.classList.add('ready');
  if (state.play) setPlay(true);
  if (SHOT) {
    window.__hollow = {
      info, state, wood, studio, piece, audio, dust, get glass() { return glass; }, setGlass, camera, controls, turntable, P, rays,
      step: async (n = 1) => { for (let i = 0; i < n; i++) { controls.update(); await pipeline.render(); } },
      newPiece, light: applyLight, setWood: (k) => { state.wood = k; applyWood(k); }, setFinish: (k) => { state.finish = k; applyFinish(k); },
      cam: (p, t) => { camera.position.set(...p); if (t) controls.target.set(...t); controls.update(); },
      spin: (a) => { camera.position.sub(controls.target).applyAxisAngle(UP, a).add(controls.target); controls.update(); },
    };
  } else {
    renderer.setAnimationLoop(frame);
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

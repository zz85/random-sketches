// Koi pond: scene assembly, render passes, touch and motion input, UI, adaptive quality.
//
// Each frame: (1) fish, pads and leaves are drawn as silhouettes onto the bottom, seen from
// above, into a small shadow map; (2) the fish are drawn as they are into fishRT; (3) one
// full-screen pass looks through the rippled surface (refraction onto the pebbles, caustics,
// shadows, the fish, water colour, reflections, glints) into sceneRT, and the pads, lilies and
// floating leaves are drawn on top; (4) a finish pass grades it, or paints it in watercolour.
import * as THREE from 'three';
import { makeShared, MAXR } from './glsl.js';
import { makeCausticPass, makeBottom, makeComposite, makeGrade, mulberry32 } from './pond.js';
import { Koi, RESIDENTS } from './koi.js';
import { Surface, seasonNow } from './surface.js';
import { makePaint, glaze } from './paint.js';
import { makeAudio } from './audio.js';

const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) ? parseFloat(Q.get(k)) : d);
const MOBILE = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 600;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const store = (() => { try { return JSON.parse(localStorage.getItem('koi') || '{}'); } catch { return {}; } })();
const save = () => { try { localStorage.setItem('koi', JSON.stringify(S)); } catch { /* private mode */ } };

const S = {
  style: Q.get('style') || store.style || 'real',      // real | paint
  mode: Q.get('mode') || store.mode || 'ripple',       // ripple | feed | call
  motion: Q.has('motion') ? Q.get('motion') !== '0' : store.motion ?? false,
  cam: Q.get('cam') || store.cam || 'top',              // top | angle | orbit (the realistic view)
  fps: Q.has('fps') ? num('fps', 60) : store.fps || 60, // frames a second the painting is shown at
  still: Q.has('still'),                                // painting held on one frame
};
// camera angles of the realistic view: elevation from straight down, symbol, name
const CAMS = { top: [0, '視', 'Top'], angle: [0.62, '斜', '2.5D'], orbit: [0.62, '巡', 'Orbit'] };
if (!CAMS[S.cam]) S.cam = 'top';
const SEED = Q.has('seed') ? num('seed', 1) : Math.floor(Math.random() * 1e6);
const rng = mulberry32(SEED);

// ---------- renderer
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: Q.has('shot') });
renderer.setClearColor(0x000000, 0);
renderer.autoClear = false;
document.body.prepend(renderer.domElement);
const GL2 = renderer.capabilities.isWebGL2;
const shared = makeShared();
const sd = shared.uSunDir.value; shared.uShadowDir.value.set(-sd.x / sd.z, -sd.y / sd.z);

const FOV = 30, D = shared.uD.value;
// the watercolour is a closer view, so the koi fill the paper as in a painting
const painted = () => S.style === 'paint' || S.style === 'ink';
const halfShort = () => num('view', painted() ? 0.8 : 1.5);
const cam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 60);
const ORTHO = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const shadowCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 30);
const view = { w: 1, h: 1, hx: 1, hy: 1, H: 5, rect: new THREE.Vector4(), q: num('q', 1), pr: 1 };

const comp = makeComposite(shared), grade = makeGrade(), paint = makePaint(comp), cpass = makeCausticPass(shared, comp);
const compScene = new THREE.Scene(); compScene.add(comp.mesh);
const gradeScene = new THREE.Scene(); gradeScene.add(grade.mesh);
const paintScene = new THREE.Scene(); paintScene.add(paint.mesh);
const fishScene = new THREE.Scene(), shadowScene = new THREE.Scene(), surfScene = new THREE.Scene();

let bottomRT = null, fishRT = null, sceneRT = null, shadowRT = null, pigRT = null, causticRT = null;
const rt = (w, h, samples) => new THREE.WebGLRenderTarget(w, h, { samples: GL2 ? samples : 0, depthBuffer: true });

// ---------- the pond's residents
const fish = [];
const surface = new Surface(shared, { season: Q.get('season') || seasonNow(), seed: SEED });
surfScene.add(surface.scene); shadowScene.add(surface.shadow);
function addFish(n) {
  for (let i = 0; i < n; i++) {
    const [variety, L, long] = RESIDENTS[fish.length % RESIDENTS.length];
    const k = new Koi({ variety, L: L * (0.92 + rng() * 0.16), long, seed: rng() * 1000, x: (rng() * 2 - 1) * 1.2, y: (rng() * 2 - 1) * 2, h: rng() * 6.28, shared });
    fish.push(k); fishScene.add(k.body); fishScene.add(k.fins); shadowScene.add(k.sBody, k.sFins);
  }
}
addFish(clamp(Math.round(num('fish', MOBILE ? 9 : 11)), 1, 30));

// ---------- ripples
const ripples = [];
function ripple(x, y, a = 1) {
  if (ripples.length >= MAXR) ripples.shift();
  ripples.push({ x, y, t0: time, a });
}
function uploadRipples() {
  while (ripples.length && time - ripples[0].t0 > 7) ripples.shift();
  const U = comp.u.uRip.value;
  ripples.forEach((r, i) => U[i].set(r.x, r.y, r.t0, r.a * 0.0032));
  comp.u.uRipN.value = ripples.length;
}

// ---------- layout
function resize() {
  const w = innerWidth, h = innerHeight, aspect = w / h;
  view.w = w; view.h = h; dirty = true;
  const HS = halfShort();
  if (aspect < 1) { view.hx = HS; view.hy = HS / aspect; } else { view.hy = HS; view.hx = HS * aspect; }
  view.H = view.hy / Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  cam.aspect = aspect; cam.updateProjectionMatrix();
  // the bottom must cover what the view sees at the bottom's depth, with room for the tilt;
  // an angled camera sees much further, so it covers every way it can turn
  const k = ((view.H + D) / view.H) * 1.18;
  let r = new THREE.Vector4(-view.hx * k, -view.hy * k, 2 * view.hx * k, 2 * view.hy * k);
  if (angled()) { const rho = reach(); r = new THREE.Vector4(-rho, -rho, 2 * rho, 2 * rho); }
  if (!bottomRT || Math.abs(r.z - view.rect.z) > 1e-3 || Math.abs(r.w - view.rect.w) > 1e-3) {
    view.rect.copy(r);
    bottomRT?.dispose();
    const maxT = Math.min(renderer.capabilities.maxTextureSize, MOBILE ? 2048 : 3072);
    bottomRT = makeBottom(renderer, shared, view.rect, maxT);
    comp.u.uBottom.value = bottomRT.texture; comp.u.uRect.value.copy(view.rect);
    Object.assign(shadowCam, { left: r.x, right: r.x + r.z, bottom: r.y, top: r.y + r.w });
    shadowCam.position.set(0, 0, 10); shadowCam.lookAt(0, 0, 0); shadowCam.updateProjectionMatrix();
    // caustic texels about a centimetre, the blur of the sun's disc at this depth
    const cl = Math.min(MOBILE ? 1024 : 1536, Math.round(Math.max(r.z, r.w) / 0.009));
    const cw = r.z >= r.w ? cl : Math.round(cl * r.z / r.w), ch = r.z >= r.w ? Math.round(cl * r.w / r.z) : cl;
    causticRT?.dispose();
    causticRT = new THREE.WebGLRenderTarget(cw, ch, { minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: false });
    causticRT.texture.wrapS = causticRT.texture.wrapT = THREE.ClampToEdgeWrapping;
    shared.uCaustic.value = causticRT.texture; shared.uCauRect.value.copy(r);
    const sl = angled() ? 1024 : 512, sw = r.z >= r.w ? sl : Math.round(sl * r.z / r.w), sh = r.z >= r.w ? Math.round(sl * r.w / r.z) : sl;
    shadowRT?.dispose(); shadowRT = rt(sw, sh, 0); shadowRT.depthBuffer = false;
    comp.u.uShadow.value = shadowRT.texture; comp.u.uShadowTexel.value.set(1 / sw, 1 / sh);
    surface.layout(view.hx, view.hy, halfShort() / 1.5);
  }
  const kx = Math.PI / (2 * view.hx * 1.15), ky = Math.PI / (2 * view.hy * 1.15);
  comp.u.uSlosh.value.z = kx; comp.u.uSlosh.value.w = ky;
  renderer.setSize(w, h);
  sizeTargets();
}
function sizeTargets() {
  view.pr = Math.min(devicePixelRatio || 1, 2) * view.q * (painted() ? 0.72 : 1);
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2) * Math.min(1, view.q + 0.15));
  const W = Math.max(2, Math.round(view.w * view.pr)), H = Math.max(2, Math.round(view.h * view.pr));
  shared.uPaint.value = painted() ? 1 : 0; paint.u.uInk.value = S.style === 'ink' ? 1 : 0;
  for (const k of fish) glaze(k.fins.material, painted());
  paint.u.uGrain.value = view.h / 3.5; paint.u.uPx.value = H / 700; paint.u.uRes.value.set(W, H);
  if (painted()) {
    // only the pigment layer is needed; free the realistic targets
    fishRT?.dispose(); sceneRT?.dispose(); fishRT = sceneRT = null;
    if (pigRT && pigRT.width === W && pigRT.height === H) return;
    pigRT?.dispose();
    pigRT = rt(W, H, 4); pigRT.texture.minFilter = THREE.LinearMipmapLinearFilter; pigRT.texture.generateMipmaps = true;
    paint.u.uPig.value = pigRT.texture;
    return;
  }
  pigRT?.dispose(); pigRT = null;
  if (sceneRT && sceneRT.width === W && sceneRT.height === H) return;
  fishRT?.dispose(); sceneRT?.dispose();
  fishRT = rt(W, H, 4); sceneRT = rt(W, H, 4);
  comp.u.uFish.value = fishRT.texture; grade.u.uScene.value = sceneRT.texture;
  grade.u.uRes.value.set(W, H);
}
addEventListener('resize', resize);

// ---------- motion: tilt (parallax, glint, things drift downhill) and shake (slosh, startle)
const motion = { tilt: [0, 0], tiltT: [0, 0], base: null, sx: 0, sy: 0, vx: 0, vy: 0, seen: false, lastShake: -9 };
function screenAngle() { return ((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * Math.PI / 180; }
function toScreen(dx, dy) { const a = screenAngle(), c = Math.cos(a), s = Math.sin(a); return [dx * c - dy * s, dx * s + dy * c]; }
addEventListener('deviceorientation', (e) => {
  if (!S.motion || e.beta == null) return;
  motion.seen = true;
  // relative to however the phone is being held: a baseline that follows slowly
  if (!motion.base) motion.base = [e.beta, e.gamma];
  motion.base[0] += (e.beta - motion.base[0]) * 0.004; motion.base[1] += (e.gamma - motion.base[1]) * 0.004;
  const gx = clamp((e.gamma - motion.base[1]) / 28, -1, 1), gy = clamp(-(e.beta - motion.base[0]) / 28, -1, 1);
  motion.tiltT = toScreen(gx, gy);
});
addEventListener('devicemotion', (e) => {
  if (!S.motion) return;
  const a = e.acceleration && e.acceleration.x != null ? e.acceleration : null;
  if (!a) return;
  const [ax, ay] = toScreen(a.x || 0, a.y || 0);
  // the water lags the bowl: drive the slosh with the phone's acceleration
  motion.vx -= ax * 0.0009; motion.vy -= ay * 0.0009;
  const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);
  if (mag > 13 && time - motion.lastShake > 1.2) {
    motion.lastShake = time;
    startle = { t: -1, x: 0, y: 0, r: 99 };
    for (let i = 0; i < 6; i++) ripple((Math.random() * 2 - 1) * view.hx, (Math.random() * 2 - 1) * view.hy, 1.2);
    audio.plip(0.16);
  }
});
async function enableMotion() {
  try {
    for (const E of [window.DeviceOrientationEvent, window.DeviceMotionEvent]) if (E && typeof E.requestPermission === 'function') { const r = await E.requestPermission(); if (r !== 'granted') throw new Error(r); }
    S.motion = true; motion.base = null; hint('Tilt the phone: the light moves and leaves drift downhill. Shake to scatter the koi.');
  } catch { S.motion = false; hint('Motion sensors are not available here'); }
  save(); refreshUI();
}

// ---------- touch
const fingers = new Map(); // pointerId -> { x, y, lx, ly, lt, sx, sy }
let gest = null; // screen centroid while turning the camera
function centroid() { let x = 0, y = 0; for (const f of fingers.values()) { x += f.sx; y += f.sy; } return [x / fingers.size, y / fingers.size]; }
function toWorld(cx, cy) {
  const v = new THREE.Vector3((cx / view.w) * 2 - 1, -(cy / view.h) * 2 + 1, 0.5).unproject(cam).sub(cam.position).normalize();
  const t = -cam.position.z / v.z;
  return [cam.position.x + v.x * t, cam.position.y + v.y * t];
}
const canvas = renderer.domElement;
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
  wake(); poke();
  const [x, y] = toWorld(e.clientX, e.clientY);
  const f = { x, y, lx: x, ly: y, lt: time, sx: e.clientX, sy: e.clientY };
  fingers.set(e.pointerId, f);
  // two fingers (or the right mouse button, or shift-drag) turn the camera in the realistic view
  if (!painted() && (fingers.size >= 2 || e.button === 2 || e.shiftKey)) { gest = centroid(); return; }
  // a pad you touch rocks on the water
  for (const p of surface.pads) if (Math.hypot(p.x - x, p.y - y) < p.r) { p.vx += (p.x - x) * 0.6; p.vy += (p.y - y) * 0.6; p.vr += (Math.random() - 0.5) * 0.4; }
  if (S.mode === 'ripple') { ripple(x, y, 1); audio.plip(0.16); }
  else if (S.mode === 'feed') { surface.dropPellets(x, y, 3 + Math.floor(Math.random() * 3), ripple); audio.plip(0.08, 900); }
  else { ripple(x, y, 0.35); audio.plip(0.06, 700); }
});
canvas.addEventListener('pointermove', (e) => {
  const f = fingers.get(e.pointerId); if (!f) return;
  f.sx = e.clientX; f.sy = e.clientY;
  if (gest) {
    const c = centroid();
    orbit.azT -= (c[0] - gest[0]) / view.w * 3.2;
    orbit.elT = clamp(orbit.elT + (c[1] - gest[1]) / view.h * 1.6, 0, EL_MAX);
    gest = c;
    if (S.cam === 'top' && orbit.elT > 0.03) { S.cam = 'angle'; save(); resize(); refreshUI(); }
    return;
  }
  const [x, y] = toWorld(e.clientX, e.clientY); f.x = x; f.y = y;
  const moved = Math.hypot(x - f.lx, y - f.ly);
  if (S.mode === 'ripple' && moved > 0.07) { ripple(x, y, 0.4 + Math.min(0.6, moved * 2)); f.lx = x; f.ly = y; }
  else if (S.mode === 'feed' && (moved > 0.12 || time - f.lt > 0.25) && moved > 0.02) { surface.dropPellets(x, y, 1 + Math.floor(Math.random() * 2), ripple); f.lx = x; f.ly = y; f.lt = time; }
});
const lift = (e) => { fingers.delete(e.pointerId); if (fingers.size === 0) gest = null; };
canvas.addEventListener('pointerup', lift); canvas.addEventListener('pointercancel', lift);

// ---------- UI
const audio = makeAudio();
const $ = (id) => document.getElementById(id);
const MODES = { ripple: ['波', 'Ripple', 'Touch the water. The koi keep clear of your finger.'], feed: ['餌', 'Feed', 'Tap to scatter food. Drag to sprinkle.'], call: ['招', 'Call', 'Hold a finger on the water and the koi gather beneath it.'] };
function refreshUI() {
  document.body.classList.toggle('paper', painted());
  $('style').innerHTML = { real: '<b>写</b> Real', paint: '<b>絵</b> Paint', ink: '<b>墨</b> Ink' }[S.style] || '<b>写</b> Real';
  const m = MODES[S.mode]; $('mode').innerHTML = `<b>${m[0]}</b> ${m[1]}`;
  $('motion').innerHTML = '<b>傾</b> Tilt'; $('motion').classList.toggle('on', S.motion);
  $('sound').innerHTML = '<b>音</b> Sound'; $('sound').classList.toggle('on', audio.on);
  const c = CAMS[S.cam]; $('cam').innerHTML = `<b>${c[1]}</b> ${c[2]}`; $('cam').style.display = painted() ? 'none' : '';
  $('still').innerHTML = S.still ? '<b>動</b> Play' : '<b>止</b> Still'; $('still').classList.toggle('on', S.still);
  $('fps').innerHTML = S.fps >= 60 ? '<b>齣</b> Smooth' : `<b>齣</b> ${S.fps} fps`;
  for (const id of ['still', 'fps']) $(id).style.display = painted() ? '' : 'none';
}
let hintTimer = 0;
function hint(text) { const h = $('hint'); h.textContent = text; h.classList.add('show'); clearTimeout(hintTimer); hintTimer = setTimeout(() => h.classList.remove('show'), 3600); }
let idle = 0;
function poke() { idle = 0; document.body.classList.remove('calm'); }
$('style').onclick = () => { S.style = { real: 'paint', paint: 'ink', ink: 'real' }[S.style] || 'paint'; if (!painted()) S.still = false; save(); resize(); refreshUI(); poke(); };
$('mode').onclick = () => { const k = Object.keys(MODES); S.mode = k[(k.indexOf(S.mode) + 1) % k.length]; save(); refreshUI(); hint(MODES[S.mode][2]); poke(); };
$('motion').onclick = () => { if (S.motion) { S.motion = false; save(); refreshUI(); } else enableMotion(); poke(); };
$('cam').onclick = () => { const k = Object.keys(CAMS); setCam(k[(k.indexOf(S.cam) + 1) % k.length]); hint(S.cam === 'top' ? 'Straight down.' : 'Two fingers (or right-drag) turn and tilt the view.'); poke(); };
$('still').onclick = () => { S.still = !S.still; dirty = true; refreshUI(); poke(); };
const FPS = [60, 24, 16, 12, 8, 4];
$('fps').onclick = () => { S.fps = FPS[(FPS.indexOf(S.fps) + 1) % FPS.length]; save(); refreshUI(); hint(S.fps >= 60 ? 'Painted every frame.' : `Painted ${S.fps} times a second.`); poke(); };
$('sound').onclick = async () => { await audio.toggle(); refreshUI(); poke(); };
if (!('DeviceOrientationEvent' in window) || !MOBILE) $('motion').style.display = Q.has('motion') ? '' : 'none';
addEventListener('keydown', (e) => {
  if (e.key === 'p' || e.key === 'w') $('style').click();
  else if (e.key === 'm') $('mode').click();
  else if (e.key === 'c') $('cam').click();
  else if (e.key === ' ' && painted()) { e.preventDefault(); $('still').click(); }
  else if (e.key === 'f' && painted()) $('fps').click();
  else if (e.key === 's') $('sound').click();
  else if (e.key === 'h') document.body.classList.toggle('calm');
});
document.body.addEventListener('pointerdown', poke, { passive: true });
document.body.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') poke(); }, { passive: true });
refreshUI();

// keep the screen awake while the pond is open
let lock = null;
async function wake() { try { if (!lock && navigator.wakeLock && document.visibilityState === 'visible') { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch { /* not allowed */ } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') wake(); });

// ---------- the loop
let time = 0, last = performance.now(), startle = null, frames = 0, paintAcc = 0, dirty = true;
const perf = { ema: 16.7, acc: 0, n: 0, lastCheck: 0, ms: 0 };
const camTarget = new THREE.Vector3(0, 0, -D * 0.55);
const VP = new THREE.Matrix4();

// the camera's angle: elevation from straight down and azimuth, eased toward targets that the
// view button and a two-finger drag set; Orbit turns slowly round the pond on its own
const orbit = { el: CAMS[S.cam][0], az: 0, elT: CAMS[S.cam][0], azT: 0 };
function angled() { return !painted() && S.cam !== 'top'; }
function camDist(el) { return (view.H - camTarget.z) * (1 - 0.22 * Math.sin(el)); }
function placeCamera(el, az, tx = 0, ty = 0) {
  const R = camDist(el), s = Math.sin(el);
  cam.position.set(camTarget.x - R * s * Math.sin(az) + tx * view.H * 0.09, camTarget.y - R * s * Math.cos(az) + ty * view.H * 0.09, camTarget.z + R * Math.cos(el));
  cam.up.set(Math.sin(az), Math.cos(az), 0); cam.lookAt(camTarget); cam.updateMatrixWorld();
}
// how far from the middle the view can reach on the bottom at the steepest angle, any way round
const EL_MAX = 0.8;
function reach() {
  placeCamera(EL_MAX, 0); cam.updateProjectionMatrix();
  let rho = Math.max(view.hx, view.hy);
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    const v = new THREE.Vector3(sx, sy, 0.5).unproject(cam).sub(cam.position).normalize();
    const t = (-D - cam.position.z) / v.z;
    rho = Math.max(rho, Math.hypot(cam.position.x + v.x * t - camTarget.x, cam.position.y + v.y * t - camTarget.y));
  }
  return Math.min(rho * 1.05, 14);
}
function orbitStep(dt) {
  if (!angled()) { orbit.elT = 0; orbit.azT = Math.round(orbit.azT / 6.2832) * 6.2832; }
  else if (S.cam === 'orbit' && !fingers.size) orbit.azT += dt * 0.025;
  const e = Math.min(1, dt * 2.5);
  orbit.el += (orbit.elT - orbit.el) * e; orbit.az += (orbit.azT - orbit.az) * e;
}
function setCam(c) {
  S.cam = c; if (CAMS[c]) orbit.elT = CAMS[c][0];
  save(); resize(); refreshUI(); dirty = true;
}

function simulate(dt) {
  time += dt;
  shared.uTime.value = time;
  // tilt eases in; the slosh is a damped standing wave driven by tilt changes and shakes
  const [tx, ty] = motion.tiltT;
  const ptx = motion.tilt[0], pty = motion.tilt[1];
  motion.tilt[0] += (tx - motion.tilt[0]) * Math.min(1, dt * 3); motion.tilt[1] += (ty - motion.tilt[1]) * Math.min(1, dt * 3);
  motion.vx += (-(motion.tilt[0] - ptx) * 0.02 - motion.sx * 5 * dt - motion.vx * 0.9 * dt);
  motion.vy += (-(motion.tilt[1] - pty) * 0.02 - motion.sy * 5 * dt - motion.vy * 0.9 * dt);
  motion.sx = clamp(motion.sx + motion.vx * dt * 6, -0.012, 0.012); motion.sy = clamp(motion.sy + motion.vy * dt * 6, -0.012, 0.012);
  comp.u.uSlosh.value.x = motion.sx; comp.u.uSlosh.value.y = motion.sy;
  if (!S.motion) { motion.tiltT = [0, 0]; }
  if (startle && startle.t === -1) startle.t = time;
  const calls = S.mode === 'call' ? [...fingers.values()] : [];
  const fingersIn = S.mode === 'ripple' ? [...fingers.values()] : [];
  const W = {
    t: time, hx: view.hx, hy: view.hy, fish, pellets: surface.pellets, calls, fingers: fingersIn, startle, ripple,
    onEat: (x, y) => { ripple(x, y, 0.7); audio.gulp(); },
  };
  for (const k of fish) k.update(dt, W);
  if (startle && startle.t !== time) startle = null;
  // food tells the fish where to look: ripples only matter if they are fresh, so pass them as is
  surface.update({ dt, t: time, hx: view.hx, hy: view.hy, tilt: motion.tilt, ripples, ripple });
}

function render() {
  uploadRipples();
  // camera: on a sphere round the middle of the pond, straight down unless angled, leaning
  // with the tilt so the surface slides over the deep bottom
  const [tx, ty] = motion.tilt;
  placeCamera(orbit.el, orbit.az, tx, ty);
  VP.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  comp.u.uInvVP.value.copy(VP).invert(); comp.u.uCam.value.copy(cam.position); comp.u.uVP.value.copy(VP);
  comp.u.uGlint.value.set(-tx * 0.45, -ty * 0.45);

  renderer.setRenderTarget(shadowRT); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(shadowScene, shadowCam);
  if (painted()) {
    paint.u.uBoil.value = Math.floor(time * Math.min(S.fps, 12));
    // pigment on white: deeper fish first so the shallow ones paint over them, then the surface
    renderer.setRenderTarget(pigRT); renderer.setClearColor(0xffffff, 1); renderer.clear(); renderer.setClearColor(0x000000, 0);
    renderer.render(fishScene, cam); renderer.render(surfScene, cam);
    renderer.setRenderTarget(null); renderer.clear(); renderer.render(paintScene, ORTHO);
    return;
  }
  renderer.setRenderTarget(causticRT); renderer.render(cpass.scene, ORTHO);
  renderer.setRenderTarget(fishRT); renderer.clear(); renderer.render(fishScene, cam);
  renderer.setRenderTarget(sceneRT); renderer.clear(); renderer.render(compScene, ORTHO); renderer.render(surfScene, cam);
  renderer.setRenderTarget(null); renderer.clear();
  renderer.render(gradeScene, ORTHO);
}

function adapt(ms, now) {
  // keep the frame under budget: shrink the render scale when frames run long, grow it back when there is room
  if (Q.has('q')) return;
  perf.acc += ms; perf.n++;
  if (now - perf.lastCheck < 2500) return;
  const avg = perf.acc / perf.n; perf.acc = 0; perf.n = 0; perf.lastCheck = now; perf.ms = avg;
  const prev = view.q;
  if (avg > 24 && view.q > 0.45) view.q = Math.max(0.45, view.q * 0.85);
  else if (avg < 17.5 && view.q < 1) view.q = Math.min(1, view.q * 1.08);
  if (view.q !== prev) sizeTargets();
}

function loop(now) {
  const ms = now - last; last = now;
  const dt = Math.min(0.05, ms / 1000);
  const held = painted() && S.still;
  if (!Q.has('pause') && !held) simulate(dt);
  orbitStep(dt);
  // the painting can be shown at a few frames a second, like hand-painted animation, or held
  paintAcc += dt;
  const due = !painted() || (!held && (S.fps >= 60 || paintAcc >= 1 / S.fps - 0.004));
  if (due || dirty) { render(); dirty = false; if (painted()) paintAcc = S.fps >= 60 ? 0 : paintAcc % (1 / S.fps); }
  frames++;
  if (frames > 30) adapt(ms, now);
  idle += dt;
  if (idle > 6 && !document.body.classList.contains('calm')) document.body.classList.add('calm');
  requestAnimationFrame(loop);
}

resize();
// let the pond settle before the first frame: fish spread out, spines relax
for (let i = 0; i < num('warm', 600); i++) simulate(1 / 30);
for (let i = 0; i < num('t', 0) * 30; i++) simulate(1 / 30);
render();
requestAnimationFrame((t) => { last = t; requestAnimationFrame(loop); });
setTimeout(() => document.getElementById('title')?.classList.add('gone'), 5000);
if (!store.seen) { setTimeout(() => hint(MODES[S.mode][2]), 1200); store.seen = true; }
addEventListener('beforeunload', save);
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

// hooks for the smoke test
window.__koi = {
  fish, surface, ripples, S, view, perf, motion,
  step(n = 30, dt = 1 / 30) { for (let i = 0; i < n; i++) simulate(dt); render(); },
  render, ripple, setStyle(s) { S.style = s; resize(); refreshUI(); }, setCam, orbit, setMode(m) { S.mode = m; refreshUI(); },
  touch(x, y, type = 'down') { const ev = { pointerId: 99, clientX: x, clientY: y }; if (type === 'down') canvas.dispatchEvent(new PointerEvent('pointerdown', ev)); else if (type === 'move') canvas.dispatchEvent(new PointerEvent('pointermove', ev)); else canvas.dispatchEvent(new PointerEvent('pointerup', ev)); },
  tilt(x, y) { motion.tiltT = [x, y]; S.motion = true; },
  get time() { return time; },
  caustics() { // mean, sd and brightest of the caustic map's middle, for the smoke test
    const w = 64, h = 64, px = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(causticRT, (causticRT.width - w) >> 1, (causticRT.height - h) >> 1, w, h, px);
    let s = 0, s2 = 0, mx = 0; for (let i = 0; i < px.length; i += 4) { s += px[i]; s2 += px[i] * px[i]; mx = Math.max(mx, px[i]); }
    const n = w * h; return { mean: s / n, sd: Math.sqrt(s2 / n - (s / n) ** 2), max: mx };
  },
};

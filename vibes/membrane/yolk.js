// yolk.js - Membrane, the yolk game: pinch a raw yolk by its skin, lift it out of the half shell and carry it to
// the bowl, as a cook separating an egg by hand does. The yolk is a bag of liquid in a thin skin (yolksim.js). Your
// grip is a setting: the tighter you pinch, the more weight the fingers can hold before the skin slides out between
// them, but the harder they squeeze the skin, which stretches it next to the fingertips. Carrying it also loads the
// pinch: lift fast or swing it and the yolk pulls harder, so a light grip slips and a tight one bursts. Let go only
// once the bowl holds its weight: let go while you are still carrying it and it is dropped.
import * as THREE from 'three/webgpu';
import { makeStage } from './stage.js';
import { makeRim, eggR } from './egg.js';
import { buildYolk, makeYolkSim, YR, BOWL, WHITE_Y } from './yolksim.js';
import { TABLE_Y } from './sim.js';
import { buildShell, buildStrands } from './scene.js';
import { buildYolkMesh, buildBowl, buildWhite, buildPuddle } from './yolkscene.js';
import { makeAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
for (const [k, v] of new URLSearchParams(location.hash.slice(1))) Q.set(k, v);
const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
let seed = Q.has('seed') ? +Q.get('seed') : 1 + Math.floor(Math.random() * 9999);
const OPT = { substeps: +(Q.get('substeps') || 10), iters: +(Q.get('iters') || 8) };

if (!navigator.gpu) { $('status').textContent = 'Membrane needs WebGPU (Chrome, Edge, Safari 26 or Firefox 141 and later).'; throw new Error('no WebGPU'); }
const { renderer, scene, camera, controls, sun, cv, draw, snapshot, POST } = await makeStage({ Q, phone, camPos: [2.6, 9.4, 15.6], target: [2.7, -0.9, 0.2] });
scene.add(buildBowl(), buildWhite());
const puddle = buildPuddle(); scene.add(puddle);
const audio = makeAudio();

// ---------- the game's rules
const GRIP0 = 0.45;
// how much weight the pinch holds before the skin slips, in yolk weights, by grip: a light pinch can't lift it
const holdable = (g) => 0.4 + 3 * g;
const LET_GO = 0.45;   // let go while the pinch still carries more than this share of the weight, and it is dropped
const BURST_LINKS = 3;
const HANG = 1.55; // the pull the sum reads with the yolk hanging still: the cohesion and the bend links take some up
let grip = GRIP0;

let world = null;
function build() {
  if (world) { scene.remove(world.mesh, world.strands, world.shell); world.mesh.userData.dispose(); world.strands.userData.dispose(); world.shell.userData.dispose(); }
  const table = makeRim(seed);
  const m = buildYolk(3);
  // the yolk sits at the bottom of the half shell, a little in from the wall
  const bottom = -eggR(0, -1, 0);
  const center = [0, bottom + YR + 0.04, 0];
  // the chalazae: two cords of white from either side of the yolk, out to the white near the shell wall
  const strands = [];
  const sideVertex = (dx, dz) => { let best = 0, bd = -1e9; for (let i = 0; i < m.N; i++) { const s = m.pos[i * 3] * dx + m.pos[i * 3 + 2] * dz - Math.abs(m.pos[i * 3 + 1] + 0.2); if (s > bd) { bd = s; best = i; } } return best; };
  for (const [dx, dz, vol] of [[0.8, 0.6, 0.0014], [-0.8, -0.6, 0.0011]]) strands.push([[dx * 1.85, WHITE_Y - 0.1, dz * 1.85], sideVertex(dx, dz), vol]);
  const sim = makeYolkSim(m, table, center, { ...OPT, strands }); sim.init(renderer); sim.settle();
  const shell = buildShell(table, { brown: Q.get('shell') !== 'white' });
  const mesh = buildYolkMesh(sim, sun, scene.environment); mesh.userData.strainView.value = strainOn ? 1 : 0;
  const strands3 = buildStrands(sim);
  scene.add(shell, mesh, strands3);
  world = { table, sim, mesh, strands: strands3, shell, posCache: null, count: null, acc: null, done: false, state: 'rest', peak: 0, burst: false,
    fw: 0, slip: 0, lastC: null, settle: 0, lifted: false, tStart: 0, tEnd: 0, drained: 0, vol0: m.volume };
  puddle.visible = false;
  $('result').classList.remove('on'); if (window.__yolk) window.__yolk.result = null;
  $('time').textContent = '0:00'; $('score').textContent = '0';
  history.replaceState(null, '', '#seed=' + seed + (strainOn ? '&strain' : ''));
}
let strainOn = Q.has('strain');

// ---------- what the frame's readbacks say: the pinch force, the strain, where the yolk is
let frame = 0;
const tearAt = () => 1; // the counter reads strain over breaking strain already
function readbacks() {
  const w = world; if (!w.sim.stepped) return;
  if (!w.reading) {
    w.reading = true;
    w.sim.readPositions().then((p) => { if (world === w) { w.posCache = p; where(w); } }).finally(() => { w.reading = false; });
  }
  if (!w.countReading) {
    w.countReading = true;
    Promise.all([w.sim.readCounters(), w.sim.readAcc()]).then(([c, a]) => { if (world !== w) return; judge(w, c, a); }).finally(() => { w.countReading = false; });
  }
}
// the yolk's middle, its lowest point, and its speed (cm/s)
function where(w) {
  const p = w.posCache, N = w.sim.N; let x = 0, y = 0, z = 0, lo = 1e9;
  for (let i = 0; i < N; i++) { x += p[i * 4]; y += p[i * 4 + 1]; z += p[i * 4 + 2]; lo = Math.min(lo, p[i * 4 + 1]); }
  const c = [x / N, y / N, z / N], now = performance.now();
  if (w.lastC) { const dt = Math.max(1e-3, (now - w.lastAt) / 1000); w.speed = Math.hypot(c[0] - w.lastC[0], c[1] - w.lastC[1], c[2] - w.lastC[2]) / dt; }
  w.lastC = c; w.lastAt = now; w.c = c; w.lo = lo;
}
const inBowl = (c) => c && Math.hypot(c[0] - BOWL.x, c[2] - BOWL.z) < BOWL.rim - 0.6 && c[1] < BOWL.top + 0.3;
function judge(w, c, a) {
  const S = w.sim, steps = S.substeps * 2 * S.iters;
  // the pull of the pinch over the frame, as a share of the yolk's weight: each substep gravity moves every vertex
  // g dt^2 down, and whatever holds the yolk up has to put that back
  const g = -S.uniforms.grav.value.y, sdt = 1 / 60 / S.substeps;
  const f = S.force(a), weight = S.N * g * sdt * sdt * S.substeps * HANG;
  const fw = grab ? Math.hypot(...f) / weight : 0;
  w.fw = w.fw * 0.6 + fw * 0.4;
  const strain = c[1] / 1000;
  if (grab && w.state !== 'rest') w.peak = Math.max(w.peak, strain);
  const now = performance.now(), dt = w.judgeAt ? Math.min(0.1, (now - w.judgeAt) / 1000) : 1 / 60; w.judgeAt = now;
  // the skin slides out between the fingers while the pull is more than the grip holds; it grips again as it eases
  if (grab && !w.done) {
    const over = w.fw / holdable(grip);
    if (over > 1) { w.slip = Math.min(1, w.slip + (over - 1) * 5 * dt + 0.4 * dt); }
    else if (w.slip > 0.6) w.slip = Math.min(1, w.slip + 0.8 * dt); // past halfway out it goes, whatever the pull
    else w.slip = Math.max(0, w.slip - 0.6 * dt);
    S.uniforms.hold.value = 1 - 0.8 * w.slip;
    if (w.slip >= 1) { endGrab(true); if (!w.done) dropped('It slipped out of your fingers.'); }
    if (w.fw > 0.8) w.lifted = true;
  }
  if (!w.burst && c[0] >= BURST_LINKS) burst(w);
  // set down in the bowl: once it sits still there, intact, it is done
  if (!grab && !w.done && !w.burst && inBowl(w.c) && (w.speed ?? 9) < 1.5) { w.settle += dt; if (w.settle > 0.8) finish(w); } else w.settle = 0;
  // fell off the board
  if (!w.done && w.c && w.c[1] < TABLE_Y - 2) dropped('It rolled off the board.');
  hud(w, strain);
}
function hud(w, strain) {
  $('gripbar').firstElementChild.style.width = (grip * 100).toFixed(1) + '%';
  $('gripv').textContent = grab ? (w.slip > 0.02 ? 'slipping' : `${Math.round(grip * 100)}%`) : `${Math.round(grip * 100)}%`;
  // the tick: the least grip that holds the pull now
  const need = Math.max(0, Math.min(1, (w.fw - 0.4) / 3));
  const tick = $('gripbar').querySelector('u'); tick.style.left = (need * 100).toFixed(1) + '%'; tick.style.opacity = grab ? 1 : 0;
  $('gripbar').classList.toggle('slip', w.slip > 0.02);
  const k = Math.min(1, strain / tearAt());
  $('skinbar').firstElementChild.style.width = (w.burst ? 0 : (1 - k) * 100).toFixed(1) + '%';
  $('skinbar').classList.toggle('warn', k > 0.6 && k <= 0.85); $('skinbar').classList.toggle('danger', k > 0.85);
  $('skinv').textContent = w.burst ? 'burst' : k < 0.35 ? 'relaxed' : k < 0.6 ? 'taut' : k < 0.85 ? 'straining' : 'about to burst';
  $('pinch').style.setProperty('--k', k.toFixed(3));
  $('gripside').querySelector('i').style.height = `calc(${(grip * 100).toFixed(1)}% - 12px)`;
  if (!w.done) $('score').textContent = scoreNow(w);
}
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const elapsed = (w = world) => (w.tStart ? ((w.tEnd || performance.now()) - w.tStart) / 1000 : 0);
// up to 1000 for a yolk in the bowl: less for how close it came to bursting (past 30% of the way), and a little
// for time past 15 s
const scoreNow = (w) => Math.max(0, Math.round(1000 - 600 * Math.min(1, Math.max(0, w.peak - 0.3) / 0.7) - 4 * Math.max(0, elapsed(w) - 15)));

function burst(w) {
  w.burst = true; audio.lose?.();
  if (w.done) return;
  lose('Burst!', `The skin tore after ${clock(elapsed(w))}. Grip less hard, and carry it slower.`);
}
function dropped(why) { lose('Dropped', why + ' Lower it into the bowl until the bowl takes its weight, then let go.'); audio.live() && audio.voices.release(); }
function lose(title, detail) {
  const w = world; w.done = true; w.tEnd = performance.now();
  $('result').classList.add('lose'); $('rtitle').textContent = 'YOU LOSE'; $('rstars').textContent = '\u2606\u2606\u2606';
  $('rscore').textContent = title; $('rdetail').textContent = detail;
  // a moment to see it fall or run out first
  setTimeout(() => { if (world === w) $('result').classList.add('on'); }, Q.has('shot') ? 0 : 1300);
  window.__yolk.result = { lost: true, title, peak: w.peak };
}
function finish(w) {
  w.done = true; w.tEnd = performance.now();
  const sc = scoreNow(w), k = w.peak / tearAt(), stars = k < 0.6 ? 3 : k < 0.85 ? 2 : 1;
  const best = Math.max(sc, +(localStorage.getItem('membrane.yolkbest') || 0)); localStorage.setItem('membrane.yolkbest', best);
  $('result').classList.remove('lose');
  $('rtitle').textContent = stars === 3 ? 'Not a mark on it!' : stars === 2 ? 'In the bowl' : 'In the bowl, just';
  $('rstars').textContent = '\u2605'.repeat(stars) + '\u2606'.repeat(3 - stars);
  $('rscore').textContent = sc;
  $('rdetail').textContent = `skin at most ${Math.round(k * 100)}% of the way to bursting \u00b7 ${clock(elapsed(w))} \u00b7 best ${best}`;
  $('result').classList.add('on'); audio.win?.(stars);
  window.__yolk.result = { score: sc, stars, peak: w.peak };
}
// a burst yolk runs out into a pool on whatever is under it
function drain(dt) {
  const w = world; if (!w.burst) return;
  const v0 = w.sim.uniforms.vol0;
  const target = w.vol0 * 0.18, nv = target + (v0.value - target) * Math.exp(-dt * 1.6);
  w.drained += v0.value - nv; v0.value = nv;
  if (!w.c) return;
  const [x, , z] = w.c;
  let y = TABLE_Y + 0.005, rmax = 7;
  if (Math.hypot(x - BOWL.x, z - BOWL.z) < BOWL.rim) { y = BOWL.bot + 0.005 + w.drained * 0.02; rmax = BOWL.rim * 0.8; }
  else if (Math.hypot(x, z) < 1.9 && w.c[1] < 1) { y = -eggR(0, -1, 0) + 0.25 + w.drained * 0.03; rmax = 1.4; }
  const r = Math.min(rmax, Math.sqrt(w.drained / (Math.PI * 0.12)));
  puddle.visible = r > 0.05; puddle.position.set(x, y, z); puddle.scale.set(r, 0.6, r);
}

// ---------- the pinch
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let grab = null;
function rayAt(x, y) { ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera); return ray.ray; }
// the front-most yolk vertex near the ray
function pick(x, y) {
  const p = world.posCache; if (!p) return -1;
  const r = rayAt(x, y), o = r.origin, d = r.direction, R = 0.3;
  let best = -1, bt = Infinity;
  for (let i = 0; i < world.sim.N; i++) {
    const vx = p[i * 4] - o.x, vy = p[i * 4 + 1] - o.y, vz = p[i * 4 + 2] - o.z, t = vx * d.x + vy * d.y + vz * d.z;
    const e2 = vx * vx + vy * vy + vz * vz - t * t;
    if (e2 < R * R && t < bt) { bt = t; best = i; }
  }
  return best;
}
function startGrab(e, vi) {
  const p = world.posCache, at = new THREE.Vector3(p[vi * 4], p[vi * 4 + 1], p[vi * 4 + 2]);
  // the fingertip moves in an upright plane facing you, through the pinch
  const n = new THREE.Vector3(); camera.getWorldDirection(n); n.y = 0; n.normalize();
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, at);
  const hit = new THREE.Vector3(); rayAt(e.clientX, e.clientY).intersectPlane(plane, hit);
  grab = { pointerId: e.pointerId, plane, delta: at.clone().sub(hit), x: e.clientX, y: e.clientY, world: at.clone() };
  world.sim.grabStart(at.toArray()); world.slip = 0; audio.grab();
  if (!world.tStart) world.tStart = performance.now();
  if (world.state === 'rest') world.state = 'carry';
  $('pinch').classList.add('on'); movePinch(e.clientX, e.clientY); document.body.classList.add('pulling'); $('hint').classList.add('gone');
}
function movePinch(x, y) { $('pinch').style.transform = `translate(${x}px, ${y}px) scale(${1.15 - grip * 0.5})`; }
function dragTo(x, y) {
  if (!grab) return; grab.x = x; grab.y = y;
  const hit = new THREE.Vector3(); if (rayAt(x, y).intersectPlane(grab.plane, hit)) grab.world.copy(hit.add(grab.delta));
  // the fingertip can't go into the board
  grab.world.y = Math.max(grab.world.y, TABLE_Y + 0.4);
  world.sim.grabMove(...grab.world.toArray()); movePinch(x, y);
}
// let go: on purpose, or because it slipped. Let go while the pinch still carries its weight and it is dropped
function endGrab(slipped = false) {
  if (!grab) return; grab = null;
  const w = world, carried = w.fw;
  w.sim.grabEnd(); audio.release();
  $('pinch').classList.remove('on'); document.body.classList.remove('pulling');
  if (!slipped && !w.done && w.lifted && carried > LET_GO) dropped('You let go while you still held its weight.');
  w.fw = 0;
}
cv.addEventListener('pointerdown', (e) => {
  audio.unlock(); if (e.button !== 0 || grab || world.done) return;
  const vi = pick(e.clientX, e.clientY);
  if (vi >= 0) { e.stopImmediatePropagation(); e.preventDefault(); cv.setPointerCapture(e.pointerId); startGrab(e, vi); }
}, { capture: true });
cv.addEventListener('pointermove', (e) => { if (grab && e.pointerId === grab.pointerId) { e.stopImmediatePropagation(); dragTo(e.clientX, e.clientY); } else if (grab) e.stopImmediatePropagation(); }, { capture: true });
const up = (e) => { if (grab && e.pointerId === grab.pointerId) { e.stopImmediatePropagation(); endGrab(); } };
cv.addEventListener('pointerup', up, { capture: true }); cv.addEventListener('pointercancel', up, { capture: true });
// the grip: the wheel, up / down (W / S), or on touch the slider at the right edge, for a second thumb
function setGrip(g) { grip = Math.max(0, Math.min(1, g)); if (grab) movePinch(grab.x, grab.y); hud(world, (world.lastStrain || 0)); }
cv.addEventListener('wheel', (e) => { e.stopImmediatePropagation(); e.preventDefault(); setGrip(grip - e.deltaY * 0.0008); }, { capture: true, passive: false });
const side = $('gripside');
const sideSet = (e) => { const r = side.getBoundingClientRect(); setGrip(1 - (e.clientY - r.top - 6) / (r.height - 12)); };
side.addEventListener('pointerdown', (e) => { side.setPointerCapture(e.pointerId); sideSet(e); });
side.addEventListener('pointermove', (e) => { if (side.hasPointerCapture(e.pointerId)) sideSet(e); });

// ---------- UI
const act = {
  new: () => { endGrab(true); seed = 1 + Math.floor(Math.random() * 9999); build(); },
  reset: () => { endGrab(true); build(); },
  strain: () => { strainOn = !strainOn; world.mesh.userData.strainView.value = strainOn ? 1 : 0; $('strain').classList.toggle('on', strainOn); },
  sound: () => { audio.on = !audio.on; $('sound').classList.toggle('on', audio.on); },
  hide: () => document.body.classList.toggle('calm'),
};
for (const k of ['new', 'strain', 'sound']) $(k).addEventListener('click', act[k]);
$('again').addEventListener('click', act.new); $('retry').addEventListener('click', act.reset);
$('strain').classList.toggle('on', strainOn); $('sound').classList.toggle('on', audio.on);
const keysHeld = new Set();
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (['arrowup', 'w', 'arrowdown', 's'].includes(key)) { keysHeld.add(key); e.preventDefault(); return; }
  const k = { n: 'new', r: 'reset', x: 'strain', m: 'sound', h: 'hide' }[key]; if (k) { act[k](); e.preventDefault(); }
});
addEventListener('keyup', (e) => keysHeld.delete(e.key.toLowerCase()));
addEventListener('blur', () => keysHeld.clear());
function keyGrip(dt) { let d = 0; for (const k of keysHeld) d += k === 'arrowup' || k === 'w' ? 1 : -1; if (d) setGrip(grip + d * dt * 0.6); }

// ---------- loop: the sim at a fixed 60 Hz, at most two steps a frame
build();
let acc = 0, last = performance.now(), paused = Q.has('paused');
function simStep() {
  // the fingers close on the skin over a third of a second, not at once
  const gu = world.sim.uniforms.grip; gu.value = grab ? gu.value + (grip - gu.value) * 0.12 : 0;
  world.sim.step(); frame++; drain(1 / 60);
}
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000); acc = Math.min(acc + dt, 2 / 60); last = now;
  keyGrip(dt);
  if (world.tStart) $('time').textContent = clock(elapsed());
  if (!paused) while (acc >= 1 / 60 - 1e-4) { simStep(); acc -= 1 / 60; }
  controls.update(); draw(); readbacks();
}
if (!Q.has('shot')) renderer.setAnimationLoop(tick);
$('status').remove(); document.body.classList.add('ready');

// for the headless tests
window.__yolk = {
  get world() { return world; }, camera, controls, renderer, THREE, BOWL, YR, POST, scene,
  pause(v) { paused = v; },
  async steps(n, read = true) { for (let i = 0; i < n; i++) { simStep(); if (read && i % 2 === 1) await this.read(); } },
  // the frame's readbacks, awaited, so a test sees what the HUD sees
  async read() { const w = world; w.posCache = await w.sim.readPositions(); where(w); judge(w, await w.sim.readCounters(), await w.sim.readAcc()); },
  setGrip, get grip() { return grip; },
  // pinch the top of the yolk, then move the fingertip to (x, y, z)
  grabTop() { const p = world.posCache; let best = 0; for (let i = 0; i < world.sim.N; i++) if (p[i * 4 + 1] > p[best * 4 + 1]) best = i; startGrab({ clientX: 0, clientY: 0, pointerId: 1 }, best); grab.world.set(p[best * 4], p[best * 4 + 1], p[best * 4 + 2]); return grab.world.toArray(); },
  moveTo(x, y, z) { if (grab) { grab.world.set(x, y, z); world.sim.grabMove(x, y, z); } },
  get tip() { return grab ? grab.world.toArray() : null; },
  endGrab, pick, render() { draw(); }, snapshot,
  project(x, y, z) { const v = new THREE.Vector3(x, y, z).project(camera); return [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; },
  rebuild(s) { seed = s; endGrab(true); build(); }, inBowl: () => inBowl(world.c), get result() { return this._result; }, set result(v) { this._result = v; },
};
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !Q.has('shot')) navigator.serviceWorker.register('sw.js').catch(() => {});

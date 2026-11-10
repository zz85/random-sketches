// main.js - Membrane: peel the membrane off the inside of a broken eggshell. The membrane is a GPU cloth
// (sim.js, TSL compute) glued to the shell; pinch it and pull. Drag the shell itself to pick it up out of the cup
// and turn it (or tilt it with the keys), so you can peel down and away as you would holding a real one.
// Score: the share of the membrane you get off, less points for every millimetre torn and every extra piece. Pull slowly and it lets go of the shell and
// comes away in a sheet; yank it, or pull straight off the wall, and it stretches, goes thin and tears.
import * as THREE from 'three/webgpu';
import { makeStage } from './stage.js';
import { makeRim, buildMembrane, inShell } from './egg.js';
import { makeSim } from './sim.js';
import { buildShell, buildMembraneMesh, buildStrands } from './scene.js';
import { makeAudio } from './audio.js';

const $ = (id) => document.getElementById(id);
const Q = new URLSearchParams(location.search);
for (const [k, v] of new URLSearchParams(location.hash.slice(1))) Q.set(k, v);
const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
const LEVEL = Q.has('level') ? +Q.get('level') : 5;
const OPT = { substeps: +(Q.get('substeps') || (LEVEL >= 6 ? 10 : 8)), iters: +(Q.get('iters') || (LEVEL >= 6 ? 4 : 3)) };
let seed = Q.has('seed') ? +Q.get('seed') : 1 + Math.floor(Math.random() * 9999);
let brown = Q.get('shell') !== 'white';

if (!navigator.gpu) { $('status').textContent = 'Membrane needs WebGPU (Chrome, Edge, Safari 26 or Firefox 141 and later).'; throw new Error('no WebGPU'); }

const { renderer, scene, camera, controls, sun, draw, snapshot } = await makeStage({ Q, phone });
const audio = makeAudio();

// ---------- the shell's rig: seated in the cup, or held up in the air and turned
const rig = new THREE.Group(); scene.add(rig);
const HOLD = new THREE.Vector3(0, 0.9, 0.8);
const pose = { held: false, pos: new THREE.Vector3(), q: new THREE.Quaternion() }; // where the rig is heading
let wantDist = 0; // a camera distance to ease to, once, as the shell goes up (it needs more room) or comes down
function pickUp(q) {
  if (!pose.held) { pose.held = true; pose.pos.copy(HOLD); wantDist = Math.max(camera.position.distanceTo(controls.target), 18.5); }
  if (q) pose.q.copy(q);
  $('hold').textContent = 'Set down'; $('hold').classList.add('on');
}
function setDown() { if (pose.held) wantDist = 16.8; pose.held = false; pose.pos.set(0, 0, 0); pose.q.identity(); $('hold').textContent = 'Pick up'; $('hold').classList.remove('on'); }
// the preset hold: opening turned to face you, tipped down a little, so the far wall peels down toward you
const FACING = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.8, 0, 0));
// turn the shell by a screen drag of (dx, dy) pixels, about the camera's own axes (a trackball)
function turnShell(dx, dy) {
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0), upv = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const axis = right.multiplyScalar(dy).add(upv.multiplyScalar(dx)); const a = axis.length() * 0.0075;
  if (a < 1e-6) return;
  pickUp(); pose.q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis.normalize(), a)).normalize();
}
let seatedNow = true;
function updateRig(dt) {
  const k = 1 - Math.exp(-dt * 9);
  rig.position.lerp(pose.pos, k); rig.quaternion.slerp(pose.q, k);
  // it sits only once it's back home: then the cup holds the membrane too
  if (rig.position.distanceToSquared(pose.pos) < 1e-8 && rig.quaternion.angleTo(pose.q) < 1e-5) { rig.position.copy(pose.pos); rig.quaternion.copy(pose.q); }
  rig.updateMatrixWorld();
  seatedNow = !pose.held && rig.position.lengthSq() === 0 && rig.quaternion.w === 1;
  world.sim.setFrame(rig.matrixWorld, seatedNow);
  // keep the view on the shell
  controls.target.lerp(new THREE.Vector3(0, pose.held ? 0.3 : -0.6, 0).add(rig.position), k);
  if (wantDist) {
    const off = camera.position.clone().sub(controls.target), d = off.length(), nd = d + (wantDist - d) * k;
    camera.position.copy(controls.target).add(off.multiplyScalar(nd / d));
    if (Math.abs(wantDist - nd) < 0.02) wantDist = 0;
  }
}

let world = null; // { table, sim, shell, mesh }
function build() {
  if (world) { rig.remove(world.shell, world.mesh, world.strands); world.shell.userData.dispose(); world.mesh.userData.dispose(); world.strands.userData.dispose(); }
  const table = makeRim(seed);
  const m = buildMembrane(LEVEL, table, seed);
  const sim = makeSim(m, table, OPT); sim.init(renderer);
  const shell = buildShell(table, { brown });
  const mesh = buildMembraneMesh(sim, sun);
  mesh.userData.strainView.value = strainOn ? 1 : 0;
  const strands = buildStrands(sim);
  rig.add(shell, mesh, strands);
  world = { table, sim, shell, mesh, strands, posCache: null, reading: false, count: null, base: null, t0: performance.now(), done: false,
    glued: m.N - m.flap.reduce((a, b) => a + b, 0) };
  $('result').classList.remove('on'); lastTorn = 0; if (window.__membrane) window.__membrane.result = null;
  $('time').textContent = '0:00';
  updateHash();
}
let strainOn = Q.has('strain');

// ---------- readbacks: positions for picking, counters for the HUD and the sound
let frame = 0;
function readbacks() {
  const w = world;
  if (!world.sim.stepped) return;
  if (!w.reading && (frame % 4 === 0 || !w.posCache)) {
    w.reading = true;
    w.sim.readPositions().then((p) => { if (world === w) w.posCache = p; }).finally(() => { w.reading = false; });
  }
  // the threads' total length, for the creak of their drawing out
  if (audio.live() && !w.strandReading && frame % 3 === 0) {
    w.strandReading = true;
    w.sim.readStrands().then((b) => {
      let L = 0; for (let k = 0; k < b.length; k += 4) if (b[k + 1] > 0.5 && b[k + 1] < 1.5) L += b[k + 2];
      const now = performance.now();
      if (w.strandAt) w.stretch = Math.max(0, (L - w.strandL) / Math.max(0.016, (now - w.strandAt) / 1000));
      w.strandL = L; w.strandAt = now;
    }).finally(() => { w.strandReading = false; });
  }
  if (!w.countReading) {
    w.countReading = true;
    w.sim.readCounters().then((c) => {
      if (world !== w) return;
      const now = performance.now(), dt = w.countAt ? Math.min(0.2, (now - w.countAt) / 1000) : 1 / 60;
      if (w.count) audio.events(c[0] - w.count[0], c[1] - w.count[1], c[5] - w.count[5], c[6] - w.count[6], c[4] - w.count[4], w.stretch || 0, dt);
      w.countAt = now;
      w.count = c; w.countReading = false; hud();
    }).catch(() => { w.countReading = false; });
  }
}
// ---------- score: up to 1000 for getting it all off, 8 a millimetre torn, 150 for each piece past the first
const WIN_AT = 0.92, PER_MM = 8, PER_PIECE = 150, LOSE_MM = 50; // tear 5 cm and the membrane is ruined: you lose
let lastTorn = 0;
const tornMM = (c) => (c[0] * world.sim.m.edge * 10) / 1.5;
const peeledFrac = (c) => Math.max(0, Math.min(1, (c[1] - c[4]) / world.glued));
const scoreOf = (c, pieces = 1) => Math.max(0, Math.round(1000 * Math.min(1, peeledFrac(c) / WIN_AT) - PER_MM * tornMM(c) - PER_PIECE * (pieces - 1)));
function popup(text, x, y, cls) {
  const d = document.createElement('div'); d.className = 'pop ' + cls; d.textContent = text;
  d.style.left = x + 'px'; d.style.top = y + 'px'; document.body.appendChild(d); setTimeout(() => d.remove(), 1200);
}
// pieces: the membrane's vertices joined by unbroken links, counting the ones of 15 vertices or more
async function countPieces() {
  const m = world.sim.m, L = new Float32Array(await renderer.getArrayBufferAsync(world.sim.buffers.links.value));
  const par = new Int32Array(m.N).map((_, i) => i), f = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (let e = 0; e < m.nStruct; e++) if (L[e * 4 + 3] > 0.5) { const a = f(L[e * 4]), b = f(L[e * 4 + 1]); if (a !== b) par[a] = b; }
  const size = new Map(); for (let i = 0; i < m.N; i++) { const r = f(i); size.set(r, (size.get(r) || 0) + 1); }
  return [...size.values()].filter((n) => n >= 15).length;
}
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const elapsed = () => (world.tStart ? ((world.tEnd || performance.now()) - world.tStart) / 1000 : 0);
// torn too far: the round is lost
function lose() {
  const w = world; w.done = true; w.tEnd = performance.now(); endGrab();
  const c = w.count, mm = tornMM(c);
  $('result').classList.add('lose');
  $('rtitle').textContent = 'YOU LOSE';
  $('rstars').textContent = '\u2606\u2606\u2606';
  $('rscore').textContent = 'Torn apart';
  $('rdetail').textContent = `${mm.toFixed(0)} mm torn after ${clock(elapsed())}, with ${Math.round(peeledFrac(c) * 100)}% off. Peel slower, and off the wall.`;
  $('result').classList.add('on');
  audio.lose?.();
  window.__membrane.result = { lost: true, mm };
}
async function finish() {
  const w = world; w.done = true; w.tEnd = performance.now();
  const c = w.count = Array.from(await w.sim.readCounters()), pieces = await countPieces(), mm = tornMM(c), sc = scoreOf(c, pieces), secs = elapsed();
  const clean = pieces === 1 && mm < 3;
  const stars = clean ? 3 : pieces === 1 && mm < 25 ? 2 : 1;
  const best = Math.max(sc, +(localStorage.getItem('membrane.best') || 0)); localStorage.setItem('membrane.best', best);
  $('rtitle').textContent = clean ? 'Clean peel!' : pieces === 1 ? 'Peeled, with a tear' : `Peeled, in ${pieces} pieces`;
  $('rstars').textContent = '\u2605'.repeat(stars) + '\u2606'.repeat(3 - stars);
  $('rscore').textContent = sc;
  $('rdetail').textContent = `${Math.round(peeledFrac(c) * 100)}% off \u00b7 ${mm < 1 ? 'no tears' : mm.toFixed(0) + ' mm torn'} \u00b7 ${pieces} piece${pieces > 1 ? 's' : ''} \u00b7 ${clock(secs)} \u00b7 best ${best}`;
  $('result').classList.remove('lose'); $('result').classList.add('on');
  audio.win?.(stars);
  window.__membrane.result = { score: sc, pieces, mm, stars, clean };
}
function hud() {
  const c = world.count; if (!c) return;
  const peeled = 100 * peeledFrac(c), mm = tornMM(c);
  // the peel bar fills to the dashed line at the goal (92%); the intact bar drains with every millimetre torn
  $('peelbar').firstElementChild.style.width = Math.min(100, peeled / WIN_AT).toFixed(1) + '%';
  $('peeled').textContent = `${peeled.toFixed(0)}% / ${Math.round(WIN_AT * 100)}%`;
  const life = Math.max(0, 1 - mm / LOSE_MM);
  $('lifebar').firstElementChild.style.width = (life * 100).toFixed(1) + '%';
  $('lifebar').classList.toggle('warn', life < 0.6 && life >= 0.3); $('lifebar').classList.toggle('danger', life < 0.3);
  $('torn').textContent = mm < 1 ? 'no tears' : `${mm.toFixed(0)} mm torn`;
  $('score').textContent = scoreOf(c);
  // every new millimetre of tear costs points: say so at the fingertip
  if (mm - lastTorn >= 1) {
    const lost = Math.round((mm - lastTorn) * PER_MM);
    if (grab) popup('-' + lost, grab.x + 26, grab.y - 18, 'bad'); else popup('-' + lost, innerWidth / 2, innerHeight * 0.4, 'bad');
    for (const el of [$('scorebox'), $('lifebar')]) { const k = el === $('scorebox') ? 'hit' : 'shake'; el.classList.remove(k); void el.offsetWidth; el.classList.add(k); }
    lastTorn = mm;
  }
  if (!world.done && mm >= LOSE_MM) lose();
  else if (!world.done && peeledFrac(c) >= WIN_AT) finish();
  const strain = c[2] / 1000;
  if (grab) { const k = Math.min(1, strain / (world.sim.P.tear * 0.9)); $('pinch').style.setProperty('--k', k.toFixed(3)); }
}

// ---------- picking and pulling
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
let grab = null; // { pointerId, plane, delta }
function rayAt(x, y) { ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera); return ray.ray; }
const inv = new THREE.Matrix4();
const toLocal = (v) => v.applyMatrix4(inv.copy(rig.matrixWorld).invert());
// what is under (x, y): a membrane vertex (vi >= 0), the shell itself (shell true), or nothing
function pickAt(x, y) {
  const p = world.posCache; if (!p) return { vi: -1, shell: false };
  const r = rayAt(x, y).clone().applyMatrix4(inv.copy(rig.matrixWorld).invert()), o = r.origin, d = r.direction;
  // where the ray first meets the shell itself: nothing behind that can be reached
  let tShell = Infinity;
  for (let t = 0; t < 40; t += 0.01) { if (inShell(world.table, o.x + d.x * t, o.y + d.y * t, o.z + d.z * t)) { tShell = t; break; } }
  const R = 0.32; let best = -1, bt = Infinity;
  const cand = [];
  for (let i = 0; i < world.sim.N; i++) {
    const vx = p[i * 4] - o.x, vy = p[i * 4 + 1] - o.y, vz = p[i * 4 + 2] - o.z;
    const t = vx * d.x + vy * d.y + vz * d.z; if (t <= 0 || t > tShell + 0.02) continue; // nothing through the shell
    const ex = vx - d.x * t, ey = vy - d.y * t, ez = vz - d.z * t, e2 = ex * ex + ey * ey + ez * ez;
    if (e2 < R * R) { cand.push([i, t, e2]); if (t < bt) bt = t; }
  }
  // nearest to the ray among the front-most, and not behind the shell: march from the vertex back toward the
  // eye a few millimetres, and drop it if that crosses shell (a vertex just behind the wall, a little to one side)
  const seen = (i) => { for (let k = 0.006; k < 0.6; k += 0.006) if (inShell(world.table, p[i * 4] - d.x * k, p[i * 4 + 1] - d.y * k, p[i * 4 + 2] - d.z * k)) return false; return true; };
  cand.sort((a, b) => a[2] - b[2]);
  for (const [i, t] of cand) if (t < bt + 0.25 && seen(i)) { best = i; break; }
  return { vi: best, shell: best < 0 && tShell < Infinity };
}
const pick = (x, y) => pickAt(x, y).vi;
function startGrab(e, vi) {
  const p = world.posCache, at = [p[vi * 4], p[vi * 4 + 1], p[vi * 4 + 2]];
  const atW = new THREE.Vector3(...at).applyMatrix4(rig.matrixWorld);
  const n = new THREE.Vector3(); camera.getWorldDirection(n);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, atW);
  const hit = new THREE.Vector3(); rayAt(e.clientX, e.clientY).intersectPlane(plane, hit);
  // the fingertip lives in the world: each frame it is turned into the shell's frame, so it holds still while the shell moves
  grab = { pointerId: e.pointerId, plane, delta: atW.clone().sub(hit), x: e.clientX, y: e.clientY, world: atW.clone() };
  world.sim.grabStart(vi, at); audio.grab();
  if (!world.tStart) world.tStart = performance.now();
  $('pinch').classList.add('on'); movePinch(e.clientX, e.clientY);
  document.body.classList.add('pulling'); $('hint').classList.add('gone');
}
function movePinch(x, y) { $('pinch').style.transform = `translate(${x}px, ${y}px)`; }
function dragTo(x, y) {
  if (!grab) return;
  grab.x = x; grab.y = y;
  const hit = new THREE.Vector3();
  if (rayAt(x, y).intersectPlane(grab.plane, hit)) grab.world.copy(hit.add(grab.delta));
  aimGrab();
  movePinch(x, y);
}
function aimGrab() { if (!grab) return; const l = toLocal(grab.world.clone()); world.sim.grabMove(l.x, l.y, l.z); }
function endGrab() {
  if (!grab) return; grab = null; world.sim.grabEnd(); audio.release();
  $('pinch').classList.remove('on'); document.body.classList.remove('pulling');
}
const cv = renderer.domElement;
// One pointer may pinch the membrane while another holds and turns the shell, as two hands do on a phone.
// With a mouse: drag the shell to turn it (it stays up where you leave it), right-drag anywhere does the same,
// and the arrow keys or W A S D / Q E tilt it while you peel. Double-click the shell, or Set down, to put it back.
let turn = null; // { pointerId, x, y, at }
let lastShellTap = 0;
cv.addEventListener('contextmenu', (e) => e.preventDefault());
cv.addEventListener('pointerdown', (e) => {
  audio.unlock();
  if (e.button === 2 && !turn) { e.stopImmediatePropagation(); e.preventDefault(); cv.setPointerCapture(e.pointerId); turn = { pointerId: e.pointerId, x: e.clientX, y: e.clientY }; return; }
  if (e.button !== 0) return;
  const hit = pickAt(e.clientX, e.clientY);
  if (hit.vi >= 0 && !grab && !world.done) {
    e.stopImmediatePropagation(); e.preventDefault(); cv.setPointerCapture(e.pointerId);
    startGrab(e, hit.vi);
  } else if (hit.shell && !turn) {
    e.stopImmediatePropagation(); e.preventDefault(); cv.setPointerCapture(e.pointerId);
    const now = performance.now();
    if (now - lastShellTap < 320) { setDown(); lastShellTap = 0; return; }
    lastShellTap = now;
    turn = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    if (!pose.held) { pickUp(); audio.lift?.(); }
    $('hint').classList.add('gone');
  } else if (grab || turn) {
    e.stopImmediatePropagation(); // a stray second finger shouldn't start an orbit mid-peel
  }
}, { capture: true });
cv.addEventListener('pointermove', (e) => {
  if (grab && e.pointerId === grab.pointerId) { e.stopImmediatePropagation(); dragTo(e.clientX, e.clientY); }
  else if (turn && e.pointerId === turn.pointerId) { e.stopImmediatePropagation(); turnShell(e.clientX - turn.x, e.clientY - turn.y); turn.x = e.clientX; turn.y = e.clientY; }
  else if (grab || turn) e.stopImmediatePropagation();
}, { capture: true });
const up = (e) => {
  if (grab && e.pointerId === grab.pointerId) { e.stopImmediatePropagation(); endGrab(); }
  else if (turn && e.pointerId === turn.pointerId) { e.stopImmediatePropagation(); turn = null; }
};
cv.addEventListener('pointerup', up, { capture: true }); cv.addEventListener('pointercancel', up, { capture: true });
// while pulling, the wheel moves the fingertip toward or away from you
cv.addEventListener('wheel', (e) => {
  if (!grab) return; e.stopImmediatePropagation(); e.preventDefault();
  grab.plane.constant += e.deltaY * 0.004; dragTo(grab.x, grab.y);
}, { capture: true, passive: false });

// ---------- UI
function updateHash() {
  const h = new URLSearchParams(); h.set('seed', seed); if (!brown) h.set('shell', 'white'); if (strainOn) h.set('strain', '');
  history.replaceState(null, '', '#' + h.toString().replace(/=(&|$)/g, '$1'));
}
const act = {
  new: () => { endGrab(); setDown(); seed = 1 + Math.floor(Math.random() * 9999); build(); },
  reset: () => { endGrab(); setDown(); build(); },
  hold: () => { if (pose.held) setDown(); else { pickUp(FACING); audio.lift?.(); } },
  strain: () => { strainOn = !strainOn; world.mesh.userData.strainView.value = strainOn ? 1 : 0; $('strain').classList.toggle('on', strainOn); updateHash(); },
  shell: () => { brown = !brown; world.shell.userData.shellTint.value = brown ? 1 : 0; $('shell').textContent = brown ? 'Brown' : 'White'; updateHash(); },
  sound: () => { audio.on = !audio.on; $('sound').classList.toggle('on', audio.on); },
  hide: () => document.body.classList.toggle('calm'),
};
for (const k of ['new', 'reset', 'strain', 'shell', 'sound', 'hold']) $(k).addEventListener('click', act[k]);
$('again').addEventListener('click', act.new);
$('retry').addEventListener('click', act.reset);
$('strain').classList.toggle('on', strainOn); $('sound').classList.toggle('on', audio.on); $('shell').textContent = brown ? 'Brown' : 'White';
// tilt keys, held: arrows or W A S D turn the shell toward or away from you and side to side, Q E roll it
const TILT = { arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0] };
const held = new Set();
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (TILT[key] || key === 'q' || key === 'e') { held.add(key); e.preventDefault(); return; }
  const k = { n: 'new', r: 'reset', s: 'strain', b: 'shell', m: 'sound', h: 'hide', c: 'hold', ' ': 'hold' }[key];
  if (k) { act[k](); e.preventDefault(); }
});
addEventListener('keyup', (e) => held.delete(e.key.toLowerCase()));
addEventListener('blur', () => held.clear());
function keyTilt(dt) {
  let dx = 0, dy = 0, roll = 0;
  for (const k of held) { if (TILT[k]) { dx += TILT[k][0]; dy += TILT[k][1]; } if (k === 'q') roll -= 1; if (k === 'e') roll += 1; }
  if (dx || dy) turnShell(dx * dt * 180, dy * dt * 180);
  if (roll) { pickUp(); const f = new THREE.Vector3(); camera.getWorldDirection(f); pose.q.premultiply(new THREE.Quaternion().setFromAxisAngle(f, roll * dt * 1.4)).normalize(); }
}

// ---------- loop: the sim runs at a fixed 60 Hz, at most two steps a frame
build();
let acc = 0, last = performance.now(), paused = Q.has('paused');
function simStep() { updateRig(1 / 60); aimGrab(); world.sim.step(); frame++; }
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  acc = Math.min(acc + dt, 2 / 60); last = now;
  keyTilt(dt);
  if (world.tStart) $('time').textContent = clock(elapsed());
  if (!paused) while (acc >= 1 / 60 - 1e-4) { simStep(); acc -= 1 / 60; }
  controls.update();
  draw();
  readbacks();
}
if (!Q.has('shot')) renderer.setAnimationLoop(tick);
$('status').remove(); document.body.classList.add('ready');

// for the headless tests
window.__membrane = {
  get world() { return world; }, camera, controls, renderer, THREE,
  info: { level: LEVEL, ...OPT, N: world.sim.N, NT: world.sim.NT, NL: world.sim.NL, edge: world.sim.m.edge },
  pause(v) { paused = v; },
  steps(n) { for (let i = 0; i < n; i++) simStep(); controls.update(); },
  lose, LOSE_MM, async refresh() { world.count = Array.from(await world.sim.readCounters()); hud(); }, pickUp: (q) => pickUp(q ? new THREE.Quaternion(...q) : FACING), setDown, turnShell, rig, pose, finish, countPieces, scoreOf: (c) => scoreOf(c),
  grabVertex(vi) { startGrab({ clientX: innerWidth / 2, clientY: innerHeight / 2, pointerId: 1 }, vi); return vi; },
  pickAt, toWorld: (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(rig.matrixWorld).toArray(),
  grabWorld(x, y, z) { if (grab) { grab.world.set(x, y, z); aimGrab(); } },
  render() { draw(); }, snapshot,
  pick, startGrab: (x, y) => { const vi = pick(x, y); if (vi >= 0) startGrab({ clientX: x, clientY: y, pointerId: 1 }, vi); return vi; }, dragTo, endGrab,
  project(x, y, z) { const v = new THREE.Vector3(x, y, z).applyMatrix4(rig.matrixWorld).project(camera); return [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; },
  async counters() { return Array.from(await world.sim.readCounters()); },
  async positions() { return world.sim.readPositions(); },
  rebuild(s) { seed = s; build(); }, audio, makeAudio,
};
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !Q.has('shot')) navigator.serviceWorker.register('sw.js').catch(() => {});

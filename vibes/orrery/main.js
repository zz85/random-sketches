// main.js - Orrery: two ways to hold the real sky of your time and place.
//   Miniature: a celestial wristwatch on your phone (watch.js). With motion on, its chart flips to a ground
//   map and turns with the compass, and the flange shows which way to face for each body.
//   Immersive: a planetarium around you (sky.js, planets.js). Hold the phone up and the sky is where it is,
//   with the planets brought 2000x closer so you see them as globes.
import * as THREE from 'three/webgpu';
import { pass, vec2, vec4, float, mix, smoothstep, length, screenUV, screenSize, hash, time, Fn } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { Sky, BODIES, moonPhaseName, declination } from './astro.js';
import { buildSky, buildHorizon, U } from './sky.js';
import { buildPlanets, updatePlanets } from './planets.js';
import { buildWatch, updateWatch } from './watch.js';
import { pinWorld, skyToWatch, EARTH_R } from './orrery.js';

const Q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const D2R = Math.PI / 180;
const isTouch = matchMedia('(pointer: coarse)').matches;
const clamp = THREE.MathUtils.clamp;

// ------------------------------------------------------------------ state
const saved = JSON.parse(localStorage.getItem('orrery') || '{}');
const state = {
  lat: Q.has('lat') ? +Q.get('lat') : saved.lat ?? 47.6062,
  lon: Q.has('lon') ? +Q.get('lon') : saved.lon ?? -122.3321,
  placeName: Q.has('lat') ? '' : saved.placeName ?? 'Seattle',
  offsetMs: Q.has('t') ? new Date(Q.get('t')).getTime() - Date.now() : 0,
  speed: 1, paused: false, unit: 'h',
  mode: Q.get('mode') === 'sky' ? 'sky' : 'mini',
  labels: Q.has('labels') ? +Q.get('labels') : 1,
  magnify: Q.has('mag') ? +Q.get('mag') : 1, mag: Q.has('mag') ? +Q.get('mag') : 1,
  motion: false,
  yaw: Q.has('yaw') ? +Q.get('yaw') * D2R : 180 * D2R, pitch: Q.has('pitch') ? +Q.get('pitch') * D2R : 25 * D2R, fov: Q.has('fov') ? +Q.get('fov') : (isTouch ? 72 : 60),
  decl: 0, selected: null,
  face: Q.get('face') || localStorage.getItem('orrery-face') || 'chart', wzoom: 1,
  centre: (Q.get('centre') || localStorage.getItem('orrery-centre')) === 'sun' ? 'sun' : 'earth',
};
const SPEEDS = [-2592000, -604800, -86400, -3600, -600, -60, -1, 1, 60, 600, 3600, 86400, 604800, 2592000];
const speedLabel = (s) => { const a = Math.abs(s), sg = s < 0 ? '−' : ''; return a === 1 ? (s < 0 ? '−1×' : '') : a < 3600 ? `${sg}${a / 60} min/s` : a < 86400 ? `${sg}${a / 3600} h/s` : a < 604800 ? `${sg}${a / 86400} day/s` : a < 2592000 ? `${sg}${a / 604800} wk/s` : `${sg}30 day/s`; };
const simDate = () => new Date(Date.now() + state.offsetMs);

// ------------------------------------------------------------------ renderer and the two scenes
const renderer = new THREE.WebGPURenderer({ canvas: $('gl'), antialias: true, forceWebGL: Q.has('webgl') });
const maxPR = Math.min(window.devicePixelRatio || 1, 2);
let pr = Q.has('pr') ? +Q.get('pr') : Math.min(maxPR, isTouch ? 1.6 : 2);
renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;

const sky = new Sky();

// immersive
const skyScene = new THREE.Scene(); skyScene.background = new THREE.Color(0x010208);
const skyCam = new THREE.PerspectiveCamera(state.fov, innerWidth / innerHeight, 0.05, 4000); skyCam.rotation.order = 'YXZ';
const skyParts = buildSky(); skyScene.add(skyParts.group);
const horizon = buildHorizon(); skyScene.add(horizon);
const planets = buildPlanets(); skyScene.add(planets.group);

// miniature
const wScene = new THREE.Scene(); wScene.background = new THREE.Color(0x05070f);
const wCam = new THREE.PerspectiveCamera(26, innerWidth / innerHeight, 0.5, 40);
const watch = buildWatch(state.lat, placeLine());
wScene.add(watch.root, watch.key, watch.key.target);
wScene.add(new THREE.HemisphereLight(0x8090c0, 0x201810, 0.25));

function pipelineFor(scene, camera, strength, radius, threshold, vignette) {
  const p = new THREE.RenderPipeline(renderer), sp = pass(scene, camera), col = sp.getTextureNode('output');
  const bl = bloom(col, strength, radius, threshold);
  p.outputNode = Fn(() => {
    const c = col.add(bl);
    const v = smoothstep(1.1, 0.2, length(screenUV.sub(0.5).mul(vec2(screenSize.x.div(screenSize.y), 1))));
    const px = screenUV.mul(screenSize).floor();
    const g = hash(px.x.add(px.y.mul(4111.0)).add(time.mul(60).floor().mul(7919.0).mod(65536))).sub(0.5).mul(0.014);
    return vec4(c.rgb.mul(mix(float(vignette), float(1), v)).add(g), 1);
  })();
  return p;
}
const skyPipe = pipelineFor(skyScene, skyCam, 0.55, 0.5, 0.8, 0.55);
const wPipe = pipelineFor(wScene, wCam, 0.25, 0.25, 1.1, 0.3);

// ------------------------------------------------------------------ site
function placeLine() {
  const lat = `${Math.abs(state.lat).toFixed(2)}° ${state.lat >= 0 ? 'N' : 'S'}`, lon = `${Math.abs(state.lon).toFixed(2)}° ${state.lon >= 0 ? 'E' : 'W'}`;
  return `${state.placeName ? state.placeName + ' · ' : ''}${lat} ${lon}`;
}
function setPlace(lat, lon, name = '') {
  state.lat = lat; state.lon = lon; state.placeName = name;
  state.decl = declination(lat, lon);
  watch.setChart(lat, watch.chart.m, placeLine());
  localStorage.setItem('orrery', JSON.stringify({ lat, lon, placeName: name }));
}
state.decl = declination(state.lat, state.lon);
function locate(prompted) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition((p) => { setPlace(+p.coords.latitude.toFixed(4), +p.coords.longitude.toFixed(4), ''); hint('Your sky, here and now'); },
    () => { if (prompted) hint('Location unavailable: showing ' + (state.placeName || 'the last place')); }, { timeout: 15000, maximumAge: 600000 });
}

// ------------------------------------------------------------------ motion sensors
const gyro = { have: false, alpha: 0, beta: 0, gamma: 0, abs: false, offset: null, manual: 0, rest: null };
const euler = new THREE.Euler(), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)), qz = new THREE.Quaternion(), zee = new THREE.Vector3(0, 0, 1);
function onOrient(e, isAbs) {
  if (e.alpha == null) return;
  if (isAbs) gyro.abs = true; else if (gyro.abs) return; // prefer the absolute stream where it exists
  let alpha = e.alpha;
  if (!isAbs && e.webkitCompassHeading != null && !Number.isNaN(e.webkitCompassHeading)) {
    // iOS: alpha starts anywhere; the compass heading says where north is. Smooth the offset on the circle.
    const off = ((360 - e.webkitCompassHeading - e.alpha) % 360 + 360) % 360;
    if (gyro.offset == null) gyro.offset = off;
    else { const d = ((off - gyro.offset + 540) % 360) - 180; gyro.offset = (gyro.offset + d * 0.05 + 360) % 360; }
    alpha += gyro.offset;
  }
  alpha = alpha - state.decl + gyro.manual; // magnetic to true north, and the user's correction
  gyro.alpha = alpha * D2R; gyro.beta = e.beta * D2R; gyro.gamma = e.gamma * D2R; gyro.have = true;
}
function gyroQuat(out) {
  euler.set(gyro.beta, gyro.alpha, -gyro.gamma, 'YXZ');
  out.setFromEuler(euler).multiply(q1);
  const o = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  return out.multiply(qz.setFromAxisAngle(zee, -o * D2R));
}
async function enableMotion() {
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      const r = await DeviceOrientationEvent.requestPermission(); if (r !== 'granted') { hint('Motion access was declined'); return; }
    }
  } catch (e) { /* not iOS, or not from a tap */ }
  if (!state.motionBound) { addEventListener('deviceorientationabsolute', (e) => onOrient(e, true)); addEventListener('deviceorientation', (e) => onOrient(e, false)); state.motionBound = true; }
  state.motion = true; $('motion').classList.add('on');
  setTimeout(() => {
    if (!gyro.have) { hint('No motion sensors here: drag to look around'); setMotion(false); return; }
    hint(state.mode === 'sky' ? 'Hold the phone up to the sky. Drag sideways if the compass is off' : 'The chart is a map of the sky above you now, turned to the compass. The flange shows which way to face');
    if (state.mode === 'mini') flipChart(-1);
  }, 900);
}
function setMotion(on) {
  if (on) return enableMotion();
  state.motion = false; $('motion').classList.remove('on');
  const e = new THREE.Euler().setFromQuaternion(skyCam.quaternion, 'YXZ'); state.yaw = e.y; state.pitch = e.x;
  flipChart(1);
}

// the dive between the two modes, when the watch shows its orrery: 0 on the wrist, 1 standing on the pin
let dive = { v: 0, from: 0, to: 0, t: 1, dur: 1, done: null };
const easeIO = (t) => 0.5 - 0.5 * Math.cos(Math.PI * t);
// turning the watch over, and the orrery's centre (0 Earth, 1 the Sun)
let turn = { v: 0, from: 0, to: 0, t: 1 }, helio = state.centre === 'sun' ? 1 : 0;
// run once just after the next frame is drawn, while its pixels can still be copied
let afterRender = null;
function runDive(to, dur, done = null) { dive = { v: dive.v, from: dive.v, to, t: 0, dur, done }; }
// the chart turns over between sky view and ground view
let flip = null;
function flipChart(m) { if (watch.chart.m === m && !flip) return; flip = { t: 0, to: m, swapped: false }; }

// ------------------------------------------------------------------ input on the canvas
const cv = renderer.domElement, pointers = new Map();
// orbit controls for the miniature: the camera moves round the watch (yaw, pitch), kept in front of the face that
// shows so it never goes behind; a flick coasts. The watch itself stays put
const view = { yaw: 0, pitch: 0, vy: 0, vp: 0, spin: false, home: false };
const YAW_MAX = 1.05, PITCH_MAX = 0.95;
// what the camera looks at, as an offset from the watch's centre, and the point a sideways drag on the orrery turns
// round: the place you put your finger, so that point stays put under it while the rest swings round
view.tg = new THREE.Vector3(); view.pivot = null; view.roll = 0; view.vr = 0;
const Y_AXIS = new THREE.Vector3(0, 1, 0), pvT = new THREE.Vector3();
let lookY = -0.06; // the height the camera looked at last frame (the watch lifts above an open card)
function setYaw(ny) {
  ny = clamp(ny, -YAW_MAX, YAW_MAX);
  if (view.pivot) { // turn the target round the vertical through the pivot by as much as the camera turns
    pvT.set(view.tg.x, view.tg.y + lookY, view.tg.z).sub(view.pivot).applyAxisAngle(Y_AXIS, ny - view.yaw).add(view.pivot);
    view.tg.set(pvT.x, pvT.y - lookY, pvT.z);
    if (view.tg.length() > 0.8) view.tg.setLength(0.8);
  }
  view.yaw = ny;
}
// a sideways drag on the face turns the view round the face's own axis (z), through the point under your finger,
// like turning the watch on the table with a fingertip held on it
const Z_AXIS = new THREE.Vector3(0, 0, 1), qRoll = new THREE.Quaternion();
function rollBy(dx) {
  if (dive.t < 1) return;
  const d = dx * 3.4 / Math.max(320, Math.min(innerWidth, innerHeight));
  const now = performance.now(), ddt = Math.max(8, now - (drag && drag.tr || now - 16)) / 1000; if (drag) drag.tr = now;
  view.vr = view.vr * 0.5 + (d / ddt) * 0.5; turnRoll(d); view.spin = false; view.home = false;
}
function turnRoll(d) {
  if (view.pivot) {
    pvT.set(view.tg.x, view.tg.y + lookY, view.tg.z).sub(view.pivot).applyAxisAngle(Z_AXIS, d).add(view.pivot);
    view.tg.set(pvT.x, pvT.y - lookY, pvT.z); if (view.tg.length() > 0.8) view.tg.setLength(0.8);
  }
  view.roll = wrapA(view.roll + d);
}
// the point of the orrery under a screen point, else of the plane of the face
const pvPlane = new THREE.Plane(), pvN = new THREE.Vector3();
function pointOn(x, y) {
  ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, wCam);
  const hit = ray.intersectObject(watch.orrery.group, true)[0];
  if (hit) return hit.point.clone();
  watch.head.getWorldPosition(pv); pvN.set(0, 0, 1).applyQuaternion(watch.root.quaternion);
  pvPlane.setFromNormalAndCoplanarPoint(pvN, pv);
  return ray.ray.intersectPlane(pvPlane, new THREE.Vector3()) || pv.clone();
}
let lastTap = 0, pinchWas = false, wheelEnd = 0;
const wrapA = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
function orbitBy(dx, dy) {
  if (dive.t < 1) return;
  const k = 3.4 / Math.max(320, Math.min(innerWidth, innerHeight)), ny = view.yaw - dx * k;
  const now = performance.now(), ddt = Math.max(8, now - (drag && drag.tm || now - 16)) / 1000; if (drag) drag.tm = now;
  view.vy = view.vy * 0.5 + (-dx * k / ddt) * 0.5; view.vp = view.vp * 0.5 + (dy * k / ddt) * 0.5;
  setYaw(ny); view.pitch = clamp(view.pitch + dy * k, -PITCH_MAX, PITCH_MAX); view.spin = false; view.home = false;
}
// is a screen point on the body at the orrery's centre (Earth, or the Sun when Sun-centred), within a fingertip?
function onCentreBody(x, y) {
  if (watch.face !== 'orrery' || dive.v > 0) return false;
  const m = state.centre === 'sun' ? watch.orrery.bodies.Sun.mesh : watch.orrery.earth.mesh;
  ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, wCam);
  if (ray.intersectObject(m, true).length) return true;
  m.getWorldPosition(pv).project(wCam);
  return Math.hypot((pv.x * 0.5 + 0.5) * innerWidth - x, (-pv.y * 0.5 + 0.5) * innerHeight - y) < 30;
}
// is a screen point on the crown? within a finger's width of its projected centre, or on its mesh
function onCrown(x, y) {
  if (state.mode !== 'mini' || dive.v > 0) return false;
  ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, wCam);
  if (ray.intersectObject(watch.crown, false).length) return true;
  watch.crown.getWorldPosition(pv).project(wCam);
  return Math.hypot((pv.x * 0.5 + 0.5) * innerWidth - x, (-pv.y * 0.5 + 0.5) * innerHeight - y) < 34;
}
// is a screen point on the dial? the dial's projected radius round the head's centre
const dv0 = new THREE.Vector3(), dv1 = new THREE.Vector3();
function onDial(x, y) {
  if (state.mode !== 'mini') return false;
  watch.head.getWorldPosition(dv0); dv1.set(1, 0, 0).applyQuaternion(wCam.quaternion).multiplyScalar(0.9).add(dv0);
  dv0.project(wCam); dv1.project(wCam);
  const cx = (dv0.x * 0.5 + 0.5) * innerWidth, cy = (-dv0.y * 0.5 + 0.5) * innerHeight, r = Math.hypot((dv1.x - dv0.x) * 0.5 * innerWidth, (dv1.y - dv0.y) * 0.5 * innerHeight);
  return Math.hypot(x - cx, y - cy) < r;
}
// zoom: on the front it brings the watch closer; on the back it goes on past that, into the orrery onto Earth
const ZMAX = 2.6, ZDIVE = 3.2;
const canDive = () => watch.face === 'orrery' && turn.t >= 1 && state.mode === 'mini';
const zoomNow = () => state.wzoom + (canDive() ? dive.v * ZDIVE : 0);
function zoomTo(z) {
  if (dive.t < 1) return;
  state.wzoom = clamp(z, 1, ZMAX);
  if (canDive()) { const v = clamp((z - ZMAX) / ZDIVE, 0, 1); dive = { v, from: v, to: v, t: 1, dur: 1, done: null }; if (v > 0) { turnTo = null; hideCard(); } }
}
// letting go: once Earth fills the view you are standing on it, so the dive finishes into the sky; before that it eases back out
function zoomEnd() {
  if (dive.t < 1 || dive.v <= 0 || !canDive()) return;
  if (dive.v > 0.42) runDive(1, Math.max(0.6, (1 - dive.v) * 3.4), diveLanded); else runDive(0, Math.max(0.4, dive.v * 2.6));
}
let drag = null, pinch0 = null;
const hover = { x: 0, y: 0 };
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: performance.now(), moved: 0, kind: null, vy: 0 };
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: state.fov, zc: zoomNow(), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; drag = null; pinchWas = state.mode === 'mini'; }
});
cv.addEventListener('pointermove', (e) => {
  hover.x = e.clientX / innerWidth * 2 - 1; hover.y = e.clientY / innerHeight * 2 - 1;
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch0 && pointers.size === 2) {
    const [a, b] = [...pointers.values()], k = pinch0.d / Math.max(10, Math.hypot(a.x - b.x, a.y - b.y));
    if (state.mode === 'sky') state.fov = clamp(pinch0.fov * k, 8, 100);
    else { zoomTo(pinch0.zc / k); const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2; orbitBy(mx - pinch0.mx, my - pinch0.my); pinch0.mx = mx; pinch0.my = my; }
    return;
  }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
  if (state.mode === 'sky') {
    const k = (state.fov * D2R) / innerHeight;
    if (state.motion && gyro.have) gyro.manual += dx * k / D2R;
    else { state.yaw += dx * k; state.pitch = clamp(state.pitch + dy * k, -1.5, 1.55); turnTo = null; }
  } else if (drag.moved > 8) {
    // a drag that starts on the crown winds it and sets the time. On the face (the chart or the orrery) sideways
    // orbits and up and down zooms, on into the orrery on the back; anywhere else the camera orbits both ways
    if (!drag.kind) {
      drag.kind = onCrown(drag.x0, drag.y0) ? 'crown' : onDial(drag.x0, drag.y0) ? 'face' : 'orbit';
      view.pivot = drag.kind === 'face' && dive.v === 0 ? pointOn(drag.x0, drag.y0) : null;
    }
    if (drag.kind === 'orbit') { orbitBy(dx, dy); return; }
    if (drag.kind === 'face') { rollBy(dx); zoomTo(zoomNow() * Math.exp(-dy * 3 / innerHeight)); return; }
    // winding: a drag along the crown's turn, up or down the screen; a drag the height of the screen is twelve hours
    const dh = -dy / innerHeight * 12 * 3600e3;
    state.offsetMs += dh; watch.crown.rotation.x += -dy * 0.03;
  }
});
const up = (e) => {
  pointers.delete(e.pointerId); if (pointers.size < 2) pinch0 = null;
  if (drag && drag.moved < 8 && performance.now() - drag.t < 500) pick(e.clientX, e.clientY);
  if (drag && drag.kind === 'orbit' && pointers.size === 0) { view.spin = true; view.vr = 0; if (performance.now() - (drag.tm || 0) > 80) view.vy = view.vp = 0; }
  if (drag && drag.kind === 'face' && pointers.size === 0) { view.spin = true; view.vy = view.vp = 0; if (performance.now() - (drag.tr || 0) > 80) view.vr = 0; }
  if (drag && drag.moved < 8 && state.mode === 'mini') { const t = performance.now(); if (t - lastTap < 320) { if (onCentreBody(e.clientX, e.clientY)) setCentre(state.centre === 'sun' ? 'earth' : 'sun'); else { view.home = true; view.vy = view.vp = view.vr = 0; } } lastTap = t; }
  if (pinchWas && pointers.size < 2) { pinchWas = false; zoomEnd(); }
  if (drag && drag.kind === 'face' && pointers.size === 0) zoomEnd();
  if (pointers.size === 0) drag = null;
};
cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
cv.addEventListener('wheel', (e) => { e.preventDefault(); if (state.mode === 'sky') state.fov = clamp(state.fov * Math.exp(e.deltaY * 0.0012), 8, 100); else { zoomTo(zoomNow() * Math.exp(-(e.deltaY || e.deltaX) * 0.006)); clearTimeout(wheelEnd); wheelEnd = setTimeout(zoomEnd, 260); } }, { passive: false });

// ------------------------------------------------------------------ picking, the card, the arrow
let turnTo = null;
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), pv = new THREE.Vector3();
function pick(x, y) {
  let best = null;
  if (state.mode === 'mini') {
    ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, wCam);
    if (ray.intersectObject(watch.pusher, true).length) { pushButton(); return; }
    watch.pusher.getWorldPosition(pv).project(wCam);
    if (Math.hypot((pv.x * 0.5 + 0.5) * innerWidth - x, (-pv.y * 0.5 + 0.5) * innerHeight - y) < 30) { pushButton(); return; }
    const orr = watch.face === 'orrery', J = orr ? watch.orrery.bodies : watch.jewels;
    const objs = []; for (const b of BODIES) { objs.push(J[b.key].mesh); if (!orr) objs.push(watch.markers[b.key].mesh); }
    const hit = ray.intersectObjects(objs, true)[0];
    if (hit) { let o = hit.object; while (o && !o.userData.key) o = o.parent; best = o && o.userData.key; }
    if (!best) { // near misses: the nearest jewel within 26 px
      let bd = 26;
      for (const b of BODIES) { const m = J[b.key].mesh; if (!m.visible) continue; m.getWorldPosition(pv).project(wCam); const d = Math.hypot((pv.x * 0.5 + 0.5) * innerWidth - x, (-pv.y * 0.5 + 0.5) * innerHeight - y); if (d < bd) { bd = d; best = b.key; } }
    }
  } else {
    let bd = 1e9;
    for (const b of BODIES) {
      const o = planets.bodies[b.key]; pv.copy(o.node.position).project(skyCam); if (pv.z > 1) continue;
      const rPx = Math.atan(o.R / o.D) * pxPerRad(), d = Math.hypot((pv.x * 0.5 + 0.5) * innerWidth - x, (-pv.y * 0.5 + 0.5) * innerHeight - y);
      if (d < Math.max(28, rPx * 1.2) && d < bd) { bd = d; best = b.key; }
    }
  }
  if (best) { select(best, state.mode === 'sky'); } else hideCard();
}
function select(key, turn) {
  state.selected = key; showCard();
  if (turn && !(state.motion && gyro.have)) { const s = sky.bodies[key]; turnTo = { yaw: Math.atan2(-s.dir.x, -s.dir.z), pitch: Math.asin(s.dir.y) }; }
}
const fmtT = (d) => d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';
const fmtA = (a) => `${a.toFixed(1)}°`;
const compass16 = (a) => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(a / 22.5) % 16];
function showCard() {
  const key = state.selected; if (!key) return;
  const d = sky.details(key);
  const dist = key === 'Moon' ? `${Math.round(d.dist * 149597870.7).toLocaleString()} km` : `${d.dist.toFixed(d.dist < 2 ? 3 : 2)} AU`;
  const lt = d.dist * 499.005, ltS = lt < 120 ? `${lt.toFixed(1)} s` : lt < 7200 ? `${(lt / 60).toFixed(1)} min` : `${(lt / 3600).toFixed(2)} h`;
  const size = d.diam * 3600, sizeS = size > 120 ? `${(size / 60).toFixed(1)}′` : `${size.toFixed(1)}″`;
  const point = d.alt > 0 ? `Face ${Math.round(d.az)}° ${compass16(d.az)}, look up ${Math.round(d.alt)}°` : `Below the horizon, ${Math.round(-d.alt)}° under ${compass16(d.az)}`;
  const rows = [['in', d.constellation || '—'], ['RA · Dec', `${Math.floor(d.ra)}h${String(Math.floor((d.ra % 1) * 60)).padStart(2, '0')}m · ${d.dec >= 0 ? '+' : ''}${d.dec.toFixed(1)}°`],
    ['distance', `${dist} · ${ltS}`], ['apparent size', sizeS], ['magnitude', d.mag != null ? d.mag.toFixed(1) : '—']];
  if (d.frac != null) rows.push(['lit', `${Math.round(d.frac * 100)}%` + (key === 'Moon' ? ` · ${moonPhaseName(d.phaseDeg)}` : '')]);
  rows.push(['rises', fmtT(d.rise)], ['highest', d.transit ? `${fmtT(d.transit)} · ${fmtA(d.transitAlt)}` : '—'], ['sets', fmtT(d.set)]);
  $('cardBody').innerHTML = `<h2>${d.name.toUpperCase()}</h2><div class="point">${point}</div><table>${rows.map(([k, v]) => `<tr><td class="k">${k}</td><td>${v}</td></tr>`).join('')}</table>`;
  $('card').classList.add('show');
}
function hideCard() { state.selected = null; $('card').classList.remove('show'); $('arrow').classList.remove('show'); }
$('card').querySelector('button').onclick = hideCard;
const pxPerRad = () => innerHeight / (2 * Math.tan(skyCam.fov * D2R / 2));
function updateArrow() {
  const el = $('arrow');
  if (state.mode !== 'sky' || !state.selected) { el.classList.remove('show'); return; }
  const o = planets.bodies[state.selected];
  pv.copy(o.node.position).applyMatrix4(skyCam.matrixWorldInverse);
  const behind = pv.z > 0;
  const p = pv.clone().applyMatrix4(skyCam.projectionMatrix);
  let x = p.x, y = p.y; if (behind) { x = -x; y = -y; }
  const on = !behind && Math.abs(x) < 0.92 && Math.abs(y) < 0.92;
  if (on) { el.classList.remove('show'); return; }
  const a = Math.atan2(y * innerHeight, x * innerWidth), m = 34;
  const hx = innerWidth / 2 - m, hy = innerHeight / 2 - m - 50, k = Math.min(hx / Math.max(1e-6, Math.abs(Math.cos(a))), hy / Math.max(1e-6, Math.abs(Math.sin(a))));
  el.style.transform = `translate(${innerWidth / 2 + Math.cos(a) * k}px, ${innerHeight / 2 - 25 - Math.sin(a) * k}px)`;
  el.querySelector('svg').style.transform = `rotate(${90 - a / D2R}deg)`;
  el.querySelector('span').textContent = sky.bodies[state.selected].name;
  el.classList.add('show');
}

// ------------------------------------------------------------------ buttons and keys
let hintTimer = 0;
function hint(t, ms = 4200) { const h = $('hint'); h.textContent = t; h.classList.add('show'); clearTimeout(hintTimer); hintTimer = setTimeout(() => h.classList.remove('show'), ms); }
const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>', PAUSE = '<svg viewBox="0 0 24 24"><path d="M8 5v14M16 5v14" stroke-width="3"/></svg>';
function refreshSpeed() { $('play').innerHTML = state.paused ? PLAY : PAUSE; $('speed').textContent = state.paused ? 'paused' : speedLabel(state.speed); }
const setSpeed = (s) => { state.speed = s; state.paused = false; refreshSpeed(); };
const stepSpeed = (d) => { const i = SPEEDS.indexOf(state.speed); setSpeed(SPEEDS[clamp((i < 0 ? 7 : i) + d, 0, SPEEDS.length - 1)]); };
$('now').onclick = () => { state.offsetMs = 0; setSpeed(1); };
$('faster').onclick = () => stepSpeed(1); $('slower').onclick = () => stepSpeed(-1);
$('play').onclick = () => { state.paused = !state.paused; refreshSpeed(); };
for (const b of document.querySelectorAll('#units button')) b.onclick = () => { state.unit = b.dataset.u; for (const o of document.querySelectorAll('#units button')) o.classList.toggle('on', o === b); };
document.querySelector('#units button[data-u="h"]').classList.add('on');
$('when').onclick = () => {
  const p = $('pick'), d = simDate(), z = (n) => String(n).padStart(2, '0');
  p.value = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
  try { p.showPicker(); } catch (e) { p.focus(); p.click(); }
};
$('pick').onchange = () => { const t = new Date($('pick').value).getTime(); if (Number.isFinite(t)) { state.offsetMs = t - Date.now(); state.paused = true; refreshSpeed(); } };
function applyMode(m) { state.mode = m; document.body.classList.toggle('mini', m === 'mini'); for (const b of document.querySelectorAll('#mode button')) b.classList.toggle('on', b.dataset.mode === m); $('arrow').classList.remove('show'); if (state.motion) flipChart(m === 'mini' ? -1 : watch.chart.m); }
// the end of a dive: hand over to the sky view, which the last frames of the dive already show
const diveLanded = () => { afterRender = () => { applyMode('sky'); skyCam.fov = state.fov; xfDive = false; crossfade(250); }; };
function setMode(m, instant) {
  if (m === state.mode && !instant) return;
  if (!instant && dive.t < 1) return;
  const go = () => applyMode(m);
  if (instant) { go(); return; }
  if (watch.face === 'orrery' && turn.t >= 1) {
    // the orrery on the wrist is the one you stand in: the machine gathers round Earth, you fall onto your own
    // place, and the sky opens round you. Each end of the dive is cross-faded with the sky view, which matches it
    if (m === 'sky') {
      if (state.selected && !(state.motion && gyro.have)) { const s = sky.bodies[state.selected]; state.yaw = Math.atan2(-s.dir.x, -s.dir.z); state.pitch = clamp(Math.asin(s.dir.y), -0.6, 1.2); }
      turnTo = null;
      runDive(1, 5.2, diveLanded);
    } else {
      afterRender = () => { go(); dive = { v: 1, from: 1, to: 1, t: 1, dur: 1, done: null }; runDive(0, 4.6); };
    }
    return;
  }
  // from the front: turn the watch over to the orrery first, then dive in as from the back
  if (m === 'sky' && state.mode === 'mini' && turn.t >= 1) { diveAfterTurn = true; view.home = true; setFace('orrery'); return; }
  $('fade').classList.add('on'); setTimeout(() => { go(); setTimeout(() => $('fade').classList.remove('on'), 60); }, 360);
}
let diveAfterTurn = false;
for (const b of document.querySelectorAll('#mode button')) b.onclick = () => setMode(b.dataset.mode);
function setFace(f, quiet) {
  if (dive.v > 0 || dive.t < 1) return;
  state.face = f; localStorage.setItem('orrery-face', f);
  // the head turns in its cradle until that side faces you, however you hold the watch
  const to = f === 'orrery' ? Math.PI : 0;
  if (quiet) { turn = { v: to, from: to, to, t: 1 }; watch.turn = to; watch.setFace(f); } else turn = { v: turn.v, from: turn.v, to, t: 0 };
  if (!quiet) hint(f === 'orrery' ? 'The back: an orrery under the caseback, each arm pointing where its body is. Pinch or scroll to fly in and stand on Earth inside it' : 'The front: the sky chart', 3200);
}
let pushAt = -1;
function pushButton() { if (dive.v > 0 || dive.t < 1 || turn.t < 1) return; pushAt = performance.now(); setFace(watch.face === 'orrery' ? 'chart' : 'orrery'); }
function setCentre(c, quiet) {
  if (!quiet && (dive.v > 0 || dive.t < 1)) return;
  state.centre = c; localStorage.setItem('orrery-centre', c);
  $('centre').classList.toggle('on', c === 'sun'); $('centre').title = c === 'sun' ? 'Sun at the centre (c)' : 'Earth at the centre (c)';
  if (!quiet) { if (state.face !== 'orrery') setFace('orrery'); hint(c === 'sun' ? 'The Sun at the centre, the planets at their true heliocentric places' : 'Earth at the centre, every body in its true direction from you', 1800); }
}
$('centre').onclick = () => setCentre(state.centre === 'sun' ? 'earth' : 'sun');
setCentre(state.centre, true);
$('motion').onclick = () => setMotion(!state.motion);
const labelNames = ['Names off', 'Sun, Moon and planets', 'Planets, bright stars and constellations'];
$('labels').onclick = () => { state.labels = (state.labels + 1) % 3; $('labels').classList.toggle('on', state.labels > 0); hint(labelNames[state.labels], 1600); };
$('labels').classList.toggle('on', state.labels > 0);
$('magnify').onclick = () => { state.magnify = state.magnify ? 0 : 1; $('magnify').classList.toggle('on', !!state.magnify); hint(state.magnify ? 'Planets brought 1000× closer, the Sun and Moon a few times' : 'True sizes', 1800); };
$('magnify').classList.toggle('on', !!state.magnify);
$('locate').onclick = () => { hint('Finding you…'); locate(true); };
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key;
  if (k === 'm') setMode(state.mode === 'mini' ? 'sky' : 'mini'); else if (k === 'l') $('labels').click(); else if (k === 'n') $('now').click(); else if (k === 'g') $('motion').click();
  else if (k === 'z') $('magnify').click(); else if (k === ' ') { e.preventDefault(); $('play').click(); } else if (k === ']') stepSpeed(1); else if (k === '[') stepSpeed(-1);
  else if (k === 'h') document.body.classList.toggle('calm'); else if (k === 'o') pushButton(); else if (k === 'c') $('centre').click();
  else if (k === 'ArrowRight') state.offsetMs += (e.shiftKey ? 86400e3 : 3600e3); else if (k === 'ArrowLeft') state.offsetMs -= (e.shiftKey ? 86400e3 : 3600e3);
  else if (k === 'Escape') hideCard();
});
refreshSpeed();
{ const f = document.createElement('div'); f.id = 'fade'; document.body.appendChild(f); }
// the cross-fade between the dive and the sky view: a copy of the last frame, faded out over the new one
let xfDive = false;
const xf = document.createElement('canvas'); xf.id = 'xfade'; $('gl').after(xf);
function snapshot() {
  const c = renderer.domElement; xf.width = c.width; xf.height = c.height;
  xf.getContext('2d').drawImage(c, 0, 0);
  xf.style.transition = 'none'; xf.style.opacity = 1;
}
function crossfade(ms = 1100) { void xf.offsetWidth; requestAnimationFrame(() => requestAnimationFrame(() => { xf.style.transition = `opacity ${ms}ms ease-in-out`; xf.style.opacity = 0; })); }
setMode(state.mode, true);
setFace(state.face === 'orrery' ? 'orrery' : 'chart', true);

// ------------------------------------------------------------------ the time tape: drag it like film through a gate
const UNITS = { h: { notch: 10 * 60e3, major: 6, px: 12 }, d: { notch: 3600e3, major: 6, px: 10 }, m: { notch: 86400e3, major: 7, px: 9 }, y: { notch: 30.436875 * 86400e3, major: 3, px: 14 } };
const tape = $('tape'), tg = tape.getContext('2d');
let tapeDrag = null, fling = 0;
tape.addEventListener('pointerdown', (e) => { tape.setPointerCapture(e.pointerId); tapeDrag = { x: e.clientX, t: performance.now(), v: 0 }; fling = 0; });
tape.addEventListener('pointermove', (e) => {
  if (!tapeDrag) return;
  const dx = e.clientX - tapeDrag.x, now = performance.now(), u = UNITS[state.unit];
  tapeDrag.x = e.clientX; const dt = -dx / u.px * u.notch; state.offsetMs += dt;
  tapeDrag.v = dt / Math.max(1, now - tapeDrag.t) * 16; tapeDrag.t = now;
});
const tapeUp = () => { if (tapeDrag && performance.now() - tapeDrag.t < 80) fling = tapeDrag.v; tapeDrag = null; };
tape.addEventListener('pointerup', tapeUp); tape.addEventListener('pointercancel', tapeUp);
function drawTape(date) {
  const w = tape.clientWidth, h = tape.clientHeight, dp = Math.min(2, devicePixelRatio || 1);
  if (tape.width !== Math.round(w * dp)) { tape.width = Math.round(w * dp); tape.height = Math.round(h * dp); }
  tg.setTransform(dp, 0, 0, dp, 0, 0); tg.clearRect(0, 0, w, h);
  const u = UNITS[state.unit], t = date.getTime(), cx = w / 2;
  // ticks in local time
  const tzOff = date.getTimezoneOffset() * 60e3;
  let base = Math.floor((t - tzOff) / u.notch) * u.notch + tzOff;
  if (state.unit === 'y') { const d = new Date(date); d.setDate(1); d.setHours(0, 0, 0, 0); base = d.getTime(); }
  const n = Math.ceil(cx / u.px) + 2;
  tg.font = '10.5px Georgia, serif'; tg.textAlign = 'center'; tg.textBaseline = 'top';
  for (let i = -n; i <= n; i++) {
    let ti; if (state.unit === 'y') { const d = new Date(base); d.setMonth(d.getMonth() + i); ti = d.getTime(); } else ti = base + i * u.notch;
    const x = cx + (ti - t) / u.notch * u.px;
    if (x < -40 || x > w + 40) continue;
    const d = new Date(ti);
    const major = state.unit === 'h' ? d.getMinutes() === 0 : state.unit === 'd' ? d.getHours() % 6 === 0 : state.unit === 'm' ? d.getDay() === 1 : d.getMonth() % 3 === 0;
    const big = state.unit === 'h' ? d.getMinutes() === 0 && d.getHours() % 3 === 0 : state.unit === 'd' ? d.getHours() === 0 : state.unit === 'm' ? d.getDate() === 1 : d.getMonth() === 0;
    const fade = 1 - Math.min(1, Math.abs(x - cx) / cx) ** 2;
    tg.globalAlpha = 0.25 + 0.65 * fade; tg.fillStyle = '#e9cf93';
    const L = big ? 12 : major ? 8 : 4;
    tg.fillRect(x - 0.5, 2, big ? 1.5 : 1, L);
    if (major || big) {
      let s;
      if (state.unit === 'h') s = `${String(d.getHours()).padStart(2, '0')}:00`;
      else if (state.unit === 'd') s = d.getHours() === 0 ? d.toLocaleDateString([], { weekday: 'short', day: 'numeric' }) : `${d.getHours()}h`;
      else if (state.unit === 'm') s = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      else s = d.getMonth() === 0 ? String(d.getFullYear()) : d.toLocaleDateString([], { month: 'short' });
      if (!(state.unit === 'h' && !big && u.px < 14)) tg.fillText(s, x, 17);
    }
  }
  tg.globalAlpha = 1;
  // the gate
  tg.fillStyle = '#ffdc8a'; tg.beginPath(); tg.moveTo(cx - 5, 0); tg.lineTo(cx + 5, 0); tg.lineTo(cx, 7); tg.closePath(); tg.fill(); tg.fillRect(cx - 0.75, 0, 1.5, h - 4);
  const fadeG = tg.createLinearGradient(0, 0, w, 0); fadeG.addColorStop(0, 'rgba(10,14,30,1)'); fadeG.addColorStop(0.12, 'rgba(10,14,30,0)'); fadeG.addColorStop(0.88, 'rgba(10,14,30,0)'); fadeG.addColorStop(1, 'rgba(10,14,30,1)');
  tg.globalCompositeOperation = 'destination-out'; tg.fillStyle = fadeG; tg.fillRect(0, 0, w, h); tg.globalCompositeOperation = 'source-over';
}

// ------------------------------------------------------------------ HUD
const pad = (n) => String(n).padStart(2, '0');
function hud(date) {
  $('clock').textContent = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  $('date').textContent = date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const off = state.offsetMs, ahead = Math.abs(off) > 90e3;
  $('now').classList.toggle('on', !ahead && state.speed === 1 && !state.paused);
  $('place').textContent = placeLine();
  const sun = sky.bodies.Sun, moon = sky.bodies.Moon, lst = sky.lst;
  $('info').innerHTML = `Sun ${sun.alt.toFixed(0)}° · ${moonPhaseName(window.Astronomy.MoonPhase(sky.time))} ${Math.round(moon.frac * 100)}%<br>sidereal ${pad(Math.floor(lst))}:${pad(Math.floor((lst % 1) * 60))}` + (ahead ? ` · <b style="color:#ffd27d;font-weight:400">${off > 0 ? '+' : '−'}${fmtOffset(Math.abs(off))}</b>` : '');
  $('heading').textContent = state.motion && gyro.have ? `facing ${Math.round(heading)}° ${compass16(heading)}` : '';
}
function fmtOffset(ms) { const m = ms / 60000; if (m < 60) return `${Math.round(m)} min`; const h = m / 60; if (h < 48) return `${h.toFixed(1)} h`; const d = h / 24; if (d < 60) return `${d.toFixed(1)} days`; return `${(d / 365.25).toFixed(2)} yr`; }

// ------------------------------------------------------------------ frame
const qIn = new THREE.Quaternion(), vUp = new THREE.Vector3(), vFw = new THREE.Vector3();
let heading = 0, compassA = 0, tilt = { x: 0, y: 0 }, restB = null, restG = null;
let last = performance.now(), hudAt = 0, frames = 0, msAcc = 0, prAt = performance.now();
const shortAngle = (a) => ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
function frame(now = performance.now()) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!state.paused) state.offsetMs += dt * 1000 * (state.speed - 1); else state.offsetMs -= dt * 1000;
  if (!tapeDrag && Math.abs(fling) > 1000) { state.offsetMs += fling * dt * 60; fling *= Math.pow(0.04, dt); }
  const date = simDate();
  sky.update(date, state.lat, state.lon);
  if (dive.t < 1) { dive.t = Math.min(1, dive.t + dt / dive.dur); dive.v = dive.from + (dive.to - dive.from) * easeIO(dive.t); if (dive.t >= 1 && dive.done) { const d = dive.done; dive.done = null; d(); } }

  // orientation of the phone, when motion is on
  if (state.motion && gyro.have) {
    gyroQuat(qIn);
    vUp.set(0, 1, 0).applyQuaternion(qIn); vFw.set(0, 0, -1).applyQuaternion(qIn);
    const wu = 1 - Math.abs(vUp.y), hx = vUp.x * wu + vFw.x * (1 - wu), hz = vUp.z * wu + vFw.z * (1 - wu);
    heading = (Math.atan2(hx, -hz) / D2R + 360) % 360;
    if (restB == null) { restB = gyro.beta; restG = gyro.gamma; }
    restB += (gyro.beta - restB) * Math.min(1, dt * 0.6); restG += (gyro.gamma - restG) * Math.min(1, dt * 0.6);
  }

  if (turn.t < 1) { turn.t = Math.min(1, turn.t + dt / 1.3); turn.v = turn.from + (turn.to - turn.from) * easeIO(turn.t); }
  else if (diveAfterTurn) { diveAfterTurn = false; if (state.mode === 'mini' && watch.face === 'orrery') setMode('sky'); }
  // the view coasts after a flick, and a double tap brings it home
  if (view.home) { const e = Math.min(1, dt * 5); view.pivot = null; view.yaw += -view.yaw * e; view.pitch += -view.pitch * e; view.roll += -view.roll * e; view.tg.multiplyScalar(1 - e); if (Math.abs(view.yaw) + Math.abs(view.pitch) + Math.abs(view.roll) + view.tg.length() < 0.002) { view.yaw = view.pitch = view.roll = 0; view.tg.set(0, 0, 0); view.home = false; } }
  else if (view.spin && Math.abs(view.vr) > 0.01) { turnRoll(view.vr * dt); view.vr *= Math.pow(0.06, dt); }
  else if (view.spin && (Math.abs(view.vy) > 0.01 || Math.abs(view.vp) > 0.01)) {
    setYaw(view.yaw + view.vy * dt); if (Math.abs(view.yaw) === YAW_MAX) view.vy = 0;
    view.pitch = clamp(view.pitch + view.vp * dt, -PITCH_MAX, PITCH_MAX); const f = Math.pow(0.06, dt); view.vy *= f; view.vp *= f;
  }
  watch.turn = turn.v; watch.setFace(Math.cos(watch.turn) < 0 ? 'orrery' : 'chart');
  if (watch.face !== state.face && turn.t >= 1) { state.face = watch.face; localStorage.setItem('orrery-face', state.face); }
  if (pushAt >= 0) { const k = (now - pushAt) / 220; watch.pusherPress.position.y = watch.pusherY - 0.022 * Math.sin(Math.PI * Math.min(1, k)); if (k >= 1) pushAt = -1; }
  helio += ((state.centre === 'sun' ? 1 : 0) - helio) * Math.min(1, dt * 1.6); if (Math.abs(helio - (state.centre === 'sun' ? 1 : 0)) < 0.002) helio = state.centre === 'sun' ? 1 : 0;
  if (state.mode === 'sky') frameSky(dt, date); else frameWatch(dt, date);
  if (afterRender) { const f = afterRender; afterRender = null; f(); }

  if (now - hudAt > 250) { hud(date); hudAt = now; if (state.selected && (state.speed !== 1 || state.paused || tapeDrag)) showCard(); }
  drawTape(date);
  // adaptive resolution: hold about 50 fps
  frames++; msAcc += dt * 1000;
  if (!Q.has('pr') && now - prAt > 2000 && frames > 20) {
    const avg = msAcc / frames, next = avg > 22 ? Math.max(0.6, pr - 0.15) : avg < 13 ? Math.min(maxPR, pr + 0.1) : pr;
    if (Math.abs(next - pr) > 0.01) { pr = next; renderer.setPixelRatio(pr); }
    frames = 0; msAcc = 0; prAt = now;
  }
}

function frameSky(dt, date, over = null) {
  skyParts.group.matrix.copy(sky.M); skyParts.group.matrixWorldNeedsUpdate = true;
  const sAlt = sky.bodies.Sun.alt;
  U.sun.value.copy(sky.sunDir);
  U.day.value = THREE.MathUtils.smoothstep(sAlt, -7, 8);
  U.twi.value = Math.exp(-(((sAlt + 2.5) / 7.5) ** 2));
  renderer.toneMappingExposure = THREE.MathUtils.lerp(1.15, 0.85, U.day.value);
  if (over) skyCam.quaternion.copy(over.quat);
  else if (state.motion && gyro.have) skyCam.quaternion.copy(qIn);
  else {
    if (turnTo) {
      const dy = shortAngle(turnTo.yaw - state.yaw);
      state.yaw += dy * Math.min(1, dt * 3); state.pitch += (turnTo.pitch - state.pitch) * Math.min(1, dt * 3);
      if (Math.abs(dy) < 0.002 && Math.abs(turnTo.pitch - state.pitch) < 0.002) turnTo = null;
    }
    euler.set(state.pitch, state.yaw, 0, 'YXZ'); skyCam.quaternion.setFromEuler(euler);
  }
  if (over) skyCam.fov = over.fov; else skyCam.fov += (state.fov - skyCam.fov) * Math.min(1, dt * 10); skyCam.aspect = innerWidth / innerHeight; skyCam.updateProjectionMatrix();
  skyCam.updateMatrixWorld();
  const ppr = pxPerRad(), k = 1 / ppr; // world units per CSS pixel at unit depth
  U.px.value = k / pr; U.dpr.value = pr;
  state.mag += (state.magnify - state.mag) * Math.min(1, dt * 2.5);
  updatePlanets(planets, sky, skyCam, state.mag, ppr, state.labels >= 1);
  const label = (l) => l.scale.set(l.userData.px * l.userData.aspect * k, l.userData.px * k, 1);
  for (const b of BODIES) label(planets.bodies[b.key].label);
  for (const l of horizon.userData.labels) label(l);
  const all = state.labels >= 2;
  for (const l of skyParts.labels.cons) { l.visible = all; if (all) { label(l); l.material.opacity = 0.7 * (1 - U.day.value * 0.85); } }
  for (const l of skyParts.labels.stars) { l.visible = all; if (all) label(l); }
  updateArrow();
  skyPipe.render();
}

let cardLift = 0;
const sst = THREE.MathUtils.smoothstep;
const dL0 = new THREE.Vector3(), dB0 = new THREE.Vector3(), dDir = new THREE.Vector3(), dEye = new THREE.Vector3(), dF = new THREE.Vector3(), dFt = new THREE.Vector3(), dFo = new THREE.Vector3(), dUpv = new THREE.Vector3(), dQv = new THREE.Quaternion(), dQi = new THREE.Quaternion(), dM = new THREE.Matrix4();
const dP0 = new THREE.Vector3(), dPin = new THREE.Vector3(), dC = new THREE.Vector3(), dUp = new THREE.Vector3(), dQ0 = new THREE.Quaternion(), dQ = new THREE.Quaternion(), dQs = new THREE.Quaternion();
function frameWatch(dt, date) {
  renderer.toneMappingExposure = 1.0;
  // fit the watch (case, lugs and crown) to the screen, a little above the time bar
  const asp = innerWidth / innerHeight, t = Math.tan(wCam.fov * D2R / 2);
  let dist = Math.max(1.36 / t, 1.3 / (t * asp)) / state.wzoom;
  // on a tall screen an open card would cover the dial: shrink the watch into the space above it
  const card = $("card"), wantLift = card.classList.contains('show') && asp < 0.8 && dive.v === 0 ? 1 : 0;
  cardLift = Q.has('shot') ? wantLift : cardLift + (wantLift - cardLift) * Math.min(1, dt * 6);
  let lift = 0;
  if (cardLift > 0.001) {
    const top = card.getBoundingClientRect().top, room = Math.max(160, top - 110);
    const d2 = Math.max(dist, 1.25 * innerHeight / (room * t));
    const c = (110 + top) / 2; // the centre of the room left, in px
    lift = cardLift * (c - innerHeight / 2) * (2 * d2 * t / innerHeight);
    dist += (d2 - dist) * cardLift;
  }
  // turning over, the watch is held a little further off so its edge clears
  dist *= 1 + 0.05 * Math.sin(Math.PI * Math.min(1, Math.abs(turn.v - turn.from) / Math.PI));
  wCam.aspect = asp; wCam.fov = 26; wCam.near = 0.5; wCam.far = 40; lookY = -0.06 + lift; const T = view.tg;
  // as you zoom in the camera sinks toward six o'clock, so the watch lies back like one on a table you lean over
  const zt = sst(state.wzoom, 1, ZMAX), pe = clamp(view.pitch - 0.5 * zt, -1.25, PITCH_MAX);
  { const cp = Math.cos(pe); qRoll.setFromAxisAngle(Z_AXIS, view.roll);
    pv.set(dist * Math.sin(view.yaw) * cp, -0.08 * cp + dist * Math.sin(pe), dist * Math.cos(view.yaw) * cp).applyQuaternion(qRoll);
    wCam.position.set(T.x + pv.x, T.y + lookY + pv.y, T.z + pv.z); wCam.up.set(0, 1, 0).applyQuaternion(qRoll); }
  wCam.lookAt(T.x, T.y + lookY, T.z);
  // tilt with the phone (or the pointer), so the light runs over the gold
  let tx, ty;
  if (state.motion && gyro.have) { tx = clamp(gyro.gamma - restG, -0.5, 0.5) * 0.5; ty = clamp(gyro.beta - restB, -0.5, 0.5) * 0.5; }
  else if (!isTouch) { tx = hover.x * 0.12; ty = hover.y * 0.1; } else { tx = Math.sin(performance.now() / 4000) * 0.04; ty = Math.cos(performance.now() / 5300) * 0.03; }
  tilt.x += (tx - tilt.x) * Math.min(1, dt * 4); tilt.y += (ty - tilt.y) * Math.min(1, dt * 4);
  watch.root.rotation.set(tilt.y * (1 - dive.v), tilt.x * (1 - dive.v), 0); watch.head.rotation.y = turn.v;
  // compass: in ground view the sky assembly turns so its directions are the real ones
  let want = 0;
  if (state.motion && gyro.have && watch.chart.m < 0) want = (180 + heading - (state.lat >= 0 ? 180 : 0)) * D2R;
  compassA += shortAngle(want - compassA) * Math.min(1, dt * 6);
  // the chart turning over
  if (flip) {
    flip.t += dt / 0.7; const c = Math.cos(Math.min(1, flip.t) * Math.PI);
    if (!flip.swapped && flip.t >= 0.5) { watch.setChart(state.lat, flip.to, placeLine()); flip.swapped = true; }
    watch.skyRot.scale.x = Math.max(0.02, Math.abs(c));
    if (flip.t >= 1) { watch.skyRot.scale.x = 1; flip = null; }
  }
  // the dive, as functions of its progress u: approach Earth, swing round to above your place, land on the pin and
  // look up. Distances run on a log scale so the zoom feels steady. As you land, Earth shrinks under you and sinks
  // so that your eye ends at the orrery's centre, where every globe is in its true direction at its sky-view size
  const u = watch.face === 'orrery' ? dive.v : 0;
  const a = sst(u, 0, 0.45), b = sst(u, 0.22, 0.68), c = sst(u, 0.5, 1), p = sst(u, 0.5, 0.9), cs = sst(u, 0.8, 1), skyIn = sst(u, 0.5, 0.86);
  const eS = Math.exp(Math.log(0.01) * c), K_END = 1.008;
  const lnk = (l0) => THREE.MathUtils.lerp(THREE.MathUtils.lerp(l0, Math.log(3.0), a), Math.log(K_END), c);
  const kNow = Math.exp(lnk(Math.log(Math.max(4, dP0.copy(wCam.position).length() / EARTH_R))));
  updateWatch(watch, sky, date, { labels: state.labels, selected: state.selected, compassAngle: compassA, earthScale: eS, showLabels: u < 0.02, dive: u, magnify: state.mag,
    helio: helio * (1 - sst(u, 0, 0.3)), sink: EARTH_R * eS * kNow * cs, pinScale: 1 - sst(u, 0.38, 0.55) });
  if (u > 0) {
    watch.root.updateMatrixWorld(true);
    pinWorld(watch.orrery, dPin, dC); dUp.copy(dPin).sub(dC).normalize(); // Earth's centre (sunk), and your zenith
    if (state.motion && gyro.have) dQs.copy(qIn); else dQs.setFromEuler(euler.set(state.pitch, state.yaw, 0, 'YXZ'));
    skyToWatch(watch.orrery, sky, dQ).multiply(dQs);
    // the start: the camera on the wrist, looking at the dial
    dP0.copy(wCam.position); dL0.set(view.tg.x, view.tg.y + lookY, view.tg.z);
    const r0 = dP0.distanceTo(dC), k = Math.exp(lnk(Math.log(r0 / EARTH_R))), d = EARTH_R * eS * k;
    dB0.copy(dP0).sub(dC).normalize();
    dQv.setFromUnitVectors(dB0, dUp); dQi.identity().slerp(dQv, b); dDir.copy(dB0).applyQuaternion(dQi);
    const eye = dEye.copy(dC).addScaledVector(dDir, d);
    // where you'll look, and its horizontal part at your place, which is the up of the view looking down on the pin
    dF.set(0, 0, -1).applyQuaternion(dQ);
    dFt.copy(dF).addScaledVector(dUp, -dF.dot(dUp));
    if (dFt.lengthSq() < 0.03) { dFt.set(0, 1, 0).applyQuaternion(dQ); dFt.addScaledVector(dUp, -dFt.dot(dUp)); }
    dFt.normalize();
    const focus = dFo.copy(dL0).lerp(dC, sst(u, 0, 0.35));
    const up = dUpv.copy(wCam.up).lerp(dFt, b);
    if (up.lengthSq() < 1e-6) up.copy(dFt);
    dM.lookAt(eye, focus, up.normalize());
    dQ0.setFromRotationMatrix(dM);
    wCam.position.copy(eye);
    wCam.quaternion.copy(dQ0).slerp(dQ, p);
    wCam.fov = THREE.MathUtils.lerp(26, state.fov, sst(u, 0.04, 0.5));
    const h = Math.max(1e-7, d - watch.orrery.earth.r);
    wCam.near = clamp(h * 0.3, 1e-6, 0.5); wCam.far = u > 0.35 ? 3 : 40;
  }
  wCam.updateProjectionMatrix();
  // the real sky comes in behind the last part of the dive, seen through the same camera, so the stars, the
  // horizon and the globes arrive round you while the orrery lines up with them. It is drawn into the layer above
  // the canvas, whose opacity is the blend; at the end that layer is exactly the sky view, so the handoff is seamless
  if (skyIn > 0) {
    skyToWatch(watch.orrery, sky, dQi); dQv.copy(dQi).invert().multiply(wCam.quaternion);
    frameSky(dt, date, { quat: dQv, fov: wCam.fov });
    const cv = renderer.domElement; if (xf.width !== cv.width || xf.height !== cv.height) { xf.width = cv.width; xf.height = cv.height; }
    xf.getContext('2d').drawImage(cv, 0, 0);
    xf.style.transition = 'none'; xf.style.opacity = skyIn; xfDive = true;
    renderer.toneMappingExposure = 1.0;
  } else if (xfDive) { xf.style.opacity = 0; xfDive = false; }
  wPipe.render();
}

addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) last = performance.now(); });

// a dark jeweller's studio for the metals to reflect: a big soft box above, strip lights at the sides, a warm card below
function studio() {
  const sc = new THREE.Scene(); sc.background = new THREE.Color(0x020306);
  const panel = (c, w, h, x, y, z) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicNodeMaterial({ color: c, side: THREE.DoubleSide })); m.position.set(x, y, z); m.lookAt(0, 0, 0); sc.add(m); };
  panel(new THREE.Color(2.2, 2.1, 1.95), 9, 6, -3, 4, 9);
  panel(new THREE.Color(1.3, 1.3, 1.45), 1.4, 12, 9, 0, 3);
  panel(new THREE.Color(0.9, 0.95, 1.2), 1.2, 10, -9, -1, 2);
  panel(new THREE.Color(0.5, 0.36, 0.22), 12, 4, 0, -8, 4);
  panel(new THREE.Color(0.35, 0.4, 0.6), 20, 20, 0, 0, -12);
  panel(new THREE.Color(0.55, 0.52, 0.48), 5, 2.2, 1.5, 2.5, 10);
  return sc;
}

// ------------------------------------------------------------------ start
(async () => {
  try { await renderer.init(); } catch (e) { $('status').textContent = 'Could not start the renderer: ' + e.message; return; }
  const pmrem = new THREE.PMREMGenerator(renderer);
  wScene.environment = pmrem.fromScene(studio(), 0.03).texture;
  wScene.environmentIntensity = 1.0;
  sky.update(simDate(), state.lat, state.lon);
  frame();
  if (!Q.has('shot')) renderer.setAnimationLoop(frame);
  document.body.classList.add('ready');
  window.__orr = { renderer, sky, watch, planets, state, U, skyCam, wCam, select, setMode, setFace, setCentre, runDive, get turn() { return turn; }, get dive() { return dive; }, flipChart, view, zoomTo, zoomEnd, pushButton, onDial, step: (n = 1) => { for (let i = 0; i < n; i++) frame(performance.now()); }, backend: renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2' };
  if (Q.has('select')) select(Q.get('select'), state.mode === 'sky');
  if (!Q.has('lat') && saved.lat == null && !Q.has('shot')) locate(false);
  if (!Q.has('shot')) setTimeout(() => hint(state.mode === 'mini' ? 'Tap a jewel for its card. Drag round the dial to turn time. Turn on the compass to line the chart up with the sky' : 'Drag to look around, or turn on motion and hold the phone up'), 1400);
  if ('serviceWorker' in navigator && !Q.has('shot') && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();

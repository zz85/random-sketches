// main.js - Oxide: close-up landscapes of rust on old turquoise paint, a few centimetres of steel seen as if
// through a macro lens. The field (field.js) makes the relief and materials in TSL compute; surface.js shades
// and raymarches it, adds grains of powder and crumbs and drops of water; this file sets the scene: a low
// raking sun, a dark room to reflect, fog toward the horizon, a camera that glides over the surface like a
// lunar orbiter when you leave it (steady height, slow turns, a gentle bank), depth of field focused where
// you tap, a teal and orange grade, and a render scale that follows the frame rate. Listen (audio.js, plow.js)
// makes the sound a plow that corrodes the steel where the camera goes: its spectrum, smoothed, laid across
// the way the camera moves, the louder bands cutting deeper and baring more rust, with specks of rust dust.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { pass, uniform, vec2, vec3, vec4, float, mix, smoothstep, length, dot, screenUV, screenSize, hash, time, Fn, positionLocal } from 'three/tsl';
import { makeField, PRESETS } from './field.js';
import { makePlow } from './plow.js';
import { makeLook, terrainMesh, grainMesh, dropMesh, FOG, BG as BGRGB } from './surface.js';
import { makeAudio, ROWS } from './audio.js';

const Q = new URLSearchParams(location.search.slice(1) + '&' + location.hash.slice(1));
const $ = (id) => document.getElementById(id);
const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
const state = {
  scene: PRESETS[Q.get('scene')] ? Q.get('scene') : 'tide', seed: +(Q.get('seed') || Math.floor(Math.random() * 1e5)),
  grow: Q.has('grow'), drift: !Q.has('still'), t: 0, listen: false,
};

(async () => {
  if (!navigator.gpu) { $('status').textContent = 'Oxide needs WebGPU: Chrome, Edge, Safari 26 or Firefox 141 and later.'; return; }
  const renderer = new THREE.WebGPURenderer({ canvas: $('gl'), antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, +(Q.get('dpr') || 1))); // the scene pass scales itself to the frame rate below
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  try { await renderer.init(); } catch (e) { $('status').textContent = 'Could not start WebGPU: ' + e.message; return; }
  if (renderer.backend.isWebGLBackend) { $('status').textContent = 'Oxide needs WebGPU: Chrome, Edge, Safari 26 or Firefox 141 and later.'; return; }

  const scene = new THREE.Scene();
  const BG = new THREE.Color(...BGRGB);
  scene.background = BG; scene.fog = new THREE.FogExp2(BG, FOG);
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.002, 40);
  camera.position.set(0.5, 0.55, 0.9);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.07; controls.minDistance = 0.03; controls.maxDistance = 6;
  controls.minPolarAngle = 0.12; controls.maxPolarAngle = 1.53; controls.screenSpacePanning = false; controls.zoomSpeed = 0.7;
  controls.target.set(0, 0.02, 0); controls.update();

  // a dark room to reflect: a soft window high on one side, a faint warm floor
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  const envM = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  const dy = positionLocal.normalize().y;
  envM.colorNode = mix(vec3(0.03, 0.022, 0.018), vec3(0.18, 0.22, 0.24), smoothstep(-0.1, 0.8, dy));
  env.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), envM));
  const box = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.8, 2.6), side: THREE.DoubleSide }));
  box.position.set(-5, 6, 3); box.lookAt(0, 0, 0); env.add(box);
  scene.environment = pmrem.fromScene(env, 0.03).texture;

  const hemi = new THREE.HemisphereLight(0x5c9aa6, 0x3a1e10, 0.5); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffe2c0, 3);
  sun.castShadow = true; const SM = phone ? 1024 : 2048; sun.shadow.mapSize.set(SM, SM);
  Object.assign(sun.shadow.camera, { left: -1.4, right: 1.4, top: 1.4, bottom: -1.4, near: 0.5, far: 14 });
  sun.shadow.bias = -0.00015; sun.shadow.normalBias = 0.0015; sun.shadow.radius = 2;
  scene.add(sun, sun.target);

  // ---- the landscape: raymarched through the field's levels; grains and drops in the field's own XY plane, laid flat
  const N = +(Q.get('res') || (phone ? 512 : 768));
  const field = makeField(N); field.init(renderer);
  const look = makeLook();
  const audio = makeAudio(), plow = makePlow(field, look, phone ? { N: 1024, dust: 5000 } : { N: 2048, dust: 12000 });
  plow.clear(renderer); plow.U.flip.value = Q.get('flip') === '0' ? 0 : 1; // loud rusts, the rest regrows; ?flip=0 swaps them
  const terrain = terrainMesh(field, look, plow);
  scene.add(terrain);
  const group = new THREE.Group(); group.rotation.x = -Math.PI / 2; scene.add(group);
  const grains = grainMesh(field, look, phone ? 30000 : 80000, plow); group.add(grains);
  const drops = dropMesh(field, look, 60, plow); group.add(drops);
  group.add(plow.dust);

  const setScene = () => {
    const p = PRESETS[state.scene];
    field.set(p, state.seed); look.set(p, state.seed);
    plow.clear(renderer);
    state.t = p.t;
    sun.color.setRGB(...p.sunCol); sun.intensity = p.sunI; hemi.intensity = p.fill; scene.environmentIntensity = 0.35 + p.fill * 0.6;
    renderer.toneMappingExposure = p.exposure;
    sunDir.set(...p.sun).normalize();
    drops.visible = !!p.drops;
    $('name').textContent = `${p.name.toLowerCase()}: ${p.note}`;
    $('scene').value = state.scene;
    history.replaceState(null, '', `#scene=${state.scene}&seed=${state.seed}`);
  };
  const sunDir = new THREE.Vector3();

  // ---- post: depth of field on the focus point, then a teal and orange grade, vignette and grain
  const OFF = Q.has('offscreen');
  let off = null;
  if (OFF) {
    const W = innerWidth, H = innerHeight;
    off = { W, H, ldr: new THREE.RenderTarget(W, H) };
    off.c2d = document.createElement('canvas'); off.c2d.width = W; off.c2d.height = H;
    off.c2d.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none'; document.body.insertBefore(off.c2d, renderer.domElement.nextSibling);
  }
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const focus = uniform(1), focalLen = uniform(0.22), bokeh = uniform(phone ? 2.5 : 3.5);
  const blurred = Q.has('nodof') ? scenePass.getTextureNode('output') : dof(scenePass.getTextureNode('output'), scenePass.getViewZNode(), focus, focalLen, bokeh);
  pipeline.outputNode = Fn(() => {
    const c = blurred.rgb;
    const lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    const tone = mix(vec3(0.93, 1.0, 1.04), vec3(1.05, 0.99, 0.92), smoothstep(0.01, 0.35, lum));
    const v = smoothstep(1.25, 0.2, length(screenUV.sub(0.5).mul(vec2(screenSize.x.div(screenSize.y), 1))));
    const px = screenUV.mul(screenSize).floor();
    const n = hash(px.x.add(px.y.mul(4111.0)).add(time.mul(60).floor().mul(7919.0).mod(65536))).sub(0.5).mul(0.012);
    return vec4(c.mul(tone).mul(mix(float(0.45), float(1), v)).add(n), 1);
  })();
  // render scale: the scene (raymarch, grains, depth of field) at a fraction of the canvas, lowered when frames
  // run slow and raised when there is room; the grade and grain are drawn at full size over it
  const rs = { scale: +(Q.get('scale') || 1), fixed: Q.has('scale'), acc: 0, n: 0, dt: 0 };
  scenePass.setResolutionScale(rs.scale);
  const pace = (dt) => {
    if (rs.fixed || !dt) return;
    rs.acc += dt; rs.n++; if (rs.acc < 1) return;
    const avg = rs.acc / rs.n; rs.dt = avg; rs.acc = 0; rs.n = 0;
    const s = avg > 1 / 40 ? rs.scale * 0.85 : avg < 1 / 57 ? rs.scale * 1.08 : rs.scale;
    const c = Math.min(1, Math.max(0.45, s));
    if (Math.abs(c - rs.scale) > 0.01) { rs.scale = c; scenePass.setResolutionScale(c); }
  };
  const draw = () => { renderer.setRenderTarget(OFF ? off.ldr : null); pipeline.render(); renderer.setRenderTarget(null); };
  const snapshot = async () => {
    draw();
    const px = await renderer.readRenderTargetPixelsAsync(off.ldr, 0, 0, off.W, off.H);
    off.c2d.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), off.W, off.H), 0, 0);
  };
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  // ---- where the surface is: the field centres its finest levels between the camera and what it looks at,
  // and reads back the ground under the camera and ahead of it
  const fxy = (v) => new THREE.Vector2(v.x, -v.z);
  const want = new THREE.Vector2();
  const centre = () => {
    const c = fxy(camera.position), g = fxy(controls.target), d = g.clone().sub(c), n = d.length();
    return want.copy(c).addScaledVector(d, n > 3 ? 1.5 / n : 0.5);
  };
  const ground = { under: 0.02, ahead: 0.02, read: [] };
  const probe = async (dir) => {
    const o = fxy(camera.position), d = dir ? new THREE.Vector2(dir.x, -dir.z).normalize().multiplyScalar(0.055) : new THREE.Vector2();
    const r = await field.probe(o, d); if (!r) return;
    ground.read = r; ground.under = r[0]; ground.ahead = Math.max(...r);
  };

  // ---- the orbiter: when you leave the camera alone it glides over the surface at a steady height, slowly
// turning and banking a little into its turns, its height and speed changing over minutes, never quickly.
// It rides the highest ground in the next half centimetre ahead, rising early over a ridge and sinking late
// after it. In Listen its path is the plow's furrow.
  const ship = { x: 0, z: 0, psi: 0, v: 0.1, h: 0.2, pitch: 0.4, roll: 0, fov: 40, gy: 0.02, T: 0, ang: 0, R: 1, tg: new THREE.Vector3(), flying: false };
  const board = () => { // take over from the camera as it is
    const dir = controls.target.clone().sub(camera.position).normalize();
    Object.assign(ship, { x: camera.position.x, z: camera.position.z, psi: Math.atan2(dir.x, dir.z), pitch: Math.min(1.2, Math.max(0.1, Math.asin(-dir.y))), roll: 0,
      h: Math.min(3, camera.position.y - ground.under), v: 0.05, fov: camera.fov, gy: ground.ahead, flying: true });
    ship.tg.copy(controls.target);
  };
  const ease = (dt, r) => 1 - Math.exp(-dt * r);
  const fly = (dt) => {
    const T = (ship.T += dt), e = (r) => ease(dt, r), P = Math.PI * 2;
    ship.gy += (ground.ahead - ship.gy) * e(ground.ahead > ship.gy ? 0.8 : 0.15);
    ship.fov += (44 - ship.fov) * e(0.2);
    ship.h += (0.2 + 0.07 * Math.sin(T * P / 97) + 0.035 * Math.sin(T * P / 41 + 2) - ship.h) * e(0.15);
    ship.v += (0.11 + 0.03 * Math.sin(T * P / 61) - ship.v) * e(0.3);
    ship.pitch += (0.4 + 0.07 * Math.sin(T * P / 53 + 1) - ship.pitch) * e(0.2);
    let w = 0.06 * Math.sin(T * 0.037 + (state.seed % 7)) + 0.035 * Math.sin(T * 0.093 + 1);
    const r = Math.hypot(ship.x, ship.z); // keep within 25 cm of the start, turning home past it
    if (r > 25) { const home = Math.atan2(-ship.x, -ship.z), dpsi = ((home - ship.psi + Math.PI * 3) % P) - Math.PI; w += Math.sign(dpsi) * Math.min(0.12, (r - 25) * 0.05); }
    ship.psi += w * dt;
    ship.roll += (THREE.MathUtils.clamp(-w * 1.2, -0.08, 0.08) - ship.roll) * e(0.5);
    ship.x += Math.sin(ship.psi) * ship.v * dt; ship.z += Math.cos(ship.psi) * ship.v * dt;
    const y = ship.gy + ship.h;
    const dir = new THREE.Vector3(Math.sin(ship.psi) * Math.cos(ship.pitch), -Math.sin(ship.pitch), Math.cos(ship.psi) * Math.cos(ship.pitch));
    const dist = Math.min(4, (ship.h + 0.01) / Math.max(0.05, Math.sin(ship.pitch)));
    return { pos: new THREE.Vector3(ship.x, y, ship.z), target: new THREE.Vector3(ship.x, y, ship.z).addScaledVector(dir, dist), roll: ship.roll, fov: ship.fov };
  };
  let idle = 99, focusGoal = null;
  controls.addEventListener('start', () => { idle = 0; focusGoal = null; ship.flying = false; });

  // tap to focus (and to look) at a point on the surface
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return;
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
    plane.constant = -ground.under; const hit = ray.ray.intersectPlane(plane, new THREE.Vector3()); if (!hit) return;
    focusGoal = hit; idle = 0; ship.flying = false;
  });

  // ---- UI
  for (const [k, p] of Object.entries(PRESETS)) { const o = document.createElement('option'); o.value = k; o.textContent = p.name; $('scene').appendChild(o); }
  const ui = () => { $('grow').classList.toggle('on', state.grow); $('drift').classList.toggle('on', state.drift); $('sound').value = state.listen ? audio.source : 'off'; };
  // Listen: the rings spread from where you are looking when it starts; the camera circles them when idle
  const listen = async (src) => {
    const was = state.listen;
    try { await audio.use(src); } catch (e) { $('hint').textContent = 'No sound: ' + e.message; $('hint').classList.remove('gone'); src = 'off'; await audio.use('off'); }
    state.listen = src !== 'off';
    if (state.listen && !was) { audio.clear(); idle = Math.max(idle, 7); }
    ui();
  };
  $('sound').onchange = () => { const v = $('sound').value; if (v === 'file') $('file').click(); else listen(v); };
  $('file').onchange = () => { const f = $('file').files[0]; if (f) listen(f); else ui(); };
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); const f = [...e.dataTransfer.files].find((f) => f.type.startsWith('audio')); if (f) listen(f); });
  $('scene').onchange = () => { state.scene = $('scene').value; setScene(); };
  $('new').onclick = () => { state.seed = Math.floor(Math.random() * 1e5); setScene(); };
  $('grow').onclick = () => { state.grow = !state.grow; ui(); };
  $('drift').onclick = () => { state.drift = !state.drift; idle = 99; ui(); };
  const save = () => { draw(); renderer.domElement.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `oxide-${state.scene}-${state.seed}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }); };
  $('save').onclick = save;
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase(), ks = Object.keys(PRESETS);
    if (k === 'l') listen(state.listen ? 'off' : 'track'); else if (k === 'n') $('new').click(); else if (k === 'g') $('grow').click(); else if (k === 'd') $('drift').click(); else if (k === 's') save();
    else if (k === 'h') document.body.classList.toggle('calm');
    else if (k === 'p' || k === 'arrowright') { state.scene = ks[(ks.indexOf(state.scene) + 1) % ks.length]; setScene(); }
    else if (k === 'arrowleft') { state.scene = ks[(ks.indexOf(state.scene) + ks.length - 1) % ks.length]; setScene(); }
  });

  // ---- frame
  let last = performance.now(), frame = 0;
  const step = (dt, settle = false) => {
    idle += dt;
    if (state.grow) state.t = Math.min(state.t + dt * 0.006, PRESETS[state.scene].t + 0.6);
    let rolled = 0;
    if (focusGoal) {
      controls.target.lerp(focusGoal, 1 - Math.exp(-dt * 3));
      if (controls.target.distanceTo(focusGoal) < 0.002) focusGoal = null;
      controls.update();
    } else if (state.drift && idle > 8 && dt > 0) {
      if (!ship.flying) board();
      const s = fly(dt);
      camera.position.copy(s.pos); controls.target.copy(s.target); camera.up.set(0, 1, 0); camera.lookAt(s.target); camera.rotateZ(s.roll); rolled = 1;
      if (Math.abs(camera.fov - s.fov) > 0.01) { camera.fov = s.fov; camera.updateProjectionMatrix(); }
    } else controls.update();
    if (!rolled) { // above the ground, whatever you do
      const lo = ground.under + 0.02;
      if (camera.position.y < lo) { camera.position.y = lo; camera.lookAt(controls.target); }
      if (!ship.flying && Math.abs(camera.fov - 40) > 0.01) { camera.fov += (40 - camera.fov) * Math.min(1, dt * 2); camera.updateProjectionMatrix(); }
    }
    audio.update(dt);
    plow.update(renderer, dt, fxy(controls.target), fxy(controls.target.clone().sub(camera.position)), audio.levels, state.listen);
    field.update(state.t, centre(), settle);
    look.centre.value.copy(want);
    if (frame % 4 === 0) probe(ship.flying ? controls.target.clone().sub(camera.position) : null);
    focus.value = camera.position.distanceTo(controls.target);
    focalLen.value = 0.08 + focus.value * 0.28;
    // the sun and its shadow follow what you look at
    sun.target.position.copy(controls.target); sun.position.copy(controls.target).addScaledVector(sunDir, 6);
    frame++;
  };
  const loop = () => {
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
    step(dt); pace(dt); draw(); requestAnimationFrame(loop);
  };

  setScene(); ui();
  if (Q.get('cam')) { const c = Q.get('cam').split(',').map(Number); camera.position.set(c[0], c[1], c[2]); controls.target.set(c[3], c[4], c[5]); idle = 0; controls.update(); }
  step(0, true);
  await probe(); step(0, true);
  $('status').remove(); document.body.classList.add('ready');
  setTimeout(() => $('hint').classList.add('gone'), 7000);

  window.__oxide = {
    state, field, look, camera, controls, snapshot, draw, step, setScene, PRESETS,
    view(c) { camera.position.set(c[0], c[1], c[2]); controls.target.set(c[3], c[4], c[5]); idle = 0; focusGoal = null; ship.flying = false; camera.up.set(0, 1, 0); controls.update(); step(0, true); },
    set(scene, seed) { state.scene = scene; state.seed = seed; setScene(); step(0, true); },
    grow(dt) { state.t = Math.min(state.t + dt, PRESETS[state.scene].t + 0.6); step(0, true); },
    // fly the lander for `secs` at 20 steps a second, reading the ground as it goes
    async fly(secs) { idle = 99; state.drift = true; for (let i = 0; i < secs * 20; i++) { step(0.05); if (i % 4 === 0) await probe(controls.target.clone().sub(camera.position)); } step(0, true); return { ...ship, y: camera.position.y, ground: ground.under }; },
    ground, ship, audio, plow, rs, listen, trail: () => plow.read(renderer),
    // hear `secs` of sound (the test source makes it without audio) at 20 steps a second
    hear(secs) { for (let i = 0; i < secs * 20; i++) step(0.05); step(0, true); },
  };
  if (Q.has('shot')) { step(0); draw(); } else loop();
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !Q.has('shot')) navigator.serviceWorker.register('sw.js').catch(() => {});

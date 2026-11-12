// main.js - Filiform: a coated metal panel on a bench under a raking lamp, kept humid while threads of corrosion
// grow out under its coating. The filaments are simulated on the CPU (sim.js) and drawn from two textures by one
// TSL material (surface.js). Scratch the coating, salt it, turn the humidity up and down, move the lamp.
// three.js r187 WebGPU + TSL.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { pass, uniform, vec2, vec3, vec4, float, mix, smoothstep, length, screenUV, screenSize, hash, time, Fn, positionLocal } from 'three/tsl';
import { makeSim, PIECES, PANEL } from './sim.js';
import { makeLook, surfaceMaterial, benchMaterial } from './surface.js';

const Q = new URLSearchParams(location.search.slice(1) + '&' + location.hash.slice(1));
const $ = (id) => document.getElementById(id);
const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
const SPEEDS = [{ name: '1 hour / s', h: 1 }, { name: '6 hours / s', h: 6 }, { name: '1 day / s', h: 24 }, { name: '1 week / s', h: 168 }, { name: '1 month / s', h: 730 }];
const TOOLS = [{ id: 'look', name: 'Look', key: '1' }, { id: 'scratch', name: 'Scratch', key: '2' }, { id: 'salt', name: 'Salt', key: '3' }, { id: 'light', name: 'Lamp', key: '4' }];
const PAINTS = { white: { name: 'White', c: [0.86, 0.86, 0.83] }, cream: { name: 'Cream', c: [0.85, 0.79, 0.62] }, anthracite: { name: 'Anthracite', c: [0.09, 0.095, 0.1] },
  green: { name: 'Moss green', c: [0.12, 0.2, 0.13] }, red: { name: 'Signal red', c: [0.55, 0.06, 0.05] } };
const W = PANEL.W / 10, H = PANEL.H / 10; // the panel in scene units (1 = 10 mm)
const state = {
  piece: PIECES[Q.get('piece')] ? Q.get('piece') : 'tinplate', paint: PAINTS[Q.get('paint')] ? Q.get('paint') : 'white',
  rh: Math.min(0.98, Math.max(0.4, +(Q.get('rh') ?? 85) / 100)), speed: Math.min(SPEEDS.length - 1, +(Q.get('speed') ?? 2)),
  paused: Q.has('paused'), seed: +(Q.get('seed') || Math.floor(Math.random() * 1e6)), tool: 'look', lightAz: 2.5, lightEl: 0.38, wetDays: 0,
};

(async () => {
  if (!navigator.gpu) { $('status').textContent = 'Filiform needs WebGPU: Chrome, Edge, Safari 26 or Firefox 141 and later.'; return; }
  const renderer = new THREE.WebGPURenderer({ canvas: $('gl'), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, phone ? 2 : 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.AgXToneMapping; renderer.toneMappingExposure = 1.1;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  try { await renderer.init(); } catch (e) { $('status').textContent = 'Could not start WebGPU: ' + e.message; return; }
  if (renderer.backend.isWebGLBackend) { $('status').textContent = 'Filiform needs WebGPU: Chrome, Edge, Safari 26 or Firefox 141 and later.'; return; }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0f0e0d);
  const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.02, 100);
  const fitDist = () => { const t = Math.tan((15 * Math.PI) / 180); return Math.max((H * 0.62) / t, (W * 0.62) / t / camera.aspect); };
  const home = () => { const d = fitDist(); camera.position.set(0, d * Math.cos(0.12), d * Math.sin(0.12)); controls.target.set(0, 0, 0); controls.update(); };
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 0.9; controls.maxDistance = 20;
  controls.maxPolarAngle = 1.0; controls.screenSpacePanning = true;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  home();

  // a studio for the lacquer to reflect: dark, with a long softbox and a dim one overhead
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const skyM = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  const dy = positionLocal.normalize().y;
  skyM.colorNode = mix(vec3(0.02, 0.02, 0.02), vec3(0.11, 0.105, 0.1), smoothstep(-0.2, 0.9, dy));
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyM));
  const box = (w, h, c, pos) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(...c), side: THREE.DoubleSide })); m.position.set(...pos); m.lookAt(0, 0, 0); envScene.add(m); };
  box(9, 2.2, [3.2, 3.0, 2.8], [-5, 5.5, -4]); box(7, 9, [0.8, 0.76, 0.72], [-1.5, 8, 2.5]); box(3, 6, [1.4, 1.35, 1.3], [6, 3, 3]);
  scene.environment = pmrem.fromScene(envScene, 0.03).texture;
  scene.environmentIntensity = 0.65;
  const lamp = new THREE.DirectionalLight(0xffe9cf, 3.6);
  lamp.castShadow = true; lamp.shadow.mapSize.set(phone ? 1024 : 2048, phone ? 1024 : 2048);
  Object.assign(lamp.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 1, far: 30 }); lamp.shadow.bias = -0.0003; lamp.shadow.normalBias = 0.01; lamp.shadow.radius = 4;
  scene.add(lamp, lamp.target);
  scene.add(new THREE.HemisphereLight(0x9aa6b4, 0x1a1612, 0.25));
  const placeLamp = () => { const r = 12; lamp.position.set(Math.cos(state.lightAz) * Math.cos(state.lightEl) * r, Math.sin(state.lightEl) * r, Math.sin(state.lightAz) * Math.cos(state.lightEl) * r); };
  placeLamp();

  const bench = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), benchMaterial()); bench.rotation.x = -Math.PI / 2; bench.position.y = -0.07; bench.receiveShadow = true; scene.add(bench);

  // ---- the panel and its sim
  const NX = +(Q.get('res') || (phone ? 512 : 768));
  const look = makeLook();
  let sim = null, group = null, texA = null, texB = null, A = null, B = null, epoch = 0;
  const toH = THREE.DataUtils.toHalfFloat;
  const packCell = (i) => {
    const t = sim.tail[i], j = i * 4;
    A[j] = toH(t); A[j + 1] = toH(sim.head[i]); A[j + 2] = toH(sim.defect[i]); A[j + 3] = toH(t > 0 ? t * Math.max(-2000, sim.birth[i] - epoch) : 0);
    B[j] = Math.round(Math.min(1, sim.salt[i]) * 255); B[j + 1] = Math.round(sim.rear[i] * 255); B[j + 2] = Math.round(sim.act[i] * 255); B[j + 3] = Math.round(sim.hue[i] * 255);
  };
  const upload = () => {
    let n = 0;
    const ep = Math.floor(sim.now / 8) * 8;
    if (ep !== epoch) { epoch = ep; for (let i = 0; i < sim.N; i++) if (sim.tail[i] > 0) A[i * 4 + 3] = toH(sim.tail[i] * Math.max(-2000, sim.birth[i] - epoch)); n = 1; }
    n += sim.takeDirty(packCell);
    if (n) { texA.needsUpdate = true; texB.needsUpdate = true; }
    look.now.value = sim.now - epoch; look.wetDays.value = state.wetDays;
  };
  const build = () => {
    if (group) { scene.remove(group); group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); texA.dispose(); texB.dispose(); }
    sim = makeSim({ NX, piece: state.piece, seed: state.seed, maxAlive: phone ? 700 : 1400 });
    A = new Uint16Array(sim.N * 4); B = new Uint8Array(sim.N * 4); epoch = 0; state.wetDays = 0;
    texA = new THREE.DataTexture(A, sim.NX, sim.NY, THREE.RGBAFormat, THREE.HalfFloatType);
    texB = new THREE.DataTexture(B, sim.NX, sim.NY, THREE.RGBAFormat, THREE.UnsignedByteType);
    for (const t of [texA, texB]) { t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; }
    for (let i = 0; i < sim.N; i++) packCell(i);
    sim.takeDirty(() => {}); texA.needsUpdate = texB.needsUpdate = true;
    look.hole.value.set(30, 20, state.piece === 'frame' ? 2.0 : -1);
    look.paint.value.setRGB(...PAINTS[state.paint].c);
    group = new THREE.Group();
    const top = new THREE.Mesh(new THREE.PlaneGeometry(W, H), surfaceMaterial({ texA, texB, look, piece: state.piece, P: sim.P, NX: sim.NX, NY: sim.NY }));
    top.rotation.x = -Math.PI / 2; top.castShadow = top.receiveShadow = true; group.add(top);
    // its thickness: four thin sides, so the bench shows through the hole
    const sideM = new THREE.MeshStandardMaterial({ color: sim.P.metal === 'steel' ? 0x8e8c88 : 0xb9bcbf, metalness: 1, roughness: 0.35 });
    const T = 0.05;
    for (const [w, d, x, z] of [[W, 0.004, 0, H / 2 - 0.002], [W, 0.004, 0, -H / 2 + 0.002], [0.004, H, W / 2 - 0.002, 0], [0.004, H, -W / 2 + 0.002, 0]]) {
      const s = new THREE.Mesh(new THREE.BoxGeometry(w, T, d), sideM); s.position.set(x, -T / 2 - 0.0005, z); s.castShadow = true; group.add(s);
    }
    group.userData.top = top;
    scene.add(group);
    ui();
  };

  // ---- post: vignette and grain, and an offscreen path for the headless test
  const OFF = Q.has('offscreen');
  let off = null;
  if (OFF) {
    const w = innerWidth, h = innerHeight;
    off = { W: w, H: h, ldr: new THREE.RenderTarget(w, h) };
    off.c2d = document.createElement('canvas'); off.c2d.width = w; off.c2d.height = h;
    off.c2d.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none'; document.body.insertBefore(off.c2d, renderer.domElement.nextSibling);
  }
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera, { samples: phone ? 0 : 4 });
  const col = scenePass.getTextureNode('output');
  pipeline.outputNode = Fn(() => {
    const v = smoothstep(1.25, 0.3, length(screenUV.sub(0.5).mul(vec2(screenSize.x.div(screenSize.y), 1))));
    const px = screenUV.mul(screenSize).floor();
    const n = hash(px.x.add(px.y.mul(4111.0)).add(time.mul(60).floor().mul(7919.0).mod(65536))).sub(0.5).mul(0.007);
    return vec4(col.rgb.mul(mix(float(0.55), float(1), v)).add(n), 1);
  })();
  const draw = () => { renderer.setRenderTarget(OFF ? off.ldr : null); pipeline.render(); renderer.setRenderTarget(null); };
  const snapshot = async () => {
    upload(); draw();
    const px = await renderer.readRenderTargetPixelsAsync(off.ldr, 0, 0, off.W, off.H);
    off.c2d.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), off.W, off.H), 0, 0);
  };
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  // ---- time
  const advance = (hours) => {
    sim.run(hours, state.rh, 6);
    if (state.rh >= sim.P.rhMin) state.wetDays += hours / 24;
  };
  const fastForward = async (days) => {
    while (sim.now < days) { const t0 = performance.now(); while (sim.now < days && performance.now() - t0 < 60) advance(6); $('status').textContent = `day ${Math.floor(sim.now)}\u2026`; await new Promise((r) => setTimeout(r, 0)); }
  };

  // ---- UI
  const fill = (sel, items, cur) => { sel.innerHTML = ''; for (const [k, v] of Object.entries(items)) { const o = document.createElement('option'); o.value = k; o.textContent = v.name; sel.appendChild(o); } sel.value = cur; };
  fill($('piece'), PIECES, state.piece); fill($('paint'), PAINTS, state.paint);
  SPEEDS.forEach((s, i) => { const o = document.createElement('option'); o.value = i; o.textContent = s.name; $('speed').appendChild(o); });
  for (const t of TOOLS) { const b = document.createElement('button'); b.textContent = t.name; b.title = `${t.name} (${t.key})`; b.dataset.tool = t.id; b.onclick = () => setTool(t.id); $('tools').appendChild(b); }
  const setTool = (id) => { state.tool = id; for (const b of $('tools').children) b.classList.toggle('on', b.dataset.tool === id); document.body.classList.toggle('tool', id === 'scratch' || id === 'salt'); document.body.classList.toggle('light', id === 'light'); };
  const rhWord = () => {
    const P = sim.P, rh = state.rh;
    return rh < P.rhMin ? 'too dry: the heads rest' : rh > 0.93 ? 'too wet: heads swell into blisters' : rh > P.rhPeak - 0.04 && rh < P.rhPeak + 0.05 ? 'humid: fastest growth' : rh < P.rhMin + 0.08 ? 'barely humid enough' : 'humid';
  };
  const ui = () => {
    $('speed').value = state.speed; $('pause').classList.toggle('on', state.paused);
    $('paint').style.display = sim.P.coat === 'paint' ? '' : 'none';
    $('name').textContent = sim.P.note;
    $('rh').value = Math.round(state.rh * 100); $('rhLabel').textContent = `${Math.round(state.rh * 100)}% RH`;
  };
  $('piece').onchange = (e) => { state.piece = e.target.value; build(); fastForward(+(Q.get('age') ?? 10)); };
  $('paint').onchange = (e) => { state.paint = e.target.value; look.paint.value.setRGB(...PAINTS[state.paint].c); };
  $('rh').oninput = (e) => { state.rh = +e.target.value / 100; ui(); };
  $('speed').onchange = (e) => { state.speed = +e.target.value; state.paused = false; ui(); };
  $('pause').onclick = () => { state.paused = !state.paused; ui(); };
  $('restart').onclick = () => { state.seed = Math.floor(Math.random() * 1e6); build(); fastForward(+(Q.get('age') ?? 10)); };
  const save = () => { draw(); renderer.domElement.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `filiform-${state.piece}-day${Math.floor(sim.now)}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }); };
  $('save').onclick = save;
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase(), t = TOOLS.find((x) => x.key === k);
    if (t) setTool(t.id);
    else if (k === ' ') { state.paused = !state.paused; ui(); e.preventDefault(); }
    else if (k === ']') { state.speed = Math.min(SPEEDS.length - 1, state.speed + 1); ui(); } else if (k === '[') { state.speed = Math.max(0, state.speed - 1); ui(); }
    else if (k === 'arrowup' || k === 'arrowdown') { if (e.target.id !== 'rh') { state.rh = Math.min(0.98, Math.max(0.4, state.rh + (k === 'arrowup' ? 0.01 : -0.01))); ui(); e.preventDefault(); } }
    else if (k === 'r') $('restart').click(); else if (k === 's') save(); else if (k === 'h') document.body.classList.toggle('calm');
    else if (k === 'p') { const ks = Object.keys(PIECES); state.piece = ks[(ks.indexOf(state.piece) + 1) % ks.length]; $('piece').value = state.piece; build(); fastForward(+(Q.get('age') ?? 10)); }
  });

  // ---- pointer: the tools on the panel; double-click flies in to a spot
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const hitCell = (e) => {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
    const h = ray.intersectObject(group.userData.top, false)[0]; return h ? { x: h.uv.x * sim.NX, y: h.uv.y * sim.NY, p: h.point } : null;
  };
  const cv = renderer.domElement, touches = new Set();
  let drag = null;
  cv.addEventListener('pointerdown', (e) => {
    touches.add(e.pointerId);
    if (state.tool === 'look' || touches.size > 1) { drag = null; controls.enabled = true; return; }
    controls.enabled = false;
    drag = { x0: e.clientX, y0: e.clientY, cx: e.clientX, last: hitCell(e), t0: performance.now(), moved: 0 };
    cv.setPointerCapture(e.pointerId); $('hint').classList.add('gone');
    if (state.tool === 'salt' && drag.last) sim.addSalt(drag.last.x, drag.last.y, 1.2 / sim.mm, 0.5);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0));
    if (state.tool === 'light') { state.lightAz += (e.clientX - drag.cx) * 0.008; state.lightEl = Math.min(1.2, Math.max(0.12, state.lightEl - e.movementY * 0.004)); drag.cx = e.clientX; placeLamp(); return; }
    const c = hitCell(e); if (!c) return;
    if (state.tool === 'scratch' && drag.last && drag.moved > 4) sim.scratch(drag.last.x, drag.last.y, c.x, c.y, 0.13 / sim.mm, 0.3);
    if (state.tool === 'salt' && drag.last && Math.hypot(c.x - drag.last.x, c.y - drag.last.y) > 4) sim.addSalt(c.x, c.y, 1.2 / sim.mm, 0.35);
    else if (state.tool === 'salt') return;
    drag.last = c;
  });
  const up = (e) => {
    touches.delete(e.pointerId);
    if (drag && state.tool === 'scratch' && drag.moved <= 4 && drag.last) sim.chip(drag.last.x, drag.last.y, 0.35 / sim.mm, 0.5); // a tap chips the coating
    drag = null; controls.enabled = true;
  };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  let fly = null;
  cv.addEventListener('dblclick', (e) => {
    const c = hitCell(e); if (!c) return;
    const near = camera.position.distanceTo(controls.target) < 3;
    const to = near ? new THREE.Vector3() : c.p.clone(), dist = near ? fitDist() : 1.6;
    const dir = camera.position.clone().sub(controls.target).normalize();
    fly = { t: 0, fromT: controls.target.clone(), toT: to, fromP: camera.position.clone(), toP: to.clone().add(dir.multiplyScalar(dist)) };
  });

  // ---- loop
  build();
  await fastForward(+(Q.get('age') ?? 10));
  upload();
  $('status').remove(); document.body.classList.add('ready');
  setTimeout(() => $('hint').classList.add('gone'), 9000);
  setTool(TOOLS.find((t) => t.id === Q.get('tool')) ? Q.get('tool') : 'look');
  let tPrev = performance.now(), statsAt = 0;
  const fmtDays = (d) => (d < 60 ? `day ${Math.floor(d)}` : d < 730 ? `${(d / 30.44).toFixed(1)} months` : `${(d / 365.25).toFixed(1)} years`);
  const tick = (now) => {
    const dt = Math.min(0.05, (now - tPrev) / 1000); tPrev = now;
    if (!state.paused) advance(SPEEDS[state.speed].h * dt);
    upload();
    if (fly) { fly.t = Math.min(1, fly.t + dt * 1.4); const k = fly.t * fly.t * (3 - 2 * fly.t); controls.target.lerpVectors(fly.fromT, fly.toT, k); camera.position.lerpVectors(fly.fromP, fly.toP, k); if (fly.t >= 1) fly = null; }
    controls.update();
    $('age').textContent = fmtDays(sim.now);
    $('wx').textContent = rhWord() + (state.paused ? ' \u00b7 paused' : '');
    if (now - statsAt > 500) {
      statsAt = now;
      const s = sim.stats();
      $('stats').textContent = `${s.filaments} filaments \u00b7 ${s.active} growing \u00b7 ${(s.lengthMm / 1000).toFixed(s.lengthMm < 10000 ? 2 : 1)} m of tail`;
    }
    if (!OFF) draw();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.__filiform = {
    get state() { return state; }, get sim() { return sim; }, camera, controls, look, snapshot, draw, build, setTool, advance, fastForward, upload, home,
    setRh(v) { state.rh = v; ui(); },
    lamp(az, el) { state.lightAz = az; state.lightEl = el; placeLamp(); },
    // a tool at panel points in mm, as a drag or tap would use it
    scratch(ax, ay, bx, by) { sim.scratch(ax / sim.mm, ay / sim.mm, bx / sim.mm, by / sim.mm, 0.13 / sim.mm, 0.3); },
    chip(x, y) { sim.chip(x / sim.mm, y / sim.mm, 0.35 / sim.mm, 0.5); },
    salt(x, y) { sim.addSalt(x / sim.mm, y / sim.mm, 1.2 / sim.mm, 0.5); },
    // look at a spot of the panel (mm) from a distance (scene units)
    view(xmm, ymm, dist) { const t = new THREE.Vector3(xmm / 10 - W / 2, 0, H / 2 - ymm / 10); controls.target.copy(t); camera.position.copy(t).add(new THREE.Vector3(0, dist * Math.cos(0.12), dist * Math.sin(0.12))); controls.update(); },
  };
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !Q.has('shot')) navigator.serviceWorker.register('sw.js').catch(() => {});

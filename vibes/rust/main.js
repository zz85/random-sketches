// main.js - Rust: a piece of steel fixed to a wall outside, left in the weather while the years go by. The sim
// (sim.js) rusts it on the GPU, the weather (weather.js) rains on it, and you can scratch it, wire-brush it, paint
// over it or wet it. three.js r187 WebGPU + TSL.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { pass, select, uniform, vec2, vec3, vec4, float, mix, smoothstep, length, screenUV, screenSize, hash, time, Fn, positionLocal, attribute, fract } from 'three/tsl';
import { makeSim, COAT, MAT } from './sim.js';
import { SHEET, PIECES, PAINTS, buildMaps, buildSheet, buildHardware, buildExtras } from './piece.js';
import { makeLook, surfaceMaterial, wallMaterial } from './surface.js';
import { makeWeather, CLIMATES } from './weather.js';
import { makeAudio } from './audio.js';

const Q = new URLSearchParams(location.search.slice(1) + '&' + location.hash.slice(1));
const $ = (id) => document.getElementById(id);
const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
const SPEEDS = [
  { name: '1 hour / s', h: 1, passes: 4, drops: true }, { name: '1 day / s', h: 24, passes: 4, drops: true }, { name: '1 week / s', h: 168, passes: 4 },
  { name: '1 month / s', h: 730, passes: 4 }, { name: '1 year / s', h: 8766, passes: 3 },
];
const TOOLS = [
  { id: 'look', name: 'Look', key: '1' }, { id: 'scratch', name: 'Scratch', key: '2', t: 1, r: 1.7 }, { id: 'brush', name: 'Wire brush', key: '3', t: 2, r: 16 },
  { id: 'paint', name: 'Paint', key: '4', t: 3, r: 20 }, { id: 'water', name: 'Water', key: '5', t: 4, r: 12 },
];
const state = {
  piece: PIECES[Q.get('piece')] ? Q.get('piece') : 'panel', paint: PAINTS[Q.get('paint')] ? Q.get('paint') : 'green',
  climate: CLIMATES[Q.get('climate')] ? Q.get('climate') : 'temperate', speed: Math.min(SPEEDS.length - 1, +(Q.get('speed') ?? 3)),
  paused: Q.has('paused'), seed: +(Q.get('seed') || Math.floor(Math.random() * 1e6)), tool: 'look', shower: 0,
};

(async () => {
  if (!navigator.gpu) { $('status').textContent = 'Rust needs WebGPU: Chrome, Edge, Safari 26 or Firefox 141 and later.'; return; }
  // ---- renderer, camera, light
  const renderer = new THREE.WebGPURenderer({ canvas: $('gl'), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, phone ? 2 : 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.AgXToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  try { await renderer.init(); } catch (e) { $('status').textContent = 'Could not start WebGPU: ' + e.message; return; }
  if (renderer.backend.isWebGLBackend) { $('status').textContent = 'Rust needs WebGPU: Chrome, Edge, Safari 26 or Firefox 141 and later.'; return; }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x141210);
  const camera = new THREE.PerspectiveCamera(34, innerWidth / innerHeight, 0.02, 200);
  camera.position.set(1.2, 0.4, phone && innerWidth < innerHeight ? 15 : 9.6);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.08; controls.minDistance = 0.6; controls.maxDistance = 18;
  controls.minAzimuthAngle = -1.25; controls.maxAzimuthAngle = 1.25; controls.minPolarAngle = 0.35; controls.maxPolarAngle = Math.PI - 0.35;
  controls.screenSpacePanning = true; controls.update();

  const pmrem = new THREE.PMREMGenerator(renderer);
  // an outdoor sky for the metal to reflect: bright overcast above, a darker yard below, a lighter horizon
  const envScene = new THREE.Scene();
  const skyM = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  const dirY = positionLocal.normalize().y;
  skyM.colorNode = mix(mix(vec3(0.16, 0.14, 0.12), vec3(0.75, 0.74, 0.72), smoothstep(-0.25, 0.02, dirY)), vec3(0.95, 0.98, 1.05), smoothstep(0.05, 0.7, dirY));
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyM));
  const sunPatch = new THREE.Mesh(new THREE.SphereGeometry(0.9, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 5.6, 5) })); sunPatch.position.set(-4, 6, 6); envScene.add(sunPatch);
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = 0.8;
  const hemi = new THREE.HemisphereLight(0xc9d6e2, 0x3a3128, 0.6); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.4);
  sun.position.set(-5, 7, 9); sun.castShadow = true; sun.shadow.mapSize.set(phone ? 1024 : 2048, phone ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -4.5, right: 4.5, top: 3.6, bottom: -3.6, near: 2, far: 25 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.01; sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // the wall
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(60, 40), wallMaterial()); wall.position.z = -0.38; wall.receiveShadow = true; scene.add(wall);

  // ---- rain you can see
  const RAIN_N = phone ? 900 : 2000, rainVis = uniform(0);
  const rg = new THREE.BufferGeometry(), rp = [], rs = [];
  for (let i = 0; i < RAIN_N; i++) { for (const [x, y] of [[-1, 0], [1, 0], [1, 1], [-1, 0], [1, 1], [-1, 1]]) { rp.push(x, y, 0); rs.push(Math.random(), Math.random(), Math.random(), i); } }
  rg.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3)); rg.setAttribute('seed', new THREE.Float32BufferAttribute(rs, 4));
  const rm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const seedA = attribute('seed', 'vec4');
  rm.positionNode = Fn(() => {
    const fall = fract(seedA.y.sub(time.mul(seedA.z.mul(0.35).add(0.9))));
    const base = vec3(seedA.x.sub(0.5).mul(16), fall.mul(14).sub(6), hash(seedA.w.add(3)).mul(8).add(0.4));
    return base.add(vec3(positionLocal.x.mul(0.006).add(positionLocal.y.mul(-0.04)), positionLocal.y.mul(0.55), 0));
  })();
  rm.colorNode = vec3(0.75, 0.8, 0.85);
  rm.opacityNode = rainVis.mul(0.16).mul(smoothstep(0, 0.3, positionLocal.y)).mul(select(hash(seedA.w).greaterThan(float(1).sub(rainVis)), float(1), float(0)));
  const rain = new THREE.Mesh(rg, rm); rain.frustumCulled = false; rain.renderOrder = 5; scene.add(rain);

  // ---- the sim and the piece
  const NX = +(Q.get('res') || (phone ? 384 : 512)), NY = Math.round((NX * SHEET.H) / SHEET.W);
  let sim = null, group = null, maps = null, look = makeLook(), weather = makeWeather(state.climate, state.seed);
  const audio = makeAudio();
  const build = () => {
    if (group) { scene.remove(group); group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
    maps = buildMaps(state.piece, state.seed, NX, NY);
    const kHalf = new Uint16Array(maps.K0.length); for (let i = 0; i < kHalf.length; i++) kHalf[i] = THREE.DataUtils.toHalfFloat(maps.K0[i]);
    const kTex = new THREE.DataTexture(kHalf, NX, NY, THREE.RGBAFormat, THREE.HalfFloatType); kTex.magFilter = kTex.minFilter = THREE.LinearFilter; kTex.needsUpdate = true;
    sim = makeSim({ NX, NY, K0: maps.K0, K1: maps.K1, C0: maps.C0 });
    sim.init(renderer);
    sim.U.coat.value = PIECES[state.piece].coat; sim.U.gauge.value = PIECES[state.piece].gauge;
    group = new THREE.Group();
    const sheet = buildSheet(state.piece, phone ? 256 : 384, phone ? 192 : 288);
    const front = new THREE.Mesh(sheet.front, surfaceMaterial({ sim, look, kTex, kind: MAT.sheet }));
    const edges = new THREE.Mesh(sheet.edges, surfaceMaterial({ sim, look, kTex, kind: MAT.sheet, displace: false }));
    const back = new THREE.Mesh(sheet.back, new THREE.MeshStandardNodeMaterial({ color: 0x1a1512, roughness: 0.9 }));
    const hw = new THREE.Mesh(buildHardware(maps.hw), surfaceMaterial({ sim, look, kTex, hardware: true }));
    for (const m of [front, edges, back, hw]) { m.castShadow = m.receiveShadow = true; group.add(m); }
    for (const e of buildExtras(state.piece)) { const m = new THREE.Mesh(e.geo, surfaceMaterial({ sim, look, kTex, kind: e.kind, displace: false })); m.castShadow = m.receiveShadow = true; group.add(m); }
    group.userData.front = front; group.userData.hw = hw;
    scene.add(group);
    weather = makeWeather(state.climate, state.seed);
    look.paint.value.setRGB(...PAINTS[state.paint].c);
    lastStats = null; ui();
  };
  let lastStats = null;

  // ---- post: the scene, a slight bloom of wet glints, vignette and grain
  const OFF = Q.has('offscreen');
  let off = null;
  if (OFF) {
    const W = innerWidth, H = innerHeight;
    off = { W, H, ldr: new THREE.RenderTarget(W, H) };
    off.c2d = document.createElement('canvas'); off.c2d.width = W; off.c2d.height = H;
    off.c2d.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none'; document.body.insertBefore(off.c2d, renderer.domElement.nextSibling);
  }
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera, { samples: phone ? 0 : 4 });
  const col = scenePass.getTextureNode('output');
  const vig = uniform(0.4);
  pipeline.outputNode = Fn(() => {
    const v = smoothstep(1.2, 0.25, length(screenUV.sub(0.5).mul(vec2(screenSize.x.div(screenSize.y), 1))));
    const px = screenUV.mul(screenSize).floor();
    const n = hash(px.x.add(px.y.mul(4111.0)).add(time.mul(60).floor().mul(7919.0).mod(65536))).sub(0.5).mul(0.008);
    return vec4(col.rgb.mul(mix(float(1).sub(vig), float(1), v)).add(n), 1);
  })();
  const draw = () => { renderer.setRenderTarget(OFF ? off.ldr : null); pipeline.render(); renderer.setRenderTarget(null); };
  const snapshot = async () => {
    draw();
    const px = await renderer.readRenderTargetPixelsAsync(off.ldr, 0, 0, off.W, off.H);
    off.c2d.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), off.W, off.H), 0, 0);
  };
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  // ---- one frame of sim: the weather over `hours`, water passes, the chemistry
  let cloud = 0.4, rainNow = 0;
  const brush = { on: false, a: new THREE.Vector2(), b: new THREE.Vector2(), speed: 0, moved: false };
  const simFrame = (hours, passes) => {
    const U = sim.U, wx = weather.advance(hours);
    const forced = state.shower > 0;
    if (forced) state.shower -= hours;
    const raining = wx.raining || forced, power = forced ? Math.max(wx.power, 0.9) : wx.power;
    const rf = forced ? Math.max(wx.rainFrac, Math.min(1, state.shower > 0 ? 1 : 0)) : wx.rainFrac;
    // drops land at a rate set by how hard it rains now. At a fast clock a frame stands for hours or days, so it is
    // drawn as wet or dry by the share of it that rained: a wet frame rains and nothing dries, a dry one dries
    const fast = hours > 2;
    const wetNow = fast ? Math.random() < Math.min(1, rf * 1.6) : raining;
    U.rain.value = wetNow ? 0.03 * Math.min(1.5, Math.max(0.4, power || 0.6)) : 0;
    U.dropV.value = 0.045;
    U.evap.value = (wetNow ? 0.00003 : (fast ? 0.0012 : 0.00045) * (0.6 + weather.climate.sun)) * (1 - 0.6 * wx.dewFrac);
    U.dew.value = wx.dewFrac > 0 && !fast ? 0.00002 : 0;
    U.dt.value = hours; U.wetRain.value = rf; U.wetDew.value = wx.dewFrac; U.temp.value = wx.warm; U.salt.value = wx.salt;
    if (brush.on) { const t = TOOLS.find((x) => x.id === state.tool); U.tool.value = t.t; U.bR.value = t.r; U.b0.value.copy(brush.a); U.b1.value.copy(brush.b); U.bAmt.value = 1; brush.a.copy(brush.b); }
    else U.tool.value = 0;
    sim.frame(passes, true);
    cloud += ((raining ? 1 : 0.15 + 0.4 * (1 - weather.climate.sun)) - cloud) * Math.min(1, fast ? 0.1 : 0.03);
    rainNow += ((raining ? Math.min(1, power) : 0) - rainNow) * 0.2;
    look.age.value = weather.date().years;
  };

  // ---- fast-forward (?age=years): run the clock at a coarse step before showing it
  const fastForward = async (years) => {
    const step = Q.has('shot') ? 72 : 36;
    while (weather.date().years < years) {
      for (let k = 0; k < 40 && weather.date().years < years; k++) simFrame(step, 2);
      $('status').textContent = `${weather.date().years.toFixed(1)} years go by\u2026`;
      await sim.stats(); // waits for the GPU to catch up
    }
  };

  // ---- UI
  const fill = (sel, items, cur) => { sel.innerHTML = ''; for (const [k, v] of Object.entries(items)) { const o = document.createElement('option'); o.value = k; o.textContent = v.name; sel.appendChild(o); } sel.value = cur; };
  fill($('piece'), PIECES, state.piece); fill($('paint'), PAINTS, state.paint); fill($('climate'), CLIMATES, state.climate);
  SPEEDS.forEach((s, i) => { const o = document.createElement('option'); o.value = i; o.textContent = s.name; $('speed').appendChild(o); });
  for (const t of TOOLS) { const b = document.createElement('button'); b.textContent = t.name; b.title = `${t.name} (${t.key})`; b.dataset.tool = t.id; b.onclick = () => setTool(t.id); $('tools').appendChild(b); }
  const setTool = (id) => { state.tool = id; for (const b of $('tools').children) b.classList.toggle('on', b.dataset.tool === id); document.body.classList.toggle('tool', id !== 'look'); };
  const ui = () => {
    $('speed').value = state.speed; $('pause').classList.toggle('on', state.paused);
    $('paint').style.display = PIECES[state.piece].coat === COAT.paint ? '' : 'none';
    $('name').textContent = PIECES[state.piece].note + ', ' + CLIMATES[state.climate].name.toLowerCase();
    $('shower').classList.toggle('on', state.shower > 0);
  };
  $('piece').onchange = (e) => { state.piece = e.target.value; build(); };
  $('paint').onchange = (e) => { state.paint = e.target.value; look.paint.value.setRGB(...PAINTS[state.paint].c); };
  $('climate').onchange = (e) => { state.climate = e.target.value; weather.climate = state.climate; ui(); };
  $('speed').onchange = (e) => { state.speed = +e.target.value; state.paused = false; ui(); };
  $('pause').onclick = () => { state.paused = !state.paused; ui(); };
  $('shower').onclick = () => { state.shower = state.shower > 0 ? 0 : Math.max(3, SPEEDS[state.speed].h * 0.4); ui(); };
  $('restart').onclick = () => { state.seed = Math.floor(Math.random() * 1e6); build(); };
  $('sound').onclick = () => { $('sound').classList.toggle('on', audio.toggle()); };
  const save = () => { draw(); renderer.domElement.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `rust-${state.piece}-${weather.date().years.toFixed(1)}y.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }); };
  $('save').onclick = save;
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase(), t = TOOLS.find((x) => x.key === k);
    if (t) setTool(t.id);
    else if (k === ' ') { state.paused = !state.paused; ui(); e.preventDefault(); }
    else if (k === ']') { state.speed = Math.min(SPEEDS.length - 1, state.speed + 1); ui(); } else if (k === '[') { state.speed = Math.max(0, state.speed - 1); ui(); }
    else if (k === 'r') $('restart').click(); else if (k === 'w') $('shower').click(); else if (k === 'm') $('sound').click(); else if (k === 's') save();
    else if (k === 'h') document.body.classList.toggle('calm');
    else if (k === 'p') { const ks = Object.keys(PIECES); state.piece = ks[(ks.indexOf(state.piece) + 1) % ks.length]; $('piece').value = state.piece; build(); }
    else if (k === 'c') { const ks = Object.keys(CLIMATES); state.climate = ks[(ks.indexOf(state.climate) + 1) % ks.length]; $('climate').value = state.climate; weather.climate = state.climate; ui(); }
  });

  // ---- pointer: tools on the sheet; double-click flies in to a spot
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const hit = (e) => {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
    const h = ray.intersectObject(group.userData.front, false)[0]; return h ? h.point : null;
  };
  const toCell = (p, out) => out.set(((p.x + SHEET.W / 2) / SHEET.W) * NX - 0.5, ((p.y + SHEET.H / 2) / SHEET.H) * NY - 0.5);
  const cv = renderer.domElement, touches = new Set();
  let lastMove = 0, lastP = null;
  cv.addEventListener('pointerdown', (e) => {
    touches.add(e.pointerId);
    if (state.tool === 'look' || touches.size > 1) { if (brush.on) { brush.on = false; controls.enabled = true; } return; }
    const p = hit(e); if (!p) return;
    controls.enabled = false; brush.on = true; toCell(p, brush.a); brush.b.copy(brush.a); lastP = p.clone(); lastMove = performance.now();
    cv.setPointerCapture(e.pointerId); $('hint').classList.add('gone');
  });
  cv.addEventListener('pointermove', (e) => {
    if (!brush.on) return;
    const p = hit(e); if (!p) return;
    toCell(p, brush.b);
    const now = performance.now(); brush.speed = lastP ? (p.distanceTo(lastP) / Math.max(1, now - lastMove)) * 1000 : 0; lastP = p.clone(); lastMove = now;
  });
  const up = (e) => { touches.delete(e.pointerId); if (brush.on) { brush.on = false; controls.enabled = true; brush.speed = 0; } };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  let fly = null;
  cv.addEventListener('dblclick', (e) => {
    const p = hit(e); if (!p) return;
    const far = camera.position.distanceTo(controls.target) < 2.5;
    const to = far ? new THREE.Vector3(0, 0, 0) : p.clone(), dist = far ? 9.6 : 1.4;
    const dir = camera.position.clone().sub(controls.target).normalize();
    fly = { t: 0, fromT: controls.target.clone(), toT: to, fromP: camera.position.clone(), toP: to.clone().add(dir.multiplyScalar(dist)) };
  });

  // ---- loop
  build();
  if (Q.get('age')) await fastForward(+Q.get('age'));
  $('status').remove(); document.body.classList.add('ready');
  setTimeout(() => $('hint').classList.add('gone'), 9000);
  setTool(TOOLS.find((t) => t.id === Q.get('tool')) ? Q.get('tool') : 'look');
  let tPrev = performance.now(), statsAt = 0, statsBusy = false, frames = 0;
  const tick = (now) => {
    const dt = Math.min(0.05, (now - tPrev) / 1000); tPrev = now; frames++;
    const sp = SPEEDS[state.speed];
    if (!state.paused) simFrame(sp.h * dt, sp.passes);
    else if (brush.on) { sim.U.dt.value = 0; sim.U.rain.value = 0; sim.U.evap.value = 0; const t = TOOLS.find((x) => x.id === state.tool); sim.U.tool.value = t.t; sim.U.bR.value = t.r; sim.U.b0.value.copy(brush.a); sim.U.b1.value.copy(brush.b); brush.a.copy(brush.b); sim.frame(t.t === 4 ? 2 : 0, true); }
    // light: the sun goes in when it rains
    sun.intensity = mix1(2.8, 0.25, cloud); hemi.intensity = mix1(0.45, 0.85, cloud); scene.environmentIntensity = mix1(0.85, 0.7, cloud);
    renderer.toneMappingExposure = mix1(1.0, 1.25, cloud);
    rainVis.value = rainNow * (state.paused ? 0 : 1) * (sp.h > 200 ? 0.5 : 1);
    if (fly) { fly.t = Math.min(1, fly.t + dt * 1.4); const e = fly.t * fly.t * (3 - 2 * fly.t); controls.target.lerpVectors(fly.fromT, fly.toT, e); camera.position.lerpVectors(fly.fromP, fly.toP, e); if (fly.t >= 1) fly = null; }
    controls.update();
    audio.rain(rainVis.value, sp.drops, dt);
    audio.tool(brush.on ? TOOLS.find((x) => x.id === state.tool).t : 0, brush.speed); brush.speed *= 0.85;
    // the clock and the counts
    const d = weather.date();
    $('age').textContent = d.label;
    $('wx').textContent = `${d.month} \u00b7 ${state.shower > 0 || weather.state.raining ? (rainNow > 0.8 ? 'heavy rain' : 'rain') : weather.state.dewNight && (weather.state.hours % 24 < 8) ? 'dew' : cloud > 0.5 ? 'overcast' : 'dry'}${CLIMATES[state.climate].salt > 0.5 ? ' \u00b7 sea air' : ''}${state.paused ? ' \u00b7 paused' : ''}`;
    if (!OFF && now - statsAt > 600 && !statsBusy) {
      statsBusy = true; statsAt = now;
      sim.stats().then((s) => {
        if (lastStats && s.bare > lastStats.bare + 0.0004) audio.crackle(Math.round((s.bare - lastStats.bare) * 4000));
        lastStats = s;
        const cm2 = (s.holes * SHEET.W * SHEET.H * 100);
        const coat = PIECES[state.piece].coat;
        $('stats').textContent = `rust ${(s.rust * 100).toFixed(0)}%` + (coat === COAT.paint ? ` \u00b7 paint lost ${(s.bare * 100).toFixed(0)}%` : coat === COAT.zinc ? ` \u00b7 zinc gone ${(s.bare * 100).toFixed(0)}%` : '') + (cm2 > 0.05 ? ` \u00b7 holes ${cm2.toFixed(cm2 < 10 ? 1 : 0)} cm\u00b2` : '');
      }).finally(() => { statsBusy = false; });
    }
    if (state.shower > 0 !== $('shower').classList.contains('on')) ui();
    if (!OFF) draw();
    requestAnimationFrame(tick);
  };
  const mix1 = (a, b, t) => a + (b - a) * t;
  requestAnimationFrame(tick);

  window.__rust = {
    get state() { return state; }, get sim() { return sim; }, get weather() { return weather; }, camera, controls, look, snapshot, get group() { return group; }, draw, build, setTool, simFrame,
    stats: () => sim.stats(), read: () => sim.read(), date: () => weather.date(), fastForward,
    // a tool stroke from sheet point a to b (sheet units), as a drag would make it
    stroke(tool, ax, ay, bx, by) {
      const t = TOOLS.find((x) => x.id === tool), cA = new THREE.Vector2(), cB = new THREE.Vector2();
      toCell({ x: ax, y: ay }, cA); toCell({ x: bx, y: by }, cB);
      sim.U.tool.value = t.t; sim.U.bR.value = t.r; sim.U.b0.value.copy(cA); sim.U.b1.value.copy(cB); sim.U.dt.value = 0; sim.frame(t.t === 4 ? 2 : 0, true); sim.U.tool.value = 0;
    },
  };
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !Q.has('shot')) navigator.serviceWorker.register('sw.js').catch(() => {});

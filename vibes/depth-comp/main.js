// main.js - Depth Comp: the water, the line and the diver in three.js, the HUD, and the input (keys
// and touch buttons) that drive the dive in sim.js. ?demo lets the bot dive; ?target=40,
// ?disc=FIM, ?seed=3 to set the dive; ?pause steps only by hand (window.__depthcomp, for smoke.js).
import * as THREE from 'three';
import { Dive, BODY } from './sim.js';
import { Bot } from './bot.js';
import { DiverFigure } from './diver.js';
import { makeAudio } from './audio.js';

const Q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const clamp = THREE.MathUtils.clamp;
const ease = (a, b, dt, rate) => a + (b - a) * (1 - Math.exp(-dt * rate));
const store = (() => { try { return JSON.parse(localStorage.getItem('depth-comp') || '{}'); } catch { return {}; } })();
const save = () => { try { localStorage.setItem('depth-comp', JSON.stringify(store)); } catch { /* private */ } };

// ---- renderer, scene, camera
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: Q.has('shot') });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 400);
scene.fog = new THREE.FogExp2(0x1d6f9e, 0.05);
scene.background = new THREE.Color(0x1d6f9e);
const hemi = new THREE.HemisphereLight(0xbfe8ff, 0x08223a, 1.6);
const sun = new THREE.DirectionalLight(0xfff2d8, 2.2); sun.position.set(-4, 20, 6);
scene.add(hemi, sun, sun.target);

// water colour with depth: turquoise at the top, blue, then dark navy
const WATER = [[0, 0x3fa7d6], [8, 0x1d77ac], [25, 0x0d4677], [50, 0x06223f], [90, 0x020c19]];
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
function waterAt(depth, out) {
  for (let i = 1; i < WATER.length; i++) if (depth <= WATER[i][0] || i === WATER.length - 1) {
    const [d0, a] = WATER[i - 1], [d1, b] = WATER[i];
    return out.copy(_c1.setHex(a)).lerp(_c2.setHex(b), clamp((depth - d0) / (d1 - d0), 0, 1));
  }
  return out;
}

// ---- the surface from below: bright, wavy, Snell's window
const surfMat = new THREE.ShaderMaterial({
  fog: true, side: THREE.DoubleSide, transparent: true,
  uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uT: { value: 0 } }]),
  vertexShader: `uniform float uT; varying vec2 vP;
    #include <fog_pars_vertex>
    void main() { vec3 p = position; vP = p.xy; p.z += 0.06 * sin(p.x * 1.3 + uT * 1.1) + 0.05 * sin(p.y * 1.7 - uT * 0.9);
      vec4 mvPosition = modelViewMatrix * vec4(p, 1.0); gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: `uniform float uT; varying vec2 vP;
    #include <fog_pars_fragment>
    void main() { float w = sin(vP.x * 2.1 + uT * 1.3) * sin(vP.y * 1.7 - uT) + 0.5 * sin((vP.x + vP.y) * 3.7 + uT * 2.0);
      vec3 c = mix(vec3(0.42, 0.78, 0.93), vec3(0.85, 0.97, 1.0), smoothstep(0.2, 1.2, w));
      gl_FragColor = vec4(c, 0.92);
      #include <fog_fragment>
    }`,
});
const surface = new THREE.Mesh(new THREE.PlaneGeometry(160, 160, 80, 80), surfMat);
surface.rotation.x = Math.PI / 2; scene.add(surface);

// light shafts from the surface, swaying
const shaftTex = (() => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 256; const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 256); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 256);
  const img = g.getImageData(0, 0, 64, 256); for (let y = 0; y < 256; y++) for (let x = 0; x < 64; x++) { const e = Math.sin(Math.PI * x / 63) ** 2; img.data[(y * 64 + x) * 4 + 3] *= e; }
  g.putImageData(img, 0, 0); return new THREE.CanvasTexture(c);
})();
const shafts = [];
for (let i = 0; i < 14; i++) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.6 + Math.random() * 1.6, 30), new THREE.MeshBasicMaterial({ map: shaftTex, transparent: true, opacity: 0.14 + Math.random() * 0.12, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xcff0ff }));
  m.position.set((Math.random() - 0.5) * 30, -15, -2 - Math.random() * 12); m.rotation.z = -0.25 + (Math.random() - 0.5) * 0.12;
  m.userData = { x: m.position.x, ph: Math.random() * 6, sp: 0.2 + Math.random() * 0.3 };
  scene.add(m); shafts.push(m);
}

// marine snow: still in the water, so it streams past as you move
const SNOW = 1800, SB = { x: 18, y: 16, z: 10 };
const snowGeo = new THREE.BufferGeometry(), snowPos = new Float32Array(SNOW * 3);
for (let i = 0; i < SNOW; i++) { snowPos[i * 3] = (Math.random() - 0.5) * SB.x; snowPos[i * 3 + 1] = -Math.random() * SB.y; snowPos[i * 3 + 2] = (Math.random() - 0.5) * SB.z; }
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
const snow = new THREE.Points(snowGeo, new THREE.PointsMaterial({ color: 0xe8f6ff, size: 0.03, transparent: true, opacity: 0.55, depthWrite: false }));
snow.frustumCulled = false; scene.add(snow);

// ---- the line, its marks, the buoy, the plate, the seabed
const line = new THREE.Group(); scene.add(line);
const label = (text, color = '#eaf6ff', w = 128) => {
  const c = document.createElement('canvas'); c.width = w; c.height = 48; const g = c.getContext('2d');
  g.font = '600 30px system-ui, sans-serif'; g.fillStyle = color; g.textBaseline = 'middle'; g.fillText(text, 4, 25);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  s.scale.set(0.9 * w / 128, 0.34, 1); s.center.set(0, 0.5); return s;
};
let neutralMark;
function buildLine(target) {
  for (const o of [...line.children]) { line.remove(o); o.traverse?.((m) => { m.geometry?.dispose(); m.material?.map?.dispose(); m.material?.dispose(); }); }
  const len = target + 4;
  const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, len, 6), new THREE.MeshStandardMaterial({ color: 0xf2e9c9, roughness: 0.8 }));
  rope.position.y = -len / 2; line.add(rope);
  for (let m = 5; m <= target + 3; m += 5) {
    const ten = m % 10 === 0;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, ten ? 0.18 : 0.1, 8), new THREE.MeshStandardMaterial({ color: ten ? 0xe63946 : 0xffd23f, roughness: 0.6 }));
    band.position.y = -m; line.add(band);
    const s = label(`${m} m`, ten ? '#ffd9dc' : '#f4ecc8'); s.position.set(-0.75, -m, 0); line.add(s);
  }
  const buoy = new THREE.Mesh(new THREE.SphereGeometry(0.45, 20, 12), new THREE.MeshStandardMaterial({ color: 0xff7a1a, roughness: 0.5, emissive: 0x6a2a00 }));
  buoy.scale.set(1, 0.55, 1); buoy.position.y = 0.05; line.add(buoy);
  // the plate where the head meets it (the dive's depth is the hips', 0.8 m above)
  const py = -target - 0.85;
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.03, 32), new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.35, metalness: 0.6 }));
  plate.position.y = py; line.add(plate);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + 0.4, tag = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.01), new THREE.MeshStandardMaterial({ color: [0xff3b6b, 0x3bd1ff, 0x9bff3b, 0xffd23f][i], roughness: 0.4 }));
    tag.position.set(Math.cos(a) * 0.3, py + 0.12, Math.sin(a) * 0.3); line.add(tag);
  }
  const weight = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 0.3, 12), new THREE.MeshStandardMaterial({ color: 0x3a3f44, roughness: 0.7, metalness: 0.4 }));
  weight.position.y = py - 2.2; line.add(weight);
  const sl = label(`${target} m`, '#ffffff'); sl.position.set(0.55, py, 0); line.add(sl);
  const bed = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: 0x8c8466, roughness: 1 }));
  bed.rotation.x = -Math.PI / 2; bed.position.y = py - 2.4; line.add(bed);
  neutralMark = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.012, 6, 24), new THREE.MeshBasicMaterial({ color: 0x6fe0b0, transparent: true, opacity: 0.7 }));
  ring.rotation.x = Math.PI / 2; neutralMark.add(ring);
  const nl = label('neutral', '#9ff2cc'); nl.position.set(0.2, 0, 0); neutralMark.add(nl);
  line.add(neutralMark);
}

// ---- the diver
const fig = new DiverFigure();
scene.add(fig.group);

// ---- the dive
let dive, bot = null, demo = Q.has('demo');
const opts = { target: +(Q.get('target') || store.target || 30), disc: Q.get('disc') || store.disc || 'CWT' };
function reset() {
  dive = new Dive({ discipline: opts.disc, target: opts.target, seed: +(Q.get('seed') || (Math.random() * 1e9) | 0) });
  bot = demo ? new Bot(dive, { pack: 6 }) : null;
  buildLine(opts.target);
  $('result').classList.remove('show');
  $('fade').style.opacity = 0;
  toasts.length = 0; $('toasts').innerHTML = '';
  if (demo) toast('Watching the bot dive. R to dive yourself.');
  updateOpts();
}
function updateOpts() {
  $('bTarget').textContent = `${opts.target} m`;
  document.querySelectorAll('[data-disc]').forEach((b) => b.classList.toggle('on', b.dataset.disc === opts.disc));
  $('bL').firstChild.textContent = opts.disc === 'FIM' ? 'Hand L' : 'L';
  $('bR').firstChild.textContent = opts.disc === 'FIM' ? 'Hand R' : 'R';
  $('bDemo').classList.toggle('on', demo);
  store.target = opts.target; store.disc = opts.disc; save();
}

// ---- toasts
const toasts = [];
function toast(text) {
  const el = document.createElement('div'); el.className = 'panel'; el.textContent = text;
  $('toasts').prepend(el); toasts.push({ el, t: performance.now() });
  while ($('toasts').children.length > 3) $('toasts').lastChild.remove();
}

// ---- input: keys and the on-screen buttons share one table
const held = new Set();
const audio = makeAudio();
function press(code) {
  audio.wake();
  if (code === 'KeyH' || code === 'Slash') { $('help').classList.toggle('show'); return; }
  if (code === 'KeyR') { demo = false; reset(); return; }
  if (code === 'KeyC') { cam.dist = cam.dist < 7 ? 10 : 5; return; }
  if (bot) return;
  const d = dive, ph = d.phase;
  if (ph === 'breathe') {
    if (code === 'BracketLeft' || code === 'Minus') { opts.target = Math.max(5, opts.target - 5); reset(); }
    else if (code === 'BracketRight' || code === 'Equal') { opts.target = Math.min(120, opts.target + 5); reset(); }
    else if (code === 'Digit1') { opts.disc = 'CWT'; reset(); }
    else if (code === 'Digit2') { opts.disc = 'FIM'; reset(); }
  }
  switch (code) {
    case 'Space': d.breath(true); if (ph === 'surface') audio.breath(); break;
    case 'KeyP': if (d.pack()) audio.gulp(); break;
    case 'Enter': d.dive(); break;
    case 'KeyZ': case 'Comma': stroke(0); break;
    case 'KeyX': case 'Period': stroke(1); break;
    case 'KeyF': { const r = d.frenzel(); if (r) audio.click(r.eff); break; }
    case 'KeyV': { const r = d.valsalva(); if (r) audio.click(r.eff * 0.7); break; }
    case 'KeyM': { const r = d.mouthfill(); if (r && r.fill) audio.gulp(); break; }
    case 'KeyT': d.turn(); break;
    case 'KeyO': d.ok(); break;
    case 'ArrowUp': case 'PadUp': d.setArms('ahead'); break;
    case 'ArrowDown': case 'PadDown': d.setArms('sides'); break;
  }
}
function release(code) { if (code === 'Space' && !bot) dive.breath(false); }
function stroke(i) {
  const r = dive.discipline === 'FIM' ? dive.pull(i) : dive.kick(i);
  if (r && !r.busy) audio.swish(r.q, dive.discipline === 'FIM');
}
const KEYS = new Set(['Space', 'KeyP', 'Enter', 'KeyZ', 'KeyX', 'Comma', 'Period', 'KeyF', 'KeyV', 'KeyM', 'KeyT', 'KeyO', 'KeyR', 'KeyC', 'KeyH', 'Slash',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PadUp', 'PadDown', 'PadLeft', 'PadRight', 'BracketLeft', 'BracketRight', 'Minus', 'Equal', 'Digit1', 'Digit2']);
addEventListener('keydown', (e) => {
  if (!KEYS.has(e.code)) return; e.preventDefault();
  if (e.repeat) return;
  held.add(e.code); press(e.code);
});
addEventListener('keyup', (e) => { if (!held.has(e.code)) return; held.delete(e.code); release(e.code); });
addEventListener('blur', () => { for (const c of held) release(c); held.clear(); });
document.querySelectorAll('[data-k]').forEach((b) => {
  const code = b.dataset.k;
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); held.add(code); press(code); b.classList.add('on'); });
  const up = () => { if (!held.has(code)) return; held.delete(code); release(code); b.classList.remove('on'); };
  b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
});
document.querySelectorAll('[data-disc]').forEach((b) => b.addEventListener('click', () => { opts.disc = b.dataset.disc; demo = false; reset(); }));
$('bDemo').addEventListener('click', () => { demo = !demo; reset(); });
$('rDemo').addEventListener('click', () => { demo = true; reset(); });
$('bHelp').addEventListener('click', () => $('help').classList.add('show'));
$('helpClose').addEventListener('click', () => $('help').classList.remove('show'));
if (!store.seenHelp && !Q.has('shot')) { $('help').classList.add('show'); store.seenHelp = 1; save(); }

// the lean is held. The keys are relative to the diver: <- tips the head toward your belly
// (toward the line, which you face), -> toward your back. The on-screen pad is relative to the
// screen: its arrows move the head that way across it. A positive lean turns the body counter-
// clockwise, which moves the head toward the untwisted face, (-cos th, -sin th); the figure's
// half twist turns the belly the other way.
function leanInput() {
  const belly = Math.cos(fig.twist) >= 0 ? 1 : -1;
  const keys = (held.has('ArrowLeft') ? 1 : 0) - (held.has('ArrowRight') ? 1 : 0);
  const hy = Math.cos(dive.th);
  const pad = (held.has('PadRight') ? 1 : 0) - (held.has('PadLeft') ? 1 : 0);
  return clamp(keys * belly + pad * Math.sign(-hy || 1), -1, 1);
}

// camera: beside the dive, following; wheel or pinch for distance
const cam = { dist: 5, x: 0, y: -1, z: 5 };
addEventListener('wheel', (e) => { cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.001), 2.5, 16); }, { passive: true });
const touches = new Map(); let pinch0 = 0, dist0 = 5;
canvas.addEventListener('pointerdown', (e) => { touches.set(e.pointerId, [e.clientX, e.clientY]); if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); dist0 = cam.dist; } });
canvas.addEventListener('pointermove', (e) => { if (!touches.has(e.pointerId)) return; touches.set(e.pointerId, [e.clientX, e.clientY]); if (touches.size === 2 && pinch0) { const [a, b] = [...touches.values()]; cam.dist = clamp(dist0 * pinch0 / Math.max(20, Math.hypot(a[0] - b[0], a[1] - b[1])), 2.5, 16); } });
const tEnd = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch0 = 0; };
canvas.addEventListener('pointerup', tEnd); canvas.addEventListener('pointercancel', tEnd);

// ---- HUD
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const bar = (id, frac, color) => { const el = $(id); el.style.width = `${clamp(frac, 0, 1) * 100}%`; if (color) el.style.background = color; };
const C = { good: '#6fe0b0', warn: '#ffc857', bad: '#ff6b6b', blue: '#7fd0ff' };
const lungCv = $('lungs'), lctx = lungCv.getContext('2d'), prof = $('profile'), pctx = prof.getContext('2d');
let shownResult = false;

function hud(dt) {
  const d = dive;
  document.body.className = d.phase === 'duck' ? 'dive' : d.phase === 'done' ? 'done' : d.phase;
  $('cDepth').textContent = d.depth.toFixed(1);
  $('cTime').textContent = fmt(d.phase === 'breathe' ? 0 : d.diveT + Math.min(d.duckT, 4));
  $('cSpeed').textContent = `${d.vy > 0.05 ? '↑' : d.vy < -0.05 ? '↓' : ' '}${Math.abs(d.vy).toFixed(2)}`;
  $('cMax').textContent = d.maxDepth.toFixed(1);
  $('cTarget').textContent = `${d.target} m ${d.discipline}`;

  // O2: what is left, as you would have it back at the surface (falls steadily); the number is the
  // brain's PO2 now in mmHg, which depth props up on the way down
  const o2 = d.o2, left = d.o2Left; bar('gO2', left, left < 0.3 ? C.bad : left < 0.55 ? C.warn : C.good); $('tO2').textContent = `${Math.round(left * 100)}%`;
  $('tPo2').textContent = `${(d.brain * 760).toFixed(0)}`;
  bar('gPain', d.pain, d.vertigo > 0.05 ? '#c77dff' : d.pain > 0.5 ? C.bad : C.warn); $('tPain').textContent = d.vertigo > 0.05 ? 'vertigo' : d.pain > 0.02 ? `${Math.round(d.pain * 100)}%` : '';
  const u = clamp(d.urge / 1.5, 0, 1); bar('gUrge', u, d.urge > 1 ? C.warn : C.blue); $('tUrge').textContent = d.urge > 1 ? 'contr.' : `${Math.round(Math.max(0, d.urge) * 100)}%`;
  const dp = Math.max(0, d.dP); bar('gEars', dp / 0.5, dp > 0.25 ? C.bad : dp > 0.12 ? C.warn : C.good); $('tEars').textContent = `${(dp * 10).toFixed(1)} m`;
  const kg = d.netKg, lift = $('gLift');
  lift.style.left = kg >= 0 ? '50%' : `${50 + Math.max(-50, kg / 6 * 50)}%`; lift.style.width = `${Math.min(50, Math.abs(kg) / 6 * 50)}%`; lift.style.background = kg >= 0 ? C.warn : C.blue;
  $('tLift').textContent = `${kg >= 0 ? '+' : ''}${kg.toFixed(1)}`;
  const st = d.phase === 'dive' ? d.stream : 1; bar('gStream', st, st < 0.55 ? C.bad : st < 0.75 ? C.warn : C.good); $('tStream').textContent = `${Math.round(st * 100)}%`;
  const lx = Math.abs(d.x); bar('gLine', lx / 1.5, lx > 1.1 ? C.bad : lx > 0.7 ? C.warn : C.good); $('tLine').textContent = `${lx.toFixed(1)} m`;
  bar('gHr', (d.hr - 35) / 90, C.blue); $('tHr').textContent = `${d.hr}`;

  // lungs: 0..9 L, with the residual volume, the Frenzel limit and a full breath marked
  const W = (lungCv.width = lungCv.clientWidth * 2), H = (lungCv.height = 80), x = (v) => v / 9.2 * W;
  lctx.clearRect(0, 0, W, H);
  lctx.fillStyle = 'rgba(255,255,255,0.1)'; lctx.fillRect(0, 22, W, 26);
  const lv = d.lungV;
  lctx.fillStyle = lv > BODY.TLC ? '#ffc857' : lv < d.frenzelLimit ? '#ff9a6b' : '#7fd0ff'; lctx.fillRect(0, 22, x(lv), 26);
  if (d.nm > 0) { lctx.fillStyle = d.canFrenzel ? '#6fe0b0' : '#ff6b6b'; lctx.fillRect(0, 52, x(d.mouthV * 6), 10); }
  lctx.font = '20px system-ui'; lctx.fillStyle = 'rgba(234,246,255,0.75)';
  for (const [v, t] of [[BODY.RV, 'RV'], [d.frenzelLimit, 'Frenzel'], [BODY.TLC, 'full']]) { lctx.fillRect(x(v), 16, 2, 36); lctx.fillText(t, x(v) + 4, 16); }
  lctx.fillText(`lungs ${lv.toFixed(1)} L${d.nm > 0 ? `  ·  mouth ${(d.mouthV * 1000).toFixed(0)} ml` : ''}`, 4, 78);

  // depth profile
  const PW = (prof.width = 300), PH = (prof.height = 148); pctx.clearRect(0, 0, PW, PH);
  const tr = d.trace, T = Math.max(60, tr.length ? tr[tr.length - 1][0] - tr[0][0] : 60), Dm = Math.max(d.target + 3, 10);
  pctx.strokeStyle = 'rgba(255,255,255,0.25)'; pctx.setLineDash([4, 4]); pctx.beginPath(); pctx.moveTo(0, 8 + d.target / Dm * (PH - 16)); pctx.lineTo(PW, 8 + d.target / Dm * (PH - 16)); pctx.stroke(); pctx.setLineDash([]);
  pctx.strokeStyle = '#7fd0ff'; pctx.lineWidth = 3; pctx.beginPath();
  tr.forEach(([t, dd], i) => { const px = 6 + (t - tr[0][0]) / T * (PW - 12), py = 8 + dd / Dm * (PH - 16); i ? pctx.lineTo(px, py) : pctx.moveTo(px, py); });
  pctx.stroke();

  // breathe-up panel
  if (d.phase === 'breathe') {
    $('sRate').textContent = d.breathRate;
    $('sVent').textContent = d.vent.toFixed(0);
    $('sRelax').textContent = `${Math.round(d.relax * 100)}%`;
    $('sCo2').textContent = d.hypo > 0.35 ? 'washed out' : d.hypo > 0.12 ? 'low' : d.hypo < -0.2 ? 'high' : 'ok';
    $('sCo2').style.color = d.hypo > 0.35 ? C.bad : d.hypo > 0.12 ? C.warn : '';
    $('bLung').style.width = `${(d.lung - 1.5) / (BODY.TLC - 1.5) * 100}%`;
    $('bPack').style.right = '0'; $('bPack').style.width = `${d.packed / BODY.PACK * 30}%`;
    $('bBreathTxt').textContent = d.holding ? 'Let go' : d.inhaling ? 'Inhale…' : 'Breathe';
    $('bPacked').textContent = d.packed > 0.01 ? `+${d.packed.toFixed(1)} L` : '';
  }
  $('bTurn').disabled = !(d.phase === 'dive' && d.headDown && !d.turned && d.turnT === null);
  $('bMf').classList.toggle('on', d.nm > 0);

  // the body: hypoxia narrows the view, ears hurt red, blackout fades to black
  const tunnel = d.blackout ? 1 : clamp((0.35 - o2) / 0.35, 0, 1) * 0.9 + (d.dizzy > 0.2 ? d.dizzy * 0.3 : 0);
  $('vignette').style.opacity = tunnel;
  $('flash').style.opacity = clamp(d.pain * 0.9 * (0.75 + 0.25 * Math.sin(d.t * 9)), 0, 0.9);
  if (d.blackout) $('fade').style.opacity = Math.min(0.85, +$('fade').style.opacity + dt * 0.5);

  // toasts
  for (const e of d.events.splice(0)) toast(e.text);
  const now = performance.now();
  for (const t of toasts) if (now - t.t > 4500) t.el.style.opacity = 0;

  if (d.result && !shownResult) showResult(d.result);
  if (!d.result) shownResult = false;
}

function showResult(r) {
  shownResult = true;
  setTimeout(() => {
    if (dive.result !== r) return;
    $('rChip').className = `chip ${r.card}`;
    $('rTitle').textContent = { white: 'White card', yellow: 'Yellow card', red: 'Red card' }[r.card];
    $('rDepth').textContent = `${r.depth} m`; $('rTime').textContent = fmt(r.time); $('rO2').textContent = `${(r.o2 * 1000).toFixed(0)} ml`;
    const notes = [...r.notes];
    if (r.tag) notes.unshift(`tag from ${r.target} m (${r.discipline})`);
    if (r.packed > 0.05) notes.push(`packed +${r.packed.toFixed(1)} L`);
    if (r.card !== 'red') {
      const k = `${r.discipline}`; const best = store.best?.[k] || 0;
      if (r.score > best) { store.best = { ...store.best, [k]: r.score }; save(); notes.push(`new best ${r.discipline}: ${r.score} m`); }
      else if (best) notes.push(`best ${r.discipline}: ${best} m`);
    }
    $('rNotes').innerHTML = notes.map((n) => `<li>${n}</li>`).join('');
    $('result').classList.add('show');
  }, dive.blackout ? 2500 : 600);
}

// ---- frame
const _target = new THREE.Vector3(), _col = new THREE.Color();
let last = performance.now(), paused = Q.has('pause'), shake = 0, beatT = 0;
function frame(dt) {
  const d = dive;
  if (bot) bot.update(dt); else d.setLean(leanInput());
  d.step(dt);
  fig.update(dt, d);
  fig.group.position.set(d.x, d.y, 0.12);

  // the camera beside the line, a little above and ahead of the diver, kept under the surface
  _target.set(d.x * 0.6, d.y, 0);
  const lead = clamp(d.vy, -1.5, 1.5) * 0.5;
  cam.x = ease(cam.x, _target.x + cam.dist * 0.15, dt, 3);
  cam.y = ease(cam.y, Math.min(-0.25, _target.y + 0.35 + lead), dt, 3);
  cam.z = ease(cam.z, cam.dist, dt, 3);
  if (d.lmc && d.phase === 'surface') shake = 0.06;
  shake = ease(shake, 0, dt, 1.5);
  camera.position.set(cam.x + (Math.random() - 0.5) * shake, cam.y + (Math.random() - 0.5) * shake, cam.z);
  camera.lookAt(_target.x, Math.min(-0.15, _target.y + lead), 0);
  if (d.vertigo > 0) camera.rotateZ(d.vertigo * 0.5 * Math.sin(d.t * 0.9) + d.vertigo * 0.2 * Math.sin(d.t * 2.3));

  // the water's colour and the light at the camera's depth
  const cd = Math.max(0, -camera.position.y);
  waterAt(cd, _col); scene.background.copy(_col); scene.fog.color.copy(_col);
  scene.fog.density = 0.035 + 0.035 * clamp(cd / 40, 0, 1);
  hemi.intensity = 0.4 + 1.4 * Math.exp(-cd / 18); sun.intensity = 2.4 * Math.exp(-cd / 12);
  renderer.toneMappingExposure = 0.9 + 0.5 * clamp(cd / 40, 0, 1);
  surfMat.uniforms.uT.value = d.t;
  for (const s of shafts) { const u = s.userData; s.position.x = u.x + Math.sin(d.t * u.sp + u.ph) * 0.6 + camera.position.x * 0.8; s.material.opacity = (0.08 + 0.1 * (0.5 + 0.5 * Math.sin(d.t * u.sp * 1.7 + u.ph))) * Math.exp(-cd / 14); }
  // the snow wraps round the camera
  const p = snowPos;
  for (let i = 0; i < SNOW; i++) {
    const k = i * 3;
    p[k] = wrap(p[k], camera.position.x, SB.x); p[k + 1] = wrap(p[k + 1], camera.position.y - 1, SB.y); p[k + 2] = wrap(p[k + 2], -1, SB.z);
    if (p[k + 1] > -0.1) p[k + 1] -= SB.y;
  }
  snowGeo.attributes.position.needsUpdate = true;
  if (neutralMark) { const nd = d.neutralDepth; neutralMark.visible = nd > 1 && nd < d.target + 2 && d.phase !== 'done'; neutralMark.position.y = -nd; }

  // sound: the heart, slowing with the dive reflex; a thump for each contraction
  beatT += dt;
  if (d.phase !== 'breathe' && !d.blackout && beatT > 60 / Math.max(30, d.hr)) { beatT = 0; audio.beat(clamp(0.4 + d.urge * 0.2, 0, 1)); }

  hud(dt);
  renderer.render(scene, camera);
}
const wrap = (v, c, size) => { const r = v - c; return r > size / 2 ? v - size : r < -size / 2 ? v + size : v; };

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  camera.fov = w < h ? 58 : 42; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize(); reset();

function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (!paused) frame(dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// for smoke.js
window.__depthcomp = {
  get dive() { return dive; }, fig, camera,
  step(n = 1, dt = 1 / 30) { for (let i = 0; i < n; i++) frame(dt); },
  // the dive alone, no drawing (SwiftShader is slow): then step() a few frames to draw it
  advance(sec, dt = 1 / 30) { for (let t = 0; t < sec; t += dt) { if (bot) bot.update(dt); else dive.setLean(leanInput()); dive.step(dt); if (dive.phase === 'done') break; } },
  until(cond, max = 400, dt = 1 / 30) { const f = new Function('d', `return (${cond})`); for (let t = 0; t < max && !f(dive); t += dt) { if (bot) bot.update(dt); dive.step(dt); } return f(dive); },
  press, release, reset, opts,
  hold(code, on) { if (on) held.add(code); else held.delete(code); },
  leanInput,
  demo(on = true) { demo = on; reset(); },
};

if ('serviceWorker' in navigator && !Q.has('nosw') && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

/*
 * app.js - Aquarelle UI: input (pen / touch / mouse), view (pan, zoom, rotate), palette,
 * tools, undo, autosave and export, around the simulation in sim.js.
 */
import { Sim } from './sim.js';
import { makePaper, PAPERS } from './paper.js';
import { PIGMENTS, mix, swatch, rgbToHex, customPigment, mass, hexToRgb, srgbToLinear } from './km.js';
import { strokeStamps, Smoother, BRUSHES, splatterDrops } from './brush.js';

const $ = (s) => document.querySelector(s);
const qs = new URLSearchParams(location.search);
const canvas = $('#gl');
const toastEl = $('#toast');
let toastT = 0;
function toast(msg, ms = 1600) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), ms); }
function fatal(msg) { const e = $('#err'); e.style.display = 'block'; e.innerHTML = '<h2>Aquarelle cannot start</h2><p></p>'; e.querySelector('p').textContent = msg; throw new Error(msg); }

// ---------- settings ----------
const SIZES = { S: [1200, 900], M: [1600, 1200], L: [2400, 1800] };
const TINTS = { white: [1, 1, 1], natural: [0.95, 0.94, 0.905], cream: [0.94, 0.905, 0.82], grey: [0.74, 0.73, 0.70], blue: [0.70, 0.75, 0.79], black: [0.17, 0.17, 0.18] };
const DEF = { tool: 'round', paper: 'cold', tint: 'white', texture: false, sheet: 'M', drying: 1, runDry: true, fingers: 'auto', smooth: 0.3, rotate: true, pig: ['ultra'], weights: [1],
  brush: Object.fromEntries(Object.entries(BRUSHES).map(([k, b]) => [k, { size: b.size, water: b.water, paint: b.paint }])), customs: [], helpSeen: false };
let S;
try { S = { ...DEF, ...JSON.parse(localStorage.getItem('aquarelle-classic:settings') || '{}') }; } catch { S = { ...DEF }; }
// the sheet takes the screen's orientation the first time (a phone held upright gets a portrait sheet)
DEF.portrait = innerHeight > innerWidth * 1.15;
S.portrait ??= DEF.portrait;
if (qs.has('fresh')) S = structuredClone(DEF), S.helpSeen = true;
for (const k in DEF.brush) S.brush[k] ??= { ...DEF.brush[k] };
S.brush.water ??= { size: 30, water: 0.8, paint: 0 }; S.brush.lift ??= { size: 24, water: 0.3, paint: 0 }; S.brush.erase ??= { size: 30, water: 0, paint: 0 };
const saveSettings = () => { try { localStorage.setItem('aquarelle-classic:settings', JSON.stringify(S)); } catch { /* private mode */ } };

const allPigments = () => [...PIGMENTS, ...S.customs.map((c) => customPigment(c.hex, c.op, c.gran))];
const pigById = (id) => allPigments().find((p) => p.id === id) || PIGMENTS[0];

// ---------- GL + sim ----------
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true });
if (!gl) fatal('WebGL2 is not available in this browser.');
let sim, paper;
let dpr = Math.min(window.devicePixelRatio || 1, 2);
const view = { x: 0, y: 0, z: 1, r: 0 };
let needsRender = true;
function makeSim() {
  let [W, H] = SIZES[S.sheet] || SIZES.M;
  if (S.portrait) [W, H] = [H, W];
  paper = makePaper(S.paper, 512, 3);
  try { sim?.dispose(); sim = new Sim(gl, W, H, paper); } catch (e) { fatal(e.message); }
  sim.speed = S.drying;
  applyLook();
}
makeSim();

/** Paper colour and whether its relief is drawn (the physics always uses the paper's grain). */
function applyLook() { sim.setLook(TINTS[S.tint].map(srgbToLinear), S.texture ? 1 : 0); needsRender = true; }

// ---------- view ----------

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * dpr); canvas.height = Math.round(innerHeight * dpr);
  needsRender = true;
}
function fit() {
  const pad = innerWidth < 720 ? 16 : 90, W = sim.W, H = sim.H;
  const z = Math.min((innerWidth - pad * 2) / W, (innerHeight - pad * 1.6 - 60) / H);
  view.z = z; view.r = 0; view.x = (innerWidth - W * z) / 2; view.y = (innerHeight - H * z) / 2 - (innerWidth < 720 ? 10 : 6);
  needsRender = true;
}
const toSheet = (cx, cy) => { const c = Math.cos(view.r), s = Math.sin(view.r), dx = cx - view.x, dy = cy - view.y; return { x: (c * dx + s * dy) / view.z, y: (-s * dx + c * dy) / view.z }; };
const toScreen = (sx, sy) => { const c = Math.cos(view.r), s = Math.sin(view.r); return { x: view.z * (c * sx - s * sy) + view.x, y: view.z * (s * sx + c * sy) + view.y }; };
function invMat() {
  const c = Math.cos(view.r), s = Math.sin(view.r), z = view.z, a = c / z, b = s / z, cc = -s / z, d = c / z;
  return [a, cc, 0, b, d, 0, -(a * view.x + b * view.y), -(cc * view.x + d * view.y), 1];
}
function zoomAt(cx, cy, f) {
  const nz = Math.min(12, Math.max(0.15, view.z * f)); const p = toSheet(cx, cy); view.z = nz;
  const q = toScreen(p.x, p.y); view.x += cx - q.x; view.y += cy - q.y; needsRender = true;
}
resize(); fit();
addEventListener('resize', () => { resize(); if (!userMovedView) fit(); });
let userMovedView = false;

// ---------- brush state ----------
let loaded; // {K,S,gran,lift}
function loadBrush() {
  const parts = S.pig.map((id, i) => ({ p: pigById(id), w: S.weights[i] ?? 1 }));
  loaded = mix(parts);
  drawMixWell();
}
const isPaintTool = (t) => t in BRUSHES;
function brushVec(conc) {
  const m = mass(loaded);
  return { bK: [...loaded.K.map((k) => k * conc), loaded.gran * m * conc], bS: [...loaded.S.map((s) => s * conc), loaded.lift * m * conc] };
}
const concOf = (paint) => 0.1 + 4.5 * paint * paint;

// ---------- painting ----------
let stroke = null; // {tool, sm, last, rest, load, seed, kind}
let seedCounter = 1;

function sampleOf(e, rect) {
  const p = toSheet(e.clientX, e.clientY);
  let pr = e.pressure;
  if (e.pointerType !== 'pen' || !pr) pr = null;
  // tilt: altitude 0 (flat) .. pi/2 (upright), azimuth around the screen
  let alt = Math.PI / 2, az = 0;
  if (e.pointerType === 'pen') {
    if (typeof e.altitudeAngle === 'number' && e.altitudeAngle > 0) { alt = e.altitudeAngle; az = e.azimuthAngle || 0; }
    else if (e.tiltX || e.tiltY) { const tx = e.tiltX * Math.PI / 180, ty = e.tiltY * Math.PI / 180; alt = Math.PI / 2 - Math.min(Math.PI / 2, Math.hypot(tx, ty)); az = Math.atan2(ty, tx); }
  }
  return { x: p.x, y: p.y, p: pr, t: e.timeStamp || performance.now(), alt, az: az - view.r, type: e.pointerType };
}

function beginStroke(e, tool) {
  sim.begin();
  stroke = { tool, sm: new Smoother(tool === 'detail' ? Math.min(0.9, S.smooth + 0.2) : S.smooth), last: null, rest: 0, load: 1, seed: seedCounter++, v: 0, len: 0, type: e.pointerType };
  addSample(sampleOf(e));
  updateUndoButtons();
}

function addSample(q) {
  if (!stroke) return;
  const s = stroke.sm.push(q);
  emit(s);
}

function emit(s) {
  const st = stroke, tool = st.tool, B = BRUSHES[tool] || BRUSHES.round, cfg = S.brush[tool] || S.brush.round;
  if (st.last) {
    const dt = Math.max(1, s.t - st.last.t), d = Math.hypot(s.x - st.last.x, s.y - st.last.y);
    st.v = st.v * 0.7 + (d / dt) * 0.3; // sheet px per ms
  }
  // pressure: from the pen, else from speed (slow = heavy)
  const sp = Math.min(1, st.v * view.z / 2.5);
  const pr = s.p != null ? s.p : (st.type === 'mouse' ? 0.62 - 0.25 * sp : 0.7 - 0.3 * sp);
  const tilt = 1 - s.alt / (Math.PI / 2); // 0 upright .. 1 flat
  const shape = tool in BRUSHES ? B.shape : 0;
  const sizeP = tool in BRUSHES ? B.sizePressure : 0.4;
  let r = cfg.size * (1 - sizeP + sizeP * Math.pow(Math.max(pr, 0.03), 0.8)) * (1 + tilt * 0.8);
  if (tool === 'wash') r = cfg.size * (0.75 + 0.25 * pr);
  const el = 1 + tilt * 1.8 + (tool === 'wash' ? 0.5 : 0);
  // a flat mop is held across the stroke; a tilted pen lies along its azimuth
  const ex = tilt > 0.05 ? -Math.sin(s.az) : 0, ey = tilt > 0.05 ? Math.cos(s.az) : 1;
  const point = { x: s.x, y: s.y, p: pr, t: s.t, r, el, ex, ey };
  if (!st.last) { st.last = point; put([{ ...point, dx: 1, dy: 0 }], true); return; }
  const spacing = Math.max(0.6, r * (B.spacing || 0.18));
  const { stamps, rest } = strokeStamps(st.last, point, spacing, st.rest);
  st.rest = rest; st.len += Math.hypot(point.x - st.last.x, point.y - st.last.y); st.last = point;
  if (stamps.length) put(stamps, false);
}

/** Turn resampled points into sim stamps for the current tool. */
function put(points, first) {
  const st = stroke, tool = st.tool, cfg = S.brush[tool] || S.brush.round, B = BRUSHES[tool];
  const sp = Math.min(1, st.v * view.z / 3);
  const out = [];
  for (const q of points) {
    const s = { x: q.x, y: q.y, r: q.r, a: 1, dx: q.dx ?? 1, dy: q.dy ?? 0, seed: st.seed, ex: q.ex, ey: q.ey, el: q.el, dry: 0, wt: 0 };
    if (tool === 'erase') { s.a = 0.9; out.push(s); continue; }
    if (tool === 'lift') { s.a = 0.8; out.push(s); continue; }
    if (tool === 'pick') continue;
    // brush load: the hairs empty along the stroke, and a fast stroke leaves less water
    const usage = (q.r * (B?.spacing || 0.18)) / (380 + cfg.water * 1400) * (tool === 'wash' ? 0.5 : 1);
    if (S.runDry && tool !== 'water') st.load = Math.max(0, st.load - usage);
    const load = S.runDry ? st.load : 1;
    let water = cfg.water * (0.25 + 0.75 * Math.sqrt(load)) * (1 - 0.45 * sp) * (0.75 + 0.35 * (q.p ?? 0.6));
    let dry = 0;
    if (tool === 'dry') dry = Math.min(1, 0.55 + 0.45 * (1 - cfg.water) + sp * 0.2);
    else if (tool !== 'water') dry = Math.max(0, Math.min(0.85, (0.32 - water) * 3.2));
    s.dry = dry; s.wt = Math.max(0.04, water) * (tool === 'dry' ? 0.6 : 1);
    if (tool === 'splatter') {
      if (Math.random() > 0.55 && !first) continue;
      for (const d of splatterDrops(s, q.r, st.seed * 7919 + Math.floor(q.x * 13 + q.y * 7))) out.push({ ...d, el: 1, ex: 1, ey: 0, dry: 0, wt: 0.25 + 0.5 * cfg.water, a: 1 });
      continue;
    }
    out.push(s);
  }
  if (!out.length) return;
  const mode = tool === 'water' ? 1 : tool === 'lift' ? 2 : tool === 'erase' ? 3 : 0;
  // dry brush carries thick paint: same pigment in far less water
  const conc = concOf(cfg.paint) * (tool === 'dry' ? 3.5 : 1);
  const shape = tool === 'splatter' ? 3 : B ? B.shape : 0;
  sim.stamp(out, { mode, shape, ...(mode === 0 ? brushVec(conc) : { bK: [0, 0, 0, 0], bS: [0, 0, 0, 0] }), mix: tool === 'splatter' ? 0.95 : tool === 'wash' ? 0.3 : 0.22 });
  needsRender = true;
}

function endStroke() {
  if (!stroke) return;
  for (const q of stroke.sm.finish()) emit(q);
  stroke = null;
  updateUndoButtons(); scheduleSave();
}

// ---------- colour pick ----------
function pickAt(cx, cy) {
  render();
  const px = new Uint8Array(4 * 25);
  const x = Math.round(cx * dpr), y = Math.round(canvas.height - cy * dpr);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let r = 0, g = 0, b = 0; for (let i = 0; i < 25; i++) { r += px[i * 4]; g += px[i * 4 + 1]; b += px[i * 4 + 2]; }
  const hex = rgbToHex([r / 25 / 255, g / 25 / 255, b / 25 / 255]);
  // paper itself: nothing to pick
  const pc = TINTS[S.tint].map((v) => Math.round(v * 255));
  if (Math.abs(r / 25 - pc[0]) + Math.abs(g / 25 - pc[1]) + Math.abs(b / 25 - pc[2]) < 24) { toast('That is bare paper'); return; }
  addCustom(hex, 0.12);
  toast('Picked ' + hex);
}
function addCustom(hex, op = 0.15) {
  S.customs = S.customs.filter((c) => c.hex !== hex);
  S.customs.unshift({ hex, op, gran: 0.15 });
  S.customs = S.customs.slice(0, 6);
  const p = customPigment(hex, op, 0.15);
  S.pig = [p.id]; S.weights = [1];
  if (!isPaintTool(S.tool)) setTool('round');
  buildWells(); loadBrush(); saveSettings();
}

// ---------- input ----------
const touches = new Map(); // pointerId -> {x, y, x0, y0, t0}
let penSeen = qs.get('pen') === '1';
let gesture = null; // {pts:[sheet points], ...}
let tapCand = null; // multi-finger tap candidate
let pendingTouch = null; // first finger waiting to see if a second one comes
let mouseDrag = null, spaceDown = false;
let hoverPt = null;
let lpTimer = 0;

const fingersNavigate = () => S.fingers === 'auto' && penSeen;

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  closePops();
  canvas.setPointerCapture?.(e.pointerId);
  if (e.pointerType === 'pen') penSeen = true;
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
    if (touches.size === 1) tapCand = { n: 1, t0: performance.now(), moved: false };
    else if (tapCand) tapCand.n = Math.max(tapCand.n, touches.size);
    if (touches.size >= 2) {
      // a second finger: cancel the waiting stroke, or finish the one in progress
      if (pendingTouch) { pendingTouch = null; clearTimeout(lpTimer); }
      if (stroke && stroke.type === 'touch') {
        // the first finger only just started painting: that was the start of a pinch, take it back
        const young = performance.now() - stroke0 < 250;
        endStroke(); if (young) { sim.discardLast(); updateUndoButtons(); }
      }
      startGesture();
      return;
    }
    if (fingersNavigate()) { startGesture(); return; }
    // wait briefly: a second finger means navigation
    pendingTouch = { e: copyEv(e), evs: [], t0: performance.now() };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => { if (pendingTouch && !pendingTouch.moved) { const p = pendingTouch; pendingTouch = null; tapCand = null; pickAt(p.e.clientX, p.e.clientY); } }, 550);
    return;
  }
  if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || spaceDown)) { mouseDrag = { x: e.clientX, y: e.clientY }; canvas.style.cursor = 'grabbing'; return; }
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  if (e.altKey || S.tool === 'pick') { pickAt(e.clientX, e.clientY); if (S.tool === 'pick') setTool(lastPaintTool); return; }
  stroke0 = performance.now();
  beginStroke(e, S.tool);
});
let stroke0 = 0;
const copyEv = (e) => ({ clientX: e.clientX, clientY: e.clientY, pressure: e.pressure, pointerType: e.pointerType, timeStamp: e.timeStamp, tiltX: 0, tiltY: 0 });

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    const t = touches.get(e.pointerId); t.x = e.clientX; t.y = e.clientY;
    if (Math.hypot(t.x - t.x0, t.y - t.y0) > 10 && tapCand) tapCand.moved = true;
    if (gesture) { moveGesture(); return; }
    if (pendingTouch) {
      pendingTouch.evs.push(...(e.getCoalescedEvents ? e.getCoalescedEvents() : [e]).map(copyEv));
      const moved = Math.hypot(e.clientX - pendingTouch.e.clientX, e.clientY - pendingTouch.e.clientY);
      if (moved > 8 || performance.now() - pendingTouch.t0 > 60) {
        const p = pendingTouch; pendingTouch = null; clearTimeout(lpTimer); tapCand = null;
        stroke0 = performance.now();
        beginStroke(p.e, S.tool === 'pick' ? lastPaintTool : S.tool);
        for (const q of p.evs) addSample(sampleOf(q));
      }
      return;
    }
  }
  if (mouseDrag) { view.x += e.clientX - mouseDrag.x; view.y += e.clientY - mouseDrag.y; mouseDrag = { x: e.clientX, y: e.clientY }; userMovedView = true; needsRender = true; return; }
  hoverPt = { x: e.clientX, y: e.clientY, type: e.pointerType, p: e.pressure };
  if (stroke && (e.pointerType !== 'touch' || stroke.type === 'touch')) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const q of evs.length ? evs : [e]) addSample(sampleOf(q));
  }
  updateCursor();
});

function pointerEnd(e) {
  if (e.pointerType === 'touch') {
    const had = touches.has(e.pointerId);
    touches.delete(e.pointerId);
    if (!had) return;
    if (pendingTouch) {
      // a tap with one finger: a dab of paint
      const p = pendingTouch; pendingTouch = null; clearTimeout(lpTimer);
      if (!fingersNavigate()) { stroke0 = performance.now(); beginStroke(p.e, S.tool === 'pick' ? lastPaintTool : S.tool); for (const q of p.evs) addSample(sampleOf(q)); endStroke(); }
      tapCand = null;
      return;
    }
    if (stroke && stroke.type === 'touch') endStroke();
    if (touches.size === 0) {
      if (tapCand && !tapCand.moved && performance.now() - tapCand.t0 < 320 && tapCand.n >= 2) { if (tapCand.n === 2) doUndo(); else doRedo(); }
      tapCand = null; gesture = null;
    } else if (gesture) startGesture();
    return;
  }
  if (mouseDrag) { mouseDrag = null; canvas.style.cursor = ''; return; }
  if (stroke) endStroke();
}
canvas.addEventListener('pointerup', pointerEnd);
canvas.addEventListener('pointercancel', pointerEnd);
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') { hoverPt = null; updateCursor(); } });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function startGesture() {
  const pts = [...touches.values()].slice(0, 2);
  if (pts.length === 1) { gesture = { one: true, s: toSheet(pts[0].x, pts[0].y) }; return; }
  gesture = { a: toSheet(pts[0].x, pts[0].y), b: toSheet(pts[1].x, pts[1].y), r0: view.r, ang0: Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x), rotOn: false };
}
function moveGesture() {
  const pts = [...touches.values()].slice(0, 2);
  userMovedView = true; needsRender = true;
  if (gesture.one || pts.length < 2) {
    const s = gesture.s || (gesture.s = toSheet(pts[0].x, pts[0].y));
    const q = toScreen(s.x, s.y); view.x += pts[0].x - q.x; view.y += pts[0].y - q.y; return;
  }
  const { a, b } = gesture;
  const dS = Math.hypot(b.x - a.x, b.y - a.y), dC = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
  view.z = Math.min(12, Math.max(0.15, dC / Math.max(dS, 1e-3)));
  if (S.rotate) {
    const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x), angS = Math.atan2(b.y - a.y, b.x - a.x);
    let r = ang - angS;
    // rotation only after a deliberate twist, and it snaps back to square
    if (!gesture.rotOn && Math.abs(((ang - gesture.ang0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > 0.2) gesture.rotOn = true;
    if (gesture.rotOn) {
      const snap = Math.round(r / (Math.PI / 2)) * (Math.PI / 2);
      if (Math.abs(r - snap) < 0.08) r = snap;
      view.r = r;
    }
  }
  // put sheet point a under finger 0
  const q = toScreen(a.x, a.y); view.x += pts[0].x - q.x; view.y += pts[0].y - q.y;
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault(); userMovedView = true;
  if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 40 && !e.deltaX && e.deltaMode === 0 && !e.shiftKey) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  else { view.x -= e.deltaX; view.y -= e.deltaY; needsRender = true; }
}, { passive: false });
// Safari trackpad pinch
addEventListener('gesturestart', (e) => e.preventDefault());
addEventListener('gesturechange', (e) => e.preventDefault());

function updateCursor() {
  const c = $('#cursor');
  if (!hoverPt || hoverPt.type === 'touch' || gesture || mouseDrag) { c.style.display = 'none'; canvas.style.cursor = mouseDrag ? 'grabbing' : spaceDown ? 'grab' : ''; return; }
  canvas.style.cursor = spaceDown ? 'grab' : 'none';
  const cfg = S.brush[S.tool] || S.brush.round;
  const r = S.tool === 'pick' ? 6 : Math.max(2, cfg.size * view.z * (S.tool in BRUSHES ? (1 - BRUSHES[S.tool].sizePressure * 0.35) : 1));
  c.style.display = spaceDown ? 'none' : 'block';
  c.style.width = c.style.height = 2 * r + 'px';
  c.style.transform = `translate(${hoverPt.x - r}px, ${hoverPt.y - r}px)`;
  c.style.borderStyle = S.tool === 'erase' ? 'dashed' : 'solid';
}

// ---------- keys ----------
const KEYS = { b: 'round', w: 'wash', r: 'detail', y: 'dry', s: 'splatter', q: 'water', l: 'lift', e: 'erase', i: 'pick' };
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if ((e.metaKey || e.ctrlKey) && k === 'y') { e.preventDefault(); doRedo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ') { spaceDown = true; updateCursor(); e.preventDefault(); return; }
  if (KEYS[k]) { setTool(KEYS[k]); return; }
  if (k === '[' || k === ']') { const cfg = S.brush[S.tool]; if (cfg) { cfg.size = Math.max(1, Math.min(160, cfg.size * (k === ']' ? 1.15 : 1 / 1.15))); syncSliders(); updateCursor(); saveSettings(); } return; }
  if (k === 'f') { sim.dryNow(); needsRender = true; scheduleSave(); return; }
  if (k === '0') { userMovedView = false; fit(); return; }
  if (k === 'tab') { e.preventDefault(); document.body.classList.toggle('ui-hidden'); return; }
  if (k === '?' || k === 'h') { toggleHelp(); return; }
  if (/^[1-9]$/.test(k)) { const p = PIGMENTS[+k - 1]; if (p) choosePigment(p.id, e.shiftKey); }
});
addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; updateCursor(); } });

// ---------- tools + sliders ----------
let lastPaintTool = 'round';
function setTool(t) {
  if (t !== 'pick' && t !== 'lift' && t !== 'erase' && t !== 'water') lastPaintTool = t;
  S.tool = t;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  syncSliders(); updateCursor(); saveSettings();
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

const sliders = {
  sSize: { key: 'size', min: 1, max: 160, curve: 2.2, fmt: (v) => Math.round(v) + '' },
  sWater: { key: 'water', min: 0, max: 1, curve: 1, fmt: (v) => Math.round(v * 100) + '%' },
  sPaint: { key: 'paint', min: 0, max: 1, curve: 1, fmt: (v) => Math.round(v * 100) + '%' },
};
function syncSliders() {
  const cfg = S.brush[S.tool] || S.brush.round;
  for (const id in sliders) {
    const sl = sliders[id], el = document.getElementById(id), v = cfg[sl.key] ?? 0;
    const t = Math.pow((v - sl.min) / (sl.max - sl.min), 1 / sl.curve);
    el.querySelector('.fill').style.height = t * 100 + '%';
    el.querySelector('.knob').style.top = (1 - t) * 100 + '%';
    el.querySelector('.val').textContent = sl.fmt(v);
    const usable = !(S.tool === 'pick' || (sl.key === 'paint' && !isPaintTool(S.tool)) || (sl.key === 'water' && S.tool === 'erase'));
    el.style.opacity = usable ? 1 : 0.3; el.style.pointerEvents = usable ? '' : 'none';
  }
  drawMixWell();
}
for (const id in sliders) {
  const el = document.getElementById(id), sl = sliders[id];
  let drag = null;
  const set = (e) => {
    const r = el.querySelector('.track').getBoundingClientRect();
    // relative drag so a touch does not jump the value; precision when dragging sideways
    const dy = (e.clientY - drag.y) / r.height * (1 / (1 + Math.abs(e.clientX - drag.x) / 60));
    const t = Math.min(1, Math.max(0, drag.t - dy));
    const cfg = S.brush[S.tool]; if (!cfg) return;
    cfg[sl.key] = sl.min + Math.pow(t, sl.curve) * (sl.max - sl.min);
    syncSliders();
    if (sl.key === 'size') showSizePreview(cfg.size);
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); el.setPointerCapture(e.pointerId);
    const cfg = S.brush[S.tool]; if (!cfg) return;
    const r = el.querySelector('.track').getBoundingClientRect();
    let t = Math.pow((cfg[sl.key] - sl.min) / (sl.max - sl.min), 1 / sl.curve);
    // tapping the track away from the knob jumps there
    const ky = r.top + (1 - t) * r.height;
    if (Math.abs(e.clientY - ky) > 22) t = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    drag = { y: e.clientY, x: e.clientX, t };
    set(e);
  });
  el.addEventListener('pointermove', (e) => { if (drag) set(e); });
  const up = () => { if (drag) { drag = null; hideSizePreview(); saveSettings(); } };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
function showSizePreview(size) {
  const c = $('#cursor'), r = Math.max(2, size * view.z);
  c.style.display = 'block'; c.style.width = c.style.height = 2 * r + 'px';
  c.style.transform = `translate(${innerWidth / 2 - r}px, ${innerHeight / 2 - r}px)`;
}
function hideSizePreview() { $('#cursor').style.display = 'none'; }

// ---------- palette ----------
let mixMode = false;
function wellColour(p) { return rgbToHex(swatch(p, 1.1, TINTS[S.tint].map((v) => Math.min(1, v)))); }
function buildWells() {
  const box = $('#wells'); box.innerHTML = '';
  for (const p of allPigments()) {
    const b = document.createElement('button'); b.className = 'well'; b.dataset.id = p.id;
    // masstone at the centre, a thin wash at the rim, like a dried pan
    b.style.background = `radial-gradient(circle at 45% 40%, ${wellColour(p)} 0 48%, ${rgbToHex(swatch(p, 0.35, TINTS[S.tint]))} 70%, ${rgbToHex(swatch(p, 0.12, TINTS[S.tint]))})`;
    b.title = p.name;
    let lp = 0, longed = false;
    b.addEventListener('pointerdown', (e) => { longed = false; lp = setTimeout(() => { longed = true; choosePigment(p.id, true); showPigInfo(p); }, 480); });
    const cancel = () => clearTimeout(lp);
    b.addEventListener('pointerup', cancel); b.addEventListener('pointerleave', cancel); b.addEventListener('pointercancel', cancel);
    b.addEventListener('click', (e) => { if (longed) return; choosePigment(p.id, e.shiftKey || mixMode); });
    box.appendChild(b);
  }
  const add = document.createElement('button'); add.className = 'well'; add.title = 'Custom colour';
  add.style.background = 'conic-gradient(#d8483a, #e9c23c, #5aa252, #2f7fc1, #7a4fb3, #d8483a)';
  add.addEventListener('click', () => $('#customColor').click());
  box.appendChild(add);
  markWells();
}
function markWells() {
  document.querySelectorAll('.well[data-id]').forEach((w) => { const i = S.pig.indexOf(w.dataset.id); w.classList.toggle('on', i >= 0 && S.pig.length === 1); w.classList.toggle('part', i >= 0 && S.pig.length > 1); });
}
function choosePigment(id, add) {
  if (add && S.pig.length) {
    const i = S.pig.indexOf(id);
    if (i >= 0) S.weights[i] += 1; else { S.pig.push(id); S.weights.push(1); }
    if (S.pig.length > 4) { S.pig.shift(); S.weights.shift(); }
  } else { S.pig = [id]; S.weights = [1]; }
  if (!isPaintTool(S.tool)) setTool(lastPaintTool);
  loadBrush(); markWells(); saveSettings();
}
function drawMixWell() {
  const c = $('#mixWell canvas'), g = c.getContext('2d'), N = c.width;
  const id = g.createImageData(N, N), bg = TINTS[S.tint];
  const cfg = S.brush[S.tool] || S.brush[lastPaintTool], amt = concOf(cfg.paint ?? 0.5) * (0.35 + 0.65 * (cfg.water ?? 0.6));
  // a stroke from thin wash (left) to full load (right)
  const cache = new Map();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x - N / 2, dy = y - N / 2, d = Math.hypot(dx, dy) / (N / 2), i = (y * N + x) * 4;
    if (d > 1) { id.data[i + 3] = 0; continue; }
    const t = Math.round(Math.min(1, Math.max(0, (x / N) * 1.25 - 0.1 + dy / N * 0.2)) * 24) / 24;
    let col = cache.get(t);
    if (!col) { col = swatch(loaded, amt * (0.15 + 0.85 * t), bg); cache.set(t, col); }
    id.data[i] = col[0] * 255; id.data[i + 1] = col[1] * 255; id.data[i + 2] = col[2] * 255; id.data[i + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  const names = S.pig.map((p) => pigById(p).name);
  $('#mixName').textContent = names.length > 1 ? names.map((n, i) => (S.weights[i] > 1 ? S.weights[i] + '× ' : '') + n.split(' ').pop()).join(' + ') : names[0];
  const p = pigById(S.pig[0]);
  $('#mixNote').textContent = S.pig.length > 1 ? 'mixed on the brush' : p.note || '';
}
$('#mixToggle').addEventListener('click', () => { mixMode = !mixMode; $('#mixToggle').classList.toggle('on', mixMode); toast(mixMode ? 'Mixing: tap pigments to add them to the brush' : 'Tap a pigment to load it'); });
$('#mixWell').addEventListener('click', () => showPigInfo(pigById(S.pig[0])));
$('#customColor').addEventListener('change', (e) => addCustom(e.target.value, 0.2));

function showPigInfo(p) {
  const el = $('#pigInfo');
  const g = (v) => ['none', 'slight', 'some', 'strong', 'heavy'][Math.min(4, Math.round(v * 4))];
  el.innerHTML = `<h3>${S.pig.length > 1 ? 'Mix' : 'Pigment'}</h3>`;
  for (const [i, id] of S.pig.entries()) {
    const q = pigById(id);
    const row = document.createElement('div'); row.className = 'row';
    row.innerHTML = `<span style="display:flex;gap:10px;align-items:center"><span class="chip" style="background:${wellColour(q)}"></span><span>${q.name}<small style="display:block;color:var(--dim)">${q.note || ''} · granulation ${g(q.gran)} · ${q.lift < 0.3 ? 'staining' : q.lift > 0.7 ? 'lifts easily' : 'lifts'}</small></span></span>`;
    if (S.pig.length > 1) {
      const x = document.createElement('button'); x.textContent = '×'; x.style.cssText = 'font-size:18px;padding:0 8px;color:var(--dim)';
      x.onclick = () => { S.pig.splice(i, 1); S.weights.splice(i, 1); loadBrush(); markWells(); saveSettings(); showPigInfo(pigById(S.pig[0])); };
      row.appendChild(x);
    }
    el.appendChild(row);
  }
  el.classList.add('open');
}

// ---------- menu ----------
function closePops() { document.querySelectorAll('.pop.open').forEach((p) => { if (p.id !== 'help') p.classList.remove('open'); }); }
$('#menuBtn').addEventListener('click', (e) => { e.stopPropagation(); const m = $('#menu'); const open = !m.classList.contains('open'); closePops(); m.classList.toggle('open', open); });
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.pop') && !e.target.closest('#menuBtn') && !e.target.closest('.well') && !e.target.closest('#mixWell')) closePops(); });

function buildMenu() {
  const pl = $('#paperList'); pl.innerHTML = '';
  for (const [k, p] of Object.entries(PAPERS)) {
    const b = document.createElement('button'); b.className = 'item' + (S.paper === k ? ' on' : '');
    b.innerHTML = `<span>${p.name}<small>${p.note}</small></span>`;
    b.onclick = () => { S.paper = k; paper = makePaper(k, 512, 3); sim.setPaper(paper); needsRender = true; saveSettings(); buildMenu(); };
    pl.appendChild(b);
  }
  const tc = $('#tints'); tc.innerHTML = '';
  for (const [k, v] of Object.entries(TINTS)) {
    const b = document.createElement('button'); b.className = 'chip' + (S.tint === k ? ' on' : ''); b.title = k;
    b.style.background = rgbToHex(v);
    b.onclick = () => { S.tint = k; applyLook(); saveSettings(); buildMenu(); buildWells(); drawMixWell(); };
    tc.appendChild(b);
  }
  const ss = $('#sizeSeg'); ss.innerHTML = '';
  for (const k of Object.keys(SIZES)) {
    const b = document.createElement('button'); b.textContent = k; b.title = SIZES[k].join(' × '); b.className = S.sheet === k ? 'on' : '';
    b.onclick = () => { if (S.sheet === k) return; if (!confirm('A new sheet size starts a new painting. Continue?')) return; S.sheet = k; saveSettings(); makeSim(); fit(); updateUndoButtons(); buildMenu(); scheduleSave(); };
    ss.appendChild(b);
  }
  const os = $('#orientSeg'); os.innerHTML = '';
  for (const [v, label] of [[false, 'Landscape'], [true, 'Portrait']]) {
    const b = document.createElement('button'); b.textContent = label; b.className = S.portrait === v ? 'on' : '';
    b.onclick = () => { if (S.portrait === v) return; if (!confirm('Turning the sheet starts a new painting. Continue?')) return; S.portrait = v; saveSettings(); makeSim(); fit(); updateUndoButtons(); buildMenu(); scheduleSave(); };
    os.appendChild(b);
  }
  document.querySelectorAll('#drySeg button').forEach((b) => { b.classList.toggle('on', +b.dataset.v === S.drying); b.onclick = () => { S.drying = +b.dataset.v; sim.speed = S.drying; saveSettings(); buildMenu(); }; });
  document.querySelectorAll('#fingerSeg button').forEach((b) => { b.classList.toggle('on', b.dataset.v === S.fingers); b.onclick = () => { S.fingers = b.dataset.v; saveSettings(); buildMenu(); }; });
  $('#optTexture').checked = S.texture; $('#optTexture').onchange = (e) => { S.texture = e.target.checked; applyLook(); saveSettings(); };
  $('#optLoad').checked = S.runDry; $('#optLoad').onchange = (e) => { S.runDry = e.target.checked; saveSettings(); };
  $('#optSmooth').value = S.smooth; $('#optSmooth').oninput = (e) => { S.smooth = +e.target.value; saveSettings(); };
  $('#optRotate').checked = S.rotate; $('#optRotate').onchange = (e) => { S.rotate = e.target.checked; if (!S.rotate) { view.r = 0; needsRender = true; } saveSettings(); };
}
$('#newBtn').addEventListener('click', () => { sim.clearAll(); needsRender = true; updateUndoButtons(); closePops(); scheduleSave(); toast('New sheet — undo brings the old one back'); });
$('#exportBtn').addEventListener('click', () => { closePops(); exportPNG(); });
$('#shareBtn').addEventListener('click', () => exportPNG());

// ---------- top buttons ----------
function doUndo() { if (stroke) endStroke(); if (sim.undoStep()) { needsRender = true; toast('Undo'); } updateUndoButtons(); scheduleSave(); }
function doRedo() { if (sim.redoStep()) { needsRender = true; toast('Redo'); } updateUndoButtons(); scheduleSave(); }
function updateUndoButtons() { $('#undoBtn').disabled = !sim.canUndo; $('#redoBtn').disabled = !sim.canRedo; }
$('#undoBtn').addEventListener('click', doUndo);
$('#redoBtn').addEventListener('click', doRedo);
let dryHold = false, lastDryTap = 0;
$('#dryBtn').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const now = performance.now();
  if (now - lastDryTap < 330) { sim.dryNow(); needsRender = true; toast('Dried'); scheduleSave(); lastDryTap = 0; return; }
  lastDryTap = now; dryHold = true; $('#dryBtn').classList.add('on');
});
const dryUp = () => { dryHold = false; $('#dryBtn').classList.remove('on'); };
$('#dryBtn').addEventListener('pointerup', dryUp); $('#dryBtn').addEventListener('pointerleave', dryUp); $('#dryBtn').addEventListener('pointercancel', dryUp);

// tilt: off -> board tilted towards you -> follow the device (if it has a gyro)
let tiltMode = 0, devGrav = [0, 0];
$('#tiltBtn').addEventListener('click', async () => {
  tiltMode = (tiltMode + 1) % 3;
  if (tiltMode === 2) {
    try { if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) { if (await DeviceOrientationEvent.requestPermission() !== 'granted') tiltMode = 0; } } catch { tiltMode = 0; }
    if (!('ondeviceorientation' in window) || !matchMedia('(pointer: coarse)').matches) tiltMode = 0;
  }
  $('#tiltBtn').classList.toggle('on', tiltMode > 0);
  toast(['Board flat', 'Board tilted: wet paint runs down the sheet', 'Tilt your device to move wet paint'][tiltMode]);
});
addEventListener('deviceorientation', (e) => {
  if (tiltMode !== 2 || e.beta == null) return;
  const o = (screen.orientation?.angle || 0) * Math.PI / 180;
  let gx = Math.sin((e.gamma || 0) * Math.PI / 180), gy = Math.sin((e.beta || 0) * Math.PI / 180);
  [gx, gy] = [gx * Math.cos(o) + gy * Math.sin(o), -gx * Math.sin(o) + gy * Math.cos(o)];
  devGrav = [gx, gy];
});
function gravity() {
  let g = tiltMode === 1 ? [0, 0.6] : tiltMode === 2 ? devGrav : [0, 0];
  // screen-space gravity into sheet space
  const c = Math.cos(-view.r), s = Math.sin(-view.r);
  g = [c * g[0] - s * g[1], s * g[0] + c * g[1]];
  return [g[0] * 0.012, g[1] * 0.012];
}

// ---------- help ----------
function toggleHelp(force) { const h = $('#help'); h.classList.toggle('open', force ?? !h.classList.contains('open')); if (!h.classList.contains('open')) { S.helpSeen = true; saveSettings(); } }
$('#helpBtn').addEventListener('click', () => { closePops(); toggleHelp(); });
$('#helpClose').addEventListener('click', () => toggleHelp(false));

// ---------- export ----------
async function exportPNG() {
  const px = sim.exportPixels();
  const c = document.createElement('canvas'); c.width = sim.W; c.height = sim.H;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), sim.W, sim.H), 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  const name = `aquarelle-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
  window.__lastExport = { w: sim.W, h: sim.H, bytes: blob.size };
  const file = new File([blob], name, { type: 'image/png' });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: 'Aquarelle' }); return; } catch { /* cancelled */ } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Saved ' + name);
}

// ---------- autosave (IndexedDB, gzip of the dried half-float pigment layers) ----------
// own database: the current app upgrades 'aquarelle' to version 2, which a version-1 open refuses
const DB = 'aquarelle-classic', STORE = 'paintings';
const idb = () => new Promise((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function idbPut(key, val) { const db = await idb(); await new Promise((res, rej) => { const t = db.transaction(STORE, 'readwrite'); t.objectStore(STORE).put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); db.close(); }
async function idbGet(key) { const db = await idb(); const v = await new Promise((res, rej) => { const r = db.transaction(STORE).objectStore(STORE).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); db.close(); return v; }
const gz = async (u8) => (typeof CompressionStream === 'undefined' ? u8 : new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()));
const gunz = async (u8, gzipped) => (gzipped ? new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()) : u8);

let saveT = 0, saving = false, dirty = false;
function scheduleSave() { dirty = true; clearTimeout(saveT); saveT = setTimeout(save, 1800); }
async function save() {
  if (saving || qs.has('nosave')) return;
  if (stroke || sim.wet) { saveT = setTimeout(save, 1500); return; } // save once it has dried
  saving = true;
  try {
    const { K, S: Sc } = await sim.readDried();
    const gzipped = typeof CompressionStream !== 'undefined';
    await idbPut('current', { v: 1, W: sim.W, H: sim.H, sheet: S.sheet, gzipped, K: await gz(new Uint8Array(K.buffer)), S: await gz(new Uint8Array(Sc.buffer)), t: Date.now() });
    dirty = false; window.__saved = (window.__saved || 0) + 1;
  } catch (e) { console.warn('autosave failed', e); }
  saving = false;
}
async function restore() {
  if (qs.has('fresh') || qs.has('nosave')) return;
  try {
    const d = await idbGet('current');
    if (!d || d.v !== 1) return;
    if (d.sheet !== S.sheet || d.W !== sim.W) { S.sheet = d.sheet; S.portrait = d.H > d.W; makeSim(); fit(); }
    const K = new Uint16Array((await gunz(d.K, d.gzipped)).buffer), Sc = new Uint16Array((await gunz(d.S, d.gzipped)).buffer);
    if (K.length !== sim.W * sim.H * 4) return;
    sim.loadDried(K, Sc); needsRender = true; updateUndoButtons();
  } catch (e) { console.warn('restore failed', e); }
}
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) { sim.dryNow(); save(); } });

// ---------- frame loop ----------
let lastT = performance.now();
const statusEl = $('#status'), statusText = $('#statusText');
let wasWet = null;
function render() { sim.render({ inv: invMat(), zoom: view.z }, canvas.width, canvas.height, dpr, { desk: [0.022, 0.022, 0.025] }); }
// Adaptive load: if frames run long while the sheet is wet, take fewer simulation substeps per
// frame (the sim scales flow and drying per substep, so it looks the same, just coarser in
// time); give them back when there is headroom. Brush stamps are never delayed by this.
let frameEma = 16, lastAdapt = 0;
function adapt(t, ms) {
  frameEma = frameEma * 0.9 + Math.min(ms, 100) * 0.1;
  if (!sim.wet || t - lastAdapt < 400) return;
  if (frameEma > 21 && sim.maxSub > 1) { sim.maxSub--; lastAdapt = t; }
  else if (frameEma < 14 && sim.maxSub < 6) { sim.maxSub++; lastAdapt = t + 600; }
}
function frame(t) {
  const ms = t - lastT, dt = Math.min(0.25, ms / 1000); lastT = t;
  adapt(t, ms);
  sim.params.grav = gravity();
  sim.dryBoost = dryHold ? 3 : 0;
  if (sim.step(dt)) needsRender = true;
  if (needsRender) { render(); needsRender = false; }
  const wet = sim.wet;
  if (wet !== wasWet) { statusEl.classList.toggle('wet', wet); statusText.textContent = wet ? 'wet' : 'dry'; wasWet = wet; if (!wet) scheduleSave(); }
  requestAnimationFrame(frame);
}

// ---------- start ----------
buildWells(); buildMenu(); loadBrush(); setTool(S.tool in S.brush ? S.tool : 'round');
if (!S.helpSeen && !qs.has('nohelp')) toggleHelp(true);
await restore();
requestAnimationFrame(frame);
if ('serviceWorker' in navigator && !qs.has('nosw') && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

// test / debugging hook
window.__aq = { get sim() { return sim; }, view, S, get stroke() { return stroke; }, fit, setTool, choosePigment, render, redraw: () => { needsRender = true; }, exportPNG, save, toSheet, toScreen, get penSeen() { return penSeen; } };
window.__ready = true;

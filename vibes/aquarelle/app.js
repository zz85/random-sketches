/*
 * app.js - Aquarelle UI: floating toolbars around the sheet (menu, gallery, wet dot and
 * Pen | Paint top left; undo, redo, hair dryer, tilt, layers, share, full screen, help top
 * right; brushes on the left with size / water / paint sliders beside them; the pigment
 * palette along the bottom, or the pen bar in pen mode). Input (pen / touch / mouse), view
 * (pan, zoom, rotate, flip), QuickShape, layers, autosave and time-lapse sit around the
 * simulation in sim.js.
 */
import { Sim } from './sim.js';
import { makePaper, PAPERS } from './paper.js';
import { PIGMENTS, mix, swatch, rgbToHex, customPigment, mass, hexToRgb, srgbToLinear } from './km.js';
import { strokeStamps, Smoother, BRUSHES, CATEGORIES, SHAPES, splatterDrops, INKS, PEN_COLOURS, MARK_COLOURS } from './brush.js';
import { Disc, hsvToRgb, rgbToHsv } from './colour.js';
import * as store from './store.js';
import { Recorder, openPlayer, exportVideo } from './timelapse.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const qs = new URLSearchParams(location.search);
const canvas = $('#gl');
let toastT = 0;
function toast(msg, ms = 1600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
function fatal(msg) { const e = $('#err'); e.style.display = 'block'; e.innerHTML = '<h2>Aquarelle cannot start</h2><p></p>'; e.querySelector('p').textContent = msg; throw new Error(msg); }
const NOSAVE = qs.has('nosave');

// ---------- preferences ----------
const TINTS = { white: [1, 1, 1], natural: [0.95, 0.94, 0.905], cream: [0.94, 0.905, 0.82], grey: [0.74, 0.73, 0.70], blue: [0.70, 0.75, 0.79], black: [0.17, 0.17, 0.18] };
const DEF = {
  tool: 'paint', sel: { paint: 'round', smudge: 'round', erase: 'round' }, cat: 'Watercolour',
  brush: Object.fromEntries(Object.entries(BRUSHES).map(([k, b]) => [k, { size: b.size, water: b.water, paint: b.paint, sizePressure: b.sizePressure, paintPressure: b.paintPressure, spacing: b.spacing }])),
  tools: { smudge: { size: 26, paint: 0.6 }, erase: { size: 30, paint: 0.9 } },
  pig: ['ultra'], weights: [1], customs: [], history: [], colOpacity: 0.15, colGran: 0.15,
  drying: 1, runDry: true, fingers: 'auto', smooth: 0.3, rotate: true, right: false, cursor: true, pressure: 1, quick: true, record: true,
  helpSeen: false, currentId: null,
  autoFs: /Android/i.test(navigator.userAgent) && matchMedia('(pointer: coarse)').matches,
  // pen mode (notes): nib, ink colour, highlighter colour, size per nib
  mode: 'paint', pen: { nib: 'ballpoint', col: '#141414', mark: '#ffe24a', size: Object.fromEntries(Object.entries(INKS).map(([k, v]) => [k, v.size])), customs: [] },
  eink: null,
};
let S;
try { S = { ...structuredClone(DEF), ...JSON.parse(localStorage.getItem('aquarelle:prefs') || '{}') }; } catch { S = structuredClone(DEF); }
if (qs.has('fresh')) S = structuredClone(DEF);
for (const k in DEF.brush) S.brush[k] = { ...DEF.brush[k], ...(S.brush[k] || {}) };
for (const k in DEF.tools) S.tools[k] = { ...DEF.tools[k], ...(S.tools?.[k] || {}) };
S.sel = { ...DEF.sel, ...S.sel };
S.pen = { ...DEF.pen, ...S.pen, size: { ...DEF.pen.size, ...(S.pen?.size || {}) } };
// colour e-paper (Bigme, Boox, Kobo...): light high-contrast UI, no animation, sparse redraws.
// Guessed from the user agent the first time, then a preference (Prefs → E-paper display).
if (qs.has('eink')) S.eink = qs.get('eink') !== '0';
S.eink ??= /bigme|boox|onyx|eink|e-ink|kobo|pocketbook|hisense a|meebook|b7 ?pro/i.test(navigator.userAgent);
if (!['paint', 'smudge', 'erase'].includes(S.tool)) S.tool = 'paint';
const savePrefs = () => { try { localStorage.setItem('aquarelle:prefs', JSON.stringify(S)); } catch { /* private mode */ } };
document.body.classList.toggle('right', S.right);
function applyTheme() {
  document.body.classList.toggle('eink', !!S.eink);
  document.body.classList.toggle('penmode', S.mode === 'pen');
  document.querySelector('meta[name=theme-color]').content = S.eink ? '#ffffff' : '#28282a';
  if (sim) { applyPattern(); needsRender = true; }
}

const allPigments = () => [...PIGMENTS, ...S.customs.map((c) => customPigment(c.hex, c.op, c.gran))];
const pigById = (id) => allPigments().find((p) => p.id === id) || (id?.startsWith('custom:') ? customPigment(id.split(':')[1], +id.split(':')[2] || 0.15) : PIGMENTS[0]);

// ---------- GL ----------
// low-latency (desynchronized) canvas on desktop only: on Android it can land on an overlay
// plane, which e-paper drivers and the DOM above it do not always handle
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: !/Android/i.test(navigator.userAgent) });
if (!gl) fatal('WebGL2 is not available in this browser.');
let sim = null;
/** The open painting: its look lives with it, like Procreate's background colour. */
let doc = null; // {id, name, W, H, paper, tint, texture, created}
const rec = new Recorder();
let dpr = Math.min(window.devicePixelRatio || 1, 2);
const view = { x: 0, y: 0, z: 1, r: 0, f: 1 };
let needsRender = true, userMovedView = false;

function applyLook() { if (!sim) return; sim.setLook(TINTS[doc.tint].map(srgbToLinear), doc.texture ? 1 : 0); applyPattern(); needsRender = true; if (loaded) drawMixWell(); }
// ruled paper for notes: line spacing scales with the page (about 6.5 mm on a 7" page)
const PATTERNS = ['None', 'Lined', 'Grid', 'Dots'];
function applyPattern() {
  sim.setPattern(doc.pattern || 0, Math.round(Math.max(sim.W, sim.H) / 22), S.eink ? [0.6, 0.6, 0.6] : [0.62, 0.72, 0.9]);
  sim.pattern.margin = S.eink ? [0.7, 0.7, 0.7] : [0.95, 0.55, 0.55];
}

/** Open a painting on a fresh simulation. data = saved layers, or null for a blank sheet. */
function openDoc(d, data) {
  doc = d;
  try { sim?.dispose(); sim = new Sim(gl, d.W, d.H, makePaper(d.paper, 512, 3)); } catch (e) { fatal(e.message); }
  sim.speed = S.drying;
  if (data) sim.loadAll(data);
  applyLook();
  rec.reset(NOSAVE ? null : d.id, d.frames || 0);
  view.f = 1; userMovedView = false; fit();
  if (S.currentId !== d.id) { S.currentId = d.id; savePrefs(); }
  updateUndo(); buildLayers(); markWet(true);
}

const SIZES = [
  { name: 'Notebook page', note: true, get: () => [1264, 1680] },
  { name: 'Screen size', get: () => { const a = Math.max(innerWidth, innerHeight) / Math.min(innerWidth, innerHeight), L = 1800; return innerWidth >= innerHeight ? [L, Math.round(L / a)] : [Math.round(L / a), L]; } },
  { name: '4 : 3', get: () => [1600, 1200] },
  { name: 'Square', get: () => [1400, 1400] },
  { name: 'A4', get: () => (innerWidth >= innerHeight ? [1754, 1240] : [1240, 1754]) },
  { name: 'Postcard 3 : 2', get: () => [1800, 1200] },
  { name: 'Large 4 : 3', get: () => [2048, 1536] },
];
function newDoc(W, H, name, pattern = 0) {
  return { id: store.newId(), name: name || (pattern ? 'Notes' : 'Untitled'), W, H, paper: pattern ? 'hot' : 'cold', tint: 'white', texture: false, pattern, created: Date.now(), frames: 0 };
}

// ---------- view ----------
// The canvas is sized and mapped from its measured box, never from 100vh / innerHeight: on
// Chrome for Android 100vh is the height with the address bar hidden, so with the bar
// showing the image was stretched and paint landed below the pen (26 px at the top of a
// 7" screen, 84 px at the bottom). view.x/y stay in client (page) coordinates.
const box = { x: 0, y: 0, w: innerWidth, h: innerHeight };
function measure() {
  const r = canvas.getBoundingClientRect();
  box.x = r.left; box.y = r.top; box.w = r.width || innerWidth; box.h = r.height || innerHeight;
}
function resize() {
  measure();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(box.w * dpr); canvas.height = Math.round(box.h * dpr);
  dpr = canvas.height / box.h; // the exact scale after rounding, so the mapping has no drift
  needsRender = true;
}
/** Resize: keep the page under the pen mid-stroke, refit afterwards if the view was not moved. */
let fitPending = false;
function onResize() {
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  resize();
  // mid-stroke the page stays exactly where it is on screen (the line keeps following the
  // pen); it is refitted when the pen lifts
  if (stroke) { fitPending = true; return; }
  if (!userMovedView) { fit(); return; }
  // a view you moved yourself: keep what was at the old centre at the new centre
  view.x += box.x + box.w / 2 - cx; view.y += box.y + box.h / 2 - cy; needsRender = true;
}
/** Rect of a visible panel, or null. */
const rectOf = (sel) => { const el = $(sel); if (!el || !el.offsetParent && getComputedStyle(el).position !== 'fixed') return null; const r = el.getBoundingClientRect(); return r.width && r.height ? r : null; };
/** The sheet goes in the space the floating panels leave: below the top panels, above the
 *  palette / pen bar, beside the tool strip (and the sliders on wide screens). */
function fit() {
  if (!sim) return;
  const W = sim.W, H = sim.H, gap = box.w < 720 ? 8 : 14;
  const tops = ['#topL', '#topR'].map(rectOf).filter(Boolean), bot = rectOf(S.mode === 'pen' ? '#penBar' : '#palette');
  let top = Math.max(box.y, ...tops.map((r) => r.bottom)) + gap, bottom = (bot ? bot.top : box.y + box.h) - gap;
  // side panels (tool strip, sliders): the sheet never goes under them, so every part of it
  // can be painted without panning
  const side = ['#tools', '#sliders'].map(rectOf).filter(Boolean);
  let left = box.x + gap, right = box.x + box.w - gap;
  for (const r of side) { if (r.left + r.width / 2 < box.x + box.w / 2) left = Math.max(left, r.right + gap); else right = Math.min(right, r.left - gap); }
  // on wide screens keep the sheet centred: as much room on the right as the panels take on the left
  if (box.w >= 720) { const inset = Math.max(left - box.x, box.x + box.w - right); left = box.x + inset; right = box.x + box.w - inset; }
  if (bottom - top < 120) { top = box.y + gap; bottom = box.y + box.h - gap; }
  const aw = Math.max(50, right - left), ah = Math.max(50, bottom - top);
  const z = Math.min(aw / W, ah / H);
  view.z = z; view.r = 0; view.x = left + (aw - W * z) / 2; view.y = top + (ah - H * z) / 2;
  if (view.f < 0) view.x += W * z;
  needsRender = true;
}
// screen = T + z R F sheet, F = diag(f, 1)
function fwd() { const c = Math.cos(view.r), s = Math.sin(view.r), z = view.z, f = view.f; return [z * c * f, z * s * f, -z * s, z * c]; } // columns: [a b; c d] as [m00 m10 m01 m11]
const toScreen = (sx, sy) => { const [a, b, c, d] = fwd(); return { x: a * sx + c * sy + view.x, y: b * sx + d * sy + view.y }; };
const toSheet = (cx, cy) => { const [a, b, c, d] = fwd(), det = a * d - b * c, x = cx - view.x, y = cy - view.y; return { x: (d * x - c * y) / det, y: (-b * x + a * y) / det }; };
/** Canvas pixel (CSS px from the canvas's own corner) -> sheet. */
function invMat() {
  const [a, b, c, d] = fwd(), det = a * d - b * c, ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  const tx = view.x - box.x, ty = view.y - box.y;
  return [ia, ib, 0, ic, id, 0, -(ia * tx + ic * ty), -(ib * tx + id * ty), 1];
}
function zoomAt(cx, cy, f) {
  const p = toSheet(cx, cy); view.z = Math.min(12, Math.max(0.1, view.z * f));
  const q = toScreen(p.x, p.y); view.x += cx - q.x; view.y += cy - q.y; needsRender = true; userMovedView = true;
}
resize();
addEventListener('resize', onResize);
window.visualViewport?.addEventListener('resize', onResize);
new ResizeObserver(() => { const r = canvas.getBoundingClientRect(); if (Math.abs(r.width - box.w) > 0.5 || Math.abs(r.height - box.h) > 0.5) onResize(); }).observe(canvas);

// ---------- brush ----------
let loaded;
function loadBrush() { loaded = mix(S.pig.map((id, i) => ({ p: pigById(id), w: S.weights[i] ?? 1 }))); refreshColour(); }
function brushVec(conc) {
  const m = mass(loaded);
  return { bK: [...loaded.K.map((k) => k * conc), loaded.gran * m * conc], bS: [...loaded.S.map((s) => s * conc), loaded.lift * m * conc] };
}
const concOf = (paint) => 0.1 + 4.5 * paint * paint;
/** What the current tool paints with: preset, settings, mode (0 paint, 1 water, 2 lift, 3 erase, 4 smudge). */
function current(tool = S.tool) {
  if (tool === 'pen' || tool === 'inkerase' || (S.mode === 'pen' && tool !== 'inkerase')) {
    const id = tool === 'inkerase' ? 'inkerase' : S.pen.nib, B = INKS[id];
    return { id, B, cfg: { size: S.pen.size[id], sizePressure: B.sizePressure }, mode: id === 'inkerase' ? 6 : 5 };
  }
  const id = S.sel[tool] || 'round', B = BRUSHES[id] || BRUSHES.round;
  if (tool === 'paint') return { id, B, cfg: S.brush[id], mode: B.mode || 0 };
  return { id, B, cfg: S.tools[tool], mode: tool === 'smudge' ? 4 : 3 };
}

// ---------- painting ----------
let stroke = null, seedCounter = 1, stroke0 = 0, paintTick = 0;

function sampleOf(e) {
  const p = toSheet(e.clientX, e.clientY);
  let pr = e.pointerType === 'pen' && e.pressure ? Math.pow(e.pressure, S.pressure) : null;
  // tilt: altitude 0 (flat) .. pi/2 (upright), azimuth around the screen
  let alt = Math.PI / 2, az = 0;
  if (e.pointerType === 'pen') {
    if (typeof e.altitudeAngle === 'number' && e.altitudeAngle > 0) { alt = e.altitudeAngle; az = e.azimuthAngle || 0; }
    else if (e.tiltX || e.tiltY) { const tx = e.tiltX * Math.PI / 180, ty = e.tiltY * Math.PI / 180; alt = Math.PI / 2 - Math.min(Math.PI / 2, Math.hypot(tx, ty)); az = Math.atan2(ty, tx); }
  }
  az -= view.r; if (view.f < 0) az = Math.PI - az;
  return { x: p.x, y: p.y, p: pr, t: e.timeStamp || performance.now(), alt, az, type: e.pointerType };
}

function beginStroke(e, tool = S.tool) {
  // the stylus's eraser end (or its eraser button) erases in either mode
  const eraser = e.pointerType === 'pen' && ((e.buttons & 32) || e.button === 5);
  if (S.mode === 'pen') tool = eraser || S.pen.nib === 'inkerase' ? 'inkerase' : 'pen';
  else if (eraser) tool = 'erase';
  sim.begin();
  // handwriting wants the line under the nib, so pen mode smooths less
  const smooth = tool === 'pen' || tool === 'inkerase' ? S.smooth * 0.5 : S.sel.paint === 'detail' && tool === 'paint' ? Math.min(0.9, S.smooth + 0.2) : S.smooth;
  stroke = { tool, sm: new Smoother(smooth), last: null, rest: 0, load: 1, seed: seedCounter++, v: 0, len: 0, type: e.pointerType, raw: [], hold: null };
  stroke0 = performance.now();
  addSample(sampleOf(e));
  updateUndo();
}

function addSample(q) {
  if (!stroke || stroke.snapped) return;
  stroke.raw.push(q);
  // QuickShape: holding still after a real stroke snaps it to a line or an ellipse
  if (S.quick && stroke.len > 40) {
    const h = stroke.hold;
    if (!h || Math.hypot(q.x - h.x, q.y - h.y) * view.z > 6) { clearTimeout(h?.t); stroke.hold = { x: q.x, y: q.y, t: setTimeout(quickShape, 520) }; }
  }
  emit(stroke.sm.push(q));
}

/** Pen mode: ink stamps go straight into the paper, no water. */
function emitInk(s) {
  const st = stroke, { id, B, cfg, mode } = current(st.tool);
  const pr = s.p != null ? s.p : 0.6;
  let r = Math.max(0.6, cfg.size * (1 - B.sizePressure + B.sizePressure * Math.pow(Math.max(pr, 0.05), 0.9) * 1.35));
  let el = 1, ex = 1, ey = 0;
  if (B.angle != null) { const a = B.angle * Math.PI / 180; ex = Math.cos(a); ey = Math.sin(a); el = B.flat; r = cfg.size / B.flat * 1.6; }
  const point = { x: s.x, y: s.y, p: pr, t: s.t, r, el, ex, ey };
  let pts;
  if (!st.last) pts = [{ ...point, dx: 1, dy: 0 }];
  else {
    const { stamps, rest } = strokeStamps(st.last, point, Math.max(0.35, Math.min(r, cfg.size) * B.spacing), st.rest);
    st.rest = rest; st.len += Math.hypot(point.x - st.last.x, point.y - st.last.y); pts = stamps;
  }
  st.last = point;
  if (!pts.length) return;
  const ink = st.inkVec || (st.inkVec = inkVec(id));
  sim.ink(pts.map((q) => ({ x: q.x, y: q.y, r: q.r, a: 1, ex: q.ex, ey: q.ey, el: q.el })), { mode, ...ink });
  needsRender = true; paintTick++;
}
/** Ink colour as pigment: a unit layer of it over white is exactly the chosen colour. */
function inkVec(id) {
  if (id === 'inkerase') return { bK: [0, 0, 0, 0], bS: [0, 0, 0, 0], cover: 1 };
  const hl = id === 'highlighter', p = customPigment(hl ? S.pen.mark : S.pen.col, hl ? 0.03 : 0.6, 0), m = mass(p);
  return { bK: [...p.K, 0], bS: [...p.S, 0.4 * m], cover: hl ? 0 : 1 };
}

function emit(s) {
  if (stroke.tool === 'pen' || stroke.tool === 'inkerase') return emitInk(s);
  const st = stroke, { B, cfg } = current(st.tool);
  if (st.last) {
    const dt = Math.max(1, s.t - st.last.t), d = Math.hypot(s.x - st.last.x, s.y - st.last.y);
    st.v = st.v * 0.7 + (d / dt) * 0.3; // sheet px per ms
  }
  // pressure: from the pen, else from speed (slow = heavy)
  const sp = Math.min(1, st.v * view.z / 2.5);
  const pr = s.p != null ? s.p : (st.type === 'mouse' ? 0.62 - 0.25 * sp : 0.7 - 0.3 * sp);
  const tilt = 1 - s.alt / (Math.PI / 2); // 0 upright .. 1 flat
  const sizeP = st.tool === 'paint' ? cfg.sizePressure : 0.4;
  let r = cfg.size * (1 - sizeP + sizeP * Math.pow(Math.max(pr, 0.03), 0.8)) * (1 + tilt * 0.8);
  if (B === BRUSHES.wash) r = cfg.size * (0.75 + 0.25 * pr);
  let el = 1 + tilt * 1.8 + (B === BRUSHES.wash ? 0.5 : 0);
  // a tilted pen lies along its azimuth; a flat brush keeps its chisel at a fixed angle
  let ex = tilt > 0.05 ? -Math.sin(s.az) : 0, ey = tilt > 0.05 ? Math.cos(s.az) : 1;
  if (B.angle != null) { const a = B.angle * Math.PI / 180; ex = Math.cos(a); ey = Math.sin(a); el = B.flat + tilt; r /= Math.sqrt(B.flat) * 0.8; }
  const point = { x: s.x, y: s.y, p: pr, t: s.t, r, el, ex, ey };
  if (!st.last) { st.last = point; put([{ ...point, dx: 1, dy: 0 }], true); return; }
  const spacing = Math.max(0.6, r * (cfg.spacing || B.spacing || 0.18));
  const { stamps, rest } = strokeStamps(st.last, point, spacing, st.rest);
  st.rest = rest; st.len += Math.hypot(point.x - st.last.x, point.y - st.last.y); st.last = point;
  if (stamps.length) put(stamps, false);
}

/** Turn resampled points into sim stamps for the current tool. */
function put(points, first) {
  const st = stroke, { id, B, cfg, mode } = current(st.tool);
  const sp = Math.min(1, st.v * view.z / 3);
  const out = [];
  for (const q of points) {
    const s = { x: q.x, y: q.y, r: q.r, a: 1, dx: q.dx ?? 1, dy: q.dy ?? 0, seed: st.seed, ex: q.ex, ey: q.ey, el: q.el, dry: 0, wt: 0 };
    if (mode === 3) { s.a = cfg.paint * (0.5 + 0.5 * (q.p ?? 0.7)); out.push(s); continue; }
    if (mode === 4) { if (first) continue; s.a = cfg.paint * (0.4 + 0.6 * (q.p ?? 0.7)); out.push(s); continue; }
    if (mode === 2) { s.a = 0.5 + 0.5 * cfg.paint; out.push(s); continue; }
    // brush load: the hairs empty along the stroke, and a fast stroke leaves less water
    const usage = (q.r * (cfg.spacing || 0.18)) / (380 + cfg.water * 1400) * (id === 'wash' ? 0.5 : 1);
    if (S.runDry && mode === 0) st.load = Math.max(0, st.load - usage);
    const load = S.runDry ? st.load : 1;
    const water = cfg.water * (0.25 + 0.75 * Math.sqrt(load)) * (1 - 0.45 * sp) * (0.75 + 0.35 * (q.p ?? 0.6));
    let dry = 0;
    if (id === 'dry') dry = Math.min(1, 0.55 + 0.45 * (1 - cfg.water) + sp * 0.2);
    else if (mode === 0) dry = Math.max(0, Math.min(0.85, (0.32 - water) * 3.2));
    s.dry = dry; s.wt = Math.max(0.04, water) * (id === 'dry' ? 0.6 : 1);
    if (id === 'splatter') {
      if (Math.random() > 0.55 && !first) continue;
      for (const d of splatterDrops(s, q.r, st.seed * 7919 + Math.floor(q.x * 13 + q.y * 7))) out.push({ ...d, el: 1, ex: 1, ey: 0, dry: 0, wt: 0.25 + 0.5 * cfg.water, a: 1 });
      continue;
    }
    out.push(s);
  }
  if (!out.length) return;
  // paint pressure: a harder press carries more pigment; dry brush carries thick paint
  const pp = st.tool === 'paint' ? cfg.paintPressure : 0, pAvg = points.reduce((a, q) => a + (q.p ?? 0.6), 0) / points.length;
  const conc = concOf(cfg.paint) * (1 - pp + pp * 1.4 * pAvg) * (id === 'dry' ? 3.5 : 1);
  const shape = id === 'splatter' ? 3 : B.shape || 0;
  sim.stamp(out, { mode, shape, ...(mode === 0 ? brushVec(conc) : { bK: [0, 0, 0, 0], bS: [0, 0, 0, 0] }), mix: id === 'splatter' ? 0.95 : id === 'wash' ? 0.3 : 0.22 });
  needsRender = true; paintTick++;
}

function endStroke() {
  if (!stroke) return;
  clearTimeout(stroke.hold?.t);
  if (!stroke.snapped) for (const q of stroke.sm.finish()) emit(q);
  if (stroke.tool === 'paint' && current().mode === 0) pushHistory(S.pig.length === 1 ? S.pig[0] : null);
  if (stroke.tool === 'pen' && S.pen.nib !== 'highlighter') S.pen.customs = [S.pen.col, ...S.pen.customs.filter((c) => c !== S.pen.col)].slice(0, 6);
  stroke = null;
  if (fitPending) { fitPending = false; if (!userMovedView) fit(); }
  updateUndo(); scheduleSave(); thumbsDirty = true;
}

// QuickShape: replace the stroke with the line or ellipse it was meant to be
function quickShape() {
  const st = stroke; if (!st || st.snapped || st.raw.length < 6) return;
  const pts = st.raw, a = pts[0], b = pts.at(-1);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, len = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i]; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); if (i) len += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y); }
  const diag = Math.hypot(x1 - x0, y1 - y0), closed = Math.hypot(b.x - a.x, b.y - a.y) < diag * 0.3 && len > diag * 1.8;
  const ps = pts.map((p) => p.p ?? 0.6).sort((u, v) => u - v), pr = ps[Math.floor(ps.length / 2)];
  let shape = [];
  if (closed) {
    // ellipse from the points' mean and covariance (principal axes)
    let mx = 0, my = 0; for (const p of pts) { mx += p.x; my += p.y; } mx /= pts.length; my /= pts.length;
    let sxx = 0, syy = 0, sxy = 0; for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    sxx /= pts.length; syy /= pts.length; sxy /= pts.length;
    const tr = sxx + syy, det = sxx * syy - sxy * sxy, l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)), l2 = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let ra = Math.sqrt(2 * l1), rb = Math.sqrt(2 * Math.max(l2, 0));
    if (Math.abs(ra - rb) < 0.12 * ra) ra = rb = (ra + rb) / 2; // nearly round: a circle
    const n = Math.max(24, Math.round(Math.PI * (ra + rb) / 3)), t0 = Math.atan2(a.y - my, a.x - mx) - ang;
    for (let i = 0; i <= n; i++) { const t = t0 + i / n * Math.PI * 2; shape.push({ x: mx + Math.cos(ang) * ra * Math.cos(t) - Math.sin(ang) * rb * Math.sin(t), y: my + Math.sin(ang) * ra * Math.cos(t) + Math.cos(ang) * rb * Math.sin(t) }); }
  } else {
    const n = Math.max(2, Math.round(Math.hypot(b.x - a.x, b.y - a.y) / 3));
    for (let i = 0; i <= n; i++) shape.push({ x: a.x + (b.x - a.x) * i / n, y: a.y + (b.y - a.y) * i / n });
  }
  // take the hand-drawn stroke back (with everything its water did) and paint the shape
  sim.discardLast(); sim.begin();
  Object.assign(st, { last: null, rest: 0, load: 1, v: 0.15, len: 0, snapped: true });
  let t = a.t;
  for (const q of shape) emit({ x: q.x, y: q.y, p: pr, t: (t += 8), alt: a.alt, az: a.az });
  window.__quick = { closed, n: shape.length };
  toast(closed ? 'QuickShape: ellipse' : 'QuickShape: line', 900);
}

// ---------- eyedropper ----------
let picking = false;
function pickAt(cx, cy) {
  render();
  const px = new Uint8Array(4 * 25), x = Math.round((cx - box.x) * dpr), y = Math.round(canvas.height - (cy - box.y) * dpr);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(Math.max(0, x - 2), Math.max(0, y - 2), 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let r = 0, g = 0, b = 0; for (let i = 0; i < 25; i++) { r += px[i * 4]; g += px[i * 4 + 1]; b += px[i * 4 + 2]; }
  const pc = TINTS[doc.tint].map((v) => Math.round(v * 255));
  setPicking(false);
  if (Math.abs(r / 25 - pc[0]) + Math.abs(g / 25 - pc[1]) + Math.abs(b / 25 - pc[2]) < 24) { toast('That is bare paper'); return; }
  const hex = rgbToHex([r / 25 / 255, g / 25 / 255, b / 25 / 255]);
  if (S.mode === 'pen') { setPenColour(hex); toast('Pen colour ' + hex); return; }
  useCustom(hex, Math.min(S.colOpacity, 0.15)); toast('Picked ' + hex);
}
function setPicking(on) { picking = on; $$('.pickBtn').forEach((b) => b.classList.toggle('on', on)); updateCursor(); }
$('#pickBtn').addEventListener('click', (e) => { e.stopPropagation(); setPicking(!picking); });

/** Load a picked colour as a custom pigment. */
function useCustom(hex, op = S.colOpacity, gran = S.colGran) {
  S.customs = [{ hex, op, gran }, ...S.customs.filter((c) => c.hex !== hex)].slice(0, 8);
  const p = customPigment(hex, op, gran);
  S.pig = [p.id]; S.weights = [1];
  if (S.tool !== 'paint') setTool('paint');
  if (current().mode !== 0) useBrush('round');
  loadBrush(); buildWells(); savePrefs();
}
function pushHistory(id) {
  if (!id) return;
  S.history = [id, ...S.history.filter((h) => h !== id)].slice(0, 12);
  buildHistory();
}

// ---------- input ----------
const touches = new Map();
let penSeen = qs.get('pen') === '1', gesture = null, tapCand = null, pendingTouch = null, mouseDrag = null, spaceDown = false, hoverPt = null, lpTimer = 0;
const fingersNavigate = () => S.fingers === 'auto' && penSeen;
const copyEv = (e) => ({ clientX: e.clientX, clientY: e.clientY, pressure: e.pressure, pointerType: e.pointerType, timeStamp: e.timeStamp, tiltX: 0, tiltY: 0 });

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (closePops()) { if (e.pointerType !== 'pen') return; }
  canvas.setPointerCapture?.(e.pointerId);
  if (e.pointerType === 'pen') penSeen = true;
  if (e.pointerType === 'touch') {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
    if (touches.size === 1) tapCand = { n: 1, t0: performance.now(), moved: false };
    else if (tapCand) tapCand.n = Math.max(tapCand.n, touches.size);
    if (touches.size >= 2) {
      // a second finger: cancel the waiting stroke, or take back the one that only just began
      if (pendingTouch) { pendingTouch = null; clearTimeout(lpTimer); }
      if (stroke && stroke.type === 'touch') { const young = performance.now() - stroke0 < 250; endStroke(); if (young) { sim.discardLast(); updateUndo(); } }
      startGesture(); return;
    }
    if (picking) { pickAt(e.clientX, e.clientY); tapCand = null; return; }
    if (fingersNavigate()) { startGesture(); return; }
    // wait briefly: a second finger means navigation; holding still means eyedropper
    pendingTouch = { e: copyEv(e), evs: [], t0: performance.now() };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => { if (pendingTouch) { const p = pendingTouch; pendingTouch = null; tapCand = null; pickAt(p.e.clientX, p.e.clientY); } }, 550);
    return;
  }
  if (e.pointerType === 'mouse' && (e.button === 1 || e.button === 2 || spaceDown)) { mouseDrag = { x: e.clientX, y: e.clientY }; canvas.style.cursor = 'grabbing'; return; }
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  if (e.altKey || picking) { pickAt(e.clientX, e.clientY); return; }
  beginStroke(e);
});

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    const t = touches.get(e.pointerId); t.x = e.clientX; t.y = e.clientY;
    if (Math.hypot(t.x - t.x0, t.y - t.y0) > 10 && tapCand) tapCand.moved = true;
    if (gesture) { moveGesture(); return; }
    if (pendingTouch) {
      pendingTouch.evs.push(...(e.getCoalescedEvents ? e.getCoalescedEvents() : [e]).map(copyEv));
      const moved = Math.hypot(e.clientX - pendingTouch.e.clientX, e.clientY - pendingTouch.e.clientY);
      if (moved > 8 || performance.now() - pendingTouch.t0 > 60 && moved > 2) {
        const p = pendingTouch; pendingTouch = null; clearTimeout(lpTimer); tapCand = null;
        beginStroke(p.e); for (const q of p.evs) addSample(sampleOf(q));
      }
      return;
    }
  }
  if (mouseDrag) { view.x += e.clientX - mouseDrag.x; view.y += e.clientY - mouseDrag.y; mouseDrag = { x: e.clientX, y: e.clientY }; userMovedView = true; needsRender = true; return; }
  hoverPt = { x: e.clientX, y: e.clientY, type: e.pointerType };
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
      if (!fingersNavigate()) { beginStroke(p.e); for (const q of p.evs) addSample(sampleOf(q)); endStroke(); }
      tapCand = null; return;
    }
    if (stroke && stroke.type === 'touch') endStroke();
    if (touches.size === 0) {
      if (tapCand && !tapCand.moved && performance.now() - tapCand.t0 < 320 && tapCand.n >= 2) {
        if (tapCand.n === 2) doUndo(); else if (tapCand.n === 3) doRedo(); else document.body.classList.toggle('ui-hidden');
      } else if (gesture && !gesture.one && performance.now() - gesture.t0 < 380 && view.z < gesture.z0 * 0.72) { userMovedView = false; fit(); }
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

const sheetAng = (a, b) => Math.atan2(b.y - a.y, view.f * (b.x - a.x));
function startGesture() {
  const pts = [...touches.values()].slice(0, 2);
  if (pts.length === 1) { gesture = { one: true, s: toSheet(pts[0].x, pts[0].y), t0: performance.now(), z0: view.z }; return; }
  gesture = { a: toSheet(pts[0].x, pts[0].y), b: toSheet(pts[1].x, pts[1].y), ang0: Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x), rotOn: false, t0: gesture?.t0 ?? performance.now(), z0: gesture?.z0 ?? view.z };
}
function moveGesture() {
  const pts = [...touches.values()].slice(0, 2);
  userMovedView = true; needsRender = true;
  if (gesture.one || pts.length < 2) {
    const s = gesture.s || (gesture.s = toSheet(pts[0].x, pts[0].y));
    const q = toScreen(s.x, s.y); view.x += pts[0].x - q.x; view.y += pts[0].y - q.y; return;
  }
  const { a, b } = gesture;
  view.z = Math.min(12, Math.max(0.1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) / Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-3)));
  if (S.rotate) {
    const ang = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);
    let r = ang - sheetAng(a, b);
    // rotation only after a deliberate twist, and it snaps to square
    if (!gesture.rotOn && Math.abs(((ang - gesture.ang0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI) > 0.2) gesture.rotOn = true;
    if (gesture.rotOn) { const snap = Math.round(r / (Math.PI / 2)) * (Math.PI / 2); if (Math.abs(r - snap) < 0.08) r = snap; view.r = r; }
  }
  const q = toScreen(a.x, a.y); view.x += pts[0].x - q.x; view.y += pts[0].y - q.y;
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault(); userMovedView = true;
  if (e.ctrlKey || e.metaKey || (Math.abs(e.deltaY) > 40 && !e.deltaX && e.deltaMode === 0 && !e.shiftKey)) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  else { view.x -= e.deltaX; view.y -= e.deltaY; needsRender = true; }
}, { passive: false });
addEventListener('gesturestart', (e) => e.preventDefault());
addEventListener('gesturechange', (e) => e.preventDefault());

function brushRadiusPx() { const { cfg } = current(); return Math.max(2, cfg.size * view.z * (S.tool === 'paint' ? 1 - (cfg.sizePressure ?? 0.4) * 0.35 : 0.85)); }
function updateCursor() {
  const c = $('#cursor');
  if (!S.cursor || !hoverPt || hoverPt.type === 'touch' || gesture || mouseDrag || spaceDown) { c.style.display = 'none'; canvas.style.cursor = mouseDrag ? 'grabbing' : spaceDown ? 'grab' : picking ? 'crosshair' : ''; return; }
  canvas.style.cursor = picking ? 'crosshair' : 'none';
  if (picking) { c.style.display = 'none'; return; }
  const r = brushRadiusPx();
  c.style.display = 'block'; c.style.width = c.style.height = 2 * r + 'px';
  c.style.transform = `translate(${hoverPt.x - r}px, ${hoverPt.y - r}px)`;
  c.style.borderStyle = S.tool === 'erase' ? 'dashed' : 'solid';
}

// ---------- keys ----------
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if ((e.metaKey || e.ctrlKey) && k === 'y') { e.preventDefault(); doRedo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ') { spaceDown = true; updateCursor(); e.preventDefault(); return; }
  if (k === 'escape') { closePops(); setPicking(false); return; }
  const brushes = { b: 'round', w: 'wash', t: 'flat', r: 'detail', y: 'dry', x: 'splatter', q: 'water', k: 'lift' };
  if (brushes[k]) { if (S.mode === 'pen') setMode('paint'); useBrush(brushes[k]); return; }
  const tools = { s: 'smudge', e: 'erase' };
  if (tools[k]) { if (S.mode === 'pen') setMode('paint'); setTool(tools[k]); markTools(); return; }
  if (k === 'l') { togglePop('layerPop'); return; }
  if (k === 'c') { togglePop('colPop'); return; }
  if (k === 'i') { setPicking(!picking); return; }
  if (k === '[' || k === ']') { const { cfg, id, mode } = current(); cfg.size = Math.max(0.6, Math.min(160, cfg.size * (k === ']' ? 1.15 : 1 / 1.15))); if (mode >= 5) S.pen.size[id] = cfg.size; syncSliders(); updateCursor(); savePrefs(); return; }
  if (k === 'p') { setMode(S.mode === 'pen' ? 'paint' : 'pen'); return; }
  if (k === 'f') { dryNow(); return; }
  if (k === '0') { userMovedView = false; fit(); return; }
  if (k === 'tab') { e.preventDefault(); document.body.classList.toggle('ui-hidden'); return; }
  if (/^[1-9]$/.test(k)) { const p = PIGMENTS[+k - 1]; if (p) choosePigment(p.id, e.shiftKey); }
});
addEventListener('keyup', (e) => { if (e.key === ' ') { spaceDown = false; updateCursor(); } });

// ---------- tools ----------
function setTool(t) {
  S.tool = t;
  markTools(); syncSliders(); updateCursor(); savePrefs();
  if ($('#brushPop').classList.contains('open')) buildBrushes();
}
/** Light the strip button for the current brush or tool. */
function markTools() {
  $$('#tools [data-brush]').forEach((b) => b.classList.toggle('on', S.tool === 'paint' && S.sel.paint === b.dataset.brush));
  $$('#tools [data-tool]').forEach((b) => b.classList.toggle('on', S.tool === b.dataset.tool));
}
function useBrush(id) { S.tool = 'paint'; S.sel.paint = id; setTool('paint'); }
// one button per brush, as in the first interface; tapping the selected one again opens
// its settings (smudge and erase: the brush shape they use)
$$('#tools [data-brush]').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation(); setPicking(false);
  if (S.tool === 'paint' && S.sel.paint === b.dataset.brush) { togglePop('brushPop'); return; }
  closePops(); useBrush(b.dataset.brush);
}));
$$('#tools [data-tool]').forEach((b) => b.addEventListener('click', (e) => {
  e.stopPropagation(); setPicking(false);
  if (S.tool === b.dataset.tool) { togglePop('brushPop'); return; }
  closePops(); setTool(b.dataset.tool);
}));

// ---------- pen mode ----------
function setMode(m) {
  S.mode = m; savePrefs(); applyTheme();
  $$('#modeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === m));
  closePops(); markTools(); syncSliders(); updateCursor(); buildPenBar(); refreshColour(); if (!userMovedView) requestAnimationFrame(fit);
  if (window.__ready) toast(m === 'pen' ? 'Pen: ink for writing notes' : 'Paint: watercolour', 900);
}
$$('#modeSeg button').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); setMode(b.dataset.v); }));
function setNib(id) { S.pen.nib = id; savePrefs(); syncSliders(); updateCursor(); buildPenBar(); refreshColour(); }
function setPenColour(hex) {
  if (S.pen.nib === 'highlighter') S.pen.mark = hex; else { S.pen.col = hex; if (S.pen.nib === 'inkerase') S.pen.nib = 'ballpoint'; }
  savePrefs(); buildPenBar(); refreshColour();
}
function buildPenBar() {
  const bar = $('#penBar'); if (!bar || S.mode !== 'pen') return;
  const nibs = $('#nibs'); nibs.innerHTML = '';
  for (const [id, B] of Object.entries(INKS)) {
    const b = document.createElement('button'); b.className = 'nib' + (S.pen.nib === id ? ' on' : ''); b.title = B.name + ' — ' + B.note; b.dataset.nib = id;
    b.innerHTML = `<svg class="i"><use href="#i-${id}"/></svg><span>${B.name}</span>`;
    b.onclick = () => setNib(id);
    nibs.appendChild(b);
  }
  const sw = $('#penCols'); sw.innerHTML = '';
  const hl = S.pen.nib === 'highlighter', cur = hl ? S.pen.mark : S.pen.col;
  const cols = hl ? MARK_COLOURS : [...PEN_COLOURS, ...S.pen.customs.filter((c) => !PEN_COLOURS.includes(c))].slice(0, 12);
  for (const c of cols) {
    const b = document.createElement('button'); b.className = 'pc' + (c.toLowerCase() === cur.toLowerCase() && S.pen.nib !== 'inkerase' ? ' on' : ''); b.style.background = c; b.title = c; b.dataset.col = c;
    b.onclick = () => setPenColour(c);
    sw.appendChild(b);
  }
  const more = document.createElement('button'); more.className = 'pc more'; more.title = 'Any colour…'; more.textContent = '+';
  more.onclick = (e) => { e.stopPropagation(); togglePop('colPop'); };
  sw.appendChild(more);
  const pk = document.createElement('button'); pk.className = 'pc pickBtn' + (picking ? ' on' : ''); pk.title = 'Pick a colour off the page (or touch and hold)';
  pk.innerHTML = '<svg><use href="#i-pick"/></svg>';
  pk.onclick = (e) => { e.stopPropagation(); setPicking(!picking); };
  sw.appendChild(pk);
}

// ---------- sidebar sliders ----------
const SLIDERS = {
  sSize: { key: 'size', min: 0.6, max: 160, curve: 2.6, fmt: (v) => (v < 10 ? v.toFixed(1) : Math.round(v) + '') },
  sWater: { key: 'water', min: 0, max: 1, curve: 1, fmt: (v) => Math.round(v * 100) + '%' },
  sPaint: { key: 'paint', min: 0, max: 1, curve: 1, fmt: (v) => Math.round(v * 100) + '%' },
};
function syncSliders() {
  const { cfg, mode } = current();
  for (const id in SLIDERS) {
    const sl = SLIDERS[id], el = document.getElementById(id), v = cfg[sl.key] ?? 0;
    const t = Math.pow((v - sl.min) / (sl.max - sl.min), 1 / sl.curve);
    el.querySelector('.fill').style.height = t * 100 + '%';
    el.querySelector('.knob').style.top = (1 - t) * 100 + '%';
    el.querySelector('.val').textContent = sl.fmt(v);
    const usable = sl.key === 'size' || (mode < 5 && (sl.key === 'paint' ? mode !== 1 : mode <= 1));
    el.classList.toggle('off', !usable);
  }
  // smudge / erase / lift: the paint slider is their strength
  $('#sPaint label').textContent = S.tool === 'paint' && mode !== 2 ? 'Paint' : 'Strength';
  refreshColour();
}
for (const id in SLIDERS) {
  const el = document.getElementById(id), sl = SLIDERS[id];
  let drag = null;
  const set = (e) => {
    const r = el.querySelector('.track').getBoundingClientRect();
    // relative drag (a touch does not jump the value); finer when dragging sideways, as in Procreate
    const fine = 1 / (1 + Math.abs(e.clientX - drag.x) / 50);
    const t = Math.min(1, Math.max(0, drag.t - (e.clientY - drag.y) / r.height * fine));
    const { cfg, id, mode } = current();
    cfg[sl.key] = sl.min + Math.pow(t, sl.curve) * (sl.max - sl.min);
    if (mode >= 5) S.pen.size[id] = cfg.size;
    syncSliders();
    if (sl.key === 'size') showSizePreview();
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId);
    const { cfg } = current(), r = el.querySelector('.track').getBoundingClientRect();
    let t = Math.pow(((cfg[sl.key] ?? 0) - sl.min) / (sl.max - sl.min), 1 / sl.curve);
    if (Math.abs(e.clientY - (r.top + (1 - t) * r.height)) > 22) t = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    drag = { y: e.clientY, x: e.clientX, t }; set(e);
  });
  el.addEventListener('pointermove', (e) => { if (drag) set(e); });
  const up = () => { if (drag) { drag = null; $('#cursor').style.display = 'none'; savePrefs(); } };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
function showSizePreview() {
  const c = $('#cursor'), r = brushRadiusPx();
  c.style.display = 'block'; c.style.width = c.style.height = 2 * r + 'px'; c.style.borderStyle = 'solid';
  c.style.transform = `translate(${box.x + box.w / 2 - r}px, ${box.y + box.h / 2 - r}px)`;
}

// ---------- popovers ----------
function closePops(except) {
  let any = false;
  for (const p of $$('.pop.open')) if (p.id !== except) { p.classList.remove('open'); any = true; }
  $$('.menu').forEach((m) => m.remove());
  return any;
}
function togglePop(id) {
  const p = document.getElementById(id), open = !p.classList.contains('open');
  closePops(id);
  p.classList.toggle('open', open);
  if (open) ({ brushPop: buildBrushes, colPop: buildColour, layerPop: buildLayers, actPop: buildActions })[id]?.();
}
document.addEventListener('pointerdown', (e) => {
  if (e.target === canvas || e.target.closest('.pop, .menu, .panel, #gallery, .tl')) return;
  closePops();
});
function tabs(barSel, paneRoot, onShow) {
  const bar = $(barSel);
  for (const b of bar.querySelectorAll('button')) b.onclick = () => {
    bar.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    $(paneRoot).querySelectorAll('[data-pane]').forEach((p) => (p.style.display = p.dataset.pane === b.dataset.t ? '' : 'none'));
    onShow?.(b.dataset.t);
  };
}
function seg(sel, val, on) {
  for (const b of $$(sel + ' button')) { b.classList.toggle('on', String(val) === b.dataset.v); b.onclick = () => { on(b.dataset.v); for (const x of $$(sel + ' button')) x.classList.toggle('on', x === b); }; }
}

// brush library
function selectBrush(id) {
  S.sel[S.tool] = id; savePrefs(); markTools(); syncSliders(); updateCursor();
}
function drawPreview(cv, id) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height, B = BRUSHES[id];
  g.clearRect(0, 0, W, H);
  const col = S.tool === 'erase' ? [0.85, 0.85, 0.88] : S.tool === 'smudge' ? [0.7, 0.72, 0.8] : swatch(loaded, 1.2, [1, 1, 1]);
  const css = (a) => `rgba(${col.map((c) => Math.round(c * 255)).join(',')},${a})`;
  let rnd = 7; const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  const N = 60;
  for (let i = 0; i <= N; i++) {
    const t = i / N, x = 14 + t * (W - 28), y = H / 2 + Math.sin(t * Math.PI * 1.6 - 0.6) * H * 0.22;
    const taper = Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 0.7;
    if (id === 'splatter') { if (rand() < 0.5) { g.fillStyle = css(0.75); g.beginPath(); g.arc(x + (rand() - 0.5) * 30, y + (rand() - 0.5) * H * 0.6, 1 + rand() * 4, 0, 7); g.fill(); } continue; }
    const r = id === 'wash' ? H * 0.32 : id === 'detail' ? 1 + 2.2 * taper : id === 'flat' ? 0 : id === 'dry' ? H * 0.2 : H * (0.05 + 0.18 * taper);
    if (id === 'flat') { g.strokeStyle = css(0.18); g.lineWidth = 3; g.beginPath(); g.moveTo(x - 9, y + 9); g.lineTo(x + 9, y - 9); g.stroke(); continue; }
    if (id === 'dry') { for (let k = 0; k < 6; k++) if (rand() < 0.55) { g.fillStyle = css(0.35); g.fillRect(x, y - r + k * r / 3, 3, 1.5 + rand() * 2); } continue; }
    const a = id === 'water' ? 0.05 : id === 'lift' ? 0.07 : id === 'wash' ? 0.035 : 0.1;
    g.fillStyle = id === 'water' ? `rgba(110,170,230,${a})` : id === 'lift' ? `rgba(255,255,255,${a * 2})` : css(a);
    g.beginPath(); g.arc(x, y, Math.max(0.8, r), 0, 7); g.fill();
  }
  if (B?.mode === 1) { g.fillStyle = '#8fc4ff'; g.font = '11px system-ui'; }
}
function buildBrushes() {
  const tool = S.tool, list = $('#brushList'), st = $('#studio');
  list.innerHTML = ''; st.innerHTML = '';
  if (tool === 'paint') {
    $('#brushTitle').textContent = BRUSHES[S.sel.paint].name;
    $('#studioReset').style.display = '';
    return buildStudio();
  }
  $('#brushTitle').textContent = tool === 'smudge' ? 'Smudge with…' : 'Erase with…';
  $('#studioReset').style.display = 'none';
  for (const id of SHAPES) {
    const b = document.createElement('button'); b.className = 'bru' + (S.sel[tool] === id ? ' on' : ''); b.title = BRUSHES[id].note;
    b.innerHTML = `<span>${BRUSHES[id].name}</span><canvas width="560" height="80"></canvas>`;
    drawPreview(b.querySelector('canvas'), id);
    b.onclick = () => { selectBrush(id); buildBrushes(); };
    list.appendChild(b);
  }
}
$('#studioReset').onclick = () => { const id = S.sel.paint; S.brush[id] = { ...DEF.brush[id] }; syncSliders(); savePrefs(); buildBrushes(); };
function buildStudio() {
  const id = S.sel.paint, B = BRUSHES[id], cfg = S.brush[id], el = $('#studio');
  el.innerHTML = `<div class="h3">${B.note}</div>`;
  const rows = [['size', 'Size (px)', 1, 160, 1], ['water', 'Water', 0, 1, 0.01], ['paint', 'Paint', 0, 1, 0.01], ['sizePressure', 'Pressure → size', 0, 1, 0.01], ['paintPressure', 'Pressure → paint', 0, 1, 0.01], ['spacing', 'Spacing', 0.05, 0.8, 0.01]];
  for (const [k, label, min, max, step] of rows) {
    const r = document.createElement('div'); r.className = 'row';
    r.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${cfg[k]}">`;
    r.querySelector('input').oninput = (e) => { cfg[k] = +e.target.value; syncSliders(); savePrefs(); };
    el.appendChild(r);
  }
}

// colour
let mixMode = false, disc = null, discTimer = 0;
const wellColour = (p) => rgbToHex(swatch(p, 1.1, [1, 1, 1]));
function refreshColour() {
  if (!loaded) return;
  if (S.mode === 'pen') { const c = S.pen.nib === 'highlighter' ? S.pen.mark : S.pen.col; $('#colNew').style.background = c; buildPenBar(); return; }
  const hex = rgbToHex(swatch(loaded, 1.1, [1, 1, 1]));
  $('#colNew').style.background = hex;
  const names = S.pig.map((p) => pigById(p).name);
  const name = names.length > 1 ? names.map((n, i) => (S.weights[i] > 1 ? S.weights[i] + '× ' : '') + n.replace(/^Custom /, '').split(' ').pop()).join(' + ') : names[0];
  const note = S.pig.length > 1 ? 'mixed on the brush' : pigById(S.pig[0]).note || '';
  $('#colName').textContent = name; $('#colNote').textContent = note;
  $('#mixName').textContent = name; $('#mixNote').textContent = note;
  drawMixWell();
}
/** The big well: what is on the brush, from a thin wash (left) to a full load (right), on this paper. */
function drawMixWell() {
  const c = $('#mixWell canvas'), g = c.getContext('2d'), N = c.width;
  const img = g.createImageData(N, N), bg = TINTS[doc?.tint || 'white'];
  const { cfg } = S.tool === 'paint' && S.mode !== 'pen' ? current() : current('paint');
  const amt = concOf(cfg.paint ?? 0.5) * (0.35 + 0.65 * (cfg.water ?? 0.6)), cache = new Map();
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = x - N / 2, dy = y - N / 2, i = (y * N + x) * 4;
    if (Math.hypot(dx, dy) > N / 2) continue;
    const t = Math.round(Math.min(1, Math.max(0, (x / N) * 1.25 - 0.1 + dy / N * 0.2)) * 24) / 24;
    let col = cache.get(t);
    if (!col) { col = swatch(loaded, Math.max(0.05, amt) * (0.15 + 0.85 * t), bg); cache.set(t, col); }
    img.data[i] = col[0] * 255; img.data[i + 1] = col[1] * 255; img.data[i + 2] = col[2] * 255; img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
function buildColour() {
  $('#colOld').style.background = $('#colNew').style.background;
  if (!disc) {
    disc = new Disc($('#disc'), (hsv, done) => {
      const hex = rgbToHex(hsvToRgb(...hsv));
      $('#colNew').style.background = hex;
      if (S.mode === 'pen') { if (done) setPenColour(hex); return; }
      clearTimeout(discTimer); if (done) useCustom(hex); else discTimer = setTimeout(() => useCustom(hex), 250);
    });
  }
  disc.set(rgbToHsv(S.mode === 'pen' ? hexToRgb(S.pen.nib === 'highlighter' ? S.pen.mark : S.pen.col) : swatch(loaded, 1, [1, 1, 1])));
  if (S.mode === 'pen') { $('#colName').textContent = S.pen.nib === 'highlighter' ? 'Highlighter colour' : 'Ink colour'; $('#colNote').textContent = 'drag the ring for the hue, inside for the shade'; }
  $('#colOpacity').value = S.colOpacity; $('#colGran').value = S.colGran;
  const upd = () => { S.colOpacity = +$('#colOpacity').value; S.colGran = +$('#colGran').value; const c = S.pig.length === 1 && S.pig[0].startsWith('custom:') ? S.pig[0].split(':')[1] : null; if (c) useCustom(c); savePrefs(); };
  $('#colOpacity').onchange = upd; $('#colGran').onchange = upd;
  buildHistory(); if (S.mode !== 'pen') refreshColour();
}
function buildWells() {
  const box = $('#wells'); if (!box) return; box.innerHTML = '';
  for (const p of allPigments()) {
    const b = document.createElement('button'); b.className = 'well'; b.dataset.id = p.id; b.title = p.name + (p.note ? ' — ' + p.note : '');
    b.style.background = `radial-gradient(circle at 45% 40%, ${wellColour(p)} 0 48%, ${rgbToHex(swatch(p, 0.35))} 70%, ${rgbToHex(swatch(p, 0.12))})`;
    let lp = 0, longed = false;
    b.addEventListener('pointerdown', () => { longed = false; lp = setTimeout(() => { longed = true; choosePigment(p.id, true); toast(p.name + ' added to the mix'); }, 480); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(lp));
    b.addEventListener('click', (e) => { if (!longed) choosePigment(p.id, e.shiftKey || mixMode); });
    box.appendChild(b);
  }
  // any colour: the wheel
  const rb = document.createElement('button'); rb.className = 'well rainbow'; rb.title = 'Any colour: the colour wheel (C)';
  rb.onclick = (e) => { e.stopPropagation(); togglePop('colPop'); };
  box.appendChild(rb);
  markWells();
}
function markWells() { $$('.well[data-id]').forEach((w) => { const i = S.pig.indexOf(w.dataset.id); w.classList.toggle('on', i >= 0 && S.pig.length === 1); w.classList.toggle('part', i >= 0 && S.pig.length > 1); }); }
function buildHistory() {
  const h = $('#history'); if (!h) return; h.innerHTML = '';
  for (const id of S.history) { const p = pigById(id), b = document.createElement('button'); b.className = 'sw'; b.style.background = wellColour(p); b.title = p.name; b.onclick = () => choosePigment(id); h.appendChild(b); }
  if (!S.history.length) h.innerHTML = '<small style="color:var(--dim);padding:4px">colours you paint with appear here</small>';
}
function choosePigment(id, add) {
  if (add && S.pig.length) {
    const i = S.pig.indexOf(id);
    if (i >= 0) S.weights[i] += 1; else { S.pig.push(id); S.weights.push(1); }
    if (S.pig.length > 4) { S.pig.shift(); S.weights.shift(); }
  } else { S.pig = [id]; S.weights = [1]; }
  if (S.tool !== 'paint') setTool('paint');
  if (current().mode !== 0) useBrush('round');
  loadBrush(); markWells(); savePrefs();
}
$('#mixToggle').onclick = () => { mixMode = !mixMode; $('#mixToggle').classList.toggle('on', mixMode); toast(mixMode ? 'Mixing: tap pigments to add them to the brush' : 'Tap a pigment to load it'); };
$('#mixWell').onclick = (e) => { e.stopPropagation(); togglePop('colPop'); };

// layers
let thumbsDirty = true, selOpts = false;
function buildLayers() {
  if (!sim || !$('#layerPop').classList.contains('open')) return;
  const list = $('#layerList'); list.innerHTML = '';
  $('#layCount').textContent = `${sim.layers.length} of ${sim.maxLayers}`;
  for (const L of [...sim.layers].reverse()) {
    const row = document.createElement('div'); row.className = 'lay' + (L === sim.layer ? ' on' : '') + (L.visible ? '' : ' hid');
    row.innerHTML = `<canvas width="64" height="48"></canvas><div class="nm"><b></b><small>${L.opacity < 1 ? Math.round(L.opacity * 100) + '%' : 'Normal'}</small></div><input type="checkbox" title="Visible">`;
    row.querySelector('b').textContent = L.name;
    const cb = row.querySelector('input'); cb.checked = L.visible;
    cb.onclick = (e) => { e.stopPropagation(); sim.setLayerProps(L, { visible: cb.checked }); needsRender = true; scheduleSave(); buildLayers(); };
    row.onclick = () => { if (L === sim.layer) selOpts = !selOpts; else { sim.setLayer(L); selOpts = false; } needsRender = true; buildLayers(); };
    drawThumb(row.querySelector('canvas'), L);
    list.appendChild(row);
  }
  // the paper is the background layer
  const bg = document.createElement('div'); bg.className = 'lay bg';
  bg.innerHTML = `<canvas width="64" height="48"></canvas><div class="nm"><b>Background</b><small>${PAPERS[doc.paper].name}${doc.texture ? '' : ', flat'}</small></div>`;
  const bgc = bg.querySelector('canvas').getContext('2d'); bgc.fillStyle = rgbToHex(TINTS[doc.tint]); bgc.fillRect(0, 0, 64, 48);
  bg.onclick = () => { closePops(); togglePop('actPop'); $('#actTabs [data-t="canvas"]').click(); };
  list.appendChild(bg);
  const o = $('#layerOpts'); o.innerHTML = '';
  if (selOpts) {
    const L = sim.layer, i = sim.layers.indexOf(L);
    o.innerHTML = `<div class="row"><span>Opacity</span><input type="range" min="0" max="1" step="0.01" value="${L.opacity}" style="width:170px"></div><div class="grid"></div>`;
    o.querySelector('input').oninput = (e) => { sim.setLayerProps(L, { opacity: +e.target.value }); needsRender = true; };
    o.querySelector('input').onchange = () => { scheduleSave(); buildLayers(); };
    const acts = [
      ['Rename', () => { const n = prompt('Layer name', L.name); if (n) { L.name = n; scheduleSave(); } }],
      ['Clear', () => { sim.clearAll(); afterEdit(); }],
      ['Duplicate', () => { if (sim.layers.length >= sim.maxLayers) return toast('Layer limit for this canvas size'); dupLayer(L); afterEdit(); }],
      ['Merge down', () => { if (!sim.mergeDownOp(L)) toast('Nothing below to merge into'); afterEdit(); }],
      ['Move up', () => { sim.moveLayerOp(L, i + 1); afterEdit(); }],
      ['Move down', () => { sim.moveLayerOp(L, i - 1); afterEdit(); }],
      ['Delete', () => { if (!sim.deleteLayerOp(L)) toast('A painting keeps at least one layer'); selOpts = false; afterEdit(); }],
    ];
    for (const [n, f] of acts) { const b = document.createElement('button'); b.className = 'btn' + (n === 'Delete' ? ' danger' : ''); b.textContent = n; b.onclick = f; o.querySelector('.grid').appendChild(b); }
  }
  thumbsDirty = false;
}
function afterEdit() { needsRender = true; updateUndo(); scheduleSave(); thumbsDirty = true; buildLayers(); }
function drawThumb(cv, L) {
  const w = 64, h = Math.max(8, Math.round(64 * sim.H / sim.W)); cv.height = h;
  const px = sim.layerThumb(L, w, h);
  cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
}
function dupLayer(L) {
  const N = sim.newLayerOp(); N.name = L.name + ' copy'; N.opacity = L.opacity;
  sim.blitFull(sim.kOf(L), sim.s.DK.cur); sim.blitFull(sim.kOf(L), sim.s.DK.nxt);
  sim.blitFull(sim.sOf(L), sim.s.DS.cur); sim.blitFull(sim.sOf(L), sim.s.DS.nxt);
  sim.compose();
}
$('#addLayer').onclick = () => { if (sim.layers.length >= sim.maxLayers) { toast(`${sim.maxLayers} layers is the most for this canvas size`); return; } sim.newLayerOp(); selOpts = false; afterEdit(); };
$('#layBtn').onclick = (e) => { e.stopPropagation(); togglePop('layerPop'); };

// actions
function buildActions() {
  tabs('#actTabs', '#actPop', (t) => { if (t === 'video') $('#tlInfo').textContent = `${rec.count} frames recorded`; });
  const pl = $('#paperList'); pl.innerHTML = '';
  for (const [k, p] of Object.entries(PAPERS)) {
    const b = document.createElement('button'); b.className = 'item' + (doc.paper === k ? ' on' : '');
    b.innerHTML = `<span>${p.name}<small>${p.note}</small></span>`;
    b.onclick = () => { doc.paper = k; sim.setPaper(makePaper(k, 512, 3)); applyLook(); scheduleSave(); buildActions(); };
    pl.appendChild(b);
  }
  const tc = $('#tints'); tc.innerHTML = '';
  for (const [k, v] of Object.entries(TINTS)) { const b = document.createElement('button'); b.className = 'sw' + (doc.tint === k ? ' on' : ''); b.title = k; b.style.background = rgbToHex(v); b.onclick = () => { doc.tint = k; applyLook(); scheduleSave(); buildActions(); }; tc.appendChild(b); }
  const ps = $('#patSeg'); ps.innerHTML = '';
  PATTERNS.forEach((n, i) => { const b = document.createElement('button'); b.textContent = n; b.className = (doc.pattern || 0) === i ? 'on' : ''; b.onclick = () => { doc.pattern = i; applyPattern(); needsRender = true; scheduleSave(); buildActions(); }; ps.appendChild(b); });
  const chk = (id, get, set) => { const el = $(id); el.checked = get(); el.onchange = () => { set(el.checked); savePrefs(); }; };
  chk('#optTexture', () => doc.texture, (v) => { doc.texture = v; applyLook(); scheduleSave(); });
  chk('#optFlip', () => view.f < 0, (v) => { const c = toSheet(innerWidth / 2, innerHeight / 2); view.f = v ? -1 : 1; const q = toScreen(c.x, c.y); view.x += innerWidth / 2 - q.x; view.y += innerHeight / 2 - q.y; needsRender = true; });
  chk('#optRecord', () => S.record, (v) => (S.record = v));
  chk('#optRight', () => S.right, (v) => { S.right = v; document.body.classList.toggle('right', v); });
  chk('#optFs', () => !!S.autoFs, (v) => { S.autoFs = v; if (v) setFullscreen(true); });
  chk('#optEink', () => !!S.eink, (v) => { S.eink = v; applyTheme(); });
  chk('#optCursor', () => S.cursor, (v) => { S.cursor = v; updateCursor(); });
  chk('#optQuick', () => S.quick, (v) => (S.quick = v));
  chk('#optRotate', () => S.rotate, (v) => { S.rotate = v; if (!v) { view.r = 0; needsRender = true; } });
  chk('#optLoad', () => S.runDry, (v) => (S.runDry = v));
  $('#optPressure').value = S.pressure; $('#optPressure').oninput = (e) => { S.pressure = +e.target.value; savePrefs(); };
  $('#optSmooth').value = S.smooth; $('#optSmooth').oninput = (e) => { S.smooth = +e.target.value; savePrefs(); };
  seg('#fingerSeg', S.fingers, (v) => { S.fingers = v; savePrefs(); });
  buildAdjust();
}
$('#menuBtn').onclick = (e) => { e.stopPropagation(); togglePop('actPop'); };
$('#galItem').onclick = () => { closePops(); openGallery(); };
$('#fsItem').onclick = () => { closePops(); setFullscreen(!fsEl()); };
$('#shareBtn').onclick = (e) => { e.stopPropagation(); exportImage('png'); };
function showHelp() { if (!$('#actPop').classList.contains('open')) togglePop('actPop'); $('#actTabs [data-t="help"]').click(); }
$('#helpBtn').onclick = (e) => { e.stopPropagation(); if ($('#actPop').classList.contains('open') && $('[data-pane="help"]').style.display !== 'none') closePops(); else showHelp(); };
$('#exportPng').onclick = () => { closePops(); exportImage('png'); };
$('#exportJpg').onclick = () => { closePops(); exportImage('jpeg'); };
$('#exportVid').onclick = async () => { closePops(); await rec.flush().catch(() => {}); if (!rec.count) return toast('Nothing recorded yet'); toast('Recording video…', 4000); try { await exportVideo(rec, doc.name, 30, toast); } catch (e) { toast('Video export failed: ' + e.message, 3000); } };
$('#replayBtn').onclick = () => { closePops(); openPlayer(rec, doc.name, toast); };
$('#exportVid2').onclick = () => { closePops(); openPlayer(rec, doc.name, toast); };
$('#renameBtn').onclick = () => { const n = prompt('Name this painting', doc.name); if (n) { doc.name = n; scheduleSave(); } };

// water & drying
let dryHold = false;
function buildAdjust() {
  seg('#drySeg', S.drying, (v) => { S.drying = +v; sim.speed = S.drying; savePrefs(); });
  seg('#tiltSeg', tiltMode, (v) => setTilt(+v));
}
function dryNow() { sim.dryNow(); needsRender = true; scheduleSave(); toast('Dried'); }
// hair dryer: hold to dry faster, double-tap to dry at once
let lastDryTap = 0;
$('#dryBtn').addEventListener('pointerdown', (e) => {
  e.preventDefault(); e.stopPropagation();
  const now = performance.now();
  if (now - lastDryTap < 330) { dryNow(); lastDryTap = 0; return; }
  lastDryTap = now; dryHold = true; $('#dryBtn').classList.add('on');
});
for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) $('#dryBtn').addEventListener(ev, () => { dryHold = false; $('#dryBtn').classList.remove('on'); });
$('#tiltBtn').onclick = (e) => { e.stopPropagation(); setTilt((tiltMode + 1) % 3); };

// tilt: flat, board tilted towards you, or follow the device (where it has a gyro)
let tiltMode = 0, devGrav = [0, 0];
async function setTilt(m) {
  if (m === 2) {
    try { if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission && await DeviceOrientationEvent.requestPermission() !== 'granted') m = 0; } catch { m = 0; }
    if (!('ondeviceorientation' in window) || !matchMedia('(pointer: coarse)').matches) { toast('This device has no tilt sensor'); m = 0; }
  }
  tiltMode = m; buildAdjust(); $('#tiltBtn').classList.toggle('on', m > 0);
  toast(['Board flat', 'Board tilted: wet paint runs down the sheet', 'Tilt your device to move wet paint'][m]);
}
addEventListener('deviceorientation', (e) => {
  if (tiltMode !== 2 || e.beta == null) return;
  const o = (screen.orientation?.angle || 0) * Math.PI / 180;
  let gx = Math.sin((e.gamma || 0) * Math.PI / 180), gy = Math.sin((e.beta || 0) * Math.PI / 180);
  devGrav = [gx * Math.cos(o) + gy * Math.sin(o), -gx * Math.sin(o) + gy * Math.cos(o)];
});
function gravity() {
  const g = tiltMode === 1 ? [0, 0.6] : tiltMode === 2 ? devGrav : [0, 0];
  const c = Math.cos(-view.r), s = Math.sin(-view.r);
  return [view.f * (c * g[0] - s * g[1]) * 0.012, (s * g[0] + c * g[1]) * 0.012];
}

// undo
function doUndo() { if (stroke) endStroke(); if (sim.undoStep()) { needsRender = true; toast('Undo', 700); afterEdit(); } updateUndo(); }
function doRedo() { if (sim.redoStep()) { needsRender = true; toast('Redo', 700); afterEdit(); } updateUndo(); }
function updateUndo() { $('#undoBtn').disabled = !sim?.canUndo; $('#redoBtn').disabled = !sim?.canRedo; }
$('#undoBtn').onclick = doUndo; $('#redoBtn').onclick = doRedo;

// ---------- export ----------
async function exportImage(type = 'png') {
  const px = sim.exportPixels();
  const c = document.createElement('canvas'); c.width = sim.W; c.height = sim.H;
  c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), sim.W, sim.H), 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/' + type, 0.92));
  const name = `${(doc.name || 'aquarelle').replace(/[^\w -]+/g, '')}.${type === 'png' ? 'png' : 'jpg'}`;
  window.__lastExport = { w: sim.W, h: sim.H, bytes: blob.size, type };
  const file = new File([blob], name, { type: blob.type });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: doc.name }); return; } catch { /* cancelled */ } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Saved ' + name);
}

// ---------- saving ----------
let saveT = 0, saving = false, dirty = false;
function scheduleSave() { dirty = true; clearTimeout(saveT); saveT = setTimeout(save, 1500); }
async function makeThumb() {
  const sc = Math.min(1, 480 / sim.W), w = Math.round(sim.W * sc), h = Math.round(sim.H * sc);
  const px = sim.exportPixels({ scale: sc });
  const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
}
/** Before another painting replaces this one: wait for a save in flight, then save if needed. */
async function flushSave() {
  if (!doc || NOSAVE) return;
  clearTimeout(saveT);
  while (saving) await new Promise((r) => setTimeout(r, 30));
  if (dirty) { sim.dryNow(); await save(true); }
}
async function save(force) {
  if (NOSAVE || !doc) return;
  if (saving) { scheduleSave(); return; }
  if (!force && (stroke || sim.wet)) { saveT = setTimeout(save, 1200); return; } // save once it has dried
  saving = true;
  const d = doc, s = sim;
  try {
    const data = await s.readAll();
    if (s !== sim) return; // another painting was opened meanwhile
    const frames = await rec.flush();
    await store.savePainting(d.id, { id: d.id, name: d.name, W: d.W, H: d.H, created: d.created, frames, thumb: await makeThumb() }, { ...data, paper: d.paper, tint: d.tint, texture: d.texture, pattern: d.pattern || 0 });
    d.frames = frames;
    dirty = false; window.__saved = (window.__saved || 0) + 1;
  } catch (e) { console.warn('save failed', e); }
  finally { saving = false; }
}
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) { sim.dryNow(); save(true); } });

// ---------- gallery ----------
async function openGallery() {
  await flushSave();
  closePops();
  $('#gallery').classList.add('open');
  const grid = $('#ggrid'); grid.innerHTML = '';
  const list = NOSAVE ? [] : await store.listPaintings();
  if (doc && !list.find((m) => m.id === doc.id)) list.unshift({ ...doc, updated: Date.now(), thumb: null, unsaved: true });
  for (const m of list) {
    const card = document.createElement('div'); card.className = 'card' + (doc && m.id === doc.id ? ' cur' : '');
    const url = m.thumb ? URL.createObjectURL(m.thumb) : null;
    card.innerHTML = `<button class="th">${url ? `<img src="${url}" alt="">` : ''}</button><div class="meta"><div><b></b><small>${m.W} × ${m.H} · ${new Date(m.updated).toLocaleDateString()}</small></div><button class="more">⋯</button></div>`;
    card.querySelector('b').textContent = m.name;
    card.querySelector('.th').onclick = () => openById(m.id);
    card.querySelector('.more').onclick = (e) => cardMenu(e, m);
    grid.appendChild(card);
  }
}
function menu(e, items) {
  closePops();
  const m = document.createElement('div'); m.className = 'menu';
  for (const [label, f, cls] of items) { const b = document.createElement('button'); b.textContent = label; if (cls) b.style.color = '#ff6b6b'; b.onclick = () => { m.remove(); f(); }; m.appendChild(b); }
  document.body.appendChild(m);
  const r = e.target.getBoundingClientRect();
  m.style.left = Math.min(innerWidth - 200, r.left) + 'px'; m.style.top = Math.min(innerHeight - m.offsetHeight - 10, r.bottom + 4) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', function off(ev) { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener('pointerdown', off); } }), 0);
}
function cardMenu(e, m) {
  menu(e, [
    ['Rename', async () => { const n = prompt('Name', m.name); if (!n) return; if (doc?.id === m.id) { doc.name = n; await save(true); } else await store.put('meta', m.id, { ...m, name: n }); openGallery(); }],
    ['Duplicate', async () => { if (doc?.id === m.id) await save(true); await store.duplicatePainting(m.id); openGallery(); }],
    ['Delete', async () => {
      if (!confirm(`Delete “${m.name}”? This cannot be undone.`)) return;
      await store.deletePainting(m.id);
      if (doc?.id === m.id) { doc = null; S.currentId = null; savePrefs(); }
      openGallery();
    }, true],
  ]);
}
async function openById(id) {
  if (doc?.id === id) { $('#gallery').classList.remove('open'); return; }
  await flushSave();
  const meta = await store.get('meta', id), data = await store.loadPainting(id);
  if (!meta || !data) { toast('Could not open that painting'); return; }
  openDoc({ id, name: meta.name, W: data.W, H: data.H, paper: data.paper || 'cold', tint: data.tint || 'white', texture: !!data.texture, pattern: data.pattern || 0, created: meta.created, frames: meta.frames || 0 }, data);
  $('#gallery').classList.remove('open');
}
async function createPainting(W, H, name, pattern = 0) {
  await flushSave();
  const d = newDoc(W, H, name, pattern);
  openDoc(d, null);
  $('#gallery').classList.remove('open');
  dirty = true; save(true);
  return d;
}
$('#galBtn').onclick = (e) => { e.stopPropagation(); openGallery(); };
$('#galBack').onclick = () => { if (doc) $('#gallery').classList.remove('open'); };
$('#newBtn').onclick = (e) => menu(e, [
  ['Notebook page, lined', async () => { await createPainting(1264, 1680, 'Notes', 1); setMode('pen'); }],
  ['Notebook page, grid', async () => { await createPainting(1264, 1680, 'Notes', 2); setMode('pen'); }],
  ...SIZES.filter((s) => !s.note).map((s) => { const [w, h] = s.get(); return [`${s.name}  ${w} × ${h}`, () => createPainting(w, h)]; }),
]);
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  const bmp = await createImageBitmap(f);
  // canvas up to ~3 Mpx at the image's aspect
  const sc = Math.min(1, Math.sqrt(3.1e6 / (bmp.width * bmp.height)), 2400 / Math.max(bmp.width, bmp.height));
  const d = await createPainting(Math.round(bmp.width * sc), Math.round(bmp.height * sc), f.name.replace(/\.[^.]+$/, ''));
  sim.importImage(bmp); bmp.close?.(); sim.layer.name = 'Photo'; sim.newLayerOp(); sim.undo.length = 0;
  needsRender = true; updateUndo(); scheduleSave(); toast('Imported as a glaze layer: paint on the layer above');
  return d;
};


// ---------- fullscreen ----------
// Fullscreen API where the browser has it (Android, desktop, iPad Safari with the webkit
// prefix); an installed app already runs full screen from its manifest.
const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
const fsAvail = () => !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
// installed to the home screen (Chrome also reports display-mode: fullscreen while the Fullscreen API is active, hence the fsEl check)
const standalone = () => !fsEl() && (matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches || navigator.standalone);
async function setFullscreen(on) {
  try {
    if (on && !fsEl()) { const d = document.documentElement; await (d.requestFullscreen ? d.requestFullscreen({ navigationUI: 'hide' }) : d.webkitRequestFullscreen()); }
    else if (!on && fsEl()) await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
  } catch (e) { console.info('fullscreen refused', e.message); }
}
function updateFsButton() { const b = $('#fsBtn'); if (!b) return; b.style.display = fsAvail() && !standalone() ? '' : 'none'; b.classList.toggle('on', !!fsEl()); b.querySelector('use').setAttribute('href', fsEl() ? '#i-fsexit' : '#i-fs'); }
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => { updateFsButton(); setTimeout(onResize, 60); });
$('#fsBtn')?.addEventListener('click', (e) => { e.stopPropagation(); setFullscreen(!fsEl()); });
// first touch goes full screen (a browser only allows it from a tap), if the preference is on
let fsTried = false;
document.addEventListener('pointerdown', () => {
  if (fsTried || !S.autoFs || !fsAvail() || standalone() || fsEl()) return;
  fsTried = true; setFullscreen(true);
}, true);
updateFsButton();

// ---------- frame loop ----------
let lastRender = 0, lastT = performance.now(), frameEma = 16, lastAdapt = 0, lastTick = -1, wasWet = null;
function render() { sim.render({ inv: invMat(), zoom: view.z }, canvas.width, canvas.height, dpr, { desk: S.eink ? [0.8, 0.8, 0.8] : [0.025, 0.025, 0.028] }); }
// Adaptive load: if frames run long while the sheet is wet, take fewer simulation substeps per
// frame (drying is scaled per substep, so it takes the same time); give them back with headroom.
function adapt(t, ms) {
  frameEma = frameEma * 0.9 + Math.min(ms, 100) * 0.1;
  if (!sim.wet || t - lastAdapt < 400) return;
  if (frameEma > 21 && sim.maxSub > 1) { sim.maxSub--; lastAdapt = t; } else if (frameEma < 14 && sim.maxSub < 6) { sim.maxSub++; lastAdapt = t + 600; }
}
function markWet(force) {
  const wet = sim.wet;
  if (wet === wasWet && !force) return;
  $('#wet').classList.toggle('on', wet); $('#wetText').textContent = wet ? 'wet' : 'dry'; wasWet = wet;
  if (!wet) { scheduleSave(); thumbsDirty = true; }
}
function frame(t) {
  const ms = t - lastT, dt = Math.min(0.25, ms / 1000); lastT = t;
  if (sim && doc) {
    adapt(t, ms);
    sim.params.grav = gravity();
    sim.dryBoost = dryHold ? 3 : 0;
    const stepped = sim.step(dt);
    if (stepped) { needsRender = true; paintTick++; }
    // e-paper: a drying wash is redrawn a few times a second, not every frame (fewer flashes)
    if (needsRender && (!S.eink || stroke || !sim.wet || t - lastRender > 150)) { render(); needsRender = false; lastRender = t; }
    markWet();
    if (S.record && rec.id && rec.due(paintTick !== lastTick)) { lastTick = paintTick; rec.capture(sim); }
    if (thumbsDirty && !sim.wet && $('#layerPop').classList.contains('open')) buildLayers();
  }
  requestAnimationFrame(frame);
}

// ---------- start ----------
setTool(S.tool); buildWells(); loadBrush(); applyTheme(); setMode(S.mode); syncSliders();
let opened = false;
if (!qs.has('fresh') && !NOSAVE) {
  try {
    const mig = await store.migrateV1();
    if (mig && !S.currentId) S.currentId = mig;
    if (S.currentId) { await openById(S.currentId); opened = !!doc; }
    if (!opened) { const l = await store.listPaintings(); if (l.length) { await openById(l[0].id); opened = !!doc; } }
  } catch (e) { console.warn('could not open the gallery', e); }
}
if (!opened) {
  // first visit: a canvas the shape of the screen, straight into painting
  const [w, h] = SIZES.find((s) => s.name === 'Screen size').get();
  openDoc(newDoc(w, h), null);
  if (!NOSAVE) { dirty = true; save(true); }
  if (!S.helpSeen && !qs.has('nohelp')) { showHelp(); S.helpSeen = true; savePrefs(); }
}
requestAnimationFrame(frame);
if ('serviceWorker' in navigator && !qs.has('nosw') && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

// test / debugging hook
window.__aq = {
  box, get dpr() { return dpr; }, setFullscreen, get sim() { return sim; }, get doc() { return doc; }, view, S, get stroke() { return stroke; }, fit, setTool, selectBrush, choosePigment, useCustom, render,
  redraw: () => { needsRender = true; }, useBrush, setMode, setNib, setPenColour, exportImage, save, toSheet, toScreen, openGallery, openById, createPainting, rec, togglePop, dupLayer,
  get penSeen() { return penSeen; },
};
window.__ready = true;

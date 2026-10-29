/*
 * app.js - Aquarelle UI: floating toolbars around the sheet (menu, gallery, wet dot and
 * Pen | Paint top left; undo, redo, hair dryer, tilt, layers, share, full screen, help top
 * right; brushes on the left with size / water / paint sliders beside them; the pigment
 * palette along the bottom, or the pen bar in pen mode). Input (pen / touch / mouse), view
 * (pan, zoom, rotate, flip), QuickShape, layers, autosave and time-lapse sit around the
 * simulation in sim.js.
 */
import { Sim, TILE } from './sim.js';
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
  drying: 1, runDry: true, fingers: 'auto', smooth: 0.3, rotate: true, right: false, cursor: true, pressure: 1, quick: false, palm: true, record: true,
  helpSeen: false, currentId: null,
  autoFs: /Android/i.test(navigator.userAgent) && matchMedia('(pointer: coarse)').matches,
  // zoom a page opens at, relative to the whole page (1) or 'width'; null = 125% on small
  // screens (7" e-readers, phones), the whole page elsewhere
  zoomStart: null,
  labels: true, // show a tool's name when it is tapped
  // pen mode (notes): nib, ink colour, highlighter colour, size per nib
  mode: 'paint', pen: { nib: 'ballpoint', col: '#141414', mark: '#ffe24a', size: Object.fromEntries(Object.entries(INKS).map(([k, v]) => [k, v.size])), customs: [] },
  eink: null,
};
let S;
try { S = { ...structuredClone(DEF), ...JSON.parse(localStorage.getItem('aquarelle:prefs') || '{}') }; } catch { S = structuredClone(DEF); }
if (qs.has('fresh')) S = structuredClone(DEF);
// prefs v2: QuickShape became opt-in (it snapped shading into wet rings)
if ((S.pv || 1) < 2) { S.quick = false; S.pv = 2; }
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
  sim.setPattern(doc.pattern || 0, Math.round((sim.infinite ? 1680 : Math.max(sim.W, sim.H)) / 22), S.eink ? [0.6, 0.6, 0.6] : [0.62, 0.72, 0.9]);
  sim.pattern.margin = S.eink ? [0.7, 0.7, 0.7] : [0.95, 0.55, 0.55];
}

/** A simulation of this size and kind (a page, or the window of an infinite page). */
function ensureSim(W, H, infinite) {
  if (sim && sim.W === W && sim.H === H && sim.infinite === !!infinite) return;
  try { sim?.dispose(); sim = new Sim(gl, W, H, makePaper(doc.paper, 512, 3), { infinite }); } catch (e) { fatal(e.message); }
  sim.speed = S.drying;
}
const isInf = (data) => data?.v === 3 || data?.infinite;
/** Open a painting. data = the saved page, or null for a blank sheet. */
async function openDoc(d, data) {
  doc = d; world = null;
  d.pages ??= [d.id]; d.page ??= 0; d.pageThumbs ??= {};
  view.f = 1; userMovedView = false;
  if (isInf(data)) await openInfinite(d.pages[d.page], data);
  else { ensureSim(d.W, d.H, false); sim.loadAll(data || { layers: [] }); applyLook(); fit(); }
  rec.reset(NOSAVE ? null : d.id, d.frames || 0);
  updatePages();
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
  const id = store.newId();
  return { id, name: name || (pattern ? 'Notes' : 'Untitled'), W, H, paper: pattern ? 'hot' : 'cold', tint: 'white', texture: false, pattern, created: Date.now(), frames: 0, pages: [id], page: 0, pageThumbs: {} };
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
  layoutPanels();
  // a view you moved yourself: keep what was at the old centre at the new centre
  view.x += box.x + box.w / 2 - cx; view.y += box.y + box.h / 2 - cy; needsRender = true;
}
/** Rect of a visible panel, or null. */
const rectOf = (sel) => { const el = $(sel); if (!el || !el.offsetParent && getComputedStyle(el).position !== 'fixed') return null; const r = el.getBoundingClientRect(); return r.width && r.height ? r : null; };
/** Move panels that would collide: the page control below the top bars when they leave
 *  no room for it, the zoom buttons above a tall bottom bar. */
// Make every panel fit whatever the screen: buttons that do not fit the top right bar go
// into a ⋯ menu, the tool strip scrolls between the top bars and the palette, the slider
// shortens (and goes, leaving the chips, which drag too), the zoom bar drops its % last.
const MORE = ['helpBtn', 'shareBtn', 'fsBtn', 'tiltBtn', 'layBtn', 'dryBtn', 'redoBtn', 'hideBtn']; // first to go first
const moreBtn = Object.assign(document.createElement('button'), { className: 'ico', id: 'moreBtn', title: 'More', innerHTML: '<svg><use href="#i-more"/></svg>' });
const morePop = Object.assign(document.createElement('div'), { id: 'morePop', className: 'pop under right' });
document.body.appendChild(morePop);
moreBtn.onclick = (e) => { e.stopPropagation(); togglePop('morePop'); };
morePop.addEventListener('click', (e) => { if (e.target.closest('button') && !['layBtn'].includes(e.target.closest('button').id)) setTimeout(() => morePop.classList.remove('open'), 0); });
const visible = (el) => el && getComputedStyle(el).display !== 'none';
function fitTopBars() {
  const tr = $('#topR'), home = MORE.map((id) => document.getElementById(id));
  // everything back home, in its order, then move out until the bars do not touch
  for (const b of [...$$('#topR > button'), ...morePop.children]) if (b !== moreBtn) tr.appendChild(b);
  const order = ['undoBtn', 'redoBtn', 'dryBtn', 'tiltBtn', 'layBtn', 'shareBtn', 'fsBtn', 'helpBtn', 'hideBtn'];
  for (const id of order) tr.appendChild(document.getElementById(id));
  moreBtn.remove();
  const clash = () => { const l = rectOf('#topL'), r = tr.getBoundingClientRect(); return l && r.left < l.right + 8; };
  if (!clash()) return;
  tr.insertBefore(moreBtn, $('#hideBtn'));
  for (const b of home) {
    if (!clash()) break;
    if (!visible(b)) continue;
    morePop.prepend(b);
  }
}
function fitColumns() {
  const tools = $('#tools'), sl = $('#sliders'), track = $('#slTrack'), zb = $('#zoomBar');
  tools.style.top = tools.style.maxHeight = tools.style.transform = '';
  track.style.height = ''; track.style.display = ''; sl.style.top = sl.style.transform = sl.style.maxHeight = sl.style.overflowY = ''; if (!pstate('sliders').pos) sl.style.left = '';
  $('#zoomPct').style.display = '';
  const topB = Math.max(...['#topL', '#topR', '#pages'].map(rectOf).filter(Boolean).map((r) => r.bottom), box.y) + 6;
  const bar = rectOf(S.mode === 'pen' ? '#penBar' : '#palette');
  // tool strip: between the top bars and the palette (on the left both reach it)
  const t = !pstate('tools').pos && rectOf('#tools');
  if (pstate('tools').pos) { placePanel('tools'); const r = rectOf('#tools'); if (r && r.height > innerHeight - 16) { tools.style.maxHeight = innerHeight - 16 + 'px'; placePanel('tools'); } }
  if (t) {
    const lo = bar && bar.left < t.right + 12 ? bar.top - 6 : box.y + box.h - 8, room = lo - topB;
    if (t.height > room) { tools.style.top = topB + 'px'; tools.style.transform = 'none'; tools.style.maxHeight = Math.max(100, room) + 'px'; }
    else if (t.top < topB || t.bottom > lo) { tools.style.top = (topB + lo) / 2 + 'px'; }
  }
  // zoom bar above the palette or pen bar, if they share the corner
  const z = rectOf('#zoomBar');
  if (z && bar && bar.left < z.right && bar.right > z.left && bar.top < z.bottom) zb.style.bottom = box.y + box.h - bar.top + 8 + 'px';
  // slider column: above the zoom bar when they share the edge
  const s = !pstate('sliders').pos && rectOf('#sliders'), z2 = rectOf('#zoomBar');
  if (pstate('sliders').pos) placePanel('sliders');
  // beside the tool strip (a scrolling strip is a little wider)
  if (s && !pstate('tools').pos) { const t2 = rectOf('#tools'); if (t2 && s.left < t2.right + 2 && s.right > t2.left && s.top < t2.bottom && s.bottom > t2.top) sl.style.left = t2.right + 4 + 'px'; }
  if (s) {
    let lo = box.y + box.h - 8;
    if (z2 && z2.left < s.right && z2.right > s.left) lo = Math.min(lo, z2.top - 6);
    if (bar && bar.left < s.right && bar.right > s.left) lo = Math.min(lo, bar.top - 6);
    const top = Math.max(s.top, topB), over = top + s.height - lo;
    if (over > 0 || s.top < topB) {
      const th = track.getBoundingClientRect().height;
      if (over > 0) { const h = th - over; if (h >= 56) track.style.height = h + 'px'; else track.style.display = 'none'; }
      const s2 = rectOf('#sliders');
      if (s2 && (s2.top < topB || s2.bottom > lo)) { sl.style.transform = 'none'; sl.style.top = Math.max(topB, Math.min(s2.top, lo - s2.height)) + 'px'; }
      const s3 = rectOf('#sliders'); if (s3 && s3.bottom > lo) { sl.style.maxHeight = Math.max(80, lo - s3.top) + 'px'; sl.style.overflowY = 'auto'; }
    }
  }
  // a very short screen: the zoom bar keeps + and − only
  const z3 = rectOf('#zoomBar');
  if (z3 && z3.top < topB) $('#zoomPct').style.display = 'none';
}
// ---------- movable, foldable panels ----------
// The palette, the pen bar, the tool strip and the size / water / paint column have a grip:
// drag it to put the panel anywhere, tap it to fold the panel down to what is selected
// (tap the folded panel to open it again), double-tap it to put the panel back.
// S.panels[id] = { folded, pos: { ax: 'l' | 'r', x, ay: 't' | 'b', y } } (px from the nearest edges).
const MOVABLE = ['palette', 'penBar', 'tools', 'sliders'];
const pstate = (id) => ((S.panels ??= {})[id] ??= {});
for (const id of MOVABLE) {
  const el = document.getElementById(id);
  const g = Object.assign(document.createElement('button'), { className: 'grip', title: 'Move or fold — drag to move, tap to fold, double-tap to put back', innerHTML: '<svg><use href="#i-grip"/></svg>' });
  el.prepend(g);
  let d = null, lastTap = 0;
  g.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); g.setPointerCapture(e.pointerId);
    const r = el.getBoundingClientRect();
    d = { x: e.clientX, y: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, moved: false };
  });
  g.addEventListener('pointermove', (e) => {
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    d.moved = true; labelEl.style.display = 'none';
    const w = el.offsetWidth, h = el.offsetHeight;
    const L = Math.max(0, Math.min(innerWidth - w, e.clientX - d.ox)), T = Math.max(0, Math.min(innerHeight - h, e.clientY - d.oy));
    const ax = L + w / 2 < innerWidth / 2 ? 'l' : 'r', ay = T + h / 2 < innerHeight / 2 ? 't' : 'b';
    pstate(id).pos = { ax, x: ax === 'l' ? L : innerWidth - L - w, ay, y: ay === 't' ? T : innerHeight - T - h };
    placePanel(id);
  });
  const up = (e) => {
    if (!d) return;
    const moved = d.moved; d = null;
    if (e.type !== 'pointerup') return;
    if (moved) { savePrefs(); panelsChanged(); return; }
    const now = performance.now();
    if (now - lastTap < 350) { // double-tap: back where it belongs, unfolded
      clearTimeout(g.t); lastTap = 0; delete pstate(id).pos; pstate(id).folded = false; applyPanel(id); savePrefs(); panelsChanged(); return;
    }
    lastTap = now;
    g.t = setTimeout(() => setFolded(id, !pstate(id).folded), 260);
  };
  g.addEventListener('pointerup', up); g.addEventListener('pointercancel', up);
  g.addEventListener('click', (e) => e.stopPropagation());
  // a folded panel opens again when you tap it
  el.addEventListener('click', (e) => { if (el.classList.contains('folded') && !e.target.closest('.grip')) { e.stopPropagation(); e.preventDefault(); setFolded(id, false); } }, true);
}
/** Hide every panel at once (the page stays exactly where it is), or bring them back. */
function setUiHidden(v) {
  if (v) closePops();
  document.body.classList.toggle('ui-hidden', v);
  labelEl.style.display = 'none';
}
$('#hideBtn').onclick = (e) => { e.stopPropagation(); setUiHidden(true); };
$('#uiShow').onclick = (e) => { e.stopPropagation(); setUiHidden(false); };
function setFolded(id, v) { pstate(id).folded = v; applyPanel(id); savePrefs(); panelsChanged(); }
function applyPanel(id) { document.getElementById(id).classList.toggle('folded', !!pstate(id).folded); placePanel(id); }
/** Put a moved panel where it was put, kept on the screen; a panel that was not moved: clear. */
function placePanel(id) {
  const el = document.getElementById(id), p = pstate(id).pos;
  el.classList.toggle('placed', !!p);
  if (!p) { for (const k of ['left', 'top', 'right', 'bottom', 'transform', 'translate']) el.style[k] = ''; return; }
  const w = el.offsetWidth, h = el.offsetHeight;
  let L = p.ax === 'l' ? p.x : innerWidth - p.x - w, T = p.ay === 't' ? p.y : innerHeight - p.y - h;
  L = Math.max(0, Math.min(innerWidth - w, L)); T = Math.max(0, Math.min(innerHeight - h, T));
  Object.assign(el.style, { left: L + 'px', top: T + 'px', right: 'auto', bottom: 'auto', transform: 'none', translate: 'none' });
}
function panelsChanged() { if (!sim) return; if (!userMovedView) fit(); else layoutPanels(); needsRender = true; }
/** A panel that was moved away from every edge floats over the page and leaves it its room. */
function floating(id) {
  if (!pstate(id).pos) return false;
  const r = rectOf('#' + id); if (!r) return false;
  const m = 36; return r.left > m && r.top > m && r.right < innerWidth - m && r.bottom < innerHeight - m;
}
function resetPanels() { for (const id of MOVABLE) { delete pstate(id).pos; pstate(id).folded = false; applyPanel(id); } savePrefs(); panelsChanged(); }
for (const id of MOVABLE) applyPanel(id);

function layoutPanels() {
  const pg = $('#pages'), zb = $('#zoomBar');
  pg.style.top = ''; zb.style.bottom = '';
  placePanel('palette'); placePanel('penBar');
  fitTopBars();
  const p = rectOf('#pages');
  if (p) {
    const hit = ['#topL', '#topR'].map(rectOf).filter(Boolean).filter((r) => r.left < p.right + 4 && r.right > p.left - 4);
    if (hit.length) pg.style.top = Math.max(...hit.map((r) => r.bottom)) + 6 + 'px';
  }
  fitColumns();
}
/** The rectangle the page is fitted to: the whole viewport below the top bars. The other
 *  panels (tools, sliders, palette, zoom) float over the page instead of shrinking it. */
function freeArea() {
  const gap = box.w < 720 ? 6 : 10;
  let top = box.y;
  for (const sel of ['#topL', '#topR', '#pages']) {
    const r = rectOf(sel); if (!r || r.width < r.height || r.top > box.y + box.h / 3) continue;
    top = Math.max(top, r.bottom);
  }
  const left = box.x + gap, right = box.x + box.w - gap, bottom = box.y + box.h - gap;
  top += gap;
  return { left, top, right, bottom, w: right - left, h: bottom - top };
}
/** Zoom at which the whole sheet just fits the free area ("100%"); on an infinite page,
 *  the zoom at which a page width (1264 px) fills it. */
function baseZ() { const A = freeArea(); return sim.infinite ? A.w / PAGE_W : Math.min(A.w / sim.W, A.h / sim.H); }
const startZoom = () => S.zoomStart ?? (S.eink || box.w <= 720 ? 1.25 : 1);
/**
 * Put the sheet in the free area at a zoom: 1 = whole page, 1.25 = a quarter closer,
 * 'width' = as wide as the free area. Larger than the area, it starts at its top left.
 */
function fit(mode) {
  if (!sim) return;
  if (mode !== 'width' && !(+mode > 0 && +mode < 20)) mode = startZoom(); // also when passed an event or a timestamp
  if (sim.infinite) return infFit(mode === 'width' ? 1 : +mode);
  layoutPanels();
  const A = freeArea(), W = sim.W, H = sim.H, z0 = Math.min(A.w / W, A.h / H);
  const z = mode === 'width' ? A.w / W : z0 * (+mode || 1);
  view.z = z; view.r = 0;
  // wider than the free area: start at its left edge (where writing starts), else centred;
  // taller: start at its top
  view.x = W * z > A.w + 0.5 ? A.left : A.left + (A.w - W * z) / 2;
  view.y = H * z > A.h + 0.5 ? A.top : A.top + (A.h - H * z) / 2;
  if (view.f < 0) view.x += W * z;
  needsRender = true;
}
/** Keep some of the sheet on screen however far it is panned (an infinite page: move its window). */
function clampView() {
  if (!sim) return;
  if (sim.infinite) return worldKeep();
  const A = freeArea(), cs = [[0, 0], [sim.W, 0], [0, sim.H], [sim.W, sim.H]].map(([x, y]) => toScreen(x, y));
  const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y), M = 60;
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (x1 < A.left + M) view.x += A.left + M - x1; else if (x0 > A.right - M) view.x += A.right - M - x0;
  if (y1 < A.top + M) view.y += A.top + M - y1; else if (y0 > A.bottom - M) view.y += A.bottom - M - y0;
}
/** New page in a notebook: same zoom and column, back to the top of the page. */
function placeTop() {
  if (!userMovedView || view.r) { fit(); return; }
  const A = freeArea(), h = sim.H * view.z;
  view.y = h > A.h ? A.top : A.top + (A.h - h) / 2;
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
/** Zoom buttons: about the middle of the free area; landing near the whole page snaps to it. */
function zoomBy(f) {
  const A = freeArea(), b = baseZ();
  let t = view.z * f / b;
  if (Math.abs(t - 1) < 0.06) { fit(1); userMovedView = true; return; }
  t = Math.min(12 / b, Math.max(minRel(), t));
  zoomAt(A.left + A.w / 2, A.top + A.h / 2, t * b / view.z); clampView();
}
/** The %: whole page, or back to the zoom pages open at. */
function zoomToggle() {
  const rel = view.z / baseZ(), st = startZoom();
  fit(Math.abs(rel - 1) < 0.03 ? (st === 1 ? 'width' : st) : 1); userMovedView = true;
}
// zoom slider: logarithmic, from the smallest zoom allowed to 8x the whole page
const zoomRange = () => [minRel(), 8];
function minRel() { return sim?.infinite ? infMinZ() / baseZ() : 0.5; }
let lastPct = '';
function updateZoomLabel() {
  if (!sim) return;
  const rel = view.z / baseZ(), p = Math.round(rel * 100) + '%';
  if (p !== lastPct) {
    $('#zoomPct').textContent = p; lastPct = p;
  }
}
// the % is the zoom slider: drag up / down on it to zoom (logarithmic, finer when dragging
// sideways, a detent at the whole page); a tap toggles whole page / your zoom
{
  let drag = null;
  const el = $('#zoomPct');
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, x: e.clientX, rel: view.z / baseZ(), moved: false };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y; if (Math.abs(dy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const [lo, hi] = zoomRange(), fine = 1 / (1 + Math.abs(e.clientX - drag.x) / 50);
    // 200 px of drag covers the whole range
    let rel = Math.min(hi, Math.max(lo, drag.rel * Math.pow(hi / lo, -dy / 200 * fine)));
    if (Math.abs(rel - 1) < 0.04) rel = 1;
    const A = freeArea(); zoomAt(A.left + A.w / 2, A.top + A.h / 2, rel * baseZ() / view.z); clampView(); updateZoomLabel(); userMovedView = true; needsRender = true;
  });
  let viaPointer = 0;
  const up = (e) => { const d = drag; drag = null; if (d) viaPointer = performance.now(); if (d && !d.moved && e.type === 'pointerup') zoomToggle(); };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  // keyboard (Enter / Space) and other clicks without a pointer still toggle
  el.onclick = (e) => { e.stopPropagation(); if (performance.now() - viaPointer > 400) zoomToggle(); };
}
$('#zoomIn').onclick = (e) => { e.stopPropagation(); zoomBy(1.25); };
$('#zoomOut').onclick = (e) => { e.stopPropagation(); zoomBy(1 / 1.25); };
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
    if (!h || Math.hypot(q.x - h.x, q.y - h.y) * view.z > 6) { clearTimeout(h?.t); stroke.hold = { x: q.x, y: q.y, t: setTimeout(quickShape, 650) }; }
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

/** Pastel: dry chalky stick stamps straight into the paper, catching its grain. */
function emitPastel(s) {
  const st = stroke, { id, B, cfg } = current(st.tool);
  const pr = s.p != null ? s.p : (st.type === 'mouse' ? 0.55 : 0.6);
  const tilt = 1 - s.alt / (Math.PI / 2);
  const r = Math.max(0.8, cfg.size * (1 - B.sizePressure + B.sizePressure * Math.pow(Math.max(pr, 0.05), 0.8)) * (1 + tilt * 0.9));
  const el = 1 + tilt * 1.6, ex = tilt > 0.05 ? -Math.sin(s.az) : 1, ey = tilt > 0.05 ? Math.cos(s.az) : 0;
  const point = { x: s.x, y: s.y, p: pr, t: s.t, r, el, ex, ey };
  let pts;
  if (!st.last) pts = [{ ...point }];
  else {
    const { stamps, rest } = strokeStamps(st.last, point, Math.max(0.5, r * (cfg.spacing || B.spacing)), st.rest);
    st.rest = rest; st.len += Math.hypot(point.x - st.last.x, point.y - st.last.y); pts = stamps;
  }
  st.last = point;
  if (!pts.length) return;
  const v = st.inkVec || (st.inkVec = pastelVec());
  // the stamp's strength is how hard it presses: it sets how deep into the grain it reaches
  sim.ink(pts.map((q) => ({ x: q.x, y: q.y, r: q.r, a: Math.min(1, Math.pow(q.p ?? pr, 0.8) * (0.3 + 0.95 * (cfg.paint ?? 0.6))), ex: q.ex, ey: q.ey, el: q.el, wt: st.seed % 97 })), { mode: 7, tooth: B.tooth, cover: B.cover, ...v });
  needsRender = true; paintTick++;
}
/** The loaded colour as an opaque, chalky pastel (pigment in a white chalk binder). */
function pastelVec() {
  const p = customPigment(rgbToHex(swatch(loaded, 1.1, [1, 1, 1])), 0.85, 0), m = mass(p);
  return { bK: [...p.K, 0], bS: [...p.S, 0.8 * m] };
}

function emit(s) {
  if (stroke.tool === 'pen' || stroke.tool === 'inkerase') return emitInk(s);
  if (current(stroke.tool).mode === 7) return emitPastel(s);
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
  if (stroke.tool === 'paint' && [0, 7].includes(current().mode)) pushHistory(S.pig.length === 1 ? S.pig[0] : null);
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
  const diag = Math.hypot(x1 - x0, y1 - y0), chord = Math.hypot(b.x - a.x, b.y - a.y);
  let mx = 0, my = 0; for (const p of pts) { mx += p.x; my += p.y; } mx /= pts.length; my /= pts.length;
  // a loop: goes once round its middle (1.7 to 2.4 turns of angle, nearly all one way) at a
  // fairly even distance from it, and ends near where it began. Shading back and forth also
  // ends near its start and is long for its size, and used to pass as a loop: it became a
  // wet ring, which a wet brush fills into a blot.
  let turn = 0, back = 0, rs = [];
  for (let i = 1; i < pts.length; i++) {
    let d = Math.atan2(pts[i].y - my, pts[i].x - mx) - Math.atan2(pts[i - 1].y - my, pts[i - 1].x - mx);
    d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI; turn += d; back += Math.abs(d);
  }
  for (const p of pts) rs.push(Math.hypot(p.x - mx, p.y - my));
  const rMean = rs.reduce((u, v) => u + v, 0) / rs.length, rMin = Math.min(...rs);
  const loopy = Math.abs(turn) > 1.7 * Math.PI && Math.abs(turn) < 2.4 * Math.PI && Math.abs(turn) > 0.85 * back && rMin > 0.35 * rMean;
  const closed = chord < diag * 0.3 && loopy;
  // a line: no point strays from the chord by more than 6% of its length
  let dev = 0; for (const p of pts) dev = Math.max(dev, Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / Math.max(chord, 1e-6));
  const straight = !closed && chord > diag * 0.9 && dev < 0.06 * chord;
  if (!closed && !straight) { st.hold = null; return; } // neither: leave the stroke as drawn
  const ps = pts.map((p) => p.p ?? 0.6).sort((u, v) => u - v), pr = ps[Math.floor(ps.length / 2)];
  let shape = [];
  if (closed) {
    // ellipse from the points' mean and covariance (principal axes)
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
  // take the hand-drawn stroke back (with everything its water did) and paint the shape; the
  // hand-drawn state is kept with the shape's undo step, so undo gives you your own stroke
  sim.replaceLast();
  Object.assign(st, { last: null, rest: 0, load: 1, v: 0.15, len: 0, snapped: true });
  let t = a.t;
  for (const q of shape) emit({ x: q.x, y: q.y, p: pr, t: (t += 8), alt: a.alt, az: a.az });
  window.__quick = { closed, n: shape.length };
  toast(closed ? 'QuickShape: ellipse (undo keeps your stroke)' : 'QuickShape: line (undo keeps your stroke)', 1600);
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
  if (![0, 7].includes(current().mode)) useBrush('round');
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
// Palm rejection: while the pen is on or near the screen (down, or any pen event in the last
// 300 ms, hover included) touches are ignored, and touches already down when the pen lands
// are dropped (a stroke a palm began just before is taken back).
let lastPen = -1e9;
const palms = new Set();
const penNear = () => S.palm !== false && (stroke?.type === 'pen' || performance.now() - lastPen < 300);
function dropTouches() {
  for (const id of touches.keys()) palms.add(id);
  touches.clear(); tapCand = null; gesture = null;
  if (pendingTouch) { pendingTouch = null; clearTimeout(lpTimer); }
  if (stroke && stroke.type === 'touch') { const young = performance.now() - stroke0 < 1500; endStroke(); if (young) { sim.discardLast(); updateUndo(); } }
}
for (const ev of ['pointerdown', 'pointermove', 'pointerup']) canvas.addEventListener(ev, (e) => { if (e.pointerType === 'pen') lastPen = performance.now(); }, true);
const copyEv = (e) => ({ clientX: e.clientX, clientY: e.clientY, pressure: e.pressure, pointerType: e.pointerType, timeStamp: e.timeStamp, tiltX: 0, tiltY: 0 });

canvas.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (closePops()) { if (e.pointerType !== 'pen') return; }
  canvas.setPointerCapture?.(e.pointerId);
  if (e.pointerType === 'pen') { penSeen = true; if (S.palm !== false && (touches.size || pendingTouch)) dropTouches(); }
  if (e.pointerType === 'touch' && penNear()) { palms.add(e.pointerId); return; }
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
  if (e.pointerType === 'touch' && palms.has(e.pointerId)) return;
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
  if (mouseDrag) { view.x += e.clientX - mouseDrag.x; view.y += e.clientY - mouseDrag.y; mouseDrag = { x: e.clientX, y: e.clientY }; userMovedView = true; clampView(); needsRender = true; return; }
  hoverPt = { x: e.clientX, y: e.clientY, type: e.pointerType };
  if (stroke && (e.pointerType !== 'touch' || stroke.type === 'touch')) {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const q of evs.length ? evs : [e]) addSample(sampleOf(q));
  }
  updateCursor();
});

function pointerEnd(e) {
  if (e.pointerType === 'touch' && palms.delete(e.pointerId)) return;
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
        if (tapCand.n === 2) doUndo(); else if (tapCand.n === 3) doRedo(); else setUiHidden(!document.body.classList.contains('ui-hidden'));
      } else if (gesture && gesture.mode === 'zoom' && performance.now() - gesture.t0 < 380 && view.z < gesture.z0 * 0.72) { fit(1); userMovedView = true; }
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
/*
 * Two-finger gestures decide what they are from the first ~10 px of movement and keep to
 * it: fingers moving together pan (no zoom, no rotation), spreading or pinching zooms (and
 * pans), and only a clear twist rotates (with Prefs → Rotate on). So a pan never tilts
 * or rescales the page.
 */
function startGesture() {
  const pts = [...touches.values()].slice(0, 2);
  if (pts.length === 1) { gesture = { one: true, s: toSheet(pts[0].x, pts[0].y), t0: performance.now(), z0: view.z }; return; }
  const [p, q] = pts, m0 = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  gesture = {
    mode: null, m0, d0: Math.max(1, Math.hypot(q.x - p.x, q.y - p.y)), ang0: Math.atan2(q.y - p.y, q.x - p.x),
    v0: { x: view.x, y: view.y, z: view.z, r: view.r }, s0: toSheet(m0.x, m0.y), a: toSheet(p.x, p.y), b: toSheet(q.x, q.y),
    t0: gesture?.t0 ?? performance.now(), z0: gesture?.z0 ?? view.z,
  };
}
function moveGesture() {
  const pts = [...touches.values()].slice(0, 2);
  userMovedView = true; needsRender = true;
  if (gesture.one || pts.length < 2) {
    const s = gesture.s || (gesture.s = toSheet(pts[0].x, pts[0].y));
    const q = toScreen(s.x, s.y); view.x += pts[0].x - q.x; view.y += pts[0].y - q.y; clampView(); return;
  }
  const g = gesture, [p, q] = pts, m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, d = Math.hypot(q.x - p.x, q.y - p.y);
  const ang = Math.atan2(q.y - p.y, q.x - p.x), dAng = ((ang - g.ang0 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (!g.mode) {
    // how far each kind of motion has gone, in px at the fingertips
    const T = Math.hypot(m.x - g.m0.x, m.y - g.m0.y), D = Math.abs(d - g.d0), A = Math.abs(dAng) * g.d0 / 2;
    if (Math.max(T, D, A) < 10) return;
    g.mode = S.rotate && A > 1.6 * Math.max(T, D) ? 'rotate' : D > 0.9 * T ? 'zoom' : 'pan';
  }
  if (g.mode === 'pan') { view.x = g.v0.x + m.x - g.m0.x; view.y = g.v0.y + m.y - g.m0.y; }
  else if (g.mode === 'zoom') {
    view.r = g.v0.r; view.z = Math.min(12, Math.max(0.1, g.v0.z * d / g.d0));
    const s = toScreen(g.s0.x, g.s0.y); view.x += m.x - s.x; view.y += m.y - s.y;
  } else {
    const { a, b } = g;
    view.z = Math.min(12, Math.max(0.1, d / Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-3)));
    let r = ang - sheetAng(a, b);
    const snap = Math.round(r / (Math.PI / 2)) * (Math.PI / 2); if (Math.abs(r - snap) < 0.08) r = snap;
    view.r = r;
    const s = toScreen(a.x, a.y); view.x += p.x - s.x; view.y += p.y - s.y;
  }
  clampView();
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault(); userMovedView = true;
  if (e.ctrlKey || e.metaKey || (Math.abs(e.deltaY) > 40 && !e.deltaX && e.deltaMode === 0 && !e.shiftKey)) zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  else { view.x -= e.deltaX; view.y -= e.deltaY; needsRender = true; }
  clampView();
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
  const brushes = { b: 'round', w: 'wash', t: 'flat', r: 'detail', y: 'dry', x: 'splatter', q: 'water', k: 'lift', a: e.shiftKey ? 'pastelpencil' : 'pastel' };
  if (k === 'n') { insertPage(doc.page + 1, !!sim.infinite); return; }
  if (brushes[k]) { if (S.mode === 'pen') setMode('paint'); useBrush(brushes[k]); return; }
  const tools = { s: 'smudge', e: 'erase' };
  if (tools[k]) { if (S.mode === 'pen') setMode('paint'); setTool(tools[k]); markTools(); return; }
  if (k === 'l') { togglePop('layerPop'); return; }
  if (k === 'c') { togglePop('colPop'); return; }
  if (k === 'i') { setPicking(!picking); return; }
  if (k === '[' || k === ']') { const { cfg, id, mode } = current(); cfg.size = Math.max(0.6, Math.min(160, cfg.size * (k === ']' ? 1.15 : 1 / 1.15))); if (mode >= 5) S.pen.size[id] = cfg.size; syncSliders(); updateCursor(); savePrefs(); return; }
  if (k === 'p' && !e.repeat) { setMode(S.mode === 'pen' ? 'paint' : 'pen'); return; }
  if (k === 'f') { dryNow(); return; }
  if (k === '0') { fit(1); userMovedView = true; return; }
  if (k === '=' || k === '+') { zoomBy(1.25); return; }
  if (k === '-' || k === '_') { zoomBy(1 / 1.25); return; }
  if (e.key === 'PageDown') { e.preventDefault(); gotoPage(doc.page + 1, false); return; }
  if (e.key === 'PageUp') { e.preventDefault(); gotoPage(doc.page - 1); return; }
  if (k === 'tab') { e.preventDefault(); setUiHidden(!document.body.classList.contains('ui-hidden')); return; }
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
  closePops(); markTools(); syncSliders(); updateCursor(); buildPenBar(); refreshColour(); requestAnimationFrame(() => (userMovedView ? layoutPanels() : fit()));
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
// One slim slider: the chips above it show size, water and paint, and pick which of them
// the slider moves; dragging up / down on a chip changes that value directly.
const SLIDERS = {
  size: { min: 0.6, max: 160, curve: 2.6, fmt: (v) => (v < 10 ? v.toFixed(1) : Math.round(v) + '') },
  water: { min: 0, max: 1, curve: 1, fmt: (v) => Math.round(v * 100) + '%' },
  paint: { min: 0, max: 1, curve: 1, fmt: (v) => Math.round(v * 100) + '%' },
};
let slKey = 'size';
const usableKeys = () => {
  const { mode } = current();
  // pen ink: size; pastel: size + pressure (paint); water and lift: no paint; erase / smudge: strength
  return mode >= 5 && mode !== 7 ? ['size'] : mode === 7 ? ['size', 'paint'] : mode === 1 ? ['size', 'water'] : mode >= 2 && mode <= 4 ? ['size', 'paint'] : ['size', 'water', 'paint'];
};
const tOf = (k, v) => Math.pow(((v ?? 0) - SLIDERS[k].min) / (SLIDERS[k].max - SLIDERS[k].min), 1 / SLIDERS[k].curve);
function setSlKey(k) { slKey = k; syncSliders(); }
function syncSliders() {
  const { cfg, mode } = current(), keys = usableKeys();
  if (!keys.includes(slKey)) slKey = 'size';
  const panel = $('#sliders'); panel.dataset.k = slKey;
  for (const ch of $$('#sliders .chip')) {
    const k = ch.dataset.k;
    ch.hidden = !keys.includes(k); ch.classList.toggle('on', k === slKey);
    ch.querySelector('b').textContent = SLIDERS[k].fmt(cfg[k] ?? 0);
    ch.querySelector('small').textContent = k === 'paint' ? (mode === 0 ? 'paint' : mode === 7 ? 'press' : 'strength') : k;
  }
  const t = tOf(slKey, cfg[slKey]);
  $('#slTrack .fill').style.height = t * 100 + '%';
  $('#slTrack .knob').style.top = (1 - t) * 100 + '%';
  refreshColour();
}
function setValue(k, t) {
  const { cfg, id, mode } = current(), sl = SLIDERS[k];
  cfg[k] = sl.min + Math.pow(Math.min(1, Math.max(0, t)), sl.curve) * (sl.max - sl.min);
  if (mode >= 5 && mode !== 7 && k === 'size') S.pen.size[id] = cfg.size;
  syncSliders();
  if (k === 'size') showSizePreview();
}
/** Vertical drag on `el` (track of height h px) changing value k; relative, finer when dragging sideways. */
function dragValue(el, getK, h, jump) {
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId);
    const k = getK(), { cfg } = current();
    let t = tOf(k, cfg[k]);
    if (jump) { const r = el.querySelector('.track').getBoundingClientRect(); if (Math.abs(e.clientY - (r.top + (1 - t) * r.height)) > 22) t = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)); }
    drag = { y: e.clientY, x: e.clientX, t, k, moved: false };
    if (jump) setValue(k, t);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
    const fine = 1 / (1 + Math.abs(e.clientX - drag.x) / 50);
    if (drag.moved || jump) setValue(drag.k, drag.t - (e.clientY - drag.y) / (h() || 150) * fine);
  });
  const up = () => { if (drag) { const d = drag; drag = null; $('#cursor').style.display = 'none'; savePrefs(); if (!jump && !d.moved) setSlKey(d.k); } };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}
dragValue($('#slTrack'), () => slKey, () => $('#slTrack .track').getBoundingClientRect().height, true);
for (const ch of $$('#sliders .chip')) dragValue(ch, () => ch.dataset.k, () => $('#slTrack .track').getBoundingClientRect().height, false);
function showSizePreview() {
  const c = $('#cursor'), r = brushRadiusPx();
  c.style.display = 'block'; c.style.width = c.style.height = 2 * r + 'px'; c.style.borderStyle = 'solid';
  c.style.transform = `translate(${box.x + box.w / 2 - r}px, ${box.y + box.h / 2 - r}px)`;
}

// ---------- tool labels ----------
// Tapping (or hovering with a mouse or a hovering pen) a toolbar button shows its name beside
// it for a moment; brushes add what they are for.
const labelEl = document.createElement('div'); labelEl.id = 'tipLabel'; document.body.appendChild(labelEl);
let labelT = 0, hoverT = 0;
function labelFor(b) {
  const br = b.dataset.brush && BRUSHES[b.dataset.brush];
  if (br) return [br.name, br.note];
  if (b.dataset.tool) return [{ smudge: 'Smudge', erase: 'Eraser' }[b.dataset.tool], b.dataset.tool === 'smudge' ? 'push paint around; tap again for its shape' : 'tap again for its shape'];
  if (b.dataset.nib) return null; // pen nibs have their names under them
  const t = (b.getAttribute('title') || '').trim(); if (!t) return null;
  const m = t.match(/^(.*?)(?:\s+\((.*?)\))?(?:\s*[—:]\s*(.*))?$/);
  return [m[1], m[3] || m[2] || ''];
}
function showLabel(b, ms = 1500) {
  const l = labelFor(b); if (!l || !l[0]) return;
  labelEl.innerHTML = '<b></b><small></small>';
  labelEl.querySelector('b').textContent = l[0]; labelEl.querySelector('small').textContent = l[1] || '';
  labelEl.style.display = 'block';
  const r = b.getBoundingClientRect(), w = labelEl.offsetWidth, h = labelEl.offsetHeight;
  // beside a vertical strip, below a top bar, above a bottom bar
  let x, y;
  if (r.top < box.y + 80 && r.width < 80) { x = r.left + r.width / 2 - w / 2; y = r.bottom + 8; }
  else if (r.left < box.x + box.w / 2) { x = r.right + 10; y = r.top + r.height / 2 - h / 2; }
  else { x = r.left - w - 10; y = r.top + r.height / 2 - h / 2; }
  labelEl.style.left = Math.max(4, Math.min(innerWidth - w - 4, x)) + 'px'; labelEl.style.top = Math.max(4, Math.min(innerHeight - h - 4, y)) + 'px';
  clearTimeout(labelT); labelT = setTimeout(() => (labelEl.style.display = 'none'), ms);
}
const hideLabel = () => { clearTimeout(hoverT); clearTimeout(labelT); labelEl.style.display = 'none'; };
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('.panel button, .panel .vs'); if (!b) { hideLabel(); return; }
  if (e.pointerType !== 'mouse' && S.labels !== false) showLabel(b);
}, true);
document.addEventListener('pointerover', (e) => {
  const b = e.target.closest('.panel button'); clearTimeout(hoverT);
  if (!b || e.pointerType === 'touch') return;
  hoverT = setTimeout(() => showLabel(b, 2500), 450);
});
document.addEventListener('pointerout', (e) => { if (e.target.closest('.panel button')) { clearTimeout(hoverT); if (e.pointerType === 'mouse') labelEl.style.display = 'none'; } });

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
  if (open) ({ brushPop: buildBrushes, colPop: buildColour, layerPop: buildLayers, actPop: buildActions, pagePop: buildPages })[id]?.();
  if (open) keepOnScreen(p);
}
/** A popover never runs off the screen: shift it back in, and it scrolls if it is taller. */
function keepOnScreen(p) {
  p.style.translate = ''; p.style.maxHeight = '';
  const r = p.getBoundingClientRect(), m = 4;
  if (r.height > innerHeight - 2 * m) p.style.maxHeight = innerHeight - 2 * m + 'px';
  const r2 = p.getBoundingClientRect();
  const dy = r2.top < m ? m - r2.top : r2.bottom > innerHeight - m ? innerHeight - m - r2.bottom : 0;
  const dx = r2.left < m ? m - r2.left : r2.right > innerWidth - m ? innerWidth - m - r2.right : 0;
  if (dx || dy) p.style.translate = `${dx}px ${dy}px`;
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
  if (![0, 7].includes(current().mode)) useBrush('round');
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
      ['Clear', () => {
        if (sim.infinite) { if (!confirm('Clear this layer everywhere on the infinite page? Undo only brings back the part around you.')) return; clearWorldLayer(L); }
        sim.clearAll(); afterEdit();
      }],
      ['Duplicate', () => { if (sim.infinite) return toast('Not on an infinite page'); if (sim.layers.length >= sim.maxLayers) return toast('Layer limit for this canvas size'); dupLayer(L); afterEdit(); }],
      ['Merge down', () => { if (sim.infinite) return toast('Not on an infinite page'); if (!sim.mergeDownOp(L)) toast('Nothing below to merge into'); afterEdit(); }],
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
  chk('#optLabels', () => S.labels !== false, (v) => (S.labels = v));
  $('#optPanels').onclick = () => { resetPanels(); toast('Panels are back in place'); };
  chk('#optCursor', () => S.cursor, (v) => { S.cursor = v; updateCursor(); });
  chk('#optQuick', () => S.quick, (v) => (S.quick = v));
  chk('#optPalm', () => S.palm !== false, (v) => (S.palm = v));
  chk('#optRotate', () => S.rotate, (v) => { S.rotate = v; if (!v) { view.r = 0; needsRender = true; } });
  chk('#optLoad', () => S.runDry, (v) => (S.runDry = v));
  $('#optPressure').value = S.pressure; $('#optPressure').oninput = (e) => { S.pressure = +e.target.value; savePrefs(); };
  $('#optSmooth').value = S.smooth; $('#optSmooth').oninput = (e) => { S.smooth = +e.target.value; savePrefs(); };
  seg('#fingerSeg', S.fingers, (v) => { S.fingers = v; savePrefs(); });
  seg('#zoomSeg', startZoom(), (v) => { S.zoomStart = v === 'width' ? 'width' : +v; savePrefs(); fit(); userMovedView = false; });
  buildAdjust();
}
$('#menuBtn').onclick = (e) => { e.stopPropagation(); togglePop('actPop'); };
$('#galItem').onclick = () => { closePops(); openGallery(); };
$('#addPageItem').onclick = () => { closePops(); insertPage(doc.page + 1); };
$('#addInfItem').onclick = () => { closePops(); insertPage(doc.page + 1, true); };
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
  if (!doc) return;
  clearTimeout(saveT);
  while (saving) await new Promise((r) => setTimeout(r, 30));
  if (dirty || NOSAVE) { sim.dryNow(); await save(true); }
}
async function save(force) {
  if (!doc || (NOSAVE && !force)) return;
  if (saving) { scheduleSave(); return; }
  if (!force && (stroke || sim.wet)) { saveT = setTimeout(save, 1200); return; } // save once it has dried
  saving = true;
  const d = doc, s = sim, key = d.pages[d.page];
  try {
    const look = { paper: d.paper, tint: d.tint, texture: d.texture, pattern: d.pattern || 0 };
    let data = null, inf = null;
    if (s.infinite) inf = await saveWorld(); // tiles that changed; the layer list and the view
    else data = await s.readAll();
    if (s !== sim || d !== doc || key !== d.pages[d.page]) return; // another painting or page was opened meanwhile
    const frames = await rec.flush();
    d.pageThumbs[key] = await makeThumb();
    const meta = { id: d.id, name: d.name, W: d.W, H: d.H, created: d.created, frames, pages: d.pages.slice(), page: d.page, pageThumbs: { ...d.pageThumbs }, thumb: d.pageThumbs[d.pages[0]] || d.pageThumbs[key], inf: d.inf || undefined };
    if (inf) { if (NOSAVE) pageCache.set(key, { v: 3, ...inf, ...look }); else await store.savePageRecord(key, meta, { ...inf, ...look }); }
    else if (NOSAVE) pageCache.set(key, data);
    else await store.savePainting(key, meta, { ...data, ...look });
    d.frames = frames;
    dirty = false; window.__saved = (window.__saved || 0) + 1;
  } catch (e) { console.warn('save failed', e); }
  finally { saving = false; }
}
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) { sim.dryNow(); save(true); } });

// ---------- infinite pages ----------
// An infinite page is a window (sheet a bit larger than the screen) over unlimited paper
// kept in 128 px tiles. When the view gets near the window's edge the window moves: tiles
// that changed and leave are read back into memory (and saved, gzipped, to IndexedDB),
// tiles that arrive are written in. Tiles near the window are decompressed ahead of time,
// so moving never waits; until they are ready the view stops at the window's edge.
const PAGE_W = 1264, IM = 128, RING = 4;
let world = null; // {key, raw: Map(local key -> {K, S} | null), comp: Map(local key -> packed), pending: Set, loading: Set}
const worlds = new Map(); // ?nosave: infinite pages kept in memory
const tkey = (uid, x, y) => `${uid}|${x},${y}`;
/** Window size for this screen: a page width and the free area's height at 100%, plus margins. */
function winSize() {
  const A = freeArea(), zb = A.w / PAGE_W, r = (v) => Math.ceil(v / 128) * 128;
  return [Math.min(2048, r(PAGE_W + 2 * IM)), Math.min(2048, r(A.h / zb + 2 * IM))];
}
/** Smallest zoom at which the view still fits inside the window's margins. */
function infMinZ() { const A = freeArea(); return Math.max(A.w / (sim.W - 2 * IM), A.h / (sim.H - 2 * IM)); }
function visibleRect() {
  const A = freeArea(), ps = [[A.left, A.top], [A.right, A.top], [A.left, A.bottom], [A.right, A.bottom]].map(([x, y]) => toSheet(x, y));
  const xs = ps.map((p) => p.x), ys = ps.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
/** Move the view so that sheet point (sx, sy) sits at screen point (cx, cy). */
function placeAt(sx, sy, cx, cy) { const q = toScreen(sx, sy); view.x += cx - q.x; view.y += cy - q.y; needsRender = true; }
function infFit(rel = startZoom()) {
  const A = freeArea(), p = toSheet(A.left, A.top), keep = p.x > 0 && p.y > 0 && p.x < sim.W && p.y < sim.H;
  view.r = 0; view.z = Math.max(infMinZ(), rel * baseZ());
  placeAt(keep ? p.x : IM, keep ? p.y : IM, A.left, A.top); worldKeep();
}
async function openInfinite(key, data) {
  const [W, H] = winSize();
  ensureSim(W, H, true);
  sim.loadAll({ layers: (data.layers || []).map((l) => ({ ...l, K: null, S: null })), active: data.active });
  world = (NOSAVE && worlds.get(key)) || { key, raw: new Map(), comp: new Map(), pending: new Set(), loading: new Set() };
  worlds.set(key, world);
  if (!NOSAVE) for (const [k, v] of await store.getTiles(key + '|')) world.comp.set(k.slice(key.length + 1), v);
  // the window around where you were looking
  const v = data.view || { wx: IM, wy: IM, zr: startZoom() };
  sim.origin = [Math.floor((v.wx - IM) / TILE) * TILE, Math.floor((v.wy - IM) / TILE) * TILE];
  await loadWindow();
  applyLook();
  const A = freeArea();
  view.r = 0; view.z = Math.max(infMinZ(), (v.zr || 1) * baseZ());
  placeAt(v.wx - sim.origin[0], v.wy - sim.origin[1], A.left, A.top);
  worldKeep(); prefetch();
}
/** Decompress and write every tile inside the window. */
async function loadWindow() {
  const tw = sim.W / TILE, th = sim.H / TILE, [ox, oy] = sim.origin.map((v) => v / TILE);
  for (const L of sim.layers) for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const k = tkey(L.uid, ox + x, oy + y);
    if (!world.raw.has(k) && world.comp.has(k)) world.raw.set(k, await store.unpackTile(world.comp.get(k)));
    const d = world.raw.get(k); if (d) sim.writeTile(L, x, y, d.K, d.S);
  }
  sim.compose();
}
/** Decompress tiles around the window (and towards where it is about to move). */
function prefetch(dx = 0, dy = 0) {
  if (!world) return;
  const w = world, tw = sim.W / TILE, th = sim.H / TILE, [ox, oy] = sim.origin.map((v) => v / TILE), sx = dx / TILE, sy = dy / TILE;
  const x0 = ox + Math.min(0, sx) - RING, x1 = ox + tw + Math.max(0, sx) + RING, y0 = oy + Math.min(0, sy) - RING, y1 = oy + th + Math.max(0, sy) + RING;
  for (const k of w.comp.keys()) {
    if (w.raw.has(k) || w.loading.has(k)) continue;
    const m = k.match(/\|(-?\d+),(-?\d+)$/), x = +m[1], y = +m[2];
    if (x < x0 || x >= x1 || y < y0 || y >= y1) continue;
    w.loading.add(k);
    store.unpackTile(w.comp.get(k)).then((d) => { if (!w.raw.has(k)) w.raw.set(k, d); }).finally(() => w.loading.delete(k));
  }
}
/** Can the window move by (dx, dy) now, i.e. is every tile it would bring in decompressed? */
function tilesReady(dx, dy) {
  const tw = sim.W / TILE, th = sim.H / TILE, nx = (sim.origin[0] + dx) / TILE, ny = (sim.origin[1] + dy) / TILE, sx = dx / TILE, sy = dy / TILE;
  for (const L of sim.layers) for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const ox = x + sx, oy = y + sy; if (ox >= 0 && oy >= 0 && ox < tw && oy < th) continue;
    const k = tkey(L.uid, nx + x, ny + y); if (!world.raw.has(k) && world.comp.has(k)) return false;
  }
  return true;
}
function keepTile(t) { // a tile read back from the window: into memory, to be saved
  const k = tkey(t.L.uid, sim.origin[0] / TILE + t.tx, sim.origin[1] / TILE + t.ty);
  world.raw.set(k, t.empty ? null : { K: t.K, S: t.S }); world.pending.add(k);
}
/** Keep the view inside the window, moving the window when the view nears its edge. */
function worldKeep() {
  if (!sim?.infinite || !world) return;
  const A = freeArea(), zmin = infMinZ();
  if (view.z < zmin - 1e-9) { const c = toSheet(A.left + A.w / 2, A.top + A.h / 2); view.z = zmin; placeAt(c.x, c.y, A.left + A.w / 2, A.top + A.h / 2); }
  let v = visibleRect();
  const W = sim.W, H = sim.H;
  if (v.x0 >= IM && v.y0 >= IM && v.x1 <= W - IM && v.y1 <= H - IM) return;
  const dx = Math.round(((v.x0 + v.x1) / 2 - W / 2) / TILE) * TILE, dy = Math.round(((v.y0 + v.y1) / 2 - H / 2) / TILE) * TILE;
  if ((dx || dy) && !stroke && !turning && tilesReady(dx, dy)) { shiftWorld(dx, dy); v = visibleRect(); }
  else if (dx || dy) prefetch(dx, dy);
  // until it can move: stop at the window's edge
  const sx = v.x0 < 0 ? -v.x0 : v.x1 > W ? W - v.x1 : 0, sy = v.y0 < 0 ? -v.y0 : v.y1 > H ? H - v.y1 : 0;
  if (sx || sy) { const a = toScreen(0, 0), b = toScreen(sx, sy); view.x -= b.x - a.x; view.y -= b.y - a.y; if (gesture?.v0) { gesture.v0.x -= b.x - a.x; gesture.v0.y -= b.y - a.y; } }
}
function shiftWorld(dx, dy) {
  if (sim.wet) sim.dryNow(); // wet paint does not travel with the window
  const [ox, oy] = sim.origin.map((v) => v / TILE);
  sim.shift(dx, dy, keepTile, (L, x, y) => world.raw.get(tkey(L.uid, ox + dx / TILE + x, oy + dy / TILE + y)) || null);
  sim.origin = [sim.origin[0] + dx, sim.origin[1] + dy];
  // the same paper stays under your fingers
  const a = toScreen(0, 0), b = toScreen(dx, dy); view.x += b.x - a.x; view.y += b.y - a.y;
  if (gesture) {
    for (const k of ['a', 'b', 's0', 's']) if (gesture[k]) gesture[k] = { x: gesture[k].x - dx, y: gesture[k].y - dy };
    if (gesture.v0) { gesture.v0.x += b.x - a.x; gesture.v0.y += b.y - a.y; }
  }
  needsRender = true; updateUndo(); prefetch(); scheduleSave();
  window.__shifts = (window.__shifts || 0) + 1;
}
/** Save an infinite page: changed tiles, then the layer list and the view. */
async function saveWorld() {
  const w = world;
  for (const t of sim.takeDirty()) keepTile(t);
  const puts = [], dels = [];
  for (const k of [...w.pending]) {
    const v = w.raw.get(k); w.pending.delete(k);
    if (NOSAVE) continue;
    if (v) { const p = await store.packTile(v.K, v.S); w.comp.set(k, p); puts.push([w.key + '|' + k, p]); }
    else { w.comp.delete(k); dels.push(w.key + '|' + k); }
  }
  if (puts.length || dels.length) await store.writeTiles(puts, dels);
  if (!NOSAVE) trimRaw();
  const A = freeArea(), p = toSheet(A.left, A.top);
  return { infinite: true, layers: sim.layers.map((L) => ({ uid: L.uid, name: L.name, visible: L.visible, opacity: L.opacity })), active: sim.layers.indexOf(sim.layer),
    view: { wx: p.x + sim.origin[0], wy: p.y + sim.origin[1], zr: view.z / baseZ() } };
}
/** Forget decompressed tiles far from the window (they are safe, compressed, in comp). */
function trimRaw() {
  const tw = sim.W / TILE, th = sim.H / TILE, [ox, oy] = sim.origin.map((v) => v / TILE), R = RING + 4;
  for (const k of world.raw.keys()) {
    if (world.pending.has(k)) continue;
    const m = k.match(/\|(-?\d+),(-?\d+)$/), x = +m[1], y = +m[2];
    if (x < ox - R || x >= ox + tw + R || y < oy - R || y >= oy + th + R) world.raw.delete(k);
  }
}
/** Clear a layer's tiles outside the window (the window itself is cleared by Sim.clearAll). */
function clearWorldLayer(L) {
  for (const k of new Set([...world.raw.keys(), ...world.comp.keys()])) if (k.startsWith(L.uid + '|')) { world.raw.set(k, null); world.pending.add(k); }
}

// ---------- pages ----------
// A painting is a notebook of one or more pages. One page is in the simulation at a time;
// turning saves it (dried) and loads the next. Undo history is per visit to a page.
let turning = false, wantPage = null;
const pageCache = new Map(); // ?nosave: pages kept in memory instead of IndexedDB
async function loadPage(n, fresh) {
  const key = doc.pages[n];
  const data = fresh || pageCache.get(key) || (NOSAVE ? null : await store.loadPainting(key));
  const wasInf = !!sim?.infinite;
  doc.page = n;
  if (isInf(data)) await openInfinite(key, data);
  else {
    world = null; ensureSim(doc.W, doc.H, false); sim.loadAll(data || { layers: [] }); applyLook();
    if (wasInf) fit(); else placeTop();
  }
  updatePages(); updateUndo(); buildLayers(); markWet(true); thumbsDirty = true; needsRender = true;
}
/** Turn to page n (0-based). Past the last page: a new blank page, if `add`. */
async function gotoPage(n, add = true) {
  if (!doc) return;
  // taps while a page is turning: go where the last one points once it has
  if (turning) { wantPage = [n - doc.page, add]; return; }
  if (n < 0 || n === doc.page) return;
  if (n >= doc.pages.length) { if (add) await insertPage(doc.pages.length); return; }
  turning = true;
  try {
    if (stroke) endStroke();
    await flushSave();
    await loadPage(n);
    dirty = true; save(true); // the new page index; flushSave on the next turn waits for it
    if (window.__ready) toast(`Page ${n + 1} of ${doc.pages.length}`, 700);
  } finally { turning = false; afterTurn(); }
}
function afterTurn() { if (wantPage) { const [d, add] = wantPage; wantPage = null; gotoPage(doc.page + d, add); } }
async function insertPage(at, infinite = false) {
  if (turning || !doc) return;
  turning = true;
  try {
    if (stroke) endStroke();
    await flushSave();
    doc.pages.splice(at, 0, store.newPageKey(doc.id));
    await loadPage(at, infinite ? { v: 3, infinite: true, layers: [] } : { layers: [] });
    dirty = true; save(true);
    if (window.__ready) toast(`New page ${at + 1} of ${doc.pages.length}`, 900);
  } finally { turning = false; afterTurn(); }
}
async function deletePage(n) {
  if (turning || !doc) return;
  if (doc.pages.length < 2) { toast('A notebook keeps at least one page: clear it in Layers instead'); return; }
  if (!confirm(`Delete page ${n + 1}? This cannot be undone.`)) return;
  turning = true;
  try {
    if (stroke) endStroke();
    clearTimeout(saveT); while (saving) await new Promise((r) => setTimeout(r, 30));
    if (n !== doc.page && dirty) await save(true);
    const [key] = doc.pages.splice(n, 1); delete doc.pageThumbs[key]; pageCache.delete(key);
    if (!NOSAVE) { await store.del('layers', key); await store.delTiles(key + '|'); }
    worlds.delete(key);
    if (n === doc.page) { dirty = false; await loadPage(Math.min(n, doc.pages.length - 1)); }
    else if (n < doc.page) { doc.page--; updatePages(); }
    dirty = true; save(true);
  } finally { turning = false; afterTurn(); }
}
function movePage(n, to) {
  if (turning || to < 0 || to >= doc.pages.length) return;
  const [k] = doc.pages.splice(n, 1); doc.pages.splice(to, 0, k);
  if (doc.page === n) doc.page = to; else if (n < doc.page && to >= doc.page) doc.page--; else if (n > doc.page && to <= doc.page) doc.page++;
  updatePages(); scheduleSave(); dirty = true;
}
function updatePages() {
  if (!doc) return;
  const n = doc.pages.length, i = doc.page;
  document.body.classList.toggle('single-page', n < 2);
  $('#pgNum').textContent = `${i + 1} / ${n}`;
  $('#pgPrev').disabled = i === 0; $('#pgNext').disabled = i === n - 1;
  if (sim?.infinite) $('#pgNum').textContent += ' ∞';
  if ($('#pagePop').classList.contains('open')) buildPages();
}
function buildPages() {
  const g = $('#pageGrid'); g.innerHTML = '';
  const pr = rectOf('#pages'), pop = $('#pagePop');
  pop.style.top = (pr ? pr.bottom : box.y + 60) + 6 + 'px';
  $('#pgCount').textContent = `${doc.page + 1} of ${doc.pages.length}`;
  const ar = `${sim.W} / ${sim.H}`;
  doc.pages.forEach((key, i) => {
    const b = document.createElement('button'); b.className = 'pg' + (i === doc.page ? ' on' : ''); b.dataset.page = i;
    b.innerHTML = `<span class="pth" style="aspect-ratio:${ar}"></span><span>${i + 1}</span>`;
    const th = b.querySelector('.pth');
    if (i === doc.page) {
      // the open page, as it is now
      const sc = Math.min(1, 360 / sim.W), w = Math.round(sim.W * sc), h = Math.round(sim.H * sc), c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(sim.exportPixels({ scale: sc }).buffer), w, h), 0, 0); th.appendChild(c);
    } else if (doc.pageThumbs[key]) { const im = document.createElement('img'); im.src = URL.createObjectURL(doc.pageThumbs[key]); im.onload = () => URL.revokeObjectURL(im.src); th.appendChild(im); }
    b.onclick = () => { if (i !== doc.page) { closePops(); gotoPage(i); } };
    g.appendChild(b);
  });
  $('#pgEarlier').disabled = doc.page === 0; $('#pgLater').disabled = doc.page === doc.pages.length - 1;
}
$('#pgPrev').onclick = (e) => { e.stopPropagation(); gotoPage(doc.page - 1); };
$('#pgNext').onclick = (e) => { e.stopPropagation(); gotoPage(doc.page + 1, false); };
$('#pgNew').onclick = (e) => { e.stopPropagation(); insertPage(doc.page + 1, !!sim.infinite); };
$('#pgNum').onclick = (e) => { e.stopPropagation(); togglePop('pagePop'); };
$('#pgAdd').onclick = () => { closePops(); insertPage(doc.page + 1, !!sim.infinite); };
$('#pgEarlier').onclick = () => { movePage(doc.page, doc.page - 1); };
$('#pgLater').onclick = () => { movePage(doc.page, doc.page + 1); };
$('#pgDelete').onclick = () => { closePops(); deletePage(doc.page); };

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
    const np = store.pagesOf(m).length;
    card.innerHTML = `<button class="th">${url ? `<img src="${url}" alt="">` : ''}</button><div class="meta"><div><b></b><small>${np > 1 ? np + ' pages · ' : ''}${m.inf ? '∞' : m.W + ' × ' + m.H} · ${new Date(m.updated).toLocaleDateString()}</small></div><button class="more">⋯</button></div>`;
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
  m.style.maxHeight = innerHeight - 16 + 'px';
  m.style.left = Math.max(4, Math.min(innerWidth - m.offsetWidth - 4, r.left)) + 'px'; m.style.top = Math.max(8, Math.min(innerHeight - m.offsetHeight - 8, r.bottom + 4)) + 'px';
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
  const meta = await store.get('meta', id);
  if (!meta) { toast('Could not open that painting'); return; }
  const pages = store.pagesOf(meta);
  let page = Math.min(Math.max(0, meta.page || 0), pages.length - 1), data = await store.loadPainting(pages[page]);
  if (!data && page) { page = 0; data = await store.loadPainting(pages[0]); }
  if (!data) { toast('Could not open that painting'); return; }
  await openDoc({ id, name: meta.name, W: data.W || 1264, H: data.H || 1680, paper: data.paper || 'cold', tint: data.tint || 'white', texture: !!data.texture, pattern: data.pattern || 0, created: meta.created, frames: meta.frames || 0, inf: meta.inf, pages: pages.slice(), page, pageThumbs: { ...(meta.pageThumbs || {}) } }, data);
  $('#gallery').classList.remove('open');
}
async function createPainting(W, H, name, pattern = 0, infinite = false) {
  await flushSave();
  const d = newDoc(W, H, name, pattern); if (infinite) d.inf = true;
  await openDoc(d, infinite ? { v: 3, infinite: true, layers: [] } : null);
  $('#gallery').classList.remove('open');
  dirty = true; save(true);
  return d;
}
$('#galBtn').onclick = (e) => { e.stopPropagation(); openGallery(); };
$('#galBack').onclick = () => { if (doc) $('#gallery').classList.remove('open'); };
$('#newBtn').onclick = (e) => menu(e, [
  ['Notebook, lined', async () => { await createPainting(1264, 1680, 'Notes', 1); setMode('pen'); }],
  ['Notebook, grid', async () => { await createPainting(1264, 1680, 'Notes', 2); setMode('pen'); }],
  ['Notebook, dotted', async () => { await createPainting(1264, 1680, 'Notes', 3); setMode('pen'); }],
  ['Infinite page, lined', async () => { await createPainting(1264, 1680, 'Infinite notes', 1, true); setMode('pen'); }],
  ['Infinite canvas', async () => { await createPainting(1264, 1680, 'Infinite canvas', 0, true); }],
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
    if (sim.infinite && !stroke && world) worldKeep();
    sim.params.grav = gravity();
    sim.dryBoost = dryHold ? 3 : 0;
    const stepped = sim.step(dt);
    if (stepped) { needsRender = true; paintTick++; }
    // e-paper: a drying wash is redrawn a few times a second, not every frame (fewer flashes)
    if (needsRender && (!S.eink || stroke || !sim.wet || t - lastRender > 150)) { render(); needsRender = false; lastRender = t; updateZoomLabel(); }
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
  await openDoc(newDoc(w, h), null);
  if (!NOSAVE) { dirty = true; save(true); }
  if (!S.helpSeen && !qs.has('nohelp')) { showHelp(); S.helpSeen = true; savePrefs(); }
}
requestAnimationFrame(frame);
if ('serviceWorker' in navigator && !qs.has('nosw') && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});

// test / debugging hook
window.__aq = {
  box, get dpr() { return dpr; }, setFullscreen, get sim() { return sim; }, get doc() { return doc; }, view, S, get stroke() { return stroke; }, fit, setTool, selectBrush, choosePigment, useCustom, render,
  redraw: () => { needsRender = true; }, get world() { return world; }, worldKeep, infMinZ, visibleRect, placeAt, freeAreaRect: () => freeArea(), baseZ, zoomBy, zoomToggle, freeArea, gotoPage, insertPage, deletePage, movePage, get pageCache() { return pageCache; }, useBrush, setMode, setNib, setPenColour, exportImage, save, toSheet, toScreen, openGallery, openById, createPainting, rec, togglePop, dupLayer,
  get penSeen() { return penSeen; }, setUiHidden, togglePop, closePops, setFolded, resetPanels, layoutPanels,
};
window.__ready = true;

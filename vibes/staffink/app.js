// StaffInk UI: pointer capture, ink grouping, recognition feedback, editing, playback.
import { loadModel, bbox, pathLength, straightness, reversals, makeUserTemplate, packStrokes, unpackStrokes, CLASSES } from './recognizer.js';
import { newScore, newMeasure, ensureTrailingMeasure, findEvent, describe, tupletWindows, clearTuplet, hasArtic, setArtic, DIV } from './theory.js';
import { buildExtraTemplates } from './extras.js';
import { layoutScore, locate } from './layout.js';
import { renderScore } from './render.js';
import { interpret, detectGesture, removeEvent, isScribble, makeTuplet, articShapes, eraseHits, applyErase } from './parser.js';
import { Player } from './audio.js';
import { toMusicXML, toMidi, performance as performanceOf } from './export.js';
import { timeMap, headsAt, drawPlayheads, HEAD_COLORS } from '../notation-ir/playheads.js';
import { timeline, rangeOf, stepFocus, addClip, addJump, removeMarker, markerById, moveClip, pruneProgram, compile, markers as programMarkers, hasMarkers, emptyProgram } from './arrange.js';
import { renderClipOrder } from '../notation-ir/cliporder.js';
import { layoutMarkers, drawMarkers, hitMarker } from '../notation-ir/markers.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), cScore = $('score');
const gS = cScore.getContext('2d');
const params = new URLSearchParams(location.search);
// Ink canvas: low-latency (desynchronized) or standard, switchable in settings for A/B
// comparison. Auto = low latency except on Android, where Chrome puts a desynchronized
// canvas on its own overlay plane and its transparent pixels composite as black over
// the score. ?lowlatency=1 / =0 overrides the setting. A context's options are fixed
// when it is created, so switching swaps in a fresh canvas element.
let cInk = $('ink'), gI = null;
const IS_ANDROID = /Android/i.test(navigator.userAgent);
function inkLowWanted() {
  const q = params.get('lowlatency');
  if (q === '1' || q === '0') return q === '1';
  const m = S.settings.ink;
  return m === 'low' ? true : m === 'standard' ? false : !IS_ANDROID;
}
function setupInk() {
  const want = inkLowWanted();
  if (gI && S.ink.wanted === want) return false;
  if (gI) { const c = cInk.cloneNode(false); cInk.replaceWith(c); cInk = c; }
  gI = (want && cInk.getContext('2d', { desynchronized: true })) || cInk.getContext('2d');
  const attrs = (gI.getContextAttributes && gI.getContextAttributes()) || {};
  // what the browser actually gave us: unsupported browsers silently ignore the option
  S.ink = { wanted: want, active: !!attrs.desynchronized };
  return true;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota or private mode */ } };

const S = {
  score: (!params.has('fresh') && validScore(load('staffink.score'))) || newScore(),
  settings: { zoom: 1, delay: 700, finger: 'auto', font: 'Bravura', showInk: false, ink: 'auto', ...(load('staffink.settings') || {}) },
  ink: { wanted: null, active: false },
  user: [], tool: 'write', penSeen: false, scrollY: 0, scale: 12, L: null, w: 0, h: 0,
  undo: [], redo: [], group: [], groupTimer: 0, ptrs: new Map(), fading: [], pending: [],
  selected: null, playing: new Set(), model: null, lastEdit: null, inkHistory: [], player: new Player(),
  range: null, // text-editor-like selection: { a, b } event ids (anchor, focus)
  marker: null, pickJump: null, loopSel: false, ML: null,
  heads: [], // playhead lines while playing: [{ line (system), x, color }]
};
for (const u of load('staffink.user') || []) { try { S.user.push(makeUserTemplate(u.label, unpackStrokes(u.strokes))); } catch (e) { /* skip bad entry */ } }
if (params.get('delay')) S.settings.delay = +params.get('delay');

setupInk();

function validScore(s) { return s && s.version === 1 && Array.isArray(s.measures) && Array.isArray(s.staves) && s.measures.length ? s : null; }

// ---------------------------------------------------------------- model
const modelReady = Promise.all([
  fetch('model.json').then((r) => r.json()).then((j) => { S.model = loadModel(j); }),
  fetch('digits.json').then((r) => r.json()).catch(() => null).then((d) => { S.extras = buildExtraTemplates(d); }),
]).catch((e) => toast('Could not load the recogniser: ' + e.message, 6000));

// ---------------------------------------------------------------- layout & drawing
function resize() {
  const dpr = window.devicePixelRatio || 1;
  S.w = stage.clientWidth; S.h = stage.clientHeight;
  for (const c of [cScore, cInk]) { c.width = Math.round(S.w * dpr); c.height = Math.round(S.h * dpr); c.style.width = S.w + 'px'; c.style.height = S.h + 'px'; }
  gS.setTransform(dpr, 0, 0, dpr, 0, 0); gI.setTransform(dpr, 0, 0, dpr, 0, 0);
  S.scale = clamp(Math.min(S.w, S.h * 1.4) / 44, 10, 17) * S.settings.zoom;
  relayout();
}

function relayout() {
  ensureTrailingMeasure(S.score);
  S.L = layoutScore(S.score, { width: S.w / S.scale, font: S.settings.font });
  S.scrollY = clamp(S.scrollY, 0, maxScroll());
  const gone = pruneProgram(S.score);
  if (gone.length) toast(`marker${gone.length > 1 ? 's' : ''} ${gone.join(', ')} removed: ${gone.length > 1 ? 'their' : 'its'} note was erased`, 2400);
  if (S.marker && !markerById(S.score, S.marker)) { S.marker = null; hideMarkBar(); }
  if (S.range && !(findEvent(S.score, S.range.a) && findEvent(S.score, S.range.b))) { S.range = null; hideRangeBar(); }
  layoutProgram();
  drawScore(); drawInk(); progBar();
}

// ---------------------------------------------------------------- markers & range geometry
const sysLines = () => S.L.systems.map((sys) => ({ x0: sys.x0, x1: sys.x1, top: sys.staffTops[0], bottom: sys.staffTops[sys.staffTops.length - 1] + 4 }));
function placeAnchor(a, edge) {
  const id = a.event && Number(String(a.event).replace(/^si/, ''));
  const p = id && S.L.evPos.get(id);
  if (!p) return null;
  return { line: p.sys, x: edge === 'end' || a.edge === 'end' ? p.bbox.x1 + 0.35 : p.bbox.x0 - 0.25 };
}
function layoutProgram() { S.ML = hasMarkers(S.score.program) ? layoutMarkers(programMarkers(S.score), { lines: sysLines(), place: placeAnchor }) : null; }
const markerView = () => ({ X: (x) => x * S.scale, Y: (y) => (y - S.scrollY) * S.scale, sp: S.scale });
/** Bands of the range selection, one per system: { sys, x0, x1, y0, y1 } in page units. */
function rangeBands() {
  const r = S.range && rangeOf(S.score, S.range.a, S.range.b); if (!r) return [];
  const by = new Map();
  for (const id of r.ids) {
    const p = S.L.evPos.get(id); if (!p) continue;
    const b = by.get(p.sys) || { sys: p.sys, x0: Infinity, x1: -Infinity };
    b.x0 = Math.min(b.x0, p.bbox.x0 - 0.35); b.x1 = Math.max(b.x1, p.bbox.x1 + 0.35); by.set(p.sys, b);
  }
  return [...by.values()].map((b) => { const sys = S.L.systems[b.sys]; return { ...b, y0: sys.staffTops[0] - 1.2, y1: sys.staffTops[sys.staffTops.length - 1] + 5.2 }; });
}
/** The event nearest a page point, for range selection: by system, then x. */
function nearestEvent(p) {
  let sys = null, sd = Infinity;
  for (const s of S.L.systems) { const t = s.staffTops[0] - 3, b = s.staffTops[s.staffTops.length - 1] + 7; const d = p.y < t ? t - p.y : p.y > b ? p.y - b : 0; if (d < sd) { sd = d; sys = s; } }
  if (!sys) return null;
  let best = null, bd = Infinity;
  for (const [id, e] of S.L.evPos) {
    if (e.sys !== sys.index) continue;
    const cx = (e.bbox.x0 + e.bbox.x1) / 2, d = Math.abs(cx - p.x) + 0.05 * Math.abs(e.top + 2 - p.y);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}
const maxScroll = () => Math.max(0, S.L.height + 6 - S.h / S.scale);

let scoreQueued = false;
function drawScore() {
  if (scoreQueued) return; scoreQueued = true;
  requestAnimationFrame(() => {
    scoreQueued = false;
    renderScore(gS, S.L, { scale: S.scale, scrollY: S.scrollY, width: S.w, height: S.h, title: S.score.title }, { selected: new Set(S.selected ? [S.selected.id] : []), playing: S.playing });
    for (const b of rangeBands()) {
      const x = b.x0 * S.scale, y = (b.y0 - S.scrollY) * S.scale, w = (b.x1 - b.x0) * S.scale, h = (b.y1 - b.y0) * S.scale;
      gS.fillStyle = 'rgba(37,99,235,0.13)'; gS.fillRect(x, y, w, h);
      gS.fillStyle = 'rgba(37,99,235,0.85)'; gS.fillRect(x - 1, y, 2, h); gS.fillRect(x + w - 1, y, 2, h);
    }
    if (S.ML) drawMarkers(gS, S.ML, markerView(), { selected: S.marker });
    if (S.heads.length) drawPlayheads(gS, S.heads, sysLines(), markerView());
    if (S.settings.showInk) for (const st of S.inkHistory) drawStroke(gS, st, 'rgba(37,99,235,0.35)');
    for (const a of S.pending) for (const st of a.strokes) drawStroke(gS, st, 'rgba(29,28,26,0.45)');
  });
}

let inkQueued = false;
function drawInk() {
  if (inkQueued) return; inkQueued = true;
  requestAnimationFrame(() => {
    inkQueued = false;
    gI.clearRect(0, 0, S.w, S.h);
    const now = performance.now();
    S.fading = S.fading.filter((f) => now - f.t0 < 450);
    for (const f of S.fading) for (const st of f.strokes) drawStroke(gI, st, `rgba(29,28,26,${0.7 * (1 - (now - f.t0) / 450)})`);
    for (const st of S.group) drawStroke(gI, st.pts, '#1d1c1a', st.type);
    for (const [, p] of S.ptrs) if (p.role === 'ink') drawStroke(gI, p.pts.concat(p.pred || []), '#1d1c1a', p.type);
    for (const [, p] of S.ptrs) if (p.role === 'erase' && p.pts.length) drawStroke(gI, p.pts, 'rgba(214,52,52,0.45)', 'wide');
    if (S.fading.length) drawInk();
  });
}

function drawStroke(g, pts, color, type) {
  if (!pts.length) return;
  const sc = S.scale, oy = S.scrollY;
  g.strokeStyle = color; g.fillStyle = color; g.lineCap = 'round'; g.lineJoin = 'round';
  const base = type === 'wide' ? 0.9 * sc : 0.13 * sc;
  if (pts.length === 1) { g.beginPath(); g.arc(pts[0].x * sc, (pts[0].y - oy) * sc, base * 0.6, 0, 7); g.fill(); return; }
  if (type !== 'pen') {
    // one path: translucent ink must not double up where segments overlap
    g.lineWidth = base; g.beginPath(); g.moveTo(pts[0].x * sc, (pts[0].y - oy) * sc);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x * sc, (pts[i].y - oy) * sc);
    g.stroke(); return;
  }
  // pressure-varying width: one path per run of similar width
  const w = (p) => base * (0.45 + 1.1 * (p.p === undefined ? 0.5 : p.p));
  let i = 1;
  while (i < pts.length) {
    const lw = Math.round(w(pts[i]) * 4) / 4;
    g.lineWidth = lw; g.beginPath(); g.moveTo(pts[i - 1].x * sc, (pts[i - 1].y - oy) * sc);
    while (i < pts.length && Math.round(w(pts[i]) * 4) / 4 === lw) { g.lineTo(pts[i].x * sc, (pts[i].y - oy) * sc); i++; }
    g.stroke();
  }
}

// ---------------------------------------------------------------- history & persistence
let saveTimer = 0;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { store('staffink.score', S.score); store('staffink.settings', S.settings); }, 300); }
function saveUser() { store('staffink.user', S.user.map((u) => ({ label: u.label, strokes: u.strokes }))); }
function pushHistory(before) { S.undo.push(before); if (S.undo.length > 200) S.undo.shift(); S.redo = []; updateButtons(); }
function undo() {
  commitGroup();
  if (!S.undo.length) return;
  S.redo.push(JSON.stringify(S.score)); S.score = JSON.parse(S.undo.pop()); afterHistory('undone');
}
function redo() {
  if (!S.redo.length) return;
  S.undo.push(JSON.stringify(S.score)); S.score = JSON.parse(S.redo.pop()); afterHistory('redone');
}
function afterHistory(what) { S.selected = null; S.lastEdit = null; hideAlts(); hideSel(); $('title').value = S.score.title; relayout(); save(); updateButtons(); toast(what, 900); }
function updateButtons() { $('undo').disabled = !S.undo.length; $('redo').disabled = !S.redo.length; }

// ---------------------------------------------------------------- feedback UI
let toastTimer = 0;
function toast(html, ms = 2400) { const el = $('status'); el.innerHTML = html; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms); }

const GLYPH = {
  'Whole-Note': '\uE1D2', 'Half-Note': '\uE1D3', 'Quarter-Note': '\uE1D5', 'Eighth-Note': '\uE1D7', 'Sixteenth-Note': '\uE1D9', 'Thirty-Two-Note': '\uE1DB', 'Sixty-Four-Note': '\uE1DD',
  'Whole-Half-Rest': '\uE4E3', 'Quarter-Rest': '\uE4E5', 'Eighth-Rest': '\uE4E6', 'Sixteenth-Rest': '\uE4E7', 'Thirty-Two-Rest': '\uE4E8', 'Sixty-Four-Rest': '\uE4E9',
  Sharp: '\uE262', Flat: '\uE260', Natural: '\uE261', 'Double-Sharp': '\uE263', 'G-Clef': '\uE050', 'F-Clef': '\uE062', 'C-Clef': '\uE05C', 'Common-Time': '\uE08A', 'Cut-Time': '\uE08B', Dot: '\uE1E7',
  'Art-staccato': '\uE4A2', 'Art-staccatissimo': '\uE4A6', 'Art-tenuto': '\uE4A4', 'Art-accent': '\uE4A0', 'Art-marcato': '\uE4AC', 'Art-fermata': '\uE4C0',
};
const NICE = { 'Whole-Half-Rest': 'whole/half rest', 'Thirty-Two-Note': '32nd note', 'Sixty-Four-Note': '64th note', 'Thirty-Two-Rest': '32nd rest', 'Sixty-Four-Rest': '64th rest', 'G-Clef': 'treble clef', 'F-Clef': 'bass clef', 'C-Clef': 'alto clef' };
const nice = (l) => NICE[l] || (l.startsWith('Dyn-') || l.startsWith('Art-') ? l.slice(4) : l === 'Tuplet-3' ? 'triplet 3' : l === 'Tuplet-6' ? 'sextuplet 6' : null) || (/^\d+-\d+-Time$/.test(l) ? l.replace(/^(\d+)-(\d+)-Time$/, '$1/$2 time') : l.replace(/-/g, ' ').toLowerCase());
const DYN_CH = { p: '\uE520', m: '\uE521', f: '\uE522', r: '\uE523', s: '\uE524', z: '\uE525' };
function glyphHtml(l) {
  if (l.startsWith('Dyn-')) return `<span class="mus" style="font-size:22px;top:3px">${[...l.slice(4)].map((c) => DYN_CH[c]).join('')}</span>`;
  if (l.startsWith('Tuplet-')) return `<span class="mus" style="font-size:22px;top:3px">${String.fromCodePoint(0xE880 + +l.slice(7))}</span>`;
  if (GLYPH[l]) { const small = /Clef/.test(l) ? ' style="font-size:15px;top:2px"' : l.startsWith('Art-') ? ' style="top:8px"' : ''; return `<span class="mus"${small}>${GLYPH[l]}</span>`; }
  const m = l.match(/^(\d+)-(\d+)-Time$/); if (m) return `<b>${m[1]}/${m[2]}</b>`;
  return '<b>|</b>';
}

let altTimer = 0;
function showAlts(edit, strokes) {
  const box = $('alts');
  // always offer the runners-up: a confidently wrong guess still needs a way out
  const alts = (edit.alts || []).slice(0, 5);
  if (!alts.length) { hideAlts(); return; }
  const shown = alts.some((a) => a.label === edit.label) ? alts : [{ label: edit.label, p: 1 }, ...alts.slice(0, 4)];
  const pct = (p) => (p < 0.01 ? '<1%' : Math.round(p * 100) + '%');
  box.innerHTML = shown.map((a) => `<button data-l="${a.label}" class="${a.label === edit.label ? 'on' : ''}" title="${nice(a.label)}">${glyphHtml(a.label)}<small>${a.label === edit.label ? '✓' : pct(a.p)}</small></button>`).join('') + '<div class="hint">Not what you wrote? Tap the right one, it learns your hand.</div>';
  box.classList.add('show');
  clearTimeout(altTimer); altTimer = setTimeout(hideAlts, 5000);
}
function hideAlts() { $('alts').classList.remove('show'); }
$('alts').addEventListener('pointerdown', (e) => e.stopPropagation());
$('alts').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-l]'); if (!btn || !S.lastEdit) return;
  const label = btn.dataset.l, le = S.lastEdit;
  if (label === le.edit.label) { hideAlts(); return; }
  S.score = JSON.parse(le.before);
  S.pending = S.pending.filter((p) => p.strokes !== le.strokes);
  if (le.pushed) S.undo.pop();
  relayout();
  const e2 = interpret(le.strokes, ctx(), label);
  if (e2) applyEdit(e2, le.strokes, { noAlts: true });
  S.user = S.user.filter((u, i, a) => a.filter((v) => v.label === u.label).indexOf(u) >= a.filter((v) => v.label === u.label).length - 11);
  S.user.push(makeUserTemplate(label, le.strokes));
  if (S.user.length > 300) S.user.splice(0, S.user.length - 300);
  saveUser();
  toast(`Learned: that was a <b>${nice(label)}</b>`);
  hideAlts();
});

// ---------------------------------------------------------------- recognition flow
const ctx = (score = S.score, L = S.L, pending = S.pending) => ({ score, L, model: S.model, user: S.user, pending, extras: S.extras });

function groupBox() { return bbox(S.group.map((s) => s.pts)); }

function gestureShape(pts) {
  if (pts.length < 3) return null;
  const b = bbox([pts]), a = pts[0], z = pts[pts.length - 1];
  const chord = Math.hypot(z.x - a.x, z.y - a.y), st = straightness(pts);
  if (isScribble(pts)) return 'scribble';
  if (st > 0.92 && chord >= 1.4 && Math.abs(z.y - a.y) < 0.8 * Math.abs(z.x - a.x)) return 'line';
  if (b.w >= 0.9 && b.h <= 0.55 * b.w + 0.2 && reversals(pts, 0.3, 'x') === 0 && st > 0.5 && st < 0.995) return 'arc';
  return null;
}

async function handleStroke(stroke) {
  await modelReady;
  const pts = stroke.pts, sb = bbox([pts]);
  const shape = gestureShape(pts);
  if (S.group.length) {
    const gb = groupBox();
    // scribbling over ink that has not been recognised yet cancels it
    if (shape === 'scribble' && sb.x0 < gb.x1 && sb.x1 > gb.x0 && sb.y0 < gb.y1 && sb.y1 > gb.y0) {
      S.fading.push({ strokes: [...S.group.map((s) => s.pts), pts], t0: performance.now() }); S.group = []; clearTimeout(S.groupTimer); drawInk(); toast('ink cancelled', 1200); return;
    }
    if (shape) {
      // would this stroke be a gesture once the pending symbol is on the page?
      const trial = JSON.parse(JSON.stringify(S.score));
      const pend = S.pending.slice();
      const e = interpret(S.group.map((s) => s.pts), ctx(trial, S.L, pend));
      if (e) e.apply(trial);
      const L2 = layoutScore(trial, { width: S.w / S.scale, font: S.settings.font });
      const loc = locate(L2, sb.cx, sb.cy);
      if (loc && detectGesture([pts], { score: trial, L: L2 }, loc)) { commitGroup(); runGroup([pts]); return; }
    }
    const far = sb.x0 > gb.x1 + 2.0 || sb.x1 < gb.x0 - 2.0 || sb.y0 > gb.y1 + 5 || sb.y1 < gb.y0 - 5;
    // a small mark just above or below the symbol being written is its articulation:
    // finish the symbol first so the mark has a note to attach to. A short flat line
    // outside the staff is left alone, it is far more often a ledger line.
    const loc = locate(S.L, sb.cx, sb.cy);
    const outside = loc && (sb.y1 < loc.top - 0.3 || sb.y0 > loc.top + 4.3);
    const art = articShapes([pts]).filter((a) => !(a.label === 'Art-tenuto' && outside));
    const offSide = sb.y1 < gb.y0 - 0.1 || sb.y0 > gb.y1 + 0.1;
    if (far || (art.length && offSide && sb.cx > gb.x0 - 1 && sb.cx < gb.x1 + 1)) commitGroup();
  } else if (shape) {
    const loc = locate(S.L, sb.cx, sb.cy);
    if (loc && detectGesture([pts], ctx(), loc)) { runGroup([pts]); return; }
  }
  S.group.push(stroke);
  clearTimeout(S.groupTimer);
  S.groupTimer = setTimeout(commitGroup, S.settings.delay);
  drawInk();
}

function commitGroup() {
  clearTimeout(S.groupTimer);
  if (!S.group.length) return;
  const strokes = S.group.map((s) => s.pts);
  S.group = [];
  if (!S.model) { S.group = strokes.map((pts) => ({ pts })); S.groupTimer = setTimeout(commitGroup, 200); return; }
  runGroup(strokes);
}

function runGroup(strokes) {
  S.fading.push({ strokes, t0: performance.now() }); drawInk();
  const edit = interpret(strokes, ctx());
  if (!edit) { toast('?', 900); return; }
  applyEdit(edit, strokes);
}

function applyEdit(edit, strokes, opt = {}) {
  const before = JSON.stringify(S.score);
  const r = edit.apply(S.score) || { ids: [] };
  const changed = JSON.stringify(S.score) !== before;
  if (changed) pushHistory(before);
  if (r.pending) S.pending.push(r.pending);
  S.lastEdit = { before, strokes, edit, pushed: changed };
  S.log = (S.log || []).slice(-40).concat([{ label: edit.label, kind: edit.kind, n: strokes.length, desc: edit.desc || '' }]);
  S.inkHistory.push(...strokes); if (S.inkHistory.length > 400) S.inkHistory.splice(0, S.inkHistory.length - 400);
  relayout(); save();
  const conf = edit.alts && edit.alts.length ? edit.alts.find((a) => a.label === edit.label) : null;
  let msg = edit.desc || nice(edit.label);
  if (r.ids && r.ids.length && (edit.kind === 'note' || edit.kind === 'rest' || edit.kind === 'chord' || edit.kind === 'acc')) {
    const f = findEvent(S.score, r.ids[0]);
    if (f) msg = describe(f.ev, S.L.spelled.get(f.ev));
    if (f && f.ev.kind === 'note' && edit.kind !== 'acc') S.player.preview((S.L.spelled.get(f.ev) || []).map((h) => h.midi));
  }
  toast(`<b>${msg}</b>${conf ? ` · ${Math.round(conf.p * 100)}%${conf.source === 'user' ? ' (your handwriting)' : ''}` : ''}`);
  if (!opt.noAlts && edit.alts && edit.alts.length) showAlts(edit, strokes); else hideAlts();
  // pending accidentals expire
  const now = Date.now(); S.pending = S.pending.filter((p) => now - p.t < 15000);
}

// ---------------------------------------------------------------- hit testing & selection
function hitTest(p) {
  let best = null;
  for (const [id, e] of S.L.evPos) {
    if (e.kind === 'rest') {
      const b = e.bbox;
      if (p.x > b.x0 - 0.3 && p.x < b.x1 + 0.3 && p.y > b.y0 - 0.3 && p.y < b.y1 + 0.3) { const d = Math.hypot(p.x - (b.x0 + b.x1) / 2, p.y - (b.y0 + b.y1) / 2); if (!best || d < best.d) best = { id, d }; }
      continue;
    }
    for (const h of e.heads) {
      const dx = p.x - (h.x + e.hw / 2), dy = p.y - h.y;
      if (Math.abs(dx) < e.hw / 2 + 0.35 && Math.abs(dy) < 0.7) { const d = Math.hypot(dx, dy); if (!best || d < best.d) best = { id, d, pos: h.pos }; }
    }
  }
  return best;
}

function select(hit) {
  if (!hit) { S.selected = null; hideSel(); drawScore(); return; }
  S.selected = { id: hit.id, pos: hit.pos };
  const f = findEvent(S.score, hit.id);
  if (f && f.ev.kind === 'note') S.player.preview((S.L.spelled.get(f.ev) || []).map((h) => h.midi));
  if (f) toast(`<b>${describe(f.ev, S.L.spelled.get(f.ev))}</b>`, 1500);
  showSel(); drawScore();
}

const ARTIC_BTN = [['stacc', '\uE4A2', 'staccato'], ['staccatissimo', '\uE4A6', 'staccatissimo'], ['tenuto', '\uE4A4', 'tenuto'], ['accent', '\uE4A0', 'accent'], ['marcato', '\uE4AC', 'marcato'], ['fermata', '\uE4C0', 'fermata']];
const DUR_BTN = [[1, '\uE1D2'], [2, '\uE1D3'], [4, '\uE1D5'], [8, '\uE1D7'], [16, '\uE1D9']];
function showSel() {
  const box = $('selbar');
  const f = S.selected && findEvent(S.score, S.selected.id);
  if (!f) { hideSel(); return; }
  const ev = f.ev, isNote = ev.kind === 'note';
  const slurred = (S.score.slurs || []).some((x) => x.from === ev.id || x.to === ev.id);
  const head = isNote ? ev.heads.find((h) => h.pos === S.selected.pos) || ev.heads[0] : null;
  const accBtn = (v, g) => `<button data-a="acc" data-v="${v}" class="${head && head.acc === v ? 'on' : ''}"><span class="mus">${g}</span></button>`;
  box.innerHTML = DUR_BTN.map(([d, g]) => `<button data-a="dur" data-v="${d}" class="${ev.dur === d && !ev.full ? 'on' : ''}" title="duration"><span class="mus">${g}</span></button>`).join('')
    + `<button data-a="dot" class="${ev.dots ? 'on' : ''}" title="dot"><span class="mus">\uE1E7</span>${ev.dots > 1 ? '2' : ''}</button>`
    + (isNote ? accBtn(1, '\uE262') + accBtn(-1, '\uE260') + accBtn(0, '\uE261') + `<button data-a="tie" class="${ev.tie ? 'on' : ''}" title="tie to next">⌒</button>` + (slurred ? '<button data-a="flip" title="flip slur">⌒↕</button>' : '') : '')
    + `<button data-a="tup" class="${ev.tuplet ? 'on' : ''}" title="triplet from here"><span class="mus" style="font-size:20px;top:2px">\uE883</span></button>`
    + `<button data-a="rest" title="${isNote ? 'make rest' : 'make note'}">${isNote ? '<span class="mus">\uE4E5</span>' : '<span class="mus">\uE0A4</span>'}</button><button data-a="del" title="delete">✕</button>`
    + '<div class="hint" style="width:100%"></div>' + ARTIC_BTN.filter(([a]) => isNote || a === 'fermata').map(([a, g, t]) => `<button data-a="art" data-d="${a}" class="${hasArtic(ev, a) ? 'on' : ''}" title="${t}"><span class="mus" style="top:${a === 'fermata' ? 6 : 8}px">${g}</span></button>`).join('')
    + '<div class="hint" style="width:100%"></div>' + ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'sfz'].map((d) => `<button data-a="dyn" data-d="${d}" class="${ev.dyn === d ? 'on' : ''}" title="dynamic ${d}"><span class="mus" style="font-size:22px;top:3px">${[...d].map((c) => DYN_CH[c]).join('')}</span></button>`).join('');
  box.classList.add('show');
  const p = S.L.evPos.get(ev.id);
  const bw = box.offsetWidth, bh = box.offsetHeight;
  const x = clamp((p.bbox.x0 + p.bbox.x1) / 2 * S.scale - bw / 2, 6, S.w - bw - 6);
  let y = (p.bbox.y0 - S.scrollY) * S.scale + 48 - bh - 26;
  if (y < 52) y = (p.bbox.y1 - S.scrollY) * S.scale + 48 + 26;
  box.style.left = x + 'px'; box.style.top = y + 'px';
}
function hideSel() { $('selbar').classList.remove('show'); }
$('selbar').addEventListener('pointerdown', (e) => e.stopPropagation());
$('selbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-a]'); if (!b || !S.selected) return;
  editSelected(b.dataset.a, b.dataset.d || (b.dataset.v !== undefined ? +b.dataset.v : undefined));
});

function editSelected(a, v) {
  const f = S.selected && findEvent(S.score, S.selected.id); if (!f) return;
  const before = JSON.stringify(S.score), ev = f.ev;
  const head = ev.kind === 'note' ? ev.heads.find((h) => h.pos === S.selected.pos) || ev.heads[0] : null;
  if (a === 'dur') { ev.dur = v; ev.full = false; delete ev.beamId; if (ev.tuplet) clearTuplet(S.score, ev.tuplet.id); }
  else if (a === 'dyn') { if (ev.dyn === v) delete ev.dyn; else ev.dyn = v; }
  else if (a === 'tup') {
    if (ev.tuplet) clearTuplet(S.score, ev.tuplet.id);
    else {
      const w = tupletWindows(f.events, f.i, 3).filter((x) => x.a === f.i).sort((p, q) => p.b - q.b)[0];
      if (!w) { toast('a triplet needs notes after this one that add up to three equal parts', 2600); return; }
      makeTuplet(S.score, f.events.slice(w.a, w.b).map((e) => e.id), 3);
    }
  }
  else if (a === 'dot') ev.dots = ((ev.dots || 0) + 1) % 3;
  else if (a === 'acc' && head) head.acc = head.acc === v ? null : v;
  else if (a === 'tie') ev.tie = !ev.tie;
  else if (a === 'art') setArtic(ev, v, !hasArtic(ev, v));
  else if (a === 'flip') {
    // flip every slur touching this note, from the side it is drawn on now
    (S.score.slurs || []).forEach((x, i) => {
      if (x.from !== ev.id && x.to !== ev.id) return;
      const seg = S.L.slurs.find((q) => q.idx === i);
      x.dir = seg && seg.up ? 'down' : 'up';
    });
  }
  else if (a === 'rest') { if (ev.kind === 'note') { ev.kind = 'rest'; ev.heads = []; ev.tie = false; } else { ev.kind = 'note'; ev.full = false; ev.dur = ev.dur || 4; ev.heads = [{ pos: 4, acc: null }]; } S.selected.pos = ev.kind === 'note' ? 4 : undefined; }
  else if (a === 'del') { removeEvent(S.score, ev.id); S.selected = null; }
  else if (a === 'move' && head) { for (const h of ev.heads) h.pos += v; S.selected.pos += v; }
  pushHistory(before); relayout(); save();
  if (S.selected) {
    showSel();
    const g = findEvent(S.score, S.selected.id);
    if (g) { toast(`<b>${describe(g.ev, S.L.spelled.get(g.ev))}</b>`, 1500); if (g.ev.kind === 'note') S.player.preview((S.L.spelled.get(g.ev) || []).map((h) => h.midi)); }
  } else { hideSel(); toast('deleted', 900); }
}

// ---------------------------------------------------------------- pointer input
const toPage = (e) => { const r = stage.getBoundingClientRect(); return { x: (e.clientX - r.left) / S.scale, y: (e.clientY - r.top) / S.scale + S.scrollY }; };
const touches = () => [...S.ptrs.values()].filter((p) => p.type === 'touch');
function fingerNavigates() { return S.settings.finger === 'navigate' || (S.settings.finger === 'auto' && S.penSeen); }

stage.addEventListener('pointerdown', (e) => {
  if (document.querySelector('dialog[open]')) return;
  $('exportMenu').classList.remove('show');
  S.player.ensure();
  const p = toPage(e);
  if (e.pointerType === 'pen' && !S.penSeen) { S.penSeen = true; updateMode(); }
  stage.setPointerCapture(e.pointerId);
  const rec = { id: e.pointerId, type: e.pointerType, start: p, last: p, t0: performance.now(), pts: [], moved: 0, sy0: S.scrollY, vy: 0, lastT: performance.now() };
  S.ptrs.set(e.pointerId, rec);
  const ts = touches();
  if (e.pointerType === 'touch' && ts.length >= 2) {
    // second finger: pinch/scroll; drop a stroke the first finger just began
    for (const t of ts) { if (t.role === 'ink' && performance.now() - t.t0 < 400) t.pts = []; t.role = 'pinch'; }
    const [a, b] = ts; S.pinch = { d0: Math.hypot(a.last.x - b.last.x, a.last.y - b.last.y) * S.scale, z0: S.settings.zoom, cy0: ((a.last.y + b.last.y) / 2 - S.scrollY) * S.scale, sy0: S.scrollY };
    return;
  }
  const eraser = e.pointerType === 'pen' && ((e.buttons & 32) || e.button === 5);
  if (eraser || S.tool === 'erase') { rec.role = 'erase'; rec.before = JSON.stringify(S.score); rec.erased = 0; rec.pts.push(p); hideAlts(); return; }
  const mk = S.ML && hitMarker(S.ML, markerView(), p.x * S.scale, (p.y - S.scrollY) * S.scale);
  // a marker: its label anywhere, its bracket when not writing (writing near it stays writing)
  if (mk && e.button === 0 && !S.pickJump && (mk.onLabel || S.tool !== 'write')) { rec.role = 'marker'; rec.marker = mk.id; return; }
  if (e.shiftKey && e.button === 0) { // shift-click extends the selection, like text
    const id = nearestEvent(p), a = S.range ? S.range.a : S.selected ? S.selected.id : null;
    if (id != null && a != null) { setRange(a, id); rec.role = 'range'; rec.anchor = a; rec.moved = 1; return; }
  }
  if (S.tool === 'select' || (e.pointerType === 'touch' && fingerNavigates()) || e.button === 1 || e.button === 2) {
    const hit = hitTest(p);
    if (hit && S.selected && hit.id === S.selected.id) { rec.role = 'drag'; rec.before = JSON.stringify(S.score); rec.dpos = 0; return; }
    // Select tool: a pen or mouse drag selects a range like text; a finger scrolls, or
    // selects after holding still for a moment
    if (S.tool === 'select' && e.pointerType !== 'touch' && e.button === 0) { rec.role = 'range'; rec.anchor = nearestEvent(p); rec.hit = hit; return; }
    rec.role = 'nav'; rec.hit = hit;
    if (S.tool === 'select' && e.pointerType === 'touch') rec.hold = setTimeout(() => { if (rec.role === 'nav' && rec.moved < 0.4) { rec.role = 'range'; rec.anchor = nearestEvent(p); rec.moved = 1; setRange(rec.anchor, rec.anchor); navigator.vibrate?.(10); } }, 450);
    return;
  }
  rec.role = 'ink';
  rec.pts.push({ x: p.x, y: p.y, p: e.pointerType === 'pen' ? e.pressure : 0.5, t: e.timeStamp });
  clearTimeout(S.groupTimer);
  hideAlts();
  drawInk();
});

window.addEventListener('pointermove', (e) => {
  const rec = S.ptrs.get(e.pointerId); if (!rec) return;
  const p = toPage(e);
  const dMoved = Math.hypot(p.x - rec.start.x, (p.y - S.scrollY) - (rec.start.y - rec.sy0));
  rec.moved = Math.max(rec.moved, dMoved);
  if (rec.role === 'ink') {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ce of evs.length ? evs : [e]) {
      const q = toPage(ce), last = rec.pts[rec.pts.length - 1];
      if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 0.02) rec.pts.push({ x: q.x, y: q.y, p: e.pointerType === 'pen' ? ce.pressure : 0.5, t: ce.timeStamp });
    }
    rec.pred = e.getPredictedEvents ? e.getPredictedEvents().slice(0, 2).map((pe) => toPage(pe)) : null;
    drawInk();
  } else if (rec.role === 'erase') {
    rec.pts.push(p);
    const b = { x0: p.x - 0.3, x1: p.x + 0.3, y0: p.y - 0.3, y1: p.y + 0.3 };
    const h = eraseHits(S.L, b, true);
    const n = h.ids.length + h.artics.length + h.slurs.length, hit = n > 0;
    if (hit) { applyErase(S.score, h); rec.erased += n; }
    if (hit) { if (S.selected && !findEvent(S.score, S.selected.id)) { S.selected = null; hideSel(); } relayout(); }
    drawInk();
  } else if (rec.role === 'pinch') {
    rec.last = p;
    const ts = touches(); if (ts.length < 2 || !S.pinch) return;
    const [a, b] = ts.map((t) => (t === rec ? { ...rec, screen: e } : t));
    const ax = a.last.x * S.scale, ay = (a.last.y - S.scrollY) * S.scale, bx = b.last.x * S.scale, by = (b.last.y - S.scrollY) * S.scale;
    const d = Math.hypot(ax - bx, ay - by), cy = (ay + by) / 2;
    const z = clamp(S.pinch.z0 * d / Math.max(20, S.pinch.d0), 0.6, 2);
    if (Math.abs(z - S.settings.zoom) > 0.02) { S.settings.zoom = z; resize(); }
    S.scrollY = clamp(S.pinch.sy0 - (cy - S.pinch.cy0) / S.scale, 0, maxScroll());
    drawScore(); drawInk();
    return;
  } else if (rec.role === 'nav') {
    const dy = (e.clientY - (rec.lastClientY ?? e.clientY));
    rec.lastClientY = e.clientY;
    if (rec.moved > 0.4) {
      const now = performance.now();
      S.scrollY = clamp(S.scrollY - dy / S.scale, 0, maxScroll());
      rec.vy = -dy / S.scale / Math.max(1, now - rec.lastT) * 16; rec.lastT = now;
      hideSel(); hideAlts(); hideRangeBar(); hideMarkBar(); drawScore(); drawInk();
    }
  } else if (rec.role === 'range') {
    if (rec.moved > 0.4 && rec.anchor != null) {
      const id = nearestEvent(p);
      if (id != null && (!S.range || S.range.b !== id || S.range.a !== rec.anchor)) setRange(rec.anchor, id);
      // scroll when the pen reaches the top or bottom edge
      const sy = (p.y - S.scrollY) * S.scale;
      if (sy > S.h - 30) S.scrollY = clamp(S.scrollY + 0.4, 0, maxScroll()); else if (sy < 30) S.scrollY = clamp(S.scrollY - 0.4, 0, maxScroll());
    }
  } else if (rec.role === 'drag') {
    const dpos = Math.round(-(p.y - rec.start.y) * 2);
    if (dpos !== rec.dpos) {
      const f = findEvent(S.score, S.selected.id);
      if (f && f.ev.kind === 'note') { for (const h of f.ev.heads) h.pos += dpos - rec.dpos; S.selected.pos += dpos - rec.dpos; rec.dpos = dpos; relayout(); showSel(); S.player.preview((S.L.spelled.get(f.ev) || []).map((h) => h.midi)); }
    }
  }
  rec.last = p;
});

function endPointer(e) {
  const rec = S.ptrs.get(e.pointerId); if (!rec) return;
  S.ptrs.delete(e.pointerId);
  if (rec.role === 'pinch') { if (touches().length < 2) S.pinch = null; save(); return; }
  if (e.type === 'pointercancel') { drawInk(); return; }
  const p = toPage(e);
  if (rec.role === 'ink') {
    const dt = performance.now() - rec.t0;
    const b = bbox([rec.pts]);
    if (dt < 300 && Math.max(b.w, b.h) < 0.35 && !S.group.length) {
      const hit = hitTest(p);
      if (hit || S.pickJump || S.range) { tapAt(p, hit); drawInk(); return; }
    }
    if (S.selected) { S.selected = null; hideSel(); drawScore(); }
    if (rec.pts.length) handleStroke({ pts: rec.pts, type: rec.type });
    drawInk();
  } else if (rec.role === 'erase') {
    if (rec.erased) { pushHistory(rec.before); save(); toast(`erased ${rec.erased}`, 900); }
    drawInk();
  } else if (rec.role === 'nav') {
    clearTimeout(rec.hold);
    if (rec.moved < 0.4) tapAt(p, rec.hit);
    else inertia(rec.vy);
  } else if (rec.role === 'range') {
    if (rec.moved < 0.4) tapAt(p, rec.hit);
    else if (S.range) showRangeBar();
  } else if (rec.role === 'marker') {
    if (rec.moved < 0.4) selectMarker(rec.marker);
  } else if (rec.role === 'drag') {
    if (rec.dpos) { pushHistory(rec.before); save(); }
  }
}
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);
stage.addEventListener('contextmenu', (e) => e.preventDefault());

function inertia(v) {
  const step = () => {
    if (Math.abs(v) < 0.02) return;
    S.scrollY = clamp(S.scrollY + v, 0, maxScroll()); v *= 0.93;
    drawScore(); drawInk(); requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey) { S.settings.zoom = clamp(S.settings.zoom * Math.exp(-e.deltaY / 300), 0.6, 2); resize(); save(); return; }
  S.scrollY = clamp(S.scrollY + (e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY) / S.scale, 0, maxScroll());
  hideAlts(); hideSel(); hideRangeBar(); hideMarkBar(); drawScore(); drawInk();
}, { passive: false });

// ---------------------------------------------------------------- toolbar
function setTool(t) { S.tool = t; for (const [k, id] of [['write', 'tWrite'], ['select', 'tSelect'], ['erase', 'tErase']]) $(id).classList.toggle('on', k === t); commitGroup(); updateMode(); }
$('tWrite').onclick = () => setTool('write');
$('tSelect').onclick = () => setTool('select');
$('tErase').onclick = () => setTool('erase');
$('undo').onclick = undo; $('redo').onclick = redo;
$('play').onclick = togglePlay;
$('title').addEventListener('input', (e) => { S.score.title = e.target.value || 'Untitled'; drawScore(); save(); });

function updateMode() {
  const t = { write: 'Write', select: 'Select', erase: 'Erase' }[S.tool];
  const finger = S.tool !== 'write' ? '' : fingerNavigates() ? ' · pen writes, finger scrolls & selects' : S.penSeen ? ' · pen & finger write' : ' · pen, mouse or finger writes';
  // while A/B testing (ink picked by hand or in the address) say which ink is on
  const ab = S.settings.ink !== 'auto' || params.has('lowlatency') ? (S.ink.active ? ' · low-latency ink' : ' · standard ink') : '';
  $('mode').textContent = t + finger + ab;
}

function togglePlay() {
  commitGroup();
  if (S.player.playing) { S.player.stop(); return; }
  // a selection plays just itself; an arrangement plays its markers; otherwise the score
  const r = S.range && rangeOf(S.score, S.range.a, S.range.b);
  if (r) { playProgram(compile(S.score, { range: r, loop: S.loopSel ? 64 : 1 })); return; }
  if (hasMarkers(S.score.program)) { playProgram(compile(S.score)); return; }
  $('playIc').textContent = '■'; $('playLbl').textContent = 'Stop';
  S.player.onStop = onStopPlay;
  // the playhead runs in the player's own (fermata-stretched) ticks
  const { onsets } = performanceOf(S.score);
  const map = staffInkMap(onsets.map((o) => ({ t: o.tick, end: o.tick + o.dur, id: o.id })));
  S.player.play(S.score, (on, now) => {
    S.playing = on; const h = map(now); S.heads = h ? [{ ...h, color: HEAD_COLORS[0] }] : [];
    followHeads(); drawScore();
  });
}
function onStopPlay() { S.playing = new Set(); S.heads = []; $('playIc').textContent = '▶'; $('playLbl').textContent = 'Play'; drawScore(); }

// ---------------------------------------------------------------- playheads
const evCenter = (p) => (p.hw ? p.x + p.hw / 2 : (p.bbox.x0 + p.bbox.x1) / 2);
/**
 * time -> page position, from [{ t, end, id }] (any time unit): each event's onset at its
 * notehead, and each bar's end at its barline, so the head crosses rests and empty beats.
 */
function staffInkMap(list) {
  const pts = [], ends = new Map();
  for (const q of list) {
    const p = S.L.evPos.get(q.id); if (!p) continue;
    pts.push({ t: q.t, line: p.sys, x: evCenter(p) });
    ends.set(p.mi, Math.max(ends.get(p.mi) ?? -Infinity, q.end));
  }
  for (const m of S.L.measures) if (ends.has(m.mi)) pts.push({ t: ends.get(m.mi), line: m.sys, x: m.x1 - 0.15, end: true });
  return timeMap(pts, sysLines());
}
/** Keep the first playhead's system in view. */
function followHeads() {
  const h = S.heads[0], sys = h && S.L.systems[h.line]; if (!sys) return;
  const top = sys.staffTops[0], bot = sys.staffTops[sys.staffTops.length - 1] + 4;
  if (top - 3 < S.scrollY || bot + 4 > S.scrollY + S.h / S.scale) S.scrollY = clamp(top - 6, 0, maxScroll());
}

/**
 * Authored playback through the timeline IR (../notation-ir): the score becomes a
 * measure-free timeline and `program` (see notation-ir/playback.js) says what plays when -
 * clips, jumps, loops, several cursors at once. Anchor to notes on the page with
 * { event: 'si<id>' } (StaffInk event ids). Every note any cursor is sounding lights up.
 * Loaded on first use, so the editor never depends on it.
 */
let IR = null;
async function loadIR() {
  if (!IR) {
    const [adapter, playback] = await Promise.all([import('../notation-ir/adapters/staffink.js'), import('../notation-ir/playback.js')]);
    IR = { ...adapter, ...playback };
  }
  return IR;
}
async function playProgram(program = {}) {
  commitGroup();
  const { fromStaffInk, perform, inkId } = await loadIR();
  const ir = fromStaffInk(S.score);
  let p;
  try { p = perform(ir, { tempo: S.score.tempo, root: { walk: {} }, ...program }); } catch (e) { toast(`can't play: ${e.message}`, 3000); return null; }
  if (!p.notes.length) { toast('nothing to play there', 1200); return p; }
  $('playIc').textContent = '■'; $('playLbl').textContent = 'Stop';
  S.player.onStop = onStopPlay;
  // the playheads run in score time (whole notes), one per cursor, coloured like their clip
  const W = 4 * DIV, map = staffInkMap(timeline(S.score).map((q) => ({ t: q.onset / W, end: q.end / W, id: q.id })));
  S.player.playPerformance(p, (on, now) => {
    S.playing = on; S.heads = headsAt(p, now, (f, at) => (f === 'main' ? map(at) : null), S.ML);
    followHeads(); drawScore();
  }, inkId);
  return p;
}

// ---------------------------------------------------------------- range selection & markers
function setRange(a, b) {
  if (a == null || b == null) return;
  S.range = { a, b }; S.selected = null; hideSel(); selectMarker(null, true);
  drawScore(); showRangeBar();
}
function clearRange() { if (!S.range) return; S.range = null; hideRangeBar(); drawScore(); }
/** A tap: completes a jump, selects a note, or clears the selection. */
function tapAt(p, hit) {
  if (S.pickJump != null) {
    const to = hit ? hit.id : nearestEvent(p), from = S.pickJump;
    S.pickJump = null;
    if (to == null) { toast('jump cancelled', 900); return; }
    scoreChange((s) => { const j = addJump(s, from, to); S.marker = j.id; });
    toast('<b>jump added</b> · it is taken on Play (arrangement: score)', 2200); selectMarker(S.marker); return;
  }
  clearRange(); selectMarker(null); select(hit);
}
const bar = (id) => $(id);
function placeBar(box, x0, x1, y0, y1) {
  box.classList.add('show');
  const bw = box.offsetWidth, bh = box.offsetHeight;
  const x = clamp(((x0 + x1) / 2) * S.scale - bw / 2, 6, S.w - bw - 6);
  let y = (y0 - S.scrollY) * S.scale + 48 - bh - 8;
  if (y < 52) y = (y1 - S.scrollY) * S.scale + 48 + 8;
  box.style.left = x + 'px'; box.style.top = y + 'px';
}
function showRangeBar() {
  const r = S.range && rangeOf(S.score, S.range.a, S.range.b), bands = rangeBands();
  if (!r || !bands.length) { hideRangeBar(); return; }
  const box = bar('rangebar');
  box.innerHTML = `<button data-r="play" title="Play the selection (Space)">▶ <small>${r.n}</small></button>`
    + `<button data-r="loop" class="${S.loopSel ? 'on' : ''}" title="Loop the selection when playing">⟳ Loop</button>`
    + '<button data-r="clip" title="Keep it as a clip marker: play it, loop it, layer it">＋ Clip</button>'
    + '<button data-r="jump" title="Add a jump: after this selection, continue at a note you tap">⤳ Jump</button>'
    + '<button data-r="x" title="Clear the selection (Esc)">✕</button>';
  const b = bands[0];
  placeBar(box, b.x0, b.x1, b.y0, b.y1);
}
function hideRangeBar() { bar('rangebar').classList.remove('show'); }
bar('rangebar').addEventListener('pointerdown', (e) => e.stopPropagation());
bar('rangebar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-r]'); if (!b) return;
  const r = S.range && rangeOf(S.score, S.range.a, S.range.b); if (!r) return;
  const a = b.dataset.r;
  if (a === 'play') { if (S.player.playing) S.player.stop(); togglePlay(); }
  else if (a === 'loop') { S.loopSel = !S.loopSel; showRangeBar(); }
  else if (a === 'clip') { let c; scoreChange((s) => { c = addClip(s, r); }); clearRange(); selectMarker(c.id); toast(`<b>clip ${c.name}</b> · tap its label to loop or layer it`, 2200); }
  else if (a === 'jump') { S.pickJump = r.last; clearRange(); toast('<b>tap the note to jump to</b> (Esc cancels)', 3000); }
  else if (a === 'x') clearRange();
});

function selectMarker(id, quiet) {
  S.marker = id || null;
  if (!id) { hideMarkBar(); progBar(); if (!quiet) drawScore(); return; }
  clearRange(); S.selected = null; hideSel(); showMarkBar(); progBar(); drawScore();
}
function showMarkBar() {
  const m = markerById(S.score, S.marker); if (!m) { hideMarkBar(); return; }
  const g = S.ML && S.ML.items.find((x) => x.id === m.id), box = bar('markbar');
  if (m.from && 'loop' in m) {
    const first = S.score.program.clips[0] === m;
    box.innerHTML = `<span class="hint" style="width:auto;padding:0 6px"><b>clip ${m.name}</b></span><button data-m="play" title="Play this clip">▶</button>`
      + `<button data-m="loop-" title="Fewer repeats">−</button><span class="hint" style="width:auto">×${m.loop}</span><button data-m="loop+" title="More repeats">+</button>`
      + (first ? '' : `<button data-m="with" class="${m.withPrev ? 'on' : ''}" title="Play together with the clip before it (arrangement: clips)">⧉ with previous</button>`)
      + `<button data-m="tr-" title="Down an octave">8vb</button><span class="hint" style="width:auto">${m.transpose ? (m.transpose > 0 ? '+' : '') + m.transpose : '±0'}</span><button data-m="tr+" title="Up an octave">8va</button>`
      + `<button data-m="dl-" title="Start earlier">◂</button><span class="hint" style="width:auto">delay ${m.delay || 0}</span><button data-m="dl+" title="Start a beat later">▸</button>`
      + (S.score.program.clips.length > 1 ? `<button data-m="ord-" ${first ? 'disabled' : ''} title="Play this clip earlier (Alt+←)">⇠ earlier</button><button data-m="ord+" ${S.score.program.clips.at(-1) === m ? 'disabled' : ''} title="Play this clip later (Alt+→)">later ⇢</button>` : '')
      + '<button data-m="del" title="Remove the marker">✕ Remove</button>';
  } else {
    box.innerHTML = `<span class="hint" style="width:auto;padding:0 6px"><b>jump</b></span><button data-m="times-">−</button><span class="hint" style="width:auto">×${m.times}</span><button data-m="times+">+</button><button data-m="del" title="Remove the jump">✕ Remove</button>`;
  }
  const seg = g && (g.pieces?.[0] || (g.from && { line: g.from.line, x0: g.from.x - 2, x1: g.from.x + 2 }));
  const sys = seg && S.L.systems[seg.line];
  if (!sys) { box.classList.add('show'); box.style.left = '10px'; box.style.top = '60px'; return; }
  placeBar(box, seg.x0, seg.x1, sys.staffTops[0] - 4, sys.staffTops[sys.staffTops.length - 1] + 5);
}
function hideMarkBar() { bar('markbar').classList.remove('show'); }
bar('markbar').addEventListener('pointerdown', (e) => e.stopPropagation());
bar('markbar').addEventListener('click', (e) => { const b = e.target.closest('button[data-m]'); if (b) markerEdit(b.dataset.m); });
function markerEdit(a) {
  const id = S.marker; if (!markerById(S.score, id)) return;
  if (a === 'play') {
    const m = markerById(S.score, id);
    if (S.player.playing) S.player.stop();
    playProgram({ root: compile({ ...S.score, program: { mode: 'clips', clips: [{ ...m, withPrev: false }], jumps: [] } }).root }); return;
  }
  scoreChange((s) => {
    const m = markerById(s, id);
    if (a === 'del') removeMarker(s, id);
    else if (a === 'loop-') m.loop = Math.max(1, m.loop - 1);
    else if (a === 'loop+') m.loop = Math.min(32, m.loop + 1);
    else if (a === 'with') m.withPrev = !m.withPrev;
    else if (a === 'tr-') m.transpose = (m.transpose || 0) - 12;
    else if (a === 'tr+') m.transpose = (m.transpose || 0) + 12;
    else if (a === 'dl-') m.delay = Math.max(0, (m.delay || 0) - 1);
    else if (a === 'dl+') m.delay = (m.delay || 0) + 1;
    else if (a === 'times-') m.times = Math.max(1, m.times - 1);
    else if (a === 'times+') m.times = Math.min(16, m.times + 1);
    else if (a === 'ord-' || a === 'ord+') moveClip(s, id, s.program.clips.indexOf(m) + (a === 'ord-' ? -1 : 1));
    if (a === 'with' && m.withPrev) s.program.mode = 'clips';
  });
  if (a === 'del') { selectMarker(null); toast('marker removed', 900); } else showMarkBar();
}

/** The arrangement strip: what Play plays when there are markers. */
function progBar() {
  const box = bar('progbar'), p = S.score.program;
  if (!hasMarkers(p)) { box.classList.remove('show'); return; }
  box.innerHTML = '<span class="hint" style="width:auto;padding:0 4px">Play:</span>'
    + `<button data-p="score" class="${p.mode !== 'clips' ? 'on' : ''}" title="Play through the score, taking the jumps">score${p.jumps.length ? ' + jumps' : ''}</button>`
    + `<button data-p="clips" class="${p.mode === 'clips' ? 'on' : ''}" title="Play the clips in this order (‖ plays together with the one before)">clips</button>`
    + '<span class="order" style="display:inline-flex;align-items:center;padding:0 2px"></span>';
  // the clips in playing order: tap one to edit it, drag it sideways to reorder
  renderClipOrder(box.querySelector('.order'), p, {
    selected: S.marker,
    onSelect: (id) => selectMarker(id),
    onMove: (id, to) => { scoreChange((s) => { moveClip(s, id, to); }); if (S.marker) showMarkBar(); toast(`<b>order</b> ${S.score.program.clips.map((c) => c.name).join(' ')}`, 1200); },
  });
  box.classList.add('show');
}
bar('progbar').addEventListener('pointerdown', (e) => e.stopPropagation());
bar('progbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-p]'); if (!b) return;
  scoreChange((s) => { (s.program ||= emptyProgram()).mode = b.dataset.p; });
});

// export
$('exportBtn').onclick = (e) => { const m = $('exportMenu'); const r = e.currentTarget.getBoundingClientRect(); m.style.left = Math.max(4, Math.min(r.left, innerWidth - 200)) + 'px'; m.style.top = r.bottom + 4 + 'px'; m.classList.toggle('show'); };
$('exportMenu').onclick = (e) => {
  const b = e.target.closest('button[data-x]'); if (!b) return;
  $('exportMenu').classList.remove('show'); commitGroup();
  const name = (S.score.title || 'score').replace(/[^\w\- ]+/g, '').trim() || 'score';
  const x = b.dataset.x;
  if (x === 'xml') download(`${name}.musicxml`, new Blob([toMusicXML(S.score)], { type: 'application/vnd.recordare.musicxml+xml' }));
  if (x === 'mid') download(`${name}.mid`, new Blob([toMidi(S.score)], { type: 'audio/midi' }));
  if (x === 'json') download(`${name}.staffink.json`, new Blob([JSON.stringify(S.score)], { type: 'application/json' }));
  if (x === 'png') exportPng(name);
  if (x === 'open') $('openFile').click();
  if (x === 'settings') $('settingsBtn').onclick();
  if (x === 'help') $('help').showModal();
};
$('openFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const s = validScore(JSON.parse(await f.text())); if (!s) throw new Error('not a StaffInk score'); pushHistory(JSON.stringify(S.score)); S.score = s; afterHistory('opened'); }
  catch (err) { toast('Could not open: ' + err.message, 4000); }
  e.target.value = '';
};
function download(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
function exportPng(name) {
  const sc = 14, w = Math.round(S.L.width * sc), h = Math.round((S.L.height + 4) * sc), k = 2;
  const c = document.createElement('canvas'); c.width = w * k; c.height = h * k;
  const g = c.getContext('2d'); g.scale(k, k);
  const L = layoutScore(S.score, { width: S.L.width, font: S.settings.font });
  renderScore(g, L, { scale: sc, scrollY: 0, width: w, height: h, title: S.score.title }, {});
  c.toBlob((b) => download(`${name}.png`, b), 'image/png');
}

// settings
const KEYS = [[-7, 'C♭ / a♭'], [-6, 'G♭ / e♭'], [-5, 'D♭ / b♭'], [-4, 'A♭ / f'], [-3, 'E♭ / c'], [-2, 'B♭ / g'], [-1, 'F / d'], [0, 'C / a'], [1, 'G / e'], [2, 'D / b'], [3, 'A / f♯'], [4, 'E / c♯'], [5, 'B / g♯'], [6, 'F♯ / d♯'], [7, 'C♯ / a♯']];
$('sKey').innerHTML = KEYS.map(([k, n]) => `<option value="${k}">${n} (${k ? Math.abs(k) + (k > 0 ? '♯' : '♭') : 'no accidentals'})</option>`).join('');
$('settingsBtn').onclick = () => {
  commitGroup();
  const sc = S.score;
  $('sStaves').value = sc.staves.map((s) => s.clef).join('') === 'GF' ? 'GF' : sc.staves[0].clef;
  $('sKey').value = sc.key; $('sTime').value = sc.timeSym === 'common' ? 'C' : sc.time.join('/');
  $('sTempo').value = sc.tempo; $('sFont').value = S.settings.font; $('sZoom').value = S.settings.zoom; $('sDelay').value = S.settings.delay;
  $('sFinger').value = S.settings.finger; $('sShowInk').checked = S.settings.showInk;
  $('sInk').value = S.settings.ink; inkNote();
  $('userCount').textContent = S.user.length ? `${S.user.length} corrected symbol${S.user.length > 1 ? 's' : ''}` : 'none yet: tap an alternative after a misread';
  $('settings').showModal();
};
$('settingsDone').onclick = () => $('settings').close();
function scoreChange(fn) { const before = JSON.stringify(S.score); fn(S.score); if (JSON.stringify(S.score) !== before) { pushHistory(before); relayout(); save(); } }
$('sStaves').onchange = (e) => scoreChange((s) => {
  const v = e.target.value, clefs = v === 'GF' ? ['G', 'F'] : [v];
  if (clefs.length !== s.staves.length) for (const m of s.measures) { while (m.staves.length < clefs.length) m.staves.push({ events: [] }); m.staves.length = clefs.length; if (m.attrs.clefs) m.attrs.clefs.length = clefs.length; }
  s.staves = clefs.map((c) => ({ clef: c }));
});
$('sKey').onchange = (e) => scoreChange((s) => { s.key = +e.target.value; });
$('sTime').onchange = (e) => scoreChange((s) => { const v = e.target.value; if (v === 'C') { s.time = [4, 4]; s.timeSym = 'common'; } else { s.time = v.split('/').map(Number); delete s.timeSym; } });
$('sTempo').onchange = (e) => scoreChange((s) => { s.tempo = clamp(+e.target.value || 96, 30, 260); });
$('sFont').onchange = (e) => { S.settings.font = e.target.value; document.fonts.load(`40px ${S.settings.font}`).then(relayout); save(); };
$('sZoom').oninput = (e) => { S.settings.zoom = +e.target.value; resize(); save(); };
$('sDelay').oninput = (e) => { S.settings.delay = +e.target.value; save(); };
$('sFinger').onchange = (e) => { S.settings.finger = e.target.value; updateMode(); save(); };
function inkNote() {
  const q = params.get('lowlatency');
  const now = S.ink.active ? 'now: low latency' : S.ink.wanted ? 'now: standard (this browser has no low-latency canvas)' : 'now: standard';
  const why = q === '1' || q === '0' ? ` · set by ?lowlatency=${q} in the address` : '';
  const warn = IS_ANDROID && S.ink.active ? ' · on Android this can black out the page; switch back if it does' : '';
  $('inkNow').textContent = now + why + warn;
}
$('sInk').onchange = (e) => { S.settings.ink = e.target.value; if (setupInk()) resize(); inkNote(); updateMode(); save(); };
$('sShowInk').onchange = (e) => { S.settings.showInk = e.target.checked; drawScore(); save(); };
$('forget').onclick = () => { S.user = []; saveUser(); $('userCount').textContent = 'none'; toast('forgot your handwriting corrections'); };
$('newScore').onclick = () => { scoreChange((s) => { const n = newScore({ staves: s.staves.map((x) => ({ ...x })), key: s.key, time: s.time, tempo: s.tempo }); Object.keys(s).forEach((k) => delete s[k]); Object.assign(s, n); }); $('title').value = S.score.title; S.pending = []; S.inkHistory = []; $('settings').close(); };
$('helpBtn').onclick = () => $('help').showModal();
$('helpDone').onclick = () => { $('help').close(); store('staffink.helped', true); };

// keyboard
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (e.key === ' ') { e.preventDefault(); togglePlay(); return; }
  if (e.key === 'Escape') { if (S.pickJump) { S.pickJump = null; toast('jump cancelled', 900); } clearRange(); selectMarker(null); select(null); hideAlts(); return; }
  if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const from = S.range || (S.selected && { a: S.selected.id, b: S.selected.id });
    if (from) { e.preventDefault(); setRange(from.a, stepFocus(S.score, from.b, e.key === 'ArrowLeft' ? -1 : 1)); showRangeBar(); }
    return;
  }
  if (S.marker && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); markerEdit('del'); return; }
  if (S.marker && e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && markerById(S.score, S.marker)?.loop !== undefined) { e.preventDefault(); markerEdit(e.key === 'ArrowLeft' ? 'ord-' : 'ord+'); return; }
  if (!S.selected) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editSelected('del'); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); editSelected('move', (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 7 : 1)); }
  else if (/^[1-6]$/.test(e.key)) editSelected('dur', [1, 2, 4, 8, 16, 32][+e.key - 1]);
  else if (e.key === '.') editSelected('dot');
});

// ---------------------------------------------------------------- boot
window.addEventListener('resize', resize);
$('title').value = S.score.title;
updateButtons(); updateMode();
Promise.all([document.fonts.load('40px Bravura'), document.fonts.load('40px Petaluma')]).finally(resize);
resize();
if (!load('staffink.helped') && !params.has('nohelp')) $('help').showModal();

// Music handed over from another app (ScoreShift's "Edit in StaffInk"): a StaffInk score
// built through the timeline IR, left in localStorage. Loading it is one undoable change.
if (params.has('import')) {
  const got = load('staffink.import');
  try { localStorage.removeItem('staffink.import'); } catch (e) { /* private mode */ }
  if (got && validScore(got.score)) {
    scoreChange((s) => { Object.keys(s).forEach((k) => delete s[k]); Object.assign(s, got.score); });
    $('title').value = S.score.title; S.pending = []; S.inkHistory = [];
    const r = got.report || {}, notes = [];
    if (r.dropped?.length) notes.push(`${r.dropped.reduce((a, d) => a + d.events, 0)} notes in a second voice left out`);
    if (r.approximated?.length) notes.push(`${r.approximated.length} tuplets written as plain notes`);
    if (r.clefs?.length) notes.push('a clef StaffInk lacks was replaced');
    toast(`<b>Opened from ${got.from || 'another app'}</b>${notes.length ? ' · ' + notes.join(' · ') : ''}`, 5000);
  } else toast('Nothing to import', 2000);
  history.replaceState(null, '', location.pathname + location.search.replace(/[?&]import\b/, '').replace(/^&/, '?'));
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') && !params.has('nosw')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}

/** Test/automation hook: page-space (staff spaces) ink straight into the recogniser. */
window.StaffInk = {
  S, get inkCanvas() { return cInk; }, get score() { return S.score; }, get layout() { return S.L; }, modelReady,
  write(strokes) { runGroup(strokes); return S.lastEdit && S.lastEdit.edit.label; },
  staffTop(sys = 0, si = 0) { return S.L.systems[sys].staffTops[si]; },
  pageToClient(x, y) { const r = stage.getBoundingClientRect(); return { x: r.left + x * S.scale, y: r.top + (y - S.scrollY) * S.scale }; },
  togglePlay, undo, redo, commitGroup,
  playProgram, async ir() { return (await loadIR()).fromStaffInk(S.score); },
  get heads() { return S.heads; },
  setRange, clearRange, get range() { return S.range && rangeOf(S.score, S.range.a, S.range.b); }, rangeBands, markerLayout: () => S.ML, selectMarker, markerEdit, tapAt,
  pageToCanvas(x, y) { return { x: x * S.scale, y: (y - S.scrollY) * S.scale }; },
};

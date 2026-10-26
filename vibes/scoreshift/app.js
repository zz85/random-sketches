// ScoreShift UI: load a photo, recognise in a worker, show original / interpretation /
// transposed page, let the user correct recognition, export.
import { INSTRUMENTS, keyName, CLEFS, instrument, midiOf } from './theory.js';
import { buildScore, evTicks, WHOLE } from './score.js';
import { toMusicXML, toMidi } from './export.js';
import { Player } from './player.js';
import { markOriginal, collectEdits, applyEdits, makeProject, readProject, fileKey } from './edits.js';
import { interpret, yOfP, lineY, spaceAt } from './omr.js';
import { Renderer, plan, describe, drawOverlay } from './render.js';
import { markersOf } from '../notation-ir/markers.js';
import { layoutMarkersOn, drawMarkersOn, hitMarkerOn, selectionBands, drawBands, headMaps, drawHeadsOn } from '../notation-ir/surface.js';
import { photoSurface } from './surface.js';
import { emptyArrangement, hasMarkers, addClip, addJump, removeMarker, markerById, moveClip, compileArrangement, arrangementMarkers, rangeOfIR } from '../notation-ir/arrangement.js';
import { renderClipOrder } from '../notation-ir/cliporder.js';
import { findById, parsePageId } from '../notation-ir/anchors.js';
import { headsAt, HEAD_COLORS } from '../notation-ir/playheads.js';

const $ = (id) => document.getElementById(id);
const cv = $('cv'), ov = $('ov'), ctx = cv.getContext('2d'), octx = ov.getContext('2d');
const ph = $('ph'), phx = ph.getContext('2d'); // playhead lines, redrawn every frame on their own canvas
const store = JSON.parse(localStorage.getItem('scoreshift') || '{}');
const S = { edits: new Map(), programs: new Map(), source: null, speed: store.speed || 1, metro: !!store.metro, startTick: 0, from: store.from || 'C', to: store.to || 'Bb-clarinet', octave: 'auto', clef: store.clef || 'auto', view: 'transposed', labels: !!store.labels, zoom: 1, model: null, rend: null, name: 'score', sel: null, tempo: store.tempo || 100, score: null, sounding: null };
const save = () => localStorage.setItem('scoreshift', JSON.stringify({ from: S.from, to: S.to, clef: S.clef, labels: S.labels, tempo: S.tempo, show: S.show, speed: S.speed, metro: S.metro }));

for (const sel of [$('from'), $('to')]) for (const i of INSTRUMENTS) sel.add(new Option(i.name, i.id));
$('from').value = S.from; $('to').value = S.to; $('clef').value = S.clef; $('labels').checked = S.labels;
$('from').onchange = (e) => { S.from = e.target.value; save(); update(); };
$('to').onchange = (e) => { S.to = e.target.value; S.octave = 'auto'; save(); update(); };
$('clef').onchange = (e) => { S.clef = e.target.value; save(); update(); };
$('labels').onchange = (e) => { S.labels = e.target.checked; save(); update(); };
document.querySelectorAll('[data-view]').forEach((b) => (b.onclick = () => { S.view = b.dataset.view; update(); }));
const oct = (d) => { const cur = S.octave === 'auto' ? (S.plan ? S.plan.staves[0]?.octave || 0 : 0) : S.octave; S.octave = d === 0 ? 'auto' : Math.max(-3, Math.min(3, cur + d)); update(); };
$('octDn').onclick = () => oct(-1); $('octUp').onclick = () => oct(1); $('octAuto').onclick = () => oct(0);
$('zoom').oninput = (e) => { S.zoom = +e.target.value; layoutStage(); };

// ---------- loading ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let job = Promise.resolve();
// Recognise one image (Blob, ImageBitmap or canvas). Returns { model, img } or throws.
function recognise(src) {
  const run = async () => {
    const bmp = src instanceof Blob ? await createImageBitmap(src, { imageOrientation: 'from-image' }) : src;
    const lim = 3600, f0 = Math.min(1, lim / Math.max(bmp.width, bmp.height));
    const img = document.createElement('canvas');
    img.width = Math.round(bmp.width * f0); img.height = Math.round(bmp.height * f0);
    img.getContext('2d').drawImage(bmp, 0, 0, img.width, img.height);
    // analysis copy: gray, at most ~2400 px
    const f = Math.min(1, 2400 / Math.max(img.width, img.height));
    const aw = Math.round(img.width * f), ah = Math.round(img.height * f);
    const ac = document.createElement('canvas'); ac.width = aw; ac.height = ah;
    const a2 = ac.getContext('2d', { willReadFrequently: true }); a2.drawImage(img, 0, 0, aw, ah);
    const rgba = a2.getImageData(0, 0, aw, ah).data, gray = new Uint8Array(aw * ah);
    for (let i = 0; i < aw * ah; i++) gray[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
    const res = await new Promise((resolve) => { worker.onmessage = (e) => resolve(e.data); worker.postMessage({ gray, w: aw, h: ah, f }, [gray.buffer]); });
    if (res.error) throw new Error(res.error);
    const m = res.model;
    for (const n of m.notes) n.st = m.staves[n.si];
    return { model: m, img };
  };
  const p = job.then(run, run); job = p.catch(() => {}); // one recognition at a time
  return p;
}
// A small pool of extra workers for PDF work (page probes on open, whole-file export), so
// probing pages runs in parallel with each other and with the interactive recogniser.
const pool = { workers: [], free: [], wait: [] };
function poolSize() { return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)); }
function poolGet() {
  if (!pool.workers.length) for (let i = 0; i < poolSize(); i++) { const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }); pool.workers.push(w); pool.free.push(w); }
  if (pool.free.length) return Promise.resolve(pool.free.pop());
  return new Promise((res) => pool.wait.push(res));
}
function poolPut(w) { const n = pool.wait.shift(); if (n) n(w); else pool.free.push(w); }
async function poolCall(msg, tr) {
  const w = await poolGet();
  try { return await new Promise((res, rej) => { w.onmessage = (e) => (e.data.error ? rej(new Error(e.data.error)) : res(e.data)); w.onerror = (e) => rej(new Error(e.message)); w.postMessage(msg, tr); }); }
  finally { poolPut(w); }
}
function poolClose() { pool.workers.forEach((w) => w.terminate()); pool.workers = []; pool.free = []; pool.wait = []; }
function probe(src) {
  const c = src, g = c.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, c.width, c.height).data, gray = new Uint8Array(c.width * c.height);
  for (let i = 0; i < gray.length; i++) gray[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  return poolCall({ probe: true, gray, w: c.width, h: c.height }, [gray.buffer]);
}
function show(model, img, name) {
  S.model = model; S.rend = new Renderer(img, model); S.name = name; S.octave = S.octave ?? 'auto';
  $('empty').hidden = true; $('stage').hidden = false; $('export').disabled = false;
  for (const id of ['play', 'xml', 'midi', 'editInk', 'markMode']) $(id).disabled = false;
  $('transport').hidden = false;
  player.stop(); S.selM = null; S.startTick = 0;
  fitZoom(); update();
}
function noteRestored(n) { setStatus($('status').innerHTML + ` · <b>${n}</b> saved correction${n > 1 ? 's' : ''} restored`); }
// ⬇ Project: the source file with the corrections of every page, and the settings
async function saveProject() {
  if (!S.source) return;
  markEdited();
  const pages = {};
  const n = S.pdf ? S.pdf.n : 1;
  for (let k = 1; k <= n; k++) { const e = S.edits.get(k) ?? (await idb.get(editKey(k)))?.edits; if (e) pages[k] = e; }
  const settings = { from: S.from, to: S.to, clef: S.clef, octave: S.octave, tempo: S.tempo, speed: S.speed };
  const programs = Object.fromEntries([...(S.programs || new Map())].filter(([, v]) => v));
  const text = makeProject({ bytes: S.source.bytes, name: S.source.name, mime: S.source.mime, pages, settings, programs });
  download(text, 'application/json', `${S.source.name.replace(/\.[^.]+$/, '')}.scoreshift`);
  return { pages: Object.keys(pages).length, size: text.length };
}
async function busy(fn, label = 'Reading the music…') {
  hidePop(); $('busy').firstElementChild.textContent = label; $('busy').style.display = 'grid';
  try { return await fn(); } finally { $('busy').style.display = 'none'; }
}
async function load(blob, name, fromProject = null) {
  // a ScoreShift project: its source file, with the corrections of every page
  if (!fromProject && (/\.scoreshift(\.json)?$/i.test(name || blob.name || '') || (blob.type === 'application/json' && blob.size > 100))) {
    let pr = null; try { pr = readProject(await blob.text()); } catch (e) { setStatus(`<b>Could not open this project:</b> ${e.message}`); return; }
    if (pr) {
      Object.assign(S, pr.settings);
      for (const [id, k] of [['from', 'from'], ['to', 'to'], ['clef', 'clef'], ['tempo', 'tempo']]) if (pr.settings[k] != null) $(id).value = pr.settings[k];
      return load(new File([pr.bytes], pr.name, { type: pr.mime }), pr.name, pr);
    }
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  S.source = { bytes, name: name || blob.name || 'score', mime: blob.type || (await isPdf(blob) ? 'application/pdf' : 'image/png'), key: await fileKey(bytes) };
  S.edits = new Map(fromProject ? Object.entries(fromProject.pages).map(([k, v]) => [+k, v]) : []);
  S.programs = new Map(fromProject ? Object.entries(fromProject.programs || {}).map(([k, v]) => [+k, v]) : []);
  if (fromProject) for (const [k, v] of S.edits) idb.put(editKey(k), v ? { edits: v, name: S.source.name, saved: Date.now() } : null);
  if (fromProject) for (const [k, v] of S.programs) idb.put(`${editKey(k)}:prog`, v ? { program: v, saved: Date.now() } : null);
  MKS.range = null; MKS.sel = null; MKS.pick = null;
  $('saveProject').disabled = false;
  if (await isPdf(blob)) return loadPdf(blob, name);
  closePdf();
  await busy(async () => {
    try { const { model, img } = await recognise(blob); S.octave = 'auto'; const n = await restoreEdits(model, 1); show(model, img, (name || 'score').replace(/\.[^.]+$/, '')); if (n) noteRestored(n); }
    catch (e) { setStatus(`<b>Could not read this image:</b> ${e.message}. Try a flatter, sharper photo with the full staff width in frame.`); }
  });
}

// ---------- PDF (IMSLP etc.) ----------
const pdfMod = () => import('./pdfsource.js');
async function isPdf(blob) { return (await pdfMod()).isPdf(blob); }
function closePdf() { if (S.pdf) { const pp = S.pdf.pool; S.pdf = null; pp.destroy(); poolClose(); } $('pages').hidden = true; $('exportPdf').hidden = true; }
async function loadPdf(blob, name) {
  closePdf();
  await busy(async () => {
    try {
      const { PdfPool } = await pdfMod();
      const pool = await PdfPool.open(blob, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
      const P = (S.pdf = { pool, name: (name || 'score').replace(/\.pdf$/i, ''), n: pool.numPages, page: 0, edited: new Map(), thumbs: new Map() });
      $('pages').hidden = false; $('exportPdf').hidden = false;
      S.octave = 'auto';
      // IMSLP / Internet Archive files open with a cover, title page, preface: probe pages at
      // 1000 px for staves, a batch at a time across the readers, and start at the first page
      // mostly covered by staves. The probe renders double as thumbnails.
      const B = pool.readers.length, lim = Math.min(P.n, 40);
      let best = 1, most = 0, found = 0;
      for (let k0 = 1; k0 <= lim && !found; k0 += B) {
        $('busy').firstElementChild.textContent = `Looking for music… page ${k0}`;
        const ks = Array.from({ length: Math.min(B, lim - k0 + 1) }, (_, i) => k0 + i);
        const res = await Promise.all(ks.map(async (k) => { const { canvas } = await pool.render(k, 1000); P.thumbs.set(k, thumbOf(canvas)); return probe(canvas); }));
        res.forEach(({ staves, cover }, i) => {
          if (staves > most) { most = staves; best = ks[i]; }
          if (!found && staves >= 3 && cover >= 0.4) found = ks[i];
        });
      }
      if (found) best = found;
      buildThumbs();
      await openPage(best);
    } catch (e) { closePdf(); setStatus(`<b>Could not open this PDF:</b> ${e.message}`); }
  }, 'Opening PDF…');
}
async function openPage(k, quiet = false) {
  const P = S.pdf; if (!P || k < 1 || k > P.n) return false;
  P.page = k; pageUi();
  if (P.edited.has(k)) { const e = P.edited.get(k); show(e.model, e.img, `${P.name}-p${k}`); return true; }
  const { canvas } = await P.pool.render(k, 3000);
  try {
    const { model, img } = await recognise(canvas);
    if (P !== S.pdf) return false;
    const nr = await restoreEdits(model, k);
    if (nr) P.edited.set(k, { model, img });
    show(model, img, `${P.name}-p${k}`);
    if (nr) noteRestored(nr);
    return true;
  } catch (e) {
    if (quiet) return false;
    // no music on this page: show it as is
    S.model = null; S.rend = null;
    cv.width = canvas.width; cv.height = canvas.height; ctx.drawImage(canvas, 0, 0); ov.width = 1; ov.height = 1;
    $('empty').hidden = true; $('stage').hidden = false; $('export').disabled = true;
    const w = Math.min($('wrap').clientWidth - 4, canvas.width / devicePixelRatio);
    cv.style.width = w + 'px'; cv.style.height = (w * canvas.height) / canvas.width + 'px';
    setStatus(`Page ${k} of ${P.n}: <b>no staves found</b> (${e.message}).`);
    return false;
  }
}
// ---------- saving: autosave of corrections (IndexedDB, per file and page), project files ----------
const idb = (() => {
  let db = null;
  const open = () => db || (db = new Promise((res, rej) => { if (!self.indexedDB) return rej(new Error('no IndexedDB')); const q = indexedDB.open('scoreshift', 1); q.onupgradeneeded = () => q.result.createObjectStore('edits'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }));
  const tx = async (mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction('edits', mode), r = fn(t.objectStore('edits')); t.oncomplete = () => res(r?.result); t.onerror = () => rej(t.error); }); };
  return { get: (k) => tx('readonly', (s) => s.get(k)).catch(() => null), put: (k, v) => tx('readwrite', (s) => (v ? s.put(v, k) : s.delete(k))).catch(() => null) };
})();
const pageNo = () => (S.pdf ? S.pdf.page : 1);
const editKey = (k = pageNo()) => S.source && `${S.source.key}:${k}`;
const markEdited = () => {
  if (S.pdf && S.model) S.pdf.edited.set(S.pdf.page, { model: S.model, img: S.rend.img });
  if (S.model && S.source) { const e = collectEdits(S.model); idb.put(editKey(), e ? { edits: e, name: S.source.name, saved: Date.now() } : null); S.edits.set(pageNo(), e); }
};
// a freshly read page: remember what was read, then put back any corrections saved for it
async function restoreEdits(model, k = pageNo()) {
  markOriginal(model);
  if (!S.programs.has(k) && S.source) { const pr = await idb.get(`${editKey(k)}:prog`); if (pr?.program) S.programs.set(k, pr.program); }
  const saved = S.edits.get(k) ?? (S.source ? (await idb.get(editKey(k)))?.edits : null);
  if (!saved) return 0;
  const r = applyEdits(model, saved, { interpret, yOfP });
  S.edits.set(k, saved);
  return r.applied;
}
function pageUi() {
  const P = S.pdf; if (!P) return;
  $('pageNo').textContent = `${P.page} / ${P.n}`;
  $('prevPage').disabled = P.page <= 1; $('nextPage').disabled = P.page >= P.n;
  document.querySelectorAll('#thumbs button').forEach((b) => b.setAttribute('aria-current', +b.dataset.page === P.page ? 'page' : 'false'));
  document.querySelector(`#thumbs button[data-page="${P.page}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
const thumbOf = (src) => {
  const t = document.createElement('canvas'), f = 160 / Math.max(src.width, src.height);
  t.width = Math.round(src.width * f); t.height = Math.round(src.height * f);
  t.getContext('2d').drawImage(src, 0, 0, t.width, t.height);
  return t;
};
function buildThumbs() {
  const strip = $('thumbs'), P = S.pdf; strip.innerHTML = '';
  const io = new IntersectionObserver((ents) => ents.forEach((en) => {
    if (!en.isIntersecting) return; io.unobserve(en.target);
    const b = en.target, k = +b.dataset.page;
    const put = (c) => { c.setAttribute('aria-hidden', 'true'); b.prepend(c); };
    if (P.thumbs.has(k)) return put(P.thumbs.get(k));
    // after page work: thumbnails only ever wait behind it
    (P.thumbQ ||= Promise.resolve());
    P.thumbQ = P.thumbQ.then(() => (P === S.pdf ? P.pool.render(k, 160) : null)).then((r) => r && put(r.canvas)).catch(() => {});
  }), { root: strip, rootMargin: '200px' });
  for (let k = 1; k <= P.n; k++) {
    const b = document.createElement('button'); b.dataset.page = k; b.title = `Page ${k}`;
    b.innerHTML = `<span>${k}</span>`; b.setAttribute('aria-label', `Page ${k}`);
    b.onclick = () => busy(() => openPage(k));
    strip.appendChild(b); io.observe(b);
  }
}
$('prevPage').onclick = () => S.pdf && busy(() => openPage(S.pdf.page - 1));
$('nextPage').onclick = () => S.pdf && busy(() => openPage(S.pdf.page + 1));

// Whole document, transposed, as a PDF: pages without staves are kept as they are.
// The main thread only paints PDF pages; a pool of workers recognises, rewrites and
// JPEG-encodes them in parallel (OffscreenCanvas), results reassembled in page order.
async function exportPdf() {
  const P = S.pdf; if (!P) return;
  const { writePdf } = await pdfMod();
  const opts = { from: S.from, to: S.to, octave: S.octave, clef: S.clef }, q = 0.8;
  const pages = new Array(P.n); let next = 1, done = 0;
  const progress = () => ($('busy').firstElementChild.textContent = `Transposing… ${done} of ${P.n} pages`);
  const jpegMain = (c) => new Promise((res) => c.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), 'image/jpeg', q));
  const lane = async () => {
    while (next <= P.n) {
      const k = next++;
      const { canvas, widthPt, heightPt } = await P.pool.render(k, 2400); // pages render on all readers at once
      let r;
      if (P.edited.has(k)) { // corrected by hand: use that model, render here
        const { model, img } = P.edited.get(k), c = document.createElement('canvas');
        new Renderer(img, model).render(c.getContext('2d'), plan(model, opts));
        r = { jpeg: await jpegMain(c), w: c.width, h: c.height };
      } else {
        const bitmap = await createImageBitmap(canvas);
        canvas.width = canvas.height = 1; // free the page early
        r = await poolCall({ page: true, bitmap, opts, q }, [bitmap]);
      }
      pages[k - 1] = { ...r, widthPt, heightPt };
      done++; progress();
    }
  };
  progress(); await Promise.all(Array.from({ length: poolSize() }, lane));
  const bytes = writePdf(pages);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  a.download = `${P.name}-${S.to}.pdf`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return { bytes: bytes.length, music: pages.filter((p) => p.music).length };
}
$('exportPdf').onclick = () => busy(exportPdf, 'Transposing…');
for (const id of ['cam', 'cam2', 'file']) $(id).onchange = (e) => { const f = e.target.files[0]; if (f) load(f, f.name); e.target.value = ''; };
const sample = async () => closePdf() || load(await (await fetch('sample.jpg')).blob(), 'minuet');
$('sample').onclick = sample; $('sample2').onclick = sample;
window.addEventListener('paste', (e) => { const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/') || i.type === 'application/pdf'); if (it) load(it.getAsFile(), 'pasted'); });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) load(f, f.name); });

// ---------- drawing ----------
function setStatus(html) { $('status').innerHTML = html; }
function update() {
  document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === S.view));
  $('octAuto').setAttribute('aria-pressed', S.octave === 'auto');
  const m = S.model; if (!m) return;
  const pl = (S.plan = plan(m, { from: S.from, to: S.to, octave: S.octave, clef: S.clef }));
  S.score = buildScore(m);
  const R = S.rend;
  if (S.view === 'transposed') R.render(ctx, pl);
  else { cv.width = R.W; cv.height = R.H; ctx.drawImage(R.src, 0, 0); }
  ov.width = R.W; ov.height = R.H; octx.clearRect(0, 0, R.W, R.H);
  if (S.view === 'interpreted') drawOverlay(octx, m, R.r, null, 'original', S.sel);
  else if (S.labels && S.view === 'transposed') drawOverlay(octx, m, R.r, pl, 'transposed', S.sel);
  else if (S.labels) drawOverlay(octx, m, R.r, null, 'original', S.sel);
  if (S.view === 'interpreted') drawRhythm(octx, m, S.score, R.r, S.selM);
  drawPlayhead();
  drawProgramMarkers();
  refreshMarkers();
  if (!player.playing) showPos(S.startTick);
  chips();
  layoutStage();
  const n = m.notes.length, octs = [...new Set(pl.staves.map((p) => p.octave))], oc = octs.length === 1 && octs[0] ? ` · ${octs[0] > 0 ? '+' : ''}${octs[0]} oct${pl.octave === 'auto' ? ' (auto)' : ''}` : octs.length > 1 ? ' · octave per staff (auto)' : '';
  setStatus(`${S.pdf ? `Page ${S.pdf.page} of ${S.pdf.n} · ` : ''}<b>${m.staves.length}</b> staves · <b>${n}</b> notes · ${describe(m, pl)}${oc} · read in ${Math.round(m.ms)} ms · ${barSummary(S.score)}${S.view === 'interpreted' ? ' · tap a note, rest, bar or staff label to correct it' : ''}`);
}
function barSummary(sc) {
  const st = sc.stats, bad = st.under + st.over, n = sc.measures.length;
  return `<b>${n}</b> bars: ${bad ? `<b class="bad">${bad} don't add up</b>` : 'all add up'}${st.repaired ? `, ${st.repaired} auto-fixed` : ''}`;
}

// ---------- rhythm overlay (interpreted view) ----------
const DUR_GLYPH = { 1: '𝅝', 2: '𝅗𝅥', 4: '♩', 8: '♪', 16: '𝅘𝅥𝅯', 32: '𝅘𝅥𝅰' };
const evLabel = (e) => `${e.kind === 'rest' ? 'r' : ''}${e.full ? 'bar' : e.dur}${'.'.repeat(e.dots || 0)}${e.tuplet ? '³' : ''}${e.tie ? '⁀' : ''}${e.voice ? ' v2' : ''}${(e.notes?.[0].artic || []).map((a) => ({ stacc: '·', ten: '–', acc: '>' })[a]).join('')}`;
// What Interpreted view shows (each can be switched off in the Show menu).
const SHOW_KEYS = [['bars', 'bar numbers + checks'], ['values', 'note values'], ['artic', 'articulations + bowing'], ['ties', 'ties'], ['slurs', 'slurs'], ['dyn', 'dynamics + hairpins'], ['voices', 'voices'], ['text', 'text']];
S.show = Object.assign(Object.fromEntries(SHOW_KEYS.map(([k]) => [k, true])), store.show || {});
const pill = (g, text, x, y, fg, bg = 'rgba(255,255,255,.92)', align = 'center') => {
  const w = g.measureText(text).width + 6, x0 = align === 'left' ? x - 3 : x - w / 2;
  g.fillStyle = bg; g.fillRect(x0, y - 11, w, 14); g.fillStyle = fg; g.textAlign = align; g.fillText(text, align === 'left' ? x : x, y);
};
function arc(g, x0, y0, x1, y1, up, dash) {
  const mx = (x0 + x1) / 2, h = Math.min(28, 6 + 0.12 * Math.abs(x1 - x0));
  g.setLineDash(dash ? [5, 4] : []); g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(mx, (y0 + y1) / 2 + (up ? -h : h), x1, y1); g.stroke(); g.setLineDash([]);
}
function drawRhythm(g, model, sc, r, selM) {
  const on = S.show;
  g.save(); g.scale(r, r);
  for (const m of sc.measures) {
    const st = m.st, ya = lineY(st, 0, m.x0) - 2, yb = lineY(st, 4, m.x0) + 2;
    const bad = m.status === 'under' || m.status === 'over', fixed = m.repairs.length > 0;
    if (bad || fixed || m === selM) {
      g.fillStyle = bad ? 'rgba(230,40,40,.13)' : 'rgba(255,170,0,.10)';
      g.fillRect(m.x0 + 2, ya, m.x1 - m.x0 - 4, yb - ya);
      if (m === selM) { g.strokeStyle = '#0a58ca'; g.lineWidth = 2; g.strokeRect(m.x0 + 2, ya, m.x1 - m.x0 - 4, yb - ya); }
    }
    if (on.bars) {
      // bar number above the staff at the bar's start; under it the count when it does not add up
      g.font = '700 12px system-ui, sans-serif';
      pill(g, `${m.number}${m.voices > 1 && on.voices ? ' ‖2' : ''}`, m.x0 + 4, ya - 6, '#0b5394', 'rgba(219,234,254,.95)', 'left');
      g.font = '700 14px system-ui, sans-serif';
      const tx = (m.x0 + m.x1) / 2, ty = lineY(st, 4, tx) + 36;
      const label = bad ? `${m.ticks / 96}/${m.cap / 96} beats` : fixed ? `fixed: ${m.repairs.join(', ')}` : m.timeShown ? `${m.time.beats}/${m.time.unit}${m.time.inferred ? '?' : ''}` : '';
      if (label) pill(g, label, tx, ty, bad ? '#b4141e' : '#8a5a00');
    }
    g.font = '700 12px system-ui, sans-serif';
    for (const e of m.events) {
      if (e.removed) continue;
      if (e.kind === 'rest' && on.values) { const b = e.rest.box; g.strokeStyle = 'rgba(120,60,200,.85)'; g.lineWidth = 1.5; g.strokeRect(b[0] - 1, b[1] - 1, b[2] - b[0] + 2, b[3] - b[1] + 2); }
      const y = e.kind === 'rest' ? e.rest.box[3] + 10 : Math.max(...e.notes.map((n) => n.y)) + (e.notes[0].stem && e.notes[0].stem.dir > 0 ? Math.max(0, e.notes[0].stem.tip - Math.max(...e.notes.map((n) => n.y))) + 10 : 20);
      const parts = [];
      if (on.values) parts.push(`${e.kind === 'rest' ? 'r' : ''}${e.full ? 'bar' : e.dur}${'.'.repeat(e.dots || 0)}${e.tuplet ? '³' : ''}${e.grace ? ((e.notes[0].fix?.graceKind ?? e.notes[0].graceKind) === 'app' ? ' appogg.' : ' acciacc.') : ''}`);
      if (on.voices && m.voices > 1) parts.push(`v${(e.voice ?? 0) + 1}`);
      if (on.artic) parts.push(...(e.notes?.[0].artic || []).map((a) => ({ stacc: 'stacc', ten: 'ten', acc: 'acc', upbow: 'up-bow V', dnbow: 'down-bow ⊓' })[a]));
      if (parts.length) pill(g, parts.join(' '), e.x, y, e.repaired ? '#c2410c' : e.fixed ? '#0a7d32' : '#4b2a8a');
    }
  }
  for (const st of model.staves) {
    g.lineWidth = 2.2;
    if (on.ties) { g.strokeStyle = 'rgba(0,140,70,.9)'; for (const a of st.notes) if (a.tie) { const b = st.notes.find((q) => q.chord === a.chord + 1 && q.p === a.p); const up = a.stem ? a.stem.dir > 0 : true; if (b) arc(g, a.box[2], a.y + (up ? -7 : 7), b.box[0], b.y + (up ? -7 : 7), up); else arc(g, a.box[2], a.y - 7, a.box[2] + 30, a.y - 7, true); } }
    if (on.slurs) { g.strokeStyle = 'rgba(200,0,120,.85)'; for (const sl of st.slurs || []) { const b = sl.box; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(b[0], sl.yl); g.quadraticCurveTo((b[0] + b[2]) / 2, 2 * sl.peak - (sl.yl + sl.yr) / 2, b[2], sl.yr); g.stroke(); g.setLineDash([]); g.font = '700 11px system-ui, sans-serif'; pill(g, `slur${sl.open ? '→' : ''}${sl.cont ? '←' : ''}`, (b[0] + b[2]) / 2, sl.above ? b[1] - 3 : b[3] + 14, '#a3006b'); } }
    if (on.dyn) {
      g.font = '800 13px system-ui, sans-serif';
      for (const d of st.dynamics || []) { const b = d.box; g.strokeStyle = 'rgba(200,90,0,.9)'; g.lineWidth = 1.5; g.strokeRect(b[0] - 2, b[1] - 2, b[2] - b[0] + 4, b[3] - b[1] + 4); pill(g, d.text, (b[0] + b[2]) / 2, b[3] + 16, '#b45309', 'rgba(255,237,213,.95)'); }
      for (const h of st.hairpins || []) { const b = h.box; g.strokeStyle = 'rgba(200,90,0,.9)'; g.lineWidth = 1.5; g.strokeRect(b[0] - 2, b[1] - 2, b[2] - b[0] + 4, b[3] - b[1] + 4); pill(g, h.form === 'cresc' ? 'cresc <' : 'dim >', (b[0] + b[2]) / 2, b[3] + 16, '#b45309', 'rgba(255,237,213,.95)'); }
    }
    if (on.text) { g.font = '600 11px system-ui, sans-serif'; for (const t of st.words || []) { const b = t.box; g.strokeStyle = 'rgba(100,110,120,.7)'; g.lineWidth = 1; g.setLineDash([3, 3]); g.strokeRect(b[0] - 2, b[1] - 2, b[2] - b[0] + 4, b[3] - b[1] + 4); g.setLineDash([]); pill(g, `text${t.guess ? ' ~' + t.guess : ''}`, b[0], b[1] - 4, '#475569', 'rgba(241,245,249,.95)', 'left'); } }
  }
  g.restore();
}
// Show menu: one checkbox per kind of label
(() => {
  const box = $('show'); if (!box) return;
  box.innerHTML = '<summary>Show ▾</summary><div class="panel">' + SHOW_KEYS.map(([k, l]) => `<label><input type="checkbox" data-show="${k}" ${S.show[k] ? 'checked' : ''}> ${l}</label>`).join('') + '</div>';
  box.querySelectorAll('[data-show]').forEach((c) => (c.onchange = () => { S.show[c.dataset.show] = c.checked; save(); update(); }));
})();
function drawPlayhead() {
  if (!S.sounding || !S.sounding.length) return;
  const r = S.rend.r; octx.save(); octx.scale(r, r); octx.fillStyle = 'rgba(255,90,0,.45)';
  for (const o of S.sounding) {
    const e = o.e;
    if (e.kind === 'rest') { const b = e.rest.box; octx.fillRect(b[0], b[1], b[2] - b[0], b[3] - b[1]); continue; }
    for (const n of e.notes) {
      const nn = S.view === 'transposed' ? S.plan.staves[n.st.index].notes.find((q) => q.n === n) : null;
      const y = nn ? yOfP(n.st, nn.p, n.x) : n.y;
      octx.beginPath(); octx.ellipse(n.x, y, 13, 10, 0, 0, Math.PI * 2); octx.fill();
    }
  }
  octx.restore();
}

// ---------- playback and music export ----------
const player = new Player();
const musicOpts = () => {
  const transposed = S.view === 'transposed';
  return { plan: transposed ? S.plan : null, from: instrument(S.from), instrument: transposed ? instrument(S.to) : instrument(S.from), tempo: S.tempo };
};
$('tempo').value = S.tempo;
$('tempo').onchange = (e) => { S.tempo = Math.max(20, Math.min(320, +e.target.value || 100)); e.target.value = S.tempo; save(); if (player.playing) { player.setSpeed(S.speed); player.tempo = S.tempo; } showPos(S.startTick); };
// ---------- transport: play / stop, position, speed, metronome ----------
// Length of the music in ticks and where each bar starts (first part), for the position slider.
function barStarts(sc) { const out = []; let t = 0; for (const m of sc.parts[0]?.measures || []) { out.push({ m, tick: t }); t += m.status === 'rest' ? m.cap : m.ticks; } return { out, total: t }; }
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
function showPos(tick) {
  if (!S.score) return;
  const { out, total } = barStarts(S.score), spt = 60 / (S.tempo * S.speed) / 96;
  const bar = [...out].reverse().find((q) => q.tick <= tick + 1e-6);
  $('posText').textContent = `bar ${bar ? bar.m.number : 1} · ${mmss(tick * spt)} / ${mmss(total * spt)}`;
  if (!S.dragPos) { $('pos').max = Math.max(1, Math.round(total)); $('pos').value = Math.round(tick); }
}
function redrawPlay(on) {
  S.sounding = on;
  const R = S.rend; octx.clearRect(0, 0, R.W, R.H);
  if (S.view === 'interpreted') { drawOverlay(octx, S.model, R.r, null, 'original', S.sel); drawRhythm(octx, S.model, S.score, R.r, S.selM); }
  else if (S.labels) drawOverlay(octx, S.model, R.r, S.view === 'transposed' ? S.plan : null, S.view === 'transposed' ? 'transposed' : 'original', S.sel);
  drawPlayhead();
  drawProgramMarkers();
}
function startPlay(fromTick) {
  $('play').textContent = '■ Stop'; $('play').setAttribute('aria-pressed', 'true');
  let last = '';
  player.speed = S.speed; player.metronome = S.metro;
  let map = null; // playhead positions come from the page surface, once the IR is ready (a few ms)
  toIR().then((irc) => { S.surf = surfaceFor(irc); map = headMaps(S.surf, irItems(irc.score, WHOLE)); });
  player.play(S.model, S.score, musicOpts(), (on, now) => {
    S.startTick = now; showPos(now);
    const key = on.map((o) => o.tick).join();
    if (key !== last) { last = key; redrawPlay(on); }
    S.heads = map ? map(now).map((h) => ({ ...h, color: HEAD_COLORS[0] })) : [];
    drawHeads();
  }, fromTick);
}

// ---------- playhead lines ----------
// One line per part across its staff, gliding with the music (through rests and long notes),
// perpendicular to the staff on a tilted photo; one per cursor for programs, coloured like
// their clip. Drawn on their own canvas so a frame costs one line, not the overlay.
/** The page as a notation-ir surface (./surface.js): markers, playheads and selection all go through it. */
function surfaceFor(irc) { return photoSurface({ model: S.model, score: S.score, irc, view: mkView }); }
/** IR events as surface time items, time in `unit`s of a whole note (ticks: WHOLE, whole notes: 1). */
function irItems(score, unit) {
  const f = (x) => (x.n / x.d) * unit;
  return score.events.filter((e) => !e.fragment && e.src).map((e) => ({ id: e.id, t: f(e.onset), end: f(e.onset) + f(e.dur) }));
}
function drawHeads() {
  const R = S.rend; if (!R) return;
  if (ph.width !== R.W || ph.height !== R.H) { ph.width = R.W; ph.height = R.H; }
  phx.clearRect(0, 0, R.W, R.H);
  if (!S.heads?.length || !S.model) return;
  if (S.surf) drawHeadsOn(phx, S.surf, S.heads);
  followHead();
}
/** Keep the first playhead in view while playing. */
function followHead() {
  const h = S.heads[0], st = h && S.model.staves[h.line]; if (!st) return;
  const k = (S.rend.r / devicePixelRatio) * S.zoom, w = $('wrap'), sg = $('stage'), sp = spaceAt(st, h.x);
  const y0 = sg.offsetTop + (lineY(st, 0, h.x) - 3 * sp) * k, y1 = sg.offsetTop + (lineY(st, 4, h.x) + 3 * sp) * k, x = sg.offsetLeft + h.x * k;
  if (y0 < w.scrollTop || y1 > w.scrollTop + w.clientHeight) w.scrollTop = y0 - w.clientHeight / 4;
  if (x < w.scrollLeft + 20 || x > w.scrollLeft + w.clientWidth - 20) w.scrollLeft = x - w.clientWidth / 3;
}
$('play').onclick = () => {
  if (!S.model) return;
  if (player.playing) { player.stop(); return; }
  // a selection plays just itself; an arrangement plays its markers; otherwise the page
  if (rangeNow()) { playRange(); return; }
  const arr = arrOf();
  if (hasMarkers(arr) && arr.mode && arr.mode !== 'page' && (arr.mode === 'clips' ? arr.clips.length : arr.jumps.length)) { playProgram(); return; }
  if (S.programs.get(pageNo()) && !arr) { playProgram(); return; }
  const total = barStarts(S.score).total;
  startPlay(S.startTick >= total - 1 ? 0 : S.startTick);
};
$('pos').oninput = () => { S.dragPos = true; S.startTick = +$('pos').value; showPos(S.startTick); };
$('pos').onchange = () => {
  S.dragPos = false; S.startTick = +$('pos').value;
  // snap to the start of the bar it falls in, so playback starts on a downbeat
  const bar = [...barStarts(S.score).out].reverse().find((q) => q.tick <= S.startTick + 1e-6); if (bar) S.startTick = bar.tick;
  if (player.playing) { player.onStop = null; player.stop(); player.onStop = onPlayStop; startPlay(S.startTick); } else showPos(S.startTick);
};
$('speed').value = S.speed; $('speedText').textContent = `×${S.speed.toFixed(2)}`;
$('speed').oninput = () => { S.speed = +$('speed').value; $('speedText').textContent = `×${S.speed.toFixed(2)}`; player.setSpeed(S.speed); showPos(S.startTick); save(); };
$('metro').checked = S.metro;
$('metro').onchange = () => { S.metro = $('metro').checked; player.metronome = S.metro; save(); };
// ---------- the timeline IR (../notation-ir), loaded on first use ----------
// Authored playback over the page (clips, jumps, loops, several cursors at once; anchors
// such as { pos: { x, line } } or { barline } are positions on this photo), and the hand-off
// to StaffInk for editing the recognised music with a pen.
let IR = null;
async function loadIR() {
  if (!IR) {
    const [ss, si, pb] = await Promise.all([import('../notation-ir/adapters/scoreshift.js'), import('../notation-ir/adapters/staffink.js'), import('../notation-ir/playback.js')]);
    IR = { ...ss, toStaffInk: si.toStaffInk, ...pb };
  }
  return IR;
}
async function toIR() { const { fromScoreShift } = await loadIR(); return fromScoreShift(S.model, S.score, { ...musicOpts(), title: S.name }); }
/**
 * Play a program over this page. keep (default) makes it the page's program, saved with the
 * project; with no program, plays the page's own (its markers, see below). Markers whose note
 * was deleted by a correction are reported and nothing plays. The metronome and speed work as
 * for ordinary playback.
 */
async function playProgram(program, { keep = true } = {}) {
  if (!S.model) return null;
  const { perform, checkProgram, clicksFor } = await loadIR();
  const { score, byId } = await toIR();
  if (program && keep) { S.programs.set(pageNo(), program); saveProgram(); }
  if (!program) program = S.programs.get(pageNo()) || {};
  if (program.arrangement) program = compileArrangement(program.arrangement, { beat: beatUnit(score) });
  if (keep) refreshMarkers();
  const full = { tempo: S.tempo, root: { walk: {} }, ...program };
  const lost = checkProgram(score, full);
  if (lost.length) {
    const names = lostNames(full, lost);
    setStatus(`<b>${lost.length} playback marker${lost.length > 1 ? 's' : ''} lost ${lost.length > 1 ? 'their' : 'its'} note</b> (deleted by a correction; drawn red on the page, tap it to fix): ${names.join(', ')}`);
    return { lost };
  }
  const p = perform(score, full);
  if (!p.notes.length) { setStatus('<b>Nothing to play there</b>'); return p; }
  $('play').textContent = '■ Stop'; $('play').setAttribute('aria-pressed', 'true');
  player.speed = S.speed; player.metronome = S.metro;
  let last = '';
  S.surf = surfaceFor({ score, byId });
  const map = headMaps(S.surf, irItems(score, 1));
  player.playPerformance(p, (on, now) => {
    const key = [...on].join();
    if (key !== last) { last = key; redrawPlay([...on].map((id) => byId.get(id)).filter(Boolean)); }
    S.heads = headsAt(p, now, (f, at) => (f === 'main' ? map(at) : null), MK);
    drawHeads();
  }, undefined, { clicks: clicksFor(score, p) });
  return p;
}
function lostNames(full, lost) {
  const arr = S.programs.get(pageNo())?.arrangement;
  if (arr) {
    const ids = (l) => (l.anchor.events || [l.anchor.event]).filter(Boolean);
    return [...new Set(lost.map((l) => { const m = [...arr.clips, ...arr.jumps].find((x) => ids(l).some((id) => id === x.from || id === x.to)); return m ? m.name || 'a jump' : l.path; }))];
  }
  const { clips, jumps } = markersOf(full);
  return [...new Set(lost.map((l) => [...clips, ...jumps].find((m) => l.path.startsWith(m.path || m.id) || l.path.startsWith(m.id))?.name || l.path))];
}
const beatUnit = (score) => score.directions.find((d) => d.kind === 'meter')?.unit || 4;

// ---------- playback markers on the photo (shared notation-ir markers + arrangement) ----------
// The page's program is either an arrangement the user built here (clips, jumps; stored as
// { arrangement }) or a program set from code. Clips are brackets over the staff, jumps
// arrows; a marker whose note a correction deleted is drawn red and dashed where the note was
// (its page-keyed id says where), and tapping it offers to re-attach it.
//
// ✂ Markers mode: tap a bar to select it, Shift+tap or "Extend" to grow the selection, drag
// across notes with a mouse; then play or loop just that passage (speed and metronome apply),
// keep it as a clip, or add a jump from its end to a note you tap.
const MKS = { on: false, range: null, loop: false, sel: null, pick: null, extend: false, irc: null, drag: null, hold: null, swallowUntil: 0 };
let MK = null, mkSeq = 0;
const arrOf = () => S.programs.get(pageNo())?.arrangement || null;
function ensureArr() {
  let p = S.programs.get(pageNo());
  if (!p?.arrangement) { p = { arrangement: { ...emptyArrangement(), mode: 'page' } }; S.programs.set(pageNo(), p); }
  return p.arrangement;
}
function saveProgram() { if (S.source) idb.put(`${editKey()}:prog`, S.programs.get(pageNo()) ? { program: S.programs.get(pageNo()), saved: Date.now() } : null); }
function changed() { saveProgram(); arrUi(); refreshMarkers(); }

async function refreshMarkers() {
  const prog = S.programs.get(pageNo()), seq = ++mkSeq;
  if ((!prog && !MKS.on) || !S.model) { MKS.irc = null; if (MK) { MK = null; redrawPlay(S.sounding); } arrUi(); return; }
  const irc = await toIR();
  if (seq !== mkSeq) return; // a newer refresh is on its way
  MKS.irc = irc;
  const surf = (S.surf = surfaceFor(irc));
  MK = prog ? layoutMarkersOn(surf, prog.arrangement ? arrangementMarkers(prog.arrangement) : markersOf(prog)) : null;
  if (MK && !MK.items.length) MK = null;
  if (MKS.range && !rangeNow()) MKS.range = null;
  redrawPlay(S.sounding);
  arrUi();
  if (MK?.lost.length && !/marker/.test($('status').textContent)) setStatus($('status').innerHTML + ` · <b class="bad">${MK.lost.length} playback marker${MK.lost.length > 1 ? 's' : ''} lost ${MK.lost.length > 1 ? 'their' : 'its'} note</b> (red: tap it to fix)`);
}
// markers are sized by the staff space, but never smaller on screen than ~15 CSS px a space
const mkView = () => { const r = S.rend.r; return { X: (x) => x * r, Y: (y) => y * r, sp: Math.max((S.model.space || 16) * r, (15 * devicePixelRatio) / S.zoom) }; };
function drawProgramMarkers() {
  if (!S.rend || !S.model) return;
  const R = rangeNow();
  if (!S.surf) return;
  if (R) drawBands(octx, S.surf, selectionBands(S.surf, R.ids), { pad: 1.6, fill: 'rgba(37,99,235,0.16)', edge: 'rgba(37,99,235,0.9)' });
  if (MK) drawMarkersOn(octx, S.surf, MK, { selected: MKS.sel });
}

// --- picking things on the photo
function imgAt(e) { const rect = cv.getBoundingClientRect(), k = (S.rend.r / devicePixelRatio) * S.zoom; return { x: (e.clientX - rect.left) / k, y: (e.clientY - rect.top) / k }; }
/** The event (IR id) under a photo point, through the page surface. */
const pickEvent = (pt, reach) => (S.surf && MKS.irc ? S.surf.eventAt(pt, reach) : null);
const rangeNow = () => (MKS.range && MKS.irc ? rangeOfIR(MKS.irc.score, MKS.range.a, MKS.range.b) : null);
function setRange(a, b) { MKS.range = { a, b }; MKS.sel = null; redrawPlay(S.sounding); }
/** Grow the selection to include ids too (like Shift+click in a text editor). */
function extendRange(ids) {
  const sc = MKS.irc.score, R = rangeNow(), all = [...ids, ...(R ? [R.first, R.last] : [])].map((id) => findById(sc, 'event', id)).filter(Boolean);
  const on = (e) => e.onset.n / e.onset.d, end = (e) => on(e) + e.dur.n / e.dur.d;
  setRange(all.reduce((a, e) => (on(e) < on(a) ? e : a)).id, all.reduce((a, e) => (end(e) > end(a) ? e : a)).id);
}
function clearRange() { if (!MKS.range) return; MKS.range = null; MKS.extend = false; redrawPlay(S.sounding); }

// --- popups
function rangePop(e) {
  const R = rangeNow(); if (!R) { hidePop(); return; }
  const bar = (id) => MKS.irc.byId.get(id)?.m.number, b0 = bar(R.first), b1 = bar(R.last);
  showPop(`<h3>${b0 === b1 ? `Bar ${b0}` : `Bars ${b0}–${b1}`} · ${R.n} note${R.n === 1 ? '' : 's'}</h3>
    <div class="row"><button id="rPlay">▶ Play</button><button id="rLoop" aria-pressed="${MKS.loop}">⟳ Loop</button><button id="rExt" aria-pressed="${MKS.extend}" title="Tap another bar to extend the selection to it">⇢ Extend</button></div>
    <div class="row"><button id="rClip" title="Keep this passage as a clip marker">＋ Clip</button><button id="rJump" title="After this passage, continue at a note you tap">⤳ Jump</button><button id="rX">✕</button></div>
    <p class="hint">Speed and metronome apply. Shift+tap a bar (or Extend) grows the selection; or drag across notes (with a finger: hold, then drag).</p>`, e);
  $('rPlay').onclick = () => { playRange(); };
  $('rLoop').onclick = () => { MKS.loop = !MKS.loop; $('rLoop').setAttribute('aria-pressed', MKS.loop); };
  $('rExt').onclick = () => { MKS.extend = !MKS.extend; $('rExt').setAttribute('aria-pressed', MKS.extend); };
  $('rClip').onclick = () => { const c = addClip(ensureArr(), rangeNow()); MKS.sel = c.id; clearRange(); hidePop(); changed(); setStatus(`<b>Clip ${c.name}</b> kept · tap its label to loop or layer it`); };
  $('rJump').onclick = () => { MKS.pick = { kind: 'jump', from: rangeNow().last }; clearRange(); hidePop(); setStatus('<b>Tap the note to jump to</b> (Esc cancels)'); };
  $('rX').onclick = () => { clearRange(); hidePop(); };
}
function playRange() {
  const R = rangeNow(); if (!R) return;
  if (player.playing) player.stop();
  playProgram(compileArrangement(null, { range: R, loop: MKS.loop ? 64 : 1 }), { keep: false });
}
function markerPop(id, e) {
  MKS.sel = id; redrawPlay(S.sounding); arrUi();
  const arr = arrOf(), m = markerById(arr, id), item = MK?.items.find((x) => x.id === id);
  if (!m) { // a marker from a program set in code: show what it is, offer to remove the program
    showPop(`<h3>${item?.label || 'Marker'}</h3><p class="hint">Set from a program; remove the page's program to clear it.</p><div class="row"><button id="mClear">Remove the program</button><button id="mX">Close</button></div>`, e);
    $('mClear').onclick = () => { S.programs.delete(pageNo()); MKS.sel = null; hidePop(); changed(); };
    $('mX').onclick = () => { MKS.sel = null; hidePop(); redrawPlay(S.sounding); };
    return;
  }
  const isClip = 'loop' in m, lost = item?.lost, name = isClip ? `Clip ${m.name}` : 'Jump';
  const lostRows = lost ? `<p class="hint" style="color:#c92a2a"><b>${name} lost ${isClip ? 'a note' : 'its note'}</b>: a correction deleted it.</p>
    <div class="row"><button id="mNear">Attach to the nearest note</button><button id="mPick">Pick a note…</button></div>` : '';
  const body = isClip
    ? `<div class="row"><button id="mPlay">▶</button><span>repeat</span><button id="mL-">−</button><b>×${m.loop}</b><button id="mL+">+</button></div>
       <div class="row"><span>octave</span><button id="mT-">8vb</button><b>${m.transpose ? (m.transpose > 0 ? '+' : '') + m.transpose : '±0'}</b><button id="mT+">8va</button>
       <span>delay</span><button id="mD-">−</button><b>${m.delay || 0}</b><button id="mD+">+</button></div>
       <div class="row">${arr.clips[0] === m ? '' : `<button id="mW" aria-pressed="${!!m.withPrev}" title="Play together with the clip before it">⧉ with previous</button>`}
       ${arr.clips.length > 1 ? `<button id="mO-" ${arr.clips[0] === m ? 'disabled' : ''} title="Play this clip earlier">⇠ earlier</button><button id="mO+" ${arr.clips.at(-1) === m ? 'disabled' : ''} title="Play this clip later">later ⇢</button>` : ''}</div>`
    : `<div class="row"><span>taken</span><button id="mJ-">−</button><b>×${m.times}</b><button id="mJ+">+</button></div>`;
  showPop(`<h3>${name}</h3>${lostRows}${body}<div class="row"><button id="mDel">✕ Remove</button><button id="mX">Close</button></div>`, e);
  const edit = (fn) => () => { fn(markerById(arrOf(), id)); changed(); markerPop(id, e); };
  const on = (bid, fn) => { const b = $(bid); if (b) b.onclick = fn; };
  on('mL-', edit((x) => { x.loop = Math.max(1, x.loop - 1); }));
  on('mL+', edit((x) => { x.loop = Math.min(64, x.loop + 1); }));
  on('mT-', edit((x) => { x.transpose = (x.transpose || 0) - 12; }));
  on('mT+', edit((x) => { x.transpose = (x.transpose || 0) + 12; }));
  on('mD-', edit((x) => { x.delay = Math.max(0, (x.delay || 0) - 1); }));
  on('mD+', edit((x) => { x.delay = (x.delay || 0) + 1; }));
  on('mJ-', edit((x) => { x.times = Math.max(1, x.times - 1); }));
  on('mJ+', edit((x) => { x.times = Math.min(16, x.times + 1); }));
  on('mW', edit((x) => { x.withPrev = !x.withPrev; if (x.withPrev) arrOf().mode = 'clips'; }));
  on('mO-', edit((x) => { moveClip(arrOf(), x.id, arrOf().clips.indexOf(x) - 1); }));
  on('mO+', edit((x) => { moveClip(arrOf(), x.id, arrOf().clips.indexOf(x) + 1); }));
  on('mPlay', () => { if (player.playing) player.stop(); playProgram(compileArrangement({ ...emptyArrangement(), mode: 'clips', clips: [{ ...m, withPrev: false }] }, { beat: beatUnit(MKS.irc.score) }), { keep: false }); });
  on('mNear', edit((x) => { reattach(x, null); }));
  on('mPick', () => { MKS.pick = { kind: 'repair', id }; hidePop(); setStatus(`<b>Tap the note ${name} should use</b> (Esc cancels)`); });
  on('mDel', () => { removeMarker(arrOf(), id); MKS.sel = null; hidePop(); changed(); });
  on('mX', () => { MKS.sel = null; hidePop(); redrawPlay(S.sounding); arrUi(); });
}
/** Re-attach a marker's lost ends: to `to` (an IR event id), or each to the nearest note on its staff. */
function reattach(m, to) {
  const sc = MKS.irc.score;
  for (const k of ['from', 'to']) {
    if (findById(sc, 'event', m[k])) continue;
    if (to) { m[k] = to; continue; }
    const pk = parsePageId(m[k]); if (!pk) continue;
    let best = null, bd = Infinity;
    for (const e of sc.events) if (e.src.line === pk.line) { const d = Math.abs(e.src.x - pk.q * sc.pageIds.unit); if (d < bd) { bd = d; best = e; } }
    if (best) m[k] = best.id;
  }
}

// --- arrangement switch in the transport: what Play plays when the page has markers
function arrUi() {
  const arr = arrOf(), box = $('arrMode');
  $('markMode').setAttribute('aria-pressed', MKS.on);
  if (!hasMarkers(arr)) { box.hidden = true; return; }
  box.hidden = false;
  box.querySelectorAll('[data-am]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.am === (arr.mode || 'page')));
  box.querySelector('[data-am=clips]').textContent = arr.clips.length ? 'clips' : 'clips –';
  box.querySelector('[data-am=score]').textContent = `page + jumps${arr.jumps.length ? ` (${arr.jumps.length})` : ''}`;
  // the clips in playing order: tap to edit, drag sideways to reorder
  renderClipOrder($('clipOrder'), arr, {
    selected: MKS.sel,
    onSelect: (id) => { const c = $('clipOrder').querySelector(`[data-clip="${id}"]`).getBoundingClientRect(); markerPop(id, { clientX: c.left + c.width / 2, clientY: c.bottom }); },
    onMove: (id, to) => { moveClip(arrOf(), id, to); changed(); setStatus(`<b>Clip order</b> ${arrOf().clips.map((c) => c.name).join(' ')}`); },
  });
}
$('arrMode').addEventListener('click', (e) => { const b = e.target.closest('[data-am]'); if (!b || !arrOf()) return; arrOf().mode = b.dataset.am; changed(); });
$('markMode').onclick = () => {
  MKS.on = !MKS.on; MKS.pick = null; MKS.extend = false; if (!MKS.on) clearRange();
  hidePop(); refreshMarkers();
  setStatus(MKS.on ? '<b>Markers</b>: tap a bar to select it (Shift+tap or Extend grows it); or drag across notes, with a finger hold first. Then play or loop it, keep it as a clip or add a jump. Tap a marker to change it.' : 'Markers off: tap notes to correct them');
};

// --- pointer: mouse drag selects across notes in Markers mode
$('stage').addEventListener('pointerdown', (e) => {
  if (!MKS.on || !S.model || e.pointerType === 'touch' || e.button !== 0 || MKS.pick) return;
  const pt = imgAt(e);
  if (hitMarkerOn(S.surf, MK, pt)) return;
  const ev = pickEvent(pt); if (ev) MKS.drag = { a: ev, x: e.clientX, y: e.clientY, moved: false };
});
window.addEventListener('pointermove', (e) => {
  const d = MKS.drag; if (!d) return;
  if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return;
  d.moved = true;
  const ev = pickEvent(imgAt(e), 6); if (ev && (!MKS.range || MKS.range.b !== ev || MKS.range.a !== d.a)) { setRange(d.a, ev); hidePop(); }
});
window.addEventListener('pointerup', (e) => {
  const d = MKS.drag; MKS.drag = null;
  if (d?.moved) { MKS.swallowUntil = performance.now() + 500; rangePop(e); }
});
// --- fingers: hold still for a moment, then drag to select (a quick swipe still scrolls)
const HOLD_MS = 380;
function cancelHold() { if (MKS.hold) clearTimeout(MKS.hold.timer); MKS.hold = null; }
$('stage').addEventListener('touchstart', (e) => {
  cancelHold();
  if (!MKS.on || !S.model || MKS.pick || e.touches.length !== 1) return;
  const t = e.touches[0], pt = imgAt(t);
  if (hitMarkerOn(S.surf, MK, pt)) return; // a tap on a marker
  const ev = pickEvent(pt); if (!ev) return;
  const h = (MKS.hold = { x: t.clientX, y: t.clientY, a: ev, on: false, last: t });
  h.timer = setTimeout(() => { h.on = true; hidePop(); setRange(ev, ev); navigator.vibrate?.(12); }, HOLD_MS);
}, { passive: true });
$('stage').addEventListener('touchmove', (e) => {
  const h = MKS.hold; if (!h) return;
  const t = e.touches[0]; h.last = t;
  if (!h.on) { if (Math.hypot(t.clientX - h.x, t.clientY - h.y) > 10) cancelHold(); return; } // moved first: a scroll
  e.preventDefault(); // selecting: hold the page still
  const ev = pickEvent(imgAt(t), 6);
  if (ev && (!MKS.range || MKS.range.b !== ev)) setRange(h.a, ev);
  const w = $('wrap'), wr = w.getBoundingClientRect(); // near an edge: scroll on
  if (t.clientY > wr.bottom - 40) w.scrollTop += 10; else if (t.clientY < wr.top + 40) w.scrollTop -= 10;
}, { passive: false });
$('stage').addEventListener('touchend', () => {
  const h = MKS.hold; cancelHold();
  if (h?.on) { MKS.swallowUntil = performance.now() + 600; rangePop({ clientX: h.last.clientX, clientY: h.last.clientY }); }
});
$('stage').addEventListener('touchcancel', cancelHold);
$('stage').addEventListener('contextmenu', (e) => { if (MKS.on) e.preventDefault(); }); // a long press is a selection here

/** Taps in Markers mode, and on markers / pending picks in any mode. true = handled. */
function markerTap(e) {
  if (performance.now() < MKS.swallowUntil) return true; // the click that ends a drag-select
  const pt = imgAt(e);
  if (MKS.pick) {
    const ev = pickEvent(pt, 5), pick = MKS.pick; MKS.pick = null;
    if (!ev) { setStatus('Cancelled: no note there'); return true; }
    if (pick.kind === 'jump') { const j = addJump(ensureArr(), pick.from, ev); if ((arrOf().mode || 'page') === 'page') arrOf().mode = 'score'; MKS.sel = j.id; changed(); setStatus('<b>Jump added</b> · Play now takes it (page + jumps)'); }
    else { const m = markerById(arrOf(), pick.id); if (m) { reattach(m, ev); changed(); setStatus('<b>Marker re-attached</b>'); } }
    return true;
  }
  const mk = hitMarkerOn(S.surf, MK, pt);
  if (mk) { markerPop(mk.id, e); return true; }
  if (!MKS.on) return false;
  const bar = S.surf?.barAt(pt);
  if (!bar) { clearRange(); hidePop(); return true; }
  if ((e.shiftKey || MKS.extend) && MKS.range) extendRange([bar.first, bar.last]); else setRange(bar.first, bar.last);
  MKS.extend = false; rangePop(e);
  return true;
}

/** The music as shown (as written or transposed) into StaffInk, in a new tab. */
async function editInStaffInk({ open = true } = {}) {
  if (!S.model) return null;
  const { toStaffInk } = await loadIR();
  const { score, skipped } = await toIR();
  const { score: si, report } = toStaffInk(score, { tempo: S.tempo });
  si.title = `${S.name}${S.view === 'transposed' ? ` (${instrument(S.to).name.split(' (')[0]})` : ''}`;
  report.grace = skipped;
  try { localStorage.setItem('staffink.import', JSON.stringify({ score: si, report, from: 'ScoreShift', at: Date.now() })); } catch (e) { alert('Could not hand the music over: ' + e.message); return null; }
  if (open) window.open(new URL('../staffink/?import&nohelp', location.href).href, '_blank');
  return { score: si, report };
}
$('editInk').onclick = () => editInStaffInk();

function onPlayStop() { S.heads = []; drawHeads(); S.sounding = null; $('play').textContent = '▶ Play'; $('play').setAttribute('aria-pressed', 'false'); update(); }
player.onStop = onPlayStop;
const download = (data, type, name) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); };
const exportName = (ext) => `${S.name}${S.pdf ? `-p${S.pdf.page}` : ''}-${S.view === 'transposed' ? S.to : 'as-written'}.${ext}`;
$('xml').onclick = () => { if (!S.model) return; const o = musicOpts(); download(toMusicXML(S.model, S.score, { ...o, title: S.name }), 'application/vnd.recordare.musicxml+xml', exportName('musicxml')); };
$('saveProject').onclick = () => saveProject();
$('midi').onclick = () => { if (!S.model) return; download(toMidi(S.model, S.score, { ...musicOpts(), title: S.name }), 'audio/midi', exportName('mid')); };
function fitZoom() {
  const w = $('wrap').clientWidth - 4;
  S.zoom = Math.max(0.25, Math.min(2, w / (S.rend.W / devicePixelRatio)));
  $('zoom').value = S.zoom;
}
function layoutStage() {
  if (!S.rend) return;
  const w = (S.rend.W / devicePixelRatio) * S.zoom, h = (S.rend.H / devicePixelRatio) * S.zoom;
  for (const c of [cv, ov, ph]) { c.style.width = w + 'px'; c.style.height = h + 'px'; }
  $('stage').style.width = w + 'px'; $('stage').style.height = h + 'px';
  chips();
}
const toScreen = (x, y) => { const k = (S.rend.r / devicePixelRatio) * S.zoom; return [x * k, y * k]; };
function chips() {
  document.querySelectorAll('.chip').forEach((c) => c.remove());
  if (!S.model || S.view !== 'interpreted') return;
  S.model.staves.forEach((st, i) => {
    const b = document.createElement('button'); b.className = 'chip';
    const [x, y] = toScreen(st.x0, lineY(st, 0, st.x0) - 6);
    b.style.left = x + 'px'; b.style.top = y + 'px';
    b.textContent = `${{ treble: '𝄞', bass: '𝄢', alto: '𝄡', tenor: '𝄡', treble8vb: '𝄞₈' }[st.clef.type]} ${keyName(st.key.fifths)}`;
    b.setAttribute('aria-label', `Staff ${i + 1}: ${st.clef.type} clef, ${keyName(st.key.fifths)}. Change`);
    b.onclick = (e) => { e.stopPropagation(); staffPop(st, e); };
    $('stage').appendChild(b);
  });
}

// ---------- corrections ----------
const pop = $('pop');
function hidePop() { pop.style.display = 'none'; S.sel = null; S.selM = null; }
function showPop(html, e) {
  pop.innerHTML = html; pop.style.display = 'block';
  const r = pop.getBoundingClientRect();
  pop.style.left = Math.min(innerWidth - r.width - 8, Math.max(8, e.clientX - r.width / 2)) + 'px';
  pop.style.top = Math.min(innerHeight - r.height - 8, e.clientY + 14) + 'px';
  pop.querySelector('button, select')?.focus();
}
function staffPop(st, e) {
  const opts = (sel) => Object.keys(CLEFS).map((c) => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join('');
  const keys = [...Array(15)].map((_, i) => i - 7).map((f) => `<option value="${f}" ${f === st.key.fifths ? 'selected' : ''}>${keyName(f)} (${f > 0 ? f + '♯' : f < 0 ? -f + '♭' : 'none'})</option>`).join('');
  showPop(`<h3>Staff ${st.index + 1}</h3>
    <div class="row"><label>Clef <select id="pClef">${opts(st.clef.type)}</select></label></div>
    <div class="row"><label>Key <select id="pKey">${keys}</select></label></div>
    ${keyChangeRows(st)}
    <div class="row"><label><input type="checkbox" id="pAll" checked> all staves</label><button id="pOk">Apply</button><button id="pX">Close</button></div>
    <p style="margin:.3rem 0 0;color:#5d6b78;font-size:.82rem">Detected: ${st.clef.detected || 'no clef'}, ${keyName(st.key.detected)}${(st.keyChanges || []).length ? ', ' + st.keyChanges.map((k) => `→ ${keyName(k.detected)}`).join(' ') : ''}</p>`, e);
  $('pOk').onclick = () => {
    const targets = $('pAll').checked ? S.model.staves : [st];
    for (const t of targets) { t.clef.type = $('pClef').value; t.key.fifths = +$('pKey').value; }
    readKeyChanges(st);
    for (const t of new Set([...targets, st])) interpret(t);
    markEdited();
    hidePop(); update();
  };
  $('pX').onclick = () => { hidePop(); update(); };
}
// Key changes inside a staff: one row per change found (its key, or "none" to remove it), and
// a row to add one after any barline that has none. Keys are written as the page writes them;
// the transposed page redraws each change for the target instrument.
function keyChangeRows(st) {
  const keyOpts = (sel, none) => (none ? `<option value="none">${none}</option>` : '') + [...Array(15)].map((_, i) => i - 7).map((f) => `<option value="${f}" ${f === sel ? 'selected' : ''}>${keyName(f)}</option>`).join('');
  const rows = (st.keyChanges || []).map((k, i) => `<div class="row"><label>Key change after bar ${st.bars.findIndex((b) => b.x === k.x) + 1} <select data-kc="${i}">${keyOpts(k.fifths, 'none (remove)')}</select></label></div>`);
  const free = st.bars.map((b, i) => ({ b, i })).filter(({ b }) => b.x < st.x1 - 3 * S.model.space && !(st.keyChanges || []).some((k) => k.x === b.x));
  if (free.length) rows.push(`<div class="row"><label>Add key change after bar <select id="pKcBar"><option value="">–</option>${free.map(({ b, i }) => `<option value="${b.x}">${i + 1}</option>`).join('')}</select></label>
    <select id="pKcKey" aria-label="Key of the added change">${keyOpts(st.key.fifths)}</select></div>`);
  return rows.join('');
}
function readKeyChanges(st) {
  const kcs = st.keyChanges || (st.keyChanges = []);
  pop.querySelectorAll('[data-kc]').forEach((sel) => { const k = kcs[+sel.dataset.kc]; if (sel.value === 'none') k.removed = true; else k.fifths = +sel.value; });
  for (let i = kcs.length - 1; i >= 0; i--) if (kcs[i].removed) kcs.splice(i, 1); // its glyphs stay on the page as they are
  const bx = $('pKcBar')?.value;
  if (bx) {
    const b = st.bars.find((q) => q.x === +bx), x0 = b.x1 + 0.5 * S.model.space;
    // added by hand: there is nothing on the page to erase, so the transposed page draws it
    // after the barline only if the target key differs
    kcs.push({ x: b.x, x0, x1: x0, detected: null, fifths: +$('pKcKey').value, from: null, ids: [], glyphs: [], manual: true });
    kcs.sort((a, c) => a.x - c.x);
  }
  let cur = st.key.fifths; for (const k of kcs) { k.from = cur; cur = k.fifths; }
}
// ---------- rhythm corrections ----------
// A correction is stored on the analysis objects (note.fix on every head of the chord, rest.fix,
// st.timeFix) and the score is rebuilt from them, so it survives re-reading the bars.
function eventOf(n) { for (const m of S.score.measures) for (const e of m.events) if (e.notes && e.notes.includes(n)) return e; return null; }
function measureOf(e) { return S.score.measures.find((m) => m.events.includes(e)); }
const DURS = [1, 2, 4, 8, 16, 32];
function rhythmRow(ev) {
  if (!ev) return '';
  const m = measureOf(ev);
  return `<div class="row" role="group" aria-label="Note value">${DURS.map((d) => `<button data-dur="${d}" aria-pressed="${ev.dur === d}" aria-label="${['whole', 'half', 'quarter', 'eighth', 'sixteenth', 'thirty-second'][DURS.indexOf(d)]}">${DUR_GLYPH[d]}</button>`).join('')}</div>
    <div class="row"><button data-r="dot" aria-pressed="${!!ev.dots}">dot</button><button data-r="tuplet" aria-pressed="${!!ev.tuplet}">triplet</button>${ev.kind === 'note' ? `<button data-r="tie" aria-pressed="${!!ev.tie}">tie →</button><button data-r="grace" aria-pressed="${!!ev.grace}">grace</button>${ev.grace ? `<button data-r="gkind" aria-pressed="${(ev.notes[0].fix?.graceKind ?? ev.notes[0].graceKind) !== 'app'}" title="slashed: crushed in before the beat; unslashed: half the next note, on the beat">slashed (acciaccatura)</button>` : ''}` : ''}</div>
    ${ev.kind === 'note' ? `<div class="row" role="group" aria-label="Articulation">${[['stacc', 'staccato ·'], ['ten', 'tenuto –'], ['acc', 'accent >'], ['dnbow', 'down-bow ⊓'], ['upbow', 'up-bow V']].map(([k, l]) => `<button data-art="${k}" aria-pressed="${(ev.notes[0].artic || []).includes(k)}">${l}</button>`).join('')}</div>` : ''}
    <p class="hint">Bar ${m.number}: ${m.ticks / 96} of ${m.cap / 96} beats${m.repairs.length ? ` · auto-fixed: ${m.repairs.join(', ')}` : ''}${ev.repaired ? ` (this ${ev.kind}: ${ev.repaired})` : ''}</p>`;
}
function setFix(ev, patch) {
  const cur = { dur: ev.dur, dots: ev.dots, tuplet: ev.tuplet, tie: ev.tie, grace: ev.grace, graceKind: ev.notes?.[0].fix?.graceKind };
  const f = { ...cur, ...patch };
  if (ev.kind === 'rest') { ev.rest.fix = f; delete ev.rest.fix.tie; delete ev.rest.fix.grace; }
  else for (const n of ev.notes) n.fix = f;
  markEdited();
}
function bindRhythm(ev, reopen) {
  if (!ev) return;
  const redo = (patch) => { setFix(ev, patch); update(); reopen(); };
  pop.querySelectorAll('[data-dur]').forEach((b) => (b.onclick = () => redo({ dur: +b.dataset.dur })));
  pop.querySelectorAll('[data-art]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.art, on = !(ev.notes[0].artic || []).includes(k), other = { upbow: 'dnbow', dnbow: 'upbow' }[k];
    for (const n of ev.notes) n.artic = on ? [...new Set([...(n.artic || []).filter((a) => a !== other), k])] : (n.artic || []).filter((a) => a !== k);
    markEdited(); update(); reopen();
  }));
  pop.querySelectorAll('[data-r]').forEach((b) => (b.onclick = () => {
    const k = b.dataset.r;
    if (k === 'dot') redo({ dots: ev.dots ? 0 : 1 });
    if (k === 'tuplet') {
      // a triplet is three notes: mark this one and its two neighbours of the same value
      const m = measureOf(ev), evs = m.events.filter((q) => !q.removed && !q.grace), i = evs.indexOf(ev);
      const on = !ev.tuplet;
      let win = [ev];
      if (on) { for (const a of [i - 1, i - 2, i + 1, i + 2].map((j) => evs[j])) if (a && win.length < 3 && !a.tuplet && Math.abs(evs.indexOf(a) - i) <= 2) win.push(a); }
      else win = ev.tg || [ev];
      for (const q of win) setFix(q, { tuplet: on ? [3, 2] : null });
      update(); reopen();
    }
    if (k === 'tie') redo({ tie: !ev.tie });
    if (k === 'grace') redo({ grace: !ev.grace });
    if (k === 'gkind') { const cur = ev.notes[0].fix?.graceKind ?? ev.notes[0].graceKind; redo({ graceKind: cur === 'app' ? 'acc' : 'app' }); }
  }));
}
function restPop(ev, e) {
  showPop(`<h3>Rest</h3>${rhythmRow(ev)}<div class="row"><button id="rDel">Not a rest</button><button id="rX">Close</button></div>`, e);
  bindRhythm(ev, () => { const ne = measureOf(ev) ? ev : findRest(ev.rest); if (ne) restPop(ne, e); });
  $('rDel').onclick = () => { ev.rest.deleted = true; markEdited(); hidePop(); update(); };
  $('rX').onclick = () => { hidePop(); update(); };
}
const findRest = (r) => { for (const m of S.score.measures) for (const e of m.events) if (e.rest === r) return e; return null; };
function measurePop(m, e) {
  S.selM = m; update();
  const t = m.time || { beats: 4, unit: 4 };
  const status = { ok: 'adds up', pickup: 'pickup (short on purpose)', end: 'last bar (short on purpose)', rest: 'whole-bar rest', under: 'too short: a note or rest is missing or misread', over: 'too long: a value is misread, or a note is not a note' }[m.status];
  showPop(`<h3>Bar ${m.number}</h3>
    <p class="hint">${m.ticks / 96} of ${m.cap / 96} beats: ${status}${m.repairs.length ? `<br>auto-fixed: ${m.repairs.join(', ')}` : ''}</p>
    <div class="row"><label>Time signature <input id="mB" type="number" min="1" max="32" value="${t.beats}" style="width:3.5rem"> / <select id="mU">${[1, 2, 4, 8, 16].map((u) => `<option ${u === t.unit ? 'selected' : ''}>${u}</option>`).join('')}</select></label></div>
    <div class="row"><button id="mOk">Set from this bar on</button><button id="mPlay">▶ from here</button><button id="mX">Close</button></div>`, e);
  $('mOk').onclick = () => {
    const st = m.st, k = S.score.measures.filter((q) => q.st === st).indexOf(m);
    st.timeFix = { ...(st.timeFix || {}), [k]: { beats: +$('mB').value, unit: +$('mU').value } };
    markEdited(); S.selM = null; hidePop(); update();
  };
  $('mPlay').onclick = () => { hidePop(); const bar = barStarts(S.score).out.find((q) => q.m === m); player.onStop = null; player.stop(); player.onStop = onPlayStop; startPlay(bar ? bar.tick : 0); };
  $('mX').onclick = () => { S.selM = null; hidePop(); update(); };
}
function notePop(n, e) {
  S.sel = n; update();
  const accLabel = { '-2': '𝄫', '-1': '♭', 0: '♮', 1: '♯', 2: '𝄪' };
  showPop(`<h3>${n.name} <small style="color:#5d6b78">(${n.kind})</small></h3>
    <div class="row"><button id="nUp" aria-label="Move up a step">▲</button><button id="nDn" aria-label="Move down a step">▼</button>
      ${[-1, 0, 1].map((t) => `<button data-acc="${t}" aria-pressed="${n.accid?.type === t}">${accLabel[t]}</button>`).join('')}
      <button data-acc="none" aria-pressed="${!n.accid}">no acc.</button></div>
    ${rhythmRow(eventOf(n))}
    <div class="row"><button id="nDel">Not a note</button><button id="nPlay" aria-label="Hear it">🔊</button><button id="nX">Close</button></div>`, e);
  bindRhythm(eventOf(n), () => notePop(n, e));
  $('nPlay').onclick = () => { const ev = eventOf(n); player.preview((ev ? ev.notes : [n]).map((q) => midiOf(q.pitch) + instrument(S.from).ds)); };
  const redo = () => { interpret(n.st); markEdited(); notePop(n, e); };
  $('nUp').onclick = () => { n.p++; n.y = yOfP(n.st, n.p, n.x); redo(); };
  $('nDn').onclick = () => { n.p--; n.y = yOfP(n.st, n.p, n.x); redo(); };
  pop.querySelectorAll('[data-acc]').forEach((b) => (b.onclick = () => {
    const v = b.dataset.acc; n.accid = v === 'none' ? null : { ...(n.accid || { ids: [], box: [n.box[0] - 12, n.y - 12, n.box[0] - 2, n.y + 12] }), type: +v }; redo();
  }));
  $('nDel').onclick = () => {
    const st = n.st; st.notes.splice(st.notes.indexOf(n), 1); S.model.notes.splice(S.model.notes.indexOf(n), 1);
    interpret(st); markEdited(); hidePop(); update();
  };
  $('nX').onclick = () => { hidePop(); update(); };
}
$('stage').addEventListener('click', (e) => {
  if (!S.model) return;
  if (markerTap(e)) return;
  const rect = cv.getBoundingClientRect(), k = (S.rend.r / devicePixelRatio) * S.zoom;
  const x = (e.clientX - rect.left) / k, y = (e.clientY - rect.top) / k;
  let best = null, bd = 14;
  for (const n of S.model.notes) {
    const nn = S.view === 'transposed' && S.plan ? S.plan.staves[n.st.index].notes.find((q) => q.n === n) : null;
    const ny = nn ? yOfP(n.st, nn.p, n.x) : n.y, d = Math.hypot(n.x - x, ny - y);
    if (d < bd) { bd = d; best = n; }
  }
  if (best) notePop(best, e);
  else if (S.view === 'interpreted') {
    const st = S.model.staves.find((s) => x < s.x0 + 5 * spaceAt(s, s.x0) && y > lineY(s, 0, s.x0) - 30 && y < lineY(s, 4, s.x0) + 30);
    if (st) { staffPop(st, e); return; }
    for (const m of S.score.measures) for (const ev of m.events) if (ev.kind === 'rest' && !ev.removed) { const b = ev.rest.box; if (x > b[0] - 6 && x < b[2] + 6 && y > b[1] - 6 && y < b[3] + 6) { restPop(ev, e); return; } }
    const m = S.score.measures.find((q) => x > q.x0 && x < q.x1 && y > lineY(q.st, 0, x) - 20 && y < lineY(q.st, 4, x) + 40);
    if (m) measurePop(m, e); else hidePop();
  }
  else hidePop();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { MKS.pick = null; MKS.sel = null; clearRange(); hidePop(); update(); }
  if (e.key === ' ' && e.target === document.body && S.model) { e.preventDefault(); $('play').click(); }
});
window.addEventListener('resize', () => S.rend && layoutStage());

$('export').onclick = () => {
  const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
  const g = c.getContext('2d'); g.drawImage(cv, 0, 0); if (S.view !== 'original') g.drawImage(ov, 0, 0);
  c.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${S.name}-${S.to}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }, 'image/png');
};

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
// test hook
window.__ss = { S, load, saveProject, idb, update, plan, openPage, exportPdf, player, setFix, eventOf, toMusicXML, toMidi, musicOpts, playProgram, editInStaffInk, toIR, markers: () => MK, refreshMarkers, heads: () => S.heads, MKS, rangeNow, markerTap, arrOf }; window.__yOfP = yOfP;

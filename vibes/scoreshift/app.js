// ScoreShift UI: load a photo, recognise in a worker, show original / interpretation /
// transposed page, let the user correct recognition, export.
import { INSTRUMENTS, keyName, CLEFS } from './theory.js';
import { interpret, yOfP, lineY, spaceAt } from './omr.js';
import { Renderer, plan, describe, drawOverlay } from './render.js';

const $ = (id) => document.getElementById(id);
const cv = $('cv'), ov = $('ov'), ctx = cv.getContext('2d'), octx = ov.getContext('2d');
const store = JSON.parse(localStorage.getItem('scoreshift') || '{}');
const S = { from: store.from || 'C', to: store.to || 'Bb-clarinet', octave: 'auto', clef: store.clef || 'auto', view: 'transposed', labels: !!store.labels, zoom: 1, model: null, rend: null, name: 'score', sel: null };
const save = () => localStorage.setItem('scoreshift', JSON.stringify({ from: S.from, to: S.to, clef: S.clef, labels: S.labels }));

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
function probe(src) {
  const run = async () => {
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(src, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data, gray = new Uint8Array(c.width * c.height);
    for (let i = 0; i < gray.length; i++) gray[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    return new Promise((res) => { worker.onmessage = (e) => res(e.data); worker.postMessage({ probe: true, gray, w: c.width, h: c.height }, [gray.buffer]); });
  };
  const p = job.then(run, run); job = p.catch(() => {});
  return p;
}
function show(model, img, name) {
  S.model = model; S.rend = new Renderer(img, model); S.name = name; S.octave = S.octave ?? 'auto';
  $('empty').hidden = true; $('stage').hidden = false; $('export').disabled = false;
  fitZoom(); update();
}
async function busy(fn, label = 'Reading the music…') {
  hidePop(); $('busy').firstElementChild.textContent = label; $('busy').style.display = 'grid';
  try { return await fn(); } finally { $('busy').style.display = 'none'; }
}
async function load(blob, name) {
  if (await isPdf(blob)) return loadPdf(blob, name);
  closePdf();
  await busy(async () => {
    try { const { model, img } = await recognise(blob); S.octave = 'auto'; show(model, img, (name || 'score').replace(/\.[^.]+$/, '')); }
    catch (e) { setStatus(`<b>Could not read this image:</b> ${e.message}. Try a flatter, sharper photo with the full staff width in frame.`); }
  });
}

// ---------- PDF (IMSLP etc.) ----------
const pdfMod = () => import('./pdfsource.js');
async function isPdf(blob) { return (await pdfMod()).isPdf(blob); }
function closePdf() { if (S.pdf) { const d = S.pdf.doc; S.pdf = null; (d.loadingTask?.destroy?.() ?? d.destroy?.())?.catch?.(() => {}); } $('pages').hidden = true; $('exportPdf').hidden = true; }
async function loadPdf(blob, name) {
  closePdf();
  await busy(async () => {
    try {
      const { openPdf } = await pdfMod();
      const doc = await openPdf(blob);
      S.pdf = { doc, name: (name || 'score').replace(/\.pdf$/i, ''), n: doc.numPages, page: 0, edited: new Map() };
      $('pages').hidden = false; $('exportPdf').hidden = false;
      buildThumbs();
      S.octave = 'auto';
      // IMSLP / Internet Archive files open with a cover, title page, preface: probe pages at low
      // resolution for staves (~0.3 s a page) and start at the first mostly covered by staves
      const { renderPage } = await pdfMod();
      let best = 1, most = 0;
      for (let k = 1; k <= Math.min(doc.numPages, 40); k++) {
        $('busy').firstElementChild.textContent = `Looking for music… page ${k}`;
        const { staves, cover } = await probe((await renderPage(doc, k, 1400)).canvas);
        if (staves > most) { most = staves; best = k; }
        if (staves >= 3 && cover >= 0.4) { best = k; break; }
      }
      await openPage(best);
    } catch (e) { closePdf(); setStatus(`<b>Could not open this PDF:</b> ${e.message}`); }
  }, 'Opening PDF…');
}
async function openPage(k, quiet = false) {
  const P = S.pdf; if (!P || k < 1 || k > P.n) return false;
  P.page = k; pageUi();
  if (P.edited.has(k)) { const e = P.edited.get(k); show(e.model, e.img, `${P.name}-p${k}`); return true; }
  const { renderPage } = await pdfMod();
  const { canvas } = await renderPage(P.doc, k);
  try {
    const { model, img } = await recognise(canvas);
    if (P !== S.pdf) return false;
    show(model, img, `${P.name}-p${k}`);
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
const markEdited = () => { if (S.pdf && S.model) S.pdf.edited.set(S.pdf.page, { model: S.model, img: S.rend.img }); };
function pageUi() {
  const P = S.pdf; if (!P) return;
  $('pageNo').textContent = `${P.page} / ${P.n}`;
  $('prevPage').disabled = P.page <= 1; $('nextPage').disabled = P.page >= P.n;
  document.querySelectorAll('#thumbs button').forEach((b) => b.setAttribute('aria-current', +b.dataset.page === P.page ? 'page' : 'false'));
  document.querySelector(`#thumbs button[data-page="${P.page}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function buildThumbs() {
  const strip = $('thumbs'), P = S.pdf; strip.innerHTML = '';
  let queue = Promise.resolve();
  const io = new IntersectionObserver((ents) => ents.forEach((en) => {
    if (!en.isIntersecting) return; io.unobserve(en.target);
    const b = en.target;
    queue = queue.then(async () => {
      if (P !== S.pdf) return;
      const { renderPage } = await pdfMod();
      const { canvas } = await renderPage(P.doc, +b.dataset.page, 160);
      canvas.setAttribute('aria-hidden', 'true'); b.prepend(canvas);
    }).catch(() => {});
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
async function exportPdf() {
  const P = S.pdf; if (!P) return;
  const { renderPage, writePdf } = await pdfMod();
  const pages = [], opts = { from: S.from, to: S.to, octave: S.octave, clef: S.clef };
  const jpeg = (c) => new Promise((res) => c.toBlob(async (b) => res(new Uint8Array(await b.arrayBuffer())), 'image/jpeg', 0.8));
  for (let k = 1; k <= P.n; k++) {
    $('busy').firstElementChild.textContent = `Transposing page ${k} of ${P.n}…`;
    const { canvas, widthPt, heightPt } = await renderPage(P.doc, k, 2400);
    let out = canvas;
    try {
      const { model, img } = P.edited.get(k) || (k === P.page && S.model ? { model: S.model, img: S.rend.img } : await recognise(canvas));
      const r = new Renderer(img, model), c = document.createElement('canvas');
      r.render(c.getContext('2d'), plan(model, opts));
      out = c;
    } catch (e) { /* no music here: original page */ }
    pages.push({ jpeg: await jpeg(out), w: out.width, h: out.height, widthPt, heightPt });
  }
  const bytes = writePdf(pages);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  a.download = `${P.name}-${S.to}.pdf`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return bytes.length;
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
  const R = S.rend;
  if (S.view === 'transposed') R.render(ctx, pl);
  else { cv.width = R.W; cv.height = R.H; ctx.drawImage(R.src, 0, 0); }
  ov.width = R.W; ov.height = R.H; octx.clearRect(0, 0, R.W, R.H);
  if (S.view === 'interpreted') drawOverlay(octx, m, R.r, null, 'original', S.sel);
  else if (S.labels && S.view === 'transposed') drawOverlay(octx, m, R.r, pl, 'transposed', S.sel);
  else if (S.labels) drawOverlay(octx, m, R.r, null, 'original', S.sel);
  chips();
  layoutStage();
  const n = m.notes.length, octs = [...new Set(pl.staves.map((p) => p.octave))], oc = octs.length === 1 && octs[0] ? ` · ${octs[0] > 0 ? '+' : ''}${octs[0]} oct${pl.octave === 'auto' ? ' (auto)' : ''}` : octs.length > 1 ? ' · octave per staff (auto)' : '';
  setStatus(`${S.pdf ? `Page ${S.pdf.page} of ${S.pdf.n} · ` : ''}<b>${m.staves.length}</b> staves · <b>${n}</b> notes · ${describe(m, pl)}${oc} · read in ${Math.round(m.ms)} ms${S.view === 'interpreted' ? ' · tap a note or a staff label to correct it' : ''}`);
}
function fitZoom() {
  const w = $('wrap').clientWidth - 4;
  S.zoom = Math.max(0.25, Math.min(2, w / (S.rend.W / devicePixelRatio)));
  $('zoom').value = S.zoom;
}
function layoutStage() {
  if (!S.rend) return;
  const w = (S.rend.W / devicePixelRatio) * S.zoom, h = (S.rend.H / devicePixelRatio) * S.zoom;
  for (const c of [cv, ov]) { c.style.width = w + 'px'; c.style.height = h + 'px'; }
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
function hidePop() { pop.style.display = 'none'; S.sel = null; }
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
    <div class="row"><label><input type="checkbox" id="pAll" checked> all staves</label><button id="pOk">Apply</button><button id="pX">Close</button></div>
    <p style="margin:.3rem 0 0;color:#5d6b78;font-size:.82rem">Detected: ${st.clef.detected || 'no clef'}, ${keyName(st.key.detected)}</p>`, e);
  $('pOk').onclick = () => {
    const targets = $('pAll').checked ? S.model.staves : [st];
    for (const t of targets) { t.clef.type = $('pClef').value; t.key.fifths = +$('pKey').value; interpret(t); }
    markEdited();
    hidePop(); update();
  };
  $('pX').onclick = () => { hidePop(); update(); };
}
function notePop(n, e) {
  S.sel = n; update();
  const accLabel = { '-2': '𝄫', '-1': '♭', 0: '♮', 1: '♯', 2: '𝄪' };
  showPop(`<h3>${n.name} <small style="color:#5d6b78">(${n.kind})</small></h3>
    <div class="row"><button id="nUp" aria-label="Move up a step">▲</button><button id="nDn" aria-label="Move down a step">▼</button>
      ${[-1, 0, 1].map((t) => `<button data-acc="${t}" aria-pressed="${n.accid?.type === t}">${accLabel[t]}</button>`).join('')}
      <button data-acc="none" aria-pressed="${!n.accid}">no acc.</button></div>
    <div class="row"><button id="nDel">Not a note</button><button id="nX">Close</button></div>`, e);
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
  const rect = cv.getBoundingClientRect(), k = (S.rend.r / devicePixelRatio) * S.zoom;
  const x = (e.clientX - rect.left) / k, y = (e.clientY - rect.top) / k;
  let best = null, bd = 14;
  for (const n of S.model.notes) {
    const nn = S.view === 'transposed' && S.plan ? S.plan.staves[n.st.index].notes.find((q) => q.n === n) : null;
    const ny = nn ? yOfP(n.st, nn.p, n.x) : n.y, d = Math.hypot(n.x - x, ny - y);
    if (d < bd) { bd = d; best = n; }
  }
  if (best) notePop(best, e);
  else if (S.view === 'interpreted') { const st = S.model.staves.find((s) => x < s.x0 + 5 * spaceAt(s, s.x0) && y > lineY(s, 0, s.x0) - 30 && y < lineY(s, 4, s.x0) + 30); if (st) staffPop(st, e); else hidePop(); }
  else hidePop();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hidePop(); update(); } });
window.addEventListener('resize', () => S.rend && layoutStage());

$('export').onclick = () => {
  const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height;
  const g = c.getContext('2d'); g.drawImage(cv, 0, 0); if (S.view !== 'original') g.drawImage(ov, 0, 0);
  c.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${S.name}-${S.to}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }, 'image/png');
};

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
// test hook
window.__ss = { S, load, update, plan, openPage, exportPdf }; window.__yOfP = yOfP;

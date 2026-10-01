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
async function load(blob, name) {
  hidePop();
  $('busy').style.display = 'grid';
  try {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
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
    S.model = m; S.rend = new Renderer(img, m); S.name = (name || 'score').replace(/\.[^.]+$/, ''); S.octave = 'auto';
    $('empty').hidden = true; $('stage').hidden = false; $('export').disabled = false;
    fitZoom();
    update();
  } catch (e) {
    setStatus(`<b>Could not read this image:</b> ${e.message}. Try a flatter, sharper photo with the full staff width in frame.`);
  } finally { $('busy').style.display = 'none'; }
}
for (const id of ['cam', 'cam2', 'file']) $(id).onchange = (e) => { const f = e.target.files[0]; if (f) load(f, f.name); e.target.value = ''; };
const sample = async () => load(await (await fetch('sample.jpg')).blob(), 'minuet');
$('sample').onclick = sample; $('sample2').onclick = sample;
window.addEventListener('paste', (e) => { const it = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/')); if (it) load(it.getAsFile(), 'pasted'); });
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
  setStatus(`<b>${m.staves.length}</b> staves · <b>${n}</b> notes · ${describe(m, pl)}${oc} · read in ${Math.round(m.ms)} ms${S.view === 'interpreted' ? ' · tap a note or a staff label to correct it' : ''}`);
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
  const redo = () => { interpret(n.st); notePop(n, e); };
  $('nUp').onclick = () => { n.p++; n.y = yOfP(n.st, n.p, n.x); redo(); };
  $('nDn').onclick = () => { n.p--; n.y = yOfP(n.st, n.p, n.x); redo(); };
  pop.querySelectorAll('[data-acc]').forEach((b) => (b.onclick = () => {
    const v = b.dataset.acc; n.accid = v === 'none' ? null : { ...(n.accid || { ids: [], box: [n.box[0] - 12, n.y - 12, n.box[0] - 2, n.y + 12] }), type: +v }; redo();
  }));
  $('nDel').onclick = () => {
    const st = n.st; st.notes.splice(st.notes.indexOf(n), 1); S.model.notes.splice(S.model.notes.indexOf(n), 1);
    interpret(st); hidePop(); update();
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
window.__ss = { S, load, update, plan }; window.__yOfP = yOfP;

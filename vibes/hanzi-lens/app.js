/*
 * app.js - Hanzi Lens UI.
 *
 * Live: the camera frame goes to the worker a few times a second at a small detector size;
 * the lines it finds are tracked from frame to frame (matched by overlap), and once the
 * picture has held still, the lines without text are read from the full-resolution frame.
 * A line keeps its text while it stays in view, so the pinyin doesn't flicker.
 * Freeze (shutter, or a photo): the whole frame is read at the larger detector size, and
 * tapping a line opens its words with pinyin and CC-CEDICT meanings.
 */
import { parseDict, annotate, linePinyin, meanings, joinPinyin } from './text.js';
import { crowded } from './ocr.js';

const $ = (id) => document.getElementById(id);
const video = $('video'), still = $('still'), boxesSvg = $('boxes'), labels = $('labels');
const params = new URLSearchParams(location.search);
const LIVE_DET = 640, FREEZE_DET = +params.get('det') || 1280, MAX_PHOTO = 2560;

const S = {
  dict: null, dictP: null, ready: null, ep: '',
  mode: localStorage.getItem('hl-mode') || 'pinyin',     // 'pinyin' | 'boxes'
  view: 'start',                                       // 'start' | 'live' | 'frozen'
  stream: null, frame: 0, busy: false,
  tracks: [], nextKey: 1, steady: 0,
  frozen: null,                                        // { w, h, lines }
  sel: null, listOpen: false,
};
window.__hl = { S, freeze };   // for the smoke tests

// ---- crash trace ----
// iOS kills a tab that runs out of memory without a log. Each step of a read is written to
// localStorage as it starts; a trace that doesn't end in 'done' was cut short, and the next
// load shows its last steps on the start screen.
const TRACE_KEY = 'hl-trace';
const traceLog = [];
function trace(step) {
  traceLog.push(`${(performance.now() / 1000).toFixed(1)}s ${step}`);
  if (traceLog.length > 40) traceLog.splice(0, traceLog.length - 40);
  try { localStorage.setItem(TRACE_KEY, JSON.stringify({ at: Date.now(), ua: navigator.userAgent, ep: S.ep, steps: traceLog })); } catch { /* full or private */ }
}
// After a read, keep noting that the page is alive, so a crash after it shows too; leaving
// the page normally closes the trace.
let beat = null;
function heartbeat(what) {
  clearInterval(beat);
  const t0 = performance.now();
  let line = -1;
  beat = setInterval(() => {
    const step = `alive ${Math.round((performance.now() - t0) / 1000)}s ${what}`;
    if (line >= 0 && traceLog[line] && traceLog[line].includes(' alive ')) traceLog[line] = `${(performance.now() / 1000).toFixed(1)}s ${step}`;
    else { traceLog.push(''); line = traceLog.length - 1; traceLog[line] = `${(performance.now() / 1000).toFixed(1)}s ${step}`; }
    try { const t = JSON.parse(localStorage.getItem(TRACE_KEY)); t.steps = traceLog; localStorage.setItem(TRACE_KEY, JSON.stringify(t)); } catch { /* */ }
    if (performance.now() - t0 > 60000) { clearInterval(beat); trace('still alive after 60 s; done'); }
  }, 2000);
}
addEventListener('pagehide', () => { clearInterval(beat); trace('page closed; done'); });

function lastTrace() {
  try {
    const t = JSON.parse(localStorage.getItem(TRACE_KEY) || 'null');
    if (!t || !t.steps.length || /done$/.test(t.steps[t.steps.length - 1])) return null;
    return t;
  } catch { return null; }
}

// ---- worker ----

const worker = new Worker('./worker.js', { type: 'module' });
const waiting = [];   // the worker answers in order
worker.onmessage = (e) => {
  if (e.data.type === 'trace') { trace('worker: ' + e.data.step); return; }
  const w = waiting.shift();
  if (!w) return;
  if (e.data.type === 'error') w.reject(new Error(e.data.message)); else w.resolve(e.data);
};
const call = (msg, transfer = []) => new Promise((resolve, reject) => { waiting.push({ resolve, reject }); worker.postMessage(msg, transfer); });

function status(text) { $('status').textContent = text || ''; }

function loadDict() {
  if (!S.dictP) S.dictP = (async () => {
    trace('dictionary: fetch');
    const res = await fetch('dict/cedict.txt.gz');
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    trace('dictionary: parse');
    S.dict = parseDict(text);
    trace(`dictionary: ${S.dict.count} entries`);
    return S.dict;
  })();
  return S.dictP;
}

// CPU (WASM) by default: iOS Safari's WebGPU killed the tab after a read (iPhone, iOS 18.7)
// while WASM ran the same read through. The GPU is a choice kept on this device; ?ep=webgpu
// or ?ep=wasm overrides it for one visit.
const EP_KEY = 'hanzi-lens-ep';
function engine() {
  if (params.has('ep')) return params.get('ep') === 'webgpu' ? 'webgpu' : 'wasm';
  try { return localStorage.getItem(EP_KEY) === 'webgpu' ? 'webgpu' : 'wasm'; } catch { return 'wasm'; }
}
const gpuBox = $('gpuBox');
gpuBox.checked = engine() === 'webgpu';
gpuBox.disabled = params.has('ep');
if (!('gpu' in navigator)) { gpuBox.disabled = true; gpuBox.parentElement.title = 'This browser has no WebGPU'; }
gpuBox.addEventListener('change', () => {
  try { localStorage.setItem(EP_KEY, gpuBox.checked ? 'webgpu' : 'wasm'); } catch { /* private */ }
  // the worker's sessions are made once: a reader already loaded needs a fresh page
  if (S.ready) location.reload();
});

function boot() {
  if (!S.ready) {
    status('Loading the reader…');
    trace('boot');
    S.ready = Promise.all([call({ type: 'init', ep: engine() }), loadDict()]).then(([r]) => {
      S.ep = r.ep === 'webgpu' ? 'WebGPU' : r.ep === 'wasm' ? 'CPU' : r.ep;
      status(S.ep);
      trace(`ready ${r.ep} in ${r.ms} ms; done`);
      return r;
    }, (err) => { status('Could not load the reader: ' + err.message); S.ready = null; throw err; });
  }
  return S.ready;
}

// ---- geometry: image pixels <-> screen ----

function fit(w, h, cover) {
  const W = innerWidth, H = innerHeight, s = cover ? Math.max(W / w, H / h) : Math.min(W / w, H / h);
  return { s, ox: (W - w * s) / 2, oy: (H - h * s) / 2 };
}
const toScreen = (f, [x, y]) => [f.ox + x * f.s, f.oy + y * f.s];

// ---- drawing ----

function draw() {
  const lines = S.view === 'frozen' ? (S.frozen ? S.frozen.lines : []) : S.view === 'live' ? S.tracks.filter((t) => t.seen) : [];
  const f = S.view === 'frozen' && S.frozen ? fit(S.frozen.w, S.frozen.h, false) : fit(video.videoWidth || 1, video.videoHeight || 1, true);
  let svg = '';
  const frag = document.createDocumentFragment();
  // on a dense page every line's pinyin would cover the line above it: label the tapped line alone
  const dense = params.has('dense') ? params.get('dense') !== '0' : crowded(lines.filter((l) => l.text), f.s);
  S.dense = dense;
  lines.forEach((l, i) => {
    const q = l.quad.map((p) => toScreen(f, p));
    svg += `<polygon data-i="${i}" class="${l.text ? 'read' : ''}${S.sel === l ? ' sel' : ''}" points="${q.map((p) => p.join(',')).join(' ')}"/>`;
    if (S.mode !== 'pinyin' || !l.ann || (dense && l !== S.sel)) return;
    // a syllable over each character: along the line's first edge, just outside it
    const [o, a, , b] = q;
    const ex = a[0] - o[0], ey = a[1] - o[1];
    const cx = b[0] - o[0], cy = b[1] - o[1], thick = Math.hypot(cx, cy) || 1;
    const nx = -cx / thick, ny = -cy / thick;          // away from the text
    const lenPx = Math.hypot(ex, ey), n = l.ann.chars.length || 1;
    const base = Math.min(28, Math.max(dense ? 14 : 0, thick * 0.36)), gap = 2;
    for (const sp of l.ann.spans) {
      const p0 = l.charPos[sp.from], p1 = l.charPos[sp.to - 1];
      if (p0 == null || p1 == null) continue;
      const c = (p0 + p1) / 2;
      // as wide as the characters it covers, so neighbouring syllables don't overlap
      const room = l.vertical ? Infinity : (Math.abs(p1 - p0) * lenPx + lenPx / n) * 0.98;
      const size = Math.max(dense ? 11 : 9, Math.min(base, room / (0.58 * sp.py.length + 0.5)));
      const el = document.createElement('div');
      el.className = 'py' + (l.vertical ? ' v' : '') + (l.weak ? ' weak' : '');
      el.textContent = sp.py;
      el.style.fontSize = size.toFixed(1) + 'px';
      el.style.left = o[0] + ex * c + nx * gap + 'px';
      el.style.top = o[1] + ey * c + ny * gap + 'px';
      frag.appendChild(el);
    }
  });
  boxesSvg.innerHTML = svg;
  boxesSvg.classList.toggle('dense', dense);
  boxesSvg.classList.toggle('quiet', S.view === 'live');
  labels.replaceChildren(frag);
  labels.classList.toggle('off', S.mode !== 'pinyin');
}

/** Attach words and per-character positions to a recognised line. */
function interpret(line, r) {
  line.text = r.text;
  line.confidence = r.confidence;
  line.weak = r.confidence < 0.75;
  // CTC gives each character a centre along the line; spaces collapse, so walk both
  const chars = Array.from(r.text);
  const pos = [];
  let k = 0;
  for (const c of r.chars) {
    if (/\s/.test(c.ch)) { if (chars[k] === ' ') pos[k++] = c.pos; continue; }
    while (k < chars.length && chars[k] === ' ') k++;
    pos[k++] = c.pos;
  }
  line.charPos = pos;
  line.ann = S.dict ? annotate(r.text, S.dict) : null;
}

// ---- live view ----

const aabb = (q) => { const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const i = ix * iy, u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u > 0 ? i / u : 0;
}
const lenOf = (q) => Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);

/** Match the lines of a new frame to the tracks; returns how far the matched lines moved (fraction of the frame). */
function track(found, w, h) {
  const boxes = found.map((l) => ({ l, bb: aabb(l.quad) }));
  const pairs = [];
  S.tracks.forEach((t, ti) => boxes.forEach((b, bi) => { const v = iou(t.bb, b.bb); if (v > 0.3 && t.vertical === b.l.vertical) pairs.push([v, ti, bi]); }));
  pairs.sort((a, b) => b[0] - a[0]);
  const usedT = new Set(), usedB = new Set();
  let move = 0, moved = 0;
  for (const [, ti, bi] of pairs) {
    if (usedT.has(ti) || usedB.has(bi)) continue;
    usedT.add(ti); usedB.add(bi);
    const t = S.tracks[ti], b = boxes[bi];
    const c0 = [(t.bb[0] + t.bb[2]) / 2, (t.bb[1] + t.bb[3]) / 2], c1 = [(b.bb[0] + b.bb[2]) / 2, (b.bb[1] + b.bb[3]) / 2];
    move += Math.hypot(c1[0] - c0[0], c1[1] - c0[1]); moved++;
    // a line that grew (more of it came into view) is read again
    if (t.text != null && lenOf(b.l.quad) > t.readLen * 1.25) t.stale = true;
    t.quad = b.l.quad; t.bb = b.bb; t.missed = 0; t.seen = true;
  }
  S.tracks.forEach((t, ti) => { if (!usedT.has(ti)) { t.missed++; t.seen = false; } });
  S.tracks = S.tracks.filter((t) => t.missed <= 3);
  boxes.forEach((b, bi) => {
    if (!usedB.has(bi)) S.tracks.push({ key: S.nextKey++, quad: b.l.quad, bb: b.bb, vertical: b.l.vertical, text: null, missed: 0, seen: true, tries: 0 });
  });
  return moved ? move / moved / Math.hypot(w, h) : 0;
}

async function liveTick() {
  if (S.view !== 'live' || S.busy || video.readyState < 2) { if (S.view === 'live') requestAnimationFrame(liveTick); return; }
  S.busy = true;
  try {
    const id = ++S.frame;
    const bitmap = await createImageBitmap(video);
    const t0 = performance.now();
    const res = await call({ type: 'frame', id, bitmap, detLong: LIVE_DET, read: false }, [bitmap]);
    if (S.view !== 'live') return;
    const move = track(res.lines, res.w, res.h);
    S.steady = move < 0.006 ? S.steady + 1 : 0;
    let readMs = 0;
    if (S.steady >= 2) {
      const want = S.tracks.filter((t) => t.seen && (t.text == null || t.stale) && t.tries < 3).slice(0, 4);
      if (want.length) {
        const r = await call({ type: 'read', id, quads: want.map((t) => ({ key: t.key, quad: t.quad })) });
        readMs = r.ms || 0;
        for (const x of r.results || []) {
          const t = S.tracks.find((tt) => tt.key === x.key);
          if (!t) continue;
          t.tries++; t.stale = false; t.readLen = lenOf(t.quad);
          if (x.text) { interpret(t, x); t.tries = 0; } else t.text = t.text || null;
        }
      }
    }
    draw();
    status(`${S.ep} · ${res.lines.length} lines · ${Math.round(performance.now() - t0)} ms${readMs ? ` (read ${readMs})` : ''}${S.dense && S.mode === 'pinyin' ? ' · tap a line for its pinyin' : ''}`);
  } catch (err) {
    status('Error: ' + err.message);
  } finally {
    S.busy = false;
    if (S.view === 'live') setTimeout(() => requestAnimationFrame(liveTick), 60);
  }
}

async function startCamera() {
  try {
    S.stream = S.stream || await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
  } catch (err) {
    status('No camera: ' + err.message + '. Open a photo instead.');
    return;
  }
  video.srcObject = S.stream;
  await video.play().catch(() => {});
  await boot();
  enterLive();
}

function enterLive() {
  closeSheet();
  S.view = 'live'; S.frozen = null; S.tracks = []; S.steady = 0;
  $('start').hidden = true; $('controls').hidden = false;
  video.hidden = false; still.hidden = true;
  $('shutter').classList.remove('frozen');
  $('listBtn').disabled = true;
  draw();
  requestAnimationFrame(liveTick);
}

// ---- frozen view ----

async function freeze(bitmap) {
  await boot();
  S.view = 'frozen'; closeSheet();
  $('start').hidden = true; $('controls').hidden = !S.stream;
  $('shutter').classList.add('frozen', 'busy');
  still.width = bitmap.width; still.height = bitmap.height;
  still.getContext('2d').drawImage(bitmap, 0, 0);
  still.hidden = false; video.hidden = true;
  S.frozen = { w: bitmap.width, h: bitmap.height, lines: [] };
  draw();
  status(`${S.ep} · reading…`);
  trace(`freeze ${bitmap.width}x${bitmap.height}`);
  const id = ++S.frame;
  try {
    const res = await call({ type: 'frame', id, bitmap, detLong: FREEZE_DET, read: true }, [bitmap]);
    if (S.view !== 'frozen' || S.frame !== id) return;
    trace(`${res.lines.length} lines back in ${res.ms} ms`);
    await loadDict();
    for (const l of res.lines) interpret(l, l);
    trace('words and pinyin');
    S.frozen.lines = res.lines;
    S.frozen.ms = res.ms;
    $('listBtn').disabled = !res.lines.length;
    draw();
    trace(`drawn (${document.querySelectorAll('#labels .py').length} labels)`);
    heartbeat('after the read');
    status(`${S.ep} · ${res.lines.length} lines · ${res.ms} ms${S.dense && S.mode === 'pinyin' ? ' · tap a line for its pinyin' : ''}`);
  } catch (err) {
    status('Error: ' + err.message);
    trace('error: ' + err.message + '; done');
  } finally {
    $('shutter').classList.remove('busy');
    draw();
  }
}

async function freezeVideo() {
  if (!video.videoWidth) return;
  const bitmap = await createImageBitmap(video);
  video.pause();
  await freeze(bitmap);
}

async function openPhoto(file) {
  if (!file) return;
  let bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const s = Math.min(1, MAX_PHOTO / Math.max(bitmap.width, bitmap.height));
  if (s < 1) { const b2 = await createImageBitmap(bitmap, { resizeWidth: Math.round(bitmap.width * s), resizeHeight: Math.round(bitmap.height * s), resizeQuality: 'high' }); bitmap.close(); bitmap = b2; }
  await freeze(bitmap);
}

// ---- sheet: one line's words, or every line ----

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function closeSheet() { $('sheet').hidden = true; S.sel = null; S.listOpen = false; draw(); }

function openLine(line) {
  S.sel = line; S.listOpen = false;
  const ann = line.ann || (S.dict && annotate(line.text, S.dict));
  if (!ann) return;
  line.ann = ann;
  $('sheetLine').innerHTML = ann.tokens.map((t, i) => t.pinyin
    ? `<ruby data-t="${i}">${esc(t.text)}<rt>${esc(joinPinyin(t.pinyin))}</rt></ruby>`
    : `<span>${esc(t.text)}</span>`).join('');
  $('sheetPinyin').textContent = linePinyin(ann);
  const words = ann.tokens.filter((t) => t.kind === 'word' || t.kind === 'number');
  $('words').innerHTML = words.map((t) => wordHtml(t, ann.tokens.indexOf(t))).join('') +
    `<div class="credit">Readings and meanings: CC-CEDICT (CC BY-SA 4.0). Reading confidence ${Math.round((line.confidence || 0) * 100)}%.</div>`;
  $('sheet').hidden = false; $('sheet').scrollTop = 0;
  $('speakBtn').hidden = !('speechSynthesis' in window);
  draw();
}

function wordHtml(t, i) {
  if (t.kind === 'number') return `<div class="word" data-t="${i}"><div class="hz">${esc(t.text)}</div><div class="pz">${esc(joinPinyin(t.pinyin || []))}</div><div class="df">${esc(t.han || '')}</div></div>`;
  const e = t.entry;
  if (!e) return `<div class="word unknown" data-t="${i}"><div class="hz">${esc(t.text)}</div><div class="pz">?</div><div class="df alt">not in the dictionary</div></div>`;
  const other = e.trad !== e.simp ? (t.text === e.simp ? e.trad : e.simp) : '';
  const defs = e.defs.slice(0, 3).join('; ') + (e.defs.length > 3 ? '; …' : '');
  const n = (t.entries || []).length;
  return `<div class="word" data-t="${i}"><div class="hz">${esc(t.text)}</div>
    <div class="pz">${esc(joinPinyin(t.pinyin))}${other ? ` <span class="alt">${esc(other)}</span>` : ''}${n > 1 ? ` <span class="alt">+${n - 1} more</span>` : ''}</div>
    <div class="df">${esc(defs)}</div></div>`;
}

function expandWord(el) {
  const t = S.sel.ann.tokens[+el.dataset.t];
  if (!t || t.kind !== 'word') return;
  if (el.classList.toggle('open')) {
    const all = meanings(t).slice(1).map((m) => `<div class="ent"><b>${esc(m.pinyin)}</b> ${m.trad !== m.simp ? esc(m.simp + ' / ' + m.trad) + ' ' : ''}— ${esc(m.defs.join('; '))}</div>`).join('');
    const chars = [...t.text].length > 1 ? [...t.text].map((c) => {
      const ann = annotate(c, S.dict).tokens[0];
      return ann.entry ? `${c} ${joinPinyin(ann.pinyin)} ${ann.entry.defs[0]}` : c;
    }).join(' · ') : '';
    el.insertAdjacentHTML('beforeend', `<div class="more">${t.entry ? `<div class="ent">${esc(t.entry.defs.join('; '))}</div>` : ''}${all}${chars ? `<div class="chars">${esc(chars)}</div>` : ''}</div>`);
  } else el.querySelector('.more')?.remove();
}

function openList() {
  const lines = S.frozen ? S.frozen.lines : [];
  if (!lines.length) return;
  S.sel = null; S.listOpen = true;
  $('sheetLine').innerHTML = '<span style="font-size:18px">All the text</span>';
  $('sheetPinyin').textContent = `${lines.length} lines`;
  $('words').innerHTML = lines.map((l, i) => `<div class="list-line" data-l="${i}"><div class="zh">${esc(l.text)}</div><div class="pyl">${esc(l.ann ? linePinyin(l.ann) : '')}</div></div>`).join('');
  $('sheet').hidden = false; $('sheet').scrollTop = 0;
  draw();
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  const v = speechSynthesis.getVoices().find((x) => /^zh(-|_)?(CN|Hans)?/i.test(x.lang));
  if (v) u.voice = v;
  u.rate = 0.85;
  speechSynthesis.speak(u);
}

// ---- events ----

function lineAt(x, y) {
  const lines = S.view === 'frozen' ? (S.frozen ? S.frozen.lines : []) : S.tracks.filter((t) => t.seen && t.text);
  const f = S.view === 'frozen' ? fit(S.frozen.w, S.frozen.h, false) : fit(video.videoWidth, video.videoHeight, true);
  const inside = (q, px, py) => { let c = false; for (let i = 0, j = 3; i < 4; j = i++) { const [xi, yi] = q[i], [xj, yj] = q[j]; if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c; } return c; };
  let best = null, bd = 24;   // a small margin, for fingers
  for (const l of lines) {
    const q = l.quad.map((p) => toScreen(f, p));
    if (inside(q, x, y)) return l;
    const bb = aabb(q), d = Math.max(Math.max(bb[0] - x, 0, x - bb[2]), Math.max(bb[1] - y, 0, y - bb[3]));
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}

$('stage').addEventListener('click', async (e) => {
  if (S.view === 'start') return;
  const l = lineAt(e.clientX, e.clientY);
  if (S.view === 'live') {
    if (!l) return;
    // a tap on a live line freezes the picture and opens that line once it is read again
    const at = [e.clientX, e.clientY];
    await freezeVideo();
    const l2 = lineAt(...at);
    if (l2) openLine(l2);
    return;
  }
  if (l) openLine(l); else closeSheet();
});
$('words').addEventListener('click', (e) => {
  const w = e.target.closest('.word'), ll = e.target.closest('.list-line');
  if (w) expandWord(w);
  else if (ll) openLine(S.frozen.lines[+ll.dataset.l]);
});
$('sheetLine').addEventListener('click', (e) => {
  const r = e.target.closest('ruby');
  if (!r) return;
  const w = $('words').querySelector(`.word[data-t="${r.dataset.t}"]`);
  if (w) { if (!w.classList.contains('open')) expandWord(w); w.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
});
$('closeBtn').onclick = closeSheet;
$('speakBtn').onclick = () => { if (S.sel) speak(S.sel.text); else if (S.listOpen && S.frozen) speak(S.frozen.lines.map((l) => l.text).join('。')); };
$('copyBtn').onclick = () => { const t = S.sel ? S.sel.text : S.frozen ? S.frozen.lines.map((l) => l.text).join('\n') : ''; navigator.clipboard?.writeText(t).then(() => status('Copied'), () => {}); };
$('listBtn').onclick = openList;
$('modeBtn').onclick = () => { S.mode = S.mode === 'pinyin' ? 'boxes' : 'pinyin'; localStorage.setItem('hl-mode', S.mode); $('modeBtn').classList.toggle('off', S.mode !== 'pinyin'); draw(); };
$('modeBtn').classList.toggle('off', S.mode !== 'pinyin');
$('shutter').onclick = () => { if (S.view === 'live') freezeVideo(); else if (S.stream) { video.play(); enterLive(); } };
$('camBtn').onclick = startCamera;
for (const id of ['file', 'file2']) $(id).onchange = (e) => { openPhoto(e.target.files[0]); e.target.value = ''; };
$('sampleBtn').onclick = async () => { const blob = await (await fetch('sample.jpg')).blob(); openPhoto(blob); };
addEventListener('resize', draw);
addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'Escape') closeSheet();
  else if (e.key === ' ' && S.view !== 'start') { e.preventDefault(); $('shutter').click(); }
  else if (e.key === 'p') $('modeBtn').click();
  else if (e.key === 'l') openList();
  else if (e.key === 'o') $('file').click();
});
addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/')); if (f) openPhoto(f); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); const f = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/')); if (f) openPhoto(f); });

if (!navigator.mediaDevices?.getUserMedia) $('camBtn').hidden = true;
{
  const t = lastTrace();
  if (t) {
    const el = $('crash');
    el.hidden = false;
    el.querySelector('pre').textContent = `${new Date(t.at).toLocaleString()} · ${t.ep || 'not started'}\n${t.ua}\n\n` + t.steps.join('\n');
    el.querySelector('button').onclick = () => { navigator.clipboard?.writeText(el.querySelector('pre').textContent); status('Copied'); };
  }
}
const BUILD = 'v10';   // shown on the start screen; keep in step with sw.js VERSION
$('build').textContent = `build ${BUILD}`;
if ('serviceWorker' in navigator && !params.has('nosw')) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  // a new service worker took over: reload once so this page runs its files
  // (not on the first visit, when there was no old one)
  let reloaded = !navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded || S.view !== 'start') return;
    reloaded = true;
    location.reload();
  });
}

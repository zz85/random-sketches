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
import { parseDict, annotate, linePinyin, meanings, joinPinyin, markPinyin, pickVoice, lookup } from './text.js';
import { crowded, skewOf } from './ocr.js';

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
  vm: [1, 0, 0, 1, 0, 0],                              // view of the frozen picture (see frame); ID when not moved
  orig: null,                                          // the picture before a crop or turn, to go back to
  crop: null,                                          // the crop box on screen while cropping
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

// The worker is made on first use and, on the GPU, closed after each full read: iOS Safari
// (iPhone, iOS 18.7) killed the tab about 10 s after a read on WebGPU had been drawn, with
// nothing running, while the CPU backend ran on. Closing the worker frees its GPU device,
// its buffers and ONNX Runtime's WASM heap; the next read makes it again from the cached
// models (about 2.5 s on that iPhone). ?keep=1 keeps it, to compare.
let worker = null, waiting = [];   // the worker answers in order
function openWorker() {
  worker = new Worker('./worker.js', { type: 'module' });
  waiting = [];
  worker.onmessage = (e) => {
    if (e.data.type === 'trace') { trace('worker: ' + e.data.step); return; }
    const w = waiting.shift();
    if (!w) return;
    if (e.data.type === 'error') w.reject(new Error(e.data.message)); else w.resolve(e.data);
  };
}
function closeWorker(why) {
  if (!worker) return;
  worker.terminate(); worker = null;
  for (const w of waiting) w.reject(new Error('reader closed'));
  waiting = []; S.ready = null;
  trace(`worker closed: ${why}`);
}
const send = (msg, transfer = []) => new Promise((resolve, reject) => { if (!worker) openWorker(); waiting.push({ resolve, reject }); worker.postMessage(msg, transfer); });
// every call but init goes through boot, so a closed worker is made again first
const call = async (msg, transfer = []) => { await boot(); return send(msg, transfer); };

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
  if (params.has('ep')) return ['webgpu', 'split'].includes(params.get('ep')) ? params.get('ep') : 'wasm';
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
    S.ready = Promise.all([send({ type: 'init', ep: engine() }), loadDict()]).then(([r]) => {
      S.ep = r.ep === 'webgpu' ? 'WebGPU' : r.ep === 'wasm' ? 'CPU' : r.ep === 'wasm+webgpu' ? 'CPU+WebGPU' : r.ep;
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
  return { s, ox: (W - w * s) / 2, oy: (H - h * s) / 2, m: [s, 0, 0, s, (W - w * s) / 2, (H - h * s) / 2] };
}
// 2D affine matrices as [a, b, c, d, e, f], as DOMMatrix and canvas take them:
// x' = a x + c y + e, y' = b x + d y + f
const mul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
const apply = (M, [x, y]) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
const inv = (M) => { const d = M[0] * M[3] - M[1] * M[2]; return [M[3] / d, -M[1] / d, -M[2] / d, M[0] / d, (M[2] * M[5] - M[3] * M[4]) / d, (M[1] * M[4] - M[0] * M[5]) / d]; };
const ID = S.vm;   // the view not moved, compared by identity
const scaleOf = (M) => Math.hypot(M[0], M[1]), angleOf = (M) => Math.atan2(M[1], M[0]);
/** About a screen point: rotate by `a`, scale by `k`, then move by (dx, dy). */
const around = ([px, py], k, a, dx = 0, dy = 0) => { const c = Math.cos(a) * k, n = Math.sin(a) * k; return [c, n, -n, c, px + dx - c * px + n * py, py + dy - n * px - c * py]; };
/** Image pixels -> screen: the fit, then the view (pinch zoom, pan and turn) of the frozen picture. */
function frame() {
  if (S.view === 'frozen' && S.frozen) { const f = fit(S.frozen.w, S.frozen.h, false); f.m = mul(S.vm, f.m); f.s *= scaleOf(S.vm); return f; }
  return fit(video.videoWidth || 1, video.videoHeight || 1, true);
}
const toScreen = (f, p) => apply(f.m, p);

// ---- drawing ----

function draw() {
  const lines = S.view === 'frozen' ? (S.frozen ? S.frozen.lines : []) : S.view === 'live' ? S.tracks.filter((t) => t.seen) : [];
  const f = frame();
  if (S.view === 'frozen' && S.frozen) {
    still.style.width = S.frozen.w + 'px'; still.style.height = S.frozen.h + 'px';
    still.style.transform = `matrix(${f.m.join(',')})`;
  }
  const W = innerWidth, H = innerHeight;
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
    const bb = aabb(q);
    if (bb[2] < -50 || bb[0] > W + 50 || bb[3] < -50 || bb[1] > H + 50) return;
    // the label turns with its line: a tilted photo, or a turned view
    const turn = Math.atan2(ey, ex) - (l.vertical ? Math.PI / 2 : 0);
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
      if (Math.abs(turn) > 0.02) el.style.transform = `rotate(${turn.toFixed(3)}rad) ${l.vertical ? 'translate(0, -50%)' : 'translate(-50%, -100%)'}`;
      frag.appendChild(el);
    }
  });
  boxesSvg.innerHTML = svg;
  boxesSvg.classList.toggle('dense', dense);
  boxesSvg.classList.toggle('quiet', S.view === 'live');
  labels.replaceChildren(frag);
  labels.classList.toggle('off', S.mode !== 'pinyin');
  labels.classList.toggle('still', S.view === 'frozen');
  // edit tools for the frozen picture
  const busy = $('shutter').classList.contains('busy');
  $('edit').hidden = S.view !== 'frozen' || !!S.crop;
  for (const id of ['rotBtn', 'cropBtn']) $(id).disabled = busy;
  $('fitBtn').hidden = S.vm === ID;
  $('revertBtn').hidden = !S.orig;
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

async function freeze(bitmap, { edited = false, detLong = FREEZE_DET } = {}) {
  await boot();
  if (!edited) S.orig = null;
  S.vm = ID; endCrop();
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
    const res = await call({ type: 'frame', id, bitmap, detLong, read: true }, [bitmap]);
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
    if (/GPU/.test(S.ep) && params.get('keep') !== '1') closeWorker('free the GPU after a full read');
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

function closeSheet() {
  $('sheet').hidden = true; S.sel = null; S.listOpen = false;
  if (S.dictOpen) { S.dictOpen = false; $('dictInput').hidden = true; $('dictInput').blur(); $('sheet').classList.remove('dict'); $('sheetLine').hidden = false; }
  draw();
}

function openLine(line) {
  if (S.dictOpen) closeSheet();
  S.sel = line; S.listOpen = false;
  const ann = line.ann || (S.dict && annotate(line.text, S.dict));
  if (!ann) return;
  line.ann = ann;
  $('sheetLine').innerHTML = ann.tokens.map((t, i) => t.pinyin
    ? `<ruby data-t="${i}">${esc(t.text)}<rt>${esc(joinPinyin(t.pinyin))}</rt></ruby>`
    : `<span>${esc(t.text)}</span>`).join('');
  $('sheetPinyin').textContent = linePinyin(ann);
  S.tokens = ann.tokens;
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
  const t = S.tokens && S.tokens[+el.dataset.t];
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
  if (S.dictOpen) closeSheet();
  S.sel = null; S.listOpen = true;
  $('sheetLine').innerHTML = '<span style="font-size:18px">All the text</span>';
  $('sheetPinyin').textContent = `${lines.length} lines`;
  $('words').innerHTML = lines.map((l, i) => `<div class="list-line" data-l="${i}"><div class="zh">${esc(l.text)}</div><div class="pyl">${esc(l.ann ? linePinyin(l.ann) : '')}</div></div>`).join('');
  $('sheet').hidden = false; $('sheet').scrollTop = 0;
  draw();
}

// ---- dictionary lookup ----

async function openDict(query) {
  S.sel = null; S.listOpen = false; S.dictOpen = true;
  const input = $('dictInput');
  $('sheet').classList.add('dict');
  $('sheetLine').hidden = true;
  input.hidden = false;
  if (query != null) input.value = query;
  $('sheet').hidden = false;
  $('speakBtn').hidden = !('speechSynthesis' in window);
  input.focus();
  draw();
  if (!S.dict) { $('sheetPinyin').textContent = 'Loading the dictionary…'; $('words').innerHTML = ''; }
  await loadDict();
  runLookup();
}

let lookupTimer = 0;
function runLookup() {
  if (!S.dictOpen || !S.dict) return;
  const q = $('dictInput').value;
  const res = lookup(S.dict, q, 60);
  // each result as a word token, so the list and its expanded meanings are the line sheet's
  S.tokens = res.map(({ entry: e }) => ({ kind: 'word', text: e.simp, entry: e, entries: S.dict.get(e.simp) || [e], pinyin: markPinyin(e.pinyin) }));
  $('sheetPinyin').textContent = !q.trim() ? 'Type a word in 汉字, pinyin (nihao, ni3hao3) or English'
    : res.length ? `${res.length}${res.length >= 60 ? '+' : ''} ${res[0].kind === 'english' ? 'words for' : 'results for'} “${q.trim()}”` : `Nothing found for “${q.trim()}”`;
  $('words').innerHTML = S.tokens.map((t, i) => wordHtml(t, i)).join('') + (res.length ? '<div class="credit">CC-CEDICT (CC BY-SA 4.0)</div>' : '');
  $('sheet').scrollTop = 0;
}
$('dictInput').addEventListener('input', () => { clearTimeout(lookupTimer); lookupTimer = setTimeout(runLookup, 150); });
$('dictInput').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); else if (e.key === 'Enter') { clearTimeout(lookupTimer); runLookup(); e.target.blur(); } });
$('dictBtn').onclick = () => (S.dictOpen ? closeSheet() : openDict());
$('dictBtn2').onclick = () => openDict();

// Chrome lists its voices a moment after the page loads: wait for them the first time
function voices() {
  const now = speechSynthesis.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((r) => {
    const done = () => { speechSynthesis.removeEventListener('voiceschanged', done); r(speechSynthesis.getVoices()); };
    speechSynthesis.addEventListener('voiceschanged', done);
    setTimeout(done, 1000);
  });
}

async function speak(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'zh-CN';
  const v = pickVoice(await voices());
  if (v) u.voice = v;
  u.rate = 0.85;
  status(v ? `Speaking with ${v.name}${v.localService === false ? ' (online voice)' : ''}` : 'Speaking');
  speechSynthesis.speak(u);
}

// ---- events ----

function lineAt(x, y) {
  const lines = S.view === 'frozen' ? (S.frozen ? S.frozen.lines : []) : S.tracks.filter((t) => t.seen && t.text);
  const f = frame();
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
  if (S.view === 'start' || S.crop) return;
  if (G.swallow) { G.swallow = false; return; }   // the end of a pan, a pinch or a double tap
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
$('speakBtn').onclick = () => { if (S.dictOpen) { const q = $('dictInput').value.trim(), t = /\p{Script=Han}/u.test(q) ? q : S.tokens?.[0]?.text; if (t) speak(t); } else if (S.sel) speak(S.sel.text); else if (S.listOpen && S.frozen) speak(S.frozen.lines.map((l) => l.text).join('。')); };
$('copyBtn').onclick = () => { const t = S.dictOpen ? (S.tokens?.[0]?.text || '') : S.sel ? S.sel.text : S.frozen ? S.frozen.lines.map((l) => l.text).join('\n') : ''; navigator.clipboard?.writeText(t).then(() => status('Copied'), () => {}); };
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
  if (e.key === 'Escape') { if (S.crop) endCrop(); else closeSheet(); }
  else if (e.key === ' ' && S.view !== 'start') { e.preventDefault(); $('shutter').click(); }
  else if (e.key === 'p') $('modeBtn').click();
  else if (e.key === 'd') { e.preventDefault(); $('dictBtn').click(); }
  else if (S.view === 'frozen' && !S.crop && (e.key === '+' || e.key === '=')) zoomBy(1.5, [innerWidth / 2, innerHeight / 2]);
  else if (S.view === 'frozen' && !S.crop && e.key === '-') zoomBy(1 / 1.5, [innerWidth / 2, innerHeight / 2]);
  else if (S.view === 'frozen' && e.key === '0') setView(ID, true);
  else if (S.view === 'frozen' && e.key === 'r') $('rotBtn').click();
  else if (S.view === 'frozen' && e.key === 'c') $('cropBtn').click();
  else if (S.crop && e.key === 'Enter') $('cropOk').click();
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
const BUILD = 'v16';   // shown on the start screen; keep in step with sw.js VERSION
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

// ---- the frozen picture: pinch to zoom, pan, turn; double tap; wheel ----

const MAX_ZOOM = 10;
let redrawQueued = false;
function redraw() { if (!redrawQueued) { redrawQueued = true; requestAnimationFrame(() => { redrawQueued = false; draw(); }); } }
let tween = 0;
function setView(m, animate = false) {
  cancelAnimationFrame(tween);
  if (!animate) { S.vm = m; redraw(); return; }
  const from = S.vm, t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / 180), e = 1 - (1 - t) ** 3;
    S.vm = t === 1 ? m : from.map((v, i) => v + (m[i] - v) * e);
    draw();
    if (t < 1) tween = requestAnimationFrame(step);
  };
  tween = requestAnimationFrame(step);
}
function zoomBy(k, at) {
  const z = scaleOf(S.vm);
  k = Math.min(MAX_ZOOM / z, k);
  setView(settle(mul(around(at, k, 0), S.vm)), true);
}

/**
 * Where a gesture comes to rest: a turn within 8 deg of a quarter turn snaps to it, zoomed
 * out past the fit goes back to it, nearly the fit is the fit, and the picture is kept on
 * the screen (centred on an axis where it is smaller than the screen, edge to edge where
 * it is larger).
 */
function settle(m) {
  const W = innerWidth, H = innerHeight, mid = [W / 2, H / 2];
  const a = angleOf(m), q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
  if (Math.abs(a - q) < (8 * Math.PI) / 180) m = mul(around(mid, 1, q - a), m);
  if (scaleOf(m) < 1) m = mul(around(mid, 1 / scaleOf(m), 0), m);
  if (scaleOf(m) < 1.04 && Math.abs(angleOf(m)) < 0.01) return ID;
  const f = fit(S.frozen.w, S.frozen.h, false), full = mul(m, f.m);
  const c = [[0, 0], [S.frozen.w, 0], [S.frozen.w, S.frozen.h], [0, S.frozen.h]].map((p) => apply(full, p));
  const bb = aabb(c);
  const shift = (lo, hi, size) => (hi - lo <= size ? size / 2 - (lo + hi) / 2 : lo > 0 ? -lo : hi < size ? size - hi : 0);
  const dx = shift(bb[0], bb[2], W), dy = shift(bb[1], bb[3], H);
  return dx || dy ? mul([1, 0, 0, 1, dx, dy], m) : m;
}

const G = { pts: new Map(), moved: false, swallow: false, rotOn: false, rotAcc: 0, lastTap: null, wheelEnd: 0 };
const stage = $('stage');
stage.addEventListener('pointerdown', (e) => {
  if (S.view !== 'frozen' || S.crop || !S.frozen) return;
  cancelAnimationFrame(tween);
  stage.setPointerCapture(e.pointerId);
  // a new gesture: a pinch by touch leaves no click to swallow, so the flag starts clear
  if (!G.pts.size) { G.moved = false; G.swallow = false; G.rotOn = false; G.rotAcc = 0; G.down = [e.clientX, e.clientY]; }
  if (G.pts.size === 1) G.moved = true;   // a second finger: a pinch, not a tap
  G.pts.set(e.pointerId, [e.clientX, e.clientY]);
});
stage.addEventListener('pointermove', (e) => {
  const p = G.pts.get(e.pointerId);
  if (!p) return;
  const now = [e.clientX, e.clientY];
  if (G.pts.size === 1) {
    if (!G.moved && Math.hypot(now[0] - G.down[0], now[1] - G.down[1]) < 8) return;
    G.moved = true;
    S.vm = mul([1, 0, 0, 1, now[0] - p[0], now[1] - p[1]], S.vm);
  } else if (G.pts.size === 2) {
    const other = [...G.pts.entries()].find(([id]) => id !== e.pointerId)[1];
    const d0 = [p[0] - other[0], p[1] - other[1]], d1 = [now[0] - other[0], now[1] - other[1]];
    let k = Math.hypot(...d1) / Math.max(1, Math.hypot(...d0));
    let a = Math.atan2(d1[1], d1[0]) - Math.atan2(d0[1], d0[0]);
    if (a > Math.PI) a -= 2 * Math.PI; else if (a < -Math.PI) a += 2 * Math.PI;
    // a pinch turns the picture only once the fingers have turned 12 deg, so zooming doesn't tilt it
    if (!G.rotOn) { G.rotAcc += a; if (Math.abs(G.rotAcc) > (12 * Math.PI) / 180) G.rotOn = true; a = 0; }
    k = Math.min(MAX_ZOOM / scaleOf(S.vm), k);
    const c0 = [(p[0] + other[0]) / 2, (p[1] + other[1]) / 2], c1 = [(now[0] + other[0]) / 2, (now[1] + other[1]) / 2];
    S.vm = mul(around(c0, k, a, c1[0] - c0[0], c1[1] - c0[1]), S.vm);
  }
  G.pts.set(e.pointerId, now);
  redraw();
});
const lift = (e) => {
  if (!G.pts.delete(e.pointerId) || G.pts.size) return;
  if (G.moved) { G.swallow = true; setView(settle(S.vm), true); return; }
  // a double tap zooms in on that point, or back out to the fit
  const now = performance.now(), at = [e.clientX, e.clientY];
  if (G.lastTap && now - G.lastTap.t < 320 && Math.hypot(at[0] - G.lastTap.at[0], at[1] - G.lastTap.at[1]) < 32) {
    G.lastTap = null; G.swallow = true;
    if (scaleOf(S.vm) > 1.05) setView(ID, true); else zoomBy(2.5, at);
  } else G.lastTap = { t: now, at };
};
stage.addEventListener('pointerup', lift);
stage.addEventListener('pointercancel', lift);
stage.addEventListener('wheel', (e) => {
  if (S.view !== 'frozen' || S.crop || !S.frozen) return;
  e.preventDefault();
  const at = [e.clientX, e.clientY];
  // a trackpad pinch comes as a wheel with ctrlKey; a wheel or two-finger scroll pans, unless ctrl or alt
  if (e.ctrlKey || e.altKey || e.deltaMode) {
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002) * (e.deltaMode ? 33 : 1));
    S.vm = mul(around(at, Math.min(MAX_ZOOM / scaleOf(S.vm), k), 0), S.vm);
  } else S.vm = mul([1, 0, 0, 1, -e.deltaX, -e.deltaY], S.vm);
  redraw();
  clearTimeout(G.wheelEnd);
  G.wheelEnd = setTimeout(() => setView(settle(S.vm), true), 250);
}, { passive: false });
addEventListener('resize', () => { if (S.view === 'frozen' && S.frozen) S.vm = settle(S.vm); });

// ---- edits: turn a quarter, crop; each is read again ----

/**
 * The frozen picture drawn through `m` (picture pixels -> the new picture's pixels) on a
 * w x h canvas, as a new picture to read. A picture made from a crop of a turned view is
 * straight. Outside the old picture is mid grey.
 */
async function remake(m, w, h, { straighten = false } = {}) {
  if (!S.orig) { const c = document.createElement('canvas'); c.width = still.width; c.height = still.height; c.getContext('2d').drawImage(still, 0, 0); S.orig = c; }
  const c = document.createElement('canvas');
  c.width = Math.max(16, Math.round(w)); c.height = Math.max(16, Math.round(h));
  const g = c.getContext('2d');
  const paint = (mm) => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#808080'; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    g.setTransform(...mm);
    g.drawImage(still, 0, 0);
  };
  paint(m);
  // a small crop is scaled up for the detector no more than 2 times: blown up to 1280 px, a
  // crop of a line or two gives the detector characters far larger than it was trained on
  const detLong = Math.min(FREEZE_DET, Math.max(640, 2 * Math.max(c.width, c.height)));
  if (straighten) {
    // the detector reads level text best: find the lines' angle with a pass that only finds
    // them, and turn the crop about its middle by that much. The picture around the crop
    // fills the corners the turn opens, where there is any.
    status(`${S.ep} · straightening…`);
    $('shutter').classList.add('busy'); draw();
    const probe = await createImageBitmap(c);
    let t = null;
    try { t = skewOf((await call({ type: 'frame', id: ++S.frame, bitmap: probe, detLong, read: false }, [probe])).lines); }
    catch (err) { trace('crop skew: ' + err.message); }
    trace(`crop skew ${t == null ? 'none' : ((t * 180) / Math.PI).toFixed(1) + ' deg'}`);
    if (t != null && Math.abs(t) > (1.5 * Math.PI) / 180) paint(mul(around([c.width / 2, c.height / 2], 1, -t), m));
  }
  const bitmap = await createImageBitmap(c);
  c.width = c.height = 0;
  await freeze(bitmap, { edited: true, detLong });
}

$('rotBtn').onclick = () => {
  if (S.view !== 'frozen' || !S.frozen) return;
  const { w, h } = S.frozen;
  remake([0, 1, -1, 0, h, 0], h, w);   // clockwise: (x, y) -> (h - y, x)
};
$('revertBtn').onclick = async () => {
  if (!S.orig) return;
  const o = S.orig;
  const bitmap = await createImageBitmap(o);
  S.orig = null;
  await freeze(bitmap);
};
$('fitBtn').onclick = () => setView(ID, true);

// The crop box, on screen: drag a corner or an edge to size it, the inside to move it.
const cropEl = $('crop'), box = cropEl.querySelector('.box');
function showCrop() {
  const r = S.crop;
  box.style.left = r.x + 'px'; box.style.top = r.y + 'px'; box.style.width = r.w + 'px'; box.style.height = r.h + 'px';
}
function endCrop() { if (!S.crop) return; S.crop = null; cropEl.hidden = true; $('cropBar').hidden = true; $('controls').hidden = !S.stream; redraw(); }
$('cropBtn').onclick = () => {
  if (S.view !== 'frozen' || !S.frozen) return;
  closeSheet();
  // start from the picture as it shows, inside the screen's edge
  const f = frame(), W = innerWidth, H = innerHeight, pad = 24;
  const c = [[0, 0], [S.frozen.w, 0], [S.frozen.w, S.frozen.h], [0, S.frozen.h]].map((p) => apply(f.m, p));
  const bb = aabb(c);
  const x0 = Math.max(pad, bb[0]), y0 = Math.max(pad + 56, bb[1]), x1 = Math.min(W - pad, bb[2]), y1 = Math.min(H - pad - 70, bb[3]);
  S.crop = { x: x0, y: y0, w: Math.max(60, x1 - x0), h: Math.max(60, y1 - y0) };
  cropEl.hidden = false; $('cropBar').hidden = false; $('controls').hidden = true;
  showCrop(); redraw();
};
let cropDrag = null;
cropEl.addEventListener('pointerdown', (e) => {
  if (!S.crop) return;
  const r = S.crop, x = e.clientX, y = e.clientY, near = 28;
  const side = { l: Math.abs(x - r.x) < near, r: Math.abs(x - (r.x + r.w)) < near, t: Math.abs(y - r.y) < near, b: Math.abs(y - (r.y + r.h)) < near };
  const inX = x > r.x - near && x < r.x + r.w + near, inY = y > r.y - near && y < r.y + r.h + near;
  if (!(inX && inY)) return;
  const edge = (side.l || side.r || side.t || side.b);
  cropDrag = { id: e.pointerId, at: [x, y], start: { ...r }, side: edge ? side : null };
  cropEl.setPointerCapture(e.pointerId);
  e.preventDefault();
});
cropEl.addEventListener('pointermove', (e) => {
  if (!cropDrag || cropDrag.id !== e.pointerId) return;
  const dx = e.clientX - cropDrag.at[0], dy = e.clientY - cropDrag.at[1], s0 = cropDrag.start, min = 40;
  const W = innerWidth, H = innerHeight;
  let { x, y, w, h } = s0;
  if (!cropDrag.side) { x = Math.min(W - w, Math.max(0, s0.x + dx)); y = Math.min(H - h, Math.max(0, s0.y + dy)); }
  else {
    const sd = cropDrag.side;
    if (sd.l) { x = Math.min(s0.x + s0.w - min, Math.max(0, s0.x + dx)); w = s0.x + s0.w - x; }
    if (sd.r) w = Math.min(W - s0.x, Math.max(min, s0.w + dx));
    if (sd.t) { y = Math.min(s0.y + s0.h - min, Math.max(0, s0.y + dy)); h = s0.y + s0.h - y; }
    if (sd.b) h = Math.min(H - s0.y, Math.max(min, s0.h + dy));
  }
  S.crop = { x, y, w, h };
  showCrop();
});
const cropUp = (e) => { if (cropDrag && cropDrag.id === e.pointerId) cropDrag = null; };
cropEl.addEventListener('pointerup', cropUp);
cropEl.addEventListener('pointercancel', cropUp);
$('cropCancel').onclick = endCrop;
$('cropOk').onclick = () => {
  if (!S.crop || !S.frozen) return;
  const r = S.crop, f = frame();
  // the new picture at the old one's resolution (screen pixels per picture pixel = f.s),
  // no larger than a photo is read at
  let k = 1 / f.s;
  k = Math.min(k, MAX_PHOTO / Math.max(r.w, r.h));
  const m = mul([k, 0, 0, k, -r.x * k, -r.y * k], f.m);
  endCrop();
  remake(m, r.w * k, r.h * k, { straighten: true });
};

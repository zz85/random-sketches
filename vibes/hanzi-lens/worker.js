/*
 * worker.js - runs the two PP-OCRv5 mobile models on ONNX Runtime Web (WebGPU when the
 * device has it, WASM otherwise), off the main thread.
 *
 * Messages in:
 *   { type: 'init', ep? }                               -> { type: 'ready', ep, ms }
 *   { type: 'frame', id, bitmap, detLong, read }        -> { type: 'lines', id, w, h, lines, ms }
 *       read: true reads every line found; false only finds them (live view). The frame's
 *       pixels are kept, so the main thread can ask for some of its lines next:
 *   { type: 'read', id, quads: [{key, quad}] }          -> { type: 'read', id, results: [{key, text, ...}] }
 *       (answered with results: null when a newer frame has replaced frame `id`)
 * A line: { quad, vertical, score, text?, confidence?, chars?: [{ch, pos}] }
 */
import { detSize, detSizeStretched, detTensor, dbBoxes, readingOrder, recTensor, ctcDecode, parseRecDict, mergeGrid, bands } from './ocr.js';

const GRID_STRETCH = 1.5;   // vertical stretch of the second pass, for dense grids (see mergeGrid)
import { ORT_URL, ORT_DIST, MODELS } from './assets.js';

let ort, det, rec, recDict, ep;
// steps of the work, for the crash trace the page keeps (a tab the OS kills leaves no log)
const trace = (step) => self.postMessage({ type: 'trace', step });
let last = null;   // { id, img }

async function init(want) {
  const t0 = performance.now();
  const gpu = want !== 'wasm' && typeof navigator !== 'undefined' && navigator.gpu && (await navigator.gpu.requestAdapter().catch(() => null));
  ort = await import(gpu ? ORT_URL.webgpu : ORT_URL.wasm);
  ort.env.wasm.wasmPaths = ORT_DIST;
  ort.env.logLevel = 'error';   // ORT's warnings about unused initialisers and CPU shape ops are expected
  if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;
  const [detBuf, recBuf, yml] = await Promise.all([
    fetch(MODELS.det).then((r) => r.arrayBuffer()),
    fetch(MODELS.rec).then((r) => r.arrayBuffer()),
    fetch(MODELS.recYml).then((r) => r.text()),
  ]);
  recDict = parseRecDict(yml);
  trace(`models fetched, creating sessions (${gpu ? 'webgpu' : 'wasm'})`);
  // logSeverityLevel 3: errors only (the load-time warnings about unused initialisers and
  // shape ops kept on the CPU are expected)
  const opts = { graphOptimizationLevel: 'all', logSeverityLevel: 3 };
  const make = async (buf) => {
    if (gpu) {
      try { return { s: await ort.InferenceSession.create(buf, { ...opts, executionProviders: ['webgpu'] }), ep: 'webgpu' }; }
      catch (e) { console.warn('WebGPU session failed, using WASM', e); }
    }
    return { s: await ort.InferenceSession.create(buf, { ...opts, executionProviders: ['wasm'] }), ep: 'wasm' };
  };
  const d = await make(detBuf);
  trace(`detector session ${d.ep}`);
  const r = await make(recBuf);
  trace(`recogniser session ${r.ep}`);
  det = d.s; rec = r.s; ep = d.ep === r.ep ? d.ep : `${d.ep}+${r.ep}`;
  return { ep, ms: Math.round(performance.now() - t0), chars: recDict.length };
}

// One canvas per use, reused: Safari counts canvas memory against a low limit and frees a
// dropped canvas's memory late, so a new canvas per frame runs out of it in the live view.
const canvases = new Map();
function pixels(bitmap, w, h, use) {
  let c = canvases.get(use);
  if (!c) { c = new OffscreenCanvas(w, h); canvases.set(use, c); }
  else if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  g.drawImage(bitmap, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}

async function detPass(img, { w, h }) {
  trace(`detect ${w}x${h}`);
  const small = pixels(img.bitmap, w, h, `det${w}`);
  const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', detTensor(small), [1, 3, h, w]) });
  const map = out[det.outputNames[0]];
  const [, , mh, mw] = map.dims;
  const prob = await map.getData();
  map.dispose?.();
  return dbBoxes(prob, mw, mh, img.width / mw, img.height / mh);
}

/**
 * The stretched pass, run in bands of the first pass's size. A larger input crashed iOS
 * Safari's WebGPU (iPhone, iOS 18.7: the tab died at a 1280x1216 pass after a 1280x800 one),
 * and the same shape lets ONNX Runtime reuse the first pass's buffers.
 */
async function detBands(img, base, { w, h }) {
  const whole = pixels(img.bitmap, w, h, 'stretched');
  const boxes = [];
  for (const b of bands(h, Math.min(base.h, h))) {
    const bh = Math.min(base.h, h);
    trace(`detect band ${w}x${bh} at ${b.y0} of ${h}`);
    const band = { data: whole.data.subarray(b.y0 * w * 4, (b.y0 + bh) * w * 4), width: w, height: bh };
    const out = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', detTensor(band), [1, 3, bh, w]) });
    const map = out[det.outputNames[0]];
    const prob = await map.getData();
    map.dispose?.();
    // a region touching an inner edge of the band is cut there: the next band has it whole
    const cutTop = b.y0 > 0, cutBottom = b.y0 + bh < h;
    for (const x of dbBoxes(prob, w, bh, img.width / w, img.height / h, { oy: b.y0 })) {
      if ((cutTop && x.mapY0 <= b.y0) || (cutBottom && x.mapY1 >= b.y0 + bh - 1)) continue;
      if (x.mapCy >= b.core0 && x.mapCy < b.core1) boxes.push(x);
    }
  }
  return boxes;
}

async function detect(img, detLong) {
  const base = detSize(img.width, img.height, detLong);
  let boxes = await detPass(img, base);
  // columns may be rows of a dense grid read the wrong way: check with a stretched pass
  if (boxes.some((b) => b.vertical)) boxes = mergeGrid(boxes, await detBands(img, base, detSizeStretched(img.width, img.height, detLong, GRID_STRETCH)));
  return readingOrder(boxes);
}

// The full-resolution pixels (8 MB for a 1080p frame) are read only when a line is: the live
// view sends a frame every few hundred ms and reads lines from few of them.
function fullPixels(img) {
  if (!img.data) img.data = pixels(img.bitmap, img.width, img.height, 'full').data;
  return img;
}

async function read(img, quad) {
  const { tensor, width, used } = recTensor(fullPixels(img), quad);
  const out = await rec.run({ [rec.inputNames[0]]: new ort.Tensor('float32', tensor, [1, 3, 48, width]) });
  const t = out[rec.outputNames[0]];
  const [, T, C] = t.dims;
  const probs = await t.getData();
  t.dispose?.();
  return ctcDecode(probs, T, C, recDict, width, used);
}

let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));   // one model call at a time

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    serial(() => init(m.ep).then((r) => self.postMessage({ type: 'ready', ...r }), (err) => self.postMessage({ type: 'error', message: String(err && err.message || err) })));
  } else if (m.type === 'frame') {
    serial(async () => {
      try {
        const t0 = performance.now();
        const { bitmap } = m;
        const img = { data: null, width: bitmap.width, height: bitmap.height, bitmap };
        const boxes = await detect(img, m.detLong);
        const tDet = performance.now() - t0;
        const lines = [];
        if (m.read) trace(`${boxes.length} boxes, reading`);
        for (const [k, b] of boxes.entries()) {
          const line = { quad: b.quad, vertical: b.vertical, score: b.score };
          if (m.read && k % 10 === 0) trace(`read line ${k + 1}/${boxes.length}`);
          if (m.read) Object.assign(line, await read(img, b.quad));
          if (!m.read || line.text) lines.push(line);
        }
        if (last && last.img.bitmap !== bitmap) { last.img.bitmap.close?.(); last.img.data = null; }
        last = { id: m.id, img };
        self.postMessage({ type: 'lines', id: m.id, w: img.width, h: img.height, lines, ms: Math.round(performance.now() - t0), detMs: Math.round(tDet) });
      } catch (err) {
        self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
      }
    });
  } else if (m.type === 'read') {
    serial(async () => {
      if (!last || last.id !== m.id) { self.postMessage({ type: 'read', id: m.id, results: null }); return; }
      const t0 = performance.now(), results = [];
      for (const q of m.quads) results.push({ key: q.key, ...(await read(last.img, q.quad)) });
      self.postMessage({ type: 'read', id: m.id, results, ms: Math.round(performance.now() - t0) });
    });
  }
};

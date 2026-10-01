// Recognition off the main thread, three jobs:
//  { gray, w, h, f }          -> analysis model (A maps normalized -> the UI image's pixels)
//  { probe, gray, w, h }      -> staff count and page coverage, cheap (opening a PDF)
//  { page, bitmap, opts, q }  -> a whole export page: recognise + rewrite + JPEG, all here with
//                                OffscreenCanvas; pages without staves come back as they are
import { normalize, analyze, findStaves } from './omr.js';
import { sauvola, staffMetrics } from './imgproc.js';
import { Renderer, plan } from './render.js';

function probeGray(gray, w, h) {
  const b = sauvola({ w, h, data: gray }, 31, 0.2, 'wolf', 0), m = staffMetrics(b);
  const st = m.space >= 4 && m.votes >= 20 ? findStaves(b, m.space, Math.max(1, m.thick)) : [];
  // fraction of the page height the staves span (a music example in a preface is small)
  const cover = st.length ? (st[st.length - 1].pts[0].ys[4] - st[0].pts[0].ys[0]) / h : 0;
  return { staves: st.length, cover };
}
function analyzeGray(gray, w, h, f, opts) {
  const t0 = performance.now();
  const norm = normalize({ w, h, data: gray });
  const model = analyze(norm, opts || {});
  model.A = model.A.map((v) => v / f);
  model.scale *= f;
  model.ms = performance.now() - t0;
  model.noise = norm.noise;
  return model;
}
const toGray = (rgba, n) => { const g = new Uint8Array(n); for (let i = 0; i < n; i++) g[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8; return g; };

async function exportPage({ bitmap, opts, q = 0.8 }) {
  const W = bitmap.width, H = bitmap.height, img = new OffscreenCanvas(W, H);
  img.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close();
  const jpeg = async (c) => new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: q })).arrayBuffer());
  // analysis copy at most ~2400 px, like the interactive path
  const f = Math.min(1, 2400 / Math.max(W, H)), aw = Math.round(W * f), ah = Math.round(H * f);
  const ac = new OffscreenCanvas(aw, ah), a2 = ac.getContext('2d', { willReadFrequently: true });
  a2.drawImage(img, 0, 0, aw, ah);
  const gray = toGray(a2.getImageData(0, 0, aw, ah).data, aw * ah);
  // text-only pages (covers, prefaces) take seconds to analyse and contain nothing to move
  const pr = probeGray(gray, aw, ah);
  if (!pr.staves) return { jpeg: await jpeg(img), w: W, h: H, music: false };
  try {
    const model = analyzeGray(gray, aw, ah, f, {});
    const r = new Renderer(img, model), out = new OffscreenCanvas(1, 1);
    r.render(out.getContext('2d'), plan(model, opts));
    return { jpeg: await jpeg(out), w: out.width, h: out.height, music: true, staves: model.staves.length };
  } catch (e) {
    return { jpeg: await jpeg(img), w: W, h: H, music: false };
  }
}

self.onmessage = async (ev) => {
  const d = ev.data;
  if (d.page) {
    try { const r = await exportPage(d); self.postMessage(r, [r.jpeg.buffer]); }
    catch (e) { self.postMessage({ error: e.message || String(e) }); }
    return;
  }
  if (d.probe) {
    try { self.postMessage(probeGray(d.gray, d.w, d.h)); } catch (e) { self.postMessage({ staves: 0, cover: 0 }); }
    return;
  }
  try {
    const model = analyzeGray(d.gray, d.w, d.h, d.f, d.opts);
    for (const n of model.notes) n.si = n.st.index;
    self.postMessage({ model }, [model.labels.buffer, model.bin.buffer]);
  } catch (e) {
    self.postMessage({ error: e.message || String(e) });
  }
};

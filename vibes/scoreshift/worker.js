// Recognition off the main thread. In: { gray, w, h, f } (f = analysis scale relative to the
// image the UI holds). Out: the analysis model, with A mapping normalized -> UI image pixels.
import { normalize, analyze, findStaves } from './omr.js';
import { sauvola, staffMetrics } from './imgproc.js';

self.onmessage = (ev) => {
  const { gray, w, h, f, opts, probe } = ev.data;
  if (probe) { // cheap: how many staves does this (low-resolution) page have?
    try {
      const b = sauvola({ w, h, data: gray }, 31, 0.2, 'wolf', 0), m = staffMetrics(b);
      const st = m.space >= 4 && m.votes >= 20 ? findStaves(b, m.space, Math.max(1, m.thick)) : [];
      // fraction of the page height the staves span (a music example in a preface is small)
      const cover = st.length ? (st[st.length - 1].pts[0].ys[4] - st[0].pts[0].ys[0]) / h : 0;
      self.postMessage({ staves: st.length, cover });
    } catch (e) { self.postMessage({ staves: 0, cover: 0 }); }
    return;
  }
  try {
    const t0 = performance.now();
    const norm = normalize({ w, h, data: gray });
    const model = analyze(norm, opts || {});
    model.A = model.A.map((v) => v / f);
    model.scale *= f;
    model.ms = performance.now() - t0;
    model.noise = norm.noise;
    for (const n of model.notes) n.si = n.st.index;
    self.postMessage({ model }, [model.labels.buffer, model.bin.buffer]);
  } catch (e) {
    self.postMessage({ error: e.message || String(e) });
  }
};

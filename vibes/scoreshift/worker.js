// Recognition off the main thread. In: { gray, w, h, f } (f = analysis scale relative to the
// image the UI holds). Out: the analysis model, with A mapping normalized -> UI image pixels.
import { normalize, analyze } from './omr.js';

self.onmessage = (ev) => {
  const { gray, w, h, f, opts } = ev.data;
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

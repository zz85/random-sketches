// Detection worker: keeps the page responsive while a frame is analysed.
// in:  { id, mode: 'detect' | 'track', rgba (transferred), w, h, prev?: { p, cx, cy }, opt }
// out: { id, ok, cam: { p, cx, cy, w, h }, tin, quality, ms } or { id, error }
import { detectCourt, trackCourt } from './detect.js';
import { Camera } from './camera.js';

const pack = (c) => c && { p: c.p, cx: c.cx, cy: c.cy, w: c.w, h: c.h };

self.onmessage = (e) => {
  const { id, mode, rgba, w, h, prev, opt = {} } = e.data;
  try {
    const r = mode === 'track' && prev
      ? trackCourt(rgba, w, h, new Camera(prev.p, w, h, prev.cx, prev.cy), opt)
      : detectCourt(rgba, w, h, opt);
    self.postMessage({ id, mode, ok: r.ok, cam: pack(r.cam), tin: r.tin, quality: { coverage: r.coverage, recall: r.recall, rms: r.rms, score: r.score, good: r.good, matched: r.matched }, ms: r.ms });
  } catch (err) {
    self.postMessage({ id, mode, error: String(err && err.stack || err) });
  }
};

// Detection worker: keeps the page responsive while a frame is analysed.
// in:  { id, mode: 'detect' | 'track', rgba (transferred), w, h, prev?: { p, cx, cy }, opt }
// out: { id, ok, cam: { p, cx, cy, w, h }, tin, quality, ms, path } or { id, error }
// Tracking tries the sparse tracker first (track.js: line profiles at the frame's resolution, a
// camera on a fixed mount held still), and falls back to the full tracker when it loses the court.
// path says which ran: 'static' | 'moving' (sparse), 'recall' (back to a camera seen earlier),
// 'full', or 'detect'.
import { detectCourt, trackCourt } from './detect.js';
import { createTracker, resetTracker, trackFrame, recallShot } from './track.js';
import { Camera } from './camera.js';

const pack = (c) => c && { p: c.p, cx: c.cx, cy: c.cy, w: c.w, h: c.h };
const tracker = createTracker();
const reset = (cam, tin, opt) => { resetTracker(tracker, cam, tin); if (opt.fixedMount === false) tracker.mount = 'free'; };

self.onmessage = (e) => {
  const { id, mode, rgba, w, h, prev, opt = {} } = e.data;
  try {
    let r, path;
    if (mode === 'track' && prev) {
      const cam = new Camera(prev.p, w, h, prev.cx, prev.cy);
      if (tracker.tin !== (opt.tin ?? tracker.tin) || !tracker.anchor) reset(cam, opt.tin, opt);
      r = trackFrame(rgba, w, h, cam, tracker, opt); path = r.path;
    } else {
      // after a cut, the cameras this video has already shown are tried first (a millisecond each)
      const back = opt.recall && recallShot(rgba, w, h, tracker, opt);
      if (back) { r = { ...back, ms: { total: back.ms } }; path = 'recall'; }
      else {
        if (!opt.recall) tracker.shots = []; // a new picture or a requested re-detection
        r = detectCourt(rgba, w, h, opt); path = 'detect';
        if (r.ok) reset(r.cam, r.tin, opt);
      }
    }
    self.postMessage({ id, mode, path, ok: r.ok, cam: pack(r.cam), tin: r.tin, quality: { coverage: r.coverage, recall: r.recall, rms: r.rms, score: r.score, good: r.good, matched: r.matched }, ms: r.ms, mount: tracker.mount });
  } catch (err) {
    self.postMessage({ id, mode, error: String(err && err.stack || err) });
  }
};

// Score-bug OCR (ocr.js) beside the other workers, so reading the names never slows the tracking.
// in:  { id, t, rgba (transferred), w, h }   a 1280 px frame (the bug's letters are small)
// out: { id, t, read: { left, right, err, leftErr, rightErr, rect } | null, ms } or { id, error }
import { findOverlays } from './overlays.js';
import { makeGlyphs, playerNames } from './ocr.js';

const glyphs = makeGlyphs();

self.onmessage = (e) => {
  const { id, t, rgba, w, h } = e.data;
  try {
    const t0 = performance.now(), r = playerNames(rgba, w, h, findOverlays(rgba, w, h), glyphs);
    self.postMessage({ id, t, read: r && { left: r.left, right: r.right, err: r.err, leftErr: r.leftErr, rightErr: r.rightErr, rect: r.rect }, ms: performance.now() - t0 });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};

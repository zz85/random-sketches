// worker.js - designs a surface off the main thread: { lum, n, opts } in; progress (with a thinned copy of the
// moving mesh, for the preview) and then { h, relief, centre } out.
import { targetAreas, transport, resampleMap, solveHeights } from './ot.js';

self.onmessage = (e) => {
  const { id, lum, n, opts } = e.data, t0 = performance.now();
  const t = targetAreas(lum, n, opts.floor ?? 0.05), m = n + 1, every = Math.max(1, n / 32);
  let last = 0;
  const tr = transport(t, n, {
    maxIter: opts.maxIter ?? 400, tol: opts.tol ?? 0.02,
    onStep: (it, err, V) => {
      const now = performance.now(); if (now - last < 60 && it > 0) return; last = now;
      // every `every`th grid line, enough to see the mesh flow
      const k = n / every + 1, g = new Float32Array(2 * k * k);
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) { const v = 2 * (j * every * m + i * every); g[2 * (j * k + i)] = V[v]; g[2 * (j * k + i) + 1] = V[v + 1]; }
      self.postMessage({ id, type: 'progress', it, err, grid: g, k }, [g.buffer]);
    },
  });
  self.postMessage({ id, type: 'progress', it: tr.iters, err: tr.err, phase: 'heights' });
  const M = resampleMap(tr.V, n);
  const { h, relief, centre } = solveHeights(M, n, opts);
  const out = Float32Array.from(h);
  self.postMessage({ id, type: 'done', h: out, relief, centre, iters: tr.iters, err: tr.err, ms: performance.now() - t0 }, [out.buffer]);
};

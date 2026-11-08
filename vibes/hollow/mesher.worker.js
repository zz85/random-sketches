// mesher.worker.js - builds a piece's mesh off the main thread (module worker).
import { buildMesh } from './sdf.js';

self.onmessage = (e) => {
  const { id, spec, N, vis } = e.data;
  try {
    const t0 = performance.now();
    const m = buildMesh(spec, N, { vis });
    m.ms = performance.now() - t0;
    self.postMessage({ id, N, mesh: m }, [m.position.buffer, m.normal.buffer, m.ao.buffer, m.curv.buffer, m.index.buffer]);
  } catch (err) {
    self.postMessage({ id, N, error: String(err && err.stack || err) });
  }
};

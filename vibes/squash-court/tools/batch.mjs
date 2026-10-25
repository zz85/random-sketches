// node tools/batch.mjs <out dir> <images...> — detect in many frames on all cores; writes an
// overlay per frame (cyan lines when confident, orange when not, nothing when no court) and
// results.json { file: { ok, C, hfov, tin, coverage, ms } }.
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

if (isMainThread) {
  const [out, ...files] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const n = Math.min(files.length, Math.max(1, os.cpus().length - 1)), results = {};
  const chunks = Array.from({ length: n }, (_, i) => files.filter((_, k) => k % n === i));
  await Promise.all(chunks.map((list) => new Promise((res, rej) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { out, list } });
    w.on('message', (m) => { results[m.file] = m; console.log(`${path.basename(m.file)} ok=${m.ok} cov=${m.coverage?.toFixed(2)} C=[${m.C?.map((v) => v.toFixed(1))}] hfov=${m.hfov?.toFixed(0)} ${Math.round(m.ms)}ms`); });
    w.on('error', rej); w.on('exit', res);
  })));
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 1));
} else {
  const { readImage, writeImage, drawSeg } = await import('./nodeimg.js');
  const { detectCourt } = await import('../detect.js');
  const { courtModel } = await import('../court.js');
  for (const f of workerData.list) {
    const img = readImage(f), r = detectCourt(img.data, img.width, img.height);
    if (r.cam && r.coverage > 0.3) {
      const m = courtModel({ tin: r.tin }), col = r.ok ? [0, 255, 255] : [255, 140, 0];
      for (const e of m.edges) drawSeg(img, r.cam, e.a, e.b, r.ok ? [255, 255, 0] : [255, 140, 0], 1);
      for (const l of m.lines) if (!(l.kind === 'back' && r.cam.C[1] > 9.45)) drawSeg(img, r.cam, l.a, l.b, col, 2);
    }
    writeImage(path.join(workerData.out, path.basename(f).replace(/\.\w+$/, '.jpg')), img);
    parentPort.postMessage({ file: f, ok: r.ok, matched: r.matched, lines: r.lines?.map((l) => l.name + ':' + l.vis.toFixed(2) + '/' + l.frac.toFixed(2)).join(' '), coverage: r.coverage, recall: r.recall, C: r.cam?.C, hfov: r.cam?.hfov(), tin: r.tin, ms: r.ms.total });
  }
}

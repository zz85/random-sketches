// WebGPU check: reads the sample twice on ?ep=webgpu in headless Chromium (SwiftShader or lavapipe,
// so the timings are meaningless) and prints the crash trace, to see that the GPU sessions are
// released after each full read and made again for the next. node tools/gpu-smoke.mjs
import http from 'http'; import fs from 'fs'; import path from 'path';
import { launch, waitFor, sleep } from '../../orrery/cdp.js';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..'), PORT = 8813;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.gz': 'application/gzip', '.css': 'text/css', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => { const u = decodeURIComponent(new URL(req.url, 'http://x').pathname); const f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
await new Promise((r) => server.listen(PORT, r));
const b = await launch({ port: 9371, width: 1000, height: 760 });
console.log('lavapipe', b.lavapipe);
try {
  await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/hanzi-lens/?ep=webgpu` });
  await waitFor(() => b.evaluate('!!window.__hl'), 10000);
  for (let k = 0; k < 2; k++) {
    const t0 = Date.now();
    if (k === 0) await b.evaluate(`document.getElementById('sampleBtn').click()`);
    else await b.evaluate(`fetch('sample.jpg').then(r=>r.blob()).then(createImageBitmap).then(bm=>__hl.freeze(bm))`).catch(e=>console.log('freeze?', e.message));
    await sleep(500);
    await waitFor(() => b.evaluate(`__hl.S.view==='frozen' && __hl.S.frozen.lines.length>0 && !document.getElementById('shutter').classList.contains('busy')`), 300000);
    const r = await b.evaluate(`({ep:__hl.S.ep, n:__hl.S.frozen.lines.length, ms:__hl.S.frozen.ms, text:__hl.S.frozen.lines.map(l=>l.text).join('|')})`);
    console.log(`read ${k+1}:`, (Date.now()-t0)+'ms', JSON.stringify(r));
  }
  const tr = await b.evaluate(`JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.includes('trace')))).steps.join('\\n')`);
  console.log(tr);
  const errs = b.events.filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && /error|warn/.test(e.params.type))).map(e => JSON.stringify(e.params.args?.map(a=>a.value??a.description) || e.params.exceptionDetails?.text).slice(0,200));
  console.log('console warn/err:', errs.slice(0,8));
} finally { b.kill(); server.close(); }

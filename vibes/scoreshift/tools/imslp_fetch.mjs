// Fetch IMSLP files and render PDF pages for tools/imslp_eval.js.
//   node tools/imslp_fetch.mjs <outdir> <imslp index id>...        download (PDF, ZIP, MID...)
//   node tools/imslp_fetch.mjs --render file.pdf <outdir> [px=2400] [pages e.g. 2-25]
// IMSLP's wiki redirects non-browsers, and a browser first gets a disclaimer page, so index ids
// (the #NNNNNN on a work page) are resolved to direct file URLs in headless Chromium; the file
// itself is then downloaded directly. Please keep request volume low: these are IMSLP's servers.
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from '../cdp.js';
import { encodeGray } from '../png.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

async function resolve(ids) {
  const b = await launch({ port: 9391 }), out = {};
  await b.send('Network.enable');
  const fileUrl = () => { for (const e of b.events) { const u = e.params?.request?.url || e.params?.response?.url; if (u && /\/files\/imglnks\//.test(u)) return u; } return null; };
  for (const id of ids) {
    b.events.length = 0;
    await b.send('Page.navigate', { url: `https://imslp.org/wiki/Special:ImagefromIndex/${id}` });
    let url = null;
    for (let i = 0; i < 40 && !url; i++) {
      await sleep(500);
      if ((url = fileUrl())) break;
      const acc = await b.evaluate(`([...document.querySelectorAll('a')].find(a=>/I understand/i.test(a.textContent))||{}).href||null`).catch(() => null);
      if (acc && i % 6 === 0) await b.send('Page.navigate', { url: acc });
      url = await b.evaluate(`([...document.querySelectorAll('a')].find(a=>/\\/files\\/imglnks\\//.test(a.href))||{}).href||null`).catch(() => null);
    }
    out[id] = url;
  }
  b.kill();
  return out;
}

async function render(file, outDir, px = 2400, sel) {
  fs.mkdirSync(outDir, { recursive: true });
  const srv = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/blank.html') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<!doctype html><title>r</title>'); }
    const f = u === '/doc.pdf' ? file : path.join(ROOT, u);
    if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': /\.m?js$/.test(f) ? 'text/javascript' : f.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' });
    fs.createReadStream(f).pipe(r);
  }).listen(8811);
  const b = await launch({ port: 9395 });
  await b.send('Page.navigate', { url: 'http://127.0.0.1:8811/blank.html' });
  await waitFor(() => b.evaluate('document.readyState==="complete"'), 10000);
  const M = `import('http://127.0.0.1:8811/pdfsource.js')`;
  const n = await b.evaluate(`(async()=>{const m=await ${M};window.D=await m.openPdf(await (await fetch('/doc.pdf')).blob());return D.numPages})()`);
  const pages = sel ? sel.split(',').flatMap((r) => { const [a, z] = r.split('-').map(Number); return Array.from({ length: (z || a) - a + 1 }, (_, i) => a + i); }) : Array.from({ length: n }, (_, i) => i + 1);
  for (const k of pages) {
    const d = await b.evaluate(`(async()=>{const m=await ${M};const {canvas:c}=await m.renderPage(D,${k},${px});const px=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      const u=new Uint8Array(c.width*c.height);for(let i=0;i<u.length;i++)u[i]=(px[i*4]*77+px[i*4+1]*150+px[i*4+2]*29)>>8;let s='';for(let i=0;i<u.length;i+=8192)s+=String.fromCharCode(...u.subarray(i,i+8192));return {w:c.width,h:c.height,d:btoa(s)}})()`);
    fs.writeFileSync(path.join(outDir, `p${String(k).padStart(3, '0')}.png`), encodeGray({ w: d.w, h: d.h, data: Uint8Array.from(Buffer.from(d.d, 'base64')) }));
  }
  b.kill(); srv.close();
  console.log(`${n} pages; ${pages.length} rendered at ${px}px to ${outDir}`);
}

if (args[0] === '--render') await render(args[1], args[2], +(args[3] || 2400), args[4]);
else {
  const [outDir, ...ids] = args; fs.mkdirSync(outDir, { recursive: true });
  const urls = await resolve(ids);
  for (const [id, u] of Object.entries(urls)) {
    if (!u) { console.log(id, 'not resolved'); continue; }
    const f = path.join(outDir, decodeURIComponent(u.split('/').pop()));
    const res = await fetch(u, { headers: { 'user-agent': 'ScoreShift-eval/1 (research; low volume)' } });
    fs.writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    console.log(id, '->', f, res.status, fs.statSync(f).size, 'bytes');
  }
}

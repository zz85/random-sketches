// Writes fixtures/parts.pdf: a text-only title page (no staves, like IMSLP's cover), then the
// minuet and flats engravings, one per Letter page, via Chromium's printToPDF.
//   node tools/make_pdf_fixture.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from '../cdp.js';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const img = (n) => `data:image/png;base64,${fs.readFileSync(path.join(ROOT, 'fixtures', n + '.png')).toString('base64')}`;
const html = `<style>@page{size:Letter;margin:0.5in} body{margin:0;font-family:serif} section{page-break-after:always;height:9.9in;display:flex;flex-direction:column;justify-content:center;align-items:center} img{width:100%}</style>
<section><h1 style="font-size:40px">Test Parts</h1><p>ScoreShift PDF fixture. This page has no music.</p></section>
<section><img src="${img('minuet')}"></section><section style="page-break-after:auto"><img src="${img('flats')}"></section>`;
const b = await launch({ port: 9361 });
await b.evaluate(`document.write(${JSON.stringify(html)}); document.close(); new Promise(r => setTimeout(r, 500))`);
const r = await b.send('Page.printToPDF', { printBackground: true, paperWidth: 8.5, paperHeight: 11, preferCSSPageSize: true });
fs.writeFileSync(path.join(ROOT, 'fixtures/parts.pdf'), Buffer.from(r.result.data, 'base64'));
console.log('fixtures/parts.pdf', Math.round(r.result.data.length * 0.75 / 1024), 'KB');
b.kill();

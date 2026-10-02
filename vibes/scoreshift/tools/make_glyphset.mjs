// Training pages for the glyph classifier experiment (tools/glyphnet.mjs): random tunes dense in
// accidentals, key signatures (up to 6 sharps / flats), clefs and rests, engraved by Verovio in
// the 5 fonts at random sizes. Disjoint from the evaluation fixtures (different tunes, seeds).
//   node tools/make_glyphset.mjs [pages=60] [out=/tmp/glyphset]
// Writes <out>/<k>.png (gray) and <out>/<k>.json { space, boxes: [{ cls, box }] } in page pixels.
import fs from 'fs';
import path from 'path';
import { launch } from '../cdp.js';
import { decodeGray, encodeGray } from '../png.js';
import { FONTS, toMEI } from './tunes.js';

const N = +(process.argv[2] || 60), OUT = process.argv[3] || '/tmp/glyphset';
const VER = process.env.VEROVIO || '/tmp/ssdev/node_modules/verovio';
const { default: createVerovioModule } = await import(path.join(VER, 'dist/verovio-module.mjs'));
const { VerovioToolkit } = await import(path.join(VER, 'dist/verovio.mjs'));
const VM = await createVerovioModule();
fs.mkdirSync(OUT, { recursive: true });
let seed = 977; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32), pick = (a) => a[Math.floor(rnd() * a.length)];
const ACC = { E262: 'sharp', E260: 'flat', E261: 'natural', E263: 'dsharp', E264: 'dflat' };
const REST = { E4E3: 'rest1', E4E4: 'rest2', E4E5: 'rest4', E4E6: 'rest8', E4E7: 'rest16', E4E8: 'rest32' };
const RANGE = { G: [26, 41], F: [14, 29], C: [20, 35] }; // diatonic indices (C4 = 28)

function tune() {
  const clef = pick(['G', 'G', 'F', 'C']), fifths = Math.floor(rnd() * 13) - 6, [lo, hi] = RANGE[clef];
  const bars = [];
  for (let b = 0; b < 8; b++) {
    const toks = []; let q = 0;
    while (q < 4) {
      const d = pick([4, 4, 8, 8, 2, 16]), len = 4 / d;
      if (q + len > 4) { toks.push(`r:${4 / (4 - q) >= 1 ? [1, 2, 4, 8, 16].find((x) => 4 / x <= 4 - q) : 16}`); break; }
      if (rnd() < 0.2) toks.push(`r:${d}`);
      else {
        const dd = lo + Math.floor(rnd() * (hi - lo + 1)), acc = rnd() < 0.45 ? pick(['#', 'b', 'n', '#', 'b', 'n', 'x', 'bb']) : '';
        toks.push(`${acc}${'cdefgab'[dd % 7]}${Math.floor(dd / 7)}:${d}`);
      }
      q += len;
    }
    bars.push(toks.join(' '));
  }
  return { clef, fifths, meter: [4, 4], src: bars.join(' | ') + ' |' };
}

const b = await launch({ port: 9344 });
for (let k = 0; k < N; k++) {
  const t = tune(), font = FONTS[k % FONTS.length], S = 13 + Math.floor(rnd() * 14);
  const tk = new VerovioToolkit(VM);
  tk.setOptions({ font, scale: Math.round((S / 18) * 100), pageWidth: 1900, pageHeight: 3000, adjustPageHeight: true, header: 'none', footer: 'none', breaks: 'auto' });
  if (!tk.loadData(toMEI(t))) continue;
  const svg = tk.renderToSVG(1);
  await b.evaluate(`document.body.style.margin='0';document.body.style.background='#fff';document.body.innerHTML=${JSON.stringify(svg)};1`);
  const size = await b.evaluate(`(()=>{const r=document.querySelector('svg').getBoundingClientRect();return [Math.ceil(r.width),Math.ceil(r.height)]})()`);
  await b.send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
  const boxes = await b.evaluate(`(()=>{const R=(e)=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom].map(v=>+v.toFixed(1))};const out=[];
    for (const u of document.querySelectorAll('g.keyAccid use, g.accid use, g.rest use, .notehead use')) out.push({g:u.getAttribute('xlink:href').slice(1,5),box:R(u),key:!!u.closest('g.keySig')});
    const l=[...document.querySelector('g.staff').querySelectorAll(':scope > path')].slice(0,5).map(p=>{const r=p.getBoundingClientRect();return (r.top+r.bottom)/2});
    return {boxes:out,space:(l[4]-l[0])/4}})()`);
  const shot = await b.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size[0], height: size[1], scale: 1 } });
  const img = decodeGray(Buffer.from(shot.result.data, 'base64'));
  const lab = boxes.boxes.map((q) => ({ cls: ACC[q.g] || REST[q.g] || ({ E0A4: 'head', E0A3: 'hollow', E0A2: 'hollow' }[q.g]), key: q.key, box: q.box })).filter((q) => q.cls);
  fs.writeFileSync(path.join(OUT, `${k}.png`), encodeGray(img));
  fs.writeFileSync(path.join(OUT, `${k}.json`), JSON.stringify({ font, space: boxes.space, fifths: t.fifths, clef: t.clef, boxes: lab }));
}
b.kill();
console.log(`${N} pages in ${OUT}`);

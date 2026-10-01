// Builds the test fixtures and the glyph table from Verovio engravings.
//   npm i --prefix /tmp/ssdev verovio@6.3.0      (dev-only; nothing at runtime needs it)
//   node tools/make_fixtures.mjs                 (VEROVIO=/path/to/node_modules/verovio to override)
// Writes fixtures/<tune>.png (clean engraving, gray) + fixtures/<tune>.json (truth: every
// notehead's pixel box, written pitch, explicit accidental, every staff's line y's, clef, key)
// and ../glyphs.js (SMuFL paths for noteheads/accidentals/clefs in 5 fonts).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from '../cdp.js';
import { decodeGray, encodeGray } from '../png.js';
import { TUNES, FONTS, GLYPHS, GLYPH_ABC } from './tunes.js';
import { keyAlter, natMidi } from '../theory.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(DIR, '..');
const VER = process.env.VEROVIO || '/tmp/ssdev/node_modules/verovio';
const { default: createVerovioModule } = await import(path.join(VER, 'dist/verovio-module.mjs'));
const { VerovioToolkit } = await import(path.join(VER, 'dist/verovio.mjs'));
const VM = await createVerovioModule();
let tk = new VerovioToolkit(VM);

const b = await launch({ port: 9343 });
const ACC = { E262: 1, E260: -1, E261: 0, E263: 2, E264: -2 };

async function render(svg) {
  await b.evaluate(`document.body.style.margin='0';document.body.style.background='#fff';document.body.innerHTML=${JSON.stringify(svg)};1`);
  const size = await b.evaluate(`(()=>{const r=document.querySelector('svg').getBoundingClientRect();return [Math.ceil(r.width),Math.ceil(r.height)]})()`);
  await b.send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
  return size;
}

// ---- glyph table ----
const glyphs = {};
for (const font of FONTS) {
  glyphs[font] = {};
  for (const abc of GLYPH_ABC) {
  tk = new VerovioToolkit(VM);
  tk.setOptions({ font, scale: 100, pageWidth: 2100, adjustPageHeight: true, header: 'none', footer: 'none' });
  tk.loadData(abc);
  const svg = tk.renderToSVG(1);
  for (const m of svg.matchAll(/<g id="(E[0-9A-F]{3})-[^"]*"[^>]*>\s*<path transform="scale\(1,-1\)" d="([^"]*)"/g)) {
    if (!GLYPHS[m[1]]) continue;
    const bb = await b.evaluate(`(()=>{const s=document.createElementNS('http://www.w3.org/2000/svg','svg');const p=document.createElementNS('http://www.w3.org/2000/svg','path');p.setAttribute('d',${JSON.stringify(m[2])});s.appendChild(p);document.body.appendChild(s);const r=p.getBBox();s.remove();return [r.x,r.y,r.width,r.height]})()`);
    // font units, 250 per staff space, y up; stored as staff spaces with y DOWN (canvas convention)
    glyphs[font][GLYPHS[m[1]]] = { d: m[2], box: [bb[0] / 250, -(bb[1] + bb[3]) / 250, (bb[0] + bb[2]) / 250, -bb[1] / 250] };
  }
  }
  const missing = Object.values(GLYPHS).filter((n) => !glyphs[font][n]);
  if (missing.length) console.log(font, 'missing glyphs', missing);
}
fs.writeFileSync(path.join(ROOT, 'glyphs.js'), `// SMuFL glyph outlines extracted from Verovio ${tk.getVersion()} (fonts: SIL OFL 1.1).\n// path d in font units (250 per staff space, y up, flip with scale(s/250,-s/250)); box = [x0,y0,x1,y1] in staff spaces, y down.\nexport const GLYPHS = ${JSON.stringify(glyphs)};\n`);
console.log('glyphs.js written');

// ---- fixtures ----
fs.mkdirSync(path.join(ROOT, 'fixtures'), { recursive: true });
const SIZES = [16, 20, 24, 18, 22, 14, 26];
for (let i = 0; i < TUNES.length; i++) {
  const t = TUNES[i], font = FONTS[i % FONTS.length], S = SIZES[i];
  tk = new VerovioToolkit(VM); // fresh: the ABC importer leaks key state between loads
  tk.setOptions({ font, scale: Math.round((S / 18) * 100), pageWidth: 1900, pageHeight: 6000, adjustPageHeight: true, header: 'none', footer: 'none', pageMarginLeft: 60, pageMarginRight: 60, pageMarginTop: 60, pageMarginBottom: 60, breaks: 'auto', spacingSystem: 10 });
  tk.loadData(t.abc);
  tk.renderToMIDI();
  const svg = tk.renderToSVG(1);
  const size = await render(svg);
  const geo = await b.evaluate(`(()=>{
    const R=(e)=>{const r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom].map(v=>+v.toFixed(2))};
    const systems=[...document.querySelectorAll('g.system')];
    const staves=systems.map(sy=>{const st=[...sy.querySelectorAll('g.staff')];
      const lines=[...st[0].querySelectorAll(':scope > path')].slice(0,5).map(p=>{const r=p.getBoundingClientRect();return +((r.top+r.bottom)/2).toFixed(2)});
      const x0=Math.min(...st.map(s=>s.querySelector(':scope > path').getBoundingClientRect().left)), x1=Math.max(...st.map(s=>s.querySelector(':scope > path').getBoundingClientRect().right));
      const ks=sy.querySelector('g.keySig');
      return {lines,x0,x1,keyBox:ks?R(ks):null,clefBox:R(sy.querySelector('g.clef'))}});
    const notes=[...document.querySelectorAll('g.note')].map(n=>{const a=n.querySelector('g.accid use');
      return {id:n.id,sys:systems.indexOf(n.closest('g.system')),bar:[...document.querySelectorAll('g.measure')].indexOf(n.closest('g.measure')),head:R(n.querySelector('.notehead')),
        accid:a?a.getAttribute('xlink:href').slice(1,5):null,accidBox:a?R(a):null,
        glyph:n.querySelector('.notehead use').getAttribute('xlink:href').slice(1,5)}});
    return {staves,notes};})()`);
  const shot = await b.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: size[0], height: size[1], scale: 1 } });
  const img = decodeGray(Buffer.from(shot.result.data, 'base64'));
  // crop to content + margin to keep the files small
  let y1 = 0; for (let y = img.h - 1; y >= 0 && !y1; y--) for (let x = 0; x < img.w; x++) if (img.data[y * img.w + x] < 128) { y1 = Math.min(img.h, y + 3 * S); break; }
  const out = { w: img.w, h: y1, data: img.data.subarray(0, img.w * y1) };
  // written pitch from key + accidentals carried through the bar (Verovio's MIDI values leak
  // key state between ABC loads, so they are not used)
  let bar = -1, carry = new Map();
  const notes = geo.notes.map((n) => {
    const a = tk.getElementAttr(n.id), d = +a.oct * 7 + 'cdefgab'.indexOf(a.pname);
    if (n.bar !== bar) { bar = n.bar; carry = new Map(); }
    let alter = n.accid ? ACC[n.accid] : carry.has(d) ? carry.get(d) : keyAlter(t.fifths, d % 7);
    if (n.accid) carry.set(d, alter);
    const midi = natMidi(d) + alter;
    return { x: +((n.head[0] + n.head[2]) / 2).toFixed(2), y: +((n.head[1] + n.head[3]) / 2).toFixed(2), w: +(n.head[2] - n.head[0]).toFixed(2), sys: n.sys, bar: n.bar,
      pname: a.pname, oct: +a.oct, midi, accid: n.accid ? ACC[n.accid] : null, accidBox: n.accidBox, type: { E0A2: 'whole', E0A3: 'half', E0A4: 'black' }[n.glyph] };
  });
  const truth = { tune: t.name, font, space: S, clef: t.clef, fifths: t.fifths, w: out.w, h: out.h, staves: geo.staves, notes };
  fs.writeFileSync(path.join(ROOT, 'fixtures', t.name + '.png'), encodeGray(out));
  fs.writeFileSync(path.join(ROOT, 'fixtures', t.name + '.json'), JSON.stringify(truth));
  console.log(t.name, font, `S=${S}`, `${out.w}x${out.h}`, geo.staves.length, 'staves', notes.length, 'notes');
}
b.kill();

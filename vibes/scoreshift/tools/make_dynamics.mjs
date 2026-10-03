// Templates for dynamics and common expression words, rendered in headless Chromium:
//  - each dynamic in the 5 SMuFL fonts, as Verovio engraves it (ligatures and all)
//  - each dynamic and word in italic / bold italic serif text fonts (scores engraved with text
//    dynamics, e.g. Finale's Times, as on the CODA sheet)
// Stored as shape descriptors (raster.js: 10 x 10 coverage grid + box size), so recognition
// needs no fonts at run time. Writes ../dynamics.js.
//   node tools/make_dynamics.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from '../cdp.js';
import { decodeGray } from '../png.js';
import { descriptor } from '../raster.js';
import { FONTS } from './tunes.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const VER = process.env.VEROVIO || '/tmp/ssdev/node_modules/verovio';
const { default: createVerovioModule } = await import(path.join(VER, 'dist/verovio-module.mjs'));
const { VerovioToolkit } = await import(path.join(VER, 'dist/verovio.mjs'));
const VM = await createVerovioModule();
export const DYNAMICS = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sf', 'sfz', 'sfp', 'fz', 'fp', 'rf', 'rfz', 'sffz'];
// words that look a little like dynamics and must not be read as them
const WORDS = ['dolce', 'espr.', 'cresc.', 'dim.', 'molto', 'marcato', 'poco', 'più', 'sempre', 'subito', 'sub.', 'ten.', 'rit.', 'a tempo', 'legato', 'simile', 'ben', 'pizz.', 'arco', 'div.', 'non', 'e', 'con', 'sord.'];
const TEXT_FONTS = [['Nimbus Roman', 'italic', 700], ['Nimbus Roman', 'italic', 400], ['DejaVu Serif', 'italic', 700], ['DejaVu Serif', 'italic', 400]];

const b = await launch({ port: 9348, width: 1600, height: 1200 });
const shotMask = async (clip, th = 128) => {
  const s = await b.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
  const g = decodeGray(Buffer.from(s.result.data, 'base64')), m = new Uint8Array(g.w * g.h);
  for (let i = 0; i < m.length; i++) m[i] = g.data[i] < th ? 1 : 0;
  return { m, w: g.w, h: g.h };
};
const out = [];
// SMuFL dynamics, one per measure
for (const font of FONTS) {
  const tk = new VerovioToolkit(VM);
  tk.setOptions({ font, scale: 100, pageWidth: 2100, adjustPageHeight: true, header: 'none', footer: 'none', breaks: 'none' });
  const ms = DYNAMICS.map((d, i) => `<measure n="${i + 1}"><staff n="1"><layer n="1"><note xml:id="n${i}" pname="c" oct="5" dur="1"/></layer></staff><dynam staff="1" place="below" startid="#n${i}">${d}</dynam></measure>`).join('');
  tk.loadData(`<?xml version="1.0" encoding="UTF-8"?><mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0"><music><body><mdiv><score><scoreDef><staffGrp><staffDef n="1" lines="5"><clef shape="G" line="2"/></staffDef></staffGrp></scoreDef><section>${ms}</section></score></mdiv></body></music></mei>`);
  const svg = tk.renderToSVG(1);
  await b.evaluate(`document.body.style.margin='0';document.body.style.background='#fff';document.body.innerHTML=${JSON.stringify(svg)};1`);
  const size = await b.evaluate(`(()=>{const r=document.querySelector('svg').getBoundingClientRect();return [Math.ceil(r.width),Math.ceil(r.height)]})()`);
  await b.send('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });
  const info = await b.evaluate(`(()=>{const l=[...document.querySelector('g.staff').querySelectorAll(':scope > path')].slice(0,5).map(p=>{const r=p.getBoundingClientRect();return (r.top+r.bottom)/2});
    return {space:(l[4]-l[0])/4, boxes:[...document.querySelectorAll('g.dynam')].map(d=>{const r=d.getBoundingClientRect();return [r.left,r.top,r.width,r.height]})}})()`);
  for (const [i, bx] of info.boxes.entries()) {
    const mk = await shotMask({ x: Math.floor(bx[0]) - 1, y: Math.floor(bx[1]) - 1, width: Math.ceil(bx[2]) + 3, height: Math.ceil(bx[3]) + 3 });
    const d = descriptor(mk.m, mk.w, mk.h); if (!d) continue;
    out.push({ text: DYNAMICS[i], dyn: true, font, g: Array.from(d.g, (v) => +v.toFixed(3)), hS: +(d.bh / info.space).toFixed(3), ar: +(d.bw / d.bh).toFixed(3) });
  }
}
// text fonts: dynamics and words
await b.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 1, mobile: false });
for (const [family, style, weight] of TEXT_FONTS) for (const [txt, dyn] of [...DYNAMICS.map((d) => [d, true]), ...WORDS.map((w) => [w, false])]) {
  const bx = await b.evaluate(`(()=>{document.body.innerHTML='<span id=t style="font:${style} ${weight} 64px &quot;${family}&quot;;position:absolute;left:20px;top:20px;white-space:nowrap">${txt}</span>';
    const r=document.getElementById('t').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()`);
  const mk = await shotMask({ x: Math.floor(bx[0]) - 4, y: Math.floor(bx[1]), width: Math.ceil(bx[2]) + 8, height: Math.ceil(bx[3]) });
  const d = descriptor(mk.m, mk.w, mk.h); if (!d) continue;
  out.push({ text: txt, dyn, font: `${family} ${style} ${weight}`, g: Array.from(d.g, (v) => +v.toFixed(3)), hS: null, ar: +(d.bw / d.bh).toFixed(3) });
}
b.kill();
fs.writeFileSync(path.join(DIR, '..', 'dynamics.js'), `// Dynamics and expression-word shape templates (tools/make_dynamics.mjs): SMuFL dynamics of 5 fonts
// as Verovio engraves them, and dynamics + words in italic serif text fonts. g = 10 x 10 ink
// coverage of the ink box, ar = width / height, hS = height in staff spaces (SMuFL only).
export const DYN_TEMPLATES = ${JSON.stringify(out)};\n`);
console.log(out.length, 'templates');

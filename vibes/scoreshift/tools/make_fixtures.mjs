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
import { TUNES, FONTS, GLYPHS, GLYPH_ABC, GLYPH_TUNES, toMEI } from './tunes.js';
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
const ARTIC = { E4A0: 'acc', E4A1: 'acc', E4A2: 'stacc', E4A3: 'stacc', E4A4: 'ten', E4A5: 'ten', E610: 'dnbow', E611: 'dnbow', E612: 'upbow', E613: 'upbow' };

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
  for (const abc of [...GLYPH_ABC, ...GLYPH_TUNES.map(toMEI)]) {
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
const SIZES = [16, 20, 24, 18, 22, 14, 26, 18, 20, 17, 19, 21, 18, 20, 18];
for (let i = 0; i < TUNES.length; i++) {
  const t = TUNES[i], font = FONTS[i % FONTS.length], S = SIZES[i];
  tk = new VerovioToolkit(VM); // fresh: the ABC importer leaks key state between loads
  tk.setOptions({ font, scale: Math.round((S / 18) * 100), pageWidth: 1900, pageHeight: 6000, adjustPageHeight: true, header: 'none', footer: 'none', pageMarginLeft: 60, pageMarginRight: 60, pageMarginTop: 60, pageMarginBottom: 60, breaks: 'auto', spacingSystem: 10 });
  if (!tk.loadData(t.src ? toMEI(t) : t.abc)) throw new Error('Verovio could not load ' + t.name);
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
        glyph:n.querySelector('.notehead use').getAttribute('xlink:href').slice(1,5),
        artic:[...(n.closest('g.chord')||n).querySelectorAll('g.artic use')].map(u=>u.getAttribute('xlink:href').slice(1,5)),
        articBox:[...(n.closest('g.chord')||n).querySelectorAll('g.artic use')].map(R)}});
    // rhythm: every event (note, chord, rest, measure rest) of every measure in reading order
    const measures=[...document.querySelectorAll('g.measure')].map(m=>({sys:systems.indexOf(m.closest('g.system')),
      events:[...m.querySelectorAll('g.note, g.chord, g.rest, g.mRest')].filter(e=>!(e.matches('g.note')&&e.parentElement.closest('g.chord'))).map(e=>({
        id:e.id, kind:e.classList[0], notes:e.matches('g.chord')?[...e.querySelectorAll('g.note')].map(q=>q.id):e.matches('g.note')?[e.id]:[],
        tuplet:e.closest('g.tuplet')?.id||null, layer:[...m.querySelectorAll('g.layer')].indexOf(e.closest('g.layer')), beam:e.closest('g.beam')?.id||null, box:e.matches('g.rest, g.mRest')?R(e):null}))}));
    const ties=[...document.querySelectorAll('g.tie')].map(t=>t.id);
    const dynams=[...document.querySelectorAll('g.dynam')].map(d=>({id:d.id,box:R(d)}));
    const slurs=[...document.querySelectorAll('g.slur')].map(d=>({id:d.id,box:R(d)}));
    const hairpins=[...document.querySelectorAll('g.hairpin')].map(d=>({id:d.id,box:R(d)}));
    return {staves,notes,measures,ties,dynams,slurs,hairpins};})()`);
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
    const art = [...new Set(n.artic.map((g) => ARTIC[g]).filter(Boolean))];
    return { artic: art, articBox: n.articBox, x: +((n.head[0] + n.head[2]) / 2).toFixed(2), y: +((n.head[1] + n.head[3]) / 2).toFixed(2), w: +(n.head[2] - n.head[0]).toFixed(2), sys: n.sys, bar: n.bar,
      pname: a.pname, oct: +a.oct, midi, accid: n.accid ? ACC[n.accid] : null, accidBox: n.accidBox, type: { E0A2: 'whole', E0A3: 'half', E0A4: 'black' }[n.glyph] };
  });
  const truth = { tune: t.name, font, space: S, clef: t.clef, fifths: t.fifths, w: out.w, h: out.h, staves: geo.staves, notes };
  // rhythm truth: per measure the events in order with written value (dur 1 2 4 8 16 32,
  // dots), tuplet ratio and sounding length in ticks (96 per quarter); notes refer to events
  const meter = t.meter ? null : (t.abc.match(/^M:(.*)$/m) || [])[1].trim();
  truth.meter = t.meter || (meter === 'C' ? [4, 4] : meter === 'C|' ? [2, 2] : meter.split('/').map(Number));
  const tieStarts = new Set(geo.ties.map((id) => tk.getElementAttr(id).startid?.replace('#', '')));
  const noteIdx = new Map(geo.notes.map((n, i) => [n.id, i]));
  const evIds = new Map(geo.measures.flatMap((m) => m.events.map((e) => [e.id, e.notes.map((id) => noteIdx.get(id))[0]])));
  const idxOf = (id) => noteIdx.get(id) ?? evIds.get(id) ?? null;
  truth.measures = geo.measures.map((m) => ({ sys: m.sys, events: m.events.map((e) => {
    const a = tk.getElementAttr(e.id), dur = e.kind === 'mRest' ? 1 : +a.dur, dots = +(a.dots || 0);
    const tup = e.tuplet ? tk.getElementAttr(e.tuplet) : null, ratio = tup ? [+tup.num, +tup.numbase] : null;
    let tk0 = (4 / dur) * 96, add = tk0; for (let k = 0; k < dots; k++) { add /= 2; tk0 += add; }
    if (ratio) tk0 = (tk0 * ratio[1]) / ratio[0];
    const grace = !!a.grace;
    return { kind: e.kind === 'chord' ? 'note' : e.kind, dur, dots, tuplet: ratio, ticks: e.kind === 'mRest' ? null : grace ? 0 : tk0, grace: grace ? a.grace : undefined, notes: e.notes.map((id) => noteIdx.get(id)),
      tie: e.notes.some((id) => tieStarts.has(id)), beam: !!e.beam, box: e.box, voice: Math.max(0, e.layer) };
  }) }));
  const cap = (truth.meter[0] * 4 / truth.meter[1]) * 96;
  truth.measures.forEach((m, mi) => { if (mi === 0 && m.events.filter((e) => !e.voice).reduce((s, e) => s + (e.ticks ?? cap), 0) < cap) m.pickup = true; });
  truth.measures.forEach((m, mi) => m.events.forEach((e, ei) => e.notes.forEach((k) => Object.assign(notes[k], { ev: [mi, ei], dur: e.dur, dots: e.dots, tuplet: e.tuplet, grace: e.grace }))));
  // expression: dynamics (text, box, the note it is attached to), slurs and hairpins (first and
  // last note); notes referred to by index
  const startOf = (id) => { const a = tk.getElementAttr(id); return { from: (a.startid || '').replace('#', ''), to: (a.endid || '').replace('#', '') }; };
  const dynText = t.src ? [...toMEI(t).matchAll(/<dynam[^>]*>([a-z]+)<\/dynam>/g)].map((m) => m[1]) : [];
  truth.dynamics = geo.dynams.map((d, k) => { const r = startOf(d.id); return { text: dynText[k], box: d.box, note: idxOf(r.from) }; });
  truth.slurs = geo.slurs.map((d) => { const r = startOf(d.id); return { box: d.box, from: idxOf(r.from), to: idxOf(r.to) }; });
  truth.hairpins = geo.hairpins.map((d) => { const r = startOf(d.id), a = tk.getElementAttr(d.id); return { box: d.box, form: a.form, from: idxOf(r.from), to: idxOf(r.to) }; });
  fs.writeFileSync(path.join(ROOT, 'fixtures', t.name + '.png'), encodeGray(out));
  fs.writeFileSync(path.join(ROOT, 'fixtures', t.name + '.json'), JSON.stringify(truth));
  console.log(t.name, font, `S=${S}`, `${out.w}x${out.h}`, geo.staves.length, 'staves', notes.length, 'notes');
}
b.kill();

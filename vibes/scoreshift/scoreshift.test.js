// bun test — theory, image primitives, and recognition accuracy on the Verovio fixtures
// (clean and through simulated scan / photo / phone degradation).
import { test, expect, describe } from 'bun:test';
import { decodeGray, encodeGray } from './png.js';
import * as IP from './imgproc.js';
import { CLEFS, INSTRUMENTS, instrument, partInterval, transposePitch, keySigPositions, readStaff, spellStaff, bestOctave, nameOf, intervalFifths, pOfD, dOfP } from './theory.js';
import { evaluate, evaluateRhythm, FIXTURES, loadFixture } from './eval.js';
import { buildScore, evTicks, baseTicks } from './score.js';
import { toMusicXML, toMidi, performance } from './export.js';
import { rasterGlyph } from './raster.js';
import { GLYPHS } from './glyphs.js';
import { plan } from './render.js';
import { CONDITIONS } from './degrade.js';
import { normalize, analyze } from './omr.js';
import fs from 'fs';

describe('theory', () => {
  const C = instrument('C'), BB = instrument('Bb-clarinet');
  test('B♭ clarinet reads a major 2nd above concert', () => {
    expect(partInterval(C, BB, 1, 0)).toEqual({ dd: 1, ds: 2, fifths: 3 }); // G major -> A major
    expect(nameOf(transposePitch({ d: 32, alter: 0 }, { dd: 1, ds: 2 }))).toBe('A4');
    expect(nameOf(transposePitch({ d: 31, alter: 1 }, { dd: 1, ds: 2 }))).toBe('G♯4'); // F♯4 -> G♯4
    expect(nameOf(transposePitch({ d: 34, alter: -1 }, { dd: 1, ds: 2 }))).toBe('C5'); // B♭4 -> C5
  });
  test('instrument keys from G major concert', () => {
    const k = (id) => partInterval(C, instrument(id), 1, 0).fifths;
    expect(k('alto-sax')).toBe(4); expect(k('F-horn')).toBe(2); expect(k('A-clarinet')).toBe(-2);
    expect(k('Eb-clarinet')).toBe(4); expect(k('tenor-sax')).toBe(3); expect(k('viola')).toBe(1);
  });
  test('between transposing instruments', () => {
    // a B♭ trumpet part read by an E♭ alto sax: up a perfect 5th
    expect(partInterval(instrument('Bb-trumpet'), instrument('alto-sax'), 0, 0)).toMatchObject({ dd: 4, ds: 7, fifths: 1 });
  });
  test('enharmonic respelling past six accidentals', () => {
    expect(partInterval(C, BB, -5, 0).fifths).toBe(-3); // D♭ -> E♭
    const iv = partInterval(C, BB, 5, 0);                 // B major -> C♯ (7) respelled D♭ (-5)
    expect(iv.fifths).toBe(-5); expect(iv).toMatchObject({ dd: 2, ds: 2 });
    expect(intervalFifths({ dd: 1, ds: 2 })).toBe(2);
  });
  test('clefs and key signature positions', () => {
    expect(dOfP(CLEFS.treble, 2)).toBe(32); expect(dOfP(CLEFS.bass, 6)).toBe(24); expect(dOfP(CLEFS.alto, 4)).toBe(28);
    expect(pOfD(CLEFS.treble, 28)).toBe(-2); // middle C on the first ledger below
    expect(keySigPositions(CLEFS.treble, 3)).toEqual([8, 5, 9]);
    expect(keySigPositions(CLEFS.bass, -2)).toEqual([2, 5]);
    expect(keySigPositions(CLEFS.alto, 1)).toEqual([7]);
    expect(keySigPositions(CLEFS.tenor, 2)).toEqual([2, 6]);
  });
  test('accidentals carry through the bar and are respelled', () => {
    // G major, bar 0: F (♯ by key), F♮, F (still ♮), bar 1: F (♯ again)
    const notes = [{ p: 1, acc: null, bar: 0 }, { p: 1, acc: 0, bar: 0 }, { p: 1, acc: null, bar: 0 }, { p: 1, acc: null, bar: 1 }];
    const ps = readStaff(notes, CLEFS.treble, 1);
    expect(ps.map(nameOf)).toEqual(['F♯4', 'F4', 'F4', 'F♯4']);
    const iv = partInterval(instrument('C'), instrument('Bb-clarinet'), 1, 0);
    const t = ps.map((p) => transposePitch(p, iv));
    expect(t.map(nameOf)).toEqual(['G♯4', 'G4', 'G4', 'G♯4']);
    expect(spellStaff(t, notes, iv.fifths)).toEqual([null, 0, null, null]); // ♮ once, then carried
  });
  test('cautionary accidentals survive', () => {
    const notes = [{ p: 1, acc: 1, bar: 0 }]; // redundant F♯ in G major
    const ps = readStaff(notes, CLEFS.treble, 1);
    expect(spellStaff(ps.map((p) => transposePitch(p, { dd: 1, ds: 2 })), notes, 3)).toEqual([1]);
  });
  test('octave choice keeps notes in range', () => {
    expect(bestOctave([40, 43, 45], instrument('Bb-clarinet').range)).toBe(1);
    expect(bestOctave([62, 67, 72], instrument('Bb-clarinet').range)).toBe(0);
    expect(INSTRUMENTS.every((i) => i.range[0] < i.range[1])).toBe(true);
  });
});

describe('image primitives', () => {
  test('png round trip', () => {
    const img = { w: 7, h: 3, data: Uint8Array.from({ length: 21 }, (_, i) => i * 12) };
    expect(decodeGray(encodeGray(img))).toEqual(img);
  });
  test('staff metrics and skew on synthetic lines', () => {
    const w = 600, h = 300, d = new Uint8Array(w * h), a = (2 * Math.PI) / 180;
    for (let s = 0; s < 3; s++) for (let k = 0; k < 5; k++) for (let x = 0; x < w; x++) for (let t = 0; t < 2; t++) d[Math.round(40 + s * 90 + k * 14 + x * Math.tan(a) + t) * w + x] = 1;
    const m = IP.staffMetrics({ w, h, data: d });
    expect(Math.round(m.space)).toBe(14);
    expect(Math.abs((IP.estimateSkew({ w, h, data: d }) * 180) / Math.PI - 2)).toBeLessThan(0.15);
  });
  test('components and morphology', () => {
    const w = 20, h = 10, d = new Uint8Array(w * h);
    for (let y = 2; y < 8; y++) for (let x = 2; x < 8; x++) d[y * w + x] = 1; // 6x6 block
    for (let y = 0; y < h; y++) d[y * w + 15] = 1;                          // 1px line
    const { comps } = IP.components({ w, h, data: d });
    expect(comps.filter(Boolean).map((c) => c.n).sort((a, b) => a - b)).toEqual([10, 36]);
    const o = IP.open({ w, h, data: d }, 3);
    expect(o.data.reduce((a, v) => a + v, 0)).toBe(36); // the block survives, the line does not
  });
});

describe('recognition (Verovio fixtures, 5 engraving fonts)', () => {
  const runs = {};
  for (const cond of Object.keys(CONDITIONS)) runs[cond] = FIXTURES.map((f) => evaluate(f, cond));
  const sum = (rs, k) => rs.reduce((a, r) => a + r[k], 0);
  test('every staff found, every clef read', () => {
    for (const cond of ['clean', 'scan', 'photo']) for (const r of runs[cond]) {
      expect(r.staves).toBe(r.trueStaves);
      expect(r.clefOk).toBe(r.trueStaves);
    }
  });
  test('clean engravings: heads and pitches', () => {
    const rs = runs.clean;
    expect(sum(rs, 'tp') / sum(rs, 'n')).toBeGreaterThan(0.99);
    expect(sum(rs, 'fp')).toBeLessThanOrEqual(3);
    expect(sum(rs, 'pitch') / sum(rs, 'n')).toBeGreaterThan(0.98);
    expect(rs.every((r) => r.keyOk === r.trueStaves)).toBe(true);
  });
  test('scanned and photographed pages', () => {
    for (const cond of ['scan', 'photo']) {
      const rs = runs[cond];
      expect(sum(rs, 'tp') / sum(rs, 'n')).toBeGreaterThan(0.95);
      expect(sum(rs, 'pitch') / sum(rs, 'n')).toBeGreaterThan(0.88);
    }
  });
  test('low-resolution phone photo still yields usable staves', () => {
    const rs = runs.phone;
    expect(rs.every((r) => r.staves === r.trueStaves)).toBe(true);
    expect(sum(rs, 'tp') / sum(rs, 'n')).toBeGreaterThan(0.85);
  });
  test('transposition plan: minuet for B♭ clarinet moves every head up one step into A major', () => {
    const r = runs.clean.find((x) => x.name === 'minuet');
    const pl = plan(r.res, { from: 'C', to: 'Bb-clarinet', octave: 'auto', clef: 'auto' });
    expect(pl.staves.every((s) => s.fifths === 3 && s.octave === 0 && !s.clefChanged)).toBe(true);
    expect(pl.staves.every((s) => s.notes.every((nn) => nn.p === nn.n.p + 1))).toBe(true);
    // the C♯5 in bar 20 (C♯ in G major) becomes D♯5 with a sharp
    const sharp = pl.staves.flatMap((s) => s.notes).filter((nn) => nn.n.accid);
    expect(sharp.length).toBeGreaterThan(0);
    expect(sharp.every((nn) => nn.name === 'D♯5' && nn.acc === 1)).toBe(true);
  });
  test('cello part read by a viola: clef change to alto, same key', () => {
    const r = runs.clean.find((x) => x.name === 'cello');
    const pl = plan(r.res, { from: 'cello', to: 'viola', octave: 0, clef: 'auto' });
    expect(pl.staves.every((s) => s.clefChanged && s.fifths === 2)).toBe(true);
    expect(pl.staves[0].notes[0].p - pl.staves[0].notes[0].n.p).toBe(-6); // D3: middle line in bass, first ledger below in alto
  });
  test('fixtures load', () => { expect(loadFixture('minuet').truth.notes.length).toBe(96); });
  // rhythm: written value of every note (dur, dots, tuplet) and whole bars against the truth
  const rh = {}; for (const cond of ['clean', 'photo', 'phone']) rh[cond] = runs[cond].map(evaluateRhythm);
  test('rhythm, clean engravings: note values and bars', () => {
    const rs = rh.clean;
    expect(sum(rs, 'val') / sum(rs, 'n')).toBeGreaterThan(0.99);
    expect(sum(rs, 'bars') / sum(rs, 'nbars')).toBeGreaterThan(0.97);
    expect(rs.every((r) => r.rests === r.trests)).toBe(true);
    // time signatures, including C | (cut) and 6/8, read on the first staff
    const m = (name) => runs.clean.find((x) => x.name === name).res.staves[0].times[0];
    expect(m('triplets').sym).toBe('cut');
    expect([m('sixeight').beats, m('sixeight').unit]).toEqual([6, 8]);
    expect([m('viola').beats, m('viola').unit]).toEqual([2, 4]);
  });
  test('rhythm, photos', () => {
    expect(sum(rh.photo, 'val') / sum(rh.photo, 'n')).toBeGreaterThan(0.94);
    expect(sum(rh.photo, 'bars') / sum(rh.photo, 'nbars')).toBeGreaterThan(0.85);
    expect(sum(rh.phone, 'val') / sum(rh.phone, 'n')).toBeGreaterThan(0.85);
  });
  test('MusicXML and MIDI from a recognised page', () => {
    const r = runs.clean.find((x) => x.name === 'triplets'), sc = buildScore(r.res);
    const xml = toMusicXML(r.res, sc, { title: 't' });
    expect(xml.match(/<measure /g).length).toBe(9);
    expect(xml).toContain('<time symbol="cut"><beats>2</beats><beat-type>2</beat-type></time>');
    expect(xml.match(/<actual-notes>3<\/actual-notes>/g).length).toBe(18);
    expect(xml.match(/<tuplet type="start"\/>/g).length).toBe(6);
    expect(xml).toContain('<tie type="start"/>');
    // every measure's durations add up to 2/2 (480 divisions per quarter)
    for (const m of xml.split('<measure ').slice(1)) expect([...m.matchAll(/<duration>(\d+)<\/duration>/g)].filter((d, i, a) => !m.split('<note>')[i + 1]?.includes('<chord/>')).reduce((a, d) => a + +d[1], 0)).toBe(1920);
    const p = performance(r.res, sc);
    expect(p.notes.find((n) => n.midi === 79 && n.dur === 576)).toBeTruthy(); // g5 whole tied to a half: one sounding note
    const mid = toMidi(r.res, sc, { tempo: 90 });
    expect(String.fromCharCode(...mid.slice(0, 4))).toBe('MThd');
  });
});

describe('score assembly and bar repair', () => {
  const st = (events) => ({ index: 0, system: 1, x0: 0, x1: 1000, key: { x1: 0, fifths: 0 }, clef: { type: 'treble' }, bars: [{ x: 500, ids: [] }], times: [{ x: 1, x1: 2, beats: 3, unit: 4 }], tuplets: [],
    notes: events.filter((e) => e.k !== 'r').map((e, i) => ({ x: e.x, y: 50, p: 4, chord: i + 1, dur: e.d, ndots: e.dots || 0, beamed: !!e.b, comp: e.b ? 7 : 100 + i, flags: e.d >= 8 && !e.b ? 1 : 0, pitch: { d: 32, alter: 0 }, box: [e.x - 6, 44, e.x + 6, 56] })),
    rests: events.filter((e) => e.k === 'r').map((e) => ({ x: e.x, dur: e.d, dots: 0, box: [e.x - 5, 40, e.x + 5, 60] })) });
  const build = (evs) => { const s = st(evs); return buildScore({ space: 16, staves: [s] }); };
  test('a missed dot is put back, a misread flag is corrected', () => {
    const sc = build([{ x: 100, d: 2 }, { x: 600, d: 2 }, { x: 800, d: 8 }]); // bar 1: a half alone, bar 2: half + 8th
    expect(sc.measures[0].repairs).toEqual(['dot added']); expect(sc.measures[0].events[0].dots).toBe(1);
    expect(sc.measures[1].repairs).toEqual(['one beam fewer']); expect(sc.measures[1].events[1].dur).toBe(4);
    expect(sc.measures.every((m) => m.status === 'ok')).toBe(true);
  });
  test('an unmarked beamed triplet', () => {
    const sc = build([{ x: 100, d: 8, b: 1 }, { x: 150, d: 8, b: 1 }, { x: 200, d: 8, b: 1 }, { x: 300, d: 2 }, { x: 600, d: 2 }, { x: 800, d: 4 }]);
    expect(sc.measures[0].repairs).toEqual(['triplet']);
    expect(sc.measures[0].events.slice(0, 3).every((e) => e.tuplet && e.tuplet[0] === 3)).toBe(true);
  });
  test('a pickup stays short, a corrected value is kept', () => {
    const s = st([{ x: 100, d: 4 }, { x: 600, d: 2 }, { x: 800, d: 4 }]);
    s.bars = [{ x: 200, ids: [] }, { x: 900, ids: [] }];
    let sc = buildScore({ space: 16, staves: [s] });
    expect(sc.measures.map((m) => m.status)).toEqual(['pickup', 'ok']);
    s.notes[1].fix = { dur: 4, dots: 0, tuplet: null }; // the user says the half is a quarter
    sc = buildScore({ space: 16, staves: [s] });
    expect(evTicks(sc.measures[1].events[0])).toBe(96); // kept; the repair goes elsewhere
    expect(sc.measures[1].events[0].repaired).toBeUndefined();
  });
  test('tick arithmetic', () => {
    expect(baseTicks(4, 1)).toBe(144); expect(evTicks({ dur: 8, dots: 0, tuplet: [3, 2] })).toBe(32);
  });
  test('glyph rasterizer', () => {
    const r = rasterGlyph(GLYPHS.Bravura.restQuarter.d, 16);
    expect(r.h).toBeGreaterThan(40); expect(r.m.reduce((a, v) => a + v, 0)).toBeGreaterThan(200);
  });
});

// The CODA audition sheet (Brahms 2 + Fledermaus, viola, alto clef) is not committed; put its
// page render at fixtures/local/coda_p1.png (rendered at 3000 px and scaled to 2400, as the app
// does) to run this.
const CODA = new URL('./fixtures/local/coda_p1.png', import.meta.url);
describe.skipIf(!fs.existsSync(CODA))('real page: CODA viola audition sheet', () => {
  test('every bar adds up', () => {
    const r = analyze(normalize(decodeGray(fs.readFileSync(CODA)))), sc = buildScore(r);
    expect(r.staves.map((s) => s.key.fifths)).toEqual([2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3]);
    expect(r.staves[0].times[0]).toMatchObject({ beats: 3, unit: 4 });
    expect(r.staves[6].times[0].sym).toBe('cut');
    expect(sc.stats.under + sc.stats.over).toBe(0);
    expect(sc.measures.length).toBeGreaterThanOrEqual(66);
  });
});

// One system from three pages of a real scan: Haydn op. 17 no. 5, Philharmonia study score
// (1920s), Internet Archive / Wikimedia Commons (public domain), rendered from the JBIG2/JPX PDF
// at 2400 px and quantised to 16 grey levels. Clefs and keys are the true ones, read by eye; the
// note counts are a baseline from the current recogniser (not hand counted), so a drop is a
// regression. Each crop has a failure that was fixed: p15's top staff picked up a beam as its top
// line and its clef touched the bracket; p11's clefs touch the bracket and the staff above;
// p20's key signatures lose a flat on some staves.
describe('real scan regression (Haydn op. 17 no. 5)', () => {
  const CASES = [
    { name: 'scan_haydn_p15', clefs: 'treble treble alto bass', key: 1, notes: 72 },
    { name: 'scan_haydn_p11', clefs: 'treble treble alto bass', key: 1, notes: 72 },
    { name: 'scan_haydn_p20', clefs: 'treble treble alto bass', key: -2, notes: 97 },
  ];
  for (const c of CASES) test(c.name, () => {
    const r = analyze(normalize(decodeGray(fs.readFileSync(new URL(`./fixtures/${c.name}.png`, import.meta.url)))));
    expect(r.staves.length).toBe(4);
    expect(r.staves.map((s) => s.clef.detected).join(' ')).toBe(c.clefs);
    expect(r.staves.map((s) => s.key.fifths)).toEqual([c.key, c.key, c.key, c.key]);
    expect(r.notes.length).toBeGreaterThanOrEqual(Math.floor(0.95 * c.notes));
    expect(r.notes.length).toBeLessThanOrEqual(Math.ceil(1.1 * c.notes));
    expect(new Set(r.staves.map((s) => s.system)).size).toBe(1); // one system: shared barlines
    const pl = plan(r, { from: 'C', to: 'Bb-clarinet', octave: 'auto', clef: 'keep' });
    expect(pl.staves.every((s) => s.fifths === c.key + 2)).toBe(true);
  });
});

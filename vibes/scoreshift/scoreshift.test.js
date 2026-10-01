// bun test — theory, image primitives, and recognition accuracy on the Verovio fixtures
// (clean and through simulated scan / photo / phone degradation).
import { test, expect, describe } from 'bun:test';
import { decodeGray, encodeGray } from './png.js';
import * as IP from './imgproc.js';
import { CLEFS, INSTRUMENTS, instrument, partInterval, transposePitch, keySigPositions, readStaff, spellStaff, bestOctave, nameOf, intervalFifths, pOfD, dOfP } from './theory.js';
import { evaluate, FIXTURES, loadFixture } from './eval.js';
import { plan } from './render.js';
import { CONDITIONS } from './degrade.js';

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
});

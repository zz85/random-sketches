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
import { normalize, analyze, analyzeAfter, needsPriorKey, applyPriorKey, interpret, findText } from './omr.js';
import { Renderer } from './render.js';
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

describe('ties, text, voices, articulations', () => {
  test('a tied note keeps its accidental across the barline and the system break', () => {
    const st = { clef: { type: 'treble' }, key: { fifths: 0 }, notes: [] };
    st.notes = [{ p: 1, bar: 0, chord: 1, accid: { type: 1 }, tie: true }, { p: 1, bar: 1, chord: 2 }, { p: 1, bar: 1, chord: 3 }].map((n) => ({ st, ...n }));
    interpret(st);
    expect(st.notes.map((n) => n.name)).toEqual(['F♯4', 'F♯4', 'F4']); // the tie carries; the next F is natural again
    const st2 = { clef: { type: 'treble' }, key: { fifths: 0 }, prevStaff: st, notes: [] };
    st.notes[2].tie = true; st.notes[2].accid = { type: -1 }; interpret(st);
    st2.notes = [{ st: st2, p: 1, bar: 0, chord: 1 }]; interpret(st2);
    expect(st2.notes[0].name).toBe('F♭4');
  });
  test('rows of letters are text, a lone ring is not', () => {
    const box = (x, y, w, h, id) => ({ id, x0: x, y0: y, x1: x + w, y1: y + h, cx: x + w / 2, cy: y + h / 2, n: w * h / 2 });
    const word = [box(0, 0, 10, 12, 1), box(14, 2, 10, 10, 2), box(28, 0, 6, 16, 3), box(38, 2, 10, 10, 4)]; // "dolce"-like
    expect([...findText(word, 16)].sort()).toEqual([1, 2, 3, 4]);
    expect(findText([box(0, 0, 18, 13, 1), box(60, 0, 18, 13, 2)], 16).size).toBe(0); // two whole notes
  });
  test('two voices on one staff, articulations, double flats', () => {
    const tv = evaluate('twovoice', 'clean'), R = evaluateRhythm(tv);
    expect(R.bars).toBeGreaterThanOrEqual(7);
    expect(R.score.measures.filter((m) => m.voices === 2).length).toBeGreaterThanOrEqual(6);
    const xml = toMusicXML(tv.res, R.score, {});
    expect(xml).toContain('<backup>'); expect(xml).toContain('<voice>2</voice>');
    const mk = evaluate('marks', 'clean');
    let ok = 0, n = 0, fp = 0;
    for (const [t, g] of mk.pairs) { for (const a of t.artic) { n++; if (g.artic.includes(a)) ok++; } fp += g.artic.filter((a) => !t.artic.includes(a)).length; }
    expect(ok).toBe(n); expect(fp).toBe(0);
    expect(mk.pitch).toBe(mk.n); // double sharps and double flats
    const p = performance(mk.res, buildScore(mk.res));
    expect(p.notes[0].sound).toBeLessThan(0.6 * p.notes[0].dur); // staccato sounds short
  });
});

describe('expression: dynamics, hairpins, slurs', () => {
  test('read on the expr fixture and played', () => {
    const r = evaluate('expr', 'clean'), T = r.truth, g = new Map(r.pairs.map(([t, q]) => [r.tn.indexOf(t), q]));
    const D = r.res.staves.flatMap((s) => s.dynamics), H = r.res.staves.flatMap((s) => s.hairpins), Sl = r.res.staves.flatMap((s) => s.slurs);
    expect(T.dynamics.filter((d) => D.some((x) => x.text === d.text && x.note === g.get(d.note))).length).toBeGreaterThanOrEqual(6);
    expect(D.every((x) => T.dynamics.some((d) => d.text === x.text))).toBe(true); // no invented dynamics
    expect(H.map((h) => h.form).sort()).toEqual(['cresc', 'dim']);
    expect(T.slurs.filter((t) => Sl.some((x) => x.from === g.get(t.from) && x.to === g.get(t.to))).length).toBeGreaterThanOrEqual(4);
    const sc = buildScore(r.res), p = performance(r.res, sc);
    const first = p.notes[0], loud = p.notes.find((n) => n.vel >= 0.79);
    expect(first.vel).toBeCloseTo(0.42, 2); expect(loud).toBeTruthy(); // p ... f
    expect(first.sound).toBe(first.dur); // under a slur: legato
    const xml = toMusicXML(r.res, sc, {});
    expect(xml).toContain('<dynamics><p/></dynamics>'); expect(xml).toContain('<wedge type="crescendo"/>'); expect(xml).toContain('<slur type="start"');
  });
});

describe('bowing marks', () => {
  test('up-bows and down-bows read, stacked marks kept, exported as <technical>', () => {
    const r = evaluate('bowing', 'clean');
    let ok = 0, n = 0, fp = 0;
    for (const [t, g] of r.pairs) { for (const a of t.artic.filter((x) => x.endsWith('bow'))) { n++; if (g.artic.includes(a)) ok++; } fp += g.artic.filter((a) => a.endsWith('bow') && !t.artic.includes(a)).length; }
    expect(n).toBe(22); expect(ok).toBe(n); expect(fp).toBe(0);
    const xml = toMusicXML(r.res, buildScore(r.res), {});
    expect(xml).toContain('<technical><down-bow/></technical>'); expect(xml).toContain('<technical><up-bow/></technical>');
  });
});

describe('grace notes', () => {
  test('found, take no time, play just before their note, export with a slash', () => {
    const r = evaluate('grace', 'clean'), sc = buildScore(r.res), R = evaluateRhythm(r);
    const truthG = r.tn.filter((t) => t.grace), found = truthG.filter((t) => r.pairs.some(([q, g]) => q === t && g.grace));
    expect(found.length).toBeGreaterThanOrEqual(6);
    expect(R.bars).toBeGreaterThanOrEqual(7); // bars still add up: graces take no time
    const p = performance(r.res, sc), g = p.notes.find((n) => n.dur === 12 && n.tick > 0), next = p.notes.find((n) => n.tick > g.tick);
    expect(next.tick - g.tick).toBe(14);
    expect(toMusicXML(r.res, sc, {})).toContain('<grace slash="yes"/>');
    // slashed (acciaccatura) or not (appoggiatura), from the slash through the stem
    const kinds = r.pairs.filter(([t, q]) => t.grace && q.grace);
    expect(kinds.every(([t, q]) => (t.grace === 'unacc') === (q.graceKind === 'acc'))).toBe(true);
    expect(kinds.some(([, q]) => q.graceKind === 'app')).toBe(true);
    expect(toMusicXML(r.res, sc, {})).toContain('<grace/>');
    // an appoggiatura takes half its note, on the beat; the note starts late
    const g6 = p.notes.find((n) => n.midi === 73 && n.dur === 144), b6 = g6 && p.notes.find((n) => n.midi === 71 && n.tick === g6.tick + 144);
    expect(g6 && b6 && b6.dur).toBe(144); // bar 6: C♯ appoggiatura takes half of the dotted half B
  });
});

describe('saving corrections', () => {
  test('edits survive re-reading the page, and a project file round-trips', async () => {
    const { markOriginal, collectEdits, applyEdits, makeProject, readProject } = await import('./edits.js');
    const { yOfP } = await import('./omr.js');
    const read = () => markOriginal(analyze(normalize(loadFixture('minuet').img)));
    const a = read(), st = a.staves[0], n = st.notes[3], gone = st.notes[5];
    // a pitch moved a step, an accidental, a value fix, an articulation, a deleted note, a key
    n.p += 1; n.y = yOfP(st, n.p, n.x); n.accid = { ids: [], box: n.box, type: 1 }; n.fix = { dur: 2, dots: 0, tuplet: null };
    st.notes[4].artic = ['stacc']; st.notes.splice(st.notes.indexOf(gone), 1); a.staves[1].key.fifths = 0;
    for (const q of a.staves) interpret(q);
    const ed = collectEdits(a);
    expect(ed.notes.length).toBe(3); expect(ed.staves).toEqual([{ si: 1, fifths: 0 }]);
    const pr = readProject(makeProject({ bytes: new Uint8Array([1, 2, 3]), name: 'm.png', mime: 'image/png', pages: { 1: ed }, settings: { to: 'alto-sax' } }));
    expect([...pr.bytes]).toEqual([1, 2, 3]); expect(pr.settings.to).toBe('alto-sax');
    const b = read(), r = applyEdits(b, pr.pages[1], { interpret, yOfP });
    expect(r).toEqual({ applied: 4, missed: 0 });
    const sb = b.staves[0];
    expect(sb.notes.length).toBe(st.notes.length);
    expect(sb.notes.map((q) => q.name)).toEqual(st.notes.map((q) => q.name));
    expect(sb.notes[3].fix.dur).toBe(2); expect(sb.notes[4].artic).toEqual(['stacc']);
    expect(b.staves[1].notes.map((q) => q.name)).toEqual(a.staves[1].notes.map((q) => q.name));
    expect(collectEdits(b)).toEqual(ed); // and saving it again gives the same edits
  });
});

describe('metronome', () => {
  test('beats follow the meter; a pickup counts back from its bar line', async () => {
    const { beats } = await import('./player.js');
    const r = evaluate('sixeight', 'clean'), b = beats(buildScore(r.res));
    // 6/8 with an eighth pickup: no click in the pickup (it is the last eighth of a bar), then
    // two dotted-quarter beats a bar, accent on each downbeat
    expect(b[0]).toEqual({ tick: 48, accent: true }); expect(b[1]).toEqual({ tick: 48 + 144, accent: false });
    const m = evaluate('minuet', 'clean'), bm = beats(buildScore(m.res));
    expect(bm.slice(0, 4).map((q) => q.tick)).toEqual([0, 96, 192, 288]); expect(bm.filter((q) => q.accent).length).toBe(24);
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
  test('meter inference retries with inexpensive rhythm repairs', () => {
    const s = st([
      { x: 100, d: 2 }, { x: 160, d: 8, b: 1 },
      { x: 300, d: 2 }, { x: 360, d: 8, b: 1 },
      { x: 500, d: 2 }, { x: 560, d: 8, b: 1 },
      { x: 700, d: 2 }, { x: 760, d: 8, b: 1 },
    ]);
    s.times = [];
    s.bars = [{ x: 200, ids: [] }, { x: 400, ids: [] }, { x: 600, ids: [] }, { x: 800, ids: [] }];
    const sc = buildScore({ space: 16, staves: [s] });
    expect(sc.measures.every((m) => m.time?.beats === 3 && m.time?.unit === 4 && m.time?.inferred)).toBe(true);
    expect(sc.measures.every((m) => m.status === 'ok')).toBe(true);
    expect(sc.measures.every((m) => m.repairs.includes('one beam fewer'))).toBe(true);
  });
  test('tick arithmetic', () => {
    expect(baseTicks(4, 1)).toBe(144); expect(evTicks({ dur: 8, dots: 0, tuplet: [3, 2] })).toBe(32);
  });
  test('glyph classifier reads rasterized accidentals and rests on a staff', async () => {
    const { classify } = await import('./glyphnet.js');
    const read = (name, font) => {
      const g = rasterGlyph(GLYPHS[font][name].d, 16), w = 80, h = 120, data = new Uint8Array(w * h);
      for (let k = 0; k < 5; k++) for (let x = 0; x < w; x++) for (let y = 28 + 16 * k; y < 30 + 16 * k; y++) data[y * w + x] = 1;
      for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.m[y * g.w + x]) data[(60 - (g.h >> 1) + y) * w + 40 - (g.w >> 1) + x] = 1;
      const p = classify({ w, h, data }, [40 - (g.w >> 1), 60 - (g.h >> 1), 40 - (g.w >> 1) + g.w - 1, 60 - (g.h >> 1) + g.h - 1]);
      return Object.entries(p).sort((a, b) => b[1] - a[1])[0][0];
    };
    for (const font of ['Bravura', 'Leland']) {
      expect(read('sharp', font)).toBe('sharp'); expect(read('flat', font)).toBe('flat'); expect(read('natural', font)).toBe('natural');
      expect(read('doubleSharp', font)).toBe('dsharp'); expect(read('rest8th', font)).toBe('rest8');
    }
  });
  test('glyph rasterizer', () => {
    const r = rasterGlyph(GLYPHS.Bravura.restQuarter.d, 16);
    expect(r.h).toBeGreaterThan(40); expect(r.m.reduce((a, v) => a + v, 0)).toBeGreaterThan(200);
  });
});

// The CODA audition sheet (Brahms 2 + Fledermaus, viola, alto clef), page 1 rendered at 3000 px
// and scaled to 2400 as the app does (fixtures/coda_p1.png).
const CODA = new URL('./fixtures/coda_p1.png', import.meta.url);
describe('real page: CODA viola audition sheet', () => {
  // Snapshot of the whole reading (snapshots/coda.json, checked in): pitch names and
  // values of every bar, keys, clefs, ties, articulations, bowing, graces, dynamics, slurs.
  // A change fails with the bars that differ. If the change is an improvement, accept it with
  //   UPDATE_SNAPSHOTS=1 bun test
  test('reads exactly as the snapshot', async () => {
    const { snapshot, diffSnapshots } = await import('./snapshot.js');
    const file = new URL('./snapshots/coda.json', import.meta.url);
    const got = snapshot(analyze(normalize(decodeGray(fs.readFileSync(CODA)))));
    if (process.env.UPDATE_SNAPSHOTS || !fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(got, null, 1) + '\n');
    const want = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(diffSnapshots(want, got)).toEqual([]);
  });
  test('every bar adds up', () => {
    const r = analyze(normalize(decodeGray(fs.readFileSync(CODA)))), sc = buildScore(r);
    expect(r.staves.map((s) => s.key.fifths)).toEqual([2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3]);
    expect(r.staves[0].times[0]).toMatchObject({ beats: 3, unit: 4 });
    expect(r.staves[6].times[0].sym).toBe('cut');
    expect(sc.stats.under + sc.stats.over).toBe(0);
    expect(sc.measures.length).toBeGreaterThanOrEqual(66);
    // ties the page has: the opening E4 over bars 1-2-3, E5 bar 3 into 4, G♯4 bar 15 into 16
    const bar = (k) => sc.measures[k - 1].events.filter((e) => e.notes);
    expect(bar(1).at(-1).tie && bar(2).at(-1).tie && bar(3).at(-1).tie).toBe(true);
    // the E5 at the end of bar 3 is tied into bar 4 (that tie touches the phrase slur); playback
    // must sound it once, held over the barline
    expect(bar(3).at(-1).notes[0].name).toBe('E5'); expect(bar(3).at(-1).tie).toBe(true);
    expect(bar(4)[0].notes[0].name).toBe('E5');
    const pf = performance(r, sc).notes.filter((n) => n.midi === 76);
    expect(pf[0].dur).toBe(96 + 192); // quarter tied to half: one note, three beats
    expect(bar(16)[0].notes[0].name).toBe('G♯4'); // tied from bar 15: keeps its sharp
    // bowing as printed: bar 11 down, up; bar 12 starts down-bow on its second note
    expect(bar(11)[0].notes[0].artic).toContain('dnbow'); expect(bar(11)[1].notes[0].artic).toContain('upbow');
    expect(bar(12)[1].notes[0].artic).toContain('dnbow'); expect(bar(1)[0].notes[0].artic).toContain('upbow');
    // the waltz's acciaccaturas (bars 56 and 58): a G♯4 grace before the F♯4
    for (const k of [56, 58]) { expect(bar(k)[0].grace).toBe(true); expect(bar(k)[0].notes[0].graceKind).toBe('acc'); expect(bar(k)[0].notes[0].name).toBe('G♯4'); expect(bar(k)[1].notes[0].name).toBe('F♯4'); }
    const dyn = r.staves.flatMap((s) => s.dynamics.map((d) => d.text));
    expect(dyn.filter((d) => d === 'f').length).toBeGreaterThanOrEqual(7); expect(dyn).toContain('pp'); expect(dyn).toContain('mp');
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

// Key changes inside a staff: Telemann, Fantasia 12 (TWV 40:13), Presto, from the scanned 1955
// Bärenreiter edition on IMSLP (#96616): g minor -> [Maggiore] G major after a repeat bar
// (♮♮♯), and back -> [Minore] (♮♭♭). One staff each, quantised to 16 grey levels.
describe('key change inside a staff (Telemann Fantasia 12, IMSLP #96616)', () => {
  const read = (n) => analyze(normalize(decodeGray(fs.readFileSync(new URL(`./fixtures/scan_telemann_${n}.png`, import.meta.url)))));
  for (const [name, from, to] of [['maggiore', -2, 1], ['minore', 1, -2]]) test(name, () => {
    const r = read(name), st = r.staves[0];
    expect(r.staves.length).toBe(1);
    expect(st.key.fifths).toBe(from);
    expect(st.keyChanges.map((k) => k.fifths)).toEqual([to]);
    const k = st.keyChanges[0];
    // notes after the change are read in the new key, before it in the old
    const before = st.notes.filter((n) => n.x < k.x0), after = st.notes.filter((n) => n.x > k.x1);
    expect(before.length).toBeGreaterThan(5); expect(after.length).toBeGreaterThan(5);
    const fs_ = (ns, f) => ns.filter((n) => n.pitch.d % 7 === 3 && !n.accid).every((n) => n.pitch.alter === (f > 0 ? 1 : 0)); // F: ♯ in G major only
    expect(fs_(after, to) && fs_(before, from)).toBe(true);
    // B♭ clarinet: g minor -> a minor (0), G major -> A major (3)
    const pl = plan(r, { from: 'C', to: 'Bb-clarinet', octave: 0, clef: 'keep' });
    expect(pl.staves[0].fifths).toBe(from + 2);
    expect(pl.staves[0].changes.map((c) => c.fifths)).toEqual([to + 2]);
    // MusicXML written for the clarinet carries both keys
    const xml = toMusicXML(r, buildScore(r), { plan: pl, title: 't' });
    expect([...xml.matchAll(/<fifths>(-?\d+)<\/fifths>/g)].map((m) => +m[1])).toEqual([from + 2, to + 2]);
  });
});

// A bold sharp whose crossbars fill the gap between its stems (Bärenreiter scan, Fantasia 12,
// G major section): it used to read as one wide stroke, so the staff lost its key signature.
test('bold scanned sharp in a key signature (IMSLP #96616)', () => {
  const r = analyze(normalize(decodeGray(fs.readFileSync(new URL('./fixtures/scan_telemann_boldsharp.png', import.meta.url)))));
  expect(r.staves.length).toBe(1);
  expect(r.staves[0].key.detected).toBe(1);
});

// A flat above the staff whose bowl a ledger line cuts away from its stem (Sibelius, Symphony
// No. 2, viola part, p. 4, first system; the score #046 in midiviz ships): the bowl alone read as
// a double sharp, so B♭ came out as B𝄪. The stem keeps the stub of the bowl's bottom, a little
// wider than a bare stroke, and must still be re-paired with its bowl.
test('a flat cut by a ledger line is still a flat (Sibelius 2, viola)', () => {
  const r = analyze(normalize(decodeGray(fs.readFileSync(new URL('./fixtures/scan_sibelius2_va_p4.png', import.meta.url)))));
  const notes = r.staves[0].notes;
  expect(notes.some((n) => n.accid?.type === 2)).toBe(false);
  expect(notes.filter((n) => n.accid?.type === -1).length).toBeGreaterThanOrEqual(3);
  expect(notes.filter((n) => n.name === 'B♭4').length).toBeGreaterThanOrEqual(4);
  expect(notes.some((n) => n.name.startsWith('B♯'))).toBe(false);
});

// A flat touching the hollow head it belongs to loses the bottom of its bowl to that note's stem,
// so its position reads half a step low and it found no head at its pitch: bar 198's E♭5 half
// note read as E5 (same page, the first three systems).
test('a flat touching its half note is still that note\'s (Sibelius 2, viola, bar 198)', () => {
  const r = analyze(normalize(decodeGray(fs.readFileSync(new URL('./fixtures/scan_sibelius2_va_p4_top.png', import.meta.url)))));
  const bar = (k) => r.staves[0].notes.filter((n) => n.bar === k).map((n) => n.name);
  expect(bar(2)).toEqual(['A4', 'B♭4', 'C5', 'D5', 'E♭5', 'D5']);
});

// An orchestral part that goes divisi on two braced staves for a few lines (Sibelius 2, viola,
// p. 2, bars 117-127): the lower staves are a second part only on those systems. Its bars must
// sound with the bars they stand under, not from the top of the page at the same time as them.
test('a divisi staff plays with the bars it stands under (Sibelius 2, viola)', () => {
  const r = analyze(normalize(decodeGray(fs.readFileSync(new URL('./fixtures/scan_sibelius2_va_divisi.png', import.meta.url)))));
  const sc = buildScore(r);
  expect(sc.parts.length).toBe(2);
  const [upper, lower] = sc.parts;
  const starts = new Map(); let t = 0;
  for (const m of upper.measures) { starts.set(m, t); t += m.status === 'rest' ? m.cap : m.ticks; }
  // every divisi bar starts where the upper bar of its system starts
  for (const m of lower.measures) {
    const over = upper.measures.find((q) => q.st.system === m.st.system && (m.x0 + m.x1) / 2 >= q.x0 && (m.x0 + m.x1) / 2 < q.x1);
    expect(m.at).toBe(starts.get(over));
  }
  const firstDivisi = Math.min(...upper.measures.filter((q) => lower.staves.some((st) => st.system === q.st.system)).map((q) => starts.get(q)));
  const notes = performance(r, sc).notes;
  expect(Math.min(...notes.filter((n) => n.part === 1).map((n) => n.tick))).toBeGreaterThanOrEqual(firstDivisi);
  expect(firstDivisi).toBeGreaterThan(0);
});

// Opening key signatures that begin with naturals, and the key carried over from the previous
// page (a part's next page, or a key change at the page turn). Fixtures spliced from the
// Telemann crops above by tools/make_key_fixtures.mjs: the key change in each crop moved to the
// start of the staff, so the glyphs are the scan's own.
describe('opening naturals and the previous page\'s key', () => {
  const page = (n) => normalize(decodeGray(fs.readFileSync(new URL(`./fixtures/${n}.png`, import.meta.url))));
  const key = (st) => ({ fifths: st.key.fifths, detected: st.key.detected, cancellation: st.key.cancellation, types: st.key.glyphs.map((g) => g.type) });
  test('naturals then sharps or flats replace the key; naturals alone cancel it', () => {
    expect(key(analyze(page('key_open_naturals_sharp')).staves[0])).toEqual({ fifths: 1, detected: 1, cancellation: false, types: [0, 0, 1] });
    expect(key(analyze(page('key_open_naturals_flats')).staves[0])).toEqual({ fifths: -2, detected: -2, cancellation: false, types: [0, -1, -1] });
    expect(key(analyze(page('key_open_cancel')).staves[0])).toEqual({ fifths: 0, detected: 0, cancellation: true, types: [0, 0] });
  });
  test('printed keys win over the previous page; staves with none take it', () => {
    // the part was in D major: a printed G major or g minor or C (cancelled) is the new key
    expect(analyzeAfter(page('key_open_naturals_sharp'), 2).staves[0].key.fifths).toBe(1);
    expect(analyzeAfter(page('key_open_naturals_flats'), 2).staves[0].key.fifths).toBe(-2);
    expect(analyzeAfter(page('key_open_cancel'), 2).staves[0].key.fifths).toBe(0);
    // a staff whose signature was not found reads in the previous page's key, and its pitches
    // follow (re-read after the key is applied)
    const missed = analyzeAfter(page('key_missing'), 2), st = missed.staves[0];
    expect([st.key.fifths, st.key.documentInferred]).toEqual([2, true]);
    const cs = st.notes.filter((n) => n.pitch.d % 7 === 0 && !n.accid);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((n) => n.pitch.alter === 1)).toBe(true); // C♯
    expect(analyze(page('key_missing')).staves[0].key.fifths).toBe(0); // (without it: C)
    const keyless = analyzeAfter(page('key_keyless_pair'), 2);
    // two keyless staves in a row are a C / a-minor section, not a missed key: kept at 0
    expect(keyless.staves.map((s) => [s.key.fifths, !!s.key.keylessSection])).toEqual([[0, true], [0, true]]);
  });
  test('needsPriorKey / applyPriorKey', () => {
    const st = (key) => ({ key, notes: [], clef: { type: 'treble' } });
    const missing = st({ fifths: 0, detected: 0, glyphs: [] }), keyless = st({ fifths: 0, detected: 0, glyphs: [], keylessSection: true });
    const printed = st({ fifths: 2, detected: 2, glyphs: [{}, {}] }), cancelled = st({ fifths: 0, detected: 0, cancellation: true, glyphs: [{ type: 0 }] });
    expect(needsPriorKey([keyless], 2)).toBe(false);
    expect(needsPriorKey([missing, keyless, printed], 2)).toBe(true);
    expect(needsPriorKey([missing, cancelled], 2)).toBe(false); // the page cancels the old key
    expect(needsPriorKey([missing], null)).toBe(false);
    expect(applyPriorKey([missing, keyless, printed], 2)).toBe(1);
    expect([missing, keyless, printed].map((s) => s.key.fifths)).toEqual([2, 0, 2]);
    expect(missing.key.documentInferred).toBe(true);
    const other = st({ fifths: 0, detected: 0, glyphs: [] });
    expect(applyPriorKey([other, st({ fifths: 1, detected: 1, glyphs: [{}] })], 2)).toBe(0);
    expect(other.key.fifths).toBe(0);
  });
  test('a cancelling signature gives the renderer natural samples, not sharps', () => {
    const m = analyze(page('key_open_naturals_sharp'));
    const fake = { m, maskCrop: () => null, cropCanvas: () => null };
    Renderer.prototype.collectSamples.call(fake);
    expect(Object.keys(fake.samples).sort()).toEqual(['natural', 'sharp']);
  });
});

// Page rendering can be cancelled (opening another page while one decodes), and its pdf.js
// page is cleaned up whatever happens.
describe('PDF page rendering', () => {
  const fakeDoc = (opts = {}) => {
    const log = { cleanup: 0, cancel: 0 };
    let finish;
    const page = {
      getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
      cleanup: () => log.cleanup++,
      render: () => ({ promise: new Promise((res, rej) => { finish = { res, rej }; if (opts.instant) res(); }), cancel: () => { log.cancel++; finish.rej(new Error('Rendering cancelled')); } }),
    };
    return { log, doc: { getPage: async () => page } };
  };
  globalThis.document ??= { createElement: () => ({ getContext: () => ({ fillRect() {} }) }) };
  test('completes, keeping the page when asked', async () => {
    const { renderPage } = await import('./pdfsource.js');
    const { log, doc } = fakeDoc({ instant: true });
    const out = await renderPage(doc, 1, 800, true);
    expect([out.widthPt, out.heightPt, log.cleanup]).toEqual([600, 800, 0]);
    await renderPage(doc, 1, 800, false);
    expect(log.cleanup).toBe(1);
  });
  test('an abort cancels the render and cleans up', async () => {
    const { renderPage } = await import('./pdfsource.js');
    const before = fakeDoc(), ac0 = new AbortController(); ac0.abort();
    await expect(renderPage(before.doc, 1, 800, true, ac0.signal)).rejects.toThrow(/cancelled/);
    const during = fakeDoc(), ac = new AbortController();
    const p = renderPage(during.doc, 1, 800, true, ac.signal);
    await new Promise((r) => setTimeout(r, 0)); ac.abort();
    await expect(p).rejects.toThrow(/cancelled/i);
    expect(during.log).toEqual({ cleanup: 1, cancel: 1 }); // kept pages too: a half-rendered page is not reused
  });
});

// Leopold Auer's edition of Bach's Partita No. 1, BWV 1002 (Carl Fischer, 1917; IMSLP #921334,
// public domain), the Allemande's first three systems at 2400 px. Tight engraving: most slurs
// touch a stem, a head or a staccato dot on a staff line, sit between two staves, or are cut
// apart by the stems they cross; the bowing marks sit above the beams. 36 slurs by eye and 4
// bowing marks (down, up, up, down); before arcs merged into note ink were recovered 19 slurs
// were read, 27 before steep slurs between voices were
test('slurs and bowings in a tightly engraved violin edition (Auer, IMSLP #921334)', () => {
  const r = analyze(normalize(decodeGray(fs.readFileSync(new URL('./fixtures/auer_bwv1002_allemanda.png', import.meta.url)))));
  expect(r.staves.length).toBe(3);
  const slurs = r.staves.reduce((a, s) => a + s.slurs.length, 0);
  expect(slurs).toBeGreaterThanOrEqual(33);
  expect(slurs).toBeLessThanOrEqual(38);
  // steep slurs between voices (a bass note to the melody): 9 by eye, each joining two chords
  const steep = r.staves.flatMap((s) => s.slurs.filter((q) => q.steep));
  expect(steep.length).toBeGreaterThanOrEqual(8);
  for (const q of steep) { expect(q.from && q.to).toBeTruthy(); expect(q.to.x).toBeGreaterThan(q.from.x); }
  // (the bracket round the 8/8 is curved, thin and tall too, but joins no notes)
  expect(steep.some((q) => q.box[0] < 450 && q.box[3] < 260)).toBe(false);
  const bows = r.notes.filter((n) => n.artic.some((a) => /bow/.test(a))).map((n) => n.artic.find((a) => /bow/.test(a)));
  expect(bows.filter((b) => b === 'upbow').length).toBe(2);
  expect(bows.filter((b) => b === 'dnbow').length).toBe(2);
});

// bun test  — recognizer, parser, theory, layout and export, on synthetic handwriting.
import { test, expect, describe } from 'bun:test';
import fs from 'fs';
import { loadModel, classify, features, N_FEATURES, makeUserTemplate } from './recognizer.js';
import { newScore, spellScore, ticks, measureCapacity, keyAlter } from './theory.js';
import { layoutScore, beamGroups, locate } from './layout.js';
import { interpret, parseNote, removeEvent, articShapes } from './parser.js';
import { toMusicXML, toMidi, performance } from './export.js';
import { hasArtic } from './theory.js';
import * as I from './testink.js';
import { buildExtraTemplates, inkWord, rng, DYN_WORDS } from './extras.js';
import { rankTemplates } from './recognizer.js';
import { velocities } from './export.js';
import { ticks as tk } from './theory.js';

const model = loadModel(JSON.parse(fs.readFileSync(new URL('./model.json', import.meta.url))));
const extras = buildExtraTemplates(JSON.parse(fs.readFileSync(new URL('./digits.json', import.meta.url))));
const WIDTH = 64;

function session(opts) {
  const score = newScore(opts);
  const s = { score, pending: [], log: [] };
  s.L = () => layoutScore(s.score, { width: WIDTH });
  s.write = (strokes, forced) => {
    const L = s.L();
    const e = interpret(strokes, { score: s.score, L, model, user: s.user || [], pending: s.pending, extras }, forced);
    if (!e) { s.log.push(null); return null; }
    const r = e.apply(s.score);
    if (r && r.pending) s.pending.push(r.pending);
    s.log.push(e);
    return e;
  };
  s.top = (si = 0, sys = 0) => s.L().systems[sys].staffTops[si];
  /** x inside measure mi after its existing content */
  s.xIn = (mi, frac = 0.5) => { const m = s.L().measures[mi]; return m.reserveX + (m.x1 - m.reserveX) * frac * 0.6 + 0.8; };
  s.events = (mi = 0, si = 0) => s.score.measures[mi].staves[si].events;
  return s;
}

describe('recognizer', () => {
  test('features have a fixed length', () => {
    expect(features(I.note(10, 5, 2)).length).toBe(N_FEATURES);
  });
  const cases = [
    ['Quarter-Note', () => I.note(10, 5, 2)], ['Quarter-Note', () => I.note(10, 5, 7)],
    ['Half-Note', () => I.note(10, 5, 1, { filled: false })], ['Eighth-Note', () => I.note(10, 5, 2, { flags: 1 })],
    ['Sixteenth-Note', () => I.note(10, 5, 2, { flags: 2 })], ['Whole-Note', () => I.wholeNote(10, 5, 3)],
    ['Sharp', () => I.sharp(10, 5, 3)], ['Flat', () => I.flat(10, 5, 3)], ['Natural', () => I.natural(10, 5, 3)],
    ['Quarter-Rest', () => I.quarterRest(10, 5)], ['Whole-Half-Rest', () => I.blockRest(10, 5, 5)], ['G-Clef', () => I.trebleClef(10, 3)],
  ];
  for (const [label, make] of cases) test(`classifies ${label}`, () => { expect(classify(make(), model)[0].label).toBe(label); });

  test('size matters: a tiny loop is not a whole note', () => {
    const tiny = [I.hollowHead(5, 5, 0.3, 0.25)];
    expect(classify(tiny, model)[0].label).not.toBe('Whole-Note');
  });

  test('a user correction teaches the recogniser', () => {
    const ink = I.quarterRest(10, 5);
    const user = [makeUserTemplate('Eighth-Rest', ink)];
    expect(classify(ink, model, { user })[0].label).toBe('Eighth-Rest');
    expect(classify(I.note(10, 5, 2), model, { user })[0].label).toBe('Quarter-Note');
  });
});

describe('structural note parse', () => {
  test('stem up, filled head, pitch from height', () => {
    const r = parseNote(I.note(10, 5, 2), 10);
    expect(r.stem.up).toBe(true); expect(r.heads.map((h) => h.pos)).toEqual([2]); expect(r.filled).toBe(true);
  });
  test('stem down, open head', () => {
    const r = parseNote(I.note(10, 5, 7, { filled: false }), 10);
    expect(r.stem.up).toBe(false); expect(r.heads.map((h) => h.pos)).toEqual([7]); expect(r.filled).toBe(false);
  });
});

describe('theory', () => {
  test('ticks and capacity', () => {
    expect(ticks({ dur: 4 })).toBe(96); expect(ticks({ dur: 4, dots: 1 })).toBe(144); expect(ticks({ dur: 8, dots: 2 })).toBe(84);
    expect(measureCapacity([6, 8])).toBe(288);
  });
  test('key signatures', () => {
    expect(keyAlter(-1, 6)).toBe(-1); expect(keyAlter(2, 0)).toBe(1); expect(keyAlter(2, 4)).toBe(0);
  });
  test('accidentals carry through the bar, key signature applies', () => {
    const s = newScore({ key: -1 });
    const B = (acc = null) => ({ id: s.nextId++, kind: 'note', dur: 4, heads: [{ pos: 4, acc }] });
    s.measures[0].staves[0].events.push(B(), B(0), B());
    s.measures[1].staves[0].events.push(B());
    const { spelled } = spellScore(s);
    const midis = [...s.measures[0].staves[0].events, ...s.measures[1].staves[0].events].map((e) => spelled.get(e)[0].midi);
    expect(midis).toEqual([70, 71, 71, 70]);
  });
});

describe('writing', () => {
  test('a quarter note lands on G4', () => {
    const s = session();
    s.write(I.note(s.top(), s.xIn(0, 0.1), 2));
    const ev = s.events()[0];
    expect(ev).toMatchObject({ kind: 'note', dur: 4, heads: [{ pos: 2 }] });
    expect(spellScore(s.score).spelled.get(ev)[0].midi).toBe(67);
  });

  test('a bar of four notes, then the next bar; paper keeps one blank bar', () => {
    const s = session();
    for (const p of [2, 4, 6, 3]) s.write(I.note(s.top(), s.xIn(0), p));
    expect(s.events(0).map((e) => e.heads[0].pos)).toEqual([2, 4, 6, 3]);
    s.write(I.note(s.top(), s.xIn(1, 0.1), 5, { filled: false }));
    expect(s.events(1)).toHaveLength(1);
    expect(s.events(1)[0].dur).toBe(2);
    expect(s.score.measures).toHaveLength(3);
  });

  test('sharp before a note, written first', () => {
    const s = session();
    const x = s.xIn(0, 0.1);
    const e = s.write(I.sharp(s.top(), x, 3));
    expect(e.label).toBe('Sharp');
    expect(s.pending).toHaveLength(1);
    s.write(I.note(s.top(), x + 1.9, 3));
    expect(s.events()[0].heads[0].acc).toBe(1);
    expect(s.pending).toHaveLength(0);
  });

  test('flat added in front of an existing note', () => {
    const s = session();
    s.write(I.note(s.top(), s.xIn(0, 0.2), 4));
    const hx = s.L().evPos.get(s.events()[0].id).x;
    s.write(I.flat(s.top(), hx - 1.4, 4));
    expect(s.events()[0].heads[0].acc).toBe(-1);
  });

  test('a stemless head on an existing stem makes a chord', () => {
    const s = session();
    s.write(I.note(s.top(), s.xIn(0, 0.2), 2));
    const p = s.L().evPos.get(s.events()[0].id);
    s.write([I.filledHead(p.x + 0.6, p.top + 4 - 6 / 2)]);
    expect(s.events()).toHaveLength(1);
    expect(s.events()[0].heads.map((h) => h.pos).sort()).toEqual([2, 6]);
  });

  test('dot to the right = dotted, dot under = staccato', () => {
    const s = session();
    s.write(I.note(s.top(), s.xIn(0, 0.2), 3));
    let p = s.L().evPos.get(s.events()[0].id);
    s.write(I.dot(p.x + 1.8, p.heads[0].y));
    expect(s.events()[0].dots).toBe(1);
    s.write(I.note(s.top(), s.xIn(0), 6));
    p = s.L().evPos.get(s.events()[1].id);
    s.write(I.dot(p.x + 0.6, p.heads[0].y - 1.3));
    expect(s.events()[1].stacc).toBe(true);
  });

  test('a line across two stem tips beams them', () => {
    const s = session();
    s.write(I.note(s.top(), s.xIn(0, 0.1), 2));
    s.write(I.note(s.top(), s.xIn(0, 0.1), 3));
    const [a, b] = s.events().map((e) => s.L().evPos.get(e.id));
    const e = s.write(I.straight(a.stem.x - 0.1, a.stem.y1 + 0.2, b.stem.x + 0.1, b.stem.y1 + 0.1));
    expect(e.kind).toBe('beam');
    expect(s.events().map((x) => x.dur)).toEqual([8, 8]);
    const g = beamGroups(s.events(), [4, 4]);
    expect(g).toHaveLength(1);
  });

  test('an arc between equal pitches is a tie, otherwise a slur', () => {
    const s = session();
    for (const p of [3, 3, 5]) s.write(I.note(s.top(), s.xIn(0), p));
    const [a, b, c] = s.events().map((e) => s.L().evPos.get(e.id));
    const hw = s.L().headW;
    expect(s.write(I.arc(a.x + hw, a.heads[0].y + 0.6, b.x, b.heads[0].y + 0.6, 0.5)).kind).toBe('tie');
    expect(s.events()[0].tie).toBe(true);
    expect(s.write(I.arc(b.x + hw / 2, b.heads[0].y + 0.7, c.x + hw / 2, c.heads[0].y + 0.7, 0.7)).kind).toBe('slur');
    expect(s.score.slurs).toHaveLength(1);
    const perf = performance(s.score);
    expect(perf.notes).toHaveLength(2); // tied pair sounds once
    expect(perf.notes[0].dur).toBe(192);
  });

  test('scribbling over a note erases it', () => {
    const s = session();
    s.write(I.note(s.top(), s.xIn(0, 0.1), 4));
    s.write(I.note(s.top(), s.xIn(0), 5));
    const p = s.L().evPos.get(s.events()[0].id);
    const e = s.write(I.scribble(p.bbox.x0 - 0.3, p.bbox.y0, p.bbox.x1 + 0.3, p.bbox.y1, 7));
    expect(e.kind).toBe('erase');
    expect(s.events().map((x) => x.heads[0].pos)).toEqual([5]);
  });

  test('block rests: hanging = whole (bar rest), sitting = half', () => {
    const s = session();
    s.write(I.blockRest(s.top(), s.xIn(0, 0.2), 5));
    expect(s.events(0)[0]).toMatchObject({ kind: 'rest', dur: 1, full: true });
    s.write(I.blockRest(s.top(), s.xIn(1, 0.1), 4));
    expect(s.events(1)[0]).toMatchObject({ kind: 'rest', dur: 2 });
  });

  test('ledger lines are ignored, the note below them is kept', () => {
    const s = session();
    const x = s.xIn(0, 0.2), top = s.top();
    const ink = [...I.note(top, x, -2), ...I.straight(x - 0.9, top + 5, x + 0.9, top + 5)];
    s.write(ink);
    expect(s.events()[0].heads[0].pos).toBe(-2);
  });

  test('ink far from every staff is not forced onto one', () => {
    const s = session();
    const e = s.write(I.note(s.top() + 22, s.xIn(0, 0.2), 2));
    expect(e.kind).toBe('none');
    expect(s.events()).toHaveLength(0);
  });

  test('grand staff routes low notes to the bass staff', () => {
    const s = session({ staves: [{ clef: 'G' }, { clef: 'F' }] });
    s.write(I.note(s.top(1), s.xIn(0, 0.1), 4));
    expect(s.events(0, 1)).toHaveLength(1);
    expect(spellScore(s.score).spelled.get(s.events(0, 1)[0])[0].midi).toBe(50); // D3
  });
});

describe('tuplets, dynamics, hairpins', () => {
  const r = rng(99);
  const three = (s, mi = 0) => { for (const p of [3, 4, 5]) s.write(I.note(s.top(), s.xIn(mi, 0.1), p, { flags: 1 })); return s.events(mi); };
  test('a 3 over three eighths makes a triplet that fills one beat', () => {
    const s = session();
    const evs = three(s);
    expect(evs.map((e) => e.dur)).toEqual([8, 8, 8]);
    const ps = evs.map((e) => s.L().evPos.get(e.id));
    const cx = (ps[0].x + ps[2].x) / 2 + 0.5, y = Math.min(...ps.map((p) => p.bbox.y0)) - 1.6;
    const e = s.write(inkWord('3', cx - 0.4, y, r));
    expect(e.label).toBe('Tuplet-3');
    expect(s.events().every((x) => x.tuplet && x.tuplet.n === 3)).toBe(true);
    expect(s.events().reduce((a, x) => a + tk(x), 0)).toBe(96);
    const L = s.L();
    expect(L.tuplets).toHaveLength(1);
    expect(L.tuplets[0].bracket).toBe(false); // the three are beamed together
    const xml = toMusicXML(s.score);
    expect((xml.match(/<actual-notes>3<\/actual-notes>/g) || []).length).toBe(3);
    expect(xml).toContain('<tuplet type="start"');
    expect(xml).toContain('<duration>32</duration>');
  });
  test('quarter + eighth under a 3 is a triplet too; a lone quarter is not', () => {
    const s = session();
    s.write(I.note(s.top(), s.xIn(0, 0.1), 4));
    s.write(I.note(s.top(), s.xIn(0, 0.1), 5, { flags: 1 }));
    const ps = s.events().map((e) => s.L().evPos.get(e.id));
    s.write(inkWord('3', (ps[0].x + ps[1].x) / 2, s.top() - 2.2, r));
    expect(s.events().map((x) => !!x.tuplet)).toEqual([true, true]);
    const t = session();
    t.write(I.note(t.top(), t.xIn(0, 0.1), 4));
    const p = t.L().evPos.get(t.events()[0].id);
    const e = t.write(inkWord('3', p.x, t.top() - 2.2, r));
    expect(e.kind).toBe('none');
  });
  test('dynamics under notes attach and set playback loudness', () => {
    const s = session();
    for (const p of [2, 3, 4, 5]) s.write(I.note(s.top(), s.xIn(0), p));
    const ps = s.events().map((e) => s.L().evPos.get(e.id));
    expect(s.write(inkWord('p', ps[0].x, s.top() + 7, r)).label).toBe('Dyn-p');
    expect(s.write(inkWord('ff', ps[3].x - 0.3, s.top() + 7, r)).label).toBe('Dyn-ff');
    expect(s.events()[0].dyn).toBe('p'); expect(s.events()[3].dyn).toBe('ff');
    // a crescendo from the first note to the third ramps toward the ff
    const hx0 = ps[0].x + 1.6, hx1 = ps[2].x + 1, hy = s.top() + 6.6;
    const e = s.write([[...I.straight(hx1, hy - 0.5, hx0, hy)[0], ...I.straight(hx0, hy, hx1, hy + 0.5)[0]]]);
    expect(e.kind).toBe('hairpin');
    expect(s.score.hairpins[0]).toMatchObject({ type: 'cresc', from: s.events()[0].id, to: s.events()[2].id });
    const v = s.events().map((x) => velocities(s.score).get(x.id));
    expect(v[0]).toBeLessThan(v[1]); expect(v[1]).toBeLessThan(v[2]); expect(v[2]).toBeLessThan(v[3]);
    const xml = toMusicXML(s.score);
    expect(xml).toContain('<dynamics><p/></dynamics>');
    expect(xml).toContain('<wedge type="crescendo"/>');
    expect(xml).toContain('<wedge type="stop"/>');
    expect(s.L().hairpins).toHaveLength(1);
  });
  test('two-stroke diminuendo', () => {
    const s = session();
    for (const p of [5, 4]) s.write(I.note(s.top(), s.xIn(0), p));
    const ps = s.events().map((e) => s.L().evPos.get(e.id));
    const x0 = ps[0].x, x1 = ps[1].x + 1.2, y = s.top() + 6.6;
    const e = s.write([I.straight(x0, y - 0.5, x1, y)[0], I.straight(x0, y + 0.5, x1 + 0.1, y + 0.05)[0]]);
    expect(e && e.label).toBe('diminuendo');
  });
  test('synthetic dynamics are recognised; notes and accidentals stay away from the templates', () => {
    const rr = rng(4242);
    let ok = 0, n = 0;
    for (const w of DYN_WORDS) for (let i = 0; i < 5; i++) { n++; if (rankTemplates(inkWord(w, 5, 5, rr), extras, 1.0)[0].label === 'Dyn-' + w) ok++; }
    expect(ok / n).toBeGreaterThan(0.9);
    for (const ink of [I.wholeNote(10, 5, -2), I.note(10, 5, -3), I.sharp(10, 5, 3), I.quarterRest(10, 5)]) expect(rankTemplates(ink, extras, 1.0)[0].d).toBeGreaterThan(0.052);
  });
  test('a whole note on a ledger line below the staff is still a note', () => {
    const s = session();
    s.write(I.wholeNote(s.top(), s.xIn(0, 0.2), -2));
    expect(s.events()[0]).toMatchObject({ kind: 'note', dur: 1, heads: [{ pos: -2 }] });
  });
  test('deleting a tuplet member dissolves the tuplet', () => {
    const s = session();
    const evs = three(s);
    const ps = evs.map((e) => s.L().evPos.get(e.id));
    s.write(inkWord('3', (ps[0].x + ps[2].x) / 2, Math.min(...ps.map((p) => p.bbox.y0)) - 1.6, r));
    removeEvent(s.score, s.events()[1].id);
    expect(s.events().every((x) => !x.tuplet)).toBe(true);
  });
});

describe('articulations and slurs', () => {
  // four quarters: two stems up (low), two stems down (high)
  const four = (pos = [2, 3, 6, 7]) => { const s = session(); for (const p of pos) s.write(I.note(s.top(), s.xIn(0), p)); return s; };
  const at = (s, k) => s.L().evPos.get(s.events()[k].id);
  const cx = (p) => p.x + p.hw / 2;

  test('shapes: dash, tick, wedge, caret, arch + dot', () => {
    expect(articShapes(I.tenutoMark(5, 5))[0].label).toBe('Art-tenuto');
    expect(articShapes(I.tickMark(5, 5))[0].label).toBe('Art-staccatissimo');
    expect(articShapes(I.accentMark(5, 5))[0].label).toBe('Art-accent');
    expect(articShapes(I.marcatoMark(5, 5))[0].label).toBe('Art-marcato');
    expect(articShapes(I.fermataMark(5, 5))[0].label).toBe('Art-fermata');
    expect(articShapes(I.note(10, 5, 2))).toHaveLength(0);
    expect(articShapes(I.sharp(10, 5, 3))).toHaveLength(0);
    expect(articShapes(I.quarterRest(10, 5))).toHaveLength(0);
  });

  test('marks next to a note attach to it, on either side', () => {
    const s = four();
    const [a, b, c, d] = [0, 1, 2, 3].map((k) => at(s, k));
    // stem-up notes: under the head; stem-down notes: above the head
    expect(s.write(I.accentMark(cx(a), a.heads[0].y + 1.3)).kind).toBe('artic');
    expect(s.write(I.tenutoMark(cx(b), b.heads[0].y + 1.1)).label).toBe('Art-tenuto');
    expect(s.write(I.marcatoMark(cx(c), c.heads[0].y - 1.4)).label).toBe('Art-marcato');
    expect(s.write(I.tickMark(cx(d), d.heads[0].y - 1.3)).label).toBe('Art-staccatissimo');
    // above an up-stem note, past the stem tip, still counts
    expect(s.write(I.fermataMark(cx(a), a.stem.y1 - 1.2)).label).toBe('Art-fermata');
    const e = s.events();
    expect(hasArtic(e[0], 'accent')).toBe(true); expect(e[0].fermata).toBe(true);
    expect(hasArtic(e[1], 'tenuto')).toBe(true);
    expect(hasArtic(e[2], 'marcato')).toBe(true);
    expect(hasArtic(e[3], 'staccatissimo')).toBe(true);
    // alternatives offer other readings, including the network's
    expect(s.log[s.log.length - 1].alts.some((x) => x.source === 'mlp')).toBe(true);
  });

  test('a mark far from any note, or a big wedge under the notes, is not an articulation', () => {
    const s = four();
    const a = at(s, 0), d = at(s, 3);
    const e = s.write(I.accentMark(s.xIn(0) + 6, s.top() - 3));
    expect(e && e.kind).not.toBe('artic');
    const hp = s.write(I.straight(a.x, s.top() + 7.6, d.x + 1, s.top() + 7).concat(I.straight(a.x, s.top() + 7.6, d.x + 1, s.top() + 8.3)));
    expect(hp.kind).toBe('hairpin');
  });

  test('accent and marcato exclude each other, staccato and staccatissimo too', () => {
    const s = four();
    const a = at(s, 0);
    s.write(I.accentMark(cx(a), a.heads[0].y + 1.3));
    s.write(I.marcatoMark(cx(a), at(s, 0).bbox.y1 + 0.6));
    expect(hasArtic(s.events()[0], 'marcato')).toBe(true);
    expect(hasArtic(s.events()[0], 'accent')).toBe(false);
  });

  test('engraving: head side, stacked outward, fermata above the staff', () => {
    const s = four();
    for (const k of [0, 3]) { const ev = s.events()[k]; ev.stacc = true; ev.artic = ['accent']; ev.fermata = true; }
    const [a, , , d] = [0, 1, 2, 3].map((k) => at(s, k));
    const byArt = (p, n) => p.artics.find((m) => m.art === n);
    // stem up -> marks below the head, staccato nearest
    expect(byArt(a, 'stacc').box.y0).toBeGreaterThan(a.heads[0].y + 0.5);
    expect(byArt(a, 'accent').box.y0).toBeGreaterThan(byArt(a, 'stacc').box.y1);
    // stem down -> above
    expect(byArt(d, 'stacc').box.y1).toBeLessThan(d.heads[0].y - 0.5);
    expect(byArt(d, 'accent').box.y1).toBeLessThan(byArt(d, 'stacc').box.y0);
    for (const p of [a, d]) { const f = byArt(p, 'fermata'); expect(f.box.y1).toBeLessThan(p.top); expect(f.box.y1).toBeLessThanOrEqual(p.core.y0); }
  });

  test('scribbling over a mark removes only the mark; over a slur, only the slur', () => {
    const s = four([3, 3, 5, 5]);
    const a = at(s, 0), b = at(s, 1), c = at(s, 2);
    s.write(I.accentMark(cx(a), a.heads[0].y + 1.3));
    const m = at(s, 0).artics[0].box;
    const e = s.write(I.scribble(m.x0 - 0.3, m.y0 - 0.1, m.x1 + 0.3, m.y1 + 0.2, 6));
    expect(e.kind).toBe('erase');
    expect(s.events()).toHaveLength(4);
    expect(hasArtic(s.events()[0], 'accent')).toBe(false);
    s.write(I.arc(cx(b), b.heads[0].y + 0.8, cx(c), c.heads[0].y + 0.8, 0.8));
    expect(s.score.slurs).toHaveLength(1);
    const sl = s.L().slurs[0], mid = sl.pts[6];
    const e2 = s.write(I.scribble(mid.x - 0.9, mid.y - 0.8, mid.x + 0.9, mid.y + 0.8, 6));
    expect(e2.desc).toContain('slur');
    expect(s.score.slurs).toHaveLength(0);
    expect(s.events()).toHaveLength(4);
  });

  test('slur direction: head side, above for mixed stems, flippable; clears notes in between', () => {
    const s = four([2, 3, 2, 3]);
    const ids = s.events().map((e) => e.id);
    s.score.slurs.push({ from: ids[0], to: ids[3] });
    let sl = s.L().slurs[0];
    expect(sl.up).toBe(false); // stems up -> slur under the heads
    s.events()[1].heads[0].pos = 9; // a high note in the middle: stems now mixed
    sl = s.L().slurs[0];
    expect(sl.up).toBe(true);
    const mid = at(s, 1), apex = Math.min(...sl.pts.map((q) => q.y));
    expect(apex).toBeLessThan(mid.bbox.y0);
    s.score.slurs[0].dir = 'down';
    expect(s.L().slurs[0].up).toBe(false);
  });

  test('a slur across a line break is drawn on both lines', () => {
    const s = session();
    s.score.measures = Array.from({ length: 12 }, () => ({ attrs: {}, staves: [{ events: [0, 1, 2, 3].map((k) => ({ id: s.score.nextId++, kind: 'note', dur: 4, dots: 0, heads: [{ pos: 3 + (k % 3), acc: null }], tie: false })) }] }));
    const L = s.L();
    const seq = s.score.measures.flatMap((m) => m.staves[0].events);
    const k = seq.findIndex((e, i) => i && L.evPos.get(e.id).sys !== L.evPos.get(seq[i - 1].id).sys);
    expect(k).toBeGreaterThan(0);
    s.score.slurs.push({ from: seq[k - 2].id, to: seq[k + 1].id });
    const parts = s.L().slurs;
    expect(parts).toHaveLength(2);
    expect(parts[0].sys + 1).toBe(parts[1].sys);
    expect(parts[0].cut).toBe('end'); expect(parts[1].cut).toBe('start');
  });

  test('playback follows the marks', () => {
    const s = four([3, 3, 3, 3]);
    const [a, b, c, d] = s.events();
    b.artic = ['accent']; c.artic = ['tenuto']; d.stacc = true;
    let n = performance(s.score).notes;
    expect(n[1].vel).toBeGreaterThan(n[0].vel + 0.1);
    expect(n[2].dur).toBe(96); expect(n[0].dur).toBeLessThan(96); expect(n[3].dur).toBeLessThan(50);
    d.stacc = false; d.artic = ['staccatissimo'];
    expect(performance(s.score).notes[3].dur).toBeLessThan(n[3].dur);
    // slurred notes join up, the last one of the slur releases normally
    c.artic = [];
    s.score.slurs.push({ from: a.id, to: c.id });
    n = performance(s.score).notes;
    expect(n[0].dur).toBe(96); expect(n[1].dur).toBe(96); expect(n[2].dur).toBeLessThan(96);
    // a fermata holds its note and pushes the rest later
    b.fermata = true;
    const p = performance(s.score);
    expect(p.notes[1].dur).toBe(192); expect(p.notes[2].tick).toBe(96 * 3);
    expect(p.totalTicks).toBe(96 * 5);
  });

  test('MusicXML carries articulations, fermatas and slur placement', () => {
    const s = four([3, 3, 3, 3]);
    const [a, b, c, d] = s.events();
    a.artic = ['accent', 'tenuto']; b.artic = ['marcato']; c.stacc = true; d.artic = ['staccatissimo']; d.fermata = true;
    s.score.slurs.push({ from: a.id, to: c.id, dir: 'up' });
    const xml = toMusicXML(s.score);
    for (const t of ['<accent/>', '<tenuto/>', '<strong-accent type="up"/>', '<staccato/>', '<staccatissimo/>', '<fermata type="upright"/>', '<slur type="start" number="1" placement="above"/>']) expect(xml).toContain(t);
  });
});

describe('layout', () => {
  const fill = (score, mi, evs) => { score.measures[mi].staves[0].events = evs.map((e) => ({ id: score.nextId++, kind: 'note', heads: [{ pos: 3, acc: null }], ...e })); };
  test('eighths beam by beat', () => {
    expect(beamGroups(Array.from({ length: 8 }, (_, i) => ({ id: i, kind: 'note', dur: 8, heads: [{ pos: 3 }] })), [4, 4])).toHaveLength(4);
    expect(beamGroups(Array.from({ length: 6 }, (_, i) => ({ id: i, kind: 'note', dur: 8, heads: [{ pos: 3 }] })), [6, 8]).map((g) => g.length)).toEqual([3, 3]);
  });
  test('systems break and stay inside the page; notes move left to right', () => {
    const s = newScore();
    s.measures = [];
    for (let i = 0; i < 14; i++) { s.measures.push({ attrs: {}, staves: [{ events: [] }] }); fill(s, i, [{ dur: 8 }, { dur: 8 }, { dur: 4 }, { dur: 2 }]); }
    const L = layoutScore(s, { width: WIDTH });
    expect(L.systems.length).toBeGreaterThan(2);
    for (const sys of L.systems) expect(sys.x1).toBeLessThanOrEqual(WIDTH - 1.5 + 0.01);
    const xs = s.measures[0].staves[0].events.map((e) => L.evPos.get(e.id).x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    expect(L.beams.length).toBe(14);
  });
  test('locate finds the staff and bar under a point', () => {
    const s = newScore({ staves: [{ clef: 'G' }, { clef: 'F' }] });
    const L = layoutScore(s, { width: WIDTH });
    const sys = L.systems[0];
    expect(locate(L, sys.measures[1].x0 + 2, sys.staffTops[1] + 2)).toMatchObject({ si: 1, mi: 1 });
  });
});

describe('export', () => {
  test('MusicXML and MIDI', () => {
    const s = session();
    for (const p of [2, 4]) s.write(I.note(s.top(), s.xIn(0), p));
    s.write(I.sharp(s.top(), s.xIn(0) + 0.2, 6));
    s.write(I.note(s.top(), s.xIn(0) + 2.0, 6));
    const xml = toMusicXML(s.score);
    expect((xml.match(/<note>/g) || []).length).toBe(3);
    expect(xml).toContain('<step>G</step><octave>4</octave>');
    expect(xml).toContain('<step>D</step><alter>1</alter><octave>5</octave>');
    expect(xml).toContain('<accidental>sharp</accidental>');
    expect(xml.split('<measure ').length - 1).toBe(1);
    const mid = toMidi(s.score);
    expect(String.fromCharCode(...mid.slice(0, 4))).toBe('MThd');
    expect(mid.filter((b, i) => (b & 0xf0) === 0x90 && mid[i + 2] > 0 && i > 22).length).toBeGreaterThanOrEqual(3);
  });
});

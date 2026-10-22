// bun test — ScoreShift pages through the IR: adapter, page anchors, playback parity, and
// the OMR -> StaffInk hand-off.
import { test, expect, describe } from 'bun:test';
import { evaluate } from '../scoreshift/eval.js';
import { buildScore } from '../scoreshift/score.js';
import { performance as ssPerformance } from '../scoreshift/export.js';
import { plan } from '../scoreshift/render.js';
import { instrument } from '../scoreshift/theory.js';
import { fromScoreShift } from './adapters/scoreshift.js';
import { toStaffInk } from './adapters/staffink.js';
import { perform, playheadsAt } from './playback.js';
import { interpret, toText } from './interpret.js';
import { resolveAnchor } from './anchors.js';
import { check } from './ir.js';
import { spellScore } from '../staffink/theory.js';
import { performance as siPerformance } from '../staffink/export.js';
import { DIV } from './duration.js';
import { r, add as radd } from './rational.js';

const page = (name) => { const r = evaluate(name, 'clean'); return { model: r.res, sc: buildScore(r.res) }; };
const minuet = page('minuet');

describe('ScoreShift adapter', () => {
  const { score, byId } = fromScoreShift(minuet.model, minuet.sc, { from: instrument('C') });
  test('every timed event lands on the timeline, in order, with no overlaps', () => {
    const tl = minuet.sc.parts[0].measures.flatMap((m) => m.events).filter((e) => !e.removed && !e.grace);
    expect(score.events.length).toBe(tl.length);
    expect(check(score).filter((d) => d.kind === 'overlap')).toEqual([]);
    expect([...byId.values()].every((q) => q.e)).toBe(true);
  });
  test('the printed barlines become the bars, and the meter fits them', () => {
    const res = interpret(score);
    const printed = score.directions.filter((d) => d.kind === 'barline').length;
    expect(res.measures.length).toBe(printed);
    expect(res.measures.filter((m) => m.status === 'over' || m.status === 'under')).toEqual([]);
    expect(res.bars.every((b) => b.kind === 'explicit')).toBe(true);
  });
  test('it sounds like ScoreShift: same pitches at the same times', () => {
    const own = ssPerformance(minuet.model, minuet.sc, { from: instrument('C') }).notes.filter((n) => n.dur > 12);
    const spt = 60 / 100 / DIV;
    const ir = perform(score, { tempo: 100, root: { walk: {} } }).notes;
    expect(ir.length).toBeGreaterThan(80);
    const key = (m, t) => `${m}@${Math.round(t * 1000)}`;
    expect(ir.map((n) => key(n.midi, n.t)).sort()).toEqual(own.map((n) => key(n.midi, n.tick * spt)).sort());
  });
  test('a transposing plan: the written pitches change, the sound does not', () => {
    const pl = plan(minuet.model, { from: 'C', to: 'Bb-clarinet', octave: 'auto', clef: 'auto' });
    const t = fromScoreShift(minuet.model, minuet.sc, { plan: pl });
    expect(t.score.parts[0].transpose).toBe(-2);
    expect(t.score.events[0].heads[0].d).toBe(score.events[0].heads[0].d + 1);
    const a = perform(score, { root: { walk: {} } }).notes.map((n) => n.midi);
    expect(perform(t.score, { root: { walk: {} } }).notes.map((n) => n.midi)).toEqual(a);
  });
  test('anchors on the photo: a point on a staff, a printed bar, and the playhead back on the page', () => {
    const first = score.events[0], bar = score.directions.find((d) => d.kind === 'barline');
    expect(resolveAnchor(score, { pos: { x: first.src.x - 5, line: first.src.line } }).t).toEqual(first.onset);
    const p = perform(score, { tempo: 120, root: { play: { from: { barline: bar.id }, to: { bar: 3, edge: 'end' } } } });
    expect(p.notes[0].at).toEqual(bar.at);
    const head = playheadsAt(score, p, 0.01)[0];
    expect(Math.abs(head.pos.x - bar.src.x)).toBeLessThan(60);
    expect(head.pos.line).toBe(bar.src.line);
  });
  test('grace notes are left out and counted', () => {
    const g = page('grace');
    const r = fromScoreShift(g.model, g.sc);
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.score.events.every((e) => e.dur.n > 0)).toBe(true);
  });
});

describe('OMR -> StaffInk editing', () => {
  const { score } = fromScoreShift(minuet.model, minuet.sc, { from: instrument('C') });
  const { score: si, report } = toStaffInk(score);
  test('a valid StaffInk score: full bars, one per printed bar', () => {
    expect(si.version).toBe(1);
    expect(si.measures.length).toBe(interpret(score).measures.length + 1); // + StaffInk's empty bar to write on
    const { fill } = spellScore(si);
    const bad = fill.map((f, i) => [i, f[0]]).filter(([i, f]) => !f.full && i > 0 && i < fill.length - 1);
    expect(bad).toEqual([]);
    expect(si.time).toEqual([3, 4]);
    expect(si.key).toBe(1);
    expect(report.dropped).toEqual([]);
  });
  test('StaffInk spells and plays the same pitches the photo had', () => {
    const fromPhoto = perform(score, { root: { walk: {}, articulate: false } }).notes.map((n) => n.midi);
    const inStaffInk = siPerformance(si).notes.map((n) => n.midi);
    expect(inStaffInk).toEqual(fromPhoto);
  });
  test('and back: StaffInk -> IR -> StaffInk is stable', async () => {
    const { fromStaffInk } = await import('./adapters/staffink.js');
    const again = toStaffInk(fromStaffInk(si)).score;
    const sig = (s) => s.measures.map((m) => m.staves[0].events.map((e) => `${e.kind}${e.dur}${'.'.repeat(e.dots)}${e.heads.map((h) => h.pos + ':' + h.acc).join(',')}${e.tie ? '~' : ''}`).join(' ')).join(' | ');
    expect(sig(again)).toBe(sig(si));
  });
});

describe('IR -> StaffInk, edge cases', async () => {
  const { createScore, addEvent, addDirection, addVoice } = await import('./ir.js');
  test('bar-crossing notes become ties; triplets stay triplets; a quintuplet is reported', () => {
    const s = createScore();
    addDirection(s, 'meter', 0, { beats: 2, unit: 4 });
    let t = r(0);
    const add = (d, dur) => { const e = addEvent(s, { onset: t, dur, heads: [{ d }] }); t = radd(t, e.dur); return e; };
    add(28, '3/8'); add(29, '3/8'); add(30, '1/12'); add(31, '1/12'); add(32, '1/12');
    for (let k = 0; k < 5; k++) add(33, '1/20');
    const { score, report } = toStaffInk(s);
    const evs = score.measures.flatMap((m) => m.staves[0].events);
    expect(evs.slice(0, 3).map((e) => [e.dur, e.dots, !!e.tie])).toEqual([[4, 1, false], [8, 0, true], [4, 0, false]]);
    const trip = evs.filter((e) => e.tuplet);
    expect(trip.length).toBe(3); expect(new Set(trip.map((e) => e.tuplet.id)).size).toBe(1); expect(trip[0].tuplet).toMatchObject({ n: 3, m: 2 });
    expect(report.approximated.length).toBe(5);
  });
  test('a second voice is reported, not merged into the first', () => {
    const s = createScore();
    const v2 = addVoice(s, { staff: s.parts[0].staves[0].id });
    addEvent(s, { onset: 0, dur: '1/2', heads: [{ d: 35 }] });
    addEvent(s, { voice: v2.id, onset: 0, dur: '1/2', heads: [{ d: 28 }] });
    const r = toStaffInk(s);
    expect(r.score.measures[0].staves[0].events.map((e) => [e.kind, e.dur, e.heads.map((h) => h.pos)])).toEqual([['note', 2, [5]]]); // an unfinished bar stays unfinished
    expect(r.report.meter).toEqual([4, 4]);
    expect(r.report.dropped).toEqual([{ voice: v2.id, events: 1 }]);
  });
});


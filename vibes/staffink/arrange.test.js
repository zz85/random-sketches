// bun test — range selection and arrangements (markers) on a StaffInk score.
import { test, expect, describe } from 'bun:test';
import { newScore } from './theory.js';
import { timeline, rangeOf, stepFocus, addClip, addJump, removeMarker, pruneProgram, compile, markers, hasMarkers } from './arrange.js';
import { fromStaffInk } from '../notation-ir/adapters/staffink.js';
import { perform } from '../notation-ir/playback.js';
import { removeEvent } from './parser.js';

// grand staff, 4/4: treble C D E F | G A B C, bass a whole note per bar
function piece() {
  const s = newScore({ staves: [{ clef: 'G' }, { clef: 'F' }], time: [4, 4], tempo: 120 });
  let id = 1;
  const n = (pos, dur = 4) => ({ id: id++, kind: 'note', dur, dots: 0, heads: [{ pos, acc: null }] });
  s.measures[0].staves[0].events.push(n(-2), n(-1), n(0), n(1));
  s.measures[0].staves[1].events.push(n(2, 1));
  s.measures[1].staves[0].events.push(n(2), n(3), n(4), n(5));
  s.measures[1].staves[1].events.push(n(0, 1));
  return s; // ids: 1-4 treble bar 1, 5 bass bar 1, 6-9 treble bar 2, 10 bass bar 2
}
const play = (s, program) => perform(fromStaffInk(s), { tempo: 120, ...program }).notes.map((n) => n.midi);

describe('range selection, like text', () => {
  const s = piece();
  test('a range is every event between two, on every staff', () => {
    const r = rangeOf(s, 2, 3);
    expect([...r.ids].sort((a, b) => a - b)).toEqual([2, 3]); // the bass whole note started before
  });
  test('the anchor can be after the focus; first and last are by time', () => {
    const r = rangeOf(s, 7, 1);
    expect(r.first).toBe(1);
    expect(r.ids.has(5) && r.ids.has(10) && r.ids.has(7) && !r.ids.has(8)).toBe(true);
    expect(r.last).toBe(7); // the clip ends where the selection ends
  });
  test('shift+arrow steps the focus through time', () => {
    expect(stepFocus(s, 1, 1)).toBe(2);
    expect(stepFocus(s, 4, 1)).toBe(6);
    expect(stepFocus(s, 1, -1)).toBe(1);
  });
  test('playing a selection plays just it, on every staff, and can loop', () => {
    const r = rangeOf(s, 6, 7);
    expect(play(s, compile(s, { range: r }))).toEqual([43, 67, 69]); // the bass G2 starts with 6, cut off after 7
    const one = rangeOf(s, 2, 2);
    expect(play(s, compile(s, { range: one, loop: 3 }))).toEqual([62, 62, 62]);
  });
});

describe('arrangements', () => {
  test('clips in order, repeats, octaves and layers', () => {
    const s = piece();
    const a = addClip(s, rangeOf(s, 1, 2)), b = addClip(s, rangeOf(s, 9, 9));
    expect([a.name, b.name]).toEqual(['A', 'B']);
    s.program.mode = 'clips';
    a.loop = 2;
    // A (C D, with the bass B2 underneath) twice, then B
    expect(play(s, compile(s))).toEqual([47, 60, 62, 47, 60, 62, 72]);
    b.withPrev = true; b.transpose = -12; // B an octave down, together with A
    const p = perform(fromStaffInk(s), { tempo: 120, ...compile(s) });
    expect(new Set(p.notes.map((n) => n.cursor)).size).toBe(2);
    expect(p.notes.filter((n) => n.t === 0).map((n) => n.midi).sort()).toEqual([47, 60, 60]);
  });
  test('a delay in beats', () => {
    const s = piece();
    const a = addClip(s, rangeOf(s, 1, 1)), b = addClip(s, rangeOf(s, 1, 1));
    s.program.mode = 'clips'; b.withPrev = true; b.delay = 1; b.transpose = 12;
    const p = perform(fromStaffInk(s), { tempo: 120, ...compile(s) });
    expect(p.notes.map((n) => [n.midi, n.t])).toEqual([[47, 0], [60, 0], [59, 0.5], [72, 0.5]]); // both staves, the copy a beat later and an octave up
    void a;
  });
  test('score mode takes the jumps', () => {
    const s = piece();
    addJump(s, 4, 1); // after F back to C, once
    expect(play(s, compile(s)).filter((m) => m > 59)).toEqual([60, 62, 64, 65, 60, 62, 64, 65, 67, 69, 71, 72]);
  });
  test('markers follow edits; erasing a note removes its markers', () => {
    const s = piece();
    const a = addClip(s, rangeOf(s, 6, 7));
    s.measures[0].staves[0].events.splice(0, 1); // a note before the clip goes
    expect(play(s, compile(s, { range: rangeOf(s, a.from, a.to) }))).toEqual([43, 67, 69]);
    addJump(s, 9, 6);
    removeEvent(s, 6);
    expect(pruneProgram(s)).toEqual(['A', 'jump']);
    expect(hasMarkers(s.program)).toBe(false);
  });
  test('markers for drawing, and removing one', () => {
    const s = piece();
    const c = addClip(s, rangeOf(s, 1, 4)), j = addJump(s, 4, 1);
    const m = markers(s);
    expect(m.clips[0]).toMatchObject({ id: c.id, name: 'A', from: { event: 'si1' }, to: { event: 'si4', edge: 'end' } });
    expect(m.jumps[0]).toMatchObject({ id: j.id, name: 'J1', at: { event: 'si4', edge: 'end' }, to: { event: 'si1' } });
    expect(removeMarker(s, c.id)).toBe(true);
    expect(markers(s).clips).toEqual([]);
  });
  test('the timeline covers both staves in time order', () => {
    const tl = timeline(piece());
    expect(tl.slice(0, 3).map((q) => [q.id, q.onset])).toEqual([[1, 0], [5, 0], [2, 96]]);
  });
});

describe('reordering clips', async () => {
  const { moveClip } = await import('./arrange.js');
  test('moveClip on a score changes the playing order', () => {
    const s = piece();
    addClip(s, rangeOf(s, 1, 1)); const b = addClip(s, rangeOf(s, 9, 9));
    s.program.mode = 'clips';
    expect(moveClip(s, b.id, 0)).toBe(true);
    expect(play(s, compile(s))).toEqual([72, 47, 60]);
  });
});

describe('the engraved surface', async () => {
  const { engravedSurface } = await import('./surface.js');
  const { layoutScore } = await import('./layout.js');
  const { checkSurface, headMaps, selectionBands, placeAnchor } = await import('../notation-ir/surface.js');
  const s = piece(), L = layoutScore(s, { width: 60 });
  const surf = checkSurface(engravedSurface(L, () => ({ X: (x) => x, Y: (y) => y, sp: 1 })));
  const p = (id) => L.evPos.get(id);
  test('places events where the layout drew them; StaffInk and IR ids both work', () => {
    expect(surf.lines().length).toBe(L.systems.length);
    expect(surf.place(2, 'start')).toEqual([{ line: p(2).sys, x: p(2).bbox.x0 - 0.25 }]);
    expect(surf.place('si2', 'end')).toEqual(surf.place(2, 'end'));
    expect(surf.place(999)).toEqual([]);
    expect(placeAnchor(surf, { event: 'si3', edge: 'end' }).x).toBe(p(3).bbox.x1 + 0.35);
  });
  test('the event under a point, and the bar under it', () => {
    const q = p(7);
    expect(surf.eventAt({ x: (q.bbox.x0 + q.bbox.x1) / 2, y: q.top + 2 })).toBe(7);
    const bar = surf.barAt({ x: (q.bbox.x0 + q.bbox.x1) / 2, y: q.top + 2 });
    expect([...rangeOf(s, bar.first, bar.last).ids].sort((a, b) => a - b)).toEqual([6, 7, 8, 9, 10]); // the whole bar, both staves
  });
  test('playheads run to the barline of each bar; selection bands span both staves of the system', () => {
    const W = 384, items = timeline(s).map((q) => ({ id: q.id, t: q.onset / W, end: q.end / W }));
    const m = headMaps(surf, items);
    expect(m(0)[0].x).toBeCloseTo((p(1).hw ? p(1).x + p(1).hw / 2 : (p(1).bbox.x0 + p(1).bbox.x1) / 2));
    const m0 = L.measures[0];
    expect(m(0.999)[0].x).toBeGreaterThan(p(4).x); // the last beat of bar 1 glides on towards its barline
    expect(m(0.999)[0].x).toBeLessThanOrEqual(m0.x1);
    const b = selectionBands(surf, [1, 5]);
    expect(b.length).toBe(1);
    expect(b[0].x0).toBeCloseTo(Math.min(p(1).bbox.x0, p(5).bbox.x0) - 0.25);
  });
});

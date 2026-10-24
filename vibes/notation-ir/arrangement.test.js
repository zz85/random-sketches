// bun test — shared arrangements (clips, jumps, ranges) and metronome clicks for programs.
import { test, expect, describe } from 'bun:test';
import { createScore, addEvent, addDirection, addVoice } from './ir.js';
import { emptyArrangement, addClip, addJump, removeMarker, markerById, compileArrangement, arrangementMarkers, rangeOfIR, hasMarkers } from './arrangement.js';
import { perform, clicksFor } from './playback.js';
import { r } from './rational.js';

// 3/4: two bars of quarters C D E | F G A, a bass voice with a dotted half per bar
function piece() {
  const s = createScore();
  addDirection(s, 'meter', 0, { beats: 3, unit: 4 });
  const v2 = addVoice(s, { staff: s.parts[0].staves[0].id });
  const top = [28, 29, 30, 31, 32, 33].map((d, i) => addEvent(s, { id: `t${i}`, onset: r(i, 4), dur: '1/4', heads: [{ d, alter: 0 }] }));
  const low = [21, 22].map((d, i) => addEvent(s, { id: `b${i}`, voice: v2.id, onset: r(3 * i, 4), dur: '3/4', heads: [{ d, alter: 0 }] }));
  return { s, top, low };
}
const midis = (s, prog) => perform(s, { tempo: 120, ...prog }).notes.map((n) => n.midi);

describe('ranges over the IR', () => {
  const { s } = piece();
  test('like text: every voice in the stretch, ends by time whatever the order', () => {
    const R = rangeOfIR(s, 't4', 't1');
    expect([...R.ids].sort()).toEqual(['b1', 't1', 't2', 't3', 't4']);
    expect([R.first, R.last]).toEqual(['t1', 't4']);
    expect(R.n).toBe(5);
    expect(rangeOfIR(s, 'nope', 't1')).toBe(null);
  });
  test('a range plays just itself, cut off at its end, and loops', () => {
    expect(midis(s, compileArrangement(null, { range: rangeOfIR(s, 't3', 't4') }))).toEqual([50, 65, 67]);
    expect(midis(s, compileArrangement(null, { range: rangeOfIR(s, 't0', 't0'), loop: 3 }))).toEqual([48, 60, 48, 60, 48, 60]);
  });
});

describe('arrangements', () => {
  test('clips, layers, jumps; markers for drawing', () => {
    const { s } = piece(), a = emptyArrangement();
    const A = addClip(a, rangeOfIR(s, 't0', 't2')), B = addClip(a, rangeOfIR(s, 't5', 't5'));
    expect([A.name, B.name, hasMarkers(a)]).toEqual(['A', 'B', true]);
    a.mode = 'clips'; B.loop = 2;
    expect(midis(s, compileArrangement(a))).toEqual([48, 60, 62, 64, 69, 69]);
    B.withPrev = true; B.transpose = -12; B.delay = 1;
    const p = perform(s, { tempo: 120, ...compileArrangement(a, { beat: 4 }) });
    expect(new Set(p.notes.map((n) => n.cursor)).size).toBe(2);
    expect(p.notes.filter((n) => n.midi === 57).map((n) => n.t)).toEqual([0.5, 1]);
    a.mode = 'score';
    addJump(a, 't5', 't3');
    expect(midis(s, compileArrangement(a)).filter((m) => m > 59)).toEqual([60, 62, 64, 65, 67, 69, 65, 67, 69]);
    const m = arrangementMarkers(a);
    expect(m.clips.map((c) => c.name)).toEqual(['A', 'B']);
    expect(m.jumps[0]).toMatchObject({ name: 'J1', at: { event: 't5', edge: 'end' }, to: { event: 't3' } });
    expect(markerById(a, A.id)).toBe(A);
    expect(removeMarker(a, A.id)).toBe(true);
    expect(a.clips.map((c) => c.name)).toEqual(['B']);
    expect(addClip(a, rangeOfIR(s, 't0', 't0')).name).toBe('A'); // the first free letter
  });
  test('idOf maps app ids to IR ids', () => {
    const a = emptyArrangement(); addClip(a, { first: 3, last: 4 });
    expect(compileArrangement({ ...a, mode: 'clips' }, { idOf: (x) => `si${x}` }).root.seq[0].play.from).toEqual({ event: 'si3' });
  });
});

describe('metronome clicks for programs', () => {
  const { s } = piece();
  test('the beats of the bars actually played, accented on the downbeat, every pass', () => {
    const p = perform(s, { tempo: 120, ...compileArrangement(null, { range: rangeOfIR(s, 't3', 't5'), loop: 2 }) });
    const c = clicksFor(s, p);
    expect(c.map((x) => [x.t, x.accent])).toEqual([[0, true], [0.5, false], [1, false], [1.5, true], [2, false], [2.5, false]]);
  });
  test('a passage starting mid-bar clicks from where it starts; layers do not double', () => {
    const p = perform(s, { tempo: 120, root: { par: [{ play: { from: { event: 't1' }, to: { event: 't2', edge: 'end' } } }, { play: { from: { event: 't1' }, to: { event: 't2', edge: 'end' } }, transpose: 12 }] } });
    expect(clicksFor(s, p).map((x) => [x.t, x.accent])).toEqual([[0, false], [0.5, false]]);
  });
});

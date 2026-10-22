// bun test — content, interpretation and layout of the timeline IR.
import { test, expect, describe } from 'bun:test';
import { r, add, eq, str, parse } from './rational.js';
import { createScore, addEvent, addDirection, addLink, addVoice, check } from './ir.js';
import { interpret, toText, notateDuration, meterTree } from './interpret.js';
import { layoutLine, fitWithGaps } from './layout.js';
import { parseName } from './pitch.js';
import { fromStaffInk } from './adapters/staffink.js';
import { newScore } from '../staffink/theory.js';

/** Sequential notes: [["C4", "1/4"], ["r", "1/4"], ["F#4", "1/2"]] -> events in voice v1. */
function line(score, notes, { voice, start = '0', known = false } = {}) {
  let t = parse(start);
  return notes.map(([n, d, extra = {}]) => {
    const heads = n === 'r' ? [] : n.split(' ').map((s) => { const p = parseName(s); return known ? { d: p.d, alter: p.alter ?? 0 } : { d: p.d, acc: p.alter ?? null }; });
    const e = addEvent(score, { voice, onset: t, dur: d, heads, ...extra });
    t = add(t, e.dur);
    return e;
  });
}

describe('rational time', () => {
  test('triplets sum exactly', () => {
    const third = r(1, 12);
    expect(eq(add(add(third, third), third), r(1, 4))).toBe(true);
    expect(str(r(6, 8))).toBe('3/4');
  });
});

describe('bars are derived, not containers', () => {
  const s = createScore();
  line(s, [['C4', '1/4'], ['D4', '1/2'], ['E4', '1/4'], ['F4', '1/2']]);

  test('no meter: free time, no bars, no splitting', () => {
    expect(toText(interpret(s, { meter: 'none' }), 'v1')).toBe('C4q D4h E4q F4h');
  });
  test('the same content in 2/4: bars, bar-crossing tie', () => {
    const res = interpret(s, { meter: [{ beats: 2, unit: 4 }] });
    expect(toText(res, 'v1')).toBe('| C4q D4q~ | D4q E4q | F4h |');
    expect(res.measures.map((m) => m.status)).toEqual(['ok', 'ok', 'ok']);
  });
  test('in 3/4 the last bar is reported short, not padded', () => {
    const res = interpret(s, { meter: [{ beats: 3, unit: 4 }] });
    expect(toText(res, 'v1')).toBe('| C4q D4h | E4q F4h |');
    const t = interpret(s, { meter: [{ beats: 4, unit: 4 }] });
    expect(toText(t, 'v1')).toBe('| C4q D4h E4q | F4h |');
    expect(t.measures.map((m) => m.status)).toEqual(['ok', 'end']);
  });
  test('pickup', () => {
    const res = interpret(s, { meter: [{ beats: 3, unit: 4 }], pickup: '1/4' });
    expect(toText(res, 'v1')).toBe('| C4q | D4h E4q | F4h |');
    expect(res.measures[0].status).toBe('pickup');
  });
  test('a printed barline wins and re-phases the meter; odd bars are reported', () => {
    const p = createScore();
    line(p, [['C4', '1/4'], ['D4', '1/4'], ['E4', '1/4'], ['F4', '1/4'], ['G4', '1/4'], ['A4', '1/4']]);
    addDirection(p, 'meter', 0, { beats: 3, unit: 4 });
    addDirection(p, 'barline', '1/2');
    const res = interpret(p);
    expect(toText(res, 'v1')).toBe('| C4q D4q | E4q F4q G4q | A4q |');
    expect(res.bars.map((b) => b.kind)).toEqual(['explicit', 'derived', 'final']);
    expect(res.measures.map((m) => m.status)).toEqual(['pickup', 'ok', 'end']);
    expect(toText(interpret(p, { bars: 'derived' }), 'v1')).toBe('| C4q D4q E4q | F4q G4q A4q |');
  });
  test('meter change mid-piece forces a bar there', () => {
    const p = createScore();
    line(p, [['C4', '1/2'], ['D4', '3/8'], ['E4', '3/8']]);
    addDirection(p, 'meter', 0, { beats: 2, unit: 4 });
    addDirection(p, 'meter', '1/2', { beats: 6, unit: 8 });
    expect(toText(interpret(p), 'v1')).toBe('| C4h | D4q. E4q. |');
  });
});

describe('gaps, rests and space', () => {
  const s = createScore();
  addEvent(s, { onset: 0, dur: '1/4', heads: [{ d: 28 }] });
  addEvent(s, { onset: '1/2', dur: '1/4', heads: [{ d: 29 }] });
  test('a gap becomes a rest or is left as paper', () => {
    expect(toText(interpret(s, { meter: 'none' }), 'v1')).toBe('C4q rq D4q');
    expect(toText(interpret(s, { meter: 'none', fillGaps: 'space' }), 'v1')).toBe('C4q _q D4q');
    expect(check(s)).toEqual([{ kind: 'gap', voice: 'v1', from: r(1, 4), to: r(1, 2) }]);
  });
  test('empty bars get a whole-bar rest; a part-filled bar gets rests to its end', () => {
    const res = interpret(s, { meter: [{ beats: 3, unit: 8 }], end: '9/8' });
    expect(toText(res, 'v1')).toBe('| C4q re | re D4q | R |');
  });
  test('overlaps inside a voice are reported, not fixed', () => {
    const o = createScore();
    addEvent(o, { onset: 0, dur: '1/2', heads: [{ d: 28 }] });
    addEvent(o, { onset: '1/4', dur: '1/4', heads: [{ d: 30 }] });
    expect(interpret(o, { meter: 'none' }).diagnostics.map((d) => d.kind)).toEqual(['overlap']);
  });
});

describe('durations and tuplets come from the numbers', () => {
  test('dotted, tied, and tuplet values', () => {
    const w = (d) => notateDuration(r(...d)).map((v) => `${v.type}${'.'.repeat(v.dots)}${v.tuplet ? '/' + v.tuplet[0] : ''}`).join('+');
    expect(w([3, 8])).toBe('4.');
    expect(w([5, 8])).toBe('2+8');
    expect(w([1, 12])).toBe('8/3');
    expect(w([1, 20])).toBe('16/5');
    expect(w([1, 6])).toBe('4/3');
  });
  test('triplets are bracketed in groups that add up to a beat', () => {
    const s = createScore();
    line(s, [['C4', '1/12'], ['D4', '1/12'], ['E4', '1/12'], ['F4', '1/12'], ['G4', '1/6'], ['A4', '1/2']]);
    const res = interpret(s, { meter: [{ beats: 4, unit: 4 }] });
    expect(toText(res, 'v1')).toBe('| C4e/3 D4e/3 E4e/3 F4e/3 G4q/3 A4h |');
    expect(res.voices.get('v1').map((p) => p.tupletGroup ?? '-')).toEqual(['t1', 't1', 't1', 't2', 't2', '-']);
  });
  test('quintuplet sixteenths', () => {
    const s = createScore();
    line(s, Array.from({ length: 5 }, () => ['C5', '1/20']));
    expect(toText(interpret(s, { meter: 'none' }), 'v1')).toBe('C5s/5 C5s/5 C5s/5 C5s/5 C5s/5');
  });
});

describe('accidental scope is a rule you choose', () => {
  // ink / OMR style: F# written, then F with no accidental later
  const s = createScore();
  line(s, [['F#4', '1/4'], ['F4', '1/4'], ['G4', '1/2'], ['F4', '1/4']]);
  const midis = (res) => res.voices.get('v1').filter((p) => p.kind === 'note').map((p) => p.heads[0].midi);

  test('bar scope: carries to the barline', () => {
    const res = interpret(s, { meter: [{ beats: 4, unit: 4 }] });
    expect(midis(res)).toEqual([66, 66, 67, 65]);
    expect(toText(res, 'v1')).toBe('| F#4q F4q G4h | F4q |');
  });
  test('free time: bar scope never ends, a window does', () => {
    expect(midis(interpret(s, { meter: 'none' }))).toEqual([66, 66, 67, 66]);
    expect(midis(interpret(s, { meter: 'none', accidentals: { window: '1/2' } }))).toEqual([66, 66, 67, 65]);
    expect(midis(interpret(s, { meter: 'none', accidentals: 'note' }))).toEqual([66, 65, 67, 65]);
  });
  test('known pitches get the accidentals they need', () => {
    const k = createScore();
    line(k, [['F#4', '1/4'], ['F4', '1/4'], ['Bb4', '1/4'], ['B4', '1/4']], { known: true });
    addDirection(k, 'key', 0, { fifths: -1 });
    expect(toText(interpret(k, { meter: [{ beats: 4, unit: 4 }] }), 'v1')).toBe('| F#4q Fn4q B4q Bn4q |');
  });
  test('a note split across a bar keeps its pitch and drops the accidental', () => {
    const k = createScore();
    line(k, [['C4', '1/2'], ['D4', '1/4'], ['F#4', '1/2']]);
    const res = interpret(k, { meter: [{ beats: 4, unit: 4 }] });
    expect(toText(res, 'v1')).toBe('| C4h D4q F#4q~ | F4q |');
    expect(midis(res)).toEqual([60, 62, 66, 66]);
  });
  test('tie links carry pitch to the next event', () => {
    const k = createScore();
    const [a, b] = line(k, [['F#4', '1/4'], ['F4', '1/4']]);
    addLink(k, 'tie', [a.id, b.id]);
    const res = interpret(k, { meter: [{ beats: 2, unit: 4 }], accidentals: 'note' });
    expect(midis(res)).toEqual([66, 66]);
    expect(toText(res, 'v1')).toBe('| F#4q~ F4q |');
  });
});

describe('alternative readings', () => {
  test('most confident wins, picks override', () => {
    const s = createScore();
    addEvent(s, { onset: 0, dur: '1/4', heads: [{ d: 28 }], alt: { group: 'g1', option: 'a', conf: 0.4 } });
    addEvent(s, { onset: 0, dur: '1/4', heads: [{ d: 29 }], alt: { group: 'g1', option: 'b', conf: 0.7 } });
    addEvent(s, { onset: 0, dur: '1/8', heads: [{ d: 28 }], alt: { group: 'g1', option: 'c', conf: 0.2 } });
    addEvent(s, { onset: '1/4', dur: '1/4', heads: [{ d: 30 }] });
    expect(toText(interpret(s, { meter: 'none' }), 'v1')).toBe('D4q E4q');
    expect(toText(interpret(s, { meter: 'none', picks: { g1: 'a' } }), 'v1')).toBe('C4q E4q');
    expect(toText(interpret(s, { meter: 'none', picks: { g1: 'c' } }), 'v1')).toBe('C4e re E4q');
  });
});

describe('voices and chords', () => {
  test('two voices on one staff share accidentals; chords', () => {
    const s = createScore();
    const v2 = addVoice(s, { staff: s.parts[0].staves[0].id });
    line(s, [['C5 E5', '1/2'], ['F5', '1/2']]);
    line(s, [['F#4', '1/2'], ['F4', '1/2']], { voice: v2.id });
    const res = interpret(s, { meter: [{ beats: 4, unit: 4 }] });
    expect(toText(res, v2.id)).toBe('| F#4h F4h |');
    expect(res.voices.get(v2.id)[1].heads[0].midi).toBe(66);
    expect(toText(res, 'v1').startsWith('| <C5 E5>h F5h')).toBe(true);
  });
});

describe('layout', () => {
  test('gap-constrained fit is exact and never collides', () => {
    expect(fitWithGaps([0, 5, 10], [1, 1, 1], [2, 2, 0])).toEqual([0, 5, 10]);
    const x = fitWithGaps([0, 0.5, 1], [1, 1, 1], [2, 2, 0]); // wants to bunch, gaps force 2 apart
    expect(x[1] - x[0]).toBeCloseTo(2); expect(x[2] - x[1]).toBeCloseTo(2);
    expect((x[0] + x[1] + x[2]) / 3).toBeCloseTo(0.5); // centred on the targets
  });

  const s = createScore();
  line(s, [['C4', '1/4', { src: { x: 10 } }], ['D4', '1/4', { src: { x: 13 } }], ['E4', '1/2', { src: { x: 30 } }], ['F4', '1/4', { src: { x: 31 } }]]);
  const res = interpret(s, { meter: 'none' });

  test('engraved spacing grows with duration', () => {
    const L = layoutLine(res, s);
    const x = L.columns.map((c) => c.x);
    expect(x[1] - x[0]).toBeCloseTo(x[2] - x[1]);
    expect(x[3] - x[2]).toBeGreaterThan(x[2] - x[1]);
  });
  test('proportional: x is time', () => {
    const L = layoutLine(res, s, { mode: 'proportional', unit: 40 });
    [0, 10, 20, 40].forEach((v, i) => expect(L.columns[i].x).toBeCloseTo(v));
  });
  test('anchored: follows the ink, pushes apart only what would collide', () => {
    const L = layoutLine(res, s, { mode: 'anchored' });
    const x = L.columns.map((c) => c.x);
    expect(x[0]).toBeCloseTo(10); expect(x[1]).toBeCloseTo(13);
    expect(x[3] - x[2]).toBeGreaterThanOrEqual(1.3 - 1e-9);
    expect((x[2] + x[3]) / 2).toBeCloseTo(30.5);
  });
  test('anchored with derived bars: bars slot between anchored notes', () => {
    const b = interpret(s, { meter: [{ beats: 2, unit: 4 }] });
    const L = layoutLine(b, s, { mode: 'anchored' });
    const bar = L.columns.find((c) => c.kind === 'bar');
    const [d4, e4] = L.columns.filter((c) => c.kind === 'events').slice(1, 3);
    expect(bar.x).toBeGreaterThan(d4.x); expect(bar.x).toBeLessThan(e4.x);
  });
});

describe('StaffInk adapter', () => {
  const si = newScore({ time: [4, 4] });
  let id = 1;
  const note = (pos, dur, extra = {}) => ({ id: id++, kind: 'note', dur, dots: 0, heads: [{ pos, acc: null }], ...extra });
  si.measures[0].staves[0].events.push(note(-2, 4), note(-1, 4, { tie: true }), note(-1, 4)); // C4 D4~D4, bar 3/4 written
  si.measures[1].staves[0].events.push({ id: id++, kind: 'rest', dur: 1, dots: 0, full: true, heads: [] });
  si.measures.push({ attrs: {}, staves: [{ events: [note(0, 2, { heads: [{ pos: 0, acc: 1 }] })] }] }); // E#4 half

  const ir = fromStaffInk(si);
  test('half-written bars become gaps on the timeline', () => {
    expect(check(ir).map((d) => d.kind)).toEqual(['gap']);
    expect(toText(interpret(ir), 'v1')).toBe('| C4q D4q~ D4q rq | R | E#4h |');
  });
  test('the same ink without its meter, or as paper still being written', () => {
    expect(toText(interpret(ir, { meter: 'none', fillGaps: 'space' }), 'v1')).toBe('C4q D4q~ D4q _q rw E#4h');
    expect(toText(interpret(ir, { meter: [{ beats: 3, unit: 4 }] }), 'v1')).toBe('| C4q D4q~ D4q | R | rq rq E#4q~ | E4q |');
  });
});

describe('beat-aware values', () => {
  const play = (meter, notes, opts = {}) => {
    const s = createScore();
    line(s, notes);
    return toText(interpret(s, { meter: [meter], ...opts }), 'v1');
  };
  const q = (n, d) => [n, d];
  test('4/4: the middle of the bar stays visible; q h q is accepted', () => {
    expect(play({ beats: 4, unit: 4 }, [q('C4', '1/4'), q('D4', '1/2'), q('E4', '1/4')])).toBe('| C4q D4h E4q |');
    expect(play({ beats: 4, unit: 4 }, [q('C4', '1/4'), q('D4', '3/4')])).toBe('| C4q D4q~ D4h |');
    expect(play({ beats: 4, unit: 4 }, [q('C4', '1/4'), q('D4', '3/8'), q('E4', '3/8')])).toBe('| C4q D4q~ D4e E4e~ E4q |');
    expect(play({ beats: 4, unit: 4 }, [q('C4', '3/4'), q('D4', '1/4')])).toBe('| C4h. D4q |');
    expect(play({ beats: 4, unit: 4 }, [q('C4', '5/8'), q('D4', '3/8')])).toBe('| C4h~ C4e D4e~ D4q |');
  });
  test('syncopation: e q e inside a half bar, tied across the middle', () => {
    expect(play({ beats: 4, unit: 4 }, [q('C4', '1/8'), q('D4', '1/4'), q('E4', '1/8'), q('F4', '1/2')])).toBe('| C4e D4q E4e F4h |');
    expect(play({ beats: 4, unit: 4 }, [q('C4', '1/4'), q('C4', '1/8'), q('D4', '1/4'), q('E4', '1/8'), q('F4', '1/4')])).toBe('| C4q C4e D4e~ D4e E4e F4q |');
    expect(play({ beats: 4, unit: 4 }, [q('C4', '1/8'), q('D4', '1/4'), q('E4', '1/8'), q('F4', '1/2')], { syncopation: false })).toBe('| C4e D4e~ D4e E4e F4h |');
    expect(play({ beats: 2, unit: 4 }, [q('C4', '1/16'), q('D4', '1/8'), q('E4', '1/16'), q('F4', '1/4')])).toBe('| C4s D4e E4s F4q |');
  });
  test('3/4: a half or dotted quarter on beat 2 is fine', () => {
    expect(play({ beats: 3, unit: 4 }, [q('C4', '1/4'), q('D4', '1/2')])).toBe('| C4q D4h |');
    expect(play({ beats: 3, unit: 4 }, [q('C4', '1/4'), q('D4', '3/8'), q('E4', '1/8')])).toBe('| C4q D4q. E4e |');
  });
  test('6/8: two dotted-quarter beats, never hidden', () => {
    expect(play({ beats: 6, unit: 8 }, [q('C4', '1/4'), q('D4', '1/4'), q('E4', '1/4')])).toBe('| C4q D4e~ D4e E4q |');
    expect(play({ beats: 6, unit: 8 }, [q('C4', '1/2'), q('D4', '1/4')])).toBe('| C4q.~ C4e D4q |');
    expect(play({ beats: 6, unit: 8 }, [q('C4', '3/8'), q('D4', '3/8')])).toBe('| C4q. D4q. |');
    expect(play({ beats: 6, unit: 8 }, [q('C4', '3/4')])).toBe('| C4h. |');
  });
  test('additive 7/8 as 2 + 2 + 3', () => {
    expect(play({ beats: 7, unit: 8, groups: [2, 2, 3] }, [q('C4', '1/8'), q('D4', '1/4'), q('E4', '1/8'), q('F4', '3/8')])).toBe('| C4e D4e~ D4e E4e F4q. |');
  });
  test('rests take exact beats only', () => {
    const s = createScore();
    addEvent(s, { onset: '1/4', dur: '1/4', heads: [{ d: 28 }] });
    addEvent(s, { onset: '7/8', dur: '1/8', heads: [{ d: 29 }] });
    expect(toText(interpret(s, { meter: [{ beats: 4, unit: 4 }] }), 'v1')).toBe('| rq C4q rq re D4e |');
    const t = createScore();
    addEvent(t, { onset: '1/8', dur: '1/8', heads: [{ d: 28 }] });
    expect(toText(interpret(t, { meter: [{ beats: 4, unit: 4 }], end: '1' }), 'v1')).toBe('| re C4e rq rh |');
  });
  test('a pickup is the end of a bar; written values win; free time stays greedy', () => {
    expect(play({ beats: 4, unit: 4 }, [q('C4', '1/8'), q('D4', '1/4'), q('E4', '1/2')], { pickup: '3/8' })).toBe('| C4e D4q | E4h |');
    const s = createScore();
    addEvent(s, { onset: '1/4', dur: '3/4', heads: [{ d: 28 }], written: { type: 2, dots: 1 } });
    expect(toText(interpret(s, { meter: [{ beats: 4, unit: 4 }] }), 'v1')).toBe('| rq C4h. |');
    expect(toText(interpret(s, { meter: [{ beats: 4, unit: 4 }], written: false }), 'v1')).toBe('| rq C4q~ C4h |');
    expect(toText(interpret(s, { meter: [{ beats: 4, unit: 4 }], beats: false, written: false }), 'v1')).toBe('| rq C4h. |');
  });
  test('the beat tree', () => {
    const lens = (n) => n.kids().map((k) => str(k.len));
    expect(lens(meterTree({ beats: 4, unit: 4 }))).toEqual(['1/2', '1/2']);
    expect(lens(meterTree({ beats: 12, unit: 8 }))).toEqual(['3/4', '3/4']);
    expect(lens(meterTree({ beats: 12, unit: 8 }).kids()[0])).toEqual(['3/8', '3/8']);
    expect(lens(meterTree({ beats: 3, unit: 4 }))).toEqual(['1/4', '1/4', '1/4']);
    expect(lens(meterTree({ beats: 5, unit: 4 }))).toEqual(['3/4', '1/2']);
  });
});

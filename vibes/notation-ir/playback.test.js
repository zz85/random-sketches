// bun test — anchors and authored non-linear playback.
import { test, expect, describe } from 'bun:test';
import { r } from './rational.js';
import { createScore, addEvent, addDirection, addFragment, addLink } from './ir.js';
import { resolveAnchor, timeAtPos, positionAt } from './anchors.js';
import { perform, playheadsAt } from './playback.js';
import { interpret } from './interpret.js';
import { fromStaffInk } from './adapters/staffink.js';
import { newScore } from '../staffink/theory.js';

// main: 8 quarters C4..C5 in 2/4 on two lines of a page (4 per line), a printed barline
// after bar 1. idea: a two-note phrase sketched off to the side, its own time.
function page() {
  const s = createScore();
  addDirection(s, 'meter', 0, { beats: 2, unit: 4 });
  const ev = Array.from({ length: 8 }, (_, i) => addEvent(s, {
    onset: r(i, 4), dur: '1/4', heads: [{ d: 28 + i }], src: { x: 10 + 5 * (i % 4), line: i < 4 ? 0 : 1 },
  }));
  const bl = addDirection(s, 'barline', '1/2', {}, { src: { x: 18.5, line: 0 } });
  addFragment(s, { id: 'idea', src: { x: 60, y: 40 } });
  const idea = [addEvent(s, { fragment: 'idea', onset: 0, dur: '1/8', heads: [{ d: 39 }] }), addEvent(s, { fragment: 'idea', onset: '1/8', dur: '1/8', heads: [{ d: 40 }] })];
  return { s, ev, bl, idea };
}
const midis = (p) => p.notes.map((n) => n.midi);
const times = (p) => p.notes.map((n) => +n.t.toFixed(3));

describe('anchors', () => {
  const { s, ev, bl } = page();
  const io = (f) => interpret(s, { fragment: f });
  test('bars, events, printed barlines, fragment ends', () => {
    expect(resolveAnchor(s, { bar: 3 }, io).t).toEqual(r(1));
    expect(resolveAnchor(s, { bar: 3, edge: 'end' }, io).t).toEqual(r(3, 2));
    expect(resolveAnchor(s, { event: ev[5].id, edge: 'end' }, io).t).toEqual(r(3, 2));
    expect(resolveAnchor(s, { barline: bl.id }, io).t).toEqual(r(1, 2));
    expect(resolveAnchor(s, { fragment: 'idea', edge: 'end' }, io)).toEqual({ fragment: 'idea', t: r(1, 4) });
  });
  test('page position <-> score time, per line', () => {
    expect(timeAtPos(s, 'main', { x: 25, line: 0 })).toEqual(r(3, 4));
    expect(timeAtPos(s, 'main', { x: 22.5, line: 0 })).toEqual(r(5, 8));
    expect(timeAtPos(s, 'main', { x: 20, line: 1 })).toEqual(r(3, 2));
    expect(positionAt(s, 'main', r(5, 8))).toEqual({ x: 22.5, line: 0 });
    expect(positionAt(s, 'main', r(5, 4))).toEqual({ x: 15, line: 1 });
  });
  test('an anchor on a note follows the note when the music is edited', () => {
    const t = createScore();
    const [, b, c] = [0, 1, 2].map((i) => addEvent(t, { onset: r(i, 4), dur: '1/4', heads: [{ d: 30 + i }] }));
    const prog = { tempo: 120, root: { play: { from: { event: b.id }, to: { event: c.id, edge: 'end' } } } };
    expect(midis(perform(t, prog))).toEqual([65, 67]);
    for (const e of [b, c]) e.onset = r(e.onset.n * 2 + 1, 8); // something was inserted before them
    const p = perform(t, prog);
    expect(midis(p)).toEqual([65, 67]);
    expect(p.notes[0].at).toEqual(b.onset);
  });
});

describe('clips', () => {
  const { s, ev, bl } = page();
  test('a span between bars plays from its own start', () => {
    const p = perform(s, { tempo: 120, root: { play: { from: { bar: 2 }, to: { bar: 3, edge: 'end' } } } });
    expect(midis(p)).toEqual([64, 65, 67, 69]);
    expect(times(p)).toEqual([0, 0.5, 1, 1.5]);
    expect(p.duration).toBe(2);
  });
  test('from a printed barline, and between two points on the page', () => {
    expect(midis(perform(s, { root: { play: { from: { barline: bl.id }, to: { bar: 2, edge: 'end' } } } }))).toEqual([64, 65]);
    expect(midis(perform(s, { root: { play: { from: { pos: { x: 22.5, line: 0 } }, to: { pos: { x: 20, line: 1 } } } } }))).toEqual([65, 67, 69]);
  });
  test('a lasso of objects', () => {
    const p = perform(s, { tempo: 120, root: { play: { events: [ev[1].id, ev[4].id] } } });
    expect(midis(p)).toEqual([62, 67]);
    expect(times(p)).toEqual([0, 1.5]); // keeps the silence between them...
    expect(times(perform(s, { tempo: 120, root: { play: { events: [ev[1].id, ev[4].id] }, gaps: 'compress' } }))).toEqual([0, 0.5]); // ...unless told not to
  });
});

describe('jumps', () => {
  const { s } = page();
  test('a repeat: back from the end of bar 2 to bar 1, once', () => {
    const p = perform(s, { tempo: 120, jumps: [{ at: { bar: 2, edge: 'end' }, to: { bar: 1 } }], root: { walk: {} } });
    expect(midis(p)).toEqual([60, 62, 64, 65, 60, 62, 64, 65, 67, 69, 71, 72]);
    expect(p.duration).toBe(6);
    expect(p.trace.map((t) => [t.s0, t.s1].map((x) => x.n / x.d))).toEqual([[0, 1], [0, 2]]);
  });
  test('out to a sketched fragment and back', () => {
    const p = perform(s, {
      tempo: 120,
      jumps: [{ at: { bar: 1, edge: 'end' }, to: { fragment: 'idea', edge: 'start' } }, { at: { fragment: 'idea', edge: 'end' }, to: { bar: 3 } }],
      root: { walk: { to: { bar: 4, edge: 'end' } } },
    });
    expect(midis(p)).toEqual([60, 62, 79, 81, 67, 69, 71, 72]);
    expect(times(p)).toEqual([0, 0.5, 1, 1.25, 1.5, 2, 2.5, 3]);
    expect(p.notes.map((n) => n.fragment)).toEqual(['main', 'main', 'idea', 'idea', 'main', 'main', 'main', 'main']);
  });
  test('a jump taken twice, then read on', () => {
    const p = perform(s, { jumps: [{ at: { bar: 1, edge: 'end' }, to: { bar: 1 }, times: 2 }], root: { walk: { to: { bar: 2, edge: 'end' } } } });
    expect(midis(p)).toEqual([60, 62, 60, 62, 60, 62, 64, 65]);
  });
});

describe('several selections at once', () => {
  const { s } = page();
  test('a canon: the same clip again, delayed and an octave up, on its own cursor', () => {
    const all = { from: { edge: 'start' } };
    const p = perform(s, { tempo: 120, root: { par: [{ play: all }, { play: all, delay: '1/2', transpose: 12 }] } });
    expect(p.notes.length).toBe(16);
    expect(p.notes.filter((n) => n.cursor === '0.1').map((n) => n.t)).toEqual([1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]);
    expect(p.duration).toBe(5);
    const heads = playheadsAt(s, p, 1.25);
    expect(heads.map((h) => [h.cursor, h.at])).toEqual([['0.0', 0.625], ['0.1', 0.125]]);
    expect(heads[0].pos).toEqual({ x: 22.5, line: 0 });
  });
  test('loops in parallel with different lengths drift (phasing)', () => {
    const p = perform(s, { tempo: 120, root: { par: [
      { loop: 3, body: { play: { from: { bar: 1 }, to: { bar: 1, edge: 'end' } } } },
      { loop: 2, body: { play: { from: { bar: 1 }, to: { bar: 1, edge: 'end' } }, tempo: 80 } },
    ] } });
    expect(p.notes.filter((n) => n.cursor === '0.0').length).toBe(6);
    expect(p.notes.filter((n) => n.cursor === '0.1').map((n) => n.t)).toEqual([0, 0.75, 1.5, 2.25]);
  });
});

describe('imperfect sketches', () => {
  // StaffInk: bar 1 only half written (C4 D4~D4), bar 2 = E4
  const si = newScore({ time: [4, 4], tempo: 120 });
  let id = 1;
  const note = (pos, extra = {}) => ({ id: id++, kind: 'note', dur: 4, dots: 0, heads: [{ pos, acc: null }], ...extra });
  si.measures[0].staves[0].events.push(note(-2), note(-1, { tie: true }), note(-1));
  si.measures[1].staves[0].events.push(note(0));
  const ir = fromStaffInk(si);

  test('the unwritten beat stays silent, or is skipped; ties sound as one note', () => {
    const keep = perform(ir, { tempo: 120, root: { walk: {}, articulate: false } });
    expect(keep.notes.map((n) => [n.midi, n.t, n.dur])).toEqual([[60, 0, 0.5], [62, 0.5, 1], [64, 2, 0.5]]);
    const tight = perform(ir, { tempo: 120, root: { walk: {}, gaps: 'compress' } });
    expect(tight.notes.map((n) => n.t)).toEqual([0, 0.5, 1.5]);
  });
  test('uncertain readings: cycle through them per pass, or leave out the doubtful ones', () => {
    const s = createScore();
    addEvent(s, { onset: 0, dur: '1/4', heads: [{ d: 28 }], alt: { group: 'g', option: 'a', conf: 0.8 } });
    addEvent(s, { onset: 0, dur: '1/4', heads: [{ d: 29 }], alt: { group: 'g', option: 'b', conf: 0.3 } });
    addEvent(s, { onset: '1/4', dur: '1/4', heads: [{ d: 30 }] });
    addEvent(s, { onset: '1/2', dur: '1/4', heads: [{ d: 31 }], alt: { group: 'h', option: 'x', conf: 0.2 } });
    expect(midis(perform(s, { root: { loop: 2, body: { play: {} }, alts: 'cycle' } }))).toEqual([60, 64, 65, 62, 64, 65]);
    expect(midis(perform(s, { root: { play: {}, minConf: 0.5 } }))).toEqual([60, 64]);
  });
});

describe('experiments are replayable', () => {
  const { s } = page();
  const prog = (seed) => ({ seed, root: { loop: 8, body: { choose: [{ play: { from: { bar: 1 }, to: { bar: 1, edge: 'end' } } }, { play: { from: { bar: 4 }, to: { bar: 4, edge: 'end' } } }], weights: [1, 1] } } });
  test('same seed, same piece; the choices actually vary', () => {
    expect(midis(perform(s, prog(7)))).toEqual(midis(perform(s, prog(7))));
    const firsts = new Set(Array.from({ length: 6 }, (_, k) => midis(perform(s, prog(k + 1))).join()));
    expect(firsts.size).toBeGreaterThan(1);
    expect(midis(perform(s, prog(3))).every((m) => [60, 62, 71, 72].includes(m))).toBe(true);
  });
});

describe('StaffInk player', async () => {
  const { Player } = await import('../staffink/audio.js');
  const { siId, inkId } = await import('./adapters/staffink.js');

  // a clock-driven fake: voice() records what would sound, frames advance the audio clock
  function fake() {
    const pl = new Player(), voices = [], frames = [];
    pl.ctx = { currentTime: 0 };
    pl.ensure = () => pl.ctx;
    pl.voice = (midi, t, dur, vel) => voices.push({ midi, t: +t.toFixed(3), dur: +dur.toFixed(3), vel });
    globalThis.requestAnimationFrame = (f) => { frames.push(f); return frames.length; };
    globalThis.cancelAnimationFrame = () => {};
    const advance = (sec) => { pl.ctx.currentTime = sec; const f = frames.shift(); f && f(); };
    return { pl, voices, advance };
  }
  const si = newScore({ time: [2, 4], tempo: 120 });
  let id = 1;
  const note = (pos, extra = {}) => ({ id: id++, kind: 'note', dur: 4, dots: 0, heads: [{ pos, acc: null }], ...extra });
  si.measures[0].staves[0].events.push(note(-2, { dyn: 'p' }), note(-1));
  si.measures[1].staves[0].events.push(note(0, { artic: ['accent'] }), note(1));
  const ir = fromStaffInk(si);

  test('IR ids map back to StaffInk ids; dynamics become velocities, accents louder', () => {
    expect(ir.events.map((e) => inkId(e.id))).toEqual([1, 2, 3, 4]);
    expect(siId(3)).toBe('si3');
    expect(ir.events[0].vel).toBeCloseTo(0.44);
    expect(ir.events[2].marks).toEqual(['accent']);
    const v = perform(ir, { root: { play: {} } }).notes.map((n) => n.vel);
    expect(v[2]).toBeGreaterThan(v[1]);
  });
  test('a program plays through the shared scheduler; all cursors light up their notes', () => {
    const { pl, voices, advance } = fake();
    const p = perform(ir, { tempo: 120, root: { par: [
      { play: { from: { event: siId(3) } } },                 // bar 2 ...
      { loop: 2, body: { play: { events: [siId(1)] } } },     // ... over a repeated first note
    ] } });
    const seen = [];
    let stopped = false;
    pl.onStop = () => { stopped = true; };
    pl.playPerformance(p, (on, now) => seen.push([+now.toFixed(2), [...on].sort()]), inkId);
    advance(0.08 + 0.1); advance(0.08 + 0.6); advance(0.08 + 1.5);
    expect(voices.map((v) => [v.midi, +(v.t - 0.08).toFixed(3)])).toEqual([[60, 0], [64, 0], [60, 0.5], [65, 0.5]]);
    expect(seen).toEqual([[0.1, [1, 3]], [0.6, [1, 4]], [1.5, []]]);
    expect(stopped).toBe(true);
  });
  test('the ordinary Play button path: same notes and times, scheduled just ahead', () => {
    const { pl, voices, advance } = fake();
    const seen = [];
    pl.play(si, (on) => seen.push([...on]));
    expect(voices.map((v) => v.midi)).toEqual([60]); // only what falls inside the lookahead
    advance(0.08 + 1.1);
    expect(seen).toEqual([[3]]);
    advance(0.08 + 1.6);
    expect(voices.map((v) => v.midi)).toEqual([60, 62, 64, 65]);
    expect(voices.map((v) => +(v.t - 0.08).toFixed(3))).toEqual([0, 0.5, 1, 1.5]);
    pl.stop();
  });
});

describe('articulation in perform()', async () => {
  const { performance } = await import('../staffink/export.js');
  const { DIV } = await import('../staffink/theory.js');
  // every rule StaffInk's own playback has: slur, staccato, staccatissimo, tenuto, marcato,
  // accent, a fermata, a tie across the bar, dynamics and a hairpin
  const si = newScore({ time: [4, 4], tempo: 90 });
  let id = 1;
  const n = (pos, x = {}) => ({ id: id++, kind: 'note', dur: 4, dots: 0, heads: [{ pos, acc: null }], ...x });
  const m0 = [n(0, { dyn: 'p' }), n(1), n(2), n(3, { stacc: true })];
  const m1 = [n(4, { artic: ['tenuto'] }), n(5, { artic: ['staccatissimo'] }), n(4, { artic: ['marcato'], dur: 8 }), n(3, { dur: 8, artic: ['accent'] }), n(2, { tie: true, dyn: 'f' })];
  const m2 = [n(2, { dur: 4 }), n(1, { fermata: true }), n(0, { dur: 2 })];
  si.measures[0].staves[0].events.push(...m0);
  si.measures[1].staves[0].events.push(...m1);
  si.measures.push({ attrs: {}, staves: [{ events: m2 }] });
  si.slurs = [{ from: m0[0].id, to: m0[2].id }];
  si.hairpins = [{ from: m1[0].id, to: m1[3].id, type: 'dim' }];

  test('the IR plays exactly what StaffInk plays (times, lengths, loudness)', () => {
    const own = performance(si).notes, spt = 60 / 90 / DIV;
    const ir = perform(fromStaffInk(si), { tempo: 90, root: { walk: {} } }).notes;
    const r3 = (x) => Math.round(x * 1000) / 1000;
    expect(ir.map((x) => [x.midi, r3(x.t), r3(x.dur), r3(x.vel)])).toEqual(own.map((x) => [x.midi, r3(x.tick * spt), r3(x.dur * spt), r3(x.vel)]));
    expect(ir.length).toBe(11); // the tie sounds once
  });
  test('slurred notes join, staccato is short, the fermata waits', () => {
    const p = perform(fromStaffInk(si), { tempo: 60, root: { walk: {} } }).notes;
    expect(p[0].dur).toBeCloseTo(1); expect(p[1].dur).toBeCloseTo(1); // under the slur: full value
    expect(p[2].dur).toBeLessThan(1); // its last note is not joined
    expect(p[3].dur).toBeCloseTo(0.45);
    const ferm = p.find((x) => x.event === `si${m2[1].id}`), after = p.find((x) => x.event === `si${m2[2].id}`);
    expect(after.t - ferm.t).toBeCloseTo(2); // held twice its value
    const flat = perform(fromStaffInk(si), { tempo: 60, root: { walk: {}, articulate: false } }).notes;
    expect(flat[3].dur).toBeCloseTo(1);
  });
});

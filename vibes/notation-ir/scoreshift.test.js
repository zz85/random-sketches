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


describe('stable ids: a saved program survives corrections', async () => {
  const { loadFixture } = await import('../scoreshift/eval.js');
  const { analyze, normalize, interpret: respell, yOfP } = await import('../scoreshift/omr.js');
  const { markOriginal, collectEdits, applyEdits } = await import('../scoreshift/edits.js');
  const { checkProgram } = await import('./playback.js');
  const { findById, parsePageId, AnchorError } = await import('./anchors.js');
  const read = () => markOriginal(analyze(normalize(loadFixture('minuet').img)));
  const ir = (model) => fromScoreShift(model, buildScore(model)).score;

  const a = read(), A = ir(a);
  const evs = A.events.filter((e) => e.src.line === 0);
  const bars = A.directions.filter((d) => d.kind === 'barline' && d.src.line === 0);
  // a loop from bar 3's printed barline to a note in bar 5, plus a lasso of two notes
  const program = { tempo: 120, root: { seq: [
    { loop: 2, body: { play: { from: { barline: bars[1].id }, to: { event: evs.find((e) => e.onset.n / e.onset.d >= 3 * 0.75 + 0.25).id } } } },
    { play: { events: [evs[12].id, evs[14].id] }, gaps: 'compress' },
  ] } };
  const sound = (s) => perform(s, program).notes.map((n) => `${n.midi}@${n.t.toFixed(3)}`);
  const before = sound(A);

  test('ids are keyed to the page', () => {
    const k = parsePageId(evs[0].id);
    expect(k).toMatchObject({ kind: 'ss', line: 0, voice: 'v1' });
    expect(Math.abs(k.q * A.pageIds.unit - evs[0].src.x)).toBeLessThanOrEqual(A.pageIds.unit / 2);
    expect(new Set(A.events.map((e) => e.id)).size).toBe(A.events.length);
    expect(parsePageId(bars[1].id).kind).toBe('ssb');
    expect(checkProgram(A, program)).toEqual([]);
  });
  test('deleting a note earlier on the page keeps every later id, and the program sounds the same', () => {
    const b = read(), st = b.staves[0], gone = st.notes[1];
    st.notes.splice(1, 1); b.notes.splice(b.notes.indexOf(gone), 1); respell(st);
    const B = ir(b);
    // every later event moved up one place in the list, so an index-based id would now name its neighbour
    expect(B.events.findIndex((e) => e.id === evs[12].id)).toBe(A.events.findIndex((e) => e.id === evs[12].id) - 1);
    const later = A.events.filter((e) => e.src.line > 0 || e.src.x > evs[2].src.x).map((e) => e.id);
    const ids = new Set(B.events.map((e) => e.id));
    expect(later.every((id) => ids.has(id))).toBe(true);
    expect(B.events.length).toBe(A.events.length - 1);
    expect(checkProgram(B, program)).toEqual([]);
    expect(sound(B)).toEqual(before);
  });
  test('the same edit through a saved project file', () => {
    const b = read(); b.staves[0].notes.splice(1, 1); respell(b.staves[0]);
    const edits = JSON.parse(JSON.stringify(collectEdits(b))), saved = JSON.parse(JSON.stringify(program));
    const c = read(); applyEdits(c, edits, { interpret: respell, yOfP });
    expect(sound(ir(c)).length).toBe(before.length);
    expect(perform(ir(c), saved).notes.map((n) => n.midi)).toEqual(perform(A, program).notes.map((n) => n.midi));
  });
  test('a head that moved a little is still found; a deleted one is reported, not replaced', () => {
    const b = read(), st = b.staves[0], target = A.events.find((e) => e.id === evs[12].id);
    const n = st.notes.find((q) => Math.abs(q.x - target.src.x) < 1);
    n.x += 5; respell(st); // re-read a few pixels off: less than half a space (8 px)
    const B = ir(b);
    expect(B.events.some((e) => e.id === evs[12].id)).toBe(false);
    expect(findById(B, 'event', evs[12].id).heads[0].d).toBe(target.heads[0].d);
    expect(sound(B).length).toBe(before.length);

    const c = read(), sc = c.staves[0];
    sc.notes.splice(sc.notes.findIndex((q) => Math.abs(q.x - target.src.x) < 1), 1); respell(sc);
    const C = ir(c);
    expect(findById(C, 'event', evs[12].id)).toBe(null);
    const lost = checkProgram(C, program);
    expect(lost.map((l) => l.path)).toEqual(['root.seq[1].play.events']);
    expect(lost[0].anchor.events).toEqual([evs[12].id]);
    expect(() => perform(C, program)).toThrow(AnchorError);
  });
});

describe('the photo surface (ScoreShift)', async () => {
  const { photoSurface } = await import('../scoreshift/surface.js');
  const { checkSurface, headMaps, layoutMarkersOn, selectionBands } = await import('./surface.js');
  const { lineY } = await import('../scoreshift/omr.js');
  const irc = fromScoreShift(minuet.model, minuet.sc, { from: instrument('C') });
  const surf = checkSurface(photoSurface({ model: minuet.model, score: minuet.sc, irc, view: () => ({ X: (x) => x, Y: (y) => y, sp: 16 }) }));
  const ev = irc.score.events.filter((e) => e.src.line === 0).sort((a, b) => a.src.x - b.src.x);
  test('lines follow the staves on the photo; events are where they were printed', () => {
    const st = minuet.model.staves[0], L = surf.lines()[0];
    expect(L.topAt(st.x0 + 100)).toBe(lineY(st, 0, st.x0 + 100));
    expect(surf.place(ev[3].id, 'center')).toEqual([{ line: 0, x: ev[3].src.x, top: lineY(st, 0, ev[3].src.x) }]);
    expect(surf.place('ss:L99:q1:v1')).toEqual([]);
  });
  test('the note under a point, the bar under a point, the bar an event is in', () => {
    const st = minuet.model.staves[0], x = ev[5].src.x;
    expect(surf.eventAt({ x: x + 2, y: lineY(st, 2, x) })).toBe(ev[5].id);
    expect(surf.eventAt({ x, y: lineY(st, 0, x) - 400 })).toBe(null);
    const m = minuet.sc.measures[2], bar = surf.barAt({ x: (m.x0 + m.x1) / 2, y: lineY(m.st, 2, (m.x0 + m.x1) / 2) });
    expect(irc.byId.get(bar.first).m).toBe(m); expect(irc.byId.get(bar.last).m).toBe(m);
    expect(surf.barOf(bar.first)).toEqual({ key: m.index, line: m.st.index, x: Math.min(m.x1, m.st.x1) });
  });
  test('markers, selection and playheads through the surface', () => {
    const L = layoutMarkersOn(surf, { clips: [{ id: 'a', name: 'A', from: { event: ev[2].id }, to: { event: ev[6].id, edge: 'end' } }], jumps: [{ id: 'j', name: 'J1', at: { barline: irc.score.directions.find((d) => d.kind === 'barline').id }, to: { event: ev[0].id } }] });
    expect(L.items[0].pieces[0].x0).toBeCloseTo(ev[2].src.x - 0.7 * surf.space);
    expect(L.lost).toEqual([]);
    expect(selectionBands(surf, [ev[2].id, ev[6].id])[0]).toMatchObject({ line: 0 });
    const items = irc.score.events.map((e) => ({ id: e.id, t: e.onset.n / e.onset.d, end: (e.onset.n / e.onset.d) + e.dur.n / e.dur.d }));
    const m = headMaps(surf, items);
    expect(m(0)).toEqual([{ line: 0, x: ev[0].src.x }]);
    const t = ev[4].onset.n / ev[4].onset.d;
    expect(m(t)[0].x).toBeCloseTo(ev[4].src.x, 1);
  });
});

describe('pen annotations on a photographed page', async () => {
  const { photoSurface } = await import('../scoreshift/surface.js');
  const { attachStrokes, resolveAnnotation, itemsOf } = await import('./annotations.js');
  const { loadFixture } = await import('../scoreshift/eval.js');
  const { analyze, normalize, interpret: respell } = await import('../scoreshift/omr.js');
  const { markOriginal } = await import('../scoreshift/edits.js');
  const { lineY } = await import('../scoreshift/omr.js');
  const read = () => markOriginal(analyze(normalize(loadFixture('minuet').img)));
  const view = () => ({ X: (x) => x, Y: (y) => y, sp: 16 });
  const surfOf = (model, opts = {}) => { const sc = buildScore(model), irc = fromScoreShift(model, sc, opts); return { surf: photoSurface({ model, score: sc, irc, view }), items: itemsOf(irc.score), irc }; };
  const a = read(), A = surfOf(a);
  const ev = A.irc.score.events.filter((e) => e.src.line === 0).sort((x, y) => x.src.x - y.src.x);
  const target = ev[8], st = a.staves[0], top = lineY(st, 0, target.src.x), sp = a.space || 16;
  // a "3" written a space and a half above the staff over the 9th note
  const ink = [[{ x: target.src.x - 4, y: top - 2 * sp }, { x: target.src.x + 4, y: top - 1.5 * sp }, { x: target.src.x - 3, y: top - sp }]];
  const ann = attachStrokes(A.surf, A.items, ink, { id: 'f1' });
  const at = (S) => resolveAnnotation(S.surf, ann, S.items);
  test('a fingering written on the photo is attached to the note under it', () => {
    expect(ann.anchor).toEqual({ kind: 'event', id: target.id });
    expect(at(A).pieces[0].points.map((q) => [Math.round(q.x), Math.round(q.y)])).toEqual(ink[0].map((q) => [Math.round(q.x), Math.round(q.y)]));
  });
  test('it stays on its note after a correction elsewhere rebuilds the page', () => {
    const b = read(); b.staves[0].notes.splice(1, 1); respell(b.staves[0]);
    const r = at(surfOf(b));
    expect(r.lost).toBe(false);
    expect(r.pieces[0].points[0].x).toBeCloseTo(ink[0][0].x, 0);
  });
  test('and on the transposed page (the note moved up a step, the fingering did not move off it)', async () => {
    const { plan } = await import('../scoreshift/render.js');
    const T = surfOf(a, { plan: plan(a, { from: 'C', to: 'Bb-clarinet', octave: 'auto', clef: 'auto' }) });
    expect(T.irc.score.events.find((e) => e.id === target.id).heads[0].d).toBe(target.heads[0].d + 1);
    expect(at(T).pieces[0].points[0]).toEqual(at(A).pieces[0].points[0]);
  });
  test('its note deleted: drawn where the note was, flagged lost', () => {
    const c = read(), sc = c.staves[0];
    sc.notes.splice(sc.notes.findIndex((n) => Math.abs(n.x - target.src.x) < 1), 1); respell(sc);
    const r = at(surfOf(c));
    expect(r.lost).toBe(true);
    expect(Math.abs(r.pieces[0].points[0].x - ink[0][0].x)).toBeLessThan(sp / 2);
  });
});

describe('annotations in exported pages', async () => {
  const { chooseAnnotations, colorsOf, drawPageAnnotations } = await import('../scoreshift/inkexport.js');
  const { photoSurface } = await import('../scoreshift/surface.js');
  const { attachStrokes, itemsOf } = await import('./annotations.js');
  const { lineY } = await import('../scoreshift/omr.js');
  const model = minuet.model, sc = minuet.sc, irc = fromScoreShift(model, sc);
  const surf = photoSurface({ model, score: sc, irc, view: () => ({ X: (x) => x, Y: (y) => y, sp: 16 }) });
  const items = itemsOf(irc.score), st = model.staves[0];
  const ev = irc.score.events.filter((e) => e.src.line === 0).sort((a, b) => a.src.x - b.src.x);
  const mark = (e, color) => attachStrokes(surf, items, [[{ x: e.src.x - 4, y: lineY(st, 0, e.src.x) - 30 }, { x: e.src.x + 4, y: lineY(st, 0, e.src.x) - 26 }]], { id: color, color });
  const list = [mark(ev[3], '#c2255c'), mark(ev[9], '#1c7ed6')];
  const ctx = () => { const calls = []; return { calls, g: new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => calls.push([k, ...a])), set: (t, k, v) => ((t[k] = v), true) }) }; };
  test('choose: all, none, or by colour', () => {
    expect(chooseAnnotations(list, {}).length).toBe(2);
    expect(chooseAnnotations(list, { include: false })).toEqual([]);
    expect(chooseAnnotations(list, { colors: ['#1C7ED6'] }).map((a) => a.id)).toEqual(['#1c7ed6']);
    expect(colorsOf([list, [], null])).toEqual(['#c2255c', '#1c7ed6']);
  });
  test('drawn at the export scale, where they were written', () => {
    const { calls, g } = ctx();
    expect(drawPageAnnotations(g, { model, renderer: { r: 2 }, annotations: list, opts: { colors: ['#c2255c'] } })).toBe(1);
    const mv = calls.find((c) => c[0] === 'moveTo');
    expect(mv[1]).toBeCloseTo((ev[3].src.x - 4) * 2, 0);
    expect(mv[2]).toBeCloseTo((lineY(st, 0, ev[3].src.x) - 30) * 2, 0);
  });
  test('on the transposed page, through the stretched staff', async () => {
    const { calls, g } = ctx();
    const { plan: mk } = await import('../scoreshift/render.js'), plan = mk(model, { from: 'C', to: 'Bb-clarinet', octave: 'auto', clef: 'auto' });
    const warps = new Map([[st, { warp: (x) => x + 20, k: 1 }]]);
    drawPageAnnotations(g, { model, renderer: { r: 1, warps }, plan, annotations: [list[0]] });
    expect(calls.find((c) => c[0] === 'moveTo')[1]).toBeCloseTo(ev[3].src.x - 4 + 20, 0);
  });
  test('nothing chosen: nothing drawn', () => {
    const { calls, g } = ctx();
    expect(drawPageAnnotations(g, { model, renderer: { r: 1 }, annotations: list, opts: { include: false } })).toBe(0);
    expect(calls.length).toBe(0);
  });
});

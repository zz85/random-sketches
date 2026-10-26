// bun test — pen annotations: attach ink to the music, redraw it on any surface.
import { test, expect, describe } from 'bun:test';
import { attachStrokes, resolveAnnotation, hitAnnotation, reattachAnnotation, drawAnnotations, itemsOf, annotationEvents } from './annotations.js';
import { checkSurface } from './surface.js';

// A toy surface: two lines (systems). Line 0 is a grand staff: treble top at y 10, bass at y 20.
// Line 1 is one staff at y 40. Note positions can be changed to simulate re-engraving.
function toySurface({ space = 1, where, lines = [{ x0: 0, x1: 100, top: 10, bottom: 24, group: 0 }, { x0: 0, x1: 100, top: 40, bottom: 44, group: 0 }], lostAt } = {}) {
  return checkSurface({
    kind: 'toy', space, view: () => ({ X: (x) => x * 10, Y: (y) => y * 10, sp: 10 * space }),
    lines: () => lines,
    place(id, edge = 'start') {
      const w = where[id]; if (!w) return [];
      const [line, x, top] = w;
      return [{ line, x: x + (edge === 'end' ? 1.5 : edge === 'center' ? 0 : -1) * space, top }];
    },
    eventAt(pt) {
      let best = null, bd = Infinity;
      for (const [id, [line, x, top]] of Object.entries(where)) { const d = Math.abs(x - pt.x) + 3 * Math.abs(top + 2 * space - pt.y); if (d < bd) { bd = d; best = id; } }
      return best;
    },
    ...(lostAt ? { lostAt } : {}),
  });
}
// treble t0..t5 at x 10..60 (one per beat), bass b0..b1 under them; line 1: t6, t7
const W0 = { t0: [0, 10, 10], t1: [0, 20, 10], t2: [0, 30, 10], t3: [0, 40, 10], t4: [0, 50, 10], t5: [0, 60, 10], b0: [0, 10, 20], b1: [0, 40, 20], t6: [1, 10, 40], t7: [1, 30, 40] };
const items = [['t0', 0], ['t1', 0.25], ['t2', 0.5], ['t3', 0.75], ['t4', 1], ['t5', 1.25], ['b0', 0], ['b1', 0.75], ['t6', 1.5], ['t7', 1.75]]
  .map(([id, t]) => ({ id, t, end: t + (id[0] === 'b' ? 0.75 : 0.25) }));
const line = (pts) => pts.map(([x, y, p]) => ({ x, y, ...(p != null ? { p } : {}) }));
const pts = (r) => r.pieces.flatMap((pc) => pc.points.map((q) => [pc.line, +q.x.toFixed(3), +q.y.toFixed(3)]));

describe('attaching ink to music', () => {
  const S = toySurface({ where: W0 });
  test('a short mark over a note: attached to that note, in staff spaces', () => {
    const a = attachStrokes(S, items, [line([[29.5, 8], [30.5, 7]])], { id: 'f1' }); // a fingering above t2
    expect(a.anchor).toEqual({ kind: 'event', id: 't2' });
    expect(a.strokes[0]).toEqual([{ u: -0.5, dy: -2 }, { u: 0.5, dy: -3 }]);
    expect(a.at).toBe(0.5);
    expect(pts(resolveAnnotation(S, a, items))).toEqual([[0, 29.5, 8], [0, 30.5, 7]]); // round trip
  });
  test('a mark on the bass staff of a grand staff is measured from the bass staff', () => {
    const a = attachStrokes(S, items, [line([[40, 27]])]);
    expect(a.anchor.id).toBe('b1');
    expect(a.strokes[0][0].dy).toBe(7); // 7 spaces below the bass top (y 20), not 17 below the treble
  });
  test('a circle around several notes: a span over them, of that staff only; margins kept in spaces', () => {
    const circle = line([[18, 9], [35, 8], [43, 10], [35, 15], [18, 14], [18, 9]]); // around t1..t3
    const a = attachStrokes(S, items, [circle]);
    expect(a.anchor).toEqual({ kind: 'span', first: 't1', last: 't3' }); // b1 (bass, same x) not included
    expect(annotationEvents(a)).toEqual(['t1', 't3']);
    expect(a.strokes[0][0]).toEqual({ u: 0, ox: -1, dy: -1 }); // 1 space before t1's start (x 19)
    expect(a.strokes[0][2]).toEqual({ u: 1, ox: 1.5, dy: 0 }); // 1.5 past t3's end (41.5)
  });
  test('a mark far from any note: anchored to its moment on the staff', () => {
    const a = attachStrokes(S, items, [line([[85, 8], [90, 8]])]); // past the last note of line 0
    expect(a.anchor.kind).toBe('time');
    expect(a.at).toBe(1.25); // beyond t5: the last moment on that staff
    const b = attachStrokes(toySurface({ where: { ...W0, t5: [0, 95, 10] } }), items, [line([[78, 8], [80, 8]])]);
    expect(b.anchor.kind).toBe('time');
    expect(b.at).toBeCloseTo(1 + 0.25 * (29 / 45)); // between t4 (x 50) and t5 (x 95)
  });
  test('nothing to attach to: null', () => {
    expect(attachStrokes(S, [], [line([[1, 1]])])).toBe(null);
    expect(attachStrokes(S, items, [[]])).toBe(null);
  });
});

describe('the ink follows the music', () => {
  const S = toySurface({ where: W0 });
  const fing = attachStrokes(S, items, [line([[29.5, 8, 0.4], [30.5, 7, 0.6]])]);
  const circle = attachStrokes(S, items, [line([[18, 9], [43, 9], [43, 14], [18, 14]])]);
  test('a note moved (an edit, a re-engraving): the fingering moves with it, pressure kept', () => {
    const moved = toySurface({ where: { ...W0, t2: [0, 37, 10] } });
    expect(pts(resolveAnnotation(moved, fing, items))).toEqual([[0, 36.5, 8], [0, 37.5, 7]]);
    expect(resolveAnnotation(moved, fing, items).pieces[0].points.map((q) => q.p)).toEqual([0.4, 0.6]);
  });
  test('a different scale (photo pixels vs staff spaces): offsets scale with the staff space', () => {
    const W = Object.fromEntries(Object.entries(W0).map(([k, [l, x, t]]) => [k, [l, x * 16, t * 16]]));
    const big = toySurface({ space: 16, where: W, lines: [{ x0: 0, x1: 1600, top: 160, bottom: 384, group: 0 }, { x0: 0, x1: 1600, top: 640, bottom: 704, group: 0 }] });
    expect(pts(resolveAnnotation(big, fing, items))).toEqual([[0, 472, 128], [0, 488, 112]]);
  });
  test('the notes spread apart: the circle stretches with them', () => {
    const wide = toySurface({ where: { ...W0, t1: [0, 20, 10], t3: [0, 80, 10] } });
    const [p0, p1] = resolveAnnotation(wide, circle, items).pieces[0].points;
    expect(p0.x).toBeCloseTo(18); // the start stays 1 space before t1
    expect(p1.x).toBeCloseTo(83); // the right edge stays 1.5 spaces past t3's end (81.5)
  });
  test('a span over a line break on another surface is drawn in two pieces', () => {
    const broken = toySurface({ where: { ...W0, t3: [1, 12, 40] } }); // t3 moved to the next system
    const r = resolveAnnotation(broken, circle, items);
    expect(r.pieces.map((p) => p.line)).toEqual([0, 1, 0]); // the left edge, the right edge on the next line, back
    expect(pts(r)[1]).toEqual([1, 15, 39]); // the right edge 1.5 spaces past t3's end on its new line
    expect(r.pieces.find((p) => p.line === 1).points.every((q) => q.y > 35 && q.y < 46)).toBe(true); // drawn at line 1's staff
  });
  test('a margin mark stays at its moment when the notes move', () => {
    const a = attachStrokes(S, items, [line([[85, 8], [90, 8]])]);
    const shifted = toySurface({ where: Object.fromEntries(Object.entries(W0).map(([k, [l, x, t]]) => [k, [l, x + 5, t]])) });
    expect(pts(resolveAnnotation(shifted, a, items))).toEqual([[0, 90, 8], [0, 95, 8]]);
  });
  test('the music is not on this surface: nothing drawn', () => {
    const empty = toySurface({ where: {} });
    expect(resolveAnnotation(empty, fing, [])).toBe(null);
  });
});

describe('when the note is deleted', () => {
  const S = toySurface({ where: W0 });
  const fing = attachStrokes(S, items, [line([[29.5, 8], [30.5, 7]])]);
  const { t2, ...gone } = W0; void t2;
  const without = items.filter((q) => q.id !== 't2');
  test('drawn where the note used to be when the surface knows (a photo), marked lost', () => {
    const r = resolveAnnotation(toySurface({ where: gone, lostAt: (a) => (a.event === 't2' ? { line: 0, x: 30 } : null) }), fing, without);
    expect(r.lost).toBe(true);
    expect(pts(r)).toEqual([[0, 29.5, 8], [0, 30.5, 7]]);
  });
  test('otherwise at its moment on the staff', () => {
    const r = resolveAnnotation(toySurface({ where: gone }), fing, without);
    expect(r.lost).toBe(true);
    expect(r.pieces[0].points[0].x).toBeCloseTo(29.5); // t = 0.5, halfway between t1 (20) and t3 (40)
  });
  test('re-attached to another note', () => {
    const a = structuredClone(fing);
    reattachAnnotation(a, 't3', without);
    expect(resolveAnnotation(toySurface({ where: gone }), a, without).lost).toBe(false);
    expect(pts(resolveAnnotation(toySurface({ where: gone }), a, without))).toEqual([[0, 39.5, 8], [0, 40.5, 7]]);
  });
});

describe('picking and drawing', () => {
  const S = toySurface({ where: W0 });
  const a = { ...attachStrokes(S, items, [line([[29.5, 8], [30.5, 7]])]), id: 'a' }, b = { ...attachStrokes(S, items, [line([[50, 27], [52, 27]])]), id: 'b' };
  test('the annotation under a point', () => {
    expect(hitAnnotation(S, [a, b], items, { x: 30, y: 7.6 })?.id).toBe('a');
    expect(hitAnnotation(S, [a, b], items, { x: 51, y: 27.2 })?.id).toBe('b');
    expect(hitAnnotation(S, [a, b], items, { x: 70, y: 30 })).toBe(null);
  });
  test('plain JSON: stored and loaded, it draws the same', () => {
    const back = JSON.parse(JSON.stringify(a));
    expect(resolveAnnotation(S, back, items)).toEqual(resolveAnnotation(S, a, items));
  });
  test('draws round strokes on any 2D context, lost ones dashed', () => {
    const calls = [];
    const g = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...x) => calls.push([k, ...x])), set: (t, k, v) => ((t[k] = v), true) });
    drawAnnotations(g, S, [a], items);
    expect(calls.filter((c) => c[0] === 'stroke').length).toBe(1);
    expect(calls.find((c) => c[0] === 'setLineDash')[1]).toEqual([]);
    calls.length = 0;
    drawAnnotations(g, toySurface({ where: {} }), [a], items.filter((q) => q.id !== 't2')); // its note gone, nothing placed
    expect(calls.filter((c) => c[0] === 'stroke').length).toBe(0);
  });
  test('itemsOf an IR score', () => {
    const score = { events: [{ id: 'x', onset: { n: 1, d: 4 }, dur: { n: 1, d: 8 } }, { id: 'y', fragment: 'idea', onset: { n: 0, d: 1 }, dur: { n: 1, d: 4 } }] };
    expect(itemsOf(score)).toEqual([{ id: 'x', t: 0.25, end: 0.375 }]);
  });
});

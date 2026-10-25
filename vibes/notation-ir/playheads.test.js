// bun test — playhead lines: time maps over line breaks, cursors with their clip colours.
import { test, expect, describe } from 'bun:test';
import { timeMap, cursorsAt, headsAt, drawPlayheads, HEAD_COLORS } from './playheads.js';
import { createScore, addEvent, addDirection } from './ir.js';
import { emptyArrangement, addClip, compileArrangement, rangeOfIR, arrangementMarkers } from './arrangement.js';
import { layoutMarkers } from './markers.js';
import { perform, playheadsAt } from './playback.js';
import { r } from './rational.js';

const lines = [{ x0: 0, x1: 100, top: 10, bottom: 14 }, { x0: 0, x1: 100, top: 30, bottom: 34 }];

describe('timeMap', () => {
  // a bar of four beats on line 0 (barline at 95), the next bar on line 1
  const pts = [{ t: 0, line: 0, x: 10 }, { t: 1, line: 0, x: 30 }, { t: 2, line: 0, x: 50 }, { t: 3, line: 0, x: 70 }, { t: 4, line: 0, x: 95, end: true },
    { t: 4, line: 1, x: 10 }, { t: 6, line: 1, x: 50 }];
  const m = timeMap(pts, lines);
  test('moves linearly between points: through a held note or a rest too', () => {
    expect(m(0)).toEqual({ line: 0, x: 10 });
    expect(m(0.5)).toEqual({ line: 0, x: 20 });
    expect(m(3.5).x).toBeCloseTo(82.5);
  });
  test('at a line break: up to the barline, then on at the next line', () => {
    expect(m(3.999).line).toBe(0);
    expect(m(4)).toEqual({ line: 1, x: 10 });
    expect(m(5)).toEqual({ line: 1, x: 30 });
  });
  test('waits before the first point and stays after the last', () => {
    expect(m(-1)).toEqual({ line: 0, x: 10 });
    expect(m(9)).toEqual({ line: 1, x: 50 });
    expect(timeMap([], lines)(1)).toBe(null);
  });
  test('without a closing barline it runs on to the end of the line', () => {
    const n = timeMap([{ t: 0, line: 0, x: 60 }, { t: 2, line: 1, x: 5 }], lines);
    expect(n(1)).toEqual({ line: 0, x: 80 });
  });
});

describe('cursors and colours', () => {
  const s = createScore();
  addDirection(s, 'meter', 0, { beats: 4, unit: 4 });
  [28, 29, 30, 31].forEach((d, i) => addEvent(s, { id: `n${i}`, onset: r(i, 4), dur: '1/4', heads: [{ d, alter: 0 }] }));
  const a = emptyArrangement();
  const A = addClip(a, rangeOfIR(s, 'n0', 'n1')), B = addClip(a, rangeOfIR(s, 'n2', 'n3'));
  a.mode = 'clips'; B.withPrev = true;
  const p = perform(s, { tempo: 120, ...compileArrangement(a) });
  test('trace segments carry their clip marker; two cursors at once', () => {
    expect([...new Set(p.trace.map((x) => x.marker))].sort()).toEqual([A.id, B.id]);
    const c = cursorsAt(p, 0.25);
    expect(c.map((x) => [x.marker, x.at])).toEqual([[A.id, 0.125], [B.id, 0.625]]);
    expect(playheadsAt(s, p, 0.25).map((x) => x.at)).toEqual([0.125, 0.625]);
  });
  test('a cursor in a clip takes the clip colour; outside a clip, the default by cursor', () => {
    const ml = layoutMarkers(arrangementMarkers(a), { lines, place: () => ({ line: 0, x: 1 }) });
    const map = (f, at) => ({ line: 0, x: at * 100 });
    const h = headsAt(p, 0.25, map, ml);
    expect(h.map((x) => x.color)).toEqual(ml.items.map((x) => x.color));
    expect(h.map((x) => x.x)).toEqual([12.5, 62.5]);
    const plain = perform(s, { tempo: 120, root: { par: [{ play: {} }, { play: {}, transpose: 12 }] } });
    expect(headsAt(plain, 0.1, map).map((x) => x.color)).toEqual([HEAD_COLORS[0], HEAD_COLORS[1]]);
    expect(headsAt(plain, 0.1, () => [{ line: 0, x: 1 }, { line: 1, x: 1 }]).length).toBe(4); // a position per part
    expect(headsAt(plain, 99, map)).toEqual([]);
  });
});

describe('drawing', () => {
  test('a line per head across its staff, tilted with the staff', () => {
    const calls = [];
    const g = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => calls.push([k, ...a])), set: (t, k, v) => ((t[k] = v), true) });
    const tilted = [{ ...lines[0], topAt: (x) => 10 + x * 0.05, bottomAt: (x) => 14 + x * 0.05 }];
    drawPlayheads(g, [{ line: 0, x: 50, color: '#f00' }], tilted, { X: (x) => x * 10, Y: (y) => y * 10, sp: 10 });
    const [mv, ln] = [calls.find((c) => c[0] === 'moveTo'), calls.find((c) => c[0] === 'lineTo')];
    expect(mv[1]).toBeGreaterThan(ln[1]); // the staff falls to the right, so the perpendicular's top is right of its bottom
    expect(mv[2]).toBeLessThan(125); // starts above the top line (y 12.5 at x 50)
    expect(calls.filter((c) => c[0] === 'stroke').length).toBe(1);
  });
});

// bun test — the surface interface: feature code written once, run against a toy surface.
import { test, expect, describe } from 'bun:test';
import { checkSurface, placeAnchor, layoutMarkersOn, hitMarkerOn, selectionBands, drawBands, headMaps, drawHeadsOn, drawMarkersOn, timeAt } from './surface.js';
import { geometry } from './markers.js';

// two lines (parts 0 and 1 share line pairs? no: line 0 = part 0, line 1 = part 0 continued, line 2 = part 1)
// events e0..e5 on line 0 at x 10..60, e6..e9 on line 1; p0..p2 on line 2; e9 also shows on line 1 and 0 (a tie)
const lines = [{ x0: 0, x1: 100, top: 10, bottom: 14, group: 0 }, { x0: 0, x1: 100, top: 30, bottom: 34, group: 0 }, { x0: 0, x1: 100, top: 50, bottom: 54, group: 1 }];
const where = { e0: [0, 10], e1: [0, 20], e2: [0, 30], e3: [0, 40], e4: [0, 50], e5: [0, 60], e6: [1, 10], e7: [1, 20], p0: [2, 10], p1: [2, 40], p2: [2, 70] };
const bars = { e0: 'b0', e1: 'b0', e2: 'b0', e3: 'b1', e4: 'b1', e5: 'b1', e6: 'b2', e7: 'b2', p0: 'q0', p1: 'q0', p2: 'q1' };
const barEnd = { b0: [0, 35], b1: [0, 95], b2: [1, 95], q0: [2, 55], q1: [2, 95] };
const toy = {
  kind: 'toy', space: 1, view: () => ({ X: (x) => x * 10, Y: (y) => y * 10, sp: 10 }),
  lines: () => lines,
  place(id, edge = 'start') {
    if (id === 'tie') return [{ line: 0, x: 80 + (edge === 'end' ? 2 : 0) }, { line: 1, x: 5 + (edge === 'end' ? 2 : 0) }]; // across a line break
    const w = where[id]; if (!w) return [];
    return [{ line: w[0], x: w[1] + (edge === 'end' ? 3 : edge === 'center' ? 0 : -2) }];
  },
  eventAt(pt) {
    const line = lines.findIndex((l) => pt.y >= l.top - 3 && pt.y <= l.bottom + 3); if (line < 0) return null;
    let best = null, bd = Infinity; for (const [id, [l, x]] of Object.entries(where)) if (l === line && Math.abs(x - pt.x) < bd) { bd = Math.abs(x - pt.x); best = id; }
    return best;
  },
  barOf: (id) => bars[id] && { key: bars[id], line: barEnd[bars[id]][0], x: barEnd[bars[id]][1] },
  placeAnchor: (a) => (a.barline === 'B1' ? { line: 0, x: 35 } : null),
  lostAt: (a) => (a.event === 'gone' ? { line: 0, x: 44 } : null),
};

describe('the interface', () => {
  test('checkSurface names what is missing', () => {
    expect(checkSurface(toy)).toBe(toy);
    expect(() => checkSurface({ kind: 'half', space: 1, lines() {}, view() {} })).toThrow('missing place, eventAt');
    expect(() => checkSurface({ ...toy, space: 0 })).toThrow('space');
  });
  test('anchors: events by edge (first place for a start, last for an end), others through placeAnchor', () => {
    expect(placeAnchor(toy, { event: 'e1' })).toEqual({ line: 0, x: 18 });
    expect(placeAnchor(toy, { event: 'e1', edge: 'end' })).toEqual({ line: 0, x: 23 });
    expect(placeAnchor(toy, { event: 'tie' }, 'start')).toEqual({ line: 0, x: 80 });
    expect(placeAnchor(toy, { event: 'tie' }, 'end')).toEqual({ line: 1, x: 7 });
    expect(placeAnchor(toy, { barline: 'B1' })).toEqual({ line: 0, x: 35 });
    expect(placeAnchor(toy, { event: 'nowhere' })).toBe(null);
  });
});

describe('features on any surface', () => {
  test('markers: layout, lost markers, hit testing in surface units', () => {
    const L = layoutMarkersOn(toy, { clips: [{ id: 'a', name: 'A', from: { event: 'e4' }, to: { event: 'e7', edge: 'end' } }, { id: 'b', name: 'B', from: { event: 'gone' }, to: { event: 'e1', edge: 'end' } }], jumps: [] });
    expect(L.items[0].pieces.map((p) => [p.line, p.x0, p.x1])).toEqual([[0, 48, 100], [1, 0, 23]]);
    expect(L.lost).toEqual(['b']);
    expect(L.items[1].pieces[0].x0).toBe(44);
    const lab = geometry(L, toy.view())[0].label;
    expect(hitMarkerOn(toy, L, { x: (lab.x + 2) / 10, y: (lab.y + 2) / 10 })?.id).toBe('a');
    expect(hitMarkerOn(toy, null, { x: 0, y: 0 })).toBe(null);
  });
  test('selection bands: one per line, from the first start to the last end', () => {
    expect(selectionBands(toy, ['e5', 'e3', 'e6', 'tie'])).toEqual([{ line: 0, x0: 38, x1: 82 }, { line: 1, x0: 5, x1: 13 }]);
    expect(selectionBands(toy, ['nowhere'])).toEqual([]);
  });
  test('playheads: one per part, through rests to the barline, then the next line', () => {
    const items = [['e0', 0], ['e1', 1], ['e2', 2], ['e3', 3], ['e4', 4], ['e5', 5], ['e6', 6], ['e7', 7], ['p0', 0], ['p1', 3], ['p2', 6]].map(([id, t]) => ({ id, t, end: t + 1 }));
    const m = headMaps(toy, items);
    expect(m(0)).toEqual([{ line: 0, x: 10 }, { line: 2, x: 10 }]);
    expect(m(2.5)).toEqual([{ line: 0, x: 32.5 }, { line: 2, x: 35 }]); // each part at its own place
    expect(m(5.5)[0]).toEqual({ line: 0, x: 77.5 }); // last beat of the line: towards its barline
    expect(m(6)[0]).toEqual({ line: 1, x: 10 });
    expect(m(5)[1].x).toBeCloseTo(62.5); // a bar ending before its next note: up to the barline (x 55) then on
  });
  test('time from a point between notes', () => {
    const items = [['e0', 0], ['e1', 1], ['e2', 2]].map(([id, t]) => ({ id, t }));
    expect(timeAt(toy, items, { x: 15, y: 12 })).toBe(0.5);
    expect(timeAt(toy, items, { x: 2, y: 12 })).toBe(0);
    expect(timeAt(toy, items, { x: 50, y: 80 })).toBe(null);
  });
  test('drawing goes through the surface view', () => {
    const calls = [];
    const g = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => calls.push([k, ...a])), set: (t, k, v) => ((t[k] = v), true) });
    drawBands(g, toy, [{ line: 0, x0: 10, x1: 30 }], { pad: 1 });
    expect(calls.find((c) => c[0] === 'moveTo')).toEqual(['moveTo', 100, 90]);
    drawHeadsOn(g, toy, [{ line: 1, x: 20, color: '#f00' }]);
    drawMarkersOn(g, toy, layoutMarkersOn(toy, { clips: [{ id: 'a', name: 'A', from: { event: 'e1' }, to: { event: 'e2', edge: 'end' } }], jumps: [] }));
    expect(calls.filter((c) => c[0] === 'stroke').length).toBeGreaterThan(2);
  });
});

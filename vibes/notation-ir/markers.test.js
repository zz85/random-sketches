// bun test — shared marker geometry: clips across line breaks, stacking, jumps, lost markers.
import { test, expect, describe } from 'bun:test';
import { markersOf, layoutMarkers, geometry, hitMarker, drawMarkers } from './markers.js';

// two lines of a page, 0..100 wide; events e1..e8, four per line at x = 10, 30, 50, 70
const lines = [{ x0: 0, x1: 100, top: 10, bottom: 14 }, { x0: 0, x1: 100, top: 30, bottom: 34 }];
const pos = (id) => { const k = +String(id).replace(/\D/g, '') - 1; return { line: Math.floor(k / 4), x: 10 + 20 * (k % 4) }; };
const place = (a, edge) => {
  if (!a.event) return a.edge === 'end' ? { line: 1, x: 90 } : { line: 0, x: 5 };
  if (a.event === 'gone') return null;
  const p = pos(a.event); return { line: p.line, x: p.x + (edge === 'end' ? 8 : 0) };
};
const view = { X: (x) => x * 10, Y: (y) => y * 10, sp: 10 };

describe('markersOf a playback program', () => {
  test('play nodes become clips with their loop counts; jumps are collected', () => {
    const m = markersOf({
      clips: { riff: { from: { event: 'e2' }, to: { event: 'e3', edge: 'end' } } },
      jumps: [{ at: { event: 'e4', edge: 'end' }, to: { event: 'e1' } }],
      root: { seq: [{ loop: 4, body: { play: 'riff' } }, { par: [{ play: { events: ['e5', 'e6'] }, marker: 'x' }, { walk: { jumps: [{ at: { event: 'e8' }, to: { event: 'e5' }, times: 2 }] } }] }] },
    });
    expect(m.clips.map((c) => [c.id, c.name, c.loop])).toEqual([['riff', 'A', 4], ['x', 'B', 1]]);
    expect(m.jumps.map((j) => [j.name, j.times])).toEqual([['J1', 2], ['J2', 1]]);
  });
});

describe('layout', () => {
  test('a clip over a line break is drawn in pieces; overlapping clips stack', () => {
    const L = layoutMarkers({ clips: [
      { id: 'a', name: 'A', from: { event: 'e3' }, to: { event: 'e6', edge: 'end' } },
      { id: 'b', name: 'B', loop: 2, from: { event: 'e4' }, to: { event: 'e4', edge: 'end' } },
      { id: 'c', name: 'C', from: { event: 'e1' }, to: { event: 'e2', edge: 'end' } },
    ], jumps: [] }, { lines, place });
    const [a, b, c] = L.items;
    expect(a.pieces.map((p) => [p.line, p.x0, p.x1, p.row, !!p.cutL, !!p.cutR])).toEqual([[0, 50, 100, 0, false, true], [1, 0, 38, 0, true, false]]);
    expect(b.pieces[0].row).toBe(1); // under A's bracket: next row up
    expect(c.pieces[0].row).toBe(0); // clear of A: same row
    expect(b.label).toBe('B ×2');
  });
  test('a lost marker is flagged, and drawn where it used to be when the app knows', () => {
    const m = { clips: [{ id: 'a', name: 'A', from: { event: 'gone' }, to: { event: 'e2', edge: 'end' } }], jumps: [{ id: 'j', name: 'J1', at: { event: 'e4', edge: 'end' }, to: { event: 'gone' } }] };
    const L = layoutMarkers(m, { lines, place, lostAt: () => ({ line: 0, x: 42 }) });
    expect(L.lost).toEqual(['a', 'j']);
    expect(L.items[0].pieces[0].x0).toBe(42);
    expect(L.items[0].label).toBe('A ?');
    expect(L.items[1].to).toEqual({ line: 0, x: 42 });
    expect(layoutMarkers(m, { lines, place }).items[0].pieces).toEqual([]);
  });
});

describe('geometry and hit testing', () => {
  const L = layoutMarkers({ clips: [{ id: 'a', name: 'A', from: { event: 'e1' }, to: { event: 'e2', edge: 'end' } }], jumps: [{ id: 'j', name: 'J1', at: { event: 'e4', edge: 'end' }, to: { event: 'e1' } }] }, { lines, place });
  test('brackets sit above the staff in canvas pixels', () => {
    const g = geometry(L, view);
    expect(g[0].segs[0]).toMatchObject({ x0: 100, x1: 380 });
    expect(g[0].segs[0].y).toBeCloseTo(100 - 1.6 * 10);
    expect(g[1].same).toBe(true);
  });
  test('tapping a label or the bracket finds the marker; elsewhere nothing', () => {
    const g = geometry(L, view)[0];
    expect(hitMarker(L, view, g.label.x + 3, g.label.y + 3)).toMatchObject({ id: 'a', onLabel: true });
    expect(hitMarker(L, view, 250, g.segs[0].y + 1).id).toBe('a');
    expect(hitMarker(L, view, 250, 300)).toBe(null);
  });
  test('draws on any 2D context', () => {
    const calls = [];
    const g = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => calls.push(k)), set: (t, k, v) => ((t[k] = v), true) });
    drawMarkers(g, L, view, { selected: 'a' });
    expect(calls.filter((c) => c === 'stroke').length).toBeGreaterThan(2);
    expect(calls).toContain('fillText');
  });
});

import { test, expect } from 'bun:test';
import { keepFlights, toMatch, fromRecorded, playersAt, rallyList } from './session.js';

const fl = (t0, t1, x = 1) => ({ cam: [3.2, 14, 4], t0, t1, speed: 20, labels: [], impacts: [{ t: (t0 + t1) / 2, X: [x, 0, 1], plane: 'front' }], pts: [{ t: t0, X: [x, 5, 1], V: [0, -20, 2] }, { t: t1, X: [x, 1, 1.2], V: [0, -18, 0] }], uv: [[1, 2]] });

test('flight windows merge into the whole session', () => {
  let all = keepFlights([], [fl(1, 1.4), fl(2, 2.5)]);
  // the worker refits the second flight and adds a third; the first is no longer in its window
  all = keepFlights(all, [fl(2.02, 2.5, 2), fl(3, 3.3)]);
  expect(all.map((f) => f.t0)).toEqual([1, 2.02, 3]);
  expect(all[1].pts[0].X[0]).toBe(2);
  expect(all[0].uv).toBeUndefined(); // pixels are not kept
});

test('a session becomes a match file with a replay', () => {
  const heat = new Float32Array(26 * 39); heat[100] = 3.5;
  const stats = { 1: { heat, dist: 42, time: 30, top: 5.1, series: [{ t: 0, v: 1 }, { t: 0.2, v: null }], log: [{ t: 0, X: [3, 5] }, { t: 0.2, X: [3.1, 5.2] }] } };
  const shot = { t: 1.2, player: 1, kind: { type: 'drive' }, front: [2, 0, 1.5], bounce: { t: 1.9, X: [1, 8, 0], inferred: false }, speed: 31.234, apex: 2.1, tight: false, measured: true, quality: 4 };
  const M = toMatch({ source: 'camera', names: { 1: 'Coll', 2: '' }, duration: 30, stats, tctl: { 1: { controlShare: 0.6 } }, bounces: [{ t: 1.9, X: [1, 8, 0], plane: 'floor', player: 1 }], shots: [shot], flights: [fl(1, 1.4)], text: (s) => `${s.kind.type} by ${s.player}` });
  expect(M.players[0]).toMatchObject({ id: 1, distance: 42, topSpeed: 5.1, speed: [[0, 1], [0.2, null]] });
  expect(M.players[0].heatmap.seconds[100]).toBe(3.5);
  expect(M.bounces[0]).toMatchObject({ plane: 'floor', x: 1, y: 8, player: 1 });
  expect(M.shots[0]).toMatchObject({ text: 'drive by 1', bounce: [1, 8, 0], bounceT: 1.9, speed: 31.23 });
  const J = JSON.parse(JSON.stringify(M)), R = fromRecorded(J);
  expect(R.flights[0].pts[1]).toEqual({ t: 1.4, X: [1, 1, 1.2], V: [0, -18, 0] });
  expect([R.t0, R.t1]).toEqual([0, 1.4]);
  expect(playersAt(R.logs, 0.15)).toEqual([{ id: 1, X: [3.1, 5.2], seen: true }]);
  expect(playersAt(R.logs, 1.4)).toEqual([]); // not seen near then
});

test('rallies of a recording, with who hit how many', () => {
  const sh = (t, player, type = 'drive', q = 3) => ({ t, player, quality: q, kind: { type }, struck: { t: t - 0.4 }, bounceT: t + 0.8 });
  const M = { shots: [sh(10, 1), sh(11.5, 2), sh(13, 1, 'drop'), sh(13.5, null, 'drive', 1), sh(30, 2), sh(31.2, null, 'lob')],
    coach: { shots: [{ t: 31.2, hitter: 1 }] } };
  const R = rallyList(M);
  expect(R.map((r) => [r.n, r.shots, r.by[1], r.by[2]])).toEqual([[1, 3, 2, 1], [2, 2, 1, 1]]);
  expect(R[0]).toMatchObject({ t0: 9.6, t1: 13.8 });
  expect(R[1].last).toMatchObject({ hitter: 1, kind: { type: 'lob' } });
});

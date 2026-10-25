// bun test — coaching numbers (coaching.js): hitters by alternation, volleys, T at the opponent's
// hit, first bounces, on hand-built shots with known answers
import { test, expect, describe } from 'bun:test';
import { coachStats, rallies, hitFor, posAtFromLogs } from './coaching.js';
import { T_POINT } from './tcontrol.js';

// a ball struck from feet F towards the front wall, first fitted point 0.1 s later
const struckFrom = (F, t) => { const V = [0, -14, 2.5]; return { t: t + 0.1, X: [F[0], F[1] + V[1] * 0.1, 0.9 + V[2] * 0.1], V }; };
const shot = (o) => ({ kind: { type: 'drive' }, player: null, bounce: null, ...o });

describe('coaching', () => {
  test('hitFor carries the ball back to the player who struck it', () => {
    const s = struckFrom([2, 8], 1), h = hitFor(s, [2, 8]);
    expect(h.t).toBeGreaterThan(1.03); expect(h.t).toBeLessThan(1.1); expect(h.d).toBeLessThanOrEqual(0.8);
  });
  test('rallies split at long gaps', () => {
    const R = rallies([0, 1.2, 2.5, 7, 8.1].map((t) => ({ t })));
    expect(R.map((r) => r.length)).toEqual([3, 2]);
  });
  // a rally: P1 hits from the back right at t=0, P2 from the back left at 1.3, P1 again at 2.6;
  // P1 hit at 0 and 2.6 is near the T at 1.3, P2 is 2.5 m off it at P1's hits
  const p1 = [[0, [1.2, 8.5]], [1.3, [3.1, 5.6]], [2.6, [1.0, 8.3]]], p2 = [[0, [4.6, 7.4]], [1.3, [5.4, 8.6]], [2.6, [4.4, 7.6]]];
  const logs = { 1: [], 2: [] };
  for (let t = -0.2; t < 3.2; t += 0.1) for (const [id, P] of [[1, p1], [2, p2]]) { const q = P.reduce((a, b) => (Math.abs(b[0] - t) < Math.abs(a[0] - t) ? b : a)); logs[id].push({ t, X: q[1] }); }
  const posAt = posAtFromLogs(logs);
  const shots = [
    // only the middle shot says who hit it (on its bounce); the rally fills in the others
    shot({ t: 0.5, struck: struckFrom(p1[0][1], 0), bounce: { t: 1.0, X: [5, 8, 0], inferred: false } }),
    // P2 takes P1's ball before its (carried) bounce at 1.5: a volley
    shot({ t: 1.8, struck: struckFrom(p2[1][1], 1.3), player: 2, bounce: { t: 2.3, X: [1.2, 9, 0], inferred: false } }),
    shot({ t: 3.1, struck: struckFrom(p1[2][1], 2.6), kind: { type: 'drop' }, bounce: { t: 3.6, X: [1, 1.5, 0], inferred: false } }),
  ];
  // P1's first shot would have landed at 1.5 (carried on), after P2's hit at 1.3: volleyed
  shots[0].bounce = { t: 1.5, X: [5, 8, 0], inferred: true };
  const C = coachStats(shots, posAt);
  test('hitters alternate through the rally from one known shot', () => {
    expect(C.shots.map((r) => r.hitter)).toEqual([1, 2, 1]);
  });
  test('a volley: hit before the previous shot came down', () => {
    expect(C.shots[1].volley).toBe(true);
    expect(C.players[2].volleys.n).toBe(1);
    expect(C.players[2].volleys.points[0].opp).toEqual([3.1, 5.6]); // P1 on the T when P2 volleyed
    expect(C.shots[2].volley).toBe(false); // P2's ball landed at 2.3, P1 hit it at 2.6
  });
  test('T at the opponent\'s hit', () => {
    // P1 at P2's hit (1.3): on the T; P2 at P1's hits: 2.5 m and more off it
    expect(C.players[1].tAtOppHit.n).toBe(1); expect(C.players[1].tAtOppHit.share).toBe(1);
    expect(C.players[2].tAtOppHit.n).toBe(2); expect(C.players[2].tAtOppHit.share).toBe(0);
    expect(C.players[2].tAtOppHit.medianDistance).toBeGreaterThan(1.5);
    expect(Math.hypot(3.1 - T_POINT[0], 5.6 - T_POINT[1])).toBeLessThan(1);
  });
  test('first bounces: a volleyed shot has none', () => {
    expect(C.shots[0].first).toBe(null); // volleyed by P2 before it landed
    expect(C.shots[2].first.X).toEqual([1, 1.5]);
    expect(C.players[1].firstBounces.byKind).toEqual({ drop: 1 });
    expect(C.players[1].firstBounces.zones.front).toBe(1);
  });
});

import { zoneOf, shotLabel, replyQuality, responsePatterns } from './coaching.js';
describe('response patterns', () => {
  test('zones: 1 front left (as the camera sees it), 12 back right', () => {
    expect(zoneOf([6, 0.5])).toBe(1); expect(zoneOf([3.2, 0.5])).toBe(2); expect(zoneOf([0.5, 0.5])).toBe(3);
    expect(zoneOf([6, 3])).toBe(4); expect(zoneOf([1, 6])).toBe(9); expect(zoneOf([5.5, 9])).toBe(10); expect(zoneOf([0.3, 9.5])).toBe(12);
  });
  test('labels and reply quality', () => {
    expect(shotLabel({ volley: true, kind: { type: 'drive', direction: 'crosscourt' } })).toBe('Volley Cross Drive');
    expect(shotLabel({ volley: false, kind: { type: 'boast' } })).toBe('Boast');
    expect(replyQuality({ volley: true, kind: { type: 'drive' }, hit: { X: [5.5, 9] } })).toBe('high');
    expect(replyQuality({ volley: false, kind: { type: 'drop' }, hit: { X: [3, 4] } })).toBe('high');
    expect(replyQuality({ volley: false, kind: { type: 'drive' }, hit: { X: [5.5, 9] } })).toBe('low');
    expect(replyQuality({ volley: false, kind: { type: 'drive' }, hit: { X: [3.2, 8.5] } })).toBe('medium');
  });
  test('replies counted per zone, by the striker\'s shot type, within a rally only', () => {
    const r = (t, rally, hitter, type, X, volley = false) => ({ t, rally, hitter, kind: { type }, hit: X ? { X } : null, volley });
    const rows = [r(0, 0, 1, 'drive', [1, 9]), r(1, 0, 2, 'drive', [5.5, 9]), r(2, 0, 1, 'drop', [3, 3]), r(3, 0, 2, 'drop', [5.8, 1], false),
      r(4, 0, 1, 'drive', [1, 8]), r(9, 1, 2, 'lob', [5, 9])]; // the last reply is another rally
    const all = responsePatterns(rows, 1);
    expect(all.of).toBe(3); expect(all.n).toBe(2);
    expect(all.zones[9].n).toBe(1); expect(all.zones[9].shots).toEqual({ Drive: 1 }); expect(all.zones[0].shots).toEqual({ Drop: 1 });
    expect(all.quality).toEqual({ high: 1, medium: 0, low: 1 }); // a drop from the front (high), a drive from the back corner (low)
    const drops = responsePatterns(rows, 1, 'drop');
    expect(drops.n).toBe(1); expect(drops.zones[0].share).toBe(1);
  });
});

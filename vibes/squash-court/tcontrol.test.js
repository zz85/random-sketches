// bun test — T domination (tcontrol.js)
import { test, expect, describe } from 'bun:test';
import { TControl, T_POINT, tLabel } from './tcontrol.js';

describe('T domination', () => {
  const at = (dx, dy) => [T_POINT[0] + dx, T_POINT[1] + dy];
  test('the player nearer the T gets the control time; the shares add to 1', () => {
    const c = new TControl();
    // 10 s at 5 detections a second each: P1 on the T for the first 6 s, then P2
    for (let i = 0; i < 50; i++) { const t = i * 0.2, p1T = t < 6; c.add(1, t, p1T ? at(0.2, 0.3) : at(-1.5, 3)); c.add(2, t + 0.01, p1T ? at(1, 2.5) : at(0, 0.5)); }
    const a = c.summary(1), b = c.summary(2);
    expect(a.controlShare + b.controlShare).toBeCloseTo(1, 6);
    expect(a.controlShare).toBeGreaterThan(0.55); expect(a.controlShare).toBeLessThan(0.65);
    expect(a.zoneShare).toBeGreaterThan(0.55); expect(b.zoneShare).toBeGreaterThan(0.35);
    expect(tLabel(a)).toMatch(/^T \d+%$/);
  });
  test('time alone does not count as control; gaps are capped; a seek restarts', () => {
    const c = new TControl();
    for (let i = 0; i < 20; i++) c.add(1, i * 0.2, at(0, 0)); // only P1 seen
    expect(c.summary(1).controlShare).toBe(null);
    expect(c.summary(1).zoneSeconds).toBeCloseTo(3.8, 6);
    c.add(1, 30, at(0, 0)); expect(c.summary(1).seconds).toBeCloseTo(4.3, 6); // a 26 s gap counts 0.5 s
    c.add(1, 1, at(0, 0)); expect(c.summary(1).seconds).toBeCloseTo(4.3, 6); // back in time: nothing added
  });
  test('round trip through summaries', () => {
    const c = new TControl();
    for (let i = 0; i < 30; i++) { c.add(1, i * 0.2, at(0.1, 0)); c.add(2, i * 0.2 + 0.02, at(2, 2)); }
    const r = TControl.fromSummaries({ 1: c.summary(1), 2: c.summary(2) });
    expect(r.summary(1).controlShare).toBeCloseTo(c.summary(1).controlShare, 6);
    expect(r.summary(2).meanDistance).toBeCloseTo(c.summary(2).meanDistance, 6);
  });
});

// bun test: physics and track geometry without a browser
import { test, expect } from 'bun:test';
import { buildTrack, serialize, deserialize, strokeFrames } from './track.js';
import * as S from './sim.js';
import { makeDemo } from './demo.js';

const flatStroke = (extra = {}) => ({ type: 0, mode: 'wall', pts: [[-50, 0, 0], [50, 0, 0]], flip: false, bank: false, w: 2.4, ...extra });
const run = (track, flag, frames) => { const st = S.spawn(flag); for (let f = 0; f < frames; f++) S.step(st, track); return st; };

test('rider coasts on a flat line without losing speed', () => {
  const st = run(buildTrack([flatStroke()]), { p: [0, 0, 0], dir: [1, 0, 0], v: 5 }, 240);
  expect(st.crashed).toBe(false);
  expect(S.speed(st)).toBeCloseTo(5, 1);
  expect(Math.abs(S.sledFrame(st).c[1])).toBeLessThan(0.05);
});

test('small drops are survived, big ones throw the rider off', () => {
  const tr = buildTrack([flatStroke()]);
  expect(run(tr, { p: [0, 2, 0], dir: [1, 0, 0], v: 5 }, 180).crashed).toBe(false);
  expect(run(tr, { p: [0, 6, 0], dir: [1, 0, 0], v: 5 }, 180).crashed).toBe(true);
});

test('lines are one-sided: a flipped line lets the rider fall through', () => {
  const st = run(buildTrack([flatStroke({ flip: true })]), { p: [0, 1, 0], dir: [1, 0, 0], v: 0 }, 60);
  expect(S.point(st, 0)[1]).toBeLessThan(-3);
});

test('drawing direction sets the riding side like Line Rider', () => {
  const ltr = strokeFrames({ type: 0, mode: 'wall', pts: [[0, 0, 0], [1, 0, 0]], hints: [[0, 0, 1], [0, 0, 1]] });
  const rtl = strokeFrames({ type: 0, mode: 'wall', pts: [[1, 0, 0], [0, 0, 0]], hints: [[0, 0, 1], [0, 0, 1]] });
  expect(ltr.N[0][1]).toBeCloseTo(1);
  expect(rtl.N[0][1]).toBeCloseTo(-1);
  const floor = strokeFrames({ type: 0, mode: 'floor', pts: [[1, 0, 0], [0, 0, 0]] });
  expect(floor.N[0][1]).toBeCloseTo(1);
});

test('accelerate lines push the way they were drawn', () => {
  const st = run(buildTrack([flatStroke({ type: 1 })]), { p: [0, 0, 0], dir: [1, 0, 0], v: 2 }, 60);
  expect(S.speed(st)).toBeGreaterThan(8);
  const back = run(buildTrack([flatStroke({ type: 1, pts: [[50, 0, 0], [-50, 0, 0]], flip: true })]), { p: [0, 0, 0], dir: [1, 0, 0], v: 2 }, 60);
  expect(S.velocity(back, 0)[0]).toBeGreaterThan(8);
});

test('banking keeps a fast rider in a tight top-down turn; flat it flies off', () => {
  const pts = [];
  for (let i = 0; i <= 40; i++) pts.push([-20 + i * 0.5, 0, 0]);
  for (let i = 1; i <= 20; i++) { const a = (i / 20) * Math.PI / 2; pts.push([5 * Math.sin(a), 0, 5 - 5 * Math.cos(a)]); }
  for (let i = 1; i <= 40; i++) pts.push([5, 0, 5 + i * 0.5]);
  const v = 14, at = (bank) => S.sledFrame(run(buildTrack([{ type: 0, mode: 'floor', pts, bank, w: 2.4 }], { yRef: v * v / 32 / 0.8 }), { p: [-15, 0, 0], dir: [1, 0, 0], v }, 150)).c;
  const banked = at(true), flat = at(false);
  expect(Math.abs(banked[0] - 5)).toBeLessThan(1);
  expect(banked[2]).toBeGreaterThan(10);
  expect(flat[1]).toBeLessThan(-3);
});

test('the demo track is ridden end to end without a crash', () => {
  const { strokes, flag } = makeDemo();
  const tr = buildTrack(strokes, { yRef: flag.p[1] + flag.v ** 2 / 32 });
  const st = S.spawn(flag);
  let minX = Infinity, maxZ = -Infinity, looped = false;
  for (let f = 0; f < 60 * 25; f++) {
    S.step(st, tr);
    const c = S.sledFrame(st).c;
    minX = Math.min(minX, c[0]); maxZ = Math.max(maxZ, c[2]);
    if (c[1] > 9 && Math.abs(c[0]) < 2) looped = true;   // top of the corkscrew
  }
  expect(st.crashed).toBe(false);
  expect(looped).toBe(true);
  expect(maxZ).toBeGreaterThan(60);   // through the banked turn
  expect(minX).toBeLessThan(-100);    // out to the finish
});

test('runs are deterministic', () => {
  const { strokes, flag } = makeDemo();
  const tr = buildTrack(strokes, { yRef: flag.p[1] + flag.v ** 2 / 32 });
  const a = run(tr, flag, 600), b = run(tr, flag, 600);
  expect([...a.pos]).toEqual([...b.pos]);
});

test('tracks survive a save / load round trip', () => {
  const { strokes, flag } = makeDemo();
  const o = deserialize(serialize(strokes, flag));
  expect(o.strokes.length).toBe(strokes.length);
  expect(o.strokes[7].mode).toBe('floor');
  expect(o.strokes[7].bank).toBe(true);
  expect(o.flag.p[1]).toBeCloseTo(flag.p[1], 2);
  expect(() => deserialize('{"nope":1}')).toThrow();
});

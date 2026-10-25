// bun test — SquashAI label parsing and the geometry helpers behind tools/pbox_eval.mjs
import { test, expect } from 'bun:test';
import { readCsv, fromSquashAI, TBOX_WORLD, homography, applyH, iou, greedyMatch } from './squashai.js';
import { Camera } from '../camera.js';

test('csv rows keyed by file, numbers parsed, blanks null', () => {
  const r = readCsv('filename;p1.x;p1.name\nmedia/images/a-1.jpg;1.5;Hosny\nmedia/images/a-2.jpg;;\n');
  expect(r['media/images/a-1.jpg']).toEqual({ 'p1.x': 1.5, 'p1.name': 'Hosny' });
  expect(r['media/images/a-2.jpg']['p1.x']).toBe(null);
});
test('SquashAI floor frame to ours: centre, front-right corner', () => {
  expect(fromSquashAI([0, 0])).toEqual([3.2, 4.875]);
  expect(fromSquashAI([3.2, 4.875])).toEqual([0, 0]); // +x is our x = 0 wall, +y the front wall
});
test('the T-box homography recovers floor points from a camera', () => {
  const cam = Camera.fromLookAt([3.2, 13, 5], [3.2, 4, 0], 0, 1100, 1280, 720);
  const img = TBOX_WORLD.map(([x, y]) => cam.project([x, y, 0]).slice(0, 2)), H = homography(img, TBOX_WORLD);
  const u = cam.project([2.1, 8.3, 0]), X = applyH(H, u);
  expect(X[0]).toBeCloseTo(2.1, 6); expect(X[1]).toBeCloseTo(8.3, 6);
});
test('iou and one-to-one matching', () => {
  expect(iou([0, 0, 10, 10], [5, 0, 15, 10])).toBeCloseTo(1 / 3, 9);
  expect(iou([0, 0, 1, 1], [2, 2, 3, 3])).toBe(0);
  const m = greedyMatch([0, 10], [9, 1], (a, b) => -Math.abs(a - b), -2);
  expect(m.map(([i, j]) => [i, j]).sort()).toEqual([[0, 1], [1, 0]]);
});

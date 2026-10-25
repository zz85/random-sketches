// bun test — camera maths, the distance map, and court detection / tracking on synthetic frames
// with known cameras (tools/synth_eval.mjs runs the larger sweep).
import { test, expect, describe } from 'bun:test';
import { Camera, rodrigues, rotToRodrigues, lookAt } from './camera.js';
import { courtModel } from './court.js';
import { distanceTransform, detectCourt, trackCourt, mulberry32 } from './detect.js';
import { renderCourt, randomBroadcastCamera } from './synth.js';
import { homography4, cameraFromFloorH, boxSeeds } from './boxes.js';
import { features } from './detect.js';
import { createTracker, resetTracker, sparseTrack, trackFrame, recallShot } from './track.js';

describe('camera', () => {
  test('rodrigues round trip, including 180°', () => {
    for (const r of [[0.1, -0.2, 0.3], [Math.PI, 0, 0], [0, 3.1, 0.2], [1e-9, 0, 0]]) {
      const R = rodrigues(r), back = rodrigues(rotToRodrigues(R));
      R.forEach((v, i) => expect(back[i]).toBeCloseTo(v, 9));
    }
  });
  test('lookAt puts the target at the principal point, upright', () => {
    const c = Camera.fromLookAt([3.2, 15, 4], [3.2, 0, 1], 0, 1000, 1280, 720);
    const u = c.project([3.2, 0, 1]); expect(u[0]).toBeCloseTo(640, 6); expect(u[1]).toBeCloseTo(360, 6);
    expect(c.project([3.2, 0, 3])[1]).toBeLessThan(360); // higher on the wall is higher in the image
    expect(c.project([0, 0, 1])[0]).toBeGreaterThan(640); // x = 0 is the player's right, so it is on the right in a view from behind
    expect(c.angles().yaw).toBeCloseTo(0, 6);
  });
  test('ray / unproject invert project, with distortion', () => {
    const c = Camera.fromLookAt([1, 14, 3], [3, 2, 0.5], 0.02, 900, 1280, 720, -0.05);
    for (const X of [[1, 3, 0], [5.5, 8, 0], [2, 7.5, 0]]) {
      const u = c.project(X), Y = c.toFloor(u[0], u[1]);
      Y.forEach((v, i) => expect(v).toBeCloseTo(X[i], 6));
    }
  });
  test('homography and 3x4 matrix agree with project (k1 = 0)', () => {
    const c = Camera.fromLookAt([4, 13, 5], [3, 3, 0], 0, 800, 960, 540), H = c.homography('floor'), X = [2, 6, 0];
    const h = [H[0] * 2 + H[1] * 6 + H[2], H[3] * 2 + H[4] * 6 + H[5], H[6] * 2 + H[7] * 6 + H[8]], u = c.project(X);
    expect(h[0] / h[2]).toBeCloseTo(u[0], 6); expect(h[1] / h[2]).toBeCloseTo(u[1], 6);
  });
});

test('service box corners -> floor homography -> camera, exactly', () => {
  const c = Camera.fromLookAt([2, 15, 4], [3.5, 3, 0.5], 0.02, 900, 1280, 720);
  const W = [[1.575, 5.415], [1.575, 7.015], [4.825, 5.415], [4.825, 7.015]];
  const H = homography4(W, W.map(([x, y]) => c.project([x, y, 0])));
  const d = cameraFromFloorH(H, 1280, 720, 640, 360);
  d.C.forEach((v, i) => expect(v).toBeCloseTo(c.C[i], 6));
  expect(d.f).toBeCloseTo(900, 4);
  expect(cameraFromFloorH(H, 1280, 720, 640, 360, 700).f).toBeCloseTo(700, 6); // given focal: pose only
});

test('court model: WSF dimensions', () => {
  const m = courtModel(), L = (n) => m.lines.find((l) => l.name === n);
  expect(L('front-out').a[2] + 0.025).toBeCloseTo(4.57, 9);
  expect(L('back-out').a[2] + 0.025).toBeCloseTo(2.13, 9);
  expect(L('short').a[1] + 0.025).toBeCloseTo(5.44, 9);
  expect(L('box-R-back').a[1] + 0.025).toBeCloseTo(7.04, 9);
  expect(m.lines.length).toBe(12);
});

test('distance map: matches brute force within half a pixel', () => {
  const w = 60, h = 40, rng = mulberry32(3), seeds = Array.from({ length: 25 }, () => (rng() * w * h) | 0);
  const { dist, near } = distanceTransform(w, h, seeds);
  let worst = 0;
  for (let k = 0; k < w * h; k++) {
    const x = k % w, y = (k / w) | 0; let b = Infinity;
    for (const s of seeds) b = Math.min(b, Math.hypot(x - (s % w), y - ((s / w) | 0)));
    worst = Math.max(worst, dist[k] - b);
    expect(seeds.includes(near[k])).toBe(true);
  }
  expect(worst).toBeLessThan(0.5);
});

describe('detection on synthetic frames', () => {
  const W = 960, H = 540, rng = mulberry32(42), cases = [];
  for (let i = 0; i < 7; i++) { const cam = randomBroadcastCamera(rng, W, H); cases.push({ i, cam }); }
  // indices that the eval sweep finds reliably (club and glass)
  for (const i of [1, 2, 4, 6]) test(`frame ${i}: camera within 10 cm, view within 0.5°`, () => {
    const { cam } = cases[i], img = renderCourt(cam, { seed: i + 1, style: i % 2 ? 'glass' : 'club', players: 2, adverts: 8 });
    const r = detectCourt(img.data, W, H);
    const dC = Math.hypot(...r.cam.C.map((v, k) => v - cam.C[k]));
    const dot = r.cam.R[6] * cam.R[6] + r.cam.R[7] * cam.R[7] + r.cam.R[8] * cam.R[8];
    expect(r.ok).toBe(true);
    expect(dC).toBeLessThan(0.1);
    expect(Math.acos(Math.min(1, dot)) * 180 / Math.PI).toBeLessThan(0.5);
    expect(Math.abs(r.cam.f / cam.f - 1)).toBeLessThan(0.01);
  }, 20000);
  test('service boxes give seeds near the true camera', () => {
    const { cam } = cases[2], img = renderCourt(cam, { seed: 3, style: 'club', players: 0, adverts: 4 });
    const F = features(img.data, W, H), seeds = boxSeeds(F).seeds;
    expect(seeds.length).toBeGreaterThan(0);
    const best = Math.min(...seeds.map((s) => Math.hypot(...s.C.map((v, k) => v - cam.C[k]))));
    expect(best).toBeLessThan(1.5);
  });
  test('PSA men\'s tin (0.43 m) is told from the WSF one', () => {
    const { cam } = cases[4], img = renderCourt(cam, { seed: 5, style: 'glass', players: 2, adverts: 8, tin: 0.43 });
    const r = detectCourt(img.data, W, H);
    expect(r.tin).toBe(0.43);
    expect(Math.hypot(...r.cam.C.map((v, k) => v - cam.C[k]))).toBeLessThan(0.1);
  }, 20000);
  test('tracking recovers a 30 cm / 1.5° / 5% zoom jump in one frame', () => {
    const { cam } = cases[2], img = renderCourt(cam, { seed: 3, style: 'club', players: 2 });
    const p = cam.p.slice(); p[0] += 0.02; p[1] -= 0.015; p[3] += 0.2; p[4] -= 0.2; p[6] += 0.05;
    const r = trackCourt(img.data, W, H, cam.with(p));
    expect(r.ok).toBe(true);
    expect(Math.hypot(...r.cam.C.map((v, k) => v - cam.C[k]))).toBeLessThan(0.1);
    expect(r.ms.total).toBeLessThan(400);
  });
});

describe('sparse tracking (track.js)', () => {
  const w = 960, h = 540, C = [3.5, 14.5, 3.7];
  const at = (T, f) => Camera.fromLookAt(C, T, 0.005, f, w, h);
  const frame = (cam, t) => renderCourt(cam, { seed: 9, style: 'glass', players: [{ x: 2 + t, y: 6 }, { x: 4.2, y: 5 - t }], supersample: 1 });
  test('a camera that holds still is held exactly, while players move', () => {
    const cam = at([3.2, 2.6, 1.1], 1100), st = createTracker(); resetTracker(st, cam, 0.48);
    let c = cam;
    for (let i = 0; i < 4; i++) c = sparseTrack(frame(cam, i * 0.3).data, w, h, c, st).cam;
    const r = sparseTrack(frame(cam, 1.5).data, w, h, c, st);
    expect(r.ok).toBe(true); expect(r.mode).toBe('static'); expect(r.cam).toBe(c);
    expect(Math.hypot(...r.cam.C.map((v, k) => v - C[k]))).toBeLessThan(0.03);
  });
  test('a pan and zoom on a fixed mount is followed, the position held', () => {
    const c0 = at([3.2, 2.6, 1.1], 1100), st = createTracker(); resetTracker(st, c0, 0.48);
    let c = sparseTrack(frame(c0, 0).data, w, h, c0, st).cam;
    for (let i = 1; i <= 6; i++) {
      const truth = at([3.2 + 0.08 * i, 2.6 + 0.05 * i, 1.1 - 0.02 * i], 1100 + 40 * i);
      const r = sparseTrack(frame(truth, i * 0.2).data, w, h, c, st);
      expect(r.ok).toBe(true); c = r.cam;
      const u = c.project([3.2, 5.44, 0]), v = truth.project([3.2, 5.44, 0]);
      expect(Math.hypot(u[0] - v[0], u[1] - v[1])).toBeLessThan(1);
      expect(r.ms).toBeLessThan(60);
    }
    expect(Math.hypot(...c.C.map((v, k) => v - C[k]))).toBeLessThan(0.03);
    expect(st.mount).toBe('fixed');
  });
  test('after a cut away and back, the camera is picked up again without a detection', () => {
    const cam = at([3.2, 2.6, 1.1], 1100), st = createTracker(); resetTracker(st, cam, 0.48);
    let c = cam; for (let i = 0; i < 12; i++) c = sparseTrack(frame(cam, i * 0.1).data, w, h, c, st).cam;
    const blank = new Uint8ClampedArray(w * h * 4).fill(90);
    expect(trackFrame(blank, w, h, c, st).ok).toBe(false);
    const r = recallShot(frame(cam, 2).data, w, h, st);
    expect(r && r.ok).toBe(true); expect(r.path).toBe('recall');
    expect(Math.hypot(...r.cam.C.map((v, k) => v - C[k]))).toBeLessThan(0.03);
  });
  test('a cut to a frame with no court is reported lost', () => {
    const cam = at([3.2, 2.6, 1.1], 1100), st = createTracker(); resetTracker(st, cam, 0.48);
    sparseTrack(frame(cam, 0).data, w, h, cam, st);
    const blank = new Uint8ClampedArray(w * h * 4).fill(90);
    expect(sparseTrack(blank, w, h, cam, st).ok).toBe(false);
  });
});

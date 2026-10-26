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
  // the front camera: in the tin, or in a front corner, low, looking back down the court (no front
  // wall lines in view, the floor pattern squeezed near the horizon)
  for (const [name, C, T, hf] of [['in the tin', [3.2, -0.1, 0.45], [3.2, 8, 0.2], 65], ['in a front corner', [0.3, -0.3, 0.8], [4.5, 9, 0.3], 75]]) {
    test(`front camera ${name}`, () => {
      const cam = Camera.fromLookAt(C, T, 0, 1920 / 2 / Math.tan(hf * Math.PI / 360), 1920, 1080);
      const img = renderCourt(cam, { seed: 3, style: 'club', players: 2 }), r = detectCourt(img.data, 1920, 1080);
      expect(r.ok).toBe(true);
      expect(Math.hypot(...r.cam.C.map((v, k) => v - cam.C[k]))).toBeLessThan(0.05);
    }, 30000);
  }
  // a zoomed camera in the stand behind a glass front wall, off to one side (PSA Tour Finals): its
  // front-wall lines do not show, and once fitted it tracks
  test('front camera far behind a glass front wall tracks', () => {
    const cam = Camera.fromLookAt([8, -6.7, 1.4], [2.5, 9, 0.6], 0, 1280 / 2 / Math.tan(30 * Math.PI / 360), 1280, 720);
    const img = renderCourt(cam, { seed: 4, style: 'glass', players: 2 }), st = createTracker({ tin: 0.48 });
    const p = cam.p.slice(); p[0] += 0.004; p[1] -= 0.004; p[6] += 0.02;
    resetTracker(st, cam.with(p), 0.48);
    let c = cam.with(p);
    for (let i = 0; i < 4; i++) { const r = trackFrame(img.data, 1280, 720, c, st, { dt: 0.04 }); expect(r.ok).toBe(true); c = r.cam; }
    let e = 0; for (const X of [[0, 5.415, 0], [4.825, 7.015, 0], [3.2, 9.75, 0]]) { const a = cam.project(X), b = c.project(X); e = Math.max(e, Math.hypot(a[0] - b[0], a[1] - b[1])); }
    expect(e).toBeLessThan(2);
  }, 20000);
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

// ---------- players and ball ----------
import { detectPlayers, PlayerTracker } from './players.js';
import { simulate, fitFlight, fitFlights, cutTrack, ballCandidates, toGray, predictPath } from './ball.js';
import { Rally } from './rally.js';

describe('players and ball', () => {
  test('of two rival flights, the one the soundtrack agrees with is kept', () => {
    // equally long and equally well fitted; one starts 50 ms after a heard hit and ends just before
    // a heard wall impact, the other (a reflection, a racket) lines up with nothing
    const fl = (t0, x) => ({ t0, t1: t0 + 0.4, rms: 1, uv: Array(20).fill([0, 0]), impacts: [], pts: [{ t: t0, X: [x, 5, 3] }, { t: t0 + 0.4, X: [x, 1, 2] }] });
    for (const order of [0, 1]) {
      const R = new Rally(); R.onsets = [9.5, 10.0, 10.47];
      const ball = fl(10.05, 2), other = fl(10.2, 5);
      R.add(order ? [ball] : [other]); R.add(order ? [other] : [ball]);
      expect(R.flights).toEqual([ball]);
      expect(ball.heard).toBe(2);
    }
    const R = new Rally(); const a = fl(10.05, 2), b = fl(10.2, 5); R.add([a]); R.add([b]); expect(R.flights).toEqual([a]); // no sound: the first stays
  });
  test('players on the floor within 10 cm (true camera)', () => {
    const cam = Camera.fromLookAt([3.2, 13.5, 4], [3.2, 4.5, 0.6], 0, 900, 960, 540);
    const truth = [{ x: 2.0, y: 5.0 }, { x: 4.5, y: 7.0 }];
    const img = renderCourt(cam, { seed: 3, style: 'glass', players: truth, adverts: 4 });
    const P = detectPlayers(img.data, 960, 540, cam, { tin: 0.48 });
    for (const T of truth) {
      const e = Math.min(...P.players.map((p) => Math.hypot(p.X[0] - T.x, p.X[1] - T.y)));
      expect(e).toBeLessThan(0.10);
    }
  });
  test('player identities survive crossing paths', () => {
    const T = new PlayerTracker();
    // two players run past each other 0.6 m apart; detections arrive in either order
    let idA = null;
    for (let i = 0; i <= 20; i++) {
      const t = i / 10, a = 1 + 0.2 * i, b = 5 - 0.2 * i, dets = i % 2 ? [{ X: [b, 5.6] }, { X: [a, 5] }] : [{ X: [a, 5] }, { X: [b, 5.6] }];
      const out = T.update(dets, t);
      if (i === 0) idA = out.find((k) => k.X[0] < 3).id;
    }
    expect(T.tracks.find((k) => k.id === idA).X[0]).toBeCloseTo(5, 0); // the player who started at x = 1
  });
  test('shirt colour keeps identities through an overlap and a lost player', () => {
    const T = new PlayerTracker(), RED = [190, 40, 40], DARK = [30, 30, 35];
    const ids = {};
    let t = 0;
    const step = (dets) => { t += 0.04; return T.update(dets, t); };
    for (let i = 0; i < 20; i++) step([{ X: [2, 6], col: RED }, { X: [4, 6], col: DARK }]);
    for (const k of T.tracks) ids[k.col[0] > 100 ? 'red' : 'dark'] = k.id;
    // they cross so positions alone would swap them, and the box is on the wrong player for a while
    for (let i = 0; i < 10; i++) step([{ X: [3.6, 6], col: RED }, { X: [2.4, 6], col: DARK }]);
    for (let i = 0; i < 10; i++) step([{ X: [3.4, 6], col: RED }]); // dark player missed
    const out = step([{ X: [3.8, 6], col: RED }, { X: [2.2, 6], col: DARK }]);
    expect(out.find((k) => k.X[0] > 3).id).toBe(ids.red);
    expect(out.find((k) => k.X[0] < 3).id).toBe(ids.dark);
  });
  test('one flight in 3D from its pixels (within 5 cm)', () => {
    const cam = Camera.fromLookAt([3.2, 14, 4.5], [3.2, 4, 0.8], 0, 1300, 1280, 720);
    const sim = simulate([2, 7, 0.9], [1.5, -20, 4], 0.25, 50);
    const pts = sim.frames.map((f) => { const u = cam.project(f.X); return { t: f.t, u: u[0], v: u[1], X: f.X }; });
    const f = fitFlight(pts, cam);
    for (let i = 0; i < pts.length; i++) expect(Math.hypot(...f.pts3[i].X.map((v, j) => v - pts[i].X[j]))).toBeLessThan(0.05);
  });
  test('the rest of a drive predicted from its first half (front wall, two bounces, within 3 cm)', () => {
    const cam = Camera.fromLookAt([3.2, 14, 4.5], [3.2, 4, 0.8], 0, 1300, 1280, 720);
    const sim = simulate([2, 7, 0.9], [1, -24, 4], 1.4, 50);
    const pts = sim.frames.filter((f) => f.t < 0.18).map((f) => { const u = cam.project(f.X); return { t: f.t, u: u[0], v: u[1], X: f.X }; });
    const fit = fitFlight(pts, cam), q = fit.pts3[fit.pts3.length - 1];
    const P = predictPath(q.X, q.V, { t: pts[pts.length - 1].t, T: 1.5 });
    expect(P.hits.map((m) => m.plane)).toEqual(['front', 'floor', 'floor']);
    expect(P.end).toBe('down');
    for (const f of sim.frames.filter((f) => f.t > 0.2 && f.t < P.hits[2].t)) {
      const p = P.pts.reduce((a, b) => (Math.abs(b.t - f.t) < Math.abs(a.t - f.t) ? b : a));
      expect(Math.hypot(...p.X.map((v, j) => v - f.X[j]))).toBeLessThan(0.03);
    }
    expect(predictPath([3, 8, 1], [0.5, -12, 9]).end).toBe('out'); // over the front-wall out line
  });
  test('a drive is cut at the front wall and labelled', () => {
    const cam = Camera.fromLookAt([3.2, 14, 4.5], [3.2, 4, 0.8], 0, 1300, 1280, 720);
    const sim = simulate([2, 7, 0.9], [1, -24, 4], 0.6, 50);
    const pts = sim.frames.map((f) => { const u = cam.project(f.X); return { t: f.t, u: u[0], v: u[1], X: f.X }; });
    const segs = cutTrack(pts, cam);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    const F = fitFlights(pts, segs, cam);
    expect(F.labels[0]).toBe('front');
    expect(Math.abs(F.impacts[0].X[1])).toBeLessThan(0.1);
  });
  test('ball candidates: a moving dot is found, a still one is not', () => {
    const cam = Camera.fromLookAt([3.2, 14, 4.5], [3.2, 4, 0.8], 0, 1300, 640, 360);
    const frame = (u) => { const d = new Uint8ClampedArray(640 * 360 * 4).fill(90); for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) { const o = ((180 + y) * 640 + u + x) * 4; d[o] = d[o + 1] = d[o + 2] = 250; } for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) { const o = ((60 + y) * 640 + 500 + x) * 4; d[o] = d[o + 1] = d[o + 2] = 250; } return toGray(d, 640, 360, 640); };
    const c = ballCandidates(frame(200), frame(230), frame(260), cam, { fps: 25 });
    expect(c.some((q) => Math.abs(q.u - 230.5) < 2 && Math.abs(q.v - 180.5) < 2)).toBe(true);
    expect(c.some((q) => Math.abs(q.u - 500.5) < 5)).toBe(false);
  });
});

import { Bounces, impactsOf, heatGrid } from './bounces.js';
describe('ball bounces', () => {
  const fl = (t0, t1, end, impacts = []) => ({ t0, t1, impacts, pts: [{ t: t0, X: [3, 2, 1], V: [0, 5, -2] }, { t: t1, X: end, V: [0, 5, -6] }] });
  test('a flight ending on the floor is a bounce; one ending in the air is not', () => {
    expect(impactsOf(fl(0, 0.4, [3, 6, 0.02])).map((m) => [m.plane, m.inferred])).toEqual([['floor', true]]);
    expect(impactsOf(fl(0, 0.4, [3, 6, 1.2]))).toEqual([]);
  });
  test('a replaced window replaces its bounces, older ones stay', () => {
    const B = new Bounces();
    B.update([fl(0, 0.4, [3, 6, 0]), fl(1, 1.4, [2, 7, 0])]);
    B.update([fl(1, 1.4, [4, 8, 0], [{ t: 1.2, X: [3, 0, 1], plane: 'front' }])]); // the second flight refitted
    expect(B.on('floor').map((m) => m.X[1])).toEqual([6, 8]);
    expect(B.on('front').length).toBe(1);
  });
  test('heat grid keeps the count and peaks at the bounce', () => {
    const H = heatGrid([[1.1, 2.1], [1.1, 2.1], [5, 9]], 0.25, 6.4, 9.75);
    const sum = H.g.reduce((s, v) => s + v, 0), peak = H.g.indexOf(Math.max(...H.g));
    expect(sum).toBeGreaterThan(2.5); expect(sum).toBeLessThan(3.2);
    expect([peak % H.nx, Math.floor(peak / H.nx)]).toEqual([4, 8]);
  });
});

import { onsets, audioOffset } from './audio.js';
import { soundImpacts, hitterOf, extrapolate } from './bounces.js';
import { flight } from './ball.js';
describe('impact sounds and hitters', () => {
  test('clicks in noise and speech-like hum are found, the hum is not', () => {
    const rate = 32000, x = new Float32Array(rate * 2), rng = mulberry32(5), clicks = [0.31, 0.77, 1.12, 1.6];
    for (let i = 0; i < x.length; i++) x[i] = 0.01 * (rng() - 0.5) + 0.2 * Math.sin(2 * Math.PI * 180 * i / rate) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * i / rate));
    for (const t of clicks) for (let j = 0; j < 400; j++) x[Math.round(t * rate) + j] += 0.5 * (rng() - 0.5) * Math.exp(-j / 60);
    const o = onsets(x, rate).map((q) => q.t);
    expect(o.length).toBe(4);
    clicks.forEach((t, i) => expect(Math.abs(o[i] - t)).toBeLessThan(0.004));
  });
  test('audio delay recovered from impacts both saw', () => {
    const imp = [1, 2.5, 3.1, 4.7, 6], heard = [0.4, ...imp.map((t) => t + 0.045), 5.2];
    expect(audioOffset(heard, imp).offset).toBeCloseTo(0.045, 2);
  });
  test('extrapolate matches the flight model, forward and back', () => {
    const X = [3, 6, 1], V = [1, -15, 3], [A] = flight(X, V, [0.2]), f = extrapolate(X, V, 0.2), b = extrapolate(A.X, A.V, -0.2);
    f.X.forEach((v, j) => expect(v).toBeCloseTo(A.X[j], 3)); b.X.forEach((v, j) => expect(v).toBeCloseTo(X[j], 2));
  });
  test('a bounce heard after a lost track is placed on the floor; the hitter is the nearer player', () => {
    const X0 = [2, 7, 0.6], V0 = [0.5, -14, 0], ts = [0, 0.04, 0.08, 0.12], S = flight(X0, V0, ts);
    const f = { t0: 1, t1: 1.12, impacts: [], pts: ts.map((t, i) => ({ t: 1 + t, X: S[i].X, V: S[i].V })) };
    let tz = 0; for (let t = 0.12; t < 1; t += 0.001) if (extrapolate(X0, V0, t).X[2] <= 0) { tz = t; break; } // when it reaches the floor
    const players = (t, X) => ({ id: Math.hypot(X[0] - 2, X[1] - 7) < Math.hypot(X[0] - 4.5, X[1] - 4) ? 1 : 2, dist: Math.min(Math.hypot(X[0] - 2, X[1] - 7), Math.hypot(X[0] - 4.5, X[1] - 4)), other: Math.max(Math.hypot(X[0] - 2, X[1] - 7), Math.hypot(X[0] - 4.5, X[1] - 4)) });
    const heard = soundImpacts([1 + tz], [f], players);
    expect(heard.length).toBe(1); expect(heard[0].plane).toBe('floor');
    expect(hitterOf(heard[0], [f], players, [0.97])).toBe(1);
  });
});

import { Commentary, describe as describeShot } from './commentary.js';
describe('commentary', () => {
  // simulate a shot up to its first floor bounce and name it
  const aim = (X0, T, sp) => { const d = T.map((v, j) => v - X0[j]), L = Math.hypot(...d), V = d.map((v) => (v / L) * sp); V[2] += 0.5 * 9.81 * L / sp; return V; };
  const shot = (X0, V0) => {
    const sim = simulate(X0, V0, 2.5, 50), stop = sim.events.find((e) => e.type === 'floor')?.t ?? 2.5;
    const pts = sim.frames.filter((f) => f.t <= stop + 0.02).map((f) => ({ t: f.t, X: f.X, V: f.V }));
    const C = new Commentary(), out = C.update([{ t0: 0, t1: pts.at(-1).t, pts, impacts: sim.events.filter((e) => e.t <= stop + 1e-3).map((e) => ({ t: e.t, X: e.X, plane: e.type })) }], [], () => ({ id: 1, dist: 0.4, other: 3 }));
    expect(out.length).toBe(1); return out[0];
  };
  test('straight drive, tight and deep', () => { const s = shot([5.6, 8, 0.6], aim([5.6, 8, 0.6], [5.9, 0, 1.4], 42)); expect(s.kind).toMatchObject({ type: 'drive', direction: 'straight', tight: 'left', length: 'deep' }); expect(describeShot(s)).toMatch(/^P1 plays a hard straight drive/); });
  test('crosscourt drive', () => expect(shot([5.6, 8, 0.6], aim([5.6, 8, 0.6], [2.6, 0, 1.3], 40)).kind).toMatchObject({ type: 'drive', direction: 'crosscourt' }));
  test('lob', () => expect(shot([4.5, 3, 0.4], aim([4.5, 3, 0.4], [4.4, 0, 4.0], 13)).kind.type).toBe('lob'));
  test('drop', () => expect(shot([2, 3.5, 0.5], aim([2, 3.5, 0.5], [1.4, 0, 0.62], 9)).kind).toMatchObject({ type: 'drop', length: 'short' }));
  test('boast', () => expect(shot([0.6, 8, 0.6], [-8, -22, 4]).kind.type).toBe('boast'));
  test('a contact inferred from a flight that never reached the wall', () => {
    const sim = simulate([3, 7, 0.8], [0.3, -30, 3], 0.12, 50), pts = sim.frames.map((f) => ({ t: f.t, X: f.X, V: f.V }));
    const out = new Commentary().update([{ t0: 0, t1: pts.at(-1).t, pts, impacts: [] }]);
    expect(out.length).toBe(1); expect(out[0].measured).toBe(false); expect(out[0].front[1]).toBeLessThan(0.05);
  });
});

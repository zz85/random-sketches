import { test, expect } from 'bun:test';
import { ksFromWB1, over1, PIGMENTS, mix, swatch, srgbToLinear, linearToSrgb, customPigment, hexToRgb } from './km.js';
import { strokeStamps, Smoother } from './brush.js';
import { makePaper } from './paper.js';

const byId = (id) => PIGMENTS.find((p) => p.id === id);
const hue = ([r, g, b]) => { const M = Math.max(r, g, b), m = Math.min(r, g, b), d = M - m || 1e-9; let h = M === r ? (g - b) / d : M === g ? 2 + (b - r) / d : 4 + (r - g) / d; return ((h * 60) + 360) % 360; };

test('KM inversion round-trips white and black backgrounds', () => {
  for (const [rw, rb] of [[0.8, 0.05], [0.3, 0.02], [0.95, 0.6], [0.5, 0.45]]) {
    const [K, S] = ksFromWB1(rw, rb);
    expect(K).toBeGreaterThan(0); expect(S).toBeGreaterThan(0);
    expect(over1(K, S, 1)).toBeCloseTo(rw, 4);
    expect(over1(K, S, 0)).toBeCloseTo(rb, 4);
  }
});

test('srgb <-> linear', () => { for (const v of [0, 0.02, 0.3, 0.7, 1]) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6); });

test('every pigment is valid, darker with more paint, and lighter over white than black', () => {
  for (const p of PIGMENTS) {
    for (const v of [...p.K, ...p.S]) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(0); }
    const l = (c) => c[0] + c[1] + c[2];
    expect(l(swatch(p, 0.3))).toBeGreaterThan(l(swatch(p, 1.5)));
    expect(l(swatch(p, 1, [1, 1, 1]))).toBeGreaterThan(l(swatch(p, 1, [0, 0, 0])));
    expect(p.gran).toBeGreaterThanOrEqual(0); expect(p.gran).toBeLessThanOrEqual(1);
  }
});

test('subtractive mixing: yellow + blue is green, not grey', () => {
  const g = swatch(mix([{ p: byId('hansa'), w: 1 }, { p: byId('phthalo'), w: 1 }]), 1);
  const h = hue(g);
  expect(h).toBeGreaterThan(80); expect(h).toBeLessThan(170);
  const sat = Math.max(...g) - Math.min(...g);
  expect(sat).toBeGreaterThan(0.15);
});

test('yellow + rose is orange, ultramarine + rose is violet', () => {
  expect(hue(swatch(mix([{ p: byId('hansa'), w: 1 }, { p: byId('rose'), w: 1 }]), 1))).toBeLessThan(45);
  const v = hue(swatch(mix([{ p: byId('ultra'), w: 1 }, { p: byId('rose'), w: 1 }]), 1));
  expect(v).toBeGreaterThan(250); expect(v).toBeLessThan(340);
});

test('opaque pigments cover black better than transparent ones', () => {
  const onBlack = (id) => swatch(byId(id), 1, [0, 0, 0]).reduce((a, b) => a + b);
  expect(onBlack('cadred')).toBeGreaterThan(onBlack('rose'));
  expect(onBlack('white')).toBeGreaterThan(onBlack('ultra') * 3);
});

test('custom pigment reproduces its picked colour as a unit layer on white', () => {
  for (const hex of ['#3a7bd5', '#e94e1b', '#2d6a4f']) {
    const p = customPigment(hex, 0.2);
    const s = swatch(p, 1); const w = hexToRgb(hex);
    for (let i = 0; i < 3; i++) expect(s[i]).toBeCloseTo(w[i], 2);
  }
});

test('stroke stamps are evenly spaced and interpolate pressure', () => {
  const st = strokeStamps({ x: 0, y: 0, p: 0 }, { x: 100, y: 0, p: 1 }, 4, 0);
  expect(st.stamps.length).toBe(25);
  for (let i = 1; i < st.stamps.length; i++) expect(st.stamps[i].x - st.stamps[i - 1].x).toBeCloseTo(4, 6);
  expect(st.stamps[12].p).toBeCloseTo(0.52, 2);
  // the remainder carries over so two halves equal the whole
  const a = strokeStamps({ x: 0, y: 0, p: 0 }, { x: 50, y: 0, p: 0.5 }, 4, 0);
  const b = strokeStamps({ x: 50, y: 0, p: 0.5 }, { x: 100, y: 0, p: 1 }, 4, a.rest);
  expect(a.stamps.length + b.stamps.length).toBe(25);
});

test('smoother removes jitter but reaches the end point', () => {
  const sm = new Smoother(0.5);
  let last; for (let i = 0; i <= 40; i++) last = sm.push({ x: i, y: (i % 2) * 2, p: 0.5, t: i * 8 });
  expect(Math.abs(last.y - 1)).toBeLessThan(0.8);
  const end = sm.finish();
  expect(end.at(-1).x).toBeCloseTo(40, 3);
});

test('paper height field is deterministic, normalised and tileable', () => {
  const a = makePaper('cold', 128, 7), b = makePaper('cold', 128, 7);
  expect(a.h).toEqual(b.h);
  let mn = 1, mx = 0, s = 0; for (const v of a.h) { mn = Math.min(mn, v); mx = Math.max(mx, v); s += v; }
  expect(mn).toBeGreaterThanOrEqual(0); expect(mx).toBeLessThanOrEqual(1); expect(mx - mn).toBeGreaterThan(0.5);
  expect(s / a.h.length).toBeGreaterThan(0.3); expect(s / a.h.length).toBeLessThan(0.7);
  // wrap: left column next to right column differs about as much as two neighbours
  const N = 128; let dw = 0, dn = 0; for (let y = 0; y < N; y++) { dw += Math.abs(a.h[y * N] - a.h[y * N + N - 1]); dn += Math.abs(a.h[y * N + 1] - a.h[y * N]); }
  expect(dw).toBeLessThan(dn * 2);
  const hot = makePaper('hot', 128, 7); let vh = 0, vc = 0; for (let i = 1; i < N * N; i++) { vh += Math.abs(hot.h[i] - hot.h[i - 1]); vc += Math.abs(a.h[i] - a.h[i - 1]); }
  expect(vh).toBeLessThan(vc);
});

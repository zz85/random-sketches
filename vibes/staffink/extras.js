// Templates for symbols HOMUS does not have: dynamics and tuplet numbers.
//
// Tuplet digits come from real handwriting: the numerators of HOMUS time signatures
// (digits.json, see train.js --digits). There is no public online-handwriting set of
// dynamics, so those are drawn here from letter skeletons of italic p, m, f, s, z with
// randomised slant, proportions, spacing and cursive joins, then matched with $P
// (which ignores stroke order and direction). They are a starting point: corrections
// from the alternatives strip become personal templates and win once you have made one.
import { makeUserTemplate, unpackStrokes } from './recognizer.js';

// letter skeletons: x-height 0.8 sp, baseline y = 0, y down; [advance, strokes]
const LETTER = {
  p: [0.78, [[[0.08, -0.8], [0.02, -0.3], [-0.04, 0.25], [-0.1, 0.72]], [[0.02, -0.52], [0.25, -0.84], [0.6, -0.72], [0.62, -0.28], [0.32, -0.04], [0.04, -0.18]]]],
  m: [0.98, [[[0, 0], [0.02, -0.76], [0.01, -0.5], [0.2, -0.8], [0.39, -0.7], [0.41, 0], [0.42, -0.5], [0.61, -0.8], [0.8, -0.7], [0.82, 0]]]],
  f: [0.58, [[[0.78, -1.45], [0.52, -1.68], [0.3, -1.42], [0.16, -0.4], [0.02, 0.45], [-0.22, 0.7], [-0.36, 0.52]], [[-0.08, -0.74], [0.52, -0.8]]]],
  s: [0.62, [[[0.5, -0.7], [0.3, -0.83], [0.08, -0.66], [0.26, -0.4], [0.46, -0.2], [0.3, 0.0], [0.02, -0.08]]]],
  z: [0.72, [[[0.02, -0.78], [0.56, -0.8], [0.03, 0.0], [0.62, -0.03]]]],
  3: [0.7, [[[0.02, -1.25], [0.45, -1.4], [0.62, -1.05], [0.28, -0.72], [0.66, -0.42], [0.55, -0.02], [0.02, -0.08]]]],
  6: [0.7, [[[0.58, -1.35], [0.15, -0.9], [0.02, -0.32], [0.3, 0.0], [0.6, -0.3], [0.42, -0.66], [0.06, -0.45]]]],
};

/** Catmull-Rom through control points, ~10 samples per segment. */
function spline(cp) {
  const out = [];
  for (let i = 0; i < cp.length - 1; i++) {
    const p0 = cp[Math.max(0, i - 1)], p1 = cp[i], p2 = cp[i + 1], p3 = cp[Math.min(cp.length - 1, i + 2)];
    for (let k = 0; k < 10; k++) {
      const t = k / 10, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({ x: f(p0[0], p1[0], p2[0], p3[0]), y: f(p0[1], p1[1], p2[1], p3[1]) });
    }
  }
  out.push({ x: cp[cp.length - 1][0], y: cp[cp.length - 1][1] });
  return out;
}

export function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

/**
 * Handwritten-looking ink for a word such as "mf" or "3", origin at (x, y) = left baseline.
 * o: {slant, scale, join (cursive), jitter}
 */
export function inkWord(word, x, y, r = rng(1), o = {}) {
  const slant = o.slant ?? 0.1 + r() * 0.3, scale = o.scale ?? 0.95 + r() * 0.5, jit = o.jitter ?? 0.05;
  const joinAll = o.join ?? r() < 0.3;
  const strokes = [];
  let cx = 0;
  for (const ch of word) {
    const [adv, sk] = LETTER[ch];
    const sx = 0.9 + r() * 0.25;
    sk.forEach((cp, si) => {
      const pts = spline(cp.map(([px, py]) => [cx + px * sx + (r() - 0.5) * jit, py + (r() - 0.5) * jit]));
      if (joinAll && si === 0 && strokes.length && ch !== 'f') strokes[strokes.length - 1].push(...pts);
      else strokes.push(pts);
    });
    cx += adv * sx + (r() - 0.3) * 0.12;
  }
  return strokes.map((s) => s.map((p) => ({ x: x + (p.x - slant * p.y) * scale, y: y + p.y * scale })));
}

export const DYN_WORDS = ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'sfz', 'fp'];

/** Built-in extra templates: synthetic dynamics (+ synthetic digits), plus HOMUS digits if given. */
export function buildExtraTemplates(digitsJson, perWord = 10) {
  const r = rng(2024), out = [];
  for (const w of DYN_WORDS) for (let i = 0; i < perWord; i++) out.push(makeUserTemplate('Dyn-' + w, inkWord(w, 0, 0, r)));
  for (const d of ['3', '6']) for (let i = 0; i < 4; i++) out.push(makeUserTemplate('Tuplet-' + d, inkWord(d, 0, 0, r)));
  for (const [label, packed] of (digitsJson && digitsJson.templates) || []) out.push(makeUserTemplate(label, unpackStrokes(packed)));
  return out;
}

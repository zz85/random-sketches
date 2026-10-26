// Pen annotations in exported pages (PNG and the transposed PDF), on the main thread and in the
// export workers alike: rebuild the page's music, make its photo surface for the page as it is
// being written (transposed staves stretch where a key signature got wider), and draw the marks
// the user chose. No DOM; takes any 2D context (OffscreenCanvas in a worker).
import { buildScore } from './score.js';
import { photoSurface } from './surface.js';
import { fromScoreShift } from '../notation-ir/adapters/scoreshift.js';
import { drawAnnotations, itemsOf } from '../notation-ir/annotations.js';

/**
 * Which annotations to export. opts = { include: true|false, colors: [hex] | null (all) }.
 * Returns the list to draw.
 */
export function chooseAnnotations(list, opts = {}) {
  if (!list?.length || opts.include === false) return [];
  const want = opts.colors && new Set(opts.colors.map((c) => c.toLowerCase()));
  return want ? list.filter((a) => want.has((a.color || '').toLowerCase())) : list;
}

/** The colours used on these pages, in order of first use. */
export const colorsOf = (lists) => [...new Set(lists.filter(Boolean).flat().map((a) => (a.color || '').toLowerCase()).filter(Boolean))];

/**
 * Draw annotations onto ctx, a page written by `renderer` (render.js Renderer, after render():
 * its scale r and per-staff warps). Returns the number of marks drawn.
 */
export function drawPageAnnotations(ctx, { model, renderer, plan = null, annotations, opts = {} }) {
  const list = chooseAnnotations(annotations, opts);
  if (!list.length) return 0;
  const score = buildScore(model), irc = fromScoreShift(model, score, { plan });
  const r = renderer.r, sp = (model.space || 16) * r;
  const warps = plan && renderer.warps;
  const warp = warps ? (line, x) => { const w = warps.get(model.staves[line]); return w ? w.warp(x) : x; } : null;
  const surf = photoSurface({ model, score, irc, warp, view: () => ({ X: (x) => x * r, Y: (y) => y * r, sp }) });
  drawAnnotations(ctx, surf, list, itemsOf(irc.score));
  return list.length;
}

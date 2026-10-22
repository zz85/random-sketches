// Layout layer (horizontal, one system for now): where each column of the interpreted
// music goes. A column is a moment that something starts at (all voices, all staves), or
// a barline. Every mode is the same problem: target positions + minimum gaps, solved
// exactly as a least-squares fit that never lets two columns collide.
//
//   engraved      targets from duration-based spacing (StaffInk's log spacing)
//   proportional  x = time * unit (contemporary / graphic notation, piano-roll alignment)
//   anchored      x stays as close as possible to where the input put it: the user's ink, or
//                 the printed note on a photographed page. Columns without a source position
//                 (derived rests, derived bars) are placed by engraved spacing between their
//                 anchored neighbours, with a low weight.
//
// Units are staff spaces. Widths are rough glyph boxes, enough to keep things apart.

import { cmp, sub, toFloat } from './rational.js';

export const spacing = (dt) => 1.2 + 1.9 * Math.log2(1 + 8 * dt); // dt in whole notes; eighth -> ~3.1

const pieceWidth = (p) => {
  if (p.kind === 'space') return 0;
  const accs = p.heads ? p.heads.filter((h) => h.show != null).length : 0;
  return 1.3 + (accs ? 1.1 : 0) + (p.dots ? 0.6 : 0);
};

/** Columns in time order; a bar sorts before the notes that start on it. */
export function columns(res) {
  const cols = new Map();
  const col = (t, bar) => {
    const k = `${t.n}/${t.d}${bar ? 'b' : ''}`;
    if (!cols.has(k)) cols.set(k, { t, kind: bar ? 'bar' : 'events', pieces: [], width: bar ? 1.4 : 0, anchors: [] });
    return cols.get(k);
  };
  for (const b of res.bars) { const c = col(b.at, true); c.bar = b; if (b.src?.x != null) c.anchors.push(b.src.x); }
  for (const [, ps] of res.voices) for (const p of ps) {
    const c = col(p.onset, false);
    c.pieces.push(p);
    c.width = Math.max(c.width, pieceWidth(p));
  }
  return [...cols.values()].sort((a, b) => cmp(a.t, b.t) || (a.kind === 'bar' ? -1 : 1));
}

/**
 * x per column. opts: { mode, unit (proportional, staff spaces per whole note),
 * anchorOf(piece) -> x | undefined (anchored; default piece's event src.x) , events }.
 */
export function layoutLine(res, score, opts = {}) {
  const { mode = 'engraved', unit = 24 } = opts;
  const byId = new Map(score.events.map((e) => [e.id, e]));
  const anchorOf = opts.anchorOf || ((p) => (p.cont ? undefined : byId.get(p.event)?.src?.x));
  const cols = columns(res);
  if (!cols.length) return { columns: [], width: 0 };
  if (mode === 'anchored') for (const c of cols) for (const p of c.pieces) { const x = anchorOf(p); if (x != null) c.anchors.push(x); }

  // minimum gap after each column; engraved ideal gap
  const gap = cols.map((c, i) => (i + 1 < cols.length ? Math.max(c.width, 0.3) : 0));
  const ideal = cols.map((c, i) => {
    if (i + 1 === cols.length) return 0;
    const n = cols[i + 1];
    if (c.kind === 'bar' || n.kind === 'bar') return Math.max(gap[i], 1.4);
    return Math.max(gap[i], spacing(toFloat(sub(n.t, c.t))));
  });
  const E = [0]; for (let i = 1; i < cols.length; i++) E.push(E[i - 1] + ideal[i - 1]);

  let target, weight;
  if (mode === 'proportional') { target = cols.map((c) => toFloat(c.t) * unit); weight = cols.map(() => 1); }
  else if (mode === 'anchored') {
    const a = cols.map((c) => (c.anchors.length ? c.anchors.reduce((s, x) => s + x, 0) / c.anchors.length : null));
    target = interpolate(a, E); weight = a.map((x) => (x == null ? 0.01 : 1));
  } else { target = E; weight = cols.map(() => 1); }

  const x = fitWithGaps(target, weight, gap);
  cols.forEach((c, i) => { c.x = x[i]; });
  return { columns: cols, width: x[x.length - 1] + cols[cols.length - 1].width };
}

/** Fill unanchored columns by engraved spacing stretched between the anchored neighbours. */
function interpolate(a, E) {
  const idx = a.map((v, i) => (v == null ? -1 : i)).filter((i) => i >= 0);
  if (!idx.length) return E;
  return a.map((v, i) => {
    if (v != null) return v;
    const l = [...idx].reverse().find((j) => j < i), r = idx.find((j) => j > i);
    if (l == null) return a[r] - (E[r] - E[i]);
    if (r == null) return a[l] + (E[i] - E[l]);
    const f = E[r] === E[l] ? 0.5 : (E[i] - E[l]) / (E[r] - E[l]);
    return a[l] + f * (a[r] - a[l]);
  });
}

/**
 * Minimise sum w_i (x_i - target_i)^2 subject to x_{i+1} - x_i >= gap_i. Substituting
 * y_i = x_i - (gap_0 + ... + gap_{i-1}) turns it into weighted isotonic regression, solved
 * exactly by pool-adjacent-violators in O(n).
 */
export function fitWithGaps(target, weight, gap) {
  const G = [0]; for (let i = 1; i < target.length; i++) G.push(G[i - 1] + gap[i - 1]);
  const blocks = [];
  target.forEach((t, i) => {
    let b = { sum: weight[i] * (t - G[i]), w: weight[i], n: 1 };
    while (blocks.length && blocks[blocks.length - 1].sum / blocks[blocks.length - 1].w > b.sum / b.w) {
      const p = blocks.pop(); b = { sum: p.sum + b.sum, w: p.w + b.w, n: p.n + b.n };
    }
    blocks.push(b);
  });
  const y = blocks.flatMap((b) => Array(b.n).fill(b.sum / b.w));
  return y.map((v, i) => v + G[i]);
}

// Anchors: references to a place in the music that survive edits, so playback objects
// (clip edges, jump markers, loop brackets) stay attached to what the user pointed at.
// An anchor resolves to { fragment, t } (fragment-local score time) when it is used, never
// when it is created, so if the note it names moves or a bar is reinterpreted, it follows.
//
//   { time: '1/2', fragment? }             a moment
//   { event: id, edge?: 'start' | 'end' }  a note or rest (an object along the staff)
//   { barline: directionId }               a printed / drawn barline (a bar on the page)
//   { bar: n, edge?, fragment? }           the n-th (1-based) measure of the interpretation
//   { pos: { x, line }, fragment? }        a point on the page / paper, read through the
//                                          source positions of the notes on that line
//   { fragment, edge: 'start' | 'end' }    either end of a fragment
//
// positionAt goes the other way, score time -> page position, for drawing markers and
// playheads where the music actually is.

import { r, ZERO, add, sub, mul, cmp, lt, le, parse, toFloat } from './rational.js';
import { MAIN, fragOf, active, scoreEnd, endOf } from './ir.js';

export function fragmentEnd(score, fragment = MAIN) { return scoreEnd(score, active(score, {}, fragment), fragment); }

/** An anchor that names nothing in the score (the note was deleted, the bar is gone). */
export class AnchorError extends Error {
  constructor(anchor, why) { super(`anchor ${JSON.stringify(anchor)}: ${why}`); this.anchor = anchor; this.code = 'unresolved-anchor'; }
}

// Page-keyed ids (adapters/scoreshift.js): <kind>:L<line>:q<x>[:<voice>][#n]
const PAGE_ID = /^(\w+):L(\d+):q(-?\d+)(?::([^#]+))?(?:#\d+)?$/;
export const parsePageId = (id) => { const m = PAGE_ID.exec(id || ''); return m && { kind: m[1], line: +m[2], q: +m[3], voice: m[4] ?? null }; };

/**
 * The object an id names: exactly, or for a page-keyed id the nearest one of the same kind on
 * the same staff line within score.pageIds.tol (same voice first). null when nothing is close:
 * a deleted note is never replaced by its neighbour.
 */
export function findById(score, kind, id) {
  const list = kind === 'event' ? score.events : score.directions.filter((d) => d.kind === 'barline');
  const exact = list.find((x) => x.id === id);
  if (exact || !score.pageIds) return exact || null;
  const k = parsePageId(id);
  if (!k) return null;
  const { unit, tol = 2 } = score.pageIds;
  let best = null, bd = Infinity;
  for (const x of list) {
    const p = parsePageId(x.id);
    if (!p || p.kind !== k.kind || p.line !== k.line || x.src?.x == null) continue;
    const d = Math.abs(x.src.x / unit - k.q) + (k.voice && p.voice !== k.voice ? 0.5 : 0); // prefer the same voice
    if (Math.abs(x.src.x / unit - k.q) <= tol && d < bd) { bd = d; best = x; }
  }
  return best;
}

/** interpOf(fragment) -> interpret() result; needed only for { bar } anchors. */
export function resolveAnchor(score, a, interpOf) {
  if (a.event) {
    const e = findById(score, 'event', a.event);
    if (!e) throw new AnchorError(a, 'no such event (deleted?)');
    return { fragment: fragOf(e), t: a.edge === 'end' ? endOf(e) : e.onset };
  }
  if (a.barline) {
    const d = findById(score, 'barline', a.barline);
    if (!d) throw new AnchorError(a, 'no such barline');
    return { fragment: fragOf(d), t: d.at };
  }
  const fragment = a.fragment ?? MAIN;
  if (a.time != null) return { fragment, t: parse(a.time) };
  if (a.bar != null) {
    const ms = interpOf(fragment).measures;
    const m = ms[a.bar - 1];
    if (!m) throw new AnchorError(a, `no bar ${a.bar} in ${fragment} (${ms.length} bars)`);
    return { fragment, t: a.edge === 'end' ? m.end : m.start };
  }
  if (a.pos) return { fragment, t: timeAtPos(score, fragment, a.pos) };
  if (a.edge) return { fragment, t: a.edge === 'end' ? fragmentEnd(score, fragment) : ZERO };
  throw new AnchorError(a, 'cannot resolve');
}

/** Source points on one line of a fragment: { x, t } from notes and printed barlines. */
function points(score, fragment, line) {
  const pts = [];
  for (const e of active(score, {}, fragment)) if (e.src?.x != null && (line == null || e.src.line === line)) pts.push({ x: e.src.x, t: e.onset, line: e.src.line });
  for (const d of score.directions) if (d.kind === 'barline' && fragOf(d) === fragment && d.src?.x != null && (line == null || d.src.line === line)) pts.push({ x: d.src.x, t: d.at, line: d.src.line });
  return pts;
}

/** Page x on a line -> score time, interpolating between the nearest source points. */
export function timeAtPos(score, fragment, { x, line }) {
  const pts = points(score, fragment, line).sort((a, b) => a.x - b.x);
  if (!pts.length) throw new AnchorError({ pos: { x, line } }, `no source positions on line ${line}`);
  if (x <= pts[0].x) return pts[0].t;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i];
    if (x <= q.x) return snap(p.t, q.t, (x - p.x) / (q.x - p.x || 1));
  }
  return pts[pts.length - 1].t;
}

// Interpolated times snap to a 1/64 grid so a position between two notes gives a usable time.
function snap(a, b, f) {
  const v = toFloat(a) + f * (toFloat(b) - toFloat(a));
  return r(Math.round(v * 64), 64);
}

/** Score time -> { x, line } on the page, or null when the fragment has no source positions. */
export function positionAt(score, fragment, t) {
  const pts = points(score, fragment).sort((a, b) => cmp(a.t, b.t) || a.x - b.x);
  if (!pts.length) return null;
  let p = pts[0], q = null;
  for (const pt of pts) { if (le(pt.t, t)) p = pt; else { q = pt; break; } }
  if (!q || q.line !== p.line || le(t, p.t)) return { x: p.x, line: p.line };
  const f = toFloat(sub(t, p.t)) / toFloat(sub(q.t, p.t));
  return { x: p.x + f * (q.x - p.x), line: p.line };
}

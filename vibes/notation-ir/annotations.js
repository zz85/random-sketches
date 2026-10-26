// Pen annotations: ink attached to the music, not to the page. A stroke written on any surface
// (a photographed page, StaffInk's engraving, paper) is stored relative to the music it marks,
// in staff spaces, so it is redrawn in the right place on every surface, after corrections,
// after a transposition, at any zoom. Ink is never notation: annotations sit next to the IR
// and do not change playback, export or bar checks. Pure, no DOM; drawing takes any 2D context.
//
// annotation = {
//   id, color, width (staff spaces),
//   anchor: { kind: 'event', id }                  a mark at one note (fingering, breath, word)
//         | { kind: 'span', first, last }          a mark over several (circle, box, bracket):
//                                                  it stretches when the notes move apart
//         | { kind: 'time' }                       a mark between notes or in the margin
//   at,      the moment (whole notes) the mark refers to: how a 'time' mark is placed, and
//            where a mark goes when its note is deleted
//   near,    an event on the same staff, to find the part / staff for 'time' marks
//   strokes: [[{ u, ox?, dy, p? }]]  per point: u = along the anchor (event: staff spaces from
//            the note; span: fraction 0..1 from the first note's start to the last's end, with
//            ox = staff spaces beyond either end, so a circle's margins keep their size while
//            the part over the notes stretches; time: staff spaces from the moment's
//            position), dy = staff spaces below the top line of the note's own staff,
//            p = pen pressure
// }
// `items` everywhere = [{ id, t, end? }] the events in time (whole notes), see itemsOf.

import { selectionBands, headMaps } from './surface.js';

export const NEAR = 3;      // a mark within this many staff spaces of a note belongs to it
export const SPAN_MIN = 2;  // notes needed under a mark for it to be a span
export const SPAN_WIDTH = 2.5; // staff spaces a mark must cover to be a span

/** Surface time items from an IR score: [{ id, t, end }] in whole notes. */
export function itemsOf(score) {
  const f = (x) => x.n / x.d;
  return score.events.filter((e) => !e.fragment).map((e) => ({ id: e.id, t: f(e.onset), end: f(e.onset) + f(e.dur) }));
}

const bbox = (strokes) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of strokes) for (const p of s) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
};
/** y of the top line of the staff a placed event is on (its own staff, else the line's top). */
const staffTop = (surface, p, x = p.x) => {
  if (p.top != null) return p.top;
  const L = surface.lines()[p.line];
  return L.topAt ? L.topAt(x) : L.top;
};
const timeOf = (items, id) => items.find((q) => q.id === id)?.t;

/** Where the moment t is on a surface, on the staff of event `near` when it can tell: { line, x, top }. */
function placeTime(surface, items, t, near) {
  const heads = headMaps(surface, items)(t); if (!heads.length) return null;
  const L = surface.lines(), ref = near != null ? surface.place(near, 'center')[0] : null;
  const g = ref ? L[ref.line]?.group ?? 0 : 0;
  const h = heads.find((q) => (L[q.line]?.group ?? 0) === g) || heads[0];
  // keep the staff of `near` when it is on the same line (a grand-staff system)
  const top = ref && ref.line === h.line && ref.top != null ? ref.top : (L[h.line].topAt ? L[h.line].topAt(h.x) : L[h.line].top);
  return { line: h.line, x: h.x, top };
}

/**
 * Attach strokes (surface units: [[{ x, y, p? }]]) to the music under them. Returns an
 * annotation, or null when there is no music on the surface to attach to.
 */
export function attachStrokes(surface, items, strokes, { id = null, color = '#c2255c', width = 0.18 } = {}) {
  strokes = strokes.filter((s) => s.length);
  if (!strokes.length || !items.length) return null;
  const sp = surface.space, b = bbox(strokes);
  const near = surface.eventAt({ x: b.cx, y: b.cy }, 4); if (near == null) return null;
  const ref = surface.place(near, 'center')[0]; if (!ref) return null;
  const top = ref.top ?? null;
  // the notes under the mark: same line, same staff, centres inside its horizontal extent
  const under = items.map((q) => ({ q, p: surface.place(q.id, 'center')[0] }))
    .filter(({ p }) => p && p.line === ref.line && (top == null || p.top == null || Math.abs(p.top - top) < 0.5 * sp) && p.x >= b.x0 - 0.3 * sp && p.x <= b.x1 + 0.3 * sp)
    .sort((a, b2) => a.p.x - b2.p.x);
  const rel = (fn) => strokes.map((s) => s.map((pt) => ({ ...fn(pt), ...(pt.p != null ? { p: pt.p } : {}) })));
  const dyOf = (pt, p) => (pt.y - staffTop(surface, p, pt.x)) / sp;
  let anchor, out;
  if (under.length >= SPAN_MIN && b.x1 - b.x0 >= SPAN_WIDTH * sp) {
    const first = under[0].q.id, last = under.reduce((a, u) => ((u.q.end ?? u.q.t) > (a.q.end ?? a.q.t) ? u : a)).q.id;
    const xa = surface.place(first, 'start')[0].x, xb = surface.place(last, 'end')[0].x, len = Math.max(1e-6, xb - xa);
    anchor = { kind: 'span', first, last };
    out = rel((pt) => {
      const ox = pt.x < xa ? (pt.x - xa) / sp : pt.x > xb ? (pt.x - xb) / sp : 0;
      return { u: Math.max(0, Math.min(1, (pt.x - xa) / len)), ...(ox ? { ox } : {}), dy: dyOf(pt, ref) };
    });
  } else if (Math.abs(ref.x - b.cx) <= NEAR * sp) {
    anchor = { kind: 'event', id: near };
    out = rel((pt) => ({ u: (pt.x - ref.x) / sp, dy: dyOf(pt, ref) }));
  } else {
    // no note close: the moment under the mark, interpolated along the staff
    const t = timeAtX(surface, items, ref, b.cx);
    const at = placeTime(surface, items, t, near);
    anchor = { kind: 'time' };
    out = rel((pt) => ({ u: (pt.x - at.x) / sp, dy: (pt.y - at.top) / sp }));
    return { id, color, width, anchor, at: t, near, strokes: out };
  }
  const at = anchor.kind === 'span' ? timeOf(items, anchor.first) : timeOf(items, near);
  return { id, color, width, anchor, at, near, strokes: out };
}

/** The moment at x on the line of placed event `ref`, between the notes of its staff. */
function timeAtX(surface, items, ref, x) {
  const pts = [];
  for (const q of items) { const p = surface.place(q.id, 'center')[0]; if (p && p.line === ref.line && (ref.top == null || p.top == null || p.top === ref.top)) pts.push({ x: p.x, t: q.t }); }
  pts.sort((a, b) => a.x - b.x);
  if (!pts.length) return 0;
  if (x <= pts[0].x) return pts[0].t;
  for (let i = 1; i < pts.length; i++) if (x <= pts[i].x) { const a = pts[i - 1], c = pts[i]; return a.t + ((x - a.x) / (c.x - a.x || 1)) * (c.t - a.t); }
  return pts[pts.length - 1].t;
}

/**
 * The annotation's ink on a surface: { pieces: [{ line, points: [{ x, y, p? }] }], lost }
 * (several pieces when a span runs over a line break), or null when its music is not on
 * this surface at all. lost = the note it was attached to is gone; it is then drawn where
 * that note was (surface.lostAt) or at its moment.
 */
export function resolveAnnotation(surface, ann, items) {
  const sp = surface.space, A = ann.anchor;
  const fromTime = (lost) => {
    let at = null;
    if (lost && surface.lostAt) { const ids = A.kind === 'span' ? [A.first] : [A.id ?? ann.near]; const p = surface.lostAt({ event: ids[0] }); if (p) at = { ...p, top: staffTop(surface, p) }; }
    if (!at && ann.at != null) at = placeTime(surface, items, ann.at, surface.place(ann.near, 'center').length ? ann.near : null);
    if (!at) return null;
    const scaleU = A.kind === 'span' ? 4 : 1; // a lost span keeps a rough shape, ~4 spaces wide
    return { pieces: ann.strokes.map((s) => ({ line: at.line, points: s.map((q) => ({ x: at.x + (q.u * scaleU + (q.ox || 0)) * sp, y: at.top + q.dy * sp, ...(q.p != null ? { p: q.p } : {}) })) })), lost };
  };
  if (A.kind === 'time') return fromTime(false);
  if (A.kind === 'event') {
    const p = surface.place(A.id, 'center')[0];
    if (!p) return fromTime(true);
    return { pieces: ann.strokes.map((s) => ({ line: p.line, points: s.map((q) => ({ x: p.x + q.u * sp, y: staffTop(surface, p) + q.dy * sp, ...(q.p != null ? { p: q.p } : {}) })) })), lost: false };
  }
  // span: along the notes, over line breaks when the surface breaks them
  const a = surface.place(A.first, 'start')[0], b = surface.place(A.last, 'end');
  const bl = b[b.length - 1];
  if (!a || !bl) return fromTime(true);
  const L = surface.lines();
  const segs = a.line === bl.line ? [{ line: a.line, x0: a.x, x1: bl.x, top: a.top }]
    : [{ line: a.line, x0: a.x, x1: L[a.line].x1, top: a.top }, ...L.slice(a.line + 1, bl.line).map((l, k) => ({ line: a.line + 1 + k, x0: l.x0, x1: l.x1 })), { line: bl.line, x0: L[bl.line].x0, x1: bl.x, top: bl.top }];
  const total = segs.reduce((s, g) => s + Math.max(0, g.x1 - g.x0), 0) || 1e-6;
  const place = (u, ox = 0) => { // u along the whole span (+ ox spaces beyond an end) -> segment + x
    if (ox < 0) return { g: segs[0], x: segs[0].x0 + ox * sp };
    if (ox > 0) { const g = segs[segs.length - 1]; return { g, x: g.x1 + ox * sp }; }
    let d = u * total;
    for (const g of segs) { const w = g.x1 - g.x0; if (d <= w) return { g, x: g.x0 + d }; d -= w; }
    const g = segs[segs.length - 1]; return { g, x: g.x1 };
  };
  const pieces = [];
  for (const s of ann.strokes) {
    let cur = null;
    for (const q of s) {
      const { g, x } = place(q.u, q.ox);
      const top = g.top ?? (L[g.line].topAt ? L[g.line].topAt(x) : L[g.line].top);
      if (!cur || cur.line !== g.line) { cur = { line: g.line, points: [] }; pieces.push(cur); }
      cur.points.push({ x, y: top + q.dy * sp, ...(q.p != null ? { p: q.p } : {}) });
    }
  }
  return { pieces, lost: false };
}

/** Distance from a point to an annotation's ink, in surface units (Infinity when not shown). */
export function distanceTo(surface, ann, items, pt) {
  const r = resolveAnnotation(surface, ann, items); if (!r) return Infinity;
  let d = Infinity;
  for (const pc of r.pieces) for (let i = 0; i < pc.points.length; i++) {
    const a = pc.points[i], b = pc.points[i + 1] || a, dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    d = Math.min(d, Math.hypot(pt.x - a.x - t * dx, pt.y - a.y - t * dy));
  }
  return d;
}
/** The annotation under a point (within tol staff spaces of its ink), or null: for erasing and selecting. */
export function hitAnnotation(surface, anns, items, pt, tol = 0.6) {
  let best = null, bd = tol * surface.space;
  for (const a of anns) { const d = distanceTo(surface, a, items, pt); if (d <= bd) { bd = d; best = a; } }
  return best;
}

/** Re-attach a lost annotation to another event (an id), keeping its shape. */
export function reattachAnnotation(ann, id, items) {
  const t = timeOf(items, id);
  if (ann.anchor.kind === 'span') ann.anchor = { kind: 'span', first: id, last: id };
  else ann.anchor = { kind: 'event', id };
  ann.near = id; if (t != null) ann.at = t;
  return ann;
}

/** Draw annotations on a surface: pressure-weighted round strokes, lost ones dashed. */
export function drawAnnotations(g, surface, anns, items, { selected = null } = {}) {
  const v = surface.view();
  g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
  for (const a of anns) {
    const r = resolveAnnotation(surface, a, items); if (!r) continue;
    g.strokeStyle = a.color || '#c2255c'; g.globalAlpha = r.lost ? 0.6 : 0.92;
    const w = Math.max(1, (a.width ?? 0.18) * v.sp) * (selected === a.id ? 1.8 : 1);
    g.setLineDash(r.lost ? [0.45 * v.sp, 0.3 * v.sp] : []);
    for (const pc of r.pieces) {
      const P = pc.points; if (!P.length) continue;
      if (P.length === 1) { g.fillStyle = g.strokeStyle; g.beginPath(); g.arc(v.X(P[0].x), v.Y(P[0].y), w / 2, 0, 7); g.fill(); continue; }
      for (let i = 1; i < P.length; i++) {
        g.lineWidth = w * (0.6 + 0.8 * (P[i].p ?? 0.5));
        g.beginPath(); g.moveTo(v.X(P[i - 1].x), v.Y(P[i - 1].y)); g.lineTo(v.X(P[i].x), v.Y(P[i].y)); g.stroke();
      }
    }
  }
  g.restore();
}

/** The events an annotation is attached to (for listing it, or highlighting its notes). */
export const annotationEvents = (ann) => (ann.anchor.kind === 'span' ? [ann.anchor.first, ann.anchor.last] : ann.anchor.kind === 'event' ? [ann.anchor.id] : []);
/** Where an annotation's notes are, as selection bands (for showing what it marks). */
export const annotationBands = (surface, ann) => selectionBands(surface, annotationEvents(ann));

// Surfaces: anywhere the music is visible. Notation features (markers, playheads, selection,
// picking a note under the pen) are written once against this interface; each app supplies a
// surface for its page: StaffInk an engraved layout, ScoreShift a photographed page, later ink
// on paper or a piano roll. The IR never holds geometry a surface can compute live.
//
// A surface is a plain object:
//   kind       'engraved' | 'photo' | 'ink' | ...
//   space      one staff space in the surface's own units (StaffInk 1, ScoreShift ~16 px)
//   lines()    [{ x0, x1, top, bottom, group?, topAt?(x), bottomAt?(x) }] the staves or
//              systems in reading order; group = part (one playhead per group); topAt /
//              bottomAt follow a staff that is not level (a photo)
//   place(id, edge)  where an event is: [{ line, x, top? }], several places when it shows in
//              several (a note continued over a line break), [] when it is not on this surface.
//              edge 'start' | 'end' | 'center'; ids are IR event ids or the app's own.
//              top = y of the top line of the event's own staff (a line can hold several
//              staves, e.g. a grand-staff system); without it the line's top is used
//   eventAt(pt, reach?)  the id of the event under / nearest to a point on the line under it,
//              or null; reach = how far off the staff still counts, in staff spaces
//   view()     { X(x), Y(y), sp } surface units -> canvas pixels; sp = a staff space in pixels
// optional:
//   barOf(id)  { key, line, x } the bar an event is in, and where that bar ends (the playhead
//              runs to the barline before a line break, and across rests)
//   barAt(pt)  { first, last } the events of the bar under a point
//   placeAnchor(anchor, edge)  { line, x } for anchors other than events (a barline, a bar)
//   lostAt(anchor)  { line, x } where a marker whose note is gone used to be

import { layoutMarkers, drawMarkers, hitMarker } from './markers.js';
import { timeMap, drawPlayheads } from './playheads.js';

const REQUIRED = ['lines', 'place', 'eventAt', 'view'];

/** Throw unless s implements the interface; returns s. */
export function checkSurface(s) {
  const missing = REQUIRED.filter((k) => typeof s?.[k] !== 'function');
  if (missing.length) throw new Error(`surface ${s?.kind ?? '?'}: missing ${missing.join(', ')}`);
  if (!(s.space > 0)) throw new Error(`surface ${s.kind}: space must be > 0`);
  return s;
}

/** An anchor's place: events through place() (first for a start, last for an end), others through placeAnchor. */
export function placeAnchor(surface, a, edge = 'start') {
  if (!a) return null;
  if (a.event != null) {
    const end = edge === 'end' || a.edge === 'end', ps = surface.place(a.event, end ? 'end' : 'start');
    return ps.length ? ps[end ? ps.length - 1 : 0] : null;
  }
  return surface.placeAnchor ? surface.placeAnchor(a, edge) : null;
}

// ---------------------------------------------------------------- markers

/** markers.js layout of `markers` on this surface. */
export function layoutMarkersOn(surface, markers) {
  return layoutMarkers(markers, {
    lines: surface.lines(), place: (a, e) => placeAnchor(surface, a, e),
    lostAt: surface.lostAt ? (a) => surface.lostAt(a) : undefined,
  });
}
export const drawMarkersOn = (g, surface, layout, opts) => drawMarkers(g, layout, surface.view(), opts);
/** The marker under a point in surface units, or null. */
export function hitMarkerOn(surface, layout, pt) {
  if (!layout) return null;
  const v = surface.view();
  return hitMarker(layout, v, v.X(pt.x), v.Y(pt.y));
}

// ---------------------------------------------------------------- selection

/** A selection of event ids as one band per line: [{ line, x0, x1 }] in reading order. */
export function selectionBands(surface, ids) {
  const by = new Map();
  for (const id of ids) for (const edge of ['start', 'end']) for (const p of surface.place(id, edge)) {
    const b = by.get(p.line) || { line: p.line, x0: Infinity, x1: -Infinity };
    b.x0 = Math.min(b.x0, p.x); b.x1 = Math.max(b.x1, p.x); by.set(p.line, b);
  }
  return [...by.values()].sort((a, b) => a.line - b.line);
}

/** Draw selection bands across their staves (following a tilted staff), pad staff spaces above and below. */
export function drawBands(g, surface, bands, { pad = 1.4, fill = 'rgba(37,99,235,0.15)', edge = 'rgba(37,99,235,0.88)' } = {}) {
  const L = surface.lines(), v = surface.view(), sp = surface.space;
  g.save();
  for (const b of bands) {
    const l = L[b.line]; if (!l) continue;
    const top = (x) => v.Y((l.topAt ? l.topAt(x) : l.top) - pad * sp), bot = (x) => v.Y((l.bottomAt ? l.bottomAt(x) : l.bottom) + pad * sp);
    const xa = v.X(b.x0), xb = v.X(b.x1);
    g.fillStyle = fill;
    g.beginPath(); g.moveTo(xa, top(b.x0)); g.lineTo(xb, top(b.x1)); g.lineTo(xb, bot(b.x1)); g.lineTo(xa, bot(b.x0)); g.closePath(); g.fill();
    g.strokeStyle = edge; g.lineWidth = Math.max(1.5, 0.14 * v.sp);
    g.beginPath(); g.moveTo(xa, top(b.x0)); g.lineTo(xa, bot(b.x0)); g.moveTo(xb, top(b.x1)); g.lineTo(xb, bot(b.x1)); g.stroke();
  }
  g.restore();
}

// ---------------------------------------------------------------- playheads

/**
 * Time -> playhead positions, one per group (part) of lines. items = [{ id, t, end }] in any
 * one time unit: each event's onset is at its place, and where the surface knows bars
 * (barOf), each bar's last moment is at its barline, so the head runs on through rests and
 * up to the end of a line before moving to the next.
 */
export function headMaps(surface, items) {
  const L = surface.lines(), groups = new Map(), ends = new Map();
  for (const q of items) {
    const ps = surface.place(q.id, 'center'); if (!ps.length) continue;
    const p = ps[0], g = L[p.line]?.group ?? 0;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push({ t: q.t, line: p.line, x: p.x });
    const bar = q.end != null && surface.barOf?.(q.id);
    if (bar) { const k = `${g}|${bar.key}`, cur = ends.get(k); if (!cur || q.end > cur.t) ends.set(k, { g, t: q.end, line: bar.line, x: bar.x, end: true }); }
  }
  for (const e of ends.values()) groups.get(e.g).push(e);
  const maps = [...groups.keys()].sort((a, b) => a - b).map((g) => timeMap(groups.get(g), L));
  return (t) => maps.map((m) => m(t)).filter(Boolean);
}
export const drawHeadsOn = (g, surface, heads) => drawPlayheads(g, heads, surface.lines(), surface.view());

// ---------------------------------------------------------------- time from a point

/**
 * The moment a point stands for (in the items' time unit), interpolated between the events
 * on the line under it; null when there is nothing there. For scrubbing, or anchoring a
 * marker to a point between notes.
 */
export function timeAt(surface, items, pt) {
  const id = surface.eventAt(pt); if (id == null) return null;
  const line = surface.place(id, 'center')[0]?.line;
  const pts = [];
  for (const q of items) for (const p of surface.place(q.id, 'center')) if (p.line === line) pts.push({ x: p.x, t: q.t });
  if (!pts.length) return null;
  pts.sort((a, b) => a.x - b.x);
  if (pt.x <= pts[0].x) return pts[0].t;
  for (let i = 1; i < pts.length; i++) if (pt.x <= pts[i].x) { const a = pts[i - 1], b = pts[i]; return a.t + ((pt.x - a.x) / (b.x - a.x || 1)) * (b.t - a.t); }
  return pts[pts.length - 1].t;
}

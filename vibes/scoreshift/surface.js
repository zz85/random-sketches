// A photographed page as a notation-ir surface (../notation-ir/surface.js): the staves found on
// the photo are the lines (following their tilt), and every event is where it was printed, from
// the IR's page-keyed ids. Units are normalized page pixels. Pure, so it runs under bun.
import { lineY, spaceAt } from './omr.js';
import { findById, parsePageId, resolveAnchor, positionAt } from '../notation-ir/anchors.js';

/**
 * model = the recognised page, score = buildScore(model), irc = fromScoreShift(...) result
 * ({ score: IR, byId }), view() -> { X, Y, sp } for the current zoom.
 */
export function photoSurface({ model, score, irc, view }) {
  const sp = model.space || 16, ir = irc.score;
  const partOf = new Map(); score.parts.forEach((p, k) => p.staves.forEach((st) => partOf.set(st.index, k)));
  const lines = [];
  for (const st of model.staves) {
    const xm = (st.x0 + st.x1) / 2;
    lines[st.index] = { x0: st.x0, x1: st.x1, top: lineY(st, 0, xm), bottom: lineY(st, 4, xm), group: partOf.get(st.index) ?? 0, topAt: (x) => lineY(st, 0, x), bottomAt: (x) => lineY(st, 4, x) };
  }
  /** The staff under a point (within reach staff spaces of its lines), or null. */
  const staffAt = ({ x, y }, reach = 3) => {
    let best = null, bd = Infinity;
    for (const st of model.staves) { const s = spaceAt(st, x), t = lineY(st, 0, x) - reach * s, b = lineY(st, 4, x) + reach * s, d = y < t ? t - y : y > b ? y - b : 0; if (d < bd) { bd = d; best = st; } }
    return bd === 0 ? best : null;
  };
  const evOf = (id) => findById(ir, 'event', id);
  return {
    kind: 'photo', space: sp, view, staffAt,
    lines: () => lines,
    place(id, edge = 'start') {
      const e = evOf(id); if (!e?.src) return [];
      return [{ line: e.src.line, x: e.src.x + (edge === 'end' ? 0.9 : edge === 'center' ? 0 : -0.7) * sp }];
    },
    eventAt(pt, reach = 3) {
      const st = staffAt(pt, reach); if (!st) return null;
      let best = null, bd = Infinity;
      for (const e of ir.events) if (e.src?.line === st.index) { const d = Math.abs(e.src.x - pt.x); if (d < bd) { bd = d; best = e; } }
      return best ? best.id : null;
    },
    barOf(id) {
      const e = evOf(id), q = e && irc.byId.get(e.id); if (!q) return null;
      return { key: q.m.index, line: q.m.st.index, x: Math.min(q.m.x1, q.m.st.x1) };
    },
    barAt(pt) {
      const st = staffAt(pt); if (!st) return null;
      const m = score.measures.find((q) => q.st === st && pt.x >= q.x0 && pt.x < q.x1); if (!m) return null;
      const evs = ir.events.filter((e) => e.src?.line === st.index && e.src.x >= m.x0 && e.src.x < m.x1);
      if (!evs.length) return null;
      const on = (e) => e.onset.n / e.onset.d, end = (e) => on(e) + e.dur.n / e.dur.d;
      return { first: evs.reduce((a, e) => (on(e) < on(a) ? e : a)).id, last: evs.reduce((a, e) => (end(e) > end(a) ? e : a)).id, m };
    },
    placeAnchor(a) {
      if (a.barline) { const d = findById(ir, 'barline', a.barline); return d?.src ? { line: d.src.line, x: d.src.x } : null; }
      try { const r = resolveAnchor(ir, a); return positionAt(ir, r.fragment, r.t); } catch (e) { return null; }
    },
    lostAt(a) { const k = parsePageId(a.event || a.barline); return k && lines[k.line] ? { line: k.line, x: k.q * ir.pageIds.unit } : null; },
  };
}

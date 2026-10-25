// Playhead lines, shared by StaffInk and ScoreShift: a thin line across the staff that glides
// through the music while it plays, one per cursor, so the position shows through rests,
// long notes and jumps, and the voices of a canon or a layered clip can be told apart.
//
// The apps describe where music is on their page as points in time; this module interpolates
// between them, handles line breaks, and draws. No DOM, no dependencies on the IR beyond the
// plain-data trace that playback.js perform() returns.
//
//   points  [{ t, line, x, end? }]  a moment and where it is (any time unit, the same one the
//           map is queried in). end: true marks the end of a stretch on that line (a barline
//           before a line break), sorted before a point starting at the same moment.
//   lines   [{ x0, x1, top, bottom, topAt?, bottomAt? }]  as in markers.js
//   view    { X(x), Y(y), sp }  app units -> canvas pixels

/** Default playhead colours by cursor, when a cursor is not inside a clip marker. */
export const HEAD_COLORS = ['#e8590c', '#0ca678', '#7048e8', '#d6336c', '#1c7ed6', '#f59f00'];

/**
 * A function t -> { line, x } (or null with no points). Between two points on one line the
 * position moves linearly; when the next point is on another line, the head runs on to the
 * end of this line and then continues on the next. Before the first point it waits there,
 * after the last it stays at the last.
 */
export function timeMap(points, lines = []) {
  const P = points.filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.x)).slice()
    .sort((a, b) => a.t - b.t || (b.end ? 1 : 0) - (a.end ? 1 : 0));
  if (!P.length) return () => null;
  return (t) => {
    if (t <= P[0].t) return { line: P[0].line, x: P[0].x };
    let lo = 0, hi = P.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (P[mid].t <= t) lo = mid; else hi = mid - 1; }
    const a = P[lo], b = P[lo + 1];
    if (!b) return { line: a.line, x: a.x };
    const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
    if (b.line === a.line) return { line: a.line, x: a.x + f * (b.x - a.x) };
    const end = lines[a.line] ? lines[a.line].x1 : a.x; // run on to the end of the line
    return { line: a.line, x: a.x + f * (end - a.x) };
  };
}

/**
 * Where every cursor of a performance is at T seconds: [{ cursor, fragment, at, marker }],
 * at = score time in whole notes (a float). From perf.trace (playback.js).
 */
export function cursorsAt(perf, T) {
  const out = [];
  for (const s of perf.trace) {
    if (!(s.t0 <= T && T < s.t1)) continue;
    const f = (T - s.t0) / (s.t1 - s.t0 || 1), a = s.s0.n / s.s0.d, b = s.s1.n / s.s1.d;
    out.push({ cursor: s.cursor, fragment: s.fragment, at: a + f * (b - a), marker: s.marker ?? null });
  }
  return out;
}

/**
 * Playheads to draw at T seconds: [{ line, x, color, cursor }]. map(fragment, at) returns a
 * position, an array of positions (one per part playing in parallel), or null. A cursor in a
 * clip takes the clip's colour from the marker layout; others get HEAD_COLORS by cursor.
 */
export function headsAt(perf, T, map, markerLayout = null) {
  const order = [...new Set(perf.trace.map((s) => s.cursor))].sort();
  const out = [];
  for (const c of cursorsAt(perf, T)) {
    const item = c.marker && markerLayout?.items.find((x) => x.id === c.marker);
    const color = item ? (item.lost ? HEAD_COLORS[0] : item.color) : HEAD_COLORS[order.indexOf(c.cursor) % HEAD_COLORS.length];
    const p = map(c.fragment, c.at);
    for (const q of Array.isArray(p) ? p : p ? [p] : []) out.push({ ...q, color, cursor: c.cursor });
  }
  return out;
}

/** Draw playhead lines; perpendicular to the staff when the line gives topAt (a tilted photo). */
export function drawPlayheads(g, heads, lines, view) {
  const { X, Y, sp } = view;
  g.save();
  g.lineCap = 'round';
  for (const h of heads) {
    const L = lines[h.line]; if (!L) continue;
    const top = L.topAt ? L.topAt(h.x) : L.top, bottom = L.bottomAt ? L.bottomAt(h.x) : L.bottom;
    // the staff's slope at x: the line runs perpendicular to it
    const s = L.topAt ? (L.topAt(h.x + 10) - L.topAt(h.x - 10)) / 20 : 0;
    const over = sp / Math.max(1e-6, Y(1) - Y(0)); // one staff space in app units
    const y0 = top - 1.1 * over, y1 = bottom + 1.1 * over;
    const xa = h.x + s * (top - y0), xb = h.x - s * (y1 - top);
    g.globalAlpha = 0.85; g.strokeStyle = h.color; g.fillStyle = h.color;
    g.lineWidth = Math.max(2, 0.2 * sp);
    g.beginPath(); g.moveTo(X(xa), Y(y0)); g.lineTo(X(xb), Y(y1)); g.stroke();
    // a small cap on top, so the head is easy to find
    const w = 0.45 * sp;
    g.globalAlpha = 1; g.beginPath(); g.moveTo(X(xa) - w, Y(y0) - w * 1.2); g.lineTo(X(xa) + w, Y(y0) - w * 1.2); g.lineTo(X(xa), Y(y0)); g.closePath(); g.fill();
  }
  g.restore();
}


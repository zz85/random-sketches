// Playback markers on the page, shared by StaffInk and ScoreShift: clips as coloured brackets
// over the staff (split at line breaks, stacked when they overlap), loop counts, jumps as
// arrows, and markers whose note is gone drawn red and dashed where it used to be.
//
// The apps describe their page and this module does the rest:
//   lines   [{ x0, x1, top, bottom, group?, topAt? }] in reading order, in the app's own units
//           (StaffInk: systems in staff spaces; ScoreShift: staves in page pixels). A clip
//           that runs past the end of a line continues on the next line of the same group.
//           topAt(x) gives the top line's y at x, for a staff that is not quite level.
//   place(anchor, edge) -> { line, x } | null    where a notation-ir anchor is on the page
//   lostAt(anchor)      -> { line, x } | null    (optional) where a lost anchor used to be
//   view    { X(x), Y(y), sp }  app units -> canvas pixels, sp = one staff space in pixels
//
// Markers come from markersOf(program) (any notation-ir playback program) or are built by the
// app: { clips: [{ id, name, color?, loop?, from?, to?, events?, layer? }],
//        jumps: [{ id, at, to, times?, name? }] }.

export const COLORS = ['#2563eb', '#d9480f', '#0f9d58', '#9c36b5', '#c2255c', '#1098ad', '#e67700', '#5c7cfa'];
export const LOST = '#e03131';
const LETTER = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');

/** Markers in a notation-ir playback program: every play node is a clip, every jump a jump. */
export function markersOf(program = {}) {
  const clips = [], jumps = [];
  const clipOf = (c) => (typeof c === 'string' ? program.clips?.[c] : c) || {};
  const visit = (n, path, loop) => {
    if (!n) return;
    if (n.loop != null && n.body) { visit(n.body, `${path}.body`, (loop || 1) * n.loop); return; }
    if (n.play !== undefined) {
      const c = clipOf(n.play), i = clips.length;
      clips.push({ id: n.marker || (typeof n.play === 'string' ? n.play : path), path, name: n.name || c.name || LETTER(i), color: n.color || c.color,
        loop: loop || 1, from: c.from, to: c.to, events: c.events, transpose: n.transpose });
    }
    if (n.walk) (n.walk.jumps || []).forEach((j, k) => jumps.push({ id: j.marker || `${path}.walk.jumps[${k}]`, at: j.at, to: j.to, times: j.times ?? 1 }));
    for (const k of ['seq', 'par', 'choose']) (n[k] || []).forEach((c, i) => visit(c, `${path}.${k}[${i}]`, loop));
  };
  visit(program.root, 'root', 1);
  (program.jumps || []).forEach((j, k) => jumps.push({ id: j.marker || `jumps[${k}]`, at: j.at, to: j.to, times: j.times ?? 1 }));
  jumps.forEach((j, k) => { j.name ??= `J${k + 1}`; });
  return { clips, jumps };
}

const before = (a, b) => a.line < b.line || (a.line === b.line && a.x < b.x);

/** Page geometry of every marker: pieces per line, stacking rows, what is lost. */
export function layoutMarkers(markers, { lines, place, lostAt }) {
  const items = [], rows = new Map(); // line -> [[x0, x1]] per row
  const rowFor = (line, x0, x1) => {
    const rs = rows.get(line) || []; rows.set(line, rs);
    let r = rs.findIndex((iv) => iv.every(([a, b]) => x1 <= a - 0.01 || x0 >= b + 0.01));
    if (r < 0) { r = rs.length; rs.push([]); }
    rs[r].push([x0, x1]);
    return r;
  };
  const span = (A, B) => {
    if (A.line === B.line) return [{ line: A.line, x0: A.x, x1: Math.max(B.x, A.x + 0.01) }];
    const g = lines[A.line]?.group, out = [{ line: A.line, x0: A.x, x1: lines[A.line].x1, cutR: true }];
    for (let l = A.line + 1; l < B.line; l++) if (lines[l] && lines[l].group === g) out.push({ line: l, x0: lines[l].x0, x1: lines[l].x1, cutL: true, cutR: true });
    if (lines[B.line]) out.push({ line: B.line, x0: lines[B.line].x0, x1: B.x, cutL: true });
    return out;
  };
  markers.clips.forEach((c, i) => {
    const color = c.color || COLORS[i % COLORS.length];
    let A = null, B = null, lost = false;
    if (c.events) {
      for (const id of c.events) {
        const a = place({ event: id }, 'start'), b = place({ event: id }, 'end');
        if (!a || !b) { lost = true; continue; }
        if (!A || before(a, A)) A = a;
        if (!B || before(B, b)) B = b;
      }
    } else {
      A = place(c.from || { edge: 'start' }, 'start'); B = place(c.to || { edge: 'end' }, 'end');
      lost = !A || !B;
    }
    let pieces = [];
    if (A && B && !before(B, A)) pieces = span(A, B);
    else if (lost && lostAt) { // draw where the lost end used to be
      const p = (!A && lostAt(c.from || {})) || (!B && lostAt(c.to || {})) || (c.events && c.events.map((id) => lostAt({ event: id })).find(Boolean)) || A || B;
      if (p) pieces = [{ line: p.line, x0: p.x, x1: p.x + (lines[p.line] ? Math.max(1, (lines[p.line].x1 - lines[p.line].x0) / 40) : 1) }];
    }
    for (const p of pieces) p.row = rowFor(p.line, p.x0, p.x1);
    items.push({ kind: 'clip', id: c.id, name: c.name, label: `${c.name}${c.loop > 1 ? ` ×${c.loop}` : ''}${c.transpose ? ` ${c.transpose > 0 ? '+' : ''}${c.transpose}` : ''}${lost ? ' ?' : ''}`, color: lost ? LOST : color, lost, pieces, clip: c });
  });
  for (const j of markers.jumps) {
    let a = place(j.at, j.at?.edge || 'end'), b = place(j.to, j.to?.edge || 'start');
    const lost = !a || !b;
    if (!a && lostAt) a = lostAt(j.at); if (!b && lostAt) b = lostAt(j.to);
    const top = (l) => (rows.get(l) || []).length;
    items.push({ kind: 'jump', id: j.id, name: j.name, label: `${j.name}${(j.times ?? 1) > 1 ? ` ×${j.times}` : ''}${lost ? ' ?' : ''}`, color: lost ? LOST : '#495057', lost, from: a, to: b, rowFrom: a ? top(a.line) : 0, rowTo: b ? top(b.line) : 0, jump: j });
  }
  return { items, lost: items.filter((x) => x.lost).map((x) => x.id), lines };
}

// ---------------------------------------------------------------- geometry in pixels

const ROW = 1.35, BASE = 1.6; // staff spaces above the staff: first row, distance between rows

/** Pixel shapes of every marker for one view: shared by drawing and hit testing. */
export function geometry(layout, view) {
  const { X, Y, sp } = view, L = layout.lines, out = [];
  const topAt = (line, x) => (L[line].topAt ? L[line].topAt(x) : L[line].top);
  const yRow = (line, row, x) => Y(topAt(line, x)) - (BASE + row * ROW) * sp;
  const fontPx = Math.max(10, 0.95 * sp);
  const labelBox = (x, y, text) => ({ x, y: y - fontPx * 1.15, w: text.length * fontPx * 0.58 + fontPx * 0.8, h: fontPx * 1.3, text, fontPx });
  for (const it of layout.items) {
    if (it.kind === 'clip') {
      const segs = it.pieces.filter((p) => L[p.line]).map((p) => ({ x0: X(p.x0), x1: X(p.x1), y: yRow(p.line, p.row, p.x0), y1: yRow(p.line, p.row, p.x1), cutL: p.cutL, cutR: p.cutR, tick: 0.55 * sp }));
      if (!segs.length) continue;
      out.push({ ...it, segs, label: labelBox(segs[0].x0, segs[0].y - 0.15 * sp, it.label) });
    } else {
      const pt = (p, row) => p && L[p.line] && { x: X(p.x), y: yRow(p.line, row, p.x) };
      const a = pt(it.from, it.rowFrom), b = pt(it.to, it.rowTo);
      if (!a && !b) continue;
      const same = a && b && it.from.line === it.to.line;
      const lift = same ? Math.min(2.4 * sp, 0.7 * sp + Math.abs(b.x - a.x) * 0.05) : 1.6 * sp;
      out.push({ ...it, a, b, same, lift, label: labelBox((a || b).x + 0.2 * sp, Math.min(a ? a.y : Infinity, b ? b.y : Infinity) - (same ? lift * 0.75 : 0.9 * sp), it.label) });
    }
  }
  return out;
}

const dist2Seg = (px, py, x0, y0, x1, y1) => { const dx = x1 - x0, dy = y1 - y0, t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / (dx * dx + dy * dy || 1))); return Math.hypot(px - x0 - t * dx, py - y0 - t * dy); };

/** The marker under a canvas-pixel point, or null (onLabel: the point is on its label chip). */
export function hitMarker(layout, view, px, py) {
  const tol = Math.max(6, 0.6 * view.sp);
  let best = null, bd = Infinity;
  for (const g of geometry(layout, view)) {
    const l = g.label;
    if (px >= l.x - 2 && px <= l.x + l.w + 2 && py >= l.y - 2 && py <= l.y + l.h + 2) return { ...g, onLabel: true };
    let d = Infinity;
    if (g.kind === 'clip') for (const s of g.segs) d = Math.min(d, dist2Seg(px, py, s.x0, s.y, s.x1, s.y1), dist2Seg(px, py, s.x0, s.y, s.x0, s.y + s.tick), dist2Seg(px, py, s.x1, s.y1, s.x1, s.y1 + s.tick));
    else for (const p of [g.a, g.b]) if (p) d = Math.min(d, Math.hypot(px - p.x, py - p.y));
    if (d < tol && d < bd) { bd = d; best = g; }
  }
  return best;
}

// ---------------------------------------------------------------- drawing

function arrowHead(g, x, y, ang, s) {
  g.beginPath(); g.moveTo(x, y);
  g.lineTo(x - s * Math.cos(ang - 0.45), y - s * Math.sin(ang - 0.45));
  g.lineTo(x - s * Math.cos(ang + 0.45), y - s * Math.sin(ang + 0.45));
  g.closePath(); g.fill();
}

/** Draw every marker. opts.selected = id of the marker to emphasise. */
export function drawMarkers(g, layout, view, opts = {}) {
  const { sp } = view, lw = Math.max(1.5, 0.16 * sp);
  g.save();
  g.lineCap = 'round'; g.lineJoin = 'round';
  for (const it of geometry(layout, view)) {
    const sel = opts.selected === it.id;
    g.strokeStyle = it.color; g.fillStyle = it.color;
    g.lineWidth = sel ? lw * 2 : lw;
    g.setLineDash(it.lost ? [0.5 * sp, 0.35 * sp] : []);
    if (it.kind === 'clip') {
      for (const s of it.segs) {
        g.beginPath();
        if (!s.cutL) { g.moveTo(s.x0, s.y + s.tick); g.lineTo(s.x0, s.y); } else g.moveTo(s.x0, s.y);
        g.lineTo(s.x1, s.y1);
        if (!s.cutR) g.lineTo(s.x1, s.y1 + s.tick);
        g.stroke();
        if (s.cutR) arrowHead(g, s.x1 + 0.3 * sp, s.y1, 0, 0.45 * sp); // continues on the next line
      }
    } else {
      const { a, b } = it;
      g.beginPath();
      if (it.same) {
        const top = Math.min(a.y, b.y) - it.lift;
        g.moveTo(a.x, a.y); g.bezierCurveTo(a.x, top, b.x, top, b.x, b.y); g.stroke();
        g.setLineDash([]); arrowHead(g, b.x, b.y, Math.PI / 2, 0.6 * sp); // the curve ends straight down onto the target
      } else {
        if (a) { g.moveTo(a.x, a.y); g.quadraticCurveTo(a.x, a.y - it.lift, a.x + 1.4 * sp, a.y - it.lift); g.stroke(); g.setLineDash([]); arrowHead(g, a.x + 1.4 * sp, a.y - it.lift, 0, 0.55 * sp); }
        if (b) { g.beginPath(); g.setLineDash(it.lost ? [0.5 * sp, 0.35 * sp] : []); g.moveTo(b.x - 1.4 * sp, b.y - it.lift); g.quadraticCurveTo(b.x, b.y - it.lift, b.x, b.y); g.stroke(); g.setLineDash([]); arrowHead(g, b.x, b.y, Math.PI / 2, 0.55 * sp); }
      }
    }
    // label chip
    g.setLineDash([]);
    const l = it.label;
    g.globalAlpha = sel ? 1 : 0.92;
    g.fillStyle = it.color; roundRect(g, l.x, l.y, l.w, l.h, l.h / 2.5); g.fill();
    g.globalAlpha = 1; g.fillStyle = '#fff';
    g.font = `600 ${Math.round(l.fontPx)}px system-ui, sans-serif`; g.textBaseline = 'middle'; g.textAlign = 'left';
    g.fillText(l.text, l.x + l.fontPx * 0.4, l.y + l.h / 2 + 0.5);
    if (sel) { g.strokeStyle = it.color; g.lineWidth = 2; roundRect(g, l.x - 3, l.y - 3, l.w + 6, l.h + 6, l.h / 2); g.stroke(); }
  }
  g.restore();
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r); g.lineTo(x + w, y + h - r);
  g.quadraticCurveTo(x + w, y + h, x + w - r, y + h); g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r); g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y); g.closePath();
}

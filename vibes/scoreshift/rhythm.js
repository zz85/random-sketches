// Rhythm symbols on the staff-removed page (pixel side, runs inside analyze in the worker):
//  - beams and flags on every stem -> the written value of each chord
//  - rests, time signatures and tuplet numbers, by template matching against the SMuFL glyphs
//    of five engraving fonts (glyphs.js), rasterized at the normalized staff space
//  - ties (arcs joining two heads at the same position) and grace notes (small heads)
// Results are annotations on the analysis model: note.dur/beams/flags/grace/tie, st.rests,
// st.times, st.tuplets. Measures and bar-fill repair are built from these in score.js.
import { GLYPHS } from './glyphs.js';
import { rasterGlyph, descriptor, shapeDistance } from './raster.js';
import { lineY, yOfP, pOfY, spaceAt, TARGET } from './omr.js';
import { classify } from './glyphnet.js';
import { DYN_TEMPLATES } from './dynamics.js';
import { shapeDistance as shapeDist } from './raster.js';

const CLASSES = {
  rest: ['restWhole', 'restQuarter', 'rest8th', 'rest16th', 'rest32nd'],
  digit: ['timeSig0', 'timeSig1', 'timeSig2', 'timeSig3', 'timeSig4', 'timeSig5', 'timeSig6', 'timeSig7', 'timeSig8', 'timeSig9'],
  meterSym: ['timeSigCommon', 'timeSigCutCommon'],
  tuplet: ['tuplet3', 'tuplet5', 'tuplet6'],
};
let TEMPLATES = null;
export function templates() {
  if (TEMPLATES) return TEMPLATES;
  TEMPLATES = [];
  for (const font of Object.keys(GLYPHS)) for (const [cls, names] of Object.entries(CLASSES)) for (const name of names) {
    const g = GLYPHS[font][name]; if (!g) continue;
    const r = rasterGlyph(g.d, TARGET), dsc = descriptor(r.m, r.w, r.h);
    if (dsc) TEMPLATES.push({ font, cls, name, dsc, hS: dsc.bh / TARGET, wS: dsc.bw / TARGET });
  }
  return TEMPLATES;
}

// best template of a class family for a component mask: { name, dist, cls }
function match(mask, cw, ch, families, S) {
  const d = descriptor(mask, cw, ch); if (!d) return null;
  let best = null; const all = {};
  for (const T of templates()) {
    if (!families.includes(T.cls)) continue;
    // size matters within a family (a 16th rest is taller than an 8th); across fonts it varies
    const dist = shapeDistance(d, T.dsc) + 0.25 * Math.abs(Math.log(d.bh / S / T.hS));
    if (!(T.name in all) || dist < all[T.name]) all[T.name] = dist;
    if (!best || dist < best.dist) best = { name: T.name, cls: T.cls, dist };
  }
  if (best) best.all = all; // best distance per glyph name
  return best;
}

// Meters that actually occur, for choosing between digit readings of similar distance
const COMMON_METERS = new Set(['2/2', '3/2', '4/2', '2/4', '3/4', '4/4', '5/4', '6/4', '3/8', '6/8', '9/8', '12/8', '5/8', '7/8', '2/8', '4/8', '6/16', '9/16', '12/16', '7/4', '1/4']);
function readMeter(top, bot) {
  if (!top.length || !bot.length || top.length > 2 || bot.length > 2 || [...top, ...bot].some((d) => !d)) return null;
  const opts = (ds) => { // candidate numbers with their worst digit distance
    let out = [['', 0]];
    for (const d of ds) { const nx = []; for (const [s, w] of out) for (let v = 0; v <= 9; v++) { const dist = d.all['timeSig' + v]; if (dist != null && dist < d.dist + 0.12) nx.push([s + v, Math.max(w, dist)]); } out = nx; }
    return out.filter(([s]) => s[0] !== '0');
  };
  let best = null;
  for (const [b, db] of opts(top)) for (const [u, du] of opts(bot)) {
    if (![1, 2, 4, 8, 16, 32].includes(+u)) continue;
    const dist = Math.max(db, du), score = dist + (COMMON_METERS.has(b + '/' + u) ? 0 : 0.1);
    if (!best || score < best.score) best = { beats: +b, unit: +u, dist, score };
  }
  return best && best.dist < 0.5 ? { beats: best.beats, unit: best.unit, dist: best.dist } : null;
}

const RARE_DYN = new Set(['rf', 'rfz', 'sffz', 'sfp']); // read only when clearly better
const REST_DUR = { restWhole: 1, restQuarter: 4, rest8th: 8, rest16th: 16, rest32nd: 32 };
const DIGIT = (name) => +name.slice(-1);

export function readRhythm({ w, h, S0, t, staves, notes, L, comps, accs, dots, headComps, bin, useNet = true, textIds = new Set() }) {
  const ink = (x, y) => x >= 0 && y >= 0 && x < w && y < h && L[y * w + x] > 0;
  // ---------------------------------------------------------------- stems: beams and flags
  // vertical ink runs in column x between y0 and y1 (either order), as [start, len] from y0
  const runs = (x, y0, y1) => {
    const dir = y1 >= y0 ? 1 : -1, out = []; let s = -1;
    for (let y = Math.round(y0), k = 0; dir > 0 ? y <= y1 : y >= y1; y += dir, k++) {
      if (ink(x, y)) { if (s < 0) s = k; } else if (s >= 0) { out.push([s, k - s]); s = -1; }
    }
    if (s >= 0) out.push([s, Math.round(Math.abs(y1 - y0)) + 1 - s]);
    return out;
  };
  // head widths per staff: grace notes are clearly smaller than the staff's typical head
  for (const st of staves) {
    const ws = notes.filter((n) => n.st === st && n.kind === 'black').map((n) => n.box[2] - n.box[0]).sort((a, b) => a - b);
    st.headW = ws.length ? ws[ws.length >> 1] : 1.2 * S0;
  }
  const chords = new Map();
  for (const n of notes) { const k = n.st.index + ':' + n.chord; if (!chords.has(k)) chords.set(k, []); chords.get(k).push(n); }
  for (const ch of chords.values()) {
    const st = ch[0].st, S = spaceAt(st, ch[0].x);
    const withStem = ch.filter((n) => n.stem);
    // grace (cue) notes: smaller heads on shorter stems than the staff's own
    const grace = withStem.length > 0 && ch.every((n) => n.small || n.box[2] - n.box[0] < 0.86 * st.headW) && Math.max(...withStem.map((n) => n.stem.len)) < (ch.every((n) => n.small) ? 2.75 : 2.7) * S;
    let dur, beams = 0, flags = 0, beamed = false;
    if (!withStem.length) dur = 1;
    else if (ch.every((n) => n.kind === 'half')) dur = 2;
    else {
      const dir = withStem[0].stem.dir, sx = withStem[0].stem.x;
      const tip = dir < 0 ? Math.min(...withStem.map((n) => n.stem.tip)) : Math.max(...withStem.map((n) => n.stem.tip));
      const near = Math.min(...ch.map((n) => Math.abs(n.y - tip))); // head closest to the tip
      // scan from just beyond the tip toward the heads, stopping a space short of them
      const a = tip + dir * 0.25 * S, len = Math.max(0, near - 1.0 * S + 0.25 * S), b = a - dir * len;
      const k = (r) => Math.max(1, Math.round((r + 0.25 * S) / (0.75 * S)));
      const side = (sd) => {
        const cols = [0.6, 1.1, 1.6].map((o) => runs(Math.round(sx + sd * o * S), a, b).filter((r) => r[1] >= 0.3 * S));
        const isBeam = cols.every((c) => c.length && c[0][0] <= 1.4 * S);
        // beams stack from the stem end, a quarter space apart: a run further off (a slur
        // passing over the beam) ends the stack
        let count = 0, end = -Infinity;
        for (const r of cols[0]) { if (r[0] > 3.2 * S || (count && r[0] - end > 0.33 * S)) break; if (r[1] < 0.36 * S) continue; count += k(r[1]); end = r[0] + r[1]; }
        return { isBeam, count };
      };
      const L_ = side(-1), R_ = side(1);
      if (L_.isBeam || R_.isBeam) { beamed = true; beams = Math.max(L_.isBeam ? L_.count : 0, R_.isBeam ? R_.count : 0); }
      else { // flags hang on the right of the stem, one crossing each in a column beside it
        flags = Math.max(...[0.55, 0.75, 0.95].map((o) => runs(Math.round(sx + o * S), a, b).filter((r) => r[1] >= 0.2 * S && r[0] <= 2.2 * S).length));
      }
      dur = 4 * 2 ** Math.min(3, beams + flags);
    }
    // a head found only by the small-head pass must look like a grace note: short stem with a
    // flag, beam or slash; anything else there is a fragment (flag piece, dot, letter) and is dropped
    // ... and must not sit against another note's stem (beam stubs, flags of a full-size note)
    const onStem = ch.some((n) => notes.some((o) => !o.small && o.stem && o.st === st && o.stem.x >= n.box[0] - 0.45 * S && o.stem.x <= n.box[2] + 0.45 * S &&
      n.y > Math.min(o.y, o.stem.tip) - 0.3 * S && n.y < Math.max(o.y, o.stem.tip) + 0.3 * S));
    if (ch.every((n) => n.small) && (!grace || (!flags && !beamed) || onStem)) { for (const n of ch) n.dropSmall = true; continue; }
    // a small head in a chord with full-size ones is a fragment beside the chord, never a note
    if (ch.some((n) => n.small) && ch.some((n) => !n.small)) for (const n of ch) if (n.small) n.dropSmall = true;
    const nd = Math.min(2, Math.max(0, ...ch.map((n) => (n.dots || []).length)));
    for (const n of ch) Object.assign(n, { dur, dots: n.dots, ndots: nd, beams, flags, beamed, grace });
  }

  for (let k = notes.length - 1; k >= 0; k--) if (notes[k].dropSmall) { const n = notes[k], i = n.st.notes.indexOf(n); if (i >= 0) n.st.notes.splice(i, 1); headComps.delete(n.comp); notes.splice(k, 1); }
  // ---------------------------------------------------------------- free symbols
  const used = new Set([...headComps, ...textIds]); // (letters of words are never rests, digits or marks)
  for (const st of staves) { st.key.ids.forEach((i) => used.add(i)); (st.keyChanges || []).forEach((k) => k.ids.forEach((i) => used.add(i))); st.bars.forEach((b) => b.ids.forEach((i) => used.add(i))); (st.clef.ids || []).forEach((i) => used.add(i)); }
  // accidentals that belong to a note (an unattached "flat" is often an 8th rest)
  for (const n of notes) n.accid?.ids.forEach((i) => used.add(i));
  for (const n of notes) n.dots?.forEach((d) => d.ids.forEach((i) => used.add(i)));
  const staffOf = (c) => staves.find((st) => c.cx >= st.x0 - S0 && c.cx <= st.x1 + S0 && c.cy >= st.band[0] && c.cy < st.band[1]);
  // mask of a component or a group (c.ids); rows a removed staff line cut out of a symbol are
  // filled back where there is ink just above and just below them
  const maskOf = (c) => {
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1, m = new Uint8Array(cw * ch), ids = c.ids || [c.id];
    for (let y = c.y0; y <= c.y1; y++) for (let x = c.x0; x <= c.x1; x++) if (ids.includes(L[y * w + x])) m[(y - c.y0) * cw + x - c.x0] = 1;
    if (ids.length > 1) {
      const gap = Math.ceil(t) + 3;
      for (let x = 0; x < cw; x++) for (let y = 1; y < ch; y++) {
        if (m[y * cw + x] || !m[(y - 1) * cw + x]) continue;
        let e = y; while (e < ch && !m[e * cw + x] && e - y < gap) e++;
        if (e < ch && m[e * cw + x]) for (let k = y; k < e; k++) m[k * cw + x] = 1;
      }
    }
    return { m, cw, ch };
  };
  // a hairpin: two thin strokes meeting at one end; the open end has two ink runs a good half
  // space apart, the closed end one, the middle two
  const hairpinForm = (c, S) => {
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    if (cw < 2.5 * S || ch > 1.8 * S || ch < 0.35 * S || c.n / (cw * ch) > 0.45) return null;
    // the gap between the two strokes grows steadily from one end to the other
    const M = maskOf(c).m, at = (fx) => { const x = Math.min(cw - 1, Math.max(0, Math.round(fx * (cw - 1)))); let a = -1, b = -1, n = 0, inside = false; for (let y = 0; y < ch; y++) { const v = M[y * cw + x]; if (v) { if (a < 0) a = y; b = y; if (!inside) n++; } inside = !!v; } return { n, span: a < 0 ? null : b - a }; };
    const xs = [0.12, 0.3, 0.5, 0.7, 0.88].map(at);
    if (xs.some((q) => q.span == null) || at(0.5).n !== 2) return null;
    const sp = xs.map((q) => q.span), inc = sp.every((v, i) => !i || v >= sp[i - 1] - 1), dec = sp.every((v, i) => !i || v <= sp[i - 1] + 1);
    const lo = Math.min(sp[0], sp[4]), hi = Math.max(sp[0], sp[4]);
    if (hi - lo < 0.45 * S || lo > 0.45 * S) return null;
    return inc && sp[4] > sp[0] ? 'cresc' : dec && sp[0] > sp[4] ? 'dim' : null;
  };
  for (const st of staves) { st.rests = []; st.times = []; st.tuplets = []; }
  readTimes();
  const arcs = [];
  // Time signatures: right after the key signature, or right after a barline. The two digits
  // touch the middle line, so staff removal fuses them (and can split one): read the ink of
  // the region as a top half and a bottom half, each a number of column-separated digits.
  // A second pass at the start of a staff lets the digits take components already read as
  // noteheads (a 4's closed triangle passes for a filled head); those notes are then dropped.
  function readTimes() {
    const fixed = new Set(); // key signatures, barlines, clefs: never part of a time signature
    for (const st of staves) { st.key.ids.forEach((i) => fixed.add(i)); (st.keyChanges || []).forEach((k) => k.ids.forEach((i) => fixed.add(i))); st.bars.forEach((b) => b.ids.forEach((i) => fixed.add(i))); (st.clef.ids || []).forEach((i) => fixed.add(i)); }
    for (const st of staves) {
      const S = spaceAt(st, st.x0), anchors = [st.key.x1 + 1, ...st.bars.map((b) => b.x1 + 1)];
      for (const [ai, ax] of anchors.entries()) for (const heads of ai === 0 ? [false, true] : [false]) {
        if (heads && st.times.length) continue;
        const firstNote = heads ? st.x1 : Math.min(st.x1, ...st.notes.filter((n) => n.box[0] > ax).map((n) => n.box[0] - 0.2 * S));
        const xl = ax, xr = Math.min(firstNote, ax + 4.5 * S);
        const yt = lineY(st, 0, ax), yb = lineY(st, 4, ax), ym = lineY(st, 2, ax);
        const cl = comps.filter((c) => c && (!used.has(c.id) || (heads && !fixed.has(c.id))) && c.x0 >= xl - 0.2 * S && c.x0 < xr && c.x1 < xr + 2 * S && c.y1 > yt - 0.6 * S && c.y0 < yb + 0.6 * S && c.y1 - c.y0 < 7.5 * S);
        if (!cl.length) continue;
        // keep the run of glyphs starting at the anchor (no wide gaps)
        cl.sort((a, b) => a.x0 - b.x0);
        const grp = []; let gx = xl;
        for (const c of cl) { if (c.x0 - gx > 1.2 * S) break; grp.push(c); gx = Math.max(gx, c.x1); }
        if (!grp.length) continue;
        const X0 = Math.min(...grp.map((c) => c.x0)), X1 = Math.max(...grp.map((c) => c.x1)), Y0 = Math.min(...grp.map((c) => c.y0)), Y1 = Math.max(...grp.map((c) => c.y1));
        if (X1 - X0 > 3.6 * S || Y1 - Y0 < 1.5 * S) continue;
        const ids = new Set(grp.map((c) => c.id));
        const half = (ya, yz) => { // one number in rows [ya, yz): one digit, or two side by side
          ya = Math.round(ya); yz = Math.round(yz);
          const cw = X1 - X0 + 1, ch = Math.max(1, yz - ya), m = new Uint8Array(cw * ch), colInk = new Uint16Array(cw);
          for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) { const yy = ya + y; if (yy >= 0 && yy < h && ids.has(L[yy * w + X0 + x])) { m[y * cw + x] = 1; colInk[x]++; } }
          const cut = (s0, s1) => { const dw = s1 - s0, dm = new Uint8Array(dw * ch); for (let y = 0; y < ch; y++) for (let k = 0; k < dw; k++) dm[y * dw + k] = m[y * cw + s0 + k]; return match(dm, dw, ch, ['digit'], S); };
          const pieces = []; let x = 0;
          while (x < cw) { while (x < cw && colInk[x] === 0) x++; if (x >= cw) break; const s0 = x; while (x < cw && colInk[x] > 0) x++; pieces.push([s0, x]); }
          if (!pieces.length) return [];
          const one = [cut(pieces[0][0], pieces[pieces.length - 1][1])];
          // two digits: split at the widest gap, both halves digit-sized
          let two = null;
          if (pieces.length >= 2) {
            let g = 1; for (let k = 2; k < pieces.length; k++) if (pieces[k][0] - pieces[k - 1][1] > pieces[g][0] - pieces[g - 1][1]) g = k;
            const a = [pieces[0][0], pieces[g - 1][1]], b = [pieces[g][0], pieces[pieces.length - 1][1]];
            if (a[1] - a[0] >= 0.45 * S && b[1] - b[0] >= 0.45 * S) two = [cut(...a), cut(...b)];
          }
          const worst = (ds) => Math.max(...ds.map((d) => (d ? d.dist : 9)));
          return two && worst(two) < worst(one) ? two : one;
        };
        const top = half(Math.min(Y0, yt - 0.3 * S), ym), bot = half(ym, Math.max(Y1, yb + 0.3 * S) + 1);
        let tsig;
        tsig = readMeter(top, bot);
        if (tsig && ai > 0 && tsig.dist > 0.42) tsig = null; // a change mid-staff must read cleanly
        if (!tsig && Y1 - Y0 > 1.6 * S && Y1 - Y0 < 2.7 * S && X1 - X0 > 1.0 * S && X1 - X0 < 2.4 * S && Math.abs((Y0 + Y1) / 2 - ym) < 0.6 * S) { // C, cut C
          const cw = X1 - X0 + 1, ch = Y1 - Y0 + 1, m = new Uint8Array(cw * ch);
          for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) if (ids.has(L[y * w + x])) m[(y - Y0) * cw + x - X0] = 1;
          const g = match(m, cw, ch, ['meterSym', 'digit', 'rest'], S);
          if (g && g.cls === 'meterSym' && g.dist < (ai ? 0.3 : 0.4)) tsig = g.name === 'timeSigCommon' ? { beats: 4, unit: 4, sym: 'common', dist: g.dist } : { beats: 2, unit: 2, sym: 'cut', dist: g.dist };
        }
        if (!tsig) continue;
        if (heads && tsig.dist > 0.36) continue;
        // the stroke of a cut C passes for a barline
        if (tsig.sym === 'common') { const k = st.bars.findIndex((b) => Math.abs(b.x - (X0 + X1) / 2) < 0.3 * (X1 - X0)); if (k >= 0) { tsig = { beats: 2, unit: 2, sym: 'cut' }; grp.push(...st.bars[k].ids.map((i) => comps[i])); st.bars.splice(k, 1); } }
        for (const c of grp) ids.add(c.id);
        st.times.push({ x: (X0 + X1) / 2, x0: X0, x1: X1, ...tsig, ids: [...ids] });
        for (const i of ids) used.add(i);
        // accidentals in it are gone with it, notes are dropped
        for (let k = accs.length - 1; k >= 0; k--) if (accs[k].c.ids.some((i) => ids.has(i))) accs.splice(k, 1);
        if (heads) for (let k = notes.length - 1; k >= 0; k--) if (ids.has(notes[k].comp)) { st.notes.splice(st.notes.indexOf(notes[k]), 1); headComps.delete(notes[k].comp); notes.splice(k, 1); }
      }
    }
  }
  // pieces of one symbol split by staff-line removal: overlapping columns, a line-thick gap
  // between them at a staff line
  const free = comps.filter((c) => c && (!used.has(c.id) || textIds.has(c.id)) && c.n >= 3).sort((a, b) => a.y0 - b.y0);
  const parent = new Map(free.map((c) => [c.id, c]));
  const root = (c) => { while (parent.get(c.id) !== c) c = parent.get(c.id); return c; };
  for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
    const a = free[i], b = free[j];
    if (b.y0 - a.y1 > Math.ceil(t) + 3) continue;
    if (b.y0 < a.y1 - 2 || Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) < 0.25 * Math.min(a.x1 - a.x0 + 1, b.x1 - b.x0 + 1)) continue;
    const st = staffOf(b); if (!st) continue;
    const yg = (a.y1 + b.y0) / 2;
    if (b.y0 - a.y1 > 1 && ![0, 1, 2, 3, 4].some((k) => Math.abs(lineY(st, k, (b.x0 + b.x1) / 2) - yg) <= t + 1)) continue; // (or touching corners)
    const ra = root(a), rb = root(b); if (ra !== rb) parent.set(rb.id, ra);
  }
  const groups = new Map();
  for (const c of free) { const r = root(c); if (!groups.has(r.id)) groups.set(r.id, []); groups.get(r.id).push(c); }
  const syms = [...groups.values()].map((cs) => cs.length === 1 ? cs[0] : {
    id: cs[0].id, ids: cs.map((c) => c.id), x0: Math.min(...cs.map((c) => c.x0)), y0: Math.min(...cs.map((c) => c.y0)), x1: Math.max(...cs.map((c) => c.x1)), y1: Math.max(...cs.map((c) => c.y1)),
    n: cs.reduce((s, c) => s + c.n, 0), cx: cs.reduce((s, c) => s + c.cx * c.n, 0) / cs.reduce((s, c) => s + c.n, 0), cy: cs.reduce((s, c) => s + c.cy * c.n, 0) / cs.reduce((s, c) => s + c.n, 0) });
  // Articulations: staccato dot, tenuto dash, accent wedge, centred on a chord, beyond its
  // outermost head on the side away from the stem (or past a whole note, either side), within
  // 2.6 spaces (accents 3.4, they go above the staff); an accent may also sit beyond the stem end. Read before the other free
  // symbols so the dots and dashes are not taken for anything else.
  for (const n of notes) n.artic = [];
  const chordsOf = new Map(); for (const n of notes) { const k = n.st.index + ':' + n.chord; if (!chordsOf.has(k)) chordsOf.set(k, []); chordsOf.get(k).push(n); }
  const markKind = (c, S) => {
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1, W = cw / S, H = ch / S, fill = c.n / (cw * ch);
    if (W >= 0.2 && W <= 0.6 && H >= 0.2 && H <= 0.6 && fill > 0.5 && W / H > 0.6 && W / H < 1.7) return 'stacc';
    if (W >= 0.65 && W <= 1.7 && ch <= Math.max(0.36 * S, 2.2 * t + 2) && H >= 0.08 && fill > 0.7) return 'ten';
    if (W >= 0.75 && W <= 1.9 && H >= 0.4 && H <= 1.15 && fill > 0.12 && fill < 0.6) {
      // a wedge opening left: the right end's ink sits at mid height, the left end's at top and bottom
      const M = maskOf(c).m, col = (fx) => { const x = Math.min(cw - 1, Math.round(fx * (cw - 1))), ys = []; for (let y = 0; y < ch; y++) if (M[y * cw + x]) ys.push(y / (ch - 1)); return ys; };
      const r = col(0.95), l = col(0.05), mid = (ys) => ys.length && ys.every((y) => y > 0.25 && y < 0.75), ends = (ys) => ys.some((y) => y < 0.3) && ys.some((y) => y > 0.7) && !ys.some((y) => y > 0.4 && y < 0.6);
      if (mid(r) && ends(l)) return 'acc';
    }
    return null;
  };
  for (const c of syms) {
    if (!c || used.has(c.id)) continue;
    const st = staffOf(c); if (!st) continue;
    const S = spaceAt(st, c.cx), kind = markKind(c, S); if (!kind) continue;
    let best = null;
    for (const ns of chordsOf.values()) {
      if (ns[0].st !== st) continue;
      const x = ns.reduce((q, n) => q + n.x, 0) / ns.length;
      if (Math.abs(c.cx - x) > (kind === 'stacc' ? 0.5 : 0.7) * S) continue;
      const stem = ns.find((n) => n.stem)?.stem, top = Math.min(...ns.map((n) => n.y)), bot = Math.max(...ns.map((n) => n.y));
      // head side: below when the stem goes up, above when it goes down; past the stem end otherwise
      const sides = stem ? (stem.dir < 0 ? [c.cy - bot, top - c.cy - (top - stem.tip)] : [top - c.cy, c.cy - bot - (stem.tip - bot)]) : [c.cy - bot, top - c.cy];
      // (dots and dashes beyond the stem end are mostly pieces of tuplet numbers and fingerings)
      const d = kind === 'acc' || !stem ? Math.max(...sides) : sides[0];
      if (d < 0.45 * S || d > (kind === "acc" ? 3.4 : 2.6) * S) continue;
      if (!best || d < best.d) best = { d, ns };
    }
    if (!best) continue;
    for (const n of best.ns) if (!n.artic.includes(kind)) n.artic.push(kind);
    used.add(c.id); (c.ids || [c.id]).forEach((i) => used.add(i));
  }
  // ---------------------------------------------------------------- dynamics and words
  // Expression text outside the staff: components grouped into words (similar height band,
  // gaps under half a space), each word matched against the dynamics and expression-word templates.
  // A dynamic that matches clearly better than any word attaches to the chord it starts under.
  for (const st of staves) { st.dynamics = []; st.words = []; }
  const isText = (c) => (c.ids || [c.id]).some((i) => textIds.has(i));
  const cand = syms.filter((c) => c && (!used.has(c.id) || isText(c)) && !headComps.has(c.id)).filter((c) => {
    const st = staffOf(c); if (!st) return false;
    const S = spaceAt(st, c.cx), H = (c.y1 - c.y0 + 1) / S, W = (c.x1 - c.x0 + 1) / S;
    if (H < 0.35 || H > 3.2 || W > 3.8) return false;
    // (ties, slurs and hairpins are not text: thin, wide, mostly empty boxes)
    const fill = c.n / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1));
    if (!isText(c) && W >= 0.9 && H <= Math.max(1.4, 0.35 * W) && fill < 0.5 && c.n / (c.x1 - c.x0 + 1) < 0.45 * S) return false;
    return (c.y0 > lineY(st, 4, c.cx) - 0.1 * S && c.cy > lineY(st, 4, c.cx) + 0.6 * S) || (c.y1 < lineY(st, 0, c.cx) + 0.1 * S && c.cy < lineY(st, 0, c.cx) - 0.6 * S);
  }).sort((a, b) => a.x0 - b.x0);
  // A dynamic touching a stem that runs below (or above) the staff is part of that note's
  // component: cut the stem's columns out and take what is left beyond the staff as candidates.
  for (const n of notes) {
    const sm = n.stem; if (!sm || n.chord == null) continue;
    const st = n.st, S = spaceAt(st, n.x), yb = lineY(st, 4, sm.x), yt = lineY(st, 0, sm.x);
    const lo = sm.dir > 0 ? Math.max(yb + 0.5 * S, n.y + 0.8 * S) : sm.tip - 2.5 * S, hi = sm.dir > 0 ? sm.tip + 2.5 * S : Math.min(yt - 0.5 * S, n.y - 0.8 * S);
    if (hi - lo < 0.8 * S) continue;
    const x0 = Math.round(sm.x - 2.2 * S), x1 = Math.round(sm.x + 2.2 * S), px = [];
    for (let y = Math.round(lo); y <= Math.round(hi); y++) for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= w || y < 0 || y >= h || L[y * w + x] !== n.comp || Math.abs(x - sm.x) <= Math.ceil(t) + 1) continue;
      // (not a beam: long horizontal runs)
      let a = x, b = x; while (a > 0 && L[y * w + a - 1] === n.comp && x - a < 2 * S) a--; while (b < w - 1 && L[y * w + b + 1] === n.comp && b - x < 2 * S) b++;
      if (b - a > 1.3 * S) continue;
      px.push([x, y]);
    }
    if (px.length < 0.25 * S * S) continue;
    const xs = px.map((p) => p[0]), ys = px.map((p) => p[1]);
    const q = { id: -n.comp, px, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), n: px.length };
    q.cx = (q.x0 + q.x1) / 2; q.cy = (q.y0 + q.y1) / 2;
    if ((q.y1 - q.y0) / S < 0.8 || (q.x1 - q.x0) / S < 0.5 || cand.some((c) => c.id === q.id)) continue;
    cand.push(q);
  }
  cand.sort((a, b) => a.x0 - b.x0);
  const taken = new Set();
  for (const c0 of cand) {
    if (taken.has(c0)) continue;
    const st = staffOf(c0), S = spaceAt(st, c0.cx), word = [c0];
    let box = [c0.x0, c0.y0, c0.x1, c0.y1];
    for (const q of cand) {
      if (taken.has(q) || word.includes(q) || staffOf(q) !== st || q.x0 < box[0]) continue;
      if (q.x0 - box[2] > 0.5 * S) continue;
      const ov = Math.min(box[3], q.y1) - Math.max(box[1], q.y0);
      if (ov < 0.3 * Math.min(box[3] - box[1], q.y1 - q.y0)) continue;
      word.push(q); box = [Math.min(box[0], q.x0), Math.min(box[1], q.y0), Math.max(box[2], q.x1), Math.max(box[3], q.y1)];
    }
    word.forEach((q) => taken.add(q));
    const cw = box[2] - box[0] + 1, ch = box[3] - box[1] + 1, m = new Uint8Array(cw * ch), ids = new Set(word.filter((q) => !q.px).flatMap((q) => q.ids || [q.id]));
    for (let y = box[1]; y <= box[3]; y++) for (let x = box[0]; x <= box[2]; x++) if (ids.has(L[y * w + x])) m[(y - box[1]) * cw + x - box[0]] = 1;
    for (const q of word) if (q.px) for (const [x, y] of q.px) m[(y - box[1]) * cw + x - box[0]] = 1;
    const d = descriptor(m, cw, ch); if (!d) continue;
    let bestD = null, bestW = null;
    for (const T of DYN_TEMPLATES) {
      const dist = shapeDist(d, { g: T.g, bw: T.ar, bh: 1 }) + (T.hS ? 0.2 * Math.abs(Math.log(d.bh / S / T.hS)) : 0);
      if (T.dyn) { const dd = dist + (RARE_DYN.has(T.text) ? 0.05 : 0); if (!bestD || dd < bestD.dist) bestD = { text: T.text, dist: dd }; } else if (!bestW || dist < bestW.dist) bestW = { text: T.text, dist };
    }
    // a lone digit (a tuplet number, a fingering) is not a word
    if (word.length === 1) { const gd = match(m, cw, ch, ['tuplet', 'digit'], S); if (gd && (!bestD || gd.dist < bestD.dist + 0.03)) { word.forEach((q) => taken.delete(q)); continue; } }
    const below = box[1] > lineY(st, 4, (box[0] + box[2]) / 2) - 0.2 * S;
    if (globalThis.DYN) globalThis.DYN.push({ st: st.index, box, d: bestD, w: bestW });
    if (bestD && bestD.dist < 0.3 && (!bestW || bestD.dist < bestW.dist - 0.02) && (box[3] - box[1]) / S < 3.3) {
      // the chord at (or the first after) the dynamic's left part
      let n = null; for (const q of st.notes) if (q.x > box[0] - 1.0 * S && (!n || q.x < n.x)) n = q;
      st.dynamics.push({ text: bestD.text, dist: bestD.dist, box, note: n, below, ids: [...ids] });
    } else if (word.length >= 2 || (bestW && bestW.dist < 0.3)) st.words.push({ box, guess: bestW?.text, ids: [...ids] });
    ids.forEach((i) => used.add(i));
  }
  for (const c of syms) {
    if (!c || used.has(c.id)) continue;
    const st = staffOf(c); if (!st) continue;
    const S = spaceAt(st, c.cx), cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1, W = cw / S, H = ch / S;
    const yt = lineY(st, 0, c.cx), yb = lineY(st, 4, c.cx), fill = c.n / (cw * ch);
    if (st.clef.box && c.x1 < st.clef.box[2]) continue;
    const inside = c.cy > yt - 0.5 * S && c.cy < yb + 0.5 * S;
    // arcs (ties and slurs): wide, flat, thin
    // (a short flat tie fills most of its box; what makes an arc is that it is thin)
    if (W >= 0.9 && H <= Math.max(1.4, 0.35 * W) && (fill < 0.5 || (H <= 0.75 && fill < 0.9)) && c.n / cw < 0.45 * S && !hairpinForm(c, S)) { arcs.push({ st, c }); continue; }
    // whole / half rests: a solid slab hanging from a line (whole) or sitting on one (half); the
    // 4th and middle lines normally, any line or ledger position when a second voice moves it
    const near = c.cy > yt - 2.2 * S && c.cy < yb + 2.2 * S;
    if (near && W >= 0.8 && W <= 1.9 && H >= 0.3 && H <= 0.8 && fill > 0.88 && W / H >= 1.6) {
      const on = (y) => { for (let k = -2; k <= 6; k++) if (Math.abs(y - (yt + ((yb - yt) / 4) * k)) < 0.3 * S) return k; return null; };
      const top = on(c.y0), bot = on(c.y1);
      const whole = top != null && bot == null, half = bot != null && top == null;
      // usual places first: whole from the 2nd line, half on the 3rd
      const usual = (whole && top === 1) || (half && bot === 2);
      if ((whole || half) && (usual || !inside || Math.abs(c.cy - lineY(st, 2, c.cx)) > 0.8 * S)) st.rests.push({ x: c.cx, y: c.cy, dur: whole ? 1 : 2, box: [c.x0, c.y0, c.x1, c.y1], ids: c.ids || [c.id], displaced: !usual });
      continue;
    }
    if (W < 0.35 || W > 2.4 || H < 0.7 || H > 4.8) continue;
    const { m } = maskOf(c);
    // rests
    if (inside && H >= 1.2 && H <= 4.6 && W <= 1.7) {
      // competing readings of the value: template distances and the classifier's probabilities
      // combine into a score per value; the runners-up are kept as alternatives (a cost per
      // value) for the bar check to choose from
      const g = match(m, cw, ch, ['rest'], S);
      const pr = useNet && bin ? classify(bin, [c.x0, c.y0, c.x1, c.y1]) : null;
      const pRest = pr ? pr.rest4 + pr.rest8 + pr.rest16 : 0;
      if (g && g.name !== 'restWhole' && (g.dist < 0.36 || (pr && pRest > 0.95 && g.dist < 0.5))) {
        const sc = {};
        for (const [nm, d] of Object.entries(REST_DUR)) if (d >= 4) sc[d] = -6 * (g.all[nm] ?? 1) + (pr ? Math.log((pr['rest' + Math.min(16, d)] ?? 0) + 1e-3) : 0);
        const best = +Object.keys(sc).reduce((a, b) => (sc[b] > sc[a] ? b : a));
        const alt = {}; for (const d in sc) if (+d !== best) alt[d] = +(sc[best] - sc[d]).toFixed(2);
        st.rests.push({ x: c.cx, y: c.cy, dur: best, alt, box: [c.x0, c.y0, c.x1, c.y1], ids: c.ids || [c.id], dist: g.dist });
        continue;
      }
    }
    // tuplet numbers: small digits outside (or at the edge of) the staff
    if (H >= 0.7 && H <= 1.9 && W <= 1.5 && (c.y1 < yt + 0.6 * S || c.y0 > yb - 0.6 * S)) {
      const g = match(m, cw, ch, ['tuplet', 'digit'], S);
      if (g && g.dist < 0.36) { const v = DIGIT(g.name); if (v === 3 || v === 5 || v === 6) st.tuplets.push({ x: c.cx, y: c.cy, n: v, box: [c.x0, c.y0, c.x1, c.y1], ids: c.ids || [c.id], dist: g.dist }); }
    }
  }
  // dotted rests: an augmentation dot right of a rest
  for (const st of staves) for (const r of st.rests) {
    const S = spaceAt(st, r.x);
    r.dots = dots.filter((d) => d.st === st && !used.has(d.c.ids[0]) && d.c.cx > r.box[2] && d.c.cx - r.box[2] < 1.2 * S && d.c.cy > r.box[1] - 0.3 * S && d.c.cy < r.box[3] &&
      // (not the staccato of the next note: just above or below its head)
      !st.notes.some((n) => Math.abs(n.x - d.c.cx) < 0.8 * S && Math.abs(n.y - d.c.cy) < 1.6 * S)).length > 0 ? 1 : 0;
  }
  // Ties merged with something else (a phrase slur, a hairpin) are not components of their own:
  // between two neighbouring chords sharing a pitch, look for a thin curve of ink starting next
  // to the first head and ending next to the second, bowing away from the heads on one side.
  const tieBetween = (a, b, S) => {
    const xa = Math.round(a.box[2] + 0.1 * S), xb = Math.round(b.box[0] - 0.1 * S);
    if (xb - xa < 0.6 * S || xb - xa > 12 * S) return false;
    for (const side of [-1, 1]) {
      let hit = 0, last = null, ok = true, ys = [];
      for (let x = xa; x <= xb; x++) {
        // nearest ink beyond the head on this side, within 1.8 spaces
        let found = null;
        for (let d = Math.round(0.25 * S); d <= Math.round(1.8 * S); d++) { const y = Math.round(a.y + side * d); if (y >= 0 && y < h && L[y * w + x] && !headComps.has(L[y * w + x])) { found = y; break; } }
        if (found == null) continue;
        let run = 0; while (run < S && L[(found + side * run) * w + x]) run++;
        if (run > 0.45 * S) continue; // a stem, a thick symbol
        if (last != null && Math.abs(found - last) > 0.35 * S) { ok = false; break; }
        last = found; hit++; ys.push(Math.abs(found - a.y));
      }
      // (the curve's ends merge into the heads, which are skipped)
      if (!ok || hit < 0.6 * (xb - xa + 1) || ys.length < 3) continue;
      // a curve: nearer the heads at both ends than in the middle
      const n3 = Math.max(1, Math.floor(ys.length / 4)), ends = (ys.slice(0, n3).reduce((q, v) => q + v, 0) + ys.slice(-n3).reduce((q, v) => q + v, 0)) / (2 * n3), midv = Math.max(...ys);
      if (ys[0] < 1.3 * S && ys[ys.length - 1] < 1.3 * S && midv - ends > 0.08 * S) return true;
    }
    return false;
  };
  // ties: an arc from just right of one head to just left of the next head at the same position
  // (on the next chord of the staff). An arc running off the end of the staff ties over the
  // system break to the same note at the start of the next one.
  for (const n of notes) n.tie = false;
  for (const st of staves) {
    const S = spaceAt(st, (st.x0 + st.x1) / 2);
    for (const a of st.notes) {
      if (a.tie) continue;
      const b = st.notes.find((q) => q.chord === a.chord + 1 && q.p === a.p);
      if (b && tieBetween(a, b, S)) a.tie = true;
    }
  }
  for (const { st, c } of arcs) {
    const S = spaceAt(st, c.cx);
    const col = (x) => { for (let y = c.y0; y <= c.y1; y++) if (L[y * w + x] === c.id) return y; return c.cy; };
    const yl = col(c.x0), yr = col(c.x1);
    const ns = st.notes;
    for (const a of ns) {
      if (Math.abs(c.x0 - a.box[2]) > 1.2 * S && Math.abs(c.x0 - a.x) > 0.9 * S) continue;
      if (Math.abs(yl - a.y) > 2.0 * S) continue;
      const next = ns.filter((b) => b.chord === a.chord + 1);
      const b = next.find((q) => q.p === a.p && Math.abs(c.x1 - q.box[0]) < 1.4 * S && Math.abs(yr - q.y) < 2.0 * S);
      if (b) { a.tie = true; a.tieIds = [c.id]; c.isTie = true; break; }
      if (!next.length && c.x1 > st.x1 - 1.8 * S) { a.tie = true; a.tieIds = [c.id]; c.isTie = true; break; }
    }
  }

  // ---------------------------------------------------------------- slurs
  // Every other arc is a slur, from the chord nearest its left end to the one nearest its right
  // end (heads or stem ends within reach). An arc running off the end of the staff continues on
  // the next system; one starting at the left edge comes from the previous one.
  for (const st of staves) st.slurs = [];
  const ends = (st, x, y, S) => {
    let best = null;
    for (const n of st.notes) {
      const ys = [n.y, n.stem ? n.stem.tip : n.y], dx = Math.abs(n.x - x), dy = Math.min(...ys.map((v) => Math.abs(v - y)));
      if (dx > 2.2 * S || dy > 3.2 * S) continue;
      const d = dx + 0.5 * dy; if (!best || d < best.d) best = { d, n };
    }
    return best?.n || null;
  };
  for (const { st, c } of arcs) {
    if (c.isTie) continue;
    const S = spaceAt(st, c.cx), col = (x) => { for (let y = c.y0; y <= c.y1; y++) if (L[y * w + x] === c.id) return y; return c.cy; };
    // a slur cut into pieces by staff lines and barlines: follow small fragments along its
    // direction from the right end
    let ex = c.x1, ey = col(c.x1);
    const slope = (ey - col(Math.max(c.x0, Math.round(c.x1 - 0.2 * (c.x1 - c.x0))))) / Math.max(1, 0.2 * (c.x1 - c.x0));
    for (let grew = true; grew;) {
      grew = false;
      for (const q of comps) {
        if (!q || q.id === c.id || used.has(q.id) || headComps.has(q.id) || q.n > 120 || q.x0 <= ex - 1 || q.x0 - ex > 1.6 * S || q.y1 - q.y0 > 0.8 * S) continue;
        const py = ey + slope * ((q.x0 + q.x1) / 2 - ex);
        if (Math.abs((q.y0 + q.y1) / 2 - py) > 0.6 * S) continue;
        ex = q.x1; ey = (q.y0 + q.y1) / 2; grew = true; used.add(q.id); break;
      }
    }
    const a = ends(st, c.x0, col(c.x0), S), b = ends(st, ex, ey, S);
    const fromEdge = c.x0 < (st.key?.x1 ?? st.x0) + 1.5 * S, toEdge = ex > st.x1 - 1.8 * S;
    if ((!a && !fromEdge) || (!b && !toEdge) || (a && b && a.chord === b.chord)) continue;
    const yl = col(c.x0), yr = ey, above = c.y0 < Math.min(yl, yr) - 2;
    st.slurs.push({ from: a, to: b, open: !b, cont: !a, box: [c.x0, c.y0, ex, Math.max(c.y1, ey)], yl, yr, peak: above ? c.y0 : c.y1, above, ids: c.ids || [c.id] });
    used.add(c.id);
  }

  // ---------------------------------------------------------------- hairpins
  // Two thin strokes meeting at one end: wide, short, outside the staff. The open end has two ink
  // runs a good half space apart, the closed end one.
  for (const st of staves) st.hairpins = [];
  for (const c of syms) {
    if (!c || used.has(c.id)) continue;
    const st = staffOf(c); if (!st) continue;
    const S = spaceAt(st, c.cx);
    const yt = lineY(st, 0, c.cx), yb = lineY(st, 4, c.cx); if (c.y1 > yt - 0.3 * S && c.y0 < yb + 0.3 * S) continue;
    const form = hairpinForm(c, S);
    if (!form) continue;
    const near = (x) => { let best = null; for (const n of st.notes) { const d = Math.abs(n.x - x); if (!best || d < best.d) best = { d, n }; } return best && best.d < 3 * S ? best.n : null; };
    st.hairpins.push({ form, from: near(c.x0), to: near(c.x1), box: [c.x0, c.y0, c.x1, c.y1], ids: c.ids || [c.id] });
    used.add(c.id);
  }

}

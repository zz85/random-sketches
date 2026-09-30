// Engraving layout: score model -> positioned glyphs in staff-space units. No DOM.
//
// Spacing follows the logarithmic rule of thumb from Gourlay (1987) and Ross ("The Art
// of Music Engraving"): a note's space grows with log2 of its duration, so a half
// note is not twice as wide as a quarter. Columns are shared across staves by onset
// (grand staff alignment). Unfilled bars reserve room for the missing beats so there is
// always paper to write on, and systems are filled greedily then justified.
//
// y grows downward; a staff's top line is at `top`, bottom line at `top + 4`.
// Position p sits at y = top + 4 - p/2.
import { SMUFL } from './smufl.js';
import { DIV, spellScore, evTicks, measureCapacity } from './theory.js';

export const PAGE = { marginL: 1.6, marginR: 1.6, top: 7, staffDist: 11, sysGap: 10, minMeasure: 9 };

export const spacing = (t) => 1.2 + 1.9 * Math.log2(1 + t / (DIV / 2));
export const yOf = (top, pos) => top + 4 - pos / 2;
export const posOf = (top, y) => Math.round((top + 4 - y) * 2);

const REST_GLYPH = { 1: 'restWhole', 2: 'restHalf', 4: 'restQuarter', 8: 'rest8th', 16: 'rest16th', 32: 'rest32nd', 64: 'rest64th' };
const FLAG = { 8: '8th', 16: '16th', 32: '32nd', 64: '64th' };
const ACC_GLYPH = { '-2': 'accidentalDoubleFlat', '-1': 'accidentalFlat', 0: 'accidentalNatural', 1: 'accidentalSharp', 2: 'accidentalDoubleSharp' };
export const CLEF_GLYPH = { G: ['gClef', 2], F: ['fClef', 6], C: ['cClef', 4] };

export function glyphW(M, name) { const g = M.glyphs[name]; return g ? g.bb[2] - g.bb[0] : 1; }

function beatTicks(time) {
  if (time[1] >= 8 && time[0] % 3 === 0 && time[0] > 3) return (3 * 4 / time[1]) * DIV; // compound: dotted quarter
  if (time[1] === 2) return 2 * DIV;
  return (4 / time[1]) * DIV;
}

/** Beam groups for one staff of one measure: arrays of note events. */
export function beamGroups(events, time) {
  const beat = beatTicks(time), groups = [];
  let cur = [], t = 0, curBeat = -1, curId = null;
  const flush = () => { if (cur.length > 1) groups.push(cur); cur = []; curId = null; };
  for (const ev of events) {
    const b = Math.floor(t / beat);
    const beamable = ev.kind === 'note' && ev.dur >= 8;
    if (!beamable) flush();
    else {
      const sameExplicit = ev.beamId && ev.beamId === curId;
      if (cur.length && !sameExplicit && (b !== curBeat || ev.beam === 'break' || (curId && ev.beamId !== curId))) flush();
      if (!cur.length) { curBeat = b; curId = ev.beamId || null; }
      cur.push(ev);
    }
    t += evTicks(ev, time);
  }
  flush();
  return groups;
}

function stemUpFor(heads) {
  const lo = Math.min(...heads.map((h) => h.pos)), hi = Math.max(...heads.map((h) => h.pos));
  return (4 - lo) > (hi - 4);
}

/**
 * @param score  model from theory.js
 * @param opt    { width: page width in sp, font: 'Bravura'|'Petaluma' }
 */
export function layoutScore(score, opt) {
  const M = SMUFL.fonts[opt.font || 'Bravura'];
  const ED = M.engravingDefaults;
  const width = opt.width;
  const { spelled, fill, attrs } = spellScore(score);
  const nSt = score.staves.length;
  const headW = glyphW(M, 'noteheadBlack');
  const sysH = (nSt - 1) * PAGE.staffDist + 4;

  // ---- 1. columns and natural widths per measure
  const measures = score.measures.map((m, mi) => {
    const a = attrs[mi], cap = measureCapacity(a.time);
    const cols = new Map();
    m.staves.forEach((st, si) => {
      let t = 0;
      for (const ev of st.events) {
        const d = evTicks(ev, a.time);
        if (!cols.has(t)) cols.set(t, { t, items: [], len: d });
        const c = cols.get(t); c.items.push({ si, ev }); c.len = Math.min(c.len, d);
        t += d;
      }
    });
    const list = [...cols.values()].sort((x, y) => x.t - y.t);
    list.forEach((c, i) => {
      const next = list[i + 1] ? list[i + 1].t : c.t + c.len;
      c.w = spacing(next - c.t);
      let accCols = 0, dotW = 0, second = false;
      for (const { ev } of c.items) {
        if (ev.kind !== 'note') continue;
        const sp = spelled.get(ev) || [];
        accCols = Math.max(accCols, accidentalColumns(ev.heads.map((h, k) => ({ pos: h.pos, show: sp[k] && sp[k].showAcc }))));
        if (ev.dots) dotW = Math.max(dotW, 0.45 + 0.5 * ev.dots);
        const ps = ev.heads.map((h) => h.pos).sort((x, y) => x - y);
        for (let k = 1; k < ps.length; k++) if (ps[k] - ps[k - 1] === 1) second = true;
      }
      c.lead = accCols ? accCols * 1.15 + 0.2 : 0;
      c.w = Math.max(c.w, headW + 0.6 + dotW + (second ? headW : 0));
      if (c.items.some(({ ev }) => ev.full)) c.w = Math.max(c.w, 5);
    });
    const used = Math.max(...m.staves.map((st) => st.events.reduce((t, ev) => t + evTicks(ev, a.time), 0)), 0);
    const reserve = used < cap ? spacing(DIV) * (cap - used) / DIV * (used ? 0.9 : 0.75) : 0;
    const ch = a.changed;
    let header = 0;
    if (mi > 0) {
      if (ch.clefs.some(Boolean)) header += 3;
      if (ch.key) header += Math.max(1, Math.abs(a.key)) * 1.05 + 0.6;
      if (ch.time) header += timeSigWidth(M, a.time, a.timeSym) + 0.8;
    }
    const content = list.reduce((s, c) => s + c.lead + c.w, 0) + reserve;
    return { mi, a, cols: list, header, content: Math.max(content, PAGE.minMeasure), padL: 1.0, padR: 0.4, used, cap, fill: fill[mi] };
  });

  // ---- 2. line breaking + justification
  const systems = [];
  let i = 0, y = PAGE.top;
  while (i < measures.length) {
    const first = measures[i];
    const a = first.a;
    const clefW = 3.4, keyW = a.key ? Math.abs(a.key) * 1.05 + 0.6 : 0;
    const showTime = i === 0 || a.changed.time;
    const timeW = showTime ? timeSigWidth(M, a.time, a.timeSym) + 0.9 : 0;
    const header = 0.6 + clefW + keyW + timeW;
    const avail = width - PAGE.marginL - PAGE.marginR - header;
    const row = [];
    let sum = 0;
    while (i < measures.length) {
      const m = measures[i];
      const w = m.padL + m.padR + (row.length ? m.header : 0) + m.content;
      if (row.length && sum + w > avail) break;
      row.push(m); sum += w; i++;
    }
    const fixed = row.reduce((s, m, k) => s + m.padL + m.padR + (k ? m.header : 0), 0);
    const flex = sum - fixed;
    let factor = flex > 0 ? (avail - fixed) / flex : 1;
    if (i >= measures.length) factor = Math.min(factor, 1.15);
    systems.push({ index: systems.length, y, header, showTime, keyW, clefW, timeW, a, measures: row, factor, x0: PAGE.marginL, staffTops: Array.from({ length: nSt }, (_, s) => y + s * PAGE.staffDist) });
    y += sysH + PAGE.sysGap;
  }

  // ---- 3. positions (beamed notes share one stem direction, decided before placing heads)
  const evPos = new Map();
  const beams = [];
  const groupsOf = new Map(), forcedUp = new Map();
  for (const m of measures) for (let si = 0; si < nSt; si++) {
    const gs = beamGroups(score.measures[m.mi].staves[si].events, m.a.time);
    groupsOf.set(m.mi + ':' + si, gs);
    for (const g of gs) { const up = stemUpFor(g.flatMap((ev) => ev.heads)); for (const ev of g) forcedUp.set(ev.id, up); }
  }
  for (const sys of systems) {
    let x = sys.x0 + sys.header;
    sys.measures.forEach((m, k) => {
      m.sys = sys.index; m.x0 = x; m.headerX = x; x += m.padL + (k ? m.header : 0);
      m.contentX = x;
      m.showHeader = k > 0;
      for (const c of m.cols) {
        x += c.lead * Math.min(sys.factor, 1.3);
        c.x = x;
        for (const { si, ev } of c.items) evPos.set(ev.id, placeEvent(ev, spelled.get(ev) || [], c.x, sys.staffTops[si], M, headW, { mi: m.mi, si, sys: sys.index, colW: c.w * sys.factor }, forcedUp.get(ev.id)));
        x += c.w * sys.factor;
      }
      const reserveStart = x;
      x = m.contentX + m.cols.reduce((s, c) => s + (c.lead * Math.min(sys.factor, 1.3)) + c.w * sys.factor, 0);
      const minEnd = m.contentX + m.content * sys.factor;
      x = Math.max(x, minEnd);
      m.reserveX = reserveStart;
      x += m.padR;
      m.x1 = x;
      // full-measure rests are centred in the bar
      for (const c of m.cols) for (const { ev } of c.items) if (ev.full) {
        const p = evPos.get(ev.id); const w = glyphW(M, 'restWhole'); const dx = (m.contentX + m.x1) / 2 - w / 2 - p.x;
        p.x += dx; p.rest.x += dx; p.bbox.x0 += dx; p.bbox.x1 += dx;
      }
    });
    sys.x1 = x;
  }

  // ---- 4. stems, beams, flags
  for (const m of measures) {
    for (let si = 0; si < nSt; si++) {
      const events = score.measures[m.mi].staves[si].events;
      const groups = groupsOf.get(m.mi + ':' + si);
      const inGroup = new Set(groups.flat());
      for (const ev of events) if (ev.kind === 'note' && !inGroup.has(ev)) stemSingle(evPos.get(ev.id), ev, M, headW);
      for (const g of groups) beams.push(beamGroup(g.map((ev) => [ev, evPos.get(ev.id)]), M, headW));
    }
  }

  // ---- 5. ties and slurs
  const ties = [];
  const seqs = score.staves.map((_, si) => {
    const out = [];
    score.measures.forEach((m) => m.staves[si].events.forEach((ev) => out.push(ev)));
    return out;
  });
  for (const seq of seqs) {
    seq.forEach((ev, k) => {
      if (!ev.tie || ev.kind !== 'note') return;
      const nx = seq[k + 1];
      const a = evPos.get(ev.id);
      for (const h of a.heads) {
        const b = nx && nx.kind === 'note' ? evPos.get(nx.id) : null;
        const hb = b && b.heads.find((q) => q.pos === h.pos);
        const up = !a.stemUp;
        const sysEnd = systems[a.sys].x1;
        const x1 = hb && b.sys === a.sys ? hb.x + 0.1 : sysEnd - 0.2;
        ties.push({ x0: h.x + headW - 0.1, x1, y: h.y + (up ? -0.55 : 0.55), up, broken: !hb });
      }
    });
  }
  const slurs = [];
  for (const s of score.slurs || []) {
    const a = evPos.get(s.from), b = evPos.get(s.to);
    if (!a || !b || a.sys !== b.sys) continue;
    const up = !a.stemUp;
    const ya = up ? Math.min(...a.heads.map((h) => h.y)) - 0.8 : Math.max(...a.heads.map((h) => h.y)) + 0.8;
    const yb = up ? Math.min(...b.heads.map((h) => h.y)) - 0.8 : Math.max(...b.heads.map((h) => h.y)) + 0.8;
    slurs.push({ x0: a.x + headW / 2, y0: ya, x1: b.x + headW / 2, y1: yb, up });
  }

  const height = y + 4;
  return { systems, measures, evPos, beams, ties, slurs, height, width, headW, font: opt.font || 'Bravura', M, ED, nSt, attrs, spelled };
}

// Time signature digits are two spaces tall in Bravura; Petaluma draws them larger, so
// they are scaled to fit their half of the staff.
export function timeScale(M) { const g = M.glyphs.timeSig4; const h = g ? g.bb[3] - g.bb[1] : 2; return h > 2.3 ? 2.05 / h : 1; }
export function timeSigWidth(M, time, sym) {
  const k = timeScale(M);
  if (sym === 'common' || sym === 'cut') return glyphW(M, 'timeSigCommon') * k;
  const width = (n) => String(n).split('').reduce((s, d) => s + glyphW(M, 'timeSig' + d), 0) * k;
  return Math.max(width(time[0]), width(time[1]));
}
function accidentalColumns(heads) {
  const shown = heads.filter((h) => h.show).sort((a, b) => b.pos - a.pos);
  const cols = [];
  for (const h of shown) {
    let c = 0;
    while (cols[c] && cols[c].some((p) => Math.abs(p - h.pos) < 6)) c++;
    (cols[c] = cols[c] || []).push(h.pos); h.col = c;
  }
  return cols.length;
}

function placeEvent(ev, sp, x, top, M, headW, meta, forced) {
  const p = { id: ev.id, kind: ev.kind, x, top, ...meta, heads: [], dots: [], ledgers: [], bbox: null };
  if (ev.kind === 'rest') {
    const g = ev.full ? 'restWhole' : REST_GLYPH[ev.dur];
    const pos = ev.full || ev.dur === 1 ? 6 : 4;
    p.rest = { glyph: g, x, y: yOf(top, pos) };
    const bb = M.glyphs[g].bb;
    p.bbox = { x0: x + bb[0], x1: x + bb[2], y0: p.rest.y - bb[3], y1: p.rest.y - bb[1] };
    for (let d = 0; d < (ev.dots || 0); d++) p.dots.push({ x: x + bb[2] + 0.35 + d * 0.5, y: yOf(top, 5) });
    return p;
  }
  const up = forced !== undefined ? forced : stemUpFor(ev.heads);
  p.stemUp = up;
  const glyph = ev.dur === 1 ? 'noteheadWhole' : ev.dur === 2 ? 'noteheadHalf' : 'noteheadBlack';
  const hw = glyphW(M, glyph);
  const sorted = ev.heads.map((h, k) => ({ pos: h.pos, k, spell: sp[k] })).sort((a, b) => a.pos - b.pos);
  // seconds: the second head of a pair goes to the other side of the stem
  const order = up ? sorted : sorted.slice().reverse();
  let prev = null;
  for (const h of order) {
    h.displaced = !!(prev && Math.abs(h.pos - prev.pos) === 1 && !prev.displaced);
    prev = h;
  }
  const shift = hw - (M.engravingDefaults.stemThickness || 0.12);
  for (const h of sorted) {
    const hx = h.displaced ? x + (up ? shift : -shift) : x;
    p.heads.push({ pos: h.pos, k: h.k, x: hx, y: yOf(top, h.pos), glyph, displaced: h.displaced, spell: h.spell });
  }
  // accidentals, stacked in columns right to left
  const accHeads = p.heads.map((h) => ({ pos: h.pos, show: h.spell && h.spell.showAcc, h }));
  accidentalColumns(accHeads);
  const leftMost = Math.min(...p.heads.map((h) => h.x));
  for (const a of accHeads) if (a.show) {
    const g = ACC_GLYPH[a.h.spell.alter];
    a.h.acc = { glyph: g, x: leftMost - 0.2 - (a.col + 1) * 1.15 + (1.15 - glyphW(M, g)) , y: a.h.y };
  }
  // ledger lines
  const lo = sorted[0].pos, hi = sorted[sorted.length - 1].pos;
  const lx0 = Math.min(...p.heads.map((h) => h.x)) - 0.35, lx1 = Math.max(...p.heads.map((h) => h.x)) + hw + 0.35;
  for (let q = -2; q >= lo; q -= 2) p.ledgers.push({ x0: lx0, x1: lx1, y: yOf(top, q) });
  for (let q = 10; q <= hi; q += 2) p.ledgers.push({ x0: lx0, x1: lx1, y: yOf(top, q) });
  // dots: in the space above a line note
  const dotX = Math.max(...p.heads.map((h) => h.x)) + hw + 0.35;
  for (const h of p.heads) {
    const dp = h.pos % 2 === 0 ? h.pos + 1 : h.pos;
    for (let d = 0; d < (ev.dots || 0); d++) p.dots.push({ x: dotX + d * 0.5, y: yOf(top, dp) });
  }
  if (ev.stacc) {
    const h = up ? p.heads[0] : p.heads[p.heads.length - 1];
    const dp = up ? h.pos - 2 - (h.pos % 2 === 0 ? 1 : 0) : h.pos + 2 + (h.pos % 2 === 0 ? 1 : 0);
    p.stacc = { x: x + hw / 2 - 0.2, y: yOf(top, dp) };
  }
  p.headGlyph = glyph; p.hw = hw;
  const ys = p.heads.map((h) => h.y);
  p.bbox = { x0: Math.min(leftMost, ...p.heads.filter((h) => h.acc).map((h) => h.acc.x)), x1: Math.max(...p.heads.map((h) => h.x)) + hw, y0: Math.min(...ys) - 0.5, y1: Math.max(...ys) + 0.5 };
  return p;
}

function stemBase(p, M) {
  const up = p.stemUp, st = M.engravingDefaults.stemThickness;
  const a = M.glyphs[p.headGlyph][up ? 'stemUpSE' : 'stemDownNW'] || [up ? p.hw : 0, up ? 0.168 : -0.168];
  const baseHead = up ? p.heads.reduce((m, h) => (h.pos < m.pos ? h : m)) : p.heads.reduce((m, h) => (h.pos > m.pos ? h : m));
  const farHead = up ? p.heads.reduce((m, h) => (h.pos > m.pos ? h : m)) : p.heads.reduce((m, h) => (h.pos < m.pos ? h : m));
  const x = p.x + (up ? a[0] - st / 2 : a[0] + st / 2);
  return { x, y0: baseHead.y - a[1], far: farHead };
}

function stemSingle(p, ev, M) {
  if (ev.dur === 1) return;
  const up = p.stemUp;
  const b = stemBase(p, M);
  let len = 3.5 + (ev.dur === 32 ? 0.5 : ev.dur === 64 ? 1.2 : 0);
  let tip = up ? b.far.y - len : b.far.y + len;
  const mid = yOf(p.top, 4);
  if (up && tip > mid) tip = mid; if (!up && tip < mid) tip = mid;
  p.stem = { x: b.x, y0: b.y0, y1: tip };
  if (FLAG[ev.dur]) p.flag = { glyph: `flag${FLAG[ev.dur]}${up ? 'Up' : 'Down'}`, x: b.x - M.engravingDefaults.stemThickness / 2, y: tip };
  p.bbox.y0 = Math.min(p.bbox.y0, tip); p.bbox.y1 = Math.max(p.bbox.y1, tip);
  if (p.flag) p.bbox.x1 = Math.max(p.bbox.x1, b.x + 1.1);
}

function beamGroup(items, M, headW) {
  const up = items[0][1].stemUp;
  const bt = M.engravingDefaults.beamThickness, bs = M.engravingDefaults.beamSpacing;
  const bases = items.map(([ev, p]) => ({ ev, p, b: stemBase(p, M) }));
  const maxLevel = Math.max(...items.map(([ev]) => Math.log2(ev.dur) - 2));
  const extra = (maxLevel - 1) * (bt + bs);
  const ideal = bases.map(({ b }) => (up ? b.far.y - 3.25 - extra : b.far.y + 3.25 + extra));
  const f = bases[0], l = bases[bases.length - 1];
  let slope = (l.b.x - f.b.x) > 0 ? (ideal[ideal.length - 1] - ideal[0]) / (l.b.x - f.b.x) : 0;
  const maxRise = 1.0 / Math.max(1, l.b.x - f.b.x);
  slope = Math.max(-maxRise, Math.min(maxRise, slope)) * 0.7;
  const line = (x) => ideal[0] + slope * (x - f.b.x);
  let shift = 0;
  bases.forEach(({ b }, k) => {
    const need = ideal[k];
    const have = line(b.x);
    if (up && have > need) shift = Math.min(shift, need - have);
    if (!up && have < need) shift = Math.max(shift, need - have);
  });
  const mid = yOf(items[0][1].top, 4);
  const beamY = (x) => line(x) + shift;
  // stems must reach the middle line
  let adj = 0;
  bases.forEach(({ b }) => { const y = beamY(b.x); if (up && y > mid) adj = Math.min(adj, mid - y); if (!up && y < mid) adj = Math.max(adj, mid - y); });
  const Y = (x) => beamY(x) + adj;
  for (const { p, b } of bases) {
    p.stem = { x: b.x, y0: b.y0, y1: Y(b.x) + (up ? -0.0 : 0) };
    delete p.flag;
    p.bbox.y0 = Math.min(p.bbox.y0, p.stem.y1); p.bbox.y1 = Math.max(p.bbox.y1, p.stem.y1);
  }
  const st = M.engravingDefaults.stemThickness;
  const segs = [];
  for (let level = 0; level <= maxLevel; level++) {
    const off = level * (bt + bs) * (up ? 1 : -1);
    const has = bases.map(({ ev }) => Math.log2(ev.dur) - 3 >= level);
    for (let k = 0; k < bases.length; k++) {
      if (!has[k]) continue;
      let j = k; while (j + 1 < bases.length && has[j + 1]) j++;
      let x0 = bases[k].b.x - st / 2, x1 = bases[j].b.x + st / 2;
      if (j === k) { // partial beam (hook) toward the neighbour
        const toRight = k === 0 || (k < bases.length - 1 && ticksDotted(bases[k].ev));
        if (toRight) x1 = x0 + 1.1; else { x1 = x0 + st; x0 = x1 - 1.1; }
      }
      segs.push({ x0, x1, y0: Y(x0) + off, y1: Y(x1) + off, up });
      k = j;
    }
  }
  return { up, segs, thickness: bt, ids: bases.map(({ ev }) => ev.id) };
}
const ticksDotted = (ev) => !!ev.dots;

/** Which system/staff/measure a page point (sp) falls in, for ink routing. */
export function locate(L, x, y) {
  if (!L.systems.length) return null;
  let best = null;
  for (const sys of L.systems) for (let si = 0; si < sys.staffTops.length; si++) {
    const top = sys.staffTops[si], d = Math.abs(y - (top + 2));
    if (!best || d < best.d) best = { d, sys, si, top };
  }
  const sys = best.sys;
  let m = sys.measures.find((mm) => x >= mm.x0 && x < mm.x1);
  if (!m) m = x < sys.measures[0].x0 ? sys.measures[0] : sys.measures[sys.measures.length - 1];
  return { sys: sys.index, si: best.si, top: best.top, mi: m.mi, m, dist: best.d };
}

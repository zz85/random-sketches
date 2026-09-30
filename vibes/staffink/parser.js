// Ink -> score edits. Pure: takes a stroke group (page coordinates in staff spaces), the
// score and its layout, and returns an edit to apply. No DOM.
//
// Order of decisions, following the pen-music literature:
//  1. Gestures that only make sense against notes already on the page (Forsberg et al.,
//     "The Music Notepad", UIST 1998; Anstice et al., "Presto", OZCHI 1996; StaffPad):
//     scribble-to-erase, a straight line across stem tips = beam, an arc between two
//     heads = tie (same pitch) or slur, ledger lines and barlines are ignored because
//     the engraver draws them.
//  2. Tiny strokes are dots; their meaning comes from where they sit relative to a
//     head (right = augmentation, above/below = staccato).
//  3. Everything else goes to the symbol classifier (recognizer.js) with a context
//     prior: clefs and time signatures only at the start of a bar.
//  4. Notes are parsed structurally (Miyao & Maruyama's stroke-primitive idea, 2004/07):
//     find the stem, then the heads at one end of it; each head's height on the staff
//     gives its pitch, several heads make a chord, fill density decides black/white.
import { bbox, pathLength, straightness, reversals, resampleStep, classify, CLASSES } from './recognizer.js';
import { findEvent, ensureTrailingMeasure } from './theory.js';
import { locate, posOf } from './layout.js';

// ---------------------------------------------------------------- stroke analysis

/** Longest nearly straight, nearly vertical run in a stroke: a stem candidate. */
export function verticalRun(stroke, maxTilt = 0.36) {
  const r = resampleStep(stroke, 0.12);
  let best = null;
  for (let i = 0; i < r.length - 1; i++) {
    let L = 0;
    for (let j = i + 1; j < r.length; j++) {
      L += Math.hypot(r[j].x - r[j - 1].x, r[j].y - r[j - 1].y);
      const dx = r[j].x - r[i].x, dy = r[j].y - r[i].y, c = Math.hypot(dx, dy);
      if (L > 0.35 && (c / L < 0.94 || Math.abs(dx) > Math.abs(dy) * maxTilt)) break;
      if (!best || c > best.len) best = { len: c, i, j, r };
    }
  }
  if (!best) return null;
  const a = best.r[best.i], b = best.r[best.j];
  best.top = a.y < b.y ? a : b; best.bottom = a.y < b.y ? b : a; best.x = (a.x + b.x) / 2;
  return best;
}

/** Back-and-forth strokes: 3+ reversals with a real sweep, bigger than a notehead. */
export function isScribble(s) {
  const b = bbox([s]), rx = reversals(s, 0.3, 'x'), ry = reversals(s, 0.3, 'y');
  const sweep = rx >= ry ? b.w : b.h;
  return Math.max(b.w, b.h) >= 1.5 && Math.max(rx, ry) >= 3 && sweep >= 0.9 && pathLength(s) >= 2.5 * Math.max(b.w, b.h);
}

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
const minDist = (pts, q) => pts.reduce((m, p) => Math.min(m, dist(p, q)), Infinity);

function pieceInfo(pts) {
  const b = bbox([pts]), ink = pathLength(pts);
  const closedGap = pts.length > 2 ? dist(pts[0], pts[pts.length - 1]) : 9;
  return { pts, b, ink, density: ink / (b.w + b.h + 0.2), closed: closedGap < Math.max(0.45, 0.35 * Math.max(b.w, b.h)) && ink > 1.2, compact: Math.max(b.w, b.h) <= 2.2 };
}

/**
 * Structural parse of a note symbol.
 * @returns {heads:[{x,y,pos,filled,density}], stem, flags, filled}
 */
export function parseNote(strokes, top) {
  let stem = null, stemIdx = -1;
  strokes.forEach((s, i) => { const v = verticalRun(s); if (v && (!stem || v.len > stem.len)) { stem = v; stemIdx = i; } });
  if (stem && stem.len < 1.4) stem = null;
  const pieces = [];
  strokes.forEach((s, i) => {
    if (stem && i === stemIdx) {
      const a = stem.r.slice(0, stem.i + 1), c = stem.r.slice(stem.j);
      if (pathLength(a) > 0.3) pieces.push(pieceInfo(a));
      if (pathLength(c) > 0.3) pieces.push(pieceInfo(c));
    } else if (pathLength(s) > 0.15 || s.length) pieces.push(pieceInfo(s.length > 1 ? s : [s[0], { x: s[0].x + 0.05, y: s[0].y }]));
  });
  if (!stem) {
    // whole note or a stemless head (or several stacked: a chord)
    const heads = [];
    for (const p of pieces) splitHeads(p, top).forEach((h) => heads.push(h));
    return finish(heads, null, 0);
  }
  const sx = stem.x;
  const ends = { top: [], bottom: [] };
  for (const p of pieces) {
    const dT = minDist(p.pts, stem.top), dB = minDist(p.pts, stem.bottom);
    if (Math.min(dT, dB) > 1.9) continue;
    const end = dT < dB ? 'top' : 'bottom';
    const rightOf = p.b.x0 > sx - 0.45 && p.b.x1 > sx + 0.45;
    p.flagLike = rightOf && !p.closed && (p.b.h > 0.8 || p.ink > 1.8) && p.density < 2.4;
    p.headScore = p.compact && !p.flagLike ? p.density + (p.closed ? 0.8 : 0) + (end === 'bottom' && p.b.cx < sx ? 0.6 : 0) + (end === 'top' && p.b.cx > sx ? 0.3 : 0) : 0;
    ends[end].push(p);
  }
  const score = (list) => list.reduce((s, p) => s + p.headScore, 0);
  const headEnd = score(ends.top) > score(ends.bottom) ? 'top' : 'bottom';
  const flagEnd = headEnd === 'top' ? 'bottom' : 'top';
  let heads = [];
  for (const p of ends[headEnd]) if (p.headScore > 0) splitHeads(p, top).forEach((h) => heads.push(h));
  if (!heads.length) {
    // head merged into the stem stroke and too small to separate: assume a standard position
    const up = headEnd === 'bottom';
    const y = up ? stem.bottom.y - 0.1 : stem.top.y + 0.1;
    heads.push({ x: up ? sx - 0.6 : sx + 0.6, y, pos: posOf(top, y), filled: true, density: 3 });
  }
  const flags = ends[flagEnd].filter((p) => p.flagLike || p.headScore === 0).length + ends[headEnd].filter((p) => p.flagLike).length;
  return finish(heads, { x: sx, top: stem.top.y, bottom: stem.bottom.y, len: stem.len, up: headEnd === 'bottom' }, flags);
}

function splitHeads(p, top) {
  const filled = p.density > 2.15 && !(p.closed && p.density < 2.6);
  if (p.b.h > 2.1 && p.b.w < 2.0) {
    const k = Math.round((p.b.h - 0.1) / 1.0);
    return Array.from({ length: k }, (_, i) => { const y = p.b.y0 + 0.5 + i * (p.b.h - 1) / Math.max(1, k - 1); return { x: p.b.cx, y, pos: posOf(top, y), filled, density: p.density }; });
  }
  return [{ x: p.b.cx, y: p.b.cy, pos: posOf(top, p.b.cy), filled, density: p.density, closed: p.closed }];
}

function finish(heads, stem, flags) {
  const byPos = new Map();
  for (const h of heads) if (!byPos.has(h.pos)) byPos.set(h.pos, h);
  const hs = [...byPos.values()].sort((a, b) => a.pos - b.pos);
  const filled = hs.length ? hs.filter((h) => h.filled).length * 2 >= hs.length : false;
  return { heads: hs, stem, flags, filled };
}

function isLedger(s, top) {
  const b = bbox([s]);
  return b.h < 0.4 && b.w > 0.6 && b.w < 3.2 && straightness(s) > 0.9 && (b.cy < top - 0.6 || b.cy > top + 4.6);
}

// ---------------------------------------------------------------- context helpers

function eventsIn(L, sys, si) {
  const out = [];
  for (const [id, p] of L.evPos) if (p.sys === sys && p.si === si) out.push(p);
  return out.sort((a, b) => a.x - b.x);
}

function insertIndex(score, L, mi, si, x) {
  const evs = score.measures[mi].staves[si].events;
  let k = 0;
  for (const ev of evs) { const p = L.evPos.get(ev.id); if (p && p.x + (p.hw || 1) / 2 < x) k++; }
  return k;
}

function rectOverlap(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

// ---------------------------------------------------------------- gestures

export function detectGesture(strokes, ctx, loc) {
  const { L } = ctx;
  if (strokes.length !== 1) return null;
  const s = strokes[0], b = bbox(strokes), ink = pathLength(s);
  const a = s[0], z = s[s.length - 1];

  // scribble over existing symbols = erase
  const rx = reversals(s, 0.3, 'x');
  if (isScribble(s)) {
    const hit = [];
    for (const [id, p] of L.evPos) {
      const area = Math.max(0.3, (p.bbox.x1 - p.bbox.x0) * (p.bbox.y1 - p.bbox.y0));
      const head = p.heads && p.heads.length ? { x0: p.bbox.x0, x1: p.bbox.x1, y0: Math.min(...p.heads.map((h) => h.y)) - 0.5, y1: Math.max(...p.heads.map((h) => h.y)) + 0.5 } : p.bbox;
      if (rectOverlap(b, p.bbox) > 0.3 * area || rectOverlap(b, head) > 0.5 * (head.x1 - head.x0) * (head.y1 - head.y0)) hit.push(id);
    }
    if (hit.length) return { kind: 'erase', label: 'erase', ids: hit, desc: `erased ${hit.length} symbol${hit.length > 1 ? 's' : ''}`, apply: (score) => { for (const id of hit) removeEvent(score, id); ensureTrailingMeasure(score); return { ids: [] }; } };
  }

  const chord = dist(a, z), st = straightness(s);
  // straight, shallow line touching two or more stem tips = beam
  if (st > 0.92 && chord >= 1.4 && Math.abs(z.y - a.y) < 0.8 * Math.abs(z.x - a.x)) {
    const [l, r] = a.x < z.x ? [a, z] : [z, a];
    const yAt = (x) => l.y + (r.y - l.y) * (x - l.x) / Math.max(1e-6, r.x - l.x);
    const hits = [];
    for (const [id, p] of L.evPos) {
      if (p.kind !== 'note' || !p.stem || p.sys !== loc.sys) continue;
      const tx = p.stem.x, ty = p.stem.y1;
      if (tx < l.x - 0.6 || tx > r.x + 0.6) continue;
      if (Math.abs(yAt(Math.min(r.x, Math.max(l.x, tx))) - ty) < 1.2) hits.push(p);
    }
    if (hits.length >= 2) {
      const ids = hits.sort((p, q) => p.x - q.x).map((p) => p.id);
      return { kind: 'beam', label: 'beam', desc: `beamed ${ids.length} notes`, apply: (score) => {
        const beamId = 'b' + (score.nextId++);
        for (const id of ids) { const f = findEvent(score, id); if (!f) continue; f.ev.dur = f.ev.dur < 8 ? 8 : Math.min(64, f.ev.dur * 2); f.ev.beamId = beamId; }
        return { ids };
      } };
    }
  }

  // arc from one head to another = tie or slur
  if (b.w >= 0.9 && b.h <= 0.55 * b.w + 0.2 && rx === 0 && st > 0.5 && st < 0.995) {
    const [l, r] = a.x < z.x ? [a, z] : [z, a];
    let sag = 0;
    for (const p of s) {
      const t = (p.x - l.x) / Math.max(1e-6, r.x - l.x), yl = l.y + t * (r.y - l.y);
      if (Math.abs(p.y - yl) > Math.abs(sag)) sag = p.y - yl;
    }
    if (Math.abs(sag) >= 0.15) {
      const near = (pt) => {
        let best = null;
        for (const [, p] of L.evPos) {
          if (p.kind !== 'note' || p.sys !== loc.sys) continue;
          for (const h of p.heads) { const d = Math.hypot(pt.x - (h.x + L.headW / 2), pt.y - h.y); if (d < 1.9 && (!best || d < best.d)) best = { d, p, h }; }
        }
        return best;
      };
      const A = near(l), B = near(r);
      if (A && B && A.p.id !== B.p.id && A.p.x < B.p.x) {
        const shared = A.p.heads.some((h) => B.p.heads.some((k) => k.pos === h.pos));
        const same = shared && A.h.pos === B.h.pos || shared && Math.abs(A.h.pos - B.h.pos) <= 1;
        const seq = [...eventsIn(L, A.p.sys, A.p.si)];
        const adjacent = seq.findIndex((p) => p.id === A.p.id) + 1 === seq.findIndex((p) => p.id === B.p.id) || A.p.sys !== B.p.sys;
        if (same && adjacent) return { kind: 'tie', label: 'tie', desc: 'tie', apply: (score) => { const f = findEvent(score, A.p.id); if (f) f.ev.tie = true; return { ids: [A.p.id] }; } };
        return { kind: 'slur', label: 'slur', desc: 'slur', apply: (score) => { score.slurs = (score.slurs || []).filter((x) => !(x.from === A.p.id && x.to === B.p.id)); score.slurs.push({ from: A.p.id, to: B.p.id }); return { ids: [A.p.id, B.p.id] }; } };
      }
    }
  }

  // straight vertical line through the whole staff = barline (drawn automatically)
  if (st > 0.93 && b.h >= 3.3 && b.w < 0.6 && b.y0 < loc.top + 0.9 && b.y1 > loc.top + 3.1) {
    return { kind: 'barline', label: 'Barline', desc: 'barlines are automatic, bars fill as you write', apply: () => ({ ids: [] }) };
  }
  return null;
}

export function removeEvent(score, id) {
  const f = findEvent(score, id);
  if (!f) return;
  f.events.splice(f.i, 1);
  score.slurs = (score.slurs || []).filter((s) => s.from !== id && s.to !== id);
  // a tie into a removed note is meaningless
  const prev = f.events[f.i - 1];
  if (prev && prev.tie && !f.events[f.i]) prev.tie = false;
}

// ---------------------------------------------------------------- dots

function attachDots(dots, ctx, loc, onlyEvent) {
  const { L } = ctx;
  const actions = [];
  for (const d of dots) {
    let best = null;
    for (const [, p] of L.evPos) {
      if (p.sys !== loc.sys || p.si !== loc.si) continue;
      if (onlyEvent && p.id !== onlyEvent) continue;
      const hs = p.kind === 'note' ? p.heads : [{ x: p.bbox.x0, y: (p.bbox.y0 + p.bbox.y1) / 2 }];
      const hw = p.kind === 'note' ? p.hw : p.bbox.x1 - p.bbox.x0;
      for (const h of hs) {
        const dx = d.cx - (h.x + hw), dy = d.cy - h.y;
        if (dx > -0.3 && dx < 2.2 && Math.abs(dy) < 1.0) { const sc = Math.abs(dx - 0.4) + Math.abs(dy); if (!best || sc < best.sc) best = { sc, p, type: 'aug' }; }
        if (p.kind === 'note' && Math.abs(d.cx - (h.x + hw / 2)) < 0.9 && Math.abs(dy) > 0.5 && Math.abs(dy) < 2.4) { const sc = Math.abs(d.cx - (h.x + hw / 2)) + Math.abs(Math.abs(dy) - 1.1) + 0.3; if (!best || sc < best.sc) best = { sc, p, type: 'stacc' }; }
      }
    }
    if (best) actions.push({ ...best, x: d.cx });
  }
  return actions;
}

function applyDots(score, actions, L) {
  const seen = new Map();
  for (const a of actions) {
    const f = findEvent(score, a.p.id);
    if (!f) continue;
    if (a.type === 'stacc') { f.ev.stacc = true; continue; }
    // one dot per head of a chord is still a single dot; a dot further right doubles it
    const prevX = seen.has(a.p.id) ? seen.get(a.p.id) : (a.p.dots.length ? a.p.dots[a.p.dots.length - 1].x : null);
    if (prevX === null) { f.ev.dots = Math.max(1, f.ev.dots || 0); seen.set(a.p.id, a.x); }
    else if (a.x > prevX + 0.3 && (f.ev.dots || 0) < 2) { f.ev.dots = (f.ev.dots || 0) + 1; seen.set(a.p.id, a.x); }
  }
}

// ---------------------------------------------------------------- main entry

const CLEF_TIME = Object.keys(CLASSES).filter((k) => CLASSES[k].kind === 'clef' || CLASSES[k].kind === 'time');

/**
 * Interpret one stroke group.
 * @param strokes  [[{x,y}]] page coordinates in staff spaces
 * @param ctx      { score, L, model, user, pending }
 * @param forced   optional label to use instead of the classifier's choice
 * @returns edit { kind, label, alts, desc, apply(score) -> {ids, pending?} } or null
 */
export function interpret(strokes, ctx, forced) {
  const { score, L } = ctx;
  if (!strokes.length) return null;
  const all = bbox(strokes);
  let loc = locate(L, all.cx, all.cy);
  if (!loc) return null;
  if (loc.dist > 7) return { kind: 'none', label: 'none', alts: [], desc: 'write on or near a staff', apply: () => ({ ids: [] }) };
  if (!forced) { const g = detectGesture(strokes, ctx, loc); if (g) return g; }

  const dots = [], main = [];
  for (const s of strokes) {
    const b = bbox([s]);
    if (forced === 'Dot' || (b.w < 0.55 && b.h < 0.55 && pathLength(s) < 1.6)) dots.push(b);
    else if (!forced && isLedger(s, loc.top)) continue;
    else main.push(s);
  }
  if (!main.length) {
    if (!dots.length) return null;
    const acts = attachDots(dots, ctx, loc);
    if (!acts.length) return { kind: 'none', label: 'Dot', desc: 'dot: no note next to it', apply: () => ({ ids: [] }) };
    return { kind: 'dot', label: 'Dot', alts: [], desc: acts[0].type === 'stacc' ? 'staccato' : 'augmentation dot', apply: (s) => { applyDots(s, acts, L); return { ids: acts.map((a) => a.p.id) }; } };
  }
  const b = bbox(main);
  loc = locate(L, b.cx, b.cy);
  const top = loc.top, m = loc.m, mi = loc.mi, si = loc.si;

  // context prior: clefs and time signatures belong at the start of a bar
  const firstEv = score.measures[mi].staves[si].events[0];
  const firstX = firstEv && L.evPos.get(firstEv.id) ? L.evPos.get(firstEv.id).x : m.x1;
  const atStart = b.cx < firstX && b.x0 < m.contentX + 4.5;
  const inHeader = L.systems[loc.sys] && b.cx < L.systems[loc.sys].x0 + L.systems[loc.sys].header + 0.5;
  const prior = { Barline: 0.02, Dot: 0.3 };
  for (const k of CLEF_TIME) prior[k] = atStart || inHeader ? 1 : 0.02;
  const ranked = classify(main, ctx.model, { prior, user: ctx.user });
  const label = forced || ranked[0].label;
  const alts = ranked.slice(0, 5).map((r) => ({ label: r.label, p: r.p, source: r.source }));
  const C = CLASSES[label];
  const edit = { label, alts, kind: C.kind, strokes: main };
  const targetMi = inHeader && loc.sys !== undefined ? L.systems[loc.sys].measures[0].mi : mi;

  if (C.kind === 'note') {
    const nb = parseNote(main, top);
    if (!nb.heads.length) return { ...edit, kind: 'none', desc: 'could not find a notehead', apply: () => ({ ids: [] }) };
    let dur = C.dur;
    const single = nb.heads.length === 1, h0 = nb.heads[0];
    if (!nb.stem) dur = nb.filled && !(single && h0.closed) ? 4 : 1;
    else if (!single) dur = nb.filled ? Math.min(64, 4 * 2 ** Math.min(4, nb.flags)) : 2;
    else if (dur === 1) dur = nb.filled ? 4 : 2;
    else if (dur === 2 && h0.density > 3.0) dur = 4;
    else if (dur === 4 && h0.closed && h0.density < 1.8) dur = 2;
    if (forced) dur = C.dur === 1 && nb.stem ? 2 : C.dur;
    const headX = Math.min(...nb.heads.map((h) => h.x));
    // stemless head next to an existing note = add to its chord
    if (!nb.stem && !forced) {
      for (const [, p] of L.evPos) {
        if (p.kind !== 'note' || p.sys !== loc.sys || p.si !== si) continue;
        if (Math.abs(p.x + p.hw / 2 - headX) < 1.3 && !p.heads.some((h) => nb.heads.some((n) => n.pos === h.pos))) {
          const pos = nb.heads.map((h) => h.pos);
          return { ...edit, kind: 'chord', desc: `added ${pos.length > 1 ? 'heads' : 'a head'} to chord`, apply: (s) => {
            const f = findEvent(s, p.id); if (!f) return { ids: [] };
            for (const q of pos) if (!f.ev.heads.some((h) => h.pos === q)) f.ev.heads.push({ pos: q, acc: takePending(ctx, loc, headX, q) });
            return { ids: [p.id] };
          } };
        }
      }
    }
    const idx = insertIndex(score, L, mi, si, headX + 0.5);
    const heads = nb.heads.map((h) => ({ pos: h.pos, acc: null }));
    const rightX = Math.max(...nb.heads.map((h) => h.x)) + 0.6;
    const augX = dots.filter((d) => d.cx - rightX > -0.2 && d.cx - rightX < 2.2 && Math.min(...nb.heads.map((h) => Math.abs(d.cy - h.y))) < 1.0).map((d) => d.cx).sort((p, q) => p - q);
    const nDots = augX.length ? Math.min(2, 1 + augX.filter((x, i) => i && x - augX[i - 1] > 0.3).length) : 0;
    const stacc = dots.some((d) => Math.abs(d.cx - headX) < 0.9 && Math.min(...nb.heads.map((h) => Math.abs(d.cy - h.y))) > 0.6);
    return { ...edit, dur, heads, apply: (s) => {
      const evs = s.measures[mi].staves[si].events;
      dropFullRest(evs);
      const ev = { id: s.nextId++, kind: 'note', dur, dots: nDots, heads: heads.map((h) => ({ ...h, acc: takePending(ctx, loc, headX, h.pos) })), tie: false, stacc };
      evs.splice(Math.min(idx, evs.length), 0, ev);
      ensureTrailingMeasure(s);
      return { ids: [ev.id] };
    } };
  }
  if (C.kind === 'rest') {
    let dur = C.dur;
    const cpos = (top + 4 - b.cy) * 2;
    if (label === 'Whole-Half-Rest') dur = cpos > 5.0 ? 1 : 2;
    const idx = insertIndex(score, L, mi, si, b.cx);
    const empty = score.measures[mi].staves[si].events.length === 0;
    return { ...edit, dur, apply: (s) => {
      const evs = s.measures[mi].staves[si].events;
      dropFullRest(evs);
      const ev = { id: s.nextId++, kind: 'rest', dur, dots: dots.length ? 1 : 0, heads: [], full: dur === 1 && empty };
      evs.splice(Math.min(idx, evs.length), 0, ev);
      ensureTrailingMeasure(s);
      return { ids: [ev.id] };
    } };
  }
  if (C.kind === 'acc') {
    const y = label === 'Flat' ? b.y1 - 0.285 * b.h : b.cy;
    const pos = posOf(top, y);
    let target = null;
    for (const [, p] of L.evPos) {
      if (p.kind !== 'note' || p.sys !== loc.sys || p.si !== si) continue;
      for (const h of p.heads) {
        const dx = h.x - b.x1, dp = Math.abs(h.pos - pos);
        if (dx > -0.9 && dx < 3.5 && dp <= 1) { const sc = dx + dp * 1.5; if (!target || sc < target.sc) target = { sc, p, h }; }
      }
    }
    if (target) {
      const q = target.h.pos;
      return { ...edit, desc: `${label.toLowerCase()} on the note`, apply: (s) => { const f = findEvent(s, target.p.id); if (f) { const hh = f.ev.heads.find((h) => h.pos === q); if (hh) hh.acc = C.acc; } return { ids: [target.p.id] }; } };
    }
    return { ...edit, desc: 'accidental waiting for its note', apply: () => ({ ids: [], pending: { acc: C.acc, pos, x1: b.x1, sys: loc.sys, si, strokes: main, t: Date.now() } }) };
  }
  if (C.kind === 'clef') {
    return { ...edit, desc: `${C.clef === 'G' ? 'treble' : C.clef === 'F' ? 'bass' : 'alto'} clef`, apply: (s) => {
      if (targetMi === 0) s.staves[si].clef = C.clef;
      else { const a = s.measures[targetMi].attrs; a.clefs = a.clefs || s.staves.map(() => null); a.clefs[si] = C.clef; }
      return { ids: [] };
    } };
  }
  if (C.kind === 'time') {
    return { ...edit, desc: `time signature ${C.sym === 'common' ? 'C' : C.sym === 'cut' ? '¢' : C.time.join('/')}`, apply: (s) => {
      if (targetMi === 0) { s.time = C.time; s.timeSym = C.sym; }
      else { s.measures[targetMi].attrs.time = C.time; s.measures[targetMi].attrs.timeSym = C.sym; }
      return { ids: [] };
    } };
  }
  if (C.kind === 'dot') {
    const acts = attachDots([b], ctx, loc);
    if (!acts.length) return { ...edit, kind: 'none', desc: 'dot: no note next to it', apply: () => ({ ids: [] }) };
    return { ...edit, desc: acts[0].type === 'stacc' ? 'staccato' : 'augmentation dot', apply: (s) => { applyDots(s, acts, L); return { ids: acts.map((a) => a.p.id) }; } };
  }
  return { ...edit, kind: 'none', desc: 'barlines are automatic', apply: () => ({ ids: [] }) };
}

function dropFullRest(evs) { for (let i = evs.length - 1; i >= 0; i--) if (evs[i].full) evs.splice(i, 1); }

/** Consume a pending accidental written to the left of a new head. */
function takePending(ctx, loc, headX, pos) {
  const P = ctx.pending || [];
  const k = P.findIndex((a) => a.sys === loc.sys && a.si === loc.si && headX - a.x1 > -0.8 && headX - a.x1 < 3.8 && Math.abs(a.pos - pos) <= 1);
  if (k < 0) return null;
  const a = P.splice(k, 1)[0];
  return a.acc;
}

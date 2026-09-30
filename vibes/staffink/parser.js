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
//     head (right = augmentation, above/below = staccato). Other small marks just
//     above or below a note are articulations, told apart by shape (dash = tenuto,
//     tick = staccatissimo, > = accent, ^ = marcato, arch + dot = fermata). Their
//     position is what separates them from look-alikes: an accent from a hairpin
//     (smaller, and hugging one note), a tenuto from a ledger line.
//  3. Everything else goes to the symbol classifier (recognizer.js) with a context
//     prior: clefs and time signatures only at the start of a bar.
//  4. Notes are parsed structurally (Miyao & Maruyama's stroke-primitive idea, 2004/07):
//     find the stem, then the heads at one end of it; each head's height on the staff
//     gives its pitch, several heads make a chord, fill density decides black/white.
import { bbox, pathLength, straightness, reversals, resampleStep, classify, CLASSES, isExtra, isArtic, rankTemplates } from './recognizer.js';
import { findEvent, ensureTrailingMeasure, tupletWindows, clearTuplet, TUPLETS, hasArtic, setArtic, ARTIC_NAMES } from './theory.js';
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

  // scribble over existing symbols = erase (notes first, else an articulation, else a slur)
  const rx = reversals(s, 0.3, 'x');
  if (isScribble(s)) {
    const hit = eraseHits(L, b, false);
    const n = hit.ids.length + hit.artics.length + hit.slurs.length;
    if (n) {
      const what = hit.ids.length ? `${hit.ids.length} symbol${hit.ids.length > 1 ? 's' : ''}` : hit.artics.length ? hit.artics.map((a) => ARTIC_NAMES[a.art]).join(', ') : hit.slurs.length > 1 ? `${hit.slurs.length} slurs` : 'slur';
      return { kind: 'erase', label: 'erase', ids: hit.ids, desc: `erased ${what}`, apply: (score) => { applyErase(score, hit); return { ids: [] }; } };
    }
  }

  const hp = detectHairpin(strokes, ctx, loc);
  if (hp) return hp;

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

/**
 * What an eraser box touches. `touch` (eraser tool, small box): any overlap counts.
 * Otherwise (scribble): a note needs a real share of its body covered. Notes win over
 * their articulations, which win over slurs, so scribbling a mark off keeps its note.
 */
export function eraseHits(L, b, touch) {
  const ids = [], artics = [], slurs = [];
  for (const [id, p] of L.evPos) {
    const c = p.core || p.bbox;
    const area = Math.max(0.3, (c.x1 - c.x0) * (c.y1 - c.y0));
    const head = p.heads && p.heads.length ? { x0: c.x0, x1: c.x1, y0: Math.min(...p.heads.map((h) => h.y)) - 0.5, y1: Math.max(...p.heads.map((h) => h.y)) + 0.5 } : c;
    const ov = rectOverlap(b, c);
    if (touch ? ov > 0 : ov > 0.3 * area || rectOverlap(b, head) > 0.5 * (head.x1 - head.x0) * (head.y1 - head.y0)) ids.push(id);
  }
  if (!ids.length) for (const [id, p] of L.evPos) for (const a of p.artics || []) {
    const m = { x0: a.box.x0 - 0.15, x1: a.box.x1 + 0.15, y0: a.box.y0 - 0.15, y1: a.box.y1 + 0.15 };
    if (rectOverlap(b, m) > (touch ? 0 : 0.25 * (m.x1 - m.x0) * (m.y1 - m.y0))) artics.push({ id, art: a.art });
  }
  if (!ids.length && !artics.length) for (const sl of L.slurs || []) {
    const inside = sl.pts.filter((q) => q.x > b.x0 - 0.25 && q.x < b.x1 + 0.25 && q.y > b.y0 - 0.25 && q.y < b.y1 + 0.25).length;
    if (inside >= (touch ? 1 : 2) && !slurs.includes(sl.idx)) slurs.push(sl.idx);
  }
  return { ids, artics, slurs };
}

export function applyErase(score, hit) {
  for (const id of hit.ids) removeEvent(score, id);
  for (const a of hit.artics) { const f = findEvent(score, a.id); if (f) setArtic(f.ev, a.art, false); }
  if (hit.slurs.length) score.slurs = (score.slurs || []).filter((_, i) => !hit.slurs.includes(i));
  if (hit.ids.length) ensureTrailingMeasure(score);
}

export function removeEvent(score, id) {
  const f = findEvent(score, id);
  if (!f) return;
  if (f.ev.tuplet) clearTuplet(score, f.ev.tuplet.id); // a tuplet missing a member no longer adds up
  f.events.splice(f.i, 1);
  score.slurs = (score.slurs || []).filter((s) => s.from !== id && s.to !== id);
  score.hairpins = (score.hairpins || []).filter((h) => h.from !== id && h.to !== id);
  // a tie into a removed note is meaningless
  const prev = f.events[f.i - 1];
  if (prev && prev.tie && !f.events[f.i]) prev.tie = false;
}

// ---------------------------------------------------------------- hairpins, dynamics, tuplets

const outsideStaff = (b, top, m = 0.35) => b.y0 > top + 4 + m || b.y1 < top - m;
const staffEvents = (L, sys, si) => [...L.evPos.values()].filter((p) => p.sys === sys && p.si === si).sort((a, b) => a.x - b.x);
const centerX = (p) => (p.hw ? p.x + p.hw / 2 : (p.bbox.x0 + p.bbox.x1) / 2);

/** '<' or '>' outside the staff: one stroke with a corner, or two lines meeting at the apex. */
export function detectHairpin(strokes, ctx, loc) {
  const b = bbox(strokes);
  if (!outsideStaff(b, loc.top, 0.2) || b.w < 1.8 || b.h > 0.6 * b.w || b.h < 0.3) return null;
  let arms, apex, opens;
  if (strokes.length === 1) {
    const s = strokes[0];
    let iMin = 0, iMax = 0;
    s.forEach((p, i) => { if (p.x < s[iMin].x) iMin = i; if (p.x > s[iMax].x) iMax = i; });
    const endsX = (s[0].x + s[s.length - 1].x) / 2;
    const k = Math.abs(s[iMin].x - endsX) > Math.abs(s[iMax].x - endsX) ? iMin : iMax;
    if (k < 2 || k > s.length - 3) return null;
    arms = [s.slice(0, k + 1), s.slice(k)]; apex = s[k]; opens = [s[0], s[s.length - 1]];
  } else if (strokes.length === 2) {
    const [a, c] = strokes, ea = [a[0], a[a.length - 1]], ec = [c[0], c[c.length - 1]];
    let best = null;
    for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { const d = dist(ea[i], ec[j]); if (!best || d < best.d) best = { d, i, j }; }
    if (best.d > 0.7) return null;
    arms = strokes; apex = { x: (ea[best.i].x + ec[best.j].x) / 2, y: (ea[best.i].y + ec[best.j].y) / 2 }; opens = [ea[1 - best.i], ec[1 - best.j]];
  } else return null;
  for (const arm of arms) { const ab = bbox([arm]); if (straightness(arm) < 0.9 || ab.w < 1.5 || ab.h > 0.6 * ab.w) return null; }
  const open = Math.abs(opens[0].y - opens[1].y), openX = (opens[0].x + opens[1].x) / 2;
  if (open < 0.3 || open > 2.2 || Math.abs(openX - apex.x) < 1.5 || Math.sign(opens[0].x - apex.x) !== Math.sign(opens[1].x - apex.x)) return null;
  const type = openX > apex.x ? 'cresc' : 'dim';
  const evs = staffEvents(ctx.L, loc.sys, loc.si);
  const nearest = (x) => evs.reduce((m, p) => (!m || Math.abs(centerX(p) - x) < Math.abs(centerX(m) - x) ? p : m), null);
  const from = nearest(b.x0), last = nearest(b.x1);
  let to = last;
  const name = type === 'cresc' ? 'crescendo' : 'diminuendo';
  if (!from) return { kind: 'none', label: name, desc: `${name}: write it under the notes it covers`, apply: () => ({ ids: [] }) };
  if (!to || to.x < from.x) to = from;
  return { kind: 'hairpin', label: name, desc: name, apply: (score) => {
    score.hairpins = (score.hairpins || []).filter((h) => !(h.from === from.id && h.to === to.id));
    score.hairpins.push({ from: from.id, to: to.id, type });
    return { ids: [from.id, to.id] };
  } };
}

/**
 * Dynamics and tuplet numbers. They are only looked for where notes cannot be: fully
 * outside the staff lines, or (numbers only) beyond the stems/beams of notes below.
 */
export const EXTRA_THRESHOLD = { outside: 0.052, beyond: 0.045 };
function tryExtra(strokes, ctx, forced) {
  const { L } = ctx;
  const b = bbox(strokes);
  const loc = locate(L, b.cx, b.cy);
  if (!loc) return null;
  let zone = outsideStaff(b, loc.top) ? 'outside' : null;
  if (!zone) {
    const over = staffEvents(L, loc.sys, loc.si).filter((p) => p.bbox.x1 > b.x0 - 0.3 && p.bbox.x0 < b.x1 + 0.3);
    if (over.length && (b.y1 < Math.min(...over.map((p) => p.bbox.y0)) - 0.1 || b.y0 > Math.max(...over.map((p) => p.bbox.y1)) + 0.1)) zone = 'beyond';
  }
  let label = forced, alts = [];
  if (!forced) {
    if (!zone || !ctx.extras) return null;
    const pool = ctx.extras.concat((ctx.user || []).filter((u) => isExtra(u.label)));
    const r = rankTemplates(strokes, pool, 1.0, zone === 'beyond' ? (l) => l.startsWith('Tuplet') : undefined);
    if (!r.length) return null;
    // a whole note on a ledger line also sits outside the staff
    const mlp = ctx.model ? classify(strokes, ctx.model)[0] : null;
    const guard = mlp && mlp.label === 'Whole-Note' && mlp.p > 0.6;
    if (r[0].d >= (guard ? 0.03 : EXTRA_THRESHOLD[zone])) return null;
    label = r[0].label;
    const w = r.slice(0, 4).map((x) => ({ label: x.label, s: Math.exp(-x.d / 0.012) }));
    const z = w.reduce((a, x) => a + x.s, 0);
    alts = w.map((x) => ({ label: x.label, p: x.s / z * 0.9, source: 'extra' }));
    if (mlp) alts.push({ label: mlp.label, p: 0.1 * mlp.p, source: 'mlp' });
  }
  const C = CLASSES[label];
  const evs = staffEvents(L, loc.sys, loc.si);
  const base = { label, alts, kind: C.kind, strokes };
  if (C.kind === 'dyn') {
    let best = null;
    for (const p of evs) { const d = Math.abs(centerX(p) - (b.x0 + Math.min(b.w, 1.4) / 2)); if (d < 4 && (!best || d < best.d)) best = { d, p }; }
    if (!best) return { ...base, kind: 'none', desc: `${C.dyn}: write it under a note`, apply: () => ({ ids: [] }) };
    const id = best.p.id;
    return { ...base, desc: `dynamic ${C.dyn}`, apply: (score) => { const f = findEvent(score, id); if (f) f.ev.dyn = C.dyn; return { ids: [id] }; } };
  }
  // tuplet: the window of consecutive events around the number whose lengths add up
  let near = null;
  for (const p of evs) { const d = Math.abs(centerX(p) - b.cx); if (!near || d < near.d) near = { d, p }; }
  if (!near || near.d > 4) return { ...base, kind: 'none', desc: `${C.n}: write it over the notes of the tuplet`, apply: () => ({ ids: [] }) };
  const events = ctx.score.measures[near.p.mi].staves[near.p.si].events;
  const k = events.findIndex((e) => e.id === near.p.id);
  let pick = null;
  for (const w of tupletWindows(events, k, C.n)) {
    const ps = events.slice(w.a, w.b).map((e) => L.evPos.get(e.id));
    const c = (centerX(ps[0]) + centerX(ps[ps.length - 1])) / 2;
    const sc = Math.abs(c - b.cx) + 0.3 * (w.b - w.a);
    if (!pick || sc < pick.sc) pick = { sc, w };
  }
  if (!pick) return { ...base, kind: 'none', desc: `${C.n}: those notes do not add up to ${C.n} equal parts`, apply: () => ({ ids: [] }) };
  const ids = events.slice(pick.w.a, pick.w.b).map((e) => e.id);
  return { ...base, desc: C.n === 3 ? 'triplet' : `${C.n}-tuplet`, apply: (score) => makeTuplet(score, ids, C.n) };
}

export function makeTuplet(score, ids, n) {
  const evs = ids.map((id) => findEvent(score, id)).filter(Boolean).map((f) => f.ev);
  for (const e of evs) if (e.tuplet) clearTuplet(score, e.tuplet.id);
  const tid = 't' + score.nextId++;
  for (const e of evs) e.tuplet = { id: tid, n, m: TUPLETS[n] };
  return { ids };
}

// ---------------------------------------------------------------- articulations

const isTiny = (s) => { const b = bbox([s]); return b.w < 0.55 && b.h < 0.55 && pathLength(s) < 1.6; };

/** Interior point farthest from the chord, and how far: the corner of a wedge. */
function corner(s) {
  const a = s[0], z = s[s.length - 1], L = Math.max(1e-6, dist(a, z));
  let k = -1, d = 0;
  for (let i = 1; i < s.length - 1; i++) {
    const e = Math.abs((z.x - a.x) * (a.y - s[i].y) - (a.x - s[i].x) * (z.y - a.y)) / L;
    if (e > d) { d = e; k = i; }
  }
  if (k < 2 || k > s.length - 3) return null;
  const arms = [s.slice(0, k + 1), s.slice(k)];
  if (arms.some((arm) => pathLength(arm) < 0.3 || straightness(arm) < 0.8)) return null;
  return { apex: s[k], a, z, depth: d, chord: L };
}

/** An arch: x monotonic, bulging well clear of the chord. sag < 0 = bulges up (y down). */
function arch(s) {
  const b = bbox([s]);
  if (reversals(s, 0.25, 'x') > 0 || b.w < 0.7) return null;
  const a = s[0], z = s[s.length - 1];
  if (Math.abs(z.y - a.y) > 0.5 * b.w) return null;
  const [l, r] = a.x < z.x ? [a, z] : [z, a];
  let sag = 0;
  for (const p of s) { const yl = l.y + (r.y - l.y) * (p.x - l.x) / Math.max(1e-6, r.x - l.x); if (Math.abs(p.y - yl) > Math.abs(sag)) sag = p.y - yl; }
  return Math.abs(sag) >= Math.max(0.3, 0.22 * b.w) ? { sag } : null;
}

/**
 * Articulation candidates from shape alone, best first: [{label, s}]. Position (just
 * above or below one note) is the caller's job, and is what makes these safe to guess.
 */
export function articShapes(strokes) {
  const out = [];
  const dots = strokes.filter(isTiny), lines = strokes.filter((s) => !isTiny(s));
  if (strokes.length > 2 || lines.length > 2) return out;
  if (!lines.length) { if (dots.length === 1) out.push({ label: 'Art-staccato', s: 0.9 }); return out; }
  if (lines.length === 1) {
    const s = lines[0], b = bbox([s]), st = straightness(s);
    const ar = arch(s);
    if (dots.length === 1) {
      const d = bbox([dots[0]]);
      // fermata: an arch with its dot under the curve
      if (ar && b.w <= 3.6 && Math.abs(d.cx - b.cx) < 0.35 * b.w + 0.15 && (ar.sag < 0 ? d.cy > b.y0 + 0.15 : d.cy < b.y1 - 0.15)) out.push({ label: 'Art-fermata', s: 0.95 });
      return out;
    }
    if (st > 0.9 && b.w >= 0.45 && b.w <= 2.0 && b.h <= 0.3 * b.w + 0.12) out.push({ label: 'Art-tenuto', s: 0.9 });
    if (st > 0.85 && b.h >= 0.3 && b.h <= 1.4 && b.w <= 0.35 * b.h + 0.1) out.push({ label: 'Art-staccatissimo', s: 0.85 });
    const c = corner(s);
    if (c && c.depth > 0.22 * c.chord && Math.max(b.w, b.h) <= 1.9 && Math.max(b.w, b.h) >= 0.35) {
      const mid = { x: (c.a.x + c.z.x) / 2, y: (c.a.y + c.z.y) / 2 };
      const dx = c.apex.x - mid.x, dy = c.apex.y - mid.y;
      if (dx > 0 && dx > 1.2 * Math.abs(dy) && Math.abs(c.a.y - c.z.y) >= 0.25) out.push({ label: 'Art-accent', s: 0.9 });
      else if (Math.abs(dy) > 1.2 * Math.abs(dx) && Math.abs(c.a.x - c.z.x) >= 0.25) out.push({ label: 'Art-marcato', s: 0.88 });
    }
    // an arch on its own: a fermata written without its dot (the dot often comes late)
    if (ar && b.w >= 1.0 && b.w <= 3.6 && st < 0.93 && !out.length) out.push({ label: 'Art-fermata', s: 0.5 });
    return out;
  }
  // two straight arms meeting at the apex
  if (dots.length) return out;
  const [p, q] = lines, ep = [p[0], p[p.length - 1]], eq = [q[0], q[q.length - 1]];
  let best = null;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { const d = dist(ep[i], eq[j]); if (!best || d < best.d) best = { d, i, j }; }
  if (best.d > 0.45 || straightness(p) < 0.85 || straightness(q) < 0.85) return out;
  const one = (best.i === 1 ? p : p.slice().reverse()).concat(best.j === 0 ? q : q.slice().reverse());
  return articShapes([one]).filter((c) => c.label === 'Art-accent' || c.label === 'Art-marcato');
}

/** The note an articulation mark belongs to: just above or below it, centred on it. */
function articTarget(L, loc, b, label) {
  let best = null;
  const ferm = label === 'Art-fermata';
  for (const [, p] of L.evPos) {
    if (p.sys !== loc.sys || p.si !== loc.si) continue;
    if (p.kind !== 'note' && !ferm) continue;
    const cx = p.hw ? p.x + p.hw / 2 : (p.bbox.x0 + p.bbox.x1) / 2;
    const dx = Math.abs(b.cx - cx);
    if (dx > Math.max(1.1, b.w / 2 + 0.4)) continue;
    const c = p.core || p.bbox;
    const hy0 = p.heads && p.heads.length ? Math.min(...p.heads.map((h) => h.y)) - 0.5 : c.y0;
    const hy1 = p.heads && p.heads.length ? Math.max(...p.heads.map((h) => h.y)) + 0.5 : c.y1;
    const reach = ferm ? 4.2 : 2.5;
    let gap = null;
    // above: clear of the head, and of an up-stem's tip (a mark cannot sit on the stem)
    if (b.y1 < hy0 + 0.2 && (!(p.stem && p.stemUp) || b.y1 < p.stem.y1 + 0.35)) gap = Math.min(Math.abs(hy0 - b.y1), Math.abs(p.bbox.y0 - b.y1));
    else if (b.y0 > hy1 - 0.2 && (!(p.stem && !p.stemUp) || b.y0 > p.stem.y1 - 0.35)) gap = Math.min(Math.abs(b.y0 - hy1), Math.abs(b.y0 - p.bbox.y1));
    if (gap === null || gap > reach) continue;
    const sc = dx + 0.7 * gap;
    if (!best || sc < best.sc) best = { sc, p };
  }
  return best && best.p;
}

function tryArtic(strokes, ctx, loc, forced) {
  const b = bbox(strokes);
  if (strokes.length > 2 || Math.max(b.w, b.h) > 3.8) return forced ? { kind: 'none', label: forced, alts: [], desc: 'write the mark just above or below one note', apply: () => ({ ids: [] }) } : null;
  let ranked = forced ? [{ label: forced, s: 1 }] : articShapes(strokes);
  if (!forced) {
    // a lone dot keeps its existing meaning (augmentation or staccato, see attachDots)
    if (strokes.length === 1 && isTiny(strokes[0])) return null;
    // your own corrected marks win when they match closely
    const mine = (ctx.user || []).filter((u) => isArtic(u.label));
    const r = mine.length ? rankTemplates(strokes, mine, 0.7)[0] : null;
    if (r && r.d < 0.042) ranked = [{ label: r.label, s: 1, source: 'user' }, ...ranked.filter((x) => x.label !== r.label)];
  }
  if (!ranked.length) return null;
  const label = ranked[0].label;
  const p = articTarget(ctx.L, loc, b, label);
  if (!p) return forced ? { kind: 'none', label, alts: [], desc: `${ARTIC_NAMES[CLASSES[label].art]}: write it just above or below a note`, apply: () => ({ ids: [] }) } : null;
  const art = CLASSES[label].art;
  let alts = [];
  if (!forced) {
    const z = ranked.reduce((a, x) => a + x.s, 0);
    alts = ranked.map((x) => ({ label: x.label, p: 0.85 * x.s / z, source: x.source || 'shape' }));
    // the way out if it was really a symbol: the network's best guesses
    if (ctx.model) for (const m of classify(strokes, ctx.model).slice(0, 2)) alts.push({ label: m.label, p: 0.15 * m.p, source: 'mlp' });
  }
  const id = p.id;
  return { kind: 'artic', label, alts, strokes, desc: ARTIC_NAMES[art], apply: (score) => { const f = findEvent(score, id); if (f) setArtic(f.ev, art, true); return { ids: [id] }; } };
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
    if (a.type === 'stacc') { setArtic(f.ev, 'stacc', true); continue; }
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
  if (!forced && strokes.length === 2) { const h = detectHairpin(strokes, ctx, loc); if (h) return h; }
  if (!forced || isArtic(forced)) { const a = tryArtic(strokes, ctx, loc, forced); if (a) return a; }
  if (!forced || isExtra(forced)) { const x = tryExtra(strokes, ctx, forced); if (x) return x; }

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

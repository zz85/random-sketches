// Interpretation layer: decisions made ON the content, each one derived or overridden.
//
//   meter        where time signatures apply ('auto' = the content's meter directions,
//                'none' = free time, or an explicit list that overrides the content)
//   bars         'auto' = printed/drawn barlines win and re-phase the meter; derived bars
//                fill between them. 'explicit' = only printed ones. 'derived' = ignore
//                printed ones. With no meter and no printed bars there are no bars.
//   pickup       length of an anacrusis before the first derived bar
//   fillGaps     'rests' (engrave silence) or 'space' (leave paper, e.g. ink in progress)
//   accidentals  how far an accidental carries: 'bar' (common practice), 'note' (applies to
//                its own note only), or { window: '1/2' } (a duration, also cut at bars) -
//                free-time music needs a rule like this since there is no bar to end it
//   maxDots      dots allowed when writing a duration
//   beats        true (default): write values so the beat stays visible (see meterTree);
//                false: greedy values, cut only at barlines
//   syncopation  true (default): allow the standard syncopations (q h q in 4/4, e q e,
//                s e s) instead of tying them
//   written      true (default): keep the input's own spelling (event.written) whenever it
//                fits, even where the beat rules would split it - a printed page or a pen
//                stroke said so
//
// A meter direction may carry groups for additive meters: { beats: 7, unit: 8, groups: [2, 2, 3] }.
//   picks        { altGroup: option } to choose a non-default reading
//   fragment     which fragment to interpret (default 'main')
//
// Output: measures (with status ok / pickup / end / under / over / free, reported, never
// repaired), and per voice a list of written pieces: the events cut at barlines into tied
// notatable values, tuplets inferred from the duration's denominator, rests or spaces in
// the gaps, and each head spelled with the accidental to engrave.

import { r, ZERO, add, sub, mul, cmp, lt, le, eq, max, parse } from './rational.js';
import { active, directions, directionAt, scoreEnd, endOf, staffOf } from './ir.js';
import { midiOf, keyAlter, step, nameOf, ACC_TEXT } from './pitch.js';

const DEFAULTS = { fragment: 'main', meter: 'auto', bars: 'auto', pickup: ZERO, fillGaps: 'rests', accidentals: 'bar', maxDots: 1, beats: true, syncopation: true, written: true, picks: {} };

export function interpret(score, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  o.pickup = parse(o.pickup);
  const events = active(score, o.picks, o.fragment);
  const end = max(scoreEnd(score, events, o.fragment), o.end ? parse(o.end) : ZERO);
  const meters = meterMap(score, o);
  const bars = barlines(score, meters, end, o);
  const measures = measuresOf(bars, meters, end);
  const diagnostics = [];
  const voices = new Map();
  for (const v of score.voices) voices.set(v.id, notateVoice(score, v, events, measures, end, o, diagnostics));
  spell(score, voices, o);
  return { opts: o, end, meters, bars, measures, voices, diagnostics };
}

// ------------------------------------------------------------------- meter and bars

export const capacity = (m) => r(m.beats, m.unit);

function meterMap(score, o) {
  if (o.meter === 'none') return [];
  if (Array.isArray(o.meter)) return o.meter.map((m) => ({ ...m, at: parse(m.at ?? 0) })).sort((a, b) => cmp(a.at, b.at));
  return directions(score, 'meter', undefined, o.fragment).map((d) => ({ at: d.at, beats: d.beats, unit: d.unit, ...(d.groups ? { groups: d.groups } : {}) }));
}

const meterAt = (meters, t) => { let cur = null; for (const m of meters) { if (le(m.at, t)) cur = m; else break; } return cur; };

function barlines(score, meters, end, o) {
  if (eq(end, ZERO)) return [];
  const explicit = o.bars === 'derived' ? [] : directions(score, 'barline', undefined, o.fragment).filter((d) => lt(ZERO, d.at) && le(d.at, end));
  const derive = o.bars !== 'explicit';
  // anchors: places a bar must be (printed bars, meter changes) and the end
  const anchors = new Map();
  const at = (t) => { const k = `${t.n}/${t.d}`; if (!anchors.has(k)) anchors.set(k, { at: t }); return anchors.get(k); };
  for (const d of explicit) Object.assign(at(d.at), { explicit: d });
  if (derive) for (const m of meters) if (lt(ZERO, m.at) && lt(m.at, end)) at(m.at).meter = true;
  at(end).end = true;
  const list = [...anchors.values()].sort((a, b) => cmp(a.at, b.at));

  const out = [];
  let cursor = ZERO;
  for (const a of list) {
    const m = derive && meterAt(meters, cursor);
    if (m) {
      const cap = capacity(m);
      let t = eq(cursor, ZERO) && lt(ZERO, o.pickup) ? o.pickup : add(cursor, cap);
      for (; lt(t, a.at); t = add(t, cap)) out.push({ at: t, kind: 'derived' });
    }
    if (a.explicit) out.push({ at: a.at, kind: 'explicit', style: a.explicit.style || 'regular', src: a.explicit.src, id: a.explicit.id });
    else if (a.meter) out.push({ at: a.at, kind: 'derived', reason: 'meter' });
    else if (a.end) out.push({ at: a.at, kind: 'final', style: 'final' });
    cursor = a.at;
  }
  // free time with nothing printed: no closing barline either, unless asked for
  if (!meters.length && out.length === 1 && out[0].kind === 'final' && !o.finalBar) return [];
  return out;
}

function measuresOf(bars, meters, end) {
  const pts = [ZERO, ...bars.map((b) => b.at)];
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const start = pts[i], stop = pts[i + 1], len = sub(stop, start);
    if (le(len, ZERO)) continue;
    const meter = meterAt(meters, start);
    const cap = meter ? capacity(meter) : null;
    let status = 'free';
    if (cap) {
      const c = cmp(len, cap);
      status = c === 0 ? 'ok' : c > 0 ? 'over' : i + 2 === pts.length ? 'end' : out.length === 0 ? 'pickup' : 'under'; // a lone short bar is unfinished, not a pickup
    }
    out.push({ index: out.length, start, end: stop, len, meter, cap, status });
  }
  if (!out.length && lt(ZERO, end)) out.push({ index: 0, start: ZERO, end, len: end, meter: null, cap: null, status: 'free' });
  return out;
}

const measureIndexAt = (measures, t) => { for (const m of measures) if (le(m.start, t) && lt(t, m.end)) return m.index; return measures.length - 1; };

// ------------------------------------------------------------------- durations

const oddPart = (n) => { while (n % 2 === 0) n /= 2; return n; };
const pow2Below = (k) => { let p = 1; while (p * 2 < k) p *= 2; return p; };
const TYPES = [1, 2, 4, 8, 16, 32, 64, 128];

/** Sounding length of a written value { type, dots, tuplet: [n, m] | null }. */
export function valueDur({ type, dots = 0, tuplet = null }) {
  const p = 2 ** dots;
  const base = r(2 * p - 1, type * p);
  return tuplet ? mul(base, r(tuplet[1], tuplet[0])) : base;
}

/**
 * Write a duration as notatable values (to be tied). A denominator with an odd factor k is a
 * k-tuplet in the time of the power of two below it (3:2, 5:4, 7:4...), written durations are
 * then split greedily into dotted values. hint: the input's own spelling, kept if it fits.
 */
export function notateDuration(D, hint, maxDots = 1) {
  if (hint && eq(valueDur(hint), D)) return [{ type: hint.type, dots: hint.dots || 0, tuplet: hint.tuplet || null, dur: D }];
  const k = oddPart(D.d);
  let tuplet = null, W = D;
  if (k > 1) { const p = pow2Below(k); tuplet = [k, p]; W = mul(D, r(k, p)); }
  if (oddPart(W.d) > 1) return [{ type: null, dots: 0, tuplet, dur: D, unnotatable: true }];
  const out = [];
  let rem = W;
  while (lt(ZERO, rem)) {
    const type = TYPES.find((t) => le(r(1, t), rem));
    if (!type) { out.push({ type: null, dots: 0, tuplet, dur: tuplet ? mul(rem, r(tuplet[1], tuplet[0])) : rem, unnotatable: true }); break; }
    let dots = 0;
    while (dots < maxDots && le(valueDur({ type, dots: dots + 1 }), rem)) dots++;
    const w = valueDur({ type, dots });
    out.push({ type, dots, tuplet, dur: tuplet ? mul(w, r(tuplet[1], tuplet[0])) : w });
    rem = sub(rem, w);
  }
  return out;
}

// ------------------------------------------------------------------- beats
//
// A bar as a tree of metrical levels: bar -> beat groups -> beats -> subdivisions. Simple
// meters beat in 1/unit and subdivide by two; compound meters (6/8, 9/8, 12/8, 6/4: beats a
// multiple of 3 above 3) beat in dotted values of three units; four beats group as 2 + 2 (so
// the middle of a 4/4 or 12/8 bar stays visible), five as 3 + 2, seven as 2 + 2 + 3, or as a
// meter's own groups. Two and three beats sit directly under the bar.
//
// A span is written at the highest node it fits in:
//   - it is that node exactly                                  -> one value (h on beat 3 of 4/4)
//   - it lies inside one child                                 -> go down into the child
//   - notes only: it starts on a child boundary and ends on one
//     (q h in 3/4), or is dotted and its dot reaches the middle
//     of the next child (h. from beat 1 of 4/4, q. on beat 2 of 3/4) -> one value
//   - notes only, syncopation: a plain value one child long,
//     starting and ending on grandchild boundaries, crossing one
//     child boundary (q h q in 4/4, e q e, s e s)                -> one value
//   - otherwise it is cut at the child boundaries and each piece written the same way, tied
// Rests take only exact nodes, so a rest never hides a beat.

const GROUPING = { 4: [2, 2], 5: [3, 2], 6: [3, 3], 7: [2, 2, 3], 8: [4, 4] };
function beatGroups(n) { if (n <= 3) return Array(n).fill(1); if (GROUPING[n]) return GROUPING[n]; const g = Array(Math.floor(n / 2) - 1).fill(2); g.push(n - 2 * g.length); return g; }

export function meterTree(meter) {
  const unit = r(1, meter.unit);
  const bin = (start, len) => ({ start, len, kids: () => (len.d >= 256 ? [] : [bin(start, mul(len, r(1, 2))), bin(add(start, mul(len, r(1, 2))), mul(len, r(1, 2)))]) });
  const seq = (start, lens, make) => { let t = start; return lens.map((l) => { const n = make(t, l); t = add(t, l); return n; }); };
  if (meter.groups) {
    // additive: groups of units, each unit subdivided by two
    const kids = () => seq(ZERO, meter.groups.map((g) => mul(unit, r(g))), (t, l) => ({ start: t, len: l, kids: () => seq(t, Array(Math.round(l.n * meter.unit / l.d)).fill(unit), bin) }));
    return { start: ZERO, len: r(meter.beats, meter.unit), kids };
  }
  const compound = meter.beats % 3 === 0 && meter.beats > 3;
  const nBeats = compound ? meter.beats / 3 : meter.beats;
  const beatLen = compound ? mul(unit, r(3)) : unit;
  const beat = (start) => (compound ? { start, len: beatLen, kids: () => seq(start, [unit, unit, unit], bin) } : bin(start, beatLen));
  const group = (start, n) => {
    if (n === 1) return beat(start);
    const parts = beatGroups(n);
    return { start, len: mul(beatLen, r(n)), kids: () => seq(start, parts.map((k) => mul(beatLen, r(k))), (t, l) => group(t, Math.round(toFloatR(l) / toFloatR(beatLen)))) };
  };
  return group(ZERO, nBeats);
}
const toFloatR = (x) => x.n / x.d;
const binary = (x) => oddPart(x.d) === 1;

/** One plain or dotted value for D, or null. */
function single(D, maxDots) {
  const v = notateDuration(D, null, maxDots);
  return v.length === 1 && !v[0].tuplet && !v[0].unnotatable ? v[0] : null;
}

/** Values for [s, e) (positions from the start of the bar) under a node of the meter tree. */
function underNode(node, s, e, kind, o, out) {
  const nEnd = add(node.start, node.len), D = sub(e, s);
  if (eq(s, node.start) && eq(e, nEnd)) { const v = single(D, o.maxDots); if (v) { out.push(v); return; } }
  const kids = node.kids();
  if (!kids.length) { out.push(...notateDuration(D, null, o.maxDots)); return; }
  const inside = kids.find((k) => le(k.start, s) && le(e, add(k.start, k.len)));
  if (inside) { underNode(inside, s, e, kind, o, out); return; }
  if (kind === 'note') {
    const bounds = kids.map((k) => k.start);
    const onKid = (t) => bounds.some((b) => eq(b, t)) || eq(t, nEnd);
    const v = single(D, o.maxDots);
    if (v && onKid(s)) {
      if (onKid(e)) { out.push(v); return; }
      const next = kids.find((k) => lt(k.start, e) && lt(e, add(k.start, k.len)));
      const prev = kids.findIndex((k) => eq(k.start, s));
      if (v.dots && next && kids.indexOf(next) === prev + 1 && eq(e, add(next.start, mul(next.len, r(1, 2))))) { out.push(v); return; }
    }
    if (v && !v.dots && o.syncopation) {
      const crossed = kids.filter((k) => lt(s, k.start) && lt(k.start, e)).length;
      const childLen = kids[0].len;
      const onGrand = (t) => kids.some((k) => k.kids().some((g) => eq(g.start, t)) || eq(add(k.start, k.len), t));
      if (crossed === 1 && kids.every((k) => eq(k.len, childLen)) && eq(D, childLen) && onGrand(s) && onGrand(e)) { out.push(v); return; }
    }
  }
  // cut at the child boundaries
  let t = s;
  for (const k of kids) {
    const ks = k.start, ke = add(k.start, k.len);
    if (le(ke, t) || le(e, ks)) continue;
    const a = max(t, ks), b = lt(e, ke) ? e : ke;
    if (lt(a, b)) underNode(k, a, b, kind, o, out);
    t = b;
  }
}

/**
 * Written values for the span [a, b) of score time inside measure m. Uses the meter tree when
 * the bar has a meter and the span sits on the binary grid; tuplet spans and free time are
 * written greedily.
 */
function notateInBar(m, a, b, kind, o, hint) {
  const D = sub(b, a);
  if (hint && o.written && eq(valueDur(hint), D)) return notateDuration(D, hint, o.maxDots);
  if (!o.beats || !m?.cap || !m.meter || kind === 'space') return notateDuration(D, null, o.maxDots);
  // position in the bar: a pickup is the end of a bar
  const off = m.status === 'pickup' ? sub(m.cap, m.len) : ZERO;
  const s0 = add(sub(a, m.start), off), e0 = add(sub(b, m.start), off);
  if (![s0, e0, D].every(binary)) return notateDuration(D, null, o.maxDots);
  const tree = meterTree(m.meter), out = [];
  // an overfull bar: carry on into virtual bars of the same meter
  let s = s0;
  while (lt(s, e0)) {
    const k = Math.floor(toFloatR(s) / toFloatR(m.cap)), base = mul(m.cap, r(k)), top = add(base, m.cap);
    const e = lt(e0, top) ? e0 : top;
    underNode(tree, sub(s, base), sub(e, base), kind, o, out);
    s = e;
  }
  return out;
}

// ------------------------------------------------------------------- pieces

function notateVoice(score, v, events, measures, end, o, diag) {
  const evs = events.filter((e) => e.voice === v.id);
  const tieOut = new Set(score.links.filter((l) => l.kind === 'tie').map((l) => l.ids[0]));
  const pieces = [];
  const emit = (ev, s, e) => {
    const kind = !ev ? (o.fillGaps === 'space' ? 'space' : 'rest') : ev.kind;
    const hint = ev?.written && !ev.mergedGap ? ev.written : null;
    const cuts = [s, ...measures.map((m) => m.start).filter((t) => lt(s, t) && lt(t, e)), e];
    const mine = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i], b = cuts[i + 1], mi = measureIndexAt(measures, a), m = measures[mi];
      if (kind === 'rest' && m?.cap && eq(a, m.start) && eq(b, m.end)) { // whole-bar rest
        mine.push({ kind, onset: a, dur: sub(b, a), type: 'bar', dots: 0, tuplet: null, measure: mi });
        continue;
      }
      let t = a;
      for (const val of notateInBar(m, a, b, kind, o, cuts.length === 2 ? hint : null)) {
        if (val.unnotatable) diag.push({ kind: 'unnotatable', voice: v.id, event: ev?.id, at: t, dur: val.dur });
        mine.push({ kind, onset: t, ...val, measure: mi });
        t = add(t, val.dur);
      }
    }
    mine.forEach((p, i) => {
      if (ev) { p.event = ev.id; if (i > 0) p.cont = true; }
      if (kind === 'note') p.tie = i < mine.length - 1 || tieOut.has(ev.id);
    });
    pieces.push(...mine);
  };
  // segments: events and the gaps between them. A gap next to a written rest joins it, so
  // silence is written once for its whole length (a bar of it becomes a bar rest).
  const segs = [];
  let t = ZERO;
  for (const ev of evs) {
    if (lt(t, ev.onset)) segs.push({ ev: null, s: t, e: ev.onset });
    if (lt(ev.onset, t)) diag.push({ kind: 'overlap', voice: v.id, event: ev.id, at: ev.onset });
    segs.push({ ev, s: ev.onset, e: endOf(ev) });
    t = max(t, endOf(ev));
  }
  if (evs.length && lt(t, end)) segs.push({ ev: null, s: t, e: end });
  if (o.fillGaps === 'rests') for (let i = 0; i + 1 < segs.length; i++) {
    const x = segs[i], y = segs[i + 1], rest = (q) => q.ev && q.ev.kind === 'rest';
    if (eq(x.e, y.s) && ((!x.ev && rest(y)) || (rest(x) && !y.ev))) {
      segs.splice(i, 2, { ev: { ...(x.ev || y.ev), mergedGap: true }, s: x.s, e: y.e }); i--;
    }
  }
  for (const g of segs) emit(g.ev, g.s, g.e);
  groupTuplets(pieces);
  return pieces;
}

/** Consecutive pieces with one ratio in one bar form a bracket until they add up to a plain value. */
function groupTuplets(pieces) {
  let g = null, n = 0;
  for (const p of pieces) {
    if (!p.tuplet || (g && (g.ratio !== `${p.tuplet}` || g.measure !== p.measure))) g = null;
    if (!p.tuplet) continue;
    if (!g) g = { id: `t${++n}`, ratio: `${p.tuplet}`, measure: p.measure, sum: ZERO };
    p.tupletGroup = g.id;
    g.sum = add(g.sum, p.dur);
    if (oddPart(g.sum.d) === 1) g = null;
  }
}

// ------------------------------------------------------------------- spelling

function spell(score, voices, o) {
  const byId = new Map(score.events.map((e) => [e.id, e]));
  const tieTarget = new Map(score.links.filter((l) => l.kind === 'tie').map((l) => [l.ids[1], l.ids[0]]));
  const resolved = new Map(); // event id -> alters per head
  const staves = new Map();
  for (const [vid, ps] of voices) {
    const st = staffOf(score, vid);
    if (!staves.has(st)) staves.set(st, []);
    staves.get(st).push(...ps.filter((p) => p.kind === 'note'));
  }
  const window = o.accidentals?.window ? parse(o.accidentals.window) : null;
  for (const [st, ps] of staves) {
    ps.sort((a, b) => cmp(a.onset, b.onset));
    let state = new Map(), bar = -1;
    for (const p of ps) {
      const ev = byId.get(p.event);
      if (p.measure !== bar) { bar = p.measure; state = new Map(); }
      if (p.cont) { // continuation of a split note: same pitch, no accidental
        p.heads = resolved.get(ev.id).map((alter, i) => head(ev.heads[i].d, alter, null));
        continue;
      }
      const fifths = directionAt(score, 'key', p.onset, st, o.fragment)?.fifths ?? 0;
      const from = tieTarget.has(ev.id) ? resolved.get(tieTarget.get(ev.id)) && byId.get(tieTarget.get(ev.id)) : null;
      const alters = [];
      p.heads = ev.heads.map((h) => {
        const tiedIn = from && from.heads.findIndex((fh) => fh.d === h.d);
        const tiedAlter = from && tiedIn >= 0 ? resolved.get(from.id)[tiedIn] : undefined;
        const s = o.accidentals === 'note' ? null : state.get(h.d);
        const carried = s && (!window || lt(sub(p.onset, s.at), window)) ? s.alter : undefined;
        const implied = carried ?? keyAlter(fifths, step(h.d));
        const alter = h.alter ?? h.acc ?? tiedAlter ?? implied;
        let show = null;
        if (h.acc != null) show = alter; // written accidentals stay, cautionary ones too
        else if (alter !== implied && tiedAlter === undefined) show = alter;
        if (show !== null) state.set(h.d, { alter, at: p.onset });
        alters.push(alter);
        return head(h.d, alter, show);
      });
      resolved.set(ev.id, alters);
    }
  }
}

const head = (d, alter, show) => ({ d, alter, show, midi: midiOf(d, alter) });

// ------------------------------------------------------------------- debugging view

const TYPE_TEXT = { 1: 'w', 2: 'h', 4: 'q', 8: 'e', 16: 's', 32: 't', 64: 'x', 128: 'o' };

/**
 * One voice as text: "| C4q D4e. E4s~ | E4h R |". Accidentals appear only where they would
 * be engraved. r = rest, _ = space, R = whole-bar rest, /3 = triplet, ~ = tie, ? = unnotatable.
 */
export function toText(res, voiceId) {
  const out = [];
  let bar = -1;
  for (const p of res.voices.get(voiceId)) {
    if (p.measure !== bar) { if (res.bars.length) out.push('|'); bar = p.measure; }
    if (p.type === 'bar') { out.push('R'); continue; }
    const v = (p.unnotatable ? '?' : TYPE_TEXT[p.type] + '.'.repeat(p.dots)) + (p.tuplet ? `/${p.tuplet[0]}` : '');
    if (p.kind === 'note') {
      const names = p.heads.map((h) => nameOf(h.d, h.show == null ? '' : ACC_TEXT[h.show]));
      out.push((names.length > 1 ? `<${names.join(' ')}>` : names[0]) + v + (p.tie ? '~' : ''));
    } else out.push((p.kind === 'space' ? '_' : 'r') + v);
  }
  if (res.bars.length && res.voices.get(voiceId).length) out.push('|');
  return out.join(' ');
}

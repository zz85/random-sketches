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

const DEFAULTS = { fragment: 'main', meter: 'auto', bars: 'auto', pickup: ZERO, fillGaps: 'rests', accidentals: 'bar', maxDots: 1, picks: {} };

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
  return directions(score, 'meter', undefined, o.fragment).map((d) => ({ at: d.at, beats: d.beats, unit: d.unit }));
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

// ------------------------------------------------------------------- pieces

function notateVoice(score, v, events, measures, end, o, diag) {
  const evs = events.filter((e) => e.voice === v.id);
  const tieOut = new Set(score.links.filter((l) => l.kind === 'tie').map((l) => l.ids[0]));
  const pieces = [];
  const emit = (ev, s, e) => {
    const kind = !ev ? (o.fillGaps === 'space' ? 'space' : 'rest') : ev.kind;
    const cuts = [s, ...measures.map((m) => m.start).filter((t) => lt(s, t) && lt(t, e)), e];
    const mine = [];
    for (let i = 0; i + 1 < cuts.length; i++) {
      const a = cuts[i], b = cuts[i + 1], mi = measureIndexAt(measures, a), m = measures[mi];
      if (kind === 'rest' && m?.cap && eq(a, m.start) && eq(b, m.end)) { // whole-bar rest
        mine.push({ kind, onset: a, dur: sub(b, a), type: 'bar', dots: 0, tuplet: null, measure: mi });
        continue;
      }
      let t = a;
      for (const val of notateDuration(sub(b, a), cuts.length === 2 ? ev?.written : null, o.maxDots)) {
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
  let t = ZERO;
  for (const ev of evs) {
    if (lt(t, ev.onset)) emit(null, t, ev.onset);
    if (lt(ev.onset, t)) diag.push({ kind: 'overlap', voice: v.id, event: ev.id, at: ev.onset });
    emit(ev, ev.onset, endOf(ev));
    t = max(t, endOf(ev));
  }
  if (evs.length && lt(t, end)) emit(null, t, end);
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

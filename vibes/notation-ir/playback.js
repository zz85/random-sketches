// Playback programs: authored, non-linear playback over the timeline IR.
//
// Score time (where music sits in a fragment) and performance time (seconds, when it
// sounds) are separate. A program says how one becomes the other. Its leaves name music
// through anchors (anchors.js), so they stay attached to notes, printed bars or positions on
// the page while the music is edited.
//
//   program = { tempo: 100 (quarters per minute), seed: 1, clips: { id: clip },
//               jumps: [{ at: anchor, to: anchor, times: 1 }], interp: { fragment: opts },
//               root: node }
//   clip    = { from: anchor, to: anchor, voices?: [ids] }  a span
//           | { events: [ids] }                              a lasso of objects
//   node    = { play: clipId | clip }   the clip, relative to its own start
//           | { walk: { from, to } }    read on from `from`, taking the program's jumps
//                                       (a repeat sign, a D.S., an arrow drawn to another
//                                       fragment) until `to`, or the end of the fragment
//                                       the jumps left it in
//           | { seq: [nodes] } | { par: [nodes] } | { loop: n, body: node }
//           | { choose: [nodes], weights? }  (seeded, so an experiment can be replayed)
//           | { rest: '1/4' }
//   any node may also set (inherited by its children):
//     tempo, delay ('1/4', before it starts), transpose (semitones),
//     gaps: 'keep' | 'compress' | { max: '1/8' }   silence in the music is kept, removed, capped
//     minConf: 0.5      skip readings less certain than this
//     alts: 'cycle' | { group: option }   per pass of a loop, play the next alternative reading
//     articulate: false   play every note for its full written value
//
// Articulation (from event marks and slur links, StaffInk's rules): staccato sounds ~45%,
// staccatissimo ~25%, marcato 75%, tenuto and notes under a slur (up to, not including, its
// last) their full value, joined to the next; other notes leave a small gap. Accent and
// marcato play louder, staccato slightly softer. A fermata holds its event for twice its value and everything after it
// in the clip, on every voice, waits. A tied note ends the way its last written note does.
//
// perform() returns notes in seconds ({ t, dur, midi, vel, event, fragment, cursor }), a
// trace of which score span each cursor played when (for playheads), and the duration.
// A note's velocity is its event's `vel` (an adapter sets it from dynamics) or 0.75.
// Every par branch is its own cursor, so several selections can sound at once.

import { r, ZERO, add, sub, cmp, lt, le, max as rmax, min as rmin, parse, toFloat, str } from './rational.js';
import { MAIN, active, endOf, altOptions } from './ir.js';
import { interpret } from './interpret.js';
import { resolveAnchor, fragmentEnd, positionAt } from './anchors.js';

const INHERIT = ['tempo', 'transpose', 'gaps', 'minConf', 'alts', 'articulate'];

export const ACCENT_BOOST = { accent: 0.18, marcato: 0.26 };
const has = (e, m) => !!e.marks && e.marks.includes(m);
/** Sounding length (whole notes) of an event written for d whole notes. */
export function release(e, d, legato) {
  if (has(e, 'staccatissimo')) return Math.max(1 / 48, d * 0.25);
  if (has(e, 'staccato')) return Math.max(1 / 32, d * 0.45);
  if (has(e, 'marcato')) return d * 0.75;
  if (has(e, 'tenuto') || legato) return d;
  return d - Math.min(d * 0.1, 1 / 32);
}
export function velocity(e) {
  let v = (e.vel ?? 0.75) * (has(e, 'staccato') ? 0.9 : 1);
  for (const k in ACCENT_BOOST) if (has(e, k)) v += ACCENT_BOOST[k];
  return Math.min(1, Math.max(0.08, v));
}

/** Events played legato: from a slur's first event up to, not including, its last (same voice). */
export function legatoIds(score) {
  const out = new Set(), byId = new Map(score.events.map((e) => [e.id, e]));
  for (const l of score.links) {
    if (l.kind !== 'slur') continue;
    const a = byId.get(l.ids[0]), b = byId.get(l.ids[l.ids.length - 1]);
    if (!a || !b) continue;
    for (const e of score.events) if (e.voice === a.voice && (e.fragment ?? MAIN) === (a.fragment ?? MAIN) && le(a.onset, e.onset) && lt(e.onset, b.onset)) out.add(e.id);
  }
  return out;
}

export function perform(score, program) {
  const P = { tempo: 100, seed: 1, clips: {}, jumps: [], interp: {}, ...program };
  const cache = new Map();
  const interpOf = (fragment, picks = {}) => {
    const k = `${fragment}|${JSON.stringify(picks)}`;
    if (!cache.has(k)) cache.set(k, interpret(score, { ...(P.interp[fragment] || {}), fragment, picks }));
    return cache.get(k);
  };
  const pitchCache = new Map();
  const pitches = (fragment, picks) => {
    const k = `${fragment}|${JSON.stringify(picks)}`;
    if (!pitchCache.has(k)) {
      const m = new Map();
      for (const [, ps] of interpOf(fragment, picks).voices) for (const p of ps) if (p.kind === 'note' && !p.cont) m.set(p.event, p.heads.map((h) => h.midi));
      pitchCache.set(k, m);
    }
    return pitchCache.get(k);
  };
  const at = (a) => resolveAnchor(score, a, (f) => interpOf(f));
  const ties = new Map(score.links.filter((l) => l.kind === 'tie').map((l) => [l.ids[0], l.ids[1]]));
  const legato = legatoIds(score);
  const transposeOf = new Map();
  for (const part of score.parts) for (const st of part.staves) for (const v of score.voices) if (v.staff === st.id) transposeOf.set(v.id, part.transpose || 0);
  const rng = mulberry(P.seed);
  const out = { notes: [], trace: [], diagnostics: [] };
  const sec = (w, ctx) => (toFloat(w) * 240) / ctx.tempo;

  function picksFor(fragment, ctx) {
    if (!ctx.alts) return {};
    if (ctx.alts !== 'cycle') return ctx.alts;
    const picks = {};
    for (const g of new Set(score.events.filter((e) => e.alt && (e.fragment ?? MAIN) === fragment).map((e) => e.alt.group))) {
      const opts = altOptions(score, g);
      picks[g] = opts[ctx.pass % opts.length];
    }
    return picks;
  }

  /** Play [a, b) of a fragment starting at t0 seconds; returns the end in seconds. */
  function span(fragment, a, b, t0, ctx, filter = {}) {
    if (!lt(a, b)) return t0;
    const picks = picksFor(fragment, ctx);
    const ids = filter.events && new Set(filter.events);
    const evs = active(score, picks, fragment).filter((e) => le(a, e.onset) && lt(e.onset, b)
      && (!filter.voices || filter.voices.includes(e.voice)) && (!ids || ids.has(e.id))
      && (ctx.minConf == null || !e.alt || (e.alt.conf ?? 0) >= ctx.minConf));

    // silences inside the span, and how much of each the gap rule removes
    const maxGap = !ctx.gaps || ctx.gaps === 'keep' ? null : ctx.gaps === 'compress' ? ZERO : parse(ctx.gaps.max);
    const cuts = []; // [from, to) of score time that is skipped
    if (maxGap) {
      let cover = a;
      const sounding = evs.filter((e) => e.kind === 'note').sort((x, y) => cmp(x.onset, y.onset));
      const silence = (s, e) => { if (lt(add(s, maxGap), e)) cuts.push([add(s, maxGap), e]); };
      for (const e of sounding) { if (lt(cover, e.onset)) silence(cover, e.onset); cover = rmax(cover, rmin(endOf(e), b)); }
      if (lt(cover, b)) silence(cover, b);
    }
    // fermatas: the clip waits at the end of each held event for as long as the event lasts
    const holdAt = new Map(); // end time -> the longest fermata ending there
    for (const e of evs) if (has(e, 'fermata')) {
      const at = rmin(endOf(e), b), k = str(at), x = sub(at, e.onset);
      if (!holdAt.has(k) || lt(holdAt.get(k)[1], x)) holdAt.set(k, [at, x]);
    }
    const holds = [...holdAt.values()];
    const map = (s) => {
      let d = sub(s, a);
      for (const [c0, c1] of cuts) { if (le(c1, s)) d = sub(d, sub(c1, c0)); else if (lt(c0, s)) d = sub(d, sub(s, c0)); }
      for (const [at, x] of holds) if (le(at, s)) d = add(d, x);
      return d;
    };

    const pm = pitches(fragment, picks);
    const mine = [];
    for (const e of evs) {
      if (e.kind !== 'note') continue;
      const s0 = map(e.onset), s1 = map(rmin(endOf(e), b));
      for (const midi of pm.get(e.id) || []) {
        mine.push({ s0: toFloat(s0), s1: toFloat(s1), midi: midi + (ctx.transpose || 0) + (transposeOf.get(e.voice) || 0), vel: velocity(e), event: e.id, last: e, fragment, cursor: ctx.cursor, at: e.onset });
      }
    }
    // a tie sustains one note instead of re-striking it
    for (const n of mine) {
      if (n.dead) continue;
      for (;;) {
        const nxt = ties.get(n.last.id);
        const m = nxt && mine.find((x) => !x.dead && x.event === nxt && x.midi === n.midi && Math.abs(x.s0 - n.s1) < 1e-9);
        if (!m) break;
        n.s1 = m.s1; n.last = m.last; m.dead = true;
      }
    }
    const tempoK = 240 / ctx.tempo;
    for (const n of mine) {
      if (n.dead) continue;
      const d = n.s1 - n.s0, snd = ctx.articulate === false ? d : release(n.last, d, legato.has(n.last.id));
      out.notes.push({ t: t0 + n.s0 * tempoK, dur: snd * tempoK, midi: n.midi, vel: n.vel, event: n.event, fragment, cursor: n.cursor, at: n.at });
    }

    // trace: one segment per stretch of score time that was not cut
    const edges = [a, ...cuts.flat(), b];
    for (let i = 0; i + 1 < edges.length; i += 2) {
      const s0 = edges[i], s1 = edges[i + 1];
      if (lt(s0, s1)) out.trace.push({ cursor: ctx.cursor, fragment, t0: t0 + sec(map(s0), ctx), t1: t0 + sec(map(s1), ctx), s0, s1 });
    }
    return t0 + sec(map(b), ctx);
  }

  function clipOf(c) {
    const clip = typeof c === 'string' ? P.clips[c] : c;
    if (!clip) throw new Error(`no clip ${c}`);
    if (clip.events) {
      const evs = score.events.filter((e) => clip.events.includes(e.id));
      if (!evs.length) throw new Error('clip: no events');
      const fragment = evs[0].fragment ?? MAIN;
      let a = evs[0].onset, b = endOf(evs[0]);
      for (const e of evs) { a = rmin(a, e.onset); b = rmax(b, endOf(e)); }
      return { fragment, a, b, filter: { events: clip.events } };
    }
    const A = at(clip.from || { edge: 'start' }), B = clip.to ? at(clip.to) : { fragment: A.fragment, t: fragmentEnd(score, A.fragment) };
    if (A.fragment !== B.fragment) throw new Error('clip: from and to are in different fragments (use walk with a jump)');
    return { fragment: A.fragment, a: A.t, b: B.t, filter: { voices: clip.voices } };
  }

  function walk(w, t0, ctx) {
    let { fragment: f, t: p } = at(w.from || { edge: 'start' });
    const end = w.to ? at(w.to) : null;
    const jumps = (w.jumps || P.jumps).map((j) => ({ at: at(j.at), to: at(j.to), left: j.times ?? 1 }));
    let t = t0;
    for (let steps = 0; steps < 1000; steps++) {
      const bound = end && end.fragment === f ? end.t : fragmentEnd(score, f);
      const next = jumps.filter((j) => j.left > 0 && j.at.fragment === f && lt(p, j.at.t) && le(j.at.t, bound))
        .sort((x, y) => cmp(x.at.t, y.at.t))[0];
      if (!next) return span(f, p, bound, t, ctx);
      t = span(f, p, next.at.t, t, ctx);
      next.left--;
      f = next.to.fragment; p = next.to.t;
    }
    out.diagnostics.push({ kind: 'walk-limit' });
    return t;
  }

  function run(node, t0, parent) {
    const ctx = { ...parent };
    for (const k of INHERIT) if (node[k] !== undefined) ctx[k] = node[k];
    if (node.delay) t0 += sec(parse(node.delay), ctx);
    if (node.play !== undefined) { const c = clipOf(node.play); return span(c.fragment, c.a, c.b, t0, ctx, c.filter); }
    if (node.walk) return walk(node.walk, t0, ctx);
    if (node.rest) return t0 + sec(parse(node.rest), ctx);
    if (node.seq) { let t = t0; for (const n of node.seq) t = run(n, t, ctx); return t; }
    if (node.par) return Math.max(t0, ...node.par.map((n, i) => run(n, t0, { ...ctx, cursor: `${ctx.cursor}.${i}` })));
    if (node.loop != null) { let t = t0; for (let k = 0; k < node.loop; k++) t = run(node.body, t, { ...ctx, pass: k }); return t; }
    if (node.choose) {
      const w = node.weights || node.choose.map(() => 1), tot = w.reduce((s, x) => s + x, 0);
      let u = rng() * tot, i = 0;
      while (i < w.length - 1 && u >= w[i]) u -= w[i++];
      return run(node.choose[i], t0, ctx);
    }
    throw new Error(`unknown node ${JSON.stringify(node)}`);
  }

  out.duration = run(P.root, 0, { tempo: P.tempo, cursor: '0', pass: 0 });
  out.notes.sort((x, y) => x.t - y.t || x.midi - y.midi);
  out.trace.sort((x, y) => x.t0 - y.t0);
  return out;
}

/** Where every cursor is at T seconds: [{ cursor, fragment, at (score time, float), pos }]. */
export function playheadsAt(score, perf, T) {
  return perf.trace.filter((s) => s.t0 <= T && T < s.t1).map((s) => {
    const f = (T - s.t0) / (s.t1 - s.t0), at = toFloat(s.s0) + f * (toFloat(s.s1) - toFloat(s.s0));
    return { cursor: s.cursor, fragment: s.fragment, at, pos: positionAt(score, s.fragment, r(Math.round(at * 384), 384)) };
  });
}

function mulberry(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
}

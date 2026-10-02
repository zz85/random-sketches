// From recognised symbols to music: parts -> measures -> events with exact durations, then a
// bar-fill check that repairs the likeliest misreadings. Pure (no DOM, no pixels): runs in the
// main thread after every correction, and under bun for the evaluation.
//
// Ticks: 96 per quarter note. An event is { kind: 'note' | 'rest', x, dur (1 2 4 8 16 32),
// dots, tuplet: [n, m] | null, ticks, notes: [analysis notes] | rest, tie, grace }.
// User corrections live on the analysis objects (note.fix, rest.fix, rest.deleted, st.timeFix)
// so they survive a rebuild.

export const DIV = 96;
export const WHOLE = 4 * DIV;
export const baseTicks = (dur, dots) => { let t = WHOLE / dur, a = t; for (let i = 0; i < dots; i++) { a /= 2; t += a; } return t; };
export const evTicks = (e) => (e.grace ? 0 : e.full ? e.cap : (baseTicks(e.dur, e.dots) * (e.tuplet ? e.tuplet[1] : 1)) / (e.tuplet ? e.tuplet[0] : 1));
export const capOf = (time) => (time.beats * WHOLE) / time.unit;
const TUPLET_OF = { 3: [3, 2], 5: [5, 4], 6: [6, 4] };
const METERS = [[4, 4], [3, 4], [2, 4], [2, 2], [6, 8], [3, 8], [9, 8], [12, 8], [5, 4], [6, 4], [3, 2]];

/** Which part each staff belongs to: in a score, the row of its system; else one part. */
export function partsOf(model) {
  const bySys = new Map();
  for (const st of model.staves) bySys.set(st.system, [...(bySys.get(st.system) || []), st]);
  const rows = Math.max(...[...bySys.values()].map((g) => g.length));
  const parts = Array.from({ length: rows }, (_, i) => ({ index: i, staves: [] }));
  for (const g of bySys.values()) g.forEach((st, i) => parts[rows === g.length ? i : Math.min(i, rows - 1)].staves.push(st));
  return parts;
}

// events of one staff region [xa, xb)
function regionEvents(st, xa, xb, S) {
  const evs = [];
  const chords = new Map();
  for (const n of st.notes) {
    if (n.x < xa || n.x >= xb) continue;
    if (!chords.has(n.chord)) chords.set(n.chord, []);
    chords.get(n.chord).push(n);
  }
  for (const ns of chords.values()) {
    const f = ns.find((n) => n.fix)?.fix || {};
    const n0 = ns[0];
    evs.push({
      kind: 'note', x: ns.reduce((s, n) => s + n.x, 0) / ns.length, notes: ns.sort((a, b) => a.p - b.p),
      dur: f.dur ?? n0.dur ?? 4, dots: f.dots ?? n0.ndots ?? 0, tuplet: f.tuplet !== undefined ? f.tuplet : null,
      tie: f.tie ?? ns.some((n) => n.tie), grace: f.grace ?? n0.grace ?? false, beamComp: n0.beamed ? n0.comp : null, fixed: !!ns.find((n) => n.fix),
      tupletFixed: f.tuplet !== undefined,
    });
  }
  for (const r of st.rests || []) {
    if (r.deleted || r.x < xa || r.x >= xb) continue;
    const f = r.fix || {};
    evs.push({ kind: 'rest', x: r.x, rest: r, dur: f.dur ?? r.dur, dots: f.dots ?? r.dots ?? 0, tuplet: f.tuplet !== undefined ? f.tuplet : null, fixed: !!r.fix, tupletFixed: f.tuplet !== undefined });
  }
  evs.sort((a, b) => a.x - b.x || (a.kind === 'rest') - (b.kind === 'rest'));
  // merge notes on different stems at the same x into one chord (two voices sharing a beat)
  for (let i = 1; i < evs.length; i++) {
    const a = evs[i - 1], b = evs[i];
    if (a.kind === 'note' && b.kind === 'note' && Math.abs(a.x - b.x) < 0.6 * S && !a.grace && !b.grace) {
      a.notes = [...a.notes, ...b.notes].sort((p, q) => p.p - q.p); a.dur = Math.max(a.dur, b.dur); a.tie = a.tie || b.tie;
      evs.splice(i--, 1);
    }
  }
  return evs;
}

// tuplet numbers: the n events nearest the number (a beamed group under it first)
function applyTuplets(st, measures, S) {
  for (const t of st.tuplets || []) {
    const ratio = TUPLET_OF[t.n]; if (!ratio) continue;
    const m = measures.find((q) => t.x >= q.x0 - 0.5 * S && t.x < q.x1); if (!m) continue;
    const evs = m.events.filter((e) => !e.grace);
    let best = null;
    for (let i = 0; i + t.n <= evs.length; i++) {
      const win = evs.slice(i, i + t.n);
      if (win.some((e) => e.tuplet || e.tupletFixed)) continue;
      const cx = (win[0].x + win[win.length - 1].x) / 2;
      if (t.x < win[0].x - 1.2 * S || t.x > win[win.length - 1].x + 1.2 * S) continue;
      // the number sits just beyond the heads or the stem ends (beam) of its group
      const ys = win.flatMap((e) => (e.notes ? e.notes.flatMap((n) => [n.y, n.stem ? n.stem.tip : n.y]) : [e.rest.box[1], e.rest.box[3]]));
      if (Math.min(...ys.map((y) => Math.abs(y - t.y))) > 2.2 * S) continue;
      // the written values of a tuplet add up to n equal units
      const units = win.reduce((s, e) => s + baseTicks(e.dur, e.dots), 0) / t.n;
      if (![WHOLE / 2, WHOLE / 4, WHOLE / 8, WHOLE / 16, WHOLE / 32].includes(units)) continue;
      const beamed = win[0].beamComp != null && win.every((e) => e.beamComp === win[0].beamComp);
      const d = Math.abs(cx - t.x) - (beamed ? 2 * S : 0);
      if (!best || d < best.d) best = { d, win };
    }
    if (best) for (const e of best.win) { e.tuplet = ratio; e.tupletMark = t; e.tg = best.win; }
  }
}

/**
 * Build the score. Returns { parts: [{ index, measures }], measures (all, page order), stats }.
 * measure: { part, st, index (in part), number, x0, x1, time, timeShown, fifths, clef, events,
 *   ticks, cap, status: ok | pickup | end | rest | under | over, repairs: [text], double }
 */
export function buildScore(model) {
  const S = model.space || 16;
  const parts = partsOf(model);
  const all = [];
  for (const part of parts) {
    part.measures = [];
    let time = null;
    for (const st of part.staves) {
      const start = st.times?.length && st.times[0].x < Math.min(st.x1, ...st.notes.map((n) => n.x)) ? st.times[0].x1 : (st.key?.x1 ?? st.x0);
      const bars = st.bars.filter((b) => b.x > start + 0.5 * S).sort((a, b) => a.x - b.x);
      const edges = [{ x: start, double: false }, ...bars, { x: st.x1 + S, end: true }];
      const ms = [];
      for (let i = 0; i + 1 < edges.length; i++) {
        const x0 = edges[i].x, x1 = edges[i + 1].x;
        const events = regionEvents(st, x0, x1, S);
        if (!events.length && (edges[i + 1].end || x1 - x0 < 6 * S)) continue;
        // a time signature at the start of this measure (or just before its first event)
        const ts = (st.timeFix && st.timeFix[ms.length]) || (st.times || []).find((t) => t.x >= (i === 0 ? st.key?.x1 ?? st.x0 : x0) - 0.5 * S && t.x < Math.min(x1, events[0]?.x ?? x1));
        const shown = !!ts;
        if (ts) time = { beats: ts.beats, unit: ts.unit, sym: ts.sym, fixed: !!st.timeFix?.[ms.length] };
        ms.push({ part: part.index, st, x0, x1, events, time, timeShown: shown, double: !!edges[i + 1].double, endBar: !!edges[i + 1].end, fifths: st.key.fifths, clef: st.clef.type });
      }
      applyTuplets(st, ms, S);
      part.measures.push(...ms);
    }
    // measures before any time signature take the first one, or one inferred from the bars
    const firstT = part.measures.find((m) => m.time)?.time;
    for (const m of part.measures) { if (m.time) break; m.time = firstT; }
    inferMeter(part);
    part.measures.forEach((m, i) => { m.index = i; m.number = i + 1; });
    for (const m of part.measures) checkMeasure(m, part);
    all.push(...part.measures);
  }
  const counts = { ok: 0, pickup: 0, end: 0, rest: 0, under: 0, over: 0, repaired: 0 };
  for (const m of all) { counts[m.status]++; if (m.repairs.length) counts.repaired++; }
  return { parts, measures: all, stats: counts };
}

// When no time signature was read, or the one read fits few bars while another fits most,
// take the meter the bars themselves agree on.
function inferMeter(part) {
  const ms = part.measures; if (!ms.length) return;
  const raw = (m) => m.events.reduce((s, e) => s + evTicks(e), 0);
  // segments between time signature changes
  let a = 0;
  while (a < ms.length) {
    let b = a + 1; while (b < ms.length && !ms[b].timeShown) b++;
    const seg = ms.slice(a, b), t = seg[0].time;
    if (!t || !t.fixed) {
      const cnt = (cap) => seg.filter((m, i) => (a > 0 || i > 0) && raw(m) === cap).length;
      const cur = t ? cnt(capOf(t)) : -1;
      let best = null;
      for (const [beats, unit] of METERS) { const c = cnt(capOf({ beats, unit })); if (!best || c > best.c) best = { beats, unit, c }; }
      if (best && best.c >= 2 && best.c > Math.max(1, 2 * cur) && !(t && capOf(t) === capOf(best))) {
        const nt = { beats: best.beats, unit: best.unit, inferred: true };
        for (const m of seg) m.time = nt;
      }
    }
    a = b;
  }
}

// ---------------------------------------------------------------- bar-fill check and repair

function checkMeasure(m, part) {
  m.cap = m.time ? capOf(m.time) : null;
  m.repairs = [];
  const evs = m.events.filter((e) => !e.grace);
  // a lone whole rest is a whole-bar rest in any meter
  if (evs.length === 1 && evs[0].kind === 'rest' && evs[0].dur === 1 && !evs[0].dots) { evs[0].full = true; evs[0].cap = m.cap; m.ticks = m.cap; m.status = 'rest'; return; }
  const sum = () => evs.reduce((s, e) => s + evTicks(e), 0);
  m.ticks = sum();
  if (m.cap == null) { m.status = 'ok'; return; }
  if (m.ticks === m.cap) { m.status = 'ok'; return; }
  const i = part.measures.indexOf(m), prev = part.measures[i - 1];
  const first = i === 0 || prev.double || m.timeShown;
  const last = m.double || i === part.measures.length - 1;
  // Readings to choose from: the bar as read, and (if tuplet numbers were applied) without
  // them - a "3" can be a fingering or a letter. Each may also need a repair to add up.
  const marked = evs.filter((e) => e.tupletMark && !e.tupletFixed);
  const opts = [{ base: 0, set: () => {} }];
  if (marked.length) { const save = marked.map((e) => e.tuplet); opts[0].set = () => marked.forEach((e, k) => (e.tuplet = save[k])); opts.push({ base: 0.8, set: () => marked.forEach((e) => (e.tuplet = null)), text: 'tuplet number ignored' }); }
  let best = null;
  for (const o of opts) {
    o.set();
    const fix = sum() === m.cap ? { cost: 0, edits: [] } : repair(evs, m.cap);
    if (fix && (!best || o.base + fix.cost < best.cost)) best = { cost: o.base + fix.cost, o, fix };
  }
  if (best) {
    best.o.set(); if (best.o.text) { m.repairs.push(best.o.text); marked.forEach((e) => delete e.tupletMark); }
    for (const r of best.fix.edits) { r.apply(); m.repairs.push(r.text); }
    m.ticks = sum(); m.status = 'ok'; return;
  }
  opts[0].set(); m.ticks = sum();
  if (m.ticks < m.cap && (first || last)) { m.status = first ? 'pickup' : 'end'; return; }
  m.status = m.ticks < m.cap ? 'under' : 'over';
}

// Edits that explain a bar that does not add up, each with a cost (how likely that misreading
// is). The cheapest single edit or pair that makes the bar exactly full wins, if unambiguous.
function candidates(evs) {
  const out = [];
  const t0 = (e) => evTicks(e);
  evs.forEach((e, k) => {
    if (e.fixed) return;
    const add = (cost, text, patch) => {
      const old = { dur: e.dur, dots: e.dots, tuplet: e.tuplet };
      const nw = { ...old, ...patch }, delta = evTicks({ ...e, ...nw }) - t0(e);
      if (delta) out.push({ k, cost, delta, text, apply: () => { Object.assign(e, nw); e.repaired = text; } });
    };
    if (e.dots) add(1.0, 'dot removed', { dots: e.dots - 1 }); else add(1.0, 'dot added', { dots: 1 });
    if (e.kind === 'note' && e.dur >= 4 && (e.notes[0].beamed || e.notes[0].flags || e.dur > 4)) {
      if (e.dur >= 8) add(1.6, 'one beam fewer', { dur: e.dur / 2 });
      if (e.dur <= 16) add(1.6, 'one beam more', { dur: e.dur * 2 });
    }
    if (e.kind === 'note' && e.dur === 4 && !e.notes[0].beamed && !e.notes[0].flags) add(2.0, 'flag added', { dur: 8 });
    if (e.kind === 'note' && e.dur === 2) add(2.2, 'half → quarter', { dur: 4 });
    if (e.kind === 'note' && e.dur === 4 && !e.notes[0].beamed) add(2.2, 'quarter → half', { dur: 2 });
    if (e.kind === 'rest') {
      if (e.dur >= 8) add(1.2, 'rest value', { dur: e.dur / 2 }); // rest glyphs vary most between fonts
      if (e.dur <= 16 && e.dur >= 4) add(1.2, 'rest value', { dur: e.dur * 2 });
      out.push({ k, cost: 2.5, delta: -t0(e), text: 'rest removed', apply: () => { e.grace = true; e.removed = true; e.repaired = 'rest removed'; } });
    }
  });
  // triplets whose number was not found: three consecutive events of one written value (or
  // adding up to three units)
  for (let k = 0; k + 3 <= evs.length; k++) {
    const win = evs.slice(k, k + 3);
    if (win.some((e) => e.tuplet || e.fixed || e.tupletFixed)) continue;
    const T = win.reduce((s, e) => s + baseTicks(e.dur, e.dots), 0);
    if (![WHOLE / 2, WHOLE / 4, WHOLE / 8, WHOLE / 16].map((u) => 3 * u).includes(T)) continue;
    const beamed = win[0].beamComp != null && win.every((e) => e.beamComp === win[0].beamComp);
    if (!beamed) continue; // an unmarked triplet is always a beamed group
    out.push({ k, cost: 1.3, delta: -T / 3, text: 'triplet', group: win, apply: () => win.forEach((e) => { e.tuplet = [3, 2]; e.tg = win; e.repaired = 'triplet'; }) });
  }
  return out;
}
function repair(evs, cap) {
  const sum = evs.reduce((s, e) => s + evTicks(e), 0), need = cap - sum;
  if (!need) return null;
  const cs = candidates(evs);
  const sols = [];
  for (const c of cs) if (c.delta === need) sols.push({ cost: c.cost, edits: [c] });
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    const a = cs[i], b = cs[j];
    if (a.k === b.k || (a.group && b.group && Math.abs(a.k - b.k) < 3) || (a.group && b.k >= a.k && b.k < a.k + 3) || (b.group && a.k >= b.k && a.k < b.k + 3)) continue;
    if (a.delta + b.delta === need) sols.push({ cost: a.cost + b.cost + 0.5, edits: [a, b] });
  }
  if (!sols.length) return null;
  sols.sort((a, b) => a.cost - b.cost);
  // ambiguous: two different edits at the same cost (unless they are the same kind of edit on
  // a run of equal notes, e.g. two triplet groups) - keep the bar as read and flag it instead
  if (sols.length > 1 && sols[1].cost - sols[0].cost < 0.15 && sols[1].edits.map((e) => e.text).join() !== sols[0].edits.map((e) => e.text).join()) return null;
  if (sols[0].cost > 4.5) return null;
  return sols[0];
}

/** Events of a part in order with onsets (ticks from the start of the part). */
export function timeline(part) {
  const out = []; let t0 = 0;
  for (const m of part.measures) {
    let t = t0;
    for (const e of m.events) { if (e.removed) continue; out.push({ e, m, tick: t, ticks: evTicks(e) }); t += evTicks(e); }
    // short bars (pickups) last as long as their contents
    t0 += m.status === 'rest' ? m.cap : m.ticks;
  }
  return out;
}

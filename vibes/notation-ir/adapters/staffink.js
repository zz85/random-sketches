// StaffInk score -> timeline IR. StaffInk keeps notes inside fixed-capacity measures; here
// each event just gets an onset (measure start + what precedes it in the bar), so a bar
// the user has only half written becomes a gap, not a padded measure, and the meter is a
// direction the interpretation can follow, change or drop.
//
// IR event ids are `si<StaffInk id>` (siId / inkId convert), so a playback program can
// anchor to the notes the user sees, and playback can highlight them. Each note carries the
// velocity StaffInk's own playback would give it (dynamics, hairpins, accents).
import { resolveAttrs, measureCapacity, ticks, DIV, CLEF_BASE, articsOf, setArtic, newScore, newMeasure, ensureTrailingMeasure, DYNAMICS } from '../../staffink/theory.js';
import { velocities } from '../../staffink/export.js';
import { createScore, addEvent, addDirection, addLink, directions, directionAt, allStaves } from '../ir.js';
import { interpret, notateDuration } from '../interpret.js';
import { fromTicks, sub, lt, ZERO } from '../rational.js';

export const siId = (inkId) => `si${inkId}`;
export const inkId = (irId) => (typeof irId === 'string' && irId.startsWith('si') ? Number(irId.slice(2)) : null);

/** StaffInk articulation names <-> IR marks. */
export const MARK = { stacc: 'staccato', staccatissimo: 'staccatissimo', tenuto: 'tenuto', accent: 'accent', marcato: 'marcato', fermata: 'fermata' };

const CLEF = { G: { sign: 'G', line: 2 }, F: { sign: 'F', line: 4 }, C: { sign: 'C', line: 3 } };

export function fromStaffInk(si) {
  const score = createScore({ title: si.title, staves: si.staves.length });
  const staves = score.parts[0].staves;
  const T = (t) => fromTicks(t, DIV);
  const attrs = resolveAttrs(si);
  const vels = velocities(si);
  const ids = new Map(); // StaffInk id -> IR id
  const seq = staves.map(() => []);
  let t0 = 0;
  si.measures.forEach((m, mi) => {
    const a = attrs[mi];
    if (a.changed.time) addDirection(score, 'meter', T(t0), { beats: a.time[0], unit: a.time[1] });
    if (a.changed.key) addDirection(score, 'key', T(t0), { fifths: a.key });
    a.clefs.forEach((c, s) => { if (a.changed.clefs[s]) addDirection(score, 'clef', T(t0), CLEF[c], { staff: staves[s].id }); });
    m.staves.forEach((st, s) => {
      let t = t0;
      for (const ev of st.events) {
        const len = ev.full ? measureCapacity(a.time) : ticks(ev);
        const e = addEvent(score, {
          voice: score.voices[s].id, onset: T(t), dur: T(len),
          heads: ev.kind === 'note' ? ev.heads.map((h) => ({ d: CLEF_BASE[a.clefs[s]] + h.pos, acc: h.acc ?? null })) : [],
          written: ev.full ? undefined : { type: ev.dur, dots: ev.dots || 0, tuplet: ev.tuplet ? [ev.tuplet.n, ev.tuplet.m] : null },
          src: { staffink: ev.id, measure: mi }, id: siId(ev.id),
        });
        const marks = articsOf(ev).map((a) => MARK[a]);
        if (marks.length) e.marks = marks;
        if (ev.kind === 'note') e.vel = Math.min(1, Math.max(0.08, vels.get(ev.id) ?? 0.68));
        if (ev.dyn) addDirection(score, 'dynamic', T(t), { text: ev.dyn }, { staff: staves[s].id, event: e.id });
        ids.set(ev.id, e.id);
        seq[s].push({ ev, e });
        t += len;
      }
    });
    t0 += measureCapacity(a.time);
  });
  for (const list of seq) list.forEach(({ ev, e }, i) => { if (ev.tie && list[i + 1]) addLink(score, 'tie', [e.id, list[i + 1].e.id]); });
  for (const sl of si.slurs || []) if (ids.has(sl.from) && ids.has(sl.to)) addLink(score, 'slur', [ids.get(sl.from), ids.get(sl.to)]);
  for (const h of si.hairpins || []) if (ids.has(h.from) && ids.has(h.to)) addLink(score, 'hairpin', [ids.get(h.from), ids.get(h.to)], { type: h.type });
  return score;
}

// ------------------------------------------------------------------ IR -> StaffInk
//
// The reverse: interpret the IR (bars, ties across them, rests, spelling), then write each
// staff's first voice as StaffInk measures, so music from anywhere (a photographed page) can
// be edited with the pen. StaffInk is stricter than the IR, and everything it cannot hold is
// listed in `report` rather than silently changed:
//   dropped       other voices on a staff (StaffInk writes one voice per staff)
//   approximated  tuplets other than 3:2 and 6:4, written as plain values (the bar overfills)
//   clefs         clefs StaffInk does not have (tenor, octave clefs), written as the nearest
//   padded        a pickup, filled with rests at its start (StaffInk has no anacrusis)
//   meter         set when the IR had no meter and 4/4 was assumed
const SI_TUPLETS = { 3: 2, 6: 4 };
const ART = Object.fromEntries(Object.entries(MARK).map(([k, v]) => [v, k]));

export function toStaffInk(ir, opts = {}) {
  const report = { dropped: [], approximated: [], clefs: [], padded: 0, meter: null };
  const hasMeter = directions(ir, 'meter').length > 0 || opts.meter;
  if (!hasMeter) report.meter = [4, 4];
  const res = interpret(ir, { fillGaps: 'rests', ...opts, ...(hasMeter ? {} : { meter: [{ beats: 4, unit: 4 }] }) });
  const staffIds = allStaves(ir);
  const clefs = staffIds.map((st) => {
    const c = directionAt(ir, 'clef', ZERO, st) || { sign: 'G', line: 2, octave: 0 };
    const exact = (c.sign === 'G' && c.line === 2) || (c.sign === 'F' && c.line === 4) || (c.sign === 'C' && c.line === 3);
    if (!exact || c.octave) report.clefs.push({ staff: st, clef: `${c.sign}${c.line}${c.octave ? (c.octave > 0 ? '+' : '') + c.octave * 8 : ''}`, as: c.sign });
    return c.sign;
  });
  const first = res.measures[0];
  const meterOf = (m) => (m.meter ? [m.meter.beats, m.meter.unit] : [4, 4]);
  const score = newScore({
    title: ir.title, staves: clefs.map((c) => ({ clef: c })), time: meterOf(first || {}),
    key: directionAt(ir, 'key', ZERO)?.fifths ?? 0, tempo: opts.tempo || directionAt(ir, 'tempo', ZERO)?.bpm || 96,
  });
  score.measures = res.measures.map(() => newMeasure(staffIds.length));
  let id = 1;
  const firstPiece = new Map(); // IR event id -> StaffInk id of its first written piece
  const byIr = new Map(ir.events.map((e) => [e.id, e]));
  const dynOf = new Map(ir.directions.filter((d) => d.kind === 'dynamic' && d.event).map((d) => [d.event, d.text]));

  // meter, key and clef changes as measure attributes
  let time = score.time, key = score.key;
  res.measures.forEach((m, mi) => {
    const a = score.measures[mi].attrs, mt = meterOf(m);
    if (mi > 0 && (mt[0] !== time[0] || mt[1] !== time[1])) { a.time = mt; time = mt; }
    const k = directionAt(ir, 'key', m.start)?.fifths ?? 0;
    if (mi > 0 && k !== key) { a.key = k; key = k; }
  });

  staffIds.forEach((st, si) => {
    const voices = ir.voices.filter((v) => v.staff === st);
    for (const v of voices.slice(1)) {
      const n = ir.events.filter((e) => e.voice === v.id).length;
      if (n) report.dropped.push({ voice: v.id, events: n });
    }
    if (!voices.length) return;
    const base = CLEF_BASE[clefs[si]];
    const pieces = res.voices.get(voices[0].id) || [];
    // a pickup becomes a full first bar with rests in front
    if (first && first.status === 'pickup' && first.cap) {
      for (const v of notateDuration(sub(first.cap, first.len))) score.measures[0].staves[si].events.push({ id: id++, kind: 'rest', dur: v.type, dots: v.dots, heads: [] });
      report.padded++;
    }
    for (const p of pieces) {
      if (p.kind === 'space') continue;
      const out = score.measures[p.measure].staves[si].events;
      if (p.type === 'bar') { out.push({ id: id++, kind: 'rest', dur: 1, dots: 0, full: true, heads: [] }); continue; }
      const ev = { id: id++, kind: p.kind === 'note' ? 'note' : 'rest', dur: p.type || 4, dots: p.dots, heads: [] };
      if (p.tuplet) {
        if (SI_TUPLETS[p.tuplet[0]] === p.tuplet[1]) ev.tuplet = { id: `t${si}_${p.tupletGroup}`, n: p.tuplet[0], m: p.tuplet[1] };
        else report.approximated.push({ event: p.event, tuplet: p.tuplet });
      }
      if (p.kind === 'note') {
        ev.heads = p.heads.map((h) => ({ pos: h.d - base, acc: h.show ?? null }));
        if (p.tie) ev.tie = true;
      }
      const src = p.event && byIr.get(p.event);
      if (src && !p.cont) {
        firstPiece.set(src.id, ev.id);
        for (const mk of src.marks || []) if (ART[mk]) setArtic(ev, ART[mk], true);
        const dyn = dynOf.get(src.id);
        if (dyn && DYNAMICS.includes(dyn)) ev.dyn = dyn;
      }
      out.push(ev);
    }
  });
  for (const l of ir.links) {
    const a = firstPiece.get(l.ids[0]), b = firstPiece.get(l.ids[l.ids.length - 1]);
    if (a == null || b == null || a === b) continue;
    if (l.kind === 'slur') score.slurs.push({ from: a, to: b });
    if (l.kind === 'hairpin') score.hairpins.push({ from: a, to: b, type: l.type === 'cresc' ? 'cresc' : 'dim' });
  }
  score.nextId = id;
  ensureTrailingMeasure(score);
  return { score, report };
}
void lt;

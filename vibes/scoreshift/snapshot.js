// A readable snapshot of what a page reads as, for regression tests: per staff its clef and key
// (and key changes), per bar its time signature and every event in order: pitch name and value
// (dots, triplet, tie ~, grace g/ga, voice), articulations and bowing, rests; dynamics, hairpins
// and slurs by the bar and note they start on. Compared bar by bar, so a change reads as
// "bar 21: F♯♯3:16 -> F♯3:16" instead of a wall of JSON.
import { buildScore, evTicks } from './score.js';

const val = (e) => `${e.full ? 'bar' : e.dur}${'.'.repeat(e.dots || 0)}${e.tuplet ? 't' : ''}`;
export function snapshot(model) {
  const sc = buildScore(model);
  const where = new Map(); for (const m of sc.measures) for (const e of m.events) for (const n of e.notes || []) where.set(n, m.number);
  const staves = model.staves.map((st) => ({ clef: st.clef.type, key: st.key.fifths, ...(st.keyChanges?.length ? { keyChanges: st.keyChanges.map((k) => k.fifths) } : {}) }));
  const bars = sc.measures.map((m) => {
    const ev = m.events.filter((e) => !e.removed).map((e) => {
      if (e.kind === 'rest') return `r${val(e)}`;
      const g = e.grace ? (e.notes[0].graceKind === 'app' ? 'ga:' : 'g:') : '';
      const art = (e.notes[0].artic || []).slice().sort().join(',');
      return `${g}${e.notes.map((n) => n.name).join('+')}:${e.grace ? 'grace' : val(e)}${e.tie ? '~' : ''}${m.voices > 1 ? `/v${(e.voice ?? 0) + 1}` : ''}${art ? `[${art}]` : ''}`;
    });
    return { bar: m.number, staff: m.st.index, time: m.time ? `${m.time.beats}/${m.time.unit}` : null, status: m.status, events: ev.join(' ') };
  });
  const at = (n) => (n ? `${where.get(n)}:${n.name}` : '-');
  const expr = model.staves.flatMap((st) => [
    ...(st.dynamics || []).map((d) => `${d.text}@${at(d.note)}`),
    ...(st.hairpins || []).map((h) => `${h.form}@${at(h.from)}`),
    ...(st.slurs || []).map((s) => `slur@${at(s.from)}-${at(s.to)}`),
  ]);
  return { notes: model.notes.length, staves, bars, expression: expr };
}

/** Differences between two snapshots, as readable lines (empty when they agree). */
export function diffSnapshots(want, got) {
  const out = [];
  if (want.notes !== got.notes) out.push(`notes: ${want.notes} -> ${got.notes}`);
  want.staves.forEach((s, i) => { if (JSON.stringify(s) !== JSON.stringify(got.staves[i])) out.push(`staff ${i + 1}: ${JSON.stringify(s)} -> ${JSON.stringify(got.staves[i])}`); });
  if (want.staves.length !== got.staves.length) out.push(`staves: ${want.staves.length} -> ${got.staves.length}`);
  const n = Math.max(want.bars.length, got.bars.length);
  for (let i = 0; i < n; i++) {
    const a = want.bars[i], b = got.bars[i];
    if (!a || !b) { out.push(`bar ${i + 1}: ${a ? a.events : '(none)'} -> ${b ? b.events : '(none)'}`); continue; }
    for (const k of ['time', 'status', 'events']) if (a[k] !== b[k]) out.push(`bar ${a.bar} ${k}: ${a[k]} -> ${b[k]}`);
  }
  const A = new Set(want.expression), B = new Set(got.expression);
  for (const x of A) if (!B.has(x)) out.push(`lost: ${x}`);
  for (const x of B) if (!A.has(x)) out.push(`new: ${x}`);
  return out;
}
void evTicks;

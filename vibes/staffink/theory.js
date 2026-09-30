// Score model and music theory. Pure functions, no DOM.
//
// Staff position `pos`: 0 = bottom line, 1 = first space, ... 8 = top line; ledger
// positions continue below 0 and above 8. A duration `dur` is the note value
// denominator (1 whole, 2 half, 4 quarter ... 64). Ticks: DIV per quarter note.

export const DIV = 96;

export function newScore(opts = {}) {
  const staves = opts.staves || [{ clef: 'G' }];
  return {
    version: 1, title: opts.title || 'Untitled', tempo: opts.tempo || 96,
    key: opts.key || 0, time: opts.time || [4, 4], staves,
    measures: [newMeasure(staves.length), newMeasure(staves.length)],
    slurs: [], nextId: 1,
  };
}
export function newMeasure(nStaves) { return { attrs: {}, staves: Array.from({ length: nStaves }, () => ({ events: [] })) }; }

export function ticks(ev) {
  const base = (4 / ev.dur) * DIV;
  let t = base, add = base;
  for (let i = 0; i < (ev.dots || 0); i++) { add /= 2; t += add; }
  return t;
}
export function measureCapacity(time) { return time[0] * (4 / time[1]) * DIV; }

/** Duration in ticks of an event inside a measure with `time` (full-measure rests fill it). */
export function evTicks(ev, time) { return ev.full ? measureCapacity(time) : ticks(ev); }

/** Effective clef/key/time for every measure, and which ones change there. */
export function resolveAttrs(score) {
  const out = [];
  let clefs = score.staves.map((s) => s.clef), key = score.key, time = score.time;
  score.measures.forEach((m, i) => {
    const a = m.attrs || {};
    const changed = { clefs: score.staves.map(() => i === 0), key: i === 0, time: i === 0 };
    if (a.clefs) a.clefs.forEach((c, s) => { if (c && c !== clefs[s]) { clefs = clefs.slice(); clefs[s] = c; changed.clefs[s] = true; } });
    if (a.key !== undefined && a.key !== key) { key = a.key; changed.key = true; }
    if (a.time && (a.time[0] !== time[0] || a.time[1] !== time[1])) { time = a.time; changed.time = true; }
    out.push({ clefs, key, time, timeSym: a.timeSym || (i === 0 ? score.timeSym : undefined), changed });
  });
  return out;
}

// diatonic step of the bottom staff line: C4 = 28 (octave * 7 + letter, C=0)
export const CLEF_BASE = { G: 30, F: 18, C: 24 };
const LETTER_SEMIS = [0, 2, 4, 5, 7, 9, 11];
export const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6];  // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];   // B E A D G C F

export function keyAlter(key, letter) {
  if (key > 0) return SHARP_ORDER.slice(0, key).includes(letter) ? 1 : 0;
  if (key < 0) return FLAT_ORDER.slice(0, -key).includes(letter) ? -1 : 0;
  return 0;
}

/** Key signature glyph positions on a staff with `clef` (standard engraving order). */
export function keySigPositions(key, clef) {
  const sharps = [8, 5, 9, 6, 3, 7, 4], flats = [4, 7, 3, 6, 2, 5, 1]; // treble
  const shift = clef === 'F' ? -2 : clef === 'C' ? -1 : 0;
  return (key > 0 ? sharps.slice(0, key) : flats.slice(0, -key)).map((p) => p + shift);
}

export function diatonic(pos, clef) { return CLEF_BASE[clef] + pos; }
export function stepName(d) { return { step: LETTERS[((d % 7) + 7) % 7], octave: Math.floor(d / 7) }; }
export function midiOf(d, alter) { const l = ((d % 7) + 7) % 7; return LETTER_SEMIS[l] + 12 * (Math.floor(d / 7) + 1) + alter; }

/**
 * Pitches for every head in one staff of one measure: key signature, then accidentals
 * carrying through the bar at the same staff position, ties keep the previous pitch.
 * @returns Map(event -> [{d, alter, midi, showAcc}]) aligned with ev.heads
 */
export function spellMeasure(events, clef, key, carryIn) {
  const acc = new Map(); // pos -> alter set by an accidental earlier in the bar
  const out = new Map();
  let prevTied = carryIn || null;
  for (const ev of events) {
    if (ev.kind !== 'note') { out.set(ev, []); prevTied = null; continue; }
    const heads = ev.heads.map((h) => {
      const d = diatonic(h.pos, clef), letter = ((d % 7) + 7) % 7;
      let alter;
      if (h.acc !== null && h.acc !== undefined) { alter = h.acc; acc.set(h.pos, alter); }
      else if (prevTied && prevTied.has(h.pos)) alter = prevTied.get(h.pos);
      else if (acc.has(h.pos)) alter = acc.get(h.pos);
      else alter = keyAlter(key, letter);
      return { d, alter, midi: midiOf(d, alter), showAcc: h.acc !== null && h.acc !== undefined };
    });
    out.set(ev, heads);
    prevTied = ev.tie ? new Map(ev.heads.map((h, i) => [h.pos, heads[i].alter])) : null;
  }
  return { spelled: out, tieOut: prevTied };
}

/** Every head's pitch in the score: Map(ev -> heads[]) plus per-measure fill state. */
export function spellScore(score) {
  const attrs = resolveAttrs(score);
  const spelled = new Map(), fill = [];
  const carry = score.staves.map(() => null);
  score.measures.forEach((m, mi) => {
    const a = attrs[mi];
    const cap = measureCapacity(a.time);
    const f = [];
    m.staves.forEach((st, si) => {
      const r = spellMeasure(st.events, a.clefs[si], a.key, carry[si]);
      for (const [ev, h] of r.spelled) spelled.set(ev, h);
      carry[si] = r.tieOut;
      const used = st.events.reduce((t, ev) => t + evTicks(ev, a.time), 0);
      f.push({ used, cap, over: used > cap, full: used === cap });
    });
    fill.push(f);
  });
  return { spelled, fill, attrs };
}

export function findEvent(score, id) {
  for (let mi = 0; mi < score.measures.length; mi++) {
    const m = score.measures[mi];
    for (let si = 0; si < m.staves.length; si++) {
      const i = m.staves[si].events.findIndex((e) => e.id === id);
      if (i >= 0) return { mi, si, i, ev: m.staves[si].events[i], events: m.staves[si].events };
    }
  }
  return null;
}

/** Events in reading order for one staff: [{ev, mi, si, onset}] */
export function staffSequence(score, si) {
  const attrs = resolveAttrs(score);
  const out = [];
  let t0 = 0;
  score.measures.forEach((m, mi) => {
    let t = t0;
    for (const ev of m.staves[si].events) { out.push({ ev, mi, si, onset: t }); t += evTicks(ev, attrs[mi].time); }
    t0 += measureCapacity(attrs[mi].time);
  });
  return out;
}

/** Keep exactly one empty measure at the end (StaffPad-style endless paper). */
export function ensureTrailingMeasure(score) {
  const empty = (m) => m.staves.every((s) => s.events.length === 0) && !Object.keys(m.attrs || {}).length;
  while (score.measures.length > 1 && empty(score.measures[score.measures.length - 1]) && empty(score.measures[score.measures.length - 2])) score.measures.pop();
  if (!empty(score.measures[score.measures.length - 1])) score.measures.push(newMeasure(score.staves.length));
}

export const DUR_NAMES = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd', 64: '64th' };
export function describe(ev, heads) {
  const d = (ev.dots ? (ev.dots > 1 ? 'double-dotted ' : 'dotted ') : '') + DUR_NAMES[ev.dur];
  if (ev.kind === 'rest') return `${ev.full ? 'bar' : d} rest`;
  const names = (heads || []).map((h) => { const s = stepName(h.d); return s.step + ['𝄫', '♭', '', '♯', '𝄪'][h.alter + 2] + s.octave; });
  return `${d} ${names.join(' ')}`;
}

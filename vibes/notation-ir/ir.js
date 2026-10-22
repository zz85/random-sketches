// Content layer: what the music IS, with no measures.
//
// A score is a set of events on one timeline (onset + duration, exact rationals in whole
// notes), in voices that belong to a staff of a part. Ties, slurs, tuplet groupings are
// links between events. Clefs, keys, printed time signatures, printed barlines, dynamics
// and tempo are directions at a time. Nothing here requires a bar to be full, or bars to
// exist at all: barlines, bar-crossing ties, rests and written note values are decided by
// the interpretation layer (interpret.js), and every such decision can be overridden.
//
// Pitch: d = diatonic index (C0 = 0, C4 = 28, so d % 7 is the letter C..B). A head has
//   alter  the sounding alteration in semitones when it is known (imported music), or
//          undefined when it should be resolved from key + accidental scope (ink, OMR)
//   acc    an accidental that was actually written/printed (-2..2) or null
// Content stores pitch, not staff position, so a clef change never changes a note.
//
// Uncertain input: events that are competing readings of the same thing share
// alt = { group, option, conf }. Interpretation picks one option per group (the most
// confident unless told otherwise); the others stay in the score for the user to swap in.
//
// Source geometry: any event or direction may carry src = { x, y, line, ... } in the input's
// own units (handwriting position, printed position on a page; line = which staff line /
// system it sits on). Layout and playback anchors resolve against it.
//
// Fragments: every event and direction belongs to a fragment (default 'main'), and onsets
// are local to it. A fragment is an idea with its own time, e.g. a phrase sketched off to
// the side; nothing relates its time to another fragment's until a playback program does.

import { r, ZERO, add, cmp, lt, max, parse } from './rational.js';

export function createScore({ title = 'Untitled', staves = 1 } = {}) {
  const score = { version: 1, title, parts: [], voices: [], events: [], links: [], directions: [], fragments: [{ id: 'main' }], nextId: 1 };
  addPart(score, { name: 'Part 1', staves });
  return score;
}

const nid = (score, p) => `${p}${score.nextId++}`;

export function addPart(score, { name = `Part ${score.parts.length + 1}`, staves = 1 } = {}) {
  const id = `P${score.parts.length + 1}`;
  const part = { id, name, staves: Array.from({ length: staves }, (_, i) => ({ id: `${id}S${i + 1}` })) };
  score.parts.push(part);
  for (const st of part.staves) addVoice(score, { staff: st.id });
  return part;
}

export function addVoice(score, { staff, id } = {}) {
  staff = staff || score.parts[0].staves[0].id;
  const v = { id: id || `v${score.voices.length + 1}`, staff };
  score.voices.push(v);
  return v;
}

export const MAIN = 'main';
export const fragOf = (x) => x.fragment ?? MAIN;

export function addFragment(score, { id = `f${score.fragments.length}`, src } = {}) {
  const f = { id };
  if (src) f.src = src;
  score.fragments.push(f);
  return f;
}

export const staffOf = (score, voiceId) => score.voices.find((v) => v.id === voiceId)?.staff;
export const allStaves = (score) => score.parts.flatMap((p) => p.staves.map((s) => s.id));

/**
 * Add a note or rest. onset/dur accept rationals or "3/16" strings.
 * heads: [{ d, alter?, acc? }] (empty for a rest). written: optional hint for how the input
 * spelled the rhythm ({ type: 4, dots: 0, tuplet: [3, 2] }), used when no split is needed.
 */
export function addEvent(score, { voice, onset, dur, heads = [], kind, written, src, alt, marks, id, fragment } = {}) {
  voice = voice || score.voices[0].id;
  onset = parse(onset); dur = parse(dur);
  if (cmp(dur, ZERO) <= 0) throw new Error('event duration must be positive');
  const ev = {
    id: id || nid(score, 'e'), voice, onset, dur,
    kind: kind || (heads.length ? 'note' : 'rest'),
    heads: heads.map((h) => ({ d: h.d, alter: h.alter, acc: h.acc ?? null })),
  };
  if (fragment && fragment !== MAIN) ev.fragment = fragment;
  if (written) ev.written = written;
  if (src) ev.src = src;
  if (alt) ev.alt = alt;
  if (marks) ev.marks = marks;
  score.events.push(ev);
  return ev;
}

/** kind: tie | slur | tuplet | beam | hairpin. ids in time order. */
export function addLink(score, kind, ids, extra = {}) {
  const l = { id: nid(score, 'l'), kind, ids: [...ids], ...extra };
  score.links.push(l);
  return l;
}

/**
 * kind: clef {sign, line, octave} | key {fifths} | meter {beats, unit} | barline {style}
 *       | dynamic {text} | tempo {bpm, unit}. staff omitted = every staff.
 */
export function addDirection(score, kind, at, fields = {}, { staff, src, fragment, event } = {}) {
  const d = { id: nid(score, 'd'), kind, at: parse(at), ...fields };
  if (event) d.event = event; // attached to an event (a dynamic under a note)
  if (fragment && fragment !== MAIN) d.fragment = fragment;
  if (staff) d.staff = staff;
  if (src) d.src = src;
  score.directions.push(d);
  return d;
}

export const directions = (score, kind, staff, fragment = MAIN) =>
  score.directions.filter((d) => d.kind === kind && fragOf(d) === fragment && (!staff || !d.staff || d.staff === staff)).sort((a, b) => cmp(a.at, b.at));

/** The direction of `kind` in force at time t on a staff (last one at or before t). */
export function directionAt(score, kind, t, staff, fragment = MAIN) {
  let cur = null;
  for (const d of directions(score, kind, staff, fragment)) { if (cmp(d.at, t) <= 0) cur = d; else break; }
  return cur;
}

export const endOf = (ev) => add(ev.onset, ev.dur);

/** Options of an alt group, most confident first. */
export function altOptions(score, group) {
  const m = new Map();
  for (const e of score.events) if (e.alt?.group === group) m.set(e.alt.option, Math.max(m.get(e.alt.option) ?? -1, e.alt.conf ?? 0));
  return [...m].sort((a, b) => b[1] - a[1]).map(([o]) => o);
}

/**
 * Events of the chosen reading in one fragment (all fragments when fragment = null):
 * one option per alt group (picks[group] or the most confident).
 */
export function active(score, picks = {}, fragment = MAIN) {
  const best = new Map();
  for (const e of score.events) {
    if (!e.alt) continue;
    const g = e.alt.group, cur = best.get(g);
    if (!cur || (e.alt.conf ?? 0) > cur.conf) best.set(g, { option: e.alt.option, conf: e.alt.conf ?? 0 });
  }
  return score.events
    .filter((e) => fragment === null || fragOf(e) === fragment)
    .filter((e) => !e.alt || e.alt.option === (picks[e.alt.group] ?? best.get(e.alt.group).option))
    .sort((a, b) => cmp(a.onset, b.onset));
}

/** Last moment anything happens. */
export function scoreEnd(score, events = active(score), fragment = MAIN) {
  let t = ZERO;
  for (const e of events) t = max(t, endOf(e));
  for (const d of score.directions) if (fragOf(d) === fragment) t = max(t, d.at);
  return t;
}

/** Facts worth telling the user about, never fixed silently: overlaps inside one voice, gaps. */
export function check(score, picks, fragment = MAIN) {
  const out = [];
  for (const v of score.voices) {
    const evs = active(score, picks, fragment).filter((e) => e.voice === v.id);
    for (let i = 1; i < evs.length; i++) {
      const prevEnd = endOf(evs[i - 1]);
      if (lt(evs[i].onset, prevEnd)) out.push({ kind: 'overlap', voice: v.id, ids: [evs[i - 1].id, evs[i].id] });
      else if (lt(prevEnd, evs[i].onset)) out.push({ kind: 'gap', voice: v.id, from: prevEnd, to: evs[i].onset });
    }
  }
  return out;
}

export { r };

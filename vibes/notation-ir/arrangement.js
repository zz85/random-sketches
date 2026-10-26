// Arrangements: playback markers a user places on the music, shared by StaffInk and
// ScoreShift. Pure, no DOM.
//
// arrangement = {
//   mode:  'score'  play through the music, taking the jump markers
//          'clips'  play the clips in order; a clip marked `withPrev` sounds together with
//                   the one before it (a canon, a layer, two loops phasing)
//   clips: [{ id, name, from, to (event ids, inclusive), loop, withPrev, delay (beats), transpose }]
//   jumps: [{ id, from (after this event), to (to this event), times }]
//   next:  id counter
// }
// Ids are whatever the app uses; `idOf` turns one into the IR event id (StaffInk: 5 -> 'si5';
// ScoreShift stores IR ids already). compileArrangement turns it into a playback.js program,
// arrangementMarkers into markers.js markers.
import { lt, le, cmp } from './rational.js';
import { MAIN, endOf } from './ir.js';
import { findById } from './anchors.js';
import { COLORS } from './markers.js';

export const emptyArrangement = () => ({ mode: 'score', clips: [], jumps: [], next: 1 });
export const hasMarkers = (a) => !!a && (a.clips.length > 0 || a.jumps.length > 0);
const LETTER = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');

/** A new clip over range = { first, last } (event ids); named with the first free letter. */
export function addClip(arr, range) {
  const used = new Set(arr.clips.map((c) => c.name));
  let k = 0; while (used.has(LETTER(k))) k++;
  const c = { id: `c${arr.next++}`, name: LETTER(k), from: range.first, to: range.last, loop: 1, withPrev: false, delay: 0, transpose: 0 };
  arr.clips.push(c);
  return c;
}
export function addJump(arr, from, to) {
  const j = { id: `j${arr.next++}`, from, to, times: 1 };
  arr.jumps.push(j);
  return j;
}
export function removeMarker(arr, id) {
  if (!arr) return false;
  const n = arr.clips.length + arr.jumps.length;
  arr.clips = arr.clips.filter((c) => c.id !== id); arr.jumps = arr.jumps.filter((j) => j.id !== id);
  return arr.clips.length + arr.jumps.length < n;
}
/**
 * Move a clip to position `to` in the playing order (clamped). The first clip plays on its
 * own, so it loses `withPrev`. Returns true when the order changed.
 */
export function moveClip(arr, id, to) {
  const i = arr ? arr.clips.findIndex((c) => c.id === id) : -1;
  if (i < 0) return false;
  const j = Math.max(0, Math.min(arr.clips.length - 1, to));
  if (j === i) return false;
  const [c] = arr.clips.splice(i, 1);
  arr.clips.splice(j, 0, c);
  if (arr.clips[0]) arr.clips[0].withPrev = false;
  return true;
}
/** A clip's colour index: by its letter, so it keeps its colour when the order changes. */
export const clipHue = (c) => Math.max(0, (c.name || 'A').charCodeAt(0) - 65) + 26 * (parseInt(c.name.slice(1), 10) || 0);

export const markerById = (arr, id) => (arr && (arr.clips.find((c) => c.id === id) || arr.jumps.find((j) => j.id === id))) || null;
/** The event ids a marker is attached to, by role: { from, to }. */
export const markerEnds = (m) => ({ from: m.from, to: m.to });

const ident = (id) => id;
function clipNode(c, beat, idOf) {
  const play = { play: { from: { event: idOf(c.from) }, to: { event: idOf(c.to), edge: 'end' } }, marker: c.id, name: c.name };
  const n = (c.loop || 1) > 1 ? { loop: c.loop, body: play } : play;
  if (c.transpose) n.transpose = c.transpose;
  if (c.delay) n.delay = `${c.delay}/${beat}`;
  return n;
}

/**
 * The playback program for an arrangement. With `range` ({ first, last }), just that stretch,
 * looping when loop > 1. beat = the time signature's unit, for clip delays in beats.
 */
export function compileArrangement(arr, { range = null, loop = 1, beat = 4, idOf = ident } = {}) {
  const a = arr || emptyArrangement();
  if (range) {
    const play = { play: { from: { event: idOf(range.first) }, to: { event: idOf(range.last), edge: 'end' } } };
    return { root: loop > 1 ? { loop, body: play } : play };
  }
  if (a.mode === 'clips' && a.clips.length) {
    const steps = [];
    for (const c of a.clips) { if (c.withPrev && steps.length) steps[steps.length - 1].push(c); else steps.push([c]); }
    return { root: { seq: steps.map((s) => (s.length > 1 ? { par: s.map((c) => clipNode(c, beat, idOf)) } : clipNode(s[0], beat, idOf))) } };
  }
  return { root: { walk: {} }, jumps: a.jumps.map((j) => ({ at: { event: idOf(j.from), edge: 'end' }, to: { event: idOf(j.to) }, times: j.times || 1, marker: j.id })) };
}

/** Markers for drawing (markers.js): every clip and jump, in either mode. */
export function arrangementMarkers(arr, { idOf = ident } = {}) {
  const a = arr || emptyArrangement();
  return {
    clips: a.clips.map((c) => ({ id: c.id, name: c.name, loop: c.loop, transpose: c.transpose, from: { event: idOf(c.from) }, to: { event: idOf(c.to), edge: 'end' }, withPrev: c.withPrev, color: COLORS[clipHue(c) % COLORS.length] })),
    jumps: a.jumps.map((j, k) => ({ id: j.id, name: `J${k + 1}`, at: { event: idOf(j.from), edge: 'end' }, to: { event: idOf(j.to) }, times: j.times })),
  };
}

/**
 * A range over an IR score between two events, like a text selection: every event (any
 * staff, any voice) starting from the earlier one's onset up to the later one's end. A clip
 * over it runs from `first` (the earlier end point) to the end of `last` (the later one).
 * Page-keyed ids are matched as anchors are (findById), so a range survives a re-read.
 */
export function rangeOfIR(score, a, b, fragment = MAIN) {
  const A = findById(score, 'event', a), B = findById(score, 'event', b);
  if (!A || !B) return null;
  const first = cmp(A.onset, B.onset) <= 0 ? A : B, last = cmp(endOf(A), endOf(B)) >= 0 ? A : B;
  const t0 = first.onset, t1 = endOf(last);
  const inside = score.events.filter((e) => (e.fragment ?? MAIN) === fragment && le(t0, e.onset) && lt(e.onset, t1));
  return { ids: new Set(inside.map((e) => e.id)), first: first.id, last: last.id, t0, t1, n: inside.filter((e) => e.kind === 'note').length, events: inside };
}

// Arrangements: the playback markers a StaffInk score carries (score.program), and the
// text-editor-like range selection. Pure (no DOM), so it runs under bun.
//
// score.program = {
//   mode:  'score'  play through the score, taking the jump markers
//          'clips'  play the clips in order; a clip marked `withPrev` sounds together with
//                   the one before it (a canon, a layer, two loops phasing)
//   clips: [{ id, name, from, to (StaffInk event ids, inclusive), loop, withPrev, delay (beats), transpose }]
//   jumps: [{ id, from (after this event), to (to this event), times }]
// }
// Markers point at StaffInk event ids, which never change, so they follow every edit; a marker
// whose note is erased is removed (and comes back with undo).
// The arrangement itself (clips, jumps, compiling to a program) is shared with ScoreShift:
// ../notation-ir/arrangement.js. This file adds StaffInk's side: its timeline and selection.
import { resolveAttrs, measureCapacity, evTicks, findEvent } from './theory.js';
import {
  emptyArrangement, hasMarkers, addClip as sharedAddClip, addJump as sharedAddJump, removeMarker as sharedRemove,
  markerById as sharedById, compileArrangement, arrangementMarkers, moveClip as sharedMove,
} from '../notation-ir/arrangement.js';

export const siId = (id) => `si${id}`;

/** Every event in time order: [{ id, ev, si, mi, onset, end }] (ticks), all staves. */
export function timeline(score) {
  const attrs = resolveAttrs(score), out = [];
  let t0 = 0;
  score.measures.forEach((m, mi) => {
    m.staves.forEach((st, si) => {
      let t = t0;
      for (const ev of st.events) { const d = evTicks(ev, attrs[mi].time); out.push({ id: ev.id, ev, si, mi, onset: t, end: t + d }); t += d; }
    });
    t0 += measureCapacity(attrs[mi].time);
  });
  return out.sort((a, b) => a.onset - b.onset || a.si - b.si);
}

/**
 * A range between two events, like a text selection between two characters: every event on
 * any staff that starts from the earlier one's onset up to the later one's end. A clip over it
 * runs from `first` (the earlier end point) to the end of `last` (the later one), so a long
 * note on another staff is cut off where the selection ends.
 */
export function rangeOf(score, a, b, tl = timeline(score)) {
  const A = tl.find((q) => q.id === a), B = tl.find((q) => q.id === b);
  if (!A || !B) return null;
  const t0 = Math.min(A.onset, B.onset), t1 = Math.max(A.end, B.end);
  const inside = tl.filter((q) => q.onset >= t0 && q.onset < t1);
  if (!inside.length) return null;
  const first = A.onset <= B.onset ? A : B, last = A.end >= B.end ? A : B;
  return { ids: new Set(inside.map((q) => q.id)), first: first.id, last: last.id, t0, t1, n: inside.length };
}

/** Move a range's focus one step in time (dir -1 / +1), as Shift+arrow does in a text editor. */
export function stepFocus(score, focus, dir, tl = timeline(score)) {
  const onsets = [...new Set(tl.map((q) => q.onset))];
  const cur = tl.find((q) => q.id === focus); if (!cur) return focus;
  const k = onsets.indexOf(cur.onset) + dir;
  if (k < 0 || k >= onsets.length) return focus;
  return tl.find((q) => q.onset === onsets[k] && q.si === cur.si)?.id ?? tl.find((q) => q.onset === onsets[k]).id;
}

export const emptyProgram = emptyArrangement;
export { hasMarkers };
const ensure = (score) => (score.program ||= emptyArrangement());

export const addClip = (score, range) => sharedAddClip(ensure(score), range);
export const addJump = (score, from, to) => sharedAddJump(ensure(score), from, to);
export const removeMarker = (score, id) => sharedRemove(score.program, id);
export const markerById = (score, id) => sharedById(score.program, id);
/** Move a clip to index `to` in the playing order. */
export const moveClip = (score, id, to) => sharedMove(score.program, id, to);

/** Drop markers whose notes are gone; returns their names. */
export function pruneProgram(score) {
  const p = score.program; if (!p) return [];
  const ok = (id) => !!findEvent(score, id), gone = [];
  p.clips = p.clips.filter((c) => (ok(c.from) && ok(c.to)) || (gone.push(c.name), false));
  p.jumps = p.jumps.filter((j) => (ok(j.from) && ok(j.to)) || (gone.push('jump'), false));
  return gone;
}

/**
 * The notation-ir playback program for the arrangement. With `range`, just that selection
 * (looping when loop > 1). Clip delays are in beats of the time signature's unit.
 */
export const compile = (score, { range = null, loop = 1 } = {}) => compileArrangement(score.program, { range, loop, beat: score.time?.[1] || 4, idOf: siId });

/** Markers for drawing (notation-ir markers.js format): every clip and jump, in either mode. */
export const markers = (score) => arrangementMarkers(score.program, { idOf: siId });

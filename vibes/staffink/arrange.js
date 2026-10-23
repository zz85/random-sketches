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
import { resolveAttrs, measureCapacity, evTicks, findEvent } from './theory.js';

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

export const emptyProgram = () => ({ mode: 'score', clips: [], jumps: [], next: 1 });
export const hasMarkers = (p) => !!p && (p.clips.length > 0 || p.jumps.length > 0);
const ensure = (score) => (score.program ||= emptyProgram());
const LETTER = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');

export function addClip(score, range) {
  const p = ensure(score), used = new Set(p.clips.map((c) => c.name));
  let k = 0; while (used.has(LETTER(k))) k++;
  const c = { id: `c${p.next++}`, name: LETTER(k), from: range.first, to: range.last, loop: 1, withPrev: false, delay: 0, transpose: 0 };
  p.clips.push(c);
  return c;
}
export function addJump(score, from, to) {
  const p = ensure(score);
  const j = { id: `j${p.next++}`, from, to, times: 1 };
  p.jumps.push(j);
  return j;
}
export function removeMarker(score, id) {
  const p = score.program; if (!p) return false;
  const n = p.clips.length + p.jumps.length;
  p.clips = p.clips.filter((c) => c.id !== id); p.jumps = p.jumps.filter((j) => j.id !== id);
  return p.clips.length + p.jumps.length < n;
}
export const markerById = (score, id) => score.program && (score.program.clips.find((c) => c.id === id) || score.program.jumps.find((j) => j.id === id));

/** Drop markers whose notes are gone; returns their names. */
export function pruneProgram(score) {
  const p = score.program; if (!p) return [];
  const ok = (id) => !!findEvent(score, id), gone = [];
  p.clips = p.clips.filter((c) => (ok(c.from) && ok(c.to)) || (gone.push(c.name), false));
  p.jumps = p.jumps.filter((j) => (ok(j.from) && ok(j.to)) || (gone.push('jump'), false));
  return gone;
}

const clipNode = (c, beat) => {
  const play = { play: { from: { event: siId(c.from) }, to: { event: siId(c.to), edge: 'end' } }, marker: c.id, name: c.name };
  const n = (c.loop || 1) > 1 ? { loop: c.loop, body: play } : play;
  if (c.transpose) n.transpose = c.transpose;
  if (c.delay) n.delay = `${c.delay}/${beat}`;
  return n;
};

/**
 * The notation-ir playback program for the arrangement. With `range`, just that selection
 * (looping when loop > 1). beat = the time signature's unit, for clip delays in beats.
 */
export function compile(score, { range = null, loop = 1 } = {}) {
  const p = score.program || emptyProgram(), beat = score.time?.[1] || 4;
  const jumps = p.jumps.map((j) => ({ at: { event: siId(j.from), edge: 'end' }, to: { event: siId(j.to) }, times: j.times || 1, marker: j.id }));
  if (range) {
    const play = { play: { from: { event: siId(range.first) }, to: { event: siId(range.last), edge: 'end' } } };
    return { root: loop > 1 ? { loop, body: play } : play };
  }
  if (p.mode === 'clips' && p.clips.length) {
    const steps = [];
    for (const c of p.clips) { if (c.withPrev && steps.length) steps[steps.length - 1].push(c); else steps.push([c]); }
    return { root: { seq: steps.map((s) => (s.length > 1 ? { par: s.map((c) => clipNode(c, beat)) } : clipNode(s[0], beat))) } };
  }
  return { root: { walk: {} }, jumps };
}

/** Markers for drawing (notation-ir markers.js format): every clip and jump, in either mode. */
export function markers(score) {
  const p = score.program || emptyProgram();
  return {
    clips: p.clips.map((c) => ({ id: c.id, name: c.name, loop: c.loop, transpose: c.transpose, from: { event: siId(c.from) }, to: { event: siId(c.to), edge: 'end' }, withPrev: c.withPrev })),
    jumps: p.jumps.map((j, k) => ({ id: j.id, name: `J${k + 1}`, at: { event: siId(j.from), edge: 'end' }, to: { event: siId(j.to) }, times: j.times })),
  };
}

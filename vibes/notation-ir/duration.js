// Duration primitives shared by StaffInk, ScoreShift and the timeline IR.
// `dur` is a note value denominator (1 whole, 2 half, 4 quarter ... 64), `dots` augmentation
// dots, a tuplet [n, m] plays n notes in the time of m. Integer ticks: DIV per quarter note.
// The IR itself uses exact rationals (rational.js); ticksToWhole converts.
import { r } from './rational.js';

export const DIV = 96;
export const WHOLE = 4 * DIV;
/** MusicXML <type> names by denominator. */
export const TYPE_NAMES = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd', 64: '64th' };

/** Written length in ticks, ignoring any tuplet. */
export function baseTicks(dur, dots = 0) {
  let t = WHOLE / dur, add = t;
  for (let i = 0; i < dots; i++) { add /= 2; t += add; }
  return t;
}
/** Sounding length in ticks: a tuplet [n, m] scales by m / n. */
export const tupletTicks = (dur, dots, tuplet) => (tuplet ? (baseTicks(dur, dots) * tuplet[1]) / tuplet[0] : baseTicks(dur, dots));
/** Ticks in a bar of beats / unit. */
export const barTicks = (beats, unit) => (beats * WHOLE) / unit;
/** Ticks -> exact fraction of a whole note. */
export const ticksToWhole = (t) => r(t, WHOLE);

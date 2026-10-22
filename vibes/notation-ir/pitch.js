// Pitch primitives shared by StaffInk, ScoreShift and the timeline IR.
// A pitch is (d, alter): d = diatonic index (C0 = 0, C4 = 28, d % 7 is the letter C..B),
// alter in semitones. Staff position p counts half spaces up from the bottom line.
export const NAT = [0, 2, 4, 5, 7, 9, 11];
export const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
export const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
export const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F

export const step = (d) => ((d % 7) + 7) % 7;
export const octave = (d) => Math.floor(d / 7);
export const natMidi = (d) => 12 * (octave(d) + 1) + NAT[step(d)];
export const midiOf = (d, alter = 0) => natMidi(d) + alter;
export const stepName = (d) => ({ step: LETTERS[step(d)], octave: octave(d) });
export const ACC_TEXT = { '-2': 'bb', '-1': 'b', 0: 'n', 1: '#', 2: 'x' };
/** MusicXML <accidental> names by alteration. */
export const ACC_XML = { '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' };
/** Letter + optional accidental text + octave, e.g. nameOf(31, '#') = "F#4". */
export const nameOf = (d, acc = '') => LETTERS[step(d)] + acc + octave(d);

/** Alteration the key signature gives a letter (step 0..6). */
export function keyAlter(fifths, s) {
  if (fifths > 0) return SHARP_ORDER.indexOf(s) < fifths ? 1 : 0;
  if (fifths < 0) return FLAT_ORDER.indexOf(s) < -fifths ? -1 : 0;
  return 0;
}

/** "C4" / "F#4" / "Bb3" -> { d, alter } (alter undefined when no accidental is written). */
export function parseName(s) {
  const m = /^([A-G])(bb|b|#|x|n)?(-?\d)$/.exec(s);
  if (!m) throw new Error(`bad pitch ${s}`);
  const alter = { bb: -2, b: -1, n: 0, '#': 1, x: 2 }[m[2]];
  return { d: +m[3] * 7 + LETTERS.indexOf(m[1]), alter };
}

/**
 * Clefs as { sign, line, d, oct }: the diatonic pitch d sits on staff line `line` (1..5 from
 * the bottom), oct shifts an octave clef. Every app's clef maps onto one of these.
 */
export const CLEFS = {
  treble: { sign: 'G', line: 2, d: 32, oct: 0 },
  treble8vb: { sign: 'G', line: 2, d: 32, oct: -1 },
  bass: { sign: 'F', line: 4, d: 24, oct: 0 },
  alto: { sign: 'C', line: 3, d: 28, oct: 0 },
  tenor: { sign: 'C', line: 4, d: 28, oct: 0 },
};
export const clefRefP = (c) => (c.line - 1) * 2;
/** Staff position -> diatonic pitch, and back. */
export const dOfP = (clef, p) => clef.d + clef.oct * 7 + (p - clefRefP(clef));
export const pOfD = (clef, d) => d - clef.d - clef.oct * 7 + clefRefP(clef);
/** A clef from sign + line (+ octave), e.g. { sign: 'C', line: 4 } -> tenor. */
export function clefOf({ sign, line, octave: oct = 0 }) {
  const id = Object.keys(CLEFS).find((k) => CLEFS[k].sign === sign && CLEFS[k].line === line && CLEFS[k].oct === oct);
  return id ? { id, ...CLEFS[id] } : { id: `${sign}${line}`, sign, line, d: { G: 32, F: 24, C: 28 }[sign], oct };
}

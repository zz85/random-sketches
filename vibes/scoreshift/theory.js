// Pitch spelling, clefs, keys, transposing instruments and measure-scoped accidentals.
// A pitch is { d, alter }: d = diatonic index (C0 = 0, C4 = 28), alter in semitones.
// Staff position p counts half spaces up from the bottom line (bottom line 0, top line 8).

// The primitives (letters, key alterations, clefs, staff position <-> pitch) are shared with
// StaffInk through ../notation-ir/pitch.js; this file adds what is specific to transposing.
import { step, octave, natMidi, keyAlter, SHARP_ORDER, FLAT_ORDER, CLEFS, clefRefP, dOfP, pOfD, nameOf as coreName } from '../notation-ir/pitch.js';

export { step, octave, natMidi, keyAlter, SHARP_ORDER, FLAT_ORDER, CLEFS, clefRefP, dOfP, pOfD };
const BASE_FIFTHS = [0, 2, 4, -1, 1, 3, 5];
export const midiOf = ({ d, alter }) => natMidi(d) + alter;
export const nameOf = ({ d, alter }) => coreName(d, alter > 0 ? '♯'.repeat(alter) : alter < 0 ? '♭'.repeat(-alter) : '');
const MAJOR = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
export const keyName = (f) => (f >= -7 && f <= 7 ? MAJOR[f + 7] + ' major' : `${f} fifths`);


// Key signature glyph positions (p) per clef, in order.
const TREBLE_SHARPS = [8, 5, 9, 6, 3, 7, 4], TREBLE_FLATS = [4, 7, 3, 6, 2, 5, 1];
export function keySigPositions(clef, fifths) {
  const n = Math.abs(fifths); if (!n) return [];
  if (clef.sign === 'C' && clef.line === 4 && fifths > 0) return [2, 6, 3, 7, 4, 8, 5].slice(0, n); // tenor sharps start low
  const shift = clef.sign === 'F' ? -2 : clef.sign === 'G' ? 0 : clef.line === 3 ? -1 : 1;
  return (fifths > 0 ? TREBLE_SHARPS : TREBLE_FLATS).slice(0, n).map((p) => p + shift);
}

// Interval = { dd: diatonic steps, ds: semitones }. Sounding = written + interval.
export const INSTRUMENTS = [
  { id: 'C', name: 'Concert pitch (piano, flute, violin, oboe, voice)', dd: 0, ds: 0, clef: 'treble', range: [55, 96] },
  { id: 'Bb-clarinet', name: 'B♭ clarinet', dd: -1, ds: -2, clef: 'treble', range: [52, 91] },
  { id: 'A-clarinet', name: 'A clarinet', dd: -2, ds: -3, clef: 'treble', range: [52, 91] },
  { id: 'Eb-clarinet', name: 'E♭ clarinet', dd: 2, ds: 3, clef: 'treble', range: [52, 89] },
  { id: 'bass-clarinet', name: 'B♭ bass clarinet (treble)', dd: -8, ds: -14, clef: 'treble', range: [52, 84] },
  { id: 'Bb-trumpet', name: 'B♭ trumpet / cornet', dd: -1, ds: -2, clef: 'treble', range: [54, 84] },
  { id: 'soprano-sax', name: 'B♭ soprano sax', dd: -1, ds: -2, clef: 'treble', range: [58, 89] },
  { id: 'alto-sax', name: 'E♭ alto sax', dd: -5, ds: -9, clef: 'treble', range: [58, 89] },
  { id: 'tenor-sax', name: 'B♭ tenor sax', dd: -8, ds: -14, clef: 'treble', range: [58, 89] },
  { id: 'bari-sax', name: 'E♭ baritone sax', dd: -12, ds: -21, clef: 'treble', range: [58, 89] },
  { id: 'F-horn', name: 'F horn', dd: -4, ds: -7, clef: 'treble', range: [54, 84] },
  { id: 'english-horn', name: 'English horn (F)', dd: -4, ds: -7, clef: 'treble', range: [59, 88] },
  { id: 'alto-flute', name: 'Alto flute (G)', dd: -3, ds: -5, clef: 'treble', range: [60, 91] },
  { id: 'piccolo', name: 'Piccolo', dd: 7, ds: 12, clef: 'treble', range: [62, 96] },
  { id: 'guitar', name: 'Guitar (sounds 8vb)', dd: -7, ds: -12, clef: 'treble', range: [52, 88] },
  { id: 'viola', name: 'Viola (alto clef)', dd: 0, ds: 0, clef: 'alto', range: [48, 84] },
  { id: 'cello', name: 'Cello / bassoon / trombone (bass)', dd: 0, ds: 0, clef: 'bass', range: [36, 72] },
  { id: 'double-bass', name: 'Double bass (sounds 8vb)', dd: -7, ds: -12, clef: 'bass', range: [40, 67] },
];
export const instrument = (id) => INSTRUMENTS.find((i) => i.id === id) || INSTRUMENTS[0];

export function transposePitch({ d, alter }, { dd, ds }) {
  const d2 = d + dd;
  return { d: d2, alter: natMidi(d) + alter + ds - natMidi(d2) };
}
// Fifths count of an interval (C -> the note dd steps / ds semitones above).
export function intervalFifths({ dd, ds }) {
  const p = transposePitch({ d: 28, alter: 0 }, { dd, ds });
  return BASE_FIFTHS[step(p.d)] + 7 * p.alter;
}

// Written interval from a part for `from` to a part for `to`, plus whole octaves.
// Respelled enharmonically when the target key would pass 6 sharps/flats.
export function partInterval(from, to, fifths, octaves = 0) {
  let dd = from.dd - to.dd + 7 * octaves, ds = from.ds - to.ds + 12 * octaves;
  let k = fifths + intervalFifths({ dd, ds });
  if (k > 6) { dd += 1; k -= 12; } else if (k < -6) { dd -= 1; k += 12; }
  return { dd, ds, fifths: k };
}

// Read pitches for one staff. notes: [{ p, x, acc (alter|null), bar (measure index) }] in
// reading order (chords: same x, any order). Returns alter per note (key + measure accidentals).
export function readStaff(notes, clef, fifths) {
  let bar = -1, state = new Map();
  return notes.map((n) => {
    if (n.bar !== bar) { bar = n.bar; state = new Map(); }
    const d = dOfP(clef, n.p);
    let alter;
    if (n.acc != null) { alter = n.acc; state.set(d, alter); }
    else alter = state.has(d) ? state.get(d) : keyAlter(n.fifths ?? fifths, step(d)); // n.fifths: a key change inside the staff
    return { d, alter };
  });
}

// Accidentals to engrave for transposed pitches. Shows one whenever the alteration differs
// from what the key and earlier accidentals in the bar imply, and keeps cautionary ones
// (an explicit accidental in the source that was redundant there stays explicit).
export function spellStaff(pitches, notes, fifths) {
  let bar = -1, state = new Map();
  return pitches.map((pt, i) => {
    const n = notes[i];
    if (n.bar !== bar) { bar = n.bar; state = new Map(); }
    const implied = state.has(pt.d) ? state.get(pt.d) : keyAlter(n.fifths ?? fifths, step(pt.d));
    const show = pt.alter !== implied || n.acc != null;
    state.set(pt.d, pt.alter);
    return show ? pt.alter : null;
  });
}

// Pick the octave shift (-2..2) that keeps the most notes inside a written range.
export function bestOctave(midis, range) {
  let best = 0, bs = -Infinity;
  for (const o of [0, -1, 1, -2, 2]) {
    let s = 0; for (const m of midis) { const v = m + 12 * o; s += v < range[0] ? range[0] - v : v > range[1] ? v - range[1] : 0; }
    s = -s - Math.abs(o) * 0.01;
    if (s > bs + 1e-9) { bs = s; best = o; }
  }
  return best;
}

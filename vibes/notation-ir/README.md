# notation-ir

A timeline intermediate representation for music notation, shared ground for
[StaffInk](../staffink/) (stylus input) and [ScoreShift](../scoreshift/) (photo OMR).
It is built for music that doesn't fit a bar grid: unmeasured passages, bars that are
only half written, printed barlines that disagree with the time signature, and inputs
that are uncertain.

Plain ES modules, `bun test`. Both apps import the shared primitives (`pitch.js`,
`duration.js`, `rational.js`) and the Web Audio `player.js` directly, and load the rest on
first use. Serve `vibes/` as a whole. [PLAN.md](PLAN.md) covers the model decisions, the
adapter contract, known gaps and next steps.

## Three layers

| Layer | File | Holds |
|---|---|---|
| Content | `ir.js` | Events on one timeline (exact rational onset and duration, in voices on staves), links between events (tie, slur, tuplet, beam), directions at a time (clef, key, meter, printed barline, dynamic). Competing readings share an `alt` group. Source geometry is kept in `src`. **No measures.** |
| Interpretation | `interpret.js` | Decisions made on the content: the meter (as printed, overridden, or none), barlines (printed bars win and re-phase the meter, the rest are derived), a pickup, rests or empty space in gaps, how far an accidental carries (`bar` / `note` / a time window), and which reading of each `alt` group. Output: measures with a status that is reported, never repaired (`ok pickup end under over free`), plus written pieces per voice. Pieces are events cut at barlines into tied values that keep the beat visible (a meter tree: half-bar in 4/4, dotted beats in 6/8, additive groups; standard syncopations accepted; rests on exact beats), with tuplets inferred from the duration (1/12 is a triplet eighth, 1/20 a quintuplet sixteenth) and every head spelled. |
| Layout | `layout.js` | Horizontal positions. Three modes: `engraved` (duration spacing), `proportional` (x = time) and `anchored` (stay near the ink or the printed note). All three are one least-squares fit with minimum gaps, solved exactly. |

| Anchors | `anchors.js` | References that survive edits. An anchor can name a moment, a note (`{ event }`), a printed barline (`{ barline }`), the n-th bar of the interpretation (`{ bar }`), a point on the page (`{ pos: { x, line } }`, read through the notes' source positions) or a fragment end. It resolves when used, so it follows the music. `positionAt` maps score time back to a page position for drawing markers and playheads. |
| Playback | `playback.js` | Authored, non-linear playback. Clips are spans between anchors or a lasso of events. A program is built from `play`, `walk` (reads on and takes jump markers anchored on the page: repeats, D.S., arrows out to a sketched fragment and back), `seq`, `par` (each branch is its own cursor, e.g. canons or phasing loops), `loop`, seeded `choose` and `rest`. Per-node options set tempo, delay, transpose, gap handling (keep / compress / cap), a confidence floor, and cycling alternative readings per loop pass. Output is notes in seconds plus a trace for playheads. |

`arrangement.js` holds the playback markers a user places (clips with repeat, octave, delay
and "with previous"; jumps; a mode that is either the score taking its jumps or the clips in
order). It compiles them to a program and selects ranges over the IR like text. StaffInk and
ScoreShift both build on it. `clicksFor(score, perf)` gives metronome clicks for any program.

`markers.js` draws playback markers on either app's page: clips as brackets (split at line
breaks, stacked when they overlap), loop counts, jumps as arrows, and lost markers red and
dashed. It covers layout, hit testing and drawing. Each app supplies its lines and a
`place(anchor)` function.

Events and directions belong to **fragments** (default `main`), each with its own local time, so an idea sketched off to the side doesn't need a place in the main timeline.

`adapters/scoreshift.js` converts a recognised page (as written or transposed). Printed bars
become barline directions, and every event keeps its position on the photo, so anchors and
playheads work on the page. `ScoreShift`'s **Edit in StaffInk** button runs
`fromScoreShift` → `toStaffInk` and opens the music in StaffInk to edit with the pen. Anything
StaffInk can't hold (a second voice, 5-tuplets, tenor clef) is reported. `__ss.playProgram(program)`
plays programs over the page.

`adapters/staffink.js` converts a StaffInk score. Underfull bars become gaps, the meter
becomes a direction, IR ids are `si<StaffInk id>` and each note keeps StaffInk's velocity.
In StaffInk, `StaffInk.playProgram(program)` plays a program through the app's own player
and lights up every note any cursor is sounding:

```js
StaffInk.playProgram({ root: { par: [
  { play: { from: { event: 'si12' } } },                         // from this note on...
  { loop: 4, body: { play: { events: ['si3', 'si4'] }, gaps: 'compress' } }, // ...over a riff
] } });
```

```js
import { createScore, addEvent } from './ir.js';
import { interpret, toText } from './interpret.js';
const s = createScore();
addEvent(s, { onset: 0, dur: '1/4', heads: [{ d: 28 }] });     // C4
addEvent(s, { onset: '1/4', dur: '1/2', heads: [{ d: 29 }] }); // D4
toText(interpret(s, { meter: 'none' }), 'v1');                 // "C4q D4h"
toText(interpret(s, { meter: [{ beats: 2, unit: 4 }] }), 'v1'); // "| C4q D4q~ | D4q |"
```

## Not yet

- Beaming, vertical layout, line breaking, and drawing.
- MusicXML / MIDI writers from interpreted output.
- Live triggering. A ScoreShift hook (its `Player` has the same shape).

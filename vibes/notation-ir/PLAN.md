# notation-ir: IR and adapters plan

The current state, the decisions behind it, and the next steps in the order they should
happen. Each step lists what has to be true before it counts as done.

## 1. Where things stand

```
          StaffInk (pen)                          ScoreShift (photo OMR)
  theory.js ─┐  audio.js ─┐                 theory.js ─┐  score.js ─┐  player.js ─┐
             ▼            ▼                            ▼            ▼             ▼
       pitch.js     duration.js     player.js      (shared primitives, loaded eagerly)
                                        ▲
   adapters/staffink.js ◄── ir.js ──► adapters/scoreshift.js   (loaded on first use)
     fromStaffInk / toStaffInk      fromScoreShift
                   interpret.js  anchors.js  playback.js  layout.js
```

- **Shared primitives** (`pitch.js`, `duration.js`, `player.js`, `rational.js`) are imported by
  both apps directly. Both service workers precache them, so both apps now need `../notation-ir/`
  deployed next to them.
- **IR modules** load lazily, the first time a program plays or a page is handed off. They are
  cached on a best-effort basis, so a deployment without them still works for normal use.
- **Parity checks** in the tests:
  - The IR's `perform()` gives the same times, lengths and velocities as StaffInk's own
    `performance()`, including slurs, staccato, staccatissimo, tenuto, marcato, accents,
    fermatas, ties and hairpins.
  - On every Verovio fixture, the IR gives the same pitches at the same onsets as ScoreShift's
    `performance()`.
  - Fixture to StaffInk to StaffInk playback keeps the pitches on every fixture except
    `twovoice`, where the second voice is dropped and reported.

## 2. Model decisions (settled)

| Decision | Why |
|---|---|
| Time is exact rationals of a whole note | Tuplets of any ratio, no tick rounding. Apps keep their integer ticks and convert at the edge. |
| Content has no measures | Unfinished, unmeasured and misread music is a state the IR can hold, not an error. |
| Bars, ties across bars, rests and spelling are interpretation | The same content can be read in another meter, in free time, or with printed bars winning. |
| Problems are reported, never repaired (`check`, measure `status`, `report`) | ScoreShift's repair stays in ScoreShift. The IR keeps both what was read and how it fits. |
| A head holds pitch (`d`, optional `alter`), not a staff position | A clef change never moves a note. Ink and OMR leave `alter` empty and the IR resolves it. |
| `src` keeps input geometry; anchors resolve when used | Markers follow edits, and layout and playheads map back to the ink or the photo. |
| Fragments have their own local time | Sketched ideas need no place on the main timeline. |
| One set of articulation rules lives in `perform()` (StaffInk's) | Both apps sound the same through the IR. ScoreShift's own Play button keeps its slightly different rules. |

## 3. Adapters: the contract

Every adapter is `from<App>(…) → IR` plus, where useful, `to<App>(IR) → { score, report }`.

- **IDs.** IR event ids must map back to the app's own ids so highlighting and anchors work.
  - StaffInk: ids are `si<StaffInk id>`.
  - ScoreShift: the adapter returns `byId` (IR id → timeline entry), because ScoreShift events
    have no stable id.
- **Pitch.** Ink sets `acc` only. OMR and imports set `alter`. A transposing part sets
  `part.transpose` (written to concert pitch, in semitones).
- **Expression.** `vel` holds the dynamic level only. `marks` uses the IR vocabulary:
  `staccato staccatissimo tenuto accent marcato fermata up-bow down-bow`. Slurs, ties and
  hairpins are links. A dynamic is a `dynamic` direction carrying `event`.
- **Geometry.** `src: { x, y, line }` on events. Printed barlines become `barline` directions
  with `src`.
- **Reporting.** Anything the target cannot hold goes in `report`, never silently:
  - StaffInk: `dropped`, `approximated`, `clefs`, `padded`, `meter`.
  - ScoreShift: `skipped` grace notes.

### Known gaps per adapter

**fromScoreShift**
- Grace notes are skipped. They need a zero-length "grace" kind, see step 6.
- Barlines come from the first part only.
- In-staff key changes under a transposing plan use the staff's planned key.
- Multi-page PDFs convert only the current page.

**toStaffInk**
- Only the first voice per staff is written.
- Only 3:2 and 6:4 tuplets survive.
- There is no anacrusis: a pickup is padded with rests.
- Durations are split greedily, not by beat (step 4).
- Tenor and octave clefs are written as the nearest StaffInk clef.

**fromStaffInk**
- Complete. A second StaffInk voice would need a voice concept in StaffInk first.

## 4. Next steps, in order

1. **Beat-aware notation in `interpret`.** Split values at beat boundaries (syncopation, the
   half-bar rule in 4/4, dotted values in 6/8). This is the biggest visible gap when OMR or
   free-time music reaches StaffInk.
   - *Done when* `| C4q D4h E4q |` in 4/4 is written as `D4q~D4q`, and every fixture
     round-trips with the same beaming StaffInk would draw.
2. **Ids that survive a rebuild for ScoreShift events** (e.g. hashed from staff index + x +
   first note), so programs and anchors saved with a project still resolve after a correction.
   - *Done when* a program saved in a `.scoreshift` project replays after a note is edited.
3. **Program UI in both apps.**
   - Put loop, jump and clip markers on the page as anchors (`{ event }` and `{ pos }` in
     StaffInk; `{ barline }` and `{ pos }` in ScoreShift), drawn through `positionAt`, with
     several playheads.
   - Store the program with the score or project.
   - *Done when* a repeat and a canon can be authored without the console.
4. **Return trip StaffInk → ScoreShift.** Rewrite the page from corrected pitches by matching
   IR events back through `src` and changing `note.fix`.
   - *Done when* a pitch edited in StaffInk shows up moved on the photo.
5. **Shared writers.** `musicxml.js` and `midi.js` built from interpreted output, so free-time
   and reinterpreted music exports.
   - This replaces the two near-identical writers once the parity tests match their output
     (accepting documented differences).
6. **Content gaps:** grace notes (a kind with zero duration that steals or precedes), a second
   StaffInk voice, `tempo` directions honoured by `perform`, and al Fine / conditional jumps in
   `walk`.
7. **Live triggering** (out of scope for now): a cursor scheduler that takes new clips while it
   plays, quantised to the beat of a running cursor.

## 5. Deployment notes

- Serve the `vibes/` folder as a whole. Each app imports `../notation-ir/`, and ScoreShift's
  hand-off opens `../staffink/`.
- Opening StaffInk from ScoreShift offline works only if StaffInk has been opened online at
  least once, because each app's service worker controls only its own pages.
- The smoke tests serve `vibes/` and open each app at its real path, as deployed.

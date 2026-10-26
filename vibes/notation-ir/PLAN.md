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
  They must stay the same across rebuilds, so saved programs keep their anchors.
  - StaffInk: ids are `si<StaffInk id>`.
  - ScoreShift: ids are keyed to the page (staff line, x in quarter spaces, voice), and the
    adapter also returns `byId` (IR id → timeline entry).
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
- Tenor and octave clefs are written as the nearest StaffInk clef.

**fromStaffInk**
- Complete. A second StaffInk voice would need a voice concept in StaffInk first.

## 4. Next steps, in order

1. ~~**Beat-aware notation in `interpret`.**~~ Done. A meter tree (bar, then beat groups,
   then beats, then subdivisions; simple, compound and additive meters) decides how each span
   is written. Syncopations and dotted values are accepted where the dot reaches the middle of
   the next unit. Rests take exact beats only. Gaps merge into the rests next to them.
   - With the printed values ignored (`written: false`), the rules reproduce the engraved
     rhythm of 14 of the 15 fixtures. The exception is `sixeight`, where the Verovio
     engraving lets a quarter cross the second beat.
2. ~~**Ids that survive a rebuild for ScoreShift events.**~~ Done.
   - Events are `ss:L<line>:q<x in quarter spaces>:<voice>` and barlines `ssb:L<line>:q<x>`.
   - `findById` matches a moved head within half a staff space, preferring the same voice. A
     deleted note returns null and is never replaced by its neighbour.
   - `checkProgram` lists every anchor that no longer resolves, and `perform` throws
     `AnchorError` for one.
   - ScoreShift saves the page's program in the `.scoreshift` project (`programs`), and
     `playProgram()` with no argument replays it, reporting any markers that lost their note.
3. **Program UI.** Partly done.
   - Done: StaffInk range selection like text, a playable selection (with loop), clip markers
     (repeat, octave, delay, layer with the previous clip), jumps, and a Play mode switch
     (score + jumps, or clips in order). Programs are stored in `score.program`
     (`staffink/arrange.js`).
   - Done: shared marker drawing (`markers.js`). ScoreShift draws the page's saved program on
     the photo, with lost markers red and dashed.
   - Done: authoring in ScoreShift (✂ Markers). Tap a bar to select it, Shift+tap or Extend to
     grow the selection, or drag across notes with a mouse. Then play or loop the passage
     (speed and metronome apply), keep it as a clip, or add a jump. Lost markers can be
     re-attached to the nearest note or to a tapped note. The arrangement logic is shared
     (`arrangement.js`), and programs autosave per page as well as going into the project.
   - Done: playhead lines in both apps (`playheads.js`), one per cursor, coloured like their
     clip, for normal Play as well as programs.
   - Done: reordering clips. Both apps show the clips in playing order as chips: drag one
     sideways, or use earlier / later on the selected clip (Alt+←/→ in StaffInk). A clip keeps
     its colour (taken from its letter) when it moves.
   - Done: finger selection in ScoreShift. Hold still for a moment, then drag; a quick swipe
     still scrolls the page.
3b. **Surfaces.** Done: `surface.js` defines the interface, and both apps' page geometry
   moved behind it (`staffink/surface.js`, `scoreshift/surface.js`) with no change in
   behaviour (all smoke checks unchanged). Next on it:
   - two surfaces of one IR side by side (the photo and an engraved view), with selection,
     markers and the playhead in sync;
   - pen annotations anchored to events, shown on every surface. Done: the model
     (`annotations.js`) and ScoreShift's ✎ Annotate mode (pen and mouse, finger until a pen is
     seen; colours, widths, eraser and pen eraser end, undo/redo, tap a mark to recolour,
     delete or re-attach it; saved per page and in the project, included in the PNG export).
     Exports ask whether to draw them and which colours (PNG and the transposed PDF, whose
     pages are drawn in the export workers). Next: carrying the marks into StaffInk with
     "Edit in StaffInk" (needs an id mapping);
   - live geometry only: ScoreShift's `src` stays as the photo surface's identity, and
     engraved positions are never copied into the IR.
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

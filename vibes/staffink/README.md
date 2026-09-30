# StaffInk

Handwritten music notation in the browser. Write on the staff with a stylus, finger or
mouse; pause, and the ink turns into engraved notation you can play back and export.
No backend and no build step: plain ES modules, a 172 KB recognizer model, and vendored
SMuFL fonts. Nothing leaves the page.

```
python3 -m http.server      # any static server (model.json is fetched, so file:// will not work)
bun test                    # recognizer, parser, theory, layout, export: 37 tests
node smoke.js               # headless Chromium over CDP, real pen + touch pointer events: 18 checks
bun train.js --eval         # retrain, writer-independent score (downloads HOMUS to /tmp/homus)
bun train.js                # retrain on all 100 writers, writes model.json (~5 min)
```

## What you can write

| Ink | Becomes |
|---|---|
| scribbled or open head + stem, flags | quarter/half/eighth/16th/32nd/64th, pitch from where the head sits |
| an open oval | whole note |
| a head on an existing stem | chord |
| a line across two or more stem tips | beam (eighths; a second line makes 16ths) |
| ♯ ♭ ♮ 𝄪 left of a head, before or after the note | accidental, carried through the bar |
| dot right of a head / above or below | augmentation dot (twice = double) / staccato |
| quarter, eighth… rests; a block hanging from line 4 / sitting on line 3 | rests; whole (bar) rest / half rest |
| arc from head to head | tie (same pitch) or slur |
| G/F/C clef, 2/4 3/4 4/4 6/8 … C ¢ at the start of a bar | clef / time signature change |
| scribble over symbols | erase (over unrecognised ink: cancel it). The stylus eraser end also erases |
| ledger lines, barlines | ignored, the engraver draws them |

After every symbol the top alternatives appear in a strip at the bottom. Tapping one fixes
the symbol and stores the ink as a personal template, so the recognizer adapts to your
hand. Tap a notehead to hear it and get an edit bar (duration, dot, accidentals, tie,
staccato, note↔rest, delete); drag it or use ↑/↓ to change pitch. Bars grow as you write
and always leave room for the missing beats, underfull bars are tinted amber and overfull
ones red. One blank bar is always kept at the end. Treble, bass, alto or piano grand staff;
any key; Bravura or the handwritten-style Petaluma. Export MusicXML 4.0, MIDI, PNG or the
native JSON; autosaves to localStorage.

Input handling follows what the platform offers: Pointer Events with `getCoalescedEvents()`
for full-rate stylus samples, `getPredictedEvents()` to draw ahead of the pen, pressure
for stroke width, a `desynchronized` canvas for the ink layer, and palm rejection by
pointer type (once a stylus is seen, fingers scroll, pinch-zoom and select instead of
writing; configurable).

## Research notes

### Is StaffPad the industry leader? Mostly, in its niche

- **StaffPad** (David William Hearn, Matthew Tesch) shipped for Windows 8 / Surface in March
  2015 and for iPad on 5 Feb 2020, won an Apple Design Award in 2020, and has been part of
  Muse Group (MuseScore, Audacity) since May 2021. It has since added Piano Capture
  (on-device ML transcription of a real piano through the microphone), MIDI input and
  Muse Sounds playback. Reviews and buyer's guides consistently rank it first for
  handwriting-to-notation. So for **handwritten notation input specifically, yes**.
- It was **not first**. **NotateMe** by Neuratron (the PhotoScore OMR people) shipped in 2013
  on iOS and Android, recognises a broad symbol set (cross-staff beams, multiple voices,
  tuplets, hairpins, lyrics) and is the main direct competitor, and the only serious
  option on Android. Research systems came much earlier: Presto (1996) and the Music
  Notepad (1998), below.
- It is **not the notation market leader** overall. That is Sibelius, Dorico and MuseScore
  Studio (free, the largest user base), all keyboard/mouse/MIDI-first. Finale, long
  the third pillar, was discontinued by MakeMusic on 26 Aug 2024, with users steered to
  Dorico.

### Literature and what was taken from it

| Work | Idea | Used here |
|---|---|---|
| Anstice, Bell, Cockburn, Setchell, *The Design of a Pen-Based Musical Input System*, OZCHI 1996 (Presto) and follow-ups (OZCHI 1998, Canterbury thesis) | Shorthand gestures designed by watching musicians write; about 3x faster than other entry methods. Ledger lines and bars are the computer's job | Engraver draws ledgers and barlines; strokes that look like them are dropped |
| Forsberg, Dieterich, Zeleznik, *The Music Notepad*, UIST 1998 | Gesture notation plus a probabilistic interpreter over gesture sequences; context decides meaning | Gestures interpreted against what is already on the page (beam across stems, tie between heads, scribble-erase), tentatively committing pending ink first |
| Miyao & Maruyama, ICPR 2004 / IJDAR 2007; Mitobe et al., fast HMM, IWFHR 2004 | Music symbols are combinations of a few stroke primitives: classify strokes, then combine | Structural note parser: find the stem, heads at one end, fill density for black/white, several heads = chord |
| Calvo-Zaragoza & Oncina, *Recognition of Pen-Based Music Notation: the HOMUS dataset*, ICPR 2014; stroke clustering (k-medoids) and finite-state-machine papers from the same group | 15 200 symbols, 32 classes, 100 musicians on a 14 px staff; online vs offline features; stroke vocabularies should be re-learned from user data | Training data for the classifier; user corrections stored as templates |
| Vatavu, Anthony, Wobbrock, $P (ICMI 2012), $Q (MobileHCI 2018) | Order- and direction-invariant point-cloud matching; $Q's early abandoning makes it fast on phones | Matching of personal correction templates (with early abandoning) |
| Kato, Suzuki, Omachi, Aso, directional element features, IEEE TPAMI 1999 (handwritten CJK characters) | Ink length binned by orientation over a zone grid | Main classifier features |
| Rebelo et al., *Optical music recognition: state-of-the-art and open issues*, IJMIR 2012 | Staff space is the natural unit; size relative to it is the strongest cue | All geometry in staff spaces; size features |
| Gourlay, *Spacing a Line of Music*, 1987; Ross, *The Art of Music Engraving*; Gould, *Behind Bars* | Logarithmic duration spacing; beaming by beat; stem direction by the note furthest from the middle line | `layout.js` |
| SMuFL (W3C Music Notation CG), Bravura / Petaluma (Steinberg, OFL) | Standard glyph codepoints, anchors (stem attachment), engraving defaults | Glyphs, stem anchors, line thicknesses |

### Recognizer choice, measured

Writer-independent on HOMUS (train writers 1–80, test 81–100):

| Classifier | top-1 | top-3 | per symbol |
|---|---|---|---|
| $P nearest neighbour, 20 templates/class (500-sample subset) | 64 % | 88 % | 19 ms |
| $P + staff-relative size term | worse at every weight tried | | |
| **MLP 171→128→64→32 over directional features + size, augmented** (all 3040 test samples) | **94.4 %** | **99.3 %** | < 1 ms |

$P alone confuses flag counts and similar outlines, and adding size per template adds
noise faster than signal. The MLP learns size jointly with shape. Its remaining errors are
mostly 32nd vs 64th notes and rests. With top-3 at 99 %, the alternatives strip nearly
always contains the right answer. HOMUS has no chords, beams or ties, which is why those are
handled structurally and as gestures rather than by the classifier. HOMUS is used for
research without a stated licence; the repo ships only the derived weights (`model.json`),
not the data.

## Files

| File | Role |
|---|---|
| `recognizer.js` | features, MLP inference, $P user templates, stroke geometry |
| `parser.js` | ink → score edits: gestures, dots, context prior, structural note parse, accidental attachment |
| `theory.js` | score model, durations, clefs/keys, pitch spelling with accidental carry and ties |
| `layout.js` | spacing, line breaking, stems, beams, chords with seconds, accidentals stacking, ties/slurs, hit location |
| `render.js` | canvas drawing with SMuFL glyphs |
| `export.js` | playback timeline (ties merged), MusicXML 4.0, Standard MIDI File |
| `audio.js` | Web Audio voice + scheduler |
| `app.js`, `index.html` | pointer input, ink grouping and timing, alternatives/learning, editing, settings |
| `train.js` | zero-dependency MLP training on HOMUS |
| `testink.js` | synthetic handwriting for tests and the smoke run |

## Not yet

One voice per staff; no tuplets, grace notes, dynamics, hairpins, lyrics or text; no
key-signature handwriting (use settings); no offline/PWA shell yet; recognition sees one
symbol at a time, so writing two symbols without lifting a moment between them can merge
them (a far-away stroke starts a new symbol, otherwise the pause does).

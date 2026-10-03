# ScoreShift

Take a photo of a page of music and get the same page back written for another instrument:
a B♭ clarinet, E♭ alto sax, F horn, viola, anything transposing. The photo is the layout.
ScoreShift does not re-engrave the music. It reads the page, then edits the page itself:

- every pitched symbol (notehead, stem, flag, beam group, augmentation dots) is cut out of the
  photo and pasted back shifted to its new line or space, in the page's own ink and typeface
- the key signature is replaced, and the line is squeezed a little when the new key needs
  more room (one squeeze per system, so the barlines of a score stay aligned)
- accidentals are re-spelled bar by bar for the new key; new ones are copied from glyphs found
  on the same page where possible, otherwise drawn from a SMuFL font
- ledger lines are regenerated; erased paper is refilled from a local paper-colour map and
  the staff lines under every cut are copied in from the nearest intact columns
- slurs, dynamics, lyrics, rests, articulations, text and spacing stay where the engraver put them

That is why it never has to understand rhythm, voices or layout. Transposition is a vertical
shift of the pitched symbols, and the page already has the layout.

PDFs work too, such as scores and parts from IMSLP: pick a page from the thumbnail strip, or
export the whole file transposed as a new PDF.

It also reads the rhythm: note values from beams and flags, dots, rests, time signatures,
triplets and ties, assembled into measures that are checked against the time signature. So the
page can be **played** (with the sounding notes lit up on the page) and exported as
**MusicXML** or **MIDI**, as written or transposed.

Runs entirely on the device: plain ES modules, a Web Worker for recognition, no build step,
no dependencies, nothing uploaded. Installable PWA that works offline.

```
python3 -m http.server              # any static server, then open /vibes/scoreshift/
bun test                            # theory, recognition + rhythm accuracy, bar repair, export, real scans: 30 tests
node smoke.js                       # headless Chromium over CDP: UI, corrections, PDF, playback, exports, offline: 32 checks
bun eval.js [tune|all] [condition]  # accuracy table (pitch and rhythm); condition = clean | scan | photo | phone
bun debug.js <tune> [cond] [x0 y0 x1 y1]   # colour overlay of what was recognised
node tools/make_fixtures.mjs        # rebuild fixtures + glyphs.js from Verovio (dev-only dependency)
node tools/make_sample.mjs          # rebuild sample.jpg
node tools/make_pdf_fixture.mjs     # rebuild fixtures/parts.pdf (title page + 2 music pages)
node tools/compare.mjs truth fixtures/<tune>.json a.musicxml [b.mxl ...]   # score MusicXML (ours, Audiveris) against ground truth
node tools/compare.mjs pair a.musicxml b.mxl                               # or two outputs against each other
bun tools/oemer_heads.mjs <dir>     # score oemer notehead masks (json + mask png per fixture image) against the truth
node tools/make_glyphset.mjs 120 /tmp/glyphset && bun tools/glyphnet.mjs /tmp/glyphset 25 && node tools/glyphnet_export.mjs   # retrain the classifier
```

## Using it

**Photo** (camera) or **Open**, or drop / paste an image or a PDF. Pick what the music is
**written for** (concert pitch by default; a B♭ trumpet part works too) and what to
**transpose for**. **Octave** is chosen automatically per staff to keep the most notes inside the
target instrument's written range, or set it with −/+. **Clef** follows the target instrument
(a cello line read by a clarinet goes to treble), or keep the page's clefs.

Three views: **Original** (deskewed photo), **Interpreted** (staff lines, clefs, barlines and
every recognised notehead labelled with its pitch, colour-coded by letter name),
**Transposed**. In Interpreted view, tap a staff label to correct its clef or key (for one or
all staves); tap a note to move it a step, change its accidental, or mark it as not a note.
Corrections feed the transposed page immediately. **⬇ PNG** exports the current view.

**Rhythm.** Interpreted view also shows each note's and rest's value (`8`, `4.`, `16³`, `r4`,
`⁀` for a tie) and checks every bar against the time signature. Bars that do not add up are
shaded red with how many beats they hold; bars that were made to add up automatically are shaded
amber with what was changed (`dot added`, `one beam fewer`, `triplet`, `rest value`, `tuplet number
ignored`). Tap a note or a rest to set its value, dot, triplet, tie or grace note (or mark a rest
as not a rest); tap inside a bar to see its count, set the time signature from that bar on, or
play from there. Corrections are kept and win over the automatic repair.

**▶ Play** plays the page at the **Tempo** set (quarter notes per minute), at concert pitch,
highlighting the sounding notes on whichever view is showing. **⬇ MusicXML** and **⬇ MIDI**
export the music of the current page: in Transposed view the transposed part (key, clef and
pitches for the target instrument, with a `<transpose>` element so notation apps play it at
concert pitch), otherwise the music as written. MusicXML opens in MuseScore, Dorico, Sibelius,
Finale and Verovio.

**PDFs** (IMSLP, Internet Archive, anything): rendered with pdf.js, including the JBIG2 and
JPEG 2000 images scanned PDFs are made of. Opening probes each page at low resolution for staves
and starts at the first page mostly covered by music, skipping the cover, title page and preface.
Scanned PDFs spend ~0.7 s a page decoding JBIG2 / JPEG 2000 whatever the output size, so pages
render on a pool of up to four pdf.js documents (each with its own pdf.js worker) and probe a
batch at a time; each reader keeps its last page decoded, so the probe's page is re-rendered at
full size in ~40 ms, and the probe renders become the thumbnails. A thumbnail strip and ◀ ▶ move between pages; corrections are remembered per
page. **⬇ Transposed PDF** transposes every page and writes a new PDF of the same page size
(pages with no music are kept as they are). On a 30-page Internet Archive scan of a Haydn
quartet (31 JBIG2 + 60 JPEG 2000 images) it opens at the first page of music (page 11) in
~6 s and exports the whole file in ~22 s. The export runs on a pool of up to four workers: the main
thread only paints PDF pages, each worker probes its page for staves (text pages are kept
without the seconds a full analysis of a page of words costs), recognises, rewrites and
JPEG-encodes it with OffscreenCanvas. Pages corrected by hand use the corrected reading.

Works best with printed music, the page flat, the whole staff width in frame and even light.
Phone photos down to about 13 px per staff space work (see below); more is better.

## How the recognition works

A classical staff-first OMR pipeline (Fujinaga, Rebelo et al., Audiveris), restricted to what
transposition needs. All of it is in `omr.js` / `imgproc.js`, about 900 lines.

1. **Normalise** (`normalize`): Sauvola binarisation of a 3×3-smoothed copy, then Fujinaga's
   run-length trick: the most common vertical black run is the staff-line thickness, the most
   common black+white pair is the line-to-line distance. The photo is resampled so a staff space
   is 16 px, deskewed by the sharpest sheared row histogram, and binarised again with
   Wolf–Jolion, which normalises by the image's own contrast so faint photographed lines survive.
   Light smoothing is only applied when a MAD estimate of sensor noise says it is needed.
2. **Staves** (`findStaves`): row projections in vertical slices 4 spaces wide; every run of
   five evenly spaced line candidates is scored by completeness and the best non-overlapping
   runs kept, so stacks of ledger lines next to a staff do not win. Slices are linked into
   staves, each line kept as a piecewise-linear `y(x)` (handles residual curl and keystone),
   and the ends walked outwards through binarisation gaps. When a staff is found twice (a few
   slices took a beam or hairpin above it as the top line), the one most slices support wins. A five-line "staff" that sits on a
   real staff's ledger positions and is shorter is dropped.
3. **Staff removal**: vertical runs no thicker than the line are cleared along each line.
4. **Clefs**: the first tall component of each staff. In scans clefs often touch the system
   bracket or the opening barline and become part of a component spanning the whole system, so
   long vertical runs of components too big to be a clef are cut in the clef zone first. G clef by extent (above and below the
   staff), C clef by a solid bar as tall as the staff (alto vs tenor by where it is centred),
   F clef as a curl that stops short of the bottom line; C clef pieces and F clef dots are gathered.
5. **Filled heads**: a morphological opening with a square of 0.55 spaces removes stems, lines,
   flags, slurs and most beams; the surviving blobs are scored at every staff position (heads
   lie on lines or spaces), with half-columns for chords with seconds. Each must be about a space
   tall (beam slabs are half that) and carry a thin stem of at least 2 spaces, found on the right
   going up or the left going down, bridging small gaps in photographed stems.
6. **Hollow heads**: enclosed holes on the binary *with* staff lines, halves split by a staff or
   ledger line re-joined, then a ring test (wall thickness, outer size, oval rather than
   rectangular hole). Rejected: flat bowls (stem rising on the left), holes in sharps, naturals
   and double sharps, time-signature digits (two spaces tall, hanging from a line), loops of
   curly flags (threaded on a black note's stem), and any head beyond the staff without a
   ledger line under it (letters in tempo marks, lyrics and dynamics).
7. **Accidentals** from stroke structure: long vertical strokes (bridging gaps from photo
   breaks and removed staff lines), how many, how they overlap, and whether the ink to their
   right is bottom-heavy (a flat's bowl). Fragments cut apart by staff removal (a flat's bowl at
   its joint, the two halves of a sharp lying on lines) are re-paired. Key signatures are the
   evenly spaced run of same-type accidentals after the clef, kept only as far as they sit where
   a key signature puts them for that clef. Scans misread them (heavy staff lines erase a
   sharp's crossbars, splitting it into halves; a sharp's crossings survive the head opening and
   look like a notehead; a glyph is lost or one from the music is picked up), so halves are
   re-paired, accidental-shaped "heads" are rejected, C clefs gather their curls so the key is
   found right after them, and a staff takes the key most staves of its system (else of the page)
   read: when it read none but has ink where a key would be, or the same kind of accidental in
   another number. A sharp/flat contradiction is never overruled (orchestral scores mix keys;
   horns often have none). Inferred keys are marked. Local accidentals attach to the nearest head to
   their right at the same position and carry through the bar.
8. **Barlines** are thin components spanning a staff (or a whole system, counted for every staff
   they cross); staves joined by the same barlines form a system.
9. **Pitch**: staff position + clef + key + bar-scoped accidentals (`theory.js`).

Transposition (`theory.js`) works on (diatonic step, alteration) pairs, so spelling is exact:
the interval between the two instruments is applied as diatonic steps + semitones, the key
moves round the circle of fifths and is respelled enharmonically past six sharps or flats
(D♭ major for B♭ clarinet is E♭, B major becomes D♭ rather than C♯). Accidentals are shown
whenever the new alteration differs from what the new key and the bar imply, and cautionary
accidentals in the source stay cautionary.

### Reading the rhythm

`rhythm.js` runs in the worker after the pitch pass, on the staff-removed page; `score.js` builds
the music from it on the main thread (a few ms, so it is rebuilt after every correction).

1. **Stems.** Each chord's stem end is scanned in columns 0.6, 1.1 and 1.6 spaces either side. Ink
   in all three is a beam; the beams stacked from the stem end are counted from the run lengths
   (a beam is half a space thick, a quarter space apart), stopping at a gap so a slur over the beam
   does not count. With no beam, flags are counted as crossings of a column just right of the stem,
   near its end. Value: hollow head with stem = half, without = whole, else 4 × 2^(beams+flags).
   Augmentation dots are the dots right of a head; dot-sized pieces with neighbours across a staff
   line are a tie or slur cut up by staff removal, not dots. Heads clearly smaller than the staff's
   typical head on short stems are grace notes.
2. **Templates.** Rests, time-signature digits, C / cut C and tuplet numbers are matched against
   the SMuFL glyphs of the five fonts, rasterized at the normalized staff space by a 90-line path
   rasterizer (`raster.js`, no canvas, so it runs in workers and under bun): a 10 × 10 coverage grid
   of the ink box plus aspect and size. Pieces of one symbol split by staff-line removal are joined
   first. Whole and half rests are solid slabs told apart by the line they hang from or sit on.
3. **Time signatures** are read as a region right after the key signature or a barline, not as
   components: the two digits touch the middle line and fuse through it. The region is split at
   the middle line, each half into one or two digits, and the reading is chosen among close
   alternatives with a prior on meters that occur (a scanned 2/4 should not read 7/4). A second
   pass at the start of a staff may take components the pitch pass called noteheads (a 4's
   triangle is a filled head) and drops those notes. A cut C's stroke reads as a barline and is
   taken back. Measures before any time signature use the first one; with none at all, the meter
   the bars agree on.
4. **Ties** are arcs from just right of a head to just left of the next head at the same position,
   or off the end of the staff (tied over the system break).
5. **Measures.** Each staff is split at its barlines (including barlines touched by a slur, found
   as thin full-height columns inside a bigger component, and excluding stems cut off their hollow
   head); heads on one stem, or at one x, are one chord. Parts: one per staff row of the system, so
   a single part page is one part and a quartet score is four. A tuplet number applies to the n
   events under it whose written values make n equal units.
6. **Bar check and repair.** A bar must add up to its time signature, except a pickup (first bar,
   or after a double bar) and the bar closing a section. A bar that does not is repaired with the
   cheapest edit, or pair of edits, that makes it exactly full: a dot added or removed (1.0), a rest
   value (1.2), an unmarked beamed triplet (1.3), a beam more or fewer (1.6), a flag (2.0), half ↔
   quarter (2.2), a rest that is not one (2.5), and reading the bar without its tuplet numbers
   (0.8). Ambiguous or expensive repairs are not made; the bar is shown red instead.
7. **Export and playback** (`export.js`, `player.js`): MusicXML 4.0 partwise at 480 divisions per
   quarter (3-, 5- and 6-tuplets are whole numbers) with keys, clefs, time signatures, pickup as
   measure 0, dots, tuplets, ties, accidentals as engraved, double and final barlines and system
   breaks; MIDI format 0, one channel per part; Web Audio playback with ties merged into one
   sounding note.

### Voices, articulations, ties, text

- **Two voices.** A bar is read as two voices only when it shows them: a stem-up and a stem-down
  chord, or a stemmed and a stemless note, in the same column, or a rest displaced off the middle
  line. Voice 1 is the stems up, voice 2 the stems down; a stemless chord there is split, upper
  heads to voice 1; rests above the middle line go to voice 1, below to voice 2, centred ones to
  the voice with nothing sounding there. Each voice is checked and repaired against the time
  signature on its own, and the two-voice reading is kept only if it explains the bar better than
  one voice (one voice wins a tie), so melodies with mixed stems are never split. Two fixes made
  this work: a head under another voice's head takes its own stem, not the one running up through
  the other head; and a hollow head touching a filled one (a third apart in one column) is still a
  ring. The meter check counts a bar as fitting if each voice does. Exported as MusicXML voices
  with `<backup>` and stem directions.
- **Articulations.** Staccato dots, tenuto dashes and accent wedges, centred on a chord beyond its
  outer head on the head side (accents may also sit past the stem end and further away). They
  shorten (staccato ~45%, tenuto full length) or strengthen (accent) playback and MIDI, are
  exported as MusicXML `<articulations>`, show in Interpreted view (`·`, `–`, `>`), and can be
  toggled on a note.
- **Ties keep their accidental.** A note tied from an F♯ stays F♯ in the next bar, or at the
  start of the next system, without a new sharp (it played as F♮ before). The next untied F is
  natural again.
- **Text is not notes.** Letters stand in rows of similar-sized components with tight gaps,
  outside the staff lines. A note whose component is in such a row ("o", "p" and "d" of a tempo
  mark, an expression or a dynamic, read as whole or half notes) is dropped. Rows that are mostly
  notes, and anything inside the staff, are left alone. On the CODA and Telemann pages it removes
  the "pp" and the "o"s of "Allegro" and nothing else; the fixtures are unchanged.
- **Double accidentals.** A double flat engraved as two flat glyphs, or cut in pieces by a staff
  line, is reassembled (glyphnet reads the joined box); double sharps split by a line likewise.

### Competing readings and the glyph classifier

Doubtful symbols keep more than one reading, and the reading that best fits the rest of the
evidence wins:

- **Accidentals:** the stroke rules and a small learned classifier (`glyphnet.js`) both read every
  accidental-sized symbol. The rules carry a fixed prior; the classifier can add an accidental the
  rules missed, or change its type, only when it is at least 90% sure, and it can never delete one
  (on real scans, unlike its training pages, it is less reliable about what is *not* a symbol).
  A double sharp cut in two by a staff line is reassembled when the classifier reads the pair.
- **Rests:** the template distance and the classifier score every value; the runner-up values
  are kept with their costs, so the bar check can pick a value the glyph also resembles.
- **Bars:** the bar check chooses among dots, beam counts, rest values, triplets, ignored tuplet
  numbers and, now, "not a note" (cheap for an unbeamed head stranded inside a beam group).
- **Beams:** beams counted from the stem end must stack tightly (a slur running close under a
  beam was being counted as a second beam).

**The classifier** is an MLP: input 962 (a 24 × 40 crop, 3 × 5 staff spaces of the binarized page
with its staff lines, plus box size); hidden layers 96 and 48; output 12 classes (5 accidentals,
black and hollow heads, 4 rest values, other). It has 98k parameters, stored as 130 KB of int8
weights in `glyphnet-weights.js`, and runs in plain JS at ~0.1 ms per glyph, adding a few hundred
ms to a page. It is trained by `tools/glyphnet.mjs` on 120 random pages from
`tools/make_glyphset.mjs`: tunes dense in accidentals, key signatures up to six sharps or flats and
rests, engraved by Verovio in the 5 fonts at 13–26 px per space and degraded at random. That gives
13,800 crops cut from the page as the pipeline sees it. The evaluation fixtures are other tunes.

Note accidentals in the fixtures, given the symbol's pieces:

| | clean | scan | photo | phone |
|---|---|---|---|---|
| stroke rules | 28/30 | 28/30 | 28/30 | 20/30 |
| classifier | 30/30 | 30/30 | 30/30 | 29/30 |

The classifier wrongly reads about 2% of other symbols as accidentals, which is why it adds or
changes one only when it is very sure. Combined, pitch rose from 94.6 to 96.0% on scans, 96.4 to
97.2% on photos and 83.0 to 91.6% on phone photos, with clean pages unchanged. On the CODA sheet
it agrees with the rules on 70 of 71 accidentals and finds the two double sharps the rules
missed. On the Haydn scan the keys of 8 pages are unchanged.

**Why not a bigger network.** Models were checked for size, licence and whether they report
symbol positions, which the in-place rewrite needs:

| model | what it does | size | licence | positions? |
|---|---|---|---|---|
| Legato / Legato 2 (2025–26) | page image → ABC notation, LLM-style decoder | 430 MB (small: 44 MB) | MIT | no |
| SMT (Sheet Music Transformer) | system image → kern tokens | 86 MB | MIT | no |
| homr (TrOMR-based) | U-Net segmentation + transformer per staff | ~20–85 MB ONNX | AGPL-3.0 | segmentation only |
| oemer | U-Net segmentation + rules | tens of MB, ONNX (not measured) | MIT | yes (pixels) |
| glyphnet (here) | one symbol crop → class | 130 KB | (this repo) | yes, from the pipeline |

The sequence models transcribe music but cannot say where on the page each note is, so they
cannot drive an edit of the photo. They would need transformers.js or onnxruntime-web, tens to
hundreds of MB downloaded, and seconds per page on a phone. homr's licence would make the app
AGPL. oemer's segmentation would be the plausible next step if notehead *detection* on photos
becomes the bottleneck (it is the biggest remaining loss on phone photos). That needs ONNX
Runtime Web with WebGPU or wasm, and a check of its weights' size and licence.

### oemer's notehead segmentation, tried

oemer's second U-Net (`seg_net`, 38 MB ONNX, MIT) labels stems/rests, noteheads and clefs/keys
per pixel. Run on the fixture images (Python, onnxruntime on CPU), its notehead layer was scored
by `tools/oemer_heads.mjs`: a true head counts as found when its centre falls in the predicted
mask.

| | heads | ScoreShift | oemer | either | found only by oemer | oemer blobs on no head | oemer time |
|---|---|---|---|---|---|---|---|
| clean | 499 | 99.6% | 92.4% | 99.6% | 0 | 1029 / 1972 | ~100 s a page |
| phone | 499 | 93.6% | 97.4% | 99.2% | 28 | 172 / 627 | ~90 s a page |

On phone photos it finds heads ScoreShift misses: their union would recover 28 of the 32 misses,
the largest loss left there. On clean pages it adds nothing. Half of its blobs cover no head at
all, so it could only confirm heads the rules are unsure of, never add heads on its own. At
38 MB, and minutes a page on a CPU here, it does not fit an offline phone app as is; a smaller
distilled head detector trained on the same synthetic pages as `glyphnet` would be the next step.

### Against Audiveris

Audiveris 5.11 (built from source; batch export) and ScoreShift on the same images, scored by
`tools/compare.mjs` (notes aligned by pitch; values and whole bars compared):

| | ScoreShift pitch / +value / bars | Audiveris pitch / +value / bars |
|---|---|---|
| clean fixtures | 99.0 / 99.0 / 120 of 124 | 96.8 / 95.0 / 113 |
| scan | 96.0 / 95.0 / 105 | 97.0 / 94.8 / 111 |
| photo | 97.2 / 95.4 / 109 | 75.6 / 71.9 / 80 |
| phone (~13 px/space) | 91.6 / 87.2 / 90 | 10.8 / 7.2 / 1 (finds almost no staff lines) |
| CODA sheet (67 bars) | 100 / 100 / 67 | 96.5 / 95.6 / 55 |

`compare.mjs` aligns notes, which counts a little differently from `eval.js`. The CODA reference
is not independent: it is the two outputs where they agree, plus the 13 bars where they differed,
settled by looking at the page. ScoreShift matches all 13 now, and the fixes that got it there
were made on this same page, so its 100% is a fitted score, not a held-out one. Audiveris runs
about 17 s a page in Java; ScoreShift about 1.5 s in the browser. Audiveris reads far more:
several voices, text, repeats, tremolos, and a full editor.

### Real IMSLP files with MusicXML ground truth

Telemann's 12 Fantasias for solo flute (TWV 40:2-13) on IMSLP come with a MusicXML
transcription of all twelve (#236786, ~8,460 notes), which serves as the answer key for two PDFs:
the edition engraved from that same MusicXML (#236783, 24 pages, key exact) and a scanned 1955
Bärenreiter edition (#96616, 24 music pages; a different edition, so a few "errors" are edition
differences).

```
node tools/imslp_fetch.mjs /tmp/imslp 236786 236783 96616      # resolve via headless Chromium, download
node tools/imslp_fetch.mjs --render /tmp/imslp/<file>.pdf /tmp/imslp/haus 2400 2-25
bun tools/imslp_eval.js /tmp/imslp/haus /tmp/imslp/xml/*.xml   # after unzipping the MusicXML
```

`imslp_eval.js` aligns every detected notehead in reading order against the true notes by edit
distance on MIDI pitch (a missed or extra note costs once instead of shifting everything after
it), then maps each staff to the true system its notes align with to score its clef and key.

| | heads found | pitch right | extra | clefs | keys |
|---|---|---|---|---|---|
| typeset edition, before | 99.9% | 98.1% | 26 | 264/264 | 227/264 |
| typeset edition, now | 99.9% | 99.7% | 22 | 264/264 | 263/264 |
| Bärenreiter scan, before | 99.4% | 96.0% | 134 | 264/266 | 243/266 |
| Bärenreiter scan, now | 99.7% | 98.8% | 101 | 264/264 | 263/264 |

Fixes the comparison drove: a flat's bowl split off its stem by a staff line re-joined; a sharp's
crossbar stack no longer bridged into one wide stroke (strokes must be mostly ink, and as tall
as the glyph); flat bowls and sharp crossings rejected as noteheads; an accidental right against
its note ends the key signature; overlapping staves are one staff. Key changes inside a staff
(Fantasia 12's maggiore / minore sections) are read too: a run of accidentals right after a
barline, optionally naturals cancelling the old key, then sharps or flats at the signature
positions; a lone one needs a double or repeat bar, and naturals alone must cancel the whole
key. All four changes in the two editions are found, with none invented on the other 46 pages.
Notes after a change are read in the new key, the transposed page rewrites the change for the
target key (with cancelling naturals where needed), the next staff of a part inherits it, and
MusicXML gets a new `<key>`. Bold scanned sharps whose crossbars fill the space between the stems
(they read as one wide stroke) are split at the two columns with the most ink. Both corrections
are in the staff popup of the Interpreted view: change or remove a detected key change, or add
one after any barline.

What is left (scan: 47 semitone errors of 8,462 notes; typeset: 18), from the error list:
accidentals touching their notehead or stem are merged into the note's component and never read
(a classifier pass on the ink left of the head either fired on beams or, constrained, found
nothing, so it was not kept); naturals occasionally read as flats or sharps on the scan; and a
few readings where the 1955 edition and the MusicXML simply differ.

### Accuracy

Twelve test tunes engraved by Verovio in five different music fonts (Leipzig, Bravura, Leland,
Gootville, Petaluma) at 14–26 px per space: treble, bass and alto clefs, keys from 4♯ to 3♭,
chords, beams, 16ths and 32nds, ledger lines up to five, all accidentals including double sharps,
and for rhythm: rests of every value, dotted values, flags and beams, eighth and quarter
triplets, ties across barlines, 4/4, 3/4, 2/4, cut time and 6/8 with a pickup, two voices on one
staff, staccato / tenuto / accent marks and double flats (ground truth is
every event of every bar from Verovio's own encoding). Each is then run through a deterministic
photo simulator (`degrade.js`: rotation, keystone, page curl, scale, uneven lighting, blur,
sensor noise). 570 notes and 140 bars per condition:

| condition | heads found | pitch correct | note values correct | bars exactly right |
|---|---|---|---|---|
| clean engraving | 99.3% | 98.8% | 99.3% | 137/140 |
| scan (1.2°, blur, light noise) | 96.0% | 95.6% | 95.1% | 119/140 |
| photo (−2.5°, keystone, curl, 1.25×, shadow) | 97.5% | 96.1% | 95.4% | 124/140 |
| phone (4°, strong keystone and curl, 0.85×, heavy noise, ~13 px/space) | 93.5% | 91.2% | 89.2% | 106/140 |

A bar is "exactly right" when every note and rest starts at the right time with the right length,
in whichever voice. The two new tunes cost a little on the totals: two voices in one column hide
heads (a whole-note chord in a fused stack is still missed).

| articulations (clean / scan / photo / phone) | found | false |
|---|---|---|
| staccato (15) | 15 / 15 / 15 / 15 | |
| tenuto (7) | 7 / 6 / 7 / 7 | |
| accent (5) | 5 / 5 / 5 / 5 | |
| any, on other notes | | 0 / 0 / 0 / 1 |

Double sharps 8/8 clean (7/8 on photos), double flats 5/5 clean (2–3/5 degraded).

"Note values" counts every note of the truth, so a missed head counts as wrong; most wrong bars
under degradation are bars with a missed note, which the bar check marks red. All staves and
clefs are found in every condition. Most of what remains on phone photos is noteheads the
detector misses, and key signatures it cannot read.

**A real page:** the CODA 2026–27 viola audition sheet (Brahms 2 and the Fledermaus overture,
alto clef, 11 staves, 321 notes, a PDF engraved with a Finale-style font) reads with every key
signature, both time signatures (3/4, cut time, and 3/4 again at the waltz) and every one of its
67 bars adding up: 5 bars by automatic repair, 1 pickup, 2 section-ending bars, 1 whole-bar rest.
Getting there fixed things the generated fixtures never showed: half notes whose tilted hole is
wider than a space, a tempo-mark letter read as a flat ahead of the key signature, a cut C read as
a fourth sharp, a barline fused with the slur that crosses it, tie fragments taken for dots, a
double sharp taken for a whole note. That page is not committed; with its render at
`fixtures/local/coda_p1.png` (and the PDF at `fixtures/local/coda.pdf`) `bun test` and
`node smoke.js` check it too.

About 250–400 ms per page on a desktop core. The misses that remain are mostly Petaluma's
handwritten-style key signatures under degradation and a few hollow heads in noise.
On a real 1920s Philharmonia study-score page (Haydn op. 17 no. 5, scanned, 1920 px wide, so
only ~13 px per space) it finds all 16 staves, every clef, most key signatures (the rest
inferred) and makes about 340 notehead detections (not ground-truthed); it does not see
grace notes. The transposed page is readable but shows its seams at that resolution.

### Limitations

- Printed music only; no handwriting, tablature, percussion or early notation.
- Grace and cue notes are smaller than the head detector's opening and are not moved; when one is
  found it plays as a short grace note.
- Rhythm: at most two voices per staff; no tremolos, repeats, voltas, multi-bar rests or tempo
  marks (set the tempo by hand); dynamics, slurs and other articulations (marcato, fermata) are
  not read. A note missed by the head detector cannot be added by hand yet; its bar shows red.
- Ties and slurs stay put: fine for steps, visibly off for big moves such as clef changes.
- Moving a note does not re-flip stems or re-slope beams; with a clef change notes can collide.
- One staff size per page; cross-staff beams move with one staff.
- Clefs and keys on scans: on 8 pages of the Haydn scan (132 staves) 131 clefs and 128 keys are
  right. A wrong key gives that staff a different target key; fix it in Interpreted view.
- A key change inside a staff is rewritten in the space of the old one; a longer new signature
  runs towards the music (no squeeze there). One added by hand is drawn after its barline.
- Exported PDFs are page images (JPEG), not vector or text; about 0.7 MB a page.

## Research notes

### What the market does

The established optical music recognition products all convert the page into a notation file
and re-engrave it:

- **SmartScore** (Musitek, since the 1990s), **PhotoScore & NotateMe Ultimate** (Neuratron, a
  Lite edition ships with Sibelius), **capella-scan** (capella-software), **ScanScore**, and the
  older **SharpEye**: desktop scan → MusicXML → editor. ScanScore has a scan mode and a
  "change key" command, but the output is its own engraving.
- **Audiveris**: the open-source reference (Java, AGPL), classical pipeline with a neural glyph
  classifier, MusicXML out; MuseScore's PDF import has used it.
- **PlayScore 2** (iOS/Android) and **Sheet Music Scanner**: point the phone and hear it play;
  where they transpose, it is on their own re-rendered notation.
- **Soundslice**'s scanner (beta Nov 2022, Adrian Holovaty) is machine-learning based and
  often described as the state of the art; its 2025 updates added hairpins, tempo marks and
  slant correction. Newzik's Maestria converts PDFs into interactive "LiveScores" that can be
  transposed.

I did not find a product that edits the photo in place. That is the gap this sketch explores:
recognition errors become visible and local (one note in the wrong place) instead of
cascading into a re-engraved page that looks nothing like the original, and nothing the
recogniser does not understand (fingerings, bowings, hand-written cues, editorial brackets)
is lost.

### Literature

- **Surveys**: Rebelo et al., *Optical music recognition: state-of-the-art and open issues*
  (IJMIR 2012) lays out the staff-first pipeline used here; Calvo-Zaragoza, Hajič and Pacha,
  *Understanding Optical Music Recognition* (ACM Computing Surveys 2020) redefines the field
  and its outputs.
- **Staff detection and removal**: Fujinaga's run-length estimates of line thickness and
  spacing (1988, 2004); Dalitz et al., *A comparative study of staff removal algorithms*
  (TPAMI 2008), which is why removal here only clears runs no thicker than a line.
- **Binarisation**: Sauvola & Pietikäinen (2000) and Wolf & Jolion (2004), the latter for
  low-contrast photos.
- **Datasets**: MUSCIMA++ (handwritten, Hajič & Pecina 2017), DeepScores (Tuggener et al. 2018),
  PrIMuS and Camera-PrIMuS (Calvo-Zaragoza & Rizo 2018).
- **End-to-end models**: CRNN + CTC on monophonic staves (Calvo-Zaragoza & Rizo 2018);
  TrOMR (NetEase 2023, transformer, polyphonic); the Sheet Music Transformer and its full-page
  pianoform successor (Ríos-Vila et al. 2024); **Legato** (2025, NeurIPS 2025), the first
  large-scale pretrained full-page typeset OMR model, emitting ABC; Legato 2 (2026) reads
  system by system.
- **Open source for phone photos**: **oemer** (UNet segmentation + rules, made for skewed phone
  photos) and **homr** (oemer's segmentation + a TrOMR-style transformer, camera pictures to
  MusicXML; Andromr runs it on Android).

End-to-end models output a symbol *sequence*, not positions, which is exactly what in-place
editing cannot use; segmentation models (oemer, homr's first stage, DeepScores detectors)
give positions but need a 10–100 MB network on the device. The classical pipeline gives
pixel-exact positions, component masks for cutting symbols out, and runs in a few hundred
milliseconds with no model at all, which is the right trade for this sketch. A small
segmentation net would be the natural upgrade for heads and accidentals in poor photos.

## Files

| file | what |
|---|---|
| `omr.js` | normalisation, staves, staff removal, clefs, heads, stems, accidentals, keys, barlines, systems |
| `imgproc.js` | Sauvola / Wolf binarisation, run-length metrics, skew, resampling, morphology, components |
| `theory.js` | pitch spelling, clefs, key signatures, 18 instruments, intervals, bar-scoped accidentals |
| `render.js` | transposition plan, in-place page rewrite, interpretation overlay |
| `glyphnet.js`, `glyphnet-weights.js` | learned glyph classifier (98k-parameter MLP, int8) |
| `rhythm.js` | beams and flags per stem, dots, grace notes, rests / time signatures / tuplet numbers by template, ties |
| `raster.js` | SVG path rasterizer and shape descriptor for the glyph templates |
| `score.js` | parts, measures, events, tuplet assignment, bar check and repair, timeline |
| `export.js`, `player.js` | MusicXML 4.0, MIDI, the note list for playback; Web Audio player |
| `app.js`, `index.html`, `worker.js` | UI, corrections, export, PDF paging; recognition (and the page probe) in a worker |
| `pdfsource.js` | pdf.js loading and page rendering; a ~40-line PDF writer for the transposed export |
| `vendor/pdfjs/` | pdf.js 6.3.289 legacy build + JBIG2 / OpenJPEG / QCMS wasm decoders (Apache-2.0 and listed licences) |
| `glyphs.js` | SMuFL outlines (noteheads, accidentals, clefs, rests, flags, digits, C / cut C) from 5 fonts, extracted from Verovio |
| `degrade.js` | deterministic photo simulator with exact point mapping for ground truth |
| `eval.js`, `debug.js`, `scoreshift.test.js`, `smoke.js`, `cdp.js`, `png.js` | evaluation, tests, tiny CDP driver and PNG codec |
| `tools/` | fixture / glyph / sample builders (Verovio 6.3, dev-only) |
| `fixtures/` | `scan_haydn_p*.png` (one system each from a real 1920s scan, regression test), `parts.pdf` (PDF smoke test), 10 clean engravings + ground truth (every head's box, pitch, accidental and value; every bar's events; staves, clefs, keys, meter); `local/` (gitignored) for pages that cannot be committed |

Fonts: glyph outlines from Leipzig, Bravura, Leland, Gootville and Petaluma (SIL OFL 1.1).

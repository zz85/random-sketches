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

### Accuracy

Ten test tunes engraved by Verovio in five different music fonts (Leipzig, Bravura, Leland,
Gootville, Petaluma) at 14–26 px per space: treble, bass and alto clefs, keys from 4♯ to 3♭,
chords, beams, 16ths and 32nds, ledger lines up to five, all accidentals including double sharps,
and for rhythm: rests of every value, dotted values, flags and beams, eighth and quarter
triplets, ties across barlines, 4/4, 3/4, 2/4, cut time and 6/8 with a pickup (ground truth is
every event of every bar from Verovio's own encoding). Each is then run through a deterministic
photo simulator (`degrade.js`: rotation, keystone, page curl, scale, uneven lighting, blur,
sensor noise). 499 notes and 124 bars per condition:

| condition | heads found | pitch correct | note values correct | bars exactly right |
|---|---|---|---|---|
| clean engraving | 99.6% | 99.0% | 99.6% | 123/124 |
| scan (1.2°, blur, light noise) | 96.0% | 94.6% | 94.8% | 103/124 |
| photo (−2.5°, keystone, curl, 1.25×, shadow) | 98.0% | 96.4% | 96.0% | 111/124 |
| phone (4°, strong keystone and curl, 0.85×, heavy noise, ~13 px/space) | 93.6% | 83.0% | 88.6% | 89/124 |

"Note values" counts every note of the truth, so a missed head counts as wrong; most wrong bars
under degradation are bars with a missed note, which the bar check marks red. All staves and
clefs are found in every condition. Petaluma's handwritten-style key signatures are the main
loss on phone photos.

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
- Rhythm: one voice per staff (notes of two voices at one x become one chord, with the longer
  value); no tremolos, repeats, voltas, multi-bar rests or tempo marks (set the tempo by hand);
  dynamics and articulations are not read, so playback is flat. A note missed by the head
  detector cannot be added by hand yet; its bar shows red.
- Ties and slurs stay put: fine for steps, visibly off for big moves such as clef changes.
- Moving a note does not re-flip stems or re-slope beams; with a clef change notes can collide.
- One staff size per page; cross-staff beams move with one staff.
- Clefs and keys on scans: on 8 pages of the Haydn scan (132 staves) 131 clefs and 128 keys are
  right. A wrong key gives that staff a different target key; fix it in Interpreted view.
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

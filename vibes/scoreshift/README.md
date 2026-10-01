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

Runs entirely on the device: plain ES modules, a Web Worker for recognition, no build step,
no dependencies, nothing uploaded. Installable PWA that works offline.

```
python3 -m http.server              # any static server, then open /vibes/scoreshift/
bun test                            # theory, image primitives, recognition accuracy: 18 tests
node smoke.js                       # headless Chromium over CDP: UI, PDF, export, offline: 24 checks
bun eval.js [tune|all] [condition]  # accuracy table; condition = clean | scan | photo | phone
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

**PDFs** (IMSLP, Internet Archive, anything): rendered with pdf.js, including the JBIG2 and
JPEG 2000 images scanned PDFs are made of. Opening probes each page at low resolution for staves
(~0.3 s a page) and starts at the first page mostly covered by music, skipping the cover, title
page and preface. A thumbnail strip and ◀ ▶ move between pages; corrections are remembered per
page. **⬇ Transposed PDF** transposes every page and writes a new PDF of the same page size
(pages with no music are kept as they are). On a 30-page Internet Archive scan of a Haydn
quartet (31 JBIG2 + 60 JPEG 2000 images) it opens at the first page of music in ~12 s and
exports the whole file in ~27 s. The export runs on a pool of up to four workers: the main
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
   and the ends walked outwards through binarisation gaps. A five-line "staff" that sits on a
   real staff's ledger positions and is shorter is dropped.
3. **Staff removal**: vertical runs no thicker than the line are cleared along each line.
4. **Clefs**: the first tall component of each staff. G clef by extent (above and below the
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

### Accuracy

Seven test tunes engraved by Verovio in five different music fonts (Leipzig, Bravura, Leland,
Gootville, Petaluma) at 14–26 px per space: treble, bass and alto clefs, keys from 4♯ to 3♭,
chords, beams, 16ths, ledger lines up to five, all accidentals including double sharps. Each is
then run through a deterministic photo simulator (`degrade.js`: rotation, keystone, page curl,
scale, uneven lighting, blur, sensor noise). 378 notes per condition:

| condition | heads found | precision | pitch correct | staves | clefs | keys |
|---|---|---|---|---|---|---|
| clean engraving | 99.7% | 99.7% | 99.2% | 19/19 | 19/19 | 19/19 |
| scan (1.2°, blur, light noise) | 95.8% | 96.8% | 93.1% | 19/19 | 19/19 | 17/19 |
| photo (−2.5°, keystone, curl, 1.25×, shadow) | 97.9% | 97.9% | 95.5% | 19/19 | 19/19 | 17/19 |
| phone (4°, strong keystone and curl, 0.85×, heavy noise, ~13 px/space) | 94.2% | 96.5% | 89.2% | 19/19 | 19/19 | 17/19 |

About 250–400 ms per page on a desktop core. The misses that remain are mostly Petaluma's
handwritten-style key signatures under degradation and a few hollow heads in noise.
On a real 1920s Philharmonia study-score page (Haydn op. 17 no. 5, scanned, 1920 px wide, so
only ~13 px per space) it finds all 16 staves, every clef, most key signatures (the rest
inferred) and makes about 340 notehead detections (not ground-truthed); it does not see
grace notes. The transposed page is readable but shows its seams at that resolution.

### Limitations

- Printed music only; no handwriting, tablature, percussion or early notation.
- Grace and cue notes are smaller than the head detector's opening and are not moved.
- Rhythm is never interpreted, so there is no playback or MusicXML export.
- Ties and slurs stay put: fine for steps, visibly off for big moves such as clef changes.
- Moving a note does not re-flip stems or re-slope beams; with a clef change notes can collide.
- One staff size per page; cross-staff beams move with one staff.
- Key signatures on scans: 95% of staves right on 8 pages of the Haydn scan (125/132, was 98/132).
  The rest are mostly staves whose clef was not found; a wrong one gives that staff a different
  target key, fixed in Interpreted view.
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
| `app.js`, `index.html`, `worker.js` | UI, corrections, export, PDF paging; recognition (and the page probe) in a worker |
| `pdfsource.js` | pdf.js loading and page rendering; a ~40-line PDF writer for the transposed export |
| `vendor/pdfjs/` | pdf.js 6.3.289 legacy build + JBIG2 / OpenJPEG / QCMS wasm decoders (Apache-2.0 and listed licences) |
| `glyphs.js` | SMuFL outlines (noteheads, accidentals, clefs) from 5 fonts, extracted from Verovio |
| `degrade.js` | deterministic photo simulator with exact point mapping for ground truth |
| `eval.js`, `debug.js`, `scoreshift.test.js`, `smoke.js`, `cdp.js`, `png.js` | evaluation, tests, tiny CDP driver and PNG codec |
| `tools/` | fixture / glyph / sample builders (Verovio 6.3, dev-only) |
| `fixtures/` | `parts.pdf` (PDF smoke test), 7 clean engravings + ground truth (every head's box, pitch, accidental; staves, clefs, keys) |

Fonts: glyph outlines from Leipzig, Bravura, Leland, Gootville and Petaluma (SIL OFL 1.1).

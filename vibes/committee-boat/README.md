# Committee Boat

Race committee paperwork on a phone or tablet: the fleet list, the start sequence with spoken signals and who is clear to cross, start-line marks (crossed, OCS, DNS, DNC), finish times from a big button or the horn, and PHRF results.

Open `index.html` (no build, no deps). `?demo=<seconds>` loads a demo fleet with rolling starts that many seconds from now (`&fresh` replaces what is saved), `?tab=fleet|start|finish|results`. Everything is saved in the browser (localStorage) as you go; Settings → Back up writes it all to a JSON file. Installable PWA, works offline (except OCR without TextDetector, see below).

## Tabs

| Tab | What it does |
|---|---|
| Fleet | Boats with sail number, name, type, rating (PHRF s/nm) and fleet. Sort A–Z (ignores a leading "The"), by sail number (numeric part, so 7, 42, 112, USA 12345), fleet or rating. Import pasted spreadsheet rows or CSV: with a header the columns are found by name (Sail, Boat, Type, PHRF / Rating, Fleet, Skipper), without one the order is sail, name, type, rating, fleet. |
| Start | Starts in time order, each with its fleets and a countdown. "One per fleet" makes rolling starts N minutes apart. Banner: which starts are clear to cross now and which are not yet. Each boat: **Crossed** (before its gun that is OCS, after it a good start; an OCS boat crossing after the gun has returned), **Over** (OCS), **Returned**, and DNS / DNC under ⋯. General recall clears the start's marks and asks for a new time. |
| Finish | Type part of a sail number (the end counts most: what you read off the bow) or a name, pick the boat, and it goes **on deck**. The FINISH button (on press, not release; Space works too) gives the time to the first boat on deck, or keeps a time with no boat to name later (shown in red, badge on the tab). Tap a time to edit hours, minutes, seconds (±1 s); tap a name to change the boat; **+ Time** adds one by hand. Still racing: who is out there (OCS boats that never returned are flagged), DNF / RET buttons. Out: DNC, DNS, OCS, DNF, RET. |
| Results | Per fleet: PHRF time on distance (corrected = elapsed − rating × course nm), time on time (elapsed × A / (B + rating), 650 / 550 by default) or elapsed. Ties share points; DNC, DNS, OCS, DNF, RET, DSQ score entries + 1. "Race closed" scores boats still racing as DNF. A finish before its start is flagged, not placed. Copy as text, CSV, print. |

Every mark shows a toast with Undo. Races are kept separately; **+ Race** copies the starts' fleets and the scoring.

## Clock and narration

The clock is the device clock plus a GPS offset plus a manual offset. With "Use GPS time" the app compares each fix's timestamp with the device clock; a fix arrives after its timestamp, so delay only pulls a sample down, and the offset used is the 80th percentile of the last 15. Some browsers stamp fixes with the device clock itself, so the GPS offset can stay at 0; then use the manual offset: ±0.1 / 1 s, or **Tap on the minute** the moment a reference clock (the RC's GPS, a phone on network time) turns a whole minute.

Narration (speech synthesis): each signal of the sequence (5-4-1-0 or 3-2-1-0), "in 10 seconds" and 3-2-1 before each signal so the horn goes on time, 30 / 20 / 10 / 5…1 to the start, and at the gun "PHRF A start. Clear to cross:" with the sail numbers digit by digit and names. Also boats over early and each finish. A signal that is already more than 2 s past is never said (opening the app mid-race is quiet). Optional beep at signals. The screen is kept on (Wake Lock).

## Horn, voice and camera

- **Listen for horn**: the microphone's 250–2500 Hz band must rise `sensitivity` dB over its running noise floor and be tonal (its strongest bin 12 dB over the band median, which a horn's harmonics are and wind is not) for the shortest blast setting (150 ms). The finish time is when the blast began, less half the FFT window. Horns within 5 s of a start signal are ignored. `horn.js`, tested on synthetic spectra.
- 🎤 says a sail number or a name into the lookup ("four two", "forty two", "Blue Moon"); one clear match goes on deck. Chrome / Safari speech recognition.
- 📷 reads a bow name or sail number in the dashed box (or a photo): the browser's TextDetector where there is one, otherwise Tesseract.js loaded from jsDelivr on first use (needs a connection once). OCR text is matched fuzzily against the fleet (O/0, l/1, S/5 in numbers, misread letters in names); tap a match to put it on deck.

## Files

`race.js` (model: fleet, lookup, starts, marks, finishes, scoring, narration), `horn.js` (horn detector), `app.js` (UI), `index.html`. `node --test race.test.js` (12), `node smoke.js` (32 checks in headless Chromium, screenshots `smoke_*.png`), `node mkicons.js` (PNG icons from `icon.svg`).

# Sound Race

A tactics trainer for windward-leeward racing off Shilshole, in central Puget Sound. You race recorded days, with the wind as NOAA's West Point station measured it and the tidal current NOAA predicts for those hours. Three AI rivals race you, each sailing the course a different way. Sail Trim teaches trim; this teaches the decisions in between: where to start, when to tack on a shift, which side the current favours, when you are on the layline.

Open `index.html` (no build, no deps, works from `file://`). Links: `?day=0..7&leg=0.5|1|1.5&laps=1|2|3&speed=0..5`.

## What it simulates

- **Wind**: the 10-minute means and gusts of NDBC station WPOW1 (West Point lighthouse) on eight real race windows from 2024 and 2025, weeknight 18:00 and weekend 12:00 PDT. The days were picked to cover different conditions: steady, shifty, a persistent veer or back, light and patchy, fresh, northerly and southerly. A 10-minute mean hides the short shifts, so inside it the wind carries frozen turbulence moving downwind at the wind's own speed. The shifts are 3 to 10° (sized from how much the record moves between samples) over about 2 km and 15 minutes, and the puffs are sized from the gust ratio over about 450 m. You see them coming from upwind, as darker water. The wind is lighter in the lee of land, up to 45% within 700 m downwind of a shore. The strip under the map plots the whole record, with the race window shaded.
- **Current**: NOAA CO-OPS 6-minute predictions at six harmonic current stations (West Point, Point Jefferson, President Point, Alki Point, Alki 1 mi W, Restoration Point). Each station gives flood and ebb directions of its own. They are blended by inverse distance squared and fall to nothing over the last 400 m to the shore. The cyan arrows on the map show the current; the cyan line in the strip is the current along the course axis.
- **Land**: NOAA ENC Direct coastal-scale land areas. Land shows on the map, gets a 100 m raster and a distance-to-shore grid, and a boat that sails into it runs aground.
- **Boat**: a Catalina 30 on the Sail Trim model's own polar (`../sail-trim`, calibrated against her ORC certificate at 1.6% RMS), auto-trimmed at every wind speed and angle. Each point takes the faster of the genoa and the spinnaker, or the genoa poled out wing on wing, and the right sail shows on the boat. Speed through the water follows the polar with a lag: about 12 s to build and 5 s to lose, so a tack costs about a third of her speed. Leeway is up to 4° close-hauled. The helm turns 6°/s, and the ground track adds the current.
- **Race**: a windward-leeward course laid to the wind at the gun. The start line is square to the wind, the windward mark is left to port, the leeward gate sits just below the line, and the finish is downwind through the line. The course goes at the first of seven spots off Shilshole that keeps it, and 600 m either side of it, 250 m clear of the shore. The three-minute sequence has OCS: you dip back below the line to start again.

## Playing

- The helm holds the best VMG angle for the wind where you are, upwind or downwind by leg. You choose when to tack or gybe (`Space`, or the touch button).
- `←` `→` steer 2° (`Shift` for 10°). The helm then holds that true wind angle, which is how you luff to kill time before the start or reach off to a mark. `V` returns to the VMG angle.
- `1` to `6` set the speed (1x to 32x) and `P` pauses. Zoom with `+`, `-` or the wheel. Drag the map to pan, and double-click (or `C`) to follow the boat again. "North up" turns the map from course up.
- The HUD shows TWS/TWD/TWA at the boat; the shift against your last three minutes' mean, as lifted or headed on your board upwind; the current set and rate; and the distance, bearing and VMC to the next mark. Place is counted by legs done, then distance to the next mark.
- The dashed green (starboard) and red (port) laylines are ground tracks at the polar's VMG angle in the wind and current at the mark, so they lean with the tide.
- After the finish, the results show each boat's elapsed time, tacks and gybes. The debrief gives your time against the ORC VMG time for the course at the day's mean wind, your upwind time on the lifted and the headed board, the metres the current carried you toward or held you back from the marks, and the distance you sailed over the ground.

## Rivals

`sim.js` `STYLES`: all three sail the polar's VMG angles and take the laylines, current included, with 2° of overstand. Near a mark (within 350 m) they steer straight at it, and they tack away from a shore ahead. In the pre-start they luff at a set-up point 45 s below their spot on the line and leave in time to reach it at the gun. They hold back further where the current would set them over.

- **Shift sailor** tacks on any header over 5° against its last 6 minutes' mean wind and gybes on the lifts. It starts at the committee boat end.
- **Tide reader** compares the current up the course on each side at the start of each leg and goes to the better side first. It starts mid-line.
- **Middle road** stays within 30% of the leg's half-width of the rhumb line and tacks only on headers over 8°. It starts toward the pin.

Two-lap, 1 nm races (`node --test sim.test.js`, elapsed minutes for the three styles, against the ORC VMG time at the day's mean wind):

| Day | ORC | Shift sailor | Tide reader | Middle road |
|---|---|---|---|---|
| Steady northerly, 12.5 kn | 51 | 61.0 | 60.9 | 62.5 |
| Shifty northerly, 10.7 kn | 54 | 64.9 | 64.8 | 64.2 |
| Northerly veering right 37° | 62 | 69.7 | 67.4 | 77.5 |
| Steady southerly, 15.3 kn | 48 | 54.1 | 53.8 | 54.3 |
| Shifty southerly, 3 to 17 kn | 57 | 113.8 | 104.0 | 105.7 |
| Southerly backing left 43° | 54 | 55.1 | 54.1 | 70.0 |
| Light and patchy | 72 | 123.3 | 120.9 | 125.9 |
| Fresh breeze, 17.7 kn | 46 | 54.0 | 54.6 | 54.1 |

On steady days they are 10 to 20% off the ORC time, from tacks, roundings and an adverse tide on the beats. On the days where the wind died or swung 50°, the race takes nearly twice the time the day's mean wind predicts. Where the wind backed 43°, the middle road lost 15 minutes to the boats that went toward the shift.

## Files

- `sim.js`: projection, land, wind field, currents, polar, boat, laylines, course, rounding and finishing, AI. No drawing. It runs in the browser and in node.
- `app.js`, `index.html`: drawing, HUD, input, the race loop and the debrief.
- `data/days.js`, `data/land.js`: built by `node fetch_data.js` (needs network: NDBC historical `cwind` files, CO-OPS current predictions, ENC Direct). NDBC has no CORS headers, so the page doesn't fetch it and the data is bundled.
- `data/polar.js`: built by `node build_polar.js` from `../sail-trim/model.js` (parallel workers, about 40 s on 48 cores).
- `debug_race.js [day]`: prints an AI race in the course frame.

## Tests

- `node --test sim.test.js`: land around West Point and Bainbridge; polar numbers and VMG angles; the current blends the stations, slows at the shore and turns with the tide; the wind follows the record and its puffs move downwind; the wind shadow north of West Point in a southerly; boat speed, a tack's speed loss and the current's set; laylines lean with a current; courses in clear water on every day; a whole two-lap AI race on every recorded day (no grounding, starts on time, believable times).
- `node smoke.mjs`: headless Chromium (Playwright's, via `cdp.mjs`): loads, sails the pre-start at 32x, starts, tacks, steers, returns to VMG, waits for a rival to round the windward mark, switches to a southerly day, and takes screenshots, with no exceptions.

## Limits

- The 10-minute record is from one station at West Point. The wind's spatial pattern (shifts and puffs) is generated around it, so it is realistic in size and timing but isn't the day's real pattern.
- Boats don't collide, and there are no right-of-way rules between them. Mark touches aren't penalised here, unlike Sail Trim's single-boat race.
- Currents are predictions, not the day's measurements, and the blend between stations ignores eddies behind points such as West Point.

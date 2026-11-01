# Sail Trim

A trimming simulator for a masthead sloop from 20 to 50 ft, calibrated against the ORC polar of a Catalina 30. Every string a crew pulls is a control, and each one changes the sail shape the way it does on a real boat. The shape decides the flow at three heights of each sail, the flow decides the forces, and the forces decide boat speed, heel, leeway and helm.

Open `index.html` (no build, no deps). Files: `model.js` (the physics), `race.js` (course and rules), `polar.js` (polar view), `calib/` (ORC data and the fit). `?preset=light|medium|breezy|gale|reach|genReach|run|spinRun`.

## Controls and what they change

| Control | Shape it changes (in `model.js` `shape()`) |
|---|---|
| Mainsheet | Boom angle, and leech tension while the boom is near the centreline. Past about a third eased the sheet stops holding the leech, so twist opens. |
| Traveler | Boom angle without changing leech tension. |
| Vang | Leech tension (twist) when the sheet no longer holds it, a little low mast bend. |
| Main halyard, cunningham | Luff tension: draft position. Too little shows horizontal wrinkles (scallops), too much a vertical crease. The tension needed rises with wind load, which also blows the draft aft. Cunningham also flattens and opens the top. |
| Outhaul | Depth of the lower main. |
| Backstay | Mast bend (flattens the main, mostly the top, twists the upper leech) and forestay tension (less jib sag, so a flatter jib with a finer entry). |
| Jib sheet | Jib angle and jib leech tension. |
| Jib car | Twist of the jib and depth of its foot: aft, the top luffs first; forward, the foot does. |
| Jib halyard | Jib luff tension and draft position. |
| Headsail | Jib, spinnaker or gennaker; each shows only its own controls. |
| Wing on wing | The jib poled out to windward on a whisker pole, clear of the main's wind shadow. Only works within about 30 degrees of dead downwind; higher, the poled jib is aback. |
| Spinnaker sheet, guy / pole, pole height | Sheet sets the clew. The pole angle should be at right angles to the apparent wind: too far forward on a run hides the kite behind the main, too far aft on a reach collapses the luff. Pole height should keep tack and clew level (a little lower in light air): too high curls the top of the luff first, too low the foot. A symmetric kite loses some efficiency on a tight reach. |
| Gennaker sheet, tack line | Tack down on the bowsprit for a tight reach, eased up on a broad reach so the sail rotates out from behind the main. It can't go as deep as a spinnaker: on a run it sits in the main's wind shadow. |

## Boat size

The base boat is a Catalina 30 as its ORC certificate measures it (29.3 ft, 7.63 m waterline, 5648 kg sailing with crew, 21.7 m² wetted surface, main 22.6 m², genoa 33.4 m², spinnaker 60.3 m²). The Length slider scales it from 20 to 50 ft: sail areas with L², displacement with L³, righting moment with L⁴, hull speed with √L. Sail heeling moment grows with L³, so a bigger boat heels less for the same wind, carries full sail longer and is faster.

## Spinnaker trouble

Over 30 degrees of heel under a kite the boat broaches: she rounds up about 45 degrees, is knocked flat and loses half her speed.

## Model

- Wind: true wind at 10 m with a power-law gradient, so the masthead sees more wind from further aft (apparent wind twists with height). Gusts and slow shifts are on by default, so trim is never finished.
- Each sail is three sections at 20 / 50 / 80% height, each with an angle (boom or clew angle plus twist), a depth and a draft position.
- Each section has a groove of angle of attack between luffing (windward telltale lifts) and stalling (leeward telltale stalls). The groove is wider for a deep sail with the draft forward, narrower for a flat one or the draft aft, which is why light air wants full sails and a breeze lets you flatten them. Past the stall the section turns into drag, which is how a run works.
- The jib heads the main a little, backwinds its luff when sheeted inside it, and sits in the main's shadow on a run.
- Heel: heeling moment against a righting moment; heel reduces the wind the sails see (cos heel) and adds hull drag. Hull: friction, a wave wall near hull speed (about 6.8 kn), keel induced drag and leeway from side force, rudder drag from weather helm. Helm comes from heel and from main versus jib power.
- Auto-trim: coordinate search over the controls of the sails that are up, for each number of reefs, for the fastest steady speed, with a penalty past 25 degrees of heel and for a heavy helm. A reef must gain a little to be chosen. Off the wind it also starts from eased sheets (a search from close-hauled sheets stops short), and with the jib it tries wing on wing. It keeps the headsail you chose.
- Trim coach: advice from the telltales and shape, the way a trim guide reads them.

## Calibration

The coefficients the model can't measure (`CAL` in `model.js`: sail lift and parasitic drag, spinnaker efficiency and how far a squared pole gets it out of the main's shadow, the genoa's sheeting angle with the sheet in hard, hull skin friction and its rise with heel, wave-making resistance as a power of the Froude number, righting moment, windage) are fitted to a published ORC polar: the 2026 ORC Club certificate of the Catalina 30 "River Weasel" (USA 3522, ORC ref `04560004IWP`, from data.orc.org), stored in `calib/orc-catalina30.js`. Its targets are boat speed at 52 to 180 degrees true wind angle and the VMG beat and run at ORC's optimal angles, in 4 to 24 kn of true wind (117 speeds), plus 36 pointing checks: sailing 7 degrees higher or lower than ORC's beat angle (12 for the run) must not make a better VMG than ORC's.

`node calib/calibrate.js` alternates two steps for five rounds: auto-trim every point with every sail a crew would try (genoa below 75 degrees, genoa or spinnaker from there, as ORC takes the faster), in parallel workers; then fit `CAL` with those trims held (Nelder-Mead). It writes `calib/cal.json`, copied into `model.js`. `--check` prints the table and the VMG angles for the `CAL` in `model.js` (`calib/check.txt`).

Result: 2.6% RMS error on the speeds. VMG beat angles: 48 / 46 / 42 / 40 degrees in 4 / 6 / 8 / 10 kn (ORC 46.6 / 43.7 / 42.1 / 41.2), 36 to 38 from 12 kn (ORC 40), with the VMG within 3%; only 1 of the 36 pointing checks beats ORC's VMG by more than 0.5%. Light-air pointing came from the sheeting angle: with the genoa allowed in to 8 degrees the boat pointed 10 degrees too high in 4 kn; the fitted lead is 16 degrees, a cruiser's toe-rail track. Known gaps: a spinnaker beam reach in 6 kn is 10% fast, and the model runs deeper than ORC in 8 to 14 kn (170 to 175 degrees against 153 to 168) at the same VMG.

The spinnaker's gain over a jib alone was checked against the difference between the ORC Club and non-spinnaker certificates of an S2 9.1 (5% at 120 degrees and 9% at 150 in 12 kn); a test holds it between 2 and 14%.

## Polar view

The Polar tab beside Sails draws the model's polar, auto-trimmed at 15 angles from 32 to 180 degrees (the faster of the genoa and the spinnaker), against the ORC certificate's, for the wind speeds you pick (6, 12 and 20 kn at first), with each line's RMS error, both VMG optimums and your boat as a dot. It is computed in Web Workers built from the model's own source (`SailModelFactory`), so it runs from `file://` too, and in the page, an angle at a time, where workers aren't available. At another length than 29.3 ft the ORC lines dim, since they are the Catalina 30's.

## Race

Race panel: a windward-leeward course of 0.25, 0.5 or 1 nm legs, 1 or 2 laps, with a 1, 3 or 5 minute start sequence (signals at 60, 30 and 10 s). Start between the pin and the committee boat, round the windward mark to port, go through the leeward gate on lap 2, and finish back through the start line. Over the line at the gun is OCS until you dip back below it; touching a mark or the committee boat costs a 360 (a full turn either way), owed before the finish counts. The header shows the clock, the leg and the distance and bearing to the next mark; the Course tab shows the map with laylines from the windward mark for the wind as it is (shifts move them), your track and the next mark, and a minimap stays on the Boat view while racing. Time x2 / x4 / x8 speeds up the boat, the wind and the clock.

At the finish it gives your time from the gun against the ORC VMG time for the course (each leg at the certificate's beat or run VMG for the set wind, scaled by the square root of length for other lengths), as a percentage, and keeps your best per course, wind and length in localStorage. Auto-trim during a race is noted. `race.js` holds the rules with no drawing.

## Tests

- `node --test model.test.js`: physics sanity (no-go zone, plausible speed and heel, auto-trim never slower, stall and luff, backstay, cunningham, outhaul, vang, depower, jib lead, boat size, reefing, kite gain against ORC, spinnaker pole, kite collapse close-hauled, six points of the Catalina 30 polar).
- `node --test race.test.js`: crossings, a lap, the wrong-way rounding, OCS, a mark touch and its 360, two laps through the gate, the ORC time, and an autopilot that sails two laps with the model (16:05 against ORC's 13:39 in 12 kn, with its tacks and gybes).
- `node smoke.js`: headless Chromium (Playwright's, via `cdp.js`): loads, sails, auto-trims, tacks, hoists the spinnaker and gennaker, reefs, changes the boat length, computes the polar in workers and checks it against ORC, starts a race, screenshots.

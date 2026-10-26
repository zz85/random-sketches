# Squash Court: to build

Things we found worth doing but haven't done yet. The first item in each section is the one to do first. Benchmarks are named where one exists, so a change can be measured against today's figure.

## Players

- **Overhead and replay-camera feet.** On the near-overhead camera (the Nantes replays in `4SUAaJp3z5A`) feet land 10–30% of the player's height below the real feet. The person box is a fixed 0.6 × 1.75 m upright box, which is wrong when looking almost straight down. Measure with `tools/pbox_eval.mjs --video 4SUAaJp3z5A --show 12`. Today 18% of players are found with feet in place, 36% with any box overlap.
- **Feet behind the back-glass frame.** Club courts with a glass back wall (`1kUy7bkYNMg`): the feet stop at the glass frame or door bar instead of at the floor.
- **Recall on real frames.** Today 33% of players are found with feet in place and 47% with any box overlap, with 491 detections that match no labelled player (`tools/pbox_eval.mjs`, each still on its own with no background model). Add a mode that warms the background model on the video around each labelled frame, so the benchmark measures what the page actually sees.
- **Near players.** 20% are found when the box is ≥ 320 px tall, against 38% for far players. The box search may reject them: too big, or feet out of frame.
- **Players crouched behind a score bug.** They are placed as if standing (README Limits).
- **Heatmaps double-count after a seek back.** Seeking back adds an already-watched stretch to the heatmaps, speeds and T time again. Remember which video times are already counted.

## Identity and names

- **Hook the scoreboard OCR into the Players panel.** `ocr.js` (thread 25) is untracked and not used yet. Names typed by hand should still win over names read, and ⇄ should still swap them.
- **Test the OCR against the SquashAI name labels.** `attributes.csv` has both players' names on each frame, so every frame with a score bug can check the OCR. Thread 25's own test was 4 of 9 frames read fully right.
- **Test shirt-colour identity against SquashAI shirt colours.** `attributes.csv` has a hex colour per player per frame. `match.mjs`'s player 1 / player 2 could be scored against it, across cuts, per video.

## Court

- **A confident wrong fit on a low end-on camera.** `ohtRSiQ-HPg-282137.jpg` is reported ok, but the lines are drawn in the wrong place (the label's T-box sits on the real service lines). The fit score should reject it. Find more like it in the `pbox_eval --json` output: frames where `ok` is true and the T-box is more than 30 px off, whose label T-box is not stale.
- **The T-box sits about one line width wider than the labels.** The projected inner corners of the service boxes sit 5–10 px outside the clicked corners, the same way on every video. It is probably which edge of the line the labellers clicked. Check against a frame where the line edges can be measured, before changing the court model.
- **Detect the zoomed front camera behind a glass front wall.** `Top 10 Rallies - PSA Squash Tour Finals 202425.mp4` 4:07–4:15: a camera in the stand about 6.7 m behind the glass front wall and 1.7 m outside the right wall, 1.3 m up, 30° wide. Fitted by hand from five points (rms 4.5 px), it tracks the whole 8 s pan. Detection still misses every frame, for two reasons. The thin red lines on the dark wood floor are barely found: the line detector picks up the wood grain as strongly. Brightening the frame or keeping only coloured line pixels did not help. And a low camera behind the back wall that reads the back wall's railing and its floor edge as the tin and service line scores higher than the right camera. That fit fails the court test, so nothing wrong is shown, but nothing right is either. Measure by: frames of that clip fitted within 5 px of the hand camera.
- **Make court accuracy on real frames a benchmark.** Count only frames whose label T-box fits (one T-box is clicked per camera set-up). Today the error is 7.8 px median at 1280 px on those frames. Report it with `pbox_eval` as a second table.

## Ball, shots and commentary

- **`match.mjs` names no shots on some cameras.** On the Rehman v Hosny semifinal (`029AwqdH868`), all 1,340 fitted ball flights were rejected as coming from "other cameras". `mainView` is too strict for that club-court main camera.
- **Skip slow-motion replays.** They are analysed as live play, which gives wrong speeds and repeated bounces. The SquashAI `replay` tag (109 frames) is ground truth for a replay detector.
- **Rally start and end.** The SquashAI `action` tag (734 of 1,253 frames) marks rally vs between points. Use it to test rally segmentation, then add a summary after each point (length, shots, who won the T).
- **Check heard bounces against frames.** Impact sounds line up with impacts seen in the video only a little better than chance. Shoe squeaks near the end of a lost flight can add a false bounce.
- **Check commentary shot by shot.** Shots are named correctly on synthetic flights, but individual real shots haven't been checked against the video (the ball is too small at contact-sheet size). Use full-size frames around each named shot.
- **Who hit the shot.** The hitter is known for only about a third of bounces.

## Stats

- **More shots with a known hitter, for the coaching numbers.** On a full game only 115 of 415 shots have one (`coaching.js`), and volleys could be decided on 21. Racket sounds near a player give hit moments without a fitted flight, and so do the players' own swings, so the T-at-hit number would not depend on the ball fit. Check volleys and the hit times against frames.
- **Grade replies from what happened next.** Response patterns' High / Medium / Low comes from the reply shot and where it was taken (`replyQuality`). Grading by the rally's outcome, or by how far the striker was pulled off the T, would be closer to what coaches mean. It needs rally winners, which need the score bug read between points.
- **First-bounce accuracy per shot type.** The first-bounce map is there; add each player's spread per shot type (straight drives along the wall, crosscourts past the opponent), compared with a target zone.

- **Check T domination against results.** Run `match.mjs` on single full matches with a known winner, and see whether T control (share of the time each player is the nearer to the T) predicts it, as SquashAI set out to measure. On the Rehman v Hosny semifinal it is 56% / 44%; that result hasn't been looked up.
- **T over time.** Each player's T share per rally or per minute, next to the speed chart.

## Live and recordings

- **Take the recorded video out of the browser.** It is kept in IndexedDB only; Download writes the analysis without it. The segments are separate WebM / MP4 files (one recorder each), so a download needs them joined (remux, or a zip of the segments with the `.json`). Also: a storage meter and old-recording clean-up when the browser's quota runs low.
- **Check video recording on phones.** Frame rate of the analysis while encoding, and Safari's MP4 segments seeking and playing back to back.
- **Still frames at each shot.** A cheaper alternative: one JPEG per named shot (or per floor bounce), shown next to its line in the commentary feed of a recording.
- **Rally winners in the rally list.** It shows the last shot, not who won the point; that needs the score bug read between points (OCR) or the ball's last bounce judged.

## Data

- **More labelled real footage.** SquashAI is 1,253 stills from 8 videos (2017–2020), with no ball labels and with gaps between frames too long to test tracking. A small labelling mode in the page, to click players' feet and ball positions on consecutive frames and export them, would give tracking ground truth.
- The SquashAI videos are PSA footage: keep them and the frames extracted from them local (`tools/squashai_fetch.mjs` puts them in `/tmp/squash/squashai`).

# Squash Court

Finds a squash court in a photo, a video or the live camera from its painted lines, and recovers the camera that took it: position in metres, view direction, focal length and lens distortion. From that every pixel on the floor or walls maps to court coordinates, and the floor and front wall can be shown rectified. Plain JS, no dependencies, runs in a worker.

Open `index.html` from any static http server (module worker), then Open… a photo or video, drop or paste one, use Camera, or press Demo frame for a synthetic frame with a known camera. Click the frame to measure a point; Export camera JSON writes K, R, C, the 3×4 matrix and the floor / front wall homographies.

## How it works

The court is a known 3D object (WSF singles: 9.75 × 6.4 m, front out line 4.57, service line 1.78, tin 0.48, back wall line 2.13, short line 5.44 to its back edge, 1.6 m service boxes, 50 mm lines — `court.js`). The detector fits a full pinhole camera to it rather than a floor homography, because broadcast frames often show more wall than floor, and only a 3D model ties the two together.

1. **Line pixels** (`lineMap`): a pixel is on a painted line when the pixels a few px either side, across some direction, are alike and both differ from it the same way, at three scales. That fires on thin lines of any colour on wood, dark floors, white walls and glass, but not on edges. The four directional responses give the line normal; non-maximum suppression across it leaves sub-pixel centre lines.
2. **Segments** (`segments`): centre-line pixels are linked by direction and split until straight; short pieces (text, adverts, wood grain, crowd) are dropped.
3. **Distance map** of the segment pixels with the nearest one's index, so a projected model point finds its image line in O(1).
4. **Search** (`detectCourt`): ~6000 camera seeds drawn from where squash cameras stand (behind and above the back wall, overhead, through the side glass, in the court), scored by how much projected model line lands on image line; a short stochastic local search on the best; distinct survivors refined.
5. **Refinement** (`refine`): Gauss–Newton ICP on 8 parameters (Rodrigues rotation, position, log focal, radial k1), each model sample pulled along its projected normal to the nearest image line, Tukey-weighted with a shrinking scale, LM-damped, with plausibility bounds (above the floor, not behind the front wall). The back-wall line is ignored for cameras behind it.
6. **Choice**: candidates are scored both ways (model on image lines, and image segments explained by the model) and the search runs at 640 and 480 px work width, keeping the camera that explains the finer image best (the coarse one is steadier on clutter, the fine one resolves thin distant lines). The focal / distance trade-off is probed explicitly.
7. **Video** (`trackCourt`): each frame refines from the previous camera (wide capture, then tight), and re-detects after three low-confidence frames.

## Numbers

- Synthetic frames (`node tools/synth_eval.mjs 20`, random broadcast cameras, club and glass courts with players and advert clutter): 17/20 found; on those median error 1.6 cm in position, 0.03° in view direction, 0.08 % in focal, 0.18 px reprojection.
- 18 PSA / SquashTV broadcast stills (YouTube auto-thumbnails of match videos, not in the repo): 11 fitted correctly by eye — every wide or standard broadcast view, overhead club cameras and glass show courts. The misses are close-ups where little of the court shows (one wall and a corner of floor), which have no unique solution from a single frame; in a video they are carried by tracking.
- Time (node, one core): detection ≈ 450 ms per frame (both resolutions), tracking ≈ 60 ms at 480 px (≈ 20 fps in headless Chromium without GPU; feature extraction is most of it and could move to WebGL).

## Files

- `court.js` court model; `camera.js` camera (project, ray, unproject, homography, angles) and a small solver
- `detect.js` features, search, refinement, tracking; `worker.js` runs it off the main thread
- `app.js`, `index.html` the UI: overlay, rectified floor and front wall, a 3D view with the camera frustum, point picking, export
- `synth.js` ray-cast synthetic court frames with a known camera
- `tools/run.mjs` detect on images and write overlays (`--map` shows line pixels); `tools/synth_eval.mjs` accuracy sweep; `tools/make_video.mjs` synthetic clip
- `bun test` (11: camera maths, model, distance map, detection and tracking on synthetic frames); `node smoke.js` (headless Chromium through the real UI and worker: demo frame pose, click to metres, export, a tracked video clip)

## Limits

Assumes a standard singles court and a principal point at the image centre. Painted lines must be visible; a frame showing one wall and a sliver of floor is ambiguous. Real frames came from YouTube thumbnails because the video downloader was blocked (bot check), so a real broadcast video has not been tracked end to end yet — only the synthetic clip.

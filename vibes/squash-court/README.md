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
6. **Service-box seeds** (`boxes.js`): the box sides, box backs and short line are found as fitted image lines; each pair of boxes gives the four inner corners, a floor homography, and (with the principal point known) a camera for a ladder of focal lengths. Corners come from intersecting lines, so a player's foot on a corner does not hide it.
7. **Choice**: every model line counts by the fraction of it that is matched (pixel length would reward a camera that blows up the few lines it matches and pushes the rest out of frame), the floor lines most, an image line pixel credits one model line only, and the image line must run the same way as the model line (glass panel seams and frames crossing it do not count). Candidates are also scored image-to-model, at 640 and 480 px work width. The focal / distance valley is probed for the best few, and the polish fits k1 and the tin height: 0.48 m (WSF) or 0.43 m (PSA men).
8. **Confidence**: a frame is a court when at least three lines match and one of them is on the floor; TV graphics, logos and audience shots match one or two lines of anything and are rejected.
9. **Video** (`trackCourt`): each frame refines from the previous camera at a tight tolerance (a wide one lets clutter drag it along the zoom valley), probes the valley a step either way, and the page re-detects after three low-confidence frames or when a fit explains much less than the last detection did (a cut to another camera).

## Numbers

- PSA broadcast video (two top-10-rally compilations, 1280×720, one frame every 10 s, 169 frames, not in the repo; `node tools/batch.mjs out frames/*.jpg`): 138 detected with confidence. Every wide broadcast view checked by eye fits, including the PSA men's tin; court-level close-ups from inside the glass mostly fit; the end cards, logos and audience shots are rejected. Misses: older dark courts with faint blue lines (Hull, El Gouna), some steep overhead zooms and corner close-ups.

- Synthetic frames (`node tools/synth_eval.mjs 20`, random broadcast cameras, club and glass courts with players and advert clutter): 17/20 found; on those median error 1.6 cm in position, 0.03° in view direction, 0.08 % in focal, 0.18 px reprojection.
- 18 PSA / SquashTV broadcast stills (YouTube auto-thumbnails of match videos, not in the repo): 11 fitted correctly by eye — every wide or standard broadcast view, overhead club cameras and glass show courts. The misses are close-ups where little of the court shows (one wall and a corner of floor), which have no unique solution from a single frame; in a video they are carried by tracking.
- Time (node, one core): detection ≈ 0.9–1.5 s per still (both resolutions, both tin heights), tracking ≈ 55 ms at 480 px (≈ 15–18 fps in headless Chromium without GPU).

## Files

- `court.js` court model; `camera.js` camera (project, ray, unproject, homography, angles) and a small solver
- `detect.js` features, search, refinement, tracking; `boxes.js` service-box seeds; `worker.js` runs it off the main thread
- `app.js`, `index.html` the UI: overlay, rectified floor and front wall, a 3D view with the camera frustum, point picking, export
- `synth.js` ray-cast synthetic court frames with a known camera
- `tools/run.mjs` detect on images and write overlays (`--map` shows line pixels); `tools/batch.mjs` the same on all cores with a results.json; `tools/synth_eval.mjs` accuracy sweep; `tools/make_video.mjs` synthetic clip
- `bun test` (14: service boxes to camera, tin height, camera maths, model, distance map, detection and tracking on synthetic frames); `node smoke.js` (headless Chromium through the real UI and worker: demo frame pose, click to metres, export, a tracked video clip)

## Limits

Assumes a standard singles court and a principal point at the image centre. Painted lines must be visible; a frame showing one wall and a sliver of floor is ambiguous. On show courts the side-wall out line rarely matches the WSF slope exactly, so it weighs least. Tracking a camera that zooms in slowly drifts along the zoom / distance valley at 480 px (on the synthetic clip: within 3 cm for 2 s, then up to metres once only the front wall and short line are in view); tracking at full resolution would hold it but costs 4×.

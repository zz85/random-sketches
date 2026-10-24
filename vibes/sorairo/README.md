# Sorairo 空色

An anime / Makoto Shinkai-style hillside rendered in three.js: a lone tree dropping leaves or petals, wind-blown grass, towering cumulus, birds and contrails, and a painterly post-process. Open `index.html` from any static server (three.js comes from unpkg via an import map).

Drag to orbit, scroll to zoom. **H** hides the panel, **P** saves a PNG, **M** toggles sound.

Two time-lapse animations are in the Animate folder: a **day cycle** (noon, afternoon, golden hour, magic hour, night) and **four seasons** (a year on the hill, from snow through cherry blossom, summer and the autumn turn to bare branches and snow again). A third, **time zoom**, starts at your real clock and date in real time, then speeds up through a few whole days and nights to month-by-month seasons. Try `?anim=day`, `?anim=year` or `?anim=zoom`.

## How it works

About 1,900 lines of plain ES modules on three.js 0.160, with no build step and no npm dependencies. three.js supplies the renderer, buffers, render targets and `UnrealBloomPass`. Everything visible is a custom `ShaderMaterial`, and all textures, geometry and noise are generated in code.

| File | |
|---|---|
| `main.js` | scene assembly, time-of-day keyframes, shadow pass, fly-over scheduling, lil-gui panel, camera shots |
| `glsl.js` | shared uniforms and GLSL: noise, wind, cel lighting, shadow lookup, cloud shadows, aerial perspective |
| `sky.js` | sky dome: gradient, sun/moon, stars, horizon cumulus towers, overhead cumulus, cirrus, contrail |
| `world.js` | terrain height function, dirt path, mountain ranges, utility poles and wires |
| `tree.js` | branch skeleton and tubes, leaf-cluster cards, canopy gaps, falling leaves / petals |
| `grass.js` | instanced grass blades and wildflowers |
| `birds.js` | instanced flock |
| `post.js` | light shafts, bloom, flare, tone map and grade, anisotropic Kuwahara, canvas finish |
| `smoke.js` | headless render test |

### Shared lighting

`glsl.js` defines one set of uniforms (sun direction and colour, ambient, fog, wind, shadow map, cloud cover). Every material spreads that set in by reference, so when the time-of-day slider changes a value once per frame, everything updates together. All materials call the same GLSL helpers:

- `celLight`: the main source of the anime look. A two-tone light model with a narrow, slightly soft terminator; shadows are filled with a blue-violet ambient instead of being darkened toward black.
- `windBend` / `gustAt`: a wind field of gusts that roll across the scene in the wind direction.
- `cloudShadowAt`: scrolling noise that darkens ground, tree and poles as cloud shadows pass.
- `applyFog`: haze that turns sun-coloured looking toward the sun and sky-coloured looking away. This is what fades the mountains.

### Sky (`sky.js`)

One large sphere, computed entirely in its fragment shader.

- **Base:** zenith-to-horizon gradient, sun or moon disc with glow, stars.
- **Horizon towers:** a height profile along the horizon gives each column a top, noise inside that shape gives density, and a low-frequency shape field decides the lit side so light falls across large masses rather than speckling.
- **Overhead:** a cumulus layer and cirrus streaks on the dome.
- **Contrail:** the plane flies a great circle. The shader takes the angle from the plane back along that circle as the age of each part of the trail; age drives width, drift, where the two engine trails merge, fraying and fade.
- **Alpha:** the sky writes how open it is to the sun into alpha, with clouds lowering it. The light-shaft pass reads it, so clouds block shafts the same way the tree does.

### Terrain and props (`world.js`)

- `heightAt(x, z)` is one JS function (layered noise plus a hill under the tree). It builds the terrain mesh and also places every grass blade, pole and the tree base.
- The dirt path follows a Catmull-Rom curve. `pathDist` measures distance to it, using a grid so each lookup only checks nearby segments; that distance blends ground to dirt and clears grass off the path.
- Two rings of mountain ridges at different distances get different amounts of fog.
- 14 utility poles along the path, with wires sagging in a catenary.

### Tree (`tree.js`)

- **Branches:** recursive growth with random wander and bending (up for main limbs, out and down for smaller ones). Children sprout slightly below the parent's tip so joints look grown. Branches become tubes merged into one mesh.
- **Foliage:** about 1,450 camera-facing leaf-cluster cards, textured with leaf shapes drawn on a canvas, 4 variants in a 2×2 atlas. Each card's normal blends the direction out from its cluster with the direction out from the whole canopy, so the cel lighting shades the canopy as a few big soft volumes, like a painter's blocked-in masses, rather than thousands of flat cards.
- **Canopy gaps (`airy`):** two 3D noise fields remove cards. A coarse one (about 5 m) cuts holes through the canopy, a fine one makes each pad's outline lobed. Pad centres are protected so every branch tip keeps leaves. The branch growth draws the same random numbers at every setting, so the slider changes only the leaves.
- **Autumn colours:** the `autumn` style gives each card one of six colours (green, light green, yellow, orange, orange-red, brown) in turning order. The `turned` slider (0 early … 1 late autumn) moves the canopy through them: at 0 it is mostly green with a few yellow tips, at 0.5 (default) an even mix weighted to yellow, orange and red, at 1 mostly orange-red (about half the canopy) with orange and brown and almost no green. A card's stage comes from noise at its clump's centre, so leaves turn a pad at a time, with slight bias for the top and outside, per-card scatter and about 10% stray leaves. Moving the slider only shifts the thresholds, so a pad that is orange at 0.5 is further along at 1, never a different colour at random. Stage thresholds are taken from quantiles so each colour keeps its share of the canopy on any seed. Shadow sides are a deep version of each leaf's colour; falling leaves use only the turned colours. `maple` is the older all-orange style.
- **Falling leaves / petals:** 420 instances the CPU never updates. Each leaf's position is a function of time and its seed: spawn point, fall, flutter, spin, wind drift, landing and fade. Most start in the canopy; about 30% are drifters crossing the view from upwind.

### Grass (`grass.js`)

- 170,000 instances of one 5-segment tapered strip, scattered over the terrain and kept off the path.
- The vertex shader bends each blade quadratically by the shared gust field, shortening it as it bends so its length stays about the same.
- Normals are partly flattened toward the ground normal so the field shades as one surface. Tips glow when backlit, and a brighter sheen travels where gusts press blades flat, giving the rolling wave. Wildflowers are a second instanced set.

### Birds (`birds.js`)

- About 11 instances of a 10-vertex V silhouette in a loose formation with stragglers. A per-vertex wing weight makes the tips move most; glides happen when a slow noise crosses a threshold.
- At the start of each cycle the CPU picks a new line of flight from wherever the camera faces, so a flock always crosses the view.

### Shadows

One sun-aimed depth map, 2048² (1024² on mobile). Only the tree and poles cast; everything else is hidden for that pass. A mesh can swap in a cheaper material for the shadow pass, which is how leaf cards cast cut-out leaf shadows. Receivers use 3×3 PCF.

### Post-processing (`post.js`)

Passes are wired by hand rather than through `EffectComposer`, because some read more than one earlier image.

1. **Scene** to a half-float target with 4× MSAA; alpha holds the sky's sun-occlusion mask.
2. **Light shafts:** 40 jittered, decaying samples marched toward the sun's screen position. Only open sky near the sun contributes, so shafts pour through gaps in the canopy and clouds.
3. **Bloom:** `UnrealBloomPass` on the shaft output.
4. **Grade:** lens-flare ghosts and an anamorphic streak scaled by sun visibility (9 taps of the mask), then a brightness-only tone map, lift, gain, saturation and sRGB. Mapping only brightness keeps oranges and magentas saturated where a normal tone map would wash them toward white.
5. **Anisotropic Kuwahara** (after Kyprianidis et al. 2009), three passes:
   - the structure tensor measures local edge direction;
   - a 13-tap separable Gaussian smooths it;
   - each pixel averages 8 overlapping sectors of an ellipse stretched along the edge with polynomial weights, the lowest-variance sector counting most.

   Areas flatten into brush-stroke patches that follow contours and keep edges crisp: the gouache / oil-paint look. Radius scales with pixel ratio; off by default on mobile.
6. **Finish:** slight chromatic fringe, edge darkening like pooled paint, procedural canvas weave, vignette, grain.

### Animations (`seasons.js`, `snow.js`)

Both run a `progress` value from 0 to 1 over a loop length (50 s for a day, 80 s for a year by default) and loop. Playing either one speeds the clouds up 30× (the *cloud speed-up* slider) on their own clock, `uCloudT`, so the sky races like a time-lapse while grass and leaves still move in real time.

- **Camera drift** (*camera drift* slider, `drift`, 0 = off, 1 default): while either animation plays, the camera moves like a motion-control slider shot, swinging about 23° around the tree and back over two loops, with a slight push in and rise on slower, offset cycles so the path doesn't repeat exactly. The motion is applied as frame-to-frame increments, so it carries on from wherever you leave the view, and it pauses while you drag and for 2 s after. *Slow orbit* overrides it.
- **Time zoom** (`journey.js`): a 44 s ramp of the time rate (simulated seconds per real second), eased in log steps, then held: 6 s of real time, up to one day every 8 s (the sun moves, clouds speed up), one day every 3 s (about four whole days and nights by 30 s), then one month every 4 s. A clock at the top left shows the date, time and speed. The state is a function of the real seconds since the start (the simulated time is the integral of the rate), so the progress slider and `?p=` jump straight to any point.
  - The hour drives the time-of-day slider once round the clock: night from 20:00 to 04:00, the moon sets, dawn about 05:25, morning about 06:50, noon, afternoon, golden hour, magic hour. The sun swings across the sky from east to west (the moon stays put, so the swing fades out through the night).
  - Past about one day per second the days lock to one hour (*time zoom: hour kept*, `lock`, 15:00 by default), like a time-lapse shot at the same time every day. The lock tightens gradually: each day lingers near that hour and rushes through the rest, so the nights shrink to a blink and vanish. From then on each day gets its own cloud cover and light, as in four seasons.
  - The date sets the season (northern hemisphere): blossom about 1 April, summer in early July, late autumn at the end of October, first snow in mid December. *Start time zoom from now* restarts it from the current clock.
- **Day cycle** sweeps the time-of-day slider from noon to night over 90% of the loop, holds the night, and fades through dark back to noon.
- **Four seasons**: `sampleSeason(s)` maps the day of the year to everything seasonal. s = 0 is deep winter, so the loop opens with the thaw. Each "day" also gets its own cloud cover and light level, for the flicker of a time-lapse shot at the same hour every day.
  - Snow melts in patches (`snowAt`, shared by the ground, grass and flowers: hollows hold it longest) and the mountain snow line climbs back up.
  - The bare tree blossoms pink with the petal atlas (cards come back in reverse shedding order), drops petals, then leafs out spring green and deepens to summer green.
  - Grass greens up, wildflowers come and go, and the ground turns gold in autumn and straw in winter.
  - Autumn runs the `turned` slider from 0 to 1, then the canopy sheds: each card has a drop rank (`iDrop`, its order by turn, so the most turned fall first) and shrinks away as `uBare` passes it, while the falling leaves thicken (`uFallDensity` thins them without retiming).
  - A fan of forking twigs on every branch tip, hidden by leaves the rest of the year, gives the bare crown its shape, and snow settles on the tops of the limbs.
  - Snow falls from a camera-centred box of stateless points, the ground buries most grass blades and leaves straw tips poking out, winter skies are cloudier and a little greyer, and the birds and insects go quiet.

### Time of day and runtime

- Seven keyframes round the clock (noon, afternoon, golden hour, magic hour, night, dawn, morning) set sun height, sky and cloud colours, fog colour and density, ambient, bloom and grade. One slider blends neighbouring keyframes and wraps from morning back to noon. Dawn is not magic hour backwards: a cool lilac sky over a pastel peach horizon, rose cloud edges, the last stars and low mist, then a crisp, cooler morning as the mist burns off. The higurashi call at dusk and again at dawn.
- Pixel ratio is capped at 1.5 (1.25 on mobile) and drops automatically below about 40 fps.

### Sound (`audio.js`)

Everything is synthesised with Web Audio; there are no sample files. Browsers only allow audio after a gesture, so it starts from the ♪ button, the M key or the Sound folder (`?sound=1` starts it on the first click or key press anywhere). Music and ambience each have a volume slider.

- **Ambience** follows the scene. Wind is looped pink noise in two bands (a low body and a bandpass whistle that rises with gusts), scaled by the `wind` setting, with a high-passed leaf rustle in gusts. Songbirds (short pitch-swept whistles) call by day, and more often when the flock crosses. A far low rumble comes in with the contrail. Higurashi cicadas give their falling evening call from golden hour to magic hour, and three crickets chirp at night.
- **Music** is a slow generative piano over a detuned-saw pad at 64 bpm in D major, on the royal-road progression (IVmaj7, V, iii7, vi) that anime soundtracks lean on, then ii7, V7, I. The melody is a random walk on the pentatonic scale that lands on chord tones on the beat. At night it drops an octave, plays fewer notes and the pad darkens. Everything goes through a generated stereo hall reverb and a soft limiter.

## URL parameters

`time` (0 noon, 1 afternoon, 2 golden, 3 magic hour, 4 night, 5 dawn, 6 morning, 7 noon), `az` sun azimuth, `style` (summer, sakura, autumn, maple), `shot` (hillside, under, wide, path, sky), `paint` (Kuwahara radius, 0 = off), `wind`, `windDir`, `clouds`, `towers`, `leaves`, `seed`, `airy` (canopy gaps, 0 dense … 1 airy), `turned` (autumn progress, 0 early … 1 late), `anim` (day, year), `dur` (seconds per loop), `p` (start point, 0 … 1), `play=0`, `season` (a fixed day of the year, 0 … 1, paused), `lapse` (cloud speed-up), `hour` (time zoom start hour, default now; with `season` it sets the start date), `lock` (time zoom hour kept), `clock=1` (show the clock with `noui`), `drift` (camera drift, 0 off … 2), `sound=1`, `music` and `ambience` (volumes, 0 … 1), `birds=0`, `contrail=0`, `orbit=1`, `noui`, `pr` (pixel-ratio scale), `still=1` + `t` (render one frame at a fixed time and set `window.__ready`).

## Test

`node smoke.js` has no dependencies. It starts a static server and headless Chromium with SwiftShader, drives it over the Chrome DevTools Protocol directly, and renders 20 still shots (including dawn, morning, mid-day-cycle, blossom, shedding, winter and two time-zoom frames), checks that all three animations play live without errors and that the camera drifts, then renders the sound graph offline for day, dusk and night (failing on silence, NaN or clipping) and checks that the ♪ button starts live audio without errors. A shot fails on any console or shader error, an exception, or a nearly flat frame (pixel read-back, brightness standard deviation). Shots are written to `shot_*.png` (git-ignored); the server sends `no-store` so they always reflect the current code. `ONLY=afternoon,night` runs a subset.

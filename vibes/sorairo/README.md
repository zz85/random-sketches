# Sorairo 空色

An anime / Makoto Shinkai-style hillside rendered in three.js: a lone tree with falling leaves, wind-blown grass, towering cumulus and a painterly post-process. Open `index.html` from any static server (three.js comes from unpkg via an import map).

Drag to orbit, scroll to zoom. **H** hides the panel, **P** saves a PNG.

## What's in it

| File | |
|---|---|
| `main.js` | scene assembly, time-of-day keyframes, tree shadow pass, lil-gui panel, camera shots |
| `sky.js` | sky dome: gradient, sun/moon, stars, horizon cumulus towers, overhead cumulus, cirrus. Alpha = sun occlusion for the light shafts |
| `world.js` | terrain height function (shared with grass placement), dirt path, mountain ranges, utility poles and wires |
| `tree.js` | recursive branch tubes, leaf-cluster billboards with sphere normals, stateless falling leaves / petals |
| `grass.js` | instanced blades bent by a travelling gust field, wildflowers |
| `post.js` | light shafts, bloom, flare, tone map + grade, anisotropic Kuwahara, canvas / vignette / grain |
| `glsl.js` | shared GLSL: noise, wind, cel lighting, shadow lookup, cloud shadows, aerial perspective |

## URL parameters

`time` (0 noon … 4 night), `az` sun azimuth, `style` (summer, sakura, autumn), `shot` (hillside, under, wide, path, sky), `paint` (Kuwahara radius, 0 = off), `wind`, `clouds`, `seed`, `orbit=1`, `noui`, `still` + `t` (render one frame at a fixed time).

## Test

`node smoke.js` renders each shot headless (SwiftShader), fails on shader/console errors or a blank frame, and writes `shot_*.png`.

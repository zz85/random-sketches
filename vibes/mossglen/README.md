# Mossglen

A moss-covered Scottish glen in three.js: a recumbent stone circle on a knoll above a peaty burn, old oaks with buttress roots, boulders and a fallen bough, ferns and rushes, under four kinds of Scottish light. Moss grows over all of it on a front you can scrub through, and you can paint it on or scrape it off by hand. Press **✦ new glen** (or `n`) to sink this glen into the mere and conjure another: a new seed rolls the hills, the knoll, the burn's course, how lumpy the ground is and where the stones and oaks stand, the land rises from the stone circle outward on a glowing front, and the moss floods in over a few seconds. Open `index.html` from any static server (three.js comes from unpkg via an import map), for example `python3 -m http.server` in `vibes/` and then `/mossglen/`. It installs as a PWA and works offline after the first visit.

![](shot_glen.png)

## Using it

- **Play / Growth**: the moss creeps out from the burn banks over the wet ground, over the hummocks, then up the stones and the trunks. Play runs it over about 20 s; the slider scrubs it.
- **look / grow / scrape**: in *grow*, a stroke plants moss that swells up, matures (darker, deeper, with nodding capsules on stalks) and creeps outward through good habitat. *scrape* strips it back to bare schist, soil or bark. The slider sets the brush size.
- Mouse: the left button paints (orbits in *look*), the right button orbits, and the wheel zooms. Touch: one finger paints, two fingers orbit and pinch.
- **Glen** panel: Cover (how far up the poorer ground and the stones the moss can reach), Lush (cushion depth), Wet (darker, glossier moss), light (Morning mist, Soft day, Golden evening, Gloaming, blended between), wind, creep distance, wisps.
- Keys: `1` `2` `3` mode, space play, `[` `]` brush size, `h` hide the UI.

URL options: `?seed=123` for a given glen, `?q=0|1|2` quality (phone, laptop, desktop; phones default to 0), `?grow=0.6`, `?cover=0.8`, `?lush=1`, `?wet=0.5`, `?light=2.5`, `?cam=x,y,z,tx,ty,tz`, `?nowisps`, `?pause`.

## How it works

- `world.js`: the height field, shaped by a seed (`setTerrainSeed`; seed 5 is the hand-tuned glen), (knoll, hills, hummocks and the burn's channel), the warped-grid ground, the water (peaty, flowing normals, Fresnel sky, foam), the ring of hills and the sky dome with drifting cloud.
- `props.js`: stones are icospheres eroded by noise and cut by bevelled fracture planes; oaks are recursive tubes with buttress roots that return the spots their leaves hang from.
- `growth.js`: every mossable vertex (ground, stone, bark) gets a habitat (moisture by the burn, shade under the oaks, patch noise, upward faces, the foot of trunks) and an arrival time: a Dijkstra shortest path over the mesh from seeds on the banks, dearer through poor habitat, up props and uphill. A vertex is mossy once Growth passes its arrival time and Cover admits its habitat, so the front follows water and shade the way real moss does. Painting is per-vertex state (painted, scraped, maturity) in an RGBA8 texture the shaders read with `texelFetch`; painted moss creeps to neighbours over the mesh's adjacency.
- `moss.js`: the surface shader puts soil, lichened schist or bark under a ragged moss edge, with cushions (domes on a jittered grid) for colour, relief and occlusion. Shells (instanced layers of the same mesh) give the pile; they thin out with distance and are cut inside each cushion's dome, so cushions part with dark seams. Sporophytes (setae with nodding capsules) stand on mature moss near the camera, never thinner than half a pixel.
- `flora.js`: ferns whose fiddleheads unroll as the moss arrives, rushes, oak-leaf cards (alpha to coverage under MSAA), motes in the light and will-o'-the-wisps that light the moss in the gloaming.
- `post.js`: an MSAA half-float scene target, light shafts at half resolution from the sky behind the canopy, two-level bloom, then exposure, ACES, saturation, a cool shade / warm light split, vignette and grain.
- `glsl.js`: shared uniforms and GLSL: noise, wrap and translucent lighting, PCF sun shadow, height fog with sun scatter, the moss state.

Performance: three quality tiers (terrain and prop detail, shell layers and distance, sporophyte, fern and leaf counts, shadow size and taps, MSAA, wisp lights), an adaptive render scale between 0.5 and 1 that holds 60 fps (30 on phones), a shadow map rendered only when the light changes, and one draw call each for ground, stones and every kind of foliage. WebGL2 GLSL rather than TSL, so it runs on phones without WebGPU.

## Test

`node smoke.js` (zero deps, Playwright's Chromium with SwiftShader) checks that it loads without shader errors, renders, that coverage rises with Growth and Cover, that stones moss after the wet ground, that paint grows and creeps and scrape strips it, and that the phone tier renders. `ONLY=shots node smoke.js` just writes the `shot_*.png` screenshots. It is slow (several minutes) on a software renderer.

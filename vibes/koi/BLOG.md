# Koi: a pond of painted fish and ink in water

Koi is a three.js sketch of a koi pond seen from above, made to leave open on a phone. It has three styles: realistic, watercolour and ink. All three share the same fish and the same water simulation and differ only in how the result is drawn. It is plain ES modules with no build step and no dependencies beyond three.js.

## The koi

Each fish is a fixed mesh in its rest pose that the vertex shader bends along a moving spine. The CPU only moves 16 spine points per fish.

**The model.** The body is a lofted tube of 52 rings with 24 points around each. Three profile functions of the position along the body, `s`, set its width from above, the height of its back and the depth of its belly. Each rises with a quarter-ellipse, peaks about a third of the way back, tapers, and closes with a cap at the tail root. The fins are six small grids in one mesh: paired pectorals and pelvics, a dorsal strip, and a forked tail tilted so it shows from above. Butterfly koi get pectorals 1.85× longer and a tail twice as long.

**The spine.** Point 0 is the head. Every later point follows the one in front at a fixed spacing, like a chain dragged along a path, with each bend limited to 0.2 rad and relaxing back toward straight. The body therefore follows the path the head took, and in a turn the tail traces the same curve.

**Bending in the shader.** For each vertex, the shader interpolates a Catmull-Rom curve through the nearest spine points to get a centre and a forward direction. It then adds a swimming wave, `amp · env(s) · sin(phase − 5.4·s)`, where `env` keeps the head still and grows toward the tail, so the wave travels from head to tail. The wave's derivative tilts the frame, so cross sections stay square to the bent body. Fins add their own lagged motion on top: the dorsal trails the body's sway, the tail's trailing edge lags further, and the paired fins fold in, spread out and paddle. The shadow pass reuses the same vertex code.

**Patterns.** The red and black markings are two 3D noise fields evaluated at the fragment's rest-pose position and thresholded, so they bend and move with the body. Twelve varieties are table entries: colours, thresholds, whether black stays on the back or wraps the body, red on the head, the darkness of the net pattern of scale edges, and metallic sheen. Asagi and tancho get special cases for the blue back and the single red spot. Overlapping scale rows, eyes and nostrils are placed by position on the rest body.

**Behaviour.** Each fish adds up steering wishes: wander, look ahead to avoid walls, keep clear of fish at a similar depth, and loosely line up with neighbours. Touch adds pellets to chase, a held finger that calls fish over, and ripples they shy away from. They swim by beat and glide: below 90% of target speed a fish beats its tail and accelerates, and above 112% it glides with the tail nearly still. Tail frequency follows speed and amplitude follows thrust. The pectorals are folded when gliding, spread to brake when slow, and the one on the inside of a turn spreads further. This rhythm does more than anything else to make the fish read as koi rather than generic fish.

## The realistic water

The realistic style is one full-screen pass that traces each pixel through the moving surface, plus a caustic pass, a shadow pass and a tone-mapping pass.

**The surface.** The surface is never stored as a height map. Its slope is computed analytically wherever it's needed:

- a long, low swell, and short wind waves 16–35 cm long with capillary-gravity dispersion (`ω = √(gk + σk³/ρ)`, at half speed for calm), stronger in drifting patches where a breath of wind touches the water;
- up to 24 touch ripples, each a ring-shaped wave packet that spreads, widens and fades;
- standing waves across the pond when the phone is tilted or shaken.

**Refraction.** The view ray meets the surface plane, bends through the surface normal (`refract`, n = 1.333), and hits the bottom 1.1 m down. The pebble bottom is generated once into a texture with mipmaps: rounded stones in a jittered grid, seven kinds of rock, silt between them, baked light on the domes and dark crevices. Users can switch it to a sky-blue pool or a dark liner.

**Caustics.** These are simulated every frame on the GPU from the same wave and ripple slopes. For each texel of the bottom, the pass finds where its sunlight crossed the surface, stepping back along the sun direction and correcting for the bend. It then takes the light's concentration as `1 / det(J)`, where J is the Jacobian of the surface-to-bottom map, built from the Hessian of the surface height. Where the waves focus light, the determinant shrinks and the bottom brightens. That gives the moving net of bright lines without tracing any photons.

**Light under water.** `underLight` combines four things:

- sun dimmed by Beer-Lambert absorption down the water column, with red lost first;
- dappled shade from a swaying maple canopy, as drifting noise;
- the caustic net;
- blurred shadows of the fish, pads and leaves, from a shadow map rendered along the sun direction;

plus blue ambient sky light. On the way back up, `waterPath` absorbs the colour again along the view path and adds the light the water scatters back, so deep water turns green-blue and murky.

**Fish under water.** The fish are rendered normally into their own target. The composite then shifts where it reads that target by the screen distance between where the bent ray and the straight ray reach the fish's depth. The fish wobble and shift under the ripples just as the bottom does, without being rendered once per ray.

**The surface on top.** The canopy and sky reflect with a Fresnel weight (Schlick, 2% at normal incidence), so the reflection is faint looking straight down and strong at grazing angles in the 2.5D and orbit cameras. The sun adds two specular lobes, a sharp glint and a soft sheen, with the glint moved by phone tilt. A final pass applies a vignette, ACES tone mapping at exposure 1.25, gamma and dither.

## Ink in water

The reference for ink mode was CCTV's "Ink" commercial (Weareflink / Troublemakers, 2010): animals in dense, dark brushwork at the head that dissolve into smoke behind. Ink mode keeps two separate clocks.

- **Keyframes at 8 fps.** The fish, pads and petals are rendered as pigment onto a white target only 8 times a second by default, and the fps button can drop it to 4, 2, 1, ½ or ¼. Between keyframes the painting holds still.
- **Ink simulation every frame.** A density field of ink is advected, diffused and faded at the display rate, so the smoke keeps moving while the fish jump between poses.

**The field.** One channel of density in ping-pong targets: half-float where available, otherwise 8-bit storing a quarter of the density. One pass per frame:

1. **Velocity**, added up analytically with no pressure solve: a slow pond current from the curl of drifting noise; a little drag along each fish's body; a jet behind each tail, flicked left and right with each beat, plus swirls shed by the tail that alternate direction; curl noise confined to each fish's wake; and the push from touch ripples.
2. **Semi-Lagrangian advection**: each pixel looks up where its ink came from.
3. **Diffusion** toward the four neighbours, with small noise eddies that fray thin edges into wisps.
4. **Fade** that is faster for dense ink and faster near a fish that is swimming hard. A beating fish's trail clears in about a second, and a gliding fish's lingers.

Every source is either a curl or a local jet, so the flow is close to divergence-free and needs no projection step. On a phone that is the difference between one pass and a dozen.

**Shedding, not copying.** Stamping keyframes straight in left a sharp ghost of every fish, and within seconds the pond was marbled with black bands. The stamp is now read from a blurred mip level and laid down at 45% strength. The fish push the water gently and mostly control how fast their ink fades, so a trail still shows how the fish swam without being thrown across the pond.

**Drawing it.** The current keyframe goes on top, read slightly blurred and wobbled by noise of about 2 pixels, with a softer copy behind it like ink bleeding into damp paper. Where the density changes steeply, the edges of wisps darken a little. Density becomes colour through a per-channel absorption that leaves thin ink a cool blue-grey and thick ink a warm, purplish black. All of it sits on cold-pressed paper: noise bumps and fibres lit from the top left, with ink settling darker in the hollows.

## Cost

- **Realistic:** a fish pass, a shadow pass, one caustic pass and one composite pass. The bottom is generated once.
- **Ink:** a simulation pass and a display pass at about 0.72 of device resolution, each looping over at most 12 fish. The scene geometry is only drawn on keyframes.
- **All styles:** an adaptive render scale lowers resolution when frames run long.

## What I'd do next

- Spread each keyframe's ink along the path the tail swept since the last keyframe, so trails become ribbons instead of a row of beads.
- Let the wake run longer so the curls have room to develop.
- Run the ink simulation at half resolution on slow phones.

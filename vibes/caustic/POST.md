# Caustic: lighting the Wallace sets with light off water

The Wallace building in *Blade Runner 2049* is lit almost entirely by moving reflections of water: thin bright lines crawling down a planked corridor, broad gold ribbons over Wallace's concrete office, fine ripples on the walls of a flooded hall. This sketch rebuilds those three sets in three.js r187 with WebGPU and TSL, and copies how they were lit rather than simulating the physics. It lives in [vibes/caustic](./).

![The corridor](shot_corridor.jpg)

## How the film did it

Roger Deakins didn't add the ripples in post. His crew built shallow troughs of water on the set and aimed big tungsten lamps into them (eight 10K Fresnels with custom barn doors, by his own forum and the production write-ups), so the reflections off the moving water landed on the walls. That gives a plan that is cheap on a GPU:

1. make the light pattern a rippling surface throws (a caustic) as a texture;
2. project it from a lamp, the way a slide projector would, with shadows;
3. let the room's materials, bounce light, haze and the lens do the rest.

## The caustic texture

`caustics.js` draws a caustic into a square half-float render target each frame. The water is a sum of 12 travelling sine waves. Their wave vectors are whole numbers of cycles across the square, so the pattern tiles, and a lamp can repeat it across its beam with no seams.

To find where the light goes, a fine grid mesh covering the square is drawn with each vertex moved by `depth * grad(h)`: for small slopes that's where a ray reflected or refracted at that point lands on a wall `depth` away. In the fragment shader, the light per area is the grid cell's area before the move over its area after it, both taken from screen-space derivatives (`dFdx`, `dFdy` of the old and new positions). Where neighbouring rays cross, the cell shrinks to almost nothing, the ratio spikes, and you get the bright lines. Additive blending sums overlapping folds. The mean stays 1, since light is only moved around, so a lamp's intensity is its average brightness. The mesh is drawn three times, for red, green and blue, at depths 4% apart, which gives the slight colour fringe real caustics have.

Each set has its own water, so its own look:

| set | waves (cycles per tile) | depth | speed | look |
|---|---|---|---|---|
| corridor | 2 to 9, one direction | 0.075 | 0.55 | thin, sharp lines sloshing one way |
| office | 2 to 6, and 1 to 4 for the skylight | 0.06, 0.1 | 0.4, 0.35 | broad, slow ribbons |
| hall | 5 to 16, every direction | 0.05 | 0.6 | a fine net of ripples |

`depth` is the focus. Short and the lines are soft; long and they sharpen, then break up into a busy net as rays cross more than once.

## One concrete

The walls, floors and frames of all three sets are one material, `rough()` in `materials.js`: board-formed concrete. A height field is built from broad fractal blotches, a fine sandy grit, small air pits from Worley noise and faint horizontal formwork streaks. The same field darkens the colour where it is low and goes through `bumpMap` into the normal, so a raking caustic catches the grain: the lines break up a little over the grit, as they do on the set. Tall panel seams are cut in the same way. Only the hall's deck is still wood.

## Projecting it

In r187 a `SpotLight` takes a `colorNode`: a TSL function from the point's coordinate in the light's projection (its shadow matrix) to a colour. Each "Fresnel" is a spot light whose `colorNode` samples the caustic texture at that coordinate, turned, repeated 2 to 4.5 times and drifting slowly, so two lamps off the same water don't show the same pattern. Because it's a real light with a shadow map, the portal frames, roof beams, desk and chairs cut shadows into the ripples, which is most of what makes it read as the film.

## Global illumination

The real sets glow because the amber light bounces off wood and concrete. Two cheap parts stand in for that:

- **One virtual light per beam.** Where each beam lands, a dim, unshadowed point light sits just off the surface, in the beam's colour times the surface's, carrying a few percent of the beam's power. This is instant radiosity cut down to one bounce and one light. It warms the ceiling, the floor and the shadow sides, and it costs almost nothing, so phones keep it.
- **SSGI with TRAA.** On desktop, three's `ssgi` node runs on a scene pass that also writes albedo, normals and velocity (MRT). It's composited as `beauty * AO + albedo * GI`, then temporal reprojection AA (`traa`) averages away its noise over frames, and antialiases too. The GI button turns it off.

## The hanging light

The hall's light is a thin glowing disc on a long cable, so from the shore it reads as the ellipse in the film. It hangs from a pivot 13 m up and swings as a pendulum: two slow sines, 7.2 s and 9.1 s, of 3.4 and 2.3 degrees, so its path wanders. The spot light that throws the pool of light onto the platform hangs from the same pivot and aims at a fixed point, so the pool and the chairs' shadows sway with it, and the disc's reflection slides over the black water.

## Haze, water and the lens

- **Haze**: a `VolumeNodeMaterial` box raymarched at half resolution, lit by the same projected spot lights, so each beam carries its ripples through the air. A Bayer dither per frame hides the step pattern, and the volume goes through a bloom mip chain as a blur before it's added. It has to stay faint: at the first setting tried, the haze washed every set out to beige.
- **The hall's water**: a `reflector()` with its UVs pushed around by noise and a near-black base, so the walls and the slit come back broken up. Its first version was too strong; the reflection of the lit walls filled the lower frame, where the film keeps the water black.
- **The lens**: ACES tone mapping, bloom, a horizontal anamorphic streak made from 25 taps of the bloom texture, a little lateral colour at the edges, vignette, grain, 2.39:1 bars.

## Where the orange comes from

The gold comes from four places, and they stack:

1. **The lamps**: every caustic spot light is the same gold, `0xffb840` (or `0xffc050` for the skylight and the hanging light), as tungsten through warm gels is.
2. **The materials**: all three sets share one rough concrete, a neutral warm grey (`0x76694e`), so the walls don't add a colour of their own.
3. **The bounce lights**: their colour is lamp times surface.
4. **The grade**, last and strongest: each pixel is pulled toward its luminance times a gold tint, `mix(tint * luma * 2.2, colour, sat)`, with a toe that sinks the shadows. All three sets share one grade: tint 1.0 / 0.70 / 0.14 with sat 0.28, so only 28% of the scene's own colour survives.

The first version gave each set its own lamp colour, material and grade, and the corridor was the most orange on all four counts: oiled wood that is orange-brown itself, lamps at `0xffa53a` (the most orange), a tint whose green was lowest (0.62) and wood-coloured bounce lights. Against the three film stills, which are all the same gold, that read as a different film. Now `scenes.js` holds one `GOLD`, one `GRADE` and one `CONCRETE` for all three, and the sets differ only in their water and their geometry.

The Tune panel's **Warmth** slider moves the grade's tint toward grey (same luminance) and the lamps toward white, and past 1 makes it more orange still. **Colour** sets how much of the scene's own colour survives the grade.

![Warmth 0.25, choppier water](shot_tune.jpg)

## Touching the water

The texture is made fresh each frame from the wave sum, so disturbing the water just adds terms to it. A splash is a ring-shaped wave packet: 14 cycles per tile, running out at 0.18 tiles per second of water time, widening and dying away over a few seconds. Distances are taken across the tile's wrap, so it tiles too. Eight can be in flight at once. Only the slope enters the caustic, so each splash adds `dh/dr * d/r` to the gradient.

Tapping a wall puts a splash where you touched: the tap is raycast into the set, the hit point goes through each caustic lamp's shadow matrix (the same projection the light uses), then through the lamp's turn, repeat and drift, which gives the spot on the water tile that lights that point. A tap on a dark spot, or the hall's floor, stirs the water at random. The Splash button and `s` do that too.

The other water controls scale the set's own values: **Ripple size** (the tile's repeat across each beam), **Sharpness** (the depth, so the focus), **Wave height** (the slope amplitude: calm to choppy) and **Water speed** (the water's own clock, so it slows smoothly instead of jumping).

## Sound

Two separate things. **Sound** is a drone: detuned saws a fifth apart through a slowly breathing low-pass, a sub, and brown noise lapping, with a root per set.

**Music** is a slow cyberpunk score in D minor at 84 bpm, all synthesised in Web Audio. It aims for the CS-80 feel of the Blade Runner scores: pads of three detuned saws per note whose filter opens over two bars, a resonant square bass pulsing in sixteenths, an eighth-note triangle arpeggio through a dotted-eighth ping-pong delay, a slow saw-and-square lead, and a drum machine with a big gated snare into a long hall. The kick ducks everything else, so it breathes with the beat. Notes are scheduled on the audio clock 150 ms ahead from a 25 ms timer, so a busy GPU frame doesn't make it stumble. It builds over 16 bars: pads and a sparse bass, then drums, then the arpeggio, then the lead.

## Testing

`node smoke.js` drives headless Chrome over CDP, with no dependencies. It renders every shot of every set, checks that each caustic texture is lit and has lines (mean near 1, high variance, bright peaks), that a splash changes the texture, that a tap on a lit wall lands in a beam, that Warmth 0 really drains the amber, and that four bars of the score render offline (`OfflineAudioContext`) with sound in them.

One snag: SwiftShader's software WebGPU loses its device on the haze pass, since every step of the raymarch samples several shadowed, projected lights. Any one of the haze, the projection or the shadows alone is fine. So the test runs the full look on WebGL 2 and WebGPU without the haze, and the page reloads with `?novol` if a real GPU ever loses its device. It hasn't been tried on real GPUs or phones yet.

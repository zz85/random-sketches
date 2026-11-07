# Orrery

Codevember 2026, theme *Orrery*. It has two modes.

- **Miniature** is a celestial wristwatch after Patek Philippe's Celestial. The dial is a lapis enamel sky chart printed in gold that turns once a sidereal day, under a smoked sapphire that leaves clear the sky above your horizon. The Sun, Moon and planets are set as jewels at their true places, and the hands tell local time. The flange works as a compass: with motion on, the chart turns so its directions are the real ones. The head sits in a cradle held by the lugs, with pivots at 12 and 6, as a reversible case does. Turn it over (the pusher above the crown, or `o`) and it spins left to right in the cradle to show an orrery under the display caseback: Earth on a centre arbor, turned by sidereal time with a pin at your place, and the Moon, Sun and planets on gold arms at their true ecliptic longitudes, over a dial with the zodiac and the Sun's calendar for the year. The centre button (`c`) moves the Sun to the centre and the planets to their true heliocentric places, with Earth and the Moon on Earth's orbit; the arms slide between the two layouts.
- **Immersive** is a planetarium you hold up to the sky. Planets are drawn 2000 times closer than they are, so they show as globes, and the Sun and Moon 12 and 17 times larger. Every direction is exact.

Drag the face sideways to turn the watch round its own axis, about the point under your finger, and up or down to zoom (the watch lies back as you come closer, like one on a table you lean over); on the back, double-tap the body at the centre to switch between Earth-centred and Sun-centred; drag anywhere else to move the camera round the watch, as three.js orbit controls do, kept in front of the face so it never goes behind (a flick coasts, a double tap brings it back). Drag the crown up or down to wind it and set the time. Pinch, or scroll, brings it closer; with the back showing, zooming on past that flies into the orrery onto Earth, and two fingers moving together orbit round it as you go. Let go once Earth fills the view and you land in Immersive; let go earlier and it eases back out. The Immersive button runs the same dive on its own, in about five seconds. The camera comes down into the orrery on a log scale, so the approach slows as Earth grows, and swings from the watch's angle to the angle of the sky view. The pin shrinks away as you reach it, the works fade, the globes shrink to the sizes the sky view draws, and the real sky fades in behind them, rendered from the same camera, so you end standing on your pin with every arm pointing at its body overhead. Coming back runs it in reverse.

three.js r187 `WebGPURenderer`, WebGPU where the browser has it and WebGL 2 otherwise. Every material is TSL. Open `index.html` from any static server (for example `python3 -m http.server` in `vibes/`, then `/orrery/`). It installs as a PWA and works offline after the first visit.

## Using it

- **Mode** (top right, `m`): Miniature or Immersive.
- **Turn over** (the pusher above the crown, `o`): the sky chart on the front, the orrery on the back.
- **Look round the watch** by dragging (on the face, up and down zooms); **wind the crown** (drag it up or down) to set the time. Pinch or scroll to zoom, and on the back zoom on into the orrery. **Centre** (`c`): Earth or the Sun at the middle of the orrery.
- **Tap** a body for its card: constellation, altitude and azimuth, RA and Dec, distance and light time, magnitude, how much is lit, rise, transit and set. In Immersive the view turns to it; going into Immersive with a body selected looks at it.
- **Drag** to look around in Immersive. **Pinch** or the wheel zooms the view; in Miniature, pinch or the wheel brings the watch closer.
- **Motion** (`g`): the camera follows the phone, with north from the compass corrected to true north by the World Magnetic Model (`geomag.js`). In Miniature the watch tilts with the phone so the light runs over the metal.
- **Names** (`l`): off, Sun, Moon and planets, or everything with the bright stars and constellations.
- **Magnify** (`z`, Immersive): true sizes or brought closer.
- **Location** (pin icon): your position from the browser; without it, the last place used, or Seattle.
- **Time**: Now (`n`), slower and faster (`[` `]`, from −30 days/s to +30 days/s), pause (space), the arrow keys step an hour (a day with shift), and the tape at the bottom drags and flings through time by hour, day, month or year.
- `h` hides the UI. Page zoom is locked so pinches always reach the sketch.

URL options: `?mode=sky`, `?face=orrery` (start on the back), `?centre=sun`, `?lat=..&lon=..`, `?t=2026-10-29T07:00:00Z`, `?yaw=..&pitch=..&fov=..` (degrees), `?labels=0|1|2`, `?mag=1`, `?select=Moon`, `?webgl` (forces WebGL 2), `?pr=1` (fixed pixel ratio).

## How it works

- `astro.js`: [Astronomy Engine](https://github.com/cosinekitty/astronomy) (MIT). Each frame it builds the rotation from J2000 equatorial to the local horizon (x east, y up, −z north) and each body's topocentric direction, distance, size, IAU pole and prime meridian, and its direction to the Sun.
- `sky.js`: the dome's TSL sky colour (night enamel, a Rayleigh-like day gradient with a Mie halo, twilight bands and the Belt of Venus), the Milky Way in galactic coordinates, 5,000 stars (d3-celestial, BSD-3) sized in pixels by magnitude, gold constellation figures, the horizon and a gold ecliptic with degree ticks.
- `planets.js`: the globes of the immersive sky, each lit from its true Sun direction, so phases and bright limbs are real, with a little of the sky's colour in front of them by day. Saturn's rings take the planet's shadow.
- `watch.js`: the Miniature watch. The chart is a polar azimuthal-equidistant projection on the visible pole, printed to canvas textures (enamel and a gold mask). Platinum case and lugs, a leather strap, and a fake crystal reflection.
- `orrery.js`: the orrery on the back. The dial is the ecliptic seen from the north, the equinox at twelve o'clock. Arm radii are only an order (Ptolemy's), so each globe is lit from the real Sun direction turned into the dial's frame, not from the little Sun on the dial. Each globe rides at its true ecliptic longitude, with its latitude as height above the arm plane, so seen from Earth's centre every body is in its true direction. That is what lets the dive end on the real sky.
- `main.js`: the two cameras and the dive between them (during the dive the sky is rendered from the watch camera's direction and blended in on an overlay canvas), input, the time tape, cards, and post-processing (bloom, vignette, grain). The pixel ratio adapts to hold the frame rate.

## Checking it

`node smoke.js` loads it in headless Chromium and checks for console and shader errors and for frames that aren't blank (night, the Moon, Jupiter and Saturn close up, day, and Miniature). Screenshots go to `/tmp/orrery-shots`, never into the repo. It uses lavapipe (Mesa's software Vulkan through ANGLE) when it finds it and SwiftShader otherwise, on the WebGL 2 backend: headless screenshots of a WebGPU canvas come out blank, so the WebGPU path needs a real browser.

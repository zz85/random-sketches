# CarPlay Gravity

A CarPlay-style car screen where every piece is a rigid body, after mrdoob's Google Gravity. The
screen loads in its normal layout and after 1.6 s it all falls. The pieces stay live while they
tumble: clocks tick, the map keeps driving, play / pause / skip work and the gauges move.

- **Layouts**: Home (sidebar + 10 app tiles, labels fall separately), Dashboard (navigation map,
  Now Playing, Up Next, weather) and Cluster (speedometer and tachometer as rolling circles,
  gear, turn signals, a mini map, warning lamps, odometer).
- **Gravity**: Down (the dial or the arrow keys point it anywhere), Tilt (the device's
  accelerometer, mapped through the screen orientation; asks for permission on iOS), Drive (the
  simulated car's turns push everything sideways, plus road rumble and the odd pothole), Zero-G
  (no gravity, bouncy). Strength 0–3 g.
- **Hands**: drag and throw any piece. In the still layout you can pull one piece out; the rest
  stay put until something hits them hard enough to knock them loose. A tap still works as a tap
  (Maps / Music open the dashboard, the sidebar button switches Home / Dashboard, other tiles hop).
- **Restore** springs everything back into the layout; **Shake** throws it all around.
- Keys: `G` drop / restore, `S` shake, arrows point gravity, `D` drive, `Z` zero-g, `T` tilt, `1`–`3` layouts.
- URL: `?layout=dash|cluster`, `?mode=drive|zero|tilt`, `?still` (no automatic drop), `?seed=` (route).

The drive: an endless made-up street grid, a route that turns at corners, a speed profile that
brakes for the bends (2.6 m/s² lateral limit), and the lateral acceleration v²κ that Drive mode
applies to the screen. The turn banner, ETA, signals and gauges all read from it (`nav.js`).

Physics (`physics.js`, no dependencies): oriented boxes and circles, Box2D Lite's box-box
clipping, sequential impulses with warm starting, friction, restitution on new contacts only,
a soft mouse joint, and pinned bodies that a hard hit sets free. Pieces are DOM elements moved
with CSS transforms; their bodies are measured from the live layout (and re-measured on resize).

Tests: `node --test` (physics: resting, an 8-box stack, rolling, knock-loose, dragging) and
`node smoke.js` (headless Chromium over CDP: each layout drawn where its bodies are, drop and
settle, drag, restore, taps, knock-loose, drive sway, zero-g, no console errors).

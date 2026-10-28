# CarPlay Gravity

A CarPlay-style car screen where every piece is a rigid body, after mrdoob's Google Gravity. The
screen loads in its normal layout and falls after 5 s, or at the first touch. The pieces stay live while they
tumble: clocks tick, the map keeps driving, play / pause / skip work and the gauges move.

- **Looks like CarPlay in iOS 26 / 27**: the floating glass sidebar (clock, signal, recent apps,
  the Dashboard / app-grid button), squircle app icons with a lit glass rim in the Default or Dark
  appearance, labels on glass chips, page dots, a layered "Celosia"-style wallpaper (Indigo, Rose,
  Teal) or the blue Ocean sweep. The icons and wallpapers are drawn from scratch in canvas code,
  not Apple's artwork.
- **The sidebar falls too**: its glass pill is a piece like the rest. The clock, recent apps and
  buttons start inside it and pass through it until they have come apart once (`world.ignorePair`),
  then they collide normally. The pill is tipped over its foot when it drops, since a 70 × 468 bar
  would otherwise just stand there.
- **Appearance**: Dark or Light (light wallpapers, glass and maps), and icons in Default, Dark or
  Clear (tinted glass with the glyph cut out of it).
- **Liquid Glass blur**: every glass piece (sidebar, chips, cards, Clear icons, the options sheet)
  blurs and saturates what is under it, drawn on the canvas with `ctx.filter`. A piece at rest
  blurs the backdrop under it once, cut to its outline, and reuses that; a piece in flight blurs
  the live frame (four per frame at most), because reading the canvas back is the slow part. No
  refraction or lensing at the rim, only blur, tint and a lit edge.
- **Double-tap cracks the glass**: a spider-web of wandering cracks with rings, shards and a
  frosted bruise, and the shock knocks nearby pieces loose. Restore mends it.
- **Layouts**: Widgets (iOS 26's widget page: calendar on the left, four Home accessory tiles
  that toggle), Home (the app grid in CarPlay's default order: 4 columns on 800 × 480, 5 on wide
  screens; labels fall separately), Dashboard (map with the arrival pill, glass cards for the next
  turn, Now Playing and Up Next) and Cluster (speedometer and tachometer as rolling circles, gear,
  turn signals, a mini map, warning lamps, odometer).
- **Dashboard map**: an Apple Maps-style driving view in perspective, the camera behind and above
  the car: arterials, parks, extruded buildings, the route as a ribbon on the road (and faintly
  through buildings), street labels on the ground, fog to the horizon, the blue puck.
- **Options sheet** on the canvas itself: the ⤓ button in the sidebar (top right on the
  Cluster), the Settings app, or `M`. Screen, gravity mode, strength, appearance, icon style,
  wallpaper, a direction dial, Shake and Drop / Restore. The scene keeps running, frosted, behind it.
  Screen, appearance, icons, wallpaper and strength are remembered.
- **Gravity**: Down (the dial or the arrow keys point it anywhere), Tilt (the device's
  accelerometer, mapped through the screen orientation; asks for permission on iOS), Drive (the
  simulated car's turns push everything sideways, plus road rumble and the odd pothole), Zero-G
  (no gravity, bouncy). Strength 0–3 g, 1.5 g by default.
- **Hands**: drag and throw any piece. In the still layout you can pull one piece out; the rest
  stay put until something hits them hard enough to knock them loose. A tap still works as a tap
  (Maps / Music open the dashboard, the sidebar button switches Home / Dashboard, other tiles hop).
- **Restore** springs everything back into the layout; **Shake** throws it all around.
- Keys: `M` options, `G` drop / restore, `S` shake, arrows point gravity, `D` drive, `Z` zero-g, `T` tilt, `1`–`4` layouts.
- URL: `?layout=widgets|home|dash|cluster`, `?appearance=light`, `?mode=drive|zero|tilt`, `?wallpaper=indigo|rose|teal|ocean`, `?icons=dark|clear`, `?menu`, `?still` (no automatic drop), `?seed=` (route).

The drive: an endless made-up street grid, a route that turns at corners, a speed profile that
brakes for the bends (2.6 m/s² lateral limit), and the lateral acceleration v²κ that Drive mode
applies to the screen. The turn banner, ETA, signals and gauges all read from it (`nav.js`).

Type: the canvas asks for `-apple-system` (SF Pro on Apple devices), then Helvetica, Helvetica
Neue, Arial. SF can't be bundled (Apple's licence), so elsewhere it is Helvetica or a clone of it
(Nimbus Sans on most Linux).

Made for an 800 × 480 head unit: the screen is laid out in logical pixels with the height fixed
at 480 (a wider screen gets more width, a narrower one is scaled down) and scaled to the device.
On a screen under 600 px tall or 860 px wide the bezel goes and the canvas fills the screen.

Rendering is one canvas (`app.js`). Each piece is a spec with a centre, a size and a `draw(ctx)`
in its own coordinates, plus tap regions for its buttons. Pieces that only change now and then
(tiles, labels, clock, Now Playing) are cached as bitmaps keyed on what they show and drawn with
the body's transform; the two maps (into their own canvases at 30 fps) and the gauges (dial face
cached, needle and arc live) are drawn every frame. Taps hit-test through each body's rotation.
About 1.6 ms of CPU a frame in headless Chromium at rest (the 3D map is most of it).

Physics (`physics.js`, no dependencies): oriented boxes and circles, Box2D Lite's box-box
clipping, sequential impulses with warm starting, friction, restitution on new contacts only,
a soft mouse joint, and pinned bodies that a hard hit sets free.

Tests: `node --test` (physics: resting, an 8-box stack, rolling, knock-loose, dragging) and
`node smoke.js` (headless Chromium over CDP, at 800 × 480 and 1280 × 800: each layout fits with no overlaps, first touch / 5 s start, drop and
settle, double-tap crack, drag, restore, taps, knock-loose, drive sway, zero-g, the options sheet (appearance, icons), frame cost, no console errors).

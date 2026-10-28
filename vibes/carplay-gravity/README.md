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
- **Double-tap cracks the glass**: three to nine long cracks from the point in uneven directions,
  nearly straight with small kinks, forks and short dead-end hairlines, a crushed spot with a
  partial ring where it hit. The cracks run out from the impact over half a second, with a glint
  on the running tips. Drawn as a WebGL2 pass over the finished frame (`fx.js`): each wedge of
  glass between two cracks shifts and turns the picture under it as one piece, a little lighter or
  darker as it tilts (the idea from [ksenia-k's broken glass pen](https://codepen.io/ksenia-k/pen/abegNPO);
  no code from it), the crack edges split it into colours and
  catch the light from the top left, and the panel bleeds: dark ink spreading from the impact
  with fingers along the cracks, an oily rainbow round it, sometimes a faint stuck pixel column.
  **Cracks** in the sheet (0.25× to 3×, default 1.8×, `?cracks=`) sets how many cracks, how far
  they run, how far the wedges move and how hard the shock is. The shock knocks nearby pieces loose. Restore mends it. Without WebGL2 (or after a lost
  context) the cracks are drawn in 2D instead. The crack shapes follow the notes on broken-glass
  optics in [kossik/cracked-glass](https://github.com/kossik/cracked-glass); no code from it.
- **Liquid ripples** (off by default; Ripples On in the sheet or `?ripples=on`): a touch sends a wave ring
  across the screen that bends and shades the picture, dragging leaves a wake, Shake and a crack
  splash harder. The pass is off when nothing is cracked or rippling, and then
  gives back its GPU memory (the GL canvas and its textures shrink to 1 × 1); the crack maps are
  drawn at most 1.5 px per logical px.
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
- URL: `?layout=widgets|home|dash|cluster`, `?appearance=light`, `?mode=drive|zero|tilt`, `?wallpaper=indigo|rose|teal|ocean`, `?icons=dark|clear`, `?ripples=on`, `?cracks=0.25..3`, `?menu`, `?still` (no automatic drop), `?seed=` (route).

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
About 1.7 ms of CPU a frame in headless Chromium at rest (the 3D map is most of it); with a
crack or ripples on, the frame is uploaded to the GPU and redrawn, about 5.5 ms in SwiftShader.

Physics (`physics.js`, no dependencies): oriented boxes and circles, Box2D Lite's box-box
clipping, sequential impulses with warm starting, friction, restitution on new contacts only,
a soft mouse joint, and pinned bodies that a hard hit sets free.

Tests: `node --test` (physics: resting, an 8-box stack, rolling, knock-loose, dragging) and
`node smoke.js` (headless Chromium over CDP, at 800 × 480 and 1280 × 800: each layout fits with no overlaps, first touch / 5 s start, drop and
settle, double-tap crack, the WebGL pass and ripples, drag, restore, taps, knock-loose, drive sway, zero-g, the options sheet (appearance, icons), frame cost, no console errors).

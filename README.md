# Random experiments

- [SailNav](vibes/sailnav/) - Browser chart plotter for Puget Sound: official NOAA ENC charts (S-52 day/night), charted depth + tide under the boat from GPS, automatic draft-aware water routing between two points, XTE/BRG/TTG navigation, MOB, GPX, offline mode that parses NOAA S-57 cells in the browser, installable PWA. Navigation math ported from OpenCPN
- [West Point Buoy](vibes/buoy-data/) - Fast, rich dashboard for NOAA NDBC station WPOW1 (and other Puget Sound stations): 10-min wind + gusts, forecast overlay, wind rose, pressure, tide, marine forecast
- [Estate AR](vibes/estate-ar/) - Camera-passthrough AR that labels the buildings you point at with the county's assessed value, use, zoning and recent sales. Parcel polygons from King County, Snohomish County, Los Angeles County (comps-based market estimate where Prop 13 makes assessed values meaningless) and the WA statewide parcel layer (public ArcGIS, CORS, no keys, no backend); per-unit values and rent estimates for apartment buildings from assessor unit records and Zillow ZIP indices, GPS + compass + tilt for placement, terrain elevation and fused GPS altitude so hillsides and high-rise floors project correctly, labels on rooftops via OSM or value-density height estimates, ground-plane parcel outlines, radar mini-map, installable PWA with offline parcel cache
- [Marine AR](vibes/marine-ar/) - Camera-passthrough AR for the water: charted traffic separation lanes, zones and precautionary areas drawn on the sea surface with direction arrows (NOAA ENC Direct, CORS), AIS vessels pinned in AR with name/type/speed/course/size, hull outlines, 6-min vectors, CPA/TCPA. Live AIS worldwide from OpenSeaFeed (keyless WebSocket) or Digitraffic (Finland), no backend; optional aisstream.io proxy; simulated traffic as fallback. Radar mini-map, true horizon for eye height
- [StaffInk](vibes/staffink/) - Handwritten music notation: write notes, chords, accidentals, rests, clefs, time signatures, triplets, dynamics and hairpins on the staff with a stylus, finger or mouse and they become engraved SMuFL notation (Bravura/Petaluma). Tiny MLP trained on the HOMUS dataset (94% writer-independent, 99% top-3), structural note parsing for pitch/chords, gestures for beams, ties, slurs and scribble-erase, alternatives strip that learns your handwriting ($P templates), grand staff, playback, MusicXML/MIDI/PNG export, offline installable PWA
- [Night Sky AR](vibes/night-sky/) - AR camera overlay that identifies stars, planets, and the Moon by pointing your phone at the sky
- [BrainWave - Neural Audio Engine](vibes/brain-waves/) - Brainwave entrainment app with binaural beats, study/focus modes, and procedural ambient music
- [CPU/Numa Affinity planner / visualizer](cpu-affinity-planner/)
- [moon fraction](cosmos/moonfraction.html) - Visualization of moon in it's different phases
- [sun path ar 2d](cosmos/sunpath_three_ar_2d.html) - Heads up display using AR passthrough style
  - [sun path AR](cosmos/sunpath_three_ar.html) - AR visualization of sun path with three.js
  - [sun day path](cosmos/sunpath_three.html) - Sun's visualization path of the day
  - [sun year path](cosmos/sunpath_three_year.html) - Sun's visualization path of the year
- [sun charts](cosmos/suncharts.html) - JS based sunrise and sunset tables and visualizations
- [tide predictor](cosmos/tides.html) - Harmonic tide prediction in the browser (Schureman / NOS method) from NOAA constituents, with tide clock, hi/lo table, spring/neap envelope, constituent decomposition and phasor view. Engine in [tides.js](cosmos/tides.js), validated against NOAA in [test_tides.js](cosmos/test_tides.js)
- [compass](cosmos/compass.html) - Web based implementation of IOS compass app
  - [compass with positioning](cosmos/compass_position.html) - with positioning data
  - [compass with sun position](cosmos/compass_sun.html) - with sunrise and sunset
  - [compass with sun position true north](cosmos/compass_sun_north.html) - with true north
- [protrait_effect](protrait_effect) - experiments to render the bokeh (aka Protrait on ios) effect with tensorflow.js and three.js
- [fishy-sketches](fishy-sketches) - drawing fishes with bezier curves in 2d

Nodejs experiments
- [Terminal Mirror](term-mirror/README.md) - terminal sharing/mirror in the browser
- [fullbody-quest](fullbody-quest) - Poor man's fullbody for Meta quest 2
- [streaming-server](streaming-server) - Simple scaffolding for real-time web applications without websockets.


#### History / Notes

See [Changelog](CHANGELOG.md)
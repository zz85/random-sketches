# Random experiments

- [SailNav](vibes/sailnav/) - Browser chart plotter for Puget Sound: official NOAA ENC charts (S-52 day/night), charted depth + tide under the boat from GPS, automatic draft-aware water routing between two points, XTE/BRG/TTG navigation, MOB, GPX, offline mode that parses NOAA S-57 cells in the browser. Navigation math ported from OpenCPN
- [West Point Buoy](vibes/buoy-data/) - Fast, rich dashboard for NOAA NDBC station WPOW1 (and other Puget Sound stations): 10-min wind + gusts, forecast overlay, wind rose, pressure, tide, marine forecast
- [Estate AR](vibes/estate-ar/) - Camera-passthrough AR that labels the buildings you point at with the county's assessed value, use, zoning and recent sales. King County parcel polygons from the assessor's public ArcGIS server (CORS, no keys, no backend), GPS + compass + tilt for placement, ground-plane parcel outlines, radar mini-map
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
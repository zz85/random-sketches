# Logs

26 Sep 2026
- Add [Marine AR](vibes/marine-ar/) - AR vessel finder built on the estate-ar pattern. Surveyed live AIS sources reachable from a browser: Digitraffic (Finland) is the only public CORS REST feed; aisstream.io is worldwide but bans browser connections so `proxy.js` re-serves it in Digitraffic's shape; US live AIS (NAIS / MarineCadastre) is not public. Lanes come from NOAA ENC Direct TSSLPT/TSEZNE/PRCARE/TSSBND/FAIRWY layers (harbour + coastal, verified CORS). Pinhole camera with roll, near-plane clipping so lanes you stand in still draw, curvature-dropped sea surface, true horizon dip, hull footprints from A/B/C/D, dead reckoning, CPA/TCPA. `bun test` with captured fixtures + headless Chromium smoke render.
- Marine AR land occlusion: ENC Direct LNDARE polygons (server-generalised via `maxAllowableOffset`), 2D sight-line vs shoreline test per vessel at 2 Hz. Ships behind a headland render dimmed/dashed with distance to the blocking shore; lane labels behind land are dropped. Viewer standing on land is handled by skipping the first crossing of the ring that contains them.
- Marine AR elevation-aware occlusion + AtoN: LNDELV spot heights attached to land rings, sight line from eye height vs land height vs estimated ship air draught with curvature; a lighthouse on the shore is no longer hidden by its own shore. Buoys, beacons, daymarks and lights from ENC Direct pinned in AR with S-52-ish glyphs and IHO light characters (Fl R 2.5s 5M), tap for details. Smoke test rewritten over the DevTools protocol (fixed settle instead of network idle, reads page state).

26 Sep 2026
- Add [Estate AR](vibes/estate-ar/) - property price AR viewer. Surveyed sources callable from a static page: King County's `KingCo_PropertyInfo` ArcGIS MapServer answers point+distance queries with WGS84 polygons, appraised land/improvement values and a 3-year sales layer, all with CORS; Nominatim for place names. `geo.js` does centroid/angular-span/point-in-polygon and a pinhole projection from (bearing, pitch); Android Euler angles are rotated to the back-camera direction so any phone orientation works. Labels, ground-plane outlines when tilted down, radar, detail sheet with sales history and assessor links, simulated mode for desktop. `bun test` (33) on a captured live fixture + live smoke test.
- Estate AR: Snohomish County provider (`pds_prop_report` MapServer, market land/impr values) and the WA State Parcels Project layer on DNR's server as the fallback for Pierce and every other WA county (values match King County's own service exactly; DOR land-use codes decoded). Labels moved to rooftops: building height from OSM `height`/`building:levels` via Overpass (CORS works from a browser; 37/134 buildings mapped in the U-District), else estimated from use class + improvement value per ft² of lot (log fit through $60→1, $1000→6, $8500→24 storeys; reproduces the Brooklyn Ave skyline). Dashed roof outlines + corner verticals. PWA: manifest, icons, service worker (shell cache-first, data network-first with fallback), IndexedDB parcel store with fetched-coverage circles so revisited streets work with no signal. Verified offline reload in headless Chromium. 48 tests.
- Estate AR: radar and a settings-sheet mini-map show the offline coverage union (wash + exact boundary from `unionArcs`, which computes the uncovered arc intervals per circle — canvas `destination-out` tricks left antialiasing ghosts) and amber dotted circles for pending downloads; "Precache around me" with a slider, request estimate and a hex-lattice planner (`planPrecache`, tested gap-free) that skips already-covered circles and runs two requests at a time; 0.5 mi of the U-District = 19 requests, ~3k parcels, 5 MB, ~2 s. Service worker shell strategy changed to stale-while-revalidate so edits reach installed copies. 53 tests.
- Estate AR: coverage wash drawn on the ground plane in the camera view (circles clipped to the view wedge with Sutherland–Hodgman before projecting, near-plane vertices pinned to the screen bottom, union boundary stroked as a line on the pavement); auto-precache ahead along the GPS course (`Track` needs 30 m over 90 s, `planAhead` lays a 3-lane corridor of fetch circles, `allowAuto` gates on navigator.connection type / saveData with Off / Wi-Fi / Any), sharing one download runner with the manual button. 59 tests.
- Estate AR: optimisation pass. Bandwidth: server-side generalisation (`maxAllowableOffset` 0.5 m, 52→18 KB gzipped per circle), paging in dense cores, Overpass skipped when heights are already known, rolling 24 h data meter with a daily budget gating auto-precache. CPU: rings converted once to a metric frame and decimated, planar `parcelViewXY` replaces per-vertex haversine, 30 fps cap with change detection, radar footprints on a cached offscreen bitmap, union arcs cached — main thread 0% idle → 96% idle still / 74% turning with 740 parcels. Battery: 720p camera, sensors and camera suspended when hidden, low-battery mode via Battery API. Large commercial: stacked condo/air-rights parcels merged into one label with summed value and a units list, wide parcels anchor the label where you are looking, county-server outage falls back to the statewide layer (Snohomish went down mid-session). 68 tests.
- Estate AR: per-unit economics for large buildings. King County's nightly Apartment Complex + Unit Breakdown extracts (no CORS, 9,170 buildings) and the WA rows of Zillow Research's ZORI/ZHVI ZIP CSVs are folded by `fetch_data.js` into two small bundled JSONs; `market.js` gives assessed value per unit, $/ft² living, unit mix, year built, ZIP typical rent/condo/home with 1y change, and an estimated rent per unit (ZIP rent × size^0.6 × age factor) with gross yield. Assessor storey counts now override the height estimate. "Per unit" price mode. The detail sheet states what assessed value is (1 Jan assessment-year estimate, not last sale). 76 tests.
- Estate AR: Los Angeles County provider (Calabasas beta tester). Parcels from the county's hosted layer with roll values, Prop 13 base years, living ft², beds/baths, units and year built; recorded sales from the assessor's PAIS layer. Because Prop 13 pins assessed value to the purchase price, California defaults to a comps-based market estimate (median $/ft² of nearby 4-year sales × living area, with IQR) and the sheet explains the base year. Zillow ZIP indices now bundled per state (WA, CA); rent estimate for single homes; `?sim=calabasas`. 81 tests.
- Estate AR: elevation. `terrain.js` looks up ground elevation per parcel (Open-Meteo, 100/call) and under the viewer (USGS 3DEP), cached on a 30 m grid, so hillside lots sit at their real height; GPS altitude is geoid-corrected, ground-subtracted and fused across fixes weighted by altitudeAccuracy, trusted only under 12 m uncertainty ("~floor 25 ±1" in the chip), with a manual Floor override in settings. From a high-rise the street grid now drops below the horizon instead of every label sitting 30° too high. `?sim=…&floor=24` / `&alt=166`. 87 tests.
- Add [SailNav](vibes/sailnav/) - studied OpenCPN (s52cnsy DEPARE01 banding, georef Mercator sailing, Routeman XTE/arrival) and built a browser plotter on NOAA ENC Online tiles + ENC Direct DEPARE/SOUNDG queries. Depth-under-boat with tide correction, grid A* water routing respecting draft, shore margin and charted hazards. `bun test` + live NOAA smoke test.
- SailNav offline: `s57.js` reads ISO 8211 / S-57 `.000` cells directly in the browser (DecompressionStream unzip, DataView parsing, IndexedDB store); vector S-52 chart, depth and routing without network. Verified identical to ENC Direct on US5SEAGK. Bundled 62 central Puget Sound cells (4.9 MB) in `vibes/sailnav/charts/` with auto-load around the boat; `fetch_charts.js` refreshes them. Vendored Leaflet + service worker + manifest: whole app runs offline after first load (verified with network disabled in headless Chromium).

26 Sep 2026
- Add [West Point Buoy](vibes/buoy-data/) - single-file dashboard replacing the NDBC station page: NDBC 10-min wind/gust via tiny CORS proxy (NWS hourly fallback), NWS hourly forecast dashed onto the wind chart, pressure/temp, CO-OPS tide, parsed coastal waters forecast with advisories, wind rose histogram for the selected range (click a sector to filter the chart by direction), diurnal hour×day heatmap, side-by-side station compare overlay
- Add [tide predictor](cosmos/tides.html) - harmonic tide prediction in plain JS. [tides.js](cosmos/tides.js) is a port of the Schureman SP-98 constituent definitions (following pytides and XTide's congen_input.txt), fed by NOAA CO-OPS harmonic constituents. Visualizations: height curve with daylight bands and NOAA overlay, tide clock, hi/lo table, ±45 day spring/neap envelope with moon phases, constituent bars, decomposition of the top constituents, animated phasor sum.
- [test_tides.js](cosmos/test_tides.js) validates against NOAA official predictions for 8 stations: height rmse 0.006-0.11 ft, hi/lo timing mean error under 1 minute. Gotcha found: NOAA's M1 uses Schureman's second formula (V = T - s + h + 90, u = xi - nu + Q) with the speed of the first (14.4966939 deg/h).
- Research notes: surveyed pytides, UTide, pyTMD, PyFES/aviso-fes, hatyan, slackwater (ex-neaps, TS) and its station database, solunar. Picked pytides/congen as the reference for a small browser port; slackwater is the best maintained JS option if a dependency is acceptable.

17 Feb 2026
- Add [BrainWave - Neural Audio Engine](vibes/brain-waves/) - Web Audio app for brainwave entrainment with binaural beats, isochronic tones, and 9 study/focus mode presets
- Procedural ambient music engine with 10 generative styles (ambient pads, piano, space drone, singing bowls, lo-fi, arpeggios, dark pad, cinematic lo-fi, cinematic arpeggio, shimmer)
- Independent volume controls for master, beats, and music layers
- Real-time waveform/frequency visualizer, session timer, 6 ambient noise generators

13 Oct 2025
- Add [CPU/Numa Affinity planner / visualizer](cpu-affinity-planner/index.html)

15 Jul 2024
- Attempted to reproduce moon [fraction vis using astronomy lib](cosmos/moonfraction2.html)

14 Jul 2024
- [Testing astronomy engine lib](cosmos/test_astronomy_engine.html). Also [nodejs comparison with suncalc3](cosmos/test_astro_vs_suncalc.js).

11 Jul 2024
- [moon charts](cosmos/mooncharts.html) - strip down to basic 30 day dump. 

10 Jul 2024
- Visualization of moon across it's phases. [moonfraction](cosmos/moonfraction.html). Other WIPs [moonpath wip1](cosmos/wip_moonpath_three.html) [moonpath wip2](cosmos/wip2_moonpath_three.html)

16 March 2024
- Adding TextGeometry to three.js, including serialization/deserialization support https://github.com/mrdoob/three.js/pull/27931

11 Feb 2024
- [Terminal Mirror](term-mirror/README.md) - Mirrors a tmux session to a web interface over fetch streaming. This was interesting as an "external monitor" in passthrough mode on my quest.

![tmux mirroring pic](notes/tmux-mirroring-2024-02-18.png)
![](notes/tmux-mirroring-2024-02-18.mov)

6 Feb 2024
- Canvas version of the Starlings murmurations inspired by https://twitter.com/JulianGarnier/status/1754495444896416025 (incomplete, need to follow up on tweens)

5 Feb 2024
- Simple visualization to work out [earth, moon, and sun](cosmos/earthmoonsunsim.html) relations

2 Feb 2024
- Added [true north](cosmos/compass_sun_north.html) for compass heading, updated compass sun position to include current angle
- Integrate "AR passthrough" for [sun path ar 2d](cosmos/sunpath_three_ar_2d.html), removed WebGL renderer

1 Feb 2024
- Added [color palette test](cosmos/skycolor.html) utilizing rgb, oklab and spectral interpolation

30 Jan 2024
- [sun path ar 2d](cosmos/sunpath_three_ar_2d.html) alternative implementation of sunpath ar but rendered on 2d canvas. this uses threejs for 3d calculations but not rendering.

28 Jan 2024
* updated Sun path viz with equal altitude spacing
* Initial implementation of AR sunpath using threejs, geolocation and device motion
* [sun path ar](cosmos/sunpath_three_ar.html) for mobile and [sun path three](cosmos/sunpath_three.html) for desktop experimentations
* [sun year path](cosmos/sunpath_three_year.html) - Sun's visualization path of the year
27 Jan 2024
- exploration of AR with compass direction. [threejs device orientation test](cosmos/compass_three_ar_orient_test.html)
26 Jan 2024
- [Compass with position](cosmos/compass_position.html), compass variant that uses geolocation for coordinates and altitude. Also combined sun positioning to show [compass with sun position](cosmos/compass_sun.html)
24 Jan 2024
 - JS based generation and visualizations of [sunrise and sunset tables](cosmos/suncharts.html). Explore the use of the suncalc libaries and [geolocation](cosmos/location.html) api.
23 Jan 2024
 - A JS canvas based implementation of the IOS [Compass app](cosmos/compass.html), utilizing device orientation event and webkit compass heading. I implemented most of the UI/UX including bearing display and the dial rotation, including bubble level and direction marking. What's missing are vibration (disallowed in safari) and GPS coordinates and some subtle animations. One improvement I have over Apple's implementation
  is that tapping the screen not only marks the change in direction, but gives the angle difference. This
  can be useful for just measuring differences in compass bearings.
14 Jan 2024
 - combined streaming server and tracking code in handstand experiment to mirror pose tracking across the network
14 Jan 2024
 - streaming-server uses h2 and sse (server sent events) as an alternative to websockets.

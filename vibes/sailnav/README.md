# SailNav - browser chart plotter for Puget Sound

A single-page chart plotter that borrows its design from [OpenCPN](https://github.com/OpenCPN/OpenCPN)
but runs entirely in a phone browser against NOAA's public services. No server, no proxy, no build step.

Serve the folder over http(s) (geolocation and the service worker need a secure context or localhost). No CDN: Leaflet is vendored, `sw.js` precaches the app shell and caches chart zips as they load, so after one online visit the app installs to the home screen and runs with no signal.

```
cd vibes/sailnav && python3 -m http.server 8000     # http://localhost:8000
bun test                                            # unit tests (nav math, S-52 banding, router, S-57 reader)
bun live_check.js                                   # live NOAA smoke test: depth at Shilshole, route to Blake Island
```

## What it does

Works in two modes. **Online**: NOAA's ENC Online / ENC Direct ArcGIS services (CORS-enabled) supply
rendered tiles and S-57 features on demand. **Offline**: drop a NOAA ENC zip (e.g. `US5SEAGK.zip` from
charts.noaa.gov) onto the page and the browser itself unzips it (`DecompressionStream`), parses the
ISO 8211 / S-57 `.000` cell (`DataView`, ~60 ms per cell), stores the bytes in IndexedDB, and from then
on depth, routing and a vector S-52 chart all run from local data with no network. Local cells take
priority wherever they cover the position.

**Bundled charts.** `charts/` ships the 62 NOAA harbour-scale (1:12,000) cells covering central Puget
Sound from the Tacoma Narrows to Everett / Port Townsend approaches: 4.9 MB total, the largest cell
is 335 KB. NOAA's user agreement allows redistribution (the copies are just not "official" for
carriage requirements). `charts/catalog.json` lists each cell with its bbox; the app fetches the cells
around the boat (about 16, ~1.5 MB) on the first GPS fix and any others a route needs, then keeps them in
IndexedDB, so a normal day's sailing never touches NOAA's servers after the first load. Refresh with
`bun fetch_charts.js` (weekly Notice-to-Mariners updates) or add areas with `--bbox w,s,e,n --scale 5`.

- **Official NOAA ENC charts** rendered with S-52 symbology by NOAA's *ENC Online* Maritime Chart
  Service, used as a tile source. The safety contour follows your draft + clearance, depth units
  follow the units toggle, and NIGHT switches the whole chart to the S-52 night palette.
- **Charted depth under the boat** (the hero readout). Queries NOAA *ENC Direct* for the S-57
  `DEPARE` depth area (DRVAL1/DRVAL2) and nearest `SOUNDG` at your GPS position, then adds the
  current tide height from the nearest CO-OPS station so you get depth *now*, not just MLLW.
  Coloured red / amber / green against your required depth. Tap anywhere on the chart for the
  same readout at that point.
- **Automatic water routing** between two points ("Google Maps for boats"). The ENC depth areas,
  dredged areas, land, rocks, wrecks and obstructions for the area are rasterised into a ~40 m grid;
  anything shallower than draft + clearance is blocked (charted depth at MLLW, no tide credit), with a
  hard shore margin and a soft preference for channel centres. A* finds the path, which is then
  string-pulled into a few rhumb-line legs. In narrow water (Agate Pass, Eagle Harbor, marina entrances)
  the margin steps down automatically and the status says so.
- **Red/green lateral marks.** Mutually nearest port/starboard marks (`BOYLAT`/`BCNLAT`, side from
  `CATLAM`) become gates: walls run outward from each mark until they meet shoal water, so the route
  has to go between them. A single mark gets a wall to the shoal it guards, so the route can't pass
  inside it. This works in both directions and in both IALA regions. The leg table lists each gate
  and which side each mark is passed on (northbound into Eagle Harbor: green 3 to port, red 4 to
  starboard, i.e. red right returning). If the marks make a route impossible (for example a channel
  that shoaled after the buoys were set), it routes without them and warns. Toggle: BUOYS.
- **Bridges and overhead cables.** `BRIDGE`, `CBLOHD`, `PIPOHD` and `CONVYR` footprints whose charted
  clearance (`VERCLR`, or `VERCSA` for cables when lower) is below MAST + HEADROOM are blocked.
  Opening bridges (bascule, swing, lift: `CATBRG` 2-5, 7) are passable unless their open clearance
  `VERCOP` is too low, and are flagged "opening required". Unnamed bank sections with no clearance
  take it from the charted span they touch; anything still uncharted counts as too low. If a low
  bridge is the only way through, the router widens the search to look for a way round (around
  Bainbridge instead of under the 22.8 m Agate Pass bridge for a 24 m mast) or names the bridge.
  US charts give clearance above MHW, so headroom should cover the gap to a high tide.
- **Active navigation** with OpenCPN `Routeman` semantics: BRG/DTG/TTG, cross-track error with
  steer-left/right arrow, arrival by perpendicular crossing (not radius), auto-advance to the next
  waypoint, virtual "Begin" point at the boat when a leg is activated, Ctrl-N to skip a waypoint.
- Boat marker with 10-minute COG predictor, look-ahead follow mode, track trail, MOB with
  bearing/distance/elapsed, tide sparkline (-6h to +18h) with next high/low, GPX route export,
  draggable waypoints, STYC race marks and common Puget Sound destinations as one-tap chips,
  coordinates in decimal / D M.m / DMS / Google Maps URL.

## Files

| File | Purpose |
|---|---|
| `index.html` | The app (Leaflet 1.9 from unpkg is the only dependency) |
| `nav.js` | Port of OpenCPN `georef.cpp` / `routeman.cpp`: haversine, Mercator (rhumb) sailing, forward problem, `legProgress` (XTE, along-track, arrival, VMG, TTG), formatting, coordinate parsing |
| `chart.js` | NOAA access: ENC Online tile URLs with ECDIS `display_params`, ENC Direct feature queries with pagination, `depthAt(lat, lon)`, `fetchRoutingData(bbox)`, S-52 colour tables (from OpenCPN `chartsymbols.xml`), `DEPARE01` banding, CO-OPS tides |
| `s57.js` | ISO 8211 reader (DDR field formats, directory, binary subfields), S-57 feature assembly (nodes/edges into points, lines, rings with holes), `toRoutingData`, local `depthAt`, ZIP reader on `DecompressionStream` |
| `chartstore.js` | IndexedDB persistence of cells, merged dataset, coverage tests (`M_COVR`) |
| `router.js` | Scanline rasteriser, hazard buffers, BFS distance transform, binary-heap A*, supercover line-of-sight simplification, `route(data, from, to, opts)` |
| `lateral.test.js` | Buoy gates (both directions), single marks, fallback, narrow-water margin, bridge/cable clearance rules, real Agate Pass bridge |
| `sailnav.test.js` | `bun test` unit tests including a synthetic harbour that forces the router around an island, through a gap in a shallow bar and away from a rock |
| `s57.test.js` | Parses the real US5SEAGK cell (fetched once into /tmp) and checks geometry closure, known depths and an offline route around West Point |
| `live_check.js` | Network smoke test against NOAA |
| `fetch_charts.js` | Downloads/refreshes bundled cells from charts.noaa.gov and writes `charts/catalog.json` |
| `charts/` | 62 NOAA ENC zips (verbatim) + catalog |
| `sw.js`, `manifest.webmanifest` | Offline app shell (network-first for code, cache-first for chart zips) and PWA install metadata. Bump `VERSION` in `sw.js` when shipping changes |
| `vendor/` | Leaflet 1.9.4 (BSD-2) and icons |

## Data sources (all CORS-enabled, verified)

- `gis.charttools.noaa.gov/.../MCS/ENCOnline/.../export` - rendered ENC, Web Mercator bbox, PNG32.
  Accepts `display_params` JSON with `ColorScheme` (0 day / 1 dusk / 2 night), `SafetyContour`,
  `ShallowContour`, `DeepContour`, `SafetyDepth`, `DisplayDepthUnits` (1 m / 2 ft / 3 fm),
  `TwoDepthShades` (1 or 2), `DisplayCategory`.
- `encdirect.noaa.gov/arcgis/rest/services/encdirect/enc_harbour/MapServer` - feature layers by
  S-57 class. Layer ids used: 227 Depth_Area, 228 Dredged_Area, 233 Land_Area, 76 Sounding_point,
  33 Obstruction_point, 34 Underwater_Awash_Rock_point, 36 Wreck_point. `enc_approach` is the
  fallback (232/233/238/80/36/37/39). Depths are metres below MLLW.
- `api.tidesandcurrents.noaa.gov` - CO-OPS predictions (6-minute and hi/lo), metric, GMT.
- `charts.noaa.gov/ENCs/<CELL>.zip` - raw S-57 cells for offline use (no CORS, so the user downloads
  and drops the file). The local parser agrees with ENC Direct on 40/40 random points in US5SEAGK.

## What was taken from OpenCPN

Studied from source (`libs/s52plib/src/s52cnsy.cpp`, `model/src/georef.cpp`, `model/src/routeman.cpp`,
`gui/src/routeman_gui.cpp`, `gui/src/chcanv.cpp`, `data/s57data/chartsymbols.xml`, and the
`weather_routing_pi` plugin):

- S-52 conditional symbology: `DEPARE01` four-band depth colouring and the mariner parameters
  (shallow / safety / deep contour, safety depth); `OBSTRN04` / `WRECKS02` default depths when
  `VALSOU` is missing (used to decide whether a hazard blocks a route).
- The day / dusk / night colour tables.
- Rhumb-line legs (`DistanceBearingMercator`) rather than great circles for route math.
- `Routeman::UpdateProgress`: XTE as the normal from the boat to the leg, arrival when the
  along-track distance to the perpendicular through the waypoint is inside the arrival radius,
  negative radius = never arrive (MOB), `FindBestActivatePoint` scoring by `dist / cos(brg - cog)`.
- Own-ship conventions: COG predictor line, yellow marker on low GPS accuracy, quarter-screen
  look-ahead when following above ~2 kn.
- OpenCPN core has no automatic obstacle routing; `weather_routing_pi` uses isochrones over GSHHS
  coastlines. SailNav instead uses a depth-aware grid A*, which is simpler and fits a phone.

## Limits

Planning aid only. ENC Direct is refreshed weekly but NOAA says it is "not intended for navigation".
Soundings are point samples; the depth card prefers a sounding within 120 m, otherwise the depth
area's minimum. Routing data is capped at ~1.2M grid cells, so very long routes get coarser cells.
Routing can't go through the Ballard Locks yet (the lock chamber isn't a charted depth area), so Ship Canal and Lake Union routes fail; the bridge clearances there (Ballard 8.8 m and Fremont 4.2 m closed, Aurora 22.2 m) are parsed and checked. The depth card adds the Seattle tide everywhere, which is wrong above the locks where the water level is controlled. Tide predictions still need the network (CO-OPS); porting `cosmos/tides.js` with bundled constituents would remove that. No AIS, no wind, no currents yet (see `tidewise/PLAN.md` and `cosmos/tides.js` for harmonic tides).

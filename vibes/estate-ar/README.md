# Estate AR - property prices through the camera

Point your phone at a building and see what the county assessor thinks it is worth.
Camera passthrough, GPS, compass and tilt from the browser; parcel polygons and assessed
values from public ArcGIS servers (King County, Snohomish County, and the Washington
statewide parcel layer for Pierce and every other WA county). No API keys, no proxy, no
backend: a static page plus a few JS modules. Installable as a PWA; what you have looked at
stays available offline.

```
cd vibes/estate-ar && python3 -m http.server 8000   # http://localhost:8000 (camera/GPS need https or localhost)
bun test                                            # geometry + provider parsing against a captured live response
bun live_check.js [lat lon [radius_m]]              # live query: parcels around a point, who you are standing on
bun live_check.js --all                             # one point per provider: Seattle, Everett, Tacoma
bun fetch_data.js                                   # refresh data/ (King County apartment records, Zillow ZIP indices)
```

On a phone, serve it over https (any static host works: GitHub Pages, S3, `npx serve --ssl`),
tap **Start**, grant camera / location / motion. On desktop, **Try without sensors** puts you
in the U-District with a simulated compass: drag to look around, wheel or arrow keys to tilt.

## What you see

- **Price labels on rooftops**, colour coded by property type (blue residential, orange
  commercial, purple condo, yellow exempt, green undeveloped). Near labels show address,
  distance and use; far ones collapse to just the price. Nearest parcels win when the block
  is dense (max labels is a setting). Building height comes from OpenStreetMap where mapped
  (`height` / `building:levels` via Overpass) and otherwise is estimated from the assessor's
  improvement value per ft² of lot — see below.
- **Ground outlines and wireframe volumes**: tilt down and parcel boundaries are drawn on the
  ground plane in perspective; buildings with a height get a dashed roof outline and corner
  verticals, so you can see which lot the tower stands on.
- **"You are on"** card: the parcel your GPS position falls inside (point-in-polygon), with its value.
- **Radar** mini-map, heading-up, with the view cone, every loaded parcel footprint, and your
  GPS accuracy circle.
- **Detail sheet** on tap: total / land / improvement assessed value, $/ft² of lot, use, zoning,
  lot size, storeys and height (with its source), plat, recorded sales in the last three years
  (King County; $0 transfers flagged), and links to the assessor's record.
- **Offline**: a service worker caches the app shell, and every parcel you have fetched is kept
  in IndexedDB together with the circles that were fetched. Standing inside a fetched circle
  never hits the network; walking into a new block fetches once and merges with the cached
  neighbours. Install from the browser menu for a full-screen standalone app.
- **Precache a neighbourhood** from the settings sheet: pick a distance (0.2-2 mi), see how
  many requests it needs and what is already cached on a small coverage map, and download.
  The area is tiled with 260 m fetch circles on a hex lattice, nearest first, two requests in
  flight; the map and the radar show amber dots for what is still to come. 0.5 mi around the
  U-District is 19 requests, ~3,000 parcels, 5 MB, a couple of seconds on wifi.
- **Coverage overlay** on the radar and, when tilted down, on the ground plane in the camera
  view: a green wash over everything cached for offline use with its exact boundary drawn (arc
  segments of the circle union, `unionArcs`), so the edge of "works offline" is a line on the
  pavement ahead of you. Circles are clipped to the view wedge in the ground frame
  (Sutherland–Hodgman, `Geo.clipPolygon`) before projection so nothing behind the camera is
  ever projected. While a download runs the radar zooms out to show progress.
- **Auto-precache ahead**: while you move, the GPS track gives a course (needs 30 m of
  displacement over the last 90 s, so standing still or jitter never triggers it) and a
  corridor of fetch circles is downloaded ahead along it — three lanes wide so a turn at the
  next block is covered — before you get there. Off / Wi-Fi only / any connection; Wi-Fi mode
  reads `navigator.connection` (Chrome/Android) and never runs with Data Saver on. iOS Safari
  does not expose connection type, so there Wi-Fi mode means "not known to be cellular".
  Desktop: WASD walks the simulated position.
- **Price modes**: total assessed, land only, $/ft² lot, or last sale price.
- Settings for fetch radius, label distance, camera FOV, heading offset and magnetic declination
  (compass on Android is magnetic; Seattle is about 15°E), units, rooftop/OSM toggles,
  persisted in localStorage.

## How the AR works

Everything reduces to bearing and pitch. For each parcel `geo.js` computes the bearing and
distance to its centroid (shoelace centroid on a local tangent plane), the nearest vertex, and
the angular span the polygon subtends from where you stand. `DeviceOrientationEvent` gives the
camera direction: on iOS `webkitCompassHeading` is already a true-ish heading; on Android the
alpha/beta/gamma Euler angles are rotated into the earth frame to get the back camera's azimuth
and elevation (so it works in any phone orientation). A pinhole projection with the configured
horizontal FOV maps (bearing, pitch) to screen pixels; labels float 5.5 m above the parcel
centroid, ground outlines sit at -1.6 m (eye height). Heading is low-pass filtered on the circle
so it never spins the long way round north.

There is no visual tracking or SLAM: accuracy is GPS accuracy (a few metres) plus compass
accuracy (5-15°). That is fine for "which building is that" at 30-200 m and hopeless for the
house next door; the heading offset slider is there for the compass.

### Building heights

`heights.js`. OSM is the truth where someone has mapped it (37 of 134 buildings in the
U-District test area). Everywhere else, the height is estimated from data the assessor already
supplies: the use class puts a floor and ceiling on storeys (single family 1-3, 4-plex 2-4,
retail 1-6, apartment/office/hotel 1-45, parking and vacant land 0), and improvement value
per ft² of lot picks a point in between on a log curve fitted through three King County
anchors: $60/ft² ≈ 1 storey house, $1,000/ft² ≈ 6-storey walk-up, $8,500/ft² ≈ 24-storey
tower. On the Brooklyn Ave test block it puts The Standard at 24, Hub U District at 21, the
Graduate Hotel at 9 (actually 8) and the walk-ups at 5-6 — good enough to put a label near
the roof line rather than at street level. It is an estimate and the detail sheet says so.

## What the prices are

The label shows the county's **assessed value** (land + improvements): the assessor's mass-appraisal
estimate of market value as of 1 January of the assessment year, set once a year for taxation. It
is not the last sale price and not a live listing estimate; it typically runs a year behind and
below the market. The "Sale" price mode (King County) shows the last recorded transaction instead.
Snohomish's `TAX_YEAR` is shown when present; the WA statewide layer carries the county's file date.

## Apartments, condos and rents

For large residential buildings the total is not very meaningful, so the app adds a per-unit view:

- **King County apartment buildings.** The assessor publishes nightly extracts of every apartment
  complex (units, average unit ft², storeys, year built, elevator) and its unit breakdown (bedroom
  mix). `fetch_data.js` folds these into `data/kc_apartments.json` (430 KB, 9,170 buildings, keyed
  by PIN), loaded lazily when you are in King County. From it: **assessed value per unit**,
  **$/ft² of living area**, unit mix, year built. The storey count also replaces the height
  estimate (The Standard on Brooklyn Ave: 211 units, 25 storeys — the estimate said 24).
- **Stacked condominiums.** The assessor values each condo unit, so the merged footprint shows the
  average assessed value per unit directly.
- **Rents.** No rent API is callable from a browser without a key, so `fetch_data.js` extracts the
  Washington rows of Zillow Research's public CSVs — ZORI (typical asking rent, all homes +
  multifamily) and ZHVI (typical condo value, typical home value) by ZIP, last 13 months — into
  `data/zip_market_wa.json` (105 KB, 485 ZIPs) and `data/zip_market_ca.json` (388 KB, 1,545 ZIPs); only your state's file is loaded. The detail sheet shows the ZIP typical rent, condo
  and home values with 1-year change, and an **estimated rent for a unit in this building**: ZIP
  typical rent × (unit size / 850 ft²)^0.6 × an age factor (new buildings +18%, pre-1985 −8%),
  with the implied gross yield against the assessed value per unit. On the Brooklyn Ave test block
  this gives studios ~$1,300, new towers ~$2,300, yields 4–9%, which matches asking rents there.
  It is an estimate and is labelled as one; the ZIP figures are Zillow's, as of the month shown.
- A "Per unit" price mode puts the per-unit figure on the labels.

## California: Proposition 13 and the market estimate

Los Angeles County (Calabasas included) is a provider. California is different from Washington:
under Proposition 13 the assessed value is the purchase price at the last change of ownership,
grown at most 2 % a year, so two identical houses can carry $300K and $2.5M on the roll. Showing
assessed values there would be misleading, so in Prop 13 counties the default label is a
**comps-based market estimate**: the median $/ft² of arm's-length sales in the last 4 years within
2× the search radius (at least 500 m), from the assessor's own sales layer, times the home's
recorded living area. Labels say "est. market · 5 comps $645/ft²"; the detail sheet shows the
estimate with the IQR of the comps, the Prop 13 value with its base year and homeowner exemption,
the recorded living area / beds / baths / year built, and an estimated rent for the whole house.
The estimate ignores condition, view and lot, and there is none for parcels without a recorded
living area (vacant land, common-area slivers with a $9 roll value). The "Assessed" price mode
still shows the roll value everywhere; "Auto" picks per state.

Simulator: `index.html?sim=calabasas` starts you in Vista Pointe.

## Cost: bandwidth, CPU, battery

- **Bandwidth.** Parcel geometry is generalised by the server (`maxAllowableOffset` ≈ 0.5 m,
  `geometryPrecision=5`): a 260 m circle in the U-District drops from 7,000 to 1,250 vertices and
  52 KB to 18 KB gzipped. Only the needed attributes are requested. Dense cores page through
  `resultOffset` (max 3 pages) instead of silently truncating at 1,000. Overpass is skipped when
  the parcel set already carries OSM heights, on low battery, or over budget. A rolling 24 h
  data meter (decoded bytes, persisted) gates auto-precache at a configurable daily budget
  (default 25 MB) and warns before manual downloads. Snohomish's joined view rejects
  `maxAllowableOffset`, so that provider is flagged `generalize:false` and decimated client-side.
- **CPU.** Every ring is converted once to a metric frame (`Geo.frame`) and decimated at 0.4 m
  (`Geo.decimate`), so per-frame work is subtraction/hypot/atan2 (`Geo.parcelViewXY`), not
  haversine per vertex. The render loop is capped at 30 fps and skips frames when heading,
  pitch and position have not changed. The radar's parcel footprints live on an offscreen
  north-up bitmap that is only redrawn when parcels, zoom, selection or position change; each
  frame rotates and blits it. The coverage union arcs are cached per coverage set. Ground drawing
  has a per-frame parcel budget and coarser rings for far parcels. With 740 parcels loaded, main
  thread idle went from 0% (rAF gaps at 20 ms) to 96% idle when still and 74% while turning.
- **Battery.** Camera at 720p/30 fps instead of 1080p. When the tab is hidden the camera tracks
  are disabled, the GPS watch cleared and the 60 Hz orientation listeners removed; all resume on
  return. If the Battery API reports ≤20% and not charging: 15 fps, no rooftop wireframes, no
  Overpass, smaller ground budget.

## Large commercial parcels

- **Stacked parcels** (condominium units, air-rights lots, parking stalls under a tower) share one
  footprint and would each get a label. `groupStacked` merges parcels whose centroids are within
  1.5 m and areas within 5% into one, with the values summed, the unit suffix stripped from the
  address and a units list in the detail sheet. 1250 Pacific Ave in Tacoma collapses 8 → 3.
- **Wide parcels** (a mall, a campus, a big-box lot) subtend a large angle; their centroid can be
  off-screen while the building fills the view. When a parcel spans more than 40°, its label is
  anchored at the heading clamped into the parcel's angular span (`spanLo`/`spanHi`), so it sits
  on the part of the building you are actually looking at.
- **Dense downtowns** exceeding 1,000 parcels per request are paged rather than truncated.
- **Provider outage**: when a county server errors (Snohomish's went down during this work) the
  query falls back to the statewide layer and the header says so.

## Data sources (all free, no keys, CORS-enabled)

| Source | Covers | What | Notes |
|---|---|---|---|
| `gismaps.kingcounty.gov/arcgis/rest/services/Property/KingCo_PropertyInfo/MapServer/2` | King County | Parcels: PIN, address, city, zip, lot ft², acres, appraised land + improvement value, property type, present use, zoning, plat | Point + distance query in WGS84, polygons back in WGS84. 1000 features max (`exceededTransferLimit`) |
| `.../KingCo_PropertyInfo/MapServer/3` | King County | Sales in the last 3 years: PIN, date, price, use, type | Joined to parcels by PIN client side |
| `gis.snoco.org/scd/rest/services/MapService/pds_prop_report/MapServer/0` | Snohomish County | Cadastral parcels joined to assessor market land/improvement values, situs address, use code, zoning, exemption, link to the assessor | The PDS "property report" service. Fields are qualified (`GDBA.CADASTRAL__parcels.MKLND`) |
| `gis.dnr.wa.gov/site2/rest/services/Public_Forest_Practices/WADNR_PUBLIC_OCIO_Parcels/MapServer/0` | All of Washington (used for Pierce and anywhere not above) | WA State Parcels Project: normalised statewide layer with situs address, DOR land use code, land + building value, link to the county's record, county FIPS | Updated yearly from each assessor; values matched King County exactly in tests. Pierce County's own GIS has no public REST endpoint |
| `nominatim.openstreetmap.org/reverse` | — | City + neighbourhood for the header | Once per 300 m of movement |
| `overpass-api.de` / `overpass.kumi.systems` | — | OSM buildings with `height` or `building:levels` near you | Best effort; shared volunteer servers. Matched to parcels by building centroid |
| `aqua.kingcounty.gov/extranet/assessor/*.zip` | King County | Apartment Complex + Unit Breakdown extracts | No CORS, so bundled by `fetch_data.js` into `data/kc_apartments.json` |
| `files.zillowstatic.com/research/public_csvs/…` | WA + CA ZIPs | ZORI rent, ZHVI condo and home value indices | 10–120 MB CSVs, so bundled by `fetch_data.js` into `data/zip_market_{wa,ca}.json` |
| `cache.gis.lacounty.gov/cache/rest/services/LACounty_Cache/LACounty_Parcel/FeatureServer/0` | Los Angeles County | Parcels with roll values, base years, living ft², beds/baths, units, year built | Hosted layer, CORS, 2000/page, updated monthly |
| `assessor.gis.lacounty.gov/assessor/rest/services/PAIS/pais_sales_parcels/MapServer/0` | Los Angeles County | Recorded sales with price, size, bedrooms | Feeds the comps estimate |

Assessed values are the county's taxation values (typically a year behind and below market),
not a market appraisal. Snohomish publishes "market" land/improvement values, which are its
assessor's estimates of the same thing. The Zillow / Redfin style "Zestimate" data you see in Google Maps is
proprietary and not available without keys or a server, so this deliberately shows public
records instead: they are exact, per parcel, and include the transaction history.

### Adding another county

`providers.js` has a `PROVIDERS` registry. A provider is an ArcGIS `query` URL, the fields to
request, a `map(attributes)` onto the normalised parcel shape, a bounding box used to pick it
from GPS (first match wins, so county entries go before the statewide fallback), and optional
sales layer / links. Most US county assessors publish parcels as an ArcGIS REST service with
`Access-Control-Allow-Origin` set, so adding one is a config entry; check with
`curl -sI -H "Origin: https://x" <url>?f=json | grep -i access-control`.

## Files

- `index.html` — the app (camera, sensors, overlay, radar, detail sheet, settings, SW registration)
- `geo.js` — haversine, bearing, centroid, point-in-polygon, angular span, metric frame + planar view + ring decimation, pinhole projection, polygon clipping / view wedge, heading filter, formatting
- `providers.js` — provider registry (King, Snohomish, WA statewide) with fallback, ArcGIS queries (generalised, paged, byte-metered), normalisation, sales join, stacked-parcel grouping, WA DOR use codes, Nominatim
- `heights.js` — storey/height estimate from use class + value density; Overpass fetch and parcel matching
- `market.js` — apartment records and ZIP market indices: per-unit value, rent estimate, yield
- `fetch_data.js` — refreshes `data/` from the assessor extracts and Zillow Research CSVs
- `parcelstore.js` — offline cache: coverage circles + IndexedDB parcel store (memory fallback), hex-lattice precache planner, circle-union boundary, GPS track/course, corridor-ahead planner, wifi gate, 24 h data meter
- `sw.js`, `manifest.webmanifest`, `icon.svg`, `icon-192.png`, `icon-512.png` — PWA
- `estate.test.js` — bun tests (81) using `fixture_parcels.json` / `fixture_sales.json` / `fixture_snohomish.json` / `fixture_wastate.json` captured from the live services
- `live_check.js` — live smoke test

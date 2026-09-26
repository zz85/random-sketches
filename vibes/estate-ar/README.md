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
- **Radar coverage overlay**: the green wash on the radar is the union of what works offline,
  with its boundary drawn (exact arc segments of the circle union, `unionArcs`) so you can see
  where cached data ends. While a download runs the radar zooms out to show progress.
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

## Data sources (all free, no keys, CORS-enabled)

| Source | Covers | What | Notes |
|---|---|---|---|
| `gismaps.kingcounty.gov/arcgis/rest/services/Property/KingCo_PropertyInfo/MapServer/2` | King County | Parcels: PIN, address, city, zip, lot ft², acres, appraised land + improvement value, property type, present use, zoning, plat | Point + distance query in WGS84, polygons back in WGS84. 1000 features max (`exceededTransferLimit`) |
| `.../KingCo_PropertyInfo/MapServer/3` | King County | Sales in the last 3 years: PIN, date, price, use, type | Joined to parcels by PIN client side |
| `gis.snoco.org/scd/rest/services/MapService/pds_prop_report/MapServer/0` | Snohomish County | Cadastral parcels joined to assessor market land/improvement values, situs address, use code, zoning, exemption, link to the assessor | The PDS "property report" service. Fields are qualified (`GDBA.CADASTRAL__parcels.MKLND`) |
| `gis.dnr.wa.gov/site2/rest/services/Public_Forest_Practices/WADNR_PUBLIC_OCIO_Parcels/MapServer/0` | All of Washington (used for Pierce and anywhere not above) | WA State Parcels Project: normalised statewide layer with situs address, DOR land use code, land + building value, link to the county's record, county FIPS | Updated yearly from each assessor; values matched King County exactly in tests. Pierce County's own GIS has no public REST endpoint |
| `nominatim.openstreetmap.org/reverse` | — | City + neighbourhood for the header | Once per 300 m of movement |
| `overpass-api.de` / `overpass.kumi.systems` | — | OSM buildings with `height` or `building:levels` near you | Best effort; shared volunteer servers. Matched to parcels by building centroid |

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
- `geo.js` — haversine, bearing, centroid, point-in-polygon, angular span, pinhole projection, heading filter, formatting
- `providers.js` — provider registry (King, Snohomish, WA statewide), ArcGIS queries, normalisation, sales join, WA DOR use codes, Nominatim
- `heights.js` — storey/height estimate from use class + value density; Overpass fetch and parcel matching
- `parcelstore.js` — offline cache: coverage circles + IndexedDB parcel store (memory fallback), hex-lattice precache planner, circle-union boundary
- `sw.js`, `manifest.webmanifest`, `icon.svg`, `icon-192.png`, `icon-512.png` — PWA
- `estate.test.js` — bun tests (53) using `fixture_parcels.json` / `fixture_sales.json` / `fixture_snohomish.json` / `fixture_wastate.json` captured from the live services
- `live_check.js` — live smoke test

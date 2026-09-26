# Estate AR - property prices through the camera

Point your phone at a building and see what the county assessor thinks it is worth.
Camera passthrough, GPS, compass and tilt from the browser; parcel polygons and assessed
values from the county's public ArcGIS server. No API keys, no proxy, no backend: one static
`index.html` plus two small JS modules.

```
cd vibes/estate-ar && python3 -m http.server 8000   # http://localhost:8000 (camera/GPS need https or localhost)
bun test                                            # geometry + provider parsing against a captured live response
bun live_check.js [lat lon [radius_m]]              # live query: parcels around a point, who you are standing on
```

On a phone, serve it over https (any static host works: GitHub Pages, S3, `npx serve --ssl`),
tap **Start**, grant camera / location / motion. On desktop, **Try without sensors** puts you
in the U-District with a simulated compass: drag to look around, wheel or arrow keys to tilt.

## What you see

- **Floating price labels** over each parcel in the camera's field of view, colour coded by
  property type (blue residential, orange commercial, purple condo, yellow exempt). Near
  labels show address, distance and use; far ones collapse to just the price. Nearest parcels
  win when the block is dense (max labels is a setting).
- **Ground outlines**: tilt the phone down and the parcel boundaries are drawn on the ground
  plane in perspective, so you can see where one lot ends and the next begins.
- **"You are on"** card: the parcel your GPS position falls inside (point-in-polygon), with its value.
- **Radar** mini-map, heading-up, with the view cone, every loaded parcel footprint, and your
  GPS accuracy circle.
- **Detail sheet** on tap: total / land / improvement assessed value, $/ft² of lot, use, zoning,
  lot size, plat, recorded sales in the last three years (with $0 transfers flagged), and links to
  the assessor's record and the county parcel viewer.
- **Price modes**: total assessed, land only, $/ft² lot, or last sale price.
- Settings for fetch radius, label distance, camera FOV, heading offset and magnetic declination
  (compass on Android is magnetic; Seattle is about 15°E), units, persisted in localStorage.
  Parcels are cached in localStorage and only refetched when you walk 40% of the radius.

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

## Data sources (all free, no keys, CORS-enabled)

| Source | What | Notes |
|---|---|---|
| `gismaps.kingcounty.gov/arcgis/rest/services/Property/KingCo_PropertyInfo/MapServer/2` | Parcels: PIN, address, city, zip, lot ft², acres, appraised land + improvement value, property type, present use, zoning, plat | Point + distance query in WGS84, returns polygons in WGS84. 1000 features max per request (`exceededTransferLimit`) |
| `.../KingCo_PropertyInfo/MapServer/3` | Sales in the last 3 years: PIN, date, price, use, type | Joined to parcels by PIN client side |
| `nominatim.openstreetmap.org/reverse` | City + neighbourhood for the header | Once per 300 m of movement |

Assessed values are the county's taxation values (typically a year behind and below market),
not a market appraisal. The Zillow / Redfin style "Zestimate" data you see in Google Maps is
proprietary and not available without keys or a server, so this deliberately shows public
records instead: they are exact, per parcel, and include the transaction history.

### Adding another county

`providers.js` has a `PROVIDERS` registry. A provider is an ArcGIS `query` URL plus a field
map onto the normalised parcel shape, a bounding box used to pick it from GPS, and optional
sales layer / links. Most US county assessors publish parcels as an ArcGIS REST service with
`Access-Control-Allow-Origin` set, so adding one is a config entry; check with
`curl -sI -H "Origin: https://x" <url>?f=json | grep -i access-control`.

## Files

- `index.html` — the app (camera, sensors, overlay, radar, detail sheet, settings)
- `geo.js` — haversine, bearing, centroid, point-in-polygon, angular span, pinhole projection, heading filter, formatting
- `providers.js` — ArcGIS parcel/sales queries, normalisation, sales join, Nominatim, localStorage cache
- `estate.test.js` — bun tests (33) for the above, using `fixture_parcels.json` / `fixture_sales.json` captured from the live service
- `live_check.js` — live smoke test

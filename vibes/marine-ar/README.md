# Marine AR

Camera-passthrough AR for the water: point your phone at the sound and it draws the
**charted traffic lanes on the sea surface** (with their direction arrows and
separation zones) and pins **AIS vessels** where they actually are, with name, type,
speed, course, size, distance and a 6-minute course vector. Tap a vessel for the full
static record plus CPA/TCPA relative to you.

No backend, no keys, no build step: `index.html` + two plain JS modules. Every data
source is a CORS-enabled public endpoint fetched directly from the browser. An optional
zero-dependency `proxy.js` exists only because the one worldwide AIS feed with a free
tier (aisstream.io) forbids browser connections.

```
open index.html                       # any static server, or
node proxy.js                         # http://localhost:8788  (also serves the files)
bun test                              # geometry, providers, proxy: 32 tests, fixtures included
node smoke.js                         # headless Chromium render check against live NOAA
```

## Data sources (all CORS, verified Sep 2026)

| What | Where | Notes |
|---|---|---|
| Traffic lanes, separation zones, precautionary areas, TSS boundaries, fairways | NOAA **ENC Direct** ArcGIS REST, `enc_harbour` + `enc_coastal` services | S-57 objects TSSLPT (with `ORIENT`), TSEZNE, PRCARE, TSSBND, FAIRWY. Layer ids in `providers.js` `LANE_LAYERS`. Harbour features win, coastal fills gaps. Cached 7 days in localStorage. |
| AIS vessels — Finland / Baltic | **Digitraffic** `meri.digitraffic.fi/api/ais/v1` | Public REST, `Access-Control-Allow-Origin: *`, no key. `/locations?latitude&longitude&radius` polled every 10 s, `/vessels/{mmsi}` for static data. Also has MQTT-over-WebSocket (not used; polling is enough). |
| AIS vessels — worldwide | **aisstream.io** via `proxy.js` | Free API key, server-side only. The proxy holds one WebSocket for a box around the viewer and re-serves the table in the exact Digitraffic shape, so the browser has one code path. `AISSTREAM_API_KEY=… node proxy.js`. |
| AIS vessels — nowhere | **demo** provider | Simulated ships seeded *inside the charted lanes* running along `ORIENT`, plus a ferry, a sailboat and an anchored tug. Auto-selected outside Digitraffic coverage when no proxy is configured, so Puget Sound is usable without a key. |
| Magnetic declination | NOAA WMM `geomag-web` calculator | CORS. Applied to Android compass headings; iOS `webkitCompassHeading` is already true. |
| Place name | Nominatim reverse geocode | Header only. |

US public AIS is the gap: NOAA/MarineCadastre publish AIS only as historical daily
files, USCG NAIS is not public, and the ArcGIS service that once mirrored it now needs
a token. If you find a CORS-open live US feed, it is one `restPoller(...)` entry in
`AIS_PROVIDERS` away.

## How it draws

`geo.js` has a pinhole `Camera` standing `eyeHeight` metres above the water with
heading/pitch/roll. Anything on the sea surface (lane polygons, hull footprints,
course vectors, arrows) is converted to local east/north metres, dropped by the
refracted earth-curvature term, and run through the camera with Sutherland-Hodgman
clipping at the near plane, so a lane you are standing in still renders as the
strip it is instead of vanishing. The horizon is drawn at the true dip for your eye
height (1.76′·√h) with a roll-aware compass tape on it.

Vessels are dead-reckoned from their last report along SOG/COG (except anchored or
moored), so a 10 s poll still looks continuous. Hull outlines use the AIS A/B/C/D
reference-point dimensions and true heading. Labels are decluttered nearest-first
and pushed up when they collide. The radar mini-map is heading-up with a FOV wedge.

Device orientation is handled as a full rotation matrix (W3C Z-X'-Y'') corrected for
`screen.orientation.angle`, giving camera heading, pitch and roll of the *back
camera*, which is what you want when the phone is held upright — not the flat-phone
compass heading that `alpha` alone gives.

## Files

- `index.html` — the app. URL params for testing: `?lat=&lon=&eye=&hdg=&pitch=&provider=demo|digitraffic|proxy&proxy=http://…&auto=1&nocam=1`
- `geo.js` — spherical + ENU geometry, `Camera`, horizon, hull footprint, dead reckoning, CPA/TCPA, lane arrows
- `providers.js` — ENC Direct lane queries, AIS provider registry, `VesselTable`, ITU ship-type / nav-status tables, `LaneStore`
- `proxy.js` — static server + aisstream.io → Digitraffic-shaped `/ais/*`
- `marine-ar.test.js` — `bun test`; uses the `fixture_*.json` captured from the live endpoints
- `smoke.js` — renders two scenes in headless Chromium and fails on console errors

## Not done / ideas

- Land occlusion: ships behind a headland still show. NOAA ENC `LNDARE` is one more
  ENC Direct layer; a coarse depth test against land polygons would hide them.
- Own-ship SOG/COG for CPA comes from `geolocation.speed/heading`; on foot it is ~0,
  which is correct, but on a moving boat give it a moment to settle.
- Digitraffic MQTT (`wss://meri.digitraffic.fi:443/mqtt`) for sub-second updates.
- AtoN (buoys, lights) from ENC Direct as extra AR pins.

# Marine AR

Camera-passthrough AR for the water: point your phone at the sound and it draws the
**charted traffic lanes on the sea surface** (with their direction arrows and
separation zones) and pins **AIS vessels** where they actually are, with name, type,
speed, course, size, distance and a 6-minute course vector. Tap a vessel for the full
static record plus CPA/TCPA relative to you.

No backend, no keys, no build step: `index.html` + two plain JS modules. Every data
source is a public endpoint reached directly from the browser: CORS REST for charts and
Finnish AIS, and a keyless WebSocket (OpenSeaFeed) for worldwide AIS, since browsers do
not apply CORS to WebSockets. An optional zero-dependency `proxy.js` remains for those
who prefer aisstream.io's denser feed, which needs a key that must not live in a page.

```
open index.html                       # any static server, or
node proxy.js                         # http://localhost:8788  (also serves the files)
bun test                              # geometry, providers, proxy, occlusion, AtoN, AIS sockets, light rhythms: 61 tests, fixtures included
node smoke.js                         # headless Chromium over CDP: 5 scenes against live NOAA / OpenSeaFeed / Digitraffic, page state + console
```

## Data sources (all CORS, verified Sep 2026)

| What | Where | Notes |
|---|---|---|
| Traffic lanes, separation zones, precautionary areas, TSS boundaries, fairways | NOAA **ENC Direct** ArcGIS REST, `enc_harbour` + `enc_coastal` services | S-57 objects TSSLPT (with `ORIENT`), TSEZNE, PRCARE, TSSBND, FAIRWY. Layer ids in `providers.js` `LANE_LAYERS`. Harbour features win, coastal fills gaps. Cached 7 days in localStorage. |
| AIS vessels — Finland / Baltic | **Digitraffic** `meri.digitraffic.fi/api/ais/v1` | Public REST, `Access-Control-Allow-Origin: *`, no key. `/locations?latitude&longitude&radius` polled every 10 s, `/vessels/{mmsi}` for static data. Also has MQTT-over-WebSocket (not used; polling is enough). |
| AIS vessels — worldwide | **OpenSeaFeed** `wss://stream.openseafeed.com/v1/stream` | Community-owned open AIS network (Apache-2.0, data CC BY 4.0) speaking the aisstream.io protocol. Keyless free tier: one subscribe message with a bounding box around the viewer (padded 1.5×, resubscribed when you move out of it), the box's vessels replayed on connect, then live position and static reports. Free tier allows 30 000 deg² of box area, probed; an AR view needs about 0.2. Default outside national feeds; falls back to demo after 25 s without data. |
| Vessel names for silent targets | **OpenSeaFeed** `GET api.openseafeed.com/v1/vessels/{mmsi}` | ~250 bytes, CORS `*`. A class B boat repeats its name only every 6 min and many never send it; a vessel we have only heard a position from is looked up here (nearest nameless first, 5 per second) and shown as "Unnamed vessel · US" meanwhile. Hits cached 30 days in localStorage, misses one day. Opt-out in settings. |
| AIS vessels — worldwide, denser | **aisstream.io** via `proxy.js` | Free API key, server-side only. The proxy holds one WebSocket for a box around the viewer and re-serves the table in the exact Digitraffic shape, so the browser has one code path. `AISSTREAM_API_KEY=… node proxy.js`. |
| AIS vessels — nowhere | **demo** provider | Simulated ships seeded *inside the charted lanes* running along `ORIENT`, plus a ferry, a sailboat and an anchored tug. Only used when explicitly chosen or when no live feed delivers; the chip then reads "AIS SIMULATED" so it cannot be mistaken for real traffic. |
| Land, for line-of-sight occlusion | NOAA **ENC Direct** `Land_Area` (S-57 LNDARE) + `Land_Elevation_point` (LNDELV), harbour then coastal | Fetched with `maxAllowableOffset` (~30 m generalisation) so a 45 km box is ~150 KB. Each vessel's sight line is tested against the polygons twice a second; ships behind land are drawn dimmed and dashed with "behind land · distance to shore" (or hidden, per setting). Lane labels whose centroid is behind land are dropped. Cached 30 days. |
| Aids to navigation | NOAA **ENC Direct** point layers BOYLAT/BOYSPP/BOYCAR/BOYISD/BOYSAW, BCNLAT/BCNSPP/BCNSAW, DAYMAR, LIGHTS, LITFLT | Buoys drawn as cones in their charted colours, beacons as posts, loose lights as stars; the LIGHTS object at the same position is merged onto its structure and rendered as "Fl G 4s 5M" from LITCHR/COLOUR/SIGGRP/SIGPER/VALNMR. Tap for lateral meaning, height, nominal range, sector. Same occlusion treatment as vessels. After dark (sun below −3° at your position, or forced in settings) every light flashes its charted rhythm: `Geo.lightSchedule` turns LITCHR/SIGPER/SIGGRP into an on/off timetable (Fl, LFl, Q, VQ, Iso, Oc, Al, composite groups like Fl(2+1), Q+LFl), lit lights get a glow sized by nominal range, and each has its own phase so a row of buoys does not blink in unison. Harbour layers first (11 requests), coastal only where harbour charted nothing. Cached 30 days. |
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

- `index.html` — the app. URL params for testing: `?lat=&lon=&eye=&hdg=&pitch=&provider=demo|openseafeed|digitraffic|proxy&proxy=http://…&auto=1&nocam=1&night=1`
- `geo.js` — spherical + ENU geometry, `Camera`, horizon, hull footprint, dead reckoning, CPA/TCPA, lane arrows, land line-of-sight (`landOcclusion`, elevation-aware), `estimateAirDraught`, light rhythms (`lightSchedule`, `lightState`), `sunAltitude`
- `providers.js` — ENC Direct lane / land / LNDELV / AtoN queries, S-57 colour and light-character tables, AIS provider registry, `VesselTable`, ITU ship-type / nav-status tables, `LaneStore` / `LandStore` / `BoxStore` / `StaticCache`, OpenSeaFeed socket + name lookup
- `proxy.js` — static server + aisstream.io → Digitraffic-shaped `/ais/*`
- `marine-ar.test.js` — `bun test`; uses the `fixture_*.json` captured from the live endpoints
- `smoke.js` — renders two scenes in headless Chromium and fails on console errors

## Not done / ideas

- Occlusion is elevation-aware where the chart allows: each land ring takes the
  highest LNDELV spot height inside it, the target height is a rough air draught
  from AIS length and type (or the charted HEIGHT of a light), and the sight line
  from your eye height is compared with the land over each stretch it crosses,
  earth curvature included. ENCs chart spot heights sparsely (26 of 359 rings
  around Seattle; none on Magnolia), so rings without a height are opaque by
  default; the "uncharted land" slider assumes a height for them instead. A
  proper fix is a DEM (SRTM/3DEP) sampled along the sight line.
- Own-ship SOG/COG for CPA comes from `geolocation.speed/heading`; on foot it is ~0,
  which is correct, but on a moving boat give it a moment to settle.
- Digitraffic MQTT (`wss://meri.digitraffic.fi:443/mqtt`) for sub-second updates.

# Tidewise — a DeepZoom.com-style marine trip planner

Planning doc for recreating something like [deepzoom.com](https://www.deepzoom.com): an
animated, time-scrubbable map of tides, currents, weather and nautical charts, with routes,
trips and sharing on top.

Status: planning only. Nothing built yet.

---

## 1. What DeepZoom actually is

Not Microsoft's Deep Zoom image tech. It's a one-developer marine planning web app
(Jay Borseth, since ~2008; Silverlight → D3/Bootstrap → Quasar/Vue). Everything on it
is driven by a single global **time slider**; you scrub or press play and the whole map
animates through time.

Feature inventory, grouped by what powers it:

| Area | Features |
|---|---|
| Time | Global timeline (timebase, duration, playback rate), play/pause, scrub, "Now" |
| Tides & currents | NOAA + CHS (Canada) stations, harmonic predictions, tide graph, tide tables, animated current arrows, earth/sun/moon phase animation |
| Spatial currents | Continuous animated tidal current field from ADCIRC constituent databases (EC2015, ENPAC15), color bands + streamers |
| Weather | GFS wind/rain/temp animated globally, NDBC buoys with live obs, radar (Iowa Mesonet, 5-min refresh), pilot charts with animated wind roses |
| Basemaps | Satellite or outdoors; NOAA raster/ENC charts, international charts; graticule; 3D tilt |
| Planning | Routes (draw, merge, extend, speed, departure time), auto-routing over an AIS-heatmap-derived graph, markers with star ratings, tracks (timeline-aware), magnetic heading per leg |
| Trips | Bundle of routes/markers/view settings; public or private share links; state-encoding URLs |
| Scripting | Before/during/after events on trips and routes (0–1 relative progress), `if` conditions, `loopCount`, info stack of web pages/media |
| Misc | Wikipedia integration, search (stations, places, lat/lng formats), PWA, undo/redo, iframe embedding, subscriptions, AI assistant with credit caps |

The unifying idea: **every layer is a function of (lon, lat, t)**, and the UI is a
clock you can drive.

---

## 2. Design principles for the rebuild

1. **Time is the primary axis.** One `TimeStore` (t, t0, duration, rate, playing) that every layer subscribes to. No layer owns its own clock.
2. **Compute predictions client-side.** Tide/current harmonics are cheap (sum of ~37 cosines). Ship constituents to the browser, not precomputed time series. This is what makes scrubbing instant and offline-friendly.
3. **Static data first, servers last.** Most datasets (stations, constituents, charts, pilot charts, ADCIRC mesh) change yearly or never. Bake them into static files on a CDN. The only live server work is weather ingest and user data.
4. **GPU for fields, DOM/Canvas for features.** Wind, spatial currents and radar are raster fields → WebGL custom layers. Stations, routes, markers → vector layers.
5. **Everything shareable is a URL.** App state must round-trip to a compact URL so a trip link reproduces exactly what the author saw.
6. **Ship vertical slices.** Each milestone is usable on its own. M1 alone (charts + tides + time slider) is already a useful tool.

---

## 3. Architecture

```
┌────────────────────────── Browser (PWA) ──────────────────────────┐
│  Vue 3 + Quasar (or Svelte)                                        │
│  ┌──────────┐  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │TimeStore │→ │ Layer mgr   │→ │ MapLibre GL  │  │ Panels     │  │
│  │(pinia)   │  │ tides/wx/.. │  │ + custom GL  │  │ tide graph │  │
│  └──────────┘  └─────────────┘  │   layers     │  │ route edit │  │
│  ┌──────────────────────────┐   └──────────────┘  │ script dlg │  │
│  │ Workers: harmonics, GRIB │                     └────────────┘  │
│  │ decode, ADCIRC interp    │                                      │
│  └──────────────────────────┘                                      │
└───────────────┬───────────────────────────────┬───────────────────┘
                │ static GETs                   │ JSON API
        ┌───────▼────────┐             ┌────────▼─────────┐
        │ CDN / S3       │             │ API (Node/Hono   │
        │ • chart tiles  │             │  or Go)          │
        │ • stations.json│             │ • auth (magic    │
        │ • constituents │             │   link / OAuth)  │
        │ • ADCIRC packed│             │ • trips, routes, │
        │ • pilot charts │             │   markers, tracks│
        │ • wind PNGs    │             │ • share links    │
        │ • routing graph│             │ • AI proxy w/    │
        └───────▲────────┘             │   credit meter   │
                │                      └────────┬─────────┘
        ┌───────┴─────────────┐          ┌──────▼──────┐
        │ Scheduled ingest    │          │ Postgres +  │
        │ • GFS 4×/day        │          │ PostGIS     │
        │ • NDBC hourly       │          └─────────────┘
        │ • radar 5 min       │
        │ • yearly: NOAA/CHS  │
        │   stations, charts  │
        └─────────────────────┘
```

### Stack picks (with reasons)

| Concern | Pick | Why |
|---|---|---|
| Map engine | **MapLibre GL JS** | Free Mapbox GL fork; vector tiles; `CustomLayerInterface` for WebGL layers; `mapbox-gl-draw` compatible forks exist for route editing. DeepZoom uses Mapbox — same mental model without the bill. |
| UI | **Vue 3 + Quasar** (alt: Svelte 5) | Quasar gives PWA scaffolding, dialogs, mobile-first controls out of the box. Matches the original, which lowers "unknown unknowns". |
| State | Pinia | One store per concern: time, view, layers, trip, auth. |
| Heavy math | Web Workers + WASM (Rust) where it matters | ADCIRC interpolation over 2M nodes and GRIB decode are the only genuinely heavy bits. |
| Backend | Node (Hono/Fastify) or Go | Thin CRUD + auth + ingest orchestration. Nothing here is CPU-bound. |
| DB | Postgres + PostGIS | Routes/markers are geometries; want spatial queries for "public markers in viewport". |
| Object store | S3 + CloudFront (or Cloudflare R2) | Everything static. |
| Ingest | Cron'd containers (ECS scheduled tasks / GitHub Actions for the slow yearly ones) | GFS is the only thing that needs a real schedule. |
| Charts | Self-hosted PMTiles | One file per chart set, range requests, no tile server. |
| Time zones | `@vvo/tzdb` or Luxon w/ IANA data | Stations report in local time; BC recently broke assumptions — keep tzdb fresh. |
| Tests | Vitest (unit), Playwright (e2e) | Harmonic math needs golden tests against NOAA published predictions. |

---

## 4. Data sources and pipelines

### 4.1 Tides & currents (yearly ingest, static output)

- **NOAA CO-OPS** — station metadata + harmonic constituents API (`/mdapi/prod/webapi/stations/{id}/harcon.json`). ~3000 tide stations, ~subordinate stations use offsets from reference stations.
- **NOAA current predictions** — station list + constituents where available; many are "subordinate" with time/speed ratios.
- **CHS (Canada)** — IWLS API for stations and constituents.
- Output: `stations.geojson` (light, for map) + `constituents/{stationId}.json` (fetched lazily on select) + `datums.json`.
- **Client harmonic engine**: `h(t) = H0 + Σ f_i · A_i · cos(ω_i·t + (V0+u)_i − κ_i)`. Need nodal corrections (f, u) for the year, equilibrium arguments V0. Port from `xtide`/`pytides` logic; validate against NOAA's own predictions to <1 cm.
- High/low extraction: sample at 6-min, refine extrema with Newton on the derivative.

### 4.2 Spatial currents (one-time ingest, packed static)

- **ADCIRC EC2015 / ENPAC15** tidal databases: unstructured triangle mesh, per-node amplitude/phase for ~37 constituents (u and v).
- Preprocess to a **regular grid per zoom tier** (e.g. 500 m, 2 km, 8 km) of packed Float16 constituents, tiled and gzip'd. Trades mesh fidelity for trivial GPU sampling. Keep the top ~8 constituents per node (M2, S2, N2, K1, O1, P1, Q1, K2) — that's >95% of energy.
- Render: WebGL fragment shader computes u,v at time t from constituent textures → speed color bands + streamer particle advection (same technique as earth.nullschool / `webgl-wind`).
- Show the depth-averaged caveat prominently; "where a station exists, trust it."

### 4.3 Weather (scheduled ingest)

- **GFS 0.25°** from NOMADS, 4 runs/day, hourly steps to 120h then 3-hourly. Pull only the bands we need: UGRD/VGRD 10 m, PRATE, TMP 2 m, PRMSL, GUST.
- Decode GRIB2 server-side (`wgrib2` or `eccodes`), write each timestep as a **RG16 PNG** (u,v encoded) + JSON with scale/offset. ~1 MB per step, ~60 steps per run.
- Client: interpolate between steps in the shader as t scrubs. Particles for wind, color ramp for rain/temp.
- **NDBC buoys**: hourly `latest_obs.txt` → GeoJSON with wind/wave/pressure.
- **Radar**: Iowa Environmental Mesonet NEXRAD composite WMS/tile endpoint; client fetches directly with a 5-min cache-buster; toggling radar clamps timebase to last 1 h (mirror DeepZoom).
- **Pilot charts**: NGA pilot chart PDFs are painful; alternative is compute monthly wind roses from ERA5 climatology once and store as JSON per 5° cell.

### 4.4 Charts

- **NOAA**: ENC S-57 → vector tiles via `OpenCPN`-style S-52 styling is the "right" way but large. Pragmatic path: NOAA's official **raster tile service** (ECDIS-style tiles) cached to PMTiles, plus NOAA ENC Direct-to-GIS for soundings/depth areas as vector overlay.
- **International**: OpenSeaMap seamarks (vector) over a basemap; other national HOs where licensing allows.
- **Basemap**: Protomaps/OpenFreeMap vector tiles (outdoors), Esri World Imagery or Sentinel-2 cloudless (satellite).
- **Magnetic variation**: WMM coefficients, compute declination client-side per leg.

### 4.5 Auto-routing graph (one-time + yearly refresh)

- Inputs: a year of **AIS** positions (NOAA MarineCadastre publishes US AIS). Rasterize to a heatmap, skeletonize dense corridors → nodes/edges, hand-edit to avoid shoals.
- Store as a compact graph file (`nodes.bin`, `edges.bin`) partitioned by region; client loads the region and runs A* (or contraction hierarchies if it gets big).
- Big scary disclaimer, exactly like the original: routes are not depth-filtered.

---

## 5. Client data model

```ts
interface Trip {
  id: string;            // short slug for /trip/:id
  ownerId: string;
  name: string;
  visibility: 'private' | 'link' | 'public';
  routes: Route[];
  markers: Marker[];
  tracks: Track[];
  view?: ViewSettings;   // layers, opacities, timebase — "include view settings"
  script: ScriptEvent[]; // trip-level before/during/after
}

interface Route {
  id: string;
  name: string;
  geometry: LineString;  // GeoJSON, lon/lat
  departure: string;     // ISO, with tz
  speedKts: number;
  color: string;
  enabled: boolean;      // disabled = boundary marker
  script: ScriptEvent[];
  // derived, not stored: legs[], eta per vertex, magnetic heading per leg
}

interface ScriptEvent {
  scope: 'trip' | 'route';
  routeId?: string;
  phase: 'before' | 'during' | 'after';
  at?: number;           // 0..1 relative progress, only for 'during'
  if?: string;           // expression, e.g. "loopCount % 2 == 0"
  action: ScriptAction;  // discriminated union: setLayer, setOpacity, selectStation,
                         // notify, infoUrl, setTimebase, setRate, flyTo, setTimezone ...
}

interface TimeState {
  t: number;             // ms epoch, current animation time
  t0: number;            // timebase start
  durationMs: number;
  rate: number;          // sim seconds per wall second
  playing: boolean;
  loopCount: number;
  tz: string;            // display tz
}
```

Undo/redo: command pattern over geometry mutations only (matches original — property edits don't push unless geometry changes).

### URL state

`/trip/:id?t=...&t0=...&dur=...&rate=...&play=1&c=lon,lat,z,b,p&layers=chart:1,wind:0.6,cur:1&sta=9447130&tz=America/Vancouver`

Everything in `ViewSettings` + `TimeState` serializes here. Trip content comes from the API by id.

---

## 6. Rendering plan per layer

| Layer | Technique | Notes |
|---|---|---|
| Basemap / charts | MapLibre raster + vector sources | PMTiles protocol handler |
| Tide stations | MapLibre circle layer, data-driven radius/color from current height | Recompute paint props per frame from harmonics in a worker; throttle to visible features |
| Current station arrows | MapLibre symbol layer with rotation + icon-size from speed | Or a small custom Canvas overlay if >2k arrows |
| Spatial currents | Custom WebGL layer: constituent textures → velocity → bands + particles | Same shader for wind with different inputs |
| Wind / rain / temp | Custom WebGL layer, two timesteps blended | Particle count scales with viewport |
| Radar | Raster source, refreshed on interval | |
| Routes / markers | GeoJSON sources + a `maplibre-gl-draw` fork for editing | Animated boat position: point along line at ETA(t) |
| Tracks | GeoJSON line + "cursor" point at t | GPX import |
| Tide graph panel | D3 or lightweight Canvas line chart, 3-day window centred on t | Vertical cursor bound to TimeStore |
| Earth/sun/moon | Small Canvas/SVG animation | Reuse the `cosmos/` code already in this repo |

---

## 7. Milestones

Each milestone is deployable and useful by itself.

### M0 — Skeleton (1 wk)
- Vite + Vue + Quasar PWA, MapLibre with an outdoors basemap, TimeStore + slider + play/pause, URL state round-trip.
- Deploy static to S3/CloudFront. No backend.

### M1 — Tides (2–3 wk) ← the DeepZoom v1.0 feature set
- Ingest NOAA stations + constituents to static JSON.
- Harmonic engine in a worker with golden tests vs NOAA predictions.
- Station layer animating with t; tide graph panel; hi/lo table in station-local tz.
- NOAA raster chart tiles as a toggleable layer with opacity.

### M2 — Currents + Canada (2 wk)
- Current stations with animated arrows; subordinate station offsets.
- CHS ingest for both tides and currents.
- Search by station name / lat-lng.

### M3 — Weather (3 wk)
- GFS ingest pipeline (scheduled), RG16 PNG tiles.
- Wind particle layer, rain/temp color layers, timestep blending.
- NDBC buoys with live obs popups. Radar layer with the 1-h timebase clamp.

### M4 — Routes, markers, trips (3–4 wk)
- Backend: auth (magic link), Postgres, trips/routes/markers CRUD, share slugs, visibility.
- Route drawing/editing (mouse + touch), speed/departure, ETAs, boat animation along route, magnetic heading per leg, merge/extend.
- Markers with ratings; public marker collections; "publish to public map" flow.
- GPX track import, timeline-aware playback.

### M5 — Scripting (2 wk)
- ScriptEvent model, before/during/after evaluation in the TimeStore tick, `if` expressions via a sandboxed evaluator (jsep/expr-eval, not `eval`), `loopCount`.
- Script dialog: record-current-state → event, Δt reassign, error position display, halt on error.
- Info stack panel for `infoUrl`.

### M6 — Spatial currents (3–4 wk, R&D heavy)
- ADCIRC → gridded packed constituents pipeline.
- WebGL layer reusing the wind shader family. Stepped color scale, streamers, center readout.

### M7 — Auto-routing (3 wk)
- AIS heatmap → graph pipeline; hand-editing tool; client A*.

### M8 — Polish / business
- Pilot charts + wind roses, Wikipedia geosearch popups, graticule, 3D tilt, iframe embed mode, subscriptions (Stripe), AI assistant behind a per-user credit meter (lesson from the original's leaked key: server-side proxy only, hard caps, rotate keys).

Rough total: ~5–6 months of one focused developer to reach parity-ish. M0–M2 is ~6 weeks and is already a tool people would use.

---

## 8. Risks and open questions

- **Chart licensing**: NOAA is public domain; most other hydrographic offices are not. International charts may be limited to OpenSeaMap-quality unless paying.
- **Data volume**: GFS at 60 steps × 5 variables × 4 runs/day adds up. Keep only the latest 2 runs; lazily fetch steps around t.
- **ADCIRC accuracy**: depth-averaged, validated on heights not velocities. Must label it as approximate or it becomes a liability in rapids.
- **Auto-routing liability**: same. Disclaimer + never depth-filter silently.
- **Harmonic subtleties**: NOAA subordinate stations, datum offsets (MLLW vs chart datum), mixed tz/DST handling. This is where most bugs will live; invest in golden tests early.
- **Mobile touch editing** of routes is notoriously fiddly (the original has a whole bug saga in `mapbox-gl-draw`). Budget time for it in M4.
- **Open**: Vue/Quasar vs Svelte? Quasar recommended for speed-to-PWA; Svelte if bundle size and per-frame reactivity overhead become an issue.
- **Open**: Should tide constituents be precomputed to a coarse time series server-side instead? No — client harmonics keeps scrubbing instant and works offline. Revisit only if a datum/constituent case can't be handled client-side.

---

## 9. Immediate next steps

1. Spike the harmonic engine: pull constituents for one station (e.g. Seattle 9447130), predict a week, diff against NOAA's `predictions` API. This de-risks M1 and the whole "client-side compute" premise.
2. Spike MapLibre + one NOAA raster chart layer + a time slider in a single HTML file (fits this repo's style — see `cosmos/`).
3. Decide UI framework after both spikes.

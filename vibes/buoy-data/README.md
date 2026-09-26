# West Point Buoy

A faster, richer view of NOAA station **WPOW1 (West Point, Seattle)** — or any nearby Puget Sound station — that replaces refreshing the NDBC station page.

Single-file app (`index.html`), no build step, no dependencies. Optional 90-line Node proxy for the 10-minute NDBC feed.

## Run

```
node proxy.js          # http://localhost:8787
```

Or just open `index.html` directly: it works without the proxy, using NWS hourly observations instead of NDBC's 10-minute feed.

## What it shows

- **Wind now** — big number, direction, gust, 1-hour trend, Beaufort badge, compass rose with a 3-hour direction trail
- **Wind history** — 24h to 45d, speed area + gust dots + direction arrows, with the NWS hourly *forecast* dashed onto the next 24h so you see where it's going, not just where it's been
- **Wind rose** — 16-sector histogram for the selected range, stacked by speed band (area ∝ frequency), with prevailing direction, mean, calm % and ≥15 kt %. Click a sector to filter the wind chart to that direction (click again or the chip to clear)
- **Diurnal heatmap** — hour of day × day, cell color = mean wind that hour, hover for avg/gust
- **Compare** — pick a second station in the header; its wind and pressure overlay the charts in pink, the hero shows its current wind and the delta vs the primary station
- **Pressure** with 3-hour tendency, **air/water temp**
- **Tide** — CO-OPS predictions with observed water level overlaid, next 4 highs/lows
- **Marine forecast** — the NWS coastal waters forecast (CWF) for the station's zone, with small craft advisories called out
- Dark/light theme, kt / mph / m/s / km/h, °F/°C, localStorage cache so it renders instantly on reopen, auto-refresh every 5 min and on tab focus

## Data sources (all free, no keys)

| Source | What | CORS | Notes |
|---|---|---|---|
| `https://www.ndbc.noaa.gov/data/realtime2/WPOW1.cwind` | 10-min continuous wind (dir, speed, gust), last 45 days | **no** | Best resolution. Needs the proxy. |
| `https://www.ndbc.noaa.gov/data/realtime2/WPOW1.txt` | Hourly standard met (pressure, air/water temp, dew point, waves), 45 days | **no** | Whitespace-delimited, `MM` = missing |
| `https://api.weather.gov/stations/WPOW1/observations` | Same station, hourly, JSON, ~7 days | yes | Fallback when no proxy |
| `https://api.weather.gov/gridpoints/SEW/122,71/forecast/hourly` | Hourly wind forecast | yes | Grid point resolved from `/points/{lat},{lon}` |
| `https://api.weather.gov/products/types/CWF/locations/SEW` | Coastal waters forecast text | yes | Parsed per zone (PZZ135 = Puget Sound) — the API's `/zones/forecast/PZZ135/forecast` returns "marine not supported" |
| `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter` | Tide predictions, hi/lo, observed water level (station 9447130) | yes | |

Things checked and rejected: `sdf.ndbc.noaa.gov` SOS/ERDDAP (unreachable), `latest_obs/WPOW1.txt` (404), CO-OPS wind/air temp at 9447130 (not offered).

## Files

- `index.html` — everything
- `proxy.js` — static server + `/ndbc/*` → `https://www.ndbc.noaa.gov/data/*` with CORS and a 5-minute cache

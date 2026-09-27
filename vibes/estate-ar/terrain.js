/**
 * Terrain and viewer height for Estate AR.
 *
 * Two questions the AR geometry needs answered in metres:
 *   1. How high is the ground under each parcel relative to the ground under me?  (hills)
 *   2. How high is my eye above the ground under me?                               (high-rises)
 *
 * Ground elevation comes from public DEM services that allow CORS:
 *   - Open-Meteo elevation API: Copernicus GLO-90, up to 100 points per call, no key.
 *     Used for parcels in bulk (one call per 100 parcels).
 *   - USGS EPQS (epqs.nationalmap.gov): 3DEP, ~1 m, one point per call, US only.
 *     Used for the precise ground under the viewer; Open-Meteo if it fails.
 * Elevations are cached on a ~30 m grid so a slowly moving viewer does not re-ask.
 *
 * Eye height above ground: GPS altitude is the weak link (ellipsoidal, ±15–30 m, often
 * null indoors). We fuse it: geoid-correct to orthometric height, subtract the ground,
 * smooth over many fixes weighted by altitudeAccuracy, and only trust the result when
 * the weighted uncertainty is small. Otherwise the last trusted value, else 1.6 m.
 * The user can override with a manual floor number (storey ≈ 3.2 m).
 *
 * UMD: window.Terrain in the browser, module.exports in bun tests.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Terrain = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STOREY_M = 3.2;        // metres per floor, typical residential/office
  const EYE_STANDING = 1.6;    // metres, eye above the floor you stand on
  const GRID_M = 30;           // elevation cache cell

  // ---- geoid: EGM96-ish offsets (metres, geoid above ellipsoid) for the regions we serve.
  // GPS altitude is above the WGS84 ellipsoid; ground elevations are above the geoid (sea level).
  // A single per-region number is accurate to ~1 m over a county, plenty for this purpose.
  const GEOID = [
    { lat: [46.5, 49.5], lon: [-124.9, -116.9], n: -20.5 },   // Washington
    { lat: [32.5, 42.1], lon: [-124.5, -114.0], n: -33.0 },   // California (LA ≈ -33.5, SF ≈ -32.5)
  ];
  function geoidOffset(lat, lon) {
    for (const g of GEOID) if (lat >= g.lat[0] && lat <= g.lat[1] && lon >= g.lon[0] && lon <= g.lon[1]) return g.n;
    return -20;   // conservative CONUS-ish default
  }

  // ---- elevation cache ----------------------------------------------------
  const cache = new Map();   // "i,j" -> metres
  const cellKey = (lat, lon) => {
    const mLat = 111320, mLon = 111320 * Math.cos(lat * Math.PI / 180);
    return `${Math.round(lat * mLat / GRID_M)},${Math.round(lon * mLon / GRID_M)}`;
  };
  function cached(lat, lon) { const v = cache.get(cellKey(lat, lon)); return v === undefined ? null : v; }
  function remember(lat, lon, m) { cache.set(cellKey(lat, lon), m); }

  async function openMeteo(points, fetchImpl) {
    const f = fetchImpl || fetch, out = new Array(points.length).fill(null);
    for (let i = 0; i < points.length; i += 100) {
      const chunk = points.slice(i, i + 100);
      const url = `https://api.open-meteo.com/v1/elevation?latitude=${chunk.map((p) => p[0].toFixed(5)).join(",")}&longitude=${chunk.map((p) => p[1].toFixed(5)).join(",")}`;
      const r = await f(url); if (!r.ok) throw new Error(`open-meteo ${r.status}`);
      const j = await r.json();
      (j.elevation || []).forEach((e, k) => { if (typeof e === "number") out[i + k] = e; });
    }
    return out;
  }
  async function usgs(lat, lon, fetchImpl) {
    const f = fetchImpl || fetch;
    const r = await f(`https://epqs.nationalmap.gov/v1/json?x=${lon.toFixed(6)}&y=${lat.toFixed(6)}&units=Meters&wkid=4326&includeDate=false`);
    if (!r.ok) throw new Error(`epqs ${r.status}`);
    const j = await r.json(), v = parseFloat(j.value);
    if (!isFinite(v) || v < -500) throw new Error("epqs no data");
    return v;
  }

  /**
   * Ground elevation (m above sea level) for many points, cached. Returns an array
   * aligned with `points`; entries are null where no source answered.
   */
  async function elevations(points, fetchImpl) {
    const out = points.map(([lat, lon]) => cached(lat, lon));
    const need = []; out.forEach((v, i) => { if (v == null) need.push(i); });
    if (!need.length) return out;
    // dedupe by cell
    const byCell = new Map(); for (const i of need) { const k = cellKey(points[i][0], points[i][1]); if (!byCell.has(k)) byCell.set(k, []); byCell.get(k).push(i); }
    const reps = [...byCell.values()].map((idx) => points[idx[0]]);
    let vals; try { vals = await openMeteo(reps, fetchImpl); } catch (e) { return out; }
    [...byCell.values()].forEach((idx, k) => { if (vals[k] != null) { remember(points[idx[0]][0], points[idx[0]][1], vals[k]); for (const i of idx) out[i] = vals[k]; } });
    return out;
  }

  /** Ground elevation under one point, precise (USGS) with Open-Meteo fallback. */
  async function elevationAt(lat, lon, fetchImpl) {
    const c = cached(lat, lon); if (c != null) return c;
    let v = null;
    try { v = await usgs(lat, lon, fetchImpl); } catch (e) { try { v = (await openMeteo([[lat, lon]], fetchImpl))[0]; } catch (e2) { /* offline */ } }
    if (v != null) remember(lat, lon, v);
    return v;
  }

  // ---- viewer height fusion ----------------------------------------------
  /**
   * Running estimate of eye height above local ground from GPS fixes.
   *   feed(alt, altAcc, groundElev, lat, lon)  per fix; alt/altAcc may be null
   *   eye()  -> { m, source: "gps"|"manual"|"default", floor, uncertainty }
   */
  function viewerHeight(opts) {
    const o = Object.assign({ trustAcc: 12, halfLife: 8, maxAbove: 400 }, opts);
    const s = { sum: 0, wsum: 0, n: 0, lastTrusted: null, manualFloor: null, lastAlt: null, lastAcc: null, lastGround: null };
    function feed(alt, altAcc, groundElev, lat, lon) {
      s.lastAlt = alt; s.lastAcc = altAcc; s.lastGround = groundElev;
      if (alt == null || groundElev == null || !isFinite(alt)) return;
      const acc = altAcc != null && isFinite(altAcc) && altAcc > 0 ? altAcc : 30;
      const above = alt + geoidOffset(lat, lon) - groundElev - EYE_STANDING;   // floor height above ground
      if (above < -30 || above > o.maxAbove) return;                             // garbage fix
      const w = 1 / (acc * acc), decay = Math.pow(0.5, 1 / o.halfLife);
      s.sum = s.sum * decay + above * w; s.wsum = s.wsum * decay + w; s.n++;
      const unc = 1 / Math.sqrt(s.wsum);                                        // metres, 1σ
      if (unc <= o.trustAcc) s.lastTrusted = { above: s.sum / s.wsum, unc };
    }
    function estimate() { return s.wsum > 0 ? { above: s.sum / s.wsum, unc: 1 / Math.sqrt(s.wsum), n: s.n } : null; }
    function setFloor(fl) { s.manualFloor = fl == null || fl === "" ? null : Number(fl); }
    function eye() {
      if (s.manualFloor != null) return { m: Math.max(0, s.manualFloor) * STOREY_M + EYE_STANDING, source: "manual", floor: s.manualFloor, uncertainty: 1.5 };
      if (s.lastTrusted) { const m = Math.max(0, s.lastTrusted.above) + EYE_STANDING; return { m, source: "gps", floor: Math.round(Math.max(0, s.lastTrusted.above) / STOREY_M), uncertainty: s.lastTrusted.unc }; }
      return { m: EYE_STANDING, source: "default", floor: 0, uncertainty: null };
    }
    return { feed, eye, estimate, setFloor, get manualFloor() { return s.manualFloor; } };
  }

  return { STOREY_M, EYE_STANDING, GRID_M, geoidOffset, elevations, elevationAt, viewerHeight, _cache: cache };
});

/*
 * geo.js - geometry for a camera-passthrough property viewer.
 *
 *   - haversine distance / initial bearing (spherical)
 *   - polygon centroid and bounding box (shoelace on a local tangent plane)
 *   - angular span of a parcel as seen from the viewer (for label width)
 *   - point-in-polygon (ray casting)
 *   - bearing -> screen x, pitch -> screen y for a pinhole camera
 *   - compass helpers: wrap, shortest signed difference, low-pass on a circle
 *   - money formatting
 *
 * Distances in metres, angles in degrees, bearings clockwise from true north.
 * Browser global (window.Geo) or CommonJS module.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Geo = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const R = 6371008.8;
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  function wrap360(a) { a = a % 360; return a < 0 ? a + 360 : a; }
  /** Signed shortest difference a - b in (-180, 180]. */
  function angleDiff(a, b) { let d = (a - b) % 360; if (d > 180) d -= 360; if (d <= -180) d += 360; return d; }

  function haversine(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R;
    const dp = p2 - p1, dl = (lon2 - lon1) * D2R;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return wrap360(Math.atan2(y, x) * R2D);
  }

  /** Local metres-per-degree at a latitude (equirectangular, fine for a few km). */
  function metresPerDegree(lat) {
    return { lat: 111132.954 - 559.822 * Math.cos(2 * lat * D2R), lon: 111132.954 * Math.cos(lat * D2R) };
  }

  /**
   * Centroid of a ring given as [[lon, lat], ...]. Computed with the shoelace
   * formula on a local plane so long east-west parcels are not biased.
   * Falls back to the vertex mean for degenerate (zero-area) rings.
   */
  function ringCentroid(ring) {
    if (!ring || ring.length === 0) return null;
    const lat0 = ring[0][1], lon0 = ring[0][0];
    const mpd = metresPerDegree(lat0);
    const pts = ring.map(([lon, lat]) => [(lon - lon0) * mpd.lon, (lat - lat0) * mpd.lat]);
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
      const f = x1 * y2 - x2 * y1;
      a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
    }
    if (Math.abs(a) < 1e-6) {
      const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
      const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
      return { lat: lat0 + my / mpd.lat, lon: lon0 + mx / mpd.lon, areaM2: 0 };
    }
    a *= 0.5; cx /= (6 * a); cy /= (6 * a);
    return { lat: lat0 + cy / mpd.lat, lon: lon0 + cx / mpd.lon, areaM2: Math.abs(a) };
  }

  /** Largest ring (by |area|) of an Esri polygon {rings:[[[lon,lat],...],...]}. */
  function outerRing(rings) {
    let best = null, bestA = -1;
    for (const r of rings || []) {
      const c = ringCentroid(r);
      if (c && c.areaM2 > bestA) { bestA = c.areaM2; best = r; }
    }
    return best;
  }

  /** Ray-casting point in ring. */
  function pointInRing(lat, lon, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /**
   * How the parcel looks from the viewer: bearing to centroid, min distance to
   * any vertex, and the angular span [left, right] (degrees) the ring subtends.
   * The span is measured around the centroid bearing so parcels behind the
   * viewer or wrapping across north are handled.
   */
  function parcelView(lat, lon, ring, centroid) {
    const c = centroid || ringCentroid(ring);
    const brg = bearing(lat, lon, c.lat, c.lon);
    let minD = Infinity, lo = 0, hi = 0;
    for (const [vlon, vlat] of ring) {
      const d = haversine(lat, lon, vlat, vlon);
      if (d < minD) minD = d;
      const off = angleDiff(bearing(lat, lon, vlat, vlon), brg);
      if (off < lo) lo = off; if (off > hi) hi = off;
    }
    const span = Math.min(hi - lo, 359);
    return {
      bearing: brg,
      distance: haversine(lat, lon, c.lat, c.lon),
      nearest: minD,
      spanDeg: span,
      inside: pointInRing(lat, lon, ring),
    };
  }

  /**
   * Pinhole projection. Returns screen coordinates (px) for a target at
   * (bearing, pitch) given the camera (heading, pitch) and horizontal FOV.
   * Returns null when the target is outside the frustum (with margin).
   */
  function project(targetBearing, targetPitch, heading, camPitch, hfovDeg, width, height, marginDeg) {
    const dx = angleDiff(targetBearing, heading);
    const half = hfovDeg / 2;
    if (Math.abs(dx) > half + (marginDeg || 0)) return null;
    const f = (width / 2) / Math.tan(half * D2R);      // focal length in px
    const x = width / 2 + f * Math.tan(dx * D2R);
    const dy = targetPitch - camPitch;
    const y = height / 2 - f * Math.tan(Math.max(-80, Math.min(80, dy)) * D2R);
    return { x, y, dx, focal: f };
  }

  /** Elevation angle (deg) to a point `distance` away and `dh` metres higher than the eye. */
  function pitchTo(distance, dh) { return Math.atan2(dh, Math.max(distance, 0.1)) * R2D; }

  /**
   * Exponential low-pass on a circular quantity. `alpha` in (0,1]; higher is
   * snappier. Never crosses the long way round north.
   */
  function smoothHeading(prev, next, alpha) {
    if (prev == null || !isFinite(prev)) return wrap360(next);
    return wrap360(prev + alpha * angleDiff(next, prev));
  }

  const CARDINALS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  function cardinal(deg) { return CARDINALS[Math.round(wrap360(deg) / 22.5) % 16]; }

  function fmtMoney(v, compact) {
    if (v == null || !isFinite(v)) return "—";
    if (compact) {
      if (v >= 1e9) return "$" + (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + "B";
      if (v >= 1e6) return "$" + (v / 1e6).toFixed(v >= 1e7 ? 0 : 2).replace(/\.?0+$/, "") + "M";
      if (v >= 1e3) return "$" + Math.round(v / 1e3) + "K";
      return "$" + Math.round(v);
    }
    return "$" + Math.round(v).toLocaleString("en-US");
  }

  function fmtDistance(m, imperial) {
    if (imperial) { const ft = m * 3.28084; return ft < 1000 ? Math.round(ft) + " ft" : (ft / 5280).toFixed(1) + " mi"; }
    return m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(1) + " km";
  }

  /**
   * Web Mercator (EPSG:3857) <-> WGS84. King County returns 3857 when asked
   * for outSR=102100; we ask for 4326 but keep this for completeness/tests.
   */
  function mercToLatLon(x, y) {
    const lon = x / 6378137 * R2D;
    const lat = (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * R2D;
    return { lat, lon };
  }

  return {
    R, wrap360, angleDiff, haversine, bearing, metresPerDegree,
    ringCentroid, outerRing, pointInRing, parcelView, project, pitchTo,
    smoothHeading, cardinal, fmtMoney, fmtDistance, mercToLatLon,
  };
}));

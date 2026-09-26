/*
 * nav.js - navigation math for a small-craft chart plotter.
 *
 * A JavaScript port of the pieces of OpenCPN's model/src/georef.cpp and
 * routeman.cpp that a browser plotter needs:
 *
 *   - great-circle distance/bearing (haversine, spherical)
 *   - Mercator (rhumb-line) sailing, which is what OpenCPN uses for route legs
 *   - forward problem: destination from (lat, lon, bearing, distance)
 *   - cross-track error, along-track range, arrival test (Routeman::UpdateProgress)
 *   - VMG / closing velocity, TTG / ETA
 *   - coordinate formatting and parsing (decimal, D M.m, D M S)
 *
 * All distances are in metres unless the name says otherwise, all angles in
 * degrees true, clockwise from north. Works as a browser global (window.Nav)
 * or a CommonJS module. Not for primary navigation.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Nav = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const R = 6371008.8;            // mean Earth radius, metres (IUGG)
  const NM = 1852;                // metres per nautical mile
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const MS_TO_KN = 3600 / NM;     // 1.943844...

  function wrap360(d) { d = d % 360; return d < 0 ? d + 360 : d; }
  function wrap180(d) { d = wrap360(d); return d > 180 ? d - 360 : d; }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ---------------------------------------------------------------------
  // Great circle (spherical)
  // ---------------------------------------------------------------------
  function haversine(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  /** Initial great-circle bearing from 1 to 2, degrees true. */
  function bearing(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return wrap360(Math.atan2(y, x) * R2D);
  }

  /** Destination along a great circle. Returns {lat, lon}. */
  function destination(lat, lon, brg, distM) {
    const d = distM / R, b = brg * D2R, p1 = lat * D2R, l1 = lon * D2R;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 * R2D, lon: wrap180(l2 * R2D) };
  }

  // ---------------------------------------------------------------------
  // Mercator / rhumb-line sailing (OpenCPN DistanceBearingMercator)
  // A rhumb line keeps a constant true bearing, which is what you steer.
  // Over Puget Sound distances it differs from the great circle by metres.
  // ---------------------------------------------------------------------
  function rhumb(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R;
    let dl = (lon2 - lon1) * D2R;
    if (Math.abs(dl) > Math.PI) dl = dl > 0 ? -(2 * Math.PI - dl) : (2 * Math.PI + dl);
    const dPsi = Math.log(Math.tan(Math.PI / 4 + p2 / 2) / Math.tan(Math.PI / 4 + p1 / 2));
    const dPhi = p2 - p1;
    // q = dPhi/dPsi, but for E-W legs dPsi -> 0 so fall back to cos(lat)
    const q = Math.abs(dPsi) > 1e-12 ? dPhi / dPsi : Math.cos(p1);
    const dist = Math.sqrt(dPhi * dPhi + q * q * dl * dl) * R;
    const brg = wrap360(Math.atan2(dl, dPsi) * R2D);
    return { distance: dist, bearing: brg };
  }

  /** Rhumb-line destination. */
  function rhumbDestination(lat, lon, brg, distM) {
    const d = distM / R, b = brg * D2R, p1 = lat * D2R, l1 = lon * D2R;
    const dPhi = d * Math.cos(b);
    let p2 = p1 + dPhi;
    if (Math.abs(p2) > Math.PI / 2) p2 = p2 > 0 ? Math.PI - p2 : -Math.PI - p2;
    const dPsi = Math.log(Math.tan(p2 / 2 + Math.PI / 4) / Math.tan(p1 / 2 + Math.PI / 4));
    const q = Math.abs(dPsi) > 1e-12 ? dPhi / dPsi : Math.cos(p1);
    const dl = d * Math.sin(b) / q;
    return { lat: p2 * R2D, lon: wrap180((l1 + dl) * R2D) };
  }

  // ---------------------------------------------------------------------
  // Local tangent plane helpers (east/north metres about an origin)
  // ---------------------------------------------------------------------
  function toEN(lat, lon, olat, olon) {
    const cos = Math.cos(olat * D2R);
    return {
      e: (lon - olon) * D2R * R * cos,
      n: (lat - olat) * D2R * R,
    };
  }
  function fromEN(e, n, olat, olon) {
    const cos = Math.cos(olat * D2R);
    return { lat: olat + n / R * R2D, lon: olon + e / (R * cos) * R2D };
  }

  // ---------------------------------------------------------------------
  // Active-leg progress. Port of Routeman::UpdateProgress.
  //
  //   from  - start of the current leg (previous waypoint, or the boat's
  //           position when the leg was activated; OpenCPN's virtual "Begin")
  //   to    - the active waypoint
  //   boat  - {lat, lon}, optional sog (m/s) and cog (deg)
  //
  // Returns:
  //   brg           bearing boat -> waypoint (rhumb)
  //   dtg           distance boat -> waypoint, metres
  //   xte           cross-track error, metres; positive = boat is RIGHT of
  //                 the course line (steer left to correct)
  //   alongTrack    remaining distance measured along the leg to the line
  //                 through the waypoint perpendicular to the leg
  //                 (OpenCPN's RangeToNormalCrossing)
  //   legCourse     bearing from -> to
  //   vmg           closing speed toward waypoint, m/s (sog*cos(cog-brg))
  //   ttgSec        time to go at current VMG, or null
  //   arrived       alongTrack <= arrivalRadius (negative radius = never)
  // ---------------------------------------------------------------------
  function legProgress(from, to, boat, arrivalRadiusM) {
    const rb = rhumb(boat.lat, boat.lon, to.lat, to.lon);
    const leg = rhumb(from.lat, from.lon, to.lat, to.lon);

    // Work in a local plane about the waypoint.
    const pb = toEN(boat.lat, boat.lon, to.lat, to.lon);   // boat rel. wp
    const pa = toEN(from.lat, from.lon, to.lat, to.lon);   // leg start rel. wp
    const legLen = Math.hypot(pa.e, pa.n);
    let xte = 0, along = rb.distance;
    if (legLen > 1e-3) {
      // unit vector along the leg (from -> to), pointing at the waypoint
      const ux = -pa.e / legLen, uy = -pa.n / legLen;
      // boat->wp vector
      const vx = -pb.e, vy = -pb.n;
      along = vx * ux + vy * uy;                      // signed along-track remaining
      // boat rel. leg start, projected perpendicular to the leg. With u = along-track
      // (east, north), a boat to starboard has positive (u.n * dE - u.e * dN) since
      // east is +x and north is +y in this local frame.
      const bx = pb.e - pa.e, by = pb.n - pa.n;
      xte = uy * bx - ux * by;
    }
    let vmg = null, ttgSec = null;
    if (boat.sog != null && boat.cog != null) {
      vmg = boat.sog * Math.cos((boat.cog - rb.bearing) * D2R);
      if (vmg > 0.05) ttgSec = rb.distance / vmg;
    }
    const radius = arrivalRadiusM == null ? 0.05 * NM : arrivalRadiusM;
    const arrived = radius >= 0 && along <= radius;
    return {
      brg: rb.bearing, dtg: rb.distance, xte, alongTrack: along,
      legCourse: leg.bearing, legLength: leg.distance, vmg, ttgSec, arrived,
    };
  }

  /** Sum leg lengths (rhumb) for an array of {lat, lon}. */
  function routeLength(points) {
    let m = 0;
    for (let i = 1; i < points.length; i++) {
      m += rhumb(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon).distance;
    }
    return m;
  }

  /** Per-leg table: [{from, to, distance, bearing, cumulative}] */
  function routeLegs(points) {
    const legs = [];
    let cum = 0;
    for (let i = 1; i < points.length; i++) {
      const r = rhumb(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
      cum += r.distance;
      legs.push({ index: i, from: points[i - 1], to: points[i], distance: r.distance, bearing: r.bearing, cumulative: cum });
    }
    return legs;
  }

  /** ETA for a distance at a speed: returns Date or null. */
  function eta(distM, speedMs, now) {
    if (!(speedMs > 0.05)) return null;
    return new Date((now == null ? Date.now() : now) + (distM / speedMs) * 1000);
  }

  // ---------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------
  function pad(n, w) { return String(n).padStart(w, "0"); }

  function toDM(deg, isLat, decimals) {
    const hemi = isLat ? (deg < 0 ? "S" : "N") : (deg < 0 ? "W" : "E");
    const abs = Math.abs(deg);
    let d = Math.floor(abs);
    let m = (abs - d) * 60;
    const dec = decimals == null ? 3 : decimals;
    if (Number(m.toFixed(dec)) >= 60) { d += 1; m = 0; }
    return `${pad(d, isLat ? 2 : 3)}\u00B0${m.toFixed(dec).padStart(dec + 3, "0")}'${hemi}`;
  }
  function fmtPos(lat, lon) { return toDM(lat, true) + " " + toDM(lon, false); }

  function fmtNm(m) {
    const nm = m / NM;
    if (nm < 0.1) return Math.round(m) + " m";
    if (nm < 10) return nm.toFixed(2) + " NM";
    if (nm < 100) return nm.toFixed(1) + " NM";
    return Math.round(nm) + " NM";
  }
  function fmtBrg(deg) { return pad(Math.round(wrap360(deg)) % 360, 3) + "\u00B0"; }
  function fmtKn(ms) { return (ms * MS_TO_KN).toFixed(1); }
  function fmtDuration(sec) {
    if (sec == null || !isFinite(sec)) return "--";
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    if (h > 0) return `${h}:${pad(m, 2)}:${pad(s, 2)}`;
    return `${m}:${pad(s, 2)}`;
  }
  function fmtDepth(m, unit) {
    if (m == null || !isFinite(m)) return "--";
    if (unit === "ft") return (m * 3.28084).toFixed(m * 3.28084 < 10 ? 1 : 0);
    if (unit === "fm") return (m / 1.8288).toFixed(1);
    return m.toFixed(m < 10 ? 1 : 0);
  }
  const DEPTH_UNIT_LABEL = { m: "m", ft: "ft", fm: "fm" };
  function depthToMetres(v, unit) {
    if (unit === "ft") return v / 3.28084;
    if (unit === "fm") return v * 1.8288;
    return v;
  }

  // ---------------------------------------------------------------------
  // Parsing: accepts "47.68, -122.41", "47°41.064'N 122°24.679'W",
  // "47 41 03.8 N 122 24 40.7 W", Google Maps URLs.
  // ---------------------------------------------------------------------
  function parseLatLon(text) {
    if (!text) return null;
    text = String(text).trim();
    const url = text.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/) ||
      text.match(/[?&](?:q|ll|query)=(-?\d+\.?\d*),(-?\d+\.?\d*)/);
    if (url) return { lat: +url[1], lon: +url[2] };

    // D M S with hemispheres
    const dms = /(\d{1,3})[°\s]+(\d{1,2})['\s]+(\d{1,2}(?:\.\d+)?)["\s]*([NS])[,\s]+(\d{1,3})[°\s]+(\d{1,2})['\s]+(\d{1,2}(?:\.\d+)?)["\s]*([EW])/i;
    let m = text.match(dms);
    if (m) {
      let lat = +m[1] + m[2] / 60 + m[3] / 3600;
      let lon = +m[5] + m[6] / 60 + m[7] / 3600;
      if (/s/i.test(m[4])) lat = -lat;
      if (/w/i.test(m[8])) lon = -lon;
      return { lat, lon };
    }
    // D M.m with hemispheres
    const dm = /(\d{1,3})[°\s]+(\d{1,2}(?:\.\d+)?)['\s]*([NS])[,\s]+(\d{1,3})[°\s]+(\d{1,2}(?:\.\d+)?)['\s]*([EW])/i;
    m = text.match(dm);
    if (m) {
      let lat = +m[1] + m[2] / 60;
      let lon = +m[4] + m[5] / 60;
      if (/s/i.test(m[3])) lat = -lat;
      if (/w/i.test(m[6])) lon = -lon;
      return { lat, lon };
    }
    // decimal pair
    const parts = text.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (parts.length >= 2 && parts.every(isFinite)) {
      if (Math.abs(parts[0]) <= 90 && Math.abs(parts[1]) <= 180) return { lat: parts[0], lon: parts[1] };
    }
    return null;
  }

  return {
    R, NM, MS_TO_KN, wrap360, wrap180, clamp,
    haversine, bearing, destination, rhumb, rhumbDestination, toEN, fromEN,
    legProgress, routeLength, routeLegs, eta,
    toDM, fmtPos, fmtNm, fmtBrg, fmtKn, fmtDuration, fmtDepth, depthToMetres, DEPTH_UNIT_LABEL,
    parseLatLon,
  };
}));

/*
 * geo.js - geometry for a camera-passthrough marine traffic viewer.
 *
 *   - haversine distance / bearing / destination (spherical)
 *   - local ENU tangent plane (metres east/north of the viewer)
 *   - ring centroid, bbox, point-in-ring
 *   - Camera: a pinhole camera standing `eyeHeight` metres above the water,
 *     with heading / pitch / roll. Projects world points on the sea surface
 *     to screen pixels and clips polygons/polylines at the near plane so a
 *     lane that passes under or behind the viewer still draws correctly.
 *   - horizon dip and distance for an eye height (with standard refraction)
 *   - AIS helpers: hull footprint from A/B/C/D dimensions, dead reckoning,
 *     CPA / TCPA between two moving targets
 *   - lane direction arrows: sample points inside a lane polygon and lay a
 *     small arrow at each, pointing along the charted ORIENT
 *   - compass helpers and formatting (metres / nautical miles, knots)
 *
 * Distances in metres, speeds in knots, angles in degrees, bearings clockwise
 * from true north. Rings are [[lon, lat], ...] like GeoJSON / Esri.
 * Browser global (window.Geo) or CommonJS module.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Geo = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const R = 6371008.8;
  const NM = 1852;
  const KN = NM / 3600;                 // metres per second in one knot
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

  /** Point `distM` along `brg` from (lat, lon). */
  function destination(lat, lon, brg, distM) {
    const p1 = lat * D2R, l1 = lon * D2R, b = brg * D2R, d = distM / R;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 * R2D, lon: ((l2 * R2D + 540) % 360) - 180 };
  }

  /** Local metres-per-degree at a latitude (equirectangular, fine for tens of km). */
  function metresPerDegree(lat) {
    return { lat: 111132.954 - 559.822 * Math.cos(2 * lat * D2R), lon: 111132.954 * Math.cos(lat * D2R) };
  }

  /** East/north metres of (lat, lon) relative to origin (lat0, lon0). */
  function toENU(lat0, lon0, lat, lon) {
    const mpd = metresPerDegree(lat0);
    let dlon = lon - lon0; if (dlon > 180) dlon -= 360; if (dlon < -180) dlon += 360;
    return { e: dlon * mpd.lon, n: (lat - lat0) * mpd.lat };
  }
  function fromENU(lat0, lon0, e, n) {
    const mpd = metresPerDegree(lat0);
    return { lat: lat0 + n / mpd.lat, lon: lon0 + e / mpd.lon };
  }

  // ---- rings --------------------------------------------------------------

  function ringBBox(ring) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [lon, lat] of ring) { if (lon < w) w = lon; if (lon > e) e = lon; if (lat < s) s = lat; if (lat > n) n = lat; }
    return [w, s, e, n];
  }

  /** Shoelace centroid on a local plane; falls back to vertex mean for degenerate rings. */
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

  /** Shortest distance (m) from a point to a ring's edges. */
  function distanceToRing(lat, lon, ring) {
    const pts = ring.map(([rlon, rlat]) => toENU(lat, lon, rlat, rlon));
    let best = Infinity;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j], b = pts[i];
      const dx = b.e - a.e, dy = b.n - a.n, l2 = dx * dx + dy * dy;
      let t = l2 === 0 ? 0 : ((-a.e) * dx + (-a.n) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      const px = a.e + t * dx, py = a.n + t * dy;
      const d = Math.hypot(px, py);
      if (d < best) best = d;
    }
    return best;
  }

  // ---- horizon ------------------------------------------------------------

  /** Dip of the sea horizon below eye level, degrees (Bowditch, refracted). */
  function horizonDip(eyeHeightM) { return 1.76 * Math.sqrt(Math.max(0, eyeHeightM)) / 60; }
  /** Distance to the sea horizon, metres (refracted). */
  function horizonDistance(eyeHeightM) { return 3860 * Math.sqrt(Math.max(0, eyeHeightM)); }
  /**
   * Depression angle (deg, negative = below eye level) of a point on the sea
   * surface `d` metres away as seen from `h` metres up, including earth
   * curvature. Beyond the horizon this keeps decreasing gently, which is what
   * we want for drawing hull-down ships just under the horizon line.
   */
  function seaPitch(d, h) {
    const drop = d * d / (2 * R) * 0.86;   // refracted curvature drop
    return -Math.atan2(h + drop, Math.max(d, 0.1)) * R2D;
  }

  // ---- camera -------------------------------------------------------------

  /**
   * Pinhole camera at the viewer, `eyeHeight` m above the water, oriented by
   * true heading (deg cw from N), pitch (deg, up positive) and roll (deg, cw
   * positive). `hfov` is the horizontal field of view in degrees.
   *
   * World frame: e east, n north, u up (metres from the viewer's feet).
   */
  class Camera {
    constructor(o) {
      this.width = o.width; this.height = o.height;
      this.hfov = o.hfov; this.eyeHeight = o.eyeHeight == null ? 2 : o.eyeHeight;
      this.near = o.near || 0.5;
      this.focal = (this.width / 2) / Math.tan(this.hfov / 2 * D2R);
      this.setOrientation(o.heading || 0, o.pitch || 0, o.roll || 0);
    }
    setOrientation(heading, pitch, roll) {
      this.heading = heading; this.pitch = pitch; this.roll = roll;
      const h = heading * D2R, p = pitch * D2R, r = roll * D2R;
      this.ch = Math.cos(h); this.sh = Math.sin(h);
      this.cp = Math.cos(p); this.sp = Math.sin(p);
      this.cr = Math.cos(r); this.sr = Math.sin(r);
    }
    /** World (e, n, u) -> camera (right, up, fwd). */
    toCam(e, n, u) {
      // yaw: heading rotates world so that "forward" is the heading direction
      const right0 = e * this.ch - n * this.sh;
      const fwd0 = e * this.sh + n * this.ch;
      // pitch about the right axis
      const fwd1 = fwd0 * this.cp + u * this.sp;
      const up1 = -fwd0 * this.sp + u * this.cp;
      // roll about the forward axis
      const right = right0 * this.cr - up1 * this.sr;
      const up = right0 * this.sr + up1 * this.cr;
      return { r: right, u: up, f: fwd1 };
    }
    /** Camera coords -> screen px, or null when behind the near plane. */
    toScreen(c) {
      if (c.f < this.near) return null;
      return { x: this.width / 2 + this.focal * c.r / c.f, y: this.height / 2 - this.focal * c.u / c.f, depth: c.f };
    }
    /** Project a world point; null when behind. */
    project(e, n, u) { return this.toScreen(this.toCam(e, n, u)); }
    /** Project a point on the sea surface (u = -eyeHeight, with curvature drop). */
    projectSea(e, n) {
      const d = Math.hypot(e, n);
      const drop = d * d / (2 * R) * 0.86;
      return this.project(e, n, -this.eyeHeight - drop);
    }
    /** Where a (bearing, pitch) direction lands on screen (for the horizon/tape); null if outside ±100°. */
    projectDirection(brg, pitchDeg) {
      const dx = angleDiff(brg, this.heading);
      if (Math.abs(dx) > 100) return null;
      const b = brg * D2R, p = pitchDeg * D2R;
      const e = Math.sin(b) * Math.cos(p), n = Math.cos(b) * Math.cos(p), u = Math.sin(p);
      return this.project(e * 1e6, n * 1e6, u * 1e6);
    }
    /**
     * Clip a closed ring of camera-space points against the near plane
     * (Sutherland-Hodgman on f >= near). Returns [] when fully behind.
     */
    clipRing(cam) {
      const out = [], N = this.near;
      for (let i = 0; i < cam.length; i++) {
        const a = cam[i], b = cam[(i + 1) % cam.length];
        const ain = a.f >= N, bin = b.f >= N;
        if (ain) out.push(a);
        if (ain !== bin) {
          const t = (N - a.f) / (b.f - a.f);
          out.push({ r: a.r + t * (b.r - a.r), u: a.u + t * (b.u - a.u), f: N });
        }
      }
      return out;
    }
    /** Clip an open polyline; returns an array of visible pieces (each an array of cam points). */
    clipPolyline(cam) {
      const pieces = [], N = this.near; let cur = [];
      for (let i = 0; i < cam.length; i++) {
        const a = cam[i], b = cam[i + 1];
        if (a.f >= N) cur.push(a);
        if (b && (a.f >= N) !== (b.f >= N)) {
          const t = (N - a.f) / (b.f - a.f);
          const p = { r: a.r + t * (b.r - a.r), u: a.u + t * (b.u - a.u), f: N };
          cur.push(p);
          if (a.f >= N) { pieces.push(cur); cur = []; }
        }
      }
      if (cur.length > 1) pieces.push(cur);
      return pieces;
    }
    /** Ring of [lon,lat] on the sea -> screen polygon [{x,y}] (clipped), given viewer lat/lon. */
    projectSeaRing(ring, lat0, lon0) {
      const cam = ring.map(([lon, lat]) => {
        const { e, n } = toENU(lat0, lon0, lat, lon);
        const d = Math.hypot(e, n);
        return this.toCam(e, n, -this.eyeHeight - d * d / (2 * R) * 0.86);
      });
      return this.clipRing(cam).map((c) => this.toScreen(c));
    }
    projectSeaLine(line, lat0, lon0) {
      const cam = line.map(([lon, lat]) => {
        const { e, n } = toENU(lat0, lon0, lat, lon);
        const d = Math.hypot(e, n);
        return this.toCam(e, n, -this.eyeHeight - d * d / (2 * R) * 0.86);
      });
      return this.clipPolyline(cam).map((piece) => piece.map((c) => this.toScreen(c)));
    }
  }

  // ---- AIS helpers -----------------------------------------------------------

  /**
   * Hull footprint from AIS reference-point dimensions (metres from the GPS
   * antenna: a to bow, b to stern, c to port, d to starboard) and true heading.
   * Returns a 5-point ring [bow-port, bow-stbd, stern-stbd, stern-port, bow-tip?]
   * Actually: 4 corners + a bow point so the shape reads as a ship.
   */
  function hullFootprint(lat, lon, headingDeg, dims) {
    const a = dims && dims.a || 0, b = dims && dims.b || 0, c = dims && dims.c || 0, d = dims && dims.d || 0;
    const L = a + b, B = c + d;
    if (L <= 0 || B <= 0) return null;
    const h = (headingDeg || 0) * D2R, ch = Math.cos(h), sh = Math.sin(h);
    // ship frame: x starboard, y forward. World: e = x*cos(h) + y*sin(h); n = -x*sin(h) + y*cos(h)
    const pts = [
      [-c, a - L * 0.15],   // port shoulder
      [0, a],               // bow tip
      [d, a - L * 0.15],    // starboard shoulder
      [d, -b],              // starboard quarter
      [-c, -b],             // port quarter
    ];
    return pts.map(([x, y]) => {
      const e = x * ch + y * sh, n = -x * sh + y * ch;
      const p = fromENU(lat, lon, e, n);
      return [p.lon, p.lat];
    });
  }

  /** Position `dtSec` after a report, moving at sog knots along cog. */
  function deadReckon(lat, lon, sogKn, cogDeg, dtSec) {
    if (!isFinite(sogKn) || !isFinite(cogDeg) || sogKn <= 0 || dtSec <= 0) return { lat, lon };
    return destination(lat, lon, cogDeg, sogKn * KN * dtSec);
  }

  /**
   * Closest point of approach between own ship and a target, both moving
   * uniformly. Speeds in knots, courses in degrees. Returns {cpaM, tcpaSec,
   * rangeM, bearing}. tcpaSec < 0 means the target is opening.
   */
  function cpa(own, tgt) {
    const { e, n } = toENU(own.lat, own.lon, tgt.lat, tgt.lon);
    const vo = velocity(own.sog, own.cog), vt = velocity(tgt.sog, tgt.cog);
    const dve = vt.e - vo.e, dvn = vt.n - vo.n;     // relative velocity of target wrt own
    const v2 = dve * dve + dvn * dvn;
    const range = Math.hypot(e, n);
    if (v2 < 1e-9) return { cpaM: range, tcpaSec: 0, rangeM: range, bearing: wrap360(Math.atan2(e, n) * R2D), stationary: true };
    const t = -(e * dve + n * dvn) / v2;
    const ce = e + dve * t, cn = n + dvn * t;
    return { cpaM: Math.hypot(ce, cn), tcpaSec: t, rangeM: range, bearing: wrap360(Math.atan2(e, n) * R2D), stationary: false };
  }
  function velocity(sogKn, cogDeg) {
    if (!isFinite(sogKn) || !isFinite(cogDeg)) return { e: 0, n: 0 };
    const v = sogKn * KN, c = cogDeg * D2R;
    return { e: v * Math.sin(c), n: v * Math.cos(c) };
  }

  /**
   * Direction arrows for a traffic lane: grid-sample the polygon at `spacing`
   * metres (grid aligned with the lane orientation), keep the samples inside
   * the ring, and return one arrow polyline [[lon,lat] x 3-5] per sample
   * pointing along `orientDeg`.
   */
  function laneArrows(ring, orientDeg, spacing, arrowLen) {
    spacing = spacing || 700; arrowLen = arrowLen || spacing * 0.35;
    const c = ringCentroid(ring);
    if (!c || !isFinite(orientDeg)) return [];
    const o = orientDeg * D2R, ax = Math.sin(o), ay = Math.cos(o);   // along-lane unit (e, n)
    const px = ay, py = -ax;                                          // across-lane unit
    // extent of the ring along/across the axes
    let minA = Infinity, maxA = -Infinity, minP = Infinity, maxP = -Infinity;
    const loc = ring.map(([lon, lat]) => {
      const { e, n } = toENU(c.lat, c.lon, lat, lon);
      const a = e * ax + n * ay, p = e * px + n * py;
      if (a < minA) minA = a; if (a > maxA) maxA = a; if (p < minP) minP = p; if (p > maxP) maxP = p;
      return [e, n];
    });
    const out = [];
    const half = arrowLen / 2, headLen = arrowLen * 0.4, headW = arrowLen * 0.25;
    for (let p = minP + spacing / 2; p < maxP; p += spacing) {
      for (let a = minA + spacing / 2; a < maxA; a += spacing) {
        const e = a * ax + p * px, n = a * ay + p * py;
        const ll = fromENU(c.lat, c.lon, e, n);
        if (!pointInRing(ll.lat, ll.lon, ring)) continue;
        // shaft from tail to tip, plus two barbs
        const tail = [e - ax * half, n - ay * half], tip = [e + ax * half, n + ay * half];
        const barbBase = [tip[0] - ax * headLen, tip[1] - ay * headLen];
        const b1 = [barbBase[0] + px * headW, barbBase[1] + py * headW];
        const b2 = [barbBase[0] - px * headW, barbBase[1] - py * headW];
        const P = (q) => { const g = fromENU(c.lat, c.lon, q[0], q[1]); return [g.lon, g.lat]; };
        out.push([P(tail), P(tip), P(b1), P(tip), P(b2)]);
      }
    }
    return out;
  }

  // ---- land occlusion ----------------------------------------------------------

  /** Proper segment-segment intersection test (affine-invariant, so plain lon/lat is fine). */
  function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    if ((d1 > 0 && d2 > 0) || (d1 < 0 && d2 < 0)) return false;
    const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    if ((d3 > 0 && d4 > 0) || (d3 < 0 && d4 < 0)) return false;
    // collinear: only when the projections overlap
    if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0) {
      const horiz = Math.abs(bx - ax) >= Math.abs(by - ay);
      const [a0, a1, c0, c1] = horiz ? [ax, bx, cx, dx] : [ay, by, cy, dy];
      return Math.max(Math.min(a0, a1), Math.min(c0, c1)) <= Math.min(Math.max(a0, a1), Math.max(c0, c1));
    }
    return true;
  }

  /**
   * All parameters t in [0,1] along a->b where it crosses ring edges, ascending.
   * Segments start on the water, so the first crossing is where the line of
   * sight enters land.
   */
  function ringCrossings(ax, ay, bx, by, ring, bbox) {
    if (bbox) {
      const [w, s, e, n] = bbox;
      if (Math.max(ax, bx) < w || Math.min(ax, bx) > e || Math.max(ay, by) < s || Math.min(ay, by) > n) return [];
    }
    const out = [];
    const rx = bx - ax, ry = by - ay;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [cx, cy] = ring[j], [dx, dy] = ring[i];
      if (!segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) continue;
      const sx = dx - cx, sy = dy - cy, den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-18) continue;
      const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
      if (t >= 0 && t <= 1) out.push(t);
    }
    return out.sort((p, q) => p - q);
  }

  /**
   * Line-of-sight test across land polygons. `land` is [{ring, bbox}]. Returns
   * null when the view is clear, otherwise {t, distanceM} of the first point
   * where the sight line from the viewer enters land.
   *
   * Standing on land yourself (a pier, a beach, a bluff) is tolerated: for a
   * ring that contains the viewer the first crossing is the shore in front of
   * you, not an obstacle, and any crossing within `graceM` of the viewer is
   * ignored (GPS error, charted shoreline generalisation).
   */
  function landOcclusion(lat0, lon0, lat, lon, land, graceM) {
    graceM = graceM == null ? 60 : graceM;
    const total = haversine(lat0, lon0, lat, lon);
    if (total <= graceM) return null;
    let best = null;
    for (const L of land) {
      const ts = ringCrossings(lon0, lat0, lon, lat, L.ring, L.bbox);
      if (ts.length === 0) continue;
      const skip = pointInRing(lat0, lon0, L.ring) ? 1 : 0;
      for (let i = skip; i < ts.length; i++) {
        if (ts[i] * total < graceM) continue;
        if (best == null || ts[i] < best) best = ts[i];
        break;
      }
    }
    return best == null ? null : { t: best, distanceM: best * total };
  }

  // ---- compass / formatting -----------------------------------------------

  function smoothHeading(prev, next, alpha) {
    if (prev == null || !isFinite(prev)) return wrap360(next);
    return wrap360(prev + alpha * angleDiff(next, prev));
  }
  const CARDINALS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  function cardinal(deg) { return CARDINALS[Math.round(wrap360(deg) / 22.5) % 16]; }

  function fmtDistance(m, nautical) {
    if (m == null || !isFinite(m)) return "—";
    if (nautical) { const nm = m / NM; return nm < 0.2 ? Math.round(m / 0.3048 / 10) * 10 + " ft" : nm.toFixed(nm < 10 ? 2 : 1) + " NM"; }
    return m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(m < 10000 ? 2 : 1) + " km";
  }
  function fmtSpeed(kn) { return kn == null || !isFinite(kn) ? "—" : kn.toFixed(1) + " kn"; }
  function fmtBearing(b) { return b == null || !isFinite(b) ? "—" : String(Math.round(wrap360(b))).padStart(3, "0") + "° " + cardinal(b); }
  function fmtDuration(sec) {
    if (sec == null || !isFinite(sec)) return "—";
    const s = Math.abs(Math.round(sec));
    if (s < 60) return s + " s";
    if (s < 3600) return Math.floor(s / 60) + " min";
    return (s / 3600).toFixed(1) + " h";
  }

  return {
    R, NM, KN, wrap360, angleDiff, haversine, bearing, destination, metresPerDegree, toENU, fromENU,
    ringBBox, ringCentroid, outerRing, pointInRing, distanceToRing,
    horizonDip, horizonDistance, seaPitch, Camera,
    hullFootprint, deadReckon, cpa, velocity, laneArrows,
    segmentsCross, ringCrossings, landOcclusion,
    smoothHeading, cardinal, fmtDistance, fmtSpeed, fmtBearing, fmtDuration,
  };
}));

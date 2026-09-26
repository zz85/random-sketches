/*
 * heights.js - building height estimates so labels can sit on rooftops.
 *
 * Two layers:
 *
 *   estimateHeight(parcel)     Heuristic from assessor data only, so it always
 *                              works: use class decides a floor/ceiling on
 *                              storeys, then improvement value per ft² of lot
 *                              (a good proxy for floor-area ratio) picks a point
 *                              in between on a log scale. Calibrated on King
 *                              County U-District parcels: ~$60/ft² ≈ 1 storey
 *                              house, ~$1,000/ft² ≈ 6-storey apartment,
 *                              ~$8,500/ft² ≈ 24-storey tower.
 *
 *   fetchOsmHeights(lat, lon, r) OpenStreetMap buildings via Overpass, using
 *                              `height` or `building:levels` where mapped.
 *                              Matched to parcels by containment of the
 *                              building centroid. Overpass is CORS-open
 *                              (Access-Control-Allow-Origin: *) but is a shared
 *                              volunteer service, so failures are expected and
 *                              swallowed; the heuristic stays as the fallback.
 *
 *   applyHeights(parcels, osm) Merges: OSM value when present, else heuristic.
 *                              Sets parcel.height (m), parcel.storeys and
 *                              parcel.heightSource ("osm" | "estimate").
 *
 * Browser global (window.Heights) or CommonJS module. Depends on geo.js.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./geo.js"));
  else root.Heights = factory(root.Geo);
}(typeof self !== "undefined" ? self : this, function (Geo) {
  "use strict";

  const STOREY_M = 3.3;          // typical floor-to-floor; ground floors of towers are taller, roofs add a bit
  const HOUSE_STOREY_M = 3.0;

  /** Storey bounds by use class. `flat` uses are surfaces with no building. */
  function storeyBounds(p) {
    const u = (p.use || "").toLowerCase(), t = p.propType;
    if (/parking|vacant|undeveloped|open space|parks?\b|cemetery|water|right.of.way|\brow\b|golf|agricult|farm|forest|timber|railroad|highway|street|reference|easement|common area/.test(u) || t === "U" || t === "T" || /^(reference|unknown)/i.test(p.address || "")) return { min: 0, max: 0, flat: true };
    if (/single family|mobile home|manufactured/.test(u) || (t === "R" && /^(single|1 ?unit)/.test(u))) return { min: 1, max: 3, storeyM: HOUSE_STOREY_M };
    if (/duplex|triplex|4-plex|2-4 units|townhouse|rooming/.test(u)) return { min: 2, max: 4, storeyM: HOUSE_STOREY_M };
    if (/church|relig|school|library|museum|fire|police|post office|community/.test(u)) return { min: 1, max: 5 };
    if (/warehouse|industrial|manufactur|storage|shop\b|auto|service station|gas|car wash|nursery/.test(u)) return { min: 1, max: 3 };
    if (/retail|restaurant|eating|drinking|tavern|store|grocery|food|bank|market/.test(u) && !/mixed/.test(u)) return { min: 1, max: 6 };
    if (/apartment|multi.?family|condominium|hotel|motel|office|mixed|medical|hospital|dormitory|assembly|arena|theat/.test(u) || t === "C" || t === "K") return { min: 1, max: 45 };
    if (t === "R") return { min: 1, max: 3, storeyM: HOUSE_STOREY_M };
    return { min: 1, max: 12 };
  }

  /**
   * Improvement value per ft² of lot -> storeys, log scale. Least-squares fit of
   * a*ln(1+d/b)+c through King County 2026 anchors: $60/ft² -> 1 (house),
   * $1,000 -> 6 (walk-up apartment block), $8,500 -> 24 (tower). Max error 0.3.
   */
  function storeysFromDensity(d) {
    if (!(d > 0)) return 1;
    return 14.17 * Math.log(1 + d / 1995) + 0.43;
  }

  function estimateHeight(p) {
    const b = storeyBounds(p);
    if (b.flat) return { height: 0, storeys: 0, source: "estimate" };
    const lot = p.lotSqft > 0 ? p.lotSqft : (p.centroid && p.centroid.areaM2 ? p.centroid.areaM2 * 10.7639 : 0);
    let storeys;
    if (p.imprValue > 0 && lot > 0) storeys = storeysFromDensity(p.imprValue / lot);
    else if (p.imprValue > 0) storeys = b.min + (b.max - b.min) * 0.3;
    else storeys = b.min;          // land-only value on a built class: assume the minimum
    storeys = Math.max(b.min, Math.min(b.max, Math.floor(storeys + 0.6)));   // round, biased slightly up
    const sm = b.storeyM || STOREY_M;
    return { height: storeys * sm + (storeys > 3 ? 1.5 : 0.8), storeys, source: "estimate" };
  }

  // ---- OpenStreetMap ------------------------------------------------------

  const OVERPASS_URLS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

  /** Parse OSM `height` ("12", "12 m", "40'", "40 ft") to metres, or null. */
  function parseOsmHeight(v) {
    if (v == null) return null;
    const m = String(v).trim().match(/^(-?\d+(?:\.\d+)?)\s*(m|ft|feet|')?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return /ft|feet|'/i.test(m[2] || "") ? n * 0.3048 : n;
  }

  /** One OSM building -> {lat, lon, height, storeys, name} or null when it carries no height information. */
  function osmBuilding(el) {
    const t = el.tags || {};
    const c = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!c) return null;
    let height = parseOsmHeight(t.height), storeys = t["building:levels"] != null ? parseFloat(t["building:levels"]) : null;
    if (height == null && storeys != null && isFinite(storeys)) height = storeys * STOREY_M + 1;
    if (height == null) return null;
    if (storeys == null || !isFinite(storeys)) storeys = Math.max(1, Math.round(height / STOREY_M));
    return { lat: c.lat, lon: c.lon, height, storeys, name: t.name || null };
  }

  async function fetchOsmHeights(lat, lon, radiusM, fetchImpl, urls) {
    const f = fetchImpl || fetch;
    const q = `[out:json][timeout:20];(way["building"]["building"!="no"](around:${Math.round(radiusM)},${lat.toFixed(6)},${lon.toFixed(6)});relation["building"](around:${Math.round(radiusM)},${lat.toFixed(6)},${lon.toFixed(6)}););out tags center;`;
    let lastErr;
    for (const u of urls || OVERPASS_URLS) {
      try {
        const res = await f(u, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
        const d = await res.json();
        return (d.elements || []).map(osmBuilding).filter(Boolean);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("Overpass unavailable");
  }

  /**
   * Attach heights. Priority: assessor storey count (King County apartment
   * complexes, via `lookup(pin)` -> {stories}) > OSM building matched by
   * centroid containment (tallest wins) > the value-density estimate.
   */
  function applyHeights(parcels, osm, lookup) {
    for (const p of parcels) {
      const a = lookup ? lookup(p.id) : null;
      if (a && a.stories > 0) { p.storeys = a.stories; p.height = a.stories * STOREY_M + (a.stories > 3 ? 1.5 : 0.8); p.heightSource = "assessor"; continue; }
      const e = estimateHeight(p); p.height = e.height; p.storeys = e.storeys; p.heightSource = "estimate";
    }
    if (!osm || !osm.length) return parcels;
    const matched = new Map();
    for (const b of osm) {
      for (const p of parcels) {
        if (Geo.pointInRing(b.lat, b.lon, p.ring)) {
          const cur = matched.get(p.id);
          if (!cur || b.height > cur.height) matched.set(p.id, b);
          break;
        }
      }
    }
    for (const p of parcels) {
      const b = matched.get(p.id);
      if (b && p.heightSource !== "assessor") { p.height = b.height; p.storeys = b.storeys; p.heightSource = "osm"; }
      if (b && !p.name && b.name) p.name = b.name;
    }
    return parcels;
  }

  return { STOREY_M, storeyBounds, storeysFromDensity, estimateHeight, parseOsmHeight, osmBuilding, fetchOsmHeights, applyHeights, OVERPASS_URLS };
}));

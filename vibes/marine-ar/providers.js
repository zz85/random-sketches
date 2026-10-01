/*
 * providers.js - data access for Marine AR. Everything is a plain browser
 * fetch to a CORS-enabled public endpoint; the only optional server piece is
 * proxy.js, which turns a key-protected AIS stream into the same GeoJSON that
 * Digitraffic serves publicly.
 *
 *   LANE_LAYERS / fetchLanes()  - charted traffic lanes from NOAA ENC Direct
 *                                 (ArcGIS REST, CORS): S-57 TSSLPT lane parts,
 *                                 TSEZNE separation zones, PRCARE precautionary
 *                                 areas, TSSBND boundary lines, FAIRWY fairways
 *   AIS providers               - registry of vessel-position sources, all
 *                                 normalised to the Vessel shape below:
 *       digitraffic   Finnish waters, public REST, CORS, no key
 *       proxy         proxy.js -> aisstream.io (worldwide, key on the server)
 *       demo          simulated traffic in the lanes around the viewer
 *   VesselTable                 - merges position + static reports, ages out
 *                                 stale targets, dead-reckons to "now"
 *   SHIP_TYPES / NAV_STATUS     - ITU-R M.1371 code tables
 *   reverseGeocode()            - Nominatim, for the header
 *
 * Lane = { id, kind: 'lane'|'zone'|'precaution'|'boundary'|'fairway',
 *          ring: [[lon,lat],...] | null, line: [[lon,lat],...] | null,
 *          orient: deg | null, cattss, inform, cell, centroid, bbox }
 *
 * Vessel = { mmsi, name, callSign, imo, shipType, shipTypeName, category,
 *            lat, lon, sog, cog, heading, navStat, rot, posAcc,
 *            dims: {a,b,c,d} | null, length, beam, draught, destination,
 *            at (ms of last position), staticAt }
 *
 * Browser global (window.Providers) or CommonJS module. Depends on geo.js.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./geo.js"));
  else root.Providers = factory(root.Geo);
}(typeof self !== "undefined" ? self : this, function (Geo) {
  "use strict";

  // ---- NOAA ENC Direct: charted lanes ------------------------------------

  const ENC_DIRECT = "https://encdirect.noaa.gov/arcgis/rest/services/encdirect";

  /**
   * Layer ids verified against the MapServer JSON (Sep 2026). Harbour cells
   * (1:10k-1:50k) carry the most detail; coastal (1:150k-1:600k) covers open
   * water such as the Strait of Juan de Fuca where no harbour cell exists.
   * Kind -> S-57 acronym: lane TSSLPT, zone TSEZNE, precaution PRCARE,
   * boundary TSSBND, fairway FAIRWY.
   */
  const LANE_LAYERS = {
    harbour: { service: "enc_harbour", lane: 215, zone: 214, precaution: 211, boundary: 136, fairway: 208 },
    coastal: { service: "enc_coastal", lane: 155, zone: 154, precaution: 152, boundary: 103, fairway: 150 },
  };

  const LANE_STYLE = {
    lane:       { label: "Traffic lane",        stroke: "#ff33bf", fill: "rgba(255,51,191,0.10)" },
    zone:       { label: "Separation zone",     stroke: "#ff33bf", fill: "rgba(255,51,191,0.28)" },
    precaution: { label: "Precautionary area",  stroke: "#ffb020", fill: "rgba(255,176,32,0.12)" },
    boundary:   { label: "TSS boundary",        stroke: "#ff33bf", fill: null },
    fairway:    { label: "Fairway",             stroke: "#3fa0ff", fill: "rgba(63,160,255,0.08)" },
  };

  function envelopeParams(bbox, outFields, withGeometry) {
    return new URLSearchParams({
      geometry: bbox.map((v) => v.toFixed(5)).join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326", spatialRel: "esriSpatialRelIntersects",
      outFields: outFields.join(","),
      returnGeometry: withGeometry ? "true" : "false",
      outSR: "4326", geometryPrecision: "5", f: "json",
    });
  }

  async function arcgisQuery(url, params, fetchImpl) {
    const f = fetchImpl || fetch;
    const res = await f(`${url}?${params}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`ArcGIS ${data.error.code}: ${data.error.message}`);
    return data;
  }

  function clean(s) { return typeof s === "string" ? s.replace(/\s+/g, " ").trim() : s; }
  function num(v) { return v == null || v === "" ? null : Number(v); }

  /** Esri feature (polygon or polyline) -> Lane. */
  function normalizeLane(feature, kind, scale) {
    const a = feature.attributes || {}, g = feature.geometry || {};
    const id = `${scale}:${kind}:${a.OBJECTID != null ? a.OBJECTID : (a["APPROACH.TSSLPT.FID"] || Math.random().toString(36).slice(2))}`;
    const lane = {
      id, kind, scale,
      ring: null, line: null,
      orient: num(a.ORIENT),
      cattss: clean(a.CATTSS) || null,
      inform: clean(a.INFORM) || null,
      cell: clean(a.DSNM) || null,
      style: LANE_STYLE[kind],
    };
    if (g.rings) {
      lane.ring = Geo.outerRing(g.rings);
      if (!lane.ring) return null;
      lane.centroid = Geo.ringCentroid(lane.ring);
      lane.bbox = Geo.ringBBox(lane.ring);
    } else if (g.paths && g.paths.length) {
      lane.line = g.paths.reduce((best, p) => (p.length > best.length ? p : best), g.paths[0]);
      lane.bbox = Geo.ringBBox(lane.line);
      const mid = lane.line[Math.floor(lane.line.length / 2)];
      lane.centroid = { lat: mid[1], lon: mid[0], areaM2: 0 };
    } else return null;
    return lane;
  }

  /** bbox [w,s,e,n] around a point. */
  function bboxAround(lat, lon, radiusM) {
    const mpd = Geo.metresPerDegree(lat);
    return [lon - radiusM / mpd.lon, lat - radiusM / mpd.lat, lon + radiusM / mpd.lon, lat + radiusM / mpd.lat];
  }

  /**
   * Every lane feature within radiusM of the viewer. Queries harbour and
   * coastal cells; when a harbour cell covers the area its features are kept
   * and the coastal duplicates of the same scheme are dropped (same ORIENT
   * and overlapping centroids), otherwise coastal fills the gap.
   */
  async function fetchLanes(lat, lon, radiusM, fetchImpl, opts) {
    const bbox = bboxAround(lat, lon, radiusM);
    const kinds = (opts && opts.kinds) || ["lane", "zone", "precaution", "boundary", "fairway"];
    const scales = (opts && opts.scales) || ["harbour", "coastal"];
    const jobs = [];
    for (const scale of scales) {
      const L = LANE_LAYERS[scale];
      for (const kind of kinds) {
        if (L[kind] == null) continue;
        const url = `${ENC_DIRECT}/${L.service}/MapServer/${L[kind]}/query`;
        jobs.push(arcgisQuery(url, envelopeParams(bbox, ["*"], true), fetchImpl)
          .then((d) => (d.features || []).map((f) => normalizeLane(f, kind, scale)).filter(Boolean))
          .catch((e) => { console.warn("lanes", scale, kind, e.message); return []; }));
      }
    }
    const all = (await Promise.all(jobs)).flat();
    return dedupeLanes(all);
  }

  /** Prefer harbour-scale features; drop coastal ones whose centroid falls inside a harbour polygon of the same kind. */
  function dedupeLanes(lanes) {
    const harbour = lanes.filter((l) => l.scale === "harbour");
    if (harbour.length === 0) return lanes;
    const out = harbour.slice();
    for (const l of lanes) {
      if (l.scale === "harbour") continue;
      const covered = harbour.some((h) => h.kind === l.kind && h.ring && l.centroid && Geo.pointInRing(l.centroid.lat, l.centroid.lon, h.ring));
      if (!covered) out.push(l);
    }
    return out;
  }

  /** Which lane polygon (if any) contains the point; lanes before zones before precautionary areas. */
  function laneAt(lat, lon, lanes) {
    const order = { lane: 0, zone: 1, precaution: 2, fairway: 3 };
    let best = null;
    for (const l of lanes) {
      if (!l.ring || order[l.kind] == null) continue;
      if (Geo.pointInRing(lat, lon, l.ring) && (best == null || order[l.kind] < order[best.kind])) best = l;
    }
    return best;
  }

  // ---- NOAA ENC Direct: land (LNDARE) for line-of-sight occlusion ---------------

  /** Land_Area polygon layers, verified against the MapServer JSON (Sep 2026). */
  const LAND_LAYERS = { harbour: { service: "enc_harbour", land: 233, elev: 39 }, coastal: { service: "enc_coastal", land: 171, elev: 36 } };

  /**
   * Land polygons around the viewer, as [{ring, bbox, name}]. Every ring is kept
   * (islands and holes alike: a hole is water, but the sight line crossing its
   * edge has already crossed the outer shore first, so counting it is harmless).
   * `maxAllowableOffset` asks the server to generalise the shoreline to about
   * `toleranceM` metres, which turns a 600 KB harbour response into ~150 KB.
   * Harbour cells first; coastal only when no harbour cell covers the area.
   */
  async function fetchLand(lat, lon, radiusM, fetchImpl, opts) {
    const bbox = bboxAround(lat, lon, radiusM);
    const tolM = (opts && opts.toleranceM) || 30;
    const tolDeg = tolM / Geo.metresPerDegree(lat).lat;
    const query = async (scale) => {
      const L = LAND_LAYERS[scale];
      const p = envelopeParams(bbox, ["OBJL", "OBJNAM"], true);
      p.set("maxAllowableOffset", tolDeg.toFixed(6));
      const d = await arcgisQuery(`${ENC_DIRECT}/${L.service}/MapServer/${L.land}/query`, p, fetchImpl);
      return { land: normalizeLand(d.features || [], scale), exceeded: !!d.exceededTransferLimit };
    };
    // LNDELV spot heights (both scales; sparse, so take everything) alongside
    const elevQuery = (scale) => {
      const L = LAND_LAYERS[scale];
      return arcgisQuery(`${ENC_DIRECT}/${L.service}/MapServer/${L.elev}/query`, envelopeParams(bbox, ["ELEVAT", "OBJNAM"], true), fetchImpl)
        .then((d) => (d.features || []).filter((f) => f.geometry && f.attributes && f.attributes.ELEVAT != null)
          .map((f) => ({ lat: f.geometry.y, lon: f.geometry.x, elev: Number(f.attributes.ELEVAT), name: clean(f.attributes.OBJNAM) || null })))
        .catch((e) => { console.warn("lndelv", scale, e.message); return []; });
    };
    const [rh, spotsH, spotsC] = await Promise.all([query("harbour"), elevQuery("harbour"), elevQuery("coastal")]);
    const r = rh.land.length ? rh : await query("coastal");
    r.spots = dedupeSpots(spotsH.concat(spotsC));
    attachElevations(r.land, r.spots);
    return r;
  }

  function dedupeSpots(spots) {
    const seen = new Set(), out = [];
    for (const sp of spots) { const k = sp.lat.toFixed(4) + "," + sp.lon.toFixed(4); if (seen.has(k)) continue; seen.add(k); out.push(sp); }
    return out;
  }

  /** ring.elev = highest charted spot height inside the ring (null when none). */
  function attachElevations(land, spots) {
    for (const L of land) {
      let e = null;
      for (const sp of spots) {
        const [w, s, ee, n] = L.bbox;
        if (sp.lon < w || sp.lon > ee || sp.lat < s || sp.lat > n) continue;
        if (Geo.pointInRing(sp.lat, sp.lon, L.ring) && (e == null || sp.elev > e)) e = sp.elev;
      }
      L.elev = e;
    }
    return land;
  }

  function normalizeLand(features, scale) {
    const out = [];
    for (const f of features) {
      const rings = f.geometry && f.geometry.rings;
      if (!rings) continue;
      const name = clean(f.attributes && f.attributes.OBJNAM) || null;
      for (const ring of rings) {
        if (ring.length < 3) continue;
        out.push({ ring, bbox: Geo.ringBBox(ring), name, scale });
      }
    }
    return out;
  }

  class LandStore {
    constructor(opts) {
      this.storage = (opts && opts.storage) || null;
      this.ttlMs = (opts && opts.ttlMs) || 30 * 24 * 3600e3;
      this.key = (opts && opts.key) || "marine-ar:land";
      this.center = null; this.radius = 0; this.at = 0; this.land = []; this.spots = [];
      this._load();
    }
    _load() {
      if (!this.storage) return;
      try {
        const d = JSON.parse(this.storage.getItem(this.key) || "null");
        if (!d || Date.now() - d.at > this.ttlMs) return;
        Object.assign(this, { center: d.center, radius: d.radius, at: d.at, land: d.land || [], spots: d.spots || [] });
      } catch (e) { /* ignore */ }
    }
    _save() {
      if (!this.storage) return;
      try { this.storage.setItem(this.key, JSON.stringify({ center: this.center, radius: this.radius, at: this.at, land: this.land, spots: this.spots })); }
      catch (e) { /* quota: land can exceed 5 MB on busy coasts; fine, refetch next time */ }
    }
    needsFetch(lat, lon, radiusM) {
      if (!this.center || Date.now() - this.at > this.ttlMs) return true;
      if (radiusM > this.radius * 1.05) return true;
      return Geo.haversine(lat, lon, this.center.lat, this.center.lon) > this.radius * 0.4;
    }
    set(lat, lon, radiusM, land, spots) { this.center = { lat, lon }; this.radius = radiusM; this.at = Date.now(); this.land = land; this.spots = spots || []; this._save(); }
    clear() { this.center = null; this.land = []; this.spots = []; if (this.storage) try { this.storage.removeItem(this.key); } catch (e) { /* */ } }
  }

  // ---- NOAA ENC Direct: aids to navigation ------------------------------------------

  /**
   * Point layers for buoys, beacons, daymarks and lights, verified against the
   * MapServer JSON (Sep 2026). S-57 acronyms in the key. A light (LIGHTS) is a
   * separate object sitting on the same point as its buoy or beacon, so
   * fetchAton merges lights onto structures by position.
   */
  const ATON_LAYERS = {
    harbour: { service: "enc_harbour", BCNLAT: 1, BCNSAW: 2, BCNSPP: 3, BOYCAR: 4, BOYISD: 5, BOYLAT: 6, BOYSAW: 7, BOYSPP: 8, DAYMAR: 9, LIGHTS: 11, LITFLT: 12 },
    coastal: { service: "enc_coastal", BCNLAT: 1, BCNSAW: 2, BCNSPP: 3, BOYISD: 4, BOYLAT: 5, BOYSAW: 6, BOYSPP: 7, DAYMAR: 8, LIGHTS: 10, LITFLT: 11 },
  };
  const ATON_KIND = {
    BCNLAT: "Lateral beacon", BCNSAW: "Safe water beacon", BCNSPP: "Special purpose beacon", BOYCAR: "Cardinal buoy", BOYISD: "Isolated danger buoy",
    BOYLAT: "Lateral buoy", BOYSAW: "Safe water buoy", BOYSPP: "Special purpose buoy", DAYMAR: "Daymark", LIGHTS: "Light", LITFLT: "Light float",
  };
  /** S-57 COLOUR codes -> css. */
  const S57_COLOUR = { 1: "#ffffff", 2: "#222222", 3: "#ff3b3b", 4: "#31d158", 5: "#3a7bff", 6: "#ffd60a", 7: "#9a9a9a", 8: "#8b5a2b", 9: "#ffb020", 10: "#b46cff", 11: "#ff8c1a", 12: "#ff3fd0", 13: "#ff9ec8" };
  const S57_COLOUR_NAME = { 1: "W", 2: "B", 3: "R", 4: "G", 5: "Bu", 6: "Y", 7: "Gy", 8: "Br", 9: "Am", 10: "Vi", 11: "Or", 12: "Mg", 13: "Pk" };
  /** S-57 LITCHR codes -> IHO abbreviation. */
  const LITCHR = { 1: "F", 2: "Fl", 3: "LFl", 4: "Q", 5: "VQ", 6: "UQ", 7: "Iso", 8: "Oc", 9: "IQ", 10: "IVQ", 11: "IUQ", 12: "Mo", 13: "FFl", 14: "FlLFl", 15: "OcFl", 16: "FLFl", 17: "OcAlt", 18: "LFlAlt", 19: "AlFl", 20: "AlFF", 25: "Q+LFl", 26: "VQ+LFl", 27: "UQ+LFl", 28: "Al", 29: "AlFFl" };
  const CATLAM = { 1: "port hand", 2: "starboard hand", 3: "preferred channel to starboard", 4: "preferred channel to port" };

  /** "Fl G 4s 5M" from a LIGHTS record. */
  function lightCharacter(a) {
    const chr = LITCHR[a.LITCHR] || "";
    const col = String(a.COLOUR || "").split(",").map((c) => S57_COLOUR_NAME[Number(c)] || "").filter(Boolean).join("");
    const grp = a.SIGGRP && a.SIGGRP !== "(1)" ? a.SIGGRP : "";
    const per = a.SIGPER != null && isFinite(a.SIGPER) ? `${Number(a.SIGPER)}s` : "";
    const rng = a.VALNMR != null && isFinite(a.VALNMR) ? `${Number(a.VALNMR)}M` : "";
    return [chr + grp, col, per, rng].filter(Boolean).join(" ");
  }

  function normalizeAton(feature, kind, scale) {
    const a = feature.attributes || {}, g = feature.geometry;
    if (!g || g.x == null) return null;
    const colours = String(a.COLOUR || "").split(",").map((c) => Number(c)).filter((c) => S57_COLOUR[c]);
    return {
      id: `${scale}:${kind}:${a.OBJECTID}`, kind, kindName: ATON_KIND[kind], scale,
      lat: g.y, lon: g.x,
      name: clean(a.OBJNAM) || null,
      colours, color: colours.length ? S57_COLOUR[colours[0]] : "#ffd60a",
      shape: clean(a.BOYSHP || a.BCNSHP) || null,
      lateral: a.CATLAM != null ? CATLAM[Number(a.CATLAM)] || null : null,
      heightM: a.HEIGHT != null ? Number(a.HEIGHT) : (a.VERLEN != null ? Number(a.VERLEN) : null),
      inform: clean(a.INFORM) || null,
      cell: clean(a.DSNM) || null,
      light: kind === "LIGHTS" || kind === "LITFLT" ? {
        character: lightCharacter(a), colour: colours.length ? S57_COLOUR[colours[0]] : "#ffffff",
        colours: colours.length ? colours.map((c) => S57_COLOUR[c]) : ["#ffffff"],           // slot order for alternating lights
        chr: a.LITCHR != null ? Number(a.LITCHR) : null, periodS: a.SIGPER != null && isFinite(a.SIGPER) ? Number(a.SIGPER) : null, group: clean(a.SIGGRP) || null,
        heightM: a.HEIGHT != null ? Number(a.HEIGHT) : null, rangeNM: a.VALNMR != null ? Number(a.VALNMR) : null, sector: a.SECTR1 != null ? [Number(a.SECTR1), Number(a.SECTR2)] : null,
      } : null,
    };
  }

  /**
   * Buoys, beacons, daymarks and lights within radiusM. Lights are merged onto
   * the structure at the same position (within ~3 m); a light with no structure
   * (a lighthouse charted as LIGHTS on a LNDMRK, a pier light) stays as its own
   * "Light" entry. Harbour scale wins over coastal at the same position.
   */
  async function fetchAton(lat, lon, radiusM, fetchImpl, opts) {
    const bbox = bboxAround(lat, lon, radiusM);
    const tasksFor = (scale) => {
      const L = ATON_LAYERS[scale];
      return Object.keys(L).filter((k) => k !== "service").map((kind) => () =>
        arcgisQuery(`${ENC_DIRECT}/${L.service}/MapServer/${L[kind]}/query`, envelopeParams(bbox, ["*"], true), fetchImpl)
          .then((d) => (d.features || []).map((f) => normalizeAton(f, kind, scale)).filter(Boolean))
          .catch((e) => { console.warn("aton", scale, kind, e.message); return []; }));
    };
    // Browsers allow ~6 connections per host and every layer is its own request,
    // so: harbour cells first (11 requests), coastal (10 more) only where no
    // harbour cell charted anything, which is the open-water case.
    const limit = (opts && opts.concurrency) || 6;
    const harbour = (await runLimited(tasksFor("harbour"), limit)).flat();
    if (harbour.length > 0 && !(opts && opts.coastal)) return mergeAton(harbour);
    const coastal = (await runLimited(tasksFor("coastal"), limit)).flat();
    return mergeAton(harbour.concat(coastal));
  }

  async function runLimited(tasks, limit) {
    const results = new Array(tasks.length); let next = 0;
    async function worker() { while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); } }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return results;
  }

  function mergeAton(items) {
    const key = (a) => a.lat.toFixed(4) + "," + a.lon.toFixed(4);     // ~10 m
    const byPos = new Map();
    // structures first, harbour before coastal
    const structures = items.filter((a) => !a.light).sort((a, b) => (a.scale === "harbour" ? 0 : 1) - (b.scale === "harbour" ? 0 : 1));
    for (const a of structures) { const k = key(a); if (!byPos.has(k)) byPos.set(k, a); }
    const lights = items.filter((a) => a.light).sort((a, b) => (a.scale === "harbour" ? 0 : 1) - (b.scale === "harbour" ? 0 : 1));
    const loose = new Map();
    for (const l of lights) {
      const k = key(l), s = byPos.get(k);
      if (s) { if (!s.light) { s.light = l.light; if (!s.name) s.name = l.name; if (s.heightM == null) s.heightM = l.light.heightM; } }
      else if (!loose.has(k)) loose.set(k, l);
    }
    return [...byPos.values(), ...loose.values()];
  }

  /** Generic bbox-keyed cache for point sets (AtoN). */
  class BoxStore {
    constructor(opts) {
      this.storage = (opts && opts.storage) || null;
      this.ttlMs = (opts && opts.ttlMs) || 30 * 24 * 3600e3;
      this.key = (opts && opts.key) || "marine-ar:box";
      this.center = null; this.radius = 0; this.at = 0; this.items = [];
      if (this.storage) try {
        const d = JSON.parse(this.storage.getItem(this.key) || "null");
        if (d && Date.now() - d.at <= this.ttlMs) Object.assign(this, { center: d.center, radius: d.radius, at: d.at, items: d.items || [] });
      } catch (e) { /* ignore */ }
    }
    needsFetch(lat, lon, radiusM) {
      if (!this.center || Date.now() - this.at > this.ttlMs) return true;
      if (radiusM > this.radius * 1.05) return true;
      return Geo.haversine(lat, lon, this.center.lat, this.center.lon) > this.radius * 0.4;
    }
    set(lat, lon, radiusM, items) {
      this.center = { lat, lon }; this.radius = radiusM; this.at = Date.now(); this.items = items;
      if (this.storage) try { this.storage.setItem(this.key, JSON.stringify({ center: this.center, radius: this.radius, at: this.at, items })); } catch (e) { /* quota */ }
    }
    clear() { this.center = null; this.items = []; if (this.storage) try { this.storage.removeItem(this.key); } catch (e) { /* */ } }
  }

  // ---- AIS code tables (ITU-R M.1371) -------------------------------------

  const NAV_STATUS = {
    0: "Under way using engine", 1: "At anchor", 2: "Not under command", 3: "Restricted manoeuvrability",
    4: "Constrained by draught", 5: "Moored", 6: "Aground", 7: "Engaged in fishing", 8: "Under way sailing",
    9: "Reserved (HSC)", 10: "Reserved (WIG)", 11: "Towing astern", 12: "Pushing ahead / towing alongside",
    13: "Reserved", 14: "AIS-SART / MOB / EPIRB", 15: "Undefined",
  };

  /** Ship type code -> {name, category}. Category drives the icon colour. */
  function shipType(code) {
    if (code == null || !isFinite(code)) return { name: "Unknown", category: "unknown" };
    const c = Number(code);
    const hazard = ["", " (hazard A)", " (hazard B)", " (hazard C)", " (hazard D)", "", "", "", "", ""];
    if (c >= 20 && c <= 29) return { name: "Wing in ground" + hazard[c - 20], category: "other" };
    if (c === 30) return { name: "Fishing", category: "fishing" };
    if (c === 31 || c === 32) return { name: "Towing", category: "tug" };
    if (c === 33) return { name: "Dredging / underwater ops", category: "special" };
    if (c === 34) return { name: "Diving ops", category: "special" };
    if (c === 35) return { name: "Military ops", category: "special" };
    if (c === 36) return { name: "Sailing", category: "pleasure" };
    if (c === 37) return { name: "Pleasure craft", category: "pleasure" };
    if (c >= 40 && c <= 49) return { name: "High speed craft" + hazard[c - 40], category: "hsc" };
    if (c === 50) return { name: "Pilot vessel", category: "special" };
    if (c === 51) return { name: "Search and rescue", category: "special" };
    if (c === 52) return { name: "Tug", category: "tug" };
    if (c === 53) return { name: "Port tender", category: "special" };
    if (c === 54) return { name: "Anti-pollution", category: "special" };
    if (c === 55) return { name: "Law enforcement", category: "special" };
    if (c === 58) return { name: "Medical transport", category: "special" };
    if (c === 59) return { name: "Non-combatant ship", category: "special" };
    if (c >= 60 && c <= 69) return { name: "Passenger" + hazard[c - 60], category: "passenger" };
    if (c >= 70 && c <= 79) return { name: "Cargo" + hazard[c - 70], category: "cargo" };
    if (c >= 80 && c <= 89) return { name: "Tanker" + hazard[c - 80], category: "tanker" };
    if (c >= 90 && c <= 99) return { name: "Other" + hazard[c - 90], category: "other" };
    if (c === 0) return { name: "Not available", category: "unknown" };
    return { name: "Reserved (" + c + ")", category: "other" };
  }

  const CATEGORY_COLOR = {
    passenger: "#3fd0ff", cargo: "#6fe36f", tanker: "#ff5c5c", tug: "#ffb020", fishing: "#c9a0ff",
    pleasure: "#ffe66d", hsc: "#ff8ad8", special: "#ffffff", other: "#b8c4cc", unknown: "#8a969c",
  };

  /** MMSI MID -> flag (small table; the first three digits identify the country). */
  const MID = { 201: "AL", 205: "BE", 211: "DE", 218: "DE", 219: "DK", 220: "DK", 224: "ES", 226: "FR", 227: "FR", 228: "FR",
    229: "MT", 230: "FI", 231: "FO", 232: "GB", 233: "GB", 234: "GB", 235: "GB", 236: "GI", 244: "NL", 245: "NL", 246: "NL",
    247: "IT", 248: "MT", 249: "MT", 250: "IE", 253: "LU", 255: "PT", 256: "MT", 257: "NO", 258: "NO", 259: "NO", 261: "PL",
    265: "SE", 266: "SE", 271: "TR", 273: "RU", 276: "EE", 277: "LT", 303: "US", 305: "AG", 308: "BS", 309: "BS", 311: "BS",
    316: "CA", 338: "US", 351: "PA", 352: "PA", 353: "PA", 354: "PA", 355: "PA", 356: "PA", 357: "PA", 366: "US", 367: "US",
    368: "US", 369: "US", 370: "PA", 371: "PA", 372: "PA", 373: "PA", 374: "PA", 412: "CN", 413: "CN", 414: "CN", 416: "TW",
    431: "JP", 432: "JP", 440: "KR", 441: "KR", 477: "HK", 503: "AU", 512: "NZ", 525: "ID", 533: "MY", 548: "PH", 563: "SG",
    564: "SG", 565: "SG", 566: "SG", 567: "TH", 574: "VN", 620: "KM", 636: "LR", 637: "LR" };
  function flagOf(mmsi) { return MID[String(mmsi).slice(0, 3)] || null; }

  // ---- Vessel table -------------------------------------------------------

  /**
   * Holds the latest position and static data per MMSI. Providers push
   * partial updates; `snapshot(now)` returns dead-reckoned vessels, dropping
   * anything not heard from in `maxAgeMs`.
   */
  class VesselTable {
    constructor(opts) {
      this.maxAgeMs = (opts && opts.maxAgeMs) || 15 * 60e3;
      this.map = new Map();
    }
    get size() { return this.map.size; }
    get(mmsi) { return this.map.get(Number(mmsi)) || null; }
    upsertPosition(p) {
      const mmsi = Number(p.mmsi);
      const v = this.map.get(mmsi) || { mmsi, name: null, callSign: null, imo: null, shipType: null, dims: null, draught: null, destination: null, staticAt: 0, flag: flagOf(mmsi) };
      Object.assign(v, {
        lat: p.lat, lon: p.lon,
        sog: isFinite(p.sog) && p.sog < 102.3 ? p.sog : null,
        cog: isFinite(p.cog) && p.cog < 360 ? p.cog : null,
        heading: isFinite(p.heading) && p.heading < 360 ? p.heading : null,
        navStat: p.navStat == null ? 15 : p.navStat,
        rot: p.rot == null ? null : p.rot,
        posAcc: !!p.posAcc,
        at: p.at || Date.now(),
      });
      if (p.name) v.name = clean(p.name);
      this.map.set(mmsi, v);
      return v;
    }
    upsertStatic(s) {
      const mmsi = Number(s.mmsi);
      const v = this.map.get(mmsi) || { mmsi, lat: null, lon: null, at: 0, flag: flagOf(mmsi) };
      if (s.name) v.name = clean(s.name);
      if (s.callSign) v.callSign = clean(s.callSign);
      if (s.imo) v.imo = s.imo;
      if (s.shipType != null) { v.shipType = s.shipType; const t = shipType(s.shipType); v.shipTypeName = t.name; v.category = t.category; }
      if (s.dims) { v.dims = s.dims; v.length = s.dims.a + s.dims.b || null; v.beam = s.dims.c + s.dims.d || null; }
      if (s.draught != null) v.draught = s.draught;
      if (s.destination) v.destination = clean(s.destination);
      if (s.eta) v.eta = s.eta;
      v.staticAt = s.at || Date.now();
      this.map.set(mmsi, v);
      return v;
    }
    /** Vessels with a position, dead-reckoned to `now`, stale ones removed. */
    snapshot(now) {
      now = now || Date.now();
      const out = [];
      for (const [mmsi, v] of this.map) {
        if (v.lat == null) continue;
        const age = now - v.at;
        if (age > this.maxAgeMs) { this.map.delete(mmsi); continue; }
        const dr = v.navStat === 1 || v.navStat === 5 ? { lat: v.lat, lon: v.lon } : Geo.deadReckon(v.lat, v.lon, v.sog, v.cog, Math.min(age, 120e3) / 1000);
        if (!v.category) { const t = shipType(v.shipType); v.shipTypeName = t.name; v.category = t.category; }
        out.push({ ...v, drLat: dr.lat, drLon: dr.lon, ageSec: age / 1000, color: CATEGORY_COLOR[v.category] || CATEGORY_COLOR.unknown, navStatName: NAV_STATUS[v.navStat] || "Undefined" });
      }
      return out;
    }
    clear() { this.map.clear(); }
  }

  // ---- AIS providers -------------------------------------------------------

  /**
   * Each provider: { id, name, attribution, bbox|null, pollMs, start(ctx) }.
   * start() returns a handle {stop()}; ctx = { table, getCenter() -> {lat, lon, radiusM}, onUpdate(), onError(e), fetch, proxyBase }.
   */

  /** Digitraffic response -> table. GeoJSON FeatureCollection of positions. */
  function ingestDigitrafficLocations(table, data) {
    let n = 0;
    for (const f of data.features || []) {
      const p = f.properties || {}, c = f.geometry && f.geometry.coordinates;
      if (!c) continue;
      table.upsertPosition({ mmsi: f.mmsi || p.mmsi, lat: c[1], lon: c[0], sog: p.sog, cog: p.cog, heading: p.heading, navStat: p.navStat, rot: p.rot, posAcc: p.posAcc, at: p.timestampExternal || Date.now() });
      n++;
    }
    return n;
  }
  function ingestDigitrafficVessel(table, m) {
    if (!m || m.mmsi == null) return null;
    return table.upsertStatic({
      mmsi: m.mmsi, name: m.name, callSign: m.callSign, imo: m.imo || null, shipType: m.shipType,
      dims: { a: m.referencePointA || 0, b: m.referencePointB || 0, c: m.referencePointC || 0, d: m.referencePointD || 0 },
      draught: m.draught != null ? m.draught / 10 : null,   // decimetres in the AIS message
      destination: m.destination, eta: m.eta, at: m.timestamp,
    });
  }

  /**
   * Polls a Digitraffic-shaped REST API: GET {base}/locations?latitude&longitude&radius(km)
   * and GET {base}/vessels/{mmsi} for static data of vessels we have not seen.
   * Used for Digitraffic itself and for proxy.js, which mimics it.
   */
  function restPoller(base, headers) {
    return function start(ctx) {
      let stopped = false, timer = null, inflight = new Set();
      const f = ctx.fetch || fetch;
      async function tick() {
        if (stopped) return;
        try {
          const { lat, lon, radiusM } = ctx.getCenter();
          const km = Math.max(1, Math.ceil(radiusM / 1000));
          const res = await f(`${base}/locations?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}&radius=${km}`, { headers });
          if (!res.ok) throw new Error(`AIS HTTP ${res.status}`);
          ingestDigitrafficLocations(ctx.table, await res.json());
          // static data for newcomers, a few per tick so we never burst
          const missing = ctx.table.snapshot().filter((v) => !v.staticAt && !inflight.has(v.mmsi)).slice(0, 6);
          for (const v of missing) {
            inflight.add(v.mmsi);
            f(`${base}/vessels/${v.mmsi}`, { headers }).then((r) => (r.ok ? r.json() : null)).then((m) => {
              if (m) ingestDigitrafficVessel(ctx.table, m); else ctx.table.upsertStatic({ mmsi: v.mmsi });   // mark as looked up
              ctx.onUpdate();
            }).catch(() => ctx.table.upsertStatic({ mmsi: v.mmsi })).finally(() => inflight.delete(v.mmsi));
          }
          ctx.onUpdate();
        } catch (e) { ctx.onError(e); }
        if (!stopped) timer = setTimeout(tick, ctx.pollMs || 10e3);
      }
      tick();
      return { stop() { stopped = true; clearTimeout(timer); }, refresh() { clearTimeout(timer); tick(); } };
    };
  }

  // ---- aisstream.io-shaped frames (aisstream.io, OpenSeaFeed, aiscast) --------

  function aisstreamDims(d) { return { a: d.A || 0, b: d.B || 0, c: d.C || 0, d: d.D || 0 }; }
  function aisstreamStatic(body, meta, now) {
    const s = { at: now };
    if (body.Name) s.name = body.Name.trim(); else if (meta.ShipName) s.name = meta.ShipName.trim();
    if (body.CallSign) s.callSign = body.CallSign.trim();
    if (body.ImoNumber) s.imo = body.ImoNumber;
    if (body.Type != null) s.shipType = body.Type;
    if (body.Dimension) s.dims = aisstreamDims(body.Dimension);
    if (body.MaximumStaticDraught != null) s.draught = body.MaximumStaticDraught;   // metres
    if (body.Destination) s.destination = body.Destination.trim();
    if (body.Eta) s.eta = body.Eta;
    return s;
  }
  /**
   * Feeds one aisstream.io-protocol frame ({MessageType, MetaData, Message}) into a VesselTable.
   * Returns "pos", "static" or null. Names arrive in MetaData on every position report, so a
   * vessel gets a name before its static data shows up.
   */
  function ingestAisstreamFrame(table, msg, now) {
    const meta = (msg && msg.MetaData) || {}, mmsi = Number(meta.MMSI);
    if (!mmsi || !msg.Message) return null;
    const body = msg.Message[msg.MessageType];
    if (!body) return null;
    now = now || Date.now();
    switch (msg.MessageType) {
      case "PositionReport":
      case "StandardClassBPositionReport":
      case "ExtendedClassBPositionReport": {
        const lat = body.Latitude != null ? body.Latitude : meta.latitude, lon = body.Longitude != null ? body.Longitude : meta.longitude;
        if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
        table.upsertPosition({
          mmsi, lat, lon, sog: body.Sog, cog: body.Cog, heading: body.TrueHeading,
          navStat: body.NavigationalStatus == null ? 15 : body.NavigationalStatus,
          rot: body.RateOfTurn == null ? null : body.RateOfTurn, posAcc: !!body.PositionAccuracy, at: now,
        });
        const v = table.get(mmsi);
        const st = {};
        if (meta.ShipName && !v.name) st.name = meta.ShipName.trim();
        if (meta.ShipType != null && v.shipType == null) st.shipType = meta.ShipType;
        if (body.Dimension) Object.assign(st, aisstreamStatic(body, meta, now));      // extended class B carries dims + type
        if (Object.keys(st).length) { const staticAt = v.staticAt; table.upsertStatic({ mmsi, ...st }); if (!st.at) table.get(mmsi).staticAt = staticAt; }
        return "pos";
      }
      case "ShipStaticData":
        table.upsertStatic({ mmsi, ...aisstreamStatic(body, meta, now) });
        return "static";
      case "StaticDataReport": {
        const a = body.ReportA, b = body.ReportB, s = { mmsi, at: now };
        if (a && a.Name) s.name = a.Name.trim();
        if (b) { if (b.ShipType != null) s.shipType = b.ShipType; if (b.CallSign) s.callSign = b.CallSign.trim(); if (b.Dimension) s.dims = aisstreamDims(b.Dimension); }
        table.upsertStatic(s);
        return "static";
      }
      default: return null;
    }
  }

  /**
   * Cache of vessel particulars keyed by MMSI, persisted in localStorage. Names and dimensions
   * change rarely, so entries live 30 days; a miss (404) is remembered for a day.
   */
  class StaticCache {
    constructor(opts) {
      this.storage = (opts && opts.storage) || null; this.key = (opts && opts.key) || "marine-ar:static";
      this.ttlMs = (opts && opts.ttlMs) || 30 * 86400e3; this.missTtlMs = (opts && opts.missTtlMs) || 86400e3; this.max = (opts && opts.max) || 3000;
      this.map = new Map();
      try { const d = JSON.parse(this.storage && this.storage.getItem(this.key) || "null"); if (d && d.v === 1) for (const [k, v] of d.e) this.map.set(Number(k), v); } catch (e) { /* ignore */ }
      this._dirty = false;
    }
    get(mmsi) {
      const e = this.map.get(Number(mmsi)); if (!e) return undefined;
      if (Date.now() - e.at > (e.miss ? this.missTtlMs : this.ttlMs)) { this.map.delete(Number(mmsi)); return undefined; }
      return e.miss ? null : e;
    }
    set(mmsi, data) {
      this.map.set(Number(mmsi), { ...(data || { miss: true }), at: Date.now() });
      if (this.map.size > this.max) { const k = this.map.keys().next().value; this.map.delete(k); }
      this._dirty = true; if (!this._t) this._t = setTimeout(() => this.flush(), 2000);
    }
    flush() { this._t = null; if (!this._dirty || !this.storage) return; this._dirty = false; try { this.storage.setItem(this.key, JSON.stringify({ v: 1, e: [...this.map.entries()] })); } catch (e) { /* quota */ } }
  }

  /** OpenSeaFeed /v1/vessels/{mmsi} record -> VesselTable static fields. Dimensions come as len/beam only, so the reference point is centred. */
  function staticFromOsf(v) {
    if (!v) return null;
    const s = {};
    if (v.name) s.name = v.name; if (v.type != null) s.shipType = v.type; if (v.imo) s.imo = v.imo; if (v.callsign) s.callSign = v.callsign;
    if (v.dest) s.destination = v.dest; if (v.draught != null) s.draught = v.draught;
    if (v.len) s.dims = { a: Math.round(v.len / 2), b: Math.round(v.len / 2), c: Math.round((v.beam || 0) / 2), d: Math.round((v.beam || 0) / 2) };
    return Object.keys(s).length ? s : null;
  }

  /**
   * Fills in name / type / size for vessels whose static report has not arrived yet, from a
   * per-vessel REST lookup (OpenSeaFeed `GET /v1/vessels/{mmsi}`, CORS *, ~250 bytes) backed
   * by StaticCache. `limit` lookups per call so a busy harbour never bursts.
   */
  function lookupMissingStatic(table, opts) {
    const { base, cache, fetchImpl, inflight, limit, onUpdate } = opts;
    const f = fetchImpl || fetch;
    // nameless vessels first (they are the ones labelled "Unnamed"), nearest first within that
    const c = opts.center;
    const dist = (v) => (c && v.lat != null ? Geo.haversine(c.lat, c.lon, v.lat, v.lon) : 0);
    const missing = table.snapshot().filter((v) => !v.staticAt && !inflight.has(v.mmsi)).sort((a, b) => (!!a.name - !!b.name) || (dist(a) - dist(b))).slice(0, limit || 3);
    let started = 0;
    for (const v of missing) {
      const cached = cache ? cache.get(v.mmsi) : undefined;
      if (cached !== undefined) {                                   // hit (data) or remembered miss (null)
        const s = cached && staticFromOsf(cached);
        table.upsertStatic({ mmsi: v.mmsi, ...(s || {}) });
        if (s) onUpdate && onUpdate();
        continue;
      }
      inflight.add(v.mmsi); started++;
      f(`${base}/${v.mmsi}`, { headers: { Accept: "application/json" } })
        .then((r) => (r.ok ? r.json() : r.status === 404 ? null : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => {
          const keep = d ? { name: d.name, type: d.type, imo: d.imo, callsign: d.callsign, dest: d.dest, draught: d.draught, len: d.len, beam: d.beam } : null;
          const s = staticFromOsf(keep);
          if (cache) cache.set(v.mmsi, s ? keep : null);          // a record with no particulars is a miss: retry tomorrow
          table.upsertStatic({ mmsi: v.mmsi, ...(s || {}) });       // marks as looked up either way
          if (s) onUpdate && onUpdate();
        })
        .catch(() => { /* leave unlooked-up; retried on a later tick */ })
        .finally(() => inflight.delete(v.mmsi));
    }
    return started;
  }

  /**
   * Bounding box around the viewer in aisstream subscribe form [[[latS, lonW], [latN, lonE]]],
   * padded so a moving viewer does not resubscribe every tick. OpenSeaFeed's free tier allows
   * 30 000 square degrees in total (probed 2026-09); a viewer needs well under one.
   */
  function aisstreamBox(lat, lon, radiusM, padFactor) {
    const r = radiusM * (padFactor || 1.5);
    const dLat = r / 111320, dLon = r / (111320 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
    const c = (v, m) => Math.round(Math.max(-m, Math.min(m, v)) * 1000) / 1000;
    return [[[c(lat - dLat, 90), c(lon - dLon, 180)], [c(lat + dLat, 90), c(lon + dLon, 180)]]];
  }

  /**
   * Live AIS over an aisstream.io-protocol WebSocket. Browsers do not apply CORS to WebSockets,
   * so this runs straight from the page. Reconnects with backoff; resubscribes when the viewer
   * moves out of the padded box. `apiKey` is optional (OpenSeaFeed's free tier is keyless).
   */
  function aisstreamSocket(url, apiKey, lookupBase) {
    return function start(ctx) {
      let stopped = false, ws = null, timer = null, box = null, backoff = 1000, gotAny = false, watchdog = null;
      const inflight = new Set();
      const WS = ctx.WebSocket || (typeof WebSocket !== "undefined" ? WebSocket : null);
      if (!WS) { ctx.onError(new Error("WebSocket unavailable")); return { stop() {}, refresh() {} }; }
      const inBox = (lat, lon) => box && lat > box[0][0][0] && lat < box[0][1][0] && lon > box[0][0][1] && lon < box[0][1][1];
      function subscribe() {
        const { lat, lon, radiusM } = ctx.getCenter();
        box = aisstreamBox(lat, lon, radiusM);
        const sub = { BoundingBoxes: box };
        if (apiKey) sub.APIKey = apiKey;
        ws.send(JSON.stringify(sub));
      }
      function flush() {
        if (gotAny) ctx.onUpdate(); gotAny = false;
        if (lookupBase && ctx.lookupStatic !== false) lookupMissingStatic(ctx.table, { base: lookupBase, cache: ctx.staticCache, fetchImpl: ctx.fetch, inflight, limit: 5, center: ctx.getCenter(), onUpdate: () => { gotAny = true; } });
        if (!stopped) timer = setTimeout(flush, ctx.pollMs || 1000);
      }
      function connect() {
        if (stopped) return;
        try { ws = new WS(url); } catch (e) { ctx.onError(e); return retry(); }
        ws.onopen = () => { backoff = 1000; subscribe(); };
        ws.onmessage = (e) => {
          let m; try { m = JSON.parse(e.data); } catch (err) { return; }
          if (m && m.error) { ctx.onError(new Error(m.error)); return; }
          if (ingestAisstreamFrame(ctx.table, m)) gotAny = true;
        };
        ws.onerror = () => { /* onclose follows */ };
        ws.onclose = (e) => { ws = null; if (!stopped) { if (e && e.code !== 1000 && e.code !== 1005) ctx.onError(new Error(`AIS socket closed (${e.code})`)); retry(); } };
      }
      function retry() { clearTimeout(watchdog); watchdog = setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 30e3); }
      // viewer moved: resubscribe if the padded box no longer covers the range
      function check() {
        if (stopped) return;
        const { lat, lon, radiusM } = ctx.getCenter();
        const inner = aisstreamBox(lat, lon, radiusM, 1.0)[0];
        if (ws && ws.readyState === 1 && box && !(inBox(inner[0][0], inner[0][1]) && inBox(inner[1][0], inner[1][1]))) { ws.close(1000); }   // onclose reconnects with a new box
        setTimeout(check, 5000);
      }
      connect(); flush(); setTimeout(check, 5000);
      return {
        stop() { stopped = true; clearTimeout(timer); clearTimeout(watchdog); if (ws) { ws.onclose = null; ws.close(1000); ws = null; } },
        refresh() { if (ws && ws.readyState === 1) ws.close(1000); },
      };
    };
  }

  /** Simulated traffic: a handful of ships running the charted lanes near the viewer, plus a ferry and a sailboat. */
  function demoProvider() {
    return function start(ctx) {
      let stopped = false, timer = null;
      const { lat, lon } = ctx.getCenter();
      const lanes = (ctx.lanes || []).filter((l) => l.kind === "lane" && l.ring && l.orient != null);
      const ships = [];
      const mk = (o) => ships.push(o);
      // one ship per lane (up to 6), started at a random point in the lane
      lanes.slice(0, 6).forEach((l, i) => {
        const c = l.centroid;
        const types = [70, 80, 60, 70, 89, 74];
        const names = ["EVER GLORY", "POLAR ENDEAVOUR", "GRAND PRINCESS", "MSC AURORA", "SEA-RIVER LOGISTICS", "ONE APUS"];
        mk({ mmsi: 366000000 + i, name: names[i], shipType: types[i], lat: c.lat, lon: c.lon, sog: 11 + (i % 3) * 3, cog: l.orient, heading: l.orient, navStat: 0, dims: { a: 200 + i * 20, b: 60, c: 16, d: 16 }, callSign: "WDE" + (4000 + i), imo: 9400000 + i, destination: ["SEATTLE", "TACOMA", "VANCOUVER", "OAKLAND", "ANACORTES", "EVERETT"][i], draught: 9 + i });
      });
      // a ferry and a sailboat nearby regardless of lanes
      mk({ mmsi: 366772760, name: "WENATCHEE", shipType: 60, lat: lat + 0.02, lon: lon + 0.01, sog: 17, cog: 250, heading: 250, navStat: 0, dims: { a: 70, b: 70, c: 14, d: 14 }, callSign: "WDC7373", destination: "BAINBRIDGE IS", draught: 5.5 });
      mk({ mmsi: 338123456, name: "S/V RAVEN", shipType: 36, lat: lat - 0.05, lon: lon + 0.07, sog: 5.5, cog: 20, heading: 15, navStat: 8, dims: { a: 6, b: 6, c: 2, d: 2 }, callSign: "WDK9911", destination: "", draught: 2.1 });
      mk({ mmsi: 366999000, name: "ISLAND TUG", shipType: 52, lat: lat + 0.03, lon: lon - 0.03, sog: 0, cog: 90, heading: 95, navStat: 1, dims: { a: 15, b: 15, c: 5, d: 5 }, callSign: "WDF1122", destination: "ANCHORED", draught: 4 });
      let last = Date.now();
      function tick() {
        if (stopped) return;
        const now = Date.now(), dt = (now - last) / 1000; last = now;
        for (const s of ships) {
          if (s.navStat !== 1 && s.sog > 0) {
            const p = Geo.destination(s.lat, s.lon, s.cog, s.sog * Geo.KN * dt * (ctx.demoSpeed || 1));
            s.lat = p.lat; s.lon = p.lon;
            // sailboat wanders
            if (s.shipType === 36) { s.cog = Geo.wrap360(s.cog + (Math.random() - 0.5) * 6); s.heading = Geo.wrap360(s.cog - 5); }
            // turn ships around when they leave their lane
            const lane = laneAt(s.lat, s.lon, lanes);
            if (lanes.length && s.shipType !== 36 && s.shipType !== 60 && !lane) { s.cog = Geo.wrap360(s.cog + 180); s.heading = s.cog; }
            if (s.shipType === 60 && Geo.haversine(s.lat, s.lon, lat, lon) > 6000) { s.cog = Geo.wrap360(s.cog + 180); s.heading = s.cog; }
          }
          ctx.table.upsertPosition({ mmsi: s.mmsi, lat: s.lat, lon: s.lon, sog: s.sog, cog: s.cog, heading: s.heading, navStat: s.navStat, rot: 0, posAcc: true, at: now });
          if (!ctx.table.get(s.mmsi).staticAt) ctx.table.upsertStatic({ mmsi: s.mmsi, name: s.name, callSign: s.callSign, imo: s.imo, shipType: s.shipType, dims: s.dims, draught: s.draught, destination: s.destination, at: now });
        }
        ctx.onUpdate();
        timer = setTimeout(tick, 2000);
      }
      tick();
      return { stop() { stopped = true; clearTimeout(timer); }, refresh() {} };
    };
  }

  const AIS_PROVIDERS = {
    digitraffic: {
      id: "digitraffic", name: "Digitraffic (Finland)",
      attribution: "Fintraffic / digitraffic.fi, CC BY 4.0",
      bbox: [19.0, 59.3, 31.6, 66.0],
      pollMs: 10e3,
      start: restPoller("https://meri.digitraffic.fi/api/ais/v1", { "Digitraffic-User": "random-sketches/marine-ar", Accept: "application/json" }),
    },
    openseafeed: {
      id: "openseafeed", name: "OpenSeaFeed (worldwide)",
      attribution: "OpenSeaFeed community AIS, CC BY 4.0",
      bbox: null, worldwide: true,
      pollMs: 1000,
      start: aisstreamSocket("wss://stream.openseafeed.com/v1/stream", null, "https://api.openseafeed.com/v1/vessels"),
    },
    proxy: {
      id: "proxy", name: "Local proxy (aisstream.io)",
      attribution: "aisstream.io via proxy.js",
      bbox: null,
      pollMs: 5e3,
      start(ctx) { return restPoller((ctx.proxyBase || "") + "/ais", { Accept: "application/json" })(ctx); },
    },
    demo: {
      id: "demo", name: "Demo traffic",
      attribution: "simulated vessels",
      bbox: null,
      pollMs: 2e3,
      start: demoProvider(),
    },
  };

  /**
   * Live provider for a point: a national feed whose coverage box contains it (denser, official),
   * else the worldwide community feed. Null only if no live provider is registered.
   */
  function aisProviderFor(lat, lon) {
    for (const p of Object.values(AIS_PROVIDERS)) {
      if (!p.bbox) continue;
      const [w, s, e, n] = p.bbox;
      if (lon >= w && lon <= e && lat >= s && lat <= n) return p;
    }
    return Object.values(AIS_PROVIDERS).find((p) => p.worldwide) || null;
  }

  // ---- Nominatim ----------------------------------------------------------

  async function reverseGeocode(lat, lon, fetchImpl) {
    const f = fetchImpl || fetch;
    const u = `https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&format=jsonv2&zoom=14`;
    const res = await f(u, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const d = await res.json();
    const a = d.address || {};
    return {
      city: a.city || a.town || a.village || a.municipality || a.county || null,
      water: a.water || a.bay || a.strait || a.sea || null,
      neighbourhood: a.neighbourhood || a.suburb || a.quarter || null,
      display: d.display_name || null,
    };
  }

  // ---- Magnetic declination (NOAA WMM, CORS) --------------------------------

  async function declination(lat, lon, fetchImpl) {
    const f = fetchImpl || fetch;
    const u = `https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination?lat1=${lat.toFixed(3)}&lon1=${lon.toFixed(3)}&resultFormat=json&key=zNEw7`;
    const res = await f(u);
    if (!res.ok) throw new Error(`WMM HTTP ${res.status}`);
    const d = await res.json();
    const r = d.result && d.result[0];
    return r ? r.declination : null;
  }

  // ---- Lane cache ---------------------------------------------------------

  class LaneStore {
    constructor(opts) {
      this.storage = (opts && opts.storage) || null;
      this.ttlMs = (opts && opts.ttlMs) || 7 * 24 * 3600e3;    // lanes change rarely
      this.key = (opts && opts.key) || "marine-ar:lanes";
      this.center = null; this.radius = 0; this.at = 0; this.lanes = [];
      this._load();
    }
    _load() {
      if (!this.storage) return;
      try {
        const d = JSON.parse(this.storage.getItem(this.key) || "null");
        if (!d || Date.now() - d.at > this.ttlMs) return;
        Object.assign(this, { center: d.center, radius: d.radius, at: d.at });
        this.lanes = (d.lanes || []).map((l) => ({ ...l, style: LANE_STYLE[l.kind] }));
      } catch (e) { /* ignore */ }
    }
    _save() {
      if (!this.storage) return;
      try { this.storage.setItem(this.key, JSON.stringify({ center: this.center, radius: this.radius, at: this.at, lanes: this.lanes.map(({ style, ...l }) => l) })); }
      catch (e) { /* quota */ }
    }
    needsFetch(lat, lon, radiusM) {
      if (!this.center || Date.now() - this.at > this.ttlMs) return true;
      if (radiusM > this.radius * 1.05) return true;
      return Geo.haversine(lat, lon, this.center.lat, this.center.lon) > this.radius * 0.4;
    }
    set(lat, lon, radiusM, lanes) { this.center = { lat, lon }; this.radius = radiusM; this.at = Date.now(); this.lanes = lanes; this._save(); }
    clear() { this.center = null; this.lanes = []; if (this.storage) try { this.storage.removeItem(this.key); } catch (e) { /* */ } }
  }

  return {
    ENC_DIRECT, LANE_LAYERS, LANE_STYLE, envelopeParams, normalizeLane, bboxAround, fetchLanes, dedupeLanes, laneAt,
    LAND_LAYERS, fetchLand, normalizeLand, attachElevations, LandStore,
    ATON_LAYERS, ATON_KIND, S57_COLOUR, LITCHR, lightCharacter, normalizeAton, fetchAton, mergeAton, BoxStore,
    NAV_STATUS, shipType, CATEGORY_COLOR, flagOf, VesselTable,
    ingestDigitrafficLocations, ingestDigitrafficVessel, restPoller, demoProvider, AIS_PROVIDERS, aisProviderFor,
    ingestAisstreamFrame, aisstreamBox, aisstreamSocket, StaticCache, staticFromOsf, lookupMissingStatic,
    reverseGeocode, declination, LaneStore,
  };
}));

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
      mk({ mmsi: 338123456, name: "S/V RAVEN", shipType: 36, lat: lat - 0.012, lon: lon + 0.02, sog: 5.5, cog: 20, heading: 15, navStat: 8, dims: { a: 6, b: 6, c: 2, d: 2 }, callSign: "WDK9911", destination: "", draught: 2.1 });
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

  /** Provider whose coverage box contains the point, else null (caller decides between proxy/demo). */
  function aisProviderFor(lat, lon) {
    for (const p of Object.values(AIS_PROVIDERS)) {
      if (!p.bbox) continue;
      const [w, s, e, n] = p.bbox;
      if (lon >= w && lon <= e && lat >= s && lat <= n) return p;
    }
    return null;
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
    NAV_STATUS, shipType, CATEGORY_COLOR, flagOf, VesselTable,
    ingestDigitrafficLocations, ingestDigitrafficVessel, restPoller, demoProvider, AIS_PROVIDERS, aisProviderFor,
    reverseGeocode, declination, LaneStore,
  };
}));

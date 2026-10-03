/*
 * chart.js - NOAA chart data access for the browser.
 *
 * Two NOAA services power everything, both send CORS headers so no proxy
 * is needed:
 *
 *  1. ENC Online (gis.charttools.noaa.gov) - Esri Maritime Chart Service that
 *     renders official NOAA ENC cells with S-52 symbology on demand. We use
 *     its /export endpoint as a tile source (one export per 256px tile) and
 *     pass ECDIS "display_params" for colour scheme and safety contour.
 *
 *  2. ENC Direct (encdirect.noaa.gov) - the same ENC data exposed as ArcGIS
 *     feature layers grouped by compilation scale (harbour, approach, ...).
 *     We query S-57 object classes directly:
 *        DEPARE  Depth_Area        DRVAL1 (min) / DRVAL2 (max) metres
 *        SOUNDG  Sounding_point    Z metres
 *        LNDARE  Land_Area
 *        UWTROC/OBSTRN/WRECKS      isolated dangers
 *     Depths are in metres below the chart datum (MLLW for US charts).
 *
 * Works as a browser global (window.Chart) or CommonJS (fetch must exist).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Chart = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ENC_ONLINE = "https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/ENCOnline/MapServer/exts/MaritimeChartService/MapServer";
  const ENC_DIRECT = "https://encdirect.noaa.gov/arcgis/rest/services/encdirect";

  // ENC Direct layer ids, per service (verified against the MapServer JSON).
  // Harbour = 1:10,001-1:50,000 cells (Puget Sound is fully covered at this
  // scale); approach = 1:50,001-1:150,000 as a fallback in open water.
  const LAYERS = {
    harbour: {
      service: "enc_harbour",
      depthArea: 227, dredgedArea: 228, landArea: 233, sounding: 76,
      depthContour: 104, obstruction: 33, rock: 34, wreck: 36,
      beaconLateral: 1, buoyLateral: 6, bridgeArea: 141, bridgeLine: 87, cableOverhead: 88, pipeOverhead: 92,
      conveyorLine: 89, conveyorArea: 144, gateLine: 121, lockBasin: 181, soundingDatum: 224, pylonPoint: 28, pylonArea: 149,
    },
    approach: {
      service: "enc_approach",
      depthArea: 232, dredgedArea: 233, landArea: 238, sounding: 80,
      depthContour: 108, obstruction: 36, rock: 37, wreck: 39,
    },
  };

  // S-52 colour tables, extracted from OpenCPN data/s57data/chartsymbols.xml.
  // Only the tokens the app uses.
  const S52 = {
    DAY: {
      DEPDW: "#d4eaee", DEPMD: "#bad5e1", DEPMS: "#98c5f2", DEPVS: "#73b6ef", DEPIT: "#83b295",
      DEPSC: "#525a5c", DEPCN: "#7d898c", LANDA: "#c9b97a", LANDF: "#8b661f", CSTLN: "#525a5c",
      NODTA: "#a3b4b7", CHBLK: "#070707", CHGRD: "#7d898c", CHRED: "#f15469", CHGRN: "#68e456",
      CHYLW: "#f4da48", CHMGD: "#c545c3", ISDNG: "#c545c3", DNGHL: "#f15469", SNDG1: "#7d898c",
      SNDG2: "#070707", SHIPS: "#070707", PLRTE: "#dc4025", UINFB: "#3a78f0", UINFO: "#eb7d36",
      UINFR: "#f15469", UINFG: "#68e456", ARPAT: "#3fa56f", CHWHT: "#d4eaee",
    },
    DUSK: {
      DEPDW: "#070707", DEPMD: "#0c0e0f", DEPMS: "#151b21", DEPVS: "#16232f", DEPIT: "#15251f",
      DEPSC: "#363c3d", DEPCN: "#292e2e", LANDA: "#2c291b", LANDF: "#4c3811", CSTLN: "#363c3d",
      NODTA: "#292e2e", CHBLK: "#363c3d", CHGRD: "#363c3d", CHRED: "#501c23", CHGRN: "#234c1d",
      CHYLW: "#514918", CHMGD: "#4a3a51", ISDNG: "#4a3a51", DNGHL: "#501c23", SNDG1: "#292e2e",
      SNDG2: "#474e4f", SHIPS: "#474e4f", PLRTE: "#49150c", UINFB: "#132850", UINFO: "#4b2613",
      UINFR: "#501c23", UINFG: "#234c1d", ARPAT: "#1a452f", CHWHT: "#474e4f",
    },
    NIGHT: {
      DEPDW: "#070707", DEPMD: "#070707", DEPMS: "#030413", DEPVS: "#030413", DEPIT: "#080b09",
      DEPSC: "#252929", DEPCN: "#1f2223", LANDA: "#0d0a08", LANDF: "#171105", CSTLN: "#252929",
      NODTA: "#070707", CHBLK: "#1f2223", CHGRD: "#1f2223", CHRED: "#3b110a", CHGRN: "#162207",
      CHYLW: "#29210a", CHMGD: "#341234", ISDNG: "#341234", DNGHL: "#3b110a", SNDG1: "#1f2223",
      SNDG2: "#2b3030", SHIPS: "#252929", PLRTE: "#42130b", UINFB: "#151d45", UINFO: "#341c0c",
      UINFR: "#3b110a", UINFG: "#162207", ARPAT: "#0c1f15", CHWHT: "#252929",
    },
  };

  /**
   * S-52 DEPARE01 depth band. Port of s52cnsy.cpp DEPARE01 (4-shade mode).
   *   drval1/drval2 : area min/max depth (m). shallow/safety/deep : mariner contours (m).
   * Returns the colour token.
   */
  function depthBand(drval1, drval2, shallow, safety, deep) {
    if (drval1 == null) return "NODTA";
    if (drval2 == null || drval2 <= drval1) drval2 = drval1 + 0.01;
    let fill = "DEPIT";
    if (drval1 >= 0 && drval2 > 0) fill = "DEPVS";
    if (drval1 >= shallow && drval2 > shallow) fill = "DEPMS";
    if (drval1 >= safety && drval2 > safety) fill = "DEPMD";
    if (drval1 >= deep && drval2 > deep) fill = "DEPDW";
    return fill;
  }

  // ---------------------------------------------------------------------
  // Web-Mercator helpers for tiling the ENC Online export service.
  // ---------------------------------------------------------------------
  const ORIGIN = 20037508.342789244;
  function tileBounds3857(x, y, z) {
    const n = Math.pow(2, z), size = 2 * ORIGIN / n;
    const minx = -ORIGIN + x * size, maxx = minx + size;
    const maxy = ORIGIN - y * size, miny = maxy - size;
    return [minx, miny, maxx, maxy];
  }

  /**
   * ECDIS display parameters for the Maritime Chart Service. Valid keys and
   * ranges were probed against the live service (10.9.1).
   *   scheme: 0 day, 1 dusk, 2 night. safety/shallow/deep in metres.
   *   units: 1 metres, 2 feet, 3 fathoms (DisplayDepthUnits).
   */
  function displayParams(opts) {
    opts = opts || {};
    const p = [
      { name: "ColorScheme", value: opts.scheme == null ? 0 : opts.scheme },
      { name: "SafetyContour", value: opts.safety == null ? 5 : opts.safety },
      { name: "ShallowContour", value: opts.shallow == null ? 2 : opts.shallow },
      { name: "DeepContour", value: opts.deep == null ? 20 : opts.deep },
      { name: "SafetyDepth", value: opts.safetyDepth == null ? (opts.safety == null ? 5 : opts.safety) : opts.safetyDepth },
      { name: "DisplayDepthUnits", value: opts.units == null ? 1 : opts.units },
      { name: "TwoDepthShades", value: opts.twoShades ? 1 : 2 },
      { name: "DisplayCategory", value: opts.displayCategory || "1,2,4" },
    ];
    return JSON.stringify({ ECDISParameters: { version: "10.9.1", DynamicParameters: { Parameter: p } } });
  }

  /** URL for a 256px Web Mercator tile rendered by ENC Online. */
  function encTileUrl(x, y, z, opts) {
    const b = tileBounds3857(x, y, z);
    const q = new URLSearchParams({
      bbox: b.join(","), bboxSR: "3857", imageSR: "3857",
      size: "256,256", format: "png32", transparent: "true", f: "image",
      display_params: displayParams(opts),
    });
    return ENC_ONLINE + "/export?" + q.toString();
  }

  // ---------------------------------------------------------------------
  // ENC Direct feature queries
  // ---------------------------------------------------------------------
  const memCache = new Map();

  async function fetchJson(url) {
    if (memCache.has(url)) return memCache.get(url);
    const r = await fetch(url);
    if (!r.ok) throw new Error("NOAA " + r.status + " " + url.slice(0, 120));
    const j = await r.json();
    if (j.error) throw new Error("NOAA: " + (j.error.message || JSON.stringify(j.error)));
    memCache.set(url, j);
    return j;
  }

  function layerUrl(scale, key) {
    const L = LAYERS[scale];
    return `${ENC_DIRECT}/${L.service}/MapServer/${L[key]}/query`;
  }

  /** Point-in-polygon query, returns the feature attribute rows. */
  async function queryPoint(scale, key, lat, lon, outFields) {
    const q = new URLSearchParams({
      geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
      spatialRel: "esriSpatialRelIntersects", outFields: outFields || "*",
      returnGeometry: "false", f: "json",
    });
    const j = await fetchJson(layerUrl(scale, key) + "?" + q);
    return (j.features || []).map(f => f.attributes);
  }

  /** Point features within a radius (metres). Returns [{attrs, lat, lon}]. */
  async function queryNear(scale, key, lat, lon, radiusM, outFields) {
    const q = new URLSearchParams({
      geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326",
      distance: String(radiusM), units: "esriSRUnit_Meter",
      spatialRel: "esriSpatialRelIntersects", outFields: outFields || "*",
      returnGeometry: "true", outSR: "4326", f: "json",
    });
    const j = await fetchJson(layerUrl(scale, key) + "?" + q);
    return (j.features || []).map(f => ({ attrs: f.attributes, lat: f.geometry && f.geometry.y, lon: f.geometry && f.geometry.x }));
  }

  /**
   * Envelope query as GeoJSON with pagination (maxRecordCount is 1000).
   * bbox = [west, south, east, north]. Returns a GeoJSON FeatureCollection.
   */
  async function queryBbox(scale, key, bbox, outFields, onProgress) {
    const features = [];
    let offset = 0;
    for (let page = 0; page < 40; page++) {
      const q = new URLSearchParams({
        geometry: bbox.join(","), geometryType: "esriGeometryEnvelope", inSR: "4326",
        spatialRel: "esriSpatialRelIntersects", outFields: outFields || "*",
        returnGeometry: "true", outSR: "4326", geometryPrecision: "6",
        resultOffset: String(offset), resultRecordCount: "1000", f: "geojson",
      });
      const j = await fetchJson(layerUrl(scale, key) + "?" + q);
      const fs = j.features || [];
      features.push(...fs);
      if (onProgress) onProgress(features.length);
      const more = j.exceededTransferLimit || (j.properties && j.properties.exceededTransferLimit);
      if (!more && fs.length < 1000) break;
      if (fs.length === 0) break;
      offset += fs.length;
    }
    return { type: "FeatureCollection", features };
  }

  /**
   * Depth at a position. Tries harbour-scale cells first, then approach.
   * Returns:
   *   { band: {min, max}|null, sounding: {depth, distM, lat, lon}|null,
   *     dredged: {min}|null, land: bool, cell: "US5SEAGK", scale }
   * All depths in metres below chart datum (MLLW).
   */
  async function depthAt(lat, lon, opts) {
    opts = opts || {};
    const radius = opts.soundingRadiusM || 250;
    for (const scale of ["harbour", "approach"]) {
      const [areas, land, dredged, snd, sdat] = await Promise.all([
        queryPoint(scale, "depthArea", lat, lon, "DRVAL1,DRVAL2,DSNM"),
        queryPoint(scale, "landArea", lat, lon, "OBJNAM,DSNM").catch(() => []),
        queryPoint(scale, "dredgedArea", lat, lon, "DRVAL1,DRVAL2,DSNM").catch(() => []),
        queryNear(scale, "sounding", lat, lon, radius, "Z,SORDAT,DSNM").catch(() => []),
        LAYERS[scale].soundingDatum ? queryPoint(scale, "soundingDatum", lat, lon, "VERDAT,INFORM").catch(() => []) : Promise.resolve([]),
      ]);
      if (!areas.length && !land.length && !snd.length) continue;

      // Prefer the tightest band if several cells overlap.
      let band = null;
      for (const a of areas) {
        if (a.DRVAL1 == null) continue;
        const b = { min: a.DRVAL1, max: a.DRVAL2 == null ? a.DRVAL1 : a.DRVAL2, cell: a.DSNM };
        if (!band || (b.max - b.min) < (band.max - band.min)) band = b;
      }
      let nearest = null;
      for (const s of snd) {
        if (s.attrs.Z == null || s.lat == null) continue;
        const d = haversineM(lat, lon, s.lat, s.lon);
        if (!nearest || d < nearest.distM) nearest = { depth: s.attrs.Z, distM: d, lat: s.lat, lon: s.lon, date: s.attrs.SORDAT };
      }
      return {
        scale,
        band,
        sounding: nearest,
        soundings: snd.filter(s => s.attrs.Z != null).map(s => ({ depth: s.attrs.Z, lat: s.lat, lon: s.lon })),
        dredged: dredged.length ? { min: dredged[0].DRVAL1, max: dredged[0].DRVAL2 } : null,
        land: land.length > 0,
        datum: (() => { const a = sdat.find(r => /lake/i.test(String(r.INFORM || ""))); return a ? { lake: true, inform: a.INFORM } : null; })(),
        cell: (band && band.cell) || (areas[0] && areas[0].DSNM) || (land[0] && land[0].DSNM) || null,
      };
    }
    return { scale: null, band: null, sounding: null, soundings: [], dredged: null, land: false, cell: null };
  }

  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371008.8, d2r = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * d2r / 2) ** 2 + Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin((lon2 - lon1) * d2r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  /**
   * Everything the router needs for a bounding box: depth areas, dredged
   * areas, land, and point hazards. Uses harbour scale, fills gaps from
   * approach scale. onProgress(stage, count) is optional.
   */
  async function fetchRoutingData(bbox, onProgress) {
    const prog = (s, n) => onProgress && onProgress(s, n);
    const [dep, drg, land, rocks, obst, wrecks] = await Promise.all([
      queryBbox("harbour", "depthArea", bbox, "DRVAL1,DRVAL2", n => prog("depth areas", n)),
      queryBbox("harbour", "dredgedArea", bbox, "DRVAL1,DRVAL2", n => prog("dredged", n)).catch(() => ({ features: [] })),
      queryBbox("harbour", "landArea", bbox, "OBJNAM", n => prog("land", n)),
      queryBbox("harbour", "rock", bbox, "VALSOU,WATLEV", n => prog("rocks", n)).catch(() => ({ features: [] })),
      queryBbox("harbour", "obstruction", bbox, "VALSOU,WATLEV,CATOBS", n => prog("obstructions", n)).catch(() => ({ features: [] })),
      queryBbox("harbour", "wreck", bbox, "VALSOU,WATLEV,CATWRK", n => prog("wrecks", n)).catch(() => ({ features: [] })),
    ]);
    const none = { features: [] };
    const [bcn, boy, brA, brL, cbl, pip, cvL, cvA, gat, lok, sdat, pyP, pyA] = await Promise.all([
      queryBbox("harbour", "beaconLateral", bbox, "CATLAM,COLOUR,OBJNAM", n => prog("beacons", n)).catch(() => none),
      queryBbox("harbour", "buoyLateral", bbox, "CATLAM,COLOUR,OBJNAM", n => prog("buoys", n)).catch(() => none),
      queryBbox("harbour", "bridgeArea", bbox, "CATBRG,VERCLR,VERCCL,VERCOP,HORCLR,OBJNAM,INFORM", n => prog("bridges", n)).catch(() => none),
      queryBbox("harbour", "bridgeLine", bbox, "CATBRG,VERCLR,VERCCL,VERCOP,HORCLR,OBJNAM,INFORM").catch(() => none),
      queryBbox("harbour", "cableOverhead", bbox, "VERCLR,VERCSA,OBJNAM,INFORM", n => prog("overhead cables", n)).catch(() => none),
      queryBbox("harbour", "pipeOverhead", bbox, "VERCLR,OBJNAM,INFORM").catch(() => none),
      queryBbox("harbour", "conveyorLine", bbox, "VERCLR,OBJNAM").catch(() => none),
      queryBbox("harbour", "conveyorArea", bbox, "VERCLR,OBJNAM").catch(() => none),
      queryBbox("harbour", "gateLine", bbox, "CATGAT,HORCLR,OBJNAM", n => prog("lock gates", n)).catch(() => none),
      queryBbox("harbour", "lockBasin", bbox, "OBJNAM,HORCLR").catch(() => none),
      queryBbox("harbour", "soundingDatum", bbox, "VERDAT,INFORM").catch(() => none),
      queryBbox("harbour", "pylonPoint", bbox, "CATPYL").catch(() => none),
      queryBbox("harbour", "pylonArea", bbox, "CATPYL").catch(() => none),
    ]);
    const markOf = (kind) => f => ({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], kind, name: (f.properties || {}).OBJNAM || null, props: f.properties || {} });
    const over = (kind) => f => ({ kind, geometry: f.geometry, properties: f.properties || {} });
    let approach = { features: [] }, approachLand = { features: [] };
    if (dep.features.length === 0) {
      approach = await queryBbox("approach", "depthArea", bbox, "DRVAL1,DRVAL2", n => prog("approach depth", n));
      approachLand = await queryBbox("approach", "landArea", bbox, "OBJNAM", n => prog("approach land", n));
    }
    return {
      bbox,
      depthAreas: dep.features.concat(approach.features),
      dredgedAreas: drg.features,
      land: land.features.concat(approachLand.features),
      hazards: [].concat(
        rocks.features.map(f => tagHazard(f, "rock")),
        obst.features.map(f => tagHazard(f, "obstruction")),
        wrecks.features.map(f => tagHazard(f, "wreck"))),
      lateralMarks: [].concat(bcn.features.filter(f => f.geometry).map(markOf("BCNLAT")), boy.features.filter(f => f.geometry).map(markOf("BOYLAT"))),
      overheads: [].concat(
        brA.features.map(over("bridge")), brL.features.map(over("bridge")), cbl.features.map(over("cable")),
        pip.features.map(over("pipe")), cvL.features.map(over("conveyor")), cvA.features.map(over("conveyor"))).filter(o => o.geometry),
      gates: gat.features.filter(f => f.geometry).map(f => ({ geometry: f.geometry, properties: f.properties || {} })),
      lockBasins: lok.features.filter(f => f.geometry),
      pylons: pyP.features.concat(pyA.features).filter(f => f.geometry).map(f => ({ geometry: f.geometry, properties: f.properties || {} })),
      datumAreas: sdat.features.filter(f => f.geometry && /lake/i.test(String((f.properties || {}).INFORM || "")))
        .map(f => ({ kind: "sounding", lake: true, geometry: f.geometry, properties: f.properties })),
    };
  }

  // Port of the depth defaults in OBSTRN04 / WRECKS02 when VALSOU is absent.
  function tagHazard(f, kind) {
    const p = f.properties || {};
    let depth = p.VALSOU;
    if (depth == null) {
      const wat = Number(p.WATLEV);
      if (kind === "wreck") {
        const cat = Number(p.CATWRK);
        depth = cat === 1 ? 20 : cat === 2 ? 0 : -15; // 1 non-dangerous, 2 dangerous, else unknown = assume dangerous
      } else {
        depth = wat === 5 ? 0 : wat === 3 ? 0.01 : -15;
      }
      if (wat === 1 || wat === 2) depth = -1; // dries / always dry
    }
    return { kind, depth: Number(depth), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], props: p };
  }

  // ---------------------------------------------------------------------
  // Tides: NOAA CO-OPS predictions (CORS enabled). Puget Sound stations.
  // ---------------------------------------------------------------------
  const COOPS = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
  const TIDE_STATIONS = [
    { id: "9447130", name: "Seattle", lat: 47.6026, lon: -122.3393 },
    { id: "9446484", name: "Tacoma", lat: 47.2667, lon: -122.4133 },
    { id: "9444900", name: "Port Townsend", lat: 48.1129, lon: -122.7595 },
    { id: "9447814", name: "Poulsbo", lat: 47.7333, lon: -122.6333 },
    { id: "9445958", name: "Bremerton", lat: 47.5617, lon: -122.6233 },
    { id: "9444090", name: "Port Angeles", lat: 48.125, lon: -123.44 },
    { id: "9449880", name: "Friday Harbor", lat: 48.5453, lon: -123.0128 },
    { id: "9447659", name: "Everett", lat: 47.9792, lon: -122.2233 },
    { id: "9446025", name: "Olympia (Budd Inlet)", lat: 47.0433, lon: -122.9033 },
    { id: "9447427", name: "Edmonds", lat: 47.8133, lon: -122.3833 },
  ];
  function nearestTideStation(lat, lon) {
    let best = null;
    for (const s of TIDE_STATIONS) {
      const d = haversineM(lat, lon, s.lat, s.lon);
      if (!best || d < best.distM) best = { ...s, distM: d };
    }
    return best;
  }
  /** 6-minute MLLW predictions (metres) for today and tomorrow at a station. */
  async function fetchTide(stationId) {
    const q = new URLSearchParams({
      product: "predictions", station: stationId, date: "today", range: "48",
      datum: "MLLW", units: "metric", time_zone: "gmt", interval: "6", format: "json",
    });
    const j = await fetchJson(COOPS + "?" + q);
    const rows = (j.predictions || []).map(p => ({ t: Date.parse(p.t.replace(" ", "T") + "Z"), h: parseFloat(p.v) }));
    const hilo = new URLSearchParams({
      product: "predictions", station: stationId, date: "today", range: "48",
      datum: "MLLW", units: "metric", time_zone: "gmt", interval: "hilo", format: "json",
    });
    let extremes = [];
    try {
      const k = await fetchJson(COOPS + "?" + hilo);
      extremes = (k.predictions || []).map(p => ({ t: Date.parse(p.t.replace(" ", "T") + "Z"), h: parseFloat(p.v), type: p.type }));
    } catch (e) { /* optional */ }
    return { stationId, series: rows, extremes };
  }
  /** Linear interpolation of tide height at time t (ms). */
  function tideAt(tide, t) {
    const s = tide && tide.series;
    if (!s || !s.length) return null;
    if (t <= s[0].t) return s[0].h;
    for (let i = 1; i < s.length; i++) {
      if (t <= s[i].t) {
        const f = (t - s[i - 1].t) / (s[i].t - s[i - 1].t);
        return s[i - 1].h + f * (s[i].h - s[i - 1].h);
      }
    }
    return s[s.length - 1].h;
  }

  // ---------------------------------------------------------------------
  // Lake Washington / Lake Union / Ship Canal water level (above the Ballard Locks).
  // Not tidal: the Corps holds the lakes between 20 ft (winter) and 22 ft (summer) on the
  // project datum, measured at the Locks. Charts above the locks reference soundings to
  // "Low Water of the Lakes", 20 ft (6.1 m) above MLLW, so depth now = charted + (level - 20 ft).
  // No public live feed with CORS was found, so this is the Corps' published operating
  // schedule (refill from Feb 15 to 22 ft by about June 1, hold through summer, draw down
  // through autumn to 20 ft by Dec 1). The user can override it.
  // ---------------------------------------------------------------------
  const LAKE_LOW_WATER_FT = 20;
  function lakeLevelFt(date) {
    const d = date instanceof Date ? date : new Date(date == null ? Date.now() : date);
    const y = d.getFullYear(), t = d.getTime();
    const at = (m, day) => new Date(y, m - 1, day).getTime();
    const lerp = (a, b, ta, tb) => a + (b - a) * (t - ta) / (tb - ta);
    if (t < at(2, 15)) return 20.0;
    if (t < at(6, 1)) return lerp(20.0, 22.0, at(2, 15), at(6, 1));
    if (t < at(9, 1)) return 22.0;
    if (t < at(12, 1)) return lerp(22.0, 20.0, at(9, 1), at(12, 1));
    return 20.0;
  }
  /** Height of the water above the lake chart datum, metres. overrideFt: user-entered level. */
  function lakeHeightM(date, overrideFt) {
    const ft = overrideFt != null && isFinite(overrideFt) ? overrideFt : lakeLevelFt(date);
    return (ft - LAKE_LOW_WATER_FT) * 0.3048;
  }

  return {
    ENC_ONLINE, ENC_DIRECT, LAYERS, S52, depthBand, LAKE_LOW_WATER_FT, lakeLevelFt, lakeHeightM,
    tileBounds3857, displayParams, encTileUrl,
    queryPoint, queryNear, queryBbox, depthAt, fetchRoutingData, tagHazard,
    TIDE_STATIONS, nearestTideStation, fetchTide, tideAt,
    _cache: memCache,
  };
}));

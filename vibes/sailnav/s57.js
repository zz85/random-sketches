/*
 * s57.js - read NOAA ENC cells (S-57 / ISO 8211 ".000" files) directly in
 * the browser, with nothing but ArrayBuffer/DataView/TextDecoder, and turn
 * the object classes a plotter cares about into GeoJSON.
 *
 * Also contains a minimal ZIP reader (stored + deflate) built on the
 * DecompressionStream browser API (falls back to zlib in Node/Bun) so a
 * NOAA "US5SEAGK.zip" download can be dropped straight onto the page.
 *
 * ISO 8211 in one paragraph: a file is a sequence of records. Each record has
 * a 24-byte ASCII leader (record length, base address of the field area,
 * sizes of the directory entry parts), a directory of (tag, length, position)
 * entries terminated by 0x1E, then the field area. The first record (DDR)
 * describes every field's subfields and binary formats such as b11 (uint8),
 * b12 (uint16 LE), b14 (uint32 LE), b24 (int32 LE), A (text to 0x1F),
 * B(40) (5 raw bytes). S-57 layers feature records (FRID + ATTF + FSPT) over
 * spatial records (VRID + SG2D/SG3D + VRPT) that share coordinates, so an
 * area's ring is assembled by walking its edges and their connected nodes.
 *
 * Works as a browser global (window.S57) or CommonJS.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.S57 = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FT = 0x1e, UT = 0x1f;
  const ascii = new TextDecoder("latin1");

  // S-57 object class codes (OBJL) and attribute codes (ATTL) used here.
  // Codes verified against OpenCPN data/s57data/s57objectclasses.csv and s57attributes.csv.
  const OBJL = {
    ACHARE: 4, BCNCAR: 5, BCNISD: 6, BCNLAT: 7, BCNSAW: 8, BCNSPP: 9, BRIDGE: 11, BOYCAR: 14, BOYINB: 15,
    BOYISD: 16, BOYLAT: 17, BOYSAW: 18, BOYSPP: 19, CBLOHD: 21, CBLSUB: 22, COALNE: 30, CONVYR: 34, DAYMAR: 39,
    DEPARE: 42, DEPCNT: 43, DRGARE: 46, FAIRWY: 51, FLODOC: 57, GATCON: 61, HULKES: 65, LNDARE: 71, LNDMRK: 74,
    LIGHTS: 75, LOKBSN: 79, MORFAC: 84, OBSTRN: 86, PILPNT: 90, PIPOHD: 93, PIPSOL: 94, PONTON: 95, PYLONS: 98,
    RESARE: 112, SEAARE: 119, SLCONS: 122, SOUNDG: 129, TSELNE: 145, TSSLPT: 148, UWTROC: 153, UNSARE: 154,
    WRECKS: 159, M_COVR: 302, M_NSYS: 305, M_QUAL: 308, M_SDAT: 309, M_VDAT: 312,
  };
  const OBJL_NAME = Object.fromEntries(Object.entries(OBJL).map(([k, v]) => [v, k]));
  const ATTL = {
    2: "BCNSHP", 4: "BOYSHP", 8: "CATACH", 9: "CATBRG", 11: "CATCBL", 17: "CATCON", 18: "CATCOV", 29: "CATGAT",
    36: "CATLAM", 42: "CATOBS", 49: "CATPYL", 59: "CATSEA", 60: "CATSLC", 66: "CATSPM", 71: "CATWRK", 75: "COLOUR",
    76: "COLPAT", 81: "CONDTN", 82: "CONRAD", 83: "CONVIS", 87: "DRVAL1", 88: "DRVAL2", 90: "ELEVAT", 93: "EXPSOU",
    95: "HEIGHT", 98: "HORCLR", 102: "INFORM", 107: "LITCHR", 113: "NATSUR", 116: "OBJNAM", 125: "QUASOU",
    131: "RESTRN", 133: "SCAMIN", 136: "SECTR1", 137: "SECTR2", 141: "SIGGRP", 142: "SIGPER", 147: "SORDAT",
    148: "SORIND", 149: "STATUS", 156: "TECSOU", 158: "TXTDSC", 174: "VALDCO", 178: "VALNMR", 179: "VALSOU",
    181: "VERCLR", 182: "VERCCL", 183: "VERCOP", 184: "VERCSA", 185: "VERDAT", 187: "WATLEV", 301: "NOBJNM", 402: "QUAPOS",
  };
  // Enumerated WATLEV names for tooltips
  const WATLEV = { 1: "partly submerged at high water", 2: "always dry", 3: "always under water", 4: "covers and uncovers", 5: "awash", 6: "subject to inundation", 7: "floating" };

  // ---------------------------------------------------------------------
  // ISO 8211
  // ---------------------------------------------------------------------
  function int(bytes, off, len) {
    let v = 0;
    for (let i = 0; i < len; i++) { const c = bytes[off + i]; if (c >= 48 && c <= 57) v = v * 10 + (c - 48); }
    return v;
  }

  /** Parse the field format string "(b11,b14,2b11,A(8),B(40),A)" into an array of {type,width,count}. */
  function parseFormat(fmt) {
    const s = fmt.indexOf("("), e = fmt.lastIndexOf(")");
    if (s < 0 || e < 0) return [];
    const out = [];
    for (const raw of fmt.slice(s + 1, e).split(",")) {
      const t = raw.trim();
      const mm = t.match(/^(\d*)([AIRBb])(?:\((\d+)\)|(\d\d))?$/);
      if (!mm) continue;
      const count = mm[1] ? parseInt(mm[1], 10) : 1;
      const type = mm[2];
      let width = null, kind = type;
      if (type === "b") { kind = "b" + mm[4]; }
      else if (mm[3]) width = parseInt(mm[3], 10);
      if (type === "B" && mm[3]) width = mm[3] / 8;
      for (let i = 0; i < count; i++) out.push({ kind, width });
    }
    return out;
  }

  /** Read the DDR and return { fields: {tag: {names[], formats[], repeating}}, leader } */
  function readDDR(bytes) {
    const recLen = int(bytes, 0, 5);
    const base = int(bytes, 12, 5);
    const sl = int(bytes, 20, 1), sp = int(bytes, 21, 1), st = int(bytes, 23, 1);
    const entryLen = st + sl + sp;
    const fields = {};
    for (let p = 24; p + entryLen <= base - 1; p += entryLen) {
      const tag = ascii.decode(bytes.subarray(p, p + st));
      const len = int(bytes, p + st, sl), pos = int(bytes, p + st + sl, sp);
      const start = base + pos;
      const body = bytes.subarray(start, start + len);
      // field control(9 chars) UT name UT labels UT formats FT
      const parts = [];
      let s = 0;
      for (let i = 0; i < body.length; i++) if (body[i] === UT || body[i] === FT) { parts.push(ascii.decode(body.subarray(s, i))); s = i + 1; }
      const labels = parts[1] || "", formats = parts[2] || "";
      const repeating = labels.startsWith("*");
      fields[tag] = {
        names: labels.replace(/^\*/, "").split("!").filter(Boolean),
        formats: parseFormat(formats),
        repeating,
      };
    }
    return { fields, recLen };
  }

  /** Decode one field body according to its DDR description. Returns array of row objects. */
  function decodeField(desc, body, view, baseOff) {
    const rows = [];
    let p = 0;
    const n = body.length;
    const end = body[n - 1] === FT ? n - 1 : n;
    if (!desc || !desc.formats.length) return [{ raw: body }];
    do {
      const row = {};
      for (let i = 0; i < desc.formats.length && p < end; i++) {
        const f = desc.formats[i], name = desc.names[i] || ("f" + i);
        switch (f.kind) {
          case "b11": row[name] = body[p]; p += 1; break;
          case "b12": row[name] = view.getUint16(baseOff + p, true); p += 2; break;
          case "b14": row[name] = view.getUint32(baseOff + p, true); p += 4; break;
          case "b21": row[name] = view.getInt8(baseOff + p); p += 1; break;
          case "b22": row[name] = view.getInt16(baseOff + p, true); p += 2; break;
          case "b24": row[name] = view.getInt32(baseOff + p, true); p += 4; break;
          case "B": { row[name] = body.subarray(p, p + f.width); p += f.width; break; }
          default: { // A, I, R : text, fixed width or UT-terminated
            if (f.width) { row[name] = ascii.decode(body.subarray(p, p + f.width)); p += f.width; }
            else { let e = p; while (e < end && body[e] !== UT) e++; row[name] = ascii.decode(body.subarray(p, e)); p = e + 1; }
          }
        }
      }
      rows.push(row);
    } while (desc.repeating && p < end);
    return rows;
  }

  /** Iterate data records: yields { tag: rows[] } maps. */
  function* records(bytes, ddr) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = ddr.recLen;
    while (pos + 24 <= bytes.length) {
      const recLen = int(bytes, pos, 5);
      if (!recLen) break;
      const base = int(bytes, pos + 12, 5);
      const sl = int(bytes, pos + 20, 1), sp = int(bytes, pos + 21, 1), st = int(bytes, pos + 23, 1);
      const entryLen = st + sl + sp;
      const rec = {};
      for (let p = pos + 24; p + entryLen <= pos + base - 1; p += entryLen) {
        const tag = ascii.decode(bytes.subarray(p, p + st));
        const len = int(bytes, p + st, sl), off = int(bytes, p + st + sl, sp);
        const start = pos + base + off;
        rec[tag] = decodeField(ddr.fields[tag], bytes.subarray(start, start + len), view, start);
      }
      yield rec;
      pos += recLen;
    }
  }

  // ---------------------------------------------------------------------
  // S-57 model
  // ---------------------------------------------------------------------
  // NAME is a 5-byte foreign pointer: RCNM (1 byte) + RCID (uint32 LE).
  function nameKey(b) { return b[0] + ":" + (((b[1] | (b[2] << 8) | (b[3] << 16)) + b[4] * 16777216) >>> 0); }

  /**
   * Parse an S-57 base cell. Returns:
   *  { dsnm, edition, update, scale, comf, somf, features:[...], stats }
   * feature = { objl, klass, prim, rcid, attrs:{}, geometry (GeoJSON), fidn }
   * Only classes in `opts.classes` (default: all known in OBJL) get geometry built.
   */
  function parseCell(buffer, opts) {
    opts = opts || {};
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const ddr = readDDR(bytes);
    const want = opts.classes ? new Set(opts.classes.map(c => typeof c === "string" ? OBJL[c] : c)) : null;

    let comf = 1e7, somf = 10, dsnm = null, edition = null, update = null, scale = null;
    const nodes = new Map();   // "rcnm:rcid" -> {lon,lat} or for SOUNDG multipoint {pts:[[lon,lat,depth]]}
    const edges = new Map();   // key -> {start:key, end:key, pts:[[lon,lat],...]}
    const featureRecs = [];
    const stats = { records: 0, nodes: 0, edges: 0, features: 0 };

    for (const rec of records(bytes, ddr)) {
      stats.records++;
      if (rec.DSID) { const d = rec.DSID[0]; dsnm = d.DSNM; edition = d.EDTN; update = d.UPDN; }
      if (rec.DSPM) { const d = rec.DSPM[0]; comf = d.COMF || comf; somf = d.SOMF || somf; scale = d.CSCL; }
      if (rec.VRID) {
        const v = rec.VRID[0];
        const key = v.RCNM + ":" + v.RCID;
        if (v.RCNM === 110 || v.RCNM === 120) { // isolated / connected node
          if (rec.SG3D) {
            nodes.set(key, { pts: rec.SG3D.map(r => [r.XCOO / comf, r.YCOO / comf, r.VE3D / somf]) });
          } else if (rec.SG2D) {
            const r = rec.SG2D[0];
            nodes.set(key, { lon: r.XCOO / comf, lat: r.YCOO / comf });
          }
          stats.nodes++;
        } else if (v.RCNM === 130) { // edge
          let start = null, end = null;
          for (const p of rec.VRPT || []) {
            const k = nameKey(p.NAME);
            if (p.TOPI === 1) start = k; else if (p.TOPI === 2) end = k;
          }
          const pts = (rec.SG2D || []).map(r => [r.XCOO / comf, r.YCOO / comf]);
          edges.set(key, { start, end, pts });
          stats.edges++;
        }
      }
      if (rec.FRID) {
        const f = rec.FRID[0];
        if (want && !want.has(f.OBJL)) continue;
        featureRecs.push(rec);
      }
    }

    const edgeCoords = (key, ornt) => {
      const e = edges.get(key);
      if (!e) return [];
      const s = nodes.get(e.start), t = nodes.get(e.end);
      const c = [];
      if (s && s.lon != null) c.push([s.lon, s.lat]);
      for (const p of e.pts) c.push(p);
      if (t && t.lon != null) c.push([t.lon, t.lat]);
      if (ornt === 2) c.reverse();
      return c;
    };
    const same = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

    // Chain edge coordinate arrays into closed rings by matching endpoints.
    // ORNT has already been applied, but real cells still contain rings whose
    // edges are listed out of order, so we also accept reversed pieces.
    function assembleRings(pieces) {
      const pool = pieces.filter(p => p.length >= 2);
      const rings = [];
      while (pool.length) {
        let ring = pool.shift().slice();
        let progressed = true;
        while (!same(ring[0], ring[ring.length - 1]) && progressed) {
          progressed = false;
          const tail = ring[ring.length - 1];
          for (let i = 0; i < pool.length; i++) {
            const p = pool[i];
            if (same(p[0], tail)) { ring.push(...p.slice(1)); pool.splice(i, 1); progressed = true; break; }
            if (same(p[p.length - 1], tail)) { for (let k = p.length - 2; k >= 0; k--) ring.push(p[k]); pool.splice(i, 1); progressed = true; break; }
          }
        }
        if (ring.length >= 3) { if (!same(ring[0], ring[ring.length - 1])) ring.push(ring[0]); if (ring.length >= 4) rings.push(ring); }
      }
      return rings;
    }

    const features = [];
    for (const rec of featureRecs) {
      const f = rec.FRID[0];
      const attrs = {};
      for (const a of (rec.ATTF || [])) {
        const name = ATTL[a.ATTL] || ("A" + a.ATTL);
        let v = a.ATVL;
        if (v === "" || v == null) continue;
        const num = Number(v);
        attrs[name] = (v.trim() !== "" && !isNaN(num) && /^[-\d.]+$/.test(v.trim())) ? num : v;
      }
      const spatial = rec.FSPT || [];
      let geometry = null;
      if (f.PRIM === 1) {
        const coords = [];
        for (const s of spatial) {
          const n = nodes.get(nameKey(s.NAME));
          if (!n) continue;
          if (n.pts) coords.push(...n.pts); else coords.push([n.lon, n.lat]);
        }
        if (coords.length === 1) geometry = { type: "Point", coordinates: coords[0] };
        else if (coords.length > 1) geometry = { type: "MultiPoint", coordinates: coords };
      } else if (f.PRIM === 2) {
        const lines = [];
        let cur = [];
        for (const s of spatial) {
          const c = edgeCoords(nameKey(s.NAME), s.ORNT);
          if (!c.length) continue;
          if (cur.length && same(cur[cur.length - 1], c[0])) cur.push(...c.slice(1));
          else { if (cur.length) lines.push(cur); cur = c.slice(); }
        }
        if (cur.length) lines.push(cur);
        if (lines.length === 1) geometry = { type: "LineString", coordinates: lines[0] };
        else if (lines.length) geometry = { type: "MultiLineString", coordinates: lines };
      } else if (f.PRIM === 3) {
        // Exterior rings have USAG 1 (or 3 = exterior truncated at the data
        // limit); interior rings USAG 2. Edges are not guaranteed to appear in
        // chained order, so link them by matching endpoints.
        const shells = assembleRings(spatial.filter(s => s.USAG !== 2).map(s => edgeCoords(nameKey(s.NAME), s.ORNT)));
        const holes = assembleRings(spatial.filter(s => s.USAG === 2).map(s => edgeCoords(nameKey(s.NAME), s.ORNT)));
        const polys = shells.map(r => [r]);
        for (const h of holes) {
          // attach hole to the shell that contains its first vertex
          let host = polys.find(p => pointInRing(h[0][0], h[0][1], p[0]));
          if (!host) host = polys[0];
          if (host) host.push(h); else polys.push([h]);
        }
        if (polys.length === 1) geometry = { type: "Polygon", coordinates: polys[0] };
        else if (polys.length > 1) geometry = { type: "MultiPolygon", coordinates: polys };
      }
      if (!geometry) continue;
      const fo = rec.FOID && rec.FOID[0];
      features.push({
        type: "Feature",
        objl: f.OBJL, klass: OBJL_NAME[f.OBJL] || String(f.OBJL), prim: f.PRIM, rcid: f.RCID,
        id: fo ? `${fo.AGEN}-${fo.FIDN}-${fo.FIDS}` : String(f.RCID),
        properties: Object.assign({ OBJL: f.OBJL, klass: OBJL_NAME[f.OBJL] || String(f.OBJL) }, attrs),
        geometry,
      });
      stats.features++;
    }
    return { dsnm, edition, update, scale, comf, somf, features, stats };
  }

  /** Bounding box [w,s,e,n] of a parsed cell (from M_COVR if present, else all features). */
  function cellBounds(cell) {
    let w = 180, s = 90, e = -180, n = -90;
    const visit = (c) => { if (typeof c[0] === "number") { if (c[0] < w) w = c[0]; if (c[0] > e) e = c[0]; if (c[1] < s) s = c[1]; if (c[1] > n) n = c[1]; } else c.forEach(visit); };
    const covr = cell.features.filter(f => f.objl === OBJL.M_COVR && Number(f.properties.CATCOV) === 1);
    for (const f of (covr.length ? covr : cell.features)) visit(f.geometry.coordinates);
    return [w, s, e, n];
  }

  // ---------------------------------------------------------------------
  // Convert to the shape Chart.fetchRoutingData / Router expect, and a local depthAt.
  // ---------------------------------------------------------------------
  function toRoutingData(cells) {
    const list = Array.isArray(cells) ? cells : [cells];
    const out = { bbox: null, depthAreas: [], dredgedAreas: [], land: [], hazards: [], soundings: [],
      lateralMarks: [], overheads: [], gates: [], lockBasins: [], datumAreas: [] };
    for (const cell of list) {
      const b = cellBounds(cell);
      out.bbox = out.bbox ? [Math.min(out.bbox[0], b[0]), Math.min(out.bbox[1], b[1]), Math.max(out.bbox[2], b[2]), Math.max(out.bbox[3], b[3])] : b;
      for (const f of cell.features) {
        const p = f.properties;
        switch (f.objl) {
          case OBJL.DEPARE: out.depthAreas.push(f); break;
          case OBJL.DRGARE: out.dredgedAreas.push(f); break;
          case OBJL.LNDARE: if (f.prim === 3) out.land.push(f); break;
          case OBJL.SOUNDG: {
            const pts = f.geometry.type === "Point" ? [f.geometry.coordinates] : f.geometry.coordinates;
            for (const c of pts) if (c.length >= 3 && isFinite(c[2])) out.soundings.push({ lon: c[0], lat: c[1], depth: c[2], date: p.SORDAT });
            break;
          }
          case OBJL.BOYLAT: case OBJL.BCNLAT:
            if (f.geometry.type === "Point") out.lateralMarks.push({ lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], kind: f.klass, name: p.OBJNAM || null, props: p });
            break;
          case OBJL.GATCON: out.gates.push({ geometry: f.geometry, properties: p }); break;
          case OBJL.LOKBSN: out.lockBasins.push(f); break;
          case OBJL.M_SDAT: case OBJL.M_VDAT:
            if (f.prim === 3 && /lake/i.test(String(p.INFORM || ""))) out.datumAreas.push({ kind: f.objl === OBJL.M_SDAT ? "sounding" : "vertical", lake: true, geometry: f.geometry, properties: p });
            break;
          case OBJL.BRIDGE: out.overheads.push({ kind: "bridge", geometry: f.geometry, properties: p }); break;
          case OBJL.CBLOHD: out.overheads.push({ kind: "cable", geometry: f.geometry, properties: p }); break;
          case OBJL.PIPOHD: out.overheads.push({ kind: "pipe", geometry: f.geometry, properties: p }); break;
          case OBJL.CONVYR: out.overheads.push({ kind: "conveyor", geometry: f.geometry, properties: p }); break;
          case OBJL.UWTROC: case OBJL.OBSTRN: case OBJL.WRECKS: {
            const kind = f.objl === OBJL.UWTROC ? "rock" : f.objl === OBJL.OBSTRN ? "obstruction" : "wreck";
            const pts = f.geometry.type === "Point" ? [f.geometry.coordinates] : f.geometry.type === "MultiPoint" ? f.geometry.coordinates : centroidPts(f.geometry);
            for (const c of pts) out.hazards.push(hazardFrom(kind, p, c));
            break;
          }
        }
      }
    }
    return out;
  }
  function centroidPts(g) {
    // for line/area hazards, sample all vertices (conservative)
    const pts = [];
    const visit = (c) => { if (typeof c[0] === "number") pts.push(c); else c.forEach(visit); };
    visit(g.coordinates);
    return pts;
  }
  // Same defaults as Chart.tagHazard (OBSTRN04 / WRECKS02)
  function hazardFrom(kind, p, c) {
    let depth = p.VALSOU;
    if (depth == null) {
      const wat = Number(p.WATLEV);
      if (kind === "wreck") { const cat = Number(p.CATWRK); depth = cat === 1 ? 20 : cat === 2 ? 0 : -15; }
      else depth = wat === 5 ? 0 : wat === 3 ? 0.01 : -15;
      if (wat === 1 || wat === 2) depth = -1;
    }
    return { kind, depth: Number(depth), lat: c[1], lon: c[0], props: p };
  }

  function pointInRing(lon, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function pointInGeom(lon, lat, g) {
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const poly of polys) {
      if (!pointInRing(lon, lat, poly[0])) continue;
      let inHole = false;
      for (let k = 1; k < poly.length; k++) if (pointInRing(lon, lat, poly[k])) { inHole = true; break; }
      if (!inHole) return true;
    }
    return false;
  }

  /** Offline equivalent of Chart.depthAt over parsed routing data. */
  function depthAt(data, lat, lon, opts) {
    const radius = (opts && opts.soundingRadiusM) || 250;
    let band = null;
    for (const f of data.depthAreas) {
      if (!pointInGeom(lon, lat, f.geometry)) continue;
      const p = f.properties;
      if (p.DRVAL1 == null) continue;
      const b = { min: p.DRVAL1, max: p.DRVAL2 == null ? p.DRVAL1 : p.DRVAL2 };
      if (!band || (b.max - b.min) < (band.max - band.min)) band = b;
    }
    let dredged = null;
    for (const f of data.dredgedAreas) if (pointInGeom(lon, lat, f.geometry)) { dredged = { min: f.properties.DRVAL1, max: f.properties.DRVAL2 }; break; }
    let land = false;
    for (const f of data.land) if (pointInGeom(lon, lat, f.geometry)) { land = true; break; }
    const R = 6371008.8, d2r = Math.PI / 180, cos = Math.cos(lat * d2r);
    let nearest = null; const soundings = [];
    for (const s of data.soundings) {
      const dx = (s.lon - lon) * d2r * R * cos, dy = (s.lat - lat) * d2r * R;
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      soundings.push(s);
      if (!nearest || d < nearest.distM) nearest = { depth: s.depth, distM: d, lat: s.lat, lon: s.lon, date: s.date };
    }
    let datum = null;
    for (const a of data.datumAreas || []) if (a.kind === "sounding" && pointInGeom(lon, lat, a.geometry)) { datum = { lake: true, inform: a.properties.INFORM }; break; }
    return { scale: "local", band, sounding: nearest, soundings, dredged, land, datum, cell: data.dsnm || null };
  }

  // ---------------------------------------------------------------------
  // ZIP reader (central directory + DecompressionStream). Returns [{name, bytes}].
  // ---------------------------------------------------------------------
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === "function") {
      const ds = new DecompressionStream("deflate-raw");
      const w = ds.writable.getWriter(); w.write(bytes); w.close();
      const chunks = []; const r = ds.readable.getReader();
      for (;;) { const { value, done } = await r.read(); if (done) break; chunks.push(value); }
      let n = 0; for (const c of chunks) n += c.length;
      const out = new Uint8Array(n); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    }
    const zlib = require("zlib");
    return new Uint8Array(zlib.inflateRawSync(Buffer.from(bytes)));
  }

  async function unzip(buffer, filter) {
    const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    // find End Of Central Directory
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("Not a zip file");
    const count = v.getUint16(eocd + 10, true), cdOff = v.getUint32(eocd + 16, true);
    const out = [];
    let p = cdOff;
    for (let i = 0; i < count; i++) {
      if (v.getUint32(p, true) !== 0x02014b50) break;
      const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
      const nlen = v.getUint16(p + 28, true), elen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
      const lho = v.getUint32(p + 42, true);
      const name = ascii.decode(b.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + elen + clen;
      if (filter && !filter(name)) continue;
      const lnlen = v.getUint16(lho + 26, true), lelen = v.getUint16(lho + 28, true);
      const dataOff = lho + 30 + lnlen + lelen;
      const data = b.subarray(dataOff, dataOff + csize);
      if (method === 0) out.push({ name, bytes: data });
      else if (method === 8) out.push({ name, bytes: await inflateRaw(data) });
      else throw new Error("Unsupported zip method " + method + " for " + name);
    }
    return out;
  }

  /** Load every .000 cell out of a NOAA ENC zip (or a bare .000) ArrayBuffer. */
  async function loadEncArchive(buffer, opts) {
    const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const isZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
    const files = isZip ? await unzip(b, n => /\.000$/i.test(n)) : [{ name: "cell.000", bytes: b }];
    return files.map(f => Object.assign(parseCell(f.bytes, opts), { file: f.name }));
  }

  return { OBJL, OBJL_NAME, ATTL, WATLEV, readDDR, parseFormat, records, parseCell, cellBounds, toRoutingData, depthAt, pointInGeom, unzip, loadEncArchive };
}));

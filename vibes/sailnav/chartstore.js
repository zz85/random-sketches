/*
 * chartstore.js - keep parsed NOAA ENC cells offline in IndexedDB and merge
 * them into one local dataset for depth queries, routing and rendering.
 *
 * Usage (browser):
 *   await ChartStore.open();
 *   await ChartStore.importFile(file)          // File/Blob: .zip from charts.noaa.gov or a bare .000
 *   const data = ChartStore.data();            // {depthAreas, land, hazards, soundings, bbox, cells:[...]}
 *   ChartStore.covers(lat, lon) -> cell | null
 *
 * Cells are stored as raw bytes (the ISO 8211 file, typically 0.3-2 MB) and
 * re-parsed on load; parsing a cell takes ~50 ms so there is no point storing
 * derived GeoJSON.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./s57.js"));
  else root.ChartStore = factory(root.S57);
}(typeof self !== "undefined" ? self : this, function (S57) {
  "use strict";

  const DB = "sailnav_charts", STORE = "cells";
  let db = null;
  const cells = new Map();   // dsnm -> parsed cell (+ bounds, bytes length)
  let merged = null;

  function idb() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: "dsnm" }); };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }
  function tx(mode, fn) {
    return idb().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(STORE, mode); const s = t.objectStore(STORE);
      const out = fn(s);
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    }));
  }

  function addParsed(cell, bytesLen) {
    cell.bounds = S57.cellBounds(cell);
    cell.bytesLen = bytesLen;
    cells.set(cell.dsnm, cell);
    merged = null;
  }

  /** Load every stored cell into memory. Returns the list of cells. */
  async function open() {
    let rows = [];
    try {
      rows = await tx("readonly", s => s.getAll());
    } catch (e) { console.warn("chart store unavailable", e); return []; }
    for (const r of rows || []) {
      try { const cell = S57.parseCell(new Uint8Array(r.bytes)); cell.file = r.file; cell.savedAt = r.savedAt; addParsed(cell, r.bytes.byteLength); }
      catch (e) { console.warn("bad stored cell", r.dsnm, e); }
    }
    return list();
  }

  /** Import a File/Blob/ArrayBuffer containing a NOAA ENC zip or a .000 file. Returns imported cells. */
  async function importFile(fileOrBuffer, name) {
    const buf = fileOrBuffer instanceof ArrayBuffer ? fileOrBuffer : await fileOrBuffer.arrayBuffer();
    const b = new Uint8Array(buf);
    const isZip = b[0] === 0x50 && b[1] === 0x4b;
    const files = isZip ? await S57.unzip(b, n => /\.000$/i.test(n)) : [{ name: name || (fileOrBuffer.name) || "cell.000", bytes: b }];
    const out = [];
    for (const f of files) {
      const cell = S57.parseCell(f.bytes);
      if (!cell.dsnm) throw new Error(f.name + ": not an S-57 cell");
      cell.file = f.name; cell.savedAt = Date.now();
      addParsed(cell, f.bytes.byteLength);
      const bytes = f.bytes.slice().buffer; // detach from the zip buffer
      try { await tx("readwrite", s => s.put({ dsnm: cell.dsnm, file: f.name, savedAt: cell.savedAt, edition: cell.edition, update: cell.update, bytes })); }
      catch (e) { console.warn("could not persist", cell.dsnm, e); }
      out.push(cell);
    }
    return out;
  }

  async function remove(dsnm) {
    cells.delete(dsnm); merged = null;
    try { await tx("readwrite", s => s.delete(dsnm)); } catch (e) { /* ignore */ }
  }
  async function clear() {
    cells.clear(); merged = null;
    try { await tx("readwrite", s => s.clear()); } catch (e) { /* ignore */ }
  }

  function list() {
    return [...cells.values()].map(c => ({ dsnm: c.dsnm, file: c.file, edition: c.edition, update: c.update, scale: c.scale, bounds: c.bounds, features: c.features.length, bytes: c.bytesLen, savedAt: c.savedAt }));
  }

  /** Merged routing/depth dataset across all loaded cells (cached). */
  function data() {
    if (!cells.size) return null;
    if (!merged) {
      merged = S57.toRoutingData([...cells.values()]);
      merged.cells = [...cells.values()];
      merged.dsnm = merged.cells.length === 1 ? merged.cells[0].dsnm : merged.cells.length + " cells";
    }
    return merged;
  }

  /** The most detailed (largest compilation scale number smallest) loaded cell whose coverage contains the point. */
  function covers(lat, lon) {
    let best = null;
    for (const c of cells.values()) {
      const b = c.bounds;
      if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
      const covr = c.features.find(f => f.objl === S57.OBJL.M_COVR && Number(f.properties.CATCOV) === 1);
      if (covr && !S57.pointInGeom(lon, lat, covr.geometry)) continue;
      if (!best || (c.scale || 1e9) < (best.scale || 1e9)) best = c;
    }
    return best;
  }

  /** True when every corner and the centre of bbox is inside loaded coverage. */
  function coversBbox(bbox) {
    const pts = [[bbox[1], bbox[0]], [bbox[1], bbox[2]], [bbox[3], bbox[0]], [bbox[3], bbox[2]], [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2]];
    return pts.every(p => covers(p[0], p[1]));
  }

  /** Depth at a point from local cells, or null when not covered. */
  function depthAt(lat, lon, opts) {
    const cell = covers(lat, lon);
    if (!cell) return null;
    const d = S57.depthAt(data(), lat, lon, opts);
    d.cell = cell.dsnm; d.scale = "local 1:" + cell.scale;
    return d;
  }

  // ---------------------------------------------------------------------
  // Bundled catalog: charts/catalog.json lists cells shipped next to the app.
  // ensureCoverage() fetches (once) whichever bundled cells intersect an area
  // and are not already stored, so the app fills its own offline store.
  // ---------------------------------------------------------------------
  let catalog = null, baseUrl = "charts/";
  const inflight = new Map();

  async function loadCatalog(url) {
    baseUrl = (url || "charts/catalog.json").replace(/catalog\.json$/, "");
    try {
      const r = await fetch(url || "charts/catalog.json", { cache: "no-cache" });
      if (!r.ok) return null;
      catalog = await r.json();
      return catalog;
    } catch (e) { return null; }
  }
  function catalogCells() { return catalog ? catalog.cells : []; }
  function catalogCovering(bbox) {
    return catalogCells().filter(c => !(c.bbox[2] < bbox[0] || c.bbox[0] > bbox[2] || c.bbox[3] < bbox[1] || c.bbox[1] > bbox[3]));
  }
  /** Fetch bundled cells intersecting bbox [w,s,e,n] that are not loaded yet. Returns names fetched. */
  async function ensureCoverage(bbox, onProgress) {
    const need = catalogCovering(bbox).filter(c => !cells.has(c.name + ".000") && !cells.has(c.name));
    const done = [];
    await Promise.all(need.map(async c => {
      if (!inflight.has(c.name)) {
        inflight.set(c.name, (async () => {
          const r = await fetch(baseUrl + c.file);
          if (!r.ok) throw new Error(c.file + " " + r.status);
          const got = await importFile(await r.arrayBuffer(), c.file);
          return got;
        })().finally(() => inflight.delete(c.name)));
      }
      try { await inflight.get(c.name); done.push(c.name); if (onProgress) onProgress(c.name, done.length, need.length); }
      catch (e) { console.warn("bundled cell fetch failed", c.name, e); }
    }));
    return done;
  }
  /** Is a point inside any bundled (not necessarily loaded) cell? */
  function bundledCovers(lat, lon) { return catalogCovering([lon, lat, lon, lat]).length > 0; }

  return { open, importFile, remove, clear, list, data, covers, coversBbox, depthAt,
    loadCatalog, catalogCells, catalogCovering, ensureCoverage, bundledCovers, _cells: cells };
}));

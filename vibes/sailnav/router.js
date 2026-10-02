/*
 * router.js - automatic water routing between two points.
 *
 * OpenCPN core only does hand-placed waypoint routes; its weather_routing
 * plugin does wind-aware isochrones over GSHHS coastlines. For a small-boat
 * plotter on Puget Sound we want something closer to "Google Maps for
 * boats": the shortest path that stays in water at least as deep as the boat
 * needs, keeps a margin from shore and hazards, and prefers the middle of
 * channels.
 *
 * Approach:
 *   1. Rasterise the S-57 skin-of-the-earth (DEPARE/DRGARE/LNDARE) from ENC
 *      Direct into a grid of "minimum charted depth" cells (pure JS scanline,
 *      even-odd rule, so it runs in tests without a canvas).
 *   2. Mark isolated dangers (UWTROC/OBSTRN/WRECKS) shallower than the
 *      required depth as blocked, with a buffer.
 *   3. Distance transform from blocked cells -> apply a hard safety margin
 *      and a soft "channel centre" cost.
 *   4. Lateral marks (BOYLAT/BCNLAT): mutually-nearest port/starboard pairs
 *      become gates. Walls run outward from each mark of a gate until they
 *      meet shoal water, so the only way through is between the marks.
 *      An unpaired mark gets a wall to the nearest shoal it guards, so the
 *      route cannot squeeze between a mark and its danger. This is
 *      direction-agnostic: it holds for IALA-A and -B and for inbound and
 *      outbound traffic alike.
 *   5. Overhead obstructions (BRIDGE/CBLOHD/PIPOHD/CONVYR) whose charted
 *      clearance is below air draft + headroom become walls. Opening bridges
 *      are passable when their open clearance suffices, and are reported.
 *      Walls block cells but are not sources for the shore margin, otherwise
 *      a 100 m gate or a bridge span would close entirely.
 *   6. A* (8-connected, binary heap) between the snapped endpoints.
 *   7. String-pull the cell path into as few straight legs as possible.
 *
 * Works as a browser global (window.Router) or CommonJS.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Router = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const R = 6371008.8, D2R = Math.PI / 180;
  const LAND = -1000;         // sentinel minDepth for land
  const UNKNOWN = NaN;

  // ---------------------------------------------------------------------
  // Grid
  // ---------------------------------------------------------------------
  /**
   * Create an empty grid covering bbox [w, s, e, n] with ~cellM metre cells.
   * maxCells caps memory/time; the cell size grows to fit.
   */
  function makeGrid(bbox, cellM, maxCells) {
    const [w, s, e, n] = bbox;
    const midLat = (s + n) / 2;
    const widthM = (e - w) * D2R * R * Math.cos(midLat * D2R);
    const heightM = (n - s) * D2R * R;
    maxCells = maxCells || 1.5e6;
    let cell = cellM || 40;
    if ((widthM / cell) * (heightM / cell) > maxCells) cell = Math.sqrt(widthM * heightM / maxCells);
    const cols = Math.max(2, Math.ceil(widthM / cell));
    const rows = Math.max(2, Math.ceil(heightM / cell));
    const g = {
      bbox, cols, rows, cellM: cell,
      dLon: (e - w) / cols, dLat: (n - s) / rows,
      minDepth: new Float32Array(cols * rows).fill(UNKNOWN),
      hazard: new Uint8Array(cols * rows),     // 1 = point hazard blocks cell
      wall: new Uint8Array(cols * rows),       // 1 = impassable but not a shore-margin source (marks, gate walls, low bridges)
      overId: new Int32Array(cols * rows).fill(-1), // index into the overhead list for cells under a bridge/cable
      widthM, heightM,
    };
    return g;
  }

  function toCell(g, lat, lon) {
    return {
      x: Math.floor((lon - g.bbox[0]) / g.dLon),
      y: Math.floor((g.bbox[3] - lat) / g.dLat),
    };
  }
  function cellCenter(g, x, y) {
    return { lat: g.bbox[3] - (y + 0.5) * g.dLat, lon: g.bbox[0] + (x + 0.5) * g.dLon };
  }
  function inGrid(g, x, y) { return x >= 0 && y >= 0 && x < g.cols && y < g.rows; }

  // ---------------------------------------------------------------------
  // Scanline polygon fill (even-odd). ring = [[lon, lat], ...]
  // Calls visit(idx) for each covered cell exactly once per polygon.
  // ---------------------------------------------------------------------
  function fillPolygon(g, rings, visit) {
    // Convert to grid space (continuous), collect edges
    const edges = [];
    let ymin = Infinity, ymax = -Infinity;
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        const ax = (a[0] - g.bbox[0]) / g.dLon, ay = (g.bbox[3] - a[1]) / g.dLat;
        const bx = (b[0] - g.bbox[0]) / g.dLon, by = (g.bbox[3] - b[1]) / g.dLat;
        if (ay === by) continue;
        edges.push(ay < by ? [ax, ay, bx, by] : [bx, by, ax, ay]);
        ymin = Math.min(ymin, ay, by); ymax = Math.max(ymax, ay, by);
      }
    }
    if (!edges.length) return;
    const y0 = Math.max(0, Math.floor(ymin)), y1 = Math.min(g.rows - 1, Math.ceil(ymax));
    const xs = [];
    for (let y = y0; y <= y1; y++) {
      const sy = y + 0.5; // sample at the cell centre row
      xs.length = 0;
      for (const e of edges) {
        if (sy >= e[1] && sy < e[3]) {
          xs.push(e[0] + (sy - e[1]) * (e[2] - e[0]) / (e[3] - e[1]));
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(0, Math.ceil(xs[i] - 0.5)), xb = Math.min(g.cols - 1, Math.floor(xs[i + 1] - 0.5));
        for (let x = xa; x <= xb; x++) visit(y * g.cols + x);
      }
    }
  }

  function geomPolygons(geom) {
    if (!geom) return [];
    if (geom.type === "Polygon") return [geom.coordinates];
    if (geom.type === "MultiPolygon") return geom.coordinates;
    return [];
  }

  /**
   * Paint depth areas, dredged areas and land into the grid.
   * data = { depthAreas, dredgedAreas, land, hazards } (GeoJSON features).
   * Overlapping areas keep the shallower (conservative) value.
   */
  function rasterize(g, data) {
    const md = g.minDepth;
    const paintDepth = (features) => {
      for (const f of features || []) {
        const p = f.properties || {};
        const v = p.DRVAL1 == null ? -0.5 : Number(p.DRVAL1);
        for (const poly of geomPolygons(f.geometry)) {
          fillPolygon(g, poly, idx => {
            const cur = md[idx];
            if (Number.isNaN(cur) || v < cur) md[idx] = v;
          });
        }
      }
    };
    paintDepth(data.depthAreas);
    paintDepth(data.dredgedAreas);
    for (const f of data.land || []) {
      for (const poly of geomPolygons(f.geometry)) fillPolygon(g, poly, idx => { md[idx] = LAND; });
    }
    return g;
  }

  /** Block cells around point hazards shallower than requiredDepth. */
  function applyHazards(g, hazards, requiredDepth, bufferM) {
    const r = Math.max(1, Math.ceil((bufferM || 30) / g.cellM));
    for (const h of hazards || []) {
      if (!(h.depth < requiredDepth)) continue;
      const c = toCell(g, h.lat, h.lon);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const x = c.x + dx, y = c.y + dy;
        if (inGrid(g, x, y)) g.hazard[y * g.cols + x] = 1;
      }
    }
  }

  /**
   * Navigability mask + distance (in cells) to nearest blocked cell.
   *  requiredDepth: metres of charted depth needed (draft + clearance - tide)
   *  allowUnknown : treat cells with no depth area as water
   */
  function buildMask(g, requiredDepth, allowUnknown) {
    const n = g.cols * g.rows;
    const ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const d = g.minDepth[i];
      if (g.hazard[i] || g.wall[i]) continue;
      if (Number.isNaN(d)) { if (allowUnknown) ok[i] = 1; continue; }
      if (d === LAND) continue;
      if (d >= requiredDepth) ok[i] = 1;
    }
    // multi-source BFS distance transform (chebyshev-ish, 8-neighbour)
    const dist = new Uint16Array(n).fill(0xffff);
    const q = new Int32Array(n);
    let qh = 0, qt = 0;
    for (let i = 0; i < n; i++) if (!ok[i] && !g.wall[i]) { dist[i] = 0; q[qt++] = i; }
    // grid edge counts as blocked so we never hug the bbox boundary
    for (let x = 0; x < g.cols; x++) { for (const y of [0, g.rows - 1]) { const i = y * g.cols + x; if (dist[i] !== 0) { dist[i] = 0; q[qt++] = i; } } }
    for (let y = 0; y < g.rows; y++) { for (const x of [0, g.cols - 1]) { const i = y * g.cols + x; if (dist[i] !== 0) { dist[i] = 0; q[qt++] = i; } } }
    while (qh < qt) {
      const i = q[qh++];
      const x = i % g.cols, y = (i - x) / g.cols, d = dist[i] + 1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= g.cols || ny >= g.rows) continue;
        const j = ny * g.cols + nx;
        if (dist[j] > d) { dist[j] = d; q[qt++] = j; }
      }
    }
    return { ok, dist };
  }

  // ---------------------------------------------------------------------
  // Lines on the grid
  // ---------------------------------------------------------------------
  /** Bresenham cells from (x0,y0) to (x1,y1) inclusive. visit(x, y) returning false stops. */
  function lineCells(x0, y0, x1, y1, visit) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    for (;;) {
      if (visit(x, y) === false) return;
      if (x === x1 && y === y1) return;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }
  function geomLines(geom) {
    if (!geom) return [];
    if (geom.type === "LineString") return [geom.coordinates];
    if (geom.type === "MultiLineString") return geom.coordinates;
    if (geom.type === "Polygon") return geom.coordinates;
    if (geom.type === "MultiPolygon") return [].concat(...geom.coordinates);
    return [];
  }
  /** Visit every cell touched by a line or polygon (outline plus interior). */
  function rasterGeom(g, geom, visit) {
    for (const line of geomLines(geom)) {
      for (let i = 1; i < line.length; i++) {
        const a = toCell(g, line[i - 1][1], line[i - 1][0]), b = toCell(g, line[i][1], line[i][0]);
        lineCells(a.x, a.y, b.x, b.y, (x, y) => { if (inGrid(g, x, y)) visit(y * g.cols + x); });
      }
    }
    for (const poly of geomPolygons(geom)) fillPolygon(g, poly, visit);
  }
  function metresBetween(g, ax, ay, bx, by) {
    const dx = (bx - ax) * g.cellM, dy = (by - ay) * g.cellM;
    return Math.hypot(dx, dy);
  }

  // ---------------------------------------------------------------------
  // Overhead clearance (bridges, cables, pipes, conveyors)
  // ---------------------------------------------------------------------
  // S-57 CATBRG: 1 fixed, 2 opening, 3 swing, 4 lifting, 5 bascule, 6 pontoon,
  // 7 drawbridge, 8 transporter, 9 footbridge, 10 viaduct, 11 aqueduct, 12 suspension.
  const OPENING_BRIDGE = new Set([2, 3, 4, 5, 7]);
  const CATBRG_NAME = { 1: "fixed", 2: "opening", 3: "swing", 4: "lifting", 5: "bascule", 6: "pontoon", 7: "drawbridge", 8: "transporter", 9: "footbridge", 10: "viaduct", 11: "aqueduct", 12: "suspension" };
  const num = v => (v === "" || v == null || !isFinite(Number(v))) ? null : Number(v);

  /** Normalise one overhead feature: clearances in metres (US charts: above MHW). */
  function overheadInfo(o) {
    const p = o.properties || {};
    const cat = num(p.CATBRG);
    const opening = o.kind === "bridge" && OPENING_BRIDGE.has(cat);
    let closed = num(p.VERCLR);
    if (closed == null) closed = num(p.VERCCL);
    if (o.kind === "cable" && num(p.VERCSA) != null) closed = closed == null ? num(p.VERCSA) : Math.min(closed, num(p.VERCSA));
    const open = opening ? num(p.VERCOP) : null;   // null on an opening bridge = unlimited when open
    return {
      kind: o.kind, name: p.OBJNAM || null, category: o.kind === "bridge" ? (CATBRG_NAME[cat] || "bridge") : o.kind,
      clearance: closed, opening, openClearance: open, inform: p.INFORM || null,
    };
  }

  /**
   * Rasterise overheads. Every footprint cell gets overId; footprints whose
   * clearance is below needM become walls. Unknown clearance blocks when
   * blockUnknown (conservative: an uncharted span over water may be low).
   * Returns the info list with .blocks set.
   */
  function applyOverheads(g, overheads, needM, blockUnknown, enforce) {
    const list = (overheads || []).map(o => Object.assign(overheadInfo(o), { geometry: o.geometry }));
    inheritClearances(list);
    list.forEach((info, id) => {
      if (needM == null) info.blocks = false;
      else if (info.opening) info.blocks = info.openClearance != null && info.openClearance < needM && (info.clearance == null || info.clearance < needM);
      else if (info.clearance == null) info.blocks = !!blockUnknown;
      else info.blocks = info.clearance < needM;
      info.needsOpening = info.opening && needM != null && (info.clearance == null || info.clearance < needM) && !info.blocks;
      info.index = id;
      rasterGeom(g, info.geometry, i => {
        // a cell under several pieces keeps the most restrictive one for reporting
        const prev = g.overId[i] >= 0 ? list[g.overId[i]] : null;
        if (!prev || (info.blocks && !prev.blocks) || (info.clearance != null && (prev.clearance == null || info.clearance < prev.clearance))) g.overId[i] = id;
        if (info.blocks && enforce !== false) g.wall[i] = 1;
      });
    });
    for (const info of list) delete info.geometry;
    return list;
  }

  /**
   * ENCs split one bridge or cable into several features: the span over the channel
   * carries VERCLR, the pieces over the banks usually carry nothing. A piece with no
   * clearance that touches (within ~60 m) a charted piece of the same kind inherits
   * the lowest touching clearance and, if unnamed, its name. It keeps its own category,
   * so a fixed approach span next to a bascule span is still fixed.
   */
  function inheritClearances(list) {
    const verts = list.map(o => { const v = []; const visit = c => { if (typeof c[0] === "number") v.push(c); else c.forEach(visit); }; visit(o.geometry ? o.geometry.coordinates : []); return v; });
    const near = (a, b) => {
      for (const p of a) for (const q of b) {
        const dy = (p[1] - q[1]) * 111320, dx = (p[0] - q[0]) * 111320 * Math.cos(p[1] * D2R);
        if (dx * dx + dy * dy < 3600) return true;
      }
      return false;
    };
    for (let pass = 0; pass < 3; pass++) {           // a few passes let clearance flow along a chain of pieces
      let changed = false;
      list.forEach((o, i) => {
        if (o.clearance != null) return;
        let best = null;
        list.forEach((k, j) => {
          if (i === j || k.kind !== o.kind || k.clearance == null) return;
          if (!near(verts[i], verts[j])) return;
          if (!best || k.clearance < best.clearance) best = k;
        });
        if (best) { o.clearance = best.clearance; o.inherited = true; if (!o.name) o.name = best.name; changed = true; }
      });
      if (!changed) break;
    }
  }

  // ---------------------------------------------------------------------
  // Lateral marks
  // ---------------------------------------------------------------------
  // S-57 CATLAM: 1 port-hand, 2 starboard-hand, 3 preferred channel to starboard,
  // 4 preferred channel to port. COLOUR: 3 red, 4 green.
  function markSide(p) { const c = num(p && p.CATLAM); return c === 1 ? "port" : c === 2 ? "starboard" : c === 3 || c === 4 ? "junction" : null; }
  function markColour(p) { const c = String((p && p.COLOUR) || "").split(",")[0]; return c === "3" ? "red" : c === "4" ? "green" : c ? "other" : null; }

  /**
   * Turn lateral marks into walls on the grid.
   *   isBlocked(i): true for cells already impassable by depth/land/hazard.
   *   opts.maxGateM   widest channel accepted as a gate (default 700 m)
   *   opts.wallM      how far gate walls extend outward (default 600 m)
   *   opts.shoalM     search radius from an unpaired mark to its shoal (default 400 m)
   * Returns { marks, gates:[{a, b, widthM}], unpaired }.
   */
  function applyLateral(g, marks, isBlocked, opts) {
    opts = opts || {};
    const maxGateM = opts.maxGateM || 700, wallM = opts.wallM || 600, shoalM = opts.shoalM || 400, minGateM = opts.minGateM || 20;
    const ms = [];
    for (const m of marks || []) {
      const c = toCell(g, m.lat, m.lon);
      if (!inGrid(g, c.x, c.y)) continue;
      ms.push({ ...m, x: c.x, y: c.y, side: markSide(m.props), colour: markColour(m.props) });
    }
    const port = ms.filter(m => m.side === "port"), stbd = ms.filter(m => m.side === "starboard");
    const nearest = (m, others) => {
      let best = null, bd = Infinity;
      for (const o of others) { const d = metresBetween(g, m.x, m.y, o.x, o.y); if (d < bd) { bd = d; best = o; } }
      return best ? { m: best, d: bd } : null;
    };
    const gates = [], paired = new Set();
    for (const p of port) {
      const ns = nearest(p, stbd);
      if (!ns || ns.d > maxGateM || ns.d < minGateM) continue;
      const back = nearest(ns.m, port);
      if (!back || back.m !== p) continue;                 // mutual nearest only
      const mx = Math.round((p.x + ns.m.x) / 2), my = Math.round((p.y + ns.m.y) / 2);
      if (g.minDepth[my * g.cols + mx] === LAND) continue; // a land between them: not one channel
      gates.push({ a: p, b: ns.m, widthM: ns.d });
      paired.add(p); paired.add(ns.m);
    }
    const wallFrom = (m, ux, uy) => {
      // walk outward from the mark until shoal/land or wallM
      const k = Math.ceil(wallM / g.cellM);
      const ex = Math.round(m.x + ux * k), ey = Math.round(m.y + uy * k);
      lineCells(m.x, m.y, ex, ey, (x, y) => {
        if (!inGrid(g, x, y)) return false;
        const i = y * g.cols + x;
        if (!(x === m.x && y === m.y) && isBlocked(i)) return false;
        g.wall[i] = 1;
      });
    };
    for (const gt of gates) {
      const dx = gt.b.x - gt.a.x, dy = gt.b.y - gt.a.y, L = Math.hypot(dx, dy) || 1;
      wallFrom(gt.b, dx / L, dy / L);
      wallFrom(gt.a, -dx / L, -dy / L);
    }
    let unpaired = 0;
    for (const m of ms) {
      g.wall[m.y * g.cols + m.x] = 1;
      if (paired.has(m)) continue;
      unpaired++;
      // nearest blocked cell within shoalM (ring search), then wall the gap
      const R = Math.ceil(shoalM / g.cellM);
      let hit = null;
      for (let r = 1; r <= R && !hit; r++) {
        let bd = Infinity;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = m.x + dx, y = m.y + dy;
          if (!inGrid(g, x, y) || !isBlocked(y * g.cols + x)) continue;
          const d = dx * dx + dy * dy;
          if (d < bd) { bd = d; hit = { x, y }; }
        }
      }
      if (hit) lineCells(m.x, m.y, hit.x, hit.y, (x, y) => { const i = y * g.cols + x; if (isBlocked(i)) return false; g.wall[i] = 1; });
    }
    return { marks: ms, gates, unpaired };
  }

  /** Do segments p1-p2 and q1-q2 intersect (cell space)? */
  function segIntersect(p1, p2, q1, q2) {
    const o = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const o1 = o(p1, p2, q1), o2 = o(p1, p2, q2), o3 = o(q1, q2, p1), o4 = o(q1, q2, p2);
    return o1 !== o2 && o3 !== o4;
  }

  // ---------------------------------------------------------------------
  // Binary min-heap on (f, idx)
  // ---------------------------------------------------------------------
  class Heap {
    constructor(cap) { this.f = new Float64Array(cap); this.i = new Int32Array(cap); this.n = 0; }
    push(f, i) {
      let k = this.n++;
      if (k >= this.f.length) this._grow();
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (this.f[p] <= f) break;
        this.f[k] = this.f[p]; this.i[k] = this.i[p]; k = p;
      }
      this.f[k] = f; this.i[k] = i;
    }
    pop() {
      const top = this.i[0];
      const n = --this.n;
      if (n > 0) {
        const f = this.f[n], i = this.i[n];
        let k = 0;
        for (;;) {
          let c = 2 * k + 1;
          if (c >= n) break;
          if (c + 1 < n && this.f[c + 1] < this.f[c]) c++;
          if (this.f[c] >= f) break;
          this.f[k] = this.f[c]; this.i[k] = this.i[c]; k = c;
        }
        this.f[k] = f; this.i[k] = i;
      }
      return top;
    }
    _grow() {
      const f = new Float64Array(this.f.length * 2), i = new Int32Array(this.i.length * 2);
      f.set(this.f); i.set(this.i); this.f = f; this.i = i;
    }
    get size() { return this.n; }
  }

  /** Nearest navigable cell to (x, y) within maxR cells, or null. */
  function snapToWater(g, mask, x, y, marginCells, maxR) {
    maxR = maxR || 60;
    const okAt = (cx, cy) => inGrid(g, cx, cy) && mask.ok[cy * g.cols + cx] && mask.dist[cy * g.cols + cx] > marginCells;
    if (okAt(x, y)) return { x, y, moved: 0 };
    for (let r = 1; r <= maxR; r++) {
      let best = null;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (okAt(x + dx, y + dy)) {
          const d = dx * dx + dy * dy;
          if (!best || d < best.d) best = { x: x + dx, y: y + dy, d };
        }
      }
      if (best) return { x: best.x, y: best.y, moved: Math.sqrt(best.d) };
    }
    return null;
  }

  /**
   * Cells reachable from start under the same rules A* uses (margin, no corner cutting).
   * A pre-check before A*: when start and destination are not connected, A* would
   * otherwise expand every reachable cell before giving up.
   */
  function reachable(g, mask, start, marginCells) {
    const cols = g.cols, n = cols * g.rows;
    const seen = new Uint8Array(n), q = new Int32Array(n);
    let qh = 0, qt = 0;
    const s0 = start.y * cols + start.x;
    seen[s0] = 1; q[qt++] = s0;
    while (qh < qt) {
      const i = q[qh++], x = i % cols, y = (i - x) / cols;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= g.rows) continue;
        const j = ny * cols + nx;
        if (seen[j] || !mask.ok[j] || mask.dist[j] <= marginCells) continue;
        if (dx && dy && (!mask.ok[y * cols + nx] || !mask.ok[ny * cols + x])) continue;
        seen[j] = 1; q[qt++] = j;
      }
    }
    return seen;
  }
  /**
   * A* over the mask. Returns array of cell indices from start to goal, or null.
   *  marginCells : hard keep-off distance from blocked cells
   *  comfortCells: soft band; cost rises linearly inside it (channel centring)
   */
  function astar(g, mask, start, goal, marginCells, comfortCells, comfortWeight) {
    const cols = g.cols, n = cols * g.rows;
    const gScore = new Float64Array(n).fill(Infinity);
    const parent = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const sIdx = start.y * cols + start.x, tIdx = goal.y * cols + goal.x;
    const h = (i) => { const x = i % cols, y = (i - x) / cols; const dx = x - goal.x, dy = y - goal.y; return Math.sqrt(dx * dx + dy * dy); };
    const heap = new Heap(1 << 16);
    gScore[sIdx] = 0; heap.push(h(sIdx), sIdx);
    const W = comfortWeight == null ? 1.5 : comfortWeight;
    let expanded = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === tIdx) break;
      expanded++;
      const cx = cur % cols, cy = (cur - cx) / cols;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= g.rows) continue;
        const ni = ny * cols + nx;
        if (closed[ni] || !mask.ok[ni]) continue;
        const dist = mask.dist[ni];
        if (dist <= marginCells && ni !== tIdx) continue;
        // no corner cutting past blocked orthogonal neighbours
        if (dx && dy) {
          const a = cy * cols + nx, b = ny * cols + cx;
          if (!mask.ok[a] || !mask.ok[b]) continue;
        }
        let step = (dx && dy) ? Math.SQRT2 : 1;
        if (dist < comfortCells) step *= 1 + W * (comfortCells - dist) / comfortCells;
        const ng = gScore[cur] + step;
        if (ng < gScore[ni]) {
          gScore[ni] = ng; parent[ni] = cur;
          heap.push(ng + h(ni), ni);
        }
      }
    }
    if (parent[tIdx] === -1 && sIdx !== tIdx) return null;
    const path = [];
    for (let i = tIdx; i !== -1; i = parent[i]) { path.push(i); if (i === sIdx) break; }
    path.reverse();
    path.expanded = expanded;
    return path;
  }

  /** Supercover line: does the straight segment stay in navigable cells? */
  function lineClear(g, mask, x0, y0, x1, y1, marginCells) {
    const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy, x = x0, y = y0;
    for (;;) {
      const i = y * g.cols + x;
      if (!mask.ok[i] || mask.dist[i] <= marginCells) return false;
      if (x === x1 && y === y1) return true;
      const e2 = 2 * err;
      // step both axes separately (supercover) so we never slip between diagonal blocked cells
      if (e2 > -dy) { err -= dy; x += sx; if (!(mask.ok[y * g.cols + x] && mask.dist[y * g.cols + x] > marginCells)) return false; }
      if (e2 < dx) { err += dx; y += sy; }
    }
  }

  /** Greedy string pulling: keep the fewest waypoints whose legs are all clear. */
  function simplify(g, mask, path, marginCells) {
    if (path.length <= 2) return path.slice();
    const pts = path.map(i => ({ x: i % g.cols, y: Math.floor(i / g.cols) }));
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !lineClear(g, mask, pts[i].x, pts[i].y, pts[j].x, pts[j].y, marginCells)) j--;
      out.push(pts[j]);
      i = j;
    }
    return out.map(p => p.y * g.cols + p.x);
  }

  // ---------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------
  /**
   * route(data, from, to, opts) -> { waypoints, cellPath, grid, mask, stats, warnings } | { error, blockedBy? }
   *   data: output of Chart.fetchRoutingData or S57.toRoutingData (must cover both points)
   *   opts.requiredDepth  metres of charted depth needed (default 3)
   *   opts.marginM        hard keep-off from shore/hazards (default 60)
   *   opts.comfortM       soft band preferring channel centres (default 250)
   *   opts.cellM          grid resolution (default 40)
   *   opts.allowUnknown   treat uncharted cells as water (default false)
   *   opts.lateral        honour red/green lateral marks (default true)
   *   opts.airDraft       mast height above the waterline, metres (null = ignore overheads)
   *   opts.headroomM      extra vertical clearance wanted (default 1)
   *   opts.blockUnknownClearance  treat bridges/cables with no charted clearance as too low (default true)
   *   opts.adaptiveMargin step the shore margin down (to 0) when narrow water blocks the route (default true)
   *
   * If no route exists with every constraint, it retries without the lateral
   * marks (and says so in warnings). If the only way through is under an
   * overhead that is too low, the error names it in blockedBy.
   */
  function route(data, from, to, opts) {
    opts = opts || {};
    const t0 = Date.now();
    const requiredDepth = opts.requiredDepth == null ? 3 : opts.requiredDepth;
    const lateral = opts.lateral !== false;
    const needM = opts.airDraft > 0 ? opts.airDraft + (opts.headroomM == null ? 1 : opts.headroomM) : null;
    const g = opts.grid || rasterize(makeGrid(data.bbox, opts.cellM || 40, opts.maxCells), data);
    if (!opts.grid) applyHazards(g, data.hazards, requiredDepth, opts.hazardBufferM || 40);
    const marginCells = Math.round((opts.marginM == null ? 60 : opts.marginM) / g.cellM);
    const comfortCells = Math.max(marginCells + 1, Math.round((opts.comfortM == null ? 250 : opts.comfortM) / g.cellM));
    const c0 = toCell(g, from.lat, from.lon), c1 = toCell(g, to.lat, to.lon);
    if (!inGrid(g, c0.x, c0.y) || !inGrid(g, c1.x, c1.y)) return { error: "Endpoint outside routing area" };

    const isBlocked = (i) => {
      const d = g.minDepth[i];
      return g.hazard[i] === 1 || Number.isNaN(d) || d === LAND || d < requiredDepth;
    };

    function attempt(useLateral, enforceOverheads, mc) {
      g.wall.fill(0); g.overId.fill(-1);
      const overheads = applyOverheads(g, data.overheads, needM, opts.blockUnknownClearance !== false, enforceOverheads);
      const lat = useLateral ? applyLateral(g, data.lateralMarks, isBlocked, opts) : { marks: [], gates: [], unpaired: 0 };
      const mask = buildMask(g, requiredDepth, !!opts.allowUnknown);
      const snapR = Math.ceil(1500 / g.cellM);
      const s = snapToWater(g, mask, c0.x, c0.y, mc, snapR);
      const e = snapToWater(g, mask, c1.x, c1.y, mc, snapR);
      if (!s || !e) return { s, e, mask, overheads, lat, mc };
      // Cheap flood fill first: when the two ends are not connected, A* would expand the whole grid.
      if (!reachable(g, mask, s, mc)[e.y * g.cols + e.x]) return { s, e, unreachable: true, mask, overheads, lat, mc };
      const path = astar(g, mask, s, e, mc, Math.max(mc + 1, comfortCells), opts.comfortWeight);
      return { s, e, mask, overheads, lat, path, mc };
    }

    // Narrow water (Agate Pass, marina entrances, the Ship Canal) is narrower than twice
    // the open-water shore margin. Try the requested margin first, then step it down.
    const margins = [marginCells];
    if (opts.adaptiveMargin !== false) for (let m = Math.floor(marginCells / 2); m >= 0; m = m > 1 ? Math.floor(m / 2) : m - 1) if (m < margins[margins.length - 1]) margins.push(m);
    const warnings = [];
    let a = null;
    const search = (useLateral) => {
      for (const mc of margins) {
        const r = attempt(useLateral, true, mc);
        if (r.path) return r;
        if (!a || (!a.s && r.s) || (!a.e && r.e)) a = r;  // keep the most informative failure
      }
      return null;
    };
    let found = search(lateral);
    if (!found && lateral) {
      found = search(false);
      if (found) warnings.push("Could not honour every lateral mark; this route ignores buoy gates. Check the channel by eye.");
    }
    if (found) a = found;
    if (found && found.mc < marginCells) warnings.push(`Narrow water: shore margin reduced to ${Math.round(found.mc * g.cellM)} m to get through.`);
    if (!a.s) return { error: "Start is not in navigable water for the required depth (" + requiredDepth + " m)" };
    if (!a.e) return { error: "Destination is not in navigable water for the required depth (" + requiredDepth + " m)" };
    if (!found) {
      // Would it work if overheads were ignored? Then name the overheads on that path.
      const minMc = margins[margins.length - 1];
      const probe = attempt(lateral, true, minMc);
      if (needM != null && probe.overheads.some(o => o.blocks)) {
        const c = attempt(lateral, false, minMc);
        if (c.path) {
          const hit = overheadsOnPath(g, c.path, c.overheads).filter(o => o.blocks);
          if (hit.length) {
            return {
              error: "Blocked overhead: " + hit.map(o => describeOverhead(o) + " < " + needM.toFixed(1) + " m needed").join("; "),
              blockedBy: hit,
            };
          }
        }
      }
      return { error: "No water route found at " + requiredDepth + " m depth: the destination's water is not connected to the start within the search area. Try a shallower draft, or check the chart for a bar or bridge in between." };
    }
    const { s, e, mask, path, mc } = a;
    const simple = simplify(g, mask, path, mc);
    const waypoints = simple.map(i => cellCenter(g, i % g.cols, Math.floor(i / g.cols)));
    waypoints[0] = { lat: from.lat, lon: from.lon };
    waypoints[waypoints.length - 1] = { lat: to.lat, lon: to.lon };

    let minAlong = Infinity;
    for (const i of path) { const d = g.minDepth[i]; if (!Number.isNaN(d) && d !== LAND && d < minAlong) minAlong = d; }

    // Report gates passed and overheads passed under, along the actual legs.
    const legsCells = simple.map(i => ({ x: i % g.cols, y: Math.floor(i / g.cols) }));
    const gatesPassed = [];
    for (const gt of a.lat.gates) {
      for (let k = 1; k < legsCells.length; k++) {
        const p1 = legsCells[k - 1], p2 = legsCells[k];
        if (!segIntersect(p1, p2, gt.a, gt.b)) continue;
        // which side does each mark fall on, relative to the direction of travel?
        const side = (m) => ((p2.x - p1.x) * (m.y - p1.y) - (p2.y - p1.y) * (m.x - p1.x)) > 0 ? "starboard" : "port"; // grid y points south
        gatesPassed.push({ leg: k, marks: [gt.a, gt.b].map(m => ({ name: m.name, colour: m.colour, side: m.side, passedTo: side(m) })), widthM: Math.round(gt.widthM) });
        break;
      }
    }
    const under = overheadsOnLegs(g, legsCells, a.overheads);
    for (const o of under) {
      if (o.needsOpening) warnings.push(describeOverhead(o) + ": opening required (closed clearance below " + needM.toFixed(1) + " m)");
      else if (o.clearance == null && needM != null) warnings.push(describeOverhead(o) + ": clearance not charted");
    }

    return {
      waypoints, cellPath: path, grid: g, mask, warnings,
      stats: {
        ms: Date.now() - t0, cells: g.cols * g.rows, cellM: g.cellM, expanded: path.expanded,
        startMovedM: s.moved * g.cellM, endMovedM: e.moved * g.cellM,
        minChartedDepth: isFinite(minAlong) ? minAlong : null, requiredDepth, marginM: mc * g.cellM, requestedMarginM: marginCells * g.cellM,
        lateral: { marks: a.lat.marks.length, gates: a.lat.gates.length, unpaired: a.lat.unpaired, gatesPassed },
        overheads: under, neededClearance: needM,
      },
      gates: a.lat.gates.map(gt => [gt.a, gt.b].map(m => ({ lat: m.lat, lon: m.lon, colour: m.colour }))),
    };
  }

  function describeOverhead(o) {
    const cat = o.category && o.category !== "bridge" && o.category !== o.kind ? o.category + " " : "";
    const nm = o.name || (o.kind === "bridge" ? "Unnamed " + cat + "bridge" : "Overhead " + o.kind);
    const clr = o.clearance == null ? "clearance not charted" : (o.opening ? "closed " : "") + o.clearance.toFixed(1) + " m" + (o.inherited ? " (from adjoining section)" : "");
    return `${nm} (${o.opening && o.name ? o.category + ", " : ""}${clr})`;
  }
  function overheadsOnPath(g, path, list) {
    const ids = new Set();
    for (const i of path) if (g.overId[i] >= 0) ids.add(g.overId[i]);
    return [...ids].map(id => list[id]);
  }
  /** Overheads crossed by the legs; each carries .leg = index of the first leg that passes under it. */
  function overheadsOnLegs(g, legsCells, list) {
    const first = new Map();
    for (let k = 1; k < legsCells.length; k++) {
      const a = legsCells[k - 1], b = legsCells[k];
      lineCells(a.x, a.y, b.x, b.y, (x, y) => { const id = g.overId[y * g.cols + x]; if (id >= 0 && !first.has(id)) first.set(id, k); });
    }
    return [...first].map(([id, k]) => Object.assign({}, list[id], { leg: k }));
  }

  /** Bounding box around two points padded by a fraction and a minimum in metres. */
  function routingBbox(a, b, padFrac, minPadM) {
    padFrac = padFrac == null ? 0.35 : padFrac; minPadM = minPadM || 2500;
    const midLat = (a.lat + b.lat) / 2;
    const w = Math.min(a.lon, b.lon), e = Math.max(a.lon, b.lon), s = Math.min(a.lat, b.lat), n = Math.max(a.lat, b.lat);
    const padLat = Math.max((n - s) * padFrac, minPadM / (R * D2R));
    const padLon = Math.max((e - w) * padFrac, minPadM / (R * D2R * Math.cos(midLat * D2R)));
    return [w - padLon, s - padLat, e + padLon, n + padLat];
  }

  return {
    LAND, makeGrid, toCell, cellCenter, inGrid, fillPolygon, rasterize, applyHazards, buildMask,
    snapToWater, astar, lineClear, simplify, route, routingBbox, Heap,
    lineCells, applyOverheads, overheadInfo, applyLateral, markSide, markColour, describeOverhead,
  };
}));

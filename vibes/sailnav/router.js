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
 *   4. A* (8-connected, binary heap) between the snapped endpoints.
 *   5. String-pull the cell path into as few straight legs as possible.
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
      if (g.hazard[i]) continue;
      if (Number.isNaN(d)) { if (allowUnknown) ok[i] = 1; continue; }
      if (d === LAND) continue;
      if (d >= requiredDepth) ok[i] = 1;
    }
    // multi-source BFS distance transform (chebyshev-ish, 8-neighbour)
    const dist = new Uint16Array(n).fill(0xffff);
    const q = new Int32Array(n);
    let qh = 0, qt = 0;
    for (let i = 0; i < n; i++) if (!ok[i]) { dist[i] = 0; q[qt++] = i; }
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
   * route(data, from, to, opts) -> { waypoints:[{lat,lon}], cellPath, grid, stats } | { error }
   *   data: output of Chart.fetchRoutingData (must cover both points)
   *   opts.requiredDepth  metres of charted depth needed (default 3)
   *   opts.marginM        hard keep-off from shore/hazards (default 60)
   *   opts.comfortM       soft band preferring channel centres (default 250)
   *   opts.cellM          grid resolution (default 40)
   *   opts.allowUnknown   treat uncharted cells as water (default false)
   */
  function route(data, from, to, opts) {
    opts = opts || {};
    const t0 = Date.now();
    const requiredDepth = opts.requiredDepth == null ? 3 : opts.requiredDepth;
    const g = opts.grid || rasterize(makeGrid(data.bbox, opts.cellM || 40, opts.maxCells), data);
    if (!opts.grid) applyHazards(g, data.hazards, requiredDepth, opts.hazardBufferM || 40);
    const mask = buildMask(g, requiredDepth, !!opts.allowUnknown);
    const marginCells = Math.round((opts.marginM == null ? 60 : opts.marginM) / g.cellM);
    const comfortCells = Math.max(marginCells + 1, Math.round((opts.comfortM == null ? 250 : opts.comfortM) / g.cellM));

    const c0 = toCell(g, from.lat, from.lon), c1 = toCell(g, to.lat, to.lon);
    if (!inGrid(g, c0.x, c0.y) || !inGrid(g, c1.x, c1.y)) return { error: "Endpoint outside routing area" };
    const s = snapToWater(g, mask, c0.x, c0.y, marginCells, Math.ceil(1500 / g.cellM));
    const e = snapToWater(g, mask, c1.x, c1.y, marginCells, Math.ceil(1500 / g.cellM));
    if (!s) return { error: "Start is not in navigable water for the required depth (" + requiredDepth + " m)" };
    if (!e) return { error: "Destination is not in navigable water for the required depth (" + requiredDepth + " m)" };

    const path = astar(g, mask, s, e, marginCells, comfortCells, opts.comfortWeight);
    if (!path) return { error: "No water route found at " + requiredDepth + " m depth. Try a shallower draft or smaller margin." };
    const simple = simplify(g, mask, path, marginCells);

    const waypoints = simple.map(i => cellCenter(g, i % g.cols, Math.floor(i / g.cols)));
    // Keep the user's exact endpoints as the first/last waypoint.
    waypoints[0] = { lat: from.lat, lon: from.lon };
    waypoints[waypoints.length - 1] = { lat: to.lat, lon: to.lon };

    // Shallowest charted depth the route passes through (excluding endpoints' snap legs)
    let minAlong = Infinity;
    for (const i of path) { const d = g.minDepth[i]; if (!Number.isNaN(d) && d !== LAND && d < minAlong) minAlong = d; }

    return {
      waypoints, cellPath: path, grid: g, mask,
      stats: {
        ms: Date.now() - t0, cells: g.cols * g.rows, cellM: g.cellM, expanded: path.expanded,
        startMovedM: s.moved * g.cellM, endMovedM: e.moved * g.cellM,
        minChartedDepth: isFinite(minAlong) ? minAlong : null, requiredDepth, marginM: marginCells * g.cellM,
      },
    };
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
  };
}));

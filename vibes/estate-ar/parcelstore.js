/*
 * parcelstore.js - offline parcel cache for Estate AR.
 *
 * Parcels are kept in IndexedDB keyed by provider + parcel id, along with a
 * list of "coverage" circles: every (lat, lon, radius, time) that was fetched
 * from the network. That makes two questions cheap:
 *
 *   coverage.covers(lat, lon, radius)   is this whole circle inside something we
 *                                       fetched recently? -> no network needed
 *   store.near(lat, lon, radius)        every cached parcel whose centroid is
 *                                       within radius -> render offline
 *   planPrecache(...)                   hex-tile a neighbourhood with fetch
 *                                       circles, skipping what is covered
 *   Track / planAhead / allowAuto       course from GPS fixes, a corridor of
 *                                       circles ahead of it, and the
 *                                       wifi/data-saver gate for auto mode
 *
 * So walking back along a street you already looked at is instant and works
 * with no signal; a new block needs one fetch and is then kept for `ttlMs`.
 *
 * The geometry/bookkeeping lives in `Coverage` (pure, tested under bun); the
 * IndexedDB adapter is `ParcelDB`. A `MemoryDB` with the same shape is used in
 * tests and as a fallback when IndexedDB is unavailable (private mode).
 *
 * Browser global (window.ParcelStore) or CommonJS module. Depends on geo.js.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./geo.js"));
  else root.ParcelStore = factory(root.Geo);
}(typeof self !== "undefined" ? self : this, function (Geo) {
  "use strict";

  const DEFAULT_TTL = 14 * 24 * 3600e3;   // assessed values change yearly; two weeks is plenty
  const MAX_CIRCLES = 400;

  class Coverage {
    constructor(circles, ttlMs) { this.circles = circles || []; this.ttlMs = ttlMs || DEFAULT_TTL; }
    fresh(now) { const t = (now || Date.now()) - this.ttlMs; return this.circles.filter((c) => c.at > t); }
    /** True when the query circle lies entirely inside one fresh fetched circle of the same provider. */
    covers(lat, lon, radius, providerId, now) {
      for (const c of this.fresh(now)) {
        if (c.providerId !== providerId) continue;
        if (Geo.haversine(lat, lon, c.lat, c.lon) + radius <= c.radius + 1) return true;
      }
      return false;
    }
    /** Fraction (0..1) of the query circle's area that fresh coverage overlaps — a cheap Monte-Carlo-free estimate using sample points on 3 rings. */
    fraction(lat, lon, radius, providerId, now) {
      const fresh = this.fresh(now).filter((c) => c.providerId === providerId);
      if (!fresh.length) return 0;
      const mpd = Geo.metresPerDegree(lat);
      let hit = 0, total = 0;
      for (const rf of [0.25, 0.6, 0.9]) for (let a = 0; a < 360; a += 30) {
        const pl = lat + Math.cos(a * Math.PI / 180) * radius * rf / mpd.lat, po = lon + Math.sin(a * Math.PI / 180) * radius * rf / mpd.lon;
        total++;
        if (fresh.some((c) => Geo.haversine(pl, po, c.lat, c.lon) <= c.radius)) hit++;
      }
      return hit / total;
    }
    add(lat, lon, radius, providerId, now) {
      const at = now || Date.now();
      // drop circles this one fully contains (same provider) to keep the list short
      this.circles = this.circles.filter((c) => !(c.providerId === providerId && Geo.haversine(lat, lon, c.lat, c.lon) + c.radius <= radius + 1));
      this.circles.push({ lat, lon, radius, providerId, at });
      const t = at - this.ttlMs;
      this.circles = this.circles.filter((c) => c.at > t);
      if (this.circles.length > MAX_CIRCLES) this.circles.splice(0, this.circles.length - MAX_CIRCLES);
      return this;
    }
    /** Circles as [minLon,minLat,maxLon,maxLat] for a mini-map, oldest first. */
    boxes(now) {
      return this.fresh(now).map((c) => { const m = Geo.metresPerDegree(c.lat); return [c.lon - c.radius / m.lon, c.lat - c.radius / m.lat, c.lon + c.radius / m.lon, c.lat + c.radius / m.lat]; });
    }
  }

  // ---- serialisation of parcels (Dates -> ms) --------------------------------
  function freeze(p) {
    return { ...p, sales: (p.sales || []).map((s) => ({ ...s, date: s.date ? +s.date : null })), lastSale: p.lastSale ? { ...p.lastSale, date: p.lastSale.date ? +p.lastSale.date : null } : null };
  }
  function thaw(p) {
    return { ...p, sales: (p.sales || []).map((s) => ({ ...s, date: s.date != null ? new Date(s.date) : null })), lastSale: p.lastSale ? { ...p.lastSale, date: p.lastSale.date != null ? new Date(p.lastSale.date) : null } : null };
  }
  const keyOf = (providerId, id) => providerId + "|" + id;

  // ---- in-memory DB (tests, fallback) ------------------------------------------
  class MemoryDB {
    constructor() { this.parcels = new Map(); this.meta = new Map(); }
    async putParcels(providerId, parcels) { for (const p of parcels) this.parcels.set(keyOf(providerId, p.id), { key: keyOf(providerId, p.id), providerId, lat: p.centroid.lat, lon: p.centroid.lon, at: Date.now(), data: freeze(p) }); }
    async parcelsInBox(providerId, box) { const [w, s, e, n] = box; return [...this.parcels.values()].filter((r) => r.providerId === providerId && r.lon >= w && r.lon <= e && r.lat >= s && r.lat <= n).map((r) => thaw(r.data)); }
    async getMeta(k) { return this.meta.get(k); }
    async setMeta(k, v) { this.meta.set(k, v); }
    async count() { return this.parcels.size; }
    async clear() { this.parcels.clear(); this.meta.clear(); }
  }

  // ---- IndexedDB adapter ---------------------------------------------------------
  class ParcelDB {
    constructor(name) { this.name = name || "estate-ar"; this.db = null; }
    open() {
      if (this.db) return Promise.resolve(this.db);
      return new Promise((res, rej) => {
        const r = indexedDB.open(this.name, 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          const ps = db.createObjectStore("parcels", { keyPath: "key" });
          ps.createIndex("provLat", ["providerId", "lat"]);
          db.createObjectStore("meta");
        };
        r.onsuccess = () => { this.db = r.result; res(this.db); };
        r.onerror = () => rej(r.error);
      });
    }
    tx(store, mode, fn) {
      return this.open().then((db) => new Promise((res, rej) => {
        const t = db.transaction(store, mode), s = t.objectStore(store);
        let out; try { out = fn(s); } catch (e) { rej(e); return; }
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
        t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      }));
    }
    async putParcels(providerId, parcels) {
      const at = Date.now();
      await this.tx("parcels", "readwrite", (s) => { for (const p of parcels) s.put({ key: keyOf(providerId, p.id), providerId, lat: p.centroid.lat, lon: p.centroid.lon, at, data: freeze(p) }); });
    }
    parcelsInBox(providerId, box) {
      const [w, s, e, n] = box;
      return this.open().then((db) => new Promise((res, rej) => {
        const out = [];
        const req = db.transaction("parcels").objectStore("parcels").index("provLat").openCursor(IDBKeyRange.bound([providerId, s], [providerId, n]));
        req.onsuccess = () => { const c = req.result; if (!c) { res(out); return; } const r = c.value; if (r.lon >= w && r.lon <= e) out.push(thaw(r.data)); c.continue(); };
        req.onerror = () => rej(req.error);
      }));
    }
    getMeta(k) { return this.tx("meta", "readonly", (s) => s.get(k)); }
    setMeta(k, v) { return this.tx("meta", "readwrite", (s) => s.put(v, k)); }
    count() { return this.tx("parcels", "readonly", (s) => s.count()); }
    clear() { return this.tx("parcels", "readwrite", (s) => s.clear()).then(() => this.tx("meta", "readwrite", (s) => s.clear())); }
  }

  // ---- the store the app talks to ------------------------------------------------
  class Store {
    constructor(db, opts) { this.db = db; this.ttlMs = (opts && opts.ttlMs) || DEFAULT_TTL; this.coverage = new Coverage([], this.ttlMs); this.ready = this._load(); }
    async _load() { try { const c = await this.db.getMeta("coverage"); if (Array.isArray(c)) this.coverage = new Coverage(c, this.ttlMs); } catch (e) { /* fresh */ } }
    /** Does this circle need the network? */
    async needsFetch(lat, lon, radius, providerId) { await this.ready; return !this.coverage.covers(lat, lon, radius, providerId); }
    async coveredFraction(lat, lon, radius, providerId) { await this.ready; return this.coverage.fraction(lat, lon, radius, providerId); }
    /** Record a successful fetch. */
    async put(lat, lon, radius, providerId, parcels) {
      await this.ready;
      await this.db.putParcels(providerId, parcels);
      this.coverage.add(lat, lon, radius, providerId);
      await this.db.setMeta("coverage", this.coverage.circles);
    }
    /** Cached parcels within radius of a point (centroid test), any age. */
    async near(lat, lon, radius, providerId) {
      const m = Geo.metresPerDegree(lat), pad = radius * 1.3;   // pad: a parcel's centroid can sit outside the circle its edge touches
      const rows = await this.db.parcelsInBox(providerId, [lon - pad / m.lon, lat - pad / m.lat, lon + pad / m.lon, lat + pad / m.lat]);
      return rows.filter((p) => Geo.haversine(lat, lon, p.centroid.lat, p.centroid.lon) <= pad);
    }
    async count() { return this.db.count(); }
    async clear() { await this.db.clear(); this.coverage = new Coverage([], this.ttlMs); }
  }

  // ---- precaching a neighbourhood -----------------------------------------------
  /**
   * Tile a circle of `areaM` around (lat, lon) with fetch circles of radius
   * `fetchM` on a hexagonal lattice so the whole area is covered with modest
   * overlap. Circles already fully inside fresh coverage are skipped. Returns
   * the centres ordered nearest-first so the walkable part is cached first.
   */
  function planPrecache(lat, lon, areaM, fetchM, coverage, providerId, now) {
    const mpd = Geo.metresPerDegree(lat);
    const dx = fetchM * Math.sqrt(3) * 0.92, dy = fetchM * 1.5 * 0.92;   // hex lattice, 8% tighter than touching so gaps close
    const out = [];
    const rows = Math.ceil(areaM / dy) + 1;
    for (let j = -rows; j <= rows; j++) {
      const y = j * dy, off = (j % 2) ? dx / 2 : 0;
      const cols = Math.ceil(areaM / dx) + 1;
      for (let i = -cols; i <= cols; i++) {
        const x = i * dx + off, r = Math.hypot(x, y);
        if (r - fetchM > areaM) continue;                       // circle does not touch the area
        const cl = lat + y / mpd.lat, co = lon + x / mpd.lon;
        const covered = coverage ? coverage.covers(cl, co, fetchM, providerId, now) : false;
        out.push({ lat: cl, lon: co, radius: fetchM, dist: r, covered });
      }
    }
    out.sort((a, b) => a.dist - b.dist);
    return { circles: out, todo: out.filter((c) => !c.covered), skipped: out.filter((c) => c.covered).length };
  }

  /**
   * Boundary of a union of circles as arc segments: for each circle, the angular
   * intervals of its perimeter not inside any other circle. Input/output in a
   * planar frame ({x, y, r} in the same units). Returns [{x, y, r, a0, a1}].
   */
  function unionArcs(circles) {
    const out = [];
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      let covered = [];   // [a0, a1] intervals (radians, may exceed 2π)
      let swallowed = false;
      for (let j = 0; j < circles.length; j++) {
        if (i === j) continue;
        const o = circles[j], dx = o.x - c.x, dy = o.y - c.y, d = Math.hypot(dx, dy);
        if (d >= c.r + o.r) continue;                        // disjoint
        if (d + c.r <= o.r && (d + c.r < o.r || j < i)) { swallowed = true; break; }   // c inside o (identical circles: lowest index survives)
        if (d + o.r <= c.r) continue;                        // o inside c
        const ang = Math.atan2(dy, dx), half = Math.acos((c.r * c.r + d * d - o.r * o.r) / (2 * c.r * d));
        covered.push([ang - half, ang + half]);
      }
      if (swallowed) continue;
      if (!covered.length) { out.push({ x: c.x, y: c.y, r: c.r, a0: 0, a1: Math.PI * 2 }); continue; }
      // normalise to [0, 2π), split wrapping intervals, merge, complement
      const iv = [];
      for (const [a0, a1] of covered) {
        const T = Math.PI * 2, len = a1 - a0; let a = ((a0 % T) + T) % T;
        if (a + len <= T) iv.push([a, a + len]); else { iv.push([a, T]); iv.push([0, a + len - T]); }
      }
      iv.sort((p, q) => p[0] - q[0]);
      const merged = [];
      for (const s of iv) { const l = merged[merged.length - 1]; if (l && s[0] <= l[1]) l[1] = Math.max(l[1], s[1]); else merged.push([s[0], s[1]]); }
      let cur = 0;
      for (const [a, b] of merged) { if (a > cur + 1e-9) out.push({ x: c.x, y: c.y, r: c.r, a0: cur, a1: a }); cur = Math.max(cur, b); }
      if (cur < Math.PI * 2 - 1e-9) out.push({ x: c.x, y: c.y, r: c.r, a0: cur, a1: Math.PI * 2 });
    }
    return out;
  }

  // ---- auto-precache along the route -----------------------------------------------
  /**
   * Course of travel from GPS fixes. Keeps the last few fixes, reports speed and
   * bearing once the track is long enough to trust (GPS jitter at walking pace is
   * a few metres, so we need tens of metres of displacement).
   */
  class Track {
    constructor(opts) { this.fixes = []; this.windowMs = (opts && opts.windowMs) || 90e3; this.minDist = (opts && opts.minDist) || 25; }
    push(lat, lon, at) {
      const t = at ?? Date.now();
      this.fixes.push({ lat, lon, t });
      while (this.fixes.length && t - this.fixes[0].t > this.windowMs) this.fixes.shift();
      if (this.fixes.length > 60) this.fixes.shift();
      return this;
    }
    /** {bearing, speed (m/s), distance} over the window, or null when not moving enough. */
    course() {
      if (this.fixes.length < 2) return null;
      const a = this.fixes[0], b = this.fixes[this.fixes.length - 1];
      const d = Geo.haversine(a.lat, a.lon, b.lat, b.lon), dt = (b.t - a.t) / 1000;
      if (d < this.minDist || dt <= 0) return null;
      return { bearing: Geo.bearing(a.lat, a.lon, b.lat, b.lon), speed: d / dt, distance: d };
    }
    reset() { this.fixes = []; }
  }

  /**
   * Fetch circles ahead of a moving viewer: a corridor of `fetchM` circles along
   * the course, `lookaheadM` long and ~2 circles wide (so a turn at the next
   * block is still covered), skipping what coverage already has. Nearest first.
   */
  function planAhead(lat, lon, bearingDeg, lookaheadM, fetchM, coverage, providerId, now) {
    const mpd = Geo.metresPerDegree(lat), b = bearingDeg * Math.PI / 180;
    const fx = Math.sin(b), fy = Math.cos(b), rx = fy, ry = -fx;       // forward and right unit vectors (x east, y north)
    const step = fetchM * 1.5, side = fetchM * 1.6;
    const out = [];
    for (let s = step * 0.5; s <= lookaheadM; s += step) {
      for (const k of [0, -1, 1]) {
        const x = fx * s + rx * side * k * 0.5, y = fy * s + ry * side * k * 0.5;
        const cl = lat + y / mpd.lat, co = lon + x / mpd.lon;
        const covered = coverage ? coverage.covers(cl, co, fetchM, providerId, now) : false;
        out.push({ lat: cl, lon: co, radius: fetchM, dist: Math.hypot(x, y), covered });
      }
    }
    out.sort((p, q) => p.dist - q.dist);
    return { circles: out, todo: out.filter((c) => !c.covered), skipped: out.filter((c) => c.covered).length };
  }

  /**
   * Should we auto-precache now? `conn` is navigator.connection (may be undefined).
   * mode: "off" | "wifi" | "any". Unmetered is inferred from type/saveData; browsers
   * without the API (iOS Safari) cannot tell, so "wifi" there means "not saveData
   * and not known cellular", which is the best available answer.
   */
  function allowAuto(mode, conn, online) {
    if (mode === "off" || online === false) return { ok: false, why: online === false ? "offline" : "off" };
    if (conn && conn.saveData) return { ok: false, why: "data saver on" };
    if (mode === "any") return { ok: true, why: "any connection" };
    if (!conn || !conn.type || conn.type === "unknown") return { ok: true, why: "connection type unknown, assuming ok" };
    if (conn.type === "wifi" || conn.type === "ethernet") return { ok: true, why: conn.type };
    return { ok: false, why: conn.type };
  }

  /**
   * Rolling 24 h byte meter, persisted. `add(bytes)` on every response, `today()`
   * for the total; `over(limitBytes)` is the gate auto mode and the manual
   * precache estimate consult. Buckets are hourly so the window slides.
   */
  class DataMeter {
    constructor(storage, key) { this.storage = storage || null; this.key = key || "estate-ar:data"; this.buckets = {}; this._load(); }
    _load() { if (!this.storage) return; try { const d = JSON.parse(this.storage.getItem(this.key) || "{}"); if (d && typeof d === "object") this.buckets = d; } catch (e) { /* */ } }
    _save() { if (!this.storage) return; try { this.storage.setItem(this.key, JSON.stringify(this.buckets)); } catch (e) { /* */ } }
    _prune(now) { const cut = Math.floor((now || Date.now()) / 3600e3) - 24; for (const k of Object.keys(this.buckets)) if (Number(k) < cut) delete this.buckets[k]; }
    add(bytes, now) { const h = Math.floor((now || Date.now()) / 3600e3); this.buckets[h] = (this.buckets[h] || 0) + bytes; this._prune(now); this._save(); }
    today(now) { this._prune(now); return Object.values(this.buckets).reduce((a, b) => a + b, 0); }
    over(limitBytes, now) { return this.today(now) >= limitBytes; }
  }

  function open(opts) {
    const useIDB = typeof indexedDB !== "undefined" && !(opts && opts.memory);
    return new Store(useIDB ? new ParcelDB(opts && opts.name) : new MemoryDB(), opts);
  }

  return { Coverage, MemoryDB, ParcelDB, Store, open, freeze, thaw, planPrecache, planAhead, unionArcs, Track, allowAuto, DataMeter, DEFAULT_TTL };
}));

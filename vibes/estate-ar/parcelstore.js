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

  function open(opts) {
    const useIDB = typeof indexedDB !== "undefined" && !(opts && opts.memory);
    return new Store(useIDB ? new ParcelDB(opts && opts.name) : new MemoryDB(), opts);
  }

  return { Coverage, MemoryDB, ParcelDB, Store, open, freeze, thaw, DEFAULT_TTL };
}));

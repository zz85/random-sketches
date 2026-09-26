/*
 * providers.js - data access for Estate AR. Everything here is a plain
 * browser fetch to a CORS-enabled public endpoint; there is no server side.
 *
 *   PROVIDERS        - registry of ArcGIS parcel services, keyed by id. Each
 *                      entry maps the service's field names onto the
 *                      normalised Parcel shape below, so adding a county is a
 *                      config change (most US assessors publish ArcGIS REST).
 *   queryParcels()   - parcels intersecting a circle around the viewer
 *   querySales()     - recent sales in the same circle (optional per provider)
 *   normalizeParcel()- Esri feature -> Parcel
 *   joinSales()      - attach sales to parcels by PIN
 *   reverseGeocode() - Nominatim, for the header ("Seattle · University District")
 *   ParcelStore      - in-memory + localStorage cache with a "do we need to
 *                      refetch" test based on how far the viewer moved
 *
 * Parcel = {
 *   id, address, city, zip, use, zoning, propType, name, plat,
 *   landValue, imprValue, totalValue, lotSqft, acres,
 *   ring: [[lon,lat],...], centroid: {lat, lon, areaM2},
 *   sales: [{date: Date, price, use, type}]   // filled by joinSales
 * }
 *
 * Browser global (window.Providers) or CommonJS module. Depends on geo.js.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./geo.js"));
  else root.Providers = factory(root.Geo);
}(typeof self !== "undefined" ? self : this, function (Geo) {
  "use strict";

  const PROVIDERS = {
    kingcounty: {
      id: "kingcounty",
      name: "King County Assessor",
      attribution: "King County Assessor's Office, King County GIS Center",
      // Rough bbox used to pick a provider from GPS. [minLon, minLat, maxLon, maxLat]
      bbox: [-122.55, 47.08, -121.06, 47.78],
      // Magnetic declination (deg, east positive) for converting magnetic compass to true. Seattle 2026 ≈ 15.3°E.
      declination: 15.3,
      parcels: {
        url: "https://gismaps.kingcounty.gov/arcgis/rest/services/Property/KingCo_PropertyInfo/MapServer/2/query",
        fields: {
          id: "PIN", address: "ADDR_FULL", city: "CTYNAME", zip: "ZIP5",
          use: "PREUSE_DESC", zoning: "KCA_ZONING", propType: "PROPTYPE",
          name: "PROP_NAME", plat: "PLAT_NAME",
          landValue: "APPRLNDVAL", imprValue: "APPR_IMPR",
          lotSqft: "LOTSQFT", acres: "KCA_ACRES",
        },
      },
      sales: {
        url: "https://gismaps.kingcounty.gov/arcgis/rest/services/Property/KingCo_PropertyInfo/MapServer/3/query",
        fields: { id: "PIN", date: "SaleDate", price: "SalePrice", use: "Principal_Use", type: "Property_Type" },
      },
      // Public record pages, by PIN
      links: {
        assessor: (p) => `https://blue.kingcounty.com/Assessor/eRealProperty/Dashboard.aspx?ParcelNbr=${p.id}`,
        parcelViewer: (p) => `https://gismaps.kingcounty.gov/parcelviewer2/?pin=${p.id}`,
      },
      propTypes: { R: "Residential", C: "Commercial", K: "Condominium", M: "Mobile home", T: "Timber", U: "Undeveloped", X: "Exempt" },
    },
  };

  function providerFor(lat, lon) {
    for (const p of Object.values(PROVIDERS)) {
      const [w, s, e, n] = p.bbox;
      if (lon >= w && lon <= e && lat >= s && lat <= n) return p;
    }
    return null;
  }

  // ---- ArcGIS REST -------------------------------------------------------

  function arcgisParams(lat, lon, radiusM, outFields, withGeometry) {
    const q = new URLSearchParams({
      geometry: `${lon.toFixed(6)},${lat.toFixed(6)}`,
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      distance: String(Math.round(radiusM)),
      units: "esriSRUnit_Meter",
      outFields: outFields.join(","),
      returnGeometry: withGeometry ? "true" : "false",
      outSR: "4326",
      geometryPrecision: "6",
      f: "json",
    });
    return q;
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

  function normalizeParcel(feature, provider) {
    const F = provider.parcels.fields, a = feature.attributes || {};
    const ring = Geo.outerRing(feature.geometry && feature.geometry.rings);
    if (!ring) return null;
    const land = num(a[F.landValue]), impr = num(a[F.imprValue]);
    const p = {
      id: String(a[F.id]),
      address: clean(a[F.address]) || null,
      city: clean(a[F.city]) || null,
      zip: clean(a[F.zip]) || null,
      use: clean(a[F.use]) || null,
      zoning: clean(a[F.zoning]) || null,
      propType: clean(a[F.propType]) || null,
      name: clean(a[F.name]) || null,
      plat: clean(a[F.plat]) || null,
      landValue: land,
      imprValue: impr,
      totalValue: land == null && impr == null ? null : (land || 0) + (impr || 0),
      lotSqft: num(a[F.lotSqft]),
      acres: num(a[F.acres]),
      ring,
      centroid: Geo.ringCentroid(ring),
      sales: [],
    };
    if (provider.propTypes && p.propType) p.propTypeName = provider.propTypes[p.propType] || p.propType;
    return p;
  }

  function normalizeSale(feature, provider) {
    const F = provider.sales.fields, a = feature.attributes || {};
    return {
      id: String(a[F.id]),
      date: a[F.date] != null ? new Date(Number(a[F.date])) : null,
      price: num(a[F.price]),
      use: clean(a[F.use]) || null,
      type: clean(a[F.type]) || null,
    };
  }

  /** Attach sales to parcels by id, newest first. Zero-dollar transfers are kept but flagged. */
  function joinSales(parcels, sales) {
    const byId = new Map();
    for (const s of sales) {
      if (!byId.has(s.id)) byId.set(s.id, []);
      byId.get(s.id).push(s);
    }
    for (const p of parcels) {
      const list = (byId.get(p.id) || []).slice().sort((x, y) => (y.date || 0) - (x.date || 0));
      p.sales = list;
      p.lastSale = list.find((s) => s.price > 0) || null;
    }
    return parcels;
  }

  async function queryParcels(provider, lat, lon, radiusM, fetchImpl) {
    const F = provider.parcels.fields;
    const params = arcgisParams(lat, lon, radiusM, Object.values(F), true);
    const data = await arcgisQuery(provider.parcels.url, params, fetchImpl);
    const out = [];
    for (const f of data.features || []) { const p = normalizeParcel(f, provider); if (p) out.push(p); }
    return { parcels: out, exceeded: !!data.exceededTransferLimit };
  }

  async function querySales(provider, lat, lon, radiusM, fetchImpl) {
    if (!provider.sales) return [];
    const F = provider.sales.fields;
    const params = arcgisParams(lat, lon, radiusM, Object.values(F), false);
    const data = await arcgisQuery(provider.sales.url, params, fetchImpl);
    return (data.features || []).map((f) => normalizeSale(f, provider));
  }

  /** One round trip for the app: parcels + sales, joined. */
  async function fetchArea(provider, lat, lon, radiusM, fetchImpl) {
    const [pr, sales] = await Promise.all([
      queryParcels(provider, lat, lon, radiusM, fetchImpl),
      querySales(provider, lat, lon, radiusM, fetchImpl).catch(() => []),
    ]);
    return { parcels: joinSales(pr.parcels, sales), exceeded: pr.exceeded, salesCount: sales.length };
  }

  // ---- Nominatim ---------------------------------------------------------

  async function reverseGeocode(lat, lon, fetchImpl) {
    const f = fetchImpl || fetch;
    const u = `https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&format=jsonv2&zoom=16`;
    const res = await f(u, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const d = await res.json();
    const a = d.address || {};
    return {
      city: a.city || a.town || a.village || a.municipality || a.county || null,
      neighbourhood: a.neighbourhood || a.suburb || a.quarter || a.residential || null,
      road: a.road || null,
      display: d.display_name || null,
    };
  }

  // ---- Cache --------------------------------------------------------------

  /**
   * Keeps the parcels for the last fetched circle. `needsFetch` says whether the
   * viewer has left the inner 60% of that circle (or the cache is stale).
   */
  class ParcelStore {
    constructor(opts) {
      this.storage = (opts && opts.storage) || null;   // window.localStorage or null
      this.ttlMs = (opts && opts.ttlMs) || 6 * 3600e3;
      this.key = (opts && opts.key) || "estate-ar:cache";
      this.center = null; this.radius = 0; this.at = 0; this.parcels = []; this.providerId = null;
      this._load();
    }
    _load() {
      if (!this.storage) return;
      try {
        const raw = this.storage.getItem(this.key); if (!raw) return;
        const d = JSON.parse(raw);
        if (!d || Date.now() - d.at > this.ttlMs) return;
        Object.assign(this, { center: d.center, radius: d.radius, at: d.at, providerId: d.providerId });
        this.parcels = (d.parcels || []).map((p) => ({ ...p, sales: (p.sales || []).map((s) => ({ ...s, date: s.date ? new Date(s.date) : null })), lastSale: p.lastSale ? { ...p.lastSale, date: p.lastSale.date ? new Date(p.lastSale.date) : null } : null }));
      } catch (e) { /* ignore corrupt cache */ }
    }
    _save() {
      if (!this.storage) return;
      try { this.storage.setItem(this.key, JSON.stringify({ center: this.center, radius: this.radius, at: this.at, providerId: this.providerId, parcels: this.parcels })); }
      catch (e) { /* quota; fine */ }
    }
    needsFetch(lat, lon, radiusM, providerId) {
      if (!this.center || this.providerId !== providerId) return true;
      if (Date.now() - this.at > this.ttlMs) return true;
      if (radiusM > this.radius * 1.05) return true;
      const moved = Geo.haversine(lat, lon, this.center.lat, this.center.lon);
      return moved > this.radius * 0.4;
    }
    set(lat, lon, radiusM, providerId, parcels) {
      this.center = { lat, lon }; this.radius = radiusM; this.providerId = providerId; this.at = Date.now();
      this.parcels = parcels; this._save();
    }
    clear() { this.center = null; this.parcels = []; if (this.storage) try { this.storage.removeItem(this.key); } catch (e) { /* */ } }
  }

  return { PROVIDERS, providerFor, arcgisParams, normalizeParcel, normalizeSale, joinSales, queryParcels, querySales, fetchArea, reverseGeocode, ParcelStore };
}));

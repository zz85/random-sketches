/*
 * providers.js - data access for Estate AR. Everything here is a plain
 * browser fetch to a CORS-enabled public endpoint; there is no server side.
 *
 *   PROVIDERS        - registry of ArcGIS parcel services, keyed by id. Each
 *                      entry names the fields to request and maps them onto the
 *                      normalised Parcel shape below, so adding a county is a
 *                      config change (most US assessors publish ArcGIS REST).
 *                      King County (rich, with sales), Snohomish County, and the
 *                      Washington statewide parcel layer (covers Pierce and the
 *                      rest of WA) are included.
 *   queryParcels()   - parcels intersecting a circle around the viewer
 *   querySales()     - recent sales in the same circle (optional per provider)
 *   normalizeParcel()- Esri feature -> Parcel
 *   joinSales()      - attach sales to parcels by PIN
 *   reverseGeocode() - Nominatim, for the header ("Seattle · University District")
 *   (offline cache lives in parcelstore.js)
 *
 * Parcel = {
 *   id, address, city, zip, use, zoning, propType, propTypeName, name, plat, county, link, asOf,
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

  // Washington DOR two-digit land use codes (WAC 458-53-030), used by the statewide layer.
  const WA_DOR_USE = {
    11: "Single family", 12: "2-4 units", 13: "Multi-family (5+)", 14: "Condominium", 15: "Mobile home park", 16: "Hotel/motel", 17: "Institutional lodging", 18: "Group quarters", 19: "Other residential",
    21: "Food processing", 22: "Textile", 23: "Apparel", 24: "Lumber/wood", 25: "Furniture", 26: "Paper", 27: "Printing", 28: "Chemicals", 29: "Petroleum", 30: "Rubber/plastics", 31: "Leather", 32: "Stone/clay/glass", 33: "Primary metals", 34: "Fabricated metals", 35: "Machinery", 36: "Electrical", 37: "Transportation equipment", 38: "Instruments", 39: "Other manufacturing",
    41: "Rail transportation", 42: "Motor vehicle transportation", 43: "Aircraft transportation", 44: "Marine transportation", 45: "Highway/street ROW", 46: "Parking", 47: "Communication", 48: "Utilities", 49: "Other transportation/utility",
    50: "Condominium (non-res)", 51: "Wholesale trade", 52: "Retail – building materials", 53: "Retail – general merchandise", 54: "Retail – food", 55: "Retail – auto/marine", 56: "Retail – apparel", 57: "Retail – furniture", 58: "Retail – eating & drinking", 59: "Other retail",
    61: "Finance/insurance/real estate", 62: "Personal services", 63: "Business services", 64: "Repair services", 65: "Professional services", 66: "Contract construction", 67: "Governmental services", 68: "Educational services", 69: "Miscellaneous services",
    71: "Cultural activities", 72: "Public assembly", 73: "Amusements", 74: "Recreational activities", 75: "Resorts/camps", 76: "Parks", 79: "Other cultural/recreational",
    81: "Agriculture", 82: "Agriculture – current use", 83: "Agriculture classified", 84: "Fishing", 85: "Mining", 86: "Timber – current use", 87: "Timber – designated", 88: "Timber – classified", 89: "Other resource",
    91: "Undeveloped land", 92: "Noncommercial forest", 93: "Water areas", 94: "Open space", 95: "Timberland", 96: "Reserved", 97: "Reserved", 98: "Reserved", 99: "Other undeveloped",
  };
  /** Coarse type bucket (drives label colour) from a DOR code. R residential, K condo, C commercial, U undeveloped, X exempt/public, T timber/ag. */
  function dorType(code) {
    if (code == null) return null;
    if (code === 14) return "K";
    if (code >= 11 && code <= 19) return "R";
    if (code >= 91 && code <= 99) return "U";
    if (code >= 81 && code <= 89) return "T";
    if (code === 67 || code === 68 || code === 76) return "X";
    return "C";
  }
  const PROP_TYPES = { R: "Residential", C: "Commercial", K: "Condominium", M: "Mobile home", T: "Timber / agriculture", U: "Undeveloped", X: "Exempt / public" };

  /** Snohomish/King style "code description" use strings -> coarse type bucket via keywords. */
  function typeFromUse(use) {
    if (!use) return null;
    const u = use.toLowerCase();
    if (/condo/.test(u)) return "K";
    if (/single family|duplex|triplex|4-plex|apartment|multi.?family|residential|mobile home|townhouse|rooming/.test(u)) return "R";
    if (/vacant|undeveloped/.test(u)) return "U";
    if (/church|school|govern|park|public|exempt|welfare|relig|museum|hospital|library/.test(u)) return "X";
    if (/forest|timber|agricult|farm|open space/.test(u)) return "T";
    return "C";
  }

  /**
   * Each provider: an ArcGIS `query` URL, the attribute names to request, and a
   * `map(attributes)` that returns the normalised fields. `bbox` selects the
   * provider from GPS; earlier entries win, so county-specific providers come
   * before the statewide fallback.
   */
  const PROVIDERS = {
    kingcounty: {
      id: "kingcounty",
      name: "King County Assessor",
      attribution: "King County Assessor's Office, King County GIS Center",
      bbox: [-122.55, 47.26, -121.06, 47.78],   // [minLon, minLat, maxLon, maxLat]; King/Pierce line is ~47.255 at the Sound
      declination: 15.3,                        // deg east, Seattle 2026
      parcels: {
        url: "https://gismaps.kingcounty.gov/arcgis/rest/services/Property/KingCo_PropertyInfo/MapServer/2/query",
        outFields: ["PIN", "ADDR_FULL", "CTYNAME", "ZIP5", "PREUSE_DESC", "KCA_ZONING", "PROPTYPE", "PROP_NAME", "PLAT_NAME", "APPRLNDVAL", "APPR_IMPR", "LOTSQFT", "KCA_ACRES"],
        map: (a) => ({
          id: a.PIN, address: a.ADDR_FULL, city: a.CTYNAME, zip: a.ZIP5, use: a.PREUSE_DESC, zoning: a.KCA_ZONING,
          propType: a.PROPTYPE, name: a.PROP_NAME, plat: a.PLAT_NAME, landValue: a.APPRLNDVAL, imprValue: a.APPR_IMPR,
          lotSqft: a.LOTSQFT, acres: a.KCA_ACRES,
        }),
      },
      sales: {
        url: "https://gismaps.kingcounty.gov/arcgis/rest/services/Property/KingCo_PropertyInfo/MapServer/3/query",
        outFields: ["PIN", "SaleDate", "SalePrice", "Principal_Use", "Property_Type"],
        map: (a) => ({ id: a.PIN, date: a.SaleDate, price: a.SalePrice, use: a.Principal_Use, type: a.Property_Type }),
      },
      links: {
        "Assessor record": (p) => `https://blue.kingcounty.com/Assessor/eRealProperty/Dashboard.aspx?ParcelNbr=${p.id}`,
        "Parcel viewer": (p) => `https://gismaps.kingcounty.gov/parcelviewer2/?pin=${p.id}`,
      },
    },

    snohomish: {
      id: "snohomish",
      name: "Snohomish County Assessor",
      attribution: "Snohomish County Assessor / Planning & Development Services",
      bbox: [-122.45, 47.78, -120.9, 48.30],
      declination: 15.4,
      parcels: {
        // The PDS "property report" service: cadastral parcels joined to assessor market values.
        url: "https://gis.snoco.org/scd/rest/services/MapService/pds_prop_report/MapServer/0/query",
        outFields: [
          "GDBA.CADASTRAL__parcels.PARCEL_ID", "GDBA.CADASTRAL__parcels.SITUSLINE1", "GDBA.CADASTRAL__parcels.SITUSCITY", "GDBA.CADASTRAL__parcels.SITUSZIP",
          "GDBA.CADASTRAL__parcels.USECODE", "GDBA.CADASTRAL__parcels.MKLND", "GDBA.CADASTRAL__parcels.MKIMP", "GDBA.CADASTRAL__parcels.GIS_SQ_FT", "GDBA.CADASTRAL__parcels.GIS_ACRES",
          "GDBA.CADASTRAL__parcels.XMPTDESCR", "SCD_GDBA.AMANDA_PROP_DATA.Zoning", "SCD_GDBA.AMANDA_PROP_DATA.Zoning_Desc", "SCD_GDBA.AMANDA_PROP_DATA.Assessor_Link",
        ],
        map: (a) => {
          const g = (k) => a["GDBA.CADASTRAL__parcels." + k], m = (k) => a["SCD_GDBA.AMANDA_PROP_DATA." + k];
          const use = g("USECODE") ? String(g("USECODE")).replace(/^\d+\s*/, "").replace(/\s*-\s*(Real|Pers)\s*$/i, "") : null;   // "910 Undeveloped (Vacant) Land -Real" -> "Undeveloped (Vacant) Land"
          const zoning = m("Zoning_Desc") && m("Zoning") && m("Zoning_Desc") !== m("Zoning") ? `${m("Zoning")} – ${m("Zoning_Desc")}` : (m("Zoning") || null);
          return {
            id: g("PARCEL_ID"), address: g("SITUSLINE1"), city: g("SITUSCITY"), zip: g("SITUSZIP"), use, zoning,
            propType: g("XMPTDESCR") ? "X" : typeFromUse(use), name: g("XMPTDESCR"),
            landValue: g("MKLND"), imprValue: g("MKIMP"), lotSqft: g("GIS_SQ_FT"), acres: g("GIS_ACRES"), link: m("Assessor_Link"),
          };
        },
      },
      links: { "Assessor record": (p) => p.link || `https://www.snoco.org/proptax/search.aspx?parcel_number=${p.id}` },
    },

    // Washington State Parcels Project (OCIO), served by DNR: every WA county with digital parcels,
    // normalised fields, updated yearly. Pierce County has no public REST server of its own, so it
    // comes through here, as does anywhere else in the state not covered above.
    wastate: {
      id: "wastate",
      name: "WA State Parcels (county assessor data)",
      attribution: "Washington State Parcels Project (OCIO / county assessors), served by WA DNR",
      bbox: [-124.85, 45.53, -116.9, 49.01],
      declination: 15.0,
      parcels: {
        url: "https://gis.dnr.wa.gov/site2/rest/services/Public_Forest_Practices/WADNR_PUBLIC_OCIO_Parcels/MapServer/0/query",
        outFields: ["COUNTY_NM", "PARCEL_ID_NR", "ORIG_PARCEL_ID", "SITUS_ADDRESS", "SITUS_CITY_NM", "SITUS_ZIP_NR", "LANDUSE_CD", "ORIG_LANDUSE_CD", "VALUE_LAND", "VALUE_BLDG", "DATA_LINK", "FILE_DATE"],
        map: (a) => ({
          id: a.PARCEL_ID_NR, address: a.SITUS_ADDRESS, city: a.SITUS_CITY_NM, zip: a.SITUS_ZIP_NR,
          use: a.LANDUSE_CD != null ? (WA_DOR_USE[a.LANDUSE_CD] || `DOR ${a.LANDUSE_CD}`) : null,
          propType: dorType(a.LANDUSE_CD), landValue: a.VALUE_LAND, imprValue: a.VALUE_BLDG, link: a.DATA_LINK,
          county: WA_FIPS[a.COUNTY_NM] || a.COUNTY_NM, asOf: a.FILE_DATE,
        }),
      },
      links: { "Assessor record": (p) => p.link },
    },
  };
  // WA county FIPS (3-digit, as COUNTY_NM in the OCIO layer) -> name, for the ones around Puget Sound
  const WA_FIPS = { "33": "King", "53": "Pierce", "61": "Snohomish", "35": "Kitsap", "67": "Thurston", "57": "Skagit", "73": "Whatcom", "29": "Island", "45": "Mason", "31": "Jefferson", "9": "Clallam", "27": "Grays Harbor", "41": "Lewis", "15": "Cowlitz", "11": "Clark", "77": "Yakima", "17": "Douglas", "7": "Chelan", "37": "Kittitas", "63": "Spokane", "5": "Benton", "21": "Franklin", "25": "Grant", "71": "Walla Walla" };

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
    const a = feature.attributes || {};
    const ring = Geo.outerRing(feature.geometry && feature.geometry.rings);
    if (!ring) return null;
    const m = provider.parcels.map(a);
    if (m.id == null) return null;
    const land = num(m.landValue), impr = num(m.imprValue);
    const p = {
      id: String(m.id),
      address: clean(m.address) || null,
      city: clean(m.city) || null,
      zip: clean(m.zip) || null,
      use: clean(m.use) || null,
      zoning: clean(m.zoning) || null,
      propType: clean(m.propType) || null,
      name: clean(m.name) || null,
      plat: clean(m.plat) || null,
      county: clean(m.county) || null,
      link: m.link || null,
      asOf: m.asOf != null ? Number(m.asOf) : null,
      landValue: land,
      imprValue: impr,
      totalValue: land == null && impr == null ? null : (land || 0) + (impr || 0),
      lotSqft: num(m.lotSqft),
      acres: num(m.acres),
      ring,
      centroid: Geo.ringCentroid(ring),
      sales: [],
    };
    if (p.lotSqft == null && p.centroid.areaM2) p.lotSqft = Math.round(p.centroid.areaM2 * 10.7639);   // from the polygon when the assessor doesn't say
    if (p.acres == null && p.lotSqft != null) p.acres = p.lotSqft / 43560;
    if (p.propType) p.propTypeName = PROP_TYPES[p.propType] || p.propType;
    return p;
  }

  function normalizeSale(feature, provider) {
    const m = provider.sales.map(feature.attributes || {});
    return {
      id: String(m.id),
      date: m.date != null ? new Date(Number(m.date)) : null,
      price: num(m.price),
      use: clean(m.use) || null,
      type: clean(m.type) || null,
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
    const params = arcgisParams(lat, lon, radiusM, provider.parcels.outFields, true);
    const data = await arcgisQuery(provider.parcels.url, params, fetchImpl);
    const out = [];
    for (const f of data.features || []) { const p = normalizeParcel(f, provider); if (p) out.push(p); }
    return { parcels: out, exceeded: !!data.exceededTransferLimit };
  }

  async function querySales(provider, lat, lon, radiusM, fetchImpl) {
    if (!provider.sales) return [];
    const params = arcgisParams(lat, lon, radiusM, provider.sales.outFields, false);
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

  return { PROVIDERS, PROP_TYPES, WA_DOR_USE, dorType, typeFromUse, providerFor, arcgisParams, normalizeParcel, normalizeSale, joinSales, queryParcels, querySales, fetchArea, reverseGeocode };
}));

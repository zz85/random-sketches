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
      fallback: "wastate",
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
      fallback: "wastate",
      parcels: {
        // The PDS "property report" service: cadastral parcels joined to assessor market values.
        url: "https://gis.snoco.org/scd/rest/services/MapService/pds_prop_report/MapServer/0/query",
        paging: false,       // advancedQueryCapabilities.supportsPagination is false here
        generalize: false,   // maxAllowableOffset makes this joined view return "Failed to execute query"; rings are decimated client-side instead
        outFields: [
          "GDBA.CADASTRAL__parcels.PARCEL_ID", "GDBA.CADASTRAL__parcels.SITUSLINE1", "GDBA.CADASTRAL__parcels.SITUSCITY", "GDBA.CADASTRAL__parcels.SITUSZIP",
          "GDBA.CADASTRAL__parcels.USECODE", "GDBA.CADASTRAL__parcels.MKLND", "GDBA.CADASTRAL__parcels.MKIMP", "GDBA.CADASTRAL__parcels.GIS_SQ_FT", "GDBA.CADASTRAL__parcels.GIS_ACRES",
          "GDBA.CADASTRAL__parcels.XMPTDESCR", "GDBA.CADASTRAL__parcels.TAX_YEAR", "SCD_GDBA.AMANDA_PROP_DATA.Zoning", "SCD_GDBA.AMANDA_PROP_DATA.Zoning_Desc", "SCD_GDBA.AMANDA_PROP_DATA.Assessor_Link",
        ],
        map: (a) => {
          const g = (k) => a["GDBA.CADASTRAL__parcels." + k], m = (k) => a["SCD_GDBA.AMANDA_PROP_DATA." + k];
          const use = g("USECODE") ? String(g("USECODE")).replace(/^\d+\s*/, "").replace(/\s*-\s*(Real|Pers)\s*$/i, "") : null;   // "910 Undeveloped (Vacant) Land -Real" -> "Undeveloped (Vacant) Land"
          const zoning = m("Zoning_Desc") && m("Zoning") && m("Zoning_Desc") !== m("Zoning") ? `${m("Zoning")} – ${m("Zoning_Desc")}` : (m("Zoning") || null);
          return {
            id: g("PARCEL_ID"), address: g("SITUSLINE1"), city: g("SITUSCITY"), zip: g("SITUSZIP"), use, zoning,
            propType: g("XMPTDESCR") ? "X" : typeFromUse(use), name: g("XMPTDESCR"),
            landValue: g("MKLND"), imprValue: g("MKIMP"), lotSqft: g("GIS_SQ_FT"), acres: g("GIS_ACRES"), link: m("Assessor_Link"), taxYear: g("TAX_YEAR"),
          };
        },
      },
      links: { "Assessor record": (p) => p.link || `https://www.snoco.org/proptax/search.aspx?parcel_number=${p.id}` },
    },

    // TODO: Orange County (ocgis) and Ventura County follow the same ArcGIS pattern
    //       (roll values + base year + living ft²); each is a provider entry like this one.
    lacounty: {
      id: "lacounty",
      name: "Los Angeles County Assessor",
      attribution: "Los Angeles County Assessor / County of Los Angeles eGIS",
      bbox: [-118.95, 33.70, -117.65, 34.82],
      declination: 11.6,        // deg east, LA 2026
      state: "CA",
      prop13: true,             // assessed = purchase price + ≤2 %/yr: show base year, prefer a comps-based market estimate
      parcels: {
        url: "https://cache.gis.lacounty.gov/cache/rest/services/LACounty_Cache/LACounty_Parcel/FeatureServer/0/query",
        outFields: ["AIN", "SitusFullAddress", "SitusCity", "SitusZIP", "UseType", "UseDescription", "YearBuilt1", "Units1", "Bedrooms1", "Bathrooms1", "SQFTmain1", "Units2", "SQFTmain2", "Units3", "SQFTmain3", "Roll_Year", "Roll_LandValue", "Roll_ImpValue", "Roll_LandBaseYear", "Roll_ImpBaseYear", "Roll_HomeOwnersExemp", "Shape__Area"],
        map: (a) => {
          const units = (a.Units1 || 0) + (a.Units2 || 0) + (a.Units3 || 0), sqft = (a.SQFTmain1 || 0) + (a.SQFTmain2 || 0) + (a.SQFTmain3 || 0);
          const desc = a.UseDescription === "Single" ? "Single family" : a.UseDescription;
          const use = desc && desc !== a.UseType ? `${desc}${a.UseType && !/^Res/i.test(a.UseType) ? " (" + a.UseType + ")" : ""}` : (a.UseType || null);
          const t = String(a.UseType || "").toUpperCase();
          const propType = /SFR|SINGLE/.test(t) ? "R" : /CND|CONDO/.test(t) ? "K" : /VAC/.test(t) ? "U" : /RES|MULTI|APART|\dU\b/.test(t) || (units >= 2 && /R/.test(t)) ? "R" : /GOV|INST|EXEMPT|CHURCH|SCHOOL/.test(t) ? "X" : "C";
          return {
            id: a.AIN,
            // "24513 PALERMO DR CALABASAS CA 91302" -> "24513 PALERMO DR"
            address: a.SitusFullAddress ? String(a.SitusFullAddress).replace(/\s+CA\s+\d{5}(-\d{4})?\s*$/, "").replace(a.SitusCity ? new RegExp("\\s+" + String(a.SitusCity).replace(/\s+CA$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$", "i") : /$^/, "") : null,
            city: a.SitusCity ? String(a.SitusCity).replace(/\s+CA$/, "") : null, zip: a.SitusZIP ? String(a.SitusZIP).slice(0, 5) : null, use, propType,
            landValue: a.Roll_LandValue, imprValue: a.Roll_ImpValue,
            lotSqft: a.Shape__Area ? a.Shape__Area * 10.7639 : null,   // hosted layer area is in m²
            taxYear: a.Roll_Year, baseYear: a.Roll_LandBaseYear && a.Roll_ImpBaseYear ? Math.max(a.Roll_LandBaseYear, a.Roll_ImpBaseYear) : (a.Roll_LandBaseYear || a.Roll_ImpBaseYear || null),
            yearBuilt: a.YearBuilt1 || null, units: units || null, bedrooms: a.Bedrooms1 || null, baths: a.Bathrooms1 || null, livingSqft: sqft || null,
            homeownerExempt: !!a.Roll_HomeOwnersExemp,
          };
        },
      },
      sales: {
        // Assessor "PAIS" sales layer: recorded sales with size and bedrooms, which is what makes a $/ft² comps estimate possible
        url: "https://assessor.gis.lacounty.gov/assessor/rest/services/PAIS/pais_sales_parcels/MapServer/0/query",
        outFields: ["AIN", "SALEDATE", "SALEPRICE", "SIZE", "BEDROOMS", "YEARBUILT", "USETYPE"],
        map: (a) => ({ id: a.AIN, date: a.SALEDATE, price: a.SALEPRICE, use: a.USETYPE, type: a.USETYPE, sqft: a.SIZE, bedrooms: a.BEDROOMS, yearBuilt: a.YEARBUILT != null ? Number(a.YEARBUILT) || null : null }),
      },
      links: { "Assessor portal": (p) => `https://portal.assessor.lacounty.gov/parceldetail/${p.id}` },
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

  /**
   * Geometry generalisation asked of the server, in degrees (~0.5 m). Parcel
   * rings straight from the cadastre carry curb-return arcs at centimetre
   * spacing; at AR scale nothing under half a metre is visible, and this cuts
   * the payload by roughly two thirds (52 KB -> 18 KB gzipped for a 260 m
   * circle in the U-District, 7000 -> 1250 vertices).
   */
  const MAX_OFFSET_DEG = 0.000005;
  const PAGE_LIMIT = 3;   // at most this many pages (x maxRecordCount features) per query

  function arcgisParams(lat, lon, radiusM, outFields, withGeometry, offset, generalize) {
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
      geometryPrecision: "5",
      f: "json",
    });
    if (withGeometry && generalize !== false) q.set("maxAllowableOffset", String(MAX_OFFSET_DEG));
    if (offset) q.set("resultOffset", String(offset));
    return q;
  }

  /** Bytes received on the wire, approximated by response text length (UTF-8, almost all ASCII). Listeners get (bytes, url). */
  const meter = { bytes: 0, listeners: [] };
  function onBytes(fn) { meter.listeners.push(fn); }
  function countBytes(n, url) { meter.bytes += n; for (const fn of meter.listeners) { try { fn(n, url); } catch (e) { /* */ } } }

  async function arcgisQuery(url, params, fetchImpl) {
    const f = fetchImpl || fetch;
    const res = await f(`${url}?${params}`, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status}`);
    const text = await res.text();
    countBytes(text.length, url);
    const data = JSON.parse(text);
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
      taxYear: m.taxYear != null ? Number(m.taxYear) || null : null,
      baseYear: m.baseYear != null ? Number(m.baseYear) || null : null,
      yearBuilt: m.yearBuilt != null ? Number(m.yearBuilt) || null : null,
      unitCount: m.units != null ? Number(m.units) || null : null,
      bedrooms: m.bedrooms != null ? Number(m.bedrooms) || null : null,
      baths: m.baths != null ? Number(m.baths) || null : null,
      livingSqft: m.livingSqft != null ? Number(m.livingSqft) || null : null,
      homeownerExempt: !!m.homeownerExempt,
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
      sqft: m.sqft != null ? Number(m.sqft) || null : null,
      bedrooms: m.bedrooms != null ? Number(m.bedrooms) || null : null,
      yearBuilt: m.yearBuilt || null,
    };
  }

  /**
   * Comparable-sales price per ft² for an area: the median of price/size over
   * TODO: weight comps by recency (half-life ~18 months) and by bedroom-count
   *       match to the subject instead of a plain median over the circle.
   * arm's-length sales (price > 0, size > 0) in the last `years`, optionally
   * restricted to one use type. Returns null with fewer than `min` comps.
   */
  function compsPerSqft(sales, opts) {
    const o = Object.assign({ years: 3, min: 3, now: Date.now() }, opts);
    const cut = o.now - o.years * 365.25 * 86400e3;
    const v = sales.filter((s) => s.price > 0 && s.sqft > 0 && s.date && +s.date >= cut && (!o.type || s.type === o.type)).map((s) => s.price / s.sqft).sort((a, b) => a - b);
    if (v.length < o.min) return null;
    const mid = Math.floor(v.length / 2), median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
    return { psf: median, n: v.length, low: v[Math.floor(v.length * 0.25)], high: v[Math.floor(v.length * 0.75)] };
  }

  /**
   * Collapse parcels that share one footprint — condominium units, air-rights
   * lots, parking stalls under a tower — into a single parcel so a large
   * commercial building gets one label, not fifty. Footprints match when the
   * centroids are within 1.5 m and the areas within 5%. The survivor keeps the
   * summed value, a `units` list for the detail sheet, and the first address
   * with the unit suffix stripped.
   */
  function groupStacked(parcels) {
    const byKey = new Map();
    for (const p of parcels) {
      const c = p.centroid; if (!c) continue;
      const key = `${Math.round(c.lat * 40000)}:${Math.round(c.lon * 40000)}`;   // ~2.5 m cells; neighbours checked below
      let group = null;
      for (const k of [key, ...neighbours(key)]) { const g = byKey.get(k); if (g && sameFootprint(g[0], p)) { group = g; break; } }
      if (group) group.push(p); else byKey.set(key, [p]);
    }
    const out = [];
    for (const g of byKey.values()) {
      if (g.length === 1) { out.push(g[0]); continue; }
      const base = g.reduce((a, b) => ((b.totalValue || 0) > (a.totalValue || 0) ? b : a), g[0]);
      const merged = { ...base,
        address: base.address ? base.address.replace(/\s+(UNIT|#|APT|STE|SUITE)\s*\S+$/i, "") : base.address,
        landValue: g.reduce((s, p) => s + (p.landValue || 0), 0),
        imprValue: g.reduce((s, p) => s + (p.imprValue || 0), 0),
        units: g.map((p) => ({ id: p.id, address: p.address, use: p.use, totalValue: p.totalValue, lastSale: p.lastSale })).sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0)),
        sales: g.flatMap((p) => p.sales || []).sort((x, y) => (y.date || 0) - (x.date || 0)),
      };
      merged.totalValue = merged.landValue + merged.imprValue;
      merged.lastSale = merged.sales.find((s) => s.price > 0) || null;
      if (g.some((p) => p.propType === "K")) { merged.propType = "K"; merged.propTypeName = PROP_TYPES.K; }
      out.push(merged);
    }
    return out;
  }
  function neighbours(key) { const [a, b] = key.split(":").map(Number); const n = []; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) if (i || j) n.push(`${a + i}:${b + j}`); return n; }
  function sameFootprint(a, b) {
    if (Geo.haversine(a.centroid.lat, a.centroid.lon, b.centroid.lat, b.centroid.lon) > 1.5) return false;
    const x = a.centroid.areaM2, y = b.centroid.areaM2;
    return Math.abs(x - y) <= 0.05 * Math.max(x, y, 1);
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
    const out = [];
    let offset = 0, exceeded = false, pages = 0;
    // page through dense areas (downtown cores exceed 1000 parcels in 260 m) where the server supports it
    for (;;) {
      const params = arcgisParams(lat, lon, radiusM, provider.parcels.outFields, true, offset, provider.parcels.generalize);
      const data = await arcgisQuery(provider.parcels.url, params, fetchImpl);
      const feats = data.features || [];
      for (const f of feats) { const p = normalizeParcel(f, provider); if (p) out.push(p); }
      pages++;
      exceeded = !!data.exceededTransferLimit;
      if (!exceeded || provider.parcels.paging === false || pages >= PAGE_LIMIT || !feats.length) break;
      offset += feats.length;
    }
    return { parcels: out, exceeded, pages };
  }

  async function querySales(provider, lat, lon, radiusM, fetchImpl) {
    if (!provider.sales) return [];
    const params = arcgisParams(lat, lon, radiusM, provider.sales.outFields, false);
    const data = await arcgisQuery(provider.sales.url, params, fetchImpl);
    return (data.features || []).map((f) => normalizeSale(f, provider));
  }

  /**
   * One round trip for the app: parcels + sales, joined. When a county's own
   * server errors (Snohomish's joined view goes down for stretches), the
   * statewide layer answers instead — coarser attributes, same footprints — and
   * the result says which provider actually served it.
   */
  async function fetchArea(provider, lat, lon, radiusM, fetchImpl) {
    let pr, used = provider;
    try { pr = await queryParcels(provider, lat, lon, radiusM, fetchImpl); }
    catch (e) {
      const fb = provider.fallback && PROVIDERS[provider.fallback];
      if (!fb) throw e;
      pr = await queryParcels(fb, lat, lon, radiusM, fetchImpl); used = fb; pr.fellBackFrom = provider.id;
    }
    // sales: for Prop 13 counties widen the circle so a comps estimate has enough arm's-length sales
    const sales = used.sales ? await querySales(used, lat, lon, used.prop13 ? Math.max(radiusM * 2, 500) : radiusM, fetchImpl).catch(() => []) : [];
    const parcels = groupStacked(joinSales(pr.parcels, sales));
    if (used.prop13) {
      const comps = compsPerSqft(sales, { years: 4 });
      for (const p of parcels) { p.comps = comps; if (comps && p.livingSqft > 0) p.marketEstimate = Math.round(comps.psf * p.livingSqft); }
    }
    return { parcels, exceeded: pr.exceeded, pages: pr.pages, salesCount: sales.length, provider: used, fellBackFrom: pr.fellBackFrom || null };
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

  return { PROVIDERS, PROP_TYPES, WA_DOR_USE, MAX_OFFSET_DEG, dorType, typeFromUse, providerFor, groupStacked, compsPerSqft, onBytes, meter, arcgisParams, normalizeParcel, normalizeSale, joinSales, queryParcels, querySales, fetchArea, reverseGeocode };
}));

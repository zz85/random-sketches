/*
 * market.js - what a unit in this building is worth, and what it rents for.
 *
 * Two bundled datasets (refreshed by fetch_data.js, loaded lazily):
 *
 *   data/kc_apartments.json  King County Assessor apartment complexes by PIN:
 *                            units, average unit ft², storeys, year built,
 *                            bedroom mix. Turns a $125M assessed value into
 *                            "$592K per unit, 211 units, 799 ft² average".
 *   data/wa_zip_market.json  Zillow Research by WA ZIP: typical asking rent
 *                            (ZORI), typical condo value and typical home value
 *                            (ZHVI), last 13 months.
 *
 * Nothing here is a listing price. The assessed value is the county's estimate
 * of market value on 1 January of the assessment year; Zillow's indices are
 * smoothed ZIP-wide typical values for the latest month. The rent estimate for a
 * specific unit is the ZIP typical rent scaled by the unit's size relative to a
 * typical rental (a mild 0.6 exponent: rent per ft² falls as units get bigger),
 * and by the building's age. It is labelled as an estimate everywhere.
 *
 * Browser global (window.Market) or CommonJS module.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Market = factory();
}(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TYPICAL_RENTAL_SQFT = 850;    // ZORI covers SFR + condo + multifamily; a typical unit in that mix
  const SIZE_EXPONENT = 0.6;          // rent ∝ size^0.6 : a 425 ft² studio rents ~66% of an 850 ft² 1-2BR, not 50%
  const AGE_FACTOR = (yearBuilt, now) => {  // newer buildings command a premium over the ZIP typical
    if (!yearBuilt) return 1;
    const age = Math.max(0, (now || new Date().getFullYear()) - yearBuilt);
    return age < 5 ? 1.18 : age < 15 ? 1.08 : age < 40 ? 1.0 : 0.92;
  };

  const state = { apts: null, zips: null, loading: {} };

  async function load(kind, fetchImpl, base) {
    if (state[kind]) return state[kind];
    if (state.loading[kind]) return state.loading[kind];
    const f = fetchImpl || fetch;
    const url = (base || "") + (kind === "apts" ? "data/kc_apartments.json" : "data/wa_zip_market.json");
    state.loading[kind] = f(url).then((r) => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }).then((d) => { state[kind] = d; return d; }).finally(() => { delete state.loading[kind]; });
    return state.loading[kind];
  }
  /** Inject datasets directly (tests, or when the app already has them). */
  function set(kind, data) { state[kind] = data; }

  /** King County apartment complex record for a PIN, or null. */
  function apartment(pin) {
    const a = state.apts; if (!a || !pin) return null;
    const r = a.byPin[pin]; if (!r) return null;
    const [units, avgUnitSqft, stories, yearBuilt, buildings, elevator, beds0] = r;
    let beds = beds0 || null;
    if (beds && beds["0"]) { beds = { ...beds, S: (beds.S || 0) + beds["0"] }; delete beds["0"]; }   // the assessor codes studios as 0 or S
    return { units, avgUnitSqft: avgUnitSqft || null, stories: stories || null, yearBuilt: yearBuilt || null, buildings, elevator: !!elevator, bedroomMix: beds, source: a.source, fetched: a.fetched };
  }

  /** Zillow ZIP row -> {rent, condo, home} each {value, yearAgo, change} for the latest month with data. */
  function zip(zipCode) {
    const z = state.zips; if (!z || !zipCode) return null;
    const row = z.byZip[String(zipCode).slice(0, 5)]; if (!row) return null;
    const pick = (arr) => {
      if (!arr) return null;
      let i = arr.length - 1; while (i >= 0 && arr[i] == null) i--;
      if (i < 0) return null;
      const yearAgo = i - 12 >= 0 ? arr[i - 12] : null;
      return { value: arr[i], yearAgo, change: yearAgo ? (arr[i] - yearAgo) / yearAgo : null, monthsBack: arr.length - 1 - i };
    };
    return { city: row.city, county: row.county, rent: pick(row.rent), condo: pick(row.condo), home: pick(row.home), asOf: z.asOf, source: z.source };
  }

  /** Rent estimate for a unit of `sqft` in a building of `yearBuilt` in `zipCode`, or null. */
  function estimateRent(zipCode, sqft, yearBuilt, now) {
    const z = zip(zipCode); if (!z || !z.rent) return null;
    const size = sqft > 0 ? Math.pow(sqft / TYPICAL_RENTAL_SQFT, SIZE_EXPONENT) : 1;
    return { monthly: Math.round(z.rent.value * size * AGE_FACTOR(yearBuilt, now) / 10) * 10, zipTypical: z.rent.value, asOf: z.asOf };
  }

  /**
   * Everything the detail sheet wants for one parcel. `p` is a normalised parcel
   * (id, zip, totalValue, imprValue, units[] for stacked condos, storeys/height).
   */
  function summary(p, now) {
    const out = { kind: null };
    const apt = apartment(p.id);
    const z = zip(p.zip);
    if (apt) {
      out.kind = "apartment"; out.apt = apt;
      out.perUnit = p.totalValue > 0 ? Math.round(p.totalValue / apt.units) : null;
      out.perSqft = p.totalValue > 0 && apt.avgUnitSqft ? Math.round(p.totalValue / (apt.units * apt.avgUnitSqft)) : null;
      out.rent = estimateRent(p.zip, apt.avgUnitSqft, apt.yearBuilt, now);
      if (out.rent && out.perUnit) out.grossYield = (out.rent.monthly * 12) / out.perUnit;
      if (apt.bedroomMix) {
        out.mix = Object.entries(apt.bedroomMix).sort((a, b) => (a[0] === "S" ? -1 : b[0] === "S" ? 1 : +a[0] - +b[0])).map(([k, n]) => `${n} × ${k === "S" || k === "0" ? "studio" : k + "BR"}`);
      }
    } else if (p.units && p.units.length > 1) {
      // stacked condo units: the assessor values each unit, so the average is direct
      const valued = p.units.filter((u) => u.totalValue > 0);
      out.kind = "condo"; out.unitCount = p.units.length;
      out.perUnit = valued.length ? Math.round(valued.reduce((s, u) => s + u.totalValue, 0) / valued.length) : null;
      out.rent = estimateRent(p.zip, null, null, now);
    }
    if (z) out.zip = z;
    return out;
  }

  return { load, set, apartment, zip, estimateRent, summary, TYPICAL_RENTAL_SQFT, SIZE_EXPONENT, AGE_FACTOR, state };
}));

// bun fetch_data.js
// Refreshes the bundled market/unit datasets in data/. Run occasionally; the
// app itself never hits these hosts (the assessor zips have no CORS and the
// Zillow CSVs are 10-120 MB), it just loads the small JSON this writes.
//
//   data/kc_apartments.json   King County Assessor "Apartment Complex" + "Unit Breakdown"
//                             extracts (nightly, public): per parcel PIN -> units, avg unit
//                             ft², storeys, year built, bedroom mix. ~9k complexes.
//   data/wa_zip_market.json   Zillow Research public CSVs, Washington ZIPs only:
//                             ZORI typical asking rent, ZHVI typical condo value and
//                             typical all-homes value, last 13 months + 1y change.
//
// Sources
//   https://aqua.kingcounty.gov/extranet/assessor/Apartment%20Complex.zip
//   https://aqua.kingcounty.gov/extranet/assessor/Unit%20Breakdown.zip
//   https://www.zillow.com/research/data/   (ZORI: All Homes Plus Multifamily, smoothed; ZHVI: Condo/Co-op and All Homes, mid tier)
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const OUT = path.join(__dirname, "data");
fs.mkdirSync(OUT, { recursive: true });
const UA = { headers: { "User-Agent": "Mozilla/5.0 (estate-ar data refresh)" } };

async function get(url) { const r = await fetch(url, UA); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r; }

/** Minimal CSV parser (quoted fields, no embedded newlines). */
function parseCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
    }
    out.push(cur); rows.push(out);
  }
  return rows;
}

async function unzipCSV(url, tmpName) {
  const buf = Buffer.from(await (await get(url)).arrayBuffer());
  const zip = path.join("/tmp", tmpName + ".zip"), dir = path.join("/tmp", tmpName);
  fs.writeFileSync(zip, buf); fs.rmSync(dir, { recursive: true, force: true });
  execSync(`unzip -o -q "${zip}" -d "${dir}"`);
  const csv = fs.readdirSync(dir).find((f) => /\.csv$/i.test(f));
  return fs.readFileSync(path.join(dir, csv), "latin1");
}

async function kingApartments() {
  const apt = parseCSV(await unzipCSV("https://aqua.kingcounty.gov/extranet/assessor/Apartment%20Complex.zip", "kc_apt"));
  const ub = parseCSV(await unzipCSV("https://aqua.kingcounty.gov/extranet/assessor/Unit%20Breakdown.zip", "kc_ub"));
  const ah = apt[0], uh = ub[0];
  const col = (h, n) => { const i = h.indexOf(n); if (i < 0) throw new Error("missing column " + n); return i; };
  const A = { major: col(ah, "Major"), minor: col(ah, "Minor"), bldgs: col(ah, "NbrBldgs"), stories: col(ah, "NbrStories"), units: col(ah, "NbrUnits"), avg: col(ah, "AvgUnitSize"), yr: col(ah, "YrBuilt"), eff: col(ah, "EffYr"), elev: col(ah, "Elevators"), descr: col(ah, "ComplexDescr") };
  const U = { major: col(uh, "Major"), minor: col(uh, "Minor"), n: col(uh, "NbrThisType"), sqft: col(uh, "SqFt"), bed: col(uh, "NbrBedrooms"), bath: col(uh, "NbrBaths") };
  // bedroom mix per PIN: {S: n, 1: n, 2: n, ...} plus size-weighted average
  const mix = new Map();
  for (const r of ub.slice(1)) {
    const pin = r[U.major].padStart(6, "0") + r[U.minor].padStart(4, "0");
    const m = mix.get(pin) || (mix.set(pin, { beds: {}, sqftSum: 0, n: 0 }), mix.get(pin));
    const n = +r[U.n] || 0, sq = +r[U.sqft] || 0, bed = r[U.bed] === "S" ? "S" : String(parseInt(r[U.bed], 10) || 0);
    m.beds[bed] = (m.beds[bed] || 0) + n; m.sqftSum += n * sq; m.n += n;
  }
  const out = {};
  for (const r of apt.slice(1)) {
    const pin = r[A.major].padStart(6, "0") + r[A.minor].padStart(4, "0");
    const units = +r[A.units] || 0; if (!units) continue;
    const m = mix.get(pin);
    const rec = [units, +r[A.avg] || (m && m.n ? Math.round(m.sqftSum / m.n) : 0), +r[A.stories] || 0, +r[A.yr] || 0, +r[A.bldgs] || 1, r[A.elev] === "Y" ? 1 : 0];
    if (m) rec.push(m.beds);
    out[pin] = rec;
  }
  const doc = { source: "King County Assessor, Apartment Complex + Unit Breakdown extracts", fetched: new Date().toISOString().slice(0, 10), fields: ["units", "avgUnitSqft", "stories", "yearBuilt", "buildings", "elevator", "bedroomMix{S,1,2,3..}"], byPin: out };
  fs.writeFileSync(path.join(OUT, "kc_apartments.json"), JSON.stringify(doc));
  console.log(`kc_apartments.json: ${Object.keys(out).length} complexes, ${(fs.statSync(path.join(OUT, "kc_apartments.json")).size / 1024).toFixed(0)} KB`);
}

async function zillowWA() {
  const series = {
    rent: "https://files.zillowstatic.com/research/public_csvs/zori/Zip_zori_uc_sfrcondomfr_sm_month.csv",
    condo: "https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_condo_tier_0.33_0.67_sm_sa_month.csv",
    home: "https://files.zillowstatic.com/research/public_csvs/zhvi/Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
  };
  const STATES = new Set(["WA", "CA"]);   // the states with providers; add here when adding a county
  const byZip = {}; let asOf = null;
  for (const [key, url] of Object.entries(series)) {
    const rows = parseCSV(await (await get(url)).text());
    const h = rows[0], zipI = h.indexOf("RegionName"), stI = h.indexOf("State"), cityI = h.indexOf("City"), cntyI = h.indexOf("CountyName");
    const months = h.slice(9); asOf = months[months.length - 1];
    for (const r of rows.slice(1)) {
      if (!STATES.has(r[stI])) continue;
      const vals = r.slice(9).map((v) => (v === "" ? null : Math.round(+v)));
      // last 13 months, so the app can show a 1-year change
      const last13 = vals.slice(-13);
      if (last13.every((v) => v == null)) continue;
      const z = byZip[r[zipI]] || (byZip[r[zipI]] = { state: r[stI], city: r[cityI], county: (r[cntyI] || "").replace(/ County$/, "") });
      z[key] = last13;
    }
  }
  // one file per state so a user only downloads their own (~100 KB WA, ~400 KB CA)
  for (const st of STATES) {
    const sub = {}; for (const [zip, row] of Object.entries(byZip)) if (row.state === st) { const { state, ...rest } = row; sub[zip] = rest; }
    const doc = { source: "Zillow Research (ZORI all homes + multifamily smoothed; ZHVI condo/co-op mid-tier; ZHVI all homes mid-tier)", state: st, asOf, months: 13, fetched: new Date().toISOString().slice(0, 10), byZip: sub };
    const name = `zip_market_${st.toLowerCase()}.json`;
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(doc));
    console.log(`${name}: ${Object.keys(sub).length} ZIPs, as of ${asOf}, ${(fs.statSync(path.join(OUT, name)).size / 1024).toFixed(0)} KB`);
  }
  try { fs.unlinkSync(path.join(OUT, "wa_zip_market.json")); } catch (e) { /* old name */ }
}

(async () => {
  await kingApartments();
  await zillowWA();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });

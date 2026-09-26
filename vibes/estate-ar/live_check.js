// bun live_check.js [lat lon [radius_m]]     one point (default: Brooklyn Ave NE, U-District)
// bun live_check.js --all                    one point per provider (Seattle, Everett, Tacoma)
// Live smoke test against the county ArcGIS services and Nominatim — the same
// calls the browser makes.
const Geo = require("./geo.js");
const P = require("./providers.js");

const POINTS = { kingcounty: [47.6625, -122.3145], snohomish: [47.9790, -122.2021], wastate: [47.2529, -122.4390] };

async function check(lat, lon, radius) {
  const prov = P.providerFor(lat, lon);
  if (!prov) { console.error(`No provider covers ${lat},${lon}`); process.exit(2); }
  console.log(`Provider: ${prov.name}   point: ${lat},${lon}   radius: ${radius} m`);

  let t = Date.now();
  const r = await P.fetchArea(prov, lat, lon, radius);
  console.log(`fetchArea: ${r.parcels.length} parcels, ${r.salesCount} sales, exceeded=${r.exceeded}, ${Date.now() - t} ms`);
  if (!r.parcels.length) { console.error("FAIL: no parcels returned"); process.exit(1); }

  t = Date.now();
  const g = await P.reverseGeocode(lat, lon).catch((e) => ({ error: e.message }));
  console.log(`Nominatim: ${g.error || [g.city, g.neighbourhood, g.road].filter(Boolean).join(" · ")} (${Date.now() - t} ms)`);

  const rows = r.parcels.map((p) => ({ p, v: Geo.parcelView(lat, lon, p.ring, p.centroid) })).sort((a, b) => a.v.nearest - b.v.nearest);
  const inside = rows.filter((x) => x.v.inside);
  console.log(`Standing on: ${inside.map((x) => x.p.address || x.p.id).join(", ") || "(no parcel — street/ROW)"}\n`);
  console.log("nearest".padEnd(8), "brg".padEnd(5), "span".padEnd(6), "assessed".padEnd(9), "last sale".padEnd(18), "address / use");
  for (const { p, v } of rows.slice(0, 15)) {
    const sale = p.lastSale ? `${Geo.fmtMoney(p.lastSale.price, true)} ${p.lastSale.date.toISOString().slice(0, 7)}` : "";
    console.log(String(Math.round(v.nearest) + "m").padEnd(8), String(Math.round(v.bearing)).padEnd(5), (v.spanDeg.toFixed(0) + "°").padEnd(6), Geo.fmtMoney(p.totalValue, true).padEnd(9), sale.padEnd(18), `${p.address || "(no addr)"} · ${p.use || ""}`);
  }
  const bad = r.parcels.filter((p) => !p.centroid || !isFinite(p.centroid.lat) || p.ring.length < 4);
  const total = r.parcels.reduce((s, p) => s + (p.totalValue || 0), 0);
  console.log(`\nTotal assessed within ${radius} m: ${Geo.fmtMoney(total)}   malformed parcels: ${bad.length}`);
  if (bad.length) process.exit(1);
  console.log("OK\n");
}

(async () => {
  if (process.argv[2] === "--all") { for (const [id, [la, lo]] of Object.entries(POINTS)) { console.log(`##### ${id}`); await check(la, lo, 120); } return; }
  const lat = parseFloat(process.argv[2] || "47.6625"), lon = parseFloat(process.argv[3] || "-122.3145");
  await check(lat, lon, parseFloat(process.argv[4] || "150"));
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });

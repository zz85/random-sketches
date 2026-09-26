// bun test  (run from vibes/estate-ar)
const { test, expect, describe } = require("bun:test");
const Geo = require("./geo.js");
const P = require("./providers.js");
const H = require("./heights.js");
const PS = require("./parcelstore.js");
const M = require("./market.js");
const parcelsFx = require("./fixture_parcels.json");   // live King County response, 120 m around ME
const salesFx = require("./fixture_sales.json");       // live sales layer, 250 m around ME

const ME = { lat: 47.6625, lon: -122.3145 };            // Brooklyn Ave NE, U-District
const KC = P.PROVIDERS.kingcounty;

describe("Geo: angles", () => {
  test("wrap360 and angleDiff", () => {
    expect(Geo.wrap360(-10)).toBe(350);
    expect(Geo.wrap360(725)).toBe(5);
    expect(Geo.angleDiff(10, 350)).toBe(20);
    expect(Geo.angleDiff(350, 10)).toBe(-20);
    expect(Geo.angleDiff(180, 0)).toBe(180);
    expect(Geo.angleDiff(0, 180)).toBe(180);   // (-180,180] convention
  });
  test("smoothHeading crosses north the short way", () => {
    expect(Geo.smoothHeading(350, 10, 0.5)).toBe(0);
    expect(Geo.smoothHeading(10, 350, 0.5)).toBe(0);
    expect(Geo.smoothHeading(null, 123)).toBe(123);
  });
  test("cardinal", () => {
    expect(Geo.cardinal(0)).toBe("N"); expect(Geo.cardinal(359)).toBe("N");
    expect(Geo.cardinal(90)).toBe("E"); expect(Geo.cardinal(202)).toBe("SSW");
  });
});

describe("Geo: distance and bearing", () => {
  test("haversine: Seattle to Portland ≈ 234 km", () => {
    expect(Geo.haversine(47.6062, -122.3321, 45.5152, -122.6784) / 1000).toBeCloseTo(234.0, 0);
  });
  test("bearing: due north / due east / round trip", () => {
    expect(Geo.bearing(47, -122, 48, -122)).toBeCloseTo(0, 6);
    expect(Geo.bearing(47, -122, 47, -121)).toBeCloseTo(89.6, 0);   // slightly north of east on a sphere
    expect(Geo.bearing(47.6062, -122.3321, 45.5152, -122.6784)).toBeCloseTo(186.4, 0);
  });
  test("metresPerDegree at 47.66°", () => {
    const m = Geo.metresPerDegree(47.66);
    expect(m.lat).toBeCloseTo(111180, -2); expect(m.lon).toBeCloseTo(74870, -2);
  });
  test("mercToLatLon", () => {
    const p = Geo.mercToLatLon(-13616000, 6046000);
    expect(p.lon).toBeCloseTo(-122.31, 1); expect(p.lat).toBeCloseTo(47.66, 1);
  });
});

describe("Geo: polygons", () => {
  // 100 m x 50 m rectangle, corner at ME
  const mpd = Geo.metresPerDegree(ME.lat);
  const rect = [[ME.lon, ME.lat], [ME.lon + 100 / mpd.lon, ME.lat], [ME.lon + 100 / mpd.lon, ME.lat + 50 / mpd.lat], [ME.lon, ME.lat + 50 / mpd.lat], [ME.lon, ME.lat]];

  test("ringCentroid area and centre of a rectangle", () => {
    const c = Geo.ringCentroid(rect);
    expect(c.areaM2).toBeCloseTo(5000, -1);
    expect(Geo.haversine(c.lat, c.lon, ME.lat + 25 / mpd.lat, ME.lon + 50 / mpd.lon)).toBeLessThan(0.05);
  });
  test("ringCentroid is orientation-independent and handles degenerate rings", () => {
    const rev = rect.slice().reverse();
    expect(Geo.ringCentroid(rev).lat).toBeCloseTo(Geo.ringCentroid(rect).lat, 9);
    const line = Geo.ringCentroid([[0, 0], [1, 0]]);
    expect(line.areaM2).toBe(0); expect(line.lon).toBeCloseTo(0.5, 9);
    expect(Geo.ringCentroid([])).toBeNull();
  });
  test("outerRing picks the largest ring", () => {
    const hole = [[ME.lon + 40 / mpd.lon, ME.lat + 20 / mpd.lat], [ME.lon + 60 / mpd.lon, ME.lat + 20 / mpd.lat], [ME.lon + 60 / mpd.lon, ME.lat + 30 / mpd.lat], [ME.lon + 40 / mpd.lon, ME.lat + 20 / mpd.lat]];
    expect(Geo.outerRing([hole, rect])).toBe(rect);
    expect(Geo.outerRing(null)).toBeNull();
  });
  test("pointInRing", () => {
    expect(Geo.pointInRing(ME.lat + 10 / mpd.lat, ME.lon + 10 / mpd.lon, rect)).toBe(true);
    expect(Geo.pointInRing(ME.lat - 1 / mpd.lat, ME.lon + 10 / mpd.lon, rect)).toBe(false);
  });
  test("parcelView from 100 m south of the rectangle", () => {
    const v = Geo.parcelView(ME.lat - 100 / mpd.lat, ME.lon + 50 / mpd.lon, rect);
    expect(v.bearing).toBeCloseTo(0, 0);
    expect(v.distance).toBeCloseTo(125, 0);
    expect(v.nearest).toBeCloseTo(Math.hypot(100, 50), 0);
    // corners at ±50 m across, 100 m and 150 m away -> span = 2*atan(50/100) ≈ 53°
    expect(v.spanDeg).toBeCloseTo(53.1, 0);
    expect(v.inside).toBe(false);
  });
  test("parcelView spanning north (bearing wrap) does not blow up", () => {
    const v = Geo.parcelView(ME.lat - 20 / mpd.lat, ME.lon + 50 / mpd.lon, rect);
    expect(v.spanDeg).toBeGreaterThan(100); expect(v.spanDeg).toBeLessThan(180);
    expect(Math.abs(Geo.angleDiff(v.bearing, 0))).toBeLessThan(1);
  });
});

describe("Geo: planar frame", () => {
  const parcels = parcelsFx.features.map((f) => P.normalizeParcel(f, KC));
  const F = Geo.frame(ME.lat, ME.lon);
  test("parcelViewXY agrees with parcelView on real rings", () => {
    const [vx, vy] = F.toXY(ME.lon + 0.0012, ME.lat - 0.0008);   // viewer ~130 m away
    for (const p of parcels) {
      const a = Geo.parcelView(ME.lat - 0.0008, ME.lon + 0.0012, p.ring, p.centroid);
      const xy = p.ring.map(([lon, lat]) => F.toXY(lon, lat)), [cx, cy] = F.toXY(p.centroid.lon, p.centroid.lat);
      const b = Geo.parcelViewXY(vx, vy, xy, cx, cy);
      expect(Math.abs(Geo.angleDiff(a.bearing, b.bearing))).toBeLessThan(0.05);
      expect(b.distance).toBeCloseTo(a.distance, 0); expect(b.nearest).toBeCloseTo(a.nearest, 0);
      expect(b.spanDeg).toBeCloseTo(a.spanDeg, 0); expect(b.inside).toBe(a.inside);
      expect(b.spanHi - b.spanLo).toBeCloseTo(b.spanDeg, 6);
    }
  });
  test("inside test at the fixture point", () => {
    const [vx, vy] = [0, 0];
    const inside = parcels.filter((p) => Geo.parcelViewXY(vx, vy, p.ring.map(([lon, lat]) => F.toXY(lon, lat)), ...F.toXY(p.centroid.lon, p.centroid.lat)).inside);
    expect(inside.map((p) => p.address)).toEqual(["4541 BROOKLYN AVE NE"]);
  });
  test("decimate drops curb-arc vertices but keeps corners", () => {
    const sq = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    expect(Geo.decimate(sq, 0.5)).toEqual(sq);
    const dense = []; for (let i = 0; i <= 40; i++) dense.push([i * 0.25, 0]); dense.push([10, 10], [0, 10], [0, 0]);   // 41 collinear points on one edge
    const d = Geo.decimate(dense, 0.3);
    expect(d.length).toBe(5); expect(d[0]).toEqual([0, 0]); expect(d[1]).toEqual([10, 0]);
    const tri = [[0, 0], [1, 0], [0, 1]]; expect(Geo.decimate(tri, 5)).toBe(tri);
    const total = parcels.reduce((s, p) => s + p.ring.length, 0), after = parcels.reduce((s, p) => s + Geo.decimate(p.ring.map(([lon, lat]) => F.toXY(lon, lat)), 0.4).length, 0);
    expect(after).toBeLessThan(total * 0.6);   // the un-generalised fixture loses most of its vertices
  });
});

describe("Geo: projection", () => {
  const W = 390, H = 844, FOV = 60;
  test("centre, edges, out of frustum", () => {
    const c = Geo.project(90, 0, 90, 0, FOV, W, H, 0);
    expect(c.x).toBeCloseTo(W / 2, 6); expect(c.y).toBeCloseTo(H / 2, 6);
    const r = Geo.project(120, 0, 90, 0, FOV, W, H, 0);
    expect(r.x).toBeCloseTo(W, 6);
    const l = Geo.project(60, 0, 90, 0, FOV, W, H, 0);
    expect(l.x).toBeCloseTo(0, 6);
    expect(Geo.project(125, 0, 90, 0, FOV, W, H, 0)).toBeNull();
    expect(Geo.project(125, 0, 90, 0, FOV, W, H, 10)).not.toBeNull();   // margin
  });
  test("wraps across north; pitch moves y", () => {
    const p = Geo.project(5, 0, 355, 0, FOV, W, H, 0);
    expect(p.dx).toBeCloseTo(10, 9); expect(p.x).toBeGreaterThan(W / 2);
    const up = Geo.project(0, 10, 0, 0, FOV, W, H, 0);
    expect(up.y).toBeLessThan(H / 2);
    const down = Geo.project(0, 0, 0, 20, FOV, W, H, 0);   // camera tilted up -> horizon drops
    expect(down.y).toBeGreaterThan(H / 2);
  });
  test("pitchTo", () => {
    expect(Geo.pitchTo(100, 100)).toBeCloseTo(45, 9);
    expect(Geo.pitchTo(10, -1.6)).toBeCloseTo(-9.09, 1);
  });
});

describe("Geo: clipPolygon / viewWedge", () => {
  const sq = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
  test("wedge heading north keeps a triangle ahead", () => {
    const out = Geo.clipPolygon(sq, Geo.viewWedge(0, 45, 1.5));
    expect(out.length).toBeGreaterThanOrEqual(3);
    for (const [x, y] of out) { expect(y).toBeGreaterThanOrEqual(1.5 - 1e-9); expect(Math.abs(x)).toBeLessThanOrEqual(y + 1e-9); }
  });
  test("wedge membership at several headings", () => {
    const inside = (h, x, y) => Geo.viewWedge(h, 45, 0.5).every((pl) => pl.nx * x + pl.ny * y >= pl.d);
    expect(inside(0, 0, 5)).toBe(true); expect(inside(0, 5, 0)).toBe(false); expect(inside(0, 0, -5)).toBe(false);
    expect(inside(90, 5, 0)).toBe(true); expect(inside(90, 0, 5)).toBe(false);
    expect(inside(180, 0, -5)).toBe(true); expect(inside(270, -5, 0)).toBe(true); expect(inside(270, 5, 0)).toBe(false);
    expect(inside(350, -1, 5)).toBe(true); expect(inside(350, 3, 5)).toBe(true);   // bearing 31°, 41° off a 350° heading: wraps across north
  });
  test("polygon entirely behind the camera clips to nothing", () => {
    expect(Geo.clipPolygon([[-1, -5], [1, -5], [0, -8]], Geo.viewWedge(0, 45, 0.5))).toEqual([]);
  });
});

describe("Geo: formatting", () => {
  test("fmtMoney", () => {
    expect(Geo.fmtMoney(2929000)).toBe("$2,929,000");
    expect(Geo.fmtMoney(2929000, true)).toBe("$2.93M");
    expect(Geo.fmtMoney(116422000, true)).toBe("$116M");
    expect(Geo.fmtMoney(1500000000, true)).toBe("$1.5B");
    expect(Geo.fmtMoney(850000, true)).toBe("$850K");
    expect(Geo.fmtMoney(null)).toBe("—");
  });
  test("fmtDistance", () => {
    expect(Geo.fmtDistance(100, true)).toBe("328 ft");
    expect(Geo.fmtDistance(2000, true)).toBe("1.2 mi");
    expect(Geo.fmtDistance(999, false)).toBe("999 m");
    expect(Geo.fmtDistance(1500, false)).toBe("1.5 km");
  });
});

describe("Providers: King County parsing (live fixture)", () => {
  const parcels = parcelsFx.features.map((f) => P.normalizeParcel(f, KC)).filter(Boolean);
  const sales = salesFx.features.map((f) => P.normalizeSale(f, KC));
  P.joinSales(parcels, sales);

  test("fixture shape", () => {
    expect(parcelsFx.features.length).toBe(43);
    expect(parcels.length).toBe(43);
    expect(sales.length).toBe(19);
  });
  test("normalized parcel fields", () => {
    const p = parcels.find((q) => q.address === "4541 BROOKLYN AVE NE");
    expect(p.id).toBe("8817400020");
    expect(p.city).toBe("Seattle"); expect(p.zip).toBe("98105");
    expect(p.landValue).toBe(2437500); expect(p.imprValue).toBe(491500); expect(p.totalValue).toBe(2929000);
    expect(p.use).toBe("Apartment");                 // trailing whitespace stripped
    expect(p.propType).toBe("C"); expect(p.propTypeName).toBe("Commercial");
    expect(p.zoning).toBe("SM-U 95-320 (M1)");
    expect(p.ring.length).toBe(58); expect(p.ring[0].length).toBe(2);
    expect(p.centroid.lat).toBeCloseTo(47.6625, 3); expect(p.centroid.lon).toBeCloseTo(-122.3146, 3);
    expect(p.centroid.areaM2).toBeGreaterThan(300); expect(p.centroid.areaM2).toBeLessThan(500);
  });
  test("null address stays null, values numeric", () => {
    const p = parcels.find((q) => q.id === "8817400015");
    expect(p.address).toBeNull(); expect(p.use).toBe("Parking(Commercial Lot)");
    for (const q of parcels) { expect(typeof q.totalValue).toBe("number"); expect(q.ring.length).toBeGreaterThan(3); }
  });
  test("the fixture point is inside exactly one parcel", () => {
    const inside = parcels.filter((p) => Geo.parcelView(ME.lat, ME.lon, p.ring, p.centroid).inside);
    expect(inside.map((p) => p.address)).toEqual(["4541 BROOKLYN AVE NE"]);
  });
  test("every parcel is within the 120 m query circle (nearest vertex)", () => {
    for (const p of parcels) expect(Geo.parcelView(ME.lat, ME.lon, p.ring, p.centroid).nearest).toBeLessThan(125);
  });
  test("sales: epoch ms -> Date, join by PIN, zero-dollar transfers skipped for lastSale", () => {
    const s = sales.find((x) => x.id === "8823902320");
    expect(s.date.toISOString().slice(0, 10)).toBe("2023-10-11"); expect(s.price).toBe(1065000);
    const withSales = parcels.filter((p) => p.sales.length);
    expect(withSales.length).toBe(6);
    const p = parcels.find((q) => q.id === "8817400005");   // 4557 Brooklyn: one $0 transfer only
    expect(p.sales.length).toBe(1); expect(p.sales[0].price).toBe(0); expect(p.lastSale).toBeNull();
    const sold = parcels.find((q) => q.lastSale);
    expect(sold.lastSale.price).toBeGreaterThan(0);
    for (const q of withSales) for (let i = 1; i < q.sales.length; i++) expect(q.sales[i - 1].date >= q.sales[i].date).toBe(true);
  });
  test("normalizeParcel returns null without geometry", () => {
    expect(P.normalizeParcel({ attributes: { PIN: "x" } }, KC)).toBeNull();
  });
});

describe("Providers: Snohomish County (live fixture, Hewitt Ave, Everett)", () => {
  const SNO = P.PROVIDERS.snohomish, fx = require("./fixture_snohomish.json");
  const parcels = fx.features.map((f) => P.normalizeParcel(f, SNO)).filter(Boolean);
  test("qualified field names are mapped, use code prefix and -Real suffix stripped", () => {
    expect(parcels.length).toBe(16);
    const p = parcels.find((q) => q.id === "00439068800500");
    expect(p.address).toBe("2931 BROADWAY AVE"); expect(p.city).toBe("EVERETT"); expect(p.zip).toBe("98201");
    expect(p.use).toBe("Undeveloped (Vacant) Land");
    expect(p.landValue).toBe(324000); expect(p.imprValue).toBe(0); expect(p.totalValue).toBe(324000);
    expect(p.propType).toBe("U"); expect(p.propTypeName).toBe("Undeveloped");
    expect(p.lotSqft).toBeCloseTo(5561.6, 0); expect(p.acres).toBe(0.13);
    expect(p.link).toContain("snoco.org/proptax");
    expect(SNO.links["Assessor record"](p)).toBe(p.link);
  });
  test("typeFromUse buckets", () => {
    expect(P.typeFromUse("Single Family Residence")).toBe("R");
    expect(P.typeFromUse("Condominium Unit")).toBe("K");
    expect(P.typeFromUse("Eating Places (Restaurants)")).toBe("C");
    expect(P.typeFromUse("Church")).toBe("X");
    expect(P.typeFromUse(null)).toBeNull();
  });
});

describe("Providers: WA statewide layer (live fixture, Pacific Ave, Tacoma)", () => {
  const WA = P.PROVIDERS.wastate, fx = require("./fixture_wastate.json");
  const parcels = fx.features.map((f) => P.normalizeParcel(f, WA)).filter(Boolean);
  test("DOR codes decoded, county named, lot area derived from polygon", () => {
    expect(parcels.length).toBe(48);
    const p = parcels.find((q) => q.id === "053-9009560040");
    expect(p.address).toBe("1250 PACIFIC AVE"); expect(p.county).toBe("Pierce");
    expect(p.use).toBe("Condominium (non-res)"); expect(p.propType).toBe("C");
    expect(p.landValue).toBe(1092400); expect(p.imprValue).toBe(4466300); expect(p.totalValue).toBe(5558700);
    expect(p.lotSqft).toBeGreaterThan(0); expect(p.acres).toBeCloseTo(p.lotSqft / 43560, 6);
    expect(p.link).toContain("atip.piercecountywa.gov"); expect(p.asOf).toBe(1770969600000);
    const parking = parcels.find((q) => q.id === "053-2011050070");
    expect(parking.use).toBe("Parking"); expect(parking.propType).toBe("C");
  });
  test("dorType buckets", () => {
    expect(P.dorType(11)).toBe("R"); expect(P.dorType(14)).toBe("K"); expect(P.dorType(58)).toBe("C");
    expect(P.dorType(91)).toBe("U"); expect(P.dorType(83)).toBe("T"); expect(P.dorType(68)).toBe("X"); expect(P.dorType(null)).toBeNull();
  });
  test("providerFor: county-specific first, statewide fallback, nothing outside WA", () => {
    expect(P.providerFor(47.2529, -122.439).id).toBe("wastate");      // Tacoma
    expect(P.providerFor(47.32, -122.31).id).toBe("kingcounty");      // Federal Way
    expect(P.providerFor(47.755, -122.34).id).toBe("kingcounty");     // Shoreline
    expect(P.providerFor(47.82, -122.31).id).toBe("snohomish");       // Lynnwood
    expect(P.providerFor(48.75, -122.48).id).toBe("wastate");         // Bellingham
    expect(P.providerFor(45.5152, -122.6784)).toBeNull();             // Portland
  });
  test("fetchArea works for a provider without a sales layer", async () => {
    const fake = async () => ({ ok: true, text: async () => JSON.stringify(fx) });
    const r = await P.fetchArea(WA, 47.2529, -122.439, 100, fake);
    expect(r.parcels.length).toBe(42);   // 48 minus the stacked condo units expect(r.salesCount).toBe(0); expect(r.parcels[0].sales).toEqual([]);
  });
});

describe("Providers: Los Angeles County (live fixture, Calabasas)", () => {
  const LA = P.PROVIDERS.lacounty, fx = require("./fixture_la.json"), sfx = require("./fixture_la_sales.json");
  const parcels = fx.features.map((f) => P.normalizeParcel(f, LA)).filter(Boolean);
  const sales = sfx.features.map((f) => P.normalizeSale(f, LA));
  const NOW = Date.parse("2026-09-26");
  test("fields: address stripped of city/state/zip, home facts, Prop 13 base year", () => {
    const p = parcels.find((q) => q.id === "2069021021");
    expect(p.address).toBe("24513 PALERMO DR"); expect(p.city).toBe("CALABASAS"); expect(p.zip).toBe("91302");
    expect(p.use).toBe("Single family"); expect(p.propType).toBe("R");
    expect(p.landValue).toBe(343444); expect(p.imprValue).toBe(401829); expect(p.totalValue).toBe(745273);
    expect(p.taxYear).toBe(2026); expect(p.baseYear).toBe(2024);
    expect(p.livingSqft).toBe(2791); expect(p.bedrooms).toBe(3); expect(p.yearBuilt).toBe(1980); expect(p.unitCount).toBe(1);
    expect(p.lotSqft).toBeGreaterThan(10000); expect(p.lotSqft).toBeLessThan(16000);
    const golf = parcels.find((q) => q.id === "2069012068");
    expect(golf.use).toBe("Golf Courses (Recreational)"); expect(golf.propType).toBe("C");
    expect(LA.links["Assessor portal"](p)).toContain("portal.assessor.lacounty.gov/parceldetail/2069021021");
  });
  test("sales carry size, and compsPerSqft gives a median with an IQR", () => {
    expect(sales[0].sqft).toBe(3375); expect(sales[0].bedrooms).toBe(4); expect(sales[0].date.getFullYear()).toBe(2023);
    const c = P.compsPerSqft(sales, { years: 4, now: NOW });
    expect(c.n).toBe(5); expect(c.psf).toBeCloseTo(645, 0); expect(c.low).toBeLessThan(c.psf); expect(c.high).toBeGreaterThan(c.psf);
    expect(P.compsPerSqft(sales, { years: 1, now: NOW })).toBeNull();                 // too few recent
    expect(P.compsPerSqft(sales, { years: 4, now: NOW, type: "CND" })).toBeNull();
  });
  test("fetchArea (prop13) attaches comps and a market estimate per home, and widens the sales circle", async () => {
    const calls = [];
    const fake = async (url) => { calls.push(url); return { ok: true, text: async () => JSON.stringify(url.includes("pais_sales") ? sfx : fx) }; };
    const r = await P.fetchArea(LA, 34.145, -118.6615, 200, fake);
    const salesUrl = calls.find((u) => u.includes("pais_sales")); expect(new URL(salesUrl).searchParams.get("distance")).toBe("500");
    const p = r.parcels.find((q) => q.id === "2069021021");
    expect(p.comps.n).toBeGreaterThanOrEqual(3);
    expect(p.marketEstimate).toBeCloseTo(p.comps.psf * 2791, -3);
    expect(p.marketEstimate).toBeGreaterThan(p.totalValue);                            // 2024 purchase, still below 2026 comps
    expect(r.parcels.find((q) => q.id === "2069012068").marketEstimate).toBeGreaterThan(0);   // golf course clubhouse has a size; harmless
    expect(r.parcels.find((q) => !q.livingSqft).marketEstimate).toBeUndefined();
  });
  test("providerFor: Calabasas and downtown LA -> lacounty; Irvine -> none", () => {
    expect(P.providerFor(34.1367, -118.6615).id).toBe("lacounty");
    expect(P.providerFor(34.05, -118.25).id).toBe("lacounty");
    expect(P.providerFor(33.68, -117.8)).toBeNull();
  });
  test("Market.summary uses the parcel's own units/size in LA and the market estimate as the value basis", () => {
    const home = parcels.find((q) => q.id === "2069021021"); home.marketEstimate = 1800000;
    const m = M.summary(home, 2026);
    expect(m.kind).toBe("home"); expect(m.rent.monthly).toBeGreaterThan(3000); expect(m.grossYield).toBeGreaterThan(0.01); expect(m.grossYield).toBeLessThan(0.06);
    expect(m.zip.city).toBe("Calabasas"); expect(m.zip.county).toBe("Los Angeles");
    const apt = { id: "x", zip: "91302", unitCount: 12, livingSqft: 9600, yearBuilt: 1975, totalValue: 2400000, marketEstimate: 6000000, propType: "R" };
    const ma = M.summary(apt, 2026);
    expect(ma.kind).toBe("apartment"); expect(ma.apt.units).toBe(12); expect(ma.apt.avgUnitSqft).toBe(800); expect(ma.perUnit).toBe(500000); expect(ma.valueBasis).toBe("market estimate");
  });
});

describe("Providers: stacked parcels and paging", () => {
  test("groupStacked merges condo units on one footprint (Tacoma fixture)", () => {
    const ps = require("./fixture_wastate.json").features.map((f) => P.normalizeParcel(f, P.PROVIDERS.wastate));
    const g = P.groupStacked(ps);
    expect(g.length).toBe(42); expect(ps.length).toBe(48);
    const m = g.filter((p) => p.units);
    expect(m.length).toBe(3);
    for (const p of m) { expect(p.totalValue).toBe(p.units.reduce((s, u) => s + (u.totalValue || 0), 0)); expect(p.address).toBe("1250 PACIFIC AVE"); }
    const kc = P.groupStacked(parcelsFx.features.map((f) => P.normalizeParcel(f, KC)));
    expect(kc.length).toBe(43);   // nothing stacked there
  });
  test("groupStacked strips unit suffixes and keeps sales", () => {
    const mk = (id, addr, v) => ({ id, address: addr, centroid: { lat: 47.66, lon: -122.31, areaM2: 1000 }, ring: [], landValue: 0, imprValue: v, totalValue: v, sales: [{ id, date: new Date(2024, 0, id), price: v }], propType: "K" });
    const out = P.groupStacked([mk(1, "100 MAIN ST UNIT 101", 100), mk(2, "100 MAIN ST UNIT 202", 300)]);
    expect(out.length).toBe(1); expect(out[0].address).toBe("100 MAIN ST"); expect(out[0].units.length).toBe(2); expect(out[0].sales.length).toBe(2); expect(out[0].lastSale.price).toBe(300);
  });
  test("queryParcels pages when exceededTransferLimit and the provider supports it", async () => {
    const calls = [];
    const fake = async (url) => { calls.push(url); const off = Number(new URL(url).searchParams.get("resultOffset") || 0); const page = { features: parcelsFx.features.slice(off, off + 20), exceededTransferLimit: off + 20 < parcelsFx.features.length }; return { ok: true, text: async () => JSON.stringify(page) }; };
    const r = await P.queryParcels(KC, ME.lat, ME.lon, 120, fake);
    expect(r.parcels.length).toBe(43); expect(r.pages).toBe(3); expect(r.exceeded).toBe(false); expect(calls.length).toBe(3);
    const sno = await P.queryParcels(P.PROVIDERS.snohomish, 47.98, -122.2, 120, async () => ({ ok: true, text: async () => JSON.stringify({ features: [], exceededTransferLimit: true }) }));
    expect(sno.pages).toBe(1); expect(sno.exceeded).toBe(true);
  });
  test("fetchArea falls back to the statewide layer when the county server errors", async () => {
    const fx = require("./fixture_wastate.json"); const calls = [];
    const fake = async (url) => { calls.push(url); if (url.includes("snoco.org")) return { ok: true, text: async () => JSON.stringify({ error: { code: 400, message: "Failed to execute query." } }) }; return { ok: true, text: async () => JSON.stringify(fx) }; };
    const r = await P.fetchArea(P.PROVIDERS.snohomish, 47.98, -122.2, 100, fake);
    expect(r.fellBackFrom).toBe("snohomish"); expect(r.provider.id).toBe("wastate"); expect(r.parcels.length).toBe(42);
    expect(calls.some((u) => u.includes("dnr.wa.gov"))).toBe(true);
    await expect(P.fetchArea(P.PROVIDERS.wastate, 47.98, -122.2, 100, async () => ({ ok: false, status: 503 }))).rejects.toThrow("HTTP 503");   // no fallback from the fallback
  });
  test("arcgisParams asks for generalised geometry and the byte meter counts", async () => {
    const q = P.arcgisParams(ME.lat, ME.lon, 100, ["PIN"], true);
    expect(q.get("maxAllowableOffset")).toBe(String(P.MAX_OFFSET_DEG)); expect(q.get("geometryPrecision")).toBe("5");
    expect(P.arcgisParams(ME.lat, ME.lon, 100, ["PIN"], false).get("maxAllowableOffset")).toBeNull();
    expect(P.arcgisParams(ME.lat, ME.lon, 100, ["PIN"], true, 0, false).get("maxAllowableOffset")).toBeNull();
    let seen = 0; P.onBytes((n) => { seen += n; });
    const body = JSON.stringify({ features: [] });
    await P.queryParcels(KC, ME.lat, ME.lon, 100, async () => ({ ok: true, text: async () => body }));
    expect(seen).toBe(body.length);
  });
});

describe("Providers: query building and fetch plumbing", () => {
  test("arcgisParams", () => {
    const q = P.arcgisParams(47.6625, -122.3145, 220.4, ["PIN", "ADDR_FULL"], true);
    expect(q.get("geometry")).toBe("-122.314500,47.662500"); expect(q.get("resultOffset")).toBeNull();
    expect(q.get("inSR")).toBe("4326"); expect(q.get("outSR")).toBe("4326");
    expect(q.get("distance")).toBe("220"); expect(q.get("units")).toBe("esriSRUnit_Meter");
    expect(q.get("outFields")).toBe("PIN,ADDR_FULL"); expect(q.get("returnGeometry")).toBe("true");
  });
  test("fetchArea with a fake fetch joins both layers and reports exceeded", async () => {
    const calls = [];
    const fake = async (url) => {
      calls.push(url);
      const body = url.includes("/2/query") ? { ...parcelsFx, exceededTransferLimit: true } : salesFx;
      return { ok: true, text: async () => JSON.stringify(body) };
    };
    const r = await P.fetchArea(KC, ME.lat, ME.lon, 120, fake);
    expect(calls.length).toBe(4);                        // 3 parcel pages (the fake always says "more") + 1 sales
    expect(calls.filter((u) => u.includes(KC.parcels.url)).length).toBe(3); expect(calls.some((u) => u.includes(KC.sales.url))).toBe(true);
    expect(r.parcels.length).toBe(43); expect(r.pages).toBe(3); expect(r.salesCount).toBe(19); expect(r.exceeded).toBe(true);
  });
  test("ArcGIS error payloads and HTTP errors throw", async () => {
    const err = async () => ({ ok: true, text: async () => JSON.stringify({ error: { code: 400, message: "bad" } }) });
    await expect(P.queryParcels(KC, ME.lat, ME.lon, 100, err)).rejects.toThrow("ArcGIS 400: bad");
    const http = async () => ({ ok: false, status: 503 });
    await expect(P.queryParcels(KC, ME.lat, ME.lon, 100, http)).rejects.toThrow("HTTP 503");
    // sales failure is swallowed by fetchArea
    const mixed = async (url) => url.includes("/2/query") ? { ok: true, text: async () => JSON.stringify(parcelsFx) } : { ok: false, status: 500 };
    const r = await P.fetchArea(KC, ME.lat, ME.lon, 120, mixed);
    expect(r.parcels.length).toBe(43); expect(r.salesCount).toBe(0);
  });
  test("providerFor", () => {
    expect(P.providerFor(47.6625, -122.3145)).toBe(KC);
  });
  test("reverseGeocode picks city + neighbourhood", async () => {
    const fake = async () => ({ ok: true, json: async () => ({ display_name: "x", address: { city: "Seattle", neighbourhood: "Greek Row", road: "Brooklyn Avenue Northeast" } }) });
    const g = await P.reverseGeocode(ME.lat, ME.lon, fake);
    expect(g.city).toBe("Seattle"); expect(g.neighbourhood).toBe("Greek Row"); expect(g.road).toBe("Brooklyn Avenue Northeast");
  });
});

describe("Heights: estimates", () => {
  const parcels = parcelsFx.features.map((f) => P.normalizeParcel(f, KC));
  H.applyHeights(parcels, null);
  const by = (addr) => parcels.find((p) => p.address === addr);
  test("density curve hits the anchors", () => {
    expect(H.storeysFromDensity(60)).toBeCloseTo(1, 0);
    expect(H.storeysFromDensity(1000)).toBeCloseTo(6, 0);
    expect(H.storeysFromDensity(8500)).toBeCloseTo(24, 0);
    expect(H.storeysFromDensity(0)).toBe(1);
  });
  test("U-District skyline: tower, hotel, walk-up, retail, parking", () => {
    expect(by("4515 BROOKLYN AVE NE").storeys).toBeGreaterThanOrEqual(22);   // The Standard, 24 fl
    expect(by("4507 BROOKLYN AVE NE").storeys).toBeGreaterThanOrEqual(7);    // Graduate Hotel, ~8 fl
    expect(by("4507 BROOKLYN AVE NE").storeys).toBeLessThanOrEqual(10);
    expect(by("4535 12TH AVE NE").storeys).toBeGreaterThanOrEqual(5);        // 6-storey apartments
    expect(by("4534 UNIVERSITY WAY NE").storeys).toBeLessThanOrEqual(6);     // retail
    const parking = parcels.find((p) => /Parking/.test(p.use));
    expect(parking.storeys).toBe(0); expect(parking.height).toBe(0);
    expect(by("4557 BROOKLYN AVE NE").height).toBe(0);                        // vacant
    for (const p of parcels) { expect(p.heightSource).toBe("estimate"); expect(p.height).toBeGreaterThanOrEqual(0); }
  });
  test("class bounds: a house never gets a tower height, 4-plex is 2+", () => {
    expect(H.estimateHeight({ use: "Single Family(Res Use/Zone)", propType: "R", imprValue: 5e6, lotSqft: 5000 }).storeys).toBe(3);
    expect(H.estimateHeight({ use: "4-Plex", propType: "R", imprValue: 0, lotSqft: 5000 }).storeys).toBe(2);
    expect(H.estimateHeight({ use: "Apartment", propType: "C", imprValue: 1e6, lotSqft: 0, centroid: { areaM2: 500 } }).storeys).toBeGreaterThan(1);
    expect(H.estimateHeight({ use: "Railroad Transportation", propType: "C" }).height).toBe(0);
    expect(H.estimateHeight({ use: "DOR 0", address: "REFERENCE" }).height).toBe(0);
  });
});

describe("Heights: OSM", () => {
  test("parseOsmHeight", () => {
    expect(H.parseOsmHeight("12")).toBe(12); expect(H.parseOsmHeight("12.5 m")).toBe(12.5);
    expect(H.parseOsmHeight("40 ft")).toBeCloseTo(12.19, 2); expect(H.parseOsmHeight("40'")).toBeCloseTo(12.19, 2);
    expect(H.parseOsmHeight("tall")).toBeNull(); expect(H.parseOsmHeight(null)).toBeNull();
  });
  test("osmBuilding uses height, else levels, else null", () => {
    expect(H.osmBuilding({ center: { lat: 1, lon: 2 }, tags: { building: "yes", height: "30" } })).toMatchObject({ height: 30, storeys: 9 });
    expect(H.osmBuilding({ center: { lat: 1, lon: 2 }, tags: { building: "yes", "building:levels": "6" } })).toMatchObject({ height: 6 * H.STOREY_M + 1, storeys: 6 });
    expect(H.osmBuilding({ center: { lat: 1, lon: 2 }, tags: { building: "yes" } })).toBeNull();
    expect(H.osmBuilding({ tags: { height: "3" } })).toBeNull();
  });
  test("applyHeights matches OSM buildings to containing parcels, tallest wins, name fills in", () => {
    const parcels = parcelsFx.features.map((f) => P.normalizeParcel(f, KC));
    const p = parcels.find((q) => q.address === "4541 BROOKLYN AVE NE");
    const osm = [
      { lat: p.centroid.lat, lon: p.centroid.lon, height: 9, storeys: 3, name: "Brooklyn Apts" },
      { lat: p.centroid.lat, lon: p.centroid.lon, height: 6, storeys: 2, name: null },
      { lat: 0, lon: 0, height: 100, storeys: 30, name: "nowhere" },
    ];
    H.applyHeights(parcels, osm);
    expect(p.height).toBe(9); expect(p.storeys).toBe(3); expect(p.heightSource).toBe("osm"); expect(p.name).toBe("Brooklyn Apts");
    expect(parcels.filter((q) => q.heightSource === "osm").length).toBe(1);
  });
  test("fetchOsmHeights falls through mirrors and posts a query", async () => {
    const calls = [];
    const fake = async (url, init) => { calls.push({ url, body: init.body }); if (calls.length === 1) return { ok: false, status: 504 }; return { ok: true, json: async () => ({ elements: [{ type: "way", center: { lat: 1, lon: 2 }, tags: { building: "yes", height: "20" } }] }) }; };
    const out = await H.fetchOsmHeights(47.66, -122.31, 150, fake, ["https://a/", "https://b/"]);
    expect(calls.length).toBe(2); expect(calls[0].url).toBe("https://a/");
    expect(decodeURIComponent(calls[1].body)).toContain('way["building"]["building"!="no"](around:150,47.660000,-122.310000)');
    expect(out).toEqual([{ lat: 1, lon: 2, height: 20, storeys: 6, name: null }]);
    await expect(H.fetchOsmHeights(0, 0, 10, async () => ({ ok: false, status: 500 }), ["https://a/"])).rejects.toThrow("HTTP 500");
  });
});

describe("Market: bundled datasets", () => {
  M.set("apts", require("./data/kc_apartments.json")); M.set("zips:WA", require("./data/zip_market_wa.json")); M.set("zips:CA", require("./data/zip_market_ca.json"));
  const parcels = parcelsFx.features.map((f) => P.normalizeParcel(f, KC));
  const by = (addr) => parcels.find((p) => p.address === addr);
  test("apartment record: The Standard is 211 units / 25 storeys / 2022", () => {
    const a = M.apartment("8817400054");
    expect(a.units).toBe(211); expect(a.stories).toBe(25); expect(a.yearBuilt).toBe(2022); expect(a.avgUnitSqft).toBe(799);
    expect(a.bedroomMix.S).toBe(43); expect(a.bedroomMix["0"]).toBeUndefined();
    expect(M.apartment("nope")).toBeNull();
  });
  test("zip: 98105 has rent, condo, home with a 1y change", () => {
    const z = M.zip("98105");
    expect(z.rent.value).toBeGreaterThan(1500); expect(z.rent.value).toBeLessThan(3500);
    expect(z.condo.value).toBeGreaterThan(200000); expect(z.home.value).toBeGreaterThan(z.condo.value);
    expect(typeof z.rent.change).toBe("number"); expect(z.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(M.zip("00000")).toBeNull(); expect(M.zip(null)).toBeNull();
  });
  test("estimateRent scales with size and age", () => {
    const base = M.estimateRent("98105", M.TYPICAL_RENTAL_SQFT, 1990, 2026).monthly;
    expect(base).toBeCloseTo(M.zip("98105").rent.value, -2);
    expect(M.estimateRent("98105", 425, 1990, 2026).monthly).toBeLessThan(base);
    expect(M.estimateRent("98105", 425, 1990, 2026).monthly).toBeGreaterThan(base * 0.5);     // not linear in size
    expect(M.estimateRent("98105", 850, 2024, 2026).monthly).toBeGreaterThan(base);
    expect(M.estimateRent("00000", 850, 2024)).toBeNull();
  });
  test("summary for an apartment parcel", () => {
    const m = M.summary(by("4515 BROOKLYN AVE NE"), 2026);
    expect(m.kind).toBe("apartment"); expect(m.perUnit).toBeCloseTo(124945700 / 211, -3);
    expect(m.perSqft).toBe(Math.round(124945700 / (211 * 799)));
    expect(m.rent.monthly).toBeGreaterThan(1500); expect(m.grossYield).toBeGreaterThan(0.02); expect(m.grossYield).toBeLessThan(0.12);
    expect(m.mix[0]).toBe("43 × studio"); expect(m.zip.city).toBe("Seattle");
  });
  test("summary for stacked condo units averages the unit values", () => {
    const p = { id: "x", zip: "98105", units: [{ totalValue: 400000 }, { totalValue: 600000 }, { totalValue: 0 }], totalValue: 1000000 };
    const m = M.summary(p, 2026);
    expect(m.kind).toBe("condo"); expect(m.perUnit).toBe(500000); expect(m.unitCount).toBe(3); expect(m.rent.monthly).toBeGreaterThan(0);
  });
  test("summary for a plain parcel has no kind but still carries the ZIP market", () => {
    const m = M.summary(by("4557 BROOKLYN AVE NE"), 2026);   // vacant lot
    expect(m.kind).toBeNull(); expect(m.zip.rent.value).toBeGreaterThan(0);
  });
  test("applyHeights prefers the assessor storey count over the estimate and OSM", () => {
    const ps = parcelsFx.features.map((f) => P.normalizeParcel(f, KC));
    H.applyHeights(ps, [{ lat: by("4515 BROOKLYN AVE NE").centroid.lat, lon: by("4515 BROOKLYN AVE NE").centroid.lon, height: 10, storeys: 3, name: "The Standard" }], M.apartment);
    const std = ps.find((p) => p.address === "4515 BROOKLYN AVE NE");
    expect(std.storeys).toBe(25); expect(std.heightSource).toBe("assessor"); expect(std.name).toBe("The Standard");
    expect(ps.filter((p) => p.heightSource === "assessor").length).toBe(10);
    expect(ps.find((p) => p.address === "4557 BROOKLYN AVE NE").heightSource).toBe("estimate");
  });
  test("bundled data files are reasonably small", () => {
    const fs = require("fs");
    expect(fs.statSync(__dirname + "/data/kc_apartments.json").size).toBeLessThan(600 * 1024);
    expect(fs.statSync(__dirname + "/data/zip_market_wa.json").size).toBeLessThan(200 * 1024);
    expect(fs.statSync(__dirname + "/data/zip_market_ca.json").size).toBeLessThan(600 * 1024);
  });
});

describe("ParcelStore: coverage", () => {
  const mpd = Geo.metresPerDegree(ME.lat);
  test("covers only when the query circle is inside a fresh circle of the same provider", () => {
    const c = new PS.Coverage([], 1000);
    expect(c.covers(ME.lat, ME.lon, 100, "kingcounty")).toBe(false);
    c.add(ME.lat, ME.lon, 220, "kingcounty", 5000);
    expect(c.covers(ME.lat, ME.lon, 220, "kingcounty", 5100)).toBe(true);
    expect(c.covers(ME.lat, ME.lon, 221.5, "kingcounty", 5100)).toBe(false);
    expect(c.covers(ME.lat + 100 / mpd.lat, ME.lon, 120, "kingcounty", 5100)).toBe(true);    // 100 + 120 <= 220
    expect(c.covers(ME.lat + 100 / mpd.lat, ME.lon, 130, "kingcounty", 5100)).toBe(false);
    expect(c.covers(ME.lat, ME.lon, 100, "snohomish", 5100)).toBe(false);
    expect(c.covers(ME.lat, ME.lon, 100, "kingcounty", 7000)).toBe(false);                  // expired (ttl 1000)
  });
  test("fraction: none, all, half", () => {
    const c = new PS.Coverage([], 1e9);
    expect(c.fraction(ME.lat, ME.lon, 100, "kingcounty")).toBe(0);
    c.add(ME.lat, ME.lon, 300, "kingcounty");
    expect(c.fraction(ME.lat, ME.lon, 100, "kingcounty")).toBe(1);
    const half = c.fraction(ME.lat, ME.lon + 300 / mpd.lon, 200, "kingcounty");   // centre on the edge
    expect(half).toBeGreaterThan(0.3); expect(half).toBeLessThan(0.7);
  });
  test("add swallows contained circles and enforces ttl and cap", () => {
    const c = new PS.Coverage([], 1000);
    c.add(ME.lat, ME.lon, 100, "kingcounty", 10); c.add(ME.lat, ME.lon, 200, "kingcounty", 20);
    expect(c.circles.length).toBe(1); expect(c.circles[0].radius).toBe(200);
    c.add(ME.lat + 0.01, ME.lon, 100, "kingcounty", 20); expect(c.circles.length).toBe(2);
    c.add(ME.lat, ME.lon, 50, "kingcounty", 2000); expect(c.circles.length).toBe(1);     // the others aged out
    expect(c.boxes(2000).length).toBe(1); expect(c.boxes(2000)[0][0]).toBeLessThan(ME.lon);
  });
});

describe("ParcelStore: planPrecache", () => {
  const mpd = Geo.metresPerDegree(ME.lat);
  const inside = (plan, la, lo) => plan.circles.some((c) => Geo.haversine(la, lo, c.lat, c.lon) <= c.radius);
  test("hex tiling covers the whole area for several sizes", () => {
    for (const [A, F] of [[300, 260], [600, 260], [1000, 220], [2000, 300]]) {
      const plan = PS.planPrecache(ME.lat, ME.lon, A, F, null, "kingcounty");
      let miss = 0;
      for (let k = 0; k < 2000; k++) { const a = k * 2.399963, r = A * Math.sqrt((k + 0.5) / 2000); if (!inside(plan, ME.lat + r * Math.sin(a) / mpd.lat, ME.lon + r * Math.cos(a) / mpd.lon)) miss++; }
      expect(miss).toBe(0);
      expect(plan.circles.length).toBeLessThan(2.2 * (A / F + 1) ** 2 + 4);   // not absurdly many
      expect(plan.circles[0].dist).toBe(0);                                    // nearest first
      for (let i = 1; i < plan.circles.length; i++) expect(plan.circles[i].dist).toBeGreaterThanOrEqual(plan.circles[i - 1].dist);
    }
  });
  test("skips circles already inside fresh coverage of the same provider", () => {
    const cov = new PS.Coverage([], 1e9).add(ME.lat, ME.lon, 400, "kingcounty");
    const plan = PS.planPrecache(ME.lat, ME.lon, 600, 260, cov, "kingcounty");
    expect(plan.skipped).toBeGreaterThan(0); expect(plan.todo.length + plan.skipped).toBe(plan.circles.length);
    expect(plan.todo.every((c) => !c.covered)).toBe(true);
    expect(PS.planPrecache(ME.lat, ME.lon, 600, 260, cov, "snohomish").skipped).toBe(0);
    const full = new PS.Coverage([], 1e9).add(ME.lat, ME.lon, 2000, "kingcounty");
    expect(PS.planPrecache(ME.lat, ME.lon, 600, 260, full, "kingcounty").todo.length).toBe(0);
  });
});

describe("ParcelStore: unionArcs", () => {
  const deg = (arcs) => arcs.reduce((t, a) => t + a.a1 - a.a0, 0) * 180 / Math.PI;
  test("two unit circles at distance 1 leave 240° each", () => {
    const arcs = PS.unionArcs([{ x: 0, y: 0, r: 1 }, { x: 1, y: 0, r: 1 }]);
    expect(deg(arcs)).toBeCloseTo(480, 6);
    expect(deg(arcs.filter((a) => a.x === 0))).toBeCloseTo(240, 6);
    for (const a of arcs) { const mid = (a.a0 + a.a1) / 2, px = a.x + Math.cos(mid), py = a.y + Math.sin(mid); const other = a.x === 0 ? { x: 1, y: 0 } : { x: 0, y: 0 }; expect(Math.hypot(px - other.x, py - other.y)).toBeGreaterThan(1); }
  });
  test("disjoint, contained, identical", () => {
    expect(deg(PS.unionArcs([{ x: 0, y: 0, r: 1 }, { x: 5, y: 0, r: 1 }]))).toBeCloseTo(720, 6);
    expect(PS.unionArcs([{ x: 0, y: 0, r: 1 }, { x: 0, y: 0, r: 3 }])).toEqual([{ x: 0, y: 0, r: 3, a0: 0, a1: Math.PI * 2 }]);
    expect(deg(PS.unionArcs([{ x: 0, y: 0, r: 1 }, { x: 0, y: 0, r: 1 }]))).toBeCloseTo(360, 6);   // one of the two survives
  });
  test("hex ring swallows the centre; every remaining arc midpoint is outside all other circles", () => {
    const cs = [{ x: 0, y: 0, r: 1 }]; for (let k = 0; k < 6; k++) cs.push({ x: 1.6 * Math.cos(k * Math.PI / 3), y: 1.6 * Math.sin(k * Math.PI / 3), r: 1 });
    const arcs = PS.unionArcs(cs);
    expect(arcs.some((a) => a.x === 0 && a.y === 0)).toBe(false);
    for (const a of arcs) { const mid = (a.a0 + a.a1) / 2, px = a.x + a.r * Math.cos(mid), py = a.y + a.r * Math.sin(mid); for (const c of cs) if (c !== cs.find((q) => q.x === a.x && q.y === a.y)) expect(Math.hypot(px - c.x, py - c.y)).toBeGreaterThan(c.r - 1e-9); }
  });
});

describe("ParcelStore: Track, planAhead, allowAuto", () => {
  const mpd = Geo.metresPerDegree(ME.lat);
  test("Track: no course until moved enough, then bearing and speed", () => {
    const t = new PS.Track({ minDist: 25 });
    t.push(ME.lat, ME.lon, 0); t.push(ME.lat + 5 / mpd.lat, ME.lon, 5000);
    expect(t.course()).toBeNull();                                        // 5 m: jitter
    t.push(ME.lat + 60 / mpd.lat, ME.lon, 45000);                           // 60 m north in 45 s
    const c = t.course(); expect(c.bearing).toBeCloseTo(0, 0); expect(c.speed).toBeCloseTo(60 / 45, 2);
    t.push(ME.lat + 60 / mpd.lat, ME.lon, 200000);                          // long pause: window drops old fixes
    expect(t.fixes.length).toBe(1); expect(t.course()).toBeNull();
  });
  test("planAhead: corridor heading north, nearest first, skips covered", () => {
    const plan = PS.planAhead(ME.lat, ME.lon, 0, 800, 260, null, "kingcounty");
    expect(plan.circles.length).toBe(6);                                    // 2 steps × 3 lanes
    for (const c of plan.circles) expect(c.lat).toBeGreaterThan(ME.lat);    // all ahead
    expect(plan.circles[0].dist).toBeLessThanOrEqual(plan.circles[plan.circles.length - 1].dist);
    const lanes = new Set(plan.circles.map((c) => Math.round((c.lon - ME.lon) * mpd.lon / 10) * 10));
    expect(lanes.size).toBe(3);                                             // left, centre, right
    const cov = new PS.Coverage([], 1e9).add(ME.lat + 200 / mpd.lat, ME.lon, 600, "kingcounty");
    const plan2 = PS.planAhead(ME.lat, ME.lon, 0, 800, 260, cov, "kingcounty");
    expect(plan2.skipped).toBeGreaterThan(0); expect(plan2.todo.length).toBeLessThan(6);
    // heading east: circles have larger lon, same-ish lat
    const east = PS.planAhead(ME.lat, ME.lon, 90, 400, 260, null, "kingcounty");
    for (const c of east.circles) expect(c.lon).toBeGreaterThan(ME.lon);
  });
  test("allowAuto gate", () => {
    expect(PS.allowAuto("off", { type: "wifi" }, true).ok).toBe(false);
    expect(PS.allowAuto("wifi", undefined, false).ok).toBe(false);
    expect(PS.allowAuto("wifi", { type: "wifi" }, true).ok).toBe(true);
    expect(PS.allowAuto("wifi", { type: "cellular" }, true)).toEqual({ ok: false, why: "cellular" });
    expect(PS.allowAuto("wifi", { type: "wifi", saveData: true }, true).ok).toBe(false);
    expect(PS.allowAuto("wifi", undefined, true).ok).toBe(true);           // iOS: no API
    expect(PS.allowAuto("any", { type: "cellular" }, true).ok).toBe(true);
  });
});

describe("ParcelStore: DataMeter", () => {
  const mem = () => { const m = new Map(); return { getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
  test("adds, sums over 24 h, forgets older buckets, persists", () => {
    const st = mem(), d = new PS.DataMeter(st), H = 3600e3, t0 = 100 * H;
    d.add(1000, t0); d.add(2000, t0 + 5 * H); d.add(4000, t0 + 23 * H);
    expect(d.today(t0 + 23 * H)).toBe(7000);
    expect(d.today(t0 + 25 * H)).toBe(6000);      // first bucket (hour 100) fell out of the window at hour 125
    expect(d.over(5000, t0 + 25 * H)).toBe(true); expect(d.over(9000, t0 + 25 * H)).toBe(false);
    const d2 = new PS.DataMeter(st); expect(d2.today(t0 + 25 * H)).toBe(6000);
    st.setItem("estate-ar:data", "{broken"); expect(new PS.DataMeter(st).today()).toBe(0);
  });
});

describe("ParcelStore: Store with MemoryDB", () => {
  test("put / near / needsFetch / thawed dates / clear", async () => {
    const store = new PS.Store(new PS.MemoryDB(), { ttlMs: 1e9 });
    const parcels = parcelsFx.features.map((f) => P.normalizeParcel(f, KC));
    P.joinSales(parcels, salesFx.features.map((f) => P.normalizeSale(f, KC)));
    H.applyHeights(parcels, null);
    expect(await store.needsFetch(ME.lat, ME.lon, 120, "kingcounty")).toBe(true);
    await store.put(ME.lat, ME.lon, 120, "kingcounty", parcels);
    expect(await store.needsFetch(ME.lat, ME.lon, 120, "kingcounty")).toBe(false);
    expect(await store.needsFetch(ME.lat, ME.lon, 120, "snohomish")).toBe(true);
    expect(await store.count()).toBe(43);
    const near = await store.near(ME.lat, ME.lon, 120, "kingcounty");
    expect(near.length).toBe(43);
    const sold = near.find((p) => p.lastSale);
    expect(sold.lastSale.date).toBeInstanceOf(Date); expect(sold.sales[0].date).toBeInstanceOf(Date);
    expect(near[0].height).toBeDefined(); expect(near[0].ring.length).toBeGreaterThan(3);
    // far away: nothing
    expect((await store.near(ME.lat + 0.05, ME.lon, 120, "kingcounty")).length).toBe(0);
    // re-put updates in place (no duplicates)
    await store.put(ME.lat, ME.lon, 120, "kingcounty", parcels); expect(await store.count()).toBe(43);
    // coverage persisted through meta and reloaded by a second Store on the same DB
    const again = new PS.Store(store.db, { ttlMs: 1e9 });
    expect(await again.needsFetch(ME.lat, ME.lon, 120, "kingcounty")).toBe(false);
    await store.clear(); expect(await store.count()).toBe(0);
    expect(await store.needsFetch(ME.lat, ME.lon, 120, "kingcounty")).toBe(true);
  });
  test("open() falls back to memory when IndexedDB is missing", async () => {
    const s = PS.open({ memory: true }); expect(s.db).toBeInstanceOf(PS.MemoryDB);
    const s2 = PS.open(); expect(s2.db).toBeInstanceOf(typeof indexedDB === "undefined" ? PS.MemoryDB : PS.ParcelDB);
  });
});

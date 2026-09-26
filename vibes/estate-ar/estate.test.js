// bun test  (run from vibes/estate-ar)
const { test, expect, describe } = require("bun:test");
const Geo = require("./geo.js");
const P = require("./providers.js");
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

describe("Providers: query building and fetch plumbing", () => {
  test("arcgisParams", () => {
    const q = P.arcgisParams(47.6625, -122.3145, 220.4, ["PIN", "ADDR_FULL"], true);
    expect(q.get("geometry")).toBe("-122.314500,47.662500");
    expect(q.get("inSR")).toBe("4326"); expect(q.get("outSR")).toBe("4326");
    expect(q.get("distance")).toBe("220"); expect(q.get("units")).toBe("esriSRUnit_Meter");
    expect(q.get("outFields")).toBe("PIN,ADDR_FULL"); expect(q.get("returnGeometry")).toBe("true");
  });
  test("fetchArea with a fake fetch joins both layers and reports exceeded", async () => {
    const calls = [];
    const fake = async (url) => {
      calls.push(url);
      const body = url.includes("/2/query") ? { ...parcelsFx, exceededTransferLimit: true } : salesFx;
      return { ok: true, json: async () => body };
    };
    const r = await P.fetchArea(KC, ME.lat, ME.lon, 120, fake);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain(KC.parcels.url); expect(calls[1]).toContain(KC.sales.url);
    expect(r.parcels.length).toBe(43); expect(r.salesCount).toBe(19); expect(r.exceeded).toBe(true);
  });
  test("ArcGIS error payloads and HTTP errors throw", async () => {
    const err = async () => ({ ok: true, json: async () => ({ error: { code: 400, message: "bad" } }) });
    await expect(P.queryParcels(KC, ME.lat, ME.lon, 100, err)).rejects.toThrow("ArcGIS 400: bad");
    const http = async () => ({ ok: false, status: 503 });
    await expect(P.queryParcels(KC, ME.lat, ME.lon, 100, http)).rejects.toThrow("HTTP 503");
    // sales failure is swallowed by fetchArea
    const mixed = async (url) => url.includes("/2/query") ? { ok: true, json: async () => parcelsFx } : { ok: false, status: 500 };
    const r = await P.fetchArea(KC, ME.lat, ME.lon, 120, mixed);
    expect(r.parcels.length).toBe(43); expect(r.salesCount).toBe(0);
  });
  test("providerFor", () => {
    expect(P.providerFor(47.6625, -122.3145)).toBe(KC);
    expect(P.providerFor(45.5152, -122.6784)).toBeNull();   // Portland
  });
  test("reverseGeocode picks city + neighbourhood", async () => {
    const fake = async () => ({ ok: true, json: async () => ({ display_name: "x", address: { city: "Seattle", neighbourhood: "Greek Row", road: "Brooklyn Avenue Northeast" } }) });
    const g = await P.reverseGeocode(ME.lat, ME.lon, fake);
    expect(g.city).toBe("Seattle"); expect(g.neighbourhood).toBe("Greek Row"); expect(g.road).toBe("Brooklyn Avenue Northeast");
  });
});

describe("Providers: ParcelStore", () => {
  const mem = () => { const m = new Map(); return { getItem: (k) => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
  test("needsFetch: first time, moved, radius grown, provider changed, ttl", () => {
    const s = new ParcelStoreTest(mem());
    expect(s.needsFetch(ME.lat, ME.lon, 200, "kingcounty")).toBe(true);
    s.set(ME.lat, ME.lon, 200, "kingcounty", []);
    expect(s.needsFetch(ME.lat, ME.lon, 200, "kingcounty")).toBe(false);
    expect(s.needsFetch(ME.lat + 50 / 111180, ME.lon, 200, "kingcounty")).toBe(false);   // 50 m < 40% of 200
    expect(s.needsFetch(ME.lat + 100 / 111180, ME.lon, 200, "kingcounty")).toBe(true);   // 100 m
    expect(s.needsFetch(ME.lat, ME.lon, 300, "kingcounty")).toBe(true);
    expect(s.needsFetch(ME.lat, ME.lon, 200, "other")).toBe(true);
    s.at = Date.now() - 7 * 3600e3;
    expect(s.needsFetch(ME.lat, ME.lon, 200, "kingcounty")).toBe(true);
  });
  test("persists to storage and revives Dates", () => {
    const storage = mem();
    const a = new P.ParcelStore({ storage });
    const parcels = parcelsFx.features.map((f) => P.normalizeParcel(f, KC));
    P.joinSales(parcels, salesFx.features.map((f) => P.normalizeSale(f, KC)));
    a.set(ME.lat, ME.lon, 120, "kingcounty", parcels);
    const b = new P.ParcelStore({ storage });
    expect(b.parcels.length).toBe(43); expect(b.needsFetch(ME.lat, ME.lon, 120, "kingcounty")).toBe(false);
    const sold = b.parcels.find((p) => p.lastSale);
    expect(sold.lastSale.date).toBeInstanceOf(Date); expect(sold.sales[0].date).toBeInstanceOf(Date);
    b.clear();
    expect(new P.ParcelStore({ storage }).parcels.length).toBe(0);
  });
  test("corrupt storage is ignored", () => {
    const storage = mem(); storage.setItem("estate-ar:cache", "{not json");
    expect(new P.ParcelStore({ storage }).parcels.length).toBe(0);
  });
  function ParcelStoreTest(storage) { return new P.ParcelStore({ storage }); }
});

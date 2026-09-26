// bun test  (run from vibes/marine-ar)
const { test, expect, describe } = require("bun:test");
const Geo = require("./geo.js");
const P = require("./providers.js");
const Proxy = require("./proxy.js");

const WEST_POINT = { lat: 47.66028, lon: -122.44112 };
const tssFixture = require("./fixture_tss_lanes.json");
const prcareFixture = require("./fixture_tss_precautionary.json");
const dtLocations = require("./fixture_digitraffic_locations.json");
const dtVessel = require("./fixture_digitraffic_vessel.json");

describe("Geo basics", () => {
  test("haversine / bearing / destination round trip", () => {
    const d = Geo.destination(WEST_POINT.lat, WEST_POINT.lon, 300, 5 * Geo.NM);
    expect(Geo.haversine(WEST_POINT.lat, WEST_POINT.lon, d.lat, d.lon)).toBeCloseTo(5 * Geo.NM, 0);
    expect(Geo.bearing(WEST_POINT.lat, WEST_POINT.lon, d.lat, d.lon)).toBeCloseTo(300, 2);
  });
  test("ENU is consistent with haversine over a few km", () => {
    const t = { lat: 47.62, lon: -122.50 };
    const { e, n } = Geo.toENU(WEST_POINT.lat, WEST_POINT.lon, t.lat, t.lon);
    expect(Math.hypot(e, n)).toBeCloseTo(Geo.haversine(WEST_POINT.lat, WEST_POINT.lon, t.lat, t.lon), -1);
    const back = Geo.fromENU(WEST_POINT.lat, WEST_POINT.lon, e, n);
    expect(back.lat).toBeCloseTo(t.lat, 6); expect(back.lon).toBeCloseTo(t.lon, 6);
  });
  test("horizon: 2 m eye -> ~2.5 arcmin dip, ~5.5 km", () => {
    expect(Geo.horizonDip(2) * 60).toBeCloseTo(2.49, 1);
    expect(Geo.horizonDistance(2)).toBeCloseTo(5459, -2);
    expect(Geo.seaPitch(100, 2)).toBeCloseTo(-1.146, 2);
    expect(Geo.seaPitch(5459, 2)).toBeLessThan(-Geo.horizonDip(2));
  });
});

describe("Camera", () => {
  const cam = new Geo.Camera({ width: 1000, height: 600, hfov: 60, eyeHeight: 2, heading: 0, pitch: 0, roll: 0 });
  test("point dead ahead projects to centre column, on the horizon a little below centre", () => {
    const s = cam.projectSea(0, 1000);
    expect(s.x).toBeCloseTo(500, 6);
    expect(s.y).toBeGreaterThan(300);                    // sea surface is below eye level
    expect(s.y).toBeLessThan(310);
  });
  test("point to the right lands right of centre; behind returns null", () => {
    expect(cam.projectSea(500, 500).x).toBeGreaterThan(500);
    expect(cam.projectSea(0, -100)).toBeNull();
  });
  test("heading rotation: a target at bearing 90 is centred when looking east", () => {
    cam.setOrientation(90, 0, 0);
    expect(cam.projectSea(1000, 0).x).toBeCloseTo(500, 6);
    cam.setOrientation(0, 0, 0);
  });
  test("pitch down brings the near water into frame", () => {
    cam.setOrientation(0, -30, 0);
    const near = cam.projectSea(0, 3);                    // depression atan(2/3) = 33.7°, just below the look direction
    expect(near).not.toBeNull(); expect(near.y).toBeGreaterThan(300); expect(near.y).toBeLessThan(600);
    const far = cam.projectSea(0, 5);                     // 21.8°: above centre when looking 30° down
    expect(far.y).toBeLessThan(300);
    cam.setOrientation(0, 0, 0);
  });
  test("roll tilts a horizon point", () => {
    cam.setOrientation(0, 0, 10);
    const a = cam.projectDirection(-20, 0), b = cam.projectDirection(20, 0);
    expect(b.y).not.toBeCloseTo(a.y, 0);
    cam.setOrientation(0, 0, 0);
  });
  test("ring straddling the near plane is clipped, not dropped", () => {
    // square 200 m across, centred on the viewer
    const ring = [[-100, -100], [100, -100], [100, 100], [-100, 100]].map(([e, n]) => { const p = Geo.fromENU(WEST_POINT.lat, WEST_POINT.lon, e, n); return [p.lon, p.lat]; });
    cam.setOrientation(0, -20, 0);
    const poly = cam.projectSeaRing(ring, WEST_POINT.lat, WEST_POINT.lon);
    expect(poly.length).toBeGreaterThanOrEqual(4);
    for (const p of poly) expect(p).not.toBeNull();
    cam.setOrientation(0, 0, 0);
  });
  test("polyline through the viewer splits into visible pieces", () => {
    const line = [[0, -500], [0, 500]].map(([e, n]) => { const p = Geo.fromENU(WEST_POINT.lat, WEST_POINT.lon, e, n); return [p.lon, p.lat]; });
    const pieces = cam.projectSeaLine(line, WEST_POINT.lat, WEST_POINT.lon);
    expect(pieces.length).toBe(1);
    expect(pieces[0].length).toBe(2);
  });
});

describe("AIS geometry", () => {
  test("hull footprint has the right length and beam", () => {
    const ring = Geo.hullFootprint(WEST_POINT.lat, WEST_POINT.lon, 90, { a: 200, b: 100, c: 20, d: 20 });
    expect(ring.length).toBe(5);
    const bow = ring[1], sternP = ring[4], sternS = ring[3];
    expect(Geo.haversine(bow[1], bow[0], sternP[1], sternP[0])).toBeGreaterThan(299);
    expect(Geo.haversine(sternS[1], sternS[0], sternP[1], sternP[0])).toBeCloseTo(40, 0);
    // heading 90: bow is east of the antenna
    expect(bow[0]).toBeGreaterThan(WEST_POINT.lon);
  });
  test("dead reckoning: 12 kn for 5 min = 1 NM", () => {
    const p = Geo.deadReckon(WEST_POINT.lat, WEST_POINT.lon, 12, 0, 300);
    expect(Geo.haversine(WEST_POINT.lat, WEST_POINT.lon, p.lat, p.lon)).toBeCloseTo(Geo.NM, -1);
  });
  test("CPA: head-on target closes to zero", () => {
    const own = { lat: 47.6, lon: -122.4, sog: 10, cog: 0 };
    const tgt = Geo.destination(47.6, -122.4, 0, 2 * Geo.NM);
    const r = Geo.cpa(own, { lat: tgt.lat, lon: tgt.lon, sog: 10, cog: 180 });
    expect(r.cpaM).toBeLessThan(5);
    expect(r.tcpaSec).toBeCloseTo(2 * Geo.NM / (20 * Geo.KN), -1);   // 6 minutes
    expect(r.rangeM).toBeCloseTo(2 * Geo.NM, -1);
  });
  test("CPA: target abeam and parallel keeps its range, tcpa 0", () => {
    const own = { lat: 47.6, lon: -122.4, sog: 10, cog: 0 };
    const tgt = Geo.destination(47.6, -122.4, 90, 1000);
    const r = Geo.cpa(own, { lat: tgt.lat, lon: tgt.lon, sog: 10, cog: 0 });
    expect(r.stationary).toBe(true);
    expect(r.cpaM).toBeCloseTo(1000, -1);
  });
  test("lane arrows fall inside the lane and point along ORIENT", () => {
    const lane = P.normalizeLane(tssFixture.features[0], "lane", "coastal");
    const arrows = Geo.laneArrows(lane.ring, lane.orient, 500);
    expect(arrows.length).toBeGreaterThan(3);
    for (const a of arrows) {
      const mid = [(a[0][0] + a[1][0]) / 2, (a[0][1] + a[1][1]) / 2];
      expect(Geo.pointInRing(mid[1], mid[0], lane.ring)).toBe(true);
      const brg = Geo.bearing(a[0][1], a[0][0], a[1][1], a[1][0]);
      expect(Math.abs(Geo.angleDiff(brg, lane.orient))).toBeLessThan(1);
    }
  });
});

describe("Lanes (ENC Direct)", () => {
  test("normalizes TSSLPT polygons with ORIENT and CATTSS", () => {
    const lanes = tssFixture.features.map((f) => P.normalizeLane(f, "lane", "coastal"));
    expect(lanes.length).toBe(8);
    for (const l of lanes) {
      expect(l.ring.length).toBeGreaterThan(10);
      expect(l.orient).toBeGreaterThanOrEqual(0); expect(l.orient).toBeLessThan(360);
      expect(l.cattss).toBe("IMO adopted");
      expect(l.cell).toBe("US3WA1DF.000");
      expect(l.style.label).toBe("Traffic lane");
      expect(l.centroid.areaM2).toBeGreaterThan(1e6);
    }
  });
  test("Puget Sound lanes run roughly N-S, in opposing pairs", () => {
    const lanes = tssFixture.features.map((f) => P.normalizeLane(f, "lane", "coastal"));
    const north = lanes.filter((l) => l.orient < 45 || l.orient > 315).length;
    const south = lanes.filter((l) => l.orient > 135 && l.orient < 225).length;
    expect(north + south).toBe(lanes.length);
    expect(north).toBeGreaterThan(0); expect(south).toBeGreaterThan(0);
  });
  test("precautionary areas normalize as polygons without ORIENT", () => {
    const areas = prcareFixture.features.map((f) => P.normalizeLane(f, "precaution", "coastal"));
    expect(areas.length).toBe(3);
    expect(areas[0].orient).toBeNull();
    expect(areas[0].inform).toBe("SF");
  });
  test("laneAt finds the lane containing a point in it", () => {
    const lanes = tssFixture.features.map((f) => P.normalizeLane(f, "lane", "coastal"));
    const c = lanes[0].centroid;
    const hit = P.laneAt(c.lat, c.lon, lanes);
    expect(hit).not.toBeNull();
    expect(P.laneAt(WEST_POINT.lat, WEST_POINT.lon + 0.2, lanes)).toBeNull();   // over Magnolia, on land
  });
  test("dedupe keeps coastal features that no harbour polygon covers", () => {
    const lanes = tssFixture.features.map((f) => P.normalizeLane(f, "lane", "coastal"));
    const harbour = { ...lanes[0], id: "h", scale: "harbour" };
    const out = P.dedupeLanes([harbour, ...lanes]);
    expect(out.find((l) => l.id === "h")).toBeDefined();
    expect(out.find((l) => l.id === lanes[0].id)).toBeUndefined();   // same polygon, covered
    expect(out.length).toBe(lanes.length);                             // 1 harbour + 7 uncovered coastal
  });
  test("envelopeParams builds a 4326 envelope query", () => {
    const q = P.envelopeParams(P.bboxAround(WEST_POINT.lat, WEST_POINT.lon, 10000), ["*"], true);
    expect(q.get("geometryType")).toBe("esriGeometryEnvelope");
    expect(q.get("outSR")).toBe("4326");
    const [w, s, e, n] = q.get("geometry").split(",").map(Number);
    expect(e - w).toBeCloseTo(0.266, 2);   // 20 km of longitude at 47.66N
    expect(n - s).toBeCloseTo(0.180, 2);
  });
  test("fetchLanes hits harbour + coastal layers and merges", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const body = url.includes("/155/") ? tssFixture : url.includes("/152/") ? prcareFixture : { features: [] };
      return { ok: true, json: async () => body };
    };
    const lanes = await P.fetchLanes(WEST_POINT.lat, WEST_POINT.lon, 15000, fetchImpl);
    expect(calls.length).toBe(10);
    expect(calls.some((u) => u.includes("enc_harbour/MapServer/215/query"))).toBe(true);
    expect(lanes.filter((l) => l.kind === "lane").length).toBe(8);
    expect(lanes.filter((l) => l.kind === "precaution").length).toBe(3);
  });
});

describe("AIS providers", () => {
  test("Digitraffic positions + static ingest into VesselTable", () => {
    const t = new P.VesselTable();
    const n = P.ingestDigitrafficLocations(t, dtLocations);
    expect(n).toBe(dtLocations.features.length);
    expect(t.size).toBe(n);
    const v = P.ingestDigitrafficVessel(t, dtVessel);
    expect(v.name).toBe("VARTIOLAIVA 55");
    expect(v.draught).toBeCloseTo(2.1, 5);
    expect(v.length).toBe(35); expect(v.beam).toBe(6);
    expect(v.shipTypeName).toBe("Wing in ground");
    expect(v.flag).toBe("FI");
  });
  test("snapshot dead-reckons moving vessels and drops stale ones", () => {
    const t = new P.VesselTable({ maxAgeMs: 60e3 });
    const now = 1_000_000_000_000;
    t.upsertPosition({ mmsi: 1, lat: 60, lon: 25, sog: 12, cog: 90, heading: 90, navStat: 0, at: now - 30e3 });
    t.upsertPosition({ mmsi: 2, lat: 60, lon: 25, sog: 12, cog: 90, heading: 90, navStat: 5, at: now - 30e3 });   // moored: no DR
    t.upsertPosition({ mmsi: 3, lat: 60, lon: 25, sog: 12, cog: 90, navStat: 0, at: now - 120e3 });            // stale
    const s = t.snapshot(now);
    expect(s.length).toBe(2);
    const a = s.find((v) => v.mmsi === 1), b = s.find((v) => v.mmsi === 2);
    expect(a.drLon).toBeGreaterThan(25); expect(b.drLon).toBe(25);
    expect(Geo.haversine(60, 25, a.drLat, a.drLon)).toBeCloseTo(12 * Geo.KN * 30, -1);
    expect(a.navStatName).toBe("Under way using engine");
    expect(t.size).toBe(2);
  });
  test("invalid AIS sentinels (sog 102.3, cog 360, hdg 511) become null", () => {
    const t = new P.VesselTable();
    const v = t.upsertPosition({ mmsi: 9, lat: 60, lon: 25, sog: 102.3, cog: 360, heading: 511, navStat: 15 });
    expect(v.sog).toBeNull(); expect(v.cog).toBeNull(); expect(v.heading).toBeNull();
  });
  test("ship type table", () => {
    expect(P.shipType(70)).toEqual({ name: "Cargo", category: "cargo" });
    expect(P.shipType(81).name).toBe("Tanker (hazard A)");
    expect(P.shipType(60).category).toBe("passenger");
    expect(P.shipType(36).category).toBe("pleasure");
    expect(P.shipType(null).category).toBe("unknown");
  });
  test("provider selection by coverage", () => {
    expect(P.aisProviderFor(60.15, 24.95).id).toBe("digitraffic");
    expect(P.aisProviderFor(WEST_POINT.lat, WEST_POINT.lon)).toBeNull();
  });
  test("restPoller polls locations and fetches static data for newcomers", async () => {
    const t = new P.VesselTable({ maxAgeMs: 1e15 });   // fixture timestamps are fixed in the past
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.includes("/locations")) return { ok: true, json: async () => dtLocations };
      return { ok: true, json: async () => ({ ...dtVessel, mmsi: Number(url.split("/").pop()) }) };
    };
    let updates = 0;
    const h = P.restPoller("https://x/api", {})({ table: t, fetch: fetchImpl, pollMs: 60e3, getCenter: () => ({ lat: 60.15, lon: 24.95, radiusM: 8000 }), onUpdate: () => updates++, onError: (e) => { throw e; } });
    await new Promise((r) => setTimeout(r, 20));
    h.stop();
    expect(calls[0]).toContain("/locations?latitude=60.15000&longitude=24.95000&radius=8");
    expect(calls.filter((u) => u.includes("/vessels/")).length).toBe(6);   // batched newcomers
    expect(updates).toBeGreaterThan(1);
    expect(t.snapshot().filter((v) => v.name).length).toBe(6);
  });
  test("demo provider seeds ships in the lanes and moves them", async () => {
    const t = new P.VesselTable();
    const lanes = tssFixture.features.map((f) => P.normalizeLane(f, "lane", "coastal"));
    const h = P.AIS_PROVIDERS.demo.start({ table: t, lanes, getCenter: () => ({ lat: WEST_POINT.lat, lon: WEST_POINT.lon, radiusM: 10000 }), onUpdate() {}, onError() {} });
    const first = t.snapshot();
    expect(first.length).toBe(9);   // 6 lane ships + ferry + sailboat + anchored tug
    const ship = first.find((v) => v.mmsi === 366000000);
    expect(P.laneAt(ship.lat, ship.lon, lanes)).not.toBeNull();
    expect(ship.name).toBe("EVER GLORY");
    h.stop();
  });
});

describe("Land occlusion (ENC LNDARE)", () => {
  const landFixture = require("./fixture_land.json");
  const land = P.normalizeLand(landFixture.features, "harbour");
  const ELLIOTT_BAY = { lat: 47.61, lon: -122.37 };       // behind Magnolia from West Point
  const GOLDEN_GARDENS = { lat: 47.69, lon: -122.43 };    // open water to the north
  const MID_SOUND = { lat: 47.66, lon: -122.50 };         // due west, open water
  const LAKE_UNION = { lat: 47.64, lon: -122.335 };       // behind Queen Anne hill from anywhere on the Sound

  test("normalizes every ring with a bbox", () => {
    expect(land.length).toBeGreaterThan(20);
    for (const L of land) { expect(L.ring.length).toBeGreaterThanOrEqual(3); expect(L.bbox.length).toBe(4); }
  });
  test("segmentsCross: crossing, touching and disjoint", () => {
    expect(Geo.segmentsCross(0, 0, 2, 2, 0, 2, 2, 0)).toBe(true);
    expect(Geo.segmentsCross(0, 0, 1, 1, 1, 1, 2, 0)).toBe(true);     // shared endpoint
    expect(Geo.segmentsCross(0, 0, 1, 1, 2, 2, 3, 3)).toBe(false);    // collinear, disjoint
    expect(Geo.segmentsCross(0, 0, 1, 0, 0, 1, 1, 1)).toBe(false);    // parallel
  });
  test("ringCrossings on a unit square", () => {
    const sq = [[0, 0], [2, 0], [2, 2], [0, 2]];
    const ts = Geo.ringCrossings(-1, 1, 3, 1, sq);
    expect(ts.length).toBe(2); expect(ts[0]).toBeCloseTo(0.25, 6); expect(ts[1]).toBeCloseTo(0.75, 6);
    expect(Geo.ringCrossings(-1, 3, 3, 3, sq)).toEqual([]);
    expect(Geo.ringCrossings(-1, 3, 3, 3, sq, Geo.ringBBox(sq))).toEqual([]);   // bbox reject path
  });
  test("a ship in Elliott Bay is hidden behind Magnolia from West Point", () => {
    const o = Geo.landOcclusion(WEST_POINT.lat, WEST_POINT.lon, ELLIOTT_BAY.lat, ELLIOTT_BAY.lon, land);
    expect(o).not.toBeNull();
    expect(o.distanceM).toBeGreaterThan(500);                 // the bluff starts a good way off
    expect(o.distanceM).toBeLessThan(Geo.haversine(WEST_POINT.lat, WEST_POINT.lon, ELLIOTT_BAY.lat, ELLIOTT_BAY.lon));
  });
  test("open water to the north and west is clear", () => {
    expect(Geo.landOcclusion(WEST_POINT.lat, WEST_POINT.lon, GOLDEN_GARDENS.lat, GOLDEN_GARDENS.lon, land)).toBeNull();
    expect(Geo.landOcclusion(WEST_POINT.lat, WEST_POINT.lon, MID_SOUND.lat, MID_SOUND.lon, land)).toBeNull();
  });
  test("viewer standing on land sees past their own shore", () => {
    const bluff = { lat: 47.655, lon: -122.42 };              // Discovery Park, inside the Magnolia polygon
    expect(land.some((L) => Geo.pointInRing(bluff.lat, bluff.lon, L.ring))).toBe(true);
    expect(Geo.landOcclusion(bluff.lat, bluff.lon, MID_SOUND.lat, MID_SOUND.lon, land)).toBeNull();
    expect(Geo.landOcclusion(bluff.lat, bluff.lon, LAKE_UNION.lat, LAKE_UNION.lon, land)).not.toBeNull();
  });
  test("targets closer than the grace distance are never occluded", () => {
    const near = Geo.destination(WEST_POINT.lat, WEST_POINT.lon, 100, 40);
    expect(Geo.landOcclusion(WEST_POINT.lat, WEST_POINT.lon, near.lat, near.lon, land)).toBeNull();
  });
  test("fetchLand asks for generalised harbour polygons and falls back to coastal", async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => (url.includes("/233/") ? { features: [] } : landFixture) }; };
    const r = await P.fetchLand(WEST_POINT.lat, WEST_POINT.lon, 20000, fetchImpl);
    expect(calls.length).toBe(2);
    expect(calls[0]).toContain("enc_harbour/MapServer/233/query"); expect(calls[1]).toContain("enc_coastal/MapServer/171/query");
    expect(new URL(calls[0]).searchParams.get("maxAllowableOffset")).toMatch(/^0\.00027/);   // 30 m at 47.66N
    expect(r.land.length).toBe(land.length);
  });
});

describe("proxy.js: aisstream -> Digitraffic shape", () => {
  test("ingests PositionReport and ShipStaticData", () => {
    Proxy.vessels.clear();
    Proxy.ingest({ MessageType: "PositionReport", MetaData: { MMSI: 366123456, ShipName: "TEST SHIP  " }, Message: { PositionReport: { Latitude: 47.6, Longitude: -122.4, Sog: 10.5, Cog: 180.2, TrueHeading: 181, NavigationalStatus: 0, RateOfTurn: 0, PositionAccuracy: true } } });
    Proxy.ingest({ MessageType: "ShipStaticData", MetaData: { MMSI: 366123456 }, Message: { ShipStaticData: { Name: "TEST SHIP", CallSign: "WDX1", ImoNumber: 9000001, Type: 70, Dimension: { A: 100, B: 50, C: 10, D: 12 }, MaximumStaticDraught: 8.5, Destination: "SEATTLE" } } });
    const v = Proxy.vessels.get(366123456);
    expect(v.pos.lat).toBe(47.6); expect(v.static.name).toBe("TEST SHIP"); expect(v.static.dims.a).toBe(100);
  });
  test("/ais/locations and /ais/vessels answer in Digitraffic format, which VesselTable ingests", () => {
    const state = Proxy._state; state.box = Proxy.boxAround(47.6, -122.4, 1000);   // pretend subscribed
    const resOf = () => { const r = { headers: {}, body: "" , writeHead(s, h) { r.status = s; r.headers = h; }, end(b) { r.body = b; } }; return r; };
    process.env.AISSTREAM_API_KEY = process.env.AISSTREAM_API_KEY || "";
    // handleAis refuses without a key; test the shape by re-requiring with a key would need a fresh module, so exercise the key path only if present
    const r = resOf();
    Proxy.handleAis(new URL("http://x/ais/locations?latitude=47.6&longitude=-122.4&radius=10"), r);
    if (r.status === 503) { expect(JSON.parse(r.body).error).toContain("AISSTREAM_API_KEY"); return; }
    const t = new P.VesselTable();
    expect(P.ingestDigitrafficLocations(t, JSON.parse(r.body))).toBe(1);
    const r2 = resOf();
    Proxy.handleAis(new URL("http://x/ais/vessels/366123456"), r2);
    const v = P.ingestDigitrafficVessel(t, JSON.parse(r2.body));
    expect(v.draught).toBeCloseTo(8.5, 5); expect(v.length).toBe(150);
  });
  test("bounding box helpers", () => {
    const box = Proxy.boxAround(47.6, -122.4, 20);
    expect(box[0][0]).toBeGreaterThan(47.6); expect(box[1][0]).toBeLessThan(47.6);
    expect(Proxy.boxContains(box, 47.6, -122.4, 10)).toBe(true);
    expect(Proxy.boxContains(box, 47.6, -122.4, 30)).toBe(false);
    expect(Proxy.boxContains(box, 48.5, -122.4, 5)).toBe(false);
  });
});

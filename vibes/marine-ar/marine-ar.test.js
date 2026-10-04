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

describe("Screen clipping (2 fps regression)", () => {
  const rect = [-640, -330, 1920, 990];
  test("polygon fully inside is returned unchanged", () => {
    const poly = [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 100 }];
    expect(Geo.clipPolygonToRect(poly, rect)).toBe(poly);
  });
  test("near-plane vertex millions of px away is clipped into the padded rect, area inside kept", () => {
    const poly = [{ x: 600, y: 400, depth: 900 }, { x: 700, y: 400, depth: 900 }, { x: 10780067, y: 5e6, depth: 0.5 }, { x: 650, y: 9e6, depth: 0.5 }];
    const c = Geo.clipPolygonToRect(poly, rect);
    expect(c.length).toBeGreaterThanOrEqual(3);
    for (const p of c) { expect(p.x).toBeGreaterThanOrEqual(-640 - 1e-6); expect(p.x).toBeLessThanOrEqual(1920 + 1e-6); expect(p.y).toBeLessThanOrEqual(990 + 1e-6); }
    expect(c.some((p) => p.x === 600 && p.y === 400)).toBe(true);            // original on-screen vertices survive
    let per = 0; for (let i = 0; i < c.length; i++) { const a = c[i], b = c[(i + 1) % c.length]; per += Math.hypot(b.x - a.x, b.y - a.y); }
    expect(per).toBeLessThan(10000);                                           // was ~46 million px of dashes
    expect(c.every((p) => typeof p.depth === "number")).toBe(true);            // depth interpolated for arrow culling
  });
  test("polygon entirely off-screen disappears", () => {
    expect(Geo.clipPolygonToRect([{ x: 5000, y: 5000 }, { x: 6000, y: 5000 }, { x: 6000, y: 6000 }], rect)).toEqual([]);
  });
  test("polyline split into visible runs", () => {
    const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 1e7, y: 0 }, { x: 1e7, y: 100 }, { x: 200, y: 100 }, { x: 300, y: 100 }];
    const pieces = Geo.clipPolylineToRect(line, rect);
    expect(pieces.length).toBe(2);
    expect(pieces[0][pieces[0].length - 1].x).toBeCloseTo(1920);
    expect(pieces[1][0].x).toBeCloseTo(1920); expect(pieces[1][pieces[1].length - 1].x).toBe(300);
  });
  test("Camera.projectSeaRing never returns far-off coordinates for a lane that passes beside the viewer", () => {
    const cam = new Geo.Camera({ width: 1280, height: 660, hfov: 60, eyeHeight: 18 });
    cam.setOrientation(300, -6, 0);
    const lat0 = 47.6603, lon0 = -122.4412;
    // a 6 km x 1 km lane that runs right past the viewer and behind them
    const ring = [[-122.452, 47.63], [-122.437, 47.63], [-122.437, 47.69], [-122.452, 47.69], [-122.452, 47.63]];
    const poly = cam.projectSeaRing(ring, lat0, lon0);
    for (const p of poly) { expect(Math.abs(p.x)).toBeLessThan(2000); expect(Math.abs(p.y)).toBeLessThan(1000); }
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
    expect(P.aisProviderFor(WEST_POINT.lat, WEST_POINT.lon).id).toBe("openseafeed");   // worldwide community feed outside Finland
  });
  test("aisstream frames -> VesselTable (OpenSeaFeed / aisstream.io protocol)", () => {
    const t = new P.VesselTable({ maxAgeMs: 1e15 });
    const frames = require("./fixture_openseafeed.json");
    const kinds = frames.map((f) => P.ingestAisstreamFrame(t, f, 1790487200000));
    expect(kinds.filter((k) => k === "pos").length).toBe(4);
    expect(kinds.filter((k) => k === "static").length).toBe(1);
    const andiamo = t.get(338477073);
    expect(andiamo.name).toBe("ANDIAMO");                  // from MetaData on the position report
    expect(andiamo.category).toBe("pleasure");             // MetaData.ShipType 37
    expect(andiamo.heading).toBe(287);
    expect(andiamo.staticAt).toBeFalsy();                  // metadata name is not static data
    const wen = t.get(366772750);
    expect(wen.name).toBe("WENATCHEE"); expect(wen.length).toBe(140); expect(wen.draught).toBe(5.5); expect(wen.destination).toBe("SEATTLE");
    expect(wen.staticAt).toBe(1790487200000);
    expect(P.ingestAisstreamFrame(t, { MessageType: "Nonsense", MetaData: { MMSI: 1 }, Message: { Nonsense: {} } })).toBeNull();
    expect(P.ingestAisstreamFrame(t, { error: "free tier is limited" })).toBeNull();
  });
  test("aisstream box: padded, clamped, tiny against the 30 000 deg² free tier", () => {
    const b = P.aisstreamBox(WEST_POINT.lat, WEST_POINT.lon, 15000)[0];
    expect(b[0][0]).toBeLessThan(WEST_POINT.lat); expect(b[1][0]).toBeGreaterThan(WEST_POINT.lat);
    expect(b[0][1]).toBeLessThan(WEST_POINT.lon); expect(b[1][1]).toBeGreaterThan(WEST_POINT.lon);
    const area = (b[1][0] - b[0][0]) * (b[1][1] - b[0][1]);
    expect(area).toBeGreaterThan(0.1); expect(area).toBeLessThan(0.5);
    const polar = P.aisstreamBox(89.9, 179.9, 50000)[0];
    expect(polar[1][0]).toBe(90); expect(polar[1][1]).toBe(180);
  });
  test("lookupMissingStatic fills names from /v1/vessels, caches hits and misses, nearest nameless first", async () => {
    const t = new P.VesselTable({ maxAgeMs: 1e15 });
    t.upsertPosition({ mmsi: 1, lat: 47.70, lon: -122.44, sog: 5, at: Date.now() });            // nameless, 4.4 km
    t.upsertPosition({ mmsi: 2, lat: 47.665, lon: -122.44, sog: 5, at: Date.now() });           // nameless, 0.5 km -> first
    t.upsertPosition({ mmsi: 3, lat: 47.661, lon: -122.44, sog: 5, at: Date.now() }); t.upsertStatic({ mmsi: 3, name: "KNOWN" }); t.get(3).staticAt = 0;   // named via metadata, nearest
    const storage = new Map(), ls = { getItem: (k) => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) };
    const cache = new P.StaticCache({ storage: ls });
    const calls = [];
    const fetchImpl = async (u) => { calls.push(u); const m = Number(u.split("/").pop());
      if (m === 2) return { ok: true, json: async () => ({ mmsi: 2, name: "WSF PUYALLUP", type: 60, imo: 9137363, callsign: "WCY7938", dest: "FERRY TERMINAL", draught: 5.6, len: 140, beam: 28 }) };
      if (m === 1) return { ok: true, json: async () => ({ mmsi: 1, lat: 47.7, lon: -122.44, sog: 5 }) };   // OSF knows the position only
      return { ok: false, status: 404 }; };
    const inflight = new Set(); let updates = 0;
    const n = P.lookupMissingStatic(t, { base: "https://x/v1/vessels", cache, fetchImpl, inflight, limit: 2, center: { lat: 47.6603, lon: -122.4412 }, onUpdate: () => updates++ });
    expect(n).toBe(2);
    expect(calls.map((u) => u.split("/").pop())).toEqual(["2", "1"]);          // nameless before named, nearest first
    await new Promise((r) => setTimeout(r, 10));
    const v2 = t.get(2);
    expect(v2.name).toBe("WSF PUYALLUP"); expect(v2.length).toBe(140); expect(v2.beam).toBe(28); expect(v2.dims.a).toBe(70); expect(v2.draught).toBe(5.6); expect(v2.imo).toBe(9137363);
    expect(t.get(1).name).toBeFalsy(); expect(t.get(1).staticAt).toBeTruthy();   // looked up, nothing known, not retried this session
    expect(updates).toBe(1);
    expect(cache.get(2).name).toBe("WSF PUYALLUP"); expect(cache.get(1)).toBeNull();   // miss remembered
    cache.flush();
    const again = new P.StaticCache({ storage: ls });                                   // fresh page load
    expect(again.get(2).name).toBe("WSF PUYALLUP");
    const t2 = new P.VesselTable({ maxAgeMs: 1e15 }); t2.upsertPosition({ mmsi: 2, lat: 47.665, lon: -122.44, sog: 5, at: Date.now() });
    const calls2 = [];
    P.lookupMissingStatic(t2, { base: "https://x/v1/vessels", cache: again, fetchImpl: async (u) => { calls2.push(u); return { ok: false, status: 500 }; }, inflight: new Set(), limit: 3 });
    expect(calls2.length).toBe(0); expect(t2.get(2).name).toBe("WSF PUYALLUP");      // served from cache, no request
  });
  test("aisstreamSocket subscribes with a box, ingests, reconnects on close", async () => {
    const sent = [], sockets = [];
    class FakeWS {
      constructor(url) { this.url = url; this.readyState = 0; sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 1); }
      send(d) { sent.push(JSON.parse(d)); setTimeout(() => { for (const f of require("./fixture_openseafeed.json")) this.onmessage({ data: JSON.stringify(f) }); }, 1); }
      close(code) { this.readyState = 3; const cb = this.onclose; this.onclose = null; cb && cb({ code: code || 1000 }); }
    }
    const t = new P.VesselTable({ maxAgeMs: 1e15 });
    let updates = 0, errors = [];
    const h = P.aisstreamSocket("wss://x/v1/stream")({ table: t, WebSocket: FakeWS, pollMs: 5, getCenter: () => ({ lat: WEST_POINT.lat, lon: WEST_POINT.lon, radiusM: 10000 }), onUpdate: () => updates++, onError: (e) => errors.push(e.message) });
    await new Promise((r) => setTimeout(r, 30));
    expect(sockets.length).toBe(1);
    expect(sent[0].BoundingBoxes.length).toBe(1); expect(sent[0].APIKey).toBeUndefined();
    expect(t.snapshot().length).toBe(4); expect(updates).toBeGreaterThan(0);
    sockets[0].onclose({ code: 1006 });                    // server dropped us
    await new Promise((r) => setTimeout(r, 1100));
    expect(sockets.length).toBe(2);                        // reconnected after backoff
    expect(errors.some((e) => /closed \(1006\)/.test(e))).toBe(true);
    h.stop();
    expect(sockets[1].readyState).toBe(3);
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
  test("a lighthouse on the shore is not hidden by its own shore", () => {
    const wpLight = { lat: 47.66185, lon: -122.43508 };       // West Point Light, on the point
    expect(land.some((L) => Geo.pointInRing(wpLight.lat, wpLight.lon, L.ring))).toBe(true);
    const fromSea = Geo.destination(WEST_POINT.lat, WEST_POINT.lon, 270, 800);
    expect(Geo.landOcclusion(fromSea.lat, fromSea.lon, wpLight.lat, wpLight.lon, land)).toBeNull();
    // but a light in Lake Union is behind Queen Anne from the same spot
    expect(Geo.landOcclusion(fromSea.lat, fromSea.lon, LAKE_UNION.lat, LAKE_UNION.lon, land)).not.toBeNull();
  });
  test("targets closer than the grace distance are never occluded", () => {
    const near = Geo.destination(WEST_POINT.lat, WEST_POINT.lon, 100, 40);
    expect(Geo.landOcclusion(WEST_POINT.lat, WEST_POINT.lon, near.lat, near.lon, land)).toBeNull();
  });
  test("fetchLand asks for generalised harbour polygons and falls back to coastal", async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => (url.includes("/233/") ? { features: [] } : landFixture) }; };
    const r = await P.fetchLand(WEST_POINT.lat, WEST_POINT.lon, 20000, fetchImpl);
    expect(calls.length).toBe(4);   // harbour land + harbour/coastal LNDELV, then coastal land fallback
    expect(calls[0]).toContain("enc_harbour/MapServer/233/query"); expect(calls[3]).toContain("enc_coastal/MapServer/171/query");
    expect(calls.some((u) => u.includes("enc_harbour/MapServer/39/query"))).toBe(true);
    expect(new URL(calls[0]).searchParams.get("maxAllowableOffset")).toMatch(/^0\.00027/);   // 30 m at 47.66N
    expect(r.land.length).toBe(land.length);
  });
});

describe("Elevation-aware occlusion (ENC LNDELV)", () => {
  // a 2 km long, 1 km wide island 3 km north of the viewer, on the way to a target 8 km north
  const V = { lat: 47.5, lon: -122.5 };
  const mk = (e, n) => { const p = Geo.fromENU(V.lat, V.lon, e, n); return [p.lon, p.lat]; };
  const island = { ring: [mk(-500, 3000), mk(500, 3000), mk(500, 5000), mk(-500, 5000)] };
  island.bbox = Geo.ringBBox(island.ring);
  const T = Geo.fromENU(V.lat, V.lon, 0, 8000);

  test("map-plane call (no heights) is unchanged: the island blocks", () => {
    const o = Geo.landOcclusion(V.lat, V.lon, T.lat, T.lon, [island]);
    expect(o).not.toBeNull(); expect(o.opaque).toBe(true); expect(o.distanceM).toBeCloseTo(3000, -1);
  });
  test("uncharted height is opaque by default, or assumed unknownElevM", () => {
    expect(Geo.landOcclusion(V.lat, V.lon, T.lat, T.lon, [island], { eyeM: 2, targetM: 30 }).opaque).toBe(true);
    // a 2 m sand spit: eye at 2 m, 30 m ship at 8 km -> line of sight is ~13 m up at 3 km, clear
    expect(Geo.landOcclusion(V.lat, V.lon, T.lat, T.lon, [island], { eyeM: 2, targetM: 30, unknownElevM: 2 })).toBeNull();
  });
  test("a charted 20 m island hides a 5 m boat but not a 60 m cruise ship", () => {
    const low = { ...island, elev: 20 };
    const boat = Geo.landOcclusion(V.lat, V.lon, T.lat, T.lon, [low], { eyeM: 2, targetM: 5 });
    expect(boat).not.toBeNull(); expect(boat.opaque).toBe(false); expect(boat.elevM).toBe(20);
    expect(Geo.landOcclusion(V.lat, V.lon, T.lat, T.lon, [low], { eyeM: 2, targetM: 60 })).toBeNull();
  });
  test("a viewer on a 100 m bluff sees over a 20 m island", () => {
    const low = { ...island, elev: 20 };
    expect(Geo.landOcclusion(V.lat, V.lon, T.lat, T.lon, [low], { eyeM: 100, targetM: 5 })).toBeNull();
    // but not over a 90 m one (line of sight is ~40 m up at the island's far side)
    expect(Geo.landOcclusion(V.lat, V.lon, T.lat, T.lon, [{ ...island, elev: 90 }], { eyeM: 100, targetM: 5 })).not.toBeNull();
  });
  test("spot heights near the entry point stand in for a ring without elev", () => {
    const spots = [{ lat: island.ring[0][1], lon: island.ring[0][0], elev: 150 }];
    const o = Geo.landOcclusion(V.lat, V.lon, T.lat, T.lon, [island], { eyeM: 2, targetM: 60, unknownElevM: 2, spots });
    expect(o).not.toBeNull(); expect(o.elevM).toBe(150);
  });
  test("curvature: a 20 km sight line to a 10 m target from 2 m is blocked by an 8 m islet at 15 km", () => {
    const far = Geo.fromENU(V.lat, V.lon, 0, 20000);
    const islet = { ring: [mk(-200, 15000), mk(200, 15000), mk(200, 15400), mk(-200, 15400)], elev: 8 };
    islet.bbox = Geo.ringBBox(islet.ring);
    // flat earth would clear this (los ≈ 8 m at 15 km); the 15 m curvature drop does not
    expect(Geo.landOcclusion(V.lat, V.lon, far.lat, far.lon, [islet], { eyeM: 2, targetM: 10 })).not.toBeNull();
  });
  test("estimateAirDraught", () => {
    expect(Geo.estimateAirDraught(300, "passenger")).toBe(60);
    expect(Geo.estimateAirDraught(300, "cargo")).toBe(36);
    expect(Geo.estimateAirDraught(null)).toBe(5);
    expect(Geo.estimateAirDraught(12, "pleasure")).toBeCloseTo(4.8, 5);
  });
  test("attachElevations puts Puget Sound spot heights on their rings", () => {
    const land = P.normalizeLand(require("./fixture_land.json").features, "harbour");
    const spots = require("./fixture_lndelv.json").features.map((f) => ({ lat: f.geometry.y, lon: f.geometry.x, elev: f.attributes.ELEVAT }));
    expect(spots.length).toBe(70);
    P.attachElevations(land, spots);
    // the West Point fixture box holds no LNDELV spot heights (Seattle cells chart none), so every ring stays unknown
    expect(land.every((L) => L.elev == null)).toBe(true);
    // a synthetic ring around the 150 m hill at 47.38N picks it up
    const hill = { ring: [[-122.42, 47.37], [-122.40, 47.37], [-122.40, 47.39], [-122.42, 47.39]] }; hill.bbox = Geo.ringBBox(hill.ring);
    P.attachElevations([hill], spots);
    expect(hill.elev).toBe(150);
  });
});

describe("Aids to navigation (ENC Direct)", () => {
  const lights = require("./fixture_aton_lights.json").features.map((f) => P.normalizeAton(f, "LIGHTS", "harbour"));
  const boys = require("./fixture_aton_boylat.json").features.map((f) => P.normalizeAton(f, "BOYLAT", "harbour"));
  const bcns = require("./fixture_aton_bcnlat.json").features.map((f) => P.normalizeAton(f, "BCNLAT", "harbour"));
  test("normalizes buoys with colour, shape and lateral meaning", () => {
    const wp = boys.find((b) => /West Point Lighted Buoy 1/.test(b.name));
    expect(wp).toBeDefined(); expect(wp.color).toBe("#31d158"); expect(wp.shape).toBe("pillar"); expect(wp.lateral).toBe("port hand");
    expect(Geo.haversine(wp.lat, wp.lon, WEST_POINT.lat, WEST_POINT.lon)).toBeLessThan(60);
  });
  test("light characters read like the chart", () => {
    const c = lights.map((l) => l.light.character);
    expect(c).toContain("Fl R 4s 4M");
    expect(c).toContain("Fl(5) Y 20s");
  });
  test("mergeAton puts lights on their structures and keeps loose lights", () => {
    const all = P.mergeAton([...boys, ...bcns, ...lights]);
    const shil = all.find((a) => a.name === "Shilshole Bay Light 8");
    expect(shil.kind).toBe("BCNLAT"); expect(shil.light.character).toBe("Fl R 4s 4M"); expect(shil.heightM).toBeCloseTo(4.6, 5);
    const loose = all.filter((a) => a.kind === "LIGHTS");
    expect(loose.length).toBeGreaterThan(0); expect(loose.length).toBeLessThan(lights.length);
    // overlapping cells chart the same buoy twice; one per position survives
    const positions = (xs) => new Set(xs.map((a) => a.lat.toFixed(4) + "," + a.lon.toFixed(4))).size;
    expect(all.filter((a) => a.kind === "BOYLAT").length).toBe(positions(boys));
    expect(positions(boys)).toBeLessThan(boys.length);
  });
  test("fetchAton queries every harbour + coastal point layer", async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => (url.includes("enc_harbour/MapServer/11/") ? require("./fixture_aton_lights.json") : { features: [] }) }; };
    const r = await P.fetchAton(WEST_POINT.lat, WEST_POINT.lon, 5000, fetchImpl);
    expect(calls.length).toBe(11);                                   // harbour answered, coastal skipped
    expect(calls.every((u) => u.includes("enc_harbour/"))).toBe(true);
    const empty = []; await P.fetchAton(WEST_POINT.lat, WEST_POINT.lon, 5000, async (u) => { empty.push(u); return { ok: true, json: async () => ({ features: [] }) }; });
    expect(empty.length).toBe(21);                                   // nothing at harbour scale -> coastal too
    expect(r.length).toBe(new Set(lights.map((a) => a.lat.toFixed(4) + "," + a.lon.toFixed(4))).size);
  });
});

describe("Light rhythms", () => {
  const sched = (c, p, g) => Geo.lightSchedule(c, p, g).on.map((x) => x.map((v) => +v.toFixed(2)));
  test("characters produce the textbook on/off patterns", () => {
    expect(Geo.lightSchedule(1).on).toEqual([[0, 1, 0]]);                                   // F: always on
    expect(sched(2, 4)).toEqual([[0, 0.5, 0]]);                                          // Fl 4s
    expect(sched(2, 10, "(2)")).toEqual([[0, 0.5, 0], [1.2, 1.7, 0]]);                    // Fl(2) 10s
    expect(sched(2, 15, "(2+1)")).toEqual([[0, 0.5, 0], [1.2, 1.7, 0], [3.7, 4.2, 0]]);  // Fl(2+1) 15s: composite group
    expect(sched(3, 10)).toEqual([[0, 2, 0]]);                                           // LFl 10s: 2 s flash
    expect(Geo.lightSchedule(4).period).toBe(1); expect(sched(4)).toEqual([[0, 0.5, 0]]);  // Q: 60/min
    expect(Geo.lightSchedule(5).period).toBe(0.5);                                         // VQ: 120/min
    expect(sched(7, 4)).toEqual([[0, 2, 0]]);                                            // Iso 4s
    expect(sched(8, 4)).toEqual([[0, 3, 0]]);                                            // Oc 4s: 3 s light, 1 s dark
    expect(sched(8, 10, "(2)")).toEqual([[0, 5.5, 0], [7, 8.5, 0]]);                      // Oc(2) 10s: two eclipses
    expect(sched(28, 4)).toEqual([[0, 2, 0], [2, 4, 1]]);                                 // Al WR: colour slots alternate
    expect(sched(19, 10)).toEqual([[0, 0.5, 0], [5, 5.5, 1]]);                            // AlFl WR 10s
    expect(sched(25, 15).length).toBe(7);                                                // Q(6)+LFl 15s: six quick + one long
  });
  test("lightState: lit slot or -1, with per-light phase", () => {
    const s = Geo.lightSchedule(2, 4);
    expect(Geo.lightState(s, 0.2)).toBe(0); expect(Geo.lightState(s, 1)).toBe(-1); expect(Geo.lightState(s, 4.1)).toBe(0);
    expect(Geo.lightState(s, 1, 3.2)).toBe(0);                                             // phase shifts the schedule
    const al = Geo.lightSchedule(28, 4); expect(Geo.lightState(al, 3)).toBe(1);
    const oc = Geo.lightSchedule(8, 4); let lit = 0; for (let t = 0; t < 4; t += 0.01) if (Geo.lightState(oc, t) >= 0) lit++; expect(lit / 400).toBeCloseTo(0.75, 1);
  });
  test("sun altitude: Seattle solstice noon ~66°, midnight ~-19°, equinox sunset near 0", () => {
    expect(Geo.sunAltitude(47.6, -122.4, new Date("2026-06-21T20:15:00Z"))).toBeCloseTo(65.8, 0);
    expect(Geo.sunAltitude(47.6, -122.4, new Date("2026-06-21T08:15:00Z"))).toBeCloseTo(-19, 0);
    expect(Math.abs(Geo.sunAltitude(47.6, -122.4, new Date("2026-09-23T02:05:00Z")))).toBeLessThan(2);   // sunset 19:05 PDT
  });
  test("normalizeAton keeps the raw character for the rhythm engine", () => {
    const lights = require("./fixture_aton_lights.json");
    const a = P.normalizeAton(lights.features.find((f) => f.attributes.SIGPER), "LIGHTS", "harbour");
    expect(a.light.chr).toBeGreaterThan(0); expect(a.light.periodS).toBeGreaterThan(0); expect(a.light.colours.length).toBeGreaterThan(0);
    const s = Geo.lightSchedule(a.light.chr, a.light.periodS, a.light.group);
    expect(s.period).toBe(a.light.periodS);
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

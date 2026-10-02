// bun test  -- lateral marks (red/green buoy gates) and overhead clearance (bridges, cables).
const { test, expect, describe } = require("bun:test");
const fs = require("fs");
const Router = require("./router.js");
const S57 = require("./s57.js");
const Nav = require("./nav.js");

const poly = (w, s, e, n) => ({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const area = (d, g) => ({ properties: { DRVAL1: d, DRVAL2: d + 10 }, geometry: g });
const mark = (lat, lon, side, name) => ({ lat, lon, kind: "BOYLAT", name, props: { CATLAM: side === "port" ? 1 : 2, COLOUR: side === "port" ? "4" : "3", OBJNAM: name } });
const BBOX = [-122.5, 47.5, -122.4, 47.6];
const base = (extra) => Object.assign({ bbox: BBOX, depthAreas: [area(20, poly(...BBOX))], dredgedAreas: [], land: [], hazards: [], lateralMarks: [], overheads: [] }, extra);
const OPTS = { requiredDepth: 2, cellM: 25, marginM: 50, comfortM: 100 };

// Cells the A* path visits, as lat/lon
const pathLatLon = r => r.cellPath.map(i => Router.cellCenter(r.grid, i % r.grid.cols, Math.floor(i / r.grid.cols)));
function crosses(r, a, b) {
  // does any leg of the simplified route intersect segment a-b?
  const o = (p, q, s) => Math.sign((q.lon - p.lon) * (s.lat - p.lat) - (q.lat - p.lat) * (s.lon - p.lon));
  for (let k = 1; k < r.waypoints.length; k++) {
    const p1 = r.waypoints[k - 1], p2 = r.waypoints[k];
    if (o(p1, p2, a) !== o(p1, p2, b) && o(a, b, p1) !== o(a, b, p2)) return true;
  }
  return false;
}

describe("lateral marks", () => {
  test("markSide / markColour decode CATLAM and COLOUR", () => {
    expect(Router.markSide({ CATLAM: 1 })).toBe("port");
    expect(Router.markSide({ CATLAM: "2" })).toBe("starboard");
    expect(Router.markSide({ CATLAM: 3 })).toBe("junction");
    expect(Router.markColour({ COLOUR: "3" })).toBe("red");
    expect(Router.markColour({ COLOUR: "4,3" })).toBe("green");
  });

  test("a red/green pair becomes a gate the route must pass through", () => {
    // Gate 300 m wide in open deep water, red to the east (IALA-B: red to starboard when
    // heading north = returning). The direct line passes ~260 m outside the green mark.
    const red = mark(47.55, -122.448, "starboard", "R2"), green = mark(47.55, -122.452, "port", "G1");
    const data = base({ lateralMarks: [red, green] });
    const from = { lat: 47.53, lon: -122.4555 }, to = { lat: 47.57, lon: -122.4555 };
    const free = Router.route(data, from, to, { ...OPTS, lateral: false });
    expect(free.error).toBeUndefined();
    expect(crosses(free, red, green)).toBe(false);          // straight past the outside of G1
    const r = Router.route(data, from, to, OPTS);
    expect(r.error).toBeUndefined();
    expect(r.stats.lateral.gates).toBe(1);
    expect(crosses(r, red, green)).toBe(true);
    expect(r.stats.lateral.gatesPassed.length).toBe(1);
    // northbound: red (east of track) passed to starboard, green to port: "red right returning"
    const gp = r.stats.lateral.gatesPassed[0].marks;
    expect(gp.find(m => m.colour === "red").passedTo).toBe("starboard");
    expect(gp.find(m => m.colour === "green").passedTo).toBe("port");
    expect(r.warnings).toEqual([]);
  });

  test("southbound through the same gate reports red to port", () => {
    const red = mark(47.55, -122.448, "starboard", "R2"), green = mark(47.55, -122.452, "port", "G1");
    const r = Router.route(base({ lateralMarks: [red, green] }), { lat: 47.57, lon: -122.4555 }, { lat: 47.53, lon: -122.4555 }, OPTS);
    expect(crosses(r, red, green)).toBe(true);
    expect(r.stats.lateral.gatesPassed[0].marks.find(m => m.colour === "red").passedTo).toBe("port");
  });

  test("an unpaired mark keeps the route off the shoal side", () => {
    // Shoal 1 m deep south of a lone green mark 280 m off it. Direct line runs between mark and shoal.
    const shoal = area(1, poly(-122.46, 47.545, -122.44, 47.555));
    const g = mark(47.5575, -122.45, "port", "G3");
    const data = base({ depthAreas: [area(20, poly(...BBOX)), shoal], lateralMarks: [g] });
    const from = { lat: 47.557, lon: -122.49 }, to = { lat: 47.557, lon: -122.41 };
    const free = Router.route(data, from, to, { ...OPTS, lateral: false });
    const atMarkFree = pathLatLon(free).filter(c => Math.abs(c.lon - g.lon) < 0.0003);
    expect(atMarkFree.every(c => c.lat < g.lat)).toBe(true);   // between mark and shoal
    const r = Router.route(data, from, to, OPTS);
    expect(r.error).toBeUndefined();
    const atMark = pathLatLon(r).filter(c => Math.abs(c.lon - g.lon) < 0.0003);
    expect(atMark.length).toBeGreaterThan(0);
    expect(atMark.every(c => c.lat > g.lat)).toBe(true);       // outside the mark, away from its shoal
  });

  test("falls back with a warning when marks make the route impossible", () => {
    // A breakwater with a 900 m opening; the marked channel between R and G has shoaled to 1 m
    // (chart newer than the buoys). Depth alone allows passing outside either mark; the gate walls
    // close those gaps, so the router retries without marks and says so.
    const land = [{ properties: {}, geometry: poly(-122.5, 47.548, -122.456, 47.552) }, { properties: {}, geometry: poly(-122.444, 47.548, -122.4, 47.552) }];
    const shoal = area(1, poly(-122.4516, 47.5485, -122.4484, 47.5515));
    const red = mark(47.55, -122.4485, "starboard", "R4"), green = mark(47.55, -122.4515, "port", "G3");
    const data = base({ depthAreas: [area(20, poly(...BBOX)), shoal], land, lateralMarks: [red, green] });
    const r = Router.route(data, { lat: 47.53, lon: -122.45 }, { lat: 47.57, lon: -122.45 }, OPTS);
    expect(r.error).toBeUndefined();
    expect(r.warnings.some(w => /lateral mark/.test(w))).toBe(true);
    expect(crosses(r, red, green)).toBe(false);
  });

  test("adaptive margin squeezes through narrow water and says so", () => {
    // 60 m wide cut through a land bar; the requested 50 m margin would close it
    const land = [{ properties: {}, geometry: poly(-122.5, 47.548, -122.4504, 47.552) }, { properties: {}, geometry: poly(-122.4496, 47.548, -122.4, 47.552) }];
    const data = base({ land });
    const r = Router.route(data, { lat: 47.53, lon: -122.45 }, { lat: 47.57, lon: -122.45 }, OPTS);
    expect(r.error).toBeUndefined();
    expect(r.stats.marginM).toBeLessThan(50);
    expect(r.warnings.join()).toMatch(/Narrow water/);
    expect(Router.route(data, { lat: 47.53, lon: -122.45 }, { lat: 47.57, lon: -122.45 }, { ...OPTS, adaptiveMargin: false }).error).toBeDefined();
  });

  test("disconnected water fails fast with a clear message", () => {
    const land = [{ properties: {}, geometry: poly(-122.5, 47.548, -122.4, 47.552) }];
    const t = Date.now();
    const r = Router.route(base({ land }), { lat: 47.53, lon: -122.45 }, { lat: 47.57, lon: -122.45 }, OPTS);
    expect(r.error).toMatch(/not connected/);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("overhead clearance", () => {
  // E-W channel 600 m wide between land north and south, bridge spanning it at lon -122.45
  const landN = { properties: {}, geometry: poly(-122.5, 47.555, -122.4, 47.6) };
  const landS = { properties: {}, geometry: poly(-122.5, 47.5, -122.4, 47.5496) };
  const span = poly(-122.4505, 47.548, -122.4495, 47.557);
  const bridge = (props) => ({ kind: "bridge", geometry: span, properties: Object.assign({ OBJNAM: "Test Bridge" }, props) });
  const from = { lat: 47.5523, lon: -122.49 }, to = { lat: 47.5523, lon: -122.41 };
  const data = (o) => base({ land: [landN, landS], overheads: [o] });

  test("fixed bridge lower than mast + headroom blocks and is named", () => {
    const r = Router.route(data(bridge({ CATBRG: 1, VERCLR: 10 })), from, to, { ...OPTS, airDraft: 12 });
    expect(r.error).toMatch(/Test Bridge/);
    expect(r.error).toMatch(/10\.0 m/);
    expect(r.blockedBy.length).toBe(1);
  });

  test("fixed bridge high enough is passed and reported", () => {
    const r = Router.route(data(bridge({ CATBRG: 1, VERCLR: 10 })), from, to, { ...OPTS, airDraft: 8 });
    expect(r.error).toBeUndefined();
    expect(r.stats.overheads.map(o => o.name)).toEqual(["Test Bridge"]);
    expect(r.stats.neededClearance).toBe(9);
    expect(r.warnings).toEqual([]);
  });

  test("headroom is added to the air draft", () => {
    expect(Router.route(data(bridge({ CATBRG: 1, VERCLR: 10 })), from, to, { ...OPTS, airDraft: 9.5 }).error).toBeDefined();
    expect(Router.route(data(bridge({ CATBRG: 1, VERCLR: 10 })), from, to, { ...OPTS, airDraft: 9.5, headroomM: 0.2 }).error).toBeUndefined();
  });

  test("no air draft means overheads never block", () => {
    const r = Router.route(data(bridge({ CATBRG: 1, VERCLR: 2 })), from, to, OPTS);
    expect(r.error).toBeUndefined();
    expect(r.stats.overheads.length).toBe(1);
  });

  test("bascule bridge: passable with an 'opening required' warning", () => {
    const r = Router.route(data(bridge({ CATBRG: 5, VERCCL: 8.8 })), from, to, { ...OPTS, airDraft: 15 });
    expect(r.error).toBeUndefined();
    expect(r.warnings.join()).toMatch(/Test Bridge.*opening required/);
    // tall enough to clear it closed: no warning
    expect(Router.route(data(bridge({ CATBRG: 5, VERCCL: 8.8 })), from, to, { ...OPTS, airDraft: 6 }).warnings).toEqual([]);
  });

  test("lift bridge with a charted open clearance still too low blocks", () => {
    const r = Router.route(data(bridge({ CATBRG: 4, VERCCL: 6, VERCOP: 14 })), from, to, { ...OPTS, airDraft: 15 });
    expect(r.error).toMatch(/Test Bridge/);
  });

  test("uncharted clearance blocks by default, warns when allowed", () => {
    const o = bridge({ CATBRG: 1 });
    expect(Router.route(data(o), from, to, { ...OPTS, airDraft: 12 }).error).toMatch(/clearance not charted/);
    const r = Router.route(data(o), from, to, { ...OPTS, airDraft: 12, blockUnknownClearance: false });
    expect(r.error).toBeUndefined();
    expect(r.warnings.join()).toMatch(/clearance not charted/);
  });

  test("overhead cable uses the lower of VERCLR and safe clearance VERCSA", () => {
    const cable = { kind: "cable", geometry: { type: "LineString", coordinates: [[-122.45, 47.545], [-122.45, 47.56]] }, properties: { VERCLR: 20, VERCSA: 14 } };
    expect(Router.overheadInfo(cable).clearance).toBe(14);
    expect(Router.route(data(cable), from, to, { ...OPTS, airDraft: 14 }).error).toBeDefined();
    expect(Router.route(data(cable), from, to, { ...OPTS, airDraft: 12 }).error).toBeUndefined();
  });
});

describe("real NOAA cells", () => {
  const load = async (names) => {
    const cells = [];
    for (const n of names) cells.push(...await S57.loadEncArchive(fs.readFileSync(__dirname + "/charts/" + n + ".zip")));
    return S57.toRoutingData(cells);
  };

  test("cells carry lateral marks and bridge clearances", async () => {
    const d = await load(["US5SEAHI", "US5SEAGL", "US5SEAGK"]);
    expect(d.lateralMarks.length).toBeGreaterThanOrEqual(20);
    expect(d.lateralMarks.every(m => Router.markSide(m.props))).toBe(true);
    const info = d.overheads.map(Router.overheadInfo);
    // A bridge is several features: the navigable span carries the clearance, approach spans often none.
    const span = n => info.find(o => o.name === n && o.clearance != null);
    expect(span("Ballard Bridge")).toMatchObject({ opening: true, clearance: 8.8, category: "bascule" });
    expect(span("Fremont Bridge")).toMatchObject({ opening: true, clearance: 4.2, category: "bascule" });
    expect(span("George Washington Memorial Bridge")).toMatchObject({ opening: false, clearance: 22.2, category: "fixed" });
    expect(info.some(o => o.clearance === 22.8 && o.kind === "bridge")).toBe(true);  // Agate Pass Bridge
  });

  test("Agate Passage: 18 m mast passes under the 22.8 m bridge, 24 m mast is stopped", async () => {
    const d = await load(["US5SEAHI", "US5SEAHJ", "US5SEAGI", "US5SEAGJ"]);
    // Port Madison end (NE, 18 m) to the Port Orchard end (SW, 9 m) of Agate Passage
    const a = { lat: 47.7300, lon: -122.5450 }, b = { lat: 47.7000, lon: -122.5725 };
    const box = Router.routingBbox(a, b, 0.3, 1500);
    const data = Object.assign({}, d, { bbox: box });
    const opts = { requiredDepth: 2.8, marginM: 50, comfortM: 150, cellM: 25 };
    const ok = Router.route(data, a, b, { ...opts, airDraft: 18 });
    expect(ok.error).toBeUndefined();
    expect(ok.stats.overheads.some(o => o.clearance === 22.8)).toBe(true);
    const low = Router.route(data, a, b, { ...opts, airDraft: 24 });
    expect(low.error).toMatch(/Blocked overhead: .*22\.8 m.* < 25\.0 m needed/);
  });
});

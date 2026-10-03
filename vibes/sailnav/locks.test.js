// bun test  -- routing through the Ballard Locks and the non-tidal lake datum above them.
const { test, expect, describe } = require("bun:test");
const fs = require("fs");
const Router = require("./router.js");
const S57 = require("./s57.js");
const Chart = require("./chart.js");
const Nav = require("./nav.js");

const poly = (w, s, e, n) => ({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });

describe("synthetic lock", () => {
  // Sea (west) and lake (east) separated by a land dam with a 20 m chamber; 40 m grid.
  const BBOX = [-122.5, 47.5, -122.4, 47.6];
  const chamber = poly(-122.4505, 47.5499, -122.4495, 47.55008);  // ~75 m long, ~20 m wide
  const data = {
    bbox: BBOX,
    depthAreas: [{ properties: { DRVAL1: 10, DRVAL2: 20 }, geometry: poly(...BBOX) }],
    dredgedAreas: [{ properties: { DRVAL1: 6 }, geometry: chamber }],
    land: [{ properties: {}, geometry: poly(-122.4505, 47.5, -122.4495, 47.54990) }, { properties: {}, geometry: poly(-122.4505, 47.55008, -122.4495, 47.6) }],
    hazards: [], lateralMarks: [], overheads: [],
    gates: [
      { properties: { CATGAT: 4, HORCLR: 20 }, geometry: { type: "LineString", coordinates: [[-122.4505, 47.5499], [-122.4505, 47.55008]] } },
      { properties: { CATGAT: "lock gate", HORCLR: 20 }, geometry: { type: "LineString", coordinates: [[-122.4495, 47.5499], [-122.4495, 47.55008]] } },
    ],
  };
  const from = { lat: 47.55, lon: -122.48 }, to = { lat: 47.55, lon: -122.42 };

  test("lock gate detection accepts S-57 code and ENC Direct text", () => {
    expect(Router.isLockGate({ CATGAT: 4 })).toBe(true);
    expect(Router.isLockGate({ CATGAT: "lock gate" })).toBe(true);
    expect(Router.isLockGate({ CATGAT: 2 })).toBe(false);
  });

  test("a 20 m chamber is passable on a 40 m grid and is reported", () => {
    const r = Router.route(data, from, to, { requiredDepth: 2, cellM: 40, marginM: 80, adaptiveResolution: false });
    expect(r.error).toBeUndefined();
    expect(r.stats.locks.length).toBe(1);
    expect(r.stats.locks[0].width).toBe(20);
    expect(r.warnings.join()).toMatch(/Transits Lock/);
  });

  test("without gates the dam is closed", () => {
    const r = Router.route({ ...data, gates: [] }, from, to, { requiredDepth: 2, cellM: 40, marginM: 80, adaptiveResolution: false });
    expect(r.error).toMatch(/not connected/);
  });
});

describe("Ballard Locks on the bundled NOAA cells", () => {
  let all;
  const load = async () => {
    if (all) return all;
    const cells = [];
    for (const n of ["US5SEAGK", "US5SEAGL"]) cells.push(...await S57.loadEncArchive(fs.readFileSync(__dirname + "/charts/" + n + ".zip")));
    return (all = S57.toRoutingData(cells));
  };
  const SHILSHOLE = { lat: 47.6844, lon: -122.41132 }, LAKE_UNION = { lat: 47.6370, lon: -122.3370 };

  test("cells carry the five lock gates (2 small, 3 large), two chambers and the lake datum", async () => {
    const d = await load();
    const lg = d.gates.filter(g => Router.isLockGate(g.properties));
    expect(lg.map(g => g.properties.HORCLR).sort((a, b) => a - b)).toEqual([8.5, 8.5, 24.3, 24.3, 24.3]);
    expect(d.datumAreas.length).toBeGreaterThan(0);
    const g = Router.makeGrid([-122.41, 47.66, -122.388, 47.672], 20);
    const ch = Router.applyLocks(g, d, 3);
    expect(ch.map(c => c.width).sort((a, b) => a - b)).toEqual([8.5, 24.3]);
    expect(ch.every(c => /Ballard Locks/.test(c.name))).toBe(true);
  });

  test("Shilshole to Lake Union goes through the locks, opening required for a 15 m mast", async () => {
    const d = await load();
    const r = Router.route(Object.assign({}, d, { bbox: Router.routingBbox(SHILSHOLE, LAKE_UNION, 0.3, 1500) }), SHILSHOLE, LAKE_UNION,
      { requiredDepth: 2.8, marginM: 80, cellM: 40, maxCells: 1.2e6, airDraft: 15 });
    expect(r.error).toBeUndefined();
    expect(r.stats.locks.length).toBe(1);                     // one chamber, never both
    expect(r.warnings.join()).toMatch(/Transits Ballard Locks/);
    const names = new Set(r.stats.overheads.map(o => o.name));
    for (const n of ["Burlington Northern Railroad Bridge", "Ballard Bridge", "Fremont Bridge", "George Washington Memorial Bridge"]) expect(names.has(n)).toBe(true);
    for (const n of ["Ballard Bridge", "Fremont Bridge"]) expect(r.warnings.some(w => w.startsWith(n) && /opening required/.test(w))).toBe(true);
    expect(Nav.routeLength(r.waypoints) / Nav.NM).toBeGreaterThan(4);
    expect(Nav.routeLength(r.waypoints) / Nav.NM).toBeLessThan(5.5);
    // the lock leg starts and ends at waypoints: no leg crosses chamber walls
    const lockLeg = r.stats.locks[0].leg;
    expect(lockLeg).toBeGreaterThan(1);
  });

  test("a 23 m mast is stopped by the 22.2 m Aurora (George Washington Memorial) Bridge", async () => {
    const d = await load();
    const r = Router.route(Object.assign({}, d, { bbox: Router.routingBbox(SHILSHOLE, LAKE_UNION, 0.3, 1500) }), SHILSHOLE, LAKE_UNION,
      { requiredDepth: 2.8, marginM: 80, cellM: 40, maxCells: 1.2e6, airDraft: 23 });
    expect(r.error).toMatch(/George Washington Memorial Bridge/);
  });

  test("depth above the locks reports the lake datum, below the locks it does not", async () => {
    const d = await load();
    expect(S57.depthAt(d, 47.6370, -122.3370).datum.lake).toBe(true);
    expect(S57.depthAt(d, 47.6620, -122.3850).datum.lake).toBe(true);   // Salmon Bay, just above the locks
    expect(S57.depthAt(d, 47.6663, -122.4005).datum).toBeNull();       // below the locks: tidal, MLLW
    expect(S57.depthAt(d, 47.6844, -122.41132).datum).toBeNull();
  });
});

describe("lake level", () => {
  const at = s => new Date(s + "T12:00:00");
  test("follows the Corps schedule: 20 ft winter, 22 ft summer", () => {
    expect(Chart.lakeLevelFt(at("2026-01-15"))).toBe(20);
    expect(Chart.lakeLevelFt(at("2026-07-04"))).toBe(22);
    const apr = Chart.lakeLevelFt(at("2026-04-08"));
    expect(apr).toBeGreaterThan(20.5); expect(apr).toBeLessThan(21.5);
    const oct = Chart.lakeLevelFt(at("2026-10-15"));
    expect(oct).toBeGreaterThan(20.5); expect(oct).toBeLessThan(21.5);
  });
  test("height over chart datum (Low Water of the Lakes = 20 ft)", () => {
    expect(Chart.lakeHeightM(at("2026-07-04"))).toBeCloseTo(0.6096, 4);
    expect(Chart.lakeHeightM(at("2026-01-15"))).toBe(0);
    expect(Chart.lakeHeightM(at("2026-01-15"), 21.5)).toBeCloseTo(0.4572, 4);  // user-entered posted level
  });
});

describe("Lake Washington cells", () => {
  let all;
  const LAKE = ["US5SEAEM", "US5SEAEN", "US5SEAFM", "US5SEAFN", "US5SEAGM", "US5SEAGN", "US5SEAHM", "US5SEAHN"];
  const load = async () => {
    if (all) return all;
    const cells = [];
    for (const n of LAKE.concat(["US5SEAGL"])) cells.push(...await S57.loadEncArchive(fs.readFileSync(__dirname + "/charts/" + n + ".zip")));
    return (all = S57.toRoutingData(cells));
  };
  const sub = (d, a, b, pad) => Object.assign({}, d, { bbox: Router.routingBbox(a, b, 1.0, pad || 6000) });
  const crossLon = (r, lat) => { const w = r.waypoints; for (let k = 1; k < w.length; k++) if ((w[k - 1].lat - lat) * (w[k].lat - lat) < 0) { const f = (lat - w[k - 1].lat) / (w[k].lat - w[k - 1].lat); return w[k - 1].lon + f * (w[k].lon - w[k - 1].lon); } return null; };
  const LESCHI = { lat: 47.6010, lon: -122.2830 }, KIRKLAND = { lat: 47.6760, lon: -122.2130 }, RENTON = { lat: 47.5050, lon: -122.2100 };

  test("bundled in the catalog, all on the lake datum", async () => {
    const cat = JSON.parse(fs.readFileSync(__dirname + "/charts/catalog.json", "utf8"));
    for (const n of LAKE) expect(cat.cells.some(c => c.name === n)).toBe(true);
    const d = await load();
    for (const p of [LESCHI, RENTON, { lat: 47.7530, lon: -122.2600 }]) expect(S57.depthAt(d, p.lat, p.lon).datum.lake).toBe(true);
  });

  test("CATBRG decodes codes and ENC Direct text", () => {
    const info = p => Router.overheadInfo({ kind: "bridge", properties: p });
    expect(info({ CATBRG: "bascule bridge", VERCCL: 9.7 })).toMatchObject({ opening: true, category: "bascule" });
    expect(info({ CATBRG: 5 })).toMatchObject({ opening: true });
    expect(info({ CATBRG: "pontoon bridge" })).toMatchObject({ floating: true, clearance: 0 });
    expect(info({ CATBRG: "fixed bridge", VERCLR: 12 })).toMatchObject({ opening: false, floating: false, clearance: 12 });
  });

  test("SR 520 floating bridge: blocks even with no mast set, passable only under the high-rise spans", async () => {
    const d = await load();
    for (const mast of [null, 6]) {
      const r = Router.route(sub(d, LESCHI, KIRKLAND), LESCHI, KIRKLAND, { requiredDepth: 2.8, marginM: 80, cellM: 40, airDraft: mast });
      expect(r.error).toBeUndefined();
      const lon = crossLon(r, 47.6405);
      // west high-rise (12.4 m) is at the Seattle end; the pontoons run -122.274 .. -122.244
      expect(lon < -122.2735 || lon > -122.2440).toBe(true);
    }
    const r15 = Router.route(sub(d, LESCHI, KIRKLAND), LESCHI, KIRKLAND, { requiredDepth: 2.8, marginM: 80, cellM: 40, airDraft: 15 });
    expect(r15.stats.overheads.some(o => o.name === "Evergreen Point Bridge - East Span" && o.clearance === 20.4)).toBe(true);
    const r22 = Router.route(sub(d, LESCHI, KIRKLAND), LESCHI, KIRKLAND, { requiredDepth: 2.8, marginM: 80, cellM: 40, airDraft: 22 });
    expect(r22.error).toMatch(/East Span \(20\.4 m\).*highest span/);
  });

  test("I-90: the 2.4 km bridge charted at 8.8 m is only passable near its piers; 15 m mast goes east of Mercer Island", async () => {
    const d = await load();
    const r = Router.route(sub(d, LESCHI, RENTON), LESCHI, RENTON, { requiredDepth: 2.8, marginM: 80, cellM: 40, airDraft: 6 });
    expect(r.error).toBeUndefined();
    const lon = crossLon(r, 47.5897);
    expect(Math.min(Math.abs(lon + 122.2825), Math.abs(lon + 122.2576))).toBeLessThan(0.0035);   // within ~260 m of a pier pair
    const r15 = Router.route(sub(d, LESCHI, RENTON), LESCHI, RENTON, { requiredDepth: 2.8, marginM: 80, cellM: 40, airDraft: 15 });
    expect(r15.error).toBeUndefined();
    expect(crossLon(r15, 47.5897)).toBeGreaterThan(-122.23);                                      // East Channel, 21.6 m
    expect(r15.stats.overheads.some(o => o.clearance === 21.6)).toBe(true);
  });

  test("Lake Union to Union Bay through the Montlake Cut", async () => {
    const d = await load();
    const a = { lat: 47.6370, lon: -122.3370 }, b = { lat: 47.6520, lon: -122.2800 };
    const r = Router.route(sub(d, a, b, 2500), a, b, { requiredDepth: 2.8, marginM: 80, cellM: 40, airDraft: 15 });
    expect(r.error).toBeUndefined();
    for (const n of ["University Bridge", "Montlake Bridge"]) expect(r.warnings.some(w => w.startsWith(n) && /opening required/.test(w))).toBe(true);
  });
});

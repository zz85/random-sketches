// bun test  -- S-57 / ISO 8211 reader tests.
// Uses the real NOAA cell US5SEAGK (Shilshole / West Point). The zip is fetched once
// from charts.noaa.gov into /tmp when missing; tests are skipped offline.
const { test, expect, describe } = require("bun:test");
const fs = require("fs");
const S57 = require("./s57.js");
const Router = require("./router.js");
const Nav = require("./nav.js");

const ZIP = "/tmp/enc/US5SEAGK.zip";
async function fixture() {
  if (fs.existsSync(ZIP)) return fs.readFileSync(ZIP);
  try {
    const r = await fetch("https://charts.noaa.gov/ENCs/US5SEAGK.zip");
    if (!r.ok) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    fs.mkdirSync("/tmp/enc", { recursive: true }); fs.writeFileSync(ZIP, b);
    return b;
  } catch (e) { return null; }
}

describe("ISO 8211 format parsing", () => {
  test("parseFormat handles nested parens and repeat counts", () => {
    expect(S57.parseFormat("(B(40),4b11)")).toEqual([{ kind: "B", width: 5 }, { kind: "b11", width: null }, { kind: "b11", width: null }, { kind: "b11", width: null }, { kind: "b11", width: null }]);
    expect(S57.parseFormat("(b11,b14,2b11,3A,2A(8),R(4),b11,2A,b11,b12,A)").length).toBe(16);
    expect(S57.parseFormat("(3b24)")).toEqual([{ kind: "b24", width: null }, { kind: "b24", width: null }, { kind: "b24", width: null }]);
    expect(S57.parseFormat("(2b24)")[1].kind).toBe("b24");
  });
});

describe("S-57 cell US5SEAGK", () => {
  test("unzips and parses the cell with browser-style APIs", async () => {
    const zip = await fixture(); if (!zip) { console.warn("skipped: no fixture"); return; }
    const files = await S57.unzip(zip, n => /\.000$/.test(n));
    expect(files.length).toBe(1);
    expect(files[0].name).toMatch(/US5SEAGK\.000$/);
    const cell = S57.parseCell(files[0].bytes);
    expect(cell.dsnm).toBe("US5SEAGK.000");
    expect(cell.scale).toBe(12000);
    expect(cell.comf).toBe(10000000);
    expect(cell.stats.features).toBeGreaterThan(1000);
    const klasses = new Set(cell.features.map(f => f.klass));
    for (const k of ["DEPARE", "LNDARE", "SOUNDG", "DEPCNT", "UWTROC", "LIGHTS", "M_COVR"]) expect(klasses.has(k)).toBe(true);
    const b = S57.cellBounds(cell);
    expect(b[0]).toBeCloseTo(-122.475, 3); expect(b[3]).toBeCloseTo(47.7, 3);
  });

  test("loadEncArchive accepts a zip and a bare .000", async () => {
    const zip = await fixture(); if (!zip) return;
    const [a] = await S57.loadEncArchive(zip);
    const raw = (await S57.unzip(zip, n => /\.000$/.test(n)))[0].bytes;
    const [b] = await S57.loadEncArchive(raw);
    expect(a.features.length).toBe(b.features.length);
  });

  test("polygons close and depth areas carry DRVAL1/DRVAL2", async () => {
    const zip = await fixture(); if (!zip) return;
    const [cell] = await S57.loadEncArchive(zip);
    const areas = cell.features.filter(f => f.klass === "DEPARE");
    expect(areas.length).toBeGreaterThan(50);
    for (const f of areas) {
      const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const p of polys) for (const ring of p) {
        expect(ring.length).toBeGreaterThanOrEqual(4);
        expect(ring[0][0]).toBeCloseTo(ring[ring.length - 1][0], 9);
        expect(ring[0][1]).toBeCloseTo(ring[ring.length - 1][1], 9);
      }
      expect(typeof f.properties.DRVAL1).toBe("number");
    }
    // Soundings: multipoint with depth in metres (SOMF = 10)
    const snd = cell.features.find(f => f.klass === "SOUNDG");
    expect(snd.geometry.type).toBe("MultiPoint");
    expect(snd.geometry.coordinates[0].length).toBe(3);
    expect(snd.geometry.coordinates.every(c => c[2] > -5 && c[2] < 400)).toBe(true);
  });

  test("local depthAt matches known values (verified against NOAA ENC Direct)", async () => {
    const zip = await fixture(); if (!zip) return;
    const [cell] = await S57.loadEncArchive(zip);
    const data = S57.toRoutingData(cell);
    expect(data.soundings.length).toBeGreaterThan(500);
    const d = S57.depthAt(data, 47.6844, -122.41132, { soundingRadiusM: 200 });
    expect(d.band).toEqual({ min: 9.1, max: 182.8 });
    expect(d.sounding.depth).toBe(20.7);
    expect(d.sounding.distM).toBeCloseTo(39.6, 0);
    expect(d.land).toBe(false);
    // West Point lighthouse is land
    expect(S57.depthAt(data, 47.6620, -122.4353).land).toBe(true);
    // Shilshole marina basin is dredged / shallow band
    const marina = S57.depthAt(data, 47.6810, -122.4060);
    expect(marina.band === null || marina.band.min < 9.1 || marina.dredged !== null || marina.land).toBe(true);
  });

  test("routes on local data around West Point", async () => {
    const zip = await fixture(); if (!zip) return;
    const [cell] = await S57.loadEncArchive(zip);
    const data = S57.toRoutingData(cell);
    const r = Router.route(data, { lat: 47.6844, lon: -122.41132 }, { lat: 47.6400, lon: -122.4300 }, { requiredDepth: 3, cellM: 30, marginM: 80 });
    expect(r.error).toBeUndefined();
    expect(r.waypoints.length).toBeGreaterThanOrEqual(3);
    expect(r.stats.minChartedDepth).toBeGreaterThanOrEqual(3);
    // must pass west of West Point (lon < -122.44 at lat ~47.66)
    const west = r.waypoints.some(w => w.lat > 47.655 && w.lat < 47.67 && w.lon < -122.441) ||
      r.cellPath.some(i => { const c = Router.cellCenter(r.grid, i % r.grid.cols, Math.floor(i / r.grid.cols)); return c.lat > 47.655 && c.lat < 47.67 && c.lon < -122.441; });
    expect(west).toBe(true);
    expect(Nav.routeLength(r.waypoints) / Nav.NM).toBeGreaterThan(3);
  });
});

describe("bundled charts/ catalog", () => {
  test("every bundled cell parses with finite soundings and hazards, catalog bboxes match", async () => {
    const cat = JSON.parse(fs.readFileSync(__dirname + "/charts/catalog.json", "utf8"));
    expect(cat.cells.length).toBeGreaterThan(50);
    let soundings = 0;
    for (const c of cat.cells) {
      const [cell] = await S57.loadEncArchive(fs.readFileSync(__dirname + "/charts/" + c.file));
      expect(cell.dsnm).toBe(c.name + ".000");
      const b = S57.cellBounds(cell);
      for (let i = 0; i < 4; i++) expect(b[i]).toBeCloseTo(c.bbox[i], 3);
      const d = S57.toRoutingData(cell);
      for (const s of d.soundings) { expect(isFinite(s.lat) && isFinite(s.lon) && isFinite(s.depth)).toBe(true); }
      for (const h of d.hazards) { expect(isFinite(h.lat) && isFinite(h.lon) && isFinite(h.depth)).toBe(true); }
      soundings += d.soundings.length;
    }
    expect(soundings).toBeGreaterThan(10000);
  });
});

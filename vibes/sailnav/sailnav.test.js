// bun test  (run from vibes/sailnav)
const { test, expect, describe } = require("bun:test");
const Nav = require("./nav.js");
const Router = require("./router.js");
const Chart = require("./chart.js");

const SHILSHOLE = { lat: 47.6844, lon: -122.41132 };   // STYC start line
const BLAKE = { lat: 47.52667, lon: -122.5 };           // Blake Island
const WEST_POINT = { lat: 47.66028, lon: -122.44112 };

describe("Nav geometry", () => {
  test("haversine and rhumb agree over Puget Sound distances", () => {
    const gc = Nav.haversine(SHILSHOLE.lat, SHILSHOLE.lon, BLAKE.lat, BLAKE.lon);
    const rl = Nav.rhumb(SHILSHOLE.lat, SHILSHOLE.lon, BLAKE.lat, BLAKE.lon);
    expect(gc / Nav.NM).toBeCloseTo(10.1, 0);          // ~10 NM
    expect(Math.abs(gc - rl.distance)).toBeLessThan(5); // metres
    expect(rl.bearing).toBeGreaterThan(195);
    expect(rl.bearing).toBeLessThan(205);
  });

  test("destination inverts bearing/distance", () => {
    const d = Nav.destination(SHILSHOLE.lat, SHILSHOLE.lon, 200, 5 * Nav.NM);
    expect(Nav.haversine(SHILSHOLE.lat, SHILSHOLE.lon, d.lat, d.lon)).toBeCloseTo(5 * Nav.NM, 0);
    expect(Nav.bearing(SHILSHOLE.lat, SHILSHOLE.lon, d.lat, d.lon)).toBeCloseTo(200, 3);
    const r = Nav.rhumbDestination(SHILSHOLE.lat, SHILSHOLE.lon, 90, 2 * Nav.NM);
    expect(r.lat).toBeCloseTo(SHILSHOLE.lat, 6);        // due east keeps latitude
    expect(Nav.rhumb(SHILSHOLE.lat, SHILSHOLE.lon, r.lat, r.lon).distance).toBeCloseTo(2 * Nav.NM, 0);
  });

  test("legProgress: XTE sign, along-track, arrival (OpenCPN semantics)", () => {
    const from = { lat: 47.60, lon: -122.45 }, to = { lat: 47.70, lon: -122.45 }; // leg due north
    // boat 200 m east of the line, halfway -> right of track, positive XTE
    const boat = Nav.fromEN(200, 0, 47.65, -122.45);
    const p = Nav.legProgress(from, to, { ...boat, sog: 3, cog: 0 }, 100);
    expect(p.xte).toBeCloseTo(200, -1);
    expect(p.legCourse).toBeCloseTo(0, 0);
    expect(p.alongTrack / Nav.NM).toBeCloseTo(3.0, 0);   // 0.05 deg lat = 3 NM
    expect(p.vmg).toBeCloseTo(3 * Math.cos((0 - p.brg) * Math.PI / 180), 5);
    expect(p.arrived).toBe(false);
    // boat 50 m short of the perpendicular through the waypoint but 300 m off -> arrives (normal crossing)
    const near = Nav.fromEN(300, -50, to.lat, to.lon);
    const q = Nav.legProgress(from, to, near, 100);
    expect(q.alongTrack).toBeCloseTo(50, -1);
    expect(q.arrived).toBe(true);
    // negative radius never arrives (MOB)
    expect(Nav.legProgress(from, to, near, -1).arrived).toBe(false);
    // boat west of line -> negative XTE
    const west = Nav.fromEN(-150, 0, 47.65, -122.45);
    expect(Nav.legProgress(from, to, west).xte).toBeCloseTo(-150, -1);
  });

  test("route length and legs", () => {
    const pts = [SHILSHOLE, WEST_POINT, BLAKE];
    const legs = Nav.routeLegs(pts);
    expect(legs.length).toBe(2);
    expect(legs[1].cumulative).toBeCloseTo(Nav.routeLength(pts), 6);
    expect(Nav.eta(Nav.NM, Nav.NM / 3600, 0).getTime()).toBeCloseTo(3600 * 1000, -1);
  });

  test("formatting", () => {
    expect(Nav.fmtPos(47.6844, -122.41132)).toBe("47\u00B041.064'N 122\u00B024.679'W");
    expect(Nav.fmtBrg(5.4)).toBe("005\u00B0");
    expect(Nav.fmtNm(1852)).toBe("1.00 NM");
    expect(Nav.fmtNm(90)).toBe("90 m");
    expect(Nav.fmtDuration(3725)).toBe("1:02:05");
    expect(Nav.fmtDepth(9.1, "ft")).toBe("30");
    expect(Nav.fmtDepth(9.1, "fm")).toBe("5.0");
    expect(Nav.depthToMetres(10, "ft")).toBeCloseTo(3.048, 3);
  });

  test("parseLatLon accepts common formats", () => {
    expect(Nav.parseLatLon("47.6844, -122.41132")).toEqual({ lat: 47.6844, lon: -122.41132 });
    const dm = Nav.parseLatLon("47\u00B041.064'N 122\u00B024.679'W");
    expect(dm.lat).toBeCloseTo(47.6844, 4); expect(dm.lon).toBeCloseTo(-122.41132, 4);
    const dms = Nav.parseLatLon("47 41 03.8 N 122 24 40.7 W");
    expect(dms.lat).toBeCloseTo(47.6844, 3); expect(dms.lon).toBeCloseTo(-122.4113, 3);
    expect(Nav.parseLatLon("https://www.google.com/maps/@47.68,-122.41,15z").lat).toBe(47.68);
    expect(Nav.parseLatLon("hello")).toBeNull();
  });
});

describe("Chart helpers", () => {
  test("S-52 DEPARE01 banding", () => {
    // shallow 2, safety 5, deep 20
    expect(Chart.depthBand(0, 2, 2, 5, 20)).toBe("DEPVS");
    expect(Chart.depthBand(2, 5, 2, 5, 20)).toBe("DEPMS");
    expect(Chart.depthBand(5, 10, 2, 5, 20)).toBe("DEPMD");
    expect(Chart.depthBand(9.1, 182.8, 2, 5, 20)).toBe("DEPVS" === "x" ? "" : "DEPMD");
    expect(Chart.depthBand(20, 50, 2, 5, 20)).toBe("DEPDW");
    expect(Chart.depthBand(-2, 0, 2, 5, 20)).toBe("DEPIT");
    expect(Chart.depthBand(null, null, 2, 5, 20)).toBe("NODTA");
  });
  test("tile bounds and URL", () => {
    const b = Chart.tileBounds3857(0, 0, 0);
    expect(b[0]).toBeCloseTo(-20037508.34, 1); expect(b[3]).toBeCloseTo(20037508.34, 1);
    const u = Chart.encTileUrl(655, 1429, 12, { scheme: 2, safety: 4 });
    expect(u).toContain("bboxSR=3857");
    expect(decodeURIComponent(u)).toContain('"ColorScheme","value":2');
    expect(decodeURIComponent(u)).toContain('"TwoDepthShades","value":2');
  });
  test("hazard depth defaults follow OBSTRN04/WRECKS02", () => {
    const f = (props) => ({ properties: props, geometry: { coordinates: [-122.4, 47.6] } });
    expect(Chart.tagHazard(f({ VALSOU: 7.2 }), "rock").depth).toBe(7.2);
    expect(Chart.tagHazard(f({}), "rock").depth).toBe(-15);
    expect(Chart.tagHazard(f({ WATLEV: 3 }), "rock").depth).toBe(0.01);
    expect(Chart.tagHazard(f({ CATWRK: 1 }), "wreck").depth).toBe(20);
    expect(Chart.tagHazard(f({ CATWRK: 2 }), "wreck").depth).toBe(0);
  });
  test("tide interpolation", () => {
    const tide = { series: [{ t: 0, h: 1 }, { t: 1000, h: 3 }] };
    expect(Chart.tideAt(tide, 500)).toBe(2);
    expect(Chart.tideAt(tide, -5)).toBe(1);
    expect(Chart.tideAt(tide, 5000)).toBe(3);
    expect(Chart.nearestTideStation(47.68, -122.41).name).toBe("Seattle");
  });
});

// Synthetic harbour: a rectangle of water with a land island and a shallow bar.
function syntheticData() {
  const bbox = [-122.5, 47.5, -122.4, 47.6];
  const poly = (w, s, e, n) => ({ type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
  return {
    bbox,
    depthAreas: [
      { properties: { DRVAL1: 10, DRVAL2: 50 }, geometry: poly(-122.5, 47.5, -122.4, 47.6) },
      // shallow bar 1.5 m across the middle, gap on the east side
      { properties: { DRVAL1: 1.5, DRVAL2: 3 }, geometry: poly(-122.5, 47.548, -122.43, 47.552) },
    ],
    dredgedAreas: [],
    land: [{ properties: {}, geometry: poly(-122.47, 47.56, -122.44, 47.58) }],  // island north of bar
    hazards: [{ kind: "rock", depth: 0.5, lat: 47.53, lon: -122.45 }],
  };
}

describe("Router", () => {
  test("rasterize paints depths, land and keeps the shallower value", () => {
    const data = syntheticData();
    const g = Router.rasterize(Router.makeGrid(data.bbox, 100), data);
    const deep = Router.toCell(g, 47.51, -122.49), bar = Router.toCell(g, 47.55, -122.48), isl = Router.toCell(g, 47.57, -122.455);
    expect(g.minDepth[deep.y * g.cols + deep.x]).toBe(10);
    expect(g.minDepth[bar.y * g.cols + bar.x]).toBe(1.5);
    expect(g.minDepth[isl.y * g.cols + isl.x]).toBe(Router.LAND);
  });

  test("routes around land, respects draft, and hazards", () => {
    const data = syntheticData();
    const from = { lat: 47.51, lon: -122.45 }, to = { lat: 47.59, lon: -122.45 };
    // 2 m draft: must use the east gap in the bar and go around the island
    const r = Router.route(data, from, to, { requiredDepth: 2, cellM: 60, marginM: 100, comfortM: 200 });
    expect(r.error).toBeUndefined();
    expect(r.waypoints.length).toBeGreaterThan(2);
    expect(r.waypoints[0]).toEqual(from);
    expect(r.waypoints[r.waypoints.length - 1]).toEqual(to);
    expect(r.stats.minChartedDepth).toBeGreaterThanOrEqual(2);
    // Every waypoint must be in water deep enough and off the island
    for (const wp of r.waypoints.slice(1, -1)) {
      const c = Router.toCell(r.grid, wp.lat, wp.lon);
      expect(r.grid.minDepth[c.y * r.grid.cols + c.x]).toBeGreaterThanOrEqual(2);
    }
    // Some waypoint crosses the bar line east of the gap edge (-122.43)
    const crossing = r.waypoints.find(w => w.lat > 47.548 && w.lat < 47.552) ||
      r.waypoints.find((w, i) => i > 0 && (r.waypoints[i - 1].lat - 47.55) * (w.lat - 47.55) < 0);
    expect(crossing).toBeDefined();
    // Hazard at 47.53,-122.45 lies on the direct line; route must not pass within 40 m
    for (const i of r.cellPath) {
      const c = Router.cellCenter(r.grid, i % r.grid.cols, Math.floor(i / r.grid.cols));
      expect(Nav.haversine(c.lat, c.lon, 47.53, -122.45)).toBeGreaterThan(40);
    }
    // 1 m draft can go straight over the bar: shorter route
    const r1 = Router.route(data, from, to, { requiredDepth: 1, cellM: 60, marginM: 100, comfortM: 200 });
    expect(Nav.routeLength(r1.waypoints)).toBeLessThan(Nav.routeLength(r.waypoints));
  });

  test("reports no route when the destination is on land or draft too deep", () => {
    const data = syntheticData();
    const r = Router.route(data, { lat: 47.51, lon: -122.45 }, { lat: 47.59, lon: -122.45 }, { requiredDepth: 60, cellM: 80 });
    expect(r.error).toBeDefined();
  });

  test("lineClear and simplify shorten paths", () => {
    const data = syntheticData();
    const r = Router.route(data, { lat: 47.505, lon: -122.49 }, { lat: 47.54, lon: -122.41 }, { requiredDepth: 2, cellM: 60 });
    expect(r.error).toBeUndefined();
    expect(r.waypoints.length).toBeLessThan(r.cellPath.length / 4);
  });

  test("routingBbox pads endpoints", () => {
    const b = Router.routingBbox(SHILSHOLE, BLAKE);
    expect(b[0]).toBeLessThan(-122.5); expect(b[2]).toBeGreaterThan(-122.41);
    expect(b[1]).toBeLessThan(47.52); expect(b[3]).toBeGreaterThan(47.69);
  });
});

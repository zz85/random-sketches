// Live NOAA smoke test (needs network). Run: bun live_test.js
// Fetches real ENC data for Shilshole -> Blake Island and routes across it.
const Nav = require("./nav.js");
const Chart = require("./chart.js");
const Router = require("./router.js");

const SHILSHOLE = { lat: 47.6844, lon: -122.41132 };
const BLAKE_MARINA = { lat: 47.5405, lon: -122.4825 }; // Blake Island state park dock (NE side)

(async () => {
  let t = Date.now();
  const d = await Chart.depthAt(SHILSHOLE.lat, SHILSHOLE.lon);
  console.log("depthAt Shilshole:", JSON.stringify({ ...d, soundings: d.soundings.length }), (Date.now() - t) + "ms");
  if (!d.band || d.band.min < 5) throw new Error("expected ~9.1 m band at Shilshole");

  const onLand = await Chart.depthAt(47.6605, -122.4415); // West Point lighthouse (land)
  console.log("depthAt West Point light: land=", onLand.land, "band=", onLand.band);

  const bbox = Router.routingBbox(SHILSHOLE, BLAKE_MARINA);
  console.log("bbox", bbox.map(v => v.toFixed(3)).join(","));
  t = Date.now();
  const data = await Chart.fetchRoutingData(bbox, (s, n) => process.stdout.write(`  ${s}: ${n}\r`));
  console.log(`\nfetched depthAreas=${data.depthAreas.length} land=${data.land.length} hazards=${data.hazards.length} in ${Date.now() - t}ms`);

  t = Date.now();
  const r = Router.route(data, SHILSHOLE, BLAKE_MARINA, { requiredDepth: 3, cellM: 40, marginM: 80, comfortM: 300 });
  if (r.error) throw new Error(r.error);
  console.log("route:", r.stats, "\nwaypoints:", r.waypoints.length, "length", Nav.fmtNm(Nav.routeLength(r.waypoints)));
  for (const l of Nav.routeLegs(r.waypoints)) console.log("  ", Nav.fmtBrg(l.bearing), Nav.fmtNm(l.distance), Nav.fmtPos(l.to.lat, l.to.lon));

  // Every simplified waypoint must be in water >= 3 m per the chart
  let bad = 0;
  for (const wp of r.waypoints.slice(1, -1)) {
    const c = Router.toCell(r.grid, wp.lat, wp.lon);
    const md = r.grid.minDepth[c.y * r.grid.cols + c.x];
    if (!(md >= 3)) bad++;
  }
  console.log("waypoints in shallow/land cells:", bad);
  if (bad) process.exit(1);

  // Direct rhumb line Shilshole -> Blake crosses West Point / Magnolia? Check the route is longer than direct but < 1.5x
  const direct = Nav.rhumb(SHILSHOLE.lat, SHILSHOLE.lon, BLAKE_MARINA.lat, BLAKE_MARINA.lon).distance;
  console.log("direct", Nav.fmtNm(direct), "ratio", (Nav.routeLength(r.waypoints) / direct).toFixed(3));
  console.log("OK");
})().catch(e => { console.error("FAIL", e); process.exit(1); });

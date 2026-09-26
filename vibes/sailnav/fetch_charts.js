#!/usr/bin/env bun
// Refresh the bundled NOAA ENC cells in ./charts and rebuild charts/catalog.json.
//
//   bun fetch_charts.js            # re-download every cell listed in charts/catalog.json (weekly NTM updates)
//   bun fetch_charts.js US5SEAGK   # add / refresh specific cells
//   bun fetch_charts.js --bbox -122.72,47.24,-122.32,48.0 --scale 5   # (re)select cells from NOAA's product catalog
//
// Cells come from https://charts.noaa.gov/ENCs/<CELL>.zip. NOAA's user agreement permits redistribution
// (redistributed copies are simply not "official"). Each zip is kept verbatim so provenance stays intact.
const fs = require("fs"), path = require("path");
const S57 = require("./s57.js");
const DIR = path.join(__dirname, "charts"), CAT = path.join(DIR, "catalog.json");
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
let names = args.filter(a => /^US\w{6}$/.test(a));

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const existing = fs.existsSync(CAT) ? JSON.parse(fs.readFileSync(CAT, "utf8")) : { cells: [] };
  if (opt("--bbox")) {
    const box = opt("--bbox").split(",").map(Number), scale = opt("--scale") || "5";
    console.log("Reading NOAA product catalog (50 MB)...");
    const xml = await (await fetch("https://charts.noaa.gov/ENCs/ENCProdCat_19115.xml")).text();
    for (const chunk of xml.split("<DS_DataSet").slice(1)) {
      const t = chunk.match(/<title>\s*<gco:CharacterString>(US\w{6})</); if (!t) continue;
      if (t[1][2] !== scale) continue;
      const pos = [...chunk.matchAll(/<gml:pos>([-\d.]+) ([-\d.]+)<\/gml:pos>/g)].map(m => [+m[2], +m[1]]);
      if (!pos.length) continue;
      const b = [Math.min(...pos.map(p => p[0])), Math.min(...pos.map(p => p[1])), Math.max(...pos.map(p => p[0])), Math.max(...pos.map(p => p[1]))];
      const title = (chunk.match(/<alternateTitle>\s*<gco:CharacterString>([^<]*)/) || [])[1] || "";
      if (b[2] < box[0] || b[0] > box[2] || b[3] < box[1] || b[1] > box[3]) continue;
      if (/Lake Washington/.test(title)) continue;
      names.push(t[1]);
    }
    console.log(names.length, "cells in bbox");
  }
  if (!names.length) names = existing.cells.map(c => c.name);
  const cells = new Map(existing.cells.map(c => [c.name, c]));
  for (const n of names) {
    const url = `https://charts.noaa.gov/ENCs/${n}.zip`;
    const r = await fetch(url);
    if (!r.ok) { console.warn("skip", n, r.status); continue; }
    const buf = new Uint8Array(await r.arrayBuffer());
    const [cell] = await S57.loadEncArchive(buf);
    fs.writeFileSync(path.join(DIR, n + ".zip"), buf);
    const b = S57.cellBounds(cell);
    const title = (await S57.unzip(buf, f => /README\.TXT$/.test(f)))[0];
    cells.set(n, { name: n, file: n + ".zip", bytes: buf.length, edition: cell.edition, update: cell.update, scale: cell.scale,
      bbox: b.map(v => +v.toFixed(5)), features: cell.features.length, fetched: new Date().toISOString().slice(0, 10) });
    console.log(n, (buf.length / 1024).toFixed(0) + " KB", "ed", cell.edition + "." + cell.update, "1:" + cell.scale, cell.features.length, "features");
  }
  const list = [...cells.values()].sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(CAT, JSON.stringify({ source: "https://charts.noaa.gov/ENCs/", generated: new Date().toISOString().slice(0, 10), cells: list }, null, 1));
  console.log("catalog:", list.length, "cells,", (list.reduce((s, c) => s + c.bytes, 0) / 1048576).toFixed(2), "MB");
})();

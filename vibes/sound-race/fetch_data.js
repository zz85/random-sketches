// Build the bundled data: Puget Sound coastline, recorded race days of wind at West Point (NDBC WPOW1, 10-minute
// continuous winds) and NOAA tidal current predictions at the harmonic current stations around the course.
//   node fetch_data.js            writes data/land.js and data/days.js
// Needs network (NOAA). The app itself never fetches NDBC (no CORS); it can fetch more currents from CO-OPS live.
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const BBOX = [-122.56, 47.56, -122.33, 47.80]; // lon/lat: Bainbridge to Seattle, Alki to Point Jefferson
const CURRENT_STATIONS = ['PUG1515', 'PUG1509', 'PUG1511', 'PUG1516', 'PUG1502', 'PUG1512', 'PUG1505'];
const YEARS = [2024, 2025];

async function get(url, binary) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'sound-race data build' } });
      if (r.ok) return binary ? Buffer.from(await r.arrayBuffer()) : r.text();
      console.warn(r.status, url);
    } catch (e) { console.warn(e.message, url); }
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error('failed ' + url);
}

async function land() {
  const u = 'https://encdirect.noaa.gov/arcgis/rest/services/encdirect/enc_coastal/MapServer/171/query?where=1%3D1'
    + `&geometry=${BBOX.join(',')}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`
    + '&outFields=OBJNAM&returnGeometry=true&outSR=4326&maxAllowableOffset=0.0002&f=geojson';
  const d = JSON.parse(await get(u));
  const rings = [];
  for (const f of d.features) {
    const g = f.geometry, polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
    for (const p of polys) rings.push(p.map((r) => r.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)])));
  }
  return { source: 'NOAA ENC Direct, coastal scale, Land_Area (LNDARE)', bbox: BBOX, polygons: rings };
}

// 10-minute continuous winds, UTC. Returns [{ t (ms), dir (deg true, from), spd (kn), gst (kn) }].
async function cwind(year) {
  const gz = await get(`https://www.ndbc.noaa.gov/data/historical/cwind/wpow1c${year}.txt.gz`, true);
  const out = [];
  for (const line of zlib.gunzipSync(gz).toString().split('\n')) {
    if (!line || line[0] === '#') continue;
    const v = line.trim().split(/\s+/).map(Number);
    if (v[5] === 999 || v[6] >= 99) continue;
    out.push({ t: Date.UTC(v[0], v[1] - 1, v[2], v[3], v[4]), dir: v[5], spd: v[6] / 0.514444, gst: v[8] < 99 ? v[8] / 0.514444 : null });
  }
  return out;
}

const circMean = (a) => Math.atan2(a.reduce((s, x) => s + Math.sin(x * Math.PI / 180), 0), a.reduce((s, x) => s + Math.cos(x * Math.PI / 180), 0)) * 180 / Math.PI;
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;

// Race windows in local time (PDT, UTC-7): weeknight races 18:00-20:00, weekend races 12:00-15:00.
function windows(rows) {
  const byT = new Map(rows.map((r) => [r.t, r]));
  const out = [];
  for (const year of YEARS) for (let m = 4; m <= 9; m++) for (let d = 1; d <= 31; d++) {
    const day = new Date(Date.UTC(year, m - 1, d));
    if (day.getUTCMonth() !== m - 1) continue;
    const wd = day.getUTCDay(), weekend = wd === 0 || wd === 6;
    const startLocal = weekend ? 12 : 18, hours = weekend ? 3 : 2;
    const t0 = Date.UTC(year, m - 1, d, startLocal + 7), pts = [];
    for (let t = t0 - 3600e3; t <= t0 + (hours + 1) * 3600e3; t += 600e3) if (byT.has(t)) pts.push(byT.get(t));
    const race = pts.filter((p) => p.t >= t0 && p.t <= t0 + hours * 3600e3);
    if (race.length < hours * 6 * 0.9 || pts.length < (hours + 2) * 6 * 0.9) continue;
    const spd = race.reduce((s, p) => s + p.spd, 0) / race.length, dir = (circMean(race.map((p) => p.dir)) + 360) % 360;
    const sd = Math.sqrt(race.reduce((s, p) => s + angDiff(p.dir, dir) ** 2, 0) / race.length);
    const trend = angDiff(circMean(race.slice(-6).map((p) => p.dir)), circMean(race.slice(0, 6).map((p) => p.dir)));
    const spdRange = Math.max(...race.map((p) => p.spd)) - Math.min(...race.map((p) => p.spd));
    out.push({ t0, hours, weekend, spd, dir, sd, trend, spdRange, pts });
  }
  return out;
}

// Pick a spread of racing days: northerly and southerly, steady, oscillating and persistent shifts, light and fresh.
function pick(ws) {
  const ok = ws.filter((w) => w.spd >= 6 && w.spd <= 18 && w.sd < 30);
  const north = (w) => Math.abs(angDiff(w.dir, 0)) < 45, south = (w) => Math.abs(angDiff(w.dir, 190)) < 45;
  const cats = [
    ['Steady northerly', (w) => north(w) && w.sd < 6 && w.spd >= 9, (w) => w.sd],
    ['Shifty northerly', (w) => north(w) && w.sd >= 9 && Math.abs(w.trend) < 8, (w) => -w.sd],
    ['Northerly veering right', (w) => north(w) && w.trend > 12, (w) => -w.trend],
    ['Steady southerly', (w) => south(w) && w.sd < 6 && w.spd >= 9, (w) => w.sd],
    ['Shifty southerly', (w) => south(w) && w.sd >= 9 && Math.abs(w.trend) < 8, (w) => -w.sd],
    ['Southerly backing left', (w) => south(w) && w.trend < -12, (w) => w.trend],
    ['Light and patchy', (w) => w.spd < 8 && w.spdRange > 4, (w) => -w.spdRange],
    ['Fresh breeze', (w) => w.spd >= 13, (w) => -w.spd],
  ];
  const used = new Set(), out = [];
  for (const [label, f, key] of cats) {
    const c = ok.filter((w) => f(w) && !used.has(w.t0)).sort((a, b) => key(a) - key(b))[0];
    if (c) { used.add(c.t0); out.push(Object.assign({ label }, c)); }
  }
  return out;
}

const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, '');
async function currents(t0, hours) {
  const out = {};
  for (const id of CURRENT_STATIONS) {
    const b = ymd(t0 - 3 * 3600e3), e = ymd(t0 + (hours + 3) * 3600e3);
    const u = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&station=${id}&begin_date=${b}&end_date=${e}&units=english&time_zone=gmt&interval=6&format=json&application=sound-race`;
    const d = JSON.parse(await get(u));
    if (!d.current_predictions) { console.warn(id, JSON.stringify(d).slice(0, 120)); continue; }
    const cp = d.current_predictions.cp.filter((p) => { const t = Date.parse(p.Time.replace(' ', 'T') + 'Z'); return t >= t0 - 2 * 3600e3 && t <= t0 + (hours + 2) * 3600e3; });
    out[id] = { flood: cp[0].meanFloodDir, ebb: cp[0].meanEbbDir, t: Date.parse(cp[0].Time.replace(' ', 'T') + 'Z'), dt: 360, v: cp.map((p) => p.Velocity_Major) };
  }
  return out;
}

async function stations() {
  const d = JSON.parse(await get('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=currentpredictions'));
  const out = {};
  for (const s of d.stations) if (CURRENT_STATIONS.includes(s.id) && !out[s.id]) out[s.id] = { name: s.name, lat: +s.lat, lon: +s.lng };
  return out;
}

async function main() {
  const dir = path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const L = await land();
  fs.writeFileSync(path.join(dir, 'land.js'), `// ${L.source}. Generated by fetch_data.js.\nself.SOUND_LAND = ${JSON.stringify(L)};\n`);
  console.log('land polygons', L.polygons.length);
  let rows = [];
  for (const y of YEARS) rows = rows.concat(await cwind(y));
  const days = pick(windows(rows));
  const st = await stations();
  const out = [];
  for (const w of days) {
    console.log(w.label, new Date(w.t0).toISOString(), w.spd.toFixed(1), 'kn', w.dir.toFixed(0), 'sd', w.sd.toFixed(1), 'trend', w.trend.toFixed(0));
    out.push({
      label: w.label, start: w.t0, hours: w.hours,
      summary: { spd: +w.spd.toFixed(1), dir: Math.round(w.dir), sd: +w.sd.toFixed(1), trend: Math.round(w.trend) },
      wind: { t: w.pts[0].t, dt: 600, dir: w.pts.map((p) => p.dir), spd: w.pts.map((p) => +p.spd.toFixed(1)), gst: w.pts.map((p) => (p.gst == null ? null : +p.gst.toFixed(1))) },
      currents: await currents(w.t0, w.hours),
    });
  }
  const src = 'Wind: NOAA NDBC WPOW1 (West Point, WA) 10-minute continuous winds, historical cwind files. Currents: NOAA CO-OPS current predictions.';
  fs.writeFileSync(path.join(dir, 'days.js'), `// ${src} Generated by fetch_data.js.\nself.SOUND_DAYS = ${JSON.stringify({ source: src, wpow1: { lat: 47.6617, lon: -122.4339 }, stations: st, days: out })};\n`);
  console.log('days', out.length);
}
main().catch((e) => { console.error(e); process.exit(1); });

// Sound Race simulation: the recorded wind at West Point, NOAA tidal currents, the coastline, a boat on the Sail Trim
// polar, AI rivals and a windward-leeward course. No drawing. Browser (self.SoundSim) and node.
// World frame: metres from ORIGIN, x east, y north. Headings and wind directions: degrees clockwise from north;
// a wind direction is where the wind blows FROM, a current direction where it flows TO.
(function (root) {
  'use strict';
  const D = Math.PI / 180, KN = 0.514444, NM = 1852;
  const ORIGIN = { lat: 47.675, lon: -122.44 };
  const MX = 111320 * Math.cos(ORIGIN.lat * D), MY = 110540;
  const toXY = (lon, lat) => ({ x: (lon - ORIGIN.lon) * MX, y: (lat - ORIGIN.lat) * MY });
  const toLL = (x, y) => ({ lon: ORIGIN.lon + x / MX, lat: ORIGIN.lat + y / MY });
  const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
  const wrap = (a) => ((a % 360) + 360) % 360;
  const angDiff = (a, b) => ((a - b + 540) % 360) - 180; // a - b in -180..180
  const smooth = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;

  // ---- Land: polygons in metres, a raster mask and a distance-to-shore grid -------------------------
  function makeLand(L, opts) {
    opts = opts || {};
    const polys = L.polygons.map((p) => p.map((r) => r.map(([lon, lat]) => { const q = toXY(lon, lat); return [q.x, q.y]; })));
    const cell = opts.cell || 100, half = opts.half || 9000;
    const n = Math.round((2 * half) / cell), x0 = -half, y0 = -half;
    const mask = new Uint8Array(n * n);
    // Even-odd scanline fill at each row's cell centres, over every ring (holes are lakes: water).
    const edges = [];
    for (const p of polys) for (const r of p) for (let i = 0; i < r.length - 1; i++) edges.push(r[i], r[i + 1]);
    for (let j = 0; j < n; j++) {
      const y = y0 + (j + 0.5) * cell, xs = [];
      for (let e = 0; e < edges.length; e += 2) {
        const a = edges[e], b = edges[e + 1];
        if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] - x0) / cell - 0.5)), i1 = Math.min(n - 1, Math.floor((xs[k + 1] - x0) / cell - 0.5));
        for (let i = i0; i <= i1; i++) mask[j * n + i] = 1;
      }
    }
    // Chamfer distance (metres) from each water cell to the nearest land cell.
    const dist = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) dist[i] = mask[i] ? 0 : 1e9;
    const a = cell, b = cell * Math.SQRT2;
    for (let pass = 0; pass < 2; pass++) {
      const fwd = pass === 0;
      for (let jj = 0; jj < n; jj++) for (let ii = 0; ii < n; ii++) {
        const j = fwd ? jj : n - 1 - jj, i = fwd ? ii : n - 1 - ii, s = fwd ? -1 : 1, k = j * n + i;
        let d = dist[k];
        if (i + s >= 0 && i + s < n) d = Math.min(d, dist[k + s] + a);
        if (j + s >= 0 && j + s < n) {
          const r = (j + s) * n;
          d = Math.min(d, dist[r + i] + a);
          if (i - 1 >= 0) d = Math.min(d, dist[r + i - 1] + b);
          if (i + 1 < n) d = Math.min(d, dist[r + i + 1] + b);
        }
        dist[k] = d;
      }
    }
    const idx = (x, y) => { const i = Math.floor((x - x0) / cell), j = Math.floor((y - y0) / cell); return i < 0 || j < 0 || i >= n || j >= n ? -1 : j * n + i; };
    return {
      polys, cell, n, x0, y0, mask, dist,
      isLand: (x, y) => { const k = idx(x, y); return k >= 0 && mask[k] === 1; },
      // Distance to shore, bilinear between cell centres; outside the grid, far from land.
      shore(x, y) {
        const fx = (x - x0) / cell - 0.5, fy = (y - y0) / cell - 0.5, i = Math.floor(fx), j = Math.floor(fy);
        if (i < 0 || j < 0 || i >= n - 1 || j >= n - 1) return 5000;
        const tx = fx - i, ty = fy - j, k = j * n + i;
        return lerp(lerp(dist[k], dist[k + 1], tx), lerp(dist[k + n], dist[k + n + 1], tx), ty);
      },
    };
  }

  // ---- Recorded day: wind series and currents --------------------------------------------------------
  const seriesAt = (s, t) => { // { t, dt (s), v[] } linear in time, clamped
    const f = clamp((t - s.t) / (s.dt * 1000), 0, s.v.length - 1), i = Math.min(Math.floor(f), s.v.length - 2);
    return lerp(s.v[i], s.v[i + 1], f - i);
  };
  function windSeries(day) {
    const w = day.wind, u = [], v = [], g = [];
    // Interpolate as a vector so a shift through north doesn't spin the long way round.
    w.dir.forEach((d, i) => { u.push(w.spd[i] * Math.sin(d * D)); v.push(w.spd[i] * Math.cos(d * D)); g.push(w.gst[i] == null ? w.spd[i] * 1.3 : w.gst[i]); });
    const S = (arr) => ({ t: w.t, dt: w.dt, v: arr });
    const su = S(u), sv = S(v), sg = S(w.spd), sgu = S(g);
    return (t) => {
      const a = seriesAt(su, t), b = seriesAt(sv, t);
      return { dir: wrap(Math.atan2(a, b) / D), spd: seriesAt(sg, t), gst: seriesAt(sgu, t) };
    };
  }

  // A hash-based value noise in 3D (x, y, time), smooth, about -1..1.
  function hash(i, j, k, seed) {
    let h = (i * 374761393 + j * 668265263 + k * 2147483647 + seed * 144269504) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return ((h >>> 0) / 4294967295) * 2 - 1;
  }
  function noise3(x, y, z, seed) {
    const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), u = smooth(x - i), v = smooth(y - j), w = smooth(z - k);
    const c = (a, b, cc) => hash(i + a, j + b, k + cc, seed);
    return lerp(lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
      lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v), w);
  }

  // The wind field. The 10-minute record sets the mean; inside it the shifts and puffs are frozen turbulence
  // carried down the course by the wind (you see them coming from upwind), sized from the record's spread and gusts;
  // near a windward shore the wind is lighter (its wind shadow).
  function makeWind(day, land, opts) {
    opts = opts || {};
    const rec = windSeries(day), seed = opts.seed || 7;
    // Shift amplitude inside a 10-minute mean: from the spread of the record's directions, 3 to 10 degrees.
    const dirs = day.wind.dir, n = dirs.length;
    let sd = 0; for (let i = 1; i < n; i++) sd += angDiff(dirs[i], dirs[i - 1]) ** 2;
    sd = Math.sqrt(sd / Math.max(1, n - 1));
    const shiftAmp = opts.shiftAmp != null ? opts.shiftAmp : clamp(0.6 * sd, 3, 10);
    const SHIFT_L = 2200, PUFF_L = 450, SHIFT_T = 900, PUFF_T = 400; // metres and seconds
    // How far the air has travelled since the record began, at each sample: the turbulence moves with it.
    const t0 = day.wind.t, adv = [0];
    for (let i = 1; i < day.wind.spd.length; i++) adv.push(adv[i - 1] + 0.5 * (day.wind.spd[i - 1] + day.wind.spd[i]) * KN * day.wind.dt);
    const travelled = (t) => {
      const f = clamp((t - t0) / (day.wind.dt * 1000), 0, adv.length - 1), i = Math.min(Math.floor(f), adv.length - 2);
      const extra = (t - t0) / 1000 - (adv.length - 1) * day.wind.dt; // past the record: keep going at the last speed
      return lerp(adv[i], adv[i + 1], f - i) + (extra > 0 ? extra * day.wind.spd[adv.length - 1] * KN : 0) + Math.min(0, (t - t0) / 1000) * day.wind.spd[0] * KN;
    };
    function at(x, y, t) {
      const m = rec(t), th = m.dir * D;
      // Along-wind coordinate downwind (a puff at s moves to larger s), cross-wind coordinate.
      const s = -(x * Math.sin(th) + y * Math.cos(th)), c = x * Math.cos(th) - y * Math.sin(th);
      const ts = (t - t0) / 1000, sa = s - travelled(t);
      const shift = shiftAmp * (noise3(sa / SHIFT_L, c / (SHIFT_L * 2), ts / SHIFT_T, seed) * 1.6);
      const gust = Math.max(0, m.gst / Math.max(m.spd, 0.5) - 1);
      const p = noise3(sa / PUFF_L, c / PUFF_L, ts / PUFF_T, seed + 11) + 0.5 * noise3(sa / (PUFF_L / 2.3), c / (PUFF_L / 2.3), ts / (PUFF_T / 2), seed + 23);
      let spd = m.spd * (1 + 0.55 * gust * p);
      let dir = m.dir + shift + 4 * gust * p; // puffs come in a little to the right (veer) in the northern hemisphere
      // Wind shadow of land upwind: look up the wind for 700 m.
      if (land) {
        let blocked = 0;
        for (let d = 100; d <= 700; d += 100) if (land.isLand(x + Math.sin(th) * d, y + Math.cos(th) * d)) { blocked = 1 - (d - 100) / 600; break; }
        spd *= 1 - 0.45 * blocked;
      }
      return { dir: wrap(dir), spd: Math.max(0, spd), puff: p, mean: m };
    }
    return { at, record: rec, shiftAmp };
  }

  // Tidal current: each harmonic station's prediction, a speed along its flood or ebb direction, blended by inverse
  // distance squared, and slowed to nothing at the shore over the last 400 m.
  const CURRENT_USE = ['PUG1515', 'PUG1509', 'PUG1511', 'PUG1516', 'PUG1502', 'PUG1512'];
  function makeCurrent(day, stations, land) {
    const st = [];
    for (const id of CURRENT_USE) {
      const c = day.currents[id], s = stations[id];
      if (!c || !s) continue;
      st.push(Object.assign({ id, name: s.name, series: { t: c.t, dt: c.dt, v: c.v }, flood: c.flood, ebb: c.ebb }, toXY(s.lon, s.lat)));
    }
    function stationVec(s, t) {
      const v = seriesAt(s.series, t), dir = v >= 0 ? s.flood : s.ebb, k = Math.abs(v);
      return { u: k * Math.sin(dir * D), v: k * Math.cos(dir * D), kn: v };
    }
    function at(x, y, t) {
      let u = 0, v = 0, w = 0;
      for (const s of st) {
        const d2 = (x - s.x) ** 2 + (y - s.y) ** 2 + 300 * 300, k = 1 / d2;
        const c = stationVec(s, t); u += k * c.u; v += k * c.v; w += k;
      }
      if (!w) return { u: 0, v: 0, spd: 0, dir: 0 };
      u /= w; v /= w;
      const f = land ? smooth(clamp(land.shore(x, y) / 400, 0, 1)) : 1;
      u *= f; v *= f;
      return { u, v, spd: Math.hypot(u, v), dir: wrap(Math.atan2(u, v) / D) }; // knots, flowing toward dir
    }
    return { at, stations: st, stationVec };
  }

  // ---- Polar ----------------------------------------------------------------------------------------
  function makePolar(P) {
    const ti = (tws) => { const t = clamp(tws, P.tws[0], P.tws[P.tws.length - 1]); let i = 0; while (i < P.tws.length - 2 && P.tws[i + 1] < t) i++; return [i, (t - P.tws[i]) / (P.tws[i + 1] - P.tws[i])]; };
    const ai = (twa) => { const a = clamp(Math.abs(twa), P.twa[0], 180); let j = 0; while (j < P.twa.length - 2 && P.twa[j + 1] < a) j++; return [j, (a - P.twa[j]) / (P.twa[j + 1] - P.twa[j])]; };
    function speed(tws, twa) {
      const [i, u] = ti(tws), [j, v] = ai(twa), b = P.bs;
      return lerp(lerp(b[i][j], b[i][j + 1], v), lerp(b[i + 1][j], b[i + 1][j + 1], v), u);
    }
    function sail(tws, twa) { const [i, u] = ti(tws), [j, v] = ai(twa); return P.sail[u < 0.5 ? i : i + 1][v < 0.5 ? j : j + 1]; }
    // VMG-optimal true wind angles, upwind and downwind, for a wind speed.
    const optCache = new Map();
    function optimum(tws) {
      const key = Math.round(tws * 4);
      if (optCache.has(key)) return optCache.get(key);
      tws = key / 4; // the cached answer is for the quantised speed, whichever speed asked first
      let up = { a: 45, v: 0 }, dn = { a: 160, v: 0 };
      for (let a = 30; a <= 180; a += 0.5) {
        const b = speed(tws, a), vm = b * Math.cos(a * D);
        if (vm > up.v) up = { a, v: vm, bs: b };
        if (-vm > dn.v) dn = { a, v: -vm, bs: b };
      }
      const r = { up, dn }; optCache.set(key, r); return r;
    }
    return { speed, sail, optimum };
  }

  // ---- Boat -----------------------------------------------------------------------------------------
  // Speed through the water follows the polar with a lag: about 12 s to build speed, 5 s to lose it (a tack in a
  // 30-footer costs a third of her speed). Leeway up to 4 deg close-hauled. Ground velocity adds the current.
  const TURN = 6;        // deg/s at the helm
  const leewayOf = (twa, bs) => 4 * clamp((90 - Math.abs(twa)) / 50, 0, 1) * clamp(bs / 3, 0, 1) * Math.sign(twa || 1);
  function newBoat(o) {
    return Object.assign({ x: 0, y: 0, hdg: 0, bs: 0, twa: 0, tws: 0, sog: 0, cog: 0, turnTo: null, tacks: 0, gybes: 0, track: [], dist: 0 }, o);
  }
  const twaOf = (hdg, windDir) => angDiff(windDir, hdg); // + wind on the starboard side
  function stepBoat(b, env, polar, dt) {
    const w = env.wind.at(b.x, b.y, env.t), c = env.current.at(b.x, b.y, env.t);
    if (b.turnTo != null) {
      const e = angDiff(b.turnTo, b.hdg), s = clamp(e, -TURN * dt, TURN * dt);
      b.hdg = wrap(b.hdg + s);
      if (Math.abs(e) < 0.01) b.turnTo = null;
    }
    const twa = twaOf(b.hdg, w.dir);
    // Board (+1 starboard, -1 port), with a little hysteresis so a wobble head to wind or dead downwind isn't a tack or gybe.
    if (!b.board) b.board = twa >= 0 ? 1 : -1;
    if (twa * b.board < 0 && Math.abs(twa) > 6 && Math.abs(twa) < 174) { b.board = -b.board; if (Math.abs(twa) < 90) b.tacks++; else b.gybes++; }
    const target = polar.speed(w.spd, twa);
    const tau = target > b.bs ? 12 : 5;
    b.bs += (target - b.bs) * (1 - Math.exp(-dt / tau));
    const leeway = leewayOf(twa, b.bs);
    // The wind sets her to leeward: with the wind on starboard (twa > 0) she makes good a course to port of her heading.
    const course = wrap(b.hdg - leeway);
    const vx = b.bs * Math.sin(course * D) + c.u, vy = b.bs * Math.cos(course * D) + c.v;
    const dx = vx * KN * dt, dy = vy * KN * dt;
    if (env.land && env.land.isLand(b.x + dx, b.y + dy)) { b.bs = 0; b.aground = true; b.sog = 0; b.twa = twa; b.tws = w.spd; b.twd = w.dir; b.cur = c; b.target = target; return b; }
    b.aground = false;
    b.x += dx; b.y += dy; b.dist += Math.hypot(dx, dy);
    b.sog = Math.hypot(vx, vy); b.cog = wrap(Math.atan2(vx, vy) / D);
    b.twa = twa; b.tws = w.spd; b.twd = w.dir; b.cur = c; b.target = target; b.leeway = leeway;
    return b;
  }
  // Turn onto the other tack (or gybe) at the same wind angle.
  function tack(b) { if (b.turnTo == null) b.turnTo = wrap(b.twd - (-b.twa)); }

  // Ground course on a heading, current included: speed v kn through the water; with twa, leeway too.
  function groundCourse(hdg, v, cur, twa) {
    const h = twa == null ? hdg : hdg - leewayOf(twa, v);
    const vx = v * Math.sin(h * D) + cur.u, vy = v * Math.cos(h * D) + cur.v;
    return { cog: wrap(Math.atan2(vx, vy) / D), sog: Math.hypot(vx, vy) };
  }

  // Laylines to a mark for a wind and current: the ground tracks of the two tacks (or gybes) at the optimal angle,
  // drawn back from the mark. Returns the reverse bearings (from the mark) of the starboard- and port-tack laylines.
  function laylines(polar, wind, cur, upwind) {
    const o = polar.optimum(wind.spd), a = upwind ? o.up.a : o.dn.a, v = upwind ? o.up.bs : o.dn.bs;
    const stb = groundCourse(wrap(wind.dir - a), v, cur, a), port = groundCourse(wrap(wind.dir + a), v, cur, -a);
    return { stb: wrap(stb.cog + 180), port: wrap(port.cog + 180), angle: a, stbCog: stb.cog, portCog: port.cog };
  }

  // ---- Course ---------------------------------------------------------------------------------------
  // A windward-leeward course laid to the wind at the start: the start line square to it, the windward mark legNm
  // upwind, the leeward gate just below the line. Placed at the first spot off Shilshole that keeps the course and
  // 600 m either side of it in water at least 250 m from shore.
  const START_SPOTS = [[-122.425, 47.684], [-122.435, 47.690], [-122.445, 47.682], [-122.44, 47.70], [-122.455, 47.672], [-122.46, 47.69], [-122.43, 47.705]];
  function makeCourse(windDir, legNm, land, opts) {
    opts = opts || {};
    const L = legNm * NM, th = windDir * D;
    const fwd = { x: Math.sin(th), y: Math.cos(th) }, rt = { x: Math.cos(th), y: -Math.sin(th) };
    const ok = (o) => {
      if (!land) return true;
      for (let s = -300; s <= L + 300; s += 100) for (let c = -600; c <= 600; c += 150) {
        const x = o.x + fwd.x * s + rt.x * c, y = o.y + fwd.y * s + rt.y * c;
        if (land.isLand(x, y) || land.shore(x, y) < 250) return false;
      }
      return true;
    };
    let o = null;
    for (const [lon, lat] of opts.spots || START_SPOTS) { const p = toXY(lon, lat); if (ok(p)) { o = p; break; } }
    if (!o) o = toXY(START_SPOTS[0][0], START_SPOTS[0][1]);
    const at = (s, c) => ({ x: o.x + fwd.x * s + rt.x * c, y: o.y + fwd.y * s + rt.y * c });
    return {
      axis: wrap(windDir), legNm, L, laps: opts.laps || 1, origin: o,
      pin: at(0, -90), committee: at(0, 90), windward: at(L, 0), gate: [at(-90, -35), at(-90, 35)],
      // course frame: s along the axis (upwind), c across (to the right looking upwind)
      toCourse: (p) => ({ s: (p.x - o.x) * fwd.x + (p.y - o.y) * fwd.y, c: (p.x - o.x) * rt.x + (p.y - o.y) * rt.y }),
      fromCourse: at,
    };
  }

  // Legs: start, W, (G, W) per extra lap, finish (the line, from below... it is crossed downwind, from the windward side).
  function newRace(course, o) {
    const legs = ['start', 'W']; for (let i = 1; i < course.laps; i++) legs.push('G', 'W'); legs.push('F');
    return { course, legs, countdown: (o && o.countdown) || 180 };
  }
  // Each boat's progress through the race, from its moves in the course frame.
  function newEntry(name) { return { name, leg: 0, started: null, ocs: false, finish: null, rounded: [], penalty: 0 }; }
  function advance(race, e, p0, p1, t) { // t = seconds since the gun (negative before)
    const C = race.course, a = C.toCourse(p0), b = C.toCourse(p1), leg = race.legs[e.leg], ev = [];
    const lineX = (half) => { // crossing s = 0 within |c| <= half; +1 upward
      if ((a.s < 0) === (b.s < 0)) return 0;
      const f = a.s / (a.s - b.s), c = a.c + f * (b.c - a.c);
      return Math.abs(c) <= half ? (b.s > a.s ? 1 : -1) : 0;
    };
    if (e.finish != null) return ev;
    if (leg === 'start') {
      if (t < 0) return ev;
      const x = lineX(90);
      if (x === -1 && e.ocs) { e.ocs = false; ev.push('cleared'); }
      else if (x === 1 && !e.ocs) { e.started = t; e.leg++; ev.push('started'); }
      return ev;
    }
    if (leg === 'W' || leg === 'G') {
      // Rounded once the boat passes the mark's line square to the axis, beyond it, within 120 m.
      const m = leg === 'W' ? C.toCourse(C.windward) : C.toCourse({ x: (C.gate[0].x + C.gate[1].x) / 2, y: (C.gate[0].y + C.gate[1].y) / 2 });
      const past = leg === 'W' ? b.s > m.s && a.s <= m.s : b.s < m.s && a.s >= m.s;
      // Windward mark to port: the boat goes up past it on its right (c > mark), then turns down round it. Gate: between its two marks.
      const ok = leg === 'W' ? b.c > m.c && b.c < m.c + 400 : Math.abs(b.c - m.c) < 35;
      if (past && ok) { e.rounded.push(t); e.leg++; ev.push(leg === 'W' ? 'roundedW' : 'roundedG'); }
      return ev;
    }
    if (leg === 'F' && lineX(90) === -1) { e.finish = t; ev.push('finished'); }
    return ev;
  }

  // ---- AI rivals ------------------------------------------------------------------------------------
  // Three ways round a beat: tack on the shifts, go where the current helps, or stay near the middle. All three use
  // laylines with the current and sail the polar's VMG angles. Downwind they gybe on headers and on the laylines.
  const STYLES = {
    shifts: { name: 'Shift sailor', header: 5, corridor: 0.9, current: 0, spot: 40 },
    current: { name: 'Tide reader', header: 12, corridor: 0.9, current: 1, spot: 0 },
    middle: { name: 'Middle road', header: 8, corridor: 0.3, current: 0, spot: -40 },
  };
  function newAI(style, start) { return { style, b: newBoat(start), memo: { dirs: [], hold: 0 } }; }
  function aiStep(ai, env, polar, race, entry, dt) {
    const b = ai.b, S = STYLES[ai.style], C = race.course, m = ai.memo;
    const w = env.wind.at(b.x, b.y, env.t), cur = env.current.at(b.x, b.y, env.t);
    m.dirs.push(w.dir); if (m.dirs.length > 360 / Math.max(dt, 0.1)) m.dirs.shift();
    let su = 0, cu = 0; for (const d of m.dirs) { su += Math.sin(d * D); cu += Math.cos(d * D); }
    const mean = wrap(Math.atan2(su, cu) / D);
    m.hold -= dt;
    const leg = race.legs[entry.leg], tg = env.tGun;
    let target, upwind;
    if (leg === 'start' && tg < 0) {
      // Pre-start: wait luffing at a set-up point one minute's close-hauled sail below the line, then go on starboard so
      // as to reach the line at the gun at this boat's chosen spot on it.
      // The set-up point is on an approach 15 deg below close-hauled, so she can always bear away to fetch the spot.
      const o = polar.optimum(w.spd), hS = wrap(w.dir - o.up.a), aA = o.up.a + 15;
      const gc = groundCourse(wrap(w.dir - aA), polar.speed(w.spd, aA) * 0.85, cur, aA);
      const spot = C.fromCourse(-8, S.spot != null ? S.spot : 0), T = 45;
      const A = { x: spot.x - Math.sin(gc.cog * D) * gc.sog * KN * T, y: spot.y - Math.cos(gc.cog * D) * gc.sog * KN * T };
      const dA = Math.hypot(A.x - b.x, A.y - b.y), toSpot = Math.hypot(spot.x - b.x, spot.y - b.y);
      const p = C.toCourse(b);
      // Early at the line: luff, far enough below it that the current doesn't set her over before the gun.
      const set = (cur.u * Math.sin(C.axis * D) + cur.v * Math.cos(C.axis * D)) * KN, early = 15 + Math.max(0, set) * (-tg + 10);
      if (p.s > -early) b.turnTo = wrap(w.dir - 26);
      else if ((dA <= 25 && -tg <= T + 4) || -tg <= toSpot / Math.max(gc.sog * KN / 0.85, 0.5) + 4) { // time to go: fetch the spot
        const brg = wrap(Math.atan2(spot.x - b.x, spot.y - b.y) / D);
        b.turnTo = angDiff(w.dir, brg) > o.up.a ? brg : hS;
      }
      else if (dA > 25) {                                                          // get to the set-up point
        // Upwind of her: beat to it on the board that points nearer; else sail straight there.
        const brg = wrap(Math.atan2(A.x - b.x, A.y - b.y) / D), twa = angDiff(w.dir, brg);
        let board = twaOf(b.hdg, w.dir) >= 0 ? 1 : -1;
        if (twa * board < -o.up.a + 20) board = -board;          // A has gone well past the other board's line: tack
        b.turnTo = Math.abs(twa) < o.up.a ? wrap(w.dir - o.up.a * board) : brg;
      } else b.turnTo = wrap(w.dir - 26);                                          // there: luff and wait
      return stepBoat(b, env, polar, dt);
    }
    if (leg === 'start' && entry.ocs) { b.turnTo = wrap(w.dir + 150); return stepBoat(b, env, polar, dt); } // dip back below the line
    const mid = (g) => ({ x: (g[0].x + g[1].x) / 2, y: (g[0].y + g[1].y) / 2 });
    if (leg === 'start') {
      // Missed the line at the gun: come back below it if above it outside its ends, else cross it inside them.
      const p = C.toCourse(b);
      if (p.s > 0) { target = C.fromCourse(-60, clamp(p.c, -60, 60)); upwind = false; }
      else if (Math.abs(p.c) > 70) { target = C.fromCourse(30, clamp(p.c, -60, 60)); upwind = true; }
      else { target = C.fromCourse(C.L, 30); upwind = true; }
    } else if (leg === 'W') {
      // Aim just right of the mark, to round it to port. Above it without having rounded: come back down on its right.
      const p = C.toCourse(b);
      if (p.s > C.L + 5) { target = C.fromCourse(C.L - 50, 70); upwind = false; }
      else { target = C.fromCourse(C.L, 30); upwind = true; }
    } else {
      // The gate, or the finish line: both are crossed going down, between their ends. Below one outside them: go back up.
      const g = leg === 'G' ? C.toCourse(mid(C.gate)) : { s: 0, c: 0 }, half = leg === 'G' ? 25 : 70, p = C.toCourse(b);
      if (p.s < g.s - 5 && Math.abs(p.c - g.c) > half) { target = C.fromCourse(g.s + 50, g.c); upwind = true; }
      else { target = C.fromCourse(g.s, g.c); upwind = false; }
    }
    const o = polar.optimum(w.spd), ang = upwind ? o.up.a : o.dn.a, v = upwind ? o.up.bs : o.dn.bs;
    const stbH = wrap(w.dir - ang), portH = wrap(w.dir + ang);
    const onStb = (b.board || (twaOf(b.hdg, w.dir) >= 0 ? 1 : -1)) > 0;
    const brg = wrap(Math.atan2(target.x - b.x, target.y - b.y) / D), dist = Math.hypot(target.x - b.x, target.y - b.y);
    // Close to the mark (or the point it is going to): steer straight at it, beating only where that is too close to the wind.
    if (dist < 350 && b.turnTo == null) {
      const twaB = angDiff(w.dir, brg);
      let board = onStb ? 1 : -1;
      if (Math.abs(twaB) < o.up.a) { if (twaB * board < -10) board = -board; b.turnTo = wrap(w.dir - o.up.a * board); }
      else b.turnTo = brg;
    } else if (b.turnTo == null && m.hold <= 0) {
      const gcS = groundCourse(stbH, v, cur, ang), gcP = groundCourse(portH, v, cur, -ang);
      // Layline: once the other board's ground track reaches the mark, take it (with a little overstand).
      const other = onStb ? gcP.cog : gcS.cog, mine = onStb ? gcS.cog : gcP.cog;
      const reach = angDiff(brg, mine), side = angDiff(other, mine);
      const pastLay = Math.sign(reach) === Math.sign(side) && Math.abs(reach) >= Math.abs(side) + 2;
      let want = false;
      if (pastLay && dist > 60) want = true;
      // Corridor: stay within a fraction of the leg's width of the rhumb line (course frame c).
      // On starboard (tack or gybe) she moves to the left of the axis (c falls), on port to the right.
      const pc = C.toCourse(b), cMax = Math.max(200, S.corridor * C.L * 0.45);
      if ((onStb && pc.c < -cMax) || (!onStb && pc.c > cMax)) want = true;
      // Headers: on starboard a backing wind (to the left) heads her, on port a veer. Downwind a lift calls for a gybe.
      const shift = angDiff(w.dir, mean), headed = onStb ? shift < 0 : shift > 0;
      if (dist > 300 && ((upwind && headed) || (!upwind && !headed)) && Math.abs(shift) > S.header && !pastLay) want = true;
      // Tide reader: at each leg's start, compare the current up the course on each side and go to the better side first.
      if (S.current) {
        if (m.sideLeg !== entry.leg) {
          m.sideLeg = entry.leg;
          const help = (c) => { let h = 0; for (const f of [0.3, 0.6]) { const p = C.fromCourse(C.L * f, c), k = env.current.at(p.x, p.y, env.t); h += (k.u * Math.sin(C.axis * D) + k.v * Math.cos(C.axis * D)) * (upwind ? 1 : -1); } return h; };
          const l = help(-0.4 * C.L), r = help(0.4 * C.L);
          m.side = Math.abs(l - r) > 0.1 ? (r > l ? 1 : -1) : 0;
        }
        // Starboard goes left (c falls), port right: hold the board that leads to the chosen side until she is out there.
        const pc2 = C.toCourse(b), there = m.side * pc2.c > 0.35 * C.L;
        if (m.side && !there && !pastLay && dist > 300) want = (m.side > 0) === onStb;
      }
      if (want) { b.turnTo = onStb ? portH : stbH; m.hold = 90; m.dirs.length = 0; }
    }
    // Otherwise sail the VMG angle on this board, following the wind as it shifts.
    if (b.turnTo == null && dist >= 350) b.turnTo = onStb ? stbH : portH;
    // Shore ahead (on the ground track): tack or gybe away whatever the plan.
    if (b.turnTo == null || Math.abs(angDiff(b.turnTo, b.hdg)) < 1) {
      const gc = groundCourse(b.hdg, Math.max(b.bs, 2), cur);
      const ahead = (d) => env.land && (env.land.isLand(b.x + Math.sin(gc.cog * D) * d, b.y + Math.cos(gc.cog * D) * d) || env.land.shore(b.x + Math.sin(gc.cog * D) * d, b.y + Math.cos(gc.cog * D) * d) < 60);
      if (ahead(120) || ahead(250)) { b.turnTo = onStb ? portH : stbH; m.hold = 60; }
    }
    return stepBoat(b, env, polar, dt);
  }

  const api = { leewayOf, D, KN, NM, ORIGIN, toXY, toLL, wrap, angDiff, clamp, makeLand, makeWind, makeCurrent, makePolar, newBoat, stepBoat, tack, twaOf, groundCourse, laylines, makeCourse, newRace, newEntry, advance, STYLES, newAI, aiStep, noise3 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SoundSim = api;
})(typeof self !== 'undefined' ? self : this);

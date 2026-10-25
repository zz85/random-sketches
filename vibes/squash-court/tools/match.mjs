// node tools/match.mjs <video> <out dir> [--jobs N] [--from s] [--to s]
// A whole match file: court tracked through the cuts, players and ball on every stretch where the
// court is seen, impacts heard in the soundtrack. Splits the file into chunks run in parallel
// (one process each), then merges them:
//   - players: identities across cuts from shirt colour (two clusters over the whole file, tracks
//     seen together kept apart), then
//     per player the time per 25 cm floor cell (heatmap), distance, speed over time
//   - bounces: every floor / front-wall impact (fitted, ended on the floor, or heard), with who hit
//     the shot
// Writes <out>/match.json (open it in the page) and <out>/match.png (floor plan).
import { spawn, execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import { detectCourt } from '../detect.js';
import { createTracker, resetTracker, trackFrame, recallShot } from '../track.js';
import { Rally } from '../rally.js';
import { onsets, audioOffset } from '../audio.js';
import { Bounces, heatGrid, impactsOf } from '../bounces.js';
import { Commentary, describe, mainView } from '../commentary.js';
import { W as CW, L as CL, courtModel } from '../court.js';
import { writeImage, line } from './nodeimg.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const src = args[0], out = args[1], SELF = fileURLToPath(import.meta.url);
const W0 = 1280; // frames are decoded at this width (or the file's, if smaller)


// ---------- parent ----------
async function main() {
  mkdirSync(out, { recursive: true });
  const dur = duration(src), from = +opt('--from', 0), to = Math.min(dur, +opt('--to', dur)), jobs = +opt('--jobs', Math.min(24, os.cpus().length));
  const len = Math.max(20, Math.ceil((to - from) / jobs)), parts = [];
  for (let s = from; s < to; s += len) parts.push([s, Math.min(len, to - s)]);
  console.log(`${src}: ${(dur / 60).toFixed(1)} min, ${parts.length} chunks of ${len} s on ${jobs} processes`);
  const t0 = Date.now(); let done = 0;
  const res = await Promise.all(parts.map(([s, l], i) => new Promise((ok, bad) => {
    const json = `${out}/chunk_${i}.json`, p = spawn(process.execPath, [SELF, src, out, '--chunk', String(s), '--len', String(l), '--json', json], { stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('exit', (c) => { if (c) return bad(new Error(`chunk ${i} exited ${c}`)); done++; process.stdout.write(`\r${done}/${parts.length} chunks, ${((Date.now() - t0) / 1000).toFixed(0)} s`); ok(JSON.parse(readFileSync(json, 'utf8'))); });
  })));
  console.log();
  const M = merge(res, { source: src.split('/').pop(), duration: to - from });
  writeFileSync(`${out}/match.json`, JSON.stringify(M));
  render(M, `${out}/match.png`);
  console.log(`court seen ${(M.courtSeconds / 60).toFixed(1)} min; ${M.players.map((p) => `P${p.id} ${p.distance.toFixed(0)} m, top ${p.topSpeed.toFixed(1)} m/s`).join('; ')}`);
  const fl = M.bounces.filter((m) => m.plane === 'floor');
  console.log(`${fl.length} floor bounces (${fl.filter((m) => m.sound).length} by ear), ${M.bounces.filter((m) => m.plane === 'front').length} front-wall hits; hitter known for ${M.bounces.filter((m) => m.player).length}; audio ${M.audio.sure ? `${Math.round(M.audio.offset * 1000)} ms after picture (${M.audio.matched} impacts matched, ${M.audio.chance} by chance)` : `delay not determined (best ${M.audio.matched}, ${M.audio.chance} by chance)`}, ${M.audio.heard} heard`);
  const kinds = {}; for (const s of M.shots) { const k = s.kind.type + (s.kind.direction ? ' ' + s.kind.direction : ''); kinds[k] = (kinds[k] || 0) + 1; }
  console.log(`${M.shots.length} shots: ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}; ${M.flightsOtherViews} flights from other cameras left out`);
  console.log(`wrote ${out}/match.json, ${out}/match.png in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

function duration(f) {
  let s = ''; try { execFileSync('ffmpeg', ['-hide_banner', '-i', f], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { s = String(e.stderr); }
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(s); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0;
}

// ---------- one chunk ----------
async function chunk(file, ss, len, json) {
  const probe = (() => { let s = ''; try { execFileSync('ffmpeg', ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { s = String(e.stderr); } return s; })();
  const vm = /, (\d{2,5})x(\d{2,5})[, ]/.exec(probe), fpsM = /([\d.]+) fps/.exec(probe), fps = fpsM ? +fpsM[1] : 25;
  const sw = +vm[1], sh = +vm[2], W = Math.min(W0, sw), H = Math.round(sh * W / sw / 2) * 2, N = W * H * 4;
  // audio first (small): mono 32 kHz
  const abuf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(ss), '-t', String(len), '-i', file, '-vn', '-ac', '1', '-ar', '32000', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const heard = abuf.length ? onsets(new Float32Array(abuf.buffer, abuf.byteOffset, abuf.length / 4), 32000).map((o) => +(o.t + ss).toFixed(4)) : [];
  const ff = spawn('ffmpeg', ['-v', 'error', '-ss', String(ss), '-t', String(len), '-i', file, '-an', '-vf', `scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  const tr = createTracker(), R = new Rally({ playerEvery: 0.2 }), dets = [], flights = [];
  let stretch = 0, cam = null, lastCam = null, idx = 0, lastTry = -Infinity, courtSeconds = 0, lastOk = null, pending = Buffer.alloc(0);
  const keep = (win) => { // the rally's flight window replaces what it covers
    if (!win || !win.length) return;
    const a = win[0].t0 - 0.05, b = Math.max(...win.map((f) => f.t1)) + 0.05;
    for (let i = flights.length - 1; i >= 0; i--) if (flights[i].t0 >= a && flights[i].t0 <= b) flights.splice(i, 1);
    for (const f of win) flights.push({ cam: f.cam, t0: f.t0, t1: f.t1, impacts: f.impacts, labels: f.labels, speed: f.speed, pts: f.pts.map((q) => ({ t: +q.t.toFixed(4), X: q.X.map((v) => +v.toFixed(3)), V: q.V && q.V.map((v) => +v.toFixed(2)) })) });
  };
  const frame = (rgba) => {
    const t = ss + idx++ / fps;
    let ok = false, path = null;
    if (cam) {
      const r = trackFrame(rgba, W, H, cam, tr, { dt: lastOk == null ? 1 : t - lastOk });
      if (r.ok) { cam = r.cam; ok = true; path = r.path; } else cam = null;
    }
    if (!cam) {
      const back = recallShot(rgba, W, H, tr, {});
      if (back) { cam = back.cam; ok = true; path = 'recall'; }
      else if (t - lastTry > 0.5) { // a fresh detection costs ~1 s: twice a second of video at most
        lastTry = t; const d = detectCourt(rgba, W, H);
        if (d.ok) { cam = d.cam; resetTracker(tr, d.cam, d.tin); tr.tin = d.tin; ok = true; path = 'detect'; }
      }
    }
    if (!ok) { if (lastCam && lastOk != null && t - lastOk > 0.3) { keep(R.finish(lastCam, W)); R.reset(); lastCam = null; stretch++; } return; }
    if (lastCam && (path === 'detect' || path === 'recall' || (lastOk != null && t - lastOk > 0.3))) { keep(R.finish(lastCam, W)); R.reset(); stretch++; }
    lastCam = cam;
    if (lastOk != null && t - lastOk < 0.1) courtSeconds += t - lastOk;
    lastOk = t;
    const q = R.frame(rgba, W, H, cam, t, { tin: tr.tin });
    if (q.flights) keep(q.flights);
    // the tracked players (identity within this stretch of one camera), with the shirt colour
    if (!q.dup && q.ms.players != null) for (const p of q.players) if (p.seen) dets.push({ t: +t.toFixed(3), X: p.X.map((v) => +v.toFixed(3)), col: p.col && p.col.map(Math.round), track: `${ss}:${stretch}:${p.id}`, occ: !!p.occluded });
  };
  await new Promise((ok) => {
    ff.stdout.on('data', (c) => { pending = pending.length ? Buffer.concat([pending, c]) : c; while (pending.length >= N) { frame(new Uint8ClampedArray(pending.buffer.slice(pending.byteOffset, pending.byteOffset + N))); pending = pending.subarray(N); } });
    ff.on('exit', ok);
  });
  if (lastCam) keep(R.finish(lastCam, W));
  writeFileSync(json, JSON.stringify({ ss, len, fps, dets, flights, heard, courtSeconds }));
}

// ---------- merge ----------
function merge(parts, meta) {
  const dets = parts.flatMap((p) => p.dets).sort((a, b) => a.t - b.t);
  // the main high camera only: court-level, side and close-up views misjudge depth
  const allFlights = parts.flatMap((p) => p.flights), flights = allFlights.filter((f) => mainView(f.cam)).sort((a, b) => a.t0 - b.t0);
  const heard = parts.flatMap((p) => p.heard).sort((a, b) => a - b);
  const { tracks, cents } = linkIdentities(dets);
  for (const d of dets) d.id = tracks.get(d.track)?.id ?? null;
  for (let i = dets.length - 1; i >= 0; i--) if (!dets[i].id) dets.splice(i, 1);
  const players = [1, 2].map((id) => {
    const D = dets.filter((d) => d.id === id), heat = new Float32Array(Math.ceil(CW / 0.25) * Math.ceil(CL / 0.25)), nx = Math.ceil(CW / 0.25);
    let dist = 0, secs = 0; const speed = [], vs = [];
    for (let i = 0; i < D.length; i++) {
      const d = D[i], p = D[i - 1], dt = p ? d.t - p.t : 0;
      if (p && dt > 0 && dt < 0.5) { secs += dt; const cx = Math.floor(d.X[0] / 0.25), cy = Math.floor(d.X[1] / 0.25); if (cx >= 0 && cy >= 0 && cx < nx && cy < 39) heat[cy * nx + cx] += dt; const st = Math.hypot(d.X[0] - p.X[0], d.X[1] - p.X[1]); if (st < 7 * dt + 0.3) dist += st; }
      // speed: least-squares slope over the last 0.6 s
      // (a step faster than a sprint is a different person under this colour: the window stops there)
      const win = [d]; for (let j = i - 1; j >= 0 && D[j].t > d.t - 0.6; j--) { const q = win[win.length - 1], e = q.t - D[j].t; if (Math.hypot(q.X[0] - D[j].X[0], q.X[1] - D[j].X[1]) > 6 * e + 0.25) break; win.push(D[j]); }
      let v = null;
      if (win.length >= 3) { const n = win.length, mt = win.reduce((s, q) => s + q.t, 0) / n, mx = win.reduce((s, q) => s + q.X[0], 0) / n, my = win.reduce((s, q) => s + q.X[1], 0) / n; let tt = 0, tx = 0, ty = 0; for (const q of win) { const e = q.t - mt; tt += e * e; tx += e * (q.X[0] - mx); ty += e * (q.X[1] - my); } v = tt > 1e-6 ? Math.min(9, Math.hypot(tx / tt, ty / tt)) : null; }
      if (p && dt > 1) speed.push([+(p.t + 0.01).toFixed(2), null]);
      speed.push([d.t, v == null ? null : +v.toFixed(2)]); if (v != null) vs.push(v);
    }
    vs.sort((a, b) => a - b);
    return { id, colour: cents[id - 1], distance: dist, seconds: secs, topSpeed: vs.length ? vs[Math.floor(vs.length * 0.95)] : 0, speed, heatmap: { cell: 0.25, nx, ny: 39, seconds: Array.from(heat, (v) => +v.toFixed(3)) } };
  });
  // who was where: nearest detection in time per player
  const byId = { 1: dets.filter((d) => d.id === 1), 2: dets.filter((d) => d.id === 2) };
  const playersAt = (t, X) => {
    const near = [];
    for (const id of [1, 2]) { const L = byId[id]; if (!L.length) continue; let lo = 0, hi = L.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (L[m].t < t) lo = m + 1; else hi = m; } const q = [L[lo], L[lo - 1]].filter(Boolean).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0]; if (Math.abs(q.t - t) < 0.4) near.push({ id, dist: Math.hypot(q.X[0] - X[0], q.X[1] - X[1]) }); }
    near.sort((a, b) => a.dist - b.dist); return near.length ? { id: near[0].id, dist: near[0].dist, other: near[1]?.dist ?? null } : null;
  };
  // the delay from impacts the picture saw (fitted, and flights ending on the floor)
  const seen = flights.flatMap((f) => impactsOf(f).map((m) => m.t)).sort((a, b) => a - b);
  const off = audioOffset(heard, seen);
  const B = new Bounces();
  const shift = off.sure ? off.offset : 0, on = heard.map((t) => t - shift);
  // per stretch of flights (the window logic wants nearby flights only)
  const CM = new Commentary();
  for (let i = 0; i < flights.length;) { let j = i + 1; while (j < flights.length && flights[j].t0 - flights[j - 1].t1 < 3) j++; B.update(flights.slice(i, j), { onsets: on, players: playersAt }); CM.update(flights.slice(i, j), B.list, playersAt); i = j; }
  return {
    ...meta, courtSeconds: parts.reduce((s, p) => s + p.courtSeconds, 0),
    audio: { heard: heard.length, offset: shift, matched: off.matched, chance: off.chance, sure: off.sure },
    players, flights: flights.length, flightsOtherViews: allFlights.length - flights.length,
    shots: CM.shots.map((s) => ({ t: +s.t.toFixed(3), player: s.player, kind: s.kind, front: s.front.map((v) => +v.toFixed(3)), bounce: s.bounce && s.bounce.X.map((v) => +v.toFixed(3)), speed: s.speed && +s.speed.toFixed(1), apex: +s.apex.toFixed(2), tight: s.tight, measured: s.measured, quality: s.quality, text: describe(s) })),
    bounces: B.list.map((m) => ({ t: +m.t.toFixed(3), plane: m.plane, x: +m.X[0].toFixed(3), y: +m.X[1].toFixed(3), z: +m.X[2].toFixed(3), inferred: !!m.inferred, sound: !!m.sound, player: m.player ?? null })),
  };
}
// Identities across cuts. Each tracked player of one camera stretch gets the median shirt colour
// of its detections, leaving out those taken while the two players were within 0.9 m (the boxes
// mix there) or occluded. Tracks of one stretch that are seen at the same moments are two people:
// they form chains (a track dropped and restarted is linked to the same partner), and a chain has
// only two possible labellings, so it is labelled as a whole, whichever fits the two shirt colours
// better. The two colours are found by k-means over the tracks, then refined with those
// constraints. A track with too few colour reads takes its label from its chain, or is left out.
function linkIdentities(dets) {
  const tracks = new Map(), at = new Map();
  for (const d of dets) {
    if (!tracks.has(d.track)) tracks.set(d.track, { key: d.track, stretch: d.track.split(':').slice(0, 2).join(':'), cols: [], n: 0, ts: new Set(), other: new Set() });
    const T = tracks.get(d.track); T.n++; T.ts.add(d.t);
    const k = T.stretch + '@' + d.t; if (!at.has(k)) at.set(k, []); at.get(k).push(d);
  }
  for (const g of at.values()) {
    const close = g.length >= 2 && Math.hypot(g[0].X[0] - g[1].X[0], g[0].X[1] - g[1].X[1]) < 0.9;
    for (const d of g) { const T = tracks.get(d.track); if (d.col && !close && !d.occ) T.cols.push(d.col); for (const o of g) if (o.track !== d.track) T.other.add(o.track); }
  }
  const T = [...tracks.values()];
  for (const t of T) t.col = t.cols.length >= 5 ? [0, 1, 2].map((k) => t.cols.map((c) => c[k]).sort((a, b) => a - b)[t.cols.length >> 1]) : null;
  // chains: 2-colour the "seen together" graph; a chain that cannot be 2-coloured is split back
  // into single tracks
  const side = new Map(), chains = [];
  for (const t of T) {
    if (side.has(t.key)) continue;
    const C = [t], q = [t]; side.set(t.key, 0); let ok = true;
    while (q.length) { const a = q.pop(); for (const k of a.other) { const o = tracks.get(k); if (!side.has(k)) { side.set(k, 1 - side.get(a.key)); C.push(o); q.push(o); } else if (side.get(k) === side.get(a.key)) ok = false; } }
    if (ok) chains.push(C); else for (const c of C) { side.set(c.key, 0); chains.push([c]); }
  }
  const w = (t) => Math.min(200, t.cols.length);
  const coloured = T.filter((t) => t.col);
  let cents = kmeans2(coloured.flatMap((t) => Array(Math.min(20, t.cols.length)).fill(t.col)));
  for (let it = 0; it < 10; it++) {
    for (const C of chains) {
      // cost of labelling side 0 as player 1 (flip = 0) or as player 2 (flip = 1)
      const cost = [0, 1].map((flip) => C.reduce((s, t) => s + (t.col ? w(t) * dist3(t.col, cents[(side.get(t.key) ^ flip)]) : 0), 0));
      const flip = cost[0] <= cost[1] ? 0 : 1, any = C.some((t) => t.col);
      for (const t of C) { t.id = any ? (side.get(t.key) ^ flip) + 1 : null; t.margin = Math.abs(cost[0] - cost[1]); }
    }
    const next = [1, 2].map((id) => { const S = coloured.filter((t) => t.id === id), W = S.reduce((s, t) => s + w(t), 0); return W ? [0, 1, 2].map((k) => S.reduce((s, t) => s + w(t) * t.col[k], 0) / W) : cents[id - 1]; });
    const moved = Math.max(dist3(next[0], cents[0]), dist3(next[1], cents[1]));
    cents = next.map((c) => c.map(Math.round));
    if (moved < 0.5) break;
  }
  return { tracks, cents, chains: chains.length };
}

// shirt colours compared by hue (red-green, blue-green) more than brightness: the same shirt is
// darker in one corner of the court than another
const feat = (c) => [c[0] - c[1], c[2] - c[1], (c[0] + c[1] + c[2]) / 6];
const dist3 = (a, b) => { const p = feat(a), q = feat(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
function kmeans2(P) {
  if (P.length < 2) return [[255, 0, 0], [0, 0, 255]];
  const mean = [0, 1, 2].map((k) => P.reduce((s, p) => s + p[k], 0) / P.length);
  let a = P.reduce((b, p) => (dist3(p, mean) > dist3(b, mean) ? p : b)), b = P.reduce((c, p) => (dist3(p, a) > dist3(c, a) ? p : c));
  for (let it = 0; it < 20; it++) {
    const A = [], Bs = []; for (const p of P) (dist3(p, a) <= dist3(p, b) ? A : Bs).push(p);
    const m = (S, d) => (S.length ? [0, 1, 2].map((k) => S.reduce((s, p) => s + p[k], 0) / S.length) : d); a = m(A, a); b = m(Bs, b);
  }
  return [a, b].map((c) => c.map(Math.round));
}

// ---------- picture ----------
function render(M, file) {
  const s = 48, w = Math.round(CW * s) * 2 + 30, h = Math.round(CL * s) + 40, img = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let i = 0; i < w * h; i++) { img.data[i * 4] = 22; img.data[i * 4 + 1] = 24; img.data[i * 4 + 2] = 29; img.data[i * 4 + 3] = 255; }
  const col = (id) => (id === 1 ? [255, 45, 122] : id === 2 ? [45, 212, 255] : [170, 170, 170]);
  const panel = (ox, fill) => {
    for (let y = 0; y < CL * s; y++) for (let x = 0; x < CW * s; x++) { const o = ((y + 30) * w + x + ox) * 4; img.data[o] = 60; img.data[o + 1] = 52; img.data[o + 2] = 44; }
    fill(ox);
    const m = courtModel(); for (const l of m.lines) if (l.kind === 'floor') line(img, ox + (CW - l.a[0]) * s, 30 + l.a[1] * s, ox + (CW - l.b[0]) * s, 30 + l.b[1] * s, [0, 230, 255], 1); // x = 0 (the right wall) on the right
  };
  const blend = (ox, X, Y, c, a) => { const x = Math.round(ox + X), y = Math.round(30 + Y); if (x < ox || y < 30 || x >= ox + CW * s || y >= 30 + CL * s) return; const o = (y * w + x) * 4; for (let k = 0; k < 3; k++) img.data[o + k] = img.data[o + k] * (1 - a) + c[k] * a; };
  // left: players' heatmaps
  panel(0, (ox) => {
    for (const p of M.players) {
      const H = p.heatmap, g = blurGrid(H.seconds, H.nx, H.ny), mx = Math.max(...g);
      for (let y = 0; y < CL * s; y++) for (let x = 0; x < CW * s; x++) { const v = sample(g, H.nx, H.ny, (CW - x / s) / 0.25 - 0.5, y / s / 0.25 - 0.5) / mx; if (v > 0.05) blend(ox, x, y, col(p.id), Math.min(0.85, 0.9 * v)); }
    }
  });
  // right: bounces, glow and dots by hitter
  const ox2 = Math.round(CW * s) + 30, fl = M.bounces.filter((m) => m.plane === 'floor');
  panel(ox2, (ox) => {
    const H = heatGrid(fl.map((m) => [m.x, m.y]), 0.25, CW, CL), mx = Math.max(1e-9, ...H.g);
    for (let y = 0; y < CL * s; y++) for (let x = 0; x < CW * s; x++) { const v = sample(H.g, H.nx, H.ny, (CW - x / s) / 0.25 - 0.5, y / s / 0.25 - 0.5) / mx; if (v > 0.12) blend(ox, x, y, [255, 110 + 140 * v, 40 + 150 * v * v], Math.min(0.85, 0.9 * v)); }
    for (const m of fl) for (let a = 0; a < 6.28; a += 0.4) for (let r = 0; r <= 3; r++) blend(ox, (CW - m.x) * s + r * Math.cos(a), m.y * s + r * Math.sin(a), col(m.player), 1);
  });
  writeImage(file, img);
}
function blurGrid(a, nx, ny) { let g = Float32Array.from(a); for (let p = 0; p < 2; p++) { const o = new Float32Array(g.length); for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { let v = 0, s = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const X = x + i, Y = y + j; if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue; const k = (i ? 0.5 : 1) * (j ? 0.5 : 1); v += g[Y * nx + X] * k; s += k; } o[y * nx + x] = v / s; } g = o; } return g; }
function sample(g, nx, ny, x, y) { const x0 = Math.max(0, Math.min(nx - 1, Math.floor(x))), y0 = Math.max(0, Math.min(ny - 1, Math.floor(y))), x1 = Math.min(nx - 1, x0 + 1), y1 = Math.min(ny - 1, y0 + 1), fx = Math.max(0, Math.min(1, x - x0)), fy = Math.max(0, Math.min(1, y - y0)); return g[y0 * nx + x0] * (1 - fx) * (1 - fy) + g[y0 * nx + x1] * fx * (1 - fy) + g[y1 * nx + x0] * (1 - fx) * fy + g[y1 * nx + x1] * fx * fy; }

if (opt('--merge')) { // re-run the merge on the chunks of an earlier run: --merge <out dir>
  const dir = opt('--merge'), res = []; for (let i = 0; ; i++) { try { res.push(JSON.parse(readFileSync(`${dir}/chunk_${i}.json`, 'utf8'))); } catch { break; } }
  const M = merge(res, { source: src.split('/').pop(), duration: res.reduce((s, p) => s + p.len, 0) });
  writeFileSync(`${dir}/match.json`, JSON.stringify(M)); render(M, `${dir}/match.png`); console.log(`merged ${res.length} chunks into ${dir}/match.json`); process.exit(0);
}
if (opt('--render')) { render(JSON.parse(readFileSync(opt('--render'), 'utf8')), src); process.exit(0); }
if (opt('--chunk')) { await chunk(src, +opt('--chunk'), +opt('--len'), opt('--json')); process.exit(0); }
await main();

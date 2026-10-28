// A recorded session: everything the live analysis produced, so a camera session (which cannot be
// re-run, unlike a file) can be looked at afterwards. It is a match.json (the format tools/match.mjs
// writes and the page opens) plus what is needed to replay it in 3D: every player position and
// every fitted ball flight.
//
//   keepFlights(all, window) -> all, with the worker's latest flight window merged in (the worker
//     keeps only its last 40 flights and can replace one with a better rival, so what the window
//     covers is replaced)
//   toMatch({ ... }) -> match object with .recorded = { positions, flights }
//   fromRecorded(M) -> { flights, logs: { id: [{ t, X }] }, t0, t1 } for the replay
//   playersAt(logs, t) -> [{ id, X, seen }] where each player was at t (null if not seen near then)
//   rallyList(M) -> [{ n, t0, t1, shots, by: { 1: n, 2: n }, last: shot }] the session's rallies
//   Store: IndexedDB list / get / put / remove of { id, date, source, duration, shots, data }
//   pickCleanup(recs, opts) -> [{ id, drop: 'video' | 'all', bytes }] what a clean-up removes
//   Video: the optional recorded picture, in ~10 s segments (each a whole playable file):
//     put(id, seg, { t0, t1, mime, cam, w, h }, blob), segments(id), remove(id)
import { W as CW, L as CL } from './court.js';
import { rallies } from './coaching.js';

const r3 = (v) => Math.round(v * 1000) / 1000, r2 = (v) => Math.round(v * 100) / 100;

export function keepFlights(all, win) {
  if (!win || !win.length) return all;
  const a = Math.min(...win.map((f) => f.t0)) - 0.05, b = Math.max(...win.map((f) => f.t1)) + 0.05;
  const out = all.filter((f) => f.t0 < a || f.t0 > b);
  for (const f of win) out.push({ cam: f.cam, t0: f.t0, t1: f.t1, speed: f.speed, labels: f.labels, impacts: f.impacts.map((m) => ({ t: m.t, X: m.X.slice(), plane: m.plane })), pts: f.pts.map((q) => ({ t: q.t, X: q.X.slice(), V: q.V && q.V.slice() })) });
  return out.sort((p, q) => p.t0 - q.t0);
}

// stats: the page's per-player { heat, dist, time, top, series: [{ t, v }], log: [{ t, X }] };
// tctl: id -> TControl summary; bounces: Bounces.list; shots: Commentary shots; text(shot) its line
export function toMatch({ source = 'camera', names = {}, started = Date.now(), duration = 0, courtSeconds = null, stats = {}, tctl = {}, bounces = [], shots = [], coach = null, flights = [], camera = null, text = () => '', cell = 0.25 }) {
  const nx = Math.ceil(CW / cell), ny = Math.ceil(CL / cell);
  const players = Object.entries(stats).map(([id, st]) => ({
    id: +id, distance: st.dist, seconds: st.time, topSpeed: st.top, tControl: tctl[id] ?? null,
    speed: st.series.map((q) => [r2(q.t), q.v == null ? null : r2(q.v)]),
    heatmap: { cell, nx, ny, seconds: Array.from(st.heat, r3) },
  }));
  return {
    kind: 'session', version: 1, source, names, started, duration, courtSeconds: courtSeconds ?? duration,
    camera: camera && { C: camera.C.map(r3), f: Math.round(camera.f) },
    players,
    bounces: bounces.map((m) => ({ t: r3(m.t), plane: m.plane, x: r3(m.X[0]), y: r3(m.X[1]), z: r3(m.X[2]), inferred: !!m.inferred, sound: !!m.sound, player: m.player ?? null })),
    shots: shots.map((s) => ({ t: r3(s.t), player: s.player ?? null, kind: s.kind, front: s.front.map(r3), bounce: s.bounce && s.bounce.X.map(r3), bounceT: s.bounce ? r3(s.bounce.t) : null, bounceInferred: !!s.bounce?.inferred, struck: s.struck && { t: r3(s.struck.t), X: s.struck.X.map(r3), V: s.struck.V.map(r2) }, speed: s.speed && r2(s.speed), apex: s.apex != null ? r2(s.apex) : null, tight: s.tight, measured: s.measured, quality: s.quality, text: text(s) })),
    coach,
    recorded: {
      positions: Object.fromEntries(Object.entries(stats).map(([id, st]) => [id, st.log.map((q) => [r3(q.t), r3(q.X[0]), r3(q.X[1])])])),
      flights: flights.map((f) => ({ t0: r3(f.t0), t1: r3(f.t1), speed: f.speed && r2(f.speed), cam: f.cam, labels: f.labels, impacts: f.impacts.map((m) => ({ t: r3(m.t), plane: m.plane, X: m.X.map(r3) })), pts: f.pts.map((q) => [r3(q.t), ...q.X.map(r3), ...(q.V ? q.V.map(r2) : [])]) })),
    },
  };
}

export function fromRecorded(M) {
  const R = M.recorded; if (!R) return null;
  const flights = R.flights.map((f) => ({ ...f, uv: [], rms: 0, pts: f.pts.map((p) => ({ t: p[0], X: p.slice(1, 4), V: p.length >= 7 ? p.slice(4, 7) : null })) }));
  const logs = Object.fromEntries(Object.entries(R.positions).map(([id, L]) => [id, L.map((p) => ({ t: p[0], X: [p[1], p[2]] }))]));
  const ts = [...flights.flatMap((f) => [f.t0, f.t1]), ...Object.values(logs).flatMap((L) => (L.length ? [L[0].t, L[L.length - 1].t] : []))];
  return { flights, logs, t0: ts.length ? Math.min(...ts) : 0, t1: ts.length ? Math.max(...ts) : 0 };
}

// Rallies from the named shots (coaching.js: the next front-wall contact within 2.3 s), each from
// a little before its first hit to its last bounce, with who hit how many (the coaching rows' hitter,
// which labels a whole rally from the shots that say who hit them).
export function rallyList(M, { gap = 2.3 } = {}) {
  const shots = (M.shots ?? []).filter((s) => s.quality == null || s.quality >= 2).sort((a, b) => a.t - b.t);
  const rows = M.coach?.shots ?? [], hitter = (s) => rows.find((r) => Math.abs(r.t - s.t) < 0.01)?.hitter ?? s.player ?? null;
  return rallies(shots, gap).map((R, i) => {
    const a = R[0], z = R[R.length - 1], by = { 1: 0, 2: 0 };
    for (const s of R) { const h = hitter(s); if (h === 1 || h === 2) by[h]++; }
    return { n: i + 1, t0: a.struck?.t ?? a.t - 0.6, t1: z.bounceT ?? z.t + 1.2, shots: R.length, by, last: { ...z, hitter: hitter(z) } };
  });
}

export function playersAt(logs, t, near = 0.5) {
  const out = [];
  for (const [id, L] of Object.entries(logs)) {
    if (!L.length) continue;
    let lo = 0, hi = L.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (L[m].t < t) lo = m + 1; else hi = m; }
    const q = [L[lo], L[lo - 1]].filter(Boolean).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    if (Math.abs(q.t - t) <= near) out.push({ id: +id, X: q.X.slice(), seen: true });
  }
  return out;
}

// What a clean-up removes, oldest first. recs: [{ id, date, bytes (analysis), video (bytes) }].
//   olderThan: only recordings started before this time (ms); keepNewest: never the newest n;
//   keep: ids never touched (the session being recorded); what: 'video' drops only the picture
//   (the analysis stays, and it is small), 'all' the whole recording;
//   need: stop once this many bytes are freed (the automatic clean-up), else take all that match.
export function pickCleanup(recs, { olderThan = Infinity, keepNewest = 0, keep = [], what = 'video', need = Infinity } = {}) {
  const newest = new Set([...recs].sort((a, b) => b.date - a.date).slice(0, keepNewest).map((r) => r.id)), skip = new Set(keep);
  const out = []; let freed = 0;
  for (const r of [...recs].sort((a, b) => a.date - b.date)) {
    if (freed >= need) break;
    if (r.date >= olderThan || newest.has(r.id) || skip.has(r.id)) continue;
    const bytes = what === 'all' ? (r.bytes ?? 0) + (r.video ?? 0) : r.video ?? 0;
    if (!bytes && what === 'video') continue;
    out.push({ id: r.id, drop: what, bytes }); freed += bytes;
  }
  return out;
}

// ---------- storage (IndexedDB, browser only) ----------
const DB = 'squash-court', ST = 'sessions', VS = 'video';
function db() {
  return new Promise((ok, bad) => {
    const q = indexedDB.open(DB, 2);
    q.onupgradeneeded = () => { const d = q.result; if (!d.objectStoreNames.contains(ST)) d.createObjectStore(ST, { keyPath: 'id' }); if (!d.objectStoreNames.contains(VS)) d.createObjectStore(VS, { keyPath: 'k' }); };
    q.onsuccess = () => ok(q.result); q.onerror = () => bad(q.error);
  });
}
const tx = async (mode, fn, store = ST) => { const d = await db(); return new Promise((ok, bad) => { const t = d.transaction(store, mode), r = fn(t.objectStore(store)); t.oncomplete = () => ok(r?.result); t.onerror = () => bad(t.error); }); };
// a session's video segments: keys `${id}|0003`, so one key range is the whole session
const range = (id) => IDBKeyRange.bound(`${id}|`, `${id}|\uffff`);
export const Video = {
  put: (id, seg, meta, blob) => tx('readwrite', (s) => s.put({ k: `${id}|${String(seg).padStart(4, '0')}`, id, seg, ...meta, size: blob.size, blob }), VS),
  segments: async (id) => (await tx('readonly', (s) => s.getAll(range(id)), VS)).sort((a, b) => a.seg - b.seg),
  remove: (id) => tx('readwrite', (s) => s.delete(range(id)), VS),
  // bytes per session, without reading the blobs' contents
  sizes: async () => { const out = {}; for (const r of await tx('readonly', (s) => s.getAll(), VS)) out[r.id] = (out[r.id] ?? 0) + r.size; return out; },
};
export const Store = {
  put: (rec) => tx('readwrite', (s) => s.put(rec)),
  get: (id) => tx('readonly', (s) => s.get(id)),
  remove: async (id) => { await Video.remove(id); return tx('readwrite', (s) => s.delete(id)); },
  // newest first, metadata only (each record is read whole: fine for tens of sessions)
  // bytes: the analysis as stored (older records without the field are measured here)
  list: async () => (await tx('readonly', (s) => s.getAll())).map(({ data, ...m }) => ({ ...m, bytes: m.bytes ?? JSON.stringify(data ?? null).length })).sort((a, b) => b.date - a.date),
};

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
//   Store: IndexedDB list / get / put / remove of { id, date, source, duration, shots, data }
import { W as CW, L as CL } from './court.js';

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

// ---------- storage (IndexedDB, browser only) ----------
const DB = 'squash-court', ST = 'sessions';
function db() {
  return new Promise((ok, bad) => { const q = indexedDB.open(DB, 1); q.onupgradeneeded = () => q.result.createObjectStore(ST, { keyPath: 'id' }); q.onsuccess = () => ok(q.result); q.onerror = () => bad(q.error); });
}
const tx = async (mode, fn) => { const d = await db(); return new Promise((ok, bad) => { const t = d.transaction(ST, mode), r = fn(t.objectStore(ST)); t.oncomplete = () => ok(r?.result); t.onerror = () => bad(t.error); }); };
export const Store = {
  put: (rec) => tx('readwrite', (s) => s.put(rec)),
  get: (id) => tx('readonly', (s) => s.get(id)),
  remove: (id) => tx('readwrite', (s) => s.delete(id)),
  // newest first, metadata only (each record is read whole: fine for tens of sessions)
  list: async () => (await tx('readonly', (s) => s.getAll())).map(({ data, ...m }) => (void data, m)).sort((a, b) => b.date - a.date),
};

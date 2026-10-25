// Coaching numbers from the shots (commentary.js) and the players' tracked positions:
//   1. T at the opponent's hit: where each player stands at the moment the other strikes the ball,
//      and how often that is on the T (within `radius` of it)
//   2. volleys: how often each player takes the ball before it bounces, where from, and where the
//      opponent is at that moment
//   3. first bounces: one per shot, the ball's first floor contact after the front wall, by player
//      and shot type (a volleyed shot has none)
//
//   coachStats(shots, posAt) -> { players: { 1: {...}, 2: {...} }, shots: [...] }
//   posAt(id, t) -> [x, y] where player id stood at time t (nearest detection), or null
//
// Each shot is built round its front-wall contact (s.t) and carries `struck`, the first fitted
// point of the ball on its way in. The racket hit is earlier: the ball is carried back from there
// to where it passes closest to a player, and that player is the hitter (a racket's reach from
// the feet). Within a rally the hitters must alternate, so the rally is labelled as a whole: the
// alternation that agrees best with the per-shot evidence (the hitter recorded on its bounce, the
// nearer player at the hit). A gap long enough to hide a missed shot starts a new rally.
import { W as CW } from './court.js';
import { extrapolate } from './bounces.js';
import { T_POINT } from './tcontrol.js';

const xy = (X) => [X[0], X[1]];
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const bounceOf = (s) => (s.bounce ? (Array.isArray(s.bounce) ? (s.bounceT != null ? { t: s.bounceT, X: s.bounce, inferred: !!s.bounceInferred } : null) : s.bounce) : null);

// The racket hit for one shot, for one candidate hitter: the ball carried back from `struck`
// until it is within a racket's reach of that player's feet (horizontally), or else to its
// closest pass, at most 1 s back (the first fitted point can be well after the racket).
export function hitFor(struck, feet, reach = 0.8) {
  let s = { X: struck.X, V: struck.V }, t = struck.t, best = { t, X: s.X, d: dist2(s.X, feet) };
  for (let k = 0; k < 200 && best.d > reach; k++) {
    s = extrapolate(s.X, s.V, -0.005); t -= 0.005;
    if (s.X[2] < 0.02 || s.X[2] > 5 || s.X[1] > 9.8) break;
    const d = dist2(s.X, feet);
    if (d < best.d) best = { t, X: s.X, d }; else if (d > best.d + 0.3) break;
  }
  return best;
}

// Shots split into rallies: the next front-wall contact follows within `gap` s (a shot takes
// 0.8-2 s front wall to front wall; a missed one leaves about twice that)
export function rallies(shots, gap = 2.3) {
  const out = []; let cur = [];
  for (const s of shots) { if (cur.length && s.t - cur[cur.length - 1].t > gap) { out.push(cur); cur = []; } cur.push(s); }
  if (cur.length) out.push(cur);
  return out;
}

// Per shot: the hit for each player, and how strongly the evidence says who hit it (+ for 1, - for 2)
function evidence(s, posAt) {
  const e = { vote: 0, hits: {} };
  if (s.player === 1 || s.player === 2) e.vote += s.player === 1 ? 2 : -2;
  if (!s.struck?.V) return e;
  for (const id of [1, 2]) { const p = posAt(id, s.struck.t); if (p) e.hits[id] = hitFor(s.struck, p); }
  const a = e.hits[1]?.d, b = e.hits[2]?.d;
  if (a != null && b != null) { const m = (b - a) / Math.max(0.5, Math.min(a, b) + 0.5); if (Math.min(a, b) < 1.6) e.vote += Math.max(-1, Math.min(1, m)); }
  else if (a != null && a < 1.2) e.vote += 0.5; else if (b != null && b < 1.2) e.vote -= 0.5;
  return e;
}

export function assignHitters(shots, posAt, gap) {
  const ev = new Map(shots.map((s) => [s, evidence(s, posAt)])), out = new Map();
  for (const R of rallies(shots, gap)) {
    // alternation A: the first shot is P1's; B: P2's. Score = votes agreeing minus disagreeing.
    let score = 0, weight = 0;
    R.forEach((s, i) => { const v = ev.get(s).vote; score += i % 2 ? -v : v; weight += Math.abs(v); });
    const sure = weight > 0 ? Math.abs(score) / weight : 0;
    R.forEach((s, i) => {
      const e = ev.get(s), first = score >= 0 ? 1 : 2, id = weight > 0 && sure >= 0.34 ? (i % 2 ? 3 - first : first) : null;
      out.set(s, { id, sure, own: Math.abs(e.vote) >= 1 ? (e.vote > 0 ? 1 : 2) : null, hit: id ? e.hits[id] ?? null : null, rally: R });
    });
  }
  return out;
}

export function coachStats(shots, posAt, { radius = 1.0, gap = 2.3 } = {}) {
  shots = shots.slice().sort((a, b) => a.t - b.t);
  const H = assignHitters(shots, posAt, gap), P = { 1: newPlayer(), 2: newPlayer() }, list = [];
  shots.forEach((s, i) => {
    const h = H.get(s), prev = shots[i - 1], next = shots[i + 1];
    const sameR = (o) => o && H.get(o).rally === h.rally;
    const hit = h.hit, hitT = hit?.t ?? null;
    const row = { t: s.t, hitter: h.id, sure: +h.sure.toFixed(2), kind: s.kind, hit: hit ? { t: +hit.t.toFixed(3), X: hit.X.map((v) => +v.toFixed(2)) } : null, volley: null, opp: null, oppT: null, first: null };
    // 2. a volley: the previous shot (the opponent's) had not reached the floor when this one was hit
    if (hit && sameR(prev)) {
      const b = bounceOf(prev);
      if (b && hitT - prev.t > 0.2) {
        if (b.t < hitT - 0.03) row.volley = false;
        // a bounce carried on past the hit is where it would have landed; one actually seen after
        // the hit contradicts it (the hit time is wrong), so that shot is left undecided
        else if (b.t > hitT + 0.03 && b.inferred) row.volley = true;
      }
    }
    // 1. the opponent at this hit
    if (h.id && hitT != null) { const o = posAt(3 - h.id, hitT); if (o) { row.opp = o.map((v) => +v.toFixed(2)); row.oppT = +dist2(o, T_POINT).toFixed(2); } }
    // 3. first bounce: this shot's, unless the next shot was hit before it (volleyed)
    const b = bounceOf(s);
    if (b && b.X[1] > 0.3) {
      const nh = sameR(next) ? H.get(next).hit : null;
      if (!(nh && nh.t < b.t - 0.03)) row.first = { t: +b.t.toFixed(3), X: xy(b.X).map((v) => +v.toFixed(2)), inferred: !!b.inferred };
    }
    list.push(row);
    if (!h.id) return;
    const me = P[h.id], op = P[3 - h.id];
    if (row.oppT != null) { op.tAt.push(row.oppT); op.tPts.push(row.opp); }
    if (row.volley != null) { me.decided++; if (row.volley) { me.volleys++; me.volleyPts.push({ X: xy(row.hit.X), opp: row.opp, kind: s.kind?.type ?? null }); } }
    if (row.first) me.first.push({ X: row.first.X, kind: s.kind?.type ?? null, inferred: row.first.inferred });
    me.shots++;
  });
  const players = {};
  for (const id of [1, 2]) players[id] = summarise(P[id], radius);
  return { radius, shots: list, players, attributed: list.filter((r) => r.hitter).length, total: list.length };
}

const newPlayer = () => ({ shots: 0, tAt: [], tPts: [], decided: 0, volleys: 0, volleyPts: [], first: [] });
function summarise(p, radius) {
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
  const zone = (y) => (y < 5.44 ? 'front' : y < 7.04 ? 'middle' : 'back');
  const byKind = {}, zones = { front: 0, middle: 0, back: 0 };
  for (const f of p.first) { const k = f.kind ?? 'shot'; byKind[k] = (byKind[k] || 0) + 1; zones[zone(f.X[1])]++; }
  const drives = p.first.filter((f) => f.kind === 'drive');
  const vKinds = {}; for (const v of p.volleyPts) vKinds[v.kind ?? 'shot'] = (vKinds[v.kind ?? 'shot'] || 0) + 1;
  return {
    shots: p.shots,
    // where this player was when the OPPONENT hit
    tAtOppHit: { n: p.tAt.length, onT: p.tAt.filter((d) => d < radius).length, share: p.tAt.length ? p.tAt.filter((d) => d < radius).length / p.tAt.length : null, medianDistance: med(p.tAt), points: p.tPts },
    volleys: { n: p.volleys, of: p.decided, share: p.decided ? p.volleys / p.decided : null, kinds: vKinds, points: p.volleyPts },
    firstBounces: {
      n: p.first.length, zones, byKind, points: p.first,
      drives: drives.length, drivesDeep: drives.filter((f) => f.X[1] > 7.04).length, drivesTight: drives.filter((f) => Math.min(f.X[0], CW - f.X[0]) < 0.5).length,
    },
  };
}

// Nearest detection in time from per-player logs [{ t, X }] sorted by t, within `tol` s
export function posAtFromLogs(logs, tol = 0.4) {
  return (id, t) => {
    const L = logs[id]; if (!L || !L.length) return null;
    let lo = 0, hi = L.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (L[m].t < t) lo = m + 1; else hi = m; }
    const q = [L[lo], L[lo - 1]].filter(Boolean).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    return q && Math.abs(q.t - t) <= tol ? xy(q.X) : null;
  };
}

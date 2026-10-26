// A rally in metres, frame by frame: players (detected, then tracked with identities) and the ball
// (moving blobs linked into 2D tracks; a finished track is cut at its impacts and fitted as 3D
// ballistic flights). Used by the worker for video and by tools/rally_run.mjs.
//
//   const R = new Rally(); R.frame(rgba, W, H, cam, t, { tin }) ->
//     { dup, players: [{ id, X: [x, y], seen, box? }], ball: { u, v } | null, flights: all | null }
//   flights is the whole recent list when it changed (a new flight can replace a worse rival).
//
// Frames repeated by the encoder (broadcast 25 fps in a 50 fps file) change nothing and are
// skipped, so a three-frame difference always compares frames that differ. Times are the media
// times, so frames analysed at an uneven rate still fit the flight model.
import { detectPlayers, PlayerTracker } from './players.js';
import { toGray, ballCandidates, BallTracker, cutTrack, fitFlights, outside } from './ball.js';

export class Rally {
  constructor({ gridW = 640, playerW = 480, playerEvery = 0 } = {}) {
    this.gridW = gridW; this.playerW = playerW; this.playerEvery = playerEvery; this.reset();
  }
  reset() {
    this.grays = []; // last three distinct frames: { g, t }
    this.ballT = new BallTracker({ gate: 12, slack: 0.6, maxMiss: 3, impacts: false, first: 40 });
    this.playerT = new PlayerTracker(); this.dets = []; this.tPlayers = -Infinity; this.flights = []; this.queue = [];
    // (this.onsets survives a reset: it is the whole soundtrack)
    this.last = null; this.fgN = null; this.fgFrames = 0;
  }
  // Fixed things the colour model calls foreground (glass-door brackets, the bars under a score
  // bug, a camera on the tin): pixels that are foreground in most frames of this camera stretch.
  // People move, so their pixels are foreground a fraction of the time. Masked pixels are not
  // counted again, so the mask does not switch itself off.
  staticMask() {
    if (!this.fgN || this.fgFrames < 30) return null; // 6 s of player detections
    const N = this.fgN, f = this.fgFrames * 0.7;
    return (i) => N[i] > f;
  }
  learnStatic(P, mask) {
    const n = P.w * P.h;
    if (!this.fgN || this.fgN.length !== n) { this.fgN = new Uint16Array(n); this.fgFrames = 0; }
    this.fgFrames++;
    for (let i = 0; i < n; i++) if (P.fg[i] || (mask && mask(i))) this.fgN[i]++;
  }
  // players / ball: which parts to run (the page runs them in two workers so the slow player search
  // never makes the ball skip frames); boxes (rgba px) and playerX (metres): players found
  // elsewhere, for the ball to ignore and for its racket hits
  frame(rgba, W, H, cam, t, { tin = 0.48, players: doPlayers = true, ball: doBall = true, boxes = null, playerX = null } = {}) {
    const ms = {}, t0 = now();
    const g = toGray(rgba, W, H, Math.min(this.gridW, W));
    const prev = this.grays[this.grays.length - 1];
    if (prev && (t <= prev.t || meanDiff(prev.g.g, g.g) < 0.2)) return { dup: true, players: this.last?.players ?? [], ball: null, flights: [], ms };
    // players: detection on this frame (or every `playerEvery` s), identities from the tracker
    let players = [];
    if (!doPlayers) { if (boxes) this.dets = boxes.map((box, i) => ({ box, X: playerX?.[i] ?? null })); }
    else if (t - this.tPlayers >= this.playerEvery) {
      const mask = this.staticMask(), t1 = now(), P = detectPlayers(rgba, W, H, cam, { tin, width: Math.min(this.playerW, W), staticMask: mask ?? undefined });
      this.learnStatic(P, mask);
      this.dets = P.players; this.tPlayers = t; ms.players = now() - t1;
      players = this.playerT.update(P.players, t).map((p) => { const d = this.playerT.tracks.find((k) => k.id === p.id)?.det; return { ...p, box: d?.box ?? null, col: d?.col ?? null }; });
    } else players = this.playerT.update([], t).map((p) => ({ ...p, box: null }));
    // ball: candidates in the middle one of the last three distinct frames
    this.grays.push({ g, t }); if (this.grays.length > 3) this.grays.shift();
    let ball = null; const flights = [];
    if (doBall && this.grays.length === 3) {
      const [A, B, C] = this.grays, k = W / g.w;
      const grid = this.dets.map((p) => p.box.map((v) => v / k));
      const cands = ballCandidates(A.g, B.g, C.g, cam, { players: grid, thr: 10, fps: 1 / Math.max(1e-3, (C.t - A.t) / 2) });
      this.ballT.update(B.t, cands);
      // the live ball: the longest current track that was seen just now and moves
      const live = this.ballT.tracks.filter((tr) => tr.miss === 0 && tr.pts.length >= 3).sort((a, b) => b.pts.length - a.pts.length)[0];
      if (live) { const q = live.pts[live.pts.length - 1]; ball = { u: q.u, v: q.v, t: q.t }; }
      // finished tracks are fitted one per frame, longest first, so a burst of them (a cut, a
      // crowd) spreads its cost instead of stalling one frame
      this.queue = (this.queue || []).concat(this.ballT.done.splice(0).filter((tr) => tr.pts.length >= 6)).sort((a, b) => b.pts.length - a.pts.length).slice(0, 6);
      const tr = this.queue.shift(); if (tr) flights.push(...(this.fit(tr, cam, W) || []));
    }
    ms.total = now() - t0;
    this.last = { players, ball };
    const changed = this.add(flights);
    return { dup: false, players, ball, flights: changed ? this.flights : null, ms };
  }
  // flush the open tracks (end of a clip)
  finish(cam, W) { const out = []; for (const tr of [...(this.queue || []), ...this.ballT.finish()]) { out.push(...(this.fit(tr, cam, W) || [])); } this.ballT = new BallTracker({ gate: 12, slack: 0.6, maxMiss: 3, impacts: false, first: 40 }); this.add(out); return this.flights; }
  // There is one ball: of flights that overlap in time (the ball and its reflection in the glass,
  // one track split in two, a racket swung beside it) the better supported one stays. Support is
  // its length in frames, less its fit error, plus a bonus when it starts where the ball can be
  // expected to start (off a player's racket, or where a kept flight ended just before: a bounce)
  // and when the soundtrack agrees: an impact heard just before its first frame (the hit), just
  // after its last (the wall or floor it was heading for) or at a fitted impact inside it.
  // this.onsets: heard impact times in the same clock as the frames (sorted), or null.
  // Returns whether the list changed.
  add(flights) {
    let changed = false;
    const players = this.dets.map((p) => p.X).filter(Boolean);
    const startsWell = (f) => {
      const a = f.pts[0]; if (!a) return false;
      if (a.X[2] < 2.5 && players.some((X) => Math.hypot(a.X[0] - X[0], a.X[1] - X[1]) < 1.5)) return true;
      return this.flights.some((g) => g !== f && f.t0 - g.t1 > -0.05 && f.t0 - g.t1 < 0.2 && Math.hypot(...g.pts[g.pts.length - 1].X.map((v, j) => v - a.X[j])) < 1.0);
    };
    const support = (g) => g.uv.length - 2 * g.rms + (g.startsWell ? 8 : 0) + 4 * (g.heard ?? 0);
    for (const f of flights) {
      f.startsWell = startsWell(f); f.heard = this.heardFor(f);
      const rivals = this.flights.filter((g) => Math.min(f.t1, g.t1) - Math.max(f.t0, g.t0) > 0.06);
      if (rivals.some((g) => support(g) >= support(f))) continue;
      this.flights = this.flights.filter((g) => !rivals.includes(g)); this.flights.push(f); changed = true;
    }
    this.flights.sort((a, b) => a.t0 - b.t0); if (this.flights.length > 40) this.flights.splice(0, this.flights.length - 40);
    return changed;
  }
  // how many of a flight's ends and impacts have a heard impact where one belongs (0-3)
  heardFor(f) {
    const on = this.onsets; if (!on || !on.length) return 0;
    const any = (a, b) => { let lo = 0, hi = on.length; while (lo < hi) { const m = (lo + hi) >> 1; if (on[m] < a) lo = m + 1; else hi = m; } return lo < on.length && on[lo] <= b; };
    return (any(f.t0 - 0.12, f.t0 + 0.02) ? 1 : 0) + (any(f.t1 - 0.02, f.t1 + 0.12) ? 1 : 0) + (f.impacts.some((m) => any(m.t - 0.04, m.t + 0.04)) ? 1 : 0);
  }
  // rejected tracks, with why, when this.debug is an array (diagnostics only)
  why(tr, reason) { if (this.debug) this.debug.push({ reason, pts: tr.pts.map((q) => ({ t: q.t, u: q.u, v: q.v })) }); return null; }
  // A finished 2D track becomes flights in metres (an array, possibly empty) if it is one: it
  // moves, the flight model explains its pixels, and it stays in the court at a ball's speeds.
  // Spectators, players' limbs and reflections mostly fail one of those.
  fit(tr, cam, W) {
    const pts = tr.pts.map((q) => ({ t: q.t, u: q.u, v: q.v })), s = W / 1280;
    if (pts.length < 6) return this.why(tr, 'short');
    const span = Math.hypot(pts[pts.length - 1].u - pts[0].u, pts[pts.length - 1].v - pts[0].v);
    let path = 0; for (let i = 1; i < pts.length; i++) path += Math.hypot(pts[i].u - pts[i - 1].u, pts[i].v - pts[i - 1].v);
    if (span < 12 * s || span / (pts[pts.length - 1].t - pts[0].t) < 150 * s) return this.why(tr, 'still'); // still, or drifting: a spectator, a reflection, a racket held up
    // cheap first: a flight's image path is smooth in time between impacts (a quadratic fits each
    // piece to a few px), a jittering limb or reflection is not. A track can run on through a wall
    // or floor bounce, so it is split where one quadratic stops fitting: a ball gives a few long
    // pieces, a limb many short ones. Only those go to 3D.
    const pieces = smoothPieces(pts, 3 * Math.max(1, s));
    const covered = pieces.reduce((n, [a, b]) => n + b - a + 1, 0);
    if (covered < 0.7 * pts.length || pieces.length > Math.max(2, pts.length / 8)) return this.why(tr, 'jitter');
    // each piece is then its own flight (or two, where the flight model finds a soft bounce or the
    // frames next to an impact inside it), fitted on its own: the fit's cost grows with the number
    // of flights chained, and a 1 s track fitted as one chain would stall the ball worker for a
    // second. A piece that is not a flight is dropped without taking the rest of the track with it.
    const out = [];
    for (const [a, e] of pieces) { const f = this.fitPiece(tr, pts.slice(a, e + 1), cam, s); if (f) out.push(f); }
    return out;
  }
  fitPiece(tr, pts, cam, s) {
    const segs = cutTrack(pts, cam, { tol: 2.5 * Math.max(1, s) });
    if (!segs.length) return this.why(tr, 'nosegs');
    const used = segs.reduce((n, [a, b]) => n + b - a + 1, 0);
    if (used < 5 || used < 0.6 * pts.length) return this.why(tr, 'fewused');
    const F = fitFlights(pts, segs, cam, { players: this.dets.map((p) => p.X).filter(Boolean), beam: 3 });
    if (!(F.rms < 2 * Math.max(1, s))) return this.why(tr, 'rms');
    const P3 = F.flights.flatMap((f) => f.pts3);
    if (P3.some((q) => outside(q.X) > 0.3)) return this.why(tr, 'outside');
    // a racket or a hand: every point of it next to a player (a real flight leaves the player it
    // came off within a few frames)
    const near = this.dets.map((p) => p.X).filter(Boolean);
    if (near.length && P3.every((q) => q.X[2] < 2.4 && near.some((X) => Math.hypot(q.X[0] - X[0], q.X[1] - X[1]) < 1.0))) return this.why(tr, 'player');
    const speeds = F.flights.map((f) => Math.hypot(...f.V0));
    if (speeds.some((v) => v > 75) || Math.max(...speeds) < 4) return this.why(tr, 'speed'); // slower than a drop shot: a spectator through the glass
    return {
      cam: cam.C.map((v) => +v.toFixed(2)), // where the camera stood: shots are named from the main view only
      t0: pts[0].t, t1: pts[pts.length - 1].t, rms: F.rms, labels: F.labels, speed: Math.max(...speeds),
      pts: P3.map((q) => ({ t: q.t, X: q.X, V: q.V })), uv: pts.map((q) => [q.u, q.v]),
      impacts: F.impacts.map((m) => ({ t: m.t, X: m.X, plane: m.plane })),
    };
  }
}

// Split a 2D track into pieces each fitted by one quadratic in time to within tol px rms (grown
// greedily, at least 5 points); points that start no piece are left out. Returns [first, last]
// index pairs.
function smoothPieces(pts, tol, minLen = 5) {
  const out = []; let s = 0;
  while (s + minLen <= pts.length) {
    let e = s + minLen - 1;
    if (smooth2D(pts.slice(s, e + 1)) > tol) { s++; continue; }
    while (e + 1 < pts.length && smooth2D(pts.slice(s, e + 2)) <= tol) e++;
    out.push([s, e]); s = e + 1;
  }
  return out;
}
// rms (px) of the best quadratic in time through a track's u and v
function smooth2D(pts) {
  const t0 = pts[0].t, T = pts.map((p) => p.t - t0), n = pts.length;
  const fit = (y) => { // least squares y = a + b t + c t^2 via normal equations
    const S = [0, 0, 0, 0, 0], R = [0, 0, 0];
    for (let i = 0; i < n; i++) { let p = 1; for (let k = 0; k < 5; k++) { S[k] += p; if (k < 3) R[k] += p * y[i]; p *= T[i]; } }
    const M = [[S[0], S[1], S[2]], [S[1], S[2], S[3]], [S[2], S[3], S[4]]], x = solve3(M, R);
    if (!x) return Infinity;
    let e = 0; for (let i = 0; i < n; i++) { const d = x[0] + x[1] * T[i] + x[2] * T[i] * T[i] - y[i]; e += d * d; } return e / n;
  };
  return Math.sqrt(fit(pts.map((p) => p.u)) + fit(pts.map((p) => p.v)));
}
function solve3(M, r) {
  const d = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = d(M); if (Math.abs(D) < 1e-18) return null;
  return [0, 1, 2].map((j) => d(M.map((row, i) => row.map((v, k) => (k === j ? r[i] : v)))) / D);
}
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function meanDiff(a, b) { let s = 0; const n = Math.min(a.length, b.length), step = 7; let m = 0; for (let i = 0; i < n; i += step) { s += Math.abs(a[i] - b[i]); m++; } return s / m; }

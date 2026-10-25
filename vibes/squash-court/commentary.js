// Shot-by-shot commentary from the ball's fitted flights.
//
// A squash shot is defined by where it meets the front wall and what it does after: so every shot
// is built around a front-wall contact, measured (a fitted impact) or inferred (a flight heading
// forward carried on to the wall, or one coming back carried back to it). Around the contact:
//   in   the flight(s) arriving: speed, where they came from, a side wall on the way (a boast)
//   out  the flight(s) leaving until the next racket hit: apex, the first floor bounce, how close
//        to a side wall the ball runs on its way back
// and the shot is named from those: lob, drop, kill, boast, drive (straight or crosscourt), with
// length, width, tightness and pace.
//
//   new Commentary().update(flights, bounces, playersAt) -> the shots (re)built in that window
//   describe(shot) -> one line of commentary
import { W as CW, L as CL } from './court.js';
import { extrapolate } from './bounces.js';

const SHORT = 5.44, BOX = 7.04; // short line (back edge), back of the service boxes

// The main broadcast view: high behind the back wall. Court-level, side and close-up cameras see
// too little of a flight in depth (and replays from them are slowed down), so shots and bounces
// are only read from this one.
export const mainView = (C) => !C || (C[1] > CL + 1 && C[2] > 2.5);
const side = (x) => (x < CW / 2 ? 'right' : 'left'); // x = 0 is the right wall facing the front
const nearWall = (x) => Math.min(x, CW - x);

// Front-wall contacts in a set of flights, measured or carried on to the wall.
export function frontContacts(flights, { reach = 0.6 } = {}) {
  const out = [];
  const onWall = (X) => X[0] > -0.05 && X[0] < CW + 0.05 && X[2] > 0.05 && X[2] < 5.4;
  for (const f of flights) {
    for (const m of f.impacts) if (m.plane === 'front') out.push({ t: m.t, X: m.X, measured: true });
    const a = f.pts[0], z = f.pts[f.pts.length - 1];
    if (z.V && z.V[1] < -1 && !f.impacts.some((m) => m.plane === 'front' && m.t >= z.t - 0.05)) { const c = carry(z, -1, reach); if (c && onWall(c.X)) out.push({ ...c, measured: false }); }
    if (a.V && a.V[1] > 1 && a.X[1] < 5 && !f.impacts.some((m) => m.plane === 'front' && m.t <= a.t + 0.05)) { const c = carry(a, 1, reach); if (c && onWall(c.X)) out.push({ ...c, measured: false }); }
  }
  out.sort((p, q) => p.t - q.t);
  // one contact per 0.12 s: a measured one wins, else their mean
  const merged = [];
  for (const c of out) {
    const p = merged[merged.length - 1];
    if (p && c.t - p.t < 0.12) { if (c.measured && !p.measured) merged[merged.length - 1] = c; else if (c.measured === p.measured) { p.t = (p.t + c.t) / 2; p.X = p.X.map((v, j) => (v + c.X[j]) / 2); } continue; }
    merged.push({ ...c });
  }
  return merged;
}
// carry a state forward (dir -1: the flight heads for y = 0 later) or back (dir 1: it came from it)
function carry(q, dir, reach) {
  let s = { X: q.X, V: q.V }, t = q.t; const h = 0.01 * (dir < 0 ? 1 : -1);
  for (let k = 0; k * 0.01 < reach; k++) {
    const n = extrapolate(s.X, s.V, h);
    if (n.X[1] <= 0.02) { const f = (s.X[1] - 0.02) / (s.X[1] - n.X[1]); return { t: t + h * f, X: s.X.map((v, j) => v + (n.X[j] - v) * f), V: s.V }; }
    s = n; t += h;
    if (s.X[2] < 0) return null;
  }
  return null;
}

// Build the shot around one front-wall contact.
function shotAt(c, flights, bounces, playersAt, next) {
  const tEnd = Math.min(next ?? Infinity, c.t + 2.5), pts = flights.flatMap((f) => f.pts);
  const inPts = pts.filter((q) => q.t < c.t - 0.005 && q.t > c.t - 1.6 && q.V && q.V[1] < 0).sort((a, b) => a.t - b.t);
  const outPts = pts.filter((q) => q.t > c.t + 0.005 && q.t < tEnd && q.V && q.V[1] > -0.5).sort((a, b) => a.t - b.t);
  const imps = flights.flatMap((f) => f.impacts);
  // pace: the fastest the ball is seen going in (it slows from the racket on); else the speed off
  // the wall times a typical loss (restitution ~0.45 along y, not much across)
  const vIn = inPts.length ? Math.max(...inPts.map((q) => Math.hypot(...q.V))) : null;
  const vOut = outPts.length ? Math.hypot(...outPts[0].V) : null;
  const speed = vIn ?? (vOut != null ? vOut * 1.6 : c.V ? Math.hypot(...c.V) : null);
  const boast = imps.some((m) => (m.plane === 'right' || m.plane === 'left') && m.t < c.t && m.t > c.t - 0.6 && (!inPts.length || m.t > inPts[0].t - 0.05));
  const from = inPts.length ? inPts[0].X : null;
  // after the wall: apex, bounce, closest pass to a side wall in the back half
  const apex = Math.max(c.X[2], ...outPts.map((q) => q.X[2]));
  const inCourt = (m) => m.X[1] > 0.3; // a 'bounce' at the front wall is a misfit
  let bounce = bounces.filter(inCourt).find((m) => m.plane === 'floor' && m.t > c.t + 0.05 && m.t < tEnd) ?? imps.filter(inCourt).find((m) => m.plane === 'floor' && m.t > c.t + 0.05 && m.t < tEnd);
  if (!bounce && outPts.length) { // carry the last point to the floor
    let s = { X: outPts[outPts.length - 1].X, V: outPts[outPts.length - 1].V }, t = outPts[outPts.length - 1].t;
    for (let k = 0; k < 120 && s.X[2] > 0.02; k++) { s = extrapolate(s.X, s.V, 0.01); t += 0.01; }
    if (s.X[2] <= 0.02 && s.X[1] < CL + 0.3 && s.X[1] > 0.3) bounce = { t, X: [s.X[0], s.X[1], 0], inferred: true };
  }
  const back = outPts.filter((q) => q.X[1] > SHORT);
  const tight = Math.min(bounce ? nearWall(bounce.X[0]) : Infinity, ...back.map((q) => nearWall(q.X[0])));
  const sideHit = imps.find((m) => (m.plane === 'right' || m.plane === 'left') && m.t > c.t && m.t < (bounce?.t ?? tEnd));
  // who hit it: the hitter recorded on its bounce, else the player nearest where it came from
  let player = bounce?.player ?? null;
  if (!player && from) { const p = playersAt(inPts[0].t, from); if (p && p.dist < 2.5 && (p.other == null || p.dist < 0.7 * p.other)) player = p.id; }
  const quality = (c.measured ? 2 : 1) + (inPts.length >= 3 ? 1 : 0) + (outPts.length >= 3 ? 1 : 0) + (bounce && !bounce.inferred ? 1 : 0);
  const s = { t: c.t, front: c.X, measured: c.measured, speed, from, apex, bounce: bounce ? { t: bounce.t, X: bounce.X, inferred: !!bounce.inferred } : null, struck: struckPoint(inPts, flights), tight, boast, sideAfter: sideHit?.plane ?? null, player, quality };
  s.kind = classify(s);
  return s;
}

// The ball just off the racket: the first point of the last stretch of flight heading for the
// front wall, after any back or side wall it came off (a ball coming forward off the back wall
// has not been hit yet). Racket hits end a fitted flight, so the stretch is within one flight.
function struckPoint(inPts, flights) {
  if (!inPts.length) return null;
  const last = inPts[inPts.length - 1], f = flights.find((g) => g.pts.includes(last));
  const wall = Math.max(-Infinity, ...(f?.impacts ?? []).filter((m) => m.plane !== 'front' && m.plane !== 'floor' && m.t < last.t).map((m) => m.t));
  const run = inPts.filter((q) => f.pts.includes(q) && q.t > wall);
  const q = run[0] ?? last;
  return { t: q.t, X: q.X, V: q.V, wall: wall > -Infinity };
}
// Name the shot. Thresholds are from the court (tin 0.43-0.48 m, service line 1.78 m, short line
// 5.44 m) and typical professional pace (drives 35-50 m/s off the racket, drops under 20).
export function classify(s) {
  const z = s.front[2], v = s.speed ?? 0, b = s.bounce, by = b ? b.X[1] : null;
  const fromSide = s.from ? side(s.from[0]) : null, toSide = b ? side(b.X[0]) : s.sideAfter === 'right' ? 'right' : s.sideAfter === 'left' ? 'left' : null;
  // crosscourt: struck clearly on one side, ending clearly on the other
  const toX = b ? b.X[0] : s.sideAfter === 'right' ? 0 : s.sideAfter === 'left' ? CW : null;
  const cross = fromSide && toSide && fromSide !== toSide && Math.abs(s.from[0] - CW / 2) > 0.6 && toX != null && Math.abs(toX - CW / 2) > 0.6;
  const out = {};
  if (s.boast) out.type = 'boast';
  else if (z > 2.6 && s.apex > 3.6 && v < 32) out.type = 'lob'; // high and slow; a short one is a lob that sits up
  else if (z < 0.95 && v < 22 && (by == null || by < 4.5)) out.type = 'drop';
  else if (z < 0.95 && v >= 28 && (by == null || by < 6.5)) out.type = 'kill';
  else out.type = 'drive';
  if (out.type === 'drive' || out.type === 'lob') out.direction = cross ? 'crosscourt' : 'straight';
  if (by != null) out.length = by > BOX + 0.6 ? 'deep' : by > SHORT ? 'length' : 'short';
  if (s.tight < 0.35) out.tight = toSide ?? (b ? side(b.X[0]) : null);
  else if (cross && b && nearWall(b.X[0]) < 1.2 && by > SHORT) out.wide = true; // a crosscourt past the opponent
  if (s.sideAfter && out.type === 'drive' && cross) out.wide = true;
  out.pace = v >= 40 ? 'hard' : v >= 28 ? 'firm' : v > 0 && v < 15 ? 'soft' : null;
  if (out.type === 'drop' && s.tight < 0.35) out.nick = s.tight < 0.12;
  return out;
}

export function describe(s, name = (id) => `P${id}`) {
  const k = s.kind, who = s.player ? name(s.player) : 'A player';
  // pace only when it is believable for that shot (a misfit flight can say 12 or 300 km/h)
  const ok = s.speed && (k.type === 'drop' ? s.speed > 4 && s.speed < 25 : k.type === 'lob' ? s.speed > 8 && s.speed < 30 : s.speed > 18 && s.speed < 75);
  const kmh = ok ? ` (${Math.round(s.speed * 3.6)} km/h)` : '';
  let shot;
  if (k.type === 'drive') shot = `${ok && k.pace === 'hard' ? 'a hard ' : 'a '}${k.direction} drive`;
  else if (k.type === 'lob') shot = `a ${k.direction === 'crosscourt' ? 'crosscourt' : 'straight'} lob${s.apex ? `, ${s.apex.toFixed(1)} m high` : ''}`;
  else if (k.type === 'drop') shot = `a drop${k.nick ? ' into the nick' : ''}, ${Math.round((s.front[2] - 0.45) * 100)} cm above the tin`;
  else if (k.type === 'kill') shot = `a kill${ok && k.pace === 'hard' ? ', hit hard' : ''}, low on the front wall`;
  else shot = 'a boast off the side wall';
  const tail = [];
  if (k.tight && !k.nick) tail.push(k.type === 'drop' || k.type === 'kill' || k.type === 'boast' ? `hugging the ${k.tight} wall` : `tight down the ${k.tight} wall`);
  else if (k.wide) tail.push('wide past the middle');
  if (k.length === 'deep') tail.push('dying in the back corner');
  else if (k.length === 'length' && k.type !== 'lob') tail.push('to a good length');
  else if (k.length === 'short' && (k.type === 'drive' || k.type === 'lob')) tail.push('but it sits up short');
  return `${who} plays ${shot}${kmh}${tail.length ? ', ' + tail.join(', ') : ''}.`;
}

// Movement lines: a player at full stretch, or pulled into a corner.
export function movement(id, X, speed, name = (i) => `P${i}`) {
  const corner = X[1] < 2.6 ? 'front' : X[1] > 8.0 ? 'back' : null;
  if (speed > 4.3 && corner) return `${name(id)} races into the ${corner} ${side(X[0])} corner (${speed.toFixed(1)} m/s).`;
  if (corner === 'back' && nearWall(X[0]) < 0.9) return `${name(id)} is pinned in the back ${side(X[0])} corner.`;
  return null;
}

// The shots in the stretch of time a flight window covers are rebuilt from it each time (the ball
// worker's window can refit or replace flights); earlier shots stay. Each shot keeps an id so the
// page can update its line in place.
export class Commentary {
  constructor() { this.shots = []; this.n = 0; }
  update(flights, bounces = [], playersAt = () => null) {
    if (!flights.length) return [];
    const t0 = flights[0].t0 - 0.6, t1 = Math.max(...flights.map((f) => f.t1)) + 0.6;
    const C = frontContacts(flights).filter((c) => c.t >= t0 && c.t <= t1);
    const built = C.map((c, i) => shotAt(c, flights, bounces, playersAt, C[i + 1]?.t));
    const old = this.shots.filter((s) => s.t >= t0 && s.t <= t1);
    for (const s of built) { const o = old.find((p) => Math.abs(p.t - s.t) < 0.15); s.id = o ? o.id : ++this.n; }
    this.shots = this.shots.filter((s) => s.t < t0 || s.t > t1).concat(built).sort((a, b) => a.t - b.t);
    return built;
  }
  clear() { this.shots = []; }
}

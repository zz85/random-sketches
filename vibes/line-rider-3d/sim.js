// Rider physics, no three.js. Line Rider's model carried into 3D: Verlet point masses joined by sticks,
// one-sided collision against the track (here ribbons instead of lines), bindings between rider and sled
// that break past a stretch limit ("bosh"). Deterministic: the same track and flag always give the same run.
import { G, V } from './track.js';
const { sub, add, mul, dot, cross, len, norm } = V;

export const FPS = 60, SUB = 4, DT = 1 / (FPS * SUB), ITER = 3;
export const HIT = 0.45;      // how far under a surface a point is still pushed back out
export const EXT = 0.12;      // segments reach this far past their ends so joints don't leak
export let ENDURE = 0.13;   // binding stretch (relative, seen in one substep) that throws the rider off: a ~4 unit drop onto flat
export const ACC = 24;        // accelerate-line push, units/s^2
export const FRIC_BODY = 0.1; // rider's body drags when it touches the track; the sled doesn't
export const GRIP = 0.85;    // per substep, share of sideways (across-ribbon) sled velocity turned into speed along it
export let ALIGN = 7;         // 1/s, how fast the sled yaws into its direction of travel while touching
export const tune = (o) => { if ('ALIGN' in o) ALIGN = o.ALIGN; if ('ENDURE' in o) ENDURE = o.ENDURE; };   // tests only

export const P = { TL: 0, TR: 1, NL: 2, NR: 3, S: 4, B: 5, SH: 6, HL: 7, HR: 8, FL: 9, FR: 10 };
export const NP = 11;
// rest pose in the sled frame: [forward, up, right]
const REST = [
  [-0.5, 0, -0.25], [-0.5, 0, 0.25], [0.5, 0, -0.25], [0.5, 0, 0.25], [0.52, 0.34, 0],
  [-0.28, 0.12, 0], [-0.1, 0.8, 0], [0.4, 0.42, -0.13], [0.4, 0.42, 0.13], [0.42, 0.15, -0.11], [0.42, 0.15, 0.11],
];
const SLED = [0, 1, 2, 3, 4];
const STICKS = [];   // [i, j, stiffness, kind]  kind 0 sled, 1 body, 2 binding
for (let a = 0; a < SLED.length; a++) for (let b = a + 1; b < SLED.length; b++) STICKS.push([SLED[a], SLED[b], 1, 0]);
for (const [i, j, k] of [[5, 6, 1], [6, 7, 1], [6, 8, 1], [5, 9, 1], [5, 10, 1], [9, 10, 0.5], [7, 8, 0.3]]) STICKS.push([i, j, k, 1]);
for (const [i, j, k] of [[5, 0, 1], [5, 1, 1], [5, 2, 1], [5, 3, 1], [6, 0, 0.35], [6, 1, 0.35], [6, 4, 0.35], [7, 4, 0.6], [8, 4, 0.6], [9, 2, 1], [10, 3, 1], [9, 0, 0.5], [10, 1, 0.5]]) STICKS.push([i, j, k, 2]);
let REST_LEN = null;

function frameFrom(dir, up = [0, 1, 0]) {
  const F = norm(dir);
  let U = sub(up, mul(F, dot(up, F)));
  U = len(U) < 1e-3 ? (Math.abs(F[1]) < 0.9 ? norm(sub([0, 1, 0], mul(F, F[1]))) : [1, 0, 0]) : norm(U);
  return { F, U, R: cross(F, U) };
}
function restPositions(origin, dir, up) {
  const { F, U, R } = frameFrom(dir, up);
  return REST.map(([f, u, r]) => add(origin, add(mul(F, f), add(mul(U, u), mul(R, r)))));
}
REST_LEN = (() => { const p = restPositions([0, 0, 0], [1, 0, 0]); return STICKS.map(([i, j]) => len(sub(p[i], p[j]))); })();

// flag = { p: sled centre on the track, dir: heading, up?: surface normal there, v: initial speed }
export function spawn(flag) {
  const pos = new Float64Array(NP * 3), prev = new Float64Array(NP * 3);
  const pts = restPositions(flag.p, flag.dir, flag.up || [0, 1, 0]);
  const F = norm(flag.dir), dv = mul(F, (flag.v || 0) * DT);
  pts.forEach((p, i) => { pos.set(p, i * 3); prev.set(sub(p, dv), i * 3); });
  return { pos, prev, crashed: false, crashFrame: -1, frame: 0, contact: 0 };
}
export function cloneState(s) { return { pos: s.pos.slice(), prev: s.prev.slice(), crashed: s.crashed, crashFrame: s.crashFrame, frame: s.frame, contact: s.contact }; }

const get = (a, i) => [a[i * 3], a[i * 3 + 1], a[i * 3 + 2]];
const put = (a, i, v) => { a[i * 3] = v[0]; a[i * 3 + 1] = v[1]; a[i * 3 + 2] = v[2]; };

// check: measure bindings before correcting them (Line Rider breaks a binding on the stretch it sees
// before the solver pulls it back, so a hard enough jolt in one step throws the rider)
export const stats = { maxStretch: 0 };
function satisfy(st, check) {
  const p = st.pos;
  for (let k = 0; k < STICKS.length; k++) {
    const [i, j, stiff, kind] = STICKS[k];
    if (kind === 2 && st.crashed) continue;
    const dx = p[j * 3] - p[i * 3], dy = p[j * 3 + 1] - p[i * 3 + 1], dz = p[j * 3 + 2] - p[i * 3 + 2];
    const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-9;
    if (check && kind === 2) {
      const r = Math.abs(L - REST_LEN[k]) / REST_LEN[k];
      if (r > stats.maxStretch) stats.maxStretch = r;
      if (r > ENDURE) { st.crashed = true; st.crashFrame = st.frame; }
    }
    const f = ((L - REST_LEN[k]) / L) * 0.5 * stiff;
    p[i * 3] += dx * f; p[i * 3 + 1] += dy * f; p[i * 3 + 2] += dz * f;
    p[j * 3] -= dx * f; p[j * 3 + 1] -= dy * f; p[j * 3 + 2] -= dz * f;
  }
}

// Push point i out of any ribbon it has sunk into from the riding side. Returns the contact normal or null.
function collide(st, track, i, last, cn) {
  const pos = st.pos, prev = st.prev;
  let px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
  const cands = track.query(px, py, pz);
  let hit = false;
  for (let c = 0; c < cands.length; c++) {
    const s = track.segs[cands[c]];
    const rx = px - s.a[0], ry = py - s.a[1], rz = pz - s.a[2];
    const along = rx * s.t[0] + ry * s.t[1] + rz * s.t[2];
    if (along < -EXT || along > s.L + EXT) continue;
    const u = Math.max(0, Math.min(1, along / s.L));
    const nx0 = s.na[0] + (s.nb[0] - s.na[0]) * u, ny0 = s.na[1] + (s.nb[1] - s.na[1]) * u, nz0 = s.na[2] + (s.nb[2] - s.na[2]) * u;
    const nl = Math.sqrt(nx0 * nx0 + ny0 * ny0 + nz0 * nz0), nx = nx0 / nl, ny = ny0 / nl, nz = nz0 / nl;
    const qx = rx - s.t[0] * along, qy = ry - s.t[1] * along, qz = rz - s.t[2] * along;   // offset from centre line
    const sx = s.sa[0] + (s.sb[0] - s.sa[0]) * u, sy = s.sa[1] + (s.sb[1] - s.sa[1]) * u, sz = s.sa[2] + (s.sb[2] - s.sa[2]) * u;
    const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    const lat = (qx * sx + qy * sy + qz * sz) / sl;
    if (Math.abs(lat) > s.w / 2) continue;
    const d = qx * nx + qy * ny + qz * nz;
    if (d >= 0 || d < -HIT) continue;
    const vx = px - prev[i * 3], vy = py - prev[i * 3 + 1], vz = pz - prev[i * 3 + 2];
    if (vx * nx + vy * ny + vz * nz > 0) continue;   // already leaving
    px -= nx * d; py -= ny * d; pz -= nz * d;
    if (last) {
      if (i >= 5 && (st.crashed || i < 9)) {   // body points drag along the surface (feet ride on the sled until a crash)
        const vn = vx * nx + vy * ny + vz * nz;
        prev[i * 3] += (vx - nx * vn) * FRIC_BODY; prev[i * 3 + 1] += (vy - ny * vn) * FRIC_BODY; prev[i * 3 + 2] += (vz - nz * vn) * FRIC_BODY;
      }
      if (i < 4 && !st.crashed) {   // runners: sideways slip is steered along the track, speed kept
        const vn = vx * nx + vy * ny + vz * nz;
        const ux = sx / sl, uy = sy / sl, uz = sz / sl;
        const vs = vx * ux + vy * uy + vz * uz;
        const tx = vx - nx * vn - ux * vs, ty = vy - ny * vn - uy * vs, tz = vz - nz * vn - uz * vs;
        const vt = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (vt > 1e-9) {
          const vs2 = vs * (1 - GRIP), vt2 = Math.sqrt(vt * vt + vs * vs - vs2 * vs2);
          const k = vt2 / vt;
          const nvx = tx * k + ux * vs2, nvy = ty * k + uy * vs2, nvz = tz * k + uz * vs2;
          const vn2 = vn - d;   // normal velocity after the push-out
          prev[i * 3] = px - nvx - nx * vn2; prev[i * 3 + 1] = py - nvy - ny * vn2; prev[i * 3 + 2] = pz - nvz - nz * vn2;
        }
      }
      if (s.type === 1) { const k = ACC * DT * DT * s.dir; px += s.t[0] * k; py += s.t[1] * k; pz += s.t[2] * k; }
    }
    if (cn) { cn[0] += nx; cn[1] += ny; cn[2] += nz; }
    hit = true;
  }
  pos[i * 3] = px; pos[i * 3 + 1] = py; pos[i * 3 + 2] = pz;
  return hit;
}

function rotateAbout(st, idx, c, axis, ang) {
  const cs = Math.cos(ang), sn = Math.sin(ang);
  for (const i of idx) {
    const p = get(st.pos, i), r = sub(p, c);
    // Rodrigues
    const k = axis, kr = cross(k, r), kd = dot(k, r);
    const nr = add(add(mul(r, cs), mul(kr, sn)), mul(k, kd * (1 - cs)));
    const np = add(c, nr), d = sub(np, p);
    put(st.pos, i, np);
    put(st.prev, i, add(get(st.prev, i), d));   // move, don't spin the momentum
  }
}

const ALL = [...Array(NP).keys()];
function substep(st, track) {
  const pos = st.pos, prev = st.prev, g = -G * DT * DT;
  for (let i = 0; i < NP * 3; i += 3) {
    const vx = pos[i] - prev[i], vy = pos[i + 1] - prev[i + 1], vz = pos[i + 2] - prev[i + 2];
    prev[i] = pos[i]; prev[i + 1] = pos[i + 1]; prev[i + 2] = pos[i + 2];
    pos[i] += vx; pos[i + 1] += vy + g; pos[i + 2] += vz;
  }
  const cn = [0, 0, 0];
  let contact = 0;
  for (let it = 0; it < ITER; it++) {
    satisfy(st, it === 0 && !st.crashed);
    const last = it === ITER - 1;
    for (let i = 0; i < NP; i++) if (collide(st, track, i, last, i < 4 && last ? cn : null) && last && i < 4) contact++;
  }
  st.contact = contact;
  if (!st.crashed) checkCrash(st);
  // yaw the sled into its direction of travel while it's on the track (runners), like a sled carving
  if (contact > 0 && len(cn) > 1e-6) {
    const n = norm(cn);
    const tail = mul(add(get(pos, 0), get(pos, 1)), 0.5), nose = mul(add(get(pos, 2), get(pos, 3)), 0.5);
    let F = sub(nose, tail); F = sub(F, mul(n, dot(F, n)));
    let v = [0, 0, 0];
    for (let i = 0; i < 4; i++) v = add(v, sub(get(pos, i), get(prev, i)));
    v = sub(v, mul(n, dot(v, n)));
    if (len(v) > 4 * 0.5 * DT && len(F) > 1e-6) {
      if (dot(F, v) < 0) v = mul(v, -1);
      const ang = Math.atan2(dot(cross(F, v), n), dot(F, v));
      const c = mul(add(tail, nose), 0.5);
      rotateAbout(st, st.crashed ? SLED : ALL, c, n, ang * (1 - Math.exp(-ALIGN * DT)));
    }
  }
}

function checkCrash(st) {
  const p = st.pos;
  const f = sledFrame(st);
  const body = sub(get(p, P.SH), get(p, P.B));
  if (dot(f.U, body) < 0.15 * len(body)) { st.crashed = true; st.crashFrame = st.frame; }
}

export function sledFrame(st) {
  const p = st.pos;
  const tl = get(p, 0), tr = get(p, 1), nl = get(p, 2), nr = get(p, 3);
  const F = norm(sub(add(nl, nr), add(tl, tr)));
  const R = norm(sub(add(tr, nr), add(tl, nl)));
  const U = norm(cross(R, F));
  return { c: mul(add(add(tl, tr), add(nl, nr)), 0.25), F, R, U };
}

export function step(st, track) {
  for (let k = 0; k < SUB; k++) substep(st, track);
  st.frame++;
}

export function point(st, i) { return get(st.pos, i); }
export function velocity(st, i = 0) { return mul(sub(get(st.pos, i), get(st.prev, i)), 1 / DT); }
export function speed(st) {
  let v = [0, 0, 0];
  for (let i = 0; i < 4; i++) v = add(v, sub(get(st.pos, i), get(st.prev, i)));
  return len(v) / (4 * DT);
}

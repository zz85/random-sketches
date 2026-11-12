/*
 * figures.js - people for the sets, as the film shows them: figures against the light, Luv walking the corridor's
 * stairs and the hall's stepping stones, Wallace standing at his desk or sitting in the hall. Each is a small
 * jointed figure of lathed and capsule parts (no model files), lit by the same lamps, so it reads as a silhouette
 * against a bright wall and catches the ripples where the light falls on it.
 *
 * figure(opts) builds one; walker(f, path, h) walks it back and forth along a path of [x, z] points at a walking
 * pace, standing a while at each end and turning; h(x, z) is the floor's height there (stairs, a deck).
 */
import * as THREE from 'three/webgpu';

const mat = (c, r = 0.6, sheen = 0) => sheen
  ? new THREE.MeshPhysicalNodeMaterial({ color: c, roughness: r, sheen, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xfff0d8) })
  : new THREE.MeshStandardNodeMaterial({ color: c, roughness: r, metalness: 0 });

// a solid of revolution from [radius, height] pairs, squashed front to back by `depth`
function lathe(pts, depth = 0.75, seg = 20) {
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg);
  g.scale(1, 1, depth); return g;
}
const capsule = (r, len, m) => { const g = new THREE.CapsuleGeometry(r, len, 4, 10); g.translate(0, -len / 2 - r * 0.6, 0); return new THREE.Mesh(g, m); };
function add(parent, mesh) { mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh; }

/*
 * kind: 'woman' (a fitted dress to the knee, a bun, heels) or 'man' (a long loose jacket, trousers);
 * dress, skin, hair: colours; height in metres. Faces +z, standing on y = 0.
 */
// The leg measures of the MakeHuman Luv (assets/luv.glb, as tools/makehuman_luv.py prints them), in metres: her
// figure is built with them, so the walker's feet land the same for the mannequin and for the model it drives.
// heel and pitch: her stiletto booties lift her 6.9 cm and point her feet 33 degrees toe-down.
export const LUV_LEGS = { hipY: 0.9288, thigh: 0.4232, shin: 0.4392, hipX: 0.0979, heel: 0.0692, pitch: 0.576 };

// clasp: her hands come together in front of her as she takes the stairs, as Luv's do in the stills.
export function figure({ kind = 'woman', dress = 0xc8b898, skin = 0x5a4232, hair = 0x0c0907, height = 1.72, legs: LG = null, clasp = false } = {}) {
  const W = kind === 'woman', s = height / (W ? 1.72 : 1.85);
  const mDress = mat(dress, 0.55, W ? 0.5 : 0), mSkin = mat(skin, 0.5), mHair = mat(hair, 0.4), mDark = mat(0x0a0806, 0.5);
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body); body.scale.setScalar(s);
  const hipY = (LG?.hipY ?? (W ? 0.92 : 0.98)) + (LG?.heel ?? 0), thigh = LG?.thigh ?? (W ? 0.43 : 0.46), shin = LG?.shin ?? (W ? 0.42 : 0.46), hipX = LG?.hipX ?? (W ? 0.075 : 0.1);
  const pelvis = new THREE.Group(); pelvis.position.y = hipY; body.add(pelvis);
  // the legs: hips, knees, feet
  const legs = [];
  for (const sx of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(sx * hipX, 0, 0); pelvis.add(hip);
    add(hip, capsule(W ? 0.062 : 0.075, thigh - 0.08, W ? mSkin : mDark));
    const knee = new THREE.Group(); knee.position.y = -thigh; hip.add(knee);
    add(knee, capsule(W ? 0.045 : 0.06, shin - 0.08, W ? mSkin : mDark));
    add(knee, new THREE.Mesh(new THREE.SphereGeometry(W ? 0.05 : 0.066, 10, 8), W ? mSkin : mDark));
    // the ankle, and a foot from it down to the ground (the heel's height for her)
    const ankle = new THREE.Group(); ankle.position.y = -shin; knee.add(ankle);
    const gap = hipY - thigh - shin;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(W ? 0.07 : 0.1, gap, W ? 0.2 : 0.27), mDark);
    foot.position.set(0, -gap / 2, 0.05); add(ankle, foot);
    // (in heels the ankle points the foot down; the mannequin's block of a foot stays flat on the floor, its
    // height the heel's, so it stands in for the shoe)
    if (LG?.pitch) { const holder = new THREE.Group(); holder.rotation.x = -LG.pitch; ankle.add(holder); holder.add(foot); }
    legs.push({ hip, knee, ankle });
  }
  // the dress or jacket over the hips and the torso; the spine above
  if (W) add(pelvis, new THREE.Mesh(lathe([[0, -0.4], [0.14, -0.41], [0.17, -0.2], [0.175, -0.02], [0.13, 0.08], [0, 0.08]], 0.72), mDress));
  else add(pelvis, new THREE.Mesh(lathe([[0, -0.5], [0.24, -0.52], [0.21, -0.2], [0.19, 0.05], [0, 0.05]], 0.7), mDark));
  const spine = new THREE.Group(); spine.position.y = W ? 0.06 : 0.04; pelvis.add(spine);
  const torsoTop = W ? 0.44 : 0.52;
  add(spine, new THREE.Mesh(lathe(W
    ? [[0, 0], [0.12, 0], [0.11, 0.1], [0.15, 0.26], [0.16, 0.36], [0.13, torsoTop], [0, torsoTop]]
    : [[0, 0], [0.19, 0], [0.19, 0.2], [0.21, 0.4], [0.18, torsoTop], [0, torsoTop]], 0.62), W ? mDress : mDark));
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.052, 0.12, 10), W ? mSkin : mDark); neck.position.y = torsoTop + 0.04; add(spine, neck);
  const head = new THREE.Group(); head.position.y = torsoTop + 0.16; spine.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), mSkin); skull.scale.set(0.085, 0.112, 0.1); skull.position.set(0, 0.03, 0.01); add(head, skull);
  const hairCap = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.62), mHair);
  hairCap.scale.set(0.092, 0.12, 0.108); hairCap.position.set(0, 0.035, -0.005); hairCap.rotation.x = -0.35; add(head, hairCap);
  if (W) { const bun = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), mHair); bun.position.set(0, 0.07, -0.1); add(head, bun); }
  // the arms: shoulders, elbows, hands
  const arms = [];
  for (const sx of [-1, 1]) {
    const sh = new THREE.Group(); sh.position.set(sx * (W ? 0.17 : 0.23), torsoTop - 0.05, 0); sh.rotation.z = sx * 0.06; spine.add(sh);
    const ra = W ? 0.042 : 0.058, rf = W ? 0.034 : 0.048, mA = W ? mDress : mDark;
    // a round shoulder and elbow over each joint, so the arm reads as one limb when it bends
    const cap = new THREE.Mesh(new THREE.SphereGeometry(ra * 1.25, 12, 8), mA); cap.scale.set(1, 0.9, 0.9); add(sh, cap);
    add(sh, capsule(ra, 0.22, mA));
    const el = new THREE.Group(); el.position.y = W ? -0.29 : -0.31; sh.add(el);
    add(el, new THREE.Mesh(new THREE.SphereGeometry(rf * 1.1, 10, 8), mA));
    add(el, capsule(rf, 0.2, mA));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8), mSkin); hand.scale.set(0.03, 0.06, 0.045); hand.position.y = -0.31; add(el, hand);
    arms.push({ sh, el });
  }
  const f = { root, body, pelvis, spine, head, legs, arms, hipY, thigh, shin, gap: hipY - thigh - shin, hipX, scale: s, kind, phase: 0, pitch: LG?.pitch ?? 0, heel: LG?.heel ?? 0, clasp };
  stand(f);
  return f;
}

// poses: each sets every joint, so they can follow one another frame by frame
export function stand(f, t = 0) {
  f.pelvis.position.set(0, f.hipY, 0); f.pelvis.rotation.set(0, 0, 0);
  f.spine.rotation.set(0.02 * Math.sin(t * 0.45), 0, 0); f.head.rotation.set(0.04, 0.15 * Math.sin(t * 0.13), 0);
  for (const [i, L] of f.legs.entries()) { L.hip.rotation.set(0, 0, (i ? 1 : -1) * 0.015); L.knee.rotation.set(0, 0, 0); }
  for (const [i, A] of f.arms.entries()) { A.sh.rotation.set(0.04, 0, (i ? 1 : -1) * 0.06); A.el.rotation.x = -0.18; }
  level(f);
}
// each foot flat on the ground, whatever its hip and knee do
// (in heels, pointed down by their pitch)
function level(f) { for (const L of f.legs) L.ankle.rotation.set(-(f.pelvis.rotation.x + L.hip.rotation.x + L.knee.rotation.x) + f.pitch, 0, 0); }
// the arms with the hands together in front, a little below the waist (k: how far into it, 0 to 1)
const CLASP = [[0.2, 0.72, -0.1, -1.3], [0.2, -0.72, 0.1, -1.3]]; // per arm (right, left): shoulder x, y, z; elbow
function clasp(f, k) {
  f.claspK = k;
  if (k <= 0) return;
  for (const [i, A] of f.arms.entries()) { const c = CLASP[i];
    A.sh.rotation.set(A.sh.rotation.x + (c[0] - A.sh.rotation.x) * k, A.sh.rotation.y + (c[1] - A.sh.rotation.y) * k, A.sh.rotation.z + (c[2] - A.sh.rotation.z) * k);
    A.el.rotation.x += (c[3] - A.el.rotation.x) * k; }
}
// a walk: the phase advances with the distance walked (a stride of two steps every 1.1 m: short, unhurried steps)
export function walk(f, phase) {
  const p = phase, W = f.kind === 'woman';
  f.pelvis.position.set(0, f.hipY - 0.025 + 0.02 * Math.abs(Math.cos(p)), 0); f.pelvis.rotation.set(0, 0.08 * Math.sin(p), (W ? 0.035 : 0.015) * Math.sin(p));
  f.spine.rotation.set(0.04, -0.12 * Math.sin(p), 0); f.head.rotation.set(0, 0.04 * Math.sin(p), 0);
  for (const [i, L] of f.legs.entries()) {
    const q = p + i * Math.PI;
    L.hip.rotation.set(-(W ? 0.3 : 0.36) * Math.sin(q), 0, 0);
    L.knee.rotation.set(0.75 * Math.max(0, Math.sin(q + 1.3)) + 0.05, 0, 0);
  }
  for (const [i, A] of f.arms.entries()) { const q = p + i * Math.PI; A.sh.rotation.set(0.17 * Math.sin(q), 0, (i ? 1 : -1) * 0.06); A.el.rotation.x = -0.22 - 0.14 * Math.max(0, -Math.sin(q)); }
  level(f);
}
// seated, on a seat `seat` metres up: thighs forward, shins down, leaning back, hands on the arms
export function sit(f, seat = 0.52, t = 0) {
  f.pelvis.position.set(0, seat + 0.08, -0.05); f.pelvis.rotation.set(0, 0, 0);
  f.spine.rotation.set(-0.16 + 0.015 * Math.sin(t * 0.32), 0, 0); f.head.rotation.set(0.12, 0.2 * Math.sin(t * 0.08), 0);
  for (const [i, L] of f.legs.entries()) { L.hip.rotation.set(-Math.PI / 2 + 0.08, (i ? 1 : -1) * 0.08, 0); L.knee.rotation.set(Math.PI / 2 - 0.05, 0, 0); }
  for (const A of f.arms) { A.sh.rotation.x = -0.35; A.el.rotation.x = -0.95; }
  level(f);
}

// a leg reaching for an ankle target, in the body's own frame (metres before its scale): two-bone IK in the leg's
// plane, the knee bending forward, the foot kept level
function reach(f, L, dz, dy) { const [h, k] = solve(f, dz, dy); L.hip.rotation.set(h, 0, 0); L.knee.rotation.set(k, 0, 0); }
// the hip and knee angles that put the ankle at (dz forward, dy up) of the hip
function solve(f, dz, dy) {
  // (the reach saturates smoothly short of a locked knee, so a leg straightens gradually, never with a snap)
  const a = f.thigh, b = f.shin, len = a + b, e = 0.0025 * len, r = Math.max(0.05, Math.hypot(dz, dy)), x = (len - r) / e;
  const d = len - e * (x > 30 ? x : Math.log1p(Math.exp(x)));
  const phi = Math.atan2(dz, -dy); // forward of straight down
  const alpha = Math.acos(Math.min(1, (a * a + d * d - b * b) / (2 * a * d)));
  const knee = Math.PI - Math.acos(Math.min(1, Math.max(-1, (a * a + b * b - d * d) / (2 * a * b))));
  return [-(phi + alpha), knee];
}

/*
 * Walks f back and forth along `path` ([x, z] points), its feet planted on the floor whose height h(x, z) gives:
 * every footfall is placed in advance along the path, one on each tread of a stair (wherever the floor is level for
 * less than a stride) and evenly at `step` metres on longer level runs, the feet taking them in turn. Each foot
 * swings from its last footfall to its next and stays put on the floor otherwise; the legs reach for them (IK).
 *   On the level it is an upright walk carried by the hips: each foot lands about half a step ahead of the body and
 *   leaves as far behind it (60% of the time on the ground, so the thighs swing about 18 degrees either side of
 *   upright), the standing leg all but straight, the foot lifting 2 cm.
 *   On a stair the foot lands nearly under the body and the knees lift it over the riser.
 * Everything that changes between the two eases with the distance to the stairs, never by a switch: the gait, the
 * pace (`stairs` times `speed` there, up and down), the hips. The hips ride as high as the feet on the floor let
 * them, a lifting foot letting go of them smoothly; the upper body follows its pose through a short low-pass, so
 * the start and end of a walk don't jump. It stands `rest` s at each end, turning slowly. Returns update(t).
 */
export function walker(f, path, h = () => 0, { speed = 0.6, rest = 7, start = 0, step = 0.38, stairs = 0.38 } = {}) {
  const P = path.map(([x, z]) => new THREE.Vector2(x, z)), seg = [];
  let total = 0; for (let i = 1; i < P.length; i++) { const d = P[i].distanceTo(P[i - 1]); seg.push(d); total += d; }
  const at = (s) => { // the point and heading `s` metres along the path
    s = Math.min(total - 1e-4, Math.max(1e-4, s));
    let i = 0; while (i < seg.length - 1 && s > seg[i]) { s -= seg[i]; i++; }
    const a = P[i], b = P[i + 1], k = Math.min(1, Math.max(0, s / seg[i]));
    return { p: a.clone().lerp(b, k), dir: b.clone().sub(a).normalize() };
  };
  const hAt = (s) => { const { p } = at(s); return h(p.x, p.y); };
  const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  // the level runs of the floor along the path, and the footfalls on them
  const DS = 0.01, runs = [];
  let r0 = 0, y0 = hAt(0);
  for (let i = 1; i * DS < total; i++) {
    const s = i * DS, y = hAt(s);
    if (Math.abs(y - y0) > 0.01) { runs.push({ a: r0, b: s, y: y0 }); r0 = s; y0 = y; }
  }
  runs.push({ a: r0, b: total, y: y0 });
  const tread = (R) => R.b - R.a < step * 1.7;
  const plants = [];
  for (const [k, R] of runs.entries()) {
    const len = R.b - R.a, mA = k ? 0.2 : 0, mB = k < runs.length - 1 ? 0.2 : 0;
    if (tread(R)) plants.push((R.a + R.b) / 2); // a tread: one foot on the middle of it
    else { const n = Math.max(1, Math.round((len - mA - mB) / step)); for (let i = 0; i <= n; i++) plants.push(R.a + mA + (len - mA - mB) * i / n); }
  }
  if (plants[0] > 0.05) plants.unshift(0);
  if (plants[plants.length - 1] < total - 0.05) plants.push(total); // the walk ends with the feet under the body
  // how much of a stair it is here: 1 on the treads, easing to 0 over 0.7 m either side
  const stairRuns = runs.filter(tread);
  const stairy = (s) => { let k = 0; for (const R of stairRuns) { const d = s < R.a ? R.a - s : s > R.b ? s - R.b : 0; k = Math.max(k, 1 - sstep(0, 0.7, d)); } return k; };
  // time along the path, slower where it steps, as a table to read s from t
  // (and slower over the first and last half metre, as a walk starts and comes to a stop: the first step from
  // standing and the last one closing up take their time)
  const ramp = (s) => (0.35 + 0.65 * sstep(0, 0.55, s)) * (0.35 + 0.65 * sstep(0, 0.55, total - s));
  const T = [0]; for (let i = 1; i * DS <= total; i++) { const s = (i - 0.5) * DS; T.push(T[i - 1] + DS / (speed * ramp(s) * (1 - (1 - stairs) * stairy(s)))); }
  const leg = T[T.length - 1], cycle = 2 * (leg + rest);
  const sOf = (t) => { let lo = 0, hi = T.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m; else hi = m; } return Math.min(total, (lo + (t - T[lo]) / Math.max(1e-9, T[hi] - T[lo])) * DS); };
  // the footfalls each way, as distances travelled from where that leg starts, each with its gait: `a`, how far
  // (in steps) ahead of the body the foot lands, and `c`, how far into the other foot's step it lifts
  const gaitOf = (F, sAt) => F.map((q) => { const k = stairy(sAt(q)); return { a: 0.58 + (0.18 - 0.58) * k, c: 0.24 + (0.12 - 0.24) * k }; });
  const fwd = plants, bwd = plants.map((p) => total - p).reverse();
  const gF = gaitOf(fwd, (q) => q), gB = gaitOf(bwd, (q) => total - q);
  // where a footfall's foot centre goes, in the walking direction's own distance: on a tread it steps down onto,
  // a little forward of its middle, so the heel clears the nosing behind it sooner
  const centre = (q, dir) => { const s0 = dir > 0 ? q : total - q; return hAt(s0 - dir * 0.25) > hAt(s0) + 0.02 ? q + 0.12 * f.scale : q; };
  const ground = (q, side, dir) => { // a footfall's ankle target in the world: on the floor, beside the path
    // (the footfall is where the foot's middle goes; the ankle is a little behind it, the way it walks)
    q = centre(q, dir);
    const s0 = dir > 0 ? q : total - q, { dir: d } = at(s0), { p } = at(s0 - dir * 0.05 * f.scale), lat = f.hipX * f.scale * side * (dir > 0 ? 1 : -1);
    const m = at(s0).p; // the floor's height under the foot's middle
    return new THREE.Vector3(p.x + d.y * lat, h(m.x, m.y) + f.gap * f.scale, p.y - d.x * lat);
  };
  // A swing over a stair, as how far up or down it is (0 to 1) at each moment w of the swing, a stage for each tread
  // edge it passes. Going up, the foot lifts first and goes forward after (its way across from 20% of the swing on),
  // reaching each tread's height before its toe comes over that tread's riser. Going down, it goes out early (its
  // way across done by 70%) and comes down over the rest, never below a tread until its heel is past that tread's
  // edge, so it lowers onto the tread steadily. Cached per swing.
  const swings = new Map(), TOE = 0.11, HEEL = 0.11;
  const across = (up, w) => up > 0 ? sstep(0.2, 1, w) : up < 0 ? sstep(0, 0.7, w) : sstep(0, 1, w);
  const wAt = (up, e) => { let lo = 0, hi = 1; for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (across(up, m) < e) lo = m; else hi = m; } return lo; };
  const swing = (F, a, b, dirn) => {
    const key = dirn + ':' + a;
    if (!swings.has(key)) {
      const S = (q) => dirn > 0 ? q : total - q, qa = F[Math.max(0, a)], qb = F[Math.min(F.length - 1, b)];
      const ca = centre(qa, dirn), cb = centre(qb, dirn), y0 = hAt(S(qa)), y1 = hAt(S(qb)), up = Math.sign(y1 - y0) * (Math.abs(y1 - y0) > 0.02 ? 1 : 0);
      const marks = []; let yPrev = y0;
      for (let q = qa; q < qb; q += 0.005) {
        const y = hAt(S(q)); if (Math.abs(y - yPrev) < 0.01) continue;
        // where the foot's centre is as its toe reaches a riser up, or its heel passes an edge down
        const c = y > yPrev ? q - TOE * f.scale - 0.02 : q + HEEL * f.scale;
        marks.push({ w: wAt(up, Math.min(0.97, Math.max(0, (c - ca) / Math.max(1e-6, cb - ca)))), d: Math.abs(y - yPrev) / Math.max(1e-6, Math.abs(y1 - y0)) });
        yPrev = y;
      }
      // up: stage k rises from the last mark (or the start) to its own; down: it falls from its mark to the next (or the end)
      const st = marks.map((m, k) => up > 0 ? { d: m.d, w0: k ? marks[k - 1].w : 0, w1: Math.max(m.w, (k ? marks[k - 1].w : 0) + 0.05) } : { d: m.d, w0: m.w, w1: k + 1 < marks.length ? marks[k + 1].w : 1 });
      swings.set(key, { up, g: (w) => { let g = 0; for (const s of st) g += s.d * sstep(s.w0, s.w1, w); return Math.min(1, g); } });
    }
    return swings.get(key);
  };
  const smoothGround = (s) => { let y = 0; for (let k = -3; k <= 3; k++) y += hAt(s + k * 0.1); return y / 7; };
  let yaw = null, hy = null, last = null, upper = null;
  const A = [new THREE.Vector3(), new THREE.Vector3()], tmp = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0);
  // the upper body's joints, low-passed toward the pose of the moment
  const joints = [f.pelvis, f.spine, f.head, ...f.arms.flatMap((A) => [A.sh, A.el])];
  const smoothUpper = (k) => {
    const now = joints.map((j) => [j.position.x, j.rotation.x, j.rotation.y, j.rotation.z]);
    if (upper && k < 1) for (const [i, j] of joints.entries()) {
      const o = upper[i], v = now[i];
      for (let c = 0; c < 4; c++) v[c] = o[c] + (v[c] - o[c]) * k;
      j.position.x = v[0]; j.rotation.set(v[1], v[2], v[3]);
    }
    upper = now;
  };
  const update = (t) => {
    if (last !== null && (t < last || t - last > 2)) { yaw = hy = upper = null; } // a jump in time: start afresh
    const dt = last === null ? 1 : Math.min(0.5, Math.max(0, t - last)); last = t;
    const ease = (rate) => 1 - Math.exp(-dt * rate);
    const u = ((t + start) % cycle + cycle) % cycle;
    let s, moving, back;
    if (u < leg) { s = sOf(u); moving = true; back = false; }
    else if (u < leg + rest) { s = total; moving = false; back = false; }
    else if (u < 2 * leg + rest) { s = total - sOf(u - leg - rest); moving = true; back = true; }
    else { s = 0; moving = false; back = true; }
    const { p, dir } = at(s);
    const ahead = back ? dir.clone().negate() : dir.clone();
    const facing = moving ? ahead : (u - (back ? 2 * leg + rest : leg)) > rest * 0.6 ? ahead.clone().negate() : ahead;
    const want = Math.atan2(facing.x, facing.y);
    yaw = yaw === null ? want : yaw + Math.atan2(Math.sin(want - yaw), Math.cos(want - yaw)) * ease(1.1); // a slow, deliberate turn
    f.root.position.x = p.x; f.root.position.z = p.y; f.root.rotation.y = yaw;
    const sc = f.scale, hipH = f.hipY * sc, kS = stairy(s), full = (f.thigh + f.shin) * sc;
    const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
    const rel = (P) => { const dx = P.x - p.x, dz = P.z - p.y; return [(-sy * dx + cy * dz) / sc, (P.y - hy) / sc]; };
    const legsTo = (fk) => { for (const side of [0, 1]) {
      if (fk && fk[side]) {
        // a level swing (62 to 100% of the gait cycle), after the phases of walking: from toe-off the hip flexes,
        // 10 degrees by the end of initial swing and 20 by mid-swing, easing back a little to land; the knee goes on
        // bending from toe-off to its peak in initial swing and straightens through mid and terminal swing to land
        // all but straight; each from the leg's own angles where it lifted to its angles where it lands, so the foot
        // leaves and lands exactly on its footfalls
        const { from, to, w, kp } = fk[side], a = solve(f, ...rel(from)), b = solve(f, ...rel(to));
        const hw = sstep(0, 0.7, w) * 1.04 - 0.04 * sstep(0.7, 1, w);
        const kpk = Math.max(a[1], kp), kn = w < 0.38 ? a[1] + (kpk - a[1]) * sstep(0, 0.38, w) : kpk + (b[1] - kpk) * sstep(0.38, 0.98, w);
        f.legs[side].hip.rotation.set(a[0] + (b[0] - a[0]) * hw, 0, 0);
        f.legs[side].knee.rotation.set(kn, 0, 0);
        continue;
      }
      reach(f, f.legs[side], ...rel(A[side]));
    } level(f); };
    if (!moving) {
      stand(f, t); if (f.clasp) clasp(f, sstep(0.15, 0.85, kS)); smoothUpper(ease(4));
      const target = hAt(s) + f.gap * sc + full * 0.996; hy = hy === null ? target : hy + (target - hy) * ease(2.5);
      f.root.position.y = hy - hipH;
      // both feet under the hips, turning with her as she turns round (a pivot on the spot): the knees take up any
      // difference in height
      for (const side of [0, 1]) {
        const off = new THREE.Vector3(f.hipX * sc * (side ? 1 : -1), 0, -0.05 * sc).applyAxisAngle(Y, yaw);
        A[side].set(p.x + off.x, hAt(s) + f.gap * sc, p.y + off.z);
      }
      legsTo(); return;
    }
    // where each foot is: the footfalls in the order this way takes them, the feet taking them in turn
    const dirn = back ? -1 : 1, q = back ? total - s : s, F = back ? bwd : fwd, G = back ? gB : gF, N = F.length - 1;
    const land = (k) => { k = Math.min(N, Math.max(0, k)); return k ? F[k] - G[k].a * (F[k] - F[k - 1]) : F[0]; }; // the body's q as footfall k lands
    let n = 0; while (n < N && land(n + 1) <= q) n++; // the last footfall landed
    const lift = (0.012 + 0.048 * kS) * sc, W = [0, 0], TO = [null, null], UP = [0, 0], FROM = [null, null], PH = [0.2, 0.2], RL = [0, 0];
    for (const side of [0, 1]) { // footfalls of index parity `side` belong to that foot
      // both feet start together at the first footfall; the trailing one closes up beside the last at the end
      const lastF = n % 2 === side ? n : n - 1, next = lastF + 2, end = next > N;
      const from = ground(F[Math.max(0, lastF)], side ? 1 : -1, dirn), to = ground(F[end ? N : next], side ? 1 : -1, dirn);
      if (end && lastF === N) { A[side].copy(from); continue; }
      // it swings from a little way into the other foot's step (c) to its own landing
      const q0 = end ? land(N) : land(next - 1), q1 = end ? total : land(next), c = G[end ? N : next].c;
      const w = Math.min(1, Math.max(0, ((q - q0) / Math.max(1e-6, q1 - q0) - c) / (1 - c)));
      W[side] = w; TO[side] = to; FROM[side] = from.clone(); UP[side] = swing(F, lastF, next, dirn).up;
      // where it is in its gait cycle: 0 as it lands, 50% as the other foot lands, 62% as it lifts, then the swing
      // (the first foot to move starts as if the other had just landed, at the walk's start; the last to close up
      // ends its cycle where the walk ends)
      {
        const l1 = lastF >= 0 ? land(lastF + 1) : 0, l0 = lastF >= 0 ? land(lastF) : -land(1), l2 = end ? total : land(lastF + 2), c2 = 0.5 + 0.5 * c;
        PH[side] = w > 0 ? c2 + (1 - c2) * w : q < l1 ? 0.5 * (q - l0) / Math.max(1e-6, l1 - l0) : 0.5 + 0.5 * (q - l1) / Math.max(1e-6, l2 - l1);
        RL[side] = lastF >= 0 ? 1 : 0; // it rolled off its toes as it lifted (the first step from standing doesn't)
      }
      if (w <= 0) { A[side].copy(from); continue; }
      const up = to.y - from.y, sw = swing(F, lastF, next, dirn), e = across(sw.up, w);
      A[side].lerpVectors(from, to, e);
      // up a step: the foot rises early and comes in over the nosing; down one: it goes out level and comes down a
      // tread at a time as its heel passes each nosing, slowing as it lands
      const rise = sw.up ? sw.g(w) : 0;
      A[side].y = from.y + up * rise + lift * Math.sin(Math.PI * w);
    }
    // a standing foot left behind the body rolls onto its toes: its heel, and the ankle, rise (up to 5 cm), so it
    // doesn't pull the hips down as the stride opens, and the foot pitches about its toes to keep them on the floor
    // On the level the roll follows the gait cycle: the heel leaves the floor in terminal stance (from 38%) and the
    // foot pitches about the ball to 20 degrees by toe-off (62%), its ankle rising with it; in the swing it comes back
    // level by mid-swing. (In heels the foot is pointed already, so it rolls less.)
    const toe = [0, 0], LB = 0.12 * sc * Math.cos(f.pitch), POFF = 0.45 * (1 - 0.45 * Math.min(1, f.pitch / 0.6));
    const rollAt = (ph) => POFF * sstep(0.38, 0.62, ph);
    for (const side of [0, 1]) {
      const dx = A[side].x - p.x, dz = A[side].z - p.y, behind = -(-sy * dx + cy * dz);
      // (on a stair, by how far behind the body the foot is; the roll eases out as the foot leaves the floor)
      const rS = 0.05 * 0.6 * sc * sstep(0.04 * sc, 0.26 * sc, behind) * (1 - sstep(0, 0.35, W[side])), pS = Math.asin(Math.min(0.9, rS / (0.15 * sc)));
      const pL = RL[side] * (W[side] > 0 ? rollAt(0.62) * (1 - sstep(0, 0.45, W[side])) : rollAt(PH[side]));
      const pr = pL + (pS - pL) * kS;
      toe[side] = pr; A[side].y += (W[side] > 0 && UP[side] === 0 ? 0 : LB * Math.sin(pr));
      if (FROM[side]) { const r0 = RL[side] * rollAt(0.62); FROM[side].y += LB * Math.sin(r0 + (pS - r0) * kS); }
    }
    // the hips: as high as the floor would carry them, no higher than each foot on the floor reaches; a lifting
    // foot, or one far behind (rolling off its toes), lets go of them smoothly
    const Lr = full * (0.9985 - 0.0145 * kS);
    // (going down, the floor a stride ahead lowers them already, so the swinging leg reaches the tread below with
    // its knee still easing straight, rather than snapping straight just before it lands)
    let target = Math.min(smoothGround(s), smoothGround(s + (back ? -0.2 : 0.2))) + f.gap * sc + full * (0.997 - 0.012 * kS);
    for (const side of [0, 1]) {
      const H = tmp.set(p.x, 0, p.y).add(new THREE.Vector3(f.hipX * sc * (side ? 1 : -1), 0, 0).applyAxisAngle(Y, yaw));
      const dh = Math.min(Lr, Math.hypot(A[side].x - H.x, A[side].z - H.z));
      // (a foot swinging down to a lower tread holds them from halfway, so the body lowers on the standing knee as
      // the swinging leg reaches down, and that leg straightens over the swing, not as it lands)
      const down = UP[side] < 0, w = W[side];
      const upward = UP[side] > 0;
      // (one leaving a lower tread holds them until it has risen well clear, so the hips climb with it and the knee
      // flexes as the foot rises, not all at once)
      const free = down ? sstep(0, 0.3, w) * (1 - sstep(0.3, 0.65, w)) : upward ? 0 : sstep(0, 0.35, w) * (1 - sstep(0.7, 1, w));
      const slack = 0.5 * sc * (free + sstep(0.62, 0.85, dh / Lr));
      target = Math.min(target, A[side].y + Math.sqrt(Lr * Lr - dh * dh) + slack);
      // a foot swinging up to a higher tread keeps its knee bent through the swing (its leg a little shorter than
      // straight, most at mid-swing), so the hips rise with the foot and the knee flexes and extends once, smoothly
      if (upward && w > 0) { const Ls = Lr * (1 - 0.14 * Math.sin(Math.PI * w)), dd = Math.min(Ls, dh); target = Math.min(target, A[side].y + Math.sqrt(Ls * Ls - dd * dd)); }
      // and a swinging foot's landing draws them down to where it will reach, as it comes (down a stair, the
      // standing knee lowers the body while the swinging leg reaches for the tread below)
      if (TO[side] && W[side] > 0) {
        const dl = Math.min(Lr, Math.hypot(TO[side].x - H.x, TO[side].z - H.z));
        target = Math.min(target, TO[side].y + Math.sqrt(Lr * Lr - dl * dl) + 0.6 * sc * (1 - sstep(0.15, 1, W[side])));
      }
    }
    // on the level: as high as the standing legs let the hips ride with each knee at its stance angle, about 12
    // degrees through loading response (to 12% of the cycle) and all but straight from mid-stance on; a heel that
    // has left the floor (past 45%) holds them only from rising past its straight reach
    let tL = smoothGround(s) + f.gap * sc + full * 0.999;
    for (const side of [0, 1]) {
      if (W[side] > 0 && W[side] < 1 || PH[side] > 0.5 && RL[side]) continue; // (in pre-swing the heel is up: that foot is on its toes)
      const H = tmp.set(p.x, 0, p.y).add(new THREE.Vector3(f.hipX * sc * (side ? 1 : -1), 0, 0).applyAxisAngle(Y, yaw));
      const ph = PH[side], kc = ph < 0.45 ? 0.035 + 0.17 * sstep(0, 0.12, ph) * (1 - sstep(0.12, 0.31, ph)) : 0.02;
      const a = f.thigh * sc, b = f.shin * sc, L = Math.sqrt(a * a + b * b + 2 * a * b * Math.cos(kc)), dh = Math.min(L * 0.999, Math.hypot(A[side].x - H.x, A[side].z - H.z));
      tL = Math.min(tL, A[side].y + Math.sqrt(L * L - dh * dh));
    }
    target = tL + (target - tL) * sstep(0, 0.5, kS);
    hy = hy === null ? target : hy + (target - hy) * ease(14);
    f.root.position.y = hy - hipH;
    // the upper body from the walk cycle, its phase from the footfalls; then the legs reach their feet
    const ph = Math.PI * (n + Math.min(1, Math.max(0, (q - land(n)) / Math.max(1e-6, land(n + 1) - land(n)))));
    walk(f, ph);
    // the hips: on the level a fuller turn and roll with each step and a little sway over the standing foot
    const hk = 1.1 - 0.7 * kS;
    f.pelvis.position.set((f.kind === 'woman' ? 0.02 : 0.012) * (1 - kS) * Math.sin(ph), f.hipY, 0);
    f.pelvis.rotation.set(0, f.pelvis.rotation.y * hk, f.pelvis.rotation.z * (1.4 - kS));
    if (f.clasp) clasp(f, sstep(0.15, 0.85, kS));
    smoothUpper(ease(10));
    // (the knee's peak in the swing: 40 degrees on the level, a slow walk's in heels, less near a stair)
    legsTo([0, 1].map((side) => W[side] > 0 && W[side] < 1 && UP[side] === 0 ? { from: FROM[side], to: TO[side], w: W[side], kp: 0.7 * (1 - kS) } : null));
    for (const side of [0, 1]) f.legs[side].ankle.rotation.x += toe[side];
  };
  update(0);
  return update;
}


/*
 * The MakeHuman Luv (assets/luv.glb, built by tools/makehuman_luv.py from MakeHuman's CC0 body, rig and weights and
 * the community's clothes, hair and skins): dressMakehuman(f, gltf, look) puts a copy of the model on figure f, hides
 * the mannequin's meshes, and returns pose(), which turns the model's bones to follow the mannequin's joints, so
 * the walker, its footfalls and its IK drive the model unchanged. The model's bones have no rotation at rest, so
 * each bone's world rotation is the mannequin joint's turn from its own rest, after a fixed turn that takes the
 * bone's rest direction onto the mannequin segment's (the model stands in an A pose; the mannequin's arms hang).
 * look: { outfit: 'tunic' | 'coat', hair: 'bun' | 'long' | 'braid', skin: 'caucasian' | 'eurasian' }.
 */
export function dressMakehuman(f, gltf, look) {
  const model = cloneSkinned(gltf.scene), meta = gltf.scene.getObjectByName('Luv')?.userData ?? gltf.scene.children[0].userData;
  const bones = {}; model.traverse((o) => { if (o.isBone) bones[o.name] = o; if (o.isSkinnedMesh) { o.castShadow = o.receiveShadow = true; o.frustumCulled = false; } });
  f.root.add(model);
  const parts = []; model.traverse((o) => { if (o.isMesh) parts.push(o); });
  const skinTex = {};
  const setLook = (L) => {
    for (const o of parts) {
      const x = o.userData ?? {};
      o.visible = x.role === 'body' ? x.outfit === L.outfit : x.role === 'outfit' ? x.outfit === L.outfit : x.role === 'hair' ? x.hair === L.hair : true;
      if (x.role === 'body' && L.skin && gltf.parser && meta.skins?.[L.skin] !== undefined) {
        const k = L.skin; if (!skinTex[k]) skinTex[k] = gltf.parser.getDependency('texture', meta.skins[k]).then((t) => { t.flipY = false; t.colorSpace = THREE.SRGBColorSpace; return t; });
        skinTex[k].then((t) => { if (o.material.map !== t) { o.material = o.material.clone(); o.material.map = t; o.material.needsUpdate = true; } });
      }
    }
  };
  setLook(look);
  // the mannequin's joints at rest (every joint's own turn taken off but the shoulders' fixed outward tilt), in
  // the figure's own frame
  const J = { pelvis: f.pelvis, spine: f.spine, head: f.head, hipL: f.legs[1].hip, kneeL: f.legs[1].knee, ankleL: f.legs[1].ankle, hipR: f.legs[0].hip, kneeR: f.legs[0].knee, ankleR: f.legs[0].ankle,
    shL: f.arms[1].sh, elL: f.arms[1].el, shR: f.arms[0].sh, elR: f.arms[0].el };
  // (the mannequin's left, +x, is the model's left: both face +z)
  const MAP = { pelvis: 'pelvis', spine_01: 'spine', spine_02: 'spine', spine_03: 'spine', neck_01: 'head', head: 'head', clavicle_l: 'spine', clavicle_r: 'spine',
    thigh_l: 'hipL', calf_l: 'kneeL', foot_l: 'ankleL', ball_l: 'ankleL', thigh_r: 'hipR', calf_r: 'kneeR', foot_r: 'ankleR', ball_r: 'ankleR',
    upperarm_l: 'shL', lowerarm_l: 'elL', hand_l: 'elL', upperarm_r: 'shR', lowerarm_r: 'elR', hand_r: 'elR' };
  const CHILD = { hipL: 'kneeL', kneeL: 'ankleL', hipR: 'kneeR', kneeR: 'ankleR', shL: 'elL', shR: 'elR' }; // segments whose direction the bone takes
  const saved = Object.fromEntries(Object.entries(J).map(([k, j]) => [k, j.quaternion.clone()]));
  for (const [k, j] of Object.entries(J)) { j.rotation.set(0, 0, k.startsWith('sh') ? (k === 'shL' ? 0.06 : -0.06) : 0); }
  f.root.updateMatrixWorld(true);
  const toFig = new THREE.Matrix4().copy(f.root.matrixWorld).invert(), m4 = new THREE.Matrix4();
  const figQuat = (o, q) => { m4.multiplyMatrices(toFig, o.matrixWorld); return q.setFromRotationMatrix(m4.extractRotation(m4)); };
  const figPos = (o, v) => v.setFromMatrixPosition(m4.multiplyMatrices(toFig, o.matrixWorld));
  const rest = {}, restPos = {};
  for (const [k, j] of Object.entries(J)) { rest[k] = figQuat(j, new THREE.Quaternion()).invert(); restPos[k] = figPos(j, new THREE.Vector3()); }
  const elbowHand = (k) => restPos[k].clone().add(new THREE.Vector3(0, -0.31 * f.scale, 0).applyQuaternion(rest[k].clone().invert()));
  const C = {};
  for (const [b, k] of Object.entries(MAP)) {
    const bh = meta.bones[b]; if (!bh) continue;
    const kid = CHILD[k], want = kid ? restPos[kid].clone().sub(restPos[k]) : k.startsWith('el') ? elbowHand(k).sub(restPos[k]) : null;
    C[b] = want && (b.startsWith('thigh') || b.startsWith('calf') || b.startsWith('upperarm') || b.startsWith('lowerarm'))
      ? new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3().fromArray(bh.tail).sub(new THREE.Vector3().fromArray(bh.head)).normalize(), want.normalize())
      : new THREE.Quaternion();
  }
  for (const [k, j] of Object.entries(J)) j.quaternion.copy(saved[k]);
  // the model's hips: where its pelvis bone sits from the middle of its hip joints
  const hv = (n) => new THREE.Vector3().fromArray(meta.bones[n].head);
  const pelvisOff = hv('pelvis').sub(hv('thigh_l').add(hv('thigh_r')).multiplyScalar(0.5));
  const order = []; model.traverse((o) => { if (o.isBone) order.push(o); }); // parents first
  const W = new Map(), D = {}, q = new THREE.Quaternion(), qp = new THREE.Quaternion(), v = new THREE.Vector3();
  for (const o of f.body.children) if (o.isMesh) o.visible = false;
  f.body.traverse((o) => { if (o.isMesh) o.visible = false; });
  const pose = () => {
    f.root.updateMatrixWorld(true); toFig.copy(f.root.matrixWorld).invert();
    for (const [k, j] of Object.entries(J)) D[k] = figQuat(j, D[k] ?? new THREE.Quaternion()).multiply(rest[k]);
    W.clear();
    for (const o of order) {
      const k = MAP[o.name], parentW = W.get(o.parent) ?? qp.identity();
      let wq = k ? D[k].clone().multiply(C[o.name]) : parentW.clone();
      // hands together: as the arms come in, each hand turns its fingers down and in, over the other
      if (f.claspK > 0 && (o.name === 'hand_l' || o.name === 'hand_r')) {
        const bh = meta.bones[o.name], rd = new THREE.Vector3().fromArray(bh.tail).sub(new THREE.Vector3().fromArray(bh.head)).normalize();
        const sgn = o.name === 'hand_l' ? 1 : -1, want = new THREE.Vector3(-sgn * 0.6, -1, 0.25).normalize();
        wq = wq.clone().slerp(new THREE.Quaternion().setFromUnitVectors(rd, want), f.claspK);
      }
      W.set(o, wq);
      o.quaternion.copy(parentW.clone().invert().multiply(wq));
    }
    // the pelvis bone at the mannequin's hips, turned with them
    const P = bones.pelvis; if (P) {
      figPos(f.pelvis, v).add(pelvisOff.clone().applyQuaternion(D.pelvis));
      P.position.copy(v).sub(new THREE.Vector3().fromArray(meta.bones[P.parent?.name]?.head ?? [0, 0, 0]));
    }
  };
  pose();
  const undress = () => { f.root.remove(model); f.body.traverse((o) => { if (o.isMesh) o.visible = true; }); };
  return { model, pose, setLook, undress, meta };
}

// a copy of a skinned scene with its own skeleton (SkeletonUtils.clone, inlined)
function cloneSkinned(src) {
  const map = new Map(), clone = src.clone(true);
  const walk = (a, b) => { map.set(a, b); for (let i = 0; i < a.children.length; i++) walk(a.children[i], b.children[i]); };
  walk(src, clone);
  src.traverse((s) => {
    if (!s.isSkinnedMesh) return;
    const c = map.get(s), sk = s.skeleton;
    c.skeleton = sk.clone(); c.bindMatrix.copy(s.bindMatrix);
    c.skeleton.bones = sk.bones.map((b) => map.get(b));
    c.bind(c.skeleton, c.bindMatrix);
  });
  return clone;
}

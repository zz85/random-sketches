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
export function figure({ kind = 'woman', dress = 0xc8b898, skin = 0x5a4232, hair = 0x0c0907, height = 1.72 } = {}) {
  const W = kind === 'woman', s = height / (W ? 1.72 : 1.85);
  const mDress = mat(dress, 0.55, W ? 0.5 : 0), mSkin = mat(skin, 0.5), mHair = mat(hair, 0.4), mDark = mat(0x0a0806, 0.5);
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body); body.scale.setScalar(s);
  const hipY = W ? 0.92 : 0.98, thigh = W ? 0.43 : 0.46, shin = W ? 0.42 : 0.46;
  const pelvis = new THREE.Group(); pelvis.position.y = hipY; body.add(pelvis);
  // the legs: hips, knees, feet
  const legs = [];
  for (const sx of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(sx * (W ? 0.075 : 0.1), 0, 0); pelvis.add(hip);
    add(hip, capsule(W ? 0.062 : 0.075, thigh - 0.08, W ? mSkin : mDark));
    const knee = new THREE.Group(); knee.position.y = -thigh; hip.add(knee);
    add(knee, capsule(W ? 0.045 : 0.06, shin - 0.08, W ? mSkin : mDark));
    add(knee, new THREE.Mesh(new THREE.SphereGeometry(W ? 0.05 : 0.066, 10, 8), W ? mSkin : mDark));
    // the ankle, and a foot from it down to the ground (the heel's height for her)
    const ankle = new THREE.Group(); ankle.position.y = -shin; knee.add(ankle);
    const gap = hipY - thigh - shin;
    const foot = new THREE.Mesh(new THREE.BoxGeometry(W ? 0.07 : 0.1, gap, W ? 0.2 : 0.27), mDark);
    foot.position.set(0, -gap / 2, 0.05); add(ankle, foot);
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
  const f = { root, body, pelvis, spine, head, legs, arms, hipY, thigh, shin, gap: hipY - thigh - shin, hipX: W ? 0.075 : 0.1, scale: s, kind, phase: 0 };
  stand(f);
  return f;
}

// poses: each sets every joint, so they can follow one another frame by frame
export function stand(f, t = 0) {
  f.pelvis.position.set(0, f.hipY, 0); f.pelvis.rotation.set(0, 0, 0);
  f.spine.rotation.set(0.02 * Math.sin(t * 0.45), 0, 0); f.head.rotation.set(0.04, 0.15 * Math.sin(t * 0.13), 0);
  for (const [i, L] of f.legs.entries()) { L.hip.rotation.set(0, 0, (i ? 1 : -1) * 0.015); L.knee.rotation.set(0, 0, 0); }
  for (const A of f.arms) { A.sh.rotation.x = 0.04; A.el.rotation.x = -0.12; }
  level(f);
}
// each foot flat on the ground, whatever its hip and knee do
function level(f) { for (const L of f.legs) L.ankle.rotation.set(-(f.pelvis.rotation.x + L.hip.rotation.x + L.knee.rotation.x), 0, 0); }
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
  for (const [i, A] of f.arms.entries()) { const q = p + i * Math.PI; A.sh.rotation.x = 0.22 * Math.sin(q); A.el.rotation.x = -0.2 - 0.12 * Math.max(0, Math.sin(q)); }
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
function reach(f, L, dz, dy) {
  const a = f.thigh, b = f.shin, d = Math.min(a + b - 1e-4, Math.max(0.05, Math.hypot(dz, dy)));
  const phi = Math.atan2(dz, -dy); // forward of straight down
  const alpha = Math.acos(Math.min(1, (a * a + d * d - b * b) / (2 * a * d)));
  const knee = Math.PI - Math.acos(Math.min(1, Math.max(-1, (a * a + b * b - d * d) / (2 * a * b))));
  L.hip.rotation.set(-(phi + alpha), 0, 0); L.knee.rotation.set(knee, 0, 0);
}

/*
 * Walks f back and forth along `path` ([x, z] points), its feet planted on the floor whose height h(x, z) gives:
 * every footfall is placed in advance along the path, one on each tread of a stair (wherever the floor is level for
 * less than a stride) and evenly at `step` metres on longer level runs, the feet taking them in turn. Each foot
 * swings from its last footfall to its next over the last part of the body's travel between two footfalls, lifting
 * over a riser, and stays put on the floor otherwise; the legs reach for them (IK), and the hips ride as high as
 * the standing leg lets them, so the body climbs and descends a step at a time. It walks at `speed` m/s on the level
 * and `stairs` times that where the floor steps, standing `rest` s at each end and turning slowly. Returns update(t).
 */
export function walker(f, path, h = () => 0, { speed = 0.65, rest = 7, start = 0, step = 0.52, stairs = 0.55 } = {}) {
  const P = path.map(([x, z]) => new THREE.Vector2(x, z)), seg = [];
  let total = 0; for (let i = 1; i < P.length; i++) { const d = P[i].distanceTo(P[i - 1]); seg.push(d); total += d; }
  const at = (s) => { // the point and heading `s` metres along the path
    s = Math.min(total - 1e-4, Math.max(1e-4, s));
    let i = 0; while (i < seg.length - 1 && s > seg[i]) { s -= seg[i]; i++; }
    const a = P[i], b = P[i + 1], k = Math.min(1, Math.max(0, s / seg[i]));
    return { p: a.clone().lerp(b, k), dir: b.clone().sub(a).normalize() };
  };
  const hAt = (s) => { const { p } = at(s); return h(p.x, p.y); };
  // the level runs of the floor along the path, and the footfalls on them
  const DS = 0.01, runs = [];
  let r0 = 0, y0 = hAt(0);
  for (let i = 1; i * DS < total; i++) {
    const s = i * DS, y = hAt(s);
    if (Math.abs(y - y0) > 0.01) { runs.push({ a: r0, b: s, y: y0 }); r0 = s; y0 = y; }
  }
  runs.push({ a: r0, b: total, y: y0 });
  const plants = [];
  for (const [k, R] of runs.entries()) {
    const len = R.b - R.a, mA = k ? 0.2 : 0, mB = k < runs.length - 1 ? 0.2 : 0;
    if (len < step * 1.7) plants.push((R.a + R.b) / 2); // a tread: one foot on the middle of it
    else { const n = Math.max(1, Math.round((len - mA - mB) / step)); for (let i = 0; i <= n; i++) plants.push(R.a + mA + (len - mA - mB) * i / n); }
  }
  if (plants[0] > 0.05) plants.unshift(0);
  const stepped = (s) => runs.some((R) => s >= R.a - 0.2 && s <= R.b + 0.2 && R.b - R.a < step * 1.7);
  // time along the path, slower where it steps, as a table to read s from t
  const T = [0]; for (let i = 1; i * DS <= total; i++) T.push(T[i - 1] + DS / (speed * (stepped(i * DS) ? stairs : 1)));
  const leg = T[T.length - 1], cycle = 2 * (leg + rest);
  const sOf = (t) => { let lo = 0, hi = T.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] < t) lo = m; else hi = m; } return Math.min(total, (lo + (t - T[lo]) / Math.max(1e-9, T[hi] - T[lo])) * DS); };
  // the footfalls each way, as distances travelled from where that leg starts
  const fwd = plants, bwd = plants.map((p) => total - p).reverse();
  const ground = (q, side, dir) => { // a footfall's ankle target in the world: on the floor, beside the path
    // (the footfall is where the foot's middle goes; the ankle is a little behind it, the way it walks)
    const s0 = dir > 0 ? q : total - q, { dir: d } = at(s0), { p } = at(s0 - dir * 0.05 * f.scale), lat = f.hipX * f.scale * side * (dir > 0 ? 1 : -1);
    const m = at(s0).p; // the floor's height under the foot's middle
    return new THREE.Vector3(p.x + d.y * lat, h(m.x, m.y) + f.gap * f.scale, p.y - d.x * lat);
  };
  const smoothGround = (s) => { let y = 0; for (let k = -3; k <= 3; k++) y += hAt(s + k * 0.1); return y / 7; };
  let yaw = null, hy = null;
  const A = [new THREE.Vector3(), new THREE.Vector3()], tmp = new THREE.Vector3();
  const update = (t) => {
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
    yaw = yaw === null ? want : yaw + Math.atan2(Math.sin(want - yaw), Math.cos(want - yaw)) * 0.035; // a slow, deliberate turn
    f.root.position.x = p.x; f.root.position.z = p.y; f.root.rotation.y = yaw;
    const sc = f.scale, hipH = f.hipY * sc;
    if (!moving) {
      stand(f, t);
      const want = hAt(s) + hipH; hy = hy === null ? want : hy + (want - hy) * 0.3;
      f.root.position.y = hy - hipH;
      // the feet on the floor under the hips while they settle: the knees take up the difference
      for (const L of f.legs) reach(f, L, 0.02, (hAt(s) + f.gap * sc - hy) / sc);
      level(f); return;
    }
    // where each foot is: the footfalls in the order this way takes them, the feet taking them in turn
    const dirn = back ? -1 : 1, q = back ? total - s : s, F = back ? bwd : fwd;
    let n = 0; while (n < F.length - 1 && F[n + 1] - 0.18 * (F[n + 1] - F[n]) <= q) n++; // the last footfall landed
    const land = (k) => F[Math.min(F.length - 1, k)] - 0.18 * (F[Math.min(F.length - 1, k)] - F[Math.max(0, k - 1)]); // the body's q as footfall k lands
    const stance = [];
    for (const side of [0, 1]) { // footfalls of index parity `side` belong to that foot
      // both feet start together at the first footfall; the trailing one closes up beside the last at the end
      const last = n % 2 === side ? n : n - 1, next = last + 2, end = next >= F.length;
      const from = ground(F[Math.max(0, last)], side ? 1 : -1, dirn), to = ground(F[end ? F.length - 1 : next], side ? 1 : -1, dirn);
      // it swings over the last 70% of the travel between the other foot's landing and its own
      const q0 = end ? land(F.length - 1) : land(next - 1), q1 = end ? total : land(next);
      if (end && last === F.length - 1) { A[side].copy(from); stance.push(side); continue; }
      const w = Math.min(1, Math.max(0, ((q - q0) / Math.max(1e-6, q1 - q0) - 0.3) / 0.7));
      if (w <= 0) { A[side].copy(from); stance.push(side); continue; }
      const e = w * w * (3 - 2 * w), up = to.y - from.y;
      A[side].lerpVectors(from, to, e);
      // up a step: the foot rises early and comes in over the nosing; down one: it goes out, then drops
      A[side].y = from.y + up * (up > 0 ? Math.min(1, w * 1.7) : Math.max(0, (w - 0.35) / 0.65) ** 1.5) + 0.06 * sc * Math.sin(Math.PI * w);
      if (w >= 1) stance.push(side);
    }
    // the hips: as high as the floor around would carry them, no higher than a standing leg reaches
    const Lr = (f.thigh + f.shin) * sc * 0.985;
    let target = smoothGround(s) + hipH * 0.985;
    const hip = (side) => tmp.set(p.x, 0, p.y).add(new THREE.Vector3(f.hipX * sc * (side ? 1 : -1), 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
    for (const side of stance.length ? stance : [0, 1]) { const H = hip(side), dh = Math.hypot(A[side].x - H.x, A[side].z - H.z); target = Math.min(target, A[side].y + Math.sqrt(Math.max(0, Lr * Lr - dh * dh))); }
    hy = hy === null ? target : hy + (target - hy) * 0.35;
    f.root.position.y = hy - hipH;
    // the upper body from the walk cycle, its phase from the footfalls; then the legs reach their feet
    const q0 = land(n), q1 = land(n + 1);
    walk(f, Math.PI * (n + Math.min(1, Math.max(0, (q - q0) / Math.max(1e-6, q1 - q0)))) * 1);
    f.pelvis.position.set(0, f.hipY, 0); f.pelvis.rotation.set(0, f.pelvis.rotation.y * 0.5, f.pelvis.rotation.z * 0.5);
    const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
    for (const side of [0, 1]) {
      // the ankle target in the body's frame, from the hip joint
      const dx = A[side].x - p.x, dz = A[side].z - p.y, lz = -sy * dx + cy * dz, dy = (A[side].y - hy) / sc;
      reach(f, f.legs[side], lz / sc, dy);
    }
    level(f);
  };
  update(0);
  return update;
}

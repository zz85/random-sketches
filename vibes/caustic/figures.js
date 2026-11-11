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
    const foot = new THREE.Mesh(new THREE.BoxGeometry(W ? 0.07 : 0.1, W ? 0.06 : 0.07, W ? 0.2 : 0.27), mDark);
    foot.position.set(0, -shin + 0.03, 0.05); add(knee, foot);
    legs.push({ hip, knee });
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
  const f = { root, body, pelvis, spine, head, legs, arms, hipY, thigh, shin, kind, phase: 0 };
  stand(f);
  return f;
}

// poses: each sets every joint, so they can follow one another frame by frame
export function stand(f, t = 0) {
  f.pelvis.position.set(0, f.hipY, 0); f.pelvis.rotation.set(0, 0, 0);
  f.spine.rotation.set(0.02 * Math.sin(t * 0.45), 0, 0); f.head.rotation.set(0.04, 0.15 * Math.sin(t * 0.13), 0);
  for (const [i, L] of f.legs.entries()) { L.hip.rotation.set(0, 0, (i ? 1 : -1) * 0.015); L.knee.rotation.set(0, 0, 0); }
  for (const A of f.arms) { A.sh.rotation.x = 0.04; A.el.rotation.x = -0.12; }
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
  for (const [i, A] of f.arms.entries()) { const q = p + i * Math.PI; A.sh.rotation.x = 0.22 * Math.sin(q); A.el.rotation.x = -0.2 - 0.12 * Math.max(0, Math.sin(q)); }
}
// seated, on a seat `seat` metres up: thighs forward, shins down, leaning back, hands on the arms
export function sit(f, seat = 0.52, t = 0) {
  f.pelvis.position.set(0, seat + 0.08, -0.05); f.pelvis.rotation.set(0, 0, 0);
  f.spine.rotation.set(-0.16 + 0.015 * Math.sin(t * 0.32), 0, 0); f.head.rotation.set(0.12, 0.2 * Math.sin(t * 0.08), 0);
  for (const [i, L] of f.legs.entries()) { L.hip.rotation.set(-Math.PI / 2 + 0.08, (i ? 1 : -1) * 0.08, 0); L.knee.rotation.set(Math.PI / 2 - 0.05, 0, 0); }
  for (const A of f.arms) { A.sh.rotation.x = -0.35; A.el.rotation.x = -0.95; }
}

/*
 * Walks f back and forth along `path` ([x, z] points) at `speed` m/s, standing `rest` s at each end, the floor's
 * height from h(x, z). Returns update(t) and the figure's root.
 */
export function walker(f, path, h = () => 0, { speed = 0.65, rest = 7, start = 0 } = {}) {
  const P = path.map(([x, z]) => new THREE.Vector2(x, z)), seg = [], STRIDE = 1.1;
  let total = 0; for (let i = 1; i < P.length; i++) { const d = P[i].distanceTo(P[i - 1]); seg.push(d); total += d; }
  const leg = total / speed, cycle = 2 * (leg + rest);
  const at = (s) => { // the point and heading `s` metres along the path
    let i = 0; while (i < seg.length - 1 && s > seg[i]) { s -= seg[i]; i++; }
    const a = P[i], b = P[i + 1], k = Math.min(1, Math.max(0, s / seg[i]));
    return { p: a.clone().lerp(b, k), dir: b.clone().sub(a).normalize() };
  };
  let yaw = null, hy = null;
  const update = (t) => {
    const u = ((t + start) % cycle + cycle) % cycle;
    let s, moving, back;
    if (u < leg) { s = u * speed; moving = true; back = false; }
    else if (u < leg + rest) { s = total; moving = false; back = false; }
    else if (u < 2 * leg + rest) { s = total - (u - leg - rest) * speed; moving = true; back = true; }
    else { s = 0; moving = false; back = true; }
    const { p, dir } = at(Math.min(total - 1e-4, Math.max(1e-4, s)));
    // face the way it walks; at a rest, turn round to face the way back after a pause
    const ahead = back ? dir.clone().negate() : dir.clone();
    const facing = moving ? ahead : (u - (back ? 2 * leg + rest : leg)) > rest * 0.6 ? ahead.clone().negate() : ahead;
    const want = Math.atan2(facing.x, facing.y);
    yaw = yaw === null ? want : yaw + Math.atan2(Math.sin(want - yaw), Math.cos(want - yaw)) * 0.035; // a slow, deliberate turn
    const y = h(p.x, p.y); hy = hy === null ? y : hy + (y - hy) * 0.25; // the floor's steps eased, as a body rises
    f.root.position.set(p.x, hy, p.y); f.root.rotation.y = yaw;
    if (moving) walk(f, (s / STRIDE) * Math.PI * 2 * (back ? -1 : 1)); else stand(f, t);
  };
  update(0);
  return update;
}

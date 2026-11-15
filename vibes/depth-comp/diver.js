// diver.js - the freediver figure, after one-breath's game/Diver.js (zz85/one-breath): a jointed
// body in a wetsuit, hood, mask and long fins, the blades chains of slices that bend behind the
// kick. There it is posed from a few numbers and kicks on its own with the speed; here each joint
// follows the dive in sim.js: a leg kicks when its button is pressed (a bad kick bends the knee
// like a bicycle kick), the arms streamline, sit by the sides, pull the rope or go to the nose,
// and the body takes the angle the physics gives it.
//
//   const fig = new DiverFigure(); scene.add(fig.group); every frame: fig.update(dt, dive)
//
// Figure frame (as in Diver.js): faces +Z, feet at the origin, about 1.75 m tall. The world's dive
// plane is x/y: the figure's +Y (feet to head) is turned to the body's angle `th`, its face to
// the side of the line, its left-right axis toward the camera.
import * as THREE from 'three';
import { DUCK, STROKE, MONO } from './sim.js';

const PIVOT = 1.0;              // the centre of mass, at the hips: the point sim.js moves
const NECK_Y = 1.50, HEAD_Y = 1.63;
const SHOULDER = { x: 0.2, y: 1.45 }, UPPER_ARM = 0.3, FOREARM = 0.27;
const HIP = { x: 0.1, y: 0.9 }, THIGH = 0.44, SHIN = 0.42, FOOT_L = 0.24;
const POINT = Math.PI / 2 - 0.45;   // the pointed foot, toes trailing the heel
const BLADE_L = 0.8, BLADE_N = 7;
// the arm's own pose on the way to the nose (equalizing) or the ear (in pain), which IK finishes
const NOSE = { a: 1.1, bend: 2.2, out: -0.5 }, EAR = { a: 0.9, bend: 2.3, out: 0.5 };

const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;
const ease = (a, b, dt, rate) => a + (b - a) * (1 - Math.exp(-dt * rate));
const smooth = (t) => t * t * (3 - 2 * t);

const mat = (color, rough = 0.6, metal = 0) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });

// a capsule from a to b, radius r
function rod(a, b, r, material) {
  const len = a.distanceTo(b);
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.001, len), 4, 10), material);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return m;
}
function blob(rx, ry, rz, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), material);
  m.scale.set(rx, ry, rz); m.position.set(x, y, z); return m;
}
function slab(w, h, d, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); m.position.set(x, y, z); return m;
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);

export class DiverFigure {
  constructor({ suit = 0x15191d, accent = 0x2fb4c8, fins = 0x2fb4c8 } = {}) {
    const S = mat(suit, 0.55), A = mat(accent, 0.45), SK = mat(0x9a6a4a, 0.6), K = mat(0x0b0d0e, 0.5), F = mat(fins, 0.3);
    F.side = THREE.DoubleSide;
    const lens = new THREE.MeshStandardMaterial({ color: 0x6f8f9c, roughness: 0.05, metalness: 0.3 });
    this.group = new THREE.Group();       // at the centre of mass; turned to the body's angle
    this.turn = new THREE.Group();        // the figure frame turned into the dive plane
    this.turn.rotation.y = -Math.PI / 2;
    this.body = new THREE.Group(); this.body.position.y = -PIVOT;
    this.group.add(this.turn); this.turn.add(this.body);

    // torso: hips, waist, chest, a stripe down each side, the weight belt
    this.body.add(blob(0.15, 0.1, 0.1, S, 0, 0.95), blob(0.13, 0.11, 0.085, S, 0, 1.12), blob(0.165, 0.16, 0.1, S, 0, 1.32));
    for (const s of [-1, 1]) this.body.add(slab(0.012, 0.5, 0.05, A, s * 0.15, 1.18, 0.01));
    const belt = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.014, 6, 20), K); belt.rotation.x = Math.PI / 2; belt.scale.set(1.08, 0.74, 1); belt.position.y = 1.0; this.body.add(belt);
    this.body.add(rod(V(0, 1.47, 0.01), V(0, 1.55, 0.01), 0.055, S));

    // head on the neck: hood, face, mask, snorkel
    this.neck = new THREE.Group(); this.neck.position.set(0, NECK_Y, 0.01); this.body.add(this.neck);
    const y = HEAD_Y - NECK_Y;
    this.neck.add(blob(0.098, 0.11, 0.102, S, 0, y), blob(0.07, 0.08, 0.05, SK, 0, y - 0.03, 0.06));
    this.neck.add(slab(0.15, 0.06, 0.035, K, 0, y + 0.03, 0.095));
    for (const s of [-1, 1]) this.neck.add(slab(0.058, 0.042, 0.006, lens, s * 0.036, y + 0.03, 0.114));
    const strap = new THREE.Mesh(new THREE.TorusGeometry(0.104, 0.008, 4, 20), A); strap.rotation.x = Math.PI / 2; strap.position.y = y + 0.03; this.neck.add(strap);
    this.neck.add(rod(V(0.1, y - 0.07, 0.05), V(0.11, y + 0.2, 0), 0.01, A));
    // a headlamp on the mask strap, and where it points: ahead of the face and toward the crown, so
    // head down with the chin tucked it lights the line below you
    this.lampMount = new THREE.Object3D(); this.lampMount.position.set(0, y + 0.075, 0.08); this.neck.add(this.lampMount);
    this.lampAim = new THREE.Object3D(); this.lampAim.position.set(0, y + 0.075 + 2.525, 3); this.neck.add(this.lampAim);
    this.lampBody = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 12), K); this.lampBody.rotation.x = Math.PI / 2;
    this.lampMount.rotation.x = -Math.atan2(2.6 - 0.075, 3 - 0.08); this.lampMount.add(this.lampBody);   // the lamp and its beam cone point at the aim
    this.lampLens = new THREE.Mesh(new THREE.CircleGeometry(0.018, 12), new THREE.MeshBasicMaterial({ color: 0xfff6d8 })); this.lampLens.position.z = 0.016; this.lampMount.add(this.lampLens);
    this.lampMount.visible = false;
    // the mouthfill: cheeks puffed
    this.cheeks = blob(0.06, 0.035, 0.04, SK, 0, y - 0.04, 0.09); this.cheeks.visible = false; this.neck.add(this.cheeks);

    // arms: shoulder -> upper arm -> elbow -> forearm and hand
    this.arms = [];
    for (const s of [-1, 1]) {
      const shoulder = new THREE.Group(); shoulder.position.set(s * SHOULDER.x, SHOULDER.y, 0);
      shoulder.add(blob(0.05, 0.05, 0.05, S, 0, -0.01), rod(V(0, -0.02, 0), V(s * 0.005, -UPPER_ARM, 0), 0.04, S));
      const elbow = new THREE.Group(); elbow.position.y = -UPPER_ARM;
      elbow.add(rod(V(0, 0, 0), V(0, -FOREARM, 0.01), 0.033, S), slab(0.07, 0.17, 0.024, SK, 0, -FOREARM - 0.085, 0.012));
      const hand = new THREE.Object3D(); hand.position.set(0, -FOREARM - 0.12, 0.012); elbow.add(hand);
      shoulder.add(elbow); this.body.add(shoulder);
      this.arms.push({ s, shoulder, elbow, hand, a: 0.05, bend: 0.1, out: 0.06 });
    }

    // legs: hip -> thigh -> knee -> shin -> ankle -> foot / fin pocket -> blade
    this.legs = [];
    for (const s of [-1, 1]) {
      const hip = new THREE.Group(); hip.position.set(s * HIP.x, HIP.y, 0);
      hip.add(blob(0.066, 0.066, 0.066, S, 0, -0.02), rod(V(0, -0.02, 0), V(0, -THIGH, 0), 0.06, S));
      const knee = new THREE.Group(); knee.position.y = -THIGH;
      knee.add(rod(V(0, 0, 0), V(0, -SHIN, -0.01), 0.045, S));
      const ankle = new THREE.Group(); ankle.position.set(0, -SHIN, -0.01);
      const foot = slab(0.08, 0.055, FOOT_L, SK, 0, -0.03, FOOT_L / 2 - 0.03);
      const pocket = slab(0.095, 0.075, FOOT_L + 0.02, K, 0, -0.03, FOOT_L / 2 - 0.02);
      const blade = new Blade(F, K); blade.root.position.set(0, -0.03, FOOT_L);
      ankle.add(foot, pocket, blade.root); knee.add(ankle); hip.add(knee); this.body.add(hip);
      // the monofin: one wide blade across both feet, carried on the right foot, centred between them
      if (s > 0) {
        this.monoBlade = new Blade(F, K, 0.66, 0.72, 0.2, 1.6);
        this.monoBlade.root.position.set(-HIP.x, -0.03, FOOT_L - 0.02);
        ankle.add(this.monoBlade.root);
      }
      this.legs.push({ s, hip, knee, ankle, foot, pocket, blade, ang: 0, kn: 0.06, prev: 0, omega: 0 });
    }
    this.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; } });
    this.neckBend = 0; this.hinge = 0; this.t = 0; this.twist = 0; this.side = 1;
  }

  update(dt, d) {
    this.t += dt;
    this.group.position.set(d.x, d.y, 0.12);
    const ph = d.phase, t = d.t, fim = d.discipline === 'FIM', mono = d.fins === 'mono';
    // pain curls you up and makes you shake; vertigo throws the arms out and rolls the head
    const pain = d.blackout ? 0 : d.pain, vert = d.blackout ? 0 : d.vertigo;
    const shake = pain * 0.05 * Math.sin(this.t * 23), earAche = pain > 0.3 && (d.dP > 0.12 || vert > 0.05);
    const limp = !!d.blackout;
    const floating = ph === 'breathe' || ph === 'surface' || (ph === 'done' && !d.blackout && d.depth < 0.5);
    const duck = ph === 'duck' ? d.duckT : null;
    let stage = -1, f = 0;
    if (duck !== null) {
      const marks = [0, DUCK.glide, DUCK.knife, DUCK.legs, DUCK.pull, DUCK.equalize, DUCK.end];
      for (let i = 1; i < marks.length; i++) if (duck < marks[i]) { stage = i - 1; f = (duck - marks[i - 1]) / (marks[i] - marks[i - 1]); break; }
      if (stage < 0) stage = 5;
    }

    // the body: centre of mass at the dive's point, turned to its angle. Turning it by th alone
    // keeps the face on one side of the body axis, which head down would look away from the line
    // after some moves, so the body also twists about its own long axis, by 0 or a half turn,
    // whichever puts the face nearer "toward the line, a little down": on the line head up or head
    // down, and face down in the duck dive's glide. It eases round, the way a diver swings round
    // the rope at the plate.
    this.group.rotation.z = d.th;
    // the side of the line you dive on: it changes only once you are well across (you pass beside
    // the rope, a little in front of it, so a small drift over x 0 isn't a change of side)
    if (d.x > 0.5) this.side = 1; else if (d.x < -0.5) this.side = -1;
    // the face untwisted points (-cos th, -sin th); the half turn points the other way
    const face = this.side * Math.cos(d.th) + 0.6 * Math.sin(d.th) >= 0 ? 0 : Math.PI;
    let to = face; while (to - this.twist > Math.PI) to -= 2 * Math.PI; while (this.twist - to > Math.PI) to += 2 * Math.PI;
    this.twist = ease(this.twist, to, dt, ph === 'dive' && d.turnT === null ? 3 : 7);
    this.turn.rotation.y = -Math.PI / 2 + this.twist;

    // the jackknife of the duck dive: legs folded toward the belly, then lifted in line
    const hingeT = stage === 1 ? Math.PI / 2 : stage === 2 ? (Math.PI / 2) * (1 - f) : 0;
    this.hinge = ease(this.hinge, hingeT, dt, 9);

    // ---- legs
    for (let i = 0; i < 2; i++) {
      const L = this.legs[i];
      let ang = 0, kn = 0.06, rate = 18;
      if (limp) { ang = 0.25; kn = 0.3; rate = 2; }
      else if (floating) { ang = 0.12 * Math.sin(this.t * 1.6 + i * Math.PI); kn = 0.25 + 0.15 * Math.sin(this.t * 1.6 + i * Math.PI + 1); rate = 4; } // treading water
      else if (duck !== null) { ang = stage === 0 ? 0.25 * Math.sin(duck * 9 + i * Math.PI) : 0; kn = 0.05; }
      else if (fim) { ang = 0.04; kn = 0.08; rate = 6; }   // legs together, trailing
      else if (mono) {
        // the dolphin kick, both legs as one: knees bent going into the downstroke and straightened
        // through it (the legs sweep toward the belly), then the upstroke lifts them past straight,
        // knees giving a little; held too long the legs stall bent
        const M = d.mono, q = M.q || 1;
        if (M.down) { const f = clamp((t - M.at) / MONO.down, 0, 1.5); ang = -0.45 * Math.min(f, 1); kn = f < 1 ? lerp(0.55, 0.04, smooth(f)) : 0.04 + 0.4 * (f - 1); rate = 16; }
        else if (t - M.upAt < MONO.up + 0.35) { const f = clamp((t - M.upAt) / MONO.up, 0, 1); ang = lerp(-0.45, 0.32 * (0.6 + 0.4 * q), smooth(f)); kn = 0.1 + 0.45 * Math.sin(Math.PI * Math.min(f, 1)); rate = 16; }
        else { ang = 0.03; kn = 0.06; rate = 5; }
      } else {
        // a kick: the power stroke toward the belly, the recovery back past straight, then trailing
        const tau = t - d.legs[i].at, q = d.legs[i].q;
        if (tau < STROKE.kick) { ang = -0.48 * (0.5 + 0.5 * q); kn = 0.06 + 0.7 * (1 - q); }
        else if (tau < STROKE.kick + 0.36) { ang = 0.3 * (0.5 + 0.5 * q); kn = 0.35 + 0.4 * (1 - q); }
        else { ang = 0.02; kn = 0.06; rate = 6; }
      }
      if (pain > 0.02 && !limp && !floating) { ang = ang * (1 - 0.5 * pain) - 0.45 * pain; kn = kn + 0.9 * pain; }
      if (vert > 0.05 && !limp) { ang += vert * 0.4 * Math.sin(this.t * 1.7 + i * 2.1); kn += vert * 0.3; }
      L.ang = ease(L.ang, ang, dt, rate); L.kn = ease(L.kn, kn, dt, rate);
      L.hip.rotation.x = L.ang - this.hinge + shake * (i ? 1 : -1);
      L.hip.rotation.z = L.s * 0.03;
      L.knee.rotation.x = L.kn;
      L.ankle.rotation.x = floating ? 0.6 : POINT;
      const finsOn = !fim;
      L.foot.visible = !finsOn; L.pocket.visible = finsOn; L.blade.root.visible = finsOn && !mono;
      if (this.monoBlade) this.monoBlade.root.visible = mono;
      if (mono) L.hip.rotation.z = L.s * 0.005;   // feet together in the pockets
      const a = L.hip.rotation.x + L.knee.rotation.x;
      const omega = dt > 0 ? (a - L.prev) / dt : 0; L.prev = a; L.omega = ease(L.omega, omega, dt, 30);
      L.blade.update(dt, finsOn ? L.omega : 0, finsOn);
      if (mono && L.s > 0) this.monoBlade.update(dt, L.omega, true);
    }

    // ---- arms: a = how far the arm swings forward from the side (0 hanging, PI overhead)
    const nose = t - d.nose < 0.6 && !limp && ph !== 'breathe';
    for (const A of this.arms) {
      let a = 0.05, bend = 0.1, out = 0.06, rate = 8;
      if (limp) { a = 0.7; bend = 0.4; out = 0.2; rate = 2; }
      else if (floating) { a = 0.35 + 0.1 * Math.sin(this.t * 1.3 + A.s); bend = 0.7; out = 0.45; rate = 4; } // sculling
      else if (duck !== null) {
        if (stage <= 2) { a = Math.PI - 0.08; bend = 0.02; out = 0.02; }
        else if (stage === 3) { a = lerp(Math.PI - 0.08, 0.1, smooth(f)); out = 0.06 + Math.sin(f * Math.PI) * 0.8; bend = 0.05; }
        else { a = 0.08; bend = 0.15; }
      } else if (d.turnT !== null) { a = A.s > 0 ? 1.9 : 1.3; bend = 0.3; out = 0.1; }  // a hand on the line
      else if (fim) {
        // hand over hand: from overhead on the rope, pulled to the hip, then reaching back up
        const hi = A.s < 0 ? 0 : 1, tau = t - d.hands[hi].at;
        // the rope is an arm's length in front of the face (the hips hang 0.3 m off it), so each
        // hand reaches forward to it: up past the head (a 2.55, reach ahead 0.3 m) and pulled down
        // to the hip (a 0.6), the elbow bending mid-pull to keep the hand on the rope
        if (tau < STROKE.pull) { const f = smooth(tau / STROKE.pull); a = lerp(2.55, 0.6, f); bend = 0.7 * Math.sin(Math.PI * f); rate = 20; }
        else if (tau < STROKE.pull + 0.5) { a = 2.55; bend = 0.45; rate = 6; }
        else { a = 2.55; bend = 0.2; rate = 5; }
        out = 0.06;
      } else if (d.arms === 'ahead') { a = Math.PI - 0.08; bend = 0.02; out = 0.03; rate = 5; }
      else { a = 0.06; bend = 0.08; out = 0.05; rate = 5; }
      // the right hand to the nose to equalize (or for the mouthfill)
      // (the upper arm forward and down a little, the forearm folded back up to the face)
      if (A.s > 0 && (nose || (duck !== null && stage === 4))) { a = NOSE.a; bend = NOSE.bend; out = NOSE.out; rate = 14; }
      // in pain: a hand clamped over the aching ear, the other arm hugging the chest; with
      // vertigo the arms flail out for something to hold
      const busy = (A.s > 0 && nose) || d.turnT !== null || (fim && pain < 0.6);
      if (!limp && !floating && duck === null && !busy) {
        if (vert > 0.2) { a = 1.3 + 0.7 * Math.sin(this.t * 1.9 + A.s); out = 0.9 + 0.3 * Math.sin(this.t * 2.6 + A.s); bend = 0.4; rate = 6; }
        else if (A.s > 0 && earAche) { a = EAR.a; bend = EAR.bend; out = EAR.out; rate = 10; }
        else if (A.s < 0 && pain > 0.55) { a = 0.95; bend = 1.9; out = 0.12; rate = 8; }
      }
      a += shake * 0.6;
      A.a = ease(A.a, a, dt, rate); A.bend = ease(A.bend, bend, dt, rate); A.out = ease(A.out, out, dt, rate);
      // where the hand must be, which the arm reaches by IK after the head is posed: the nose, the
      // ear, or the rope (hand over hand in free immersion, a hand on it at the turn)
      let ik = null;
      if (!limp && !floating) {
        if (A.s > 0 && (nose || (duck !== null && stage === 4))) ik = 'nose';
        else if (d.turnT !== null) ik = 'rope';
        else if (duck === null && A.s > 0 && earAche && vert <= 0.2) ik = 'ear';
        else if (duck === null && fim && !(vert > 0.2) && !(A.s < 0 && pain > 0.55)) ik = 'rope';
      }
      A.ik = ik;
    }

    // ---- head: in the water the chin tucks in; floating it looks ahead; dropped when limp
    let neck = 0;
    if (limp) neck = 0.55;
    else if (floating) neck = -0.15;
    else if (duck !== null && stage >= 1 && stage <= 3) neck = 0.25;
    else neck = 0.12 + 0.15 * d.lean + (mono && d.mono.down ? 0.08 : 0);
    if (!limp && !floating) neck += 0.4 * pain;   // the chin pulled in, shoulders hunched
    this.neckBend = ease(this.neckBend, neck, dt, 6);
    this.neck.rotation.x = this.neckBend;
    this.neckRoll = ease(this.neckRoll || 0, (earAche ? 0.3 * pain : 0) + vert * 0.55 * Math.sin(this.t * 1.3), dt, 4);
    this.neck.rotation.z = this.neckRoll;
    this._arms(dt, d, fim);
    this.cheeks.visible = d.nm > 0 && d.mouthV > 0.08;
    if (this.cheeks.visible) { const k = 0.6 + 0.8 * clamp(d.mouthV / 0.5, 0, 1); this.cheeks.scale.set(0.06 * k, 0.035 * k, 0.04 * k); }
  }
}

// ---- the arms by IK: each arm's own pose (A.a, A.bend, A.out) blended toward a two-bone solve that
// puts the hand on its target. Targets are in the body's frame (the shoulders' parent).
const L1 = UPPER_ARM, L2 = FOREARM + 0.12;
const _T = new THREE.Vector3(), _u = new THREE.Vector3(), _n = new THREE.Vector3(), _p = new THREE.Vector3(), _E = new THREE.Vector3(),
  _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _qf = new THREE.Quaternion(),
  _qi = new THREE.Quaternion(), _e = new THREE.Euler(), _pole = new THREE.Vector3(), _lw = new THREE.Vector3();
DiverFigure.prototype._arms = function (dt, d, fim) {
  this.group.updateMatrixWorld(true);
  const hy = Math.cos(d.th) >= 0 ? 1 : -1;                      // which way along the rope the head points
  const reachY = d.y + hy * 0.92, shoulderY = d.y + hy * 0.45;  // the rope a long arm ahead, and at the shoulders
  for (let i = 0; i < 2; i++) {
    const A = this.arms[i];
    A.ikW = ease(A.ikW || 0, A.ik ? 1 : 0, dt, A.ik === 'rope' ? 14 : 10);
    _e.set(-A.a, 0, A.s * A.out); _qf.setFromEuler(_e);
    if (A.ik) A.kind = A.ik;
    if (A.ikW < 0.002 || !A.kind) { A.shoulder.quaternion.copy(_qf); A.elbow.rotation.x = -A.bend; continue; }
    // the target
    if (A.kind === 'nose') _T.set(0, HEAD_Y - NECK_Y - 0.03, 0.15).applyMatrix4(this.neck.matrix);
    else if (A.kind === 'ear') _T.set(A.s * 0.13, HEAD_Y - NECK_Y, 0.0).applyMatrix4(this.neck.matrix);
    else {
      // the rope: during a pull the hand holds its grip and the body slides past it; between pulls
      // it reaches ahead for the next grip
      let y;
      if (d.turnT !== null) y = shoulderY;
      else {
        const H = d.hands[i], tau = d.t - H.at;
        if (tau < STROKE.pull) { if (A.pullAt !== H.at) { A.pullAt = H.at; A.grabY = A.ropeY ?? reachY; } y = A.grabY; }
        else y = ease(A.ropeY ?? reachY, reachY, dt, 7);
      }
      A.ropeY = y;
      _T.set(0, y, 0); this.body.worldToLocal(_T);
    }
    // the solve: elbow out and down from the line from shoulder to hand
    const S = A.shoulder.position;
    _u.subVectors(_T, S); let D = _u.length(); _u.normalize();
    D = clamp(D, 0.08, L1 + L2 - 0.005);
    const cA = clamp((L1 * L1 + D * D - L2 * L2) / (2 * L1 * D), -1, 1), sA = Math.sqrt(1 - cA * cA);
    _pole.set(A.s, -0.7, -0.5);
    _n.crossVectors(_u, _pole); if (_n.lengthSq() < 1e-6) _n.set(1, 0, 0); _n.normalize();
    _p.crossVectors(_n, _u);
    _E.copy(_u).multiplyScalar(L1 * cA).addScaledVector(_p, L1 * sA);   // the elbow, from the shoulder
    _y.copy(_E).multiplyScalar(-1).normalize(); _x.copy(_n); _z.crossVectors(_x, _y);
    _m.makeBasis(_x, _y, _z); _q.setFromRotationMatrix(_m);
    // the forearm from the elbow to the hand, in the upper arm's frame: a turn about its x
    _lw.copy(_u).multiplyScalar(D).sub(_E).normalize().applyQuaternion(_qi.copy(_q).invert());
    const th = Math.atan2(-_lw.z, -_lw.y);
    _e.set(-A.a, 0, A.s * A.out); _qf.setFromEuler(_e);
    A.shoulder.quaternion.copy(_qf).slerp(_q, A.ikW);
    A.elbow.rotation.x = lerp(-A.bend, th, A.ikW);
  }
};

// ---- the fin blade: a chain of slices from the toes, bent by the water (from Diver.js): each
// slice hangs on the one before as a damped hinge (stiffness falls toward the tip), and the
// leg's angular speed loads the hinges as drag, so the root bends first and the bend runs out.
class Blade {
  constructor(F, K, width = 0.19, length = BLADE_L, taper = 0.025, stiff = 1) {
    this.root = new THREE.Group(); this.joints = []; this.stiff = stiff;
    this.angle = new Float32Array(BLADE_N); this.vel = new Float32Array(BLADE_N);
    const dz = length / BLADE_N;
    let parent = this.root;
    for (let i = 0; i < BLADE_N; i++) {
      const j = new THREE.Group(); if (i > 0) j.position.z = dz;
      const t0 = i / BLADE_N, w = width - taper * t0, r = 0.028 * (1 - 0.7 * t0) + 0.004;
      j.add(slab(w, 0.006, dz + 0.004, F, 0, 0, dz / 2));
      for (const s of [-1, 1]) j.add(slab(0.01, r, dz + 0.004, K, s * (w / 2 - 0.002), 0, dz / 2));
      parent.add(j); this.joints.push(j); parent = j;
    }
  }
  update(dt, omega, on) {
    const A = this.angle, Vv = this.vel, h = Math.min(dt, 1 / 30);
    for (let i = 0; i < BLADE_N; i++) {
      const t = (i + 0.5) / BLADE_N, k = 420 * this.stiff * (1 - 0.6 * t), c = 1.1 * Math.sqrt(k);
      const load = on ? clamp(-omega * 0.012 * (1.0 - 0.5 * t), -0.2, 0.2) : 0;
      Vv[i] += (-k * A[i] + k * load - c * Vv[i]) * h;
      A[i] = clamp(A[i] + Vv[i] * h, -0.25, 0.25);
      this.joints[i].rotation.x = A[i];
    }
  }
}

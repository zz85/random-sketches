// sim.js - one breath-hold dive down a line, as numbers: the breathe-up and packing, the duck
// dive, finning (one button a leg) or pulling the rope (free immersion), the body's balance in
// the water, equalizing (Valsalva, Frenzel, mouthfill), freefall, the turn, the ascent, and the
// surface protocol. No DOM and no three.js: main.js steps it and draws it, test_sim.js and
// bot.js drive it headless.
//
// Frame: x across (metres from the line), y up (0 the surface, -depth below). The body's angle
// `th` turns its feet-to-head axis counter-clockwise from straight up, so the head points along
// h = (-sin th, cos th): th 0 head up, th PI head down. (x, y) is the centre of mass, at the hips.
//
// What the numbers stand for, each kept simple enough to play with:
// - Pressure 1 atm plus 1 per 10 m. Gas (lungs, mouth, neoprene) shrinks as 1/P (Boyle), so a
//   diver who floats at the surface is neutral somewhere around 10-15 m and sinks below it.
// - Buoyancy acts at the chest (the lungs) and weight at the hips: head down is unstable, head
//   up is stable. Moving through the water the fins trail like an arrow's feathers and keep the
//   body pointing where it goes, so balance matters most where you are slow: the first metres
//   against the lift, the turn, and the last metres before the surface.
// - Drag is quadratic, small along the body (streamlined) and large across it. A kick spreads the
//   fins (more drag for a moment), a wobble or a hand off the streamline adds more.
// - Oxygen: the lungs' O2 fraction falls with what you burn, buffered by the blood; the brain's
//   PO2 follows the lungs' (fraction x pressure) a few seconds late. Rising, the pressure falls
//   and so does the PO2: blackouts happen in the last metres and just after the surface.
// - CO2 is the urge to breathe: a warning, not the danger. Hyperventilating during the breathe-up
//   delays it (and lowers the blackout margin), so the warning comes late.

export const RHO = 1025, G = 9.81;

export const BODY = {
  TLC: 6.0,        // L, lungs after a full inhale
  FRC: 2.6,        // L, after a relaxed exhale
  RV: 1.5,         // L, after a forced exhale: what is left
  PACK: 3.0,       // L, the most packing (buccal pumping) adds over a full inhale
  suit: 2.5,       // kg of lift the neoprene gives at the surface, squashed with depth like gas
  neg: 4.0,        // kg the rest of you sinks by (tissue, bone, the weight belt)
  mass: 95,        // kg, with the water you carry along
  inertia: 18,     // kg m^2 about the hips, with the water
  chest: 0.34,     // m from the hips to where the lungs lift, arms at the sides
  cda: 0.055,      // m^2, drag area along the body, streamlined
  cdaSide: 0.55,   // m^2, across it
  frenzel: 1.3,    // x RV: below this lung volume no air reaches the mouth (the Frenzel limit)
  mouthMin: 0.2,   // L: below this the cheeks can't push a mouthfill into the ears
  squeeze: 0.6,    // x RV: below this the chest itself is squeezed
};

// the duck dive, seconds from its start: a glide with the arms ahead, the jackknife, the legs
// lifted straight up (their weight drives the body down), one arm pull, a hand to the nose
export const DUCK = { glide: 0.7, knife: 1.4, legs: 2.1, pull: 3.0, equalize: 3.6, end: 4.0 };
export const STROKE = { kick: 0.24, pull: 0.55, turn: 1.6, mouthfill: 0.8 };
export const KICK = { ideal: 0.45, J: 26 };   // s between kicks of a good flutter; N s per kick
export const PULL = { ideal: 0.75, J: 50 };   // s between pulls hand over hand; N s per pull

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (a, b, dt, rate) => a + (b - a) * (1 - Math.exp(-dt * rate));
const smooth = (t) => t * t * (3 - 2 * t);

export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// how good a stroke is from the time since the one before: a gaussian in log time around the
// ideal gap (narrower on the hurried side), or a fresh start from a glide
function tempo(gap, ideal) {
  const l = Math.log(Math.max(gap, 1e-3) / ideal);
  const g = Math.exp(-((l / (l < 0 ? 0.5 : 0.8)) ** 2));
  return Math.max(g, 0.75 * smooth(clamp((gap - 1.3 * ideal) / (1.3 * ideal), 0, 1)));
}

export class Dive {
  constructor({ discipline = 'CWT', target = 30, seed = 7 } = {}) {
    this.discipline = discipline; // 'CWT' constant weight with fins, 'FIM' free immersion (the rope)
    this.target = target;
    this.rnd = mulberry32(seed);
    this.t = 0;
    this.phase = 'breathe';       // breathe -> duck -> dive -> surface -> done
    this.events = [];             // { t, key, text }: main.js shows them
    this._said = {};

    // breathe-up
    this.lung = BODY.FRC; this.inhaling = false; this.inhaleAt = 0; this.packed = 0; this.holding = false;
    this.relax = 0.45; this.hypo = 0; this.vent = 7; this.fin = 0.4; this.syncope = 0;
    this.breathStarts = [];

    // the body in the water
    this.x = 0.6; this.y = 0; this.vx = 0; this.vy = 0; this.th = 0.1; this.om = 0;
    this.lean = 0; this.arms = 'sides'; this.turb = 0; this.bias = 0;
    this.legs = [{ at: -9, q: 0 }, { at: -9, q: 0 }];
    this.hands = [{ at: -9, q: 0 }, { at: -9, q: 0 }];
    this.lastStroke = -9; this.lastSide = -1; this.strokes = [];
    this.kickDrag = 0; this.nose = -9; this.mouthfillAt = -9; this.lastKick = -9;
    this.stream = 1; this.kicks = 0; this.pulls = 0; this.quality = 1;

    // gas and blood
    this.nL = BODY.FRC;   // lung gas, surface litres (an amount, not a volume)
    this.nm = 0;          // mouthfill gas, surface litres
    this.f = 0.14;        // lung O2 fraction
    this.brain = 0.14;    // brain PO2, atm, lagging the lungs'
    this.urge = 0.15;     // CO2: contractions start at 1
    this.tension = 0; this.effort = 0;
    this.Pe = 1;          // the middle ear's pressure, atm
    this.earHurt = 0; this.squeeze = 0;

    // the dive and its record
    this.duckT = 0; this.duckX0 = 0.6; this.diveT = 0; this.tSub = 0; this.maxDepth = 0;
    this.turnT = null; this.turned = false; this.tag = false; this.early = false;
    this.surfT = 0; this.hooks = 0; this.firstBreath = null; this.okAt = null;
    this.lmc = false; this.blackout = null; this.injury = null; this.result = null;
    this.tugs = 0; this.o2Used = 0; this.equalizes = 0; this.trace = [];
  }

  // ---- what the HUD reads
  get depth() { return Math.max(0, -this.y); }
  get P() { return 1 + this.depth / 10; }
  get gas() { return this.phase === 'breathe' ? this.lung + this.packed : this.nL + this.nm; }
  get lungV() { return this.phase === 'breathe' ? this.lung + this.packed : this.nL / this.P; }
  get mouthV() { return this.nm / this.P; }
  get netKg() { return (this.gas + BODY.suit) / this.P - BODY.neg; }
  get neutralDepth() { return Math.max(0, ((this.gas + BODY.suit) / BODY.neg - 1) * 10); }
  get dP() { return this.P - this.Pe; }
  get speed() { return Math.hypot(this.vx, this.vy); }
  get headDown() { return Math.cos(this.th) < -0.3; }
  get threshold() { return 0.035 + 0.015 * clamp(this.hypo, 0, 1); }  // brain PO2 at blackout
  get frenzelLimit() { return BODY.RV * BODY.frenzel; }
  get canFrenzel() { return this.nm > 0 ? this.mouthV >= BODY.mouthMin : this.lungV >= this.frenzelLimit; }
  get hr() { return Math.round(55 + 35 * (1 - this.relax) + 15 * Math.max(0, this.hypo) - (this.phase === 'dive' ? 15 * clamp(this.tSub / 25, 0, 1) : 0) + 25 * this.tension); }
  get breathRate() { return this.breathStarts.filter((t) => this.t - t < 60).length; }
  get dizzy() {
    if (this.packed < 1.4) return 0;
    const over = this.phase === 'breathe' || this.phase === 'duck' ? this.packed : this.nL / this.P - BODY.TLC;
    return clamp((this.packed - 1.4) / 1.4, 0, 1) * clamp(over / this.packed, 0, 1);
  }
  get o2() { return clamp((this.brain - this.threshold) / (0.14 - this.threshold), 0, 2); } // 1 = as you started, at the surface

  say(key, text, cool = 4) {
    const last = this._said[key];
    if (last !== undefined && this.t - last < cool) return false;
    this._said[key] = this.t; this.events.push({ t: this.t, key, text }); return true;
  }
  once(key, text) { return this.say(key, text, Infinity); }

  // ---- input: the breathe-up
  breath(on) {
    if (this.phase === 'breathe') {
      if (on && this.holding) { this.holding = false; this.packed = 0; this.say('letgo', 'You let the breath go. Breathe up again.', 0); }
      if (on && !this.inhaling) { this.breathStarts.push(this.t); this.inhaleAt = this.t; }
      this.inhaling = on;
    } else if (this.phase === 'surface' && on) this.hook();
  }

  pack() {
    if (this.phase !== 'breathe') return false;
    if (this.lung < BODY.TLC - 0.1) { this.say('packfirst', 'Fill your lungs first: hold Breathe to the top, then pack.', 0); return false; }
    if (this.packed >= BODY.PACK - 0.02) { this.say('packmax', 'Nothing more fits.', 1); return false; }
    if (!this.holding) { this.holding = true; this._hold(); }
    this.inhaling = false;
    this.packed = Math.min(BODY.PACK, this.packed + 0.3 * (1 - this.packed / (BODY.PACK + 0.5)));
    this.effort += 0.002;
    if (this.packed > 1.5) this.once('overpack', 'Packed tight: dizzy, a stiff throat for the first Frenzels, and a lot of lift to fight. Do not linger.');
    return true;
  }

  // the last breath is taken: the hold starts, with what the breathe-up left in the blood
  _hold() {
    this.f = 0.14 + 0.012 * clamp(this.hypo, 0, 1) + 0.004 * this.relax;
    this.brain = this.f;
    this.urge = 0.15 - 0.4 * this.hypo;
  }

  dive() {
    if (this.phase !== 'breathe') return false;
    if (!this.holding) this._hold();
    this.inhaling = false;
    this.nL = this.lung + this.packed;
    if (this.lung < BODY.TLC - 0.5 && !this.packed) this.say('half', `Down on ${this.lung.toFixed(1)} L: less air, less lift, an early Frenzel limit.`, 0);
    if (this.hypo > 0.35) this.say('hypo', 'You hyperventilated: the urge to breathe will come late, and the margin is thin.', 0);
    this.phase = 'duck'; this.duckT = 0; this.duckX0 = this.x;
    return true;
  }

  // ---- input: under water
  setLean(v) { this.lean = clamp(v, -1, 1); }
  setArms(a) { this.arms = a === 'ahead' ? 'ahead' : 'sides'; }

  // one leg's kick: flutter is the legs taking turns at a steady beat
  kick(i) {
    if (this.phase !== 'dive' || this.blackout || this.discipline !== 'CWT' || this.turnT !== null) return null;
    const L = this.legs[i];
    if (this.t - L.at < STROKE.kick * 0.7) return { q: 0, busy: true };
    const gap = this.t - this.lastStroke;
    const alt = this.lastSide === 1 - i || gap > 1.3 * KICK.ideal ? 1 : 0.35;
    const q = alt * tempo(gap, KICK.ideal);
    L.at = this.t; L.q = q; this.lastStroke = this.t; this.lastSide = i; this.lastKick = this.t;
    this.strokes.push({ kind: 'kick', until: this.t + STROKE.kick, F: KICK.J * q / STROKE.kick });
    this.effort += 0.0045 * (1 + 1.6 * (1 - q));
    this.urge += 0.0015 * (1 + (1 - q));
    this.kickDrag += 0.12 + 0.25 * (1 - q);
    this.om += (this.rnd() - 0.5) * 0.7 * (1 - q);   // a bad kick twists you
    this.tension = Math.min(1, this.tension + 0.03 * (1 - q));
    this.kicks++; this.quality = ease(this.quality, q, 1, 0.35);
    if (q < 0.4) this.say('kickbad', alt < 1 ? 'Same leg twice: flutter alternates, left, right, left.' : 'Too fast: long, even kicks drive you, mashing just churns.', 6);
    return { q };
  }

  // free immersion: one hand over the other down (or up) the rope
  pull(i) {
    if (this.phase !== 'dive' || this.blackout || this.discipline !== 'FIM' || this.turnT !== null) return null;
    const H = this.hands[i];
    if (this.t - H.at < STROKE.pull * 0.7) return { q: 0, busy: true };
    const gap = this.t - this.lastStroke;
    const alt = this.lastSide === 1 - i || gap > 1.3 * PULL.ideal ? 1 : 0.4;
    const q = alt * tempo(gap, PULL.ideal);
    const hy = Math.cos(this.th);
    H.at = this.t; H.q = q; this.lastStroke = this.t; this.lastSide = i;
    // you pull along the rope the way your head points
    this.strokes.push({ kind: 'pull', until: this.t + STROKE.pull, F: PULL.J * q * clamp(Math.abs(hy) * 1.4 - 0.4, 0, 1) / STROKE.pull, dir: Math.sign(hy) || 1 });
    this.effort += 0.006 * (1 + 1.6 * (1 - q));
    this.urge += 0.002 * (1 + (1 - q));
    this.tension = Math.min(1, this.tension + 0.03 * (1 - q));
    this.pulls++; this.quality = ease(this.quality, q, 1, 0.35);
    if (q < 0.4) this.say('pullbad', alt < 1 ? 'Hand over hand: left, right, left.' : 'Long, smooth pulls. Yanking burns oxygen.', 6);
    return { q };
  }

  // Frenzel: the tongue pushes air from the mouth into the ears; the mouth refills from the lungs
  // until they are nearly empty (the Frenzel limit), or from a mouthfill after that
  frenzel() {
    if (!this._under() || this.t - this.nose < 0.22) return null;
    this.nose = this.t; this.equalizes++;
    const P = this.P;
    let eff;
    if (this.nm > 0) {
      if (this.mouthV < BODY.mouthMin) { this.say('mfempty', 'The mouthfill is spent: nothing left to push. Time to turn.', 3); return { eff: 0 }; }
      eff = 1; this.nm = Math.max(0, this.nm - 0.001 * P);   // a little goes into the ears
    } else {
      eff = clamp((this.lungV - BODY.RV * 1.2) / (BODY.RV * 0.15), 0, 1);
      if (eff <= 0) { this.say('flimit', 'Frenzel limit: the lungs are too small to fill the mouth. A mouthfill, taken shallower, would carry you on.', 3); return { eff: 0 }; }
      // overpacked lungs stiffen the throat: the first Frenzels are clumsy
      if (this.lungV > BODY.TLC) { eff *= 0.45; this.say('tight', 'Packed lungs: a tight throat, Frenzel is hard until the air has squashed.', 5); }
    }
    this.Pe = Math.min(P, this.Pe + 0.16 * eff);
    this.effort += 0.0006;
    return { eff };
  }

  // Valsalva: pushing against a closed nose with the chest. Easy head up near the surface, weak
  // head down and once the lungs are small, costly, and it blows a mouthfill
  valsalva() {
    if (!this._under() || this.t - this.nose < 0.3) return null;
    this.nose = this.t; this.equalizes++;
    let eff = clamp((this.lungV - 2.5) / 1.5, 0, 1) * (this.headDown ? 0.35 : 1);
    if (this.nm > 0) { this.nm = 0; this.say('mfblown', 'Valsalva blew the mouthfill away.', 0); }
    this.Pe = Math.min(this.P, this.Pe + 0.3 * eff);
    this.effort += 0.008; this.urge += 0.01;
    this.tension = Math.min(1, this.tension + 0.12);
    this.om += (this.rnd() - 0.5) * 0.5;
    if (eff < 0.3) this.say('valweak', this.headDown ? 'Valsalva barely works head down. Frenzel.' : 'The lungs are too small for Valsalva now.', 4);
    return { eff };
  }

  // a mouthfill: fill the mouth from the last of the lungs and lock it, then Frenzel from it
  mouthfill() {
    if (!this._under() || this.nm > 0 || this.t - this.mouthfillAt < 1) return null;
    const fill = clamp(Math.min(0.5, (this.lungV - BODY.RV * 0.9) * 0.55), 0, 0.5);
    this.mouthfillAt = this.t; this.nose = this.t;
    if (fill < 0.12) { this.say('mflate', 'Too deep: the lungs have nothing left to give the mouth.', 0); return { fill: 0 }; }
    const n = fill * this.P;
    this.nm = n; this.nL -= n;
    this.effort += 0.004;
    const reach = (n / BODY.mouthMin - 1) * 10;
    this.say('mf', `Mouthfill ${(fill * 1000).toFixed(0)} ml at ${this.depth.toFixed(0)} m: good for about ${reach.toFixed(0)} m.`, 0);
    return { fill, reach };
  }

  turn() {
    if (this.phase !== 'dive' || this.turnT !== null || this.turned || this.blackout || !this.headDown) return false;
    this.tag = this.depth >= this.target - 1.2;
    this.early = !this.tag;
    this.turnT = 0; this.turnFrom = this.th;
    this.turnDir = (this.om + 0.3 * this.lean) >= 0 ? 1 : -1;
    this.effort += 0.01; this.tension = Math.min(1, this.tension + 0.05);
    this.say('turn', this.tag ? `Tag at ${this.target} m. Up you go: it is a long way against the weight.` : `Turned at ${this.depth.toFixed(1)} m, short of the plate.`, 0);
    return true;
  }

  // a recovery breath at the surface (hook breathing: in, hold, push)
  hook() {
    if (this.phase !== 'surface' || this.blackout) return;
    this.hooks++;
    if (this.firstBreath === null) this.firstBreath = this.surfT;
    this.f += (0.15 - this.f) * 0.4;
    this.urge = Math.max(0, this.urge - 0.5);
  }

  ok() {
    if (this.phase !== 'surface' || this.blackout || this.okAt !== null) return;
    if (!this.hooks) { this.say('okfirst', 'Breathe first, then the OK.', 0); return; }
    this.okAt = this.surfT;
  }

  _under() { return (this.phase === 'dive' || (this.phase === 'duck' && this.duckT > DUCK.legs)) && !this.blackout; }

  // ---- time
  step(dt) {
    const n = Math.max(1, Math.ceil(dt / (1 / 240))), h = dt / n;
    for (let i = 0; i < n; i++) this._step(h);
  }

  _step(h) {
    this.t += h;
    switch (this.phase) {
      case 'breathe': this._breathe(h); break;
      case 'duck': this._duck(h); break;
      case 'dive': this._dive(h); break;
      case 'surface': this._surface(h); break;
      default: this._after(h);
    }
    if (this.phase !== 'breathe' && (this.trace.length === 0 || this.t - this.trace[this.trace.length - 1][0] > 0.25)) this.trace.push([this.t, this.depth]);
  }

  _breathe(h) {
    const prev = this.lung;
    // a short press is a small breath; held, the breath gets bigger and faster, to the top in ~4 s
    if (this.inhaling) this.lung = Math.min(BODY.TLC, this.lung + (0.3 + 0.25 * (this.t - this.inhaleAt)) * h);
    else if (!this.holding) this.lung += (BODY.FRC - this.lung) * (1 - Math.exp(-h * 0.55));
    const flow = Math.abs(this.lung - prev) / h;              // L/s
    this.vent = ease(this.vent, flow * 30, h, 0.12);         // L/min: half the air moved is breathed out
    if (!this.holding) {
      this.fin = ease(this.fin, this.inhaling ? 1 : 0, h, 0.1);
      this.hypo = clamp(this.hypo + h * (this.vent - 12) / 700, -0.5, 1);
      // calm: little air moved, and long exhales (in a third of the time, out two thirds)
      const calm = clamp(1 - (this.vent - 8) / 12, 0, 1) * clamp(1 - Math.abs(this.fin - 0.33) / 0.35, 0, 1);
      this.relax = ease(this.relax, calm, h, 0.04);
      if (this.hypo > 0.25) this.say('hyper', 'Breathing hard and fast: that is hyperventilation. It hides the warning, it does not add oxygen.', 20);
    } else {
      this._o2(h, 1);
      this.relax = ease(this.relax, this.relax * (1 - 0.15 * this.dizzy), h, 0.2);
      if (this.packed > 2.6) this.syncope += h * 0.09 * ((this.packed - 2.6) / 0.4) ** 2;
      if (this.syncope > 0.5) this.say('faint', 'Grey at the edges: the packed lungs press on the heart. Go, or let it out.', 4);
      if (this.syncope >= 1) this._blackout('packing blackout at the surface');
    }
  }

  _duck(h) {
    this.duckT += h;
    const T = this.duckT, D = DUCK;
    const seg = (a, b) => smooth(clamp((T - a) / (b - a), 0, 1));
    // the duck dive is the body's own move: placed, not simulated
    const fim = this.discipline === 'FIM';
    this.x = lerp(this.duckX0, fim ? 0.3 : 0.2, seg(0, D.knife));
    const lift = 1 - 0.1 * this.packed;   // a packed body sinks less far on the same move
    this.y = -lift * (0.15 * seg(0, D.glide) + 0.35 * seg(D.glide, D.knife) + 0.5 * seg(D.knife, D.legs) + 0.9 * seg(D.legs, D.pull) + 0.6 * seg(D.pull, D.end));
    this.th = 0.1 + (Math.PI / 2 - 0.1) * seg(0, D.glide * 0.8) + (Math.PI / 2 - 0.05) * seg(D.glide, D.knife);
    this.vx = this.vy = this.om = 0;
    this.effort += 0.01 * h / D.end;
    this._body(h, this.P);
    if (this.packed > 2.6) { this.syncope += h * 0.09 * ((this.packed - 2.6) / 0.4) ** 2; if (this.syncope >= 1) return this._blackout('packing blackout on the duck dive'); }
    if (T - h < D.equalize && T >= D.equalize) this.frenzel();
    if (T >= D.end) {
      this.phase = 'dive'; this.vy = -(0.75 - 0.12 * this.packed); this.vx = 0;
      this.say('go', this.discipline === 'CWT' ? 'Kick: left, right, left... and keep your ears equalized.' : 'Pull: hand over hand down the rope.', 0);
    }
  }

  _dive(h) {
    const B = BODY, P = this.P, d = this.depth;
    this.diveT += h; this.tSub += h; this.maxDepth = Math.max(this.maxDepth, d);
    const fim = this.discipline === 'FIM';
    const hx = -Math.sin(this.th), hy = Math.cos(this.th);
    const gasV = this.gas / P;
    let net = (this.gas + B.suit) / P - B.neg;
    if (this.y > -0.3 && net > 0) net *= clamp(-this.y / 0.3, 0, 1);  // floating at the top
    let Fx = 0, Fy = net * G;

    // strokes still running
    let kicking = false, pulling = false;
    for (const s of this.strokes) {
      if (this.t >= s.until) continue;
      if (s.kind === 'kick') { Fx += s.F * hx; Fy += s.F * hy; kicking = true; }
      else { Fy += s.F * s.dir; pulling = true; }
    }
    if (this.strokes.length > 8) this.strokes = this.strokes.filter((s) => this.t < s.until);
    this.kickDrag *= Math.exp(-3 * h);

    // drag: along the body and across it
    const vax = this.vx * hx + this.vy * hy, px = this.vx - vax * hx, py = this.vy - vax * hy, perp = Math.hypot(px, py);
    let S = (this.arms === 'ahead' ? 0.82 : 1) + this.kickDrag + 1.2 * Math.abs(this.om) + 0.08 * Math.abs(this.lean)
      + (this.t - this.nose < 0.6 ? 0.15 : 0) + (pulling ? 0.08 : 0);
    if (vax < 0) S *= 1.6;                // feet or back first
    const ka = 0.5 * RHO * B.cda * S, kp = 0.5 * RHO * B.cdaSide;
    Fx -= ka * Math.abs(vax) * vax * hx + kp * perp * px;
    Fy -= ka * Math.abs(vax) * vax * hy + kp * perp * py;
    const sp = Math.hypot(this.vx, this.vy);
    this.stream = ease(this.stream, (0.82 / S) * (sp > 0.2 ? Math.abs(vax) / sp : 1), h, 4);

    // the line: free immersion holds it; constant weight wears a lanyard on it
    if (fim) { Fx += -500 * (this.x - 0.3) - 150 * this.vx; Fy -= 8 * this.vy; }
    else if (Math.abs(this.x) > 1.2) {
      Fx -= Math.sign(this.x) * 400 * (Math.abs(this.x) - 1.2) + 60 * this.vx;
      if (this.say('tug', 'The lanyard snaps tight: you have drifted off the line. Lean back toward it.', 5)) { this.tugs++; this.effort += 0.01; this.tension = Math.min(1, this.tension + 0.15); this.om += (this.rnd() - 0.5) * 0.6; }
    }

    // turning: one hand on the line, the body swung round, the speed held
    if (this.turnT !== null) {
      this.turnT += h;
      const f = smooth(clamp(this.turnT / STROKE.turn, 0, 1));
      this.th = this.turnFrom + this.turnDir * Math.PI * f; this.om = 0;
      this.vx = ease(this.vx, 0, h, 5); this.vy = ease(this.vy, 0, h, 5);
      Fx = Fy = 0;
      if (this.turnT >= STROKE.turn) { this.turnT = null; this.turned = true; this.th = this.turnFrom + this.turnDir * Math.PI; }
    } else {
      // torques: the lungs lift the chest, the fins trail, your weight shifts, the water stirs
      const chest = this.arms === 'ahead' ? 0.27 : B.chest;
      let tq = -chest * Math.sin(this.th) * gasV * G;
      if (sp > 0.03) tq += 30 * sp * (hx * this.vy - hy * this.vx);
      tq += this.lean * 16;
      // the water stirs (quick), and your balance wanders (slow: the head turns, a shoulder drops,
      // the belt slides, a current): neither stops by itself, so you keep correcting
      const sig = 5 * (1 + 1.5 * this.dizzy), k = 1.2;
      this.turb += -k * this.turb * h + sig * Math.sqrt(2 * k * h) * gauss(this.rnd);
      this.bias += -this.bias / 8 * h + 7 * (1 + this.dizzy) * Math.sqrt(2 / 8 * h) * gauss(this.rnd);
      tq += this.turb + this.bias;
      if (fim) { const want = Math.round(this.th / Math.PI) * Math.PI; tq += -60 * (this.th - want); }
      tq -= (35 + 45 * sp) * this.om;
      this.om += tq / B.inertia * h;
      this.th += this.om * h;
    }

    this.vx += Fx / B.mass * h; this.vy += Fy / B.mass * h;
    this.x += this.vx * h; this.y += this.vy * h;
    if (this.y > 0) { this.y = 0; this.vy = Math.min(this.vy, 0); }
    if (!this.turned && this.y < -this.target - 0.2) {
      this.y = -this.target - 0.2; this.vy = Math.max(this.vy, 0);
      this.say('plate', 'The bottom plate. Grab the tag and turn (T).', 3);
    }

    this._body(h, P, kicking || pulling);
    if (this.phase !== 'dive') return;

    // teaching moments
    if (net < 0 && this.vy < 0 && d > 6) this.once('neutral', `Past neutral at about ${d.toFixed(0)} m: from here the water pulls you down.`);
    if (net < -0.5 && this.vy < -0.4 && this.t - this.lastStroke > 2 && !this.turned) this.once('freefall', 'Freefall. Stop working: arms by your sides, chin in, stay straight.');
    if (!this.nm && this.lungV < this.frenzelLimit + 0.35 && !this.turned) this.once('fnear', 'Lungs nearly at the Frenzel limit: take the mouthfill now (M).');

    // up: out of the water
    if (this.y > -0.35 && this.vy >= 0 && this.maxDepth > 3 && Math.cos(this.th) > 0.3) {
      this.phase = 'surface'; this.surfT = 0; this.vx = this.vy = this.om = 0;
      this.say('surface', 'Surface! Breathe (hook breaths), then give the OK.', 0);
    }
  }

  // what every phase under the water does to the body: oxygen, CO2, tension, ears, chest
  _body(h, P, working = false) {
    this.tension = ease(this.tension, this.urge > 1 ? 0.15 + 0.25 * Math.min(this.urge - 1, 1) : 0, h, 0.4);
    this.urge += h * (1 / 80) * (1 + this.tension);
    if (this.urge > 1) this.once('contractions', 'Contractions: the urge to breathe. It is CO2 talking, not empty lungs. Stay calm.');
    this._o2(h, P);
    if (this.Pe > P) this.Pe = P;   // the tubes vent on the way up
    const dP = P - this.Pe;
    if (dP > 0.25) { this.tension = Math.min(1, this.tension + h * 0.6); this.say('earpain', 'Ears hurt! Equalize (F) or stop going down.', 3); }
    else if (dP > 0.12) this.say('ears', 'Pressure in the ears: equalize.', 4);
    if (dP > 0.42) { this.earHurt += h * (dP - 0.42) * 6; if (this.earHurt >= 1 && !this.injury) this._injure('ear barotrauma: an eardrum gave way'); }
    const lv = this.nL / P;
    if (lv < BODY.RV * BODY.squeeze && this.phase === 'dive') {
      this.squeeze += h * ((BODY.RV * BODY.squeeze - lv) / (BODY.RV * BODY.squeeze)) * (0.3 + this.speed + 2 * this.tension + 2 * Math.abs(this.om)) * 0.3;
      this.say('chest', 'Deep for your lungs: the chest is squeezed. Stay relaxed and slow.', 6);
      if (this.squeeze >= 1 && !this.injury) this._injure('lung squeeze');
    }
    void working;
  }

  _o2(h, P) {
    const reflex = clamp(this.tSub / 25, 0, 1);
    const rate = lerp(0.30, 0.20, reflex) + 0.14 * (1 - this.relax) + 0.3 * this.tension;  // L/min at rest
    const used = rate / 60 * h + this.effort;
    this.urge += this.effort * 2;
    this.effort = 0;
    this.f = Math.max(0, this.f - used / (this.nL + this.nm + 6));   // + about 6 L of the blood's buffer
    this.o2Used += used;
    this.brain = ease(this.brain, this.f * P, h, 1 / 6);
    const thr = this.threshold;
    if (this.brain < thr + 0.01 && this.phase === 'surface' && !this.lmc) { this.lmc = true; this.say('lmc', 'Samba! Loss of motor control: the brain is short of oxygen.', 0); }
    if (this.brain < thr) this._blackout(this.phase === 'surface' ? 'blackout at the surface' : `blackout at ${this.depth.toFixed(0)} m`);
  }

  _injure(what) {
    this.injury = what;
    this.say('injury', `Injured: ${what}. Abort, go up.`, 0);
    if (this.phase === 'dive' && this.headDown && this.turnT === null && !this.turned) { this.turn(); this.early = true; this.tag = false; }
  }

  _blackout(why) {
    if (this.blackout) return;
    this.blackout = why; this.say('blackout', `Blackout: ${why}. Your buddy brings you up.`, 0);
    this._finish();
  }

  _surface(h) {
    this.surfT += h;
    this.y = ease(this.y, 0, h, 3); this.th = ease(this.th, 0.15, h, 3); this.x = ease(this.x, 0.6, h, 0.5);
    if (this.hooks >= 3) this.f = ease(this.f, 0.15, h, 0.4);
    this._body(h, 1);
    if (this.phase !== 'surface') return;
    if (this.surfT > 4 && this.firstBreath === null) this.say('breathe', 'Breathe!', 2);
    if (this.surfT >= (this.okAt !== null && this.hooks >= 3 ? 12 : 15)) this._finish();
  }

  _after(h) {
    // limp: drifting where the buddy holds you, or floating after the dive
    this.vx = ease(this.vx, 0, h, 2); this.vy = ease(this.vy, 0, h, 2); this.om = ease(this.om, 0, h, 2);
    if (this.blackout) { this.y = ease(this.y, 0, h, 0.6); this.th = ease(this.th, 0.6, h, 1); }
    this.brain = ease(this.brain, 0.12, h, 0.2);
  }

  _finish() {
    const notes = []; let card = 'white';
    if (!this.tag && this.maxDepth > 0) this.early = true;
    const red = (s) => { card = 'red'; notes.push(s); };
    const yellow = (s) => { if (card === 'white') card = 'yellow'; notes.push(s); };
    if (this.blackout) red(this.blackout);
    if (this.injury) red(this.injury);
    if (this.lmc && !this.blackout) red('loss of motor control at the surface');
    if (!this.blackout) {
      if (this.okAt === null) red('no OK sign within 15 s');
      if (this.firstBreath !== null && this.firstBreath > 4) yellow(`first breath ${this.firstBreath.toFixed(0)} s after the surface`);
      if (this.early && !this.injury) yellow(`turned early (${this.maxDepth.toFixed(1)} of ${this.target} m)`);
    }
    if (this.tugs) notes.push(`${this.tugs} lanyard tug${this.tugs > 1 ? 's' : ''}`);
    const depth = this.tag ? this.target : Math.floor(this.maxDepth * 10) / 10;
    const score = card === 'red' ? 0 : depth - (this.early ? 0.5 * Math.max(0, this.target - this.maxDepth) : 0) - (card === 'yellow' ? 1 : 0);
    this.result = { card, depth, target: this.target, tag: this.tag, time: this.diveT + DUCK.end, o2: this.o2Used, notes, score: Math.max(0, Math.round(score * 10) / 10), discipline: this.discipline, packed: this.packed };
    this.phase = 'done';
  }
}

function gauss(rnd) {
  let u = 0; while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

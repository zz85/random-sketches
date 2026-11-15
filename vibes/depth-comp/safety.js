// safety.js - the safety diver: waits at the surface on the other side of the line, leaves in
// time to meet you on your way up (at 20 m, or two thirds of the way down on a shallower dive),
// turns there head up to face you, and comes up beside you face to face. If you black out it
// reaches you and brings you up, holding you; if it was waiting at the surface it goes down for
// you, as far as 35 m. Deeper than that, the line's counterweight hauls you up by your lanyard to
// the safety at the meeting depth; with no lanyard, nobody can reach you. It is a second DiverFigure posed from a puppet that has the fields DiverFigure.update
// reads from a dive.
//
//   const s = new Safety(figure); every frame after dive.step: s.update(dt, dive) -> events
import { DUCK } from './sim.js';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const ease = (a, b, dt, rate) => a + (b - a) * (1 - Math.exp(-dt * rate));
const smooth = (t) => t * t * (3 - 2 * t);
const SPEED = 1.1, RESCUE = 1.6, UP = 1.0;   // m/s: descending, going down for you, bringing you up
const X = -0.7;                                // its place: across the line from you
const REACH = 35;                              // the deepest it goes down for you

export const meetDepth = (target) => (target >= 30 ? 20 : Math.max(4, Math.round(target * 0.66)));

export class Safety {
  constructor(fig) {
    this.fig = fig;
    this.p = {   // the puppet DiverFigure reads
      phase: 'surface', t: 0, discipline: 'CWT', fins: 'bi', blackout: null, pain: 0, vertigo: 0, dP: 0,
      duckT: 0, th: 0.15, x: X - 0.2, y: 0, vy: 0, lean: 0, arms: 'sides', nm: 0, mouthV: 0, nose: -9, turnT: null,
      legs: [{ at: -9, q: 1 }, { at: -9, q: 1 }], hands: [{ at: -9, q: 1 }, { at: -9, q: 1 }], mono: { down: false, at: -9, upAt: -9, q: 1 },
    };
    this.reset(30);
  }

  reset(target) {
    Object.assign(this.p, { phase: 'surface', th: 0.15, x: X - 0.2, y: 0, vy: 0, turnT: null, duckT: 0, nose: -9 });
    this.state = 'wait'; this.meet = meetDepth(target); this.rescued = false; this.haul = false; this.lost = false; this.kickAt = 0; this.side = 0; this.holding = false; this.events = [];
  }

  // how long until you reach the meeting depth on the way up, from what you are doing now
  _eta(d) {
    const up = Math.max(0.6, d.vy);
    if (d.phase === 'duck') return 99;
    if (!d.turned && d.turnT === null) return (d.target - d.depth) / Math.max(0.6, -d.vy) + 2 + (d.target - this.meet) / 1.1;
    return d.depth > this.meet ? (d.depth - this.meet) / up : 0;
  }

  update(dt, d) {
    const p = this.p; p.t = d.t;
    const say = (key, text) => this.events.push({ key, text });

    // a blackout: go to you, take hold, bring you up
    if (d.blackout && !this.rescued) {
      this.rescued = true;
      this.haul = d.depth > REACH && d.lanyard;
      // near you, or you are at the surface (it is beside you there): it takes hold at once
      if ((Math.abs(p.y - d.y) < 1.5 && this.state !== 'wait') || d.depth < 1.5) { this.state = 'hold'; say('rescue', 'Your safety has you: holding your airway, bringing you up.'); }
      else if (d.depth > REACH && !d.lanyard) { this.state = 'done'; this.lost = true; say('lost', `Too deep for your safety at ${d.depth.toFixed(0)} m, and no lanyard to haul you up by.`); }
      else {
        if (this.state === 'wait' || this.state === 'done') { p.phase = 'duck'; p.duckT = 0; this.duckFrom = { x: p.x, y: p.y }; }
        else if (p.phase !== 'duck') p.phase = 'dive';
        this.state = 'rescue';
        say('rescue', this.haul ? `The counterweight hauls the line up: your lanyard brings you from ${d.depth.toFixed(0)} m to your safety at ${this.meet} m.` : `Your safety goes down for you (${d.depth.toFixed(0)} m).`);
      }
    }
    // hauled up the line by the lanyard, limp, until the safety takes you
    if (this.haul && this.state !== 'hold' && this.state !== 'done') { d.held = true; d.y = Math.min(0, d.y + UP * 1.2 * dt); d.x = ease(d.x, 0.2, dt, 2); }

    switch (this.state) {
      case 'wait':
        // breathing up at the surface beside the buoy, watching you; it leaves once you will be at
        // the meeting depth in about the time it takes to get there
        p.phase = 'surface'; p.y = ease(p.y, 0, dt, 2); p.th = ease(p.th, 0.15, dt, 2); p.x = ease(p.x, X - 0.2, dt, 1);
        if (d.phase === 'dive' && d.maxDepth > this.meet * 0.5 && this._eta(d) < DUCK.end + this.meet / SPEED + 3) {
          this.state = 'duck'; p.phase = 'duck'; p.duckT = 0; this.duckFrom = { x: p.x, y: p.y };
          say('safety', `Your safety diver is on the way down to meet you at ${this.meet} m.`);
        }
        if (d.phase === 'surface' || d.phase === 'done') this.state = 'done';
        break;
      case 'duck':
      case 'rescue':
        if (p.phase === 'duck') { if (this._duck(dt)) { p.phase = 'dive'; p.th = Math.PI; } break; }
        // head down along the line, kicking, toward the meeting depth (or to you)
        {
          const goal = this.state === 'rescue' ? (this.haul ? this.meet : d.depth - 0.3) : this.meet;
          const v = this.state === 'rescue' ? RESCUE : SPEED;
          p.vy = -v; p.y = Math.max(-goal, p.y - v * dt); p.x = ease(p.x, this.state === 'rescue' ? d.x - 0.55 : X, dt, 2);
          p.th = ease(p.th, Math.PI, dt, 3); this._kick(dt, -p.y < 12 || this.state === 'rescue');
          if ((d.t - p.nose) > 1.4) p.nose = d.t;   // equalizing every metre or so
          if (-p.y >= goal - 0.05) {
            if (this.state === 'rescue') { if (!this.haul || d.depth < this.meet + 0.8) { this.state = 'hold'; say('hold', 'Your safety has you: holding your airway, bringing you up.'); } }
            else { this.state = 'turn'; this.turnAt = d.t; }
          }
        }
        break;
      case 'turn':
        // a hand on the line, swing round to head up, and wait, facing you as you come up
        p.turnT = d.t - this.turnAt; p.vy = 0;
        p.th = Math.PI + Math.PI * smooth(clamp(p.turnT / 1.6, 0, 1));
        if (p.turnT > 1.6) { p.turnT = null; this.state = 'hang'; }
        break;
      case 'hang':
        p.th = ease(p.th, 2 * Math.PI, dt, 3); p.vy = 0; p.y = -this.meet + 0.05 * Math.sin(d.t * 1.3);
        if (d.y > p.y - 1.2 && (d.turned || d.depth < this.meet)) { this.state = 'escort'; say('met', `Safety at ${this.meet} m: eye contact, and up together.`); }
        break;
      case 'escort':
        // beside you, face to face, a touch above so it sees your face, kicking at your pace
        p.y = ease(p.y, Math.min(0, d.y + 0.2), dt, 4); p.vy = d.vy; p.x = ease(p.x, X, dt, 2);
        p.th = ease(p.th, 2 * Math.PI, dt, 3); this._kick(dt, d.depth > 6);
        if (d.phase === 'surface' || d.phase === 'done' || p.y > -0.3) { this.state = 'done'; }
        break;
      case 'hold':
        // holding you from behind your shoulder, mask on your face, bringing you up at 1 m/s
        this.holding = true;
        d.held = true;
        d.y = Math.min(0, d.y + UP * dt); d.x = ease(d.x, 0.35, dt, 2);
        p.y = d.y + 0.15; p.x = d.x - 0.55; p.vy = UP; p.th = ease(p.th, 2 * Math.PI, dt, 3); p.turnT = null;
        if (p.phase !== 'dive') p.phase = 'dive';
        this._kick(dt, true);
        if (d.y > -0.05) { this.state = 'done'; d.y = 0; say('surfaced', 'At the surface: your safety takes off your mask, blows across your face and talks you back.'); }
        break;
      case 'done':
        p.phase = 'surface'; p.turnT = null; p.y = ease(p.y, 0, dt, 2); p.th = ease(p.th, 0.15, dt, 2);
        p.x = ease(p.x, d.blackout ? d.x - 0.5 : X - 0.2, dt, 1);
        break;
    }
    this.fig.update(dt, p);
    const ev = this.events; this.events = []; return ev;
  }

  // its duck dive, mirrored from yours: it glides away from the line (toward -x) and folds forward,
  // turning counter-clockwise to head down
  _duck(dt) {
    const p = this.p, D = DUCK, T = (p.duckT += dt);
    const seg = (a, b) => smooth(clamp((T - a) / (b - a), 0, 1));
    p.x = lerp(this.duckFrom.x, X, seg(0, D.knife));
    p.y = this.duckFrom.y - (0.15 * seg(0, D.glide) + 0.35 * seg(D.glide, D.knife) + 0.5 * seg(D.knife, D.legs) + 0.9 * seg(D.legs, D.pull) + 0.6 * seg(D.pull, D.end));
    p.th = 0.1 + (Math.PI / 2 + 0.1) * seg(0, D.glide * 0.8) + (Math.PI / 2 - 0.05) * seg(D.glide, D.knife);
    return T >= D.end;
  }

  _kick(dt, on) {
    if (!on) return;
    this.kickAt -= dt;
    if (this.kickAt <= 0) { this.p.legs[this.side].at = this.p.t; this.p.legs[this.side].q = 1; this.side = 1 - this.side; this.kickAt = 0.45; }
  }
}

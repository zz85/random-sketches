// bot.js - a diver that plays the dive itself, for the tests and for ?demo: a calm breathe-up,
// a full breath and some packing, kicks (or pulls) on the beat until freefall, balance by
// leaning toward the line, Frenzel whenever the ears feel it, a mouthfill near the Frenzel limit,
// the turn at the plate, kicks up until the lift takes over, then hook breaths and the OK.
//
//   const bot = new Bot(dive, { pack: 6, breatheUp: 40 }); every frame: bot.update(dt); dive.step(dt)
//
// Options make it dive badly on purpose: `hyper` breathes hard and fast, `mash` kicks the same
// leg too fast, `noEq` never equalizes, `noBalance` never leans, `lazyBreath` never breathes at
// the surface, `noMouthfill`, `kickTo` the depth it stops kicking at going down.
import { BODY } from './sim.js';

export class Bot {
  constructor(dive, o = {}) {
    this.d = dive;
    this.o = { pack: 4, breatheUp: 40, inhale: 2.5, exhale: 6.5, kickGap: 0.45, pullGap: 0.75, ...o };
    this.t = 0; this.next = 0; this.side = 0; this.cycleAt = 0; this.dove = false; this.hookAt = 0;
  }

  update(dt) {
    const d = this.d, o = this.o;
    this.t += dt;
    if (d.phase !== 'dive' && this.release !== undefined) { d.dolphin(false); this.release = undefined; }
    if (d.phase === 'breathe') return this._breatheUp();
    if (d.phase === 'surface') {
      if (o.lazyBreath) return;
      if (d.hooks < 3 && this.t - this.hookAt > 1.2) { d.breath(true); d.breath(false); this.hookAt = this.t; }
      if (d.hooks >= 1 && d.okAt === null) d.ok();
      return;
    }
    if (d.phase !== 'dive' || d.blackout) return;

    const down = !d.turned && d.turnT === null;
    // ears: a Frenzel each time they press; a mouthfill on the way to the Frenzel limit
    if (!o.noEq && d.dP > 0.1) d.frenzel();
    if (!o.noMouthfill && down && !d.nm && d.lungV < d.frenzelLimit + 0.35 && d.depth > 8) d.mouthfill();
    if (down && (d.depth >= d.target - 0.6 || (d.dP > 0.2 && !d.canFrenzel))) d.turn();

    // balance: the body along the way it should go, an arm's length (0.3 m) off the line
    if (!o.noBalance && d.turnT === null) {
      const want = (down ? Math.PI : 0) + (down ? 1 : -1) * -(0.4 * (d.x - 0.3) + 3 * d.vx);
      const err = Math.atan2(Math.sin(d.th - want), Math.cos(d.th - want));   // the short way round
      d.setLean(-2.5 * err - 1.2 * d.om);
    }

    if (this.release !== undefined && this.t >= this.release) { d.dolphin(false); this.release = undefined; }
    // work: down until freefall, up until the lift carries you
    const net = d.netKg;
    const work = down ? (o.kickTo !== undefined ? d.depth < o.kickTo : net > -0.8 || d.speed < 0.5) : d.depth > 7 || d.vy < 0.3;
    d.setArms(down && net < -0.5 && d.discipline === 'CWT' ? 'sides' : 'ahead');
    if (work && d.turnT === null && this.t >= this.next) {
      if (d.discipline === 'FIM') { d.pull(this.side); this.next = this.t + o.pullGap; }
      else if (d.fins === 'mono') { d.dolphin(true); this.release = this.t + (o.hold || 0.35); this.next = this.t + (o.monoGap || 0.9); }
      else if (o.mash) { d.kick(0); this.next = this.t + 0.12; }
      else { d.kick(this.side); this.next = this.t + o.kickGap; }
      this.side = 1 - this.side;
    }
  }

  _breatheUp() {
    const d = this.d, o = this.o, inh = o.hyper ? 2.0 : o.inhale, exh = o.hyper ? 1.5 : o.exhale;
    if (this.t < o.breatheUp) {
      const c = (this.t - this.cycleAt);
      if (c >= inh + exh) this.cycleAt = this.t;
      const want = (this.t - this.cycleAt) < inh;
      if (want !== d.inhaling) d.breath(want);
      return;
    }
    // the last breath, to the top, then the packs, then down
    if (d.lung < BODY.TLC - 0.05 && !d.holding) { if (!d.inhaling) d.breath(true); return; }
    if (d.packed < 0.01 && o.pack === 0) { d.dive(); return; }
    if (this.packs === undefined) { this.packs = 0; this.packAt = this.t; }
    if (this.packs < o.pack) { if (this.t - this.packAt > 0.4) { d.pack(); this.packs++; this.packAt = this.t; } return; }
    if (this.t - this.packAt > (o.linger || 0.4)) d.dive();
  }
}

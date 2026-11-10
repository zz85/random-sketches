// node debug_race.js [day] : trace an AI race in the course frame.
global.self = global;
require('./data/land.js'); require('./data/days.js'); require('./data/polar.js');
const S = require('./sim.js');
const land = S.makeLand(self.SOUND_LAND), polar = S.makePolar(self.SOUND_POLAR), DATA = self.SOUND_DAYS;
const day = DATA.days[+(process.argv[2] || 0)];
const W = S.makeWind(day, land), cur = S.makeCurrent(day, DATA.stations, land);
const C = S.makeCourse(W.record(day.start).dir, 1, land, { laps: 2 }), R = S.newRace(C, { countdown: 180 });
const ais = Object.keys(S.STYLES).map((k, i) => ({ ai: S.newAI(k, Object.assign(C.fromCourse(-250, S.STYLES[k].spot), { hdg: S.wrap(C.axis - 45) })), e: S.newEntry(k) }));
const env = { wind: W, current: cur, land, t: 0, tGun: 0 }, dt = 1;
console.log(day.label, 'axis', C.axis.toFixed(0));
for (let tg = -R.countdown; tg < 4 * 3600; tg += dt) {
  env.t = day.start + tg * 1000; env.tGun = tg;
  for (const r of ais) {
    const p0 = { x: r.ai.b.x, y: r.ai.b.y };
    S.aiStep(r.ai, env, polar, R, r.e, dt);
    if (tg < 0 && tg + dt >= 0 && C.toCourse(r.ai.b).s > 0) r.e.ocs = true;
    const ev = S.advance(R, r.e, p0, r.ai.b, tg + dt);
    if (ev.length) console.log(tg, r.e.name, ev.join(','));
  }
  if ((tg % 120 === 0 || (tg < 100 && tg % 10 === 0)) && tg < 9000) console.log(tg, ais.map((r) => { const p = C.toCourse(r.ai.b); return `${r.e.name[0]} leg${r.e.leg}${r.e.ocs ? 'OCS' : ''} s${p.s.toFixed(0)} c${p.c.toFixed(0)} h${r.ai.b.hdg.toFixed(0)} twa${r.ai.b.twa.toFixed(0)} bs${r.ai.b.bs.toFixed(1)}`; }).join(' | '));
  if (ais.every((r) => r.e.finish != null)) break;
}

// node probe.js [target] [pack] [CWT|FIM] [opts json]: one bot dive, printed as it goes
import { Dive } from './sim.js';
import { Bot } from './bot.js';
const [target = 30, pack = 4, disc = 'CWT', opts = '{}'] = process.argv.slice(2);
const d = new Dive({ target: +target, discipline: disc, seed: 3 });
const bot = new Bot(d, { pack: +pack, ...JSON.parse(opts) });
const dt = 1 / 60; let last = -1;
for (let i = 0; i < 60 * 400 && d.phase !== 'done'; i++) {
  bot.update(dt); d.step(dt);
  for (const e of d.events.splice(0)) console.log(`${d.t.toFixed(1).padStart(6)}  ${e.text}`);
  if (d.phase !== 'breathe' && Math.floor(d.t / 5) !== last) {
    last = Math.floor(d.t / 5);
    console.log(`${d.t.toFixed(1).padStart(6)}  ${d.phase.padEnd(7)} d ${d.depth.toFixed(1).padStart(5)} v ${d.vy.toFixed(2).padStart(5)} th ${(d.th * 180 / Math.PI).toFixed(0).padStart(4)} x ${d.x.toFixed(2)} net ${d.netKg.toFixed(2)} lung ${d.lungV.toFixed(2)} dP ${d.dP.toFixed(2)} pO2 ${d.brain.toFixed(3)} f ${d.f.toFixed(3)} urge ${d.urge.toFixed(2)} str ${d.stream.toFixed(2)} q ${d.quality.toFixed(2)}`);
  }
}
console.log(JSON.stringify(d.result), 'relax', d.relax.toFixed(2), 'hypo', d.hypo.toFixed(2));

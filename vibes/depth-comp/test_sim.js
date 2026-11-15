// node test_sim.js - the dive's mechanics, headless: buoyancy, balance, finning, equalizing,
// packing, breathe-up, oxygen, and whole dives by the bot, good ones and bad ones.
import { Dive, BODY, KICK } from './sim.js';
import { Bot } from './bot.js';

let fails = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };
const dt = 1 / 60;
// `ears` keeps them equalized, for the tests that are about something else
const run = (d, sec, each, ears = true) => { for (let t = 0; t < sec && d.phase !== 'done'; t += dt) { each?.(t); if (ears) d.Pe = d.P; d.step(dt); } };
const play = (opts, bo = {}) => {
  const d = new Dive({ seed: 3, ...opts }), bot = new Bot(d, bo);
  let minO2 = 9;
  for (let i = 0; i < 60 * 600 && d.phase !== 'done'; i++) { bot.update(dt); d.step(dt); if (d.phase === 'surface' || d.phase === 'dive') minO2 = Math.min(minO2, d.brain); }
  return { d, r: d.result, minO2 };
};
// a diver placed in the water, head down, still
const placed = (depth, gas = BODY.TLC, o = {}) => {
  const d = new Dive({ target: 100, seed: 5, ...o });
  d._hold(); d.nL = gas; d.phase = 'dive'; d.y = -depth; d.th = Math.PI; d.x = 0; d.Pe = d.P;
  return d;
};

// ---- buoyancy
{
  const d = placed(0); const nd = d.neutralDepth;
  check(nd > 10 && nd < 13, `full lungs: neutral at ${nd.toFixed(1)} m`);
  const p = placed(0, BODY.TLC + 2);
  check(p.neutralDepth > nd + 4, `2 L packed: neutral deeper, at ${p.neutralDepth.toFixed(1)} m`);
}

// ---- freefall: from 25 m the body falls head first at a steady speed; your balance wanders, so
// left alone it tilts off the line, and small leans keep it straight
{
  const fall = (balance) => {
    const d = placed(25); d.vy = -0.6; d.setArms('sides'); let maxOff = 0;
    run(d, 12, () => { if (balance) d.setLean(-2.5 * (d.th - Math.PI) - 1.2 * d.om); maxOff = Math.max(maxOff, Math.abs(d.th - Math.PI)); });
    return { d, off: maxOff * 180 / Math.PI };
  };
  const b = fall(true), n = fall(false);
  check(b.d.vy < -0.6 && b.d.vy > -1.3, `freefall: ${(-b.d.vy).toFixed(2)} m/s at ${b.d.depth.toFixed(0)} m`);
  check(b.off < 12 && n.off > 15, `freefall: balanced, within ${b.off.toFixed(0)} deg of straight down; left alone, ${n.off.toFixed(0)} deg off`);
}

// ---- balance: still and slow in the shallows, head down is unstable; head up is stable
{
  const a = placed(3); a.th = Math.PI + 0.05; run(a, 10);
  check(Math.abs(a.th - Math.PI) > 0.5, `head down and still at 3 m, the body rolls over (${(a.th * 180 / Math.PI).toFixed(0)} deg)`);
  const b = placed(3); b.th = 0.05; run(b, 6);
  check(Math.abs(b.th) < 0.3, `head up and still, it stays up (${(b.th * 180 / Math.PI).toFixed(0)} deg)`);
  const c = placed(3); c.th = Math.PI; run(c, 1, () => c.setLean(1)); c.setLean(0);
  check(c.th > Math.PI + 0.1, `leaning turns the body (${((c.th - Math.PI) * 180 / Math.PI).toFixed(0)} deg in 1 s)`);
}

// ---- finning: alternating on the beat beats mashing and same-leg kicks, metre for metre
{
  const fin = (pattern) => {
    const d = placed(5, BODY.TLC); d.vy = -0.5; const y0 = d.y; let o0 = d.o2Used;
    let n = 0; run(d, 10, (t) => { if (t >= n * pattern.gap) { d.kick(pattern.leg(n)); n++; } d.setLean(-2.5 * (d.th - Math.PI) - 1.2 * d.om); });
    return { m: y0 - d.y, o2: (d.o2Used - o0), q: d.quality };
  };
  const good = fin({ gap: KICK.ideal, leg: (n) => n % 2 });
  const mash = fin({ gap: 0.12, leg: (n) => n % 2 });
  const same = fin({ gap: KICK.ideal, leg: () => 0 });
  check(good.m > 7, `flutter on the beat: ${good.m.toFixed(1)} m in 10 s (quality ${good.q.toFixed(2)})`);
  check(mash.m < good.m * 0.8 && mash.o2 / Math.max(mash.m, 0.1) > 1.5 * good.o2 / good.m, `mashing: ${mash.m.toFixed(1)} m, ${(1000 * mash.o2 / Math.max(mash.m, 0.1)).toFixed(0)} ml O2 a metre against ${(1000 * good.o2 / good.m).toFixed(0)}`);
  check(same.m < good.m * 0.7, `the same leg every time: ${same.m.toFixed(1)} m`);
}

// ---- equalizing
{
  // Frenzel works until the lungs reach the Frenzel limit, deeper with packed lungs
  const limit = (gas) => { const d = placed(0, gas); for (let m = 1; m < 60; m++) { d.y = -m; const r = d.frenzel(); d.nose = -9; if (!r || r.eff <= 0) return m; } return 60; };
  const l0 = limit(BODY.TLC), l2 = limit(BODY.TLC + 2.5);
  check(l0 >= 18 && l0 <= 24, `Frenzel limit with full lungs: ${l0} m`);
  check(l2 >= l0 + 8, `with 2.5 L packed: ${l2} m`);
  // a mouthfill taken before the limit carries the Frenzel deeper; taken too deep it is small
  const reach = (at) => { const d = placed(at); d.mouthfill(); d.nose = -9; for (let m = at; m < 120; m++) { d.y = -m; const r = d.frenzel(); d.nose = -9; if (!r || r.eff <= 0) return m; } return 120; };
  const r15 = reach(15), r21 = reach(21), r6 = reach(6);
  check(r15 > l0 + 20, `mouthfill at 15 m equalizes to ${r15} m`);
  check(r15 > r6 && r15 > r21, `best taken near the limit: from 6 m ${r6} m, from 15 m ${r15} m, from 21 m ${r21} m`);
  const late = placed(32); check(late.mouthfill().fill === 0, 'no mouthfill at 32 m on full lungs: nothing left to give');
  // Valsalva: fine head up at the surface, weak head down, worse deeper; it blows a mouthfill
  const v1 = placed(2); v1.th = 0; v1.Pe = 1; const e1 = v1.valsalva().eff;
  const v2 = placed(2); v2.Pe = 1; const e2 = v2.valsalva().eff;
  const v3 = placed(15); v3.Pe = 1; v3.th = 0; const e3 = v3.valsalva().eff;
  check(e1 > 0.8 && e2 < 0.4 && e3 < e1 * 0.5, `Valsalva: head up ${e1.toFixed(2)}, head down ${e2.toFixed(2)}, at 15 m ${e3.toFixed(2)}`);
  const v4 = placed(15); v4.mouthfill(); v4.nose = -9; v4.valsalva(); check(v4.nm === 0, 'Valsalva loses the mouthfill');
  // packed lungs make the first Frenzels weak
  const pk = placed(1, BODY.TLC + 2.5); pk.Pe = 1; check(pk.frenzel().eff < 0.6, 'overpacked: a stiff throat, weak Frenzel near the surface');
}

// ---- pain: unequalized ears hurt; pain slows and weakens kicks and burns oxygen; forced deeper,
// the eardrum gives way and vertigo spins you
{
  const kicks = (pe) => {
    const d = placed(8); d.vy = -0.5; const y0 = d.y, o0 = d.o2Used; let n = 0;
    for (let t = 0; t < 6; t += dt) { if (t >= n * KICK.ideal) { d.kick(n % 2); n++; } d.setLean(-2.5 * (d.th - Math.PI) - 1.2 * d.om); d.Pe = pe(d); d.step(dt); }
    return { m: y0 - d.y, o2: d.o2Used - o0, pain: d.pain };
  };
  const ok = kicks((d) => d.P), sore = kicks((d) => d.P - 0.35);
  check(sore.pain > 0.5 && sore.m < ok.m * 0.75 && sore.o2 > ok.o2 * 1.3, `ears 3.5 m behind: pain ${sore.pain.toFixed(2)}, ${sore.m.toFixed(1)} m in 6 s against ${ok.m.toFixed(1)}, ${(sore.o2 * 1000).toFixed(0)} ml O2 against ${(ok.o2 * 1000).toFixed(0)}`);
  const d = placed(5); d.vy = -1; let at = null;
  for (let t = 0; t < 20 && !d.injury; t += dt) { d.vy = Math.min(d.vy, -0.8); d.step(dt); }
  at = d.depth;
  check(/eardrum/.test(d.injury || '') && d.vertigo > 0.9 && d.dP < 0.01, `forced down unequalized: the eardrum goes at ${at.toFixed(1)} m, vertigo ${d.vertigo.toFixed(2)}`);
  const f0 = d.f; run(d, 5, null, false); const b = placed(at); const g0 = b.f; run(b, 5, null, false);
  check(f0 - d.f > 1.5 * (g0 - b.f), `in pain and spinning, oxygen goes ${((f0 - d.f) / (g0 - b.f)).toFixed(1)}x as fast`);
}

// ---- the breathe-up
{
  const calm = new Dive(), fast = new Dive();
  new Bot(calm); const bf = new Bot(fast, { hyper: true }), bc = new Bot(calm);
  for (let t = 0; t < 40; t += dt) { bc.update(dt); calm.step(dt); bf.update(dt); fast.step(dt); }
  check(calm.relax > 0.5 && calm.hypo < 0.1, `slow breathing: relaxed (${calm.relax.toFixed(2)}), CO2 normal (${calm.hypo.toFixed(2)}), ${calm.breathRate} breaths a minute`);
  check(fast.hypo > 0.15 && fast.relax < calm.relax, `fast and deep: hypocapnia ${fast.hypo.toFixed(2)}, relax ${fast.relax.toFixed(2)}`);
  calm._hold(); fast._hold();
  check(fast.urge < calm.urge - 0.05 && fast.threshold > calm.threshold, `hyperventilated: the urge starts lower (${fast.urge.toFixed(2)} vs ${calm.urge.toFixed(2)}) and the blackout line higher`);
  const d = new Dive(); d.breath(true); run(d, 6); check(d.lung >= BODY.TLC - 0.01, `holding Breathe fills the lungs (${d.lung.toFixed(1)} L)`);
  for (let i = 0; i < 40; i++) d.pack();
  check(d.packed > 2.8 && d.packed <= BODY.PACK, `packing adds ${d.packed.toFixed(2)} L, less each time`);
  const e = new Dive(); e.breath(true); run(e, 1); e.breath(false); check(!e.pack(), 'no packing on a half breath');
}

// ---- whole dives
{
  const a = play({ target: 30 }, { pack: 6 });
  check(a.r.card === 'white' && a.r.tag, `30 m CWT by the bot: ${a.r.card} card, ${a.r.time.toFixed(0)} s, lowest PO2 ${a.minO2.toFixed(3)}`);
  const f = play({ target: 30, discipline: 'FIM' }, { pack: 6 });
  check(f.r.card === 'white' && f.r.tag, `30 m FIM: ${f.r.card}, ${f.r.time.toFixed(0)} s`);
  const deep = play({ target: 60 }, { pack: 20 });
  check(deep.r.card === 'white' && deep.r.tag, `60 m with a big pack and a mouthfill: ${deep.r.card} (${deep.r.notes.join(', ')})`);
  const nm = play({ target: 50 }, { pack: 6, noMouthfill: true });
  check(!nm.r.tag && nm.r.depth < 40, `50 m without a mouthfill: turned at the Frenzel limit, ${nm.r.depth} m`);
  const ne = play({ target: 30 }, { noEq: true });
  check(!ne.r.tag && ne.r.depth < 10 && ne.r.o2 > a.r.o2, `never equalizing: the pain stops you at ${ne.r.depth} m, and burns ${(ne.r.o2 * 1000).toFixed(0)} ml`);
  const nb = play({ target: 30 }, { noBalance: true });
  check(!nb.r.tag || (nb.d.tugs >= 3 && nb.r.o2 > a.r.o2 && a.d.tugs <= 1), `never balancing: off the line ${nb.d.tugs} times, ${nb.r.depth} m, ${(nb.r.o2 * 1000).toFixed(0)} ml O2`);
  const ms = play({ target: 30 }, { mash: true });
  check(ms.r.card === 'red' || !ms.r.tag, `mashing one leg: ${ms.r.depth} m, ${ms.r.notes[0] || ms.r.card}`);
  const lz = play({ target: 30 }, { lazyBreath: true });
  check(lz.r.card === 'red', `no breath and no OK at the surface: ${lz.r.notes.join(', ')}`);
  const pk = play({ target: 30 }, { pack: 30, linger: 10 });
  check(/packing/.test(pk.r.notes.join()), `packed full and lingering: ${pk.r.notes[0]}`);
  const pq = play({ target: 30 }, { pack: 30 });
  check(pq.r.tag && pq.r.o2 > a.r.o2, `packed full and away at once: makes it, burning more (${(pq.r.o2 * 1000).toFixed(0)} ml vs ${(a.r.o2 * 1000).toFixed(0)})`);
  const mono = play({ target: 30, fins: 'mono' }, { pack: 6 });
  check(mono.r.card === 'white' && mono.r.time < a.r.time - 3 && mono.r.o2 < a.r.o2 * 0.9, `monofin, dolphin kick: ${mono.r.time.toFixed(0)} s and ${(mono.r.o2 * 1000).toFixed(0)} ml, against bifins ${a.r.time.toFixed(0)} s and ${(a.r.o2 * 1000).toFixed(0)} ml`);
  const long2 = play({ target: 30, fins: 'mono' }, { pack: 6, hold: 0.7 }), snatch = play({ target: 30, fins: 'mono' }, { pack: 6, hold: 0.2 });
  check(long2.r.o2 > mono.r.o2 * 1.2 && snatch.r.o2 > mono.r.o2 * 1.2, `monofin: holding the downstroke 0.7 s costs ${(long2.r.o2 * 1000).toFixed(0)} ml, snatching it ${(snatch.r.o2 * 1000).toFixed(0)}`);
  const free = play({ target: 30, lanyard: false }, { pack: 6, noBalance: true });
  check(free.d.tugs === 0 && /lanyard/.test(free.r.notes.join()), `no lanyard: no tugs, ${free.r.notes.join(', ')}`);
  { const d = placed(20); d.x = 1.5; check(!d.turn(), 'the turn needs the line in reach'); }
  const long = play({ target: 80 }, { pack: 20 });
  check(!long.r.tag, `80 m on the same lungs: ${long.r.notes[0]}`);
}

console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);

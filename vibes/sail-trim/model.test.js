// node --test model.test.js
const test = require('node:test'), assert = require('node:assert');
const M = require('./model.js');
const env = (tws, twa) => ({ tws: tws * M.KN, twa });
const kn = (s) => s.bs / M.KN;

test('no-go zone: pointing at the wind stops the boat', () => {
  const s = M.steady(M.defaultControls(), env(12, 15));
  assert.ok(kn(s) < 1, `bs ${kn(s)}`);
});
test('close-hauled speed and heel are plausible for a 30 footer', () => {
  const p = M.PRESETS.medium, e = env(p.tws, p.twa), s = M.steady(M.autoTrim(p.c, e), e);
  assert.ok(kn(s) > 4.5 && kn(s) < 6.5, `bs ${kn(s)}`);
  assert.ok(s.heel > 8 && s.heel < 25, `heel ${s.heel}`);
});
test('auto-trim never makes it slower', () => {
  for (const p of Object.values(M.PRESETS)) {
    const e = env(p.tws, p.twa), a = M.score(p.c, e).value, b = M.score(M.autoTrim(p.c, e), e).value;
    assert.ok(b >= a - 1e-6, `${p.label}: ${a} -> ${b}`);
  }
});
test('over-trimming the main stalls it, easing it out luffs it', () => {
  const f = (ms) => M.forces(Object.assign(M.defaultControls(), { mainsheet: ms, traveler: 0 }), { tws: 6, twa: 90, bs: 3 }, 5).flow.main[1].state;
  assert.equal(f(0), 'stall');
  assert.ok(['luff', 'flog'].includes(f(1)));
});
test('backstay flattens the main and cuts jib sag', () => {
  const a = M.shape(Object.assign(M.defaultControls(), { backstay: 0 }), 15), b = M.shape(Object.assign(M.defaultControls(), { backstay: 1 }), 15);
  assert.ok(b.main.sections[2].camber < a.main.sections[2].camber);
  assert.ok(b.jib.sag < a.jib.sag && b.main.twist > a.main.twist);
});
test('cunningham pulls the main draft forward; outhaul flattens the foot', () => {
  const base = M.defaultControls();
  assert.ok(M.shape(Object.assign({}, base, { cunningham: 1 }), 15).main.draft < M.shape(base, 15).main.draft);
  assert.ok(M.shape(Object.assign({}, base, { outhaul: 1 }), 15).main.sections[0].camber < M.shape(Object.assign({}, base, { outhaul: 0 }), 15).main.sections[0].camber);
});
test('vang holds the leech once the sheet is eased', () => {
  const eased = { mainsheet: 0.5 };
  assert.ok(M.shape(Object.assign(M.defaultControls(), eased, { vang: 0.9 }), 12).main.twist < M.shape(Object.assign(M.defaultControls(), eased, { vang: 0 }), 12).main.twist - 8);
});
test('depowering in a breeze reduces heel', () => {
  const e = env(21, 42), hard = M.steady(M.PRESETS.medium.c, e), dep = M.steady(M.PRESETS.breezy.c, e);
  assert.ok(dep.heel < hard.heel, `${dep.heel} vs ${hard.heel}`);
});
test('jib lead: top luffs first with the car aft', () => {
  const f = M.forces(Object.assign(M.defaultControls(), { jibLead: -1 }), { tws: 6, twa: 42, bs: 2.8 }, 10);
  assert.ok(f.flow.jib[2].alpha < f.flow.jib[0].alpha - 4);
});
test('a bigger boat is stiffer and faster for the same trim', () => {
  const e = env(14, 42), c = M.PRESETS.medium.c;
  M.setBoat(22); const small = M.steady(c, e);
  M.setBoat(45); const big = M.steady(c, e);
  M.setBoat(M.BASE.loa);
  assert.ok(big.heel < small.heel && kn(big) > kn(small), `22ft ${kn(small)} kn ${small.heel} deg, 45ft ${kn(big)} kn ${big.heel} deg`);
});
test('auto-trim reefs in a gale but not in light air, and the reef keeps her on her feet', () => {
  const e = env(26, 44), c = M.autoTrim(M.PRESETS.breezy.c, e);
  assert.ok(c.reef >= 1, `reef ${c.reef}`);
  assert.ok(M.steady(Object.assign({}, c, { reef: 0 }), e).heel > M.steady(c, e).heel + 2);
  assert.equal(M.autoTrim(M.PRESETS.light.c, env(6, 44)).reef, 0);
});
test('downwind the kite gains about what ORC gives a 30 ft masthead boat over jib alone; the spinnaker goes deeper than the gennaker', () => {
  // ORC Club vs non-spinnaker certificates of an S2 9.1 at 12 kn: jib alone 5% slower at 120 deg, 9% at 150
  const best = (head, twa) => { const e = env(12, twa); return kn(M.steady(M.autoTrim(Object.assign(M.defaultControls(), { head, mainsheet: 0.6, spinSheet: 0.6, spinPole: 0.7 }), e), e)); };
  for (const twa of [120, 150]) {
    const loss = 1 - best('jib', twa) / best('spin', twa);
    assert.ok(loss > 0.02 && loss < 0.14, `${twa}: jib ${(loss * 100).toFixed(1)}% slower`);
  }
  assert.ok(best('gen', 120) > best('jib', 120));
  assert.ok(best('spin', 170) > best('gen', 170));
});
test('matches the Catalina 30 ORC polar at a few points', () => {
  const O = require('./calib/orc-catalina30.js'), i = (t) => O.tws.indexOf(t);
  const at = (tws, twa, head, target) => {
    const e = Object.assign(env(tws, twa), { bs: target * M.KN });
    const c = M.autoTrim(Object.assign(M.defaultControls(), { head, mainsheet: twa > 90 ? 0.6 : 0.06, jibSheet: twa > 90 ? 0.7 : 0.1, spinSheet: 0.6, spinPole: 0.7 }), e);
    const v = kn(M.steady(c, e));
    assert.ok(Math.abs(v / target - 1) < 0.07, `${tws} kn ${twa} deg: ${v.toFixed(2)} vs ORC ${target.toFixed(2)}`);
  };
  for (const t of [6, 12, 20]) at(t, O.beatAngle[i(t)], 'jib', O.beatVmg[i(t)] / Math.cos(O.beatAngle[i(t)] * M.D));
  at(12, 60, 'jib', O.speeds['60'][i(12)]);
  at(12, 120, 'spin', O.speeds['120'][i(12)]);
  at(16, 150, 'spin', O.speeds['150'][i(16)]);
});
test('spinnaker pole: squared back on a run is faster than at the forestay', () => {
  const e = env(14, 165), c = M.PRESETS.spinRun.c;
  assert.ok(kn(M.steady(Object.assign({}, c, { spinPole: 0.75 }), e)) > kn(M.steady(Object.assign({}, c, { spinPole: 0.05 }), e)) + 0.3);
});
test('a kite collapses close-hauled', () => {
  const f = M.forces(Object.assign(M.defaultControls(), { head: 'spin' }), { tws: 6, twa: 45, bs: 3 }, 5);
  assert.ok(f.flow.head.every((x) => x.state === 'luff' || x.state === 'flog'));
});
test('auto-trim on a jib run finds the same trim from sheeted-in, and wings the jib out dead downwind', () => {
  for (const twa of [150, 170]) {
    const e = env(12, twa), from = (p) => kn(M.steady(M.autoTrim(Object.assign({}, M.PRESETS[p].c, { head: 'jib' }), e), e));
    assert.ok(Math.abs(from('medium') - from('run')) < 0.15, `${twa}: ${from('medium')} vs ${from('run')}`);
  }
  const e = env(12, 172), c = M.autoTrim(M.PRESETS.medium.c, e);
  assert.equal(c.wing, true);
  assert.ok(kn(M.steady(c, e)) > kn(M.steady(Object.assign({}, c, { wing: false }), e)));
});

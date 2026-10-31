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
  const p = M.PRESETS.medium, s = M.steady(p.c, env(p.tws, p.twa));
  assert.ok(kn(s) > 4.5 && kn(s) < 7, `bs ${kn(s)}`);
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
  M.setBoat(30);
  assert.ok(big.heel < small.heel && kn(big) > kn(small), `22ft ${kn(small)} kn ${small.heel} deg, 45ft ${kn(big)} kn ${big.heel} deg`);
});
test('reefing cuts heel; auto-trim reefs in a gale but not in light air', () => {
  const e = env(26, 44), c = M.PRESETS.breezy.c;
  assert.ok(M.steady(Object.assign({}, c, { reef: 2 }), e).heel < M.steady(Object.assign({}, c, { reef: 0 }), e).heel - 3);
  assert.ok(M.autoTrim(c, e).reef >= 1);
  assert.equal(M.autoTrim(M.PRESETS.light.c, env(6, 44)).reef, 0);
});
test('downwind, a kite beats the jib; the spinnaker goes deeper than the gennaker', () => {
  const best = (head, twa) => { const e = env(12, twa); return kn(M.steady(M.autoTrim(Object.assign(M.defaultControls(), { head, mainsheet: 0.6 }), e), e)); };
  assert.ok(best('spin', 150) > best('jib', 150) + 0.5);
  assert.ok(best('gen', 120) > best('jib', 120) + 0.5);
  assert.ok(best('spin', 170) > best('gen', 170));
});
test('spinnaker pole: squared back on a run is faster than at the forestay', () => {
  const e = env(14, 165), c = M.PRESETS.spinRun.c;
  assert.ok(kn(M.steady(Object.assign({}, c, { spinPole: 0.75 }), e)) > kn(M.steady(Object.assign({}, c, { spinPole: 0.05 }), e)) + 0.3);
});
test('a kite collapses close-hauled', () => {
  const f = M.forces(Object.assign(M.defaultControls(), { head: 'spin' }), { tws: 6, twa: 45, bs: 3 }, 5);
  assert.ok(f.flow.head.every((x) => x.state === 'luff' || x.state === 'flog'));
});

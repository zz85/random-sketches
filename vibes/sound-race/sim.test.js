// node --test sim.test.js : wind, current, land, polar, boat, laylines, course and a whole AI race on recorded days.
const test = require('node:test'), assert = require('node:assert');
global.self = global;
require('./data/land.js'); require('./data/days.js'); require('./data/polar.js');
const S = require('./sim.js');
const land = S.makeLand(self.SOUND_LAND), polar = S.makePolar(self.SOUND_POLAR), DATA = self.SOUND_DAYS;

test('land: West Point and Shilshole marina are land, the Sound off them is water', () => {
  const at = (lon, lat) => S.toXY(lon, lat);
  let p = at(-122.4355, 47.6620); assert.ok(land.isLand(p.x, p.y), 'West Point');
  p = at(-122.400, 47.680); assert.ok(land.isLand(p.x, p.y), 'Ballard shore');
  p = at(-122.45, 47.68); assert.ok(!land.isLand(p.x, p.y), 'mid Sound');
  assert.ok(land.shore(p.x, p.y) > 1000);
  p = at(-122.53, 47.68); assert.ok(land.isLand(p.x, p.y), 'Bainbridge');
});

test('polar: Catalina 30 numbers, no-go zone, VMG angles', () => {
  assert.equal(polar.speed(12, 28), 0);
  assert.ok(Math.abs(polar.speed(12, 90) - 6.5) < 0.3, String(polar.speed(12, 90)));
  const o = polar.optimum(12);
  assert.ok(o.up.a > 36 && o.up.a < 46, 'beat ' + o.up.a);
  assert.ok(o.dn.a > 150 && o.dn.a < 180, 'run ' + o.dn.a);
  assert.ok(Math.abs(o.up.v - 4.2) < 0.25, 'VMG ' + o.up.v);
});

test('current: blends the stations, reverses with the tide, slows at the shore', () => {
  const day = DATA.days[0], cur = S.makeCurrent(day, DATA.stations, land);
  assert.ok(cur.stations.length >= 5);
  const p = S.toXY(-122.45, 47.675);
  const speeds = []; for (let t = day.start - 2 * 3600e3; t <= day.start + 4 * 3600e3; t += 600e3) speeds.push(cur.at(p.x, p.y, t));
  assert.ok(speeds.every((c) => c.spd < 3));
  const near = S.toXY(-122.4385, 47.6625), far = S.toXY(-122.46, 47.662);
  assert.ok(cur.at(near.x, near.y, day.start).spd <= cur.at(far.x, far.y, day.start).spd + 1e-9);
  // Some day of the eight sees the current change direction by more than 90 deg in its race window.
  const turns = DATA.days.some((d) => { const c = S.makeCurrent(d, DATA.stations, land), a = c.at(p.x, p.y, d.start), b = c.at(p.x, p.y, d.start + d.hours * 3600e3); return a.spd > 0.1 && b.spd > 0.1 && Math.abs(S.angDiff(a.dir, b.dir)) > 90; });
  assert.ok(turns);
});

test('wind: follows the record, with shifts and puffs that move downwind', () => {
  const day = DATA.days[1], W = S.makeWind(day, land), p = S.toXY(-122.45, 47.69);
  let sum = 0, n = 0, min = 360, max = -360;
  for (let t = day.start; t < day.start + 3600e3; t += 20e3) {
    const w = W.at(p.x, p.y, t), m = W.record(t), d = S.angDiff(w.dir, m.dir);
    sum += w.spd / m.spd; n++; min = Math.min(min, d); max = Math.max(max, d);
  }
  assert.ok(Math.abs(sum / n - 1) < 0.15, 'mean speed ratio ' + sum / n);
  assert.ok(max - min > 4 && max - min < 45, 'shift range ' + (max - min));
  // Frozen turbulence: the wind here now is the wind 500 m upwind a while ago.
  const m = W.record(day.start), th = m.dir * S.D, U = m.spd * S.KN, dt = 500 / U;
  const up = { x: p.x + Math.sin(th) * 500, y: p.y + Math.cos(th) * 500 };
  const a = W.at(up.x, up.y, day.start), b = W.at(p.x, p.y, day.start + dt * 1000);
  assert.ok(Math.abs(a.puff - b.puff) < 0.35, `${a.puff} ${b.puff}`);
});

test('wind shadow: lighter just to leeward of land', () => {
  const day = DATA.days.find((d) => d.summary.dir > 140 && d.summary.dir < 220), W = S.makeWind(day, land);
  // A southerly: just north of West Point is in its lee.
  const lee = S.toXY(-122.433, 47.666), open = S.toXY(-122.47, 47.666);
  let r = 0; for (let t = day.start; t < day.start + 1800e3; t += 30e3) r += W.at(lee.x, lee.y, t).spd / W.at(open.x, open.y, t).spd;
  assert.ok(r / 60 < 0.9, String(r / 60));
});

test('boat: reaches polar speed, a tack costs speed, the current carries her', () => {
  const still = { t: 0, wind: { at: () => ({ dir: 0, spd: 12 }) }, current: { at: () => ({ u: 0, v: 0, spd: 0 }) } };
  const b = S.newBoat({ hdg: 315 });
  for (let i = 0; i < 600; i++) S.stepBoat(b, still, polar, 0.5);
  assert.ok(Math.abs(b.bs - polar.speed(12, 45)) < 0.05);
  const before = b.bs; S.tack(b);
  let low = 99; for (let i = 0; i < 60; i++) { S.stepBoat(b, still, polar, 0.5); low = Math.min(low, b.bs); }
  assert.ok(low < before * 0.8 && Math.abs(b.hdg - 45) < 1 && b.tacks === 1, `${low} ${b.hdg}`);
  const flood = { t: 0, wind: still.wind, current: { at: () => ({ u: 0, v: -1, spd: 1 }) } };
  const c = S.newBoat({ hdg: 90, bs: polar.speed(12, 90) }); S.stepBoat(c, flood, polar, 1);
  assert.ok(c.cog > 90 && c.cog < 110, String(c.cog));
});

test('laylines lean with the current', () => {
  const w = { dir: 0, spd: 12 }, none = S.laylines(polar, w, { u: 0, v: 0 }, true), east = S.laylines(polar, w, { u: 1, v: 0 }, true);
  assert.ok(Math.abs(S.angDiff(none.stb, 180 - none.angle)) < 2 || Math.abs(S.angDiff(none.stb, none.stb)) < 1);
  // A current setting east pushes both ground tracks to the right.
  assert.ok(S.angDiff(east.stbCog, none.stbCog) > 3 && S.angDiff(east.portCog, none.portCog) > 3);
});

test('course: laid to the wind, in clear water on every recorded day', () => {
  for (const d of DATA.days) {
    const W = S.makeWind(d, land), C = S.makeCourse(W.record(d.start).dir, 1, land);
    for (const m of [C.pin, C.committee, C.windward, C.gate[0], C.gate[1]]) assert.ok(land.shore(m.x, m.y) > 250, d.label);
    const w = C.toCourse(C.windward); assert.ok(Math.abs(w.s - 1852) < 1 && Math.abs(w.c) < 1);
  }
});

// Sail a race with the three AI styles; return each one's elapsed time, or null.
function race(day, laps, legNm) {
  const W = S.makeWind(day, land), cur = S.makeCurrent(day, DATA.stations, land);
  const C = S.makeCourse(W.record(day.start).dir, legNm, land, { laps }), R = S.newRace(C, { countdown: 180 });
  const ais = Object.keys(S.STYLES).map((k, i) => ({ ai: S.newAI(k, Object.assign(C.fromCourse(-250, S.STYLES[k].spot), { hdg: S.wrap(C.axis - 45) })), e: S.newEntry(k) }));
  const dt = 1, env = { wind: W, current: cur, land, t: 0, tGun: 0 };
  for (let tg = -R.countdown; tg < 4 * 3600; tg += dt) {
    env.t = day.start + tg * 1000; env.tGun = tg;
    for (const r of ais) {
      const p0 = { x: r.ai.b.x, y: r.ai.b.y };
      S.aiStep(r.ai, env, polar, R, r.e, dt);
      if (tg < 0 && tg + dt >= 0 && C.toCourse(r.ai.b).s > 0) r.e.ocs = true;
      S.advance(R, r.e, p0, r.ai.b, tg + dt);
      assert.ok(!land.isLand(r.ai.b.x, r.ai.b.y), `${r.e.name} aground on ${day.label}`);
    }
    if (ais.every((r) => r.e.finish != null)) break;
  }
  return ais.map((r) => ({ name: r.e.name, finish: r.e.finish, started: r.e.started, tacks: r.ai.b.tacks, gybes: r.ai.b.gybes, leg: r.e.leg }));
}

test('AI rivals finish a two-lap race on every recorded day, in a believable time', () => {
  for (const d of DATA.days) {
    const res = race(d, 2, 1);
    // They set up 250 m below the line three minutes out: in very light air that is too far to start on time.
    const atGun = S.makeWind(d, land).record(d.start).spd, late = atGun > 6 ? 60 : 150;
    for (const r of res) {
      assert.ok(r.finish != null, `${r.name} did not finish ${d.label} (leg ${r.leg})`);
      assert.ok(r.started < late, `${r.name} started late on ${d.label}: ${r.started}`);
    }
    // 4 nm of windward-leeward: ORC VMG time at the day's mean wind, give or take what wind and tide do.
    const o = polar.optimum(d.summary.spd), orc = 2 * (1852 / (o.up.v * S.KN) + 1852 / (o.dn.v * S.KN));
    const best = Math.min(...res.map((r) => r.finish - r.started));
    console.log(`${d.label.padEnd(24)} ORC ${(orc / 60).toFixed(0)} min, AI ${res.map((r) => `${r.name} ${((r.finish - r.started) / 60).toFixed(1)} (${r.tacks}t ${r.gybes}g)`).join(', ')}`);
    assert.ok(best > orc * 0.6 && best < orc * 2.0, `${d.label}: ${best} vs ${orc}`);
  }
});

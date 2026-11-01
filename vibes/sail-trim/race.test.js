// node --test race.test.js
const test = require('node:test'), assert = require('node:assert');
const R = require('./race.js');

// Drive a race along waypoints, a step every 2 m.
function sail(r, pts, headingTurns) {
  const ev = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
    for (let k = 0; k < n; k++) {
      const p0 = { x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n }, p1 = { x: a.x + (b.x - a.x) * (k + 1) / n, y: a.y + (b.y - a.y) * (k + 1) / n };
      ev.push(...R.update(r, p0, p1, 1, (headingTurns && headingTurns[i]) ? headingTurns[i] / n : 0));
    }
  }
  return ev.map((e) => e.type);
}

test('segment crossing and its direction', () => {
  const a = { x: -1, y: 0 }, b = { x: 1, y: 0 };
  assert.equal(R.crosses(a, b, { x: 0, y: -1 }, { x: 0, y: 1 }), 1);
  assert.equal(R.crosses(a, b, { x: 0, y: 1 }, { x: 0, y: -1 }), -1);
  assert.equal(R.crosses(a, b, { x: 2, y: -1 }, { x: 2, y: 1 }), 0);
});

test('one lap: start, round the windward mark to port, finish', () => {
  const c = R.makeCourse({ legNm: 0.25, laps: 1 }), r = R.newRace(c, { countdown: 20 }), L = c.L;
  const ev = sail(r, [{ x: 0, y: -50 }, { x: 0, y: -20 }, { x: 10, y: 20 }, { x: 15, y: L + 10 }, { x: -15, y: L + 10 }, { x: -5, y: 10 }, { x: 0, y: -20 }]);
  assert.deepEqual(ev.filter((e) => e !== 'signal'), ['gun', 'started', 'rounded', 'finished']);
  assert.equal(r.phase, 'finished');
  assert.ok(r.finish > 0 && r.started >= 0);
});

test('rounding the windward mark the wrong way round does not count', () => {
  const c = R.makeCourse({ legNm: 0.25 }), r = R.newRace(c, { countdown: 1 }), L = c.L;
  sail(r, [{ x: 0, y: -10 }, { x: 0, y: 10 }, { x: -15, y: L + 10 }, { x: 15, y: L + 10 }, { x: 5, y: 10 }, { x: 0, y: -20 }]);
  assert.equal(r.phase, 'racing');
  assert.equal(c.legs[r.leg], 'W');
});

test('over the line at the gun: OCS until back below it', () => {
  const c = R.makeCourse({}), r = R.newRace(c, { countdown: 5 });
  const ev = sail(r, [{ x: 0, y: -5 }, { x: 0, y: 30 }, { x: 0, y: 40 }]);
  assert.ok(ev.includes('ocs') && !ev.includes('started'));
  const ev2 = sail(r, [{ x: 0, y: 40 }, { x: 0, y: -10 }, { x: 0, y: 20 }]);
  assert.deepEqual(ev2, ['ocsClear', 'started']);
});

test('touching a mark needs a 360 before the finish counts', () => {
  const c = R.makeCourse({ legNm: 0.25 }), r = R.newRace(c, { countdown: 1 }), L = c.L;
  sail(r, [{ x: 0, y: -10 }, { x: 0, y: 10 }, { x: 2, y: L - 2 }, { x: 15, y: L + 10 }, { x: -15, y: L + 10 }, { x: 0, y: 10 }, { x: 0, y: -20 }]);
  assert.equal(r.penalty, 1);
  assert.notEqual(r.phase, 'finished');
  sail(r, [{ x: 0, y: -20 }, { x: 0, y: -30 }, { x: 0, y: -40 }], [0, 200, 200]); // a full turn
  assert.equal(r.penalty, 0);
  sail(r, [{ x: 0, y: -40 }, { x: 0, y: 10 }, { x: 0, y: -10 }]);
  assert.equal(r.phase, 'finished');
});

test('two laps go through the leeward gate', () => {
  const c = R.makeCourse({ legNm: 0.25, laps: 2 }), r = R.newRace(c, { countdown: 1 }), L = c.L;
  assert.deepEqual(c.legs, ['start', 'W', 'G', 'W', 'finish']);
  const lap = [{ x: 15, y: L + 10 }, { x: -15, y: L + 10 }];
  sail(r, [{ x: 0, y: -10 }, { x: 0, y: 10 }, ...lap, { x: 0, y: -60 }, { x: 0, y: -90 }, { x: 15, y: 0 }, ...lap, { x: 0, y: 10 }, { x: 0, y: -10 }]);
  assert.equal(r.phase, 'finished');
  assert.equal(r.splits.length, 3);
});

test('target time adds each leg at the beat or run VMG', () => {
  const c = R.makeCourse({ legNm: 0.5, laps: 1 });
  assert.ok(Math.abs(R.targetTime(c, 4, 5) - (926 / (4 * 0.514444) + 926 / (5 * 0.514444))) < 1);
});

test('an autopilot sails the course with the model in about the ORC time', () => {
  const M = require('./model.js'), O = require('./calib/orc-catalina30.js');
  const KN = M.KN, D = M.D, tws = 12, i = O.tws.indexOf(tws);
  const c = R.makeCourse({ legNm: 0.25, laps: 2 }), r = R.newRace(c, { countdown: 20 });
  const beat = M.autoTrim(Object.assign(M.defaultControls(), { head: 'jib' }), { tws: tws * KN, twa: 41, bs: 2.8 });
  const run = M.autoTrim(Object.assign(M.defaultControls(), { head: 'spin', mainsheet: 0.8, spinSheet: 0.6, spinPole: 0.75 }), { tws: tws * KN, twa: 160, bs: 2.8 });
  const S = { tws: tws * KN, twa: 90, bs: 2, heel: 0, leeway: 0 };
  let p = { x: -20, y: -50 }, course = 90, target = 90; // course > 0 is starboard tack: heading = -course, here west
  const lay = 41 + 4; // beat angle plus leeway
  const dt = 0.25;
  for (let n = 0; n < 6000 && r.phase !== 'finished'; n++) {
    const leg = c.legs[r.leg], m = R.nextMark(r).p, brg = Math.atan2(m.x - p.x, m.y - p.y) / D;
    if (r.phase === 'pre') target = r.t < -12 ? 90 : -41;            // reach away, then come up to the line on port
    else if (leg === 'start') target = -41;                           // port tack (heading north-east) off the line
    else if (leg === 'W') {
      if (Math.abs(target) > 90 && p.y < c.gate[0].y - 25) target = -41; // clear below the gate: up on port
      if (target < 0 && brg <= -lay - 1) target = 41;                 // port tack until just past the starboard layline
    } else {                                                          // the runs: to the gate or the finish
      const band = leg === 'G' ? 12 : 30;
      if (Math.abs(target) < 90) target = 155;                        // round the mark: bear away
      if (p.y < c.windward.y - 20) { if (p.x < -band) target = -160; else if (p.x > band) target = 160; }
    }
    const turn = Math.max(-14 * dt, Math.min(14 * dt, ((target - course + 540) % 360) - 180)), h0 = -course;
    course += turn; if (course > 180) course -= 360; if (course < -180) course += 360;
    S.twa = course;
    M.step(S, Math.abs(course) < 100 ? beat : run, dt);
    const cog = -(course + Math.sign(course || 1) * S.leeway) * D, p1 = { x: p.x + S.bs * Math.sin(cog) * dt, y: p.y + S.bs * Math.cos(cog) * dt };
    R.update(r, p, p1, dt, -turn);
    p = p1;
  }
  assert.equal(r.phase, 'finished', `stuck on leg ${c.legs[r.leg]} at ${JSON.stringify(p)}`);
  const orc = R.targetTime(c, O.beatVmg[i], O.runVmg[i]), ratio = (r.finish - r.started) / orc;
  assert.ok(ratio > 0.95 && ratio < 1.3, `${R.fmt(r.finish)} vs ORC ${R.fmt(orc)} (${ratio.toFixed(2)})`);
});

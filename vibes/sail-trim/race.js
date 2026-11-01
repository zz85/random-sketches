// Windward-leeward race: course geometry, start, roundings, penalties and finish, with no drawing.
// World frame: metres, x east, y north; the mean wind blows from the north (from +y).
// A heading is degrees clockwise from north; the model's signed TWA (course) is heading = -course.
(function (root) {
  'use strict';
  const NM = 1852, D = Math.PI / 180;
  const LINE = 120;      // start / finish line length, m
  const GATE_Y = -70;    // leeward gate below the start line, m
  const GATE_W = 50;
  const HIT = 4;         // a mark closer than this to the boat's centre is hit, m

  // A course of `legNm` from the start line to the windward mark, `laps` times round.
  function makeCourse(o) {
    const legNm = (o && o.legNm) || 0.25, laps = (o && o.laps) || 1, L = legNm * NM;
    const legs = ['start', 'W'];
    for (let i = 1; i < laps; i++) legs.push('G', 'W');
    legs.push('finish');
    return {
      legNm, laps, L, legs,
      pin: { x: -LINE / 2, y: 0 }, committee: { x: LINE / 2, y: 0 },
      windward: { x: 0, y: L },
      gate: [{ x: -GATE_W / 2, y: GATE_Y }, { x: GATE_W / 2, y: GATE_Y }],
    };
  }

  // Signed side of point p against the line a->b (positive: left of it).
  const side = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  // Does the move p0->p1 cross the segment a-b? Returns +1 crossing from its right to its left, -1 the other way, 0 none.
  function crosses(a, b, p0, p1) {
    const s0 = side(a, b, p0), s1 = side(a, b, p1);
    if (s0 === s1 || (s0 > 0) === (s1 > 0)) return 0;
    const t0 = side(p0, p1, a), t1 = side(p0, p1, b);
    if ((t0 > 0) === (t1 > 0)) return 0;
    return s1 > 0 ? 1 : -1;
  }

  function newRace(course, o) {
    return {
      course, phase: 'pre', t: -((o && o.countdown) || 60), leg: 0,
      ocs: false, started: null, penalty: 0, turn: 0, hitCool: 0,
      splits: [], finish: null, events: [],
    };
  }

  const marks = (c) => [c.windward, c.gate[0], c.gate[1], c.pin, c.committee];
  const nextMark = (r) => {
    const c = r.course, leg = c.legs[r.leg];
    if (leg === 'W') return { name: 'windward mark', p: c.windward };
    if (leg === 'G') return { name: 'leeward gate', p: { x: 0, y: c.gate[0].y } };
    return { name: leg === 'start' ? 'start line' : 'finish line', p: { x: 0, y: 0 } };
  };

  // Advance the race by dt seconds as the boat moves p0 -> p1, turning dHeading degrees (signed).
  // Returns the events of this step, such as 'gun', 'ocs', 'started', 'rounded', 'hit', 'penaltyDone', 'finished'.
  function update(r, p0, p1, dt, dHeading) {
    const c = r.course, ev = [], say = (type, text) => { ev.push({ type, text, t: r.t }); };
    if (r.phase === 'finished') return ev;
    const t0 = r.t;
    r.t += dt;
    for (const s of [-60, -30, -10]) if (t0 < s && r.t >= s) say('signal', `${-s} seconds`);
    if (t0 < 0 && r.t >= 0) {
      r.phase = 'racing';
      if (p1.y > 0) { r.ocs = true; say('ocs', 'Over early (OCS): sail back below the line and start again.'); }
      else say('gun', 'Start!');
    }
    // Penalty: one full turn (a tack and a gybe) clears each mark hit.
    if (r.penalty > 0) {
      r.turn += dHeading;
      if (Math.abs(r.turn) >= 360) { r.penalty--; r.turn = 0; say('penaltyDone', r.penalty ? 'Turn done, one more to go.' : 'Penalty turn done.'); }
    }
    r.hitCool -= dt;
    if (r.hitCool <= 0) for (const m of marks(c)) {
      const d = Math.hypot(p1.x - m.x, p1.y - m.y);
      if (d < (m === c.committee ? HIT + 3 : HIT)) {
        r.penalty++; r.turn = 0; r.hitCool = 5;
        say('hit', m === c.committee ? 'Hit the committee boat: do a penalty turn (360).' : 'Mark touched: do a penalty turn (360).');
        break;
      }
    }
    if (r.phase !== 'racing') return ev;
    const leg = c.legs[r.leg];
    if (leg === 'start') {
      if (r.ocs && p1.y < 0) { r.ocs = false; say('ocsClear', 'Cleared: now start.'); }
      // Started: across the line between the pin and the committee boat, northward.
      if (!r.ocs && crosses(c.pin, c.committee, p0, p1) && p1.y > p0.y) {
        r.started = r.t; r.leg++; say('started', `Started ${fmt(r.t)} after the gun.`);
      }
    } else if (leg === 'W') {
      // Rounded to port: across the ray from the mark straight upwind, from east to west.
      const top = { x: c.windward.x, y: c.windward.y + 1e5 };
      if (crosses(c.windward, top, p0, p1) && p1.x < p0.x) {
        r.splits.push(r.t); r.leg++; say('rounded', `Windward mark at ${fmt(r.t)}.`);
      }
    } else if (leg === 'G') {
      if (crosses(c.gate[0], c.gate[1], p0, p1) && p1.y < p0.y) {
        r.splits.push(r.t); r.leg++; say('rounded', `Leeward gate at ${fmt(r.t)}.`);
      }
    } else if (leg === 'finish') {
      if (crosses(c.pin, c.committee, p0, p1) && p1.y < p0.y) {
        if (r.penalty > 0) say('noFinish', 'Not finished: do your penalty turn first, then cross again.');
        else { r.finish = r.t; r.phase = 'finished'; say('finished', `Finished in ${fmt(r.t)}.`); }
      }
    }
    return ev;
  }

  // Theoretical time from the gun at a polar's VMGs (kn): each leg's distance at the beat or run VMG.
  function targetTime(course, beatVmg, runVmg) {
    const KN = 0.514444, L = course.L, g = -course.gate[0].y;
    let up = 0, down = 0;
    for (let i = 1; i < course.legs.length; i++) {
      const leg = course.legs[i], prev = course.legs[i - 1];
      if (leg === 'W') up += prev === 'start' ? L : L + g;
      else if (leg === 'G') down += L + g;
      else if (leg === 'finish') down += L;
    }
    return up / (beatVmg * KN) + down / (runVmg * KN);
  }

  // Linear interpolation of an ORC table row (by true wind speed, kn).
  function interp(xs, ys, x) {
    if (x <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ys[ys.length - 1];
  }

  function fmt(s) {
    const neg = s < 0; s = Math.abs(s);
    const m = Math.floor(s / 60), x = Math.floor(s % 60);
    return (neg ? '-' : '') + m + ':' + String(x).padStart(2, '0');
  }

  const api = { NM, LINE, GATE_Y, GATE_W, HIT, makeCourse, newRace, update, nextMark, crosses, targetTime, interp, fmt, marks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Race = api;
})(typeof self !== 'undefined' ? self : this);

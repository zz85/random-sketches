// node --test race.test.js
const test = require('node:test'), assert = require('node:assert');
const RC = require('./race.js');
const { HornDetector } = require('./horn.js');

const T = RC.parseHms;
const fleet = () => RC.parseFleet(`Sail,Boat,Type,PHRF,Fleet
USA 12345,Wild Thing,J/105,81,A
28771,Blue Moon,J/80,111,B
7,The Albatross,Catalina 30,186,B
42,Salty Dog,Olson 911,129,A
USA 112,Mojo,J/24,171,B`);

test('times parse and print', () => {
  assert.equal(T('14:05'), 50700);
  assert.equal(T('14:05:30'), 50730);
  assert.equal(T('140530'), 50730);
  assert.equal(T('9.05.07'), 32707);
  assert.equal(T('25:00'), null);
  assert.equal(RC.hms(50730.9), '14:05:30');
  assert.equal(RC.dur(3725), '1:02:05');
  assert.equal(RC.dur(65), '1:05');
});

test('fleet import finds columns by header, sorts by name and sail number', () => {
  const b = fleet();
  assert.equal(b.length, 5);
  assert.deepEqual(b[0], { ...b[0], name: 'Wild Thing', sail: 'USA 12345', type: 'J/105', rating: 81, fleet: 'A' });
  assert.deepEqual(RC.sortBoats(b, 'name').map((x) => x.name), ['The Albatross', 'Blue Moon', 'Mojo', 'Salty Dog', 'Wild Thing']);
  assert.deepEqual(RC.sortBoats(b, 'sail').map((x) => x.sail), ['7', '42', 'USA 112', 'USA 12345', '28771']);
  const nohead = RC.parseFleet('101\tFoo\tJ/24\t171\tB');
  assert.equal(nohead[0].name, 'Foo'); assert.equal(nohead[0].rating, 171);
  assert.equal(RC.parseFleet(RC.fleetCsv(b)).length, 5);
});

test('partial sail number and name lookup', () => {
  const b = fleet();
  assert.equal(RC.matchBoats('345', b)[0].boat.name, 'Wild Thing'); // end of the sail number
  assert.deepEqual(RC.matchBoats('12', b).slice(0, 2).map((m) => m.boat.name), ['Mojo', 'Wild Thing']); // ...112 ends in 12, 12345 starts with it
  assert.equal(RC.matchBoats('112', b)[0].boat.name, 'Mojo');
  assert.equal(RC.matchBoats('blu', b)[0].boat.name, 'Blue Moon');
  assert.equal(RC.matchBoats('dog', b)[0].boat.name, 'Salty Dog');
  assert.equal(RC.matchBoats('albatros', b)[0].boat.name, 'The Albatross');
  assert.equal(RC.matchBoats('wld thng', b)[0].boat.name, 'Wild Thing'); // letters in order
  assert.equal(RC.matchBoats('', b).length, 0);
});

test('OCR text matches sail numbers and misread names', () => {
  const b = fleet();
  assert.equal(RC.matchOcr('USA l2345', b)[0].boat.name, 'Wild Thing');
  assert.equal(RC.matchOcr('BLUE M0ON', b)[0].boat.name, 'Blue Moon');
  assert.equal(RC.matchOcr('~ SALTV DOG ~', b)[0].boat.name, 'Salty Dog');
  assert.equal(RC.matchOcr('28771', b)[0].boat.name, 'Blue Moon');
  assert.equal(RC.matchOcr('xyzzy', b).length, 0);
});

test('starts, clear to cross, OCS and returning', () => {
  const b = fleet(), r = RC.makeRace();
  RC.autoStarts(r, b, T('12:00'), 300);
  assert.deepEqual(r.starts.map((s) => [s.label, RC.hms(s.time)]), [['A', '12:00:00'], ['B', '12:05:00']]);
  const [wild, blue] = [b[0], b[1]];
  assert.equal(RC.startPhase(r, r.starts[0], T('11:55:30')).phase, 'sequence');
  assert.equal(RC.startPhase(r, r.starts[0], T('11:55:30')).next.name, 'Preparatory');
  let c = RC.clearToCross(r, b, T('12:01'));
  assert.deepEqual(c.clear.map((x) => x.start.label), ['A']);
  assert.deepEqual(c.early.map((x) => x.start.label), ['B']);
  assert.equal(RC.startState(r, wild, T('12:01')), 'clear');
  assert.equal(RC.startState(r, blue, T('12:01')), 'waiting');
  RC.markCrossed(r, blue, T('12:04:58')); // 2 s early
  assert.equal(RC.startState(r, blue, T('12:05:10')), 'ocs');
  RC.markCrossed(r, blue, T('12:06:30')); // came back and started
  assert.equal(RC.startState(r, blue, T('12:07')), 'started');
  assert.ok(r.entries[blue.id].returned);
  RC.markCrossed(r, wild, T('12:00:04'));
  assert.equal(r.entries[wild.id].start, 'ok');
});

test('finishes: on-deck queue, unassigned times, reassigning', () => {
  const b = fleet(), r = RC.makeRace();
  RC.enqueue(r, b[3].id); RC.enqueue(r, b[0].id); RC.enqueue(r, b[3].id);
  assert.deepEqual(r.queue, [b[3].id, b[0].id]);
  const f1 = RC.recordFinish(r, T('13:10:00'));
  assert.equal(f1.boatId, b[3].id);
  assert.deepEqual(r.queue, [b[0].id]);
  const f0 = RC.recordFinish(r, T('13:09:00'), null); // a time hack nobody was ready for
  assert.equal(r.finishes[0].id, f0.id);
  RC.assignFinish(r, f0.id, b[0].id);
  assert.equal(RC.finishOf(r, b[0].id).t, T('13:09:00'));
  assert.equal(r.queue.length, 0);
  RC.assignFinish(r, f1.id, b[0].id); // move Wild Thing to the other time: one finish per boat
  assert.equal(RC.finishOf(r, b[0].id).id, f1.id);
  assert.equal(f0.boatId, null);
});

test('scoring: time on distance, time on time, codes score entries + 1', () => {
  const b = fleet(), r = RC.makeRace({ scoring: 'tod', distance: 10 });
  RC.autoStarts(r, b, T('12:00'), 300);
  const by = (n) => b.find((x) => x.name === n);
  // Fleet B starts 12:05. Blue Moon (111) 1:30:00 elapsed, Albatross (186) 1:40:00, Mojo DNC
  RC.recordFinish(r, T('13:35:00'), by('Blue Moon').id);
  RC.recordFinish(r, T('13:45:00'), by('The Albatross').id);
  RC.markStart(r, by('Mojo'), 'dnc');
  // Fleet A starts 12:00. Wild Thing OCS and never returned but finished; Salty Dog retired
  RC.markCrossed(r, by('Wild Thing'), T('11:59:59'));
  RC.recordFinish(r, T('13:00:00'), by('Wild Thing').id);
  RC.setStatus(r, by('Salty Dog'), 'ret');
  const res = RC.results(r, b);
  const A = res.find((g) => g.fleet === 'A'), B = res.find((g) => g.fleet === 'B');
  assert.equal(B.rows[0].boat.name, 'The Albatross'); // 6000 - 1860 = 4140 beats 5400 - 1110 = 4290
  assert.equal(B.rows[0].corrected, 4140);
  assert.equal(B.rows[0].place, 1);
  assert.equal(B.rows[1].behind, 150);
  assert.deepEqual(B.rows.map((x) => x.code), [null, null, 'DNC']);
  assert.equal(B.rows[2].points, 4);
  assert.deepEqual(A.rows.map((x) => [x.boat.name, x.code, x.points]), [['Wild Thing', 'OCS', 3], ['Salty Dog', 'RET', 3]]);
  r.scoring = 'tot';
  const tot = RC.results(r, b).find((g) => g.fleet === 'B').rows[0];
  assert.equal(tot.boat.name, 'The Albatross'); // 6000*650/736 = 5299 beats 5400*650/661 = 5310
  assert.ok(Math.abs(tot.corrected - Math.min(5400 * 650 / 661, 6000 * 650 / 736)) < 1e-9);
  const csv = RC.resultsCsv(r, b);
  assert.match(csv.split('\n')[0], /^Fleet,Place,Sail,Boat/);
});

test('ties share points; closing the race turns boats still racing into DNF', () => {
  const b = fleet(), r = RC.makeRace({ scoring: 'elapsed' });
  RC.autoStarts(r, b, T('12:00'), 300);
  const B = b.filter((x) => x.fleet === 'B');
  RC.recordFinish(r, T('13:00:00'), B[0].id); RC.recordFinish(r, T('13:00:00'), B[1].id);
  const g = RC.results(r, b).find((x) => x.fleet === 'B');
  assert.deepEqual(g.rows.slice(0, 2).map((x) => x.points), [1.5, 1.5]);
  assert.equal(g.rows[2].code, 'racing');
  assert.equal(RC.results(r, b, { closed: true }).find((x) => x.fleet === 'B').rows[2].code, 'DNF');
});

test('narration: each signal once, the start names who is clear, stale signals are skipped', () => {
  const b = fleet(), r = RC.makeRace(); RC.autoStarts(r, b, T('12:00'), 300);
  const fired = new Set(); const said = [];
  for (let t = T('11:54:58'); t <= T('12:00:01'); t += 0.25) said.push(...RC.announcements(r, b, t, fired).map((a) => a.text));
  assert.equal(said.filter((s) => /^A, warning/.test(s)).length, 1);
  assert.ok(said.includes('B, warning signal. Five minutes.')); // B's warning is A's start (rolling starts)
  assert.ok(said.includes('A, one minute.'));
  assert.ok(said.includes('10 seconds.'));
  const start = said.find((s) => /^A start/.test(s));
  assert.match(start, /Clear to cross: 4 2, Salty Dog, 1 2 3 4 5, Wild Thing\./);
  assert.ok(!said.some((s) => /^B start/.test(s)));
  const late = new Set();
  assert.equal(RC.announcements(r, b, T('12:30'), late).length, 0); // opened the app mid-race: nothing to say
});

test('horn detector: tonal blast found at its onset, wind gusts ignored', () => {
  const N = 1024, binHz = 24000 / N, frame = 20;
  const spec = (f) => { const s = new Float32Array(N); for (let i = 0; i < N; i++) s[i] = f(i * binHz); return s; };
  const quiet = () => spec(() => -90 + Math.random() * 6);
  const horn = () => spec((hz) => { const h = [420, 840, 1260, 1680].some((x) => Math.abs(hz - x) < 30); return h ? -25 : -85 + Math.random() * 6; });
  const wind = () => spec((hz) => -40 - hz / 400 + Math.random() * 6); // loud, broadband, falling with frequency
  const d = new HornDetector({ latencyMs: 20 });
  const onsets = [];
  let t = 0;
  const run = (gen, ms) => { for (const end = t + ms; t < end; t += frame) { const r = d.step(gen(), binHz, t); if (r.onset != null) onsets.push(r.onset); } };
  run(quiet, 3000); run(wind, 1500); run(quiet, 1000);
  assert.equal(onsets.length, 0);
  const at = t; run(horn, 800); run(quiet, 2000);
  assert.equal(onsets.length, 1);
  assert.ok(Math.abs(onsets[0] - (at - 20)) <= frame, onsets[0] + ' vs ' + at);
  run(horn, 120); run(quiet, 1000); // too short
  assert.equal(onsets.length, 1);
  const at2 = t; run(horn, 400); run(quiet, 500);
  assert.equal(onsets.length, 2);
  assert.ok(Math.abs(onsets[1] - (at2 - 20)) <= frame);
});

test('voice lookup: spoken sail numbers become digits', () => {
  assert.equal(RC.spokenQuery('four two'), '42');
  assert.equal(RC.spokenQuery('sail number forty two'), '42');
  assert.equal(RC.spokenQuery('one one two'), '112');
  assert.equal(RC.spokenQuery('2 8 7 7 1'), '28771');
  assert.equal(RC.spokenQuery('Blue Moon'), 'blue moon');
});

test('a finish before the gun is flagged, a race past midnight is not', () => {
  const b = fleet(), r = RC.makeRace({ scoring: 'elapsed' });
  RC.autoStarts(r, b, T('23:30'), 300);
  const A = b.filter((x) => x.fleet === 'A');
  RC.recordFinish(r, T('00:45:00'), A[0].id);
  RC.recordFinish(r, T('23:20:00'), A[1].id);
  const g = RC.results(r, b).find((x) => x.fleet === 'A');
  assert.equal(g.rows[0].elapsed, 4500);
  assert.equal(g.rows[1].check, 'finish before start');
  assert.equal(g.rows[1].place, undefined);
});

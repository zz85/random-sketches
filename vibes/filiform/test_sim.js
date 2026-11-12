// node --test test_sim.js - the filament model on its own, without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSim, PIECES, rhResponse } from './sim.js';

const grow = (s, days, rh = 0.85) => { while (s.now < days - 1e-9) s.step(6, rh); return s.stats(); };
const NX = 384; // half the app's grid, for speed; widths and speeds are in mm, so it behaves the same

test('nothing starts on an intact, unsalted coating', () => {
  const s = makeSim({ NX, piece: 'tinplate', seed: 1, setup: false });
  const st = grow(s, 30);
  assert.equal(st.filaments, 0);
  // a scratch with no salt in it doesn't start any either
  s.scratch(50, 50, 300, 200, 2, 0);
  assert.equal(grow(s, 60).filaments, 0);
});

test('filaments start from a salted scribe and grow at about the right speed', () => {
  const s = makeSim({ NX, piece: 'tinplate', seed: 2 });
  const st = grow(s, 20);
  assert.ok(st.filaments > 30, `${st.filaments} filaments`);
  // the oldest heads at their best humidity: 0.4 mm/day times their own 0.75..1.25, less the time to start
  assert.ok(st.longestMm > 3 && st.longestMm < 12, `longest ${st.longestMm.toFixed(1)} mm in 20 days`);
});

test('below the threshold humidity nothing grows; above it growth resumes', () => {
  const s = makeSim({ NX, piece: 'tinplate', seed: 3 });
  const a = grow(s, 15);
  const b = grow(s, 45, 0.5);
  assert.equal(b.lengthMm, a.lengthMm);
  assert.equal(b.filaments, a.filaments);
  assert.equal(b.active, 0);
  const c = grow(s, 60, 0.85);
  assert.ok(c.lengthMm > a.lengthMm * 1.3, `${a.lengthMm.toFixed(0)} -> ${c.lengthMm.toFixed(0)} mm`);
});

test('growth is fastest near the peak humidity, slower either side', () => {
  const P = PIECES.tinplate;
  const v = (rh) => rhResponse(P, rh).speed;
  assert.equal(v(0.6), 0);
  assert.ok(v(0.7) < v(0.8) && v(0.8) < v(0.86));
  assert.ok(v(0.95) < v(0.86) && v(0.98) < v(0.95));
  // and above about 93% the heads swell
  assert.ok(rhResponse(P, 0.97).width > 1.8 * rhResponse(P, 0.86).width);
});

test('wider tails grow in very humid air', () => {
  const width = (rh) => { const s = makeSim({ NX, piece: 'tinplate', seed: 4 }); grow(s, 25, rh); const ws = s.alive.map((f) => f.w); return ws.reduce((a, b) => a + b, 0) / ws.length; };
  assert.ok(width(0.97) > 1.6 * width(0.8));
});

test('filaments do not cross each other\u2019s tails', () => {
  for (const piece of Object.keys(PIECES)) {
    const s = makeSim({ NX, piece, seed: 5 });
    const st = grow(s, 120);
    assert.ok(st.moves > 5000, `${piece}: ${st.moves} moves`);
    // a head stepping into another's dry tail is a crossing; the steering keeps it to a small share of the moves
    assert.ok(st.crossings / st.moves < 0.005, `${piece}: ${st.crossings} crossings in ${st.moves} moves`);
    // and most of the filaments that stopped met another's tail
    assert.ok(st.died.met > st.died.dry, `${piece}: ${JSON.stringify(st.died)}`);
  }
});

test('a head that reaches a fresh scratch opens to the air and dies', () => {
  const s = makeSim({ NX, piece: 'tinplate', seed: 6 });
  grow(s, 30);
  const live = s.alive.filter((f) => f.grace <= 0).length, before = s.stats().died.bare; // (a head just started still has its defect behind it)
  // cut across the whole panel, every few cells, through every head
  for (const f of s.alive) s.scratch(f.x - 3, f.y - 3, f.x + 3, f.y + 3, 2.5, 0);
  s.step(1, 0.85);
  assert.ok(s.stats().died.bare - before >= live * 0.95, `${s.stats().died.bare - before} of ${live}`);
});

test('the same seed gives the same panel', () => {
  const a = grow(makeSim({ NX, piece: 'wheel', seed: 9 }), 30), b = grow(makeSim({ NX, piece: 'wheel', seed: 9 }), 30);
  assert.deepEqual(a, b);
});

test('every changed cell is reported for the renderer', () => {
  const s = makeSim({ NX, piece: 'frame', seed: 7 });
  s.takeDirty(() => {});
  grow(s, 10);
  const seen = new Set(); s.takeDirty((i) => seen.add(i));
  for (let i = 0; i < s.N; i++) if (s.head[i] > 0) assert.ok(seen.has(i));
  assert.ok(seen.size > 100);
  assert.equal(s.takeDirty(() => {}), 0);
});

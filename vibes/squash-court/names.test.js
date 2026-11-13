// bun test — the score-bug name vote (names.js)
import { test, expect, describe } from 'bun:test';
import { NameVote } from './names.js';

const read = (left, right, le = 0.07, re = 0.07) => ({ left, right, leftErr: le, rightErr: re, err: Math.max(le, re) });

describe('NameVote', () => {
  test('names a match after three agreeing reads, not before', () => {
    const v = new NameVote();
    expect(v.add(read('ELIAS', 'MAKIN'), 0)).toBe(null);
    expect(v.add(read('ELIAS', 'MAKIN'), 2)).toBe(null);
    expect(v.add(read('ELIAS', 'MAKIN'), 4)).toEqual({ left: 'ELIAS', right: 'MAKIN' });
  });
  test('frames with no bug neither count nor undo the names', () => {
    const v = new NameVote();
    for (let t = 0; t < 6; t += 2) v.add(read('PERRY', 'SERME'), t);
    for (let t = 6; t < 60; t += 2) expect(v.add(null, t)).toEqual({ left: 'PERRY', right: 'SERME' });
  });
  test('a misread on one side does not hold up the other, and confident misreads are outvoted', () => {
    const v = new NameVote();
    v.add(read('MASSARO', 'DAVIO', 0.08, 0.075), 0);
    v.add(read('MASSARO', 'DAVID', 0.08, 0.07), 2);
    v.add(read('MASSARO', 'DAVID', 0.08, 0.06), 4);
    expect(v.add(read('MASSARO', 'DAVID', 0.08, 0.07), 6)).toEqual({ left: 'MASSARO', right: 'DAVID' });
  });
  test('reads with a high error do not count', () => {
    const v = new NameVote();
    for (let t = 0; t < 10; t += 2) v.add(read('GIUS', 'KENNEDY', 0.15, 0.06), t);
    expect(v.names).toBe(null);
    expect(v.leader('right')).toBe('KENNEDY');
  });
  test('the next match in a compilation takes over once it leads', () => {
    const v = new NameVote();
    for (let t = 0; t < 10; t += 2) v.add(read('WEAVER', 'KENNEDY'), t);
    let n; for (let t = 10; t < 30; t += 2) n = v.add(read('GILIS', 'KENNEDY'), t);
    expect(n).toEqual({ left: 'GILIS', right: 'KENNEDY' });
  });
  test('a seek back starts afresh', () => {
    const v = new NameVote();
    for (let t = 100; t < 110; t += 2) v.add(read('SERME', 'HAMMAMY'), t);
    expect(v.add(read('GOHAR', 'SOBHY'), 20)).toBe(null);
  });
  test('the same name on both sides is not taken', () => {
    const v = new NameVote();
    for (let t = 0; t < 10; t += 2) v.add(read('SERME', 'SERME'), t);
    expect(v.names).toBe(null);
  });
});

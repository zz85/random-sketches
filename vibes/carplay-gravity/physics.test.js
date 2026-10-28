// node --test   (physics only; the page is checked by smoke.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, Body } from './physics.js';

const settle = (w, s = 4) => { for (let i = 0; i < s * 120; i++) w.step(1 / 120); };

test('a box comes to rest on the floor', () => {
  const w = new World(); w.setBounds(0, 0, 400, 300);
  const b = w.add(new Body({ x: 200, y: 50, w: 60, h: 40, angle: 0.3 }));
  settle(w);
  assert.ok(Math.abs(b.y - 280) < 1.5, `y ${b.y}`);
  assert.ok(Math.abs(Math.sin(b.angle * 2)) < 0.02, `flat, angle ${b.angle}`);
  assert.ok(Math.hypot(b.vx, b.vy) < 5, 'still');
});

test('a stack of eight boxes stands', () => {
  const w = new World(); w.setBounds(0, 0, 400, 600);
  const bs = [];
  for (let i = 0; i < 8; i++) bs.push(w.add(new Body({ x: 200 + (i % 2) * 3, y: 600 - 25 - i * 50.5, w: 70, h: 50 })));
  settle(w, 5);
  const top = bs[7];
  assert.ok(Math.abs(top.x - 201.5) < 12, `top x ${top.x}`);
  assert.ok(Math.abs(top.y - (600 - 25 - 7 * 50)) < 6, `top y ${top.y}`);
});

test('circles roll and stay inside the walls', () => {
  const w = new World(); w.setBounds(0, 0, 400, 300); w.gx = 1200;
  const c = w.add(new Body({ x: 60, y: 260, w: 80, h: 80, shape: 'circle' }));
  const b = w.add(new Body({ x: 200, y: 100, w: 50, h: 50 }));
  settle(w, 3);
  assert.ok(c.x <= 361 && c.x > 300, `circle x ${c.x}`);
  assert.ok(Math.abs(c.angle) > 1, 'it rolled');
  assert.ok(b.x < 376 && b.y < 276, 'box inside');
});

test('a pinned body holds until hit hard, then falls', () => {
  const w = new World(); w.setBounds(0, 0, 400, 400);
  const p = w.add(new Body({ x: 200, y: 100, w: 60, h: 60, pinned: true }));
  settle(w, 1);
  assert.equal(p.y, 100);
  const ball = w.add(new Body({ x: 60, y: 100, w: 30, h: 30, shape: 'circle' }));
  ball.vx = 1500; w.gy = 0;
  settle(w, 0.5);
  assert.equal(p.pinned, false);
  w.gy = 2400; settle(w, 2);
  assert.ok(p.y > 330, `fell to ${p.y}`);
});

test('the mouse joint carries a body to the pointer', () => {
  const w = new World(); w.setBounds(0, 0, 600, 600);
  const b = w.add(new Body({ x: 300, y: 570, w: 60, h: 60 }));
  const j = w.grab(b, 310, 560);
  j.tx = 200; j.ty = 200;
  settle(w, 2);
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  const ax = b.x + c * j.lx - s * j.ly, ay = b.y + s * j.lx + c * j.ly;
  assert.ok(Math.hypot(ax - 200, ay - 200) < 25, `anchor ${ax},${ay}`);
});

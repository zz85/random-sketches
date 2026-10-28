// Small 2D rigid-body engine for DOM pieces: oriented boxes and circles, sequential impulses with
// warm starting (Box2D Lite's box-box clipping, Catto 2006), friction, a little restitution, a
// soft mouse joint for dragging, and "pinned" bodies that hold their place until something hits
// them hard enough to knock them loose. Units are CSS pixels and seconds; y points down.

export class Body {
  constructor({ x, y, w, h, r = 0, shape = 'box', angle = 0, density = 1, friction = 0.5, restitution = 0.12, pinned = false, el = null }) {
    this.shape = shape;
    this.x = x; this.y = y; this.angle = angle;
    this.hw = w / 2; this.hh = h / 2; this.r = shape === 'circle' ? (r || Math.min(w, h) / 2) : 0;
    this.vx = 0; this.vy = 0; this.w = 0;
    this.friction = friction; this.restitution = restitution;
    const area = shape === 'circle' ? Math.PI * this.r * this.r : w * h;
    this.area = area; this.mass = density * area / 1000;
    this.I = shape === 'circle' ? this.mass * this.r * this.r / 2 : this.mass * (w * w + h * h) / 12;
    this.el = el;
    this.id = Body.nextId++;
    this.setPinned(pinned);
  }
  setPinned(p) {
    this.pinned = p;
    this.invMass = p ? 0 : 1 / this.mass;
    this.invI = p ? 0 : 1 / this.I;
    if (p) { this.vx = this.vy = this.w = 0; }
  }
  resize(w, h) {
    this.hw = w / 2; this.hh = h / 2;
    if (this.shape === 'circle') this.r = Math.min(w, h) / 2;
    const d = this.mass / this.area;
    this.area = this.shape === 'circle' ? Math.PI * this.r * this.r : w * h;
    this.mass = d * this.area;
    this.I = this.shape === 'circle' ? this.mass * this.r * this.r / 2 : this.mass * (w * w + h * h) / 12;
    this.setPinned(this.pinned);
  }
  // bounding radius, for the broad phase
  get bound() { return this.shape === 'circle' ? this.r : Math.hypot(this.hw, this.hh); }
}
Body.nextId = 1;

const STATIC = { invMass: 0, invI: 0, vx: 0, vy: 0, w: 0, pinned: false };

// ---------- narrow phase: contacts {x, y, nx, ny, sep} with the normal pointing from a to b ----------

function clipSegment(out, a, b, nx, ny, offset) {
  let n = 0;
  const d0 = nx * a.x + ny * a.y - offset, d1 = nx * b.x + ny * b.y - offset;
  if (d0 <= 0) out[n++] = a;
  if (d1 <= 0) out[n++] = b;
  if (d0 * d1 < 0) { const t = d0 / (d0 - d1); out[n++] = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }; }
  return n;
}

function incidentEdge(b, nx, ny) {
  // the edge of b most anti-parallel to the reference normal
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  const lx = -(c * nx + s * ny), ly = -(-s * nx + c * ny);
  let p, q;
  if (Math.abs(lx) > Math.abs(ly)) {
    if (lx > 0) { p = [b.hw, -b.hh]; q = [b.hw, b.hh]; } else { p = [-b.hw, b.hh]; q = [-b.hw, -b.hh]; }
  } else if (ly > 0) { p = [b.hw, b.hh]; q = [-b.hw, b.hh]; } else { p = [-b.hw, -b.hh]; q = [b.hw, -b.hh]; }
  const w = (v) => ({ x: b.x + c * v[0] - s * v[1], y: b.y + s * v[0] + c * v[1] });
  return [w(p), w(q)];
}

export function collideBoxes(A, B) {
  const ca = Math.cos(A.angle), sa = Math.sin(A.angle), cb = Math.cos(B.angle), sb = Math.sin(B.angle);
  // columns of the rotations: A1=(ca,sa) A2=(-sa,ca)
  const dpx = B.x - A.x, dpy = B.y - A.y;
  const dAx = ca * dpx + sa * dpy, dAy = -sa * dpx + ca * dpy;
  const dBx = cb * dpx + sb * dpy, dBy = -sb * dpx + cb * dpy;
  // C = RA^T RB
  const c11 = ca * cb + sa * sb, c12 = -ca * sb + sa * cb, c21 = -sa * cb + ca * sb, c22 = sa * sb + ca * cb;
  const a11 = Math.abs(c11), a12 = Math.abs(c12), a21 = Math.abs(c21), a22 = Math.abs(c22);
  const faX = Math.abs(dAx) - A.hw - (a11 * B.hw + a12 * B.hh);
  const faY = Math.abs(dAy) - A.hh - (a21 * B.hw + a22 * B.hh);
  if (faX > 0 || faY > 0) return [];
  const fbX = Math.abs(dBx) - (a11 * A.hw + a21 * A.hh) - B.hw;
  const fbY = Math.abs(dBy) - (a12 * A.hw + a22 * A.hh) - B.hh;
  if (fbX > 0 || fbY > 0) return [];

  const rel = 0.95, abs = 0.01;
  let axis = 0, sep = faX, nx = dAx > 0 ? ca : -ca, ny = dAx > 0 ? sa : -sa;
  if (faY > rel * sep + abs * A.hh) { axis = 1; sep = faY; nx = dAy > 0 ? -sa : sa; ny = dAy > 0 ? ca : -ca; }
  if (fbX > rel * sep + abs * B.hw) { axis = 2; sep = fbX; nx = dBx > 0 ? cb : -cb; ny = dBx > 0 ? sb : -sb; }
  if (fbY > rel * sep + abs * B.hh) { axis = 3; sep = fbY; nx = dBy > 0 ? -sb : sb; ny = dBy > 0 ? cb : -cb; }

  let fnx, fny, front, snx, sny, negSide, posSide, inc;
  if (axis === 0) {
    fnx = nx; fny = ny; front = A.x * fnx + A.y * fny + A.hw; snx = -sa; sny = ca;
    const side = A.x * snx + A.y * sny; negSide = -side + A.hh; posSide = side + A.hh; inc = incidentEdge(B, fnx, fny);
  } else if (axis === 1) {
    fnx = nx; fny = ny; front = A.x * fnx + A.y * fny + A.hh; snx = ca; sny = sa;
    const side = A.x * snx + A.y * sny; negSide = -side + A.hw; posSide = side + A.hw; inc = incidentEdge(B, fnx, fny);
  } else if (axis === 2) {
    fnx = -nx; fny = -ny; front = B.x * fnx + B.y * fny + B.hw; snx = -sb; sny = cb;
    const side = B.x * snx + B.y * sny; negSide = -side + B.hh; posSide = side + B.hh; inc = incidentEdge(A, fnx, fny);
  } else {
    fnx = -nx; fny = -ny; front = B.x * fnx + B.y * fny + B.hh; snx = cb; sny = sb;
    const side = B.x * snx + B.y * sny; negSide = -side + B.hw; posSide = side + B.hw; inc = incidentEdge(A, fnx, fny);
  }
  const c1 = [], c2 = [];
  if (clipSegment(c1, inc[0], inc[1], -snx, -sny, negSide) < 2) return [];
  if (clipSegment(c2, c1[0], c1[1], snx, sny, posSide) < 2) return [];
  const out = [];
  for (const p of c2) {
    const s = fnx * p.x + fny * p.y - front;
    if (s <= 0) out.push({ x: p.x - s * fnx, y: p.y - s * fny, nx, ny, sep: s });
  }
  return out;
}

export function collideCircles(A, B) {
  const dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy), sep = d - A.r - B.r;
  if (sep > 0) return [];
  const nx = d > 1e-6 ? dx / d : 0, ny = d > 1e-6 ? dy / d : 1;
  return [{ x: A.x + nx * (A.r + sep / 2), y: A.y + ny * (A.r + sep / 2), nx, ny, sep }];
}

export function collideBoxCircle(A, B) {
  const c = Math.cos(A.angle), s = Math.sin(A.angle);
  const dx = B.x - A.x, dy = B.y - A.y;
  const lx = c * dx + s * dy, ly = -s * dx + c * dy;
  const qx = Math.max(-A.hw, Math.min(A.hw, lx)), qy = Math.max(-A.hh, Math.min(A.hh, ly));
  let nlx, nly, sep, px = qx, py = qy;
  if (qx === lx && qy === ly) { // centre inside the box: push out through the nearest face
    const ex = A.hw - Math.abs(lx), ey = A.hh - Math.abs(ly);
    if (ex < ey) { nlx = Math.sign(lx) || 1; nly = 0; px = nlx * A.hw; sep = -ex - B.r; }
    else { nlx = 0; nly = Math.sign(ly) || 1; py = nly * A.hh; sep = -ey - B.r; }
  } else {
    const ox = lx - qx, oy = ly - qy, d = Math.hypot(ox, oy);
    sep = d - B.r; if (sep > 0) return [];
    nlx = ox / d; nly = oy / d;
  }
  return [{ x: A.x + c * px - s * py, y: A.y + s * px + c * py, nx: c * nlx - s * nly, ny: s * nlx + c * nly, sep }];
}

function collide(A, B) {
  if (A.shape === 'box' && B.shape === 'box') return collideBoxes(A, B);
  if (A.shape === 'circle' && B.shape === 'circle') return collideCircles(A, B);
  if (A.shape === 'box') return collideBoxCircle(A, B);
  return collideBoxCircle(B, A).map((k) => ({ ...k, nx: -k.nx, ny: -k.ny }));
}

// ---------- world ----------

export class World {
  constructor() {
    this.bodies = [];
    this.gx = 0; this.gy = 2400;
    this.iterations = 10;
    this.arbiters = new Map();
    this.joint = null;
    this.walls = { l: 0, t: 0, r: 800, b: 600 };
    this.wallFriction = 0.6;
    this.linearDamping = 0.05; this.angularDamping = 0.4;
    this.knockSpeed = 260; // relative speed that frees a pinned body
    this.maxSpeed = 7000;
    this.onKnock = null;
    this.restitution = null; // overrides every body's when set (zero-g is bouncier)
    this.ignore = new Set(); // pairs that pass through each other until they have come apart
  }
  add(b) { this.bodies.push(b); return b; }
  remove(b) { this.bodies = this.bodies.filter((o) => o !== b); if (this.joint && this.joint.body === b) this.joint = null; }
  clear() { this.bodies = []; this.arbiters.clear(); this.ignore.clear(); this.joint = null; }
  // a and b start one inside the other (a toolbar and its buttons): no contact between them until
  // they have separated once, then they collide like any other pair
  ignorePair(a, b) { this.ignore.add(a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id); }
  setBounds(l, t, r, b) { this.walls = { l, t, r, b }; }

  // Soft mouse joint (Box2D's b2MouseJoint) anchored at a world point on the body.
  grab(body, x, y, { hz = 6, damping = 0.75, maxForce = 1e9 } = {}) {
    const c = Math.cos(-body.angle), s = Math.sin(-body.angle), dx = x - body.x, dy = y - body.y;
    this.joint = { body, lx: c * dx - s * dy, ly: s * dx + c * dy, tx: x, ty: y, hz, damping, maxForce, ix: 0, iy: 0 };
    return this.joint;
  }
  release() { this.joint = null; }

  contactsFor(dt) {
    const B = this.bodies, live = new Set();
    for (let i = 0; i < B.length; i++) {
      const a = B[i];
      for (let j = i + 1; j < B.length; j++) {
        const b = B[j];
        if (a.invMass === 0 && b.invMass === 0) continue;
        const R = a.bound + b.bound, key = a.id < b.id ? a.id + ':' + b.id : b.id + ':' + a.id;
        if (this.ignore.size && this.ignore.has(key)) {
          if (Math.abs(a.x - b.x) > R || Math.abs(a.y - b.y) > R || !collide(a, b).length) this.ignore.delete(key);
          continue;
        }
        if (Math.abs(a.x - b.x) > R || Math.abs(a.y - b.y) > R) continue;
        const cs = collide(a, b);
        if (!cs.length) continue;
        live.add(key);
        this.updateArbiter(key, a, b, cs);
      }
      this.wallContacts(a, live);
    }
    for (const k of this.arbiters.keys()) if (!live.has(k)) this.arbiters.delete(k);
  }

  // Four half-planes as walls: a contact for each corner (or the circle) past one.
  wallContacts(a, live) {
    if (a.invMass === 0) return;
    const W = this.walls;
    const pts = a.shape === 'circle' ? null : corners(a);
    const planes = [[0, 1, W.b, 'b'], [0, -1, -W.t, 't'], [1, 0, W.r, 'r'], [-1, 0, -W.l, 'l']];
    for (const [nx, ny, off, name] of planes) {
      const cs = [];
      if (pts) for (const p of pts) { const s = off - (nx * p.x + ny * p.y); if (s < 0.5) cs.push({ x: p.x, y: p.y, nx: -nx, ny: -ny, sep: s }); }
      else { const s = off - (nx * a.x + ny * a.y) - a.r; if (s < 0.5) cs.push({ x: a.x + nx * a.r, y: a.y + ny * a.r, nx: -nx, ny: -ny, sep: s }); }
      if (!cs.length) continue;
      // normal from the wall (body "a" of the arbiter) into the body
      const key = 'w' + name + ':' + a.id;
      live.add(key);
      this.updateArbiter(key, STATIC, a, cs.map((c) => ({ ...c, nx: -nx, ny: -ny, sep: Math.min(c.sep, 0.5) })), this.wallFriction);
    }
  }

  updateArbiter(key, a, b, cs, friction) {
    const old = this.arbiters.get(key);
    for (const c of cs) {
      c.Pn = 0; c.Pt = 0; c.fresh = true;
      // warm start from last step's impulse at the same place; only a new contact bounces
      if (old) for (const o of old.contacts) if (Math.abs(o.x - c.x) < 4 && Math.abs(o.y - c.y) < 4) { c.Pn = o.Pn; c.Pt = o.Pt; c.fresh = false; break; }
    }
    const f = friction ?? Math.sqrt(a.friction * b.friction);
    const e = this.restitution ?? Math.max(a.restitution ?? 0, b.restitution ?? 0);
    this.arbiters.set(key, { a, b, contacts: cs, friction: f, restitution: e });
  }

  step(dt) {
    const B = this.bodies;
    // forces
    for (const b of B) {
      if (b.invMass === 0) continue;
      b.vx += this.gx * dt; b.vy += this.gy * dt;
      const ld = Math.max(0, 1 - this.linearDamping * dt), ad = Math.max(0, 1 - this.angularDamping * dt);
      b.vx *= ld; b.vy *= ld; b.w *= ad;
    }
    this.contactsFor(dt);
    const inv = 1 / dt;
    // pre-step: masses, bias, knock-loose, warm start
    for (const arb of this.arbiters.values()) {
      const { a, b } = arb;
      for (const c of arb.contacts) {
        const r1x = c.x - (a.x ?? c.x), r1y = c.y - (a.y ?? c.y), r2x = c.x - b.x, r2y = c.y - b.y;
        c.r1x = a === STATIC ? 0 : r1x; c.r1y = a === STATIC ? 0 : r1y; c.r2x = r2x; c.r2y = r2y;
        const rn1 = c.r1x * c.nx + c.r1y * c.ny, rn2 = r2x * c.nx + r2y * c.ny;
        const kn = a.invMass + b.invMass + a.invI * (c.r1x * c.r1x + c.r1y * c.r1y - rn1 * rn1) + b.invI * (r2x * r2x + r2y * r2y - rn2 * rn2);
        c.mn = kn > 0 ? 1 / kn : 0;
        const tx = c.ny, ty = -c.nx, rt1 = c.r1x * tx + c.r1y * ty, rt2 = r2x * tx + r2y * ty;
        const kt = a.invMass + b.invMass + a.invI * (c.r1x * c.r1x + c.r1y * c.r1y - rt1 * rt1) + b.invI * (r2x * r2x + r2y * r2y - rt2 * rt2);
        c.mt = kt > 0 ? 1 / kt : 0;
        const vn = relVel(a, b, c, c.nx, c.ny);
        // a moving body hitting a pinned one hard enough frees it (for the next step)
        if (-vn > this.knockSpeed) {
          if (a.pinned) { a.setPinned(false); this.onKnock?.(a); }
          if (b.pinned) { b.setPinned(false); this.onKnock?.(b); }
        }
        c.bias = -0.2 * inv * Math.min(0, c.sep + 0.5) + (c.fresh && vn < -200 ? -arb.restitution * vn : 0);
        const Px = c.Pn * c.nx + c.Pt * tx, Py = c.Pn * c.ny + c.Pt * ty;
        applyImpulse(a, b, c, Px, Py);
      }
    }
    const J = this.joint;
    if (J) prepareJoint(J, dt);
    for (let it = 0; it < this.iterations; it++) {
      if (J) solveJoint(J, dt);
      for (const arb of this.arbiters.values()) {
        const { a, b } = arb;
        for (const c of arb.contacts) {
          const vn = relVel(a, b, c, c.nx, c.ny);
          let dPn = c.mn * (-vn + c.bias);
          const Pn0 = c.Pn; c.Pn = Math.max(Pn0 + dPn, 0); dPn = c.Pn - Pn0;
          applyImpulse(a, b, c, dPn * c.nx, dPn * c.ny);
          const tx = c.ny, ty = -c.nx;
          const vt = relVel(a, b, c, tx, ty);
          let dPt = c.mt * -vt;
          const maxPt = arb.friction * c.Pn, Pt0 = c.Pt;
          c.Pt = Math.max(-maxPt, Math.min(maxPt, Pt0 + dPt)); dPt = c.Pt - Pt0;
          applyImpulse(a, b, c, dPt * tx, dPt * ty);
        }
      }
    }
    for (const b of B) {
      if (b.invMass === 0) continue;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > this.maxSpeed) { b.vx *= this.maxSpeed / sp; b.vy *= this.maxSpeed / sp; }
      b.w = Math.max(-60, Math.min(60, b.w));
      b.x += b.vx * dt; b.y += b.vy * dt; b.angle += b.w * dt;
    }
  }
}

export function corners(b) {
  const c = Math.cos(b.angle), s = Math.sin(b.angle), out = [];
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const lx = u * b.hw, ly = v * b.hh;
    out.push({ x: b.x + c * lx - s * ly, y: b.y + s * lx + c * ly });
  }
  return out;
}

function relVel(a, b, c, nx, ny) {
  const vbx = b.vx - b.w * c.r2y, vby = b.vy + b.w * c.r2x;
  const vax = a.vx - a.w * c.r1y, vay = a.vy + a.w * c.r1x;
  return (vbx - vax) * nx + (vby - vay) * ny;
}

function applyImpulse(a, b, c, Px, Py) {
  if (a.invMass) { a.vx -= a.invMass * Px; a.vy -= a.invMass * Py; a.w -= a.invI * (c.r1x * Py - c.r1y * Px); }
  if (b.invMass) { b.vx += b.invMass * Px; b.vy += b.invMass * Py; b.w += b.invI * (c.r2x * Py - c.r2y * Px); }
}

function prepareJoint(J, dt) {
  const b = J.body;
  if (b.invMass === 0) return;
  const m = b.mass, om = 2 * Math.PI * J.hz, d = 2 * m * J.damping * om, k = m * om * om;
  let g = dt * (d + dt * k); g = g ? 1 / g : 0;
  J.gamma = g; J.beta = dt * k * g;
  const c = Math.cos(b.angle), s = Math.sin(b.angle);
  J.rx = c * J.lx - s * J.ly; J.ry = s * J.lx + c * J.ly;
  const k11 = b.invMass + b.invI * J.ry * J.ry + g, k12 = -b.invI * J.rx * J.ry, k22 = b.invMass + b.invI * J.rx * J.rx + g;
  const det = k11 * k22 - k12 * k12, id = det ? 1 / det : 0;
  J.m11 = id * k22; J.m12 = -id * k12; J.m22 = id * k11;
  J.cx = (b.x + J.rx - J.tx) * J.beta; J.cy = (b.y + J.ry - J.ty) * J.beta;
  b.w *= 0.98;
  // warm start
  b.vx += b.invMass * J.ix; b.vy += b.invMass * J.iy; b.w += b.invI * (J.rx * J.iy - J.ry * J.ix);
}

function solveJoint(J, dt) {
  const b = J.body;
  if (b.invMass === 0) return;
  const cdx = b.vx - b.w * J.ry, cdy = b.vy + b.w * J.rx;
  const ux = -(cdx + J.cx + J.gamma * J.ix), uy = -(cdy + J.cy + J.gamma * J.iy);
  let ix = J.m11 * ux + J.m12 * uy, iy = J.m12 * ux + J.m22 * uy;
  const ox = J.ix, oy = J.iy; J.ix += ix; J.iy += iy;
  const max = J.maxForce * dt, l = Math.hypot(J.ix, J.iy);
  if (l > max) { J.ix *= max / l; J.iy *= max / l; }
  ix = J.ix - ox; iy = J.iy - oy;
  b.vx += b.invMass * ix; b.vy += b.invMass * iy; b.w += b.invI * (J.rx * iy - J.ry * ix);
}

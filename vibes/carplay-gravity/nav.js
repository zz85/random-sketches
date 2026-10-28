// A drive through an endless made-up city: a grid of streets, a route that turns at corners,
// a speed profile that slows for the turns, and the lateral g that a passenger (or a loose
// app icon) feels. drawMap() paints the heading-up navigation view for the Maps card.

const BLOCK = 90;           // metres between streets
const CORNER = 16;          // corner radius
const VMAX = 14, ALAT = 2.6, ACC = 1.6, BRAKE = 3.2; // m/s, m/s²

const STREETS = ['Pine St', 'Union St', 'Madison St', 'Spring St', 'Seneca St', 'Marion St', 'Cherry St', 'Columbia St', 'Olive Way', 'Stewart St', 'Virginia St', 'Lenora St', 'Blanchard St', 'Bell St', 'Wall St', 'Vine St'];
const AVENUES = ['1st Ave', '2nd Ave', '3rd Ave', '4th Ave', '5th Ave', '6th Ave', '7th Ave', '8th Ave', '9th Ave', 'Westlake Ave', 'Boren Ave', 'Terry Ave', 'Minor Ave', 'Fairview Ave'];
const mod = (a, n) => ((a % n) + n) % n;
const streetName = (dirX, gx, gy) => (dirX ? STREETS[mod(gy, STREETS.length)] : AVENUES[mod(gx, AVENUES.length)]);

function hash(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

export class Drive {
  constructor(seed = 7) {
    this.rand = mulberry(seed);
    this.nodes = [{ gx: 0, gy: 0 }, { gx: 0, gy: -1 }]; // grid nodes the route passes, heading north
    this.samples = []; this.built = 0;
    this.s = 0; this.v = 8; this.aLat = 0; this.aLon = 0; this.heading = -Math.PI / 2; this.viewHeading = -Math.PI / 2;
    this.odo = 12873.4; this.trip = 0; this.etaMin = 23;
    this.extend();
  }
  // straight runs of 1–3 blocks, then a left or right turn (never a U-turn)
  addNode() {
    const n = this.nodes, a = n[n.length - 2], b = n[n.length - 1];
    let dx = b.gx - a.gx, dy = b.gy - a.gy;
    const runLen = n.length < 3 ? 3 : 1 + Math.floor(this.rand() * 3);
    // continue straight runLen-1 more, then turn
    for (let i = 1; i < runLen; i++) n.push({ gx: b.gx + dx * i, gy: b.gy + dy * i });
    const last = n[n.length - 1];
    const turn = this.rand() < 0.5 ? 1 : -1;
    [dx, dy] = [-dy * turn, dx * turn];
    n.push({ gx: last.gx + dx, gy: last.gy + dy });
  }
  // turn nodes into samples every 2 m with rounded corners
  extend() {
    while (this.nodes.length < this.built + 12) this.addNode();
    const N = this.nodes, S = this.samples;
    let prev = S.length ? S[S.length - 1] : null;
    const push = (x, y) => {
      if (prev) {
        const d = Math.hypot(x - prev.x, y - prev.y);
        if (d < 1e-6) return;
        const th = Math.atan2(y - prev.y, x - prev.x);
        const p = { x, y, s: prev.s + d, th };
        if (S.length === 1) S[0].th = th;
        S.push(p); prev = p;
      } else { prev = { x, y, s: 0, th: -Math.PI / 2 }; S.push(prev); }
    };
    for (let i = Math.max(1, this.built); i < N.length - 1; i++) {
      const a = N[i - 1], b = N[i], c = N[i + 1];
      const d1x = Math.sign(b.gx - a.gx), d1y = Math.sign(b.gy - a.gy), d2x = Math.sign(c.gx - b.gx), d2y = Math.sign(c.gy - b.gy);
      const bx = b.gx * BLOCK, by = b.gy * BLOCK;
      const straight = d1x === d2x && d1y === d2y;
      const r = straight ? 0 : CORNER;
      const p0x = bx - d1x * r, p0y = by - d1y * r;
      if (!prev) push(a.gx * BLOCK + d1x * r, a.gy * BLOCK + d1y * r);
      // straight to the corner start
      const L = Math.hypot(p0x - prev.x, p0y - prev.y), n = Math.max(1, Math.round(L / 2));
      const sx = prev.x, sy = prev.y;
      for (let k = 1; k <= n; k++) push(sx + (p0x - sx) * k / n, sy + (p0y - sy) * k / n);
      b.s = prev.s; // distance along the route where this node's corner starts
      if (!straight) {
        const p2x = bx + d2x * r, p2y = by + d2y * r;
        for (let k = 1; k <= 12; k++) {
          const t = k / 12, u = 1 - t;
          push(u * u * p0x + 2 * u * t * bx + t * t * p2x, u * u * p0y + 2 * u * t * by + t * t * p2y);
        }
      }
      b.turn = straight ? 0 : Math.sign(d1x * d2y - d1y * d2x); // +1 right (y down), -1 left
      b.onto = straight ? '' : streetName(d2x !== 0, b.gx, b.gy);
    }
    this.built = N.length - 1;
  }
  at(s) {
    const S = this.samples;
    let lo = 0, hi = S.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m].s <= s) lo = m; else hi = m; }
    const a = S[lo], b = S[hi], t = b.s > a.s ? Math.max(0, Math.min(1, (s - a.s) / (b.s - a.s))) : 0;
    let dth = b.th - a.th; dth = Math.atan2(Math.sin(dth), Math.cos(dth));
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, th: a.th + dth * t, i: lo };
  }
  curvature(s, ds = 3) {
    const a = this.at(s - ds), b = this.at(s + ds);
    let d = b.th - a.th; d = Math.atan2(Math.sin(d), Math.cos(d));
    return d / (2 * ds);
  }
  nextTurn() {
    for (const n of this.nodes) if (n.turn && n.s !== undefined && n.s + CORNER * 0.8 > this.s) return { dist: Math.max(0, n.s - this.s + CORNER), dir: n.turn, onto: n.onto };
    return null;
  }
  update(dt) {
    if (this.samples[this.samples.length - 1].s - this.s < 900) this.extend();
    // brake for the sharpest bend we can reach within stopping distance
    let vT = VMAX;
    for (let d = 0; d < 70; d += 3) {
      const k = Math.abs(this.curvature(this.s + d));
      if (k > 1e-4) vT = Math.min(vT, Math.sqrt(2 * BRAKE * d * 0.6 + ALAT / k));
    }
    const dv = vT - this.v;
    this.aLon = Math.max(-BRAKE, Math.min(ACC, dv * 1.5));
    this.v = Math.max(0, this.v + this.aLon * dt);
    this.s += this.v * dt;
    this.odo += this.v * dt / 1609.34; this.trip += this.v * dt / 1609.34;
    const k = this.curvature(this.s);
    this.aLat = this.v * this.v * k; // + = turning right (y down)
    const p = this.at(this.s);
    this.x = p.x; this.y = p.y; this.heading = p.th;
    let dh = p.th - this.viewHeading; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.viewHeading += dh * Math.min(1, dt * 3);
    // forget what is far behind
    if (this.samples.length > 4000 && this.samples[1000].s < this.s - 300) {
      this.samples.splice(0, 1000);
      this.nodes = this.nodes.filter((n, i) => i >= this.nodes.length - 30 || n.s === undefined || n.s > this.s - 300);
      this.built = this.nodes.length - 1;
    }
  }
}

function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------- the map ----------
// Apple Maps' driving view in plain 2D canvas: a camera behind and above the car, tilted down, and
// the city projected through it. Streets are the ground showing between block polygons, the
// route is a ribbon on the ground, buildings are extruded boxes drawn far to near, and the
// distance fades into a hazy horizon. Ground polygons are clipped at the near plane.

const PAL = {
  dark: { sky: '#1b2029', ground: '#4a515d', major: '#5f6776', block: '#2a2f38', park: '#1d3a2b', water: '#172b47', roof: '#3a404b', sideA: '#30353f', sideB: '#262a32', edge: 'rgba(255,255,255,.05)', label: '#c8ced8', labelHalo: 'rgba(20,24,30,.85)', route: '#2a87ff', routeEdge: '#0f4fb8', fog: '27,32,41' },
  light: { sky: '#dfe6ee', ground: '#ffffff', major: '#fde9a6', block: '#efece5', park: '#c4e6b1', water: '#9fcdf5', roof: '#fbfbfa', sideA: '#e7e5e1', sideB: '#d9d6d1', edge: 'rgba(0,0,0,.05)', label: '#4a4f57', labelHalo: 'rgba(255,255,255,.9)', route: '#1f80ff', routeEdge: '#155bd0', fog: '226,232,240' },
};

export function drawMap(ctx, w, h, drive, { light = false, zoom = 1, carY = 0.74, pitch = 0.82 } = {}) {
  const P = light ? PAL.light : PAL.dark;
  const th = drive.viewHeading, fx = Math.cos(th), fy = Math.sin(th), rx = -fy, ry = fx;
  const back = 150 * zoom, H = 135 * zoom, cph = Math.cos(pitch), sph = Math.sin(pitch), F = h * 1.05, near = 4;
  const Cx = drive.x - fx * back, Cy = drive.y - fy * back;
  // world (x, y, z up) to camera space: right, up, depth
  const cam = (x, y, z = 0) => {
    const dx = x - Cx, dy = y - Cy, fg = dx * fx + dy * fy, rt = dx * rx + dy * ry, dz = z - H;
    return [rt, fg * sph + dz * cph, fg * cph - dz * sph];
  };
  const carC = cam(drive.x, drive.y);
  const cx = w / 2, cy = h * carY + F * carC[1] / carC[2];
  const proj = (q) => [cx + F * q[0] / q[2], cy - F * q[1] / q[2]];
  const horizon = cy - F * Math.tan(pitch);
  // fill a ground polygon given world points, clipped against the near plane
  const ground = (pts, z = 0) => {
    const q = pts.map(([x, y]) => cam(x, y, z)), out = [];
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length], ia = a[2] >= near, ib = b[2] >= near;
      if (ia) out.push(a);
      if (ia !== ib) { const t = (near - a[2]) / (b[2] - a[2]); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, near]); }
    }
    if (out.length < 3) return false;
    ctx.beginPath();
    out.forEach((qq, i) => { const [sx, sy] = proj(qq); i ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); });
    ctx.closePath();
    return true;
  };
  ctx.save();
  ctx.fillStyle = P.ground; ctx.fillRect(0, 0, w, h);
  const R = 900, g0x = Math.floor((drive.x - R) / BLOCK), g1x = Math.ceil((drive.x + R) / BLOCK), g0y = Math.floor((drive.y - R) / BLOCK), g1y = Math.ceil((drive.y + R) / BLOCK);
  const major = (g) => mod(g, 4) === 0, RW = 11, MW = 18;
  const inFront = (x, y, r) => { const dx = x - Cx, dy = y - Cy; return dx * fx + dy * fy > -r && Math.hypot(dx, dy) < R + r; };
  // arterials, a different colour from the side streets
  ctx.fillStyle = P.major;
  for (let gx = g0x; gx <= g1x; gx++) if (major(gx) && ground([[gx * BLOCK - MW / 2, g0y * BLOCK], [gx * BLOCK + MW / 2, g0y * BLOCK], [gx * BLOCK + MW / 2, g1y * BLOCK], [gx * BLOCK - MW / 2, g1y * BLOCK]])) ctx.fill();
  for (let gy = g0y; gy <= g1y; gy++) if (major(gy) && ground([[g0x * BLOCK, gy * BLOCK - MW / 2], [g1x * BLOCK, gy * BLOCK - MW / 2], [g1x * BLOCK, gy * BLOCK + MW / 2], [g0x * BLOCK, gy * BLOCK + MW / 2]])) ctx.fill();
  // blocks; collect the buildings on them
  const boxes = [];
  for (let gx = g0x; gx < g1x; gx++) for (let gy = g0y; gy < g1y; gy++) {
    const mx = (gx + 0.5) * BLOCK, my = (gy + 0.5) * BLOCK;
    if (!inFront(mx, my, BLOCK)) continue;
    const hsh = hash(gx, gy), lake = hash(gx >> 2, gy >> 2) > 0.93, park = !lake && hsh > 0.86;
    const x0 = gx * BLOCK + (major(gx) ? MW : RW) / 2, y0 = gy * BLOCK + (major(gy) ? MW : RW) / 2;
    const x1 = (gx + 1) * BLOCK - (major(gx + 1) ? MW : RW) / 2, y1 = (gy + 1) * BLOCK - (major(gy + 1) ? MW : RW) / 2;
    ctx.fillStyle = lake ? P.water : park ? P.park : P.block;
    if (ground([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])) ctx.fill();
    if (lake || park) continue;
    // lots: 2 × 2, or one big building
    const n = hsh < 0.25 ? 1 : 2, lw = (x1 - x0) / n, lh = (y1 - y0) / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const u = hash(gx * 7 + i * 3, gy * 13 + j * 5), v = hash(gx * 3 - j, gy * 5 + i * 11);
      if (u < 0.12) continue; // a gap: a car park
      const inset = 3 + u * 6, bx0 = x0 + i * lw + inset, by0 = y0 + j * lh + inset, bx1 = x0 + (i + 1) * lw - inset, by1 = y0 + (j + 1) * lh - inset;
      const tall = (major(gx) || major(gx + 1) || major(gy) || major(gy + 1)) ? 1.6 : 1;
      boxes.push({ x0: bx0, y0: by0, x1: bx1, y1: by1, z: (5 + v * v * 22) * tall, d: Math.hypot((bx0 + bx1) / 2 - Cx, (by0 + by1) / 2 - Cy) });
    }
  }
  // the route: a ribbon from just behind the car to the edge of the view
  const S = drive.samples, i0 = Math.max(0, drive.at(drive.s).i - 4);
  const ribbon = (half) => {
    const L = [], Rr = [];
    for (let i = i0; i < S.length && S[i].s < drive.s + 900; i += 1) {
      const sp = S[i], nx = -Math.sin(sp.th), ny = Math.cos(sp.th);
      L.push([sp.x + nx * half, sp.y + ny * half]); Rr.push([sp.x - nx * half, sp.y - ny * half]);
    }
    return L.concat(Rr.reverse());
  };
  ctx.fillStyle = P.routeEdge; if (ground(ribbon(4.6), 0.1)) ctx.fill();
  ctx.fillStyle = P.route; if (ground(ribbon(3.4), 0.2)) ctx.fill();
  // buildings, far to near; only the two walls facing the camera and the roof
  boxes.sort((a, b) => b.d - a.d);
  for (const B of boxes) {
    if (B.d > 700) continue;
    const base = [[B.x0, B.y0], [B.x1, B.y0], [B.x1, B.y1], [B.x0, B.y1]];
    const qb = base.map(([x, y]) => cam(x, y, 0)), qt = base.map(([x, y]) => cam(x, y, B.z));
    if (qb.some((q) => q[2] < near) || qt.some((q) => q[2] < near)) continue;
    const pb = qb.map(proj), pt = qt.map(proj);
    for (let k = 0; k < 4; k++) {
      const a = base[k], b = base[(k + 1) % 4];
      // outward normal of this wall; visible when it faces the camera
      const nx = b[1] - a[1], ny = -(b[0] - a[0]);
      if (((a[0] + b[0]) / 2 - Cx) * nx + ((a[1] + b[1]) / 2 - Cy) * ny >= 0) continue;
      ctx.beginPath(); ctx.moveTo(...pb[k]); ctx.lineTo(...pb[(k + 1) % 4]); ctx.lineTo(...pt[(k + 1) % 4]); ctx.lineTo(...pt[k]); ctx.closePath();
      ctx.fillStyle = Math.abs(nx * rx + ny * ry) > Math.abs(nx * fx + ny * fy) ? P.sideA : P.sideB; ctx.fill();
    }
    ctx.beginPath(); pt.forEach((q, i) => (i ? ctx.lineTo(...q) : ctx.moveTo(...q))); ctx.closePath();
    ctx.fillStyle = P.roof; ctx.fill(); ctx.strokeStyle = P.edge; ctx.lineWidth = 1; ctx.stroke();
  }
  // the route again, faintly, where buildings hide it (as Apple Maps shows it through them)
  ctx.globalAlpha = 0.35; ctx.fillStyle = P.route; if (ground(ribbon(3.4), 0.2)) ctx.fill(); ctx.globalAlpha = 1;
  // haze towards the horizon, and the sky
  const fog = ctx.createLinearGradient(0, horizon, 0, horizon + h * 0.45);
  fog.addColorStop(0, `rgba(${P.fog},1)`); fog.addColorStop(1, `rgba(${P.fog},0)`);
  ctx.fillStyle = fog; ctx.fillRect(0, Math.max(0, horizon), w, h * 0.45);
  if (horizon > 0) { ctx.fillStyle = P.sky; ctx.fillRect(0, 0, w, horizon + 1); }
  // street names along the arterials near the route
  const fs = Math.max(9, h * 0.026);
  ctx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, Helvetica, "Helvetica Neue", Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const label = (x, y, ax, ay, name) => {
    const a = cam(x, y), b = cam(x + ax * 10, y + ay * 10);
    if (a[2] < 40 || b[2] < 40 || a[2] > 700) return;
    const [sx, sy] = proj(a), [tx, ty] = proj(b);
    if (sx < 0 || sx > w || sy < horizon + 12 || sy > h) return;
    let ang = Math.atan2(ty - sy, tx - sx); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
    const sc = Math.max(0.6, Math.min(1.2, 260 / a[2]));
    ctx.save(); ctx.translate(sx, sy); ctx.rotate(ang); ctx.scale(sc, sc * 0.92);
    ctx.strokeStyle = P.labelHalo; ctx.lineWidth = 3; ctx.strokeText(name, 0, 0); ctx.fillStyle = P.label; ctx.fillText(name, 0, 0);
    ctx.restore();
  };
  for (let gx = g0x; gx <= g1x; gx++) if (major(gx)) for (let gy = g0y; gy < g1y; gy++) if (hash(gx, gy * 3) > 0.55) label(gx * BLOCK, (gy + 0.5) * BLOCK, 0, 1, streetName(false, gx, gy));
  for (let gy = g0y; gy <= g1y; gy++) if (major(gy)) for (let gx = g0x; gx < g1x; gx++) if (hash(gx * 5, gy) > 0.55) label((gx + 0.5) * BLOCK, gy * BLOCK, 1, 0, streetName(true, gx, gy));
  // the car: Apple's navigation puck, a blue arrow with a white border lying on the road
  const [px, py] = proj(carC), a = Math.max(9, h * 0.042);
  ctx.save(); ctx.translate(px, py); ctx.scale(1, 0.78);
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.beginPath(); ctx.ellipse(0, a * 0.35, a * 1.1, a * 0.55, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, -a * 1.05); ctx.lineTo(a * 0.82, a * 0.78); ctx.lineTo(0, a * 0.38); ctx.lineTo(-a * 0.82, a * 0.78); ctx.closePath();
  ctx.lineJoin = 'round'; ctx.lineWidth = a * 0.28; ctx.strokeStyle = '#fff'; ctx.stroke();
  const pg = ctx.createLinearGradient(0, -a, 0, a); pg.addColorStop(0, '#4fa4ff'); pg.addColorStop(1, '#0a6cf0');
  ctx.fillStyle = pg; ctx.fill();
  ctx.restore();
  ctx.restore();
}

export const fmtDist = (m) => (m > 300 ? (m / 1609.34).toFixed(1) + ' mi' : Math.round(m * 3.28084 / 50) * 50 + ' ft');

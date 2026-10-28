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

export function drawMap(ctx, w, h, drive, { night = true, scale = null } = {}) {
  const px = scale || Math.max(w, h) / 420; // px per metre
  const col = night
    ? { bg: '#1f2329', block: '#2a2f37', park: '#22382c', water: '#1b2d44', road: '#3d434d', major: '#565e6b', label: '#8b94a3', route: '#2f8bff', routeEdge: '#1b5fc4' }
    : { bg: '#ece8df', block: '#f6f3ec', park: '#cfe5c4', water: '#a9cdee', road: '#ffffff', major: '#fde59a', label: '#6c6f75', route: '#2f7bf5', routeEdge: '#1b5fc4' };
  ctx.save();
  ctx.fillStyle = col.bg; ctx.fillRect(0, 0, w, h);
  const cx = w / 2, cy = h * 0.68;
  ctx.translate(cx, cy);
  ctx.rotate(-Math.PI / 2 - drive.viewHeading);
  ctx.scale(px, px);
  ctx.translate(-drive.x, -drive.y);
  const R = Math.hypot(w, h) / px;
  const g0x = Math.floor((drive.x - R) / BLOCK), g1x = Math.ceil((drive.x + R) / BLOCK);
  const g0y = Math.floor((drive.y - R) / BLOCK), g1y = Math.ceil((drive.y + R) / BLOCK);
  const RW = 9, MW = 14; // road widths
  const major = (g) => mod(g, 4) === 0;
  // blocks
  for (let gx = g0x; gx < g1x; gx++) for (let gy = g0y; gy < g1y; gy++) {
    const hsh = hash(gx, gy), lake = hash(gx >> 2, gy >> 2) > 0.93;
    ctx.fillStyle = lake ? col.water : hsh > 0.86 ? col.park : col.block;
    const x0 = gx * BLOCK + (major(gx) ? MW : RW) / 2, y0 = gy * BLOCK + (major(gy) ? MW : RW) / 2;
    const x1 = (gx + 1) * BLOCK - (major(gx + 1) ? MW : RW) / 2, y1 = (gy + 1) * BLOCK - (major(gy + 1) ? MW : RW) / 2;
    rrect(ctx, x0, y0, x1 - x0, y1 - y0, 4); ctx.fill();
    if (!lake && hsh <= 0.86 && night) { // a few building footprints
      ctx.fillStyle = '#323844';
      const n = 1 + Math.floor(hsh * 4);
      for (let k = 0; k < n; k++) {
        const u = hash(gx * 7 + k, gy * 13 - k), v = hash(gx * 3 - k, gy * 5 + k * 9);
        const bw = 18 + u * 26, bh = 16 + v * 30;
        ctx.fillRect(x0 + 6 + u * (x1 - x0 - bw - 12), y0 + 6 + v * (y1 - y0 - bh - 12), bw, bh);
      }
    }
  }
  // roads
  ctx.lineCap = 'butt';
  for (const pass of [0, 1]) for (let gx = g0x; gx <= g1x; gx++) {
    if (major(gx) !== !!pass) continue;
    ctx.strokeStyle = pass ? col.major : col.road; ctx.lineWidth = pass ? MW : RW;
    ctx.beginPath(); ctx.moveTo(gx * BLOCK, g0y * BLOCK); ctx.lineTo(gx * BLOCK, g1y * BLOCK); ctx.stroke();
  }
  for (const pass of [0, 1]) for (let gy = g0y; gy <= g1y; gy++) {
    if (major(gy) !== !!pass) continue;
    ctx.strokeStyle = pass ? col.major : col.road; ctx.lineWidth = pass ? MW : RW;
    ctx.beginPath(); ctx.moveTo(g0x * BLOCK, gy * BLOCK); ctx.lineTo(g1x * BLOCK, gy * BLOCK); ctx.stroke();
  }
  // route ahead
  const S = drive.samples, i0 = drive.at(drive.s).i;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const [c, lw] of [[col.routeEdge, 11], [col.route, 7.5]]) {
    ctx.strokeStyle = c; ctx.lineWidth = lw; ctx.beginPath(); ctx.moveTo(drive.x, drive.y);
    for (let i = i0 + 1; i < S.length && S[i].s < drive.s + R * 1.2; i++) ctx.lineTo(S[i].x, S[i].y);
    ctx.stroke();
  }
  // street labels, kept upright
  ctx.fillStyle = col.label; ctx.font = '600 7px -apple-system, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const up = Math.PI / 2 + drive.viewHeading;
  for (let gx = g0x; gx <= g1x; gx++) for (let gy = g0y; gy < g1y; gy++) if (hash(gx, gy * 3) > 0.8) {
    ctx.save(); ctx.translate(gx * BLOCK, (gy + 0.5) * BLOCK); ctx.rotate(up); ctx.fillText(streetName(false, gx, gy), 0, 0); ctx.restore();
  }
  for (let gy = g0y; gy <= g1y; gy++) for (let gx = g0x; gx < g1x; gx++) if (hash(gx * 5, gy) > 0.8) {
    ctx.save(); ctx.translate((gx + 0.5) * BLOCK, gy * BLOCK); ctx.rotate(up); ctx.fillText(streetName(true, gx, gy), 0, 0); ctx.restore();
  }
  ctx.restore();
  // the car: an arrow pointing up
  ctx.save(); ctx.translate(cx, cy);
  const a = Math.max(10, Math.min(w, h) * 0.05);
  ctx.fillStyle = 'rgba(47,139,255,0.18)'; ctx.beginPath(); ctx.arc(0, 0, a * 2.2, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, -a); ctx.lineTo(a * 0.75, a * 0.8); ctx.lineTo(0, a * 0.4); ctx.lineTo(-a * 0.75, a * 0.8); ctx.closePath();
  ctx.fillStyle = '#fff'; ctx.strokeStyle = '#1b5fc4'; ctx.lineWidth = a * 0.18; ctx.lineJoin = 'round'; ctx.stroke(); ctx.fill();
  ctx.restore();
}

function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

export const fmtDist = (m) => (m > 300 ? (m / 1609.34).toFixed(1) + ' mi' : Math.round(m * 3.28084 / 50) * 50 + ' ft');

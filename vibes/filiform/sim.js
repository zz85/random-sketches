// sim.js - Filiform: corrosion that grows under a coating as threads, on the CPU (plain JS, no three.js, so
// `node --test test_sim.js` runs it as it is).
//
// Filiform corrosion starts where a coating is broken (a scratch, a chip, a cut edge) and salt is on the metal,
// once the air is humid enough. A filament is a small wet cell under the coating: its head is acidic and
// eats the metal at its front, oxygen comes in through the dry, porous tail it leaves behind, and the product
// lifts the coating into a ridge. The head carries its salt with it, so it keeps going. What makes the pattern:
//  - a head can't grow into dry corrosion product, so filaments don't cross. One that runs into a tail at a
//    glancing angle is turned away (about as a ball bounces), and one that meets it head on stops there;
//  - a head needs the coating over it: at a scratch or the panel's edge it opens to the air and dies;
//  - heads wander (their curvature is a random process along the path), now and then split in two, and
//    sometimes dry out and stop;
//  - humidity sets it all: below a threshold the heads go dormant and dry, near 85% they run fastest, and
//    above about 93% they swell into blisters, so a tail's width records the weather it grew in.
//
// The panel is a grid of NX x NY cells (y up). Per cell: tail (the lifted ridge's profile, 0..~1.1, with faint
// growth bands), head (this frame's heads, a dome), defect (coating gone), salt, birth (days, when the tail was
// laid), rear (0 at a head's front to 1 at its back), act (the head's activity), hue (per filament), owner and
// pathAt (which filament laid it and how far along it was, so a head can tell its own fresh tail from others').
// Every cell a step changes is listed in `dirty` for the renderer.

export const PANEL = { W: 60, H: 40 }; // mm

// v: head speed at its best humidity (mm/day); w: filament widths (mm); branch: splits per mm of path;
// stop: heads that dry out and stop, per mm; rhMin: dormant below it; rhPeak: fastest at it; init: filaments
// started per day per edge cell of a defect at full salt and best humidity
export const PIECES = {
  tinplate: { name: 'Lacquered tinplate', note: 'gold lacquer on tinplate, scribed with an X', metal: 'steel', coat: 'clear',
    v: 0.4, w: [0.22, 0.42], branch: 0.012, stop: 0.006, rhMin: 0.62, rhPeak: 0.86, init: 0.06 },
  frame: { name: 'Painted aluminium', note: 'powder-coated aluminium, sawn and drilled', metal: 'al', coat: 'paint',
    v: 0.2, w: [0.3, 0.6], branch: 0.045, stop: 0.008, rhMin: 0.5, rhPeak: 0.82, init: 0.04 },
  wheel: { name: 'Clear-coated alloy', note: 'clear coat on polished aluminium, stone-chipped and kerbed', metal: 'al', coat: 'clear',
    v: 0.24, w: [0.16, 0.32], branch: 0.035, stop: 0.007, rhMin: 0.5, rhPeak: 0.82, init: 0.06 },
};

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// how the heads respond to the relative humidity rh (0..1): speed (of the best), width (of the filament's own),
// whether they are active, and how far into blistering
export function rhResponse(P, rh) {
  if (rh < P.rhMin) return { speed: 0, width: 0.75, active: false, blister: 0 };
  const t = Math.min(1, (rh - P.rhMin) / (P.rhPeak - P.rhMin));
  let speed = Math.pow(t, 1.4);
  if (rh > P.rhPeak) speed *= 1 - 0.45 * Math.min(1, (rh - P.rhPeak) / (0.97 - P.rhPeak));
  const blister = smooth(0.93, 0.985, rh);
  speed *= 1 - 0.55 * blister;
  return { speed, width: (0.75 + 0.4 * t) * (1 + 1.5 * blister), active: true, blister };
}

export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function makeSim({ NX = 768, piece = 'tinplate', seed = 1, maxAlive = 1200, setup = true } = {}) {
  const NY = Math.round((NX * PANEL.H) / PANEL.W), N = NX * NY, mm = PANEL.W / NX;
  const P = PIECES[piece] || PIECES.tinplate;
  const rnd = mulberry32(seed * 7919 + 13);
  let spare = null;
  const gauss = () => { if (spare !== null) { const s = spare; spare = null; return s; } const u = Math.max(1e-12, rnd()), v = rnd(), r = Math.sqrt(-2 * Math.log(u)); spare = r * Math.sin(6.283185 * v); return r * Math.cos(6.283185 * v); };

  const tail = new Float32Array(N), head = new Float32Array(N), defect = new Float32Array(N), salt = new Float32Array(N);
  const birth = new Float32Array(N), rear = new Float32Array(N), act = new Float32Array(N), hue = new Float32Array(N);
  const owner = new Int32Array(N).fill(-1), pathAt = new Float32Array(N);
  const mark = new Uint8Array(N), dirty = new Int32Array(N);
  let dn = 0;
  const touch = (i) => { if (!mark[i]) { mark[i] = 1; dirty[dn++] = i; } };
  let headCells = new Int32Array(1 << 15), hn = 0;
  const pushHead = (i) => { if (hn >= headCells.length) { const g = new Int32Array(headCells.length * 2); g.set(headCells); headCells = g; } headCells[hn++] = i; };

  const fil = [];
  let alive = [], nextId = 0;
  const S = { now: 0, crossings: 0, moves: 0, born: 0, branched: 0, died: { met: 0, bare: 0, edge: 0, dry: 0 }, covered: 0, defectsChanged: true };
  let sites = new Int32Array(0), siteSalt = new Float32Array(0), saltSum = 0;
  let F = rhResponse(P, 0.85);

  const rebuildSites = () => {
    const s = [], ss = [];
    for (let y = 1; y < NY - 1; y++) for (let x = 1; x < NX - 1; x++) {
      const i = y * NX + x;
      if (defect[i] > 0.35) continue;
      const nb = Math.max(defect[i - 1], defect[i + 1], defect[i - NX], defect[i + NX]);
      if (nb < 0.6) continue;
      const sl = Math.max(salt[i], salt[i - 1], salt[i + 1], salt[i - NX], salt[i + NX]);
      if (sl > 0.01) { s.push(i); ss.push(Math.min(1, sl)); }
    }
    sites = Int32Array.from(s); siteSalt = Float32Array.from(ss); saltSum = 0;
    for (const v of ss) saltSum += v;
    S.defectsChanged = false;
  };

  // ---- what a head at (x, y) can't grow into: dry corrosion product (others', or its own from further back),
  // bare metal, and the outside of the panel
  const obs = (f, x, y) => {
    if (x < 0 || y < 0 || x >= NX || y >= NY) return 1;
    const i = (y | 0) * NX + (x | 0);
    let t = tail[i];
    if (t > 0) {
      const o = owner[i];
      if (o === f.id) { if (f.path - pathAt[i] < 2.5 * f.w + 3) t = 0; }
      else if (f.grace > 0 && (o === f.parent || o === f.sib)) t = 0;
    }
    const d = f.grace > 0 ? 0 : defect[i];
    return t > d ? t : d;
  };

  // ---- the tail: a capsule from a to b, a dome across it (the coating lifted over the product), with faint
  // growth bands along it, written where it is higher than what is there
  const stampTail = (f, ax, ay, bx, by, pa, pb, lift = 1) => {
    const r = f.w * 0.5 + 0.3, R = r + 0.5;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - R)), x1 = Math.min(NX - 1, Math.ceil(Math.max(ax, bx) + R));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - R)), y1 = Math.min(NY - 1, Math.ceil(Math.max(ay, by) + R));
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const t = L2 > 1e-9 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const qx = ax + dx * t, qy = ay + dy * t, d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
      if (d2 >= r * r) continue;
      const pth = pa + (pb - pa) * t;
      const v = Math.sqrt(1 - d2 / (r * r)) * lift * (1 + 0.1 * Math.sin((pth / f.w) * 5.5));
      const i = y * NX + x;
      if (v > tail[i]) {
        if (tail[i] < 0.3 && v >= 0.3) S.covered++;
        tail[i] = v; owner[i] = f.id; pathAt[i] = pth; birth[i] = S.now; hue[i] = f.hue; touch(i);
      }
    }
  };

  // ---- this frame's head: a teardrop, round at the front and drawn out behind, domed across
  const stampHead = (f) => {
    const r = f.w * 0.55 * (0.9 + 0.25 * f.act), L = f.w * (1.2 + 1.1 * f.act);
    const c = Math.cos(f.th), s = Math.sin(f.th), fx = f.x + c * r * 0.45, fy = f.y + s * r * 0.45;
    const R = L + r + 1;
    const x0 = Math.max(0, Math.floor(fx - R)), x1 = Math.min(NX - 1, Math.ceil(fx + R)), y0 = Math.max(0, Math.floor(fy - R)), y1 = Math.min(NY - 1, Math.ceil(fy + R));
    const amp = 0.35 + 0.65 * f.act;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const rx = x + 0.5 - fx, ry = y + 0.5 - fy, u = rx * c + ry * s, v = ry * c - rx * s;
      if (u > 0.3 || u < -L) continue;
      let hw;
      if (u > -r) { const q = u + r; hw = Math.sqrt(Math.max(0, r * r - q * q)); }
      else hw = r * Math.pow(1 - (-u - r) / (L - r), 0.7);
      hw += 0.3;
      if (Math.abs(v) >= hw) continue;
      const val = Math.sqrt(1 - (v * v) / (hw * hw)) * Math.min(1, Math.sqrt(hw / r)) * amp;
      const i = y * NX + x;
      if (val > head[i]) { if (head[i] === 0) pushHead(i); head[i] = val; rear[i] = Math.min(1, Math.max(0, -u / L)); act[i] = f.act; touch(i); }
    }
  };

  const spawn = (x, y, th, w0, parent = -1) => {
    const f = { id: nextId++, x, y, th, om: 0, w0, w: w0 * F.width, v0: 0.75 + 0.5 * rnd(), path: 0, alive: true, act: 1, grace: 0, parent, sib: -1, hue: rnd(), born: S.now, end: null };
    fil.push(f); alive.push(f); S.born++;
    return f;
  };
  const die = (f, why) => {
    if (!f.alive) return;
    f.alive = false; f.end = why; S.died[why]++;
    // a dried head stays as a slightly wider bulb at the end of its tail (not where it opened to the air)
    if (why === 'met' || why === 'dry') stampTail({ ...f, w: f.w * 1.25 }, f.x, f.y, f.x, f.y, f.path, f.path, 1.1);
  };

  // start one at the coating's side of a defect's edge, heading away from the defect, if there's room
  const trySpawn = (i) => {
    const x = i % NX, y = (i / NX) | 0;
    const gx = defect[i + 1] - defect[i - 1], gy = defect[i + NX] - defect[i - NX], gl = Math.hypot(gx, gy);
    if (gl < 1e-3) return null;
    const th = Math.atan2(-gy, -gx) + gauss() * 0.35;
    const w0 = (P.w[0] + rnd() * (P.w[1] - P.w[0])) / mm;
    const sx = x + 0.5 + Math.cos(th) * 0.5, sy = y + 0.5 + Math.sin(th) * 0.5;
    const R = Math.ceil(w0 * 1.15);
    for (let yy = Math.max(0, (sy | 0) - R); yy <= Math.min(NY - 1, (sy | 0) + R); yy++) for (let xx = Math.max(0, (sx | 0) - R); xx <= Math.min(NX - 1, (sx | 0) + R); xx++) {
      const j = yy * NX + xx; if (tail[j] > 0.2 || head[j] > 0.1) return null;
    }
    const f = spawn(sx, sy, th, w0);
    f.grace = w0 * 1.5 + 2;
    stampTail(f, sx, sy, sx, sy, 0, 0, 0.9);
    return f;
  };

  // ---- one filament over dt days: wander, sense ahead, turn away or stop, move, lay tail, maybe split
  const advance = (f, dtD) => {
    f.act += ((F.active ? 1 : 0) - f.act) * Math.min(1, dtD / 0.4);
    const ci = (f.y | 0) * NX + (f.x | 0);
    if (f.grace <= 0 && defect[ci] > 0.55) { die(f, 'bare'); return; }
    let rem = f.v0 * (P.v / mm) * F.speed * dtD;
    const Lc = 10 * f.w + 4, sig = (1 / (26 * f.w)) * Math.sqrt(2 / Lc);
    while (rem > 1e-6 && f.alive) {
      const s = Math.min(rem, 0.5); rem -= s;
      f.w += (f.w0 * F.width - f.w) * Math.min(1, s / (2.5 * f.w));
      f.om += -f.om * (s / Lc) + sig * Math.sqrt(s) * gauss();
      f.th += f.om * s;
      const r = f.w * 0.5, look = r + 1.6;
      // side feelers: turn away from what is close on either side, so it runs along a tail rather than into it
      const ol = obs(f, f.x + Math.cos(f.th + 0.7) * look * 0.9, f.y + Math.sin(f.th + 0.7) * look * 0.9);
      const or = obs(f, f.x + Math.cos(f.th - 0.7) * look * 0.9, f.y + Math.sin(f.th - 0.7) * look * 0.9);
      f.th += (or - ol) * 0.9 * (s / f.w);
      let cx = Math.cos(f.th), cy = Math.sin(f.th);
      const hx = f.x + cx * look, hy = f.y + cy * look, o = obs(f, hx, hy);
      if (o > 0.3) {
        // the obstacle's normal, from its gradient where the head would go
        let nx = obs(f, hx + 1.5, hy) - obs(f, hx - 1.5, hy), ny = obs(f, hx, hy + 1.5) - obs(f, hx, hy - 1.5);
        const nl = Math.hypot(nx, ny);
        if (nl < 1e-4) { nx = cx; ny = cy; } else { nx /= nl; ny /= nl; }
        const cosI = cx * nx + cy * ny;
        if (cosI > 0.97 || (cosI > 0.88 && rnd() < 0.5)) { die(f, 'met'); return; }
        if (cosI > 0) {
          // turned away: the mirror direction, pulled a little toward running along it
          const rx = cx - 2 * cosI * nx, ry = cy - 2 * cosI * ny, tx = -ny * Math.sign(cx * -ny + cy * nx || 1), ty = nx * Math.sign(cx * -ny + cy * nx || 1);
          const k = 0.35 + 0.3 * rnd();
          f.th = Math.atan2(ry * (1 - k) + ty * k, rx * (1 - k) + tx * k); f.om *= 0.2;
          cx = Math.cos(f.th); cy = Math.sin(f.th);
        }
      }
      // a hard check where the head would land: if it is still dry tail, try turning further either way
      if (obs(f, f.x + cx * (s + r * 0.6), f.y + cy * (s + r * 0.6)) > 0.6 && f.grace <= 0) {
        let ok = false;
        const pref = or > ol ? 1 : -1;
        for (const k of [1, -1, 2, -2, 3, -3]) {
          const th = f.th + pref * k * 0.45, tx = Math.cos(th), ty = Math.sin(th);
          if (obs(f, f.x + tx * (s + r * 0.6), f.y + ty * (s + r * 0.6)) <= 0.6) { f.th = th; cx = tx; cy = ty; f.om = 0; ok = true; break; }
        }
        if (!ok) { die(f, 'met'); return; }
      }
      const ax = f.x, ay = f.y, pa = f.path;
      f.x += cx * s; f.y += cy * s; f.path += s; f.grace -= s; S.moves++;
      if (f.x < 0.5 || f.y < 0.5 || f.x > NX - 0.5 || f.y > NY - 0.5) { die(f, 'edge'); return; }
      const ni = (f.y | 0) * NX + (f.x | 0);
      if (f.grace <= 0 && defect[ni] > 0.55) { die(f, 'bare'); return; }
      if (tail[ni] > 0.6 && owner[ni] !== f.id && owner[ni] !== f.parent && owner[ni] !== f.sib) S.crossings++;
      stampTail(f, ax, ay, f.x, f.y, pa, f.path);
      const smm = s * mm;
      if (rnd() < P.stop * smm) { die(f, 'dry'); return; }
      if (alive.length < maxAlive && f.path > 4 * f.w && rnd() < P.branch * smm * (1 + 2 * F.blister)) {
        const a = 0.35 + 0.3 * rnd(), side = rnd() < 0.5 ? 1 : -1;
        const g = spawn(f.x, f.y, f.th + side * a, f.w0 * 0.85, f.id);
        g.w = f.w * 0.85; g.grace = f.w * 2 + 3; g.sib = f.id; g.path = f.path; g.act = f.act;
        f.th -= side * a * 0.6; f.w0 *= 0.88; f.grace = Math.max(f.grace, f.w * 2 + 3); f.sib = g.id;
        S.branched++;
      }
    }
  };

  const clearHeads = () => { for (let k = 0; k < hn; k++) { const i = headCells[k]; head[i] = 0; rear[i] = 0; act[i] = 0; touch(i); } hn = 0; };
  const stampHeads = () => { clearHeads(); for (const f of alive) stampHead(f); };

  // ---- a step of `hours` at relative humidity rh
  const step = (hours, rh) => {
    const dtD = hours / 24;
    S.now += dtD;
    F = rhResponse(P, rh);
    if (S.defectsChanged) rebuildSites();
    if (F.speed > 0 && sites.length && alive.length < maxAlive) {
      const E = P.init * F.speed * dtD * saltSum;
      const n = E > 30 ? Math.max(0, Math.round(E + gauss() * Math.sqrt(E))) : poisson(E);
      for (let k = 0; k < n && alive.length < maxAlive; k++) { const j = (rnd() * sites.length) | 0; if (rnd() < siteSalt[j]) trySpawn(sites[j]); }
    }
    for (const f of alive) if (f.alive) advance(f, dtD);
    alive = alive.filter((f) => f.alive);
    stampHeads();
  };
  const poisson = (E) => { let n = 0, p = Math.exp(-E), c = p; const u = rnd(); while (u > c && n < 60) { n++; p *= E / n; c += p; } return n; };
  // a long step, cut into steps no longer than `maxH` hours
  const run = (hours, rh, maxH = 6) => { while (hours > 1e-9) { const h = Math.min(maxH, hours); step(h, rh); hours -= h; } };

  // ---- tools (cells). A scratch cuts the coating in a groove of radius r and leaves a little salt in it
  const capsule = (ax, ay, bx, by, R, fn) => {
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - R)), x1 = Math.min(NX - 1, Math.ceil(Math.max(ax, bx) + R));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - R)), y1 = Math.min(NY - 1, Math.ceil(Math.max(ay, by) + R));
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5, t = L2 > 1e-9 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const d = Math.hypot(px - ax - dx * t, py - ay - dy * t);
      if (d < R) fn(y * NX + x, d);
    }
  };
  const scratch = (ax, ay, bx, by, r = 0.16 / mm, saltAmt = 0.3) => {
    capsule(ax, ay, bx, by, r + 1, (i, d) => {
      const v = smooth(r + 0.8, r * 0.35, d);
      if (v > defect[i]) { defect[i] = v; touch(i); }
      if (saltAmt * v > salt[i]) { salt[i] = saltAmt * v; touch(i); }
    });
    S.defectsChanged = true;
  };
  // a chip: a ragged round flake of coating gone
  const chip = (x, y, r, saltAmt = 0.5, ragged = 1) => {
    const k1 = rnd() * 6.28, k2 = rnd() * 6.28, a1 = (0.15 + 0.15 * rnd()) * ragged, a2 = 0.1 * rnd() * ragged;
    capsule(x, y, x, y, r * 1.4 + 1, (i, d) => {
      const px = (i % NX) + 0.5 - x, py = ((i / NX) | 0) + 0.5 - y, an = Math.atan2(py, px);
      const rr = r * (1 + a1 * Math.sin(3 * an + k1) + a2 * Math.sin(7 * an + k2));
      const v = smooth(rr + 0.8, rr - 0.8, d);
      if (v > defect[i]) { defect[i] = v; touch(i); }
      if (saltAmt * v > salt[i]) { salt[i] = saltAmt * v; touch(i); }
    });
    S.defectsChanged = true;
  };
  const addSalt = (x, y, r, amt = 0.6) => {
    capsule(x, y, x, y, r, (i, d) => { const v = Math.min(1, salt[i] + amt * Math.exp(-((d / r) ** 2) * 2.5) * (0.6 + 0.8 * rnd())); if (v !== salt[i]) { salt[i] = v; touch(i); } });
    S.defectsChanged = true;
  };
  // the panel's cut edges: coating gone in a band of `bandMm` along the sides listed
  const edges = (sides, bandMm, saltAmt) => {
    const b = bandMm / mm;
    for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
      let d = Infinity;
      if (sides.includes('l')) d = Math.min(d, x + 0.5); if (sides.includes('r')) d = Math.min(d, NX - x - 0.5);
      if (sides.includes('b')) d = Math.min(d, y + 0.5); if (sides.includes('t')) d = Math.min(d, NY - y - 0.5);
      const v = smooth(b + 0.8, b - 0.8, d), i = y * NX + x;
      if (v > defect[i]) { defect[i] = v; salt[i] = Math.max(salt[i], saltAmt * v); touch(i); }
    }
    S.defectsChanged = true;
  };

  // ---- each piece as it comes: where its coating is already broken, and the salt on it
  const at = (xmm, ymm) => [xmm / mm, ymm / mm];
  if (setup) {
    if (piece === 'tinplate') {
      edges('lrtb', 0.2, 0.15);
      // the standard test: an X scribed through the lacquer, then salted
      const [a, b] = at(12, 7), [c, d] = at(48, 33), [e, g] = at(12, 33), [h, k] = at(48, 7);
      scratch(a, b, c, d, 0.14 / mm, 0.9); scratch(e, g, h, k, 0.14 / mm, 0.9);
    } else if (piece === 'frame') {
      edges('l', 0.25, 0.6); // sawn
      const [hx, hy] = at(30, 20); chip(hx, hy, 2.4 / mm, 0.8, 0); // a drilled hole
      for (let n = 0; n < 4; n++) { const [x, y] = at(38 + rnd() * 18, 4 + rnd() * 32); chip(x, y, (0.3 + rnd() * 0.4) / mm, 0.6); }
    } else {
      for (let n = 0; n < 9; n++) { const [x, y] = at(5 + rnd() * 50, 9 + rnd() * 28); chip(x, y, (0.25 + rnd() * 0.55) / mm, 0.7); }
      // a kerb scrape along the bottom: a wavering band of short scratches
      let [x, y] = at(4, 3.2);
      for (let n = 0; n < 40; n++) { const nx = x + (1.3 + rnd()) / mm, ny = Math.max(1.6 / mm, Math.min(5.5 / mm, y + gauss() * 0.4 / mm)); scratch(x, y, nx, ny, (0.12 + rnd() * 0.18) / mm, 0.8); x = nx; y = ny; if (x > 56 / mm) break; }
    }
    rebuildSites();
  }

  // ---- what it adds up to
  const stats = () => {
    let len = 0, longest = 0, active = 0;
    for (const f of fil) { len += f.path; if (f.path > longest) longest = f.path; }
    for (const f of alive) if (f.act > 0.5 && F.speed > 0) active++;
    return { filaments: fil.length, alive: alive.length, active, lengthMm: len * mm, longestMm: longest * mm, covered: S.covered / N, days: S.now, crossings: S.crossings, moves: S.moves, died: { ...S.died }, branched: S.branched };
  };

  return {
    NX, NY, N, mm, P, piece, tail, head, defect, salt, birth, rear, act, hue, owner, pathAt,
    get fil() { return fil; }, get alive() { return alive; }, get now() { return S.now; }, get F() { return F; }, get sites() { return sites.length; },
    step, run, scratch, chip, addSalt, stats, stampHeads, rebuildSites,
    // the cells changed since the last call (the renderer packs them), then forgotten
    takeDirty(fn) { for (let k = 0; k < dn; k++) { const i = dirty[k]; mark[i] = 0; fn(i); } const n = dn; dn = 0; return n; },
    mmToCell: (v) => v / mm,
  };
}

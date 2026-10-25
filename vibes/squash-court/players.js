// Players in metres. With the camera known, every pixel is a known point on the floor or a wall,
// so the court's own surfaces form the background: each surface is cut into ~0.6 m cells and each
// cell's colour is its median (a player covers far less than half a cell's pixels), painted lines
// and surface seams are masked, and what differs from its cell is foreground. A foreground blob is
// a player when its lowest point lands on the floor and its extent there matches a person at that
// spot (the camera says how many pixels 1.75 m is at every floor point); the glass fittings,
// scoreboard graphics and line clutter that also differ are far too small or have no feet.
// The position is the centre of the feet on the floor. In video, a background model kept in court
// coordinates (the camera moves, the court does not) replaces the single-frame cell model.
import { courtModel, W as CW, L as CL } from './court.js';
import { findOverlays } from './overlays.js';

const SURF = ['floor', 'front', 'right', 'left', 'back'];
// surface index -> (u, v) court coordinates on it, and its extent
const extent = [[CW, CL], [CW, 5.64], [CL, 5.64], [CL, 5.64], [CW, 5.64]];
const toUV = (s, X) => (s === 0 ? [X[0], X[1]] : s === 1 ? [X[0], X[2]] : s === 2 || s === 3 ? [X[1], X[2]] : [X[0], X[2]]);

// For every pixel of a w x h grid: which court surface its ray meets first (-1: none) and where.
// Walls the camera stands outside of are glass it looks through, so they are skipped.
export function surfaceMap(cam, w, h) {
  const surf = new Int8Array(w * h).fill(-1), su = new Float32Array(w * h), sv = new Float32Array(w * h), dist = new Float32Array(w * h);
  const C = cam.C, use = [true, C[1] > 0, C[0] > 0, C[0] < CW, C[1] < CL];
  const planes = [[2, 0], [1, 0], [0, 0], [0, CW], [1, CL]];
  const k = cam.w / w; // grid -> camera pixels
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const { o, d } = cam.ray((x + 0.5) * k, (y + 0.5) * k);
    let best = Infinity, bs = -1, bX = null;
    for (let s = 0; s < 5; s++) {
      if (!use[s]) continue;
      const [ax, val] = planes[s]; if (Math.abs(d[ax]) < 1e-9) continue;
      const t = (val - o[ax]) / d[ax]; if (t <= 0 || t >= best) continue;
      const X = [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]], [u, v] = toUV(s, X);
      if (u < -0.02 || v < -0.02 || u > extent[s][0] + 0.02 || v > extent[s][1] + 0.02) continue;
      best = t; bs = s; bX = [u, v];
    }
    const i = y * w + x;
    if (bs >= 0) { surf[i] = bs; su[i] = bX[0]; sv[i] = bX[1]; dist[i] = best; }
  }
  return { surf, su, sv, dist, w, h, k };
}

// Distance (m) from a surface point to the nearest painted line or surface edge on that surface.
function lineMask(model) {
  const segs = [[], [], [], [], []];
  for (const l of model.lines) {
    const s = l.kind === 'floor' ? 0 : l.kind === 'front' ? 1 : l.kind === 'back' ? 4 : l.a[0] === 0 ? 2 : 3;
    segs[s].push([toUV(s, l.a), toUV(s, l.b)]);
  }
  return (s, u, v) => {
    let m = Math.min(u, v, extent[s][0] - u); // edges where surfaces meet (not the open top)
    for (const [[x0, y0], [x1, y1]] of segs[s]) {
      const ex = x1 - x0, ey = y1 - y0, L2 = ex * ex + ey * ey, t = Math.max(0, Math.min(1, ((u - x0) * ex + (v - y0) * ey) / L2));
      m = Math.min(m, Math.hypot(u - x0 - t * ex, v - y0 - t * ey));
    }
    return m;
  };
}


// Downsample RGBA to a w-wide grid (box filter).
function grid(rgba, W, H, w) {
  const k = W / w, h = Math.round(H / k), r = new Float32Array(w * h), g = new Float32Array(w * h), b = new Float32Array(w * h), s = Math.max(1, Math.round(k));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (let j = 0; j < s; j++) { const Y = Math.min(H - 1, Math.floor(y * k) + j); for (let i = 0; i < s; i++) { const o = (Y * W + Math.min(W - 1, Math.floor(x * k) + i)) * 4; sr += rgba[o]; sg += rgba[o + 1]; sb += rgba[o + 2]; n++; } }
    const q = y * w + x; r[q] = sr / n; g[q] = sg / n; b[q] = sb / n;
  }
  return { r, g, b, w, h };
}

const med = (a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };

// Regions judged in a single frame: the floor, the front wall above the tin and the tin band.
// Side and back walls are usually glass with a crowd behind them, so they are not judged.
const region = (s, v, tin) => (s === 0 ? 0 : s === 1 ? (v < tin ? 2 : 1) : -1);

// Background colour per region from the frame itself: a quadratic in the surface coordinates per
// colour channel, fitted by iteratively reweighted least squares with a Tukey weight, so players,
// adverts and reflections (a minority of each region) do not pull it. Returns per-pixel model and
// a per-region noise scale.
function smoothBackground(img, S, ok, tin) {
  const n = S.surf.length, reg = new Int8Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (S.surf[i] >= 0) reg[i] = region(S.surf[i], S.sv[i], tin);
  const model = new Float32Array(n * 3), scale = [40, 40, 40];
  for (let R = 0; R < 3; R++) {
    const idx = []; for (let i = 0; i < n; i++) if (reg[i] === R && ok[i]) idx.push(i);
    if (idx.length < 30) continue;
    const step = Math.max(1, Math.floor(idx.length / 4000)), sub = idx.filter((_, k) => k % step === 0);
    const basis = (i) => { const u = S.su[i] / 6.4 - 0.5, v = S.sv[i] / 6.4 - 0.5; return [1, u, v, u * u, u * v, v * v]; };
    const B = sub.map(basis), ch = [img.r, img.g, img.b];
    let coef = [0, 1, 2].map((c) => [med(sub.map((i) => ch[c][i])), 0, 0, 0, 0, 0]), wts = sub.map(() => 1), sc = 40;
    for (let it = 0; it < 5; it++) {
      coef = [0, 1, 2].map((c) => wls(B, sub.map((i) => ch[c][i]), wts) || coef[c]);
      const res = sub.map((i, k) => { let s = 0; for (let c = 0; c < 3; c++) s += Math.abs(ch[c][i] - dot(coef[c], B[k])); return s; });
      sc = Math.max(6, 1.48 * med(res.slice()));
      wts = res.map((r) => (r < 3 * sc ? (1 - (r / (3 * sc)) ** 2) ** 2 : 0));
    }
    scale[R] = sc;
    for (let i = 0; i < n; i++) if (reg[i] === R) { const b = basis(i); for (let c = 0; c < 3; c++) model[i * 3 + c] = dot(coef[c], b); }
  }
  return { model, scale, reg };
}
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
function wls(B, y, w) {
  const m = B[0].length, A = new Float64Array(m * m), r = new Float64Array(m);
  for (let k = 0; k < B.length; k++) { if (!w[k]) continue; const b = B[k]; for (let i = 0; i < m; i++) { r[i] += w[k] * b[i] * y[k]; for (let j = 0; j < m; j++) A[i * m + j] += w[k] * b[i] * b[j]; } }
  for (let i = 0; i < m; i++) A[i * m + i] += 1e-6;
  return solveN(A, r, m);
}
function solveN(A, b, n) {
  for (let i = 0; i < n; i++) {
    let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r * n + i]) > Math.abs(A[p * n + i])) p = r;
    if (Math.abs(A[p * n + i]) < 1e-12) return null;
    for (let c = 0; c < n; c++) { const t = A[i * n + c]; A[i * n + c] = A[p * n + c]; A[p * n + c] = t; } { const t = b[i]; b[i] = b[p]; b[p] = t; }
    for (let r = i + 1; r < n; r++) { const f = A[r * n + i] / A[i * n + i]; for (let c = i; c < n; c++) A[r * n + c] -= f * A[i * n + c]; b[r] -= f * b[i]; }
  }
  const x = new Array(n); for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i * n + c] * x[c]; x[i] = s / A[i * n + i]; }
  return x;
}

// Background kept across video frames in court coordinates: per surface cell of 5 cm, an
// exponential running mean that only learns where the frame agrees with it (or while it is new),
// so players walking through do not burn into it.
export class CourtBackground {
  constructor(res = 0.05) { this.res = res; this.maps = SURF.map((_, s) => { const nu = Math.ceil(extent[s][0] / res) + 1, nv = Math.ceil(extent[s][1] / res) + 1; return { nu, nv, c: new Float32Array(nu * nv * 3), n: new Uint16Array(nu * nv) }; }); }
  idx(s, u, v) { const m = this.maps[s]; return Math.min(m.nv - 1, Math.max(0, Math.round(v / this.res))) * m.nu + Math.min(m.nu - 1, Math.max(0, Math.round(u / this.res))); }
  get(s, u, v) { const m = this.maps[s], i = this.idx(s, u, v); return m.n[i] >= 4 ? [m.c[i * 3], m.c[i * 3 + 1], m.c[i * 3 + 2]] : null; }
  update(s, u, v, col, fg) {
    const m = this.maps[s], i = this.idx(s, u, v), n = m.n[i];
    if (fg && n >= 8) return; // do not learn players
    const a = 1 / Math.min(n + 1, 30);
    for (let k = 0; k < 3; k++) m.c[i * 3 + k] += (col[k] - m.c[i * 3 + k]) * a;
    if (n < 65535) m.n[i] = n + 1;
  }
}

// Find players. cam is in rgba pixels. Returns { players: [{ X: [x, y], foot: [u, v], box, height, score }], fg, S }
export function detectPlayers(rgba, W, H, cam, opt = {}) {
  const w = opt.width ?? Math.min(640, W), img = grid(rgba, W, H, w), h = img.h;
  const S = opt.surfaces && opt.surfaces.w === w ? opt.surfaces : surfaceMap(cam, w, h);
  const model = courtModel({ tin: opt.tin ?? 0.48 }), nearLine = lineMask(model);
  // pixels that can be judged: on a court surface, clear of painted lines and seams by a line
  // width plus the pixel's own footprint
  // broadcast graphics are not the court: masked, a little larger than found (a caption tab often
  // sits on top of the score bug)
  const hidden = new Uint8Array(w * h), rects = opt.overlays ?? findOverlays(rgba, W, H);
  for (const [x0, y0, x1, y1] of rects) {
    const mx = 0.012 * W, my = 0.2 * (y1 - y0);
    for (let y = Math.max(0, Math.floor((y0 - my) / S.k)); y < Math.min(h, Math.ceil((y1 + 0.01 * H) / S.k)); y++) for (let x = Math.max(0, Math.floor((x0 - mx) / S.k)); x < Math.min(w, Math.ceil((x1 + mx) / S.k)); x++) hidden[y * w + x] = 1;
  }
  if (opt.staticMask) for (let i = 0; i < w * h; i++) if (opt.staticMask(i)) hidden[i] = 1;
  const ok = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (hidden[i]) continue;
    const s = S.surf[i]; if (s < 0) continue;
    const px = S.dist[i] * S.k / cam.f; // metres per grid pixel at that distance (roughly)
    if (nearLine(s, S.su[i], S.sv[i]) > 0.03 + 1.2 * px) ok[i] = 1;
  }
  const bg = opt.background, tin = opt.tin ?? 0.48, sm = bg ? null : smoothBackground(img, S, ok, tin);
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (!ok[i]) continue;
    const s = S.surf[i], col = [img.r[i], img.g[i], img.b[i]];
    let m, thr;
    if (bg) { m = bg.get(s, S.su[i], S.sv[i]); thr = opt.thr ?? 34; }
    else { const R = sm.reg[i]; if (R < 0) continue; m = [sm.model[i * 3], sm.model[i * 3 + 1], sm.model[i * 3 + 2]]; thr = Math.max(opt.thr ?? 36, 3.5 * sm.scale[R]); }
    if (m && Math.abs(col[0] - m[0]) + Math.abs(col[1] - m[1]) + Math.abs(col[2] - m[2]) > thr) fg[i] = 1;
  }
  // masked line pixels between two foreground pixels are foreground too (a leg across a line)
  const fill = dilate(fg, w, h, 1);
  for (let i = 0; i < w * h; i++) if (!ok[i] && !hidden[i] && S.surf[i] >= 0 && fill[i]) fg[i] = 1;
  if (bg) for (let i = 0; i < w * h; i++) if (S.surf[i] >= 0) bg.update(S.surf[i], S.su[i], S.sv[i], [img.r[i], img.g[i], img.b[i]], fill[i]);
  // thin vertical structures (glass panel joints, door frames, racket shafts) are one or two grid
  // pixels wide: an opening across removes them, then a closing along re-joins limbs
  const clean = closeV(openH(fg, w, h), w, h, 2);
  const out = findPeople(clean, S, cam, w, h, hidden, opt);
  // inside the court (with a margin for a lunge into the corner)
  const players = out.filter((p) => p.X[0] > -0.15 && p.X[0] < CW + 0.15 && p.X[1] > 0.05 && p.X[1] < CL + 0.15);
  return { players, fg: clean, hidden, overlays: rects, S, w, h };
}


// Occupancy over the floor (after Fleuret et al.'s probabilistic occupancy map, greedily): a person
// standing at floor point X fills a known box in the image, 0.6 m wide and 1.75 m tall seen from
// the camera. Every 10 cm of the court is scored by how much of its box is foreground (an integral
// image makes each box O(1)); the best is taken, its feet found exactly, its pixels explained away,
// and the next best taken. Fragmented silhouettes (skin the colour of the floor, white shorts on a
// white wall) still fill a box, where connected components would split them.
function findPeople(fg0, S, cam, w, h, hidden, opt) {
  const fg = fg0.slice(), out = [], Ih = integral(hidden, w, h);
  const g = (u) => [u[0] / S.k - 0.5, u[1] / S.k - 0.5];
  const boxAt = (x, y, half = 0.3, top = 1.75) => {
    let px = -(y - cam.C[1]), py = x - cam.C[0]; const pl = Math.hypot(px, py) || 1; px *= half / pl; py *= half / pl;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, fy = 0, fx = 0;
    for (const [z, s] of [[0, -1], [0, 1], [top, -1], [top, 1]]) {
      const u = cam.project([x + s * px, y + s * py, z]); if (!(u[2] > 0)) return null;
      const q = g(u); x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    const f = g(cam.project([x, y, 0])); fx = f[0]; fy = f[1];
    return { x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1), fx, fy };
  };
  for (let n = 0; n < 8 && out.length < (opt.max ?? 2); n++) {
    // fills count only what can be seen: a box whose bottom is behind a graphic is judged by the
    // rest of it (Ih: the hidden pixels)
    const I = integral(fg, w, h), sum = (x0, y0, x1, y1) => { x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w - 1, x1); y1 = Math.min(h - 1, y1); if (x1 < x0 || y1 < y0) return [0, 1, 1]; const W1 = w + 1, q = (J) => J[(y1 + 1) * W1 + x1 + 1] - J[y0 * W1 + x1 + 1] - J[(y1 + 1) * W1 + x0] + J[y0 * W1 + x0], A = (x1 - x0 + 1) * (y1 - y0 + 1); return [q(I), Math.max(1, A - q(Ih)), A]; };
    let best = null;
    for (let y = -0.2; y <= CL + 0.2; y += 0.1) for (let x = -0.2; x <= CW + 0.2; x += 0.1) {
      const B = boxAt(x, y); if (!B || B.y1 - B.y0 < 6) continue;
      if (B.fx < 1 || B.fy < 1 || B.fx > w - 2 || B.fy > h - 2) continue; // feet in the frame
      const H = B.y1 - B.y0, hb = Math.max(1, Math.round(H * 0.25)), hn = Math.max(1, Math.round(H * 0.1));
      const [s, a, A0] = sum(B.x0, B.y0, B.x1, B.y1), [sb, ab, Ab] = sum(B.x0, B.y1 - hb, B.x1, B.y1), [sn, an, An] = sum(B.x0, B.y1 + 1, B.x1, B.y1 + hn);
      if (a < 0.45 * A0) continue; // mostly behind a graphic
      const part = a < 0.8 * A0 || ab < 0.8 * Ab; // partly behind a graphic: judge the visible part
      const f = s / (part ? a : A0), fb = part ? (ab < 0.4 * Ab ? f : sb / ab) : sb / Ab, fn = part ? (an < 0.4 * An ? 0 : sn / an) : sn / An;
      if (f < (opt.minFill ?? 0.25) || fb < 0.12) continue;
      // the box should hold the person and stand on floor: a box too far back (too small, high in
      // the image) has legs below it, one too near has floor in its bottom quarter
      const score = f * Math.min(1, fb / 0.3) * (1 - 0.8 * Math.min(1, fn / Math.max(0.05, fb)));
      if (!best || score > best.score) best = { x, y, B, score };
    }
    if (!best) break;
    const P = refineFeet(fg, S, cam, w, h, hidden, best, boxAt, opt);
    // explain the person away: clear their box (the coarse one and the refined one)
    for (const B of [best.B, P && P.B].filter(Boolean)) for (let y = Math.max(0, B.y0); y <= Math.min(h - 1, B.y1); y++) for (let x = Math.max(0, B.x0); x <= Math.min(w - 1, B.x1); x++) fg[y * w + x] = 0;
    if (opt.debug) opt.debug.push({ x: best.x, y: best.y, score: best.score, ok: !!P && !P.why, why: P && P.why });
    if (P && !P.why) out.push(P);
  }
  return out;
}

// From a coarse occupancy hit, the feet: in the central columns of the person's box, follow the
// foreground down from the body (gaps up to a third of a person allowed: a leg the colour of the
// floor) to its lowest pixels, and average their floor points.
function refineFeet(fg, S, cam, w, h, hidden, hit, boxAt, opt) {
  const B = hit.B, Hp = B.y1 - B.y0, cx0 = Math.round(B.x0 + 0.2 * (B.x1 - B.x0)), cx1 = Math.round(B.x1 - 0.2 * (B.x1 - B.x0));
  const rowHas = (y) => { let n = 0; for (let x = Math.max(0, cx0); x <= Math.min(w - 1, cx1); x++) if (fg[y * w + x]) n++; return n; };
  const rowHidden = (y) => { for (let x = Math.max(0, cx0); x <= Math.min(w - 1, cx1); x++) if (hidden[y * w + x]) return true; return false; };
  let y = Math.round(B.y0 + 0.5 * Hp), last = -1, gap = 0;
  while (y > B.y0 && rowHidden(y)) y--; // the box's middle is behind a graphic: start above it
  let lim = Math.min(h, B.y1 + 0.3 * Hp);
  for (; y < lim; y++) {
    if (rowHas(y) >= 2) { last = y; gap = 0; continue; }
    if (rowHidden(y)) {
      // a graphic across the legs: the feet may show below it (a player in front of the score bug)
      let y2 = y; while (y2 < h && rowHidden(y2)) y2++;
      let below = -1; for (let yy = y2; yy < Math.min(h, y2 + Math.max(3, 0.15 * Hp)); yy++) if (rowHas(yy) >= 2) { below = yy; break; }
      if (below >= 0 && last >= 0 && below - last < 0.7 * Hp) { y = below - 1; gap = 0; lim = Math.min(h, Math.max(lim, below + 0.3 * Hp)); continue; }
    }
    if (++gap > Math.max(3, 0.15 * Hp)) break;
  }
  if (last < 0) return { why: 'no fg below' };
  if (last >= h - 2) return { why: 'feet below frame' }; // the feet are below the frame
  // a graphic right below: the feet may be behind it, unless the person above is complete
  let atGraphic = false;
  for (let x = Math.max(0, cx0); x <= Math.min(w - 1, cx1); x++) if (hidden[Math.min(h - 1, last + 2) * w + x]) atGraphic = true;
  // floor points of the lowest foreground in the band (the bottom outline)
  let fx = 0, fy = 0, n = 0;
  for (let yy = last; yy >= last - 2; yy--) for (let x = Math.max(0, cx0 - 2); x <= Math.min(w - 1, cx1 + 2); x++) { const i = yy * w + x; if (fg[i] && S.surf[i] === 0 && (yy === h - 1 || !fg[i + w])) { fx += S.su[i]; fy += S.sv[i]; n++; } }
  if (!n) return { why: 'feet not on floor' };
  let X = [fx / n, fy / n];
  const gx = X[0] - cam.C[0], gy = X[1] - cam.C[1], gl = Math.hypot(gx, gy) || 1; X = [X[0] + 0.1 * gx / gl, X[1] + 0.1 * gy / gl];
  const R = boxAt(X[0], X[1]); if (!R) return null;
  // the person's extent above the feet, within the box
  let top = last; for (let yy = last; yy >= Math.max(0, R.y0 - 0.15 * (R.y1 - R.y0)); yy--) if (rowHas(yy)) top = yy;
  const H = R.y1 - R.y0, tall = (last - top) / Math.max(1, H) * 1.75;
  // how much of a person above these feet is on judged pixels at all
  let avail = 0; for (let yy = last; yy >= Math.max(0, last - H); yy--) { const sf = S.surf[yy * w + Math.round(R.fx)]; if (sf !== 0 && sf !== 1) break; avail = last - yy; }
  // a graphic right below: if the lowest visible pixels are the shins, the person above them is
  // too tall for feet there (standing further away makes them smaller). Then place them by the head:
  // toward the camera along the ground (lower in the image), where a 1.72 m person's head lands on
  // the observed top row, with the feet still hidden.
  let top2 = last; for (let yy = last; yy >= Math.max(0, Math.round(Math.min(B.y0, R.y0) - 0.4 * Hp)); yy--) if (rowHas(yy)) top2 = yy;
  if (atGraphic && (last - top2) / Math.max(1, H) * 1.75 > 2.05) {
    let bestS = null, bd = Infinity;
    for (let s = 0; s <= 4; s += 0.05) {
      const Xs = [X[0] - s * gx / gl, X[1] - s * gy / gl], hu = cam.project([Xs[0], Xs[1], 1.72]), fu = cam.project([Xs[0], Xs[1], 0]);
      if (!(hu[2] > 0 && fu[2] > 0) || fu[1] / S.k < last - 1) continue;
      const d = Math.abs(hu[1] / S.k - 0.5 - top2); if (d < bd) { bd = d; bestS = Xs; }
    }
    if (!bestS) return { why: 'graphic' };
    const R2 = boxAt(bestS[0], bestS[1]); if (!R2) return null;
    return { X: bestS, foot: cam.project([bestS[0], bestS[1], 0]).slice(0, 2), height: 1.72, occluded: true, score: hit.score, B: R2, box: [R2.x0 * S.k, R2.y0 * S.k, (R2.x1 + 1) * S.k, (R2.y1 + 1) * S.k] };
  }
  const need = Math.min(opt.minTall ?? 0.42 * 1.75, 0.8 * avail / H * 1.75);
  if (tall < need || need < 0.2) return { why: `tall ${tall.toFixed(2)} need ${need.toFixed(2)}` };
  return { X, foot: cam.project([X[0], X[1], 0]).slice(0, 2), height: tall, score: hit.score, B: R, box: [R.x0 * S.k, R.y0 * S.k, (R.x1 + 1) * S.k, (R.y1 + 1) * S.k] };
}

function integral(m, w, h) {
  const W1 = w + 1, I = new Int32Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += m[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row; } }
  return I;
}
function openH(m, w, h) { // erode then dilate with a 1x3 horizontal element
  const e = new Uint8Array(w * h), o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; e[i] = m[i] & m[i - 1] & m[i + 1]; }
  for (let y = 0; y < h; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; o[i] = e[i] | e[i - 1] | e[i + 1]; }
  return o;
}
function closeV(m, w, h, r) { // dilate then erode with a (2r+1)x1 vertical element
  const d = new Uint8Array(w * h), o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let j = -r; j <= r && !v; j++) { const Y = y + j; if (Y >= 0 && Y < h) v = m[Y * w + x]; } d[y * w + x] = v; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 1; for (let j = -r; j <= r && v; j++) { const Y = y + j; if (Y >= 0 && Y < h) v = d[Y * w + x]; } o[y * w + x] = v; }
  return o;
}

function bbox(px, w, k) { let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1; for (const i of px) { const x = i % w, y = (i / w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } return [x0 * k, y0 * k, (x1 + 1) * k, (y1 + 1) * k]; }

function dilate(m, w, h, r) {
  const o = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (m[y * w + x]) for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const X = x + i, Y = y + j; if (X >= 0 && Y >= 0 && X < w && Y < h) o[Y * w + X] = 1; }
  return o;
}

// Connected components of `mask`, each listing the pixels of `keep` inside it.
function components(mask, keep, w, h) {
  const lab = new Int32Array(w * h).fill(-1), out = [], st = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    const px = []; lab[i] = out.length; st.push(i);
    while (st.length) {
      const j = st.pop(); if (keep[j]) px.push(j);
      const x = j % w, y = (j / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const n = Y * w + X; if (mask[n] && lab[n] < 0) { lab[n] = out.length; st.push(n); } }
    }
    out.push({ px });
  }
  return out;
}

// Two-player identity across frames: assign detections to tracks by the cheaper of the two
// pairings, smooth each track with a constant-velocity filter, and coast a track briefly when its
// player is hidden.
export class PlayerTracker {
  constructor() { this.tracks = []; }
  update(dets, t) {
    const T = this.tracks;
    for (const k of T) { const dt = t - k.t; k.pred = [k.X[0] + k.v[0] * dt, k.X[1] + k.v[1] * dt]; }
    const used = new Set(), cost = (k, d) => Math.hypot(k.pred[0] - d.X[0], k.pred[1] - d.X[1]);
    // greedy by cost is exact for two tracks and two detections
    const pairs = [];
    for (const k of T) for (const d of dets) pairs.push([cost(k, d), k, d]);
    pairs.sort((a, b) => a[0] - b[0]);
    const done = new Set();
    for (const [c, k, d] of pairs) {
      if (done.has(k) || used.has(d) || c > 2.2) continue;
      const dt = Math.max(1e-3, t - k.t), a = 0.5, nv = [(d.X[0] - k.X[0]) / dt, (d.X[1] - k.X[1]) / dt];
      k.X = [k.pred[0] + a * (d.X[0] - k.pred[0]), k.pred[1] + a * (d.X[1] - k.pred[1])];
      k.v = [k.v[0] * 0.6 + nv[0] * 0.4, k.v[1] * 0.6 + nv[1] * 0.4].map((v) => Math.max(-7, Math.min(7, v)));
      k.t = t; k.miss = 0; k.det = d; done.add(k); used.add(d);
    }
    for (const k of T) if (!done.has(k)) { k.miss++; k.det = null; k.X = k.pred; k.t = t; k.v = k.v.map((v) => v * 0.7); }
    // a coasting (or noisy) track stays in the court and stops at its walls
    for (const k of T) { const c = [Math.max(-0.1, Math.min(CW + 0.1, k.X[0])), Math.max(0.1, Math.min(CL + 0.1, k.X[1]))]; if (c[0] !== k.X[0]) k.v[0] = 0; if (c[1] !== k.X[1]) k.v[1] = 0; k.X = c; }
    this.tracks = T.filter((k) => k.miss < 12);
    for (const d of dets) if (!used.has(d) && this.tracks.length < 2) this.tracks.push({ id: this.nextId(), X: d.X.slice(), v: [0, 0], t, miss: 0, det: d });
    return this.tracks.map((k) => ({ id: k.id, X: k.X.slice(), v: k.v.slice(), seen: k.miss === 0, occluded: !!k.det?.occluded }));
  }
  nextId() { const ids = new Set(this.tracks.map((k) => k.id)); let i = 1; while (ids.has(i)) i++; return i; }
}

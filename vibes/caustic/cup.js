/*
 * cup.js - the bright curve in a coffee cup. Light falls over the rim, reflects off the inside wall, and the
 * reflected rays crowd together along a curve: the caustic, the envelope of the reflected rays. Parallel sunlight
 * in a round cup gives a nephroid with its cusp halfway to the centre; a lamp on the rim gives a cardioid. Every
 * ray is traced here (bounce after bounce) and drawn with additive light, so the curve appears on its own; the
 * envelope can also be drawn exactly, from where each reflected ray crosses its neighbour.
 */
const cv = document.getElementById('cv'), g = cv.getContext('2d');
const lightCv = document.createElement('canvas'), lg = lightCv.getContext('2d');
const Q = new URLSearchParams(location.search);
let W = 0, H = 0, dpr = 1, scale = 1, cx = 0, cy = 0;

const st = {
  shape: 'cup', light: 'sun', sunAng: -0.35, lamp: [Math.cos(2.4), Math.sin(2.4)], bounces: 2, raysExp: 13,
  env: false, move: false, drawn: null,
};

// ---------------------------------------------------------------- mirrors: polylines with smooth normals

function shapePoints(name) {
  const P = [], N = 900;
  if (name === 'cup') for (let k = 0; k < N; k++) { const a = k / N * 2 * Math.PI; P.push([Math.cos(a), Math.sin(a)]); }
  if (name === 'ellipse') for (let k = 0; k < N; k++) { const a = k / N * 2 * Math.PI; P.push([1.15 * Math.cos(a), 0.8 * Math.sin(a)]); }
  if (name === 'flower') for (let k = 0; k < N; k++) { const a = k / N * 2 * Math.PI, r = 0.92 + 0.12 * Math.cos(5 * a); P.push([r * Math.cos(a), r * Math.sin(a)]); }
  if (name === 'heart') for (let k = 0; k < N; k++) { // a cardioid, its cusp pointing in, turned upright
    const a = k / N * 2 * Math.PI, r = 0.62 * (1 - Math.sin(a)); P.push([r * Math.cos(a), r * Math.sin(a) + 0.62]);
  }
  if (name === 'parabola') { for (let k = 0; k <= N; k++) { const x = -1.15 + 2.3 * k / N; P.push([x, 0.75 * x * x - 0.75]); } return { P, closed: false }; } // focus at y = -0.75 + 1/3
  if (name === 'draw') return st.drawn ? { P: st.drawn, closed: false } : shapePoints('cup');
  return { P, closed: true };
}
let mirror = null;
function buildMirror() {
  const { P, closed } = shapePoints(st.shape), n = P.length, segs = [];
  // vertex normals (to the left of the direction of travel; CCW closed shapes: inward)
  const vn = P.map((p, i) => {
    const a = P[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = P[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l];
  });
  const m = closed ? n : n - 1;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % n; segs.push({ a: P[i], b: P[j], na: vn[i], nb: vn[j], i });
    for (const p of [P[i], P[j]]) { minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]); maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]); }
  }
  // a uniform grid over the segments, for ray marching
  const G = 64, pad = 1e-3; minx -= pad; miny -= pad; maxx += pad; maxy += pad;
  const cell = [], cw = (maxx - minx) / G, ch = (maxy - miny) / G;
  for (let k = 0; k < G * G; k++) cell.push([]);
  segs.forEach((s, k) => {
    const i0 = Math.floor((Math.min(s.a[0], s.b[0]) - minx) / cw), i1 = Math.floor((Math.max(s.a[0], s.b[0]) - minx) / cw);
    const j0 = Math.floor((Math.min(s.a[1], s.b[1]) - miny) / ch), j1 = Math.floor((Math.max(s.a[1], s.b[1]) - miny) / ch);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cell[j * G + i].push(k);
  });
  mirror = { P, closed, segs, G, cell, minx, miny, cw, ch, R: Math.max(Math.hypot(minx, miny), Math.hypot(maxx, maxy), Math.hypot(minx, maxy), Math.hypot(maxx, miny)) };
}

// first hit of ray o + t d (t > eps) with the mirror: { t, x, y, nx, ny, seg } (n interpolated, unnormalised side)
let stamp = 0; const seen = new Int32Array(8192);
function hit(ox, oy, dx, dy, skip) {
  const M = mirror, G = M.G;
  // enter the grid box
  let t0 = 0, t1 = 1e9;
  for (const [o, d, lo, hi] of [[ox, dx, M.minx, M.minx + G * M.cw], [oy, dy, M.miny, M.miny + G * M.ch]]) {
    if (Math.abs(d) < 1e-12) { if (o < lo || o > hi) return null; continue; }
    let a = (lo - o) / d, b = (hi - o) / d; if (a > b) [a, b] = [b, a]; t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  if (t0 > t1) return null;
  const sx = ox + dx * (t0 + 1e-9), sy = oy + dy * (t0 + 1e-9);
  let i = Math.min(G - 1, Math.max(0, Math.floor((sx - M.minx) / M.cw))), j = Math.min(G - 1, Math.max(0, Math.floor((sy - M.miny) / M.ch)));
  const stepI = dx > 0 ? 1 : -1, stepJ = dy > 0 ? 1 : -1;
  const nextX = M.minx + (i + (dx > 0 ? 1 : 0)) * M.cw, nextY = M.miny + (j + (dy > 0 ? 1 : 0)) * M.ch;
  let tMaxX = Math.abs(dx) < 1e-12 ? Infinity : (nextX - ox) / dx, tMaxY = Math.abs(dy) < 1e-12 ? Infinity : (nextY - oy) / dy;
  const tdX = Math.abs(dx) < 1e-12 ? Infinity : M.cw / Math.abs(dx), tdY = Math.abs(dy) < 1e-12 ? Infinity : M.ch / Math.abs(dy);
  stamp++; if (seen.length < M.segs.length) throw new Error('too many segments');
  for (let guard = 0; guard < 4 * G; guard++) {
    let best = null;
    for (const k of M.cell[j * G + i]) {
      if (k === skip || seen[k] === stamp) continue; seen[k] = stamp;
      const s = M.segs[k], ex = s.b[0] - s.a[0], ey = s.b[1] - s.a[1];
      const den = dx * ey - dy * ex; if (Math.abs(den) < 1e-14) continue;
      const qx = s.a[0] - ox, qy = s.a[1] - oy, t = (qx * ey - qy * ex) / den, u = (qx * dy - qy * dx) / den;
      if (t > 1e-7 && u >= 0 && u <= 1 && (!best || t < best.t)) best = { t, u, k };
    }
    if (best && best.t <= Math.min(tMaxX, tMaxY) + 1e-9) {
      const s = M.segs[best.k], u = best.u, nx = s.na[0] * (1 - u) + s.nb[0] * u, ny = s.na[1] * (1 - u) + s.nb[1] * u, l = Math.hypot(nx, ny);
      return { t: best.t, x: ox + dx * best.t, y: oy + dy * best.t, nx: nx / l, ny: ny / l, seg: best.k };
    }
    if (tMaxX < tMaxY) { i += stepI; tMaxX += tdX; } else { j += stepJ; tMaxY += tdY; }
    if (i < 0 || j < 0 || i >= G || j >= G) return best ? null : null;
  }
  return null;
}

// ---------------------------------------------------------------- tracing

function sources(N) {
  const out = [];
  if (st.light === 'sun') {
    const dx = Math.cos(st.sunAng), dy = Math.sin(st.sunAng), R = mirror.R * 1.02;
    for (let k = 0; k < N; k++) { const s = -R + 2 * R * (k + 0.5) / N; out.push([-dx * (R + 0.4) - dy * s, -dy * (R + 0.4) + dx * s, dx, dy]); }
  } else for (let k = 0; k < N; k++) { const a = (k + 0.5) / N * 2 * Math.PI; out.push([st.lamp[0], st.lamp[1], Math.cos(a), Math.sin(a)]); }
  return out;
}

// paths[b] = flat list of segments for bounce b (0 = the incoming light), and the first reflections for the envelope
function trace() {
  const N = 2 ** st.raysExp, B = st.bounces, paths = Array.from({ length: B + 1 }, () => []), first = [];
  let count = 0;
  for (const [sx, sy, sdx, sdy] of sources(N)) {
    let ox = sx, oy = sy, dx = sdx, dy = sdy, skip = -1, b = 0, entered = !mirror.closed || st.light === 'lamp' && inside(sx, sy), refl = null;
    for (let step = 0; step < B + 4 && b <= B; step++) {
      const h = hit(ox, oy, dx, dy, skip);
      if (!h) { const L = 6; if (entered || !mirror.closed) paths[b].push(ox, oy, ox + dx * L, oy + dy * L); break; }
      const dn = dx * h.nx + dy * h.ny;
      if (mirror.closed && dn > 0) { // meeting the wall from outside: light passes over the rim
        ox = h.x; oy = h.y; skip = h.seg; entered = true; continue;
      }
      if (entered || !mirror.closed) paths[b].push(ox, oy, h.x, h.y);
      // reflect
      const rx = dx - 2 * dn * h.nx, ry = dy - 2 * dn * h.ny;
      if (b === 0) refl = [h.x, h.y, rx, ry];
      ox = h.x; oy = h.y; dx = rx; dy = ry; skip = h.seg; b++;
    }
    first.push(refl); count++;
  }
  return { paths, first, count };
}
function inside(x, y) { // even-odd over the polygon
  const P = mirror.P; let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) if ((P[i][1] > y) !== (P[j][1] > y) && x < (P[j][0] - P[i][0]) * (y - P[i][1]) / (P[j][1] - P[i][1]) + P[i][0]) c = !c;
  return c;
}
// the envelope of the first reflected rays: where each crosses the next
function envelope(first) {
  const pts = [];
  for (let k = 0; k + 1 < first.length; k++) {
    const a = first[k], b = first[k + 1]; if (!a || !b) { pts.push(null); continue; }
    const den = a[2] * b[3] - a[3] * b[2]; if (Math.abs(den) < 1e-12) { pts.push(null); continue; }
    const t = ((b[0] - a[0]) * b[3] - (b[1] - a[1]) * b[2]) / den;
    if (t < 0 || t > 4 || Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.05) { pts.push(null); continue; }
    pts.push([a[0] + a[2] * t, a[1] + a[3] * t]);
  }
  return pts;
}

// ---------------------------------------------------------------- drawing

const X = (x) => cx + x * scale, Y = (y) => cy - y * scale;
let last = null, acc = null, img = null;
// adds weight `k` per pixel of length along the segment, bilinearly; with `rc`, only within sqrt(rc) of the middle
function splat(x0, y0, x1, y1, k, w, h, rc) {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy), n = Math.ceil(L); if (n < 1) return;
  const sx = dx / n, sy = dy / n, kk = k * L / n;
  let x = x0 + sx * 0.5, y = y0 + sy * 0.5;
  for (let i = 0; i < n; i++, x += sx, y += sy) {
    if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) continue;
    if (rc && ((x - cx) ** 2 + (y - cy) ** 2) / (scale * scale) > rc) continue;
    const ix = x | 0, iy = y | 0, fx = x - ix, fy = y - iy, o = iy * w + ix;
    acc[o] += kk * (1 - fx) * (1 - fy); acc[o + 1] += kk * fx * (1 - fy); acc[o + w] += kk * (1 - fx) * fy; acc[o + w + 1] += kk * fx * fy;
  }
}
function draw() {
  const T = trace(); last = T;
  // the light, added up in floating point (one splat per pixel along each ray), then tone-mapped
  const w = lightCv.width, h = lightCv.height;
  if (!acc || acc.length !== w * h) { acc = new Float32Array(w * h); img = lg.createImageData(w, h); }
  acc.fill(0);
  const N = T.count, beamPx = (st.light === 'sun' ? 2 * mirror.R : 2 * Math.PI * 0.6) * scale, unit = beamPx / N;
  const Rc = (mirror.R * 1.25) ** 2;
  T.paths.forEach((p, b) => {
    const k = unit * (b === 0 ? 0.3 : 0.85 ** (b - 1));
    for (let q = 0; q < p.length; q += 4) splat(X(p[q]), Y(p[q + 1]), X(p[q + 2]), Y(p[q + 3]), k, w, h, b === 0 && !mirror.closed ? Rc : 0);
  });
  const d = img.data, gain = 0.32;
  for (let i = 0; i < w * h; i++) { const v = 1 - Math.exp(-gain * acc[i]); d[4 * i] = 255 * v; d[4 * i + 1] = 228 * v ** 1.1; d[4 * i + 2] = 175 * v ** 1.3; d[4 * i + 3] = 255; }
  lg.putImageData(img, 0, 0);
  // the picture: table, cup, coffee, then the light on the coffee
  g.setTransform(1, 0, 0, 1, 0, 0);
  const tbl = g.createRadialGradient(cx, cy, scale * 0.5, cx, cy, Math.max(W, H)); tbl.addColorStop(0, '#2a1c13'); tbl.addColorStop(1, '#0d0806');
  g.fillStyle = tbl; g.fillRect(0, 0, W, H);
  const path = new Path2D(); mirror.P.forEach((p, i) => (i ? path.lineTo(X(p[0]), Y(p[1])) : path.moveTo(X(p[0]), Y(p[1])))); if (mirror.closed) path.closePath();
  if (mirror.closed) {
    g.save(); g.lineJoin = 'round'; g.strokeStyle = '#e9e3da'; g.lineWidth = scale * 0.16; g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = scale * 0.08; g.stroke(path); g.restore();
    g.strokeStyle = '#fbf8f3'; g.lineWidth = scale * 0.05; g.stroke(path);
    g.save(); g.clip(path);
    const cof = g.createRadialGradient(X(0.1), Y(0.12), scale * 0.05, X(0), Y(0), scale * 1.2); cof.addColorStop(0, '#5a3418'); cof.addColorStop(0.7, '#3b200e'); cof.addColorStop(1, '#22120a');
    g.fillStyle = cof; g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'lighter'; g.drawImage(lightCv, 0, 0); g.restore();
    g.strokeStyle = 'rgba(80, 50, 30, 0.6)'; g.lineWidth = scale * 0.012; g.stroke(path);
  } else {
    g.save(); g.globalCompositeOperation = 'lighter'; g.drawImage(lightCv, 0, 0); g.restore();
    g.strokeStyle = '#d9dde2'; g.lineWidth = scale * 0.035; g.lineCap = 'round'; g.stroke(path);
  }
  if (st.env) {
    g.strokeStyle = 'rgba(140, 230, 255, 0.95)'; g.lineWidth = 1.5 * dpr; g.beginPath(); let pen = false;
    for (const p of envelope(T.first)) { if (!p || Math.hypot(p[0], p[1]) > 3) { pen = false; continue; } if (pen) g.lineTo(X(p[0]), Y(p[1])); else g.moveTo(X(p[0]), Y(p[1])); pen = true; }
    g.stroke();
  }
  // the light
  if (st.light === 'sun') {
    const R = mirror.R + 0.42, x = X(-Math.cos(st.sunAng) * R), y = Y(-Math.sin(st.sunAng) * R);
    g.fillStyle = '#ffd98e'; g.shadowColor = '#ffb347'; g.shadowBlur = 24 * dpr; g.beginPath(); g.arc(x, y, 13 * dpr, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
  } else {
    const x = X(st.lamp[0]), y = Y(st.lamp[1]);
    g.fillStyle = '#fff4d8'; g.shadowColor = '#ffd27a'; g.shadowBlur = 20 * dpr; g.beginPath(); g.arc(x, y, 7 * dpr, 0, Math.PI * 2); g.fill(); g.shadowBlur = 0;
  }
  describe();
}

function describe() {
  const s = st.shape, sun = st.light === 'sun', r = Math.hypot(...st.lamp);
  let name = '', text = '';
  if (s === 'cup' && sun) { name = 'Nephroid'; text = 'Parallel light off the inside of a circle. The cusp sits halfway from the wall to the centre, where a curved mirror focuses (R/2). Two cusps would show if the light could reach the near wall too.'; }
  else if (s === 'cup' && Math.abs(r - 1) < 0.06) { name = 'Cardioid'; text = 'A lamp on the rim. The reflected rays wrap into a heart, its cusp a third of the way across.'; }
  else if (s === 'cup' && r < 0.04) { name = 'No caustic'; text = 'From the centre every ray hits the wall square on and comes straight back.'; }
  else if (s === 'cup') { name = r < 1 ? 'Limacon-type caustic' : 'Between a cardioid and a nephroid'; text = 'Move the lamp out to infinity and the caustic becomes the nephroid; put it on the rim and it is a cardioid.'; }
  else if (s === 'parabola') { name = 'Parabolic bowl'; text = 'Light along the axis goes to one point, the focus: the caustic has shrunk to a point. Tilt the sun and it opens into a curve, the coma of a telescope mirror.'; }
  else if (s === 'ellipse') { name = 'Ellipse'; text = 'Put the lamp on a focus (1 of the two points 0.83 from the centre) and every ray goes through the other.'; }
  else if (s === 'heart') { name = 'A cardioid mirror'; text = 'The caustic of a cardioid is a smaller curve inside it with its own cusps.'; }
  else if (s === 'flower') { name = 'Five lobes'; text = 'Each lobe is its own small concave mirror, with its own little caustic.'; }
  else { name = 'Your mirror'; text = 'Every bend of the curve focuses light somewhere; the bright lines are where neighbouring rays cross.'; }
  document.getElementById('iname').textContent = name; document.getElementById('itext').textContent = text;
}

// ---------------------------------------------------------------- input

let dirty = true, drag = null;
const toWorld = (e) => { const r = cv.getBoundingClientRect(); return [((e.clientX - r.left) * dpr - cx) / scale, -((e.clientY - r.top) * dpr - cy) / scale]; };
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId); const p = toWorld(e);
  if (st.shape === 'draw' && drawing) { drag = 'pen'; st.drawn = [p]; return; }
  drag = 'light'; moveLight(p);
});
cv.addEventListener('pointermove', (e) => {
  if (!drag) return; const p = toWorld(e);
  if (drag === 'pen') { const q = st.drawn[st.drawn.length - 1]; if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.015) { st.drawn.push(p); buildMirror(); dirty = true; } return; }
  moveLight(p);
});
cv.addEventListener('pointerup', () => { if (drag === 'pen') { st.drawn = smooth(st.drawn); drawing = false; buildMirror(); dirty = true; } drag = null; });
function moveLight(p) {
  if (st.light === 'sun') st.sunAng = Math.atan2(-p[1], -p[0]);
  else st.lamp = p;
  dirty = true;
}
function smooth(P) { // resample evenly, then a few passes of averaging
  if (P.length < 3) return null;
  let Q2 = P;
  for (let it = 0; it < 4; it++) Q2 = Q2.map((p, i) => i === 0 || i === Q2.length - 1 ? p : [(Q2[i - 1][0] + 2 * p[0] + Q2[i + 1][0]) / 4, (Q2[i - 1][1] + 2 * p[1] + Q2[i + 1][1]) / 4]);
  const out = [Q2[0]], step = 0.006; let acc = 0;
  for (let i = 1; i < Q2.length; i++) {
    const a = Q2[i - 1], b = Q2[i], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (acc += l; acc >= step; acc -= step) { const f = 1 - (acc - step) / l; out.push([a[0] + (b[0] - a[0]) * Math.min(1, f), a[1] + (b[1] - a[1]) * Math.min(1, f)]); }
  }
  return out.length > 3 && out.length < 4000 ? out : null;
}
let drawing = false;
const on = (sel, v) => document.querySelectorAll(sel).forEach((b) => b.classList.toggle('on', b.dataset.shape === v || b.dataset.light === v));
document.querySelectorAll('[data-shape]').forEach((b) => b.onclick = () => set(b.dataset.shape));
document.querySelectorAll('[data-light]').forEach((b) => b.onclick = () => { st.light = b.dataset.light; on('[data-light]', st.light); dirty = true; });
document.getElementById('bounces').oninput = (e) => { st.bounces = +e.target.value; dirty = true; };
document.getElementById('rays').oninput = (e) => { st.raysExp = +e.target.value; dirty = true; };
document.getElementById('env').onclick = (e) => { st.env = !st.env; e.target.classList.toggle('on', st.env); dirty = true; };
document.getElementById('move').onclick = (e) => { st.move = !st.move; e.target.classList.toggle('on', st.move); };
function set(shape) {
  st.shape = shape; on('[data-shape]', shape);
  if (shape === 'draw') { drawing = true; st.drawn = null; document.getElementById('iname').textContent = 'Draw a mirror'; }
  if (shape === 'parabola') st.sunAng = -Math.PI / 2;
  buildMirror(); dirty = true;
}

function resize() {
  dpr = Math.min(devicePixelRatio, 2); W = cv.width = lightCv.width = Math.round(innerWidth * dpr); H = cv.height = lightCv.height = Math.round(innerHeight * dpr);
  scale = Math.min(W, H) * 0.34; cx = W / 2; cy = H * 0.47; dirty = true;
}
addEventListener('resize', resize);

let t = 0;
function loop() {
  if (st.move) { t += 1 / 60; if (st.light === 'sun') st.sunAng += 0.004; else { const a = Math.atan2(st.lamp[1], st.lamp[0]) + 0.006, r = 0.6 + 0.55 * (0.5 + 0.5 * Math.sin(t * 0.4)); st.lamp = [r * Math.cos(a), r * Math.sin(a)]; } dirty = true; }
  if (dirty && !(drawing && !st.drawn)) { draw(); dirty = false; }
  else if (drawing && !st.drawn) { g.fillStyle = '#120c08'; g.fillRect(0, 0, W, H); g.fillStyle = '#eee'; g.font = `${16 * dpr}px Georgia`; g.textAlign = 'center'; g.fillText('Draw a curved mirror with your finger or mouse', W / 2, H / 2); }
  requestAnimationFrame(loop);
}

resize(); set('cup'); on('[data-light]', 'sun'); loop();

window.__cup = {
  set, st,
  stats() {
    const b0 = st.bounces; st.bounces = 1; draw(); st.bounces = b0; dirty = true;
    // brightest spot of the reflected light inside the cup, and how far it is from the nephroid
    const d = lg.getImageData(0, 0, lightCv.width, lightCv.height).data, bestAcc = 0; let best = -1, bx = 0, by = 0;
    for (let y = 0; y < lightCv.height; y += 2) for (let x = 0; x < lightCv.width; x += 2) { const k = 4 * (y * lightCv.width + x), v = d[k] + d[k + 1] + d[k + 2]; if (Math.hypot(x - cx, y - cy) > 0.85 * scale) continue; if (v > best) { best = v; bx = x; by = y; } }
    const wx = (bx - cx) / scale, wy = -(by - cy) / scale, c = Math.cos(st.sunAng), s = Math.sin(st.sunAng);
    let dist = Infinity;
    for (let k = 0; k < 2000; k++) { const a = k / 2000 * 2 * Math.PI, u = 0.75 * Math.cos(a) - 0.25 * Math.cos(3 * a), v = 0.75 * Math.sin(a) - 0.25 * Math.sin(3 * a); dist = Math.min(dist, Math.hypot(c * u - s * v - wx, s * u + c * v - wy)); }
    return { rays: last.count, peak: [+wx.toFixed(3), +wy.toFixed(3)], dist: +dist.toFixed(3), peakOnCurve: dist < 0.06 };
  },
};

if ('serviceWorker' in navigator && !Q.has('shot') && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');

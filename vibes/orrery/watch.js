// watch.js - Miniature: a celestial wristwatch for your phone, after the sky-chart complications of
// Patek Philippe's Celestial. A disc of lapis enamel printed in gold with the stars, turning once a sidereal
// day; a smoked sapphire over it that leaves clear the sky above your horizon; the Sun, Moon and planets set
// as jewels at their true places on the chart; an azimuth flange that works as a compass. Hands tell local time.
//
// Chart geometry: a polar azimuthal-equidistant map centred on the visible celestial pole. In "sky" view the
// chart is as you see the sky looking up (east on the left with south at 6 o'clock); in "ground" view it is
// mirrored, like a map laid on a table, so turned to the compass it lines up with the real directions.
import { buildOrrery, updateOrrery } from './orrery.js';
import * as THREE from 'three/webgpu';
import { Fn, uniform, uv, vec2, vec3, vec4, float, mix, smoothstep, clamp, abs, exp, pow, max, min, dot, normalize, length, sin, cos, fract, floor, step,
  texture, positionWorld, positionLocal, normalWorld, normalLocal, cameraPosition, reflect, hash, mx_worley_noise_float, mx_worley_noise_vec2, mx_noise_float, mx_fractal_noise_float, modelWorldMatrix, time } from 'three/tsl';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { STARS, LINES, CONSTELLATIONS, NAMED } from './stardata.js';
import { BODIES } from './astro.js';
import { v3, labelSprite } from './materials.js';

const D2R = Math.PI / 180;
export const RD = 0.86; // the chart's radius
const PLAT = new THREE.Color(0xe6e6e9), GOLD = new THREE.Color(0xe7c47c), LAPIS = new THREE.Color(0x0c1f5e);

// ------------------------------------------------------------------ chart projection
export class Chart {
  constructor(lat, m) { this.set(lat, m); }
  set(lat, m) {
    this.lat = lat; this.s = lat >= 0 ? 1 : -1; this.m = m; // m: 1 sky view, -1 ground view
    this.lim = Math.max(-88, Math.abs(lat) - 98); // the farthest declination drawn (toward the hidden pole)
    this.span = 90 - this.lim;
  }
  r(dec) { return (90 - this.s * dec) / this.span; } // 0 at the pole, 1 at the rim
  // RA (hours), Dec -> disc-frame position, in units of the chart radius
  xy(raH, dec, out = new THREE.Vector2()) { const a = -this.s * this.m * raH * 15 * D2R, r = this.r(dec); return out.set(r * Math.cos(a), r * Math.sin(a)); }
  discAngle(lstH) { return (-90 + this.s * this.m * lstH * 15) * D2R; }
  // (hour angle deg, dec) of a point at altitude h and azimuth A (from north, eastward), for this latitude
  hd(h, A) {
    const phi = this.lat * D2R, As = (A - 180) * D2R, hr = h * D2R;
    const dec = Math.asin(Math.sin(phi) * Math.sin(hr) - Math.cos(phi) * Math.cos(hr) * Math.cos(As)) / D2R;
    const H = Math.atan2(Math.sin(As), Math.cos(As) * Math.sin(phi) + Math.tan(hr) * Math.cos(phi)) / D2R;
    return [H, dec];
  }
  // dial-frame (fixed) position of hour angle H (deg) and dec
  fixedXY(H, dec, out = new THREE.Vector2()) { const a = (-90 + this.s * this.m * H) * D2R, r = this.r(dec); return out.set(r * Math.cos(a), r * Math.sin(a)); }
  // screen angle of an azimuth on the flange
  azAngle(A) { const Abot = this.s > 0 ? 180 : 0; return (-90 + this.m * (A - Abot)) * D2R; }
}

const eqToRaDec = (lamDeg) => { // a point of the ecliptic -> [RA h, Dec]
  const e = 23.4393 * D2R, l = lamDeg * D2R;
  return [((Math.atan2(Math.sin(l) * Math.cos(e), Math.cos(l)) / D2R + 360) % 360) / 15, Math.asin(Math.sin(e) * Math.sin(l)) / D2R];
};

function canvas(w, h = w) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function canvasTex(c, srgb) { const t = new THREE.CanvasTexture(c); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; return t; }

// the star chart: an enamel colour canvas and a gold-ink mask canvas
function drawChart(ch) {
  const N = 2048, C = N / 2, R = C * 0.995;
  const P = (raH, dec) => { const v = ch.xy(raH, dec); return [C + v.x * R, C - v.y * R]; };
  const en = canvas(N), g = en.getContext('2d');
  const grd = g.createRadialGradient(C, C, 0, C, C, R);
  grd.addColorStop(0, '#173a8f'); grd.addColorStop(0.55, '#0e2667'); grd.addColorStop(1, '#071338');
  g.fillStyle = grd; g.fillRect(0, 0, N, N);
  // guilloche: fine concentric rings under the enamel
  g.globalAlpha = 0.07; g.strokeStyle = '#9fb8ff'; g.lineWidth = 1.2;
  for (let r = 6; r < R; r += 7) { g.beginPath(); g.arc(C, C, r, 0, Math.PI * 2); g.stroke(); }
  g.globalAlpha = 1;
  // the Milky Way, computed on a coarse grid from galactic latitude, then blurred up
  {
    const M = 256, mw = canvas(M), mg = mw.getContext('2d'), img = mg.createImageData(M, M);
    const ngp = [192.85948, 27.12825], gc = [266.405, -28.936];
    const vec = (ra, de) => [Math.cos(de * D2R) * Math.cos(ra * D2R), Math.cos(de * D2R) * Math.sin(ra * D2R), Math.sin(de * D2R)];
    const NG = vec(...ngp), GC = vec(...gc), G3 = [NG[1] * GC[2] - NG[2] * GC[1], NG[2] * GC[0] - NG[0] * GC[2], NG[0] * GC[1] - NG[1] * GC[0]];
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      const x = (i + 0.5) / M * 2 - 1, y = 1 - (j + 0.5) / M * 2, r = Math.hypot(x, y);
      if (r > 1) continue;
      const dec = ch.s * (90 - r * ch.span), ra = ((-Math.atan2(y, x) / D2R) * ch.s * ch.m / 15 * 15 + 720) % 360;
      const v = vec(ra, dec), b = Math.asin(v[0] * NG[0] + v[1] * NG[1] + v[2] * NG[2]), l = Math.atan2(v[0] * G3[0] + v[1] * G3[1] + v[2] * G3[2], v[0] * GC[0] + v[1] * GC[1] + v[2] * GC[2]);
      const n = 0.6 + 0.4 * Math.sin(l * 7 + 1.3) * Math.sin(l * 3.1 + b * 9) + 0.25 * Math.sin(l * 17 + b * 23);
      const I = (Math.exp(-b * b * 30) * (0.5 + 0.5 * Math.exp(-l * l * 0.5)) + Math.exp(-l * l * 2 - b * b * 12) * 0.8) * n * (1 - 0.7 * Math.exp(-((b - 0.02) ** 2) * 900));
      const k = (j * M + i) * 4; img.data[k] = 150; img.data[k + 1] = 175; img.data[k + 2] = 255; img.data[k + 3] = Math.max(0, Math.min(255, I * 70));
    }
    mg.putImageData(img, 0, 0);
    g.filter = 'blur(10px)'; g.drawImage(mw, C - R, C - R, 2 * R, 2 * R); g.filter = 'none';
  }
  // gold ink
  const go = canvas(N), k = go.getContext('2d');
  k.fillStyle = '#000'; k.fillRect(0, 0, N, N);
  k.strokeStyle = k.fillStyle = '#fff';
  const circle = (dec, w, a = 1, dash = null) => { k.globalAlpha = a; k.lineWidth = w; k.setLineDash(dash || []); k.beginPath(); k.arc(C, C, ch.r(dec) * R, 0, Math.PI * 2); k.stroke(); k.setLineDash([]); k.globalAlpha = 1; };
  // rim: two lines and the hours of right ascension
  const rimDec = ch.s * (90 - ch.span);
  k.lineWidth = 3; k.beginPath(); k.arc(C, C, R - 2, 0, Math.PI * 2); k.stroke();
  k.lineWidth = 1.5; k.beginPath(); k.arc(C, C, R - 44, 0, Math.PI * 2); k.stroke();
  for (let i = 0; i < 24 * 12; i++) {
    const a = -ch.s * ch.m * (i / 12) * 15 * D2R, l = i % 12 === 0 ? 0 : i % 6 === 0 ? 18 : i % 3 === 0 ? 12 : 7;
    if (!l) continue;
    k.lineWidth = i % 6 ? 1.4 : 2; k.beginPath(); k.moveTo(C + Math.cos(a) * (R - 44), C - Math.sin(a) * (R - 44)); k.lineTo(C + Math.cos(a) * (R - 44 + l), C - Math.sin(a) * (R - 44 + l)); k.stroke();
  }
  k.font = '600 30px Georgia, serif'; k.textAlign = 'center'; k.textBaseline = 'middle';
  for (let h = 0; h < 24; h++) {
    const a = -ch.s * ch.m * h * 15 * D2R;
    k.save(); k.translate(C + Math.cos(a) * (R - 22), C - Math.sin(a) * (R - 22)); k.rotate(-a + Math.PI / 2); k.fillText(String(h), 0, 0); k.restore();
  }
  // equator, tropics and the ecliptic
  circle(0, 1.6, 0.55, [10, 8]);
  for (const d of [30, 60]) circle(ch.s * d, 1, 0.25, [3, 9]);
  for (const d of [-30]) if (d > rimDec * ch.s || ch.s < 0) circle(ch.s * d, 1, 0.25, [3, 9]);
  k.globalAlpha = 0.85; k.lineWidth = 2.2; k.beginPath();
  for (let l = 0; l <= 360; l += 1) { const [ra, de] = eqToRaDec(l); const [x, y] = P(ra, de); l ? k.lineTo(x, y) : k.moveTo(x, y); }
  k.stroke();
  for (let l = 0; l < 360; l += 5) {
    const [ra, de] = eqToRaDec(l), [ra2, de2] = eqToRaDec(l + 0.5);
    const [x, y] = P(ra, de), [x2, y2] = P(ra2, de2), nx = -(y2 - y), ny = x2 - x, nl = Math.hypot(nx, ny), L = l % 30 ? 6 : 14;
    k.lineWidth = l % 30 ? 1.2 : 2; k.beginPath(); k.moveTo(x - nx / nl * L, y - ny / nl * L); k.lineTo(x + nx / nl * L, y + ny / nl * L); k.stroke();
  }
  k.globalAlpha = 1;
  // hour circles from the pole, faint
  k.globalAlpha = 0.16; k.lineWidth = 1;
  for (let h = 0; h < 24; h += 2) { const [x, y] = P(h, rimDec + ch.s * 2); const [x0, y0] = P(h, ch.s * 80); k.beginPath(); k.moveTo(x0, y0); k.lineTo(x, y); k.stroke(); }
  k.globalAlpha = 1;
  // constellation figures
  k.globalAlpha = 0.5; k.lineWidth = 1.6;
  for (const ln of LINES) {
    k.beginPath(); let pen = false;
    for (let i = 0; i < ln.length; i += 2) {
      const dec = ln[i + 1];
      if (ch.r(dec) > 0.985) { pen = false; continue; }
      const [x, y] = P(ln[i] / 15, dec); pen ? k.lineTo(x, y) : k.moveTo(x, y); pen = true;
    }
    k.stroke();
  }
  k.globalAlpha = 1;
  // stars
  for (let i = 0; i < STARS.length; i += 4) {
    const ra = STARS[i] / 15, dec = STARS[i + 1], mag = STARS[i + 2];
    if (ch.r(dec) > 0.975 || mag > 5.6) continue;
    const [x, y] = P(ra, dec), rr = Math.max(0.9, Math.min(7.5, 1.0 + (5.0 - mag) * 1.15));
    k.globalAlpha = mag > 4.5 ? 0.7 : 1;
    k.beginPath(); k.arc(x, y, rr, 0, Math.PI * 2); k.fill();
    if (mag < 1.6) { // a four-pointed star for the brightest
      const L = rr * 3.2, w = rr * 0.45; k.beginPath();
      k.moveTo(x, y - L); k.lineTo(x + w, y - w); k.lineTo(x + L, y); k.lineTo(x + w, y + w); k.lineTo(x, y + L); k.lineTo(x - w, y + w); k.lineTo(x - L, y); k.lineTo(x - w, y - w); k.closePath(); k.fill();
    }
  }
  k.globalAlpha = 1;
  // names
  k.font = 'italic 21px Georgia, serif'; k.globalAlpha = 0.62;
  for (const [name, ra, dec, rank] of CONSTELLATIONS) { if (rank > 2 || ch.r(dec) > 0.93) continue; const [x, y] = P(ra / 15, dec); k.fillText(name.toUpperCase().split('').join('\u200a'), x, y + 26); }
  k.font = 'italic 19px Georgia, serif'; k.globalAlpha = 0.85; k.textAlign = 'left';
  for (const [name, ra, dec] of NAMED) { if (ch.r(dec) > 0.95) continue; const [x, y] = P(ra / 15, dec); k.fillText(name, x + 13, y - 11); }
  k.globalAlpha = 1;
  return { enamel: canvasTex(en, true), gold: canvasTex(go, false) };
}

// the smoked sapphire with the horizon, almucantars, cardinal points and the maker's lines
function drawHorizon(ch, place) {
  const N = 1024, C = N / 2, R = C * 0.995;
  const c = canvas(N), g = c.getContext('2d'), img = g.createImageData(N, N), d = img.data;
  const phi = ch.lat * D2R, sp = Math.sin(phi), cp = Math.cos(phi), degPx = ch.span / R;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i + 0.5 - C) / R, y = (C - j - 0.5) / R, r = Math.hypot(x, y), k = (j * N + i) * 4;
    if (r > 1.004) continue;
    const H = ch.s * ch.m * (Math.atan2(y, x) / D2R + 90) * D2R, dec = ch.s * (90 - r * ch.span) * D2R;
    const sa = sp * Math.sin(dec) + cp * Math.cos(dec) * Math.cos(H), alt = Math.asin(Math.max(-1, Math.min(1, sa))) / D2R;
    // smoked outside the horizon, clear inside
    const out = Math.min(1, Math.max(0, (-alt + 0.15) / 0.5));
    let a = out * 0.8, cr = 6, cg = 11, cb = 32;
    // fine gold lines: the horizon, almucantars every 30 degrees
    const w = degPx * 1.1;
    const lineAt = (h, wd) => Math.max(0, 1 - Math.abs(alt - h) / wd);
    const hz = lineAt(0, w * 1.6), al = alt > 0 ? Math.max(lineAt(30, w * 0.7), lineAt(60, w * 0.7)) * 0.45 : 0;
    const L = Math.max(hz, al);
    if (L > 0) { cr = cr + (232 - cr) * L; cg = cg + (200 - cg) * L; cb = cb + (130 - cb) * L; a = Math.max(a, L * 0.95); }
    d[k] = cr; d[k + 1] = cg; d[k + 2] = cb; d[k + 3] = a * 255 * Math.min(1, (1.004 - r) * 200);
  }
  g.putImageData(img, 0, 0);
  const at = (H, dec) => { const v = ch.fixedXY(H, dec); return [C + v.x * R, C - v.y * R]; };
  // azimuth lines every 45 degrees from the zenith, dotted
  g.strokeStyle = 'rgba(232,200,130,0.28)'; g.lineWidth = 1; g.setLineDash([2, 5]);
  for (let A = 0; A < 360; A += 45) { g.beginPath(); for (let h = 0; h <= 88; h += 2) { const [x, y] = at(...ch.hd(h, A)); h ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); }
  g.setLineDash([]);
  // zenith
  { const [x, y] = at(...ch.hd(90, 0)); g.strokeStyle = 'rgba(240,210,140,0.9)'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(x - 9, y); g.lineTo(x + 9, y); g.moveTo(x, y - 9); g.lineTo(x, y + 9); g.stroke(); }
  // cardinal points just inside the horizon
  g.fillStyle = '#f2d593'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.shadowColor = 'rgba(0,0,0,0.8)'; g.shadowBlur = 6;
  for (const [t, A] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    const [x, y] = at(...ch.hd(7, A));
    if (Math.hypot(x - C, y - C) > R * 0.95) continue;
    g.font = '600 30px Georgia, serif'; g.fillText(t, x, y);
  }
  // maker's lines in the widest smoked part: beyond the horizon point opposite 6 o'clock
  {
    const Atop = ch.s > 0 ? 0 : 180, [Hn, dn] = ch.hd(0, Atop), v = ch.fixedXY(Hn, dn), r0 = v.length(), a = Math.atan2(v.y, v.x);
    const rm = (r0 + 1) / 2, [x, y] = [C + Math.cos(a) * rm * R, C - Math.sin(a) * rm * R];
    g.shadowBlur = 0; g.fillStyle = '#e9c983';
    g.font = '500 30px Georgia, serif'; g.fillText('O R R E R Y', x, y - 18);
    g.font = 'italic 17px Georgia, serif'; g.fillStyle = 'rgba(233,201,131,0.85)';
    g.fillText(place, x, y + 14);
  }
  const t = canvasTex(c, true); return t;
}

// azimuth flange (the rehaut): a strip around the cone between dial and bezel, gold on navy
function drawFlange(ch) {
  const W = 4096, H = 96, c = canvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H); g.fillStyle = g.strokeStyle = '#fff';
  const X = (A) => { const u = ((ch.azAngle(A) / D2R + 90) / 360); return ((1 - u) % 1 + 1) % 1 * W; };
  for (let A = 0; A < 360; A += 2) {
    const x = X(A), l = A % 10 ? 14 : A % 30 ? 24 : 30;
    g.fillRect(x - (A % 10 ? 0.9 : 1.4), H - 8 - l, A % 10 ? 1.8 : 2.8, l);
  }
  g.fillRect(0, H - 8, W, 2);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const [t, A] of [['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315]]) {
    g.font = A % 90 ? '500 30px Georgia, serif' : '700 46px Georgia, serif';
    for (const dx of [-W, 0, W]) g.fillText(t, X(A) + dx, 30);
  }
  g.font = '22px Georgia, serif';
  for (let A = 30; A < 360; A += 30) if (A % 90) for (const dx of [-W, 0, W]) { g.fillText(String(A), X(A) + dx + (ch.m > 0 ? 0 : 0), 34); }
  const t = canvasTex(c, false); t.wrapS = THREE.RepeatWrapping; return t;
}

// gold ink on enamel: one physical material, metal where the ink is
function inkMaterial(goldTex, baseNode, { sparkle = false, uLight = null, uvNode = uv() } = {}) {
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.2, metalness: 0 });
  const ink = texture(goldTex, uvNode).r;
  const fine = mx_noise_float(vec3(uv().mul(900), 0)).mul(0.5).add(0.5);
  m.colorNode = mix(baseNode, v3(GOLD).mul(fine.mul(0.15).add(0.9)), ink);
  m.metalnessNode = ink;
  m.roughnessNode = mix(float(0.12), float(0.26), ink);
  m.clearcoatNode = ink.oneMinus();
  m.clearcoatRoughness = 0.03;
  if (sparkle) {
    // aventurine: tiny flakes that catch the light as the watch tilts
    const cell = floor(uv().mul(620)), cid = cell.x.add(cell.y.mul(631)), h1 = hash(cid), h2 = hash(cid.add(400000)), h3 = hash(cid.add(900000));
    const fl = normalize(modelWorldMatrix.mul(vec4(h1.sub(0.5).mul(1.4), h2.sub(0.5).mul(1.4), 1, 0)).xyz);
    const hv = normalize(uLight.add(normalize(cameraPosition.sub(positionWorld))));
    const f = fract(uv().mul(620)).sub(0.5), dotty = smoothstep(0.32, 0.0, length(f));
    const glint = pow(dot(fl, hv).max(0), 420).mul(step(0.86, h3)).mul(dotty).mul(ink.oneMinus());
    m.emissiveNode = vec3(1.0, 0.9, 0.75).mul(glint).mul(5.0);
  }
  return m;
}

function leafHand(len, w, tail) {
  const s = new THREE.Shape();
  s.moveTo(0, -tail);
  s.bezierCurveTo(w * 0.6, -tail * 0.6, w * 0.5, 0, w * 0.55, len * 0.18);
  s.bezierCurveTo(w * 0.62, len * 0.5, w * 0.3, len * 0.8, 0, len);
  s.bezierCurveTo(-w * 0.3, len * 0.8, -w * 0.62, len * 0.5, -w * 0.55, len * 0.18);
  s.bezierCurveTo(-w * 0.5, 0, -w * 0.6, -tail * 0.6, 0, -tail);
  const hole = new THREE.Path(); hole.absarc(0, 0, w * 0.14, 0, Math.PI * 2, true); s.holes.push(hole);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.003, bevelSize: w * 0.18, bevelSegments: 3, curveSegments: 24 });
  // facet it: a ridge down the middle, so each half catches the light at its own angle (dauphine style)
  const g2 = g.index ? g.toNonIndexed() : g, p = g2.attributes.position;
  for (let i = 0; i < p.count; i++) { const z = p.getZ(i); if (z > 0.0035) p.setZ(i, z + 0.012 * Math.max(0, 1 - Math.abs(p.getX(i)) / (w * 0.75))); }
  g2.computeVertexNormals();
  return g2;
}

function strapMaterial() {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0, side: THREE.DoubleSide });
  const p = uv().mul(vec2(1, 3));
  const x = uv().x.sub(0.5).abs().mul(2); // 0 centre, 1 edge
  // alligator: large tiles in the middle, smaller toward the edges
  const scale = mix(float(20), float(34), x);
  const f = mx_worley_noise_vec2(vec2(p.x.mul(scale), p.y.mul(scale).mul(0.75)));
  const groove = smoothstep(0.0, 0.09, f.y.sub(f.x)), dome = f.x.oneMinus();
  const stitch = smoothstep(0.86, 0.87, x).mul(smoothstep(0.9, 0.89, x)).mul(step(0.45, fract(p.y.mul(22))));
  const base = mix(vec3(0.004, 0.006, 0.02), vec3(0.007, 0.012, 0.038).mul(dome.mul(0.6).add(0.6)), groove).mul(smoothstep(1.0, 0.75, x).mul(0.5).add(0.5));
  m.colorNode = mix(base, vec3(0.06, 0.08, 0.16), stitch);
  m.roughnessNode = mix(float(0.9), float(0.62), groove);
  
  return m;
}

// ------------------------------------------------------------------ the watch
export function buildWatch(lat, place) {
  const root = new THREE.Group(); // tilted by the phone; faces +z
  // the head (case, dials, crystals, the orrery) turns over about its 12-6 axis inside a cradle that the lugs hold,
  // as a reversible case does; the cradle, lugs, strap and crown stay put
  const head = new THREE.Group(); root.add(head);
  const W = { root, head, chart: new Chart(lat, 1), jewels: {}, markers: {}, place };
  const plat = new THREE.MeshPhysicalNodeMaterial({ color: PLAT, metalness: 1, roughness: 0.14 });
  const platBrushed = new THREE.MeshPhysicalNodeMaterial({ color: PLAT, metalness: 1, roughness: 0.3 });
  const uLight = uniform(new THREE.Vector3(-0.35, 0.5, 0.8).normalize());
  W.uLight = uLight;

  // case: a lathe profile round the axis, turned to face the viewer; open at the back too, a display caseback
  const prof = [[0.948, 0.104], [0.95, 0.128], [0.975, 0.148], [1.01, 0.152], [1.045, 0.138], [1.075, 0.105], [1.095, 0.05], [1.098, -0.01], [1.095, -0.06], [1.075, -0.105], [1.045, -0.135], [1.01, -0.149], [0.975, -0.146], [0.95, -0.127], [0.948, -0.104]].reverse().map(([r, z]) => new THREE.Vector2(r, z));
  const caseG = new THREE.LatheGeometry(prof, 256); caseG.rotateX(Math.PI / 2);
  const caseM = new THREE.Mesh(caseG, plat); caseM.castShadow = true; head.add(caseM);
  // the cradle: a flat platinum ring round the case, with a pivot at 12 and at 6
  const crProf = [[1.112, 0.05], [1.118, 0.066], [1.15, 0.075], [1.2, 0.07], [1.228, 0.045], [1.236, 0], [1.228, -0.045], [1.2, -0.07], [1.15, -0.075], [1.118, -0.066], [1.112, -0.05]].reverse().map(([r, z]) => new THREE.Vector2(r, z));
  const crG = new THREE.LatheGeometry(crProf, 256); crG.rotateX(Math.PI / 2);
  const cradle = new THREE.Mesh(crG, platBrushed); cradle.castShadow = true; root.add(cradle);
  for (const sy of [1, -1]) {
    const pivot = new THREE.Mesh(new THREE.CylinderGeometry(0.034, 0.034, 0.16, 32), plat); pivot.position.set(0, sy * 1.15, 0); root.add(pivot);
    const screw = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.03, 40), plat); screw.position.set(0, sy * 1.245, 0); root.add(screw);
    const slot = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.034, 0.012), platBrushed); slot.position.set(0, sy * 1.255, 0); root.add(slot);
  }
  // lugs and strap
  for (const sy of [1, -1]) for (const sx of [1, -1]) {
    const lug = new THREE.Mesh(new RoundedBoxGeometry(0.17, 0.56, 0.12, 4, 0.04), platBrushed);
    lug.position.set(sx * 0.62, sy * 1.25, -0.03); lug.rotation.x = sy * 0.16; root.add(lug);
  }
  const strapM = strapMaterial();
  for (const sy of [1, -1]) {
    const g = new THREE.PlaneGeometry(1.06, 3.2, 1, 48), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i) + 1.6; p.setXYZ(i, p.getX(i), sy * (1.25 + y), -0.06 - y * y * 0.05 - y * 0.05); }
    g.computeVertexNormals();
    if (sy < 0) { const idx = g.index.array; for (let i = 0; i < idx.length; i += 3) { const t = idx[i]; idx[i] = idx[i + 2]; idx[i + 2] = t; } g.computeVertexNormals(); }
    const strap = new THREE.Mesh(g, strapM); root.add(strap);
  }
  // crown at 3 o'clock, fluted
  {
    const g = new THREE.CylinderGeometry(0.078, 0.078, 0.11, 96, 2), p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i), a = Math.atan2(z, x), r = Math.hypot(x, z); if (r > 0.05) { const k = 1 + 0.055 * Math.max(0, Math.cos(a * 22)) ** 0.5 - 0.03; p.setX(i, x * k); p.setZ(i, z * k); } }
    g.computeVertexNormals();
    const crown = new THREE.Mesh(g, plat); crown.rotation.z = Math.PI / 2; crown.position.set(1.31, 0, -0.01); root.add(crown);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 24), plat); neck.rotation.z = Math.PI / 2; neck.position.set(1.25, 0, -0.01); root.add(neck);
    const cab = new THREE.Mesh(new THREE.SphereGeometry(0.03, 24, 16), new THREE.MeshPhysicalNodeMaterial({ color: 0x1a3fb0, roughness: 0.05, clearcoat: 1, metalness: 0 }));
    cab.scale.x = 0.45; cab.position.set(1.368, 0, -0.01); root.add(cab);
    W.crown = crown;
    // the pusher above the crown, at two o'clock on the cradle: it turns the head over
    // a flat disc pusher, as on the reference: a low collar on the cradle and a wide button with a chamfered edge
    const a = Math.PI / 7.5, pusher = new THREE.Group();
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.07, 0.035, 48), platBrushed); collar.position.y = 0.0175;
    const bProf = [[0, 0], [0.074, 0], [0.078, 0.006], [0.078, 0.024], [0.072, 0.032], [0, 0.032]].map(([r, y]) => new THREE.Vector2(r, y));
    const btn = new THREE.Mesh(new THREE.LatheGeometry(bProf, 64), plat); btn.position.y = 0.04;
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.06, 48), platBrushed); face.rotation.x = -Math.PI / 2; face.position.y = 0.0725;
    const press = new THREE.Group(); press.add(btn, face); pusher.add(collar, press);
    pusher.position.set(Math.cos(a) * 1.225, Math.sin(a) * 1.225, -0.005); pusher.rotation.z = a - Math.PI / 2; root.add(pusher);
    W.pusher = pusher; W.pusherPress = press; W.pusherY = press.position.y;
  }

  // the turning assembly (turned to the compass in ground view): chart disc, sapphire, flange, markers
  const skyRot = new THREE.Group(); root.add(skyRot); W.skyRot = skyRot;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(RD, 256), new THREE.MeshBasicNodeMaterial()); disc.receiveShadow = true;
  skyRot.add(disc); W.disc = disc;
  const sapphire = new THREE.Mesh(new THREE.CircleGeometry(RD, 256), new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false }));
  sapphire.position.z = 0.04; sapphire.renderOrder = 2; skyRot.add(sapphire); W.sapphire = sapphire;
  const flG = new THREE.CylinderGeometry(0.95, RD - 0.004, 0.07, 512, 1, true); flG.rotateX(Math.PI / 2);
  const flange = new THREE.Mesh(flG, new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide })); flange.position.z = 0.07; flange.receiveShadow = true; skyRot.add(flange); W.flange = flange;

  // jewels on the chart (children of the disc, so they turn with the sky)
  const gemMat = (color) => new THREE.MeshPhysicalNodeMaterial({ color: new THREE.Color(color), roughness: 0.08, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.02, sheen: 0.4, sheenColor: new THREE.Color(0xffffff) });
  const goldPol = new THREE.MeshPhysicalNodeMaterial({ color: GOLD, metalness: 1, roughness: 0.12 });
  for (const b of BODIES) {
    let j;
    if (b.key === 'Sun') {
      const s = new THREE.Shape(); for (let i = 0; i < 32; i++) { const a = i / 32 * Math.PI * 2, r = i % 2 ? 0.032 : (i % 4 ? 0.05 : 0.062); i ? s.lineTo(Math.cos(a) * r, Math.sin(a) * r) : s.moveTo(r, 0); }
      j = new THREE.Group();
      const rays = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.003, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1 }), goldPol);
      const face = new THREE.Mesh(new THREE.SphereGeometry(0.028, 32, 16), goldPol); face.scale.z = 0.35; face.position.z = 0.006;
      rays.castShadow = face.castShadow = true;
      j.add(rays, face);
    } else if (b.key === 'Moon') {
      const mm = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.25, metalness: 0, clearcoat: 1 });
      const uL = uniform(new THREE.Vector3(0, 0, 1));
      const n = normalize(normalLocal), lit = smoothstep(-0.04, 0.08, dot(n, uL));
      const mare = smoothstep(0.1, 0.5, mx_fractal_noise_float(normalLocal.mul(3.2), 3, 2, 0.5, 1)).mul(0.25);
      mm.colorNode = mix(vec3(0.015, 0.02, 0.05), vec3(0.85, 0.85, 0.82).sub(mare), lit);
      mm.emissiveNode = vec3(0.85, 0.85, 0.8).sub(mare).mul(lit).mul(0.35);
      j = new THREE.Mesh(new THREE.SphereGeometry(0.036, 48, 24), mm); j.scale.z = 0.5; j.castShadow = true; j.userData.uL = uL;
      const bez = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.004, 8, 48), goldPol); j.add(bez); bez.scale.z = 2;
    } else {
      const r = { Jupiter: 0.022, Saturn: 0.02, Venus: 0.021, Mars: 0.017 }[b.key] || 0.014;
      j = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16), gemMat(b.color)); j.scale.z = 0.55; j.castShadow = true;
      const bez = new THREE.Mesh(new THREE.TorusGeometry(r * 1.08, r * 0.14, 8, 32), goldPol); bez.scale.z = 1.6; j.add(bez);
      if (b.key === 'Saturn') { const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.7, r * 0.12, 6, 40), goldPol); ring.rotation.x = 1.2; j.add(ring); }
    }
    j.userData.key = b.key; j.position.z = 0.012;
    disc.add(j);
    const label = labelSprite(b.name, { size: 40, color: '#f3dda7', italic: true, spacing: 0.04, depthTest: false });
    label.material.sizeAttenuation = true; label.renderOrder = 8; skyRot.add(label);
    W.jewels[b.key] = { mesh: j, label };
    // its marker on the flange: where to face
    const mk = new THREE.Mesh(new THREE.SphereGeometry(0.011, 16, 10), gemMat(b.color)); mk.userData.key = b.key; skyRot.add(mk);
    const tick = new THREE.Mesh(new THREE.ConeGeometry(0.012, 0.03, 3), goldPol); tick.visible = false; skyRot.add(tick);
    W.markers[b.key] = { mesh: mk, tick };
  }

  // hands (local time), in white gold
  const handM = new THREE.MeshPhysicalNodeMaterial({ color: new THREE.Color(0xf4f1ea), metalness: 1, roughness: 0.22 });
  const mk = (geo, z) => { const h = new THREE.Mesh(geo, handM); h.position.z = z; h.castShadow = true; root.add(h); return h; };
  W.hHour = mk(leafHand(0.46, 0.07, 0.07), 0.085);
  W.hMin = mk(leafHand(0.72, 0.055, 0.09), 0.095);
  const secG = new THREE.BoxGeometry(0.006, 0.88, 0.003); secG.translate(0, 0.32, 0);
  W.hSec = new THREE.Mesh(secG, goldPol); W.hSec.position.z = 0.106; W.hSec.castShadow = true; root.add(W.hSec);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.012, 32), goldPol); cap.rotation.x = Math.PI / 2; cap.position.z = 0.11; root.add(cap);

  // sapphire crystal: a fake reflection, added on top
  {
    const R = 3.2, a = Math.asin(0.952 / R);
    const g = new THREE.SphereGeometry(R, 96, 16, 0, Math.PI * 2, 0, a); g.rotateX(Math.PI / 2); g.translate(0, 0, 0.152 - R);
    const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const n = normalize(normalWorld), v = normalize(cameraPosition.sub(positionWorld)), rv = reflect(v.negate(), n);
    const win = pow(dot(rv, uLight).max(0), 60).mul(0.22).add(pow(dot(rv, uLight).max(0), 8).mul(0.04));
    const fres = pow(dot(n, v).max(0).oneMinus(), 5).mul(0.1);
    m.colorNode = vec3(0.85, 0.9, 1.0).mul(win.add(fres));
    const crystal = new THREE.Mesh(g, m); crystal.renderOrder = 10; root.add(crystal);
    const back = new THREE.Mesh(g, m); back.rotation.y = Math.PI; back.scale.z = 0.98; back.renderOrder = 10; root.add(back);
  }

  // light: a soft key from the upper left, with shadows of the hands on the dial
  const key = new THREE.DirectionalLight(0xfff4e6, 1.3); key.position.set(-2.2, 3, 5); key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024); Object.assign(key.shadow.camera, { left: -1.3, right: 1.3, top: 1.3, bottom: -1.3, near: 1, far: 12 });
  key.shadow.camera.updateProjectionMatrix(); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.01; key.shadow.radius = 4;
  W.key = key;

  W.setChart = (lat, m, place = W.place) => {
    W.chart.set(lat, m); W.place = place;
    const c = drawChart(W.chart);
    if (W._tex) for (const t of W._tex) t.dispose();
    const hz = drawHorizon(W.chart, place), fl = drawFlange(W.chart);
    W._tex = [c.enamel, c.gold, hz, fl];
    disc.material = inkMaterial(c.gold, texture(c.enamel, uv()).rgb, { sparkle: true, uLight });
    disc.material.needsUpdate = true;
    sapphire.material.colorNode = texture(hz, uv()).rgb; sapphire.material.opacityNode = texture(hz, uv()).a; sapphire.material.needsUpdate = true;
    const fm = inkMaterial(fl, v3(new THREE.Color(0x0a1640)), { uvNode: vec2(uv().x.oneMinus(), uv().y) });
    fm.side = THREE.DoubleSide; flange.material = fm;
  };
  W.setChart(lat, 1, place);

  // the back of the watch: a little orrery under the caseback crystal, its dial back to back with the chart
  W.orrery = buildOrrery(); W.orrery.group.rotation.y = Math.PI; W.orrery.group.position.z = -0.012; root.add(W.orrery.group);
  W.hands = [W.hHour, W.hMin, W.hSec, cap];
  // the case, strap and crystal, which the camera leaves behind as it dives into the orrery
  // move everything of the head into it: the case went in above; the dials, hands, crystals and orrery here
  for (const c of [skyRot, ...W.hands, W.orrery.group, ...root.children.filter((c) => c.renderOrder === 10)]) head.add(c);
  W.shell = [...root.children, ...head.children].filter((c) => c !== head && c !== W.orrery.group && c !== skyRot && !W.hands.includes(c));
  // which side faces you: the head turns over about its 12-6 axis
  W.turn = 0; W.face = 'chart';
  W.setFace = (f) => { W.face = f; };
  W.setFace('chart');
  return W;
}

const v2 = new THREE.Vector2(), v2b = new THREE.Vector2();
export function updateWatch(W, sky, date, { labels = 1, selected = null, compassAngle = 0, earthScale = 1, showLabels = true, dive = 0, magnify = 0, helio = 0, sink = 0, pinScale = 1 } = {}) {
  // in the dive the crystal goes at once, the chart behind the orrery's dial before that fades, the case once it's off screen
  for (const c of W.shell) c.visible = c.renderOrder === 10 ? dive < 0.02 : dive < 0.3;
  const front = Math.cos(W.turn) > -0.2, back = Math.cos(W.turn) < 0.2;
  W.skyRot.visible = front && dive < 0.15; for (const h of W.hands) h.visible = front && dive < 0.15;
  W.orrery.group.visible = back;
  if (back) updateOrrery(W.orrery, sky, date, { labels, selected: W.face === 'orrery' ? selected : null, earthScale, showLabels, dive, magnify, helio, sink, pinScale });
  if (!front) return;
  const ch = W.chart;
  W.skyRot.rotation.z = compassAngle;
  W.disc.rotation.z = ch.discAngle(sky.lst);
  const sunP = ch.xy(sky.bodies.Sun.ra, sky.bodies.Sun.dec, new THREE.Vector2());
  for (const b of BODIES) {
    const s = sky.bodies[b.key], J = W.jewels[b.key], r = ch.r(s.dec);
    const p = ch.xy(s.ra, s.dec, v2).multiplyScalar(RD);
    J.mesh.visible = r < 0.99;
    J.mesh.position.set(p.x, p.y, 0.012);
    if (b.key === 'Moon') {
      // phase: light from the Sun's place on the chart, tilted by the phase angle
      const cosi = 2 * s.frac - 1, sini = Math.sqrt(Math.max(0, 1 - cosi * cosi));
      v2b.copy(sunP).multiplyScalar(RD).sub(p).normalize();
      J.mesh.userData.uL.value.set(v2b.x * sini, v2b.y * sini, cosi).normalize();
    }
    // label beside it, in the turning frame (sprites stay upright)
    const wp = new THREE.Vector3(p.x, p.y, 0.05).applyAxisAngle(new THREE.Vector3(0, 0, 1), W.disc.rotation.z);
    J.label.position.set(wp.x, wp.y - 0.05, 0.08);
    J.label.visible = labels > 0 && J.mesh.visible;
    const lh = 0.032 * (b.key === 'Sun' || b.key === 'Moon' ? 1.1 : 0.95);
    J.label.scale.set(lh * J.label.userData.aspect, lh, 1);
    // flange marker at its azimuth, dimmer when it is below the horizon
    const a = ch.azAngle(s.az), M = W.markers[b.key];
    M.mesh.position.set(Math.cos(a) * 0.905, Math.sin(a) * 0.905, 0.075);
    const sel = selected === b.key;
    M.mesh.scale.setScalar((s.alt > 0 ? 1 : 0.6) * (sel ? 1.7 : 1));
    M.tick.visible = sel;
    if (sel) { M.tick.position.set(Math.cos(a) * 0.968, Math.sin(a) * 0.968, 0.14); M.tick.rotation.set(0, 0, a + Math.PI / 2); }
  }
  // hands
  const h = date.getHours(), m = date.getMinutes(), sec = date.getSeconds() + date.getMilliseconds() / 1000;
  const beat = Math.floor(sec * 8) / 8; // 28,800 vph: eight beats a second
  W.hSec.rotation.z = -beat / 60 * Math.PI * 2;
  W.hMin.rotation.z = -(m + sec / 60) / 60 * Math.PI * 2;
  W.hHour.rotation.z = -((h % 12) + m / 60) / 12 * Math.PI * 2;
}

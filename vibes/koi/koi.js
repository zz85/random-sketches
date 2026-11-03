// Koi: body and fins built once per fish shape and bent in the vertex shader along a spine
// the CPU moves (the head steers, the body follows its path, a travelling wave swims it).
// Colour patterns are 3D noise in the fish's own rest space, so they ride on the body.
import * as THREE from 'three';
import { COMMON } from './glsl.js';

export const NSP = 16; // spine points
const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
// smooth, never-repeating 1D noise in [-1, 1]
const wobble = (t) => (Math.sin(t) * 0.5 + Math.sin(t * 1.618 + 1.3) * 0.3 + Math.sin(t * 2.71 + 4.1) * 0.2);

// ---------- body profile, in body lengths. s runs nose (0) to tail.
const S_END = 0.875;
function close(s) { return s > 0.83 ? Math.sqrt(Math.max(0, 1 - ((s - 0.83) / (S_END - 0.83)) ** 2)) : 1; }
export function halfWidth(s) {
  const a = Math.min(s / 0.25, 1);
  return 0.1 * Math.sqrt(Math.max(0, 1 - (1 - a) ** 2)) * (1 - 0.8 * Math.pow(sm(0.25, 0.83, s), 1.2)) * close(s);
}
function topH(s) { const a = Math.min(s / 0.32, 1); return 0.096 * Math.sqrt(Math.max(0, 1 - (1 - a) ** 2)) * (1 - 0.66 * Math.pow(sm(0.32, 0.83, s), 1.1)) * close(s); }
function botH(s) { const a = Math.min(s / 0.34, 1); return 0.118 * Math.sqrt(Math.max(0, 1 - (1 - a) ** 2)) * (1 - 0.70 * Math.pow(sm(0.36, 0.83, s), 1.1)) * close(s); }

function bodyGeometry(NS = 52, NT = 24) {
  const rest = [], aS = [], aSec = [], aNorm = [], aArc = [], idx = [];
  const P = (s, th) => { const c = Math.cos(th), sn = Math.sin(th); return [-s, halfWidth(s) * c, (sn > 0 ? topH(s) : botH(s)) * sn]; };
  for (let i = 0; i <= NS; i++) {
    const s = S_END * Math.pow(i / NS, 1.25);
    for (let j = 0; j <= NT; j++) {
      const th = -Math.PI / 2 + (j / NT) * Math.PI * 2;
      const p = P(s, th), e = 1e-3;
      const ds = P(Math.min(S_END, s + e), th).map((v, k) => v - P(Math.max(0, s - e), th)[k]);
      const dt = P(s, th + e).map((v, k) => v - P(s, th - e)[k]);
      let n = [ds[1] * dt[2] - ds[2] * dt[1], ds[2] * dt[0] - ds[0] * dt[2], ds[0] * dt[1] - ds[1] * dt[0]];
      let l = Math.hypot(...n);
      if (l < 1e-9) n = s < 0.1 ? [1, 0, 0] : [-1, 0, 0], l = 1;
      n = n.map((v) => v / l);
      const ref = [-(s - 0.45) * 0.4, p[1], p[2]];
      if (n[0] * ref[0] + n[1] * ref[1] + n[2] * ref[2] < 0) n = n.map((v) => -v);
      // aNorm in (forward tangent, lateral, up): the rest frame's along axis is -s
      rest.push(p[0], p[1], p[2]); aS.push(s); aSec.push(p[1], p[2]); aNorm.push(n[0], n[1], n[2]); aArc.push(th * 0.1);
    }
  }
  for (let i = 0; i < NS; i++) for (let j = 0; j < NT; j++) {
    const a = i * (NT + 1) + j, b = a + NT + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(rest, 3));
  g.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 1));
  g.setAttribute('aSec', new THREE.Float32BufferAttribute(aSec, 2));
  g.setAttribute('aNorm', new THREE.Float32BufferAttribute(aNorm, 3));
  g.setAttribute('aArc', new THREE.Float32BufferAttribute(aArc, 1));
  g.setIndex(idx);
  return g;
}

// fins: 0/1 pectoral left/right, 2/3 pelvic, 4 dorsal, 5 caudal. `long` is butterfly koi.
function finGeometry(long) {
  const aS = [], aRoot = [], aOff = [], aUV = [], aKind = [], idx = [];
  let base = 0;
  const grid = (NU, NV, kind, fn) => {
    for (let iu = 0; iu <= NU; iu++) for (let iv = 0; iv <= NV; iv++) {
      const u = iu / NU, v = -1 + (2 * iv) / NV, r = fn(u, v);
      aS.push(r.s); aRoot.push(...(r.root || [0, 0, 0])); aOff.push(...r.off); aUV.push(u, v); aKind.push(kind);
    }
    for (let iu = 0; iu < NU; iu++) for (let iv = 0; iv < NV; iv++) {
      const a = base + iu * (NV + 1) + iv, b = a + NV + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    base += (NU + 1) * (NV + 1);
  };
  const paired = (kind0, s0, lat, up, len, aFront, aBack) => {
    for (const side of [1, -1]) grid(7, 10, side > 0 ? kind0 : kind0 + 1, (u, v) => {
      const t = (v + 1) / 2, a = aFront + (aBack - aFront) * t;
      const r = len * (0.6 + 0.4 * Math.sin(Math.PI * (0.12 + 0.88 * t)));
      return { s: s0, root: [(0.5 - t) * len * 0.22, side * halfWidth(s0) * lat, up], off: [-Math.cos(a) * r * u, side * Math.sin(a) * r * u, -0.012 * u] };
    });
  };
  const k = long ? 1.85 : 1;
  paired(0, 0.215, 0.9, -0.035, 0.165 * k, 1.3, 0.32);
  paired(2, 0.47, 0.72, -0.075, 0.085 * k, 0.95, 0.25);
  // dorsal: a strip along the back
  const dl = long ? 0.11 : 0.072;
  grid(3, 14, 4, (u, v) => {
    const t = (v + 1) / 2, s = 0.33 + t * 0.36;
    const h = dl * (t < 0.12 ? t / 0.12 : 1 - 0.7 * Math.pow((t - 0.12) / 0.88, 0.9));
    return { s, off: [0, 0, topH(s) * 0.92 + u * h] };
  });
  // caudal: a soft fork, splayed so it shows from above
  const len = long ? 0.42 : 0.21, span = long ? 0.2 : 0.135, tilt = 0.42;
  grid(9, 12, 5, (u, v) => {
    const av = Math.abs(v);
    const lc = long ? len * (1 - 0.18 * av * av) : len * (0.78 + 0.22 * Math.pow(av, 1.3));
    const sp = (0.022 + (span - 0.022) * Math.pow(u, 0.75)) * v;
    return { s: 0.82 + u * lc, off: [0, sp * Math.cos(tilt), sp * Math.sin(tilt) * Math.sign(v) * av] };
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(aS.length * 3), 3));
  g.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 1));
  g.setAttribute('aRoot', new THREE.Float32BufferAttribute(aRoot, 3));
  g.setAttribute('aOff', new THREE.Float32BufferAttribute(aOff, 3));
  g.setAttribute('aUV', new THREE.Float32BufferAttribute(aUV, 2));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(aKind, 1));
  g.setIndex(idx);
  return { geometry: g, sMax: 0.82 + len + 0.02 };
}

// ---------- shaders
const VS_HEAD = /* glsl */ `
${COMMON}
#define NSP ${NSP}
uniform vec4 uSpine[NSP];   // xy position, zw forward tangent
uniform float uSMax, uLen, uZ, uPitch;
uniform vec4 uSwim;          // phase, tail amplitude (L), wave number, unused
uniform vec4 uFin;           // spread left, spread right, paddle phase, paddle amplitude
uniform vec2 uShadowDir;
vec2 cr(vec2 a, vec2 b, vec2 c, vec2 d, float t) {
  float t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2. * b) + (-a + c) * t + (2. * a - 5. * b + 4. * c - d) * t2 + (-a + 3. * b - 3. * c + d) * t3);
}
float env(float s) { return 0.1 + 0.9 * pow(smoothstep(0.04, 1.0, s), 1.4); }
// the swimming spine at s: centre and forward tangent
void frame(float s, out vec2 c, out vec2 t) {
  float f = clamp(s / uSMax, 0., 1.) * float(NSP - 1);
  int i = int(min(floor(f), float(NSP - 2)));
  float a = f - float(i);
  vec2 p0 = uSpine[max(i - 1, 0)].xy, p1 = uSpine[i].xy, p2 = uSpine[i + 1].xy, p3 = uSpine[min(i + 2, NSP - 1)].xy;
  if (i == 0) p0 = 2. * p1 - p2;
  if (i + 2 > NSP - 1) p3 = 2. * p2 - p1;
  vec2 p = cr(p0, p1, p2, p3, a);
  vec2 tt = normalize(mix(uSpine[i].zw, uSpine[i + 1].zw, a));
  vec2 n = vec2(-tt.y, tt.x);
  float ph = uSwim.x - uSwim.z * s;
  float e = env(s), de = (env(s + 0.01) - env(s - 0.01)) / 0.02;
  float off = uSwim.y * e * sin(ph);
  float doff = uSwim.y * (de * sin(ph) - e * uSwim.z * cos(ph));
  c = p + n * off * uLen;
  t = normalize(tt - n * doff);
}
vec4 place(vec3 w) {
#ifdef SHADOW
  return projectionMatrix * viewMatrix * vec4(w.xy + uShadowDir * (w.z + uD), -uD, 1.);
#else
  return projectionMatrix * viewMatrix * vec4(w, 1.);
#endif
}
`;

const BODY_VS = /* glsl */ `
${VS_HEAD}
attribute float aS, aArc;
attribute vec2 aSec;
attribute vec3 aNorm;
varying vec3 vW, vN, vRest;
varying float vArc;
void main() {
  vec2 c, t; frame(aS, c, t);
  vec2 n = vec2(-t.y, t.x);
  vec3 w = vec3(c + n * aSec.x * uLen, uZ + aSec.y * uLen + uPitch * (aS - 0.4) * uLen);
  vN = normalize(vec3(t, 0.) * aNorm.x + vec3(n, 0.) * aNorm.y + vec3(0, 0, 1) * aNorm.z);
  vW = w; vRest = vec3(aS, aSec); vArc = aArc;
  gl_Position = place(w);
}`;

const FIN_VS = /* glsl */ `
${VS_HEAD}
attribute float aS, aKind;
attribute vec3 aRoot, aOff;
attribute vec2 aUV;
varying vec3 vW, vN;
varying vec2 vUV;
varying float vKind;
void main() {
  vec2 c, t; frame(aS, c, t);
  vec2 n = vec2(-t.y, t.x);
  vec3 off = aOff;
  float u = aUV.x;
  if (aKind < 3.5) {
    // paired fins: spread out or tuck in about the root, and paddle
    float side = mod(aKind, 2.) < 0.5 ? 1. : -1.;
    float spread = aKind < 1.5 ? (side > 0. ? uFin.x : uFin.y) : 0.5 + 0.5 * (side > 0. ? uFin.x : uFin.y);
    float ang = -side * (spread - 0.55) * 0.9;
    float ca = cos(ang), sa = sin(ang);
    off.xy = vec2(ca * off.x - sa * off.y, sa * off.x + ca * off.y);
    float flap = sin(uFin.z - u * 1.6 + side * 0.4 + aKind) * uFin.w * pow(u, 1.4);
    off.z += flap * 0.07 + (spread - 0.5) * 0.02 * u;
    off.xy *= 1. - abs(flap) * 0.12;
    off += aRoot;
  } else if (aKind < 4.5) {
    // dorsal: the top lags the body's sway
    float ph = uSwim.x - uSwim.z * aS - 0.9;
    off.y += sin(ph) * uSwim.y * 0.9 * u;
  } else {
    // caudal: the trailing edge lags, flutters and, on long fins, flows
    float ph = uSwim.x - uSwim.z * aS - 1.4;
    off.y += sin(ph) * uSwim.y * 0.5 * u * u * (1. + abs(aUV.y));
    off.z += sin(uTime * 1.7 + aUV.y * 3. + aS * 9.) * 0.006 * u * u * (uSMax - 0.8) * 4.;
  }
  vec3 w = vec3(c, uZ + uPitch * (aS - 0.4) * uLen) + (vec3(t, 0.) * off.x + vec3(n, 0.) * off.y + vec3(0, 0, 1) * off.z) * uLen;
  vW = w; vUV = aUV; vKind = aKind;
  vN = aKind > 3.5 && aKind < 4.5 ? vec3(n, 0.3) : vec3(0., 0., 1.);
  gl_Position = place(w);
}`;

// colour pattern: shared by body and fins
const PATTERN = /* glsl */ `
uniform vec3 uBase, uC1, uC2;
uniform vec4 uPat;   // red threshold, black threshold, dorsal bias, red on the head
uniform vec4 uPat2;  // net, metallic, scale relief, seed
uniform vec4 uPat3;  // red scale, black scale, mode (0 patches, 1 asagi, 2 tancho), dark fin roots
uniform float uWhite; // how milky-translucent the white skin reads
vec3 koiColour(vec3 rest, float up, out float white) {
  float s = rest.x;
  vec3 q = vec3(s * 4.2, rest.y * 7., rest.z * 7.) * uPat3.x + uPat2.w;
  float dors = smoothstep(-0.6, 0.15, up + uPat.z * 0.4);
  float m1 = fbm3(q);
  float ew = mix(0.018, 0.05, uPaint);
  float red = smoothstep(uPat.x - ew, uPat.x + ew, m1) * dors;
  red = max(red, uPat.w * smoothstep(0.045, 0.075, s) * smoothstep(0.23, 0.18, s) * smoothstep(-0.1, 0.45, up) * smoothstep(0.38, 0.45, m1 + 0.1));
  if (uPat3.z > 1.5) red = smoothstep(0.048, 0.038, length(vec2((s - 0.125) * 0.9, rest.y))) * step(0., up);
  else if (uPat3.z > 0.5) red = smoothstep(0.15, -0.35, up) * smoothstep(0.06, 0.14, s) + smoothstep(0.2, 0.12, s) * smoothstep(0.2, -0.1, up);
  float m2 = fbm3(vec3(s * 9., rest.y * 14., rest.z * 14.) * uPat3.y + uPat2.w + 11.);
  float blk = smoothstep(uPat.y - ew, uPat.y + ew, m2) * mix(dors, 1., step(uPat.z, -0.5));
  vec3 c = mix(uBase, uC1, clamp(red, 0., 1.));
  c = mix(c, uC2, clamp(blk, 0., 1.));
  white = (1. - clamp(red, 0., 1.)) * (1. - clamp(blk, 0., 1.)) * uWhite;
  return c;
}
`;

const BODY_FS = /* glsl */ `
${COMMON}
${PATTERN}
varying vec3 vW, vN, vRest;
varying float vArc;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vW);
  float s = vRest.x;
  float upR = vRest.z / max(length(vRest.yz), 1e-3);
  float white;
  vec3 alb = koiColour(vRest, upR, white);
  // scales: overlapping rows, each brighter towards its free edge with a fine dark rim
  vec2 q = vec2(s, vArc) * vec2(34., 34.);
  q.y += 0.5 * floor(q.x);
  vec2 cell = floor(q), fq = fract(q) - 0.5;
  float d = length(vec2(fq.x + 0.5, fq.y * 1.25));
  float scaleOn = smoothstep(0.17, 0.25, s) * uPat2.z * (1. - 0.75 * uPaint);
  float rim = smoothstep(0.78, 1.0, d) * smoothstep(1.15, 1.0, d);
  float sparkle = hash12(cell + uPat2.w);
  alb *= 1. + scaleOn * (0.10 * smoothstep(0.1, 0.85, d) - 0.18 * rim);
  alb *= 1. - uPat2.x * rim * smoothstep(0.17, 0.25, s) * 0.75;
  // eyes and nostrils
  float eye = length(vec3(s - 0.088, abs(vRest.y) - 0.068, vRest.z - 0.02));
  alb = mix(alb, vec3(0.62, 0.48, 0.18) * 0.5, smoothstep(0.019, 0.015, eye));
  alb = mix(alb, vec3(0.008), smoothstep(0.012, 0.009, eye));
  float nos = length(vec2(s - 0.035, abs(vRest.y) - 0.026)) + max(0., -vRest.z) * 2.;
  alb = mix(alb, alb * 0.45, smoothstep(0.009, 0.005, nos));
  if (uPaint > 0.5) {
    // watercolour: white skin is bare paper shaped by a cool shade on the flanks; colour
    // patches bloom wet-in-wet, darker at their cores and in backrun rims; deeper fish fade
    float wrapP = clamp((dot(N, uSunDir) + 0.4) / 1.4, 0., 1.);
    float side = clamp(1. - N.z, 0., 1.);
    float shade = clamp(side * 1.1 + (1. - wrapP) * 0.55 - 0.2, 0., 1.);
    vec3 cool = vec3(0.50, 0.63, 0.78);
    float col1 = 1. - white / max(uWhite, 1e-3) * step(0.01, uWhite);
    float n = fbm3(vRest * vec3(16., 26., 26.) + uPat2.w * 3.1);
    float n2 = fbm3(vRest * vec3(6., 11., 11.) + uPat2.w + 5.);
    float inten = clamp(0.55 + (n - 0.5) * 1.6 + 0.35, 0.45, 1.45);
    vec3 pig = pow(clamp(alb, 0.02, 1.), vec3(inten));
    float backrun = smoothstep(0.035, 0.0, abs(n2 - 0.5)) * col1;
    pig = pow(pig, vec3(1. + 0.6 * backrun));
    pig = mix(pig, vec3(0.98), smoothstep(0.62, 0.8, n2) * col1 * 0.45);      // lifted bloom
    pig *= mix(vec3(1.), cool, shade * 0.85);
    pig = mix(pig, pig * cool, smoothstep(0.75, 0.98, side) * 0.6);   // a darker stroke down the flanks
    pig = mix(pig, vec3(1.), smoothstep(0.94, 0.995, N.z) * smoothstep(0.15, 0.3, s) * 0.4); // highlight on the back
    float dk = clamp((-vW.z - 0.1) / 0.8, 0., 1.);
    pig = mix(pig, mix(vec3(1.), cool, 0.35), dk * 0.55);
    gl_FragColor = vec4(pig, 1.);
    return;
  }
  alb = s2l(alb);

  float metal = uPat2.y;
  float wrap = clamp((dot(N, uSunDir) + 0.4) / 1.4, 0., 1.);
  float cau = caustic(vW.xy, vec2(0.)) * smoothstep(-0.2, 0.7, N.z) * exp(vW.z * 2.2);
  vec3 E = underLight(vW, 0., cau, wrap);
  vec3 col = alb * E * 0.5 * (1. - metal * 0.55);
  // wet sheen (and a metallic koi's mirror scales)
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(N, H), 0.);
  float sun = dapple(toSurface(vW)) * exp(-uSigma.g * -vW.z * 2.);
  float spec = pow(nh, 70.) * 0.32 + pow(nh, 18.) * metal * (0.6 + 1.4 * sparkle * scaleOn);
  col += uSunCol * spec * sun * mix(vec3(1.), alb * 2.2 + 0.1, metal);
  col += alb * uAmb * metal * 0.35 * (0.6 + 0.8 * sparkle);
  // milky white skin glows a little at the rim
  float fr = pow(1. - max(dot(N, V), 0.), 2.);
  col += alb * uAmb * fr * (0.15 + 0.35 * white);
  col = waterPath(col, -vW.z);
  gl_FragColor = vec4(enc(col), 1.);
}`;

const FIN_FS = /* glsl */ `
${COMMON}
${PATTERN}
uniform vec3 uFinCol;
varying vec3 vW, vN;
varying vec2 vUV;
varying float vKind;
void main() {
  float u = vUV.x, v = vUV.y;
  float rays = vKind > 4.5 ? 15. : (vKind > 3.5 ? 12. : 9.);
  float ray = pow(abs(cos(v * 1.5708 * rays)), 6.);
  float edge = vKind > 3.5 && vKind < 4.5 ? 1. - smoothstep(0.7, 1., u) : 1. - smoothstep(0.82, 1., u);
  edge *= 1. - smoothstep(0.85, 1., abs(v)) * (vKind > 4.5 ? 0.5 : 1.);
  float a = (0.22 + 0.28 * ray + 0.45 * (1. - u) * (1. - u)) * edge;
  float white;
  vec3 root = koiColour(vec3(0.3, 0., 0.1), 1., white);
  vec3 alb = mix(root, uFinCol, smoothstep(0.0, 0.55, u));
  alb = mix(alb, vec3(0.04), uPat3.w * ray * smoothstep(0.55, 0.0, u));
  if (uPaint > 0.5) {
    // pale, streaky strokes of a dry brush, cool towards the tips
    float streak = vnoise(vec2(v * 22. + vKind * 7., u * 2.2)) * 0.7 + vnoise(vec2(v * 60. + vKind, u * 5.)) * 0.3;
    float aa = a * (0.45 + 0.9 * streak) * (1. - 0.45 * u);
    vec3 pig = mix(pow(alb, vec3(0.8)), mix(uFinCol, vec3(0.52, 0.68, 0.82), 0.65), smoothstep(0.0, 0.6, u));
    pig = mix(pig, pig * vec3(0.8, 0.88, 0.95), ray * 0.6);
    float dk = clamp((-vW.z - 0.1) / 0.8, 0., 1.);
    float al = clamp(aa * 2.4, 0., 0.9) * (1. - dk * 0.4);
    gl_FragColor = vec4(pig * al, al);   // premultiplied, glazed by multiply
    return;
  }
  alb = s2l(alb * (0.9 + 0.2 * ray));
  vec3 E = underLight(vW, 0., caustic(vW.xy, vec2(0.)) * exp(vW.z * 2.2), 0.85);
  vec3 col = alb * E * 0.5 + uAmb * alb * 0.12;
  col = waterPath(col, -vW.z);
  gl_FragColor = vec4(enc(col), a);
}`;

const SHADOW_BODY_FS = /* glsl */ `uniform float uShadowK; void main() { gl_FragColor = vec4(vec3(0.85 * uShadowK), 1.); }`;
const SHADOW_FIN_FS = /* glsl */ `uniform float uShadowK; varying vec2 vUV; void main() { gl_FragColor = vec4(vec3((0.28 - 0.18 * vUV.x) * uShadowK), 1.); }`;

// ---------- varieties (sRGB). red/black thresholds: higher means less of that colour.
const W_ = '#f2eee4';
export const VARIETIES = {
  kohaku:   { base: W_, c1: '#d33a1b', c2: '#141414', t1: 0.53, t2: 2, dorsal: 0.4, head: 1, mode: 0, net: 0, metal: 0, fin: '#f3efe9', white: 1 },
  sanke:    { base: W_, c1: '#d23d1f', c2: '#121212', t1: 0.56, t2: 0.68, dorsal: 0.5, head: 1, mode: 0, net: 0, metal: 0, fin: '#f0ece6', white: 1, finRoot: 0.5 },
  showa:    { base: W_, c1: '#cf3a1d', c2: '#0e0e0e', t1: 0.52, t2: 0.50, dorsal: -1, head: 0.6, mode: 0, net: 0, metal: 0, fin: '#e8e4dc', white: 1, finRoot: 1 },
  ogon:     { base: '#e7ad38', c1: '#e7ad38', c2: '#000', t1: 2, t2: 2, dorsal: 0, head: 0, mode: 0, net: 0.25, metal: 1, fin: '#f0c862', white: 0 },
  platinum: { base: '#e3e6e8', c1: '#e3e6e8', c2: '#000', t1: 2, t2: 2, dorsal: 0, head: 0, mode: 0, net: 0.12, metal: 1, fin: '#eef0f2', white: 0.3 },
  chagoi:   { base: '#86663f', c1: '#86663f', c2: '#000', t1: 2, t2: 2, dorsal: 0, head: 0, mode: 0, net: 0.6, metal: 0.15, fin: '#9b7d55', white: 0 },
  asagi:    { base: '#6c8593', c1: '#d0581f', c2: '#000', t1: 0, t2: 2, dorsal: 0, head: 0, mode: 1, net: 0.85, metal: 0, fin: '#d9a07c', white: 0 },
  tancho:   { base: W_, c1: '#d6391b', c2: '#000', t1: 0, t2: 2, dorsal: 0, head: 0, mode: 2, net: 0, metal: 0, fin: '#f4f0ea', white: 1 },
  kujaku:   { base: '#d9dcd8', c1: '#df6d28', c2: '#000', t1: 0.5, t2: 2, dorsal: 0.6, head: 0.4, mode: 0, net: 0.7, metal: 0.7, fin: '#e9ece8', white: 0.2 },
  kigoi:    { base: '#efcf47', c1: '#efcf47', c2: '#000', t1: 2, t2: 2, dorsal: 0, head: 0, mode: 0, net: 0.15, metal: 0, fin: '#f5df7c', white: 0.2 },
  utsuri:   { base: W_, c1: W_, c2: '#101010', t1: 2, t2: 0.47, dorsal: -1, head: 0, mode: 0, net: 0, metal: 0, fin: '#ece8e0', white: 1, finRoot: 0.8 },
  benigoi:  { base: '#c4421f', c1: '#c4421f', c2: '#000', t1: 2, t2: 2, dorsal: 0, head: 0, mode: 0, net: 0.2, metal: 0, fin: '#d9714a', white: 0 },
};
// the pond's residents, in the order they are added (length in metres, butterfly fins)
export const RESIDENTS = [
  ['kohaku', 0.70], ['ogon', 0.62], ['sanke', 0.60], ['showa', 0.64], ['platinum', 0.56, true], ['chagoi', 0.78],
  ['asagi', 0.52], ['tancho', 0.54], ['kohaku', 0.50, true], ['kigoi', 0.46], ['kujaku', 0.50], ['utsuri', 0.58],
  ['benigoi', 0.48], ['sanke', 0.44, true],
];

const col3 = (hex) => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); }; // THREE.Color converts to linear; we want sRGB here
function srgb3(hex) { const n = parseInt(hex.slice(1), 16); return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); }
void col3;

let BODY_GEO = null;
const FIN_GEO = {};

export class Koi {
  constructor({ variety, L, long, seed, x, y, h, shared }) {
    this.variety = variety; this.L = L; this.long = !!long; this.seed = seed;
    this.x = x; this.y = y; this.h = h; this.z = -0.3 - (seed % 0.4); this.zt = this.z;
    this.v = L * 0.3; this.omega = 0; this.phase = seed * 10; this.amp = 0.6; this.beat = 1;
    this.finPhase = seed * 7; this.spreadL = 0.5; this.spreadR = 0.5; this.pitch = 0;
    this.hunger = 0.5 + (seed % 0.5); this.boost = 0; this.nextRipple = 0; this.diveUntil = 0;
    this.target = null;
    BODY_GEO ||= bodyGeometry();
    FIN_GEO[this.long] ||= finGeometry(this.long);
    const fg = FIN_GEO[this.long];
    this.sMax = fg.sMax;
    this.P = []; for (let i = 0; i < NSP; i++) this.P.push(new THREE.Vector4());
    this.resetSpine();
    const V = VARIETIES[variety];
    this.u = {
      uSpine: { value: this.P }, uSMax: { value: this.sMax }, uLen: { value: L }, uZ: { value: this.z }, uPitch: { value: 0 },
      uSwim: { value: new THREE.Vector4(0, 0.05, 5.6, 0) }, uFin: { value: new THREE.Vector4(0.5, 0.5, 0, 0.3) },
      uBase: { value: srgb3(V.base) }, uC1: { value: srgb3(V.c1) }, uC2: { value: srgb3(V.c2) }, uFinCol: { value: srgb3(V.fin) },
      uPat: { value: new THREE.Vector4(V.t1, V.t2, V.dorsal, V.head) },
      uPat2: { value: new THREE.Vector4(V.net, V.metal, 1, (seed * 97.13) % 50) },
      uPat3: { value: new THREE.Vector4(0.85 + (seed * 3.1 % 0.4), 0.9 + (seed * 5.3 % 0.4), V.mode, V.finRoot || 0) },
      uWhite: { value: V.white }, uShadowK: { value: 1 },
    };
    const U = { ...shared, ...this.u };
    this.body = new THREE.Mesh(BODY_GEO, new THREE.ShaderMaterial({ uniforms: U, vertexShader: BODY_VS, fragmentShader: BODY_FS }));
    this.fins = new THREE.Mesh(fg.geometry, new THREE.ShaderMaterial({ uniforms: U, vertexShader: FIN_VS, fragmentShader: FIN_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    const sOpt = { uniforms: U, defines: { SHADOW: 1 }, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true };
    this.sBody = new THREE.Mesh(BODY_GEO, new THREE.ShaderMaterial({ ...sOpt, vertexShader: BODY_VS, fragmentShader: SHADOW_BODY_FS }));
    this.sFins = new THREE.Mesh(fg.geometry, new THREE.ShaderMaterial({ ...sOpt, vertexShader: FIN_VS, fragmentShader: SHADOW_FIN_FS, side: THREE.DoubleSide }));
    for (const m of [this.body, this.fins, this.sBody, this.sFins]) m.frustumCulled = false;
  }
  resetSpine() {
    const seg = (this.sMax * this.L) / (NSP - 1), dx = Math.cos(this.h), dy = Math.sin(this.h);
    for (let i = 0; i < NSP; i++) this.P[i].set(this.x - dx * seg * i, this.y - dy * seg * i, dx, dy);
  }
  get mouth() { return [this.x + Math.cos(this.h) * 0.01, this.y + Math.sin(this.h) * 0.01]; }

  // W: { t, hx, hy, fish, pellets, calls, fingers, startle, ripple(x,y,a), onEat(x,y) }
  update(dt, W) {
    const L = this.L, t = W.t, sd = this.seed;
    let dx = Math.cos(this.h), dy = Math.sin(this.h);
    let ax = 0, ay = 0, excite = 0;
    // cruising speed and depth drift with slow noise of their own
    let vt = L * (0.24 + 0.14 * (0.5 + 0.5 * wobble(t * 0.05 + sd * 17)));
    let zt = -0.22 - 0.4 * (0.5 + 0.5 * wobble(t * 0.021 + sd * 5)) ;
    if (wobble(t * 0.013 + sd * 3) > 0.72) zt = -0.07;          // now and then, up to bask
    // walls: look ahead and turn back in before reaching the edge
    const look = L * 0.7 + this.v * 2.2, px = this.x + dx * look, py = this.y + dy * look;
    const mx = W.hx + 0.05, my = W.hy + 0.05;
    if (px > mx) ax -= (px - mx) * 2.2; if (px < -mx) ax += (-mx - px) * 2.2;
    if (py > my) ay -= (py - my) * 2.2; if (py < -my) ay += (-my - py) * 2.2;
    // company: keep clear of fish at a similar depth, drift into line with ones nearby
    for (const o of W.fish) {
      if (o === this) continue;
      const ex = this.x - o.x, ey = this.y - o.y, d = Math.hypot(ex, ey) + 1e-6, dz = Math.abs(this.z - o.z);
      const rs = (L + o.L) * 0.62;
      if (d < rs && dz < 0.22) { const k = ((rs - d) / rs) * 1.6 * (1 - dz / 0.22); ax += (ex / d) * k; ay += (ey / d) * k; }
      if (d < 1.3) { const k = 0.07 * (1 - d / 1.3); ax += Math.cos(o.h) * k; ay += Math.sin(o.h) * k; }
    }
    // food on the surface
    this.hunger = Math.min(1, this.hunger + dt * 0.012);
    let food = null, fd = 2.6;
    if (this.hunger > 0.15) for (const p of W.pellets) { if (!p.alive) continue; const d = Math.hypot(p.x - this.x, p.y - this.y); if (d < fd) { fd = d; food = p; } }
    if (food) {
      const k = 1.6 * this.hunger + 0.6;
      ax += ((food.x - this.x) / fd) * k; ay += ((food.y - this.y) / fd) * k;
      vt = Math.max(vt, L * (0.55 + 0.6 * Math.min(1, fd)));
      zt = fd < 0.9 ? -0.045 : -0.12; excite = 1;
      const [mx_, my_] = this.mouth;
      if (Math.hypot(food.x - mx_, food.y - my_) < 0.035 + L * 0.06 && this.z > -0.14) {
        food.alive = false; this.hunger = Math.max(0, this.hunger - 0.14); this.diveUntil = t + 1.6 + (sd % 1);
        W.onEat(food.x, food.y, this);
      }
    }
    // a finger held on the water calls them over
    for (const c of W.calls) {
      const ex = c.x - this.x, ey = c.y - this.y, d = Math.hypot(ex, ey) + 1e-6;
      if (d > 3.6) continue;
      const k = d > 0.45 ? 1.1 * Math.min(1, (d - 0.45) * 2) : -0.6 * (1 - d / 0.45);
      ax += (ex / d) * k; ay += (ey / d) * k;
      vt = Math.max(vt, L * (d > 1 ? 0.6 : 0.35)); zt = Math.max(zt, d < 1.2 ? -0.06 : -0.15); excite = Math.max(excite, 0.5);
    }
    // a finger in the water: they shy away from it
    for (const f of W.fingers) {
      const ex = this.x - f.x, ey = this.y - f.y, d = Math.hypot(ex, ey) + 1e-6, r = 0.55 + L * 0.4;
      if (d < r) { const k = 2.4 * (1 - d / r); ax += (ex / d) * k; ay += (ey / d) * k; vt = Math.max(vt, L * 0.9); zt = Math.min(zt, -0.35); }
    }
    // a shake: dart away and dive, then settle over a few seconds
    if (W.startle && W.startle.t === t) {
      const ex = this.x - W.startle.x, ey = this.y - W.startle.y, d = Math.hypot(ex, ey) + 1e-6;
      if (d < W.startle.r) { this.h = Math.atan2(ey, ex) + (Math.random() - 0.5) * 1.2; this.boost = Math.max(this.boost, (1 - d / W.startle.r) * 2.4 + 0.6); this.diveUntil = t + 4; }
    }
    if (t < this.diveUntil) zt = Math.min(zt, -0.5);
    if (this.boost > 0) { vt = Math.max(vt, L * (0.6 + 1.6 * this.boost)); this.boost = Math.max(0, this.boost - dt * 0.9); }

    // steering: turn towards the summed wish, plus a wandering drift of its own
    const wish = Math.atan2(dy + ay, dx + ax);
    let turn = wobble(t * 0.09 + sd * 13.1) * 0.42 + clamp(angDiff(wish, this.h) * 1.7, -1.8, 1.8);
    const maxTurn = 0.7 + 2.6 * (this.v / L) + excite * 0.6;
    this.omega += (clamp(turn, -maxTurn, maxTurn) - this.omega) * Math.min(1, dt * 1.6);
    this.h += this.omega * dt;
    dx = Math.cos(this.h); dy = Math.sin(this.h);

    // beat and glide: koi thrust up to speed, then coast with the tail almost still
    if (this.v < vt * 0.9) this.beat = 1; else if (this.v > vt * 1.12) this.beat = 0;
    const turning = Math.min(1, Math.abs(this.omega) * 0.7);
    this.amp += ((this.beat ? 1 : 0.1 + 0.5 * turning) - this.amp) * Math.min(1, dt * 2.2);
    const vGoal = this.beat ? vt * 1.3 : vt * 0.6;
    this.v += (vGoal - this.v) * dt * (this.beat ? 0.9 + this.amp : 0.35);
    this.x += dx * this.v * dt; this.y += dy * this.v * dt;
    const zPrev = this.z;
    this.z += clamp(zt - this.z, -1, 1) * Math.min(1, dt * (0.25 + excite * 0.5));
    this.z = clamp(this.z, -uDepthMax, -0.035 - L * 0.06);
    this.pitch += (clamp((this.z - zPrev) / Math.max(dt, 1e-3) * 1.4, -0.25, 0.25) - this.pitch) * Math.min(1, dt * 2);

    // tail: frequency follows speed, amplitude the thrust
    const f = 0.45 + 1.45 * (this.v / L) * (0.35 + 0.65 * this.amp);
    this.phase += 2 * Math.PI * f * dt;
    const ampTail = (0.018 + 0.07 * this.amp) * (1 + turning * 0.5) * (this.long ? 0.85 : 1);
    // pectoral fins: tucked to glide, out and paddling to hover and brake, the inner one out in a turn
    const slow = 1 - Math.min(1, this.v / (L * 0.3));
    const base = 0.25 + 0.25 * this.amp + 0.45 * slow;
    const inner = clamp(this.omega * 0.5, -0.4, 0.4);
    this.spreadL += (clamp(base + Math.max(0, inner), 0, 1) - this.spreadL) * Math.min(1, dt * 2);
    this.spreadR += (clamp(base + Math.max(0, -inner), 0, 1) - this.spreadR) * Math.min(1, dt * 2);
    this.finPhase += dt * (1.6 + 2.2 * slow + excite);

    // the surface: a basking or feeding fish dimples it now and then
    if (this.z > -0.075 && t > this.nextRipple) { W.ripple(this.x + dx * L * 0.05, this.y + dy * L * 0.05, 0.35 + excite * 0.3); this.nextRipple = t + 0.9 + Math.random() * 1.5; }
    this.updateSpine(dt);
    this.u.uZ.value = this.z; this.u.uPitch.value = this.pitch;
    this.u.uSwim.value.set(this.phase, ampTail, 5.4, 0);
    this.u.uFin.value.set(this.spreadL, this.spreadR, this.finPhase, 0.25 + 0.6 * slow + 0.3 * excite);
  }

  updateSpine(dt) {
    const P = this.P, seg = (this.sMax * this.L) / (NSP - 1), dx = Math.cos(this.h), dy = Math.sin(this.h);
    P[0].x = this.x; P[0].y = this.y; P[1].x = this.x - dx * seg; P[1].y = this.y - dy * seg;
    const relax = Math.exp(-dt * 0.9), maxB = 0.2;
    for (let i = 2; i < NSP; i++) {
      let fx = P[i - 2].x - P[i - 1].x, fy = P[i - 2].y - P[i - 1].y; const fl = Math.hypot(fx, fy) || 1; fx /= fl; fy /= fl;
      let vx = P[i - 1].x - P[i].x, vy = P[i - 1].y - P[i].y; const vl = Math.hypot(vx, vy) || 1; vx /= vl; vy /= vl;
      let a = Math.atan2(fx * vy - fy * vx, fx * vx + fy * vy);
      a = clamp(a * relax, -maxB, maxB);
      const ca = Math.cos(a), sa = Math.sin(a);
      vx = fx * ca - fy * sa; vy = fx * sa + fy * ca;
      P[i].x = P[i - 1].x - vx * seg; P[i].y = P[i - 1].y - vy * seg;
    }
    for (let i = 0; i < NSP; i++) {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(NSP - 1, i + 1)];
      let tx = a.x - b.x, ty = a.y - b.y; if (i === 0) { tx = dx; ty = dy; }
      const l = Math.hypot(tx, ty) || 1; P[i].z = tx / l; P[i].w = ty / l;
    }
  }
  dispose() { for (const m of [this.body, this.fins, this.sBody, this.sFins]) m.material.dispose(); }
}
const uDepthMax = 0.9;

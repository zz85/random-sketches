// Shared GLSL: noise, the water's optics, sunlight through the canopy, caustics, ripples.
// Every shader works in linear light. Render targets are 8-bit, so colour is stored as
// sqrt(linear) (enc / dec) to keep dark water free of banding; the final pass tone maps.
import * as THREE from 'three';

export const MAXR = 24; // ripples the surface keeps at once

// one uniform set, spread by reference into every material
export function makeShared() {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.34, 0.42, 0.84).normalize() },
    uSunCol: { value: new THREE.Vector3(2.5, 2.38, 2.12) },
    uAmb: { value: new THREE.Vector3(0.42, 0.52, 0.58) },
    // extinction per unit of water (red goes first) and the colour it scatters back
    uSigma: { value: new THREE.Vector3(1.25, 0.52, 0.58) },
    uScatter: { value: new THREE.Vector3(0.004, 0.013, 0.012) },
    uD: { value: 1.1 },               // pond depth
    uCaustic: { value: null },        // the caustic map on the bottom, simulated each frame (pond.js)
    uCauRect: { value: new THREE.Vector4(-1, -1, 2, 2) },
    uWave: { value: capillaryWaves() }, // short wind waves that focus the sunlight
    uDappleK: { value: 1 },            // how much the canopy shades the pond
    uShadowDir: { value: new THREE.Vector2() }, // where shadows fall per unit of height
    uPaint: { value: 0 },              // 1: shaders output watercolour pigment (sRGB on white) instead of light
    uRain: { value: 0 },               // 0 dry, up to 1 steady rain
  };
}

// a light breeze: wavelengths of 16 to 35 cm from every side, each tilting the water 3 to 4.5 degrees
// (the surface shading takes them at a third of that; the caustics need the full slope)
function capillaryWaves() {
  const out = [];
  for (let i = 0; i < 8; i++) {
    const a = 0.6 + i * 2.39996 + Math.sin(i * 5.1) * 0.3, k = 18 + ((i * 0.618034) % 1) * 22;
    out.push(new THREE.Vector4(Math.cos(a), Math.sin(a), k, (0.05 + 0.03 * ((i * 0.381966) % 1)) / k));
  }
  return out;
}

export const COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir, uSunCol, uAmb, uSigma, uScatter;
uniform float uD, uDappleK, uPaint;
uniform sampler2D uCaustic;
uniform vec4 uCauRect;
#define NW 8
uniform vec4 uWave[NW]; // direction, wavenumber, amplitude
vec3 enc(vec3 c) { return sqrt(max(c, 0.)); }
vec3 dec(vec3 c) { return c * c; }
vec3 s2l(vec3 c) { return pow(c, vec3(2.2)); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm3o(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= .5; } return s / .875; }
float fbm(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= .5; } return s / .96875; }
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  float a = mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y);
  float b = mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y);
  return mix(a, b, u.z);
}
float fbm3(vec3 p) { float s = 0., a = .5; for (int i = 0; i < 3; i++) { s += a * vnoise3(p); p = p * 2.03 + 7.1; a *= .5; } return s / .875; }

// sunlight through a maple canopy far above: soft bright patches that sway and drift.
// xy is where the sun ray crosses the surface.
float dapple(vec2 xy) {
  vec2 q = xy * 0.38 + vec2(uTime * 0.004, -uTime * 0.003);
  q += 0.05 * vec2(sin(uTime * 0.23 + q.y * 3.), cos(uTime * 0.19 + q.x * 3.));
  float n = fbm3o(q);
  return mix(1., mix(0.45, 1.0, smoothstep(0.40, 0.60, n)), uDappleK);
}
// where a sun ray to a point at height z (< 0) crossed the surface
vec2 toSurface(vec3 p) { return p.xy + uSunDir.xy / uSunDir.z * (-p.z); }

// the caustic net on the bottom at p (the map pond.js simulates each frame)
float caustic(vec2 p) { return texture(uCaustic, (p - uCauRect.xy) / uCauRect.zw).r; }
// at a point above the bottom (a fish's back) the same light has focused less
float causticAt(vec3 p) {
  float c = caustic(toSurface(p) - uSunDir.xy / uSunDir.z * uD);
  return mix(0.42, c, clamp(-p.z / uD * 2.2, 0., 1.));
}
// the short wind waves: slope g and its derivatives H (xx, yy, xy) at p.
// Deep-water capillary-gravity dispersion, slowed to half speed for calm.
void capillary(vec2 p, out vec2 g, out vec3 H) {
  g = vec2(0.); H = vec3(0.);
  for (int i = 0; i < NW; i++) {
    vec4 w = uWave[i];
    float k = w.z, om = sqrt(9.81 * k + 7.3e-5 * k * k * k) * 0.5;
    float ph = k * dot(w.xy, p) - om * uTime + float(i) * 2.399;
    float c = cos(ph), s = sin(ph);
    g += w.xy * (w.w * k * c);
    H -= vec3(w.x * w.x, w.y * w.y, w.x * w.y) * (w.w * k * k * s);
  }
}

// light reaching a point under water, before the view path: sun through the water column
// and the canopy, the caustic net, and sky light
vec3 underLight(vec3 p, float shade, float cau, float facing) {
  float depth = max(-p.z, 0.);
  vec3 down = exp(-uSigma * depth / uSunDir.z);
  float sun = dapple(toSurface(p)) * (1. - shade) * (0.15 + 3.4 * cau * cau) * facing;
  return uSunCol * uSunDir.z * sun * down + uAmb * exp(-uSigma * depth * 1.2) * (0.55 + 0.45 * facing);
}
// the view path back up through depth d (path length lw)
vec3 waterPath(vec3 col, float lw) {
  vec3 T = exp(-uSigma * lw);
  return col * T + uScatter * (uSunCol + uAmb) * (1. - T);
}
`;

// analytic ripple rings: wave packets that spread, widen and fade
export const RIPPLES = /* glsl */ `
#define MAXR ${MAXR}
uniform vec4 uRip[MAXR];   // x, y, start time, amplitude
uniform int uRipN;
const float RC = 0.32, RK = 62.;
// rain: drops on a hashed grid, each cell's slots firing now and then, each a small ring.
// How many fire is uRain; none of it is stored, so it costs nothing in the ripple list.
uniform float uRain;
const float RCELL = 0.45;
vec2 rainGrad(vec2 p) {
  vec2 g = vec2(0.);
  if (uRain < 0.01) return g;
  vec2 c0 = floor(p / RCELL);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) for (int k = 0; k < 2; k++) {
    vec2 c = c0 + vec2(i, j) + float(k) * 71.3;
    float P = 1.1 + 0.6 * hash12(c * 1.7 + 3.1);
    float ph = uTime / P + hash12(c + 9.2), n = floor(ph), age = fract(ph) * P;
    if (hash12(c + n * 13.17) > uRain * 0.8) continue;
    vec2 d = p - (c0 + vec2(i, j) + hash22(c + n * 7.31)) * RCELL;
    float dist = length(d) + 1e-4, w = 0.012 + age * 0.03, x = dist - age * 0.2, kk = 120. / (1. + age);
    if (abs(x) > 3. * w) continue;
    float env = (0.6 + 0.4 * hash12(c + n)) * 0.0011 * exp(-age * 2.6) * exp(-x * x / (w * w));
    g += d / dist * env * (kk * cos(kk * x) - 2. * x / (w * w) * sin(kk * x));
  }
  return g;
}
vec2 rippleGrad(vec2 p) {
  vec2 g = rainGrad(p);
  for (int i = 0; i < MAXR; i++) {
    if (i >= uRipN) break;
    vec4 r = uRip[i];
    float age = uTime - r.z;
    if (age < 0.) continue;
    vec2 d = p - r.xy;
    float dist = length(d) + 1e-4;
    float w = 0.045 + age * 0.045;
    float x = dist - age * RC;
    if (abs(x) > 3. * w) continue;
    float k = RK / (1. + age * 0.5);
    float env = r.w * exp(-age * 0.6) / (1. + dist * 3.) * exp(-x * x / (w * w));
    g += d / dist * env * (k * cos(k * x) - 2. * x / (w * w) * sin(k * x));
  }
  return g;
}
`;

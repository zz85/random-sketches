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
    uScatter: { value: new THREE.Vector3(0.006, 0.020, 0.018) },
    uD: { value: 1.1 },               // pond depth
    uCaustic: { value: null },
    uDappleK: { value: 1 },            // how much the canopy shades the pond
    uShadowDir: { value: new THREE.Vector2() }, // where shadows fall per unit of height
  };
}

export const COMMON = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir, uSunCol, uAmb, uSigma, uScatter;
uniform float uD, uDappleK;
uniform sampler2D uCaustic;
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
  return mix(1., mix(0.34, 1.0, smoothstep(0.40, 0.60, n)), uDappleK);
}
// where a sun ray to a point at height z (< 0) crossed the surface
vec2 toSurface(vec3 p) { return p.xy + uSunDir.xy / uSunDir.z * (-p.z); }

// two scrolling layers of a tileable caustic web; their minimum is the bright net
float caustic(vec2 p, vec2 distort) {
  vec2 a = p * 0.82 + distort + vec2(uTime * 0.018, uTime * 0.011);
  vec2 b = p * 1.07 - distort * 0.8 + vec2(-uTime * 0.014, uTime * 0.016) + 0.37;
  return min(texture(uCaustic, a).r, texture(uCaustic, b).r);
}

// light reaching a point under water, before the view path: sun through the water column
// and the canopy, the caustic net, and sky light
vec3 underLight(vec3 p, float shade, float cau, float facing) {
  float depth = max(-p.z, 0.);
  vec3 down = exp(-uSigma * depth / uSunDir.z);
  float sun = dapple(toSurface(p)) * (1. - shade) * (0.32 + 1.55 * cau) * facing;
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
vec2 rippleGrad(vec2 p) {
  vec2 g = vec2(0.);
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

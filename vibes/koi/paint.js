// Watercolour finish: the frame becomes transparent washes on cold-pressed paper. Pigment
// pools at the edges of each wash, granulates in the paper's tooth and blooms unevenly; the
// outlines "boil" at 8 frames a second like a hand-painted animation while the paper stays put.
import * as THREE from 'three';
import { QUAD_VS, quad } from './pond.js';

const PAINT_FS = /* glsl */ `
uniform sampler2D uScene;
uniform vec2 uRes;
uniform float uTime, uExposure, uGrain;
varying vec2 vUv;
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(h12(i), h12(i + vec2(1, 0)), u.x), mix(h12(i + vec2(0, 1)), h12(i + vec2(1, 1)), u.x), u.y); }
float fb(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 4; i++) { s += a * vn(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= .5; } return s / .9375; }
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0., 1.); }
vec3 tone(vec2 uv) { vec3 c = texture(uScene, uv).rgb; c *= c; return pow(aces(c * uExposure), vec3(1. / 2.2)); }
float lum(vec3 c) { return dot(c, vec3(0.3, 0.55, 0.15)); }
void main() {
  vec2 asp = vec2(uRes.x / uRes.y, 1.), q = vUv * asp, px = 1. / uRes;
  float fr = floor(uTime * 8.);
  vec2 wob = (vec2(vn(q * 5. + fr * 1.7), vn(q * 5. + fr * 1.7 + 9.)) - 0.5) * 0.0026
           + (vec2(vn(q * 26. + fr * 3.1), vn(q * 26. + fr * 3.1 + 5.)) - 0.5) * 0.001;
  vec2 uv = vUv + wob;
  // washes: blur away the photographic texture
  vec2 r = px * 2.6 * uRes.y / 900.;
  vec3 c0 = tone(uv);
  vec3 b = (tone(uv + vec2(r.x, 0.)) + tone(uv - vec2(r.x, 0.)) + tone(uv + vec2(0., r.y)) + tone(uv - vec2(0., r.y))) * 0.25;
  vec3 b2 = (tone(uv + r * vec2(2.1, 1.4)) + tone(uv + r * vec2(-1.4, 2.1)) + tone(uv + r * vec2(-2.1, -1.4)) + tone(uv + r * vec2(1.4, -2.1))) * 0.25;
  vec3 c = c0 * 0.15 + b * 0.35 + b2 * 0.5;
  // pigment pools where neighbouring washes differ
  float e = length(vec2(lum(tone(uv + vec2(r.x * 1.6, 0.))) - lum(tone(uv - vec2(r.x * 1.6, 0.))), lum(tone(uv + vec2(0., r.y * 1.6))) - lum(tone(uv - vec2(0., r.y * 1.6)))));
  float edge = smoothstep(0.06, 0.3, e);
  // a little more colour in the colour, then to pigment density
  // lift the deep water into a mid wash, keep the colour in it
  c = pow(c, vec3(0.62));
  float l = lum(c);
  c = clamp(l + (c - l) * 1.7, 0.0, 1.0);
  vec3 dens = -log(clamp(c, 0.035, 1.));
  dens *= 0.7;
  float wash = fb(q * 2.3 + uTime * 0.003);
  dens *= 0.55 + 0.9 * wash * wash + 0.1;
  // paper: cold-pressed tooth; pigment settles in the hollows
  vec2 pq = q * uGrain;
  float tooth = fb(pq) * 0.6 + vn(pq * 3.1) * 0.4;
  dens *= 1. + (0.5 - tooth) * 0.45;
  dens += edge * 0.22 * (0.4 + dens);
  // flocculation: specks of pigment in the darker washes
  dens *= 1. + (vn(pq * 1.7 + 3.) - 0.5) * 0.2 * smoothstep(0.2, 1.2, dens.g);
  vec3 paper = vec3(0.972, 0.958, 0.925) * (0.955 + 0.06 * tooth);
  vec3 col = paper * exp(-dens);
  // the paper left bare at a ragged border
  float bd = min(min(vUv.x, 1. - vUv.x) * asp.x, min(vUv.y, 1. - vUv.y));
  float border = smoothstep(0.012, 0.05, bd + (fb(q * 7.) - 0.5) * 0.035);
  col = mix(paper, col, border);
  col += (h12(gl_FragCoord.xy) - 0.5) / 255.;
  gl_FragColor = vec4(col, 1.);
}`;

export function makePaint() {
  const u = { uScene: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, uExposure: { value: 1.25 }, uGrain: { value: 260 } };
  const material = new THREE.ShaderMaterial({ uniforms: u, vertexShader: QUAD_VS, fragmentShader: PAINT_FS, depthTest: false, depthWrite: false });
  return { mesh: quad(material), u };
}

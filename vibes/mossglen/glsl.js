// Shared uniforms and GLSL for every material: noise, the moss state of a vertex, lighting
// (sun with shadow map, sky / ground ambient, wisp lights, velvet sheen), and height fog.
// Materials spread `shared` into their uniforms, so one write per frame updates them all.
import * as THREE from 'three';

export function makeShared() {
  return {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.5, -0.6).normalize() },
    uSunColor: { value: new THREE.Color(3, 2.6, 2) },
    uSkyAmb: { value: new THREE.Color(0.3, 0.38, 0.45) },
    uGroundAmb: { value: new THREE.Color(0.1, 0.1, 0.05) },
    uFogColor: { value: new THREE.Color(0.5, 0.56, 0.58) },
    uFogSun: { value: new THREE.Color(1, 0.85, 0.6) },
    uFogDensity: { value: 0.02 },
    uFogFall: { value: 0.25 },
    uWind: { value: 0.5 },
    uReveal: { value: 1e5 }, uRevealGlow: { value: 0 },
    uShadowMap: { value: null },
    uShadowMatrix: { value: new THREE.Matrix4() },
    uShadowOn: { value: 0 },
    // moss: uGrow drives the growth front (0 bare … 1 everything it can reach), uCover how
    // poor a habitat it will still take, uLush how deep the cushions get, uWet how wet it is
    uGrow: { value: 0.7 },
    uCover: { value: 0.75 },
    uLush: { value: 1 },
    uWet: { value: 0.4 },
    uMossTex: { value: null },
    uMossW: { value: 512 },
    uShellDist: { value: 14 },
    uPix: { value: 0.001 }, // radians per pixel
    uWisp: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, -100, 0, 0)) },
    uWispColor: { value: new THREE.Color(0.35, 0.75, 1.6) },
  };
}

export const NOISE = /* glsl */ `
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); vec3 u = f * f * (3. - 2. * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), u.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), u.x), u.y),
             mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), u.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), u.x), u.y), u.z);
}
float fbm(vec3 p) { float s = 0., a = .5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= .5; } return s / .9375; }
float fbm2(vec3 p) { return (vnoise(p) * .65 + vnoise(p * 2.1 + 9.3) * .35); }
`;

export const COMMON = /* glsl */ `
uniform float uTime;
uniform float uReveal, uRevealGlow;
float riseK(vec3 w, float s) { return 1.0 - smoothstep(uReveal - 7.0, uReveal, length(w.xz - vec2(0.0, 2.0)) * s); }
vec3 rise(vec3 w, float s) { float k = riseK(w, s); w.y = -0.9 + (w.y + 0.9) * k * k * (3.0 - 2.0 * k); return w; }
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmb;
uniform vec3 uGroundAmb;
uniform vec3 uFogColor;
uniform vec3 uFogSun;
uniform float uFogDensity;
uniform float uFogFall;
uniform float uWind;
uniform float uGrow;
uniform float uCover;
uniform float uLush;
uniform float uWet;
uniform vec4 uWisp[4];
uniform vec3 uWispColor;
${NOISE}

// Height fog along the view ray (exponential density falling off with height), in-scattering
// turns sun-coloured looking towards the sun: the glen's morning mist.
// Opaque surfaces write 1 + their distance in metres to alpha (the sky writes 0): the light
// shafts read the sky from it and the painterly filter how far away a pixel is.
float depthCode(vec3 wp) { return 1.0 + distance(wp, cameraPosition); }
vec3 applyFog(vec3 col, vec3 wp) {
  vec3 ro = cameraPosition; vec3 d = wp - ro; float t = length(d); vec3 rd = d / max(t, 1e-4);
  float b = uFogFall;
  float yb = ro.y + 1.0;
  float k = uFogDensity * exp(-b * yb);
  float fy = abs(rd.y) < 1e-3 ? t : (1.0 - exp(-b * rd.y * t)) / (b * rd.y);
  float fog = 1.0 - exp(-k * fy);
  fog = 1.0 - (1.0 - fog) * exp(-t * 0.0032);
  float s = pow(max(dot(rd, uSunDir), 0.0), 6.0);
  col = mix(col, mix(uFogColor, uFogSun, s * 0.8), clamp(fog, 0.0, 1.0));
  // the conjuring front: a green-gold glow where the land is rising
  if (uRevealGlow > 0.0) { float r = length(wp.xz - vec2(0.0, 2.0)); col += vec3(0.45, 1.0, 0.3) * uRevealGlow * exp(-pow((r - uReveal + 3.0) / 1.6, 2.0)) * 2.5; }
  return col;
}

// The small floating lights: each a soft point light with no shadows.
vec3 wispLight(vec3 wp, vec3 N) {
  vec3 s = vec3(0.0);
  for (int i = 0; i < WISP_LIGHTS; i++) {
    vec3 d = uWisp[i].xyz - wp; float r2 = dot(d, d);
    s += uWispColor * uWisp[i].w * max(dot(N, d * inversesqrt(r2 + 1e-4)) * 0.6 + 0.4, 0.0) / (1.0 + r2 * 3.0);
  }
  return s;
}

// albedo, normal, position, ambient occlusion, wrap (soft terminator for velvety surfaces),
// transmission (thin tissue lit from behind), sheen (moss velvet at grazing angles)
vec3 shade(vec3 albedo, vec3 N, vec3 wp, float ao, float sh, float wrap, float trans, float sheen) {
  vec3 L = uSunDir; vec3 V = normalize(cameraPosition - wp);
  float nl = dot(N, L);
  float diff = max((nl + wrap) / (1.0 + wrap), 0.0) * sh;
  float back = max(-nl, 0.0) * trans * (0.4 + 0.6 * sh);
  float nv = max(dot(N, V), 0.0);
  float rim = pow(1.0 - nv, 3.0) * sheen;
  float behind = pow(max(dot(-V, L), 0.0), 2.0);
  vec3 sky = mix(uGroundAmb, uSkyAmb, N.y * 0.5 + 0.5) * ao;
  vec3 col = albedo * (uSunColor * (diff + back) + sky + wispLight(wp, N));
  col += albedo * rim * (sky * 1.2 + uSunColor * behind * sh * 0.6);
  return col;
}
`;

// The conjuring of a new glen: a front sweeps out from the stone circle and everything rises
// out of a flat dark mere behind it. uReveal is the front's radius; huge means risen.
export const RISE = /* glsl */ `
uniform float uReveal;
float riseK(vec3 w, float s) { return 1.0 - smoothstep(uReveal - 7.0, uReveal, length(w.xz - vec2(0.0, 2.0)) * s); }
vec3 rise(vec3 w, float s) { float k = riseK(w, s); w.y = -0.9 + (w.y + 0.9) * k * k * (3.0 - 2.0 * k); return w; }
`;

export const SHADOW = /* glsl */ `
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform float uShadowOn;
float sunShadow(vec3 wp, float bias) {
  vec4 sc = uShadowMatrix * vec4(wp, 1.0);
  vec3 c = sc.xyz / sc.w * 0.5 + 0.5;
  if (uShadowOn < 0.5 || c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  vec2 texel = 1.0 / vec2(textureSize(uShadowMap, 0));
  float s = 0.0;
#if SHADOW_TAPS == 1
  return step(c.z - bias, texture2D(uShadowMap, c.xy).r);
#elif SHADOW_TAPS > 4
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) s += step(c.z - bias, texture2D(uShadowMap, c.xy + vec2(x, y) * texel * 1.5).r);
  return s / 9.0;
#else
  for (int i = 0; i < 4; i++) { vec2 o = vec2(float(i & 1), float(i >> 1)) - 0.5; s += step(c.z - bias, texture2D(uShadowMap, c.xy + o * texel * 1.5).r); }
  return s * 0.25;
#endif
}
`;

// The moss on a vertex: automatic growth from its habitat and arrival time on the growth
// front, plus the painted state in the moss texture (r painted amount, g scraped, b maturity).
// Returns (amount 0..1, depth 0..1).
export const MOSS = /* glsl */ `
uniform highp sampler2D uMossTex;
uniform float uMossW;
vec4 mossTexel(float vid) {
  int i = int(vid + 0.5); int w = int(uMossW);
  return texelFetch(uMossTex, ivec2(i - (i / w) * w, i / w), 0);
}
vec2 mossState(float vid, float hab, float arr) {
  vec4 t = mossTexel(vid);
  float gate = smoothstep(1.0 - uCover, 1.0 - uCover + 0.16, hab);
  float autoM = smoothstep(arr, arr + 0.06, uGrow) * gate;
  float autoD = clamp((uGrow - arr) * 3.0, 0.0, 1.0) * gate;
  float m = max(autoM, t.r) * (1.0 - t.g);
  float d = max(autoD, t.b) * (1.0 - t.g);
  return vec2(m, d * m);
}
// How far the moss lifts the surface: cushions and pillows, deeper on stones and bark.
float mossLift(vec3 wp, vec2 md, float kind) {
  float pillow = vnoise(wp * 3.1) * 0.7 + vnoise(wp * 8.7 + 4.0) * 0.3;
  return md.y * uLush * (kind < 0.5 ? 0.035 : 0.03) * (0.3 + 1.2 * pillow);
}
// Moss colour from where it grows (a slow field picks the kind), a hash per cushion (each
// cushion its own shade, which is what makes it read as moss), depth (young growth paler and
// yellower), and tip (strand tips catch light). Kinds: deep emerald feather moss, bright
// yellow-green cushions, dark old carpet, and red-bronze sphagnum in the wet.
vec3 mossColor(vec3 wp, float depth, float tip, float cush) {
  float sp = fbm2(wp * 0.42 + 3.0);
  vec3 c = mix(vec3(0.03, 0.105, 0.014), vec3(0.15, 0.25, 0.022), smoothstep(0.4, 0.7, sp));
  c = mix(c, vec3(0.02, 0.05, 0.012), smoothstep(0.58, 0.8, fbm2(wp * 1.3 + 7.0)) * 0.6);
  float bog = smoothstep(0.66, 0.8, fbm2(wp * 0.9 + 21.0)) * smoothstep(0.3, 0.0, wp.y + 0.3);
  c = mix(c, vec3(0.2, 0.075, 0.03), bog * 0.8);
  c *= 0.72 + 0.56 * cush;
  c = mix(c, c.ggb * vec3(1.3, 1.0, 0.6), (cush - 0.5) * 0.35);
  c = mix(vec3(0.22, 0.3, 0.05), c, smoothstep(0.0, 0.6, depth));
  c *= mix(0.55, 1.25, tip);
  return c * mix(1.0, 0.7, uWet);
}
// Cushions about 5 cm across on a jittered grid over 2D coordinates: (dome 0..1, hash).
vec2 cushion(vec2 p) {
  vec2 c = floor(p), f = fract(p); float best = 9.0, id = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 o = vec2(float(i), float(j)), h = hash22(c + o);
    float d = length(o + 0.15 + 0.7 * h - f) / (0.55 + 0.35 * h.x);
    if (d < best) { best = d; id = h.y; }
  }
  return vec2(clamp(1.0 - best * best, 0.0, 1.0), id);
}
`;

export const ACES = /* glsl */ `
vec3 aces(vec3 x) { const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14; return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0); }
`;

// The pond: the pebble bottom (made once), the caustics (simulated each frame), and the composite
// pass that looks through the moving surface: refraction onto the bottom, caustics, fish and
// canopy shadows, the water's colour along the path, the canopy's reflection and sun glints.
import * as THREE from 'three';
import { COMMON, RIPPLES, MAXR } from './glsl.js';

const QUAD_VS = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;
export const quad = (material) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material); m.frustumCulled = false; return m; };
const ORTHO = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

export function renderTo(renderer, rt, material) {
  const s = new THREE.Scene(); const m = quad(material); s.add(m);
  renderer.setRenderTarget(rt); renderer.render(s, ORTHO); renderer.setRenderTarget(null);
  m.geometry.dispose();
}

// ---------- caustics, simulated each frame: sunlight refracted by the actual surface (the
// wind waves and every ripple) lands on the bottom bunched or spread. For each texel of the
// bottom, find where its light crossed the surface, and take the light's density there as
// 1 / det of the Jacobian of the surface-to-bottom map (I + kD * slope Hessian). The sun's
// disc blurs it by about a centimetre at this depth, which is about one texel.
const CAUSTIC_FS = /* glsl */ `
${COMMON}
${RIPPLES}
uniform float uBreeze;
varying vec2 vUv;
void field(vec2 p, out vec2 g, out vec3 H) {
  capillary(p, g, H); g *= uBreeze; H *= uBreeze;
  const float e = 0.006;
  vec2 r0 = rippleGrad(p), rx = rippleGrad(p + vec2(e, 0.)), ry = rippleGrad(p + vec2(0., e));
  g += r0;
  H += vec3(rx.x - r0.x, ry.y - r0.y, 0.5 * (rx.y - r0.y + ry.x - r0.x)) / e;
}
void main() {
  vec2 B = uCauRect.xy + vUv * uCauRect.zw;
  // light that reaches B crossed the surface about here: along the sun, less the bend
  const float KR = 0.25; // 1 - 1/1.333: how far a slope turns the ray, per unit depth
  vec2 P = B + uSunDir.xy / uSunDir.z * uD, g; vec3 H;
  field(P, g, H); P -= KR * uD * g;
  field(P, g, H);
  mat2 J = mat2(1. + KR * uD * H.x, KR * uD * H.z, KR * uD * H.z, 1. + KR * uD * H.y);
  float I = 1. / max(abs(determinant(J)), 0.12);
  float c = 1. - exp(-0.55 * min(I, 8.));
  gl_FragColor = vec4(c, c, c, 1.);
}`;
export function makeCausticPass(shared, comp) {
  const u = { ...shared, uRip: comp.u.uRip, uRipN: comp.u.uRipN, uBreeze: comp.u.uBreeze };
  const material = new THREE.ShaderMaterial({ uniforms: u, vertexShader: QUAD_VS, fragmentShader: CAUSTIC_FS, depthTest: false, depthWrite: false });
  const scene = new THREE.Scene(); scene.add(quad(material));
  return { u, scene };
}

export function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------- the bottom: river pebbles in silt with a film of algae, rendered once for the
// world rectangle the view can see (rect = x0, y0, w, h) and kept with mipmaps.
const BOTTOM_FS = /* glsl */ `
${COMMON}
uniform vec4 uRect;
uniform float uFloor;
varying vec2 vUv;
vec3 voro(vec2 p) {
  vec2 i = floor(p), f = fract(p); float f1 = 9., f2 = 9., id = 0.;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 o = vec2(x, y), h = hash22(i + o), c = o + 0.1 + 0.8 * h;
    float d = length(c - f);
    if (d < f1) { f2 = f1; f1 = d; id = hash12(i + o + 3.7); } else if (d < f2) f2 = d;
  }
  return vec3(f1, f2, id);
}
vec2 warp(vec2 p) { return p + 0.22 * vec2(vnoise(p * 1.7), vnoise(p * 1.7 + 9.3)) ; }
// pebble height and id at p (world units)
vec2 pebble(vec2 p, float scale) {
  vec3 v = voro(warp(p * scale));
  // a rounded stone in each cell, its size bounded by the gap to the next one
  float rad = min(0.36 + 0.2 * fract(v.z * 5.1), (v.x + v.y) * 0.5 * 0.92);
  float r = v.x / rad;
  float h = sqrt(max(0., 1. - r * r));
  h = min(h, smoothstep(0.0, 0.12, v.y - v.x) * 1.2);
  return vec2(h * (0.6 + 0.4 * fract(v.z * 7.3)), v.z);
}
vec3 stoneColour(float id, vec2 p) {
  vec3 c;
  float r = fract(id * 13.17);
  if (r < 0.28) c = vec3(0.50, 0.50, 0.48);        // grey granite
  else if (r < 0.46) c = vec3(0.36, 0.38, 0.40);   // slate
  else if (r < 0.62) c = vec3(0.58, 0.50, 0.40);   // tan
  else if (r < 0.75) c = vec3(0.45, 0.36, 0.28);   // warm brown
  else if (r < 0.88) c = vec3(0.24, 0.24, 0.24);   // basalt
  else if (r < 0.95) c = vec3(0.66, 0.58, 0.52);   // pinkish
  else c = vec3(0.80, 0.78, 0.74);                 // quartz
  c *= 0.85 + 0.3 * fract(id * 91.7);
  // speckle and banding inside a stone
  c *= 0.86 + 0.28 * vnoise(p * 140. + id * 50.);
  c *= 0.93 + 0.14 * smoothstep(0.3, 0.7, vnoise(vec2(dot(p, vec2(0.8, 0.6)) * 30. + id * 9., id * 4.)));
  return s2l(c);
}
void main() {
  vec2 p = uRect.xy + vUv * uRect.zw;
  const float SC = 11.0;
  float e = 0.004;
  vec2 a = pebble(p, SC), bx = pebble(p + vec2(e, 0.), SC), by = pebble(p + vec2(0., e), SC);
  vec3 n = normalize(vec3(-(bx.x - a.x) / e * 0.025, -(by.x - a.x) / e * 0.025, 1.));
  vec3 stone = stoneColour(a.y, p);
  // silt and fine gravel between the stones
  float g = vnoise(p * 90.) * 0.6 + vnoise(p * 210.) * 0.4;
  vec3 silt = s2l(mix(vec3(0.30, 0.27, 0.21), vec3(0.42, 0.38, 0.30), g));
  float inStone = smoothstep(0.02, 0.2, a.x);
  vec3 col = mix(silt, stone, inStone);
  // baked light: stone domes lit from above, crevices occluded
  float lit = 0.62 + 0.38 * clamp(dot(n, normalize(vec3(0.3, 0.4, 0.86))), 0., 1.);
  float ao = mix(0.25, 1.0, smoothstep(0.0, 0.7, a.x));
  col *= lit * ao;
  // algae film and silt patches: greener and duller in the low spots, thin on the domes
  float alg = smoothstep(0.35, 0.75, fbm(p * 0.9 + 4.));
  float moss = smoothstep(0.45, 0.8, fbm(p * 6.0)) * (1. - a.x * 0.6);
  float silty = smoothstep(0.55, 0.85, fbm(p * 0.45 + 20.));
  if (uFloor < 0.5) {
    // clean river pebbles: a faint brown film in the low spots, no green
    col = mix(col, col * s2l(vec3(0.78, 0.72, 0.62)), 0.2 + alg * 0.25);
    col *= 0.9;
    col = mix(col, silt, silty * 0.4);
  } else if (uFloor < 1.5) {
    // a pale sky-blue pool, its plaster mottled, with a scatter of pebbles settled on it
    float mott = vnoise(p * 3.) * 0.5 + vnoise(p * 23.) * 0.3 + vnoise(p * 160.) * 0.2;
    vec3 plaster = s2l(mix(vec3(0.52, 0.72, 0.86), vec3(0.66, 0.82, 0.93), mott));
    float few = step(0.9, fract(a.y * 37.1)) * inStone;
    col = mix(plaster * (0.94 + 0.06 * lit), col, few);
  } else {
    // a dark liner: near-black slate and basalt, a little sheen on the domes
    float lum = dot(col, vec3(0.3, 0.5, 0.2));
    col = vec3(lum) * vec3(0.30, 0.31, 0.33) * (0.7 + 0.5 * a.x);
  }
  // a few fallen leaves rotting on the bottom
  vec3 lv = voro(p * 2.2 + 30.);
  float leaf = step(0.93, lv.z) * smoothstep(0.16, 0.10, lv.x);
  col = mix(col, s2l(vec3(0.30, 0.18, 0.09)), leaf * 0.8);
  gl_FragColor = vec4(enc(col), 1.);
}`;

export function makeBottom(renderer, shared, rect, longSide) {
  const w = rect.z >= rect.w ? longSide : Math.round(longSide * rect.z / rect.w);
  const h = rect.z >= rect.w ? Math.round(longSide * rect.w / rect.z) : longSide;
  const rt = new THREE.WebGLRenderTarget(w, h, { minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true, depthBuffer: false });
  const m = new THREE.ShaderMaterial({ uniforms: { ...shared, uRect: { value: rect } }, vertexShader: QUAD_VS, fragmentShader: BOTTOM_FS, depthTest: false });
  renderTo(renderer, rt, m); m.dispose();
  return rt;
}

// ---------- the composite: one full-screen pass through the surface
const COMPOSITE_FS = /* glsl */ `
${COMMON}
${RIPPLES}
uniform sampler2D uBottom, uShadow, uFish;
uniform vec4 uRect;
uniform mat4 uInvVP;
uniform vec3 uCam;
uniform mat4 uVP;
uniform vec2 uShadowTexel, uGlint;
uniform vec4 uSlosh;
uniform float uBreeze;
varying vec2 vUv;

vec2 wave(vec2 p, vec2 dir, float k, float w, float a) { return dir * (a * k * cos(k * dot(dir, p) - w * uTime)); }
vec2 ambientGrad(vec2 p) {
  // a calm pond: long low swell, and cat's paws where a breath of wind touches it
  float paw = smoothstep(0.45, 0.9, vnoise(p * 0.35 + vec2(uTime * 0.05, uTime * 0.021)));
  vec2 g = wave(p, vec2(0.80, 0.60), 6.0, 1.9, 0.0011) + wave(p, vec2(-0.45, 0.89), 8.5, 2.6, 0.0007);
  vec2 c = wave(p, vec2(0.94, 0.34), 38., 9.0, 0.00022) + wave(p, vec2(0.70, -0.71), 47., 10.5, 0.00016)
         + wave(p, vec2(0.17, 0.98), 61., 12.0, 0.00011);
  vec2 cg; vec3 cH; capillary(p, cg, cH);
  g = g * uBreeze + (c * (0.15 + 0.85 * paw) + cg * 0.3) * uBreeze;
  // slosh: standing waves across the pond from tilting or shaking the phone
  g += vec2(uSlosh.x * uSlosh.z * cos(p.x * uSlosh.z), uSlosh.y * uSlosh.w * cos(p.y * uSlosh.w));
  return g;
}
float shadowAt(vec2 uv) {
  vec2 t = uShadowTexel * 2.2;
  float s = texture(uShadow, uv).r * 0.4;
  s += (texture(uShadow, uv + vec2(t.x, t.y)).r + texture(uShadow, uv + vec2(-t.x, t.y)).r
      + texture(uShadow, uv + vec2(t.x, -t.y)).r + texture(uShadow, uv + vec2(-t.x, -t.y)).r) * 0.15;
  return clamp(s, 0., 1.);
}
void main() {
  vec4 far = uInvVP * vec4(vUv * 2. - 1., 1., 1.);
  vec3 rd = normalize(far.xyz / far.w - uCam);
  vec3 S = uCam + rd * (-uCam.z / rd.z);
  vec2 g = rippleGrad(S.xy) + ambientGrad(S.xy);
  vec3 N = normalize(vec3(-g, 1.));
  vec3 R = refract(rd, N, 1. / 1.333);
  float tb = (-uD - S.z) / R.z;
  vec3 B = S + R * tb;
  vec2 buv = (B.xy - uRect.xy) / uRect.zw;
  vec3 alb = dec(texture(uBottom, buv).rgb);
  float sh = shadowAt(buv);
  float cau = caustic(B.xy);
  vec3 col = alb * underLight(B, sh * 0.8, cau, 1.) * 0.75;
  col = waterPath(col, tb);

  // the fish, rendered straight, are looked at through the same bent ray
  // (where the bent ray reaches the fishes' depth, back on screen, against where the straight one does)
  vec3 Fr = S + R * ((-0.33 - S.z) / R.z), Fs = S + rd * ((-0.33 - S.z) / rd.z);
  vec4 pa = uVP * vec4(Fr, 1.), pb = uVP * vec4(Fs, 1.);
  vec4 f = texture(uFish, vUv + (pa.xy / pa.w - pb.xy / pb.w) * 0.5);
  vec3 fl = f.a > 0.001 ? dec(f.rgb / f.a) * f.a : vec3(0.);
  col = fl + col * (1. - f.a);

  // the surface: canopy and sky in the reflection, Fresnel-weighted, and sun glints
  float cosi = max(dot(-rd, N), 0.);
  float F = 0.02 + 0.98 * pow(1. - cosi, 5.);
  vec3 rr = reflect(rd, N);
  vec2 cq = (S.xy + rr.xy * 6.) * 0.16 + vec2(uTime * 0.002, uTime * 0.0013);
  cq += 0.03 * vec2(sin(uTime * 0.21 + cq.y * 4.), cos(uTime * 0.17 + cq.x * 4.));
  float can = smoothstep(0.38, 0.66, fbm3o(cq * 1.6));
  vec3 sky = mix(vec3(0.62, 0.74, 0.86) * 1.6, vec3(0.020, 0.032, 0.016), can * 0.92);
  col += sky * F * 1.6;
  vec3 L = normalize(uSunDir + vec3(uGlint, 0.));
  vec3 H = normalize(L - rd);
  float nh = max(dot(N, H), 0.);
  float sp = pow(nh, 1400.) * 90. + pow(nh, 160.) * 1.2;
  col += uSunCol * sp * F * dapple(S.xy);
  gl_FragColor = vec4(enc(col), 1.);
}`;

export function makeComposite(shared) {
  const rip = []; for (let i = 0; i < MAXR; i++) rip.push(new THREE.Vector4(0, 0, -100, 0));
  const u = {
    ...shared,
    uRip: { value: rip }, uRipN: { value: 0 },
    uBottom: { value: null }, uShadow: { value: null }, uFish: { value: null },
    uRect: { value: new THREE.Vector4() }, uInvVP: { value: new THREE.Matrix4() }, uCam: { value: new THREE.Vector3() },
    uVP: { value: new THREE.Matrix4() }, uShadowTexel: { value: new THREE.Vector2(1 / 512, 1 / 512) },
    uGlint: { value: new THREE.Vector2() }, uSlosh: { value: new THREE.Vector4(0, 0, 1, 1) }, uBreeze: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({ uniforms: u, vertexShader: QUAD_VS, fragmentShader: COMPOSITE_FS, depthTest: false, depthWrite: false });
  return { material, mesh: quad(material), u };
}

// ---------- the realistic finish: vignette, tone map, dither
const GRADE_FS = /* glsl */ `
uniform sampler2D uScene;
uniform vec2 uRes;
uniform float uExposure;
varying vec2 vUv;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0., 1.); }
float h12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec3 c = texture(uScene, vUv).rgb; c *= c;
  vec2 q = vUv - 0.5; q.x *= uRes.x / uRes.y;
  c *= 1. - 0.35 * smoothstep(0.25, 0.95, length(q));
  c = aces(c * uExposure);
  c = pow(c, vec3(1. / 2.2));
  c += (h12(gl_FragCoord.xy) - 0.5) / 255.;
  gl_FragColor = vec4(c, 1.);
}`;
export function makeGrade() {
  const u = { uScene: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uExposure: { value: 1.25 } };
  const material = new THREE.ShaderMaterial({ uniforms: u, vertexShader: QUAD_VS, fragmentShader: GRADE_FS, depthTest: false, depthWrite: false });
  return { mesh: quad(material), u };
}
export { QUAD_VS };

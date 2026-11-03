// Ink in water, after CCTV's "Ink" (Weareflink, 2010): the painting is only a keyframe. At the
// chosen frame rate the fish are painted and their ink is dropped into the water; every frame in
// between, the ink is carried by the water (slow curling currents, the drag of each fish, the
// vortices its tail sheds, the rings of touches), spreads and fades. So each fish trails smoke
// that billows and curls behind it while the next keyframe draws it crisp and dark again.
// The field is ink density (0 = clear), on two render targets that take turns.
import * as THREE from 'three';
import { QUAD_VS, quad } from './pond.js';
import { COMMON, RIPPLES } from './glsl.js';

export const NF = 12; // fish that stir the ink

const STEP_FS = /* glsl */ `
${COMMON}
${RIPPLES}
uniform sampler2D uPrev, uPig;
uniform vec2 uRes;
uniform mat4 uInvVP;
uniform vec3 uCam;
uniform float uDt, uStamp, uEnc, uFN, uLod;
uniform vec4 uFP[${NF}], uFT[${NF}]; // head (uv) and velocity (uv/s); tail (uv) and length, beat
varying vec2 vUv;
float lumd(vec3 d) { return dot(d, vec3(0.3, 0.45, 0.25)); }
float psi(vec2 q) {
  float t = uTime;
  return vnoise(q * 2.1 + vec2(t * 0.031, -t * 0.017)) * 0.55 + vnoise(q * 4.7 - vec2(t * 0.05, t * 0.043) + 7.) * 0.3
       + vnoise(q * 11. + vec2(t * 0.09, 3.)) * 0.15;
}
vec2 perp(vec2 v) { return vec2(-v.y, v.x); }
void main() {
  vec2 asp = vec2(uRes.x / uRes.y, 1.), q = vUv * asp;
  // slow currents: the curl of a drifting stream function, so the water neither piles up nor thins
  float e = 0.01, p0 = psi(q);
  vec2 v = vec2(psi(q + vec2(0., e)) - p0, -(psi(q + vec2(e, 0.)) - p0)) / e * 0.0022;
  // each fish drags the water along its body, and its tail sheds vortices turning left and right in turn
  for (int i = 0; i < ${NF}; i++) {
    if (float(i) >= uFN) break;
    vec4 F = uFP[i], T = uFT[i];
    vec2 d = q - F.xy * asp, r2 = vec2(T.z * T.z * 0.25, T.z * T.z * 0.09);
    vec2 fv = F.zw * asp; float sp = length(fv); vec2 dir = fv / max(sp, 1e-4), side = perp(dir);
    // the body drags a little water along, and parts it sideways at the shoulders
    float wb = exp(-dot(d, d) / r2.x);
    v += fv * 0.25 * wb + side * dot(d, side) / max(T.z, 1e-3) * sp * 0.6 * wb;
    // behind the tail: a jet thrown back against the swim, flicked left and right with each beat,
    // with the vortices it sheds turning in turn, so the trail shows how the fish pushes
    vec2 dt = q - T.xy * asp;
    float back = dot(dt, -dir), lat = dot(dt, side);
    float wj = smoothstep(-0.2 * T.z, 0.1 * T.z, back) * exp(-max(back, 0.) / (T.z * 1.4)) * exp(-lat * lat / (T.z * T.z * 0.06));
    float beat = sin(T.w - back / max(T.z, 1e-3) * 4.);
    v += (-dir * 0.7 + side * beat * 0.9) * sp * wj;
    float w = exp(-dot(dt, dt) / r2.y);
    v += perp(dt) / max(T.z, 1e-3) * w * sin(T.w) * sp * 2.5;
  }
  // a touch's rings push the ink out as they pass
  vec4 far = uInvVP * vec4(vUv * 2. - 1., 1., 1.);
  vec3 rd = normalize(far.xyz / far.w - uCam);
  vec3 S = uCam + rd * (-uCam.z / rd.z);
  v -= rippleGrad(S.xy) * 0.9;
  // carried by the water (looked up where it came from), a little spread, slowly fading
  vec2 from = vUv - v / asp * uDt, px = 2.5 / uRes;
  float d = texture(uPrev, from).r / uEnc;
  float nb = (texture(uPrev, from + vec2(px.x, 0.)).r + texture(uPrev, from - vec2(px.x, 0.)).r
            + texture(uPrev, from + vec2(0., px.y)).r + texture(uPrev, from - vec2(0., px.y)).r) / (4. * uEnc);
  d = mix(d, nb, 0.2);
  // the water's small eddies fray the edges of the ink into wisps
  float fray = vnoise(q * 38. + vec2(uTime * 0.4, -uTime * 0.3)) * 0.6 + vnoise(q * 90. - uTime * 0.7) * 0.4;
  d -= uDt * 0.5 * smoothstep(0.45, 0.8, fray) * min(d, 1.);
  // dense ink thins out quickly into wisps, and the wisps linger
  d = max(0., d * exp(-uDt * (0.6 + 9. * min(length(v), 0.25) + 1.6 * smoothstep(0.5, 2.5, d))) - uDt * 0.02);
  // a keyframe: the fresh painting drops its ink in, dark where it is dense
  if (uStamp > 0.5) {
    // softened, so what it leaves behind is a cloud and not a copy of the fish
    float s = lumd(-log(clamp(textureLod(uPig, vUv, uLod).rgb, 0.02, 1.)));
    s = pow(s * 1.7, 1.45);
    d = max(d, s * 0.45);
  }
  gl_FragColor = vec4(d * uEnc, 0., 0., 1.);
}`;

const SHOW_FS = /* glsl */ `
${COMMON}
uniform sampler2D uInkF, uPig;
uniform vec2 uRes;
uniform float uEnc, uGrain, uLod;
float paperH(vec2 p) {
  float h = vnoise(p) * 0.5 + vnoise(p * 2.3 + 7.) * 0.3 + vnoise(p * 5.3 + 3.) * 0.2;
  float fib = vnoise(vec2(p.x * 0.35 + p.y * 0.9, p.y * 0.12 - p.x * 0.4) * 3.);
  return h * 0.85 + smoothstep(0.55, 0.75, fib) * 0.15;
}
varying vec2 vUv;
void main() {
  vec2 asp = vec2(uRes.x / uRes.y, 1.), q = vUv * asp, px = 1. / uRes;
  float d = texture(uInkF, vUv).r / uEnc;
  // the edges of a wisp are where the ink is thickest against the water: darker filaments
  float gx = texture(uInkF, vUv + vec2(px.x * 1.5, 0.)).r - texture(uInkF, vUv - vec2(px.x * 1.5, 0.)).r;
  float gy = texture(uInkF, vUv + vec2(0., px.y * 1.5)).r - texture(uInkF, vUv - vec2(0., px.y * 1.5)).r;
  float edge = length(vec2(gx, gy)) / uEnc;
  // keep the smoke thin under the title so it stays readable
  float tm = smoothstep(0.88, 0.95, vUv.y) * (1. - smoothstep(0.55, 0.75, vUv.x));
  d *= 1. - 0.7 * tm; edge *= 1. - 0.7 * tm;
  d += edge * 1.6 * smoothstep(0.03, 0.5, d) * (1. - smoothstep(1.2, 2.5, d));
  // the keyframe itself, painted crisp over the ink it is shedding; dense ink reads near black
  // read soft and a little wobbly, so its edges feather like a loaded brush and not a drawn line
  vec2 wob = (vec2(vnoise(q * 140.), vnoise(q * 140. + 9.)) - 0.5) * 3.5 * px;
  vec3 W = vec3(0.3, 0.45, 0.25);
  float p = dot(-log(clamp(textureLod(uPig, vUv + wob, uLod * 0.75).rgb, 0.02, 1.)), W);
  float halo = dot(-log(clamp(textureLod(uPig, vUv, uLod + 1.2).rgb, 0.02, 1.)), W);
  p = pow(max(p, halo * 0.85) * 1.9, 1.3);
  d = max(d, p) + 0.2 * min(d, p);
  // xuan paper's soft fibre, catching a little more ink
  vec2 pq = q * uGrain * 0.45;
  float e = 0.35, h0 = paperH(pq);
  vec2 slope = vec2(paperH(pq + vec2(e, 0.)) - h0, paperH(pq + vec2(0., e)) - h0) / e;
  float tooth = h0 * 0.8 + vnoise(q * uGrain * 1.6) * 0.2;
  // ink a shade darker, and settling into the paper's hollows
  d *= 1.1 * (1. + (0.5 - tooth) * 0.5 * smoothstep(0.05, 1., d));
  // thin ink reads cool blue-grey; thick ink a warm, purplish black
  vec3 k = mix(vec3(1.10, 1.0, 0.86), vec3(1.0, 1.06, 0.98), smoothstep(0.8, 2.4, d));
  // a misty, luminous ground, brighter in the middle
  vec2 c = (vUv - 0.5) * asp;
  vec3 ground = vec3(0.955, 0.955, 0.965) * (1.02 - dot(c, c) * 0.22) * (0.985 + 0.03 * (tooth - 0.5)) * (1. + clamp(dot(slope, vec2(-0.7, 0.7)), -1., 1.) * 0.045);
  ground = mix(ground, vec3(0.80, 0.82, 0.86), smoothstep(0.35, 1.1, length(c * vec2(1.25, 0.95))) * 0.35);
  vec3 col = ground * exp(-d * k * (1. + 0.35 * smoothstep(1.2, 3., d)));
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.;
  gl_FragColor = vec4(col, 1.);
}`;

export function makeInk(renderer, comp) {
  // ink density wants a float target; on a device without one it is stored scaled into 8 bits
  const float = renderer.capabilities.isWebGL2 && (renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
  const enc = float ? 1 : 0.25;
  const fu = Array.from({ length: NF }, () => new THREE.Vector4()), tu = Array.from({ length: NF }, () => new THREE.Vector4());
  const su = { ...comp.u, uPrev: { value: null }, uPig: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uDt: { value: 0 }, uStamp: { value: 0 }, uEnc: { value: enc }, uFN: { value: 0 }, uLod: { value: 2 }, uFP: { value: fu }, uFT: { value: tu } };
  const step = new THREE.Scene(); step.add(quad(new THREE.ShaderMaterial({ uniforms: su, vertexShader: QUAD_VS, fragmentShader: STEP_FS, depthTest: false, depthWrite: false })));
  const vu = { ...comp.u, uInkF: { value: null }, uPig: { value: null }, uRes: su.uRes, uEnc: su.uEnc, uLod: su.uLod, uGrain: { value: 260 } };
  const show = new THREE.Scene(); show.add(quad(new THREE.ShaderMaterial({ uniforms: vu, vertexShader: QUAD_VS, fragmentShader: SHOW_FS, depthTest: false, depthWrite: false })));
  let A = null, B = null;
  const make = (w, h) => new THREE.WebGLRenderTarget(w, h, { type: float ? THREE.HalfFloatType : THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
  return {
    float, su, vu,
    size(w, h) {
      if (A && A.width === w && A.height === h) return;
      A?.dispose(); B?.dispose(); A = make(w, h); B = make(w, h); su.uRes.value.set(w, h); su.uLod.value = Math.max(1, Math.log2(h / 260));
      for (const t of [A, B]) { renderer.setRenderTarget(t); renderer.setClearColor(0x000000, 1); renderer.clear(); }
      renderer.setRenderTarget(null); renderer.setClearColor(0x000000, 0);
    },
    free() { A?.dispose(); B?.dispose(); A = B = null; },
    // one frame of the water carrying the ink; with `stamp`, the fresh painting in uPig drops in
    step(dt, stamp, ortho) {
      if (!A) return;
      su.uPrev.value = A.texture; su.uDt.value = dt; su.uStamp.value = stamp ? 1 : 0;
      renderer.setRenderTarget(B); renderer.render(step, ortho);
      [A, B] = [B, A];
    },
    show(ortho) { if (!A) return; vu.uInkF.value = A.texture; renderer.setRenderTarget(null); renderer.render(show, ortho); },
  };
}

// Watercolour: not a filter over the realistic frame but its own picture, after the
// references (loose koi on white cold-pressed paper). The fish, pads and floaters are drawn as
// pigment, multiplied onto white like glazes (pigRT); this pass then paints that on paper.
// Washes bleed softly in places and stay crisp in others, pigment pools at the inner edge of
// each wash, granulates in the paper's tooth and blooms; the water itself is left as paper, with
// faint cool shadows under the fish and pale ripple strokes that bend what is beneath them.
// Outlines "boil" at 8 frames a second while the paper and its splatters stay put.
import * as THREE from 'three';
import { QUAD_VS, quad } from './pond.js';
import { COMMON, RIPPLES } from './glsl.js';

const PAINT_FS = /* glsl */ `
${COMMON}
${RIPPLES}
uniform sampler2D uPig, uShadow;
uniform vec2 uRes;
uniform mat4 uInvVP;
uniform vec3 uCam;
uniform vec4 uRect;
uniform float uGrain, uPx;
varying vec2 vUv;
float lumd(vec3 d) { return dot(d, vec3(0.3, 0.45, 0.25)); }
vec3 dens(vec3 c) { return -log(clamp(c, 0.03, 1.)); }
vec3 pigAt(vec2 uv, float lod) { return textureLod(uPig, uv, lod).rgb; }
void main() {
  vec2 asp = vec2(uRes.x / uRes.y, 1.), q = vUv * asp;
  float fr = floor(uTime * 8.);
  // the surface under this pixel, and its slope from the ripples
  vec4 far = uInvVP * vec4(vUv * 2. - 1., 1., 1.);
  vec3 rd = normalize(far.xyz / far.w - uCam);
  vec3 S = uCam + rd * (-uCam.z / rd.z);
  vec2 g = rippleGrad(S.xy);
  // boil + the ripples bending what lies under them
  vec2 wob = (vec2(vnoise(q * 5. + fr * 1.7), vnoise(q * 5. + fr * 1.7 + 9.)) - 0.5) * 0.0028
           + (vec2(vnoise(q * 30. + fr * 3.1), vnoise(q * 30. + fr * 3.1 + 5.)) - 0.5) * 0.0011;
  vec2 uv = vUv + wob - g * 0.06 / asp;

  // pigment: crisp, small blur and wide blur, as densities
  float L1 = log2(max(uPx * 2.5, 1.)), L2 = L1 + 2.2, L3 = L1 + 3.9;
  vec3 d0 = dens(pigAt(uv, 0.));
  vec3 d1 = dens(pigAt(uv, L1));
  vec3 d2 = dens(pigAt(uv, L2));
  vec3 d3 = dens(pigAt(uv + (vec2(vnoise(q * 9.), vnoise(q * 9. + 3.)) - 0.5) * 0.012, L3));
  // where the paper was wet the wash feathers out; elsewhere it keeps a hard edge
  float wet = smoothstep(0.30, 0.66, fbm(q * 3.2 + 1.7));
  vec3 bl = d3 * 1.25;
  bl -= min(bl.r, min(bl.g, bl.b)) * 0.7; // colour bleeds, ink grey stays put
  vec3 d = mix(d0 * 0.15 + d1 * 0.85, max(d1 * 0.9, bl), wet * 0.9);
  // pigment pools at the inside of a wash's edge (and less where it feathered)
  vec3 pool = max(d1 - d2, 0.);
  d += pool * (1.4 - wet * 0.9);
  // the paper: cold-pressed tooth catches pigment in its hollows, granulating the darker washes
  vec2 pq = q * uGrain;
  float tooth = fbm(pq) * 0.55 + vnoise(pq * 3.1) * 0.45;
  float gran = (0.5 - tooth) * (0.3 + 0.45 * smoothstep(0.1, 1.2, lumd(d)));
  d *= 1. + gran;
  // blooms and uneven washes across the shapes
  d *= 0.82 + 0.36 * fbm(q * 6. + 4.);

  // the water left as paper: a faint cool shadow on the bottom under each fish and pad
  vec3 B = S + rd * ((-uD - S.z) / rd.z);
  vec2 buv = (B.xy - uRect.xy) / uRect.zw;
  float sh = 0.;
  for (int i = 0; i < 8; i++) { float a = float(i) * 0.785 + fr * 0.3; sh += texture(uShadow, buv + wob * 2. + vec2(cos(a), sin(a)) * 0.012 * (1. + float(i % 2))).r; }
  sh /= 8.;
  d += vec3(0.20, 0.11, 0.05) * clamp(sh, 0., 1.) * 0.4 * (0.6 + 0.8 * vnoise(q * 9.));
  // ripples as pale dry strokes where the rings are steepest
  float rg = length(g);
  d += vec3(0.16, 0.08, 0.04) * smoothstep(0.006, 0.03, rg) * (0.5 + 0.8 * vnoise(q * 40. + fr));

  // splatters on the paper, placed once: a few drops of the palette
  for (int i = 0; i < 2; i++) {
    vec2 cell = floor(q * (i == 0 ? 7. : 19.)), f = fract(q * (i == 0 ? 7. : 19.));
    float h = hash12(cell + float(i) * 17.);
    if (h > (i == 0 ? 0.95 : 0.975)) {
      vec2 c = hash22(cell + 3.) * 0.6 + 0.2;
      float r = (i == 0 ? 0.05 : 0.08) * (0.3 + hash12(cell + 9.));
      float m = smoothstep(r, r * 0.7, length(f - c) + (vnoise((f - c) * 30.) - 0.5) * r * 0.5);
      float k = fract(h * 37.);
      vec3 pc = k < 0.4 ? vec3(0.04, 0.6, 1.3) : k < 0.7 ? vec3(0.9, 0.55, 0.35) : k < 0.85 ? vec3(0.9, 0.85, 0.8) : vec3(0.08, 1.0, 1.6);
      d += pc * m * (i == 0 ? 0.9 : 0.6);
    }
  }
  vec3 paper = vec3(0.975, 0.965, 0.94) * (0.965 + 0.05 * tooth);
  vec3 col = paper * exp(-d);
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.;
  gl_FragColor = vec4(col, 1.);
}`;

export function makePaint(comp) {
  const u = { ...comp.u, uPig: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uGrain: { value: 260 }, uPx: { value: 1 } };
  const material = new THREE.ShaderMaterial({ uniforms: u, vertexShader: QUAD_VS, fragmentShader: PAINT_FS, depthTest: false, depthWrite: false });
  return { mesh: quad(material), u };
}

// multiply onto what is there: each layer of pigment is a glaze
export function glaze(m, on) {
  if (!m.userData.orig) m.userData.orig = { blending: m.blending, transparent: m.transparent, depthWrite: m.depthWrite };
  if (on) {
    Object.assign(m, { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.OneMinusSrcAlphaFactor, transparent: true });
  } else Object.assign(m, m.userData.orig);
  m.needsUpdate = true;
}

// Post: scene (HDR, alpha 0 where the sky shows) -> light shafts from the sun through gaps in
// the canopy and stones (half resolution) -> a small bloom (quarter and eighth resolution)
// -> composite: exposure, ACES, grade (lift, gain, saturation, cool shade / warm light),
// vignette, grain, sRGB out.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { ACES } from './glsl.js';

const VS = /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const rt = (w, h, o = {}) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, ...o });

export function makePost(renderer, { samples = 0, shaftTaps = 32 } = {}) {
  const quad = new FullScreenQuad();
  const T = {};
  const shafts = new THREE.ShaderMaterial({
    defines: { N: shaftTaps },
    uniforms: { tScene: { value: null }, uSun: { value: new THREE.Vector2() }, uOn: { value: 0 }, uAspect: { value: 1 } },
    vertexShader: VS,
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene; uniform vec2 uSun; uniform float uOn, uAspect; varying vec2 vUv;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        if (uOn < 0.001) { gl_FragColor = vec4(0.0); return; }
        vec2 delta = (uSun - vUv) / float(N) * 0.85;
        vec2 p = vUv + delta * hash(gl_FragCoord.xy);
        float acc = 0.0, w = 1.0, ws = 0.0;
        for (int i = 0; i < N; i++) {
          vec4 s = texture2D(tScene, p);
          vec2 d = (p - uSun) * vec2(uAspect, 1.0);
          acc += (1.0 - s.a) * max(min(dot(s.rgb, vec3(0.3, 0.5, 0.2)), 4.0) - 0.8, 0.0) * exp(-dot(d, d) * 9.0) * w;
          ws += w; w *= 0.97; p += delta;
        }
        vec2 d0 = (vUv - uSun) * vec2(uAspect, 1.0);
        gl_FragColor = vec4(vec3(acc / ws * exp(-length(d0) * 1.6) * uOn), 1.0);
      }`,
  });
  const bright = new THREE.ShaderMaterial({
    uniforms: { tIn: { value: null }, uTexel: { value: new THREE.Vector2() } }, vertexShader: VS,
    fragmentShader: /* glsl */ `
      uniform sampler2D tIn; uniform vec2 uTexel; varying vec2 vUv;
      void main() {
        vec3 c = vec3(0.0);
        for (int i = 0; i < 4; i++) { vec2 o = (vec2(float(i & 1), float(i >> 1)) - 0.5) * uTexel * 2.0; c += texture2D(tIn, vUv + o).rgb; }
        c *= 0.25; float l = dot(c, vec3(0.3, 0.5, 0.2));
        gl_FragColor = vec4(c * smoothstep(1.4, 4.0, l) / max(l, 1e-3) * min(l, 12.0), 1.0);
      }`,
  });
  const blur = new THREE.ShaderMaterial({
    uniforms: { tIn: { value: null }, uDir: { value: new THREE.Vector2() } }, vertexShader: VS,
    fragmentShader: /* glsl */ `
      uniform sampler2D tIn; uniform vec2 uDir; varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tIn, vUv).rgb * 0.227;
        c += (texture2D(tIn, vUv + uDir * 1.385).rgb + texture2D(tIn, vUv - uDir * 1.385).rgb) * 0.316;
        c += (texture2D(tIn, vUv + uDir * 3.231).rgb + texture2D(tIn, vUv - uDir * 3.231).rgb) * 0.070;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const comp = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null }, tShaft: { value: null }, tB1: { value: null }, tB2: { value: null },
      uShaftColor: { value: new THREE.Color(1, 0.9, 0.7) }, uExposure: { value: 1 }, uBloom: { value: 0.6 }, uSat: { value: 1.05 },
      uLift: { value: new THREE.Color(0.01, 0.015, 0.02) }, uGain: { value: new THREE.Color(1, 1, 1) }, uTime: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: VS,
    fragmentShader: /* glsl */ `
      ${ACES}
      uniform sampler2D tScene, tShaft, tB1, tB2; uniform vec3 uShaftColor, uLift, uGain; uniform float uExposure, uBloom, uSat, uTime; uniform vec2 uRes;
      varying vec2 vUv;
      vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      void main() {
        vec3 c = texture2D(tScene, vUv).rgb;
        c += uShaftColor * texture2D(tShaft, vUv).r;
        c += (texture2D(tB1, vUv).rgb * 0.6 + texture2D(tB2, vUv).rgb * 0.4) * uBloom;
        c = aces(c * uExposure);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = mix(vec3(l), c, uSat);
        // cool in the shade, warm in the light
        c *= mix(vec3(0.93, 0.99, 1.06), vec3(1.04, 1.0, 0.94), smoothstep(0.05, 0.6, l));
        c = uLift + c * (uGain - uLift);
        vec2 q = vUv - 0.5; c *= 1.0 - dot(q, q) * 0.55;
        c = toSRGB(clamp(c, 0.0, 1.0));
        c += (fract(sin(dot(vUv * uRes + uTime, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0 * 1.5;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const P = { comp, shafts, sun: shafts.uniforms.uSun.value };
  P.setSize = (w, h) => {
    for (const k in T) T[k].dispose();
    T.scene = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1), qw = Math.max(2, w >> 2), qh = Math.max(2, h >> 2), ew = Math.max(2, w >> 3), eh = Math.max(2, h >> 3);
    T.shaft = rt(hw, hh); T.qa = rt(qw, qh); T.qb = rt(qw, qh); T.ea = rt(ew, eh); T.eb = rt(ew, eh);
    shafts.uniforms.uAspect.value = w / h;
    comp.uniforms.uRes.value.set(w, h);
    P.w = w; P.h = h; P.sceneRT = T.scene;
  };
  const pass = (m, target) => { quad.material = m; renderer.setRenderTarget(target); quad.render(renderer); };
  P.render = (scene, camera) => {
    renderer.setRenderTarget(T.scene); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
    shafts.uniforms.tScene.value = T.scene.texture; pass(shafts, T.shaft);
    bright.uniforms.tIn.value = T.scene.texture; bright.uniforms.uTexel.value.set(1 / P.w, 1 / P.h); pass(bright, T.qa);
    blur.uniforms.tIn.value = T.qa.texture; blur.uniforms.uDir.value.set(1 / T.qa.width, 0); pass(blur, T.qb);
    blur.uniforms.tIn.value = T.qb.texture; blur.uniforms.uDir.value.set(0, 1 / T.qa.height); pass(blur, T.qa);
    bright.uniforms.tIn.value = T.qa.texture; bright.uniforms.uTexel.value.set(0, 0);
    blur.uniforms.tIn.value = T.qa.texture; blur.uniforms.uDir.value.set(2 / T.qa.width, 0); pass(blur, T.ea);
    blur.uniforms.tIn.value = T.ea.texture; blur.uniforms.uDir.value.set(0, 1 / T.ea.height); pass(blur, T.eb);
    blur.uniforms.tIn.value = T.eb.texture; blur.uniforms.uDir.value.set(1 / T.ea.width, 0); pass(blur, T.ea);
    comp.uniforms.tScene.value = T.scene.texture; comp.uniforms.tShaft.value = T.shaft.texture; comp.uniforms.tB1.value = T.qa.texture; comp.uniforms.tB2.value = T.ea.texture;
    pass(comp, null);
  };
  return P;
}

// Falling snow: points in a box that travels with the camera, stateless (each flake's
// position is a function of time), thinned by uSnowFall without retiming.
import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { mulberry32 } from './tree.js';

export function makeSnow(shared, count = 6000) {
  const rnd = mulberry32(5);
  const p = new Float32Array(count * 3), sd = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) { p.set([rnd(), rnd(), rnd()], i * 3); sd.set([rnd(), rnd()], i * 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 2));
  const uniforms = { ...shared, uSnowFall: { value: 0 }, uPR: { value: 1 } };
  const m = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: COMMON + /* glsl */ `
      uniform float uSnowFall, uPR;
      attribute vec2 aSeed;
      varying float vA;
      const vec3 BOX = vec3(60.0, 26.0, 60.0);
      void main() {
        float s = aSeed.x, on = step(aSeed.y, uSnowFall);
        float speed = mix(0.7, 1.4, s);
        vec3 q = position * BOX;
        q.y -= uTime * speed;
        q.xz += uWind * uTime * 0.6 + vec2(sin(uTime * 0.7 + s * 40.0), cos(uTime * 0.53 + s * 23.0)) * 0.5;
        // wrap into a box centred on the camera
        vec3 c = cameraPosition - vec3(BOX.x * 0.5, 6.0, BOX.z * 0.5);
        vec3 wp = c + mod(q - c, BOX);
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        float d = max(-mv.z, 0.5);
        vA = on * smoothstep(0.5, 2.0, d) * (1.0 - smoothstep(22.0, 30.0, d));
        gl_PointSize = on * uPR * mix(2.0, 3.6, s) * (14.0 / d) + 0.8 * on;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: COMMON + /* glsl */ `
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.15, d) * vA * 0.9;
        if (a < 0.01) discard;
        gl_FragColor = vec4(SNOW * (uAmbient * 1.1 + uSunColor * 0.45), a);
      }`,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return { pts, uniforms };
}

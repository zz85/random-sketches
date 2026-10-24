// Falling rain: thin streaks (each drop is a line segment, its length the distance it falls
// in a short shutter) in a box that travels with the camera. Stateless like the snow:
// a drop's position is a function of time, and uRain thins the drops without retiming.
import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { mulberry32 } from './tree.js';

export function makeRain(shared, count = 9000) {
  const rnd = mulberry32(9);
  // two vertices per drop share position and seed; aEnd = 0 head, 1 tail
  const p = new Float32Array(count * 6), sd = new Float32Array(count * 4), end = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const x = rnd(), y = rnd(), z = rnd(), a = rnd(), b = rnd();
    p.set([x, y, z, x, y, z], i * 6); sd.set([a, b, a, b], i * 4); end.set([0, 1], i * 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('aSeed', new THREE.BufferAttribute(sd, 2));
  g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
  const uniforms = { ...shared, uRain: { value: 0 } };
  const m = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: COMMON + /* glsl */ `
      uniform float uRain;
      attribute vec2 aSeed; attribute float aEnd;
      varying float vA;
      const vec3 BOX = vec3(36.0, 18.0, 36.0);
      void main() {
        float s = aSeed.x, on = step(aSeed.y, uRain);
        // falling at 8-11 m/s, slanted by the wind
        vec3 vel = vec3(uWind.x * 1.6, -mix(8.0, 11.0, s), uWind.y * 1.6);
        vec3 q = position * BOX + vel * uTime;
        vec3 c = cameraPosition - vec3(BOX.x * 0.5, 5.0, BOX.z * 0.5);
        vec3 wp = c + mod(q - c, BOX);
        wp -= vel * 0.045 * aEnd;                 // the tail: where it was 45 ms ago
        vec4 mv = viewMatrix * vec4(wp, 1.0);
        float d = max(-mv.z, 0.3);
        vA = on * smoothstep(0.4, 1.5, d) * (1.0 - smoothstep(12.0, 18.0, d)) * mix(1.0, 0.35, aEnd);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: COMMON + /* glsl */ `
      varying float vA;
      void main() {
        if (vA < 0.01) discard;
        // drops catch the sky light more than the sun
        gl_FragColor = vec4(uFogColor * 1.25 + uAmbient * 0.5 + uSunColor * 0.1, vA * 0.45);
      }`,
  });
  const lines = new THREE.LineSegments(g, m);
  lines.frustumCulled = false;
  return { lines, uniforms };
}

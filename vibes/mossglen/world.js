// The glen: terrain height field with a knoll for the stone circle, hummocky ground, a burn
// (stream) running across it, hills around. Terrain mesh, water, far hills and sky.
import * as THREE from 'three';
import { COMMON, SHADOW, RISE } from './glsl.js';

export function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function h3(x, y, z) { let h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return h - Math.floor(h); }
export function noise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z), fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  const l = (a, b, t) => a + (b - a) * t;
  return l(l(l(h3(ix, iy, iz), h3(ix + 1, iy, iz), ux), l(h3(ix, iy + 1, iz), h3(ix + 1, iy + 1, iz), ux), uy),
    l(l(h3(ix, iy, iz + 1), h3(ix + 1, iy, iz + 1), ux), l(h3(ix, iy + 1, iz + 1), h3(ix + 1, iy + 1, iz + 1), ux), uy), uz);
}
export function fbm3(x, y, z, o = 4) { let s = 0, a = 0.5, n = 0; for (let i = 0; i < o; i++) { s += a * noise3(x, y, z); n += a; x = x * 2.03 + 17.1; y = y * 2.03 + 3.7; z = z * 2.03 + 9.2; a *= 0.5; } return s / n; }
export const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ---- the shape of this glen. Seed 5 is the hand-tuned one; any other seed rolls a new glen:
// noise offsets, how high the hills and the knoll stand, how lumpy the ground is (from a
// lawn of moss to an Icelandic lava field of hummocks), and where the burn winds.
export const T = { ox: 0, oz: 0, knoll: 0.85, ring: 7, hill: 4.5, hum: 0.45, humF: 0.32, lumps: 0, sz: 7.5, sa: 3.2, sf: 0.075, sp: 0.6, sb: 1.4, sq: 2.1, drop: 0.028 };
const T0 = { ...T };
export function setTerrainSeed(seed) {
  Object.assign(T, T0);
  if (seed === 5) return T;
  const r = mulberry32(seed * 7919 + 13), L = (a, b) => a + (b - a) * r();
  Object.assign(T, { ox: L(-400, 400), oz: L(-400, 400), knoll: L(0.4, 1.5), ring: L(4, 12), hill: L(2.5, 8), hum: L(0.25, 0.75), humF: L(0.22, 0.5),
    lumps: r() < 0.4 ? L(0.25, 0.6) : 0, sz: L(6.2, 10), sa: L(1.2, 4.5), sf: L(0.05, 0.11), sp: L(0, 6.3), sb: L(0.4, 2), sq: L(0, 6.3), drop: L(0.012, 0.04) });
  return T;
}

// ---- the burn: a centreline z = zs(x) across the glen, falling gently to +x
export const streamZ = (x) => T.sz + T.sa * Math.sin(x * T.sf + T.sp) + T.sb * Math.sin(x * 0.19 + T.sq);
const streamDZ = (x) => T.sa * T.sf * Math.cos(x * T.sf + T.sp) + T.sb * 0.19 * Math.cos(x * 0.19 + T.sq);
export const waterY = (x) => -0.55 - T.drop * x + 0.06 * Math.sin(x * 0.4);
export function streamDist(x, z) { const s = streamDZ(x); return Math.abs(z - streamZ(x)) / Math.sqrt(1 + s * s); }
export const streamHalfWidth = (x) => 0.95 + 0.35 * Math.sin(x * 0.23 + 1.0) + 0.2 * Math.sin(x * 0.61);

// Height of the ground before moss (metres).
export function heightAt(x, z) {
  const r = Math.hypot(x, z);
  const nx = x + T.ox, nz = z + T.oz;
  let h = T.knoll * Math.exp(-(r * r) / 110);                    // the knoll the stones stand on
  h += smooth(16, 70, r) * T.ring + (fbm3(nx * 0.035, 0.5, nz * 0.035, 3) - 0.5) * T.hill * smooth(8, 40, r);
  h += -T.drop * x;                                              // the glen drains to +x
  h += (fbm3(nx * T.humF, 1.7, nz * T.humF, 3) - 0.5) * T.hum;   // hummocks
  if (T.lumps > 0) h += Math.pow(1 - Math.abs(noise3(nx * 0.9, 2.3, nz * 0.9) * 2 - 1), 3) * T.lumps * smooth(2.5, 7, r); // lava-field pillows
  h += (noise3(x * 1.4, 4.1, z * 1.4) - 0.5) * 0.06;
  // the burn: banks ease down to the water, the channel sits below it
  const d = streamDist(x, z), w = streamHalfWidth(x), wy = waterY(x);
  const bank = smooth(w + 4.5, w + 0.6, d);
  h = h + (Math.min(h, wy + 0.35 + 0.15 * d) - h) * bank;
  const bed = smooth(w + 0.25, w * 0.35, d);
  h = h + (wy - 0.32 - (1 - d / (w + 0.25)) * 0.08 - h) * bed;
  return h;
}
export function normalAt(x, z, out = new THREE.Vector3()) {
  const e = 0.05;
  return out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
}

// Terrain grid, denser near the clearing: x = R (a u + (1 - a) u^3).
export function terrainGeometry(N, R = 75) {
  const a = 0.24, warp = (u) => R * (a * u + (1 - a) * u * u * u);
  const pos = new Float32Array((N + 1) * (N + 1) * 3), nor = new Float32Array(pos.length), n = new THREE.Vector3();
  let k = 0;
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = warp(i / N * 2 - 1), z = warp(j / N * 2 - 1), y = heightAt(x, z);
    pos[k] = x; pos[k + 1] = y; pos[k + 2] = z; normalAt(x, z, n); nor[k] = n.x; nor[k + 1] = n.y; nor[k + 2] = n.z; k += 3;
  }
  const idx = new Uint32Array(N * N * 6); k = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const p = j * (N + 1) + i, q = p + N + 1;
    // alternate the diagonal so the hummocks don't show a grain
    if ((i + j) & 1) { idx.set([p, q, p + 1, p + 1, q, q + 1], k); } else { idx.set([p, q, q + 1, p, q + 1, p + 1], k); }
    k += 6;
  }
  return { pos, nor, idx };
}

// ---- water: a strip down the channel, opaque, coloured by depth over the bed
export function makeWater(shared, defines) {
  const pos = [], dep = [], idx = [], x0 = -78, x1 = 78, S = 260;
  for (let i = 0; i <= S; i++) {
    const x = x0 + (x1 - x0) * i / S, z = streamZ(x), w = streamHalfWidth(x) + 0.35, s = streamDZ(x), L = Math.sqrt(1 + s * s);
    for (let j = 0; j <= 4; j++) {
      const v = j / 4 * 2 - 1, px = x - (s / L) * w * v, pz = z + (1 / L) * w * v;
      const wy = waterY(px);
      pos.push(px, wy, pz); dep.push(wy - heightAt(px, pz));
    }
  }
  for (let i = 0; i < S; i++) for (let j = 0; j < 4; j++) { const p = i * 5 + j, q = p + 5; idx.push(p, q, p + 1, p + 1, q, q + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('depth', new THREE.Float32BufferAttribute(dep, 1));
  g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    defines, uniforms: { ...shared },
    vertexShader: /* glsl */ `
      attribute float depth; varying vec3 vW; varying float vD;
      ${RISE}
      void main() { vec4 w = modelMatrix * vec4(position, 1.0); w.xyz = rise(w.xyz, 1.0); vW = w.xyz; vD = depth; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      ${SHADOW}
      varying vec3 vW; varying float vD;
      vec3 skyTint(vec3 d) { return mix(uFogColor * 0.9, uSkyAmb * 2.2, smoothstep(0.0, 0.6, d.y)) + uFogSun * pow(max(dot(d, uSunDir), 0.0), 40.0) * 2.0; }
      void main() {
        float t = uTime;
        // flow runs to +x; two scrolling noise layers make the surface normal
        vec3 p = vec3(vW.x - t * 0.55, 0.0, vW.z) * 2.2;
        float e = 0.06;
        float h0 = fbm2(p + vec3(0, t * 0.3, 0)), hx = fbm2(p + vec3(e, t * 0.3, 0)), hz = fbm2(p + vec3(0, t * 0.3, e));
        vec3 N = normalize(vec3((h0 - hx) * 0.5, e, (h0 - hz) * 0.5));
        vec3 V = normalize(cameraPosition - vW);
        float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        float sh = sunShadow(vW, 0.003);
        float dep = clamp(vD, 0.0, 1.0);
        // peaty burn: amber in the shallows over the stones, near black where deep
        float stones = vnoise(vec3(vW.xz * 5.0, 1.0)) * 0.6 + vnoise(vec3(vW.xz * 13.0, 3.0)) * 0.4;
        vec3 bed = mix(vec3(0.05, 0.035, 0.02), vec3(0.16, 0.1, 0.05), stones) * (uSunColor * 0.25 * sh + uSkyAmb * 0.8);
        vec3 body = mix(bed, vec3(0.012, 0.009, 0.005), smoothstep(0.05, 0.45, dep));
        vec3 R = reflect(-V, N);
        vec3 col = mix(body, skyTint(R) * 0.8, fres);
        col += uSunColor * pow(max(dot(R, uSunDir), 0.0), 220.0) * 3.0 * sh;
        // a little foam where the water is thin
        float foam = smoothstep(0.1, 0.0, dep) * smoothstep(0.55, 0.8, vnoise(vec3(vW.x * 3.0 - t * 1.2, 0.0, vW.z * 6.0)));
        col = mix(col, (uSkyAmb + uSunColor * 0.2 * sh) * 0.9, foam * 0.5);
        gl_FragColor = vec4(applyFog(col, vW), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
  return mesh;
}

// ---- hills on the horizon: a ring of heathery slopes, mostly fog
export function makeHills(shared, defines) {
  const pos = [], idx = [], S = 200, R = [74, 120, 230, 420];
  for (let i = 0; i <= S; i++) {
    const a = i / S * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    for (let j = 0; j < R.length; j++) {
      const r = R[j], x = c * r, z = s * r;
      // one skyline per direction; the inner rings are its lower slopes
      const H = 22 + fbm3(c * 1.3 + 4 + T.ox * 0.01, s * 1.3, 0.5 + T.oz * 0.01, 5) * 95 * (0.55 + 0.45 * Math.sin(a * 2 + 1)) ** 2;
      const y = j === 0 ? heightAt(x, z) - 0.5 : H * [0, 0.22, 0.7, 1][j] + (j === 1 ? 6 : 0);
      pos.push(x, y, z);
    }
  }
  for (let i = 0; i < S; i++) for (let j = 0; j < R.length - 1; j++) { const p = i * R.length + j, q = p + R.length; idx.push(p, p + 1, q, q, p + 1, q + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.ShaderMaterial({
    defines, uniforms: { ...shared }, side: THREE.DoubleSide,
    vertexShader: `${RISE}
    varying vec3 vW; varying vec3 vN; void main() { vec4 w = modelMatrix * vec4(position, 1.0); w.xyz = rise(w.xyz, 0.3); vW = w.xyz; vN = normal; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying vec3 vW; varying vec3 vN;
      void main() {
        float n = fbm(vW * 0.04);
        vec3 alb = mix(vec3(0.07, 0.08, 0.03), vec3(0.16, 0.08, 0.12), smoothstep(0.45, 0.7, n)); // grass and heather
        alb = mix(alb, vec3(0.13, 0.1, 0.05), smoothstep(0.6, 0.8, fbm(vW * 0.1 + 3.0)) * 0.6);   // bracken
        vec3 nn = normalize(vN); if (nn.y < 0.0) nn = -nn;
        vec3 col = shade(alb, nn, vW, 1.0, 1.0, 0.3, 0.0, 0.0);
        gl_FragColor = vec4(applyFog(col, vW), 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
  return mesh;
}

// ---- sky: a soft Scottish sky, low cloud and a bright patch where the sun is.
// Alpha 0 marks sky for the light shafts.
export function makeSky(shared, defines) {
  const m = new THREE.ShaderMaterial({
    defines, uniforms: { ...shared, uCloud: { value: 0.6 } }, side: THREE.BackSide, depthWrite: false, depthTest: false,
    vertexShader: `varying vec3 vD; void main() { vD = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      uniform float uCloud;
      varying vec3 vD;
      void main() {
        vec3 d = normalize(vD);
        float el = d.y;
        vec3 col = mix(uFogColor, uSkyAmb * 2.4, smoothstep(-0.02, 0.5, el));
        float sd = max(dot(d, uSunDir), 0.0);
        col += uFogSun * (pow(sd, 8.0) * 0.6 + pow(sd, 64.0) * 1.5);
        // cloud: noise on a plane overhead
        vec2 cp = d.xz / max(el + 0.3, 0.05) * 0.6 + vec2(uTime * 0.004, uTime * 0.002);
        float c = smoothstep(0.55 - uCloud * 0.4, 0.85, fbm(vec3(cp, uTime * 0.003)));
        vec3 cloudCol = mix(uSkyAmb * 1.8, uFogColor * 1.1, 0.4) + uFogSun * pow(sd, 4.0) * 0.8;
        col = mix(col, cloudCol, c * smoothstep(0.06, 0.45, el) * 0.7);
        col += uSunColor * smoothstep(0.9993, 0.9997, sd) * (1.0 - c * 0.9) * 3.0;
        col = mix(col, uFogColor, smoothstep(0.12, -0.05, el) * 0.8);
        gl_FragColor = vec4(col, 0.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), m);
  mesh.frustumCulled = false; mesh.renderOrder = -1;
  return mesh;
}

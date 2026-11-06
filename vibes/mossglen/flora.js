// Everything that grows up out of the moss or hangs over it: ferns that unroll from
// fiddleheads as the moss reaches them (or as you paint near them), soft rush by the burn,
// the oak canopy as leaf-cluster cards, motes in the light and a few will-o'-the-wisps.
import * as THREE from 'three';
import { COMMON, SHADOW, MOSS } from './glsl.js';
import { streamDist, streamHalfWidth } from './world.js';

const I = (a, s) => new THREE.InstancedBufferAttribute(a, s);

// ---------------- ferns
function fernTemplate(F, S) {
  const pos = [], aS = [], aF = [], idx = [];
  for (let f = 0; f < F; f++) for (let s = 0; s < S; s++) for (const side of [-1, 1]) {
    const o = pos.length / 3;
    for (let u = 0; u <= 3; u++) for (const e of [-1, 1]) { pos.push(side, u / 3, e); aS.push((s + 0.5) / S); aF.push(f); }
    for (let u = 0; u < 3; u++) { const a = o + u * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); // x side, y along pinna, z edge
  g.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 1));
  g.setAttribute('aF', new THREE.Float32BufferAttribute(aF, 1));
  g.setIndex(idx);
  return g;
}

const FERN_VS = /* glsl */ `
${COMMON}
${MOSS}
uniform float uFronds;
attribute float aS, aF;
attribute vec3 iPos; attribute float iVid, iHab, iArr, iScale; attribute vec4 iSeed;
varying vec3 vW, vN; varying float vU, vS, vP, vBrown;
void main() {
  vec4 tx = mossTexel(iVid);
  float gate = smoothstep(1.0 - uCover, 1.0 - uCover + 0.16, iHab);
  float u = max(smoothstep(iArr, iArr + 0.18, uGrow) * gate, smoothstep(0.25, 0.85, tx.b)) * (1.0 - tx.g);
  if (u < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float phi = aF / uFronds * 6.2832 + iSeed.x * 6.2832 + sin(aF * 3.7) * 0.3;
  vec3 radial = vec3(cos(phi), 0.0, sin(phi)), side = vec3(-radial.z, 0.0, radial.x);
  float L = iScale * (0.75 + 0.35 * fract(aF * 0.618 + iSeed.y)) * (0.3 + 0.7 * u);
  float a0 = 1.25 - 0.25 * fract(aF * 0.37 + iSeed.z), droop = 1.3 + 0.6 * iSeed.w, coil = (1.0 - u) * 9.0;
  float gust = sin(uTime * 1.7 + iSeed.x * 20.0 + aF) * 0.06 * uWind;
  // integrate the rachis: angle falls along it (arching), and while young coils into a fiddlehead
  vec2 q = vec2(0.0); float ang = a0; const int K = 7; float ds = aS / float(K);
  for (int k = 0; k < K; k++) { float s = (float(k) + 0.5) * ds; ang = a0 - droop * s - coil * s * s + gust * s; q += vec2(cos(ang), sin(ang)) * ds * L; }
  vec3 tangent = radial * cos(ang) + vec3(0, 1, 0) * sin(ang);
  vec3 rach = iPos + radial * q.x + vec3(0, q.y, 0);
  // pinnae: longest mid-frond, swept towards the tip, drooping at their ends, rolled up while young
  float pl = L * 0.24 * pow(sin(3.1416 * pow(aS, 0.75)), 0.8) * (0.25 + 0.75 * u);
  float along = position.y;
  vec3 pd = normalize(side * position.x + tangent * 0.35);
  vec3 down = cross(pd, tangent) * sign(position.x);
  float w = pl * 0.16 * (1.0 - along * 0.85);
  vec3 p = rach + pd * along * pl + tangent * position.z * w - vec3(0, 1, 0) * along * along * pl * 0.25 * u;
  p = rise(p, 1.0);
  vW = p; vN = normalize(cross(pd, tangent) * sign(position.x) + vec3(0, 0.3, 0)); vU = u; vS = aS; vP = along;
  vBrown = step(0.93, iSeed.w);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const FERN_FS = /* glsl */ `
${COMMON}
${SHADOW}
varying vec3 vW, vN; varying float vU, vS, vP, vBrown;
void main() {
  vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
  vec3 alb = mix(vec3(0.17, 0.3, 0.04), vec3(0.05, 0.14, 0.02), smoothstep(0.2, 0.9, vU) * (0.6 + 0.4 * vS));
  alb = mix(alb, vec3(0.26, 0.12, 0.035), vBrown * 0.85);
  alb *= 0.85 + 0.3 * vP;
  float sh = sunShadow(vW, 0.003);
  vec3 col = shade(alb, N, vW, 0.75, sh, 0.3, 0.9, 0.2);
  gl_FragColor = vec4(applyFog(col, vW), depthCode(vW));
}`;

export function makeFerns(G, shared, defines, count, rnd) {
  const F = 7, S = 11, g = fernTemplate(F, S);
  const pts = G.scatter(count * 3, (i) => {
    if (G.kind[i] !== 0) return 0;
    const x = G.pos[i * 3], z = G.pos[i * 3 + 2], r = Math.hypot(x, z), sd = streamDist(x, z) - streamHalfWidth(x);
    if (sd < 0.7 || r < 7.6 || r > 34 || G.nor[i * 3 + 1] < 0.75) return 0;
    return Math.max(0, G.hab[i] - 0.35) * (sd < 4 ? 1.6 : 1);
  }, rnd, (p) => p.kind === 0);
  // keep them apart a little
  const keep = [];
  for (const q of pts) { if (keep.length >= count) break; if (keep.every((k) => (k.p[0] - q.p[0]) ** 2 + (k.p[2] - q.p[2]) ** 2 > 0.8)) keep.push(q); }
  const n = keep.length, P = new Float32Array(n * 3), V = new Float32Array(n), H = new Float32Array(n), A = new Float32Array(n), SC = new Float32Array(n), SD = new Float32Array(n * 4);
  keep.forEach((q, i) => { P.set([q.p[0], q.p[1] - 0.02, q.p[2]], i * 3); V[i] = q.vid; H[i] = q.hab; A[i] = Math.min(0.95, q.arr + 0.06 + rnd() * 0.12); SC[i] = 0.75 + rnd() * 0.7; SD.set([rnd(), rnd(), rnd(), rnd()], i * 4); });
  g.setAttribute('iPos', I(P, 3)); g.setAttribute('iVid', I(V, 1)); g.setAttribute('iHab', I(H, 1)); g.setAttribute('iArr', I(A, 1)); g.setAttribute('iScale', I(SC, 1)); g.setAttribute('iSeed', I(SD, 4));
  g.instanceCount = n;
  const m = new THREE.ShaderMaterial({ defines, uniforms: { ...shared, uFronds: { value: F } }, vertexShader: FERN_VS, fragmentShader: FERN_FS, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
  mesh.userData.castShadow = true;
  return mesh;
}

// ---------------- soft rush: stiff dark stems in clumps on the wet banks
export function makeRushes(G, shared, defines, count, rnd) {
  const STEMS = 22, pos = [], aK = [], idx = [];
  for (let k = 0; k < STEMS; k++) for (let s = 0; s <= 4; s++) for (const e of [-1, 1]) { pos.push(e, s / 4, 0); aK.push(k); }
  for (let k = 0; k < STEMS; k++) for (let s = 0; s < 4; s++) { const a = k * 10 + s * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aK', new THREE.Float32BufferAttribute(aK, 1)); g.setIndex(idx);
  const pts = G.scatter(count, (i) => {
    if (G.kind[i] !== 0) return 0;
    const x = G.pos[i * 3], z = G.pos[i * 3 + 2], sd = streamDist(x, z) - streamHalfWidth(x);
    return sd > 0.25 && sd < 3.5 && Math.hypot(x, z) < 40 ? 1 : 0;
  }, rnd, (p) => p.kind === 0);
  const n = pts.length, P = new Float32Array(n * 4);
  pts.forEach((q, i) => P.set([q.p[0], q.p[1] - 0.03, q.p[2], rnd()], i * 4));
  g.setAttribute('iPos', I(P, 4)); g.instanceCount = n;
  const m = new THREE.ShaderMaterial({
    defines, uniforms: { ...shared }, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      ${COMMON}
      uniform float uPix;
      attribute float aK; attribute vec4 iPos;
      varying vec3 vW, vN; varying float vH;
      void main() {
        float s = iPos.w * 31.0 + aK * 1.7;
        float a = fract(sin(s) * 43758.5) * 6.2832, lean = 0.12 + 0.35 * fract(sin(s * 1.3) * 9123.1);
        float L = 0.55 + 0.45 * fract(sin(s * 2.1) * 3711.3);
        vec3 dir = normalize(vec3(cos(a) * lean, 1.0, sin(a) * lean));
        float h = position.y;
        vec3 p = iPos.xyz + vec3(cos(a), 0, sin(a)) * 0.05 + dir * h * L;
        p.xz += vec2(cos(a), sin(a)) * h * h * 0.08 + vec2(sin(uTime * 1.9 + s), cos(uTime * 1.6 + s)) * h * h * 0.04 * uWind;
        vec3 toCam = normalize(cameraPosition - p), side = normalize(cross(dir, toCam));
        float w = max(0.0022, distance(p, cameraPosition) * uPix * 0.6) * (1.0 - h * 0.6);
        p += side * position.x * w;
        p = rise(p, 1.0);
        vW = p; vN = normalize(cross(side, dir)); vH = h;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      ${SHADOW}
      varying vec3 vW, vN; varying float vH;
      void main() {
        vec3 N = normalize(vN); if (!gl_FrontFacing) N = -N;
        vec3 alb = mix(vec3(0.03, 0.06, 0.015), vec3(0.09, 0.16, 0.03), vH);
        alb = mix(alb, vec3(0.2, 0.15, 0.06), smoothstep(0.85, 1.0, vH) * 0.7);
        vec3 col = shade(alb, N, vW, 0.7 + 0.3 * vH, sunShadow(vW, 0.003), 0.4, 0.5, 0.4);
        gl_FragColor = vec4(applyFog(col, vW), depthCode(vW));
      }`,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
  return mesh;
}

// ---------------- oak canopy: leaf-cluster cards (R tone, A coverage) facing the camera,
// lit with normals from the crown's centre so the canopy reads as masses
function leafAtlas(rnd) {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * S / 2, oy = Math.floor(v / 2) * S / 2, H = S / 4;
    for (let i = 0; i < 38; i++) {
      const r = Math.sqrt(rnd()) * H * 0.8, a = rnd() * Math.PI * 2;
      const x = ox + H + Math.cos(a) * r, y = oy + H + Math.sin(a) * r * 0.9;
      const tone = Math.floor(110 + 145 * (1 - r / H) * (0.55 + 0.45 * rnd()));
      g.fillStyle = `rgb(${tone},${tone},${tone})`;
      g.save(); g.translate(x, y); g.rotate(a + (rnd() - 0.5) * 1.4);
      // an oak leaf: a lobed blade
      const L = 9 + rnd() * 5, W = L * 0.42;
      g.beginPath(); g.moveTo(-L, 0);
      for (let k = 0; k <= 8; k++) { const t = k / 8, xx = -L + 2 * L * t, ww = W * Math.sin(Math.PI * t) * (k % 2 ? 1 : 0.65); g.lineTo(xx, -ww); }
      for (let k = 8; k >= 0; k--) { const t = k / 8, xx = -L + 2 * L * t, ww = W * Math.sin(Math.PI * t) * (k % 2 ? 1 : 0.65); g.lineTo(xx, ww); }
      g.fill(); g.restore();
    }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const LEAF_VS = /* glsl */ `
${COMMON}
attribute vec4 iPos; attribute vec4 iCrown;
varying vec2 vUv; varying vec3 vW, vN; varying float vTone;
void main() {
  float seed = iPos.w;
  vec3 c = iPos.xyz;
  c.xz += vec2(sin(uTime * 0.9 + seed * 7.0), cos(uTime * 0.7 + seed * 5.0)) * 0.05 * uWind * (c.y - iCrown.y + 6.0) * 0.15;
  float rk = riseK(c, 1.0); c = rise(c, 1.0);
  vec4 mv = viewMatrix * vec4(c, 1.0);
  float a = seed * 6.2832 + sin(uTime * 1.3 + seed * 11.0) * 0.08 * uWind;
  vec2 q = mat2(cos(a), sin(a), -sin(a), cos(a)) * position.xy * iCrown.w * rk;
  mv.xy += q;
  int v = int(floor(fract(seed * 7.13) * 4.0));
  vUv = (uv + vec2(float(v - (v / 2) * 2), float(v / 2))) * 0.5;
  vec3 off = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * q.x + vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) * q.y;
  vN = normalize(c - iCrown.xyz + off * 0.6);
  vW = c + off;
  vTone = fract(seed * 3.7);
  gl_Position = projectionMatrix * mv;
}`;

export function makeCanopy(trees, shared, defines, perSpot, rnd) {
  const P = [], C = [];
  for (const t of trees) {
    const cc = t.leaves.reduce((s, l) => s.add(l.p), new THREE.Vector3()).multiplyScalar(1 / t.leaves.length);
    cc.y -= 1.0;
    for (const l of t.leaves) for (let k = 0; k < perSpot; k++) {
      const d = new THREE.Vector3(rnd() - 0.5, (rnd() - 0.5) * 0.7, rnd() - 0.5).multiplyScalar(l.s * 1.7);
      P.push(l.p.x + d.x, l.p.y + d.y + 0.15, l.p.z + d.z, rnd()); C.push(cc.x, cc.y, cc.z, 1.0 + rnd() * 0.6);
    }
  }
  const g = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
  g.setAttribute('iPos', I(new Float32Array(P), 4)); g.setAttribute('iCrown', I(new Float32Array(C), 4));
  g.instanceCount = P.length / 4;
  const tex = leafAtlas(rnd);
  const FS = /* glsl */ `
    ${COMMON}
    ${SHADOW}
    uniform sampler2D uLeaf;
    varying vec2 vUv; varying vec3 vW, vN; varying float vTone;
    void main() {
      vec4 t = texture2D(uLeaf, vUv);
      if (t.a < 0.5) discard;
#ifdef DEPTH_ONLY
      gl_FragColor = vec4(1.0); return;
#endif
      vec3 N = normalize(vN);
      vec3 alb = mix(vec3(0.012, 0.03, 0.008), vec3(0.06, 0.12, 0.02), t.r) * (0.6 + 0.7 * vTone);
      alb = mix(alb, alb * vec3(1.35, 1.05, 0.55), smoothstep(0.75, 1.0, vTone)); // a few yellowing leaves
      float sh = sunShadow(vW + N * 0.2, 0.004);
      vec3 col = shade(alb, N, vW, 0.55 + 0.45 * t.r, sh, 0.5, 0.8, 0.0);
      gl_FragColor = vec4(applyFog(col, vW), depthCode(vW));
    }`;
  const u = { ...shared, uLeaf: { value: tex } };
  const m = new THREE.ShaderMaterial({ defines, uniforms: u, vertexShader: LEAF_VS, fragmentShader: FS, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
  mesh.userData.castShadow = true;
  mesh.userData.shadowMat = new THREE.ShaderMaterial({ defines: { SHADOW_TAPS: defines.SHADOW_TAPS, WISP_LIGHTS: defines.WISP_LIGHTS, DEPTH_ONLY: 1 }, uniforms: u, vertexShader: LEAF_VS, fragmentShader: FS, side: THREE.DoubleSide });
  return mesh;
}

// ---------------- motes drifting in the light, and wisps
export function makeMotes(shared, defines, count, rnd) {
  const P = new Float32Array(count * 3), S = new Float32Array(count);
  for (let i = 0; i < count; i++) { P.set([(rnd() - 0.5) * 30, rnd() * 6, (rnd() - 0.5) * 30 + 2], i * 3); S[i] = rnd(); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(S, 1));
  const m = new THREE.ShaderMaterial({
    defines, uniforms: { ...shared }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      ${COMMON}
      uniform float uPix;
      attribute float aSeed;
      varying float vA;
      void main() {
        float s = aSeed;
        vec3 p = position + vec3(sin(uTime * 0.11 + s * 40.0), sin(uTime * 0.07 + s * 13.0) * 0.5, cos(uTime * 0.09 + s * 27.0)) * 1.5;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float d = -mv.z;
        vec3 V = normalize(p - cameraPosition);
        vA = (0.4 + 3.0 * pow(max(dot(V, uSunDir), 0.0), 6.0)) * smoothstep(0.5, 3.0, d) * smoothstep(25.0, 10.0, d) * (0.5 + 0.5 * sin(uTime * 0.8 + s * 50.0));
        gl_PointSize = max(1.5, 0.012 / (d * uPix));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      varying float vA;
      void main() { float r = length(gl_PointCoord - 0.5) * 2.0; if (r > 1.0) discard; gl_FragColor = vec4(uSunColor * 0.05 * vA * (1.0 - r * r), 0.0); }`,
  });
  const pts = new THREE.Points(g, m); pts.frustumCulled = false; pts.renderOrder = 5;
  return pts;
}

export function makeWisps(shared, defines, n, rnd, heightAt) {
  const paths = Array.from({ length: n }, (_, i) => ({ a: rnd() * 6.28, r: 4 + rnd() * 9, s: 0.03 + rnd() * 0.05, h: 0.4 + rnd() * 0.8, ph: rnd() * 6.28 }));
  const P = new Float32Array(n * 4);
  const g = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
  const attr = I(P, 4); attr.setUsage(THREE.DynamicDrawUsage); g.setAttribute('iPos', attr); g.instanceCount = n;
  const m = new THREE.ShaderMaterial({
    defines, uniforms: { ...shared, uBright: { value: 1 } }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 iPos; varying vec2 vUv; varying float vA;
      void main() { vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0); mv.xy += position.xy * 0.5; vUv = uv; vA = iPos.w; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uWispColor; uniform float uBright; varying vec2 vUv; varying float vA;
      void main() { float r = length(vUv - 0.5) * 2.0; float core = exp(-r * r * 60.0) * 6.0 + exp(-r * r * 7.0) * 0.5; gl_FragColor = vec4(uWispColor * core * vA * uBright * (1.0 - smoothstep(0.85, 1.0, r)), 0.0); }`,
  });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 6;
  mesh.userData.update = (t, on) => {
    mesh.visible = on;
    for (let i = 0; i < n; i++) {
      const p = paths[i], a = p.a + t * p.s;
      const x = Math.cos(a) * p.r + Math.sin(t * 0.21 + p.ph) * 1.2, z = Math.sin(a) * p.r * 0.8 + 2 + Math.cos(t * 0.17 + p.ph) * 1.2;
      const y = heightAt(x, z) + p.h + Math.sin(t * 0.9 + p.ph) * 0.12;
      const glow = on ? 0.55 + 0.45 * Math.sin(t * 1.3 + p.ph * 3) : 0;
      P.set([x, y, z, glow], i * 4);
      if (i < 4) shared.uWisp.value[i].set(x, y, z, glow * 0.35);
    }
    attr.needsUpdate = true;
  };
  return mesh;
}

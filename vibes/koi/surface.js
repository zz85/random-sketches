// On the surface: lily pads with water lilies, leaves or petals that drift down and float
// (by season), food pellets. All of them drift on a slow current, get pushed by ripples and
// slide downhill when the phone tilts; pads and leaves cast shadows on the bottom.
import * as THREE from 'three';
import { COMMON } from './glsl.js';
import { mulberry32 } from './pond.js';

const SHADOW_PLACE = /* glsl */ `
uniform vec2 uShadowDir;
vec4 place(vec3 w) {
#ifdef SHADOW
  return projectionMatrix * viewMatrix * vec4(w.xy + uShadowDir * (w.z + uD), -uD, 1.);
#else
  return projectionMatrix * viewMatrix * vec4(w, 1.);
#endif
}`;

// ---------- lily pad: a notched disc with an upturned rim
function padGeometry() {
  const R = 7, A = 56, notch = 0.2, pos = [], uv = [], idx = [];
  for (let i = 0; i <= R; i++) for (let j = 0; j <= A; j++) {
    const r = i / R, a = notch + (j / A) * (Math.PI * 2 - 2 * notch);
    const lip = Math.pow(Math.max(0, (r - 0.86) / 0.14), 2) * 0.05;
    pos.push(Math.cos(a) * r, Math.sin(a) * r, lip - 0.012 * r * r); uv.push(r, a);
  }
  for (let i = 0; i < R; i++) for (let j = 0; j < A; j++) { const a = i * (A + 1) + j, b = a + A + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  return g;
}
const PAD_VS = /* glsl */ `
${COMMON}
${SHADOW_PLACE}
varying vec3 vW; varying vec2 vP; varying vec2 vRA;
void main() { vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vP = position.xy; vRA = uv; gl_Position = place(w.xyz); }`;
const PAD_FS = /* glsl */ `
${COMMON}
uniform float uSeed;
varying vec3 vW; varying vec2 vP; varying vec2 vRA;
void main() {
  float r = vRA.x, a = vRA.y;
  // bites and tears at the rim
  float bite = vnoise(vec2(a * 3.0, uSeed));
  if (r > 0.9 + 0.1 * smoothstep(0.78, 0.7, bite) && bite > 0.78) discard;
  float n = fbm(vP * 6. + uSeed);
  vec3 c = mix(vec3(0.17, 0.33, 0.12), vec3(0.33, 0.47, 0.17), n);
  c = mix(c, vec3(0.52, 0.50, 0.20), smoothstep(0.62, 0.8, fbm(vP * 3. + uSeed * 2.)) * 0.6);   // yellowing
  c = mix(c, vec3(0.30, 0.17, 0.10), smoothstep(0.7, 0.85, vnoise(vP * 14. + uSeed)) * 0.35);  // spots
  // radial veins from the centre, and the midrib opposite the notch
  float va = a * 7.0 / 3.14159 + 0.4 * vnoise(vec2(r * 4., a * 2.));
  float vein = smoothstep(0.08, 0.0, abs(fract(va) - 0.5) * r * 2.) * smoothstep(0.05, 0.25, r);
  float rib = smoothstep(0.035, 0.0, abs(a - 3.14159) * r) * smoothstep(0.02, 0.15, r);
  c = mix(c, c * 1.25 + 0.03, max(vein * 0.55, rib * 0.7));
  // a red-bronze lip on the upturned edge
  c = mix(c, vec3(0.42, 0.14, 0.08), smoothstep(0.88, 0.98, r) * 0.75);
  if (uPaint > 0.5) { vec3 w = mix(vec3(0.38, 0.55, 0.30), vec3(0.55, 0.66, 0.36), n); w = mix(w, vec3(0.62, 0.40, 0.28), smoothstep(0.88, 0.98, r) * 0.6); w = mix(w, w * 1.15, max(vein, rib) * 0.6); gl_FragColor = vec4(mix(vec3(1.), w, 0.5), 1.); return; }
  vec3 alb = s2l(c);
  vec3 N = normalize(vec3(-vP * 0.05 * smoothstep(0.85, 1., r) * 6. + (vec2(vnoise(vP * 9.), vnoise(vP * 9. + 4.)) - 0.5) * 0.12, 1.));
  vec3 V = normalize(cameraPosition - vW), H = normalize(uSunDir + V);
  float sun = dapple(vW.xy);
  vec3 col = alb * (uSunCol * max(dot(N, uSunDir), 0.) * sun + uAmb * 0.8) * 0.5;
  col += uSunCol * pow(max(dot(N, H), 0.), 26.) * 0.07 * sun;   // waxy sheen
  // a few beads of water
  vec2 cell = floor(vP * 7. + uSeed), f = fract(vP * 7. + uSeed) - 0.5;
  float drop = step(0.9, hash12(cell)) * smoothstep(0.12, 0.06, length(f - (hash22(cell) - 0.5) * 0.5));
  col = mix(col, col * 0.7, drop) + uSunCol * drop * smoothstep(0.05, 0.0, length(f - (hash22(cell) - 0.5) * 0.5 - vec2(0.03))) * 0.8 * sun;
  gl_FragColor = vec4(enc(col), 1.);
}`;
const HALO_FS = /* glsl */ `uniform float uPaint; varying vec2 vRA; void main() { if (uPaint > 0.5) discard; float r = vRA.x; gl_FragColor = vec4(0.0, 0.03, 0.02, 0.32 * smoothstep(1.0, 0.82, r)); }`;
const PAD_SHADOW_FS = /* glsl */ `void main() { gl_FragColor = vec4(vec3(0.9), 1.); }`;

// ---------- water lily: three rings of cupped petals round a yellow centre
function lilyGeometry(rng) {
  const pos = [], aP = [], idx = [];
  let base = 0;
  const rings = [[9, 1.0, 1.35, 0.18], [8, 0.85, 0.85, 0.5], [7, 0.62, 0.45, 0.6]];
  rings.forEach(([n, len, tilt, off], ri) => {
    for (let k = 0; k < n; k++) {
      const ang = (k + off * (ri + 1)) * (Math.PI * 2 / n) + (rng() - 0.5) * 0.2, L = len * (0.9 + rng() * 0.2), tl = tilt + (rng() - 0.5) * 0.15;
      const NU = 6, NV = 4;
      for (let iu = 0; iu <= NU; iu++) for (let iv = 0; iv <= NV; iv++) {
        const u = iu / NU, v = -1 + (2 * iv) / NV, w = 0.32 * L * Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.05)), 0.7) * (1 - 0.3 * u);
        const along = u * L, rad = along * Math.sin(tl) + 0.06, up = along * Math.cos(tl) * 0.75 + v * v * w * 0.35 + 0.02 * u;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        pos.push(ca * rad - sa * v * w, sa * rad + ca * v * w, up); aP.push(u, v, ri);
      }
      for (let iu = 0; iu < NU; iu++) for (let iv = 0; iv < NV; iv++) { const a = base + iu * (NV + 1) + iv, b = a + NV + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
      base += (NU + 1) * (NV + 1);
    }
  });
  // the centre: a dome of stamens
  const C = 14;
  pos.push(0, 0, 0.32); aP.push(0, 0, 3);
  for (let k = 0; k <= C; k++) { const a = (k / C) * Math.PI * 2; pos.push(Math.cos(a) * 0.17, Math.sin(a) * 0.17, 0.22); aP.push(1, 0, 3); }
  for (let k = 0; k < C; k++) idx.push(base, base + 1 + k, base + 2 + k);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aP', new THREE.Float32BufferAttribute(aP, 3)); g.setIndex(idx);
  return g;
}
const LILY_VS = /* glsl */ `
${COMMON}
attribute vec3 aP; varying vec3 vP, vW;
void main() { vec4 w = modelMatrix * vec4(position, 1.); vW = w.xyz; vP = aP; gl_Position = projectionMatrix * viewMatrix * w; }`;
const LILY_FS = /* glsl */ `
${COMMON}
uniform vec3 uTip, uHeart;
varying vec3 vP, vW;
void main() {
  vec3 c;
  if (vP.z > 2.5) c = mix(vec3(0.95, 0.72, 0.12), vec3(0.98, 0.86, 0.35), vP.x) * (0.8 + 0.4 * hash12(floor(vW.xy * 900.)));
  else {
    c = mix(uHeart, uTip, smoothstep(0.15, 1.0, vP.x) * (0.7 + 0.3 * (1. - vP.z / 2.)));
    c *= 0.9 + 0.1 * pow(abs(cos(vP.y * 9.)), 4.);           // fine veins
    c *= 0.82 + 0.18 * vP.x + 0.12 * vP.z;                    // inner petals in the cup's shade
  }
  if (uPaint > 0.5) { gl_FragColor = vec4(mix(vec3(1.), c, 0.85), 1.); return; }
  float sun = dapple(vW.xy);
  vec3 alb = s2l(c);
  vec3 col = alb * (uSunCol * 0.62 * sun + uAmb * 0.9) * 0.5 + alb * uSunCol * 0.05 * sun; // petals glow through
  gl_FragColor = vec4(enc(col), 1.);
}`;

// ---------- floaters: petals and leaves as instanced cards, shaped in the fragment shader
const FLOAT_VS = /* glsl */ `
${COMMON}
${SHADOW_PLACE}
attribute vec4 iPos;   // x, y, rotation, size
attribute vec4 iData;  // kind, hue, opacity, curl
varying vec2 vQ; varying vec4 vD; varying vec3 vW;
void main() {
  vec2 q = position.xy; vQ = q; vD = iData;
  float c = cos(iPos.z), s = sin(iPos.z);
  vec2 xy = iPos.xy + vec2(c * q.x - s * q.y, s * q.x + c * q.y) * iPos.w;
  vec3 w = vec3(xy, 0.003 + iData.w * dot(q, q) * iPos.w * 0.3 + iPos.w * 0.02 * float(iData.x > 2.5));
  vW = w; gl_Position = place(w);
}`;
const FLOAT_SHAPE = /* glsl */ `
// coverage of the card at q (-0.5 .. 0.5) for each kind: 0 petal, 1 maple, 2 ginkgo, 3 food
float shape(vec2 q, float kind) {
  if (kind < 0.5) { // cherry petal: an oval with a notch at the tip
    float d = length(q * vec2(1.6, 1.0)) - 0.42;
    float notch = length(q - vec2(0., 0.5)) - 0.12;
    return smoothstep(0.02, -0.02, max(d, -notch));
  } else if (kind < 1.5) { // maple: five pointed lobes on a stem
    vec2 p = q - vec2(0., -0.05);
    float a = atan(p.x, p.y), r = length(p);
    float lobes = 0.22 + 0.24 * pow(abs(cos(a * 2.5)), 0.6) * (1. - 0.35 * smoothstep(1.6, 2.6, abs(a)));
    lobes += 0.03 * abs(sin(a * 17.));
    float stem = step(abs(q.x), 0.012) * step(q.y, -0.05) * step(-0.48, q.y);
    return max(smoothstep(0.015, -0.015, r - lobes), stem);
  } else if (kind < 2.5) { // ginkgo: a fan with a cleft
    vec2 p = q - vec2(0., -0.38);
    float a = atan(p.x, p.y), r = length(p);
    float fan = step(abs(a), 1.15) * smoothstep(0.02, -0.02, r - 0.78 + 0.08 * smoothstep(0.12, 0., abs(a))) * step(0.12, r);
    float stem = step(abs(q.x), 0.012) * step(q.y, -0.25) * step(-0.5, q.y);
    return max(fan, stem);
  }
  return smoothstep(0.5, 0.38, length(q));
}`;
const FLOAT_FS = /* glsl */ `
${COMMON}
${FLOAT_SHAPE}
varying vec2 vQ; varying vec4 vD; varying vec3 vW;
void main() {
  float k = vD.x, m = shape(vQ, k);
  if (m < 0.5) discard;
  vec3 c;
  if (k < 0.5) c = mix(vec3(0.99, 0.86, 0.89), vec3(0.95, 0.66, 0.74), vD.y) * (0.92 + 0.08 * smoothstep(0.4, 0.0, length(vQ)));
  else if (k < 1.5) c = mix(vec3(0.80, 0.14, 0.06), vec3(0.93, 0.47, 0.10), vD.y);
  else if (k < 2.5) c = mix(vec3(0.95, 0.78, 0.18), vec3(0.82, 0.62, 0.12), vD.y);
  else c = vec3(0.42, 0.25, 0.12) * (0.75 + 0.5 * smoothstep(0.3, 0.0, length(vQ - vec2(-0.12, 0.12))));
  if (k > 0.5 && k < 2.5) c *= 0.85 + 0.25 * vnoise(vQ * 14. + vD.y * 20.) - 0.25 * smoothstep(0.03, 0.0, abs(vQ.x)) * step(-0.2, vQ.y);
  if (uPaint > 0.5) { gl_FragColor = vec4(mix(vec3(1.), c, 0.55), 1.); return; }
  vec3 alb = s2l(c);
  float sun = dapple(vW.xy);
  vec3 col = alb * (uSunCol * uSunDir.z * sun + uAmb * 0.85) * 0.5;
  if (k > 2.5) col += uSunCol * sun * 0.25 * smoothstep(0.12, 0.0, length(vQ - vec2(-0.14, 0.14)));
  gl_FragColor = vec4(enc(col), 1.);
}`;
const FLOAT_SHADOW_FS = /* glsl */ `${FLOAT_SHAPE}
varying vec2 vQ; varying vec4 vD;
void main() { float m = shape(vQ, vD.x); if (m < 0.5) discard; gl_FragColor = vec4(vec3(0.7 * vD.z), 1.); }`;

export const SEASON_KINDS = { spring: [0, 0, 0, 0, 1], summer: [1], autumn: [1, 1, 2, 1, 2], winter: [1, 2] };
export function seasonNow(d = new Date()) { const m = d.getMonth(); return m >= 2 && m <= 4 ? 'spring' : m <= 7 ? 'summer' : m <= 10 ? 'autumn' : 'winter'; }

const MAXF = 64;
export class Surface {
  constructor(shared, { season = seasonNow(), seed = 1 } = {}) {
    this.shared = shared; this.season = season; this.rng = mulberry32(seed * 7919 + 3);
    this.scene = new THREE.Group(); this.shadow = new THREE.Group();
    this.pads = []; this.floaters = []; this.pellets = [];
    this.nextFall = 4;
    // floaters
    const g = new THREE.InstancedBufferGeometry();
    const plane = new THREE.PlaneGeometry(1, 1);
    g.index = plane.index; g.setAttribute('position', plane.getAttribute('position'));
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAXF * 4), 4); this.iData = new THREE.InstancedBufferAttribute(new Float32Array(MAXF * 4), 4);
    this.iPos.setUsage(THREE.DynamicDrawUsage); this.iData.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.iPos); g.setAttribute('iData', this.iData); g.instanceCount = 0;
    this.floatGeo = g;
    const fm = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: shared, vertexShader: FLOAT_VS, fragmentShader: FLOAT_FS, side: THREE.DoubleSide }));
    const fs = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: shared, vertexShader: FLOAT_VS, fragmentShader: FLOAT_SHADOW_FS, defines: { SHADOW: 1 }, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide }));
    fm.frustumCulled = fs.frustumCulled = false; fm.renderOrder = 5;
    this.scene.add(fm); this.shadow.add(fs);
    this.padGeo = padGeometry();
  }

  // pads in two or three clusters near the edges of the view (hx, hy: half extents)
  layout(hx, hy, k = 1) {
    for (const p of this.pads) { this.scene.remove(p.mesh, p.halo, p.lily); this.shadow.remove(p.shadow); }
    this.pads = [];
    const rng = mulberry32(911), clusters = [[-0.78, 0.7, 4], [0.82, -0.55, 3], [0.55, 0.92, 2]];
    for (const [cx, cy, n] of clusters) for (let i = 0; i < n; i++) {
      const r = (0.15 + rng() * 0.15) * (0.4 + 0.6 * k), ang = rng() * Math.PI * 2, dist = i === 0 ? 0 : (0.25 + rng() * 0.25) * (0.4 + 0.6 * k);
      const ax = cx * hx + Math.cos(ang) * dist, ay = cy * hy + Math.sin(ang) * dist;
      const seed = rng() * 100;
      const mat = new THREE.ShaderMaterial({ uniforms: { ...this.shared, uSeed: { value: seed } }, vertexShader: PAD_VS, fragmentShader: PAD_FS });
      const mesh = new THREE.Mesh(this.padGeo, mat); mesh.renderOrder = 2;
      const halo = new THREE.Mesh(this.padGeo, new THREE.ShaderMaterial({ uniforms: this.shared, vertexShader: PAD_VS, fragmentShader: HALO_FS, transparent: true, depthWrite: false, depthTest: false }));
      halo.renderOrder = 1;
      const shadow = new THREE.Mesh(this.padGeo, new THREE.ShaderMaterial({ uniforms: this.shared, vertexShader: PAD_VS, fragmentShader: PAD_SHADOW_FS, defines: { SHADOW: 1 }, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true }));
      let lily = null;
      if (i === 0 || rng() < 0.3) {
        const tip = rng() < 0.5 ? [0.96, 0.62, 0.74] : [0.98, 0.95, 0.93];
        lily = new THREE.Mesh(lilyGeometry(rng), new THREE.ShaderMaterial({ uniforms: { ...this.shared, uTip: { value: new THREE.Vector3(...tip) }, uHeart: { value: new THREE.Vector3(1, 0.97, 0.9) } }, vertexShader: LILY_VS, fragmentShader: LILY_FS, side: THREE.DoubleSide }));
        lily.renderOrder = 3; lily.userData = { dx: (rng() - 0.5) * r * 0.6, dy: (rng() - 0.5) * r * 0.6, size: 0.085 + rng() * 0.04 };
      }
      for (const m of [mesh, halo, shadow, lily]) if (m) m.frustumCulled = false;
      this.scene.add(halo, mesh); if (lily) this.scene.add(lily); this.shadow.add(shadow);
      this.pads.push({ ax, ay, x: ax, y: ay, vx: 0, vy: 0, r, rot: rng() * 6.28, vr: 0, mesh, halo, shadow, lily });
    }
  }

  dropPellets(x, y, n, rippleFn) {
    for (let i = 0; i < n; i++) {
      if (this.pellets.length >= 48) this.pellets.shift();
      const a = Math.random() * 6.28, d = Math.random() * 0.06;
      this.pellets.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: 0, vy: 0, alive: true, age: 0, rot: Math.random() * 6 });
    }
    rippleFn(x, y, 0.5);
  }

  // env: { dt, t, hx, hy, tilt: [gx, gy], ripples (array), ripple(x,y,a) }
  update(env) {
    const { dt, t, hx, hy } = env, [gx, gy] = env.tilt;
    const current = (x, y) => [0.010 * Math.sin(y * 0.6 + t * 0.03) + 0.004 * Math.sin(x * 1.3 - t * 0.05), 0.008 * Math.cos(x * 0.5 - t * 0.025) + 0.004 * Math.cos(y * 1.1 + t * 0.04)];
    const push = (o, k) => {
      for (const r of env.ripples) {
        const age = t - r.t0; if (age < 0 || age > 3) continue;
        const ex = o.x - r.x, ey = o.y - r.y, d = Math.hypot(ex, ey) + 1e-4, front = age * 0.32;
        const w = Math.exp(-((d - front) ** 2) / 0.01) * r.a * Math.exp(-age) * k / (1 + d * 3);
        o.vx += (ex / d) * w * dt; o.vy += (ey / d) * w * dt;
      }
    };
    // pads: tethered by their stems, nudged by everything else
    for (const p of this.pads) {
      const [cx, cy] = current(p.x, p.y);
      p.vx += ((p.ax - p.x) * 0.06 + cx * 0.3 + gx * 0.03 - p.vx * 0.5) * dt;
      p.vy += ((p.ay - p.y) * 0.06 + cy * 0.3 + gy * 0.03 - p.vy * 0.5) * dt;
      push(p, 0.15 / p.r);
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vr += (Math.sin(t * 0.05 + p.ax * 3) * 0.004 - p.vr * 0.4) * dt; p.rot += p.vr * dt;
      for (const m of [p.mesh, p.halo, p.shadow]) { m.position.set(p.x, p.y, m === p.halo ? 0.0005 : 0.004); m.rotation.z = p.rot; m.scale.setScalar(m === p.halo ? p.r * 1.12 : p.r); }
      if (p.lily) { const l = p.lily, c = Math.cos(p.rot), s = Math.sin(p.rot); l.position.set(p.x + c * l.userData.dx - s * l.userData.dy, p.y + s * l.userData.dx + c * l.userData.dy, 0.006); l.scale.setScalar(l.userData.size); l.rotation.z = p.rot * 0.7; }
    }
    // keep pads from overlapping one another
    for (let i = 0; i < this.pads.length; i++) for (let j = i + 1; j < this.pads.length; j++) {
      const a = this.pads[i], b = this.pads[j], ex = b.x - a.x, ey = b.y - a.y, d = Math.hypot(ex, ey) + 1e-6, m = (a.r + b.r) * 0.92 - d;
      if (m > 0) { const k = m * 0.5 / d; a.x -= ex * k; a.y -= ey * k; b.x += ex * k; b.y += ey * k; }
    }
    // leaves and petals falling, landing, drifting
    this.nextFall -= dt;
    const kinds = SEASON_KINDS[this.season] || [];
    if (kinds.length && this.nextFall <= 0 && this.floaters.length < 40) {
      const rate = this.season === 'spring' ? 3 : this.season === 'autumn' ? 7 : 22;
      this.nextFall = rate * (0.4 + Math.random() * 1.2);
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      const x = (Math.random() * 2 - 1) * hx * 0.9, y = (Math.random() * 2 - 1) * hy * 0.9;
      this.floaters.push({ x, y, vx: 0, vy: 0, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.1, kind, hue: Math.random(), size: kind === 0 ? 0.024 + Math.random() * 0.01 : 0.085 + Math.random() * 0.04, curl: Math.random(), age: 0, land: 1 });
      env.ripple(x, y, kind === 0 ? 0.25 : 0.45);
    }
    const all = [...this.floaters, ...this.pellets];
    for (const f of all) {
      const [cx, cy] = current(f.x, f.y);
      const drag = f.kind === undefined ? 1.2 : 0.8;
      f.vx += (cx + gx * 0.05 - f.vx) * drag * dt; f.vy += (cy + gy * 0.05 - f.vy) * drag * dt;
      push(f, 0.5);
      f.x += f.vx * dt; f.y += f.vy * dt; f.rot += (f.vr || 0) * dt + (f.vx * f.vy) * 0.0; f.age += dt;
      f.land = Math.max(0, (f.land || 0) - dt * 2.5);
      // nothing floats through a pad
      for (const p of this.pads) { const ex = f.x - p.x, ey = f.y - p.y, d = Math.hypot(ex, ey) + 1e-6; if (d < p.r) { f.x = p.x + (ex / d) * p.r; f.y = p.y + (ey / d) * p.r; } }
    }
    this.floaters = this.floaters.filter((f) => f.age < 420 && Math.abs(f.x) < hx + 0.6 && Math.abs(f.y) < hy + 0.6);
    this.pellets = this.pellets.filter((p) => p.alive && p.age < 60);
    let n = 0;
    const P = this.iPos.array, D = this.iData.array;
    for (const f of this.floaters) { if (n >= MAXF) break; P.set([f.x, f.y, f.rot, f.size * (1 + f.land * 0.6)], n * 4); D.set([f.kind, f.hue, 1, f.curl], n * 4); n++; }
    for (const p of this.pellets) { if (n >= MAXF) break; P.set([p.x, p.y, p.rot, 0.016 * Math.min(1, p.age * 4 + 0.3)], n * 4); D.set([3, 0, 0.3, 0], n * 4); n++; }
    this.floatGeo.instanceCount = n; this.iPos.needsUpdate = true; this.iData.needsUpdate = true;
  }
}

// The moss itself, in three layers that all read the same per-vertex state:
//  1. the surface material of ground, stones and bark: bare soil / stone / bark under a
//     velvet of moss whose cover, colour and cushion relief follow its amount and depth,
//     with the cushions lifting the surface as real geometry;
//  2. fur shells: the same mesh drawn again a few times, each layer pushed out along the
//     normal and cut into strands, only where there is moss and only near the camera;
//  3. sporophytes: thin red setae with capsules that rise out of mature moss and glow
//     when the sun is behind them.
import * as THREE from 'three';
import { COMMON, SHADOW, MOSS } from './glsl.js';

const SURF_VS = /* glsl */ `
${COMMON}
${MOSS}
attribute float vid, hab, arr, ao, kind;
varying vec3 vW, vN;
varying float vM, vD, vAo, vKind, vHab;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec2 md = mossState(vid, hab, arr);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  w.xyz += n * mossLift(w.xyz, md, kind);
  w.xyz = rise(w.xyz, 1.0);
  vW = w.xyz; vN = n; vM = md.x; vD = md.y; vAo = ao; vKind = kind; vHab = hab;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SURF_FS = /* glsl */ `
${COMMON}
${SHADOW}
${MOSS}
varying vec3 vW, vN;
varying float vM, vD, vAo, vKind, vHab;
vec2 cushionAt(vec3 wp, vec3 n) {
  vec3 a = abs(n); vec2 p = (a.y > 0.7 ? wp.xz : (a.x > a.z ? wp.zy : wp.xy)) * 18.0;
  vec2 c = cushion(p);
  // cushions smaller than a few pixels melt into an even velvet instead of a scale pattern
  float k = 1.0 - smoothstep(0.08, 0.3, length(fwidth(p)));
  return vec2(mix(0.55, c.x, k), mix(0.5, c.y, k * 0.8 + 0.2));
}
vec3 bump(vec3 n, float h) {
  vec3 dpx = dFdx(vW), dpy = dFdy(vW);
  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx); float det = dot(dpx, r1);
  vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - g);
}
void main() {
  vec3 n = normalize(vN);
  vec3 wp = vW;
  float g1 = vnoise(wp * 2.3), g2 = vnoise(wp * 9.0 + 3.0), g3 = vnoise(wp * 31.0 + 7.0);
  vec3 alb; float relief;
  if (vKind < 0.5) {
    // peaty soil under oak litter, a few pebbles
    alb = mix(vec3(0.05, 0.035, 0.02), vec3(0.15, 0.08, 0.035), smoothstep(0.4, 0.75, fbm2(wp * 1.6 + 2.0)));
    alb = mix(alb, vec3(0.13, 0.12, 0.1), smoothstep(0.78, 0.86, g2) * 0.7);
    relief = g2 * 0.012 + g3 * 0.004;
  } else if (vKind < 1.5) {
    // grey schist: grain, darker veins, pale crustose lichen
    alb = mix(vec3(0.11, 0.11, 0.1), vec3(0.24, 0.235, 0.215), g1 * 0.6 + g2 * 0.4);
    alb *= 0.8 + g3 * 0.35;
    float lichen = smoothstep(0.62, 0.7, fbm2(wp * 3.3 + 11.0)) * smoothstep(0.25, 0.4, g3);
    alb = mix(alb, vec3(0.33, 0.36, 0.28), lichen * 0.8);
    relief = g1 * 0.02 + g2 * 0.008 + g3 * 0.002;
  } else {
    // oak bark: furrows running along the stems
    float furrow = vnoise(wp * vec3(9.0, 1.3, 9.0));
    alb = mix(vec3(0.035, 0.03, 0.025), vec3(0.11, 0.1, 0.085), furrow) * (0.85 + g2 * 0.3);
    relief = furrow * 0.02 + g3 * 0.003;
  }
  // moss cover: a ragged front at the edge of a colony, solid once it has spread
  float edge = fbm2(wp * 7.0) * 0.7 + g3 * 0.3;
  float cov = smoothstep(0.0, 0.18, vM - (edge - 0.5) * 0.9 * (1.0 - vM) - 0.08) * smoothstep(0.0, 0.06, vM);
  float tufts = vnoise(wp * 55.0) * 0.6 + vnoise(wp * 140.0) * 0.4;
  vec2 cu = cushionAt(wp, n);
  vec3 mc = mossColor(wp, vD, mix(0.25, 0.8, cu.x) * (0.7 + 0.3 * tufts), cu.y);
  // far off, the moss is painted in dabs: big patches of chartreuse, olive, ochre and deep
  // green with broken edges, which the painterly filter in post then flattens
  float far = smoothstep(5.0, 20.0, distance(wp, cameraPosition));
  if (far > 0.001) {
    vec3 q = wp * 0.75 + vec3(vnoise(wp * 0.6), vnoise(wp * 0.6 + 5.0), vnoise(wp * 0.6 + 9.0)) * 1.4;
    float id = fract(sin(dot(floor(q), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
    vec3 pal = id < 0.3 ? vec3(0.17, 0.3, 0.025) : id < 0.6 ? vec3(0.07, 0.15, 0.02) : id < 0.82 ? vec3(0.2, 0.21, 0.035) : vec3(0.035, 0.085, 0.018);
    pal *= 0.8 + 0.4 * mossColor(wp, vD, 0.5, 0.5).g / 0.15;
    mc = mix(mc, mix(mc, pal, 0.6), far);
  }
  float mh = (sqrt(cu.x) * 0.7 + tufts * 0.3) * 0.008 * (0.4 + vD);
  vec3 N = bump(n, mix(relief, mh, cov));
  float wet = uWet * (1.0 - cov);
  alb = mix(alb * mix(1.0, 0.55, wet), mc, cov);
  float sh = sunShadow(wp + n * 0.03, 0.0015);
  float ao = vAo * mix(1.0, 0.45 + 0.55 * sqrt(cu.x), cov);
  vec3 col = shade(alb, N, wp, ao, sh, mix(0.1, 0.4, cov), cov * 0.3, cov * (0.45 + vD * 0.35));
  // wet stone and soil catch a little sun
  vec3 V = normalize(cameraPosition - wp);
  col += uSunColor * sh * pow(max(dot(reflect(-uSunDir, N), V), 0.0), 40.0) * wet * 0.25;
  gl_FragColor = vec4(applyFog(col, wp), depthCode(wp));
}`;

export function makeSurfaceMaterial(shared, defines) {
  return new THREE.ShaderMaterial({ defines, uniforms: { ...shared }, vertexShader: SURF_VS, fragmentShader: SURF_FS });
}

// ---- fur shells
const SHELL_VS = /* glsl */ `
${COMMON}
${MOSS}
uniform float uShells, uShellDist;
attribute float vid, hab, arr, ao, kind;
varying vec3 vW, vN;
varying float vM, vD, vT, vAo;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec2 md = mossState(vid, hab, arr);
  float dist = distance(w.xyz, cameraPosition);
  // fewer layers with distance; a layer is dropped by moving it off screen (its triangles clip)
  float layers = uShells * clamp((uShellDist - dist) / (uShellDist * 0.35), 0.0, 1.0);
  float i = float(gl_InstanceID);
  if (md.x < 0.06 || i >= layers - 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 n = normalize(mat3(modelMatrix) * normal);
  float t = (i + 1.0) / uShells;
  float fur = (0.004 + 0.009 * md.y) * uLush * smoothstep(0.06, 0.5, md.x) * (kind > 0.5 ? 0.75 : 1.0);
  // strands lean a little downhill and sway together
  vec3 sway = vec3(sin(uTime * 1.3 + w.x * 0.8), 0.0, cos(uTime * 1.1 + w.z * 0.7)) * 0.25 * uWind;
  w.xyz += n * (mossLift(w.xyz, md, kind) + t * fur) + sway * fur * t * t;
  w.xyz = rise(w.xyz, 1.0);
  vW = w.xyz; vN = n; vM = md.x; vD = md.y; vT = t; vAo = ao;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const SHELL_FS = /* glsl */ `
${COMMON}
${SHADOW}
${MOSS}
varying vec3 vW, vN;
varying float vM, vD, vT, vAo;
float strand(vec2 p, float t, out float id) {
  vec2 c = floor(p), f = fract(p);
  vec2 h = hash22(c); id = h.x;
  float r = 0.5 * (1.0 - t * 0.6) * (0.6 + 0.4 * h.y);
  return length(f - (0.25 + 0.5 * h.yx)) < r ? 0.75 + 0.25 * h.x : 0.0;
}
void main() {
  vec3 n = normalize(vN), a = abs(n);
  vec2 p = a.y > 0.7 ? vW.xz : (a.x > a.z ? vW.zy : vW.xy);
  // each cushion a dome; the layer is cut away above it, so cushions part with dark seams
  vec2 cu = cushion(p * 18.0);
  float dome = sqrt(cu.x) * mix(0.75, 1.0, vM);
  if (vT > dome) discard;
  float id, len = strand(p * 230.0, vT / max(dome, 0.05), id);
  if (len <= 0.0) len = strand(p * 230.0 + 0.5, vT / max(dome, 0.05), id);
  if (len <= 0.0 || vT > dome * len) discard;
  vec3 col = mossColor(vW, vD, 0.3 + 0.7 * vT / dome + (id - 0.5) * 0.25, cu.y);
  float sh = sunShadow(vW + n * 0.03, 0.0015);
  col = shade(col, n, vW, vAo * (0.3 + 0.7 * vT), sh, 0.45, 0.45, 0.3 + vT * 0.6);
  gl_FragColor = vec4(applyFog(col, vW), depthCode(vW));
}`;

export function makeShells(geometry, shared, defines, layers) {
  const g = new THREE.InstancedBufferGeometry();
  for (const k of Object.keys(geometry.attributes)) g.setAttribute(k, geometry.attributes[k]);
  g.setIndex(geometry.index); g.instanceCount = layers;
  g.boundingSphere = geometry.boundingSphere;
  const m = new THREE.ShaderMaterial({ defines, uniforms: { ...shared, uShells: { value: layers } }, vertexShader: SHELL_VS, fragmentShader: SHELL_FS });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
  return mesh;
}

// ---- sporophytes: a seta (3-sided stalk) with a nodding capsule
function sporophyteGeometry() {
  const pos = [], h = [], part = [], nor = [], idx = [];
  const R = 4;
  for (let r = 0; r <= R; r++) for (let s = 0; s < 3; s++) {
    const a = s / 3 * Math.PI * 2; pos.push(Math.cos(a), 0, Math.sin(a)); nor.push(Math.cos(a), 0, Math.sin(a)); h.push(r / R); part.push(0);
  }
  for (let r = 0; r < R; r++) for (let s = 0; s < 3; s++) { const a = r * 3 + s, b = r * 3 + (s + 1) % 3; idx.push(a, a + 3, b, b, a + 3, b + 3); }
  // capsule: a bipyramid with a 5-sided waist
  const o = pos.length / 3;
  pos.push(0, -1, 0); nor.push(0, -1, 0); h.push(0); part.push(1);
  for (let s = 0; s < 5; s++) { const a = s / 5 * Math.PI * 2; pos.push(Math.cos(a), 0, Math.sin(a)); nor.push(Math.cos(a), 0, Math.sin(a)); h.push(0.5); part.push(1); }
  pos.push(0, 1, 0); nor.push(0, 1, 0); h.push(1); part.push(1);
  for (let s = 0; s < 5; s++) { const a = o + 1 + s, b = o + 1 + (s + 1) % 5; idx.push(o, b, a, a, b, o + 6); }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('ah', new THREE.Float32BufferAttribute(h, 1));
  g.setAttribute('apart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

const SPORO_VS = /* glsl */ `
${COMMON}
${MOSS}
uniform float uPix;
attribute float ah, apart;
attribute vec3 iPos, iNor; attribute float iVid, iHab, iArr, iKind; attribute vec4 iSeed;
varying vec3 vW, vN; varying float vPart, vH, vAge;
void main() {
  vec2 md = mossState(iVid, iHab, iArr);
  vec4 tx = mossTexel(iVid);
  float up = max(smoothstep(iArr + 0.14, iArr + 0.3, uGrow) * smoothstep(1.0 - uCover, 1.0 - uCover + 0.16, iHab), smoothstep(0.55, 0.9, tx.b)) * (1.0 - tx.g);
  up *= smoothstep(0.4, 0.8, md.x) * smoothstep(13.0, 5.0, distance(iPos, cameraPosition));
  if (up < 0.02) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // never thinner than about half a pixel, so distant setae don't sparkle
  float px = distance(iPos, cameraPosition) * uPix;
  vec3 n = normalize(mix(iNor, vec3(0, 1, 0), 0.6));
  vec3 t = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0))), b = cross(n, t);
  float L = (0.02 + 0.03 * iSeed.x) * uLush * up;
  float sway = sin(uTime * (1.5 + iSeed.y) + iSeed.z * 6.28) * 0.12 * uWind;
  vec3 lean = (t * (iSeed.z - 0.5) + b * (iSeed.w - 0.5)) * 0.5 + t * sway;
  vec3 base = iPos + iNor * mossLift(iPos, md, iKind);
  vec3 p, nn;
  if (apart < 0.5) {
    float h = ah;
    vec3 axis = n + lean * h;
    p = base + axis * L * h + (t * position.x + b * position.z) * max(0.0005, px * 0.35);
    nn = t * position.x + b * position.z;
  } else {
    // nodding capsule: hangs off the top of the seta
    vec3 top = base + (n + lean) * L;
    vec3 ax = normalize(mix(n + lean, t * (iSeed.z - 0.5) * 2.0 - n * 0.3, 0.55 * smoothstep(0.4, 1.0, up)));
    float cr = max(0.0016, px * 0.7) * (0.6 + 0.4 * up), cl = max(0.0032, px * 1.2) * (0.6 + 0.4 * up);
    vec3 s = cross(ax, t); s = length(s) < 1e-3 ? b : normalize(s); vec3 q = cross(ax, s);
    p = top + ax * (position.y + 1.0) * cl + (s * position.x + q * position.z) * cr;
    nn = ax * position.y + s * position.x + q * position.z;
  }
  p = rise(p, 1.0);
  vW = p; vN = normalize(nn); vPart = apart; vH = ah; vAge = up;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;

const SPORO_FS = /* glsl */ `
${COMMON}
${SHADOW}
varying vec3 vW, vN; varying float vPart, vH, vAge;
void main() {
  vec3 seta = mix(vec3(0.08, 0.025, 0.01), vec3(0.28, 0.1, 0.03), vH);
  vec3 caps = mix(vec3(0.25, 0.32, 0.05), vec3(0.45, 0.2, 0.04), vAge);
  vec3 alb = vPart < 0.5 ? seta : caps;
  float sh = sunShadow(vW, 0.002);
  vec3 col = shade(alb, normalize(vN), vW, 0.9, sh, 0.5, 1.6, 0.3);
  gl_FragColor = vec4(applyFog(col, vW), depthCode(vW));
}`;

export function makeSporophytes(G, shared, defines, count, rnd) {
  const g = sporophyteGeometry();
  const pts = G.scatter(count, (i) => {
    const x = G.pos[i * 3], z = G.pos[i * 3 + 2];
    return G.hab[i] > 0.45 && Math.hypot(x, z - 4) < 26 ? G.hab[i] ** 2 * (G.kind[i] === 0 ? 1 : 2.2) : 0;
  }, rnd);
  const n = pts.length, P = new Float32Array(n * 3), Nn = new Float32Array(n * 3), V = new Float32Array(n), H = new Float32Array(n), A = new Float32Array(n), K = new Float32Array(n), S = new Float32Array(n * 4);
  pts.forEach((q, i) => { P.set(q.p, i * 3); Nn.set(q.n, i * 3); V[i] = q.vid; H[i] = q.hab; A[i] = q.arr; K[i] = q.kind; S.set([rnd(), rnd(), rnd(), rnd()], i * 4); });
  const I = (a, s) => new THREE.InstancedBufferAttribute(a, s);
  g.setAttribute('iPos', I(P, 3)); g.setAttribute('iNor', I(Nn, 3)); g.setAttribute('iVid', I(V, 1)); g.setAttribute('iHab', I(H, 1)); g.setAttribute('iArr', I(A, 1)); g.setAttribute('iKind', I(K, 1)); g.setAttribute('iSeed', I(S, 4));
  g.instanceCount = n;
  const m = new THREE.ShaderMaterial({ defines, uniforms: { ...shared }, vertexShader: SPORO_VS, fragmentShader: SPORO_FS });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
  return mesh;
}

// ---- near detail: the moss as shoots. Within a few metres of the camera each mossy vertex
// carries a handful of tufts, each a little rosette of upright shoots with keeled leaves (after
// mrdoob's floor moss), so close up the pile becomes plants. They are placed on the CPU around
// the camera, refilled only when the camera has moved, and fade in with distance; far away the
// shells and the painterly filter take over.
function tuftGeometry() {
  const pos = [], tip = [], idx = [], rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  for (let sh = 0; sh < 5; sh++) {
    const a0 = sh * 2.39996, r0 = 0.011 * Math.sqrt(sh / 4 + 0.05), x0 = Math.cos(a0) * r0, z0 = Math.sin(a0) * r0;
    const H = 0.6 + rnd() * 0.4;
    for (let lf = 0; lf < 4; lf++) {
      const t = lf / 3, a = a0 + lf * 2.39996, L = (0.011 + rnd() * 0.006) * (1 - t * 0.3), W = L * 0.24, rise = 0.45 + t * 0.5;
      const dx = Math.cos(a) * L, dz = Math.sin(a) * L, sx = -Math.sin(a) * W, sz = Math.cos(a) * W, y = 0.022 * H * t;
      const o = pos.length / 3;
      pos.push(x0, y, z0, x0 + dx * 0.5 + sx, y + L * rise * 0.45, z0 + dz * 0.5 + sz, x0 + dx * 0.5, y + L * rise * 0.45 + W * 0.5, z0 + dz * 0.5,
        x0 + dx * 0.5 - sx, y + L * rise * 0.45, z0 + dz * 0.5 - sz, x0 + dx, y + L * rise, z0 + dz);
      tip.push(t * 0.4, t * 0.5 + 0.3, t * 0.5 + 0.45, t * 0.5 + 0.3, t * 0.6 + 0.4);
      idx.push(o, o + 1, o + 2, o, o + 2, o + 3, o + 1, o + 4, o + 2, o + 2, o + 4, o + 3);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aTip', new THREE.Float32BufferAttribute(tip, 1));
  g.setIndex(idx);
  return g;
}

const TUFT_VS = /* glsl */ `
${COMMON}
${MOSS}
uniform float uTuftR;
attribute float aTip;
attribute vec3 iPos, iNor; attribute vec4 iA, iSeed;
varying vec3 vW, vN; varying float vT, vD, vId;
void main() {
  vec2 md = mossState(iA.x, iA.y, iA.z);
  float dist = distance(iPos, cameraPosition);
  float s = smoothstep(0.4, 0.8, md.x) * smoothstep(uTuftR, uTuftR * 0.6, dist);
  if (s < 0.03) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec3 n = normalize(mix(iNor, vec3(0, 1, 0), 0.35));
  vec3 t = normalize(cross(n, abs(n.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0))), b = cross(n, t);
  float a = iSeed.x * 6.2832, ca = cos(a), sa = sin(a);
  vec3 lp = vec3(position.x * ca - position.z * sa, position.y, position.x * sa + position.z * ca);
  float k = (0.85 + 0.6 * iSeed.y) * (0.6 + 0.6 * md.y) * uLush * s;
  float sway = sin(uTime * (1.4 + iSeed.z) + iSeed.w * 6.28) * uWind * position.y * 6.0;
  vec3 base = iPos + iNor * (mossLift(iPos, md, iA.w) - 0.004);
  vec3 p = base + (t * (lp.x + sway * 0.01) + n * lp.y * (0.8 + 0.6 * md.y) + b * lp.z) * k;
  p = rise(p, 1.0);
  vW = p; vN = normalize(n + (t * lp.x + b * lp.z) * 40.0); vT = aTip; vD = md.y; vId = iSeed.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}`;
const TUFT_FS = /* glsl */ `
${COMMON}
${SHADOW}
${MOSS}
varying vec3 vW, vN; varying float vT, vD, vId;
void main() {
  vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
  vec3 col = mossColor(vW, vD, 0.2 + 0.85 * vT + (vId - 0.5) * 0.3, vId);
  col *= 0.85 + 0.35 * vT;
  float sh = sunShadow(vW + vN * 0.02, 0.0015);
  col = shade(col, n, vW, 0.3 + 0.7 * vT, sh, 0.5, 0.6, 0.3 + 0.6 * vT);
  gl_FragColor = vec4(applyFog(col, vW), depthCode(vW));
}`;

export function makeTufts(G, shared, defines, radius) {
  const cap = Math.round(1300 * radius * radius);
  const g = tuftGeometry();
  const P = new Float32Array(cap * 3), Nn = new Float32Array(cap * 3), A = new Float32Array(cap * 4), Sd = new Float32Array(cap * 4);
  const aP = new THREE.InstancedBufferAttribute(P, 3), aN = new THREE.InstancedBufferAttribute(Nn, 3), aA = new THREE.InstancedBufferAttribute(A, 4), aS = new THREE.InstancedBufferAttribute(Sd, 4);
  for (const a of [aP, aN, aA, aS]) a.setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('iPos', aP); g.setAttribute('iNor', aN); g.setAttribute('iA', aA); g.setAttribute('iSeed', aS);
  g.instanceCount = 0;
  const m = new THREE.ShaderMaterial({ defines: { ...defines, SHADOW_TAPS: 4 }, uniforms: { ...shared, uTuftR: { value: radius } }, vertexShader: TUFT_VS, fragmentShader: TUFT_FS, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false;
  const last = new THREE.Vector3(1e9, 0, 0);
  const h = (i, k) => { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
  const { pos, nor, hab, arr, kind, adj, adjStart } = G;
  // fill the tufts around the camera; cheap, and only when it has moved a quarter radius
  const lastDir = new THREE.Vector3(), cand = [];
  mesh.userData.update = (cam, dir, force) => {
    if (!force && cam.distanceTo(last) < radius * 0.2 && dir.dot(lastDir) > 0.92) return;
    last.copy(cam); lastDir.copy(dir);
    let n = 0; cand.length = 0;
    // vertices in front of the camera, nearest first
    G.near(cam.x, cam.y, cam.z, radius, (i, d2) => {
      if (kind[i] === 0 && hab[i] <= 0) return;
      const dx = pos[i * 3] - cam.x, dy = pos[i * 3 + 1] - cam.y, dz = pos[i * 3 + 2] - cam.z;
      if (dx * dir.x + dy * dir.y + dz * dir.z < -0.6 * Math.sqrt(d2) && d2 > 0.25) return;
      cand.push(d2, i);
    });
    const order = Array.from({ length: cand.length / 2 }, (_, k) => k).sort((a, b) => cand[a * 2] - cand[b * 2]);
    for (const o of order) {
      const i = cand[o * 2 + 1];
      if (n >= cap) break;
      // edge length round the vertex sets how many tufts it needs to close up
      let e = 0, c = 0;
      for (let q = adjStart[i]; q < adjStart[i + 1] && c < 4; q++, c++) { const j = adj[q]; e += Math.hypot(pos[j * 3] - pos[i * 3], pos[j * 3 + 1] - pos[i * 3 + 1], pos[j * 3 + 2] - pos[i * 3 + 2]); }
      e = c ? e / c : 0.05;
      const want = Math.min(20, Math.max(1, Math.round((e * e) / (0.032 * 0.032))));
      const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
      const tx = Math.abs(ny) < 0.9 ? nz : 0, ty = Math.abs(ny) < 0.9 ? 0 : -nz, tz = Math.abs(ny) < 0.9 ? -nx : ny;
      const tl = Math.hypot(tx, ty, tz) || 1, bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
      for (let k = 0; k < want && n < cap; k++) {
        const u = (h(i, k) - 0.5) * e, v = (h(i, k + 31) - 0.5) * e;
        P[n * 3] = pos[i * 3] + (tx * u) / tl + (bx * v) / tl; P[n * 3 + 1] = pos[i * 3 + 1] + (ty * u) / tl + (by * v) / tl; P[n * 3 + 2] = pos[i * 3 + 2] + (tz * u) / tl + (bz * v) / tl;
        Nn[n * 3] = nx; Nn[n * 3 + 1] = ny; Nn[n * 3 + 2] = nz;
        A[n * 4] = i; A[n * 4 + 1] = hab[i]; A[n * 4 + 2] = arr[i]; A[n * 4 + 3] = kind[i];
        Sd[n * 4] = h(i, k + 7); Sd[n * 4 + 1] = h(i, k + 13); Sd[n * 4 + 2] = h(i, k + 17); Sd[n * 4 + 3] = h(i, k + 23);
        n++;
      }
    }
    g.instanceCount = n;
    for (const a of [aP, aN, aA, aS]) { a.updateRange.count = n * a.itemSize; a.needsUpdate = true; }
  };
  mesh.userData.hide = () => { g.instanceCount = 0; last.set(1e9, 0, 0); };
  return mesh;
}

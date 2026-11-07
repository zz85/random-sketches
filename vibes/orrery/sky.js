// sky.js - the celestial sphere: a dome of night-blue enamel that turns to day, the Milky Way, 5000 stars
// as gilded points with spikes, gold constellation figures, and labels. Lives in a group whose matrix is
// the exact J2000-equatorial -> local-horizon rotation for the observer, so every star is where it is.
import * as THREE from 'three/webgpu';
import { Fn, uniform, attribute, vec2, vec3, vec4, float, mix, smoothstep, clamp, abs, exp, sqrt, pow, max, min, dot, cross, normalize, length, asin, atan, sin, cos,
  positionWorld, positionLocal, modelWorldMatrix, cameraViewMatrix, cameraProjectionMatrix, cameraPosition, mx_fractal_noise_float, mx_noise_float, time, hash, faceDirection } from 'three/tsl';
import { STARS, LINES, CONSTELLATIONS, NAMED } from './stardata.js';
import { eqjVec } from './astro.js';
export const SKY_R = 1000;
import { textSprite, labelSprite, v3 } from './materials.js';

export const U = {
  sun: uniform(new THREE.Vector3(0, 1, 0)), // world direction of the Sun
  day: uniform(0), // 0 night .. 1 full day
  twi: uniform(0), // twilight weight
  starGain: uniform(1),
  px: uniform(0.001), // view-space units per pixel at unit depth
  dpr: uniform(1),
  lines: uniform(0.55),
};

const NGP = eqjVec(192.85948, 27.12825), GC = eqjVec(266.405, -28.936);
const GC3 = new THREE.Vector3().crossVectors(NGP, GC);

// sky colour for a world direction d and its J2000 direction e (both unit)
export function skyColor(d, e, { milky = true } = {}) {
  const s = U.sun, h = d.y;
  const mu = dot(d, s);
  // night: deep blue enamel, a degrade toward the horizon, faint airglow on it
  const night = mix(vec3(0.004, 0.009, 0.03), vec3(0.016, 0.04, 0.115), smoothstep(-0.25, 0.95, h))
    .add(vec3(0.03, 0.035, 0.05).mul(exp(abs(h).mul(-14))));
  // day: thin Rayleigh-ish gradient and a Mie halo round the sun
  const hp = max(h, 0);
  const daySky = mix(vec3(0.62, 0.74, 0.9), vec3(0.11, 0.31, 0.72), pow(hp, 0.45))
    .add(vec3(1.0, 0.9, 0.7).mul(pow(max(mu, 0), 9).mul(0.35).add(pow(max(mu, 0), 120).mul(1.5))));
  // twilight: an orange band under the sun's azimuth and the violet Belt of Venus opposite
  const dh = normalize(vec3(d.x, 0.0001, d.z)), sh = normalize(vec3(s.x, 0.0001, s.z));
  const muH = dot(dh, sh);
  const band = exp(hp.mul(-5.5));
  const tw = vec3(1.0, 0.36, 0.1).mul(pow(max(muH, 0), 1.6)).mul(band).mul(1.3)
    .add(vec3(0.95, 0.6, 0.3).mul(pow(max(mu, 0), 6)).mul(0.6))
    .add(vec3(0.3, 0.16, 0.36).mul(pow(max(muH.negate(), 0), 2)).mul(exp(abs(h.sub(0.08)).mul(-9))).mul(0.6));
  let col = mix(night, daySky, U.day).add(tw.mul(U.twi));
  if (milky) {
    const b = asin(clamp(dot(e, v3(NGP)), -1, 1));
    const l = atan(dot(e, v3(GC3)), dot(e, v3(GC)));
    const n1 = mx_fractal_noise_float(e.mul(5.0), 4, 2.0, 0.55, 1.0);
    const n2 = mx_fractal_noise_float(e.mul(17.0), 3, 2.0, 0.5, 1.0);
    const bulge = exp(l.mul(l).mul(-1.6).sub(b.mul(b).mul(14.0)));
    const disc = exp(b.mul(b).mul(-28.0)).mul(exp(l.mul(l).mul(-0.12)).mul(0.6).add(0.4));
    const rift = exp(b.sub(0.02).mul(b.sub(0.02)).mul(-900.0)).mul(smoothstep(-0.25, 0.35, n2)).mul(exp(l.mul(l).mul(-0.35)));
    const mw = disc.add(bulge.mul(1.4)).mul(n1.mul(0.55).add(0.75)).mul(rift.mul(-0.8).add(1)).max(0);
    const mwCol = mix(vec3(0.5, 0.58, 0.85), vec3(1.0, 0.82, 0.58), clamp(bulge.mul(2.0), 0, 1));
    col = col.add(mwCol.mul(mw).mul(0.085).mul(U.day.oneMinus().pow(3)).mul(smoothstep(-0.25, 0.05, h).mul(0.6).add(0.4)));
  }
  // below the horizon: the ground, a dark veil you can still see the stars through
  const ground = mix(vec3(0.006, 0.008, 0.016), vec3(0.05, 0.06, 0.07), U.day).add(tw.mul(U.twi).mul(0.08).mul(exp(h.mul(30))));
  col = mix(col, ground, smoothstep(0.0, -0.035, h).mul(0.9));
  return col;
}

function bvColor(bv) {
  // B-V to an sRGB-ish tint (Ballesteros temperature, then a rough blackbody ramp)
  const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const t = Math.min(Math.max(T, 2500), 30000) / 100;
  let r = t <= 66 ? 1 : Math.min(1, 1.29 * Math.pow(t - 60, -0.1332));
  let g = t <= 66 ? Math.min(1, 0.39 * Math.log(t) - 0.63) : Math.min(1, 1.13 * Math.pow(t - 60, -0.0755));
  let b = t >= 66 ? 1 : t <= 19 ? 0 : Math.min(1, 0.543 * Math.log(t - 10) - 1.196);
  return new THREE.Color(r, g, Math.max(0, b)).convertSRGBToLinear();
}

export function buildSky() {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;

  // ---- the dome
  const domeGeo = new THREE.SphereGeometry(SKY_R, 96, 64);
  const dome = new THREE.Mesh(domeGeo, new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide, depthWrite: false, transparent: true }));
  const d = normalize(positionWorld), e = normalize(positionLocal);
  dome.material.colorNode = skyColor(d, e);
  dome.renderOrder = -10; dome.frustumCulled = false;
  group.add(dome);

  // ---- stars: one mesh of quads, each sized and placed in the vertex shader
  const n = STARS.length / 4;
  const pos = new Float32Array(n * 12), corner = new Float32Array(n * 8), mag = new Float32Array(n * 4), col = new Float32Array(n * 12), seed = new Float32Array(n * 4);
  const idx = new Uint32Array(n * 6);
  const v = new THREE.Vector3(), gold = new THREE.Color(0xf3d58c).convertSRGBToLinear();
  const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < n; i++) {
    eqjVec(STARS[i * 4], STARS[i * 4 + 1], v);
    const m = STARS[i * 4 + 2], c = bvColor(STARS[i * 4 + 3]).lerp(gold, 0.3);
    const r = Math.random();
    for (let k = 0; k < 4; k++) {
      const j = i * 4 + k;
      pos.set([v.x, v.y, v.z], j * 3); corner.set(C[k], j * 2); mag[j] = m; col.set([c.r, c.g, c.b], j * 3); seed[j] = r;
    }
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  sg.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
  sg.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
  sg.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
  sg.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  sg.setIndex(new THREE.BufferAttribute(idx, 1));
  const sm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const aDir = attribute('position', 'vec3'), aCorner = attribute('aCorner', 'vec2'), aMag = attribute('aMag', 'float'), aCol = attribute('aCol', 'vec3'), aSeed = attribute('aSeed', 'float');
  // pixel radius of the core, and how much bigger the quad is for the spikes of bright stars
  const rad = mix(float(0.9), float(4.2), smoothstep(6.2, -1.5, aMag)).mul(U.dpr);
  const bright = smoothstep(2.2, -0.5, aMag);
  const quad = mix(float(2.2), float(7.0), bright);
  sm.vertexNode = Fn(() => {
    const wp = modelWorldMatrix.mul(vec4(aDir.mul(SKY_R * 0.985), 1));
    const vp = cameraViewMatrix.mul(wp);
    const off = aCorner.mul(rad).mul(quad).mul(U.px).mul(vp.z.negate()).mul(U.starGain.sqrt().max(0.6));
    return cameraProjectionMatrix.mul(vec4(vp.xy.add(off), vp.z, 1));
  })();
  const up = normalize(modelWorldMatrix.mul(vec4(aDir, 0)).xyz).y;
  sm.colorNode = Fn(() => {
    const c = aCorner.mul(quad); // in units of the core radius
    const r2 = dot(c, c);
    const core = exp(r2.mul(-1.4));
    const halo = exp(sqrt(r2).mul(-1.1)).mul(0.18);
    const sx = exp(abs(c.y).mul(-5.0)).mul(max(float(0), float(1).sub(abs(c.x).div(quad)))).pow(1.5);
    const sy = exp(abs(c.x).mul(-5.0)).mul(max(float(0), float(1).sub(abs(c.y).div(quad)))).pow(1.5);
    const spikes = sx.add(sy).mul(bright).mul(0.55);
    // flux relative to a 1st-magnitude star; faint stars dim instead of shrinking below a pixel
    const flux = pow(float(2.512), float(2.0).sub(aMag)).min(8.0);
    const intensity = flux.div(rad.div(U.dpr).mul(rad.div(U.dpr)).mul(0.5)).min(3.5).max(0.05);
    // twinkle, stronger toward the horizon
    const tw = sin(time.mul(aSeed.mul(5).add(4)).add(aSeed.mul(40))).mul(0.5).add(0.5);
    const twinkle = float(1).sub(tw.mul(mix(float(0.12), float(0.45), smoothstep(0.5, 0.0, up))));
    const vis = U.day.oneMinus().pow(2.2).mul(0.97).add(0.03).mul(smoothstep(-0.03, 0.01, up).mul(0.82).add(0.18)).mul(U.starGain);
    return vec4(aCol.mul(core.add(halo).add(spikes)).mul(intensity).mul(twinkle).mul(vis), 1);
  })();
  const stars = new THREE.Mesh(sg, sm);
  stars.frustumCulled = false; stars.renderOrder = -5;
  group.add(stars);

  // ---- constellation figures, fine gold lines
  const lp = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  for (const ln of LINES) for (let i = 0; i + 3 < ln.length; i += 2) {
    eqjVec(ln[i], ln[i + 1], a).multiplyScalar(SKY_R * 0.98); eqjVec(ln[i + 2], ln[i + 3], b).multiplyScalar(SKY_R * 0.98);
    // trim the ends so the lines don't run into the stars
    const ab = b.clone().sub(a), L = ab.length(), trim = Math.min(L * 0.18, 9);
    lp.push(...a.clone().addScaledVector(ab, trim / L).toArray(), ...b.clone().addScaledVector(ab, -trim / L).toArray());
  }
  const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  const lm = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const lup = normalize(positionWorld).y;
  lm.colorNode = vec3(0.85, 0.66, 0.33).mul(U.lines).mul(U.day.oneMinus().pow(3).mul(0.96).add(0.04)).mul(smoothstep(-0.03, 0.01, lup).mul(0.75).add(0.25));
  const lines = new THREE.LineSegments(lg, lm); lines.frustumCulled = false; lines.renderOrder = -6;
  group.add(lines);

  // ---- labels: constellations (italic, faint) and the brightest stars
  const labels = { cons: [], stars: [] };
  const mkLabel = (txt, ra, dec, opts, list, center = [0.5, 0.5]) => {
    const { tex, aspect } = textSprite(txt, opts);
    const mat = new THREE.SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: false });
    mat.opacity = 0.9;
    const s = new THREE.Sprite(mat);
    eqjVec(ra, dec, s.position).multiplyScalar(SKY_R * 0.97);
    s.center.set(center[0], center[1]); s.userData = { aspect, px: opts.px || 13 }; s.renderOrder = 5; s.visible = false;
    group.add(s); list.push(s); return s;
  };
  for (const [name, ra, dec, rank] of CONSTELLATIONS) mkLabel(name.toUpperCase(), ra, dec, { size: 40, italic: false, color: '#c9a868', spacing: 0.35, px: rank === 1 ? 11 : 9.5 }, labels.cons);
  for (const [name, ra, dec] of NAMED) mkLabel(name, ra, dec, { size: 40, italic: true, color: '#f4e4c0', spacing: 0.05, px: 11 }, labels.stars, [-0.12, 0.5]);

  // ---- the ecliptic: the plane of the watch's orrery, seen from inside it, with a tick every sign
  {
    const eps = 23.4393 * Math.PI / 180, R = SKY_R * 0.975, pts = [];
    const at = (l, b = 0) => { const x = Math.cos(b) * Math.cos(l), y = Math.cos(b) * Math.sin(l), z = Math.sin(b); return [x * R, (y * Math.cos(eps) - z * Math.sin(eps)) * R, (y * Math.sin(eps) + z * Math.cos(eps)) * R]; };
    for (let d = 0; d < 360; d += 1) {
      const l = d * Math.PI / 180, l2 = (d + 1) * Math.PI / 180;
      pts.push(...at(l), ...at(l2));
      const tk = d % 30 === 0 ? 0.03 : d % 10 === 0 ? 0.012 : 0;
      if (tk) pts.push(...at(l, -tk), ...at(l, tk));
    }
    const eg = new THREE.BufferGeometry(); eg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const em = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const eup = normalize(modelWorldMatrix.mul(vec4(positionLocal, 0)).xyz).y;
    em.colorNode = vec3(0.95, 0.72, 0.35).mul(U.lines).mul(0.55).mul(U.day.oneMinus().pow(2).mul(0.9).add(0.1)).mul(smoothstep(-0.03, 0.01, eup).mul(0.7).add(0.3));
    const ecl = new THREE.LineSegments(eg, em); ecl.frustumCulled = false; ecl.renderOrder = -6; group.add(ecl);
  }

  return { group, dome, stars, lines, labels };
}

// the horizon of the planetarium: a fine gold line with azimuth ticks and the cardinal points, in world space
export function buildHorizon() {
  const g = new THREE.Group(), R = SKY_R * 0.9, pts = [];
  for (let a = 0; a < 360; a += 1) {
    const r = a * Math.PI / 180, x = Math.sin(r) * R, z = -Math.cos(r) * R, l = a % 10 ? (a % 5 ? 0 : R * 0.006) : R * 0.014;
    const r2 = (a + 1) * Math.PI / 180;
    pts.push(x, 0, z, Math.sin(r2) * R, 0, -Math.cos(r2) * R);
    if (l) pts.push(x, 0, z, x, l, z);
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const m = new THREE.LineBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  m.colorNode = vec3(0.9, 0.72, 0.4).mul(0.55);
  const line = new THREE.LineSegments(geo, m); line.frustumCulled = false; line.renderOrder = -4; g.add(line);
  g.userData.labels = [];
  for (const [t, a, px] of [['N', 0, 22], ['NE', 45, 13], ['E', 90, 22], ['SE', 135, 13], ['S', 180, 22], ['SW', 225, 13], ['W', 270, 22], ['NW', 315, 13]]) {
    const s = labelSprite(t, { size: 64, color: '#f0d49a', spacing: 0.1, px, center: [0.5, -0.25] });
    const r = a * Math.PI / 180; s.position.set(Math.sin(r) * R, 0, -Math.cos(r) * R);
    g.add(s); g.userData.labels.push(s);
  }
  return g;
}

// planets.js - the Sun, Moon and planets for the immersive sky, drawn as globes "brought closer":
// planets 2000x nearer than they are (so Jupiter spans about 26 degrees), the Sun and Moon twelve to seventeen times larger.
// Each sits in its true direction, lit from its true direction to the Sun (so phases are real), turned to its
// IAU pole and prime meridian, and in true order of distance, so a nearer body passes in front of a farther one.
import * as THREE from 'three/webgpu';
import { Fn, uniform, uv, vec2, vec3, vec4, float, mix, smoothstep, clamp, abs, exp, pow, max, min, dot, normalize, length, sin, cos, atan,
  texture, positionWorld, positionLocal, normalWorld, normalLocal, cameraPosition, mx_fractal_noise_float, mx_noise_float, time, modelWorldMatrix, If, Discard } from 'three/tsl';
import { BODIES, MAX_DEG } from './astro.js';
import { labelSprite } from './materials.js';
import { skyColor } from './sky.js';

const PPE = 'https://cdn.jsdelivr.net/gh/jeromeetienne/threex.planets@3de707594b1178ba32c62199bf29efdf90f59cf0/images/';
export const THREE_TEX = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r187/examples/textures/planets/';
export const TEXTURE_PREFIXES = [PPE, THREE_TEX];
export const MAPS = { Moon: THREE_TEX + 'moon_1024.jpg', Mercury: PPE + 'mercurymap.jpg', Mars: PPE + 'marsmap1k.jpg', Jupiter: PPE + 'jupitermap.jpg', Saturn: PPE + 'saturnmap.jpg', Uranus: PPE + 'uranusmap.jpg', Neptune: PPE + 'neptunemap.jpg', Sun: PPE + 'sunmap.jpg' };
const ATMOS = { Venus: [1.0, 0.9, 0.7, 0.5], Mars: [1.0, 0.6, 0.45, 0.25], Jupiter: [0.95, 0.85, 0.7, 0.25], Saturn: [0.95, 0.85, 0.6, 0.25], Uranus: [0.6, 0.9, 1.0, 0.45], Neptune: [0.45, 0.6, 1.0, 0.45] };
export const RING_IN = 74500 / 60268, RING_OUT = 140220 / 60268; // the ring texture's span, in Saturn radii

// display distance (world units) for a true distance in AU: compressed, but in the same order
export const placeDist = (au) => 400 * Math.pow(au / 40, 0.25);

const loader = new THREE.TextureLoader();
export function tex(url, srgb = true) {
  const t = loader.load(url);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; t.wrapS = THREE.RepeatWrapping;
  return t;
}

export function globeMaterial(key, uSun, { air = true } = {}) {
  const m = new THREE.MeshBasicNodeMaterial();
  const n = normalize(normalWorld), l = uSun, v = normalize(cameraPosition.sub(positionWorld));
  const mu0 = dot(n, l), mu = dot(n, v).max(1e-3);
  let albedo;
  if (key === 'Venus') {
    // thick cloud: soft creamy bands that drift
    const q = normalLocal;
    const nz = mx_fractal_noise_float(q.mul(vec3(2.0, 7.0, 2.0)).add(vec3(time.mul(0.01), 0, 0)), 4, 2.0, 0.5, 1.0);
    albedo = mix(vec3(0.93, 0.85, 0.66), vec3(0.98, 0.95, 0.86), nz.mul(0.5).add(0.5)).sub(vec3(0.06, 0.07, 0.1).mul(abs(sin(q.y.mul(9).add(nz.mul(2))))));
  } else {
    albedo = texture(tex(MAPS[key]), uv()).rgb;
    if (key === 'Moon') albedo = albedo.mul(1.15);
  }
  let shade;
  if (key === 'Moon' || key === 'Mercury') {
    // Lommel-Seeliger: an airless, dusty world looks flat at full phase, not like a ball
    shade = mu0.max(0).div(mu0.max(0).add(mu)).mul(2.0).mul(smoothstep(-0.02, 0.05, mu0));
  } else {
    shade = smoothstep(-0.12, 0.35, mu0).mul(mu0.max(0).mul(0.75).add(0.25));
  }
  let col = albedo.mul(shade).mul(1.25);
  if (key === 'Moon') col = col.add(albedo.mul(vec3(0.5, 0.6, 0.9)).mul(0.02)); // earthshine
  const at = ATMOS[key];
  if (at) {
    // a limb of lit atmosphere, brightest on the sunward side
    const rim = pow(mu.oneMinus(), 3.0).mul(smoothstep(-0.25, 0.4, mu0));
    col = col.add(vec3(at[0], at[1], at[2]).mul(rim).mul(at[3]));
  }
  if (key === 'Saturn') {
    // the rings' shadow on the globe: from this point toward the Sun, where does the ray cross the ring plane?
    const nRing = normalize(modelWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz), c = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz;
    const R = modelWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz.length();
    const p = positionWorld, tHit = dot(c.sub(p), nRing).div(dot(l, nRing));
    const hit = p.add(l.mul(tHit)), rr = length(hit.sub(c)).div(R);
    const inRing = smoothstep(RING_IN - 0.02, RING_IN + 0.05, rr).mul(smoothstep(RING_OUT + 0.02, RING_OUT - 0.08, rr)).mul(tHit.greaterThan(0).select(1, 0));
    col = col.mul(inRing.mul(-0.7).add(1));
  }
  // the air in front of the body: the dark limb takes the sky's colour, and by day the whole disc washes out
  const vd = normalize(positionWorld.sub(cameraPosition));
  if (air) col = col.add(skyColor(vd, vd, { milky: false }));
  m.colorNode = col;
  return m;
}

export function ringMaterial(uSun) {
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const colT = tex(PPE + 'saturnringcolor.jpg'), patT = tex(PPE + 'saturnringpattern.gif', false);
  const r = length(positionLocal.xy);
  const R = modelWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz.length(); // the planet's radius (the ring is the globe's child)
  const t = r.sub(RING_IN).div(RING_OUT - RING_IN);
  const rc = vec2(t, 0.5);
  const col = texture(colT, rc).rgb, a = texture(patT, rc).r;
  // the planet's shadow on the rings
  const c = modelWorldMatrix.mul(vec4(0, 0, 0, 1)).xyz, p = positionWorld, toC = c.sub(p), along = dot(toC, uSun);
  const perp = length(toC.sub(uSun.mul(along)));
  const shadow = max(smoothstep(R.mul(0.97), R.mul(1.03), perp), along.lessThan(0).select(1, 0));
  // lit side brighter, unlit side glows faintly by light passing through
  const nW = normalize(modelWorldMatrix.mul(vec4(0, 0, 1, 0)).xyz);
  const v = normalize(cameraPosition.sub(p));
  const sameSide = dot(nW, uSun).mul(dot(nW, v)).greaterThan(0).select(1.0, 0.35);
  m.colorNode = col.mul(shadow.mul(0.95).add(0.05)).mul(sameSide).mul(abs(dot(nW, uSun)).mul(0.6).add(0.5));
  m.opacityNode = a.mul(t.greaterThan(0).and(t.lessThan(1)).select(1, 0)).mul(0.95);
  return m;
}

function sunMaterials() {
  const disc = new THREE.MeshBasicNodeMaterial();
  const v = normalize(cameraPosition.sub(positionWorld)), mu = dot(normalize(normalWorld), v).max(0);
  const gran = texture(tex(MAPS.Sun), uv().add(vec2(time.mul(0.001), 0))).rgb;
  const limb = pow(mu, 0.5).mul(0.7).add(0.3);
  disc.colorNode = mix(vec3(1.0, 0.62, 0.25), vec3(1.0, 0.93, 0.75), limb).mul(gran.r.mul(0.25).add(0.85)).mul(limb).mul(6.0);
  // corona and glare: a camera-facing quad
  const glow = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const q = positionLocal.xy, r = length(q);
  const ang = atan(q.y, q.x);
  const streak = pow(abs(cos(ang.mul(3).add(mx_noise_float(vec3(ang.mul(2), r.mul(0.3), time.mul(0.05))).mul(1.5)))), 6).mul(0.5).add(0.5);
  glow.colorNode = vec3(1.0, 0.8, 0.55).mul(exp(r.sub(1).max(0).mul(-2.2)).mul(0.9).mul(streak).add(exp(r.mul(-0.35)).mul(0.12))).mul(smoothstep(1.0, 1.04, r)).mul(smoothstep(12.0, 6.0, r));
  return { disc, glow };
}

// a point of light for when the globe is smaller than a few pixels (true scale, or far zoomed out)
function glintMaterial(color) {
  const m = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: false });
  const p = uv().sub(0.5).mul(2), r2 = dot(p, p);
  const spikes = exp(abs(p.x).mul(-14)).add(exp(abs(p.y).mul(-14))).mul(smoothstep(1.0, 0.0, r2)).mul(0.5);
  const uA = uniform(1); m.userData.alpha = uA;
  m.colorNode = vec3(new THREE.Color(color).convertSRGBToLinear()).mul(exp(r2.mul(-9)).mul(2.2).add(spikes)).mul(uA);
  return m;
}

export function buildPlanets() {
  const group = new THREE.Group();
  const out = { group, bodies: {} };
  for (const b of BODIES) {
    const uSun = uniform(new THREE.Vector3(1, 0, 0));
    const node = new THREE.Group(); // positioned and turned each frame; scaled to the globe's radius
    let globe, extra = null;
    if (b.key === 'Sun') {
      const sm = sunMaterials();
      globe = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), sm.disc);
      extra = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), sm.glow); extra.renderOrder = 3; extra.frustumCulled = false;
      group.add(extra);
    } else {
      globe = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), globeMaterial(b.key, uSun));
      if (b.key === 'Saturn') {
        const ring = new THREE.Mesh(new THREE.RingGeometry(RING_IN, RING_OUT, 192, 1), ringMaterial(uSun));
        ring.rotation.x = -Math.PI / 2; ring.renderOrder = 2; globe.add(ring);
      }
    }
    node.add(globe);
    const glint = new THREE.Sprite(glintMaterial(b.color)); glint.renderOrder = 4;
    const label = labelSprite(b.name.toUpperCase(), { size: 44, color: '#f2dca4', spacing: 0.3, px: 12, center: [0.5, 1.6] });
    group.add(node, glint, label);
    out.bodies[b.key] = { def: b, node, globe, extra, glint, label, uSun, R: 1, D: 1, ang: 0 };
  }
  return out;
}

const tA = new THREE.Vector3(), tB = new THREE.Vector3(), tC = new THREE.Vector3(), tM = new THREE.Matrix4();

// magnify: 0 true size, 1 brought closer (planets 2000x, Sun and Moon 12 and 17 times)
export function updatePlanets(P, sky, camera, magnify, pxPerRad, labels) {
  for (const b of BODIES) {
    const s = sky.bodies[b.key], o = P.bodies[b.key];
    const k = 1 + (b.near - 1) * magnify;
    const ang = Math.min(s.diam * k, b.key === 'Moon' || b.key === 'Sun' ? MAX_DEG.lights : MAX_DEG.planets) * Math.PI / 180; // angular diameter drawn, radians
    const D = placeDist(s.dist), R = D * Math.tan(ang / 2);
    o.R = R; o.D = D; o.ang = ang;
    const p = tA.copy(s.dir).multiplyScalar(D);
    o.node.position.copy(p);
    // body frame: x prime meridian, y north pole, z = x cross y
    tB.copy(s.north); tC.copy(s.pm).addScaledVector(tB, -s.pm.dot(tB)).normalize();
    tM.makeBasis(tC, tB, new THREE.Vector3().crossVectors(tC, tB)); o.node.quaternion.setFromRotationMatrix(tM);
    o.node.scale.setScalar(R);
    o.uSun.value.copy(s.sun);
    if (o.extra) { o.extra.position.copy(p).multiplyScalar(1.02); o.extra.quaternion.copy(camera.quaternion); o.extra.scale.setScalar(R); }
    // a glint when the disc is under ~4 px, fading as it grows
    const px = (ang / 2) * pxPerRad;
    const ga = THREE.MathUtils.clamp((4 - px) / 3, 0, 1);
    o.glint.visible = ga > 0.01 && b.key !== 'Sun';
    o.glint.material.userData.alpha.value = ga * (s.alt > -1 ? 1 : 0.35);
    o.glint.position.copy(p).multiplyScalar(0.999);
    const gs = 16 / pxPerRad; o.glint.scale.set(gs, gs, 1);
    o.label.visible = labels;
    o.label.position.copy(p);
    o.label.center.y = 1.2 + Math.max(px, 4) / 12 * 1.0;
  }
}

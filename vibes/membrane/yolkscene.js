// yolkscene.js - Membrane, the yolk game: the yolk's skin, the bowl it goes in, the egg white left in the shell, and
// the yolk that runs out of a burst one.
import * as THREE from 'three/webgpu';
import { Fn, attribute, varying, int, float, vec3, select, mix, smoothstep, clamp, transformNormalToView, faceDirection, mx_fractal_noise_float, mx_noise_float,
  uniform, dot, normalize, max, pow, abs, normalView, positionView, positionLocal, length, sin, time } from 'three/tsl';
import { TABLE_Y } from './sim.js';
import { BOWL, WHITE_Y } from './yolksim.js';
import { eggR } from './egg.js';

// ---------- the yolk: one vertex of the drawn mesh per corner of each triangle, read from the sim's buffers.
// A raw yolk is glossy (a wet skin over a liquid), deep orange where it is thick and paler where the skin is
// drawn thin over it, with pale wrinkles where the skin is gathered (in the pinch). Light goes into it: a warm glow
// at the edges and through it from behind, which reads as a liquid in a skin rather than a ball.
export function buildYolkMesh(sim, light, env = null) {
  const { m } = sim, { pos, normal, triE } = sim.buffers;
  const vid = new Float32Array(m.NT * 3), tid = new Float32Array(m.NT * 3);
  for (let t = 0; t < m.NT; t++) for (let k = 0; k < 3; k++) { vid[t * 3 + k] = m.tris[t][k]; tid[t * 3 + k] = t; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(m.NT * 9), 3));
  g.setAttribute('vid', new THREE.Float32BufferAttribute(vid, 1));
  g.setAttribute('tid', new THREE.Float32BufferAttribute(tid, 1));
  // the rest shape of each vertex, for patterns that travel with the skin
  const rest = new Float32Array(m.NT * 9);
  for (let t = 0; t < m.NT; t++) for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) rest[(t * 3 + k) * 3 + c] = m.pos[m.tris[t][k] * 3 + c];
  g.setAttribute('rest', new THREE.Float32BufferAttribute(rest, 3));
  const mat = new THREE.MeshPhysicalNodeMaterial({ side: THREE.DoubleSide, roughness: 0.42, clearcoat: 0.55, clearcoatRoughness: 0.14, ior: 1.4, specularIntensity: 0.25 });
  // the room's light washes a saturated colour out to peach: the yolk takes less of it than the rest of the scene
  if (env) { mat.envMap = env; mat.envMapIntensity = 0.12; }
  const vi = int(attribute('vid', 'float')), ti = int(attribute('tid', 'float'));
  mat.positionNode = Fn(() => select(triE.element(ti).w.greaterThan(0.5), pos.element(vi).xyz, vec3(0, -50, 0)))();
  const nrm = varying(normal.element(vi), 'yNrm');
  mat.normalNode = transformNormalToView(nrm.xyz).mul(faceDirection);
  const R = attribute('rest', 'vec3');
  const strainView = uniform(0);
  const stretch = nrm.w;
  const thin = clamp(stretch.sub(1).mul(2.2), 0, 1), gathered = clamp(float(0.92).sub(stretch).mul(3.5), 0, 1);
  const mot = mx_fractal_noise_float(R.mul(2.2), 3, 2, 0.5).mul(0.5).add(0.5);
  const deep = mix(vec3(0.85, 0.3, 0.0), vec3(0.92, 0.4, 0.0), mot);
  const pale = vec3(1.0, 0.62, 0.02);
  // gathered skin folds into fine pale creases
  const crease = smoothstep(0.35, 0.85, abs(mx_noise_float(R.mul(vec3(14, 5, 14)))).oneMinus()).mul(gathered);
  const yolkC = mix(mix(deep, pale, thin.mul(0.6)), vec3(0.98, 0.86, 0.6), crease.mul(0.75));
  const heat = mix(mix(vec3(0.2, 0.4, 0.9), vec3(0.95, 0.85, 0.2), clamp(stretch.sub(1).mul(4), 0, 1)), vec3(0.95, 0.15, 0.1), clamp(stretch.sub(1.2).mul(3), 0, 1));
  mat.colorNode = mix(yolkC, heat, strainView);
  mat.roughnessNode = float(0.42).add(crease.mul(0.2));
  const L = uniform(new THREE.Vector3()).onRenderUpdate(() => light.position.clone().sub(light.target.position).normalize());
  const facing = abs(dot(normalView, normalize(positionView).negate()));
  const back = max(dot(nrm.xyz, L).negate(), 0);
  // light scattered in the yolk: a warm rim and light through it from behind, more where the skin is thin
  mat.emissiveNode = vec3(0.85, 0.22, 0.0).mul(pow(float(1).sub(facing), 2).mul(0.3).add(back.mul(0.25)).add(0.07).mul(thin.mul(0.6).add(1))).mul(strainView.oneMinus());
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = true; mesh.renderOrder = 2;
  mesh.userData = { strainView, dispose: () => { g.dispose(); mat.dispose(); } };
  return mesh;
}

// ---------- the bowl: a small glazed bowl, pale celadon, on a foot ring
export function buildBowl() {
  const pts = [], { Rs, t, cy, bot, top } = BOWL;
  pts.push(new THREE.Vector2(0, TABLE_Y), new THREE.Vector2(1.1, TABLE_Y), new THREE.Vector2(1.18, TABLE_Y + 0.06), new THREE.Vector2(1.12, bot - t + 0.05));
  // the outer face, from the foot up to the rim
  const a0 = Math.asin(1.12 / (Rs + t)), a1 = Math.acos((cy - top) / (Rs + t));
  for (let k = 0; k <= 24; k++) { const a = a0 + (a1 - a0) * (k / 24); pts.push(new THREE.Vector2(Math.sin(a) * (Rs + t), cy - Math.cos(a) * (Rs + t))); }
  // a rounded lip, then the inner face back down to the middle
  const ai = Math.acos((cy - top) / Rs);
  pts.push(new THREE.Vector2(Math.sin(ai) * Rs + t * 0.6, top + 0.05), new THREE.Vector2(Math.sin(ai) * Rs + t * 0.15, top + 0.04));
  for (let k = 0; k <= 32; k++) { const a = ai * (1 - k / 32); pts.push(new THREE.Vector2(Math.sin(a) * Rs + 1e-4, cy - Math.cos(a) * Rs)); }
  const g = new THREE.LatheGeometry(pts, 96);
  const mat = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.18, clearcoat: 0.7, clearcoatRoughness: 0.1 });
  mat.colorNode = mix(vec3(0.62, 0.7, 0.62), vec3(0.7, 0.77, 0.69), mx_noise_float(positionLocal.mul(3)).mul(0.5).add(0.5));
  const m = new THREE.Mesh(g, mat); m.position.set(BOWL.x, 0, BOWL.z); m.castShadow = m.receiveShadow = true;
  return m;
}

// ---------- the egg white left in the half shell: its surface, clear and glossy, a disc at WHITE_Y out to the shell
export function buildWhite() {
  // the shell's inner radius across at that height, by direction round the egg
  const S = 96, p = [0, WHITE_Y, 0], idx = [];
  for (let i = 0; i <= S; i++) {
    const th = (i / S) * Math.PI * 2, dx = Math.cos(th), dz = Math.sin(th);
    let lo = 0, hi = 3; for (let k = 0; k < 30; k++) { const r = (lo + hi) / 2, L = Math.hypot(r, WHITE_Y); if (L < eggR(r * dx / L, WHITE_Y / L, r * dz / L)) lo = r; else hi = r; }
    p.push(dx * (lo - 0.02), WHITE_Y, dz * (lo - 0.02));
  }
  for (let i = 1; i <= S; i++) idx.push(0, i + 1, i);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); g.setIndex(idx); g.computeVertexNormals();
  const mat = new THREE.MeshPhysicalNodeMaterial({ transparent: true, depthWrite: false, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, ior: 1.36 });
  mat.colorNode = vec3(0.92, 0.93, 0.86);
  // a slow wobble on its surface
  mat.normalNode = transformNormalToView(normalize(vec3(sin(positionLocal.x.mul(5).add(time.mul(0.7))).mul(0.04), 1, sin(positionLocal.z.mul(4).sub(time.mul(0.5))).mul(0.04))));
  mat.opacityNode = float(0.32);
  const m = new THREE.Mesh(g, mat); m.renderOrder = 4;
  return m;
}

// ---------- a burst yolk running out: a pool that spreads on whatever is under it, its radius set by the app
export function buildPuddle() {
  const g = new THREE.CircleGeometry(1, 64); g.rotateX(-Math.PI / 2);
  // a little raised in the middle, with a wavy edge
  const P = g.attributes.position;
  for (let i = 0; i < P.count; i++) { const x = P.getX(i), z = P.getZ(i), r = Math.hypot(x, z), a = Math.atan2(z, x); const k = 1 + 0.08 * Math.sin(a * 5) + 0.05 * Math.sin(a * 11 + 1); P.setXYZ(i, x * k, 0.12 * (1 - r * r), z * k); }
  g.computeVertexNormals();
  const mat = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.03 });
  mat.colorNode = mix(vec3(0.9, 0.4, 0.02), vec3(0.97, 0.55, 0.07), mx_noise_float(positionLocal.mul(2)).mul(0.5).add(0.5));
  mat.emissiveNode = vec3(0.25, 0.08, 0);
  const m = new THREE.Mesh(g, mat); m.visible = false; m.receiveShadow = true; m.renderOrder = 1;
  return m;
}

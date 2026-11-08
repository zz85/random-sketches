/*
 * dust.js - dust motes drifting in the light. One instanced sprite per mote; each one's place is a
 * function of its index and time (a slow fall and drift through a box around the plinth, with a little
 * wander), so nothing is simulated on the CPU. A mote shows only where the key light reaches it: its
 * place is tested against the key light's shadow map, so motes light up inside the beam and go dark
 * in the shadows of the window frame and the piece, the way dust does in a sunbeam. Each mote turns as
 * it falls and catches the light now and then. The motes live in a scene of their own, drawn by their own
 * pass and added in the composite, so GTAO, the godrays and the scene's normals never see them; each mote
 * hides behind the piece and the plinth by testing its depth against the main pass's depth.
 *
 * Call after the first frame has rendered, so the key light's shadow map exists.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, instanceIndex, hash, time, vec2, vec3, vec4, float, uniform, sin, fract, mix, smoothstep, length, uv,
  texture, lightShadowMatrix, step, screenUV, depth, pow, positionWorld, cameraPosition, distance, clamp,
} from 'three/tsl';

export function buildDust(scene, light, sceneDepth, { count = 2400, box = [1.8, 1.5, 1.8], centre = [0, 1.45, 0] } = {}) {
  const U = { amount: uniform(1), color: uniform(new THREE.Color(1, 0.9, 0.75)), focus: uniform(new THREE.Vector3(0, 1.2, 0)) };
  const r = (k) => hash(instanceIndex.add(k * 7919));
  const B = vec3(...box), C = vec3(...centre);

  // place: a random start, falling 2-6 mm/s and drifting sideways, wrapped in the box, plus a slow wander
  const place = Fn(() => {
    const start = vec3(r(1), r(2), r(3));
    const vel = vec3(r(4).sub(0.5).mul(0.006), r(5).mul(-0.004).sub(0.002), r(6).sub(0.5).mul(0.006));
    const t = time.add(r(7).mul(1000));
    const wander = vec3(sin(t.mul(r(8).mul(0.3).add(0.15))), sin(t.mul(r(9).mul(0.25).add(0.1)).add(1.7)), sin(t.mul(r(10).mul(0.3).add(0.12)).add(4.1))).mul(0.012);
    const p = fract(start.add(vel.mul(t).div(B)));
    return C.add(p.sub(0.5).mul(B)).add(wander);
  })();

  // lit: 1 where the key light reaches the mote, 0 in shadow or outside the shadow box
  const lit = Fn(() => {
    const s = lightShadowMatrix(light).mul(vec4(place, 1));
    const c = s.xyz.div(s.w).toVar();
    const inside = step(0, c.x).mul(step(c.x, 1)).mul(step(0, c.y)).mul(step(c.y, 1)).mul(step(0, c.z)).mul(step(c.z, 1));
    return texture(light.shadow.map.depthTexture, vec2(c.x, c.y.oneMinus())).compare(c.z).r.mul(inside);
  })();

  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  mat.positionNode = place;
  // a mote is a speck of a millimetre or less, drawn a little larger and fainter out of focus
  const blur = clamp(distance(place, U.focus).mul(1.6), 0, 1);
  mat.scaleNode = mix(float(0.0012), float(0.0035), pow(r(11), 2)).mul(blur.mul(0.6).add(1));
  mat.colorNode = Fn(() => {
    const d = length(uv().sub(0.5)).mul(2);
    const disc = smoothstep(1, 0.2, d);
    // flakes turn as they fall and glint when they face the light
    const glint = pow(sin(time.mul(r(12).mul(2).add(0.6)).add(r(13).mul(6.28))).mul(0.5).add(0.5), 3).mul(0.85).add(0.15);
    const fade = smoothstep(0, 0.08, length(place.sub(cameraPosition)).sub(0.15)); // none against the lens
    const seen = step(depth, sceneDepth.sample(screenUV).r);
    const b = lit.mul(seen).mul(glint).mul(fade).mul(U.amount).mul(mix(float(1), float(0.25), blur)).mul(mix(float(0.4), float(1.4), r(14)));
    return vec4(U.color.mul(b).mul(disc), disc.mul(b));
  })();

  const dust = new THREE.Sprite(mat);
  dust.count = count;
  dust.frustumCulled = false;
  dust.renderOrder = 10;
  scene.add(dust);
  return { mesh: dust, U };
}

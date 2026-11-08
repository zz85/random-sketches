/*
 * glass.js - a museum vitrine: a hood of five panes of 6 mm low-iron glass standing on the plinth.
 *
 * The panes are drawn in a pass of their own, after the room, and composited over it, so the scene's
 * depth and normals stay the room's: GTAO and the godrays see through the glass, as the eye does. Thin
 * flat glass barely displaces what is behind it (a 6 mm pane shifts a ray by under 2 mm), so the look is
 * in the light it reflects and absorbs, which each fragment computes:
 *   - Fresnel for two faces of a slab (Schlick, n = 1.5), so a pane is almost invisible face-on and turns
 *     to a mirror at grazing angles;
 *   - reflections of the room from the environment map, and of the key light where the ray toward it
 *     clears the window frame (the same shadow map test the dust uses), so the sun glints off the case;
 *   - absorption along the path through the glass, a faint green face-on and a deep sea-green on the
 *     polished edges, where light runs the length of the sheet: those edge lines are what make glass read;
 *   - a little settled dust on the lid, lit by the beam.
 * The pass's alpha is how much of what is behind a fragment the glass takes away; the composite
 * multiplies the scene by what is left, tints it, and adds the reflections. A fragment behind the piece is
 * hidden by testing its depth against the room pass's depth.
 */
import * as THREE from 'three/webgpu';
import {
  Fn, vec2, vec3, vec4, float, uniform, mix, smoothstep, step, pow, exp, sqrt, abs, max, clamp, dot, normalize, reflect,
  positionWorld, normalWorld, normalLocal, cameraPosition, screenUV, depth, texture, lightShadowMatrix, pmremTexture,
  mx_noise_float,
} from 'three/tsl';

export const PANE = 0.006; // glass thickness, m
export const CASE_HALF = 0.3; // half the case's width, inside the plinth's 0.31

export function buildGlass(scene, { light, envTexture, sceneDepth, base }) {
  const U = {
    keyDir: uniform(new THREE.Vector3(0, 1, 0)), keyColor: uniform(new THREE.Color(1, 1, 1)),
    env: uniform(0.22), fill: uniform(new THREE.Color(0.05, 0.05, 0.06)), tint: uniform(new THREE.Color(0.93, 0.975, 0.955)),
  };
  const lit = Fn(([p]) => {
    const s = lightShadowMatrix(light).mul(vec4(p, 1));
    const c = s.xyz.div(s.w).toVar();
    const inside = step(0, c.x).mul(step(c.x, 1)).mul(step(0, c.y)).mul(step(c.y, 1)).mul(step(0, c.z)).mul(step(c.z, 1));
    return texture(light.shadow.map.depthTexture, vec2(c.x, c.y.oneMinus())).compare(c.z).r.mul(inside);
  });

  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, premultipliedAlpha: true });
  mat.outputNode = Fn(() => {
    const v = normalize(cameraPosition.sub(positionWorld));
    const n = normalize(normalWorld);
    const cosT = clamp(abs(dot(n, v)), 0.001, 1);
    // each pane's local z is its thickness, so the faces whose normal isn't along z are its polished edges
    const edge = step(abs(normalLocal.z), 0.5);
    const f = float(0.04).add(float(0.96).mul(pow(cosT.oneMinus(), 5)));
    const fSlab = f.mul(2).div(f.add(1));
    // the path inside: along the refracted ray through the face, and much longer seen into an edge
    const cosR = sqrt(float(1).sub(cosT.mul(cosT).oneMinus().div(2.25)));
    const tFace = exp(float(-3.4 * PANE).div(cosR));
    const r = reflect(v.negate(), n);
    // the room from the environment map, except where the reflected ray meets the plinth's top, which is
    // drawn as the plaster it is, lit or in shadow: that bright band low in the panes is most of the look
    const tHit = float(base.y).sub(positionWorld.y).div(r.y.min(-0.0001));
    const hit = positionWorld.add(r.mul(tHit));
    const onTop = step(0.0, tHit).mul(step(abs(hit.x), 0.31)).mul(step(abs(hit.z), 0.31)).mul(step(r.y, -0.0001));
    const plaster = vec3(0.74, 0.715, 0.67).mul(U.keyColor.mul(lit(hit.add(vec3(0, 0.002, 0)))).mul(max(U.keyDir.y, 0)).mul(0.8).add(U.fill));
    const room = mix(pmremTexture(envTexture, r, float(0)).rgb.mul(U.env), plaster, onTop);
    const sun = pow(max(dot(r, U.keyDir), 0), 2500).mul(lit(positionWorld)).mul(U.keyColor).mul(30);
    // dust settled on the lid, seen where the beam lights it
    const top = step(0.9, n.y).mul(step(float(base.y + 0.1), positionWorld.y));
    const settled = smoothstep(0.55, 0.9, mx_noise_float(positionWorld.mul(260))).mul(0.5)
      .add(mx_noise_float(positionWorld.mul(9)).mul(0.5).add(0.5).mul(0.25)).mul(top);
    const film = settled.mul(0.05);
    const faceA = float(1).sub(fSlab.oneMinus().mul(tFace)).add(film);
    const faceRGB = room.add(sun).mul(fSlab).add(U.keyColor.mul(lit(positionWorld)).mul(settled).mul(0.035));
    // an edge: a dark sea-green line, lighter where the edge faces the light
    const edgeTint = vec3(0.17, 0.34, 0.3);
    const edgeLight = max(dot(n, U.keyDir), 0).mul(lit(positionWorld)).mul(0.6).add(room.mul(2)).add(0.03);
    const edgeRGB = edgeTint.mul(edgeLight).mul(U.keyColor).add(sun.mul(0.3));
    const a = mix(faceA, float(0.82), edge);
    const rgb = mix(faceRGB, edgeRGB.mul(0.82), edge);
    // behind the piece or the plinth: hidden
    const seen = step(depth, sceneDepth.sample(screenUV).r.add(0.00002));
    return vec4(rgb.mul(seen), a.mul(seen));
  })();

  const group = new THREE.Group(); group.visible = false;
  group.position.copy(base);
  scene.add(group);
  const panes = [];
  for (let i = 0; i < 5; i++) { const m = new THREE.Mesh(new THREE.BufferGeometry(), mat); m.frustumCulled = false; group.add(m); panes.push(m); }

  // the hood: two long sides, two short sides inside them, and the lid on top; H is the outside height
  function resize(H) {
    const W = CASE_HALF * 2, t = PANE, h = H - t;
    const put = (m, w, hh, x, y, z, ry, rx) => {
      m.geometry.dispose(); m.geometry = new THREE.BoxGeometry(w, hh, t);
      m.position.set(x, y, z); m.rotation.set(rx || 0, ry || 0, 0);
    };
    put(panes[0], W, h, 0, h / 2, CASE_HALF - t / 2);
    put(panes[1], W, h, 0, h / 2, -CASE_HALF + t / 2);
    put(panes[2], W - 2 * t, h, CASE_HALF - t / 2, h / 2, 0, Math.PI / 2);
    put(panes[3], W - 2 * t, h, -CASE_HALF + t / 2, h / 2, 0, Math.PI / 2);
    put(panes[4], W, W, 0, H - t / 2, 0, 0, -Math.PI / 2);
    S.height = H;
  }
  const S = { group, U, mat, resize, height: 0.7 };
  resize(0.7);
  return S;
}

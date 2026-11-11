/*
 * caustics.js - a live caustic texture: the light a rippling water surface sends to a wall, as a tileable HDR
 * texture that spot lights project (light.colorNode), the way the Wallace sets were lit: 10K Fresnels aimed into
 * troughs of water, their reflections thrown onto the walls.
 *
 * The water is a sum of travelling waves with whole-number wave vectors, so it tiles the unit square. A grid
 * over the square is drawn into a render target with each vertex moved to where its ray lands, `p + depth *
 * grad(h)` (the small-slope ray offset, the same for reflection and refraction up to the constant), and each
 * fragment adds the light per area, |dA(water)| / |dA(wall)|, from screen-space derivatives. Where neighbouring
 * rays cross, that ratio spikes: the bright caustic lines. Three draws at slightly different depths give the
 * colour fringes of a real one. The texture's mean is 1, so a light's intensity is its average brightness.
 */
import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, vec2, vec3, vec4, float, positionGeometry, varying, dFdx, dFdy, abs, max, min, Loop, sin, cos, sqrt, int } from 'three/tsl';

const WAVES = 12;

export class Caustics {
  /*
   * size: texture size; grid: cells per unit; kMin/kMax: wavelengths, in cycles across the tile;
   * amp: the slope scale (with depth, how sharp the lines are); speed: time scale; dir/spread: where the waves
   * travel (a trough sloshing one way, or ripples every way); disp: the depth spread between red and blue.
   */
  constructor(renderer, { size = 512, grid = 256, kMin = 2, kMax = 7, amp = 1, depth = 0.08, speed = 1, dir = 0, spread = Math.PI, disp = 0.04, seed = 1 } = {}) {
    this.renderer = renderer;
    this.rt = new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, depthBuffer: false, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
    this.rt.texture.wrapS = this.rt.texture.wrapT = THREE.RepeatWrapping;
    this.texture = this.rt.texture;
    this.time = uniform(0); this.depth = uniform(depth); this.amp = uniform(amp);
    this.speed = speed;
    // waves: whole-number wave vectors (k cycles per tile), amplitude ~ 1/k^1.5, deep-water phase speed
    let s = seed * 9301 + 49297;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const K = [], P = [];
    for (let i = 0; i < WAVES; i++) {
      const k = kMin + (kMax - kMin) * rnd() ** 1.3, a = dir + (rnd() * 2 - 1) * spread;
      let kx = Math.round(k * Math.cos(a)), ky = Math.round(k * Math.sin(a));
      if (!kx && !ky) kx = 1;
      const kl = Math.hypot(kx, ky);
      K.push(new THREE.Vector4(kx, ky, 0.9 / kl ** 1.5 / Math.sqrt(WAVES), Math.sqrt(kl) * (0.6 + 0.6 * rnd())));
      P.push(rnd() * Math.PI * 2);
    }
    const waves = uniformArray(K, 'vec4'), phases = uniformArray(P, 'float');
    const grad = Fn(([p]) => {
      const g = vec2(0).toVar();
      Loop(WAVES, ({ i }) => {
        const w = waves.element(i), k = w.xy.mul(Math.PI * 2);
        const ph = k.dot(p).sub(w.w.mul(this.time)).add(phases.element(i));
        g.addAssign(k.mul(w.z.mul(cos(ph))));
      });
      return g.mul(this.amp).mul(1 / (Math.PI * 2));
    });
    // grid over [-0.5, 1.5]^2, so light thrown in from beyond the tile's edges is kept; the camera sees [0, 1]^2
    const n = Math.round(grid * 2);
    const geo = new THREE.PlaneGeometry(2, 2, n, n); geo.translate(0.5, 0.5, 0);
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
    for (const [ch, f] of [[vec3(1, 0, 0), 1 - disp], [vec3(0, 1, 0), 1], [vec3(0, 0, 1), 1 + disp]]) {
      const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      m.blending = THREE.CustomBlending; m.blendSrc = THREE.OneFactor; m.blendDst = THREE.OneFactor; m.blendEquation = THREE.AddEquation;
      const p = positionGeometry.xy;
      const q = p.add(grad(p).mul(this.depth.mul(f)));
      const vP = varying(p), vQ = varying(q);
      m.positionNode = vec3(q, 0);
      m.colorNode = Fn(() => {
        const a = dFdx(vP), b = dFdy(vP), c = dFdx(vQ), d = dFdy(vQ);
        const src = abs(a.x.mul(b.y).sub(a.y.mul(b.x))), dst = max(abs(c.x.mul(d.y).sub(c.y.mul(d.x))), 1e-12);
        return vec4(ch.mul(min(src.div(dst), 60)), 1);
      })();
      const mesh = new THREE.Mesh(geo, m); mesh.frustumCulled = false; this.scene.add(mesh);
    }
  }
  update(t) {
    this.time.value = t * this.speed;
    const r = this.renderer, prev = r.getRenderTarget(), ac = r.autoClear;
    r.setRenderTarget(this.rt); r.setClearColor(0x000000, 0); r.clear(); r.autoClear = false;
    r.render(this.scene, this.cam);
    r.autoClear = ac; r.setRenderTarget(prev);
  }
}

// A spot light whose beam carries a caustic: its colour at each point is the caustic texture at that point's
// place in the beam (scaled, turned and drifting), times `tint`. Shadows come with the spot light.
import { texture, rotateUV, time as T } from 'three/tsl';
export function causticSpot(caustic, { color = 0xffb54a, intensity = 400, angle = 0.5, penumbra = 0.6, scale = 1.5, rot = 0, drift = [0, 0], shadow = 1024, near = 0.5, far = 60, blur = 0 } = {}) {
  const l = new THREE.SpotLight(color, intensity, 0, angle, penumbra, 2);
  l.castShadow = shadow > 0;
  if (shadow) { l.shadow.mapSize.set(shadow, shadow); l.shadow.camera.near = near; l.shadow.camera.far = far; l.shadow.bias = -0.0004; l.shadow.normalBias = 0.02; l.shadow.radius = 2; }
  const sc = uniform(scale), dr = uniform(new THREE.Vector2(...drift));
  l.colorNode = Fn(([coord]) => {
    const uv = rotateUV(coord.xy.sub(0.5), rot, vec2(0)).mul(sc).add(dr.mul(T));
    const c = blur > 0
      ? texture(caustic.texture, uv).add(texture(caustic.texture, uv.add(vec2(blur, 0)))).add(texture(caustic.texture, uv.add(vec2(0, blur)))).add(texture(caustic.texture, uv.sub(vec2(blur, blur)))).mul(0.25)
      : texture(caustic.texture, uv);
    return c.rgb;
  });
  l.userData = { scale: sc, drift: dr };
  return l;
}

// One bounce of a beam, the cheap way (instant radiosity with one virtual light): a dim, unshadowed point light
// just off the surface the beam lands on, in that surface's colour, carrying the share of the beam's flux the
// surface throws back into the room. It warms the ceiling, the floor and the shadows as the real bounce does.
export function bounce(spot, { albedo = 0xb08050, share = 0.05, off = 1.2, distance = 0 } = {}) {
  const p = new THREE.PointLight(new THREE.Color(spot.color).multiply(new THREE.Color(albedo)), spot.intensity * share, distance, 2);
  const to = spot.target.position, d = spot.position.clone().sub(to).normalize();
  p.position.copy(to).addScaledVector(d, off);
  return p;
}

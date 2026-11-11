/*
 * caustics.js - the light of water. Trough (below) lights the sets: a lamp, a real rectangle of water and the
 * rays it bends traced out into the set. Caustics is the cheap kind, a tileable texture of a rippling surface's
 * light, which only paints the office skylight's glow.
 *
 * The water is a sum of travelling waves with whole-number wave vectors, so it tiles the unit square. A grid
 * over the square is drawn into a render target with each vertex moved to where its ray lands, `p + depth *
 * grad(h)` (the small-slope ray offset, the same for reflection and refraction up to the constant), and each
 * fragment adds the light per area, |dA(water)| / |dA(wall)|, from screen-space derivatives. Where neighbouring
 * rays cross, that ratio spikes: the bright caustic lines. Three draws at slightly different depths give the
 * colour fringes of a real one. The texture's mean is 1, so a light's intensity is its average brightness.
 */
import * as THREE from 'three/webgpu';
import { Fn, uniform, uniformArray, vec2, vec3, vec4, float, positionGeometry, positionWorld, varying, dFdx, dFdy, abs, max, min, Loop, sin, cos, sqrt, int, exp, fract, length, If, normalize, reflect, refract, smoothstep, texture, Discard, screenCoordinate, screenUV } from 'three/tsl';

const WAVES = 12;
const DROPS = 8; // splashes in flight at once, each a ring that runs out from where it hit and dies away

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
    this.base = { depth, amp, speed };
    // splashes: (x, y) on the tile, the water's time it hit, its strength; an old one's strength is 0
    this.drops = Array.from({ length: DROPS }, () => new THREE.Vector4(0, 0, -100, 0)); this.nextDrop = 0;
    const drops = this.dropArr = uniformArray(this.drops, 'vec4');
    const grad = Fn(([p]) => {
      const g = vec2(0).toVar();
      Loop(WAVES, ({ i }) => {
        const w = waves.element(i), k = w.xy.mul(Math.PI * 2);
        const ph = k.dot(p).sub(w.w.mul(this.time)).add(phases.element(i));
        g.addAssign(k.mul(w.z.mul(cos(ph))));
      });
      g.mulAssign(this.amp);
      // each splash: a wave packet of 14 cycles a tile on a ring running out at 0.18 tile/s, widening and fading;
      // the distance is taken across the tile's wrap so it tiles too. Only the slope matters: dh/dr along d/r.
      Loop(DROPS, ({ i }) => {
        const D = drops.element(i), age = this.time.sub(D.z);
        If(D.w.greaterThan(0).and(age.greaterThan(0)).and(age.lessThan(8)), () => {
          const d = fract(p.sub(D.xy).add(0.5)).sub(0.5), r = max(length(d), 1e-4);
          const x = r.sub(age.mul(0.18)), w = age.mul(0.03).add(0.03);
          const env = D.w.mul(0.06).mul(exp(age.mul(-0.45))).mul(exp(x.mul(x).div(w.mul(w)).negate())).div(sqrt(r.mul(20).add(1)));
          g.addAssign(d.div(r).mul(sin(x.mul(Math.PI * 2 * 14)).mul(env).mul(-Math.PI * 2 * 14)));
        });
      });
      return g.mul(1 / (Math.PI * 2));
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
  // a splash at (x, y) on the tile (wrapped), of the given strength
  splash(x, y, strength = 1) {
    const d = this.drops[this.nextDrop]; this.nextDrop = (this.nextDrop + 1) % DROPS;
    d.set(x - Math.floor(x), y - Math.floor(y), this.time.value, strength);
  }
  // t: the water's own clock in seconds (main.js runs it faster or slower with the Speed control)
  update(t) {
    this.time.value = t * this.speed;
    const r = this.renderer, prev = r.getRenderTarget(), ac = r.autoClear;
    r.setRenderTarget(this.rt); r.setClearColor(0x000000, 0); r.clear(); r.autoClear = false;
    r.render(this.scene, this.cam);
    r.autoClear = ac; r.setRenderTarget(prev);
  }
}

/*
 * Trough - one lamp and the water it lights the room through, traced in 3D: the way the Wallace sets were lit.
 *
 * The water is a real rectangle in the set: a trough on the floor that a low lamp shines down into (`reflect`),
 * or a glass tank over an opening that a lamp shines down through (`refract`). The spot light that carries the
 * pattern sits where the light seems to come from: the lamp itself for a tank, or the lamp's mirror image under
 * the water for a trough. Its shadow map, its cone and its falloff are then the real ones, and the light leaves
 * through the water's outline alone.
 *
 * Each frame, a grid over the water sends one ray per vertex: from the lamp to the vertex, bent by the wave's
 * normal there (Snell, or the mirror law), out to whatever it hits. The hit comes from a map of the set seen from
 * the source (each texel the world position there, made once, as the set doesn't move), read at the bent ray's
 * landing, twice, so each ray goes as far as the wall, stair or frame it really lands on. The grid is drawn where
 * its rays land, in the light's own projection, and each fragment adds the flat water's footprint area over the
 * wavy water's (screen-space derivatives), so a flat trough gives 1 over its footprint and waves bunch it into
 * lines. So the pattern stretches along the throw, fans out of the water's shape, is soft on what is near the
 * water and sharp on what is far, and each surface the beam meets gets its own focus.
 */
export class Trough {
  /*
   * mode: 'reflect' (a trough below its lamp) or 'refract' (a tank above the room);
   * at: the water's centre; size: [along T, along B] in metres; turn: the turn of T about the up axis;
   * from: where the light seems to come from (the mirror image of the lamp for 'reflect', the lamp for 'refract');
   * lux: the light's strength at the centre of its footprint (intensity = lux * distance^2);
   * waves: lMin/lMax wavelengths in metres, slope (rms), dir/spread (radians in the water's frame), speed (time
   * scale, 1 = real water), slosh (the slope of the trough's sloshing mode); disp: red/blue throw spread;
   * res: the traced texture's texels (res x res, shaped to the footprint); cell: texels per grid cell of rays;
   * near/far: the light's camera; blur: texels per tap of the lamp-size blur; soft: the lamp's size, as how much it rounds the folds' peaks (peak 1 / soft).
   */
  constructor(renderer, {
    mode = 'reflect', at = [0, 0, 0], size = [2, 1], turn = 0, from, color = 0xffb840, lux = 6, lMin = 0.05, lMax = 0.3, slope = 0.03, dir = 0, spread = Math.PI,
    speed = 0.3, slosh = 0.01, disp = mode === 'reflect' ? 0 : 0.03, cell = 4, res = 1024, posRes = 384, shadow = 1024, near = 0.3, far = 60, seed = 1, edge = 0.03, eta = 1.333, soft = 0.035, blur = 0.8,
  } = {}) {
    this.renderer = renderer; this.mode = mode; this.lux = lux;
    this.C = new THREE.Vector3(...at);
    this.T = new THREE.Vector3(Math.cos(turn), 0, -Math.sin(turn)); this.N = new THREE.Vector3(0, 1, 0); this.B = new THREE.Vector3().crossVectors(this.N, this.T).negate();
    this.size = new THREE.Vector2(...size);
    this.E = new THREE.Vector3(...from);
    const side = this.E.clone().sub(this.C).dot(this.N);
    // the lamp: for a trough, the mirror image of `from` in the water; for a tank, `from` itself
    this.lamp = mode === 'reflect' ? this.E.clone().addScaledVector(this.N, -2 * side) : this.E.clone();
    if (mode === 'reflect' && side >= 0) throw new Error('trough: the source must be under the water');
    if (mode === 'refract' && side <= 0) throw new Error('tank: the lamp must be over the water');
    this.room = this.N.clone().multiplyScalar(mode === 'reflect' ? 1 : -1); // the side the light goes out to

    // the light, at the source, aimed through the water's centre, with a cone just wide enough for the water
    const l = this.light = new THREE.SpotLight(color, 1, 0, 0.5, 0.05, 2);
    l.position.copy(this.E); l.target.position.copy(this.C);
    const axis = this.C.clone().sub(this.E).normalize();
    let ang = 0;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const q = this.C.clone().addScaledVector(this.T, a * size[0] / 2).addScaledVector(this.B, b * size[1] / 2);
      ang = Math.max(ang, q.sub(this.E).normalize().angleTo(axis));
    }
    l.angle = Math.min(1.45, ang * 1.3 + 0.05); l.penumbra = 0.2; // wide enough that the cone never cuts the traced light, which the water's own outline bounds
    l.castShadow = shadow > 0;
    if (shadow) { l.shadow.mapSize.set(shadow, shadow); l.shadow.camera.near = near; l.shadow.camera.far = far; l.shadow.bias = -0.0004; l.shadow.normalBias = 0.02; l.shadow.radius = 2; }
    l.shadow.camera.near = near; l.shadow.camera.far = far;

    // The traced light is kept in a projection of its own from the source, fitted to the water's footprint (a
    // wide, short trapezoid for a trough seen low), not to the round cone, so its texels go where the light is.
    const cam = this.cam2 = new THREE.PerspectiveCamera(60, 1, near, far);
    cam.position.copy(this.E); cam.lookAt(this.C); cam.updateMatrixWorld();
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => this.C.clone().addScaledVector(this.T, a * size[0] / 2).addScaledVector(this.B, b * size[1] / 2));
    const view = (q) => q.clone().applyMatrix4(cam.matrixWorldInverse);
    let cx = 0, cy = 0; for (const q of corners) { const v = view(q); cx += v.x / -v.z / 4; cy += v.y / -v.z / 4; }
    cam.lookAt(new THREE.Vector3(cx, cy, -1).applyMatrix4(cam.matrixWorld)); cam.updateMatrixWorld();
    // an off-centre frustum around the footprint's tangents (setViewOffset, so a renderer's own update keeps it)
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const q of corners) { const v = view(q), a = v.x / -v.z, b = v.y / -v.z; x0 = Math.min(x0, a); x1 = Math.max(x1, a); y0 = Math.min(y0, b); y1 = Math.max(y1, b); }
    const mx = (x1 - x0) * 0.08 + 0.02, my = (y1 - y0) * 0.08 + 0.02; // room for light the waves throw past the flat footprint
    x0 -= mx; x1 += mx; y0 -= my; y1 += my;
    const TX = Math.max(-x0, x1), TY = Math.max(-y0, y1), PX = 1000;
    cam.fov = 2 * Math.atan(TY) * 180 / Math.PI; cam.aspect = TX / TY;
    cam.setViewOffset(2 * TX * PX, 2 * TY * PX, (x0 + TX) * PX, (TY - y1) * PX, (x1 - x0) * PX, (y1 - y0) * PX);
    cam.updateProjectionMatrix(); cam.aspect = (x1 - x0) / (y1 - y0); // (the aspect of the window, for the texture's size)
    // shaped like the footprint (a trough seen low is wide and short), its short side `res` texels so the light
    // has as many across the walls' height as along them, its long side at most 3 res
    const rw = cam.aspect >= 1 ? Math.min(3 * res, Math.round(res * cam.aspect)) : res, rh = cam.aspect >= 1 ? res : Math.min(3 * res, Math.round(res / cam.aspect));
    // mipmapped, so a wall far off or seen at a slant averages lines thinner than its pixels instead of catching
    // them on some pixels and not others (which beads the lines' edges)
    this.rt = new THREE.RenderTarget(rw, rh, { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true });
    // The traced light is then blurred a little, by the lamp's size: the ray grid's folds end on its triangles'
    // edges, a sawtooth a cell long that a near wall magnifies into beads along every bright line; a real lamp's
    // own size softens a fold's edge by about as much.
    const rtOpt = { type: THREE.HalfFloatType, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter };
    this.rtH = new THREE.RenderTarget(rw, rh, rtOpt);
    this.rtOut = this.rt; // the vertical pass writes back over the trace, so a lamp holds two targets, not three
    this.texture = this.rt.texture; this.texture.anisotropy = 4;
    const blurPass = (src, dx, dy) => {
      const m = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
      m.fragmentNode = Fn(() => {
        const u = screenUV, o = vec2(dx / rw, dy / rh).mul(blur), c = vec3(0).toVar();
        for (const [k, w] of [[-2, 0.06], [-1, 0.24], [0, 0.4], [1, 0.24], [2, 0.06]]) c.addAssign(texture(src.texture, u.add(o.mul(k))).level(0).rgb.mul(w));
        return vec4(c, 1);
      })();
      const sc = new THREE.Scene(); const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m); q.frustumCulled = false; sc.add(q); return sc;
    };
    this.blurH = blurPass(this.rt, 1, 0); this.blurV = blurPass(this.rtH, 0, 1); this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    const pw = Math.max(32, Math.round(posRes * rw / res)), ph = Math.max(32, Math.round(posRes * rh / res));
    this.posRT = new THREE.RenderTarget(pw, ph, { type: THREE.HalfFloatType, depthBuffer: true, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
    this.M = uniform(new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(cam.projectionMatrix).multiply(cam.matrixWorldInverse));
    this.Linv = uniform(new THREE.Matrix4()); // the spot's own projection, undone (its colorNode gets that place)
    this.time = uniform(0); this.depth = uniform(1); this.amp = uniform(1); this.scale = uniform(1);
    this.speed = speed; this.base = { depth: 1, amp: 1, speed };

    // waves, in the water's frame in metres: log-uniform wavelengths, slope amplitude ~ k^-1/2, scaled to an rms
    // slope; gravity-capillary dispersion (deep water), slowed by `speed`
    let s = seed * 9301 + 49297;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const K = [], P = []; let ss = 0;
    for (let i = 0; i < WAVES; i++) {
      const lam = lMin * (lMax / lMin) ** rnd(), k = 2 * Math.PI / lam, a = dir + (rnd() * 2 - 1) * spread;
      const sl = k ** -0.5; ss += sl * sl / 2;
      K.push(new THREE.Vector4(k * Math.cos(a), k * Math.sin(a), sl, Math.sqrt(9.81 * k + 0.074 / 1000 * k ** 3) * (0.85 + 0.3 * rnd())));
      P.push(rnd() * Math.PI * 2);
    }
    for (const w of K) w.z *= slope / Math.sqrt(ss);
    const waves = uniformArray(K, 'vec4'), phases = uniformArray(P, 'float');
    const kSl = Math.PI / size[1], wSl = Math.sqrt(9.81 * kSl * Math.tanh(kSl * 0.25));
    this.drops = Array.from({ length: DROPS }, () => new THREE.Vector4(0, 0, -100, 0)); this.nextDrop = 0;
    const drops = uniformArray(this.drops, 'vec4');
    const Lref = Math.max(size[0], size[1]), sizeU = uniform(this.size);

    // the water's slope at (x metres in its frame, g in [0, 1]^2)
    const slopeAt = Fn(([x, g]) => {
      const out = vec2(0).toVar(), xs = x.mul(this.scale);
      Loop(WAVES, ({ i }) => {
        const w = waves.element(i);
        const ph = w.xy.dot(xs).sub(w.w.mul(this.time)).add(phases.element(i));
        out.addAssign(normalize(w.xy).mul(w.z.mul(sin(ph))));
      });
      out.y.addAssign(sin(g.y.mul(Math.PI)).mul(cos(this.time.mul(wSl))).mul(slosh)); // the trough's slosh
      out.mulAssign(this.amp);
      // each splash: a ring of 14 cycles across the water, running out and fading, as in Caustics
      Loop(DROPS, ({ i }) => {
        const D = drops.element(i), age = this.time.div(this.speed).sub(D.z);
        If(D.w.greaterThan(0).and(age.greaterThan(0)).and(age.lessThan(8)), () => {
          const d = g.sub(D.xy).mul(sizeU).div(Lref), r = max(length(d), 1e-4);
          const xr = r.sub(age.mul(0.18)), wd = age.mul(0.03).add(0.03);
          const env = D.w.mul(0.12).mul(exp(age.mul(-0.45))).mul(exp(xr.mul(xr).div(wd.mul(wd)).negate())).div(sqrt(r.mul(20).add(1)));
          out.addAssign(d.div(r).mul(sin(xr.mul(Math.PI * 2 * 14)).mul(env)));
        });
      });
      return out;
    });
    const Cu = uniform(this.C), Tu = uniform(this.T), Bu = uniform(this.B), Nu = uniform(this.N), Lu = uniform(this.lamp);
    const proj = (P) => { const h = this.M.mul(vec4(P, 1)); return h.xy.div(h.w); };
    // the set's world position seen along the source's projection (y flipped: a render target's rows run down)
    const posAt = (u) => texture(this.posRT.texture, vec2(u.x, u.y.oneMinus())).level(0);
    const far0 = float(far * 0.5);
    const reach = (p, u) => { const R = posAt(u); return R.w.greaterThan(0.5).select(length(R.xyz.sub(p)), far0); };
    // The same, blended between the four texels around u, so a ray's throw changes smoothly and its landing
    // doesn't step from texel to texel; but only where the four lie on one surface (their distances within 6% of
    // each other), so an edge between a wall and the floor far behind it isn't blurred into a distance neither has.
    const posSize = uniform(new THREE.Vector2(pw, ph));
    const reachSmooth = (p, u) => {
      const f = vec2(u.x, u.y.oneMinus()).mul(posSize).sub(0.5), i = f.floor(), w = f.sub(i);
      const at = (dx, dy) => { const R = texture(this.posRT.texture, i.add(vec2(dx + 0.5, dy + 0.5)).div(posSize)).level(0); return R.w.greaterThan(0.5).select(length(R.xyz.sub(p)), far0); };
      const a = at(0, 0), b = at(1, 0), c = at(0, 1), d = at(1, 1);
      const lo = min(min(a, b), min(c, d)), hi = max(max(a, b), max(c, d));
      const blend = a.mul(w.x.oneMinus()).add(b.mul(w.x)).mul(w.y.oneMinus()).add(c.mul(w.x.oneMinus()).add(d.mul(w.x)).mul(w.y));
      return hi.sub(lo).lessThan(lo.mul(0.06)).select(blend, reach(p, u));
    };

    // The grid is laid out evenly over the light's own projection (not over the water), each vertex the point of
    // the water its ray crosses, so the rays are as dense on the far wall as near the source and no facet shows.
    // about one ray cell every `cell` texels, so its facets stay below what a wall shows
    const nx = Math.max(32, Math.round(rw / cell)), ny = Math.max(32, Math.round(rh / cell));
    const Minv = uniform(this.M.value.clone().invert()), Eu = uniform(this.E);
    const geo = new THREE.PlaneGeometry(1, 1, nx, ny); geo.translate(0.5, 0.5, 0);
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(0, 1, 1, 0, -1, 1);
    // a mirror doesn't split colours: one draw; a tank does, a little: three, at slightly different throws
    const passes = disp > 0 ? [[vec3(1, 0, 0), 1 - disp], [vec3(0, 1, 0), 1], [vec3(0, 0, 1), 1 + disp]] : [[vec3(1, 1, 1), 1]];
    for (const [ch, f] of passes) {
      const mt = new THREE.MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      mt.blending = THREE.CustomBlending; mt.blendSrc = THREE.OneFactor; mt.blendDst = THREE.OneFactor; mt.blendEquation = THREE.AddEquation;
      // one ray: from the source through the water at grid place uv, bent, thrown to the surface it lands on
      const land = (uv) => {
        const Q = Minv.mul(vec4(uv, 0.5, 1)), dq = Q.xyz.div(Q.w).sub(Eu);
        const p = Eu.add(dq.mul(Cu.sub(Eu).dot(Nu).div(dq.dot(Nu))));
        const x = vec2(p.sub(Cu).dot(Tu), p.sub(Cu).dot(Bu)), g = x.div(sizeU).add(0.5);
        const sl = slopeAt(x, g);
        const nrm = normalize(Nu.sub(Tu.mul(sl.x)).sub(Bu.mul(sl.y)));
        const I = normalize(p.sub(Lu));
        const d = mode === 'reflect' ? reflect(I, nrm) : refract(refract(I, nrm, 1 / eta), Nu, eta);
        const thr = this.depth.mul(f);
        const D0 = reach(p, uv); // the flat water's ray lands where uv is in the projection
        const D1 = reachSmooth(p, proj(p.add(d.mul(D0.mul(thr)))));
        const D2 = reachSmooth(p, proj(p.add(d.mul(D1.mul(thr)))));
        return { u: proj(p.add(d.mul(D2.mul(thr)))), g };
      };
      // The light per area is the flat footprint's area over the landed one: the inverse of the map's Jacobian
      // determinant. It is taken at each vertex, from two more rays half a cell along each grid axis, and the
      // signed determinant is interpolated across each triangle, so the brightness changes smoothly from vertex to
      // vertex and a fold (where the determinant passes through 0) falls as a sharp line inside a triangle, not
      // along its edges.
      const uv = positionGeometry.xy, h = vec2(0.5 / nx, 0.5 / ny);
      const r0 = land(uv), rx = land(uv.add(vec2(h.x, 0))), ry = land(uv.add(vec2(0, h.y)));
      const jx = rx.u.sub(r0.u).div(h.x), jy = ry.u.sub(r0.u).div(h.y);
      const det = jx.x.mul(jy.y).sub(jx.y.mul(jy.x));
      const vDet = varying(det), vG = varying(r0.g), vA = varying(uv), vB = varying(r0.u);
      mt.positionNode = vec3(r0.u, 0);
      mt.colorNode = Fn(() => {
        const rim = smoothstep(0, edge, vG.x).mul(smoothstep(0, edge, vG.x.oneMinus())).mul(smoothstep(0, edge, vG.y)).mul(smoothstep(0, edge, vG.y.oneMinus()));
        // a lamp isn't a point: its size rounds the fold's peak off over a few texels instead of a spike a texel
        // wide, which a wall would catch on some pixels and miss on others
        // ... and never more than twice the triangle's own area ratio, which conserves the light exactly: a vertex
        // whose determinant happens to be near 0 on a triangle that isn't folded would light it up as a bead
        const a = dFdx(vA), b = dFdy(vA), c = dFdx(vB), e = dFdy(vB);
        const tri = abs(a.x.mul(b.y).sub(a.y.mul(b.x))).div(max(abs(c.x.mul(e.y).sub(c.y.mul(e.x))), 1e-14));
        return vec4(ch.mul(min(float(1).div(sqrt(vDet.mul(vDet).add(soft * soft))), tri.mul(2)).mul(rim)), 1);
      })();
      const mesh = new THREE.Mesh(geo, mt); mesh.frustumCulled = false; this.scene.add(mesh);
    }

    // the spot light's colour: the traced pattern at each point's place in its projection
    const tex = this.texture;
    // (the spot hands over its own projected place; that gives the ray from the source, which this projection takes)
    l.colorNode = Fn(([coord]) => {
      const w = this.Linv.mul(vec4(coord.xy, 0.5, 1)), u = proj(w.xyz.div(w.w));
      const inside = u.x.greaterThan(0).and(u.x.lessThan(1)).and(u.y.greaterThan(0)).and(u.y.lessThan(1));
      return inside.select(texture(tex, vec2(u.x, u.y.oneMinus())).rgb, vec3(0));
    });
    l.userData = { trough: this };

    // the map of the set from the source: world positions, past the water only
    const pm = this.posMat = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    const Ru = uniform(this.room);
    pm.fragmentNode = Fn(() => {
      Discard(positionWorld.sub(Cu).dot(Ru).lessThan(0.005));
      return vec4(positionWorld, 1);
    })();
  }

  // Make the position map and fix the light's strength and aim, once the set is built (group: the set's root,
  // not yet in the main scene). Synchronous apart from the GPU work.
  bake(group) {
    const l = this.light, r = this.renderer;
    group.updateMatrixWorld(true);
    const tmp = new THREE.Scene(); const parent = group.parent; tmp.add(group); tmp.overrideMaterial = this.posMat;
    const prev = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(this.posRT); r.setClearColor(0x000000, 0); r.clear(); r.render(tmp, this.cam2);
    r.setRenderTarget(prev); r.setClearColor(cc, ca);
    tmp.remove(group); if (parent) parent.add(group);
    // the centre of the footprint: the light's strength there, and its aim (the bounce light sits by it)
    const ray = new THREE.Raycaster(this.E, this.C.clone().sub(this.E).normalize(), 0, l.shadow.camera.far);
    const hit = ray.intersectObject(group, true).find((h) => h.object.isMesh && h.point.clone().sub(this.C).dot(this.room) > 0.01);
    const D = hit ? hit.distance : 10;
    this.hit = hit?.point.clone() ?? this.C.clone().addScaledVector(this.C.clone().sub(this.E).normalize(), 10);
    l.intensity = this.lux * D * D;
    l.target.position.copy(this.hit); l.target.updateMatrixWorld();
    l.shadow.updateMatrices(l); this.Linv.value.copy(l.shadow.matrix).invert();
    this.baked = true;
  }

  // where on the water (in [0, 1]^2) the light that reaches world point P left it, for flat water; null if none
  waterUV(P) {
    const d = P.clone().sub(this.E), den = d.dot(this.N);
    if (Math.abs(den) < 1e-6) return null;
    const t = this.C.clone().sub(this.E).dot(this.N) / den;
    if (t <= 0 || t >= 1) return null;
    const q = this.E.clone().addScaledVector(d, t).sub(this.C);
    const u = q.dot(this.T) / this.size.x + 0.5, v = q.dot(this.B) / this.size.y + 0.5;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1 ? [u, v] : null;
  }
  splash(x, y, strength = 1) {
    const d = this.drops[this.nextDrop]; this.nextDrop = (this.nextDrop + 1) % DROPS;
    d.set(Math.min(1, Math.max(0, x - Math.floor(x))), Math.min(1, Math.max(0, y - Math.floor(y))), this.time.value / this.speed, strength);
  }
  update(t) {
    this.time.value = t * this.speed;
    const r = this.renderer, prev = r.getRenderTarget(), ac = r.autoClear;
    r.setRenderTarget(this.rt); r.setClearColor(0x000000, 0); r.clear(); r.autoClear = false;
    r.render(this.scene, this.cam);
    r.setRenderTarget(this.rtH); r.render(this.blurH, this.quadCam);
    r.setRenderTarget(this.rtOut); r.render(this.blurV, this.quadCam);
    r.autoClear = ac; r.setRenderTarget(prev);
  }

  // for the smoke test: the position map read at these places of the light's projection, by a tiny pass, so
  // nothing depends on which way a backend reads rows back
  async probe(uvs) {
    const N = uvs.length, rt = new THREE.RenderTarget(N, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    const arr = uniformArray(uvs.map(([u, v]) => new THREE.Vector2(u, v)), 'vec2');
    const m = new THREE.MeshBasicNodeMaterial();
    m.fragmentNode = Fn(() => { const u = arr.element(int(screenCoordinate.x)); return texture(this.posRT.texture, vec2(u.x, u.y.oneMinus())).level(0); })();
    const sc = new THREE.Scene(); sc.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1), r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(rt); r.render(sc, cam); r.setRenderTarget(prev);
    const px = await r.readRenderTargetPixelsAsync(rt, 0, 0, N, 1); rt.dispose();
    const h = (i) => THREE.DataUtils.fromHalfFloat(px[i]);
    return uvs.map((_, i) => [h(i * 4), h(i * 4 + 1), h(i * 4 + 2), h(i * 4 + 3)]);
  }
}

// The classic way (the first version, kept as a mode): a spot light whose beam carries a tiled Caustics texture: its colour at each point is the caustic texture at that point's
// place in the beam (scaled, turned and drifting), times `tint`. Shadows come with the spot light.
import { rotateUV, time as T } from 'three/tsl';
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
  l.userData = { caustic, scale: sc, scale0: scale, drift: dr, rot };
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

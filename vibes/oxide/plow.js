// plow.js - Oxide: Listen. The sound is a plow that works the steel where the camera goes. Its blade lies
// across the way the camera moves, TW cm wide, on the ground the camera looks at; the spectrum is laid along
// it mirrored from the middle (the lows in the middle), smoothed across the bands and in time. Middling
// bands corrode: they cut a furrow, eat the paint back to rust and throw up specks of rust dust. The
// loudest bands heal: paint grows back over rust and over the furrow. What it does stays: the trail is kept,
// signed (cut above 0, regrown paint below), in a texture SPAN cm square that surface.js reads.
import * as THREE from 'three/webgpu';
import { Fn, instancedArray, instanceIndex, uniform, float, int, vec2, vec3, vec4, ivec2, texture, textureStore, smoothstep, mix, abs, max, clamp, select,
  hash, dot, length, exp, floor, fract, sin, cos, positionLocal, varying, time, mx_noise_vec3, mx_noise_float, min } from 'three/tsl';
import { BANDS } from './audio.js';

export const SPAN = 64, DEPTH = 0.035, TW = 1.4; // cm: the trail's square, the deepest cut, the blade's width
const R = 160; // texels a side of the square the blade is stamped into each frame

// a smooth (cubic B-spline) read of the trail, from four bilinear reads, so the cut's slopes have no texel facets
export const trailSmooth = (T, p) => {
  const n = float(T.N), st = p.div(SPAN).add(0.5).mul(n).sub(0.5), i = floor(st), f = fract(st), g = float(1).sub(f);
  const w0 = g.mul(g).mul(g).div(6), w1 = f.mul(f).mul(f.mul(3).sub(6)).add(4).div(6), w3 = f.mul(f).mul(f).div(6), w2 = float(1).sub(w0).sub(w1).sub(w3);
  const g0 = w0.add(w1), g1 = w2.add(w3), h0 = i.sub(0.5).add(w1.div(g0)).div(n), h1 = i.add(1.5).add(w3.div(g1)).div(n);
  const t = (x, y) => texture(T.tex, vec2(x, y)).level(0).x;
  return g0.y.mul(g0.x.mul(t(h0.x, h0.y)).add(g1.x.mul(t(h1.x, h0.y)))).add(g1.y.mul(g0.x.mul(t(h0.x, h1.y)).add(g1.x.mul(t(h1.x, h1.y)))));
};
export const trailAt = (T, p) => texture(T.tex, p.div(SPAN).add(0.5)).level(0).x;

export function makePlow(field, L, { N = 2048, dust = 12000 } = {}) {
  const buf = instancedArray(N * N, 'float');
  const tex = new THREE.StorageTexture(N, N); tex.type = THREE.HalfFloatType; tex.format = THREE.RGBAFormat; tex.magFilter = tex.minFilter = THREE.LinearFilter;
  const lvData = new Uint16Array(BANDS * 4), lvTex = new THREE.DataTexture(lvData, BANDS, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  lvTex.magFilter = lvTex.minFilter = THREE.LinearFilter; lvTex.needsUpdate = true;
  const U = { a: uniform(new THREE.Vector2()), b: uniform(new THREE.Vector2()), perp: uniform(new THREE.Vector2(1, 0)), fwd: uniform(new THREE.Vector2(0, 1)),
    o: uniform(new THREE.Vector2()), k: uniform(0), on: uniform(0), dt: uniform(0), frame: uniform(0) };
  const T = { N, tex, U };
  const level = (across) => texture(lvTex, vec2(abs(across).div(TW / 2).clamp(0, 1).mul((BANDS - 1) / BANDS).add(0.5 / BANDS), 0.5)).level(0).x;

  // the blade, swept from where it was last frame to where it is, eased into what is cut already
  const stamp = Fn(() => {
    const x = U.o.x.add(float(instanceIndex.mod(R))).clamp(0, N - 1), y = U.o.y.add(float(instanceIndex.div(R))).clamp(0, N - 1);
    const p = vec2(x.add(0.5), y.add(0.5)).div(N).sub(0.5).mul(SPAN);
    const ab = U.a.sub(U.b), s = clamp(dot(p.sub(U.b), ab).div(max(dot(ab, ab), 1e-8)), 0, 1);
    const d = p.sub(U.b.add(ab.mul(s))), across = dot(d, U.perp), along = length(d.sub(U.perp.mul(across)));
    // ragged edges and a depth that wanders, from noise on the steel and in time, so no two passes match
    const n1 = mx_noise_float(vec3(p.mul(5.5), time.mul(0.25))), n2 = mx_noise_float(vec3(p.mul(1.7), time.mul(0.07).add(3)));
    const half = float(TW / 2).mul(n2.mul(0.25).add(0.9));
    const prof = smoothstep(1, 0.7, abs(across).add(n1.mul(0.08)).div(half)).mul(exp(along.div(0.07).pow(2).negate())).mul(U.on);
    const lv = level(across);
    const heal = smoothstep(0.5, 0.75, lv);                                // the loudest: paint grows back
    const cor = smoothstep(0.06, 0.4, lv).mul(float(1).sub(heal)).mul(n1.mul(0.35).add(n2.mul(0.25)).add(0.85).clamp(0.3, 1.4));
    const idx = int(y).mul(N).add(int(x)), old = buf.element(idx);
    const cut = old.add(max(cor.mul(prof).sub(old), 0).mul(U.k).mul(select(old.lessThan(0), float(0.12), float(1)))); // new paint is slow to rot again
    const nw = mix(cut, heal.negate(), heal.mul(prof).mul(U.k).mul(2.5).clamp(0, 1)).clamp(-1, 1.4);
    buf.element(idx).assign(nw);
    textureStore(tex, ivec2(int(x), int(y)), vec4(nw, 0, 0, 0));
  })().compute(R * R);
  const clear = Fn(() => {
    buf.element(instanceIndex).assign(0);
    textureStore(tex, ivec2(int(instanceIndex.mod(N)), int(instanceIndex.div(N))), vec4(0));
  })().compute(N * N);

  // specks of rust dust: born on the blade where it is loud, they float up a little, drift and fade
  const P = instancedArray(dust, 'vec4'), V = instancedArray(dust, 'vec4'); // field x, y, height, life; velocity
  const dustK = Fn(() => {
    const i = instanceIndex, fi = float(i), p = P.element(i), v = V.element(i), dead = p.w.lessThanEqual(0);
    const s1 = hash(fi.mul(1.31).add(U.frame.mul(0.618))), s2 = hash(fi.mul(2.17).add(U.frame.mul(0.414)).add(7)), s3 = hash(fi.mul(5.03).add(U.frame.mul(0.291)).add(13));
    const across = s1.sub(0.5).mul(TW * 0.9), q = U.a.add(U.perp.mul(across)).add(U.fwd.mul(s2.sub(0.5).mul(0.06)));
    const lr = level(across), lv = smoothstep(0.15, 0.4, lr).mul(smoothstep(0.6, 0.45, lr));
    const born = s3.lessThan(lv.mul(lv).mul(U.on).mul(0.03));
    const gy = field.sample(field.texH, q, false).x.sub(trailAt(T, q).max(0).mul(DEPTH));
    const p0 = vec4(q.x, q.y, gy, s2.mul(1.8).add(0.8));
    const v0 = vec4(U.perp.mul(s1.sub(0.5).mul(0.03)).add(U.fwd.mul(s3.mul(0.02))), s2.mul(0.04).add(0.015), 0);
    const tb = mx_noise_vec3(p.xyz.mul(30).add(vec3(0, 0, time.mul(0.4)))).mul(0.015);
    const nv = v.xyz.add(tb.sub(v.xyz.mul(1.4)).add(vec3(0, 0, -0.004)).mul(U.dt));
    const p1 = vec4(p.xyz.add(nv.mul(U.dt)), p.w.sub(U.dt));
    P.element(i).assign(select(dead, select(born, p0, p), p1)); V.element(i).assign(select(dead, select(born, v0, v), vec4(nv, 0)));
  })().compute(dust);
  const dustMesh = (() => {
    const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, flatShading: true });
    const fi = float(instanceIndex), pp = P.element(instanceIndex), r1 = hash(fi.mul(3.7).add(1)), r2 = hash(fi.mul(6.1).add(2));
    const sz = r1.mul(r1).mul(0.0006).add(0.00025).mul(smoothstep(0, 0.5, pp.w)).mul(select(pp.w.greaterThan(0), float(1), float(0)));
    m.positionNode = Fn(() => {
      const a = r2.mul(6.283).add(time.mul(r1.sub(0.5).mul(3))), l = positionLocal.mul(sz);
      return pp.xyz.add(vec3(l.x.mul(cos(a)).sub(l.y.mul(sin(a))), l.x.mul(sin(a)).add(l.y.mul(cos(a))), l.z));
    })();
    m.colorNode = varying(mix(L.powderCol, L.rA, r2.mul(0.6)), 'vSpeck');
    m.emissiveNode = varying(L.rA.mul(0.12), 'vSpeckE');
    const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(1, 0), m);
    mesh.count = dust; mesh.frustumCulled = false;
    return mesh;
  })();

  // each frame: the blade where the camera looks, across the way it moves; the levels smoothed across bands and in time
  const sm = new Float32Array(BANDS), heading = new THREE.Vector2(0, 1), last = new THREE.Vector2(), vel = new THREE.Vector2();
  let started = false, alive = 0, frame = 0;
  T.update = (renderer, dt, at, look, levels, on) => {
    U.on.value += ((on ? 1 : 0) - U.on.value) * Math.min(1, dt * 1.5);
    if (!started) { last.copy(at); started = true; }
    if (at.distanceTo(last) > 0.5) last.copy(at); // a jump (a new scene or view): no furrow across it
    if (dt > 0) vel.lerp(at.clone().sub(last).divideScalar(dt), 1 - Math.exp(-dt * 2));
    const want = vel.length() > 0.01 ? vel.clone().normalize() : look.clone().normalize();
    heading.lerp(want, 1 - Math.exp(-dt * 1.5)).normalize();
    for (let b = 0; b < BANDS; b++) {
      let s = 0, w = 0; for (let j = -3; j <= 3; j++) { const k = Math.min(BANDS - 1, Math.max(0, b + j)), g = Math.exp(-j * j / 5); s += (levels ? levels[k] : 0) * g; w += g; }
      sm[b] += (s / w - sm[b]) * (1 - Math.exp(-dt / 0.35)); lvData[b * 4] = THREE.DataUtils.toHalfFloat(sm[b]);
    }
    lvTex.needsUpdate = true;
    U.b.value.copy(last); U.a.value.copy(at); last.copy(at);
    U.fwd.value.copy(heading); U.perp.value.set(heading.y, -heading.x);
    U.o.value.set(Math.floor((at.x / SPAN + 0.5) * N) - R / 2, Math.floor((at.y / SPAN + 0.5) * N) - R / 2);
    U.k.value = 1 - Math.exp(-dt * 3); U.dt.value = dt; U.frame.value = frame++ % 4096;
    alive = U.on.value > 0.002 ? 4 : alive - dt;
    if (U.on.value > 0.002 && dt > 0) renderer.compute(stamp);
    dustMesh.visible = alive > 0;
    if (alive > 0 && dt > 0) renderer.compute(dustK);
  };
  T.clear = (renderer) => { renderer.compute(clear); started = false; };
  T.read = async (renderer) => { const a = new Float32Array(await renderer.getArrayBufferAsync(buf.value)); let mx = 0, mn = 0, n = 0, g = 0; for (let i = 0; i < a.length; i++) { if (a[i] > mx) mx = a[i]; if (a[i] < mn) mn = a[i]; if (a[i] > 0.1) n++; if (a[i] < -0.1) g++; } const c = (SPAN / N) ** 2; return { max: mx, min: mn, cut: n * c, grown: g * c }; };
  T.dust = dustMesh; T.levels = sm;
  return T;
}

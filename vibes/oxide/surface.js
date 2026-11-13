// surface.js - Oxide: the look. The landscape is raymarched, a ray for each pixel through the field's height
// textures (field.js), so its detail is as fine as the screen wherever you look and it runs to the horizon:
// marched in steps that grow with the height above the surface and the distance, refined by bisection, then
// shaded here by hand: paint in two tones with chalky weathering, stained where it lifts at its edge; rust
// mottled between a fresh orange and an ochre, purpler or yellower by region, cut into bands where the front
// once stood, darker with age, black-brown in the clumps and bright in the powder at the front, with a few
// glinting crystals. Sunlight with soft shadows marched toward the sun, a sky fill, a dark room in the
// reflections, clearcoat on the paint, cavities darkened, fog. It writes depth, so the grains of powder and
// crumbs and the drops of water (instanced meshes) sit in it and the depth of field reads it.
import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, uniform, varying, positionGeometry, positionLocal, instanceIndex, normalize, mix, smoothstep, clamp, dot, reflect, pow,
  select, exp, fract, floor, hash, max, min, abs, sin, cos, Loop, If, Break, screenUV, cameraPosition, cameraProjectionMatrixInverse, cameraWorldMatrix,
  cameraViewMatrix, cameraNear, cameraFar, viewZToPerspectiveDepth, mx_noise_float, mx_fractal_noise_float, texture, atan, length } from 'three/tsl';
import { coverOf } from './field.js';
import { BANDS, ROWS } from './audio.js';

const COLS = ['paint', 'paint2', 'chalkCol', 'rA', 'rB', 'rC', 'rD', 'rE', 'powderCol'];
export const FOG = 0.16; // FogExp2 density, per cm
export const BG = [0.012, 0.01, 0.009];

export function makeLook() {
  const L = { seed: uniform(0), gloss: uniform(0.4), clear: uniform(0), bandMix: uniform(1), chalk: uniform(0.5), drops: uniform(0), centre: uniform(new THREE.Vector2()),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)), sunCol: uniform(new THREE.Color()), fill: uniform(0.5) };
  for (const k of COLS) L[k] = uniform(new THREE.Color());
  L.set = (p, seed) => {
    for (const k of COLS) L[k].value.setRGB(...p[k]);
    L.gloss.value = p.gloss; L.clear.value = p.clear; L.bandMix.value = p.bandMix; L.chalk.value = p.chalk; L.drops.value = p.drops || 0; L.seed.value = seed % 997;
    L.sunDir.value.set(...p.sun).normalize(); L.sunCol.value.setRGB(...p.sunCol).multiplyScalar(p.sunI); L.fill.value = p.fill;
  };
  return L;
}

const HMAX = 0.16, HMIN = -0.12; // the slab the surface lies in, cm
const fieldXY = (w) => vec2(w.x, w.z.negate()); // world (x, z) to the field's coords

// sound for Listen: the ring of spectrum rows (audio.js), the point the rings spread from, how far a row
// travels, and how much it moves the paint (eased in and out)
export function makeSound(tex) { return { tex, head: uniform(0), emit: uniform(new THREE.Vector2()), dr: uniform(0.006), on: uniform(0) }; }

// the surface at p: height, distance to the paint's edge, cover, and the sound there. Without sound, the
// height the field made; with it, the paint's edge pushed out into the rust and the paint lifted by the
// spectrum, its bands round the circle and its history outward from the centre
const surfAt = (field, S, p, blend) => {
  const H = field.sample(field.texH, p, blend);
  if (!S) return { h: H.x, H, s: H.y, a: float(0), m: null };
  const M = field.sample(field.texM, p, blend), te = field.texelAt(p);
  const d = p.sub(S.emit), r = length(d).add(H.w.mul(0.12)), k = r.div(S.dr).max(0.6);
  const u = abs(atan(d.y, d.x)).div(Math.PI).mul((BANDS - 1) / BANDS).add(0.5 / BANDS);
  const v = S.head.add(0.5).sub(k).div(ROWS);
  const snd = texture(S.tex, vec2(u, v)).level(0);
  const a = snd.x.mul(smoothstep(float(ROWS), float(ROWS * 0.6), k)).mul(S.on);
  const wv = snd.y.mul(smoothstep(float(90), float(20), k)).mul(S.on);
  const s2 = H.y.add(a.mul(0.035)).add(snd.z.mul(0.02).mul(S.on));
  const m0 = coverOf(H.y, te), m2 = coverOf(s2, te.max(0.0015));
  const h = H.x.sub(m0.mul(M.x)).add(m2.mul(M.x)).add(a.mul(0.028).add(wv.mul(0.01)).mul(smoothstep(0.0, 0.05, s2))); // rising inside the paint, not as a wall at its edge
  return { h, H, s: s2, a, m: m2, M };
};

export function terrainMesh(field, L, S = null) {
  const m = new THREE.MeshBasicNodeMaterial();
  m.fog = false; m.depthWrite = true; m.depthTest = true;
  m.vertexNode = vec4(positionGeometry.xy, 0, 1);
  const hAt = (w) => surfAt(field, S, fieldXY(w), false).h;
  const hB = (p) => surfAt(field, S, p, true).h;

  const out = Fn(() => {
    // the ray through this pixel
    const ndc = vec2(screenUV.x.mul(2).sub(1), float(1).sub(screenUV.y.mul(2)));
    const vd = cameraProjectionMatrixInverse.mul(vec4(ndc, 1, 1));
    const rd = normalize(cameraWorldMatrix.mul(vec4(vd.xyz.div(vd.w), 0)).xyz).toVar();
    const ro = cameraPosition;
    const down = rd.y.lessThan(-1e-4);
    const t0 = select(ro.y.greaterThan(HMAX), select(down, ro.y.sub(HMAX).div(rd.y.negate()), float(1e9)), float(0));
    const tEnd = min(float(12), select(down, ro.y.sub(HMIN).div(rd.y.negate().max(1e-4)), float(16)));
    const t = t0.toVar(), tp = t0.toVar(), hit = float(0).toVar();
    If(t0.lessThan(tEnd), () => {
      Loop(160, () => {
        const pw = ro.add(rd.mul(t));
        const d = pw.y.sub(hAt(pw));
        If(d.lessThan(0), () => { hit.assign(1); Break(); });
        tp.assign(t);
        t.addAssign(max(d.mul(0.5), t.mul(0.0016).add(0.0003)));
        If(t.greaterThan(tEnd), () => { Break(); });
      });
    });
    If(hit.greaterThan(0.5), () => {
      Loop(7, () => {
        const tm = t.add(tp).mul(0.5), pw = ro.add(rd.mul(tm));
        If(pw.y.lessThan(hAt(pw)), () => { t.assign(tm); }).Else(() => { tp.assign(tm); });
      });
    });
    const P = ro.add(rd.mul(t)), p = fieldXY(P);
    const BGc = vec3(...BG);

    const SF = surfAt(field, S, p, true), H = SF.H, M = SF.M || field.sample(field.texM, p);
    const cover = SF.m || coverOf(H.y, field.texelAt(p)), powder = M.y, clump = M.z, band = M.w, s = SF.s, age = H.z, hue = H.w;

    // ---- normal: the height texture's slope, and finer than its texels a crust on the rust and an orange
    // peel on the paint, faded out where a pixel covers it
    const e = field.texelAt(p);
    const hx = hB(p.add(vec2(e, 0))).sub(hB(p.sub(vec2(e, 0)))).div(e.mul(2));
    const hy = hB(p.add(vec2(0, e))).sub(hB(p.sub(vec2(0, e)))).div(e.mul(2));
    const fine = smoothstep(3.0, 0.8, t);
    const detail = (q) => mx_fractal_noise_float(vec3(q.mul(260), 6.1), 3, 2.3, 0.6).mul(0.0011).mul(float(1).sub(cover).mul(powder.mul(0.5).add(1)))
      .add(mx_noise_float(vec3(q.mul(170), 3.3)).mul(0.00025).mul(cover));
    const ep = 0.0012, dx = float(0).toVar(), dy = float(0).toVar();
    If(fine.greaterThan(0.001), () => { // fine detail only near the camera
      const d0 = detail(p);
      dx.assign(detail(p.add(vec2(ep, 0))).sub(d0).div(ep).mul(fine)); dy.assign(detail(p.add(vec2(0, ep))).sub(d0).div(ep).mul(fine));
    });
    const Nw = normalize(vec3(hx.add(dx).negate(), 1, hy.add(dy))); // field y is world -z

    // ---- colours
    const n1 = mx_fractal_noise_float(vec3(p.mul(2.2), 3.7).add(vec3(L.seed, 0, 0)), 3, 2, 0.5); // cm
    const n2 = mx_fractal_noise_float(vec3(p.mul(14), 1.9), 3, 2, 0.5); // mm
    const n3 = mx_noise_float(vec3(p.mul(80), 5.5)).mul(fine); // tenth of a mm
    const glint = hash(floor(p.mul(420)).dot(vec2(1, 517)).add(L.seed)).greaterThan(0.988).and(cover.lessThan(0.5)).and(t.lessThan(1.5));

    let paint = mix(L.paint, L.paint2, smoothstep(-0.35, 0.45, n1.add(n2.mul(0.3)).add(hue.mul(0.5))));
    paint = mix(paint, L.chalkCol, smoothstep(0.05, 0.55, n2.add(n3.mul(0.25))).mul(L.chalk).mul(0.7));
    const edge = exp(s.max(0).div(-0.03));
    paint = mix(paint, L.rB.mul(0.45), edge.mul(0.55));                       // rust bleeding into the paint at its edge
    paint = paint.mul(float(1).sub(smoothstep(0.02, 0.0, s).mul(0.4)));      // the lifted lip, in its own shade

    const fb = fract(band), bh = hash(floor(band).add(L.seed.mul(13)));
    const bandC = select(bh.lessThan(0.4), L.rA, select(bh.lessThan(0.75), L.rB, L.rC));
    const soft = smoothstep(0.0, 0.06, fb).mul(smoothstep(1.0, 0.94, fb));    // a thin dark line at each band's edge
    let rust = mix(L.rA, L.rB, smoothstep(-0.35, 0.4, n2.add(n1.mul(0.5))));
    rust = mix(rust, bandC, L.bandMix.mul(smoothstep(0.0, 0.02, age)).mul(0.85));
    rust = rust.mul(mix(float(0.55), float(1), soft.mul(L.bandMix).add(float(1).sub(L.bandMix)).min(1)));
    rust = mix(rust, L.rD, smoothstep(0.1, 0.8, age).mul(n2.mul(0.3).add(0.55)));
    // regions: purple-brown where the hue runs high, a yellow ochre where it runs low
    rust = mix(rust, rust.mul(vec3(0.62, 0.42, 0.62)).add(L.rC.mul(0.4)), smoothstep(0.08, 0.4, hue).mul(0.7));
    rust = mix(rust, vec3(0.62, 0.4, 0.09).mul(dot(rust, vec3(0.5, 0.4, 0.1)).mul(2.2)), smoothstep(-0.08, -0.4, hue).mul(0.6));
    rust = rust.mul(n3.mul(0.35).add(0.85));
    rust = mix(rust, L.rE, clump.mul(0.9));
    rust = mix(rust, L.powderCol.mul(n3.mul(0.4).add(0.9)), powder.mul(float(1).sub(clump.mul(0.6))).min(1));

    const albedo = select(glint, L.rA.mul(1.3), mix(rust, paint, cover));
    const rough = select(glint, float(0.18), mix(float(0.92).sub(powder.mul(0.12)), L.gloss.add(n2.mul(0.08)).add(L.chalk.mul(smoothstep(0.1, 0.6, n2)).mul(0.25)), cover)).clamp(0.05, 1);
    const metal = select(glint, float(0.8), float(0));

    // ---- light
    const V = rd.negate(), Ld = L.sunDir;
    const ndl = max(dot(Nw, Ld), 0);
    // soft shadow, marched toward the sun
    const sh = float(1).toVar(), st = float(0.0015).toVar();
    const so = P.add(Nw.mul(0.0006));
    If(ndl.greaterThan(0).and(t.lessThan(7)), () => { // far off, the fog has it
      Loop(16, () => {
        const q = so.add(Ld.mul(st));
        const d = q.y.sub(hAt(q));
        sh.assign(min(sh, d.mul(14).div(st)));
        st.addAssign(clamp(d.mul(0.7), st.mul(0.25).max(0.002), 0.1));
        If(sh.lessThan(0.005).or(st.greaterThan(1.2)), () => { Break(); });
      });
    });
    const shadow = smoothstep(0, 1, sh.clamp(0, 1)).mul(select(ndl.greaterThan(0), float(1), float(0)));
    const cav = smoothstep(-0.014, 0.006, H.x.sub(field.coarse(p))).mul(0.6).add(0.4);
    const sky = mix(vec3(0.23, 0.12, 0.06), vec3(0.36, 0.6, 0.65), Nw.y.mul(0.5).add(0.5)).mul(L.fill);
    const diffuse = albedo.mul(float(1).sub(metal)).mul(L.sunCol.mul(ndl).mul(shadow).mul(1 / Math.PI).add(sky.mul(cav).mul(0.55)));
    // specular: GGX for the sun, and the dark room with its one bright window for the rest
    const spec = (r, f0) => {
      const h = normalize(Ld.add(V)), nh = max(dot(Nw, h), 0), a2 = r.mul(r).mul(r.mul(r));
      const D = a2.div(nh.mul(nh).mul(a2.sub(1)).add(1).pow(2).mul(Math.PI));
      const F = f0.add(float(1).sub(f0).mul(pow(float(1).sub(max(dot(V, h), 0)), 5)));
      const vis = float(0.25).div(max(dot(Ld, h), 0.2).pow(2));
      const R = reflect(rd, Nw), fe = f0.add(float(1).sub(f0).mul(pow(float(1).sub(max(dot(V, Nw), 0)), 5)).mul(float(1).sub(r)));
      const win = pow(max(dot(R, normalize(vec3(-0.55, 0.62, 0.34))), 0), mix(float(300), float(3), r)).mul(mix(float(5), float(0.15), r));
      const room = mix(vec3(0.03, 0.022, 0.018), vec3(0.18, 0.22, 0.24), smoothstep(-0.1, 0.8, R.y)).add(win).mul(cav);
      return D.mul(vis).mul(F).mul(L.sunCol).mul(ndl).mul(shadow).add(room.mul(fe).mul(0.6));
    };
    const f0 = mix(vec3(0.04), albedo, metal);
    let col = diffuse.add(spec(rough, f0));
    if (S) col = col.add(L.paint2.mul(SF.a.mul(exp(abs(s).div(-0.012))).mul(0.35).add(SF.a.mul(cover).mul(0.05)))); // the moving edge, lit by the sound
    col = col.add(spec(float(0.08), vec3(0.04)).mul(cover.mul(L.clear)));
    // fog, and the dark beyond the steel
    const fogK = exp(t.mul(FOG).pow(2).negate());
    col = mix(BGc, col, fogK);
    const viewZ = cameraViewMatrix.mul(vec4(P, 1)).z;
    return vec4(select(hit.greaterThan(0.5), col, BGc), select(hit.greaterThan(0.5), viewZToPerspectiveDepth(viewZ, cameraNear, cameraFar), float(1)));
  })().toVar('rm');
  m.colorNode = out.xyz;
  m.depthNode = out.w;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
  mesh.frustumCulled = false; mesh.renderOrder = -1;
  return mesh;
}

// per instance: where it lies in the window that follows the camera (wrapped, so a grain keeps its place
// while it is in view), and its own random numbers
const placed = (L, i, size, salt) => {
  const h = vec2(hash(i.mul(1.31).add(salt)), hash(i.mul(2.17).add(salt).add(7)));
  const off = fract(h.sub(L.centre.div(size)).add(0.5)).sub(0.5).mul(size);
  return L.centre.add(off);
};

export function grainMesh(field, L, count) {
  const g = new THREE.OctahedronGeometry(1, 0);
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, flatShading: true });
  const i = float(instanceIndex);
  const WIN = 2.6;
  const q = placed(L, i, WIN, 0.37);
  const H = field.sample(field.texH, q, false), M0 = field.sample(field.texM, q, false), M = vec4(coverOf(H.y, field.texelAt(q)), M0.yzw);
  const r1 = hash(i.mul(3.7).add(1)), r2 = hash(i.mul(5.3).add(2)), r3 = hash(i.mul(7.1).add(3)), r4 = hash(i.mul(9.9).add(4));
  const pw = M.y.mul(float(1).sub(M.x).mul(0.6).add(0.4)), cl = M.z.mul(float(1).sub(M.x));
  const isClump = r1.lessThan(cl.mul(0.55));
  const keep = r1.lessThan(pw.mul(0.9).add(cl.mul(0.55)).add(0.003));
  const size = select(isClump, r2.mul(r2).mul(0.0035).add(0.0012), r2.mul(r2).mul(0.0022).add(0.0007));
  const sz = select(keep, size, float(0));
  m.positionNode = Fn(() => {
    const a = r3.mul(6.283), b = r4.mul(1.4);
    const v = positionLocal.mul(vec3(r2.mul(0.6).add(0.7), r4.mul(0.6).add(0.7), 0.75)).mul(sz);
    const vx = v.x.mul(cos(a)).sub(v.y.mul(sin(a))), vy = v.x.mul(sin(a)).add(v.y.mul(cos(a)));
    const vy2 = vy.mul(cos(b)).sub(v.z.mul(sin(b))), vz = vy.mul(sin(b)).add(v.z.mul(cos(b)));
    return vec3(q.x.add(vx), q.y.add(vy2), H.x.add(vz).add(sz.mul(0.35)));
  })();
  const col = mix(L.powderCol.mul(r3.mul(0.6).add(0.6)), mix(L.rE, L.rD, r3), select(isClump, float(1), smoothstep(0.7, 1.0, r4)));
  m.colorNode = varying(col, 'vGrainCol');
  const mesh = new THREE.Mesh(g, m);
  mesh.count = count; mesh.frustumCulled = false; mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

export function dropMesh(field, L, count) {
  const g = new THREE.SphereGeometry(1, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2); g.rotateX(Math.PI / 2);
  const m = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.03, transmission: 1, thickness: 0.02, ior: 1.33, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02 });
  const i = float(instanceIndex);
  const WIN = 3;
  const q = placed(L, i, WIN, 4.11);
  const H = field.sample(field.texH, q, false), M0 = field.sample(field.texM, q, false), M = vec4(coverOf(H.y, field.texelAt(q)), M0.yzw);
  const r1 = hash(i.mul(4.7).add(11)), r2 = hash(i.mul(6.3).add(12));
  const keep = r1.lessThan(L.drops).and(M.z.lessThan(0.4));
  const sz = select(keep, r2.mul(r2).mul(0.05).add(0.008), float(0));
  m.positionNode = vec3(q.x.add(positionLocal.x.mul(sz)), q.y.add(positionLocal.y.mul(sz)), H.x.add(positionLocal.z.mul(sz).mul(0.62)).sub(sz.mul(0.04)));
  // water on rust picks up its colour; on paint it stays clear
  m.colorNode = varying(mix(vec3(1, 0.62, 0.32), vec3(0.94, 0.98, 1), M.x), 'vDropCol');
  const mesh = new THREE.Mesh(g, m);
  mesh.count = count; mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = true;
  return mesh;
}

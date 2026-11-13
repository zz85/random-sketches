// field.js - Oxide: the rust landscape, made on the GPU in two TSL compute passes, kept in nested square
// windows that follow the camera (a clipmap: level l is S0 * 2^l cm across, all N x N texels, so the detail
// near the camera is fine and the horizon is cheap; 1 unit = 1 cm). The steel goes on as far as you fly.
// A level is made again, snapped to its texels, when the camera has moved an eighth of it.
//   Pass A, once a scene: when rust reaches each point. A domain-warped fractal noise, lace from a finer one,
//   pulled earlier along the cracks of a cell network where the paint has crazed into plates. Kept as an
//   arrival time, so the bands the front leaves are the same whether you watch it grow or not.
//   Pass B, each time the front moves: the distance to the front (the arrival time less now, over its
//   gradient), and from it the relief and the materials: paint that lifts and curls where rust undercuts it,
//   plates that dish between their cracks, blisters, tide lines where the front once stood, crumbly crust and
//   pits in the rust, an orange powder at the front and dark clumps behind it.
//   Over both, regions some 10 cm across: more or less rust, crazing, lace, thicker crust, corrosion pits
//   as craters with raised rims, and a slow waviness of the sheet itself.
// Writes two half-float atlas textures (the levels stacked in rows) that the raymarch reads: H (height, signed
// distance to the paint's edge, rust age, regional hue) and M (paint over rust, powder, clumps, band). Paint
// cover is read from the distance, so the edge can be moved where it is drawn (Listen does).
import * as THREE from 'three/webgpu';
import { Fn, instancedArray, instanceIndex, uniform, float, int, vec2, vec3, vec4, ivec2, clamp, smoothstep, mix, abs, exp, select, max, min, length, fract,
  texture, exp2, textureStore, mx_fractal_noise_float, mx_fractal_noise_vec3, mx_noise_float, mx_worley_noise_vec2, mx_worley_noise_float } from 'three/tsl';

export const LEVELS = 5, S0 = 1.6;
export const SIZES = [...Array(LEVELS)].map((_, l) => S0 * 2 ** l);

// what each scene sets; colours and light are in PRESETS too, read by main.js and surface.js
export const PRESETS = {
  tide: {
    name: 'Tide lines', note: 'bands of rust where the front once stood, turquoise paint peeling off',
    region: 0.22, craze: 0.6, craters: 0.5, relief: 0.05,
    scale: 0.32, warp: 1.6, lace: 0.06, laceScale: 5, t: -0.02, cells: 0, crackW: 0, crackPull: 0,
    bandFreq: 110, bandAmp: 0.003, grow: 2.5, rustH: 0.022, crumb: 0.004, pits: 0.004, powder: 0.05, powderAmt: 0.45, clump: 0.25, clumpH: 0.012,
    paintH: 0.014, curl: 0.012, dish: 0, blister: 0.012, chalk: 0.7,
    paint: [0.02, 0.3, 0.37], paint2: [0.15, 0.55, 0.6], chalkCol: [0.4, 0.66, 0.66], gloss: 0.45, clear: 0.3,
    rA: [0.79, 0.27, 0.012], rB: [0.62, 0.24, 0.02], rC: [0.13, 0.04, 0.11], rD: [0.2, 0.05, 0.015], rE: [0.03, 0.012, 0.008], powderCol: [0.85, 0.4, 0.03], bandMix: 1,
    sun: [-0.55, 0.32, 0.6], sunCol: [1, 0.88, 0.72], sunI: 3.2, fill: 0.55, exposure: 1.0,
  },
  plates: {
    name: 'Plates', note: 'paint crazed into plates, their edges lifted and crusted, rust coming through each one',
    region: 0.18, craze: 1, craters: 0.4, relief: 0.04,
    scale: 0.22, warp: 1.1, lace: 0.08, laceScale: 3, t: -0.32, cells: 1.15, crackW: 0.012, crackPull: 0.3,
    bandFreq: 50, bandAmp: 0.002, grow: 3, rustH: 0.016, crumb: 0.006, pits: 0.006, powder: 0.03, powderAmt: 0.3, clump: 0.15, clumpH: 0.01,
    paintH: 0.016, curl: 0.03, dish: 0.03, blister: 0.006, chalk: 0.25,
    paint: [0.006, 0.05, 0.075], paint2: [0.02, 0.16, 0.24], chalkCol: [0.1, 0.2, 0.22], gloss: 0.35, clear: 0.6,
    rA: [0.6, 0.17, 0.02], rB: [0.35, 0.08, 0.015], rC: [0.12, 0.03, 0.015], rD: [0.05, 0.015, 0.008], rE: [0.02, 0.008, 0.005], powderCol: [0.7, 0.25, 0.02], bandMix: 0.3,
    sun: [0.75, 0.2, -0.35], sunCol: [1, 0.72, 0.5], sunI: 4.2, fill: 0.18, exposure: 0.85,
  },
  powder: {
    name: 'Powder', note: 'orange rust powder heaped at the edge of the paint, dark crumbs, a few drops of water',
    region: 0.25, craze: 0.5, craters: 0.7, relief: 0.06,
    scale: 0.45, warp: 1.3, lace: 0.16, laceScale: 7, t: -0.05, cells: 0, crackW: 0, crackPull: 0,
    bandFreq: 40, bandAmp: 0.001, grow: 4, rustH: 0.012, crumb: 0.008, pits: 0.003, powder: 0.12, powderAmt: 1, clump: 0.9, clumpH: 0.016,
    paintH: 0.012, curl: 0.006, dish: 0, blister: 0.016, chalk: 0.22,
    paint: [0.012, 0.1, 0.11], paint2: [0.04, 0.2, 0.21], chalkCol: [0.06, 0.2, 0.2], gloss: 0.55, clear: 0,
    rA: [0.85, 0.38, 0.03], rB: [0.3, 0.1, 0.03], rC: [0.08, 0.03, 0.02], rD: [0.04, 0.02, 0.015], rE: [0.02, 0.01, 0.008], powderCol: [1, 0.45, 0.04], bandMix: 0.15,
    sun: [-0.3, 0.38, -0.75], sunCol: [1, 0.8, 0.6], sunI: 3.6, fill: 0.35, exposure: 0.95, drops: 1,
  },
  lace: {
    name: 'Lace', note: 'rust over almost everything, glossy blue paint left in lacy islands',
    region: 0.22, craze: 0.4, craters: 0.9, relief: 0.05,
    scale: 0.4, warp: 1.8, lace: 0.22, laceScale: 9, t: 0.08, cells: 0, crackW: 0, crackPull: 0,
    bandFreq: 70, bandAmp: 0.0015, grow: 2, rustH: 0.02, crumb: 0.007, pits: 0.006, powder: 0.04, powderAmt: 0.55, clump: 0.35, clumpH: 0.012,
    paintH: 0.01, curl: 0.004, dish: 0, blister: 0.004, chalk: 0.1,
    paint: [0.02, 0.19, 0.46], paint2: [0.22, 0.51, 0.72], chalkCol: [0.5, 0.7, 0.8], gloss: 0.12, clear: 0.8,
    rA: [0.72, 0.25, 0.03], rB: [0.72, 0.42, 0.17], rC: [0.3, 0.08, 0.02], rD: [0.12, 0.04, 0.015], rE: [0.03, 0.012, 0.008], powderCol: [0.9, 0.45, 0.1], bandMix: 0.4,
    sun: [0.4, 0.45, 0.7], sunCol: [1, 0.92, 0.8], sunI: 3.0, fill: 0.5, exposure: 1.05, drops: 0.3,
  },
};

const NUM = ['region', 'craze', 'craters', 'relief', 'clumpH', 'scale', 'warp', 'lace', 'laceScale', 't', 'cells', 'crackW', 'crackPull', 'bandFreq', 'bandAmp',
  'grow', 'rustH', 'crumb', 'pits', 'powder', 'powderAmt', 'clump', 'paintH', 'curl', 'dish', 'blister', 'chalk'];

const cheb = (d) => max(abs(d.x), abs(d.y));
// paint cover from the signed distance to its edge: a wall three texels wide, so it shades
export const coverOf = (s, texel) => { const w = max(texel.mul(1.5), 0.0012); return smoothstep(w.negate(), w, s); };

export function makeField(N) {
  const NN = N * N;
  // per dispatch: which level, its texel and its centre
  const U = { off: uniform(new THREE.Vector3()), cc: uniform(new THREE.Vector2()), texel: uniform(0.01), lvl: uniform(0) };
  for (const k of NUM) U[k] = uniform(0);
  const A = instancedArray(NN * LEVELS, 'vec4'); // arrival time, distance to a crack, regional hue, relief of the sheet
  const mk = () => { const t = new THREE.StorageTexture(N, N * LEVELS); t.type = THREE.HalfFloatType; t.format = THREE.RGBAFormat; t.magFilter = t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; return t; };
  const texH = mk(), texM = mk();
  const base = () => int(U.lvl).mul(NN);
  const at = (x, y) => base().add(clamp(y, 0, N - 1).mul(N).add(clamp(x, 0, N - 1)));
  const pOf = (x, y) => vec2(float(x), float(y)).add(0.5 - N / 2).mul(U.texel).add(U.cc);
  const hf = (f) => clamp(float(0.3).div(U.texel.mul(f)), 0, 1); // fades detail finer than this level's texels

  // a corrosion pit as a crater: its height (a raised rim, a bowl) and how deep in the bowl
  const crater = (d, r) => { const bowl = smoothstep(r, 0, d), z = d.sub(r).div(r * 0.28); return vec2(exp(z.mul(z).negate()).mul(0.3).sub(bowl.mul(bowl)), bowl); };

  const arrival = Fn(() => {
    const j = int(instanceIndex), x = j.mod(N), y = j.div(N), p = pOf(x, y), i = base().add(j);
    const q = vec3(p.mul(U.scale), 0).add(U.off);
    const w = mx_fractal_noise_vec3(q.mul(0.8).add(vec3(3.1, 1.7, 0.4)), 3, 2, 0.5);
    const R = mx_fractal_noise_vec3(vec3(p.mul(0.085), 7.7).add(U.off.mul(0.37)), 3, 2, 0.5); // regions, ~10 cm
    let a = mx_fractal_noise_float(q.add(vec3(w.xy.mul(U.warp), 0)), 5, 2.0, 0.5).add(R.x.mul(U.region));
    // the lace: a finer noise warped with the coarse one, so the front breaks into fingers and islands
    const qh = vec3(p.mul(U.laceScale), 5.3).add(U.off).add(vec3(w.xy.mul(0.7), 0));
    a = a.add(mx_fractal_noise_float(qh, 4, 2.1, 0.55).mul(U.lace).mul(smoothstep(-0.25, 0.25, R.z).mul(1.3).add(0.35)));
    // crazed paint: everywhere in Plates, in some regions elsewhere; rust arrives along the cracks first
    const plates = U.cells.greaterThan(0.01);
    const craze = max(select(plates, float(1), float(0)), smoothstep(0.08, 0.28, R.y).mul(U.craze));
    const cs = select(plates, U.cells, float(1.6));
    const f = mx_worley_noise_vec2(p.mul(cs).add(U.off.xy).add(w.xy.mul(0.18)));
    const crack = f.y.sub(f.x).div(cs).mul(0.5).add(float(1).sub(craze).mul(4));
    a = a.sub(max(U.crackPull, 0.3).mul(craze).mul(exp(crack.div(-0.06))));
    // pits, big and sparse and small and many, where the region has them; they rust first
    const cm = smoothstep(0.0, 0.3, R.z.add(w.z.mul(0.3))).mul(U.craters);
    const k1 = crater(mx_worley_noise_float(vec3(p.mul(0.9), 3.3).add(U.off)), 0.32);
    const k2 = crater(mx_worley_noise_float(vec3(p.mul(3.1), 8.8).add(U.off)), 0.26);
    const relief = mx_fractal_noise_float(vec3(p.mul(0.35), 2.2).add(U.off), 3, 2, 0.5).mul(U.relief)
      .add(k1.x.mul(0.05).add(k2.x.mul(0.016)).mul(cm));
    a = a.sub(k1.y.mul(0.35).add(k2.y.mul(0.2)).mul(cm));
    A.element(i).assign(vec4(a, crack, R.z.mul(0.8).sub(R.x.mul(0.6)), relief));
  })().compute(NN);

  const shape = Fn(() => {
    const j = int(instanceIndex), x = j.mod(N), y = j.div(N), p = pOf(x, y), i = base().add(j);
    const a = A.element(i);
    const gx = A.element(at(x.add(1), y)).x.sub(A.element(at(x.sub(1), y)).x), gy = A.element(at(x, y.add(1))).x.sub(A.element(at(x, y.sub(1))).x);
    const g = length(vec2(gx, gy)).div(U.texel.mul(2)).max(0.04);
    const crack = a.y, hue = a.z;
    // distance to the paint's edge in cm: positive on paint, negative in rust; a crack is an edge too
    const s = min(a.x.sub(U.t).div(g), crack.sub(max(U.crackW, 0.01)));
    const age = U.t.sub(a.x).max(0);
    const n1 = mx_fractal_noise_float(vec3(p.mul(9), 1.7), 3, 2.0, 0.5); // about a mm
    const n2 = mx_noise_float(vec3(p.mul(55), 4.2)).mul(hf(55)); // a fifth of a mm

    // ---- rust: thicker the longer it has been bare, with a lip at each band where the front stood a while
    const band = age.mul(U.bandFreq).add(n1.mul(0.08)).add(n2.mul(0.02));
    const fb = fract(band);
    const lip = smoothstep(0.22, 0.0, fb).mul(smoothstep(0, 0.02, age));
    const thick = float(1).sub(exp(age.mul(U.grow).negate()));
    const crumb = mx_fractal_noise_float(vec3(p.mul(30), 8.1), 3, 2.2, 0.55).mul(hf(30));
    const pit = smoothstep(0.16, 0.03, mx_worley_noise_float(vec3(p.mul(38), 2.6))).mul(hf(38));
    const cl0 = mx_fractal_noise_float(vec3(p.mul(4.5), 12.5).add(U.off), 3, 2.0, 0.5).add(crumb.mul(0.35)).add(hue.mul(0.2));
    const clump = smoothstep(0.08, 0.42, cl0).mul(U.clump).mul(smoothstep(0.0, 0.06, age));
    const powder = exp(abs(s).negate().div(U.powder.max(0.001))).mul(U.powderAmt).mul(select(s.lessThan(0), float(1), float(0.45)));
    const crust = U.rustH.mul(hue.mul(0.7).add(1).max(0.35));
    let hr = thick.mul(crust).add(lip.mul(U.bandAmp)).add(crumb.mul(U.crumb)).sub(pit.mul(U.pits).mul(thick.mul(0.7).add(0.3)));
    hr = hr.add(clump.mul(clump).mul(U.clumpH).mul(crumb.mul(0.4).add(0.8))).add(powder.mul(0.006).mul(n2.mul(0.5).add(0.7))).sub(0.008);

    // ---- paint: lifts where the rust works under it, at the front and at every crack, dishes in between,
    // blisters near the front, chalky and slightly orange-peeled on top
    const sp = s.max(0);
    const lift = exp(sp.div(-0.035)).mul(U.curl).mul(n1.mul(0.4).add(0.8));
    const bl = smoothstep(0.55, 0.0, mx_worley_noise_float(vec3(p.mul(7), 9.3).add(U.off))).mul(exp(sp.div(-0.25))).mul(U.blister);
    const dish = smoothstep(0.02, 0.35, crack).mul(U.dish).mul(smoothstep(3.5, 2, crack));
    const hp = U.paintH.add(lift).add(bl).sub(dish).add(n2.mul(0.0016)).add(n1.mul(0.003));
    const m = coverOf(s, U.texel);

    const row = y.add(int(U.lvl).mul(N));
    textureStore(texH, ivec2(x, row), vec4(mix(hr, hp, m).add(a.w), s, age, hue));
    textureStore(texM, ivec2(x, row), vec4(hp.sub(hr), powder, clump, band)); // the paint's height over the rust: cover is worked out from s where it is read
  })().compute(NN);

  // ---- reading it back: the finest level that holds a point, and the next one out to blend into at its edge
  const C = SIZES.map(() => uniform(new THREE.Vector2(1e4, 1e4))); // each level's centre, as its textures hold it
  const pick = (p) => { let l = float(LEVELS - 1); for (let k = LEVELS - 2; k >= 0; k--) l = select(cheb(p.sub(C[k])).lessThan(SIZES[k] * 0.42), float(k), l); return l; };
  const centreOf = (l) => { let c = C[LEVELS - 1]; for (let k = LEVELS - 2; k >= 0; k--) c = select(l.equal(float(k)), C[k], c); return c; };
  const uvAt = (p, l) => { const u = clamp(p.sub(centreOf(l)).div(exp2(l).mul(S0)).add(0.5), 0.5 / N, 1 - 0.5 / N); return vec2(u.x, u.y.add(l).div(LEVELS)); };
  // tex: texH or texM; p: field coords (x, -z in the world); blend: smooth across the edge of a level
  const sample = (tex, p, blend = true) => {
    const l = pick(p), a = texture(tex, uvAt(p, l)).level(0);
    if (!blend) return a;
    const l2 = min(l.add(1), float(LEVELS - 1));
    const w = smoothstep(0.33, 0.42, cheb(p.sub(centreOf(l))).div(exp2(l).mul(S0))).mul(select(l.lessThan(float(LEVELS - 1)), float(1), float(0)));
    return mix(a, texture(tex, uvAt(p, l2)).level(0), w);
  };
  const texelAt = (p) => exp2(pick(p)).mul(S0 / N);
  // a blurred height under p: two levels coarser, for cavities
  const coarse = (p) => { const l = min(pick(p).add(2), float(LEVELS - 1)); return texture(texH, uvAt(p, l)).level(0).x; };

  // the ground under the camera and ahead of it, read back for the flight
  const PROBES = 10, probeO = uniform(new THREE.Vector2()), probeD = uniform(new THREE.Vector2());
  const probeBuf = instancedArray(PROBES, 'float');
  const probeK = Fn(() => { probeBuf.element(instanceIndex).assign(sample(texH, probeO.add(probeD.mul(float(instanceIndex))), false).x); })().compute(PROBES);
  let probing = false;

  let renderer = null, dirty = true, turn = 0;
  const lv = SIZES.map(() => ({ cc: new THREE.Vector2(), pending: false, t: null }));
  const run = (k, l) => { U.lvl.value = l; U.texel.value = SIZES[l] / N; U.cc.value.copy(lv[l].cc); renderer.compute(k); };
  const snap = (v, l) => { const g = (SIZES[l] / N) * 4; return new THREE.Vector2(Math.round(v.x / g) * g, Math.round(v.y / g) * g); };
  return {
    N, U, texH, texM, C, sample, texelAt, coarse,
    init(r) { renderer = r; },
    // set a scene: its numbers and a seed; every level is made again
    set(preset, seed) {
      for (const k of NUM) U[k].value = preset[k];
      const r = (k) => ((Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1;
      U.off.value.set(r(1) * 200 - 100, r(2) * 200 - 100, r(3) * 40);
      dirty = true;
    },
    // t: where the front stands; want: the point the levels centre on. A level that has fallen behind is made
    // again over two frames (arrival, then shape), one level a frame, unless `settle` does them all now.
    update(t, want, settle = false) {
      U.t.value = t;
      let budget = dirty || settle ? 99 : 1, shapes = settle ? 99 : 2; // growing: two levels a frame, in turn
      const order = [...Array(LEVELS).keys()].map((k) => (k + turn) % LEVELS); turn++;
      for (const l of dirty ? [...Array(LEVELS).keys()] : order) {
        const L = lv[l];
        if (dirty) { L.cc = snap(want, l); run(arrival, l); run(shape, l); C[l].value.copy(L.cc); L.t = t; L.pending = false; continue; }
        if (L.pending) { run(shape, l); C[l].value.copy(L.cc); L.t = t; L.pending = false; continue; }
        const d = Math.max(Math.abs(want.x - C[l].value.x), Math.abs(want.y - C[l].value.y));
        if (d > SIZES[l] / 8 && budget > 0) {
          budget--; L.cc = snap(want, l); run(arrival, l);
          if (settle) { run(shape, l); C[l].value.copy(L.cc); L.t = t; } else L.pending = true;
          continue;
        }
        if (L.t !== t && shapes > 0) { shapes--; run(shape, l); L.t = t; }
      }
      dirty = false;
    },
    // heights at o, o + d, o + 2d ... (field coords), or null while the last read is out
    async probe(o, d) {
      if (probing) return null;
      probing = true; probeO.value.copy(o); probeD.value.copy(d); renderer.compute(probeK);
      try { return Array.from(new Float32Array(await renderer.getArrayBufferAsync(probeBuf.value))); } finally { probing = false; }
    },
  };
}

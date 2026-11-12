// sim.js - Rust: the corrosion of a steel surface on a grid in TSL compute shaders.
//
// The surface is a grid of NX x NY cells laid over the sheet (y up, the sheet stands upright, so water runs
// toward y = 0). Two kinds of pass run on it:
//   water passes (several a frame): rain lands in drops, water above what a cell holds runs down to the three
//     cells below it, preferring wet ones (so runoff gathers into rivulets that keep their paths), carries the
//     iron it dissolved from rust, and leaves that iron as a stain where it dries.
//   a chemistry pass (one a frame, over the hours the frame stands for): bare steel rusts while it is wet,
//     paint is undercut from rust next to it until it blisters and flakes, zinc is used up before the steel
//     under it rusts, mill scale cracks off, metal is lost and thin sheet rusts through.
// Water (W water, C iron, S stain) and chemistry (R rust, P coating, U undercut, M metal lost) live in their own
// ping-pong buffers. K and K2 hold what each cell is: material, crevice, susceptibility, edge, rivulet meander,
// flake threshold. Each frame both are copied into two float storage textures the materials sample.
import * as THREE from 'three/webgpu';
import { Fn, instancedArray, instanceIndex, uniform, float, int, uint, vec2, vec4, ivec2, If, select, max, min, clamp, smoothstep, mix, hash, textureStore,
  sqrt, abs, atomicAdd, atomicStore, Return } from 'three/tsl';

// coatings of the sheet (uniform `coat`) and materials of a cell (K.x)
export const COAT = { paint: 0, bare: 1, zinc: 2 };
export const MAT = { sheet: 0, zincScrew: 1, steel: 2, stainless: 3, aluminium: 4, rubber: 5, weld: 6 };

export function makeSim({ NX, NY, K0, K1, C0 }) {
  const N = NX * NY;
  const Wa = instancedArray(new Float32Array(N * 4), 'vec4'), Wb = instancedArray(new Float32Array(N * 4), 'vec4');
  const Ca = instancedArray(new Float32Array(C0), 'vec4'), Cb = instancedArray(new Float32Array(C0), 'vec4');
  const F = instancedArray(new Float32Array(N * 4), 'vec4');
  const K = instancedArray(K0, 'vec4'), K2 = instancedArray(K1, 'vec4');
  const counters = instancedArray(new Uint32Array(8), 'uint').toAtomic();
  const texC = new THREE.StorageTexture(NX, NY), texW = new THREE.StorageTexture(NX, NY);
  for (const t of [texC, texW]) { t.type = THREE.HalfFloatType; t.format = THREE.RGBAFormat; t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; }

  const U = {
    coat: uniform(0), gauge: uniform(1), pass: uniform(0), // pass counter, for the rain's hash
    // weather for this frame
    rain: uniform(0), // drop chance per 4x4 block per water pass
    dropV: uniform(0.03), evap: uniform(0.004), dew: uniform(0),
    dt: uniform(1), // hours the chemistry pass stands for
    wetRain: uniform(0), wetDew: uniform(0), // fractions of those hours the whole sheet was rained on or dewy
    salt: uniform(0), temp: uniform(1),
    // rates, per wet hour
    kRust: uniform(0.0016), kLoss: uniform(0.0008), kUnder: uniform(0.0004), kZinc: uniform(0.00004), kScale: uniform(0.0015),
    kDissolve: uniform(0.02), kDeposit: uniform(0.25), kPin: uniform(2.5e-8),
    // the brush: tool 0 none, 1 scratch, 2 wire brush, 3 paint, 4 water; a capsule from b0 to b1, in cells
    tool: uniform(0), b0: uniform(new THREE.Vector2()), b1: uniform(new THREE.Vector2()), bR: uniform(4), bAmt: uniform(1),
  };

  const at = (x, y) => clamp(y, 0, NY - 1).mul(NX).add(clamp(x, 0, NX - 1));
  const brushHit = (x, y) => {
    const p = vec2(float(x), float(y)), a = U.b0, ab = U.b1.sub(a);
    const t = clamp(p.sub(a).dot(ab).div(ab.dot(ab).max(1e-4)), 0, 1);
    const d = p.sub(a.add(ab.mul(t))).length();
    return smoothstep(U.bR, U.bR.mul(0.6), d);
  };
  // how much water a cell holds before it runs: a film on smooth paint or zinc, more in rust (it soaks it up),
  // much more in a crevice (under a screw head, in a lap seam)
  const holdOf = (c, k) => float(0.0008).add(sqrt(c.x.max(0)).mul(0.004)).add(k.y.mul(0.05));

  // ---- water pass 1: what each cell sends to the three cells below, and the iron it carries
  const fluxFrom = (Wsrc, Csrc) => Fn(() => {
    const i = int(instanceIndex), x = i.mod(NX), y = i.div(NX);
    const w = Wsrc.element(i), c = Csrc.element(i), k = K.element(i), k2 = K2.element(i);
    const avail = max(w.x.sub(holdOf(c, k)), 0).mul(0.6).mul(select(c.w.greaterThan(1), float(0), float(1)));
    // targets: below-left, below, below-right. Water follows wet paths; the meander leans it one way.
    const wl = Wsrc.element(at(x.sub(1), y.sub(1))).x, wc = Wsrc.element(at(x, y.sub(1))).x, wr = Wsrc.element(at(x.add(1), y.sub(1))).x;
    const lean = k2.x;
    const fl = float(0.22).mul(float(1).sub(lean).max(0)).mul(smoothstep(0, 0.01, wl).mul(3).add(0.3)).mul(select(x.greaterThan(0), float(1), float(0)));
    const fc = float(1).mul(smoothstep(0, 0.01, wc).mul(3).add(0.3));
    const fr = float(0.22).mul(float(1).add(lean).max(0)).mul(smoothstep(0, 0.01, wr).mul(3).add(0.3)).mul(select(x.lessThan(NX - 1), float(1), float(0)));
    const s = fl.add(fc).add(fr);
    F.element(i).assign(vec4(avail.mul(fl).div(s), avail.mul(fc).div(s), avail.mul(fr).div(s), w.y.div(w.x.max(1e-5))));
  })().compute(N);

  // ---- water pass 2: run, rain, evaporate, dissolve, deposit
  const waterStep = (Wsrc, Wdst, Csrc) => Fn(() => {
    const i = int(instanceIndex), x = i.mod(NX), y = i.div(NX);
    const w = Wsrc.element(i).toVar(), c = Csrc.element(i), k = K.element(i);
    const f = F.element(i);
    const top = y.greaterThanEqual(NY - 1);
    const fu = F.element(at(x, y.add(1))), ful = F.element(at(x.sub(1), y.add(1))), fur = F.element(at(x.add(1), y.add(1)));
    const okL = select(x.greaterThan(0), float(1), float(0)), okR = select(x.lessThan(NX - 1), float(1), float(0));
    const inW = select(top, float(0), fu.y.add(ful.z.mul(okL)).add(fur.x.mul(okR)));
    const inC = select(top, float(0), fu.y.mul(fu.w).add(ful.z.mul(ful.w).mul(okL)).add(fur.x.mul(fur.w).mul(okR)));
    const out = f.x.add(f.y).add(f.z);
    const W = w.x.sub(out).add(inW).toVar(), C = w.y.sub(out.mul(f.w)).add(inC).toVar(), S = w.z.toVar();
    // a little spreading sideways, so a drop is a round spot and a film is smooth
    const wl = Wsrc.element(at(x.sub(1), y)).x, wr = Wsrc.element(at(x.add(1), y)).x;
    W.addAssign(wl.add(wr).sub(W.mul(2)).mul(0.04).mul(smoothstep(0.002, 0.01, W.max(wl).max(wr))));
    // rain: a drop in this cell's 4x4 block, at a random place in it
    const bx = x.div(4), by = y.div(4), seed = uint(by.mul(NX).add(bx)).add(uint(U.pass).mul(uint(2654435761)));
    const h = hash(seed);
    If(h.lessThan(U.rain), () => {
      const cx = float(bx.mul(4)).add(hash(seed.add(uint(17))).mul(4)), cy = float(by.mul(4)).add(hash(seed.add(uint(31))).mul(4));
      const d = vec2(float(x).add(0.5).sub(cx), float(y).add(0.5).sub(cy)).length();
      W.addAssign(U.dropV.mul(smoothstep(1.9, 0.6, d)).mul(hash(seed.add(uint(5))).mul(0.8).add(0.6)));
    });
    W.addAssign(U.dew);
    If(U.tool.equal(4), () => { W.addAssign(brushHit(x, y).mul(0.02).mul(U.bAmt)); });
    // rust dissolves into the water on it; a bit of the iron settles out wherever the water stands
    const wet = smoothstep(0.0004, 0.004, W);
    C.addAssign(c.x.min(1.5).mul(wet).mul(U.kDissolve).mul(0.04).mul(select(U.rain.greaterThan(0), float(1), float(0.2))));
    // evaporation, slower in a crevice and in thick rust, leaves the iron it carried behind as stain
    const ev = U.evap.mul(float(1).sub(k.y.mul(0.7))).div(c.x.mul(0.6).add(1)).min(W);
    const frac = ev.div(W.max(1e-5));
    const settle = C.mul(frac.add(U.kDeposit.mul(0.006)).min(1));
    S.addAssign(settle); C.subAssign(settle); W.subAssign(ev);
    // rain washes a little of the loose stain away again
    S.mulAssign(float(1).sub(out.mul(0.02)).max(0.985));
    // a hole lets the water through
    If(c.w.greaterThan(1), () => { W.assign(0); C.assign(0); });
    Wdst.element(i).assign(vec4(W.max(0), C.max(0), S, 0));
  })().compute(N);

  // ---- chemistry: one pass over the hours the frame stands for
  const chemStep = (Csrc, Cdst, Wcur) => Fn(() => {
    const i = int(instanceIndex), x = i.mod(NX), y = i.div(NX);
    const c = Csrc.element(i).toVar(), k = K.element(i), k2 = K2.element(i), w = Wcur.element(i);
    const R = c.x.toVar(), P = c.y.toVar(), Un = c.z.toVar(), M = c.w.toVar();
    const mat = k.x.round();
    // the four neighbours
    const nl = Csrc.element(at(x.sub(1), y)), nr = Csrc.element(at(x.add(1), y)), nd = Csrc.element(at(x, y.sub(1))), nu = Csrc.element(at(x, y.add(1)));
    // weighted toward the cell above: water running down carries the attack with it
    const nR = nl.x.add(nr.x).mul(0.12).add(nu.x.mul(0.66)).add(nd.x.mul(0.1));
    const nU = nl.z.add(nr.z).add(nd.z).add(nu.z).mul(0.25);
    const bare = (n) => select(n.y.lessThan(0.5), float(1), float(0));
    const nBare = max(max(bare(nl), bare(nr)), max(bare(nd), bare(nu)));
    // time of wetness: the water on the cell, rain on the whole sheet, dew; a crevice stays wet longer
    const wet = clamp(smoothstep(0.0004, 0.004, w.x).add(U.wetRain).add(U.wetDew.mul(0.8)).add(k.y.mul(U.wetRain.add(U.wetDew).mul(1.5).add(0.04))), 0, 1);
    const env = U.temp.mul(U.salt.mul(2.2).add(1));
    const hrs = U.dt.mul(wet).mul(env).toVar(); // wet hours, weighted for warmth and salt
    const susc = k.z, edge = k.w;
    // what coats the cell: the sheet's coating, zinc plating on a zinc screw, nothing on the rest
    const coat = select(mat.equal(MAT.zincScrew), float(COAT.zinc), select(mat.equal(MAT.sheet).or(mat.equal(MAT.weld)), U.coat, float(COAT.bare)));
    const rusts = mat.lessThanEqual(2).or(mat.equal(MAT.weld));

    // exposure of the steel under the coating
    const exposed = float(1).toVar();
    If(coat.equal(COAT.paint), () => {
      exposed.assign(select(P.greaterThan(0.5), float(0), float(1)));
      // under intact paint: rust next to it (or under it, painted over) creeps in and lifts the paint
      If(P.greaterThan(0.5), () => {
        const feed = nR.mul(nBare).mul(1.6).add(R.mul(1.2)).add(max(nU.sub(Un), 0).mul(0.06)).add(edge.mul(0.002));
        Un.addAssign(hrs.mul(U.kUnder).mul(feed).mul(susc));
        // past its threshold the blister breaks and the paint flakes off, sooner where paint is already gone next to it
        If(Un.greaterThan(k2.y.mul(select(nBare.greaterThan(0.5), float(0.75), float(1.3)))), () => {
          P.assign(0); R.assign(R.max(Un.mul(0.6)));
        });
        // pinholes: weathered paint lets go here and there, mostly at edges
        If(hash(uint(i).add(uint(U.pass).mul(uint(374761393)))).lessThan(U.kPin.mul(hrs).mul(edge.mul(30).add(0.4)).mul(susc)), () => { P.assign(0); });
      });
    });
    If(coat.equal(COAT.zinc), () => {
      // zinc goes first (sacrificial), thinner at cut edges and quicker in salt; steel bare of it but still
      // next to zinc is protected
      P.subAssign(hrs.mul(U.kZinc).mul(edge.mul(4).add(1)).mul(select(mat.equal(MAT.zincScrew), float(3), float(1))).mul(susc));
      P.assign(P.max(0));
      exposed.assign(smoothstep(0.18, 0.0, P));
    });
    If(coat.equal(COAT.bare), () => {
      // mill scale (or black oxide) cracks and spalls as rust grows around it
      P.subAssign(hrs.mul(U.kScale).mul(nR.add(R).mul(1.5).add(0.05)).mul(susc));
      P.assign(P.max(0));
      exposed.assign(float(1).sub(P.mul(0.75)));
    });
    // rust grows on wet exposed steel, slowing as the crust thickens; metal is lost, faster in pits and crevices
    If(rusts, () => {
      const g = hrs.mul(U.kRust).mul(exposed).mul(susc).mul(select(mat.equal(MAT.weld), float(1.5), float(1)));
      R.addAssign(g.div(R.mul(R).mul(3).add(1)));
      const pit = susc.mul(susc).mul(susc).mul(k.y.mul(2).add(1));
      M.addAssign(g.mul(U.kLoss).mul(pit).div(U.gauge).mul(select(mat.equal(MAT.sheet), float(1), float(0.2))));
    });
    // the brush
    const bh = brushHit(x, y);
    If(U.tool.equal(1).and(bh.greaterThan(0.3)), () => { // scratch: through the coating to bright steel
      If(coat.equal(COAT.paint), () => { P.assign(0); Un.assign(0); });
      If(coat.notEqual(COAT.paint), () => { P.assign(P.mul(0.3)); });
      R.mulAssign(0.5);
    });
    If(U.tool.equal(2), () => { // wire brush: loose rust and blisters off
      R.mulAssign(float(1).sub(bh.mul(0.25).mul(U.bAmt))); Un.mulAssign(float(1).sub(bh.mul(0.3)));
      If(bh.greaterThan(0.3).and(Un.greaterThan(0.05)), () => { P.assign(select(coat.equal(COAT.paint), float(0), P)); });
    });
    If(U.tool.equal(3).and(bh.greaterThan(0.25)).and(M.lessThan(1)), () => { // paint (over whatever is there)
      P.assign(1); Un.assign(Un.mul(0.3));
    });
    R.assign(R.min(3));
    Cdst.element(i).assign(vec4(R, P, Un, M));
  })().compute(N);

  const bake = (Csrc, Wsrc) => Fn(() => {
    const i = int(instanceIndex), x = i.mod(NX), y = i.div(NX);
    textureStore(texC, ivec2(x, y), Csrc.element(i));
    textureStore(texW, ivec2(x, y), Wsrc.element(i));
  })().compute(N);

  const count = (Csrc, Wsrc) => Fn(() => {
    const i = int(instanceIndex);
    const c = Csrc.element(i), w = Wsrc.element(i), k = K.element(i);
    If(k.x.round().notEqual(MAT.sheet), () => { Return(); });
    atomicAdd(counters.element(0), uint(1));
    If(c.x.greaterThan(0.15).and(c.y.lessThan(0.5).or(U.coat.notEqual(COAT.paint))), () => { atomicAdd(counters.element(1), uint(1)); });
    If(c.y.lessThan(0.5), () => { atomicAdd(counters.element(2), uint(1)); });
    If(c.w.greaterThan(1), () => { atomicAdd(counters.element(3), uint(1)); });
    If(w.x.greaterThan(0.004), () => { atomicAdd(counters.element(4), uint(1)); });
    If(c.z.greaterThan(0.08).and(c.y.greaterThan(0.5)), () => { atomicAdd(counters.element(5), uint(1)); });
  })().compute(N);
  const zero = Fn(() => { atomicStore(counters.element(int(instanceIndex)), uint(0)); })().compute(8);

  const k = {
    flux: [fluxFrom(Wa, Ca), fluxFrom(Wb, Ca), fluxFrom(Wa, Cb), fluxFrom(Wb, Cb)], // [w + 2c]
    water: [waterStep(Wa, Wb, Ca), waterStep(Wb, Wa, Ca), waterStep(Wa, Wb, Cb), waterStep(Wb, Wa, Cb)],
    chem: [chemStep(Ca, Cb, Wa), chemStep(Ca, Cb, Wb), chemStep(Cb, Ca, Wa), chemStep(Cb, Ca, Wb)], // [w + 2c]
    bake: [bake(Ca, Wa), bake(Ca, Wb), bake(Cb, Wa), bake(Cb, Wb)],
    count: [count(Ca, Wa), count(Ca, Wb), count(Cb, Wa), count(Cb, Wb)],
  };
  let renderer = null, w = 0, c = 0; // which buffer of each pair is current
  return {
    NX, NY, U, texC, texW,
    init(r) { renderer = r; renderer.compute([...k.bake, k.bake[w + 2 * c]]); },
    // one frame: `waterPasses` water passes, then the chemistry over U.dt hours, then the textures
    frame(waterPasses = 4, chem = true) {
      const list = [];
      for (let s = 0; s < waterPasses; s++) { U.pass.value = (U.pass.value + 1) % 1e6; list.push(k.flux[w + 2 * c], k.water[w + 2 * c]); w ^= 1; }
      if (chem) { list.push(k.chem[w + 2 * c]); c ^= 1; }
      list.push(k.bake[w + 2 * c]);
      renderer.compute(list);
    },
    async stats() {
      renderer.compute([zero, k.count[w + 2 * c]]);
      const a = new Uint32Array(await renderer.getArrayBufferAsync(counters.value));
      const n = Math.max(1, a[0]);
      return { rust: a[1] / n, bare: a[2] / n, holes: a[3] / n, wet: a[4] / n, blisters: a[5] / n, cells: a[0] };
    },
    async read() {
      const C = new Float32Array(await renderer.getArrayBufferAsync((c ? Cb : Ca).value));
      const W = new Float32Array(await renderer.getArrayBufferAsync((w ? Wb : Wa).value));
      return { C, W };
    },
    reset(C0new) {
      (c ? Cb : Ca).value.array.set(C0new); (c ? Cb : Ca).value.needsUpdate = true;
      const z = new Float32Array(N * 4); (w ? Wb : Wa).value.array.set(z); (w ? Wb : Wa).value.needsUpdate = true;
    },
  };
}

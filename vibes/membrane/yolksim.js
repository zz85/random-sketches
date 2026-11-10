// yolksim.js - Membrane, the yolk game: a raw yolk as a GPU balloon in TSL compute shaders. The yolk is a bag of
// liquid: its skin (the vitelline membrane) is a closed cloth, and what is inside doesn't compress.
//   predict  Verlet step with gravity; a vertex touching something wet (shell, white, bowl) drags, and the egg
//            white round the bottom of the shell slows anything moving through it
//   solve    Jacobi position-based dynamics, as the shell membrane: links pull toward their rest length (soft in
//            compression, so the skin wrinkles where it's gathered), weak bend links keep it from crumpling, and the
//            volume is held: each vertex moves along its normal by the volume lost over the area (a sphere is the
//            least skin for its volume, so any change of shape has to stretch the skin, and the strain is the load).
//            The pinch pulls what it holds toward the fingertip, squeezed together by the grip; the net pull it
//            has to give, summed over the pinched vertices, is the force on the fingers, which the app compares with
//            what the grip can hold before the skin slips out
//   links    strain past a link's own breaking strain breaks it; the yolk bursts once a few go
//   strands  the chalazae: twisted cords of white that hold a yolk to the shell. They stretch, thin and snap,
//            tugging the yolk back as it is lifted
// Counters: links torn, the nearest any link came to breaking this frame (strain over breaking strain, x1000). Atomics (int, fixed point): volume and area (per
// substep), the pinch force (x, y, z, per frame) and the pinch's weight.
import { Fn, instancedArray, instanceIndex, uniform, uniformArray, float, int, uint, vec3, vec4, If, Loop, select, max, length, normalize, cross, mix,
  clamp, atan, acos, floor, fract, atomicAdd, atomicMax, atomicStore, atomicLoad, smoothstep, dot } from 'three/tsl';
import { Vector3 } from 'three/webgpu';
import { A, B, KEGG, THICK, RIM_N, YR, YMAXL as MAXL, YMAXT as MAXT } from './egg.js';
export { buildYolk, YR } from './egg.js';
import { TABLE_Y, CUP, NS } from './sim.js';
import { BOARD } from './scene.js';

// the bowl it goes in: a spherical inner face of radius Rs from its bottom, a foot above the board, up to its rim
export const BOWL = { x: 5.4, z: 0.4, Rs: 2.6, t: 0.18, bot: TABLE_Y + 0.25, top: TABLE_Y + 1.85 };
BOWL.cy = BOWL.bot + BOWL.Rs; BOWL.rim = Math.sqrt(BOWL.Rs ** 2 - (BOWL.cy - BOWL.top) ** 2);
export const WHITE_Y = -1.55; // the level of the egg white left in the shell

export const YP = {
  cohesion: 0.08,   // share of each vertex's velocity eased to the whole yolk's per substep: the liquid inside carries
                    // a pull on the skin to all of it at once, which a few Jacobi iterations over the skin alone can't
  gravity: 420,     // cm/s^2, a little less than g: the Jacobi solve can't carry the whole weight up the skin in a few
                    // iterations, so less g gives the hang of a real yolk (a fat teardrop, as in a photo of one)
  damp: 0.998, omega: 1.5, vmax: 220,
  comp: 0.08,       // stiffness in compression, relative to tension: gathered skin wrinkles
  bendK: 0.04,
  volK: 1.0,        // how much of the volume error one substep puts back
  stretch: 0.9,     // link stiffness per iteration (below 1, so strain grows with the load instead of being solved away)
  tear: 0.65,       // breaking strain (each link draws its own, +-20%)
  smooth: 0.25,     // the breaking test reads the strain low-passed over a few substeps
  squeeze: 0.85,
  crush: 0.5,       // at full grip the pinched skin breaks at 1 - crush of its own strain    // at full grip the pinched patch closes to 1 - squeeze of its size
  pinchR: 0.36,     // cm: the pinch takes the skin within this of the fingertip
  wetDrag: 0.9,     // velocity kept per substep by a vertex touching a wet surface
  whiteDrag: 0.975, // ... and by one moving through the egg white
  strandK: 0.05, strandDraw: 0.03, strandMinR: 0.012,
};

const VS = 1e6; // fixed point for the int atomics
export function makeYolkSim(m, table, center, { substeps = 8, iters = 6, strands = [] } = {}) {
  const N = m.N, NL = m.NL, NT = m.NT;
  const p0 = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) { for (let k = 0; k < 3; k++) p0[i * 4 + k] = m.pos[i * 3 + k] + center[k]; p0[i * 4 + 3] = 1; }
  const pos = instancedArray(p0, 'vec4'), posB = instancedArray(new Float32Array(p0), 'vec4'), prev = instancedArray(new Float32Array(p0), 'vec4');
  const grab = instancedArray(new Float32Array(N * 4), 'vec4'), normal = instancedArray(new Float32Array(N * 4), 'vec4');
  const ld = new Float32Array((NL + 1) * 4), lm = new Float32Array((NL + 1) * 4);
  const rr = (i) => { const x = Math.sin(i * 12.9898 + 4.1414) * 43758.5453; return x - Math.floor(x); };
  for (let i = 0; i < NL; i++) { const [a, b, rest, parent] = m.links[i]; ld.set([a, b, rest, parent < 0 ? 1 : YP.bendK], i * 4); lm.set([rest, 0, YP.tear * (0.8 + 0.4 * rr(i)), parent], i * 4); }
  ld.set([0, 0, 1, 0], NL * 4); lm.set([1, 0, 99, -2], NL * 4);
  const links = instancedArray(ld, 'vec4'), meta = instancedArray(lm, 'vec4');
  const adj = instancedArray(new Int32Array(m.adj), 'int'), vtris = instancedArray(new Int32Array(m.vtris), 'int');
  const tv = new Float32Array((NT + 1) * 4), te = new Float32Array((NT + 1) * 4);
  for (let t = 0; t < NT; t++) { tv.set([...m.tris[t], m.restArea[t]], t * 4); te.set([m.triEdges[t * 3], m.triEdges[t * 3 + 1], m.triEdges[t * 3 + 2], 1], t * 4); }
  tv.set([0, 0, 0, 0], NT * 4); te.set([NL, NL, NL, 0], NT * 4);
  const triV = instancedArray(tv, 'vec4'), triE = instancedArray(te, 'vec4');
  const counters = instancedArray(new Uint32Array(4), 'uint').toAtomic();
  const acc = instancedArray(new Int32Array(12), 'int').toAtomic(); // 0 volume, 1 area, 2-4 pinch force, 5 pinch weight, 6-8 momentum
  // strands (as the shell membrane's): sA = (end in the white, vertex), sB = (volume, state 1 attached 2 snapped, length, time since)
  const a0 = new Float32Array(NS * 4), b0 = new Float32Array(NS * 4);
  strands.forEach(([pt, vi, vol], s) => { a0.set([...pt, vi], s * 4); b0.set([vol, 1, Math.hypot(...pt.map((x, k) => x - p0[vi * 4 + k])), 0], s * 4); });
  const sA = instancedArray(a0, 'vec4'), sB = instancedArray(b0, 'vec4');

  const dt = uniform(1 / 60 / substeps), grav = uniform(new Vector3(0, -YP.gravity, 0)), frameDt = uniform(1 / 60);
  const cohesion = uniform(YP.cohesion), damp = uniform(YP.damp), omega = uniform(YP.omega), vmax = uniform(YP.vmax), comp = uniform(YP.comp), bendK = uniform(YP.bendK), stretchK = uniform(YP.stretch);
  const vol0 = uniform(m.volume), volK = uniform(YP.volK / (2 * iters)), smooth = uniform(YP.smooth), orig = uniform(new Vector3(...center));
  const tFrom = uniform(new Vector3()), tTo = uniform(new Vector3()), alpha = uniform(1), grip = uniform(0.5), hold = uniform(1), squeeze = uniform(YP.squeeze);
  const crush = uniform(YP.crush), pickPos = uniform(new Vector3()), pinchR = uniform(YP.pinchR), pinching = uniform(0);
  const wetDrag = uniform(YP.wetDrag), whiteDrag = uniform(YP.whiteDrag), strandK = uniform(YP.strandK), strandDraw = uniform(YP.strandDraw), strandMinR = uniform(YP.strandMinR);
  const rimArr = uniformArray(Array.from(table), 'float'), tearOn = uniform(1);
  const boardHW = uniform(BOARD.w / 2), boardHD = uniform(BOARD.d / 2);

  const eggR = Fn(([d]) => { const q = d.x.mul(d.x).add(d.z.mul(d.z)).div(A * A).add(d.y.mul(d.y).div(B * B)); return d.y.mul(KEGG).add(1).mul(q.inverseSqrt()); });
  const rimAt = Fn(([th]) => {
    const u = th.add(Math.PI).div(2 * Math.PI).mul(RIM_N);
    const i0 = int(floor(u)).toVar();
    If(i0.greaterThanEqual(RIM_N), () => { i0.assign(0); });
    const i1 = select(i0.add(1).greaterThanEqual(RIM_N), int(0), i0.add(1));
    return mix(rimArr.element(i0), rimArr.element(i1), fract(u));
  });
  // the shell (both faces, where it is still there), the egg cup outside it, the bowl's wall, and the board. mt is
  // the margin kept: collide(p, mt) with a wider margin tells whether p is touching
  const collide = Fn(([p0, mt]) => {
    const p = vec3(p0).toVar();
    const L = length(p).max(1e-5), d = p.div(L).toVar(), rin = eggR(d), s = L.sub(rin);
    const covered = acos(clamp(d.y.negate(), -1, 1)).lessThan(rimAt(atan(d.z, d.x)));
    If(covered.and(s.greaterThan(mt.negate())).and(s.lessThan(mt.add(THICK))), () => {
      p.assign(d.mul(select(s.lessThan(THICK * 0.5), rin.sub(mt), rin.add(THICK).add(mt))));
    });
    const rxz = length(p.xz).max(1e-5);
    If(p.y.lessThan(CUP.top).and(p.y.greaterThan(CUP.bot)).and(length(p).greaterThan(eggR(normalize(p)).add(THICK))), () => {
      const t = clamp(p.y.negate().add(CUP.top).div(CUP.top - CUP.bot), 0, 1);
      const rc = t.mul(t).mul(-0.9).add(1).sqrt().mul(CUP.rTop).add(mt);
      If(rxz.lessThan(rc), () => { p.xz.assign(p.xz.mul(rc.div(rxz))); });
    });
    const q = p.sub(vec3(BOWL.x, BOWL.cy, BOWL.z)), qd = length(q).max(1e-5);
    If(p.y.lessThan(BOWL.top + 0.05).and(qd.greaterThan(float(BOWL.Rs).sub(mt))).and(qd.lessThan(mt.add(BOWL.Rs + BOWL.t))), () => {
      p.assign(vec3(BOWL.x, BOWL.cy, BOWL.z).add(q.div(qd).mul(select(qd.lessThan(BOWL.Rs + BOWL.t * 0.5), float(BOWL.Rs).sub(mt), mt.add(BOWL.Rs + BOWL.t)))));
    });
    const onBoard = p.x.abs().lessThan(boardHW).and(p.z.abs().lessThan(boardHD));
    If(onBoard.and(p.y.lessThan(mt.add(TABLE_Y))).and(p.y.greaterThan(TABLE_Y - 1.5)), () => { p.y.assign(mt.add(TABLE_Y)); });
    return p;
  });
  const inWhite = Fn(([p]) => {
    const L = length(p).max(1e-5), d = p.div(L);
    return L.lessThan(eggR(d)).and(p.y.lessThan(WHITE_Y)).and(acos(clamp(d.y.negate(), -1, 1)).lessThan(rimAt(atan(d.z, d.x))));
  });

  const predict = Fn(() => {
    const i = int(instanceIndex);
    const x = pos.element(i).xyz.toVar();
    const v = x.sub(prev.element(i).xyz).mul(damp).toVar();
    const vm = vec3(float(atomicLoad(acc.element(6))), float(atomicLoad(acc.element(7))), float(atomicLoad(acc.element(8)))).div(VS * N);
    v.assign(mix(v, vm.mul(damp), cohesion));
    // wet contact drags, and so does the egg white
    const touching = length(collide(x, float(0.02)).sub(x)).greaterThan(1e-6);
    v.mulAssign(select(touching, wetDrag, float(1)).mul(select(inWhite(x), whiteDrag, float(1))));
    const sp = length(v);
    If(sp.greaterThan(vmax.mul(dt)), () => { v.mulAssign(vmax.mul(dt).div(sp)); });
    prev.element(i).assign(vec4(x, 1));
    pos.element(i).assign(vec4(x.add(v).add(grav.mul(dt.mul(dt))), 1));
  })().compute(N);

  // the volume and area of the closed skin, about `orig` (near its middle, so the sums don't cancel big numbers)
  const resetVol = Fn(() => { atomicStore(acc.element(0), int(0)); atomicStore(acc.element(1), int(0)); })().compute(1);
  const resetFrame = Fn(() => { for (const k of [2, 3, 4]) atomicStore(acc.element(k), int(0)); atomicStore(counters.element(1), uint(0)); })().compute(1);
  const volPass = Fn(() => {
    const t = int(instanceIndex), T = triV.element(t);
    const a = pos.element(int(T.x)).xyz.sub(orig), b = pos.element(int(T.y)).xyz.sub(orig), c = pos.element(int(T.z)).xyz.sub(orig);
    const cr = cross(b.sub(a), c.sub(a));
    atomicAdd(acc.element(0), int(dot(a, cross(b, c)).div(6).mul(VS)));
    atomicAdd(acc.element(1), int(length(cr).mul(0.5 * VS)));
  })().compute(NT);

  const resetMom = Fn(() => { for (const k of [6, 7, 8]) atomicStore(acc.element(k), int(0)); })().compute(1);
  const momPass = Fn(() => {
    const i = int(instanceIndex), v = pos.element(i).xyz.sub(prev.element(i).xyz);
    atomicAdd(acc.element(6), int(v.x.mul(VS))); atomicAdd(acc.element(7), int(v.y.mul(VS))); atomicAdd(acc.element(8), int(v.z.mul(VS)));
  })().compute(N);
  const solve = (src, dst) => Fn(() => {
    const i = int(instanceIndex);
    const xi = src.element(i).xyz.toVar();
    const dx = vec3(0).toVar(), wsum = float(0).toVar();
    Loop(MAXL, ({ i: k }) => {
      const L = links.element(adj.element(i.mul(MAXL).add(k))).toVar();
      const o = select(int(L.x).equal(i), int(L.y), int(L.x));
      const d = src.element(o).xyz.sub(xi).toVar(), len = length(d).max(1e-6), C = len.sub(L.z);
      const w = L.w.mul(select(C.lessThan(0).and(L.w.greaterThan(0.5)), comp, float(1)));
      dx.addAssign(d.mul(C.div(len).mul(0.5).mul(w)));
      wsum.addAssign(w);
    });
    const x = xi.add(dx.mul(omega).mul(stretchK).div(wsum.max(1))).toVar();
    // volume: out along the normal by the lost volume over the area
    const n = vec3(0).toVar();
    Loop(MAXT, ({ i: k }) => {
      const T = triV.element(vtris.element(i.mul(MAXT).add(k))).toVar();
      const a = src.element(int(T.x)).xyz;
      n.addAssign(cross(src.element(int(T.y)).xyz.sub(a), src.element(int(T.z)).xyz.sub(a)));
    });
    const V = float(atomicLoad(acc.element(0))).div(VS), Ar = float(atomicLoad(acc.element(1))).div(VS).max(1e-3);
    x.addAssign(normalize(n.add(vec3(0, 1e-9, 0))).mul(vol0.sub(V).div(Ar).mul(volK)));
    // the pinch: what it holds goes to the fingertip, the patch squeezed together by the grip; the pull it gives is
    // the force on the fingers
    const g = grab.element(i).toVar();
    If(g.w.greaterThan(0).and(pinching.greaterThan(0.5)), () => {
      const tip = mix(tFrom, tTo, alpha);
      const target = tip.add(g.xyz.mul(float(1).sub(squeeze.mul(grip))));
      const k = g.w.mul(hold);
      const f = target.sub(x).mul(k);
      atomicAdd(acc.element(2), int(f.x.mul(VS))); atomicAdd(acc.element(3), int(f.y.mul(VS))); atomicAdd(acc.element(4), int(f.z.mul(VS)));
      x.addAssign(f);
    });
    dst.element(i).assign(vec4(collide(x, float(0.006)), 1));
  })().compute(N);
  const solveAB = solve(pos, posB), solveBA = solve(posB, pos);

  const linkPass = Fn(() => {
    const li = int(instanceIndex);
    const L = links.element(li).toVar(), M = meta.element(li).toVar();
    const len = length(pos.element(int(L.y)).xyz.sub(pos.element(int(L.x)).xyz));
    If(M.w.greaterThanEqual(0), () => {
      links.element(li).w.assign(select(links.element(int(M.w)).w.greaterThan(0.5), bendK, float(0)));
    }).ElseIf(M.w.greaterThan(-1.5).and(L.w.greaterThan(0.5)), () => {
      const e = len.div(L.z).sub(1), es = mix(M.y, e, smooth);
      // skin between the fingers is creased and crushed: the harder the grip, the less it takes
      const pin = max(grab.element(int(L.x)).w, grab.element(int(L.y)).w).mul(pinching);
      const thr = M.z.mul(float(1).sub(crush.mul(grip).mul(pin)));
      If(es.greaterThan(thr).and(tearOn.greaterThan(0.5)), () => { links.element(li).w.assign(0); atomicAdd(counters.element(0), uint(1)); });
      // how near the link is to breaking (x1000): the HUD's yolk skin bar
      atomicMax(counters.element(1), uint(clamp(es.div(thr), 0, 50).mul(1000)));
      meta.element(li).y.assign(es);
    });
  })().compute(NL);

  // the chalazae: their own length follows the span viscously; tension pulls the vertex back; thin enough, they snap
  const strandPass = Fn(() => {
    const s = int(instanceIndex);
    const S = sA.element(s).toVar(), Bv = sB.element(s).toVar();
    If(Bv.y.greaterThan(0.5).and(Bv.y.lessThan(1.5)), () => {
      const vi = int(S.w), x = pos.element(vi).xyz.toVar();
      const d = x.sub(S.xyz), D = length(d).max(1e-5);
      const Ls = mix(Bv.z, D, strandDraw).max(0.01), r = Bv.x.div(Ls.mul(Math.PI)).sqrt();
      If(r.lessThan(strandMinR), () => { sB.element(s).assign(vec4(Bv.x, 2, D, 0)); atomicAdd(counters.element(2), uint(1)); }).Else(() => {
        const taut = D.sub(Ls).max(0).div(D);
        pos.element(vi).assign(vec4(x.sub(d.mul(taut.mul(strandK))), 1));
        sB.element(s).z.assign(Ls);
      });
    });
  })().compute(NS);
  const strandAge = Fn(() => {
    const s = int(instanceIndex);
    If(sB.element(s).y.greaterThan(1.5), () => { sB.element(s).w.addAssign(frameDt); If(sB.element(s).w.greaterThan(0.9), () => { sB.element(s).assign(vec4(0)); }); });
  })().compute(NS);

  const triPass = Fn(() => {
    const t = int(instanceIndex), E = triE.element(t);
    triE.element(t).w.assign(select(links.element(int(E.x)).w.greaterThan(0.5).and(links.element(int(E.y)).w.greaterThan(0.5)).and(links.element(int(E.z)).w.greaterThan(0.5)), float(1), float(0)));
  })().compute(NT);
  // vertex normals and how stretched the skin is round each vertex (area now / area at rest)
  const normalPass = Fn(() => {
    const i = int(instanceIndex);
    const n = vec3(0).toVar(), ac = float(0).toVar(), ar = float(0).toVar();
    Loop(MAXT, ({ i: k }) => {
      const t = vtris.element(i.mul(MAXT).add(k)), T = triV.element(t).toVar();
      const p0 = pos.element(int(T.x)).xyz.toVar();
      const c = cross(pos.element(int(T.y)).xyz.sub(p0), pos.element(int(T.z)).xyz.sub(p0)).toVar();
      n.addAssign(c); ac.addAssign(length(c).mul(0.5)); ar.addAssign(T.w);
    });
    normal.element(i).assign(vec4(normalize(n.add(vec3(0, 1e-9, 0))), ac.div(ar.max(1e-9))));
  })().compute(N);

  const grabStart = Fn(() => {
    const i = int(instanceIndex), x = pos.element(i).xyz;
    const w = smoothstep(pinchR, pinchR.mul(0.75), length(x.sub(pickPos)));
    grab.element(i).assign(vec4(x.sub(pickPos), w));
    If(w.greaterThan(0), () => { atomicAdd(acc.element(5), int(w.mul(1000))); });
  })().compute(N);
  // after it has settled in the shell: its skin's rest lengths are the lengths it has now, so its strain counts
  // from the yolk lying at rest
  const rebase = Fn(() => {
    const li = int(instanceIndex), L = links.element(li);
    const len = length(pos.element(int(L.y)).xyz.sub(pos.element(int(L.x)).xyz));
    If(li.lessThan(NL), () => { links.element(li).z.assign(len); meta.element(li).x.assign(len); meta.element(li).y.assign(0); });
  })().compute(NL);
  const resetCounters = Fn(() => { atomicStore(counters.element(0), uint(0)); atomicStore(counters.element(1), uint(0)); })().compute(1);
  const grabEnd = Fn(() => { grab.element(int(instanceIndex)).assign(vec4(0)); })().compute(N);
  const resetW = Fn(() => { atomicStore(acc.element(5), int(0)); })().compute(1);

  let renderer = null;
  const sim = {
    N, NL, NT, m, substeps, iters, P: YP, strandSlots: NS,
    buffers: { pos, normal, triE, links, counters, sA, sB, acc },
    uniforms: { crush, cohesion, grav, grip, hold, squeeze, vol0, stretchK, comp, bendK, pinchR, wetDrag, whiteDrag, strandK, orig, volK },
    init(r) { renderer = r; },
    stepped: false,
    // let it slump into the shell, with no tearing, then count strain from there
    settle(n = 150) { tearOn.value = 0; for (let i = 0; i < n; i++) this.step(); renderer.compute([rebase, resetCounters]); tearOn.value = 1; },
    step() {
      this.stepped = true;
      renderer.compute(resetFrame);
      for (let s = 0; s < substeps; s++) {
        alpha.value = (s + 1) / substeps;
        const list = [predict, resetVol, volPass];
        for (let k = 0; k < iters; k++) list.push(solveAB, solveBA);
        list.push(strandPass, linkPass, resetMom, momPass);
        renderer.compute(list);
      }
      tFrom.value.copy(tTo.value);
      renderer.compute([triPass, normalPass, strandAge]);
    },
    grabStart(p) {
      pickPos.value.set(...p); tFrom.value.set(...p); tTo.value.copy(tFrom.value);
      renderer.compute([resetW, grabStart]); pinching.value = 1; hold.value = 1;
    },
    grabMove(x, y, z) { tTo.value.set(x, y, z); },
    grabEnd() { renderer.compute(grabEnd); pinching.value = 0; },
    // the force on the fingers, per substep and solve, in the sim's units, and the pinch's weight
    force: (a) => [a[2] / VS, a[3] / VS, a[4] / VS],
    async readPositions() { return new Float32Array(await renderer.getArrayBufferAsync(pos.value)); },
    async readCounters() { return new Uint32Array(await renderer.getArrayBufferAsync(counters.value)); },
    async readAcc() { return new Int32Array(await renderer.getArrayBufferAsync(acc.value)); },
    async readStrands() { return new Float32Array(await renderer.getArrayBufferAsync(sB.value)); },
  };
  return sim;
}

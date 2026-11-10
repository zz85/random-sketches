// sim.js - Membrane: the shell membrane as a GPU cloth in TSL compute shaders.
// Position-based dynamics with a Jacobi solve (each vertex gathers its own links, so no graph colouring):
//   predict  Verlet step with gravity and air damping
//   solve    links pull their two ends toward the rest length (stiff in tension, soft in compression so the
//            sheet wrinkles instead of shrinking), bend links across each pair of triangles keep it from
//            folding like paper, the glue pulls attached vertices back to the shell and lets go where the
//            sheet pulls a vertex further from it than the glue can hold (that is the peel front moving), the pinch holds what it holds, and the
//            shell, the egg cup and the table push it out
//   links    strain past the yield point stretches the link for good (the membrane stays baggy where you
//            pulled it); strain past the link's own threshold breaks it, and so a tear runs. A fast pull tears
//            sooner by itself: the sheet far from the fingertip can't follow in time, so the strain piles up
//            next to it
//   glorp    the membrane of a raw egg is wet: its velocity is smoothed over its neighbours (viscous, so it
//            moves as one floppy sheet), the bare shell it leaves is wet and dries over seconds, a peeled patch
//            laid back on wet shell sticks again (weakly), and some peeled spots draw a thread of egg white
//            from the shell that stretches, thins (its volume is kept) and snaps, the halves drooping back
// The shell can be picked up: the sim runs in the shell's own frame, so gravity, the table and the fingertip are
// turned into that frame each step, and as the shell moves, each loose vertex is moved the other way (it keeps
// its place in the world, so a quick turn slops the loose sheet about). The cup only counts while the shell sits.
// A tear is soft: a link close to breaking necks (flows plastically, so little stretch is stored), a broken link
// lets go over a few substeps, and the vertices round a fresh break are damped, so it parts rather than snaps.
// Counters (atomics): links torn, vertices peeled, the largest strain this frame (x1000), the strand ring's
// cursor, vertices stuck back, strands snapped, strands drawn.
import { Fn, instancedArray, instanceIndex, uniform, uniformArray, float, int, uint, vec3, vec4, If, Loop, select, max, length, normalize, cross, mix,
  vec2, clamp, atan, acos, floor, fract, hash, atomicAdd, atomicMax, atomicStore, smoothstep, dot } from 'three/tsl';
import { Vector3, Matrix4 } from 'three/webgpu';
import { A, B, KEGG, THICK, RIM_N, MAXL, MAXT } from './egg.js';

export const TABLE_Y = -4.25;
// egg cup bowl: outer radius by height (it holds the shell below y = CUP_TOP)
export const CUP_TOP = -1.25;
// the bowl's outer radius falls from rTop at its rim to sqrt(0.1) rTop at its bottom
export const CUP = { top: CUP_TOP, bot: -3.1, rTop: 2.04 };
export const cupOuter = (y) => { const t = Math.max(0, Math.min(1, (CUP.top - y) / (CUP.top - CUP.bot))); return CUP.rTop * Math.sqrt(1 - 0.9 * t * t); };

export const P = {
  gravity: 50,       // cm/s^2: less than g, since a sheet this light is held up by its own stiffness, which a few
                     // Jacobi iterations can't carry across the mesh in one substep
  damp: 0.996,       // velocity kept per substep
  omega: 1.5,        // Jacobi over-relaxation
  vmax: 60,          // cm/s
  visc: 0.25,        // share of each vertex's velocity replaced by its neighbours' mean, per substep
  dry: 9,            // seconds for the bare shell to dry
  reglue: 0.03,      // cm: a peeled vertex laid back this close to its place on wet shell sticks again
  strandP: 0.008,    // chance a peeling vertex draws a strand
  strandDraw: 0.04,  // how fast a strand's own length follows the distance it spans, per substep (viscous drawing)
  strandK: 0.04,     // how hard a taut strand pulls its vertex back toward the shell
  strandMinR: 0.0035,// cm: a strand thinner than this snaps
  comp: 0.12,        // stiffness in compression, relative to tension
  bendK: 0.08,       // bend link weight
  adh: 0.55,         // glue pull per iteration
  adhBreak: 0.08,     // peel strength: the load (strain x (1 - cos peel angle), summed over the links to the peeled
                     // sheet) at which the glue lets go of a vertex. Below the tear strain, so a pull off the wall or
                     // back over the glued sheet peels, and one along the wall, away from it, tears
  yield: 0.15,       // strain where the membrane starts to stretch for good
  creep: 0.002,      // how fast it does, per substep
  tear: 0.5,         // breaking strain (each link draws its own, +-25%)
  smooth: 0.2,       // the breaking test reads the strain low-passed over a few substeps, so a one-substep spike
                     // of the solver doesn't snap a link; a real pull holds the strain long enough to tear
  maxPlastic: 1.9,   // a link stretched for good past this length ratio breaks
  neck: 0.05,        // extra plastic flow per substep as a link's strain nears its breaking strain (necking)
  fade: 0.7,         // a broken link keeps this share of its weight each substep, so it lets go over a few
  slosh: 0.04,       // share of the shell's move that a loose vertex lags behind
  kendall: 0.6,      // how much the peel angle matters: load x (1 + kendall x cos(arm, glued side))
  peelFloor: 0.03,   // strain an arm must pass before it loads the glue at all
  reach: 0.996,      // the pinch's reach along loose sheet, kept per link it crosses (and per substep without a pinch)
  selfLoad: 0.08,    // share of the peel load that counts where no pinch reaches: the sheet's own weight, and a
                     // shell turned upside down, peel only this much (wet membrane clings; its weight is nothing)
  calm: 0.82,        // velocity kept per substep by a vertex next to a fresh break (decays back to damp)
};

export const NS = 40; // strand slots

export function makeSim(m, table, { substeps = 8, iters = 3 } = {}) {
  const N = m.N, NL = m.NL, NT = m.NT;
  // per vertex
  const pos0 = new Float32Array(N * 4), prev0 = new Float32Array(N * 4), anc0 = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < 3; k++) { pos0[i * 4 + k] = m.start[i * 3 + k]; prev0[i * 4 + k] = m.start[i * 3 + k]; anc0[i * 4 + k] = m.pos[i * 3 + k]; }
    pos0[i * 4 + 3] = 1;
    // glue strength: weaker near the crack, and a little patchy
    const nearRim = Math.min(1, Math.max(0.5, m.depth[i] / 0.25));
    prev0[i * 4 + 3] = nearRim;
    anc0[i * 4 + 3] = m.flap[i] ? 0 : 1;
  }
  const pos = instancedArray(pos0, 'vec4'), posB = instancedArray(new Float32Array(pos0), 'vec4');
  const prev = instancedArray(prev0, 'vec4'), anchor = instancedArray(anc0, 'vec4');
  const grab = instancedArray(new Float32Array(N * 4), 'vec4');
  const normal = instancedArray(new Float32Array(N * 4), 'vec4');
  // per link (+1 dummy at the end, dead): data = (a, b, rest, weight), meta = (rest0, smoothed strain, tearStrain, parent)
  const ld = new Float32Array((NL + 1) * 4), lm = new Float32Array((NL + 1) * 4);
  const r = (i) => { const x = Math.sin(i * 12.9898 + 4.1414) * 43758.5453; return x - Math.floor(x); };
  for (let i = 0; i < NL; i++) {
    const [a, b, rest, parent] = m.links[i];
    ld.set([a, b, rest, parent < 0 ? 1 : P.bendK], i * 4);
    lm.set([rest, 0, P.tear * (0.75 + 0.5 * r(i)), parent], i * 4);
  }
  ld.set([0, 0, 1, 0], NL * 4); lm.set([1, 1, 99, -2], NL * 4);
  const links = instancedArray(ld, 'vec4'), meta = instancedArray(lm, 'vec4');
  const adj = instancedArray(new Int32Array(m.adj), 'int');
  const vtris = instancedArray(new Int32Array(m.vtris), 'int');
  // per triangle (+1 dummy, dead): verts (a, b, c, restArea), edges (e0, e1, e2, alive)
  const tv = new Float32Array((NT + 1) * 4), te = new Float32Array((NT + 1) * 4);
  for (let t = 0; t < NT; t++) {
    tv.set([...m.tris[t], m.restArea[t]], t * 4);
    te.set([m.triEdges[t * 3], m.triEdges[t * 3 + 1], m.triEdges[t * 3 + 2], 1], t * 4);
  }
  tv.set([0, 0, 0, 1], NT * 4); te.set([NL, NL, NL, 0], NT * 4);
  const triV = instancedArray(tv, 'vec4'), triE = instancedArray(te, 'vec4');
  const counters = instancedArray(new Uint32Array(8), 'uint').toAtomic();
  const wet = instancedArray(new Float32Array(N), 'float');
  // strands: sA = (shell point, vertex), sB = (volume, state, length at the snap or own length, time since the snap)
  // state 0 free, 1 attached, 2 snapped
  const sA = instancedArray(new Float32Array(NS * 4), 'vec4'), sB = instancedArray(new Float32Array(NS * 4), 'vec4');
  // x: 1 at a fresh break, decaying; y: 1 once a peeled vertex has been lifted well clear of the shell
  const calmB = instancedArray(new Float32Array(N * 2), 'vec2');
  // how much the pinch reaches each vertex through loose sheet: 1 under the fingertip, falling off along the sheet
  const pullB = instancedArray(new Float32Array(N), 'float');

  const dt = uniform(1 / 60 / substeps);
  const grav = uniform(new Vector3(0, -P.gravity, 0)), vmax = uniform(P.vmax), visc = uniform(P.visc), frameDt = uniform(1 / 60);
  const reglue = uniform(P.reglue), strandP = uniform(P.strandP), strandDraw = uniform(P.strandDraw), strandK = uniform(P.strandK), strandMinR = uniform(P.strandMinR);
  const stepNo = uniform(0);
  // the shell's frame: table plane in it (dot(p, tblN) >= tblD), whether the cup counts, and the move to undo
  const tblN = uniform(new Vector3(0, 1, 0)), tblD = uniform(TABLE_Y), cupOn = uniform(1), moveM = uniform(new Matrix4());
  const pinching = uniform(0), reach = uniform(P.reach), selfLoad = uniform(P.selfLoad), kendall = uniform(P.kendall), peelFloor = uniform(P.peelFloor), slosh = uniform(P.slosh), neck = uniform(P.neck), fade = uniform(P.fade), calmK = uniform(P.calm);
  const damp = uniform(P.damp), omega = uniform(P.omega), comp = uniform(P.comp), adhK = uniform(P.adh), adhBreak = uniform(P.adhBreak);
  const yieldS = uniform(P.yield), creep = uniform(P.creep), smooth = uniform(P.smooth), maxPlastic = uniform(P.maxPlastic), bendK = uniform(P.bendK);
  const tFrom = uniform(new Vector3()), tTo = uniform(new Vector3()), alpha = uniform(1);
  const pickPos = uniform(new Vector3()), pickAnc = uniform(new Vector3()), pinchR = uniform(0.25);
  const rimArr = uniformArray(Array.from(table), 'float');

  // ---- shared shape functions on the GPU
  const eggR = Fn(([d]) => {
    const q = d.x.mul(d.x).add(d.z.mul(d.z)).div(A * A).add(d.y.mul(d.y).div(B * B));
    return d.y.mul(KEGG).add(1).mul(q.inverseSqrt());
  });
  const rimAt = Fn(([th]) => {
    const u = th.add(Math.PI).div(2 * Math.PI).mul(RIM_N);
    const i0 = int(floor(u)).toVar();
    If(i0.greaterThanEqual(RIM_N), () => { i0.assign(0); });
    const i1 = select(i0.add(1).greaterThanEqual(RIM_N), int(0), i0.add(1));
    return mix(rimArr.element(i0), rimArr.element(i1), fract(u));
  });
  const collide = Fn(([p0]) => {
    const p = vec3(p0).toVar();
    const L = length(p).max(1e-5);
    const d = p.div(L).toVar();
    const rin = eggR(d);
    const s = L.sub(rin);
    const phi = acos(clamp(d.y.negate(), -1, 1));
    const covered = phi.lessThan(rimAt(atan(d.z, d.x)));
    const mt = float(0.008);
    If(covered.and(s.greaterThan(mt.negate())).and(s.lessThan(THICK + 0.008)), () => {
      p.assign(d.mul(select(s.lessThan(THICK * 0.5), rin.sub(mt), rin.add(THICK).add(mt))));
    });
    // egg cup bowl (its rim hugs the shell), while the shell sits in it, and the table
    const rxz = length(p.xz).max(1e-5);
    If(cupOn.greaterThan(0.5).and(p.y.lessThan(CUP.top)).and(p.y.greaterThan(CUP.bot)), () => {
      const t = clamp(p.y.negate().add(CUP.top).div(CUP.top - CUP.bot), 0, 1);
      const rc = t.mul(t).mul(-0.9).add(1).sqrt().mul(CUP.rTop).add(0.01);
      // inside the porcelain (under the cup's lip and outside the shell): leave by the nearer way, out
      // through the cup's side or up over its lip, so the shell and the cup never pass a vertex between them
      If(rxz.lessThan(rc).and(L.greaterThan(rin.add(THICK))), () => {
        const up = float(CUP.top + 0.01).sub(p.y), out = rc.sub(rxz);
        If(up.lessThan(out), () => { p.y.assign(CUP.top + 0.01); }).Else(() => { p.xz.assign(p.xz.mul(rc.div(rxz))); });
      });
    });
    const h = dot(p, tblN).sub(tblD.add(0.01));
    If(h.lessThan(0), () => { p.subAssign(tblN.mul(h)); });
    return p;
  });

  // ---- kernels
  // viscosity (XSPH): each vertex's velocity eased toward its live neighbours' mean, into posB as scratch
  const viscPass = Fn(() => {
    const i = int(instanceIndex);
    const vi = pos.element(i).xyz.sub(prev.element(i).xyz).toVar();
    const acc = vec3(0).toVar(), n = float(0).toVar(), reachN = float(0).toVar();
    Loop(MAXL, ({ i: k }) => {
      const L = links.element(adj.element(i.mul(MAXL).add(k))).toVar();
      const o = select(int(L.x).equal(i), int(L.y), int(L.x));
      const live = select(L.w.greaterThan(0.5), float(1), float(0));
      acc.addAssign(pos.element(o).xyz.sub(prev.element(o).xyz).mul(live)); n.addAssign(live);
      // the pinch's reach comes through live links from loose sheet only: glued sheet carries the load into the shell
      reachN.assign(max(reachN, pullB.element(o).mul(live).mul(select(anchor.element(o).w.lessThan(0.5), float(1), float(0)))));
    });
    pullB.element(i).assign(max(grab.element(i).w.min(1), reachN.mul(reach)).mul(pinching));
    const vs = select(n.greaterThan(0), mix(vi, acc.div(n.max(1)), visc.mul(float(1).sub(anchor.element(i).w))), vi);
    posB.element(i).assign(vec4(vs, 0));
  })().compute(N);

  const predict = Fn(() => {
    const i = int(instanceIndex);
    const x = pos.element(i).xyz.toVar(), pv = prev.element(i).toVar();
    const cl = calmB.element(i).toVar();
    const v0 = posB.element(i).xyz.mul(mix(damp, calmK, cl.x)).toVar();
    // speed limit: torn edges snap back hard in one substep, and a membrane in air never moves that fast
    const sp = length(v0);
    If(sp.greaterThan(vmax.mul(dt)), () => { v0.mulAssign(vmax.mul(dt).div(sp)); });
    const v = v0.add(grav.mul(dt.mul(dt)));
    // laid back on wet shell, slowly, and not held: it sticks again, weakly (a shell that dried won't take it)
    const an = anchor.element(i).toVar(), wt = wet.element(i);
    const off = length(x.sub(an.xyz));
    If(an.w.lessThan(0.5).and(off.greaterThan(0.6)), () => { cl.y.assign(1); });
    // only a patch that was lifted away and laid back sticks: the peel front itself, creeping off, doesn't
    If(an.w.lessThan(0.5).and(cl.y.greaterThan(0.5)).and(wt.greaterThan(0.15)).and(wt.lessThan(0.97)).and(grab.element(i).w.lessThan(0.01))
      .and(length(x.sub(an.xyz)).lessThan(reglue)).and(length(v0).lessThan(dt.mul(3))), () => {
      anchor.element(i).w.assign(1); atomicAdd(counters.element(4), uint(1)); cl.y.assign(0);
      pv.w.assign(pv.w.mul(0.45).max(0.12));
    });
    calmB.element(i).assign(vec2(cl.x.mul(0.9), cl.y));
    prev.element(i).assign(vec4(x, pv.w));
    pos.element(i).assign(vec4(x.add(v), 1));
  })().compute(N);

  const solve = (src, dst) => Fn(() => {
    const i = int(instanceIndex);
    const xi = src.element(i).xyz.toVar();
    const acc = vec3(0).toVar(), wsum = float(0).toVar(), tens = float(0).toVar(), arm = vec3(0).toVar(), toGlued = vec3(0).toVar();
    const an = anchor.element(i).toVar();
    const nOut = normalize(an.xyz);
    Loop(MAXL, ({ i: k }) => {
      const L = links.element(adj.element(i.mul(MAXL).add(k))).toVar();
      const a = int(L.x), b = int(L.y);
      const o = select(a.equal(i), b, a);
      const d = src.element(o).xyz.sub(xi).toVar();
      const len = length(d).max(1e-6);
      const C = len.sub(L.z);
      const w = L.w.mul(select(C.lessThan(0).and(L.w.greaterThan(0.5)), comp, float(1)));
      acc.addAssign(d.mul(C.div(len).mul(0.5).mul(w)));
      wsum.addAssign(w);
      // for the peel load: tension in links to sheet already off the shell (the peeled arm), and which way the
      // sheet still glued lies (toGlued)
      const live = select(L.w.greaterThan(0.5), float(1), float(0));
      // only an arm that is off the wall counts (its far end lifted at least a fraction of a millimetre): the
      // solver's leftover tension in sheet lying flat on the shell doesn't unzip it
      const ao = anchor.element(o).toVar(), glNb = select(ao.w.greaterThan(0.5), float(1), float(0));
      const lifted = smoothstep(0.015, 0.06, length(ao.xyz).sub(length(src.element(o).xyz)));
      const t = C.div(L.z).sub(peelFloor).max(0).mul(float(1).sub(glNb)).mul(live).mul(lifted);
      tens.addAssign(t); arm.addAssign(d.div(len).mul(t));
      toGlued.addAssign(d.div(len).mul(glNb).mul(live));
    });
    // Kendall's peel: the load the glue feels is the arm's tension times (1 - cos theta), theta the angle between the
    // arm and the wall ahead of the front, away from the glued sheet. Straight off the wall is 1; folded back over
    // the glued sheet is easier, dragged along the wall away from it (lap shear) harder, so it tears. Softened by
    // `kendall` (1 is Kendall's own 0 to 2), and tension below `peelFloor` doesn't count, so the flap's own weight
    // and the solver's leftovers don't unzip the sheet by themselves.
    const tg = toGlued.sub(nOut.mul(toGlued.dot(nOut)));
    const G = select(length(tg).greaterThan(1e-5), normalize(tg), vec3(0));
    // the load counts in full only where the pinch reaches the front through loose sheet; the rest is the sheet's
    // own weight, which a wet membrane's cling and this thin a sheet's lightness make all but nothing
    const peel = tens.add(arm.dot(G).mul(kendall)).mul(mix(selfLoad, float(1), pullB.element(i)));
    const x = xi.add(acc.mul(omega).div(wsum.max(1))).toVar();
    If(an.w.greaterThan(0.5), () => {
      // glue strength: patchy, and weaker near the crack (prev.w)
      const thr = adhBreak.mul(prev.element(i).w).mul(hash(instanceIndex).mul(0.8).add(0.6));
      // the glue lets go; anchor.w = 0.25 marks it for spawnPass (the solve is at WebGPU's 8 storage buffers)
      If(peel.greaterThan(thr), () => { anchor.element(i).w.assign(0.25); an.w.assign(0); });
    });
    x.assign(mix(x, an.xyz, adhK.mul(select(an.w.greaterThan(0.5), float(1), float(0)))));
    const g = grab.element(i).toVar();
    If(g.w.greaterThan(0), () => { x.assign(mix(x, mix(tFrom, tTo, alpha).add(g.xyz), g.w)); });
    dst.element(i).assign(vec4(collide(x), 1));
  })().compute(N);
  const solveAB = solve(pos, posB), solveBA = solve(posB, pos);

  const linkPass = Fn(() => {
    const li = int(instanceIndex);
    const L = links.element(li).toVar(), M = meta.element(li).toVar();
    const pa = pos.element(int(L.x)).xyz, pb = pos.element(int(L.y)).xyz;
    const len = length(pb.sub(pa)).toVar();
    If(M.w.greaterThanEqual(0), () => {
      // bend link: lives while its edge does, and slowly takes the shape it is held in (creases stay)
      links.element(li).w.assign(select(links.element(int(M.w)).w.greaterThan(0.5), bendK, float(0)));
      links.element(li).z.assign(mix(L.z, len, 0.0015));
    }).ElseIf(M.w.greaterThan(-1.5).and(L.w.greaterThan(0.5)), () => {
      const e = len.div(L.z).sub(1);
      const es = mix(M.y, e, smooth);
      If(es.greaterThan(M.z).or(L.z.div(M.x).greaterThan(maxPlastic)), () => {
        // broken: dead to everything that asks (< 0.5) at once, but its pull fades out over a few substeps,
        // and its ends are calmed, so the sheet parts instead of springing back
        links.element(li).w.assign(0.45);
        calmB.element(int(L.x)).x.assign(1); calmB.element(int(L.y)).x.assign(1);
        atomicAdd(counters.element(0), uint(1));
      }).ElseIf(e.greaterThan(yieldS), () => {
        // plastic flow, faster as the strain nears breaking: the link necks, so it holds little stretch when it goes
        const k = creep.add(neck.mul(smoothstep(M.z.mul(0.55), M.z, es)));
        links.element(li).z.assign(L.z.add(len.sub(L.z.mul(yieldS.add(1))).mul(k)));
      });
      atomicMax(counters.element(2), uint(clamp(e, 0, 50).mul(1000)));
      meta.element(li).y.assign(es);
    });
    // a broken struct link letting go
    If(M.w.lessThan(0).and(M.w.greaterThan(-1.5)).and(L.w.lessThan(0.5)).and(L.w.greaterThan(0)), () => {
      links.element(li).w.assign(select(L.w.mul(fade).lessThan(0.01), float(0), L.w.mul(fade)));
    });
  })().compute(NL);

  // the shell moved by moveM (old frame to new). A loose vertex that kept its place in the world would move the
  // other way in the shell's frame; but a wet membrane this light is carried along by the air and the egg white
  // (its inertia is nothing next to the drag), so it lags by only `slosh` of the move, position and previous alike
  const movePass = Fn(() => {
    const i = int(instanceIndex);
    If(anchor.element(i).w.lessThan(0.5).and(grab.element(i).w.lessThan(0.5)), () => {
      const p0 = pos.element(i).xyz, q0 = prev.element(i).xyz;
      pos.element(i).assign(vec4(collide(mix(p0, moveM.mul(vec4(p0, 1)).xyz, slosh)), 1));
      prev.element(i).assign(vec4(mix(q0, moveM.mul(vec4(q0, 1)).xyz, slosh), prev.element(i).w));
    });
  })().compute(N);

  // what a peel leaves: the count, a wet spot, and now and then a thread of egg white drawn out of it
  const spawnPass = Fn(() => {
    const i = int(instanceIndex);
    If(anchor.element(i).w.greaterThan(0.2).and(anchor.element(i).w.lessThan(0.3)), () => {
      anchor.element(i).w.assign(0); wet.element(i).assign(1); atomicAdd(counters.element(1), uint(1));
      If(hash(instanceIndex.add(uint(stepNo).mul(7919))).lessThan(strandP), () => {
        const slot = int(atomicAdd(counters.element(3), uint(1)).mod(uint(NS)));
        If(sB.element(slot).y.lessThan(0.5), () => {
          // volume sets where it snaps: pi r^2 L at r = strandMinR, so 0.6e-4 to 2.3e-4 cm^3 snaps at 1.5 to 6 cm
          const vol = hash(instanceIndex.mul(31).add(17)).mul(hash(instanceIndex.add(uint(stepNo)).mul(13)).add(0.2)).mul(1.4e-4).add(0.6e-4);
          sA.element(slot).assign(vec4(anchor.element(i).xyz, float(i)));
          sB.element(slot).assign(vec4(vol, 1, 0.01, 0));
          atomicAdd(counters.element(6), uint(1));
        });
      });
    });
  })().compute(N);

  // strands: their own length follows the span viscously; tension pulls the vertex back; thin enough, they snap
  const strandPass = Fn(() => {
    const s = int(instanceIndex);
    const A = sA.element(s).toVar(), Bv = sB.element(s).toVar();
    If(Bv.y.greaterThan(0.5).and(Bv.y.lessThan(1.5)), () => {
      const vi = int(A.w);
      const x = pos.element(vi).xyz.toVar();
      const d = x.sub(A.xyz), D = length(d).max(1e-5);
      const Ls = mix(Bv.z, D, strandDraw).max(0.01);
      const r = Bv.x.div(Ls.mul(Math.PI)).sqrt();
      If(r.lessThan(strandMinR).or(anchor.element(vi).w.greaterThan(0.5)), () => {
        sB.element(s).assign(vec4(Bv.x, 2, D, 0)); atomicAdd(counters.element(5), uint(1));
      }).Else(() => {
        // a taut thread tugs the sheet back toward the shell (sticky), more as it thickens
        const taut = D.sub(Ls).max(0).div(D);
        pos.element(vi).assign(vec4(x.sub(d.mul(taut.mul(strandK).mul(r.div(0.01).min(2)))), 1));
        sB.element(s).z.assign(Ls);
      });
    });
  })().compute(NS);
  const strandAge = Fn(() => {
    const s = int(instanceIndex);
    If(sB.element(s).y.greaterThan(1.5), () => {
      sB.element(s).w.addAssign(frameDt);
      If(sB.element(s).w.greaterThan(0.9), () => { sB.element(s).assign(vec4(0)); });
    });
  })().compute(NS);

  const triPass = Fn(() => {
    const t = int(instanceIndex);
    const E = triE.element(t);
    const alive = links.element(int(E.x)).w.greaterThan(0.5).and(links.element(int(E.y)).w.greaterThan(0.5)).and(links.element(int(E.z)).w.greaterThan(0.5));
    triE.element(t).w.assign(select(alive, float(1), float(0)));
  })().compute(NT);

  // vertex normals and how stretched the sheet is round each vertex (area now / area at rest)
  const normalPass = Fn(() => {
    const i = int(instanceIndex);
    const n = vec3(0).toVar(), ac = float(0).toVar(), ar = float(0).toVar();
    Loop(MAXT, ({ i: k }) => {
      const t = vtris.element(i.mul(MAXT).add(k));
      const T = triV.element(t).toVar();
      const alive = triE.element(t).w;
      const p0 = pos.element(int(T.x)).xyz.toVar();
      const c = cross(pos.element(int(T.y)).xyz.sub(p0), pos.element(int(T.z)).xyz.sub(p0)).toVar();
      n.addAssign(c.mul(alive));
      ac.addAssign(length(c).mul(0.5).mul(alive));
      ar.addAssign(T.w.mul(alive));
    });
    const fallback = normalize(pos.element(i).xyz).negate();
    const nn = select(length(n).greaterThan(1e-9), normalize(n), fallback);
    normal.element(i).assign(vec4(nn, select(ar.greaterThan(0), ac.div(ar.max(1e-9)), float(1))));
    wet.element(i).assign(wet.element(i).sub(frameDt.div(P.dry)).max(0));
  })().compute(N);

  const resetMax = Fn(() => { atomicStore(counters.element(2), uint(0)); })().compute(1);

  // the pinch: everything within pinchR of the picked point, on the sheet and in space, follows the fingertip
  const grabStart = Fn(() => {
    const i = int(instanceIndex);
    const x = pos.element(i).xyz, an = anchor.element(i).xyz;
    const dr = length(an.sub(pickAnc)), dx = length(x.sub(pickPos));
    const w = smoothstep(pinchR, pinchR.mul(0.55), dr).mul(select(dx.lessThan(pinchR.mul(2)), float(1), float(0)));
    grab.element(i).assign(vec4(x.sub(pickPos), w));
  })().compute(N);
  const grabEnd = Fn(() => { grab.element(int(instanceIndex)).assign(vec4(0)); })().compute(N);

  let renderer = null;
  const sim = {
    N, NL, NT, m, table, substeps, iters, P,
    buffers: { pos, normal, anchor, triE, links, counters, wet, sA, sB },
    uniforms: { visc, strandP, strandK, strandMinR, damp, omega, comp, adhK, adhBreak, yieldS, creep, smooth, maxPlastic, bendK, grav, pinchR, neck, fade, calmK },
    grabbing: false,
    kernels: { viscPass, spawnPass, strandPass, predict, solveAB, solveBA, linkPass, triPass, normalPass, resetMax },
    init(r) { renderer = r; },
    stepped: false,
    // the shell's world matrix now (Matrix4); the sim turns gravity, the table and the move into its frame
    frame: new Matrix4(), moved: false,
    setFrame(M, seated) {
      const inv = M.clone().invert();
      if (!this.frame.equals(M)) { moveM.value.copy(inv).multiply(this.frame); this.moved = true; }
      this.frame.copy(M);
      grav.value.set(0, -P.gravity, 0).transformDirection(inv).multiplyScalar(P.gravity);
      // table: world y >= TABLE_Y, i.e. (M p).y >= TABLE_Y: n = M's second row (rotation part), d = TABLE_Y - ty
      const e = M.elements; tblN.value.set(e[1], e[5], e[9]); tblD.value = TABLE_Y - e[13];
      cupOn.value = seated ? 1 : 0;
    },
    step() {
      this.stepped = true;
      if (this.moved) { renderer.compute(movePass); this.moved = false; }
      renderer.compute(resetMax);
      for (let s = 0; s < substeps; s++) {
        alpha.value = (s + 1) / substeps;
        stepNo.value++;
        const list = [viscPass, predict];
        for (let k = 0; k < iters; k++) list.push(solveAB, solveBA);
        list.push(spawnPass, strandPass, linkPass);
        renderer.compute(list);
      }
      tFrom.value.copy(tTo.value);
      renderer.compute([triPass, normalPass, strandAge]);
    },
    // pinch at the vertex vi, whose current position is p (from a readback)
    grabStart(vi, p) {
      pickPos.value.set(p[0], p[1], p[2]);
      pickAnc.value.set(m.pos[vi * 3], m.pos[vi * 3 + 1], m.pos[vi * 3 + 2]);
      tFrom.value.set(p[0], p[1], p[2]); tTo.value.copy(tFrom.value);
      renderer.compute(grabStart); this.grabbing = true; pinching.value = 1;
    },
    grabMove(x, y, z) { tTo.value.set(x, y, z); },
    grabEnd() { renderer.compute(grabEnd); this.grabbing = false; pinching.value = 0; },
    target: () => tTo.value,
    async readPositions() { return new Float32Array(await renderer.getArrayBufferAsync(pos.value)); },
    async readStrands() { return new Float32Array(await renderer.getArrayBufferAsync(sB.value)); },
    async readCounters() { return new Uint32Array(await renderer.getArrayBufferAsync(counters.value)); },
  };
  return sim;
}

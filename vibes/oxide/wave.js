// wave.js - Oxide: Waveform. A 3D waveform visualizer played on a square of steel painted turquoise. The
// sound's spectrum runs across the plate (low notes in the middle, high ones out to both sides) and its last
// eight seconds scroll toward you, as in the classic visualizers; but the wave isn't a mesh. Where the sound
// is loud the paint rots into rust dust that lifts off the plate as high as the wave and rides it forward,
// so the waveform is a cloud of dust, which falls back as the sound drops and pours off the front edge.
// What the dust leaves behind rusts, and stays: rust comes through where the music was loud, first on the
// spots of the plate most prone to it, spreading along the front, banded by how deep it went and coloured
// by when (orange, purple-brown, ochre, over the minutes), so a song leaves its picture on the plate.
//   field: two state buffers in turn (rust, when it came through, how fast it is coming, how prone the
//   steel is) and a texture of them for drawing, made in TSL compute; dust: a pool of particles in two
//   more buffers, spawned where the wave is high, sprung to its height, blown about, landing and fading.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { Fn, pass, uniform, float, int, vec2, vec3, vec4, ivec2, uv, texture, textureStore, instancedArray, instanceIndex, select, mix, smoothstep, clamp, abs, exp,
  fract, hash, max, sin, cos, dot, length, normalize, step as stepN, If, positionLocal, screenUV, screenSize, time, cameraViewMatrix, varying,
  mx_fractal_noise_float, mx_noise_float, mx_noise_vec3, mx_worley_noise_float } from 'three/tsl';
import { makeAudio, BANDS, ROWS, RATE } from './audio.js';
import { PRESETS } from './field.js';

const Q = new URLSearchParams(location.search.slice(1) + '&' + location.hash.slice(1));
const $ = (id) => document.getElementById(id);
const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
const PL = 12;                                                    // the plate, cm a side
const G = +(Q.get('res') || (phone ? 256 : 512));                 // its field, texels a side
const NP = +(Q.get('dust') || (phone ? 50000 : 160000));          // grains of dust
const E0 = 0.35, PAINT_H = 0.03;                                  // rust shows past E0; the paint's thickness
const C0 = PRESETS.tide;
const col = (a) => vec3(...a);

(async () => {
  if (!navigator.gpu) { $('status').textContent = 'Oxide needs WebGPU: Chrome, Edge, Safari 26 or Firefox 141 and later.'; return; }
  const renderer = new THREE.WebGPURenderer({ canvas: $('gl'), antialias: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, +(Q.get('dpr') || 1)));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  try { await renderer.init(); } catch (e) { $('status').textContent = 'Could not start WebGPU: ' + e.message; return; }
  if (renderer.backend.isWebGLBackend) { $('status').textContent = 'Oxide needs WebGPU: Chrome, Edge, Safari 26 or Firefox 141 and later.'; return; }

  const scene = new THREE.Scene();
  const BG = new THREE.Color(0.012, 0.01, 0.009);
  scene.background = BG; scene.fog = new THREE.FogExp2(BG, 0.022);
  const camera = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.05, 200);
  const HOME = new THREE.Vector3(0, 6.2, 15.5);
  camera.position.copy(HOME);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.07; controls.minDistance = 3; controls.maxDistance = 40; controls.maxPolarAngle = 1.45;
  controls.target.set(0, 1.2, 0); controls.update();

  // a dark room to reflect, with one soft window
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  const envM = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  envM.colorNode = mix(vec3(0.03, 0.022, 0.018), vec3(0.18, 0.22, 0.24), smoothstep(-0.1, 0.8, positionLocal.normalize().y));
  env.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), envM));
  const box = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.8, 2.6), side: THREE.DoubleSide }));
  box.position.set(-5, 6, 3); box.lookAt(0, 0, 0); env.add(box);
  scene.environment = pmrem.fromScene(env, 0.03).texture; scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0x5c9aa6, 0x3a1e10, 0.45));
  const sun = new THREE.DirectionalLight(0xffe2c0, 3.4);
  sun.position.set(-7, 10, -9); sun.castShadow = true;
  const SM = phone ? 1024 : 2048; sun.shadow.mapSize.set(SM, SM);
  Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 40 });
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02; sun.shadow.radius = 2;
  scene.add(sun);

  // ---- sound, and where it stands on the plate
  const audio = makeAudio();
  const U = { dt: uniform(0), head: uniform(0), on: uniform(0), song: uniform(0), frame: uniform(0), amp: uniform(+(Q.get('amp') || 3.2)),
    scroll: uniform((PL * RATE) / (ROWS - 2)), rate: uniform(0.04), seed: uniform(0) };
  // the wave at plate coords (u across, v from the front edge, 0, to the back, 1, where the newest sound is)
  const waveAt = (u, v) => {
    const a = abs(u.sub(0.5)).mul(2).clamp(0, 1);
    const tu = a.mul((BANDS - 1) / BANDS).add(0.5 / BANDS);
    const tv = U.head.sub(float(1).sub(v).mul(ROWS - 3)).add(0.5).div(ROWS);
    const s = texture(audio.tex, vec2(tu, tv)).level(0).x;
    return smoothstep(0.1, 0.95, s).mul(U.on).mul(smoothstep(0.0, 0.02, v)).mul(smoothstep(1.0, 0.985, v));
  };

  // ---- the plate's field: rust, when it came through, how fast it comes, how prone the steel is
  const SA = instancedArray(G * G, 'vec4'), SB = instancedArray(G * G, 'vec4');
  const T = new THREE.StorageTexture(G, G); T.type = THREE.HalfFloatType; T.format = THREE.RGBAFormat;
  T.magFilter = T.minFilter = THREE.LinearFilter; T.generateMipmaps = false; T.wrapS = T.wrapT = THREE.ClampToEdgeWrapping;
  const cell = () => { const j = int(instanceIndex); return { j, x: j.mod(G), y: j.div(G) }; };
  const reset = Fn(() => {
    const { j, x, y } = cell();
    const p = vec2(float(x).add(0.5), float(y).add(0.5)).div(G).mul(PL);
    const q = vec3(p.mul(0.3), U.seed);
    const w = mx_noise_vec3(q.mul(0.7).add(3.1));
    const n = mx_fractal_noise_float(q.add(w.mul(1.4)), 5, 2, 0.5);
    const lace = mx_fractal_noise_float(vec3(p.mul(1.5), U.seed.add(5.3)).add(w.mul(0.5)), 3, 2.1, 0.55);
    const pit = smoothstep(0.32, 0.0, mx_worley_noise_float(vec3(p.mul(0.8), U.seed.add(9.1))));
    const sus = n.mul(0.9).add(lace.mul(0.35)).add(pit.mul(0.4)).add(0.42).clamp(0, 1);
    SA.element(j).assign(vec4(0, 0, 0, sus)); SB.element(j).assign(vec4(0, 0, 0, sus));
    textureStore(T, ivec2(x, y), vec4(0, 0, PAINT_H, 0));
  })().compute(G * G);
  const grow = (src, dst) => Fn(() => {
    const { j, x, y } = cell();
    const S = src.element(j);
    const at = (dx, dy) => src.element(clamp(y.add(dy), 0, G - 1).mul(G).add(clamp(x.add(dx), 0, G - 1))).x;
    const nb = at(2, 0).add(at(-2, 0)).add(at(0, 2)).add(at(0, -2)).mul(0.25);
    const W = waveAt(float(x).add(0.5).div(G), float(y).add(0.5).div(G)), sus = S.w;
    // loud enough here: prone steel goes at a quieter sound; rust next door pulls it on
    const drive = smoothstep(float(0.78).sub(sus.mul(0.55)), 1.0, W);
    const dC = drive.mul(sus.mul(0.8).add(0.15).add(smoothstep(0.3, 0.8, nb).mul(0.5))).mul(U.rate).mul(U.dt).mul(float(1.3).sub(S.x).clamp(0, 1));
    const C = S.x.add(dC);
    const tc = select(S.y.lessThan(0.001).and(C.greaterThan(E0)), U.song.max(0.01), S.y);
    const r = mix(S.z, dC.div(U.dt.max(1e-4)), 0.25);
    dst.element(j).assign(vec4(C, tc, r, sus));
    // relief for drawing: paint, lifting where rust undercuts it, and a crust that thickens as rust deepens
    const cov = smoothstep(E0 + 0.06, E0 - 0.06, C);
    const lift = exp(abs(C.sub(E0)).div(-0.05)).mul(0.04).mul(cov);
    const h = mix(C.sub(E0).clamp(0, 0.8).mul(0.07).add(0.004), float(PAINT_H), cov).add(lift);
    textureStore(T, ivec2(x, y), vec4(C, tc, h, r));
  })().compute(G * G);
  const growAB = grow(SA, SB), growBA = grow(SB, SA);
  let flip = 0;

  // ---- the plate
  const plateG = new THREE.PlaneGeometry(PL, PL, phone ? 192 : 320, phone ? 192 : 320); plateG.rotateX(-Math.PI / 2);
  const plateM = new THREE.MeshPhysicalNodeMaterial({ clearcoatRoughness: 0.12 });
  plateM.positionNode = positionLocal.add(vec3(0, texture(T, uv()).level(0).z, 0));
  {
    const P = uv(), p = P.mul(PL), e = 1 / G;
    const S = texture(T, P), C = S.x, tc = S.y;
    const fineN = mx_fractal_noise_float(vec3(p.mul(2.4), 3.3), 3, 2, 0.5);
    const n2 = mx_noise_float(vec3(p.mul(16), 1.1));
    const edgeOf = (fn, nn) => float(E0).add(fn.mul(0.1)).add(nn.mul(0.025));
    const Ef = edgeOf(fineN, n2);
    const sd = Ef.sub(C);                                              // > 0 on paint
    const cover = smoothstep(-0.008, 0.008, sd);
    // height for the normal: the field's relief, a lip at the paint's ragged edge, crust on the rust
    const hF = (q) => {
      const s = texture(T, q), pq = q.mul(PL);
      const d = edgeOf(mx_fractal_noise_float(vec3(pq.mul(2.4), 3.3), 3, 2, 0.5), mx_noise_float(vec3(pq.mul(16), 1.1))).sub(s.x);
      const cv = smoothstep(-0.008, 0.008, d);
      return s.z.add(exp(abs(d).div(-0.012)).mul(0.012).mul(cv)).add(mx_noise_float(vec3(pq.mul(26), 2.2)).mul(0.006).mul(float(1).sub(cv)))
        .add(mx_noise_float(vec3(pq.mul(7), 4.4)).mul(0.0015).mul(cv));
    };
    const h0 = hF(P), hx = hF(P.add(vec2(e, 0))).sub(h0).div(e * PL), hz = hF(P.add(vec2(0, e))).sub(h0).div(e * PL);
    const nW = normalize(vec3(hx.negate(), 1, hz));                  // v runs toward -z
    plateM.normalNode = normalize(cameraViewMatrix.mul(vec4(nW, 0)).xyz);
    // paint: two tones, chalky, stained where rust bleeds under its edge
    const m1 = mx_fractal_noise_float(vec3(p.mul(0.5), 7.7), 3, 2, 0.5);
    let paint = mix(col(C0.paint), col(C0.paint2), smoothstep(-0.35, 0.45, m1.add(n2.mul(0.15))));
    paint = mix(paint, col(C0.chalkCol), smoothstep(0.1, 0.6, mx_noise_float(vec3(p.mul(3), 5.5)).add(n2.mul(0.2))).mul(0.4));
    paint = mix(paint, col(C0.rB).mul(0.45), exp(sd.max(0).div(-0.03)).mul(0.6));
    // rust: its colour by when it came through, darker as it deepens, tide lines where it rusted deeper, powder at its front
    const ph = fract(tc.div(48)).mul(3);
    const cA = col(C0.rA), cB = vec3(0.3, 0.07, 0.09), cC = vec3(0.62, 0.4, 0.09);
    let rust = select(ph.lessThan(1), mix(cA, cB, ph), select(ph.lessThan(2), mix(cB, cC, ph.sub(1)), mix(cC, cA, ph.sub(2))));
    rust = mix(rust, col(C0.rB), smoothstep(-0.3, 0.5, fineN.add(n2.mul(0.4))).mul(0.35));
    const deep = C.sub(Ef).max(0);
    rust = mix(rust, col(C0.rD), smoothstep(0.1, 0.7, deep).mul(0.65));
    const fb = fract(C.mul(11).add(fineN.mul(0.25)));
    rust = rust.mul(mix(float(0.5), float(1), smoothstep(0.0, 0.07, fb).mul(smoothstep(1.0, 0.93, fb))));
    rust = mix(rust, col(C0.powderCol), exp(deep.div(-0.025)).mul(0.7));
    rust = rust.mul(mx_noise_float(vec3(p.mul(40), 6.6)).mul(0.3).add(0.88));
    plateM.colorNode = mix(rust, paint, cover);
    plateM.roughnessNode = mix(float(0.9), float(0.38).add(n2.mul(0.06)), cover);
    plateM.clearcoatNode = cover.mul(0.25);
  }
  const plate = new THREE.Mesh(plateG, plateM); plate.receiveShadow = true; plate.castShadow = true; scene.add(plate);
  const edgeM = new THREE.MeshStandardMaterial({ color: 0x2a1a12, roughness: 0.8, metalness: 0.3 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(PL, 0.25, PL), edgeM); slab.position.y = -0.126; slab.receiveShadow = true; scene.add(slab);

  // ---- the dust: dead grains try to rise where the wave is high (flakes of paint where there is paint, dark
  // crumbs where there is rust, powder anywhere), spring to the wave's height while it holds and ride it
  // forward, fall when it drops, land, and fade
  const P = instancedArray(NP, 'vec4'), V = instancedArray(NP, 'vec4'); // position and life; velocity
  const kindOf = (fi) => hash(fi.mul(7.13).add(0.5)), rOf = (fi) => hash(fi.mul(3.71).add(1.7));
  const FLAKE = 0.025, CRUMB = 0.14;
  const K = 8; // every 8th sound row is a ridge line, as the lines of a classic waveform grid
  const lineZ = (w) => { // the plate z of the ridge line nearest to v = w
    const q = U.head.sub(float(1).sub(w).mul(ROWS - 3)), q0 = q.div(K).round().mul(K);
    return float(0.5).sub(float(1).sub(U.head.sub(q0).div(ROWS - 3))).mul(PL);
  };
  const dustK = Fn(() => {
    const i = instanceIndex, fi = float(i), kind = kindOf(fi), r = rOf(fi);
    const p = P.element(i), v = V.element(i), dead = p.w.lessThanEqual(0);
    // a dead grain: a try at rising from a spot of the plate
    const s1 = hash(fi.mul(1.31).add(U.frame.mul(0.618))), s2 = hash(fi.mul(2.17).add(U.frame.mul(0.414)).add(7)), s3 = hash(fi.mul(5.03).add(U.frame.mul(0.291)).add(13));
    const W0 = waveAt(s1, s2), st = texture(T, vec2(s1, s2)).level(0), isR = stepN(E0, st.x);
    const ok = select(kind.lessThan(FLAKE), float(1).sub(isR), select(kind.lessThan(CRUMB), isR, float(1)));
    const born = s3.lessThan(W0.mul(W0).mul(0.12).mul(ok));
    const pz0 = select(kind.lessThan(CRUMB), float(0.5).sub(s2).mul(PL), lineZ(s2));
    const py0 = select(kind.lessThan(CRUMB), st.z, st.z.add(W0.pow(1.3).mul(U.amp).mul(float(1).sub(s3.mul(0.06)))));
    const p0 = vec4(s1.sub(0.5).mul(PL), py0, pz0, float(2.8).add(r.mul(3.4)));
    const v0 = vec4(0, 0.2, U.scroll.mul(0.5), 0);
    // a live one: sprung to the wave while it holds, else falling; blown about; riding forward with the scroll
    const dt = U.dt, u = p.x.div(PL).add(0.5), w = float(0.5).sub(p.z.div(PL));
    const inside = u.greaterThan(0).and(u.lessThan(1)).and(w.greaterThan(0)).and(w.lessThan(1));
    const gnd = select(inside, texture(T, vec2(u.clamp(0, 1), w.clamp(0, 1))).level(0).z, float(-60));
    const W = waveAt(u.clamp(0, 1), w.clamp(0, 1)).mul(select(inside, float(1), float(0)));
    const isP = kind.greaterThanEqual(CRUMB);
    const layer = float(1).sub(r.mul(r).mul(r).mul(r).mul(select(isP, float(0.12), float(0.5)))); // most grains near the crest, so the wave reads as a surface
    const tgt = gnd.add(W.pow(1.3).mul(U.amp).mul(layer));
    const lifting = p.w.greaterThan(0.7).and(W.greaterThan(0.04));
    const heavy = select(kind.lessThan(FLAKE), float(0.45), select(kind.lessThan(CRUMB), float(1.2), float(0.8)));
    const ay = select(lifting, tgt.sub(p.y).mul(select(isP, float(40), float(16))).sub(v.y.mul(select(isP, float(11), float(6)))), select(isP, float(-0.8), float(-7).mul(heavy)));
    const onLine = isP.and(lifting);
    const tb = mx_noise_vec3(p.xyz.mul(0.45).add(vec3(0, 0, time.mul(0.35)))).mul(select(kind.lessThan(FLAKE), float(2.2), select(onLine, float(0.25), float(1.2))));
    const lz = select(onLine, lineZ(w.clamp(0, 1)).sub(p.z).mul(90).sub(v.z.sub(U.scroll).mul(16)), float(0));
    const nv = vec3(v.x.add(tb.x.sub(v.x.mul(0.9)).mul(dt)), v.y.add(ay.add(tb.y.mul(0.6)).mul(dt)), v.z.add(U.scroll.sub(v.z).mul(1.6).add(tb.z).add(lz).mul(dt)));
    const np = p.xyz.add(nv.mul(dt));
    const landed = inside.and(np.y.lessThan(gnd));                      // on the plate: it stops, and fades fast
    const life = p.w.sub(dt).sub(select(landed, dt.mul(8), float(0))).sub(select(isP.and(lifting.not()), dt.mul(5), float(0)));
    const p1 = vec4(np.x, select(landed, gnd, np.y), np.z, select(np.y.lessThan(-8), float(0), life));
    const v1 = vec4(select(landed, nv.mul(0.15), nv), 0);
    const pn = select(dead, select(born, p0, p), p1).toVar(), vn = select(dead, select(born, v0, v), v1).toVar();
    P.element(i).assign(pn); V.element(i).assign(vn);
  })().compute(NP);

  const dust = (() => {
    const g = new THREE.OctahedronGeometry(1, 0);
    const m = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: 0.82 });
    const fi = float(instanceIndex), pp = P.element(instanceIndex), kind = kindOf(fi), r = rOf(fi), r2 = hash(fi.mul(9.7).add(3.3));
    const flake = kind.lessThan(FLAKE), crumb = kind.lessThan(CRUMB);
    const sz0 = select(flake, r2.mul(0.04).add(0.035), select(crumb, r2.mul(0.02).add(0.018), r2.mul(r2).mul(0.02).add(0.01)));
    const sz = sz0.mul(smoothstep(0, 0.35, pp.w)).mul(select(pp.w.greaterThan(0), float(1), float(0)));
    m.positionNode = Fn(() => {
      const a = r.mul(6.283).add(time.mul(select(flake, r2.sub(0.5).mul(9), r2.sub(0.5).mul(2)))), b = r2.mul(3.1).add(time.mul(select(flake, r.sub(0.5).mul(7), float(0.4))));
      const l = positionLocal.mul(vec3(1, select(flake, float(0.1), float(0.8)), 1)).mul(sz);
      const x1 = l.x.mul(cos(a)).sub(l.z.mul(sin(a))), z1 = l.x.mul(sin(a)).add(l.z.mul(cos(a)));
      const y2 = l.y.mul(cos(b)).sub(z1.mul(sin(b))), z2 = l.y.mul(sin(b)).add(z1.mul(cos(b)));
      return pp.xyz.add(vec3(x1, y2, z2));
    })();
    // the higher a grain rides, the brighter: deep red-brown at the plate up to a hot yellow-orange at the crest
    const hf = pp.y.div(U.amp).clamp(0, 1);
    const ramp = mix(mix(vec3(0.28, 0.06, 0.05), col(C0.rA), smoothstep(0.0, 0.45, hf)), vec3(1, 0.72, 0.22), smoothstep(0.45, 1.0, hf));
    const powder = ramp.mul(r.mul(0.5).add(0.75));
    const c = select(flake, mix(col(C0.paint), col(C0.paint2), r), select(crumb, mix(col(C0.rE), col(C0.rD), r).mul(2), powder));
    m.colorNode = varying(c, 'vDust');
    m.emissiveNode = varying(select(flake.or(crumb), vec3(0), powder.mul(hf.mul(hf).mul(0.9).add(0.05))), 'vDustE');
    const mesh = new THREE.Mesh(g, m);
    mesh.count = NP; mesh.frustumCulled = false; mesh.castShadow = !phone; mesh.receiveShadow = true;
    return mesh;
  })();
  scene.add(dust);

  // ---- post: bloom on the bright crests, a teal and orange grade, vignette, grain
  const OFF = Q.has('offscreen');
  let off = null;
  if (OFF) {
    const W = innerWidth, H = innerHeight;
    off = { W, H, ldr: new THREE.RenderTarget(W, H) };
    off.c2d = document.createElement('canvas'); off.c2d.width = W; off.c2d.height = H;
    off.c2d.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none'; document.body.insertBefore(off.c2d, renderer.domElement.nextSibling);
  }
  const pipeline = new THREE.RenderPipeline(renderer);
  const scenePass = pass(scene, camera);
  const sc = scenePass.getTextureNode('output');
  const glow = bloom(sc, 0.35, 0.5, 0.7);
  pipeline.outputNode = Fn(() => {
    const c = sc.rgb.add(glow.rgb);
    const lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    const tone = mix(vec3(0.93, 1.0, 1.04), vec3(1.05, 0.99, 0.92), smoothstep(0.01, 0.35, lum));
    const vg = smoothstep(1.25, 0.2, length(screenUV.sub(0.5).mul(vec2(screenSize.x.div(screenSize.y), 1))));
    const px = screenUV.mul(screenSize).floor();
    const n = hash(px.x.add(px.y.mul(4111.0)).add(time.mul(60).floor().mul(7919.0).mod(65536))).sub(0.5).mul(0.012);
    return vec4(c.mul(tone).mul(mix(float(0.45), float(1), vg)).add(n), 1);
  })();
  const rs = { scale: +(Q.get('scale') || 1), fixed: Q.has('scale'), acc: 0, n: 0 };
  scenePass.setResolutionScale(rs.scale);
  const pace = (dt) => { // render scale follows the frame rate
    if (rs.fixed || !dt) return;
    rs.acc += dt; rs.n++; if (rs.acc < 1) return;
    const avg = rs.acc / rs.n; rs.acc = 0; rs.n = 0;
    const c = Math.min(1, Math.max(0.5, avg > 1 / 40 ? rs.scale * 0.85 : avg < 1 / 57 ? rs.scale * 1.08 : rs.scale));
    if (Math.abs(c - rs.scale) > 0.01) { rs.scale = c; scenePass.setResolutionScale(c); }
  };
  const draw = () => { renderer.setRenderTarget(OFF ? off.ldr : null); pipeline.render(); renderer.setRenderTarget(null); };
  const snapshot = async () => {
    draw();
    const px = await renderer.readRenderTargetPixelsAsync(off.ldr, 0, 0, off.W, off.H);
    off.c2d.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), off.W, off.H), 0, 0);
  };
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  // ---- UI
  const state = { source: 'off', seed: +(Q.get('seed') || Math.floor(Math.random() * 1e5)), song: 0 };
  const newPlate = () => {
    U.seed.value = (state.seed % 997) * 0.731; renderer.compute(reset); state.song = 0;
    renderer.compute(dustClear);
    history.replaceState(null, '', `#seed=${state.seed}`);
  };
  const dustClear = Fn(() => { P.element(instanceIndex).assign(vec4(0, -20, 0, 0)); V.element(instanceIndex).assign(vec4(0)); })().compute(NP);
  const listen = async (src) => {
    try { await audio.use(src); } catch (e) { $('hint').textContent = 'No sound: ' + e.message; $('hint').classList.remove('gone'); src = 'off'; await audio.use('off'); }
    state.source = src instanceof File ? 'file' : src;
    $('sound').value = state.source; $('play')?.remove();
  };
  $('sound').onchange = () => { const v = $('sound').value; if (v === 'file') $('file').click(); else listen(v); };
  $('file').onchange = () => { const f = $('file').files[0]; if (f) listen(f); else $('sound').value = state.source; };
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); const f = [...e.dataTransfer.files].find((f) => f.type.startsWith('audio')); if (f) listen(f); });
  if ($('play')) $('play').onclick = () => listen('track');
  $('new').onclick = () => { state.seed = Math.floor(Math.random() * 1e5); newPlate(); };
  const AMPS = [2.2, 3.2, 4.6];
  $('amp').onclick = () => { const k = (AMPS.indexOf(U.amp.value) + 1) % AMPS.length; U.amp.value = AMPS[k]; $('amp').textContent = ['Low', 'Mid', 'High'][k]; };
  const save = () => { draw(); renderer.domElement.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `oxide-wave-${state.seed}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }); };
  $('save').onclick = save;
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 'l' || k === ' ') { e.preventDefault(); listen(state.source === 'off' ? 'track' : 'off'); } else if (k === 'n') $('new').click(); else if (k === 'a') $('amp').click();
    else if (k === 's') save(); else if (k === 'h') document.body.classList.toggle('calm');
  });

  // ---- frame: the camera sways slowly round the plate when left alone
  let idle = 99, last = performance.now(), frame = 0, T0 = 0;
  controls.addEventListener('start', () => { idle = 0; });
  const step = (dt) => {
    idle += dt; T0 += dt;
    audio.update(dt);
    const live = state.source !== 'off';
    if (live) state.song += dt;
    U.on.value += ((live ? 1 : 0) - U.on.value) * Math.min(1, dt * 2);
    U.head.value = audio.head - 1 + audio.frac; U.dt.value = dt; U.song.value = state.song; U.frame.value = frame % 4096;
    if (dt > 0) { renderer.compute(flip ? growBA : growAB); flip ^= 1; renderer.compute(dustK); }
    if (idle > 6 && dt > 0) {
      const az = Math.sin(T0 * 0.045) * 0.42, el = 0.38 + Math.sin(T0 * 0.031 + 1) * 0.07, d = HOME.length();
      const goal = new THREE.Vector3(Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d);
      camera.position.lerp(goal, 1 - Math.exp(-dt * 0.4)); controls.target.lerp(new THREE.Vector3(0, 1.2, 0), 1 - Math.exp(-dt * 0.4));
    }
    controls.update();
    frame++;
  };
  const loop = () => {
    const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
    step(dt); pace(dt); draw(); requestAnimationFrame(loop);
  };

  newPlate();
  $('status').remove(); document.body.classList.add('ready');
  setTimeout(() => $('hint').classList.add('gone'), 8000);
  const read = async (buf) => new Float32Array(await renderer.getArrayBufferAsync(buf.value));
  window.__wave = {
    state, audio, U, camera, controls, snapshot, draw, step, listen, newPlate, renderer, growAB, dustK,
    // play `secs` of sound at 20 steps a second
    hear(secs) { for (let i = 0; i < secs * 20; i++) step(0.05); },
    // the same in real time, for a source that plays in real time (the track, a file)
    hearLive(secs) { return new Promise((res) => { let n = 0; const id = setInterval(() => { step(0.05); if (++n >= secs * 20) { clearInterval(id); res(); } }, 50); }); },
    // how much dust is up and how high, and how much of the plate has rusted
    async stats() {
      const p = await read(P), s = await read(flip ? SB : SA);
      let alive = 0, hy = 0, top = 0; for (let i = 0; i < NP; i++) if (p[i * 4 + 3] > 0) { alive++; hy += p[i * 4 + 1]; top = Math.max(top, p[i * 4 + 1]); }
      let rust = 0; for (let i = 0; i < G * G; i++) if (s[i * 4] > E0) rust++;
      return { alive: alive / NP, height: alive ? hy / alive : 0, top, rust: rust / (G * G) };
    },
  };
  if (Q.has('shot')) { step(0); draw(); } else loop();
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:' && !Q.has('shot')) navigator.serviceWorker.register('sw.js').catch(() => {});

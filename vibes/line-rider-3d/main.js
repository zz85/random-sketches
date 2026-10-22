// Line Rider 3D: rendering, drawing on the sketch plane, playback. Physics in sim.js, geometry in track.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { buildTrack, strokeFrames, serialize, deserialize, DEFAULT_W, G } from './track.js';
import * as Sim from './sim.js';
import { makeDemo } from './demo.js';

const Q = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const STORE = 'lr3d.track.v1';
if (Q.has('noui')) document.body.classList.add('noui');

// ---------------------------------------------------------------- renderer, scene
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: Q.has('still') });
renderer.setPixelRatio(Q.has('pr') ? +Q.get('pr') : Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.prepend(renderer.domElement);
const PAPER = new THREE.Color('#f4f1ea');
const scene = new THREE.Scene();
scene.background = PAPER;
scene.fog = new THREE.Fog(PAPER, 120, 420);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 3000);
camera.position.set(-10, 26, 62);
scene.add(new THREE.HemisphereLight('#ffffff', '#c9c2b2', 1.6));
const sun = new THREE.DirectionalLight('#ffffff', 1.4);
sun.position.set(0.4, 1, 0.6);
scene.add(sun);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.target.set(-6, 6, 0);
controls.zoomToCursor = true;
controls.screenSpacePanning = true;

const lineMats = [];
const lineMat = (opts) => { const m = new LineMaterial({ linewidth: 2, vertexColors: true, ...opts }); m.resolution.set(innerWidth, innerHeight); lineMats.push(m); return m; };

// ---------------------------------------------------------------- state
let strokes = [], flag = null, track = buildTrack([]);
let tool = 'pencil', lineType = 0, bankOn = true, width = DEFAULT_W, grade = 0.08;
const plane = { mode: 'wall', pivot: new THREE.Vector3(0, 6, 0), yaw: 0 };
const undoStack = [], redoStack = [];
let playing = false, playhead = 0, playSpeed = 1, camMode = 'follow';
// 'side': 2.5D, a narrow-angle camera looking at the sketch plane from slightly above and behind, so it reads
// like 2D Line Rider with depth; it swings around corners while riding. '3d': free orbit camera.
let viewMode = Q.has('v3d') ? '3d' : (() => { try { return localStorage.getItem('lr3d.view') || 'side'; } catch { return 'side'; } })();
const FOV = { side: 22, '3d': 50 };
let sideAng = null, sidePitch = 0.24;   // 2.5D camera heading and pitch, eased toward sideCamera()'s target
let rec = [];                 // recorded sim states, one per frame
const MAX_FRAMES = 60 * 600;

const yRef = () => (flag ? flag.p[1] + (flag.v || 0) ** 2 / (2 * G) : 20);
const snapshot = () => serialize(strokes, flag);
function restore(text) { const o = deserialize(text); strokes = o.strokes; flag = o.flag || defaultFlag(); trackChanged(false); }
function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0; }
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }
function defaultFlag() { return { p: [0, 8, 0], dir: [1, 0, 0], v: 2 }; }

function trackChanged(save = true) {
  track = buildTrack(strokes, { yRef: yRef() });
  rec = [];
  rebuildTrackMeshes();
  updateFlagMesh();
  if (save) try { localStorage.setItem(STORE, snapshot()); } catch { /* quota / private mode */ }
}

// ---------------------------------------------------------------- track meshes
const COLORS = {
  top: [new THREE.Color('#eef2fd'), new THREE.Color('#fde6e4')],
  edge: [new THREE.Color('#2a5bd7'), new THREE.Color('#d93636'), new THREE.Color('#2fa84f')],
};
const ribbonMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
ribbonMat.onBeforeCompile = (sh) => {
  // the riding side is the front face; the pass-through underside is darker and hatched
  sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
    if (!gl_FrontFacing) { float h = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) * 0.125)); diffuseColor.rgb *= mix(0.42, 0.55, h); }`);
};
const shadowMat = new THREE.MeshBasicMaterial({ color: '#2a3042', transparent: true, opacity: 0.07, depthWrite: false });
const chevronMat = new THREE.MeshBasicMaterial({ color: '#d93636', side: THREE.DoubleSide });
const postMat = new THREE.LineBasicMaterial({ color: '#8f97ad', transparent: true, opacity: 0.35 });
const edgeMat = lineMat({ linewidth: 2.2 });
const trackGroup = new THREE.Group();
scene.add(trackGroup);
const previewGroup = new THREE.Group();
scene.add(previewGroup);

function geometryFor(frames, groundY, { shadows = true } = {}) {
  const pos = [], col = [], idx = [], ePos = [], eCol = [], sPos = [], cPos = [], pPos = [];
  for (const f of frames) {
    if (!f) continue;
    const ec = COLORS.edge[f.type];
    if (f.type === 2) {   // scenery: just ink
      for (let i = 0; i + 1 < f.P.length; i++) { ePos.push(...f.P[i], ...f.P[i + 1]); eCol.push(ec.r, ec.g, ec.b, ec.r, ec.g, ec.b); }
      continue;
    }
    const hw = f.w / 2, base = pos.length / 3, tc = COLORS.top[f.type];
    const L = [], R = [];
    for (let i = 0; i < f.P.length; i++) {
      const p = f.P[i], s = f.S[i];
      L.push([p[0] - s[0] * hw, p[1] - s[1] * hw, p[2] - s[2] * hw]);
      R.push([p[0] + s[0] * hw, p[1] + s[1] * hw, p[2] + s[2] * hw]);
      pos.push(...L[i], ...R[i]);
      col.push(tc.r, tc.g, tc.b, tc.r, tc.g, tc.b);
    }
    for (let i = 0; i + 1 < f.P.length; i++) {
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      // front face (counter-clockwise) on the riding side
      const e1 = new THREE.Vector3(...R[i]).sub(new THREE.Vector3(...L[i])), e2 = new THREE.Vector3(...L[i + 1]).sub(new THREE.Vector3(...L[i]));
      const front = e1.cross(e2).dot(new THREE.Vector3(...f.N[i])) > 0;
      if (front) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
      ePos.push(...L[i], ...L[i + 1], ...R[i], ...R[i + 1]);
      for (let k = 0; k < 4; k++) eCol.push(ec.r, ec.g, ec.b);
    }
    const last = f.P.length - 1;
    ePos.push(...L[0], ...R[0], ...L[last], ...R[last]);
    for (let k = 0; k < 4; k++) eCol.push(ec.r, ec.g, ec.b);
    if (shadows) {
      for (let i = 0; i + 1 < f.P.length; i++) sPos.push(L[i][0], groundY, L[i][2], R[i][0], groundY, R[i][2], L[i + 1][0], groundY, L[i + 1][2], R[i][0], groundY, R[i][2], R[i + 1][0], groundY, R[i + 1][2], L[i + 1][0], groundY, L[i + 1][2]);
      let nextPost = 0;
      for (let i = 0; i < f.P.length; i++) if (f.arc[i] >= nextPost) { nextPost = f.arc[i] + 3; pPos.push(...f.P[i], f.P[i][0], groundY, f.P[i][2]); }
    }
    if (f.type === 1) {   // accelerate: chevrons pointing the way it pushes
      const dir = f.flip ? -1 : 1;
      let next = 0.8;
      for (let i = 0; i < f.P.length; i++) {
        if (f.arc[i] < next || f.arc[i] > f.arc[last] - 0.5) continue;
        next = f.arc[i] + 1.6;
        const p = new THREE.Vector3(...f.P[i]), t = new THREE.Vector3(...f.T[i]).multiplyScalar(dir), s = new THREE.Vector3(...f.S[i]), n = new THREE.Vector3(...f.N[i]).multiplyScalar(0.03);
        const tip = p.clone().addScaledVector(t, 0.45).add(n), bl = p.clone().addScaledVector(t, -0.2).addScaledVector(s, -hw * 0.55).add(n), br = p.clone().addScaledVector(t, -0.2).addScaledVector(s, hw * 0.55).add(n);
        const nb = p.clone().addScaledVector(t, 0.05).add(n);
        cPos.push(...bl.toArray(), ...tip.toArray(), ...nb.toArray(), ...nb.toArray(), ...tip.toArray(), ...br.toArray());
      }
    }
  }
  const out = new THREE.Group();
  if (idx.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, ribbonMat);
    m.name = 'ribbons';
    out.add(m);
  }
  if (ePos.length) {
    const g = new LineSegmentsGeometry();
    g.setPositions(ePos); g.setColors(eCol);
    out.add(new LineSegments2(g, edgeMat));
  }
  if (sPos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(sPos, 3));
    const m = new THREE.Mesh(g, shadowMat); m.renderOrder = -1; out.add(m);
  }
  if (pPos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pPos, 3));
    out.add(new THREE.LineSegments(g, postMat));
  }
  if (cPos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(cPos, 3));
    out.add(new THREE.Mesh(g, chevronMat));
  }
  return out;
}
const disposeGroup = (grp) => { grp.traverse((o) => o.geometry && o.geometry.dispose()); grp.clear(); };

let groundY = -4, ribbonMesh = null;
function rebuildTrackMeshes() {
  disposeGroup(trackGroup);
  groundY = strokes.length ? Math.floor(track.lo[1]) - 4 : -4;
  ground.position.y = groundY - 0.01;
  const g = geometryFor(track.frames, groundY + 0.01);
  trackGroup.add(g);
  ribbonMesh = g.getObjectByName('ribbons') || null;
}

// ---------------------------------------------------------------- ground and sketch plane
const gridShader = (color, fade) => new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, side: THREE.DoubleSide, extensions: { derivatives: true },
  uniforms: { color: { value: new THREE.Color(color) }, fade: { value: fade }, alpha: { value: 1 } },
  vertexShader: 'varying vec2 vP; varying vec3 vW; void main(){ vP = position.xy; vec4 w = modelMatrix * vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
  fragmentShader: `uniform vec3 color; uniform float fade, alpha; varying vec2 vP; varying vec3 vW;
    float grid(vec2 p, float s){ vec2 g = abs(fract(p / s - 0.5) - 0.5) / fwidth(p / s); return 1. - min(min(g.x, g.y), 1.); }
    void main(){ float a = max(grid(vP, 1.) * 0.35, grid(vP, 5.)) ;
      float f = 1. - smoothstep(fade * 0.55, fade, length(vP));
      float axis = 1. - min(abs(vP.x) / fwidth(vP.x), 1.);
      gl_FragColor = vec4(color, (a * 0.5 + axis * 0.4) * f * alpha + 0.04 * f * alpha); }`,
});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), gridShader('#b9b2a2', 800));
ground.rotation.x = -Math.PI / 2;
ground.material.uniforms.alpha.value = 0.7;
scene.add(ground);
const sketch = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), gridShader('#2a5bd7', 40));
sketch.renderOrder = 2;
scene.add(sketch);
const pivotMark = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), new THREE.MeshBasicMaterial({ color: '#2a5bd7' }));
scene.add(pivotMark);
const planeNormal = () => (plane.mode === 'floor' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(Math.sin(plane.yaw), 0, Math.cos(plane.yaw)));
function updateSketch() {
  sketch.position.copy(plane.pivot);
  sketch.rotation.set(0, 0, 0);
  if (plane.mode === 'floor') sketch.rotation.x = -Math.PI / 2; else sketch.rotation.y = plane.yaw;
  sketch.material.uniforms.color.value.set(plane.mode === 'floor' ? '#2f8a4c' : '#2a5bd7');
  pivotMark.position.copy(plane.pivot);
  sketch.visible = pivotMark.visible = !playing && tool !== 'view' && tool !== 'flag';
  $('planeMode').textContent = plane.mode === 'floor' ? 'Floor' : 'Wall';
  $('gradeBox').style.opacity = plane.mode === 'floor' ? 1 : 0.4;
}

// ---------------------------------------------------------------- start flag
const flagMesh = new THREE.Group();
{
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.8, 8), new THREE.MeshLambertMaterial({ color: '#555' }));
  pole.position.y = 0.9;
  const cloth = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 1.8, 0), new THREE.Vector3(0, 1.3, 0), new THREE.Vector3(0.7, 1.55, 0)]), new THREE.MeshBasicMaterial({ color: '#2fa84f', side: THREE.DoubleSide }));
  flagMesh.add(pole, cloth);
  scene.add(flagMesh);
}
function updateFlagMesh() {
  if (!flag) return;
  const f = new THREE.Vector3(...flag.dir).normalize(), u = new THREE.Vector3(...(flag.up || [0, 1, 0]));
  flagMesh.position.set(...flag.p).addScaledVector(f, -0.9);
  flagMesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(f, u, f.clone().cross(u)));
}

// ---------------------------------------------------------------- rider
const ink = new THREE.MeshBasicMaterial({ color: '#1d2433', side: THREE.BackSide });
const white = new THREE.MeshLambertMaterial({ color: '#ffffff' });
const wood = new THREE.MeshLambertMaterial({ color: '#c8894a' });
const red = new THREE.MeshLambertMaterial({ color: '#e0453a' });
const rider = new THREE.Group();
scene.add(rider);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 10, 1), SPH = new THREE.SphereGeometry(1, 16, 12);
function part(geo, mat, outline = 0.025) {
  const m = new THREE.Mesh(geo, mat), o = new THREE.Mesh(geo, ink);
  rider.add(m, o);
  return { m, o, outline };
}
const limb = (r, mat = white) => ({ ...part(CYL, mat), r });
const ball = (r, mat = white) => ({ ...part(SPH, mat), r });
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
function setLimb(L, a, b) {
  _d.subVectors(b, a); const l = _d.length();
  for (const [mesh, k] of [[L.m, 0], [L.o, L.outline]]) {
    mesh.position.addVectors(a, b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(_up, _d.clone().divideScalar(l || 1));
    mesh.scale.set(L.r + k, l + k, L.r + k);
  }
}
function setBall(B, p, r = B.r) { for (const [mesh, k] of [[B.m, 0], [B.o, B.outline]]) { mesh.position.copy(p); mesh.scale.setScalar(r + k); } }
const parts = {
  board: part(new THREE.BoxGeometry(1, 1, 1), wood), railL: limb(0.035, wood), railR: limb(0.035, wood), back: limb(0.03, wood),
  legL: limb(0.065), legR: limb(0.065), torso: limb(0.15), armL: limb(0.055), armR: limb(0.055),
  footL: ball(0.08), footR: ball(0.08), handL: ball(0.07), handR: ball(0.07), butt: ball(0.15), head: ball(0.19),
  ropeL: limb(0.012, ink), ropeR: limb(0.012, ink),
};
const eyes = [new THREE.Mesh(SPH, ink), new THREE.Mesh(SPH, ink)];
eyes.forEach((e) => { e.scale.setScalar(0.03); rider.add(e); });
// scarf: a little verlet chain blown back by the rider's own speed (look only, not part of the sim)
const SCARF_N = 9;
const scarf = { p: [], q: [], geo: new LineSegmentsGeometry(), init: false };
const scarfMesh = new LineSegments2(scarf.geo, lineMat({ linewidth: 6, vertexColors: false, color: '#e0453a' }));
scarfMesh.material.vertexColors = false;
rider.add(scarfMesh);
// shadows: one on the ground straight below, one on the track under the rider
const blobTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const r = g.createRadialGradient(32, 32, 0, 32, 32, 32); r.addColorStop(0, 'rgba(0,0,0,0.5)'); r.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
const blob = (s) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 })); scene.add(m); return m; };
const groundBlob = blob(1.6), trackBlob = blob(1.4);
const trail = { geo: new THREE.BufferGeometry(), n: 150 };
trail.geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(trail.n * 3), 3));
trail.geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(trail.n * 3), 3));
const trailLine = new THREE.Line(trail.geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 }));
trailLine.frustumCulled = false;
scene.add(trailLine);

const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);
function poseAt(fr) {   // fractional frame -> interpolated points
  const i = Math.floor(fr), t = fr - i, A = stateAt(i), B = t > 0 ? stateAt(i + 1) : A;
  const pts = [];
  for (let k = 0; k < Sim.NP; k++) pts.push(new THREE.Vector3(A.pos[k * 3], A.pos[k * 3 + 1], A.pos[k * 3 + 2]).lerp(new THREE.Vector3(B.pos[k * 3], B.pos[k * 3 + 1], B.pos[k * 3 + 2]), t));
  return { pts, st: t > 0.5 ? B : A };
}
const raycaster = new THREE.Raycaster();
let lastScarfT = 0;
function drawRider(fr, dtReal) {
  const { pts: p, st } = poseAt(fr);
  const P = Sim.P;
  const tail = p[P.TL].clone().add(p[P.TR]).multiplyScalar(0.5), nose = p[P.NL].clone().add(p[P.NR]).multiplyScalar(0.5);
  const F = nose.clone().sub(tail).normalize(), R = p[P.TR].clone().sub(p[P.TL]).add(p[P.NR]).sub(p[P.NL]).normalize();
  const U = R.clone().cross(F).normalize();
  const c = tail.clone().add(nose).multiplyScalar(0.5);
  const board = parts.board;
  for (const [mesh, k] of [[board.m, 0], [board.o, 0.04]]) {
    mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(F, U, R));
    mesh.position.copy(c).addScaledVector(U, 0.03);
    mesh.scale.set(1.05 + k, 0.06 + k, 0.5 + k);
  }
  setLimb(parts.railL, p[P.NL], p[P.S]); setLimb(parts.railR, p[P.NR], p[P.S]);
  setLimb(parts.back, p[P.TL].clone().addScaledVector(U, 0.03), p[P.TR].clone().addScaledVector(U, 0.03));
  setLimb(parts.legL, p[P.B], p[P.FL]); setLimb(parts.legR, p[P.B], p[P.FR]);
  setLimb(parts.torso, p[P.B], p[P.SH]);
  setLimb(parts.armL, p[P.SH], p[P.HL]); setLimb(parts.armR, p[P.SH], p[P.HR]);
  setBall(parts.footL, p[P.FL]); setBall(parts.footR, p[P.FR]); setBall(parts.handL, p[P.HL]); setBall(parts.handR, p[P.HR]); setBall(parts.butt, p[P.B]);
  const spine = p[P.SH].clone().sub(p[P.B]).normalize();
  const head = p[P.SH].clone().addScaledVector(spine, 0.24);
  setBall(parts.head, head);
  // face forward: the body's forward is perpendicular to the spine, toward the hands
  const fwd = p[P.HL].clone().add(p[P.HR]).multiplyScalar(0.5).sub(p[P.SH]); fwd.addScaledVector(spine, -fwd.dot(spine)).normalize();
  const side = spine.clone().cross(fwd).normalize();
  eyes[0].position.copy(head).addScaledVector(fwd, 0.17).addScaledVector(side, 0.07).addScaledVector(spine, 0.04);
  eyes[1].position.copy(head).addScaledVector(fwd, 0.17).addScaledVector(side, -0.07).addScaledVector(spine, 0.04);
  // the rope from the sled's nose to the hands, slack once thrown off
  const ropeOn = !st.crashed;
  parts.ropeL.m.visible = parts.ropeL.o.visible = parts.ropeR.m.visible = parts.ropeR.o.visible = ropeOn;
  if (ropeOn) { setLimb(parts.ropeL, p[P.S], p[P.HL]); setLimb(parts.ropeR, p[P.S], p[P.HR]); }

  // scarf
  const neck = p[P.SH].clone().addScaledVector(spine, 0.05);
  const v = V3(Sim.velocity(st, P.SH));
  if (!scarf.init || dtReal < 0) { scarf.p = []; scarf.q = []; for (let i = 0; i < SCARF_N; i++) { const q = neck.clone().addScaledVector(fwd, -0.12 * i); scarf.p.push(q); scarf.q.push(q.clone()); } scarf.init = true; }
  const dt = Math.min(Math.max(dtReal, 0), 1 / 30);
  if (dt > 0) {
    for (let i = 1; i < SCARF_N; i++) {
      const p0 = scarf.p[i], vel = p0.clone().sub(scarf.q[i]);
      scarf.q[i].copy(p0);
      // still air drags it back (so it streams behind the neck), gravity, flutter
      const flutter = side.clone().multiplyScalar(Math.sin(performance.now() * 0.02 + i) * 0.004 * Math.min(v.length(), 20) * dt * 60);
      p0.add(vel.multiplyScalar(0.9)).add(flutter).y -= 6 * dt * dt;
    }
  }
  scarf.p[0].copy(neck); scarf.q[0].copy(neck);
  for (let it = 0; it < 3; it++) for (let i = 1; i < SCARF_N; i++) {
    const a = scarf.p[i - 1], b = scarf.p[i], d = b.clone().sub(a), l = d.length() || 1;
    b.copy(a).addScaledVector(d, 0.12 / l);
  }
  const sp = [];
  for (let i = 0; i + 1 < SCARF_N; i++) sp.push(...scarf.p[i].toArray(), ...scarf.p[i + 1].toArray());
  scarf.geo.setPositions(sp);
  lastScarfT = fr;

  // shadows
  groundBlob.position.set(c.x, groundY + 0.02, c.z);
  groundBlob.rotation.set(-Math.PI / 2, 0, 0);
  const hgt = Math.max(0, c.y - groundY);
  groundBlob.scale.setScalar(1 + hgt * 0.04);
  groundBlob.material.opacity = Math.max(0.15, 1 - hgt * 0.02);
  trackBlob.visible = false;
  if (ribbonMesh) {
    raycaster.set(c.clone().addScaledVector(_up, 0.5), new THREE.Vector3(0, -1, 0));
    raycaster.far = 40;
    const hit = raycaster.intersectObject(ribbonMesh, false)[0];
    if (hit && hit.face) {
      const n = hit.face.normal.clone().transformDirection(ribbonMesh.matrixWorld);
      if (n.y < 0) n.negate();
      trackBlob.visible = true;
      trackBlob.position.copy(hit.point).addScaledVector(n, 0.02);
      trackBlob.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      trackBlob.scale.setScalar(1 + hit.distance * 0.1);
      trackBlob.material.opacity = Math.max(0, 1 - hit.distance * 0.08);
    }
  }
  return { c, F, U, v, st };
}
function drawTrail(fr) {
  const posA = trail.geo.attributes.position.array, colA = trail.geo.attributes.color.array;
  const end = Math.floor(fr);
  let n = 0;
  for (let k = Math.max(0, end - trail.n + 1); k <= end; k++, n++) {
    const s = stateAt(k);
    posA[n * 3] = (s.pos[0] + s.pos[3] + s.pos[6] + s.pos[9]) / 4; posA[n * 3 + 1] = (s.pos[1] + s.pos[4] + s.pos[7] + s.pos[10]) / 4 + 0.05; posA[n * 3 + 2] = (s.pos[2] + s.pos[5] + s.pos[8] + s.pos[11]) / 4;
  }
  for (let i = 0; i < n; i++) { const t = i / Math.max(1, n - 1); const cc = PAPER.clone().lerp(new THREE.Color('#e0453a'), t * 0.8); colA[i * 3] = cc.r; colA[i * 3 + 1] = cc.g; colA[i * 3 + 2] = cc.b; }
  trail.geo.setDrawRange(0, n);
  trail.geo.attributes.position.needsUpdate = true; trail.geo.attributes.color.needsUpdate = true;
}

// ---------------------------------------------------------------- simulation record
function stateAt(f) {
  f = Math.max(0, Math.min(MAX_FRAMES, f));
  if (!rec.length) rec.push(Sim.spawn(flag));
  while (rec.length <= f) {
    const s = Sim.cloneState(rec[rec.length - 1]);
    Sim.step(s, track);
    rec.push(s);
  }
  return rec[f];
}

// ---------------------------------------------------------------- input: drawing on the sketch plane
const ndc = new THREE.Vector2();
function rayFrom(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  raycaster.far = Infinity;
  return raycaster.ray;
}
function planeHit(ev, y = null) {
  const ray = rayFrom(ev);
  const n = planeNormal(), pt = plane.pivot.clone();
  if (y !== null) pt.y = y;
  const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, pt);
  const out = new THREE.Vector3();
  const denom = Math.abs(n.dot(ray.direction));
  if (denom < 0.02 || !ray.intersectPlane(pl, out)) return null;
  if (out.distanceTo(camera.position) > 600) return null;
  return out;
}
function toScreen(p) {
  const v = (p.isVector3 ? p.clone() : V3(p)).project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  return { x: (v.x + 1) / 2 * r.width + r.left, y: (1 - v.y) / 2 * r.height + r.top, z: v.z };
}
// nearest stroke end within px on screen: { p, stroke, end: 0 | 1 }
function findEnd(ev, px = 16) {
  let best = null, bd = px;
  strokes.forEach((s, si) => {
    for (const end of [0, 1]) {
      const p = s.pts[end ? s.pts.length - 1 : 0], sc = toScreen(p);
      if (sc.z > 1) continue;
      const d = Math.hypot(sc.x - ev.clientX, sc.y - ev.clientY);
      if (d < bd) { bd = d; best = { p, stroke: si, end }; }
    }
  });
  return best;
}
// orient a wall-plane normal toward the camera so left -> right on screen is always a floor
function facingHint() {
  const n = planeNormal();
  if (plane.mode === 'wall' && n.dot(camera.position.clone().sub(plane.pivot)) < 0) n.negate();
  return n;
}

let draw = null;   // stroke in progress
const keys = new Set();
const snapMark = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.45, 24), new THREE.MeshBasicMaterial({ color: '#e0453a', side: THREE.DoubleSide, depthTest: false, transparent: true }));
snapMark.renderOrder = 10; snapMark.visible = false;
scene.add(snapMark);
const penMark = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), new THREE.MeshBasicMaterial({ color: '#1d2433' }));
penMark.visible = false;
scene.add(penMark);

function startStroke(ev) {
  const snap = ev.altKey ? null : findEnd(ev);
  let start;
  if (snap) {
    start = V3(snap.p);
    const s = strokes[snap.stroke];
    if (plane.mode === 'wall' && s.mode === 'wall' && s.hints) {   // carry on in that stroke's plane
      const h = s.hints[snap.end ? s.hints.length - 1 : 0];
      if (Math.abs(h[1]) < 0.9) plane.yaw = Math.atan2(h[0], h[2]);
    }
    plane.pivot.copy(start);
  } else {
    start = planeHit(ev);
    if (!start) return;
    if (plane.mode === 'floor') plane.pivot.y = start.y;
  }
  updateSketch();
  draw = { kind: tool, pts: [start], hints: [facingHint().toArray()], arc: 0, flip: ev.shiftKey, y0: start.y, end: null, type: lineType, mode: plane.mode };
}
function extendStroke(ev) {
  if (!draw) return;
  draw.flip = draw.flip || ev.shiftKey;
  if (draw.kind === 'pencil') {
    const last = draw.pts[draw.pts.length - 1];
    const hit = planeHit(ev, plane.mode === 'floor' ? last.y : null);
    if (!hit) return;
    if (plane.mode === 'floor') hit.y = last.y;
    const d = hit.distanceTo(last);
    if (d < 0.3) return;
    const n = Math.ceil(d / 0.4);
    for (let i = 1; i <= n; i++) {
      const q = last.clone().lerp(hit, i / n);
      if (plane.mode === 'floor') { const h = Math.hypot(q.x - last.x, q.z - last.z); q.y = last.y - grade * h; }
      draw.pts.push(q); draw.hints.push(facingHint().toArray());
    }
  } else {
    const snap = ev.altKey ? null : findEnd(ev);
    let end = snap ? V3(snap.p) : planeHit(ev, plane.mode === 'floor' ? draw.y0 : null);
    if (!end) return;
    if (!snap && plane.mode === 'floor') end.y = draw.y0 - grade * Math.hypot(end.x - draw.pts[0].x, end.z - draw.pts[0].z);
    draw.end = end;
  }
  drawPreview();
}
function strokeFromDraw() {
  let pts = draw.pts, hints = draw.hints;
  if (draw.kind === 'line') {
    if (!draw.end) return null;
    const a = draw.pts[0], b = draw.end, n = Math.max(1, Math.ceil(a.distanceTo(b) / 0.4));
    pts = []; hints = [];
    for (let i = 0; i <= n; i++) { pts.push(a.clone().lerp(b, i / n)); hints.push(draw.hints[0]); }
  } else if (pts.length > 3) {
    // light smoothing of hand jitter, ends kept where they were drawn (so snapped joints stay joined)
    const sm = pts.map((p, i) => (i === 0 || i === pts.length - 1 ? p.clone() : pts[i - 1].clone().add(p).add(p).add(pts[i + 1]).multiplyScalar(0.25)));
    pts = sm;
  }
  if (pts.length < 2) return null;
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += pts[i].distanceTo(pts[i - 1]);
  if (L < 0.3) return null;
  return { type: draw.type, mode: draw.mode, pts: pts.map((p) => p.toArray()), hints: draw.mode === 'wall' ? hints : undefined, flip: draw.flip, bank: bankOn, w: draw.type === 2 ? 0.3 : width };
}
function drawPreview() {
  disposeGroup(previewGroup);
  const st = draw && strokeFromDraw();
  if (!st) return;
  previewGroup.add(geometryFor([strokeFrames(st, yRef())], groundY + 0.01));
}
function endStroke() {
  if (!draw) return;
  const st = strokeFromDraw();
  draw = null;
  disposeGroup(previewGroup);
  if (!st) return;
  pushUndo();
  strokes.push(st);
  plane.pivot.copy(V3(st.pts[st.pts.length - 1]));
  updateSketch();
  trackChanged();
}

// eraser: drop every segment that passes within a few pixels of the pointer, splitting strokes
let erasing = false;
function eraseAt(ev, radius = 12) {
  const hitSegs = new Map();
  strokes.forEach((s, si) => {
    let prev = toScreen(s.pts[0]);
    for (let i = 1; i < s.pts.length; i++) {
      const cur = toScreen(s.pts[i]);
      if (prev.z < 1 && cur.z < 1) {
        const dx = cur.x - prev.x, dy = cur.y - prev.y, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((ev.clientX - prev.x) * dx + (ev.clientY - prev.y) * dy) / l2));
        if (Math.hypot(prev.x + dx * t - ev.clientX, prev.y + dy * t - ev.clientY) < radius) { if (!hitSegs.has(si)) hitSegs.set(si, new Set()); hitSegs.get(si).add(i - 1); }
      }
      prev = cur;
    }
  });
  if (!hitSegs.size) return;
  if (!erasing) { pushUndo(); erasing = true; }
  const out = [];
  strokes.forEach((s, si) => {
    const cut = hitSegs.get(si);
    if (!cut) { out.push(s); return; }
    let run = [0];
    const flush = () => { if (run.length >= 2) out.push({ ...s, pts: run.map((k) => s.pts[k]), hints: s.hints && run.map((k) => s.hints[k]) }); };
    for (let i = 0; i + 1 < s.pts.length; i++) {
      if (cut.has(i)) { flush(); run = [i + 1]; } else run.push(i + 1);
    }
    flush();
  });
  strokes = out;
  trackChanged();
}

function placeFlag(ev) {
  rayFrom(ev);
  const hit = ribbonMesh && raycaster.intersectObject(ribbonMesh, false)[0];
  pushUndo();
  if (hit) {
    // nearest segment to the hit tells us the riding direction and side
    let best = null, bd = Infinity;
    const q = hit.point;
    for (const s of track.segs) {
      const a = V3(s.a), t = V3(s.t), along = Math.max(0, Math.min(s.L, q.clone().sub(a).dot(t)));
      const d = a.clone().addScaledVector(t, along).distanceTo(q);
      if (d < bd) { bd = d; best = { s, along }; }
    }
    const { s, along } = best, u = along / s.L;
    const n = V3(s.na).lerp(V3(s.nb), u).normalize();
    // keep heading roughly the way the old flag pointed / screen right
    let dir = V3(s.t);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    if (dir.dot(right) < 0) dir.negate();
    flag = { p: q.clone().addScaledVector(n, 0.04).toArray(), dir: dir.toArray(), up: n.toArray(), v: 2 };
  } else {
    const p = planeHit(ev);
    if (!p) return;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion); right.y = 0; right.normalize();
    flag = { p: p.toArray(), dir: right.toArray(), v: 2 };
  }
  trackChanged();
}

const canvas = renderer.domElement;
const activePointers = new Set();
canvas.addEventListener('pointerdown', (ev) => {
  activePointers.add(ev.pointerId);
  if (activePointers.size > 1) { draw = null; disposeGroup(previewGroup); return; }   // second finger: camera gesture
  if (ev.button !== 0 || tool === 'view') return;
  if (playing) togglePlay(false);
  if (tool === 'pencil' || tool === 'line') startStroke(ev);
  else if (tool === 'eraser') { erasing = false; eraseAt(ev); }
  else if (tool === 'flag') placeFlag(ev);
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener('pointermove', (ev) => {
  if (draw) extendStroke(ev);
  else if (tool === 'eraser' && ev.buttons & 1 && activePointers.size === 1) eraseAt(ev);
  // hover feedback: snap ring on line ends, pen dot on the plane
  if ((tool === 'pencil' || tool === 'line') && !playing) {
    const snap = ev.altKey ? null : findEnd(ev);
    snapMark.visible = !!snap;
    if (snap) { snapMark.position.copy(V3(snap.p)); snapMark.quaternion.copy(camera.quaternion); }
    const h = draw ? null : planeHit(ev);
    penMark.visible = !!h && !snap;
    if (h) penMark.position.copy(h);
  } else { snapMark.visible = penMark.visible = false; }
});
const pointerUp = (ev) => { activePointers.delete(ev.pointerId); if (draw) endStroke(); erasing = false; };
canvas.addEventListener('pointerup', pointerUp);
canvas.addEventListener('pointercancel', (ev) => { activePointers.delete(ev.pointerId); draw = null; disposeGroup(previewGroup); });
canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
canvas.addEventListener('wheel', (ev) => {
  if (!ev.shiftKey) return;
  ev.preventDefault(); ev.stopImmediatePropagation();
  movePlane(Math.sign(ev.deltaY || ev.deltaX) * 0.5);
}, { capture: true, passive: false });
function movePlane(d) {
  if (plane.mode === 'floor') plane.pivot.y -= d;
  else { const n = facingHint(); plane.pivot.addScaledVector(n, -d); }
  updateSketch();
}
function turnPlane(rad) {
  if (plane.mode !== 'wall') return;
  plane.yaw += rad;
  updateSketch();
}
function planeToView() {
  const f = new THREE.Vector3(); camera.getWorldDirection(f);
  if (plane.mode === 'wall') { plane.yaw = Math.atan2(-f.x, -f.z); }
  plane.pivot.copy(controls.target);
  updateSketch();
}

// ---------------------------------------------------------------- UI wiring
function setTool(t) {
  tool = t;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  applyControls();
  canvas.style.cursor = t === 'view' ? 'grab' : t === 'eraser' ? 'cell' : 'crosshair';
  updateSketch();
}
function applyControls() {
  const side = viewMode === 'side', look = tool === 'view';
  controls.enableRotate = !side;
  controls.mouseButtons = { LEFT: look ? (side ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE) : -1, MIDDLE: THREE.MOUSE.PAN, RIGHT: side ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE };
  controls.touches = { ONE: look ? (side ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE) : -1, TWO: THREE.TOUCH.DOLLY_PAN };
}
function setViewMode(m, quiet = false) {
  if (m === viewMode && quiet !== 'init') return;
  const old = camera.fov;
  viewMode = m;
  camera.fov = FOV[m];
  camera.updateProjectionMatrix();
  // keep the framing: scale the distance by the change in field of view
  const off = camera.position.clone().sub(controls.target);
  off.multiplyScalar(Math.tan(THREE.MathUtils.degToRad(old / 2)) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  camera.position.copy(controls.target).add(off);
  if (m === 'side') sideAng = null;
  $('viewMode').textContent = m === 'side' ? '2.5D' : '3D';
  $('viewMode').classList.toggle('on', m === 'side');
  $('cam').style.display = m === 'side' ? 'none' : '';
  applyControls();
  if (quiet !== 'init') try { localStorage.setItem('lr3d.view', m); } catch { /* */ }   // a URL-forced view isn't remembered
  if (quiet !== true && quiet !== 'init') toast(m === 'side' ? '2.5D side view: right-drag pans, wheel zooms' : '3D view: right-drag orbits');
}
function setType(k) { lineType = k; document.querySelectorAll('[data-type]').forEach((b) => b.classList.toggle('on', +b.dataset.type === k)); }
function setBank(on) { bankOn = on; $('bank').classList.toggle('on', on); }
function setPlaneMode(m) { plane.mode = m; updateSketch(); }
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
document.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => setType(+b.dataset.type)));
$('viewMode').onclick = () => setViewMode(viewMode === 'side' ? '3d' : 'side');
$('planeMode').onclick = () => setPlaneMode(plane.mode === 'wall' ? 'floor' : 'wall');
const holdButton = (el, dir) => {   // tap: 15 degrees; hold: steer
  let t0 = 0;
  el.addEventListener('pointerdown', () => { t0 = performance.now(); keys.add(dir < 0 ? 'hold-l' : 'hold-r'); });
  const up = () => { if (!t0) return; keys.delete(dir < 0 ? 'hold-l' : 'hold-r'); if (performance.now() - t0 < 250) turnPlane(dir * Math.PI / 12); t0 = 0; };
  el.addEventListener('pointerup', up); el.addEventListener('pointerleave', up);
};
holdButton($('yawL'), 1); holdButton($('yawR'), -1);
$('toView').onclick = planeToView;
$('bank').onclick = () => setBank(!bankOn);
$('grade').oninput = (e) => { grade = +e.target.value; };
$('width').oninput = (e) => { width = +e.target.value; };
$('undo').onclick = undo; $('redo').onclick = redo;
$('helpBtn').onclick = () => $('help').classList.toggle('show');
$('help').onclick = (e) => { if (e.target === $('help')) $('help').classList.remove('show'); };
$('file').onchange = (e) => {
  const v = e.target.value; e.target.value = '';
  if (v === 'demo') { pushUndo(); loadDemo(); toast('Demo track loaded'); }
  if (v === 'new') { pushUndo(); strokes = []; flag = defaultFlag(); trackChanged(); stop(); toast('Empty track (Ctrl+Z brings the old one back)'); }
  if (v === 'export') {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([snapshot()], { type: 'application/json' }));
    a.download = 'line-rider-3d-track.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  if (v === 'import') $('importFile').click();
};
$('importFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { const text = await f.text(); deserialize(text); pushUndo(); restore(text); try { localStorage.setItem(STORE, snapshot()); } catch { /* */ } stop(); frameTrack(); toast(`Loaded ${strokes.length} strokes`); } catch (err) { toast('Not a track file: ' + err.message); }
};
$('playBtn').onclick = () => togglePlay();
$('stop').onclick = () => stop();
$('speed').onchange = (e) => { playSpeed = +e.target.value; };
$('cam').onchange = (e) => { camMode = e.target.value; };
$('timeline').oninput = (e) => { togglePlay(false); playhead = +e.target.value; };

// buttons give the keyboard back after a click; a <select> must not blur on click (that closes its dropdown)
document.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => b.blur()));
document.querySelectorAll('select').forEach((b) => b.addEventListener('change', () => b.blur()));

let toastT = 0;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2200); }

let zoomIn = false;   // on play from far away, ease in to the rider until the user zooms themselves
canvas.addEventListener('wheel', () => { zoomIn = false; }, { passive: true });
function togglePlay(on = !playing) {
  if (on && !playing && camera.position.distanceTo(controls.target) > (viewMode === 'side' ? 70 : 40) && (camMode === 'follow' || viewMode === 'side')) zoomIn = true;
  playing = on;
  $('playBtn').textContent = playing ? '⏸' : '▶';
  if (playing) { draw = null; disposeGroup(previewGroup); }
  updateSketch();
}
function stop() { togglePlay(false); playhead = 0; scarf.init = false; }

addEventListener('keydown', (ev) => {
  if (ev.target.tagName === 'INPUT' && ev.target.type !== 'range') return;
  const k = ev.key.toLowerCase();
  if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if ((ev.ctrlKey || ev.metaKey) && k === 'y') { ev.preventDefault(); redo(); return; }
  if (ev.ctrlKey || ev.metaKey) return;
  if (k === ' ') { ev.preventDefault(); togglePlay(); return; }
  if (k === 'escape') { stop(); $('help').classList.remove('show'); return; }
  if (k === 'tab') { ev.preventDefault(); setPlaneMode(plane.mode === 'wall' ? 'floor' : 'wall'); return; }
  if (k === '?' || k === 'h') { $('help').classList.toggle('show'); return; }
  const toolKeys = { q: 'pencil', w: 'line', e: 'eraser', r: 'flag', t: 'view' };
  if (toolKeys[k]) { setTool(toolKeys[k]); return; }
  if (k === '1' || k === '2' || k === '3') { setType(+k - 1); return; }
  if (k === 'a' || k === 'd') { if (!ev.repeat && !draw) turnPlane((k === 'a' ? 1 : -1) * Math.PI / 12); keys.add(k); return; }
  if (k === 'pageup') { movePlane(-1); return; }
  if (k === 'pagedown') { movePlane(1); return; }
  if (k === 'v') { planeToView(); return; }
  if (k === 'g') { setViewMode(viewMode === 'side' ? '3d' : 'side'); return; }
  if (k === 'b') { setBank(!bankOn); toast(bankOn ? 'Banking on for new strokes' : 'Banking off for new strokes'); return; }
  if (k === 'c') { const opts = ['follow', 'chase', 'free']; camMode = opts[(opts.indexOf(camMode) + 1) % 3]; $('cam').value = camMode; toast('Camera: ' + camMode); return; }
  if (k === 'f' && flag) { pushUndo(); flag.dir = flag.dir.map((x) => -x); trackChanged(); return; }
});
addEventListener('keyup', (ev) => keys.delete(ev.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  for (const m of lineMats) m.resolution.set(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- loading
function loadDemo() { const d = makeDemo(); strokes = d.strokes; flag = d.flag; trackChanged(); stop(); frameTrack(); }
function frameTrack() {
  if (!strokes.length) return;
  const lo = V3(track.lo), hi = V3(track.hi), c = lo.clone().add(hi).multiplyScalar(0.5), size = hi.clone().sub(lo).length();
  controls.target.copy(c);
  if (viewMode === 'side') {
    // 2.5D: frame the start like a 2D editor, about 45 units of track across the screen
    controls.target.set(flag.p[0] + 14, flag.p[1] - 7, flag.p[2]);
    camera.position.copy(controls.target).add(new THREE.Vector3(0, 0.25, 1).multiplyScalar(120));
  } else camera.position.copy(c).add(new THREE.Vector3(-0.35, 0.55, 0.75).normalize().multiplyScalar(size * 0.75));
  sideAng = null;
  plane.pivot.set(flag.p[0] + 8, flag.p[1] - 4, flag.p[2]);
  plane.yaw = 0;
  scene.fog.near = Math.max(120, size * 0.8); scene.fog.far = Math.max(420, size * 3);
  updateSketch();
}
{
  let saved = null;
  try { saved = !Q.has('demo') && localStorage.getItem(STORE); } catch { /* */ }
  if (Q.has('empty')) { flag = defaultFlag(); trackChanged(false); }
  else if (saved) { try { restore(saved); frameTrack(); } catch { loadDemo(); } } else loadDemo();
  if (!localStorage.getItem('lr3d.seenHelp') && !Q.has('noui')) { $('help').classList.add('show'); try { localStorage.setItem('lr3d.seenHelp', '1'); } catch { /* */ } }
}
setViewMode(viewMode, 'init'); setTool('pencil'); setType(0); setBank(true); updateSketch();

// ---------------------------------------------------------------- camera follow
const camVel = new THREE.Vector3(1, 0, 0), camUp = new THREE.Vector3(0, 1, 0);
function followCamera(info, dt) {
  if (camMode === 'free') return;
  const { c, v } = info;
  if (camMode === 'follow') {
    const d = c.clone().sub(controls.target).multiplyScalar(1 - Math.exp(-6 * dt));
    controls.target.add(d); camera.position.add(d);
    if (zoomIn) {
      const off = camera.position.clone().sub(controls.target), l = off.length();
      if (l < 18) zoomIn = false; else camera.position.copy(controls.target).addScaledVector(off, (l + (16 - l) * (1 - Math.exp(-2 * dt))) / l);
    }
  } else {
    if (v.length() > 1) camVel.lerp(v.clone().normalize(), 1 - Math.exp(-2.5 * dt)).normalize();
    camUp.lerp(info.U, 1 - Math.exp(-3 * dt)).normalize();
    // behind along the line of travel and above the sled's own up, so slopes and banks don't put it under the track
    const want = c.clone().addScaledVector(camVel, -7).addScaledVector(camUp, 2.6).add(new THREE.Vector3(0, 0.8, 0));
    camera.position.lerp(want, 1 - Math.exp(-4 * dt));
    controls.target.lerp(c, 1 - Math.exp(-10 * dt));
  }
}

// 2.5D: the camera looks along the plane normal (editing) or across the rider's direction of travel (riding),
// turned SIDE_BACK toward where the track comes from and SIDE_PITCH down, at whatever distance the user zoomed to
const SIDE_BACK = 0.3, SIDE_PITCH = { wall: 0.24, floor: 1.05 };
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
function sideAngleFor(fwd) {   // fwd: horizontal unit direction that should run left -> right on screen
  const perp = new THREE.Vector3(-fwd.z, 0, fwd.x);   // fwd turned 90 degrees, toward the viewer
  const d = perp.multiplyScalar(Math.cos(SIDE_BACK)).addScaledVector(fwd, -Math.sin(SIDE_BACK));
  return Math.atan2(d.x, d.z);
}
function sideCamera(info, dt, snap = false) {
  let want;
  if (info && playing !== 'never') {
    const v = info.v.clone(); v.y = 0;
    if (v.length() > 2) {
      v.normalize();
      // two ways to see the motion across the screen: keep the one nearer the current view so the camera
      // never flips sides
      const a = sideAngleFor(v), b = sideAngleFor(v.clone().negate());
      want = sideAng === null || Math.abs(wrapPi(a - sideAng)) <= Math.abs(wrapPi(b - sideAng)) ? a : b;
    }
  } else {
    const n = new THREE.Vector3(Math.sin(plane.yaw), 0, Math.cos(plane.yaw));
    const right = new THREE.Vector3(Math.cos(plane.yaw), 0, -Math.sin(plane.yaw));
    const a = sideAngleFor(right), b = sideAngleFor(right.clone().negate());
    // look at the plane from whichever side the camera is already on
    want = sideAng === null ? (camera.position.clone().sub(controls.target).dot(n) >= 0 ? a : b)
      : (Math.abs(wrapPi(a - sideAng)) <= Math.abs(wrapPi(b - sideAng)) ? a : b);
  }
  if (sideAng === null) sideAng = want ?? 0;
  const k = snap ? 1 : 1 - Math.exp(-(info ? 1.6 : 5) * dt);
  if (want !== undefined) sideAng += wrapPi(want - sideAng) * k;
  sidePitch += ((plane.mode === 'floor' && !info ? SIDE_PITCH.floor : SIDE_PITCH.wall) - sidePitch) * (snap ? 1 : 1 - Math.exp(-5 * dt));
  if (info) {   // follow the rider
    const d = info.c.clone().sub(controls.target).multiplyScalar(snap ? 1 : 1 - Math.exp(-6 * dt));
    controls.target.add(d);
  }
  let dist = camera.position.distanceTo(controls.target);
  if (info && zoomIn) { if (dist < 34) zoomIn = false; else dist += (30 - dist) * (snap ? 1 : 1 - Math.exp(-2 * dt)); }
  const cp = Math.cos(sidePitch);
  camera.position.copy(controls.target).add(new THREE.Vector3(Math.sin(sideAng) * cp, Math.sin(sidePitch), Math.cos(sideAng) * cp).multiplyScalar(dist));
  camera.lookAt(controls.target);
}

// ---------------------------------------------------------------- main loop
function hud(info, fr) {
  const t = fr / 60, m = Math.floor(t / 60), s = (t % 60).toFixed(2).padStart(5, '0');
  $('time').textContent = `${m}:${s}`;
  const sp = Sim.speed(info.st);
  let html = `${sp.toFixed(1)} u/s`;
  if (info.st.crashed) html += '<br><span class="crash">BOSH!</span>';
  $('hud').innerHTML = html;
  const tl = $('timeline');
  tl.max = Math.max(1800, Math.ceil((rec.length + 120) / 600) * 600);
  tl.value = Math.floor(fr);
}
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  // steering while drawing: the plane turns about the pen's last point
  const steer = (keys.has('a') || keys.has('hold-l') ? 1 : 0) - (keys.has('d') || keys.has('hold-r') ? 1 : 0);
  if (steer && plane.mode === 'wall' && draw && draw.kind === 'pencil') { plane.pivot.copy(draw.pts[draw.pts.length - 1]); plane.yaw += steer * 1.4 * dt; updateSketch(); }
  else if (steer && !draw && (keys.has('hold-l') || keys.has('hold-r'))) { plane.yaw += steer * 1.4 * dt; updateSketch(); }
  if (playing) {
    playhead = Math.min(MAX_FRAMES - 1, playhead + dt * 60 * playSpeed);
  }
  const info = drawRider(playhead, playing ? dt * playSpeed : 0);
  drawTrail(playhead);
  trailLine.visible = playhead > 0;
  if (viewMode === 'side') { controls.update(); sideCamera(playing ? info : null, dt); }
  else { if (playing) followCamera(info, dt); controls.update(); }
  hud(info, playhead);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// headless shots: ?still=1&t=seconds&view=... renders one frame and stops
if (Q.has('still')) {
  const t = +(Q.get('t') || 0);
  playhead = Math.round(t * 60);
  if (Q.get('view') === 'chase' || Q.get('view') === 'follow') {
    camMode = Q.get('view');
    zoomIn = camMode === 'follow';
    sketch.visible = pivotMark.visible = false;
    // settle the camera on the rider as if it had been following
    for (let k = Math.max(0, playhead - 90); k <= playhead; k++) { const inf = drawRider(k, 1 / 60); if (viewMode === 'side') sideCamera(inf, 1 / 60, k === Math.max(0, playhead - 90)); else followCamera(inf, 1 / 60); }
  }
  if (Q.get('view') === 'plane') { setPlaneMode(Q.get('plane') || 'wall'); }
  if (viewMode === 'side' && !(Q.get('view') === 'chase' || Q.get('view') === 'follow')) sideCamera(null, 0, true);
  if (Q.get('view') === 'chase' || Q.get('view') === 'follow') { sketch.visible = pivotMark.visible = false; camera.lookAt(controls.target); }
  if (viewMode !== 'side') controls.update();
  const info = drawRider(playhead, 0);
  drawTrail(playhead);
  trailLine.visible = playhead > 0;
  hud(info, playhead);
  renderer.render(scene, camera);
  window.__ready = true;
} else requestAnimationFrame(frame);

window.__lr = {
  get strokes() { return strokes; }, get track() { return track; }, stateAt, Sim, toScreen: (p) => { const s = toScreen(p); return { x: s.x, y: s.y }; },
  status(fr) { const s = stateAt(fr); return { crashed: s.crashed, crashFrame: s.crashFrame, c: Sim.sledFrame(s).c, speed: Sim.speed(s) }; },
};

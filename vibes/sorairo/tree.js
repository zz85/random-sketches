// A lone broad tree: recursive branch tubes, foliage made of sphere-normal leaf-cluster
// billboards (the usual trick for anime trees), and falling leaves/petals.
import * as THREE from 'three';
import { COMMON, SHADOW } from './glsl.js';

export function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Leaf-cluster atlas drawn once on a canvas: R = per-leaf tone, A = coverage.
// Four variants in a 2x2 atlas so neighbouring cards don't repeat.
function makeClusterTexture(kind) {
  const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  const rnd = mulberry32(17);
  for (let v = 0; v < 4; v++) {
    const ox = (v % 2) * S / 2, oy = Math.floor(v / 2) * S / 2, H = S / 4;
    const n = kind === 'petal' ? 70 : 46;
    for (let i = 0; i < n; i++) {
      const r = Math.sqrt(rnd()) * H * 0.78, a = rnd() * Math.PI * 2;
      const x = ox + H + Math.cos(a) * r, y = oy + H + Math.sin(a) * r * 0.9;
      const tone = Math.floor(120 + 135 * (1 - r / H) * (0.6 + 0.4 * rnd()) * (y < oy + H ? 1 : 0.8));
      g.fillStyle = `rgb(${tone},${tone},${tone})`;
      g.save(); g.translate(x, y); g.rotate(a + (rnd() - 0.5) * 1.2);
      g.beginPath();
      if (kind === 'petal') { const s = 6 + rnd() * 5; g.ellipse(0, 0, s, s * 0.8, 0, 0, Math.PI * 2); }
      else { const L = 14 + rnd() * 10, W = L * (0.38 + rnd() * 0.12); g.moveTo(-L, 0); g.quadraticCurveTo(0, -W, L, 0); g.quadraticCurveTo(0, W, -L, 0); }
      g.fill(); g.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.colorSpace = THREE.NoColorSpace;
  return t;
}

export const TREE_STYLES = {
  summer: { leafDark: [0.06, 0.2, 0.12], leafLight: [0.42, 0.68, 0.18], rim: [0.9, 1.0, 0.45], fall: [0.35, 0.6, 0.15], fall2: [0.6, 0.72, 0.2], kind: 'leaf', petals: false },
  sakura: { leafDark: [0.62, 0.32, 0.45], leafLight: [1.0, 0.82, 0.88], rim: [1.0, 0.9, 0.95], fall: [1.0, 0.78, 0.85], fall2: [0.98, 0.9, 0.95], kind: 'petal', petals: true },
  autumn: { leafDark: [0.42, 0.1, 0.04], leafLight: [1.0, 0.55, 0.12], rim: [1.0, 0.85, 0.4], fall: [0.95, 0.4, 0.08], fall2: [0.95, 0.7, 0.15], kind: 'leaf', petals: false },
};

export function makeTree(shared, groundY, seed = 7, opts = {}) {
  const rnd = mulberry32(seed);
  const group = new THREE.Group();
  const branches = []; // {pts:[Vector3], rad:[number]}
  const clumps = [];   // {c:Vector3, r:number}

  // ---- branch skeleton
  function grow(start, dir, len, rad, depth) {
    const pts = [start.clone()], rads = [rad];
    const steps = Math.max(3, Math.round(len / 0.7));
    let p = start.clone(), d = dir.clone();
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // wander + gravitropism: limbs bend upward then outward
      d.x += (rnd() - 0.5) * 0.35; d.z += (rnd() - 0.5) * 0.35;
      d.y += depth === 0 ? 0.05 : (depth === 1 ? 0.06 - t * 0.12 : -0.02);
      d.normalize();
      p = p.clone().addScaledVector(d, len / steps);
      pts.push(p); rads.push(rad * (1 - t * (depth === 0 ? 0.35 : 0.65)));
    }
    branches.push({ pts, rad: rads });
    const end = pts[pts.length - 1];
    if (depth >= 3 || rad < 0.05) { clumps.push({ c: end.clone(), r: 1.6 + rnd() * 0.9 }); return; }
    const kids = depth === 0 ? 4 + Math.floor(rnd() * 2) : 2 + Math.floor(rnd() * 2);
    const ang0 = rnd() * Math.PI * 2;
    for (let k = 0; k < kids; k++) {
      const a = ang0 + (k / kids) * Math.PI * 2 + (rnd() - 0.5) * 0.8;
      const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const spread = depth === 0 ? 0.85 + rnd() * 0.35 : 0.55 + rnd() * 0.4;
      const nd = d.clone().multiplyScalar(1 - spread * 0.6).addScaledVector(out, spread).normalize();
      if (depth === 0) nd.y = Math.max(nd.y, 0.45);
      nd.normalize();
      // children start a little below the parent's end so joints look grown
      const at = pts[Math.max(1, pts.length - 1 - Math.floor(rnd() * 2))];
      grow(at, nd, len * (depth === 0 ? 0.75 : 0.66) * (0.8 + rnd() * 0.35), rads[rads.length - 1] * 0.92, depth + 1);
    }
    // side twig clumps along longer limbs
    if (depth >= 2) for (let i = 2; i < pts.length - 1; i += 2) if (rnd() < 0.4) {
      const o = new THREE.Vector3(rnd() - 0.5, rnd() * 0.6, rnd() - 0.5).normalize().multiplyScalar(0.9);
      clumps.push({ c: pts[i].clone().add(o), r: 1.2 + rnd() * 0.7 });
    }
  }
  const base = new THREE.Vector3(0, groundY - 0.4, 0);
  grow(base, new THREE.Vector3(0.08, 1, -0.05).normalize(), 7.0, 0.62, 0);
  // root flare
  for (let k = 0; k < 5; k++) {
    const a = k / 5 * Math.PI * 2 + rnd();
    const s = base.clone().add(new THREE.Vector3(0, 1.2, 0));
    const pts = [s, s.clone().add(new THREE.Vector3(Math.cos(a) * 0.6, -0.9, Math.sin(a) * 0.6)), s.clone().add(new THREE.Vector3(Math.cos(a) * 1.5, -1.5, Math.sin(a) * 1.5))];
    branches.push({ pts, rad: [0.35, 0.22, 0.08] });
  }

  // ---- trunk + branch tubes, merged
  const pos = [], nor = [], uv = [], idx = [];
  for (const b of branches) {
    const RS = b.rad[0] > 0.3 ? 12 : b.rad[0] > 0.12 ? 8 : 5;
    const baseI = pos.length / 3;
    let prevU = null;
    let vAcc = 0;
    for (let i = 0; i < b.pts.length; i++) {
      const p = b.pts[i];
      const t = (i < b.pts.length - 1 ? b.pts[i + 1].clone().sub(p) : p.clone().sub(b.pts[i - 1])).normalize();
      let u = prevU ? prevU.clone().sub(t.clone().multiplyScalar(prevU.dot(t))).normalize() : new THREE.Vector3(1, 0, 0).cross(t).normalize();
      if (u.lengthSq() < 0.5) u = new THREE.Vector3(0, 0, 1).cross(t).normalize();
      prevU = u; const v = t.clone().cross(u);
      if (i > 0) vAcc += p.distanceTo(b.pts[i - 1]);
      for (let k = 0; k <= RS; k++) {
        const a = k / RS * Math.PI * 2; const n = u.clone().multiplyScalar(Math.cos(a)).addScaledVector(v, Math.sin(a));
        const r = b.rad[i] * (1 + 0.06 * Math.sin(a * 3 + i));
        pos.push(p.x + n.x * r, p.y + n.y * r, p.z + n.z * r); nor.push(n.x, n.y, n.z); uv.push(k / RS, vAcc);
      }
    }
    for (let i = 0; i < b.pts.length - 1; i++) for (let k = 0; k < RS; k++) {
      const a = baseI + i * (RS + 1) + k, bb = a + 1, c = a + RS + 1, d = c + 1;
      idx.push(a, c, bb, bb, c, d);
    }
  }
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  tg.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  tg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  tg.setIndex(idx);
  const barkMat = new THREE.ShaderMaterial({
    uniforms: { ...shared, uBark: { value: new THREE.Color(0.13, 0.085, 0.07) } },
    vertexShader: /* glsl */ `
      varying vec3 vWp; varying vec3 vN; varying vec2 vUv;
      void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vWp = wp.xyz; vN = normal; vUv = uv; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: COMMON + SHADOW + /* glsl */ `
      uniform vec3 uBark; varying vec3 vWp; varying vec3 vN; varying vec2 vUv;
      void main() {
        vec3 n = normalize(vN);
        float streak = vnoise(vec2(vUv.x * 14.0, vUv.y * 1.2));
        vec3 alb = uBark * (0.75 + 0.5 * streak);
        float sh = treeShadow(vWp + n * 0.08, 0.004);
        float ao = mix(0.45, 1.0, smoothstep(0.0, 6.0, vWp.y - ${groundY.toFixed(2)}));
        vec3 col = celLight(alb, dot(n, uSunDir), sh, ao, 0.15);
        gl_FragColor = vec4(applyFog(col, vWp), 1.0);
      }`,
  });
  const trunk = new THREE.Mesh(tg, barkMat);
  trunk.userData.castShadow = true;
  group.add(trunk);

  // ---- foliage cards
  let cx = 0, cy = 0, cz = 0;
  for (const c of clumps) { cx += c.c.x; cy += c.c.y; cz += c.c.z; }
  const center = new THREE.Vector3(cx, cy, cz).divideScalar(clumps.length);
  const cards = [];
  for (const c of clumps) {
    const n = Math.round(24 * c.r * c.r);
    for (let i = 0; i < n; i++) {
      // points in a squashed sphere, denser toward the surface
      const u = rnd() * 2 - 1, a = rnd() * Math.PI * 2, rr = Math.pow(rnd(), 0.4) * c.r;
      const s = Math.sqrt(1 - u * u);
      const p = new THREE.Vector3(Math.cos(a) * s, u * 0.75, Math.sin(a) * s).multiplyScalar(rr).add(c.c);
      cards.push([p, c]);
    }
  }
  const N = cards.length;
  const qg = new THREE.InstancedBufferGeometry();
  qg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  qg.setIndex([0, 1, 2, 0, 2, 3]);
  const iPos = new Float32Array(N * 3), iNrm = new Float32Array(N * 3), iRnd = new Float32Array(N * 4);
  cards.forEach(([p, c], i) => {
    iPos.set([p.x, p.y, p.z], i * 3);
    const nl = p.clone().sub(c.c).normalize(), ng = p.clone().sub(center); ng.y *= 1.3; ng.normalize();
    const nn = nl.multiplyScalar(0.45).addScaledVector(ng, 0.55).normalize();
    iNrm.set([nn.x, nn.y, nn.z], i * 3);
    // depth into the canopy (for self-occlusion), angle, size, atlas cell
    const depthIn = 1 - Math.min(1, p.distanceTo(c.c) / c.r);
    iRnd.set([rnd() * Math.PI * 2, 0.6 + rnd() * 0.5, Math.floor(rnd() * 4), depthIn], i * 4);
  });
  qg.setAttribute('iPos', new THREE.InstancedBufferAttribute(iPos, 3));
  qg.setAttribute('iNrm', new THREE.InstancedBufferAttribute(iNrm, 3));
  qg.setAttribute('iRnd', new THREE.InstancedBufferAttribute(iRnd, 4));
  qg.instanceCount = N;

  const clusterTex = { leaf: makeClusterTexture('leaf'), petal: makeClusterTexture('petal') };
  const leafUniforms = {
    ...shared,
    uTex: { value: clusterTex.leaf },
    uLeafDark: { value: new THREE.Color() }, uLeafLight: { value: new THREE.Color() }, uRim: { value: new THREE.Color() },
    uCenter: { value: center },
  };
  const leafVS = /* glsl */ `
    uniform float uTime; uniform vec2 uWind;
    attribute vec3 iPos; attribute vec3 iNrm; attribute vec4 iRnd;
    varying vec2 vUv; varying vec3 vN; varying vec3 vWp; varying float vDepth; varying float vCell;
    void main() {
      vec3 wp = iPos;
      // canopy sways as a whole, outer cards more
      float sway = sin(uTime * 0.9 + iPos.x * 0.15) * 0.5 + sin(uTime * 1.7 + iPos.z * 0.3) * 0.25;
      wp.xz += uWind * sway * 0.08 * (1.0 - iRnd.w) + uWind * 0.12;
      float c = cos(iRnd.x), s = sin(iRnd.x);
      vec2 corner = mat2(c, -s, s, c) * position.xy * iRnd.y;
      vec4 mv = viewMatrix * vec4(wp, 1.0);
      mv.xy += corner;
      // card normal: blend the clump normal with the card's own bulge (sphere-normal billboard)
      vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
      vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
      vN = normalize(iNrm + (camR * position.x + camU * position.y) * 0.35);
      vWp = wp + camR * corner.x + camU * corner.y;
      vUv = position.xy * 0.5 + 0.5; vDepth = iRnd.w; vCell = iRnd.z;
      gl_Position = projectionMatrix * mv;
    }`;
  const leafMat = new THREE.ShaderMaterial({
    uniforms: leafUniforms,
    alphaToCoverage: true,
    side: THREE.DoubleSide,
    vertexShader: leafVS,
    fragmentShader: COMMON + SHADOW + /* glsl */ `
      uniform sampler2D uTex; uniform vec3 uLeafDark, uLeafLight, uRim, uCenter;
      varying vec2 vUv; varying vec3 vN; varying vec3 vWp; varying float vDepth; varying float vCell;
      void main() {
        vec2 cell = vec2(mod(vCell, 2.0), floor(vCell / 2.0)) * 0.5;
        vec4 t = texture2D(uTex, cell + vUv * 0.5);
        if (t.a < 0.35) discard;
        vec3 n = normalize(vN);
        vec3 vd = normalize(cameraPosition - vWp);
        float ndl = dot(n, uSunDir);
        float tsh = treeShadow(vWp + uSunDir * 1.4, 0.006);
        float sh = mix(1.0, tsh, 0.75) * cloudShadowAt(vWp);
        float lit = smoothstep(-0.1, 0.25, ndl) * sh;
        lit = mix(lit, smoothstep(0.3, 0.6, lit), 0.7);
        float tone = t.r;
        vec3 alb = mix(uLeafDark, uLeafLight, clamp(tone * 0.9 + lit * 0.25, 0.0, 1.0));
        float ao = mix(1.0, 0.45, vDepth) * mix(0.75, 1.0, smoothstep(-3.0, 3.0, vWp.y - uCenter.y));
        vec3 col = alb * (uAmbient * ao + uSunColor * lit);
        // backlit translucency and rim toward the sun
        float back = pow(max(dot(-vd, uSunDir), 0.0), 4.0) * (1.0 - vDepth) * tsh * smoothstep(-0.3, 0.3, n.y);
        float rim = pow(1.0 - max(dot(n, vd), 0.0), 3.0) * smoothstep(0.0, 0.4, ndl + 0.2);
        col += uRim * uSunColor * (back * 0.2 + rim * 0.1 * sh);
        gl_FragColor = vec4(applyFog(col, vWp), 1.0);
      }`,
  });
  const leafShadowMat = new THREE.ShaderMaterial({
    uniforms: leafUniforms,
    side: THREE.DoubleSide,
    vertexShader: leafVS,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex; varying vec2 vUv; varying float vCell;
      void main() { vec2 cell = vec2(mod(vCell, 2.0), floor(vCell / 2.0)) * 0.5; if (texture2D(uTex, cell + vUv * 0.5).a < 0.5) discard; gl_FragColor = vec4(1.0); }`,
  });
  const foliage = new THREE.Mesh(qg, leafMat);
  foliage.frustumCulled = false;
  foliage.userData.castShadow = true;
  foliage.userData.shadowMat = leafShadowMat;
  group.add(foliage);

  // ---- falling leaves (stateless: each one's path is a function of time)
  const FALL = opts.fallCount ?? 420;
  const fg = new THREE.InstancedBufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  fg.setIndex([0, 1, 2, 0, 2, 3]);
  const fSpawn = new Float32Array(FALL * 4), fRnd = new Float32Array(FALL * 4);
  for (let i = 0; i < FALL; i++) {
    const drift = i < FALL * 0.3; // drifters cross the whole view from upwind
    let p;
    if (drift) p = new THREE.Vector3((rnd() - 0.5) * 70, groundY + 2 + rnd() * 14, (rnd() - 0.5) * 70);
    else { const c = clumps[Math.floor(rnd() * clumps.length)]; p = c.c.clone().add(new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(c.r * 1.6)); }
    fSpawn.set([p.x, p.y, p.z, drift ? 1 : 0], i * 4);
    fRnd.set([rnd(), rnd(), rnd(), rnd()], i * 4);
  }
  fg.setAttribute('iSpawn', new THREE.InstancedBufferAttribute(fSpawn, 4));
  fg.setAttribute('iRnd', new THREE.InstancedBufferAttribute(fRnd, 4));
  fg.instanceCount = FALL;
  const fallUniforms = { ...shared, uFallA: { value: new THREE.Color() }, uFallB: { value: new THREE.Color() }, uPetal: { value: 0 }, uGround: { value: groundY }, uFallRate: { value: 1 } };
  const fallMat = new THREE.ShaderMaterial({
    uniforms: fallUniforms,
    side: THREE.DoubleSide,
    alphaToCoverage: true,
    vertexShader: /* glsl */ `
      uniform float uTime; uniform vec2 uWind; uniform float uGround; uniform float uPetal; uniform float uFallRate;
      attribute vec4 iSpawn; attribute vec4 iRnd;
      varying vec2 vUv; varying vec3 vWp; varying vec3 vN; varying float vSeed; varying float vFade;
      mat3 rotAxis(vec3 a, float ang) { float c = cos(ang), s = sin(ang), t = 1.0 - c;
        return mat3(t*a.x*a.x + c, t*a.x*a.y + s*a.z, t*a.x*a.z - s*a.y, t*a.x*a.y - s*a.z, t*a.y*a.y + c, t*a.y*a.z + s*a.x, t*a.x*a.z + s*a.y, t*a.y*a.z - s*a.x, t*a.z*a.z + c); }
      void main() {
        float drift = iSpawn.w;
        float T = mix(9.0, 16.0, iRnd.x) * mix(1.0, 1.6, drift);
        float tt = uTime * uFallRate + iRnd.y * T;
        float life = fract(tt / T);
        float cycle = floor(tt / T);
        // re-scatter the spawn point every cycle
        vec3 jitter = vec3(fract(sin(cycle * 12.9898 + iRnd.z * 78.233) * 43758.5453) - 0.5, 0.0, fract(sin(cycle * 39.346 + iRnd.w * 11.135) * 43758.5453) - 0.5);
        vec3 p = iSpawn.xyz + jitter * mix(3.0, 30.0, drift);
        float ws = length(uWind) + 0.01;
        float fallSpeed = mix(0.9, 1.6, iRnd.z) * mix(1.0, 0.25, drift);
        float t = life * T;
        p.y -= t * fallSpeed;
        p.xz += uWind * t * mix(0.55, 1.1, drift);
        if (drift > 0.5) p.xz -= uWind * T * 0.55;             // drifters enter from upwind
        // spiral flutter
        float w = mix(1.6, 3.2, iRnd.w);
        p.x += sin(t * w + iRnd.x * 6.28) * 0.6; p.z += cos(t * w * 0.8 + iRnd.y * 6.28) * 0.6;
        p.y += sin(t * w * 2.0) * 0.12;
        // rest on the ground
        float landed = 0.0;
        float gy = uGround - 0.6 - length(p.xz) * length(p.xz) * 0.0035;
        if (p.y < gy) { landed = 1.0; p.y = gy; }
        vec3 axis = normalize(vec3(sin(iRnd.x * 9.0), 0.6, cos(iRnd.y * 9.0)));
        mat3 R = rotAxis(axis, t * mix(2.0, 5.0, iRnd.z) * (1.0 - landed) + iRnd.w * 6.28);
        float size = mix(0.07, 0.11, iRnd.x) * mix(1.0, 0.75, uPetal);
        vec3 local = R * vec3(position.x * size, position.y * size * mix(0.55, 0.85, uPetal), 0.0);
        vN = R * vec3(0.0, 0.0, 1.0);
        vWp = p + local; vUv = position.xy; vSeed = iRnd.w;
        vFade = smoothstep(0.0, 0.04, life) * (1.0 - smoothstep(0.85, 1.0, life));
        gl_Position = projectionMatrix * viewMatrix * vec4(vWp, 1.0);
      }`,
    fragmentShader: COMMON + /* glsl */ `
      uniform vec3 uFallA, uFallB; uniform float uPetal;
      varying vec2 vUv; varying vec3 vWp; varying vec3 vN; varying float vSeed; varying float vFade;
      void main() {
        vec2 q = vUv;
        float d = uPetal > 0.5
          ? length(vec2(q.x, q.y * (1.0 + 0.4 * max(q.y, 0.0)))) - 0.9 + 0.35 * smoothstep(0.6, 1.0, q.y) * (1.0 - abs(q.x) * 4.0) // notched petal
          : abs(q.y) - 0.42 * (1.0 - q.x * q.x);                     // pointed leaf
        if (d > 0.0 || vFade < hash12(gl_FragCoord.xy)) discard;
        vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
        vec3 alb = mix(uFallA, uFallB, vSeed);
        float ndl = abs(dot(n, uSunDir));
        vec3 col = alb * (uAmbient + uSunColor * (0.35 + 0.65 * smoothstep(0.1, 0.4, ndl)) * cloudShadowAt(vWp));
        gl_FragColor = vec4(applyFog(col, vWp), 1.0);
      }`,
  });
  const falling = new THREE.Mesh(fg, fallMat);
  falling.frustumCulled = false;
  group.add(falling);

  function setStyle(name) {
    const s = TREE_STYLES[name];
    leafUniforms.uLeafDark.value.setRGB(...s.leafDark);
    leafUniforms.uLeafLight.value.setRGB(...s.leafLight);
    leafUniforms.uRim.value.setRGB(...s.rim);
    leafUniforms.uTex.value = clusterTex[s.kind];
    fallUniforms.uFallA.value.setRGB(...s.fall);
    fallUniforms.uFallB.value.setRGB(...s.fall2);
    fallUniforms.uPetal.value = s.petals ? 1 : 0;
  }
  function dispose() {
    tg.dispose(); qg.dispose(); fg.dispose(); barkMat.dispose(); leafMat.dispose(); leafShadowMat.dispose(); fallMat.dispose();
    clusterTex.leaf.dispose(); clusterTex.petal.dispose();
  }
  return { group, setStyle, dispose, center, fallUniforms, cards: N, clumps: clumps.length };
}

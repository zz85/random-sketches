// Screen effects in WebGL2, as a pass over the finished 2D frame: cracked cover glass and liquid
// ripples. The 2D canvas is uploaded as a texture each frame (a GPU copy) and drawn again through a
// fragment shader that bends it: every glass shard shifts the picture a little, the crack edges
// split it into colours and catch the light, the panel under the impact bleeds, and ripples run
// out from touches. When nothing is cracked or rippling, the pass is off and costs nothing.
//
// Crack geometry is made once per impact (fracture()) in logical pixels and rasterised into two
// maps: map 1 holds each shard's shift (RG) and turn about the impact (B); map 2 the crack lines (R), a
// blurred copy of them (G), whose gradient gives the side facing the light, and which crack it is (B).
// The look follows kossik/cracked-glass's notes on the optics of broken glass: few long cracks,
// nearly straight, forking now and then; short dead-end hackle hairlines; partial rings near a
// crushed spot; width and brightness that vary along a crack; per-shard plate tilt.

const TAU = Math.PI * 2;

// kind: 'hair' one thin line (a slow triple tap), 'crack' a few sideways cracks, 'web' a spider web
// of radial cracks joined by rings (a quadruple tap)
export function fracture(x, y, W, H, rnd = Math.random, P = 1, kind = 'crack') {
  const hair = kind === 'hair', web = kind === 'web';
  const R = Math.hypot(W, H) * 1.3, lines = [], rays = [];
  const noise = () => { const v = Array.from({ length: 16 }, rnd); return (s) => { const f = s / 70, i = Math.floor(f), t = f - i, a = v[i & 15], b = v[(i + 1) & 15]; return a + (b - a) * t * t * (3 - 2 * t); }; };
  // one crack from (px, py) along a, wandering a little around its own heading
  const run = (px, py, a, len, w, kink = 0.06) => {
    const base = a, pts = [[px, py]];
    for (let d = 0; d < len;) {
      const st = 9 + rnd() * 14;
      a += (rnd() - 0.5) * 0.07 + (rnd() < kink ? (rnd() - 0.5) * 0.5 : 0);
      a = base + Math.max(-0.22, Math.min(0.22, a - base));
      px += Math.cos(a) * st; py += Math.sin(a) * st; d += st;
      pts.push([px + (rnd() - 0.5) * 1.4, py + (rnd() - 0.5) * 1.4]);
      if (px < -60 || py < -60 || px > W + 60 || py > H + 60) break;
    }
    const L = { pts, w, bright: noise(), jag: noise() };
    lines.push(L);
    return L;
  };
  // one to four main cracks running across the screen, roughly sideways, through the impact:
  // a gentle fan of headings, each half wandering on its own; now and then one half stops short
  if (web) {
    // radial cracks all round, spaced unevenly
    const n = Math.min(12, 8 + Math.floor(rnd() * 3 + P)), a0 = rnd() * TAU;
    for (let i = 0; i < n; i++) {
      const ang = a0 + (i + (rnd() - 0.5) * 0.6) * TAU / n;
      const L = run(x, y, ang, R, (1.2 + rnd() * 0.7) * (0.75 + 0.25 * P));
      L.full = true; L.ang = ang; rays.push(L);
    }
  } else if (hair) {
    // one thin line; one half often stops partway
    const ang = (rnd() - 0.5) * 1.2;
    for (const side of [0, Math.PI]) {
      const full = side === 0 || rnd() < 0.5, L = run(x, y, ang + side + (rnd() - 0.5) * 0.06, full ? R : 120 + rnd() * 260, 0.8);
      L.full = full; L.ang = ang + side; if (full) rays.push(L);
    }
  }
  const n = hair || web ? 0 : Math.max(1, Math.min(4, Math.round(0.5 + 0.8 * P + rnd() * 1.2)));
  const tilt = (rnd() - 0.5) * 1.3, gap = 0.3 + rnd() * 0.5; // up to about 37 degrees off level, spread apart
  for (let i = 0; i < n; i++) {
    const head = tilt + (i - (n - 1) / 2) * gap * (0.6 + 0.8 * rnd()) + (rnd() - 0.5) * 0.25, w = (1.3 + rnd() * 0.6) * (0.75 + 0.25 * P);
    for (const side of [0, Math.PI]) {
      const full = i === 0 || rnd() > 0.25 / P, ang = head + side + (rnd() - 0.5) * 0.08;
      const L = run(x, y, ang, full ? R : (80 + rnd() * 220) * Math.sqrt(P), w);
      L.full = full; L.ang = ang;
      if (full) rays.push(L);
    }
  }
  // forks and hackle: cracks branch at 20-35 degrees and some hairlines die into the glass
  for (const M of lines.slice()) {
    const P = M.pts;
    for (let f = hair ? 0 : rnd() < (web ? 0.7 : 0.45) ? 1 : 0; f-- > 0;) {
      const k = 4 + Math.floor(rnd() * Math.max(1, Math.min(P.length - 5, 30))), [px, py] = P[k], [qx, qy] = P[k - 1];
      const a = Math.atan2(py - qy, px - qx) + (rnd() < 0.5 ? -1 : 1) * (0.35 + rnd() * 0.25);
      run(px, py, a, 60 + rnd() * 320, M.w * 0.7, 0.04);
    }
    for (let s = hair ? Math.floor(rnd() * 3) : Math.round((2 + rnd() * 5) * Math.sqrt(P) * (web ? 1.6 : 1)); s-- > 0;) {
      const k = 1 + Math.floor(rnd() * (P.length - 2)), [px, py] = P[k], [qx, qy] = P[k - 1];
      const a = Math.atan2(py - qy, px - qx) + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.6);
      run(px, py, a, 4 + rnd() * 16, 0.55, 0);
    }
  }
  // the crushed spot: tiny splinters and one or two partial rings
  for (let i = 0, k = hair ? 0 : Math.round((2 + 2 * P) * (web ? 3 : 1)); i < k; i++) run(x, y, rnd() * TAU, (3 + rnd() * 9) * Math.sqrt(P), 0.6, 0);
  const rings = [];
  for (let i = 0, nr = !hair && !web && rnd() < 0.4 ? 1 : 0; i < nr; i++) {
    const r = 12 + rnd() * 22 + i * 16, s0 = rnd() * TAU, span = 1.2 + rnd() * 2.6, pts = [];
    for (let t = 0; t <= 14; t++) { const q = s0 + span * t / 14, rr = r + (rnd() - 0.5) * 2.5; pts.push([x + Math.cos(q) * rr, y + Math.sin(q) * rr]); }
    lines.push({ pts, w: 0.9, bright: noise(), jag: noise() });
    rings.push({ r, s0, span });
  }
  // the web: rings of short cracks joining neighbouring rays, sagging a little toward the impact,
  // closer together near it; a few links are missing
  if (web) {
    const at = (L, r) => { for (const p of L.pts) if (Math.hypot(p[0] - x, p[1] - y) >= r) return p; return null; };
    const order = rays.slice().sort((a, b) => a.ang - b.ang);
    for (let k = 0, nr = 3 + Math.floor(rnd() * 2 + P * 0.6), r = 18 + rnd() * 10; k < nr; k++, r *= 1.55 + rnd() * 0.35) {
      order.forEach((A, i) => {
        const B = order[(i + 1) % order.length];
        if (rnd() < 0.18) return;
        const a = at(A, r * (0.9 + rnd() * 0.2)), b = at(B, r * (0.9 + rnd() * 0.2));
        if (!a || !b) return;
        const sag = 0.08 + rnd() * 0.12, mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, pts = [];
        for (let t = 0; t <= 6; t++) {
          const u = t / 6, s = 1 - sag * 4 * u * (1 - u), px = a[0] + (b[0] - a[0]) * u, py = a[1] + (b[1] - a[1]) * u;
          pts.push([x + (px - x) * s + (rnd() - 0.5) * 1.2, y + (py - y) * s + (rnd() - 0.5) * 1.2]);
        }
        lines.push({ pts, w: 0.9 + rnd() * 0.4, bright: noise(), jag: noise() });
      });
    }
  }
  // shards: wedges between the full cracks, each a glass plate with its own tilt
  for (const A of rays) A.ang = Math.atan2(A.pts.at(-1)[1] - y, A.pts.at(-1)[0] - x);
  rays.sort((a, b) => a.ang - b.ang);
  const shards = rays.map((A, i) => {
    const B = rays[(i + 1) % rays.length];
    let a1 = Math.atan2(A.pts.at(-1)[1] - y, A.pts.at(-1)[0] - x), a2 = Math.atan2(B.pts.at(-1)[1] - y, B.pts.at(-1)[0] - x);
    while (a2 <= a1) a2 += TAU;
    const arc = []; for (let t = 1; t < 12; t++) { const q = a1 + (a2 - a1) * t / 12; arc.push([x + Math.cos(q) * R, y + Math.sin(q) * R]); }
    const poly = [[x, y], ...A.pts, ...arc, ...B.pts.slice().reverse()];
    const t = rnd() * TAU, m = (1.2 + rnd() * 3) * P ** 0.8 * (hair ? 0.3 : 1);
    return { poly, dx: Math.cos(t) * m, dy: Math.sin(t) * m, rot: (rnd() < 0.5 ? -1 : 1) * (0.3 + 0.7 * rnd()) * 0.011 * P };
  });
  return { x, y, lines, shards, rings, seed: rnd(), power: P, kind, blot: hair ? 0 : (4 + rnd() * 6) * (0.85 + 0.15 * P) * (web ? 1.5 : 1), streaks: hair ? 0 : Math.min(7, Math.round(1 + P + rnd() * 2) + (web ? 2 : 0)), born: performance.now() / 1000 };
}

// draw a crack as a ribbon that tapers to its tip, with brightness that comes and goes
function ribbon(g, L, scale, alpha, solid = false) {
  const P = L.pts; let s = 0, len = 0;
  for (let k = 1; k < P.length; k++) len += Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]);
  for (let k = 1; k < P.length; k++) {
    const d = Math.hypot(P[k][0] - P[k - 1][0], P[k][1] - P[k - 1][1]), t = (s + d / 2) / Math.max(1, len); s += d;
    const w = L.w * scale * (1 - 0.5 * t ** 1.6) * (0.75 + 0.5 * L.jag(s)), a = alpha * (0.6 + 0.4 * L.bright(s));
    g.globalAlpha = solid ? 1 : a; g.lineWidth = Math.max(0.3, w);
    g.beginPath(); g.moveTo(P[k - 1][0], P[k - 1][1]); g.lineTo(P[k][0], P[k][1]); g.stroke();
  }
  g.globalAlpha = 1;
}

// 2D fallback when there is no WebGL: the same cracks, drawn plainly
export function drawCracks2D(g, list, K) {
  g.save(); g.setTransform(K, 0, 0, K, 0, 0); g.lineCap = 'round'; g.lineJoin = 'round';
  for (const C of list) for (const L of C.lines) {
    g.save(); g.translate(0.6, 0.8); g.strokeStyle = 'rgba(0,0,0,.5)'; ribbon(g, L, 2.4, 1); g.restore();
    g.strokeStyle = 'rgba(255,255,255,.9)'; ribbon(g, L, 1.3, 1);
  }
  g.restore();
}

const VS = `#version 300 es
in vec2 aP; out vec2 vUv;
void main() { vUv = aP * 0.5 + 0.5; gl_Position = vec4(aP, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform sampler2D uScene, uMap1, uMap2;
uniform vec2 uRes; uniform float uK, uTime, uCracked;
uniform vec4 uRip[24]; uniform int uNRip;
uniform vec4 uImp[8]; uniform vec4 uImp2[8]; uniform int uNImp;
in vec2 vUv; out vec4 o;

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
vec3 iri(float t) { return 0.5 + 0.5 * cos(6.2832 * (t + vec3(0.0, 0.33, 0.67))); }
// device pixels (y down) <-> texture coordinates (y up)
vec2 toUv(vec2 p) { return vec2(p.x, uRes.y - p.y) / uRes; }
// a crack runs out from its impact over half a second; front() is how far it has got
float reachOf(vec2 c) { vec2 S = uRes / uK; return length(max(c, S - c)) + 40.0; } // farthest corner
float front(float age, vec2 c) { float t = clamp(age / 0.5, 0.0, 1.0); return reachOf(c) * (1.0 - (1.0 - t) * (1.0 - t)); }
float reveal(int i, vec2 q) { float d = length(q - uImp[i].xy), r = front(uImp[i].w, uImp[i].xy); return uImp[i].w >= 0.5 ? 1.0 : 1.0 - smoothstep(r - 30.0, r, d); }

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uRes;   // device px, y down
  vec2 q = p / uK;                             // logical px
  vec2 L = normalize(vec2(-0.55, -0.83));      // light from the top left

  // ripples: wave packets running out from where the glass was touched
  vec2 disp = vec2(0.0); float shade = 0.0;
  for (int i = 0; i < 24; i++) {
    if (i >= uNRip) break;
    vec4 r = uRip[i]; vec2 d = q - r.xy; float dist = length(d) + 1e-3, age = r.z;
    float x = dist - 300.0 * age, sig = 22.0 + 40.0 * age;
    float env = r.w * exp(-x * x / (sig * sig)) * exp(-1.8 * age) * (1.0 - exp(-dist * dist / 400.0));
    float k = 6.2832 / (26.0 + 18.0 * age), slope = env * cos(k * x);
    disp += d / dist * slope * 5.0; shade += dot(d / dist, L) * slope;
  }

  // shards: each plate shifts what is under it
  vec4 m1 = texture(uMap1, vUv), m2 = texture(uMap2, vUv);
  // the nearest impact pivots its shards; a crack pixel knows which impact it belongs to
  int ni = 0; float nd = 1e9;
  for (int i = 0; i < 8; i++) { if (i >= uNImp) break; float d = length(q - uImp[i].xy); if (d < nd) { nd = d; ni = i; } }
  int li = int(floor(m2.b * 255.0 / 20.0 + 0.5)) - 1; if (li < 0 || li >= uNImp) li = ni;
  float revS = uNImp > 0 ? reveal(ni, q) : 0.0, revL = uNImp > 0 ? reveal(li, q) : 0.0;
  // shards: each plate is shifted and turned a little about the impact, so it tilts as a whole
  vec2 v = q - uImp[ni].xy;
  float rot = (m1.z - 128.0 / 255.0) * 255.0 / 3000.0;
  vec2 off = ((m1.xy - 128.0 / 255.0) * 255.0 / 8.0 + vec2(-v.y, v.x) * rot) * revS * uCracked; // logical px
  float facet = clamp(rot * 70.0 + dot(off, L) * 0.06, -1.0, 1.0) * revS * uCracked;
  float line = m2.r * uCracked * revL, glow = m2.g * uCracked * revL;
  // the running tip glints
  float la = uNImp > 0 ? uImp[li].w : 1.0, dl = uNImp > 0 ? length(q - uImp[li].xy) : 0.0, fr = front(la, uNImp > 0 ? uImp[li].xy : vec2(0.0));
  line += (la < 0.5 ? exp(-(fr - dl) * (fr - dl) / 300.0) : 0.0) * smoothstep(0.2, 0.7, m2.g) * uCracked;
  vec2 e = vec2(1.5 / uRes.x, 0.0), f = vec2(0.0, 1.5 / uRes.y);
  vec2 grad = vec2(texture(uMap2, vUv + e).g - texture(uMap2, vUv - e).g, -(texture(uMap2, vUv + f).g - texture(uMap2, vUv - f).g));
  vec2 n = length(grad) > 1e-4 ? normalize(grad) : vec2(0.0);   // points away from the crack
  float lit = dot(-n, L);

  // where the picture comes from: bent by ripples, shards and, at a crack, split by colour
  vec2 src = p + (disp + off) * uK;
  vec2 ca = n * glow * 1.6 * uK + off * 0.06 * uK;
  vec3 col = vec3(texture(uScene, toUv(src + ca)).r, texture(uScene, toUv(src)).g, texture(uScene, toUv(src - ca)).b);
  vec2 sq = src / uK;

  // the panel under the glass: an ink blot spreading from each impact, fingers of it along the
  // cracks and an oily rainbow round it
  for (int i = 0; i < 8; i++) {
    if (i >= uNImp) break;
    vec4 a = uImp[i], b = uImp2[i];
    if (b.x <= 0.0) continue; // a hairline leaves the panel alone
    float dist = length(sq - a.xy), nz = fbm(sq / 14.0 + a.z * 37.0), nz2 = fbm(sq / 5.0 - a.z * 11.0);
    float grow = min(1.0, 0.25 + a.w * 0.9) * (1.0 + min(a.w, 30.0) * 0.012);
    float R = b.x * grow * (0.7 + 0.75 * nz);
    float blot = 1.0 - smoothstep(R - 1.5, R + 1.0, dist);
    float fing = smoothstep(0.42, 0.7, glow * (0.6 + 0.8 * nz2)) * exp(-dist / (b.x * grow * 3.2));
    blot = max(blot, fing);
    float rim = (1.0 - smoothstep(R, R + 5.0 + 4.0 * nz2, dist)) * (1.0 - blot);
    col = mix(col, vec3(0.012, 0.008, 0.02), blot * 0.96);
    col = mix(col, iri(nz * 1.7 + dist * 0.04) * vec3(0.8, 0.5, 1.0), rim * 0.6);
    float halo = smoothstep(R * 5.0, R * 1.2, dist) * (1.0 - blot) * (0.5 + 0.5 * cos(dist * 0.5 + nz * 6.0));
    col += (iri(dist * 0.012 + nz) - 0.5) * halo * 0.1;
  }
  // the LCD under it: light leaking through dislodged layers as thin blue and red streaks, most of
  // them columns down the panel, some rows along the crack, fading away from the impact
  for (int i = 0; i < 8; i++) {
    if (i >= uNImp) break;
    vec4 a = uImp[i], b = uImp2[i];
    for (int k = 0; k < 7; k++) {
      if (float(k) >= b.y) break;
      float h1 = h21(vec2(a.z * 91.0, float(k))), h2 = h21(vec2(float(k), a.z * 53.0)), h3 = h21(vec2(a.z + float(k), 7.7));
      bool row = h3 < 0.28;
      float c0 = (row ? a.y : a.x) + (h1 - 0.5) * (row ? 70.0 : 260.0);   // where the streak sits
      float along = row ? sq.x - a.x : sq.y - a.y, across = (row ? sq.y : sq.x) - c0;
      float w = 0.6 + h2 * 2.6, reach = 90.0 + h1 * 330.0 * b.z;
      float core = 1.0 - smoothstep(w * 0.5, w * 0.5 + 0.7, abs(across));
      float halo = exp(-across * across / (w * w * 9.0)) * 0.35;
      float fade = exp(-abs(along) / reach) * (0.75 + 0.25 * vnoise(vec2(along / 9.0, a.z * 13.0 + float(k))));
      float on = smoothstep(abs(along) + 20.0, abs(along) + 60.0, front(a.w, a.xy)) * smoothstep(0.0, 0.25, a.w);
      vec3 tint = h2 < 0.5 ? vec3(0.2, 0.45, 1.0) : h2 < 0.8 ? vec3(1.0, 0.16, 0.22) : vec3(0.85, 0.25, 1.0);
      col = mix(col, tint * 1.25, clamp(core * fade * on, 0.0, 1.0) * 0.7) + tint * halo * fade * on * 0.5;
    }
  }

  // the glass: facet tilt, the crack's dark face and its lit face, the thin bright core
  float near = smoothstep(0.08, 0.6, glow);
  col *= 1.0 + facet * 0.12;
  col *= 1.0 - near * 0.22 * clamp(-lit, 0.0, 1.0);
  col += near * 0.16 * clamp(lit, 0.0, 1.0);
  float shadow = texture(uMap2, vUv + vec2(-0.9, 1.1) * uK / uRes).r * uCracked * revL;
  col *= 1.0 - 0.45 * clamp(shadow - line, 0.0, 1.0);
  col = mix(col, vec3(1.0), clamp(line * 1.3, 0.0, 1.0) * (0.75 + 0.2 * clamp(lit + 0.5, 0.0, 1.0)));
  col += (iri(glow * 2.0 + p.x * 0.002) - 0.5) * near * 0.12;
  // ripple light
  col += shade * 0.25;
  o = vec4(col, 1.0);
}`;

export function createFX(cv) {
  const out = { ok: false, ripples: [], cracks: [] };
  const glc = document.createElement('canvas');
  glc.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;visibility:hidden'; glc.width = glc.height = 1;
  cv.after(glc);
  const gl = glc.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) return out;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  let prog;
  try {
    prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (e) { console.warn('fx: no shader', e); return out; }
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aP = gl.getAttribLocation(prog, 'aP'); gl.enableVertexAttribArray(aP); gl.vertexAttribPointer(aP, 2, gl.FLOAT, false, 0, 0);
  const U = {}; for (const n of ['uScene', 'uMap1', 'uMap2', 'uRes', 'uK', 'uTime', 'uCracked', 'uRip', 'uNRip', 'uImp', 'uImp2', 'uNImp']) U[n] = gl.getUniformLocation(prog, n);
  const tex = (unit) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128, 255])); return t; };
  const T = [tex(0), tex(1), tex(2)];
  gl.uniform1i(U.uScene, 0); gl.uniform1i(U.uMap1, 1); gl.uniform1i(U.uMap2, 2);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  const map1 = document.createElement('canvas'), map2 = document.createElement('canvas');
  let mapsDirty = true, K = 1, awake = false, sceneW = 0, sceneH = 0;
  const MK = () => Math.min(K, 1.5); // map resolution: device px per logical px, capped

  function rasterise() {
    const mk = MK(), w = Math.round(cv.width / K * mk), h = Math.round(cv.height / K * mk);
    for (const m of [map1, map2]) { m.width = w; m.height = h; }
    const g1 = map1.getContext('2d'), g2 = map2.getContext('2d');
    g1.fillStyle = 'rgb(128,128,128)'; g1.fillRect(0, 0, w, h);
    g2.fillStyle = '#000'; g2.fillRect(0, 0, w, h);
    g1.setTransform(mk, 0, 0, mk, 0, 0); g2.setTransform(mk, 0, 0, mk, 0, 0);
    for (const C of out.cracks) {
      // each crack's shards fade out with distance, so an older crack keeps its shards elsewhere
      for (const s of C.shards) {
        const cl = (v) => Math.max(1, Math.min(255, Math.round(128 + v))), c = (a) => `rgba(${cl(s.dx * 8)},${cl(s.dy * 8)},${cl(s.rot * 3000)},${a})`;
        const rg = g1.createRadialGradient(C.x, C.y, 0, C.x, C.y, 520); rg.addColorStop(0, c(1)); rg.addColorStop(0.6, c(0.85)); rg.addColorStop(1, c(0));
        g1.fillStyle = rg; g1.beginPath(); s.poly.forEach(([x, y], i) => (i ? g1.lineTo(x, y) : g1.moveTo(x, y))); g1.closePath(); g1.fill();
      }
      g1.fillStyle = 'rgb(128,128,128)'; g1.beginPath(); g1.arc(C.x, C.y, 5, 0, TAU); g1.fill();
    }
    g2.lineCap = 'round'; g2.lineJoin = 'round'; g2.globalCompositeOperation = 'lighten';
    // B: which crack a pixel belongs to (1-based x 20, unblurred so it decodes cleanly; newest wins)
    out.cracks.forEach((C, i) => { g2.strokeStyle = `rgb(0,0,${(i + 1) * 20})`; for (const L of C.lines) ribbon(g2, L, 5, 1, true); });
    g2.save(); g2.filter = `blur(${(1.6 * mk).toFixed(1)}px)`; g2.strokeStyle = '#0f0';
    for (const C of out.cracks) for (const L of C.lines) ribbon(g2, L, 4.2, 0.9);
    g2.restore();
    g2.strokeStyle = '#f00';
    for (const C of out.cracks) for (const L of C.lines) ribbon(g2, L, 1.5, 1);
    for (const [unit, m] of [[1, map1], [2, map2]]) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, T[unit]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, m); m.width = m.height = 0; }
    mapsDirty = false;
  }

  // a lost context hands the cracks back to the 2D fallback
  glc.addEventListener('webglcontextlost', (e) => { e.preventDefault(); out.ok = false; glc.style.visibility = 'hidden'; });
  // idle: give back the drawing buffer and the textures
  function sleep() {
    awake = false; glc.style.visibility = 'hidden'; glc.width = glc.height = 1;
    const px = new Uint8Array([128, 128, 128, 255]);
    for (let u = 0; u < 3; u++) { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, T[u]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px); }
    sceneW = sceneH = 0; mapsDirty = true;
  }
  const rip = new Float32Array(24 * 4), imp = new Float32Array(8 * 4), imp2 = new Float32Array(8 * 4);
  Object.assign(out, {
    ok: true, canvas: glc,
    resize(k) { K = k; mapsDirty = true; if (awake) { glc.width = cv.width; glc.height = cv.height; } },
    removeCrack(C) { const i = out.cracks.indexOf(C); if (i >= 0) { out.cracks.splice(i, 1); mapsDirty = true; } },
    addCrack(C) { out.cracks.push(C); if (out.cracks.length > 8) out.cracks.shift(); mapsDirty = true; },
    clear() { out.cracks.length = 0; out.ripples.length = 0; mapsDirty = true; },
    ripple(x, y, amp = 1) { out.ripples.push({ x, y, t: performance.now() / 1000, amp }); if (out.ripples.length > 24) out.ripples.shift(); },
    render() {
      if (!out.ok) return;
      const now = performance.now() / 1000;
      out.ripples = out.ripples.filter((r) => now - r.t < 2.6);
      if (!out.cracks.length && !out.ripples.length) { if (awake) sleep(); return; }
      if (!awake) { awake = true; glc.width = cv.width; glc.height = cv.height; }
      if (glc.width !== cv.width || glc.height !== cv.height) { glc.width = cv.width; glc.height = cv.height; }
      if (mapsDirty) rasterise();
      glc.style.visibility = 'visible';
      gl.viewport(0, 0, glc.width, glc.height);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T[0]);
      if (sceneW !== cv.width || sceneH !== cv.height) { // storage once per size, then update in place
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv); sceneW = cv.width; sceneH = cv.height;
      } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      out.ripples.forEach((r, i) => rip.set([r.x, r.y, now - r.t, r.amp], i * 4));
      out.cracks.forEach((C, i) => { imp.set([C.x, C.y, C.seed, now - C.born], i * 4); imp2.set([C.blot, C.streaks, C.power, 0], i * 4); });
      gl.uniform2f(U.uRes, glc.width, glc.height); gl.uniform1f(U.uK, K); gl.uniform1f(U.uTime, now); gl.uniform1f(U.uCracked, out.cracks.length ? 1 : 0);
      gl.uniform4fv(U.uRip, rip); gl.uniform1i(U.uNRip, out.ripples.length);
      gl.uniform4fv(U.uImp, imp); gl.uniform4fv(U.uImp2, imp2); gl.uniform1i(U.uNImp, out.cracks.length);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
  });
  return out;
}

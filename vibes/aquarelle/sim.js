/*
 * sim.js - the watercolour engine: WebGL2 fragment-shader simulation on the sheet's pixel grid.
 *
 * State (RGBA16F, ping-ponged):
 *   W   r water standing on the paper, g water absorbed in the paper (capillary layer)
 *   FK  pigment suspended in the water: K (absorption, rgb) and a = granulation mass
 *   FS  same pigment: S (scattering, rgb) and a = liftability mass
 *   DK, DS  pigment deposited in the paper, same layout
 *   F   outflow flux to the 4 neighbours (right, left, +y, -y) of the pipe model (single)
 *
 * One substep is three passes, scissored to the "active" rectangle that holds all wet paper
 * (dry paper costs nothing):
 *   A flux:     virtual-pipe shallow water (O'Brien & Hodgins 1995, Mei et al. 2007), driven by
 *               the difference in water height + a little paper height, damped, with gravity
 *               for tilted paper. Water only advances onto dry paper when it stands deep
 *               enough (surface tension pins the contact line), more easily along the
 *               paper's valleys; onto damp paper it creeps (capillary flow: backruns).
 *   B water:    apply fluxes; pigment moves with the fraction of water that moves, so it is
 *               conserved exactly; small diffusion inside wet areas (wet-in-wet softness);
 *               absorption into and diffusion within the paper; evaporation, faster near the
 *               edge of a wet area, which pulls water and pigment outward (edge darkening,
 *               Deegan et al.'s coffee ring, as Curtis et al. 1997 model it).
 *   C transfer: Curtis et al.'s adsorption/desorption between water and paper, with
 *               granulating pigment settling into the paper's valleys and staining pigment
 *               resisting lift; everything left in the water drops out when it dries.
 *
 * Brush stamps are drawn in their own passes, scissored to each batch's bounding box.
 *
 * Rendering composites deposited + suspended pigment over the paper colour with Kubelka-Munk,
 * plus the darkening and sheen of standing water, into an sRGB texture, updated only over the
 * active rect. The screen pass then just samples it and multiplies in the paper's relief.
 */

const MAX_ST = 48; // 3 vec4 uniforms each: 144 of the 224 fragment vectors WebGL2 guarantees
const SUB_HZ = 180; // simulation substeps per second

const HDR = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
`;
const VS = HDR + `void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const COMMON = `
uniform sampler2D uPaper; uniform float uPaperN; uniform ivec2 uSize;
float hAt(vec2 p) { return texture(uPaper, (p + 0.5) / uPaperN).r; }
ivec2 cl(ivec2 q) { return clamp(q, ivec2(0), uSize - 1); }
float hash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
float noise1(float x) { float i = floor(x), f = fract(x); float a = hash(vec2(i, 7.1)), b = hash(vec2(i + 1.0, 7.1)); return mix(a, b, f * f * (3.0 - 2.0 * f)); }
const ivec2 DIR[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
`;

// brush footprint, used by the stamp passes (scissored to the batch's bounding box)
const STAMPS = `
uniform vec4 uSt[${MAX_ST}];   // x, y, radius, strength
uniform vec4 uSt2[${MAX_ST}];  // stroke dir x, y, dryness, seed
uniform vec4 uSt3[${MAX_ST}];  // footprint major axis x, y, elongation, water target
uniform int uN, uShape;        // 0 round, 1 flat wash, 2 dry, 3 splatter / hard drop
uniform vec4 uBox;             // bbox of this batch
float coverage(int i, vec2 p, float h) {
  vec4 s = uSt[i], s2 = uSt2[i], s3 = uSt3[i];
  vec2 d = p - s.xy;
  // ellipse: major axis s3.xy stretched by s3.z (pen tilt or a flat brush)
  vec2 ax = s3.xy, ay = vec2(-ax.y, ax.x);
  vec2 e = vec2(dot(d, ax) / s3.z, dot(d, ay));
  float r = s.z, dist = length(e) / r;
  if (dist > 1.3) return 0.0;
  float cov;
  if (uShape == 3) cov = 1.0 - smoothstep(0.85, 1.0, dist + (h - 0.5) * 0.25);
  else {
    // the paper's tooth and a little noise roughen the edge of the footprint
    float de = dist + (h - 0.5) * (0.12 + 0.4 * s2.z);
    cov = 1.0 - smoothstep(uShape == 1 ? 0.8 : 0.62, 1.0, de);
  }
  float dry = s2.z;
  if (dry > 0.0) {
    // dry brush: only the peaks of the paper take paint, in streaks along the stroke
    float perp = dot(d, vec2(-s2.y, s2.x)) / r;
    float streak = noise1(perp * 9.0 + s2.w * 3.1) * 0.55 + noise1(perp * 31.0 + 3.0) * 0.45;
    float thr = mix(0.2, 0.66, dry);
    cov *= smoothstep(thr - 0.05, thr + 0.05, h * 0.6 + streak * 0.4 + (streak - 0.5) * 0.4 * dry);
  }
  return cov * s.w;
}
`;

const FS_FLUX = HDR + COMMON + `
uniform sampler2D uW, uF; uniform vec2 uGrav; uniform float uPin, uHk, uC, uDamp, uCap; uniform ivec4 uRect;
out vec4 o;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  vec4 w0 = texelFetch(uW, P, 0); float w = w0.x;
  if (w < 1e-4) { o = vec4(0.0); return; }
  float H = w + uHk * hAt(vec2(P));
  vec4 fo = texelFetch(uF, P, 0) * uDamp;
  float f[4]; float sum = 0.0;
  for (int i = 0; i < 4; i++) {
    ivec2 q = P + DIR[i];
    // water never leaves the simulated rectangle (the rest of the sheet is not stepped)
    bool inside = q.x >= uRect.x && q.y >= uRect.y && q.x < uRect.z && q.y < uRect.w;
    vec4 wn = texelFetch(uW, cl(q), 0); float hn = hAt(vec2(q));
    float dh = H - (wn.x + uHk * hn) + dot(uGrav, vec2(DIR[i])) * w;
    float fl = max(0.0, fo[i] + uC * dh);
    // contact line pinning: dry neighbour floods only under deep water, valleys first;
    // a damp neighbour lets the water creep in (capillary spreading, backruns)
    float dryN = 1.0 - smoothstep(0.002, 0.02, wn.x);
    float damp = smoothstep(0.15, 0.7, wn.y / uCap);
    float th = uPin * (0.85 + 0.3 * hn);
    float allow = mix(1.0, max(smoothstep(th * 0.8, th * 1.6, w), damp * 0.35), dryN);
    f[i] = inside ? fl * allow : 0.0;
    sum += f[i];
  }
  float k = sum > w * 0.8 ? w * 0.8 / sum : 1.0;
  o = vec4(f[0], f[1], f[2], f[3]) * k;
}`;

const FS_WATER = HDR + COMMON + `
uniform sampler2D uW, uF, uFK, uFS;
uniform float uEvap, uEdge, uAbsorb, uCap, uCapDiff, uEvapS, uDiff, uDryAll;
layout(location = 0) out vec4 oW; layout(location = 1) out vec4 oK; layout(location = 2) out vec4 oS;
float wetAt(ivec2 q) { return step(0.003, texelFetch(uW, cl(q), 0).x); }
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy); vec2 p = vec2(P);
  vec4 w0 = texelFetch(uW, P, 0); float w = w0.x, s = w0.y;
  vec4 fk = texelFetch(uFK, P, 0), fs = texelFetch(uFS, P, 0);
  vec4 fo = texelFetch(uF, P, 0); float outF = fo.x + fo.y + fo.z + fo.w;
  float keep = w > 1e-6 ? 1.0 - outF / w : 1.0;
  float wn = w - outF;
  vec4 nk = fk * keep, ns = fs * keep;
  float wetHere = smoothstep(0.003, 0.03, w);
  float sn = 0.0;
  for (int i = 0; i < 4; i++) {
    ivec2 q = cl(P + DIR[i]);
    vec4 wq = texelFetch(uW, q, 0);
    float fin = texelFetch(uF, q, 0)[i ^ 1];
    vec4 qk = texelFetch(uFK, q, 0), qs = texelFetch(uFS, q, 0);
    float fr = wq.x > 1e-6 ? fin / wq.x : 0.0;
    wn += fin; nk += qk * fr; ns += qs * fr;
    // pigment diffuses within connected water
    float dw = uDiff * wetHere * smoothstep(0.003, 0.03, wq.x) * smoothstep(0.0, 0.15, min(w, wq.x));
    nk += (qk - fk) * dw; ns += (qs - fs) * dw;
    sn += wq.y;
  }
  float h = hAt(p);
  float cap = uCap * (0.85 + 0.3 * (1.0 - h));
  // capillary layer: soak up from the surface, spread within the paper
  float a = min(min(uAbsorb, wn), max(0.0, cap - s));
  wn -= a; s += a;
  s += uCapDiff * (sn * 0.25 - s) * step(0.002, max(s, sn));
  // evaporation, faster at the rim of a wet area (blurred wet mask, 8 taps)
  float m = 0.0;
  for (int i = 0; i < 8; i++) { float an = float(i) * 0.7853982; m += wetAt(P + ivec2(round(vec2(cos(an), sin(an)) * 7.0))); }
  float edge = (1.0 - m / 8.0) * wetHere;
  wn -= uEvap * (1.0 + uEdge * edge) + uDryAll * 0.05;
  s -= uEvapS * (wn > 0.01 ? 0.15 : 1.0) + uDryAll * 0.02;
  wn = max(wn, 0.0); s = max(s, 0.0);
  if (wn < 1e-4) wn = 0.0;
  oW = vec4(wn, s, 0.0, 1.0); oK = max(nk, 0.0); oS = max(ns, 0.0);
}`;

const FS_TRANSFER = HDR + COMMON + `
uniform sampler2D uW, uFK, uFS, uDK, uDS;
uniform float uDown, uUp; uniform int uForceDry;
layout(location = 0) out vec4 oFK; layout(location = 1) out vec4 oFS; layout(location = 2) out vec4 oDK; layout(location = 3) out vec4 oDS;
float mass(vec4 k, vec4 s) { return k.r + k.g + k.b + s.r + s.g + s.b; }
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy); vec2 p = vec2(P);
  float w = texelFetch(uW, P, 0).x;
  vec4 fk = texelFetch(uFK, P, 0), fs = texelFetch(uFS, P, 0), dk = texelFetch(uDK, P, 0), ds = texelFetch(uDS, P, 0);
  float h = hAt(p);
  float mf = mass(fk, fs), md = mass(dk, ds);
  float granF = mf > 1e-6 ? clamp(fk.a / mf, 0.0, 1.0) : 0.0;
  float granD = md > 1e-6 ? clamp(dk.a / md, 0.0, 1.0) : 0.0;
  float liftD = md > 1e-6 ? clamp(ds.a / md, 0.0, 1.0) : 0.0;
  // adsorption: granulating pigment settles in the valleys; more as the water thins
  float down = uDown * mix(1.0, 2.2 * (1.0 - h), granF * 0.6) * (1.0 + 5.0 * (1.0 - smoothstep(0.0, 0.3, w)));
  // desorption: liftable pigment comes back off the peaks of the paper
  float up = uUp * liftD * mix(1.0, 2.0 * h, granD * 0.6) * smoothstep(0.02, 0.25, w);
  if (w < 0.002 || uForceDry == 1) down = 1.0;
  down = clamp(down, 0.0, 1.0); up = clamp(up, 0.0, 1.0);
  vec4 nfk = fk * (1.0 - down) + dk * up, nfs = fs * (1.0 - down) + ds * up;
  vec4 ndk = dk * (1.0 - up) + fk * down, nds = ds * (1.0 - up) + fs * down;
  oFK = nfk; oFS = nfs; oDK = ndk; oDS = nds;
}`;


// brush stamps on the water layer: paint / clear water add water and pigment, lift and
// erase take them away. Drawn only over the batch's bounding box.
const FS_STAMP = HDR + COMMON + STAMPS + `
uniform sampler2D uW, uFK, uFS; uniform int uMode; uniform vec4 uBK, uBS; uniform float uMix;
layout(location = 0) out vec4 oW; layout(location = 1) out vec4 oK; layout(location = 2) out vec4 oS;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy); vec2 p = vec2(P);
  vec4 w0 = texelFetch(uW, P, 0); float wn = w0.x, s = w0.y;
  vec4 nk = texelFetch(uFK, P, 0), ns = texelFetch(uFS, P, 0);
  float h = hAt(p);
  for (int i = 0; i < ${MAX_ST}; i++) {
    if (i >= uN) break;
    float c = coverage(i, p, h);
    if (c <= 0.0) continue;
    if (uMode <= 1) {
      // the brush tops the water up to its own load; into wet paint it still lets a little
      // more go (that push is what makes a bloom), but never piles water up without bound
      float wt = uSt3[i].w;
      float add = wt > wn ? (wt - wn) * min(1.0, c * 0.7) : max(0.0, min(wt * c * 0.06, wt * 1.35 - wn));
      // pigment arrives with the water it is suspended in...
      nk += uBK * add; ns += uBS * add; wn += add;
      // ...and the hairs exchange paint with the wash they touch (mixing on the paper)
      float mx = c * (uMode == 1 ? 0.05 : uMix * 0.35);
      nk += (uBK * wn - nk) * mx; ns += (uBS * wn - ns) * mx;
    } else if (uMode == 2) {
      wn *= 1.0 - c * 0.35; s *= 1.0 - c * 0.15; nk *= 1.0 - c * 0.3; ns *= 1.0 - c * 0.3;
    } else if (uMode == 4) {
      // smudge: drag wet paint along the stroke (take what lies upstream of the brush)
      ivec2 q = cl(ivec2(p - uSt2[i].xy * uSt[i].z * 0.35));
      float m = c * 0.55;
      wn = mix(wn, texelFetch(uW, q, 0).x, m); nk = mix(nk, texelFetch(uFK, q, 0), m); ns = mix(ns, texelFetch(uFS, q, 0), m);
    } else {
      wn *= 1.0 - c * 0.5; s *= 1.0 - c * 0.3; nk *= 1.0 - c * 0.6; ns *= 1.0 - c * 0.6;
    }
  }
  oW = vec4(wn, s, 0.0, 1.0); oK = max(nk, 0.0); oS = max(ns, 0.0);
}`;

// lift / erase on the deposited layer
const FS_STAMP_D = HDR + COMMON + STAMPS + `
uniform sampler2D uW, uDK, uDS; uniform int uMode;
layout(location = 0) out vec4 oDK; layout(location = 1) out vec4 oDS;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy); vec2 p = vec2(P);
  float w = texelFetch(uW, P, 0).x;
  vec4 dk = texelFetch(uDK, P, 0), ds = texelFetch(uDS, P, 0);
  float md = dk.r + dk.g + dk.b + ds.r + ds.g + ds.b;
  float liftD = md > 1e-6 ? clamp(ds.a / md, 0.0, 1.0) : 0.0;
  float h = hAt(p);
  for (int i = 0; i < ${MAX_ST}; i++) {
    if (i >= uN) break;
    float c = coverage(i, p, h);
    if (c <= 0.0) continue;
    // lift: a damp brush / tissue takes liftable pigment, more when the paper is wet
    if (uMode == 4) {
      // smudge dried paint too, more gently, more easily for liftable pigment
      ivec2 q = cl(ivec2(p - uSt2[i].xy * uSt[i].z * 0.35));
      float m = c * (0.12 + 0.3 * liftD + 0.3 * smoothstep(0.0, 0.3, w));
      dk = mix(dk, texelFetch(uDK, q, 0), m); ds = mix(ds, texelFetch(uDS, q, 0), m);
      continue;
    }
    float k = uMode == 2 ? c * 0.05 * (0.25 + liftD * 1.5) * (0.5 + 2.0 * smoothstep(0.0, 0.3, w)) : c * 0.35;
    dk *= 1.0 - k; ds *= 1.0 - k;
  }
  oDK = dk; oDS = ds;
}`;

const KM_GLSL = `
vec3 kmOver(vec3 K, vec3 S, vec3 r0) {
  if (K.r + K.g + K.b + S.r + S.g + S.b < 1e-5) return r0;
  S = max(S, vec3(1e-4));
  vec3 a = 1.0 + K / S, b = sqrt(max(a * a - 1.0, vec3(1e-8))), x = min(b * S, vec3(20.0));
  vec3 e = exp(x), ei = 1.0 / e, sh = 0.5 * (e - ei), ch = 0.5 * (e + ei);
  vec3 c = a * sh + b * ch, R = sh / c, T = b / c;
  return R + T * T * r0 / (1.0 - R * r0);
}
vec3 toSrgb(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
`;

// composite, in sheet space: KM of all pigment over the (unlit) paper colour, plus the look of
// standing water. Written to an sRGB texture and only updated where the sheet is wet, so the
// per-frame screen pass is a couple of texture reads however big the painting is.
const FS_COMP = HDR + `
uniform sampler2D uW, uFK, uFS, uDK, uDS, uBase; uniform vec3 uPaperCol; uniform float uWetShow, uOpacity; uniform vec2 uSheet;
uniform int uHasBase, uActive;
out vec4 o;
` + KM_GLSL + `
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy);
  // what lies under this layer: the paper, or the layers below composited already
  vec3 base = uHasBase == 1 ? texelFetch(uBase, P, 0).rgb : uPaperCol;
  vec3 K = texelFetch(uDK, P, 0).rgb, S = texelFetch(uDS, P, 0).rgb;
  if (uActive == 1) { K += texelFetch(uFK, P, 0).rgb; S += texelFetch(uFS, P, 0).rgb; }
  vec3 R = mix(base, kmOver(K, S, base), uOpacity);
  if (uActive == 1) {
    vec4 w = texelFetch(uW, P, 0);
    // wet paint is darker and more saturated; standing water catches the light
    float wet = smoothstep(0.004, 0.25, w.x) * uWetShow, damp = smoothstep(0.02, 0.4, w.y) * uWetShow;
    if (wet + damp > 0.0) {
      R *= mix(1.0, 0.93, damp * 0.6);
      R = mix(R, R * R / max(dot(R, vec3(0.333)), 1e-3) * 0.95, wet * 0.18);
      R *= mix(1.0, 0.92, wet);
      ivec2 sz = ivec2(uSheet) - 1;
      float gx = texelFetch(uW, min(P + ivec2(2, 0), sz), 0).x - texelFetch(uW, max(P - ivec2(2, 0), ivec2(0)), 0).x;
      float gy = texelFetch(uW, min(P + ivec2(0, 2), sz), 0).x - texelFetch(uW, max(P - ivec2(0, 2), ivec2(0)), 0).x;
      vec3 L = normalize(vec3(-0.55, -0.65, 0.75));
      vec3 nw = normalize(vec3(-gx * 4.5, -gy * 4.5, 1.0));
      float spec = pow(max(dot(reflect(-L, nw), vec3(0.0, 0.0, 1.0)), 0.0), 28.0);
      R += vec3(0.95, 0.97, 1.0) * spec * wet * 0.22;
    }
  }
  o = vec4(clamp(R, 0.0, 1.0), 1.0);
}`;

// one layer over white, sampled down to a thumbnail
const FS_THUMB = HDR + `
uniform sampler2D uDK, uDS, uFK, uFS; uniform int uActive; uniform vec2 uOut;
out vec4 o;
` + KM_GLSL + `
void main() {
  vec2 uv = gl_FragCoord.xy / uOut;
  vec3 K = texture(uDK, uv).rgb, S = texture(uDS, uv).rgb;
  if (uActive == 1) { K += texture(uFK, uv).rgb; S += texture(uFS, uv).rgb; }
  o = vec4(toSrgb(kmOver(K, S, vec3(1.0))), 1.0);
}`;

// screen: sheet -> screen transform, paper relief (precomputed light tile), desk and shadow
const FS_SCREEN = HDR + `
uniform sampler2D uComp, uLit; uniform float uPaperN, uLitAmt;
uniform mat3 uInv; uniform vec2 uSheet, uCanvas; uniform float uDpr, uZoom;
uniform vec3 uDesk; uniform int uExport; uniform float uExpScale;
uniform int uPat; uniform float uPatSp; uniform vec3 uPatCol, uPatMargin;
uniform int uInf; uniform vec2 uOrigin; uniform vec3 uPaperLin;
out vec4 o;
// coverage of a line at distance d (sheet px): at least ~0.9 sheet px wide, and never thinner
// than a screen pixel when zoomed out, so ruling stays visible and exports the same
float rule(float d, float fw) { float hw = max(0.9, 0.6 * fw); return 1.0 - smoothstep(hw - 0.5 * fw, hw + 0.5 * fw, d); }
vec3 toSrgb(vec3 c) { c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec2 p = uExport == 1 ? gl_FragCoord.xy * uExpScale : (uInv * vec3(vec2(gl_FragCoord.x, uCanvas.y - gl_FragCoord.y) / uDpr, 1.0)).xy;
  bool outside = p.x < 0.0 || p.y < 0.0 || p.x > uSheet.x || p.y > uSheet.y;
  if (outside && uInf == 0) {
    // soft drop shadow of the sheet on the desk
    vec2 q = p - vec2(3.0, 5.0) / uZoom * uDpr;
    vec2 dd = max(max(-q, q - uSheet), 0.0) * uZoom / uDpr;
    o = vec4(toSrgb(uDesk * (1.0 - 0.45 * exp(-length(dd) / 7.0))), 1.0); return;
  }
  vec2 uv = p / uSheet;
  vec3 R;
  // an infinite page has no edge: beyond the loaded window it is bare paper (briefly, while panning)
  if (outside) R = uPaperLin;
  else if (uZoom >= 1.0 || uExport == 1 && uExpScale <= 1.0) R = texture(uComp, uv).rgb;
  else {
    // zoomed out, one screen pixel covers several sheet pixels: average 4 taps
    vec2 d = 0.5 / (uZoom * uSheet);
    R = 0.25 * (texture(uComp, uv + vec2(-d.x, -d.y)).rgb + texture(uComp, uv + vec2(d.x, -d.y)).rgb + texture(uComp, uv + vec2(-d.x, d.y)).rgb + texture(uComp, uv + d).rgb);
  }
  if (uLitAmt > 0.0) R *= mix(1.0, texture(uLit, (p + 0.5) / uPaperN).r * 1.25, uLitAmt);
  if (uPat > 0) {
    // ruling multiplies like a printed line: ink and paint on top stay dark
    vec2 wp = p + uOrigin; // world position: ruling continues across an infinite page
    vec2 fw = max(fwidth(p), vec2(1e-3)), g = wp - floor(wp / uPatSp + 0.5) * uPatSp;
    float a = 0.0, m = 0.0;
    if (uPat == 1) { a = uInf == 1 || wp.y > uPatSp * 2.5 ? rule(abs(g.y), fw.y) : 0.0; m = uInf == 1 ? 0.0 : rule(abs(wp.x - uPatSp * 2.0), fw.x); }
    else if (uPat == 2) a = max(rule(abs(g.x), fw.x), rule(abs(g.y), fw.y)) * 0.75;
    else { float r = max(1.7, 0.9 * fw.x); a = 1.0 - smoothstep(r - 0.5 * fw.x, r + 0.5 * fw.x, length(g)); }
    R = mix(R, R * uPatCol, a); R = mix(R, R * uPatMargin, m * 0.8);
  }
  o = vec4(toSrgb(R), 1.0);
}`;

// probe: one texel per block of the active rect, 1 where anything is still wet
const FS_PROBE = HDR + `
uniform sampler2D uW, uFK; uniform vec4 uRect; uniform ivec2 uSize; uniform vec2 uCells;
out vec4 o;
void main() {
  vec2 c = floor(gl_FragCoord.xy);
  vec2 b0 = uRect.xy + c * (uRect.zw / uCells), bs = uRect.zw / uCells;
  float wet = 0.0;
  for (int j = 0; j < 6; j++) for (int i = 0; i < 6; i++) {
    ivec2 q = clamp(ivec2(b0 + (vec2(i, j) + 0.5) / 6.0 * bs), ivec2(0), uSize - 1);
    vec4 w = texelFetch(uW, q, 0); vec4 k = texelFetch(uFK, q, 0);
    wet = max(wet, step(0.0008, w.x) + step(0.004, w.y) + step(1e-4, k.r + k.g + k.b));
  }
  o = vec4(min(wet, 1.0), 0.0, 0.0, 1.0);
}`;

// sum deposited and suspended pigment: "dried" state for saving
const FS_DRIED = HDR + `
uniform sampler2D uFK, uFS, uDK, uDS; uniform int uActive;
layout(location = 0) out vec4 oK; layout(location = 1) out vec4 oS;
void main() { ivec2 P = ivec2(gl_FragCoord.xy); float a = float(uActive); oK = texelFetch(uDK, P, 0) + a * texelFetch(uFK, P, 0); oS = texelFetch(uDS, P, 0) + a * texelFetch(uFS, P, 0); }`;

// Pen mode: ink goes straight into the paper (no water), with a clean anti-aliased edge.
// Mode 5 inks: within a stroke stamps converge on the ink amount instead of piling up, so a
// line stays even; uCover = how much ink replaces what is under it (0 = transparent glaze,
// as a highlighter). Mode 6 erases deposited pigment outright.
//
// Mode 7 is pastel: a dry, chalky, opaque stick. The paper's tooth decides where it
// catches: a light touch marks only the peaks of the grain, pressing harder fills the
// valleys (s.w carries the pressure). It covers what is under it and builds up with
// passes; uTooth is how soft the threshold is (soft pastel crumbles more than a pencil).
const FS_INK = HDR + COMMON + `
uniform sampler2D uDK, uDS;
uniform vec4 uSt[${MAX_ST}], uSt2[${MAX_ST}], uSt3[${MAX_ST}];
uniform int uN, uMode; uniform vec4 uBK, uBS; uniform float uCover, uTooth;
layout(location = 0) out vec4 oDK; layout(location = 1) out vec4 oDS;
void main() {
  ivec2 P = ivec2(gl_FragCoord.xy); vec2 p = vec2(P);
  vec4 dk = texelFetch(uDK, P, 0), ds = texelFetch(uDS, P, 0);
  for (int i = 0; i < ${MAX_ST}; i++) {
    if (i >= uN) break;
    vec4 s = uSt[i], s3 = uSt3[i];
    vec2 d = p - s.xy, ax = s3.xy;
    vec2 e = vec2(dot(d, ax) / s3.z, dot(d, vec2(-ax.y, ax.x)));
    if (uMode == 7) {
      float c = 1.0 - smoothstep(0.5, 1.0, length(e) / s.z);
      if (c <= 0.0) continue;
      float g = hAt(p) + (hash(p * 0.731 + s3.w) - 0.5) * 0.22 * uTooth * 5.0;
      float thr = mix(0.9, 0.08, clamp(s.w, 0.0, 1.0));
      c *= smoothstep(thr - uTooth, thr + uTooth, g);
      dk = mix(dk, uBK, c * uCover); ds = mix(ds, uBS, c * uCover);
      continue;
    }
    float c = clamp(s.z - length(e) + 0.5, 0.0, 1.0) * s.w;
    if (c <= 0.0) continue;
    if (uMode == 6) { dk *= 1.0 - c; ds *= 1.0 - c; continue; }
    dk = max(mix(dk, uBK, c * uCover), uBK * c);
    ds = max(mix(ds, uBS, c * uCover), uBS * c);
  }
  oDK = dk; oDS = ds;
}`;

// a photo turned into pigment: each pixel becomes a unit layer of a transparent paint whose
// masstone over white is that pixel (the Kubelka-Munk inversion km.js uses for pigments)
const FS_IMPORT = HDR + `
uniform sampler2D uImg; uniform vec2 uOut;
layout(location = 0) out vec4 oK; layout(location = 1) out vec4 oS;
float acoth(float x) { return 0.5 * log((x + 1.0) / (x - 1.0)); }
void main() {
  vec3 c = texture(uImg, gl_FragCoord.xy / uOut).rgb;
  vec3 rw = clamp(mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)), 0.002, 0.995);
  vec3 rb = rw * 0.05, K, S;
  for (int i = 0; i < 3; i++) {
    float w = rw[i], b0 = rb[i], a = 0.5 * (w + (b0 - w + 1.0) / b0), b = sqrt(a * a - 1.0);
    S[i] = acoth((b * b - (a - w) * (a - 1.0)) / (b * (1.0 - w))) / b; K[i] = S[i] * (a - 1.0);
  }
  float m = K.r + K.g + K.b + S.r + S.g + S.b;
  oK = vec4(K, m * 0.15); oS = vec4(S, m * 0.6);
}`;

// merge a layer into the one below (pigment amounts add, scaled by the upper layer's opacity)
const FS_MERGE = HDR + `
uniform sampler2D uAK, uAS, uBK, uBS; uniform float uOpacity;
layout(location = 0) out vec4 oK; layout(location = 1) out vec4 oS;
void main() { ivec2 P = ivec2(gl_FragCoord.xy); oK = texelFetch(uBK, P, 0) + uOpacity * texelFetch(uAK, P, 0); oS = texelFetch(uBS, P, 0) + uOpacity * texelFetch(uAS, P, 0); }`;

function compile(gl, fs) {
  const mk = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => i + 1 + ': ' + l).join('\n').slice(0, 4000));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(p));
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); const name = info.name.replace(/\[0\]$/, ''); u[name] = gl.getUniformLocation(p, info.name); }
  return { p, u };
}

/** float -> IEEE half, for saving */
const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
export function toHalf(v) {
  f32[0] = v; const x = u32[0], s = (x >>> 16) & 0x8000; let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
  if (e <= 0) return s; if (e >= 31) return s | 0x7bff;
  return s | (e << 10) | ((m + 0x1000) >>> 13 > 0x3ff ? 0x3ff : (m + 0x1000) >>> 13);
}
export function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  return e === 0 ? s * m * 2 ** -24 : s * (1 + m / 1024) * 2 ** (e - 15);
}

export const TILE = 128;

export class Sim {
  /** opts.infinite: this sheet is a window onto an infinite page (smaller undo history, shift()). */
  constructor(gl, W, H, paper, opts = {}) {
    this.gl = gl; this.W = W; this.H = H;
    this.infinite = !!opts.infinite; this.origin = [0, 0]; this.dirty = new Map();
    this.floatRead = !!gl.getExtension('EXT_color_buffer_float');
    if (!this.floatRead && !gl.getExtension('EXT_color_buffer_half_float')) throw new Error('This device cannot render to floating-point textures (EXT_color_buffer_float).');
    this.vao = gl.createVertexArray();
    this.prog = { flux: compile(gl, FS_FLUX), water: compile(gl, FS_WATER), transfer: compile(gl, FS_TRANSFER), stamp: compile(gl, FS_STAMP), stampD: compile(gl, FS_STAMP_D), comp: compile(gl, FS_COMP), screen: compile(gl, FS_SCREEN), probe: compile(gl, FS_PROBE), dried: compile(gl, FS_DRIED), thumb: compile(gl, FS_THUMB), merge: compile(gl, FS_MERGE), import: compile(gl, FS_IMPORT), ink: compile(gl, FS_INK) };
    this.pattern = { type: 0, sp: 56, col: [0.4, 0.5, 0.75], margin: [0.92, 0.5, 0.5] };
    // two sRGB colour buffers: layers composite into them alternately, the top one lands in comp
    this.comp = this.tex(W, H, 'SRGB8_ALPHA8'); this.comp2 = this.tex(W, H, 'SRGB8_ALPHA8');
    this.paperCol = [1, 1, 1]; this.litAmt = 0;
    this.fbos = new Map();
    // water and suspended pigment are shared: only the active layer is ever wet. Each layer
    // owns its deposited pigment (DK, DS); s.DK / s.DS point at the active layer's.
    this.s = { W: this.pp(), FK: this.pp(), FS: this.pp() };
    this.layers = []; this.layer = null;
    this.F = this.tex();
    this.setPaper(paper);
    this.params = { evap: 0.045, edge: 2.5, absorb: 0.00012, cap: 0.22, capDiff: 0.1, evapS: 0.022, diff: 0.16, pin: 0.5, hk: 0.006, c: 0.2, damp: 0.94, down: 0.0006, up: 0.0005, grav: [0, 0] };
    this.speed = 1; this.dryBoost = 0; this.maxSub = 6;
    this.active = null; // [x0, y0, x1, y1] sheet px, where both ping-pong buffers may differ
    this.queue = [];
    this.undo = []; this.redo = []; this.rec = null;
    this.initUndo();
    this.probeTex = null; this.probePending = null; this.lastProbe = 0;
    this.stepsDone = 0; this.wetTime = 0;
    for (const k in this.s) for (const t of this.s[k].t) this.clearTex(t);
    this.clearTex(this.F);
    this.setLayer(this.addLayer());
    this.compose();
  }

  pp() { return { t: [this.tex(), this.tex()], i: 0, get cur() { return this.t[this.i]; }, get nxt() { return this.t[1 - this.i]; }, flip() { this.i = 1 - this.i; } }; }

  // ---- layers ----
  /** Create an empty layer at `index` (default: above the active one). Not undoable by itself. */
  // A layer owns one K and one S texture. The active layer borrows two shared scratch
  // textures as its ping-pong partners (s.DK, s.DS); when it stops being active its latest
  // state is copied home, so a layer costs 2 textures instead of 4.
  addLayer(index, name) {
    this.nLayers = (this.nLayers || 0) + 1;
    const L = { id: ++Sim.lid, uid: Math.random().toString(36).slice(2, 10), name: name || 'Layer ' + this.nLayers, K: this.tex(), S: this.tex(), visible: true, opacity: 1 };
    this.clearTex(L.K); this.clearTex(L.S);
    const i = index ?? (this.layer ? this.layers.indexOf(this.layer) + 1 : this.layers.length);
    this.layers.splice(i, 0, L);
    return L;
  }
  /** Make L the layer brushes paint on (wet paint on the previous one dries first). */
  setLayer(L) {
    if (!L || L === this.layer) return;
    this.dryNow();
    this.parkLayer();
    this.scratch ??= { K: this.tex(), S: this.tex() };
    this.blitFull(L.K, this.scratch.K); this.blitFull(L.S, this.scratch.S);
    const pp = (own, scr) => ({ t: [own, scr], i: 0, get cur() { return this.t[this.i]; }, get nxt() { return this.t[1 - this.i]; }, flip() { this.i = 1 - this.i; } });
    this.layer = L; this.s.DK = pp(L.K, this.scratch.K); this.s.DS = pp(L.S, this.scratch.S);
    this.compose();
  }
  /** Copy the active layer's latest state into its own textures. */
  parkLayer() {
    const L = this.layer; if (!L) return;
    for (const pp of [this.s.DK, this.s.DS]) if (pp.i === 1) { this.blitFull(pp.t[1], pp.t[0]); pp.i = 0; }
  }
  kOf(L) { return L === this.layer ? this.s.DK.cur : L.K; }
  sOf(L) { return L === this.layer ? this.s.DS.cur : L.S; }
  freeLayer(L) { this.dropTex(L.K); this.dropTex(L.S); }
  /** Most layers a sheet this size gets (about 256 MB of layer textures). */
  get maxLayers() { return Math.max(2, Math.min(16, Math.floor(256e6 / (this.W * this.H * 16)))); }
  /** Undoable layer operations, recorded as op entries in the same history as strokes. */
  opRecord(op) {
    this.dryNow();
    for (const r of this.redo) this.freeRecord(r, true);
    this.redo = []; this.rec = null;
    this.undo.push({ op, tiles: [] });
    this.trimOps();
  }
  trimOps() { while (this.undo.length > 120) this.freeRecord(this.undo.shift(), false); }
  newLayerOp() {
    const L = this.addLayer(); const i = this.layers.indexOf(L), prev = this.layer;
    this.setLayer(L);
    this.opRecord({
      undo: () => { this.layers.splice(this.layers.indexOf(L), 1); this.setLayer(prev && this.layers.includes(prev) ? prev : this.layers[0]); this.compose(); },
      redo: () => { this.layers.splice(i, 0, L); this.setLayer(L); this.compose(); },
      free: (inRedo) => { if (inRedo) this.freeLayer(L); },
    });
    return L;
  }
  deleteLayerOp(L) {
    if (this.layers.length < 2) return false;
    this.dryNow();
    const i = this.layers.indexOf(L);
    const del = () => { this.layers.splice(this.layers.indexOf(L), 1); if (this.layer === L) this.setLayer(this.layers[Math.max(0, i - 1)]); this.compose(); };
    del();
    this.opRecord({ undo: () => { this.layers.splice(i, 0, L); this.setLayer(L); this.compose(); }, redo: del, free: (inRedo) => { if (!inRedo) this.freeLayer(L); } });
    return true;
  }
  moveLayerOp(L, to) {
    const from = this.layers.indexOf(L); to = Math.max(0, Math.min(this.layers.length - 1, to));
    if (from === to) return;
    const mv = (a, b) => { this.layers.splice(a, 1); this.layers.splice(b, 0, L); this.compose(); };
    this.dryNow(); mv(from, to);
    this.opRecord({ undo: () => mv(to, from), redo: () => mv(from, to), free: () => {} });
  }
  /** Merge L into the layer below it. */
  mergeDownOp(L) {
    const i = this.layers.indexOf(L); if (i <= 0) return false;
    const B = this.layers[i - 1];
    this.setLayer(B);
    const backup = { K: this.tex(), S: this.tex() };
    this.blitFull(this.kOf(B), backup.K); this.blitFull(this.sOf(B), backup.S);
    const merge = () => {
      this.setLayer(B);
      this.use('merge'); this.bind('uAK', L.K); this.bind('uAS', L.S); this.bind('uBK', this.s.DK.cur); this.bind('uBS', this.s.DS.cur); this.f1('uOpacity', L.visible ? L.opacity : 0);
      this.draw([this.s.DK.nxt, this.s.DS.nxt], [0, 0, this.W, this.H]); this.s.DK.flip(); this.s.DS.flip();
      this.blitFull(this.s.DK.cur, this.s.DK.nxt); this.blitFull(this.s.DS.cur, this.s.DS.nxt);
      this.layers.splice(this.layers.indexOf(L), 1); this.compose();
    };
    merge();
    this.opRecord({
      undo: () => { this.setLayer(B); for (const [src, pp] of [[backup.K, this.s.DK], [backup.S, this.s.DS]]) for (const t of pp.t) this.blitFull(src, t); this.layers.splice(this.layers.indexOf(B) + 1, 0, L); this.setLayer(L); },
      redo: merge,
      free: (inRedo) => { this.dropTex(backup.K); this.dropTex(backup.S); if (!inRedo) this.freeLayer(L); },
    });
    return true;
  }
  /**
   * Pen mode: put ink stamps straight into the active layer, no water and no simulation
   * steps, recomposited only under the stroke. b: {mode 5 ink | 6 erase, bK, bS, cover}.
   */
  ink(stamps, b) {
    for (let i = 0; i < stamps.length; i += MAX_ST) {
      const batch = { st: stamps.slice(i, i + MAX_ST), b: { ...b, shape: 0 } };
      this.use('ink'); this.bind('uDK', this.s.DK.cur); this.bind('uDS', this.s.DS.cur);
      const r = this.setStampUniforms(batch); this.f1('uCover', b.cover ?? 1); this.f1('uTooth', b.tooth ?? 0.1);
      if (r[2] <= r[0] || r[3] <= r[1]) continue;
      const t = [r[0] - 2, r[1] - 2, r[2] + 2, r[3] + 2];
      this.saveTiles(t); this.markDirty(t);
      this.use('ink'); this.bind('uDK', this.s.DK.cur); this.bind('uDS', this.s.DS.cur); this.setStampUniforms(batch); this.f1('uCover', b.cover ?? 1); this.f1('uTooth', b.tooth ?? 0.1);
      this.draw([this.s.DK.nxt, this.s.DS.nxt], r); this.keep(['DK', 'DS'], r);
      this.compose(this.clampRect(t));
    }
  }
  // ---- infinite pages: tiles and the moving window ----
  /** Note that a rect of layer L changed (tile coords in TILE units), for saving its tiles. */
  markDirty(r, L = this.layer) {
    if (!this.infinite || !r || !L) return;
    let set = this.dirty.get(L); if (!set) this.dirty.set(L, (set = new Set()));
    const x0 = Math.max(0, Math.floor(r[0] / TILE)), y0 = Math.max(0, Math.floor(r[1] / TILE)), x1 = Math.min(this.W / TILE, Math.ceil(r[2] / TILE)), y1 = Math.min(this.H / TILE, Math.ceil(r[3] / TILE));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set.add(x + ',' + y);
  }
  /** Read a rect of layer L's dried pigment as half floats, row by row from y0. */
  readRegion(L, x0, y0, w, h) {
    const gl = this.gl, n = w * h * 4, out = { K: new Uint16Array(n), S: new Uint16Array(n) };
    for (const [t, key] of [[this.kOf(L), 'K'], [this.sOf(L), 'S']]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo([t]));
      if (this.floatRead) {
        const f = new Float32Array(n); gl.readPixels(x0, y0, w, h, gl.RGBA, gl.FLOAT, f);
        if (typeof Float16Array !== 'undefined') out[key] = new Uint16Array(new Float16Array(f).buffer);
        else { const hh = out[key]; for (let i = 0; i < n; i++) hh[i] = f[i] === 0 ? 0 : toHalf(f[i]); }
      } else gl.readPixels(x0, y0, w, h, gl.RGBA, gl.HALF_FLOAT, out[key]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }
  /** Tiles of layer L as {tx, ty, K, S, empty}, read in one go per bounding box. */
  readTiles(L, tiles) {
    if (!tiles.length) return [];
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (const [tx, ty] of tiles) { x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty); }
    const w = (x1 - x0 + 1) * TILE, h = (y1 - y0 + 1) * TILE, R = this.readRegion(L, x0 * TILE, y0 * TILE, w, h), out = [];
    for (const [tx, ty] of tiles) {
      const K = new Uint16Array(TILE * TILE * 4), S = new Uint16Array(TILE * TILE * 4), ox = (tx - x0) * TILE, oy = (ty - y0) * TILE;
      let any = 0;
      for (let j = 0; j < TILE; j++) {
        const src = ((oy + j) * w + ox) * 4, dst = j * TILE * 4;
        K.set(R.K.subarray(src, src + TILE * 4), dst); S.set(R.S.subarray(src, src + TILE * 4), dst);
      }
      // half floats: 0 and -0 are the only all-zero-exponent-and-mantissa patterns that matter here
      for (let i = 0; i < K.length && !any; i++) any = (K[i] & 0x7fff) | (S[i] & 0x7fff);
      out.push({ tx, ty, K, S, empty: !any });
    }
    return out;
  }
  /** Put a tile's half-float data into layer L (both textures of the active layer's pair). */
  writeTile(L, tx, ty, K, S) {
    const gl = this.gl, ts = L === this.layer ? [[this.s.DK.t[0], K], [this.s.DK.t[1], K], [this.s.DS.t[0], S], [this.s.DS.t[1], S]] : [[L.K, K], [L.S, S]];
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    for (const [t, d] of ts) { gl.bindTexture(gl.TEXTURE_2D, t); gl.texSubImage2D(gl.TEXTURE_2D, 0, tx * TILE, ty * TILE, TILE, TILE, gl.RGBA, gl.HALF_FLOAT, d); }
  }
  /** Read and forget the changed tiles: [{L, tx, ty, K, S, empty}] (for saving). */
  takeDirty(filter) {
    const out = [];
    for (const [L, set] of this.dirty) {
      if (!this.layers.includes(L)) { this.dirty.delete(L); continue; }
      const tiles = [...set].map((k) => k.split(',').map(Number)).filter(([x, y]) => !filter || filter(x, y));
      for (const t of this.readTiles(L, tiles)) { out.push({ L, ...t }); set.delete(t.tx + ',' + t.ty); }
    }
    return out;
  }
  /**
   * Move the window over the infinite page by (dx, dy) sheet px (multiples of TILE): content
   * moves by -d. Changed tiles that leave are read back and handed to leave({L, tx, ty, K, S,
   * empty}) in old window coordinates; tiles that arrive are filled from arrive(L, tx, ty)
   * (new window coordinates; null = empty). Water, the wet state and the undo history move too;
   * history that falls outside the window can no longer be undone.
   */
  shift(dx, dy, leave, arrive) {
    const gl = this.gl, W = this.W, H = this.H, sx = dx / TILE, sy = dy / TILE, tw = W / TILE, th = H / TILE;
    if (!dx && !dy) return;
    const inside = (x, y) => x >= 0 && y >= 0 && x < tw && y < th;
    // 1. changed tiles that leave
    for (const t of this.takeDirty((x, y) => !inside(x - sx, y - sy))) leave(t);
    // 2. every spatial texture moves
    this.shiftTmp ??= this.tex();
    const texs = [...this.s.W.t, ...this.s.FK.t, ...this.s.FS.t];
    for (const L of this.layers) texs.push(...(L === this.layer ? [...this.s.DK.t, ...this.s.DS.t] : [L.K, L.S]));
    const srcX0 = Math.max(0, dx), srcY0 = Math.max(0, dy), srcX1 = Math.min(W, W + dx), srcY1 = Math.min(H, H + dy);
    for (const t of texs) {
      this.clearTex(this.shiftTmp);
      if (srcX1 > srcX0 && srcY1 > srcY0) {
        this.bindBlit(t, this.shiftTmp);
        gl.blitFramebuffer(srcX0, srcY0, srcX1, srcY1, srcX0 - dx, srcY0 - dy, srcX1 - dx, srcY1 - dy, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      this.blitFull(this.shiftTmp, t);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    // 3. tiles that arrive
    for (const L of this.layers) for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      if (inside(x + sx, y + sy)) continue;
      const d = arrive(L, x, y); if (d) this.writeTile(L, x, y, d.K, d.S);
    }
    // 4. bookkeeping: dirty tiles, undo history, wet rect
    for (const [L, set] of this.dirty) {
      const n = new Set(); for (const k of set) { const [x, y] = k.split(',').map(Number); if (inside(x - sx, y - sy)) n.add(x - sx + ',' + (y - sy)); }
      this.dirty.set(L, n);
    }
    for (const r of [...this.undo, ...this.redo]) {
      if (r.op || !r.tiles.length) continue;
      const tiles = [], keys = new Set();
      for (const t of r.tiles) {
        const x = t.tx - sx, y = t.ty - sy;
        if (inside(x, y)) { tiles.push({ ...t, tx: x, ty: y }); keys.add(y * 10000 + x); } else { this.atlas.free.push(t.slot); r.broken = true; }
      }
      r.tiles = tiles; r.keys = keys;
    }
    // a step that cannot be undone ends the history there: drop it and everything older
    const bi = this.undo.map((r) => !!r.broken).lastIndexOf(true);
    if (bi >= 0) for (const r of this.undo.splice(0, bi + 1)) this.freeRecord(r, false);
    if (this.redo.some((r) => r.broken)) { for (const r of this.redo) this.freeRecord(r, true); this.redo = []; }
    if (this.active) { const a = this.active.map((v, i) => v - (i % 2 ? dy : dx)); this.active = a[2] > 0 && a[3] > 0 && a[0] < W && a[1] < H ? this.clampRect(a) : null; }
    this.queue.length = 0; // (a pending wet-map probe is discarded: its rect is not the active one any more)
    this.clearTex(this.F); if (this.Fn) this.clearTex(this.Fn);
    this.compose();
  }

  /** Ruled note paper drawn under the paint: 0 none, 1 lined, 2 grid, 3 dots. Spacing in sheet px. */
  setPattern(type, sp, col) { this.pattern = { ...this.pattern, type, sp: sp ?? this.pattern.sp, col: col ?? this.pattern.col }; }

  /** Replace the active layer with an image (ImageBitmap / canvas) turned into pigment. */
  importImage(img) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const u = this.use('import'); this.bind('uImg', t); gl.uniform2f(u.uOut, this.W, this.H);
    this.draw([this.s.DK.nxt, this.s.DS.nxt], [0, 0, this.W, this.H]); this.s.DK.flip(); this.s.DS.flip();
    this.blitFull(this.s.DK.cur, this.s.DK.nxt); this.blitFull(this.s.DS.cur, this.s.DS.nxt);
    gl.deleteTexture(t);
    this.markDirty([0, 0, this.W, this.H]);
    this.compose();
  }
  setLayerProps(L, props) { Object.assign(L, props); this.compose(); }
  blitFull(from, to) {
    const gl = this.gl;
    this.bindBlit(from, to);
    gl.blitFramebuffer(0, 0, this.W, this.H, 0, 0, this.W, this.H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }
  /** Small RGBA8 picture of one layer over white (top row first). */
  layerThumb(L, w, h) {
    const gl = this.gl, t = this.tex(w, h, 'RGBA8');
    const u = this.use('thumb');
    this.bind('uDK', this.kOf(L)); this.bind('uDS', this.sOf(L)); this.bind('uFK', this.s.FK.cur); this.bind('uFS', this.s.FS.cur);
    this.i1('uActive', L === this.layer ? 1 : 0); gl.uniform2f(u.uOut, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo([t])); gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(w * h * 4); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); this.dropTex(t);
    return px;
  }

  tex(w = this.W, h = this.H, fmt = 'RGBA16F') {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl[fmt], w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Bind read / draw framebuffers for a blit. Both are created first: creating one binds it
   *  to FRAMEBUFFER (read and draw), which would silently replace the read side. */
  bindBlit(from, to) {
    const gl = this.gl, r = this.fbo([from]), d = this.fbo([to]);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, r); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, d);
  }

  fbo(texs) {
    const key = texs.map((t) => (t.__id ??= ++Sim.ids)).join(',');
    let f = this.fbos.get(key);
    if (!f) {
      const gl = this.gl; f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      texs.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
      gl.drawBuffers(texs.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete ' + st);
      this.fbos.set(key, f);
    }
    return f;
  }

  clearTex(t, rect) {
    const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo([t]));
    if (rect) { gl.enable(gl.SCISSOR_TEST); gl.scissor(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]); }
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.disable(gl.SCISSOR_TEST);
  }

  setPaper(paper) {
    const gl = this.gl;
    if (this.paperTex) gl.deleteTexture(this.paperTex);
    const t = gl.createTexture(), N = paper.N, d = new Uint8Array(N * N);
    for (let i = 0; i < d.length; i++) d[i] = Math.round(paper.h[i] * 255);
    gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, d);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    this.paperTex = t; this.paperN = N; this.paper = paper;
    this.buildLit();
  }

  // ---- program helpers ----
  use(name) {
    const gl = this.gl, P = this.prog[name]; gl.useProgram(P.p); this.cur = P; this.unit = 0;
    if (P.u.uPaper) { this.bind('uPaper', this.paperTex); gl.uniform1f(P.u.uPaperN, this.paperN); }
    if (P.u.uSize) gl.uniform2i(P.u.uSize, this.W, this.H);
    return P.u;
  }
  bind(name, t) { const gl = this.gl, u = this.cur.u[name]; if (u == null) return; gl.activeTexture(gl.TEXTURE0 + this.unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(u, this.unit++); }
  f1(n, v) { const u = this.cur.u[n]; if (u != null) this.gl.uniform1f(u, v); }
  i1(n, v) { const u = this.cur.u[n]; if (u != null) this.gl.uniform1i(u, v); }
  draw(targets, rect) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo(targets));
    gl.viewport(0, 0, this.W, this.H);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]);
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
  }

  // ---- active region ----
  clampRect(r) { return [Math.max(0, Math.floor(r[0])), Math.max(0, Math.floor(r[1])), Math.min(this.W, Math.ceil(r[2])), Math.min(this.H, Math.ceil(r[3]))]; }
  /** Grow the active rect to cover r (saving the tiles it newly covers for undo first). */
  activate(r) {
    r = this.clampRect(r);
    if (r[2] <= r[0] || r[3] <= r[1]) return;
    // snap to tiles so undo tiles cover the active region exactly
    r = [Math.floor(r[0] / TILE) * TILE, Math.floor(r[1] / TILE) * TILE, Math.min(this.W, Math.ceil(r[2] / TILE) * TILE), Math.min(this.H, Math.ceil(r[3] / TILE) * TILE)];
    const n = this.active ? [Math.min(this.active[0], r[0]), Math.min(this.active[1], r[1]), Math.max(this.active[2], r[2]), Math.max(this.active[3], r[3])] : r;
    this.saveTiles(n);
    this.active = n;
  }
  /** Copy cur -> nxt over a rect for every ping-pong texture, so both agree there. */
  sync(rect) {
    const gl = this.gl;
    for (const k in this.s) {
      const s = this.s[k];
      this.bindBlit(s.cur, s.nxt);
      gl.blitFramebuffer(rect[0], rect[1], rect[2], rect[3], rect[0], rect[1], rect[2], rect[3], gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }
  setActive(r) {
    // shrinking: the part that drops out must be identical in both buffers
    if (this.active) this.sync(this.active);
    // flux outside the stepped rect must read as zero
    this.clearTex(this.F); if (this.Fn) this.clearTex(this.Fn);
    this.active = r;
  }

  // ---- stamps ----
  /** Queue brush stamps for the next step. b: {mode, shape, bK, bS, mix} */
  stamp(stamps, b) {
    if (!stamps.length) return;
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const s of stamps) { const r = s.r * (s.el || 1) * 1.3 + 2; x0 = Math.min(x0, s.x - r); y0 = Math.min(y0, s.y - r); x1 = Math.max(x1, s.x + r); y1 = Math.max(y1, s.y + r); }
    const M = b.mode <= 1 ? 56 : 8;
    this.activate([x0 - M, y0 - M, x1 + M, y1 + M]); this.markDirty([x0 - M, y0 - M, x1 + M, y1 + M]);
    // pointer events arrive several per frame: top up the last batch if it is the same brush,
    // so a frame costs one or two substeps, not one per event
    const same = (q) => q && q.b.mode === b.mode && q.b.shape === b.shape && q.b.mix === b.mix && q.b.bK.every((v, i) => v === b.bK[i]) && q.b.bS.every((v, i) => v === b.bS[i]);
    let i = 0;
    const last = this.queue.at(-1);
    if (same(last)) { const n = Math.min(MAX_ST - last.st.length, stamps.length); last.st.push(...stamps.slice(0, n)); i = n; }
    for (; i < stamps.length; i += MAX_ST) this.queue.push({ st: stamps.slice(i, i + MAX_ST), b });
  }

  setStampUniforms(batch) {
    const gl = this.gl, u = this.cur.u;
    const n = batch.st.length, a = new Float32Array(MAX_ST * 4), b = new Float32Array(MAX_ST * 4), c = new Float32Array(MAX_ST * 4);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    batch.st.forEach((s, i) => {
      a.set([s.x, s.y, s.r, s.a], i * 4);
      b.set([s.dx || 1, s.dy || 0, s.dry || 0, s.seed || 0], i * 4);
      c.set([s.ex ?? 1, s.ey ?? 0, s.el || 1, s.wt || 0], i * 4);
      const r = s.r * (s.el || 1) * 1.3 + 2; x0 = Math.min(x0, s.x - r); y0 = Math.min(y0, s.y - r); x1 = Math.max(x1, s.x + r); y1 = Math.max(y1, s.y + r);
    });
    gl.uniform4fv(u.uSt, a); gl.uniform4fv(u.uSt2, b); gl.uniform4fv(u.uSt3, c);
    this.i1('uN', n); this.i1('uShape', batch.b.shape || 0); this.i1('uMode', batch.b.mode || 0);
    if (u.uBK) { gl.uniform4fv(u.uBK, batch.b.bK); gl.uniform4fv(u.uBS, batch.b.bS); this.f1('uMix', batch.b.mix ?? 0.3); }
    return this.clampRect([x0, y0, x1 + 1, y1 + 1]);
  }

  /** Copy nxt -> cur over a rect for some ping-pong textures (after a scissored pass). */
  keep(keys, r) {
    const gl = this.gl;
    for (const k of keys) {
      this.bindBlit(this.s[k].nxt, this.s[k].cur);
      gl.blitFramebuffer(r[0], r[1], r[2], r[3], r[0], r[1], r[2], r[3], gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  /**
   * Apply one batch of brush stamps, drawn only over the batch's bounding box (a brush dab
   * costs its own footprint, not the whole wet area), then copied back so cur stays the truth.
   */
  applyBatch(batch) {
    const s = this.s;
    this.use('stamp');
    this.bind('uW', s.W.cur); this.bind('uFK', s.FK.cur); this.bind('uFS', s.FS.cur);
    const r = this.setStampUniforms(batch);
    if (r[2] <= r[0] || r[3] <= r[1]) return;
    this.draw([s.W.nxt, s.FK.nxt, s.FS.nxt], r); this.keep(['W', 'FK', 'FS'], r);
    if (batch.b.mode >= 2) {
      this.use('stampD');
      this.bind('uW', s.W.cur); this.bind('uDK', s.DK.cur); this.bind('uDS', s.DS.cur);
      this.setStampUniforms(batch);
      this.draw([s.DK.nxt, s.DS.nxt], r); this.keep(['DK', 'DS'], r);
    }
  }

  // ---- simulation ----
  substep(dt) {
    // slow processes (evaporation, absorption, deposition) scale with the real time a substep
    // stands for, so drying takes the same wall time however many substeps a device affords.
    // Flow and diffusion are explicit: they scale too, but only up to what stays stable
    const s = this.s, P = this.params, R = this.active, k = dt * SUB_HZ, kf = 1; // flow and diffusion are explicit and stay at their stable per-substep rate (scaling them up oscillates)
    const boost = 1 + this.dryBoost * 30;
    let u = this.use('flux');
    this.bind('uW', s.W.cur); this.bind('uF', this.F);
    this.gl.uniform2f(u.uGrav, P.grav[0], P.grav[1]);
    this.gl.uniform4i(u.uRect, R[0], R[1], R[2], R[3]);
    this.f1('uPin', P.pin * (this.paper.pin || 1)); this.f1('uHk', P.hk); this.f1('uC', P.c * kf); this.f1('uDamp', P.damp); this.f1('uCap', P.cap);
    // flux is written in place of itself: render to a scratch copy
    this.Fn ??= this.tex();
    this.draw([this.Fn], R); [this.F, this.Fn] = [this.Fn, this.F];

    u = this.use('water');
    this.bind('uW', s.W.cur); this.bind('uF', this.F); this.bind('uFK', s.FK.cur); this.bind('uFS', s.FS.cur);
    const ev = this.speed / SUB_HZ;
    this.f1('uEvap', P.evap * ev * boost * k); this.f1('uEdge', P.edge); this.f1('uAbsorb', P.absorb * (this.paper.absorb || 1) * k);
    this.f1('uCap', P.cap); this.f1('uCapDiff', Math.min(0.15, P.capDiff * kf)); this.f1('uEvapS', P.evapS * ev * boost * k); this.f1('uDiff', Math.min(0.18, P.diff * kf)); // explicit 4-neighbour diffusion: stable below 0.25, minus headroom for the flow term
    this.f1('uDryAll', this.dryBoost > 0.5 ? 1 : 0);
    this.draw([s.W.nxt, s.FK.nxt, s.FS.nxt], R); s.W.flip(); s.FK.flip(); s.FS.flip();

    this.use('transfer');
    this.bind('uW', s.W.cur); this.bind('uFK', s.FK.cur); this.bind('uFS', s.FS.cur); this.bind('uDK', s.DK.cur); this.bind('uDS', s.DS.cur);
    this.f1('uDown', P.down * k * (0.6 + 0.4 * this.speed)); this.f1('uUp', P.up * k); this.i1('uForceDry', 0);
    this.draw([s.FK.nxt, s.FS.nxt, s.DK.nxt, s.DS.nxt], R); s.FK.flip(); s.FS.flip(); s.DK.flip(); s.DS.flip();
    this.stepsDone++;
  }

  /** Advance by dt seconds of wall time. Returns true if anything changed. */
  step(dt) {
    if (!this.active) { this.queue.length = 0; return false; }
    // every stamp of the frame goes down now (cheap, footprint only), then the water moves
    for (const b of this.queue) this.applyBatch(b);
    this.queue.length = 0;
    const n = Math.min(this.maxSub, Math.max(1, Math.round(dt * SUB_HZ)));
    for (let i = 0; i < n; i++) this.substep(dt / n);
    this.dryBoost = Math.max(0, this.dryBoost - dt);
    this.wetTime += dt;
    this.markDirty(this.active); // water carries pigment anywhere in the wet rect
    this.compose(this.active);
    this.probe();
    return true;
  }

  /** Instantly dry everything: deposit all suspended pigment, remove water. */
  dryNow() {
    if (!this.active) return;
    const s = this.s, R = this.active;
    this.use('transfer');
    this.bind('uW', s.W.cur); this.bind('uFK', s.FK.cur); this.bind('uFS', s.FS.cur); this.bind('uDK', s.DK.cur); this.bind('uDS', s.DS.cur);
    this.f1('uDown', 1); this.f1('uUp', 0); this.i1('uForceDry', 1);
    this.queue.length = 0;
    this.draw([s.FK.nxt, s.FS.nxt, s.DK.nxt, s.DS.nxt], R); s.FK.flip(); s.FS.flip(); s.DK.flip(); s.DS.flip();
    for (const t of s.W.t) this.clearTex(t, R);
    for (const t of [...s.FK.t, ...s.FS.t]) this.clearTex(t, R);
    this.sync(R); this.compose(R); this.setActive(null);
  }

  /** Every ~0.4 s read back a coarse wet map of the active rect (async) and shrink / grow it. */
  probe() {
    const gl = this.gl, now = performance.now();
    if (this.probePending) {
      const st = gl.clientWaitSync(this.probePending.sync, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED) return;
      const { buf, rect, cells } = this.probePending; gl.deleteSync(this.probePending.sync); this.probePending = null;
      const px = new Uint8Array(cells * cells * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      if (rect !== this.active) return; // changed meanwhile
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) if (px[(j * cells + i) * 4] > 127) { x0 = Math.min(x0, i); x1 = Math.max(x1, i); y0 = Math.min(y0, j); y1 = Math.max(y1, j); }
      if (x1 < 0) { if (this.queue.length === 0) { this.compose(rect); this.setActive(null); } return; }
      const bw = (rect[2] - rect[0]) / cells, bh = (rect[3] - rect[1]) / cells, M = 48;
      const wet = [rect[0] + x0 * bw - M, rect[1] + y0 * bh - M, rect[0] + (x1 + 1) * bw + M, rect[1] + (y1 + 1) * bh + M];
      // wet paper near the edge of the active rect: grow it (water must never hit the scissor)
      const near = (x0 === 0 && rect[0] > 0) || (y0 === 0 && rect[1] > 0) || (x1 === cells - 1 && rect[2] < this.W) || (y1 === cells - 1 && rect[3] < this.H);
      if (near) { this.activate(wet); return; }
      const t = [Math.floor(Math.max(0, wet[0]) / TILE) * TILE, Math.floor(Math.max(0, wet[1]) / TILE) * TILE, Math.min(this.W, Math.ceil(wet[2] / TILE) * TILE), Math.min(this.H, Math.ceil(wet[3] / TILE) * TILE)];
      if ((t[2] - t[0]) * (t[3] - t[1]) < (rect[2] - rect[0]) * (rect[3] - rect[1]) * 0.8 && this.queue.length === 0) this.setActive(t);
      return;
    }
    if (now - this.lastProbe < 400 || !this.active) return;
    this.lastProbe = now;
    const cells = 48, R = this.active;
    if (!this.probeTex) { this.probeTex = this.tex(cells, cells, 'RGBA8'); this.probeBuf = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probeBuf); gl.bufferData(gl.PIXEL_PACK_BUFFER, cells * cells * 4, gl.STREAM_READ); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); }
    const u = this.use('probe');
    this.bind('uW', this.s.W.cur); this.bind('uFK', this.s.FK.cur);
    gl.uniform4f(u.uRect, R[0], R[1], R[2] - R[0], R[3] - R[1]); gl.uniform2f(u.uCells, cells, cells);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo([this.probeTex])); gl.viewport(0, 0, cells, cells);
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.probeBuf);
    gl.readPixels(0, 0, cells, cells, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.probePending = { sync: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0), buf: this.probeBuf, rect: R, cells };
    gl.flush();
  }

  get wet() { return !!this.active; }

  // ---- undo: tiles copied to an atlas on the GPU ----
  // A stroke record holds the 128 px tiles it (and the water it left) touched, for W, FK, FS
  // and its layer's DK, DS. Layer operations are op records with undo / redo / free.
  static KEYS = ['W', 'FK', 'FS', 'DK', 'DS'];
  initUndo() {
    const tw = Math.ceil(this.W / TILE), th = Math.ceil(this.H / TILE);
    const slots = Math.ceil(tw * th * (this.infinite ? 0.6 : 1.15)) + 4, cols = Math.ceil(Math.sqrt(slots)), rows = Math.ceil(slots / cols);
    this.atlas = { cols, rows, free: Array.from({ length: cols * rows }, (_, i) => cols * rows - 1 - i), tex: {} };
    for (const k of Sim.KEYS) this.atlas.tex[k] = this.tex(cols * TILE, rows * TILE);
  }
  blitTile(fromTex, fx, fy, toTex, tx, ty, w, h) {
    const gl = this.gl;
    this.bindBlit(fromTex, toTex);
    gl.blitFramebuffer(fx, fy, fx + w, fy + h, tx, ty, tx + w, ty + h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }
  slotXY(slot) { return [(slot % this.atlas.cols) * TILE, Math.floor(slot / this.atlas.cols) * TILE]; }
  freeRecord(r, inRedo) { for (const t of r.tiles) this.atlas.free.push(t.slot); r.op?.free?.(inRedo); }
  allocSlot() {
    while (!this.atlas.free.length) {
      // evict the oldest history
      const old = this.undo.length && this.undo[0] !== this.rec ? this.undo.shift() : null;
      if (!old) return -1;
      this.freeRecord(old, false);
    }
    return this.atlas.free.pop();
  }
  copyTiles(tiles, toAtlas) {
    for (const t of tiles) {
      const [ax, ay] = this.slotXY(t.slot), x = t.tx * TILE, y = t.ty * TILE, w = Math.min(TILE, this.W - x), h = Math.min(TILE, this.H - y);
      for (const k of Sim.KEYS) {
        if (toAtlas) this.blitTile(this.s[k].cur, x, y, this.atlas.tex[k], ax, ay, w, h);
        else for (const dst of this.s[k].t) this.blitTile(this.atlas.tex[k], ax, ay, dst, x, y, w, h);
      }
    }
    const gl = this.gl; gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }
  /** Start an undo step (call when a stroke begins). */
  begin() {
    for (const r of this.redo) this.freeRecord(r, true);
    this.redo = [];
    this.rec = { tiles: [], keys: new Set(), layer: this.layer };
    this.undo.push(this.rec);
    if (this.active) this.saveTiles(this.active);
    this.trimOps();
  }
  saveTiles(r) {
    if (!this.rec) return;
    const add = [];
    for (let ty = Math.floor(r[1] / TILE); ty < Math.ceil(r[3] / TILE); ty++) for (let tx = Math.floor(r[0] / TILE); tx < Math.ceil(r[2] / TILE); tx++) {
      const key = ty * 10000 + tx; if (this.rec.keys.has(key)) continue;
      const slot = this.allocSlot();
      if (slot < 0) { this.rec.broken = true; continue; }
      this.rec.keys.add(key); const t = { tx, ty, slot }; this.rec.tiles.push(t); add.push(t);
    }
    if (add.length) this.copyTiles(add, true);
  }
  swapRecord(from, to) {
    if (from.op) { (to === this.redo ? from.op.undo : from.op.redo)(); to.push(from); return true; }
    // a stroke on another layer: that layer becomes the active one (its wet state is dry now)
    if (from.layer && from.layer !== this.layer && this.layers.includes(from.layer)) this.setLayer(from.layer);
    // swap each tile in place: the sheet's tile and the record's saved tile change places, so
    // the record then holds the state to go back to. Only a one-tile scratch is needed: a
    // stroke over most of the sheet holds most of the atlas, and taking a second copy of it
    // (as this did before) failed, lost the record and its slots, and undo stopped working.
    if (this.active) this.sync(this.active);
    this.swapTmp ??= Object.fromEntries(Sim.KEYS.map((k) => [k, this.tex(TILE, TILE)]));
    for (const t of from.tiles) {
      const [ax, ay] = this.slotXY(t.slot), x = t.tx * TILE, y = t.ty * TILE, w = Math.min(TILE, this.W - x), h = Math.min(TILE, this.H - y);
      for (const k of Sim.KEYS) {
        const tmp = this.swapTmp[k];
        this.blitTile(this.s[k].cur, x, y, tmp, 0, 0, w, h);
        for (const dst of this.s[k].t) this.blitTile(this.atlas.tex[k], ax, ay, dst, x, y, w, h);
        this.blitTile(tmp, 0, 0, this.atlas.tex[k], ax, ay, w, h);
      }
    }
    this.gl.bindFramebuffer(this.gl.READ_FRAMEBUFFER, null); this.gl.bindFramebuffer(this.gl.DRAW_FRAMEBUFFER, null);
    to.push(from);
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (const t of from.tiles) { x0 = Math.min(x0, t.tx * TILE); y0 = Math.min(y0, t.ty * TILE); x1 = Math.max(x1, (t.tx + 1) * TILE); y1 = Math.max(y1, (t.ty + 1) * TILE); }
    if (x1 > 0) this.markDirty([x0, y0, x1, y1], from.layer || this.layer);
    this.queue.length = 0;
    if (x1 > 0) { const a = this.active; this.active = this.clampRect(a ? [Math.min(a[0], x0), Math.min(a[1], y0), Math.max(a[2], x1), Math.max(a[3], y1)] : [x0, y0, x1, y1]); this.compose(this.clampRect([x0, y0, x1, y1])); }
    this.clearTex(this.F);
    return true;
  }
  undoStep() {
    this.rec = null;
    const r = this.undo.pop(); if (!r) return false;
    if (r.broken) return false;
    return this.swapRecord(r, this.redo);
  }
  redoStep() {
    this.rec = null;
    const r = this.redo.pop(); if (!r) return false;
    return this.swapRecord(r, this.undo);
  }
  /** Undo the last step without keeping it for redo. */
  discardLast() { if (this.undoStep()) this.freeRecord(this.redo.pop(), true); }
  get canUndo() { return this.undo.length > 0 && !this.undo.at(-1).broken; }
  get canRedo() { return this.redo.length > 0; }

  /** Clear the active layer (one undo step). */
  clearAll() {
    this.dryNow();
    this.begin(); this.saveTiles([0, 0, this.W, this.H]);
    for (const k of Sim.KEYS) for (const t of this.s[k].t) this.clearTex(t);
    this.clearTex(this.F); this.active = null; this.queue.length = 0;
    this.markDirty([0, 0, this.W, this.H]);
    this.compose();
  }

  // ---- rendering ----
  /**
   * Recomposite a rect of the sheet (default: all of it): each visible layer is laid over
   * what is below it with Kubelka-Munk, alternating between two buffers so the top layer
   * lands in `targets[0]`.
   */
  compose(r = [0, 0, this.W, this.H], targets = [this.comp, this.comp2], wetShow = 1) {
    if (!r || !this.layers) return targets[0];
    const gl = this.gl, s = this.s, vis = this.layers.filter((l) => l.visible && l.opacity > 0);
    const n = Math.max(1, vis.length);
    let base = null;
    for (let i = 0; i < n; i++) {
      const L = vis[i], tgt = targets[(n - 1 - i) % 2], u = this.use('comp');
      this.bind('uW', s.W.cur); this.bind('uFK', s.FK.cur); this.bind('uFS', s.FS.cur);
      this.bind('uDK', L ? this.kOf(L) : s.W.cur); this.bind('uDS', L ? this.sOf(L) : s.W.cur); this.bind('uBase', base || s.W.cur); // (never the target: a feedback loop drops the draw)
      gl.uniform3fv(u.uPaperCol, this.paperCol); gl.uniform2f(u.uSheet, this.W, this.H); this.f1('uWetShow', wetShow);
      this.f1('uOpacity', L ? L.opacity : 0); this.i1('uHasBase', base ? 1 : 0); this.i1('uActive', L && L === this.layer ? 1 : 0);
      this.draw([tgt], r);
      base = tgt;
    }
    return targets[0];
  }
  /** Paper colour (linear RGB) and how much of the paper's relief is shown (0 = flat). */
  setLook(paperCol, litAmt) {
    const changed = paperCol.some((v, i) => v !== this.paperCol[i]);
    this.paperCol = paperCol; this.litAmt = litAmt;
    if (changed) this.compose();
  }
  /** Precomputed relief shading of the paper tile, light from the upper left. */
  buildLit() {
    const gl = this.gl, P = this.paper, N = P.N, h = P.h, d = new Uint8Array(N * N);
    const L = [-0.55, -0.65, 0.75], ll = Math.hypot(...L);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const hx = h[y * N + (x + 1) % N] - h[y * N + (x + N - 1) % N], hy = h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x];
      const nx = -hx * 2.2, ny = -hy * 2.2, nl = Math.hypot(nx, ny, 1);
      const lit = Math.min(1.4, Math.max(0.6, ((nx * L[0] + ny * L[1] + L[2]) / nl / ll) / (L[2] / ll)));
      d[y * N + x] = Math.round((1 + (lit - 1) * 0.16) / 1.25 * 255);
    }
    if (this.litTex) gl.deleteTexture(this.litTex);
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, N, N, 0, gl.RED, gl.UNSIGNED_BYTE, d); gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    this.litTex = t;
  }
  /** Draw the sheet to the screen: a couple of texture reads per pixel. */
  render(view, canvasW, canvasH, dpr, opts = {}) {
    const gl = this.gl;
    const u = this.use('screen');
    this.bind('uComp', opts.comp || this.comp); this.bind('uLit', this.litTex);
    this.f1('uPaperN', this.paperN); this.f1('uLitAmt', this.litAmt);
    const P = this.pattern; this.i1('uPat', P.type); this.f1('uPatSp', P.sp); gl.uniform3fv(u.uPatCol, P.col); gl.uniform3fv(u.uPatMargin, P.margin);
    this.i1('uInf', this.infinite && !opts.exportFbo ? 1 : 0); gl.uniform2f(u.uOrigin, this.origin[0], this.origin[1]); gl.uniform3fv(u.uPaperLin, this.paperCol);
    gl.uniformMatrix3fv(u.uInv, false, view.inv);
    gl.uniform2f(u.uSheet, this.W, this.H); gl.uniform2f(u.uCanvas, canvasW, canvasH);
    this.f1('uDpr', dpr); this.f1('uZoom', view.zoom * dpr);
    gl.uniform3fv(u.uDesk, opts.desk || [0.16, 0.16, 0.17]);
    this.i1('uExport', opts.exportFbo ? 1 : 0); this.f1('uExpScale', opts.scale || 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, opts.exportFbo || null);
    gl.viewport(0, 0, canvasW, canvasH);
    gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dropTex(t) {
    const gl = this.gl;
    for (const [k, f] of this.fbos) if (k.split(',').includes(String(t.__id))) { gl.deleteFramebuffer(f); this.fbos.delete(k); }
    gl.deleteTexture(t);
  }

  /** RGBA8 pixels of the painting, top row first, as if dry. `scale` < 1 gives a smaller picture. */
  exportPixels(opts = {}) {
    const gl = this.gl, sc = opts.scale || 1, w = Math.round(this.W * sc), h = Math.round(this.H * sc);
    const c = [this.tex(this.W, this.H, 'SRGB8_ALPHA8'), this.tex(this.W, this.H, 'SRGB8_ALPHA8')], t = this.tex(w, h, 'RGBA8');
    const pc = this.paperCol; if (opts.paperCol) this.paperCol = opts.paperCol;
    const out = this.compose(undefined, c, opts.wetShow ?? 0); this.paperCol = pc;
    this.render({ inv: [1, 0, 0, 0, 1, 0, 0, 0, 1], zoom: sc }, w, h, 1, { comp: out, exportFbo: this.fbo([t]), scale: 1 / sc });
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.dropTex(c[0]); this.dropTex(c[1]); this.dropTex(t);
    return px;
  }

  /** Small picture of what is on screen now (wet included), read back asynchronously. */
  async snapshot(maxW) {
    const gl = this.gl, sc = Math.min(1, maxW / this.W), w = Math.round(this.W * sc), h = Math.round(this.H * sc), t = this.tex(w, h, 'RGBA8');
    this.render({ inv: [1, 0, 0, 0, 1, 0, 0, 0, 1], zoom: sc }, w, h, 1, { exportFbo: this.fbo([t]), scale: 1 / sc });
    const buf = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf); gl.bufferData(gl.PIXEL_PACK_BUFFER, w * h * 4, gl.STREAM_READ);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
    while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((r) => setTimeout(r, 16));
    gl.deleteSync(sync);
    const px = new Uint8Array(w * h * 4);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.deleteBuffer(buf); this.dropTex(t);
    return { w, h, px };
  }

  /**
   * Dried pigment (deposited + suspended) as two half-float RGBA arrays, for saving. Async:
   * the readback goes through pixel-pack buffers and a fence, so painting never stalls on it.
   */
  async readDried(L = this.layer) {
    const gl = this.gl, s = this.s, n = this.W * this.H * 4, tk = this.tex(), ts = this.tex();
    this.use('dried'); this.bind('uFK', s.FK.cur); this.bind('uFS', s.FS.cur); this.bind('uDK', this.kOf(L)); this.bind('uDS', this.sOf(L)); this.i1('uActive', L === this.layer ? 1 : 0);
    this.draw([tk, ts], [0, 0, this.W, this.H]);
    const jobs = [];
    for (const t of [tk, ts]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo([t]));
      // read halves directly where the driver offers it, else floats
      const half = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.HALF_FLOAT && gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RGBA;
      const buf = gl.createBuffer(); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf); gl.bufferData(gl.PIXEL_PACK_BUFFER, n * (half ? 2 : 4), gl.STREAM_READ);
      gl.readPixels(0, 0, this.W, this.H, gl.RGBA, half ? gl.HALF_FLOAT : gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      jobs.push({ buf, half });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush();
    while (gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED) await new Promise((r) => setTimeout(r, 16));
    gl.deleteSync(sync);
    const out = [];
    for (const { buf, half } of jobs) {
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      let h;
      if (half) { h = new Uint16Array(n); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, h); }
      else {
        const f = new Float32Array(n); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, f);
        if (typeof Float16Array !== 'undefined') h = new Uint16Array(new Float16Array(f).buffer);
        else {
          // no native Float16Array: convert in slices so the page stays responsive
          h = new Uint16Array(n);
          for (let i = 0; i < n; i += 1 << 18) { const e = Math.min(n, i + (1 << 18)); for (let j = i; j < e; j++) h[j] = f[j] === 0 ? 0 : toHalf(f[j]); await new Promise((r) => setTimeout(r, 0)); }
        }
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null); gl.deleteBuffer(buf);
      out.push(h);
    }
    this.dropTex(tk); this.dropTex(ts);
    return { K: out[0], S: out[1] };
  }

  /** Dried painting, every layer: {layers: [{name, visible, opacity, K, S}], active}. */
  async readAll() {
    const layers = [];
    for (const L of this.layers) { const { K, S } = await this.readDried(L); layers.push({ uid: L.uid, name: L.name, visible: L.visible, opacity: L.opacity, K, S }); }
    return { layers, active: this.layers.indexOf(this.layer) };
  }
  /** Replace all layers with saved ones (half-float arrays from readDried). Clears history. */
  loadAll(data) {
    const gl = this.gl;
    this.queue.length = 0; this.active = null;
    for (const k of ['W', 'FK', 'FS']) for (const t of this.s[k].t) this.clearTex(t);
    for (const r of [...this.undo, ...this.redo]) this.freeRecord(r, false);
    for (const L of this.layers) this.freeLayer(L);
    this.layers = []; this.layer = null; this.s.DK = this.s.DS = null; this.nLayers = 0;
    for (const d of data.layers) {
      const L = this.addLayer(this.layers.length, d.name); L.visible = d.visible ?? true; L.opacity = d.opacity ?? 1; if (d.uid) L.uid = d.uid;
      for (const [t, arr] of [[L.K, d.K], [L.S, d.S]]) {
        if (!arr) continue; // an infinite page's layers come in tiles
        gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.W, this.H, gl.RGBA, gl.HALF_FLOAT, arr);
      }
    }
    if (!this.layers.length) this.addLayer();
    this.setLayer(this.layers[Math.min(this.layers.length - 1, Math.max(0, data.active ?? this.layers.length - 1))]);
    this.undo = []; this.redo = []; this.rec = null; this.initUndoFree(); this.dirty = new Map();
    this.compose();
  }
  initUndoFree() { const n = this.atlas.cols * this.atlas.rows; this.atlas.free = Array.from({ length: n }, (_, i) => n - 1 - i); }

  dispose() {
    const gl = this.gl;
    for (const k of ['W', 'FK', 'FS']) for (const t of this.s[k].t) gl.deleteTexture(t);
    for (const L of this.layers) { gl.deleteTexture(L.K); gl.deleteTexture(L.S); }
    if (this.scratch) { gl.deleteTexture(this.scratch.K); gl.deleteTexture(this.scratch.S); }
    for (const r of this.undo) r.op?.free?.(false);
    for (const r of this.redo) r.op?.free?.(true);
    for (const k in this.atlas.tex) gl.deleteTexture(this.atlas.tex[k]);
    for (const t of [this.F, this.Fn, this.paperTex, this.litTex, this.probeTex, this.comp, this.comp2, this.shiftTmp, ...Object.values(this.swapTmp || {})]) if (t) gl.deleteTexture(t);
    for (const f of this.fbos.values()) gl.deleteFramebuffer(f);
    for (const k in this.prog) gl.deleteProgram(this.prog[k].p);
  }
}
Sim.ids = 0; Sim.lid = 0;

/*
 * km.js - Kubelka-Munk pigment optics, three channels (RGB), shared by the UI (swatches,
 * the loaded-brush preview) and mirrored in GLSL by sim.js.
 *
 * Every pigment is a pair of coefficient vectors K (absorption) and S (scattering) per unit
 * thickness. A mixture of pigments in one layer adds them weighted by amount
 * (K = sum c_i K_i, S = sum c_i S_i), which is why the simulation can carry pigment as
 * extensive K and S amounts and still mix like paint: blue and yellow give green.
 *
 * Pigments are specified the way Curtis et al. (SIGGRAPH 1997, sec. 5.1) suggest: the colour
 * of a unit-thickness layer over white (Rw) and over black (Rb), inverted to K and S.
 * Inversion happens in linear light so the composite in the shader is physically consistent.
 */

export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055);
export const hexToRgb = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
export const rgbToHex = (c) => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

const acoth = (x) => 0.5 * Math.log((x + 1) / (x - 1));

/** K, S of one channel from unit-thickness reflectance over white rw and over black rb (linear). */
export function ksFromWB1(rw, rb) {
  rw = Math.min(Math.max(rw, 0.002), 0.995);
  rb = Math.min(Math.max(rb, 0.0005), rw * 0.995);
  const a = 0.5 * (rw + (rb - rw + 1) / rb);
  const b = Math.sqrt(a * a - 1);
  const S = acoth((b * b - (a - rw) * (a - 1)) / (b * (1 - rw))) / b;
  return [S * (a - 1), S];
}

/** {K:[r,g,b], S:[r,g,b]} from sRGB colours (0..1) of a unit layer over white and over black. */
export function ksFromWB(rwSrgb, rbSrgb) {
  const K = [], S = [];
  for (let i = 0; i < 3; i++) { const [k, s] = ksFromWB1(srgbToLinear(rwSrgb[i]), srgbToLinear(rbSrgb[i])); K.push(k); S.push(s); }
  return { K, S };
}

/** Reflectance R and transmittance T of one channel of a layer with total K, S (thickness folded in). */
export function layer1(K, S) {
  S = Math.max(S, 1e-4);
  const a = 1 + K / S, b = Math.sqrt(a * a - 1), x = Math.min(b * S, 30);
  const sh = Math.sinh(x), ch = Math.cosh(x), c = a * sh + b * ch;
  return [sh / c, b / c];
}

/** Reflectance of the layer over a background of reflectance r0 (all linear, one channel). */
export function over1(K, S, r0) {
  const [R, T] = layer1(K, S);
  return R + (T * T * r0) / (1 - R * r0);
}

/** Linear RGB reflectance of pigment amounts {K,S} (already scaled by amount) over r0 (linear RGB). */
export function over(K, S, r0) { return [0, 1, 2].map((i) => over1(K[i], S[i], r0[i])); }

/** sRGB colour of `amount` of a pigment / mix over a background given in sRGB. */
export function swatch(p, amount, bgSrgb = [1, 1, 1]) {
  const r0 = bgSrgb.map(srgbToLinear);
  return over(p.K.map((k) => k * amount), p.S.map((s) => s * amount), r0).map(linearToSrgb);
}

/** Mix pigments: parts = [{p, w}] -> combined {K, S, gran, lift} per unit amount (weights normalised). */
export function mix(parts) {
  const tot = parts.reduce((s, q) => s + q.w, 0) || 1;
  const K = [0, 0, 0], S = [0, 0, 0]; let gran = 0, lift = 0, m = 0;
  for (const { p, w } of parts) {
    const f = w / tot, pm = mass(p);
    for (let i = 0; i < 3; i++) { K[i] += f * p.K[i]; S[i] += f * p.S[i]; }
    gran += f * pm * p.gran; lift += f * pm * p.lift; m += f * pm;
  }
  return { K, S, gran: gran / (m || 1), lift: lift / (m || 1) };
}

/** The per-pixel "mass" the simulation uses to average granulation / liftability (sum of K and S). */
export const mass = (p) => p.K[0] + p.K[1] + p.K[2] + p.S[0] + p.S[1] + p.S[2];

function pigment(id, name, w, b, gran, lift, note) {
  const { K, S } = ksFromWB(w, b);
  return { id, name, K, S, gran, lift, note, w, b };
}

/**
 * The palette: masstone of a unit layer over white and over black, matched by eye to
 * common artist colours. Granulation (0..1) is how strongly a pigment settles into the
 * paper's hollows (Curtis's gamma); lift (0..1) how easily it re-wets and lifts once
 * deposited (the reciprocal of Curtis's staining power: low = staining).
 */
export const PIGMENTS = [
  pigment('hansa', 'Hansa Yellow', hexToRgb('#f5d10c'), hexToRgb('#2e2700'), 0.08, 0.7, 'PY97, transparent lemon'),
  pigment('gamboge', 'New Gamboge', hexToRgb('#f2a81a'), hexToRgb('#3c2a06'), 0.05, 0.4, 'warm transparent yellow'),
  pigment('ochre', 'Yellow Ochre', hexToRgb('#cf9d47'), hexToRgb('#80602c'), 0.55, 0.6, 'PY43, semi-opaque earth'),
  pigment('orange', 'Pyrrole Orange', hexToRgb('#e8601c'), hexToRgb('#2a0d03'), 0.1, 0.5, 'PO73, transparent'),
  pigment('cadred', 'Cadmium Red', hexToRgb('#c8261e'), hexToRgb('#6a120c'), 0.63, 0.5, 'PR108, opaque, granulates a little'),
  pigment('rose', 'Quinacridone Rose', hexToRgb('#c42f6e'), hexToRgb('#200310'), 0.1, 0.2, 'PV19, transparent, staining'),
  pigment('violet', 'Dioxazine Violet', hexToRgb('#4f2a8c'), hexToRgb('#0e0820'), 0.05, 0.15, 'PV23, intense, staining'),
  pigment('ultra', 'French Ultramarine', hexToRgb('#2b3fa6'), hexToRgb('#05081e'), 0.91, 0.9, 'PB29, granulating, lifts'),
  pigment('cerulean', 'Cerulean Blue', hexToRgb('#2a8fc0'), hexToRgb('#163f58'), 0.6, 0.8, 'PB35/36, semi-opaque, granulating'),
  pigment('phthalo', 'Phthalo Blue', hexToRgb('#11558f'), hexToRgb('#04101e'), 0.0, 0.1, 'PB15, transparent, staining'),
  pigment('phthgreen', 'Phthalo Green', hexToRgb('#00745a'), hexToRgb('#001510'), 0.0, 0.1, 'PG7, transparent, staining'),
  pigment('hooker', 'Hooker\'s Green', hexToRgb('#2e6a2a'), hexToRgb('#060f05'), 0.3, 0.5, 'transparent deep green'),
  pigment('sap', 'Sap Green', hexToRgb('#6b8c2e'), hexToRgb('#1a2409'), 0.15, 0.4, 'warm olive green'),
  pigment('sienna', 'Burnt Sienna', hexToRgb('#b4562b'), hexToRgb('#341409'), 0.35, 0.5, 'PBr7, warm earth'),
  pigment('umber', 'Burnt Umber', hexToRgb('#5e3c26'), hexToRgb('#120a05'), 0.8, 0.6, 'PBr7, granulating earth'),
  pigment('indianred', 'Indian Red', hexToRgb('#9a3a2c'), hexToRgb('#5a1f16'), 0.4, 0.4, 'PR101, opaque earth red'),
  pigment('payne', 'Payne\'s Grey', hexToRgb('#3c4754'), hexToRgb('#0b0e12'), 0.2, 0.4, 'blue-black'),
  pigment('potters', 'Potter\'s Pink', hexToRgb('#c99292'), hexToRgb('#77504f'), 1.0, 0.8, 'PR233, heavy granulation'),
  pigment('white', 'Titanium White', hexToRgb('#f6f4ee'), hexToRgb('#b9b7b1'), 0.1, 0.7, 'PW6 gouache, opaque, for highlights'),
];

/** A custom pigment from a picked sRGB colour and an opacity 0 (glassy) .. 1 (body colour). */
export function customPigment(hex, opacity = 0.2, gran = 0.2) {
  const w = hexToRgb(hex);
  // over black a transparent pigment is near black; an opaque one keeps most of its colour
  const t = Math.min(Math.max(opacity, 0), 1);
  const b = w.map((c) => c * (0.06 + 0.84 * t * t));
  return pigment('custom:' + hex + ':' + t.toFixed(2), 'Custom ' + hex, w, b, gran, 0.5, 'mixed from a picked colour');
}

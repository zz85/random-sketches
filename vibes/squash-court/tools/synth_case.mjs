// node tools/synth_case.mjs i out.jpg — one synthetic case: features (green, weight by brightness), truth (yellow), found (cyan)
import { renderCourt, randomBroadcastCamera } from '../synth.js';
import { detectCourt, mulberry32, total, toWorkCam, modelSamples, scoreCamera, explainScore } from '../detect.js';
import { writeImage, drawSeg } from './nodeimg.js';
const [i, out] = [+process.argv[2], process.argv[3]]; const W = 960, H = 540, rng = mulberry32(42);
let cam; for (let k = 0; k <= i; k++) cam = randomBroadcastCamera(rng, W, H);
const img = renderCourt(cam, { seed: i + 1, style: i % 2 ? 'glass' : 'club', players: 2, adverts: 8 });
const r = detectCourt(img.data, W, H, {}); const F = r.features, s = F.scale;
const ms = modelSamples(0.48, 0.08);
for (const [name, c] of [['truth', toWorkCam(cam, F)], ['found', r.workCam]]) { const a = scoreCamera(c, F, ms.pts, 2, 0.5); console.log(name, JSON.stringify(a), 'explained', explainScore(c, F, ms.model).toFixed(0)); }
for (const q of F.pts) { const X = Math.floor(q.x * s), Y = Math.floor(q.y * s), g = Math.round(255 * q.wt); for (let j = 0; j < s; j++) for (let k = 0; k < s; k++) { const o = ((Y + j) * W + X + k) * 4; img.data[o] = 0; img.data[o + 1] = g; img.data[o + 2] = 0; } }
for (const l of ms.model.lines) { drawSeg(img, cam, l.a, l.b, [255, 255, 0]); drawSeg(img, r.cam, l.a, l.b, [0, 255, 255]); }
writeImage(out, img);

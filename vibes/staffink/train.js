// Train the symbol classifier on HOMUS and write model.json. Zero dependencies.
//
//   bun train.js --eval        writer-independent: train writers 1-80, test 81-100
//   bun train.js               train on all 100 writers, write model.json
//   options: --epochs=40 --hidden=128 --seed=1 --homus=/path/to/HOMUS
//
// HOMUS (Calvo-Zaragoza & Oncina, ICPR 2014), https://grfia.dlsi.ua.es/homus/, is not
// bundled: it is downloaded to /tmp/homus on first run. model.json is derived weights.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { features, N_FEATURES, LABELS, CLASSES, f32ToB64, loadModel, forward, bbox } from './recognizer.js';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => { const [k, v] = a.slice(2).split('='); return [k, v === undefined ? true : isNaN(+v) ? v : +v]; }));
const EPOCHS = args.epochs || 40, HIDDEN = args.hidden || 128, SP = 14;
let root = args.homus || '/tmp/homus/HOMUS';
if (!fs.existsSync(root)) {
  fs.mkdirSync('/tmp/homus', { recursive: true });
  execSync('curl -sSL -o /tmp/homus/HOMUS.zip https://grfia.dlsi.ua.es/homus/HOMUS.zip && cd /tmp/homus && unzip -qo HOMUS.zip');
  root = '/tmp/homus/HOMUS';
}

let seed = (args.seed || 1) >>> 0;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

function load() {
  const out = [];
  for (const w of fs.readdirSync(root)) {
    const dir = path.join(root, w);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split(/\r?\n/);
      const label = lines[0].trim();
      const strokes = lines.slice(1).map((l) => l.split(';').filter((s) => s.trim()).map((s) => { const [x, y] = s.split(',').map(Number); return { x: x / SP, y: y / SP }; })).filter((s) => s.length);
      if (strokes.length && CLASSES[label]) out.push({ writer: +w, label, y: LABELS.indexOf(label), strokes });
    }
  }
  return out;
}

/** Writer variation: scale, aspect, rotation, shear, jitter; occasionally drop a tiny stroke. */
function augment(strokes) {
  const s = Math.exp(gauss() * 0.14), ax = Math.exp(gauss() * 0.07), rot = gauss() * 0.08, sh = gauss() * 0.1;
  const c = Math.cos(rot), si = Math.sin(rot), j = 0.025;
  const b = bbox(strokes);
  return strokes.map((st) => st.map((p) => {
    let x = (p.x - b.cx) * s * ax, y = (p.y - b.cy) * s / ax;
    x += sh * y;
    return { x: c * x - si * y + gauss() * j, y: si * x + c * y + gauss() * j };
  }));
}

// ---------------------------------------------------------------- tiny MLP + Adam
function makeLayer(nin, nout) {
  const W = new Float32Array(nin * nout), sc = Math.sqrt(2 / nin);
  for (let i = 0; i < W.length; i++) W[i] = gauss() * sc;
  return { nin, nout, W, b: new Float32Array(nout), gW: new Float32Array(nin * nout), gb: new Float32Array(nout), mW: new Float32Array(nin * nout), vW: new Float32Array(nin * nout), mb: new Float32Array(nout), vb: new Float32Array(nout) };
}

function train(samples, testSamples) {
  // feature normalisation from un-augmented data
  const X = samples.map((s) => features(s.strokes));
  const mean = new Float32Array(N_FEATURES), std = new Float32Array(N_FEATURES);
  for (const x of X) for (let i = 0; i < N_FEATURES; i++) mean[i] += x[i] / X.length;
  for (const x of X) for (let i = 0; i < N_FEATURES; i++) std[i] += (x[i] - mean[i]) ** 2 / X.length;
  for (let i = 0; i < N_FEATURES; i++) std[i] = Math.sqrt(std[i]) + 1e-3;
  const L1 = makeLayer(N_FEATURES, HIDDEN), L2 = makeLayer(HIDDEN, HIDDEN >> 1), L3 = makeLayer(HIDDEN >> 1, LABELS.length);
  const layers = [L1, L2, L3];
  const B = 32, wd = 3e-5, drop = 0.15;
  let t = 0;
  const acts = layers.map((L) => new Float32Array(L.nout)), masks = layers.map((L) => new Float32Array(L.nout));
  const deltas = layers.map((L) => new Float32Array(L.nout));
  const xin = new Float32Array(N_FEATURES);
  for (let ep = 0; ep < EPOCHS; ep++) {
    const lr = 2e-3 * (ep < EPOCHS * 0.6 ? 1 : ep < EPOCHS * 0.85 ? 0.3 : 0.08);
    const order = samples.map((_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    let loss = 0, correct = 0;
    for (let bi = 0; bi < order.length; bi += B) {
      for (const L of layers) { L.gW.fill(0); L.gb.fill(0); }
      const n = Math.min(B, order.length - bi);
      for (let k = 0; k < n; k++) {
        const s = samples[order[bi + k]];
        const x = features(rnd() < 0.85 ? augment(s.strokes) : s.strokes);
        for (let i = 0; i < N_FEATURES; i++) xin[i] = (x[i] - mean[i]) / std[i];
        // forward
        let h = xin;
        layers.forEach((L, li) => {
          const a = acts[li], last = li === layers.length - 1;
          for (let o = 0; o < L.nout; o++) {
            let v = L.b[o]; const row = o * L.nin;
            for (let i = 0; i < L.nin; i++) v += L.W[row + i] * h[i];
            if (!last) { v = Math.max(0, v); masks[li][o] = rnd() < drop ? 0 : 1 / (1 - drop); v *= masks[li][o]; }
            a[o] = v;
          }
          h = a;
        });
        const out = acts[layers.length - 1];
        let mx = -Infinity; for (const v of out) mx = Math.max(mx, v);
        let z = 0; for (let o = 0; o < out.length; o++) z += Math.exp(out[o] - mx);
        let best = 0; for (let o = 1; o < out.length; o++) if (out[o] > out[best]) best = o;
        if (best === s.y) correct++;
        loss += -(out[s.y] - mx - Math.log(z));
        const dl = deltas[layers.length - 1];
        for (let o = 0; o < out.length; o++) dl[o] = Math.exp(out[o] - mx) / z - (o === s.y ? 1 : 0);
        // backward
        for (let li = layers.length - 1; li >= 0; li--) {
          const L = layers[li], d = deltas[li], hin = li ? acts[li - 1] : xin;
          for (let o = 0; o < L.nout; o++) {
            const g = d[o]; if (g === 0) continue;
            L.gb[o] += g; const row = o * L.nin;
            for (let i = 0; i < L.nin; i++) L.gW[row + i] += g * hin[i];
          }
          if (li > 0) {
            const dp = deltas[li - 1], ap = acts[li - 1], mp = masks[li - 1];
            dp.fill(0);
            for (let o = 0; o < L.nout; o++) { const g = d[o]; if (g === 0) continue; const row = o * L.nin; for (let i = 0; i < L.nin; i++) dp[i] += g * L.W[row + i]; }
            for (let i = 0; i < dp.length; i++) dp[i] = ap[i] > 0 ? dp[i] * mp[i] : 0;
          }
        }
      }
      // Adam
      t++;
      const b1 = 0.9, b2 = 0.999, c1 = 1 - b1 ** t, c2 = 1 - b2 ** t;
      for (const L of layers) {
        for (let i = 0; i < L.W.length; i++) {
          const g = L.gW[i] / n + wd * L.W[i];
          L.mW[i] = b1 * L.mW[i] + (1 - b1) * g; L.vW[i] = b2 * L.vW[i] + (1 - b2) * g * g;
          L.W[i] -= lr * (L.mW[i] / c1) / (Math.sqrt(L.vW[i] / c2) + 1e-8);
        }
        for (let i = 0; i < L.b.length; i++) {
          const g = L.gb[i] / n;
          L.mb[i] = b1 * L.mb[i] + (1 - b1) * g; L.vb[i] = b2 * L.vb[i] + (1 - b2) * g * g;
          L.b[i] -= lr * (L.mb[i] / c1) / (Math.sqrt(L.vb[i] / c2) + 1e-8);
        }
      }
    }
    const json = toJson(layers, mean, std, samples);
    let msg = `epoch ${ep + 1}/${EPOCHS} loss ${(loss / samples.length).toFixed(3)} train(aug) ${(100 * correct / samples.length).toFixed(1)}%`;
    if (testSamples && (ep % 5 === 4 || ep === EPOCHS - 1)) msg += `  test ${evaluate(json, testSamples).top1}`;
    console.log(msg);
  }
  return toJson(layers, mean, std, samples);
}

function toJson(layers, mean, std, samples) {
  // median size per class, used by the parser for sanity checks
  const sizes = {};
  for (const l of LABELS) {
    const ws = [], hs = [];
    for (const s of samples) if (s.label === l) { const b = bbox(s.strokes); ws.push(b.w); hs.push(b.h); }
    ws.sort((a, b) => a - b); hs.sort((a, b) => a - b);
    sizes[l] = [+(ws[ws.length >> 1] || 0).toFixed(2), +(hs[hs.length >> 1] || 0).toFixed(2)];
  }
  return {
    about: 'StaffInk symbol classifier. MLP over directional element features, trained on HOMUS (Calvo-Zaragoza & Oncina 2014, grfia.dlsi.ua.es/homus). See train.js.',
    labels: LABELS, sizes, mean: f32ToB64(mean), std: f32ToB64(std),
    layers: layers.map((L) => ({ nin: L.nin, nout: L.nout, W: f32ToB64(L.W), b: f32ToB64(L.b) })),
  };
}

function evaluate(json, test) {
  const m = loadModel(json);
  let ok = 0, top3 = 0; const conf = new Map();
  for (const s of test) {
    const p = forward(m, features(s.strokes));
    const r = [...p].map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
    if (r[0][1] === s.y) ok++; else { const k = `${s.label}->${LABELS[r[0][1]]}`; conf.set(k, (conf.get(k) || 0) + 1); }
    if (r.slice(0, 3).some((x) => x[1] === s.y)) top3++;
  }
  return { top1: `${(100 * ok / test.length).toFixed(1)}% top-3 ${(100 * top3 / test.length).toFixed(1)}%`, conf: [...conf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10) };
}

const data = load();
console.log(`HOMUS: ${data.length} samples, ${N_FEATURES} features, ${LABELS.length} classes`);
const t0 = Date.now();
if (args.eval) {
  const test = data.filter((s) => s.writer > 80), tr = data.filter((s) => s.writer <= 80);
  const json = train(tr, test);
  const r = evaluate(json, test);
  console.log(`writer-independent (81-100 held out): top-1 ${r.top1}`);
  console.log('top confusions:', r.conf.map(([k, v]) => `${k} ${v}`).join(', '));
} else {
  const json = train(data);
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'model.json');
  fs.writeFileSync(file, JSON.stringify(json));
  console.log(`wrote ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
}
console.log(`${((Date.now() - t0) / 1000).toFixed(0)} s`);

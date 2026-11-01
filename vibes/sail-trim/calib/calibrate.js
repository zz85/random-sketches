// Fit the model's coefficients (SailModel.CAL) to a published ORC polar.
//   node calib/calibrate.js            fit, print the table, write calib/cal.json
//   node calib/calibrate.js --check    print the table for the CAL in model.js
// Each round re-trims every polar point with auto-trim (in parallel workers), then fits CAL
// with those trims held (Nelder-Mead), because the best trim depends on the coefficients.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path'), fs = require('fs');
const M = require('../model.js');
const ORC = require('./orc-catalina30.js');
const KN = M.KN, D = M.D;

// Polar points: the VMG beat and run at ORC's optimal angles, and the fixed angles 52 to 150.
function points() {
  const pts = [];
  ORC.tws.forEach((tws, i) => {
    pts.push({ tws, twa: ORC.beatAngle[i], target: ORC.beatVmg[i] / Math.cos(ORC.beatAngle[i] * D), kind: 'beat', w: 3 });
    for (const a of ORC.twa) pts.push({ tws, twa: a, target: ORC.speeds[a][i], kind: String(a), w: 1 });
    pts.push({ tws, twa: ORC.gybeAngle[i], target: ORC.runVmg[i] / -Math.cos(ORC.gybeAngle[i] * D), kind: 'run', w: 2 });
    // Pointing: sailing higher or lower than ORC's VMG angle must not make a better VMG than ORC's.
    for (const d of [-7, 7]) pts.push({ tws, twa: ORC.beatAngle[i] + d, vmgMax: ORC.beatVmg[i], kind: 'beat' + (d > 0 ? '+' : '-'), w: 3 });
    for (const d of [-12, 12]) { const a = Math.min(180, ORC.gybeAngle[i] + d); if (a < ORC.gybeAngle[i] + 1) { if (d > 0) continue; } pts.push({ tws, twa: a, vmgMax: ORC.runVmg[i], kind: 'run' + (d > 0 ? '+' : '-'), w: 2 }); }
  });
  return pts;
}
// The sails a crew would try: the genoa upwind, the genoa or the spinnaker from 75 deg (ORC takes the faster).
const sailsFor = (p) => (p.twa < 75 ? ['jib'] : ['jib', 'spin']);
const envOf = (p) => ({ tws: p.tws * KN, twa: p.twa, bs: (p.target || p.vmgMax / Math.abs(Math.cos(p.twa * D))) * KN * 0.95 });

function trimAll(pts, trims) {
  return pts.map((p, i) => sailsFor(p).map((sail, j) => {
    const start = (trims && trims[i] && trims[i][j]) || Object.assign(M.defaultControls(), { head: sail, mainsheet: p.twa > 90 ? 0.6 : 0.1, jibSheet: p.twa > 90 ? 0.7 : 0.1 });
    return M.autoTrim(Object.assign({}, start, { head: sail }), envOf(p));
  }));
}

function speeds(pts, trims) {
  return pts.map((p, i) => {
    let best = 0, sail = '';
    trims[i].forEach((c) => { const s = M.steady(c, envOf(p), 100); if (s.bs / KN > best) { best = s.bs / KN; sail = c.head + (c.wing ? '+wing' : '') + (c.reef ? ` r${c.reef}` : ''); } });
    return { bs: best, sail };
  });
}
const vmgOf = (p, bs) => bs * Math.abs(Math.cos(p.twa * D));
const errOf = (p, s) => (p.target ? (s.bs - p.target) / p.target : Math.max(0, vmgOf(p, s.bs) - p.vmgMax) / p.vmgMax);
const loss = (pts, sp) => pts.reduce((a, p, i) => a + p.w * errOf(p, sp[i]) ** 2, 0) / pts.reduce((a, p) => a + p.w, 0);

const PARAMS = { lift: [0.6, 1.5], parasitic: [0.005, 0.06], kite: [0.5, 1.5], fric: [0.0025, 0.0045], heelDrag: [0, 2], cw: [0.003, 0.05], fnExp: [2, 10], rm: [15000, 120000], windage: [0.5, 8], spinClear: [0.1, 1], sheetMin: [8, 17] };
const KEYS = Object.keys(PARAMS);
const toCal = (x) => Object.fromEntries(KEYS.map((k, i) => [k, PARAMS[k][0] + Math.min(1, Math.max(0, x[i])) * (PARAMS[k][1] - PARAMS[k][0])]));
const toX = (cal) => KEYS.map((k) => (cal[k] - PARAMS[k][0]) / (PARAMS[k][1] - PARAMS[k][0]));

function nelderMead(f, x0, iters) {
  const n = x0.length;
  let S = [x0].concat(x0.map((_, i) => x0.map((v, j) => (i === j ? v + 0.08 : v))));
  let F = S.map(f);
  for (let it = 0; it < iters; it++) {
    const ord = F.map((v, i) => i).sort((a, b) => F[a] - F[b]); S = ord.map((i) => S[i]); F = ord.map((i) => F[i]);
    const c = S[0].map((_, j) => S.slice(0, n).reduce((a, x) => a + x[j], 0) / n);
    const at = (t) => c.map((v, j) => v + t * (S[n][j] - v));
    const xr = at(-1), fr = f(xr);
    if (fr < F[0]) { const xe = at(-2), fe = f(xe); [S[n], F[n]] = fe < fr ? [xe, fe] : [xr, fr]; }
    else if (fr < F[n - 1]) { S[n] = xr; F[n] = fr; }
    else {
      const xc = at(0.5), fc = f(xc);
      if (fc < F[n]) { S[n] = xc; F[n] = fc; }
      else for (let i = 1; i <= n; i++) { S[i] = S[i].map((v, j) => S[0][j] + 0.5 * (v - S[0][j])); F[i] = f(S[i]); }
    }
  }
  const b = F.indexOf(Math.min(...F));
  return { x: S[b], f: F[b] };
}

// Re-trim in parallel: each worker takes a slice of the points.
function trimParallel(pts, trims, cal) {
  const n = Math.min(require('os').cpus().length, 48, pts.length), size = Math.ceil(pts.length / n);
  return Promise.all(Array.from({ length: n }, (_, w) => new Promise((res, rej) => {
    const lo = w * size, hi = Math.min(pts.length, lo + size);
    const wk = new Worker(__filename, { workerData: { cal, pts: pts.slice(lo, hi), trims: trims ? trims.slice(lo, hi) : null } });
    wk.on('message', res); wk.on('error', rej);
  }))).then((parts) => parts.flat());
}

function table(pts, sp) {
  const rows = ['beat', ...ORC.twa.map(String), 'run'];
  let out = 'TWA      ' + ORC.tws.map((t) => String(t).padStart(12)).join('') + '\n';
  for (const r of rows) {
    out += r.padEnd(9);
    ORC.tws.forEach((t) => {
      const i = pts.findIndex((p) => p.kind === r && p.tws === t);
      out += `${sp[i].bs.toFixed(2)}/${pts[i].target.toFixed(2)}`.padStart(12);
    });
    out += '\n';
  }
  const err = pts.filter((p) => p.target).map((p) => (sp[pts.indexOf(p)].bs - p.target) / p.target * 100);
  const over = pts.filter((p) => !p.target).map((p) => errOf(p, sp[pts.indexOf(p)]) * 100);
  out += `pointing checks: ${over.filter((e) => e > 0.5).length} of ${over.length} beat ORC's VMG by more than 0.5% (worst ${Math.max(...over).toFixed(1)}%)\n`;
  out += `model/ORC knots. RMS error ${Math.sqrt(err.reduce((a, e) => a + e * e, 0) / err.length).toFixed(1)}%, worst ${Math.max(...err.map(Math.abs)).toFixed(1)}%\n`;
  return out;
}

async function main() {
  const pts = points(), check = process.argv.includes('--check');
  let cal = Object.fromEntries(KEYS.map((k) => [k, M.CAL[k]]));
  M.setCal(cal);
  let trims = await trimParallel(pts, null, cal);
  if (!check) {
    for (let round = 0; round < 5; round++) {
      const r = nelderMead((x) => { M.setCal(toCal(x)); return loss(pts, speeds(pts, trims)); }, toX(cal), 260);
      cal = toCal(r.x); M.setCal(cal);
      trims = await trimParallel(pts, trims, cal);
      console.log(`round ${round}: loss ${r.f.toExponential(3)} -> retrimmed ${loss(pts, speeds(pts, trims)).toExponential(3)}`, JSON.stringify(Object.fromEntries(Object.entries(cal).map(([k, v]) => [k, +v.toPrecision(4)]))));
    }
    fs.writeFileSync(path.join(__dirname, 'cal.json'), JSON.stringify(Object.fromEntries(Object.entries(cal).map(([k, v]) => [k, +v.toPrecision(4)])), null, 1) + '\n');
  }
  const sp = speeds(pts, trims);
  console.log(table(pts, sp));
  // VMG-optimal angles against ORC's beat and gybe angles
  for (const [i, tws] of ORC.tws.entries()) {
    const best = (twas, head, sign) => {
      let b = { v: -1 }, c = null;
      for (const twa of twas) {
        const e = { tws: tws * KN, twa, bs: 4 * KN };
        c = M.autoTrim(Object.assign(c || Object.assign(M.defaultControls(), { mainsheet: sign < 0 ? 0.8 : 0.06, jibSheet: 0.1, spinSheet: 0.6, spinPole: 0.7 }), { head }), e);
        const v = sign * M.steady(c, e, 100).bs / KN * Math.cos(twa * D);
        if (v > b.v) b = { v, twa };
      }
      return b;
    };
    const u = best([36, 38, 40, 42, 44, 46, 48, 50], 'jib', 1), d = best([140, 145, 150, 155, 160, 165, 170, 175, 180], 'spin', -1);
    console.log(`${String(tws).padStart(2)} kn  beat ${u.twa} deg VMG ${u.v.toFixed(2)} (ORC ${ORC.beatAngle[i]} deg ${ORC.beatVmg[i].toFixed(2)})   run ${d.twa} deg VMG ${d.v.toFixed(2)} (ORC ${ORC.gybeAngle[i]} deg ${ORC.runVmg[i].toFixed(2)})`);
  }
  const sails = {}; pts.forEach((p, i) => { (sails[p.kind] = sails[p.kind] || []).push(sp[i].sail); });
  for (const k in sails) console.log(k.padEnd(6), sails[k].join(', '));
}

if (isMainThread) main();
else { M.setCal(workerData.cal); parentPort.postMessage(trimAll(workerData.pts, workerData.trims)); }

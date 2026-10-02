// Accuracy report on the Verovio fixtures under simulated photo conditions.
//   bun eval.js [tune] [condition]      e.g. bun eval.js minuet phone
import fs from 'fs';
import { decodeGray } from './png.js';
import { degrade, CONDITIONS } from './degrade.js';
import { normalize, analyze } from './omr.js';
import { natMidi } from './theory.js';
import { buildScore, evTicks } from './score.js';

const dir = new URL('./fixtures/', import.meta.url);
export const FIXTURES = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
const CLEF_OF = { G: 'treble', F: 'bass', C: 'alto' };

export function loadFixture(name) {
  return { img: decodeGray(fs.readFileSync(new URL(name + '.png', dir))), truth: JSON.parse(fs.readFileSync(new URL(name + '.json', dir))) };
}

export function evaluate(name, cond = 'clean') {
  const { img, truth } = loadFixture(name);
  const { img: photo, fwd } = cond === 'clean' ? { img, fwd: (x, y) => [x, y] } : degrade(img, CONDITIONS[cond]);
  const t0 = performance.now();
  const norm = normalize(photo), res = analyze(norm);
  const ms = performance.now() - t0;
  const [a, b, c, d, e, f] = norm.A, det = a * e - b * d;
  const toNorm = (x, y) => [(e * (x - c) - b * (y - f)) / det, (-d * (x - c) + a * (y - f)) / det];
  const tn = truth.notes.map((n) => {
    const [u, v] = toNorm(...fwd(n.x, n.y)), dd = n.oct * 7 + 'cdefgab'.indexOf(n.pname);
    return { ...n, u, v, d: dd, alter: n.midi - natMidi(dd) };
  });
  const det2 = res.notes.slice(), used = new Set();
  let tp = 0, pitch = 0; const misses = [], wrong = [], pairs = [];
  for (const n of tn) {
    let best = null, bd = 0.7 * 16;
    for (const m of det2) { if (used.has(m)) continue; const dd = Math.hypot(m.x - n.u, m.y - n.v); if (dd < bd) { bd = dd; best = m; } }
    if (!best) { misses.push(n); continue; }
    used.add(best); tp++; pairs.push([n, best]);
    if (best.pitch.d === n.d && best.pitch.alter === n.alter) pitch++; else wrong.push({ truth: n, got: best });
  }
  const fps = det2.filter((m) => !used.has(m));
  const clefOk = res.staves.filter((s) => s.clef.type === CLEF_OF[truth.clef]).length;
  const keyOk = res.staves.filter((s) => s.key.fifths === truth.fifths).length;
  return { truth, pairs, tn, toNorm: (x, y) => toNorm(...fwd(x, y)), name, cond, ms, staves: res.staves.length, trueStaves: truth.staves.length, clefOk, keyOk, n: tn.length, tp, fp: fps.length, pitch, misses, wrong, fps, res, norm };
}

// Rhythm against the truth: per matched note, its event's written value (dur, dots, tuplet);
// per truth bar, whether the measure holding its notes has exactly the same sequence of
// note/rest lengths. Rests: found vs truth.
export function evaluateRhythm(r) {
  const sc = buildScore(r.res), T = r.truth;
  const where = new Map();
  for (const m of sc.measures) m.events.forEach((e) => (e.notes || []).forEach((n) => where.set(n, { m, e })));
  let n = 0, dur = 0, val = 0; const confusions = {};
  for (const [tn, got] of r.pairs) {
    n++; const w = where.get(got); if (!w) continue;
    const tt = (tn.tuplet ? (baseOf(tn.dur, tn.dots) * tn.tuplet[1]) / tn.tuplet[0] : baseOf(tn.dur, tn.dots));
    if (w.e.dur === tn.dur) dur++;
    if (evTicks(w.e) === tt) val++; else { const k = `${tn.dur}${'.'.repeat(tn.dots)}${tn.tuplet ? 't' : ''}->${w.e.dur}${'.'.repeat(w.e.dots)}${w.e.tuplet ? 't' : ''}`; confusions[k] = (confusions[k] || 0) + 1; }
  }
  const cap = (T.meter[0] * 384) / T.meter[1];
  const seq = (evs) => evs.filter((e) => !e.removed && !e.grace).map((e) => (e.kind === 'note' ? 'n' : 'r') + (e.full ? cap : evTicks(e))).join(' ');
  let bars = 0; const badBars = [];
  const tnotes = r.pairs.map(([tn, got]) => [tn, got]), byTruth = new Map(); for (const [tn, got] of tnotes) byTruth.set(tn, got);
  const truthNotes = r.tn || [];
  T.measures.forEach((tm, mi) => {
    const tseq = tm.events.map((e) => (e.kind === 'note' ? 'n' : 'r') + (e.kind === 'mRest' ? cap : e.ticks)).join(' ');
    // the detected measure holding this bar's first matched note (bars of only rests: skipped)
    const firstNote = tm.events.flatMap((e) => e.notes).map((k) => truthNotes[k]).find((q) => q && byTruth.has(q));
    if (!firstNote) { if (tm.events.every((e) => e.kind !== 'note')) { const ok = sc.measures.some((m) => m.events.every((e) => e.kind === 'rest') && seq(m.events) === tseq); if (ok) bars++; else badBars.push([mi, tseq, '?']); } else badBars.push([mi, tseq, 'notes missing']); return; }
    const w = where.get(byTruth.get(firstNote)); const got = w ? seq(w.m.events) : '';
    if (got === tseq) bars++; else badBars.push([mi, tseq, got, w?.m.status]);
  });
  const rests = sc.measures.reduce((s, m) => s + m.events.filter((e) => e.kind === 'rest' && !e.removed).length, 0);
  const trests = T.measures.reduce((s, m) => s + m.events.filter((e) => e.kind !== 'note').length, 0);
  return { n, dur, val, bars, nbars: T.measures.length, badBars, confusions, rests, trests, stats: sc.stats, score: sc };
}
const baseOf = (dur, dots) => { let t = 384 / dur, a = t; for (let i = 0; i < dots; i++) { a /= 2; t += a; } return t; };

if (import.meta.main || process.argv[1]?.endsWith('eval.js')) {
  const [only, condArg] = process.argv.slice(2);
  const conds = condArg ? [condArg] : Object.keys(CONDITIONS);
  const rows = [];
  for (const name of FIXTURES.filter((n) => !only || only === 'all' || n === only)) for (const cond of conds) {
    try {
      const r = evaluate(name, cond); rows.push(r);
      const R = (r.rh = evaluateRhythm(r));
      console.log(`${name.padEnd(10)} ${cond.padEnd(6)} staves ${r.staves}/${r.trueStaves} clef ${r.clefOk} key ${r.keyOk}  heads ${r.tp}/${r.n} fp ${r.fp}  pitch ${r.pitch}/${r.n}  value ${R.val}/${R.n}  bars ${R.bars}/${R.nbars}  rests ${R.rests}/${R.trests}  ${r.ms.toFixed(0)} ms`);
      if (only && only !== 'all') {
        for (const m of r.misses.slice(0, 12)) console.log('  miss', m.pname + m.oct, m.type, m.u.toFixed(0), m.v.toFixed(0));
        for (const m of r.fps.slice(0, 12)) console.log('  fp', m.kind, m.p, m.x.toFixed(0), m.y.toFixed(0), m.stem ? 'stem' : '');
        for (const m of r.wrong.slice(0, 12)) console.log('  wrong', m.truth.pname + m.truth.oct, m.truth.alter, '->', m.got.name, 'p', m.got.p, m.got.x.toFixed(0), m.got.y.toFixed(0));
        r.res.staves.forEach((s, i) => console.log('  staff', i, s.clef.detected, 'key', s.key.detected, 'bars', s.bars.length, 'x', s.x0, s.x1, 'time', JSON.stringify((s.times || []).map((t) => t.sym || t.beats + '/' + t.unit))));
        console.log('  values', JSON.stringify(R.confusions));
        for (const b of R.badBars) console.log('  bar', ...b);
      }
    } catch (e) { console.log(`${name.padEnd(10)} ${cond.padEnd(6)} ERROR ${e.message}`); rows.push({ name, cond, n: 0, tp: 0, pitch: 0, error: e }); }
  }
  const N = rows.reduce((a, r) => a + r.n, 0), TP = rows.reduce((a, r) => a + r.tp, 0), FP = rows.reduce((a, r) => a + (r.fp || 0), 0), P = rows.reduce((a, r) => a + r.pitch, 0);
  const V = rows.reduce((a, r) => a + (r.rh?.val || 0), 0), B = rows.reduce((a, r) => a + (r.rh?.bars || 0), 0), NB = rows.reduce((a, r) => a + (r.rh?.nbars || 0), 0);
  console.log(`TOTAL values ${(V / N * 100).toFixed(1)}%  bars exactly right ${B}/${NB} (${(B / NB * 100).toFixed(1)}%)`);
  console.log(`TOTAL heads recall ${(TP / N * 100).toFixed(1)}%  precision ${(TP / (TP + FP) * 100).toFixed(1)}%  pitch ${(P / N * 100).toFixed(1)}%`);
}

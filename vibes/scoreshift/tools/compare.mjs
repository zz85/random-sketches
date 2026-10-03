// Compare MusicXML outputs (ScoreShift, Audiveris) with each other or with fixture ground truth.
//   node tools/compare.mjs truth <fixture.json> <a.musicxml|a.mxl> [b ...]
//   node tools/compare.mjs pair <a> <b>
// Music is reduced to a flat sequence of events (rest or chord: sorted MIDI pitches, length in
// 96ths of a quarter) per measure, all voices merged by onset. Notes are aligned globally
// (Needleman-Wunsch on pitch), then counted: pitch found, value right; bars compared as strings.
import fs from 'fs';
import { execFileSync } from 'child_process';

const STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
export function readXml(file) {
  let xml;
  if (/\.mxl$/.test(file)) {
    const list = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n').filter((f) => /\.(xml|musicxml)$/.test(f) && !f.startsWith('META-INF'));
    xml = execFileSync('unzip', ['-p', file, list[0]], { encoding: 'utf8', maxBuffer: 64e6 });
  } else xml = fs.readFileSync(file, 'utf8');
  const parts = [...xml.matchAll(/<part id="[^"]*">([\s\S]*?)<\/part>/g)].map((m) => m[1]);
  return parts.map((p) => {
    let divs = 1;
    return [...p.matchAll(/<measure\b[^>]*>([\s\S]*?)<\/measure>/g)].map((mm) => {
      const body = mm[1]; const d = body.match(/<divisions>(\d+)<\/divisions>/); if (d) divs = +d[1];
      const evs = new Map(); let t = 0, last = 0;
      for (const tok of body.matchAll(/<(note|backup|forward)\b[^>]*>([\s\S]*?)<\/\1>/g)) {
        const [, kind, x] = tok; const dur = +(x.match(/<duration>(\d+)<\/duration>/)?.[1] || 0);
        if (kind === 'backup') { t -= dur; continue; }
        if (kind === 'forward') { t += dur; continue; }
        if (/<grace\b/.test(x)) continue;
        const chord = /<chord\s*\/>/.test(x), on = chord ? last : t;
        const len = Math.round((dur / divs) * 96);
        const key = on + ':' + (chord ? 'c' : len);
        let e = evs.get(chord ? [...evs.keys()].reverse().find((k) => k.startsWith(on + ':')) : key);
        if (!e) { e = { on: Math.round((on / divs) * 96), len, rest: /<rest\b/.test(x), midi: [] }; evs.set(key, e); }
        if (!/<rest\b/.test(x)) {
          const st = x.match(/<step>([A-G])<\/step>/)[1], al = +(x.match(/<alter>(-?\d+)<\/alter>/)?.[1] || 0), oc = +x.match(/<octave>(\d+)<\/octave>/)[1];
          e.midi.push(12 * (oc + 1) + STEP[st] + al); e.rest = false;
        }
        if (!chord) { last = t; t += dur; }
      }
      return [...evs.values()].sort((a, b) => a.on - b.on || b.len - a.len).map((e) => ({ ...e, midi: e.midi.sort((a, b) => a - b) }));
    });
  });
}
// fixture truth in the same shape (written pitch)
export function readTruth(file) {
  const T = JSON.parse(fs.readFileSync(file, 'utf8')), cap = (T.meter[0] * 384) / T.meter[1];
  // (onsets per voice; events of all voices at one onset and length merge, as readXml does)
  return [T.measures.map((m) => {
    const at = new Map(), evs = new Map();
    for (const e of m.events) {
      const v = e.voice || 0, on = at.get(v) ?? 0, len = e.kind === 'mRest' ? cap : e.ticks; at.set(v, on + len);
      const key = on + ':' + len + ':' + (e.kind !== 'note');
      if (!evs.has(key)) evs.set(key, { on, len, rest: e.kind !== 'note', midi: [] });
      evs.get(key).midi.push(...e.notes.map((k) => T.notes[k].midi));
    }
    return [...evs.values()].sort((a, b) => a.on - b.on || b.len - a.len).map((e) => ({ ...e, midi: e.midi.sort((a, b) => a - b) }));
  })];
}
const flat = (parts) => parts.flatMap((p, pi) => p.flatMap((m, mi) => m.filter((e) => !e.rest).flatMap((e) => e.midi.map((midi) => ({ midi, len: e.len, mi, pi })))));

function align(a, b, eq) { // Needleman-Wunsch, returns pairs [i, j]
  const n = a.length, m = b.length, W = m + 1, D = new Int32Array((n + 1) * W), P = new Uint8Array((n + 1) * W);
  for (let i = 1; i <= n; i++) { D[i * W] = -i; P[i * W] = 1; }
  for (let j = 1; j <= m; j++) { D[j] = -j; P[j] = 2; }
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    const s = D[(i - 1) * W + j - 1] + (eq(a[i - 1], b[j - 1]) ? 2 : -1), u = D[(i - 1) * W + j] - 1, l = D[i * W + j - 1] - 1;
    if (s >= u && s >= l) { D[i * W + j] = s; P[i * W + j] = 0; } else if (u >= l) { D[i * W + j] = u; P[i * W + j] = 1; } else { D[i * W + j] = l; P[i * W + j] = 2; }
  }
  const out = []; let i = n, j = m;
  while (i > 0 || j > 0) { const p = P[i * W + j]; if (i > 0 && j > 0 && p === 0) { out.push([i - 1, j - 1]); i--; j--; } else if (i > 0 && (j === 0 || p === 1)) i--; else j--; }
  return out.reverse();
}
const barStr = (m) => m.map((e) => (e.rest ? 'r' : e.midi.join('+')) + ':' + e.len).join(' ');

/** Compare `got` with reference `ref`. */
export function compare(ref, got) {
  const A = flat(ref), B = flat(got);
  const pairs = align(A, B, (x, y) => x.midi === y.midi).filter(([i, j]) => A[i].midi === B[j].midi);
  const val = pairs.filter(([i, j]) => A[i].len === B[j].len).length;
  const rb = ref.flat(), gb = got.flat();
  const bp = align(rb, gb, (x, y) => barStr(x) === barStr(y)).filter(([i, j]) => barStr(rb[i]) === barStr(gb[j]));
  return { notes: A.length, got: B.length, pitch: pairs.length, value: val, bars: rb.length, gotBars: gb.length, barsExact: bp.length };
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) + '%' : '-');
export const fmt = (r) => `notes ${r.got}/${r.notes}  pitch ${pct(r.pitch, r.notes)} (prec ${pct(r.pitch, r.got)})  pitch+value ${pct(r.value, r.notes)}  bars ${r.barsExact}/${r.bars} (${r.gotBars} out)`;

if (process.argv[1]?.endsWith('compare.mjs')) {
  const [mode, a, ...rest] = process.argv.slice(2);
  const ref = mode === 'truth' ? readTruth(a) : readXml(a);
  for (const f of rest) console.log(f.split('/').pop().padEnd(30), fmt(compare(ref, readXml(f))));
}

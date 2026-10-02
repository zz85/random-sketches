// Evaluate ScoreShift on a real PDF against MusicXML ground truth.
//   bun tools/imslp_eval.js <pages dir of p###.png> <xml files...> [--pages 2-25] [--json out.json]
// Pages are rendered beforehand (tools/imslp_fetch.mjs). Every detected notehead, in reading
// order (page, staff top to bottom, left to right, chords low to high), is aligned against the
// ground-truth notes in score order with an edit-distance alignment on MIDI pitch, so edition
// differences and missed / extra notes cost locally instead of shifting everything after them.
//   heads found   = truth notes paired with a detected head (match + wrong pitch)
//   pitch correct = matched / truth notes;  extra = detected heads with no counterpart
// Staves are mapped to the truth system their aligned notes come from, to score clef and key.
import fs from 'fs';
import path from 'path';
import { decodeGray } from '../png.js';
import { normalize, analyze } from '../omr.js';
import { midiOf } from '../theory.js';
import { readMusicXML } from './groundtruth.js';

const args = process.argv.slice(2), opt = {}, files = [];
for (let i = 0; i < args.length; i++) if (args[i].startsWith('--')) opt[args[i].slice(2)] = args[++i]; else files.push(args[i]);
const [dir, ...xmls] = files;
const sel = (s) => s.split(',').flatMap((r) => { const [a, z] = r.split('-').map(Number); return Array.from({ length: (z || a) - a + 1 }, (_, i) => a + i); });
const pngs = fs.readdirSync(dir).filter((f) => /^p\d+\.png$/.test(f)).sort();
const pages = opt.pages ? sel(opt.pages) : pngs.map((f) => +f.slice(1, -4));

// truth: every non-grace note, in order, tagged with its system (global index) and staff
const T = [], tSys = [];
for (const x of xmls) for (const part of readMusicXML(fs.readFileSync(x, 'utf8')).parts) for (const s of part.systems) {
  const si = tSys.length; tSys.push({ file: path.basename(x), staves: s.staves.map((st) => ({ clef: st.clef, fifths: st.fifths })) });
  s.staves.forEach((st, k) => { for (const n of st.notes) if (!n.grace) T.push({ midi: n.midi, sys: si, staff: k }); });
}
const graces = xmls.reduce((a, x) => a + readMusicXML(fs.readFileSync(x, 'utf8')).parts.flatMap((p) => p.systems.flatMap((s) => s.staves.flatMap((st) => st.notes))).filter((n) => n.grace).length, 0);

// detection
const G = [], gStaff = [], t0 = performance.now(); let failed = 0;
for (const k of pages) {
  const f = path.join(dir, `p${String(k).padStart(3, '0')}.png`);
  let res;
  try { res = analyze(normalize(decodeGray(fs.readFileSync(f)))); } catch (e) { failed++; continue; }
  for (const st of res.staves) {
    const gi = gStaff.length; gStaff.push({ page: k, clef: st.clef.detected, type: st.clef.type, fifths: st.key.fifths, detected: st.key.detected, inferred: !!st.key.inferred, n: st.notes.length });
    for (const n of st.notes) G.push({ midi: midiOf(n.pitch), staff: gi });
  }
}
const ms = performance.now() - t0;

// alignment (Uint16 costs: sequences up to ~30k)
function align(a, b) {
  const n = a.length, m = b.length, W = m + 1, D = new Uint16Array((n + 1) * W);
  for (let j = 0; j <= m; j++) D[j] = j;
  for (let i = 1; i <= n; i++) {
    D[i * W] = i; const ai = a[i - 1], r = i * W, p = (i - 1) * W;
    for (let j = 1; j <= m; j++) { const s = D[p + j - 1] + (ai === b[j - 1] ? 0 : 1), u = D[p + j] + 1, l = D[r + j - 1] + 1; D[r + j] = s < u ? (s < l ? s : l) : u < l ? u : l; }
  }
  const pairs = []; let i = n, j = m;
  while (i > 0 || j > 0) {
    const v = D[i * W + j];
    if (i > 0 && j > 0 && v === D[(i - 1) * W + j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (i > 0 && v === D[(i - 1) * W + j] + 1) { pairs.push([i - 1, -1]); i--; }
    else { pairs.push([-1, j - 1]); j--; }
  }
  return pairs.reverse();
}
const pairs = align(T.map((t) => t.midi), G.map((g) => g.midi));
let match = 0, sub = 0, del = 0, ins = 0, oct = 0, semi = 0;
const votes = gStaff.map(() => new Map()), stScore = gStaff.map(() => ({ match: 0, sub: 0, ins: 0 }));
for (const [ti, gi] of pairs) {
  if (ti >= 0 && gi >= 0) {
    const t = T[ti], g = G[gi], d = g.midi - t.midi;
    if (!d) match++; else { sub++; if (Math.abs(d) === 12) oct++; if (Math.abs(d) === 1) semi++; }
    const key = t.sys + ':' + t.staff, v = votes[g.staff]; v.set(key, (v.get(key) || 0) + 1);
    stScore[g.staff][d ? 'sub' : 'match']++;
  } else if (ti >= 0) del++; else { ins++; stScore[G[gi].staff].ins++; }
}
// staff -> truth staff by majority of aligned notes; clef + key
const CLEF_OK = (a, b) => a === b || (a === 'treble' && b === 'treble8vb');
let clefOk = 0, keyOk = 0, keyRaw = 0, mapped = 0; const badKeys = [], badClefs = [];
gStaff.forEach((s, i) => {
  const best = [...votes[i]].sort((a, b) => b[1] - a[1])[0]; if (!best || best[1] < 3) return;
  const [si, k] = best[0].split(':').map(Number), tr = tSys[si].staves[k]; mapped++;
  if (CLEF_OK(s.clef, tr.clef)) clefOk++; else badClefs.push(`p${s.page} ${s.clef}≠${tr.clef}`);
  if (s.fifths === tr.fifths) keyOk++; else badKeys.push(`p${s.page} ${s.fifths}${s.inferred ? '*' : ''}≠${tr.fifths}`);
  if (s.detected === tr.fifths) keyRaw++;
});
const N = T.length, pct = (x, d = N) => ((100 * x) / d).toFixed(1) + '%';
const out = {
  truthNotes: N, graceNotesExcluded: graces, detected: G.length, pages: pages.length, failedPages: failed, ms: Math.round(ms),
  headsFound: pct(match + sub), pitchCorrect: pct(match), pitchGivenHead: pct(match, match + sub), extra: ins, extraRate: pct(ins, G.length),
  wrongPitch: { total: sub, octave: oct, semitone: semi }, staves: gStaff.length, stavesMapped: mapped,
  clefs: `${clefOk}/${mapped}`, keys: `${keyOk}/${mapped}`, keysReadDirectly: `${keyRaw}/${mapped}`, badKeys: badKeys.slice(0, 20), badClefs: badClefs.slice(0, 20),
  worstStaves: gStaff.map((s, i) => ({ page: s.page, i, ...stScore[i], n: s.n })).filter((s) => s.n).sort((a, b) => (b.sub + b.ins) / b.n - (a.sub + a.ins) / a.n).slice(0, 8),
};
console.log(JSON.stringify(out, null, 1));
if (opt.json) fs.writeFileSync(opt.json, JSON.stringify(out, null, 1));

// node tools/pbox_eval.mjs [--data dir] [--jobs N] [--video id] [--json out.json] [--show n]
// Player detection on real broadcast frames, against the SquashAI hand-drawn player boxes (fetch
// them with tools/squashai_fetch.mjs; default dir /tmp/squash/squashai). Each still is judged on
// its own: court fitted, then detectPlayers with no background model (the page also has the
// video's history, so it does somewhat better than this).
//
// A labelled player is FOUND when one of our players' feet (the floor point, projected) lands in
// the bottom of its box: inside it across, and within 25 % of its height above / 10 % below its
// bottom edge. Matching is one-to-one, nearest feet first. Looser, a player is seen at all when
// one of our boxes overlaps it with IoU > 0.3 (the person found, the feet maybe off). Reported:
//   - recall over every labelled player, and over those on frames whose court we fitted
//   - false players: ours with no labelled box
//   - feet error in px and as a fraction of the box height; box IoU
//   - floor error in cm, only where the label T-box agrees with our court (< 10 px at 1280 wide;
//     elsewhere the T-box is stale), label feet put on the floor through the T-box homography
//   - broken down by video, by box height (far / mid / near) and by whether the two labelled
//     players overlap in the picture (the hard case for telling them apart)
// --show n writes the n worst frames with overlays to /tmp/squash/pbox (red: label, green: ours).
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import { readImage, writeImage, line, drawCourt } from './nodeimg.js';
import { detectCourt } from '../detect.js';
import { detectPlayers } from '../players.js';
import { loadLabels, TBOX_WORLD, homography, applyH, iou, greedyMatch } from './squashai.js';

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const data = opt('--data', '/tmp/squash/squashai'), SELF = fileURLToPath(import.meta.url);
const labels = loadLabels(`${data}/datasets`).filter((l) => !opt('--video') || l.video === opt('--video'));

// ---------- one frame ----------
function evalFrame(lab, draw = false) {
  const img = readImage(`${data}/${lab.file}`), s = 1280 / img.width;
  const t0 = performance.now(), r = detectCourt(img.data, img.width, img.height), tc = performance.now() - t0;
  const out = { file: lab.file, video: lab.video, ok: !!r.ok, msCourt: tc, labels: lab.boxes.length, found: [], ours: 0 };
  if (!r.ok || !r.cam) return out;
  const cam = r.cam, t1 = performance.now(), P = detectPlayers(img.data, img.width, img.height, cam).players; out.msPlayers = performance.now() - t1;
  out.ours = P.length;
  // does the label T-box describe this frame? (worst corner, px at 1280 wide)
  out.tboxErr = Math.max(...TBOX_WORLD.map((X, i) => { const u = cam.project([X[0], X[1], 0]); return Math.hypot(u[0] - lab.tbox[i][0], u[1] - lab.tbox[i][1]) * s; }));
  const H = out.tboxErr < 10 ? homography(lab.tbox, TBOX_WORLD) : null;
  const feetIn = (b, f) => { const h = b[3] - b[1]; return f[0] >= b[0] && f[0] <= b[2] && f[1] >= b[3] - 0.25 * h && f[1] <= b[3] + 0.1 * h; };
  const footOf = (b) => [(b[0] + b[2]) / 2, b[3]];
  const M = greedyMatch(lab.boxes, P, (b, p) => (feetIn(b, p.foot) ? 1 - Math.hypot(p.foot[0] - footOf(b)[0], p.foot[1] - footOf(b)[1]) / (b[3] - b[1]) : -1), 0 - 1e-9);
  const overlap = lab.boxes.length === 2 && iou(lab.boxes[0], lab.boxes[1]) > 0;
  out.boxes = lab.boxes.map((b, i) => {
    const m = M.find((x) => x[0] === i), h = b[3] - b[1], e = { h: h * s, overlap, found: !!m };
    if (m) {
      const p = P[m[1]], f = footOf(b);
      e.feetPx = Math.hypot(p.foot[0] - f[0], p.foot[1] - f[1]) * s; e.feetRel = e.feetPx / (h * s); e.iou = iou(b, p.box);
      if (H) { const g = applyH(H, f); e.floorCm = Math.hypot(p.X[0] - g[0], p.X[1] - g[1]) * 100; }
    }
    return e;
  });
  out.false = P.length - M.length;
  // looser: the person found at all (boxes overlap), however far off the feet are
  const MI = greedyMatch(lab.boxes, P, (b, p) => iou(b, p.box), 0.3);
  for (const [i] of MI) out.boxes[i].person = true;
  if (draw) {
    drawCourt(img, cam, { thick: 1 });
    const rect = (b, c) => { line(img, b[0], b[1], b[2], b[1], c, 2); line(img, b[2], b[1], b[2], b[3], c, 2); line(img, b[2], b[3], b[0], b[3], c, 2); line(img, b[0], b[3], b[0], b[1], c, 2); };
    for (const b of lab.boxes) rect(b, [255, 40, 40]);
    for (const p of P) { rect(p.box, [40, 255, 40]); line(img, p.foot[0] - 10, p.foot[1], p.foot[0] + 10, p.foot[1], [40, 255, 40], 3); }
    mkdirSync('/tmp/squash/pbox', { recursive: true }); writeImage(`/tmp/squash/pbox/${lab.file.split('/').pop()}`, img);
  }
  return out;
}

// ---------- worker: every n-th frame from i, JSON lines on stdout ----------
if (opt('--part')) {
  const [i0, n] = opt('--part').split('/').map(Number);
  for (let i = i0; i < labels.length; i += n) process.stdout.write(JSON.stringify(evalFrame(labels[i])) + '\n');
  process.exit(0);
}

// ---------- parent ----------
const jobs = +opt('--jobs', Math.max(1, Math.min(48, os.cpus().length - 2))), t0 = performance.now();
const R = (await Promise.all(Array.from({ length: jobs }, (_, j) => new Promise((ok, no) => {
  let buf = ''; const p = spawn(process.execPath, [SELF, ...args, '--part', `${j}/${jobs}`], { stdio: ['ignore', 'pipe', 'inherit'] });
  p.stdout.on('data', (c) => (buf += c)); p.on('exit', (c) => (c ? no(new Error(`worker ${j} exited ${c}`)) : ok(buf.trim() ? buf.trim().split('\n').map((l) => JSON.parse(l)) : [])));
})))).flat();

const q = (a, p) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(0)}%` : '-');
function summary(F) {
  const B = F.flatMap((f) => f.boxes ?? []), all = F.reduce((s, f) => s + f.labels, 0), got = B.filter((b) => b.found);
  const fl = got.map((b) => b.floorCm).filter((v) => v != null);
  return {
    person: B.filter((b) => b.person).length,
    frames: F.length, courtOk: F.filter((f) => f.ok).length, labelled: all, onCourtFrames: B.length, found: got.length,
    recall: all ? got.length / all : NaN, recallOnCourt: B.length ? got.length / B.length : NaN,
    falsePlayers: F.reduce((s, f) => s + (f.false ?? 0), 0),
    feetPx: [q(got.map((b) => b.feetPx), 0.5), q(got.map((b) => b.feetPx), 0.9)], feetRel: [q(got.map((b) => b.feetRel), 0.5), q(got.map((b) => b.feetRel), 0.9)],
    iou: q(got.map((b) => b.iou), 0.5), floorCm: { n: fl.length, median: q(fl, 0.5), p90: q(fl, 0.9) },
  };
}
const row = (name, s) => console.log(`${name.padEnd(16)} ${String(s.frames).padStart(5)} ${pct(s.courtOk, s.frames).padStart(5)} ${String(s.labelled).padStart(6)} ${pct(s.found, s.labelled).padStart(6)} ${pct(s.found, s.onCourtFrames).padStart(8)} ${pct(s.person, s.onCourtFrames).padStart(7)} ${String(s.falsePlayers).padStart(6)} ${s.feetPx[0].toFixed(0).padStart(5)} ${s.feetPx[1].toFixed(0).padStart(4)} ${(s.feetRel[0] * 100).toFixed(1).padStart(5)} ${s.iou.toFixed(2).padStart(5)} ${(s.floorCm.n ? `${s.floorCm.median.toFixed(0)}/${s.floorCm.p90.toFixed(0)} (${s.floorCm.n})` : '-').padStart(14)}`);
console.log(`SquashAI player boxes: ${R.length} frames from ${data}, ${((performance.now() - t0) / 1000).toFixed(0)} s on ${jobs} processes`);
console.log(`${''.padEnd(16)} ${'frames'.padStart(5)} ${'court'.padStart(5)} ${'boxes'.padStart(6)} ${'recall'.padStart(6)} ${'r|court'.padStart(8)} ${'IoU>.3'.padStart(7)} ${'false'.padStart(6)} ${'feet px'.padStart(5)} ${'p90'.padStart(4)} ${'%h'.padStart(5)} ${'IoU'.padStart(5)} ${'floor cm/p90'.padStart(14)}`);
const S = { all: summary(R), videos: {}, byHeight: {}, overlap: {} };
for (const v of [...new Set(R.map((f) => f.video))].sort()) { S.videos[v] = summary(R.filter((f) => f.video === v)); row(v, S.videos[v]); }
row('ALL', S.all);
// by labelled box height and overlap: recall over boxes on court-fitted frames
const sub = (name, pred) => { const B = R.flatMap((f) => f.boxes ?? []).filter(pred), g = B.filter((b) => b.found); console.log(`  ${name.padEnd(28)} ${String(B.length).padStart(5)} boxes, found ${pct(g.length, B.length).padStart(4)} (IoU > 0.3: ${pct(B.filter((b) => b.person).length, B.length).padStart(4)}), feet ${(q(g.map((b) => b.feetRel), 0.5) * 100).toFixed(1)}% of height`); return { boxes: B.length, found: g.length }; };
console.log('\non frames with a fitted court:');
S.byHeight.far = sub('far (box < 200 px tall)', (b) => b.h < 200); S.byHeight.mid = sub('mid (200-320 px)', (b) => b.h >= 200 && b.h < 320); S.byHeight.near = sub('near (>= 320 px)', (b) => b.h >= 320);
S.overlap.yes = sub('the two boxes overlap', (b) => b.overlap); S.overlap.no = sub('apart', (b) => !b.overlap);
const ms = R.filter((f) => f.msPlayers != null);
console.log(`\ntimings per 1280x720 frame: court median ${q(R.map((f) => f.msCourt), 0.5).toFixed(0)} ms, players median ${q(ms.map((f) => f.msPlayers), 0.5).toFixed(0)} ms`);
if (opt('--json')) { writeFileSync(opt('--json'), JSON.stringify({ summary: S, frames: R }, null, 1)); console.log(`wrote ${opt('--json')}`); }
const show = +opt('--show', 0);
if (show) {
  const worst = R.filter((f) => f.ok && f.boxes?.some((b) => !b.found)).sort((a, b) => b.boxes.filter((x) => !x.found).length - a.boxes.filter((x) => !x.found).length || (b.false ?? 0) - (a.false ?? 0)).slice(0, show);
  for (const f of worst) evalFrame(labels.find((l) => l.file === f.file), true);
  console.log(`wrote ${worst.length} overlays to /tmp/squash/pbox`);
}

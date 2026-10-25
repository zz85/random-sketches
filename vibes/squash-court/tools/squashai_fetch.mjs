// node tools/squashai_fetch.mjs [dir]   (default /tmp/squash/squashai)
// Fetches the SquashAI labels (git clone of github.com/squashai/datasets), the 8 PSA videos they
// refer to (~870 MB, the URLs in each <id>.json) and extracts the 1,253 labelled frames as
// <dir>/media/images/<id>-<ms>.jpg, named as the dataset's own scripts/build.py names them.
// Already-present files are kept. The videos are PSA's footage: keep them local, out of the repo.
import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs';
import os from 'os';

const dir = process.argv[2] || '/tmp/squash/squashai', lab = `${dir}/datasets`;
mkdirSync(`${dir}/media/videos`, { recursive: true }); mkdirSync(`${dir}/media/images`, { recursive: true });
if (!existsSync(lab)) execFileSync('git', ['clone', '-q', '--depth', '1', 'https://github.com/squashai/datasets', lab], { stdio: 'inherit' });

const run = (cmd, a) => new Promise((ok, no) => { const p = spawn(cmd, a, { stdio: ['ignore', 'ignore', 'inherit'] }); p.on('exit', (c) => (c ? no(new Error(`${cmd} exited ${c}`)) : ok())); });
async function pool(jobs, n) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < jobs.length) await jobs[i++](); })); }

const sets = readdirSync(lab).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(`${lab}/${f}`, 'utf8')));
await pool(sets.map((d) => async () => {
  const v = `${dir}/media/videos/${d.source.name}`;
  if (existsSync(v)) return;
  console.log(`downloading ${d.source.name}`);
  await run('curl', ['-sSfL', '--retry', '3', '-o', v + '.part', d.source.url]);
  execFileSync('mv', [v + '.part', v]);
}), 4);

// frame names as build.py: the time in ms, zero-padded to the widest time in that video
const frames = [];
for (const d of sets) {
  const id = d.source.name.replace(/\.[^.]*$/, ''), tl = Math.max(1, ...d.labels.filter((l) => l.time > 0).map((l) => Math.floor(Math.log10(l.time * 1000)) + 1));
  for (const l of d.labels) { const ms = Math.floor(l.time * 1000), out = `${dir}/media/images/${id}-${String(ms).padStart(tl, '0')}.jpg`; if (!existsSync(out)) frames.push({ v: `${dir}/media/videos/${d.source.name}`, t: l.time, out }); }
}
console.log(`extracting ${frames.length} frames`);
await pool(frames.map((f) => () => run('ffmpeg', ['-v', 'error', '-ss', String(f.t), '-i', f.v, '-frames:v', '1', '-q:v', '2', f.out])), Math.max(2, os.cpus().length - 2));
const n = readdirSync(`${dir}/media/images`).length;
console.log(`${n} frames in ${dir}/media/images`);

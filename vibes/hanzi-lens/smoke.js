// Headless end-to-end check over CDP (zero deps): the sample photo through the real UI and
// worker (ONNX Runtime WASM, models from Hugging Face), recognition accuracy against
// sample.json, pinyin and meanings, the sheet, the live camera loop on a fake camera that
// shows the sample, and an offline reload through the service worker.
//   node smoke.js        (CHROME=/path/to/chrome to override; needs network on first run)
// Writes smoke_*.png. ffmpeg (for the fake camera's video file) is optional.
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(DIR);
const PORT = 8812;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.gz': 'application/gzip', '.webmanifest': 'application/manifest+json', '.css': 'text/css' };
let offline = false;
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u);
  if (offline || !f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(offline ? 503 : 404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

function editDistance(a, b) {
  a = [...a]; b = [...b];
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// the fake camera: the sample photo as a short y4m clip, panning a little then holding still
let camArgs = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
const y4m = path.join(os.tmpdir(), 'hanzi-lens-cam.y4m');
try {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', path.join(DIR, 'sample.jpg'), '-t', '4', '-r', '10',
    '-vf', "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720", '-pix_fmt', 'yuv420p', y4m]);
  camArgs.push(`--use-file-for-fake-video-capture=${y4m}`);
} catch { console.log('(no ffmpeg: the fake camera shows Chrome\'s test pattern)'); }

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const b = await launch({ port: 9367, width: 1000, height: 760, args: camArgs });
  const errors = [];
  const collect = () => {
    for (const e of b.events.splice(0)) {
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') errors.push(e.params.args.map((a) => a.value || a.description).join(' '));
      if (e.method === 'Runtime.exceptionThrown') errors.push(e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
    }
  };
  const shot = async (name) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, `smoke_${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const tap = (sel) => b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true})()`);
  try {
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/hanzi-lens/` });
    await waitFor(() => b.evaluate('!!window.__hl'), 10000);
    check('start screen', await b.evaluate(`!document.getElementById('start').hidden`));
    await shot('start');
    check('install button and dictionary on the start screen', await b.evaluate(`!!document.querySelector('#start [data-pwa-install]') && !!document.getElementById('dictBtn2')`));
    check('page zoom locked', await b.evaluate(`/user-scalable=no/.test(document.querySelector('meta[name=viewport]').content)`));
    // ---- the dictionary pane ----
    await tap('#dictBtn2');
    const look = async (q) => { await b.evaluate(`(()=>{const i=document.getElementById('dictInput'); i.value=${JSON.stringify(q)}; i.dispatchEvent(new Event('input'))})()`); await sleep(100); await waitFor(() => b.evaluate(`!!__hl.S.dict && document.querySelectorAll('#words .word').length>0 && __hl.S.tokens.length>0 && document.getElementById('sheetPinyin').textContent.includes(${JSON.stringify(q)})`), 30000); return b.evaluate(`[...document.querySelectorAll('#words .word .hz')].slice(0,3).map(e=>e.textContent)`); };
    const r1 = await look('银行'), r2 = await look('nihao'), r3 = await look('chicken');
    check('dictionary looks up Chinese, pinyin and English', r1[0] === '银行' && r2[0] === '你好' && r3[0] === '鸡', [r1[0], r2[0], r3[0]].join(' / '));
    await tap('#words .word');
    check('a result opens all its meanings', await b.evaluate(`!!document.querySelector('#words .word.open .more')`));
    await shot('dict');
    await tap('#closeBtn');
    check('closing the dictionary leaves the start screen', await b.evaluate(`document.getElementById('sheet').hidden && !document.getElementById('start').hidden && document.getElementById('dictInput').hidden`));
    // CPU by default; the GPU box is a choice kept on the device (unticked again before the read)
    const box = await b.evaluate(`(()=>{const g=document.getElementById('gpuBox'); const before=g.checked; if (g.disabled) return {before, disabled:true}; g.click(); const kept=localStorage.getItem('hanzi-lens-ep'); g.click(); return {before, kept, after:localStorage.getItem('hanzi-lens-ep')}})()`);
    check('CPU by default, GPU box kept on the device', box.before === false && (box.disabled || (box.kept === 'webgpu' && box.after === 'wasm')), JSON.stringify(box));

    // ---- a photo: the sample ----
    const t0 = Date.now();
    await tap('#sampleBtn');
    await waitFor(() => b.evaluate(`__hl.S.view==='frozen' && __hl.S.frozen.lines.length>0 && !document.getElementById('shutter').classList.contains('busy')`), 180000);
    const got = await b.evaluate(`__hl.S.frozen.lines.map(l=>({text:l.text, conf:l.confidence, vertical:l.vertical, py:l.ann?l.ann.charPinyin:null}))`);
    console.log(`     read in ${((Date.now() - t0) / 1000).toFixed(1)} s (first load included), ep ${await b.evaluate('__hl.S.ep')}, worker ${await b.evaluate('__hl.S.frozen.ms')} ms`);
    for (const g of got) console.log(`     ${g.vertical ? '|' : '-'} ${g.text}  (${Math.round(g.conf * 100)}%)`);
    const truth = JSON.parse(fs.readFileSync(path.join(DIR, 'sample.json'), 'utf8')).lines;
    let errs = 0, total = 0;
    for (const t of truth) {
      const best = Math.min(...got.map((g) => editDistance(g.text.replace(/\s/g, ''), t.replace(/\s/g, ''))));
      errs += Math.min(best, [...t.replace(/\s/g, '')].length); total += [...t.replace(/\s/g, '')].length;
    }
    const cer = errs / total;
    check('character error rate on the sample', cer <= 0.03, `${(cer * 100).toFixed(1)}% (${errs}/${total})`);
    check('every line found', got.length >= truth.length - 1, `${got.length} found, ${truth.length} expected`);
    check('vertical column read as vertical', got.some((g) => g.vertical && g.text.replace(/\s/g, '') === '欢迎光临'));
    const gb = got.find((g) => g.text.includes('宫保鸡丁'));
    check('pinyin per character', gb && gb.py.slice(0, 4).join(' ') === 'gōng bǎo jī dīng', gb ? gb.py.join(' ') : '');
    const price = got.find((g) => /^28/.test(g.text));
    check('prices read as numbers', price && price.py[0] === 'èrshíbā', price ? price.py.join(' ') : '');
    check('pinyin labels drawn', (await b.evaluate(`document.querySelectorAll('#labels .py').length`)) >= 30);
    await shot('frozen');

    // ---- tap a line: the sheet ----
    const pt = await b.evaluate(`(()=>{const p=[...document.querySelectorAll('#boxes polygon')].find((p,i)=>__hl.S.frozen.lines[+p.dataset.i].text.includes('红烧牛肉面'));const r=p.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x: pt[0], y: pt[1], button: 'left', clickCount: 1 });
    await sleep(200);
    const sheet = await b.evaluate(`({open:!document.getElementById('sheet').hidden, words:[...document.querySelectorAll('#words .word .hz')].map(e=>e.textContent), py:document.getElementById('sheetPinyin').textContent})`);
    check('tapping a line opens its words', sheet.open && sheet.words.length >= 2, `${sheet.words.join('/')} ${sheet.py}`);
    await tap('#words .word');
    await sleep(100);
    check('a word opens all its meanings', await b.evaluate(`!!document.querySelector('#words .word.open .more .ent')`));
    await shot('sheet');
    await tap('#listBtn');
    await sleep(100);
    check('all the text', (await b.evaluate(`document.querySelectorAll('#words .list-line').length`)) === got.length);
    await shot('list');
    await tap('#closeBtn');

    // ---- crash trace: a finished read ends in 'done'; a cut-off one shows on the next load ----
    await sleep(2300);
    const tr = await b.evaluate(`JSON.parse(localStorage.getItem('hl-trace')).steps`);
    check('crash trace records the read and keeps beating after it', tr.some((x) => /worker: detect/.test(x)) && /alive \d+s after the read$/.test(tr[tr.length - 1]), tr.slice(-3).join(' | '));
    // a crash fires no pagehide: fake one from another page of the same origin
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/hanzi-lens/sample.json` });
    await sleep(300);
    await b.evaluate(`(()=>{const t=JSON.parse(localStorage.getItem('hl-trace'));t.steps.push('9.9s worker: read line 11/15');localStorage.setItem('hl-trace',JSON.stringify(t));return 1})()`);
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/hanzi-lens/` });
    await waitFor(() => b.evaluate('!!window.__hl'), 10000);
    check('a cut-off trace shows on the next load', await b.evaluate(`!document.getElementById('crash').hidden && document.querySelector('#crash pre').textContent.includes('read line 11/15')`));
    await shot('crash');

    // ---- live camera ----
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/hanzi-lens/` });
    await waitFor(() => b.evaluate('!!window.__hl'), 10000);
    await tap('#camBtn');
    await waitFor(() => b.evaluate(`__hl.S.view==='live'`), 60000);
    let liveText = [];
    try {
      await waitFor(async () => (liveText = await b.evaluate(`__hl.S.tracks.filter(t=>t.text).map(t=>t.text)`)).length >= 5, 60000);
    } catch { /* reported below */ }
    const frames = await b.evaluate('__hl.S.frame');
    check('live view finds and reads lines', liveText.length >= 5, `${liveText.length} read after ${frames} frames: ${liveText.slice(0, 6).join(' / ')}`);
    await sleep(500);
    await shot('live');
    await tap('#shutter');
    await waitFor(() => b.evaluate(`__hl.S.view==='frozen' && !document.getElementById('shutter').classList.contains('busy')`), 60000);
    check('shutter freezes and reads the frame', (await b.evaluate(`__hl.S.frozen.lines.length`)) >= 8);
    await tap('#shutter');
    check('shutter again returns to live', await b.evaluate(`__hl.S.view==='live'`));

    // ---- offline ----
    await waitFor(() => b.evaluate(`navigator.serviceWorker.controller!==null || navigator.serviceWorker.ready.then(()=>true)`), 15000);
    await sleep(1000);
    offline = true;
    await b.send('Network.enable');
    await b.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/hanzi-lens/` });
    await waitFor(() => b.evaluate('!!window.__hl'), 15000);
    await tap('#sampleBtn');
    let offlineOk = false;
    try { await waitFor(() => b.evaluate(`__hl.S.view==='frozen' && __hl.S.frozen.lines.length>0`), 120000); offlineOk = true; } catch { /* below */ }
    check('works offline after the first run', offlineOk);

    collect();
    const real = errors.filter((e) => !/WebGPU|powerPreference/i.test(e));
    check('no console errors', real.length === 0, real.slice(0, 3).join(' | '));
  } catch (err) {
    collect();
    check('run', false, err.stack + '\n' + errors.join('\n'));
  } finally {
    b.kill(); server.close();
    console.log(failed ? `${failed} failed` : 'all passed');
    process.exit(failed ? 1 : 0);
  }
})();

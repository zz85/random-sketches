// Headless check of the yolk game over CDP (as smoke.js): it loads with no console or shader errors, the yolk lies
// in the shell intact, a careful carry at a middling grip gets it into the bowl and wins, a yank bursts it, a grip
// too light lets it slip, and letting go in mid-air drops it. Screenshots go to /tmp/membrane-shots (OUT=dir).
//   node smoke_yolk.js
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(DIR, '..'), PORT = 8864, OUT = process.env.OUT || '/tmp/membrane-shots';
fs.mkdirSync(OUT, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(ROOT, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(res);
});
let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const b = await launch({ port: 9398, width: 1280, height: 800 });
  const E = (s) => b.evaluate(s);
  const shot = async (name) => { await E('__yolk.snapshot()'); const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64')); };
  const errors = () => b.events.filter((e) => (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) || e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || e.params.args?.map((a) => a.value ?? a.description).join(' ')).filter((s) => !/GPU stall|Automatic fallback/.test(s || ''));
  try {
    const t0 = Date.now();
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/membrane/yolk.html?shot&offscreen&paused&seed=3` });
    await waitFor(() => E('!!window.__yolk || /needs WebGPU/.test(document.body.innerText)'), 300000);
    console.log(`     loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${await E('__yolk.world.sim.N')} vertices`);
    // a scripted carry: pinch the top at `grip`, then go through `path` (points relative to the pinch, or 'bowl'
    // for above the bowl, each with its frames), lower until the bowl takes the weight if `lower`, then let go
    await E(`window.carry = async (grip, path, { lower = false, release = true } = {}) => {
      const Y = __yolk; Y.rebuild(3); await Y.steps(20); const w = Y.world; Y.setGrip(grip); const t = Y.grabTop(); let tip = t.slice();
      const ease = (k) => k * k * (3 - 2 * k);
      for (const [to, frames] of path) {
        const from = tip.slice(), dest = to === 'bowl' ? [Y.BOWL.x, tip[1], Y.BOWL.z] : [t[0] + to[0], t[1] + to[1], t[2] + to[2]];
        for (let f = 1; f <= frames && !w.done; f++) { const k = ease(f / frames); tip = from.map((v, i) => v + (dest[i] - v) * k); Y.moveTo(...tip); await Y.steps(1, false); await Y.read(); }
      }
      if (lower) for (let f = 0; f < 300 && w.fw > 0.25 && !w.done; f++) { tip[1] -= 0.02; Y.moveTo(...tip); await Y.steps(1, false); await Y.read(); }
      if (release && !w.done) { Y.endGrab(); for (let f = 0; f < 150 && !w.done; f++) { await Y.steps(1, false); await Y.read(); } }
      return { result: w.done ? Y.result : null, peak: +w.peak.toFixed(2), burst: w.burst, slip: +w.slip.toFixed(2), inBowl: Y.inBowl() };
    }; 1`);
    await E('__yolk.steps(30)'); await sleep(200);
    const er = errors();
    check('loads without console or shader errors', er.length === 0, er.slice(0, 4).join(' | ').slice(0, 2000));
    const c = await E('__yolk.world.sim.readCounters().then((c) => Array.from(c))');
    check('the yolk lies in the shell intact', c[0] === 0 && c[1] < 400, JSON.stringify(c));
    await shot('yolk_rest');
    const ok = await E(`carry(0.4, [[[0, 4.2, 0], 80], ['bowl', 110]], { lower: true, release: false })`);
    await shot('yolk_carry');
    const won = await E(`(async () => { const Y = __yolk, w = Y.world; Y.endGrab(); for (let f = 0; f < 150 && !w.done; f++) { await Y.steps(1, false); await Y.read(); } return { result: Y.result, inBowl: Y.inBowl() }; })()`);
    check('a careful carry at 40% grip, lowered into the bowl, wins', won.result && !won.result.lost && won.inBowl, JSON.stringify({ ...ok, ...won }));
    await shot('yolk_bowl');
    const yank = await E(`carry(0.45, [[[0, 4, 0], 10]], { release: false })`);
    check('a yank bursts it', yank.result?.lost && yank.burst, JSON.stringify(yank));
    for (let k = 0; k < 40; k++) await E('__yolk.steps(1, false)');
    await shot('yolk_burst');
    const tight = await E(`carry(0.95, [[[0, 4, 0], 120], [[0, 4, 0], 60]], { release: false })`);
    check('a grip too tight bursts it', tight.result?.lost && tight.burst, JSON.stringify(tight));
    const light = await E(`carry(0.12, [[[0, 4, 0], 120], [[0, 4, 0], 120]], { release: false })`);
    check('a grip too light lets it slip', light.result?.lost && !light.burst && light.result.title === 'Dropped', JSON.stringify(light));
    const drop = await E(`carry(0.4, [[[0, 4, 0], 80], ['bowl', 110]])`);
    check('letting go in mid-air drops it', drop.result?.lost && drop.result.title === 'Dropped', JSON.stringify(drop));
    await shot('yolk_drop');
    const er2 = errors();
    check('no errors along the way', er2.length === 0, er2.slice(0, 4).join(' | ').slice(0, 1000));
  } catch (e) { console.log('FAIL', e.message); failed++; }
  b.kill(); server.close();
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})();

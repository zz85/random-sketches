// Headless render check over the Chrome DevTools protocol, zero npm deps.
// Renders a few fixed shots (still frames, fixed time) with SwiftShader, fails on any
// shader/console error or a blank frame, and writes shot_*.png next to this file.
//   node smoke.js            (CHROME=/path/to/chrome to override, ONLY=name to run one)
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// newest Playwright Chromium found in any of the usual browser folders, unless CHROME is set
// (version folders change when Playwright updates, and an install elsewhere can delete
// the ones it doesn't use, so every folder is searched)
const PWS = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(process.env.HOME, '.cache/ms-playwright'), path.join(process.env.HOME, '.local/share/ms-playwright')].filter((d) => d && fs.existsSync(d));
const CHROME = process.env.CHROME || PWS.flatMap((pw) => fs.readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).map((d) => [+d.split('-')[1], pw, d]))
  .sort((a, b) => b[0] - a[0]).flatMap(([, pw, d]) => ['chrome-linux', 'chrome-linux64', 'chrome-linux-arm64'].map((p) => path.join(pw, d, p, 'chrome')))
  .find((f) => fs.existsSync(f)) || 'chromium';
const PORT = 8811, CDP = 9351;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return new Promise((res) => { ws.onopen = () => res({ send, events, close: () => ws.close() }); });
}

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(DIR, u === '/' ? 'index.html' : u);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, '127.0.0.1');

const SHOTS = [
  ['afternoon', 'time=0.75&az=55&shot=hillside&t=20'],
  ['golden', 'time=2&az=35&shot=hillside&t=20'],
  ['magic', 'time=3&az=40&shot=wide&t=20&style=sakura'],
  ['under', 'time=1&az=10&shot=under&t=20&style=autumn'],
  ['autumn', 'time=1.3&az=-60&shot=wide&t=20&style=autumn'],
  ['autumn2', 'time=1&az=150&shot=hillside&t=20&style=autumn'],
  ['night', 'time=4&shot=path&t=20'],
  ['sky', 'time=0.75&az=55&shot=sky&t=20'],
  ['late', 'time=1&az=150&shot=hillside&t=20&style=autumn&turned=1'],
  ['dayanim', 'anim=day&p=0.55&az=35&shot=hillside&t=20'],
  ['blossom', 'season=0.15&time=1&az=150&shot=hillside&t=20'],
  ['shedding', 'season=0.76&time=1.3&az=-60&shot=wide&t=20'],
  ['winter', 'season=0.95&time=1&az=150&shot=hillside&t=20'],
  ['zoomday', 'anim=zoom&p=0.42&hour=7&season=0.77&clock=1&az=55&shot=hillside&t=20'],
  ['zoommonth', 'anim=zoom&p=1&hour=7&season=0.77&clock=1&az=55&shot=hillside&t=20'],
  ['dense', 'time=0.75&az=55&shot=hillside&t=20&airy=0'],
  ['flyover', 'time=1.3&az=-60&shot=wide&t=20'],
  ['raw', 'time=0.75&az=55&shot=hillside&t=20&paint=0'],
].filter(([n]) => !process.env.ONLY || process.env.ONLY.split(',').includes(n));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
try {
  let tabs; for (let i = 0; i < 50; i++) { try { tabs = await getJson(`http://127.0.0.1:${CDP}/json`); if (tabs.length) break; } catch { /* starting */ } await sleep(200); }
  const tab = tabs.find((t) => t.type === 'page');
  const c = await cdp(tab.webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable'); await c.send('Log.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  for (const [name, qs] of SHOTS) {
    c.events.length = 0;
    const t0 = Date.now();
    await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?still=1&noui=1&pr=1&${qs}` });
    let ready = false;
    for (let i = 0; i < 600 && !ready; i++) { await sleep(250); const r = await c.send('Runtime.evaluate', { expression: '!!window.__ready' }); ready = r.result?.result?.value; }
    const errs = c.events.filter((e) => (e.method === 'Runtime.exceptionThrown') || (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
      .map((e) => (e.params.args?.[0]?.value || e.params.exceptionDetails?.exception?.description || e.params.entry?.text || JSON.stringify(e.params)).slice(0, 700));
    const stats = await c.send('Runtime.evaluate', { returnByValue: true, expression: `(() => { const g = document.querySelector('canvas').getContext('webgl2'); const W = g.drawingBufferWidth, H = g.drawingBufferHeight; const px = new Uint8Array(W * H * 4); g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, px); let s = 0, s2 = 0, n = 0; for (let i = 0; i < px.length; i += 4 * 97) { const l = (px[i] + px[i + 1] + px[i + 2]) / 3; s += l; s2 += l * l; n++; } const m = s / n; return { mean: m, sd: Math.sqrt(s2 / n - m * m), grass: window.__sorairo?.grass.count, cards: window.__sorairo?.tree.cards }; })()` });
    const st = stats.result?.result?.value || {};
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(DIR, `shot_${name}.png`), Buffer.from(shot.result.data, 'base64'));
    const ok = ready && !errs.length && st.sd > 8;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(10)} ${((Date.now() - t0) / 1000).toFixed(1)}s mean ${st.mean?.toFixed(0)} sd ${st.sd?.toFixed(0)} grass ${st.grass} cards ${st.cards}`);
    for (const e of errs) console.log('     ', e);
  }
  // animations run live: progress advances, the season drives the scene, no errors
  if (!process.env.ONLY || process.env.ONLY.split(',').includes('anims')) {
    const t0 = Date.now(); const res = [];
    for (const m of ['day', 'year', 'zoom']) {
      c.events.length = 0;
      await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?noui=1&pr=0.25&anim=${m}&dur=6&p=0.8` });
      for (let i = 0; i < 120; i++) { await sleep(250); const r = await c.send('Runtime.evaluate', { expression: '!!window.__ready' }); if (r.result?.result?.value) break; }
      const camAt = "window.__sorairo.camera.position.toArray()";
      const p0 = (await c.send('Runtime.evaluate', { returnByValue: true, expression: camAt })).result?.result?.value;
      await sleep(3500);
      const v = (await c.send('Runtime.evaluate', { returnByValue: true, expression: `[window.__sorairo.AN.progress, window.__sorairo.S.time, ${camAt}]` })).result?.result?.value;
      const moved = v && p0 ? Math.hypot(...v[2].map((x, i) => x - p0[i])) : 0;
      const errs = c.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
      // started at 0.8 with a 6 s loop: it must have moved on (and possibly wrapped)
      res.push([m, v && Math.abs(v[0] - 0.8) > 0.005 && moved > 0.001 && !errs.length, v, moved, errs.map((e) => JSON.stringify(e.params).slice(0, 300))]);
    }
    const ok = res.every((r) => r[1]);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${'anims'.padEnd(10)} ${((Date.now() - t0) / 1000).toFixed(1)}s ` + res.map((r) => `${r[0]} p ${r[2]?.[0]?.toFixed(2)} cam moved ${r[3].toFixed(3)} m`).join(', '));
    for (const r of res) for (const e of r[4]) console.log('     ', e);
  }
  // sound: render the audio graph offline for day, dusk and night; fail on silence,
  // NaN or clipping
  if (!process.env.ONLY || process.env.ONLY.split(',').includes('audio')) {
    const t0 = Date.now();
    if (!SHOTS.length) { await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?still=1&noui=1&pr=0.25` }); await sleep(3000); }
    const r = await c.send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async () => {
      const { makeAudio } = await import('./audio.js');
      const out = {};
      for (const [name, s] of [['day', { day: 1, night: 0, dusk: 0, trail: 1, flock: 1 }], ['dusk', { day: 0.7, night: 0, dusk: 1 }], ['night', { day: 0, night: 1, dusk: 0 }]]) {
        const SR = 22050, T = 14, ctx = new OfflineAudioContext(2, SR * T, SR), a = makeAudio(ctx);
        a.setOn(true); a.update({ wind: 1.2, music: 0.6, amb: 0.8, leaves: 1, trail: 0, flock: 0, ...s }, 5); a.schedule(T);
        const b = await ctx.startRendering(); let s2 = 0, pk = 0, bad = 0, n = 0, hi = 0, hp = 0;
        for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = SR * 3; i < d.length; i++) { const v = d[i]; if (!isFinite(v)) bad++; s2 += v * v; pk = Math.max(pk, Math.abs(v)); hi += (v - hp) * (v - hp); hp = v; n++; } }
        out[name] = { rms: Math.sqrt(s2 / n), peak: pk, bad, bright: Math.sqrt(hi / n) };
      }
      return out; })()` });
    // live path: the button starts the real AudioContext and frames keep running
    c.events.length = 0;
    await c.send('Runtime.evaluate', { userGesture: true, expression: "document.getElementById('sound').click()" });
    await sleep(1500);
    const live = await c.send('Runtime.evaluate', { returnByValue: true, expression: "for (let i = 0; i < 5; i++) window.__sorairo.frame(0.016); [document.getElementById('sound').textContent, window.__sorairo.S.sound]" });
    const liveErrs = c.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'));
    const liveOk = live.result?.result?.value?.[1] === true && !liveErrs.length;
    if (!liveOk) console.log('      live sound:', JSON.stringify(live.result?.result?.value), liveErrs.map((e) => JSON.stringify(e.params).slice(0, 300)));
    const v = r.result?.result?.value, err = r.result?.exceptionDetails?.exception?.description;
    const ok = liveOk && v && Object.values(v).every((x) => x.rms > 0.01 && x.peak < 1 && !x.bad);
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${'audio'.padEnd(10)} ${((Date.now() - t0) / 1000).toFixed(1)}s ` + (v ? Object.entries(v).map(([k, x]) => `${k} rms ${x.rms.toFixed(3)} peak ${x.peak.toFixed(2)}`).join(', ') : err));
  }
  c.close();
} finally { chrome.kill(); server.close(); }
process.exit(failed ? 1 : 0);

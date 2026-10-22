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
// newest Playwright Chromium unless CHROME is set (the version folder changes when Playwright updates)
const PW = path.join(process.env.HOME, '.cache/ms-playwright');
const CHROME = process.env.CHROME || (fs.existsSync(PW) && fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
  .map((d) => path.join(PW, d, 'chrome-linux/chrome')).find((f) => fs.existsSync(f))) || 'chromium';
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
  c.close();
} finally { chrome.kill(); server.close(); }
process.exit(failed ? 1 : 0);

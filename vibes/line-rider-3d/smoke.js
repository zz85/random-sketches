// Headless check over the Chrome DevTools protocol, zero npm deps (same harness as Sorairo).
// Renders shots of the demo track with SwiftShader, draws a stroke with synthetic mouse events on an
// empty track and checks the rider lands on it, fails on any console error or blank frame.
//   node smoke.js            (CHROME=/path/to/chrome to override, ONLY=name to run one)
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
// newest Playwright Chromium in the cache unless CHROME is set
const PW = path.join(process.env.HOME, '.cache/ms-playwright');
const CHROME = process.env.CHROME || (fs.existsSync(PW) && fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => +b.split('-')[1] - +a.split('-')[1])
  .map((d) => path.join(PW, d, 'chrome-linux/chrome')).find((f) => fs.existsSync(f))) || 'chromium';
const PORT = 8823, CDP = 9363;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.json': 'application/json' };
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
  ['overview', 't=0&v3d=1'],
  ['side', 't=0&noui=0'],
  ['side_loop', 't=5.4&view=follow'],
  ['side_jump', 't=7.7&view=follow'],
  ['side_turn', 't=10.6&view=follow'],
  ['side_finish', 't=17&view=follow'],
  ['drop', 't=4.3&view=chase&v3d=1'],
  ['loop', 't=5.45&view=follow&v3d=1'],
  ['turn', 't=10.4&view=chase&v3d=1'],
  ['floorplane', 't=0&view=plane&plane=floor&noui=0'],
].filter(([n]) => !process.env.ONLY || process.env.ONLY.split(',').includes(n));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,720', 'about:blank'], { stdio: 'ignore' });
let failed = 0;
const report = (ok, name, msg, errs = []) => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(12)} ${msg}`); for (const e of errs) console.log('     ', e); };
const errorsOf = (c) => c.events.filter((e) => (e.method === 'Runtime.exceptionThrown') || (e.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(e.params.type)) || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => (e.params.args?.[0]?.value || e.params.exceptionDetails?.exception?.description || e.params.entry?.text || JSON.stringify(e.params)).slice(0, 500));
const evaluate = async (c, expr) => (await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const pixelStats = `(() => { const g = document.querySelector('canvas').getContext('webgl2'); const W = g.drawingBufferWidth, H = g.drawingBufferHeight; const px = new Uint8Array(W * H * 4); g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, px); let s = 0, s2 = 0, n = 0; for (let i = 0; i < px.length; i += 4 * 97) { const l = (px[i] + px[i + 1] + px[i + 2]) / 3; s += l; s2 += l * l; n++; } const m = s / n; return { mean: m, sd: Math.sqrt(s2 / n - m * m) }; })()`;
async function waitReady(c) { for (let i = 0; i < 400; i++) { await sleep(150); if (await evaluate(c, '!!window.__ready || !!window.__lr')) return true; } return false; }

try {
  let tabs; for (let i = 0; i < 50; i++) { try { tabs = await getJson(`http://127.0.0.1:${CDP}/json`); if (tabs.length) break; } catch { /* starting */ } await sleep(200); }
  const c = await cdp(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable'); await c.send('Log.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });

  for (const [name, qs] of SHOTS) {
    c.events.length = 0;
    const t0 = Date.now();
    const ui = qs.includes('noui=0') ? '' : '&noui=1';
    await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?demo=1&still=1&pr=1${ui}&${qs}` });
    let ready = false;
    for (let i = 0; i < 400 && !ready; i++) { await sleep(150); ready = await evaluate(c, '!!window.__ready'); }
    const st = ready ? await evaluate(c, pixelStats) : {};
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(DIR, `shot_${name}.png`), Buffer.from(shot.result.data, 'base64'));
    const errs = errorsOf(c);
    report(ready && !errs.length && st.sd > 6, name, `${((Date.now() - t0) / 1000).toFixed(1)}s mean ${st.mean?.toFixed(0)} sd ${st.sd?.toFixed(0)}`, errs);
  }

  if (!process.env.ONLY || process.env.ONLY.includes('ride')) {
    // the demo run, in the page: no crash for 25 s, and the rider gets past the far end of the turn
    c.events.length = 0;
    await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?demo=1&noui=1` });
    await waitReady(c);
    const r = await evaluate(c, `(() => { let minX = 1e9, maxZ = -1e9; for (let f = 0; f <= 1500; f += 10) { const s = __lr.status(f); minX = Math.min(minX, s.c[0]); maxZ = Math.max(maxZ, s.c[2]); } const s = __lr.status(1500); return { crashed: s.crashed, crashFrame: s.crashFrame, minX, maxZ }; })()`);
    report(r && !r.crashed && r.minX < -100 && r.maxZ > 60 && !errorsOf(c).length, 'ride', JSON.stringify(r), errorsOf(c));
  }

  if (!process.env.ONLY || process.env.ONLY.includes('menu')) {
    c.events.length = 0;
    await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?demo=1` });
    await waitReady(c);
    await evaluate(c, `document.getElementById('help').classList.remove('show')`);
    const box = await evaluate(c, `(() => { const r = document.getElementById('file').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    await sleep(100);
    const focused = await evaluate(c, `document.activeElement && document.activeElement.id`);
    report(focused === 'file' && !errorsOf(c).length, 'menu', `focus after click on Track menu: ${focused}`, errorsOf(c));
  }

  if (!process.env.ONLY || process.env.ONLY.includes('draw')) {
    // draw a stroke left -> right with the mouse on an empty track, the rider must land on it and ride
    c.events.length = 0;
    await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?empty=1&noui=1` });
    await waitReady(c);
    await sleep(300);
    const mouse = (type, x, y, buttons = 1) => c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
    await mouse('mouseMoved', 200, 380, 0);
    await mouse('mousePressed', 200, 380);
    for (let x = 200; x <= 1100; x += 25) { await mouse('mouseMoved', x, 380 + Math.sin(x / 140) * 20); await sleep(8); }
    await mouse('mouseReleased', 1100, 380, 0);
    await sleep(200);
    const r = await evaluate(c, `(() => { const s = __lr.strokes[0]; const st = __lr.status(180); return { n: __lr.strokes.length, pts: s && s.pts.length, y0: s && s.pts[0][1], crashed: st.crashed, c: st.c.map((v) => +v.toFixed(2)), speed: +st.speed.toFixed(2), contact: __lr.stateAt(180).contact }; })()`);
    const shot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(DIR, 'shot_draw.png'), Buffer.from(shot.result.data, 'base64'));
    const ok = r && r.n === 1 && r.pts > 10 && !r.crashed && Math.abs(r.c[1] - r.y0) < 6 && r.c[1] > r.y0 - 8 && !errorsOf(c).length;
    report(ok, 'draw', JSON.stringify(r), errorsOf(c));

    // line tool from the stroke's end (snaps onto it), eraser through the first stroke (splits it in two),
    // then a pencil stroke with D held (the plane turns while drawing, so its hints rotate)
    const key = (type, k, code) => c.send('Input.dispatchKeyEvent', { type, key: k, code, text: type === 'keyDown' ? k : undefined });
    const tap = async (k, code) => { await key('keyDown', k, code); await key('keyUp', k, code); };
    const endPx = await evaluate(c, `(() => { const p = __lr.strokes[0].pts.at(-1); return p; })()`);
    await tap('w', 'KeyW');
    const scr = await evaluate(c, `window.__lr.toScreen(${JSON.stringify(endPx)})`);
    await mouse('mouseMoved', scr.x, scr.y, 0); await mouse('mousePressed', scr.x, scr.y);
    for (let k = 1; k <= 10; k++) { await mouse('mouseMoved', scr.x + k * 12, scr.y + k * 14); await sleep(5); }
    await mouse('mouseReleased', scr.x + 120, scr.y + 140, 0);
    await tap('e', 'KeyE');
    await mouse('mouseMoved', 650, 300, 0); await mouse('mousePressed', 650, 300);
    for (let y = 300; y <= 460; y += 10) { await mouse('mouseMoved', 650, y); await sleep(5); }
    await mouse('mouseReleased', 650, 460, 0);
    await tap('q', 'KeyQ');
    await mouse('mouseMoved', 300, 250, 0); await mouse('mousePressed', 300, 250);
    await key('keyDown', 'd', 'KeyD');
    for (let x = 300; x <= 700; x += 10) { await mouse('mouseMoved', x, 250); await sleep(20); }
    await key('keyUp', 'd', 'KeyD');
    await mouse('mouseReleased', 700, 250, 0);
    await sleep(100);
    const e = await evaluate(c, `(() => { const S = __lr.strokes; const line = S.find((s) => s.pts.length && Math.hypot(...s.pts[0].map((v, i) => v - ${JSON.stringify(endPx)}[i])) < 1e-6); const last = S.at(-1); const h0 = last.hints[0], h1 = last.hints.at(-1); return { n: S.length, snapped: !!line, turned: +(Math.acos(Math.max(-1, Math.min(1, h0[0]*h1[0] + h0[2]*h1[2]))) * 180 / Math.PI).toFixed(1) }; })()`);
    const shot2 = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(DIR, 'shot_edit.png'), Buffer.from(shot2.result.data, 'base64'));
    report(e && e.n === 4 && e.snapped && e.turned > 5 && !errorsOf(c).length, 'edit', JSON.stringify(e), errorsOf(c));
  }
  c.close();
} finally { chrome.kill(); server.close(); }
process.exit(failed ? 1 : 0);

// Headless check over the Chrome DevTools protocol, zero npm deps (SwiftShader WebGL2).
// Paints with real pen pointer events (pressure, tilt), touch and mouse, checks that wet
// paint flows and dries, undo/redo, pinch zoom, two-finger-tap undo, mixing, export, autosave
// + reload restore, then an offline reload through the service worker. Writes shot_*.png.
//   node smoke.js      (CHROME=/path/to/chrome to override)
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PW = path.join(process.env.HOME, '.cache/ms-playwright');
const CHROME = process.env.CHROME || (fs.existsSync(PW) && fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => path.join(PW, d, 'chrome-linux/chrome')).find((f) => fs.existsSync(f)));
if (!CHROME) { console.log('FAIL no Chromium: bunx playwright install chromium, or set CHROME=...'); process.exit(1); }
const PORT = Number(process.env.PORT || 8847), CDP = Number(process.env.CDP || 9387), VW = 1280, VH = 860;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
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
  if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, '127.0.0.1');

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP}`, '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${VW},${VH}`, `--user-data-dir=/tmp/aquarelle-smoke-${process.pid}`, 'about:blank'], { stdio: 'ignore' });
let failed = 0;
process.on('exit', () => { try { chrome.kill('SIGKILL'); } catch { /* gone */ } fs.rmSync(`/tmp/aquarelle-smoke-${process.pid}`, { recursive: true, force: true }); });
server.on('error', (e) => { console.log('FAIL server:', e.message, '(set PORT=...)'); process.exit(1); });
const check = (ok, name, extra = '') => { if (!ok) failed++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); };
try {
  let tabs; for (let i = 0; i < 50; i++) { try { tabs = await getJson(`http://127.0.0.1:${CDP}/json`); if (tabs.length) break; } catch { /* starting */ } await sleep(200); }
  if (!tabs) throw new Error(`no Chrome on CDP port ${CDP} (set CDP=...)`);
  const ver = await getJson(`http://127.0.0.1:${CDP}/json/version`);
  if (!String(ver['User-Agent'] || '').includes('Headless')) throw new Error('CDP port answered by another browser');
  const c = await cdp(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable'); await c.send('Log.enable');
  await c.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  const ev = async (expr) => { const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(expr.slice(0, 80) + ': ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400)); return r.result?.result?.value; };
  const errors = () => c.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/favicon/.test(e.params.entry.text)))
    .map((e) => (e.params.args?.[0]?.value || e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text || e.params.entry?.text || '').slice(0, 600));
  const load = async (q) => {
    c.events.length = 0;
    await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html?${q}` });
    for (let i = 0; i < 200; i++) { await sleep(100); if (await ev('!!window.__ready').catch(() => false)) return true; }
    return false;
  };
  const shot = async (name) => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, `shot_${name}.png`), Buffer.from(s.result.data, 'base64')); };
  // sheet coords -> screen
  const scr = async (x, y) => ev(`(() => { const p = __aq.toScreen(${x}, ${y}); return [p.x, p.y]; })()`);
  const pen = async (pts, { pressure = (t) => 0.3 + 0.6 * Math.sin(Math.PI * t), tiltX = 0, type = 'pen' } = {}) => {
    const sp = []; for (const [x, y] of pts) sp.push(await scr(x, y));
    const n = sp.length;
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp[0][0], y: sp[0][1], button: 'left', buttons: 1, clickCount: 1, pointerType: type, force: pressure(0), tiltX });
    for (let i = 1; i < n; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sp[i][0], y: sp[i][1], button: 'left', buttons: 1, pointerType: type, force: pressure(i / (n - 1)), tiltX }); await sleep(6); }
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp[n - 1][0], y: sp[n - 1][1], button: 'left', buttons: 0, clickCount: 1, pointerType: type });
  };
  const line = (x0, y0, x1, y1, n = 40, wob = 0) => Array.from({ length: n }, (_, i) => { const t = i / (n - 1); return [x0 + (x1 - x0) * t + Math.sin(t * 9) * wob, y0 + (y1 - y0) * t + Math.cos(t * 7) * wob]; });
  const sel = async (s) => ev(`(() => { const b = document.querySelector(${JSON.stringify(s)}); if (!b) return false; b.click(); return true; })()`);
  const stat = (x0, y0, x1, y1) => ev(`(() => { const px = __aq.sim.exportPixels({ paperCol: [0.89, 0.87, 0.80] }); const W = __aq.sim.W; let s = 0, n = 0, dark = 0; for (let y = ${y0}; y < ${y1}; y += 2) for (let x = ${x0}; x < ${x1}; x += 2) { const i = (y * W + x) * 4; const l = (px[i] + px[i + 1] + px[i + 2]) / 3; s += l; n++; if (l < 200) dark++; } return { mean: s / n, dark: dark / n }; })()`);
  const waitDry = async (max = 40) => { for (let i = 0; i < max * 4; i++) { if (!(await ev('__aq.sim.wet'))) return true; await sleep(250); } return false; };

  // 0. a small landscape for the README: wet-in-wet sky, hills wet-on-dry, glazed foreground, rigger trees
  if (!process.env.SKIP_SCENE) {
    await load('fresh=1&nohelp=1&nosw=1&nosave=1');
    const setT = (tool, pig, o = {}) => ev(`(() => { __aq.setTool('${tool}'); ${pig ? `__aq.choosePigment('${pig}');` : ''} Object.assign(__aq.S.brush['${tool}'], ${JSON.stringify(o)}); return true; })()`);
    await setT('water', null, { size: 90, water: 0.85 });
    for (let y = 60; y < 640; y += 70) await pen(line(40, y, 1560, y + 10, 26), { pressure: () => 0.9 });
    await setT('wash', 'ultra', { size: 75, water: 0.8, paint: 0.5 });
    for (let y = 70; y < 330; y += 75) await pen(line(30, y, 1570, y - 20, 30, 20), { pressure: () => 0.8 });
    await setT('wash', 'rose', { size: 60, water: 0.8, paint: 0.35 });
    await pen(line(80, 470, 1520, 440, 30, 25), { pressure: () => 0.7 });
    await setT('wash', 'gamboge', { size: 55, water: 0.8, paint: 0.3 });
    await pen(line(300, 560, 1300, 540, 26, 15), { pressure: () => 0.7 });
    await waitDry(120); await ev('__aq.sim.dryNow(); true');
    // distant hills: a cool grey-violet band, wet on dry, so it keeps a hard dark edge
    await ev(`__aq.choosePigment('ultra'); __aq.choosePigment('umber', true); true`);
    await setT('round', null, { size: 40, water: 0.75, paint: 0.4 });
    const hill = (y0, amp, f, ph) => Array.from({ length: 50 }, (_, i) => [i * 33, y0 + Math.sin(i * f + ph) * amp + Math.sin(i * f * 2.7) * amp * 0.3]);
    for (let k = 0; k < 4; k++) await pen(hill(640 + k * 40, 40, 0.22, 1).map(([x, y]) => [x, y + 0]), { pressure: () => 0.9 });
    await waitDry(120); await ev('__aq.sim.dryNow(); true');
    // nearer hill: sap green + ochre, granulating, then a glaze of hooker's at the base
    await ev(`__aq.choosePigment('sap'); __aq.choosePigment('ochre', true); true`);
    await setT('wash', null, { size: 70, water: 0.8, paint: 0.5 });
    for (let k = 0; k < 6; k++) await pen(hill(790 + k * 60, 55, 0.13, 3).map(([x, y]) => [x, y + k * 10]), { pressure: () => 0.85 });
    await setT('round', 'hooker', { size: 30, water: 0.8, paint: 0.55 });
    for (let k = 0; k < 3; k++) await pen(line(0, 1080 + k * 35, 1600, 1050 + k * 30, 30, 18), { pressure: () => 0.9 });
    await waitDry(120); await ev('__aq.sim.dryNow(); true');
    // trees with the rigger, dry brush grass
    await setT('detail', 'payne', { size: 5, water: 0.5, paint: 0.8 });
    for (const x of [1150, 1215, 1260]) {
      await pen(line(x, 900, x + 6, 640, 30, 2), { pressure: (t) => 1 - 0.85 * t });
      for (let b = 0; b < 6; b++) { const y = 860 - b * 38; await pen(line(x + 3, y, x + 3 + (b % 2 ? 45 : -45) * (1 - b / 7), y - 40, 10), { pressure: (t) => 0.8 - 0.7 * t }); }
    }
    await setT('dry', 'sienna', { size: 40, water: 0.1, paint: 0.8 });
    await pen(line(80, 1110, 900, 1130, 40), { pressure: () => 0.6 });
    await setT('splatter', 'umber', { size: 45, water: 0.7, paint: 0.6 });
    await pen(line(300, 1000, 700, 1060, 14));
    await waitDry(120);
    await ev('document.querySelectorAll(".panel").forEach((p) => (p.style.display = "none")); __aq.redraw(); true');
    await sleep(500); await shot('scene');
    await ev(`(() => { const v = __aq.view; v.z = 2; const p = __aq.toScreen(1200, 760); v.x -= p.x - 640; v.y -= p.y - 430; __aq.redraw(); return true; })()`);
    await sleep(500); await shot('scene_closeup');
    check(errors().length === 0, 'scene painted without errors', errors().join(' | '));
  }

  check(await load('fresh=1&nohelp=1&nosw=1'), 'loads');
  check(errors().length === 0, 'no console errors on load', errors().join(' | '));
  const W = await ev('__aq.sim.W'), H = await ev('__aq.sim.H');

  // 1. pen strokes with pressure: round brush, ultramarine
  await ev(`__aq.setTool('round'); __aq.choosePigment('ultra'); true`);
  await pen(line(200, 300, 700, 260, 60, 6));
  await sleep(300);
  await sleep(1500);
  check(await ev('__aq.sim.wet'), 'pen stroke makes the paper wet');
  const s1 = await stat(200, 230, 700, 330), s0 = await stat(200, 400, 700, 500);
  check(s1.mean < s0.mean - 4, 'stroke lays down pigment', `${s0.mean.toFixed(1)} -> ${s1.mean.toFixed(1)}`);
  await shot('wet');

  // 2. wet-in-wet: wet a patch, drop rose and yellow into it
  await ev(`__aq.setTool('wash'); __aq.S.brush.wash.size = 60; true`);
  await sel('[data-tool="water"]'); await ev(`__aq.S.brush.water.size = 70; true`);
  for (let y = 520; y < 820; y += 40) await pen(line(150, y, 650, y, 30), { pressure: () => 0.8 });
  await ev(`__aq.setTool('round'); __aq.choosePigment('rose'); true`);
  await pen(line(250, 620, 400, 700, 20), { pressure: () => 0.9 });
  await ev(`__aq.choosePigment('gamboge'); true`);
  await pen(line(420, 600, 560, 720, 20), { pressure: () => 0.9 });
  await sleep(1500);
  await shot('wetinwet');

  // 3. mix: phthalo + hansa on the brush -> green, with a tilted pen
  await ev(`__aq.choosePigment('phthalo'); __aq.choosePigment('hansa', true); true`);
  check(await ev('__aq.S.pig.length === 2'), 'shift-select mixes two pigments');
  await pen(line(850, 200, 1400, 420, 60, 10), { tiltX: 50 });
  // 4. dry brush on rough paper is tested via the tool
  await ev(`__aq.setTool('dry'); __aq.choosePigment('sienna'); true`);
  await pen(line(800, 650, 1450, 600, 50), { pressure: () => 0.7 });
  // 5. splatter
  await ev(`__aq.setTool('splatter'); __aq.choosePigment('umber'); true`);
  await pen(line(900, 900, 1300, 980, 20));
  // 6. mouse stroke, detail brush
  await ev(`__aq.setTool('detail'); __aq.choosePigment('payne'); true`);
  await pen(line(150, 1000, 700, 1080, 60, 12), { type: 'mouse' });

  const dried = await waitDry(120);
  if (!dried) console.log('     still wet:', JSON.stringify(await ev('__aq.sim.active')));
  check(dried, 'everything dries by itself');
  await shot('dried');
  const s2 = await stat(220, 580, 600, 760), s2b = await stat(1000, 760, 1400, 860);
  check(s2.mean < s2b.mean - 8, 'wet-in-wet drops hold colour', `${s2b.mean.toFixed(1)} -> ${s2.mean.toFixed(1)}`);
  // green check: sample the mixed stroke area
  const g = await ev(`(() => { const px = __aq.sim.exportPixels({ paperCol: [0.89, 0.87, 0.80] }); const W = __aq.sim.W; let r = 0, g = 0, b = 0, n = 0; for (let x = 900; x < 1350; x += 3) { const y = Math.round(200 + (x - 850) / 550 * 220); for (let dy = -8; dy <= 8; dy += 2) { const i = ((y + dy) * W + x) * 4; if (px[i] + px[i+1] + px[i+2] < 600) { r += px[i]; g += px[i+1]; b += px[i+2]; n++; } } } return [r / n, g / n, b / n, n]; })()`);
  check(g[3] > 50 && g[1] > g[0] + 8 && g[1] >= g[2] - 25, 'phthalo + hansa mixes to green', g.map((v) => v.toFixed(0)).join(','));

  // 7. glaze over dried paint, then undo restores it exactly
  const before = await stat(200, 230, 700, 330);
  await ev(`__aq.setTool('wash'); __aq.choosePigment('ochre'); true`);
  await pen(line(150, 280, 750, 280, 40), { pressure: () => 0.8 });
  await sleep(2500);
  const glazed = await stat(200, 230, 700, 330);
  check(glazed.mean < before.mean - 2, 'glaze darkens the dried layer', `${before.mean.toFixed(1)} -> ${glazed.mean.toFixed(1)}`);
  await sel('#undoBtn'); await sleep(200);
  const undone = await stat(200, 230, 700, 330);
  check(Math.abs(undone.mean - before.mean) < 0.3, 'undo restores the dried layer', `${undone.mean.toFixed(2)} vs ${before.mean.toFixed(2)}`);
  await sel('#redoBtn'); await sleep(200);
  const redone = await stat(200, 230, 700, 330);
  check(redone.mean < before.mean - 1, 'redo brings the glaze back', redone.mean.toFixed(1));
  await sel('#undoBtn'); await sleep(100);

  // 8. lift: blotting the dried ultramarine lightens it
  await ev(`__aq.sim.dryNow(); __aq.setTool('lift'); __aq.S.brush.lift.size = 30; true`);
  const pre = await stat(400, 240, 500, 320);
  for (let i = 0; i < 4; i++) await pen(line(400, 285, 500, 280, 15), { pressure: () => 0.9 });
  await sleep(600); await ev('__aq.sim.dryNow(); true');
  const post = await stat(400, 240, 500, 320);
  check(post.mean > pre.mean + 1, 'lift takes paint off', `${pre.mean.toFixed(1)} -> ${post.mean.toFixed(1)}`);

  // 9. touch: one finger paints (no pen seen in this page yet? pen was seen: fingers navigate)
  const z0 = await ev('__aq.view.z');
  const [cx, cy] = [640, 430];
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 60, y: cy, id: 1 }, { x: cx + 60, y: cy, id: 2 }] });
  for (let i = 1; i <= 10; i++) await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 60 - i * 8, y: cy, id: 1 }, { x: cx + 60 + i * 8, y: cy, id: 2 }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(100);
  const z1 = await ev('__aq.view.z');
  check(z1 > z0 * 1.4, 'pinch zooms', `${z0.toFixed(3)} -> ${z1.toFixed(3)}`);
  const undoBefore = await ev('__aq.sim.undo.length');
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 500, y: 400, id: 3 }, { x: 600, y: 400, id: 4 }] });
  await sleep(60);
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(100);
  check(await ev('__aq.sim.undo.length') === undoBefore - 1, 'two-finger tap undoes');
  await ev('__aq.fit(); true');
  // finger painting when told to paint with fingers
  await ev(`__aq.S.fingers = 'paint'; __aq.setTool('round'); __aq.choosePigment('cadred'); true`);
  const tp = []; for (const [x, y] of line(900, 1100, 1450, 1050, 30)) tp.push(await scr(x, y));
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tp[0][0], y: tp[0][1], id: 5 }] });
  for (const [x, y] of tp.slice(1)) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 5 }] }); await sleep(8); }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
  const tstat = await stat(900, 1020, 1450, 1130);
  check(tstat.dark > 0.03, 'finger paints', JSON.stringify(tstat));

  // 10. papers
  for (const p of ['rough', 'hot']) {
    await ev(`(() => { const b = [...document.querySelectorAll('#paperList .item')].find((b) => b.textContent.toLowerCase().includes('${p === 'hot' ? 'hot' : 'rough'}')); b.click(); return true; })()`);
  }
  await ev(`(() => { [...document.querySelectorAll('#paperList .item')][0].click(); return true; })()`);
  await waitDry(40);
  await shot('final');
  // close-up: granulation, edge darkening, wet-in-wet edges at 2.5x
  await ev(`(() => { const v = __aq.view; v.z = 2.5; v.r = 0; const p = __aq.toScreen(330, 290); v.x -= p.x - 400; v.y -= p.y - 300; __aq.redraw(); return true; })()`);
  await sleep(300); await shot('closeup'); await ev('__aq.fit(); true');

  // 11. export + autosave + restore
  await ev('__aq.exportPNG()');
  const exp = await ev('window.__lastExport');
  check(exp && exp.w === W && exp.bytes > 20000, 'PNG export at sheet size', JSON.stringify(exp));
  await ev('__aq.save()');
  check((await ev('window.__saved || 0')) > 0, 'autosaves to IndexedDB');
  const ref = await stat(0, 0, W, H);
  check(await load('nohelp=1&nosw=1'), 'reload');
  await sleep(500);
  const back = await stat(0, 0, W, H);
  check(Math.abs(back.mean - ref.mean) < 0.2, 'painting restored after reload', `${ref.mean.toFixed(2)} vs ${back.mean.toFixed(2)}`);

  // 12. timing of a sim step on a big wet area (SwiftShader is slow; this is a sanity bound)
  const ms = await ev(`(() => { const s = __aq.sim; s.begin(); s.stamp([{ x: 800, y: 600, r: 300, a: 1, wt: 0.8, el: 1, ex: 1, ey: 0 }], { mode: 1, shape: 1, bK: [0,0,0,0], bS: [0,0,0,0], mix: 0.1 }); const t = performance.now(); for (let i = 0; i < 5; i++) s.step(1/60); s.gl.finish(); return (performance.now() - t) / 5; })()`);
  console.log(`     big wet area step: ${ms.toFixed(0)} ms (SwiftShader, CPU)`);

  // 13. iPad-sized touch layout with the menu and help open
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 2, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  check(await load('nosw=1&nosave=1'), 'loads at iPad size');
  await sleep(400); await sel('#menuBtn'); await sleep(300); await shot('ipad_menu');
  await sel('#helpBtn'); await sleep(300); await shot('ipad_help');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await ev("localStorage.clear(); true");
  check(await load('nosw=1&nosave=1&nohelp=1'), 'loads at phone size');
  check(await ev('__aq.sim.H > __aq.sim.W'), 'phone held upright gets a portrait sheet');
  await sleep(400); await shot('phone');
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await c.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

  // 14. offline: register the service worker, reload offline
  check(await load('nohelp=1'), 'load with service worker');
  for (let i = 0; i < 50 && !(await ev('!!navigator.serviceWorker.controller')); i++) await sleep(200);
  if (!(await ev('!!navigator.serviceWorker.controller'))) { await load('nohelp=1'); await sleep(500); }
  await c.send('Network.enable'); await c.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  check(await load('nohelp=1'), 'starts offline');
  await c.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  check(errors().length === 0, 'no console errors', errors().join(' | '));
  c.close();
} catch (e) { console.log('FAIL', e.stack || e); failed++; } finally { chrome.kill(); server.close(); }
console.log(failed ? `${failed} FAILED` : 'all ok');
process.exit(failed ? 1 : 0);

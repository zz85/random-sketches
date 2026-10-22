// Headless check over the Chrome DevTools protocol, zero npm deps (SwiftShader WebGL2).
// Paints with real pen pointer events (pressure, tilt), touch and mouse through the
// Procreate-style UI: flow and drying, mixing, glazing, undo/redo, lift, smudge, layers
// (hide, undo, merge), QuickShape, colour disc, pinch zoom and finger taps, gallery, PNG
// export, autosave + reload, time-lapse frames, iPad / phone layouts, offline reload.
// Writes shot_*.png.
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
  const pen = async (pts, { pressure = (t) => 0.3 + 0.6 * Math.sin(Math.PI * t), tiltX = 0, type = 'pen', hold = 0 } = {}) => {
    const sp = []; for (const [x, y] of pts) sp.push(await scr(x, y));
    const n = sp.length;
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp[0][0], y: sp[0][1], button: 'left', buttons: 1, clickCount: 1, pointerType: type, force: pressure(0), tiltX });
    for (let i = 1; i < n; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sp[i][0], y: sp[i][1], button: 'left', buttons: 1, pointerType: type, force: pressure(i / (n - 1)), tiltX }); await sleep(6); }
    if (hold) await sleep(hold);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp[n - 1][0], y: sp[n - 1][1], button: 'left', buttons: 0, clickCount: 1, pointerType: type });
  };
  const line = (x0, y0, x1, y1, n = 40, wob = 0) => Array.from({ length: n }, (_, i) => { const t = i / (n - 1); return [x0 + (x1 - x0) * t + Math.sin(t * 9) * wob, y0 + (y1 - y0) * t + Math.cos(t * 7) * wob]; });
  const sel = async (s) => ev(`(() => { const b = document.querySelector(${JSON.stringify(s)}); if (!b) return false; b.click(); return true; })()`);
  const stat = (x0, y0, x1, y1) => ev(`(() => { const px = __aq.sim.exportPixels({ paperCol: [0.89, 0.87, 0.80] }); const W = __aq.sim.W; let s = 0, n = 0, dark = 0; for (let y = ${y0}; y < ${y1}; y += 2) for (let x = ${x0}; x < ${x1}; x += 2) { const i = (y * W + x) * 4; const l = (px[i] + px[i + 1] + px[i + 2]) / 3; s += l; n++; if (l < 200) dark++; } return { mean: s / n, dark: dark / n }; })()`);
  const waitDry = async (max = 40) => { for (let i = 0; i < max * 4; i++) { if (!(await ev('__aq.sim.wet'))) return true; await sleep(250); } return false; };


  const setT = (tool, brush, pig, o = {}) => ev(`(() => { __aq.setTool('${tool}'); ${brush ? `__aq.selectBrush('${brush}');` : ''} ${pig ? `__aq.choosePigment('${pig}');` : ''} const id = __aq.S.sel['${tool}']; Object.assign('${tool}' === 'paint' ? __aq.S.brush[id] : __aq.S.tools['${tool}'], ${JSON.stringify(o)}); return true; })()`);

  // 0. a small landscape for the README
  if (!process.env.SKIP_SCENE) {
    await load('fresh=1&nohelp=1&nosw=1&nosave=1');
    await ev('__aq.createPainting(1600, 1200); true');
    await setT('paint', 'water', null, { size: 90, water: 0.85 });
    for (let y = 60; y < 640; y += 70) await pen(line(40, y, 1560, y + 10, 26), { pressure: () => 0.9 });
    await setT('paint', 'wash', 'ultra', { size: 75, water: 0.8, paint: 0.5 });
    for (let y = 70; y < 330; y += 75) await pen(line(30, y, 1570, y - 20, 30, 20), { pressure: () => 0.8 });
    await setT('paint', 'wash', 'rose', { size: 60, water: 0.8, paint: 0.35 });
    await pen(line(80, 470, 1520, 440, 30, 25), { pressure: () => 0.7 });
    await setT('paint', 'wash', 'gamboge', { size: 55, water: 0.8, paint: 0.3 });
    await pen(line(300, 560, 1300, 540, 26, 15), { pressure: () => 0.7 });
    await waitDry(120); await ev('__aq.sim.dryNow(); true');
    await ev(`__aq.choosePigment('ultra'); __aq.choosePigment('umber', true); true`);
    await setT('paint', 'round', null, { size: 40, water: 0.75, paint: 0.4 });
    const hill = (y0, amp, f, ph) => Array.from({ length: 50 }, (_, i) => [i * 33, y0 + Math.sin(i * f + ph) * amp + Math.sin(i * f * 2.7) * amp * 0.3]);
    for (let k = 0; k < 4; k++) await pen(hill(640 + k * 40, 40, 0.22, 1), { pressure: () => 0.9 });
    await waitDry(120); await ev('__aq.sim.dryNow(); true');
    await ev(`__aq.choosePigment('sap'); __aq.choosePigment('ochre', true); true`);
    await setT('paint', 'wash', null, { size: 70, water: 0.8, paint: 0.5 });
    for (let k = 0; k < 6; k++) await pen(hill(790 + k * 60, 55, 0.13, 3).map(([x, y]) => [x, y + k * 10]), { pressure: () => 0.85 });
    await setT('paint', 'round', 'hooker', { size: 30, water: 0.8, paint: 0.55 });
    for (let k = 0; k < 3; k++) await pen(line(0, 1080 + k * 35, 1600, 1050 + k * 30, 30, 18), { pressure: () => 0.9 });
    await waitDry(120); await ev('__aq.sim.dryNow(); true');
    // trees on their own layer
    await ev(`document.querySelector('#addLayer').click(); true`);
    await setT('paint', 'detail', 'payne', { size: 5, water: 0.5, paint: 0.8 });
    for (const x of [1150, 1215, 1260]) {
      await pen(line(x, 900, x + 6, 640, 30, 2), { pressure: (t) => 1 - 0.85 * t });
      for (let b = 0; b < 6; b++) { const y = 860 - b * 38; await pen(line(x + 3, y, x + 3 + (b % 2 ? 45 : -45) * (1 - b / 7), y - 40, 10), { pressure: (t) => 0.8 - 0.7 * t }); }
    }
    await setT('paint', 'dry', 'sienna', { size: 40, water: 0.1, paint: 0.8 });
    await pen(line(80, 1110, 900, 1130, 40), { pressure: () => 0.6 });
    await setT('paint', 'splatter', 'umber', { size: 45, water: 0.7, paint: 0.6 });
    await pen(line(300, 1000, 700, 1060, 14));
    await waitDry(120);
    await ev(`__aq.fit(); __aq.togglePop('layerPop'); true`); await sleep(500); await shot('scene_ui'); await ev(`__aq.togglePop('layerPop'); true`);
    await ev('document.querySelectorAll("#bar, #side").forEach((p) => (p.style.display = "none")); __aq.fit(); __aq.redraw(); true');
    await sleep(500); await shot('scene');
    await ev(`(() => { const v = __aq.view; v.z = 2; const p = __aq.toScreen(1200, 760); v.x -= p.x - 640; v.y -= p.y - 430; __aq.redraw(); return true; })()`);
    await sleep(500); await shot('scene_closeup');
    check(errors().length === 0, 'scene painted without errors', errors().join(' | '));
  }

  check(await load('fresh=1&nohelp=1&nosw=1'), 'loads');
  check(errors().length === 0, 'no console errors on load', errors().join(' | '));
  check(await ev('__aq.sim.W > 1000 && __aq.sim.H > 600 && !!__aq.doc.id'), 'first visit opens a screen-shaped canvas');
  await ev('__aq.createPainting(1600, 1200); true');
  const W = await ev('__aq.sim.W'), H = await ev('__aq.sim.H');
  await sleep(300); await shot('ui');

  // 1. pen strokes with pressure: round brush, ultramarine
  await setT('paint', 'round', 'ultra');
  const s0 = await stat(200, 400, 700, 500);
  await pen(line(200, 300, 700, 260, 60, 6));
  await sleep(1500);
  check(await ev('__aq.sim.wet'), 'pen stroke makes the paper wet');
  const s1 = await stat(200, 230, 700, 330);
  check(s1.mean < s0.mean - 4, 'stroke lays down pigment', `${s0.mean.toFixed(1)} -> ${s1.mean.toFixed(1)}`);

  // 2. wet-in-wet: wet a patch with the clear water brush, drop rose and yellow into it
  await setT('paint', 'water', null, { size: 70 });
  for (let y = 520; y < 820; y += 40) await pen(line(150, y, 650, y, 30), { pressure: () => 0.8 });
  await setT('paint', 'round', 'rose');
  await pen(line(250, 620, 400, 700, 20), { pressure: () => 0.9 });
  await ev(`__aq.choosePigment('gamboge'); true`);
  await pen(line(420, 600, 560, 720, 20), { pressure: () => 0.9 });
  await sleep(1500);
  await shot('wetinwet');

  // 3. mix on the brush: phthalo + hansa -> green, with a tilted pen
  await ev(`__aq.choosePigment('phthalo'); __aq.choosePigment('hansa', true); true`);
  check(await ev('__aq.S.pig.length === 2'), 'adding a pigment mixes two on the brush');
  await pen(line(850, 200, 1400, 420, 60, 10), { tiltX: 50 });
  await setT('paint', 'dry', 'sienna');
  await pen(line(800, 650, 1450, 600, 50), { pressure: () => 0.7 });
  await setT('paint', 'splatter', 'umber');
  await pen(line(900, 900, 1300, 980, 20));
  await setT('paint', 'detail', 'payne');
  await pen(line(150, 1000, 700, 1080, 60, 12), { type: 'mouse' });

  const dried = await waitDry(120);
  check(dried, 'everything dries by itself');
  await shot('dried');
  const s2 = await stat(220, 580, 600, 760), s2b = await stat(1000, 760, 1400, 860);
  check(s2.mean < s2b.mean - 8, 'wet-in-wet drops hold colour', `${s2b.mean.toFixed(1)} -> ${s2.mean.toFixed(1)}`);
  const g = await ev(`(() => { const px = __aq.sim.exportPixels({ paperCol: [0.89, 0.87, 0.80] }); const W = __aq.sim.W; let r = 0, g = 0, b = 0, n = 0; for (let x = 900; x < 1350; x += 3) { const y = Math.round(200 + (x - 850) / 550 * 220); for (let dy = -8; dy <= 8; dy += 2) { const i = ((y + dy) * W + x) * 4; if (px[i] + px[i+1] + px[i+2] < 600) { r += px[i]; g += px[i+1]; b += px[i+2]; n++; } } } return [r / n, g / n, b / n, n]; })()`);
  check(g[3] > 50 && g[1] > g[0] + 8 && g[1] >= g[2] - 25, 'phthalo + hansa mixes to green', g.map((v) => v.toFixed(0)).join(','));

  // 4. glaze over dried paint, undo / redo with the sidebar buttons
  const before = await stat(200, 230, 700, 330);
  await setT('paint', 'wash', 'ochre');
  await pen(line(150, 280, 750, 280, 40), { pressure: () => 0.8 });
  await sleep(2500);
  const glazed = await stat(200, 230, 700, 330);
  check(glazed.mean < before.mean - 2, 'glaze darkens the dried layer', `${before.mean.toFixed(1)} -> ${glazed.mean.toFixed(1)}`);
  await sel('#undoBtn'); await sleep(200);
  const undone = await stat(200, 230, 700, 330);
  check(Math.abs(undone.mean - before.mean) < 0.3, 'undo restores the dried layer', `${undone.mean.toFixed(2)} vs ${before.mean.toFixed(2)}`);
  await sel('#redoBtn'); await sleep(200);
  check((await stat(200, 230, 700, 330)).mean < before.mean - 1, 'redo brings the glaze back');
  await sel('#undoBtn'); await sleep(100);

  // 5. lift and smudge
  await ev(`__aq.sim.dryNow(); true`);
  await setT('paint', 'lift', null, { size: 30 });
  const pre = await stat(400, 240, 500, 320);
  for (let i = 0; i < 4; i++) await pen(line(400, 285, 500, 280, 15), { pressure: () => 0.9 });
  await sleep(600); await ev('__aq.sim.dryNow(); true');
  const post = await stat(400, 240, 500, 320);
  check(post.mean > pre.mean + 1, 'lift takes paint off', `${pre.mean.toFixed(1)} -> ${post.mean.toFixed(1)}`);
  const sm0 = await stat(560, 330, 700, 420);
  await setT('smudge', null, null, { size: 26, paint: 0.9 });
  for (let i = 0; i < 3; i++) await pen(line(600, 250, 640, 400, 30), { pressure: () => 0.9 });
  await ev('__aq.sim.dryNow(); true');
  const sm1 = await stat(560, 330, 700, 420);
  check(sm1.mean < sm0.mean - 0.5, 'smudge drags paint into clean paper', `${sm0.mean.toFixed(1)} -> ${sm1.mean.toFixed(1)}`);

  // 6. layers: paint on a new layer, hide it, undo the layer, merge
  await ev(`__aq.togglePop('layerPop'); true`); await sleep(200);
  await sel('#addLayer'); await sleep(100);
  check(await ev('__aq.sim.layers.length === 2 && __aq.sim.layer === __aq.sim.layers[1]'), 'new layer becomes the active one');
  await setT('paint', 'round', 'cadred', { size: 30, paint: 0.7 });
  const l0 = await stat(1000, 1050, 1500, 1150);
  await pen(line(1000, 1100, 1500, 1100, 40), { pressure: () => 0.9 });
  await waitDry(60); await ev('__aq.sim.dryNow(); true');
  const l1 = await stat(1000, 1050, 1500, 1150);
  check(l1.mean < l0.mean - 3, 'paints on the new layer', `${l0.mean.toFixed(1)} -> ${l1.mean.toFixed(1)}`);
  await shot('layers');
  await ev(`(() => { const cb = document.querySelector('#layerList .lay input'); cb.click(); return true; })()`); await sleep(150);
  const l2 = await stat(1000, 1050, 1500, 1150);
  check(Math.abs(l2.mean - l0.mean) < 0.5, 'hiding the layer hides its paint', `${l2.mean.toFixed(1)} vs ${l0.mean.toFixed(1)}`);
  await ev(`(() => { const cb = document.querySelector('#layerList .lay input'); cb.click(); return true; })()`); await sleep(150);
  await ev(`(() => { const L = __aq.sim.layer; __aq.sim.mergeDownOp(L); return true; })()`);
  check(await ev('__aq.sim.layers.length === 1'), 'merge down leaves one layer');
  check(Math.abs((await stat(1000, 1050, 1500, 1150)).mean - l1.mean) < 1, 'merged painting looks the same');
  await sel('#undoBtn'); await sleep(100);
  check(await ev('__aq.sim.layers.length === 2'), 'undo brings the merged layer back');
  await ev(`__aq.togglePop('layerPop'); true`);

  // 7. QuickShape: hold at the end of a stroke
  await setT('paint', 'detail', 'payne', { size: 4 });
  await pen(line(200, 1150, 700, 1120, 40, 14), { pressure: () => 0.7, hold: 800 });
  check(await ev('window.__quick && !window.__quick.closed'), 'QuickShape snaps a held stroke to a line');
  const circ = Array.from({ length: 50 }, (_, i) => [1200 + Math.cos(i / 49 * 6.4) * 90 + Math.sin(i) * 4, 750 + Math.sin(i / 49 * 6.4) * 70]);
  await pen(circ, { pressure: () => 0.7, hold: 800 });
  check(await ev('window.__quick && window.__quick.closed'), 'QuickShape makes a held loop an ellipse');

  // 8. colour disc: dragging in the disc loads a custom colour
  await ev(`__aq.togglePop('colPop'); true`); await sleep(200);
  const dc = await ev(`(() => { const r = document.querySelector('#disc').getBoundingClientRect(); return [r.left + r.width * 0.62, r.top + r.height * 0.4]; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: dc[0], y: dc[1], button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await sleep(300);
  check(await ev(`__aq.S.pig[0].startsWith('custom:')`), 'colour disc picks a custom colour', await ev('__aq.S.pig[0]'));
  await shot('colour');
  await ev(`__aq.togglePop('colPop'); __aq.togglePop('brushPop'); true`); await sleep(200);
  await shot('brushes');
  await ev(`__aq.togglePop('brushPop'); true`);

  // 9. touch: pinch zoom, two-finger tap undo, finger painting
  await ev(`__aq.S.fingers = 'auto'; true`);
  const z0 = await ev('__aq.view.z');
  const [cx, cy] = [640, 430];
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 60, y: cy, id: 1 }, { x: cx + 60, y: cy, id: 2 }] });
  for (let i = 1; i <= 10; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 60 - i * 8, y: cy, id: 1 }, { x: cx + 60 + i * 8, y: cy, id: 2 }] }); await sleep(40); }
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
  await ev(`__aq.S.fingers = 'paint'; true`);
  await setT('paint', 'round', 'cadred', { size: 22 });
  const tp = []; for (const [x, y] of line(900, 1150, 1450, 1150, 30)) tp.push(await scr(x, y));
  const t0s = await stat(900, 1120, 1450, 1180);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tp[0][0], y: tp[0][1], id: 5 }] });
  for (const [x, y] of tp.slice(1)) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 5 }] }); await sleep(8); }
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(1500);
  const t1s = await stat(900, 1120, 1450, 1180);
  check(t1s.mean < t0s.mean - 3, 'finger paints', `${t0s.mean.toFixed(1)} -> ${t1s.mean.toFixed(1)}`);

  // 10. papers
  await ev(`__aq.togglePop('actPop'); document.querySelector('#actTabs [data-t="canvas"]').click(); true`); await sleep(200);
  await shot('actions');
  for (const i of [1, 2, 0]) await ev(`document.querySelectorAll('#paperList .item')[${i}].click(); true`);
  await ev(`__aq.togglePop('actPop'); true`);
  await waitDry(60);
  await shot('final');
  await ev(`(() => { const v = __aq.view; v.z = 2.5; v.r = 0; const p = __aq.toScreen(330, 290); v.x -= p.x - 400; v.y -= p.y - 300; __aq.redraw(); return true; })()`);
  await sleep(300); await shot('closeup'); await ev('__aq.fit(); true');

  // 11. export, autosave, time-lapse, reload restores the current painting
  await ev(`__aq.exportImage('png')`);
  const exp = await ev('window.__lastExport');
  check(exp && exp.w === W && exp.bytes > 20000, 'PNG export at canvas size', JSON.stringify(exp));
  await ev('__aq.save(true)');
  check((await ev('window.__saved || 0')) > 0, 'autosaves to IndexedDB');
  check((await ev('__aq.rec.count')) > 3, 'time-lapse frames recorded', String(await ev('__aq.rec.count')));
  const ref = await stat(0, 0, W, H), refLayers = await ev('__aq.sim.layers.length'), id0 = await ev('__aq.doc.id');
  check(await load('nohelp=1&nosw=1'), 'reload');
  await sleep(500);
  check(await ev(`__aq.doc.id === ${JSON.stringify(id0)} && __aq.sim.layers.length === ${refLayers}`), 'reload reopens the painting with its layers');
  const back = await stat(0, 0, W, H);
  check(Math.abs(back.mean - ref.mean) < 0.2, 'painting restored after reload', `${ref.mean.toFixed(2)} vs ${back.mean.toFixed(2)}`);

  // 12. gallery: new canvas, then back to the first painting
  await ev('__aq.openGallery()'); await sleep(400);
  const nCards = await ev('document.querySelectorAll("#ggrid .card").length');
  check(nCards >= 2, 'gallery lists paintings', String(nCards));
  await shot('gallery');
  await ev('__aq.createPainting(1200, 900); true'); await sleep(300);
  check(await ev('__aq.sim.W === 1200 && !document.querySelector("#gallery").classList.contains("open")'), 'new canvas from the gallery');
  await ev(`__aq.openById(${JSON.stringify(id0)})`); await sleep(400);
  check(Math.abs((await stat(0, 0, W, H)).mean - ref.mean) < 0.2, 'reopened from the gallery');

  // 13. timing of a sim step on a big wet area (SwiftShader is slow; a sanity bound)
  const ms = await ev(`(() => { const s = __aq.sim; s.begin(); s.stamp([{ x: 800, y: 600, r: 300, a: 1, wt: 0.8, el: 1, ex: 1, ey: 0 }], { mode: 1, shape: 1, bK: [0,0,0,0], bS: [0,0,0,0], mix: 0.1 }); const t = performance.now(); for (let i = 0; i < 5; i++) s.step(1/60); s.gl.finish(); return (performance.now() - t) / 5; })()`);
  console.log(`     big wet area step: ${ms.toFixed(0)} ms (SwiftShader, CPU)`);
  await ev('__aq.sim.discardLast(); true');

  // 14. iPad-sized touch layout and a phone
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 2, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  check(await load('nosw=1&nosave=1&nohelp=1'), 'loads at iPad size');
  await sleep(400); await shot('ipad');
  await ev(`__aq.togglePop('layerPop'); true`); await sleep(300); await shot('ipad_layers');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await ev('localStorage.clear(); true');
  check(await load('fresh=1&nosw=1&nosave=1&nohelp=1'), 'loads at phone size');
  check(await ev('__aq.sim.H > __aq.sim.W'), 'phone held upright gets a portrait canvas');
  await sleep(400); await shot('phone');
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await c.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

  // 15. offline: register the service worker, reload offline
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

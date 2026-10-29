// Headless check over the Chrome DevTools protocol, zero npm deps (SwiftShader WebGL2).
// Paints with real pen pointer events (pressure, tilt), touch and mouse through the
// floating toolbars and palette: flow and drying, mixing, glazing, undo/redo, lift, smudge, layers
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
// any Playwright Chromium: the shared cache, or a private one (~/.cache/aquarelle-chromium)
const PWS = [path.join(process.env.HOME, '.cache/ms-playwright'), path.join(process.env.HOME, '.cache/aquarelle-chromium')];
const CHROME = process.env.CHROME || PWS.filter((d) => fs.existsSync(d)).flatMap((PW) => fs.readdirSync(PW).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse().map((d) => path.join(PW, d, 'chrome-linux/chrome'))).find((f) => fs.existsSync(f));
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
  // the app is served at /, and the shared ../pwa/ of the other experiments at /pwa/
  const f = u.startsWith('/pwa/') ? path.join(DIR, '..', u) : path.join(DIR, u === '/' ? 'index.html' : u);
  const ok = f.startsWith(DIR) || f.startsWith(path.join(DIR, '..', 'pwa'));
  if (!ok || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
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
  const waitFor = async (expr, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
  const waitDry = async (max = 40) => { for (let i = 0; i < max * 4; i++) { if (!(await ev('__aq.sim.wet'))) return true; await sleep(250); } return false; };


  const setT = (tool, brush, pig, o = {}) => ev(`(() => { __aq.setTool('${tool}'); ${brush ? `__aq.selectBrush('${brush}');` : ''} ${pig ? `__aq.choosePigment('${pig}');` : ''} const id = __aq.S.sel['${tool}']; Object.assign('${tool}' === 'paint' ? __aq.S.brush[id] : __aq.S.tools['${tool}'], ${JSON.stringify(o)}); return true; })()`);

  // 0. a small landscape for the README
  if (!process.env.SKIP_SCENE) {
    await load('fresh=1&nohelp=1&nosw=1&nosave=1');
    await ev('__aq.createPainting(1600, 1200).then(() => true)');
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
    await ev('document.querySelectorAll(".panel").forEach((p) => (p.style.display = "none")); __aq.fit(); __aq.redraw(); true');
    await sleep(500); await shot('scene');
    await ev(`(() => { const v = __aq.view; v.z = 2; const p = __aq.toScreen(1200, 760); v.x -= p.x - 640; v.y -= p.y - 430; __aq.redraw(); return true; })()`);
    await sleep(500); await shot('scene_closeup');
    check(errors().length === 0, 'scene painted without errors', errors().join(' | '));
  }

  check(await load('fresh=1&nohelp=1&nosw=1'), 'loads');
  check(errors().length === 0, 'no console errors on load', errors().join(' | '));
  check(await ev('__aq.sim.W > 1000 && __aq.sim.H > 600 && !!__aq.doc.id'), 'first visit opens a screen-shaped canvas');
  await ev('__aq.createPainting(1600, 1200).then(() => true)');
  // the page now fills the screen under the floating panels: zoom out a little so every
  // test stroke lands on the page, not on the palette
  await ev('__aq.fit(0.8); true');
  const W = await ev('__aq.sim.W'), H = await ev('__aq.sim.H');
  await sleep(300); await shot('ui');

  // 1. pen strokes with pressure: round brush, ultramarine
  await setT('paint', 'round', 'ultra');
  const s0 = await stat(200, 400, 700, 500);
  await pen(line(200, 300, 700, 260, 60, 6));
  await sleep(1500);
  check(await ev('__aq.sim.wet'), 'pen stroke makes the paper wet');
  let s1 = await stat(200, 230, 700, 330);
  // under heavy CPU load the first read can come before the frame that composites the stroke
  for (let i = 0; i < 10 && s1.mean >= s0.mean - 4; i++) { await sleep(300); s1 = await stat(200, 230, 700, 330); }
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
  await waitFor('!__aq.stroke'); // under load the pen-up can still be in the queue
  await sel('#undoBtn'); await sleep(400);
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

  // 7. QuickShape (off by default now): hold at the end of a stroke
  check(!(await ev('__aq.S.quick')), 'QuickShape is off by default');
  await ev('__aq.S.quick = true; true');
  await setT('paint', 'detail', 'payne', { size: 4 });
  await pen(line(200, 1150, 700, 1120, 40, 14), { pressure: () => 0.7, hold: 1200 });
  check(await ev('window.__quick && !window.__quick.closed'), 'QuickShape snaps a held stroke to a line');
  const circ = Array.from({ length: 50 }, (_, i) => [1200 + Math.cos(i / 49 * 6.4) * 90 + Math.sin(i) * 4, 750 + Math.sin(i / 49 * 6.4) * 70]);
  await pen(circ, { pressure: () => 0.7, hold: 1200 });
  check(await ev('window.__quick && window.__quick.closed'), 'QuickShape makes a held loop an ellipse');
  // undo after QuickShape gives the hand-drawn loop back, undo again removes it, redo twice
  {
    await waitFor('!__aq.stroke'); await ev('__aq.sim.dryNow(); true');
    const box2 = [1080, 650, 1320, 850];
    const shapeS = await stat(...box2);
    await ev('window.__pxShape = __aq.sim.exportPixels(); true');
    await sel('#undoBtn'); await sleep(300); await ev('__aq.sim.dryNow(); true');
    const handS = await stat(...box2);
    // pixels that differ between the shape and the stroke undo gave back (a hand loop is close to an ellipse)
    const differ = await ev(`(() => { const a = window.__pxShape, b = __aq.sim.exportPixels(); let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++; return n; })()`);
    await sel('#undoBtn'); await sleep(300);
    const noneS = await stat(...box2);
    check(handS.mean < noneS.mean - 2 && differ > 300, 'undo after QuickShape gives your own stroke back', `${differ} px differ from the shape; stroke ${handS.mean.toFixed(1)}, none ${noneS.mean.toFixed(1)}`);
    await sel('#redoBtn'); await sleep(300); await sel('#redoBtn'); await sleep(300);
    const reS = await stat(...box2);
    check(Math.abs(reS.mean - shapeS.mean) < 0.3, 'redo goes forward to the shape again', `${reS.mean.toFixed(1)} vs ${shapeS.mean.toFixed(1)}`);
  }
  // shading back and forth that ends near its start, then a rest: stays as drawn
  await ev('window.__quick = null; true');
  const zz = []; for (let i = 0; i < 14; i++) zz.push([300 + (i % 2) * 260, 300 + i * 12]);
  const zd = []; for (let i = 1; i < zz.length; i++) for (let t = 0; t < 1; t += 0.1) zd.push([zz[i - 1][0] + (zz[i][0] - zz[i - 1][0]) * t, zz[i - 1][1] + (zz[i][1] - zz[i - 1][1]) * t]);
  zd.push([320, 320], [310, 310]);
  await pen(zd, { pressure: () => 0.7, hold: 900 });
  check(!(await ev('window.__quick')), 'resting after shading back and forth does not snap it to an ellipse');
  // undo of a stroke over most of the sheet: used to need a second copy of the whole sheet,
  // ran out of room, lost the step and every later undo
  await ev('__aq.sim.dryNow(); true');
  const bigBefore = await stat(100, 100, W - 100, H - 100);
  await setT('paint', 'wash', 'ultra', { size: 75, water: 0.8 });
  const zig = []; for (let y = 60; y < H - 60; y += 90) zig.push([60, y], [W - 60, y + 45]);
  const zigD = []; for (let i = 1; i < zig.length; i++) for (let t = 0; t < 1; t += 0.05) zigD.push([zig[i - 1][0] + (zig[i][0] - zig[i - 1][0]) * t, zig[i - 1][1] + (zig[i][1] - zig[i - 1][1]) * t]);
  await pen(zigD, { pressure: () => 0.8 });
  await sleep(600);
  check((await stat(100, 100, W - 100, H - 100)).mean < bigBefore.mean - 10, 'a wash over the whole sheet');
  await waitFor('!__aq.stroke');
  await sel('#undoBtn'); await sleep(400);
  const bigAfter = await stat(100, 100, W - 100, H - 100);
  check(Math.abs(bigAfter.mean - bigBefore.mean) < 0.5, 'undo takes back a stroke over the whole sheet', `${bigBefore.mean.toFixed(1)} vs ${bigAfter.mean.toFixed(1)}`);
  await sel('#redoBtn'); await sleep(300); await sel('#undoBtn'); await sleep(300);
  const room = await ev(`(() => { const s = __aq.sim, recs = new Set([...s.undo, ...s.redo]); for (const r of [...recs]) if (r.hand) recs.add(r.hand); let held = 0; for (const r of recs) held += r.tiles?.length || 0; return [s.atlas.free.length, held, s.atlas.cols * s.atlas.rows]; })()`);
  check(Math.abs((await stat(100, 100, W - 100, H - 100)).mean - bigBefore.mean) < 0.5 && room[0] + room[1] === room[2], 'redo and undo again, and no undo room lost', `${room[0]} free + ${room[1]} held of ${room[2]}`);

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
  // (the whole-sheet wash above filled the undo room: a fresh stroke to undo)
  await setT('paint', 'round', 'ultra', { size: 20 }); await pen(line(300, 200, 600, 220, 20)); await waitFor('!__aq.stroke');
  await sleep(400); // pen events just now: touches are ignored for 300 ms (palm rejection)
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
  await ev('__aq.fit(0.8); true'); await sleep(200);
  // palm rejection: with the pen down, a palm on the screen does not pan, zoom, paint or undo
  {
    const v0 = await ev('JSON.stringify([__aq.view.x, __aq.view.y, __aq.view.z])'), u0 = await ev('__aq.sim.undo.length');
    const pp = await scr(300, 900), pq = await scr(700, 900);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pp[0], y: pp[1], button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6 });
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 900, y: 700, id: 11 }, { x: 980, y: 720, id: 12 }] });
    for (let i = 1; i <= 8; i++) {
      await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 900 - i * 12, y: 700 + i * 6, id: 11 }, { x: 980 + i * 10, y: 720, id: 12 }] });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pp[0] + (pq[0] - pp[0]) * i / 8, y: pp[1], button: 'left', buttons: 1, pointerType: 'pen', force: 0.6 });
      await sleep(30);
    }
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pq[0], y: pq[1], button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
    await sleep(200);
    check((await ev('JSON.stringify([__aq.view.x, __aq.view.y, __aq.view.z])')) === v0, 'a palm while the pen is down does not move or zoom the page');
    check((await ev('__aq.sim.undo.length')) === u0 + 1, 'the pen stroke is kept and the palm adds nothing', `${u0} -> ${await ev('__aq.sim.undo.length')}`);
    // a palm already resting when the pen lands is dropped too
    await sleep(400);
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 900, y: 700, id: 13 }] });
    await sleep(80);
    for (let i = 1; i <= 4; i++) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 900 + i * 6, y: 700 + i * 3, id: 13 }] }); await sleep(20); }
    const u1 = await ev('__aq.sim.undo.length');
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pp[0], y: pp[1] + 60, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pq[0], y: pp[1] + 60, button: 'left', buttons: 1, pointerType: 'pen', force: 0.6 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pq[0], y: pp[1] + 60, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(200);
    check((await ev('__aq.sim.undo.length')) <= u1 + 1, 'a palm resting before the pen lands is taken back', `${u1} -> ${await ev('__aq.sim.undo.length')}`);
    await sleep(400);
  }
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
  await ev('__aq.createPainting(1200, 900).then(() => true)'); await sleep(300);
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

  // 15. pen mode on a Bigme B7 Pro-sized e-paper screen (7", 1264 x 1680, CSS 632 x 840 at 2x)
  await c.send('Emulation.setDeviceMetricsOverride', { width: 632, height: 840, deviceScaleFactor: 2, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  check(await load('fresh=1&nosw=1&nosave=1&nohelp=1&eink=1'), 'loads on a 7" e-paper screen');
  check(await ev('document.body.classList.contains("eink")'), 'e-paper theme');
  await ev(`__aq.createPainting(1264, 1680, 'Notes', 1).then(() => { __aq.setMode('pen'); return true; })`); await sleep(400);
  const z125 = await ev('__aq.view.z / __aq.baseZ()'), top125 = await ev(`(() => { const a = __aq.toScreen(0, 0), A = __aq.freeArea(); return Math.abs(a.y - A.top) < 1 && Math.abs(a.x - A.left) < 1; })()`);
  check(Math.abs(z125 - 1.25) < 0.01 && top125, 'a 7" screen opens pages at 125%, from the top left', (z125 * 100).toFixed(0) + '%');
  await ev('__aq.fit(1); true'); await sleep(200);
  check(await ev('document.body.classList.contains("penmode") && getComputedStyle(document.querySelector("#penBar")).display === "flex"'), 'pen mode shows nibs and ink colours');
  // fits the whole screen below the top bar (the other panels float over it)
  const fitOk = await ev(`(() => { const a = __aq.toScreen(0, 0), b = __aq.toScreen(__aq.sim.W, __aq.sim.H), top = Math.max(document.querySelector('#topL').getBoundingClientRect().bottom, document.querySelector('#topR').getBoundingClientRect().bottom); return a.y >= top - 1 && b.y <= innerHeight && a.x >= 0 && b.x <= innerWidth && (b.x - a.x > innerWidth - 30 || b.y - a.y > innerHeight - top - 30); })()`);
  check(fitOk, 'the whole page fills the screen below the top bar');
  const tgt = await ev(`[...document.querySelectorAll('.panel button:not(.grip)')].filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); }).sort((a, b) => a - b)[0]`);
  check(tgt >= 30, 'touch targets at least 30 CSS px (≈ 5 mm on the B7 Pro)', tgt.toFixed(0) + ' px');
  const grp = await ev(`[...document.querySelectorAll('.panel .grip')].filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return [Math.min(r.width, r.height), Math.max(r.width, r.height)]; })`);
  check(grp.length && grp.every(([a, b]) => a >= 22 && b >= 34), 'panel grips at least 22 × 34 px', JSON.stringify(grp));
  // handwriting: a few cursive-ish words as pen strokes
  const word = (x0, y0, n) => { const pts = []; for (let i = 0; i <= n * 12; i++) { const t = i / 12; pts.push([x0 + t * 34, y0 - 26 * Math.abs(Math.sin(t * Math.PI * 0.9)) + 6 * Math.sin(t * 7)]); } return pts; };
  const ls = await ev('__aq.sim.pattern.sp');
  const n0 = await stat(150, ls * 3 - 40, 1100, ls * 3 + 10);
  for (let w = 0; w < 4; w++) await pen(word(170 + w * 230, ls * 3 - 4, 5), { pressure: (t) => 0.5 + 0.3 * Math.sin(t * 20) });
  await sleep(200);
  check(!(await ev('__aq.sim.wet')), 'pen ink is dry immediately (no water)');
  const n1 = await stat(150, ls * 3 - 40, 1100, ls * 3 + 10);
  check(n1.mean < n0.mean - 4, 'pen writes ink', `${n0.mean.toFixed(1)} -> ${n1.mean.toFixed(1)}`);
  // colour from the bar: red, then a fineliner line
  await ev(`document.querySelector('#penCols [data-col="#d02424"]').click(); document.querySelector('#nibs [data-nib="fineliner"]').click(); true`);
  await pen(line(170, ls * 4 - 6, 900, ls * 4 - 6, 40), { pressure: () => 0.6 });
  const red = await ev(`(() => { const px = __aq.sim.exportPixels(); const W = __aq.sim.W, y = Math.round(${ls} * 4 - 6); let r = 0, g = 0, n = 0; for (let x = 200; x < 880; x += 4) { const i = (y * W + x) * 4; r += px[i]; g += px[i + 1]; n++; } return [r / n, g / n]; })()`);
  check(red[0] > red[1] + 60, 'ink colour from the pen bar', red.map((v) => v.toFixed(0)).join(','));
  // highlighter over the first line keeps the writing readable
  await ev(`document.querySelector('#nibs [data-nib="highlighter"]').click(); true`);
  await pen(line(160, ls * 3 - 14, 1100, ls * 3 - 14, 40), { pressure: () => 0.6 });
  const hl = await stat(150, ls * 3 - 40, 1100, ls * 3 + 10);
  check(hl.dark > n1.dark * 0.8, 'highlighter does not cover the ink', `${n1.dark.toFixed(3)} / ${hl.dark.toFixed(3)}`);
  await shot('eink_notes');
  // eraser nib, then undo
  await ev(`document.querySelector('#nibs [data-nib="inkerase"]').click(); __aq.S.pen.size.inkerase = 20; true`);
  for (let k = 0; k < 3; k++) await pen(line(170, ls * 4 - 6 + (k - 1) * 8, 900, ls * 4 - 6 + (k - 1) * 8, 40), { pressure: () => 0.8 });
  const er = await ev(`(() => { const px = __aq.sim.exportPixels(); const W = __aq.sim.W, y = Math.round(${ls} * 4 - 6); let r = 0, g = 0, n = 0; for (let x = 200; x < 880; x += 4) { const i = (y * W + x) * 4; r += px[i]; g += px[i + 1]; n++; } return [r / n, g / n]; })()`);
  check(Math.abs(er[0] - er[1]) < 30, 'eraser nib rubs ink out', er.map((v) => v.toFixed(0)).join(','));
  await sel('#undoBtn'); await sleep(100); await sel('#undoBtn'); await sel('#undoBtn'); await sleep(100);
  // colour disc in pen mode sets the ink colour
  await ev(`document.querySelector('#nibs [data-nib="ballpoint"]').click(); __aq.togglePop('colPop'); true`); await sleep(300);
  await shot('eink_colour');
  const dc2 = await ev(`(() => { const r = document.querySelector('#disc').getBoundingClientRect(); return [r.left + r.width * 0.94, r.top + r.height * 0.5]; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: dc2[0], y: dc2[1], button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await sleep(200);
  check(await ev(`__aq.S.pen.col !== '#d02424'`), 'colour disc sets the ink colour', await ev('__aq.S.pen.col'));
  await ev(`__aq.togglePop('colPop'); true`);
  // the stylus's eraser end erases (buttons 32)
  await ev(`__aq.S.pen.size.ballpoint = 2.4; true`);
  const sp0 = await scr(200, ls * 6), sp1 = await scr(800, ls * 6);
  await pen(line(200, ls * 6, 800, ls * 6, 30), { pressure: () => 0.7 });
  const e0 = await stat(200, ls * 6 - 8, 800, ls * 6 + 8);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp0[0], y: sp0[1], button: 'left', buttons: 33, clickCount: 1, pointerType: 'pen', force: 0.8 });
  for (let i = 1; i <= 30; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sp0[0] + (sp1[0] - sp0[0]) * i / 30, y: sp0[1], button: 'left', buttons: 33, pointerType: 'pen', force: 0.8 }); await sleep(6); }
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp1[0], y: sp1[1], button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  const e1 = await stat(200, ls * 6 - 8, 800, ls * 6 + 8);
  console.log(`     stylus eraser end: ${e0.mean.toFixed(1)} -> ${e1.mean.toFixed(1)} (CDP may not deliver button 32)`);
  await ev(`__aq.togglePop('actPop'); document.querySelector('#actTabs [data-t="canvas"]').click(); true`); await sleep(200);
  await shot('eink_canvas');
  await ev(`__aq.togglePop('actPop'); __aq.setMode('paint'); true`); await sleep(300);
  await shot('eink_paint');
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await c.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

  // 16. notebooks: pages, zoom buttons, two-finger gesture lock (B7 Pro size, saving on)
  await c.send('Emulation.setDeviceMetricsOverride', { width: 632, height: 840, deviceScaleFactor: 2, mobile: true });
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  check(await load('fresh=1&nosw=1&nohelp=1&eink=1'), 'loads for a notebook');
  await ev(`__aq.createPainting(1264, 1680, 'Notebook test', 1).then(() => { __aq.setMode('pen'); __aq.fit(1); return true; })`); await sleep(400);
  const lsp = await ev('__aq.sim.pattern.sp');
  const band = (k) => stat(180, Math.round(lsp * k - 14), 920, Math.round(lsp * k + 14));
  const blank1 = await band(3);
  await pen(line(200, lsp * 3, 900, lsp * 3, 30), { pressure: () => 0.7 });
  const p1 = await band(3);
  check(p1.mean < blank1.mean - 3, 'writes on page 1');
  check(await ev(`getComputedStyle(document.querySelector('#pages')).display !== 'none' && document.querySelector('#pgNum').textContent.trim() === '1 / 1'`), 'page control shows 1 / 1 in pen mode');
  check(await ev(`document.querySelector('#pgNext').disabled`), '› is off on the last page');
  await sel('#pgNew');
  check(await waitFor('__aq.doc.pages.length === 2 && __aq.doc.page === 1'), 'the + in the page bar adds a page');
  check(Math.abs((await band(3)).mean - blank1.mean) < 1, 'the new page is blank');
  check(await ev(`document.querySelector('#pgNum').textContent.trim() === '2 / 2'`), 'page control shows 2 / 2');
  await pen(line(200, lsp * 6, 900, lsp * 6, 30), { pressure: () => 0.7 });
  const p2 = await band(6);
  await sel('#pgPrev');
  check(await waitFor('__aq.doc.page === 0'), '‹ goes back to page 1');
  check(Math.abs((await band(3)).mean - p1.mean) < 0.5 && Math.abs((await band(6)).mean - blank1.mean) < 1, 'page 1 has its own ink, not page 2\'s');
  await sel('#pgNext');
  const okp = await waitFor('__aq.doc.page === 1');
  check(okp && Math.abs((await band(6)).mean - p2.mean) < 0.5, 'and page 2 still has its ink');
  await sel('#pgNum'); await sleep(400);
  check(await ev(`document.querySelectorAll('#pageGrid .pg').length === 2 && document.querySelectorAll('#pageGrid .pg')[1].classList.contains('on')`), 'page list shows both pages');
  await shot('eink_pages');
  await ev(`__aq.togglePop('pagePop'); true`);
  await ev('__aq.save(true)');
  check(await load('nosw=1&nohelp=1&eink=1'), 'reload the notebook'); await sleep(600);
  check(await ev('__aq.doc.pages.length === 2 && __aq.doc.page === 1'), 'reopens at the page it was on, with both pages');
  check(Math.abs((await band(6)).mean - p2.mean) < 0.5, 'page 2 restored');
  await ev('__aq.openGallery()'); await sleep(400);
  check(await ev(`document.querySelector('#ggrid').textContent.includes('2 pages')`), 'gallery card says 2 pages');
  await ev(`document.querySelector('#galBack').click(); true`);
  await ev('window.confirm = () => true; true');
  await ev('__aq.deletePage(1)');
  check(await waitFor('__aq.doc.pages.length === 1 && __aq.doc.page === 0') && Math.abs((await band(3)).mean - p1.mean) < 0.5, 'deleting page 2 leaves page 1');

  // zoom buttons
  await ev('__aq.fit(1); true'); await sleep(200);
  const zb = await ev('__aq.view.z');
  await sel('#zoomIn'); await sleep(300);
  check(Math.abs((await ev('__aq.view.z')) / zb - 1.25) < 0.01 && (await ev(`document.querySelector('#zoomPct').textContent`)) === '125%', '+ zooms in by a quarter, % shows it');
  await sel('#zoomIn'); await sel('#zoomOut'); await sel('#zoomOut'); await sleep(300);
  check(Math.abs((await ev('__aq.view.z')) / zb - 1) < 0.01, '− zooms back out (snaps to the whole page)');
  await sel('#zoomPct'); await sleep(200);
  check(Math.abs((await ev('__aq.view.z / __aq.baseZ()')) - 1.25) < 0.01, 'tapping the % goes to the zoom pages open at');
  await sel('#zoomPct'); await sleep(200);
  check(Math.abs((await ev('__aq.view.z / __aq.baseZ()')) - 1) < 0.01, 'and back to the whole page');

  // two fingers moving together pan only, even with a little twist and spread in them
  const tv = async () => ev('[__aq.view.x, __aq.view.y, __aq.view.z, __aq.view.r]');
  const touchPath = async (frames) => {
    await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: frames[0].map(([x, y], i) => ({ x, y, id: 20 + i })) });
    for (const f of frames.slice(1)) { await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: f.map(([x, y], i) => ({ x, y, id: 20 + i })) }); await sleep(30); }
    await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(150);
  };
  await ev('__aq.S.rotate = true; __aq.fit(1.5); true'); await sleep(200);
  let g0 = await tv();
  await touchPath(Array.from({ length: 14 }, (_, i) => [[200 + i * 8, 400 + i * 6 + i * 1.2], [330 + i * 8 + i * 0.6, 400 + i * 6 - i * 1.2]]));
  let g1 = await tv();
  check(g1[3] === 0 && Math.abs(g1[2] - g0[2]) < 1e-9 && Math.hypot(g1[0] - g0[0], g1[1] - g0[1]) > 50, 'two-finger pan stays a pan: no rotation, no zoom', `moved ${Math.hypot(g1[0] - g0[0], g1[1] - g0[1]).toFixed(0)} px, r ${g1[3]}, z ${(g1[2] / g0[2]).toFixed(4)}`);
  // spreading zooms without rotating, even with a little twist
  g0 = await tv();
  await touchPath(Array.from({ length: 12 }, (_, i) => [[260 - i * 9, 420 + i * 0.8], [380 + i * 9, 420 - i * 0.8]]));
  g1 = await tv();
  check(g1[3] === 0 && g1[2] > g0[2] * 1.3, 'spreading two fingers zooms, without rotating', `z ×${(g1[2] / g0[2]).toFixed(2)}`);
  // a deliberate twist rotates (Prefs → Rotate on)
  await ev('__aq.fit(1); true'); await sleep(100);
  await touchPath(Array.from({ length: 12 }, (_, i) => { const a = i * 0.05, cx = 316, cy = 420, r = 70; return [[cx - r * Math.cos(a), cy - r * Math.sin(a)], [cx + r * Math.cos(a), cy + r * Math.sin(a)]]; }));
  g1 = await tv();
  check(Math.abs(g1[3]) > 0.3, 'a twist from the start rotates', `r ${g1[3].toFixed(2)}`);
  await ev('__aq.S.rotate = false; __aq.fit(1); true');
  await touchPath(Array.from({ length: 12 }, (_, i) => { const a = i * 0.05, cx = 316, cy = 420, r = 70; return [[cx - r * Math.cos(a), cy - r * Math.sin(a)], [cx + r * Math.cos(a), cy + r * Math.sin(a)]]; }));
  check((await tv())[3] === 0, 'and never with rotation turned off');
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await c.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  check(errors().length === 0, 'no console errors (notebook)', errors().join(' | '));

  // 16b. compact sliders, zoom slider, tool labels, pastel, infinite page (B7 Pro size)
  await c.send('Emulation.setDeviceMetricsOverride', { width: 632, height: 840, deviceScaleFactor: 2, mobile: true });
  check(await load('fresh=1&nosw=1&nohelp=1&nosave=1&eink=1'), 'loads for the new controls');
  await ev(`__aq.createPainting(1264, 1680).then(() => { __aq.useBrush('round'); return true; })`); await sleep(300);
  const slw = await ev(`document.querySelector('#sliders').getBoundingClientRect().width`);
  check(slw <= 52, 'size / water / paint fit one slim column', slw.toFixed(0) + ' px wide');
  const chipVals = await ev(`[...document.querySelectorAll('#sliders .chip:not([hidden]) b')].map((b) => b.textContent)`);
  check(chipVals.length === 3 && chipVals.every((v) => v), 'chips show all three values', chipVals.join(' / '));
  // tap the water chip: the slider moves water
  const wch = await ev(`(() => { const r = document.querySelector('#sliders .chip[data-k="water"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: wch[0], y: wch[1], button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await sleep(100);
  const w0 = await ev('__aq.S.brush.round.water'), size0 = await ev('__aq.S.brush.round.size');
  const trP = await ev(`(() => { const r = document.querySelector('#slTrack .track').getBoundingClientRect(); return [r.left + r.width / 2, r.top, r.bottom]; })()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: trP[0], y: trP[1] + 8, button: 'left', buttons: 1, clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: trP[0], y: trP[1] + 8, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(100);
  check(await ev(`document.querySelector('#sliders').dataset.k === 'water'`) && (await ev('__aq.S.brush.round.water')) > Math.max(w0, 0.9) && (await ev('__aq.S.brush.round.size')) === size0, 'tapping a chip puts its value on the slider', `water ${w0.toFixed(2)} -> ${(await ev('__aq.S.brush.round.water')).toFixed(2)}`);
  // drag up on the size chip changes size directly
  const sch = await ev(`(() => { const r = document.querySelector('#sliders .chip[data-k="size"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sch[0], y: sch[1], button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++) await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: sch[0], y: sch[1] - i * 6, button: 'left', buttons: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sch[0], y: sch[1] - 48, button: 'left', buttons: 0, clickCount: 1 });
  check((await ev('__aq.S.brush.round.size')) > size0 * 1.2, 'dragging on the size chip changes the size', `${size0.toFixed(1)} -> ${(await ev('__aq.S.brush.round.size')).toFixed(1)}`);
  // zoom slider
  await ev('__aq.fit(1); true'); await sleep(150);
  const zt = await ev(`(() => { const r = document.querySelector('#zoomPct').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const zr0 = await ev('__aq.view.z / __aq.baseZ()');
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: zt[0], y: zt[1], button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: zt[0], y: zt[1] - i * 8, button: 'left', buttons: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: zt[0], y: zt[1] - 80, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(150);
  const zr1 = await ev('__aq.view.z / __aq.baseZ()');
  check(zr1 > zr0 * 2, 'dragging up on the % zooms in', `${(zr0 * 100).toFixed(0)}% -> ${(zr1 * 100).toFixed(0)}%`);
  check(await ev(`document.querySelector('#zoomPct').textContent`) === Math.round(zr1 * 100) + '%', 'and the % follows it');
  const zh = await ev(`document.querySelector('#zoomBar').getBoundingClientRect().height`);
  check(zh < 140, 'the zoom bar is compact', zh.toFixed(0) + ' px tall');
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: zt[0], y: zt[1], button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await sleep(150);
  const zr2 = await ev('__aq.view.z / __aq.baseZ()');
  check(zr2 < zr1 * 0.8, 'tapping the % goes back to the page', `${(zr2 * 100).toFixed(0)}%`);
  await ev('__aq.fit(1); true');
  // tapping a tool shows its name
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const wb = await ev(`(() => { const r = document.querySelector('#tools [data-brush="wash"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: wb[0], y: wb[1], id: 40 }] });
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);
  const labP = await ev(`(() => { const l = document.querySelector('#tipLabel'); return l.style.display === 'block' ? l.textContent : ''; })()`);
  check(/Wash/.test(labP), 'tapping a tool shows its name', labP);
  await shot('eink_label');
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await sleep(1700);
  check(await ev(`document.querySelector('#tipLabel').style.display === 'none'`), 'and the name goes away by itself');

  // pastel: catches the paper's grain lightly, fills it when pressed, covers a dark wash
  await ev(`(() => { __aq.useBrush('round'); __aq.choosePigment('payne'); Object.assign(__aq.S.brush.round, { size: 40, water: 0.6, paint: 0.9 }); return true; })()`);
  // a dark band of dried pigment (ink stamps: a watercolour stroke runs out of paint along the way)
  await ev(`(() => { const st = []; for (let x = 200; x <= 1000; x += 6) st.push({ x, y: 300, r: 26, a: 1, ex: 1, ey: 0, el: 1 }); __aq.sim.ink(st, { mode: 5, bK: [2.5, 2.2, 1.8, 0], bS: [0.05, 0.05, 0.05, 0.3], cover: 1 }); __aq.sim.dryNow(); return true; })()`);
  const darkBg = await stat(300, 290, 900, 310);
  await ev(`(() => { __aq.useBrush('pastel'); __aq.choosePigment('hansa'); Object.assign(__aq.S.brush.pastel, { size: 30, paint: 0.6 }); return true; })()`);
  check(await ev(`!document.querySelector('#sliders .chip[data-k="water"]').offsetParent || document.querySelector('#sliders .chip[data-k="water"]').hidden`), 'pastel has no water chip');
  for (let k = 0; k < 2; k++) await pen(line(200, 300, 1000, 300, 40), { pressure: () => 0.95 });
  const coveredP = await stat(300, 290, 900, 310);
  check(coveredP.mean > darkBg.mean + 40, 'opaque pastel covers a dark wash', `${darkBg.mean.toFixed(0)} -> ${coveredP.mean.toFixed(0)}`);
  const pv = (y) => ev(`(() => { const px = __aq.sim.exportPixels(); const W = __aq.sim.W; const v = []; for (let x = 320; x < 880; x += 2) { const i = (${y} * W + x) * 4; v.push((px[i] + px[i + 1] + px[i + 2]) / 3); } const m = v.reduce((a, b) => a + b) / v.length; return { m, marked: v.filter((q) => q < 245).length / v.length }; })()`);
  await pen(line(200, 600, 1000, 600, 40), { pressure: () => 0.2 });
  await pen(line(200, 800, 1000, 800, 40), { pressure: () => 1 });
  await pen(line(200, 800, 1000, 800, 40), { pressure: () => 1 });
  const lightP = await pv(600), heavyP = await pv(800);
  check(lightP.marked > 0.05 && lightP.marked < 0.85 && heavyP.marked > lightP.marked + 0.1, 'a lightP pastel stroke catches only the grain; pressing fills it', `marked ${(lightP.marked * 100).toFixed(0)}% vs ${(heavyP.marked * 100).toFixed(0)}%`);
  check(!(await ev('__aq.sim.wet')), 'pastel is dry');
  await shot('pastel');
  // smudge drags pastel
  const sm0P = await stat(560, 820, 640, 900);
  await ev(`(() => { __aq.setTool('smudge'); Object.assign(__aq.S.tools.smudge, { size: 30, paint: 1 }); return true; })()`);
  for (let k = 0; k < 3; k++) await pen(line(600, 790, 600, 900, 20), { pressure: () => 1 });
  const sm1P = await stat(560, 820, 640, 900);
  check(sm1P.mean < sm0P.mean - 0.5, 'smudge drags pastel', `${sm0P.mean.toFixed(1)} -> ${sm1P.mean.toFixed(1)}`);

  // infinite page: write, pan far away, write, come backP; it saves and reopens
  const scr2 = async (x, y) => ev(`(() => { const c = document.querySelector('#gl'), gl = __aq.sim.gl; __aq.render(); const px = new Uint8Array(4 * 81); const b = c.getBoundingClientRect(), d = c.width / b.width; gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(Math.round((${x} - b.left) * d) - 4, Math.round(c.height - (${y} - b.top) * d) - 4, 9, 9, gl.RGBA, gl.UNSIGNED_BYTE, px); let m = 255 * 3; for (let i = 0; i < 81; i++) m = Math.min(m, px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]); return m / 3; })()`);
  const dragBy = async (dx, dy, steps = 10) => { // middle-button drag = pan
    const x0 = 300, y0 = 400;
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'middle', buttons: 4, clickCount: 1 });
    for (let i = 1; i <= steps; i++) { await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + dx * i / steps, y: y0 + dy * i / steps, button: 'middle', buttons: 4 }); await sleep(30); }
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0 + dx, y: y0 + dy, button: 'middle', buttons: 0, clickCount: 1 });
    await sleep(120);
  };
  check(await load('fresh=1&nosw=1&nohelp=1&eink=1'), 'loads for an infinite page');
  await ev(`__aq.createPainting(1264, 1680, 'Infinite test', 1, true).then(() => { __aq.setMode('pen'); return true; })`); await sleep(600);
  check(await ev('__aq.sim.infinite && !!__aq.world'), 'an infinite page opens');
  // world-space ink at a screen point: write a short line there
  const inkAt = async (cx, cy) => { const pts = []; for (let i = 0; i < 12; i++) { const p = await ev(`(() => { const p = __aq.toSheet(${cx - 30 + i * 5}, ${cy}); return [p.x, p.y]; })()`); pts.push(p); } await pen(pts, { pressure: () => 0.8 }); };
  await ev(`(() => { __aq.setNib('fineliner'); __aq.S.pen.size.fineliner = 4; return true; })()`);
  await inkAt(320, 300);
  const worldPt = await ev(`(() => { const p = __aq.toSheet(320, 300); return [p.x + __aq.sim.origin[0], p.y + __aq.sim.origin[1]]; })()`);
  check((await scr2(320, 300)) < 120, 'writes on the infinite page');
  const shifts0 = await ev('window.__shifts || 0');
  for (let k = 0; k < 8; k++) await dragBy(-420, -150); // far to the right and down
  await sleep(300);
  const travelled = await ev(`(() => { const p = __aq.toSheet(320, 300); return [p.x + __aq.sim.origin[0], p.y + __aq.sim.origin[1]]; })()`);
  const distP = Math.hypot(travelled[0] - worldPt[0], travelled[1] - worldPt[1]);
  check(distP > 4000 && (await ev('window.__shifts || 0')) > shifts0, 'pans far beyond the first window (the window moves)', `${distP.toFixed(0)} px away, ${(await ev('window.__shifts || 0')) - shifts0} moves`);
  check((await scr2(320, 300)) > 200, 'fresh paper far away');
  await inkAt(320, 300);
  const farPt = travelled;
  check((await scr2(320, 300)) < 120, 'writes far away too');
  for (let k = 0; k < 8; k++) await dragBy(420, 150);
  await sleep(500);
  for (let i = 0; i < 20 && Math.abs((await ev('__aq.sim.origin[0]')) - 0) > 4096; i++) await sleep(100);
  const backP = await ev(`(() => { const q = __aq.toScreen(${worldPt[0]} - __aq.sim.origin[0], ${worldPt[1]} - __aq.sim.origin[1]); return [q.x, q.y]; })()`);
  check(Math.abs(backP[0] - 320) < 40 && Math.abs(backP[1] - 300) < 40, 'pans backP to the start', backP.map((v) => v.toFixed(0)).join(','));
  check((await scr2(backP[0], backP[1])) < 120, 'the first writing came backP from its tiles');
  await shot('infinite');
  await ev('__aq.save(true)');
  check(await load('nosw=1&nohelp=1&eink=1'), 'reload the infinite page'); await sleep(800);
  check(await ev('__aq.sim.infinite'), 'reopens as an infinite page');
  const back2 = await ev(`(() => { const q = __aq.toScreen(${worldPt[0]} - __aq.sim.origin[0], ${worldPt[1]} - __aq.sim.origin[1]); return [q.x, q.y]; })()`);
  check((await scr2(back2[0], back2[1])) < 120, 'first writing restored after reload', back2.map((v) => v.toFixed(0)).join(','));
  for (let k = 0; k < 8; k++) await dragBy(-420, -150);
  await sleep(500);
  const far2 = await ev(`(() => { const q = __aq.toScreen(${farPt[0]} - __aq.sim.origin[0], ${farPt[1]} - __aq.sim.origin[1]); return [q.x, q.y]; })()`);
  check(far2[0] > 0 && far2[0] < 632 && (await scr2(far2[0], far2[1])) < 120, 'far writing restored too', far2.map((v) => v.toFixed(0)).join(','));
  check(errors().length === 0, 'no console errors (new controls, pastel, infinite page)', errors().join(' | '));
  const tapAt = async ([x, y]) => { for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); };
  // one tap hides every panel, the faint eye left in the corner brings them back
  check(await load('fresh=1&nosw=1&nohelp=1&nosave=1&eink=1'), 'loads for hide all'); await sleep(300);
  const v0 = await ev('[__aq.view.x, __aq.view.y, __aq.view.z]');
  await tapAt(await ev(`(() => { const r = document.querySelector('#hideBtn').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`)); await sleep(300);
  check(await ev(`document.body.classList.contains('ui-hidden') && [...document.querySelectorAll('.panel')].every((p) => getComputedStyle(p).opacity === '0' && getComputedStyle(p).pointerEvents === 'none')`), 'the eye hides every panel');
  check(JSON.stringify(await ev('[__aq.view.x, __aq.view.y, __aq.view.z]')) === JSON.stringify(v0), 'and the page does not move');
  const us = await ev(`(() => { const r = document.querySelector('#uiShow').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, r.width]; })()`);
  check(us[2] >= 40, 'a show button is left in the corner');
  await tapAt(us); await sleep(300);
  check(!(await ev(`document.body.classList.contains('ui-hidden')`)) && (await ev(`getComputedStyle(document.querySelector('#uiShow')).display`)) === 'none', 'tapping it brings the panels back');
  // panels fold and move by their grips
  await c.send('Emulation.setDeviceMetricsOverride', { width: 632, height: 840, deviceScaleFactor: 2, mobile: true });
  check(await load('fresh=1&nosw=1&nohelp=1&nosave=1&eink=1'), 'loads for movable panels'); await sleep(300);
  const gripAt = (id) => ev(`(() => { const r = document.querySelector('#${id} > .grip').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const qpw0 = await ev(`document.querySelector('#palette').getBoundingClientRect().width`);
  await tapAt(await gripAt('palette')); await sleep(500);
  const qpw1 = await ev(`document.querySelector('#palette').getBoundingClientRect().width`);
  check(qpw1 < qpw0 * 0.3 && (await ev(`document.querySelector('#palette').classList.contains('folded')`)), 'tapping the palette grip folds it', `${qpw0.toFixed(0)} -> ${qpw1.toFixed(0)} px`);
  await tapAt(await ev(`(() => { const r = document.querySelector('#mixWell').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`)); await sleep(300);
  check(!(await ev(`document.querySelector('#palette').classList.contains('folded')`)) && !(await ev(`document.querySelector('#colPop').classList.contains('open')`)), 'tapping the folded palette opens it again');
  await tapAt(await gripAt('tools')); await sleep(500);
  check(await ev(`(() => { const v = [...document.querySelectorAll('#tools > button:not(.grip)')].filter((b) => b.offsetParent); return v.length === 1 && v[0].classList.contains('on'); })()`), 'a folded tool strip shows just the selected tool');
  await tapAt(await gripAt('tools')); await sleep(500);
  // drag the tool strip by its grip into the middle: it stays there, floats, and survives a reload
  const qg0 = await gripAt('tools');
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: qg0[0], y: qg0[1], button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i++) await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: qg0[0] + i * 25, y: qg0[1] + i * 5, button: 'left', buttons: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: qg0[0] + 250, y: qg0[1] + 50, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(400);
  const qg1 = await gripAt('tools');
  check(Math.abs(qg1[0] - qg0[0] - 250) < 3 && Math.abs(qg1[1] - qg0[1] - 50) < 3, 'dragging the grip moves the tool strip', `${(qg1[0] - qg0[0]).toFixed(0)}, ${(qg1[1] - qg0[1]).toFixed(0)}`);
  check(await load('nosw=1&nohelp=1&nosave=1&eink=1'), 'reload keeps the panel'); await sleep(300);
  const qg2 = await gripAt('tools');
  check(Math.abs(qg2[0] - qg1[0]) < 3 && Math.abs(qg2[1] - qg1[1]) < 3, 'the tool strip is still where it was put');
  // double-tap: back in place
  const qgp = await gripAt('tools'); await tapAt(qgp); await sleep(80); await tapAt(qgp); await sleep(500);
  const qg3 = await gripAt('tools');
  check(Math.abs(qg3[0] - qg0[0]) < 3, 'double-tapping the grip puts it back');
  await ev('__aq.resetPanels(); true');

  // every panel fits small and short screens: scrolling tool strip, ⋯ menu, popovers inside
  const panelsFit = () => ev(`(() => { const rs = [...document.querySelectorAll('.panel')].map((p) => [p.id, p.getBoundingClientRect()]).filter(([, r]) => r.width), bad = [];
    for (let i = 0; i < rs.length; i++) { const [n, r] = rs[i]; if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) bad.push(n + ' off'); for (let j = i + 1; j < rs.length; j++) { const [m, q] = rs[j]; if (r.left < q.right && q.left < r.right && r.top < q.bottom && q.top < r.bottom) bad.push(n + '/' + m); } }
    return bad; })()`);
  for (const [w, h, d] of [[844, 390, 3], [560, 420, 1], [320, 568, 2], [1280, 600, 1]]) {
    await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: d, mobile: d > 1 });
    check(await load('fresh=1&nosw=1&nohelp=1&nosave=1'), `loads at ${w} × ${h}`); await sleep(300);
    const bad = await panelsFit();
    check(bad.length === 0, `no panel overlaps or runs off at ${w} × ${h}`, bad.join(', '));
    for (const pop of ['brushPop', 'colPop', 'actPop', 'layerPop']) {
      const r = await ev(`(() => { __aq.closePops(); __aq.togglePop('${pop}'); const r = document.getElementById('${pop}').getBoundingClientRect(); __aq.closePops(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5; })()`);
      check(r, `${pop} stays on screen at ${w} × ${h}`);
    }
  }
  // 844 × 390: the tool strip scrolls to its last tool
  await c.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true });
  check(await load('fresh=1&nosw=1&nohelp=1&nosave=1'), 'loads in phone landscape'); await sleep(300);
  check(await ev(`(() => { const t = document.querySelector('#tools'); return t.scrollHeight > t.clientHeight + 20 && getComputedStyle(t).overflowY === 'auto'; })()`), 'the tool strip scrolls on a short screen');
  check(await ev(`(() => { const t = document.querySelector('#tools'); t.scrollTop = 1e4; const b = document.querySelector('#pickBtn').getBoundingClientRect(), r = t.getBoundingClientRect(); return b.bottom <= r.bottom + 1 && b.top >= r.top - 1; })()`), 'and its last tool can be reached');
  // 320 wide: top-right buttons go into ⋯ and still work
  await c.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
  check(await load('fresh=1&nosw=1&nohelp=1&nosave=1'), 'loads at 320 wide'); await sleep(300);
  const inMore = await ev(`[...document.querySelectorAll('#morePop button')].map((b) => b.id)`);
  check(await ev(`!!document.querySelector('#topR #moreBtn')`) && inMore.includes('layBtn'), 'buttons that do not fit go into ⋯', inMore.join(','));
  await sel('#moreBtn'); await sleep(100);
  check(await ev(`document.querySelector('#morePop').classList.contains('open')`), '⋯ opens');
  await sel('#layBtn'); await sleep(200);
  check(await ev(`document.querySelector('#layerPop').classList.contains('open')`), 'and Layers works from it');
  await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  check(await load('fresh=1&nosw=1&nohelp=1&nosave=1'), 'loads wide again'); await sleep(300);
  check(!(await ev(`!!document.querySelector('#moreBtn')?.isConnected`)), 'no ⋯ when everything fits');
  await c.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

  // 17. pen-to-paint alignment, full screen and resizing, on both interfaces (this one and v1/)
  await c.send('Emulation.setDeviceMetricsOverride', { width: 632, height: 840, deviceScaleFactor: 2, mobile: true });
  const colAt = (x) => ev(`(() => { __aq.render(); const c = document.querySelector('#gl'), gl = __aq.sim.gl, r = c.getBoundingClientRect(), sx = c.width / r.width; const bx = Math.round((${x} - r.left) * sx), px = new Uint8Array(4 * c.height); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(bx, 0, 1, c.height, gl.RGBA, gl.UNSIGNED_BYTE, px); return { px: Array.from(px), top: r.top, sy: c.height / r.height, H: c.height }; })()`);
  const dabAt = async (x, y) => {
    const before = await colAt(x);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, pointerType: 'pen', force: 0.8 });
    await sleep(500); await ev('__aq.sim.dryNow(); true');
    const after = await colAt(x);
    let lo = 1e9, hi = -1;
    for (let row = 0; row < after.H; row++) { const i = row * 4, d = Math.abs(after.px[i] - before.px[i]) + Math.abs(after.px[i + 1] - before.px[i + 1]) + Math.abs(after.px[i + 2] - before.px[i + 2]); if (d > 40) { const y2 = after.top + (after.H - 1 - row + 0.5) / after.sy; lo = Math.min(lo, y2); hi = Math.max(hi, y2); } }
    return hi < 0 ? null : (lo + hi) / 2 - y;
  };
  for (const app of ['index.html', 'v1/index.html']) {
    c.events.length = 0;
    await c.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/${app}?fresh=1&nohelp=1&nosw=1&nosave=1` });
    for (let i = 0; i < 150 && !(await ev('!!window.__ready').catch(() => false)); i++) await sleep(100);
    await sleep(300);
    await ev(`(() => { if (__aq.S.sel) { __aq.setMode('paint'); __aq.setTool('paint'); __aq.selectBrush('round'); } else __aq.setTool('round'); __aq.choosePigment('payne'); Object.assign(__aq.S.brush.round, { size: 6, water: 0.3, paint: 0.9 }); return true; })()`);
    // a canvas box taller than innerHeight, as 100vh is on Android Chrome with its address bar showing
    await ev(`(() => { const c = document.querySelector('#gl'); c.style.setProperty('height', '940px', 'important'); c.style.setProperty('bottom', 'auto', 'important'); return true; })()`);
    await sleep(1200);
    const offs = [await dabAt(300, 220), await dabAt(300, 700)];
    check(offs.every((o) => o != null && Math.abs(o) < 3), `${app}: paint lands under the pen (canvas taller than the window)`, offs.map((o) => (o == null ? 'none' : o.toFixed(1))).join(', ') + ' px');
    await ev(`(() => { const c = document.querySelector('#gl'); c.style.removeProperty('height'); c.style.removeProperty('bottom'); return true; })()`);
    await sleep(1200);
    const offs2 = [await dabAt(320, 260), await dabAt(320, 650)];
    check(offs2.every((o) => o != null && Math.abs(o) < 3), `${app}: and after the window changes size`, offs2.map((o) => (o == null ? 'none' : o.toFixed(1))).join(', ') + ' px');
    // full screen button in and out
    const fb = async () => ev(`(() => { const b = document.querySelector('#fsBtn').getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2, b.width]; })()`);
    let b = await fb();
    check(b[2] > 20, `${app}: full screen button`);
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: b[0], y: b[1], button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    await sleep(500);
    const inFs = await ev('!!document.fullscreenElement');
    b = await fb();
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: b[0], y: b[1], button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    await sleep(500);
    check(inFs && !(await ev('!!document.fullscreenElement')), `${app}: full screen on and off from the button`);
    // a resize mid-stroke leaves the page where it is; refitted once the pen lifts
    await sleep(800);
    const v0 = await ev('[__aq.view.x, __aq.view.y, __aq.view.z]');
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 400, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.6 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 220, y: 400, button: 'left', buttons: 1, pointerType: 'pen', force: 0.6 });
    await ev(`(() => { const c = document.querySelector('#gl'); c.style.setProperty('height', '760px', 'important'); c.style.setProperty('bottom', 'auto', 'important'); return true; })()`);
    await sleep(1200);
    const v1 = await ev('[__aq.view.x, __aq.view.y, __aq.view.z]');
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 220, y: 400, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
    let refit = false;
    for (let i = 0; i < 30 && !refit; i++) { await sleep(150); refit = await ev(`(() => { const v = [__aq.view.x, __aq.view.y, __aq.view.z], b = __aq.box.h; __aq.fit(); const f = [__aq.view.x, __aq.view.y, __aq.view.z]; [__aq.view.x, __aq.view.y, __aq.view.z] = v; return b === 760 && v.every((q, i) => Math.abs(q - f[i]) < 1e-6); })()`); }
    check(v1.every((v, i) => Math.abs(v - v0[i]) < 1e-6) && refit, `${app}: a resize mid-stroke waits for the pen to lift`);
    await ev(`(() => { const c = document.querySelector('#gl'); c.style.removeProperty('height'); c.style.removeProperty('bottom'); return true; })()`);
    check(errors().length === 0, `${app}: no console errors`, errors().join(' | '));
  }
  await c.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

  // 18. offline: register the service worker, reload offline
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

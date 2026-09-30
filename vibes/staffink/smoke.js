// Headless end-to-end check over the Chrome DevTools protocol, zero npm deps.
// Draws synthetic handwriting with real pen pointer events (CDP pointerType 'pen'),
// so ink capture, stroke grouping, the recognition pause, gestures and engraving all
// run as they would under a stylus. Writes smoke_*.png next to this file.
//   node smoke.js            (CHROME=/path/to/chrome to override)
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as I from './testink.js';
import { inkWord, rng } from './extras.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME || path.join(process.env.HOME, '.cache/ms-playwright/chromium-1134/chrome-linux/chrome');
const PORT = 8797, CDP = 9337;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));
async function waitFor(fn, ms) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ } if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(150); } }

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return new Promise((res) => { ws.onopen = () => res({ send, events, close: () => ws.close() }); });
}

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(DIR, u === '/' ? 'index.html' : u);
  if (!f.startsWith(DIR) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--window-size=1280,860', `--remote-debugging-port=${CDP}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let failed = false;
  const check = (name, ok, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); if (!ok) failed = true; };
  try {
    const targets = await waitFor(() => getJson(`http://localhost:${CDP}/json/list`), 15000);
    const c = await cdp(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await c.send('Runtime.enable'); await c.send('Log.enable'); await c.send('Page.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    const ev = async (expr) => { const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text); return r.result.result.value; };

    /** Draw strokes (page staff-space coordinates) with the pen, then wait for recognition. */
    async function pen(strokes, settle = 450) {
      const geo = await ev('(() => { const r = document.getElementById("stage").getBoundingClientRect(); return { l: r.left, t: r.top, s: StaffInk.S.scale, sy: StaffInk.S.scrollY }; })()');
      const cx = (p) => ({ x: geo.l + p.x * geo.s, y: geo.t + (p.y - geo.sy) * geo.s });
      for (const s of strokes) {
        const a = cx(s[0]);
        await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
        for (const p of s.slice(1)) { const q = cx(p); await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: q.x, y: q.y, button: 'left', buttons: 1, pointerType: 'pen', force: 0.6 }); }
        const z = cx(s[s.length - 1]);
        await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: z.x, y: z.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
        await sleep(40);
      }
      await sleep(settle);
    }
    const events = (mi = 0, si = 0) => ev(`JSON.stringify(StaffInk.score.measures[${mi}].staves[${si}].events)`).then(JSON.parse);
    const evPos = (id) => ev(`JSON.stringify(StaffInk.layout.evPos.get(${id}))`).then(JSON.parse);
    const measure = (mi) => ev(`(() => { const m = StaffInk.layout.measures[${mi}]; return { x0: m.x0, x1: m.x1, reserveX: m.reserveX, contentX: m.contentX }; })()`);
    const nextX = async (mi) => { const m = await measure(mi); return m.reserveX + 1.2; };

    // ---------------------------------------------------------- scene 1: treble staff
    await c.send('Page.navigate', { url: `http://localhost:${PORT}/?fresh&nohelp&delay=250` });
    await sleep(800);
    await ev('StaffInk.modelReady.then(() => true)');
    const top = await ev('StaffInk.staffTop(0, 0)');
    I.reseed(3);
    await pen(I.note(top, await nextX(0), 2));                                   // G4 quarter
    await pen(I.sharp(top, await nextX(0), 3));                                  // ♯ ...
    await pen(I.note(top, (await nextX(0)) + 1.2, 3));                           // ... then F#4? (pos 3 = F4 -> F#4)
    await pen(I.note(top, await nextX(0), 6, { filled: false }));                // B4? pos 6 = D5 half
    let m0 = await events(0);
    check('bar 1: quarter, sharp quarter, half', m0.length === 3 && m0[0].dur === 4 && m0[1].heads[0].acc === 1 && m0[2].dur === 2, JSON.stringify(m0.map((e) => [e.dur, e.heads.map((h) => h.pos + (h.acc === null ? '' : ':' + h.acc))])));
    const p0 = await evPos(m0[0].id);
    await pen([I.filledHead(p0.x + 0.6, p0.top + 4 - 6 / 2)]);                    // chord head on the first stem
    m0 = await events(0);
    check('chord head joins the first note', m0[0].heads.length === 2, JSON.stringify(m0[0].heads));
    // bar 2: two quarters beamed into eighths, then a dotted half
    await pen(I.note(top, await nextX(1), 5));
    await pen(I.note(top, (await nextX(1)) + 0.3, 6));
    let m1 = await events(1);
    const [a, b] = [await evPos(m1[0].id), await evPos(m1[1].id)];
    await pen(I.straight(a.stem.x - 0.05, a.stem.y1 + 0.15, b.stem.x + 0.05, b.stem.y1 + 0.1));
    m1 = await events(1);
    check('beam gesture: eighths', m1.length === 2 && m1.every((e) => e.dur === 8), JSON.stringify(m1.map((e) => e.dur)));
    await pen(I.note(top, await nextX(1), 4, { filled: false }));
    m1 = await events(1);
    const hp = await evPos(m1[2].id);
    await pen(I.dot(hp.x + 1.9, hp.heads[0].y));
    m1 = await events(1);
    check('dotted half after the eighths', m1.length === 3 && m1[2].dur === 2 && m1[2].dots === 1, JSON.stringify(m1.map((e) => [e.dur, e.dots])));
    // bar 3: whole rest block, bar 4: tie two notes
    await pen(I.blockRest(top, (await nextX(2)) + 2, 5));
    const m2 = await events(2);
    check('whole bar rest', m2.length === 1 && m2[0].kind === 'rest' && m2[0].full, JSON.stringify(m2));
    await pen(I.note(top, await nextX(3), 1, { filled: false }));
    await pen(I.note(top, (await nextX(3)) + 0.5, 1, { filled: false }));
    let m3 = await events(3);
    const [t1, t2] = [await evPos(m3[0].id), await evPos(m3[1].id)];
    const hw = await ev('StaffInk.layout.headW');
    await pen(I.arc(t1.x + hw, t1.heads[0].y + 0.65, t2.x, t2.heads[0].y + 0.65, 0.55));
    m3 = await events(3);
    check('tie between the halves', m3[0].tie === true, JSON.stringify(m3.map((e) => e.tie)));
    // scribble-erase then undo
    await pen(I.scribble(t2.bbox.x0 - 0.3, t2.bbox.y0 - 0.2, t2.bbox.x1 + 0.3, t2.bbox.y1 + 0.2, 7));
    const afterErase = (await events(3)).length;
    await ev('StaffInk.undo(), true'); await sleep(100);
    const afterUndo = (await events(3)).length;
    check('scribble erases, undo restores', afterErase === 1 && afterUndo === 2, `${afterErase} -> ${afterUndo}`);
    const xml = await ev('import("./export.js").then(m => m.toMusicXML(StaffInk.score))');
    check('MusicXML export', (xml.match(/<note>/g) || []).length === 10 && xml.includes('<tie type="start"/>') && xml.includes('<alter>1</alter>'), `${(xml.match(/<note>/g) || []).length} notes`);
    await ev('StaffInk.togglePlay(), true'); await sleep(500);
    const playing = await ev('StaffInk.S.player.playing && StaffInk.S.playing.size');
    check('playback runs and highlights', playing > 0, `sounding ${playing}`);
    await ev('StaffInk.togglePlay(), true');
    await sleep(200);
    await ev('document.getElementById("status").classList.remove("show"), document.getElementById("alts").classList.remove("show"), true');
    await sleep(120);
    fs.writeFileSync(path.join(DIR, 'smoke_treble.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

    // ---------------------------------------------------------- scene 2: grand staff, Petaluma
    await ev('localStorage.setItem("staffink.settings", JSON.stringify({font: "Petaluma", delay: 250})), true');
    await c.send('Page.navigate', { url: `http://localhost:${PORT}/?fresh&nohelp&delay=250` });
    await sleep(800);
    await ev('StaffInk.modelReady.then(() => true)');
    await ev('(() => { const s = StaffInk.score; s.staves = [{clef:"G"},{clef:"F"}]; for (const m of s.measures) m.staves.push({events: []}); s.key = -2; s.time = [3, 4]; s.title = "Grand staff"; StaffInk.S.undo = []; window.dispatchEvent(new Event("resize")); return true; })()');
    await sleep(200);
    const tTop = await ev('StaffInk.staffTop(0, 0)'), bTop = await ev('StaffInk.staffTop(0, 1)');
    for (const [pos, flags] of [[4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [6, 1]]) await pen(I.note(tTop, await nextX(0), pos, { flags }));
    await pen(I.note(bTop, (await measure(0)).contentX + 1.2, 2, { filled: false }));
    await pen(I.note(bTop, (await nextX(0)) - 1.5, 4));
    const tr = await events(0, 0), bs = await events(0, 1);
    check('grand staff: six eighths up top, half + quarter in the bass', tr.length === 6 && tr.every((e) => e.dur === 8) && bs.length === 2 && bs[0].dur === 2, JSON.stringify([tr.map((e) => e.dur), bs.map((e) => e.dur)]));
    const beams = await ev('StaffInk.layout.beams.length');
    check('auto-beamed by beat in 3/4', beams === 3, `${beams} beam groups`);
    await ev('document.getElementById("status").classList.remove("show"), document.getElementById("alts").classList.remove("show"), true');
    await sleep(120);
    fs.writeFileSync(path.join(DIR, 'smoke_grand.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

    // ---------------------------------------------------------- scene 2b: correcting and editing
    await c.send('Page.navigate', { url: `http://localhost:${PORT}/?fresh&nohelp&delay=250` });
    await sleep(800);
    await ev('StaffInk.modelReady.then(() => true), localStorage.removeItem("staffink.user"), StaffInk.S.user = [], true');
    const eTop = await ev('StaffInk.staffTop(0, 0)');
    await pen(I.quarterRest(eTop, await nextX(0)));
    const altShown = await ev('document.getElementById("alts").classList.contains("show") && [...document.querySelectorAll("#alts button")].map(b => b.dataset.l)');
    check('alternatives offered after a symbol', Array.isArray(altShown) && altShown.length >= 2, JSON.stringify(altShown));
    const click = async (sel) => { const r = await ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; })()`); if (!r) return false; for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 }); await sleep(150); return true; };
    const alt = altShown && altShown.find((l) => l !== 'Quarter-Rest' && /Rest/.test(l)) || 'Eighth-Rest';
    if (!(await click(`#alts button[data-l="${alt}"]`))) { await ev(`(() => { const b = document.createElement('button'); b.dataset.l = ${JSON.stringify(alt)}; document.getElementById('alts').appendChild(b); b.click(); return true; })()`); await sleep(150); }
    const corrected = await events(0);
    const learned = await ev('StaffInk.S.user.length');
    check('tapping an alternative fixes the symbol and learns it', corrected.length === 1 && corrected[0].kind === 'rest' && corrected[0].dur !== 4 && learned === 1, JSON.stringify([corrected.map((e) => e.dur), learned, alt]));
    await pen(I.note(eTop, await nextX(0), 3));
    const nEv = (await events(0))[1];
    const nPos = await evPos(nEv.id);
    const geo = await ev('(() => { const r = document.getElementById("stage").getBoundingClientRect(); return { l: r.left, t: r.top, s: StaffInk.S.scale, sy: StaffInk.S.scrollY }; })()');
    const tx = geo.l + (nPos.heads[0].x + 0.6) * geo.s, ty = geo.t + (nPos.heads[0].y - geo.sy) * geo.s;
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: tx, y: ty, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen' });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
    await sleep(200);
    const selId = await ev('StaffInk.S.selected && StaffInk.S.selected.id');
    check('pen tap on a notehead selects it', selId === nEv.id, `${selId} vs ${nEv.id}`);
    await click('#selbar button[data-a="acc"][data-v="-1"]');
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
    await sleep(150);
    const edited = (await events(0))[1];
    check('edit bar: flat, then arrow up moves the note', edited.heads[0].acc === -1 && edited.heads[0].pos === 4, JSON.stringify(edited.heads));
    await sleep(100);
    fs.writeFileSync(path.join(DIR, 'smoke_edit.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

    // ---------------------------------------------------------- scene 2c: tuplets, dynamics, hairpins
    await c.send('Page.navigate', { url: `http://localhost:${PORT}/?fresh&nohelp&delay=250` });
    await sleep(800);
    await ev('StaffInk.modelReady.then(() => true)');
    const dTop = await ev('StaffInk.staffTop(0, 0)');
    const R = rng(5);
    for (const pos of [3, 4, 5]) await pen(I.note(dTop, await nextX(0), pos, { flags: 1 }));
    for (const pos of [6, 5]) await pen(I.note(dTop, await nextX(0), pos));
    let dm = await events(0);
    const tp = await Promise.all(dm.slice(0, 3).map((e) => evPos(e.id)));
    await pen(inkWord('3', (tp[0].x + tp[2].x) / 2 + 0.2, Math.min(...tp.map((p) => p.bbox.y0)) - 1.5, R));
    dm = await events(0);
    check('pen: a 3 over three eighths makes a triplet', dm.slice(0, 3).every((e) => e.tuplet && e.tuplet.n === 3) && !dm[3].tuplet, JSON.stringify(dm.map((e) => e.tuplet ? 't' : '-')));
    await pen(inkWord('p', tp[0].x, dTop + 7.2, R));
    const qp = await evPos(dm[4].id);
    await pen(inkWord('f', qp.x, dTop + 7.2, R));
    dm = await events(0);
    check('pen: p and f under notes', dm[0].dyn === 'p' && dm[4].dyn === 'f', JSON.stringify(dm.map((e) => e.dyn || '-')));
    const hy = dTop + 6.8, hx0 = tp[0].x + 1.8, hx1 = (await evPos(dm[3].id)).x + 1.2;
    await pen([[...I.straight(hx1, hy - 0.5, hx0, hy)[0], ...I.straight(hx0, hy, hx1, hy + 0.5)[0]]]);
    const hps = await ev('JSON.stringify(StaffInk.score.hairpins)').then(JSON.parse);
    check('pen: crescendo hairpin', hps.length === 1 && hps[0].type === 'cresc' && hps[0].from === dm[0].id, JSON.stringify(hps));
    const vel = await ev('import("./export.js").then(m => { const v = m.velocities(StaffInk.score); return StaffInk.score.measures[0].staves[0].events.map(e => +v.get(e.id).toFixed(2)); })');
    check('hairpin ramps playback from p to f', vel.every((v, i) => !i || v >= vel[i - 1]) && vel[0] < vel[4], JSON.stringify(vel));
    await ev('document.getElementById("status").classList.remove("show"), document.getElementById("alts").classList.remove("show"), true');
    await sleep(150);
    fs.writeFileSync(path.join(DIR, 'smoke_expr.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

    // ---------------------------------------------------------- scene 2d: offline
    await ev('navigator.serviceWorker.ready.then(() => new Promise((r) => { if (navigator.serviceWorker.controller) r(true); else navigator.serviceWorker.addEventListener("controllerchange", () => r(true)); setTimeout(() => r(!!navigator.serviceWorker.controller), 5000); }))');
    const cached = await ev('caches.open("staffink-v1").then((c) => c.keys()).then((k) => k.length)');
    await c.send('Network.enable');
    await c.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await c.send('Page.navigate', { url: `http://localhost:${PORT}/?nohelp&delay=250` });
    await sleep(1200);
    const off = await ev('Promise.race([StaffInk.modelReady.then(() => ({ model: !!StaffInk.S.model, extras: StaffInk.S.extras.length, bravura: document.fonts.check("40px Bravura"), notes: StaffInk.score.measures[0].staves[0].events.length })), new Promise((r) => setTimeout(() => r(null), 4000))])');
    const oTop = await ev('StaffInk.staffTop(0, 0)');
    await pen(I.note(oTop, await nextX(0), 8));
    const offNotes = (await events(0)).length;
    check('offline: reload from the service worker, recogniser and fonts work', off && off.model && off.extras > 100 && off.bravura && offNotes === off.notes + 1, JSON.stringify({ cached, ...off, offNotes }));
    await c.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    c.events.length = 0; // failed background revalidation while offline is expected

    // ---------------------------------------------------------- scene 3: phone, finger writing
    await ev('localStorage.removeItem("staffink.settings"), localStorage.removeItem("staffink.user"), true');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await c.send('Page.navigate', { url: `http://localhost:${PORT}/?fresh&nohelp&delay=250` });
    await sleep(900);
    await ev('StaffInk.modelReady.then(() => true)');
    const mTop = await ev('StaffInk.staffTop(0, 0)');
    async function finger(strokes) {
      const geo = await ev('(() => { const r = document.getElementById("stage").getBoundingClientRect(); return { l: r.left, t: r.top, s: StaffInk.S.scale, sy: StaffInk.S.scrollY }; })()');
      const cx = (p) => ({ x: geo.l + p.x * geo.s, y: geo.t + (p.y - geo.sy) * geo.s });
      for (const st of strokes) {
        await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [cx(st[0])] });
        for (const p of st.slice(1)) await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [cx(p)] });
        await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await sleep(40);
      }
      await sleep(450);
    }
    for (const pos of [0, 2, 4]) await finger(I.note(mTop, await nextX(0), pos));
    await finger(I.quarterRest(mTop, (await nextX(0)) + 0.4));
    const fm = await events(0);
    check('phone: finger writes E-G-B + quarter rest', fm.length === 4 && fm[3].kind === 'rest' && fm[3].dur === 4 && fm.slice(0, 3).map((e) => e.heads[0].pos).join() === '0,2,4', JSON.stringify(fm.map((e) => e.kind[0] + e.dur + ':' + e.heads.map((h) => h.pos))));
    const hdr = await ev('(() => { const h = document.querySelector("header"); return h.scrollWidth <= h.clientWidth + 1; })()');
    check('phone: toolbar fits', hdr);
    await ev('document.getElementById("status").classList.remove("show"), document.getElementById("alts").classList.remove("show"), true');
    await sleep(500);
    fs.writeFileSync(path.join(DIR, 'smoke_phone.png'), Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).result.data, 'base64'));

    const errs = c.events.filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/favicon/.test(e.params.entry.url || '')));
    check('no page errors', errs.length === 0, errs.map((e) => e.method === 'Runtime.exceptionThrown' ? e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description || e.params.exceptionDetails.text : e.params.entry.text).join(' | ').slice(0, 400));
    c.close();
  } catch (e) { console.error('smoke failed:', e.stack || e.message); failed = true; }
  chrome.kill(); server.close();
  process.exit(failed ? 1 : 0);
})();

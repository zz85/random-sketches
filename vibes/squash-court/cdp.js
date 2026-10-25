// Tiny Chrome DevTools Protocol driver (zero deps) for the smoke test.
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';

// newest Playwright Chromium in any of the usual browser folders, unless CHROME is set
const PWS = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(process.env.HOME, '.cache/ms-playwright'), path.join(process.env.HOME, '.local/share/ms-playwright')].filter((d) => d && fs.existsSync(d));
export const CHROME = process.env.CHROME || PWS.flatMap((pw) => fs.readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).map((d) => [+d.split('-')[1], pw, d]))
  .sort((a, b) => b[0] - a[0]).flatMap(([, pw, d]) => ['chrome-linux', 'chrome-linux64', 'chrome-linux-arm64'].map((p) => path.join(pw, d, p, 'chrome')))
  .find((f) => fs.existsSync(f)) || 'chromium';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = (u) => new Promise((res, rej) => http.get(u, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));
export async function waitFor(fn, ms) { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ } if (Date.now() - t0 > ms) throw new Error('timeout'); await sleep(150); } }

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl); let id = 0; const pending = new Map(); const events = [];
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); };
  const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  return new Promise((res) => { ws.onopen = () => res({ send, events, close: () => ws.close() }); });
}

// Launch headless Chromium and attach to its first page.
export async function launch({ port = 9341, width = 1280, height = 900 } = {}) {
  // fresh profile per launch: a shared one keeps service-worker caches (stale code) between runs
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=${profile}`, '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', `--window-size=${width},${height}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  const list = await waitFor(() => getJson(`http://127.0.0.1:${port}/json`), 15000);
  const page = list.find((t) => t.type === 'page');
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable');
  const evaluate = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  return { ...c, evaluate, kill: () => { c.close(); chrome.kill('SIGKILL'); setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 300); } };
}

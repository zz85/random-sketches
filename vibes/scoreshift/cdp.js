// Tiny Chrome DevTools Protocol driver (zero deps) shared by the fixture builder and smoke test.
import { spawn } from 'child_process';
import http from 'http';
import path from 'path';

export const CHROME = process.env.CHROME || path.join(process.env.HOME, '.cache/ms-playwright/chromium-1134/chrome-linux/chrome');
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
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--window-size=${width},${height}`, `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' });
  const list = await waitFor(() => getJson(`http://127.0.0.1:${port}/json`), 15000);
  const page = list.find((t) => t.type === 'page');
  const c = await connect(page.webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Page.enable');
  const evaluate = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  return { ...c, evaluate, kill: () => { c.close(); chrome.kill('SIGKILL'); } };
}

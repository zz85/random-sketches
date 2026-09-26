// Headless smoke test using Playwright's bundled Chromium via the CDP protocol,
// zero npm deps: launch chrome with --remote-debugging-pipe? Simpler: use
// --headless --screenshot and --virtual-time-budget, plus dump console via
// --enable-logging. Run:  node smoke.js
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME = process.env.CHROME || path.join(process.env.HOME, '.cache/ms-playwright/chromium-1134/chrome-linux/chrome');
const PORT = 8799;

// start the static server from proxy.js in-process
process.env.PORT = String(PORT);
const srv = spawn(process.execPath, [path.join(__dirname, 'proxy.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });

function waitPort() { return new Promise((res) => { const t = setInterval(() => http.get(`http://localhost:${PORT}/geo.js`, (r) => { r.resume(); clearInterval(t); res(); }).on('error', () => {}), 150); }); }

(async () => {
  await waitPort();
  const cases = [
    { name: 'seattle-demo', url: `http://localhost:${PORT}/?lat=47.6603&lon=-122.4412&eye=18&hdg=300&pitch=-6&provider=demo&auto=1&nocam=1` },
    { name: 'seattle-occlusion', url: `http://localhost:${PORT}/?lat=47.6603&lon=-122.4412&eye=18&hdg=135&pitch=-4&provider=demo&auto=1&nocam=1` },
    { name: 'helsinki-live', url: `http://localhost:${PORT}/?lat=60.153&lon=24.95&eye=12&hdg=200&pitch=-5&provider=digitraffic&auto=1&nocam=1` },
  ];
  let failed = false;
  for (const c of cases) {
    const out = path.join(__dirname, `smoke_${c.name}.png`);
    const log = path.join('/tmp', `chrome_${c.name}.log`);
    const args = ['--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', `--window-size=1280,800`, '--virtual-time-budget=9000',
      '--enable-logging=stderr', '--v=0', `--screenshot=${out}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', c.url];
    const stderr = await new Promise((res) => { const p = spawn(CHROME, args); let s = ''; p.stderr.on('data', (d) => (s += d)); p.on('close', () => res(s)); });
    fs.writeFileSync(log, stderr);
    const consoleLines = stderr.split('\n').filter((l) => /CONSOLE/.test(l)).map((l) => l.replace(/^.*CONSOLE\S*\s*/, ''));
    const errors = consoleLines.filter((l) => /Uncaught|TypeError|ReferenceError|SyntaxError|is not defined|Failed to load resource/.test(l));
    const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
    console.log(`${c.name}: screenshot ${size} bytes, ${consoleLines.length} console lines, ${errors.length} errors`);
    for (const l of consoleLines) console.log('   ', l.slice(0, 200));
    if (errors.length || size < 10000) failed = true;
  }
  srv.kill();
  process.exit(failed ? 1 : 0);
})();

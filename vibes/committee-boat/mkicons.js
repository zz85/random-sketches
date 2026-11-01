// node mkicons.js : renders icon.svg to icon-192.png and icon-512.png with headless Chromium.
import { launch } from './cdp.js';
import fs from 'fs';
import path from 'path';
const svg = fs.readFileSync('icon.svg', 'utf8');
for (const n of [192, 512]) {
  const b = await launch({ width: n, height: n, port: 9361 + (n % 7) });
  try {
    await b.send('Emulation.setDeviceMetricsOverride', { width: n, height: n, deviceScaleFactor: 1, mobile: false });
    await b.send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${n}" height="${n}" `)}</body>`) });
    await new Promise((r) => setTimeout(r, 600));
    const r = await b.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: n, height: n, scale: 1 } });
    fs.writeFileSync(path.resolve(`icon-${n}.png`), Buffer.from(r.result.data, 'base64'));
  } finally { b.kill(); }
}

// icon.svg -> icon-192.png, icon-512.png (rendered in headless Chrome).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, sleep } from '../cdp.js';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const svg = fs.readFileSync(path.join(DIR, 'icon.svg'), 'utf8');
for (const n of [192, 512]) {
  const b = await launch({ port: 9362, width: n, height: n });
  try {
    await b.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await b.send('Page.navigate', { url: 'data:text/html,' + encodeURIComponent(`<body style="margin:0"><img src="data:image/svg+xml,${encodeURIComponent(svg)}" width=${n} height=${n}>`) });
    await sleep(500);
    const r = await b.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: n, height: n, scale: 1 } });
    fs.writeFileSync(path.join(DIR, `icon-${n}.png`), Buffer.from(r.result.data, 'base64'));
  } finally { b.kill(); await sleep(300); }
}
console.log('icon-192.png, icon-512.png');

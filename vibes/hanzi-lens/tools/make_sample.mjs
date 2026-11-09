// Renders sample.jpg, a photo-like menu with horizontal lines, prices and a vertical
// column, and sample.json, the text on it (ground truth for smoke.js).
//   CHROME=/path/to/chrome node tools/make_sample.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch, sleep } from '../cdp.js';

const DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const items = [['宫保鸡丁', '28元'], ['麻婆豆腐', '22元'], ['红烧牛肉面', '32元'], ['小笼包', '18元'], ['酸辣汤', '15元'], ['扬州炒饭', '20元']];
const title = '川味小馆', column = '欢迎光临', foot = '营业时间 10:00-21:00';
const html = `<!doctype html><meta charset=utf-8><style>
  body{margin:0;width:1200px;height:760px;background:#3b3029;overflow:hidden;font-family:'Droid Sans Fallback',sans-serif}
  .card{position:absolute;left:150px;top:40px;width:880px;height:680px;transform:rotate(-2.5deg);
    background:radial-gradient(ellipse at 30% 20%,#fbf4e4,#eadcbf 70%,#d9c7a2);box-shadow:0 20px 60px #0009;color:#2a1a10}
  h1{position:absolute;left:90px;top:40px;margin:0;font-size:84px;letter-spacing:12px;color:#8a1c12}
  .row{position:absolute;left:100px;font-size:42px;width:560px;display:flex;justify-content:space-between}
  .col{position:absolute;right:70px;top:140px;writing-mode:vertical-rl;font-size:64px;color:#8a1c12;letter-spacing:10px}
  .foot{position:absolute;left:100px;bottom:36px;font-size:32px;color:#5a4030}
  .shade{position:absolute;inset:0;background:linear-gradient(110deg,#0000 55%,#0003);pointer-events:none}
</style><div class=card><h1>${title}</h1>
${items.map(([a, b], i) => `<div class=row style="top:${170 + i * 66}px"><span>${a}</span><span>${b}</span></div>`).join('')}
<div class=col>${column}</div><div class=foot>${foot}</div><div class=shade></div></div>`;

const b = await launch({ port: 9361, width: 1200, height: 900 });
try {
  await b.send('Page.navigate', { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) });
  await sleep(800);
  const r = await b.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
  fs.writeFileSync(path.join(DIR, 'sample.jpg'), Buffer.from(r.result.data, 'base64'));
  // names and prices sit far apart, so they are separate lines to the detector
  const lines = [title, ...items.map(([a]) => a), ...items.map(([, p]) => p), column, foot];
  fs.writeFileSync(path.join(DIR, 'sample.json'), JSON.stringify({ lines }, null, 1) + '\n');
  console.log('sample.jpg, sample.json');
} finally { b.kill(); }

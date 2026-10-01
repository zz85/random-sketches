// Writes sample.jpg: the minuet fixture through the "photo" degradation, warm paper, as a JPEG.
//   node tools/make_sample.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launch } from '../cdp.js';
import { decodeGray, encodeGray } from '../png.js';
import { degrade, CONDITIONS } from '../degrade.js';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const clean = decodeGray(fs.readFileSync(path.join(ROOT, 'fixtures/minuet.png')));
const { img } = degrade(clean, { ...CONDITIONS.photo, scale: 1.4, noise: 4 });
const b64 = encodeGray(img).toString('base64');
const b = await launch({ port: 9345 });
const jpg = await b.evaluate(`new Promise((res)=>{const i=new Image();i.onload=()=>{const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d');
  g.drawImage(i,0,0);g.globalCompositeOperation='multiply';const gr=g.createLinearGradient(0,0,c.width,c.height);gr.addColorStop(0,'#fff6e6');gr.addColorStop(1,'#efe3cf');g.fillStyle=gr;g.fillRect(0,0,c.width,c.height);
  res(c.toDataURL('image/jpeg',0.8).split(',')[1]);};i.src='data:image/png;base64,${b64}';})`);
fs.writeFileSync(path.join(ROOT, 'sample.jpg'), Buffer.from(jpg, 'base64'));
console.log('sample.jpg', img.w, 'x', img.h, Math.round(jpg.length * 0.75 / 1024), 'KB');
b.kill();

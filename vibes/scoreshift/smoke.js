// Headless end-to-end check over CDP (zero deps): loads the sample photo through the real UI,
// runs recognition in the worker, renders every view, checks the transposed page pixel by
// pixel (old head positions now paper, new positions ink), corrections, export, offline reload.
//   node smoke.js            (CHROME=/path/to/chrome to override). Writes smoke_*.png.
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { launch, sleep, waitFor } from './cdp.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8799;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(DIR, u === '/' ? 'index.html' : u);
  if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

(async () => {
  await new Promise((r) => server.listen(PORT, r));
  const b = await launch({ port: 9347, width: 1280, height: 900 });
  const errors = [];
  const shot = async (name) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(DIR, `smoke_${name}.png`), Buffer.from(r.result.data, 'base64')); };
  try {
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await waitFor(() => b.evaluate('!!window.__ss'), 10000);
    await b.evaluate(`document.getElementById('sample2').click(); 1`);
    await waitFor(() => b.evaluate('!!window.__ss.S.model'), 30000);
    await sleep(300);
    for (const e of b.events) if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') errors.push(e.params.args.map((a) => a.value || a.description).join(' '));
    for (const e of b.events) if (e.method === 'Runtime.exceptionThrown') errors.push(e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
    const info = await b.evaluate(`(()=>{const S=__ss.S,m=S.model;return {staves:m.staves.length,notes:m.notes.length,keys:m.staves.map(s=>s.key.fifths),clefs:m.staves.map(s=>s.clef.type),ms:m.ms,
      status:document.getElementById('status').textContent,plan:S.plan.staves.map(p=>p.fifths),names:m.staves[0].notes.slice(0,6).map(n=>n.name),tnames:S.plan.staves[0].notes.slice(0,6).map(n=>n.name)}})()`);
    check('recognised 4 staves', info.staves === 4, JSON.stringify(info.clefs));
    check('~96 notes', info.notes >= 90 && info.notes <= 100, `${info.notes} in ${Math.round(info.ms)} ms`);
    check('key G major on every staff', info.keys.every((k) => k === 1), JSON.stringify(info.keys));
    check('B♭ clarinet part is in A major', info.plan.every((k) => k === 3), JSON.stringify(info.plan));
    check('first bar D5 G4 A4 B4 C5 -> E5 A4 B4 C♯5 D5', info.names.slice(0, 5).join() === 'D5,G4,A4,B4,C5' && info.tnames.slice(0, 5).join() === 'E5,A4,B4,C♯5,D5', info.names.join(' ') + ' -> ' + info.tnames.join(' '));
    check('status line', /A major/.test(info.status), info.status.slice(0, 120));
    await shot('transposed');

    // pixel check: for each note, new head centre is ink, old one (if not covered by another symbol) is paper
    const px = await b.evaluate(`(()=>{const S=__ss.S,R=S.rend,c=document.getElementById('cv'),g=c.getContext('2d');let inkNew=0,paperOld=0,n=0;
      const lum=(x,y)=>{const d=g.getImageData(Math.round(x*R.r)-1,Math.round(y*R.r)-1,3,3).data;let s=0;for(let i=0;i<36;i+=4)s+=(d[i]+d[i+1]+d[i+2])/3;return s/9};
      for(const sp of S.plan.staves) for(const nn of sp.notes){ if(nn.n.kind!=='black') continue; n++;
        const W=R.warps.get(sp.st), xn=W?W.warp(nn.n.x):nn.n.x; const yNew=__yOfP(sp.st,nn.p,nn.n.x); const L=lum(xn,yNew); if(L<110) inkNew++; else (window.__bad||=[]).push([nn.n.x|0,yNew|0,L|0,nn.n.p,nn.p]);
        if(lum(nn.n.x,nn.n.y+(nn.n.y<yNew?-3:3))>150) paperOld++; }
      return {n,inkNew,paperOld,bad:(window.__bad||[]).slice(0,8)}})()`);
    check('moved noteheads are ink at the new position', px.inkNew >= 0.9 * px.n, JSON.stringify(px));
    check('old noteheads were erased', px.paperOld >= 0.75 * px.n, JSON.stringify(px));

    for (const v of ['original', 'interpreted']) { await b.evaluate(`document.querySelector('[data-view=${v}]').click();1`); await sleep(200); await shot(v); }
    const chips = await b.evaluate(`document.querySelectorAll('.chip').length`);
    check('staff chips in interpreted view', chips === 4, String(chips));

    // correction: staff key override to C major on all staves -> plan becomes D major
    await b.evaluate(`document.querySelector('.chip').click();1`); await sleep(100);
    await b.evaluate(`document.getElementById('pKey').value='0';document.getElementById('pOk').click();1`); await sleep(200);
    const k2 = await b.evaluate(`__ss.S.plan.staves.map(p=>p.fifths)`);
    check('key override re-plans (C -> D major)', k2.every((k) => k === 2), JSON.stringify(k2));
    await b.evaluate(`document.querySelector('.chip').click();1`); await sleep(100);
    await b.evaluate(`document.getElementById('pKey').value='1';document.getElementById('pOk').click();1`); await sleep(200);

    // other instruments
    for (const [to, keyExp] of [['alto-sax', 4], ['F-horn', 2], ['A-clarinet', -2], ['cello', 1]]) {
      await b.evaluate(`(()=>{const s=document.getElementById('to');s.value='${to}';s.dispatchEvent(new Event('change'));document.querySelector('[data-view=transposed]').click();return 1})()`);
      await sleep(250);
      const r = await b.evaluate(`({k:__ss.S.plan.staves.map(p=>p.fifths),clef:__ss.S.plan.staves[0].clefId,oct:__ss.S.plan.staves[0].octave})`);
      check(`${to}: key`, r.k.every((k) => k === keyExp), JSON.stringify(r));
      if (to === 'alto-sax') await shot('altosax');
      if (to === 'cello') await shot('cello');
    }
    // export produces a PNG blob
    const exp = await b.evaluate(`new Promise((res)=>{const a=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){HTMLAnchorElement.prototype.click=a;fetch(this.href).then(r=>r.blob()).then(bl=>res({name:this.download,type:bl.type,size:bl.size}))};document.getElementById('export').click();})`);
    check('export PNG', exp.type === 'image/png' && exp.size > 50000, JSON.stringify(exp));

    // offline: once the service worker has cached the shell, the app and the sample load with no network
    await b.evaluate(`navigator.serviceWorker.ready.then(()=>1)`); await sleep(1500);
    await b.send('Network.enable');
    await b.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await b.send('Page.reload', { ignoreCache: false }); await sleep(1500);
    await waitFor(() => b.evaluate('!!window.__ss'), 10000);
    await b.evaluate(`document.getElementById('sample2').click(); 1`);
    const off = await waitFor(() => b.evaluate('__ss.S.model ? __ss.S.model.notes.length : 0'), 30000).catch(() => 0);
    check('works offline (service worker)', off > 90, String(off));
    for (const e of b.events) if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') errors.push(e.params.args.map((a) => a.value || a.description).join(' '));
    for (const e of b.events) if (e.method === 'Runtime.exceptionThrown') errors.push(e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
    check('no page errors', errors.length === 0, [...new Set(errors)].join(' | ').slice(0, 600));
  } catch (e) { check('smoke run', false, e.stack); }
  b.kill(); server.close();
  console.log(failed ? `${failed} FAILED` : 'all smoke checks passed');
  process.exit(failed ? 1 : 0);
})();

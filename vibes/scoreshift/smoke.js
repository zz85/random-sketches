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
const MIME = { '.pdf': 'application/pdf', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
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

    // key change by hand in the popup: staff 1 changes to D major after bar 2; notes after it are
    // read in D major (C♯), the clarinet plan gets E major there; then remove it again
    await b.evaluate(`document.querySelector('.chip').click();1`); await sleep(100);
    const kc = await b.evaluate(`(()=>{const sel=document.getElementById('pKcBar');if(!sel)return {ok:false};sel.value=sel.options[2].value;document.getElementById('pKcKey').value='2';document.getElementById('pOk').click();
      const st=__ss.S.model.staves[0],k=st.keyChanges[0];const after=st.notes.filter(n=>n.x>k.x0&&n.pitch.d%7===0&&!n.accid);
      return {ok:true,n:st.keyChanges.length,fifths:k.fifths,cs:after.length,sharp:after.every(n=>n.pitch.alter===1),plan:__ss.S.plan.staves[0].changes.map(c=>c.fifths)}})()`);
    check('key change added in the popup', kc.ok && kc.n === 1 && kc.fifths === 2 && kc.cs > 0 && kc.sharp && kc.plan.join() === '4', JSON.stringify(kc));
    await b.evaluate(`document.querySelector('.chip').click();1`); await sleep(100);
    const kc2 = await b.evaluate(`(()=>{const s=document.querySelector('[data-kc="0"]');s.value='none';document.getElementById('pOk').click();return __ss.S.model.staves[0].keyChanges.length})()`);
    check('key change removed in the popup', kc2 === 0, String(kc2));

    // other instruments
    for (const [to, keyExp] of [['alto-sax', 4], ['F-horn', 2], ['A-clarinet', -2], ['cello', 1]]) {
      await b.evaluate(`(()=>{const s=document.getElementById('to');s.value='${to}';s.dispatchEvent(new Event('change'));document.querySelector('[data-view=transposed]').click();return 1})()`);
      await sleep(250);
      const r = await b.evaluate(`({k:__ss.S.plan.staves.map(p=>p.fifths),clef:__ss.S.plan.staves[0].clefId,oct:__ss.S.plan.staves[0].octave})`);
      check(`${to}: key`, r.k.every((k) => k === keyExp), JSON.stringify(r));
      if (to === 'alto-sax') await shot('altosax');
      if (to === 'cello') await shot('cello');
    }
    // PDF: title page is skipped, page 2 (minuet) opens, thumbnails, paging, whole-file export
    await b.evaluate(`fetch('fixtures/parts.pdf').then(r=>r.blob()).then(bl=>__ss.load(new File([bl],'parts.pdf',{type:'application/pdf'}),'parts.pdf')).then(()=>1)`);
    const pdf = await b.evaluate(`({page:__ss.S.pdf?.page,n:__ss.S.pdf?.n,staves:__ss.S.model?.staves.length,notes:__ss.S.model?.notes.length,keys:__ss.S.model?.staves.map(s=>s.key.fifths),status:document.getElementById('status').textContent,thumbs:document.querySelectorAll('#thumbs button').length})`);
    check('PDF opens at the first page with music', pdf.n === 3 && pdf.page === 2, JSON.stringify(pdf).slice(0, 160));
    check('PDF page recognised (minuet: 4 staves, G major)', pdf.staves === 4 && pdf.notes >= 90 && pdf.keys.every((k) => k === 1), `${pdf.notes} notes`);
    await sleep(800);
    const th = await b.evaluate(`document.querySelectorAll('#thumbs canvas').length`);
    check('page thumbnails', pdf.thumbs === 3 && th === 3, `${th}/3`);
    await shot('pdf');
    await b.evaluate(`document.getElementById('nextPage').click();1`);
    await waitFor(() => b.evaluate(`__ss.S.pdf.page===3 && __ss.S.model && __ss.S.model.staves.length===3`), 20000).catch(() => {});
    const p3 = await b.evaluate(`({page:__ss.S.pdf.page,keys:__ss.S.model.staves.map(s=>s.key.fifths)})`);
    check('next page: flats (B♭ major)', p3.page === 3 && p3.keys.every((k) => k === -2), JSON.stringify(p3));
    await b.evaluate(`document.querySelector('#thumbs button[data-page="1"]').click();1`); await sleep(2500);
    const p1 = await b.evaluate(`({page:__ss.S.pdf.page,model:!!__ss.S.model,status:document.getElementById('status').textContent})`);
    check('title page shown as is', p1.page === 1 && !p1.model && /no staves/.test(p1.status), p1.status.slice(0, 80));
    const pdfOut = await b.evaluate(`new Promise((res)=>{const a=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){HTMLAnchorElement.prototype.click=a;const name=this.download;
      fetch(this.href).then(r=>r.arrayBuffer()).then(async buf=>{const {openPdf}=await import('./pdfsource.js');const d=await openPdf(new Blob([buf]));const pg=await d.getPage(2);const v=pg.getViewport({scale:1});res({name,size:buf.byteLength,pages:d.numPages,w:Math.round(v.width),h:Math.round(v.height)})})};
      document.getElementById('exportPdf').click();})`);
    check('transposed PDF export (3 Letter pages, re-readable)', pdfOut.pages === 3 && pdfOut.w === 612 && pdfOut.h === 792 && pdfOut.size > 100000, JSON.stringify(pdfOut));
    const ex2 = await b.evaluate(`(()=>{const a=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){};return __ss.exportPdf().finally(()=>{HTMLAnchorElement.prototype.click=a})})()`);
    check('export: music pages transposed in workers, title page kept', ex2.music === 2, JSON.stringify(ex2));
    await b.evaluate(`document.getElementById('sample').click();1`);
    await waitFor(() => b.evaluate(`!__ss.S.pdf && __ss.S.model && __ss.S.model.notes.length > 90`), 20000).catch(async () => console.log(await b.evaluate(`JSON.stringify({pdf:!!__ss.S.pdf,m:__ss.S.model?.notes.length,st:document.getElementById("status").textContent,busy:document.getElementById("busy").style.display})`)));

    // export produces a PNG blob
    const exp = await b.evaluate(`new Promise((res)=>{const a=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){HTMLAnchorElement.prototype.click=a;fetch(this.href).then(r=>r.blob()).then(bl=>res({name:this.download,type:bl.type,size:bl.size}))};document.getElementById('export').click();})`);
    check('export PNG', exp.type === 'image/png' && exp.size > 50000, JSON.stringify(exp));

    // rhythm: bar check in the status line, corrections in Interpreted view, playback, MusicXML / MIDI
    await b.evaluate(`document.querySelector('[data-view=interpreted]').click();1`); await sleep(300);
    const rh = await b.evaluate(`(()=>{const sc=__ss.S.score;return {bars:sc.measures.length,stats:sc.stats,status:document.getElementById('status').textContent}})()`);
    check('sample: 24 bars read, most add up', rh.bars === 24 && rh.stats.ok + rh.stats.pickup + rh.stats.end >= 20, JSON.stringify(rh.stats));
    const clickAt = (x, y) => `(()=>{const R=__ss.S.rend,k=R.r/devicePixelRatio*__ss.S.zoom,r=document.getElementById('cv').getBoundingClientRect();
      document.getElementById('stage').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+${x}*k,clientY:r.top+${y}*k}));return 1})()`;
    const n0 = await b.evaluate(`(()=>{const n=__ss.S.model.staves[0].notes[1];return {x:n.x,y:n.y,dur:__ss.eventOf(n).dur}})()`);
    await b.evaluate(`document.getElementById('stage').scrollIntoView();1`);
    await b.evaluate(clickAt(n0.x, n0.y)); await sleep(200);
    const hasDur = await b.evaluate(`!!document.querySelector('#pop [data-dur="2"]')`);
    await b.evaluate(`document.querySelector('#pop [data-dur="2"]')?.click();1`); await sleep(200);
    const n1 = await b.evaluate(`(()=>{const n=__ss.S.model.staves[0].notes[1],e=__ss.eventOf(n);return {dur:e.dur,fixed:e.fixed,hint:document.querySelector('#pop .hint')?.textContent}})()`);
    check('tap a note: set it to a half note', hasDur && n1.dur === 2 && n1.fixed, JSON.stringify({ before: n0.dur, ...n1 }));
    await b.evaluate(`document.querySelector('#pop [data-dur="${n0.dur}"]').click();1`); await sleep(150);
    await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));1`);
    const mb = await b.evaluate(`(()=>{const m=__ss.S.score.measures[3];return {x:(m.x0+m.x1)/2+3,y:__ss.S.model.staves[0].pts?0:0,st:m.st.index}})()`);
    const my = await b.evaluate(`(()=>{const m=__ss.S.score.measures[3];const st=m.st;const x=m.x0+6;return {x, y:(window.__lineY?0:0)}})()`);
    await b.evaluate(`(()=>{const m=__ss.S.score.measures[3],st=m.st,x=m.x0+6,y=st.pts?0:0;return 1})()`);
    const barY = await b.evaluate(`(()=>{const m=__ss.S.score.measures[3];const n=m.events.find(e=>e.notes);return n.notes[0].st.band ? (n.notes[0].st.band[0]+n.notes[0].st.band[1])/2 : 0})()`);
    await b.evaluate(clickAt(mb.x + 4, barY)); await sleep(200);
    const bp = await b.evaluate(`document.querySelector('#pop h3')?.textContent || ''`);
    check('tap a bar: bar popup with its time signature', /^Bar 4/.test(bp) && (await b.evaluate(`!!document.getElementById('mB')`)), bp);
    await b.evaluate(`document.getElementById('mX')?.click();1`);
    await shot('rhythm');
    const dl = (id) => `new Promise((res)=>{const a=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){HTMLAnchorElement.prototype.click=a;const name=this.download;fetch(this.href).then(r=>r.arrayBuffer()).then(buf=>res({name,size:buf.byteLength,head:String.fromCharCode(...new Uint8Array(buf.slice(0,4))),text:new TextDecoder().decode(buf).slice(0,200000)}))};document.getElementById('${id}').click();})`;
    const xml = await b.evaluate(dl('xml'));
    check('MusicXML export (as written)', /as-written\.musicxml$/.test(xml.name) && xml.text.includes('<score-partwise') && (xml.text.match(/<measure /g) || []).length === 24, `${xml.name} ${xml.size} B`);
    await b.evaluate(`document.querySelector('[data-view=transposed]').click();1`); await sleep(200);
    const xmlT = await b.evaluate(dl('xml'));
    check('MusicXML export (transposed, with <transpose>)', /cello\.musicxml$/.test(xmlT.name) && xmlT.text.includes('<clef><sign>F</sign>'), xmlT.name);
    const mid = await b.evaluate(dl('midi'));
    check('MIDI export', mid.head === 'MThd' && mid.size > 300, `${mid.name} ${mid.size} B`);
    await b.evaluate(`document.getElementById('tempo').value='240';document.getElementById('tempo').dispatchEvent(new Event('change'));document.getElementById('play').click();1`);
    await sleep(900);
    const pl = await b.evaluate(`({playing:__ss.player.playing,sounding:(__ss.S.sounding||[]).length,label:document.getElementById('play').textContent})`);
    await b.evaluate(`document.getElementById('play').click();1`); await sleep(100);
    const pl2 = await b.evaluate(`({playing:__ss.player.playing,label:document.getElementById('play').textContent})`);
    check('playback with a playhead, and stop', pl.playing && pl.sounding > 0 && !pl2.playing && /Play/.test(pl2.label), JSON.stringify([pl, pl2]));
    // speed, metronome, position: start from bar 5 at half speed with the metronome on
    const tp = await b.evaluate(`(async()=>{const S=__ss.S;document.getElementById('speed').value='0.5';document.getElementById('speed').dispatchEvent(new Event('input'));
      document.getElementById('metro').checked=true;document.getElementById('metro').dispatchEvent(new Event('change'));
      const pos=document.getElementById('pos');pos.value=String(4*288+10);pos.dispatchEvent(new Event('input'));pos.dispatchEvent(new Event('change'));
      const from=S.startTick;document.getElementById('play').click();await new Promise(r=>setTimeout(r,700));
      const a=__ss.player.pos;await new Promise(r=>setTimeout(r,500));const b2=__ss.player.pos;document.getElementById('play').click();
      return {from,a:Math.round(a),b:Math.round(b2),text:document.getElementById('posText').textContent,clicks:__ss.player.metronome}})()`);
    // at tempo 240 x 0.5 = 120 quarter notes a minute: 0.5 s is one quarter, 96 ticks
    check('position, speed and metronome', tp.from === 1152 && tp.a > 1152 && Math.abs(tp.b - tp.a - 96) < 30 && /bar 5/.test(tp.text) && tp.clicks, JSON.stringify(tp));

    // the CODA audition sheet, if present locally (not committed): every bar adds up
    if (fs.existsSync(path.join(DIR, 'fixtures/local/coda.pdf'))) {
      await b.evaluate(`fetch('fixtures/local/coda.pdf').then(r=>r.blob()).then(bl=>__ss.load(new File([bl],'coda.pdf',{type:'application/pdf'}),'coda.pdf')).then(()=>1)`);
      await waitFor(() => b.evaluate(`!!(__ss.S.pdf && __ss.S.model && __ss.S.score)`), 30000).catch(() => {});
      const c = await b.evaluate(`(()=>{const sc=__ss.S.score;return {bars:sc.measures.length,stats:sc.stats,keys:__ss.S.model.staves.map(s=>s.key.fifths).join('')}})()`);
      check('CODA sheet: every bar adds up', c.bars >= 66 && c.stats.under + c.stats.over === 0 && c.keys === '22222233333', JSON.stringify(c));
      await b.evaluate(`document.querySelector('[data-view=interpreted]').click();1`); await sleep(300); await shot('coda');
      await b.evaluate(`document.getElementById('sample').click();1`);
      await waitFor(() => b.evaluate(`!__ss.S.pdf && __ss.S.model && __ss.S.model.notes.length > 90`), 20000).catch(() => {});
    }

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

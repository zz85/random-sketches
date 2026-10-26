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
  // served as deployed: the app at /scoreshift/, its siblings (the shared notation-ir, StaffInk) next to it
  const root = path.dirname(DIR), f = path.join(root, u.endsWith('/') ? u + 'index.html' : u);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
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
    await b.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/scoreshift/` });
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
    // pen annotations into the transposed PDF: a red and a blue mark on page 2, export with only red
    await b.evaluate(`document.querySelector('#thumbs button[data-page="2"]').click();1`);
    await waitFor(() => b.evaluate(`__ss.S.pdf.page===2 && !!__ss.S.model && !!__ss.S.score`), 20000).catch(() => {}); await sleep(400);
    const viewWas = await b.evaluate('__ss.S.view');
    const mk2 = await b.evaluate(`(async()=>{const S=__ss.S;document.querySelector('[data-view=transposed]').click();await new Promise(r=>setTimeout(r,200));
      const ir=(await __ss.toIR()).score,m=await import('../notation-ir/annotations.js'),{photoSurface}=await import('./surface.js'),{buildScore}=await import('./score.js');
      const surf=photoSurface({model:S.model,score:S.score,irc:await __ss.toIR(),view:()=>({X:x=>x,Y:y=>y,sp:16})}),items=m.itemsOf(ir);
      const ev=ir.events.filter(e=>e.src.line===0).sort((a,b)=>a.src.x-b.src.x),st=S.model.staves[0],sp=S.model.space||16;
      const blob=(e,color)=>{const x=e.src.x,y=__yOfP(st,8,x)-2*sp;return m.attachStrokes(surf,items,[[{x:x-10,y},{x:x+10,y},{x:x+10,y:y-12},{x:x-10,y:y-12},{x:x-10,y}]],{id:color,color,width:0.6})};
      const red=blob(ev[4],'#c2255c'),blue=blob(ev[10],'#1c7ed6');__ss.ANN.pages.set(2,[red,blue]);
      const r=S.rend.r,at=(e)=>({fx:e.src.x*r/S.rend.W,fy:(__yOfP(st,8,e.src.x)-2*sp-6)*r/S.rend.H});return {red:at(ev[4]),blue:at(ev[10]),kinds:[red.anchor.kind,blue.anchor.kind]}})()`);
    // through the export dialog: untick blue
    const pdfAnn = await b.evaluate(`new Promise((res)=>{const a=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){HTMLAnchorElement.prototype.click=a;
      fetch(this.href).then(r=>r.arrayBuffer()).then(async buf=>{const {openPdf,renderPage}=await import('./pdfsource.js');const d=await openPdf(new Blob([buf]));const {canvas:c}=await renderPage(d,2,2000);const g=c.getContext('2d');
        const px=(f,want)=>{const d2=g.getImageData(Math.round(f.fx*c.width)-6,Math.round(f.fy*c.height)-6,13,13).data;let n=0;for(let i=0;i<d2.length;i+=4){const [R,G,B]=[d2[i],d2[i+1],d2[i+2]];if(want==='red'?R>150&&G<90&&B<140:B>150&&R<90)n++}return n};
        res({red:px(${JSON.stringify(mk2.red)},'red'),blue:px(${JSON.stringify(mk2.blue)},'blue'),dialog:window.__dlg})}).catch((e)=>res({err:String(e&&e.stack||e)}))};
      document.getElementById('exportPdf').click();
      setTimeout(()=>{const p=document.getElementById('pop');window.__dlg=p.querySelector('h3')?.textContent;const blue=p.querySelector('[data-xc="#1c7ed6"]');if(blue)blue.checked=false;document.getElementById('xGo').click();},300);})`);
    check('pen annotations into the transposed PDF, by colour (red drawn, blue left out)', /annotations/.test(pdfAnn.dialog || '') && pdfAnn.red > 20 && pdfAnn.blue === 0 && mk2.kinds.join() === 'event,event', JSON.stringify({ ...pdfAnn, mk2 }));
    await b.evaluate(`(()=>{__ss.ANN.pages.clear();__ss.S.annExport=undefined;localStorage.removeItem('scoreshift.annExport');document.querySelector('[data-view=${viewWas}]').click();return 1})()`);
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
    // authored playback over the page: bars 2 and 5 at once, both light up on the photo
    const pp = await b.evaluate(`(async()=>{document.getElementById('speed').value='1';document.getElementById('speed').dispatchEvent(new Event('input'));
      const p=await __ss.playProgram({root:{par:[{play:{from:{bar:2},to:{bar:2,edge:'end'}}},{play:{from:{bar:5},to:{bar:5,edge:'end'}}}]}});
      await new Promise(r=>setTimeout(r,300));const on=(__ss.S.sounding||[]).map(o=>o.m.number);const playing=__ss.player.playing;
      document.getElementById('play').click();await new Promise(r=>setTimeout(r,50));
      return {notes:p.notes.length,cursors:new Set(p.notes.map(n=>n.cursor)).size,on,playing,after:__ss.player.playing,label:document.getElementById('play').textContent}})()`);
    check('authored playback: two bars at once, both on the playhead', pp.cursors === 2 && pp.playing && pp.on.includes(2) && pp.on.includes(5) && !pp.after && /Play/.test(pp.label), JSON.stringify(pp));
    // playhead lines: one gliding through the page on Play (drawn on its own canvas), one per cursor for a program
    const hd = await b.evaluate(`(async()=>{const S=__ss.S;S.programs.clear();__ss.update();S.startTick=0;document.getElementById('play').click();const xs=[];
      for(let k=0;k<5;k++){await new Promise(r=>setTimeout(r,220));const h=__ss.heads()?.[0];xs.push(h?h.line*1e5+h.x:null);}
      const h=__ss.heads()[0],r=S.rend.r,g=document.getElementById('ph').getContext('2d'),y=__yOfP(S.model.staves[h.line],4,h.x);
      const d=g.getImageData(Math.round(h.x*r)-4,Math.round(y*r)-4,9,9).data;let ink=0;for(let i=3;i<d.length;i+=4)if(d[i]>0)ink++;
      document.getElementById('play').click();await new Promise(r=>setTimeout(r,50));const after=(__ss.heads()||[]).length;
      await __ss.playProgram({root:{par:[{play:{from:{bar:2},to:{bar:2,edge:'end'}}},{play:{from:{bar:5},to:{bar:5,edge:'end'}}}]}},{keep:false});
      await new Promise(r=>setTimeout(r,300));const prog=__ss.heads().map(h=>h.color);__ss.player.stop();
      return {xs,ink,after,prog}})()`);
    check('playhead lines: glide on Play, one per cursor for a program', hd.xs.every((x, i) => x != null && (i === 0 || x > hd.xs[i - 1])) && hd.ink > 0 && hd.after === 0 && hd.prog.length === 2 && hd.prog[0] !== hd.prog[1], JSON.stringify(hd));
    // hand-off to StaffInk: the transposed (cello) part opens there, ready to edit with a pen
    const hand = await b.evaluate(`(async()=>{const h=await __ss.editInStaffInk({open:false});const f=document.createElement('iframe');f.style.cssText='position:fixed;left:0;top:0;width:900px;height:600px';
      document.body.appendChild(f);f.src='../staffink/?import&nohelp&nosw';
      for(let i=0;i<100&&!(f.contentWindow.StaffInk&&f.contentWindow.StaffInk.layout);i++)await new Promise(r=>setTimeout(r,100));
      const si=f.contentWindow.StaffInk,sc=si.score,evs=sc.measures.flatMap(m=>m.staves.flatMap(s=>s.events));
      const r={bars:sc.measures.length,notes:evs.filter(e=>e.kind==='note').length,clef:sc.staves[0].clef,title:sc.title,left:!!f.contentWindow.localStorage.getItem('staffink.import'),
        report:h.report,url:f.contentWindow.location.search,laid:!!si.layout&&si.layout.systems.length};f.remove();return r})()`);
    check('Edit in StaffInk: the recognised page opens as an editable score', hand.bars >= 24 && hand.notes >= 90 && hand.clef === 'F' && /cello/i.test(hand.title) && !hand.left && hand.laid > 0 && !/import/.test(hand.url), JSON.stringify({ ...hand, report: undefined }) + ' ' + JSON.stringify(hand.report));

    // grace notes move with the transposition: each grace head is ink at its new place
    await b.evaluate(`fetch('fixtures/grace.png').then(r=>r.blob()).then(bl=>__ss.load(new File([bl],'grace.png',{type:'image/png'}),'grace.png')).then(()=>1)`);
    await waitFor(() => b.evaluate(`!!(__ss.S.model && !__ss.S.pdf && __ss.S.model.notes.some(n=>n.grace))`), 20000).catch(() => {});
    await b.evaluate(`(()=>{const s=document.getElementById('to');s.value='Bb-clarinet';s.dispatchEvent(new Event('change'));document.querySelector('[data-view=transposed]').click();return 1})()`); await sleep(400);
    const gm = await b.evaluate(`(()=>{const S=__ss.S,R=S.rend,c=document.getElementById('cv'),g=c.getContext('2d');let n=0,ink=0,moved=0;
      const lum=(x,y)=>{const d=g.getImageData(Math.round(x*R.r)-1,Math.round(y*R.r)-1,3,3).data;let s=0;for(let i=0;i<36;i+=4)s+=(d[i]+d[i+1]+d[i+2])/3;return s/9};
      for(const sp of S.plan.staves) for(const nn of sp.notes){ if(!nn.n.grace) continue; n++; const W=R.warps.get(sp.st), x=W?W.warp(nn.n.x):nn.n.x, y=__yOfP(sp.st,nn.p,nn.n.x);
        if(lum(x,y)<120) ink++; if(nn.p!==nn.n.p) moved++; }
      return {n,ink,moved}})()`);
    check('grace notes move with the transposition', gm.n >= 5 && gm.ink >= gm.n - 1 && gm.moved === gm.n, JSON.stringify(gm));
    await shot('grace');

    // saving: a correction is autosaved and comes back when the same file is opened again; a
    // project file carries it to a fresh browser
    await b.evaluate(`document.getElementById('sample').click();1`);
    await waitFor(() => b.evaluate(`!__ss.S.pdf && __ss.S.model && __ss.S.model.notes.length > 90 && __ss.S.source`), 20000);
    const before = await b.evaluate(`(()=>{const st=__ss.S.model.staves[0],n=st.notes[2];return n.name})()`);
    await b.evaluate(`(()=>{const st=__ss.S.model.staves[0],n=st.notes[2];n.p+=1;n.y=__yOfP(st,n.p,n.x);__ss.S.model.staves[1].notes.splice(0,1);
      import('./omr.js').then(m=>{for(const q of __ss.S.model.staves)m.interpret(q)});return 1})()`); await sleep(100);
    await b.evaluate(`(async()=>{const m=await import('./omr.js');for(const q of __ss.S.model.staves)m.interpret(q);document.querySelector('[data-view=interpreted]').click();return 1})()`);
    // (any correction goes through markEdited: trigger it the way the popups do)
    await b.evaluate(`(()=>{const n=__ss.S.model.staves[0].notes[2];const r=document.getElementById('cv').getBoundingClientRect(),R=__ss.S.rend,k=R.r/devicePixelRatio*__ss.S.zoom;
      document.getElementById('stage').dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+n.x*k,clientY:r.top+n.y*k}));return 1})()`); await sleep(150);
    await b.evaluate(`document.getElementById('nUp').click();document.getElementById('nDn').click();1`); await sleep(300);
    const edited = await b.evaluate(`({name:__ss.S.model.staves[0].notes[2].name,n1:__ss.S.model.staves[1].notes.length})`);
    const proj = await b.evaluate(`new Promise((res)=>{const a=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){HTMLAnchorElement.prototype.click=a;const name=this.download;fetch(this.href).then(r=>r.text()).then(t=>{window.__proj=t;res({name,size:t.length})})};__ss.saveProject();})`);
    await b.evaluate(`document.getElementById('sample').click();1`); await sleep(300);
    await waitFor(() => b.evaluate(`!!(__ss.S.model && __ss.S.model.staves[0].notes[2])`), 20000);
    await sleep(500);
    const again = await b.evaluate(`({name:__ss.S.model.staves[0].notes[2].name,n1:__ss.S.model.staves[1].notes.length,status:document.getElementById('status').textContent})`);
    check('corrections autosaved and restored on reopening the file', again.name === edited.name && again.n1 === edited.n1 && edited.name !== before && /restored/.test(again.status), JSON.stringify({ before, edited, again: { ...again, status: again.status.slice(-40) } }));
    // project into a browser that has never seen it: clear the autosave, then open the project
    await b.evaluate(`new Promise(r=>{const q=indexedDB.deleteDatabase('scoreshift');q.onsuccess=q.onerror=q.onblocked=()=>r(1)})`);
    await b.evaluate(`__ss.load(new File([window.__proj],'sample.scoreshift',{type:'application/json'}),'sample.scoreshift').then(()=>1)`);
    await waitFor(() => b.evaluate(`!!(__ss.S.model && __ss.S.model.staves[0].notes[2])`), 20000);
    const fromProj = await b.evaluate(`({name:__ss.S.model.staves[0].notes[2].name,n1:__ss.S.model.staves[1].notes.length})`);
    check('project file reopens with its corrections', /\.scoreshift$/.test(proj.name) && fromProj.name === edited.name && fromProj.n1 === edited.n1, JSON.stringify({ proj, fromProj }));
    // a playback program saved in the project follows its notes through the corrections
    const prog = await b.evaluate(`(async()=>{const ir=(await __ss.toIR()).score,ev=ir.events.filter(e=>e.src.line===0);
      const want=[ev[6],ev[8]].map(e=>e.heads.map(h=>h.d).join());
      const p=await __ss.playProgram({root:{play:{events:[ev[6].id,ev[8].id]},gaps:'compress'}});__ss.player.stop();
      const proj=await new Promise((res)=>{const a=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){HTMLAnchorElement.prototype.click=a;fetch(this.href).then(r=>r.text()).then(res)};__ss.saveProject();});
      await __ss.load(new File([proj],'p.scoreshift',{type:'application/json'}),'p.scoreshift');
      for(let i=0;i<100&&!(__ss.S.model&&__ss.S.score);i++)await new Promise(r=>setTimeout(r,100));
      const again=await __ss.playProgram();__ss.player.stop();
      const ir2=(await __ss.toIR()).score;const got=again.notes?again.notes.map(n=>ir2.events.find(e=>e.id===n.event)).map(e=>e.heads.map(h=>h.d).join()):[];
      return {saved:JSON.parse(proj).programs?Object.keys(JSON.parse(proj).programs).length:0,notes:p.notes.length,again:again.notes?.length,same:JSON.stringify([...new Set(got)])===JSON.stringify(want),lost:again.lost?.length||0}})()`);
    check('a playback program saved in the project plays the same notes after reopening', prog.saved === 1 && prog.notes === 2 && prog.again === 2 && prog.same && !prog.lost, JSON.stringify(prog));
    // the program is drawn on the photo; a correction deleting one of its notes turns that marker red, and Play says which
    const mk = await b.evaluate(`(async()=>{await __ss.refreshMarkers();const m1=__ss.markers();const ir=(await __ss.toIR()).score,ev=ir.events.filter(e=>e.src.line===0);
      const st=__ss.S.model.staves[0],n=st.notes.find(q=>Math.abs(q.x-ev[6].src.x)<1);st.notes.splice(st.notes.indexOf(n),1);__ss.S.model.notes.splice(__ss.S.model.notes.indexOf(n),1);
      (await import('./omr.js')).interpret(st);__ss.update();await new Promise(r=>setTimeout(r,400));const m2=__ss.markers();const p=await __ss.playProgram();
      return {before:m1&&m1.items.map(i=>i.label),after:m2&&m2.items.map(i=>i.label),lost:m2&&m2.lost.length,refused:!!(p&&p.lost),status:document.getElementById('status').textContent.slice(0,120)}})()`);
    check('saved markers drawn on the page; a deleted note turns its marker red', mk.before?.join() === 'A' && mk.after?.join() === 'A ?' && mk.lost === 1 && mk.refused && /marker lost its note.*A/.test(mk.status), JSON.stringify(mk));
    await shot('markers');
    // authoring on the photo with real clicks: Markers mode, tap bar 3, Shift+tap bar 4, loop it, keep it as a clip, a jump
    await b.evaluate(`(()=>{__ss.S.programs.clear();__ss.MKS.on=false;__ss.update();return 1})()`); await sleep(300);
    const tap = async (x, y, modifiers = 0) => { for (const type of ['mousePressed', 'mouseReleased']) await b.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1, modifiers }); await sleep(150); };
    const at = (sel) => b.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:'center'});const q=e.getBoundingClientRect();return {x:q.left+q.width/2,y:q.top+q.height/2}})()`);
    const press = async (sel) => { const q = await at(sel); await tap(q.x, q.y); };
    const barXY = (n) => b.evaluate(`(()=>{const m=__ss.S.score.measures[${n - 1}],S=__ss.S,k=(S.rend.r/devicePixelRatio)*S.zoom;document.getElementById('stage').scrollIntoView({block:'start'});
      const r=document.getElementById('cv').getBoundingClientRect(),x=(m.x0+m.x1)/2;return {x:r.left+x*k,y:r.top+__yOfP(m.st,4,x)*k}})()`);
    await press('#markMode'); await sleep(300);
    let q = await barXY(3); await tap(q.x, q.y); q = await barXY(4); await tap(q.x, q.y, 8);
    const sel = await b.evaluate(`({h:document.querySelector('#pop h3')?.textContent,n:__ss.rangeNow()?.n})`);
    await press('#rLoop'); await press('#rPlay'); await sleep(400);
    const looping = await b.evaluate(`({playing:__ss.player.playing,bars:[...new Set((__ss.S.sounding||[]).map(o=>o.m.number))]})`);
    await press('#play'); await sleep(100);
    q = await barXY(3); await tap(q.x, q.y); await press('#rClip'); await sleep(300);
    q = await barXY(6); await tap(q.x, q.y); await press('#rJump'); q = await barXY(2); await tap(q.x - 20, q.y); await sleep(300);
    const au = await b.evaluate(`(async()=>{const a=__ss.arrOf();const p=await __ss.playProgram();__ss.player.stop();const ir=await __ss.toIR();
      return {clips:a.clips.map(c=>c.name),jumps:a.jumps.length,mode:a.mode,labels:__ss.markers().items.map(i=>i.label),bars:p.notes.map(n=>ir.byId.get(n.event).m.number).filter((v,i,x)=>i===0||v!==x[i-1]).slice(0,9).join()}})()`);
    check('authoring on the photo: select bars, loop them, keep a clip, add a jump that Play takes', sel.h === 'Bars 3–4 · 8 notes' && looping.playing && looping.bars.every((n) => n === 3 || n === 4) && au.clips.join() === 'A' && au.jumps === 1 && au.mode === 'score' && au.bars === '1,2,3,4,5,6,2,3,4', JSON.stringify({ sel, looping, au }));
    // fingers: a quick swipe leaves the page to scroll; hold, then drag selects (and holds the page still)
    await b.evaluate(`(()=>{__ss.MKS.range=null;document.getElementById('pop').style.display='none';window.scrollTo(0,0);document.getElementById('wrap').scrollTop=0;window.__prev=[];window.addEventListener('touchmove',(e)=>__prev.push(e.defaultPrevented));return 1})()`);
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    const nxy = (i) => b.evaluate("(()=>{const S=__ss.S,st=S.model.staves[0],k=(S.rend.r/devicePixelRatio)*S.zoom,r=document.getElementById('cv').getBoundingClientRect();const n=st.notes.slice().sort((a,b)=>a.x-b.x)[" + i + "];return {x:r.left+n.x*k,y:r.top+n.y*k}})()");
    const tch = (type, pt) => b.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: pt.x, y: pt.y }] });
    let t0 = await nxy(1), t1 = await nxy(6);
    await tch('touchStart', t0); for (let k = 1; k <= 6; k++) { await tch('touchMove', { x: t0.x, y: t0.y - 20 * k }); await sleep(16); } await tch('touchEnd', t0); await sleep(300);
    const swipe = await b.evaluate(`({range:!!__ss.rangeNow(),prevented:__prev.some(Boolean)})`);
    await b.evaluate(`__prev=[];1`);
    await tch('touchStart', t0); await sleep(500);
    for (let k = 1; k <= 8; k++) { await tch('touchMove', { x: t0.x + (t1.x - t0.x) * k / 8, y: t0.y + (t1.y - t0.y) * k / 8 }); await sleep(20); }
    await tch('touchEnd', t1); await sleep(300);
    const held = await b.evaluate(`({n:__ss.rangeNow()?.n,h:document.querySelector('#pop h3')?.textContent,prevented:__prev.length>0&&__prev.every(Boolean)})`);
    await b.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    check('fingers: a swipe scrolls, a hold then drag selects notes', !swipe.range && !swipe.prevented && held.n >= 4 && /^Bars \d+–\d+ · /.test(held.h) && held.prevented, JSON.stringify({ swipe, held }));
    // clip order chips in the transport: drag the last clip to the front
    await b.evaluate(`(async()=>{__ss.MKS.range=null;document.getElementById('pop').style.display='none';const m=await import('../notation-ir/arrangement.js');const ir=(await __ss.toIR()).score;
      const ev=ir.events.filter(e=>e.src.line===0).sort((a,b)=>a.src.x-b.src.x);const a={...m.emptyArrangement(),mode:'clips'};
      for(const k of [0,4,8])m.addClip(a,{first:ev[k].id,last:ev[k+1].id});__ss.S.programs.set(1,{arrangement:a});await __ss.refreshMarkers();return 1})()`); await sleep(300);
    const cxy = await b.evaluate(`(()=>{const c=[...document.querySelectorAll('#clipOrder .clipchip')];c[0].scrollIntoView({block:'center'});const r=(x)=>x.getBoundingClientRect();return {from:{x:r(c[2]).left+r(c[2]).width/2,y:r(c[2]).top+r(c[2]).height/2},to:{x:r(c[0]).left-4,y:r(c[0]).top+r(c[0]).height/2}}})()`);
    await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cxy.from.x, y: cxy.from.y, button: 'left', buttons: 1, clickCount: 1 });
    for (let k = 1; k <= 8; k++) await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cxy.from.x + (cxy.to.x - cxy.from.x) * k / 8, y: cxy.from.y, button: 'left', buttons: 1 });
    await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cxy.to.x, y: cxy.to.y, button: 'left', buttons: 0, clickCount: 1 }); await sleep(300);
    const order = await b.evaluate(`(async()=>{const o=__ss.arrOf().clips.map(c=>c.name).join();const p=await __ss.playProgram();__ss.player.stop();const ir=(await __ss.toIR()).score;
      const xs=p.notes.map(n=>ir.events.find(e=>e.id===n.event).src.x);return {o,firstIsC:xs[0]>xs[2]&&xs[2]<xs[4]}})()`);
    check('clip order chips: drag a clip to play it first', order.o === 'C,A,B' && order.firstIsC, JSON.stringify(order));
    // ✎ Annotate: a pen writes a "3" over a note and circles two bars; the ink sticks to the music
    const markersWere = await b.evaluate('__ss.MKS.on'); // Annotate turns Markers off; put it back after
    await b.evaluate(`(()=>{__ss.S.programs.clear();__ss.MKS.range=null;document.querySelector('[data-view=transposed]').click();if(__ss.MKS.on)document.getElementById('markMode').click();document.getElementById('pop').style.display='none';window.scrollTo(0,0);document.getElementById('wrap').scrollTop=0;__ss.update();return 1})()`);
    await press('#annMode'); await sleep(300);
    const pg = (x, y) => b.evaluate("(()=>{const S=__ss.S,k=(S.rend.r/devicePixelRatio)*S.zoom,r=document.getElementById('cv').getBoundingClientRect();return {x:r.left+(" + x + ")*k,y:r.top+(" + y + ")*k}})()");
    const stroke = async (pts) => { const c = []; for (const [x, y] of pts) c.push(await pg(x, y));
      await b.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c[0].x, y: c[0].y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: 0.5 });
      for (const q of c.slice(1)) await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: q.x, y: q.y, button: 'left', buttons: 1, pointerType: 'pen', force: 0.6 });
      await b.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.at(-1).x, y: c.at(-1).y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' }); };
    const nt = await b.evaluate(`(()=>{const st=__ss.S.model.staves[0],n=st.notes.slice().sort((a,b)=>a.x-b.x)[8];return {x:n.x,top:__yOfP(st,8,n.x),sp:__ss.S.model.space||16}})()`);
    await stroke([[nt.x - 5, nt.top - 2.6 * nt.sp], [nt.x + 4, nt.top - 2.7 * nt.sp], [nt.x - 1, nt.top - 2.1 * nt.sp]]); await sleep(120);
    await stroke([[nt.x - 1, nt.top - 2.1 * nt.sp], [nt.x + 5, nt.top - 1.7 * nt.sp], [nt.x - 5, nt.top - 1.2 * nt.sp]]); await sleep(900);
    const bx = await b.evaluate(`(()=>{const m=__ss.S.score.measures.filter(q=>q.st.index===1),st=m[1].st,sp=__ss.S.model.space||16;return {x0:m[1].x0+6,x1:m[2].x1-6,y0:__yOfP(st,8,m[1].x0)-1.4*sp,y1:__yOfP(st,0,m[1].x0)+1.4*sp}})()`);
    const ccx = (bx.x0 + bx.x1) / 2, ccy = (bx.y0 + bx.y1) / 2, crx = (bx.x1 - bx.x0) / 2, cry = (bx.y1 - bx.y0) / 2;
    await stroke(Array.from({ length: 25 }, (_, i) => [ccx + crx * Math.cos(i / 24 * 2 * Math.PI), ccy + cry * Math.sin(i / 24 * 2 * Math.PI)])); await sleep(900);
    const ink = (x, y) => "(()=>{const S=__ss.S,r=S.rend.r,d=document.getElementById('an').getContext('2d').getImageData(Math.round((" + x + ")*r)-6,Math.round((" + y + ")*r)-6,13,13).data;let n=0;for(let i=3;i<d.length;i+=4)if(d[i]>40)n++;return n})()";
    // where the mark is, measured from its note as drawn in this view (transposed staves stretch)
    const where = `(async()=>{const m=await import('../notation-ir/annotations.js');const a=__ss.annotations()[0];await __ss.refreshAnnotations();const S=__ss.S,r=m.resolveAnnotation(S.surf,a,__ss.ANN.items);
      const note=S.surf.place(a.anchor.id,'center')[0];return {dx:Math.round(r.pieces[0].points[0].x-note.x),y:Math.round(r.pieces[0].points[0].y),lost:r.lost,view:S.view}})()`;
    const an1 = await b.evaluate(`({kinds:__ss.annotations().map(a=>a.anchor.kind),strokes:__ss.annotations()[0]?.strokes.length})`);
    const w0 = await b.evaluate(where), inkAt = await b.evaluate(ink(nt.x - 1, nt.top - 2.1 * nt.sp));
    await b.evaluate(`document.querySelector('[data-view=original]').click();1`); await sleep(300); const wOrig = await b.evaluate(where);
    await b.evaluate(`document.querySelector('[data-view=transposed]').click();1`); await sleep(200);
    await b.evaluate(`(async()=>{const st=__ss.S.model.staves[0];st.notes.splice(1,1);(await import('./omr.js')).interpret(st);__ss.update();return 1})()`); await sleep(400);
    const wFix = await b.evaluate(where);
    check('✎ Annotate: pen ink sticks to its note and passage, in both views and through a correction', an1.kinds.join() === 'event,span' && an1.strokes === 2 && inkAt > 10 && w0.view === 'transposed' && wOrig.view === 'original' && wOrig.dx === w0.dx && wOrig.y === w0.y && wFix.dx === w0.dx && wFix.y === w0.y && !w0.lost && !wFix.lost, JSON.stringify({ an1, w0, wOrig, wFix, inkAt }));
    // eraser, undo, and the project carries the ink
    await press('#annErase'); await stroke([[ccx - crx, ccy], [ccx - crx + 8, ccy + 2]]); await sleep(200);
    const afterErase = await b.evaluate(`__ss.annotations().length`);
    await press('#annUndo'); const afterUndo = await b.evaluate(`__ss.annotations().length`); await press('#annErase');
    const proj2 = await b.evaluate(`new Promise((res)=>{const a=HTMLAnchorElement.prototype.click;HTMLAnchorElement.prototype.click=function(){HTMLAnchorElement.prototype.click=a;fetch(this.href).then(r=>r.text()).then(res)};__ss.saveProject();})`);
    await press('#annMode');
    await b.evaluate(`__ss.load(new File([${JSON.stringify(proj2)}],'p.scoreshift',{type:'application/json'}),'p.scoreshift').then(()=>1)`);
    await waitFor(() => b.evaluate(`!!(__ss.S.model && __ss.S.score && __ss.annotations().length)`), 20000).catch(() => {}); await sleep(500);
    const back = { ...(await b.evaluate(`(async()=>{await __ss.refreshAnnotations();return {n:__ss.annotations().length}})()`)), inProject: (JSON.parse(proj2).annotations?.[1] || []).length };
    check('annotations: eraser, undo, saved in the project and back on reopening', afterErase === 1 && afterUndo === 2 && back.n === 2 && back.inProject === 2, JSON.stringify({ afterErase, afterUndo, back }));
    await shot('annotate');
    await b.evaluate(`(()=>{__ss.ANN.pages.clear();__ss.update();return 1})()`);
    if (markersWere !== (await b.evaluate('__ss.MKS.on'))) await press('#markMode');
    await press('#markMode'); await b.evaluate(`(()=>{__ss.S.programs.clear();__ss.update();return 1})()`);

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

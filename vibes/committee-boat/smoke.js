// node smoke.js : loads the page in headless Chromium with the demo fleet, runs a start and a finish, screenshots.
import { launch, sleep } from './cdp.js';
import fs from 'fs';
import path from 'path';
const base = 'file://' + path.resolve('index.html');
const b = await launch({ width: 430, height: 932, port: 9371 });
const errors = [];
let ok = 0, fail = 0;
const check = (name, cond, info = '') => { cond ? ok++ : fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); };
const shot = async (f) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); };
const ev = (s) => b.evaluate(s);
const exceptions = () => { for (const e of b.events.splice(0)) if (e.method === 'Runtime.exceptionThrown') errors.push(e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text); };
const tab = (t) => ev(`document.querySelector('nav [data-tab=${t}]').click()`);
const tap = (sel) => ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.click(); return true; })()`);
try {
  // record what would be spoken, and say it instantly
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__said = []; if (window.speechSynthesis) { speechSynthesis.speak = (u) => { if (u.text) __said.push(u.text); setTimeout(() => u.onend && u.onend(), 0); }; }` });
  await b.send('Page.navigate', { url: base + '?demo=600&fresh=1' });
  await sleep(1500);
  exceptions();
  check('no exceptions on load', errors.length === 0, errors.join('\n'));
  check('demo fleet of 12', await ev("document.querySelectorAll('#fleetlist .boat').length") === 12);
  check('A-Z sort puts The Albatross under A', await ev("document.querySelector('#fleetlist .nm').textContent") === 'The Albatross');
  await ev("document.querySelector('#fleetsort [data-sort=sail]').click()");
  check('sail number sort starts with 7, 42, 46', await ev("[...document.querySelectorAll('#fleetlist .sail')].slice(0,3).map(e=>e.textContent).join()") === '7,42,46');
  await shot('smoke_fleet.png');

  // start: first start in 4 s, the others 5 min apart
  await tab('start');
  check('one start per fleet', await ev('app.race().starts.length') === 3);
  await ev(`(() => { const r = app.race(), t = Math.floor(app.nowSec()) + 4; r.starts.forEach((s, i) => s.time = t + i * 300); app.render(); })()`);
  const first = await ev('app.race().starts[0].label');
  await sleep(300);
  check('banner says the first start is not yet clear', /Not yet/.test(await ev("document.getElementById('crossbanner').textContent")));
  const early = await ev(`document.querySelector('#startlist .boat').dataset.bid`);
  await ev(`document.querySelector('#startlist .boat [data-a=cross]').click()`);
  await sleep(200);
  check('crossing before the gun is OCS', await ev(`app.race().entries['${early}'].start`) === 'ocs');
  check('OCS badge on the Start tab', await ev("document.getElementById('ocsbadge').textContent") === '1');
  check('said over early', await ev("__said.some(s => /^Over early/.test(s))"));
  await sleep(4500);
  exceptions();
  check('start announced with the boats clear to cross', await ev(`__said.some(s => s.startsWith(${JSON.stringify(first + ' start. Clear to cross:')}))`), await ev('__said.slice(-3).join(" | ")'));
  check('countdown spoken', await ev("['3','2','1'].every(c => __said.includes(c))"));
  check('banner shows the first start clear', (await ev("document.getElementById('crossbanner').textContent")).includes('Clear to cross: ' + first));
  const rows = await ev(`[...document.querySelectorAll('#startlist .list')[0].querySelectorAll('.boat')].map(e => e.className)`);
  check('boats of the first start are clear to cross', rows.filter((c) => /st-clear/.test(c)).length === rows.length - 1, rows.join());
  await ev(`document.querySelectorAll('#startlist .list')[0].querySelectorAll('.boat')[1].querySelector('[data-a=cross]').click()`);
  await ev(`document.querySelector('#startlist [data-bid="${early}"] [data-a=returned]').click()`);
  await sleep(200);
  check('returned OCS boat is started', await ev(`app.race().entries['${early}'].start === 'ok' && app.race().entries['${early}'].returned`));
  check('second boat started after the gun', (await ev(`document.querySelectorAll('#startlist .list')[0].querySelectorAll('.boat')[1].className`)).includes('st-started'));
  await shot('smoke_start.png');

  // finish
  await tab('finish');
  await ev(`(() => { const i = document.getElementById('lookup'); i.value = '42'; i.dispatchEvent(new Event('input')); })()`);
  check('partial sail number finds Salty Dog', (await ev("document.querySelector('#sugg button').textContent")).includes('Salty Dog'));
  await ev(`document.getElementById('lookup').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
  await ev(`(() => { const i = document.getElementById('lookup'); i.value = 'kin'; i.dispatchEvent(new Event('input')); })()`);
  await ev(`document.querySelector('#sugg button').click()`);
  check('two boats on deck', await ev('app.race().queue.length') === 2);
  check('finish button names the first on deck', (await ev("document.getElementById('finishbtn').textContent")).includes('Salty Dog'));
  await tap('#finishbtn');
  await sleep(100);
  check('finish recorded for Salty Dog', await ev("app.S.boats.find(b => b.id === app.race().finishes[0].boatId).name") === 'Salty Dog');
  await tap('#finishbtn');
  await tap('#finishbtn'); // nobody on deck: a time to name later
  await sleep(100);
  check('time with nobody on deck is an unknown boat', await ev('app.race().finishes.filter(f => !f.boatId).length') === 1);
  check('unknown badge', await ev("document.getElementById('unkbadge').textContent") === '1');
  // name the unknown time
  await ev(`document.querySelector('#finlist .fin.unk [data-e=who]').click()`);
  await sleep(100);
  await ev(`(() => { const q = document.getElementById('pickq'); q.value = 'blue'; q.dispatchEvent(new Event('input')); document.querySelector('#picklist [data-pick]').click(); })()`);
  await sleep(100);
  check('unknown time assigned to Blue Moon', await ev("app.race().finishes.every(f => f.boatId) && app.S.boats.find(b => b.name === 'Blue Moon').id === app.race().finishes[2].boatId"));
  // edit a time to h:m:s
  await ev(`document.querySelector('#finlist .fin [data-e=edit]').click()`);
  await ev(`(() => { const r = document.querySelector('#finlist .tedit'); r.querySelector('[data-p=h]').value = 15; r.querySelector('[data-p=m]').value = 7; r.querySelector('[data-p=s]').value = 9; r.querySelector('[data-e=ok]').click(); })()`);
  check('time edited to 15:07:09', await ev("app.race().finishes.some(f => f.t === 15*3600+7*60+9 && f.src === 'manual')"));
  // horn
  const atStart = (dt) => `app.onHorn(app.nowMs() - (app.nowSec() - app.race().starts[0].time - ${dt}) * 1000)`;
  await ev(atStart(1));
  check('horn 1 s after a start signal is ignored', /ignored/.test(await ev("document.getElementById('hornstat').textContent")) && await ev("!app.race().finishes.some(f => f.src === 'horn')"));
  await ev(atStart(20));
  check('horn records a finish', await ev("app.race().finishes.some(f => f.src === 'horn')"));
  // retire one
  await ev(`document.querySelector('#racinglist [data-r=ret]').click()`);
  check('retired boat listed under Out', (await ev("document.getElementById('outlist').textContent")).includes('RET'));
  check('said a finish', await ev("__said.some(s => /Salty Dog/.test(s))"));
  await shot('smoke_finish.png');

  // results
  await tab('results');
  await sleep(200);
  check('results tables for three fleets', await ev("document.querySelectorAll('#reslist table').length") === 3);
  check('finish before its start is flagged', /finish before start/.test(await ev("document.getElementById('reslist').textContent")));
  await ev('app.race().starts.forEach(s => s.time -= 3600); app.render()');
  check('placed boats have corrected times', await ev("[...document.querySelectorAll('#reslist tbody tr')].some(tr => /^1$/.test(tr.cells[0].textContent))"));
  await shot('smoke_results.png');

  // persistence and undo
  const n = await ev('app.race().finishes.length');
  await b.send('Page.navigate', { url: base });
  await sleep(1200);
  check('finishes survive a reload', await ev('app.race().finishes.length') === n);
  await ev("app.S.set.theme = 'night'; app.render()");
  await tab('start');
  await sleep(300);
  await shot('smoke_night.png');
  exceptions();
  check('no exceptions at the end', errors.length === 0, errors.join('\n'));
} finally { b.kill(); }
console.log(`${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);

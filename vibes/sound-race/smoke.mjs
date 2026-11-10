// node smoke.mjs : loads the page in headless Chromium, checks for errors, sails the pre-start, starts, races
// with rivals at 32x, tacks, and screenshots.
import { launch, sleep, waitFor } from './cdp.mjs';
import fs from 'fs';
import path from 'path';
const url = 'file://' + path.resolve('index.html');
const b = await launch({ width: 1400, height: 860, port: 9361 });
let ok = 0, fail = 0;
const check = (name, cond, info = '') => { cond ? ok++ : fail++; console.log((cond ? 'ok   ' : 'FAIL ') + name + (info ? '  ' + info : '')); };
const shot = async (f) => { const r = await b.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(f, Buffer.from(r.result.data, 'base64')); };
const errs = () => b.events.filter((e) => e.method === 'Runtime.exceptionThrown').map((e) => e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text);
const G = (expr) => b.evaluate(`(() => { const g = SoundRace.game; return ${expr}; })()`);
try {
  await b.send('Page.navigate', { url: url + '?day=0' });
  await sleep(2500);
  check('no exceptions on load', errs().length === 0, errs().join('\n'));
  check('four boats on the course', (await G('g.boats.length')) === 4);
  await shot('smoke_prestart.png');
  // Sail the pre-start fast: VMG helm on starboard reaches the line around the gun from 320 m below.
  await b.evaluate('SoundRace.setSpeed(5)');
  await waitFor(() => G('g.tg > 60'), 30000);
  const started = await G('g.me.e.started != null || g.me.e.ocs');
  check('player crossed the line after the gun or is OCS', started, await G('JSON.stringify(g.me.e)'));
  check('rivals started', await G('g.boats.slice(1).every((B) => B.e.started != null)'));
  const bs = await G('g.me.b.bs');
  check('boat sailing at polar speed', bs > 4, bs.toFixed(2) + ' kn');
  await shot('smoke_beat.png');
  // Tack onto port.
  await b.evaluate("dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))");
  await waitFor(() => G('g.me.b.twa < -30'), 20000);
  check('tacked onto port', (await G('g.me.b.tacks')) >= 1);
  // Steer: arrows switch to holding a wind angle.
  await b.evaluate("dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true }))");
  check('arrows hold a wind angle', (await G('g.helm.mode')) === 'twa');
  await b.evaluate("dispatchEvent(new KeyboardEvent('keydown', { key: 'v' }))");
  check('V returns to the VMG angle', (await G('g.helm.mode')) === 'vmg');
  // Let the rivals race to the windward mark and beyond.
  await waitFor(() => G('g.boats.slice(1).some((B) => B.e.leg >= 2)'), 120000);
  check('a rival rounded the windward mark', true);
  await b.evaluate("document.getElementById('s-north').click()");
  await sleep(500);
  await shot('smoke_rounding.png');
  check('no exceptions while racing', errs().length === 0, errs().join('\n'));
  // A southerly day with the gennaker-less run: switch day, check the course moved with the wind.
  await b.evaluate("document.getElementById('day').value = '3'; document.getElementById('day').dispatchEvent(new Event('change'))");
  await sleep(500);
  const axis = await G('g.course.axis');
  check('southerly day lays the course to the south', axis > 120 && axis < 240, axis.toFixed(0));
  await b.evaluate('SoundRace.setSpeed(5)');
  await sleep(4000);
  await shot('smoke_south.png');
  check('no exceptions at the end', errs().length === 0, errs().join('\n'));
} catch (e) { check('run', false, e.stack); }
b.kill();
console.log(`${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);

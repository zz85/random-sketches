// Headless smoke test for tides.html: runs the inline script against a stub DOM/canvas.
// Every drawing routine and the station load path must execute without throwing.
const fs = require('fs'), vm = require('vm'), path = require('path');
const dir = path.join(__dirname);
const html = fs.readFileSync(path.join(dir, 'tides.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/g).pop().replace(/<\/?script>/g, '');

const calls = {};
const count = (k) => { calls[k] = (calls[k] || 0) + 1; };
const ctxProxy = () => new Proxy({ w: 0, h: 0 }, { get(t, k) { if (k in t) return t[k]; return (...a) => { count('ctx.' + String(k)); }; }, set(t, k, v) { t[k] = v; return true; } });
function el(id) {
    const e = { id, value: '', checked: false, textContent: '', innerHTML: '', style: {}, children: [], listeners: {},
        addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
        appendChild(c) { this.children.push(c); return c; },
        getContext() { return ctxProxy(); },
        getBoundingClientRect() { return { left: 0, top: 0, width: 900, height: 320 }; },
        parentElement: { clientWidth: 900 }, clientWidth: 900 };
    return e;
}
const els = {};
const ids = ['stationList', 'stationId', 'loadBtn', 'nearBtn', 'datum', 'units', 'date', 'days', 'localTz', 'noaaOverlay', 'err', 'stationInfo', 'nowHeight', 'nowText', 'clock', 'hilo', 'curve', 'curveHint', 'envelope', 'statsText', 'bars', 'decomp', 'phasor', 'phasorText'];
for (const id of ids) els[id] = el(id);
els.datum.value = 'MLLW'; els.units.value = 'ft'; els.days.value = '3'; els.localTz.checked = true; els.noaaOverlay.checked = true;

const window = {
    devicePixelRatio: 1, listeners: {},
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    requestAnimationFrame(fn) { count('raf'); },
    location: { hash: '#8443970' },
    fetch: globalThis.fetch,
    setInterval() { return 0; },
    navigator: { geolocation: { getCurrentPosition(ok) { ok({ coords: { latitude: 47.6, longitude: -122.3 } }); } } }
};
const document = { getElementById: (id) => els[id] || (els[id] = el(id)), createElement: (tag) => el(tag), body: el('body') };
const sandbox = { window, document, location: window.location, navigator: window.navigator, requestAnimationFrame: window.requestAnimationFrame,
    setInterval: window.setInterval, fetch: globalThis.fetch, console, Date, Math, Infinity, NaN, Proxy, Promise, Float64Array, URLSearchParams, Error, isNaN, String, Number, Object, Array };
sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
window.self = sandbox;
// load libs as they would be in the page
for (const f of ['vendor/suncalc.js', 'tides.js', 'tide_stations.js']) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
}
if (sandbox.SunCalc) window.SunCalc = sandbox.SunCalc;
if (!window.Tides) window.Tides = sandbox.Tides;
sandbox.Tides = window.Tides; sandbox.SunCalc = window.SunCalc;

(async () => {
    vm.runInContext(script, sandbox, { filename: 'tides.html(inline)' });
    // wait for async station load + NOAA overlay
    for (let i = 0; i < 100 && !(els.stationInfo.innerHTML && els.stationInfo.innerHTML.includes('constituents')); i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 2500));
    const problems = [];
    if (els.err.textContent) problems.push('err box: ' + els.err.textContent);
    if (!/Boston/i.test(els.stationInfo.innerHTML)) problems.push('station info missing: ' + els.stationInfo.innerHTML.slice(0, 120));
    if (!/High|Low/.test(els.hilo.innerHTML)) problems.push('no hi/lo rows');
    if (!/cbar/.test(els.bars.innerHTML)) problems.push('no constituent bars');
    if (!/\d+\.\d\d ft/.test(els.nowHeight.textContent)) problems.push('nowHeight not set: ' + els.nowHeight.textContent);
    if (!/next (high|low)/.test(els.nowText.innerHTML)) problems.push('nowText missing next: ' + els.nowText.innerHTML);
    if (!(calls['ctx.stroke'] > 50 && calls['ctx.fillText'] > 20)) problems.push('little drawing happened: ' + JSON.stringify(calls));
    if (!/Σ semidiurnal/.test(els.statsText.innerHTML)) problems.push('stats missing');
    if (!/full model above/.test(els.phasorText.innerHTML)) { // phasor drawn via raf; force one frame
        const tickFn = vm.runInContext('typeof drawPhasor === "function" ? (drawPhasor(), true) : false', sandbox);
        if (!tickFn || !/full model above/.test(els.phasorText.innerHTML)) problems.push('phasor text missing');
    }
    // NOAA overlay residual should be tiny (overlay fetched for the initial MLLW window)
    const rmse = vm.runInContext(`(() => { if (!state.noaa) return -1; let se=0; for (const p of state.noaa) { const e = Tides.height(state.model, p.time) - p.height; se += e*e; } return Math.sqrt(se/state.noaa.length); })()`, sandbox);
    if (rmse < 0) problems.push('NOAA overlay not loaded'); else if (rmse > 0.1) problems.push('NOAA overlay rmse too large: ' + rmse);
    // exercise the interaction handlers
    const fire = (e, ev, arg) => (e.listeners[ev] || []).forEach(fn => fn(arg || { target: e, preventDefault() {}, clientX: 400, clientY: 100, deltaY: 100, key: 'Enter' }));
    fire(els.curve, 'mousemove'); fire(els.curve, 'wheel'); fire(els.curve, 'mousedown'); fire(els.curve, 'mousemove', { clientX: 500, clientY: 100 }); (window.listeners.mouseup || []).forEach(f => f()); fire(els.curve, 'mouseleave');
    els.units.value = 'm'; fire(els.units, 'change');
    els.days.value = '14'; fire(els.days, 'change');
    els.datum.value = 'MSL'; fire(els.datum, 'change');
    els.localTz.checked = false; fire(els.localTz, 'change');
    (window.listeners.resize || []).forEach(f => f());
    if (!/ m$/.test(els.nowHeight.textContent)) problems.push('unit switch failed: ' + els.nowHeight.textContent);
    if (!/UTC<\/th>|\(UTC\)/.test(els.hilo.innerHTML)) problems.push('tz switch to UTC not reflected: ' + els.hilo.innerHTML.slice(0, 200));
    console.log('draw calls:', Object.entries(calls).filter(([k]) => /stroke$|fill$|fillText|arc$/.test(k)).map(([k, v]) => k + '=' + v).join(' '));
    console.log('hi/lo rows:', (els.hilo.innerHTML.match(/<tr/g) || []).length - 1, '| overlay rmse (ft, MLLW):', rmse.toFixed(3));
    console.log('now:', els.nowHeight.textContent, '|', els.nowText.innerHTML.replace(/<br>/g, ' / '));
    if (problems.length) { console.log('FAIL'); problems.forEach(p => console.log(' -', p)); process.exit(1); }
    console.log('PASS');
    process.exit(0);
})().catch(e => { console.error('EXCEPTION', e); process.exit(1); });

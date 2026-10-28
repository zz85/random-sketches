// CarPlay Gravity: a car dashboard UI whose pieces are rigid bodies (after mrdoob's Google Gravity).
// Every .phys element is measured where the layout puts it, then positioned by the physics with a
// CSS transform; it stays live (clocks tick, the map drives, buttons work) while it tumbles.
import { World, Body } from './physics.js';
import { Drive, drawMap, fmtDist } from './nav.js';
import { APPS, HOME_APPS, tileInner, GLYPH } from './icons.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const params = new URLSearchParams(location.search);
const TAU = Math.PI * 2, STEP = 1 / 120;
const screenEl = $('#screen');
const world = new World();
const drive = new Drive(+params.get('seed') || 7);

const TRACKS = [
  ['Low Tide Signals', 'The Ferry Lights', 222, 205],
  ['Gravity Well', 'Mira Okafor', 245, 330],
  ['Westlake at Dusk', 'Paper Satellites', 198, 25],
  ['Slow Orbit', 'Hollis & June', 301, 265],
  ['Rain on Route 99', 'Northbound', 235, 160],
];

const state = {
  layout: ['home', 'dash', 'cluster'].includes(params.get('layout')) ? params.get('layout') : 'home',
  loose: false, mode: 'down', strength: 1, angle: Math.PI / 2, tilt: null,
  playing: true, track: 0, pos: 37, bumpT: 0, nextBump: 3, z: 10, mph: 0, rpm: 0.8, g: [0, 1],
};
let pieces = [];
const tweens = new Map();

// ---------- markup ----------

const tile = (n, cls) => `<div class="${cls} phys" data-act="app:${n}" style="background:${APPS[n].bg}">${tileInner(n)}</div>`;
const sidebar = (glyph) => `<div class="sidebar">
  <div class="sb-time phys" data-clock></div>
  <div class="sb-sig phys"><i style="height:30%"></i><i style="height:55%"></i><i style="height:80%"></i><i style="height:100%"></i><span>5G</span></div>
  <div class="sb-apps">${tile('maps', 'mini')}${tile('music', 'mini')}${tile('phone', 'mini')}</div>
  <div class="sb-gap"></div>
  <div class="homebtn phys" data-shape="circle" data-act="home">${glyph}</div>
</div>`;

$('#L-home').innerHTML = sidebar(GLYPH.dash) + `<div class="home-main"><div class="grid">${HOME_APPS.map((n) =>
  `<div class="app">${tile(n, 'tile')}<div class="lbl phys">${APPS[n].label}</div></div>`).join('')}</div><div class="dots phys"><i></i><i></i></div></div>`;

$('#L-dash').innerHTML = sidebar(GLYPH.grid) + `<div class="dash-main">
  <div class="card map phys" data-map><canvas></canvas>
    <div class="banner"><div class="arr" data-arrow></div><div style="min-width:0"><div class="d" data-dist></div><div class="st" data-onto></div></div></div>
    <div class="eta"><div><b data-arr></b><small>arrival</small></div><div><b data-min></b><small>min</small></div><div><b data-mi></b><small>mi</small></div></div>
  </div>
  <div class="card np phys">
    <div class="np-top"><div class="art"></div><div class="np-t"><b></b><span></span></div></div>
    <div class="bar"><i></i></div>
    <div class="times"><span data-el></span><span data-rem></span></div>
    <div class="ctl"><button data-act="prev" aria-label="Previous">${GLYPH.prev}</button><button class="big" data-act="play" aria-label="Play or pause"></button><button data-act="next" aria-label="Next">${GLYPH.next}</button></div>
  </div>
  <div class="pair">
    <div class="card small cal-card phys"><div class="hd">${GLYPH.cal}Up next</div><div class="big">Squash with Sam</div><div class="sub">6:30 – 7:30 PM</div><div class="sub">Seattle Athletic Club</div></div>
    <div class="card small wx phys"><div class="hd">Seattle</div><div class="row" style="gap:calc(var(--u)*1.2)"><div class="temp">54°</div><div style="width:calc(var(--u)*7);height:calc(var(--u)*7)">${GLYPH.rain}</div></div><div class="sub">Light rain · H 57° L 48°</div></div>
  </div>
</div>`;

$('#L-cluster').innerHTML = `<div class="cluster">
  <div class="gauge phys" data-shape="circle" data-gauge="speed"><canvas></canvas></div>
  <div class="cl-mid">
    <div class="row"><div class="sig phys" data-sig="-1">${GLYPH.sigL}</div><div class="gear phys">P R N <b>D</b></div><div class="sig phys" data-sig="1">${GLYPH.sigR}</div></div>
    <div class="cmap phys" data-map><canvas></canvas><div class="mini-turn"><i data-arrow></i><span data-dist></span></div></div>
    <div class="row"><div class="lamp blue phys">${GLYPH.beam}</div><div class="lamp phys">${GLYPH.belt}</div><div class="lamp phys">${GLYPH.tyre}</div><div class="lamp phys">${GLYPH.temp}</div><div class="lamp phys">${GLYPH.fuel}</div></div>
    <div class="row"><div class="stat phys"><b data-range></b> mi</div><div class="stat phys"><b>54°</b>F</div><div class="stat phys"><b data-clock></b></div></div>
    <div class="row"><div class="stat phys">ODO <b data-odo></b></div><div class="stat phys">TRIP <b data-trip></b></div></div>
  </div>
  <div class="gauge phys" data-shape="circle" data-gauge="rpm"><canvas></canvas></div>
</div>`;

// ---------- pieces <-> bodies ----------

function bounds() { world.setBounds(0, 0, screenEl.clientWidth, screenEl.clientHeight); }

// Where the layout puts every piece (centre and size in screen pixels). Briefly returns the pieces
// to the flow to measure them, and puts them back before anything is painted.
function measure(ps) {
  for (const p of ps) { p.el.classList.remove('loose'); p.el.style.transform = p.el.style.width = p.el.style.height = ''; }
  const sr = screenEl.getBoundingClientRect();
  const out = ps.map((p) => { const r = p.el.getBoundingClientRect(); return { x: r.left - sr.left + r.width / 2, y: r.top - sr.top + r.height / 2, w: r.width, h: r.height }; });
  ps.forEach((p, i) => { p.el.classList.add('loose'); p.el.style.width = out[i].w + 'px'; p.el.style.height = out[i].h + 'px'; });
  return out;
}

function render() {
  for (const { el, body: b } of pieces) el.style.transform = `translate(${(b.x - b.hw).toFixed(2)}px,${(b.y - b.hh).toFixed(2)}px) rotate(${b.angle.toFixed(4)}rad)`;
}

function setLayout(name) {
  if (drag) endDrag();
  state.layout = name;
  for (const l of $$('.layout')) l.classList.toggle('on', l.id === 'L-' + name);
  for (const b of $$('#layouts button')) b.classList.toggle('on', b.dataset.layout === name);
  world.clear(); tweens.clear();
  bounds();
  live(performance.now(), 0, true); // fill in the text first: pieces are sized by what they show
  pieces = $$('.phys', $('#L-' + name)).map((el) => ({ el }));
  const homes = measure(pieces);
  pieces.forEach((p, i) => {
    const h = homes[i];
    p.home = h;
    p.body = world.add(new Body({ x: h.x, y: h.y, w: h.w, h: h.h, shape: p.el.dataset.shape || 'box', pinned: true, el: p.el, friction: 0.55 }));
    p.el._piece = p;
  });
  render();
  if (state.loose) setTimeout(() => { if (state.layout === name && state.loose) dropAll(); }, 700);
}

function dropAll() {
  state.loose = true; $('#drop').textContent = 'Restore';
  const zero = state.mode === 'zero';
  for (const { body: b } of pieces) {
    if (!b.pinned) continue;
    tweens.delete(b);
    b.setPinned(false);
    b.w = (Math.random() - 0.5) * (zero ? 1.2 : 0.6);
    b.vx = (Math.random() - 0.5) * (zero ? 160 : 30);
    b.vy = zero ? (Math.random() - 0.5) * 160 : -Math.random() * 40;
  }
}

function restore() {
  state.loose = false; $('#drop').textContent = 'Drop';
  if (drag) endDrag();
  const homes = measure(pieces);
  pieces.forEach((p, i) => {
    const b = p.body, h = homes[i];
    p.home = h; b.resize(h.w, h.h);
    b.angle = ((b.angle % TAU) + TAU * 1.5) % TAU - Math.PI; // the short way round
    b.setPinned(true);
    tweens.set(b, { t: -i * 0.012, fx: b.x, fy: b.y, fa: b.angle, p });
  });
  render();
}

function stepTweens(dt) {
  const D = 0.8;
  for (const [b, tw] of tweens) {
    tw.t += dt;
    const t = Math.max(0, Math.min(1, tw.t / D)), c = 1.3, e = 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; // ease-out-back
    const h = tw.p.home;
    b.x = tw.fx + (h.x - tw.fx) * e; b.y = tw.fy + (h.y - tw.fy) * e; b.angle = tw.fa * (1 - e);
    if (t >= 1) { b.x = h.x; b.y = h.y; b.angle = 0; tweens.delete(b); }
  }
}

let resizeTimer = 0;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(relayout, 120); }).observe(screenEl);
function relayout() {
  if (!pieces.length) return;
  if (drag) endDrag();
  bounds();
  const homes = measure(pieces), W = world.walls;
  pieces.forEach((p, i) => {
    const b = p.body, h = homes[i];
    p.home = h; b.resize(h.w, h.h);
    if (b.pinned && !tweens.has(b)) { b.x = h.x; b.y = h.y; b.angle = 0; }
    b.x = Math.max(W.l + 4, Math.min(W.r - 4, b.x)); b.y = Math.max(W.t + 4, Math.min(W.b - 4, b.y));
  });
  render();
}

// ---------- gravity ----------

function setMode(m, user = true) {
  state.mode = m;
  for (const b of $$('#modes button')) b.classList.toggle('on', b.dataset.mode === m);
  world.restitution = m === 'zero' ? 0.75 : null;
  world.linearDamping = m === 'zero' ? 0.02 : 0.05;
  if (m === 'tilt') startTilt();
  if (m === 'zero') for (const { body: b } of pieces) if (!b.pinned) { b.vx += (Math.random() - 0.5) * 220; b.vy += (Math.random() - 0.5) * 220 - 60; b.w += (Math.random() - 0.5); }
  if (user && !state.loose) dropAll();
}

function gravity(dt) {
  const g = state.strength * 3 * screenEl.clientHeight; // px/s² — 1 g falls the screen in ~0.8 s
  let ux = 0, uy = 0;
  if (state.mode === 'down' || (state.mode === 'tilt' && !state.tilt)) { ux = Math.cos(state.angle); uy = Math.sin(state.angle); }
  else if (state.mode === 'tilt') { ux = state.tilt.x; uy = state.tilt.y; }
  else if (state.mode === 'drive') {
    // centrifugal push from the turns (exaggerated) plus road rumble and the odd pothole
    ux = -drive.aLat / 9.81 * 2.4;
    uy = 1 + (Math.random() - 0.5) * 0.18 * Math.min(1, drive.v / 6);
    state.nextBump -= dt;
    if (state.nextBump < 0) { state.bumpT = 0.08; state.nextBump = 2.5 + Math.random() * 5; }
    if (state.bumpT > 0) { state.bumpT -= dt; uy -= 2.6; }
  }
  world.gx = ux * g; world.gy = uy * g;
  state.g = [ux, uy];
}

let tiltAsked = false;
async function startTilt() {
  if (!tiltAsked) {
    tiltAsked = true;
    try { if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') await DeviceMotionEvent.requestPermission(); } catch (e) { /* refused */ }
    window.addEventListener('devicemotion', onMotion);
  }
  setTimeout(() => { if (state.mode === 'tilt' && !state.tilt) toast('No tilt sensor here: gravity stays as the dial points. Try it on a phone or tablet.'); }, 1200);
}
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  // gravity in device axes (x right, y down the portrait screen), then into the screen's orientation
  const dx = -a.x / 9.81, dy = a.y / 9.81;
  const ang = -((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * Math.PI / 180;
  const c = Math.cos(ang), s = Math.sin(ang), x = dx * c - dy * s, y = dx * s + dy * c;
  const t = state.tilt || { x, y };
  state.tilt = { x: t.x + (x - t.x) * 0.35, y: t.y + (y - t.y) * 0.35 };
}

// ---------- pointer: grab, throw, tap ----------

let drag = null;
const local = (e) => { const r = screenEl.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
screenEl.addEventListener('pointerdown', (e) => {
  if (drag) return;
  const el = e.target.closest('.phys');
  if (!el || !el._piece) return;
  e.preventDefault();
  screenEl.setPointerCapture(e.pointerId);
  const pt = local(e);
  drag = { id: e.pointerId, p: el._piece, x0: pt.x, y0: pt.y, t0: performance.now(), act: e.target.closest('[data-act]'), moved: false, joint: null };
  if (!el._piece.body.pinned) grab(pt);
});
screenEl.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const pt = local(e);
  if (!drag.moved && Math.hypot(pt.x - drag.x0, pt.y - drag.y0) > 8) {
    drag.moved = true;
    if (!drag.joint) { const b = drag.p.body; tweens.delete(b); b.setPinned(false); grab({ x: drag.x0, y: drag.y0 }); }
  }
  if (drag.joint) { drag.joint.tx = pt.x; drag.joint.ty = pt.y; }
});
const up = (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const tapped = !drag.moved && performance.now() - drag.t0 < 450 ? drag : null;
  endDrag();
  if (tapped) tap(tapped);
};
screenEl.addEventListener('pointerup', up);
screenEl.addEventListener('pointercancel', up);

function grab(pt) {
  const b = drag.p.body;
  drag.joint = world.grab(b, pt.x, pt.y, { hz: 5, damping: 0.7, maxForce: b.mass * 90000 });
  drag.p.el.classList.add('grabbed');
  drag.p.el.style.zIndex = ++state.z;
}
function endDrag() { if (!drag) return; world.release(); drag.p.el.classList.remove('grabbed'); drag = null; }

function tap({ act, p }) {
  const a = act?.dataset.act || '';
  if (a === 'play') { state.playing = !state.playing; return live(performance.now(), 0, true); }
  if (a === 'next' || a === 'prev') { changeTrack(a === 'next' ? 1 : -1); return; }
  if (a === 'home') return setLayout(state.layout === 'home' ? 'dash' : 'home');
  if (a.startsWith('app:')) {
    const n = a.slice(4);
    if (['maps', 'music', 'podcasts', 'audiobooks'].includes(n) && state.layout !== 'dash') return setLayout('dash');
  }
  hop(p);
}
function hop(p) {
  const b = p.body, el = p.el;
  el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
  if (b.pinned) return;
  const g = Math.hypot(world.gx, world.gy);
  if (g < 50) { const a = Math.random() * TAU; b.vx += Math.cos(a) * 500; b.vy += Math.sin(a) * 500; }
  else { const v = Math.sqrt(2 * g * screenEl.clientHeight * 0.3); b.vx -= world.gx / g * v; b.vy -= world.gy / g * v; }
  b.w += (Math.random() - 0.5) * 8;
}
function changeTrack(d) { state.track = (state.track + d + TRACKS.length) % TRACKS.length; state.pos = 0; live(performance.now(), 0, true); }

function shake() {
  if (!state.loose) dropAll();
  for (const { body: b } of pieces) {
    if (b.pinned) continue;
    const a = Math.random() * TAU, v = 500 + Math.random() * 900;
    b.vx += Math.cos(a) * v; b.vy += Math.sin(a) * v - 400; b.w += (Math.random() - 0.5) * 14;
  }
}

// ---------- live content ----------

const fmtClock = (d) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const DPR = () => Math.min(2, window.devicePixelRatio || 1);
function fit(cv) {
  const w = Math.max(1, Math.round(cv.clientWidth * DPR())), h = Math.max(1, Math.round(cv.clientHeight * DPR()));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return cv.getContext('2d');
}
const setText = (sel, t, root) => { for (const e of $$(sel, root)) if (e.textContent !== t) e.textContent = t; };

let lastSlow = 0, frameNo = 0, shownTrack = -1, shownPlaying = null;
function live(now, dt, force = false) {
  const L = $('#L-' + state.layout);
  frameNo++;
  // music
  const [title, artist, dur, hue] = TRACKS[state.track];
  if (state.playing) { state.pos += dt; if (state.pos >= dur) changeTrack(1); }
  if (force || shownTrack !== state.track) {
    shownTrack = state.track;
    setText('.np-t b', title); setText('.np-t span', artist);
    for (const a of $$('.art')) a.style.background = `radial-gradient(circle at 70% 25%, hsl(${hue + 40} 90% 75% / .8), transparent 45%), conic-gradient(from 210deg at 35% 70%, hsl(${hue} 80% 55%), hsl(${hue + 70} 70% 35%), hsl(${hue + 150} 85% 55%), hsl(${hue} 80% 55%))`;
  }
  if (force || shownPlaying !== state.playing) {
    shownPlaying = state.playing;
    for (const b of $$('[data-act="play"]')) b.innerHTML = state.playing ? GLYPH.pause : GLYPH.play;
    for (const m of $$('.mini[data-act="app:music"]')) m.classList.toggle('playing', state.playing);
  }
  for (const i of $$('.bar i', L)) i.style.width = (100 * state.pos / dur).toFixed(2) + '%';
  // maps at 30 fps
  if (force || frameNo % 2 === 0) for (const c of $$('[data-map] canvas', L)) { const ctx = fit(c); drawMap(ctx, c.width, c.height, drive, { scale: Math.max(c.width, c.height) / (c.closest('.cmap') ? 300 : 420) }); }
  // gauges
  state.mph += (drive.v * 2.237 - state.mph) * Math.min(1, dt * 4);
  const GEARS = [0, 13, 22, 33, 46, 60, 999];
  let gi = 0; while (state.mph > GEARS[gi + 1]) gi++;
  const f = (state.mph - GEARS[gi]) / (GEARS[gi + 1] - GEARS[gi]);
  const rpmT = Math.max(0.8, (gi === 0 ? 0.9 : 1.6) + f * 2.4 + Math.max(0, drive.aLon) * 0.25);
  state.rpm += (rpmT - state.rpm) * Math.min(1, dt * 6);
  for (const c of $$('[data-gauge] canvas', L)) drawGauge(c, c.parentNode.dataset.gauge);
  // turn signals blink before a turn
  const turn = drive.nextTurn();
  const blink = turn && turn.dist < 70 && now % 760 < 400;
  for (const s of $$('[data-sig]', L)) s.classList.toggle('on', !!blink && +s.dataset.sig === turn.dir);
  // slower text
  if (force || now - lastSlow > 250) {
    lastSlow = now;
    const d = new Date();
    setText('[data-clock]', fmtClock(d), L);
    setText('[data-el]', mmss(state.pos), L); setText('[data-rem]', '-' + mmss(dur - state.pos), L);
    const far = !turn || turn.dist > 1200;
    const g = far ? GLYPH.straight : turn.dir > 0 ? GLYPH.right : GLYPH.left;
    for (const a of $$('[data-arrow]', L)) if (a._g !== g) { a._g = g; a.innerHTML = g; }
    setText('[data-dist]', turn ? fmtDist(turn.dist) : '', L);
    setText('[data-onto]', far ? 'Continue straight' : turn.onto, L);
    const left = 7.8 - (drive.trip % 7.6), mins = Math.max(1, Math.round(left / 22 * 60));
    setText('[data-mi]', left.toFixed(1), L); setText('[data-min]', String(mins), L);
    setText('[data-arr]', fmtClock(new Date(d.getTime() + mins * 60000)), L);
    setText('[data-odo]', Math.floor(drive.odo).toLocaleString('en-US'), L);
    setText('[data-trip]', drive.trip.toFixed(1), L);
    setText('[data-range]', String(Math.round(286 - drive.trip)), L);
  }
}

function drawGauge(cv, kind) {
  const ctx = fit(cv), W = cv.width, R = W / 2;
  const speed = kind === 'speed', max = speed ? 80 : 8, major = speed ? 10 : 1, minor = speed ? 2.5 : 0.25;
  const val = speed ? state.mph : state.rpm, a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
  const ang = (v) => a0 + sweep * Math.max(0, Math.min(1, v / max));
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, W); ctx.translate(R, R);
  const face = ctx.createRadialGradient(0, -R * 0.3, R * 0.1, 0, 0, R);
  face.addColorStop(0, '#1c2230'); face.addColorStop(1, '#06080b');
  ctx.fillStyle = face; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#2b3240'; ctx.lineWidth = R * 0.025; ctx.beginPath(); ctx.arc(0, 0, R * 0.985, 0, TAU); ctx.stroke();
  // lit arc up to the value
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#ffffff12'; ctx.lineWidth = R * 0.035; ctx.beginPath(); ctx.arc(0, 0, R * 0.92, a0, a0 + sweep); ctx.stroke();
  if (!speed) { ctx.strokeStyle = '#ff3b30aa'; ctx.beginPath(); ctx.arc(0, 0, R * 0.92, ang(6.2), ang(8)); ctx.stroke(); }
  ctx.shadowColor = '#4aa3ff'; ctx.shadowBlur = R * 0.06;
  ctx.strokeStyle = '#4aa3ff'; ctx.beginPath(); ctx.arc(0, 0, R * 0.92, a0, Math.max(a0 + 0.001, ang(val))); ctx.stroke();
  ctx.shadowBlur = 0;
  // ticks and numbers
  ctx.lineCap = 'butt';
  for (let v = 0; v <= max + 1e-6; v += minor) {
    const a = ang(v), big = Math.abs(v / major - Math.round(v / major)) < 1e-6, r0 = big ? 0.74 : 0.8;
    ctx.strokeStyle = !speed && v >= 6.2 ? '#ff453a' : big ? '#e8ecf2' : '#6c7686';
    ctx.lineWidth = R * (big ? 0.022 : 0.01);
    ctx.beginPath(); ctx.moveTo(Math.cos(a) * R * r0, Math.sin(a) * R * r0); ctx.lineTo(Math.cos(a) * R * 0.86, Math.sin(a) * R * 0.86); ctx.stroke();
    if (big) {
      ctx.fillStyle = !speed && v >= 7 ? '#ff6a60' : '#cfd5de'; ctx.font = `600 ${R * 0.1}px -apple-system, system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(v), Math.cos(a) * R * 0.62, Math.sin(a) * R * 0.62);
    }
  }
  // readout
  ctx.fillStyle = '#fff'; ctx.font = `650 ${R * 0.26}px -apple-system, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(speed ? String(Math.round(val)) : val.toFixed(1), 0, R * 0.5);
  ctx.fillStyle = '#8a93a3'; ctx.font = `500 ${R * 0.085}px -apple-system, system-ui, sans-serif`;
  ctx.fillText(speed ? 'mph' : '×1000 rpm', 0, R * 0.64);
  // needle
  const a = ang(val);
  ctx.save(); ctx.rotate(a);
  ctx.shadowColor = '#ff6a2b'; ctx.shadowBlur = R * 0.05;
  ctx.fillStyle = '#ff6a2b';
  ctx.beginPath(); ctx.moveTo(-R * 0.14, -R * 0.02); ctx.lineTo(R * 0.84, -R * 0.006); ctx.lineTo(R * 0.84, R * 0.006); ctx.lineTo(-R * 0.14, R * 0.02); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#20252f'; ctx.beginPath(); ctx.arc(0, 0, R * 0.075, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#3a4252'; ctx.lineWidth = R * 0.012; ctx.stroke();
}

// ---------- hardware controls ----------

const dial = $('#dial');
function drawDial() {
  const ctx = fit(dial), W = dial.width, R = W / 2;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, W); ctx.translate(R, R);
  ctx.fillStyle = '#16181c'; ctx.beginPath(); ctx.arc(0, 0, R - 1, 0, TAU); ctx.fill();
  ctx.strokeStyle = '#33373e'; ctx.lineWidth = Math.max(1, R * 0.08); ctx.stroke();
  const [gx, gy] = state.g, m = Math.hypot(gx, gy), L = Math.min(1, m / 1.5) * R * 0.72;
  if (L < R * 0.08) { ctx.fillStyle = '#8fb3ff'; ctx.beginPath(); ctx.arc(0, 0, R * 0.12, 0, TAU); ctx.fill(); return; }
  ctx.rotate(Math.atan2(gy, gx));
  ctx.strokeStyle = ctx.fillStyle = state.mode === 'down' ? '#8fb3ff' : '#ffb35c';
  ctx.lineWidth = R * 0.14; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-L * 0.35, 0); ctx.lineTo(L - R * 0.18, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(L + R * 0.05, 0); ctx.lineTo(L - R * 0.3, -R * 0.26); ctx.lineTo(L - R * 0.3, R * 0.26); ctx.closePath(); ctx.fill();
}
let dialDrag = false;
const dialAim = (e) => { const r = dial.getBoundingClientRect(); state.angle = Math.atan2(e.clientY - r.top - r.height / 2, e.clientX - r.left - r.width / 2); if (state.mode !== 'down') setMode('down'); else if (!state.loose) dropAll(); };
dial.addEventListener('pointerdown', (e) => { dialDrag = true; dial.setPointerCapture(e.pointerId); dialAim(e); });
dial.addEventListener('pointermove', (e) => { if (dialDrag) dialAim(e); });
dial.addEventListener('pointerup', () => { dialDrag = false; });
dial.addEventListener('dblclick', () => { state.angle = Math.PI / 2; setMode('down'); });

for (const b of $$('#layouts button')) b.addEventListener('click', () => setLayout(b.dataset.layout));
for (const b of $$('#modes button')) b.addEventListener('click', () => setMode(b.dataset.mode));
const strength = $('#strength');
strength.addEventListener('input', () => { state.strength = +strength.value; $('#gval').textContent = state.strength.toFixed(1) + ' g'; });
$('#shake').addEventListener('click', shake);
$('#drop').addEventListener('click', () => (state.loose ? restore() : dropAll()));
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.key.length > 1 && e.key.startsWith('Arrow')) return;
  const k = e.key.toLowerCase();
  const dirs = { arrowdown: Math.PI / 2, arrowup: -Math.PI / 2, arrowleft: Math.PI, arrowright: 0 };
  if (k in dirs) { e.preventDefault(); state.angle = dirs[k]; setMode('down'); }
  else if (k === 'g') state.loose ? restore() : dropAll();
  else if (k === 's') shake();
  else if (k === 'z') setMode('zero');
  else if (k === 'd') setMode('drive');
  else if (k === 't') setMode('tilt');
  else if (k === '1' || k === '2' || k === '3') setLayout(['home', 'dash', 'cluster'][+k - 1]);
});

let toastTimer = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3200); }

// ---------- loop ----------

let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  drive.update(dt);
  gravity(dt);
  acc += dt;
  let n = 0;
  while (acc >= STEP && n < 4) { world.step(STEP); acc -= STEP; n++; }
  if (n === 4) acc = 0;
  stepTweens(dt);
  const W = world.walls;
  for (const { body: b } of pieces) { // anything that escaped comes back in the middle
    if (!Number.isFinite(b.x + b.y + b.angle) || b.x < W.l - 200 || b.x > W.r + 200 || b.y < W.t - 200 || b.y > W.b + 200) {
      b.x = (W.l + W.r) / 2; b.y = (W.t + W.b) / 3; b.vx = b.vy = b.w = 0; b.angle = 0;
    }
  }
  render();
  live(now, dt);
  drawDial();
  requestAnimationFrame(frame);
}

const startMode = ['down', 'tilt', 'drive', 'zero'].includes(params.get('mode')) ? params.get('mode') : 'down';
setLayout(state.layout);
setMode(startMode, false);
requestAnimationFrame(frame);
if (!params.has('still')) setTimeout(() => { if (!state.loose) dropAll(); }, 1600);

window.__cp = { world, state, drive, get pieces() { return pieces; }, setLayout, setMode, dropAll, restore, shake };

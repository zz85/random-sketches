// CarPlay Gravity: a car dashboard UI whose pieces are rigid bodies (after mrdoob's Google Gravity),
// drawn on one canvas. The screen is laid out in logical pixels for an 800 × 480 head unit (wider
// screens get more width, the height stays 480) and scaled to the device. Each piece draws itself
// in its own coordinates; static ones are cached as bitmaps and redrawn only when what they show
// changes, live ones (map, gauges) are drawn every frame. They keep working while they tumble.
import { World, Body } from './physics.js';
import { Drive, drawMap, fmtDist } from './nav.js';
import { APPS, HOME_APPS, GLYPH } from './icons.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const params = new URLSearchParams(location.search);
const TAU = Math.PI * 2, STEP = 1 / 120;
const FAM = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", system-ui, sans-serif';
const font = (w, px) => `${w} ${px}px ${FAM}`;
const screenEl = $('#screen'), cv = $('#cv'), ctx = cv.getContext('2d');
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
  playing: true, track: 0, pos: 37, bumpT: 0, nextBump: 3, mph: 0, rpm: 0.8, g: [0, 1],
};
// what the pieces show, updated once a frame
const live = { clock: '', el: '', rem: '', dist: '', onto: '', arrow: GLYPH.straight, mi: '', min: '', arr: '', odo: '', trip: '', range: '', sig: 0 };
let pieces = [];
const tweens = new Map();
let S = 1, LW = 800, LH = 480, DPR = 1, K = 1; // logical → CSS px, logical size, device px per logical px

// ---------- drawing helpers ----------

let artVer = 0;
const images = new Map();
function icon(svg, color = '#fff') {
  const key = color + svg;
  let im = images.get(key);
  if (!im) {
    im = new Image();
    im.onload = () => artVer++;
    im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" ').replaceAll('currentColor', color));
    images.set(key, im);
  }
  return im;
}
function drawIcon(c, svg, x, y, w, h = w, color) { const im = icon(svg, color); if (im.complete && im.naturalWidth) c.drawImage(im, x, y, w, h); }

function rrect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
// CSS "linear-gradient(150deg,#a,#b 45%,…)" or a plain colour, as a canvas fill for a w × h box
function cssFill(c, css, w, h) {
  const m = /linear-gradient\((\d+)deg,(.*)\)/.exec(css);
  if (!m) return css;
  const a = +m[1] * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a), L = Math.abs(w * dx) + Math.abs(h * dy);
  const g = c.createLinearGradient(w / 2 - dx * L / 2, h / 2 - dy * L / 2, w / 2 + dx * L / 2, h / 2 + dy * L / 2);
  const stops = m[2].split(/,(?![^(]*\))/).map((s) => s.trim().split(/\s+/));
  stops.forEach(([col, at], i) => g.addColorStop(at ? parseFloat(at) / 100 : i / (stops.length - 1), col));
  return g;
}
function ellipsize(c, s, max) {
  if (c.measureText(s).width <= max) return s;
  while (s.length > 1 && c.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}
function text(c, s, x, y, f, color, align = 'left', max = 0, base = 'alphabetic') {
  c.font = f; c.fillStyle = color; c.textAlign = align; c.textBaseline = base;
  c.fillText(max ? ellipsize(c, s, max) : s, x, y);
}
function wrap(c, s, max, f) {
  c.font = f; const out = []; let line = '';
  for (const w of s.split(' ')) { const t = line ? line + ' ' + w : w; if (c.measureText(t).width > max && line) { out.push(line); line = w; } else line = t; }
  if (line) out.push(line);
  return out;
}
const measure = (s, f) => { ctx.font = f; return ctx.measureText(s).width; };
const card = (c, w, h, r = 18, fill = '#1c1f25') => { rrect(c, 0, 0, w, h, r); c.fillStyle = fill; c.fill(); };

// ---------- pieces ----------
// A spec: { id, x, y (centre), w, h, shape?, draw(c, p), key?() (cache while unchanged), dyn? (draw every frame),
//           act? (tap), hits?: [{ x, y, w, h, act }] in piece coordinates }

const SB = 84; // sidebar width
function sidebar(homeGlyph) {
  const out = [
    { id: 'sb-time', x: SB / 2, y: 30, w: 72, h: 26, key: () => live.clock, draw: (c, p) => text(c, live.clock, p.w / 2, p.h / 2, font(600, 21), '#fff', 'center', 0, 'middle') },
    { id: 'sb-sig', x: SB / 2, y: 56, w: 46, h: 14, draw: (c) => {
      c.fillStyle = '#fff'; [0.3, 0.55, 0.8, 1].forEach((f, i) => { rrect(c, i * 5.5, 14 * (1 - f), 3.6, 14 * f, 1); c.fill(); });
      text(c, '5G', 26, 13, font(650, 12), '#fff');
    } },
  ];
  ['maps', 'music', 'phone'].forEach((n, i) => out.push({ id: 'mini-' + n, x: SB / 2, y: 104 + i * 64, w: 52, h: 52, act: 'app:' + n,
    key: () => (n === 'music' ? String(state.playing) : '') + new Date().getDate(),
    draw: (c, p) => { appTile(c, n, p.w); if (n === 'music' && state.playing) { c.fillStyle = '#14161a'; c.beginPath(); c.arc(p.w - 3, p.h - 3, 9, 0, TAU); c.fill(); c.fillStyle = '#fff'; c.beginPath(); c.arc(p.w - 3, p.h - 3, 6, 0, TAU); c.fill(); } } }));
  out.push({ id: 'sb-home', shape: 'circle', x: SB / 2, y: LH - 40, w: 50, h: 50, act: 'home', draw: (c, p) => {
    c.fillStyle = '#ffffff24'; c.beginPath(); c.arc(p.w / 2, p.h / 2, p.w / 2, 0, TAU); c.fill(); drawIcon(c, homeGlyph, 13, 13, 24);
  } });
  return out;
}

function appTile(c, n, T) {
  rrect(c, 0, 0, T, T, T * 0.23); c.fillStyle = cssFill(c, APPS[n].bg, T, T); c.fill();
  c.save(); c.clip(); c.strokeStyle = '#ffffff40'; c.lineWidth = 1.5; rrect(c, 0.5, 0.5, T - 1, T + 4, T * 0.23); c.stroke(); c.restore();
  if (n === 'calendar') {
    const d = new Date();
    text(c, d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(), T / 2, T * 0.3, font(600, T * 0.15), '#f2304f', 'center');
    text(c, String(d.getDate()), T / 2, T * 0.8, font(300, T * 0.47), '#111', 'center');
  } else drawIcon(c, APPS[n].glyph, T * 0.21, T * 0.21, T * 0.58);
}

function homeSpecs() {
  const MW = LW - SB, T = Math.round(Math.min(104, (MW - 60) / 5 - 26, (LH - 120) / 2 - 30));
  const gx = Math.min(36, (MW - 5 * T) / 6), LBL = 18, rowH = T + 6 + LBL, gapY = 18;
  const top = (LH - (2 * rowH + gapY + 28)) / 2, out = sidebar(GLYPH.dash);
  HOME_APPS.forEach((n, i) => {
    const col = i % 5, row = Math.floor(i / 5), cx = SB + MW / 2 + (col - 2) * (T + gx), y0 = top + row * (rowH + gapY);
    out.push({ id: 'tile-' + n, x: cx, y: y0 + T / 2, w: T, h: T, act: 'app:' + n, key: () => (n === 'calendar' ? new Date().toDateString() : ''), draw: (c, p) => appTile(c, n, p.w) });
    const f = font(500, 14), lw = Math.ceil(measure(APPS[n].label, f)) + 6;
    out.push({ id: 'lbl-' + n, x: cx, y: y0 + T + 6 + LBL / 2, w: lw, h: LBL, draw: (c, p) => {
      c.shadowColor = '#0008'; c.shadowBlur = 2 * K; c.shadowOffsetY = K; text(c, APPS[n].label, p.w / 2, p.h / 2 + 1, f, '#fff', 'center', 0, 'middle');
    } });
  });
  out.push({ id: 'dots', x: SB + MW / 2, y: top + 2 * rowH + gapY + 18, w: 30, h: 12, draw: (c) => {
    for (const [x, a] of [[6, '#fff'], [24, '#ffffff55']]) { c.fillStyle = a; c.beginPath(); c.arc(x, 6, 3.5, 0, TAU); c.fill(); }
  } });
  return out;
}

function dashSpecs() {
  const g = 10, x0 = SB + g, y0 = g, AW = LW - g - x0, AH = LH - 2 * g;
  const mapW = Math.round((AW - g) * 0.585), RW = AW - mapW - g, npH = Math.round((AH - g) * 0.53), sH = AH - g - npH, sW = (RW - g) / 2;
  const rx = x0 + mapW + g;
  const out = sidebar(GLYPH.grid);
  out.push({ id: 'map', x: x0 + mapW / 2, y: y0 + AH / 2, w: mapW, h: AH, dyn: true, map: 420, draw: (c, p) => {
    c.save(); rrect(c, 0, 0, p.w, p.h, 18); c.clip();
    if (p.mapCv) c.drawImage(p.mapCv, 0, 0, p.w, p.h);
    rrect(c, 8, 8, p.w - 16, 60, 13); c.fillStyle = '#16613fee'; c.fill();
    drawIcon(c, live.arrow, 18, 16, 42);
    text(c, live.dist, 72, 36, font(700, 26), '#fff');
    text(c, live.onto, 72, 58, font(600, 15), '#ffffffeb', 'left', p.w - 92);
    rrect(c, 8, p.h - 58, p.w - 16, 50, 13); c.fillStyle = '#14161aee'; c.fill();
    [[live.arr, 'arrival'], [live.min, 'min'], [live.mi, 'mi']].forEach(([v, l], i) => {
      const cx = 8 + (p.w - 16) * (i + 0.5) / 3;
      text(c, v, cx, p.h - 32, font(650, 19), '#fff', 'center'); text(c, l, cx, p.h - 16, font(500, 11), '#ffffff99', 'center');
    });
    c.restore();
  } });
  const bw = 44, cy = (150 + npH) / 2;
  out.push({ id: 'np', x: rx + RW / 2, y: y0 + npH / 2, w: RW, h: npH,
    hits: [['prev', 0.2, bw], ['play', 0.5, 54], ['next', 0.8, bw]].map(([act, f, s]) => ({ act, x: RW * f - s / 2, y: cy - s / 2, w: s, h: s })),
    key: () => `${state.track}|${state.playing}|${Math.floor(state.pos * 4)}`,
    draw: (c, p) => {
      card(c, p.w, p.h);
      const [title, artist, dur, hue] = TRACKS[state.track];
      c.save(); rrect(c, 14, 14, 84, 84, 9); c.clip();
      if (c.createConicGradient) { const cg = c.createConicGradient(3.6, 14 + 30, 14 + 58); cg.addColorStop(0, `hsl(${hue} 80% 55%)`); cg.addColorStop(0.35, `hsl(${hue + 70} 70% 35%)`); cg.addColorStop(0.7, `hsl(${hue + 150} 85% 55%)`); cg.addColorStop(1, `hsl(${hue} 80% 55%)`); c.fillStyle = cg; }
      else c.fillStyle = `hsl(${hue} 70% 45%)`;
      c.fillRect(14, 14, 84, 84);
      const rg = c.createRadialGradient(14 + 60, 14 + 20, 0, 14 + 60, 14 + 20, 40); rg.addColorStop(0, `hsl(${hue + 40} 90% 75% / .8)`); rg.addColorStop(1, 'transparent'); c.fillStyle = rg; c.fillRect(14, 14, 84, 84);
      c.restore();
      text(c, title, 112, 46, font(650, 18), '#fff', 'left', p.w - 124);
      text(c, artist, 112, 68, font(500, 15), '#ffffff99', 'left', p.w - 124);
      rrect(c, 14, 114, p.w - 28, 5, 3); c.fillStyle = '#ffffff2a'; c.fill();
      rrect(c, 14, 114, Math.max(5, (p.w - 28) * state.pos / dur), 5, 3); c.fillStyle = '#fff'; c.fill();
      text(c, live.el, 14, 134, font(500, 11), '#ffffff8c'); text(c, live.rem, p.w - 14, 134, font(500, 11), '#ffffff8c', 'right');
      for (const h of p.hits) drawIcon(c, h.act === 'play' ? (state.playing ? GLYPH.pause : GLYPH.play) : GLYPH[h.act], h.x + h.w * 0.2, h.y + h.h * 0.2, h.w * 0.6);
    } });
  out.push({ id: 'cal', x: rx + sW / 2, y: y0 + npH + g + sH / 2, w: sW, h: sH, draw: (c, p) => {
    card(c, p.w, p.h); c.save(); rrect(c, 0, 0, p.w, p.h, 18); c.clip(); c.fillStyle = '#f2304f'; c.fillRect(0, 0, 5, p.h); c.restore();
    c.globalAlpha = 0.65; drawIcon(c, GLYPH.cal, 15, 13, 15); text(c, 'UP NEXT', 35, 25, font(650, 11), '#fff'); c.globalAlpha = 1;
    let y = 52; for (const l of wrap(c, 'Squash with Sam', p.w - 30, font(650, 17)).slice(0, 2)) { text(c, l, 15, y, font(650, 17), '#fff'); y += 21; }
    y += 2; for (const l of ['6:30 – 7:30 PM', 'Seattle Athletic', 'Club']) { text(c, l, 15, y, font(500, 13), '#ffffff99', 'left', p.w - 26); y += 17; }
  } });
  out.push({ id: 'wx', x: rx + sW + g + sW / 2, y: y0 + npH + g + sH / 2, w: sW, h: sH, draw: (c, p) => {
    card(c, p.w, p.h, 18, cssFill(c, 'linear-gradient(170deg,#2b4f7d,#1d2f4d)', p.w, p.h));
    text(c, 'SEATTLE', 14, 25, font(650, 11), '#ffffffa6');
    text(c, '54°', 12, 80, font(250, 48), '#fff');
    drawIcon(c, GLYPH.rain, p.w - 54, 42, 40);
    text(c, 'Light rain', 14, 108, font(500, 13), '#ffffff99'); text(c, 'H 57°  L 48°', 14, 126, font(500, 13), '#ffffff99');
  } });
  return out;
}

function clusterSpecs() {
  const D = Math.round(Math.min(LH * 0.8, (LW - 250) / 2 - 16)), cy = LH / 2 + 6, cx = LW / 2, mx = 18 + D / 2;
  const out = [];
  for (const [id, x] of [['speed', mx], ['rpm', LW - mx]]) out.push({ id: 'gauge-' + id, shape: 'circle', x, y: cy, w: D, h: D, dyn: true, draw: (c, p) => drawGauge(c, p, id) });
  const top = cy - 160;
  for (const d of [-1, 1]) out.push({ id: 'sig' + d, x: cx + d * 82, y: top, w: 30, h: 30, key: () => String(live.sig === d), draw: (c, p) => {
    if (live.sig === d) { c.shadowColor = '#34e05b'; c.shadowBlur = 10 * K; }
    drawIcon(c, d < 0 ? GLYPH.sigL : GLYPH.sigR, 0, 0, p.w, p.h, live.sig === d ? '#34e05b' : '#1d3323');
  } });
  out.push({ id: 'gear', x: cx, y: top, w: 112, h: 30, draw: (c, p) => {
    rrect(c, 0, 0, p.w, p.h, 9); c.fillStyle = '#ffffff12'; c.fill();
    'PRND'.split('').forEach((ch, i) => text(c, ch, 20 + i * 24, 21, font(650, 17), ch === 'D' ? '#fff' : '#8a93a3', 'center'));
  } });
  out.push({ id: 'cmap', x: cx, y: top + 112, w: 204, h: 168, dyn: true, map: 300, draw: (c, p) => {
    c.save(); rrect(c, 0, 0, p.w, p.h, 16); c.clip();
    if (p.mapCv) c.drawImage(p.mapCv, 0, 0, p.w, p.h);
    c.font = font(650, 13); const tw = c.measureText(live.dist).width;
    rrect(c, 7, 7, tw + 38, 26, 8); c.fillStyle = '#16613fee'; c.fill();
    drawIcon(c, live.arrow, 12, 10, 20); text(c, live.dist, 37, 25, c.font, '#fff');
    c.restore();
  } });
  const lamps = [[GLYPH.beam, '#3d8bff'], [GLYPH.belt, '#3a414e'], [GLYPH.tyre, '#3a414e'], [GLYPH.temp, '#3a414e'], [GLYPH.fuel, '#f5a623']];
  lamps.forEach(([gl, col], i) => out.push({ id: 'lamp' + i, x: cx + (i - 2) * 40, y: top + 222, w: 26, h: 26, draw: (c, p) => drawIcon(c, gl, 0, 0, p.w, p.h, col) }));
  const stat = (id, x, y, w, get, unit) => out.push({ id, x, y, w, h: 22, key: () => get(), draw: (c, p) => {
    const v = get(), fb = font(650, 16), fs = font(500, 12);
    const W = measure(v, fb) + (unit ? measure(unit, fs) + 4 : 0); let x0 = (p.w - W) / 2;
    if (unit && unit.endsWith(' ')) { text(c, unit, x0, 16, fs, '#9aa3b2'); x0 += measure(unit, fs) + 4; text(c, v, x0, 16, fb, '#fff'); }
    else { text(c, v, x0, 16, fb, '#fff'); if (unit) text(c, unit, x0 + measure(v, fb) + 3, 16, fs, '#9aa3b2'); }
  } });
  stat('range', cx - 70, top + 260, 66, () => live.range, 'mi');
  stat('otemp', cx, top + 260, 52, () => '54°', 'F');
  stat('cclock', cx + 66, top + 260, 58, () => live.clock);
  stat('odo', cx - 50, top + 288, 104, () => live.odo, 'ODO ');
  stat('trip', cx + 58, top + 288, 82, () => live.trip, 'TRIP ');
  return out;
}

const LAYOUTS = { home: homeSpecs, dash: dashSpecs, cluster: clusterSpecs };

// ---------- gauges ----------

const faceCache = {};
function drawGauge(c, p, kind) {
  const R = p.w / 2, speed = kind === 'speed', max = speed ? 80 : 8, major = speed ? 10 : 1, minor = speed ? 2.5 : 0.25;
  const val = speed ? state.mph : state.rpm, a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
  const ang = (v) => a0 + sweep * Math.max(0, Math.min(1, v / max));
  // dial face, ticks and numbers: drawn once per size
  const fk = `${kind}|${R}|${K}`;
  let f = faceCache[kind];
  if (!f || f.key !== fk) {
    const px = Math.ceil(p.w * K), fc = document.createElement('canvas'); fc.width = fc.height = px;
    const g = fc.getContext('2d'); g.scale(K, K); g.translate(R, R);
    const face = g.createRadialGradient(0, -R * 0.3, R * 0.1, 0, 0, R); face.addColorStop(0, '#1c2230'); face.addColorStop(1, '#06080b');
    g.fillStyle = face; g.beginPath(); g.arc(0, 0, R, 0, TAU); g.fill();
    g.strokeStyle = '#2b3240'; g.lineWidth = R * 0.025; g.beginPath(); g.arc(0, 0, R * 0.985, 0, TAU); g.stroke();
    g.lineCap = 'round'; g.strokeStyle = '#ffffff12'; g.lineWidth = R * 0.035; g.beginPath(); g.arc(0, 0, R * 0.92, a0, a0 + sweep); g.stroke();
    if (!speed) { g.strokeStyle = '#ff3b30aa'; g.beginPath(); g.arc(0, 0, R * 0.92, ang(6.2), ang(8)); g.stroke(); }
    g.lineCap = 'butt';
    for (let v = 0; v <= max + 1e-6; v += minor) {
      const a = ang(v), big = Math.abs(v / major - Math.round(v / major)) < 1e-6, r0 = big ? 0.74 : 0.8;
      g.strokeStyle = !speed && v >= 6.2 ? '#ff453a' : big ? '#e8ecf2' : '#6c7686'; g.lineWidth = R * (big ? 0.022 : 0.01);
      g.beginPath(); g.moveTo(Math.cos(a) * R * r0, Math.sin(a) * R * r0); g.lineTo(Math.cos(a) * R * 0.86, Math.sin(a) * R * 0.86); g.stroke();
      if (big) text(g, String(v), Math.cos(a) * R * 0.62, Math.sin(a) * R * 0.62, font(600, R * 0.1), !speed && v >= 7 ? '#ff6a60' : '#cfd5de', 'center', 0, 'middle');
    }
    text(g, speed ? 'mph' : '×1000 rpm', 0, R * 0.64, font(500, R * 0.085), '#8a93a3', 'center');
    f = faceCache[kind] = { key: fk, cv: fc };
  }
  c.drawImage(f.cv, 0, 0, p.w, p.h);
  c.save(); c.translate(R, R);
  c.lineCap = 'round'; c.shadowColor = '#4aa3ff'; c.shadowBlur = R * 0.06 * K;
  c.strokeStyle = '#4aa3ff'; c.lineWidth = R * 0.035; c.beginPath(); c.arc(0, 0, R * 0.92, a0, Math.max(a0 + 0.001, ang(val))); c.stroke();
  c.shadowBlur = 0;
  text(c, speed ? String(Math.round(val)) : val.toFixed(1), 0, R * 0.5, font(650, R * 0.26), '#fff', 'center');
  c.rotate(ang(val));
  c.fillStyle = '#ff6a2b';
  c.beginPath(); c.moveTo(-R * 0.14, -R * 0.02); c.lineTo(R * 0.84, -R * 0.006); c.lineTo(R * 0.84, R * 0.006); c.lineTo(-R * 0.14, R * 0.02); c.closePath(); c.fill();
  c.fillStyle = '#20252f'; c.beginPath(); c.arc(0, 0, R * 0.075, 0, TAU); c.fill();
  c.strokeStyle = '#3a4252'; c.lineWidth = R * 0.012; c.stroke();
  c.restore();
}

// ---------- pieces <-> bodies ----------

function fitScreen() {
  const W = screenEl.clientWidth, H = screenEl.clientHeight;
  DPR = Math.min(2, window.devicePixelRatio || 1);
  S = H / 480; LW = W / S; LH = 480;
  if (LW < 760) { S = W / 760; LW = 760; LH = H / S; }
  K = S * DPR;
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  world.setBounds(0, 0, LW, LH);
  backdrop = null;
}

function setLayout(name) {
  if (drag) endDrag();
  state.layout = name;
  for (const b of $$('#layouts button')) b.classList.toggle('on', b.dataset.layout === name);
  world.clear(); tweens.clear();
  update(0, true);
  pieces = LAYOUTS[name]().map((sp) => {
    const p = { ...sp, home: { x: sp.x, y: sp.y } };
    p.body = world.add(new Body({ x: sp.x, y: sp.y, w: sp.w, h: sp.h, shape: sp.shape || 'box', pinned: true, friction: 0.55 }));
    return p;
  });
  backdrop = null;
  if (state.loose) setTimeout(() => { if (state.layout === name && state.loose) dropAll(); }, 700);
}

// new sizes (resize or rotation): every piece gets its new home and size, loose ones stay where they are
function relayout() {
  if (drag) endDrag();
  fitScreen();
  const specs = new Map(LAYOUTS[state.layout]().map((s) => [s.id, s])), W = world.walls;
  for (const p of pieces) {
    const sp = specs.get(p.id); if (!sp) continue;
    Object.assign(p, { ...sp, body: p.body, home: { x: sp.x, y: sp.y }, cache: null });
    const b = p.body; b.resize(sp.w, sp.h);
    if (b.pinned && !tweens.has(b)) { b.x = sp.x; b.y = sp.y; b.angle = 0; }
    b.x = Math.max(W.l + 4, Math.min(W.r - 4, b.x)); b.y = Math.max(W.t + 4, Math.min(W.b - 4, b.y));
  }
}
let resizeTimer = 0;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(relayout, 100); }).observe(screenEl);

function dropAll() {
  state.loose = true; $('#drop').textContent = 'Restore';
  const zero = state.mode === 'zero';
  for (const { body: b } of pieces) {
    if (!b.pinned) continue;
    tweens.delete(b); b.setPinned(false);
    b.w = (Math.random() - 0.5) * (zero ? 1.2 : 0.6);
    b.vx = (Math.random() - 0.5) * (zero ? 160 : 30);
    b.vy = zero ? (Math.random() - 0.5) * 160 : -Math.random() * 40;
  }
}

function restore() {
  state.loose = false; $('#drop').textContent = 'Drop';
  if (drag) endDrag();
  pieces.forEach((p, i) => {
    const b = p.body;
    b.angle = ((b.angle % TAU) + TAU * 1.5) % TAU - Math.PI; // the short way round
    b.setPinned(true);
    tweens.set(b, { t: -i * 0.012, fx: b.x, fy: b.y, fa: b.angle, p });
  });
}

function stepTweens(dt) {
  for (const [b, tw] of tweens) {
    tw.t += dt;
    const t = Math.max(0, Math.min(1, tw.t / 0.8)), c = 1.3, e = 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; // ease-out-back
    const h = tw.p.home;
    b.x = tw.fx + (h.x - tw.fx) * e; b.y = tw.fy + (h.y - tw.fy) * e; b.angle = tw.fa * (1 - e);
    if (t >= 1) { b.x = h.x; b.y = h.y; b.angle = 0; tweens.delete(b); }
  }
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
  const g = state.strength * 3 * LH; // logical px/s²: 1 g falls the screen in ~0.8 s
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
  const dx = -a.x / 9.81, dy = a.y / 9.81; // device axes: x right, y down the portrait screen
  const ang = -((screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0) * Math.PI / 180;
  const c = Math.cos(ang), s = Math.sin(ang), x = dx * c - dy * s, y = dx * s + dy * c;
  const t = state.tilt || { x, y };
  state.tilt = { x: t.x + (x - t.x) * 0.35, y: t.y + (y - t.y) * 0.35 };
}

// ---------- pointer: grab, throw, tap ----------

const toLogical = (e) => { const r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / S, y: (e.clientY - r.top) / S }; };
// topmost piece under a point, and the point in that piece's coordinates
function pieceAt(x, y, slop = 4) {
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = pieces[i], b = p.body, c = Math.cos(-b.angle), s = Math.sin(-b.angle), dx = x - b.x, dy = y - b.y;
    const u = c * dx - s * dy + p.w / 2, v = s * dx + c * dy + p.h / 2;
    const inside = p.shape === 'circle' ? Math.hypot(u - p.w / 2, v - p.h / 2) <= p.w / 2 + slop : u >= -slop && v >= -slop && u <= p.w + slop && v <= p.h + slop;
    if (inside) return { p, u, v };
  }
  return null;
}
let drag = null;
cv.addEventListener('pointerdown', (e) => {
  if (drag) return;
  document.body.classList.remove('menu');
  const pt = toLogical(e), hit = pieceAt(pt.x, pt.y);
  if (!hit) return;
  e.preventDefault(); cv.setPointerCapture(e.pointerId);
  const act = hit.p.hits?.find((h) => hit.u >= h.x && hit.v >= h.y && hit.u <= h.x + h.w && hit.v <= h.y + h.h)?.act || hit.p.act;
  drag = { id: e.pointerId, p: hit.p, x0: pt.x, y0: pt.y, t0: performance.now(), act, moved: false, joint: null };
  if (!hit.p.body.pinned) grab(pt);
});
cv.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const pt = toLogical(e);
  if (!drag.moved && Math.hypot(pt.x - drag.x0, pt.y - drag.y0) > 6) {
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
cv.addEventListener('pointerup', up);
cv.addEventListener('pointercancel', up);

function grab(pt) {
  const b = drag.p.body;
  drag.joint = world.grab(b, pt.x, pt.y, { hz: 5, damping: 0.7, maxForce: b.mass * 90000 });
  pieces.splice(pieces.indexOf(drag.p), 1); pieces.push(drag.p); // on top
  cv.classList.add('grabbing');
}
function endDrag() { if (!drag) return; world.release(); cv.classList.remove('grabbing'); drag = null; }

function tap({ act, p }) {
  const a = act || '';
  if (a === 'play') { state.playing = !state.playing; return; }
  if (a === 'next' || a === 'prev') return changeTrack(a === 'next' ? 1 : -1);
  if (a === 'home') return setLayout(state.layout === 'home' ? 'dash' : 'home');
  if (a.startsWith('app:') && ['maps', 'music', 'podcasts', 'audiobooks'].includes(a.slice(4)) && state.layout !== 'dash') return setLayout('dash');
  hop(p);
}
function hop(p) {
  p.flash = 0.35;
  const b = p.body;
  if (b.pinned) return;
  const g = Math.hypot(world.gx, world.gy);
  if (g < 50) { const a = Math.random() * TAU; b.vx += Math.cos(a) * 500; b.vy += Math.sin(a) * 500; }
  else { const v = Math.sqrt(2 * g * LH * 0.3); b.vx -= world.gx / g * v; b.vy -= world.gy / g * v; }
  b.w += (Math.random() - 0.5) * 8;
}
function changeTrack(d) { state.track = (state.track + d + TRACKS.length) % TRACKS.length; state.pos = 0; }

function shake() {
  if (!state.loose) dropAll();
  for (const { body: b } of pieces) {
    if (b.pinned) continue;
    const a = Math.random() * TAU, v = 500 + Math.random() * 900;
    b.vx += Math.cos(a) * v; b.vy += Math.sin(a) * v - 400; b.w += (Math.random() - 0.5) * 14;
  }
}

// ---------- live values ----------

const fmtClock = (d) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let lastSlow = 0;
function update(dt, force = false) {
  const now = performance.now();
  const dur = TRACKS[state.track][2];
  if (state.playing) { state.pos += dt; if (state.pos >= dur) changeTrack(1); }
  state.mph += (drive.v * 2.237 - state.mph) * Math.min(1, dt * 4);
  const GEARS = [0, 13, 22, 33, 46, 60, 999];
  let gi = 0; while (state.mph > GEARS[gi + 1]) gi++;
  const f = (state.mph - GEARS[gi]) / (GEARS[gi + 1] - GEARS[gi]);
  const rpmT = Math.max(0.8, (gi === 0 ? 0.9 : 1.6) + f * 2.4 + Math.max(0, drive.aLon) * 0.25);
  state.rpm += (rpmT - state.rpm) * Math.min(1, dt * 6);
  const turn = drive.nextTurn();
  live.sig = turn && turn.dist < 70 && now % 760 < 400 ? turn.dir : 0;
  if (force || now - lastSlow > 250) {
    lastSlow = now;
    const d = new Date();
    live.clock = fmtClock(d);
    live.el = mmss(state.pos); live.rem = '-' + mmss(dur - state.pos);
    const far = !turn || turn.dist > 1200;
    live.arrow = far ? GLYPH.straight : turn.dir > 0 ? GLYPH.right : GLYPH.left;
    live.dist = turn ? fmtDist(turn.dist) : '';
    live.onto = far ? 'Continue straight' : turn.onto;
    const left = 7.8 - (drive.trip % 7.6), mins = Math.max(1, Math.round(left / 22 * 60));
    live.mi = left.toFixed(1); live.min = String(mins); live.arr = fmtClock(new Date(d.getTime() + mins * 60000));
    live.odo = Math.floor(drive.odo).toLocaleString('en-US'); live.trip = drive.trip.toFixed(1); live.range = String(Math.round(286 - drive.trip));
  }
}

// ---------- rendering ----------

let backdrop = null, frameNo = 0;
function drawBackdrop() {
  if (!backdrop || backdrop.width !== cv.width || backdrop.height !== cv.height) {
    backdrop = document.createElement('canvas');
    backdrop.width = cv.width; backdrop.height = cv.height; backdrop.layout = null;
  }
  if (backdrop.layout !== state.layout) {
    const g = backdrop.getContext('2d'); g.setTransform(K, 0, 0, K, 0, 0);
    backdrop.layout = state.layout;
    if (state.layout === 'cluster') {
      const r = g.createRadialGradient(LW / 2, LH / 2, 0, LW / 2, LH / 2, LW * 0.6); r.addColorStop(0, '#151b26'); r.addColorStop(0.75, '#050608'); r.addColorStop(1, '#050608');
      g.fillStyle = r; g.fillRect(0, 0, LW, LH);
    } else {
      const lin = g.createLinearGradient(0, 0, LW * 0.6, LH * 1.2); lin.addColorStop(0, '#101320'); lin.addColorStop(1, '#07080c');
      g.fillStyle = lin; g.fillRect(0, 0, LW, LH);
      for (const [x, y, rx, ry, col] of [[0.85, 0.1, 0.6, 0.8, '#3c2a6e88'], [0.1, 1, 0.7, 0.9, '#0f4d6a99'], [0.55, 0.6, 0.5, 0.6, '#63305a55']]) {
        g.save(); g.translate(x * LW, y * LH); g.scale(rx * LW, ry * LH);
        const r = g.createRadialGradient(0, 0, 0, 0, 0, 0.7); r.addColorStop(0, col); r.addColorStop(1, 'transparent');
        g.fillStyle = r; g.fillRect(-1, -1, 2, 2); g.restore();
      }
      g.fillStyle = '#14161acc'; g.fillRect(0, 0, SB, LH);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(backdrop, 0, 0);
}

const M = 6; // cache margin for shadows, logical px
function drawPiece(p) {
  if (p.dyn) return p.draw(ctx, p);
  const key = `${p.key ? p.key() : ''}|${artVer}|${K}|${p.w}|${p.h}`;
  if (!p.cache || p.cacheKey !== key) {
    const c = p.cache || document.createElement('canvas');
    c.width = Math.ceil((p.w + 2 * M) * K); c.height = Math.ceil((p.h + 2 * M) * K);
    const g = c.getContext('2d'); g.setTransform(K, 0, 0, K, M * K, M * K);
    p.draw(g, p);
    p.cache = c; p.cacheKey = key;
  }
  ctx.drawImage(p.cache, -M, -M, p.cache.width / K, p.cache.height / K);
}

function render(dt) {
  drawBackdrop();
  frameNo++;
  for (const p of pieces) if (p.map && (frameNo % 2 === 0 || !p.mapCv)) { // maps at 30 fps, at the piece's own resolution
    const w = Math.round(p.w * K), h = Math.round(p.h * K);
    if (!p.mapCv) p.mapCv = document.createElement('canvas');
    if (p.mapCv.width !== w || p.mapCv.height !== h) { p.mapCv.width = w; p.mapCv.height = h; }
    drawMap(p.mapCv.getContext('2d'), w, h, drive, { scale: Math.max(w, h) / p.map });
  }
  ctx.setTransform(K, 0, 0, K, 0, 0);
  for (const p of pieces) {
    const b = p.body;
    ctx.save();
    ctx.translate(b.x, b.y); ctx.rotate(b.angle); ctx.translate(-p.w / 2, -p.h / 2);
    if (drag && drag.p === p && drag.joint && !p.dyn) { ctx.shadowColor = '#000b'; ctx.shadowBlur = 16 * K; ctx.shadowOffsetY = 6 * K; }
    drawPiece(p);
    if (p.flash > 0) { // tap feedback
      p.flash -= dt; ctx.shadowColor = 'transparent'; ctx.globalAlpha = Math.max(0, p.flash / 0.35) * 0.35; ctx.globalCompositeOperation = 'lighter';
      if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(p.w / 2, p.h / 2, p.w / 2, 0, TAU); } else rrect(ctx, 0, 0, p.w, p.h, Math.min(p.w, p.h) * 0.23);
      ctx.fillStyle = '#fff'; ctx.fill();
    }
    ctx.restore();
  }
}

// ---------- hardware controls ----------

const dial = $('#dial');
function drawDial() {
  const W = Math.max(1, Math.round(dial.clientWidth * DPR));
  if (!W || dial.offsetParent === null) return;
  if (dial.width !== W) dial.width = dial.height = W;
  const g = dial.getContext('2d'), R = W / 2;
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, W, W); g.translate(R, R);
  g.fillStyle = '#16181c'; g.beginPath(); g.arc(0, 0, R - 1, 0, TAU); g.fill();
  g.strokeStyle = '#33373e'; g.lineWidth = Math.max(1, R * 0.08); g.stroke();
  const [gx, gy] = state.g, m = Math.hypot(gx, gy), L = Math.min(1, m / 1.5) * R * 0.72;
  if (L < R * 0.08) { g.fillStyle = '#8fb3ff'; g.beginPath(); g.arc(0, 0, R * 0.12, 0, TAU); g.fill(); return; }
  g.rotate(Math.atan2(gy, gx));
  g.strokeStyle = g.fillStyle = state.mode === 'down' ? '#8fb3ff' : '#ffb35c';
  g.lineWidth = R * 0.14; g.lineCap = 'round';
  g.beginPath(); g.moveTo(-L * 0.35, 0); g.lineTo(L - R * 0.18, 0); g.stroke();
  g.beginPath(); g.moveTo(L + R * 0.05, 0); g.lineTo(L - R * 0.3, -R * 0.26); g.lineTo(L - R * 0.3, R * 0.26); g.closePath(); g.fill();
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
$('#menu').addEventListener('click', () => document.body.classList.toggle('menu'));
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.key.startsWith('Arrow')) return;
  const k = e.key.toLowerCase();
  const dirs = { arrowdown: Math.PI / 2, arrowup: -Math.PI / 2, arrowleft: Math.PI, arrowright: 0 };
  if (k in dirs) { e.preventDefault(); state.angle = dirs[k]; setMode('down'); }
  else if (k === 'g') state.loose ? restore() : dropAll();
  else if (k === 's') shake();
  else if (k === 'z') setMode('zero');
  else if (k === 'd') setMode('drive');
  else if (k === 't') setMode('tilt');
  else if (k === 'm') document.body.classList.toggle('menu');
  else if (k === '1' || k === '2' || k === '3') setLayout(['home', 'dash', 'cluster'][+k - 1]);
});

let toastTimer = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 3200); }

// ---------- loop ----------

let last = performance.now(), acc = 0;
const perf = { frames: 0, ms: 0 };
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  const t0 = performance.now();
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
  update(dt);
  render(dt);
  drawDial();
  perf.frames++; perf.ms += performance.now() - t0;
  requestAnimationFrame(frame);
}

const startMode = ['down', 'tilt', 'drive', 'zero'].includes(params.get('mode')) ? params.get('mode') : 'down';
fitScreen();
setLayout(state.layout);
setMode(startMode, false);
requestAnimationFrame(frame);
if (!params.has('still')) setTimeout(() => { if (!state.loose) dropAll(); }, 1600);

// for the smoke test: a piece (or one of its buttons) in client coordinates
function clientOf(id, act) {
  const p = pieces.find((q) => q.id === id), b = p.body, h = act && p.hits.find((q) => q.act === act);
  const u = h ? h.x + h.w / 2 - p.w / 2 : 0, v = h ? h.y + h.h / 2 - p.h / 2 : 0, c = Math.cos(b.angle), s = Math.sin(b.angle);
  const r = cv.getBoundingClientRect();
  return [r.left + (b.x + c * u - s * v) * S, r.top + (b.y + s * u + c * v) * S];
}
window.__cp = { world, state, drive, perf, get pieces() { return pieces; }, get size() { return { S, LW, LH }; }, setLayout, setMode, dropAll, restore, shake, clientOf };

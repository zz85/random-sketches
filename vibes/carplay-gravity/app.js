// CarPlay Gravity: a CarPlay screen whose pieces are rigid bodies (after mrdoob's Google Gravity),
// drawn on one canvas in the look of CarPlay in iOS 26 / 27. The screen is laid out in logical
// pixels for an 800 × 480 head unit (wider screens get more width, the height stays 480) and scaled
// to the device. Each piece draws itself in its own coordinates; static ones are cached as bitmaps
// and redrawn only when what they show changes, live ones (maps, gauges) every frame. The options
// are a CarPlay-style sheet on the same canvas (the button top right, the Settings app, or M).
import { World, Body } from './physics.js';
import { Drive, drawMap, fmtDist } from './nav.js';
import { APPS, HOME_APPS, GLYPH, paintApp, glyph, squircle } from './icons.js';

const params = new URLSearchParams(location.search);
const TAU = Math.PI * 2, STEP = 1 / 120;
const FAM = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", system-ui, sans-serif';
const font = (w, px) => `${w} ${px}px ${FAM}`;
const screenEl = document.getElementById('screen'), cv = document.getElementById('cv'), ctx = cv.getContext('2d');
const world = new World();
const drive = new Drive(+params.get('seed') || 7);

const TRACKS = [
  ['Low Tide Signals', 'The Ferry Lights', 222, 205],
  ['Gravity Well', 'Mira Okafor', 245, 330],
  ['Westlake at Dusk', 'Paper Satellites', 198, 25],
  ['Slow Orbit', 'Hollis & June', 301, 265],
  ['Rain on Route 99', 'Northbound', 235, 160],
];
const LAYOUT_NAMES = ['home', 'dash', 'cluster'], MODES = ['down', 'tilt', 'drive', 'zero'];
const WALLPAPERS = { indigo: 'Indigo', rose: 'Rose', teal: 'Teal', ocean: 'Ocean' };
const saved = (() => { try { return JSON.parse(localStorage.getItem('carplay-gravity') || '{}'); } catch (e) { return {}; } })();
const pick = (v, list, d) => (list.includes(v) ? v : d);

const state = {
  layout: pick(params.get('layout') || saved.layout, LAYOUT_NAMES, 'home'),
  wallpaper: pick(params.get('wallpaper') || saved.wallpaper, Object.keys(WALLPAPERS), 'indigo'),
  icons: pick(params.get('icons') || saved.icons, ['default', 'dark'], 'default'),
  loose: false, mode: 'down', strength: 1, angle: Math.PI / 2, tilt: null,
  playing: true, track: 0, pos: 37, bumpT: 0, nextBump: 3, mph: 0, rpm: 0.8, g: [0, 1],
  menu: params.has('menu'), menuT: params.has('menu') ? 1 : 0,
};
const save = () => { try { localStorage.setItem('carplay-gravity', JSON.stringify({ layout: state.layout, wallpaper: state.wallpaper, icons: state.icons })); } catch (e) { /* private mode */ } };
// what the pieces show, updated once a frame
const live = { clock: '', dist: '', onto: '', dir: 0, mi: '', min: '', arr: '', odo: '', trip: '', range: '', sig: 0 };
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

function rrect(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); }
function lin(c, x0, y0, x1, y1, stops) {
  const g = c.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((s, i) => (Array.isArray(s) ? g.addColorStop(s[0], s[1]) : g.addColorStop(i / (stops.length - 1), s)));
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
const measure = (s, f) => { ctx.font = f; return ctx.measureText(s).width; };

// Liquid Glass, as far as a 2D canvas goes: a translucent tinted fill, a sheen across the top and
// a rim lit from the top left (and faintly from the bottom right).
function glass(c, x, y, w, h, r, tint = 'rgba(38,38,48,.55)', { rim = 1, sheen = 0.1 } = {}) {
  rrect(c, x, y, w, h, r); c.fillStyle = tint; c.fill();
  if (sheen) { rrect(c, x, y, w, h, r); c.fillStyle = lin(c, 0, y, 0, y + Math.min(h, 90), [`rgba(255,255,255,${sheen})`, 'rgba(255,255,255,0)']); c.fill(); }
  rrect(c, x + 0.5, y + 0.5, w - 1, h - 1, r);
  c.lineWidth = 1;
  c.strokeStyle = lin(c, x, y, x + w * 0.6, y + h, [[0, `rgba(255,255,255,${0.5 * rim})`], [0.35, `rgba(255,255,255,${0.1 * rim})`], [0.8, `rgba(255,255,255,${0.06 * rim})`], [1, `rgba(255,255,255,${0.28 * rim})`]]);
  c.stroke();
}

// ---------- wallpapers ----------
// "Celosia" (iOS 27): sweeping layered petals with soft shadows and lit edges, in a hue; "Ocean"
// (iOS 26's dark default): a teal sweep and a blue one.
function paintWallpaper(g, W, H, name) {
  if (name === 'ocean') {
    g.fillStyle = lin(g, 0, 0, W, H, ['#0b3150', '#071a33']); g.fillRect(0, 0, W, H);
    const band = (pts, fill, rimc) => {
      g.save(); g.shadowColor = 'rgba(0,0,0,.45)'; g.shadowBlur = 40; g.shadowOffsetY = -6;
      g.beginPath(); pts(g); g.fillStyle = fill; g.fill(); g.restore();
      g.beginPath(); pts(g, true); g.strokeStyle = rimc; g.lineWidth = 1.5; g.stroke();
    };
    band((p, edge) => { p.moveTo(W * 0.02, -10); p.bezierCurveTo(W * 0.15, H * 0.55, W * 0.4, H * 0.9, W * 0.62, H + 10); if (!edge) { p.lineTo(-10, H + 10); p.lineTo(-10, -10); p.closePath(); } },
      lin(g, 0, 0, W * 0.5, H, ['#0e7a92', '#0b4b72']), 'rgba(140,230,255,.35)');
    band((p, edge) => { p.moveTo(W * 0.58, -10); p.bezierCurveTo(W * 0.5, H * 0.35, W * 0.62, H * 0.75, W * 0.98, H * 0.95); if (!edge) { p.lineTo(W + 10, H + 10); p.lineTo(W + 10, -10); p.closePath(); } },
      lin(g, W * 0.5, 0, W, H, ['#2856b8', '#163985']), 'rgba(150,190,255,.4)');
    band((p, edge) => { p.moveTo(W * 0.48, H + 10); p.bezierCurveTo(W * 0.62, H * 0.6, W * 0.85, H * 0.45, W + 10, H * 0.42); if (!edge) { p.lineTo(W + 10, H + 10); p.closePath(); } },
      lin(g, W * 0.5, H * 0.4, W, H, ['#1f4aa6', '#10306f']), 'rgba(150,190,255,.35)');
    return;
  }
  const hue = { indigo: 250, rose: 334, teal: 190 }[name] ?? 250;
  g.fillStyle = lin(g, 0, 0, W * 0.4, H, [`hsl(${hue} 45% 20%)`, `hsl(${hue + 8} 50% 7%)`]); g.fillRect(0, 0, W, H);
  // each petal: an S-curve rising to the right, filled below, lit along its edge and casting a soft
  // shadow up onto the one behind it
  const bands = [[0.5, -0.12, 30], [0.82, 0.12, 25], [1.12, 0.38, 20], [1.42, 0.62, 15], [1.75, 0.9, 10]];
  bands.forEach(([y0, y1, l], i) => {
    const curve = (p) => { p.moveTo(-W * 0.05, H * y0); p.bezierCurveTo(W * 0.32, H * (y0 - 0.62), W * 0.5, H * (y1 + 0.42), W * 1.05, H * y1); };
    g.save(); g.shadowColor = 'rgba(0,0,0,.6)'; g.shadowBlur = 44; g.shadowOffsetY = -12;
    g.beginPath(); curve(g); g.lineTo(W * 1.05, H * 1.1); g.lineTo(-W * 0.05, H * 1.1); g.closePath();
    g.fillStyle = lin(g, W * 0.2, H * (y1 + 0.1), W * 0.45, H * 1.1, [`hsl(${hue + i * 3} 42% ${l + 10}%)`, `hsl(${hue + i * 5} 48% ${Math.max(4, l - 10)}%)`]);
    g.fill(); g.restore();
    // the lit edge: a soft glow and a thin bright line that fades towards the ends
    const edge = lin(g, 0, 0, W, 0, [[0, `hsla(${hue + 15} 90% 82% / 0)`], [0.35, `hsla(${hue + 15} 90% 82% / ${0.55 - i * 0.06})`], [0.75, `hsla(${hue + 10} 90% 86% / ${0.35 - i * 0.04})`], [1, `hsla(${hue + 15} 90% 82% / 0.1)`]]);
    g.save(); g.shadowColor = `hsla(${hue + 15} 90% 75% / .55)`; g.shadowBlur = 10;
    g.beginPath(); curve(g); g.strokeStyle = edge; g.lineWidth = 1.6; g.stroke(); g.restore();
  });
  // a little light falling from the top
  const r = g.createRadialGradient(W * 0.62, -H * 0.1, 0, W * 0.62, -H * 0.1, H * 0.9); r.addColorStop(0, `hsla(${hue + 20} 70% 70% / .16)`); r.addColorStop(1, 'transparent');
  g.fillStyle = r; g.fillRect(0, 0, W, H);
}

// ---------- pieces ----------
// A spec: { id, x, y (centre), w, h, shape?, draw(c, p), key?() (cache while unchanged), dyn? (draw every frame),
//           act? (tap), hits?: [{ x, y, w, h, act }] in piece coordinates }

const SB = 82; // the sidebar's width; its glass pill is the backdrop, its contents are pieces
const dark = () => state.icons === 'dark';

function sidebar(homeBtn) {
  const out = [
    { id: 'sb-time', x: 41, y: 30, w: 62, h: 22, key: () => live.clock, draw: (c, p) => text(c, live.clock, p.w / 2, p.h / 2 + 1, font(650, 19), '#fff', 'center', 0, 'middle') },
    { id: 'sb-sig', x: 41, y: 51, w: 44, h: 13, draw: (c) => {
      c.fillStyle = '#fff'; [0.35, 0.55, 0.78, 1].forEach((f, i) => { rrect(c, 1 + i * 4.6, 12 * (1 - f) + 0.5, 3.2, 12 * f, 1); c.fill(); });
      text(c, '5G', 21, 12, font(650, 12.5), '#fff');
    } },
  ];
  ['maps', 'music', 'phone'].forEach((n, i) => out.push({ id: 'mini-' + n, x: 41, y: 112 + i * 54, w: 42, h: 42, act: 'app:' + n,
    key: () => state.icons + (n === 'calendar' ? new Date().getDate() : ''), draw: (c, p) => paintApp(c, n, 0, 0, p.w, { dark: dark() }) }));
  out.push({ id: 'sb-btn', x: 41, y: LH - 38, w: 42, h: 42, act: 'home', draw: (c, p) => (homeBtn === 'grid' ? glyph.gridBtn : glyph.dashBtn)(c, 4, 4, p.w - 8) });
  return out;
}

function homeSpecs() {
  const cols = LW / LH >= 2.05 ? 5 : 4, MW = LW - SB - 8;
  const T = Math.round(Math.min(104, (MW - (cols + 1) * 34) / cols, (LH - 150) / 2 - 30));
  const gx = (MW - cols * T) / (cols + 1), LBL = 24, rowH = T + 7 + LBL, gapY = Math.min(24, LH * 0.05);
  const top = Math.round((LH - (2 * rowH + gapY + 26)) / 2) + 2, out = sidebar('dash');
  HOME_APPS.slice(0, cols * 2).forEach((n, i) => {
    const col = i % cols, row = Math.floor(i / cols), cx = SB + gx + T / 2 + col * (T + gx), y0 = top + row * (rowH + gapY);
    out.push({ id: 'tile-' + n, x: cx, y: y0 + T / 2, w: T, h: T, act: 'app:' + n, key: () => state.icons + (n === 'calendar' ? new Date().toDateString() : ''),
      draw: (c, p) => paintApp(c, n, 0, 0, p.w, { dark: dark() }) });
    const f = font(500, 15), lw = Math.ceil(measure(APPS[n].label, f)) + 16;
    out.push({ id: 'lbl-' + n, x: cx, y: y0 + T + 7 + LBL / 2, w: lw, h: LBL, draw: (c, p) => {
      rrect(c, 0, 0, p.w, p.h, 8); c.fillStyle = 'rgba(30,30,40,.5)'; c.fill();
      text(c, APPS[n].label, p.w / 2, p.h / 2 + 0.5, f, '#fff', 'center', 0, 'middle');
    } });
  });
  // pages: widgets, Dashboard, then the app grid
  const pages = 2 + Math.ceil(HOME_APPS.length / (cols * 2)), dw = pages * 14;
  out.push({ id: 'dots', x: SB + MW / 2 + 4, y: top + 2 * rowH + gapY + 16, w: dw, h: 12, draw: (c) => {
    for (let i = 0; i < pages; i++) { c.fillStyle = i === 2 ? '#fff' : 'rgba(255,255,255,.35)'; c.beginPath(); c.arc(7 + i * 14, 6, 3.6, 0, TAU); c.fill(); }
  } });
  return out;
}

function dashSpecs() {
  const g = 6, x0 = SB + 2, y0 = g, AW = LW - g - x0, AH = LH - 2 * g;
  const mapW = Math.round((AW - g) * 0.6), RW = AW - mapW - g, cH = (AH - 2 * g) / 3, rx = x0 + mapW + g;
  const out = sidebar('grid');
  const blue = 'rgba(48,104,226,.5)';
  out.push({ id: 'map', x: x0 + mapW / 2, y: y0 + AH / 2, w: mapW, h: AH, dyn: true, map: 400, draw: (c, p) => {
    c.save(); rrect(c, 0, 0, p.w, p.h, 20); c.clip();
    if (p.mapCv) c.drawImage(p.mapCv, 0, 0, p.w, p.h);
    const parts = [[live.arr, ' arrival'], [live.min, ' min'], [live.mi, ' mi']], fb = font(650, 15), fr = font(500, 15);
    const widths = parts.map(([v, u]) => measure(v, fb) + measure(u, fr)), gap = 16, tw = widths.reduce((a, b) => a + b) + gap * 2, pw = tw + 36;
    glass(c, (p.w - pw) / 2, p.h - 46, pw, 36, 18, 'rgba(28,28,34,.72)', { sheen: 0.06 });
    let x = (p.w - tw) / 2;
    parts.forEach(([v, u], i) => { text(c, v, x, p.h - 23, fb, '#fff'); text(c, u, x + measure(v, fb), p.h - 23, fr, '#ffffffcc'); x += widths[i] + gap; });
    c.restore();
    rrect(c, 0.5, 0.5, p.w - 1, p.h - 1, 20); c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 1; c.stroke();
  } });
  out.push({ id: 'turn', x: rx + RW / 2, y: y0 + cH / 2, w: RW, h: cH, key: () => `${live.dist}|${live.onto}|${live.dir}`, draw: (c, p) => {
    glass(c, 0, 0, p.w, p.h, 20, blue);
    glyph.turn(c, 16, p.h / 2 - 22, 44, live.dir);
    text(c, live.dist, 74, p.h / 2 - 2, font(650, 26), '#fff', 'left', p.w - 86);
    text(c, live.onto, 74, p.h / 2 + 22, font(500, 17), '#ffffffd9', 'left', p.w - 86);
  } });
  const bs = 34, cy = cH / 2, ax = 16 + 66 + 8, span = RW - ax - 10;
  out.push({ id: 'np', x: rx + RW / 2, y: y0 + cH + g + cH / 2, w: RW, h: cH,
    hits: [['prev', 0.17], ['play', 0.5], ['next', 0.83]].map(([act, f]) => ({ act, x: ax + span * f - bs * 0.8, y: cy - bs * 0.8, w: bs * 1.6, h: bs * 1.6 })),
    key: () => `${state.track}|${state.playing}`,
    draw: (c, p) => {
      glass(c, 0, 0, p.w, p.h, 20, blue);
      const hue = TRACKS[state.track][3], A = 66, x = 16, y = cy - A / 2;
      c.save(); rrect(c, x, y, A, A, 9); c.clip();
      c.fillStyle = `hsl(${hue} 70% 45%)`; c.fillRect(x, y, A, A);
      if (c.createConicGradient) { const cg = c.createConicGradient(3.6, x + A * 0.35, y + A * 0.7); cg.addColorStop(0, `hsl(${hue} 80% 55%)`); cg.addColorStop(0.35, `hsl(${hue + 70} 70% 35%)`); cg.addColorStop(0.7, `hsl(${hue + 150} 85% 55%)`); cg.addColorStop(1, `hsl(${hue} 80% 55%)`); c.fillStyle = cg; c.fillRect(x, y, A, A); }
      const rg = c.createRadialGradient(x + A * 0.7, y + A * 0.25, 0, x + A * 0.7, y + A * 0.25, A * 0.5); rg.addColorStop(0, `hsl(${hue + 40} 90% 78% / .85)`); rg.addColorStop(1, 'transparent'); c.fillStyle = rg; c.fillRect(x, y, A, A);
      c.restore();
      for (const h of p.hits) {
        const s = h.act === 'play' ? bs * 1.05 : bs, gx = h.x + h.w / 2 - s / 2, gy = h.y + h.h / 2 - s / 2;
        glyph[h.act === 'play' ? (state.playing ? 'pause' : 'play') : h.act](c, gx, gy, s);
      }
    } });
  out.push({ id: 'upnext', x: rx + RW / 2, y: y0 + 2 * (cH + g) + cH / 2, w: RW, h: cH, draw: (c, p) => {
    glass(c, 0, 0, p.w, p.h, 20, 'rgba(26,26,34,.62)');
    const ev = (y, col, when, what) => {
      rrect(c, 16, y - 14, 4, 42, 2); c.fillStyle = col; c.fill();
      text(c, when, 30, y + 2, font(650, 16), col); text(c, what, 30, y + 23, font(500, 15), col, 'left', p.w - 44);
    };
    const s = p.h / 148;
    ev(30 * s, '#ffd60a', '6:30–7:30 PM', 'Squash with Sam');
    text(c, 'TOMORROW', 16, 88 * s, font(500, 11.5), '#ffffff8c');
    ev(110 * s, '#30d158', '7–8 AM', 'Ferry to Bainbridge');
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
    glyph.turn(c, 12, 10, 20, live.dir); text(c, live.dist, 37, 25, c.font, '#fff');
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
  state.layout = name; save();
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
  state.loose = true;
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
  state.loose = false;
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
function startTilt() {
  if (!tiltAsked) {
    tiltAsked = true;
    // iOS asks for permission, and only from inside a user gesture: call it before any await
    const ask = typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function' ? DeviceMotionEvent.requestPermission() : Promise.resolve('granted');
    Promise.resolve(ask).catch(() => 'denied').then(() => window.addEventListener('devicemotion', onMotion));
  }
  setTimeout(() => { if (state.mode === 'tilt' && !state.tilt) toast('No tilt sensor here: gravity stays as the dial points'); }, 1200);
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

// ---------- the options sheet ----------

const ORB = () => (state.layout === 'cluster' ? { x: LW - 26, y: 26, r: 17 } : { x: SB / 2, y: LH - 92, r: 17 });
function menuLayout() {
  const w = Math.min(640, LW - 40), h = Math.min(400, LH - 36), x = (LW - w) / 2, y = (LH - h) / 2;
  const cx = x + 132, cw = Math.min(330, w * 0.52), rx = cx + cw + (x + w - cx - cw) / 2;
  const row = (i) => y + 96 + i * 50;
  const items = [
    { id: 'close', kind: 'button', x: x + w - 50, y: y + 18, w: 34, h: 34, round: true, draw: 'close', run: () => openMenu(false) },
    { id: 'layout', kind: 'seg', label: 'Screen', x: cx, y: row(0) - 18, w: cw, h: 36, options: [['home', 'Home'], ['dash', 'Dashboard'], ['cluster', 'Cluster']], get: () => state.layout, set: (v) => setLayout(v) },
    { id: 'mode', kind: 'seg', label: 'Gravity', x: cx, y: row(1) - 18, w: cw, h: 36, options: [['down', 'Down'], ['tilt', 'Tilt'], ['drive', 'Drive'], ['zero', 'Zero-G']], get: () => state.mode, set: (v) => setMode(v) },
    { id: 'strength', kind: 'slider', label: 'Strength', x: cx, y: row(2) - 18, w: cw - 62, h: 36, min: 0, max: 3, get: () => state.strength, set: (v) => { state.strength = Math.round(v * 20) / 20; }, fmt: (v) => v.toFixed(1) + ' g' },
    { id: 'icons', kind: 'seg', label: 'Icons', x: cx, y: row(3) - 18, w: cw, h: 36, options: [['default', 'Default'], ['dark', 'Dark']], get: () => state.icons, set: (v) => { state.icons = v; save(); } },
    { id: 'wallpaper', kind: 'seg', label: 'Wallpaper', x: cx, y: row(4) - 18, w: cw, h: 36, options: Object.entries(WALLPAPERS), get: () => state.wallpaper, set: (v) => { state.wallpaper = v; save(); backdrop = null; } },
    { id: 'dial', kind: 'dial', x: rx - 58, y: row(0) - 22, w: 116, h: 116 },
    { id: 'shake', kind: 'button', label: 'Shake', x: rx - 70, y: row(3) - 22, w: 140, h: 40, run: shake },
    { id: 'drop', kind: 'button', label: () => (state.loose ? 'Restore' : 'Drop'), x: rx - 70, y: row(4) - 22, w: 140, h: 40, run: () => (state.loose ? restore() : dropAll()), primary: true },
  ];
  return { x, y, w, h, items };
}

function openMenu(on) { state.menu = on; if (menuDrag) menuDrag = null; }

function drawMenu(dt) {
  state.menuT = Math.max(0, Math.min(1, state.menuT + (state.menu ? dt : -dt) / 0.18));
  const t = state.menuT;
  if (t <= 0) { drawOrb(); return; }
  // frosted: the frame shrunk and blown back up, dimmed
  const bw = Math.max(1, Math.round(cv.width / 14)), bh = Math.max(1, Math.round(cv.height / 14));
  if (!blurCv) blurCv = document.createElement('canvas');
  if (blurCv.width !== bw || blurCv.height !== bh) { blurCv.width = bw; blurCv.height = bh; }
  const bc = blurCv.getContext('2d'); bc.imageSmoothingQuality = 'high'; bc.drawImage(cv, 0, 0, bw, bh);
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = t; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(blurCv, 0, 0, cv.width, cv.height);
  ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(0, 0, cv.width, cv.height);
  const M = menuLayout(), sc = 0.96 + 0.04 * t;
  ctx.setTransform(K * sc, 0, 0, K * sc, K * (M.x + M.w / 2) * (1 - sc), K * (M.y + M.h / 2) * (1 - sc));
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 40 * K; ctx.shadowOffsetY = 10 * K;
  rrect(ctx, M.x, M.y, M.w, M.h, 30); ctx.fillStyle = 'rgba(30,30,38,.8)'; ctx.fill(); ctx.restore();
  glass(ctx, M.x, M.y, M.w, M.h, 30, 'rgba(255,255,255,.02)', { sheen: 0.07 });
  text(ctx, 'Gravity', M.x + 26, M.y + 46, font(700, 24), '#fff');
  for (const it of M.items) {
    if (it.label && it.kind !== 'button') text(ctx, it.label, M.x + 26, it.y + it.h / 2 + 1, font(500, 15), '#ffffffa6', 'left', 0, 'middle');
    if (it.kind === 'seg') {
      rrect(ctx, it.x, it.y, it.w, it.h, it.h / 2); ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fill();
      const n = it.options.length, ow = it.w / n, cur = it.get();
      it.options.forEach(([v, lab], i) => {
        if (v === cur) glass(ctx, it.x + i * ow + 3, it.y + 3, ow - 6, it.h - 6, (it.h - 6) / 2, 'rgba(255,255,255,.24)', { sheen: 0.12, rim: 1.2 });
        text(ctx, lab, it.x + i * ow + ow / 2, it.y + it.h / 2 + 1, font(v === cur ? 650 : 500, 14), v === cur ? '#fff' : '#ffffffbf', 'center', ow - 10, 'middle');
      });
    } else if (it.kind === 'slider') {
      const f = (it.get() - it.min) / (it.max - it.min), ty = it.y + it.h / 2;
      rrect(ctx, it.x, ty - 3, it.w, 6, 3); ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fill();
      rrect(ctx, it.x, ty - 3, Math.max(6, it.w * f), 6, 3); ctx.fillStyle = '#0a84ff'; ctx.fill();
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 6 * K; ctx.shadowOffsetY = 2 * K;
      ctx.beginPath(); ctx.arc(it.x + it.w * f, ty, 13, 0, TAU); ctx.fillStyle = '#fff'; ctx.fill(); ctx.restore();
      text(ctx, it.fmt(it.get()), it.x + it.w + 62, ty + 1, font(600, 15), '#fff', 'right', 0, 'middle');
    } else if (it.kind === 'dial') drawDial(ctx, it);
    else if (it.kind === 'button') {
      if (it.round) { ctx.beginPath(); ctx.arc(it.x + it.w / 2, it.y + it.h / 2, it.w / 2, 0, TAU); ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fill(); glyph.close(ctx, it.x + 6, it.y + 6, it.w - 12, '#fff'); }
      else {
        glass(ctx, it.x, it.y, it.w, it.h, it.h / 2, it.primary ? 'rgba(10,132,255,.85)' : 'rgba(255,255,255,.14)', { sheen: 0.12 });
        text(ctx, typeof it.label === 'function' ? it.label() : it.label, it.x + it.w / 2, it.y + it.h / 2 + 1, font(650, 15), '#fff', 'center', 0, 'middle');
      }
    }
  }
  text(ctx, 'Direction', M.items.find((i) => i.id === 'dial').x + 58, M.items.find((i) => i.id === 'dial').y + 136, font(500, 13), '#ffffff8c', 'center');
  text(ctx, 'Drag and throw anything. Keys: M this sheet, G drop, S shake, arrows point gravity.', M.x + M.w / 2, M.y + M.h - 20, font(500, 12), '#ffffff73', 'center', M.w - 40);
  ctx.globalAlpha = 1;
}

function drawDial(c, it) {
  const R = it.w / 2, cx = it.x + R, cy = it.y + R;
  c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.fillStyle = 'rgba(255,255,255,.07)'; c.fill();
  c.strokeStyle = 'rgba(255,255,255,.18)'; c.lineWidth = 1; c.stroke();
  c.fillStyle = 'rgba(255,255,255,.35)';
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2; c.beginPath(); c.arc(cx + Math.cos(a) * (R - 9), cy + Math.sin(a) * (R - 9), 2, 0, TAU); c.fill(); }
  const [gx, gy] = state.g, m = Math.hypot(gx, gy), L = Math.min(1, m / 1.5) * (R - 20);
  if (L < 6) { c.fillStyle = '#0a84ff'; c.beginPath(); c.arc(cx, cy, 6, 0, TAU); c.fill(); return; }
  c.save(); c.translate(cx, cy); c.rotate(Math.atan2(gy, gx));
  c.strokeStyle = c.fillStyle = state.mode === 'down' ? '#0a84ff' : '#ff9f0a'; c.lineWidth = 6; c.lineCap = 'round';
  c.beginPath(); c.moveTo(-L * 0.25, 0); c.lineTo(L - 10, 0); c.stroke();
  c.beginPath(); c.moveTo(L + 4, 0); c.lineTo(L - 14, -10); c.lineTo(L - 14, 10); c.closePath(); c.fill();
  c.restore();
}

function drawOrb() {
  const o = ORB();
  ctx.save(); ctx.globalAlpha = 0.85;
  ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 8 * K;
  ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, TAU); ctx.fillStyle = 'rgba(30,30,38,.55)'; ctx.fill(); ctx.restore();
  ctx.save(); ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.arc(o.x, o.y, o.r - 0.5, 0, TAU);
  ctx.strokeStyle = lin(ctx, o.x - o.r, o.y - o.r, o.x + o.r, o.y + o.r, ['rgba(255,255,255,.55)', 'rgba(255,255,255,.08)', 'rgba(255,255,255,.3)']); ctx.lineWidth = 1; ctx.stroke();
  glyph.gravity(ctx, o.x - 10, o.y - 10, 20);
  ctx.restore();
}

let menuDrag = null;
function menuItemAt(pt) { return menuLayout().items.find((it) => pt.x >= it.x && pt.y >= it.y && pt.x <= it.x + it.w && pt.y <= it.y + it.h); }
function menuDown(pt) {
  const M = menuLayout();
  if (pt.x < M.x || pt.y < M.y || pt.x > M.x + M.w || pt.y > M.y + M.h) { openMenu(false); return; }
  const it = menuItemAt(pt);
  if (!it) return;
  if (it.kind === 'seg') { const i = Math.min(it.options.length - 1, Math.floor((pt.x - it.x) / (it.w / it.options.length))); const v = it.options[i][0]; if (v !== it.get()) it.set(v); }
  else if (it.kind === 'slider' || it.kind === 'dial') { menuDrag = it; menuMove(pt); }
  else if (it.kind === 'button') menuDrag = it;
}
function menuMove(pt) {
  const it = menuDrag;
  if (!it) return;
  if (it.kind === 'slider') it.set(it.min + Math.max(0, Math.min(1, (pt.x - it.x) / it.w)) * (it.max - it.min));
  else if (it.kind === 'dial') {
    const dx = pt.x - it.x - it.w / 2, dy = pt.y - it.y - it.h / 2;
    if (Math.hypot(dx, dy) < 10) return;
    state.angle = Math.atan2(dy, dx);
    if (state.mode !== 'down') setMode('down'); else if (!state.loose) dropAll();
  }
}
function menuUp(pt) {
  const it = menuDrag; menuDrag = null;
  if (it && it.kind === 'button' && pt.x >= it.x && pt.y >= it.y && pt.x <= it.x + it.w && pt.y <= it.y + it.h) it.run();
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
let drag = null, menuPointer = null;
cv.addEventListener('pointerdown', (e) => {
  if (drag || menuPointer != null) return;
  const pt = toLogical(e);
  e.preventDefault(); cv.setPointerCapture(e.pointerId);
  if (state.menu) { menuPointer = e.pointerId; menuDown(pt); return; }
  const o = ORB();
  if (Math.hypot(pt.x - o.x, pt.y - o.y) < o.r + 6) { menuPointer = e.pointerId; openMenu(true); return; }
  const hit = pieceAt(pt.x, pt.y);
  if (!hit) return;
  const act = hit.p.hits?.find((h) => hit.u >= h.x && hit.v >= h.y && hit.u <= h.x + h.w && hit.v <= h.y + h.h)?.act || hit.p.act;
  drag = { id: e.pointerId, p: hit.p, x0: pt.x, y0: pt.y, t0: performance.now(), act, moved: false, joint: null };
  if (!hit.p.body.pinned) grab(pt);
});
cv.addEventListener('pointermove', (e) => {
  const pt = toLogical(e);
  if (e.pointerId === menuPointer) { menuMove(pt); return; }
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.moved && Math.hypot(pt.x - drag.x0, pt.y - drag.y0) > 6) {
    drag.moved = true;
    if (!drag.joint) { const b = drag.p.body; tweens.delete(b); b.setPinned(false); grab({ x: drag.x0, y: drag.y0 }); }
  }
  if (drag.joint) { drag.joint.tx = pt.x; drag.joint.ty = pt.y; }
});
const up = (e) => {
  if (e.pointerId === menuPointer) { menuPointer = null; if (state.menu) menuUp(toLogical(e)); return; }
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
  if (a === 'app:settings') { p.flash = 0.35; return openMenu(true); }
  if (a.startsWith('app:') && ['maps', 'music', 'nowplaying', 'podcasts', 'audiobooks'].includes(a.slice(4)) && state.layout !== 'dash') return setLayout('dash');
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
    const far = !turn || turn.dist > 1200;
    live.dir = far ? 0 : turn.dir;
    live.dist = turn ? fmtDist(turn.dist) : '';
    live.onto = far ? 'Continue straight' : turn.onto;
    const left = 7.8 - (drive.trip % 7.6), mins = Math.max(1, Math.round(left / 22 * 60));
    live.mi = left.toFixed(1); live.min = String(mins); live.arr = fmtClock(new Date(d.getTime() + mins * 60000));
    live.odo = Math.floor(drive.odo).toLocaleString('en-US'); live.trip = drive.trip.toFixed(1); live.range = String(Math.round(286 - drive.trip));
  }
}

// ---------- rendering ----------

let backdrop = null, blurCv = null, frameNo = 0;
function drawBackdrop() {
  const key = `${state.layout === 'cluster' ? 'cluster' : 'carplay'}|${state.wallpaper}|${state.layout === 'cluster' ? '' : state.layout}`;
  if (!backdrop || backdrop.width !== cv.width || backdrop.height !== cv.height) { backdrop = document.createElement('canvas'); backdrop.width = cv.width; backdrop.height = cv.height; }
  if (backdrop.key !== key) {
    backdrop.key = key;
    const g = backdrop.getContext('2d'); g.setTransform(K, 0, 0, K, 0, 0);
    if (state.layout === 'cluster') {
      const r = g.createRadialGradient(LW / 2, LH / 2, 0, LW / 2, LH / 2, LW * 0.6); r.addColorStop(0, '#151b26'); r.addColorStop(0.75, '#050608'); r.addColorStop(1, '#050608');
      g.fillStyle = r; g.fillRect(0, 0, LW, LH);
    } else {
      paintWallpaper(g, LW, LH, state.wallpaper);
      if (state.layout === 'dash') { g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(0, 0, LW, LH); }
      // the sidebar's glass pill
      g.save(); g.shadowColor = 'rgba(0,0,0,.35)'; g.shadowBlur = 14; rrect(g, 6, 6, SB - 12, LH - 12, 24); g.fillStyle = 'rgba(16,16,22,.42)'; g.fill(); g.restore();
      glass(g, 6, 6, SB - 12, LH - 12, 24, 'rgba(255,255,255,.04)', { sheen: 0.08, rim: 1.2 });
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
      p.flash -= dt; ctx.shadowColor = 'transparent'; ctx.globalAlpha = Math.max(0, p.flash / 0.35) * 0.3; ctx.globalCompositeOperation = 'lighter';
      if (p.shape === 'circle') { ctx.beginPath(); ctx.arc(p.w / 2, p.h / 2, p.w / 2, 0, TAU); } else if (p.id.startsWith('tile') || p.id.startsWith('mini')) squircle(ctx, 0, 0, p.w); else rrect(ctx, 0, 0, p.w, p.h, 12);
      ctx.fillStyle = '#fff'; ctx.fill();
    }
    ctx.restore();
  }
  ctx.setTransform(K, 0, 0, K, 0, 0);
  drawToast(dt);
  drawMenu(dt);
}

let toastMsg = '', toastT = 0;
function toast(msg) { toastMsg = msg; toastT = 3.2; }
function drawToast(dt) {
  if (toastT <= 0) return;
  toastT -= dt;
  const f = font(500, 14), w = measure(toastMsg, f) + 32;
  ctx.globalAlpha = Math.min(1, toastT / 0.3);
  glass(ctx, (LW - w) / 2, LH - 58, w, 38, 19, 'rgba(28,28,34,.85)');
  text(ctx, toastMsg, LW / 2, LH - 38, f, '#fff', 'center', 0, 'middle');
  ctx.globalAlpha = 1;
}

// ---------- keys ----------

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const dirs = { arrowdown: Math.PI / 2, arrowup: -Math.PI / 2, arrowleft: Math.PI, arrowright: 0 };
  if (k in dirs) { e.preventDefault(); state.angle = dirs[k]; setMode('down'); }
  else if (k === 'g') state.loose ? restore() : dropAll();
  else if (k === 's') shake();
  else if (k === 'z') setMode('zero');
  else if (k === 'd') setMode('drive');
  else if (k === 't') setMode('tilt');
  else if (k === 'm') openMenu(!state.menu);
  else if (k === 'escape') openMenu(false);
  else if (k === '1' || k === '2' || k === '3') setLayout(LAYOUT_NAMES[+k - 1]);
});

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
  perf.frames++; perf.ms += performance.now() - t0;
  requestAnimationFrame(frame);
}

fitScreen();
setLayout(state.layout);
setMode(pick(params.get('mode'), MODES, 'down'), false);
requestAnimationFrame(frame);
if (!params.has('still')) setTimeout(() => { if (!state.loose) dropAll(); }, 1600);

// for the smoke test: client coordinates of a piece (or one of its buttons), or of a sheet control
function clientOf(id, act) {
  const p = pieces.find((q) => q.id === id), b = p.body, h = act && p.hits.find((q) => q.act === act);
  const u = h ? h.x + h.w / 2 - p.w / 2 : 0, v = h ? h.y + h.h / 2 - p.h / 2 : 0, c = Math.cos(b.angle), s = Math.sin(b.angle);
  const r = cv.getBoundingClientRect();
  return [r.left + (b.x + c * u - s * v) * S, r.top + (b.y + s * u + c * v) * S];
}
function menuPoint(id, fx = 0.5, option) {
  const r = cv.getBoundingClientRect();
  if (id === 'orb') { const o = ORB(); return [r.left + o.x * S, r.top + o.y * S]; }
  const it = menuLayout().items.find((i) => i.id === id);
  if (option != null) { const i = it.options.findIndex(([v]) => v === option); fx = (i + 0.5) / it.options.length; }
  return [r.left + (it.x + it.w * fx) * S, r.top + (it.y + it.h / 2) * S];
}
window.__cp = { world, state, drive, perf, get pieces() { return pieces; }, get size() { return { S, LW, LH }; }, setLayout, setMode, dropAll, restore, shake, openMenu, clientOf, menuPoint };

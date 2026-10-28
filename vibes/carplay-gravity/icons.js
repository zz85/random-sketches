// App icons and small glyphs, painted on a canvas in the style of CarPlay in iOS 26 / 27: squircle
// tiles with a lit glass rim, Default (colour) and Dark appearances. Drawn from scratch here, not
// Apple's artwork. Every painter works in a 24-unit box scaled to the tile size.

const TAU = Math.PI * 2;
const FAM = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", system-ui, sans-serif';

// Apple's icon outline is close to a superellipse with n ≈ 5
export function squircle(c, x, y, w, h = w, n = 5) {
  const rx = w / 2, ry = h / 2, cx = x + rx, cy = y + ry, e = 2 / n, N = 72;
  c.beginPath();
  for (let i = 0; i < N; i++) {
    const t = (i / N) * TAU, ct = Math.cos(t), st = Math.sin(t);
    const px = cx + rx * Math.sign(ct) * Math.abs(ct) ** e, py = cy + ry * Math.sign(st) * Math.abs(st) ** e;
    i ? c.lineTo(px, py) : c.moveTo(px, py);
  }
  c.closePath();
}

function lin(c, x0, y0, x1, y1, stops) {
  const g = c.createLinearGradient(x0, y0, x1, y1);
  stops.forEach((s, i) => (Array.isArray(s) ? g.addColorStop(s[0], s[1]) : g.addColorStop(i / (stops.length - 1), s)));
  return g;
}
const vgrad = (c, a, b) => lin(c, 0, 0, 0, 24, [a, b]);

// colours for both appearances: bg top/bottom and the glyph's own colour on a dark tile
const DARK_BG = ['#2e2e33', '#141417'];
const PAL = {
  phone: { bg: ['#65f27f', '#1fc443'], ink: ['#6cf386', '#25c74a'] },
  music: { bg: ['#ff5e78', '#fa1f3f'], ink: ['#ff6a82', '#fa2848'] },
  maps: { bg: null },
  messages: { bg: ['#65f27f', '#1fc443'], ink: ['#6cf386', '#25c74a'] },
  nowplaying: { bg: ['#ffffff', '#ececf0'] },
  podcasts: { bg: ['#d985ff', '#8a2fd8'], ink: ['#dd8cff', '#9a3ce6'] },
  audiobooks: { bg: ['#ffb84a', '#ff8000'], ink: ['#ffbe55', '#ff8a10'] },
  news: { bg: ['#ffffff', '#ececf0'] },
  calendar: { bg: ['#ffffff', '#ececf0'] },
  settings: { bg: ['#c6c9ce', '#83878e'] },
};

export const APPS = {
  phone: { label: 'Phone' }, music: { label: 'Music' }, maps: { label: 'Maps' }, messages: { label: 'Messages' },
  nowplaying: { label: 'Now Playing' }, podcasts: { label: 'Podcasts' }, audiobooks: { label: 'Audiobooks' },
  news: { label: 'News' }, calendar: { label: 'Calendar' }, settings: { label: 'Settings' },
};
// CarPlay's own default order
export const HOME_APPS = ['phone', 'music', 'maps', 'messages', 'nowplaying', 'podcasts', 'audiobooks', 'news', 'calendar', 'settings'];

const P = {}; // cached Path2Ds
const path = (k, d) => P[k] || (P[k] = new Path2D(d));

const GLYPHS = {
  phone(c, dark) {
    c.fillStyle = dark ? vgrad(c, ...PAL.phone.ink) : '#fff';
    c.translate(12, 12); c.scale(0.9, 0.9); c.translate(-12, -12);
    c.fill(path('handset', 'M6.4 3.6c.6-.4 1.4-.3 1.9.3l2.2 2.8c.5.6.5 1.5-.1 2.1l-1.3 1.3c-.3.3-.3.7-.1 1 1.2 2 2.9 3.7 4.9 4.9.3.2.8.2 1-.1l1.3-1.3c.6-.6 1.5-.6 2.1-.1l2.8 2.2c.6.5.7 1.3.3 1.9l-1 1.6c-.8 1.2-2.3 1.8-3.7 1.4C12.1 20.2 7.8 15.9 6.4 9.3 6 7.9 6.6 6.4 7.8 5.6z'));
  },
  music(c, dark) {
    c.fillStyle = dark ? vgrad(c, ...PAL.music.ink) : '#fff';
    c.fill(path('note', 'M9 6.8 18.6 4.6c.5-.1.9.2.9.7v10.4c0 1.7-1.5 3-3.3 3-1.5 0-2.6-.9-2.6-2.1 0-1.4 1.4-2.5 3.1-2.5.4 0 .8.1 1.2.2V8.6L10.6 10.3v7.6c0 1.7-1.5 3-3.3 3-1.5 0-2.6-.9-2.6-2.1 0-1.4 1.4-2.5 3.1-2.5.4 0 .8.1 1.2.2V7.5c0-.4.3-.6.6-.7z'));
  },
  messages(c, dark) {
    c.fillStyle = dark ? vgrad(c, ...PAL.messages.ink) : '#fff';
    c.fill(path('bubble', 'M12 4.2c4.9 0 8.8 3.2 8.8 7.2s-3.9 7.2-8.8 7.2c-.9 0-1.8-.1-2.6-.3-1.1.9-2.8 1.7-4.9 1.8.9-.8 1.5-1.8 1.7-2.8C4.3 16 3.2 13.8 3.2 11.4c0-4 3.9-7.2 8.8-7.2z'));
  },
  nowplaying(c) {
    const g = lin(c, 5, 0, 19, 0, ['#ff3b30', '#ff2d55', '#f74fa6']);
    c.fillStyle = g;
    [[6.1, 13.4], [8.9, 12.2], [11.7, 9.4], [14.5, 6.6], [17.3, 2.2]].forEach(([x, h]) => {
      const w = 1.75, y = 12 - h / 2;
      c.beginPath(); c.roundRect(x - w / 2, y, w, h, w / 2); c.fill();
    });
  },
  podcasts(c, dark) {
    const ink = dark ? vgrad(c, ...PAL.podcasts.ink) : '#fff';
    c.strokeStyle = ink; c.fillStyle = ink; c.lineCap = 'round';
    c.globalAlpha = dark ? 1 : 0.9;
    c.lineWidth = 1.55;
    c.beginPath(); c.arc(12, 10.4, 7.5, Math.PI * 0.78, Math.PI * 2.22); c.stroke();
    c.beginPath(); c.arc(12, 10.4, 4.6, Math.PI * 0.8, Math.PI * 2.2); c.stroke();
    c.globalAlpha = 1;
    c.beginPath(); c.arc(12, 10.4, 2.3, 0, TAU); c.fill();
    c.beginPath(); c.roundRect(10.65, 13.6, 2.7, 6.6, 1.35); c.fill();
  },
  audiobooks(c, dark) {
    c.fillStyle = dark ? '#b85a00' : '#e06a00';
    c.fill(path('cover', 'M12 8c-2.2-1.6-5.5-1.9-8.4-1V18.8c2.9-.9 6.2-.6 8.4 1 2.2-1.6 5.5-1.9 8.4-1V7c-2.9-.9-6.2-.6-8.4 1z'));
    c.fillStyle = dark ? lin(c, 0, 5, 0, 19, ['#ffc35c', '#ff9418']) : lin(c, 0, 5, 0, 19, ['#fffaf0', '#ffe6b8']);
    c.fill(path('pages', 'M11.6 7.1C9.6 5.6 6.8 5.3 4.4 6v11.6c2.4-.7 5.2-.4 7.2 1.1zM12.4 7.1c2-1.5 4.8-1.8 7.2-1.1v11.6c-2.4-.7-5.2-.4-7.2 1.1z'));
  },
  news(c, dark) {
    c.save();
    c.beginPath(); c.roundRect(4.6, 4.6, 14.8, 14.8, 3.3); c.clip();
    c.fillStyle = lin(c, 0, 4, 0, 20, ['#ff4b5c', '#f2203b']); c.fillRect(4, 4, 16, 16);
    c.strokeStyle = dark ? '#1f1f23' : '#fff'; c.lineWidth = 2.6; c.lineCap = 'butt';
    c.beginPath(); c.moveTo(4.4, 4.4); c.lineTo(19.6, 19.6); c.stroke();
    c.restore();
  },
  calendar(c, dark, now = new Date()) {
    c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.fillStyle = '#ff3b30'; c.font = `600 4.6px ${FAM}`;
    c.fillText(now.toLocaleDateString('en-US', { weekday: 'short' }), 12, 8.2);
    c.fillStyle = dark ? '#fff' : '#111'; c.font = `400 12.6px ${FAM}`;
    c.fillText(String(now.getDate()), 12, 19.6);
  },
  settings(c, dark) {
    const ink = dark ? '#8f9299' : '#3e4147';
    c.fillStyle = ink;
    c.beginPath(); c.arc(12, 12, 9.3, 0, TAU); c.fill();
    c.fillStyle = dark ? '#2a2a2e' : lin(c, 0, 3, 0, 21, ['#d4d7db', '#9a9ea5']);
    c.beginPath(); c.arc(12, 12, 8.1, 0, TAU); c.fill();
    c.strokeStyle = ink; c.lineWidth = 0.55;
    for (let i = 0; i < 48; i++) { const a = (i / 48) * TAU; c.beginPath(); c.moveTo(12 + Math.cos(a) * 6.9, 12 + Math.sin(a) * 6.9); c.lineTo(12 + Math.cos(a) * 8.1, 12 + Math.sin(a) * 8.1); c.stroke(); }
    c.lineWidth = 0.8; c.beginPath(); c.arc(12, 12, 6.6, 0, TAU); c.stroke();
    c.lineWidth = 0.95; c.lineCap = 'round';
    for (let i = 0; i < 3; i++) { // three swept spokes
      const a = -Math.PI / 2 + (i / 3) * TAU;
      c.beginPath(); c.moveTo(12 + Math.cos(a) * 2.2, 12 + Math.sin(a) * 2.2);
      c.quadraticCurveTo(12 + Math.cos(a + 0.5) * 4.6, 12 + Math.sin(a + 0.5) * 4.6, 12 + Math.cos(a + 0.35) * 6.5, 12 + Math.sin(a + 0.35) * 6.5); c.stroke();
    }
    c.fillStyle = ink; c.beginPath(); c.arc(12, 12, 2.5, 0, TAU); c.fill();
    c.fillStyle = dark ? '#2a2a2e' : '#c3c6cb'; c.beginPath(); c.arc(12, 12, 1.15, 0, TAU); c.fill();
  },
  maps(c, dark) {
    const L = dark
      ? { land: '#1f3b2a', park: '#2a5a3a', pink: '#6a3150', yellow: '#8a7420', road: '#52555c', ring: '#2f5a3f' }
      : { land: '#a7e59b', park: '#8fdc85', pink: '#f6a3c8', yellow: '#fbd648', road: '#ffffff', ring: '#c9f2c1' };
    c.fillStyle = L.land; c.fillRect(0, 0, 24, 24);
    c.strokeStyle = L.ring; c.lineWidth = 1.1;
    for (const r of [5, 7.6, 10.2]) { c.beginPath(); c.arc(24, 0, r, Math.PI / 2, Math.PI); c.stroke(); }
    c.fillStyle = L.pink; c.beginPath(); c.moveTo(0, 13.5); c.lineTo(8.5, 24); c.lineTo(0, 24); c.fill();
    c.strokeStyle = L.road; c.lineWidth = 2.4; c.beginPath(); c.moveTo(0, 12.5); c.lineTo(9.6, 24); c.stroke();
    c.strokeStyle = L.yellow; c.lineWidth = 4.2; c.beginPath(); c.moveTo(13, 24.5); c.lineTo(24.5, 15); c.stroke();
    c.strokeStyle = L.road; c.lineWidth = 0.7; c.beginPath(); c.moveTo(11.4, 24.5); c.lineTo(24.5, 13.6); c.stroke(); c.beginPath(); c.moveTo(14.6, 24.5); c.lineTo(24.5, 16.4); c.stroke();
    c.fillStyle = L.road; c.fillRect(9.1, -1, 5.8, 10);
    c.fillStyle = lin(c, 0, 0, 0, 10, ['#2f86ff', '#1f6ef2']); c.fillRect(9.8, -1, 4.4, 10);
    // the location puck
    c.save(); c.shadowColor = 'rgba(0,0,0,.28)'; c.shadowBlur = 1.2; c.shadowOffsetY = 0.5;
    c.fillStyle = '#fff'; c.beginPath(); c.arc(12, 13.4, 5.6, 0, TAU); c.fill(); c.restore();
    c.fillStyle = lin(c, 0, 9, 0, 18, ['#4aa6ff', '#1766ef']); c.beginPath(); c.arc(12, 13.4, 4.5, 0, TAU); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.moveTo(12, 10.1); c.lineTo(14.9, 16.3); c.lineTo(12, 15); c.lineTo(9.1, 16.3); c.closePath(); c.fill();
  },
};

// The whole tile at x, y with side s. dark = the Dark icon appearance.
export function paintApp(c, name, x, y, s, { dark = false, now } = {}) {
  c.save();
  c.translate(x, y);
  // soft drop shadow under the tile
  c.save(); c.shadowColor = 'rgba(0,0,0,.35)'; c.shadowBlur = s * 0.06; c.shadowOffsetY = s * 0.02;
  squircle(c, 0, 0, s); c.fillStyle = '#000'; c.fill(); c.restore();
  squircle(c, 0, 0, s);
  c.save(); c.clip();
  c.scale(s / 24, s / 24);
  const pal = PAL[name];
  if (name === 'maps') GLYPHS.maps(c, dark);
  else {
    c.fillStyle = vgrad(c, ...(dark ? DARK_BG : pal.bg)); c.fillRect(0, 0, 24, 24);
    GLYPHS[name](c, dark, now);
  }
  // glass: a sheen at the top and a lit rim, brighter top-left
  c.fillStyle = lin(c, 0, 0, 0, 12, ['rgba(255,255,255,.16)', 'rgba(255,255,255,0)']);
  c.fillRect(0, 0, 24, 12);
  c.restore();
  squircle(c, s * 0.012, s * 0.012, s * 0.976);
  c.lineWidth = Math.max(0.8, s * 0.022);
  c.strokeStyle = lin(c, 0, 0, s, s, [[0, 'rgba(255,255,255,.75)'], [0.38, 'rgba(255,255,255,.08)'], [0.7, 'rgba(255,255,255,.04)'], [1, 'rgba(255,255,255,.4)']]);
  c.stroke();
  c.restore();
}

// ---------- UI glyphs (canvas, at x, y in a box of side s) ----------

export const glyph = {
  play(c, x, y, s, col = '#fff') { c.fillStyle = col; c.beginPath(); c.moveTo(x + s * 0.24, y + s * 0.14); c.lineTo(x + s * 0.88, y + s * 0.5); c.lineTo(x + s * 0.24, y + s * 0.86); c.closePath(); rnd(c, s); c.fill(); },
  pause(c, x, y, s, col = '#fff') { c.fillStyle = col; for (const dx of [0.2, 0.58]) { c.beginPath(); c.roundRect(x + s * dx, y + s * 0.14, s * 0.22, s * 0.72, s * 0.06); c.fill(); } },
  next(c, x, y, s, col = '#fff') { c.fillStyle = col; for (const dx of [0.06, 0.5]) { c.beginPath(); c.moveTo(x + s * dx, y + s * 0.2); c.lineTo(x + s * (dx + 0.46), y + s * 0.5); c.lineTo(x + s * dx, y + s * 0.8); c.closePath(); rnd(c, s); c.fill(); } },
  prev(c, x, y, s, col = '#fff') { c.fillStyle = col; for (const dx of [0.94, 0.5]) { c.beginPath(); c.moveTo(x + s * dx, y + s * 0.2); c.lineTo(x + s * (dx - 0.46), y + s * 0.5); c.lineTo(x + s * dx, y + s * 0.8); c.closePath(); rnd(c, s); c.fill(); } },
  // turn arrows: dir +1 right, -1 left, 0 straight
  turn(c, x, y, s, dir, col = '#fff') {
    c.save(); c.translate(x, y); c.scale(s / 24, s / 24);
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = 2.9; c.lineCap = 'round'; c.lineJoin = 'round';
    if (!dir) { c.beginPath(); c.moveTo(12, 21); c.lineTo(12, 8); c.stroke(); c.beginPath(); c.moveTo(12, 2.5); c.lineTo(17.5, 9.5); c.lineTo(6.5, 9.5); c.closePath(); c.fill(); }
    else {
      c.scale(dir, 1); c.translate(dir < 0 ? -24 : 0, 0);
      c.beginPath(); c.moveTo(7, 21.5); c.lineTo(7, 13.5); c.quadraticCurveTo(7, 9.5, 11, 9.5); c.lineTo(15, 9.5); c.stroke();
      c.beginPath(); c.moveTo(21.5, 9.5); c.lineTo(14.5, 3.8); c.lineTo(14.5, 15.2); c.closePath(); c.fill();
    }
    c.restore();
  },
  // sidebar buttons: rounded square (to the Dashboard) and the 3 × 3 app grid (to the apps)
  dashBtn(c, x, y, s, col = '#fff') { c.strokeStyle = col; c.lineWidth = s * 0.09; c.beginPath(); c.roundRect(x + s * 0.2, y + s * 0.2, s * 0.6, s * 0.6, s * 0.14); c.stroke(); },
  gridBtn(c, x, y, s, col = '#fff') { c.fillStyle = col; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { c.beginPath(); c.arc(x + s * (0.27 + i * 0.23), y + s * (0.27 + j * 0.23), s * 0.075, 0, TAU); c.fill(); } },
  // the gravity menu button: an arrow falling onto a line
  gravity(c, x, y, s, col = '#fff') {
    c.save(); c.translate(x, y); c.scale(s / 24, s / 24);
    c.strokeStyle = c.fillStyle = col; c.lineWidth = 2.2; c.lineCap = 'round';
    c.beginPath(); c.moveTo(12, 3.5); c.lineTo(12, 12.5); c.stroke();
    c.beginPath(); c.moveTo(7.6, 11); c.lineTo(12, 16.2); c.lineTo(16.4, 11); c.closePath(); c.fill();
    c.beginPath(); c.moveTo(5, 20.2); c.lineTo(19, 20.2); c.stroke();
    c.restore();
  },
  close(c, x, y, s, col = '#fff') { c.strokeStyle = col; c.lineWidth = s * 0.11; c.lineCap = 'round'; c.beginPath(); c.moveTo(x + s * 0.3, y + s * 0.3); c.lineTo(x + s * 0.7, y + s * 0.7); c.moveTo(x + s * 0.7, y + s * 0.3); c.lineTo(x + s * 0.3, y + s * 0.7); c.stroke(); },
};
function rnd(c, s) { c.lineJoin = 'round'; c.lineWidth = s * 0.08; c.strokeStyle = c.fillStyle; c.stroke(); }

// SVG glyphs still used for the cluster's warning lamps and a few widget icons (drawn as images)
const svg = (body, vb = '0 0 24 24') => `<svg viewBox="${vb}" aria-hidden="true">${body}</svg>`;
const S = ({ c = '#fff', w = 1.8 } = {}) => `fill="none" stroke="${c}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
export const GLYPH = {
  sigL: svg(`<path d="M2 12 11 4v5h11v6H11v5z" fill="currentColor"/>`),
  sigR: svg(`<path d="M22 12 13 4v5H2v6h11v5z" fill="currentColor"/>`),
  beam: svg(`<path d="M10 6c-4 0-6 2.7-6 6s2 6 6 6c1.3 0 2-2.7 2-6s-.7-6-2-6zM15 7.5h6M15 10.5h6M15 13.5h6M15 16.5h6" ${S({ c: 'currentColor' })}/>`),
  belt: svg(`<circle cx="12" cy="5" r="2.2" fill="currentColor"/><path d="M8 21v-7l-1-5h10l-1 5v7M9 9l7 8" ${S({ c: 'currentColor' })}/>`),
  tyre: svg(`<path d="M6 5c-1.5 2-2.3 4.4-2.3 7S4.5 17 6 19M18 5c1.5 2 2.3 4.4 2.3 7S19.5 17 18 19M12 7v6M12 16v1" ${S({ c: 'currentColor', w: 2 })}/>`),
  fuel: svg(`<path d="M5 20V5a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 14 5v15M4 20h11M14 9h2a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 0 3 0V8l-3-3M7 7h5" ${S({ c: 'currentColor' })}/>`),
  temp: svg(`<path d="M12 3v11M9.5 6.5h-2M9.5 10h-2" ${S({ c: 'currentColor' })}/><circle cx="12" cy="17" r="3.2" fill="currentColor"/><path d="M4 21c1.5-1 2.5-1 4 0s2.5 1 4 0 2.5-1 4 0 2.5 1 4 0" ${S({ c: 'currentColor', w: 1.4 })}/>`),
};

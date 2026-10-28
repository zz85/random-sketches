// App tiles: a background and a white glyph each (drawn here, not Apple's artwork).
const svg = (body, vb = '0 0 24 24') => `<svg viewBox="${vb}" aria-hidden="true">${body}</svg>`;
const S = 'fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';

export const APPS = {
  maps: { label: 'Maps', bg: 'linear-gradient(150deg,#7ee08a,#2fb35a 45%,#2a8cf0 46%,#1f6fd8)', glyph: svg(`<path d="M12 3.5 19 20l-7-3.6L5 20z" fill="#fff"/>`) },
  music: { label: 'Music', bg: 'linear-gradient(160deg,#ff6e86,#f2304f)', glyph: svg(`<path d="M9 17.5V6l10-2v11.5" ${S}/><circle cx="6.8" cy="17.5" r="2.3" fill="#fff"/><circle cx="16.8" cy="15.5" r="2.3" fill="#fff"/>`) },
  podcasts: { label: 'Podcasts', bg: 'linear-gradient(160deg,#d27bff,#8a2ee0)', glyph: svg(`<circle cx="12" cy="10" r="2.2" fill="#fff"/><path d="M11 14h2l-.4 7h-1.2z" fill="#fff"/><path d="M8 14.2a5.5 5.5 0 1 1 8 0M5.4 16.8a9 9 0 1 1 13.2 0" ${S}/>`) },
  phone: { label: 'Phone', bg: 'linear-gradient(160deg,#6cf08a,#22c24a)', glyph: svg(`<path d="M6.6 3.5h2.6l1.5 4.2-2 1.4a10.5 10.5 0 0 0 6.2 6.2l1.4-2 4.2 1.5v2.6a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z" fill="#fff"/>`) },
  messages: { label: 'Messages', bg: 'linear-gradient(160deg,#6cf08a,#22c24a)', glyph: svg(`<path d="M12 4c4.7 0 8.5 3 8.5 6.9S16.7 17.8 12 17.8c-.9 0-1.8-.1-2.6-.3L5 19.6l1.3-3.6C4.5 14.7 3.5 12.9 3.5 10.9 3.5 7 7.3 4 12 4z" fill="#fff"/>`) },
  audiobooks: { label: 'Audiobooks', bg: 'linear-gradient(160deg,#ffb257,#ff7a1a)', glyph: svg(`<path d="M4 6.5c2.8-1.2 5.5-1.2 8 .5 2.5-1.7 5.2-1.7 8-.5v11c-2.8-1.2-5.5-1.2-8 .5-2.5-1.7-5.2-1.7-8-.5z M12 7v11" ${S}/>`) },
  calendar: { label: 'Calendar', bg: '#fff', glyph: '' }, // filled in with today's date
  news: { label: 'News', bg: 'linear-gradient(160deg,#ff5b6b,#e8192e)', glyph: svg(`<path d="M5 5h3.2l7.6 9.5V5H19v14h-3.2L8.2 9.5V19H5z" fill="#fff"/>`) },
  weather: { label: 'Weather', bg: 'linear-gradient(170deg,#4aa8ff,#1d6fe0)', glyph: svg(`<circle cx="9" cy="9" r="3.4" fill="#ffd84a"/><path d="M9 2.5v1.6M9 13.9v1.6M2.5 9h1.6M13.9 9h1.6M4.4 4.4l1.1 1.1M12.5 12.5l1.1 1.1M4.4 13.6l1.1-1.1M12.5 5.5l1.1-1.1" stroke="#ffd84a" stroke-width="1.5" stroke-linecap="round"/><path d="M8.5 19.5h9a3.3 3.3 0 0 0 .3-6.6 4.6 4.6 0 0 0-8.7 1.2 2.7 2.7 0 0 0-.6 5.4z" fill="#fff"/>`) },
  settings: { label: 'Settings', bg: 'linear-gradient(160deg,#a9adb5,#6f747d)', glyph: svg(`<circle cx="12" cy="12" r="6.3" fill="none" stroke="#fff" stroke-width="3.4" stroke-dasharray="2.4 2.55"/><circle cx="12" cy="12" r="5" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="12" r="1.9" fill="#fff"/>`) },
};

export const HOME_APPS = ['maps', 'music', 'podcasts', 'phone', 'messages', 'audiobooks', 'calendar', 'news', 'weather', 'settings'];

export function tileInner(name, now = new Date()) {
  if (name === 'calendar') {
    const day = now.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
    return `<div class="cal"><b>${day}</b><span>${now.getDate()}</span></div>`;
  }
  return APPS[name].glyph;
}

export const GLYPH = {
  play: svg(`<path d="M7 4.5v15l12.5-7.5z" fill="#fff"/>`),
  pause: svg(`<rect x="6" y="4.5" width="4" height="15" rx="1" fill="#fff"/><rect x="14" y="4.5" width="4" height="15" rx="1" fill="#fff"/>`),
  next: svg(`<path d="M3.5 6v12l8-6zM12 6v12l8-6z" fill="#fff"/>`),
  prev: svg(`<path d="M20.5 6v12l-8-6zM12 6v12l-8-6z" fill="#fff"/>`),
  grid: svg(`<g fill="#fff"><rect x="4" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8"/></g>`),
  dash: svg(`<g fill="#fff"><rect x="3.5" y="4" width="9.5" height="16" rx="2"/><rect x="15" y="4" width="5.5" height="7" rx="1.8"/><rect x="15" y="13" width="5.5" height="7" rx="1.8"/></g>`),
  right: svg(`<path d="M6 21v-8a4 4 0 0 1 4-4h8" ${S} stroke-width="2.6"/><path d="M14.5 4.5 19 9l-4.5 4.5" ${S} stroke-width="2.6"/>`),
  left: svg(`<path d="M18 21v-8a4 4 0 0 0-4-4H6" ${S} stroke-width="2.6"/><path d="M9.5 4.5 5 9l4.5 4.5" ${S} stroke-width="2.6"/>`),
  straight: svg(`<path d="M12 21V5M6.5 10 12 4.5 17.5 10" ${S} stroke-width="2.6"/>`),
  sigL: svg(`<path d="M2 12 11 4v5h11v6H11v5z" fill="currentColor"/>`),
  sigR: svg(`<path d="M22 12 13 4v5H2v6h11v5z" fill="currentColor"/>`),
  beam: svg(`<path d="M10 6c-4 0-6 2.7-6 6s2 6 6 6c1.3 0 2-2.7 2-6s-.7-6-2-6zM15 7.5h6M15 10.5h6M15 13.5h6M15 16.5h6" ${S} stroke="currentColor"/>`),
  belt: svg(`<circle cx="12" cy="5" r="2.2" fill="currentColor"/><path d="M8 21v-7l-1-5h10l-1 5v7M9 9l7 8" ${S} stroke="currentColor"/>`),
  tyre: svg(`<path d="M6 5c-1.5 2-2.3 4.4-2.3 7S4.5 17 6 19M18 5c1.5 2 2.3 4.4 2.3 7S19.5 17 18 19M12 7v6M12 16v1" ${S} stroke="currentColor" stroke-width="2"/>`),
  fuel: svg(`<path d="M5 20V5a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 14 5v15M4 20h11M14 9h2a1.5 1.5 0 0 1 1.5 1.5V16a1.5 1.5 0 0 0 3 0V8l-3-3M7 7h5" ${S} stroke="currentColor"/>`),
  temp: svg(`<path d="M12 3v11M9.5 6.5h-2M9.5 10h-2" ${S} stroke="currentColor"/><circle cx="12" cy="17" r="3.2" fill="currentColor"/><path d="M4 21c1.5-1 2.5-1 4 0s2.5 1 4 0 2.5-1 4 0 2.5 1 4 0" ${S} stroke="currentColor" stroke-width="1.4"/>`),
  rain: svg(`<path d="M7.5 15h10a3.5 3.5 0 0 0 .3-7 5 5 0 0 0-9.5 1.3A2.9 2.9 0 0 0 7.5 15z" fill="#fff"/><path d="M9 18l-1 2.5M13 18l-1 2.5M17 18l-1 2.5" stroke="#8cc8ff" stroke-width="1.6" stroke-linecap="round"/>`),
  cal: svg(`<rect x="3.5" y="5" width="17" height="15" rx="2.5" ${S}/><path d="M3.5 10h17M8 3v4M16 3v4" ${S}/>`),
};

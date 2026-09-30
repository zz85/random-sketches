// Canvas renderer for a layout (layout.js). SMuFL glyphs are drawn with fillText in
// Bravura or Petaluma at font-size = 4 staff spaces (the SMuFL em).
import { SMUFL } from './smufl.js';
import { keySigPositions } from './theory.js';
import { yOf, CLEF_GLYPH, glyphW, timeScale } from './layout.js';

const CP = SMUFL.codepoints;
const ch = (name) => String.fromCodePoint(CP[name]);

export const THEME = {
  paper: '#fbf8f1', ink: '#1d1c1a', staff: '#3b3833', faint: 'rgba(40,35,30,0.35)',
  select: '#2563eb', play: '#e2572b', over: 'rgba(214,52,52,0.09)', under: 'rgba(230,160,20,0.10)', title: '#2b2926',
};

/**
 * @param g     CanvasRenderingContext2D (already scaled for devicePixelRatio)
 * @param L     layout
 * @param view  { scale: px per sp, scrollY: sp, width: px, height: px, title, font }
 * @param st    { selected:Set, playing:Set, flash:Map(id->alpha) }
 */
export function renderScore(g, L, view, st = {}) {
  const S = view.scale, oy = view.scrollY;
  const X = (x) => x * S, Y = (y) => (y - oy) * S;
  const M = L.M, ED = L.ED;
  const selected = st.selected || new Set(), playing = st.playing || new Set();
  g.fillStyle = THEME.paper; g.fillRect(0, 0, view.width, view.height);
  g.textBaseline = 'alphabetic'; g.textAlign = 'left';
  const musicFont = `${4 * S}px ${L.font}`;
  const glyph = (name, x, y, color) => { g.fillStyle = color || THEME.ink; g.fillText(ch(name), X(x), Y(y)); };
  const hline = (x0, x1, y, w, color) => { g.fillStyle = color || THEME.staff; g.fillRect(X(x0), Y(y) - (w * S) / 2, (x1 - x0) * S, Math.max(1, w * S)); };
  const vline = (x, y0, y1, w, color) => { g.fillStyle = color || THEME.ink; g.fillRect(X(x) - Math.max(1, w * S) / 2, Y(y0), Math.max(1, w * S), (y1 - y0) * S); };

  if (view.title && Y(0) > -60) {
    g.fillStyle = THEME.title; g.textAlign = 'center';
    g.font = `italic ${Math.round(2.1 * S)}px Georgia, 'Times New Roman', serif`;
    g.fillText(view.title, view.width / 2, Y(3.6));
    g.textAlign = 'left';
  }
  const vis0 = oy - 8, vis1 = oy + view.height / S + 8;
  const lastMi = L.measures.length - 1;

  for (const sys of L.systems) {
    const top0 = sys.staffTops[0], bot = sys.staffTops[sys.staffTops.length - 1] + 4;
    if (bot < vis0 || top0 > vis1) continue;
    // bar tints first (under everything)
    for (const m of sys.measures) {
      m.fill.forEach((f, si) => {
        const t = sys.staffTops[si];
        if (f.over) { g.fillStyle = THEME.over; g.fillRect(X(m.x0), Y(t - 1), (m.x1 - m.x0) * S, 6 * S); }
        else if (f.used > 0 && f.used < f.cap && m.mi !== lastMi) { g.fillStyle = THEME.under; g.fillRect(X(m.reserveX), Y(t), (m.x1 - m.reserveX - 0.3) * S, 4 * S); }
      });
    }
    // staff lines
    for (const t of sys.staffTops) for (let l = 0; l < 5; l++) hline(sys.x0, sys.x1, t + l, ED.staffLineThickness);
    // system line + bracket for grand staff
    vline(sys.x0, top0, bot, ED.thinBarlineThickness);
    if (sys.staffTops.length > 1) { g.fillStyle = THEME.ink; g.fillRect(X(sys.x0 - 0.9), Y(top0), 0.35 * S, (bot - top0) * S); g.fillRect(X(sys.x0 - 0.9), Y(top0) - 0.15 * S, 0.9 * S, 0.3 * S); g.fillRect(X(sys.x0 - 0.9), Y(bot) - 0.15 * S, 0.9 * S, 0.3 * S); }
    g.font = musicFont;
    // system header: clef, key, time
    const a = sys.a;
    sys.staffTops.forEach((t, si) => {
      const [cg, cpos] = CLEF_GLYPH[a.clefs[si]];
      glyph(cg, sys.x0 + 0.6, yOf(t, cpos));
      let x = sys.x0 + 0.6 + sys.clefW;
      x = drawKey(glyph, M, a.key, a.clefs[si], x, t);
      if (sys.showTime) drawTime(glyph, M, a.time, a.timeSym, sys.x0 + 0.6 + sys.clefW + sys.keyW, t, g, S, L.font);
    });
    // measure number
    g.font = `${Math.round(1.1 * S)}px Georgia, serif`; g.fillStyle = THEME.faint;
    g.fillText(String(sys.measures[0].mi + 1), X(sys.x0), Y(top0 - 1.6));
    g.font = musicFont;
    for (const m of sys.measures) {
      // mid-system attribute changes
      if (m.showHeader) {
        let x = m.x0 + 0.6;
        sys.staffTops.forEach((t, si) => {
          let xx = x;
          if (m.a.changed.clefs[si]) { const [cg, cpos] = CLEF_GLYPH[m.a.clefs[si]]; g.font = `${3 * S}px ${L.font}`; glyph(cg, xx, yOf(t, cpos)); g.font = musicFont; }
          if (m.a.changed.clefs.some(Boolean)) xx += 3;
          if (m.a.changed.key) xx = drawKey(glyph, M, m.a.key, m.a.clefs[si], xx, t, true);
          if (m.a.changed.time) drawTime(glyph, M, m.a.time, m.a.timeSym, xx, t, g, S, L.font);
        });
      }
      // barline (the open end of the paper is dashed)
      if (m.mi === lastMi) {
        g.fillStyle = THEME.faint;
        for (let y = top0; y < bot; y += 0.8) g.fillRect(X(m.x1) - 0.5, Y(y), 1, 0.45 * S);
      } else vline(m.x1, top0, bot, ED.thinBarlineThickness);
    }
  }

  // events
  g.font = musicFont;
  for (const [id, p] of L.evPos) {
    const sys = L.systems[p.sys];
    if (sys.staffTops[0] - 8 > vis1 || sys.staffTops[sys.staffTops.length - 1] + 12 < vis0) continue;
    const color = playing.has(id) ? THEME.play : selected.has(id) ? THEME.select : THEME.ink;
    if (p.kind === 'rest') {
      glyph(p.rest.glyph, p.rest.x, p.rest.y, color);
      for (const d of p.dots) glyph('augmentationDot', d.x, d.y, color);
      continue;
    }
    for (const l of p.ledgers) hline(l.x0, l.x1, l.y, ED.legerLineThickness, color);
    for (const h of p.heads) {
      glyph(h.glyph, h.x, h.y, color);
      if (h.acc) glyph(h.acc.glyph, h.acc.x, h.acc.y, color);
    }
    for (const d of p.dots) glyph('augmentationDot', d.x, d.y, color);
    if (p.stem) vline(p.stem.x, Math.min(p.stem.y0, p.stem.y1), Math.max(p.stem.y0, p.stem.y1), ED.stemThickness, color);
    if (p.flag) glyph(p.flag.glyph, p.flag.x, p.flag.y, color);
    if (p.stacc) glyph(p.stemUp ? 'articStaccatoBelow' : 'articStaccatoAbove', p.stacc.x, p.stacc.y, color);
  }
  // beams
  for (const b of L.beams) {
    const color = b.ids.some((i) => playing.has(i)) ? THEME.play : b.ids.some((i) => selected.has(i)) ? THEME.select : THEME.ink;
    g.fillStyle = color;
    for (const s of b.segs) {
      const t = b.thickness * (s.up ? 1 : -1);
      g.beginPath(); g.moveTo(X(s.x0), Y(s.y0)); g.lineTo(X(s.x1), Y(s.y1)); g.lineTo(X(s.x1), Y(s.y1 + t)); g.lineTo(X(s.x0), Y(s.y0 + t)); g.closePath(); g.fill();
    }
  }
  // tuplets: number (and bracket when the group is not one beam)
  for (const t of L.tuplets || []) {
    const color = t.ids.some((i) => playing.has(i)) ? THEME.play : t.ids.some((i) => selected.has(i)) ? THEME.select : THEME.ink;
    const digits = String(t.n).split('').map((d) => 'tuplet' + d);
    const w = digits.reduce((a, g) => a + glyphW(M, g), 0), cx = (t.x0 + t.x1) / 2;
    g.font = `${3.2 * S}px ${L.font}`;
    let x = cx - w * 0.8 / 2;
    for (const d of digits) { glyph(d, x, t.y + 0.6, color); x += glyphW(M, d) * 0.8; }
    g.font = musicFont;
    if (t.bracket) {
      const th = ED.tupletBracketThickness || 0.16, hook = t.up ? 0.6 : -0.6, gap = w * 0.4 + 0.35;
      hline(t.x0, cx - gap, t.y, th, color); hline(cx + gap, t.x1, t.y, th, color);
      vline(t.x0, Math.min(t.y, t.y + hook), Math.max(t.y, t.y + hook), th, color);
      vline(t.x1, Math.min(t.y, t.y + hook), Math.max(t.y, t.y + hook), th, color);
    }
  }
  // dynamics and hairpins
  for (const d of L.dynamics || []) {
    const color = playing.has(d.id) ? THEME.play : selected.has(d.id) ? THEME.select : THEME.ink;
    let x = d.x;
    for (const gname of d.letters) { glyph(gname, x, d.y, color); x += (M.glyphs[gname] ? M.glyphs[gname].adv : 1) * 0.92; }
  }
  g.strokeStyle = THEME.ink; g.lineWidth = Math.max(1, (ED.hairpinThickness || 0.16) * S); g.lineCap = 'round';
  for (const h of L.hairpins || []) {
    const open = 0.65, cresc = h.type === 'cresc';
    // a hairpin broken across systems does not close to a point at the break
    const a0 = cresc ? (h.cut === 'start' ? open * 0.45 : 0) : (h.cut === 'start' ? open * 0.55 : open);
    const a1 = cresc ? (h.cut === 'end' ? open * 0.55 : open) : (h.cut === 'end' ? open * 0.45 : 0);
    g.beginPath();
    g.moveTo(X(h.x0), Y(h.y - a0)); g.lineTo(X(h.x1), Y(h.y - a1));
    g.moveTo(X(h.x0), Y(h.y + a0)); g.lineTo(X(h.x1), Y(h.y + a1));
    g.stroke();
  }
  // ties and slurs: crescents, thick in the middle
  g.fillStyle = THEME.ink;
  for (const t of L.ties) curve(g, X, Y, t.x0, t.y, t.x1, t.y, t.up, Math.min(1.2, 0.35 + 0.12 * (t.x1 - t.x0)), ED.tieMidpointThickness);
  for (const s of L.slurs) curve(g, X, Y, s.x0, s.y0, s.x1, s.y1, s.up, Math.min(2.2, 0.6 + 0.12 * (s.x1 - s.x0)), ED.slurMidpointThickness);
}

function drawKey(glyph, M, key, clef, x, t, cancelGap) {
  if (!key) return x;
  const name = key > 0 ? 'accidentalSharp' : 'accidentalFlat';
  for (const p of keySigPositions(key, clef)) { glyph(name, x, yOf(t, p)); x += glyphW(M, name) + 0.1; }
  return x + 0.5;
}

function drawTime(glyph, M, time, sym, x, t, g, S, font) {
  const k = timeScale(M);
  const prev = g.font;
  if (k !== 1) g.font = `${4 * S * k}px ${font}`;
  if (sym === 'common' || sym === 'cut') glyph(sym === 'common' ? 'timeSigCommon' : 'timeSigCutCommon', x, yOf(t, 4));
  else {
    const width = (n) => String(n).split('').reduce((s, d) => s + glyphW(M, 'timeSig' + d), 0) * k;
    const w = Math.max(width(time[0]), width(time[1]));
    [[time[0], 6], [time[1], 2]].forEach(([n, pos]) => {
      let xx = x + (w - width(n)) / 2;
      for (const d of String(n)) { glyph('timeSig' + d, xx, yOf(t, pos)); xx += glyphW(M, 'timeSig' + d) * k; }
    });
  }
  g.font = prev;
}

function curve(g, X, Y, x0, y0, x1, y1, up, h, thick) {
  const s = up ? -1 : 1, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  g.beginPath();
  g.moveTo(X(x0), Y(y0));
  g.bezierCurveTo(X(x0 + (mx - x0) * 0.4), Y(y0 + s * h), X(x1 - (x1 - mx) * 0.4), Y(y1 + s * h), X(x1), Y(y1));
  g.bezierCurveTo(X(x1 - (x1 - mx) * 0.4), Y(y1 + s * (h - thick)), X(x0 + (mx - x0) * 0.4), Y(y0 + s * (h - thick)), X(x0), Y(y0));
  g.fill();
}

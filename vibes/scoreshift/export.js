// MusicXML 4.0 and Standard MIDI File export, and the note list for playback, from the score
// built by score.js. Two versions of the music: as written on the page, or transposed by a
// plan from render.js (pitches, key and clef per staff for the target instrument). Either way
// the part carries <transpose> for its instrument so notation apps play it at concert pitch.
import { evTicks, timeline } from './score.js';
import { midiOf } from './theory.js';

const DIVS = 480; // per quarter: 96 ticks x 5, so 3-, 5- and 6-tuplets are whole numbers
const TYPE = { 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd', 64: '64th' };
const ACC = { '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' };
const CLEF_XML = { treble: ['G', 2], treble8vb: ['G', 2, -1], bass: ['F', 4], alto: ['C', 3], tenor: ['C', 4] };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * How each note is written in the chosen version: Map(note -> { pitch, acc }), plus per-staff
 * clef id and fifths. `plan` null = as on the page.
 */
function writing(model, plan) {
  const notes = new Map(), staves = new Map();
  for (const st of model.staves) {
    const sp = plan?.staves[st.index];
    staves.set(st, sp ? { clef: sp.clefId, fifths: sp.fifths } : { clef: st.clef.type, fifths: st.key.fifths });
    st.notes.forEach((n, i) => {
      if (sp) { const q = sp.notes[i]; notes.set(n, { pitch: q.pitch, acc: q.acc }); }
      else notes.set(n, { pitch: n.pitch, acc: n.accid ? n.accid.type : null });
    });
  }
  return { notes, staves };
}

/** Ties as sounding links: Map(note -> the note it continues into). */
function tieLinks(part, W) {
  const links = new Map(), open = new Map(); // midi -> note waiting for its continuation
  for (const { e } of timeline(part)) {
    if (e.kind !== 'note' || e.grace) { if (e.kind === 'rest') open.clear(); continue; }
    const next = new Map();
    for (const n of e.notes) {
      const m = midiOf(W.notes.get(n).pitch);
      if (open.has(m)) links.set(open.get(m), n);
      if (e.tie) next.set(m, n);
    }
    open.clear(); for (const [k, v] of next) open.set(k, v);
  }
  return links;
}

const DYN_TAG = Object.fromEntries(['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sf', 'sfz', 'sfp', 'fz', 'fp', 'rf', 'rfz', 'sffz'].map((d) => [d, d]));
export function toMusicXML(model, score, { plan = null, instrument = null, title = 'Score' } = {}) {
  const emitted = new Set();
  const W = writing(model, plan);
  const out = ['<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">', `<work><work-title>${esc(title)}</work-title></work>`,
    '<identification><encoding><software>ScoreShift</software></encoding></identification>', '<part-list>'];
  const name = instrument?.name?.replace(/ \(.*\)$/, '') || 'Part';
  score.parts.forEach((p, i) => out.push(`<score-part id="P${i + 1}"><part-name>${esc(score.parts.length > 1 ? `${name} ${i + 1}` : name)}</part-name></score-part>`));
  out.push('</part-list>');
  for (const part of score.parts) {
    out.push(`<part id="P${part.index + 1}">`);
    const links = tieLinks(part, W), tiedFrom = new Set(links.values());
    let cur = { clef: null, fifths: null, time: null }, number = 0;
    part.measures.forEach((m, mi) => {
      const pickup = mi === 0 && m.status === 'pickup';
      number += pickup ? 0 : 1;
      out.push(`<measure number="${pickup ? 0 : number}"${pickup ? ' implicit="yes"' : ''}>`);
      if (mi > 0 && m.st !== part.measures[mi - 1].st) out.push('<print new-system="yes"/>');
      const sw = W.staves.get(m.st), attrs = [];
      if (mi === 0) attrs.push(`<divisions>${DIVS}</divisions>`);
      const sp = plan?.staves[m.st.index], kf = sp ? (sp.changes.filter((k) => k.x0 <= m.x0 + 1).pop()?.fifths ?? sw.fifths) : m.fifths ?? sw.fifths;
      if (kf !== cur.fifths) attrs.push(`<key><fifths>${kf}</fifths></key>`);
      const t = m.time, tk = t ? `${t.beats}/${t.unit}${t.sym || ''}` : null;
      if (t && tk !== cur.time) attrs.push(`<time${t.sym ? ` symbol="${t.sym}"` : ''}><beats>${t.beats}</beats><beat-type>${t.unit}</beat-type></time>`);
      if (sw.clef !== cur.clef) { const c = CLEF_XML[sw.clef]; attrs.push(`<clef><sign>${c[0]}</sign><line>${c[1]}</line>${c[2] ? `<clef-octave-change>${c[2]}</clef-octave-change>` : ''}</clef>`); }
      if (mi === 0 && instrument && (instrument.dd || instrument.ds)) attrs.push(`<transpose><diatonic>${instrument.dd}</diatonic><chromatic>${instrument.ds}</chromatic></transpose>`);
      if (attrs.length) out.push(`<attributes>${attrs.join('')}</attributes>`);
      cur = { clef: sw.clef, fifths: kf, time: tk ?? cur.time };
      // voices: voice 1, then back to the start of the bar for voice 2 (<backup>), each note
      // tagged with its voice and, with two voices, its stem direction
      const nv = Math.max(1, ...m.events.map((e) => (e.voice ?? 0) + 1));
      const vEvents = Array.from({ length: nv }, (_, v) => m.events.filter((e) => (e.voice ?? 0) === v && !e.removed));
      for (const [v, evs] of vEvents.entries()) {
      if (v > 0) { const back = vEvents[v - 1].reduce((q, e) => q + Math.round(evTicks(e) * 5), 0); if (back) out.push(`<backup><duration>${back}</duration></backup>`); }
      const VO = `<voice>${v + 1}</voice>`, STEM = nv > 1 ? `<stem>${v ? 'down' : 'up'}</stem>` : '';
      for (const e of evs) {
        const dur = Math.round(evTicks(e) * 5);
        // dynamics and hairpins starting / ending here (voice 1 only, below the staff)
        for (const n of e.notes || []) {
          const d = (m.st.dynamics || []).find((q) => q.note === n);
          if (d && !emitted.has(d)) { emitted.add(d); out.push(`<direction placement="${d.below ? 'below' : 'above'}"><direction-type><dynamics><${DYN_TAG[d.text] || 'other-dynamics'}${DYN_TAG[d.text] ? '/>' : `>${esc(d.text)}</other-dynamics>`}</dynamics></direction-type><voice>${v + 1}</voice></direction>`); }
          for (const hp of m.st.hairpins || []) {
            if (hp.from === n && !emitted.has(hp)) { emitted.add(hp); out.push(`<direction placement="below"><direction-type><wedge type="${hp.form === 'cresc' ? 'crescendo' : 'diminuendo'}"/></direction-type><voice>${v + 1}</voice></direction>`); if (!hp.to || hp.to === n) out.push('<direction><direction-type><wedge type="stop"/></direction-type></direction>'); }
            else if (hp.to === n && hp.from !== n && !emitted.has(hp.to)) { emitted.add(hp.to); out.push('<direction><direction-type><wedge type="stop"/></direction-type></direction>'); }
          }
        }
        const tm = e.tuplet ? `<time-modification><actual-notes>${e.tuplet[0]}</actual-notes><normal-notes>${e.tuplet[1]}</normal-notes></time-modification>` : '';
        const dots = '<dot/>'.repeat(e.dots || 0);
        const tup = tupletEdge(m, e);
        if (e.kind === 'rest') {
          out.push(e.full ? `<note><rest measure="yes"/><duration>${Math.round(m.cap * 5)}</duration>${VO}</note>`
            : `<note><rest/><duration>${dur}</duration>${VO}<type>${TYPE[e.dur]}</type>${dots}${tm}${tup ? `<notations>${tup}</notations>` : ''}</note>`);
          continue;
        }
        e.notes.forEach((n, k) => {
          const w = W.notes.get(n), p = w.pitch, step = 'CDEFGAB'[((p.d % 7) + 7) % 7], oct = Math.floor(p.d / 7);
          const tieStart = links.has(n), tieStop = tiedFrom.has(n);
          const ties = (tieStop ? '<tie type="stop"/>' : '') + (tieStart ? '<tie type="start"/>' : '');
          const tied = (tieStop ? '<tied type="stop"/>' : '') + (tieStart ? '<tied type="start"/>' : '');
          const ART = { stacc: '<staccato/>', ten: '<tenuto/>', acc: '<accent/>' }, art = k === 0 ? (e.notes[0].artic || []).map((a) => ART[a]).join('') : '';
          const slurs = k === 0 ? (m.st.slurs || []).flatMap((sl, si) => [sl.from && e.notes.includes(sl.from) ? `<slur type="start" number="${(si % 6) + 1}"/>` : '', sl.to && e.notes.includes(sl.to) ? `<slur type="stop" number="${(si % 6) + 1}"/>` : '']).join('') : '';
          const nota = tied + slurs + (k === 0 ? tup : '') + (art ? `<articulations>${art}</articulations>` : '');
          out.push(`<note>${e.grace ? '<grace/>' : ''}${k ? '<chord/>' : ''}<pitch><step>${step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${oct}</octave></pitch>` +
            `${e.grace ? '' : `<duration>${dur}</duration>`}${ties}${VO}<type>${TYPE[e.dur] || 'quarter'}</type>${dots}` +
            `${w.acc != null ? `<accidental>${ACC[w.acc]}</accidental>` : ''}${tm}${STEM}${nota ? `<notations>${nota}</notations>` : ''}</note>`);
        });
      }
      }
      const last = mi === part.measures.length - 1;
      if (last || m.double) out.push(`<barline location="right"><bar-style>${last ? 'light-heavy' : 'light-light'}</bar-style></barline>`);
      out.push('</measure>');
    });
    out.push('</part>');
  }
  out.push('</score-partwise>');
  return out.join('\n');
}
// tuplet bracket start/stop on the first / last event of its group (score.js sets e.tg)
function tupletEdge(m, e) {
  if (!e.tuplet || !e.tg) return '';
  const g = e.tg.filter((q) => !q.removed);
  return (g[0] === e ? '<tuplet type="start"/>' : '') + (g[g.length - 1] === e ? '<tuplet type="stop"/>' : '');
}

// Loudness per event (0..1) from written dynamics (holding until the next, sf/fz/sfz/rf
// accenting one note) and hairpins (ramping from where they start to the next written dynamic,
// or two steps when none follows); default mf. Legato: events under a slur except its last.
export const DYN_LEVEL = { ppp: 0.2, pp: 0.3, p: 0.42, mp: 0.55, mf: 0.68, f: 0.8, ff: 0.9, fff: 1 };
const ACCENT_DYN = { sf: 0.25, sfz: 0.3, fz: 0.25, sffz: 0.35, rf: 0.2, rfz: 0.25 };
export function expression(part, tl = timeline(part)) {
  const level = new Map(), legato = new Set(), idx = new Map();
  const notesOf = tl.map((q) => q.e.notes || []);
  tl.forEach((q, k) => (q.e.notes || []).forEach((n) => idx.set(n, k)));
  const dyn = new Map(); // event index -> dynamic text
  const hps = [];
  for (const st of part.staves) {
    for (const d of st.dynamics || []) if (d.note && idx.has(d.note)) dyn.set(idx.get(d.note), d.text);
    for (const h of st.hairpins || []) if (h.from && idx.has(h.from)) hps.push({ a: idx.get(h.from), b: h.to && idx.has(h.to) ? idx.get(h.to) : idx.get(h.from), form: h.form });
    for (const sl of st.slurs || []) {
      const a = sl.from && idx.has(sl.from) ? idx.get(sl.from) : null, b = sl.to && idx.has(sl.to) ? idx.get(sl.to) : null;
      const lo = a ?? (b != null ? tl.findIndex((q) => q.m.st === st) : null), hi = b ?? (a != null ? tl.map((q) => q.m.st).lastIndexOf(st) + (sl.open ? 1 : 0) : null);
      if (lo != null && hi != null) for (let k = lo; k < hi; k++) legato.add(tl[k].e);
    }
  }
  const base = []; let cur = DYN_LEVEL.mf;
  tl.forEach((q, k) => {
    const t = dyn.get(k); let v;
    if (t && DYN_LEVEL[t] != null) { cur = DYN_LEVEL[t]; v = cur; }
    else if (t === 'fp' || t === 'sfp') { v = DYN_LEVEL.f; cur = DYN_LEVEL.p; }
    else if (t && ACCENT_DYN[t] != null) v = Math.min(1, cur + ACCENT_DYN[t]);
    else v = cur;
    base.push(v);
  });
  for (const h of hps) {
    const nk = [...dyn.keys()].filter((k) => k >= h.b && k <= h.b + 2 && DYN_LEVEL[dyn.get(k)] != null).sort((x, y) => x - y)[0];
    const v0 = base[h.a], v1 = nk != null ? DYN_LEVEL[dyn.get(nk)] : Math.max(0.15, Math.min(1, v0 + (h.form === 'cresc' ? 0.22 : -0.22)));
    const end = nk != null ? nk : h.b, t0 = tl[h.a].tick, t1 = Math.max(t0 + 1, tl[end].tick);
    for (let k = h.a; k <= end; k++) base[k] = v0 + ((v1 - v0) * (tl[k].tick - t0)) / (t1 - t0);
    if (nk == null) for (let k = end + 1; k < tl.length && !dyn.has(k); k++) base[k] = v1;
  }
  tl.forEach((q, k) => level.set(q.e, base[k]));
  void notesOf;
  return { level, legato, dyn, hps };
}

/** Sounding notes for playback and MIDI: [{ tick, dur, midi, part, ev, notes }], ties merged. */
export function performance(model, score, { plan = null, from = null } = {}) {
  const W = writing(model, plan);
  const shift = plan ? plan.to.ds : from ? from.ds : 0; // written -> concert pitch
  const notes = [], events = [];
  let total = 0;
  for (const part of score.parts) {
    const links = tieLinks(part, W), sounding = new Map(); // note -> sounding entry it extends
    const tl = timeline(part);
    const ex = expression(part, tl);
    for (const { e, m, tick, ticks } of tl) {
      events.push({ tick, dur: ticks, e, m, part: part.index });
      if (e.kind !== 'note') continue;
      const lv = ex.level.get(e) ?? 0.68;
      for (const n of e.notes) {
        const midi = midiOf(W.notes.get(n).pitch) + shift;
        const prev = sounding.get(n);
        let s = prev;
        const art = e.notes[0].artic || [];
        if (!s) { s = { tick, dur: e.grace ? 12 : ticks, midi, part: part.index, vel: Math.min(1, lv + (art.includes('acc') ? 0.2 : 0)) }; notes.push(s); }
        else s.dur += ticks;
        // how much of its length sounds: staccato about half, tenuto and under a slur all of it
        // (joined to the next), otherwise a small gap
        s.rel = art.includes('stacc') ? 0.45 : art.includes('ten') || ex.legato.has(e) ? 1 : 0.92;
        if (links.has(n)) sounding.set(links.get(n), s);
      }
    }
    const end = tl.length ? tl[tl.length - 1].tick + tl[tl.length - 1].ticks : 0;
    total = Math.max(total, end);
  }
  for (const n of notes) { n.sound = Math.max(6, Math.round(n.dur * (n.rel ?? 0.92))); delete n.rel; }
  notes.sort((a, b) => a.tick - b.tick || a.midi - b.midi);
  events.sort((a, b) => a.tick - b.tick);
  return { notes, events, total };
}

function vlq(n) { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; }
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** Standard MIDI File, format 0, one channel per part, at concert pitch. */
export function toMidi(model, score, { plan = null, from = null, tempo = 100, title = 'Score', program = 0 } = {}) {
  const { notes } = performance(model, score, { plan, from });
  const ev = [], us = Math.round(60e6 / tempo), T = (t) => Math.round(t * 5);
  ev.push({ t: 0, o: 0, b: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
  const ts = score.parts[0]?.measures.find((m) => m.time)?.time;
  if (ts) ev.push({ t: 0, o: 0, b: [0xff, 0x58, 4, ts.beats, Math.log2(ts.unit), 24, 8] });
  const name = [...title].map((c) => c.charCodeAt(0) & 0x7f).slice(0, 120);
  ev.push({ t: 0, o: 0, b: [0xff, 0x03, name.length, ...name] });
  for (const p of score.parts) ev.push({ t: 0, o: 0, b: [0xc0 | (p.index % 16), program] });
  for (const n of notes) {
    const ch = n.part % 16;
    ev.push({ t: T(n.tick), o: 2, b: [0x90 | ch, n.midi, Math.round(n.vel * 120)] });
    ev.push({ t: T(n.tick + n.sound) - 1, o: 1, b: [0x80 | ch, n.midi, 0] });
  }
  ev.sort((a, b) => a.t - b.t || a.o - b.o);
  const trk = []; let last = 0;
  for (const e of ev) { trk.push(...vlq(Math.max(0, e.t - last)), ...e.b); last = Math.max(last, e.t); }
  trk.push(0, 0xff, 0x2f, 0);
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (DIVS >> 8) & 255, DIVS & 255, 0x4d, 0x54, 0x72, 0x6b, ...u32(trk.length), ...trk]);
}

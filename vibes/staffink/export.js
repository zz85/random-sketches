// Playback timeline, MusicXML 4.0 and Standard MIDI File export. No DOM.
import { DIV, spellScore, resolveAttrs, measureCapacity, evTicks, stepName, DUR_NAMES, DYN_LEVEL, staffSequence } from './theory.js';
import { beamGroups } from './layout.js';

/** Last measure with anything in it (the trailing blank bar is not music). */
function lastUsed(score) {
  let k = score.measures.length - 1;
  while (k > 0 && score.measures[k].staves.every((s) => !s.events.length)) k--;
  return k;
}

/**
 * Loudness 0..1 per event id: written dynamics hold until the next one, sfz/fp accent a
 * single note, hairpins ramp from where they start to the next marked dynamic (or two
 * steps up/down when none follows). Default mf.
 */
export function velocities(score) {
  const vel = new Map();
  score.staves.forEach((_, si) => {
    const seq = staffSequence(score, si);
    let level = DYN_LEVEL.mf;
    const base = seq.map(({ ev }) => {
      let v = level;
      if (ev.dyn === 'sfz') v = Math.min(1, level + 0.3);
      else if (ev.dyn === 'fp') { v = DYN_LEVEL.f; level = DYN_LEVEL.p; }
      else if (DYN_LEVEL[ev.dyn]) { level = DYN_LEVEL[ev.dyn]; v = level; }
      return v;
    });
    for (const h of score.hairpins || []) {
      const a = seq.findIndex((q) => q.ev.id === h.from), b = seq.findIndex((q) => q.ev.id === h.to);
      if (a < 0 || b < a) continue;
      // the target is a dynamic on the last note or the one right after it
      const nk = seq.findIndex((q, k) => k > a && k >= b && k <= b + 1 && DYN_LEVEL[q.ev.dyn]);
      const v0 = base[a], v1 = nk >= 0 ? DYN_LEVEL[seq[nk].ev.dyn] : Math.max(0.15, Math.min(1, v0 + (h.type === 'cresc' ? 0.24 : -0.24)));
      const t0 = seq[a].onset, t1 = nk >= 0 ? seq[nk].onset : seq[b].onset;
      const end = nk >= 0 ? nk - 1 : b;
      for (let k = a; k <= end; k++) base[k] = v0 + (v1 - v0) * (seq[k].onset - t0) / Math.max(1, t1 - t0);
      // without a closing dynamic, the level reached is where the music stays
      if (nk < 0) for (let k = b + 1; k < seq.length && !seq[k].ev.dyn; k++) base[k] = v1;
    }
    seq.forEach(({ ev }, k) => vel.set(ev.id, base[k]));
  });
  return vel;
}

/**
 * Notes to sound: [{tick, dur, midi, id, si, vel}] with ties merged into one sounding note.
 * Also returns per-event onsets for the playhead.
 */
export function performance(score) {
  const { spelled, attrs } = spellScore(score);
  const end = lastUsed(score);
  const notes = [], onsets = [];
  const vels = velocities(score);
  score.staves.forEach((_, si) => {
    let t0 = 0;
    const open = new Map(); // midi -> note still sustaining through a tie
    for (let mi = 0; mi <= end; mi++) {
      const a = attrs[mi];
      let t = t0;
      for (const ev of score.measures[mi].staves[si].events) {
        const d = evTicks(ev, a.time);
        onsets.push({ tick: t, dur: d, id: ev.id, si });
        if (ev.kind === 'note') {
          const hs = spelled.get(ev) || [];
          const nextOpen = new Map();
          hs.forEach((h) => {
            let n = open.get(h.midi);
            if (n) n.dur += d; else { n = { tick: t, dur: d, midi: h.midi, id: ev.id, si, vel: Math.max(0.08, (vels.get(ev.id) ?? 0.68) * (ev.stacc ? 0.9 : 1)), stacc: !!ev.stacc }; notes.push(n); }
            if (ev.tie) nextOpen.set(h.midi, n);
          });
          open.clear(); for (const [k, v] of nextOpen) open.set(k, v);
        } else open.clear();
        t += d;
      }
      t0 += measureCapacity(a.time);
    }
  });
  for (const n of notes) if (n.stacc) n.dur = Math.max(DIV / 8, n.dur * 0.45);
  notes.sort((a, b) => a.tick - b.tick || a.midi - b.midi);
  onsets.sort((a, b) => a.tick - b.tick);
  let totalTicks = 0; for (let mi = 0; mi <= end; mi++) totalTicks += measureCapacity(attrs[mi].time);
  return { notes, onsets, totalTicks };
}

// ---------------------------------------------------------------- MusicXML

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ACC_NAME = { '-2': 'flat-flat', '-1': 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' };
const CLEF_XML = { G: ['G', 2], F: ['F', 4], C: ['C', 3] };

export function toMusicXML(score) {
  const { spelled, attrs } = spellScore(score);
  const end = lastUsed(score);
  const nSt = score.staves.length;
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="4.0">');
  out.push(`  <work><work-title>${esc(score.title)}</work-title></work>`);
  out.push('  <identification><encoding><software>StaffInk</software></encoding></identification>');
  out.push(`  <part-list><score-part id="P1"><part-name>${nSt > 1 ? 'Piano' : 'Music'}</part-name></score-part></part-list>`);
  out.push('  <part id="P1">');
  const slurStart = new Map(), slurStop = new Map();
  (score.slurs || []).forEach((s, i) => { slurStart.set(s.from, (i % 6) + 1); slurStop.set(s.to, (i % 6) + 1); });
  const tiedIn = score.staves.map(() => new Set());
  for (let mi = 0; mi <= end; mi++) {
    const m = score.measures[mi], a = attrs[mi], ch = a.changed;
    out.push(`    <measure number="${mi + 1}">`);
    if (mi === 0 || ch.key || ch.time || ch.clefs.some(Boolean)) {
      out.push('      <attributes>');
      if (mi === 0) out.push(`        <divisions>${DIV}</divisions>`);
      if (mi === 0 || ch.key) out.push(`        <key><fifths>${a.key}</fifths></key>`);
      if (mi === 0 || ch.time) out.push(`        <time${a.timeSym ? ` symbol="${a.timeSym}"` : ''}><beats>${a.time[0]}</beats><beat-type>${a.time[1]}</beat-type></time>`);
      if (mi === 0 && nSt > 1) out.push(`        <staves>${nSt}</staves>`);
      a.clefs.forEach((c, si) => { if (mi === 0 || ch.clefs[si]) out.push(`        <clef${nSt > 1 ? ` number="${si + 1}"` : ''}><sign>${CLEF_XML[c][0]}</sign><line>${CLEF_XML[c][1]}</line></clef>`); });
      out.push('      </attributes>');
    }
    if (mi === 0) out.push(`      <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${score.tempo}</per-minute></metronome></direction-type><sound tempo="${score.tempo}"/></direction>`);
    m.staves.forEach((st, si) => {
      if (si > 0) {
        const used = m.staves[si - 1].events.reduce((t, ev) => t + evTicks(ev, a.time), 0);
        if (used) out.push(`      <backup><duration>${used}</duration></backup>`);
      }
      const voice = si * 4 + 1;
      const beams = new Map();
      for (const g of beamGroups(st.events, a.time)) g.forEach((ev, k) => beams.set(ev.id, k === 0 ? 'begin' : k === g.length - 1 ? 'end' : 'continue'));
      const tupPos = new Map();
      st.events.forEach((ev, k) => {
        if (!ev.tuplet) return;
        const prev = st.events[k - 1], next = st.events[k + 1];
        const first = !(prev && prev.tuplet && prev.tuplet.id === ev.tuplet.id), last = !(next && next.tuplet && next.tuplet.id === ev.tuplet.id);
        tupPos.set(ev.id, (first ? 'start' : '') + (last ? 'stop' : ''));
      });
      for (const ev of st.events) {
        const d = evTicks(ev, a.time);
        const staffTag = nSt > 1 ? `<staff>${si + 1}</staff>` : '';
        const tm = ev.tuplet ? `<time-modification><actual-notes>${ev.tuplet.n}</actual-notes><normal-notes>${ev.tuplet.m}</normal-notes></time-modification>` : '';
        const tp = tupPos.get(ev.id) || '';
        const tupN = (tp.includes('start') ? `<tuplet type="start" bracket="${beams.has(ev.id) ? 'no' : 'yes'}"/>` : '') + (tp.includes('stop') ? '<tuplet type="stop"/>' : '');
        const dir = (inner, place = 'below') => out.push(`      <direction placement="${place}"><direction-type>${inner}</direction-type>${staffTag}</direction>`);
        for (const h of score.hairpins || []) if (h.from === ev.id) dir(`<wedge type="${h.type === 'cresc' ? 'crescendo' : 'diminuendo'}"/>`);
        if (ev.dyn) {
          const lvl = DYN_LEVEL[ev.dyn];
          out.push(`      <direction placement="below"><direction-type><dynamics><${ev.dyn}/></dynamics></direction-type>${staffTag}${lvl ? `<sound dynamics="${Math.round(lvl * 110 / 90 * 100)}"/>` : ''}</direction>`);
        }
        if (ev.kind === 'rest') {
          out.push(`      <note>${ev.full ? '<rest measure="yes"/>' : '<rest/>'}<duration>${d}</duration><voice>${voice}</voice>${ev.full ? '' : `<type>${DUR_NAMES[ev.dur]}</type>`}${'<dot/>'.repeat(ev.dots || 0)}${tm}${staffTag}${tupN ? `<notations>${tupN}</notations>` : ''}</note>`);
          tiedIn[si].clear();
          for (const h of score.hairpins || []) if (h.to === ev.id) dir('<wedge type="stop"/>');
          continue;
        }
        const hs = spelled.get(ev) || [];
        const incoming = tiedIn[si];
        const nextIn = new Set();
        ev.heads.map((h, k) => ({ h, s: hs[k] })).sort((p, q) => p.h.pos - q.h.pos).forEach(({ h, s }, k) => {
          const { step, octave } = stepName(s.d);
          const stop = incoming.has(h.pos), start = !!ev.tie;
          if (start) nextIn.add(h.pos);
          const ties = (stop ? '<tie type="stop"/>' : '') + (start ? '<tie type="start"/>' : '');
          const tied = (stop ? '<tied type="stop"/>' : '') + (start ? '<tied type="start"/>' : '');
          const slur = k === 0 ? (slurStart.has(ev.id) ? `<slur type="start" number="${slurStart.get(ev.id)}"/>` : '') + (slurStop.has(ev.id) ? `<slur type="stop" number="${slurStop.get(ev.id)}"/>` : '') : '';
          const art = k === 0 && ev.stacc ? '<articulations><staccato/></articulations>' : '';
          const tn = k === 0 ? tupN : '';
          const notations = tied || slur || art || tn ? `<notations>${tied}${slur}${tn}${art}</notations>` : '';
          const beam = k === 0 && beams.has(ev.id) ? `<beam number="1">${beams.get(ev.id)}</beam>` : '';
          out.push(`      <note>${k ? '<chord/>' : ''}<pitch><step>${step}</step>${s.alter ? `<alter>${s.alter}</alter>` : ''}<octave>${octave}</octave></pitch><duration>${d}</duration>${ties}<voice>${voice}</voice><type>${DUR_NAMES[ev.dur]}</type>${'<dot/>'.repeat(ev.dots || 0)}${s.showAcc ? `<accidental>${ACC_NAME[s.alter]}</accidental>` : ''}${tm}${staffTag}${beam}${notations}</note>`);
        });
        tiedIn[si] = nextIn;
        for (const h of score.hairpins || []) if (h.to === ev.id) dir('<wedge type="stop"/>');
      }
    });
    out.push('    </measure>');
  }
  out.push('  </part>');
  out.push('</score-partwise>');
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------- MIDI

function vlq(n) { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; }
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

/** Standard MIDI File, format 0, DIV ticks per quarter. */
export function toMidi(score) {
  const { notes } = performance(score);
  const attrs = resolveAttrs(score);
  const ev = [];
  const us = Math.round(60e6 / score.tempo);
  ev.push({ t: 0, o: 0, b: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
  const ts = attrs[0].time;
  ev.push({ t: 0, o: 0, b: [0xff, 0x58, 4, ts[0], Math.log2(ts[1]), 24, 8] });
  const title = [...score.title].map((c) => c.charCodeAt(0) & 0x7f).slice(0, 120);
  ev.push({ t: 0, o: 0, b: [0xff, 0x03, title.length, ...title] });
  for (const n of notes) {
    const ch = n.si === 1 ? 1 : 0, vel = Math.round(n.vel * 110);
    ev.push({ t: n.tick, o: 2, b: [0x90 | ch, n.midi, vel] });
    ev.push({ t: n.tick + n.dur, o: 1, b: [0x80 | ch, n.midi, 0] });
  }
  ev.sort((a, b) => a.t - b.t || a.o - b.o);
  const trk = [];
  let last = 0;
  for (const e of ev) { trk.push(...vlq(e.t - last), ...e.b); last = e.t; }
  trk.push(0, 0xff, 0x2f, 0);
  return new Uint8Array([0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (DIV >> 8) & 255, DIV & 255, 0x4d, 0x54, 0x72, 0x6b, ...u32(trk.length), ...trk]);
}

// ScoreShift (photo OMR) -> timeline IR.
//
// ScoreShift's score is anchored to the image: every event has an x on a staff of the page,
// measures are regions between printed barlines, checked (and possibly repaired) against the
// time signature. Here the music becomes events on a timeline per part, the printed barlines
// become barline directions with their page position, and every event keeps src = { x, y,
// line } (line = staff index on the page), so anchors such as { pos: { x, line } } or
// { barline } point at what the user sees on the photo.
//
// Pitch: heads carry the pitch as read (or as transposed by a plan) with alter known, and the
// accidental as printed. part.transpose is the written -> concert shift in semitones.
// Grace notes take no time in ScoreShift's measures and are left out (counted in `skipped`).
//
// Ids are keyed to the page, not to the order events are met, so a program saved with a
// project still points at the same notes after a correction elsewhere rebuilds the score:
//   event    ss:L<staff line>:q<x in quarter staff spaces>:<voice>   e.g. ss:L2:q164:P1v1
//   barline  ssb:L<staff line>:q<x>
// (a second event at the same key gets #2, #3). anchors.js resolves such ids within half a
// staff space when the exact one is gone, and reports them when nothing is there.
//
// Returns { score, byId: Map(IR event id -> ScoreShift timeline entry { e, m, tick, ... }),
// skipped }.
import { timeline } from '../../scoreshift/score.js';
import { writing, expression } from '../../scoreshift/export.js';
import { CLEFS } from '../pitch.js';
import { DIV } from '../duration.js';
import { createScore, addPart, addVoice, addEvent, addDirection, addLink } from '../ir.js';
import { fromTicks } from '../rational.js';

/** ScoreShift articulation names -> IR marks. */
export const MARK = { stacc: 'staccato', ten: 'tenuto', acc: 'accent', upbow: 'up-bow', dnbow: 'down-bow' };
const T = (t) => fromTicks(Math.round(t), DIV);

export function fromScoreShift(model, sscore, { plan = null, from = null, title = 'Score' } = {}) {
  const W = writing(model, plan);
  const shift = plan ? plan.to.ds : from ? from.ds : 0;
  const parts = sscore.parts.filter((p) => p.measures.length);
  const score = createScore({ title, staves: 1 });
  const S = model.space || 16, Q = S / 4;
  score.pageIds = { unit: Q, tol: 2 }; // quarter spaces; match within half a space
  const taken = new Set();
  const key = (base) => { let k = base, n = 1; while (taken.has(k)) k = `${base}#${++n}`; taken.add(k); return k; };
  score.parts[0].name = 'Part 1';
  while (score.parts.length < parts.length) addPart(score, { staves: 1 });
  const byId = new Map();
  let skipped = 0;

  parts.forEach((part, pi) => {
    const P = score.parts[pi], staff = P.staves[0].id;
    P.transpose = shift;
    const voiceIds = [score.voices.find((v) => v.staff === staff).id];
    const voiceOf = (k) => { while (voiceIds.length <= k) voiceIds.push(addVoice(score, { staff, id: `${P.id}v${voiceIds.length + 1}` }).id); return voiceIds[k]; };
    // measures: meter, key and clef where they change, a barline at each printed bar
    let t0 = 0, time = null, fifths = null, clef = null;
    for (const m of part.measures) {
      if (m.at != null) t0 = m.at; // a part on only some systems (ScoreShift alignParts)
      const len = m.status === 'rest' ? m.cap : m.ticks;
      const sw = W.staves.get(m.st);
      const mf = plan ? sw.fifths : m.fifths, mc = plan ? sw.clef : m.clef;
      if (m.time && (!time || m.timeShown || m.time.beats !== time.beats || m.time.unit !== time.unit)) {
        if (!time || m.time.beats !== time.beats || m.time.unit !== time.unit) addDirection(score, 'meter', T(t0), { beats: m.time.beats, unit: m.time.unit });
        time = m.time;
      }
      if (mf !== fifths) { addDirection(score, 'key', T(t0), { fifths: mf }, { staff }); fifths = mf; }
      if (mc !== clef) { const c = CLEFS[mc] || CLEFS.treble; addDirection(score, 'clef', T(t0), { sign: c.sign, line: c.line, octave: c.oct }, { staff }); clef = mc; }
      t0 += len;
      if (pi === 0 && len > 0) {
        const bx = m.endBar ? m.st.x1 : m.x1;
        const d = addDirection(score, 'barline', T(t0), { style: m.endBar && m === part.measures[part.measures.length - 1] ? 'final' : m.double ? 'double' : 'regular' },
          { src: { x: bx, line: m.st.index } });
        d.id = key(`ssb:L${m.st.index}:q${Math.round(bx / Q)}`);
      }
    }

    // events
    const tl = timeline(part), ex = expression(part, tl);
    const irOf = new Map(); // ScoreShift event -> IR event
    const noteEv = new Map(); // analysis note -> IR event id
    for (const q of tl) {
      const { e, m, tick, ticks } = q;
      if (e.grace || !(ticks > 0)) { if (e.grace) skipped++; continue; }
      const voice = voiceOf(q.voice ?? 0);
      const ev = addEvent(score, {
        id: key(`ss:L${m.st.index}:q${Math.round(e.x / Q)}:${voice}`),
        voice, onset: T(tick), dur: T(ticks),
        heads: e.kind === 'note' ? e.notes.map((n) => { const w = W.notes.get(n); return { d: w.pitch.d, alter: w.pitch.alter, acc: w.acc ?? null }; }) : [],
        written: e.full ? undefined : { type: e.dur, dots: e.dots || 0, tuplet: e.tuplet || null },
        src: { x: e.x, y: e.kind === 'note' ? e.notes.reduce((s, n) => s + n.y, 0) / e.notes.length : (e.rest.box[1] + e.rest.box[3]) / 2, line: m.st.index },
      });
      const marks = [...new Set((e.notes?.[0]?.artic || []).map((a) => MARK[a]).filter(Boolean))];
      if (marks.length) ev.marks = marks;
      if (e.kind === 'note') { ev.vel = ex.level.get(e) ?? 0.68; for (const n of e.notes) noteEv.set(n, ev.id); }
      irOf.set(e, ev);
      byId.set(ev.id, q);
    }
    // ties: to the next event of the same voice
    const lastIn = new Map();
    for (const q of tl) {
      const ev = irOf.get(q.e); if (!ev) continue;
      const prev = lastIn.get(ev.voice);
      if (prev && prev.e.tie && prev.e.kind === 'note' && q.e.kind === 'note') addLink(score, 'tie', [prev.ev.id, ev.id]);
      lastIn.set(ev.voice, { e: q.e, ev });
    }
    // slurs, hairpins and dynamics as the page shows them
    for (const st of part.staves) {
      for (const sl of st.slurs || []) if (noteEv.has(sl.from) && noteEv.has(sl.to)) addLink(score, 'slur', [noteEv.get(sl.from), noteEv.get(sl.to)]);
      for (const h of st.hairpins || []) if (noteEv.has(h.from) && noteEv.has(h.to)) addLink(score, 'hairpin', [noteEv.get(h.from), noteEv.get(h.to)], { type: h.form === 'cresc' ? 'cresc' : 'dim' });
      for (const d of st.dynamics || []) if (noteEv.has(d.note)) {
        const id = noteEv.get(d.note), ev = score.events.find((x) => x.id === id);
        addDirection(score, 'dynamic', ev.onset, { text: d.text }, { staff, event: id });
      }
    }
  });
  return { score, byId, skipped };
}

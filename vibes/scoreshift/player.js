// Web Audio playback of the recognised music on the shared player (../notation-ir/player.js:
// the additive voice from StaffInk, a metronome and a lookahead scheduler), so the speed can
// change and the metronome can be switched while playing, and playback can start anywhere.
// onTick reports the events sounding now (for the playhead) and the position in ticks.
import { performance as perf } from './export.js';
import { DIV, capOf } from './score.js';
import { Player as CorePlayer } from '../notation-ir/player.js';

/**
 * Beats for the metronome: [{ tick, accent }] over a part's measures, by time signature (a
 * compound meter such as 6/8 clicks dotted quarters). A pickup's beats are counted back from
 * its end, so the downbeat falls on the next bar line.
 */
export function beats(score) {
  const part = score.parts[0], out = []; if (!part) return out;
  let t0 = 0;
  for (const m of part.measures) {
    const len = m.status === 'rest' ? m.cap : m.ticks, time = m.time || { beats: 4, unit: 4 };
    const compound = time.unit === 8 && time.beats % 3 === 0 && time.beats > 3;
    const beat = compound ? (3 * 4 * DIV) / time.unit : (4 * DIV) / time.unit, cap = capOf(time);
    const short = m.status === 'pickup' ? cap - len : 0; // a pickup is the end of a bar
    for (let b = 0; b * beat < cap; b++) { const t = b * beat - short; if (t >= 0 && t < len) out.push({ tick: t0 + t, accent: b === 0 }); }
    t0 += len;
  }
  return out;
}

export class Player extends CorePlayer {
  constructor() { super(); this._tempo = 100; }
  /** Quarter notes per minute (times this.speed); can change while playing. */
  get tempo() { return this._tempo; }
  set tempo(v) { this._tempo = v; this.setRate((v * DIV) / 60); }
  get spt() { return 60 / (this.tempo * this.speed) / DIV; } // seconds per tick now
  /** Play from `fromTick` at opts.tempo quarter notes per minute (times this.speed). */
  play(model, score, opts, onTick, fromTick = 0) {
    const { notes, events, total } = perf(model, score, opts);
    this._tempo = opts.tempo || 100; this.total = total;
    this.schedule({
      notes: notes.map((n) => ({ at: n.tick, dur: n.sound, midi: n.midi, vel: n.vel })),
      clicks: beats(score).map((b) => ({ at: b.tick, accent: b.accent })),
      rate: (this._tempo * DIV) / 60, from: fromTick, end: total + DIV / 4,
      onFrame: (now) => onTick && onTick(events.filter((o) => o.tick <= now && now < o.tick + Math.max(1, o.dur)), now),
    });
  }
}

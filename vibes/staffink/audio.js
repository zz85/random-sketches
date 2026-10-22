// StaffInk playback on the shared Web Audio player (../notation-ir/player.js): the score's
// notes in ticks, scheduled ahead against AudioContext.currentTime so timing does not depend
// on the main thread. playPerformance (inherited) plays authored programs from the IR.
import { DIV } from './theory.js';
import { performance as perf } from './export.js';
import { Player as CorePlayer } from '../notation-ir/player.js';

export class Player extends CorePlayer {
  constructor() { super({ sustain: 0.25, previewDur: 0.6, previewVel: 0.8, defaultVel: 0.8 }); }

  /** Play the score; onTick(set of sounding event ids, tick) fires every animation frame. */
  play(score, onTick, fromTick = 0) {
    const { notes, onsets, totalTicks } = perf(score);
    this.schedule({
      notes: notes.map((n) => ({ at: n.tick, dur: n.dur, midi: n.midi, vel: n.vel })),
      rate: (score.tempo * DIV) / 60, from: fromTick, end: totalTicks + DIV / 4,
      onFrame: (now) => onTick && onTick(new Set(onsets.filter((o) => o.tick <= now && now < o.tick + o.dur).map((o) => o.id)), now),
    });
  }
}

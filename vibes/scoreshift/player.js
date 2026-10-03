// Web Audio playback of the recognised music: a small additive voice (from StaffInk) and a
// metronome, scheduled a little ahead of AudioContext.currentTime by a lookahead loop, so the
// speed can change and the metronome can be switched while playing, and playback can start
// anywhere. onTick reports the events sounding now (for the playhead) and the position.
import { performance as perf } from './export.js';
import { DIV, capOf } from './score.js';

const AHEAD = 0.15; // seconds scheduled ahead of the audio clock

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

export class Player {
  constructor() { this.ctx = null; this.voices = []; this.playing = false; this.onStop = null; this.speed = 1; this.metronome = false; this.pos = 0; }
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.comp = this.ctx.createDynamicsCompressor(); this.comp.threshold.value = -14; this.comp.ratio.value = 4;
      this.master = this.ctx.createGain(); this.master.gain.value = 0.55;
      this.master.connect(this.comp).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  voice(midi, t, dur, vel = 0.75) {
    const c = this.ctx, f = 440 * 2 ** ((midi - 69) / 12);
    const out = c.createGain(), lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 0.4;
    lp.frequency.setValueAtTime(Math.min(12000, f * 9), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(300, f * 2.2), t + 0.9);
    const decay = 0.9 + 2.2 * Math.max(0, (84 - midi) / 48), peak = vel * 0.22;
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(peak, t + 0.006);
    out.gain.setTargetAtTime(peak * 0.3, t + 0.01, decay / 3);
    const end = t + Math.max(0.08, dur);
    out.gain.setTargetAtTime(0.0001, end, 0.06);
    for (const [k, g, type] of [[1, 1, 'triangle'], [2, 0.32, 'sine'], [3, 0.12, 'sine'], [4.02, 0.05, 'sine']]) {
      const o = c.createOscillator(), og = c.createGain();
      o.type = type; o.frequency.value = f * k; o.detune.value = (k - 1) * 1.5;
      og.gain.value = g; o.connect(og).connect(lp); o.start(t); o.stop(end + 0.4);
      this.voices.push(o);
    }
    lp.connect(out).connect(this.master);
  }
  click(t, accent) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = 'square'; o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(accent ? 0.22 : 0.13, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + 0.06); this.voices.push(o);
  }
  preview(midis) { this.ensure(); const t = this.ctx.currentTime + 0.01; for (const m of midis) this.voice(m, t, 0.5); }
  get spt() { return 60 / (this.tempo * this.speed) / DIV; } // seconds per tick now
  /** Ticks at audio time t (the clock is re-anchored whenever the speed changes). */
  tickAt(t) { return this.anchorTick + (t - this.anchorTime) / this.spt; }
  setSpeed(x) { if (this.playing) { const now = this.ctx.currentTime; this.anchorTick = this.tickAt(now); this.anchorTime = now; } this.speed = x; }
  /** Play from `fromTick` at `tempo` quarter notes per minute (times this.speed). */
  play(model, score, opts, onTick, fromTick = 0) {
    this.stop(); this.ensure();
    const { notes, events, total } = perf(model, score, opts);
    this.tempo = opts.tempo || 100; this.total = total;
    const bt = beats(score);
    this.anchorTime = this.ctx.currentTime + 0.08; this.anchorTick = fromTick;
    let ni = notes.findIndex((n) => n.tick >= fromTick), bi = bt.findIndex((b) => b.tick >= fromTick);
    if (ni < 0) ni = notes.length; if (bi < 0) bi = bt.length;
    this.playing = true;
    const schedule = () => {
      const until = this.tickAt(this.ctx.currentTime + AHEAD), spt = this.spt;
      for (; ni < notes.length && notes[ni].tick < until; ni++) { const n = notes[ni]; this.voice(n.midi, this.anchorTime + (n.tick - this.anchorTick) * spt, n.sound * spt, n.vel); }
      for (; bi < bt.length && bt[bi].tick < until; bi++) if (this.metronome) this.click(this.anchorTime + (bt[bi].tick - this.anchorTick) * spt, bt[bi].accent);
    };
    schedule(); this.timer = setInterval(schedule, 25);
    const tick = () => {
      if (!this.playing) return;
      const now = (this.pos = this.tickAt(this.ctx.currentTime));
      onTick && onTick(events.filter((o) => o.tick <= now && now < o.tick + Math.max(1, o.dur)), now);
      if (now > total + DIV / 4) { this.stop(); this.pos = 0; return; }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearInterval(this.timer);
    const was = this.playing; this.playing = false;
    for (const o of this.voices) { try { o.stop(); } catch (e) { /* already stopped */ } }
    this.voices = [];
    if (was && this.onStop) this.onStop();
  }
}

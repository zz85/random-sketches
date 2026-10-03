// Web Audio playback of the recognised music: a small additive voice (from StaffInk), scheduled
// against AudioContext.currentTime so timing does not depend on the main thread. onTick reports
// the events sounding now, for the playhead.
import { performance as perf } from './export.js';
import { DIV } from './score.js';

export class Player {
  constructor() { this.ctx = null; this.voices = []; this.playing = false; this.onStop = null; }
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
  preview(midis) { this.ensure(); const t = this.ctx.currentTime + 0.01; for (const m of midis) this.voice(m, t, 0.5); }
  /** Play from `fromTick` at `tempo` quarter notes per minute. */
  play(model, score, opts, onTick, fromTick = 0) {
    this.stop(); this.ensure();
    const { notes, events, total } = perf(model, score, opts);
    const spt = 60 / (opts.tempo || 100) / DIV, t0 = this.ctx.currentTime + 0.08 - fromTick * spt;
    for (const n of notes) if (n.tick >= fromTick) this.voice(n.midi, t0 + n.tick * spt, n.sound * spt, n.vel);
    this.playing = true;
    const tick = () => {
      if (!this.playing) return;
      const now = (this.ctx.currentTime - t0) / spt;
      onTick && onTick(events.filter((o) => o.tick <= now && now < o.tick + Math.max(1, o.dur)), now);
      if (now > total + DIV / 4) { this.stop(); return; }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    const was = this.playing; this.playing = false;
    for (const o of this.voices) { try { o.stop(); } catch (e) { /* already stopped */ } }
    this.voices = [];
    if (was && this.onStop) this.onStop();
  }
}

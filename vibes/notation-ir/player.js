// Web Audio playback shared by StaffInk and ScoreShift (the one browser-only module here;
// under bun it runs against a stubbed AudioContext). A small additive "felt piano" voice, a
// metronome click, and a lookahead scheduler: notes are handed to the audio clock a little
// ahead of time (AHEAD), so the speed can change while playing and timing never depends on
// the main thread. The apps' own Player classes add how they turn their score into notes.
//
// Clock: positions are in any unit (ticks for a score, seconds for a performance) with
// `rate` units per second at speed 1. tickAt re-anchors whenever the rate or speed changes.

export const AHEAD = 0.15; // seconds scheduled ahead of the audio clock

export class Player {
  /** opts: sustain (level a note decays to, x peak), previewDur, previewVel, defaultVel. */
  constructor(opts = {}) {
    this.opts = { sustain: 0.3, previewDur: 0.5, previewVel: 0.75, defaultVel: 0.75, ...opts };
    this.ctx = null; this.voices = []; this.playing = false; this.onStop = null;
    this.speed = 1; this.metronome = false; this.pos = 0; this.rate = 1;
  }

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

  voice(midi, t, dur, vel = this.opts.defaultVel) {
    const c = this.ctx, f = 440 * 2 ** ((midi - 69) / 12);
    const out = c.createGain(), lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 0.4;
    lp.frequency.setValueAtTime(Math.min(12000, f * 9), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(300, f * 2.2), t + 0.9);
    const decay = 0.9 + 2.2 * Math.max(0, (84 - midi) / 48), peak = vel * 0.22; // low notes ring longer
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(peak, t + 0.006);
    out.gain.setTargetAtTime(peak * this.opts.sustain, t + 0.01, decay / 3);
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

  /** Audition a chord right now (tap-to-hear). */
  preview(midis) { this.ensure(); const t = this.ctx.currentTime + 0.01; for (const m of midis) this.voice(m, t, this.opts.previewDur, this.opts.previewVel); }

  /** Clock position at audio time t. */
  tickAt(t) { return this.anchorTick + ((t - this.anchorTime) * this.rate * this.speed); }
  reanchor() { if (this.playing) { const now = this.ctx.currentTime; this.anchorTick = this.tickAt(now); this.anchorTime = now; } }
  setSpeed(x) { this.reanchor(); this.speed = x; }
  setRate(x) { this.reanchor(); this.rate = x; }

  /**
   * Play notes [{ at, dur, midi, vel }] (sorted by at; dur in the same units) and metronome
   * clicks [{ at, accent }] from position `from`, at `rate` units per second. onFrame(pos)
   * runs every animation frame; playback stops by itself after `end`.
   */
  schedule({ notes, clicks = [], end, rate = 1, from = 0, onFrame }) {
    this.stop(); this.ensure();
    this.rate = rate;
    this.anchorTime = this.ctx.currentTime + 0.08; this.anchorTick = from;
    let ni = notes.findIndex((n) => n.at >= from), bi = clicks.findIndex((b) => b.at >= from);
    if (ni < 0) ni = notes.length; if (bi < 0) bi = clicks.length;
    this.playing = true;
    const sec = () => 1 / (this.rate * this.speed);
    const pump = () => {
      if (!this.playing) return;
      const until = this.tickAt(this.ctx.currentTime + AHEAD), s = sec();
      for (; ni < notes.length && notes[ni].at < until; ni++) { const n = notes[ni]; this.voice(n.midi, this.anchorTime + (n.at - this.anchorTick) * s, n.dur * s, n.vel ?? this.opts.defaultVel); }
      for (; bi < clicks.length && clicks[bi].at < until; bi++) if (this.metronome) this.click(this.anchorTime + (clicks[bi].at - this.anchorTick) * s, clicks[bi].accent);
    };
    pump(); this.timer = setInterval(pump, 25);
    const frame = () => {
      if (!this.playing) return;
      pump();
      const now = (this.pos = this.tickAt(this.ctx.currentTime));
      onFrame && onFrame(now);
      if (now > end) { this.stop(); this.pos = 0; return; }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /**
   * Play a performance from playback.js perform(): notes in seconds, any number of cursors.
   * onTick(set of sounding ids, seconds, notes sounding now) every frame; idOf maps an IR
   * event id to the app's own id (null = not shown).
   */
  playPerformance(p, onTick, idOf = (id) => id) {
    this.schedule({
      notes: p.notes.map((n) => ({ at: n.t, dur: n.dur, midi: n.midi, vel: n.vel })), rate: 1, end: p.duration + 0.25,
      onFrame: (now) => {
        const on = p.notes.filter((n) => n.t <= now && now < n.t + Math.max(n.dur, 0.08));
        onTick && onTick(new Set(on.map((n) => idOf(n.event)).filter((id) => id != null)), now, on);
      },
    });
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) clearInterval(this.timer);
    this.raf = this.timer = null;
    const was = this.playing; this.playing = false;
    for (const o of this.voices) { try { o.stop(); } catch (e) { /* already stopped */ } }
    this.voices = [];
    if (was && this.onStop) this.onStop();
  }
}

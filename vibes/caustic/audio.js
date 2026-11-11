// audio.js - a low synthesised score for the sets, all Web Audio: two detuned brass-like drones a fifth apart
// through a slow-opening low-pass (the long swells of the film's score), a sub, and filtered noise for the
// water lapping in the troughs. Each set has its own root.
const ROOT = { corridor: 36.71, office: 32.7, hall: 41.2 }; // D1, C1, E1

export class Drone {
  constructor() { this.on = false; this.ctx = null; }
  start() {
    const C = this.ctx = new AudioContext(), out = C.createGain(); out.gain.value = 0; out.connect(C.destination); this.out = out;
    const rev = C.createConvolver(), len = C.sampleRate * 5, ir = C.createBuffer(2, len, C.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3; }
    rev.buffer = ir; const wet = C.createGain(); wet.gain.value = 0.6; rev.connect(wet); wet.connect(out);
    this.lp = C.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 220; this.lp.Q.value = 0.8;
    this.lp.connect(out); this.lp.connect(rev);
    this.osc = [];
    for (const [mul, det, g] of [[1, -7, 0.18], [1, 6, 0.18], [1.5, -4, 0.12], [1.5, 5, 0.12], [2, 3, 0.07], [0.5, 0, 0.25]]) {
      const o = C.createOscillator(); o.type = mul === 0.5 ? 'sine' : 'sawtooth'; o.detune.value = det;
      const a = C.createGain(); a.gain.value = g; o.connect(a); a.connect(this.lp); o.start(); this.osc.push([o, mul]);
    }
    // the swell: the filter breathes over about 14 s
    const lfo = C.createOscillator(), lg = C.createGain(); lfo.frequency.value = 0.07; lg.gain.value = 160; lfo.connect(lg); lg.connect(this.lp.frequency); lfo.start();
    // water: brown noise through a moving band-pass, in slow lapping gusts
    const nb = C.createBuffer(1, C.sampleRate * 4, C.sampleRate), nd = nb.getChannelData(0); let b = 0;
    for (let i = 0; i < nd.length; i++) { b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02; nd[i] = b * 3.5; }
    const ns = C.createBufferSource(); ns.buffer = nb; ns.loop = true;
    const bp = C.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.7;
    const wg = C.createGain(); wg.gain.value = 0.25;
    const l2 = C.createOscillator(), l2g = C.createGain(); l2.frequency.value = 0.31; l2g.gain.value = 0.18; l2.connect(l2g); l2g.connect(wg.gain); l2.start();
    ns.connect(bp); bp.connect(wg); wg.connect(out); wg.connect(rev); ns.start();
    this.set('corridor', true);
  }
  set(name, now) {
    if (!this.ctx || name === this.name) return; this.name = name;
    const f = ROOT[name] || 36.7, t = this.ctx.currentTime;
    for (const [o, mul] of this.osc) o.frequency.setTargetAtTime(f * 2 * mul, t, now ? 0.01 : 2.5);
  }
  toggle() {
    if (!this.ctx) this.start();
    this.on = !this.on; const t = this.ctx.currentTime;
    if (this.on) this.ctx.resume();
    this.out.gain.setTargetAtTime(this.on ? 0.22 : 0, t, 1.2);
  }
}

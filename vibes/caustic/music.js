/*
 * music.js - a slow cyberpunk score, synthesised in Web Audio, after the CS-80 sound of the Blade Runner scores:
 * swelling brass pads, a pulsing sequenced bass, a delayed arpeggio, a lonely lead, and a slow drum machine with
 * a huge gated snare. Everything is scheduled ahead on the audio clock (a 25 ms timer looks 150 ms ahead), so the
 * timing holds even when the page is busy rendering.
 *
 * The same `Score.step(i, when)` draws one sixteenth note, so the smoke test can render bars offline
 * (OfflineAudioContext) and check that it makes sound.
 */
const BPM = 84, STEP = 60 / BPM / 4; // a sixteenth note
const midi = (n) => 440 * 2 ** ((n - 69) / 12);
// D minor, four bars a chord: Dm(add9), Bbmaj7, Gm9, A7sus resolving to A. Each chord is the pad's notes.
const CHORDS = [
  { root: 38, pad: [50, 53, 57, 64], arp: [62, 65, 69, 72, 76, 72, 69, 65] },
  { root: 34, pad: [50, 53, 57, 58], arp: [58, 62, 65, 69, 74, 69, 65, 62] },
  { root: 31, pad: [50, 53, 55, 58], arp: [55, 58, 62, 65, 69, 65, 62, 58] },
  { root: 33, pad: [49, 52, 55, 57], arp: [57, 61, 64, 67, 69, 67, 64, 61] },
];
// the lead: a slow line over the 16 bars, [step in the 16-bar cycle, midi note, length in steps]
const LEAD = [[8, 69, 20], [32, 72, 8], [40, 70, 24], [72, 65, 12], [88, 67, 36], [136, 69, 8], [144, 74, 24], [176, 72, 12], [192, 70, 28], [232, 69, 24]];
const BASS = [0, 0, 12, 0, 0, 12, 0, 7, 0, 0, 12, 0, 0, 10, 12, 7]; // offsets from the root, a sixteenth each

export class Score {
  constructor(ctx, dest) {
    const C = this.ctx = ctx;
    this.out = C.createGain(); this.out.gain.value = 1; this.out.connect(dest);
    // a long dark hall for the pads and the snare
    const rev = this.rev = C.createConvolver(), len = Math.floor(C.sampleRate * 4.5), ir = C.createBuffer(2, len, C.sampleRate);
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = rnd() * (1 - i / len) ** 2.6; }
    rev.buffer = ir; const wet = C.createGain(); wet.gain.value = 0.55; rev.connect(wet); wet.connect(this.out);
    // a ping-pong delay at a dotted eighth, for the arpeggio and the lead
    const dl = C.createDelay(2), dr = C.createDelay(2), fb = C.createGain(), lp = C.createBiquadFilter(), merge = C.createChannelMerger(2);
    dl.delayTime.value = dr.delayTime.value = STEP * 3; fb.gain.value = 0.42; lp.type = 'lowpass'; lp.frequency.value = 2600;
    dl.connect(dr); dr.connect(lp); lp.connect(fb); fb.connect(dl);
    dl.connect(merge, 0, 0); dr.connect(merge, 0, 1); const dg = C.createGain(); dg.gain.value = 0.5; merge.connect(dg); dg.connect(this.out); dg.connect(rev);
    this.delay = dl;
    // the bus the kick ducks: everything but the drums breathes with the beat
    this.duck = C.createGain(); this.duck.connect(this.out); this.duck.connect(rev);
    const nb = this.noise = C.createBuffer(1, C.sampleRate, C.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = rnd();
  }
  voice(type, f, det, when, dur, gain, dest, { a = 0.01, r = 0.2, cut = 3000, cutEnd = cut, q = 1 } = {}) {
    const C = this.ctx, o = C.createOscillator(), fl = C.createBiquadFilter(), g = C.createGain();
    o.type = type; o.frequency.value = f; o.detune.value = det;
    fl.type = 'lowpass'; fl.Q.value = q; fl.frequency.setValueAtTime(cut, when); fl.frequency.exponentialRampToValueAtTime(Math.max(40, cutEnd), when + Math.max(0.02, dur));
    g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(gain, when + a); g.gain.setValueAtTime(gain, when + Math.max(a, dur)); g.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(a, dur) + r);
    o.connect(fl); fl.connect(g); g.connect(dest); o.start(when); o.stop(when + Math.max(a, dur) + r + 0.05);
  }
  hit(when, { f0 = 0, f1 = 0, decay = 0.3, gain = 0.5, noise = 0, hp = 0, bp = 0, dest = this.out }) {
    const C = this.ctx, g = C.createGain(); g.connect(dest);
    g.gain.setValueAtTime(gain, when); g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    if (f0) { const o = C.createOscillator(); o.frequency.setValueAtTime(f0, when); o.frequency.exponentialRampToValueAtTime(f1 || f0, when + 0.12); o.connect(g); o.start(when); o.stop(when + decay + 0.05); }
    if (noise) {
      const n = C.createBufferSource(), f = C.createBiquadFilter(), ng = C.createGain(); n.buffer = this.noise; ng.gain.value = noise;
      f.type = hp ? 'highpass' : 'bandpass'; f.frequency.value = hp || bp || 1800; f.Q.value = hp ? 0.7 : 1.2;
      n.connect(f); f.connect(ng); ng.connect(g); n.start(when, Math.random() * 0.5); n.stop(when + decay + 0.05);
    }
    return g;
  }
  // one sixteenth note: i counts sixteenths from the start
  step(i, when) {
    const bar = Math.floor(i / 16), s = i % 16, ch = CHORDS[Math.floor(bar / 4) % 4], C = this.ctx;
    // pads: at each chord change, detuned saws through a filter that opens over two bars, like a CS-80 swell
    if (bar % 4 === 0 && s === 0) {
      for (const n of ch.pad) for (const det of [-9, 0, 8]) this.voice('sawtooth', midi(n), det, when, STEP * 60, 0.028, this.duck, { a: STEP * 20, r: STEP * 10, cut: 380, cutEnd: 1500, q: 0.6 });
      this.voice('sine', midi(ch.root), 0, when, STEP * 60, 0.12, this.duck, { a: STEP * 8, r: STEP * 8, cut: 200 });
    }
    // bass: sixteenths on the root, a plucked square through a resonant filter that closes fast
    if (bar >= 4 || s % 4 === 0) this.voice('square', midi(ch.root + 12 + BASS[s]), 0, when, STEP * 0.55, 0.07, this.duck, { a: 0.004, r: 0.08, cut: 1700 + (s % 4 ? 0 : 900), cutEnd: 160, q: 7 });
    // arpeggio: eighths, a soft triangle into the delay, from bar 8 on
    if (bar >= 8 && s % 2 === 0) {
      const n = ch.arp[(s / 2 + bar) % 8], g = this.ctx.createGain(); g.gain.value = 1; g.connect(this.duck); g.connect(this.delay);
      this.voice('triangle', midi(n), 4, when, STEP * 0.8, 0.045, g, { a: 0.005, r: 0.25, cut: 4000, cutEnd: 900 });
    }
    // lead: a slow, vibrato-less square-saw line with a long glide-in, into the delay and the hall
    const k = i % 256;
    for (const [at, n, len] of LEAD) if (k === at && bar >= 16) {
      const g = C.createGain(); g.gain.value = 1; g.connect(this.duck); g.connect(this.delay);
      for (const [type, det] of [['sawtooth', -5], ['square', 6]]) this.voice(type, midi(n), det, when, STEP * len, 0.03, g, { a: STEP * 3, r: STEP * 8, cut: 1200, cutEnd: 2400, q: 1.5 });
    }
    // drums: kick on 1 and the "and" of 3, the big gated snare on 2 and 4, closed hats on the off-beats
    if (bar >= 2) {
      if (s === 0 || s === 10) {
        this.hit(when, { f0: 120, f1: 42, decay: 0.45, gain: 0.55 });
        this.duck.gain.setValueAtTime(0.45, when); this.duck.gain.linearRampToValueAtTime(1, when + STEP * 3);
      }
      if (s === 4 || s === 12) {
        const g = this.hit(when, { f0: 190, f1: 160, decay: 0.32, gain: 0.25, noise: 1.1, bp: 1900 });
        const send = C.createGain(); send.gain.value = 1.4; g.connect(send); send.connect(this.rev);
      }
      if (s % 4 === 2) this.hit(when, { decay: 0.05, gain: 0.08, noise: 1, hp: 7000 });
      if (s === 15 && bar % 4 === 3) this.hit(when, { decay: 0.25, gain: 0.07, noise: 1, hp: 5000 }); // an open hat into the chord change
    }
  }
}

// The live player: start / stop with a fade, scheduled ahead of the audio clock.
export class Music {
  constructor() { this.on = false; this.ctx = null; }
  start() {
    const C = this.ctx = new AudioContext(), master = this.master = C.createGain(); master.gain.value = 0;
    const comp = C.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3; master.connect(comp); comp.connect(C.destination);
    this.score = new Score(C, master); this.i = 0; this.next = C.currentTime + 0.1;
    this.timer = setInterval(() => this.tick(), 25);
  }
  tick() {
    if (!this.on) return;
    while (this.next < this.ctx.currentTime + 0.15) { this.score.step(this.i++, this.next); this.next += STEP; }
  }
  toggle() {
    if (!this.ctx) this.start();
    this.on = !this.on; const t = this.ctx.currentTime;
    if (this.on) { this.ctx.resume(); this.next = Math.max(this.next, t + 0.05); }
    this.master.gain.setTargetAtTime(this.on ? 0.5 : 0, t, this.on ? 0.6 : 0.4);
  }
}

// for the smoke test: render `bars` bars offline, give back the RMS level and the peak
export async function renderBars(bars = 4, from = 64) {
  const sr = 22050, C = new OfflineAudioContext(2, Math.ceil(sr * (bars * 16 * STEP + 3)), sr);
  const sc = new Score(C, C.destination);
  for (let k = 0; k < bars * 16; k++) sc.step(from + k, k * STEP);
  const buf = await C.startRendering(), d = buf.getChannelData(0);
  let m = 0, pk = 0; for (const v of d) { m += v * v; pk = Math.max(pk, Math.abs(v)); }
  return { rms: Math.sqrt(m / d.length), peak: pk, seconds: buf.duration };
}

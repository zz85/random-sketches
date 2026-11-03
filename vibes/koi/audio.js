// Pond sounds, all synthesised: a slow trickle of water, drops now and then, a bamboo
// shishi-odoshi every minute or so, and a plip for each touch and each mouthful.
export function makeAudio() {
  let ctx = null, master = null, verb = null, on = false, timers = [];
  const noiseBuffer = (sec, pink) => {
    const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate), d = b.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (!pink) { d[i] = w; continue; }
      b0 = 0.99765 * b0 + w * 0.099; b1 = 0.963 * b1 + w * 0.2965; b2 = 0.57 * b2 + w * 1.0526;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
    }
    return b;
  };
  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    // a small garden's reverb
    verb = ctx.createConvolver();
    const ir = ctx.createBuffer(2, ctx.sampleRate * 2.2, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3.2); }
    verb.buffer = ir; const vg = ctx.createGain(); vg.gain.value = 0.35; verb.connect(vg); vg.connect(master);
    // the trickle: pink noise in two bands, each breathing slowly
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(6, true); src.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 0.7;
    const g1 = ctx.createGain(); g1.gain.value = 0.16;
    const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 2400; hp.Q.value = 1.2;
    const g2 = ctx.createGain(); g2.gain.value = 0.035;
    src.connect(bp); bp.connect(g1); g1.connect(master);
    src.connect(hp); hp.connect(g2); g2.connect(master); g2.connect(verb);
    for (const [g, depth, rate] of [[g1.gain, 0.05, 0.07], [g2.gain, 0.02, 0.23]]) {
      const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = rate; lg.gain.value = depth; lfo.connect(lg); lg.connect(g); lfo.start();
    }
    src.start();
  }
  // a water drop: a resonance that rises as the bubble closes
  function plip(vol = 0.18, f0 = 500 + Math.random() * 500) {
    if (!on) return;
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * (2.2 + Math.random() * 0.8), t + 0.06);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0008, t + 0.13);
    o.connect(g); g.connect(master); g.connect(verb); o.start(t); o.stop(t + 0.15);
  }
  function gulp() { plip(0.14, 220 + Math.random() * 90); setTimeout(() => plip(0.06, 300 + Math.random() * 100), 70); }
  // shishi-odoshi: the bamboo arm tips, pours, and knocks on its stone
  function tok() {
    if (!on) return;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = noiseBuffer(0.2, false);
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1050; bp.Q.value = 9;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.9, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    n.connect(bp); bp.connect(g); g.connect(master); g.connect(verb); n.start(t);
    const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.value = 410; og.gain.setValueAtTime(0.22, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(og); og.connect(master); og.connect(verb); o.start(t); o.stop(t + 0.2);
  }
  const later = (fn, lo, hi) => { const id = setTimeout(() => { fn(); later(fn, lo, hi); }, (lo + Math.random() * (hi - lo)) * 1000); timers.push(id); };
  return {
    get on() { return on; },
    async toggle() {
      if (!ctx) build();
      on = !on;
      if (on) {
        await ctx.resume();
        master.gain.cancelScheduledValues(ctx.currentTime); master.gain.linearRampToValueAtTime(0.75, ctx.currentTime + 2.5);
        later(() => plip(0.05 + Math.random() * 0.05), 2, 8);
        later(tok, 35, 95);
      } else {
        master.gain.cancelScheduledValues(ctx.currentTime); master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
        timers.forEach(clearTimeout); timers = [];
      }
      return on;
    },
    plip, gulp, tok,
  };
}

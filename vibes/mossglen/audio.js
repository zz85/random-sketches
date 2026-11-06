// The glen's sound, all synthesised in Web Audio: the burn (two bands of noise and a babble of
// small bubbling plinks, louder as you come near the water), the wind (brown noise with gusts,
// and leaves rustling in the oaks), and birds: a robin's warble, a wren's trill, a chaffinch's
// run, a wood pigeon, and in the gloaming fewer songbirds and a tawny owl. Everything goes
// through a small generated reverb so the birds sound across the glen.

export function makeAudio() {
  let ctx = null, master = null, verb = null, on = false;
  let burnGain, burnLow, windGain, rustleGain, gust = 0.5, gustT = 0, babbleT = 0, birdT = 2, owlT = 20;
  const st = { burn: 0.5, wind: 0.5, light: 0, dry: 1 };

  function noiseBuffer(sec, brown) {
    const n = Math.round(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); let last = 0;
      for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w; }
    }
    return b;
  }
  function loop(buf) { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.loopStart = Math.random(); s.start(0, Math.random() * buf.duration); return s; }
  function reverb() {
    const n = Math.round(ctx.sampleRate * 2.6), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2); }
    const cv = ctx.createConvolver(); cv.buffer = b; return cv;
  }

  function init() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 3;
    master.connect(comp).connect(ctx.destination);
    verb = reverb(); const vg = ctx.createGain(); vg.gain.value = 0.35; verb.connect(vg).connect(master);
    const white = noiseBuffer(3, false), brown = noiseBuffer(4, true);
    // burn: a hiss over a lower churn
    burnGain = ctx.createGain(); burnGain.gain.value = 0; burnGain.connect(master);
    const b1 = ctx.createBiquadFilter(); b1.type = 'bandpass'; b1.frequency.value = 1500; b1.Q.value = 0.6;
    const b2 = ctx.createBiquadFilter(); b2.type = 'bandpass'; b2.frequency.value = 420; b2.Q.value = 0.9;
    burnLow = ctx.createGain(); burnLow.gain.value = 0.7;
    loop(white).connect(b1).connect(burnGain);
    loop(brown).connect(b2).connect(burnLow).connect(burnGain);
    // wind: brown noise low-passed, and the leaves
    windGain = ctx.createGain(); windGain.gain.value = 0; windGain.connect(master);
    const wl = ctx.createBiquadFilter(); wl.type = 'lowpass'; wl.frequency.value = 380;
    loop(brown).connect(wl).connect(windGain);
    rustleGain = ctx.createGain(); rustleGain.gain.value = 0; rustleGain.connect(master); rustleGain.connect(verb);
    const rh = ctx.createBiquadFilter(); rh.type = 'highpass'; rh.frequency.value = 2800;
    const rp = ctx.createBiquadFilter(); rp.type = 'peaking'; rp.frequency.value = 5000; rp.gain.value = 6;
    loop(white).connect(rh).connect(rp).connect(rustleGain);
  }

  // one sine voice with a pitch path and an envelope, panned and sent to the reverb
  function voice(t0, pts, { gain = 0.05, pan = 0, wet = 0.6, type = 'sine', attack = 0.006 } = {}) {
    const o = ctx.createOscillator(), g = ctx.createGain(), p = ctx.createStereoPanner();
    o.type = type; p.pan.value = pan;
    o.frequency.setValueAtTime(pts[0][1], t0);
    for (const [dt, f] of pts.slice(1)) o.frequency.exponentialRampToValueAtTime(f, t0 + dt);
    const end = t0 + pts[pts.length - 1][0];
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + attack); g.gain.setValueAtTime(gain, Math.max(t0 + attack, end - 0.02)); g.gain.linearRampToValueAtTime(0, end);
    o.connect(g).connect(p); p.connect(master); const w = ctx.createGain(); w.gain.value = wet; p.connect(w).connect(verb);
    o.start(t0); o.stop(end + 0.02);
  }
  const R = (a, b) => a + (b - a) * Math.random();

  function robin(t, pan, k) { // thin, varied, liquid warbling phrases
    let at = t;
    for (let i = 0, n = 4 + (Math.random() * 6) | 0; i < n; i++) {
      const f = R(2600, 6400), d = R(0.05, 0.16), f2 = f * R(0.6, 1.5);
      voice(at, [[0, f], [d * 0.5, f2], [d, f * R(0.8, 1.2)]], { gain: 0.02 * k, pan }); at += d + R(0.02, 0.09);
    }
  }
  function wren(t, pan, k) { // a loud fast trill, then a run
    let at = t; const base = R(3800, 5200);
    for (let i = 0; i < 26; i++) { const f = base * (1 + 0.15 * Math.sin(i * 1.7)); voice(at, [[0, f], [0.025, f * 1.25], [0.04, f * 0.9]], { gain: 0.018 * k, pan }); at += 0.05; }
  }
  function chaffinch(t, pan, k) { // a descending series and a flourish at the end
    let at = t, f = R(5200, 6200);
    for (let i = 0; i < 9; i++) { voice(at, [[0, f], [0.05, f * 0.85]], { gain: 0.02 * k, pan }); at += 0.085; f *= 0.95; }
    voice(at, [[0, f * 1.4], [0.08, f * 2], [0.2, f * 0.9]], { gain: 0.024 * k, pan });
  }
  function pigeon(t, pan, k) { // coo-COO-coo, coo-coo
    let at = t;
    for (const [d, a] of [[0.35, 0.7], [0.55, 1], [0.3, 0.7], [0.4, 0.7], [0.4, 0.6]]) {
      voice(at, [[0, R(480, 520)], [d * 0.4, 560], [d, 470]], { gain: 0.035 * a * k, pan, wet: 1, type: 'triangle', attack: 0.05 }); at += d + 0.08;
    }
  }
  function owl(t, pan) { // tawny owl: hoo... hu-hu-hoooo
    voice(t, [[0, 480], [0.15, 520], [0.9, 450]], { gain: 0.03, pan, wet: 1.2, type: 'triangle', attack: 0.08 });
    let at = t + 1.9;
    voice(at, [[0, 470], [0.18, 500]], { gain: 0.022, pan, wet: 1.2, type: 'triangle', attack: 0.04 }); at += 0.32;
    voice(at, [[0, 470], [0.2, 520], [1.4, 430]], { gain: 0.032, pan, wet: 1.2, type: 'triangle', attack: 0.06 });
  }

  return {
    get on() { return on; },
    async toggle(force) {
      const want = force ?? !on;
      if (want && !ctx) init();
      if (!ctx) return on;
      if (want) await ctx.resume();
      master.gain.setTargetAtTime(want ? 0.9 : 0, ctx.currentTime, 0.4);
      on = want; return on;
    },
    // burn 0..1 (nearness to the water), wind 0..1.5, light 0 mist .. 3 gloaming
    update(dt, { burn, wind, light, hidden }) {
      if (!ctx || !on) return;
      if (hidden) { master.gain.setTargetAtTime(0, ctx.currentTime, 0.1); return; }
      master.gain.setTargetAtTime(0.9, ctx.currentTime, 0.4);
      const t = ctx.currentTime;
      gustT -= dt; if (gustT <= 0) { gust = R(0.2, 1); gustT = R(2, 7); }
      const w = Math.min(1.5, wind) * gust;
      windGain.gain.setTargetAtTime(0.05 + 0.22 * w, t, 1.2);
      rustleGain.gain.setTargetAtTime(0.004 + 0.03 * w * w, t, 0.8);
      burnGain.gain.setTargetAtTime(0.025 + 0.22 * burn * burn, t, 0.5);
      burnLow.gain.setTargetAtTime(0.5 + 0.4 * Math.sin(t * 0.7) * Math.sin(t * 0.23), t, 0.3);
      // the babble: small bubbles bursting near the water
      babbleT -= dt;
      while (babbleT <= 0 && burn > 0.15) {
        babbleT += R(0.02, 0.12) / burn;
        const f = R(350, 1100); voice(t + R(0, 0.05), [[0, f], [0.03, f * R(1.3, 1.9)]], { gain: 0.012 * burn, pan: R(-0.7, 0.7), wet: 0.2, attack: 0.002 });
      }
      // birds: plenty by day, a few at dusk, owls in the gloaming
      const dusk = Math.max(0, Math.min(1, light - 2));
      birdT -= dt;
      if (birdT <= 0) {
        birdT = R(1.5, 6) * (1 + dusk * 4);
        const pan = R(-0.9, 0.9), k = R(0.5, 1), r = Math.random(), at = t + 0.05;
        if (r < 0.35) robin(at, pan, k); else if (r < 0.6) wren(at, pan, k); else if (r < 0.85) chaffinch(at, pan, k); else pigeon(at, pan, k);
      }
      if (dusk > 0.3) { owlT -= dt; if (owlT <= 0) { owlT = R(14, 30); owl(t + 0.1, R(-0.8, 0.8)); } }
    },
  };
}

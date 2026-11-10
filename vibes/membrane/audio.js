// audio.js - Membrane: wet sounds, all synthesised in Web Audio, no samples. The building blocks are the ones that
// make liquid sound liquid:
//   bubble   a sine whose pitch rises as it decays: a small air pocket ringing at its Minnaert frequency as it
//            closes up (Van den Doel's liquid-sound model). Many small ones read as wet; one low one is a plop
//   grain    a few ms of band-passed noise: the crackle of a wet seal parting, cell by cell
//   formant  noise through two resonant band-passes that glide like a mouth going "oo" to "ah": a squelch
//   bed      a running layer of filtered noise whose level and brightness follow how fast the membrane is
//            coming off: the sticky, sucking hiss of a peel in progress
// What the app reports (events) picks and scales them: peeling, tearing, threads being drawn out and snapping,
// a patch sticking back down, the pinch and the release.
export function makeAudio({ ctx: given = null } = {}) {
  let ctx = given, noise = null, out = null, bed = null, on = given ? true : localStorage.getItem('membrane.sound') !== '0';
  const rate = { peel: 0, stretch: 0 };
  let peelAcc = 0, peelNext = 30;
  const setup = () => {
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    out = ctx.createGain(); out.gain.value = 2.4;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4;
    // a little close, damp room: wet sounds dry and boxy without it
    const conv = ctx.createConvolver(), ir = ctx.createBuffer(2, ctx.sampleRate * 0.25, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const b = ir.getChannelData(c); for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.035)); }
    conv.buffer = ir;
    const wetG = ctx.createGain(); wetG.gain.value = 0.18;
    out.connect(comp); out.connect(conv); conv.connect(wetG); wetG.connect(comp); comp.connect(ctx.destination);
    // the running peel bed: pink-ish noise, low-passed, with a slow wobble so it sucks rather than hisses
    const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 3;
    const bp = ctx.createBiquadFilter(); bp.type = 'peaking'; bp.frequency.value = 900; bp.gain.value = 8; bp.Q.value = 2;
    const g = ctx.createGain(); g.gain.value = 0;
    const lfo = ctx.createOscillator(), lfoG = ctx.createGain(); lfo.frequency.value = 7; lfoG.gain.value = 180;
    lfo.connect(lfoG); lfoG.connect(lp.frequency);
    src.connect(lp); lp.connect(bp); bp.connect(g); g.connect(out); src.start(); lfo.start();
    bed = { g, lp, lfo };
  };
  const start = () => {
    if (ctx) { if (!out) setup(); if (ctx.state === 'suspended') ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)(); setup();
  };
  const R = (a, b) => a + Math.random() * (b - a);
  const env = (g, t, a, gain, dur) => { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); };

  // one bubble: f0 Hz, rising by `rise` (0.3 is a small bubble, 1+ a big gulpy one), over `dur` seconds
  const bubble = (t, f0, dur, gain, rise = 0.5) => {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f0 * (1 + rise), t + dur);
    const g = ctx.createGain(); env(g, t, 0.0015, gain, dur);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.02);
  };
  const grain = (t, freq, q, dur, gain) => {
    const s = ctx.createBufferSource(); s.buffer = noise; s.playbackRate.value = R(0.7, 1.2);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); env(g, t, 0.0006, gain, dur);
    s.connect(f); f.connect(g); g.connect(out); s.start(t, R(0, 0.9), dur + 0.01);
  };
  // a squelch: noise through two formants gliding from "oo" (300, 800 Hz) to "ah" (750, 1200 Hz), and back if `back`
  const squelch = (t, dur, gain, back = false, low = 1) => {
    const s = ctx.createBufferSource(); s.buffer = noise; s.playbackRate.value = R(0.4, 0.6);
    const g = ctx.createGain(); env(g, t, dur * 0.3, gain, dur);
    for (const [a, b, q] of [[300, 750, 9], [800, 1200, 7]]) {
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = q;
      f.frequency.setValueAtTime(a * low * R(0.85, 1.15), t);
      f.frequency.exponentialRampToValueAtTime(b * low * R(0.85, 1.15), t + dur * (back ? 0.5 : 0.9));
      if (back) f.frequency.exponentialRampToValueAtTime(a * low, t + dur);
      s.connect(f); f.connect(g);
    }
    g.connect(out); s.start(t, R(0, 0.9), dur + 0.02);
  };
  // a soft wet thump: a low sine falling in pitch, for a patch slapping down on the shell
  const thump = (t, gain) => {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(R(140, 190), t); o.frequency.exponentialRampToValueAtTime(55, t + 0.09);
    const g = ctx.createGain(); env(g, t, 0.003, gain, 0.12);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.14);
  };

  const voices = {
    // the pinch: lips parting, a tiny smack
    grab(t = ctx.currentTime + 0.005) { grain(t, 1800, 3, 0.012, 0.18); bubble(t + 0.004, R(900, 1300), 0.03, 0.08, 0.6); },
    // let go: the sheet flops, a damp slap and a little slurp
    release(t = ctx.currentTime + 0.005) { thump(t, 0.25); squelch(t + 0.01, 0.11, 0.2, true, 0.8); for (let k = 0; k < 3; k++) bubble(t + R(0.02, 0.12), R(500, 1400), R(0.02, 0.05), 0.05, 0.4); },
    // n vertices let go in one frame: a squelch for a burst, a fizz of grains and small bubbles for a steady peel
    peel(n, t0 = ctx.currentTime + 0.01, span = 1 / 30) {
      // a fizz kept low and sparse, so it sounds moist rather than frying: grains below 3 kHz, small bubbles,
      // as many as the peel rate asks for on average
      const ng = Math.min(8, Math.floor(n / 5 + Math.random()));
      for (let k = 0; k < ng; k++) grain(t0 + R(0, span), R(900, 3000), R(2, 5), R(0.003, 0.008), R(0.04, 0.1));
      const nb = Math.min(5, Math.floor(n / 10 + Math.random()));
      for (let k = 0; k < nb; k++) bubble(t0 + R(0, span), R(500, 1800), R(0.015, 0.04), R(0.03, 0.08), R(0.3, 1.0));
      // every few dozen vertices, a squelch, sooner and louder when it comes off in a rush
      peelAcc += n;
      if (peelAcc >= peelNext) { peelAcc = 0; peelNext = R(20, 60); squelch(t0 + R(0, span), R(0.06, 0.14), Math.min(0.32, 0.1 + n / 120), Math.random() < 0.3); }
    },
    // n links tore: a crackle, still a little wet
    tear(n, t0 = ctx.currentTime + 0.01, span = 1 / 30) {
      for (let k = 0; k < Math.min(22, Math.ceil(n / 3)); k++) grain(t0 + R(0, span), R(2200, 6000), 1.4, R(0.004, 0.012), R(0.2, 0.45));
      if (n > 6 && Math.random() < 0.4) bubble(t0 + R(0, span), R(1500, 3000), 0.02, 0.06, 0.8);
    },
    // a thread is drawn out of the shell: a gulp as it lets go of the surface
    draw(t = ctx.currentTime + R(0.01, 0.04)) { bubble(t, R(350, 600), R(0.05, 0.09), 0.12, 1.1); squelch(t, 0.08, 0.08, false, 1.3); },
    // a thread snaps: a bright plip as it parts, and a lower plop a moment later as its bead lands
    snap(t = ctx.currentTime + R(0.005, 0.03)) {
      bubble(t, R(1400, 2400), R(0.025, 0.04), 0.16, 0.9);
      grain(t, 3000, 2, 0.006, 0.1);
      bubble(t + R(0.25, 0.5), R(500, 800), R(0.05, 0.08), 0.09, 0.5);
    },
    // a peeled patch laid back on the wet shell sticks: a little suck and a soft thump
    stick(n, t = ctx.currentTime + 0.01) { thump(t, Math.min(0.2, 0.06 + n / 200)); squelch(t, 0.07, 0.07, true, 0.7); },
  };

  return {
    voices, get ctx() { return ctx; }, setup: () => { if (!out) setup(); },
    get on() { return on; },
    set on(v) { on = v; localStorage.setItem('membrane.sound', v ? '1' : '0'); if (v) start(); else if (ctx) ctx.suspend(); },
    unlock() { if (on) start(); },
    live() { return on && ctx && out && ctx.state === 'running'; },
    grab() { if (this.live()) voices.grab(); },
    // the round lost: a long wet rip and the sheet slumping
    lose() { if (!this.live()) return; const t = ctx.currentTime + 0.02; voices.tear(60, t, 0.35); squelch(t + 0.3, 0.35, 0.3, true, 0.6); thump(t + 0.55, 0.3); },
    // the round won: bubbles rising in a little arpeggio, one more for each star
    win(stars = 1) { if (!this.live()) return; const t = ctx.currentTime + 0.05; [523, 659, 784, 1047].slice(0, stars + 1).forEach((f, k) => bubble(t + k * 0.13, f, 0.16, 0.16, 0.12)); },
    release() { if (this.live()) voices.release(); },
    // per frame, since the last call: links broken, vertices let go, threads snapped, threads drawn, patches
    // stuck back, and how fast the attached threads lengthened (cm/s)
    events(dTear, dPeel, dSnap = 0, dDraw = 0, dStick = 0, stretch = 0, dt = 1 / 30) {
      if (!this.live()) return;
      const t = ctx.currentTime;
      if (dTear > 0) voices.tear(dTear);
      if (dPeel > 0) voices.peel(dPeel);
      for (let k = 0; k < Math.min(3, dSnap); k++) voices.snap();
      for (let k = 0; k < Math.min(2, dDraw); k++) voices.draw();
      if (dStick > 0) voices.stick(dStick);
      // the bed follows the peel rate (vertices a second), eased
      rate.peel += (dPeel / dt - rate.peel) * 0.25;
      rate.stretch += (stretch - rate.stretch) * 0.3;
      const level = Math.min(0.35, rate.peel / 900) + Math.min(0.12, rate.stretch / 60);
      bed.g.gain.setTargetAtTime(level, t, 0.05);
      bed.lp.frequency.setTargetAtTime(350 + Math.min(1400, rate.peel * 0.9), t, 0.08);
      bed.lfo.frequency.setTargetAtTime(5 + Math.min(14, rate.peel / 40), t, 0.1);
      // threads being drawn out creak: slow, low bubbles whose pitch climbs as they thin
      if (rate.stretch > 1.5 && Math.random() < Math.min(0.8, rate.stretch / 25)) bubble(t + R(0, dt), R(220, 420) * (1 + rate.stretch / 40), R(0.04, 0.08), 0.05, 1.4);
    },
  };
}

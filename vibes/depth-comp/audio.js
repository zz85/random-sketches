// audio.js - synthesised sound, no files. Two paths:
//   the water (outside you): the ocean's bed, the waves at the surface, the crackle of snapping
//     shrimp, bubble trains, the kicks' swish. It all goes through one low-pass filter that follows
//     your depth: bright with your head out at the surface, muffled under water, and duller and
//     quieter the deeper you go, until only a low rumble and the nearest sounds are left
//   the body (inside you): the heartbeat, the ears' click, a gulp, a breath. Heard through the
//     bones, so the depth hardly changes them
// Starts on the first press (browsers need a gesture). update(dt, depth, under) every frame.
export function makeAudio() {
  let ctx = null, water = null, body = null, lp = null, white = null, brown = null;
  let bedG, waveG, waveBP, crackG, rumbleG;
  let tCrack = 0, tBubble = 2, tWave = 0, depthNow = 0, underNow = false, cutoffNow = 12000;

  const wake = () => {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ctx = new AC();
    const master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
    // the water's path through the depth filter (two poles for a steeper roll-off)
    lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5; lp.frequency.value = cutoffNow;
    const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.Q.value = 0.5;
    lp.connect(lp2).connect(master);
    lp._two = lp2;
    water = ctx.createGain(); water.connect(lp);
    const bodyLp = ctx.createBiquadFilter(); bodyLp.type = 'lowpass'; bodyLp.frequency.value = 2400;
    body = ctx.createGain(); body.connect(bodyLp).connect(master);

    // noise: white, and brown (integrated) for the deep rumble
    const n = ctx.sampleRate * 3;
    white = ctx.createBuffer(1, n, ctx.sampleRate); brown = ctx.createBuffer(1, n, ctx.sampleRate);
    const w = white.getChannelData(0), b = brown.getChannelData(0); let last = 0;
    for (let i = 0; i < n; i++) { w[i] = Math.random() * 2 - 1; last = (last + 0.02 * w[i]) / 1.02; b[i] = last * 3.5; }
    const loop = (buf, dest) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.connect(dest); s.start(); return s; };

    // the bed: the hiss of moving water, and a low rumble that is all that is left deep down
    bedG = ctx.createGain(); bedG.gain.value = 0.05;
    const bedBP = ctx.createBiquadFilter(); bedBP.type = 'bandpass'; bedBP.frequency.value = 900; bedBP.Q.value = 0.4;
    loop(white, bedBP); bedBP.connect(bedG).connect(water);
    rumbleG = ctx.createGain(); rumbleG.gain.value = 0.1;
    const rumbleLP = ctx.createBiquadFilter(); rumbleLP.type = 'lowpass'; rumbleLP.frequency.value = 160;
    loop(brown, rumbleLP); rumbleLP.connect(rumbleG).connect(water);
    // the waves: noise swelling and breaking every few seconds (update moves gain and pitch)
    waveG = ctx.createGain(); waveG.gain.value = 0;
    waveBP = ctx.createBiquadFilter(); waveBP.type = 'bandpass'; waveBP.frequency.value = 500; waveBP.Q.value = 0.7;
    loop(white, waveBP); waveBP.connect(waveG).connect(water);
    // the crackle: snapping shrimp, short high clicks through a high-pass
    crackG = ctx.createGain(); crackG.gain.value = 0.5;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2200;
    crackG.connect(hp).connect(water);
    crackG._in = crackG;
  };

  const env = (g, t, a, peak, d) => { g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  const tone = (dest, f0, f1, t, a, d, peak, type = 'sine') => {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + a + d);
    env(g, t, a, peak, d); o.connect(g).connect(dest); o.start(t); o.stop(t + a + d + 0.05);
  };
  const hiss = (dest, t, dur, f, q, peak) => {
    const s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = white; bp.type = 'bandpass'; bp.frequency.setValueAtTime(f, t); bp.frequency.exponentialRampToValueAtTime(f * 0.5, t + dur); bp.Q.value = q;
    env(g, t, dur * 0.3, peak, dur * 0.7); s.connect(bp).connect(g).connect(dest); s.start(t, Math.random() * 2); s.stop(t + dur + 0.05);
  };
  // one snap: a burst of a few milliseconds of noise
  const snap = (t, peak) => {
    const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = white;
    g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.004 + Math.random() * 0.006);
    s.connect(g).connect(crackG); s.start(t, Math.random() * 2.5); s.stop(t + 0.015);
  };
  // a bubble: a sine whose pitch rises as it rings. Its pitch is the Minnaert resonance, about
  // 3.26 / radius (m) Hz near the surface: 650 Hz for a 5 mm bubble, 3.3 kHz for 1 mm
  const bubble = (t, size, peak) => {
    const f = 3260 / size;
    tone(water, f, f * 1.6, t, 0.002, 0.03 + size * 0.008, peak);
  };
  const ok = () => ctx && ctx.state === 'running';

  return {
    wake,
    // what the water sounds like here: called every frame with your depth (m) and whether your
    // head is under
    update(dt, depth, under) {
      if (!ok()) return;
      const t = ctx.currentTime;
      depthNow = depth; underNow = under;
      // the depth filter: 12 kHz in air, 4 kHz just under, falling to ~350 Hz at 60 m and below
      const cut = under ? Math.max(350, 4000 * Math.exp(-depth / 22)) : 12000;
      cutoffNow = cut;
      lp.frequency.setTargetAtTime(cut, t, 0.15); lp._two.frequency.setTargetAtTime(cut * 1.3, t, 0.15);
      water.gain.setTargetAtTime(under ? 0.6 + 0.4 * Math.exp(-depth / 30) : 1, t, 0.2);
      bedG.gain.setTargetAtTime(under ? 0.05 * Math.exp(-depth / 25) + 0.01 : 0.02, t, 0.3);
      rumbleG.gain.setTargetAtTime(under ? 0.12 + 0.08 * Math.min(1, depth / 40) : 0.05, t, 0.3);
      // waves: a swell every 4-7 s, loud in air, a muffled wash just under, gone by 15 m
      tWave += dt;
      const swell = Math.max(0, Math.sin(tWave * 1.2) * Math.sin(tWave * 0.37 + 1)) ** 2;
      const wl = (under ? 0.35 * Math.exp(-depth / 5) : 0.5) * (0.3 + 0.7 * swell);
      waveG.gain.setTargetAtTime(wl, t, 0.25); waveBP.frequency.setTargetAtTime(350 + 900 * swell, t, 0.3);
      // the crackle: snapping shrimp live on the bottom and the reef, loudest in the shallows
      const rate = under ? 35 * Math.exp(-depth / 30) + 4 : 6;
      tCrack -= dt; let k = 0;
      while (tCrack < 0 && k++ < 6) { snap(t + Math.random() * 0.03, 0.15 + 0.6 * Math.random() ** 3); tCrack += -Math.log(Math.random() + 1e-6) / rate; }
      if (tCrack < 0) tCrack = 0;
      // bubble trains: waves breaking overhead, a diver's exhale somewhere; rarer deeper
      tBubble -= dt;
      if (tBubble < 0) {
        const n = 3 + Math.floor(Math.random() * 10), near = under ? Math.exp(-depth / 12) : 0.6;
        for (let i = 0; i < n; i++) bubble(t + i * (0.03 + Math.random() * 0.07), 1 + Math.random() * 5, 0.05 + 0.1 * near * Math.random());
        tBubble = (under ? 2 + depth / 8 : 1.5) * (0.5 + Math.random());
      }
    },
    // a burst of bubbles close by: a splash at the surface, a duck dive, an exhale
    bubbles(n = 12, peak = 0.15) { if (!ok()) return; const t = ctx.currentTime; for (let i = 0; i < n; i++) bubble(t + i * (0.02 + Math.random() * 0.04), 1 + Math.random() * 4, peak * (0.5 + 0.5 * Math.random())); },
    splash() { if (!ok()) return; const t = ctx.currentTime; hiss(water, t, 0.6, 1400, 0.5, 0.4); this.bubbles(16, 0.18); },
    beat(v) { if (!ok()) return; const t = ctx.currentTime; tone(body, 62, 42, t, 0.01, 0.12, 0.35 * v); tone(body, 58, 40, t + 0.17, 0.01, 0.1, 0.22 * v); },
    swish(q, rope) { if (!ok()) return; const t = ctx.currentTime; hiss(water, t, rope ? 0.45 : 0.25, rope ? 700 : 500 + 400 * q, 1.2 + 3 * q, 0.25 + 0.15 * (1 - q)); },
    click(eff) { if (!ok()) return; const t = ctx.currentTime; if (eff > 0) { tone(body, 1800, 900, t, 0.002, 0.04, 0.12 * eff); tone(body, 320, 260, t, 0.005, 0.06, 0.15 * eff); } else tone(body, 180, 150, t, 0.01, 0.12, 0.12, 'triangle'); },
    gulp() { if (!ok()) return; const t = ctx.currentTime; tone(body, 240, 520, t, 0.01, 0.09, 0.2); },
    breath() { if (!ok()) return; const t = ctx.currentTime; hiss(body, t, 0.7, 900, 0.6, 0.35); },
    state() { return { running: ok(), cutoff: cutoffNow, depth: depthNow, under: underNow }; },
  };
}

// Pond sounds, all synthesised: a slow trickle of water, drops now and then, a bamboo
// shishi-odoshi every minute or so, and a plip for each touch and each mouthful. Rain is a
// soft hiss with short noise ticks for the drops, and the music is a slow generative piece in
// the in scale: plucked koto-like notes in short phrases with long rests, over a quiet drone,
// and now and then a breathy flute line.
export function makeAudio() {
  let ctx = null, master = null, verb = null, on = false, timers = [];
  let rainLevel = 0, rainBed = null, rainTimer = 0, musicMode = 'off', musicG = null, padG = null, padOsc = [], droneG = null, musicTimer = 0;
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
  // ---------- rain: a hiss that swells with the rain, and short ticks for the drops it is made of
  function buildRain() {
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(5, true); src.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 350;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
    rainBed = ctx.createGain(); rainBed.gain.value = 0;
    src.connect(hp); hp.connect(lp); lp.connect(rainBed); rainBed.connect(master); src.start();
  }
  function tick() {
    // one drop: a soft dull pat of noise (no ringing band, which is what sounds tinny), panned in front
    const t = ctx.currentTime + Math.random() * 0.1;
    const n = ctx.createBufferSource(); n.buffer = tickBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'lowpass'; bp.frequency.value = 900 + Math.random() * 1500; bp.Q.value = 0.3;
    const g = ctx.createGain(), v = (0.02 + Math.random() * 0.04) * (0.5 + rainLevel * 0.5);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.03 + Math.random() * 0.04);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    n.connect(bp); bp.connect(g);
    if (pan) { pan.pan.value = Math.random() * 1.6 - 0.8; g.connect(pan); pan.connect(master); } else g.connect(master);
    n.start(t); n.stop(t + 0.06);
  }
  let tickBuf = null;
  function rainLoop() {
    if (!on || rainLevel <= 0) { rainTimer = 0; return; }
    const n = rainLevel * 2.5; let k = Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
    while (k--) tick();
    rainTimer = setTimeout(rainLoop, 100);
  }
  function applyRain() {
    if (!ctx) return;
    if (!rainBed) { buildRain(); tickBuf = noiseBuffer(0.06, false); }
    rainBed.gain.cancelScheduledValues(ctx.currentTime);
    rainBed.gain.setTargetAtTime(on ? rainLevel * 0.045 : 0, ctx.currentTime, 1.2);
    if (on && rainLevel > 0 && !rainTimer) rainLoop();
  }

  // ---------- music: the in scale on D, plucked in short phrases with silence between them
  const SCALE = [0, 1, 5, 7, 8]; // D Eb G A Bb
  const hz = (deg, oct) => 146.83 * Math.pow(2, oct + (SCALE[((deg % 5) + 5) % 5] + 12 * Math.floor(deg / 5)) / 12);
  function pluck(f, t, vol = 0.12, pan = 0) {
    // koto-like: a bright attack that dulls as it rings, the upper harmonic dying first
    const out = ctx.createGain(); out.gain.value = vol;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(Math.min(5000, f * 9), t); lp.frequency.exponentialRampToValueAtTime(Math.max(250, f * 1.6), t + 1.4);
    const dur = 2.6 + 140 / f;
    for (const [m, a, d, type] of [[1, 1, dur, 'triangle'], [2, 0.35, dur * 0.45, 'sine'], [3, 0.12, dur * 0.25, 'sine']]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = f * m * (1 + (Math.random() - 0.5) * 0.0015);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(a, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0008, t + d);
      o.connect(g); g.connect(lp); o.start(t); o.stop(t + d + 0.05);
    }
    // the pick on the string
    const n = ctx.createBufferSource(); n.buffer = tickBuf || (tickBuf = noiseBuffer(0.06, false));
    const nb = ctx.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = f * 4; nb.Q.value = 2;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0.25, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
    n.connect(nb); nb.connect(ng); ng.connect(lp); n.start(t); n.stop(t + 0.05);
    lp.connect(out);
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; out.connect(p); p.connect(musicG); } else out.connect(musicG);
  }
  function flute(f, t, len, peak = 0.05) {
    // shakuhachi-like: breath first, the tone sliding up into the note, vibrato growing late
    const o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
    o.type = 'sine'; lp.type = 'lowpass'; lp.frequency.value = f * 3;
    o.frequency.setValueAtTime(f * 0.97, t); o.frequency.exponentialRampToValueAtTime(f, t + 0.5);
    const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 4.8; vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(f * 0.006, t + len * 0.8);
    vib.connect(vg); vg.connect(o.frequency);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + 0.6); g.gain.setValueAtTime(peak, t + len - 0.9); g.gain.linearRampToValueAtTime(0, t + len);
    const n = ctx.createBufferSource(); n.buffer = breathBuf; n.loop = true;
    const nb = ctx.createBiquadFilter(); nb.type = 'bandpass'; nb.frequency.value = f * 2; nb.Q.value = 3;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0, t); ng.gain.linearRampToValueAtTime(0.06, t + 0.15); ng.gain.linearRampToValueAtTime(0.012, t + 0.8); ng.gain.linearRampToValueAtTime(0, t + len);
    o.connect(lp); lp.connect(g); n.connect(nb); nb.connect(ng);
    g.connect(musicG); ng.connect(musicG);
    for (const s of [o, vib, n]) { s.start(t); s.stop(t + len + 0.1); }
  }
  let breathBuf = null, deg = 5, nextFlute = 0, bar = 0;
  function taiko(t, vol = 0.5) {
    // a big drum far off: a low thud falling in pitch, and the skin's soft slap
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(95, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.35);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.012); g.gain.exponentialRampToValueAtTime(0.001, t + 1.6);
    o.connect(g); g.connect(musicG); o.start(t); o.stop(t + 1.7);
    const n = ctx.createBufferSource(); n.buffer = breathBuf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
    const ng = ctx.createGain(); ng.gain.setValueAtTime(vol * 0.5, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    n.connect(lp); lp.connect(ng); ng.connect(musicG); n.start(t); n.stop(t + 0.2);
  }
  // the pad behind the flow: low strings on the open fifths of the scale, moving every two bars
  const CHORDS = [[0, 7, 12], [-5, 2, 7], [-2, 5, 12], [0, 7, 10]];
  function setPad(t, i) {
    CHORDS[i].forEach((st, k) => { for (const o of padOsc[k]) o.frequency.setTargetAtTime(73.42 * Math.pow(2, st / 12) * (o.detuneK || 1), t, 1.5); });
  }
  function flowBar() {
    // samurai ambience, flow: a slow pulse of 4 at 56 bpm, koto figures, a shakuhachi line, taiko
    if (!on || musicMode !== 'flow') { musicTimer = 0; return; }
    const beat = 60 / 56, t0 = ctx.currentTime + 0.15;
    if (bar % 2 === 0) setPad(t0, (bar / 2) % CHORDS.length);
    if (bar % 4 === 0) taiko(t0, 0.55);
    if (bar % 4 === 2 && Math.random() < 0.6) { taiko(t0 + beat * 2.5, 0.25); taiko(t0 + beat * 3, 0.4); }
    // koto: a quiet broken chord rising, now and then a falling answer
    const root = [0, -3, -1, 0][(bar >> 1) % 4] + 5;
    [0, 2, 3, 5].forEach((st, i) => { if (Math.random() < 0.85) pluck(hz(root + st, 0), t0 + i * beat * 0.5 + beat * (bar % 2), 0.05, (i - 1.5) * 0.25); });
    if (Math.random() < 0.4) pluck(hz(root + 7, 0), t0 + beat * 3.5, 0.07, 0.3);
    // shakuhachi: a held note most bars, stepping through the scale, with breaths between
    if (bar % 8 !== 7 && Math.random() < 0.75) {
      deg = Math.max(3, Math.min(10, deg + [-2, -1, 1, 1, 2, -1][Math.floor(Math.random() * 6)]));
      flute(hz(deg, 0), t0 + beat * (Math.random() < 0.5 ? 0 : 1), beat * (2.5 + Math.random() * 1.2), 0.08);
    }
    bar++;
    musicTimer = setTimeout(flowBar, beat * 4 * 1000);
  }
  function phrase() {
    // stillness: sparse koto phrases with long silences over the drone
    if (!on || musicMode !== 'still') { musicTimer = 0; return; }
    let t = ctx.currentTime + 0.1;
    const notes = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < notes; i++) {
      deg = Math.max(0, Math.min(11, deg + [-2, -1, -1, 1, 1, 2, 0][Math.floor(Math.random() * 7)]));
      pluck(hz(deg, 0), t, 0.1 + Math.random() * 0.05, (Math.random() - 0.5) * 0.6);
      if (Math.random() < 0.18) pluck(hz(deg - 5, 0), t + 0.02, 0.06, -0.2); // the octave below, now and then
      t += [0.45, 0.6, 0.9, 1.2][Math.floor(Math.random() * 4)];
    }
    if (ctx.currentTime > nextFlute && Math.random() < 0.35) {
      // a long held line after the phrase, low in the range
      flute(hz(Math.max(0, deg - 3 - Math.floor(Math.random() * 3)), 0), t + 0.8, 3.5 + Math.random() * 3);
      nextFlute = ctx.currentTime + 40 + Math.random() * 40;
    }
    // ma: the silence is part of it
    musicTimer = setTimeout(phrase, (t - ctx.currentTime + 2.5 + Math.random() * 6) * 1000);
  }
  function applyMusic() {
    if (!ctx) return;
    if (!musicG) {
      musicG = ctx.createGain(); musicG.gain.value = 1.7; musicG.connect(master);
      const mv = ctx.createGain(); mv.gain.value = 0.9; musicG.connect(mv); mv.connect(verb);
      breathBuf = noiseBuffer(2, false);
      // the drone: D and A low down, a little detuned, swelling slowly
      droneG = ctx.createGain(); droneG.gain.value = 0;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400;
      for (const [f, a] of [[73.42, 0.5], [73.6, 0.35], [110, 0.25], [146.83, 0.08]]) {
        const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = f; g.gain.value = a; o.connect(g); g.connect(lp); o.start();
      }
      const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.045; lg.gain.value = 0.012; lfo.connect(lg); lg.connect(droneG.gain); lfo.start();
      lp.connect(droneG); droneG.connect(musicG);
      // pad: two detuned saws per voice through a dark filter
      padG = ctx.createGain(); padG.gain.value = 0;
      const plp = ctx.createBiquadFilter(); plp.type = 'lowpass'; plp.frequency.value = 520; plp.Q.value = 0.4;
      padOsc = CHORDS[0].map(() => [0.997, 1.003].map((k) => { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.detuneK = k; o.frequency.value = 73.42 * k; const g = ctx.createGain(); g.gain.value = 0.18; o.connect(g); g.connect(plp); o.start(); return o; }));
      plp.connect(padG); padG.connect(musicG);
    }
    droneG.gain.cancelScheduledValues(ctx.currentTime);
    const live = on && musicMode !== 'off';
    droneG.gain.setTargetAtTime(live && musicMode === 'still' ? 0.03 : 0, ctx.currentTime, 2);
padG.gain.cancelScheduledValues(ctx.currentTime);
    padG.gain.setTargetAtTime(live && musicMode === 'flow' ? 0.05 : 0, ctx.currentTime, 2.5);
    clearTimeout(musicTimer); musicTimer = 0;
    if (live) musicTimer = setTimeout(musicMode === 'flow' ? flowBar : phrase, 1500);
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
        applyRain(); applyMusic();
      } else {
        master.gain.cancelScheduledValues(ctx.currentTime); master.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
        timers.forEach(clearTimeout); timers = [];
        clearTimeout(rainTimer); rainTimer = 0; clearTimeout(musicTimer); musicTimer = 0;
        applyRain(); applyMusic();
      }
      return on;
    },
    plip, gulp, tok,
    setRain(level) { rainLevel = level; applyRain(); },
    get music() { return musicMode; },
    async setMusic(m) { musicMode = m; if (m !== 'off' && !on) await this.toggle(); else applyMusic(); },
  };
}

// audio.js - the gallery's sound, all synthesised in Web Audio. Slow generative music played on
// wooden bars: a marimba-like mallet voice whose brightness follows the piece's wood and finish
// (padauk rings bright, as xylophone bars do; spalted beech is soft and dull), a melody walking a
// pentatonic scale on a motif drawn from the piece's seed, a low bar on each chord, and a pad that
// glides between four chords. Each light has its own key, chords and pace. Around it, the room: a
// faint air-handling hum, a whisper of sanding while a piece is carved, and a glass tink when the
// case goes on or comes off. Everything goes through a generated hall reverb.

const MOODS = {
  skylight: { root: 62, pulse: 0.8, density: 0.55, penta: [0, 2, 3, 7, 9], chords: [[0, 7, 14], [5, 12, 16], [-2, 5, 14], [3, 10, 14]] },
  window: { root: 67, pulse: 0.66, density: 0.62, penta: [0, 2, 4, 7, 9], chords: [[0, 7, 16], [2, 9, 18], [0, 7, 14], [-1, 6, 14]] },
  golden: { root: 63, pulse: 1.0, density: 0.5, penta: [0, 2, 4, 7, 9], chords: [[0, 7, 16], [-3, 4, 12], [5, 12, 16], [-5, 2, 9]] },
  studio: { root: 60, pulse: 1.1, density: 0.4, penta: [0, 2, 4, 7, 9], chords: [[0, 7, 14], [-3, 4, 12], [5, 12, 16], [7, 14, 17]] },
};
// how hard and bright each wood rings as a bar, 0..1
const HARD = { walnut: 0.55, oak: 0.5, cherry: 0.45, maple: 0.7, olive: 0.62, zebrano: 0.58, padauk: 0.9, ash: 0.52, spalted: 0.18 };
const FINISH = { oil: 0, wax: -0.06, lacquer: 0.12, bare: -0.04 };
const STEPS_PER_CHORD = 8;

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function makeAudio() {
  let ctx = null, master = null, verb = null, on = false, built = false;
  let pad = [], padFilter = null, sandGain = null, noise = null;
  const S = { mood: MOODS.skylight, hard: 0.55, carving: false, glass: false };
  // the music's place: the next step's time, the step count, the melody's index on the scale
  let next = 0, step = 0, idx = 5, motif = [], rnd = Math.random, lastReveal = -99, revealDue = false;
  let notes = 0;

  function noiseBuffer(sec, brown) {
    const n = Math.round(ctx.sampleRate * sec), b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); let last = 0;
      for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w; }
    }
    return b;
  }
  function loop(buf) { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, Math.random() * buf.duration); return s; }
  function hall() {
    // 4.5 s of decaying noise after a short pre-delay, darker as it dies: a big quiet room
    const sr = ctx.sampleRate, n = Math.round(sr * 4.5), pre = Math.round(sr * 0.025), b = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c); let lp = 0;
      for (let i = pre; i < n; i++) { const k = (i - pre) / (n - pre), a = 0.6 - 0.5 * k; lp = lp * a + (Math.random() * 2 - 1) * (1 - a); d[i] = lp * Math.pow(1 - k, 2.6) * 1.6; }
    }
    const cv = ctx.createConvolver(); cv.buffer = b; return cv;
  }

  function build(given) {
    ctx = given || new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = given ? 0.9 : 0;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 55; hp.Q.value = 0.6;
    master.connect(hp).connect(comp).connect(ctx.destination);
    verb = hall(); const vg = ctx.createGain(); vg.gain.value = 0.5; verb.connect(vg).connect(master);
    const white = noiseBuffer(3, false), brown = noiseBuffer(4, true);
    noise = white;
    // the room: an air-handling hum, low and steady
    const hum = ctx.createGain(); hum.gain.value = 0.014; hum.connect(master);
    const hl = ctx.createBiquadFilter(); hl.type = 'lowpass'; hl.frequency.value = 160;
    const hh = ctx.createBiquadFilter(); hh.type = 'highpass'; hh.frequency.value = 45;
    loop(brown).connect(hh).connect(hl).connect(hum);
    // sanding while the piece is carved: noise in the band of paper on wood, in strokes
    sandGain = ctx.createGain(); sandGain.gain.value = 0; sandGain.connect(master);
    const sb = ctx.createBiquadFilter(); sb.type = 'bandpass'; sb.frequency.value = 2600; sb.Q.value = 0.8;
    const ss = ctx.createBiquadFilter(); ss.type = 'highshelf'; ss.frequency.value = 5000; ss.gain.value = -8;
    loop(white).connect(sb).connect(ss).connect(sandGain);
    const sw = ctx.createGain(); sw.gain.value = 0.3; sandGain.connect(sw).connect(verb);
    // the pad: three voices of two detuned triangles each, under a slowly breathing low-pass
    padFilter = ctx.createBiquadFilter(); padFilter.type = 'lowpass'; padFilter.frequency.value = 620; padFilter.Q.value = 0.4;
    const pg = ctx.createGain(); pg.gain.value = 1; padFilter.connect(pg); pg.connect(master);
    const pw = ctx.createGain(); pw.gain.value = 0.8; pg.connect(pw).connect(verb);
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.05; lg.gain.value = 220; lfo.connect(lg).connect(padFilter.frequency); lfo.start();
    const ch = chordNotes(0);
    pad = ch.map((m, i) => {
      const g = ctx.createGain(), pan = ctx.createStereoPanner(); g.gain.value = 0.015 - i * 0.003; pan.pan.value = (i - 1) * 0.5;
      g.connect(pan).connect(padFilter);
      const os = [-4, 4].map((cents) => { const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = hz(m); o.detune.value = cents; o.connect(g); o.start(); return o; });
      return { os, g };
    });
    next = ctx.currentTime + 0.4; step = 0; built = true;
    if (!given && typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (on) master.gain.setTargetAtTime(document.hidden ? 0 : 0.9, ctx.currentTime, document.hidden ? 0.1 : 0.6); if (!document.hidden) next = Math.max(next, ctx.currentTime + 0.1); });
  }

  const chordOf = (s) => S.mood.chords[Math.floor(s / STEPS_PER_CHORD) % S.mood.chords.length];
  const chordNotes = (s) => chordOf(s).map((c) => S.mood.root - 12 + c);
  // the melody's scale: the pentatonic over two octaves and a bit, from a fifth below the key
  const scaleNote = (i) => { const p = S.mood.penta, o = Math.floor(i / p.length); return S.mood.root - 5 + p[((i % p.length) + p.length) % p.length] + 12 * o; };
  const IDX_MAX = 11;

  // a struck wooden bar: tuned partials near 1 : 4 : 10 as on a marimba, the upper ones dying first,
  // and a short knock of noise; harder woods ring brighter and longer
  function bar(t, midi, vel, pan = 0, wet = 0.55) {
    const f = hz(midi), h = Math.max(0, Math.min(1, S.hard)), out = ctx.createGain(), p = ctx.createStereoPanner();
    p.pan.value = pan; out.connect(p); p.connect(master); const w = ctx.createGain(); w.gain.value = wet; p.connect(w).connect(verb);
    const low = Math.max(0, Math.min(1, (84 - midi) / 44));
    const tau = (0.18 + 0.5 * low) * (0.6 + 0.8 * h);
    for (const [r, a, d] of [[1, 1, 1], [3.99, 0.28 + 0.4 * h, 0.35], [10.6, 0.06 + 0.22 * h * h, 0.14]]) {
      if (f * r > 12000) continue;
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = f * r * (1 + (Math.random() - 0.5) * 0.001);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * a, t + 0.0015); g.gain.setTargetAtTime(0, t + 0.0015, tau * d);
      o.connect(g).connect(out); o.start(t); o.stop(t + tau * d * 7 + 0.05);
    }
    const k = ctx.createBufferSource(), kb = ctx.createBiquadFilter(), kg = ctx.createGain();
    k.buffer = noise; kb.type = 'bandpass'; kb.frequency.value = Math.min(8000, f * 5); kb.Q.value = 1.2;
    kg.gain.setValueAtTime(0, t); kg.gain.linearRampToValueAtTime(vel * (0.05 + 0.18 * h), t + 0.001); kg.gain.setTargetAtTime(0, t, 0.006);
    k.connect(kb).connect(kg).connect(out); k.start(t, Math.random() * 2, 0.06);
    notes++;
  }
  // a glass pane touched: inharmonic partials of a thin plate, high and brief
  function tink(t, f0, vel) {
    const p = ctx.createStereoPanner(); p.pan.value = 0.15; p.connect(master); const w = ctx.createGain(); w.gain.value = 0.9; p.connect(w).connect(verb);
    for (const [r, a, d] of [[1, 1, 0.9], [2.76, 0.5, 0.5], [5.4, 0.3, 0.3], [8.93, 0.15, 0.18]]) {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = f0 * r;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * a, t + 0.001); g.gain.setTargetAtTime(0, t + 0.001, d * 0.35);
      o.connect(g).connect(p); o.start(t); o.stop(t + d * 3);
    }
  }

  function setChord(t, s) {
    const ch = chordNotes(s);
    pad.forEach((v, i) => v.os.forEach((o) => o.frequency.setTargetAtTime(hz(ch[i]), t, 0.9)));
  }
  // schedule the music up to time `until`
  function schedule(until) {
    if (!built) return;
    while (next < until) {
      const t = next, m = S.mood, inChord = step % STEPS_PER_CHORD;
      if (inChord === 0) {
        setChord(t, step);
        bar(t, chordNotes(step)[0], 0.11, -0.2, 0.7); // a low bar on the chord's root
      }
      if (revealDue) {
        // a new piece: the chord rising, an octave up
        revealDue = false; lastReveal = t;
        chordNotes(step).forEach((n, i) => bar(t + i * m.pulse * 0.25, n + 24, 0.1, 0.3 - i * 0.2, 0.8));
      } else {
        const mv = motif[step % motif.length];
        if (rnd() < m.density * mv.p) {
          idx += mv.d; if (idx > IDX_MAX) idx = IDX_MAX - (idx - IDX_MAX); if (idx < 0) idx = -idx;
          const n = scaleNote(idx), vel = 0.09 + 0.06 * mv.acc * rnd(), pan = (idx / IDX_MAX - 0.5) * 0.9;
          bar(t + (mv.swing ? m.pulse * 0.08 : 0), n, vel, pan);
          // now and then an echo of the note an octave up, softer, after a beat and a half
          if (rnd() < 0.18) bar(t + m.pulse * 1.5, n + 12, vel * 0.4, -pan, 0.9);
        }
      }
      next += m.pulse * (motif[step % motif.length].hold ? 2 : 1); step++;
    }
  }

  function reseed(seed) {
    const r = mulberry(seed * 2654435761);
    const len = 5 + Math.floor(r() * 4);
    motif = Array.from({ length: len }, () => ({ d: [-2, -1, -1, 1, 1, 2, 0, 3][Math.floor(r() * 8)], p: 0.75 + 0.6 * r(), acc: r(), swing: r() < 0.2, hold: r() < 0.15 }));
    rnd = mulberry(seed ^ 0x9e3779b9); idx = 3 + Math.floor(r() * 5);
  }
  reseed(1);

  return {
    get on() { return on; },
    get notes() { return notes; },
    get ctx() { return ctx; },
    async toggle(force) {
      const want = force ?? !on;
      if (want && !built) build();
      if (!built) return on;
      if (want) { await ctx.resume(); next = Math.max(next, ctx.currentTime + 0.1); }
      master.gain.setTargetAtTime(want ? 0.9 : 0, ctx.currentTime, want ? 0.6 : 0.3);
      on = want; return on;
    },
    // render into a given context (an OfflineAudioContext in the tests)
    attach(c) { build(c); on = true; },
    schedule,
    setLight(key) { const m = MOODS[key] || MOODS.skylight; if (m === S.mood) return; S.mood = m; step = Math.ceil(step / STEPS_PER_CHORD) * STEPS_PER_CHORD; if (built) setChord(ctx.currentTime, step); },
    setWood(wood, finish) { S.hard = (HARD[wood] ?? 0.5) + (FINISH[finish] ?? 0); },
    piece(seed) { reseed(seed); if (built && ctx.currentTime - lastReveal > 8) revealDue = true; },
    carving(c) { S.carving = c; if (built && !c) sandGain.gain.setTargetAtTime(0, ctx.currentTime, 0.15); },
    glass(g) { S.glass = g; if (built && on) tink(ctx.currentTime + 0.02, g ? 2900 : 2300, g ? 0.05 : 0.035); },
    update() {
      if (!built || !on) return;
      const t = ctx.currentTime;
      // sanding strokes, about two a second, uneven
      if (S.carving) { const s = Math.sin(t * Math.PI * 2 * 1.7) * 0.5 + 0.5; sandGain.gain.setTargetAtTime(0.008 + 0.03 * s * s, t, 0.04); }
      schedule(t + 0.3);
    },
  };
}

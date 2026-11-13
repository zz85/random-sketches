// audio.js - Oxide's Listen mode: sound for the paint to move to. A built-in track (a slow generated groove:
// kick, hats, a bass line and a pad over Am F C G, made with Web Audio), the microphone, or a file. An
// analyser turns it into 64 bands, log-spaced from 40 Hz to 12 kHz, and the waveform; 30 times a second they
// go into a new row of a ring of 256 rows (8.5 s) in a half-float texture (x the band's level, y the
// waveform, z its onsets): the waveform page (wave.js) reads it as a spectrum that scrolls over the plate.
import * as THREE from 'three/webgpu';

export const BANDS = 64, ROWS = 256, RATE = 30;

export function makeAudio() {
  const data = new Uint16Array(BANDS * ROWS * 4), H = THREE.DataUtils.toHalfFloat;
  const tex = new THREE.DataTexture(data, BANDS, ROWS, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter; tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  const A = { tex, head: 0, frac: 0, source: 'off', level: 0, beat: 0, ctx: null, an: null, node: null, stop: null };
  let acc = 0, freq = null, wave = null, edges = null, slow = new Float32Array(BANDS), peak = new Float32Array(BANDS), sm = new Float32Array(BANDS), tmp = new Float32Array(BANDS), test = 0;

  const ensure = () => {
    if (A.ctx) return A.ctx;
    const ctx = (A.ctx = new (window.AudioContext || window.webkitAudioContext)());
    A.an = ctx.createAnalyser(); A.an.fftSize = 4096; A.an.smoothingTimeConstant = 0.55; A.an.minDecibels = -90; A.an.maxDecibels = -20;
    freq = new Float32Array(A.an.frequencyBinCount); wave = new Float32Array(A.an.fftSize);
    const bin = ctx.sampleRate / A.an.fftSize;
    edges = [...Array(BANDS + 1)].map((_, i) => Math.max(1, Math.round((40 * Math.pow(12000 / 40, i / BANDS)) / bin)));
    return ctx;
  };
  const disconnect = () => { if (A.stop) A.stop(); A.stop = null; if (A.node) { try { A.node.disconnect(); } catch (e) {} } A.node = null; };

  // ---- the built-in track: scheduled a little ahead on a timer
  const track = (ctx) => {
    const out = ctx.createGain(); out.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor(); out.connect(comp); comp.connect(ctx.destination); comp.connect(A.an);
    const noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const nd = noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const BPM = 92, beat = 60 / BPM, chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]], bass = [45, 41, 36, 43];
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const env = (g, t, a, d, v) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
    const kick = (t) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(140, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.18); env(g, t, 0.003, 0.4, 0.9); o.connect(g); g.connect(out); o.start(t); o.stop(t + 0.5); };
    const hat = (t, v) => { const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = noise; f.type = 'highpass'; f.frequency.value = 7000; env(g, t, 0.002, 0.06, v); s.connect(f); f.connect(g); g.connect(out); s.start(t); s.stop(t + 0.1); };
    const snare = (t) => { const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = noise; f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.7; env(g, t, 0.002, 0.18, 0.35); s.connect(f); f.connect(g); g.connect(out); s.start(t); s.stop(t + 0.25); };
    const note = (t, m, len, type, cut, v) => {
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      o.type = o2.type = type; o.frequency.value = hz(m); o2.frequency.value = hz(m) * 1.004; f.type = 'lowpass'; f.frequency.setValueAtTime(cut * 2, t); f.frequency.exponentialRampToValueAtTime(cut, t + len * 0.6);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + Math.min(0.08, len * 0.3)); g.gain.setValueAtTime(v, t + len * 0.7); g.gain.linearRampToValueAtTime(0, t + len);
      o.connect(f); o2.connect(f); f.connect(g); g.connect(out); o.start(t); o2.start(t); o.stop(t + len + 0.05); o2.stop(t + len + 0.05);
    };
    let next = ctx.currentTime + 0.1, step = 0;
    const tick = () => {
      while (next < ctx.currentTime + 0.25) {
        const bar = Math.floor(step / 16) % 4, s = step % 16, t = next;
        if (s % 4 === 0) kick(t); if (s === 10) kick(t);
        if (s === 4 || s === 12) snare(t);
        hat(t, s % 2 ? 0.05 : 0.11);
        if (s % 4 === 0 || s === 7 || s === 14) note(t, bass[bar] + (s === 14 ? 12 : 0), beat * 0.45, 'sawtooth', 380, 0.22);
        if (s === 0) for (const m of chords[bar]) note(t, m, beat * 4, 'sawtooth', 1400, 0.045);
        if (s % 2 === 0) note(t, chords[bar][(s / 2) % 3] + 12 + (s > 8 ? 7 : 0), beat * 0.35, 'triangle', 3000, 0.05);
        next += beat / 4; step++;
      }
    };
    tick(); const id = setInterval(tick, 50);
    A.node = out; A.stop = () => { clearInterval(id); out.gain.setTargetAtTime(0, ctx.currentTime, 0.05); setTimeout(() => { try { comp.disconnect(); } catch (e) {} }, 300); };
  };

  // source: 'off', 'track', 'mic', a File, or 'test' (a sweep made here, for the smoke test: no sound at all)
  A.use = async (source) => {
    disconnect(); A.source = source instanceof File ? 'file' : source;
    if (source === 'off' || source === 'test') return;
    const ctx = ensure(); if (ctx.state === 'suspended') await ctx.resume();
    if (source === 'track') track(ctx);
    else if (source === 'mic') {
      const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const n = ctx.createMediaStreamSource(st); n.connect(A.an); A.node = n; A.stop = () => st.getTracks().forEach((t) => t.stop());
    } else if (source instanceof File) {
      const el = new Audio(URL.createObjectURL(source)); el.loop = true; await el.play();
      const n = ctx.createMediaElementSource(el); n.connect(A.an); n.connect(ctx.destination); A.node = n; A.stop = () => { el.pause(); URL.revokeObjectURL(el.src); };
    }
  };

  const row = new Float32Array(BANDS * 4);
  const take = () => {
    if (A.source === 'test') { // a sweep and a beat, so a headless run sees rings
      test += 1 / RATE; const c = (Math.sin(test * 0.9) * 0.5 + 0.5) * BANDS, kickv = Math.exp(-((test * 1.5) % 1) * 6);
      for (let b = 0; b < BANDS; b++) { row[b * 4] = Math.min(1, Math.exp(-(((b - c) / 5) ** 2)) + kickv * Math.exp(-b / 6)); row[b * 4 + 1] = Math.sin(b * 0.6 + test * 9) * 0.5; }
    } else if (A.an && A.source !== 'off') {
      A.an.getFloatFrequencyData(freq); A.an.getFloatTimeDomainData(wave);
      for (let b = 0; b < BANDS; b++) {
        let m = -140; for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) m = Math.max(m, freq[k]);
        const v = Math.min(1, Math.max(0, (m + 85 + b * 0.35) / 60)); // dB to 0..1, tilted up a little for the highs
        slow[b] += (v - slow[b]) * 0.04;
        peak[b] = Math.max(v, peak[b] * 0.9985); // an automatic gain for each band, so a quiet song still rises
        row[b * 4] = Math.min(1, v * 0.4 + (v / Math.max(0.25, peak[b])) * 0.6); row[b * 4 + 1] = wave[Math.floor((b / BANDS) * 1024)] * 1.5; row[b * 4 + 2] = Math.max(0, v - slow[b] - 0.05) * 3;
      }
    } else row.fill(0);
    // smooth the levels across bands (1 2 1) and in time (quick rise, slow fall), so the wave is a surface and not a spray
    for (let b = 0; b < BANDS; b++) tmp[b] = (row[Math.max(0, b - 1) * 4] + 2 * row[b * 4] + row[Math.min(BANDS - 1, b + 1) * 4]) / 4;
    for (let b = 0; b < BANDS; b++) { const t = tmp[b]; sm[b] += (t - sm[b]) * (t > sm[b] ? 0.55 : 0.18); row[b * 4] = sm[b]; }
    let lv = 0, lo = 0; for (let b = 0; b < BANDS; b++) { lv += row[b * 4]; if (b < 8) lo += row[b * 4]; }
    A.level = lv / BANDS; A.beat = Math.max(A.beat * 0.85, lo / 8);
    A.head = (A.head + 1) % ROWS;
    const o = A.head * BANDS * 4; for (let k = 0; k < BANDS * 4; k++) data[o + k] = H(row[k]); tex.needsUpdate = true;
  };
  // advance by dt: a row every 1/30 s
  A.update = (dt) => { acc += dt; let n = 0; while (acc >= 1 / RATE && n < 4) { acc -= 1 / RATE; take(); n++; } if (acc > 1) acc = 0; A.frac = acc * RATE; };
  A.levels = sm; // the newest row's levels, smoothed, for the plow
  A.clear = () => { data.fill(0); tex.needsUpdate = true; };
  return A;
}

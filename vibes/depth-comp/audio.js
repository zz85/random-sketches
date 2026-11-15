// audio.js - a few synthesised sounds, no files: the heartbeat (lub-dub, slowing with the dive
// reflex), the swish of a kick or a pull (cleaner for a good one), the click of the ears
// equalizing, a gulp for a pack or a mouthfill, and a recovery breath. Starts on the first press.
export function makeAudio() {
  let ctx = null, out = null, noise = null;
  const wake = () => {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    ctx = new AC(); out = ctx.createGain(); out.gain.value = 0.5;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400; // under water
    out.connect(lp).connect(ctx.destination);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const ch = noise.getChannelData(0); for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
  };
  const env = (g, t, a, peak, d) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); };
  const tone = (f0, f1, t, a, d, peak, type = 'sine') => {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + a + d);
    env(g, t, a, peak, d); o.connect(g).connect(out); o.start(t); o.stop(t + a + d + 0.05);
  };
  const hiss = (t, dur, f, q, peak) => {
    const s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise; bp.type = 'bandpass'; bp.frequency.setValueAtTime(f, t); bp.frequency.exponentialRampToValueAtTime(f * 0.5, t + dur); bp.Q.value = q;
    env(g, t, dur * 0.3, peak, dur * 0.7); s.connect(bp).connect(g).connect(out); s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.05);
  };
  const ok = () => ctx && ctx.state === 'running';
  return {
    wake,
    beat(v) { if (!ok()) return; const t = ctx.currentTime; tone(62, 42, t, 0.01, 0.12, 0.35 * v); tone(58, 40, t + 0.17, 0.01, 0.1, 0.22 * v); },
    swish(q, rope) { if (!ok()) return; const t = ctx.currentTime; hiss(t, rope ? 0.45 : 0.25, rope ? 700 : 500 + 400 * q, 1.2 + 3 * q, 0.25 + 0.15 * (1 - q)); },
    click(eff) { if (!ok()) return; const t = ctx.currentTime; if (eff > 0) { tone(1800, 900, t, 0.002, 0.04, 0.12 * eff); tone(320, 260, t, 0.005, 0.06, 0.15 * eff); } else tone(180, 150, t, 0.01, 0.12, 0.12, 'triangle'); },
    gulp() { if (!ok()) return; const t = ctx.currentTime; tone(240, 520, t, 0.01, 0.09, 0.2); },
    breath() { if (!ok()) return; const t = ctx.currentTime; hiss(t, 0.7, 900, 0.6, 0.35); },
  };
}

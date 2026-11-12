// audio.js - Rust: all Web Audio, no samples. Rain is filtered noise whose level follows the shower, with drops
// ticking on the sheet (a short band-passed click, pitched by where it lands); the tools are noise through
// resonances that follow how fast you drag: a scratch is a high narrow squeal of grit, the wire brush a broad
// rasp, the spray a hiss, the brush a soft swish. Paint flaking off is a sparse dry crackle.
export function makeAudio() {
  let ctx = null, out, rainG, rainF, toolG, toolF, toolF2, noiseBuf, tool = 0, on = false;
  const ensure = () => {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    out = ctx.createGain(); out.gain.value = 0.7; out.connect(ctx.destination);
    const n = ctx.sampleRate * 2; noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0); let b = 0; for (let i = 0; i < n; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.6 + b * 2; }
    const loop = () => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(); return s; };
    rainF = ctx.createBiquadFilter(); rainF.type = 'lowpass'; rainF.frequency.value = 1800; rainG = ctx.createGain(); rainG.gain.value = 0;
    loop().connect(rainF); rainF.connect(rainG); rainG.connect(out);
    toolF = ctx.createBiquadFilter(); toolF.type = 'bandpass'; toolF.Q.value = 6; toolF2 = ctx.createBiquadFilter(); toolF2.type = 'highpass'; toolF2.frequency.value = 400;
    toolG = ctx.createGain(); toolG.gain.value = 0; loop().connect(toolF); toolF.connect(toolF2); toolF2.connect(toolG); toolG.connect(out);
  };
  const click = (f, g, len = 0.012) => {
    const t = ctx.currentTime, s = ctx.createBufferSource(); s.buffer = noiseBuf; const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 9;
    const e = ctx.createGain(); e.gain.setValueAtTime(g, t); e.gain.exponentialRampToValueAtTime(0.0001, t + len);
    s.connect(bp); bp.connect(e); e.connect(out); s.start(t, Math.random() * 1.5, len + 0.02);
  };
  return {
    get on() { return on; },
    toggle() { ensure(); on = !on; if (on) ctx.resume(); else ctx.suspend(); return on; },
    // per frame: how hard it rains (0..1), whether the clock runs at a pace where single drops are heard
    rain(power, drops, dt) {
      if (!on) return;
      rainG.gain.setTargetAtTime(power * 0.12, ctx.currentTime, 0.3);
      rainF.frequency.setTargetAtTime(900 + power * 2200, ctx.currentTime, 0.3);
      if (drops && power > 0) { let k = power * 40 * dt; while (k > 0) { if (Math.random() < k) click(2200 + Math.random() * 3500, 0.05 + Math.random() * 0.06); k -= 1; } }
    },
    // a tool dragged at `speed` (sheet units a second): 1 scratch, 2 wire brush, 3 paint, 4 water
    tool(kind, speed) {
      if (!on) return;
      const t = ctx.currentTime, v = Math.min(1, speed / 3);
      if (kind !== tool) { tool = kind; const [f, q] = kind === 1 ? [4200, 9] : kind === 2 ? [2600, 1.2] : kind === 3 ? [700, 0.8] : [6000, 0.6]; toolF.frequency.setValueAtTime(f, t); toolF.Q.setValueAtTime(q, t); }
      const g = kind === 0 ? 0 : (kind === 4 ? 0.25 : kind === 3 ? 0.18 * v : kind === 2 ? 0.55 * v : 0.35 * v);
      toolG.gain.setTargetAtTime(g, t, 0.03);
      if (kind === 1 && v > 0.05) toolF.frequency.setTargetAtTime(3200 + v * 2500 + Math.random() * 600, t, 0.02);
    },
    crackle(n) { if (!on) return; for (let i = 0; i < Math.min(6, n); i++) setTimeout(() => click(1200 + Math.random() * 2000, 0.07, 0.006), Math.random() * 400); },
  };
}

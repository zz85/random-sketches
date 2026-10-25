// Ball impacts in the soundtrack. A squash ball hitting a racket, a wall or the floor is a sharp
// broadband crack: energy above ~2 kHz jumps by 10-30 dB inside a couple of milliseconds and dies
// within ~30 ms. Speech, crowd and shoe squeaks rise slower or are tonal. So: high-pass the audio,
// take the energy in 2 ms frames, and an onset is a frame whose log energy rises well above the
// recent background (median of the previous 150 ms) and is a local maximum of that rise.
//
//   onsets(samples: Float32Array (mono), rate, opt) -> [{ t, db, sharp }]   t in seconds
//   audioOffset(onsetTimes, impactTimes) -> seconds to add to the video times to get audio times
//     (broadcast audio and picture are often tens of ms apart; estimated from impacts both see)

export function onsets(x, rate, { hp = 2000, frame = 0.002, rise = 15, minGap = 0.06, floorDb = -62 } = {}) {
  // 2nd-order Butterworth high-pass, run twice (4th order)
  const y = biquadHP(biquadHP(x, rate, hp), rate, hp);
  const n = Math.max(1, Math.round(frame * rate)), N = Math.floor(y.length / n), e = new Float32Array(N);
  for (let i = 0; i < N; i++) { let s = 0; for (let j = i * n; j < (i + 1) * n; j++) s += y[j] * y[j]; e[i] = 10 * Math.log10(s / n + 1e-12); }
  const back = Math.round(0.15 / frame), out = [], win = [];
  // rolling median of the background via a sorted window (small: 75 values)
  let last = -Infinity;
  const d = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (i >= 2) { const lo = Math.max(0, i - back), sl = Array.from(e.subarray(lo, i - 1)).sort((a, b) => a - b); d[i] = e[i] - sl[sl.length >> 1]; }
  }
  for (let i = 2; i < N - 2; i++) {
    if (d[i] < rise || e[i] < floorDb) continue;
    if (!(d[i] >= d[i - 1] && d[i] >= d[i + 1] && d[i] >= d[i + 2])) continue;
    // sharp: most of the rise happens within 6 ms
    const sharp = e[i] - e[Math.max(0, i - 3)];
    if (sharp < 0.6 * rise) continue;
    const t = (i * n) / rate;
    if (t - last < minGap) { const p = out[out.length - 1]; if (p && d[i] > p.db) { p.t = t; p.db = d[i]; p.sharp = sharp; last = t; } continue; }
    out.push({ t, db: d[i], sharp }); last = t;
  }
  void win;
  return out;
}

function biquadHP(x, rate, f) {
  const w = 2 * Math.PI * f / rate, c = Math.cos(w), s = Math.sin(w), q = Math.SQRT1_2, a = s / (2 * q);
  const b0 = (1 + c) / 2, b1 = -(1 + c), b2 = (1 + c) / 2, a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  const y = new Float32Array(x.length); let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
  return y;
}

// The audio delay that lines the most impacts up with onsets: try offsets in 5 ms steps over
// ±0.3 s, count impacts with an onset within 20 ms, take the best. With a few onsets a second some
// impacts match at any offset by chance, so the best must stand well above the typical count
// (`sure`); otherwise the offset is not known (0, sure false).
export function audioOffset(on, imp, { range = 0.3, tol = 0.02 } = {}) {
  if (!on.length || !imp.length) return { offset: 0, matched: 0, sure: false };
  const counts = [];
  // most impacts matched; among equals, the smallest total mismatch
  let best = { offset: 0, matched: -1, err: Infinity };
  for (let o = -range; o <= range + 1e-9; o += 0.005) {
    let m = 0, err = 0; for (const t of imp) { const d = nearest(on, t + o); if (d < tol) { m++; err += d; } }
    counts.push(m);
    if (m > best.matched || (m === best.matched && err < best.err - 1e-9)) best = { offset: +o.toFixed(3), matched: m, err };
  }
  const med = counts.sort((a, b) => a - b)[counts.length >> 1], sure = best.matched >= 4 && best.matched >= 2 * med + 2;
  return { offset: sure ? best.offset : 0, matched: best.matched, chance: med, sure };
}
function nearest(sorted, t) { let lo = 0, hi = sorted.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < t) lo = m + 1; else hi = m; } let d = Math.abs(sorted[lo] - t); if (lo > 0) d = Math.min(d, Math.abs(sorted[lo - 1] - t)); return d; }

// Mono float samples of a media file in the browser (the video element's own file / blob).
export async function decodeAudio(url, rate = 32000) {
  const buf = await (await fetch(url)).arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, rate), ab = await ctx.decodeAudioData(buf);
  const ch = ab.numberOfChannels, n = ab.length, x = new Float32Array(n);
  for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < n; i++) x[i] += d[i] / ch; }
  return { x, rate: ab.sampleRate };
}

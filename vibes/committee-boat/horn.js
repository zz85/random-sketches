// Horn detector: finds the start of a horn blast in a stream of microphone spectra.
// A horn is loud AND tonal (a few strong harmonics), wind and engine noise are broadband
// or low, so a frame counts when the 250-2500 Hz band is `rise` dB over the running
// noise floor and its strongest bin stands `tonal` dB above the band's median bin.
// The blast must last `minMs`; the time reported is when it began, not when it was confirmed.
// Pure: feed it spectra (dB per bin, as AnalyserNode.getFloatFrequencyData gives) and times.
(function (root) {
  'use strict';
  class HornDetector {
    constructor(o = {}) {
      Object.assign(this, { lo: 250, hi: 2500, rise: 15, tonal: 12, minMs: 150, gapMs: 80, refractoryMs: 1200, floorTau: 4000, latencyMs: 0 }, o);
      this.reset();
    }
    reset() { this.floor = null; this.t = null; this.on = null; this.lastHit = null; this.fired = false; this.until = -Infinity; }
    step(spec, binHz, t) {
      const i0 = Math.max(1, Math.floor(this.lo / binHz)), i1 = Math.min(spec.length - 1, Math.ceil(this.hi / binHz));
      let p = 0, peak = -Infinity; const band = [];
      for (let i = i0; i <= i1; i++) { const d = spec[i]; if (!isFinite(d)) continue; p += Math.pow(10, d / 10); if (d > peak) peak = d; band.push(d); }
      const level = p > 0 ? 10 * Math.log10(p) : -200;
      band.sort((a, b) => a - b);
      const tonal = band.length ? peak - band[band.length >> 1] : 0;
      const dt = this.t == null ? 0 : Math.max(0, t - this.t); this.t = t;
      if (this.floor == null) this.floor = level;
      const hit = level > this.floor + this.rise && tonal > this.tonal;
      let onset = null;
      if (hit) {
        if (this.on == null || t - this.lastHit > this.gapMs) { this.on = t; this.fired = false; }
        this.lastHit = t;
        if (!this.fired && t - this.on >= this.minMs && this.on >= this.until) { this.fired = true; onset = this.on - this.latencyMs; this.until = t + this.refractoryMs; }
      } else {
        if (this.on != null && t - this.lastHit > this.gapMs) this.on = null;
        // noise floor follows the band level, quickly down, slowly up, never during a blast
        const tau = level < this.floor ? this.floorTau / 8 : this.floorTau;
        this.floor += (level - this.floor) * Math.min(1, dt / tau);
      }
      return { level, floor: this.floor, tonal, hit, onset };
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { HornDetector };
  else root.HornDetector = HornDetector;
})(typeof self !== 'undefined' ? self : this);

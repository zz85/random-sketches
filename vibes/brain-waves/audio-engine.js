/**
 * BrainWave Audio Engine
 * Generates binaural beats, isochronic tones, and noise layers
 * using the Web Audio API.
 */
class BrainWaveEngine {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.analyser = null;
    this.isPlaying = false;

    // Tone nodes
    this.binauralLeft = null;
    this.binauralRight = null;
    this.binauralGainL = null;
    this.binauralGainR = null;
    this.merger = null;
    this.isochronicOsc = null;
    this.isochronicGain = null;
    this.isochronicLFO = null;
    this.isochronicLFOGain = null;

    // Noise nodes
    this.noiseNodes = {};

    // State
    this.carrierFreq = 200;
    this.beatFreq = 10;
    this.toneType = 'binaural'; // 'binaural' | 'isochronic'
    this.volume = 0.5;
    this.noiseVolumes = { white: 0, pink: 0, brown: 0, rain: 0, ocean: 0, wind: 0 };
  }

  init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    // Master gain
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.volume;

    // Analyser for visualization
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.masterGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  // ─── Binaural Beats ──────────────────────────────────
  _createBinaural() {
    this._destroyBinaural();

    const ctx = this.ctx;
    this.merger = ctx.createChannelMerger(2);

    // Left ear
    this.binauralLeft = ctx.createOscillator();
    this.binauralLeft.type = 'sine';
    this.binauralLeft.frequency.value = this.carrierFreq;
    this.binauralGainL = ctx.createGain();
    this.binauralGainL.gain.value = 0.5;
    this.binauralLeft.connect(this.binauralGainL);
    this.binauralGainL.connect(this.merger, 0, 0);

    // Right ear
    this.binauralRight = ctx.createOscillator();
    this.binauralRight.type = 'sine';
    this.binauralRight.frequency.value = this.carrierFreq + this.beatFreq;
    this.binauralGainR = ctx.createGain();
    this.binauralGainR.gain.value = 0.5;
    this.binauralRight.connect(this.binauralGainR);
    this.binauralGainR.connect(this.merger, 0, 1);

    this.merger.connect(this.masterGain);
    this.binauralLeft.start();
    this.binauralRight.start();
  }

  _destroyBinaural() {
    [this.binauralLeft, this.binauralRight].forEach(osc => {
      if (osc) { try { osc.stop(); osc.disconnect(); } catch(e) {} }
    });
    [this.binauralGainL, this.binauralGainR, this.merger].forEach(n => {
      if (n) { try { n.disconnect(); } catch(e) {} }
    });
    this.binauralLeft = null;
    this.binauralRight = null;
    this.binauralGainL = null;
    this.binauralGainR = null;
    this.merger = null;
  }

  // ─── Isochronic Tones ────────────────────────────────
  _createIsochronic() {
    this._destroyIsochronic();

    const ctx = this.ctx;
    this.isochronicOsc = ctx.createOscillator();
    this.isochronicOsc.type = 'sine';
    this.isochronicOsc.frequency.value = this.carrierFreq;

    this.isochronicGain = ctx.createGain();
    this.isochronicGain.gain.value = 0; // modulated by LFO

    // LFO to pulse the tone on/off
    this.isochronicLFO = ctx.createOscillator();
    this.isochronicLFO.type = 'square';
    this.isochronicLFO.frequency.value = this.beatFreq;

    this.isochronicLFOGain = ctx.createGain();
    this.isochronicLFOGain.gain.value = 0.5;

    // Connect LFO -> gain modulation
    this.isochronicLFO.connect(this.isochronicLFOGain);
    this.isochronicLFOGain.connect(this.isochronicGain.gain);

    this.isochronicOsc.connect(this.isochronicGain);
    this.isochronicGain.connect(this.masterGain);

    this.isochronicOsc.start();
    this.isochronicLFO.start();
  }

  _destroyIsochronic() {
    [this.isochronicOsc, this.isochronicLFO].forEach(osc => {
      if (osc) { try { osc.stop(); osc.disconnect(); } catch(e) {} }
    });
    [this.isochronicGain, this.isochronicLFOGain].forEach(n => {
      if (n) { try { n.disconnect(); } catch(e) {} }
    });
    this.isochronicOsc = null;
    this.isochronicGain = null;
    this.isochronicLFO = null;
    this.isochronicLFOGain = null;
  }

  // ─── Noise Generators ────────────────────────────────
  _createNoiseBuffer(type) {
    const ctx = this.ctx;
    const sampleRate = ctx.sampleRate;
    const length = sampleRate * 4; // 4-second loop
    const buffer = ctx.createBuffer(2, length, sampleRate);

    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);

      if (type === 'white') {
        for (let i = 0; i < length; i++) {
          data[i] = Math.random() * 2 - 1;
        }
      } else if (type === 'pink') {
        // Paul Kellet's refined pink noise algorithm
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < length; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.96900 * b2 + white * 0.1538520;
          b3 = 0.86650 * b3 + white * 0.3104856;
          b4 = 0.55000 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.0168980;
          data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
          b6 = white * 0.115926;
        }
      } else if (type === 'brown') {
        let lastOut = 0;
        for (let i = 0; i < length; i++) {
          const white = Math.random() * 2 - 1;
          lastOut = (lastOut + (0.02 * white)) / 1.02;
          data[i] = lastOut * 3.5;
        }
      } else if (type === 'rain') {
        // Simulated rain: filtered noise bursts
        let b0 = 0, b1 = 0;
        for (let i = 0; i < length; i++) {
          const white = Math.random() * 2 - 1;
          // Band-pass feel
          b0 = 0.95 * b0 + white * 0.05;
          b1 = 0.85 * b1 + b0 * 0.15;
          const burst = Math.random() < 0.001 ? (Math.random() * 0.5) : 0;
          data[i] = (b1 * 0.7 + burst) * 0.8;
        }
      } else if (type === 'ocean') {
        // Simulated ocean: slow modulated noise
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate;
          const wave = Math.sin(2 * Math.PI * 0.1 * t) * 0.5 + 0.5; // 0.1 Hz wave cycle
          const noise = Math.random() * 2 - 1;
          // Low-pass by averaging
          data[i] = noise * wave * 0.4;
        }
        // Apply simple smoothing
        for (let i = 1; i < length; i++) {
          data[i] = data[i] * 0.3 + data[i-1] * 0.7;
        }
      } else if (type === 'wind') {
        // Slow-modulated filtered noise
        let prev = 0;
        for (let i = 0; i < length; i++) {
          const t = i / sampleRate;
          const mod = Math.sin(2 * Math.PI * 0.07 * t) * 0.4 + 0.5;
          const white = Math.random() * 2 - 1;
          prev = prev * 0.97 + white * 0.03;
          data[i] = prev * mod * 4;
        }
      }
    }
    return buffer;
  }

  _startNoise(type) {
    if (this.noiseNodes[type]) return;

    const source = this.ctx.createBufferSource();
    source.buffer = this._createNoiseBuffer(type);
    source.loop = true;

    const gain = this.ctx.createGain();
    gain.gain.value = this.noiseVolumes[type];

    source.connect(gain);
    gain.connect(this.masterGain);
    source.start();

    this.noiseNodes[type] = { source, gain };
  }

  _stopNoise(type) {
    if (!this.noiseNodes[type]) return;
    try {
      this.noiseNodes[type].source.stop();
      this.noiseNodes[type].source.disconnect();
      this.noiseNodes[type].gain.disconnect();
    } catch(e) {}
    delete this.noiseNodes[type];
  }

  setNoiseVolume(type, value) {
    this.noiseVolumes[type] = value;
    if (this.isPlaying) {
      if (value > 0) {
        if (!this.noiseNodes[type]) {
          this._startNoise(type);
        } else {
          this.noiseNodes[type].gain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.05);
        }
      } else {
        this._stopNoise(type);
      }
    }
  }

  // ─── Public API ──────────────────────────────────────
  setCarrierFreq(freq) {
    this.carrierFreq = freq;
    if (this.isPlaying) this._updateTones();
  }

  setBeatFreq(freq) {
    this.beatFreq = freq;
    if (this.isPlaying) this._updateTones();
  }

  setToneType(type) {
    this.toneType = type;
    if (this.isPlaying) {
      this._destroyBinaural();
      this._destroyIsochronic();
      this._startTones();
    }
  }

  setVolume(vol) {
    this.volume = vol;
    if (this.masterGain) {
      this.masterGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.05);
    }
  }

  _startTones() {
    if (this.toneType === 'binaural') {
      this._createBinaural();
    } else {
      this._createIsochronic();
    }
  }

  _updateTones() {
    if (this.toneType === 'binaural') {
      if (this.binauralLeft) {
        this.binauralLeft.frequency.setTargetAtTime(this.carrierFreq, this.ctx.currentTime, 0.05);
        this.binauralRight.frequency.setTargetAtTime(this.carrierFreq + this.beatFreq, this.ctx.currentTime, 0.05);
      }
    } else {
      if (this.isochronicOsc) {
        this.isochronicOsc.frequency.setTargetAtTime(this.carrierFreq, this.ctx.currentTime, 0.05);
        this.isochronicLFO.frequency.setTargetAtTime(this.beatFreq, this.ctx.currentTime, 0.05);
      }
    }
  }

  play() {
    this.init();
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this._startTones();

    // Start active noise layers
    Object.keys(this.noiseVolumes).forEach(type => {
      if (this.noiseVolumes[type] > 0) {
        this._startNoise(type);
      }
    });

    this.isPlaying = true;
  }

  stop() {
    this._destroyBinaural();
    this._destroyIsochronic();
    Object.keys(this.noiseNodes).forEach(type => this._stopNoise(type));
    this.isPlaying = false;
  }

  getAnalyserData() {
    if (!this.analyser) return null;
    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteTimeDomainData(dataArray);

    const freqData = new Uint8Array(bufferLength);
    this.analyser.getByteFrequencyData(freqData);

    return { waveform: dataArray, frequency: freqData, bufferLength };
  }
}

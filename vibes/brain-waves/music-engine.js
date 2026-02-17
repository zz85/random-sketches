/**
 * BrainWave Music Engine
 * Procedurally generated ambient music using Web Audio API.
 * No external audio files required.
 *
 * Styles:
 *   - ambient-pad:    Evolving polyphonic pads with slow chord changes
 *   - piano-ambient:  Gentle pentatonic piano-like melody
 *   - space-drone:    Deep evolving drone with overtones
 *   - singing-bowls:  Resonant bell-like tones with long decay
 *   - lo-fi:          Lo-fi filtered chords with vinyl crackle feel
 *   - gentle-arp:     Soft arpeggiated patterns
 */
class MusicEngine {
  constructor() {
    this.ctx = null;
    this.outputGain = null;
    this.volume = 0;
    this.style = 'none';
    this.isPlaying = false;
    this._nodes = [];
    this._timers = [];
    this._schedulerHandle = null;

    // Musical data
    this._chordProgressions = {
      calm: [
        [261.63, 329.63, 392.00],  // C maj
        [220.00, 277.18, 329.63],  // A min
        [174.61, 220.00, 261.63],  // F maj
        [196.00, 246.94, 293.66],  // G maj
      ],
      dreamy: [
        [261.63, 311.13, 392.00],  // Cm
        [233.08, 293.66, 349.23],  // Bb
        [207.65, 261.63, 311.13],  // Ab
        [233.08, 293.66, 349.23],  // Bb
      ],
      ethereal: [
        [261.63, 329.63, 415.30],  // Cmaj7 partial
        [293.66, 369.99, 440.00],  // Dm7 partial
        [246.94, 311.13, 392.00],  // Bm partial (dreamy)
        [220.00, 277.18, 349.23],  // Am add partial
      ],
    };

    // Pentatonic scales for melodies (C pentatonic, multiple octaves)
    this._pentatonic = [
      130.81, 146.83, 164.81, 196.00, 220.00,  // C4 pentatonic low
      261.63, 293.66, 329.63, 392.00, 440.00,  // C5 pentatonic mid
      523.25, 587.33, 659.25, 783.99, 880.00,  // C6 pentatonic high
    ];

    this._arpNotes = [
      261.63, 329.63, 392.00, 523.25,  // C major arpeggio
      220.00, 261.63, 329.63, 440.00,  // Am arpeggio
      174.61, 220.00, 261.63, 349.23,  // F major arpeggio
      196.00, 246.94, 293.66, 392.00,  // G major arpeggio
    ];
  }

  /**
   * Attach to an existing AudioContext and gain node.
   * @param {AudioContext} ctx
   * @param {GainNode} destination - the node to connect output to
   */
  attach(ctx, destination) {
    this.ctx = ctx;
    this.outputGain = ctx.createGain();
    this.outputGain.gain.value = this.volume;
    this.outputGain.connect(destination);
  }

  setVolume(vol) {
    this.volume = vol;
    if (this.outputGain && this.ctx) {
      this.outputGain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.1);
    }
  }

  setStyle(style) {
    const wasPlaying = this.isPlaying;
    if (wasPlaying) this.stop();
    this.style = style;
    if (wasPlaying && style !== 'none') this.start();
  }

  start() {
    if (!this.ctx || this.style === 'none') return;
    this.isPlaying = true;

    switch (this.style) {
      case 'ambient-pad': this._startAmbientPad(); break;
      case 'piano-ambient': this._startPianoAmbient(); break;
      case 'space-drone': this._startSpaceDrone(); break;
      case 'singing-bowls': this._startSingingBowls(); break;
      case 'lo-fi': this._startLoFi(); break;
      case 'gentle-arp': this._startGentleArp(); break;
    }
  }

  stop() {
    this.isPlaying = false;
    this._timers.forEach(id => clearTimeout(id));
    this._timers = [];
    if (this._schedulerHandle) {
      clearInterval(this._schedulerHandle);
      this._schedulerHandle = null;
    }
    this._nodes.forEach(n => {
      try {
        if (n.stop) n.stop();
        n.disconnect();
      } catch(e) {}
    });
    this._nodes = [];
  }

  // ─── Helper: tracked node creation ───────────────────
  _osc(type, freq) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    this._nodes.push(o);
    return o;
  }

  _gain(val) {
    const g = this.ctx.createGain();
    g.gain.value = val;
    this._nodes.push(g);
    return g;
  }

  _filter(type, freq, Q) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    if (Q !== undefined) f.Q.value = Q;
    this._nodes.push(f);
    return f;
  }

  _delay(time) {
    const d = this.ctx.createDelay(5);
    d.delayTime.value = time;
    this._nodes.push(d);
    return d;
  }

  _schedule(fn, ms) {
    const id = setTimeout(() => {
      if (this.isPlaying) fn();
    }, ms);
    this._timers.push(id);
    return id;
  }

  // ─── Reverb-like effect using feedback delay network ─
  _createReverb(decayTime) {
    const ctx = this.ctx;
    const input = this._gain(1);
    const output = this._gain(0.7);
    const dry = this._gain(0.6);
    const wet = this._gain(0.4);

    input.connect(dry);
    dry.connect(output);

    // Simple multi-tap delay reverb
    const delays = [0.037, 0.059, 0.083, 0.117];
    delays.forEach(t => {
      const d = this._delay(t);
      const fb = this._gain(decayTime);
      const lp = this._filter('lowpass', 2500);
      input.connect(d);
      d.connect(lp);
      lp.connect(fb);
      fb.connect(d); // feedback loop
      lp.connect(wet);
    });

    wet.connect(output);
    return { input, output };
  }

  // ─── Style: Ambient Pad ─────────────────────────────
  _startAmbientPad() {
    const reverb = this._createReverb(0.55);
    reverb.output.connect(this.outputGain);

    const progression = this._chordProgressions.ethereal;
    let chordIdx = 0;

    const playChord = () => {
      if (!this.isPlaying) return;
      const chord = progression[chordIdx % progression.length];
      chordIdx++;

      chord.forEach((freq, i) => {
        // Each note is 2-3 detuned oscillators for richness
        for (let d = -6; d <= 6; d += 6) {
          const osc = this._osc('sine', freq + d + Math.random() * 2);
          const g = this._gain(0);
          osc.connect(g);
          g.connect(reverb.input);
          osc.start();

          const now = this.ctx.currentTime;
          const attack = 2 + Math.random();
          const sustain = 4 + Math.random() * 2;
          const release = 3 + Math.random();

          g.gain.setTargetAtTime(0.06, now, attack * 0.3);
          g.gain.setTargetAtTime(0.04, now + attack + sustain, 0.5);
          g.gain.setTargetAtTime(0, now + attack + sustain + release * 0.5, release * 0.3);

          this._schedule(() => {
            try { osc.stop(); } catch(e) {}
          }, (attack + sustain + release + 1) * 1000);
        }
      });

      // Next chord
      this._schedule(playChord, 8000 + Math.random() * 4000);
    };

    playChord();
  }

  // ─── Style: Piano Ambient ───────────────────────────
  _startPianoAmbient() {
    const reverb = this._createReverb(0.5);
    reverb.output.connect(this.outputGain);

    const scale = this._pentatonic;

    const playNote = () => {
      if (!this.isPlaying) return;

      const freq = scale[Math.floor(Math.random() * scale.length)];
      const now = this.ctx.currentTime;

      // Piano-like: sharp attack, quick decay, filtered
      const osc1 = this._osc('triangle', freq);
      const osc2 = this._osc('sine', freq * 2.01); // slight harmonic
      const g = this._gain(0);
      const filter = this._filter('lowpass', 1500 + Math.random() * 1000, 2);

      osc1.connect(g);
      osc2.connect(this._gain(0.02)); // subtle overtone
      this._nodes[this._nodes.length - 1].connect(g);
      g.connect(filter);
      filter.connect(reverb.input);

      osc1.start();
      osc2.start();

      // Sharp attack, exponential decay
      g.gain.setTargetAtTime(0.12, now, 0.01);
      g.gain.setTargetAtTime(0, now + 0.08, 0.8);

      this._schedule(() => {
        try { osc1.stop(); osc2.stop(); } catch(e) {}
      }, 5000);

      // Next note: variable timing for organic feel
      const nextDelay = 800 + Math.random() * 2200;
      this._schedule(playNote, nextDelay);
    };

    playNote();
  }

  // ─── Style: Space Drone ─────────────────────────────
  _startSpaceDrone() {
    const reverb = this._createReverb(0.65);
    reverb.output.connect(this.outputGain);

    // Deep fundamental
    const baseFreq = 55; // A1
    const harmonics = [1, 1.5, 2, 3, 4, 5.02, 6, 7.01];

    harmonics.forEach((h, i) => {
      const osc = this._osc('sine', baseFreq * h);
      const g = this._gain(0.04 / (i + 1));
      const lfo = this._osc('sine', 0.02 + Math.random() * 0.05);
      const lfoGain = this._gain(0.01 / (i + 1));

      lfo.connect(lfoGain);
      lfoGain.connect(g.gain);
      osc.connect(g);
      g.connect(reverb.input);

      osc.start();
      lfo.start();
    });

    // Slow evolving filtered noise layer
    const noiseG = this._gain(0.015);
    const noiseLp = this._filter('bandpass', 200, 3);
    const noiseLfo = this._osc('sine', 0.03);
    const noiseLfoG = this._gain(150);
    noiseLfo.connect(noiseLfoG);
    noiseLfoG.connect(noiseLp.frequency);

    const bufSize = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, bufSize, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    this._nodes.push(src);

    src.connect(noiseLp);
    noiseLp.connect(noiseG);
    noiseG.connect(reverb.input);

    src.start();
    noiseLfo.start();
  }

  // ─── Style: Singing Bowls ───────────────────────────
  _startSingingBowls() {
    const reverb = this._createReverb(0.6);
    reverb.output.connect(this.outputGain);

    // Singing bowl frequencies (tuned to harmonious intervals)
    const bowlFreqs = [174.61, 261.63, 329.63, 392.00, 523.25, 659.25];

    const playBowl = () => {
      if (!this.isPlaying) return;

      const freq = bowlFreqs[Math.floor(Math.random() * bowlFreqs.length)];
      const now = this.ctx.currentTime;

      // Singing bowl: fundamental + inharmonic partials
      const partials = [1, 2.71, 4.16, 5.43];
      partials.forEach((p, i) => {
        const osc = this._osc('sine', freq * p);
        const g = this._gain(0);
        osc.connect(g);
        g.connect(reverb.input);
        osc.start();

        const amp = 0.06 / (i + 1);
        const attack = 0.3 + Math.random() * 0.5;
        const decay = 4 + Math.random() * 4;

        g.gain.setTargetAtTime(amp, now, attack * 0.3);
        g.gain.setTargetAtTime(0, now + attack + 0.5, decay * 0.3);

        this._schedule(() => {
          try { osc.stop(); } catch(e) {}
        }, (attack + 0.5 + decay + 2) * 1000);
      });

      this._schedule(playBowl, 4000 + Math.random() * 6000);
    };

    playBowl();
  }

  // ─── Style: Lo-Fi ───────────────────────────────────
  _startLoFi() {
    // Lo-fi: filtered chords, bit-crushed feel, slow tempo
    const lpFilter = this._filter('lowpass', 800, 1);
    const hpFilter = this._filter('highpass', 200, 0.5);
    lpFilter.connect(hpFilter);
    hpFilter.connect(this.outputGain);

    const reverb = this._createReverb(0.45);
    reverb.output.connect(lpFilter);

    const progression = this._chordProgressions.calm;
    let chordIdx = 0;

    const playChord = () => {
      if (!this.isPlaying) return;
      const chord = progression[chordIdx % progression.length];
      chordIdx++;

      // Lo-fi: lower octave, warm waveforms
      chord.forEach(freq => {
        const f = freq / 2; // Lower octave
        const osc1 = this._osc('triangle', f);
        const osc2 = this._osc('sawtooth', f * 1.002); // slight detune
        const g1 = this._gain(0);
        const g2 = this._gain(0);

        osc1.connect(g1);
        osc2.connect(g2);
        g1.connect(reverb.input);
        g2.connect(reverb.input);

        osc1.start();
        osc2.start();

        const now = this.ctx.currentTime;
        const amp = 0.05;
        // Soft attack, moderate sustain, slow release
        g1.gain.setTargetAtTime(amp, now, 0.3);
        g2.gain.setTargetAtTime(amp * 0.3, now, 0.3);
        g1.gain.setTargetAtTime(0, now + 3, 1.5);
        g2.gain.setTargetAtTime(0, now + 3, 1.5);

        this._schedule(() => {
          try { osc1.stop(); osc2.stop(); } catch(e) {}
        }, 9000);
      });

      this._schedule(playChord, 6000 + Math.random() * 2000);
    };

    // Add subtle vinyl crackle
    const crackleGain = this._gain(0.008);
    const crackleLp = this._filter('bandpass', 3000, 1);
    const crackleLen = this.ctx.sampleRate * 2;
    const crackleBuf = this.ctx.createBuffer(1, crackleLen, this.ctx.sampleRate);
    const cd = crackleBuf.getChannelData(0);
    for (let i = 0; i < crackleLen; i++) {
      cd[i] = Math.random() < 0.01 ? (Math.random() * 2 - 1) : 0;
    }
    const crackleSrc = this.ctx.createBufferSource();
    crackleSrc.buffer = crackleBuf;
    crackleSrc.loop = true;
    this._nodes.push(crackleSrc);

    crackleSrc.connect(crackleLp);
    crackleLp.connect(crackleGain);
    crackleGain.connect(this.outputGain);
    crackleSrc.start();

    playChord();
  }

  // ─── Style: Gentle Arpeggio ─────────────────────────
  _startGentleArp() {
    const reverb = this._createReverb(0.55);
    reverb.output.connect(this.outputGain);

    const notes = this._arpNotes;
    let noteIdx = 0;
    let direction = 1;

    const playNote = () => {
      if (!this.isPlaying) return;

      const freq = notes[noteIdx];
      const now = this.ctx.currentTime;

      const osc = this._osc('sine', freq);
      const osc2 = this._osc('triangle', freq * 0.999); // subtle chorus
      const g = this._gain(0);
      const filter = this._filter('lowpass', 2000 + Math.random() * 500);

      osc.connect(g);
      osc2.connect(this._gain(0.03));
      this._nodes[this._nodes.length - 1].connect(g);
      g.connect(filter);
      filter.connect(reverb.input);

      osc.start();
      osc2.start();

      g.gain.setTargetAtTime(0.08, now, 0.02);
      g.gain.setTargetAtTime(0, now + 0.15, 0.6);

      this._schedule(() => {
        try { osc.stop(); osc2.stop(); } catch(e) {}
      }, 4000);

      // Move through arpeggio
      noteIdx += direction;
      if (noteIdx >= notes.length - 1) direction = -1;
      if (noteIdx <= 0) {
        direction = 1;
        // Occasionally jump to a different chord group
        if (Math.random() < 0.3) {
          const group = Math.floor(Math.random() * 4) * 4;
          noteIdx = group;
        }
      }

      const tempo = 400 + Math.random() * 200;
      this._schedule(playNote, tempo);
    };

    playNote();
  }
}

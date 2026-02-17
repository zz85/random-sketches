/**
 * BrainWave App - UI controller, presets, visualizer, timer
 */
(function () {
  'use strict';

  const engine = new BrainWaveEngine();
  const music = new MusicEngine();

  // ─── Mode Presets ────────────────────────────────────
  const MODES = {
    'deep-focus': {
      beatFreq: 16, carrier: 200, toneType: 'binaural',
      noise: { brown: 0.15 }, music: 'lo-fi', musicVol: 0.3,
      label: 'Deep Focus', color: '#e74c3c'
    },
    'study': {
      beatFreq: 14, carrier: 200, toneType: 'binaural',
      noise: { pink: 0.12 }, music: 'piano-ambient', musicVol: 0.35,
      label: 'Study', color: '#e67e22'
    },
    'flow-state': {
      beatFreq: 10, carrier: 180, toneType: 'binaural',
      noise: { pink: 0.06 }, music: 'gentle-arp', musicVol: 0.3,
      label: 'Flow State', color: '#f1c40f'
    },
    'creativity': {
      beatFreq: 6, carrier: 160, toneType: 'binaural',
      noise: { pink: 0.08 }, music: 'ambient-pad', musicVol: 0.35,
      label: 'Creativity', color: '#9b59b6'
    },
    'relaxation': {
      beatFreq: 10, carrier: 180, toneType: 'binaural',
      noise: { pink: 0.1 }, music: 'piano-ambient', musicVol: 0.3,
      label: 'Relaxation', color: '#2ecc71'
    },
    'meditation': {
      beatFreq: 5, carrier: 150, toneType: 'binaural',
      noise: {}, music: 'singing-bowls', musicVol: 0.4,
      label: 'Meditation', color: '#1abc9c'
    },
    'power-nap': {
      beatFreq: 3, carrier: 140, toneType: 'binaural',
      noise: { brown: 0.08 }, music: 'space-drone', musicVol: 0.25,
      label: 'Power Nap', color: '#3498db'
    },
    'sleep': {
      beatFreq: 2, carrier: 120, toneType: 'binaural',
      noise: { brown: 0.12 }, music: 'space-drone', musicVol: 0.2,
      label: 'Deep Sleep', color: '#2c3e50'
    },
    'peak-performance': {
      beatFreq: 40, carrier: 300, toneType: 'binaural',
      noise: {}, music: 'lo-fi', musicVol: 0.3,
      label: 'Peak Performance', color: '#e74c3c'
    }
  };

  // ─── DOM refs ────────────────────────────────────────
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  const btnPlay = $('#btn-play');
  const iconPlay = $('#icon-play');
  const iconPause = $('#icon-pause');
  const volumeSlider = $('#master-volume');
  const volumeValue = $('#volume-value');
  const timerSelect = $('#timer-select');
  const timerDisplay = $('#timer-display');
  const statusText = $('#status-text');
  const freqDisplay = $('#freq-display');
  const carrierSlider = $('#carrier-freq');
  const carrierValue = $('#carrier-value');
  const canvas = $('#visualizer');
  const canvasCtx = canvas.getContext('2d');

  let activeMode = null;
  let timerInterval = null;
  let timerRemaining = 0;
  let animFrame = null;

  // ─── Tab Navigation ──────────────────────────────────
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.remove('active'));
      $$('.tab-content').forEach(tc => tc.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // ─── Play / Stop ─────────────────────────────────────
  btnPlay.addEventListener('click', () => {
    if (engine.isPlaying) {
      stopAll();
    } else {
      startPlaying();
    }
  });

  function startPlaying() {
    engine.play();
    // Attach music engine to the audio context if not yet done
    if (!music.ctx) {
      music.attach(engine.getAudioContext(), engine.getMasterGain());
    }
    // Only start music if it's not already playing (setStyle may have started it)
    if (music.style !== 'none' && !music.isPlaying) {
      music.start();
    }
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
    btnPlay.classList.add('playing');
    statusText.textContent = activeMode ? MODES[activeMode].label : 'Playing';
    startVisualizer();
    startTimer();
  }

  function stopAll() {
    engine.stop();
    music.stop();
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
    btnPlay.classList.remove('playing');
    statusText.textContent = 'Ready';
    freqDisplay.textContent = '';
    cancelAnimationFrame(animFrame);
    clearInterval(timerInterval);
    timerDisplay.textContent = '';
  }

  // ─── Volume ──────────────────────────────────────────
  volumeSlider.addEventListener('input', () => {
    const v = parseInt(volumeSlider.value);
    engine.setVolume(v / 100);
    volumeValue.textContent = v + '%';
  });

  // ─── Beats Volume ─────────────────────────────────────
  const beatsVolumeSlider = $('#beats-volume');
  const beatsVolumeValue = $('#beats-volume-value');
  beatsVolumeSlider.addEventListener('input', () => {
    const v = parseInt(beatsVolumeSlider.value);
    engine.setTonesVolume(v / 100);
    beatsVolumeValue.textContent = v + '%';
  });

  // ─── Mode Cards ──────────────────────────────────────
  $$('.mode-card').forEach(card => {
    card.addEventListener('click', () => {
      const mode = card.dataset.mode;
      const preset = MODES[mode];
      if (!preset) return;

      // Highlight selection
      $$('.mode-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      activeMode = mode;

      // Apply preset
      engine.setBeatFreq(preset.beatFreq);
      engine.setCarrierFreq(preset.carrier);
      engine.setToneType(preset.toneType);

      // Reset noise then apply preset noise
      ['white', 'pink', 'brown', 'rain', 'ocean', 'wind'].forEach(n => {
        engine.setNoiseVolume(n, 0);
      });
      Object.entries(preset.noise).forEach(([type, vol]) => {
        engine.setNoiseVolume(type, vol);
      });

      // Apply music preset
      if (preset.music) {
        music.setStyle(preset.music);
        music.setVolume(preset.musicVol || 0.3);
        syncMusicUI(preset.music, preset.musicVol || 0.3);
      } else {
        music.setStyle('none');
        syncMusicUI('none', 0);
      }

      // Sync UI
      syncUIFromEngine(preset);
      updateCustomSummary();

      // Update status
      freqDisplay.textContent = preset.beatFreq + ' Hz';
      statusText.textContent = preset.label;

      // Set theme color
      document.documentElement.style.setProperty('--accent', preset.color);

      // Auto-play
      if (!engine.isPlaying) {
        startPlaying();
      }
    });
  });

  function syncUIFromEngine(preset) {
    // Sync carrier slider
    carrierSlider.value = preset.carrier;
    carrierValue.textContent = preset.carrier;

    // Sync tone type radio
    $$('input[name="tone-type"]').forEach(r => {
      r.checked = r.value === preset.toneType;
    });

    // Sync noise sliders
    $$('.sound-layer').forEach(layer => {
      const type = layer.dataset.sound;
      const vol = preset.noise[type] || 0;
      const slider = layer.querySelector('.sound-slider');
      const display = layer.querySelector('.sound-value');
      slider.value = Math.round(vol * 100);
      display.textContent = Math.round(vol * 100) + '%';
    });

    // Sync brainwave sliders - find which band this freq falls in
    const freq = preset.beatFreq;
    $$('.wave-band').forEach(band => {
      const slider = band.querySelector('.wave-slider');
      const min = parseFloat(slider.min);
      const max = parseFloat(slider.max);
      if (freq >= min && freq <= max) {
        slider.value = freq;
        band.querySelector('.wave-value').textContent = freq.toFixed(1) + ' Hz';
        band.classList.add('active-band');
      } else {
        band.classList.remove('active-band');
      }
    });
  }

  // ─── Brainwave Sliders ──────────────────────────────
  $$('.wave-band').forEach(band => {
    const slider = band.querySelector('.wave-slider');
    const display = band.querySelector('.wave-value');
    slider.addEventListener('input', () => {
      const val = parseFloat(slider.value);
      display.textContent = val.toFixed(1) + ' Hz';

      // Set this as the active frequency
      engine.setBeatFreq(val);
      freqDisplay.textContent = val.toFixed(1) + ' Hz';
      activeMode = null;
      $$('.mode-card').forEach(c => c.classList.remove('selected'));

      // Highlight this band
      $$('.wave-band').forEach(b => b.classList.remove('active-band'));
      band.classList.add('active-band');

      updateCustomSummary();
    });
  });

  // ─── Carrier Frequency ──────────────────────────────
  carrierSlider.addEventListener('input', () => {
    const val = parseInt(carrierSlider.value);
    carrierValue.textContent = val;
    engine.setCarrierFreq(val);
    updateCustomSummary();
  });

  // ─── Tone Type ──────────────────────────────────────
  $$('input[name="tone-type"]').forEach(radio => {
    radio.addEventListener('change', () => {
      engine.setToneType(radio.value);
      updateCustomSummary();
    });
  });

  // ─── Sound Layer Sliders ────────────────────────────
  $$('.sound-layer').forEach(layer => {
    const slider = layer.querySelector('.sound-slider');
    const display = layer.querySelector('.sound-value');
    const type = layer.dataset.sound;

    slider.addEventListener('input', () => {
      const val = parseInt(slider.value);
      display.textContent = val + '%';
      engine.setNoiseVolume(type, val / 100);
      updateCustomSummary();
    });
  });

  // ─── Music Style Buttons ────────────────────────────
  $$('.music-style-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const style = btn.dataset.style;
      $$('.music-style-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');

      music.setStyle(style);
      // If the audio engine is playing but music wasn't yet attached, attach and start.
      // setStyle() already handles restart if music was already playing.
      if (engine.isPlaying && style !== 'none' && !music.isPlaying) {
        if (!music.ctx) {
          music.attach(engine.getAudioContext(), engine.getMasterGain());
        }
        music.start();
      }
      updateCustomSummary();
    });
  });

  // ─── Music Volume ─────────────────────────────────
  const musicVolumeSlider = $('#music-volume');
  const musicVolumeValue = $('#music-volume-value');
  musicVolumeSlider.addEventListener('input', () => {
    const v = parseInt(musicVolumeSlider.value);
    music.setVolume(v / 100);
    musicVolumeValue.textContent = v + '%';
    updateCustomSummary();
  });

  function syncMusicUI(style, vol) {
    $$('.music-style-btn').forEach(b => {
      b.classList.toggle('selected', b.dataset.style === style);
    });
    musicVolumeSlider.value = Math.round(vol * 100);
    musicVolumeValue.textContent = Math.round(vol * 100) + '%';
  }

  // ─── Custom Summary ─────────────────────────────────
  function updateCustomSummary() {
    const summary = $('#custom-summary');
    const parts = [];

    parts.push(`<strong>Beat:</strong> ${engine.beatFreq.toFixed(1)} Hz (${engine.toneType})`);
    parts.push(`<strong>Carrier:</strong> ${engine.carrierFreq} Hz`);

    const activeNoise = Object.entries(engine.noiseVolumes)
      .filter(([, v]) => v > 0)
      .map(([t, v]) => `${t} ${Math.round(v * 100)}%`);
    if (activeNoise.length) {
      parts.push(`<strong>Sounds:</strong> ${activeNoise.join(', ')}`);
    }

    if (music.style !== 'none') {
      parts.push(`<strong>Music:</strong> ${music.style} (${Math.round(music.volume * 100)}%)`);
    }

    summary.innerHTML = parts.map(p => `<p>${p}</p>`).join('');
  }

  // ─── Timer ──────────────────────────────────────────
  function startTimer() {
    clearInterval(timerInterval);
    const minutes = parseInt(timerSelect.value);
    if (minutes === 0) {
      timerDisplay.textContent = '';
      return;
    }
    timerRemaining = minutes * 60;
    updateTimerDisplay();
    timerInterval = setInterval(() => {
      timerRemaining--;
      if (timerRemaining <= 0) {
        stopAll();
        timerDisplay.textContent = 'Done!';
        return;
      }
      updateTimerDisplay();
    }, 1000);
  }

  function updateTimerDisplay() {
    const m = Math.floor(timerRemaining / 60);
    const s = timerRemaining % 60;
    timerDisplay.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ─── Visualizer ─────────────────────────────────────
  function resizeCanvas() {
    const container = canvas.parentElement;
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
  }

  function startVisualizer() {
    resizeCanvas();
    drawVisualizer();
  }

  function drawVisualizer() {
    animFrame = requestAnimationFrame(drawVisualizer);

    const data = engine.getAnalyserData();
    if (!data) return;

    const { waveform, frequency, bufferLength } = data;
    const W = canvas.width;
    const H = canvas.height;

    canvasCtx.clearRect(0, 0, W, H);

    // Draw frequency bars (background)
    const barCount = 64;
    const barWidth = W / barCount;
    const step = Math.floor(bufferLength / barCount);

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6c5ce7';

    for (let i = 0; i < barCount; i++) {
      const val = frequency[i * step] / 255;
      const barH = val * H * 0.8;
      const x = i * barWidth;

      canvasCtx.fillStyle = accent + '40';
      canvasCtx.fillRect(x, H - barH, barWidth - 1, barH);
    }

    // Draw waveform
    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = accent;
    canvasCtx.beginPath();

    const sliceWidth = W / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = waveform[i] / 128.0;
      const y = (v * H) / 2;
      if (i === 0) canvasCtx.moveTo(x, y);
      else canvasCtx.lineTo(x, y);
      x += sliceWidth;
    }

    canvasCtx.lineTo(W, H / 2);
    canvasCtx.stroke();

    // Glow effect
    canvasCtx.shadowBlur = 12;
    canvasCtx.shadowColor = accent;
    canvasCtx.stroke();
    canvasCtx.shadowBlur = 0;
  }

  window.addEventListener('resize', resizeCanvas);

  // ─── Keyboard Shortcuts ─────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
      btnPlay.click();
    }
  });

  // Init
  updateCustomSummary();
  resizeCanvas();
})();

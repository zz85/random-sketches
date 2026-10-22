/*
 * colour.js - a Procreate-style colour disc: hue on the outer ring, saturation (left to right)
 * and brightness (bottom to top) inside the disc. Pure DOM + 2D canvas.
 */

export function hsvToRgb(h, s, v) {
  const f = (n) => { const k = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)];
}
export function rgbToHsv([r, g, b]) {
  const M = Math.max(r, g, b), m = Math.min(r, g, b), d = M - m;
  let h = 0;
  if (d) h = M === r ? ((g - b) / d + 6) % 6 : M === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, M ? d / M : 0, M];
}

export class Disc {
  /** canvas: square <canvas>; onChange(hsv, done) is called while dragging and on release. */
  constructor(canvas, onChange) {
    this.c = canvas; this.on = onChange; this.hsv = [0.6, 0.7, 0.6];
    const N = canvas.width; this.N = N; this.R = N / 2; this.ring = N * 0.085; this.inner = this.R - this.ring - N * 0.035;
    this.ringImg = this.paintRing();
    let mode = null;
    const pick = (e, done) => {
      const r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * N - this.R, y = (e.clientY - r.top) / r.height * N - this.R;
      const d = Math.hypot(x, y);
      if (!mode) mode = d > this.inner + N * 0.015 ? 'hue' : 'sv';
      if (mode === 'hue') this.hsv[0] = ((Math.atan2(y, x) / (Math.PI * 2)) + 1.25) % 1;
      else {
        // clamp into the disc, then map its bounding square to saturation / value
        const k = d > this.inner ? this.inner / d : 1, px = x * k, py = y * k;
        this.hsv[1] = Math.min(1, Math.max(0, (px / this.inner + 1) / 2));
        this.hsv[2] = Math.min(1, Math.max(0, (1 - py / this.inner) / 2));
      }
      this.draw(); this.on(this.hsv.slice(), done);
    };
    canvas.addEventListener('pointerdown', (e) => { e.preventDefault(); canvas.setPointerCapture(e.pointerId); mode = null; pick(e, false); });
    canvas.addEventListener('pointermove', (e) => { if (mode) pick(e, false); });
    const up = (e) => { if (mode) { pick(e, true); mode = null; } };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', () => (mode = null));
    this.draw();
  }
  paintRing() {
    const { N, R, ring } = this, img = new ImageData(N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = x + 0.5 - R, dy = y + 0.5 - R, d = Math.hypot(dx, dy), i = (y * N + x) * 4;
      const a = Math.min(1, Math.max(0, R - d), Math.max(0, d - (R - ring)));
      if (a <= 0) continue;
      const [r, g, b] = hsvToRgb(((Math.atan2(dy, dx) / (Math.PI * 2)) + 1.25) % 1, 1, 1);
      img.data[i] = r * 255; img.data[i + 1] = g * 255; img.data[i + 2] = b * 255; img.data[i + 3] = a * 255;
    }
    return img;
  }
  set(hsv) { this.hsv = hsv.slice(); this.draw(); }
  draw() {
    const g = this.c.getContext('2d'), { N, R, inner } = this, [h, s, v] = this.hsv;
    g.putImageData(this.ringImg, 0, 0);
    // inner disc: saturation x, value y, for the current hue
    const img = g.getImageData(0, 0, N, N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = x + 0.5 - R, dy = y + 0.5 - R, d = Math.hypot(dx, dy);
      if (d > inner + 1) continue;
      const a = Math.min(1, inner + 1 - d), i = (y * N + x) * 4;
      const [r, gg, b] = hsvToRgb(h, Math.min(1, Math.max(0, (dx / inner + 1) / 2)), Math.min(1, Math.max(0, (1 - dy / inner) / 2)));
      img.data[i] = r * 255; img.data[i + 1] = gg * 255; img.data[i + 2] = b * 255; img.data[i + 3] = a * 255;
    }
    g.putImageData(img, 0, 0);
    const knob = (x, y, col) => { g.beginPath(); g.arc(x, y, N * 0.035, 0, Math.PI * 2); g.lineWidth = N * 0.012; g.strokeStyle = '#fff'; g.fillStyle = col; g.fill(); g.stroke(); g.lineWidth = 1; g.strokeStyle = 'rgba(0,0,0,0.5)'; g.stroke(); };
    const ha = (h - 0.25) * Math.PI * 2, rr = R - this.ring / 2;
    const hex = (c) => '#' + c.map((q) => Math.round(q * 255).toString(16).padStart(2, '0')).join('');
    knob(R + Math.cos(ha) * rr, R + Math.sin(ha) * rr, hex(hsvToRgb(h, 1, 1)));
    // the selected point, kept inside the disc
    let px = (s * 2 - 1) * inner, py = (1 - v * 2) * inner; const d = Math.hypot(px, py); if (d > inner) { px *= inner / d; py *= inner / d; }
    knob(R + px, R + py, hex(hsvToRgb(h, s, v)));
  }
}

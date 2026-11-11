// pictures.js - the pictures a surface can be designed to show: a few drawn here, text, a photo, the camera, or
// the user's own drawing. Everything ends as a square canvas, read as linear brightness.

const ink = '#fff';

export const PRESETS = {
  cat(g, W) {
    g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = W * 0.028; g.lineCap = g.lineJoin = 'round';
    const c = W / 2;
    g.beginPath(); // head with ears
    g.moveTo(c - W * 0.3, c + W * 0.05);
    g.lineTo(c - W * 0.29, c - W * 0.32); g.lineTo(c - W * 0.13, c - W * 0.17);
    g.quadraticCurveTo(c, c - W * 0.22, c + W * 0.13, c - W * 0.17);
    g.lineTo(c + W * 0.29, c - W * 0.32); g.lineTo(c + W * 0.3, c + W * 0.05);
    g.bezierCurveTo(c + W * 0.3, c + W * 0.3, c - W * 0.3, c + W * 0.3, c - W * 0.3, c + W * 0.05);
    g.stroke();
    for (const s of [-1, 1]) { // eyes, almond with a slit
      g.beginPath(); g.ellipse(c + s * W * 0.12, c - W * 0.03, W * 0.06, W * 0.045, 0, 0, Math.PI * 2); g.fill();
      g.save(); g.fillStyle = '#000'; g.beginPath(); g.ellipse(c + s * W * 0.12, c - W * 0.03, W * 0.013, W * 0.04, 0, 0, Math.PI * 2); g.fill(); g.restore();
    }
    g.beginPath(); g.moveTo(c - W * 0.03, c + W * 0.06); g.lineTo(c + W * 0.03, c + W * 0.06); g.lineTo(c, c + W * 0.1); g.closePath(); g.fill(); // nose
    g.lineWidth = W * 0.016;
    g.beginPath(); g.moveTo(c, c + W * 0.1); g.quadraticCurveTo(c - W * 0.02, c + W * 0.15, c - W * 0.07, c + W * 0.13);
    g.moveTo(c, c + W * 0.1); g.quadraticCurveTo(c + W * 0.02, c + W * 0.15, c + W * 0.07, c + W * 0.13); g.stroke();
    g.lineWidth = W * 0.01;
    for (const s of [-1, 1]) for (let k = 0; k < 3; k++) { // whiskers
      g.beginPath(); g.moveTo(c + s * W * 0.1, c + W * (0.08 + k * 0.025)); g.quadraticCurveTo(c + s * W * 0.25, c + W * (0.04 + k * 0.04), c + s * W * 0.42, c + W * (0.02 + k * 0.06)); g.stroke();
    }
  },
  moon(g, W) {
    const c = W / 2, R = W * 0.27;
    const glow = g.createRadialGradient(c - W * 0.05, c, R * 0.9, c - W * 0.05, c, R * 1.7);
    glow.addColorStop(0, 'rgba(255,255,255,0.35)'); glow.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = glow; g.fillRect(0, 0, W, W);
    g.fillStyle = ink; g.beginPath(); g.arc(c - W * 0.05, c, R, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#000'; g.beginPath(); g.arc(c + W * 0.07, c - W * 0.06, R * 0.9, 0, Math.PI * 2); g.fill();
    g.fillStyle = ink; let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 16; k++) {
      const x = W * (0.5 + 0.42 * (rnd() - 0.2)), y = W * (0.08 + 0.84 * rnd()), r = W * (0.006 + 0.012 * rnd() ** 2);
      if (Math.hypot(x - c + W * 0.05, y - c) < R * 1.15) continue;
      star(g, x, y, r * 2.2, r * 0.6);
    }
    star(g, c + W * 0.24, c - W * 0.22, W * 0.06, W * 0.016);
  },
  heart(g, W) {
    const c = W / 2; g.fillStyle = ink; g.beginPath();
    g.moveTo(c, c + W * 0.3);
    g.bezierCurveTo(c - W * 0.5, c - W * 0.02, c - W * 0.2, c - W * 0.42, c, c - W * 0.15);
    g.bezierCurveTo(c + W * 0.2, c - W * 0.42, c + W * 0.5, c - W * 0.02, c, c + W * 0.3); g.fill();
    g.fillStyle = '#000'; g.beginPath(); g.ellipse(c - W * 0.13, c - W * 0.12, W * 0.05, W * 0.08, -0.6, 0, Math.PI * 2); g.fill();
  },
  // the traditional picture a Japanese or Chinese magic mirror shows: a lotus (a Buddha, often, which we leave alone)
  lotus(g, W) {
    const c = W / 2; g.fillStyle = ink; g.strokeStyle = '#000'; g.lineWidth = W * 0.012;
    const petal = (a, len, wid, y0) => {
      g.save(); g.translate(c, c + y0); g.rotate(a); g.beginPath(); g.moveTo(0, 0);
      g.quadraticCurveTo(wid, -len * 0.5, 0, -len); g.quadraticCurveTo(-wid, -len * 0.5, 0, 0); g.fill(); g.stroke(); g.restore();
    };
    for (const [a, l, w] of [[-1.25, 0.3, 0.09], [1.25, 0.3, 0.09], [-0.8, 0.36, 0.1], [0.8, 0.36, 0.1], [-0.4, 0.4, 0.11], [0.4, 0.4, 0.11], [0, 0.44, 0.12]]) petal(a, W * l, W * w, W * 0.18);
    g.fillStyle = ink; g.beginPath(); g.ellipse(c, c + W * 0.24, W * 0.36, W * 0.035, 0, 0, Math.PI * 2); g.fill(); // the leaf below
    g.beginPath(); g.arc(c, c - W * 0.38, W * 0.03, 0, Math.PI * 2); g.fill();
  },
  eye(g, W) {
    const c = W / 2; g.fillStyle = ink;
    g.beginPath(); g.moveTo(c - W * 0.42, c); g.quadraticCurveTo(c, c - W * 0.38, c + W * 0.42, c); g.quadraticCurveTo(c, c + W * 0.38, c - W * 0.42, c); g.fill();
    const ir = g.createRadialGradient(c, c, 0, c, c, W * 0.16);
    ir.addColorStop(0, '#000'); ir.addColorStop(0.35, '#000'); ir.addColorStop(0.4, '#666'); ir.addColorStop(0.9, '#222'); ir.addColorStop(1, '#000');
    g.fillStyle = ir; g.beginPath(); g.arc(c, c, W * 0.16, 0, Math.PI * 2); g.fill();
    g.fillStyle = ink; g.beginPath(); g.arc(c + W * 0.05, c - W * 0.05, W * 0.03, 0, Math.PI * 2); g.fill();
  },
  rings(g, W) { // a test card: rings, bars and a grey ramp
    const c = W / 2; g.strokeStyle = ink;
    for (let k = 1; k <= 5; k++) { g.lineWidth = W * 0.004 * k; g.beginPath(); g.arc(c, c, W * 0.07 * k, 0, Math.PI * 2); g.stroke(); }
    for (let k = 0; k < 8; k++) { g.fillStyle = `rgb(${k * 36},${k * 36},${k * 36})`; g.fillRect(W * (0.1 + k * 0.1), W * 0.86, W * 0.1, W * 0.06); }
  },
};

function star(g, x, y, R, r) {
  g.beginPath();
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4, q = k % 2 ? r : R; g.lineTo(x + q * Math.sin(a), y - q * Math.cos(a)); }
  g.closePath(); g.fill();
}

export function textPicture(g, W, text) {
  const lines = String(text || ' ').split(/\n|\\n/).slice(0, 4);
  g.fillStyle = ink; g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = W * 0.8 / lines.length;
  const font = (s) => `900 ${s}px "Helvetica Neue", Arial, sans-serif`;
  g.font = font(size);
  const widest = Math.max(...lines.map((l) => g.measureText(l).width));
  size = Math.min(size, size * W * 0.86 / widest); g.font = font(size);
  lines.forEach((l, i) => g.fillText(l, W / 2, W / 2 + (i - (lines.length - 1) / 2) * size * 1.05));
}

export function newCanvas(W = 512) {
  const c = document.createElement('canvas'); c.width = c.height = W;
  const g = c.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#000'; g.fillRect(0, 0, W, W);
  return [c, g];
}

// An image or video frame cropped to its middle square.
export function drawCover(g, W, src, sw, sh) {
  const s = Math.min(sw, sh); g.drawImage(src, (sw - s) / 2, (sh - s) / 2, s, s, 0, 0, W, W);
}

// n x n linear brightness, row 0 at the top; flipX mirrors it (for a screen seen from the side the light comes from).
export function luminance(canvas, n, { flipX = false, contrast = 1, invert = false } = {}) {
  const [c, g] = newCanvas(n);
  g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, n, n);
  const d = g.getImageData(0, 0, n, n).data, out = new Float64Array(n * n);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const p = 4 * (j * n + (flipX ? n - 1 - i : i));
    let y = 0.2126 * lin(d[p]) + 0.7152 * lin(d[p + 1]) + 0.0722 * lin(d[p + 2]);
    if (invert) y = 1 - y;
    out[j * n + i] = Math.pow(y, contrast);
  }
  return out;
}

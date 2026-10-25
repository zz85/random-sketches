// Node helpers for the tools and tests: decode / encode images through ffmpeg (raw RGBA), and
// draw the fitted court over a frame.
import { execFileSync } from 'child_process';
import { courtModel } from '../court.js';

export function readImage(file) {
  // PAM carries its own size, so no ffprobe is needed
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-pix_fmt', 'rgba', '-vcodec', 'pam', '-'], { maxBuffer: 1 << 28 });
  const end = buf.indexOf('ENDHDR\n') + 7, hdr = buf.subarray(0, end).toString();
  const W = +/WIDTH (\d+)/.exec(hdr)[1], H = +/HEIGHT (\d+)/.exec(hdr)[1];
  return { data: new Uint8ClampedArray(buf.buffer, buf.byteOffset + end, W * H * 4), width: W, height: H };
}

export function writeImage(file, img) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${img.width}x${img.height}`, '-i', '-', ...(file.endsWith('.jpg') ? ['-q:v', '3'] : []), file], { input: Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length) });
}

export function line(img, x0, y0, x1, y1, col, thick = 1) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
  for (let i = 0; i <= n; i++) {
    const x = x0 + (x1 - x0) * i / n, y = y0 + (y1 - y0) * i / n;
    for (let j = -thick + 1; j < thick; j++) for (let k = -thick + 1; k < thick; k++) {
      const X = Math.round(x + k), Y = Math.round(y + j);
      if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue;
      const o = (Y * img.width + X) * 4; img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
    }
  }
}

// Project a 3D segment, clipped to in front of the camera, sampled so curved (distorted) lines bend.
export function drawSeg(img, cam, a, b, col, thick = 1) {
  let prev = null;
  for (let i = 0; i <= 40; i++) {
    const t = i / 40, X = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], u = cam.project(X);
    if (u[2] > 0.05 && prev) line(img, prev[0], prev[1], u[0], u[1], col, thick);
    prev = u[2] > 0.05 ? u : null;
  }
}

export function drawCourt(img, cam, { tin = 0.48, thick = 1 } = {}) {
  const m = courtModel({ tin });
  for (const e of m.edges) drawSeg(img, cam, e.a, e.b, [255, 255, 0], 1);
  for (const s of m.lines) drawSeg(img, cam, s.a, s.b, [0, 255, 255], thick);
}

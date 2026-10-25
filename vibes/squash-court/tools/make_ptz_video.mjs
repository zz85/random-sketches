// node tools/make_ptz_video.mjs out.mp4 [frames] — a synthetic clip from a camera on a fixed mount,
// the way broadcast and club cameras are used: it holds still, pans and tilts, holds, zooms in,
// holds, while two players run about. Camera of every frame -> out.json.
import { renderCourt } from '../synth.js';
import { Camera } from '../camera.js';
import { spawn } from 'child_process';
import fs from 'fs';
const out = process.argv[2] || '/tmp/squash/ptz.mp4', n = +(process.argv[3] || 150), w = 960, h = 540;
const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', '25', '-i', '-', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '23', out], { stdio: ['pipe', 'inherit', 'inherit'] });
const C = [3.5, 14.5, 3.7], ease = (t) => t * t * (3 - 2 * t);
// phase: hold 0–0.2, pan/tilt 0.2–0.45, hold 0.45–0.6, zoom 0.6–0.85, hold 0.85–1
const seg = (t, a, b) => ease(Math.max(0, Math.min(1, (t - a) / (b - a))));
const cams = [];
for (let i = 0; i < n; i++) {
  const t = i / (n - 1), pan = seg(t, 0.2, 0.45), zoom = seg(t, 0.6, 0.85);
  const T = [3.2 + 0.9 * pan, 2.6 + 0.8 * pan, 1.1 - 0.3 * pan];
  const cam = Camera.fromLookAt(C, T, 0.005, 1050 + 450 * zoom, w, h);
  const players = [{ x: 2 + 1.5 * Math.sin(t * 7), y: 6 + 1.5 * Math.cos(t * 5) }, { x: 4.2 + 1.2 * Math.cos(t * 6), y: 4.8 + 2 * Math.sin(t * 4) }];
  const img = renderCourt(cam, { seed: 9, style: 'glass', players, supersample: 1 });
  cams.push({ p: cam.p, cx: cam.cx, cy: cam.cy });
  await new Promise((r) => ff.stdin.write(Buffer.from(img.data.buffer), r));
}
ff.stdin.end(); await new Promise((r) => ff.on('close', r));
fs.writeFileSync(out.replace(/\.\w+$/, '.json'), JSON.stringify(cams));
console.log('wrote', out, n, 'frames');

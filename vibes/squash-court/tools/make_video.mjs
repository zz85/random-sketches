// node tools/make_video.mjs out.mp4 [frames] — a synthetic broadcast clip: the camera pans and
// zooms slowly over a glass court while two players move. Camera of every frame -> out.json.
import { renderCourt } from '../synth.js';
import { Camera } from '../camera.js';
import { spawn } from 'child_process';
import fs from 'fs';
const out = process.argv[2] || '/tmp/squash/synth.mp4', n = +(process.argv[3] || 60), w = 960, h = 540;
const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', '25', '-i', '-', '-pix_fmt', 'yuv420p', ...(out.endsWith('.webm') ? ['-c:v', 'libvpx', '-b:v', '3M'] : ['-c:v', 'libx264', '-crf', '20']), out], { stdio: ['pipe', 'inherit', 'inherit'] });
const cams = [];
for (let i = 0; i < n; i++) {
  const t = i / (n - 1);
  const C = [3.2 + 0.8 * Math.sin(t * 3), 15 - 1.5 * t, 3.4 + 0.3 * t], T = [3.2 + 0.6 * Math.sin(t * 4), 2.5 + t, 1.2];
  const cam = Camera.fromLookAt(C, T, 0.01 * Math.sin(t * 5), 1100 + 250 * t, w, h);
  const img = renderCourt(cam, { seed: 5, style: 'glass', players: 2, supersample: 1 });
  cams.push({ p: cam.p, cx: cam.cx, cy: cam.cy });
  await new Promise((r) => ff.stdin.write(Buffer.from(img.data.buffer), r));
}
ff.stdin.end(); await new Promise((r) => ff.on('close', r));
fs.writeFileSync(out.replace(/\.\w+$/, '.json'), JSON.stringify(cams));
console.log('wrote', out, n, 'frames');

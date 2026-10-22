/*
 * timelapse.js - records the painting as it happens (small JPEG frames read back from the
 * GPU asynchronously, at most a couple per second and only when something changed) and
 * plays it back or exports it as a video with MediaRecorder (MP4 on Safari, WebM elsewhere).
 */
import { putFrame, getFrame } from './store.js';

const MAX_FRAMES = 1800;

export class Recorder {
  constructor() { this.reset(null, 0); }
  reset(id, saved) { this.id = id; this.count = saved || 0; this.mem = new Map(); this.saved = saved || 0; this.busy = false; this.last = 0; this.stride = 1; this.skip = 0; }
  /** Is a frame due? `changed` = something was painted since the last one. */
  due(changed) {
    if (this.busy || !this.id || !changed || performance.now() - this.last < 450) return false;
    // past the cap, keep every 2nd, then every 4th... frame, so long paintings still fit
    if (this.count >= MAX_FRAMES * this.stride) this.stride *= 2;
    return this.stride === 1 || ++this.skip % this.stride === 0;
  }
  async capture(sim) {
    this.busy = true; this.last = performance.now();
    try {
      const { w, h, px } = await sim.snapshot(720);
      const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0);
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
      this.mem.set(this.count++, blob);
    } catch (e) { console.warn('time-lapse frame failed', e); }
    this.busy = false;
  }
  /** Write frames not yet in IndexedDB. Returns the total count. */
  async flush() {
    for (; this.saved < this.count; this.saved++) { const b = this.mem.get(this.saved); if (b) await putFrame(this.id, this.saved, b); }
    return this.count;
  }
  async frame(i) { return this.mem.get(i) || (this.id ? await getFrame(this.id, i) : null); }
}

/** Full-screen time-lapse player with scrubber and export. */
export async function openPlayer(rec, name, toast) {
  if (!rec.count) { toast('Nothing recorded yet: paint something first'); return; }
  const el = document.createElement('div'); el.className = 'tl';
  el.innerHTML = `<div class="tl-bar"><button class="tl-close">Done</button><span>Time-lapse</span><span class="tl-n"></span></div>
    <canvas></canvas>
    <div class="tl-ctl"><button class="tl-play">❚❚</button><input type="range" min="0" step="1"><button class="tl-exp" data-len="30">Export 30 s</button><button class="tl-exp" data-len="0">Export full</button></div>`;
  document.body.appendChild(el);
  const cv = el.querySelector('canvas'), g = cv.getContext('2d'), range = el.querySelector('input'), n = rec.count;
  range.max = n - 1;
  let i = 0, playing = true, closed = false;
  const show = async (k) => {
    const b = await rec.frame(k); if (!b) return;
    const bmp = await createImageBitmap(b);
    if (cv.width !== bmp.width) { cv.width = bmp.width; cv.height = bmp.height; }
    g.drawImage(bmp, 0, 0); bmp.close?.();
    el.querySelector('.tl-n').textContent = `${k + 1} / ${n}`; range.value = k;
  };
  const loop = async () => {
    while (!closed) {
      if (playing) { await show(i); i = (i + 1) % n; }
      await new Promise((r) => setTimeout(r, 1000 / Math.min(30, Math.max(8, n / 10))));
    }
  };
  loop();
  el.querySelector('.tl-play').onclick = (e) => { playing = !playing; e.target.textContent = playing ? '❚❚' : '▶'; };
  range.oninput = () => { playing = false; el.querySelector('.tl-play').textContent = '▶'; i = +range.value; show(i); };
  el.querySelector('.tl-close').onclick = () => { closed = true; el.remove(); };
  for (const b of el.querySelectorAll('.tl-exp')) b.onclick = async () => {
    playing = false;
    b.textContent = 'Exporting…';
    try { await exportVideo(rec, name, +b.dataset.len, toast); } catch (e) { toast('Video export failed: ' + e.message, 3000); }
    b.textContent = b.dataset.len === '30' ? 'Export 30 s' : 'Export full';
  };
}

/** Render frames into a canvas and record it. len = seconds (0 = one frame per 1/30 s). */
export async function exportVideo(rec, name, len, toast) {
  if (typeof MediaRecorder === 'undefined') throw new Error('this browser cannot record video');
  const first = await createImageBitmap(await rec.frame(0));
  const W = first.width & ~1, H = first.height & ~1;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), fps = 30, n = rec.count;
  const total = len ? Math.max(1, Math.round(len * fps)) : n;
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const stream = cv.captureStream(fps), mr = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6e6 });
  const chunks = []; mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => (mr.onstop = r));
  g.drawImage(first, 0, 0, W, H); mr.start();
  for (let f = 0; f < total + fps; f++) {
    // hold the finished painting for a second at the end
    const k = Math.min(n - 1, Math.floor(f * n / total));
    const bmp = await createImageBitmap(await rec.frame(k)); g.drawImage(bmp, 0, 0, W, H); bmp.close?.();
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  mr.stop(); await done;
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  const file = `${name || 'aquarelle'}-timelapse.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
  const f = new File([blob], file, { type: blob.type });
  if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f] }); return; } catch { /* cancelled */ } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Saved ' + file);
}

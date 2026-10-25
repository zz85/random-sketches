// Squash Court: find the court in a photo, a video or the camera from its painted lines and
// show the camera it implies — pose, focal length, the floor and front wall rectified, a 3D view,
// and image points lifted onto the court in metres.
import { Camera } from './camera.js';
import { courtModel, W as CW, L as CL } from './court.js';
import { renderCourt, randomBroadcastCamera } from './synth.js';
import { mulberry32 } from './detect.js';

const $ = (id) => document.getElementById(id);
const stage = $('stage'), sctx = stage.getContext('2d');
const plan = $('plan'), pctx = plan.getContext('2d');
const wall = $('wall'), wctx = wall.getContext('2d');
const view = $('view3d'), vctx = view.getContext('2d');
let MODEL = courtModel();
// frames are grabbed at these widths; the detector itself works at 640 and 480 px, tracking at 480
const DETECT_W = 1280, TRACK_W = 960;

const S = {
  src: null, // HTMLImageElement | HTMLVideoElement | ImageData-backed canvas
  srcW: 0, srcH: 0,
  cam: null, // fitted camera in source pixels
  quality: null, ms: null, busy: false, fails: 0, frames: 0, trackMs: [],
  tin: 0.48, picks: [], showLines: true, orbit: { yaw: -0.5, pitch: 0.45, dist: 19 },
  live: false, procFrame: null,
};
window.__sq = S;

// ---------- worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let reqId = 0; const pending = new Map();
worker.onmessage = (e) => { const r = pending.get(e.data.id); pending.delete(e.data.id); r && r(e.data); };
function run(mode, img, prev, opt) {
  return new Promise((res) => { const id = ++reqId; pending.set(id, res); worker.postMessage({ id, mode, rgba: img.data, w: img.width, h: img.height, prev, opt }, [img.data.buffer]); });
}

// camera in one pixel grid -> another (same pose, scaled intrinsics)
function scaleCam(c, k, w, h) { const p = c.p.slice(); p[6] += Math.log(k); return new Camera(p, w, h, c.cx * k, c.cy * k); }
const fromMsg = (m) => new Camera(m.p, m.w, m.h, m.cx, m.cy);

// grab the current source at a processing width
const proc = document.createElement('canvas'), prc = proc.getContext('2d', { willReadFrequently: true });
function grab(width) {
  const k = Math.min(1, width / S.srcW), w = Math.round(S.srcW * k), h = Math.round(S.srcH * k);
  proc.width = w; proc.height = h; prc.drawImage(S.src, 0, 0, w, h);
  return { img: prc.getImageData(0, 0, w, h), k };
}

async function analyse(mode = 'detect') {
  if (!S.src || S.busy) return;
  S.busy = true;
  const tracking = mode === 'track' && S.cam;
  const { img, k } = grab(tracking ? TRACK_W : DETECT_W);
  S.procFrame = { img: new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), k };
  const prev = tracking ? scaleCam(S.cam, k, img.width, img.height) : null;
  const t0 = performance.now();
  const r = await run(tracking ? 'track' : 'detect', img, prev && { p: prev.p, cx: prev.cx, cy: prev.cy }, tracking ? { tin: S.tin } : {});
  S.busy = false;
  if (r.error) { status(`error: ${r.error.split('\n')[0]}`); console.error(r.error); return; }
  const wall = performance.now() - t0;
  // a cut to another camera can still give a tracked fit that passes on its own; one that explains
  // much less than the last detection did is a lost track
  if (tracking && r.ok && S.refGood && r.quality.good < 0.6 * S.refGood) r.ok = false;
  if (!tracking && r.ok) S.refGood = r.quality.good;
  if (r.cam && (r.ok || !tracking)) { S.cam = scaleCam(fromMsg(r.cam), 1 / k, S.srcW, S.srcH); S.quality = r.quality; S.okay = r.ok; if (r.tin) { S.tin = r.tin; MODEL = courtModel({ tin: r.tin }); } }
  S.fails = r.ok ? 0 : S.fails + 1;
  S.ms = { ...r.ms, wall }; S.frames++;
  if (tracking) { S.trackMs.push(wall); if (S.trackMs.length > 30) S.trackMs.shift(); }
  status(`${tracking ? 'tracked' : 'detected'} ${r.ok ? '' : '(low confidence) '}in ${Math.round(wall)} ms — coverage ${(r.quality.coverage * 100 | 0)}%, residual ${r.quality.rms?.toFixed(2)} px`);
  draw();
}

// ---------- sources ----------
function useImage(el, w, h) {
  stopLive(); S.src = el; S.srcW = w; S.srcH = h; S.cam = null; S.picks = []; fitStage(); draw(); analyse('detect');
}
function loadFile(file) {
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('video/')) {
    const v = document.createElement('video'); v.src = url; v.muted = true; v.playsInline = true; v.loop = true;
    v.onloadeddata = () => useVideo(v); return;
  }
  const im = new Image(); im.onload = () => useImage(im, im.naturalWidth, im.naturalHeight); im.src = url;
}
function useVideo(v) {
  stopLive(); S.src = v; S.srcW = v.videoWidth; S.srcH = v.videoHeight; S.cam = null; S.picks = []; S.live = true; fitStage();
  v.play().catch(() => {});
  $('play').hidden = false; $('play').textContent = 'Pause';
  loop();
}
async function useCamera() {
  try {
    const st = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
    const v = document.createElement('video'); v.srcObject = st; v.muted = true; v.playsInline = true;
    await v.play(); useVideo(v);
  } catch (e) { status(`camera: ${e.message}`); }
}
function stopLive() {
  S.live = false; $('play').hidden = true;
  if (S.src instanceof HTMLVideoElement) { S.src.pause(); S.src.srcObject?.getTracks().forEach((t) => t.stop()); }
}
function loop() {
  if (!S.live) return;
  draw();
  // a paused video is analysed once, not over and over
  const t = S.src.currentTime, fresh = !S.src.paused || t !== S.lastT || (!S.okay && S.fails < 3);
  if (!S.busy && S.src.readyState >= 2 && fresh) { S.lastT = t; analyse(S.cam && S.fails < 3 ? 'track' : 'detect'); }
  requestAnimationFrame(loop);
}
let demoN = 1;
function demo() {
  const rng = mulberry32(1000 + demoN), w = 960, h = 540;
  const cam = randomBroadcastCamera(rng, w, h);
  const img = renderCourt(cam, { seed: demoN + 3, style: demoN % 2 ? 'glass' : 'club', players: 2, adverts: 8 });
  demoN++;
  const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').putImageData(new ImageData(img.data, w, h), 0, 0);
  S.truth = cam; useImage(c, w, h);
}

// ---------- geometry helpers ----------
// The first court surface hit by the ray through a source pixel (floor, front wall or a side wall).
function pickCourt(u, v) {
  const c = S.cam; if (!c) return null;
  const { o, d } = c.ray(u, v); let best = null;
  const tryPlane = (axis, val, surface, inside) => {
    if (Math.abs(d[axis]) < 1e-9) return; const t = (val - o[axis]) / d[axis]; if (t <= 0 || (best && t >= best.t)) return;
    const X = [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]]; if (inside(X)) best = { t, X, surface };
  };
  tryPlane(2, 0, 'floor', (X) => X[0] >= -0.3 && X[0] <= CW + 0.3 && X[1] >= -0.3 && X[1] <= CL + 0.3);
  tryPlane(1, 0, 'front wall', (X) => X[0] >= 0 && X[0] <= CW && X[2] >= 0 && X[2] <= 6);
  tryPlane(0, 0, 'right wall', (X) => X[1] >= 0 && X[1] <= CL && X[2] >= 0 && X[2] <= 6);
  tryPlane(0, CW, 'left wall', (X) => X[1] >= 0 && X[1] <= CL && X[2] >= 0 && X[2] <= 6);
  return best;
}

// ---------- drawing ----------
let disp = { k: 1, ox: 0, oy: 0 };
function fitStage() {
  const box = stage.parentElement.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  stage.width = Math.round(box.width * dpr); stage.height = Math.round(box.height * dpr);
  if (!S.srcW) return;
  const k = Math.min(stage.width / S.srcW, stage.height / S.srcH);
  disp = { k, ox: (stage.width - S.srcW * k) / 2, oy: (stage.height - S.srcH * k) / 2 };
}
function seg3(ctx, cam, a, b, map, n = 24) {
  let prev = null; ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const t = i / n, X = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], u = cam.project(X);
    if (u[2] > 0.05) { const [x, y] = map(u); prev ? ctx.lineTo(x, y) : ctx.moveTo(x, y); prev = u; } else prev = null;
  }
  ctx.stroke();
}
function draw() {
  sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.fillStyle = '#111'; sctx.fillRect(0, 0, stage.width, stage.height);
  if (!S.src) return;
  sctx.drawImage(S.src, disp.ox, disp.oy, S.srcW * disp.k, S.srcH * disp.k);
  const map = (u) => [disp.ox + u[0] * disp.k, disp.oy + u[1] * disp.k];
  const dpr = devicePixelRatio || 1;
  if (S.cam && S.showLines) {
    sctx.lineWidth = 1.5 * dpr; sctx.strokeStyle = 'rgba(255,230,0,0.85)';
    for (const e of MODEL.edges) seg3(sctx, S.cam, e.a, e.b, map);
    sctx.lineWidth = 2 * dpr; sctx.strokeStyle = S.okay ? 'rgba(0,240,255,0.95)' : 'rgba(255,120,0,0.95)';
    // the back wall line is out of sight (or a blur on the glass) for a camera behind the back wall
    for (const l of MODEL.lines) if (!(l.kind === 'back' && S.cam.C[1] > CL - 0.3)) seg3(sctx, S.cam, l.a, l.b, map);
  }
  for (const p of S.picks) {
    if (!S.cam) break; const u = S.cam.project(p.X); if (!(u[2] > 0)) continue; const [x, y] = map(u);
    sctx.fillStyle = '#ff2d7a'; sctx.beginPath(); sctx.arc(x, y, 5 * dpr, 0, 7); sctx.fill();
    sctx.font = `${12 * dpr}px system-ui`; sctx.fillStyle = '#fff'; sctx.fillText(fmtX(p), x + 8 * dpr, y - 6 * dpr);
  }
  drawPlan(); drawWall(); draw3d(); readout();
}
const fmtX = (p) => p.surface === 'floor' ? `${p.X[0].toFixed(2)}, ${p.X[1].toFixed(2)} m` : p.surface === 'front wall' ? `x ${p.X[0].toFixed(2)}, h ${p.X[2].toFixed(2)} m` : `y ${p.X[1].toFixed(2)}, h ${p.X[2].toFixed(2)} m`;

// Rectify a court plane from the processed frame: each plan pixel samples the frame through the camera.
function rectify(ctx, cnv, toWorld) {
  const w = cnv.width, h = cnv.height, out = ctx.createImageData(w, h), f = S.procFrame;
  if (S.cam && f) {
    const c = scaleCam(S.cam, f.k, f.img.width, f.img.height), src = f.img.data, sw = f.img.width, sh = f.img.height;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const u = c.project(toWorld(x + 0.5, y + 0.5)), o = (y * w + x) * 4;
      if (u[2] > 0 && u[0] >= 0 && u[1] >= 0 && u[0] < sw - 1 && u[1] < sh - 1) {
        const i = ((u[1] | 0) * sw + (u[0] | 0)) * 4; out.data[o] = src[i]; out.data[o + 1] = src[i + 1]; out.data[o + 2] = src[i + 2]; out.data[o + 3] = 255;
      } else { out.data[o] = out.data[o + 1] = out.data[o + 2] = 30; out.data[o + 3] = 255; }
    }
  }
  ctx.putImageData(out, 0, 0);
}
function drawPlan() {
  const s = plan.width / CW; // px per metre; y down the court
  rectify(pctx, plan, (x, y) => [x / s, y / s, 0]);
  pctx.strokeStyle = 'rgba(0,240,255,0.8)'; pctx.lineWidth = 1;
  for (const l of MODEL.lines) if (l.kind === 'floor') { pctx.beginPath(); pctx.moveTo(l.a[0] * s, l.a[1] * s); pctx.lineTo(l.b[0] * s, l.b[1] * s); pctx.stroke(); }
  pctx.strokeRect(0.5, 0.5, plan.width - 1, plan.height - 1);
  for (const p of S.picks) if (p.surface === 'floor') { pctx.fillStyle = '#ff2d7a'; pctx.beginPath(); pctx.arc(p.X[0] * s, p.X[1] * s, 4, 0, 7); pctx.fill(); }
  // where the camera stands, if it is on the plan
  if (S.cam) { const C = S.cam.C; pctx.fillStyle = '#ffe600'; pctx.fillText(C[1] > CL ? `▼ camera ${(C[1] - CL).toFixed(1)} m behind` : '● camera', Math.max(4, Math.min(plan.width - 90, C[0] * s - 20)), Math.min(plan.height - 6, C[1] * s)); }
}
function drawWall() {
  const s = wall.width / CW; // front wall, 0 … 5 m high
  rectify(wctx, wall, (x, y) => [x / s, 0, (wall.height - y) / s]);
  wctx.strokeStyle = 'rgba(0,240,255,0.8)';
  for (const l of MODEL.lines) if (l.kind === 'front') { const y = wall.height - l.a[2] * s; wctx.beginPath(); wctx.moveTo(0, y); wctx.lineTo(wall.width, y); wctx.stroke(); }
  for (const p of S.picks) if (p.surface === 'front wall') { wctx.fillStyle = '#ff2d7a'; wctx.beginPath(); wctx.arc(p.X[0] * s, wall.height - p.X[2] * s, 4, 0, 7); wctx.fill(); }
}
// 3D overview rendered with the same camera class: court box, lines, the fitted camera's frustum.
function draw3d() {
  const w = view.width, h = view.height, o = S.orbit, T = [CW / 2, CL / 2, 1];
  const C = [T[0] + o.dist * Math.cos(o.pitch) * Math.sin(o.yaw), T[1] + o.dist * Math.cos(o.pitch) * Math.cos(o.yaw), T[2] + o.dist * Math.sin(o.pitch)];
  const vc = Camera.fromLookAt(C, T, 0, w * 0.9, w, h);
  vctx.fillStyle = '#16181d'; vctx.fillRect(0, 0, w, h);
  const id = (u) => [u[0], u[1]];
  vctx.lineWidth = 1; vctx.strokeStyle = '#555';
  for (const e of MODEL.edges) seg3(vctx, vc, e.a, e.b, id, 4);
  vctx.strokeStyle = '#d33'; for (const l of MODEL.lines) seg3(vctx, vc, l.a, l.b, id, 4);
  if (S.cam) {
    const c = S.cam, depth = Math.max(3, Math.hypot(c.C[0] - T[0], c.C[1] - T[1], c.C[2] - T[2]) * 0.35);
    const corners = [[0, 0], [c.w, 0], [c.w, c.h], [0, c.h]].map(([u, v]) => { const r = c.ray(u, v); return r.d.map((d, i) => r.o[i] + d * depth); });
    vctx.strokeStyle = '#ffe600';
    for (const q of corners) seg3(vctx, vc, c.C, q, id, 2);
    for (let i = 0; i < 4; i++) seg3(vctx, vc, corners[i], corners[(i + 1) % 4], id, 2);
    vctx.strokeStyle = 'rgba(255,230,0,0.35)';
    for (const p of S.picks) seg3(vctx, vc, c.C, p.X, id, 2);
    for (const p of S.picks) { const u = vc.project(p.X); if (u[2] > 0) { vctx.fillStyle = '#ff2d7a'; vctx.beginPath(); vctx.arc(u[0], u[1], 3.5, 0, 7); vctx.fill(); } }
  }
}
function readout() {
  const c = S.cam, el = $('readout');
  if (!c) { el.textContent = S.src ? 'looking for the court…' : 'Open a photo or video of a squash court, use the camera, or try a demo frame.'; return; }
  const a = c.angles(), hz = S.trackMs.length ? 1000 / (S.trackMs.reduce((s, v) => s + v, 0) / S.trackMs.length) : 0;
  const lines = [
    `camera   x ${c.C[0].toFixed(2)}  y ${c.C[1].toFixed(2)}  z ${c.C[2].toFixed(2)} m`,
    `         ${c.C[1] > CL ? (c.C[1] - CL).toFixed(2) + ' m behind the back wall' : (CL - c.C[1]).toFixed(2) + ' m in front of the back wall'}, ${c.C[2].toFixed(2)} m up`,
    `view     yaw ${a.yaw.toFixed(1)}°  pitch ${a.pitch.toFixed(1)}° down  roll ${a.roll.toFixed(1)}°`,
    `lens     f ${c.f.toFixed(0)} px  (h-fov ${c.hfov().toFixed(1)}°, ${(36 / 2 / Math.tan(c.hfov() * Math.PI / 360)).toFixed(0)} mm full-frame equiv.)  k1 ${c.k1.toFixed(3)}`,
    `tin      ${S.tin.toFixed(2)} m (${S.tin < 0.45 ? 'PSA men' : 'WSF / women'})`,
    `fit      coverage ${(S.quality.coverage * 100).toFixed(0)}%  residual ${S.quality.rms.toFixed(2)} px  ${S.okay ? 'good' : 'LOW CONFIDENCE'}`,
    `time     ${S.ms ? Math.round(S.ms.wall) + ' ms' : ''}${hz ? `   tracking ${hz.toFixed(1)} fps` : ''}`,
  ];
  if (S.truth && !S.live) lines.push(`truth    x ${S.truth.C[0].toFixed(2)}  y ${S.truth.C[1].toFixed(2)}  z ${S.truth.C[2].toFixed(2)} m, f ${S.truth.f.toFixed(0)} px`);
  el.textContent = lines.join('\n');
}
let msgT = 0;
function status(s) { $('status').textContent = s; clearTimeout(msgT); }

// ---------- export ----------
function exportJSON() {
  const c = S.cam; if (!c) return;
  const data = {
    note: 'World metres: x across (0 = right wall facing the front), y from the front wall, z up. Pixels: origin top-left, pixel i covers [i, i+1).',
    image: { width: c.w, height: c.h },
    intrinsics: { f: c.f, cx: c.cx, cy: c.cy, k1: c.k1, K: [c.f, 0, c.cx, 0, c.f, c.cy, 0, 0, 1] },
    extrinsics: { R: c.R, C: c.C, rodrigues: c.p.slice(0, 3) },
    P: c.matrix(), H_floor: c.homography('floor'), H_frontWall: c.homography('front'),
    angles: c.angles(), quality: S.quality,
  };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = 'squash-camera.json'; a.click();
}

// ---------- events ----------
$('file').onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
$('open').onclick = () => $('file').click();
$('camera').onclick = useCamera;
$('demo').onclick = demo;
$('redetect').onclick = () => { S.fails = 9; if (!S.live) analyse('detect'); };
$('lines').onchange = (e) => { S.showLines = e.target.checked; draw(); };
$('export').onclick = exportJSON;
$('clear').onclick = () => { S.picks = []; draw(); };
$('play').onclick = () => { const v = S.src; if (!(v instanceof HTMLVideoElement)) return; v.paused ? v.play() : v.pause(); $('play').textContent = v.paused ? 'Play' : 'Pause'; };
addEventListener('resize', () => { fitStage(); draw(); });
addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])][0]; f && loadFile(f); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; f && loadFile(f); });
stage.addEventListener('pointerdown', (e) => {
  if (!S.cam) return;
  const r = stage.getBoundingClientRect(), dpr = stage.width / r.width;
  const u = ((e.clientX - r.left) * dpr - disp.ox) / disp.k, v = ((e.clientY - r.top) * dpr - disp.oy) / disp.k;
  const hit = pickCourt(u, v); if (!hit) return;
  S.picks.push(hit); if (S.picks.length > 12) S.picks.shift();
  status(`${hit.surface}: ${fmtX(hit)}`); draw();
});
{ // orbit the 3D view
  let drag = null;
  view.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; view.setPointerCapture(e.pointerId); });
  view.addEventListener('pointermove', (e) => { if (!drag) return; S.orbit.yaw += (e.clientX - drag[0]) * 0.01; S.orbit.pitch = Math.max(0.05, Math.min(1.5, S.orbit.pitch + (e.clientY - drag[1]) * 0.01)); drag = [e.clientX, e.clientY]; draw3d(); });
  view.addEventListener('pointerup', () => { drag = null; });
  view.addEventListener('wheel', (e) => { e.preventDefault(); S.orbit.dist = Math.max(8, Math.min(60, S.orbit.dist * Math.exp(e.deltaY * 0.001))); draw3d(); }, { passive: false });
}
fitStage(); draw();
const q = new URLSearchParams(location.search);
if (q.get('img')) { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => useImage(im, im.naturalWidth, im.naturalHeight); im.src = q.get('img'); }
else if (q.has('demo')) demo();

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
// frames are grabbed at these widths; the detector works at 640 and 480 px, the sparse tracker at
// the grabbed resolution (its cost is per line sample, not per pixel), the full tracker at 480
const DETECT_W = 1280, TRACK_W = 1280;
// ?track=full uses the full tracker every frame, ?mount=moving drops the fixed-mount assumption
const QS = new URLSearchParams(location.search);
const TRACK_OPT = { ...(QS.get('track') === 'full' ? { sparse: false } : {}), ...(QS.get('mount') === 'moving' ? { fixedMount: false } : {}) };

const S = {
  src: null, // HTMLImageElement | HTMLVideoElement | ImageData-backed canvas
  srcW: 0, srcH: 0,
  cam: null, // fitted camera in source pixels
  quality: null, ms: null, busy: false, fails: 0, frames: 0, trackMs: [],
  tin: 0.48, picks: [], showLines: true, orbit: { yaw: -0.5, pitch: 0.45, dist: 19 },
  live: false, procFrame: null, sound: true,
  // players and ball (rally.js in the worker): players [{ id, X, seen, occluded, box }], the live
  // ball pixel, and fitted flights { t0, t1, pts: [{ t, X }], uv, impacts, labels, speed }
  showRally: true, showHeat: true, players: [], ball: null, ballTrail: [], flights: [], rallyMs: {},
};
// Per player: recent positions (speed), distance covered and time spent per 25 cm floor cell
// (the heatmap). Kept in the page, fed by the players worker's tracked positions.
const HM = 0.25, HX = Math.ceil(CW / HM), HY = Math.ceil(CL / HM);
const newStats = () => ({});
S.stats = newStats();
function statFor(id) { return S.stats[id] ??= { hist: [], dist: 0, time: 0, heat: new Float32Array(HX * HY), last: null, speed: 0, top: 0 }; }
function addPlayerStats(players, t) {
  for (const p of players) {
    const st = statFor(p.id);
    if (st.last && t < st.last.t) { st.hist = []; st.last = null; } // seek back
    const dt = st.last ? Math.min(0.5, t - st.last.t) : 0.2; // a still counts once
    if (p.seen) {
      const cx = Math.floor(p.X[0] / HM), cy = Math.floor(p.X[1] / HM);
      if (cx >= 0 && cy >= 0 && cx < HX && cy < HY && dt > 0) { st.heat[cy * HX + cx] += dt; st.time += dt; }
      if (st.last && dt > 0) st.dist += Math.hypot(p.X[0] - st.last.X[0], p.X[1] - st.last.X[1]);
      st.hist.push({ t, X: p.X.slice() });
    }
    st.last = { t, X: p.X.slice() };
    // speed: least-squares slope over the last 0.6 s (detections ~5 a second, feet jitter by cm)
    st.hist = st.hist.filter((q) => q.t > t - 0.6);
    if (st.hist.length >= 3) {
      const n = st.hist.length, mt = st.hist.reduce((s, q) => s + q.t, 0) / n, mx = st.hist.reduce((s, q) => s + q.X[0], 0) / n, my = st.hist.reduce((s, q) => s + q.X[1], 0) / n;
      let tt = 0, tx = 0, ty = 0; for (const q of st.hist) { const d = q.t - mt; tt += d * d; tx += d * (q.X[0] - mx); ty += d * (q.X[1] - my); }
      st.speed = tt > 1e-6 ? Math.hypot(tx / tt, ty / tt) : 0; st.top = Math.max(st.top, Math.min(st.speed, 8));
    } else st.speed = 0;
  }
}
// the ball's speed now: the fitted flight's velocity at the frame nearest the current time
function ballNow() {
  const t = S.src?.currentTime; if (t == null) return null;
  for (const f of S.flights) if (t >= f.t0 - 0.02 && t <= f.t1 + 0.02) { const q = f.pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)); if (q.V) return { X: q.X, speed: Math.hypot(...q.V) }; }
  return null;
}
const kmh = (v) => `${v.toFixed(1)} m/s (${(v * 3.6).toFixed(0)} km/h)`;
const clearRally = () => { S.stats = newStats(); S.players = []; S.ball = null; S.ballTrail = []; S.flights = []; S.rallyMs = {}; for (const R of rallyW) R.reset = true; };
window.__sq = S;

// ---------- worker ----------
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let reqId = 0; const pending = new Map();
worker.onmessage = (e) => { const r = pending.get(e.data.id); pending.delete(e.data.id); r && r(e.data); };
function run(mode, img, prev, opt) {
  return new Promise((res) => { const id = ++reqId; pending.set(id, res); worker.postMessage({ id, mode, rgba: img.data, w: img.width, h: img.height, prev, opt }, [img.data.buffer]); });
}

// Players and ball run in two more workers, fed frames the court worker has fitted: the player
// search is slow, the ball wants every frame it can get, so neither waits for the other. A frame is
// only handed to an idle worker, so nothing queues up behind the video.
const rallyW = ['players', 'ball'].map((role) => {
  const wk = new Worker(new URL('./rally-worker.js', import.meta.url), { type: 'module' });
  const R = { wk, role, busy: false, reset: true, k: 1 };
  wk.onmessage = (e) => { R.busy = false; const q = e.data; if (q.error) { console.error(q.error); return; } takeRally(q, R.k); if (!S.live) draw(); };
  return R;
});
function runRally(frame, cam, t, video) {
  if (!S.showRally) return;
  for (const R of video ? rallyW : rallyW.slice(0, 1)) {
    if (R.busy) continue;
    R.busy = true; R.k = frame.k;
    const data = new Uint8ClampedArray(frame.img.data), seen = S.players.filter((p) => p.box);
    R.wk.postMessage({ mode: video ? R.role : 'still', rgba: data, w: frame.img.width, h: frame.img.height, cam: { p: cam.p, cx: cam.cx, cy: cam.cy }, t, tin: S.tin, reset: R.reset,
      boxes: seen.map((p) => p.box.map((v) => v * frame.k)), playerX: seen.map((p) => p.X) }, [data.buffer]);
    R.reset = false;
  }
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
  const prev = tracking ? scaleCam(S.cam, k, img.width, img.height) : null, tGrab = S.src.currentTime;
  const video = S.src instanceof HTMLVideoElement;
  const t0 = performance.now();
  const r = await run(tracking ? 'track' : 'detect', img, prev && { p: prev.p, cx: prev.cx, cy: prev.cy }, tracking ? { tin: S.tin, dt: Math.abs((S.src.currentTime ?? 0) - (S.tAnalysed ?? 0)), ...TRACK_OPT } : { recall: !!(S.live && S.cam && S.fails < 9) });
  S.busy = false; S.tAnalysed = tGrab;
  if (r.error) { status(`error: ${r.error.split('\n')[0]}`); console.error(r.error); return; }
  const wall = performance.now() - t0;
  // a cut to another camera can still give a tracked fit that passes on its own; one that explains
  // much less than the last detection did is a lost track
  if (tracking && r.ok && S.refGood && r.quality.good < 0.6 * S.refGood) r.ok = false;
  if (!tracking && r.ok) S.refGood = r.quality.good;
  if (r.cam && (r.ok || !tracking)) { S.cam = scaleCam(fromMsg(r.cam), 1 / k, S.srcW, S.srcH); S.quality = r.quality; S.okay = r.ok; if (r.tin) { S.tin = r.tin; MODEL = courtModel({ tin: r.tin }); } }
  S.fails = r.ok ? 0 : S.fails + 1;
  if (r.ok && r.cam) { if (r.path === 'detect' || r.path === 'recall') for (const R of rallyW) R.reset = true; runRally(S.procFrame, fromMsg(r.cam), tGrab ?? 0, video); }
  else if (!r.ok) { S.players = []; S.ball = null; }
  S.ms = { ...r.ms, wall }; S.frames++;
  if (tracking) { S.trackMs.push(wall); if (S.trackMs.length > 30) S.trackMs.shift(); }
  S.path = r.path; S.mount = r.mount;
  const how = { static: 'held (camera still)', moving: 'tracked', full: 'tracked (full)', recall: 'back to an earlier camera', detect: 'detected' }[r.path] || (tracking ? 'tracked' : 'detected');
  status(`${how} ${r.ok ? '' : '(low confidence) '}in ${Math.round(wall)} ms — coverage ${(r.quality.coverage * 100 | 0)}%, residual ${r.quality.rms?.toFixed(2)} px${tracking && r.mount === 'free' ? ' — camera position moving' : ''}`);
  draw();
}

// players and ball from the worker, in source pixels (it saw the frame scaled by k)
function takeRally(q, k) {
  if (q.dup || !S.showRally) return;
  S.rallyMs[q.mode === 'ball' ? 'ball' : 'players'] = q.ms;
  if (q.players) { S.players = q.players.map((p) => ({ ...p, box: p.box && p.box.map((v) => v / k) })); addPlayerStats(S.players, S.src.currentTime ?? 0); }
  if (q.mode !== 'ball') return;
  S.ball = q.ball && { u: q.ball.u / k, v: q.ball.v / k, t: q.ball.t };
  if (S.ball) S.ballTrail.push(S.ball);
  const t = S.src.currentTime ?? 0; S.ballTrail = S.ballTrail.filter((b) => b.t > t - 0.4 && b.t <= t + 0.05);
  if (q.flights) S.flights = q.flights.map((f) => ({ ...f, uv: f.uv.map(([u, v]) => [u / k, v / k]) }));
}
// flights to show at time t: the last 2 s of video (all of them for a still)
const recentFlights = () => { const t = S.src?.currentTime; return t == null ? S.flights : S.flights.filter((f) => f.t1 > t - 2 && f.t0 <= t + 0.05); };
const PCOL = ['#ff2d7a', '#2dd4ff', '#b4ff2d'];
const pcol = (p) => PCOL[(p.id - 1) % PCOL.length];

// ---------- sources ----------
function useImage(el, w, h) {
  stopLive(); S.src = el; S.srcW = w; S.srcH = h; S.cam = null; S.picks = []; clearRally(); fitStage(); draw(); analyse('detect');
}
function loadFile(file) {
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('video/')) {
    const v = document.createElement('video'); v.src = url; v.muted = !S.sound; v.playsInline = true; v.loop = true;
    v.onloadeddata = () => useVideo(v); return;
  }
  const im = new Image(); im.onload = () => useImage(im, im.naturalWidth, im.naturalHeight); im.src = url;
}
function useVideo(v) {
  stopLive(); S.src = v; S.srcW = v.videoWidth; S.srcH = v.videoHeight; S.cam = null; S.picks = []; clearRally(); S.live = true; fitStage();
  // with sound if wanted; a browser that refuses unmuted playback without a fresh gesture gets it muted
  v.play().catch(() => { v.muted = true; soundLabel(); v.play().catch(() => {}); });
  $('play').hidden = false; $('play').textContent = 'Pause';
  $('sound').hidden = !!v.srcObject; soundLabel();
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
  S.live = false; $('play').hidden = true; $('sound').hidden = true;
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
  S.truth = cam; useImage(c, w, h); S.truthPlayers = img.players;
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
  if (S.cam && S.showRally) drawRallyStage(map, dpr);
  for (const p of S.picks) {
    if (!S.cam) break; const u = S.cam.project(p.X); if (!(u[2] > 0)) continue; const [x, y] = map(u);
    sctx.fillStyle = '#ff2d7a'; sctx.beginPath(); sctx.arc(x, y, 5 * dpr, 0, 7); sctx.fill();
    sctx.font = `${12 * dpr}px system-ui`; sctx.fillStyle = '#fff'; sctx.fillText(fmtX(p), x + 8 * dpr, y - 6 * dpr);
  }
  drawPlan(); drawWall(); draw3d(); readout();
}
// players: a ring on the floor round the feet (dashed when the feet are hidden behind a graphic and
// placed from the head), the position in metres; the ball: its fitted flights and the live blob
function drawRallyStage(map, dpr) {
  const c = S.cam;
  for (const p of S.players) {
    sctx.strokeStyle = pcol(p); sctx.lineWidth = 2 * dpr; sctx.setLineDash(p.occluded || !p.seen ? [4 * dpr, 3 * dpr] : []);
    sctx.beginPath(); let first = true;
    for (let a = 0; a <= 24; a++) { const u = c.project([p.X[0] + 0.28 * Math.cos(a / 24 * 2 * Math.PI), p.X[1] + 0.28 * Math.sin(a / 24 * 2 * Math.PI), 0]); if (!(u[2] > 0)) continue; const [x, y] = map(u); first ? sctx.moveTo(x, y) : sctx.lineTo(x, y); first = false; }
    sctx.stroke(); sctx.setLineDash([]);
    const u = c.project([p.X[0], p.X[1], 0]); if (!(u[2] > 0)) continue; const [x, y] = map(u);
    sctx.font = `${12 * dpr}px system-ui`; sctx.fillStyle = '#000a'; const sp = S.stats[p.id]?.speed, s = `P${p.id}  ${p.X[0].toFixed(2)}, ${p.X[1].toFixed(2)} m${sp > 0.3 ? `  ${sp.toFixed(1)} m/s` : ''}`;
    sctx.fillRect(x + 14 * dpr, y - 6 * dpr, sctx.measureText(s).width + 6 * dpr, 16 * dpr); sctx.fillStyle = pcol(p); sctx.fillText(s, x + 17 * dpr, y + 6 * dpr);
  }
  sctx.lineWidth = 2.5 * dpr;
  for (const f of recentFlights()) {
    sctx.strokeStyle = '#ffe600'; sctx.beginPath(); let first = true;
    for (const q of f.pts) { const u = c.project(q.X); if (!(u[2] > 0)) { first = true; continue; } const [x, y] = map(u); first ? sctx.moveTo(x, y) : sctx.lineTo(x, y); first = false; }
    sctx.stroke();
    for (const m of f.impacts) { const u = c.project(m.X); if (!(u[2] > 0)) continue; const [x, y] = map(u); sctx.fillStyle = '#ff8a00'; sctx.beginPath(); sctx.arc(x, y, 4 * dpr, 0, 7); sctx.fill(); }
  }
  const bn = ballNow(); if (bn) { const u = c.project(bn.X); if (u[2] > 0) { const [x, y] = map(u); sctx.font = `${12 * dpr}px system-ui`; sctx.fillStyle = '#ffe600'; sctx.fillText(`${(bn.speed * 3.6).toFixed(0)} km/h`, x + 9 * dpr, y - 9 * dpr); sctx.beginPath(); sctx.arc(x, y, 4 * dpr, 0, 7); sctx.fill(); } }
  sctx.strokeStyle = '#39ff6a'; sctx.lineWidth = 1.5 * dpr;
  for (const b of S.ballTrail) { const [x, y] = map([b.u, b.v]); sctx.strokeRect(x - 6 * dpr, y - 6 * dpr, 12 * dpr, 12 * dpr); }
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
  if (S.showHeat) drawHeat(s);
  if (S.showRally) {
    // the ball's ground track (shadow), floor bounces, players
    for (const f of recentFlights()) {
      pctx.strokeStyle = 'rgba(255,230,0,0.9)'; pctx.lineWidth = 1.5; pctx.beginPath();
      f.pts.forEach((q, i) => (i ? pctx.lineTo(q.X[0] * s, q.X[1] * s) : pctx.moveTo(q.X[0] * s, q.X[1] * s))); pctx.stroke();
      for (const m of f.impacts) { pctx.fillStyle = '#ff8a00'; pctx.beginPath(); pctx.arc(m.X[0] * s, m.X[1] * s, 3, 0, 7); pctx.fill(); }
    }
    for (const p of S.players) {
      pctx.fillStyle = pcol(p); pctx.globalAlpha = p.seen ? 1 : 0.5; pctx.beginPath(); pctx.arc(p.X[0] * s, p.X[1] * s, 6, 0, 7); pctx.fill(); pctx.globalAlpha = 1;
      pctx.fillStyle = '#000'; pctx.font = 'bold 9px system-ui'; pctx.fillText(String(p.id), p.X[0] * s - 2.5, p.X[1] * s + 3);
    }
  }
  // where the camera stands, if it is on the plan
  if (S.cam) { const C = S.cam.C; pctx.fillStyle = '#ffe600'; pctx.fillText(C[1] > CL ? `▼ camera ${(C[1] - CL).toFixed(1)} m behind` : '● camera', Math.max(4, Math.min(plan.width - 90, C[0] * s - 20)), Math.min(plan.height - 6, C[1] * s)); }
}
// Heatmap: time each player spent per 25 cm cell, blurred, in the player's colour, each scaled to
// its own busiest cell. Drawn small and scaled up, so the canvas smooths it.
const heatCnv = document.createElement('canvas'); heatCnv.width = HX; heatCnv.height = HY;
function drawHeat(s) {
  const hc = heatCnv.getContext('2d'), img = hc.createImageData(HX, HY), ids = Object.keys(S.stats);
  const blur = (a) => { const o = new Float32Array(a.length); for (let y = 0; y < HY; y++) for (let x = 0; x < HX; x++) { let v = 0, w = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const X = x + i, Y = y + j; if (X < 0 || Y < 0 || X >= HX || Y >= HY) continue; const k = i || j ? (i && j ? 0.25 : 0.5) : 1; v += a[Y * HX + X] * k; w += k; } o[y * HX + x] = v / w; } return o; };
  for (const id of ids) {
    const h = blur(S.stats[id].heat), mx = Math.max(...h); if (!(mx > 0)) continue;
    const c = PCOL[(id - 1) % PCOL.length], rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    for (let i = 0; i < h.length; i++) {
      const a = Math.sqrt(h[i] / mx); if (a < 0.04) continue;
      const o = i * 4, A = img.data[o + 3] / 255, al = Math.min(1, a * 0.85);
      for (let k = 0; k < 3; k++) img.data[o + k] = (img.data[o + k] * A + rgb[k] * al) / Math.max(1e-6, A + al);
      img.data[o + 3] = Math.min(255, (A + al - A * al) * 255);
    }
  }
  hc.putImageData(img, 0, 0);
  if (ids.length) { pctx.fillStyle = 'rgba(10,12,16,0.55)'; pctx.fillRect(0, 0, plan.width, plan.height); } // dim the floor so the heat reads
  pctx.save(); pctx.imageSmoothingEnabled = true; pctx.globalAlpha = 0.9; pctx.drawImage(heatCnv, 0, 0, HX * HM * s, HY * HM * s); pctx.restore();
  // the court lines again on top
  pctx.strokeStyle = 'rgba(0,240,255,0.8)'; pctx.lineWidth = 1;
  for (const l of MODEL.lines) if (l.kind === 'floor') { pctx.beginPath(); pctx.moveTo(l.a[0] * s, l.a[1] * s); pctx.lineTo(l.b[0] * s, l.b[1] * s); pctx.stroke(); }
}
function drawWall() {
  const s = wall.width / CW; // front wall, 0 … 5 m high
  rectify(wctx, wall, (x, y) => [x / s, 0, (wall.height - y) / s]);
  wctx.strokeStyle = 'rgba(0,240,255,0.8)';
  for (const l of MODEL.lines) if (l.kind === 'front') { const y = wall.height - l.a[2] * s; wctx.beginPath(); wctx.moveTo(0, y); wctx.lineTo(wall.width, y); wctx.stroke(); }
  for (const p of S.picks) if (p.surface === 'front wall') { wctx.fillStyle = '#ff2d7a'; wctx.beginPath(); wctx.arc(p.X[0] * s, wall.height - p.X[2] * s, 4, 0, 7); wctx.fill(); }
  if (S.showRally) for (const f of recentFlights()) for (const m of f.impacts) if (m.plane === 'front') { wctx.fillStyle = '#ff8a00'; wctx.beginPath(); wctx.arc(m.X[0] * s, wall.height - m.X[2] * s, 4, 0, 7); wctx.fill(); }
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
  if (S.showRally) {
    vctx.lineWidth = 3; for (const p of S.players) { vctx.strokeStyle = pcol(p); seg3(vctx, vc, [p.X[0], p.X[1], 0], [p.X[0], p.X[1], p.height ?? 1.75], id, 2); }
    vctx.lineWidth = 1.5; vctx.strokeStyle = '#ffe600';
    for (const f of recentFlights()) for (let i = 1; i < f.pts.length; i++) seg3(vctx, vc, f.pts[i - 1].X, f.pts[i].X, id, 1);
    vctx.lineWidth = 1;
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
    `time     ${S.ms ? Math.round(S.ms.wall) + ' ms' : ''}${hz ? `   tracking ${hz.toFixed(1)} fps` : ''}${S.live && S.path ? `   ${S.path}${S.mount === 'free' ? ', camera moving' : ', fixed mount'}` : ''}`,
  ];
  if (S.showRally) {
    for (const p of S.players) { const st = S.stats[p.id]; lines.push(`player ${p.id} x ${p.X[0].toFixed(2)}  y ${p.X[1].toFixed(2)} m${p.occluded ? '  (feet hidden: from the head)' : ''}${p.seen ? '' : '  (coasting)'}`); if (st && S.live) lines.push(`         ${kmh(st.speed)}, top ${st.top.toFixed(1)} m/s, ${st.dist.toFixed(0)} m covered in ${st.time.toFixed(0)} s`); }
    const bn = ballNow(); if (bn) lines.push(`ball now ${kmh(bn.speed)}`);
    const f = recentFlights().slice(-1)[0];
    if (f) { const a = f.pts[0].X, e = f.pts[f.pts.length - 1].X, v = (X) => `${X[0].toFixed(1)}, ${X[1].toFixed(1)}, ${X[2].toFixed(1)}`; lines.push(`ball     ${f.t0.toFixed(2)}–${f.t1.toFixed(2)} s  (${v(a)}) → (${v(e)}) m, ${(f.speed * 3.6).toFixed(0)} km/h off the hit${f.impacts.length ? '  hit ' + f.impacts.map((m) => m.plane).join(', ') : ''}`); }
    if (S.rallyMs.players != null) lines.push(`         players ${Math.round(S.rallyMs.players)} ms${S.rallyMs.ball != null ? `, ball ${Math.round(S.rallyMs.ball)} ms` : ''} a frame`);
  }
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
    time: S.src?.currentTime ?? null,
    players: S.players.map((p) => ({ id: p.id, x: p.X[0], y: p.X[1], seen: p.seen, feetHidden: p.occluded, speed: S.stats[p.id]?.speed ?? null })),
    playerStats: Object.fromEntries(Object.entries(S.stats).map(([id, st]) => [id, { distance: st.dist, seconds: st.time, topSpeed: st.top, heatmap: { cell: HM, nx: HX, ny: HY, note: 'seconds per cell, row-major from x = 0, y = 0', seconds: Array.from(st.heat, (v) => +v.toFixed(3)) } }])),
    ball: S.flights.map((f) => ({ t0: f.t0, t1: f.t1, speed: f.speed, impacts: f.impacts, points: f.pts })),
  };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })); a.download = 'squash-court.json'; a.click();
}

// ---------- events ----------
$('file').onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
$('open').onclick = () => $('file').click();
$('camera').onclick = useCamera;
$('demo').onclick = demo;
$('redetect').onclick = () => { S.fails = 9; if (!S.live) analyse('detect'); };
$('lines').onchange = (e) => { S.showLines = e.target.checked; draw(); };
$('heat').onchange = (e) => { S.showHeat = e.target.checked; draw(); };
$('rally').onchange = (e) => { S.showRally = e.target.checked; clearRally(); if (S.showRally && !S.live && S.cam && S.procFrame) runRally(S.procFrame, scaleCam(S.cam, S.procFrame.k, S.procFrame.img.width, S.procFrame.img.height), 0, false); draw(); };
$('export').onclick = exportJSON;
$('clear').onclick = () => { S.picks = []; draw(); };
function soundLabel() { const v = S.src; $('sound').textContent = v instanceof HTMLVideoElement && !v.muted ? 'Sound on' : 'Sound off'; }
$('sound').onclick = () => { const v = S.src; if (!(v instanceof HTMLVideoElement)) return; v.muted = !v.muted; S.sound = !v.muted; soundLabel(); };
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

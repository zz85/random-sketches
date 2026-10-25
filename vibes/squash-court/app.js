// Squash Court: find the court in a photo, a video or the camera from its painted lines and
// show the camera it implies — pose, focal length, the floor and front wall rectified, a 3D view,
// and image points lifted onto the court in metres.
import { Camera } from './camera.js';
import { courtModel, W as CW, L as CL } from './court.js';
import { renderCourt, randomBroadcastCamera } from './synth.js';
import { mulberry32 } from './detect.js';
import { Bounces, heatGrid } from './bounces.js';
import { predictPath } from './ball.js';
import { onsets as findOnsets, audioOffset, decodeAudio } from './audio.js';
import { Commentary, describe, movement, mainView } from './commentary.js';
import { TControl, tLabel, T_POINT } from './tcontrol.js';
import { coachStats, posAtFromLogs, responsePatterns, ZONE_X, ZONE_Y } from './coaching.js';

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
  tin: 0.48, picks: [], showLines: true, showFrustum: true, showPredict: true, orbit: { yaw: -0.5, pitch: 0.45, dist: 19 },
  live: false, procFrame: null, sound: true,
  // players and ball (rally.js in the worker): players [{ id, X, seen, occluded, box }], the live
  // ball pixel, and fitted flights { t0, t1, pts: [{ t, X }], uv, impacts, labels, speed }
  showRally: true, showHeat: true, showBounces: true, captions: true, bounces: new Bounces(), comm: new Commentary(), feed: [], speak: false, moveSaid: {}, players: [], ball: null, ballTrail: [], flights: [], rallyMs: {},
};
// Per player: recent positions (speed), distance covered and time spent per 25 cm floor cell
// (the heatmap). Kept in the page, fed by the players worker's tracked positions.
const HM = 0.25, HX = Math.ceil(CW / HM), HY = Math.ceil(CL / HM);
const newStats = () => ({});
S.stats = newStats();
S.tctl = new TControl(); // T domination: time near the T, and who is nearer it
function statFor(id) { return S.stats[id] ??= { hist: [], dist: 0, time: 0, heat: new Float32Array(HX * HY), last: null, speed: 0, top: 0, series: [], log: [] }; }
function addPlayerStats(players, t) {
  for (const p of players) {
    const st = statFor(p.id);
    if (st.last && t < st.last.t) { st.hist = []; st.last = null; } // seek back
    const dt = st.last ? Math.min(0.5, t - st.last.t) : 0.2; // a still counts once
    if (p.seen) {
      const cx = Math.floor(p.X[0] / HM), cy = Math.floor(p.X[1] / HM);
      if (cx >= 0 && cy >= 0 && cx < HX && cy < HY && dt > 0) { st.heat[cy * HX + cx] += dt; st.time += dt; }
      if (st.last && dt > 0) st.dist += Math.hypot(p.X[0] - st.last.X[0], p.X[1] - st.last.X[1]);
      st.hist.push({ t, X: p.X.slice() }); S.tctl.add(p.id, t, p.X);
      st.log.push({ t, X: p.X.slice() }); if (st.log.length > 20000) st.log.splice(0, 5000);
    }
    st.last = { t, X: p.X.slice() };
    // speed: least-squares slope over the last 0.6 s (detections ~5 a second, feet jitter by cm)
    st.hist = st.hist.filter((q) => q.t > t - 0.6);
    if (st.hist.length >= 3) {
      const n = st.hist.length, mt = st.hist.reduce((s, q) => s + q.t, 0) / n, mx = st.hist.reduce((s, q) => s + q.X[0], 0) / n, my = st.hist.reduce((s, q) => s + q.X[1], 0) / n;
      let tt = 0, tx = 0, ty = 0; for (const q of st.hist) { const d = q.t - mt; tt += d * d; tx += d * (q.X[0] - mx); ty += d * (q.X[1] - my); }
      st.speed = tt > 1e-6 ? Math.hypot(tx / tt, ty / tt) : 0; st.top = Math.max(st.top, Math.min(st.speed, 8));
    } else st.speed = 0;
    const sr = st.series; if (sr.length && t < sr[sr.length - 1].t) sr.length = 0;
    sr.push({ t, v: p.seen ? st.speed : null }); if (sr.length > 20000) sr.splice(0, 5000);
  }
}
// The players nearby at time t (from the logged detections): nearest, its distance and the
// other's. Used to say who hit a shot.
function playersAt(t, X) {
  const near = [];
  for (const [id, st] of Object.entries(S.stats)) {
    const L = st.log; if (!L || !L.length) continue;
    let lo = 0, hi = L.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (L[m].t < t) lo = m + 1; else hi = m; }
    const q = [L[lo], L[lo - 1]].filter(Boolean).sort((a, b2) => Math.abs(a.t - t) - Math.abs(b2.t - t))[0];
    if (Math.abs(q.t - t) < 0.4) near.push({ id: +id, dist: Math.hypot(q.X[0] - X[0], q.X[1] - X[1]) });
  }
  near.sort((a, b2) => a.dist - b2.dist);
  return near.length ? { id: near[0].id, dist: near[0].dist, other: near[1]?.dist ?? null } : null;
}
// ---------- commentary ----------
// Shots are (re)built from the main camera's flights whenever the flight window changes; each
// keeps its id, so a refit rewrites its line in place instead of adding another. Shots with
// little evidence behind them (an inferred wall contact and few frames) are shown faded.
// Names typed in the Players panel (kept per video file); P1 / P2 until then.
S.names = { 1: '', 2: '' };
const nameOf = (id) => (S.names[id] || '').trim() || `P${id}`;
function setNames(n, note) {
  S.names = { 1: n[1] ?? '', 2: n[2] ?? '' }; for (const i of [1, 2]) if ($(`name${i}`).value !== S.names[i]) $(`name${i}`).value = S.names[i]; // never under the cursor while typing
  if (note != null) $('nameNote').textContent = note;
  if (S.srcName) localStorage.setItem('squashNames:' + S.srcName, JSON.stringify(S.names));
  renderFeed(); draw();
}
function comment() {
  const fl = S.flights.filter((f) => mainView(f.cam));
  if (!fl.length) return;
  const changed = S.comm.update(fl, S.bounces.list, playersAt);
  for (const s of changed) {
    if (s.quality < 2) continue;
    const text = describe(s, nameOf), o = S.feed.find((e) => e.id === s.id);
    if (o) { o.shot = s; o.player = s.player; o.sure = s.quality >= 3; continue; }
    S.feed.push({ id: s.id, t: s.t, shot: s, player: s.player, sure: s.quality >= 3, fresh: true });
    if (s.quality >= 3) { if (S.speak) say(text); caption(text); }
  }
  S.feed.sort((a, b) => b.t - a.t); if (S.feed.length > 200) S.feed.length = 200;
  renderFeed();
  S.coach = coachStats(S.comm.shots, posAtFromLogs(Object.fromEntries(Object.entries(S.stats).map(([id, st]) => [id, st.log]))));
}
function commentMoves() {
  const t = S.src?.currentTime ?? 0;
  for (const p of S.players) {
    if (!p.seen) continue;
    const st = S.stats[p.id], text = st && movement(p.id, p.X, st.speed, nameOf); if (!text) continue;
    const id = p.id, X = p.X.slice(), v = st.speed, mk = () => movement(id, X, v, nameOf);
    const key = p.id + text.split(' corner')[0].slice(-10);
    if (t - (S.moveSaid[key] ?? -Infinity) < 6) continue; // once per corner visit
    S.moveSaid[key] = t;
    S.feed.unshift({ id: `m${p.id}-${t}`, t, mk, player: p.id, sure: true, fresh: true, move: true }); caption(text);
  }
  renderFeed();
}
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}.${Math.floor((t % 1) * 10)}`;
function renderFeed() {
  const el = $('feed'); if (!el) return;
  el.replaceChildren(...S.feed.slice(0, 60).map((e) => {
    const li = document.createElement('li'); li.className = (e.fresh ? 'new' : '') + (e.sure ? '' : ' maybe'); e.fresh = false;
    li.style.borderLeftColor = e.player ? PCOL[(e.player - 1) % PCOL.length] : '#666';
    const t = document.createElement('span'); t.className = 't'; t.textContent = clock(e.t); li.append(t, e.shot ? describe(e.shot, nameOf) : e.mk ? e.mk() : e.text); return li;
  }));
}
// Captions: the newest commentary line over the video for a few seconds (the feed keeps them all).
let ccTimer = 0;
function caption(text) {
  if (!S.captions || !S.live) return;
  const el = $('cc'); el.textContent = text; el.classList.remove('off');
  clearTimeout(ccTimer); ccTimer = setTimeout(() => el.classList.add('off'), Math.max(3500, 60 * text.length));
}
function say(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text.replace(/\((\d+) km\/h\)/, 'at $1 kilometres an hour'));
  u.rate = 1.15; speechSynthesis.cancel(); speechSynthesis.speak(u); // the newest shot wins
}
// Front-wall contacts: one per shot (measured or carried to the wall), for the whole clip.
const contacts = () => S.comm.shots.map((s) => ({ t: s.t, X: s.front, player: s.player, measured: s.measured }));

// Heard impacts (audio.js), in video time once the audio delay is known from impacts both saw.
S.audio = null;
function heardTimes() {
  const A = S.audio; if (!A || !A.on.length) return null;
  const imp = S.bounces.list.filter((m) => !m.sound).map((m) => m.t);
  if (imp.length >= 3 && imp.length !== A.nImp) { const o = audioOffset(A.on, imp); A.offset = o.sure ? o.offset : null; A.matched = o.matched; A.chance = o.chance; A.nImp = imp.length; }
  return A.on.map((t) => t - (A.offset ?? 0));
}
async function listen(url, v) {
  try {
    const { x, rate } = await decodeAudio(url);
    if (S.src !== v) return;
    const on = findOnsets(x, rate).map((o) => o.t);
    S.audio = { on, offset: null, matched: 0, nImp: 0 };
  } catch (e) { S.audio = { on: [], error: String(e.message || e) }; }
}
// the ball's speed now: the fitted flight's velocity at the frame nearest the current time
function ballNow() {
  const t = S.src?.currentTime; if (t == null) return null;
  for (const f of S.flights) if (t >= f.t0 - 0.02 && t <= f.t1 + 0.02) { const q = f.pts.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a)); if (q.V) return { X: q.X, speed: Math.hypot(...q.V) }; }
  return null;
}
const kmh = (v) => `${v.toFixed(1)} m/s (${(v * 3.6).toFixed(0)} km/h)`;
const clearRally = () => { S.coach = null; S.stats = newStats(); S.tctl = new TControl(); S.bounces.clear(); S.comm.clear(); S.feed = []; S.moveSaid = {}; renderFeed(); S.players = []; S.ball = null; S.ballTrail = []; S.flights = []; S.rallyMs = {}; for (const R of rallyW) R.reset = true; };
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
  const R = { wk, role, busy: false, inFlight: 0, reset: true, k: 1 };
  wk.onmessage = (e) => { R.busy = false; R.inFlight = Math.max(0, R.inFlight - 1); const q = e.data; if (q.error) { console.error(q.error); return; } takeRally(q, R.k); if (!S.live) draw(); };
  return R;
});
function runRally(frame, cam, t, video) {
  if (!S.showRally) return;
  for (const R of video ? (S.frameCb ? rallyW.slice(0, 1) : rallyW) : rallyW.slice(0, 1)) {
    if (R.busy) continue;
    R.busy = true; R.k = frame.k;
    const data = new Uint8ClampedArray(frame.img.data), seen = S.players.filter((p) => p.box);
    R.wk.postMessage({ mode: video ? R.role : 'still', rgba: data, w: frame.img.width, h: frame.img.height, cam: { p: cam.p, cx: cam.cx, cy: cam.cy }, t, tin: S.tin, reset: R.reset,
      boxes: seen.map((p) => p.box.map((v) => v * frame.k)), playerX: seen.map((p) => p.X) }, [data.buffer]);
    R.reset = false;
  }
}
// The ball needs consecutive frames, so in a video it is fed from every new video frame (not only
// the frames the court worker analyses), at 640 px, with the latest fitted camera.
const ballGrab = document.createElement('canvas'), bgc = ballGrab.getContext('2d', { willReadFrequently: true });
function feedBall(v, mediaTime) {
  const R = rallyW[1];
  // frames queue in the worker (a flight fit can take a few frames' time; the cheap per-frame work
  // catches up after it), up to a limit so a slow machine drops frames instead of falling behind
  if (!S.showRally || !S.cam || !S.okay || S.src !== v || R.inFlight >= 12) return;
  const k = Math.min(1, 640 / S.srcW), w = Math.round(S.srcW * k), h = Math.round(S.srcH * k);
  ballGrab.width = w; ballGrab.height = h; bgc.drawImage(v, 0, 0, w, h);
  const img = bgc.getImageData(0, 0, w, h), cam = scaleCam(S.cam, k, w, h), seen = S.players.filter((p) => p.box);
  R.inFlight++; R.k = k;
  R.wk.postMessage({ mode: 'ball', rgba: img.data, w, h, cam: { p: cam.p, cx: cam.cx, cy: cam.cy }, t: mediaTime, tin: S.tin, reset: R.reset,
    boxes: seen.map((p) => p.box.map((x) => x * k)), playerX: seen.map((p) => p.X) }, [img.data.buffer]);
  R.reset = false; (S.ballTs ??= []).push(mediaTime);
}
function watchFrames(v) {
  if (!v.requestVideoFrameCallback) return false;
  const cb = (now, meta) => { if (S.src !== v) return; feedBall(v, meta.mediaTime); v.requestVideoFrameCallback(cb); };
  v.requestVideoFrameCallback(cb); return true;
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
  if (q.players) { S.players = q.players.map((p) => ({ ...p, box: p.box && p.box.map((v) => v / k) })); addPlayerStats(S.players, S.src.currentTime ?? 0); commentMoves(); }
  if (q.mode !== 'ball') return;
  S.ball = q.ball && { u: q.ball.u / k, v: q.ball.v / k, t: q.ball.t };
  if (S.ball) S.ballTrail.push(S.ball);
  const t = S.src.currentTime ?? 0; S.ballTrail = S.ballTrail.filter((b) => b.t > t - 0.4 && b.t <= t + 0.05);
  if (q.flights) { S.flights = q.flights.map((f) => ({ ...f, uv: f.uv.map(([u, v]) => [u / k, v / k]) })); S.bounces.update(S.flights, { onsets: heardTimes(), players: playersAt }); comment(); }
}
// flights to show at time t: the last 2 s of video (all of them for a still)
const recentFlights = () => { const t = S.src?.currentTime; return t == null ? S.flights : S.flights.filter((f) => f.t1 > t - 2 && f.t0 <= t + 0.05); };
const PCOL = ['#ff2d7a', '#2dd4ff', '#b4ff2d'];
const pcol = (p) => PCOL[(p.id - 1) % PCOL.length];

// ---------- sources ----------
function useImage(el, w, h) {
  stopLive(); S.src = el; S.srcW = w; S.srcH = h; S.cam = null; S.picks = []; clearRally(); fitStage(); draw(); analyse('detect');
}
function loadNames() { let n = null; try { n = JSON.parse(localStorage.getItem('squashNames:' + S.srcName) || 'null'); } catch {} setNames(n ?? { 1: '', 2: '' }, n ? 'saved for this video' : 'type the names, or swap them if they are the wrong way round'); }
function loadFile(file) {
  const url = URL.createObjectURL(file); S.srcName = file.name;
  if (file.type.startsWith('video/')) {
    const v = document.createElement('video'); v.src = url; v.muted = !S.sound; v.playsInline = true; v.loop = true;
    v.onloadeddata = () => { useVideo(v); listen(url, v); }; return;
  }
  if (file.name.endsWith('.json')) { file.text().then((t) => useMatch(JSON.parse(t), file.name)); return; }
  const im = new Image(); im.onload = () => useImage(im, im.naturalWidth, im.naturalHeight); im.src = url;
}
function useVideo(v) {
  stopLive(); S.src = v; S.srcW = v.videoWidth; S.srcH = v.videoHeight; S.cam = null; S.picks = []; clearRally(); S.audio = null; S.match = null; S.live = true; fitStage();
  // with sound if wanted; a browser that refuses unmuted playback without a fresh gesture gets it muted
  S.frameCb = watchFrames(v); if (!v.srcObject) loadNames();
  // time slider: seeking starts the ball and the players' tracks afresh (a jump is not a flight)
  const sc = $('scrub'); sc.hidden = !!v.srcObject || !isFinite(v.duration);
  $('seek').max = v.duration || 1;
  v.onseeking = () => { for (const R of rallyW) R.reset = true; S.ballTrail = []; S.ball = null; S.fails = 0; };
  v.ondurationchange = () => { $('seek').max = v.duration || 1; sc.hidden = !!v.srcObject || !isFinite(v.duration); };
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
  S.live = false; $('play').hidden = true; $('sound').hidden = true; $('scrub').hidden = true; $('cc').classList.add('off');
  if (S.src instanceof HTMLVideoElement) { S.src.pause(); S.src.srcObject?.getTracks().forEach((t) => t.stop()); }
}
function loop() {
  if (!S.live) return;
  draw();
  if (!S.seeking && S.src instanceof HTMLVideoElement) { $('seek').value = S.src.currentTime; $('tlabel').textContent = `${clock(S.src.currentTime).slice(0, -2)} / ${clock(S.src.duration || 0).slice(0, -2)}`; }
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
  if (!S.src) { if (S.match) { drawPlan(); drawWall(); drawSpeed(); drawPlayerHeat($('heat1'), 1); drawPlayerHeat($('heat2'), 2); drawCoach(); drawResp(); readout(); } return; }
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
  drawPlan(); drawWall(); draw3d(); drawSpeed(); drawPlayerHeat($('heat1'), 1); drawPlayerHeat($('heat2'), 2); drawCoach(); drawResp(); readout();
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
    sctx.font = `${12 * dpr}px system-ui`; sctx.fillStyle = '#000a'; const sp = S.stats[p.id]?.speed, s = `${nameOf(p.id)}  ${p.X[0].toFixed(2)}, ${p.X[1].toFixed(2)} m${sp > 0.3 ? `  ${sp.toFixed(1)} m/s` : ''}`;
    sctx.fillRect(x + 14 * dpr, y - 6 * dpr, sctx.measureText(s).width + 6 * dpr, 16 * dpr); sctx.fillStyle = pcol(p); sctx.fillText(s, x + 17 * dpr, y + 6 * dpr);
  }
  sctx.lineWidth = 2.5 * dpr;
  for (const f of recentFlights()) {
    sctx.strokeStyle = '#ffe600'; sctx.beginPath(); let first = true;
    for (const q of f.pts) { const u = c.project(q.X); if (!(u[2] > 0)) { first = true; continue; } const [x, y] = map(u); first ? sctx.moveTo(x, y) : sctx.lineTo(x, y); first = false; }
    sctx.stroke();
    for (const m of f.impacts) { const u = c.project(m.X); if (!(u[2] > 0)) continue; const [x, y] = map(u); sctx.fillStyle = '#ff8a00'; sctx.beginPath(); sctx.arc(x, y, 4 * dpr, 0, 7); sctx.fill(); }
  }
  // where the latest flight goes next, dashed (as in the 3D view); the part the ball has already
  // passed is faint, and the whole prediction fades once the ball is past its end
  const P = S.showPredict && predicted(recentFlights());
  if (P) {
    const pp = predParts(P), line = (pts) => { sctx.beginPath(); let first = true; for (const q of pts) { const u = c.project(q.X); if (!(u[2] > 0)) { first = true; continue; } const [x, y] = map(u); first ? sctx.moveTo(x, y) : sctx.lineTo(x, y); first = false; } sctx.stroke(); };
    sctx.save(); sctx.strokeStyle = '#ff8a00'; sctx.lineWidth = 2 * dpr; sctx.setLineDash([6 * dpr, 5 * dpr]);
    sctx.globalAlpha = pp.alpha * PASSED; line(pp.past); sctx.globalAlpha = pp.alpha; line(pp.ahead); sctx.setLineDash([]);
    for (const m of P.hits) { const u = c.project(m.X); if (!(u[2] > 0)) continue; const [x, y] = map(u); sctx.globalAlpha = pp.alpha * (m.t < pp.now ? PASSED : 1); sctx.strokeStyle = m.out ? '#ff3b30' : '#ff8a00'; sctx.beginPath(); sctx.arc(x, y, (m.out ? 6 : 4.5) * dpr, 0, 7); sctx.stroke(); }
    sctx.restore();
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
  rectify(pctx, plan, (x, y) => [CW - x / s, y / s, 0]); // seen from above, facing the front wall: the right wall (x = 0) on the right
  pctx.strokeStyle = 'rgba(0,240,255,0.8)'; pctx.lineWidth = 1;
  for (const l of MODEL.lines) if (l.kind === 'floor') { pctx.beginPath(); pctx.moveTo((CW - l.a[0]) * s, l.a[1] * s); pctx.lineTo((CW - l.b[0]) * s, l.b[1] * s); pctx.stroke(); }
  pctx.strokeRect(0.5, 0.5, plan.width - 1, plan.height - 1);
  for (const p of S.picks) if (p.surface === 'floor') { pctx.fillStyle = '#ff2d7a'; pctx.beginPath(); pctx.arc((CW - p.X[0]) * s, p.X[1] * s, 4, 0, 7); pctx.fill(); }
  if (S.showHeat) drawHeat(s);
  if (S.showBounces) { const F = S.bounces.on('floor'); drawBounces(pctx, F, CW, CL, s, (x, y) => [(CW - x) * s, y * s], !S.showHeat, (m) => [m.X[0], m.X[1]]); if (F.length) { const L = F[F.length - 1]; ringLast(pctx, L, (CW - L.X[0]) * s, L.X[1] * s); } }
  if (S.showRally) {
    // the ball's ground track (shadow), floor bounces, players
    for (const f of recentFlights()) {
      pctx.strokeStyle = 'rgba(255,230,0,0.9)'; pctx.lineWidth = 1.5; pctx.beginPath();
      f.pts.forEach((q, i) => (i ? pctx.lineTo((CW - q.X[0]) * s, q.X[1] * s) : pctx.moveTo((CW - q.X[0]) * s, q.X[1] * s))); pctx.stroke();
      for (const m of f.impacts) { pctx.fillStyle = '#ff8a00'; pctx.beginPath(); pctx.arc((CW - m.X[0]) * s, m.X[1] * s, 3, 0, 7); pctx.fill(); }
    }
    for (const p of S.players) {
      pctx.fillStyle = pcol(p); pctx.globalAlpha = p.seen ? 1 : 0.5; pctx.beginPath(); pctx.arc((CW - p.X[0]) * s, p.X[1] * s, 6, 0, 7); pctx.fill(); pctx.globalAlpha = 1;
      pctx.fillStyle = '#000'; pctx.font = 'bold 9px system-ui'; pctx.fillText(String(p.id), (CW - p.X[0]) * s - 2.5, p.X[1] * s + 3);
    }
  }
  // where the camera stands, if it is on the plan
  if (S.cam) { const C = S.cam.C; pctx.fillStyle = '#ffe600'; pctx.fillText(C[1] > CL ? `▼ camera ${(C[1] - CL).toFixed(1)} m behind` : '● camera', Math.max(4, Math.min(plan.width - 90, (CW - C[0]) * s - 20)), Math.min(plan.height - 6, C[1] * s)); }
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
  pctx.save(); pctx.imageSmoothingEnabled = true; pctx.globalAlpha = 0.9; pctx.translate(CW * s, 0); pctx.scale(-1, 1); pctx.drawImage(heatCnv, 0, 0, HX * HM * s, HY * HM * s); pctx.restore();
  // the court lines again on top
  pctx.strokeStyle = 'rgba(0,240,255,0.8)'; pctx.lineWidth = 1;
  for (const l of MODEL.lines) if (l.kind === 'floor') { pctx.beginPath(); pctx.moveTo((CW - l.a[0]) * s, l.a[1] * s); pctx.lineTo((CW - l.b[0]) * s, l.b[1] * s); pctx.stroke(); }
}
// Ball bounces: a heat ramp (clear → orange → pale yellow) scaled to the busiest cell, and a dot per
// bounce (a ring when it was inferred from a flight ending on the floor rather than fitted inside
// one). to(x, y) maps plane metres to canvas pixels; the grid's cell origin is the plane's.
const BC = 0.25, bounceCnv = document.createElement('canvas');
function drawBounces(ctx, list, w, h, s, to, dim, xy) {
  if (!list.length) return;
  const pts = list.map(xy);
  const H = heatGrid(pts, BC, w, h), mx = Math.max(...H.g);
  bounceCnv.width = H.nx; bounceCnv.height = H.ny;
  const bc = bounceCnv.getContext('2d'), img = bc.createImageData(H.nx, H.ny);
  for (let i = 0; i < H.g.length; i++) {
    const a = Math.sqrt(H.g[i] / mx); if (a < 0.06) continue;
    const o = i * 4; img.data[o] = 255; img.data[o + 1] = 110 + 140 * a; img.data[o + 2] = 40 + 150 * a * a; img.data[o + 3] = Math.min(255, 60 + 195 * a);
  }
  bc.putImageData(img, 0, 0);
  if (dim) { ctx.fillStyle = 'rgba(10,12,16,0.45)'; ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height); }
  // the grid's rows run with the plane's second axis; `to` puts (0,0) and (w,h) on the canvas
  const [x0, y0] = to(0, 0), [x1, y1] = to(H.nx * BC, H.ny * BC);
  ctx.save(); ctx.imageSmoothingEnabled = true; ctx.globalAlpha = 0.85;
  ctx.translate(x0, y0); ctx.scale((x1 - x0) / H.nx, (y1 - y0) / H.ny); ctx.drawImage(bounceCnv, 0, 0); ctx.restore();
  ctx.lineWidth = 1.2;
  // dot colour: who hit the shot (grey: not known); a square: heard, not seen
  list.forEach((m, i) => {
    const [px, py] = to(...pts[i]); ctx.strokeStyle = '#000'; ctx.fillStyle = m.player ? PCOL[(m.player - 1) % PCOL.length] : '#aaa';
    ctx.beginPath(); if (m.sound) ctx.rect(px - 2.6, py - 2.6, 5.2, 5.2); else ctx.arc(px, py, 2.8, 0, 7); ctx.fill(); ctx.stroke();
  });
}
// Speed over time per player: the last 30 s (all of it for a match file), gaps where unseen.
function drawSpeed() {
  const c = $('speed'), g = c.getContext('2d'), w = c.width, h = c.height;
  g.fillStyle = '#16181d'; g.fillRect(0, 0, w, h);
  const all = Object.entries(S.stats).filter(([, st]) => st.series && st.series.length);
  const tEnd = S.match ? Math.max(1, ...all.map(([, st]) => st.series.at(-1).t)) : S.src?.currentTime ?? 0, span = S.match ? tEnd - Math.min(...all.map(([, st]) => st.series[0].t)) : 30, t0 = tEnd - span;
  const vMax = 6, X = (t) => 28 + (t - t0) / span * (w - 34), Y = (v) => h - 14 - Math.min(v, vMax) / vMax * (h - 22);
  g.strokeStyle = '#333'; g.fillStyle = '#888'; g.font = '10px system-ui'; g.lineWidth = 1;
  for (let v = 0; v <= vMax; v += 2) { g.beginPath(); g.moveTo(28, Y(v)); g.lineTo(w - 6, Y(v)); g.stroke(); g.fillText(`${v}`, 8, Y(v) + 3); }
  g.fillText('m/s', 2, 10); g.fillText(S.match ? `${(span / 60).toFixed(0)} min` : '30 s', w - 40, h - 2);
  for (const [id, st] of all) {
    g.strokeStyle = PCOL[(id - 1) % PCOL.length]; g.lineWidth = 1.5; g.beginPath(); let pen = false;
    for (const q of st.series) { if (q.t < t0) continue; if (q.v == null) { pen = false; continue; } const x = X(q.t), y = Y(q.v); pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true; }
    g.stroke();
  }
}
// A whole match analysed by tools/match.mjs: its players' heatmaps and speeds, every bounce.
function useMatch(M, name) {
  stopLive(); S.src = null; S.cam = null; clearRally(); S.match = M;
  for (const p of M.players) { const st = statFor(p.id); st.heat = Float32Array.from(p.heatmap.seconds); st.dist = p.distance; st.time = p.seconds; st.top = p.topSpeed; st.series = p.speed.map(([t, v]) => ({ t, v })); }
  S.tctl = TControl.fromSummaries(Object.fromEntries(M.players.map((p) => [p.id, p.tControl ?? null])));
  S.bounces.list = M.bounces.map((m) => ({ t: m.t, X: [m.x, m.y, m.z], plane: m.plane, inferred: m.inferred, sound: m.sound, player: m.player }));
  S.comm.shots = (M.shots ?? []).map((s, i) => ({ ...s, id: i + 1, measured: s.quality >= 4 }));
  S.feed = (M.shots ?? []).filter((s) => s.quality >= 2).map((s, i) => ({ id: i + 1, t: s.t, text: s.text, shot: s.kind && s.front ? s : null, player: s.player, sure: s.quality >= 3 })).reverse();
  S.coach = M.coach ?? null;
  S.srcName = 'match:' + M.source; loadNames(); renderFeed();
  status(`${name}: ${(M.duration / 60).toFixed(1)} min, ${M.bounces.length} impacts, ${M.players.length} players`); draw();
}
// One player's heatmap on a plain court: time per 25 cm cell, in the player's colour.
function drawPlayerHeat(cnv, id) {
  const g = cnv.getContext('2d'), s = cnv.width / CW, st = S.stats[id];
  g.fillStyle = '#3a342c'; g.fillRect(0, 0, cnv.width, cnv.height);
  const title = $(`heat${id}t`);
  if (st) {
    const h = heatGrid([], HM, CW, CL); // same grid; fill it with the player's seconds, blurred
    h.g.set(st.heat); const B = blurHeat(h.g, h.nx, h.ny), mx = Math.max(1e-9, ...B);
    const hc = document.createElement('canvas'); hc.width = h.nx; hc.height = h.ny; const hx = hc.getContext('2d'), img = hx.createImageData(h.nx, h.ny);
    const rgb = [1, 3, 5].map((i) => parseInt(PCOL[(id - 1) % PCOL.length].slice(i, i + 2), 16));
    for (let i = 0; i < B.length; i++) { const a = B[i] / mx; if (a < 0.03) continue; const o = i * 4; img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = Math.min(255, 40 + 215 * a); }
    hx.putImageData(img, 0, 0); g.save(); g.imageSmoothingEnabled = true; g.translate(CW * s, 0); g.scale(-1, 1); g.drawImage(hc, 0, 0, h.nx * HM * s, h.ny * HM * s); g.restore();
    if (title) title.textContent = `${nameOf(id)} heatmap — ${st.dist.toFixed(0)} m, top ${st.top.toFixed(1)} m/s${tLabel(S.tctl.summary(id)) ? `, ${tLabel(S.tctl.summary(id))}` : ''}`;
  } else if (title) title.textContent = `${nameOf(id)} heatmap`;
  g.strokeStyle = 'rgba(0,240,255,0.7)'; g.lineWidth = 1;
  for (const l of MODEL.lines) if (l.kind === 'floor') { g.beginPath(); g.moveTo((CW - l.a[0]) * s, l.a[1] * s); g.lineTo((CW - l.b[0]) * s, l.b[1] * s); g.stroke(); }
  g.strokeRect(0.5, 0.5, cnv.width - 1, cnv.height - 1);
  const p = S.players.find((q) => q.id === id); if (p) { g.fillStyle = '#fff'; g.beginPath(); g.arc((CW - p.X[0]) * s, p.X[1] * s, 4, 0, 7); g.fill(); }
}
// ---------- response patterns ----------
// Where the opponent took the ball in reply to one player's shots, over 12 zones: the share per
// zone (the busiest shaded), the reply shots in a zone on hover / tap / arrow keys, and the replies'
// quality (coaching.js replyQuality).
const QCOL = { high: '#5fe36a', medium: '#ffbf1f', low: '#f0584f' };
let respZones = null, respSel = null;
function drawResp() {
  const cnv = $('resp'), g = cnv.getContext('2d'), w = cnv.width, h = cnv.height, s = w / CW;
  const who = +$('respWho').value, type = $('respType').value;
  for (const i of [1, 2]) { const o = $('respWho').options[i - 1]; if (o.textContent !== nameOf(i)) o.textContent = nameOf(i); }
  const R = S.coach ? responsePatterns(S.coach.shots, who, type) : null;
  $('respTitle').textContent = `${nameOf(3 - who)} response`;
  $('respQ').innerHTML = R && R.n ? ['high', 'medium', 'low'].map((k) => `<i style="background:${QCOL[k]}"></i>${k[0].toUpperCase() + k.slice(1)} <b>${Math.round(R.share[k] * 100)}%</b>`).join('') + ` <span style="color:#999">· ${R.n} replies to ${R.of} shots</span>` : '<span style="color:#999">No replies with both hitters known yet.</span>';
  // zone rectangles in canvas px (column 0 is the left wall as the camera sees it: x = 6.4)
  const xs = [0, (CW - ZONE_X[1]) * s, (CW - ZONE_X[0]) * s, w], ys = [0, ...ZONE_Y.map((y) => y * s), h];
  respZones = []; for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) respZones.push({ zone: r * 3 + c + 1, x0: xs[c], x1: xs[c + 1], y0: ys[r], y1: ys[r + 1], Z: R ? R.zones[r * 3 + c] : null });
  g.fillStyle = '#fafafa'; g.fillRect(0, 0, w, h);
  const mx = R ? Math.max(...R.zones.map((z) => z.n)) : 0;
  for (const z of respZones) {
    const v = z.Z?.n ?? 0;
    if (v && mx) { g.fillStyle = `rgba(245,150,60,${0.15 + 0.6 * (v / mx)})`; g.fillRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0); }
    g.strokeStyle = '#bbb'; g.setLineDash([3, 3]); g.lineWidth = 1; g.strokeRect(z.x0 + 0.5, z.y0 + 0.5, z.x1 - z.x0 - 1, z.y1 - z.y0 - 1); g.setLineDash([]);
    if (respSel === z.zone) { g.strokeStyle = '#1877f2'; g.lineWidth = 3; g.strokeRect(z.x0 + 1.5, z.y0 + 1.5, z.x1 - z.x0 - 3, z.y1 - z.y0 - 3); }
    g.fillStyle = '#333'; g.font = '9px system-ui'; g.fillText(String(z.zone), z.x0 + 4, z.y0 + 11);
    g.fillStyle = v ? '#222' : '#aaa'; g.font = `600 ${Math.round(w / 13)}px system-ui`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(v ? `${Math.round(z.Z.share * 100)}%` : '0', (z.x0 + z.x1) / 2, (z.y0 + z.y1) / 2); g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  }
  // the court lines faintly underneath the grid
  g.strokeStyle = 'rgba(200,60,50,0.9)'; g.lineWidth = 2; g.strokeRect(1, 1, w - 2, h - 2);
  g.strokeStyle = 'rgba(200,60,50,0.55)'; g.lineWidth = 1.5;
  for (const l of MODEL.lines) if (l.kind === 'floor') { g.beginPath(); g.moveTo((CW - l.a[0]) * s, l.a[1] * s); g.lineTo((CW - l.b[0]) * s, l.b[1] * s); g.stroke(); }
  $('respList').textContent = R && R.n ? R.zones.filter((z) => z.n).map((z) => `Zone ${z.zone}: ${Math.round(z.share * 100)}%, ${Object.entries(z.shots).map(([k, n]) => `${k} ${n}`).join(', ')}`).join('. ') : 'No replies yet.';
  showRespTip();
}
function showRespTip() {
  const tip = $('respTip'), z = respZones?.find((q) => q.zone === respSel);
  if (!z || !z.Z?.n) { tip.hidden = true; return; }
  const cnv = $('resp'), k = cnv.clientWidth / cnv.width;
  tip.innerHTML = `<h4>Zone ${z.zone}</h4>` + Object.entries(z.Z.shots).map(([l, n]) => `<div><span>${l}</span><b>${n}</b></div>`).join('');
  tip.hidden = false;
  const left = Math.min(Math.max(0, z.x0 * k), cnv.clientWidth - tip.offsetWidth), top = z.y1 * k + 4 + tip.offsetHeight > cnv.clientHeight ? Math.max(0, z.y0 * k - tip.offsetHeight - 4) : z.y1 * k + 4;
  tip.style.left = `${left}px`; tip.style.top = `${top}px`;
}
function respAt(e) { const c = $('resp'), r = c.getBoundingClientRect(), x = (e.clientX - r.left) * c.width / r.width, y = (e.clientY - r.top) * c.height / r.height; return respZones?.find((z) => x >= z.x0 && x < z.x1 && y >= z.y0 && y < z.y1)?.zone ?? null; }
// ---------- coaching panel (coaching.js) ----------
// Three floor plans, both players or one (the selector): where each stood when the other struck
// the ball, with the 1 m ring round the T; volleys (filled, the hitter's colour) joined to where the
// opponent was then (ring); every first bounce (shape by shot type, hollow when carried on).
function courtBase(cnv) {
  const g = cnv.getContext('2d'), s = cnv.width / CW;
  g.fillStyle = '#3a342c'; g.fillRect(0, 0, cnv.width, cnv.height);
  g.strokeStyle = 'rgba(0,240,255,0.6)'; g.lineWidth = 1;
  for (const l of MODEL.lines) if (l.kind === 'floor') { g.beginPath(); g.moveTo((CW - l.a[0]) * s, l.a[1] * s); g.lineTo((CW - l.b[0]) * s, l.b[1] * s); g.stroke(); }
  g.strokeRect(0.5, 0.5, cnv.width - 1, cnv.height - 1);
  return { g, s, P: (X) => [(CW - X[0]) * s, X[1] * s] };
}
function mark(g, [x, y], kind, fill, hollow, r = 3.2) {
  g.beginPath();
  if (kind === 'drop' || kind === 'kill') { g.moveTo(x, y - r * 1.2); g.lineTo(x + r, y + r * 0.8); g.lineTo(x - r, y + r * 0.8); g.closePath(); }
  else if (kind === 'lob') g.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
  else if (kind === 'boast') { g.moveTo(x, y - r * 1.2); g.lineTo(x + r, y); g.lineTo(x, y + r * 1.2); g.lineTo(x - r, y); g.closePath(); }
  else g.arc(x, y, r, 0, 7);
  if (hollow) { g.strokeStyle = fill; g.lineWidth = 1.4; g.stroke(); } else { g.fillStyle = fill; g.fill(); g.strokeStyle = '#000'; g.lineWidth = 0.8; g.stroke(); }
}
const pct = (v) => (v == null ? '–' : `${Math.round(v * 100)}%`);
function drawCoach() {
  const C = S.coach, who = +$('coachWho').value, ids = who ? [who] : [1, 2], col = (id) => PCOL[(id - 1) % PCOL.length];
  const T = courtBase($('coachT')), V = courtBase($('coachV')), B = courtBase($('coachB'));
  // the T zone
  const r = (C?.radius ?? 1) * T.s, [tx, ty] = T.P(T_POINT);
  T.g.strokeStyle = 'rgba(255,255,255,0.7)'; T.g.setLineDash([3, 3]); T.g.beginPath(); T.g.arc(tx, ty, r, 0, 7); T.g.stroke(); T.g.setLineDash([]);
  if (!C) { $('coachText').textContent = 'Builds up as shots are recognised: who hit each one, from where, and where the other player was.'; return; }
  for (const id of ids) {
    const p = C.players[id]; if (!p) continue;
    for (const X of p.tAtOppHit.points) { const q = T.P(X), on = Math.hypot(X[0] - T_POINT[0], X[1] - T_POINT[1]) < C.radius; mark(T.g, q, 'drive', col(id), !on); }
    for (const v of p.volleys.points) {
      const a = V.P(v.X); if (v.opp) { const b = V.P(v.opp); V.g.strokeStyle = 'rgba(255,255,255,0.45)'; V.g.lineWidth = 1; V.g.beginPath(); V.g.moveTo(...a); V.g.lineTo(...b); V.g.stroke(); mark(V.g, b, 'drive', col(3 - id), true); }
      mark(V.g, a, v.kind, col(id), false);
    }
    for (const f of p.firstBounces.points) mark(B.g, B.P(f.X), f.kind, col(id), f.inferred);
  }
  const L = [`Hitter known for ${C.attributed} of ${C.total} shots; only those count.`];
  for (const id of ids) {
    const p = C.players[id]; if (!p) continue; const t = p.tAtOppHit, v = p.volleys, f = p.firstBounces;
    L.push(`${nameOf(id)}: on the T at ${pct(t.share)} of the opponent's hits (${t.n} seen, typically ${t.medianDistance != null ? t.medianDistance.toFixed(1) + ' m' : '–'} from it)`);
    L.push(`  volleys ${v.n} of ${v.of} shots where it could be told${v.of ? ` (${pct(v.share)})` : ''}${v.n ? `: ${Object.entries(v.kinds).map(([k, n]) => `${n} ${k}`).join(', ')}` : ''}`);
    L.push(`  first bounces ${f.n}: front ${f.zones.front}, middle ${f.zones.middle}, back ${f.zones.back}${f.drives ? `; drives deep ${f.drivesDeep}/${f.drives}, tight ${f.drivesTight}/${f.drives}` : ''}`);
  }
  $('coachText').textContent = L.join('\n');
}
function blurHeat(a, nx, ny) { let g = Float32Array.from(a); for (let p = 0; p < 2; p++) { const o = new Float32Array(g.length); for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { let v = 0, w = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const X = x + i, Y = y + j; if (X < 0 || Y < 0 || X >= nx || Y >= ny) continue; const k = (i ? 0.5 : 1) * (j ? 0.5 : 1); v += g[Y * nx + X] * k; w += k; } o[y * nx + x] = v / w; } g = o; } return g; }
// the most recent mark of a list, ringed in green with its time
function ringLast(ctx, m, px, py) {
  ctx.strokeStyle = '#39ff6a'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(px, py, 7, 0, 7); ctx.stroke();
  ctx.fillStyle = '#39ff6a'; ctx.beginPath(); ctx.arc(px, py, 3.5, 0, 7); ctx.fill();
  ctx.font = '10px system-ui'; ctx.fillText(clock(m.t), Math.min(ctx.canvas.width - 40, px + 9), Math.max(10, py - 6));
}
function drawWall() {
  const s = wall.width / CW; // front wall, 0 … 5 m high
  rectify(wctx, wall, (x, y) => [CW - x / s, 0, (wall.height - y) / s]); // facing it from the court: x = 0 on the right
  wctx.strokeStyle = 'rgba(0,240,255,0.8)';
  for (const l of MODEL.lines) if (l.kind === 'front') { const y = wall.height - l.a[2] * s; wctx.beginPath(); wctx.moveTo(0, y); wctx.lineTo(wall.width, y); wctx.stroke(); }
  for (const p of S.picks) if (p.surface === 'front wall') { wctx.fillStyle = '#ff2d7a'; wctx.beginPath(); wctx.arc((CW - p.X[0]) * s, wall.height - p.X[2] * s, 4, 0, 7); wctx.fill(); }
  // every front-wall contact (one per shot), coloured by hitter; the last one in green
  const C = S.showBounces ? contacts() : [];
  if (C.length) { drawBounces(wctx, C, CW, wall.height / s, s, (x, z) => [(CW - x) * s, wall.height - z * s], true, (m) => [m.X[0], m.X[2]]); const L = C[C.length - 1]; ringLast(wctx, L, (CW - L.X[0]) * s, wall.height - L.X[2] * s); }
  if (S.showRally) for (const f of recentFlights()) for (const m of f.impacts) if (m.plane === 'front') { wctx.fillStyle = '#ff8a00'; wctx.beginPath(); wctx.arc((CW - m.X[0]) * s, wall.height - m.X[2] * s, 4, 0, 7); wctx.fill(); }
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
    if (S.showFrustum) {
      vctx.strokeStyle = '#ffe600';
      for (const q of corners) seg3(vctx, vc, c.C, q, id, 2);
      for (let i = 0; i < 4; i++) seg3(vctx, vc, corners[i], corners[(i + 1) % 4], id, 2);
    }
    vctx.strokeStyle = 'rgba(255,230,0,0.35)';
    for (const p of S.picks) seg3(vctx, vc, c.C, p.X, id, 2);
    for (const p of S.picks) { const u = vc.project(p.X); if (u[2] > 0) { vctx.fillStyle = '#ff2d7a'; vctx.beginPath(); vctx.arc(u[0], u[1], 3.5, 0, 7); vctx.fill(); } }
  }
  if (S.showRally) {
    vctx.lineWidth = 3; for (const p of S.players) { vctx.strokeStyle = pcol(p); seg3(vctx, vc, [p.X[0], p.X[1], 0], [p.X[0], p.X[1], p.height ?? 1.75], id, 2); }
    // the ball: fitted flights solid, with their shadow on the floor; where the latest one goes
    // next dashed (predicted with the same physics, through its bounces), and the ball now
    const path = (P) => { vctx.beginPath(); let on = false; for (const X of P) { const u = vc.project(X); if (u[2] > 0.05) { on ? vctx.lineTo(u[0], u[1]) : vctx.moveTo(u[0], u[1]); on = true; } else on = false; } vctx.stroke(); };
    const dot = (X, r, fill) => { const u = vc.project(X); if (u[2] > 0.05) { vctx.fillStyle = fill; vctx.beginPath(); vctx.arc(u[0], u[1], r, 0, 7); vctx.fill(); } };
    const fl = recentFlights();
    vctx.lineWidth = 1.5;
    for (const f of fl) { vctx.strokeStyle = 'rgba(255,230,0,0.25)'; path(f.pts.map((q) => [q.X[0], q.X[1], 0])); vctx.strokeStyle = '#ffe600'; path(f.pts.map((q) => q.X)); }
    const P = S.showPredict && predicted(fl);
    if (P) {
      const pp = predParts(P);
      vctx.save(); vctx.setLineDash([5, 4]); vctx.lineWidth = 2;
      for (const [pts, a] of [[pp.past, PASSED], [pp.ahead, 1]]) {
        vctx.globalAlpha = pp.alpha * a;
        vctx.strokeStyle = 'rgba(255,138,0,0.3)'; path(pts.map((q) => [q.X[0], q.X[1], 0]));
        vctx.strokeStyle = '#ff8a00'; path(pts.map((q) => q.X));
      }
      vctx.setLineDash([]);
      for (const m of P.hits) { vctx.globalAlpha = pp.alpha * (m.t < pp.now ? PASSED : 1); dot(m.X, m.out ? 5 : 3.5, m.out ? '#ff3b30' : '#ff8a00'); }
      vctx.restore();
    }
    const bn = ballNow();
    if (bn) { vctx.strokeStyle = 'rgba(255,255,255,0.5)'; vctx.lineWidth = 1; path([bn.X, [bn.X[0], bn.X[1], 0]]); dot(bn.X, 4, '#fff'); }
    vctx.lineWidth = 1;
  }
}
// The prediction split at the video's current time: the part the ball has passed, the part still
// ahead, and an overall opacity that falls to zero over FADE s once the ball is past its end. A
// still image (no time) shows it all ahead.
const PASSED = 0.2, FADE = 0.6;
function predParts(P) {
  const now = S.live && S.src?.currentTime != null ? S.src.currentTime : -Infinity, end = P.pts[P.pts.length - 1].t;
  const k = P.pts.findIndex((q) => q.t > now), i = k < 0 ? P.pts.length : k;
  return { now, past: P.pts.slice(0, Math.min(P.pts.length, i + 1)), ahead: P.pts.slice(Math.max(0, i - 1)), alpha: now > end ? Math.max(0, 1 - (now - end) / FADE) : 1 };
}
// The latest flight carried on past its last fitted point (cached per flight object: the worker
// sends new objects when it refits)
const predCache = new WeakMap();
function predicted(fl) {
  const f = fl.reduce((a, b) => (!a || b.t0 > a.t0 ? b : a), null);
  if (!f) return null;
  if (!predCache.has(f)) { const q = [...f.pts].reverse().find((p) => p.V); predCache.set(f, q ? predictPath(q.X, q.V, { t: q.t, T: 1.5, tin: S.tin }) : null); }
  return predCache.get(f);
}
// ", T 58% (on the T 31% of the time, 1.4 m from it on average)"
const tText = (m) => (m && m.seconds ? `, ${m.controlShare != null ? `T ${(m.controlShare * 100).toFixed(0)}% (` : '('}on the T ${(m.zoneShare * 100).toFixed(0)}% of the time, ${m.meanDistance.toFixed(1)} m from it on average)` : '');
function readout() {
  const c = S.cam, el = $('readout');
  if (S.match) {
    const M = S.match, fl = S.bounces.on('floor'), fr = S.bounces.on('front');
    el.textContent = [`match    ${M.source} — ${(M.duration / 60).toFixed(1)} min, court seen ${(M.courtSeconds / 60).toFixed(1)} min`,
      ...M.players.map((p) => `${nameOf(p.id).padEnd(8)} ${p.distance.toFixed(0)} m in ${(p.seconds / 60).toFixed(1)} min, top ${p.topSpeed.toFixed(1)} m/s${tText(p.tControl)}${p.colour ? `, shirt rgb(${p.colour.map(Math.round).join(', ')})` : ''}`),
      `bounces  ${fl.length} on the floor (${fl.filter((m) => m.X[1] > 5.44).length} behind the short line), ${fr.length} on the front wall, ${S.bounces.list.filter((m) => m.sound).length} found by ear`,
      ...M.players.map((p) => `         ${nameOf(p.id)} hit ${S.bounces.list.filter((m) => m.player === p.id).length}`)].join('\n');
    return;
  }
  if (!c) { el.textContent = S.src ? 'looking for the court…' : 'Open a photo or video of a squash court (or a match .json from tools/match.mjs), use the camera, or try a demo frame.'; return; }
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
  if (S.showRally || S.match) {
    for (const p of S.players) { const st = S.stats[p.id]; lines.push(`${nameOf(p.id).padEnd(8)} x ${p.X[0].toFixed(2)}  y ${p.X[1].toFixed(2)} m${p.occluded ? '  (feet hidden: from the head)' : ''}${p.seen ? '' : '  (coasting)'}`); if (st && S.live) lines.push(`         ${kmh(st.speed)}, top ${st.top.toFixed(1)} m/s, ${st.dist.toFixed(0)} m covered in ${st.time.toFixed(0)} s${tText(S.tctl.summary(p.id))}`); }
    const bn = ballNow(); if (bn) lines.push(`ball now ${kmh(bn.speed)}`);
    if (S.bounces.list.length) { const fl = S.bounces.on('floor'), fr = S.bounces.on('front'); lines.push(`bounces  ${fl.length} on the floor${fl.length ? ` (${fl.filter((m) => m.X[1] > 5.44).length} behind the short line)` : ''}, ${fr.length} on the front wall`);
      const by = (id) => S.bounces.list.filter((m) => m.player === id && (m.plane === 'floor' || m.plane === 'front')).length, ids = [...new Set(S.bounces.list.map((m) => m.player).filter(Boolean))].sort();
      if (ids.length) lines.push(`         shots by ${ids.map((id) => `${nameOf(id)} ${by(id)}`).join(', ')}, ${S.bounces.list.filter((m) => !m.player).length} unknown`); }
    if (S.audio) lines.push(S.audio.error ? `sound    not decoded (${S.audio.error})` : `sound    ${S.audio.on.length} impacts heard${S.audio.offset != null ? `, audio ${Math.round(S.audio.offset * 1000)} ms after picture (${S.audio.matched} matched, ${S.audio.chance} by chance)` : ', delay not known yet'}, ${S.bounces.list.filter((m) => m.sound).length} bounces found by ear`);
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
    bounces: S.bounces.list.map((m) => ({ t: m.t, plane: m.plane, x: m.X[0], y: m.X[1], z: m.X[2], inferred: m.inferred })),
    coach: S.coach, playerStats: Object.fromEntries(Object.entries(S.stats).map(([id, st]) => [id, { distance: st.dist, seconds: st.time, topSpeed: st.top, tControl: S.tctl.summary(id), heatmap: { cell: HM, nx: HX, ny: HY, note: 'seconds per cell, row-major from x = 0, y = 0', seconds: Array.from(st.heat, (v) => +v.toFixed(3)) } }])),
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
$('predict').onchange = (e) => { S.showPredict = e.target.checked; draw(); };
$('frustum').onchange = (e) => { S.showFrustum = e.target.checked; draw3d(); };
$('bounces').onchange = (e) => { S.showBounces = e.target.checked; draw(); };
$('heat').onchange = (e) => { S.showHeat = e.target.checked; draw(); };
$('rally').onchange = (e) => { S.showRally = e.target.checked; clearRally(); if (S.showRally && !S.live && S.cam && S.procFrame) runRally(S.procFrame, scaleCam(S.cam, S.procFrame.k, S.procFrame.img.width, S.procFrame.img.height), 0, false); draw(); };
$('export').onclick = exportJSON;
// Clear: measured points and everything gathered so far (heatmaps, bounces, speeds, commentary);
// a playing video starts gathering again from the current frame
$('clear').onclick = () => { S.picks = []; const m = S.match; clearRally(); S.match = null; if (m && !S.src) S.cam = null; status('cleared'); draw(); };
$('seek').addEventListener('input', (e) => { const v = S.src; if (!(v instanceof HTMLVideoElement)) return; S.seeking = true; v.currentTime = +e.target.value; $('tlabel').textContent = `${clock(v.currentTime).slice(0, -2)} / ${clock(v.duration || 0).slice(0, -2)}`; });
$('seek').addEventListener('change', () => { S.seeking = false; });
$('seek').addEventListener('pointerup', () => { S.seeking = false; });
$('cap').onchange = (e) => { S.captions = e.target.checked; if (!S.captions) $('cc').classList.add('off'); };
for (const i of [1, 2]) $(`name${i}`).addEventListener('input', (e) => { S.names[i] = e.target.value; setNames(S.names, ''); });
$('swapNames').onclick = () => setNames({ 1: S.names[2], 2: S.names[1] }, 'swapped');
$('speak').onchange = (e) => { S.speak = e.target.checked; if (!S.speak && 'speechSynthesis' in window) speechSynthesis.cancel(); };
$('coachWho').onchange = () => draw();
$('respWho').onchange = $('respType').onchange = () => draw();
$('resp').addEventListener('pointermove', (e) => { const z = respAt(e); if (z !== respSel) { respSel = z; drawResp(); } });
$('resp').addEventListener('pointerleave', () => { respSel = null; drawResp(); });
$('resp').addEventListener('pointerdown', (e) => { respSel = respAt(e); drawResp(); });
$('resp').addEventListener('keydown', (e) => { const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 3, ArrowUp: -3 }[e.key]; if (!d) return; e.preventDefault(); respSel = Math.min(12, Math.max(1, (respSel ?? 0) + d)); drawResp(); });
{ // drag the side panel's edge to resize it (kept across reloads)
  const grip = $('grip'), set = (w) => { w = Math.max(300, Math.min(innerWidth - 320, w)); document.body.style.setProperty('--side', `${w}px`); localStorage.setItem('squashSide', w); };
  const saved = +localStorage.getItem('squashSide'); if (saved) set(saved);
  let drag = false;
  grip.addEventListener('pointerdown', (e) => { drag = true; grip.classList.add('drag'); grip.setPointerCapture(e.pointerId); });
  grip.addEventListener('pointermove', (e) => { if (drag) { set(innerWidth - e.clientX - 3); fitStage(); draw(); } });
  grip.addEventListener('pointerup', () => { drag = false; grip.classList.remove('drag'); });
  grip.addEventListener('keydown', (e) => { const w = parseInt(getComputedStyle(document.body).getPropertyValue('--side')) || 620; if (e.key === 'ArrowLeft') set(w + 20); else if (e.key === 'ArrowRight') set(w - 20); else return; fitStage(); draw(); });
}
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

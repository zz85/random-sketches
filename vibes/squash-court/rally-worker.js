// Players and ball (rally.js), beside the court worker so finding them never slows the camera
// tracking. The page runs two of these: one finds the players (slow, ~150-300 ms a frame), the
// other the ball on every frame it can get (~20 ms), with the players' boxes passed in.
// in:  { id, mode: 'players' | 'ball' | 'still', rgba (transferred), w, h, cam: { p, cx, cy }, t, tin,
//        reset, boxes?, playerX?, onsets? }   ('still': one player detection on a photo; onsets:
//        heard impact times, sent when they change)
// out: { id, players?, ball?, flights?, ms, dup } or { id, error }
import { Camera } from './camera.js';
import { Rally } from './rally.js';
import { detectPlayers } from './players.js';

const rally = new Rally({ playerEvery: 0 });
const pack = (p, id) => ({ id: p.id ?? id, X: p.X, seen: p.seen ?? true, occluded: !!p.occluded, box: p.box ?? null, height: p.height });

self.onmessage = (e) => {
  const { id, mode, rgba, w, h, cam: c, t, tin, reset, boxes, playerX, onsets } = e.data;
  if (onsets) rally.onsets = onsets; // heard impacts, video time, sent when they change
  try {
    const cam = new Camera(c.p, w, h, c.cx, c.cy), t0 = performance.now();
    if (mode === 'still') {
      const P = detectPlayers(rgba, w, h, cam, { tin });
      self.postMessage({ id, mode, players: P.players.map((p, i) => pack(p, i + 1)), ms: performance.now() - t0 });
      return;
    }
    if (reset || t < (rally.tLast ?? -Infinity)) rally.reset(); // a cut, a new clip or a seek back
    rally.tLast = t;
    const q = rally.frame(rgba, w, h, cam, t, { tin, players: mode === 'players', ball: mode === 'ball', boxes, playerX });
    self.postMessage(mode === 'players' ? { id, mode, players: q.players.map(pack), ms: performance.now() - t0, dup: q.dup } : { id, mode, ball: q.ball, flights: q.flights, ms: performance.now() - t0, dup: q.dup });
  } catch (err) {
    self.postMessage({ id, mode, error: String(err && err.stack || err) });
  }
};
